/**
 * Integration test: self_hosted sandbox work-queue (R9.14).
 *
 * Verifies the enqueue → claim → complete → await round-trip, provider
 * dispatch, and the worker HTTP endpoints.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { WorkQueue, SelfHostedSandboxProvider } from '@/sandbox/self-hosted-provider.js';
import { workerRoutes } from '@/api/routes/worker.js';

/**
 * Age a claim. `claimed_at` is written by SQLite at second precision, so a test
 * cannot reach the end of a lease window by shortening the window and waiting
 * without sleeping for whole seconds; moving the claim's own timestamp back is the
 * deterministic way to be past it.
 */
function backdateClaim(db: Database, id: string, minutes: number): void {
  db.prepare("UPDATE work_items SET claimed_at = datetime('now', ?) WHERE id = ?").run(`-${minutes} minutes`, id);
}

describe('WorkQueue', () => {
  let db: Database;
  let queue: WorkQueue;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-sh-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    queue = new WorkQueue(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enqueue → claim → complete → await round-trip', async () => {
    const id = queue.enqueue('sess_1', 'exec', { command: 'echo hi' });

    // A worker claims it
    const claimed = queue.claim('worker_1');
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(id);
    expect(claimed!.kind).toBe('exec');
    expect(claimed!.payload.command).toBe('echo hi');

    // Worker completes it
    queue.complete(id, 'worker_1', { exitCode: 0, stdout: 'hi', stderr: '', timedOut: false });

    // Server awaits the result
    const result = await queue.await(id, { timeoutMs: 1000, pollMs: 10 });
    expect((result as any).stdout).toBe('hi');
  });

  it('claim returns null when the queue is empty', () => {
    expect(queue.claim('w')).toBeNull();
  });

  it('claims oldest-first (FIFO)', () => {
    const a = queue.enqueue('s', 'read', { path: 'a' });
    const b = queue.enqueue('s', 'read', { path: 'b' });
    expect(queue.claim('w')!.id).toBe(a);
    expect(queue.claim('w')!.id).toBe(b);
  });

  it('never double-claims a single item across workers (H2)', () => {
    const id = queue.enqueue('s', 'exec', { command: 'x' });
    // Two workers race to claim the single pending item
    const first = queue.claim('worker_a');
    const second = queue.claim('worker_b');
    // Exactly one wins; the other sees an empty queue
    const claimedIds = [first, second].filter(Boolean).map((i) => i!.id);
    expect(claimedIds).toEqual([id]);
    expect([first, second].filter((x) => x === null)).toHaveLength(1);
  });

  it('can scope claims to a session', () => {
    queue.enqueue('s1', 'read', { path: 'x' });
    const forS2 = queue.enqueue('s2', 'read', { path: 'y' });
    const claimed = queue.claim('w', 's2');
    expect(claimed!.id).toBe(forS2);
  });

  it('await rejects on failed items', async () => {
    const id = queue.enqueue('s', 'exec', { command: 'bad' });
    queue.claim('w');
    queue.complete(id, 'w', 'boom', true);
    await expect(queue.await(id, { timeoutMs: 500, pollMs: 10 })).rejects.toThrow(/failed/);
  });

  it('await times out if never completed', async () => {
    const id = queue.enqueue('s', 'exec', { command: 'slow' });
    await expect(queue.await(id, { timeoutMs: 60, pollMs: 10 })).rejects.toThrow(/timed out/);
  });

  it('reclaims a claim whose lease window has passed, and refuses the late owner', () => {
    // A worker that dies mid-item leaves its claim behind. Nothing used to read
    // `claimed_at`, so that claim stood forever and the session waiting on the item
    // could only ever end in a timeout. The lease window is what turns "claimed" into
    // "claimed, but abandoned if nobody finishes it".
    const leased = new WorkQueue(db, { leaseMs: 30 * 60_000 });
    const id = leased.enqueue('s', 'exec', { command: 'x' });

    expect(leased.claim('w1')?.claimedBy).toBe('w1');
    // Inside the window the claim is still respected: this is what keeps the window
    // from becoming a licence to steal live work.
    expect(leased.claim('w2')).toBeNull();

    // Ten minutes into a thirty-minute window, still respected.
    backdateClaim(db, id, 10);
    expect(leased.claim('w2')).toBeNull();

    // Past the window the claim is abandoned and the item is handed to the next worker.
    backdateClaim(db, id, 60);
    const reclaimed = leased.claim('w2');
    expect(reclaimed?.id).toBe(id);
    expect(reclaimed?.claimedBy).toBe('w2');
    expect(reclaimed?.status).toBe('claimed');

    // And the superseded owner cannot land its result on the item it lost: the
    // claimed_by fence refuses it, so a worker that comes back to life cannot
    // overwrite the result of the worker that actually holds the item.
    expect(leased.complete(id, 'w1', { exitCode: 0, stdout: 'from the dead worker' })).toBe('not_claimed_by_worker');
    expect(leased.get(id)!.result).toBeUndefined();
    expect(leased.complete(id, 'w2', { exitCode: 0, stdout: 'from the live worker' })).toBe('completed');
    expect((leased.get(id)!.result as { stdout: string }).stdout).toBe('from the live worker');

    // The window is configurable, and an unconfigured queue must still reclaim: the
    // default has to be a real duration rather than "never".
    const defaulted = queue.enqueue('s', 'exec', { command: 'y' });
    expect(queue.claim('w1')?.id).toBe(defaulted);
    backdateClaim(db, defaulted, 24 * 60);
    expect(queue.claim('w2')?.claimedBy).toBe('w2');
  });

  it('stops a session\'s unfinished work, including what a worker claimed and abandoned', () => {
    // An item queued for a session nobody is waiting on any more is a tool call that
    // must not happen: it would run on the operator's own machine after the session
    // ended. The marker is the exclusion the claim predicate reads, so the refusal has
    // to hold at the row and not only in the caller that set it.
    const held = queue.enqueue('sess_stop', 'exec', { command: 'held' });
    expect(queue.claim('w1')?.id).toBe(held);
    const unclaimed = queue.enqueue('sess_stop', 'exec', { command: 'never' });
    const elsewhere = queue.enqueue('sess_live', 'exec', { command: 'still wanted' });
    // The worker holding `held` dies here. Its lease lapses, which is the moment the
    // item becomes a candidate for a second worker - the door a stop has to close.
    backdateClaim(db, held, 24 * 60);

    expect(queue.stop('sess_stop')).toBe(2);
    // Marked, and still `pending` / `claimed`: recording either as done or failed would
    // invent an outcome for work that simply stopped being wanted.
    expect(queue.get(unclaimed)!.status).toBe('pending');
    expect(queue.get(unclaimed)!.stoppedAt).toBeTruthy();
    expect(queue.get(held)!.status).toBe('claimed');
    expect(queue.get(held)!.stoppedAt).toBeTruthy();
    // Another session's queue is untouched.
    expect(queue.get(elsewhere)!.stoppedAt).toBeNull();
    expect(queue.stop('sess_stop')).toBe(0);

    // **The reclaim is the assertion that matters, and `held` is the item it is about.**
    // It is the oldest row and its claim has lapsed, so a predicate that only excluded
    // unclaimed work hands it to `w2` right here: the work of a session that had already
    // ended would run anyway, later, on a machine whose operator was told it stopped.
    expect(queue.claim('w2', 'sess_stop')).toBeNull();
    expect(queue.claim('w2')?.id).toBe(elsewhere);
    // The holder, though, still owns its report: it may be executing at this moment, and
    // what it reports actually happened. The marker says the work is not wanted, not that
    // the effect did not occur.
    expect(queue.complete(held, 'w1', { exitCode: 0, stdout: 'ran before the stop' })).toBe('completed');
    expect(queue.get(held)!.stoppedAt).toBeTruthy();
  });

  it('records an item enqueued for an already-ended session as stopped, and still queues work for a live one', () => {
    // The marker `stop()` writes covers the work that existed at that moment. Work that
    // arrives afterwards - a tool call from a turn that was still in flight, or one
    // enqueued by the second process this protocol exists to tolerate - used to be
    // inserted fresh and claimable, so a worker executed it for a session that was
    // already over. The decision belongs to the session, so the insert has to carry it.
    // The session rows here are real, because the predicate reads their status; this
    // database enforces its foreign keys, so the parents are created first.
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    const mkSession = (id: string, status: string): void => {
      db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id, status) VALUES (?, 'agent_x', 'x', 'env_a', ?)").run(id, status);
    };

    mkSession('sess_ended', 'completed');
    const late = queue.enqueue('sess_ended', 'exec', { command: 'never' });
    // Recorded, and still `pending`: the intent is kept and marked as unwanted rather than
    // invented as done or failed, exactly as `stop()` treats the rows it marks.
    expect(queue.get(late)!.stoppedAt).toBeTruthy();
    expect(queue.get(late)!.status).toBe('pending');
    expect(queue.claim('w1', 'sess_ended')).toBeNull();
    // The session's decision already covers it, so there is nothing left for a second stop
    // to mark - otherwise the guarantee would depend on someone remembering to call it.
    expect(queue.stop('sess_ended')).toBe(0);

    // Every terminal status behaves the same way, and they are read from the state machine
    // rather than listed here, so `timed_out` and `cleanup_pending` count too.
    for (const status of ['cancelled', 'timed_out', 'cleanup_pending']) {
      mkSession(`sess_${status}`, status);
      const id = queue.enqueue(`sess_${status}`, 'read', { path: status });
      expect(queue.get(id)!.stoppedAt).toBeTruthy();
      expect(queue.claim('w1', `sess_${status}`)).toBeNull();
    }

    // A status with an outbound transition is resumable, so its work is still wanted.
    // `failed` is the one that matters: it has a transition back to `running`, and a
    // session that is being retried must not lose the work it queued.
    for (const status of ['queued', 'running', 'paused', 'requires_action', 'failed']) {
      mkSession(`sess_${status}`, status);
      const id = queue.enqueue(`sess_${status}`, 'read', { path: status });
      expect(queue.get(id)!.stoppedAt).toBeNull();
      expect(queue.claim('w1', `sess_${status}`)!.id).toBe(id);
      queue.complete(id, 'w1', { exitCode: 0 });
    }

    // An id with no session row is a caller's mistake rather than a stop, so it stays
    // claimable - which is also how every other test in this file enqueues work.
    const unknown = queue.enqueue('sess_absent', 'read', { path: 'x' });
    expect(queue.get(unknown)!.stoppedAt).toBeNull();
    expect(queue.claim('w1', 'sess_absent')!.id).toBe(unknown);
    queue.complete(unknown, 'w1', { exitCode: 0 });

    // The boundary, stated rather than assumed: rows that were already queued are the queue
    // stop's business, not this predicate's, and this change deliberately does not reach
    // backwards to refuse work that was legitimate when it was written. (The one path where
    // that leaves a gap - a terminal session that skips its sandbox release, so nothing
    // ever calls `queue.stop()` for it - is #631 and is not this change.)
    mkSession('sess_released', 'running');
    const beforeEnd = queue.enqueue('sess_released', 'exec', { command: 'x' });
    expect(queue.stop('sess_released')).toBe(1);
    expect(queue.get(beforeEnd)!.stoppedAt).toBeTruthy();

    // A sandbox released for a session that is still resumable marks only what existed
    // then: the session has not ended, and a turn that resumes has to be able to run the
    // tools it calls. Reading a queue-level stop as a session-level end would strand it.
    const afterRelease = queue.enqueue('sess_released', 'exec', { command: 'y' });
    expect(queue.get(afterRelease)!.stoppedAt).toBeNull();
    expect(queue.claim('w1', 'sess_released')!.id).toBe(afterRelease);
    queue.complete(afterRelease, 'w1', { exitCode: 0 });

    // Once that same session does end, later work is refused by the insert itself: no
    // second stop call, and nothing that depends on who was watching at the time.
    db.prepare("UPDATE sessions SET status = 'completed' WHERE id = 'sess_released'").run();
    const afterEnd = queue.enqueue('sess_released', 'exec', { command: 'z' });
    expect(queue.get(afterEnd)!.stoppedAt).toBeTruthy();
    expect(queue.claim('w1', 'sess_released')).toBeNull();
    expect(queue.stop('sess_released')).toBe(0);
  });

  it('does not hand out work queued for a session that ended without releasing its sandbox', () => {
    // `queue.stop()` is reached only through the sandbox release. `cleanup_pending`
    // deliberately skips that release - the workspace is retained until child-tree cleanup
    // can be proven - and a session that simply finishes its turn never releases one at
    // all, so a session can reach a terminal status with its queued work unmarked. The
    // claim has to read the session's own status, or the work runs anyway.
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    const mkSession = (id: string, status: string): void => {
      db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id, status) VALUES (?, 'agent_x', 'x', 'env_a', ?)").run(id, status);
    };

    mkSession('sess_parked', 'running');
    const parked = queue.enqueue('sess_parked', 'exec', { command: 'nobody wants this' });
    mkSession('sess_held', 'running');
    const held = queue.enqueue('sess_held', 'exec', { command: 'already running' });
    expect(queue.claim('w1', 'sess_held')?.id).toBe(held);
    // The holder stops renewing here; its lease lapses, which is the moment the item
    // becomes a candidate for a second worker.
    backdateClaim(db, held, 24 * 60);

    // The session ends through the path that never tells the queue.
    db.prepare("UPDATE sessions SET status = 'cleanup_pending' WHERE id IN ('sess_parked','sess_held')").run();
    // Nothing marked these rows. That absence is the precondition of the defect, and it is
    // why reading the marker alone was not enough.
    expect(queue.get(parked)!.stoppedAt).toBeNull();
    expect(queue.get(held)!.stoppedAt).toBeNull();

    // Not on a first claim, in any of the three scopes ...
    expect(queue.claim('w1')).toBeNull();
    expect(queue.claim('w1', 'sess_parked')).toBeNull();
    expect(queue.claim('w1', undefined, 'env_a')).toBeNull();
    // ... and not on a reclaim either: `held` is expired and would otherwise be handed to a
    // second worker to run for a session that is over.
    expect(queue.claim('w2')).toBeNull();

    // The holder may still report what actually happened. The session ending says the work
    // is not wanted any more, not that the effect did not occur.
    expect(queue.complete(held, 'w1', { exitCode: 0, stdout: 'ran while it was still wanted' })).toBe('completed');

    // A terminal row must not block the queue behind it. `parked` is the oldest row here, so
    // a predicate that refused it in the update but left it selectable would find nothing it
    // could hand over and would starve every worker of the work that is still wanted.
    mkSession('sess_alive', 'running');
    const live = queue.enqueue('sess_alive', 'read', { path: 'still wanted' });
    expect(queue.claim('w3')!.id).toBe(live);

    // A status with an outbound transition is not an ended session, even when no release
    // ever ran for it: `failed` is retried, and a retry has to be able to run the tools it
    // calls.
    mkSession('sess_retry', 'failed');
    const retried = queue.enqueue('sess_retry', 'exec', { command: 'retry me' });
    expect(queue.claim('w4', 'sess_retry')!.id).toBe(retried);
    queue.complete(retried, 'w4', { exitCode: 0 });

    // And a session that ends by finishing its turn - the path that releases no sandbox at
    // all - is refused the same way, with no marker of its own.
    mkSession('sess_finished', 'running');
    const finished = queue.enqueue('sess_finished', 'exec', { command: 'too late' });
    db.prepare("UPDATE sessions SET status = 'completed' WHERE id = 'sess_finished'").run();
    expect(queue.get(finished)!.stoppedAt).toBeNull();
    expect(queue.claim('w5', 'sess_finished')).toBeNull();
  });

  it('tells a worker its lease is lost once the session stopped the work', () => {
    // A worker executing a long item asks whether the work is still wanted by renewing
    // its claim. Once the session has ended - possibly in another process, where no
    // local abort controller can reach - the stop marker is the only evidence there is.
    // Without an answer a worker can act on, it keeps executing a command the session
    // no longer wants.
    const held = queue.enqueue('sess_done', 'exec', { command: 'long' });
    expect(queue.claim('w1')?.id).toBe(held);
    expect(queue.heartbeat(held, 'w1')).toBe('renewed');
    const claimedAt = (db.prepare('SELECT claimed_at FROM work_items WHERE id = ?').get(held) as { claimed_at: string }).claimed_at;

    expect(queue.stop('sess_done')).toBe(1);
    // The refusal is about the work rather than about the caller: a worker that never
    // held the item gets the same answer, because nobody wants the item any more.
    expect(queue.heartbeat(held, 'w1')).toBe('work_lease_lost');
    expect(queue.heartbeat(held, 'w2')).toBe('work_lease_lost');
    // The stop predicate is a fence, not a check the write slipped past: the timestamp
    // is untouched, so a stopped item's claim cannot be kept alive by renewing it.
    expect((db.prepare('SELECT claimed_at FROM work_items WHERE id = ?').get(held) as { claimed_at: string }).claimed_at).toBe(claimedAt);

    // And the older refusal still means what it meant. An item nobody stopped, held by
    // someone else, is `not_claimed_by_worker`: the work is alive for its holder, so a
    // worker must not read it as permission to abandon anything.
    const other = queue.enqueue('sess_live', 'exec', { command: 'wanted' });
    expect(queue.heartbeat(other, 'w9')).toBe('not_claimed_by_worker');
    expect(queue.heartbeat('work_missing', 'w1')).toBe('not_found');

    // The holder may still report what it ran. The marker says the work is not wanted;
    // it does not say the effect did not happen.
    expect(queue.complete(held, 'w1', { exitCode: 0, stdout: 'finished anyway' })).toBe('completed');
  });
});

