/**
 * Integration test: the published self-hosted worker-key and work-queue routes.
 *
 * `docs/api.md` and `docs/api-matrix.md` publish
 * `GET/POST /v1/environments/{id}/worker-keys`,
 * `POST .../worker-keys/{key_id}/revoke`, and
 * `GET /v1/environments/{id}/work-items`. These assertions keep those published
 * paths real, and pin the two properties that make publishing the keys safe:
 * the raw secret is returned exactly once, and a revoked, expired, or
 * wrong-environment key is refused before any work item changes hands.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { WorkQueue } from '@/sandbox/self-hosted-provider.js';
import { createServer } from '@/api/server.js';

describe('Environment worker keys (documented routes)', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;
  let queue: WorkQueue;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-ewk-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_b', 'b', '', '{}', '{}')").run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id) VALUES ('sess_a', 'agent_x', 'x', 'env_a')").run();
    db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id) VALUES ('sess_b', 'agent_x', 'x', 'env_b')").run();

    queue = new WorkQueue(db);
    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      workQueue: queue,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown = {}) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { res, body: await res.json() as any };
  }

  async function get(path: string) {
    const res = await app.request(path);
    return { res, body: await res.json() as any };
  }

  async function issueKey(environmentId = 'env_a', body: Record<string, unknown> = { name: 'fde-laptop' }) {
    const { res, body: created } = await post(`/v1/environments/${environmentId}/worker-keys`, body);
    expect(res.status).toBe(201);
    return created as { id: string; secret_key: string; key_prefix: string; status: string };
  }

  async function claim(payload: Record<string, unknown>) {
    const res = await app.request('/v1/x/worker/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { res, body: res.status === 204 ? null : await res.json() as any };
  }

  it('serves the published work-items route scoped to one environment', async () => {
    const first = queue.enqueue('sess_a', 'read', { path: 'a1' });
    const second = queue.enqueue('sess_a', 'exec', { command: 'echo hi' });
    queue.enqueue('sess_b', 'read', { path: 'b1' });

    const { res, body } = await get('/v1/environments/env_a/work-items');
    expect(res.status).toBe(200);
    // env_b's item belongs to another environment and must not appear here.
    expect(body.data.map((item: { id: string }) => item.id).sort()).toEqual([first, second].sort());
    expect(body.first_id).toBe(body.data[0].id);
    expect(body.counts).toEqual({ queued: 2 });
    // The item is the shape a worker receives from the claim route.
    expect(body.data[0].sessionId).toBe('sess_a');

    // `limit` narrows the page; an unusable value falls back to the queue default.
    expect((await get('/v1/environments/env_a/work-items?limit=1')).body.data).toHaveLength(1);
    expect((await get('/v1/environments/env_a/work-items?limit=nonsense')).body.data).toHaveLength(2);

    // An unknown environment and an archived one are both refused, as the
    // neighbouring worker-key routes refuse them.
    expect((await get('/v1/environments/env_missing/work-items')).res.status).toBe(404);
    db.prepare("UPDATE environments SET archived_at = datetime('now') WHERE id = 'env_b'").run();
    expect((await get('/v1/environments/env_b/work-items')).res.status).toBe(404);
  });

  it('refuses the work-items route when this runtime has no work queue', async () => {
    const withoutQueue = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
    });

    const res = await withoutQueue.request('/v1/environments/env_a/work-items');
    expect(res.status).toBe(503);
    expect((await res.json() as any).error.type).toBe('work_queue_unavailable');
  });

  it('starts with no keys and rejects an unknown environment', async () => {
    const empty = await get('/v1/environments/env_a/worker-keys');
    expect(empty.res.status).toBe(200);
    expect(empty.body.data).toEqual([]);

    expect((await get('/v1/environments/env_missing/worker-keys')).res.status).toBe(404);
    expect((await post('/v1/environments/env_missing/worker-keys', { name: 'x' })).res.status).toBe(404);
    expect((await post('/v1/environments/env_missing/worker-keys/ewk_x/revoke')).res.status).toBe(404);
  });

  it('returns the raw secret exactly once and never lists it again', async () => {
    const created = await issueKey();
    expect(created.secret_key.startsWith('mawk_')).toBe(true);
    expect(created.status).toBe('active');
    // The stored prefix must not be the whole secret.
    expect(created.key_prefix).not.toBe(created.secret_key);
    expect(created.secret_key.startsWith(created.key_prefix.replace('...', '').slice(0, 6))).toBe(true);

    const listed = await get('/v1/environments/env_a/worker-keys');
    expect(listed.res.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].id).toBe(created.id);
    expect(listed.body.data[0].key_prefix).toBe(created.key_prefix);
    expect(listed.body.data[0].secret_key).toBeUndefined();

    // The raw key is not recoverable from storage either.
    const raw = db.prepare('SELECT * FROM environment_worker_keys WHERE id = ?').get(created.id) as Record<string, unknown>;
    expect(JSON.stringify(raw)).not.toContain(created.secret_key);
  });

  it('validates the create request', async () => {
    expect((await post('/v1/environments/env_a/worker-keys', {})).res.status).toBe(400);
    expect((await post('/v1/environments/env_a/worker-keys', { name: '   ' })).res.status).toBe(400);
    expect((await post('/v1/environments/env_a/worker-keys', { name: 'x'.repeat(81) })).res.status).toBe(400);
    expect((await post('/v1/environments/env_a/worker-keys', { name: 'k', expires_at: 'not-a-date' })).res.status).toBe(400);
    expect((await post('/v1/environments/env_a/worker-keys', { name: 'k', expires_at: null })).res.status).toBe(201);
  });

  it('scopes a claim to the environment named by the key', async () => {
    const key = await issueKey('env_a');
    queue.enqueue('sess_b', 'read', { path: 'b' });
    const forA = queue.enqueue('sess_a', 'read', { path: 'a' });

    const { res, body } = await claim({ worker_id: 'w1', environment_key: key.secret_key });
    expect(res.status).toBe(200);
    // env_b's work must not be handed to an env_a worker.
    expect(body.id).toBe(forA);
    // Which item was handed over is the assertion that matters: env_b's work
    // must not reach an env_a worker.
    expect(body.sessionId).toBe('sess_a');
  });

  it('rejects a key that does not match the requested environment', async () => {
    const key = await issueKey('env_b');
    queue.enqueue('sess_a', 'read', { path: 'a' });

    const { res, body } = await claim({ worker_id: 'w1', environment_key: key.secret_key, environment_id: 'env_a' });
    expect(res.status).toBe(400);
    expect(body.error.message).toContain('environment_key scope');
    expect(queue.list()[0].status).toBe('queued');
  });

  it('refuses an unknown key', async () => {
    const { res, body } = await claim({ worker_id: 'w1', environment_key: 'mawk_not_a_real_key' });
    expect(res.status).toBe(401);
    expect(body.error.type).toBe('unauthorized');
  });

  it('refuses a revoked key and keeps showing the revocation', async () => {
    const key = await issueKey();
    queue.enqueue('sess_a', 'read', { path: 'a' });

    const revoked = await post(`/v1/environments/env_a/worker-keys/${key.id}/revoke`);
    expect(revoked.res.status).toBe(200);
    expect(revoked.body.status).toBe('revoked');
    expect(revoked.body.revoked_at).toBeTruthy();

    const { res } = await claim({ worker_id: 'w1', environment_key: key.secret_key });
    expect(res.status).toBe(401);

    // Revocation records rather than deletes, so the key stays auditable.
    const listed = await get('/v1/environments/env_a/worker-keys');
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].status).toBe('revoked');
  });

  it('refuses an expired key', async () => {
    const key = await issueKey('env_a', { name: 'short-lived', expires_at: '2000-01-01T00:00:00.000Z' });
    queue.enqueue('sess_a', 'read', { path: 'a' });

    const { res, body } = await claim({ worker_id: 'w1', environment_key: key.secret_key });
    expect(res.status).toBe(401);
    expect(body.error.message).toContain('expired');
    expect(queue.list()[0].status).toBe('queued');
  });

  it('revoking an unknown key is a 404', async () => {
    expect((await post('/v1/environments/env_a/worker-keys/ewk_missing/revoke')).res.status).toBe(404);
  });

});
