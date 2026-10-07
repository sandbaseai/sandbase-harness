/**
 * Self-Hosted Sandbox Provider (Requirement 9.14)
 *
 * Instead of executing tool calls in-process, this provider enqueues them as
 * work items. A user-run Worker process (on their own infrastructure) claims
 * items, executes them, and posts results back. The Session state machine and
 * the Worker communicate ONLY through the standardized work-item protocol —
 * neither assumes the other's implementation.
 *
 * The queue is persisted in SQLite so Workers can poll across restarts. This
 * module provides both the SandboxProvider (server side, enqueues + awaits) and
 * the queue primitives the HTTP worker endpoints use to claim/complete items.
 */

import { nanoid } from 'nanoid';
import type { Database } from '@/core/db/database.js';
import { SESSION_TRANSITIONS } from '@/types/session.js';
import {
  sandboxCapabilities,
  type SandboxProvider,
  type SandboxInstance,
  type EnvironmentConfig,
  type ExecOptions,
  type ExecResult,
} from '@/types/sandbox.js';

export type WorkItemKind = 'exec' | 'write' | 'read' | 'list';

export interface WorkItem {
  id: string;
  sessionId: string;
  kind: WorkItemKind;
  payload: Record<string, unknown>;
/**
   * Where the item is in the one chain the frozen worker-protocol spec fixes:
   * `queued -> accepted -> applied`, plus `failed` and `unknown`.
   *
   * The chain is about **commitment**, not about who is holding the row, and that is the
   * whole reason it is worded this way. `queued` means nobody has committed to running the
   * item - whether or not a worker currently holds a lease on it - so it covers both an item
   * nobody has touched and one a worker has claimed but not accepted. `accepted` means a
   * worker confirmed the claim and committed to running it, which is the point from which
   * the effect may already have happened. `applied` means it did, `failed` means it was
   * attempted and did not, and `unknown` means it was accepted and the outcome is not known.
   *
   * The previous vocabulary wrote `claimed` on the take and left it there, so a reader could
   * not tell "taken, not started" from "committed, outcome unknown" without also reading
   * `accepted_at` - a status that means two things depending on a second column. The held-
   * but-uncommitted case moving back to `queued` is not a lost distinction: `claimed_by` and
   * `claimed_at` still record the lease, and the status now says the thing only it can say.
   */
  status: 'queued' | 'accepted' | 'applied' | 'failed' | 'unknown';
  result?: unknown;
  claimedBy?: string | null;
  createdAt?: string;
  claimedAt?: string | null;
  completedAt?: string | null;
  /**
   * When the owning session ended and its unfinished work was stopped. A marked item
   * is never handed to a worker - not on a first claim, and not on a reclaim after a
   * claim lease expired - while the worker already holding it may still report a
   * result that did happen.
   */
  stoppedAt?: string | null;
  /**
   * When the holder confirmed, at the moment of starting, that the claim was still
   * live - the point at which "somebody took it" becomes "somebody has committed to
   * running it". Null means held but never started; a reclaim by a new holder clears
   * it, because acceptance belongs to the holder that asked for it.
   *
   * **This is the line the replay rule is drawn on**, and it is not the same line
   * `abandonedAt` sits on - the two are on opposite sides of it and must not be confused.
   * Before an acceptance, nothing ran, so lapsed work is free to be handed out again.
   * After one, the holder committed to running the item, so its effect may already have
   * happened and re-offering it would replay that effect silently. A lapsed **accepted**
   * claim therefore blocks the reclaim arm of the claim predicate and the item moves to
   * `unknown` instead.
   */
  acceptedAt?: string | null;
  /**
   * When a bounded wait gave up on this item before any executor committed to running it.
   * **A record, not a fence:** nothing refuses this item on it. It says a previous attempt
   * ended without starting - which is real, because nothing was accepted and so nothing ran
   * - while the item itself stays claimable so the queue re-offers it rather than losing it.
   * Cleared when a worker claims it, since that begins a new attempt.
   */
  abandonedAt?: string | null;
  /**
   * Caller-supplied annotations merged onto the item by the official
   * `POST /v1/environments/{id}/work/{workId}` update route. Present only on
   * items written or updated after migration 061; absent reads as `{}`.
   */
  metadata?: Record<string, string>;
  /**
   * The official-wire heartbeat lease anchor — the value an
   * `expected_last_heartbeat` precondition compares against. Distinct from
   * `claimedAt`: a poll claim anchors the claim lease, while the heartbeat
   * lease begins at the first beat that presents `NO_HEARTBEAT`. Reset to
   * `null` on every (re)claim so a new claim epoch starts unleased.
   */
  heartbeatAt?: string | null;
}

export type WorkCompletionResult = 'completed' | 'not_found' | 'not_claimed_by_worker';

/**
 * Outcome of renewing a claim. `renewed` rather than `completed`, because a
 * heartbeat and a completion are different events and a caller that conflates them
 * would stop a long item by accident.
 *
 * `work_lease_lost` is the engine-neutral code a worker acts on (item 11b's frozen
 * naming): the work itself is no longer wanted, because the session that queued it
 * has ended and stopped it. It is deliberately distinct from `not_claimed_by_worker`,
 * which says this caller does not hold the item while the work continues for whoever
 * does - a worker that conflated the two would abandon live work, and one that
 * ignored the difference would keep running work nobody is waiting for.
 */
export type WorkLeaseResult = 'renewed' | 'not_found' | 'not_claimed_by_worker' | 'work_lease_lost';

/**
 * Outcome of confirming a claim at the moment execution starts.
 *
 * `accepted` is the only value that authorizes running the item. The others are refusals,
 * and the important property is what they are **not**: none of them is a completion, so a
 * worker that receives one must not run the item and must not report a result for it. A
 * result would assert an effect that never happened, and the queue would record it as
 * though the tool had run.
 *
 * `work_lease_lost` covers both a stopped item and a lapsed lease, because the instruction
 * to the worker is identical - do not run it - while the message says which of the two it
 * was. This is deliberately stricter than `heartbeat`, which renews an item already in
 * flight: a lapsed claim is reclaimable at any instant, so an acceptance that tolerated a
 * lapsed lease would authorize a worker to start something the queue may hand to a second
 * worker in the same instant, which is the double execution this exists to prevent.
 */
