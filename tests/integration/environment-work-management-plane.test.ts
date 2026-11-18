/**
 * Integration test: the published Work API management plane.
 *
 * `GET /v1/environments/{id}/work`, `GET .../work/{workId}`, and
 * `GET .../work/stats` read the same session-claim store the data plane
 * mutates. These assertions pin what a management caller depends on: the
 * list's newest-first order and keyset `page` cursor, per-claim retrieval
 * under the same credential scoping as the claim routes, the
 * `work_queue_stats` counters' meaning on the claim lease model, and the
 * queue-authority fence that keeps a session token out of all three.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { SessionWorkQueue } from '@/sandbox/session-work-queue.js';
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
  let sessionQueue: SessionWorkQueue;
  let envKeyA: string;
  let envKeyB: string;

  function addSession(id: string, envId: string, status = 'running') {
    db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id, status) VALUES (?, 'agent_x', 'x', ?, ?)")
      .run(id, envId, status);
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-ewmp-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_b', 'b', '', '{}', '{}')").run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    addSession('sess_a', 'env_a');
    addSession('sess_a2', 'env_a');
    addSession('sess_b', 'env_b');

    sessionQueue = new SessionWorkQueue(db);
    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      sessionWorkQueue: sessionQueue,
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

  it('lists claims newest-first in the published shape, scoped to the environment', async () => {
    const first = sessionQueue.ensure('sess_a')!;
    sessionQueue.ensure('sess_b');
    const second = sessionQueue.ensure('sess_a2')!;

    const res = await list();
    expect(res.status).toBe(200);
    const body = await res.json() as ListBody;
    expect(body.data.map((w) => w.id)).toEqual([second.id, first.id]);
    expect(body.next_page).toBeNull();
    const item = body.data[0]!;
    expect(item.type).toBe('work');
    expect(item.environment_id).toBe('env_a');
    expect(item.data).toEqual({ type: 'session', id: 'sess_a2' });
    expect(item.secret).toBeNull();
  });

  it('walks every claim exactly once through the page cursor', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      addSession(`sess_p${i}`, 'env_a');
      ids.push(sessionQueue.ensure(`sess_p${i}`)!.id);
    }

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
    for (let i = 0; i < 4; i += 1) {
      addSession(`sess_t${i}`, 'env_a');
      ids.push(sessionQueue.ensure(`sess_t${i}`)!.id);
    }
    // Second-precision timestamps: force every row onto one instant so the
    // rowid half of the keyset is what separates pages.
    db.prepare("UPDATE session_work_claims SET created_at = '2026-01-01 00:00:00'").run();

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

  it('retrieves one claim and hides foreign claims behind 404', async () => {
    const own = sessionQueue.ensure('sess_a')!;
    const foreign = sessionQueue.ensure('sess_b')!;

    const res = await app.request(`/v1/environments/env_a/work/${own.id}`, {
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
    });
    expect(res.status).toBe(200);
    const work = await res.json() as WorkBody;
    expect(work.id).toBe(own.id);
    expect(work.state).toBe('queued');
    expect(work.secret).toBeNull();

    // A valid env_a credential asking env_b's claim — even through env_b's own
    // path — cannot confirm it exists.
    const cross = await app.request(`/v1/environments/env_b/work/${foreign.id}`, {
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
    });
    expect(cross.status).toBe(401);
    const misplaced = await app.request(`/v1/environments/env_a/work/${foreign.id}`, {
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
    });
    expect(misplaced.status).toBe(404);
    const missing = await app.request(`/v1/environments/env_a/work/work_missing`, {
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
    });
    expect(missing.status).toBe(404);
  });

  it('lets a session token read its own claim but no other session\'s', async () => {
    sessionQueue.ensure('sess_a');
    const claimed = await poll();
    const sessionsToken = decodeSecret(claimed.secret!).sessions_token;

    const own = await app.request(`/v1/environments/env_a/work/${claimed.id}`, {
      headers: { ...HEADERS, authorization: `Bearer ${sessionsToken}` },
    });
    expect(own.status).toBe(200);

    const other = sessionQueue.ensure('sess_a2')!;
    const denied = await app.request(`/v1/environments/env_a/work/${other.id}`, {
      headers: { ...HEADERS, authorization: `Bearer ${sessionsToken}` },
    });
    expect(denied.status).toBe(404);

    // Item authority does not extend to the queue views.
    expect((await list('env_a', sessionsToken)).status).toBe(401);
    expect((await stats('env_a', sessionsToken)).status).toBe(401);
  });

  it('counts depth, pending, oldest, and polling workers the published way', async () => {
    const unclaimed = sessionQueue.ensure('sess_a')!;
    const held = sessionQueue.ensure('sess_a2')!;
    sessionQueue.ensure('sess_b'); // another environment — out of scope

    let body = await (await stats()).json() as StatsBody;
    expect(body.type).toBe('work_queue_stats');
    expect(body.depth).toBe(2);
    expect(body.pending).toBe(0);
    expect(body.workers_polling).toBe(0);
    expect(body.oldest_queued_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // A poll claims the older claim: it leaves depth and joins pending while
    // its lease lives; the poller joins workers_polling.
    const claimed = await poll();
    expect(claimed.id).toBe(unclaimed.id);
    body = await (await stats()).json() as StatsBody;
    expect(body.depth).toBe(1);
    expect(body.pending).toBe(1);
    expect(body.workers_polling).toBe(1);

    // Once the claim outlives the reclaim window it is claimable again: back
    // in depth, out of pending.
    db.prepare("UPDATE session_work_claims SET claimed_at = datetime('now', '-1 hour') WHERE id = ?").run(unclaimed.id);
    body = await (await stats()).json() as StatsBody;
    expect(body.depth).toBe(2);
    expect(body.pending).toBe(0);

    // A stopped claim and a dead session's claim are not queue pressure.
    sessionQueue.stop(held.id, true);
    db.prepare("UPDATE sessions SET status = 'completed' WHERE id = 'sess_a'").run();
    body = await (await stats()).json() as StatsBody;
    expect(body.depth).toBe(0);
    expect(body.pending).toBe(0);
    expect(body.oldest_queued_at).toBeNull();
  });

  it('scopes stats to the environment and answers 404 for an unknown one', async () => {
    sessionQueue.ensure('sess_a');
    sessionQueue.ensure('sess_b');

    expect(((await stats('env_b', envKeyB)).status)).toBe(200);
    const envB = await (await stats('env_b', envKeyB)).json() as StatsBody;
    expect(envB.depth).toBe(1);

    const foreign = await stats('env_a', envKeyB);
    expect(foreign.status).toBe(401);
    const missing = await stats('env_missing', envKeyA);
    expect(missing.status).toBe(404);
  });

  it('lets the pinned SDK decode list pages and stats', async () => {
    sessionQueue.ensure('sess_a');
    sessionQueue.ensure('sess_a2');
    const client = new Anthropic({
      baseURL: 'http://conformance.local',
      apiKey: envKeyA,
      maxRetries: 0,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.headers.has('x-api-key')) {
          request.headers.delete('authorization');
        }
        return app.request(request);
      },
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
