/**
 * Session work claims — the published claim unit on `/v1/environments/{id}/work`.
 *
 * Upstream, a work item is one session's lifecycle: a worker claims the
 * session once (`data: {type:"session", id}`), acknowledges it, heartbeats the
 * claim lease, and serves every tool call the session parks — then
 * `stop`/`force` ends the session service. This class is that claim object.
 * The per-call `work_items` rows in `WorkQueue` are the *calls a held claim
 * contains* — drained under it, never the claim unit themselves.
 *
 * Why a separate lease object rather than re-scoping `work_items`: the two
 * lifecycles differ on the one point that matters. A per-call item is a side
 * effect, so an accepted claim that lapses must go `unknown` rather than be
 * silently replayed. A session claim is different — its content is the
 * session's server-recorded parked calls, so re-claiming it after the lease
 * lapses resumes rather than replays, and a session whose worker died is
 * legitimately re-claimed by the next poller (upstream's `reclaim_older_than_ms`
 * exists for exactly that). Sharing one table would make every predicate
 * conditional on which kind of claim it is; two focused tables each hold one
 * coherent lifecycle.
 *
 * Lifecycle (`status`): `queued` → `claimed` → `accepted` → `stopping` →
 * `stopped`. `queued` is claimable; `claimed` is held but unacknowledged (its
 * reclaim window is the caller's `reclaim_older_than_ms`); `accepted` is the
 * execution commitment and is governed by the claim's own TTL
 * (`ttl_seconds`, set by heartbeat's `desired_ttl_seconds` or the queue
 * default); `stopping` is a graceful stop awaiting worker confirmation;
 * `stopped` is terminal. A live-status claim whose lease lapsed is
 * re-claimable; a `stopped` claim is never claimable again, and a session
 * that produces more work gets a NEW row — the partial unique index enforces
 * one live claim per session.
 */

import { nanoid } from 'nanoid';
import type { Database } from '@/core/db/database.js';
import { SESSION_TRANSITIONS } from '@/types/session.js';

/**
 * The session-claim row projected onto the published `BetaSelfHostedWork`
 * shape by the routes. Field names mirror `WorkItem` where the semantics
 * match: `claimedBy`/`claimedAt` are the claim lease, `acceptedAt` the
 * execution commitment, `heartbeatAt` the heartbeat-lease anchor,
 * `stopRequestedAt`/`stoppedAt` the shutdown markers.
 */
export interface SessionWorkClaim {
  id: string;
  sessionId: string;
  environmentId: string;
  /**
   * `queued` is fresh or re-claimed-and-unacknowledged. `claimed` is held but
   * unacknowledged. `accepted` is the ack'd, in-service state. `stopping` is
   * graceful-stop-requested. `stopped` is terminal.
   */
  status: 'queued' | 'claimed' | 'accepted' | 'stopping' | 'stopped';
  claimedBy?: string | null;
  claimedAt?: string | null;
  acceptedAt?: string | null;
  heartbeatAt?: string | null;
  stopRequestedAt?: string | null;
  stoppedAt?: string | null;
  /**
   * The claim's effective lease in seconds — the value a heartbeat reports as
   * `ttl_seconds` and the window the reclaim predicate uses once the claim is
   * accepted. Set by heartbeat's `desired_ttl_seconds`; `NULL` reads as the
   * queue default.
   */
  ttlSeconds?: number | null;
  metadata?: Record<string, string>;
  createdAt?: string;
  /** Second half of the list keyset cursor; populated only by `list`. */
  rowId?: number;
  /**
   * The owning session's status, joined for the projection — a session that
   * reached a terminal state ends its claim's service even when no stop was
   * recorded. Populated by `get`/`list`; absent where not selected.
   */
  sessionStatus?: string | null;
}

export type SessionClaimOutcome = 'claimed' | 'not_found' | 'not_claimable';
export type SessionAckOutcome = 'accepted' | 'not_found' | 'not_claimed_by_worker' | 'work_lease_lost';
export type SessionStopOutcome = 'stopping' | 'stopped' | 'not_found';

