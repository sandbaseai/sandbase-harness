import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

/**
 * The published memory-store update and delete routes.
 *
 * `POST /memory_stores/{id}` patches name, description, and metadata;
 * `DELETE /memory_stores/{id}` physically removes the store together with its
 * memory and version rows and answers `{id, type: "memory_store_deleted"}`.
 * Two guards gate the delete — a live session mount is a 409, and an archived
 * store is read-only, so every write to it is a 409 rather than a 404.
 */
describe('memory store update and delete', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-memstore-update-delete-'));
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

  async function createStore(name = 'store-one'): Promise<string> {
    const res = await app.request('/v1/memory_stores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: 'original', metadata: { keep: '1', drop: '2' } }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function call(method: string, path: string, body?: unknown) {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { res, body: (await res.json()) as any };
  }

  function mountSession(status: string, storeId: string) {
    db.prepare("INSERT OR IGNORE INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    db.prepare(
      "INSERT INTO sessions (id, agent_id, agent_name, agent_version, environment_id, status) VALUES (?, 'agent_x', 'x', 1, 'env_default', ?)",
    ).run(`sess_${status}`, status);
    db.prepare(
      "INSERT INTO session_resource_instances (id, session_id, resource_type, position, config, created_at, updated_at) VALUES (?, ?, 'memory_store', 0, ?, '2026-03-01 00:00:01', '2026-03-01 00:00:01')",
    ).run(`sri_${status}`, `sess_${status}`, JSON.stringify({ type: 'memory_store', memory_store_id: storeId }));
  }

  it('updates name, clears description, and merges the metadata patch', async () => {
    const id = await createStore();

    const { res, body } = await call('POST', `/v1/memory_stores/${id}`, {
      name: 'store-renamed',
      description: '',
      metadata: { drop: null, added: '3' },
    });

    expect(res.status).toBe(200);
    expect(body.name).toBe('store-renamed');
    expect(body.description).toBe('');
    expect(body.metadata).toEqual({ keep: '1', added: '3' });
  });

  it('preserves omitted fields and clears description on null', async () => {
    const id = await createStore();

    const { body } = await call('POST', `/v1/memory_stores/${id}`, { description: null });

    expect(body.name).toBe('store-one');
    expect(body.description).toBe('');
    expect(body.metadata).toEqual({ keep: '1', drop: '2' });
  });

  it('answers the same patch over the PUT alias', async () => {
    const id = await createStore();
    const { res, body } = await call('PUT', `/v1/memory_stores/${id}`, { name: 'via-put' });
    expect(res.status).toBe(200);
    expect(body.name).toBe('via-put');
  });

  it('refuses an update on a missing or archived store', async () => {
    const { res: missing } = await call('POST', '/v1/memory_stores/memstore_nope', { name: 'x' });
    expect(missing.status).toBe(404);

    const id = await createStore();
    await call('POST', `/v1/memory_stores/${id}/archive`);
    const { res, body } = await call('POST', `/v1/memory_stores/${id}`, { name: 'still-readonly' });
    expect(res.status).toBe(409);
    expect(body.error.code).toBe('memory_store_archived');
  });

  it('refuses a name outside the published bound', async () => {
    const id = await createStore();
    const { res: tooLong } = await call('POST', `/v1/memory_stores/${id}`, { name: 'x'.repeat(256) });
    expect(tooLong.status).toBe(400);
    const { res: control } = await call('POST', `/v1/memory_stores/${id}`, { name: 'has\nline' });
    expect(control.status).toBe(400);
  });

  it('deletes a store and cascades over its memory and version rows', async () => {
    const id = await createStore();
    const { res: wrote } = await call('POST', `/v1/memory_stores/${id}/memories`, {
      path: '/notes/a',
      content: 'hello',
    });
    expect(wrote.status).toBe(201);

    const { res, body } = await call('DELETE', `/v1/memory_stores/${id}`);
    expect(res.status).toBe(200);
    expect(body).toEqual({ id, type: 'memory_store_deleted' });

    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM memory_records WHERE store_id = ?').get(id) as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM memory_versions WHERE store_id = ?').get(id) as { n: number }).n,
    ).toBe(0);
    const { res: after } = await call('GET', `/v1/memory_stores/${id}`);
    expect(after.status).toBe(404);
  });

  it('refuses to delete while a non-terminal session mounts the store', async () => {
    const id = await createStore();
    mountSession('running', id);

    const { res, body } = await call('DELETE', `/v1/memory_stores/${id}`);
    expect(res.status).toBe(409);
    expect(body.error.code).toBe('memory_store_in_use');
    expect(db.prepare('SELECT id FROM memory_stores WHERE id = ?').get(id)).toBeDefined();
  });

  it('deletes a store whose only mounts belong to terminal sessions', async () => {
    const id = await createStore();
    mountSession('completed', id);

    const { res } = await call('DELETE', `/v1/memory_stores/${id}`);
    expect(res.status).toBe(200);
  });

  it('answers 404 when deleting a store that does not exist', async () => {
    const { res } = await call('DELETE', '/v1/memory_stores/memstore_nope');
    expect(res.status).toBe(404);
  });

  it('treats an archived store as read-only for every memory write', async () => {
    const id = await createStore();
    const { body: memory } = await call('POST', `/v1/memory_stores/${id}/memories`, {
      path: '/notes/a',
      content: 'hello',
    });
    await call('POST', `/v1/memory_stores/${id}/archive`);

    for (const [method, path] of [
      ['POST', `/v1/memory_stores/${id}/memories`],
      ['PUT', `/v1/memory_stores/${id}/memories/${memory.id}`],
      ['DELETE', `/v1/memory_stores/${id}/memories/${memory.id}`],
    ] as const) {
      const { res, body } = await call(method, path, method === 'DELETE' ? undefined : { path: '/notes/b', content: 'x' });
      expect(res.status).toBe(409);
      expect(body.error.code).toBe('memory_store_archived');
    }
  });
});
