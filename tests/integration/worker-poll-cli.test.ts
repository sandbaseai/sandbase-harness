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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(queue.get(id)!.status).toBe('queued');

    const lines = await withCapturedLog(() =>
      workerPollCommand({ port: String(port), workdir, once: true, workerId: 'worker_test' }));

    // The row is read back from SQLite, so this asserts the runtime accepted the
    // completion rather than that the command returned without throwing. Without
    // `worker_id` on `complete` the row stays `claimed` and the command throws.
    const item = queue.get(id)!;
    expect(item.status).toBe('applied');
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

  it('does not hang, run, or report an item the server never answers about', async () => {
    // A server that takes the connection and never replies used to park the worker on that
    // `await` with no bound: it ran nothing, reported nothing, and never polled again, while
    // holding a claim it could no longer renew. The frozen protocol lists this as an
    // acceptance criterion - "等不到 ack → 在有界时间内以机器可读原因失败，不是挂住".
    //
    // **The mock models a hanging server literally: it never settles on its own and rejects
    // only when the signal it was given aborts.** An earlier version of this case rejected
    // unconditionally, and a probe that removed the bound still passed - which showed the
    // case was asserting the error *mapping* and not the bound at all. Modelling the hang
    // faithfully is what makes the bound load-bearing.
    //
    // "Not a hang" is asserted by requiring the call to return inside a declared budget that
    // is far below this suite's 30s test timeout, so a missing bound fails as a named
    // assertion in seconds instead of as a timeout that could be blamed on a slow runner.
    const hangBudgetMs = 5_000;
    const { queue, port, workdir } = await startRuntime();
    const id = queue.enqueue('sess_worker', 'write', { path: 'must-not-exist.txt', content: 'ran anyway' });

    const realFetch = globalThis.fetch;
    const completions: string[] = [];
    let sawSignal: AbortSignal | undefined;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(((input: unknown, init?: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/x/worker/accept')) {
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        sawSignal = signal;
        return new Promise((_resolve, reject) => {
          // No bound: nothing ever settles, which is exactly the defect.
          if (!signal) return;
          signal.addEventListener('abort', () => {
            const abort = new Error('The operation was aborted due to timeout');
            abort.name = 'TimeoutError';
            reject(abort);
          });
        });
      }
      if (url.endsWith('/v1/x/worker/complete')) completions.push(url);
      return realFetch(input as Parameters<typeof realFetch>[0], init as Parameters<typeof realFetch>[1]);
    }) as typeof realFetch);

    let lines: string[] = [];
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.join(' ')); });
    let budget: ReturnType<typeof setTimeout> | undefined;
    try {
      lines = await withCapturedLog(() => Promise.race([
        workerPollCommand({ port: String(port), workdir, once: true, workerId: 'worker_test', ackTimeoutMs: '1' }),
        new Promise<never>((_resolve, reject) => {
          budget = setTimeout(
            () => reject(new Error(
              `worker hung: the claim confirmation was not bounded, so it never returned within ${hangBudgetMs}ms`,
            )),
            hangBudgetMs,
          );
        }),
      ]));
    } finally {
      clearTimeout(budget);
      warn.mockRestore();
      spy.mockRestore();
    }

    // The request really was bounded: a signal reached `fetch`, and it is the configured
    // option that produced it rather than some incidental default.
    expect(sawSignal).toBeInstanceOf(AbortSignal);

    // The item was claimed, so the claim really happened and what failed is the confirmation.
    const item = queue.get(id)!;
    expect(item.status).toBe('queued');
    expect(item.claimedBy).toBe('worker_test');
    expect(item.acceptedAt).toBeNull();
    // Nothing ran and nothing was reported - the same refusal to act as a rejected
    // confirmation, because an unconfirmed claim is one the worker cannot prove it holds.
    expect(existsSync(join(workdir, 'must-not-exist.txt'))).toBe(false);
    expect(completions).toEqual([]);
    expect(item.result).toBeUndefined();
    // The reason is machine-readable and says which bound expired, so a supervisor can
    // distinguish "the server went quiet" from "the server refused" without parsing prose.
    expect(warnings.join('\n')).toContain(`not running ${id}`);
    expect(warnings.join('\n')).toContain('work_accept_unconfirmed');
    expect(warnings.join('\n')).toContain('1ms');
    expect(lines.join('\n')).not.toContain(`completed ${id}`);
  });

  it('refuses an unusable acknowledgement bound at startup', () => {
    // Same reasoning as the interval and heartbeat options: a worker is a long-running
    // process that executes commands on someone's machine, so a value it cannot honour has
    // to stop it where the operator is still reading. `AbortSignal.timeout(NaN)` would
    // otherwise throw later, from inside the loop, and surface as a request failure rather
    // than as a bad option.
    for (const bad of ['abc', '', 'NaN', '-1', '0']) {
      expect(() => resolveWorkerPollOptions({ port: '3000', workdir: '.', ackTimeoutMs: bad }))
        .toThrow(/ack-timeout-ms/);
    }
    expect(resolveWorkerPollOptions({ port: '3000', workdir: '.' }).ackTimeoutMs).toBe(10_000);
    expect(resolveWorkerPollOptions({ port: '3000', workdir: '.', ackTimeoutMs: '1' }).ackTimeoutMs).toBe(1);
  });

  it('reports no work and exits when the queue is empty', async () => {
    const { port, workdir } = await startRuntime();

    const lines = await withCapturedLog(() =>
      workerPollCommand({ port: String(port), workdir, once: true }));

    expect(lines.join('\n')).toContain('no work');
  });

  it('does not run or report an item whose claim the server refuses to confirm', async () => {
    // The lease window can pass between claiming and starting, and an item whose window
    // passed is claimable again - so the claim alone does not authorize execution. The
    // refusal is driven at the route boundary here (a real 409 from the real server, made
    // to happen for an item that is otherwise perfectly claimable), because the gap it
    // guards is a race and a test that merely waited for a 60s lease would be asserting
    // timing instead of behaviour.
    //
    // What matters is what does **not** happen next: the command must not run the item and
    // must not report a result for it. A completion would tell the queue an effect
    // occurred that never occurred, and every retry decision downstream reads that record.
    const { queue, port, workdir } = await startRuntime();
    const id = queue.enqueue('sess_worker', 'write', { path: 'must-not-exist.txt', content: 'ran anyway' });

    const realFetch = globalThis.fetch;
    const completions: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(((input: unknown, init?: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/x/worker/accept')) {
        return Promise.resolve(new Response(
          JSON.stringify({ error: { type: 'conflict', code: 'work_lease_lost', message: 'claim lease has run out' } }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ));
      }
      if (url.endsWith('/v1/x/worker/complete')) completions.push(url);
      return realFetch(input as Parameters<typeof realFetch>[0], init as Parameters<typeof realFetch>[1]);
    }) as typeof realFetch);

    let lines: string[] = [];
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.join(' ')); });
    try {
      lines = await withCapturedLog(() =>
        workerPollCommand({ port: String(port), workdir, once: true, workerId: 'worker_test' }));
    } finally {
      warn.mockRestore();
      spy.mockRestore();
    }

    // The item was claimed, so the claim really did happen and the refusal is about the
    // acceptance rather than about the item never being handed out.
    const item = queue.get(id)!;
    expect(item.status).toBe('queued');
    expect(item.claimedBy).toBe('worker_test');
    expect(item.acceptedAt).toBeNull();
    // Nothing ran: the write the item describes never reached the workdir.
    expect(existsSync(join(workdir, 'must-not-exist.txt'))).toBe(false);
    // And nothing was reported, on either channel - no completion request, and no result
    // recorded on the row for a later reader to mistake for an effect.
    expect(completions).toEqual([]);
    expect(item.result).toBeUndefined();
    // The refusal is reported to the operator on the warning channel, and `completed` is
    // absent from the normal output - the command must not look as though it ran anything.
    expect(warnings.join('\n')).toContain(`not running ${id}`);
    expect(lines.join('\n')).not.toContain(`completed ${id}`);
  });

  it('does not report a succeeded item as failed when its completion is refused', async () => {
    // The defect: the success path wrapped `completeWorkItem` in the same `try` whose `catch`
    // exists to report a **failed command**, so a completion the server refused was answered
    // by reporting the same item again with `failed: true`. Work that had succeeded was
    // recorded as failed, carrying the transport error as its result.
    //
    // `409` is not an exotic answer here. It is what the route returns once the lease lapsed
    // and the queue moved an accepted item to `unknown`, which is the record that says the
    // outcome can no longer be written - so this is the *expected* answer for a late
    // completion, not an edge case.
    const { queue, port, workdir } = await startRuntime();
    const id = queue.enqueue('sess_worker', 'read', { path: 'greeting.txt' });
    writeFileSync(join(workdir, 'greeting.txt'), 'the item really ran', 'utf8');

    const realFetch = globalThis.fetch;
    const completionBodies: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(((input: unknown, init?: unknown) => {
      const url = String(input);
      if (!url.endsWith('/v1/x/worker/complete')) {
        return realFetch(input as Parameters<typeof realFetch>[0], init as Parameters<typeof realFetch>[1]);
      }
      completionBodies.push(JSON.parse(String((init as { body?: unknown } | undefined)?.body)) as Record<string, unknown>);
      return Promise.resolve(new Response(
        JSON.stringify({ error: { type: 'conflict', message: 'work item is not claimed by this worker' } }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ));
    }) as typeof realFetch);

    let lines: string[] = [];
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.join(' ')); });
    try {
      // `workerPollCommand` **resolving** is the assertion that the refusal did not escape
      // the loop. Before the fix this line rejected, so one late completion ended the process.
      lines = await withCapturedLog(() =>
        workerPollCommand({ port: String(port), workdir, once: true, workerId: 'worker_test' }));
    } finally {
      warn.mockRestore();
      spy.mockRestore();
    }

    // Exactly one completion was sent. A second one is the defect itself, and asserting the
    // count catches it even if the second request happened to be accepted.
    expect(completionBodies).toHaveLength(1);
    // The one request describes the work that happened, not a failure of it.
    expect(completionBodies[0].failed).toBeUndefined();
    expect(completionBodies[0].result).toBe('the item really ran');

    // The queue was told nothing, so it holds no failure for this item - the truthful record
    // is the one it already had, and the lease it keeps is what will make the item `unknown`
    // rather than replayed.
    const item = queue.get(id)!;
    expect(item.status).toBe('accepted');
    expect(item.result).toBeUndefined();

    // The delivery failure is machine-readable and names the status it was refused with, so a
    // supervisor can tell "the outcome was not recorded" from "the work failed".
    expect(warnings.join('\n')).toContain(`could not report ${id}`);
    expect(warnings.join('\n')).toContain('work_completion_undelivered');
    expect(warnings.join('\n')).toContain('409');
    // And it is not announced as completed, because the queue never accepted the report.
    expect(lines.join('\n')).not.toContain(`completed ${id}`);
  });

  it('still reports a failed item as failed when the delivery itself is refused', async () => {
    // The other side of the same separation, and the reason it has to be a separation rather
    // than a swallowed error: a command that failed **is** an item failure, and a refused
    // delivery of that fact must not turn it into silence either. Both outcomes go through
    // the same delivery step, so this asserts the step still carries `failed: true` - and
    // that its own refusal is survived rather than thrown.
    const { queue, port, workdir } = await startRuntime();
    const id = queue.enqueue('sess_worker', 'read', { path: 'does-not-exist.txt' });

    const realFetch = globalThis.fetch;
    const completionBodies: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(((input: unknown, init?: unknown) => {
      const url = String(input);
      if (!url.endsWith('/v1/x/worker/complete')) {
        return realFetch(input as Parameters<typeof realFetch>[0], init as Parameters<typeof realFetch>[1]);
      }
      completionBodies.push(JSON.parse(String((init as { body?: unknown } | undefined)?.body)) as Record<string, unknown>);
      return Promise.resolve(new Response(
        JSON.stringify({ error: { type: 'conflict', message: 'work item is not claimed by this worker' } }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ));
    }) as typeof realFetch);

    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.join(' ')); });
    try {
      await withCapturedLog(() =>
        workerPollCommand({ port: String(port), workdir, once: true, workerId: 'worker_test' }));
    } finally {
      warn.mockRestore();
      spy.mockRestore();
    }

    expect(completionBodies).toHaveLength(1);
    // The failure path is intact: the report still says the item failed, and still carries the
    // command's own error rather than the delivery error.
    expect(completionBodies[0].failed).toBe(true);
    expect(JSON.stringify(completionBodies[0].result)).toContain('does-not-exist.txt');
    expect(warnings.join('\n')).toContain('work_completion_undelivered');
    // The row is untouched by the refusal, which is the point: the queue decides the item's
    // fate, and this worker's inability to report does not get to write `failed` into it.
    expect(queue.get(id)!.status).toBe('accepted');
  });

  it('reports a completion that never reached the runtime as undelivered, not as a failure', async () => {
    // A refusal and a transport failure are both "not delivered" and both need to be told
    // apart from an item failure - but they need to be told apart from **each other** too,
    // because "the server said no" and "the server was not reached" are different diagnoses.
    // The status is what carries the difference, and `null` is the transport case.
    const { queue, port, workdir } = await startRuntime();
    const id = queue.enqueue('sess_worker', 'read', { path: 'greeting.txt' });
    writeFileSync(join(workdir, 'greeting.txt'), 'ran fine', 'utf8');

    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(((input: unknown, init?: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/x/worker/complete')) return Promise.reject(new Error('ECONNRESET'));
      return realFetch(input as Parameters<typeof realFetch>[0], init as Parameters<typeof realFetch>[1]);
    }) as typeof realFetch);

    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.join(' ')); });
    try {
      await withCapturedLog(() =>
        workerPollCommand({ port: String(port), workdir, once: true, workerId: 'worker_test' }));
    } finally {
      warn.mockRestore();
      spy.mockRestore();
    }

    expect(warnings.join('\n')).toContain('work_completion_undelivered');
    // The distinction the status carries: no answer arrived, so nothing was refused.
    expect(warnings.join('\n')).toContain('did not reach the runtime');
    expect(warnings.join('\n')).toContain('ECONNRESET');
    expect(queue.get(id)!.status).toBe('accepted');
  });

  it('keeps polling after a completion it could not deliver', async () => {
    // "Does not terminate the worker" has to mean the loop kept going, not merely that the
    // call returned - with `--once` a return is also what an early exit looks like. The loop
    // is therefore allowed to run and the **second claim** is counted: reaching it is the
    // proof that the refused completion did not stop it.
    //
    // The stopping condition is the loop's own sleep *after* that second claim, so the count
    // is real and the command still settles. It used to be a sentinel thrown from the second
    // claim, which no longer works and must not: since the claim step was bounded and wrapped,
    // a claim error is caught and retried like any other, so a sentinel thrown there is
    // swallowed and the test polls for ever. Throwing from the timer instead also proves the
    // loop got all the way back to sleeping - and it is the same technique the claim tests
    // use, so there is one way to stop this loop, not two.
    const { queue, port, workdir } = await startRuntime();
    const id = queue.enqueue('sess_worker', 'read', { path: 'greeting.txt' });
    writeFileSync(join(workdir, 'greeting.txt'), 'ran fine', 'utf8');

    const intervalMarker = 1235;
    const realFetch = globalThis.fetch;
    let claims = 0;
    const completionBodies: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(((input: unknown, init?: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/x/worker/claim')) {
        claims += 1;
        // Empty from the second claim on, so the loop has nothing to do but poll and sleep.
        if (claims >= 2) return Promise.resolve(new Response(null, { status: 204 }));
        return realFetch(input as Parameters<typeof realFetch>[0], init as Parameters<typeof realFetch>[1]);
      }
      if (url.endsWith('/v1/x/worker/complete')) {
        completionBodies.push(JSON.parse(String((init as { body?: unknown } | undefined)?.body)) as Record<string, unknown>);
        return Promise.resolve(new Response(
          JSON.stringify({ error: { type: 'conflict', message: 'work item is not claimed by this worker' } }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ));
      }
      return realFetch(input as Parameters<typeof realFetch>[0], init as Parameters<typeof realFetch>[1]);
    }) as typeof realFetch);

    const realSetTimeout = globalThis.setTimeout;
    let sleeps = 0;
    const sentinel = new Error('SENTINEL_LOOP_CONTINUED');
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (Number(ms) === intervalMarker) {
        sleeps += 1;
        if (sleeps >= 2) throw sentinel;
      }
      return realSetTimeout(fn as never, ms as never);
    }) as typeof realSetTimeout);

    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.join(' ')); });
    let rejection: unknown;
    try {
      await withCapturedLog(() =>
        workerPollCommand({
          port: String(port), workdir, intervalMs: String(intervalMarker), workerId: 'worker_test',
        }));
    } catch (error) {
      rejection = error;
    } finally {
      warn.mockRestore();
      timers.mockRestore();
      spy.mockRestore();
    }

    // The loop reached a second claim, which it could only do by surviving the refusal.
    expect(claims).toBe(2);
    expect(rejection).toBe(sentinel);
    expect(sleeps).toBeGreaterThanOrEqual(2);
    // And it did not answer the refusal by trying again: one attempt, still not a failure.
    expect(completionBodies).toHaveLength(1);
    expect(completionBodies[0].failed).toBeUndefined();
    expect(warnings.join('\n')).toContain('work_completion_undelivered');
    expect(queue.get(id)!.status).toBe('accepted');
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

    expect(queue.get(id)!.status).toBe('queued');
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
      expect(queue.get(polled)!.status).toBe('applied');
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

  it('reports a renewal the runtime never answers, and does not stop the item for it', async () => {
    // The renewal is issued from a `setInterval`, which is what made the missing bound worse
    // here than anywhere else: an unanswered request did not park the worker once, it parked
    // it again on **every tick**, and no tick ever reached the warning, because a promise that
    // never settles never reaches a `.catch`. The only symptom was indirect and late - the
    // claim lapsed, the queue moved a healthy worker's item to `unknown`, and its real result
    // was refused as a late write.
    //
    // The bound makes that observable. It must not change what the worker does about it: a
    // timeout is still a *suspicion* that the claim lapsed, so the item keeps running, and
    // `work_lease_lost` stays the one renewal answer that aborts one.
    const { queue, port, workdir } = await startRuntime();
    writeFileSync(join(workdir, 'greeting.txt'), 'still here', 'utf8');
    const id = queue.enqueue('sess_worker', 'read', { path: 'greeting.txt' });
    expect(queue.claim('worker_test')?.id).toBe(id);

    const opts = resolveWorkerPollOptions({
      port: String(port), workdir, workerId: 'worker_test', heartbeatMs: '40', heartbeatTimeoutMs: '7',
    });

    const realFetch = globalThis.fetch;
    let beats = 0;
    let sawSignal: AbortSignal | undefined;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(((input: unknown, init?: unknown) => {
      const url = String(input);
      if (!url.endsWith('/v1/x/worker/heartbeat')) {
        return realFetch(input as Parameters<typeof realFetch>[0], init as Parameters<typeof realFetch>[1]);
      }
      beats += 1;
      const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
      sawSignal = signal;
      // **A hanging server modelled literally**: nothing settles on its own, and it rejects
      // only when the signal it was given aborts. A mock that rejected unconditionally would
      // let a missing bound pass, because the rejection would arrive without one - the same
      // fidelity trap that made an earlier bound probe assert the error mapping rather than
      // the bound.
      return new Promise((_resolve, reject) => {
        if (!signal) return;
        signal.addEventListener('abort', () => {
          const abort = new Error('The operation was aborted due to timeout');
          abort.name = 'TimeoutError';
          reject(abort);
        });
      });
    }) as typeof realFetch);

    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.join(' ')); });
    // Asserted as a named diagnosis against an explicit short budget rather than by inheriting
    // the runner's 30s timeout, so a missing bound fails in seconds and cannot be blamed on a
    // slow runner.
    const hangBudgetMs = 5_000;
    let budget: ReturnType<typeof setTimeout> | undefined;
    let runSignal: AbortSignal | undefined;
    let value: unknown;
    try {
      value = await Promise.race([
        renewWhileRunning(opts, id, (signal) => {
          runSignal = signal;
          return new Promise((r) => setTimeout(() => r('ran despite the silence'), 500));
        }),
        new Promise<never>((_resolve, reject) => {
          budget = setTimeout(
            () => reject(new Error(
              `the renewal was not bounded: nothing returned within ${hangBudgetMs}ms`,
            )),
            hangBudgetMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(budget);
      warn.mockRestore();
      spy.mockRestore();
    }

    // A bound really was applied, and it is the configured option rather than an incidental
    // default.
    expect(sawSignal).toBeInstanceOf(AbortSignal);
    // Every tick was bounded rather than left in flight: more than one renewal was attempted
    // during the run, so this is the pile-up path and not a single request.
    expect(beats).toBeGreaterThanOrEqual(2);
    // The item kept running and produced its result. This is the half that must not regress -
    // an expired bound is a suspicion, and abandoning a command on one leaves a half-applied
    // side effect.
    expect(value).toBe('ran despite the silence');
    expect(runSignal?.aborted).toBe(false);
    // And the failure is now visible on the existing best-effort channel, naming the code and
    // the bound it waited, so "the runtime is not answering my renewals" can be read without
    // parsing prose.
    expect(warnings.join('\n')).toContain(`renewal failed for ${id}`);
    expect(warnings.join('\n')).toContain(`renewal unconfirmed for ${id}`);
    expect(warnings.join('\n')).toContain('work_heartbeat_unconfirmed');
    expect(warnings.join('\n')).toContain('7ms');
    // Not the abort path: a timeout must never be reported as the stop that ends an item.
    expect(warnings.join('\n')).not.toContain('work_lease_lost');
  });

  it('refuses an unusable renewal bound at startup', () => {
    // The same rule as every other option: a worker is a long-running process executing
    // commands on someone's machine, so a value it cannot honour stops it where the operator
    // is still reading. `AbortSignal.timeout(NaN)` would otherwise throw from inside the
    // interval, where the failure reads as a request failure rather than a bad option.
    for (const bad of ['abc', '', 'NaN', '-1', '0']) {
      expect(() => resolveWorkerPollOptions({ port: '3000', workdir: '.', heartbeatTimeoutMs: bad }))
        .toThrow(/heartbeat-timeout-ms/);
    }
    // The default is half the default renewal interval, so a renewal that is not going to be
    // answered stops being in flight before the next tick is due.
    expect(resolveWorkerPollOptions({ port: '3000', workdir: '.' }).heartbeatTimeoutMs).toBe(10_000);
    expect(resolveWorkerPollOptions({ port: '3000', workdir: '.', heartbeatTimeoutMs: '25' }).heartbeatTimeoutMs).toBe(25);
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

  it('polls again after a claim the runtime never answers', async () => {
    // The claim is the first thing the loop does and the only request in it with no bound
    // and no error handling. Because it is issued once from the loop rather than from a
    // timer, an unanswered claim is a *silent total stall*: no timeout, no second request,
    // no pile to notice - the worker simply sits there until someone restarts it.
    const { port, workdir } = await startRuntime();

    let claims = 0;
    let sawSignal: AbortSignal | undefined;
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(((input: unknown, init?: unknown) => {
      const url = String(input);
      if (!url.endsWith('/v1/x/worker/claim')) {
        return realFetch(input as Parameters<typeof realFetch>[0], init as Parameters<typeof realFetch>[1]);
      }
      claims += 1;
      if (claims > 1) {
        // The queue is empty from here on, so the loop is left doing nothing but polling -
        // and that is the point: reaching a second claim at all is the proof.
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
      sawSignal = signal;
      // A hanging server, modelled literally: nothing settles on its own and it rejects
      // only when the signal it was given aborts, so a missing bound cannot pass by
      // rejecting by itself.
      return new Promise((_resolve, reject) => {
        if (!signal) return;
        signal.addEventListener('abort', () => {
          const abort = new Error('The operation was aborted due to timeout');
          abort.name = 'TimeoutError';
          reject(abort);
        });
      });
    }) as typeof realFetch);

    // The loop would poll for ever by design, so the second sleep is the stopping condition:
    // throwing from the timer's executor rejects `sleep`, which escapes the loop and settles
    // the command. Intercepting only the configured interval keeps the abort timer and
    // Vitest's own timers out of it, and the value is deliberately unusual.
    const intervalMarker = 1234;
    const realSetTimeout = globalThis.setTimeout;
    let sleeps = 0;
    const sentinel = new Error('SENTINEL_LOOP_CONTINUED');
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (Number(ms) === intervalMarker) {
        sleeps += 1;
        if (sleeps >= 2) throw sentinel;
      }
      return realSetTimeout(fn as never, ms as never);
    }) as typeof realSetTimeout);

    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.join(' ')); });
    let failure: unknown;
    try {
      await workerPollCommand({
        port: String(port), workdir, workerId: 'worker_test',
        intervalMs: String(intervalMarker), claimTimeoutMs: '7',
      });
    } catch (error) {
      failure = error;
    } finally {
      warn.mockRestore();
      timers.mockRestore();
      spy.mockRestore();
    }

    // A bound was applied, and it is the configured option.
    expect(sawSignal).toBeInstanceOf(AbortSignal);
    // The loop reached a **second** claim, which is the behaviour: a claim that produced
    // nothing leaves the worker polling instead of parked.
    expect(claims).toBeGreaterThanOrEqual(2);
    // The stall is now a logged failure naming the code and the bound it waited.
    expect(warnings.join('\n')).toContain('could not claim work');
    expect(warnings.join('\n')).toContain('work_claim_unconfirmed');
    expect(warnings.join('\n')).toContain('7ms');
    // The sentinel is how we know the loop got past the failure and back to sleeping: it
    // came from the second interval timer, which is only reached after a second claim.
    expect(failure).toBe(sentinel);
    expect(sleeps).toBeGreaterThanOrEqual(2);
  });

  it('does not end the worker when the claim itself fails', async () => {
    // Nothing sits between `claimWorkItem` and the command, so anything the request throws
    // used to escape the loop and terminate the process. A runtime that blinks was therefore
    // enough to kill every worker pointed at it - the opposite of what a poll loop with a
    // configurable interval is for.
    const refusals = ['ECONNREFUSED 127.0.0.1:3000', 'fetch failed'];
    for (const message of refusals) {
      const realFetch = globalThis.fetch;
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((() => {
        const error = new Error(message);
        error.name = 'TypeError';
        return Promise.reject(error);
      }) as typeof realFetch);
      const warnings: string[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.join(' ')); });
      let failure: unknown;
      try {
        // `--once` is the one configuration where the loop is allowed to stop by itself, so
        // it is the only way to assert "it did not exit" without abandoning a pending promise.
        await workerPollCommand({ port: '9', workdir: '.', once: true, workerId: 'worker_test' });
      } catch (error) {
        failure = error;
      } finally {
        warn.mockRestore();
        spy.mockRestore();
      }
      // It resolved. Before this change the same call rejected with the transport error.
      expect(failure).toBeUndefined();
      expect(warnings.join('\n')).toContain('could not claim work');
      expect(warnings.join('\n')).toContain(message);
    }
  });

  it('refuses an unusable claim bound at startup', () => {
    for (const bad of ['abc', '', 'NaN', '-1', '0']) {
      expect(() => resolveWorkerPollOptions({ port: '3000', workdir: '.', claimTimeoutMs: bad }))
        .toThrow(/claim-timeout-ms/);
    }
    // The default is comfortably above a localhost round trip and well under the lease window,
    // so an expired bound leaves the claim's row still the worker's own while it walks away.
    expect(resolveWorkerPollOptions({ port: '3000', workdir: '.' }).claimTimeoutMs).toBe(10_000);
    expect(resolveWorkerPollOptions({ port: '3000', workdir: '.', claimTimeoutMs: '25' }).claimTimeoutMs).toBe(25);
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