describe('SelfHostedSandboxProvider', () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-shp-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dispatches execute() to the queue and returns the worker result', async () => {
    const queue = new WorkQueue(db);
    const provider = new SelfHostedSandboxProvider(queue);
    const sandbox = await provider.provision('sess_x', { name: 'sh', sandbox_provider: 'self_hosted', timeout: 5 });

    // Simulate a worker in the background
    const workerLoop = (async () => {
      for (let i = 0; i < 50; i++) {
        const item = queue.claim('w1', 'sess_x');
        if (item) {
          queue.complete(item.id, 'w1', { exitCode: 0, stdout: 'from worker', stderr: '', timedOut: false });
          return;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    })();

    const result = await sandbox.execute('echo test');
    await workerLoop;
    expect(result.stdout).toBe('from worker');
  });

  it('stops the work a session queued when its sandbox is released', async () => {
    // The lifecycle reaches the queue through the instance's cleanup, which the runtime
    // calls when a session reaches a terminal state - a user stop included. Without
    // this wiring the marker exists but nothing ever sets it, and the same test written
    // against the queue alone would pass while the runtime still handed the work out.
    const queue = new WorkQueue(db);
    const provider = new SelfHostedSandboxProvider(queue);
    const queued = queue.enqueue('sess_released', 'exec', { command: 'echo late' });
    const sandbox = await provider.provision('sess_released', { name: 'sh', sandbox_provider: 'self_hosted' });

    expect(queue.get(queued)!.stoppedAt).toBeNull();
    await sandbox.cleanup();
    expect(queue.get(queued)!.stoppedAt).toBeTruthy();
    // Marked, not completed: the item was never handed out, and the record says so
    // rather than pretending the work happened or that it was thrown away.
    expect(queue.get(queued)!.status).toBe('pending');
  });
});

