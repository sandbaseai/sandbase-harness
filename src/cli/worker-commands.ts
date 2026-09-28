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
  once?: boolean;
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
  apiKey?: string;
  environmentId?: string;
  environmentKey?: string;
  workerId: string;
  root: string;
  once: boolean;
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
    apiKey: opts.apiKey,
    environmentId: opts.environmentId,
    environmentKey: opts.environmentKey,
    workerId: opts.workerId ?? `worker_${process.pid}`,
    root: resolve(opts.workdir),
    once: opts.once === true,
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
  kind: 'exec' | 'read' | 'write' | 'list';
  payload: Record<string, unknown>;
};

export async function workerPollCommand(opts: WorkerPollOptions) {
  const config = resolveWorkerPollOptions(opts);
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
          value: await renewWhileRunning(config, item.id, (signal) => executeWorkItem(item, config.root, signal)),
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
    res = await fetch(`http://localhost:${opts.port}/v1/x/worker/accept`, {
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
    res = await fetch(`http://localhost:${opts.port}/v1/x/worker/heartbeat`, {
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
  let res: Response;
  try {
    res = await fetch(`http://localhost:${opts.port}/v1/x/worker/claim`, {
      method: 'POST',
      headers: jsonHeaders(opts),
      body: JSON.stringify({
        worker_id: opts.workerId,
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
    res = await fetch(`http://localhost:${opts.port}/v1/x/worker/complete`, {
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