export type SessionHeartbeatOutcome =
  | { outcome: 'renewed'; claim: SessionWorkClaim; lastHeartbeat: string }
  | { outcome: 'not_found' }
  | { outcome: 'precondition_failed'; claim: SessionWorkClaim }
  | { outcome: 'not_claimed_by_worker'; claim: SessionWorkClaim }
  | { outcome: 'work_lease_lost'; claim: SessionWorkClaim };

/** The configured claim lease in milliseconds — the default when no per-claim TTL is set. */
export const DEFAULT_SESSION_CLAIM_LEASE_MS = 60_000;

/** Terminal session statuses — a session that ended can no longer be claimed for work. */
const TERMINAL_SESSION_STATUSES: string[] = Object.entries(SESSION_TRANSITIONS)
  .filter(([, next]) => next.length === 0)
  .map(([status]) => status);
const TERMINAL_SESSION_STATUS_SQL = TERMINAL_SESSION_STATUSES.map((status) => `'${status}'`).join(', ');

/**
 * The claim-side queue primitives the official work routes project. Lives
 * beside `WorkQueue`, not inside it — the two lifecycles are deliberately
 * distinct so neither predicate has to guess which claim it is acting on.
 */
export class SessionWorkQueue {
  private readonly leaseMs: number;

  /**
   * Worker identities seen on the official `work/poll` route, in-memory only —
   * the `workers_polling` window is defined as workers seen inside 30s, so a
   * restart forgets them by design.
   */
  private readonly pollSeen = new Map<string, number>();

  constructor(private readonly db: Database, options: { leaseMs?: number } = {}) {
    this.leaseMs = typeof options.leaseMs === 'number' && Number.isFinite(options.leaseMs) && options.leaseMs > 0
      ? Math.floor(options.leaseMs)
      : DEFAULT_SESSION_CLAIM_LEASE_MS;
  }

  /** The default claim lease in seconds — what an unset TTL reports as `ttl_seconds`. */
  get leaseSeconds(): number {
    return this.leaseMs / 1000;
  }

