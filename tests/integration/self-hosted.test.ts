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
});