describe('Worker HTTP endpoints', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof workerRoutes>;
  let queue: WorkQueue;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-shw-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    queue = new WorkQueue(db);
    app = workerRoutes(queue);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('claim returns 204 when empty, then the item once enqueued', async () => {
    const empty = await app.request('/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker_id: 'w1' }),
    });
    expect(empty.status).toBe(204);

    queue.enqueue('s', 'read', { path: 'f' });
    const res = await app.request('/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker_id: 'w1' }),
    });
    expect(res.status).toBe(200);
    const item = await res.json();
    expect(item.kind).toBe('read');
  });

  it('claim rejects without worker_id', async () => {
    const res = await app.request('/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('complete marks the item done', async () => {
    const id = queue.enqueue('s', 'read', { path: 'f' });
    queue.claim('w1');
    const res = await app.request('/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, worker_id: 'w1', result: 'file contents' }),
    });
    expect(res.status).toBe(200);
    expect(queue.get(id)!.status).toBe('done');
  });

  it('rejects completion by a worker that did not claim the item', async () => {
    const id = queue.enqueue('s', 'read', { path: 'f' });
    queue.claim('w1');
    const res = await app.request('/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, worker_id: 'w2', result: 'forged result' }),
    });
    expect(res.status).toBe(409);
    expect(queue.get(id)!.status).toBe('claimed');
  });

  it('requires worker_id when completing an item', async () => {
    const res = await app.request('/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'work_missing', result: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('distinguishes an unknown work item from one claimed by another worker', async () => {
    // Both refusals on this route exist, and only the 409 half was driven: the case
    // above completes an item another worker holds. Nothing reached the 404, because
    // the only request in the suite carrying an unknown id also omitted worker_id and
    // was refused earlier, at the request-shape check.
    //
    // The two answers must stay different. A worker told 409 knows another worker owns
    // the item and that its own claim was never valid; a worker told 404 knows the id
    // is gone and there is nothing left to retry. Collapsing them into one answer would
    // leave a worker unable to tell "not yours" from "not there".
    const id = queue.enqueue('s', 'read', { path: 'f' });
    queue.claim('w1');

    const foreign = await app.request('/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, worker_id: 'w2', result: 'x' }),
    });
    expect(foreign.status).toBe(409);

    const missing = await app.request('/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'work_missing', worker_id: 'w2', result: 'x' }),
    });
    expect(missing.status).toBe(404);
    const body = await missing.json() as { error: { type: string; message: string } };
    // The unknown item answers with the runtime's canonical not_found envelope, not
    // with the conflict the neighbouring case sees.
    expect(body.error.type).toBe('not_found');
    expect(body.error.message).toBe('work item not found');
    // And the refusal changed nothing: the real item is still w1's to complete.
    expect(queue.get(id)!.status).toBe('claimed');
    expect(queue.get(id)!.claimedBy).toBe('w1');
  });

  it('lets only the holder renew a claim, and the renewal re-arms its lease', async () => {
    // The lease window introduced with reclaiming forces a choice: set it above the
    // longest item a worker will ever run, or let a slow item be reclaimed while it is
    // still executing. Renewal is the way out - a worker running a long item says so,
    // and the window restarts from the renewal instead of from the original claim.
    const leased = new WorkQueue(db, { leaseMs: 30 * 60_000 });
    const id = leased.enqueue('s', 'exec', { command: 'long' });
    expect(leased.claim('w1')?.id).toBe(id);
    const claimedAt = (db.prepare('SELECT claimed_at FROM work_items WHERE id = ?').get(id) as { claimed_at: string }).claimed_at;

    // A renewal from a worker that does not hold the item is refused...
    const foreign = await app.request('/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, worker_id: 'w2' }),
    });
    expect(foreign.status).toBe(409);
    // ...and it must not so much as touch the timestamp: a foreign worker cannot keep
    // someone else's claim alive, nor extend its own reach over the item.
    expect((db.prepare('SELECT claimed_at FROM work_items WHERE id = ?').get(id) as { claimed_at: string }).claimed_at).toBe(claimedAt);
    expect(leased.get(id)!.claimedBy).toBe('w1');

    // Past the window, the holder renews and the claim is its own again. This is the
    // assertion that makes the renewal real: if it were a no-op the window would still
    // have elapsed and the item would be handed over below.
    backdateClaim(db, id, 60);
    const own = await app.request('/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, worker_id: 'w1' }),
    });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ ok: true });
    expect(leased.claim('w2')).toBeNull();

    // The two refusals stay distinguishable, and the request shape is checked first.
    const missing = await app.request('/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'work_missing', worker_id: 'w1' }),
    });
    expect(missing.status).toBe(404);
    const shape = await app.request('/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    expect(shape.status).toBe(400);
    // None of the refusals handed the item to anyone, so it is still w1's to finish.
    expect(leased.complete(id, 'w1', { exitCode: 0 })).toBe('completed');
  });

  it('carries the lease is lost code when a renewal targets stopped work', async () => {
    // The code is the contract, because a worker's decision to abandon a command that is
    // already running has to be made from data and not from prose. The stop is what
    // produces it; the neighbouring refusal must keep its own shape, or a worker could
    // not tell "not yours" from "not wanted" and would abandon live work.
    const id = queue.enqueue('sess_over', 'exec', { command: 'long' });
    expect(queue.claim('w1')?.id).toBe(id);

    // Before the session ends the same request is an ordinary success, so what this case
    // observes is the stop arriving rather than the route refusing renewals in general.
    const before = await app.request('/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, worker_id: 'w1' }),
    });
    expect(before.status).toBe(200);

    queue.stop('sess_over');
    const after = await app.request('/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, worker_id: 'w1' }),
    });
    expect(after.status).toBe(409);
    const body = await after.json() as { error: { type: string; code?: string; message: string } };
    expect(body.error.code).toBe('work_lease_lost');
    expect(body.error.type).toBe('conflict');
    expect(body.error.message).toContain('stopped');

    // The other 409 stays code-less on purpose: this item is alive, held by w9, and
    // renewing it from anywhere else is not a reason to stop executing it.
    const alive = queue.enqueue('sess_alive', 'exec', { command: 'wanted' });
    expect(queue.claim('w9')?.id).toBe(alive);
    const foreign = await app.request('/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: alive, worker_id: 'w1' }),
    });
    expect(foreign.status).toBe(409);
    const foreignBody = await foreign.json() as { error: { type: string; code?: string } };
    expect(foreignBody.error.code).toBeUndefined();
    expect(foreignBody.error.type).toBe('conflict');
  });
});
