/**
 * Self-Hosted Worker Routes (R9.14)
 *
 * A user-run Worker polls these endpoints to drain the tool-execution calls a
 * session parks and post results back. The Worker executes the actual commands
 * on the user's own infrastructure — the server never runs them.
 *
 *   POST /v1/x/worker/claim-session { worker_id, session_id } → session claim | 409 | 404
 *   POST /v1/x/worker/claim         { worker_id, session_id? } → work item | 204 | 409
 *   POST /v1/x/worker/accept        { id, worker_id } → { ok: true } | 409
 *   POST /v1/x/worker/heartbeat     { id, worker_id } → { ok: true }
 *   POST /v1/x/worker/complete      { id, worker_id, result, failed? } → { ok: true }
 *
 * The claim unit on the published wire is a whole session; these routes are the
 * local drain channel the calls that session contains use. `claim-session`
 * acquires the session's live claim for this worker — the local equivalent of
 * `poll` + `ack` — and `/claim` then hands out the session's parked calls under
 * it. A `session_id`-scoped `/claim` is gated on the caller holding that
 * session's claim: the calls are the claim's content, so a process that does
 * not hold the claim must not be handed them. An unscoped `/claim` draws only
 * from sessions this worker already claims, so it can never serve a call
 * belonging to a session someone else holds.
 *
 * A worker running an item that outlives the claim lease renews it with
 * `heartbeat`; otherwise the item is treated as abandoned and handed to another
 * worker while the first one is still executing it. A renewal on work whose session
 * has ended answers 409 with the engine-neutral `work_lease_lost` code, which is the
 * runtime's way of telling a worker that is already executing something to stop: the
 * stop marker is persisted server-side, and this is the only channel through which
 * the process holding the command ever learns about it.
 *
 * `accept` closes the other half of the same race, at the opposite end: a claim is a
 * lease on running an item, and the window can pass between claiming and starting, so
 * the claim alone does not authorize execution. A worker confirms with `accept`
 * immediately before it starts, and only `{ ok: true }` authorizes running the item.
 * A refusal is never a completion - the worker must not run it and must not report a
 * result, which would assert an effect that never happened.
 */

import { Hono } from 'hono';
import type { Database } from '@/core/db/database.js';
import type { WorkQueue } from '@/sandbox/self-hosted-provider.js';
import type { SessionWorkQueue } from '@/sandbox/session-work-queue.js';
import { validateEnvironmentWorkerKey } from '@/core/auth/environment-worker-keys.js';
import { issueSessionWorkToken } from '@/core/auth/session-work-tokens.js';

