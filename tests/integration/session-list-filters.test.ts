/**
 * `GET /v1/sessions` filter behaviour: every published parameter is exercised
 * over the real route, including the two `statuses` spellings, the archived
 * default, and the cursor's binding to `order` and `created_at[*]` only.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createLogger, InMemoryLogStore } from '@/core/observability/logger.js';
import { createServer } from '@/api/server.js';

describe('GET /v1/sessions filters', () => {
  let app: ReturnType<typeof createServer>;
  let db: Database;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-session-filters-'));
    const agentsDir = join(tmpDir, 'agents');
    const skillsDir = join(tmpDir, 'skills');
    const dataDir = join(tmpDir, '.managed-agents');
    const configPath = join(dataDir, 'config.yaml');
    for (const dir of [agentsDir, skillsDir, dataDir]) mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, 'model:\n  provider: openai\n  api_key: secret-value\n');

    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES
      ('agent_filter', 'filter-agent', '{}'),
      ('agent_other', 'other-agent', '{}')`);

    const sessionManager = new SessionManager(db);
    const logStore = new InMemoryLogStore();
    const logger = createLogger({ level: 'debug', logStore, write: () => undefined });
    app = createServer({
      db,
      sessionManager,
      agents: [],
      consoleRoot: null,
      workspace: { root: tmpDir, dataDir, agentsDir, skillsDir, configPath, target: 'local' },
      runtime: { models: [], sandboxProviders: ['local'], memory: 'disabled', authEnabled: false },
      skills: [],
      logger,
      logStore,
      restart: () => undefined,
      listRuntimeModels: () => [],
      registerModelProvider: () => undefined,
      setDefaultRuntimeModel: () => undefined,
      reloadAgents: () => ({ agents: [], errors: [] }),
    });

    const insert = db.prepare(
      "INSERT INTO sessions (id, agent_id, agent_name, agent_version, environment_id, status, created_at, updated_at, archived_at) VALUES (?, ?, 'filter-agent', ?, 'env_default', ?, ?, ?, ?)",
    );
    insert.run('sess_a', 'agent_filter', 1, 'paused', '2026-03-01 00:00:01', '2026-03-01 00:00:01', null);
    insert.run('sess_b', 'agent_filter', 2, 'running', '2026-03-02 00:00:01', '2026-03-02 00:00:01', null);
    insert.run('sess_c', 'agent_other', 1, 'completed', '2026-03-03 00:00:01', '2026-03-03 00:00:01', null);
    insert.run('sess_archived', 'agent_filter', 1, 'archived', '2026-03-04 00:00:01', '2026-03-04 00:00:01', '2026-03-04 00:00:01');

    db.prepare(
      "INSERT INTO session_resource_instances (id, session_id, resource_type, position, mount_path, config, created_at, updated_at) VALUES ('sri_1', 'sess_a', 'memory_store', 0, '/mnt/memory/main', ?, '2026-03-01 00:00:01', '2026-03-01 00:00:01')",
    ).run(JSON.stringify({ type: 'memory_store', memory_store_id: 'memstore_main' }));

    db.exec("INSERT INTO scheduled_deployments (id, name, agent_id, cron) VALUES ('sched_1', 'nightly', 'agent_filter', '0 0 * * *')");
    db.exec("INSERT INTO scheduled_deployment_runs (id, schedule_id, session_id, status, trigger_type) VALUES ('sdr_1', 'sched_1', 'sess_b', 'completed', 'scheduled')");
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function listIds(query: string): Promise<string[]> {
    const res = await app.request(`/v1/sessions?${query}`);
    expect(res.status).toBe(200);
    return (await res.json()).data.map((session: { id: string }) => session.id);
  }

  it('filters by agent_id, and by agent_version only when agent_id is set', async () => {
    expect(await listIds('agent_id=agent_filter')).toEqual(['sess_b', 'sess_a']);
    expect(await listIds('agent_id=agent_filter&agent_version=1')).toEqual(['sess_a']);
    // A version without an agent is ignored rather than refused or applied.
    expect(await listIds('agent_version=2')).toEqual(['sess_c', 'sess_b', 'sess_a']);
  });

  it('rejects a non-integer agent_version', async () => {
    const res = await app.request('/v1/sessions?agent_id=agent_filter&agent_version=abc');
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('agent_version');
  });

  it('accepts both statuses spellings and repeats, matching the public grouping', async () => {
    expect(await listIds('statuses=idle')).toEqual(['sess_a']);
    expect(await listIds('statuses[]=idle')).toEqual(['sess_a']);
    expect(await listIds('statuses=idle&statuses[]=running')).toEqual(['sess_b', 'sess_a']);
    expect(await listIds('statuses[]=terminated')).toEqual(['sess_c']);
    // Nothing internal projects to rescheduling yet, but it is a valid value.
    expect(await listIds('statuses[]=rescheduling')).toEqual([]);
  });

  it('rejects a statuses value outside the published set, and the removed status parameter', async () => {
    const bad = await app.request('/v1/sessions?statuses[]=bogus');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toContain('"bogus"');

    const legacy = await app.request('/v1/sessions?status=idle');
    expect(legacy.status).toBe(400);
    expect((await legacy.json()).error.message).toContain('Unknown query parameter');
  });

  it('orders by created_at in the requested direction', async () => {
    expect(await listIds('order=asc')).toEqual(['sess_a', 'sess_b', 'sess_c']);
    expect(await listIds('order=desc')).toEqual(['sess_c', 'sess_b', 'sess_a']);
    const bad = await app.request('/v1/sessions?order=sideways');
    expect(bad.status).toBe(400);
  });

  it('excludes archived sessions by default and includes them on request', async () => {
    expect(await listIds('')).toEqual(['sess_c', 'sess_b', 'sess_a']);
    expect(await listIds('include_archived=true')).toEqual(['sess_archived', 'sess_c', 'sess_b', 'sess_a']);
    const bad = await app.request('/v1/sessions?include_archived=yes');
    expect(bad.status).toBe(400);
  });

  it('filters by the attached memory store and by the creating deployment', async () => {
    expect(await listIds('memory_store_id=memstore_main')).toEqual(['sess_a']);
    expect(await listIds('memory_store_id=memstore_other')).toEqual([]);
    expect(await listIds('deployment_id=sched_1')).toEqual(['sess_b']);
    expect(await listIds('deployment_id=sched_missing')).toEqual([]);
  });

  it('filters by creation-time bounds and rejects unparseable ones', async () => {
    expect(await listIds('created_at[gte]=2026-03-02T00:00:00Z')).toEqual(['sess_c', 'sess_b']);
    expect(await listIds('created_at[gt]=2026-03-02T00:00:01Z')).toEqual(['sess_c']);
    expect(await listIds('created_at[lt]=2026-03-02T00:00:00Z')).toEqual(['sess_a']);
    expect(await listIds('created_at[lte]=2026-03-01T00:00:02Z&created_at[gte]=2026-03-01T00:00:00Z')).toEqual(['sess_a']);
    const bad = await app.request('/v1/sessions?created_at[gt]=not-a-date');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toContain('created_at[gt]');
  });
});
