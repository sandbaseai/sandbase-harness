/**
 * Self-hosted environment worker: the machine-side half of the work queue.
 *
 * A worker claims work items from `POST /v1/x/worker/claim`, executes them inside
 * `--workdir`, and reports each result to `POST /v1/x/worker/complete`. The server
 * never runs them — this process does.
 *
 * Ten invariants this file has to hold, none of which it held before:
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
 * 6. The acceptance is **bounded**. A server that takes the connection and never answers
 *    used to park this process on that `await` forever: it ran nothing, reported nothing,
 *    and never polled again while holding a claim it could no longer renew. A bound turns a
 *    silent hang into a machine-readable failure, and the worker then behaves exactly as it
 *    does for a refusal - it runs nothing, reports nothing, and keeps polling.
 * 7. A refused **completion** is not a failed item, and does not end the worker. The
 *    outcome of the work and the delivery of that outcome are two different facts, and the
 *    single `catch` that used to wrap both reported the second as the first: a completion
 *    the server refused was answered by reporting the item again with `failed: true`, so
 *    work that had succeeded was recorded as failed. When the refusal was `409` - the
 *    expected answer once the lease lapsed and the queue moved the item to `unknown` - the
 *    second request was refused too, nothing caught it, and the refusal escaped the poll
 *    loop and terminated the process. The delivery now has its own `catch` and its own
 *    type, and neither re-runs the item nor re-reports it.
 * 8. The **renewal is bounded** too, and its bound makes a failure visible rather than
 *    changing what the worker does about it. The renewal is issued from a `setInterval`, so an
 *    unanswered request did not park the worker once - it parked it again on **every tick**,
 *    and no tick ever reached the warning, because a promise that never settles never reaches
 *    a `.catch`. The only symptom was indirect and arrived late: the claim lapsed, the queue
 *    moved the healthy worker's item to `unknown`, and its real result was refused as a late
 *    write. With a bound the failure is reported as `work_heartbeat_unconfirmed` and the item
 *    **keeps running**, because a timeout is still only a suspicion - `work_lease_lost` remains
 *    the one renewal answer that aborts an item.
 * 9. The **claim cannot stop the worker**, in either direction. It is the first request of
 *    every iteration and the only one that was still issued once with no handling, so an
 *    unanswered claim was a silent total stall - no item, no report, no retry, and no message,
 *    because there is no timer here and nothing to notice but an idle process - while a claim
 *    that *failed* was caught by nothing at all and rejected the whole command, so a runtime
 *    that blinked killed every worker pointed at it. The bound (`work_claim_unconfirmed`) and
 *    the `catch` are one behaviour, not two: an item is run only when the claim produced one,
 *    and a claim that produced none - refused, failed, or never answered - leaves the worker
 *    polling. A bound without the `catch` would have traded the stall for a crash, because the
 *    timeout it raises would have taken the same uncaught path.
 * 10. The **completion is bounded** as well, so no request in the loop is left unbounded, and
 *    its bound needed a **new diagnosis** rather than the old one applied later. The bound
 *    itself changes no control flow, because #657 / #658 already put the delivery in its own
 *    `try`/`catch` with its own type - but `work_completion_undelivered` uses `status: null`
 *    to say "this never reached the runtime", and that is false for a timeout: a request that
 *    timed out may have arrived and been applied, in which case the row already says `applied`
 *    and only this process does not know. So an unanswered completion reports
 *    `work_completion_unconfirmed` and says that the outcome may already be recorded. What it
 *    must never do is retry: the first request may already have taken effect, and the queue
 *    refuses a late write to an item it has moved on - which makes a retry pointless rather
 *    than merely redundant.
 */

import { execFile, spawn } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { extractSkillZipEntries } from '@/core/skills/skill-zip.js';

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

/**
 * How long the worker waits for its claim to be confirmed before giving up on it.
 *
 * Well below the 60s default lease window, so a bound that expires leaves the item's claim
 * still the worker's own: the worker can then walk away from it and let the lease lapse on
 * its own terms rather than racing the queue for work the queue is about to hand to someone
 * else. There is no minimum worth enforcing here beyond "a real number" - the bound is a
 * local diagnosis window over a localhost request, not a protocol parameter, and a value
 * this small is only ever chosen deliberately in a test.
 */
const MIN_ACK_TIMEOUT_MS = 1;

const DEFAULT_ACK_TIMEOUT_MS = 10_000;

/**
 * How long the worker waits for the claim itself to be answered.
 *
 * This is the bound on the *first* request of every iteration, and it is the one whose
 * absence was least visible: unlike the renewal, which is issued from a timer and therefore
 * piles up one silent request per tick, the claim is issued once from the loop. An
 * unanswered claim was a **silent total stall** - no timeout, no second request, no growing
 * pile, and nothing to notice but an idle process that never polls again.
 *
 * The same value rule as the acknowledgement bound, and for the same reason: well below the
 * 60s lease window, so an expired bound leaves the claim's row still this worker's own. That
 * matters more here, because a claim whose *response* was lost may still have created the
 * row. Walking away is safe rather than lossless - the item is stranded until the window
 * lapses - and it is safe precisely because the row's `accepted_at` is still null, so it
 * stays `queued` and the sweep re-hands it. Abandoning the claim is the "unaccepted intent
 * stays reclaimable" property, not a leak.
 */
const MIN_CLAIM_TIMEOUT_MS = 1;

const DEFAULT_CLAIM_TIMEOUT_MS = 10_000;

/**
 * How long the worker waits for a renewal of its claim to be answered.
 *
 * Half the default `--heartbeat-ms`, so a renewal that is not going to be answered stops
 * being in flight before the next tick is due. That relationship is the point of having a
 * bound at all here: the renewal is issued from a `setInterval`, and an unbounded request
 * does not park the worker once - **it parks it again on every tick**, silently, because a
 * promise that never settles never reaches the `.catch` that would have warned. The
 * diagnosis then arrives only indirectly, as a claim that quietly lapsed and an item the
 * queue moved to `unknown` while the worker was healthy.
 *
 * It is not enforced as a relationship between the two options, only stated as the default:
 * a test that wants a slow renewal against a fast tick sets both deliberately, and refusing
 * that combination would make the defect this option exists to expose untestable. The bound
 * is a local diagnosis window over a localhost request, not a protocol parameter.
 */