export function workerRoutes(queue: WorkQueue, db?: Database, sessionQueue?: SessionWorkQueue) {
  const app = new Hono();

  /**
   * Acquire the session's live claim for this worker — the local equivalent of
   * `poll` + `ack` on the published wire. The claim is materialized if the
   * session has none (a session's first worker creates it), held by this
   * worker, and acknowledged in the same step so the drain gate sees the
   * `accepted` state it requires. A session that does not exist or has ended
   * answers 404; one already held by another live worker answers 409.
   */
  app.post('/claim-session', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const workerId = body.worker_id;
    const sessionId = body.session_id;
    if (!workerId || typeof workerId !== 'string' || !sessionId || typeof sessionId !== 'string') {
      return c.json({ error: { type: 'invalid_request_error', message: 'worker_id and session_id are required' } }, 400);
    }
    const auth = db ? validateEnvironmentWorkerKey(db, body.environment_key) : { ok: true as const, environmentId: undefined };
    if (!auth.ok) return c.json({ error: { type: 'unauthorized', message: auth.message } }, 401);
    if (!sessionQueue) {
      return c.json({ error: { type: 'invalid_request_error', message: 'session claims are not enabled on this runtime' } }, 400);
    }
    const claim = sessionQueue.claimForSession(workerId, sessionId);
    if (!claim) {
      const envId = db ? sessionEnvironment(db, sessionId) : null;
      const exists = envId !== null;
      if (!exists) return c.json({ error: { type: 'not_found', message: 'session not found or already ended' } }, 404);
      return c.json({
        error: {
          type: 'conflict',
          code: 'work_lease_lost',
          message: 'this session is already claimed by another worker, or its claim is stopped',
        },
      }, 409);
    }
    return c.json(claim);
  });

  app.post('/claim', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const workerId = body.worker_id;
    if (!workerId || typeof workerId !== 'string') {
      return c.json({ error: { type: 'invalid_request_error', message: 'worker_id is required' } }, 400);
    }
    const auth = db ? validateEnvironmentWorkerKey(db, body.environment_key) : { ok: true as const, environmentId: undefined };
    if (!auth.ok) return c.json({ error: { type: 'unauthorized', message: auth.message } }, 401);
    const requestedEnvironmentId = typeof body.environment_id === 'string' ? body.environment_id : undefined;
    if (auth.environmentId && requestedEnvironmentId && requestedEnvironmentId !== auth.environmentId) {
      return c.json({ error: { type: 'invalid_request_error', message: 'environment_id does not match environment_key scope' } }, 400);
    }
    const requestedSessionId = typeof body.session_id === 'string' ? body.session_id : undefined;

    // Session-scoped drain is gated on this worker holding the session's
    // claim: the parked calls are the claim's content, so handing them to a
    // process that does not hold the claim would serve a session nobody
    // committed to. Unscoped claims draw only from sessions this worker holds.
    if (sessionQueue && requestedSessionId) {
      if (!sessionQueue.drainableBy(requestedSessionId, workerId)) {
        return c.json({
          error: {
            type: 'conflict',
            code: 'work_lease_lost',
            message: 'this worker does not hold the session claim; acquire it with /claim-session first',
          },
        }, 409);
      }
    }

    const item = sessionQueue && !requestedSessionId
      ? queue.claimAmongSessions(workerId, claimedSessionIds(sessionQueue, workerId), auth.environmentId ?? requestedEnvironmentId)
      : queue.claim(
        workerId,
        requestedSessionId,
        auth.environmentId ?? requestedEnvironmentId,
      );
    if (!item) return c.body(null, 204);
    // A claimed item carries a per-claim `secret` — the published
    // `BetaWorkSecret` envelope around a `mawt_` bearer — so a `--on-work`
    // handler can forward it into the sandbox that serves this session without
    // ever seeing the environment key. Minting needs the item's environment
    // (joined through its session) and the db handle; without either, the item
    // goes out with no secret and the spawned worker falls back to the
    // forwarded environment key.
    const environmentId = queue.environmentOf(item.id);
    if (db && environmentId) {
      const sessionsToken = issueSessionWorkToken(db, item.sessionId, environmentId);
      const payload = { sessions_token: sessionsToken, api_base_url: new URL(c.req.url).origin };
      return c.json({ ...item, secret: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url') });
    }
    return c.json(item);
  });

  app.post('/heartbeat', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.id || typeof body.id !== 'string' || !body.worker_id || typeof body.worker_id !== 'string') {
      return c.json({ error: { type: 'invalid_request_error', message: 'id and worker_id are required' } }, 400);
    }
    const outcome = queue.heartbeat(body.id, body.worker_id);
    if (outcome === 'not_found') {
      return c.json({ error: { type: 'not_found', message: 'work item not found' } }, 404);
    }
    if (outcome === 'work_lease_lost') {
      // The code, not the message, is what a caller acts on: a worker that reads prose
      // would keep executing a command the session has already stopped. The status stays
      // 409 because the request conflicts with the row's current state; the code says
      // which conflict, and this one is about the work rather than about the caller.
      return c.json({
        error: {
          type: 'conflict',
          code: 'work_lease_lost',
          message: 'this work was stopped because the session that queued it has ended',
        },
      }, 409);
    }
    if (outcome === 'not_claimed_by_worker') {
      return c.json({ error: { type: 'conflict', message: 'work item is not claimed by this worker' } }, 409);
    }
    return c.json({ ok: true });
  });

  app.post('/accept', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.id || typeof body.id !== 'string' || !body.worker_id || typeof body.worker_id !== 'string') {
      return c.json({ error: { type: 'invalid_request_error', message: 'id and worker_id are required' } }, 400);
    }
    const outcome = queue.accept(body.id, body.worker_id);
    if (outcome === 'not_found') {
      return c.json({ error: { type: 'not_found', message: 'work item not found' } }, 404);
    }
    if (outcome === 'work_lease_lost') {
      // One code for both the stopped item and the lapsed lease, because the instruction
      // to the worker is the same either way - do not run it - while the message says
      // which of the two it was. A worker that cannot tell them apart still does the
      // right thing, and one that reads the message knows whether to resubmit.
      return c.json({
        error: {
          type: 'conflict',
          code: 'work_lease_lost',
          message: 'this work cannot be accepted: it was stopped, or its claim lease has run out',
        },
      }, 409);
    }
    if (outcome === 'not_claimed_by_worker') {
      return c.json({ error: { type: 'conflict', message: 'work item is not claimed by this worker' } }, 409);
    }
    return c.json({ ok: true });
  });

  app.post('/complete', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.id || typeof body.id !== 'string' || !body.worker_id || typeof body.worker_id !== 'string') {
      return c.json({ error: { type: 'invalid_request_error', message: 'id and worker_id are required' } }, 400);
    }
    const outcome = queue.complete(body.id, body.worker_id, body.result, body.failed === true);
    if (outcome === 'not_found') {
      return c.json({ error: { type: 'not_found', message: 'work item not found' } }, 404);
    }
    if (outcome === 'not_claimed_by_worker') {
      return c.json({ error: { type: 'conflict', message: 'work item is not claimed by this worker' } }, 409);
    }
    return c.json({ ok: true });
  });

  return app;
}

/** The session's environment, or null when it cannot be attributed. */
function sessionEnvironment(db: Database, sessionId: string): string | null {
  const row = db.prepare('SELECT environment_id FROM sessions WHERE id = ?').get(sessionId) as
    | { environment_id: string | null }
    | undefined;
  return row?.environment_id ?? null;
}

/** The sessions this worker currently holds a live claim on. */
function claimedSessionIds(sessionQueue: SessionWorkQueue, workerId: string): string[] {
  return sessionQueue.sessionIdsClaimedBy(workerId);
}
