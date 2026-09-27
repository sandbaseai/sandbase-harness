/**
 * Integration test: the documented `managed-agents worker poll` works end to end.
 *
 * The self-hosted worker CLI is documented in `docs/deployment.md:234`, `docs/api.md`,
 * `docs/api-matrix.md` (twice) and the Console's environment setup step, and ticked off
 * in `docs/spec/tasks.md:84` — while `workerPollCommand` was never registered, so the
 * documented command answered `unknown command 'worker'`.
 *
 * Registering it was not sufficient. `POST /v1/x/worker/complete` requires `worker_id`
 * (`src/api/routes/worker.ts:44`) and matches the row on it, and the command never sent
 * it: the first claimed item would have been executed on the worker and then left
 * `claimed`, with the completion answering `400`. The round trip below is what makes
 * that observable, so it runs against the **real** `workerRoutes` app over a real HTTP
 * listener and the **real** `WorkQueue` — a fetch stub or a mocked route would agree
 * with whatever the command happened to send.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { serve } from '@hono/node-server';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { WorkQueue } from '@/sandbox/self-hosted-provider.js';
import { resolveWorkerPollOptions, renewWhileRunning, workerPollCommand, executeWorkItem } from '@/cli/worker-commands.js';

/** Run `fn` with `console.log` captured, so the poller's output stays out of the report. */
async function withCapturedLog<T>(fn: () => Promise<T>): Promise<string[]> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.join(' '));
  });
  try {
    await fn();
  } finally {
    log.mockRestore();
  }
  return lines;
}

