/**
 * Integration test: a claim scoped to both a session and an environment.
 *
 * `WorkQueue.claim(workerId, sessionId?, environmentId?)` has three branches, and
 * `self-hosted-provider.ts:58-63` states why the claim is safe: "a single atomic
 * conditional UPDATE guarded by `status='queued'` so two concurrent workers can
 * never claim the same item (H2). Only the worker whose UPDATE actually flips the
 * row wins."
 *
 * The two single-axis branches are covered - `self-hosted.test.ts` scopes a claim to
 * a session, and `environment-worker-keys.test.ts` scopes one to the environment
 * named by a worker key, with the comment that "env_b's work must not reach an env_a
 * worker". **The branch where both are given is covered by nothing**, and it is the
 * one carrying the join on `s.environment_id`:
 *
 *     SELECT wi.id FROM work_items wi JOIN sessions s ON s.id = wi.session_id
 *     WHERE wi.status = 'queued' AND wi.session_id = ? AND s.environment_id = ?
 *
 * That is the security-relevant intersection. A worker holding one environment's key
 * must not be handed work that belongs to another environment's session merely by
 * naming that session id - and the session id is the caller's own input, so it is the
 * cheapest thing in the request to forge.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { WorkQueue } from '@/sandbox/self-hosted-provider.js';

describe('Work queue claim scoped to a session and an environment', () => {
  let db: Database;
  let tmpDir: string;
  let queue: WorkQueue;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-claim-scope-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_b', 'b', '', '{}', '{}')").run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id) VALUES ('sess_a', 'agent_x', 'x', 'env_a')").run();
    db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id) VALUES ('sess_b', 'agent_x', 'x', 'env_b')").run();
    queue = new WorkQueue(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function statusOf(id: string): string {
    return (db.prepare('SELECT status FROM work_items WHERE id = ?').get(id) as { status: string }).status;
  }

  it('refuses a session from another environment even when the session id is named', () => {
    const item = queue.enqueue('sess_b', 'read', { path: 'b' });

    // The worker holds env_a's scope and names a session that belongs to env_b.
    expect(queue.claim('w1', 'sess_b', 'env_a')).toBeNull();
    // Refusing has to mean the item is still there, not that it was consumed.
    expect(statusOf(item)).toBe('queued');

    // The positive control: the same item is claimable by its own environment and
    // session, so the refusal above cannot have been an empty queue in disguise.
    const claimed = queue.claim('w2', 'sess_b', 'env_b');
    expect(claimed?.id).toBe(item);
    expect(claimed?.status).toBe('queued');
    expect(statusOf(item)).toBe('queued');
  });

  it('keeps a same-environment session claimable, and an unknown session inert', () => {
    const forA = queue.enqueue('sess_a', 'read', { path: 'a' });

    // The matching scope works, which is what makes the refusal above a decision
    // about the environment rather than about session scoping in general.
    expect(queue.claim('w1', 'sess_a', 'env_a')?.id).toBe(forA);
    expect(statusOf(forA)).toBe('queued');

    // A session that does not exist in this environment hands over nothing.
    queue.enqueue('sess_a', 'read', { path: 'a2' });
    expect(queue.claim('w2', 'sess_missing', 'env_a')).toBeNull();
  });
});
