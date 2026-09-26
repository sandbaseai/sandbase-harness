/**
 * Integration test: the collections that share a timestamp still have a total order.
 *
 * Both listings state the rule and why it exists. `credential-vaults.ts:103-107`:
 * "`rowid` breaks the tie between rows created in the same second: `created_at` is
 * `datetime('now')`, so a burst of vaults shares one timestamp and the ordering
 * within that group was whatever the scan produced. A windowed listing has to slice
 * a total order - without it a page boundary can repeat or drop a row - and
 * descending `rowid` is insertion-recency, which is what the tie group means."
 * `memory-stores.ts:76-78` says it is "the same tie-break as the vault listing, for
 * the same reason".
 *
 * Nothing asserted either one. The suites for these two collections cover the
 * `include_archived` parameter they share - including the repeated-parameter refusal
 * and the wording it uses - but a single row per test never puts two rows in the same
 * tie group, so the ordering within the group, which is the whole point of the
 * tie-break, was never observed. The one place a test mentions a tie-break is
 * `session-artifacts-envelope.test.ts`, and it records the *absence* of one there.
 *
 * The rows are backdated to one literal second rather than created in a burst: two
 * inserts usually share a second but need not, and a test whose premise is "these
 * probably landed in the same second" would pass or fail on machine speed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

/** One literal second, so every seeded row is in the same tie group. */
const SAME_SECOND = '2026-09-24 12:00:00';

describe('Listing order inside one tie group', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function setUp(): ReturnType<typeof createServer> {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-listing-tie-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare(
      "INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')",
    ).run();
    return createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
    });
  }

  async function send(
    server: ReturnType<typeof createServer>,
    method: string,
    path: string,
    body?: unknown,
  ) {
    const res = await server.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) as Record<string, any> : undefined };
  }

  /** Insert three rows in a known order and put all of them in one second. */
  async function seed(
    server: ReturnType<typeof createServer>,
    prefix: string,
    table: string,
    names: string[],
  ): Promise<void> {
    for (const name of names) {
      const created = await send(server, 'POST', prefix, { name });
      expect(created.status).toBe(201);
    }
    db!.prepare(`UPDATE ${table} SET created_at = ?`).run(SAME_SECOND);
    const rows = db!.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE created_at = ?`).get(SAME_SECOND) as { n: number };
    // The premise of the assertion below: three rows really do share one timestamp.
    expect(rows.n).toBe(names.length);
  }

  /** Walk the listing one row at a time through its own cursors. */
  async function walk(server: ReturnType<typeof createServer>, prefix: string): Promise<string[]> {
    const seen: string[] = [];
    let page: string | null | undefined;
    for (let step = 0; step < 10; step++) {
      const query = `?limit=1${page ? `&page=${encodeURIComponent(page)}` : ''}`;
      const listed = await send(server, 'GET', `${prefix}${query}`);
      expect(listed.status).toBe(200);
      const data = listed.body!.data as Array<{ name: string }>;
      expect(data).toHaveLength(1);
      seen.push(data[0].name);
      page = listed.body!.next_page as string | null;
      if (!page) break;
    }
    return seen;
  }

  it('orders vaults created in the same second by insertion recency, newest first', async () => {
    const server = setUp();
    await seed(server, '/v1/vaults', 'credential_vaults', ['alpha', 'beta', 'gamma']);

    const listed = await send(server, 'GET', '/v1/vaults?limit=100');
    expect(listed.status).toBe(200);
    expect((listed.body!.data as Array<{ name: string }>).map((vault) => vault.name))
      .toEqual(['gamma', 'beta', 'alpha']);

    // The consequence the comment names: a windowed listing slices this order, so
    // paging one row at a time must visit each row exactly once, in the same order.
    expect(await walk(server, '/v1/vaults')).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('gives memory stores the same order inside the tie group', async () => {
    const server = setUp();
    await seed(server, '/v1/memory_stores', 'memory_stores', ['one', 'two', 'three']);

    const listed = await send(server, 'GET', '/v1/memory_stores?limit=100');
    expect(listed.status).toBe(200);
    expect((listed.body!.data as Array<{ name: string }>).map((store) => store.name))
      .toEqual(['three', 'two', 'one']);

    expect(await walk(server, '/v1/memory_stores')).toEqual(['three', 'two', 'one']);
  });
});