describe('worker poll CLI', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let listening: { close: (cb?: () => void) => void } | undefined;

  afterEach(async () => {
    if (listening) {
      const server = listening;
      listening = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    db?.close();
    db = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  /** A real runtime on a real port, with the real work queue behind the real routes. */
  async function startRuntime() {
    const dir = mkdtempSync(join(tmpdir(), 'ma-worker-poll-'));
    tmpDir = dir;
    db = new Database(join(dir, 'test.db'));
    db.runMigrations();
    const queue = new WorkQueue(db);
    const app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      workQueue: queue,
    });

    const port = await new Promise<number>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        listening = server as unknown as { close: (cb?: () => void) => void };
        resolve(info.port);
      });
    });

    const workdir = join(dir, 'work');
    mkdirSync(workdir, { recursive: true });
    return { queue, port, workdir };
  }

  it('claims, executes and completes a work item over the real routes', async () => {
    const { queue, port, workdir } = await startRuntime();
    writeFileSync(join(workdir, 'greeting.txt'), 'hello from the worker', 'utf8');

    const id = queue.enqueue('sess_worker', 'read', { path: 'greeting.txt' });
    expect(queue.get(id)!.status).toBe('pending');

    const lines = await withCapturedLog(() =>
      workerPollCommand({ port: String(port), workdir, once: true, workerId: 'worker_test' }));

    // The row is read back from SQLite, so this asserts the runtime accepted the
    // completion rather than that the command returned without throwing. Without
    // `worker_id` on `complete` the row stays `claimed` and the command throws.
    const item = queue.get(id)!;
    expect(item.status).toBe('done');
    expect(item.claimedBy).toBe('worker_test');
    expect(item.result).toBe('hello from the worker');
    expect(lines.join('\n')).toContain(`completed ${id}`);
  });

  it('reports a failed work item as failed instead of losing it', async () => {
    // The rejection path is the other half of the same completion call and needs
    // `worker_id` too: the item must end `failed`, not `claimed`.
    const { queue, port, workdir } = await startRuntime();
    const id = queue.enqueue('sess_worker', 'read', { path: 'does-not-exist.txt' });

    await withCapturedLog(() =>
      workerPollCommand({ port: String(port), workdir, once: true, workerId: 'worker_test' }));

    const item = queue.get(id)!;
    expect(item.status).toBe('failed');
    expect(JSON.stringify(item.result)).toContain('does-not-exist.txt');
  });

  it('reports no work and exits when the queue is empty', async () => {
    const { port, workdir } = await startRuntime();

    const lines = await withCapturedLog(() =>
      workerPollCommand({ port: String(port), workdir, once: true }));

    expect(lines.join('\n')).toContain('no work');
  });

  it('does not take work belonging to another environment', async () => {
    // `--environment-id` is passed through to the claim, so a worker pointed at an
    // environment with no pending work must leave the other environment's item alone.
    const { queue, port, workdir } = await startRuntime();
    db!.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    db!.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db!.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_b', 'b', '', '{}', '{}')").run();
    db!.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id) VALUES ('sess_b', 'agent_x', 'x', 'env_b')").run();
    const id = queue.enqueue('sess_b', 'read', { path: 'greeting.txt' });

    await withCapturedLog(() =>
      workerPollCommand({ port: String(port), workdir, once: true, environmentId: 'env_a' }));

    expect(queue.get(id)!.status).toBe('pending');
  });

  it('renews its claim while an item runs, stops when it ends, and survives a failed renewal', async () => {
    // The claim carries a lease window (60s by default) and an `exec` item may take up
    // to its own 300s timeout, so a worker that executed silently past the window had
    // the item reclaimed and handed to a second worker while the first was still
    // running it. The renewal is the machine-side half of that window, and this case is
    // the only thing that drives it.
    const { queue, port, workdir } = await startRuntime();
    writeFileSync(join(workdir, 'greeting.txt'), 'hello', 'utf8');
    const id = queue.enqueue('sess_worker', 'read', { path: 'greeting.txt' });

    // The claim the poller would have made, taken here so the test controls the row.
    expect(queue.claim('worker_test')?.id).toBe(id);
    const opts = resolveWorkerPollOptions({ port: String(port), workdir, workerId: 'worker_test', heartbeatMs: '60' });

    // Every renewal the CLI sends goes to the real route, so the assertions below read
    // the effect out of SQLite rather than trusting the request count.
    const renewals: string[] = [];
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(((input: unknown, init?: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/x/worker/heartbeat')) renewals.push(url);
      return realFetch(input as Parameters<typeof realFetch>[0], init as Parameters<typeof realFetch>[1]);
    }) as typeof realFetch);

    try {
      // Start from a claim that is already past the window: without a renewal the item
      // is claimable by anyone, which is what makes the renewal observable at all.
      db!.prepare("UPDATE work_items SET claimed_at = datetime('now', '-60 minutes') WHERE id = ?").run(id);
      const value = await renewWhileRunning(opts, id, () => new Promise((r) => setTimeout(() => r('executed'), 400)));
      expect(value).toBe('executed');
      expect(renewals.length).toBeGreaterThanOrEqual(2);
      // The renewal reached the row: the abandoned claim is inside its window again, so
      // a second worker polling right now is handed nothing.
      expect(queue.claim('other_worker')).toBeNull();
      expect(queue.get(id)!.claimedBy).toBe('worker_test');
    } finally {
      spy.mockRestore();
    }

    // ...and it stops with the item: a renewal that outlived its run would keep
    // renewing a claim that is about to be completed, once per finished item.
    const settled = renewals.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(renewals.length).toBe(settled);

    // A renewal the server refuses is not fatal to the work. The port is closed, so
    // every renewal fails; the item must still run to completion and report why.
    const dead = resolveWorkerPollOptions({ port: '9', workdir, workerId: 'worker_test', heartbeatMs: '30' });
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.join(' ')); });
    try {
      expect(await renewWhileRunning(dead, id, () => new Promise((r) => setTimeout(() => r('ran anyway'), 150)))).toBe('ran anyway');
    } finally {
      warn.mockRestore();
    }
    expect(warnings.join('\n')).toContain(`renewal failed for ${id}`);

    // And the poll loop is what renews, which the assertions above cannot show on their
    // own: they call the wrapper directly, so a loop that never wrapped its execution
    // would leave them all green. This drives the real command and observes the renewal
    // being scheduled with the configured interval.
    const intervals: number[] = [];
    const realSetInterval = globalThis.setInterval;
    const scheduled = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      intervals.push(Number(ms));
      return realSetInterval(fn as never, ms as never);
    }) as typeof realSetInterval);
    try {
      const polled = queue.enqueue('sess_worker', 'read', { path: 'greeting.txt' });
      await withCapturedLog(() => workerPollCommand({
        port: String(port), workdir, once: true, workerId: 'worker_test', heartbeatMs: '60',
      }));
      expect(queue.get(polled)!.status).toBe('done');
    } finally {
      scheduled.mockRestore();
    }
    expect(intervals).toContain(60);

    // The option is validated like every other one, before the loop starts.
    for (const bad of ['abc', '', 'NaN', '-1', '0', '24']) {
      expect(() => resolveWorkerPollOptions({ port: '3000', workdir: '.', heartbeatMs: bad })).toThrow(/heartbeat-ms/);
    }
    expect(resolveWorkerPollOptions({ port: '3000', workdir: '.' }).heartbeatMs).toBe(20_000);
    expect(resolveWorkerPollOptions({ port: '3000', workdir: '.', heartbeatMs: '25' }).heartbeatMs).toBe(25);
  });

  it('stops running an item when the server says its lease is gone', async () => {
    // A renewal has two kinds of failure and they must not be treated alike. A transport
    // failure is a suspicion that the claim may have lapsed; `work_lease_lost` is the server
    // stating that the session ended and stopped the work. The renewal is the only channel
    // that can carry that decision to the process holding the command.
    const { queue, port, workdir } = await startRuntime();
    const id = queue.enqueue('sess_stopped', 'read', { path: 'greeting.txt' });
    expect(queue.claim('worker_test')?.id).toBe(id);
    const opts = resolveWorkerPollOptions({ port: String(port), workdir, workerId: 'worker_test', heartbeatMs: '25' });
    expect(queue.stop('sess_stopped')).toBe(1);

    let observed: AbortSignal | undefined;
    const started = Date.now();
    await expect(renewWhileRunning(opts, id, (signal) => {
      observed = signal;
      return new Promise<string>((resolvePromise) => {
        const timer = setTimeout(() => resolvePromise('ran to the end'), 8_000);
        signal.addEventListener('abort', () => { clearTimeout(timer); resolvePromise('stopped early'); }, { once: true });
      });
    })).rejects.toThrow(/work_lease_lost/);

    // Two things make this real: the run was handed a signal it can act on, and the decision
    // arrived and aborted it long before the item would have finished on its own. The reason
    // names the code so the queue record explains itself.
    expect(observed?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);

    // The other 409 is not a stop. An item held by another worker is alive, so a worker that
    // read that refusal as "stop" would abandon work that is still wanted - it is logged and
    // the item keeps running.
    const alive = queue.enqueue('sess_alive', 'read', { path: 'greeting.txt' });
    expect(queue.claim('other_worker')?.id).toBe(alive);
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.join(' ')); });
    let otherSignal: AbortSignal | undefined;
    let ran: string;
    try {
      ran = await renewWhileRunning(opts, alive, (signal) => {
        otherSignal = signal;
        return new Promise<string>((resolvePromise) => setTimeout(() => resolvePromise('ran anyway'), 150));
      });
    } finally {
      warn.mockRestore();
    }
    expect(ran).toBe('ran anyway');
    expect(otherSignal?.aborted).toBe(false);
    expect(warnings.join('\n')).toContain(`renewal failed for ${alive}`);
  });

  // `execShell` runs `/bin/sh`, so the kill can only be observed where that shell exists. CI
  // runs this suite on ubuntu-latest as well as windows-latest, so the behaviour is exercised
  // there; on Windows the result would measure the absence of a shell rather than the abort.
  it.skipIf(process.platform === 'win32')('kills the shell of an exec item when its lease is lost', async () => {
    const { queue, port, workdir } = await startRuntime();
    // Thirty seconds of work that only ends early if it is signalled.
    const id = queue.enqueue('sess_stopped', 'exec', { command: 'sleep 30', timeout: 60_000 });
    expect(queue.claim('worker_test')?.id).toBe(id);
    const opts = resolveWorkerPollOptions({ port: String(port), workdir, workerId: 'worker_test', heartbeatMs: '25' });
    expect(queue.stop('sess_stopped')).toBe(1);

    const item = { id, kind: 'exec' as const, payload: { command: 'sleep 30', timeout: 60_000 } };
    const started = Date.now();
    await expect(renewWhileRunning(opts, id, (signal) => executeWorkItem(item, workdir, signal)))
      .rejects.toThrow(/work_lease_lost/);
    // Reaching here in a fraction of the thirty seconds is the kill rather than the command
    // finishing or timing out on its own.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('refuses an unusable --interval-ms instead of polling with no delay', () => {
    // `Number('abc')` is NaN and `setTimeout(fn, NaN)` fires immediately, so the old
    // `Math.max(250, Number(...))` produced a busy loop against the server rather than
    // an error. It has to be rejected before the loop starts.
    for (const bad of ['abc', '', 'NaN', '-1', '0', '249']) {
      expect(() => resolveWorkerPollOptions({ port: '3000', workdir: '.', intervalMs: bad }))
        .toThrow(/interval-ms/);
    }
    expect(resolveWorkerPollOptions({ port: '3000', workdir: '.', intervalMs: '1000' }).intervalMs).toBe(1000);
    expect(resolveWorkerPollOptions({ port: '3000', workdir: '.' }).intervalMs).toBe(1000);
    expect(resolveWorkerPollOptions({ port: '3000', workdir: '.', intervalMs: '250' }).intervalMs).toBe(250);
  });

  it('refuses an unusable --port', () => {
    for (const bad of ['abc', '', '0', '65536', '3000.5', '-1']) {
      expect(() => resolveWorkerPollOptions({ port: bad, workdir: '.' })).toThrow(/port/);
    }
    expect(resolveWorkerPollOptions({ port: '3000', workdir: '.' }).port).toBe('3000');
  });
});