export type WorkAcceptResult = 'accepted' | 'not_found' | 'not_claimed_by_worker' | 'work_lease_lost';

export type WorkHeartbeatScopedResult =
  | { outcome: 'renewed'; item: WorkItem; lastHeartbeat: string }
  | { outcome: 'not_found' }
  | { outcome: 'precondition_failed'; item: WorkItem }
  | { outcome: 'not_claimed_by_worker'; item: WorkItem }
  | { outcome: 'work_lease_lost'; item: WorkItem };

/**
 * Machine-readable reasons a bounded wait ends without a result (item 11b).
 *
 * `await` gives up on a deadline, and the failure it raised said only that time had
 * passed. Three situations that call for opposite responses were indistinguishable in
 * it, and the difference is safety rather than detail:
 *
 * - `work_queue_timeout` — the row is still `pending`, so no worker ever took it.
 *   Nothing has run and submitting the intent again is safe.
 * - `work_outcome_unknown` — an executor held it and the lease lapsed with no result.
 *   The effect may already have happened on the operator's machine, so a blind replay
 *   can duplicate a side effect. It is this queue's spelling of the `outcome_unknown`
 *   the SDK already refuses to replay for the same reason.
 * - `work_lease_lost` — the session ended and stopped the work, so no result is wanted
 *   at all. That is the fact a refused renewal reports, so it is the same code rather
 *   than a third one meaning the same thing.
 */
export const WORK_QUEUE_TIMEOUT_CODE = 'work_queue_timeout';
export const WORK_OUTCOME_UNKNOWN_CODE = 'work_outcome_unknown';

/**
 * The stop code, spelled here as well as at the worker endpoint because this second
 * emit site has to be visible to the error-code module attribution scan, which models
 * `_CODE = '<literal>'` and cannot see a literal passed as a positional argument. The
 * endpoint keeps its own literal for the same reason: replacing it with this constant
 * would hide a real emit site from that scan rather than remove it.
 */
export const WORK_LEASE_LOST_CODE = 'work_lease_lost';

/**
 * Raised by a bounded wait that gave up.
 *
 * It carries `code` for the same reason every other failure in this runtime does:
 * `session.error` preserves the code under `error.code` and derives the official
 * `type` and `retry_status` from it, so a caller
 * reads the reason and its disposition instead of parsing a message. A caller told only
 * that time passed has to guess, and both guesses are wrong — treating the timeout as
 * safe to replay duplicates a side effect, and treating it as unsafe abandons work that
 * never ran.
 */
