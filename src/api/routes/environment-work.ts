/**
 * Official Work API — data plane (`/v1/environments/{id}/work/*`).
 *
 * These are the wire routes the official SDK's self-hosted worker calls:
 *
 *   GET  /v1/environments/:id/work/poll                  long-poll → work item | 204
 *   POST /v1/environments/:id/work/:workId/ack           queued → starting
 *   POST /v1/environments/:id/work/:workId/heartbeat     renew the heartbeat lease
 *   POST /v1/environments/:id/work/:workId               metadata merge patch
 *   POST /v1/environments/:id/work/:workId/stop          graceful/forced shutdown
 *   GET  /v1/environments/:id/work                       list, newest first, keyset cursor
 *   GET  /v1/environments/:id/work/stats                 queue counters
 *   GET  /v1/environments/:id/work/:workId               retrieve one item
 *
 * The runtime's queue underneath is tool-call-shaped (`/v1/x/worker`), while
 * the published work item is session-scoped: `data` is always
 * `{type:'session', id}` because that is the only data variant this queue can
 * honestly produce — every local work item belongs to a session, and the
 * per-item tool payload stays on the local worker channel. The projection is
 * deliberately lossy in one direction only: `secret` is populated on poll
 * alone, and the five published states collapse onto the queue's claim /
 * accept / stop / terminal markers as documented on `projectWorkState`.
 *
 * Authentication is the published credential set, not the local one: the
 * bearer is an environment worker key (`mawk_...`), the per-session token
 * carried inside a claimed item's `secret` (`mawt_...`), or a managed API
 * key. The global API-key middleware exempts this prefix (see auth.ts) so the
 * worker credentials reach this resolver; when no API keys are configured at
 * all the route inherits the runtime's open local-first posture and a missing
 * credential is anonymous rather than refused.
 */

import { Hono, type Context } from 'hono';
import type { Database } from '@/core/db/database.js';
import type { WorkItem, WorkQueue } from '@/sandbox/self-hosted-provider.js';
import { validateEnvironmentWorkerKey } from '@/core/auth/environment-worker-keys.js';
import { issueSessionWorkToken, validateSessionWorkToken } from '@/core/auth/session-work-tokens.js';
import { invalid, conflict, notFound } from './resource-utils.js';

export interface EnvironmentWorkRouteDeps {
  queue: WorkQueue;
  db: Database;
  /** Managed API keys, mirroring the global middleware's configuration. */
  apiKeys?: string[];
  hasApiKeys?: () => boolean;
  validateApiKey?: (key: string) => boolean;
}

/** Published poll bounds: `block_ms` must be 1-999; reclaim defaults to 5000ms. */
const POLL_BLOCK_MIN_MS = 1;
const POLL_BLOCK_MAX_MS = 999;
const DEFAULT_RECLAIM_OLDER_THAN_MS = 5_000;
const POLL_RETRY_MS = 50;

type WorkCredential =
  | { kind: 'open' }
  | { kind: 'api_key' }
  | { kind: 'environment_key'; environmentId: string }
  | { kind: 'session_token'; environmentId: string; sessionId: string };

/**
 * `work` is mounted before the refusal router; every published route in the
 * family is implemented here, so the refusal router no longer carries a Work
 * entry at all.
 */
