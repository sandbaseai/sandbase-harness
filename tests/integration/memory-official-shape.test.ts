import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

/**
 * The published memory resource shape.
 *
 * `BetaManagedAgentsMemory` renames the local fields (`memory_store_id`,
 * `content_sha256`), adds `memory_version_id`, and projects `content` only
 * under `view=full`. The published update verb is `POST`, delete answers
 * `{id, type: "memory_deleted"}`, a precondition mismatch is a 409
 * `memory_precondition_failed_error`, and `memory_versions` rows can be
 * redacted — unless the version is the memory's head.
 */
describe('memory official shape', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-memory-official-shape-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      apiKeys: [],
      hasApiKeys: () => false,
      consoleRoot: null,
      runtime: { models: [], sandboxProviders: ['local'], memory: 'disabled', authEnabled: false },
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const json = async (path: string, init?: RequestInit) => {
    const res = await app.request(path, init);
    return { status: res.status, body: (await res.json()) as any };
  };

  const post = (path: string, body: unknown) =>
    json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  async function createStore(): Promise<string> {
    const { status, body } = await post('/v1/memory_stores', { name: 'shape-store' });
    expect(status).toBe(201);
    return body.id;
  }

  async function createMemory(storeId: string, path = '/notes/a', content = 'alpha') {
    const { status, body } = await post(`/v1/memory_stores/${storeId}/memories`, { path, content });
    expect(status).toBe(201);
    return body;
  }

  const sha256 = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');

  it('projects the published key set on every memory response', async () => {
    const storeId = await createStore();
    const memory = await createMemory(storeId);

    // The published object: no `store_id`, `content_hash`, `metadata`, or
    // `archived_at` — and `content` is null under the default `basic` view.
    expect(Object.keys(memory).sort()).toEqual([
      'content',
      'content_sha256',
      'content_size_bytes',
      'created_at',
      'id',
      'memory_store_id',
      'memory_version_id',
      'path',
      'type',
      'updated_at',
    ]);
    expect(memory.type).toBe('memory');
    expect(memory.memory_store_id).toBe(storeId);
    expect(memory.memory_version_id).toMatch(/^memver_/);
    expect(memory.content).toBeNull();
    expect(memory.content_sha256).toBe(sha256('alpha'));
    expect(memory.content_size_bytes).toBe(Buffer.byteLength('alpha', 'utf8'));
  });

  it('lists memories under view=basic with null content, and under view=full with content', async () => {
    const storeId = await createStore();
    await createMemory(storeId, '/notes/basic', 'basic-body');

    const basic = await json(`/v1/memory_stores/${storeId}/memories`);
    expect(basic.status).toBe(200);
    expect(basic.body.data[0].content).toBeNull();
    expect(basic.body.data[0].content_sha256).toBe(sha256('basic-body'));

    const full = await json(`/v1/memory_stores/${storeId}/memories?view=full`);
    expect(full.body.data[0].content).toBe('basic-body');

    const bad = await json(`/v1/memory_stores/${storeId}/memories?view=everything`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.type).toBe('invalid_request_error');
  });

  it('retrieves a memory with content by default and without it under view=basic', async () => {
    const storeId = await createStore();
    const memory = await createMemory(storeId);

    const retrieved = await json(`/v1/memory_stores/${storeId}/memories/${memory.id}`);
    expect(retrieved.status).toBe(200);
    expect(retrieved.body.content).toBe('alpha');

    const basic = await json(`/v1/memory_stores/${storeId}/memories/${memory.id}?view=basic`);
    expect(basic.body.content).toBeNull();
    expect(basic.body.content_sha256).toBe(sha256('alpha'));

    const missing = await json(`/v1/memory_stores/${storeId}/memories/mem_missing`);
    expect(missing.status).toBe(404);
  });

  it('updates through the published POST verb and keeps PUT as the alias', async () => {
    const storeId = await createStore();
    const memory = await createMemory(storeId);

    const posted = await post(`/v1/memory_stores/${storeId}/memories/${memory.id}`, { content: 'posted' });
    expect(posted.status).toBe(200);

    const put = await json(`/v1/memory_stores/${storeId}/memories/${memory.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'put' }) });
    expect(put.status).toBe(200);

    const retrieved = await json(`/v1/memory_stores/${storeId}/memories/${memory.id}`);
    expect(retrieved.body.content).toBe('put');
  });

  it('answers a precondition mismatch with 409 memory_precondition_failed_error', async () => {
    const storeId = await createStore();
    const memory = await createMemory(storeId);

    const failed = await post(`/v1/memory_stores/${storeId}/memories/${memory.id}`, {
      content: 'new',
      precondition: { type: 'content_sha256', content_sha256: sha256('stale') },
    });
    expect(failed.status).toBe(409);
    expect(failed.body.error.type).toBe('memory_precondition_failed_error');
    expect(failed.body.error.current_content_sha256).toBe(sha256('alpha'));

    const ok = await post(`/v1/memory_stores/${storeId}/memories/${memory.id}`, {
      content: 'new',
      precondition: { type: 'content_sha256', content_sha256: sha256('alpha') },
    });
    expect(ok.status).toBe(200);
  });

  it('answers 200 instead of 409 when the failed precondition still matches the requested write', async () => {
    const storeId = await createStore();
    const memory = await createMemory(storeId, '/notes/same', 'same-content');

    const res = await post(`/v1/memory_stores/${storeId}/memories/${memory.id}`, {
      content: 'same-content',
      path: '/notes/same',
      precondition: { type: 'content_sha256', content_sha256: sha256('never-stored') },
    });
    // The stored state already equals the requested write, so the contract
    // answers the memory rather than the precondition failure.
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(memory.id);
  });

  it('deletes with the published tombstone and honors expected_content_sha256', async () => {
    const storeId = await createStore();
    const memory = await createMemory(storeId);

    const refused = await json(
      `/v1/memory_stores/${storeId}/memories/${memory.id}?expected_content_sha256=${sha256('stale')}`,
      { method: 'DELETE' },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.type).toBe('memory_precondition_failed_error');

    const deleted = await json(
      `/v1/memory_stores/${storeId}/memories/${memory.id}?expected_content_sha256=${sha256('alpha')}`,
      { method: 'DELETE' },
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ id: memory.id, type: 'memory_deleted' });
  });

  it('answers a path conflict with the published memory_path_conflict_error', async () => {
    const storeId = await createStore();
    const memory = await createMemory(storeId, '/notes/taken', 'first');

    const res = await post(`/v1/memory_stores/${storeId}/memories`, { path: '/notes/taken', content: 'second' });
    expect(res.status).toBe(409);
    expect(res.body.error.type).toBe('memory_path_conflict_error');
    expect(res.body.error.conflicting_path).toBe('/notes/taken');
    expect(res.body.error.conflicting_memory_id).toBe(memory.id);
  });

  it('projects versions under the published vocabulary with view-aware content', async () => {
    const storeId = await createStore();
    const memory = await createMemory(storeId, '/notes/versioned', 'v1');
    await post(`/v1/memory_stores/${storeId}/memories/${memory.id}`, { content: 'v2' });

    const listed = await json(`/v1/memory_stores/${storeId}/memory_versions?memory_id=${memory.id}`);
    expect(listed.status).toBe(200);
    // Published fields only: no `store_id`, `version`, `change`, or `session_id`.
    expect(Object.keys(listed.body.data[0]).sort()).toEqual([
      'content',
      'content_sha256',
      'content_size_bytes',
      'created_at',
      'created_by',
      'id',
      'memory_id',
      'memory_store_id',
      'operation',
      'path',
      'redacted_at',
      'type',
    ]);
    expect(listed.body.data.map((row: any) => row.operation)).toEqual(['modified', 'created']);
    expect(listed.body.data[0].content).toBeNull();
    expect(listed.body.data[0].memory_store_id).toBe(storeId);

    const full = await json(`/v1/memory_stores/${storeId}/memory_versions?memory_id=${memory.id}&view=full`);
    expect(full.body.data[0].content).toBe('v2');
    expect(full.body.data[1].content).toBe('v1');

    const filtered = await json(`/v1/memory_stores/${storeId}/memory_versions?operation=modified`);
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0].operation).toBe('modified');

    const badOp = await json(`/v1/memory_stores/${storeId}/memory_versions?operation=rewritten`);
    expect(badOp.status).toBe(400);
  });

  it('nulls the payload fields on a deleted version', async () => {
    const storeId = await createStore();
    const memory = await createMemory(storeId);
    await json(`/v1/memory_stores/${storeId}/memories/${memory.id}`, { method: 'DELETE' });

    const listed = await json(`/v1/memory_stores/${storeId}/memory_versions?memory_id=${memory.id}&view=full`);
    const deleted = listed.body.data.find((row: any) => row.operation === 'deleted');
    expect(deleted.content).toBeNull();
    expect(deleted.content_sha256).toBeNull();
    expect(deleted.content_size_bytes).toBeNull();
    expect(deleted.path).toBe('/notes/a');
  });

  it('redacts a non-head version and refuses the head version', async () => {
    const storeId = await createStore();
    const memory = await createMemory(storeId, '/notes/redact', 'v1-secret');
    await post(`/v1/memory_stores/${storeId}/memories/${memory.id}`, { content: 'v2-public' });

    const listed = await json(`/v1/memory_stores/${storeId}/memory_versions?memory_id=${memory.id}`);
    const [head, first] = listed.body.data;

    // The head carries the memory's live content — redacting it is a 409.
    const refused = await post(`/v1/memory_stores/${storeId}/memory_versions/${head.id}/redact`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('memory_version_is_head');

    // The older version redacts: payload fields null, `redacted_at` set, the
    // row itself still retrievable.
    const redacted = await post(`/v1/memory_stores/${storeId}/memory_versions/${first.id}/redact`, {});
    expect(redacted.status).toBe(200);
    expect(redacted.body.type).toBe('memory_version');
    expect(redacted.body.content).toBeNull();
    expect(redacted.body.content_sha256).toBeNull();
    expect(redacted.body.content_size_bytes).toBeNull();
    expect(redacted.body.path).toBeNull();
    expect(redacted.body.redacted_at).not.toBeNull();

    const retrieved = await json(`/v1/memory_stores/${storeId}/memory_versions/${first.id}`);
    expect(retrieved.body.redacted_at).not.toBeNull();
    expect(retrieved.body.content).toBeNull();

    // The live memory is untouched.
    const still = await json(`/v1/memory_stores/${storeId}/memories/${memory.id}`);
    expect(still.body.content).toBe('v2-public');
  });
});
