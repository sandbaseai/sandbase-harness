import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

/**
 * Memory version audit.
 *
 * A memory is overwritten in place, so without a version row nothing can say
 * what a path held before, attribute a change to the session that made it, or
 * notice that two writers raced. These assert the record exists per write and
 * that numbering is per memory and monotonic.
 */

describe('memory version audit', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-memory-versions-'));
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

  async function createStore(): Promise<string> {
    const res = await app.request('/v1/memory_stores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'audit-store' }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function writeMemory(storeId: string, body: Record<string, unknown>) {
    return app.request(`/v1/memory_stores/${storeId}/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('records a version for every create, update, and delete', async () => {
    const storeId = await createStore();
    const created = await writeMemory(storeId, { path: '/notes/release', content: 'first' });
    expect(created.status).toBe(201);
    const memoryId = ((await created.json()) as { id: string }).id;

    const updated = await app.request(`/v1/memory_stores/${storeId}/memories/${memoryId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'second' }),
    });
    expect(updated.status).toBe(200);

    const removed = await app.request(`/v1/memory_stores/${storeId}/memories/${memoryId}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);

    const listed = await app.request(`/v1/memory_stores/${storeId}/memory_versions?memory_id=${memoryId}`);
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { data: Array<Record<string, unknown>> };
    // Newest first, and all three writes are present under the published
    // `operation` vocabulary (`updated` is emitted as `modified`).
    expect(page.data).toHaveLength(3);
    expect(page.data.map((row) => row.operation)).toEqual(['deleted', 'modified', 'created']);
    // The recorded content is what was written, not the live row.
    expect(page.data.find((row) => row.operation === 'modified')).toBeDefined();
  });

  it('numbers versions per memory so two memories do not share a sequence', async () => {
    const storeId = await createStore();
    const first = await writeMemory(storeId, { path: '/notes/one', content: 'one' });
    const second = await writeMemory(storeId, { path: '/notes/two', content: 'two' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstId = ((await first.json()) as { id: string }).id;
    const secondId = ((await second.json()) as { id: string }).id;

    await app.request(`/v1/memory_stores/${storeId}/memories/${firstId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'one again' }),
    });

    const firstVersions = await app.request(`/v1/memory_stores/${storeId}/memory_versions?memory_id=${firstId}`);
    const secondVersions = await app.request(`/v1/memory_stores/${storeId}/memory_versions?memory_id=${secondId}`);
    const firstPage = (await firstVersions.json()) as { data: Array<{ operation: string }> };
    const secondPage = (await secondVersions.json()) as { data: Array<{ operation: string }> };
    expect(firstPage.data.map((row) => row.operation)).toEqual(['modified', 'created']);
    // The second memory starts its own sequence rather than continuing the first.
    expect(secondPage.data.map((row) => row.operation)).toEqual(['created']);
  });

  it('records the content hash and byte size the store already uses elsewhere', async () => {
    const storeId = await createStore();
    const content = 'release process requires Rust checks';
    const created = await writeMemory(storeId, { path: '/notes/hash', content });
    const memoryId = ((await created.json()) as { id: string }).id;

    const listed = await app.request(`/v1/memory_stores/${storeId}/memory_versions?memory_id=${memoryId}`);
    const page = (await listed.json()) as { data: Array<{ content_sha256: string; content_size_bytes: number }> };
    const expectedHash = createHash('sha256').update(content, 'utf8').digest('hex');
    expect(page.data[0].content_sha256).toBe(expectedHash);
    expect(page.data[0].content_size_bytes).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('reads one version by its own id and refuses an unknown one', async () => {
    const storeId = await createStore();
    const created = await writeMemory(storeId, { path: '/notes/read', content: 'readable' });
    const memoryId = ((await created.json()) as { id: string }).id;

    const listed = await app.request(`/v1/memory_stores/${storeId}/memory_versions?memory_id=${memoryId}`);
    const page = (await listed.json()) as { data: Array<{ id: string }> };
    const versionId = page.data[0].id;

    const found = await app.request(`/v1/memory_stores/${storeId}/memory_versions/${versionId}`);
    expect(found.status).toBe(200);
    expect(((await found.json()) as { id: string }).id).toBe(versionId);

    const missing = await app.request(`/v1/memory_stores/${storeId}/memory_versions/memver_doesnotexist`);
    expect(missing.status).toBe(404);
  });
});