const MIN_HEARTBEAT_TIMEOUT_MS = 1;

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * How long the worker waits for the outcome to be recorded before calling it unconfirmed.
 *
 * The last request in the loop to get a bound, and the only one that needed a **new
 * diagnosis** rather than the same one applied later. This call is already inside its own
 * `try`/`catch` with its own type, so the bound changes no control flow at all - which is
 * what #657 / #658 bought by separating the outcome from its delivery. What it could not buy
 * is the meaning: `WorkCompletionUndeliveredError` uses `status: null` to say "the request
 * never reached the runtime", and that is **false for a timeout**. A request that timed out
 * may have arrived and been applied, so an operator reading "did not reach the runtime" would
 * be told the opposite of what is possible - and the two imply different follow-up, because
 * only the second one means the row may already be `applied` while this process does not know.
 */
const MIN_COMPLETE_TIMEOUT_MS = 1;

const DEFAULT_COMPLETE_TIMEOUT_MS = 10_000;

export type WorkerPollOptions = {
  port: string;
  apiKey?: string;
  environmentId?: string;
  environmentKey?: string;
  workerId?: string;
  workdir: string;
  tools?: string;
  once?: boolean;
  onWork?: string;
  intervalMs?: string;
  heartbeatMs?: string;
  heartbeatTimeoutMs?: string;
  claimTimeoutMs?: string;
  completeTimeoutMs?: string;
  ackTimeoutMs?: string;
};

/** `WorkerPollOptions` with every default applied and every value checked. */
export type ResolvedWorkerPollOptions = {
  port: string;
  /** The runtime address the worker's own requests go to, derived from `port`. */
  baseUrl: string;
  apiKey?: string;
  environmentId?: string;
  environmentKey?: string;
  workerId: string;
  root: string;
  toolsPath?: string;
  once: boolean;
  /**
   * The `--on-work` spawn command: when set, a claimed item is handed to this
   * process instead of executed in-process. See `runWorkHandler` for the
   * contract.
   */
  onWork?: string;
  /**
   * Scopes claims to a single session — set by `worker run`, the in-sandbox
   * counterpart a spawn handler launches, so one sandbox serves one session.
   */
  sessionId?: string;
  intervalMs: number;
  heartbeatMs: number;
  heartbeatTimeoutMs: number;
  claimTimeoutMs: number;
  completeTimeoutMs: number;
  ackTimeoutMs: number;
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

  const heartbeatTimeoutMs = Number(opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS);
  if (!Number.isFinite(heartbeatTimeoutMs) || heartbeatTimeoutMs < MIN_HEARTBEAT_TIMEOUT_MS) {
    throw new Error(
      `Invalid --heartbeat-timeout-ms value "${opts.heartbeatTimeoutMs}". Expected a number of at least ${MIN_HEARTBEAT_TIMEOUT_MS}.`,
    );
  }

  const claimTimeoutMs = Number(opts.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS);
  if (!Number.isFinite(claimTimeoutMs) || claimTimeoutMs < MIN_CLAIM_TIMEOUT_MS) {
    throw new Error(
      `Invalid --claim-timeout-ms value "${opts.claimTimeoutMs}". Expected a number of at least ${MIN_CLAIM_TIMEOUT_MS}.`,
    );
  }

  const completeTimeoutMs = Number(opts.completeTimeoutMs ?? DEFAULT_COMPLETE_TIMEOUT_MS);
  if (!Number.isFinite(completeTimeoutMs) || completeTimeoutMs < MIN_COMPLETE_TIMEOUT_MS) {
    throw new Error(
      `Invalid --complete-timeout-ms value "${opts.completeTimeoutMs}". Expected a number of at least ${MIN_COMPLETE_TIMEOUT_MS}.`,
    );
  }

  const ackTimeoutMs = Number(opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS);
  if (!Number.isFinite(ackTimeoutMs) || ackTimeoutMs < MIN_ACK_TIMEOUT_MS) {
    throw new Error(
      `Invalid --ack-timeout-ms value "${opts.ackTimeoutMs}". Expected a number of at least ${MIN_ACK_TIMEOUT_MS}.`,
    );
  }

  return {
    port: String(port),
    baseUrl: `http://localhost:${port}`,
    apiKey: opts.apiKey,
    environmentId: opts.environmentId,
    environmentKey: opts.environmentKey,
    workerId: opts.workerId ?? `worker_${process.pid}`,
    root: resolve(opts.workdir),
    toolsPath: opts.tools ? resolve(opts.tools) : undefined,
    once: opts.once === true,
    onWork: opts.onWork,
    intervalMs,
    heartbeatMs,
    heartbeatTimeoutMs,
    claimTimeoutMs,
    completeTimeoutMs,
    ackTimeoutMs,
  };
}

type WorkerItem = {
  id: string;
  sessionId?: string;
  session_id?: string;
  kind: 'exec' | 'read' | 'write' | 'list' | 'custom_tool';
  payload: Record<string, unknown>;
  /**
   * The per-claim session credential, minted by the claim route in the
   * published `BetaWorkSecret` shape (base64url `{sessions_token, api_base_url}`).
   * An `--on-work` handler forwards it into the spawned sandbox as
   * `MANAGED_AGENTS_WORK_SECRET`; an in-process worker never needs it.
   */
  secret?: string | null;
};

/**
 * A worker-declared custom tool: the handler is invoked with the call's
 * `input` and reports its outcome as the tool's result content. A string is a
 * text block, `{content: [...]}` is the block list verbatim (with an optional
 * `is_error` flag), and any other value is folded into a JSON text block.
 * Throwing marks the result `is_error` - that is the tool's own answer, which
 * is why it is recorded `applied` rather than `failed`: `failed` is reserved
 * for work the worker could not perform at all.
 */
export type WorkerCustomToolHandler = (
  input: unknown,
  context: { toolUseId: string; signal?: AbortSignal },
) => unknown | Promise<unknown>;

export type WorkerCustomTools = Record<string, WorkerCustomToolHandler>;

/**
 * Load the `--tools` module: the worker's declared custom tools, keyed by tool
 * name. The module's default export is the map; a named `tools` export is
 * accepted as the alternative spelling. Every value must be a handler - a
 * module that names a tool it does not implement is refused at startup, where
 * the operator is still reading, rather than mid-session where a call would
 * answer "not declared" for a tool that was meant to exist.
 */
