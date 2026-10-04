/**
 * The collection envelope the operations surface serves under each prefix.
 *
 * `contracts/anthropic-cma/pagination.md` makes the two prefixes different on
 * purpose: canonical `/v1` collections carry `{data, prev_page, next_page}` and the
 * `/v1/x` mirror keeps the local `{data, has_more, first_id, last_id}` because it
 * has existing consumers. The operations router is mounted at both, so the shape
 * has to come from the mount rather than from the handler — one response carrying
 * both spellings is the failure mode the contract names.
 *
 * The previously-reviewed snapshot asserted this in
 * `tests/integration/canonical-collection-envelope.test.ts`; these cases cover the
 * operations collections it enumerated, which are the ones this change converts.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('operations collection envelope', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let app: ReturnType<typeof createServer>;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  /** A runtime with one row in each operations collection. */
  async function setupApp(): Promise<void> {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-operations-envelope-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_ops',
      'ops-agent',
      JSON.stringify({ name: 'ops-agent', model: 'model-test', system: 'You are a test agent.' }),
    );
    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [{ name: 'ops-agent', model: 'model-test', system: 'You are a test agent.' }],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      workspace: {
        root: tmpDir,
        dataDir: tmpDir,
        agentsDir: join(tmpDir, 'agents'),
        skillsDir: join(tmpDir, 'skills'),
        target: 'local',
      },
    });

    const webhook = await post('/v1/webhooks', {
      url: 'https://example.test/hook',
      events: ['session.created'],
    });
    expect(webhook.res.status).toBe(201);
    const schedule = await post('/v1/scheduled-deployments', {
      name: 'nightly',
      agent_id: 'agent_ops',
      cron: '0 3 * * *',
    });
    expect(schedule.res.status).toBe(201);
    const outcome = await post('/v1/outcomes', { name: 'passes', objective: 'the tests pass' });
    expect(outcome.res.status).toBe(201);
  }

  async function post(path: string, body: unknown) {
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

  /** The canonical envelope carries cursors and never the local field names. */
  function expectCanonicalPage(body: any) {
    expect(Object.keys(body).sort()).toEqual(['data', 'next_page', 'prev_page']);
    expect(body.next_page).toBeNull();
    expect(body.prev_page).toBeNull();
    expect(body).not.toHaveProperty('has_more');
  }

  it('serves the canonical envelope for the collections under /v1', async () => {
    await setupApp();

    for (const path of ['/v1/webhooks', '/v1/scheduled-deployments', '/v1/outcomes']) {
      const { res, body } = await get(path);
      expect(res.status, path).toBe(200);
      expectCanonicalPage(body);
      expect(body.data.length, path).toBeGreaterThan(0);
    }
  });

  it('serves the local envelope for the same collections on the /v1/x mirror', async () => {
    await setupApp();

    for (const path of ['/v1/x/webhooks', '/v1/x/scheduled-deployments', '/v1/x/outcomes']) {
      const { res, body } = await get(path);
      expect(res.status, path).toBe(200);
      // The extension envelope is what existing `/v1/x` consumers read.
      expect(typeof body.has_more, path).toBe('boolean');
      expect(typeof body.first_id, path).toBe('string');
      expect(typeof body.last_id, path).toBe('string');
      expect(body, path).not.toHaveProperty('prev_page');
      expect(body, path).not.toHaveProperty('next_page');
    }
  });

  it('keeps the canonical envelope and the 202 status of an action that returns a collection', async () => {
    await setupApp();

    const { res, body } = await post('/v1/webhooks/dispatch', { event: 'session.completed' });

    // A status code and an envelope are independent: the dispatch responded 202
    // before this change and still does, with the canonical shape.
    expect(res.status).toBe(202);
    expectCanonicalPage(body);
  });

  it('serves a nested collection under the same rule as its parent', async () => {
    await setupApp();
    const webhook = await get('/v1/webhooks');
    const id = webhook.body.data[0].id as string;

    const deliveries = await get(`/v1/webhooks/${id}/deliveries`);
    expect(deliveries.res.status).toBe(200);
    expectCanonicalPage(deliveries.body);

    const mirror = await get(`/v1/x/webhooks/${id}/deliveries`);
    expect(mirror.res.status).toBe(200);
    expect(mirror.body.has_more).toBe(false);
    expect(mirror.body).not.toHaveProperty('prev_page');
  });
});