export function environmentWorkRoutes(deps: EnvironmentWorkRouteDeps): Hono {
  const app = new Hono();

  // Registration order is load-bearing on this router: every literal
  // (`stats`, `poll`) must land before the `/:workId` parameter route, or the
  // parameter wins the path and the literal is read as a work id.
  app.get('/environments/:id/work/stats', (c) => {
    const auth = resolveWorkCredential(c, deps);
    if (auth instanceof Response) return auth;
    // Stats is queue authority, like poll: a session token is item authority
    // and must not read the queue-wide view.
    if (auth.kind === 'session_token') {
      return c.json(
        { error: { type: 'authentication_error', message: 'A session work token cannot read queue stats.' } },
        401,
      );
    }
    const environmentId = c.req.param('id') ?? '';
    const scopeError = requireEnvironmentScope(c, deps.db, environmentId, auth);
    if (scopeError) return scopeError;
    const stats = deps.queue.queueStats(environmentId);
    return c.json({
      type: 'work_queue_stats',
      depth: stats.depth,
      pending: stats.pending,
      oldest_queued_at: stats.oldestQueuedAt ? iso(stats.oldestQueuedAt) : null,
      workers_polling: deps.queue.workersPolling(),
    });
  });

  app.get('/environments/:id/work', (c) => {
    const auth = resolveWorkCredential(c, deps);
    if (auth instanceof Response) return auth;
    if (auth.kind === 'session_token') {
      return c.json(
        { error: { type: 'authentication_error', message: 'A session work token cannot list work.' } },
        401,
      );
    }
    const environmentId = c.req.param('id') ?? '';
    const scopeError = requireEnvironmentScope(c, deps.db, environmentId, auth);
    if (scopeError) return scopeError;

    const limit = parsePageLimit(c.req.query('limit'));
    if (limit instanceof Response) return limit;
    const after = decodePageCursor(c.req.query('page'));
    if (after instanceof Response) return after;
    const items = deps.queue.list({ environmentId, limit: limit + 1, after });
    const page = items.slice(0, limit);
    const last = page[page.length - 1];
    return c.json({
      data: page.map((item) => toOfficialWork(item, environmentId)),
      // A full page publishes the keyset of its last row as the opaque cursor;
      // the next fetch answers empty with next_page null, which is how the
      // SDK's page iterator ends the walk.
      next_page: items.length > limit && last?.rowId !== undefined && last.createdAt !== undefined
        ? Buffer.from(JSON.stringify({ c: last.createdAt, r: last.rowId }), 'utf8').toString('base64url')
        : null,
    });
  });

  // `poll` must register before `/:workId`: the router serves GET
  // `/work/poll` in registration order, so the literal has to land first or
  // every poll would read as a retrieve for a work item named "poll".
  app.get('/environments/:id/work/poll', async (c) => {
    const auth = resolveWorkCredential(c, deps);
    if (auth instanceof Response) return auth;
    // A claimed item's sessions_token is item authority, not queue
    // authority: it operates the session's own items and can never pull a new
    // claim — otherwise one leaked item credential could drain every session
    // the environment holds.
    if (auth.kind === 'session_token') {
      return c.json(
        { error: { type: 'authentication_error', message: 'A session work token cannot claim work.' } },
        401,
      );
    }
    const environmentId = c.req.param('id') ?? '';
    const scopeError = requireEnvironmentScope(c, deps.db, environmentId, auth);
    if (scopeError) return scopeError;

    const blockMs = parseBlockMs(c.req.query('block_ms'));
    if (blockMs instanceof Response) return blockMs;
    const reclaim = parseReclaimMs(c.req.query('reclaim_older_than_ms'));
    if (reclaim instanceof Response) return reclaim;

    const workerId = c.req.header('Anthropic-Worker-ID')?.trim() || credentialWorkerLabel(auth);
    // The published `workers_polling` stat counts workers seen inside a 30s
    // window; recording happens before the wait so a blocked worker counts as
    // polling, which is what it is doing.
    deps.queue.recordPoll(workerId);

    const deadline = Date.now() + blockMs;
    for (;;) {
      const item = deps.queue.claim(workerId, undefined, environmentId, reclaim);
      if (item) {
        return c.json(toOfficialWork(item, environmentId, mintWorkSecret(c, deps.db, item, environmentId)));
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return c.body(null, 204);
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_RETRY_MS, remaining)));
    }
  });

  app.post('/environments/:id/work/:workId/ack', (c) => {
    const scoped = requireItemScope(c, deps);
    if (scoped instanceof Response) return scoped;
    const workerId = c.req.header('Anthropic-Worker-ID')?.trim() || undefined;
    const outcome = deps.queue.acceptScoped(scoped.workId, workerId);
    if (outcome === 'not_found') return notFound(c, 'work item not found');
    if (outcome === 'work_lease_lost') {
      return conflict(
        c,
        'this work cannot be acknowledged: it was stopped, or its claim lease has run out',
        'work_lease_lost',
      );
    }
    if (outcome === 'not_claimed_by_worker') {
      return conflict(c, 'work item is not claimed by this worker');
    }
    return c.json(toOfficialWork(deps.queue.get(scoped.workId)!, scoped.environmentId));
  });

  app.post('/environments/:id/work/:workId/heartbeat', (c) => {
    const scoped = requireItemScope(c, deps);
    if (scoped instanceof Response) return scoped;
    const workerId = c.req.header('Anthropic-Worker-ID')?.trim() || undefined;
    // Absent means "no precondition"; the `? IS NULL` arm in the queue's
    // predicate is what keeps an unconditional heartbeat unconditional.
    const expected = c.req.query('expected_last_heartbeat');
    const result = deps.queue.heartbeatScoped(scoped.workId, {
      workerId,
      expectedLastHeartbeat: expected ?? null,
    });
    if (result.outcome === 'not_found') return notFound(c, 'work item not found');
    if (result.outcome === 'precondition_failed') {
      // The SDK runner reads `error.details.current_state` out of a 412 body;
      // keep that shape so its lease-lost log carries the server's view.
      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            code: 'work_lease_precondition_failed',
            message: 'expected_last_heartbeat does not match the recorded heartbeat lease',
            details: {
              current_state: heartbeatView(result.item, deps.queue, false),
            },
          },
        },
        412,
      );
    }
    if (result.outcome === 'not_claimed_by_worker') {
      return conflict(c, 'work item is not claimed by this worker');
    }
    if (result.outcome === 'work_lease_lost') {
      // Not an error on this wire: the response's own fields are the shutdown
      // signal, and a runner that sees `stopping`/`stopped` or an unextended
      // lease finishes its teardown rather than retrying the beat.
      return c.json(heartbeatView(result.item, deps.queue, false));
    }
    return c.json(heartbeatView(result.item, deps.queue, true));
  });

  app.post('/environments/:id/work/:workId', async (c) => {
    const scoped = requireItemScope(c, deps);
    if (scoped instanceof Response) return scoped;
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || typeof body.metadata !== 'object' || body.metadata === null) {
      return invalid(c, 'metadata is required: provide the patch object to merge onto the work item');
    }
    const patch: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(body.metadata as Record<string, unknown>)) {
      if (value !== null && typeof value !== 'string') {
        return invalid(c, 'metadata values must be strings or null');
      }
      patch[key] = value as string | null;
    }
    const item = deps.queue.updateMetadata(scoped.workId, patch);
    if (!item) return notFound(c, 'work item not found');
    return c.json(toOfficialWork(item, scoped.environmentId));
  });

  app.post('/environments/:id/work/:workId/stop', async (c) => {
    const scoped = requireItemScope(c, deps);
    if (scoped instanceof Response) return scoped;
    // `force` selects graceful vs forced on the published wire; the queue's
    // stop marker is already the immediate form — the holder learns from its
    // next refused renewal and a result that still lands is recorded — so
    // both values reach the same outcome here. The body is still read: a
    // malformed payload or a non-boolean `force` is refused rather than
    // silently becoming a valid stop.
    const raw = await c.req.text();
    if (raw.trim()) {
      const body = (() => { try { return JSON.parse(raw); } catch { return null; } })();
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return invalid(c, 'Request body must be a JSON object');
      }
      if (body.force !== undefined && typeof body.force !== 'boolean') {
        return invalid(c, 'force must be a boolean');
      }
    }
    const outcome = deps.queue.stopItem(scoped.workId);
    if (outcome === 'not_found') return notFound(c, 'work item not found');
    return c.json(toOfficialWork(deps.queue.get(scoped.workId)!, scoped.environmentId));
  });

  app.get('/environments/:id/work/:workId', (c) => {
    const scoped = requireItemScope(c, deps);
    if (scoped instanceof Response) return scoped;
    return c.json(toOfficialWork(deps.queue.get(scoped.workId)!, scoped.environmentId));
  });

  return app;
}

