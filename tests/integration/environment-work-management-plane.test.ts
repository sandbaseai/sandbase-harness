/**
 * Integration test: the published Work API management plane.
 *
 * `GET /v1/environments/{id}/work`, `GET .../work/{workId}`, and
 * `GET .../work/stats` read the same local queue the data plane mutates.
 * These assertions pin what a management caller depends on: the list's
 * newest-first order and keyset `page` cursor, per-item retrieval under the
 * same credential scoping as the item routes, the `work_queue_stats`
 * counters' meaning on the local lease model, and the queue-authority fence
 * that keeps a session token out of all three.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { WorkQueue } from '@/sandbox/self-hosted-provider.js';
import { createServer } from '@/api/server.js';
import { createEnvironmentWorkerKey } from '@/core/auth/environment-worker-keys.js';
import { CMA_ANTHROPIC_VERSION, CMA_MANAGED_AGENTS_BETA } from '@/core/cma/compatibility.js';

const HEADERS = {
  'content-type': 'application/json',
  'anthropic-version': CMA_ANTHROPIC_VERSION,
  'anthropic-beta': CMA_MANAGED_AGENTS_BETA,
};

interface WorkBody {
  id: string;
  type: 'work';
  environment_id: string;
  state: string;
  data: { type: string; id: string };
  secret: string | null;
  created_at: string;
}

interface ListBody {
  data: WorkBody[];
  next_page: string | null;
}

interface StatsBody {
  type: 'work_queue_stats';
  depth: number;
  pending: number;
  oldest_queued_at: string | null;
  workers_polling: number | null;
}

function decodeSecret(secret: string): { sessions_token: string } {
  return JSON.parse(Buffer.from(secret, 'base64url').toString('utf8'));
}

describe('Environment work management plane', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;
  let queue: WorkQueue;
  let envKeyA: string;
  let envKeyB: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-ewmp-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_b', 'b', '', '{}', '{}')").run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id) VALUES ('sess_a', 'agent_x', 'x', 'env_a')").run();
    db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id) VALUES ('sess_a2', 'agent_x', 'x', 'env_a')").run();
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
    envKeyA = createEnvironmentWorkerKey(db, 'env_a', { name: 'worker-a' }).secret_key;
    envKeyB = createEnvironmentWorkerKey(db, 'env_b', { name: 'worker-b' }).secret_key;
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function list(envId = 'env_a', key = envKeyA, query = '') {
    return app.request(`/v1/environments/${envId}/work${query}`, {
      headers: { ...HEADERS, authorization: `Bearer ${key}` },
    });
  }

  function stats(envId = 'env_a', key = envKeyA) {
    return app.request(`/v1/environments/${envId}/work/stats`, {
      headers: { ...HEADERS, authorization: `Bearer ${key}` },
    });
  }

  async function poll(envId = 'env_a', key = envKeyA): Promise<WorkBody> {
    const res = await app.request(`/v1/environments/${envId}/work/poll`, {
      headers: { ...HEADERS, authorization: `Bearer ${key}` },
    });
    return res.json() as Promise<WorkBody>;
  }

  it('lists items newest-first in the published shape, scoped to the environment', async () => {
    const first = queue.enqueue('sess_a', 'exec', { command: 'x' });
    queue.enqueue('sess_b', 'exec', { command: 'foreign' });
    const second = queue.enqueue('sess_a2', 'read', { path: '/y' });

    const res = await list();
    expect(res.status).toBe(200);
    const body = await res.json() as ListBody;
    expect(body.data.map((w) => w.id)).toEqual([second, first]);
    expect(body.next_page).toBeNull();
    const item = body.data[0]!;
    expect(item.type).toBe('work');
    expect(item.environment_id).toBe('env_a');
    expect(item.data).toEqual({ type: 'session', id: 'sess_a2' });
    expect(item.secret).toBeNull();
  });

  it('walks every item exactly once through the page cursor', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(queue.enqueue('sess_a', 'exec', { command: `c${i}` }));

    const seen: string[] = [];
    let page: string | null = null;
    for (;;) {
      const res = await list('env_a', envKeyA, `?limit=2${page ? `&page=${page}` : ''}`);
      expect(res.status).toBe(200);
      const body = await res.json() as ListBody;
      expect(body.data.length).toBeLessThanOrEqual(2);
      seen.push(...body.data.map((w) => w.id));
      page = body.next_page;
      if (!page) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...ids].reverse());
  });

  it('keeps cursor pages stable when equal created_at timestamps collide', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(queue.enqueue('sess_a', 'exec', { command: `c${i}` }));
    // Second-precision timestamps: force every row onto one instant so the
    // rowid half of the keyset is what separates pages.
    db.prepare("UPDATE work_items SET created_at = '2026-01-01 00:00:00'").run();

    const firstPage = await (await list('env_a', envKeyA, '?limit=2')).json() as ListBody;
    const secondPage = await (await list('env_a', envKeyA, `?limit=2&page=${firstPage.next_page}`)).json() as ListBody;
    expect([...firstPage.data, ...secondPage.data].map((w) => w.id)).toEqual([...ids].reverse());
    expect(secondPage.next_page).toBeNull();
  });

  it('refuses a malformed limit and a foreign cursor', async () => {
    for (const query of ['?limit=0', '?limit=201', '?limit=1.5', '?limit=x', '?page=not-a-cursor', '?page=aGVsbG8']) {
      const res = await list('env_a', envKeyA, query);
      expect(res.status, query).toBe(400);
      expect((await res.json() as { error: { type: string } }).error.type).toBe('invalid_request_error');
    }
  });

  it('retrieves one item and hides foreign items behind 404', async () => {
    const own = queue.enqueue('sess_a', 'exec', { command: 'x' });
    const foreign = queue.enqueue('sess_b', 'exec', { command: 'y' });

    const res = await app.request(`/v1/environments/env_a/work/${own}`, {
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
    });
    expect(res.status).toBe(200);
    const work = await res.json() as WorkBody;
    expect(work.id).toBe(own);
    expect(work.state).toBe('queued');
    expect(work.secret).toBeNull();

    // A valid env_a credential asking env_b's item — even through env_b's own
    // path — cannot confirm it exists.
    const cross = await app.request(`/v1/environments/env_b/work/${foreign}`, {
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
    });
    expect(cross.status).toBe(401);
    const misplaced = await app.request(`/v1/environments/env_a/work/${foreign}`, {
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
    });
    expect(misplaced.status).toBe(404);
    const missing = await app.request(`/v1/environments/env_a/work/work_missing`, {
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
    });
    expect(missing.status).toBe(404);
  });

  it('lets a session token read its own item but no other session\'s', async () => {
    queue.enqueue('sess_a', 'exec', { command: 'x' });
    const claimed = await poll();
    const sessionsToken = decodeSecret(claimed.secret!).sessions_token;

    const own = await app.request(`/v1/environments/env_a/work/${claimed.id}`, {
      headers: { ...HEADERS, authorization: `Bearer ${sessionsToken}` },
    });
    expect(own.status).toBe(200);

    const other = queue.enqueue('sess_a2', 'exec', { command: 'y' });
    const denied = await app.request(`/v1/environments/env_a/work/${other}`, {
      headers: { ...HEADERS, authorization: `Bearer ${sessionsToken}` },
    });
    expect(denied.status).toBe(404);

    // Item authority does not extend to the queue views.
    expect((await list('env_a', sessionsToken)).status).toBe(401);
    expect((await stats('env_a', sessionsToken)).status).toBe(401);
  });

  it('counts depth, pending, oldest, and polling workers the published way', async () => {
    const unclaimed = queue.enqueue('sess_a', 'exec', { command: 'x' });
    const held = queue.enqueue('sess_a', 'exec', { command: 'y' });
    queue.enqueue('sess_b', 'exec', { command: 'foreign' });

    let body = await (await stats()).json() as StatsBody;
    expect(body.type).toBe('work_queue_stats');
    expect(body.depth).toBe(2);
    expect(body.pending).toBe(0);
    expect(body.workers_polling).toBe(0);
    expect(body.oldest_queued_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // A poll claims the older item: it leaves depth and joins pending while
    // its lease lives; the poller joins workers_polling.
    const claimed = await poll();
    expect(claimed.id).toBe(unclaimed);
    body = await (await stats()).json() as StatsBody;
    expect(body.depth).toBe(1);
    expect(body.pending).toBe(1);
    expect(body.workers_polling).toBe(1);

    // Once the claim outlives the lease the item is claimable again: back in
    // depth, out of pending.
    db.prepare("UPDATE work_items SET claimed_at = datetime('now', '-1 hour') WHERE id = ?").run(unclaimed);
    body = await (await stats()).json() as StatsBody;
    expect(body.depth).toBe(2);
    expect(body.pending).toBe(0);

    // A stopped item and a dead session's item are not queue pressure.
    queue.stopItem(held);
    db.prepare("UPDATE sessions SET status = 'completed' WHERE id = 'sess_a'").run();
    body = await (await stats()).json() as StatsBody;
    expect(body.depth).toBe(0);
    expect(body.pending).toBe(0);
    expect(body.oldest_queued_at).toBeNull();
  });

  it('scopes stats to the environment and answers 404 for an unknown one', async () => {
    queue.enqueue('sess_a', 'exec', { command: 'x' });
    queue.enqueue('sess_b', 'exec', { command: 'y' });

    expect(((await stats('env_b', envKeyB)).status)).toBe(200);
    const envB = await (await stats('env_b', envKeyB)).json() as StatsBody;
    expect(envB.depth).toBe(1);

    const foreign = await stats('env_a', envKeyB);
    expect(foreign.status).toBe(401);
    const missing = await stats('env_missing', envKeyA);
    expect(missing.status).toBe(404);
  });

  it('lets the pinned SDK decode list pages and stats', async () => {
    queue.enqueue('sess_a', 'exec', { command: 'x' });
    queue.enqueue('sess_a', 'exec', { command: 'y' });
    const client = new Anthropic({
      baseURL: 'http://conformance.local',
      apiKey: envKeyA,
      maxRetries: 0,
      fetch: async (input, init) => app.request(input, init),
    });

    const ids: string[] = [];
    for await (const work of client.beta.environments.work.list('env_a', { limit: 1 })) {
      ids.push(work.id);
    }
    expect(ids).toHaveLength(2);

    const item = await client.beta.environments.work.retrieve(ids[0]!, { environment_id: 'env_a' });
    expect(item.type).toBe('work');
    expect(item.id).toBe(ids[0]);

    const queueStats = await client.beta.environments.work.stats('env_a');
    expect(queueStats.type).toBe('work_queue_stats');
    expect(queueStats.depth).toBe(2);
    expect(queueStats.pending).toBe(0);
  });
});