export async function loadWorkerTools(toolsPath: string | undefined): Promise<WorkerCustomTools> {
  if (!toolsPath) return {};
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(toolsPath).href)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Could not load --tools module "${toolsPath}": ${error instanceof Error ? error.message : String(error)}`);
  }
  const table = (isRecord(mod.default) ? mod.default : isRecord(mod.tools) ? mod.tools : undefined) as Record<string, unknown> | undefined;
  if (!table) {
    throw new Error(`Invalid --tools module "${toolsPath}": expected a default export of the form { tool_name: handler }`);
  }
  const tools: WorkerCustomTools = {};
  for (const [name, handler] of Object.entries(table)) {
    if (typeof handler !== 'function') {
      throw new Error(`Invalid --tools module "${toolsPath}": "${name}" is not a function`);
    }
    tools[name] = handler as WorkerCustomToolHandler;
  }
  return tools;
}

export async function workerPollCommand(opts: WorkerPollOptions) {
  const config = resolveWorkerPollOptions(opts);
  const customTools = await loadWorkerTools(config.toolsPath);
  // Skill packages materialize once per session per worker process — a
  // poll-mode worker may serve many sessions through one workdir.
  const materializedSessions = new Set<string>();
  console.log(`Polling self-hosted work as ${config.workerId} in ${config.root}`);
  for (;;) {
    // The claim is the one step that can stop the worker on its own, and until this was
    // wrapped it did - in both directions at once. Unbounded, an unanswered claim parked the
    // process for ever: no item, no report, no second request, and no message, because there
    // is no timer here to keep trying and nothing to notice but an idle process. Uncaught, a
    // claim that *failed* was worse: the error escaped the loop and rejected this command, so
    // a runtime that blinked killed every worker pointed at it.
    //
    // The two are one behaviour, which is why they are fixed together - **an item is run only
    // when the claim produced one, and a claim that produced none leaves the worker polling.**
    // A bound alone would have been a regression: the timeout it raises would have taken the
    // same uncaught path and turned a stall into a crash.
    let item: WorkerItem | null;
    try {
      item = await claimWorkItem(config);
    } catch (error) {
      console.warn(`could not claim work: ${error instanceof Error ? error.message : String(error)}`);
      if (config.once) return;
      await sleep(config.intervalMs);
      continue;
    }
    if (item && config.onWork) {
      // `--on-work` hands the whole item lifecycle to the spawned command: this
      // process never accepts, executes, or completes it — the handler does, which
      // is what makes a fresh sandbox per claim work (the claim identity is
      // forwarded, so the sandbox's worker accepts the claim as this worker). A
      // spawn that fails leaves the item claimed-but-unaccepted, and its lease
      // lapse hands it back to the queue rather than reporting a run that never
      // happened.
      const code = await runWorkHandler(config.onWork, item, config);
      if (code !== 0) {
        console.warn(`--on-work handler exited with code ${code} for ${item.id}; the item was left for the queue to reclaim`);
      }
      if (config.once) return;
      await sleep(config.intervalMs);
      continue;
    }
    if (item) {
      // The claim is confirmed immediately before the item runs, because the lease window
      // can pass between the two and an item whose window passed is claimable again. A
      // refusal here is not a failure of the item: nothing has run, so nothing is reported
      // - completing it would assert an effect that never happened, and the queue would
      // record it as though the tool had executed.
      //
      // A confirmation that never arrives is treated identically, and for the same reason:
      // the worker cannot prove it still holds the claim, so running the item is the one
      // thing it must not do. The difference is the message, which is what tells an operator
      // whether the server refused or went quiet.
      try {
        await acceptWorkItem(config, item.id);
      } catch (error) {
        console.warn(`not running ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
        if (config.once) return;
        await sleep(config.intervalMs);
        continue;
      }
      // The run and the report are separated deliberately, because they fail for unrelated
      // reasons and the single `try` that used to wrap both could not tell them apart. Its
      // `catch` existed to report a failed command, but it also caught a completion the
      // server had **refused**, and answered that by reporting the same item a second time
      // with `failed: true`. Two things followed. Work that had succeeded was recorded as
      // failed whenever the first delivery was refused, carrying the transport error as the
      // result. And when the refusal was `409` - the expected answer for an item whose
      // outcome can no longer be recorded, because its lease lapsed and the queue moved it
      // to `unknown` - the second request was refused as well and nothing caught it, so the
      // refusal escaped this loop and rejected `workerPollCommand`. One late completion took
      // the entire worker process down, and the operator saw a crash instead of a refusal.
      let outcome: PromiseSettledResult<unknown>;
      try {
        outcome = {
          status: 'fulfilled',
          value: await renewWhileRunning(config, item.id, async (signal) => {
            // The session's skill packages land under `<root>/skills/<name>/`
            // the first time a session's work runs here — inside the heartbeat
            // window so a slow download never lapses the lease.
            await ensureSessionSkills(config, item, materializedSessions);
            return executeWorkItem(item, config.root, signal, customTools);
          }),
        };
      } catch (error) {
        outcome = { status: 'rejected', reason: error };
      }
      // Delivering that outcome is a fact about **this process**, not about the work, and a
      // delivery that does not happen is reported as exactly that. The item is never re-run
      // and never re-reported, and the loop continues rather than ending: the queue already
      // holds the truth, because an item whose outcome was not delivered keeps its lease and
      // becomes `unknown` when the lease lapses - which is the record that says "accepted,
      // outcome unknown, never replay" rather than a claim that the work failed.
      //
      // The failure path is unaffected and still reports `failed: true` with the item's own
      // error: that outcome is a rejected `PromiseSettledResult`, and the refusal to deliver
      // it is a separate `catch` that no longer shares a body with it.
      try {
        await completeWorkItem(config, item, outcome);
        // Logged only once the queue has accepted the report, because the line asserts the
        // outcome is recorded rather than that the command returned.
        if (outcome.status === 'fulfilled') console.log(`completed ${item.id}`);
      } catch (error) {
        console.warn(`could not report ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
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
 * Every renewal is individually bounded by `heartbeatTimeoutMs`, which is what makes a
 * renewal the runtime never answers a **logged** failure instead of an invisible one. The
 * bound does not change the rule above: an expired bound is the same kind of suspicion as a
 * transport error, so it warns and the item keeps running. What it removes is the case where
 * the suspicion was never formed at all - an unbounded request issued from this interval
 * never settled, so it reached neither the `work_lease_lost` branch nor the warning below,
 * and the first thing an operator saw was an item the queue had moved to `unknown`.
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

/**
 * The outcome of an item could not be delivered to the queue.
 *
 * This says nothing about the work. The item ran and produced a result, or it ran and
 * failed - either way the *outcome is a fact*, and this class records only that the process
 * holding that fact could not hand it over. Conflating the two is the defect it exists to
 * remove: the caller used to report a refused delivery as a failed item, which is a claim
 * about the work that the refusal does not support.
 *
 * **It covers both ways of not being delivered, on purpose, and reports which happened.**
 * A refusal means the server answered and said no - `409` for an item whose outcome can no
 * longer be recorded, which is expected rather than exotic. A transport failure means no
 * answer arrived at all. They need different diagnoses, so the status is carried as a field
 * and rendered into the message, and `status === null` is what distinguishes "not reached"
 * from "reached and refused".
 *
 * Like `WorkAcceptUnconfirmedError`, the code is a **class property rather than an exported
 * `_CODE` constant**, so it stays out of `tests/fixtures/error-codes.json` and the public
 * taxonomy: this is a worker-local string and registering it would claim a wire contract
 * that does not exist. The code is repeated inside the message because the warning line is
 * the only channel a supervisor sees.
 */
export class WorkCompletionUndeliveredError extends Error {
  readonly code = 'work_completion_undelivered';
  readonly status: number | null;

  constructor(itemId: string, status: number | null, detail: string) {
    super(
      `outcome not delivered for ${itemId}: work_completion_undelivered - ` +
        (status === null
          ? `the request did not reach the runtime (${detail}), so the item's outcome is unrecorded`
          : `the runtime refused it with ${status} ${detail}, so the item's outcome is unrecorded`),
    );
    this.name = 'WorkCompletionUndeliveredError';
    this.status = status;
  }
}