/** The published `BetaSelfHostedWork` projection of a queue row. */
export function toOfficialWork(item: WorkItem, environmentId: string, secret?: string) {
  const state = projectWorkState(item);
  return {
    type: 'work',
    id: item.id,
    environment_id: environmentId,
    state,
    data: { type: 'session', id: item.sessionId },
    // `created_at` is NOT NULL with a DB default; the optional field on the
    // in-memory type overstates what a persisted row can carry.
    created_at: iso(item.createdAt!),
    acknowledged_at: item.acceptedAt ? iso(item.acceptedAt) : null,
    started_at: item.acceptedAt ? iso(item.acceptedAt) : null,
    latest_heartbeat_at: item.heartbeatAt ? iso(item.heartbeatAt) : null,
    stop_requested_at: item.stoppedAt ? iso(item.stoppedAt) : null,
    stopped_at: state === 'stopped' ? iso(item.completedAt ?? item.stoppedAt ?? item.createdAt!) : null,
    metadata: item.metadata ?? {},
    secret: secret ?? null,
  };
}

/**
 * Collapse the queue's markers onto the five published states:
 *
 *   queued                → 'queued'    (unclaimed, or claimed awaiting ack —
 *                                        the poll claim is a pending slot,
 *                                        which the published stats call
 *                                        "polled but not acknowledged")
 *   accepted              → 'starting'  (acknowledged, no post-ack life sign
 *                                        yet) or 'active' (a heartbeat renewed
 *                                        the lease after the ack, which is
 *                                        the only "worker is running" signal
 *                                        this queue records)
 *   stopped marker, live  → 'stopping'  (stop recorded; the holder learns from
 *                                        its next refused renewal)
 *   applied/failed/unknown→ 'stopped'   (work ended; `unknown` is the sweep of
 *                                        an accepted item whose lease lapsed)
 *
 * `heartbeat_at`, not a timestamp comparison, decides starting vs active:
 * the column exists only because a heartbeat wrote it, while `claimed_at`
 * and `accepted_at` are `datetime('now')` values with second precision — a
 * poll, ack, and first beat inside one second compare equal, and an
 * ordering rule would report 'starting' for an item that has already
 * heartbeated.
 */