export class WorkWaitTimeoutError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${message} (${code})`);
    this.name = 'WorkWaitTimeoutError';
    this.code = code;
  }
}

/**
 * How long a claim may stand without the claiming worker finishing the item.
 *
 * A worker that dies mid-item leaves its claim behind, and nothing else can read
 * `claimed_at`, so the item would stay claimed forever and the session waiting on
 * it would only ever end in a timeout. After this window the claim is assumed
 * abandoned and the item may be claimed again; the superseded worker's late
 * completion is then refused by the existing `claimed_by` fence. The window is a
 * constructor option so a deployment (and a test) can state it explicitly.
 */
export const DEFAULT_WORK_LEASE_MS = 60_000;

/**
 * Session statuses that have no outbound transition, read from the state machine rather
 * than repeated here. A second list would silently fall behind the first, and this is the
 * predicate that decides whether a session's work can still be claimed, so a status added
 * as terminal has to reach it without anyone remembering to edit this file.
 */
const TERMINAL_SESSION_STATUSES: string[] = Object.entries(SESSION_TRANSITIONS)
  .filter(([, next]) => next.length === 0)
  .map(([status]) => status);

/**
 * The same statuses as a SQL list, for the predicates that have to read them per row.
 *
 * Derived from the constant above rather than typed out again, and safe to interpolate
 * because the values are keys of `SESSION_TRANSITIONS` - literals in this repository -
 * never caller input.
 */
const TERMINAL_SESSION_STATUS_SQL = TERMINAL_SESSION_STATUSES.map((status) => `'${status}'`).join(', ');

/**
 * Queue primitives shared by the provider (enqueue/await) and the HTTP worker
 * endpoints (claim/complete).
 */
export class WorkQueue {
  private readonly leaseMs: number;

  /**
   * Workers seen by the official `work/poll` route, in-memory only. A restart
   * forgets them, which matches the metric's own definition - it counts
   * workers that polled within a 30-second window, so stale entries expire on
   * their own without a persisted row.
   */
  private readonly pollSeen = new Map<string, number>();

  constructor(private readonly db: Database, options: { leaseMs?: number } = {}) {
    this.leaseMs = typeof options.leaseMs === 'number' && Number.isFinite(options.leaseMs) && options.leaseMs > 0
      ? Math.floor(options.leaseMs)
      : DEFAULT_WORK_LEASE_MS;
  }

  /** The configured claim lease in seconds — what a heartbeat reports as `ttl_seconds`. */
  get leaseSeconds(): number {
    return this.leaseMs / 1000;
  }

  /**
   * Queue an item for a session.
   *
   * The stop is a decision about the session, not only about the rows that happened to
   * exist when it was taken. `stop()` marks the work already queued; this insert carries
   * the same decision forward, so an item that arrives afterwards - a tool call from a
   * turn that was still in flight, or one enqueued by the second process this protocol
   * exists to tolerate - is recorded as stopped and can never be claimed. Without that, a
   * worker executes it for a session that is already over.
   *
   * The status is read inside the same statement as the insert. Reading it first and then
   * inserting would leave a window in which the session ends between the two, and the row
   * written in that window is exactly the one this is about.
   *
   * A session id with no row is left claimable. An unknown id is a caller's mistake rather
   * than a stop, so treating it as ended would refuse work that is still wanted.
   */
  enqueue(sessionId: string, kind: WorkItemKind, payload: Record<string, unknown>): string {
    const id = `work_${nanoid(16)}`;
    const terminalPlaceholders = TERMINAL_SESSION_STATUSES.map(() => '?').join(', ');
    // `status` is named explicitly even though the column carries a default. The default is
    // `'pending'` from migration 003, which is immutable, and that word is no longer part of
    // the vocabulary - so relying on it would write a value that migration 048 has already
    // finished mapping and that nothing else in this file reads.
    this.db
      .prepare(
        `INSERT INTO work_items (id, session_id, kind, payload, status, stopped_at)
         SELECT ?, ?, ?, ?, 'queued', CASE WHEN (SELECT status FROM sessions WHERE id = ?) IN (${terminalPlaceholders})
           THEN datetime('now') ELSE NULL END`,
      )
      .run(id, sessionId, kind, JSON.stringify(payload), sessionId, ...TERMINAL_SESSION_STATUSES);
    return id;
  }

  /**
   * Claim the oldest claimable item (optionally scoped to a session): a pending
   * item, or one whose previous claim has outlived the lease window. Uses a
   * single atomic conditional UPDATE carrying the same predicate as the
   * selection, so two concurrent workers can never claim the same item (H2) and
   * a claim that has expired is reclaimed by exactly one of them. Only the
   * worker whose UPDATE actually flips the row wins.
   *
   * Work whose session has ended is excluded here rather than filtered out of a
   * result: a stopped item must not be selectable, because selecting it and then
   * refusing it would leave the transaction holding a row it cannot hand over.
   *
   * "Ended" is read from the session's own status, not only from the marker on the
   * row. `stop()` writes that marker, but it is reached through the sandbox release,
   * and a terminal session is allowed to skip the release - `cleanup_pending` does, to
   * retain the workspace until child-tree cleanup can be proven - while a session that
   * simply finishes its turn never releases one at all. Reading the status here makes
   * the exclusion independent of which path ended the session, and covers rows that
   * are already sitting unmarked in an existing database.
   */
  claim(workerId: string, sessionId?: string, environmentId?: string, reclaimOlderThanMs?: number): WorkItem | null {
    // SQLite has no `milliseconds` modifier - `datetime('now', '-60000 milliseconds')`
    // is NULL and every comparison against it is NULL, which reads as "nothing is ever
    // reclaimable". Seconds, with a fractional part, is the modifier that exists.
    const leaseModifier = `-${this.leaseMs / 1000} seconds`;
    // The official poll carries `reclaim_older_than_ms` — how old a
    // claimed-but-never-acknowledged item must be before a poller may take it
    // back. It narrows or widens only the stale-claim arm of the predicate:
    // the accepted-lapse sweep keeps the queue's own lease, because a worker
    // that committed to running the item answers to the TTL it was given, not
    // to a later caller's reclaim hint.
    const reclaimModifier = typeof reclaimOlderThanMs === 'number' && Number.isFinite(reclaimOlderThanMs) && reclaimOlderThanMs > 0
      ? `-${Math.floor(reclaimOlderThanMs) / 1000} seconds`
      : leaseModifier;
    // The row's own condition: unstopped, `queued`, and either never held or held under a
    // lease that has run out.
    //
    // **`status = 'queued'` is where the acceptance fence now lives, and that is what the
    // vocabulary change bought.** It used to be a second test on this arm - `accepted_at IS
    // NULL` - because `claimed` covered both sides of the line. An `accepted` row is a
    // different status now, so "may this be handed to another worker?" is answered by the same
    // column a reader uses to ask it, rather than by a predicate that has to remember to
    // consult a second one.
    //
    // **Measured, not assumed: this clause is not independently testable either.** A probe that
    // widens it to `status IN ('queued', 'accepted')` changes no test outcome (0), because the
    // sweep below has already moved every lapsed accepted row to `unknown`, and an accepted row
    // inside its lease fails the lease comparison anyway. The clause is kept for the same reason
    // its predecessor was: the statements do not share a clock, and SQLite fixes `now` per
    // statement, so a row whose lease lapses between the sweep and the select would be invisible
    // to the former and, without this clause, admissible to the latter. The vocabulary change
    // moved **where** the fence is written; it did not make it redundant, and it did not make it
    // reachable by a deterministic test.
    //
    // `abandoned_at` is deliberately **not** here, and must never be. The frozen 11b spec
    // requires an unaccepted intent to stay reclaimable after its lease expires (line 72) and
    // an executor killed before ack to leave the work in the queue (line 61 acceptance); a
    // marker in this predicate would delete that work instead of re-offering it, and a bounded
    // wait that gave up is the common path into this state rather than a rare one.
    //
    // The lease test needs `claimed_at IS NULL` as an alternative rather than as a guard: a row
    // nobody has ever claimed has a NULL timestamp, every comparison against it is NULL, and
    // `NULL OR ...` would still be falsy - so the `IS NULL` arm is what makes untouched work
    // claimable at all.
    const rowClaimable = (prefix: string): string =>
      `(${prefix}stopped_at IS NULL AND ${prefix}status = 'queued' AND (${prefix}claimed_at IS NULL OR ${prefix}claimed_at <= datetime('now', ?)))`;
    // The session's condition, as a correlated subquery so one fragment serves the
    // scoped and unscoped selections and the guarded update alike. `IS NULL` keeps work
    // for an unknown session id claimable: an id with no row is a caller's mistake
    // rather than an ended session.
    const sessionLive = (prefix: string): string =>
      `((SELECT ss.status FROM sessions ss WHERE ss.id = ${prefix}session_id) IS NULL
        OR (SELECT ss.status FROM sessions ss WHERE ss.id = ${prefix}session_id) NOT IN (${TERMINAL_SESSION_STATUS_SQL}))`;
    const claimable = (prefix: string): string => `(${rowClaimable(prefix)} AND ${sessionLive(prefix)})`;
    return this.db.transaction(() => {
      // Before selecting anything, record the items whose accepted claim has lapsed. The
      // predicate above excludes them because they are `accepted` rather than `queued`, but
      // exclusion alone would leave them sitting in `accepted` - a status that says a worker
      // committed to running them and may still be doing so - and the whole point of line 72
      // is that this outcome must be **visible as unknown** rather than silently either
      // replayed or hidden.
      //
      // The sweep is deliberate about what it does not touch. `stopped_at IS NULL` keeps the
      // session's stop as the item's stated cause, because a stop is a decision and this is
      // an absence of information. `status = 'accepted'` keeps it to the post-ack case: a
      // `queued` row whose lease lapsed is work that never started, and it keeps its
      // reclaimability, which is the property the previous change restored.
      //
      // It is intentionally not scoped to this caller's session or environment. Whether an
      // item was started and never reported is a fact about the item, not about who happened
      // to ask next, so leaving another environment's rows unrecorded until someone claims
      // there would make the queue's own state depend on polling order.
      //
      // A live holder is unaffected: renewal moves `claimed_at` forward, so a worker that is
      // still running and still heartbeating is never inside this window. A worker whose lease
      // genuinely lapsed is told the same thing it would have been told by a reclaim - the
      // claim is gone - and the difference is that its item is no longer handed to anyone else.
      this.db
        .prepare(
          `UPDATE work_items SET status = 'unknown'
           WHERE status = 'accepted' AND stopped_at IS NULL
             AND claimed_at IS NOT NULL AND claimed_at <= datetime('now', ?)`,
        )
        .run(leaseModifier);
      let candidate: { id: string } | undefined;
      if (sessionId) {
        candidate = this.db.prepare(
          environmentId
            ? `SELECT wi.id
               FROM work_items wi
               JOIN sessions s ON s.id = wi.session_id
               WHERE ${claimable('wi.')} AND wi.session_id = ? AND s.environment_id = ?
               ORDER BY wi.created_at ASC, wi.rowid ASC
               LIMIT 1`
            : `SELECT id FROM work_items WHERE ${claimable('')} AND session_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1`,
        ).get(...(environmentId ? [reclaimModifier, sessionId, environmentId] : [reclaimModifier, sessionId])) as { id: string } | undefined;
      } else if (environmentId) {
        candidate = this.db.prepare(
          `SELECT wi.id
           FROM work_items wi
           JOIN sessions s ON s.id = wi.session_id
           WHERE ${claimable('wi.')} AND s.environment_id = ?
           ORDER BY wi.created_at ASC, wi.rowid ASC
           LIMIT 1`,
        ).get(reclaimModifier, environmentId) as { id: string } | undefined;
      } else {
        candidate = this.db.prepare(
          `SELECT id FROM work_items WHERE ${claimable('')} ORDER BY created_at ASC, rowid ASC LIMIT 1`,
        ).get(reclaimModifier) as { id: string } | undefined;
      }
      if (!candidate) return null;

      // Guarded update: the row must still be `queued` under a lease that has run out, or
      // never held at all. A claim that was renewed, accepted or completed in between fails
      // the predicate and this worker loses the race.
      //
      // `status` is deliberately **not** written here. Taking a lease is not a change of
      // commitment, so the row stays `queued` until a worker accepts it - which is exactly the
      // distinction the old `claimed` erased and the reason the vocabulary was renamed.
      // `claimed_by` and `claimed_at` record the lease; `accepted_at` is cleared because
      // acceptance is a statement about a particular holder's attempt, and a reclaim is a new
      // attempt. `abandoned_at` is cleared for the same reason: both are statements about a
      // previous holder, and neither may read as though *this* attempt had already ended.
      const res = this.db
        .prepare(`UPDATE work_items SET claimed_by = ?, claimed_at = datetime('now'), accepted_at = NULL, abandoned_at = NULL, heartbeat_at = NULL WHERE id = ? AND ${claimable('')}`)
        .run(workerId, candidate.id, reclaimModifier) as { changes: number };
      if (res.changes !== 1) return null; // lost the race — someone else claimed it

      const r = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(candidate.id) as unknown as RawWorkItem;
      return toWorkItem(r);
    });
  }

  /**
   * Record a result for an item this worker holds, or refuse and say why.
   *
   * Guarded on the row still being `queued` or `accepted` **by this worker**, so a completion
   * cannot land on work that has moved on. Both are admitted on purpose: a holder may report
   * without having accepted, and that was true under the old vocabulary too.
   *
   * `unknown` is refused rather than admitted, and that is the behaviour the frozen spec asks
   * for rather than a side effect: line 58 requires a late completion to be answered with a
   * lost lease, because the queue has already recorded that it does not know the outcome, and
   * a result arriving later cannot un-tell the queue that the effect was uncertain when it was
   * handed on.
   */
  complete(id: string, workerId: string, result: unknown, failed = false): WorkCompletionResult {
    const update = this.db
      .prepare("UPDATE work_items SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ? AND status IN ('queued', 'accepted') AND claimed_by = ?")
      .run(failed ? 'failed' : 'applied', JSON.stringify(result), id, workerId) as { changes: number };
    if (update.changes === 1) return 'completed';
    return this.get(id) ? 'not_claimed_by_worker' : 'not_found';
  }

  /**
   * Renew a claim this worker holds, restarting its lease window.
   *
   * Without this, the lease window has to exceed the longest item a worker will ever
   * run, or a slow item gets reclaimed while it is still executing and its work is
   * handed to a second worker. A worker running a long item renews instead, and the
   * claim stays its own for as long as it keeps renewing.
   *
   * The renewal is guarded by `claimed_by`, like completion: a worker that does not
   * hold the item cannot move the timestamp, so it cannot keep someone else's claim
   * alive, and it cannot take an item by touching it. A lease that has already been
   * reclaimed by another worker is therefore not renewable by the superseded one —
   * that renewal reports `not_claimed_by_worker`, and the item belongs to the new
   * holder.
   *
   * Stopped work is the one refusal that is about the work rather than about the
   * caller: `work_lease_lost`. A session that has ended stops the work it queued,
   * claimed or not, and that marker is the evidence a running worker needs - without
   * an answer it can act on, a worker told nothing keeps executing a command the
   * session no longer wants, and no local abort controller can substitute for it
   * because the stop may have been issued by a different process entirely.
   */
  heartbeat(id: string, workerId: string): WorkLeaseResult {
    // The renewal is one conditional UPDATE, so the stop predicate is a fence rather
    // than a check the write can slip past: a stop that lands while this statement is
    // in flight simply leaves the row un-renewed instead of being overwritten by it.
    const update = this.db
      .prepare("UPDATE work_items SET claimed_at = datetime('now') WHERE id = ? AND status IN ('queued', 'accepted') AND claimed_by = ? AND stopped_at IS NULL")
      .run(id, workerId) as { changes: number };
    if (update.changes === 1) return 'renewed';
    // The failed write is classified afterwards, and the work-level fact comes first:
    // whether the caller ever held the item, a stopped item's lease is gone.
    const row = this.get(id);
    if (!row) return 'not_found';
    if (row.stoppedAt) return 'work_lease_lost';
    return 'not_claimed_by_worker';
  }

  /**
   * Record that a bounded wait gave up on an item no executor had accepted.
   *
   * **Observability, not a fence.** It marks the row so a later reader can tell an attempt
   * that was abandoned before starting from one that died while running, which is real
   * information: nothing was accepted, so nothing ran. It deliberately does not feed the
   * claim predicate, the accept fence, or the heartbeat fence. An earlier version of this
   * method did, and that was wrong against the frozen 11b spec on two lines - an unaccepted
   * intent must stay reclaimable after its lease expires, and an executor killed before ack
   * must leave the work in the queue. Making the row unclaimable deletes the work the spec
   * requires to be re-offered, and a bounded wait is the *common* path into that state
   * rather than a rare one.
   *
   * Guarded on `accepted_at IS NULL` for the same reason it always was: the holder may
   * accept between the wait reading the row and writing it, and work that is about to run
   * must not be recorded as abandoned-before-starting. The return value says which happened,
   * though the caller no longer varies the code on it - the reason is conservative either
   * way.
   */
  private recordGiveUp(id: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE work_items SET abandoned_at = datetime('now')
         WHERE id = ? AND status = 'queued' AND stopped_at IS NULL
           AND abandoned_at IS NULL AND accepted_at IS NULL`,
      )
      .run(id) as { changes: number };
    return res.changes === 1;
  }

  /**
   * Confirm, at the moment execution starts, that this worker may still run the item.
   *
   * A claim alone does not authorize execution, and the gap between the two is not
   * theoretical. `claim()` hands out an item with a lease window and the row becomes
   * claimable again the instant that window passes; between claiming and starting, a
   * worker returns from the claim, resolves its workdir, and - on the path this protocol
   * exists to tolerate - may be a second process that was paused, descheduled, or still
   * starting. None of that is bounded. If the window passes in that gap the item is
   * claimed by a second worker, and **both run it**: the side effect happens twice on the
   * operator's machine. A heartbeat does not save the first one, because a renewal from a
   * superseded holder is refused as `not_claimed_by_worker`, which the CLI deliberately
   * treats as a suspicion and keeps running - right for an item already in flight, whose
   * effect cannot be un-run, and useless as a guard against starting one.
   *
   * This is where "somebody took it" becomes "somebody has committed to running it". The
   * three conditions are one conditional UPDATE, so each is a fence rather than a check a
   * write can slip past: the row must still be claimed **by this worker**, unstopped, and
   * inside its lease window. The lease condition is what makes this stricter than
   * `heartbeat`, and the asymmetry is the decision rather than an oversight - see
   * `WorkAcceptResult`.
   *
   * Re-accepting is idempotent for the holder: `accepted_at` is restamped, not inspected,
   * so a worker retrying over a flaky link is not punished for the retry. **`accepted` is in
   * the predicate for that reason and not by oversight** - it is the status the first call
   * leaves behind, so admitting only `queued` would make the second call of a retry report a
   * lost lease on work the caller still holds and is about to run. The fence that matters is
   * unchanged either way: the lease window still has to be open. A refusal is never a
   * completion - the caller must not run the item and must not report a result.
   */
  accept(id: string, workerId: string): WorkAcceptResult {
    const leaseModifier = `-${this.leaseMs / 1000} seconds`;
    const update = this.db
      .prepare(
        `UPDATE work_items SET accepted_at = datetime('now'), status = 'accepted'
         WHERE id = ? AND status IN ('queued', 'accepted') AND claimed_by = ? AND stopped_at IS NULL
           AND claimed_at IS NOT NULL AND claimed_at > datetime('now', ?)`,
      )
      .run(id, workerId, leaseModifier) as { changes: number };
    if (update.changes === 1) return 'accepted';
    // Classified afterwards, and the work-level fact comes before the caller-level one,
    // for the same reason `heartbeat` orders them this way: whether the caller ever held
    // the item, a stopped item's lease is gone and the answer for the worker is the same
    // instruction either way - do not run it.
    const row = this.get(id);
    if (!row) return 'not_found';
    if (row.stoppedAt) return 'work_lease_lost';
    if (row.claimedBy === workerId && (row.status === 'queued' || row.status === 'accepted')) {
      // The holder, with a lease that has run out. The message distinguishes this from a
      // stop; the code does not, because the instruction to the worker is identical.
      return 'work_lease_lost';
    }
    return 'not_claimed_by_worker';
  }

  get(id: string): WorkItem | null {
    const r = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as RawWorkItem | undefined;
    return r ? toWorkItem(r) : null;
  }

  /**
   * The environment a work item belongs to, joined through its session.
   *
   * `null` means the item cannot be attributed — its session is gone or
   * carries no environment — and a route must refuse rather than guess: an
   * environment-scoped credential checked against an unattributable item
   * would silently compare against nothing.
   */
  environmentOf(id: string): string | null {
    const row = this.db
      .prepare(
        `SELECT s.environment_id AS environment_id
         FROM work_items wi JOIN sessions s ON s.id = wi.session_id
         WHERE wi.id = ?`,
      )
      .get(id) as { environment_id: string | null } | undefined;
    return row ? row.environment_id : null;
  }

  /**
   * The official-wire acknowledgement: a claimed item's holder confirms, at
   * the moment of starting, that the claim is still live.
   *
   * Same fence as {@link accept} — claimed, inside its lease, unstopped — but
   * the worker identity is the `Anthropic-Worker-ID` header rather than a
   * body field, and it is optional: the environment key is the authority on
   * this wire, so a caller that omits the header accepts on behalf of
   * whichever worker holds the claim. A header that names a different holder
   * is still refused, because a named-but-wrong worker is a claim conflict,
   * not an authority the credential grants.
   */
  acceptScoped(id: string, workerId?: string): WorkAcceptResult {
    const leaseModifier = `-${this.leaseMs / 1000} seconds`;
    const update = this.db
      .prepare(
        `UPDATE work_items SET accepted_at = datetime('now'), status = 'accepted'
         WHERE id = ? AND status IN ('queued', 'accepted') AND stopped_at IS NULL
           AND claimed_at IS NOT NULL AND claimed_at > datetime('now', ?)
           AND (? IS NULL OR claimed_by = ?)`,
      )
      .run(id, leaseModifier, workerId ?? null, workerId ?? null) as { changes: number };
    if (update.changes === 1) return 'accepted';
    const row = this.get(id);
    if (!row) return 'not_found';
    if (row.stoppedAt) return 'work_lease_lost';
    if (workerId && row.claimedBy && row.claimedBy !== workerId) return 'not_claimed_by_worker';
    // An unclaimed row, a lapsed lease, and a holder without a header all fail
    // the same way: the work is no longer this call's to start.
    return 'work_lease_lost';
  }

  /**
   * The official-wire heartbeat: renew the lease, honoring the published
   * optimistic-concurrency parameter.
   *
   * `expectedLastHeartbeat` compares against the recorded heartbeat anchor in
   * the same statement as the renewal, so a concurrent renewal cannot slip
   * between a check and a write — the UPDATE's predicate is the fence, and a
   * heartbeat that observes a moved timestamp changes nothing and reports
   * `precondition_failed`. The anchor is `heartbeat_at`, not `claimed_at`: on
   * the published surface the first beat carries `NO_HEARTBEAT` to claim the
   * heartbeat lease, which is created by that beat rather than by the poll —
   * if `claimed_at` were the anchor, the sentinel could never match.
   *
   * The renewal writes `claimed_at` alongside `heartbeat_at` because the
   * claim lease is what the reclaim predicate and the accept fence read: a
   * heartbeat is a life sign, and a heartbeating item must not look stale to
   * either. The holder check stays on the `Anthropic-Worker-ID` header when
   * present — a caller that names a different worker is refused even though
   * the credential itself is the authority, because a named-but-wrong worker
   * is a claim conflict rather than an impersonation the credential grants.
   *
   * `desired_ttl_seconds` is accepted but not honored per item: the lease is
   * a queue-level constant and the response reports the effective value —
   * the honest answer rather than a TTL the sweep does not apply.
   */
  heartbeatScoped(
    id: string,
    opts: { workerId?: string; expectedLastHeartbeat?: string | null } = {},
  ): WorkHeartbeatScopedResult {
    const update = this.db
      .prepare(
        `UPDATE work_items
         SET claimed_at = datetime('now'),
             heartbeat_at = datetime('now'),
             claimed_by = CASE WHEN claimed_by IS NULL AND ? IS NOT NULL THEN ? ELSE claimed_by END
         WHERE id = ? AND status IN ('queued', 'accepted') AND stopped_at IS NULL
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
        opts.workerId ?? null,
        opts.workerId ?? null,
        id,
        opts.workerId ?? null,
        opts.workerId ?? null,
        opts.expectedLastHeartbeat ?? null,
        opts.expectedLastHeartbeat ?? null,
        opts.expectedLastHeartbeat ?? null,
        opts.expectedLastHeartbeat ?? null,
      ) as { changes: number };
    if (update.changes === 1) {
      const row = this.get(id)!;
      return { outcome: 'renewed', item: row, lastHeartbeat: row.heartbeatAt! };
    }
    const row = this.get(id);
    if (!row) return { outcome: 'not_found' };
    if (opts.expectedLastHeartbeat !== undefined && opts.expectedLastHeartbeat !== null) {
      const expected = opts.expectedLastHeartbeat;
      const matched = expected === 'NO_HEARTBEAT'
        ? row.heartbeatAt === null || row.heartbeatAt === undefined
        : row.heartbeatAt != null && `${row.heartbeatAt.replace(' ', 'T')}Z` === expected;
      if (!matched) return { outcome: 'precondition_failed', item: row };
    }
    if (row.stoppedAt) return { outcome: 'work_lease_lost', item: row };
    return { outcome: 'not_claimed_by_worker', item: row };
  }

  /**
   * Record a stop decision for one item — the route-level half of the
   * official `work/:id/stop`.
   *
   * The marker is the same one {@link stop} writes per session: the item can
   * never be claimed again, and the holder learns from its next refused
   * renewal. There is no local graceful/forced distinction — `force` on the
   * wire selects between "the worker confirms the shutdown" and "mark it at
   * once", and this queue's marker is already the at-once form: the worker's
   * heartbeat loop is the shutdown signal, and a result that lands anyway is
   * still recorded, because the marker says the runtime stopped *wanting*
   * the work, not that the effect did not happen.
   */
  stopItem(id: string): 'stopped' | 'not_found' {
    const res = this.db
      .prepare(
        `UPDATE work_items SET stopped_at = datetime('now')
         WHERE id = ? AND stopped_at IS NULL AND status IN ('queued', 'accepted')`,
      )
      .run(id) as { changes: number };
    if (res.changes === 1) return 'stopped';
    return this.get(id) ? 'stopped' : 'not_found';
  }

  /**
   * Merge a metadata patch onto an item — the published update semantics:
   * a `null` value deletes the key, a string upserts it, omitted keys are
   * preserved. Returns the updated item, or `null` when it does not exist.
   */
  updateMetadata(id: string, patch: Record<string, string | null>): WorkItem | null {
    const existing = this.get(id);
    if (!existing) return null;
    const merged = { ...(existing.metadata ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else merged[key] = String(value);
    }
    this.db.prepare('UPDATE work_items SET metadata = ? WHERE id = ?').run(JSON.stringify(merged), id);
    return this.get(id);
  }

  /**
   * Record a worker identity seen on the official poll route. The
   * `workers_polling` stat counts identities seen inside its window; entries
   * age out lazily — a worker that stopped polling stops counting, which is
   * the entire contract of the field.
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

  /**
   * Stop the work a session queued, returning how many items were marked. Called when
   * the session's sandbox is released, which happens on any terminal state - a user
   * stop included.
   *
   * An unfinished item carries a tool call the session asked for and no longer wants.
   * Without a persisted marker it stays claimable forever, so a worker would execute
   * it on the operator's own machine after the conversation had ended, and nothing
   * would be waiting for the result.
   *
   * **Claimed items are marked too, and that is the difference between the marker
   * working and only appearing to.** A claim is not ownership of the work, it is a
   * lease on running it: the moment that lease expires the item is a candidate again,
   * and a worker that was never told the session ended would pick it up and execute
   * it. Marking only `pending` items leaves exactly that door open - the item a
   * worker claimed and then died on is the one most likely to be reclaimed later.
   *
   * Marking does **not** deny the holder its result. An item already claimed may be
   * executing right now and no marker can un-run it, so the worker holding it can
   * still report, and what it reports is recorded: the marker says the runtime no
   * longer wants the work, not that the effect did not happen. Releasing the same
   * session twice marks nothing the second time.
   */
  stop(sessionId: string): number {
    const res = this.db
      .prepare("UPDATE work_items SET stopped_at = datetime('now') WHERE session_id = ? AND status IN ('queued', 'accepted') AND stopped_at IS NULL")
      .run(sessionId) as { changes: number };
    return res.changes;
  }

  list(opts: { environmentId?: string; limit?: number } = {}): WorkItem[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const rows = opts.environmentId
      ? this.db.prepare(
        `SELECT wi.*
         FROM work_items wi
         JOIN sessions s ON s.id = wi.session_id
         WHERE s.environment_id = ?
         ORDER BY wi.created_at DESC, wi.rowid DESC
         LIMIT ?`,
      ).all(opts.environmentId, limit)
      : this.db.prepare(
        `SELECT *
         FROM work_items
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      ).all(limit);
    return (rows as unknown as RawWorkItem[]).map(toWorkItem);
  }

  stats(opts: { environmentId?: string } = {}): Record<string, number> {
    const rows = opts.environmentId
      ? this.db.prepare(
        `SELECT wi.status, COUNT(*) AS count
         FROM work_items wi
         JOIN sessions s ON s.id = wi.session_id
         WHERE s.environment_id = ?
         GROUP BY wi.status`,
      ).all(opts.environmentId)
      : this.db.prepare('SELECT status, COUNT(*) AS count FROM work_items GROUP BY status').all();
    return Object.fromEntries((rows as Array<{ status: string; count: number }>).map((row) => [row.status, Number(row.count)]));
  }

  /**
   * Await a work item's completion by polling (server side of provision).
   *
   * The wait is bounded, and when the bound passes the reason is read from the row the
   * loop already fetched — after the completion check, so a result that arrives in time
   * still wins, including for work the session has stopped: the marker says the result
   * is not wanted, not that the effect did not happen. Classifying from the earlier read
   * rather than a fresh query also means the reason describes the same snapshot the loop
   * decided on.
   */
  async await(id: string, opts: { timeoutMs: number; pollMs?: number }): Promise<unknown> {
    const poll = opts.pollMs ?? 200;
    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      const item = this.get(id);
      if (item && (item.status === 'applied' || item.status === 'failed')) {
        if (item.status === 'failed') throw new Error(`work item ${id} failed: ${JSON.stringify(item.result)}`);
        return item.result;
      }
      if (Date.now() > deadline) throw this.waitFailure(id, item);
      await sleep(poll);
    }
  }

  /**
   * Why a bounded wait ended without a result, from what the row records.
   *
   * The order of these checks is the decision, not an accident of writing:
   *
   * 1. **stopped first**, because a stopped item that was never claimed is still `queued`,
   *    and reporting it as "no worker ever took it, submit again" would invite a caller to
   *    resubmit work for a session that has already ended. The stop is the cause; `queued`
   *    is only the state it was in when the cause landed.
   * 2. **`queued` and never claimed next** - `claimed_at IS NULL` - and this is the one case
   *    that is provably safe to replay: nothing has taken a lease on the row, so no executor
   *    has seen it. **The `claimed_at` test is not decoration, and under the old vocabulary it
   *    was not needed.** `pending` used to carry the whole meaning, because a row left it the
   *    instant it was handed out; `queued` now covers a row a worker is holding but has not
   *    accepted, so `status = 'queued'` alone would report **work that is about to run** as
   *    safe to submit again. That is precisely the hazard the previous change was written to
   *    close, so the lease check is what keeps the retryable reason honest.
   * 3. **everything else is the unknown outcome**, including a row that cannot be read at
   *    all, and including a held row that no executor ever accepted. Absence proves
   *    nothing about whether the work ran, and of the two ways to be wrong, replaying an
   *    effect that already happened is the expensive one.
   *
   * An accepted item whose lease lapsed is `unknown` rather than a held status, and it still
   * classifies the same way - by arm 3, which is where it already landed. That is the point:
   * the code the caller is given does not change, the **behaviour behind it** does. The item
   * is no longer handed to a second worker, so `work_outcome_unknown` stops being a warning
   * about a replay that was about to happen anyway and becomes a description of what the
   * queue actually did. `unknown` is also the terminal state a later recovery path reads: the
   * spec hands "accepted but the effect is unknown" to crash recovery rather than resolving it
   * here, because deciding whether an effect may be retried depends on the tool, which this
   * layer does not know.
   *
   * **A held row that was never accepted is now recorded, but not reclassified.** The
   * accept step makes it knowable that nothing ran - accepting is the last thing a worker
   * does before it starts - and it would be tempting to report the retryable reason on that
   * basis. It must not be: the row is reclaimable by design after its lease expires, which
   * the frozen 11b spec requires twice ("未 accepted 的意图在 lease 过期后保持可重取", and the
   * acceptance that an executor killed before ack leaves the work still in the queue), so a
   * caller told to resubmit would race the queue re-offering the very item it was told was
   * dead. The give-up is persisted as observability and the claim is left alone, so the
   * queue does what the spec says and executes the work instead of losing it.
   */
  private waitFailure(id: string, item: WorkItem | null): WorkWaitTimeoutError {
    if (item?.stoppedAt) {
      return new WorkWaitTimeoutError(
        WORK_LEASE_LOST_CODE,
        `work item ${id} timed out and was stopped: the session that queued it has ended`,
      );
    }
    if (item?.status === 'queued' && !item.claimedAt) {
      return new WorkWaitTimeoutError(
        WORK_QUEUE_TIMEOUT_CODE,
        `work item ${id} timed out without an executor: no worker ever claimed it`,
      );
    }
    // A held item that no executor accepted: record that the wait gave up on it, so a later
    // reader can tell this attempt from one that was actively running, and then report the
    // conservative reason. The record is not a fence - nothing refuses the item on it -
    // because an unaccepted intent has to stay reclaimable.
    if (item?.status === 'queued' && item.claimedAt) {
      this.recordGiveUp(id);
      return new WorkWaitTimeoutError(
        WORK_OUTCOME_UNKNOWN_CODE,
        `work item ${id} timed out after it was claimed but before any executor accepted it: no result is known, and the queue will re-offer it to a worker rather than treat it as dead - do not resubmit the intent`,
      );
    }
    return new WorkWaitTimeoutError(
      WORK_OUTCOME_UNKNOWN_CODE,
      `work item ${id} timed out after it was accepted: the outcome is unknown and must not be replayed`,
    );
  }
}

export class SelfHostedSandboxProvider implements SandboxProvider {
  readonly type = 'self_hosted';

  readonly capabilities = sandboxCapabilities({
    // Execution happens on infrastructure the user runs; the runtime host is
    // not the execution host. Whatever isolation the worker applies is outside
    // this process's knowledge, so from the runtime's perspective the work is
    // off-host rather than kernel-confined here.
    isolatedExecution: true,
    // Files live wherever the worker put them; the queue protocol exposes no
    // host path back to the runtime.
    hostFilesystem: false,
    // The work-item protocol carries no resource-limit fields today.
    resourceLimits: false,
    // The worker runs on operator infrastructure; whether it can bound egress
    // is outside this process's knowledge, so a `limited` policy reports the
    // gap rather than claiming the declared limit holds.
    networkPolicyEnforcement: 'none',
  });

  constructor(private readonly queue: WorkQueue) {}

  async provision(sessionId: string, config: EnvironmentConfig): Promise<SandboxInstance> {
    return new SelfHostedSandboxInstance(sessionId, this.queue, (config.timeout ?? 300) * 1000);
  }
}

class SelfHostedSandboxInstance implements SandboxInstance {
  constructor(
    readonly sessionId: string,
    private readonly queue: WorkQueue,
    private readonly timeoutMs: number,
  ) {}

  async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
    const id = this.queue.enqueue(this.sessionId, 'exec', { command, cwd: options?.cwd, env: options?.env });
    const result = (await this.queue.await(id, { timeoutMs: options?.timeout ?? this.timeoutMs })) as ExecResult;
    return result;
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    const id = this.queue.enqueue(this.sessionId, 'write', { path, content: content.toString() });
    await this.queue.await(id, { timeoutMs: this.timeoutMs });
  }

  async readFile(path: string): Promise<string> {
    const id = this.queue.enqueue(this.sessionId, 'read', { path });
    return (await this.queue.await(id, { timeoutMs: this.timeoutMs })) as string;
  }

  async listFiles(path: string): Promise<string[]> {
    const id = this.queue.enqueue(this.sessionId, 'list', { path });
    return (await this.queue.await(id, { timeoutMs: this.timeoutMs })) as string[];
  }

  async cleanup(): Promise<void> {
    // Nothing to tear down server-side; the Worker owns the actual resources.
    //
    // What this session does own is the work it queued. Releasing the sandbox means
    // the session is over, so anything unfinished must not be handed out afterwards:
    // the tool call it carries belongs to a conversation that has ended, and executing
    // it on the operator's machine would be work nobody asked for any more. That
    // includes work a worker claimed and abandoned - the claim is a lease on running
    // it, and once the lease expires the item is a candidate again.
    this.queue.stop(this.sessionId);
  }
}

// ============================================================
// Helpers
// ============================================================

interface RawWorkItem {
  id: string;
  session_id: string;
  kind: string;
  payload: string;
  status: string;
  result: string | null;
  claimed_by: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  stopped_at: string | null;
  accepted_at: string | null;
  abandoned_at: string | null;
  metadata: string | null;
  heartbeat_at: string | null;
}

function toWorkItem(r: RawWorkItem): WorkItem {
  return {
    id: r.id,
    sessionId: r.session_id,
    kind: r.kind as WorkItemKind,
    payload: JSON.parse(r.payload),
    status: r.status as WorkItem['status'],
    result: r.result ? JSON.parse(r.result) : undefined,
    claimedBy: r.claimed_by ?? null,
    createdAt: r.created_at,
    claimedAt: r.claimed_at ?? null,
    completedAt: r.completed_at ?? null,
    stoppedAt: r.stopped_at ?? null,
    acceptedAt: r.accepted_at ?? null,
    abandonedAt: r.abandoned_at ?? null,
    metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, string>) : {},
    heartbeatAt: r.heartbeat_at ?? null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