/**
 * A renewal of this worker's claim was not answered inside the bound.
 *
 * **This is a suspicion, not a refusal, and the caller must act on it accordingly.** The
 * runtime may be busy, paused, or unreachable; nothing has said the claim is gone. A renewal
 * failure has always been best-effort - the item keeps running - because stopping a command
 * halfway through on a suspicion leaves a half-applied side effect, which is the same
 * conservative rule the session file lease states. This class exists so that the *failure
 * becomes visible* rather than changing what the worker does about it: before the bound,
 * this case produced no warning at all, and the first symptom was an item the queue had
 * moved to `unknown` while the worker was perfectly healthy.
 *
 * Deliberately distinct from `WorkLeaseLostError`, which *is* a decision - the server has
 * stated that the session ended and stopped the work - and is the only renewal failure that
 * aborts a running item. Conflating them would abort commands on a timeout.
 *
 * Like the other worker-local codes, this is a class property rather than an exported `_CODE`
 * constant, so it stays out of `tests/fixtures/error-codes.json`: nothing on the wire emits
 * it. The code is repeated inside the message because the warning line is the only channel a
 * supervisor sees.
 */
export class WorkHeartbeatUnconfirmedError extends Error {
  readonly code = 'work_heartbeat_unconfirmed';
  readonly timeoutMs: number;

