/**
 * Self-hosted environment worker: the machine-side half of the work queue.
 *
 * A worker claims work items from `POST /v1/x/worker/claim`, executes them inside
 * `--workdir`, and reports each result to `POST /v1/x/worker/complete`. The server
 * never runs them — this process does.
 *
 * Three invariants this file has to hold, none of which it held before:
 *
 * 1. `complete` carries the same `worker_id` that `claim` sent. The route requires
 *    it (`src/api/routes/worker.ts:44`) and matches the row on it
 *    (`AND claimed_by = ?`), so a completion without it is a `400`: the work item's
 *    side effect has already happened and the row stays `claimed` forever.
 * 2. Options are validated before the loop starts. `setTimeout(fn, NaN)` fires
 *    immediately, so a malformed `--interval-ms` used to become a busy loop against
 *    the server instead of an error.
 * 3. A claimed item is renewed while it runs. The claim carries a lease window
 *    (60s by default) and an `exec` item may take up to its own 300s timeout, so a
 *    worker that executed silently past the window had its item reclaimed and handed
 *    to a second worker while the first was still running it — the work happened
 *    twice on the operator's machine, and only then was the first completion refused.
 * 4. A renewal refused with `work_lease_lost` stops the item. The stop is decided by
 *    the session that queued the work, possibly in another process, so this response
 *    is the only way it reaches the command being run - and a worker that kept going
 *    would be executing work nobody is waiting for. Every other renewal failure is a
 *    suspicion and leaves the item running.
 * 5. A claimed item is accepted before it is run. The lease window can pass between
 *    claiming and starting - the worker returns from the claim, resolves its workdir, and
 *    on the path this protocol exists to tolerate may be a second process that was paused
 *    or descheduled - and an item whose window passed is claimable again, so without this
 *    the item runs twice on the operator's machine. A refused acceptance means the item is
 *    **not** run and **not** reported: a completion would assert an effect that never
 *    happened.
 */

import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/** Below this, polling a queue is indistinguishable from hammering the server. */
const MIN_POLL_INTERVAL_MS = 250;

const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * The interval is a third of the queue's default lease window, which is the same
 * relationship the session file lease uses between its heartbeat and staleness
 * (`src/strategy/pi/session-lease.ts:80-89`): frequent enough that a running worker
 * renews several times inside one window, sparse enough that an idle window costs
 * nothing.
 */
const MIN_HEARTBEAT_MS = 25;

const DEFAULT_HEARTBEAT_MS = 20_000;

export type WorkerPollOptions = {
  port: string;
  apiKey?: string;
  environmentId?: string;
  environmentKey?: string;
  workerId?: string;
  workdir: string;
  once?: boolean;
  intervalMs?: string;
  heartbeatMs?: string;
};

/** `WorkerPollOptions` with every default applied and every value checked. */
export type ResolvedWorkerPollOptions = {
  port: string;
  apiKey?: string;
  environmentId?: string;
  environmentKey?: string;
  workerId: string;
  root: string;
  once: boolean;
  intervalMs: number;
  heartbeatMs: number;
};

/**
 * Validate the worker's options and resolve the defaults.
 *
 * Throws rather than coercing. A worker is a long-running process that executes
 * commands on someone's machine, so an option it cannot honour has to stop it at
 * startup, where the operator is still reading, instead of degrading into a loop
 * that runs wrong — and an unparseable interval degrades into the worst of them, a
 * loop with no delay at all.
 */
export function resolveWorkerPollOptions(opts: WorkerPollOptions): ResolvedWorkerPollOptions {
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value "${opts.port}". Expected an integer between 1 and 65535.`);
  }

  const intervalMs = Number(opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_POLL_INTERVAL_MS) {
    throw new Error(
      `Invalid --interval-ms value "${opts.intervalMs}". Expected a number of at least ${MIN_POLL_INTERVAL_MS}.`,
    );
  }

  const heartbeatMs = Number(opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < MIN_HEARTBEAT_MS) {
    throw new Error(
      `Invalid --heartbeat-ms value "${opts.heartbeatMs}". Expected a number of at least ${MIN_HEARTBEAT_MS}.`,
    );
  }

  return {
    port: String(port),
    apiKey: opts.apiKey,
    environmentId: opts.environmentId,
    environmentKey: opts.environmentKey,
    workerId: opts.workerId ?? `worker_${process.pid}`,
    root: resolve(opts.workdir),
    once: opts.once === true,
    intervalMs,
    heartbeatMs,
  };
}

type WorkerItem = {
  id: string;
  sessionId?: string;
  session_id?: string;
  kind: 'exec' | 'read' | 'write' | 'list';
  payload: Record<string, unknown>;
};

export async function workerPollCommand(opts: WorkerPollOptions) {
  const config = resolveWorkerPollOptions(opts);
  console.log(`Polling self-hosted work as ${config.workerId} in ${config.root}`);
  for (;;) {
    const item = await claimWorkItem(config);
    if (item) {
      // The claim is confirmed immediately before the item runs, because the lease window
      // can pass between the two and an item whose window passed is claimable again. A
      // refusal here is not a failure of the item: nothing has run, so nothing is reported
      // - completing it would assert an effect that never happened, and the queue would
      // record it as though the tool had executed.
      try {
        await acceptWorkItem(config, item.id);
      } catch (error) {
        console.warn(`not running ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
        if (config.once) return;
        await sleep(config.intervalMs);
        continue;
      }
      try {
        await completeWorkItem(config, item, {
          status: 'fulfilled',
          value: await renewWhileRunning(config, item.id, (signal) => executeWorkItem(item, config.root, signal)),
        });
      } catch (error) {
        await completeWorkItem(config, item, { status: 'rejected', reason: error });
      }
      console.log(`completed ${item.id}`);
    } else if (config.once) {
      console.log('no work');
      return;
    }
    if (config.once) return;
    await sleep(config.intervalMs);
  }
}