  /**
   * Create the session's live claim if none exists, and return it.
   *
   * "Live" is a non-`stopped` row on a session that has not itself ended.
   * Materializing here — at session create, sandbox provision, and every
   * contained-item enqueue — is what makes the claim exist exactly when the
   * session first has work to serve, which is the published "Anthropic
   * enqueues the session as a work item" boundary. The partial unique index
   * on `session_id WHERE status != 'stopped'` makes the insert idempotent
   * under concurrent calls; a second caller that loses the race reads back
   * the row the first one wrote.
   *
   * A stopped claim is not resurrected: a session that produces more work
   * gets a NEW claim row, matching the published "the session's work is
   * queued again" rule. A missing or terminal session produces no claim —
   * there is nothing for a worker to serve.
   */
  ensure(sessionId: string): SessionWorkClaim | null {
    const session = this.db
      .prepare('SELECT environment_id, status FROM sessions WHERE id = ?')
      .get(sessionId) as { environment_id: string | null; status: string } | undefined;
    if (!session || !session.environment_id) return null;
    if (TERMINAL_SESSION_STATUSES.includes(session.status)) {
      // A session that ended has no work to serve — retire any claim it still
      // holds rather than hand it out.
      this.stopForSession(sessionId);
      return null;
    }
    const live = this.liveForSession(sessionId);
    if (live) return live;
    // The partial unique index makes this idempotent under concurrent calls: a
    // caller that loses the race reads back the row the winner wrote.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO session_work_claims (id, session_id, environment_id, status)
         VALUES (?, ?, ?, 'queued')`,
      )
      .run(`work_${nanoid(16)}`, sessionId, session.environment_id);
    return this.liveForSession(sessionId);
  }

  /** The session's non-`stopped` claim, or null when none exists. */
  liveForSession(sessionId: string): SessionWorkClaim | null {
    const r = this.db
      .prepare(
        `SELECT swc.*, s.status AS session_status, swc.rowid AS claim_row_id
         FROM session_work_claims swc
         LEFT JOIN sessions s ON s.id = swc.session_id
         WHERE swc.session_id = ? AND swc.status != 'stopped'
         ORDER BY swc.created_at DESC, swc.rowid DESC
         LIMIT 1`,
      )
      .get(sessionId) as RawSessionClaim | undefined;
    return r ? toSessionClaim(r) : null;
  }

  /**
   * Whether `workerId` may drain this session's contained calls: the session
   * has a live claim, it is held by this worker, it is `accepted` (the
   * execution commitment, not merely held), and the lease has not lapsed.
   *
   * This is the drain gate — contained items belong to the held claim, so a
   * process that does not hold the claim must not be handed them. `accepted`
   * is required rather than merely `claimed` because `ack` is the published
   * commitment point; draining under a held-but-unacked claim would serve a
   * session nobody committed to. During `stopping` no new call is handed out —
   * the in-flight one finishes, which is what graceful stop is for.
   */
  drainableBy(sessionId: string, workerId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM session_work_claims
         WHERE session_id = ? AND claimed_by = ? AND status = 'accepted'
           AND claimed_at IS NOT NULL
           AND claimed_at > datetime('now', '-' || COALESCE(ttl_seconds, ?) || ' seconds')`,
      )
      .get(sessionId, workerId, this.leaseSeconds);
    return row !== undefined;
  }

  /**
   * Claim the oldest claimable session claim in the environment — the official
   * `poll` verb. A claim is claimable when it is live (non-`stopped`, session
   * not terminal) and either never held or held under a lease that has
   * lapsed. The lapse window is two-valued on purpose, matching the published
   * split: an unacknowledged (`claimed`) claim is reclaimed by the caller's
   * `reclaim_older_than_ms` window, while an `accepted`/`stopping` claim is
   * governed by the claim's own TTL — a worker that committed and then died
   * is handed back only after its heartbeat lease genuinely ran out.
   *
   * Claiming resets the claim epoch: `accepted_at` and `heartbeat_at` clear
   * so a re-claim starts unacknowledged and unheartbeated, and the superseded
   * holder's credential is revoked so a stale worker cannot split-brain the
   * session. The update is a single guarded statement — only the worker whose
   * UPDATE flips the row wins, so two concurrent pollers can never hold the
   * same claim.
   */
  claim(workerId: string, environmentId: string, reclaimOlderThanMs?: number): SessionWorkClaim | null {
    const reclaimModifier = typeof reclaimOlderThanMs === 'number' && Number.isFinite(reclaimOlderThanMs) && reclaimOlderThanMs > 0
      ? `-${Math.floor(reclaimOlderThanMs) / 1000} seconds`
      : `-${DEFAULT_RECLAIM_MS_FALLBACK / 1000} seconds`;
    const claimable = (prefix: string): string =>
      `(${prefix}status != 'stopped'
        AND (${prefix}claimed_at IS NULL
          OR (${prefix}status = 'claimed' AND ${prefix}claimed_at <= datetime('now', ?))
          OR (${prefix}status != 'claimed' AND ${prefix}claimed_at <= datetime('now', '-' || COALESCE(${prefix}ttl_seconds, ${this.leaseSeconds}) || ' seconds'))))`;
    return this.db.transaction(() => {
      const candidate = this.db
        .prepare(
          `SELECT swc.id
           FROM session_work_claims swc
           JOIN sessions s ON s.id = swc.session_id
           WHERE ${claimable('swc.')}
             AND swc.environment_id = ?
             AND s.status NOT IN (${TERMINAL_SESSION_STATUS_SQL})
           ORDER BY swc.created_at ASC, swc.rowid ASC
           LIMIT 1`,
        )
        .get(reclaimModifier, environmentId) as { id: string } | undefined;
      if (!candidate) return null;

      const res = this.db
        .prepare(
          `UPDATE session_work_claims
           SET claimed_by = ?, claimed_at = datetime('now'), status = 'claimed',
               accepted_at = NULL, heartbeat_at = NULL
           WHERE id = ? AND ${claimable('')}`,
        )
        .run(workerId, candidate.id, reclaimModifier) as { changes: number };
      if (res.changes !== 1) return null;

      // The superseded holder's credential dies with its epoch: a worker that
      // lost the claim must not keep touching the session under the old token.
      this.db
        .prepare(
          `UPDATE session_work_tokens SET revoked_at = datetime('now')
           WHERE session_id = (SELECT session_id FROM session_work_claims WHERE id = ?)
             AND revoked_at IS NULL`,
        )
        .run(candidate.id);
      return this.get(candidate.id);
    });
  }

  /**
   * Claim the session's live claim for a specific worker — the local
   * session-scoped drain path a `worker run` process takes. Materializes the
   * claim when none exists (a session's first worker creates it), claims it
   * for this worker, and acknowledges it in the same step so the drain gate
   * sees the `accepted` state it requires. Returns the claim, or null when
   * another worker already holds it live.
   */
  claimForSession(workerId: string, sessionId: string): SessionWorkClaim | null {
    const live = this.ensure(sessionId);
    if (!live) return null;
    return this.db.transaction(() => {
      const res = this.db
        .prepare(
          `UPDATE session_work_claims
           SET claimed_by = ?, claimed_at = datetime('now'), status = 'accepted',
               accepted_at = datetime('now'), heartbeat_at = NULL
           WHERE id = ?
             AND status != 'stopped'
             AND (claimed_by IS NULL OR claimed_by = ?
               OR claimed_at <= datetime('now', '-' || COALESCE(ttl_seconds, ${this.leaseSeconds}) || ' seconds'))`,
        )
        .run(workerId, live.id, workerId) as { changes: number };
      if (res.changes !== 1) return null;
      this.db
        .prepare(
          `UPDATE session_work_tokens SET revoked_at = datetime('now')
           WHERE session_id = ? AND revoked_at IS NULL`,
        )
        .run(sessionId);
      return this.get(live.id);
    });
  }

  /**
   * The published `ack` — confirm the claim at the moment service starts.
   * Guarded on the row still being held, inside its lease, and unstopped; an
   * `Anthropic-Worker-ID` header, when present, must match the recorded holder.
   * Re-acknowledging is idempotent for the holder (`accepted_at` restamps).
   */
  ack(id: string, workerId?: string): SessionAckOutcome {
    const update = this.db
      .prepare(
        `UPDATE session_work_claims SET status = 'accepted', accepted_at = datetime('now')
         WHERE id = ? AND status IN ('claimed', 'accepted') AND stopped_at IS NULL
           AND claimed_at IS NOT NULL
           AND claimed_at > datetime('now', '-' || COALESCE(ttl_seconds, ?) || ' seconds')
           AND (? IS NULL OR claimed_by = ?)`,
      )
      .run(id, this.leaseSeconds, workerId ?? null, workerId ?? null) as { changes: number };
    if (update.changes === 1) return 'accepted';
    const row = this.get(id);
    if (!row) return 'not_found';
    if (row.stoppedAt || row.status === 'stopped') return 'work_lease_lost';
    if (workerId && row.claimedBy && row.claimedBy !== workerId) return 'not_claimed_by_worker';
    return 'work_lease_lost';
  }

  /**
   * The published `heartbeat` — renew the claim lease, honoring the
   * `expected_last_heartbeat` optimistic-concurrency precondition and the
   * `NO_HEARTBEAT` first-claim sentinel, and record the claim's
   * `desired_ttl_seconds` when the caller asks for one.
   *
   * The anchor is `heartbeat_at`, set by the first beat — poll does not create
   * a heartbeat lease, so `NO_HEARTBEAT` is what claims it. A stale
   * `expected_last_heartbeat` is a `412` carrying the server's view; a stopped
   * or terminal claim answers not-renewed with the projected state — the
   * shutdown signal.
   */
  heartbeat(
    id: string,
    opts: { workerId?: string; expectedLastHeartbeat?: string | null; desiredTtlSeconds?: number | null } = {},
  ): SessionHeartbeatOutcome {
    const update = this.db
      .prepare(
        `UPDATE session_work_claims
         SET claimed_at = datetime('now'),
             heartbeat_at = datetime('now'),
             ttl_seconds = CASE WHEN ? IS NOT NULL AND ? > 0 THEN ? ELSE ttl_seconds END
         WHERE id = ? AND status IN ('claimed', 'accepted', 'stopping') AND stopped_at IS NULL
           AND (
             ? IS NULL
             OR claimed_by = ?
             OR (heartbeat_at IS NULL AND ? = 'NO_HEARTBEAT')
           )
           AND (
             ? IS NULL
             OR (? = 'NO_HEARTBEAT' AND heartbeat_at IS NULL)
             OR REPLACE(heartbeat_at, ' ', 'T') || 'Z' = ?
           )`,
      )
      .run(
        opts.desiredTtlSeconds ?? null,
        opts.desiredTtlSeconds ?? null,
        opts.desiredTtlSeconds ?? null,
        id,
        opts.workerId ?? null,
        opts.workerId ?? null,
        opts.expectedLastHeartbeat ?? null,
        opts.expectedLastHeartbeat ?? null,
        opts.expectedLastHeartbeat ?? null,
        opts.expectedLastHeartbeat ?? null,
      ) as { changes: number };
    if (update.changes === 1) {
      const claim = this.get(id)!;
      return { outcome: 'renewed', claim, lastHeartbeat: claim.heartbeatAt! };
    }
    const claim = this.get(id);
    if (!claim) return { outcome: 'not_found' };
    if (opts.expectedLastHeartbeat != null) {
      const expected = opts.expectedLastHeartbeat;
      const matched = expected === 'NO_HEARTBEAT'
        ? claim.heartbeatAt == null
        : claim.heartbeatAt != null && `${claim.heartbeatAt.replace(' ', 'T')}Z` === expected;
      if (!matched) return { outcome: 'precondition_failed', claim };
    }
    if (claim.stoppedAt || claim.status === 'stopped') return { outcome: 'work_lease_lost', claim };
    return { outcome: 'not_claimed_by_worker', claim };
  }

  /**
   * The published `stop` — graceful by default, `stopped` at once on
   * `force: true`.
   *
   * Graceful writes the `stopping` marker: the holder learns from its next
   * heartbeat, finishes or cancels its in-flight call, and confirms by calling
   * stop again — a second stop on a `stopping` claim completes it. `force`
   * writes `stopped` immediately; in both cases the claim is never claimable
   * again and the contained items it held stop being drainable (they are not
   * marked `stopped_at` — a session that produces more work earns a NEW claim,
   * and its parked calls must still be answerable under it).
   */
  stop(id: string, force?: boolean): SessionStopOutcome {
    const row = this.get(id);
    if (!row) return 'not_found';
    if (row.status === 'stopped' || row.stoppedAt) return 'stopped';
    if (force || row.status === 'stopping') {
      this.db
        .prepare(
          `UPDATE session_work_claims
           SET status = 'stopped', stopped_at = datetime('now'),
               stop_requested_at = COALESCE(stop_requested_at, datetime('now'))
           WHERE id = ?`,
        )
        .run(id);
      // The claim's credential authority ends with it: a stopped claim's
      // token can no longer read the session it served.
      this.db
        .prepare(
          `UPDATE session_work_tokens SET revoked_at = datetime('now')
           WHERE session_id = ? AND revoked_at IS NULL`,
        )
        .run(row.sessionId);
      return 'stopped';
    }
    this.db
      .prepare(
        `UPDATE session_work_claims
         SET status = 'stopping', stop_requested_at = datetime('now')
         WHERE id = ? AND status != 'stopped'`,
      )
      .run(id);
    return 'stopping';
  }

  /**
   * Mark the session's live claim stopped — the session-end half of
   * {@link WorkQueue.stop}. Called from sandbox cleanup when the session is
   * over; marks the claim terminal so it is never handed out again and revokes
   * the claim's credential.
   */
  stopForSession(sessionId: string): number {
    const res = this.db
      .prepare(
        `UPDATE session_work_claims SET status = 'stopped', stopped_at = datetime('now')
         WHERE session_id = ? AND status != 'stopped'`,
      )
      .run(sessionId) as { changes: number };
    if (res.changes > 0) {
      this.db
        .prepare(
          `UPDATE session_work_tokens SET revoked_at = datetime('now')
           WHERE session_id = ? AND revoked_at IS NULL`,
        )
        .run(sessionId);
    }
    return res.changes;
  }

  /**
   * Merge a metadata patch onto a claim — the published update semantics:
   * a `null` value deletes the key, a string upserts it, omitted keys are
   * preserved. Returns the updated claim, or `null` when it does not exist.
   */
  updateMetadata(id: string, patch: Record<string, string | null>): SessionWorkClaim | null {
    const existing = this.get(id);
    if (!existing) return null;
    const merged = { ...(existing.metadata ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else merged[key] = String(value);
    }
    this.db.prepare('UPDATE session_work_claims SET metadata = ? WHERE id = ?').run(JSON.stringify(merged), id);
    return this.get(id);
  }

  /** One claim by id, with its owning session's status joined for projection. */
  get(id: string): SessionWorkClaim | null {
    const r = this.db
      .prepare(
        `SELECT swc.*, s.status AS session_status
         FROM session_work_claims swc
         LEFT JOIN sessions s ON s.id = swc.session_id
         WHERE swc.id = ?`,
      )
      .get(id) as RawSessionClaim | undefined;
    return r ? toSessionClaim(r) : null;
  }

  /** The claim's environment — denormalized on the row, so no join is needed. */
  environmentOf(id: string): string | null {
    const row = this.db
      .prepare('SELECT environment_id FROM session_work_claims WHERE id = ?')
      .get(id) as { environment_id: string } | undefined;
    return row ? row.environment_id : null;
  }

  /** The claim's owning session, for the session-token item-scope fence. */
  sessionOf(id: string): string | null {
    const row = this.db
      .prepare('SELECT session_id FROM session_work_claims WHERE id = ?')
      .get(id) as { session_id: string } | undefined;
    return row ? row.session_id : null;
  }

  /**
   * The sessions this worker currently holds a live (`accepted`) claim on —
   * the population an unscoped `/v1/x/worker/claim` may draw from. A claim a
   * worker holds but has not acked does not qualify: draining under a
   * held-but-unacked claim would serve a session nobody committed to.
   */
  sessionIdsClaimedBy(workerId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT session_id FROM session_work_claims
         WHERE claimed_by = ? AND status = 'accepted' AND stopped_at IS NULL
           AND claimed_at IS NOT NULL
           AND claimed_at > datetime('now', '-' || COALESCE(ttl_seconds, ?) || ' seconds')`,
      )
      .all(workerId, this.leaseSeconds) as Array<{ session_id: string }>;
    return rows.map((r) => r.session_id);
  }

  /**
   * Page of claims, newest first. `after` is the keyset cursor the list route
   * hands back as `next_page`: `created_at` has second precision, so the pair
   * `(created_at, rowid)` is the only boundary that cannot skip or repeat a
   * row sharing a second.
   */
  list(opts: { environmentId?: string; limit?: number; after?: { createdAt: string; rowId: number } } = {}): SessionWorkClaim[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const keyset = (prefix: string) =>
      `(${prefix}created_at < ? OR (${prefix}created_at = ? AND ${prefix}rowid < ?))`;
    const keysetArgs = opts.after ? [opts.after.createdAt, opts.after.createdAt, opts.after.rowId] : [];
    const rows = opts.environmentId
      ? this.db.prepare(
        `SELECT swc.*, s.status AS session_status, swc.rowid AS claim_row_id
         FROM session_work_claims swc
         LEFT JOIN sessions s ON s.id = swc.session_id
         WHERE swc.environment_id = ?${opts.after ? ` AND ${keyset('swc.')}` : ''}
         ORDER BY swc.created_at DESC, swc.rowid DESC
         LIMIT ?`,
      ).all(opts.environmentId, ...keysetArgs, limit)
      : this.db.prepare(
        `SELECT swc.*, s.status AS session_status, swc.rowid AS claim_row_id
         FROM session_work_claims swc
         LEFT JOIN sessions s ON s.id = swc.session_id
         ${opts.after ? `WHERE ${keyset('swc.')}` : ''}
         ORDER BY swc.created_at DESC, swc.rowid DESC
         LIMIT ?`,
      ).all(...keysetArgs, limit);
    return (rows as unknown as RawSessionClaim[]).map(toSessionClaim);
  }

  /**
   * The published `work_queue_stats` counters over session claims.
   *
   * `depth` is what a poll could hand out now — a live claim never held, or a
   * live claim whose lease lapsed (unacked claims measure the reclaim window;
   * accepted/stopping ones their own TTL). `pending` is a held-but-unacked
   * claim inside its lease — the published "polled but not acknowledged"
   * population, which a poller that acks immediately keeps near zero.
   * `oldest_queued_at` spans the same live population.
   */
  queueStats(environmentId: string, reclaimOlderThanMs?: number): { depth: number; pending: number; oldestQueuedAt: string | null } {
    const reclaimMod = typeof reclaimOlderThanMs === 'number' && Number.isFinite(reclaimOlderThanMs) && reclaimOlderThanMs > 0
      ? `-${Math.floor(reclaimOlderThanMs) / 1000} seconds`
      : `-${DEFAULT_RECLAIM_MS_FALLBACK / 1000} seconds`;
    const row = this.db.prepare(
      `SELECT
         SUM(CASE WHEN swc.claimed_at IS NULL
               OR (swc.status = 'claimed' AND swc.claimed_at <= datetime('now', ?))
               OR (swc.status != 'claimed' AND swc.claimed_at <= datetime('now', '-' || COALESCE(swc.ttl_seconds, ${this.leaseSeconds}) || ' seconds'))
             THEN 1 ELSE 0 END) AS depth,
         SUM(CASE WHEN swc.status = 'claimed' AND swc.claimed_at IS NOT NULL
               AND swc.claimed_at > datetime('now', ?)
             THEN 1 ELSE 0 END) AS pending,
         MIN(CASE WHEN swc.claimed_at IS NULL
               OR (swc.status = 'claimed' AND swc.claimed_at <= datetime('now', ?))
               OR (swc.status != 'claimed' AND swc.claimed_at <= datetime('now', '-' || COALESCE(swc.ttl_seconds, ${this.leaseSeconds}) || ' seconds'))
             THEN swc.created_at ELSE NULL END) AS oldest_queued_at
       FROM session_work_claims swc
       JOIN sessions s ON s.id = swc.session_id
       WHERE swc.environment_id = ?
         AND swc.status != 'stopped'
         AND s.status NOT IN (${TERMINAL_SESSION_STATUS_SQL})`,
    ).get(
      // depth: unacked window, then (inline) TTL modifier
      reclaimMod,
      // pending: unacked window again — inside it still counts as pending
      reclaimMod,
      // oldest_queued_at: same two windows as depth
      reclaimMod,
      environmentId,
    ) as { depth: number | null; pending: number | null; oldest_queued_at: string | null };
    return {
      depth: row.depth ?? 0,
      pending: row.pending ?? 0,
      oldestQueuedAt: row.oldest_queued_at,
    };
  }

  /**
   * Record a worker identity seen on the official poll route. The
   * `workers_polling` stat counts identities seen inside its window; entries
   * age out lazily — a worker that stopped polling stops counting.
   */
  recordPoll(workerId: string): void {
    const now = Date.now();
    this.pollSeen.set(workerId, now);
    for (const [id, at] of this.pollSeen) {
      if (now - at > 60_000) this.pollSeen.delete(id);
    }
  }

  /** Workers that polled inside `windowMs` (30s on the published surface). */
  workersPolling(windowMs = 30_000): number {
    const cutoff = Date.now() - windowMs;
    let count = 0;
    for (const at of this.pollSeen.values()) if (at >= cutoff) count += 1;
    return count;
  }
}

const DEFAULT_RECLAIM_MS_FALLBACK = 5_000;

interface RawSessionClaim {
  id: string;
  session_id: string;
  environment_id: string;
  status: string;
  claimed_by: string | null;
  claimed_at: string | null;
  accepted_at: string | null;
  heartbeat_at: string | null;
  stop_requested_at: string | null;
  stopped_at: string | null;
  ttl_seconds: number | null;
  metadata: string | null;
  created_at: string;
  claim_row_id?: number;
  session_status?: string | null;
}

function toSessionClaim(r: RawSessionClaim): SessionWorkClaim {
  return {
    id: r.id,
    sessionId: r.session_id,
    environmentId: r.environment_id,
    status: r.status as SessionWorkClaim['status'],
    claimedBy: r.claimed_by ?? null,
    claimedAt: r.claimed_at ?? null,
    acceptedAt: r.accepted_at ?? null,
    heartbeatAt: r.heartbeat_at ?? null,
    stopRequestedAt: r.stop_requested_at ?? null,
    stoppedAt: r.stopped_at ?? null,
    ttlSeconds: r.ttl_seconds ?? null,
    metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, string>) : {},
    createdAt: r.created_at,
    rowId: r.claim_row_id,
    sessionStatus: r.session_status ?? null,
  };
}
