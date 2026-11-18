/**
 * Unit tests for `SessionWorkQueue` — the session-scoped claim object behind
 * the official Work API.
 *
 * The claim unit is a whole session: `poll` claims it, `ack` commits, a
 * heartbeat (carrying `NO_HEARTBEAT` on the first beat, then the echoed
 * `expected_last_heartbeat`) renews the lease, `desired_ttl_seconds` retunes
 * it, and `stop`/`force` retires it. The contained per-call items are drained
 * under a held claim via `drainableBy`, and a stopped claim frees the session
 * for a NEW claim row rather than resurrecting the terminal one. These run
 * against a real `Database` so the lease predicates, the partial unique index,
 * and the token-revocation fences are exercised exactly as the routes drive
 * them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionWorkQueue } from '@/sandbox/session-work-queue.js';
import { issueSessionWorkToken, validateSessionWorkToken } from '@/core/auth/session-work-tokens.js';

describe('SessionWorkQueue', () => {
  let db: Database;
  let tmpDir: string;
  let queue: SessionWorkQueue;

  function addSession(id: string, envId = 'env_a', status = 'running') {
    db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id, status) VALUES (?, 'agent_x', 'x', ?, ?)")
      .run(id, envId, status);
  }

  function lapse(id: string, secondsAgo: number) {
    db.prepare("UPDATE session_work_claims SET claimed_at = datetime('now', ?) WHERE id = ?")
      .run(`-${secondsAgo} seconds`, id);
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-swq-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_b', 'b', '', '{}', '{}')").run();
    queue = new SessionWorkQueue(db, { leaseMs: 60_000 });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('materializes one live claim per session and keeps it idempotent', () => {
    addSession('sess_a');
    const first = queue.ensure('sess_a')!;
    const second = queue.ensure('sess_a')!;
    expect(first.id).toBe(second.id);
    expect(first.status).toBe('queued');
    expect(first.sessionId).toBe('sess_a');
    expect(first.environmentId).toBe('env_a');
    // The partial unique index is the guard: a second live row cannot exist.
    const rows = db.prepare("SELECT COUNT(*) n FROM session_work_claims WHERE session_id = 'sess_a'").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('produces no claim for a missing or terminal session', () => {
    expect(queue.ensure('sess_missing')).toBeNull();
    addSession('sess_dead', 'env_a', 'completed');
    expect(queue.ensure('sess_dead')).toBeNull();
  });

  it('walks poll → ack → heartbeat → drain → force-stop as one lifecycle', () => {
    addSession('sess_a');
    const seeded = queue.ensure('sess_a')!;

    // Poll claims the oldest claimable claim and binds a worker to it.
    const claimed = queue.claim('worker_1', 'env_a')!;
    expect(claimed.id).toBe(seeded.id);
    expect(claimed.status).toBe('claimed');
    expect(claimed.claimedBy).toBe('worker_1');
    // Not yet drainable: ack is the commitment the gate requires.
    expect(queue.drainableBy('sess_a', 'worker_1')).toBe(false);

    // Ack is the execution commitment; after it the claim is accepted.
    expect(queue.ack(claimed.id, 'worker_1')).toBe('accepted');
    expect(queue.drainableBy('sess_a', 'worker_1')).toBe(true);

    // First beat carries NO_HEARTBEAT and claims the anchor. The value is the
    // row's `heartbeat_at` (SQL `YYYY-MM-DD HH:MM:SS`); the wire echoes it back
    // in ISO form, which is what the precondition compares against.
    const first = queue.heartbeat(claimed.id, { workerId: 'worker_1', expectedLastHeartbeat: 'NO_HEARTBEAT' });
    expect(first.outcome).toBe('renewed');
    const anchor = `${(first as { lastHeartbeat: string }).lastHeartbeat.replace(' ', 'T')}Z`;

    // A stale precondition is refused with the server's current anchor.
    const stale = queue.heartbeat(claimed.id, { workerId: 'worker_1', expectedLastHeartbeat: 'NO_HEARTBEAT' });
    expect(stale.outcome).toBe('precondition_failed');

    // The echoed anchor renews, and a desired TTL restamps the lease.
    const renewed = queue.heartbeat(claimed.id, { workerId: 'worker_1', expectedLastHeartbeat: anchor, desiredTtlSeconds: 120 });
    expect(renewed.outcome).toBe('renewed');
    expect(queue.get(claimed.id)!.ttlSeconds).toBe(120);

    // Force stop is terminal and revokes the bound token.
    const token = issueSessionWorkToken(db, 'sess_a', 'env_a', claimed.id);
    expect(queue.stop(claimed.id, true)).toBe('stopped');
    expect(validateSessionWorkToken(db, token).ok).toBe(false);
    expect(queue.drainableBy('sess_a', 'worker_1')).toBe(false);
  });

  it('re-claims a lapsed unacknowledged claim inside the reclaim window', () => {
    addSession('sess_a');
    queue.ensure('sess_a');
    const held = queue.claim('worker_1', 'env_a')!;
    // Inside the caller's reclaim window the held claim is not claimable.
    lapse(held.id, 1);
    expect(queue.claim('worker_2', 'env_a', 5_000)).toBeNull();
    // Past it, a second worker takes the claim and starts a new epoch.
    lapse(held.id, 10);
    const reclaimed = queue.claim('worker_2', 'env_a', 5_000)!;
    expect(reclaimed.id).toBe(held.id);
    expect(reclaimed.claimedBy).toBe('worker_2');
    expect(reclaimed.acceptedAt).toBeNull();
  });

  it('holds an accepted claim to its own TTL rather than the reclaim window', () => {
    addSession('sess_a');
    queue.ensure('sess_a');
    const held = queue.claim('worker_1', 'env_a')!;
    queue.ack(held.id, 'worker_1');
    // Past the reclaim window but inside the claim TTL: not claimable.
    lapse(held.id, 10);
    expect(queue.claim('worker_2', 'env_a', 5_000)).toBeNull();
    // Past the TTL the committed-but-dead claim is handed back.
    lapse(held.id, 120);
    const reclaimed = queue.claim('worker_2', 'env_a', 5_000)!;
    expect(reclaimed.claimedBy).toBe('worker_2');
  });

  it('never lets two workers hold the same session or drain under a foreign claim', () => {
    addSession('sess_a');
    queue.ensure('sess_a');
    const held = queue.claim('worker_1', 'env_a')!;
    queue.ack(held.id, 'worker_1');
    // A second worker can neither claimForSession nor drain under the claim.
    expect(queue.claimForSession('worker_2', 'sess_a')).toBeNull();
    expect(queue.drainableBy('sess_a', 'worker_2')).toBe(false);
    // The holder re-acquires its own claim (claimForSession is idempotent for the holder).
    expect(queue.claimForSession('worker_1', 'sess_a')!.id).toBe(held.id);
  });

  it('graceful stop marks stopping, refuses new drains, and confirms to stopped', () => {
    addSession('sess_a');
    queue.ensure('sess_a');
    const held = queue.claim('worker_1', 'env_a')!;
    queue.ack(held.id, 'worker_1');
    expect(queue.drainableBy('sess_a', 'worker_1')).toBe(true);

    expect(queue.stop(held.id, false)).toBe('stopping');
    // During stopping the in-flight call finishes but no new call is handed out.
    expect(queue.drainableBy('sess_a', 'worker_1')).toBe(false);
    // The confirming stop retires it; a force on a live claim stops it outright.
    expect(queue.stop(held.id, false)).toBe('stopped');
    expect(queue.get(held.id)!.status).toBe('stopped');
  });

  it('frees the session for a NEW claim after stop rather than resurrecting it', () => {
    addSession('sess_a');
    const first = queue.ensure('sess_a')!;
    queue.stop(first.id, true);
    const second = queue.ensure('sess_a')!;
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('queued');
    // The stopped row is history; the new live row is the only live claim.
    const live = db.prepare("SELECT COUNT(*) n FROM session_work_claims WHERE session_id = 'sess_a' AND status != 'stopped'").get() as { n: number };
    expect(live.n).toBe(1);
  });

  it('revokes the bound mawt token on reclaim and on stop', () => {
    addSession('sess_a');
    queue.ensure('sess_a');
    const held = queue.claim('worker_1', 'env_a')!;
    const token = issueSessionWorkToken(db, 'sess_a', 'env_a', held.id);
    expect(validateSessionWorkToken(db, token).ok).toBe(true);
    // A re-claim starts a new epoch and kills the superseded holder's credential.
    lapse(held.id, 10);
    queue.claim('worker_2', 'env_a', 5_000);
    expect(validateSessionWorkToken(db, token).ok).toBe(false);
  });

  it('retires a live claim when its session reaches a terminal status', () => {
    addSession('sess_a');
    const held = queue.ensure('sess_a')!;
    db.prepare("UPDATE sessions SET status = 'completed' WHERE id = 'sess_a'").run();
    // ensure on a terminal session stops the claim rather than serving it.
    expect(queue.ensure('sess_a')).toBeNull();
    expect(queue.get(held.id)!.status).toBe('stopped');
    // And the terminal session's claim is no longer claimable.
    expect(queue.claim('worker_1', 'env_a')).toBeNull();
  });

  it('reports depth, pending, oldest, and polling workers on the claim lifecycle', () => {
    addSession('sess_a');
    addSession('sess_a2');
    addSession('sess_b', 'env_b');
    const a = queue.ensure('sess_a')!;
    queue.ensure('sess_a2');
    queue.ensure('sess_b');

    let stats = queue.queueStats('env_a');
    expect(stats.depth).toBe(2);
    expect(stats.pending).toBe(0);
    expect(stats.oldestQueuedAt).not.toBeNull();

    queue.recordPoll('worker_1');
    const claimed = queue.claim('worker_1', 'env_a')!;
    expect(claimed.id).toBe(a.id);
    stats = queue.queueStats('env_a');
    // Held-but-unacked is pending, out of depth.
    expect(stats.depth).toBe(1);
    expect(stats.pending).toBe(1);
    expect(queue.workersPolling()).toBe(1);

    // Past the reclaim window the held claim is claimable again — back in depth.
    lapse(claimed.id, 10);
    stats = queue.queueStats('env_a', 5_000);
    expect(stats.depth).toBe(2);
    expect(stats.pending).toBe(0);
    // Scoped: env_b's claim is not part of env_a's pressure.
    expect(queue.queueStats('env_b').depth).toBe(1);
  });
});