/**
 * Run one work item while renewing its claim on `heartbeatMs`.
 *
 * A failed renewal is best-effort: the heartbeat is logged and the item keeps running,
 * because a transport failure is only a *suspicion* that the claim lapsed, and stopping a
 * command halfway through on a suspicion would leave a half-applied side effect - the same
 * conservative rule the session file lease states, where a failed renewal may only make the
 * lease look stale later rather than make it immediately stealable.
 *
 * `work_lease_lost` is not a suspicion. The server has stated that the session ended and
 * stopped the work, so continuing would run a command nobody is waiting for, and the
 * renewal is the only channel that can carry that decision here. The run function is handed
 * a signal so the stop reaches the child process instead of being noticed after it exits.
 */
export async function renewWhileRunning<T>(
  opts: ResolvedWorkerPollOptions,
  itemId: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let leaseLost: WorkLeaseLostError | null = null;
  const timer = setInterval(() => {
    void renewClaim(opts, itemId).catch((error) => {
      if (error instanceof WorkLeaseLostError) {
        // Recorded rather than thrown: this callback has no caller to throw to, and the
        // reason has to outlive the run so the item is reported with it. The first
        // answer wins - a later renewal cannot un-stop the work.
        leaseLost ??= error;
        controller.abort();
        return;
      }
      console.warn(`renewal failed for ${itemId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, opts.heartbeatMs);
  // The renewal must never be the reason the process stays alive once the item is done.
  timer.unref?.();
  try {
    const value = await run(controller.signal);
    if (leaseLost) throw leaseLost;
    return value;
  } catch (error) {
    // The stop explains the symptom: a command killed by the abort exits non-zero, and
    // "the session ended" is the reason an operator needs, not the exit code it produced.
    if (leaseLost) throw leaseLost;
    throw error;
  } finally {
    clearInterval(timer);
  }
}

/**
 * The server refused a renewal because the work was stopped, not because this worker's
 * request was wrong. Distinct from every other renewal failure on purpose: the caller
 * aborts a running item for this error and for nothing else.
 */
export class WorkLeaseLostError extends Error {
  constructor(itemId: string) {
    super(`renewal refused for ${itemId}: the session that queued this work has ended (work_lease_lost)`);
    this.name = 'WorkLeaseLostError';
  }
}

/**
 * The server refused to confirm a claim at the moment of starting.
 *
 * Distinct from `WorkLeaseLostError`, which stops an item already running, because the
 * caller's response is different: nothing has started, so there is nothing to abort and
 * nothing to report. This class exists so that refusal cannot be mistaken for an item
 * failure and completed - a completion would tell the queue an effect happened.
 */
export class WorkAcceptRefusedError extends Error {
  readonly status: number;

  constructor(itemId: string, status: number, detail: string) {
    super(`claim not confirmed for ${itemId}: ${status} ${detail}`);
    this.name = 'WorkAcceptRefusedError';
    this.status = status;
  }
}

async function acceptWorkItem(opts: ResolvedWorkerPollOptions, itemId: string): Promise<void> {
  const res = await fetch(`http://localhost:${opts.port}/v1/x/worker/accept`, {
    method: 'POST',
    headers: jsonHeaders(opts),
    body: JSON.stringify({ id: itemId, worker_id: opts.workerId }),
  });
  if (res.ok) return;
  throw new WorkAcceptRefusedError(itemId, res.status, await res.text());
}

async function renewClaim(opts: ResolvedWorkerPollOptions, itemId: string): Promise<void> {
  const res = await fetch(`http://localhost:${opts.port}/v1/x/worker/heartbeat`, {
    method: 'POST',
    headers: jsonHeaders(opts),
    body: JSON.stringify({ id: itemId, worker_id: opts.workerId }),
  });
  if (res.ok) return;
  const body = await res.text();
  // The code is what a caller decides on; the message only explains it. Matching on the
  // status alone would treat "this item is not yours" as a stop, and that refusal means the
  // work is alive for its holder.
  if (res.status === 409 && stoppedWorkCode(body)) throw new WorkLeaseLostError(itemId);
  throw new Error(`worker heartbeat failed: ${res.status} ${body}`);
}

function stoppedWorkCode(body: string): boolean {
  try {
    return (JSON.parse(body) as { error?: { code?: unknown } })?.error?.code === 'work_lease_lost';
  } catch {
    return false;
  }
}

export async function executeWorkItem(item: WorkerItem, root: string, signal?: AbortSignal): Promise<unknown> {
  if (item.kind === 'read') {
    return readFile(safePath(root, stringPayload(item.payload.path, 'path')), 'utf8');
  }
  if (item.kind === 'write') {
    const target = safePath(root, stringPayload(item.payload.path, 'path'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, String(item.payload.content ?? ''), 'utf8');
    return { ok: true };
  }
  if (item.kind === 'list') {
    return readdir(safePath(root, stringPayload(item.payload.path ?? '.', 'path')));
  }
  if (item.kind === 'exec') {
    return execShell(String(item.payload.command ?? ''), {
      cwd: item.payload.cwd ? safePath(root, String(item.payload.cwd)) : root,
      timeoutMs: typeof item.payload.timeout === 'number' ? item.payload.timeout : 300_000,
      env: objectOfStrings(item.payload.env),
      // Only the long-running kind is abortable. The file kinds are bounded operations, and
      // an interrupted `write` is a partial side effect where a completed one is not: the
      // stop is about not starting or continuing work, not about leaving a file half written.
      signal,
    });
  }
  throw new Error(`Unsupported work item kind: ${item.kind}`);
}

async function claimWorkItem(opts: ResolvedWorkerPollOptions): Promise<WorkerItem | null> {
  const res = await fetch(`http://localhost:${opts.port}/v1/x/worker/claim`, {
    method: 'POST',
    headers: jsonHeaders(opts),
    body: JSON.stringify({
      worker_id: opts.workerId,
      environment_id: opts.environmentId,
      environment_key: opts.environmentKey ?? process.env.MANAGED_AGENTS_ENVIRONMENT_KEY,
    }),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`worker claim failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<WorkerItem>;
}

async function completeWorkItem(
  opts: ResolvedWorkerPollOptions,
  item: WorkerItem,
  resultOrError: PromiseSettledResult<unknown>,
) {
  // `worker_id` is required by the route and is what the row is matched on, so it
  // has to be the same identity `claim` sent. Omitting it answered
  // `400 id and worker_id are required` after the work had already been executed,
  // leaving the row `claimed` with its side effect applied.
  const body = resultOrError.status === 'fulfilled'
    ? { id: item.id, worker_id: opts.workerId, result: resultOrError.value }
    : { id: item.id, worker_id: opts.workerId, result: { message: resultOrError.reason instanceof Error ? resultOrError.reason.message : String(resultOrError.reason) }, failed: true };
  const res = await fetch(`http://localhost:${opts.port}/v1/x/worker/complete`, {
    method: 'POST',
    headers: jsonHeaders(opts),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`worker complete failed: ${res.status} ${await res.text()}`);
}

async function execShell(command: string, opts: { cwd: string; timeoutMs: number; env: Record<string, string>; signal?: AbortSignal }) {
  if (!command.trim()) throw new Error('exec work item requires command');
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-lc', command], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      env: { ...process.env, ...opts.env },
      // Node kills the child when the signal aborts, so the stop reaches the command
      // rather than only the promise waiting on it.
      signal: opts.signal,
    }, (error, stdout, stderr) => {
      resolve({
        exitCode: typeof (error as { code?: unknown } | null)?.code === 'number' ? (error as { code: number }).code : 0,
        stdout,
        stderr,
        timedOut: Boolean((error as { killed?: boolean } | null)?.killed),
        // Reported separately from `timedOut`: an operator reading the queue should be able
        // to tell a command that ran out of its own time from one the runtime stopped.
        aborted: (error as { name?: string } | null)?.name === 'AbortError',
      });
    });
  });
}

function safePath(root: string, value: string): string {
  const target = resolve(root, isAbsolute(value) ? `.${value}` : value);
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return target;
  throw new Error(`Path escapes worker root: ${value}`);
}

function stringPayload(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error(`${name} is required`);
}

function objectOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, String(val)]));
}

function jsonHeaders(opts: ResolvedWorkerPollOptions): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
