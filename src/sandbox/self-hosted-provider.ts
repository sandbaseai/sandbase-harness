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
}

export type WorkCompletionResult = 'completed' | 'not_found' | 'not_claimed_by_worker';

/**
 * Outcome of renewing a claim. `renewed` rather than `completed`, because a
 * heartbeat and a completion are different events and a caller that conflates them
 * would stop a long item by accident.
 */
export type WorkLeaseResult = 'renewed' | 'not_found' | 'not_claimed_by_worker';

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

  enqueue(sessionId: string, kind: WorkItemKind, payload: Record<string, unknown>): string {
    const id = `work_${nanoid(16)}`;
    this.db
      .prepare('INSERT INTO work_items (id, session_id, kind, payload) VALUES (?, ?, ?, ?)')
      .run(id, sessionId, kind, JSON.stringify(payload));
    return id;
  }

  /**
   * Claim the oldest claimable item (optionally scoped to a session): a pending
   * item, or one whose previous claim has outlived the lease window. Uses a
   * single atomic conditional UPDATE carrying the same predicate as the
   * selection, so two concurrent workers can never claim the same item (H2) and
   * a claim that has expired is reclaimed by exactly one of them. Only the
   * worker whose UPDATE actually flips the row wins.
   */
  claim(workerId: string, sessionId?: string, environmentId?: string): WorkItem | null {
    // SQLite has no `milliseconds` modifier - `datetime('now', '-60000 milliseconds')`
    // is NULL and every comparison against it is NULL, which reads as "nothing is ever
    // reclaimable". Seconds, with a fractional part, is the modifier that exists.
    const leaseModifier = `-${this.leaseMs / 1000} seconds`;
    const claimable = (prefix: string): string =>
      `(${prefix}status = 'pending' OR (${prefix}status = 'claimed' AND ${prefix}claimed_at IS NOT NULL AND ${prefix}claimed_at <= datetime('now', ?)))`;
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
   */
  heartbeat(id: string, workerId: string): WorkLeaseResult {
    const update = this.db
      .prepare("UPDATE work_items SET claimed_at = datetime('now') WHERE id = ? AND status = 'claimed' AND claimed_by = ?")
      .run(id, workerId) as { changes: number };
    if (update.changes === 1) return 'renewed';
    return this.get(id) ? 'not_claimed_by_worker' : 'not_found';
  }

  get(id: string): WorkItem | null {
    const r = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as RawWorkItem | undefined;
    return r ? toWorkItem(r) : null;
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
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
