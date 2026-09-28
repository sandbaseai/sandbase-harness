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
  status: 'pending' | 'claimed' | 'done' | 'failed';
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
 * `session.error.type` and its `retry_status` are derived from the code, so a caller
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

  constructor(private readonly db: Database, options: { leaseMs?: number } = {}) {
    this.leaseMs = typeof options.leaseMs === 'number' && Number.isFinite(options.leaseMs) && options.leaseMs > 0
      ? Math.floor(options.leaseMs)
      : DEFAULT_WORK_LEASE_MS;
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
    this.db
      .prepare(
        `INSERT INTO work_items (id, session_id, kind, payload, stopped_at)
         SELECT ?, ?, ?, ?, CASE WHEN (SELECT status FROM sessions WHERE id = ?) IN (${terminalPlaceholders})
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
  claim(workerId: string, sessionId?: string, environmentId?: string): WorkItem | null {
    // SQLite has no `milliseconds` modifier - `datetime('now', '-60000 milliseconds')`
    // is NULL and every comparison against it is NULL, which reads as "nothing is ever
    // reclaimable". Seconds, with a fractional part, is the modifier that exists.
    const leaseModifier = `-${this.leaseMs / 1000} seconds`;
    // The row's own condition: unstopped, and either pending or a claim whose lease ran out.
    // `abandoned_at` is deliberately **not** here. The frozen 11b spec requires an
    // unaccepted intent to stay reclaimable after its lease expires (line 72), and requires
    // an executor killed before ack to leave the work in the queue (line 61 acceptance). A
    // marker in this predicate would delete that work instead of re-offering it, and a
    // bounded wait that gave up is exactly the common path that reaches this state.
    const rowClaimable = (prefix: string): string =>
      `(${prefix}stopped_at IS NULL AND (${prefix}status = 'pending' OR (${prefix}status = 'claimed' AND ${prefix}claimed_at IS NOT NULL AND ${prefix}claimed_at <= datetime('now', ?))))`;
    // The session's condition, as a correlated subquery so one fragment serves the
    // scoped and unscoped selections and the guarded update alike. `IS NULL` keeps work
    // for an unknown session id claimable: an id with no row is a caller's mistake
    // rather than an ended session.
    const sessionLive = (prefix: string): string =>
      `((SELECT ss.status FROM sessions ss WHERE ss.id = ${prefix}session_id) IS NULL
        OR (SELECT ss.status FROM sessions ss WHERE ss.id = ${prefix}session_id) NOT IN (${TERMINAL_SESSION_STATUS_SQL}))`;
    const claimable = (prefix: string): string => `(${rowClaimable(prefix)} AND ${sessionLive(prefix)})`;
    return this.db.transaction(() => {
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
        ).get(...(environmentId ? [leaseModifier, sessionId, environmentId] : [leaseModifier, sessionId])) as { id: string } | undefined;
      } else if (environmentId) {
        candidate = this.db.prepare(
          `SELECT wi.id
           FROM work_items wi
           JOIN sessions s ON s.id = wi.session_id
           WHERE ${claimable('wi.')} AND s.environment_id = ?
           ORDER BY wi.created_at ASC, wi.rowid ASC
           LIMIT 1`,
        ).get(leaseModifier, environmentId) as { id: string } | undefined;
      } else {
        candidate = this.db.prepare(
          `SELECT id FROM work_items WHERE ${claimable('')} ORDER BY created_at ASC, rowid ASC LIMIT 1`,
        ).get(leaseModifier) as { id: string } | undefined;
      }
      if (!candidate) return null;

      // Guarded update: the row must still be pending, or claimed by a worker whose
      // lease has run out. A claim that was renewed, or completed, in between fails
      // the predicate and this worker loses the race.
      // `accepted_at` is cleared in the same statement: acceptance is a statement about a
      // particular holder's lease, so a reclaim by a different worker must not inherit it.
      // A row that arrives here was either never claimed or had its lease run out, and in
      // both cases nothing has committed to running it under this claim yet.
      // `abandoned_at` is cleared too, and for the same reason as `accepted_at`: both are
      // statements about a previous holder's attempt, and a reclaim is a new attempt. It is
      // pure observability - nothing reads it as a fence - so the only requirement is that
      // it must not read as though *this* attempt had already been given up on.
      const res = this.db
        .prepare(`UPDATE work_items SET status = 'claimed', claimed_by = ?, claimed_at = datetime('now'), accepted_at = NULL, abandoned_at = NULL WHERE id = ? AND ${claimable('')}`)
        .run(workerId, candidate.id, leaseModifier) as { changes: number };
      if (res.changes !== 1) return null; // lost the race — someone else claimed it

      const r = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(candidate.id) as unknown as RawWorkItem;
      return toWorkItem(r);
    });
  }

  complete(id: string, workerId: string, result: unknown, failed = false): WorkCompletionResult {
    const update = this.db
      .prepare("UPDATE work_items SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ? AND status = 'claimed' AND claimed_by = ?")
      .run(failed ? 'failed' : 'done', JSON.stringify(result), id, workerId) as { changes: number };
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
      .prepare("UPDATE work_items SET claimed_at = datetime('now') WHERE id = ? AND status = 'claimed' AND claimed_by = ? AND stopped_at IS NULL")
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
         WHERE id = ? AND status = 'claimed' AND stopped_at IS NULL
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
   * so a worker retrying over a flaky link is not punished for the retry. A refusal is
   * never a completion - the caller must not run the item and must not report a result.
   */
  accept(id: string, workerId: string): WorkAcceptResult {
    const leaseModifier = `-${this.leaseMs / 1000} seconds`;
    const update = this.db
      .prepare(
        `UPDATE work_items SET accepted_at = datetime('now')
         WHERE id = ? AND status = 'claimed' AND claimed_by = ? AND stopped_at IS NULL
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
    if (row.status === 'claimed' && row.claimedBy === workerId) {
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
      .prepare("UPDATE work_items SET stopped_at = datetime('now') WHERE session_id = ? AND status IN ('pending', 'claimed') AND stopped_at IS NULL")
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
      if (item && (item.status === 'done' || item.status === 'failed')) {
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
   * 1. **stopped first**, because a stopped item that was never claimed is still
   *    `pending`, and reporting it as "no worker ever took it, submit again" would
   *    invite a caller to resubmit work for a session that has already ended. The stop
   *    is the cause; `pending` is only the state it was in when the cause landed.
   * 2. **`pending` next**, and this is the one case that is provably safe to replay:
   *    a row becomes `claimed` when it is handed out and nothing ever moves it back, so
   *    `pending` at the deadline means no executor has seen it.
   * 3. **everything else is the unknown outcome**, including a row that cannot be read at
   *    all, and including claimed work that no executor ever accepted. Absence proves
   *    nothing about whether the work ran, and of the two ways to be wrong, replaying an
   *    effect that already happened is the expensive one.
   *
   * **A claimed row that was never accepted is now recorded, but not reclassified.** The
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
    if (item?.status === 'pending') {
      return new WorkWaitTimeoutError(
        WORK_QUEUE_TIMEOUT_CODE,
        `work item ${id} timed out without an executor: no worker ever claimed it`,
      );
    }
    // A claimed item that no executor accepted: record that the wait gave up on it, so a
    // later reader can tell this attempt from one that was actively running, and then report
    // the conservative reason. The record is not a fence - nothing refuses the item on it -
    // because an unaccepted intent has to stay reclaimable.
    if (item?.status === 'claimed' && !item.acceptedAt) {
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
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
