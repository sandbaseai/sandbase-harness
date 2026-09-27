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
   */
  claim(workerId: string, sessionId?: string, environmentId?: string): WorkItem | null {
    // SQLite has no `milliseconds` modifier - `datetime('now', '-60000 milliseconds')`
    // is NULL and every comparison against it is NULL, which reads as "nothing is ever
    // reclaimable". Seconds, with a fractional part, is the modifier that exists.
    const leaseModifier = `-${this.leaseMs / 1000} seconds`;
    const claimable = (prefix: string): string =>
      `(${prefix}stopped_at IS NULL AND (${prefix}status = 'pending' OR (${prefix}status = 'claimed' AND ${prefix}claimed_at IS NOT NULL AND ${prefix}claimed_at <= datetime('now', ?))))`;
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
      const res = this.db
        .prepare(`UPDATE work_items SET status = 'claimed', claimed_by = ?, claimed_at = datetime('now') WHERE id = ? AND ${claimable('')}`)
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

  /** Await a work item's completion by polling (server side of provision). */
  async await(id: string, opts: { timeoutMs: number; pollMs?: number }): Promise<unknown> {
    const poll = opts.pollMs ?? 200;
    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      const item = this.get(id);
      if (item && (item.status === 'done' || item.status === 'failed')) {
        if (item.status === 'failed') throw new Error(`work item ${id} failed: ${JSON.stringify(item.result)}`);
        return item.result;
      }
      if (Date.now() > deadline) throw new Error(`work item ${id} timed out`);
      await sleep(poll);
    }
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
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