  constructor(itemId: string, timeoutMs: number) {
    super(
      `renewal unconfirmed for ${itemId}: work_heartbeat_unconfirmed - no answer within ${timeoutMs}ms, ` +
        'so the claim is on course to lapse; the item keeps running because a timeout is not a stop',
    );
    this.name = 'WorkHeartbeatUnconfirmedError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The outcome was sent but not answered inside the bound, so whether it was recorded is
 * **unknown** - and that is a different fact from a request that never arrived.
 *
 * `WorkCompletionUndeliveredError` with `status: null` asserts the request did not reach the
 * runtime. That is true for a refused connection and **false here**: a request that timed out
 * may have arrived and been applied, in which case the row already says `applied` and only
 * this process does not know it. Collapsing the two would tell an operator the outcome is
 * definitively unrecorded at the exact moment the opposite is possible, and the follow-up
 * differs - one is "nothing to see", the other is "check the row before assuming anything".
 *
 * What does **not** differ is the action, and that is why the message says it out loud: the
 * item is not re-reported and not re-run. A retry is the one thing that must not happen,
 * because the first request may already have been applied, and because the queue refuses a
 * late write to an item it has already moved on - which is what makes the retry pointless
 * rather than merely redundant.
 *
 * Declared as a class property rather than an exported `_CODE` constant, so it stays out of
 * `tests/fixtures/error-codes.json`: no route emits it. The code is repeated inside the
 * message because the warning line is the only channel a supervisor sees.
 */
export class WorkCompletionUnconfirmedError extends Error {
  readonly code = 'work_completion_unconfirmed';
  readonly timeoutMs: number;

  constructor(itemId: string, timeoutMs: number) {
    super(
      `outcome unconfirmed for ${itemId}: work_completion_unconfirmed - no answer within ${timeoutMs}ms, ` +
        'so it may already have been recorded; the item is not reported again and not re-run',
    );
    this.name = 'WorkCompletionUnconfirmedError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The claim was not answered inside the bound, so this iteration produced no item.
 *
 * A claim that fails and a claim that says nothing differ in one way that matters to an
 * operator: the first says the runtime is not there, the second that it is there and is not
 * serving this queue. Both leave the worker polling - that is the behaviour, and it is the
 * only sensible one, because the alternative is a process that either parks for ever or
 * exits on a blip.
 *
 * **The limit of that safety is worth stating where it is decided rather than only in docs.**
 * A claim whose response was lost may still have created the row on the server, and this
 * worker will never see the item it just caused. That is safe but not lossless: the item is
 * stranded until its lease lapses. It is not lost, because the row's `accepted_at` is still
 * null - it stays `queued` and the sweep re-hands it, which is the "unaccepted intent stays
 * reclaimable" property from the frozen worker-protocol spec doing exactly its job. Trying to
 * undo the claim instead would need a release route that does not exist and a race against
 * the sweep that this side cannot win.
 *
 * Like the other worker-local codes, this is a class property rather than an exported `_CODE`
 * constant, so it stays out of `tests/fixtures/error-codes.json`: nothing on the wire emits
 * it. The code is repeated inside the message because the warning line is the only channel a
 * supervisor sees.
 */
export class WorkClaimUnconfirmedError extends Error {
  readonly code = 'work_claim_unconfirmed';
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `claim unconfirmed: work_claim_unconfirmed - no answer within ${timeoutMs}ms, ` +
        'so this iteration produced no item; the worker polls again',
    );
    this.name = 'WorkClaimUnconfirmedError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The claim was never confirmed because no answer arrived inside the bound.
 *
 * Deliberately a **different type** from `WorkAcceptRefusedError`, and the reason is
 * diagnosis rather than control flow: both mean "do not run this item and do not report
 * one", but the server refusing and the server saying nothing are different faults with
 * different fixes - one is a lease that lapsed or a session that ended, the other is a
 * runtime that is unreachable, overloaded, or dead. A single error type would collapse the
 * two into one message at exactly the moment an operator needs to tell them apart.
 *
 * `code` is the machine-readable half, in the shape the rest of this runtime uses, so a
 * supervisor can match on it instead of parsing prose. It is a worker-side diagnosis and
 * not a public API error code: no route emits it, and nothing outside this process has to
 * agree on it.
 *
 * **The declaration shape is deliberate.** It is a class property, not a `code: '<lit>'`
 * helper argument and not a `_CODE = '<lit>'` constant, which are the two shapes
 * `tests/unit/error-code-inventory.test.ts` scans for - so this value stays out of the
 * public error inventory on purpose. It must not be added there: that fixture feeds the
 * coverage check and the published taxonomy, and a worker-local string in it would claim a
 * wire contract that does not exist. Declaring it as an exported `_CODE` constant would
 * silently enrol it, so this is not a style preference.
 *
 * The code is repeated inside the **message** as well as exposed as a field, and that is
 * not redundancy. The only channel a supervisor sees is the warning line the polling loop
 * prints, which renders `error.message` and nothing else - so a field that never reached
 * that line would be a machine-readable reason that no machine can read. Writing it into
 * the message is what makes the claim true.
 */
export class WorkAcceptUnconfirmedError extends Error {
  readonly code = 'work_accept_unconfirmed';
  readonly timeoutMs: number;

  constructor(itemId: string, timeoutMs: number) {
    super(
      `claim not confirmed for ${itemId}: work_accept_unconfirmed - no answer within ${timeoutMs}ms, so the item was not run and no result was reported`,
    );
    this.name = 'WorkAcceptUnconfirmedError';
    this.timeoutMs = timeoutMs;
  }
}

async function acceptWorkItem(opts: ResolvedWorkerPollOptions, itemId: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${opts.baseUrl}/v1/x/worker/accept`, {
      method: 'POST',
      headers: jsonHeaders(opts),
      body: JSON.stringify({ id: itemId, worker_id: opts.workerId }),
      // Unbounded was the defect: a server that accepted the connection and never answered
      // parked this process forever, running nothing, reporting nothing, and never polling
      // again while holding a claim it could no longer renew.
      signal: AbortSignal.timeout(opts.ackTimeoutMs),
    });
  } catch (error) {
    // Aborting is the bound expiring, and it has to be told apart from every other transport
    // failure, because only this one is *expected*: a refused connection means the runtime
    // is not there, while a timeout means it is there and not answering.
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new WorkAcceptUnconfirmedError(itemId, opts.ackTimeoutMs);
    }
    throw error;
  }
  if (res.ok) return;
  throw new WorkAcceptRefusedError(itemId, res.status, await res.text());
}

async function renewClaim(opts: ResolvedWorkerPollOptions, itemId: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${opts.baseUrl}/v1/x/worker/heartbeat`, {
      method: 'POST',
      headers: jsonHeaders(opts),
      body: JSON.stringify({ id: itemId, worker_id: opts.workerId }),
      // Unbounded was the defect, and here it was worse than a single hang: this call is
      // issued from a `setInterval`, so a request that never settled did not park the worker
      // once but again on every tick, and it reached the warning below on no tick at all. The
      // bound is what makes a renewal that is not going to be answered an *observable*
      // failure instead of a growing pile of silent ones.
      signal: AbortSignal.timeout(opts.heartbeatTimeoutMs),
    });
  } catch (error) {
    // A bound that expires is reported as its own thing rather than as a generic transport
    // error, because the two call for different reading: a refused connection says the
    // runtime is not there, while a timeout says it is there and is not renewing - and only
    // the second one means the claim is on course to lapse while this worker is healthy.
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new WorkHeartbeatUnconfirmedError(itemId, opts.heartbeatTimeoutMs);
    }
    throw error;
  }
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

export async function executeWorkItem(
  item: WorkerItem,
  root: string,
  signal?: AbortSignal,
  customTools?: WorkerCustomTools,
): Promise<unknown> {
  if (item.kind === 'custom_tool') {
    return executeCustomToolWorkItem(item, customTools ?? {}, signal);
  }
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

/**
 * Run a `custom_tool` item against the worker's declared tools.
 *
 * The result is always the tool's answer rather than a thrown failure, for the
 * same reason the file kinds return their data rather than throwing: the queue
 * records `applied` when the worker did the work it was handed, and the
 * outcome — success, a thrown error, an undeclared name — belongs to the
 * session as the `user.custom_tool_result` the parked call resolves on. A
 * call for a tool this worker does not declare gets the answer it is owed
 * anyway, so the session does not hang on a misconfigured deployment.
 */
async function executeCustomToolWorkItem(
  item: WorkerItem,
  tools: WorkerCustomTools,
  signal?: AbortSignal,
): Promise<unknown> {
  const name = stringPayload(item.payload.tool_name, 'tool_name');
  const toolUseId = stringPayload(item.payload.tool_use_id, 'tool_use_id');
  const handler = tools[name];
  if (typeof handler !== 'function') {
    return {
      is_error: true,
      content: [{ type: 'text', text: `Custom tool "${name}" is not declared by this worker.` }],
    };
  }
  try {
    const value = await handler(item.payload.input, { toolUseId, signal });
    return toToolResultPayload(value);
  } catch (error) {
    return {
      is_error: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    };
  }
}

/**
 * Normalize whatever a handler returned into the `{content, is_error?}` shape
 * the session-side result event expects. A handler may return a raw block
 * list through `{content: [...]}` — blocks that fail the session's own
 * validation are refused there, the same as a caller's — so this only gives
 * the common shapes a canonical form.
 */
function toToolResultPayload(value: unknown): { content: unknown[]; is_error?: boolean } {
  if (typeof value === 'string') {
    return { content: [{ type: 'text', text: value }] };
  }
  if (isRecord(value) && Array.isArray(value.content) && value.content.every((block) => isRecord(block))) {
    return value.is_error === true
      ? { content: value.content, is_error: true }
      : { content: value.content };
  }
  return { content: [{ type: 'text', text: JSON.stringify(value ?? null) }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function claimWorkItem(opts: ResolvedWorkerPollOptions): Promise<WorkerItem | null> {
  let res: Response;
  try {
    res = await fetch(`${opts.baseUrl}/v1/x/worker/claim`, {
      method: 'POST',
      headers: jsonHeaders(opts),
      body: JSON.stringify({
        worker_id: opts.workerId,
        session_id: opts.sessionId,
        environment_id: opts.environmentId,
        environment_key: opts.environmentKey ?? process.env.MANAGED_AGENTS_ENVIRONMENT_KEY,
      }),
      // The first request of every iteration used to be the one that could park the worker
      // for ever: issued once from the loop, so there was not even a pile of silent retries
      // to notice.
      signal: AbortSignal.timeout(opts.claimTimeoutMs),
    });
  } catch (error) {
    // A bound that expires is named as its own thing, because "the runtime did not answer"
    // and "the runtime is not there" are different faults: the first means it is up and not
    // serving this queue, the second that the port is closed. Both leave the worker polling.
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new WorkClaimUnconfirmedError(opts.claimTimeoutMs);
    }
    throw error;
  }
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
  // Both ways of not delivering raise the same type so the caller has one thing to catch,
  // and the status tells the two apart - `null` means the request never reached the
  // runtime. Throwing a bare `Error` here is what let the caller read "the report failed"
  // as "the work failed", because there was no type to decide on and the message was the
  // only clue.
  let res: Response;
  try {
    res = await fetch(`${opts.baseUrl}/v1/x/worker/complete`, {
      method: 'POST',
      headers: jsonHeaders(opts),
      body: JSON.stringify(body),
      // The last unbounded request in the loop. Nothing is lost while it hangs - the item
      // keeps its lease - but the worker stops polling, so one unanswered completion stops
      // every later item from being claimed at all.
      signal: AbortSignal.timeout(opts.completeTimeoutMs),
    });
  } catch (error) {
    // A timeout is **not** the same fact as a request that never arrived, and this is the one
    // place in the file where that matters enough to need its own type: a connection that
    // fails never reached the runtime, while a request that timed out may have arrived and
    // been applied. Reporting the second as the first would tell an operator the outcome is
    // definitively unrecorded when the row may already say `applied`.
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new WorkCompletionUnconfirmedError(item.id, opts.completeTimeoutMs);
    }
    throw new WorkCompletionUndeliveredError(
      item.id,
      null,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!res.ok) throw new WorkCompletionUndeliveredError(item.id, res.status, await res.text());
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

/**
 * The environment variables an `--on-work` handler is launched with.
 *
 * This is the published contract's variable set under this project's prefix:
 * the poller sets every one except `MANAGED_AGENTS_WORK_SECRET`, which the
 * handler itself extracts from the claimed item's `secret` on stdin and
 * forwards only into the sandbox that serves that session. A secret that
 * never leaves the poller's own environment can never leak into a sibling
 * claim's sandbox, which is why it is not in this table.
 */
export const ON_WORK_ENV = {
  workId: 'MANAGED_AGENTS_WORK_ID',
  sessionId: 'MANAGED_AGENTS_SESSION_ID',
  environmentId: 'MANAGED_AGENTS_ENVIRONMENT_ID',
  environmentKey: 'MANAGED_AGENTS_ENVIRONMENT_KEY',
  workerId: 'MANAGED_AGENTS_WORKER_ID',
  baseUrl: 'MANAGED_AGENTS_BASE_URL',
  apiKey: 'MANAGED_AGENTS_API_KEY',
  workSecret: 'MANAGED_AGENTS_WORK_SECRET',
} as const;

/**
 * Run the `--on-work` command for one claimed item and resolve with its exit
 * code.
 *
 * The command receives the claimed work item as JSON on stdin and the
 * `MANAGED_AGENTS_*` variables above in its environment. It owns the item
 * from that point: acknowledging, executing, heartbeating, and reporting it
 * are the spawned worker's job — typically `managed-agents worker run` inside
 * a fresh sandbox. This function only waits for the process to exit; the
 * queue's lease is the reclamation path when a spawn dies without reporting.
 *
 * The command string runs through the platform shell so a path (`./spawn.sh`)
 * and a command line (`bash spawn.sh --flag`) both work; on Windows hosts the
 * shell is `cmd.exe`, so handlers are usually invoked as `bash spawn.sh` or a
 * `.cmd`/`.ps1` wrapper.
 */
export function runWorkHandler(
  onWork: string,
  item: WorkerItem,
  config: ResolvedWorkerPollOptions,
): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(onWork, {
      shell: true,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: {
        ...process.env,
        [ON_WORK_ENV.workId]: item.id,
        [ON_WORK_ENV.sessionId]: item.sessionId ?? item.session_id ?? '',
        ...(config.environmentId ? { [ON_WORK_ENV.environmentId]: config.environmentId } : {}),
        ...(config.environmentKey ?? process.env.MANAGED_AGENTS_ENVIRONMENT_KEY
          ? { [ON_WORK_ENV.environmentKey]: config.environmentKey ?? process.env.MANAGED_AGENTS_ENVIRONMENT_KEY! }
          : {}),
        [ON_WORK_ENV.workerId]: config.workerId,
        [ON_WORK_ENV.baseUrl]: config.baseUrl,
        ...(config.apiKey ? { [ON_WORK_ENV.apiKey]: config.apiKey } : {}),
      },
    });
    if (child.stdin) {
      // A handler that exits before reading leaves an EPIPE behind; the close
      // event already reports the exit, so the pipe error is noise.
      child.stdin.on('error', () => {});
      child.stdin.write(JSON.stringify(item));
      child.stdin.end();
    }
    child.on('error', () => resolvePromise(1));
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}

export type WorkerRunOptions = {
  workdir?: string;
  tools?: string;
  /**
   * How long to keep serving the session after its queue runs dry. The
   * official `--max-idle` analogue: the sandbox is per-session, so an idle
   * exit releases it and the next claim spawns a fresh one.
   */
  maxIdleMs?: string;
  intervalMs?: string;
  heartbeatMs?: string;
  heartbeatTimeoutMs?: string;
  claimTimeoutMs?: string;
  completeTimeoutMs?: string;
  ackTimeoutMs?: string;
};

const DEFAULT_RUN_MAX_IDLE_MS = 60_000;

/**
 * The in-sandbox half of `--on-work`: serve one session's work items and exit.
 *
 * Configuration is environment-driven because the process is meant to be a
 * container entrypoint, matching the published `worker run` contract: the
 * spawn handler sets `MANAGED_AGENTS_SESSION_ID`, `MANAGED_AGENTS_WORK_ID`,
 * `MANAGED_AGENTS_WORKER_ID`, `MANAGED_AGENTS_ENVIRONMENT_*`,
 * `MANAGED_AGENTS_BASE_URL`, and optionally `MANAGED_AGENTS_API_KEY`, and
 * forwards the claimed item JSON — including its `secret` — on stdin.
 *
 * The stdin item is the claim the poller already holds: this process accepts
 * and executes it under the forwarded worker id, then keeps claiming the
 * session's queued items until the session ends or the queue stays empty for
 * `--max-idle-ms`. Session liveness is read through the `mawt_` token in the
 * item's `secret` when present — a token that stops authenticating at the
 * session's terminal state is itself the ended signal — and the idle bound
 * is the backstop when no secret was forwarded.
 */
export async function workerRunCommand(opts: WorkerRunOptions, stdin: Readable = process.stdin) {
  const environmentKey = process.env.MANAGED_AGENTS_ENVIRONMENT_KEY;
  const sessionId = process.env.MANAGED_AGENTS_SESSION_ID;
  const workerId = process.env.MANAGED_AGENTS_WORKER_ID;
  if (!sessionId) throw new Error(`${ON_WORK_ENV.sessionId} is required: worker run serves one session's items`);
  if (!workerId) {
    throw new Error(`${ON_WORK_ENV.workerId} is required: the claim this process continues was made under that identity`);
  }
  const intervalMs = Number(opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_POLL_INTERVAL_MS) {
    throw new Error(`Invalid --interval-ms value "${opts.intervalMs}". Expected a number of at least ${MIN_POLL_INTERVAL_MS}.`);
  }
  const maxIdleMs = Number(opts.maxIdleMs ?? DEFAULT_RUN_MAX_IDLE_MS);
  if (!Number.isFinite(maxIdleMs) || maxIdleMs < MIN_POLL_INTERVAL_MS) {
    throw new Error(`Invalid --max-idle-ms value "${opts.maxIdleMs}". Expected a number of at least ${MIN_POLL_INTERVAL_MS}.`);
  }
  // The poll option validator is reused for the timeout flags — the bounds and
  // the error shapes are the same contract on both commands. `port` is a
  // placeholder: the runtime address this process talks to arrives through
  // `MANAGED_AGENTS_BASE_URL`, which the spawn handler forwarded from the
  // poller's own resolved base (or re-pointed at the host, for a container).
  const config: ResolvedWorkerPollOptions = resolveWorkerPollOptions({
    port: '3000',
    apiKey: process.env.MANAGED_AGENTS_API_KEY,
    environmentId: process.env.MANAGED_AGENTS_ENVIRONMENT_ID,
    environmentKey,
    workerId,
    workdir: opts.workdir ?? '.',
    tools: opts.tools,
    intervalMs: String(intervalMs),
    heartbeatMs: opts.heartbeatMs,
    heartbeatTimeoutMs: opts.heartbeatTimeoutMs,
    claimTimeoutMs: opts.claimTimeoutMs,
    completeTimeoutMs: opts.completeTimeoutMs,
    ackTimeoutMs: opts.ackTimeoutMs,
  });
  config.baseUrl = process.env.MANAGED_AGENTS_BASE_URL ?? 'http://localhost:3000';
  config.sessionId = sessionId;
  const customTools = await loadWorkerTools(config.toolsPath);

  // Skill packages materialize once per served session, inside the claim's
  // heartbeat window so a slow download never lapses the lease.
  const materializedSessions = new Set<string>();
  const ensureSkills = (item: WorkerItem) => ensureSessionSkills(config, item, materializedSessions);

  // The item the poller claimed arrives on stdin. When stdin is a TTY there is
  // no handed item — the loop below serves the session from the queue.
  const handed = await readStdinItem(stdin);
  if (handed) {
    await acceptWorkItem(config, handed.id);
    const outcome = await runItemWithHeartbeat(config, handed, customTools, ensureSkills);
    await completeWorkItem(config, handed, outcome);
    if (outcome.status === 'fulfilled') console.log(`completed ${handed.id}`);
  }

  // Every claim mints a fresh token, so the newest claimed item's `secret` is
  // the freshest credential to read session liveness through.
  let workSecret = handed?.secret ?? process.env.MANAGED_AGENTS_WORK_SECRET;
  let idleSince: number | null = null;
  for (;;) {
    let item: WorkerItem | null;
    try {
      item = await claimWorkItem(config);
    } catch (error) {
      console.warn(`could not claim work: ${error instanceof Error ? error.message : String(error)}`);
      item = null;
    }
    if (item) {
      idleSince = null;
      if (item.secret) workSecret = item.secret;
      try {
        await acceptWorkItem(config, item.id);
      } catch (error) {
        console.warn(`not running ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(config.intervalMs);
        continue;
      }
      const outcome = await runItemWithHeartbeat(config, item, customTools, ensureSkills);
      try {
        await completeWorkItem(config, item, outcome);
        if (outcome.status === 'fulfilled') console.log(`completed ${item.id}`);
      } catch (error) {
        console.warn(`could not report ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    idleSince ??= Date.now();
    if (await sessionHasEnded(config, sessionId, workSecret)) return;
    if (Date.now() - idleSince >= maxIdleMs) return;
    await sleep(config.intervalMs);
  }
}

/**
 * One heartbeat-renewed execution of a work item, packaged so both the handed
 * item and the session-drain loop share the failure envelope: a thrown run or
 * a lease-lost renewal is a rejected outcome, reported as a failed item.
 */
async function runItemWithHeartbeat(
  config: ResolvedWorkerPollOptions,
  item: WorkerItem,
  customTools: WorkerCustomTools,
  beforeExecute?: (item: WorkerItem) => Promise<void>,
): Promise<PromiseSettledResult<unknown>> {
  try {
    return {
      status: 'fulfilled',
      value: await renewWhileRunning(config, item.id, async (signal) => {
        await beforeExecute?.(item);
        return executeWorkItem(item, config.root, signal, customTools);
      }),
    };
  } catch (error) {
    return { status: 'rejected', reason: error };
  }
}

/**
 * Read one work item JSON from stdin, or null when stdin is a TTY/empty.
 *
 * The spawn contract passes the item on stdin; a `worker run` started without
 * one simply starts serving the session's queue, which is what makes the same
 * command usable as a manually-launched session worker.
 */
async function readStdinItem(stdin: Readable): Promise<WorkerItem | null> {
  if (stdin === process.stdin && process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return null;
  const item = JSON.parse(text) as WorkerItem;
  if (typeof item.id !== 'string' || !item.id) {
    throw new Error('work item on stdin is missing id');
  }
  return item;
}

/**
 * Whether the session this worker serves has ended, read through the per-claim
 * `mawt_` token. A dead token answers 401 — the session reaching a terminal
 * state revokes it — so any refusal counts as ended, and a live session's
 * projected `terminated` status is the explicit case. When no token was
 * forwarded the check reports "not ended" and the idle bound governs exit.
 */
async function sessionHasEnded(
  config: ResolvedWorkerPollOptions,
  sessionId: string,
  workSecret: string | null | undefined,
): Promise<boolean> {
  const token = sessionsTokenFromSecret(workSecret);
  if (!token) return false;
  try {
    const res = await fetch(`${config.baseUrl}/v1/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(config.claimTimeoutMs),
    });
    if (!res.ok) return true;
    const session = (await res.json()) as { status?: unknown };
    return session.status === 'terminated';
  } catch {
    return false;
  }
}

/**
 * Pull the `sessions_token` out of a work item's `secret`. The published
 * envelope is base64url JSON (`{sessions_token, api_base_url}`); a bare token
 * in the field is accepted too so a hand-rolled spawner can pass one.
 */
function sessionsTokenFromSecret(secret: string | null | undefined): string | null {
  if (!secret) return null;
  try {
    const decoded = JSON.parse(Buffer.from(secret, 'base64url').toString('utf8')) as { sessions_token?: string };
    if (typeof decoded.sessions_token === 'string' && decoded.sessions_token) return decoded.sessions_token;
  } catch {
    // A raw token works too; only the BetaWorkSecret envelope needs decoding.
  }
  return secret;
}

/** Same ceiling the upload route enforces on a package. */
const MAX_SKILL_PACKAGE_BYTES = 8 * 1024 * 1024;

/**
 * Download the session's assigned skill packages into `<root>/skills/<name>/`.
 *
 * The published worker contract puts the package tree at that path inside the
 * worker workdir — the same location the runtime's own provisioning writes
 * for `local`/`docker` sessions, so a packaged script runs the same way on
 * every backend. Discovery and fetch both go through the claim's `mawt_`
 * token: `GET /v1/sessions/{id}` names the agent's skill references, and the
 * version-content route is scoped to exactly those references. An unpinned
 * reference resolves through the `latest` alias the route accepts, pinned
 * references fetch their exact version.
 *
 * A worker without a forwarded secret skips materialization — it has no
 * credential with which to ask. A download failure throws: a session whose
 * declared skills cannot be materialized is running against a different
 * contract than the caller asked for, so the item reports failed rather than
 * executing short a package.
 */
async function materializeSessionSkills(
  config: ResolvedWorkerPollOptions,
  item: WorkerItem,
): Promise<void> {
  const token = sessionsTokenFromSecret(item.secret);
  const sessionId = item.session_id ?? item.sessionId ?? config.sessionId;
  if (!token || !sessionId) return;

  const fetchScoped = async (path: string): Promise<Response> => {
    const res = await fetch(`${config.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(config.claimTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`skill materialization: GET ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res;
  };

  const session = (await (await fetchScoped(`/v1/sessions/${sessionId}`)).json()) as {
    agent?: { skills?: unknown };
  };
  const refs = Array.isArray(session.agent?.skills) ? session.agent!.skills! : [];
  for (const rawRef of refs) {
    if (!rawRef || typeof rawRef !== 'object') continue;
    const ref = rawRef as Record<string, unknown>;
    // Built-in skills have no stored package to download; only custom
    // packages are materialized.
    if (ref.type !== 'custom' || typeof ref.skill_id !== 'string') continue;
    const version = typeof ref.version === 'string' && ref.version && ref.version !== 'latest'
      ? ref.version
      : 'latest';
    const res = await fetchScoped(`/v1/skills/${ref.skill_id}/versions/${version}/content`);
    if (res.headers.get('content-type')?.includes('application/zip') === false) {
      throw new Error(`skill materialization: ${ref.skill_id}@${version} is not a package`);
    }
    const zip = Buffer.from(await res.arrayBuffer());
    for (const entry of extractSkillZipEntries(zip, MAX_SKILL_PACKAGE_BYTES)) {
      // Entry paths are `<name>/<relative>` inside the archive, so extracting
      // under `skills/` reproduces `skills/<name>/...`.
      const target = safePath(config.root, `skills/${entry.path}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, entry.content);
      if (entry.executable && process.platform !== 'win32') chmodSync(target, 0o755);
    }
  }
}

/**
 * Materialize a session's skill packages at most once per worker process,
 * keyed by session so a poll-mode worker serving many sessions does not
 * re-download on every item.
 */
async function ensureSessionSkills(
  config: ResolvedWorkerPollOptions,
  item: WorkerItem,
  done: Set<string>,
): Promise<void> {
  const sessionId = item.session_id ?? item.sessionId ?? config.sessionId;
  if (!sessionId || done.has(sessionId)) return;
  await materializeSessionSkills(config, item);
  done.add(sessionId);
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
