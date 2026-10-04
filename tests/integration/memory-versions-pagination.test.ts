/**
 * `GET /v1/memory_stores/{id}/memory_versions` is paginated, as the published contract says it is.
 *
 * The documented clients walk this listing with the SDK's `autoPager()` (`记忆存储.md:999`, `:1013`),
 * and `会话操作.md:274` documents the convention: `limit` controls the page size, every response
 * carries a `next_page` cursor, and that cursor goes back as the `page` parameter. This listing
 * previously **refused** both parameters (it accepted `memory_id` only), so a client that paginated
 * was told rather than misled — the refusal is what this change replaces with the real window.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('memory version history pagination', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-memory-versions-window-'));
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
    return { status: res.status, body: await res.json() as any };
  };

  const post = (path: string, body: unknown) =>
    json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  /**
   * One store whose single memory holds three versions (created, updated, deleted) — enough history
   * for a one-item window to have somewhere to go.
   */
  const seedThreeVersions = async () => {
    const store = await post('/v1/memory_stores', { name: 'audit-store' });
    expect(store.status).toBe(201);
    const storeId = store.body.id as string;

    const created = await post(`/v1/memory_stores/${storeId}/memories`, { path: '/notes/release', content: 'first' });
    expect(created.status).toBe(201);
    const memoryId = created.body.id as string;

    const updated = await json(`/v1/memory_stores/${storeId}/memories/${memoryId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'second' }),
    });
    expect(updated.status).toBe(200);

    const removed = await json(`/v1/memory_stores/${storeId}/memories/${memoryId}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    return { storeId, memoryId };
  };

  it('windows the history and hands back a followable cursor', async () => {
    const { storeId, memoryId } = await seedThreeVersions();

    const first = await json(`/v1/memory_stores/${storeId}/memory_versions?memory_id=${memoryId}&limit=1`);
    expect(first.status).toBe(200);
    expect(first.body.data.length).toBe(1);
    expect(first.body.next_page).not.toBeNull();
    expect(first.body.prev_page).toBeNull();

    const second = await json(
      `/v1/memory_stores/${storeId}/memory_versions?memory_id=${memoryId}&limit=1&page=${encodeURIComponent(first.body.next_page)}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.data.length).toBe(1);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    // A caller that walked forward can walk back.
    expect(second.body.prev_page).not.toBeNull();

    // Walking the history through cursors reaches all three versions, newest first, each exactly once.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let step = 0; step < 6; step++) {
      const page = await json(
        `/v1/memory_stores/${storeId}/memory_versions?memory_id=${memoryId}&limit=1${cursor ? `&page=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(page.status).toBe(200);
      seen.push(page.body.data[0].operation as string);
      cursor = page.body.next_page;
      if (!cursor) break;
    }
    expect(seen).toEqual(['deleted', 'modified', 'created']);
  });

  it('keeps the memory filter inside the cursor, so a cursor cannot address another memory', async () => {
    const { storeId, memoryId } = await seedThreeVersions();
    // A second memory in the same store, so the filter is doing real work.
    const other = await post(`/v1/memory_stores/${storeId}/memories`, { path: '/notes/other', content: 'other' });
    expect(other.status).toBe(201);

    const first = await json(`/v1/memory_stores/${storeId}/memory_versions?memory_id=${memoryId}&limit=1`);
    expect(first.body.next_page).not.toBeNull();

    // The same cursor replayed under a different filter addresses a window that never existed for it.
    const replayed = await json(
      `/v1/memory_stores/${storeId}/memory_versions?memory_id=${other.body.id}&limit=1&page=${encodeURIComponent(first.body.next_page)}`,
    );
    expect(replayed.status).toBe(400);
    expect(replayed.body.error.type).toBe('invalid_request_error');
    // The wording is the shared cursor guard's, not a memory-specific one: what matters is that the\n    // cursor was refused as issued-for-a-different-query rather than silently reinterpreted.\n    expect(replayed.body.error.message).toContain('next_page');\n    expect(replayed.body.error.message).toContain('different');
  });

  it('refuses a cursor it did not issue instead of reading it as page one', async () => {
    const { storeId } = await seedThreeVersions();
    const { status, body } = await json(`/v1/memory_stores/${storeId}/memory_versions?page=not-a-cursor`);
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('page must be a cursor returned by this endpoint');
  });

  it('refuses a parameter it does not implement and names the three it does', async () => {
    const { storeId } = await seedThreeVersions();
    const { status, body } = await json(`/v1/memory_stores/${storeId}/memory_versions?foo=1`);
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('foo');
    expect(body.error.message).toContain('memory_id');
    expect(body.error.message).toContain('limit');
    expect(body.error.message).toContain('page');
  });

  it('still returns the whole history when it fits, with honest null cursors', async () => {
    const { storeId, memoryId } = await seedThreeVersions();
    const { status, body } = await json(`/v1/memory_stores/${storeId}/memory_versions?memory_id=${memoryId}`);
    expect(status).toBe(200);
    // The default page size is 20, so three versions are one complete page.
    expect(body.data.map((row: any) => row.operation)).toEqual(['deleted', 'modified', 'created']);
    expect(body.next_page).toBeNull();
    expect(body.prev_page).toBeNull();
  });
});