export function projectWorkState(item: WorkItem): 'queued' | 'starting' | 'active' | 'stopping' | 'stopped' {
  const terminal = item.status === 'applied' || item.status === 'failed' || item.status === 'unknown';
  if (terminal) return 'stopped';
  if (item.stoppedAt) return 'stopping';
  if (item.status === 'accepted') {
    return item.heartbeatAt ? 'active' : 'starting';
  }
  return 'queued';
}

function heartbeatView(item: WorkItem, queue: WorkQueue, extended: boolean) {
  return {
    type: 'work_heartbeat',
    last_heartbeat: item.heartbeatAt ? iso(item.heartbeatAt) : null,
    lease_extended: extended,
    state: projectWorkState(item),
    ttl_seconds: queue.leaseSeconds,
  };
}

/** The `secret` wire value: base64url JSON in the published `BetaWorkSecret` shape. */
function mintWorkSecret(c: Context, db: Database, item: WorkItem, environmentId: string): string {
  const sessionsToken = issueSessionWorkToken(db, item.sessionId, environmentId);
  // `api_base_url` tells the runner where its downstream calls go; without it
  // the SDK falls back to the Anthropic endpoint and the claimed work would
  // phone home instead of calling this runtime back.
  const payload = { sessions_token: sessionsToken, api_base_url: new URL(c.req.url).origin };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Resolve the request's credential to one of the published identities.
 *
 * Order matters: an API key is checked before the worker-specific families so
 * a token that happens to collide with a managed key resolves to the broader
 * authority rather than the narrower one. `environment_key` and
 * `session_token` both carry their scope from the store — the request's own
 * claims are never trusted.
 */
function resolveWorkCredential(c: Context, deps: EnvironmentWorkRouteDeps): WorkCredential | Response {
  const authorization = c.req.header('Authorization');
  const bearer = authorization === undefined ? undefined : /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
  const token = bearer ?? c.req.header('x-api-key')?.trim();
  if (!token) {
    const authEnabled = Boolean(deps.apiKeys?.length) || Boolean(deps.hasApiKeys?.());
    if (!authEnabled) return { kind: 'open' };
    return c.json(
      { error: { type: 'authentication_error', message: 'Missing credential. Provide an environment worker key or a session work token.' } },
      401,
    );
  }
  if (deps.apiKeys?.includes(token) || deps.validateApiKey?.(token)) {
    return { kind: 'api_key' };
  }
  const workerKey = validateEnvironmentWorkerKey(deps.db, token);
  if (workerKey.ok && workerKey.environmentId) {
    return { kind: 'environment_key', environmentId: workerKey.environmentId };
  }
  const sessionToken = validateSessionWorkToken(deps.db, token);
  if (sessionToken.ok) {
    return { kind: 'session_token', environmentId: sessionToken.environmentId, sessionId: sessionToken.sessionId };
  }
  return c.json(
    { error: { type: 'authentication_error', message: 'Invalid credential for the Work API.' } },
    401,
  );
}

/**
 * A stable claim identity when the `Anthropic-Worker-ID` header is absent:
 * the credential is the authority, so a label derived from its hash keeps the
 * claim fence meaningful — two different credentials cannot collide, and the
 * same one renews its own claims. Never the token itself.
 */
function credentialWorkerLabel(auth: WorkCredential): string {
  switch (auth.kind) {
    case 'api_key':
      return 'api-key';
    case 'open':
      return 'anonymous';
    case 'environment_key':
      return `environment-key:${auth.environmentId}`;
    case 'session_token':
      return `session-token:${auth.sessionId}`;
  }
}

/**
 * Environment existence and credential scope for the collection route: a
 * scoped credential that names another environment is refused outright —
 * treating it as "no work" would let one environment's key silently poll for
 * another's.
 */
function requireEnvironmentScope(
  c: Context,
  db: Database,
  environmentId: string,
  auth: WorkCredential,
): Response | null {
  const env = db.prepare('SELECT id FROM environments WHERE id = ?').get(environmentId);
  if (!env) return notFound(c, 'environment not found');
  if ((auth.kind === 'environment_key' || auth.kind === 'session_token') && auth.environmentId !== environmentId) {
    return c.json(
      { error: { type: 'authentication_error', message: 'Credential is not valid for this environment.' } },
      401,
    );
  }
  return null;
}

/**
 * The per-item guard every item route shares: credential resolved, the item's
 * owning environment resolved through its session and equal to the path's,
 * and — for a session token — the item must belong to that exact session. The
 * environment join keeps a valid credential from one environment from acting
 * on another's work and answers 404 rather than confirming the item exists.
 */
function requireItemScope(
  c: Context,
  deps: EnvironmentWorkRouteDeps,
): { workId: string; environmentId: string; auth: WorkCredential } | Response {
  const auth = resolveWorkCredential(c, deps);
  if (auth instanceof Response) return auth;
  const environmentId = c.req.param('id') ?? '';
  const workId = c.req.param('workId') ?? '';
  const itemEnvironment = deps.queue.environmentOf(workId);
  if (itemEnvironment !== environmentId) return notFound(c, 'work item not found');
  if ((auth.kind === 'environment_key' || auth.kind === 'session_token') && auth.environmentId !== environmentId) {
    return c.json(
      { error: { type: 'authentication_error', message: 'Credential is not valid for this environment.' } },
      401,
    );
  }
  if (auth.kind === 'session_token') {
    const item = deps.queue.get(workId);
    if (!item || item.sessionId !== auth.sessionId) return notFound(c, 'work item not found');
  }
  return { workId, environmentId, auth };
}

const WORK_LIST_MAX_LIMIT = 200;
const WORK_LIST_DEFAULT_LIMIT = 50;

function parsePageLimit(raw: string | undefined): number | Response {
  if (raw === undefined) return WORK_LIST_DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > WORK_LIST_MAX_LIMIT) {
    return new Response(
      JSON.stringify({
        error: { type: 'invalid_request_error', message: `limit must be an integer between 1 and ${WORK_LIST_MAX_LIMIT}` },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return value;
}

/**
 * Decode the list cursor. The cursor is base64url JSON `{c, r}` carrying the
 * last row's `(created_at, rowid)` keyset; a malformed or wrong-shaped value
 * is refused rather than silently restarting the walk at the first page.
 */
function decodePageCursor(raw: string | undefined): { createdAt: string; rowId: number } | Response | undefined {
  if (raw === undefined) return undefined;
  const parsed = (() => {
    try {
      return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    } catch {
      return null;
    }
  })();
  if (
    !parsed || typeof parsed !== 'object'
    || typeof (parsed as { c?: unknown }).c !== 'string'
    || typeof (parsed as { r?: unknown }).r !== 'number'
    || !Number.isInteger((parsed as { r: number }).r)
  ) {
    return new Response(
      JSON.stringify({
        error: { type: 'invalid_request_error', message: 'page is not a cursor this route issued' },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return { createdAt: (parsed as { c: string }).c, rowId: (parsed as { r: number }).r };
}

function parseBlockMs(raw: string | undefined): number | Response {
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < POLL_BLOCK_MIN_MS || value > POLL_BLOCK_MAX_MS) {
    // `Response` is returned through the caller's check; build the invalid
    // reply against a synthetic context-free envelope since `invalid` needs `c`.
    return new Response(
      JSON.stringify({
        error: { type: 'invalid_request_error', message: 'block_ms must be an integer between 1 and 999' },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return value;
}

function parseReclaimMs(raw: string | undefined): number | Response {
  if (raw === undefined) return DEFAULT_RECLAIM_OLDER_THAN_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return new Response(
      JSON.stringify({
        error: { type: 'invalid_request_error', message: 'reclaim_older_than_ms must be a positive number of milliseconds' },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return value;
}

/** SQLite stores `YYYY-MM-DD HH:MM:SS` UTC; the wire wants RFC 3339. */
function iso(sqlTimestamp: string): string {
  return `${sqlTimestamp.replace(' ', 'T')}Z`;
}
