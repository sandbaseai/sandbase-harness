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

  it('reports why a bounded wait gave up instead of only that it did', async () => {
    // Three situations, three opposite responses, and one message before this change:
    // "work item X timed out". A caller that guessed "safe to retry" for an item an
    // executor had already taken could duplicate a side effect on the operator's machine,
    // and one that guessed "unsafe" for an item nobody ever claimed would abandon work
    // that never ran. The reason is now read from the row.
    const unclaimed = queue.enqueue('sess_unclaimed', 'exec', { command: 'nobody here' });
    await expect(queue.await(unclaimed, { timeoutMs: 60, pollMs: 10 }))
      .rejects.toMatchObject({ code: 'work_queue_timeout' });
    // The reason is additive: the same failure still reads as a timeout in prose, because
    // a log line and a code answer different questions.
    await expect(queue.await(unclaimed, { timeoutMs: 60, pollMs: 10 })).rejects.toThrow(/timed out/);

    // Claimed, **accepted**, and never reported. The item is still `accepted` afterwards on
    // purpose - the work is alive for whoever holds it - and the reason says only that this
    // caller no longer knows the outcome, which is why it must not be replayed blindly.
    // Acceptance is what makes it unknown rather than safe: it is the executor's own
    // statement that it was about to start.
    const unknown = queue.enqueue('sess_unknown', 'exec', { command: 'maybe ran' });
    expect(queue.claim('w1', 'sess_unknown')!.id).toBe(unknown);
    expect(queue.accept(unknown, 'w1')).toBe('accepted');
    await expect(queue.await(unknown, { timeoutMs: 60, pollMs: 10 }))
      .rejects.toMatchObject({ code: 'work_outcome_unknown' });
    expect(queue.get(unknown)!.status).toBe('accepted');
    expect(queue.get(unknown)!.abandonedAt).toBeNull();

    // Claimed and **not** accepted - the same code, deliberately, even though it is now
    // knowable that nothing ran. The give-up is recorded rather than acted on, because the
    // item stays reclaimable by the spec and a caller told to resubmit would race the queue
    // re-offering it. See the reclaimability case below for the other half of that.
    const unstarted = queue.enqueue('sess_unstarted', 'exec', { command: 'never began' });
    expect(queue.claim('w3', 'sess_unstarted')!.id).toBe(unstarted);
    await expect(queue.await(unstarted, { timeoutMs: 60, pollMs: 10 }))
      .rejects.toMatchObject({ code: 'work_outcome_unknown' });
    expect(queue.get(unstarted)!.abandonedAt).toBeTruthy();

    // Stopped: the session ended and the work is not wanted at all. This is the fact a
    // refused renewal already reports, so it reuses that engine-neutral code rather than
    // adding a third one meaning the same thing.
    const stopped = queue.enqueue('sess_stopped', 'exec', { command: 'not wanted' });
    expect(queue.claim('w2', 'sess_stopped')!.id).toBe(stopped);
    expect(queue.stop('sess_stopped')).toBe(1);
    await expect(queue.await(stopped, { timeoutMs: 60, pollMs: 10 }))
      .rejects.toMatchObject({ code: 'work_lease_lost' });
  });

  it('keeps unaccepted work reclaimable when a wait gives up on it, and records the give-up', async () => {
    // The frozen 11b spec requires this twice: "未 accepted 的意图在 lease 过期后保持可重取"
    // (line 72) and, as an acceptance criterion, that an executor killed before ack leaves
    // the work "仍然可取（留在队列里）" (line 61). A bounded wait is the *common* path into
    // that state, because `execute()` always awaits with a bound - so if giving up made the
    // row unclaimable, the work the spec says stays in the queue would leave it permanently,
    // and the tool call would never happen at all.
    const id = queue.enqueue('sess_gaveup', 'exec', { command: 'never started' });
    expect(queue.claim('w1', 'sess_gaveup')!.id).toBe(id);
    expect(queue.get(id)!.acceptedAt).toBeNull();

    await expect(queue.await(id, { timeoutMs: 60, pollMs: 10 }))
      .rejects.toMatchObject({ code: 'work_outcome_unknown' });

    // The give-up is recorded - it is a real fact, and it is what distinguishes an attempt
    // abandoned before starting from one that died mid-command - while the session is still
    // alive and still owed the work.
    const row = queue.get(id)!;
    expect(row.abandonedAt).toBeTruthy();
    expect(row.stoppedAt).toBeNull();
    expect(row.status).toBe('queued');

    // Recorded where a reader can actually see it. The value of the marker is that it is
    // readable, so it has to reach the listing an operator looks at, not only the row this
    // test happens to hold - otherwise "observability" would be a claim about intent.
    const listed = queue.list().find((item) => item.id === id)!;
    expect(listed.abandonedAt).toBeTruthy();
    expect(listed.stoppedAt).toBeNull();
    // The other rows are untouched, so the marker is not being written indiscriminately.
    expect(queue.list().filter((item) => item.abandonedAt).map((item) => item.id)).toEqual([id]);

    // The reason stays conservative. Telling this caller to resubmit would be a promise the
    // queue cannot keep: the item is going to be re-offered, so the retry would run
    // alongside it.
    await expect(queue.await(id, { timeoutMs: 60, pollMs: 10 }))
      .rejects.toMatchObject({ code: 'work_outcome_unknown' });

    // And the queue does what the spec requires: once the lease expires the item is handed
    // to the next worker, which can accept it and run it. The record of the earlier give-up
    // must not survive into the new attempt.
    backdateClaim(db, id, 24 * 60);
    expect(queue.claim('w2', 'sess_gaveup')!.id).toBe(id);
    expect(queue.get(id)!.claimedBy).toBe('w2');
    expect(queue.get(id)!.abandonedAt).toBeNull();
    expect(queue.accept(id, 'w2')).toBe('accepted');
    expect(queue.complete(id, 'w2', { exitCode: 0, stdout: 'ran on the second worker' })).toBe('completed');
  });

  it('does not replay an accepted item whose lease lapsed, and still re-offers one that was never accepted', async () => {
    // The frozen spec draws one line and states both sides of it, so this case asserts both
    // sides together - a change that satisfied either half by breaking the other would fail
    // here rather than pass as an improvement.
    //
    // After an acceptance the holder committed to running the item, so its effect may already
    // have happened and handing it to a second worker would replay that effect silently
    // ("已 accepted 但效果未知必须进入 `unknown`，不得静默重放"). Before an acceptance nothing
    // ran, so lapsed work is free to be handed out and must stay claimable ("执行者在 ack 之前
    // 被杀 → 工作仍然可取（留在队列里）").
    //
    // The two markers involved look alike and mean opposite things: `abandoned_at` sits on the
    // pre-ack side and must never fence, `accepted_at` sits on the post-ack side and must.
    //
    // --- the post-ack side: accepted, lapsed, not replayed ---
    const started = queue.enqueue('sess_started', 'exec', { command: 'may already have run' });
    expect(queue.claim('w1', 'sess_started')!.id).toBe(started);
    expect(queue.accept(started, 'w1')).toBe('accepted');
    // A second worker cannot take it while the lease is live, which was already true.
    expect(queue.claim('w9', 'sess_started')).toBeNull();

    backdateClaim(db, started, 24 * 60);
    // The reclaim is now refused, so the effect cannot happen a second time.
    expect(queue.claim('w2', 'sess_started')).toBeNull();
    // And the item is recorded as what it is: a start whose outcome is not known. This is the
    // status the spec names, and the state a later recovery path reads - exclusion alone would
    // have left it claiming that somebody is still running it.
    const unknown = queue.get(started)!;
    expect(unknown.status).toBe('unknown');
    expect(unknown.acceptedAt).toBeTruthy();
    expect(unknown.result).toBeUndefined();
    // The holder cannot retroactively settle it either: the queue has already recorded that
    // the outcome was unknown when it stopped handing the item on, and a late result cannot
    // un-record that.
    expect(queue.complete(started, 'w1', { exitCode: 0, stdout: 'finished late' })).toBe('not_claimed_by_worker');

    // A bounded wait reports the same code it always did for this case - it is the behaviour
    // behind the code that changed, not the code - and it no longer describes a replay that
    // was about to happen anyway.
    await expect(queue.await(started, { timeoutMs: 60, pollMs: 10 }))
      .rejects.toMatchObject({ code: 'work_outcome_unknown' });
    // Still not replayed, after that wait too.
    expect(queue.claim('w3', 'sess_started')).toBeNull();
    expect(queue.get(started)!.status).toBe('unknown');

    // --- the pre-ack side: claimed, lapsed, nobody accepted, still reclaimable ---
    const neverStarted = queue.enqueue('sess_unstarted', 'exec', { command: 'never began' });
    expect(queue.claim('w4', 'sess_unstarted')!.id).toBe(neverStarted);
    backdateClaim(db, neverStarted, 24 * 60);
    // The same lapse, one step earlier, must behave the opposite way: taken over, run, and
    // completed by the second worker.
    expect(queue.claim('w5', 'sess_unstarted')!.id).toBe(neverStarted);
    expect(queue.get(neverStarted)!.status).toBe('queued');
    expect(queue.accept(neverStarted, 'w5')).toBe('accepted');
    expect(queue.complete(neverStarted, 'w5', { exitCode: 0, stdout: 'ran on the second worker' })).toBe('completed');
    expect(queue.get(neverStarted)!.status).toBe('applied');

    // --- and the states that must not be swept into `unknown` ---
    // Pending work was never held, so there is no start to be uncertain about.
    const queued = queue.enqueue('sess_queued', 'exec', { command: 'waiting' });
    expect(queue.claim('w6', 'sess_queued')!.id).toBe(queued);
    expect(queue.get(queued)!.status).toBe('queued');
    // A stop stays the item's stated cause rather than being recorded as an unknown outcome:
    // a stop is a decision, and this is an absence of information.
    const stopped = queue.enqueue('sess_over', 'exec', { command: 'unwanted' });
    expect(queue.claim('w7', 'sess_over')!.id).toBe(stopped);
    expect(queue.accept(stopped, 'w7')).toBe('accepted');
    backdateClaim(db, stopped, 24 * 60);
    expect(queue.stop('sess_over')).toBe(1);
    expect(queue.claim('w8', 'sess_over')).toBeNull();
    expect(queue.get(stopped)!.status).toBe('accepted');
    expect(queue.get(stopped)!.stoppedAt).toBeTruthy();
  });

  it('reports only the frozen status vocabulary, and never a word it replaced', async () => {
    // The frozen worker-protocol spec fixes the chain as `queued -> accepted -> applied`, plus
    // `failed` / `unknown`, and allows the old words to survive **only** as the migration's
    // compatibility mapping. This case pins that as a property rather than as a dozen separate
    // assertions, so the set itself is what is frozen and a sixth status cannot appear quietly.
    const FROZEN = ['queued', 'accepted', 'applied', 'failed', 'unknown'];

    // Each status reached through the public queue API, one item per transition, so the
    // assertion below is about states the queue really produces rather than values written
    // into the table by the test.
    const staysQueued = queue.enqueue('s_queued', 'exec', { command: 'untouched' });
    expect(queue.get(staysQueued)!.status).toBe('queued');

    const held = queue.enqueue('s_held', 'exec', { command: 'held' });
    expect(queue.claim('w1', 's_held')!.id).toBe(held);
    // The transition that the rename is about: a lease does **not** move the status, because
    // taking a lease is not a commitment to run the item.
    expect(queue.get(held)!.status).toBe('queued');
    expect(queue.get(held)!.claimedBy).toBe('w1');

    expect(queue.accept(held, 'w1')).toBe('accepted');
    expect(queue.get(held)!.status).toBe('accepted');
    // And re-accepting is idempotent for the holder, which is why `accepted` is admitted by
    // the accept predicate: a retry over a flaky link must not be told it lost its own claim.
    expect(queue.accept(held, 'w1')).toBe('accepted');
    // `held` is left `accepted` on purpose so the final scan sees that state too; the
    // completion transition is exercised on its own item below.

    const completing = queue.enqueue('s_applied', 'exec', { command: 'succeeds' });
    expect(queue.claim('w5', 's_applied')!.id).toBe(completing);
    expect(queue.accept(completing, 'w5')).toBe('accepted');
    expect(queue.complete(completing, 'w5', { exitCode: 0 })).toBe('completed');
    expect(queue.get(completing)!.status).toBe('applied');

    const failing = queue.enqueue('s_failed', 'exec', { command: 'fails' });
    expect(queue.claim('w2', 's_failed')!.id).toBe(failing);
    expect(queue.complete(failing, 'w2', { exitCode: 1 }, true)).toBe('completed');
    expect(queue.get(failing)!.status).toBe('failed');

    const lost = queue.enqueue('s_lost', 'exec', { command: 'unknown outcome' });
    expect(queue.claim('w3', 's_lost')!.id).toBe(lost);
    expect(queue.accept(lost, 'w3')).toBe('accepted');
    backdateClaim(db, lost, 24 * 60);
    expect(queue.claim('w4', 's_lost')).toBeNull();
    expect(queue.get(lost)!.status).toBe('unknown');

    // Every status the queue is holding is one of the five, and the counts are keyed by the
    // same vocabulary the API hands out - a caller reading `counts` must not have to know that
    // some rows are still described by the words this change replaced.
    const rows = db.prepare('SELECT DISTINCT status FROM work_items').all() as Array<{ status: string }>;
    expect(rows.map((row) => row.status).sort()).toEqual([...FROZEN].sort());
    expect(Object.keys(queue.stats()).sort()).toEqual([...FROZEN].sort());

    // And the replaced words are gone from the data, not merely unused by new writes. This is
    // the assertion that would fail if the migration's mapping were incomplete or if a write
    // path still named an old value.
    const old = db.prepare(
      "SELECT COUNT(*) AS c FROM work_items WHERE status IN ('pending', 'claimed', 'done')",
    ).get() as { c: number };
    expect(old.c).toBe(0);
  });

  it('records a give-up only for claimed work nobody accepted', async () => {
    // The record is one guarded write. `accepted_at IS NULL` is the condition that matters:
    // the holder may accept between the wait reading the row and writing it, and work that
    // is about to run must not be recorded as abandoned-before-starting. Because the record
    // is observability rather than a fence, none of this changes any answer a worker gets -
    // the assertions below are about the marker, not about permissions.
    const accepted = queue.enqueue('sess_started', 'exec', { command: 'running' });
    expect(queue.claim('w1', 'sess_started')!.id).toBe(accepted);
    expect(queue.accept(accepted, 'w1')).toBe('accepted');
    expect(queue.get(accepted)!.abandonedAt).toBeNull();
    // Untouched and still fully usable: claimed, accepted, renewable, and claimed by its
    // holder rather than taken from it.
    expect(queue.get(accepted)!.acceptedAt).toBeTruthy();
    expect(queue.heartbeat(accepted, 'w1')).toBe('renewed');
    expect(queue.claim('w9', 'sess_started')).toBeNull();

    // Work that was never claimed is not this method's business: there is no claim to give
    // up on, and `pending` already answers the caller honestly.
    const pending = queue.enqueue('sess_queued', 'exec', { command: 'waiting' });
    expect(queue.get(pending)!.abandonedAt).toBeNull();
    expect(queue.get(pending)!.status).toBe('queued');
  });

  it('classifies a stopped item by the stop, not by the state it was in', async () => {
    // A stopped item that nobody had claimed is still `pending`, so a classification that
    // tested the state before the marker would report the one reason that promises a
    // retry is safe - and tell a caller to resubmit work for a session that has ended.
    // The marker is the cause; `pending` is only where the item happened to be.
    const id = queue.enqueue('sess_never_claimed', 'exec', { command: 'too late' });
    expect(queue.get(id)!.status).toBe('queued');
    expect(queue.stop('sess_never_claimed')).toBe(1);

    await expect(queue.await(id, { timeoutMs: 60, pollMs: 10 }))
      .rejects.toMatchObject({ code: 'work_lease_lost' });
  });

  it('lets a result that arrived before the deadline win over the reason', async () => {
    // The reason is read after the completion check, and for stopped work that order is
    // the whole point: the marker says the session does not want the result, not that the
    // effect did not happen. A holder that finished the command before the deadline still
    // reports it, and the wait must not overwrite a real result with a guess about one.
    const id = queue.enqueue('sess_race', 'exec', { command: 'raced' });
    expect(queue.claim('w1', 'sess_race')!.id).toBe(id);
    expect(queue.stop('sess_race')).toBe(1);
    expect(queue.complete(id, 'w1', { exitCode: 0, stdout: 'done' })).toBe('completed');

    await expect(queue.await(id, { timeoutMs: 500, pollMs: 10 }))
      .resolves.toMatchObject({ stdout: 'done' });
  });

  it('treats a wait on a row it cannot read as an unknown outcome, not a safe retry', async () => {
    // Absence proves nothing about whether the work ran. Of the two ways to be wrong,
    // inviting a replay of an effect that may already have happened is the expensive one,
    // so the conservative classification is the one that does not promise a free retry.
    await expect(queue.await('work_missing', { timeoutMs: 60, pollMs: 10 }))
      .rejects.toMatchObject({ code: 'work_outcome_unknown' });
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
    expect(reclaimed?.status).toBe('queued');

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
    expect(queue.get(unclaimed)!.status).toBe('queued');
    expect(queue.get(unclaimed)!.stoppedAt).toBeTruthy();
    expect(queue.get(held)!.status).toBe('queued');
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
    expect(queue.get(late)!.status).toBe('queued');
    expect(queue.claim('w1', 'sess_ended')).toBeNull();
    // The session's decision already covers it, so there is nothing left for a second stop
    // to mark - otherwise the guarantee would depend on someone remembering to call it.
    expect(queue.stop('sess_ended')).toBe(0);

    // Every terminal status behaves the same way, and they are read from the state machine
    // rather than listed here, so `timed_out` and `cleanup_pending` count too.
    for (const status of ['failed', 'cancelled', 'timed_out', 'cleanup_pending']) {
      mkSession(`sess_${status}`, status);
      const id = queue.enqueue(`sess_${status}`, 'read', { path: status });
      expect(queue.get(id)!.stoppedAt).toBeTruthy();
      expect(queue.claim('w1', `sess_${status}`)).toBeNull();
    }

    // A status with an outbound transition is resumable, so its work is still wanted.
    for (const status of ['queued', 'running', 'paused', 'requires_action']) {
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

    mkSession('sess_failed', 'running');
    const failed = queue.enqueue('sess_failed', 'exec', { command: 'never after failure' });
    db.prepare("UPDATE sessions SET status = 'failed' WHERE id = 'sess_failed'").run();
    expect(queue.get(failed)!.stoppedAt).toBeNull();
    expect(queue.claim('w4', 'sess_failed')).toBeNull();
    expect(queue.get(failed)!.status).toBe('queued');

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

  it('confirms the claim before an item runs, and refuses when the lease has lapsed', () => {
    // A claim is a lease on running an item, not ownership of it: the row becomes
    // claimable again the instant the window passes, and the gap between claiming and
    // starting is unbounded - the worker returns from the claim, resolves its workdir, and
    // may be a process that was paused or descheduled. Without a check at the start, an
    // item whose window passed runs here **and** on the worker that reclaims it, so the
    // side effect happens twice on the operator's machine.
    const id = queue.enqueue('sess_accept', 'exec', { command: 'run once' });
    expect(queue.claim('w1')!.id).toBe(id);

    // Held, and not yet accepted: the two are different facts and the row records both.
    expect(queue.get(id)!.claimedBy).toBe('w1');
    expect(queue.get(id)!.acceptedAt).toBeNull();

    expect(queue.accept(id, 'w1')).toBe('accepted');
    expect(queue.get(id)!.acceptedAt).toBeTruthy();

    // Idempotent for the holder: a worker retrying over a flaky link must not be punished
    // for the retry, and the second answer is the same permission as the first.
    expect(queue.accept(id, 'w1')).toBe('accepted');

    // A foreign holder is not a stop. The item is alive for the worker that owns it, so
    // the answer has to be the one that says "not yours" rather than the one that says
    // "do not run it" - the two lead a worker to opposite actions.
    expect(queue.accept(id, 'w2')).toBe('not_claimed_by_worker');
    expect(queue.accept('work_missing', 'w1')).toBe('not_found');
  });

  it('refuses to accept a claim whose lease lapsed, even when nobody has reclaimed it', () => {
    // This is the strictness that makes accept different from heartbeat, and it is the
    // point rather than an inconsistency. A renewal is about an item already in flight,
    // whose effect cannot be un-run and which nobody else has taken, so a suspicion is
    // tolerated. An acceptance authorizes **starting** something, and a lapsed claim is
    // reclaimable at any instant: authorizing a start on it would let this worker and the
    // one that reclaims it in the same instant both run the item.
    const id = queue.enqueue('sess_lapsed', 'exec', { command: 'stale' });
    expect(queue.claim('w1')!.id).toBe(id);
    backdateClaim(db, id, 24 * 60);

    // The precondition, asserted rather than assumed: the item is still this worker's and
    // still unclaimed by anyone else, so the refusal below cannot be a foreign-holder
    // answer wearing a lease-refusal's clothes.
    expect(queue.get(id)!.claimedBy).toBe('w1');
    expect(queue.get(id)!.status).toBe('queued');

    expect(queue.accept(id, 'w1')).toBe('work_lease_lost');
    expect(queue.get(id)!.acceptedAt).toBeNull();
    // And the same lease is still renewable, which is what makes the asymmetry deliberate:
    // the worker that is already running this item is not told to stop by a lapsed lease.
    expect(queue.heartbeat(id, 'w1')).toBe('renewed');
    // Renewing restarts the window, so the item is acceptable again now that it is live.
    expect(queue.accept(id, 'w1')).toBe('accepted');
  });

  it('refuses to accept stopped work with the code a worker acts on', () => {
    // The session ended. Nothing wants the item, so the worker must not start it - and the
    // refusal is the same engine-neutral code a refused renewal uses, because the
    // instruction to the worker is identical either way.
    const id = queue.enqueue('sess_stopped', 'exec', { command: 'not wanted' });
    expect(queue.claim('w1')!.id).toBe(id);
    expect(queue.stop('sess_stopped')).toBe(1);

    expect(queue.accept(id, 'w1')).toBe('work_lease_lost');
    // A refusal is not a completion: nothing ran, so nothing may be recorded as having run.
    expect(queue.get(id)!.status).toBe('queued');
    expect(queue.get(id)!.completedAt).toBeNull();
    expect(queue.get(id)!.acceptedAt).toBeNull();
  });

  it('never lets acceptance survive to a different holder', () => {
    // Acceptance is a statement about one holder's lease, so it must never read as belonging
    // to a worker that never asked - that would tell the queue an effect was committed to
    // that nobody committed to.
    //
    // **This case previously asserted that outcome by way of a reclaim, and that assertion
    // encoded the defect.** It claimed an item, accepted it, let the lease lapse, and
    // required the item to be handed to a second worker with `accepted_at` cleared - which is
    // precisely the silent replay the frozen spec forbids ("已 accepted 但效果未知必须进入
    // `unknown`，不得静默重放"). The invariant it was reaching for is real; the route it took
    // to test it was the bug. An accepted item cannot change holders at all now, so the
    // honest statement is the stronger one: the reclaim is refused, the acceptance stays with
    // the worker that made it, and the item is recorded as an unknown outcome instead.
    const id = queue.enqueue('sess_reclaim', 'exec', { command: 'mine, then yours' });
    expect(queue.claim('w1')!.id).toBe(id);
    expect(queue.accept(id, 'w1')).toBe('accepted');
    expect(queue.get(id)!.acceptedAt).toBeTruthy();

    backdateClaim(db, id, 24 * 60);
    // Refused: no second holder, so there is no row that could read as someone else's.
    expect(queue.claim('w2')).toBeNull();
    const row = queue.get(id)!;
    expect(row.status).toBe('unknown');
    expect(row.claimedBy).toBe('w1');
    // The acceptance is still w1's own statement about w1's attempt, and w1 still cannot
    // settle it - the queue has recorded the outcome as unknown and that record stands.
    expect(row.acceptedAt).toBeTruthy();
    expect(queue.complete(id, 'w1', { exitCode: 0 })).toBe('not_claimed_by_worker');

    // The clearing path itself is still exercised, on the only row that can reach it: work
    // that was claimed and **not** accepted. The acceptance is null before and after, which
    // is what "never inherits an acceptance" means once an accepted row can no longer move.
    const unstarted = queue.enqueue('sess_reclaim', 'exec', { command: 'nobody committed' });
    expect(queue.claim('w3')!.id).toBe(unstarted);
    backdateClaim(db, unstarted, 24 * 60);
    expect(queue.claim('w4')!.id).toBe(unstarted);
    expect(queue.get(unstarted)!.claimedBy).toBe('w4');
    expect(queue.get(unstarted)!.acceptedAt).toBeNull();
    expect(queue.accept(unstarted, 'w4')).toBe('accepted');
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
    expect(queue.get(queued)!.status).toBe('queued');
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

  it('accepts a live claim, and answers 409 with the code a worker acts on', async () => {
    const post = (path: string, body: unknown) =>
      app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const id = queue.enqueue('s', 'exec', { command: 'run' });
    queue.claim('w1');

    // The success path is what authorizes the worker to start the item.
    const ok = await post('/accept', { id, worker_id: 'w1' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });

    // A foreign holder gets the refusal that says "not yours" and carries no code, because
    // the work is alive for the worker that owns it.
    const foreign = await post('/accept', { id, worker_id: 'w2' });
    expect(foreign.status).toBe(409);
    expect((await foreign.json()).error.code).toBeUndefined();

    // A stopped item gets the engine-neutral code, on the same status, because the
    // instruction to the worker is the one it must act on.
    const stopped = queue.enqueue('s_stop', 'exec', { command: 'stop me' });
    queue.claim('w3', 's_stop');
    queue.stop('s_stop');
    const refused = await post('/accept', { id: stopped, worker_id: 'w3' });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe('work_lease_lost');
    expect(queue.get(stopped)!.status).toBe('queued');

    expect((await post('/accept', { id: 'work_missing', worker_id: 'w1' })).status).toBe(404);
    expect((await post('/accept', { id, worker_id: '' })).status).toBe(400);
  });

  it('complete marks the item done', async () => {
    const id = queue.enqueue('s', 'read', { path: 'f' });
    queue.claim('w1');
    const res = await app.request('/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, worker_id: 'w1', result: 'file contents' }),
    });
    expect(res.status).toBe(200);
    expect(queue.get(id)!.status).toBe('applied');
  });

  it('rejects completion by a worker that did not claim the item', async () => {
    const id = queue.enqueue('s', 'read', { path: 'f' });
    queue.claim('w1');
    const res = await app.request('/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, worker_id: 'w2', result: 'forged result' }),
    });
    expect(res.status).toBe(409);
    expect(queue.get(id)!.status).toBe('queued');
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
    expect(queue.get(id)!.status).toBe('queued');
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
