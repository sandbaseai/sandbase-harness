/**
 * An omitted `effort` is resolved to the model's documented default at save
 * time, so the stored definition is self-describing rather than inheriting a
 * runtime/provider fallback.
 *
 * The published service fills `model` fields the caller omits — the official
 * response for a bare `claude-opus-5-5` create returns `effort: {type:
 * "medium"}` — and the published effort page fixes the per-model rule:
 * `medium` on Claude Opus 5.5 and Claude Haiku 5.5, `high` on every other
 * model that accepts effort, and no level on a model that takes none or that
 * the capability table does not know.
 *
 * What this suite pins:
 *
 * - the fill lands on the **stored** profile, so every read — the agent read,
 *   the version read, and the frozen session snapshot — reports the same
 *   level the runtime will execute;
 * - an explicit `effort` always wins over the default;
 * - the update path obeys the published exception: an unchanged model `id`
 *   keeps its stored effort when the update omits it, while a changed `id`
 *   resets to the new model's default;
 * - a model the capability table does not cover is not given an invented
 *   level — `effort` stays absent.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '@/api/server.js';
import { Database } from '@/core/db/database.js';
import { SessionManager, type SessionExecutor } from '@/core/session/session-manager.js';
import type { AgentDefinition } from '@/types/agent.js';

function createTestApp() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ma-agent-effort-default-'));
  const db = new Database(join(tmpDir, 'test.db'));
  db.runMigrations();
  db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);

  const sessionManager = new SessionManager(db);
  const executor: SessionExecutor = { async *execute() {} };
  sessionManager.setExecutor(executor);

  const agents: AgentDefinition[] = [];
  const app = createServer({
    db,
    sessionManager,
    agents,
    reloadAgents: () => ({ agents: [], errors: [] }),
  });
  return { app, db, tmpDir };
}

type TestContext = ReturnType<typeof createTestApp>;
const contexts: TestContext[] = [];

function context(): TestContext {
  const created = createTestApp();
  contexts.push(created);
  return created;
}

afterEach(() => {
  for (const opened of contexts.splice(0)) {
    opened.db.close();
    rmSync(opened.tmpDir, { recursive: true, force: true });
  }
});

async function request(app: ReturnType<typeof createServer>, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { res, body: await res.json() as any };
}

describe('the save-time effort default', () => {
  it('stores `medium` on Claude Opus 5.5 when `effort` is omitted', async () => {
    const ctx = context();
    const created = await request(ctx.app, 'POST', '/v1/agents', {
      name: 'Default effort agent',
      model: 'claude-opus-5-5',
      system: 'p',
    });
    expect(created.res.status).toBe(201);
    expect(created.body.model).toEqual({ id: 'claude-opus-5-5', speed: 'standard', effort: { type: 'medium' } });
    expect(created.body.model_config).toEqual({ id: 'claude-opus-5-5', speed: 'standard', effort: 'medium' });
  });

  it('stores `high` on a model that defaults to `high`', async () => {
    const ctx = context();
    const created = await request(ctx.app, 'POST', '/v1/agents', {
      name: 'High default agent',
      model: 'claude-sonnet-5',
      system: 'p',
    });
    expect(created.res.status).toBe(201);
    expect(created.body.model_config?.effort).toBe('high');
  });

  it('lets an explicit `effort` win over the default', async () => {
    const ctx = context();
    const created = await request(ctx.app, 'POST', '/v1/agents', {
      name: 'Explicit effort agent',
      model: { id: 'claude-opus-5-5', effort: 'low' },
      system: 'p',
    });
    expect(created.res.status).toBe(201);
    expect(created.body.model_config?.effort).toBe('low');
  });

  it('does not invent a level for a model the table does not know', async () => {
    const ctx = context();
    const created = await request(ctx.app, 'POST', '/v1/agents', {
      name: 'Unknown model agent',
      model: 'gpt-4o',
      system: 'p',
    });
    expect(created.res.status).toBe(201);
    expect(created.body.model_config?.effort).toBeUndefined();
  });

  it('does not fill a level on a model that takes no effort', async () => {
    const ctx = context();
    const created = await request(ctx.app, 'POST', '/v1/agents', {
      name: 'No effort agent',
      model: 'claude-haiku-4-5',
      system: 'p',
    });
    expect(created.res.status).toBe(201);
    // Haiku 4.5 takes no effort — storing a level would promise an execution
    // the capability table rules out.
    expect(created.body.model_config?.effort).toBeUndefined();
  });

  it('is visible on the session snapshot, not only the agent read', async () => {
    const ctx = context();
    const created = await request(ctx.app, 'POST', '/v1/agents', {
      name: 'Snapshot effort agent',
      model: 'claude-opus-5-5',
      system: 'p',
    });
    const session = await request(ctx.app, 'POST', '/v1/sessions', {
      agent: { id: created.body.id, version: 1 },
    });
    expect(session.res.status).toBe(201);
    expect(session.body.agent.model_config?.effort).toBe('medium');
  });
});

describe('the update effort rule', () => {
  it('keeps the stored effort when a same-id `model` update omits it', async () => {
    const ctx = context();
    const created = await request(ctx.app, 'POST', '/v1/agents', {
      name: 'Keep effort agent',
      model: { id: 'claude-opus-5-5', effort: 'low' },
      system: 'p',
    });
    // Re-send the same model id without effort: the stored level is kept.
    const updated = await request(ctx.app, 'PUT', `/v1/agents/${created.body.id}`, {
      model: 'claude-opus-5-5',
    });
    expect(updated.res.status).toBe(200);
    expect(updated.body.model_config?.effort).toBe('low');
  });

  it('resets to the new model default when the id changes', async () => {
    const ctx = context();
    const created = await request(ctx.app, 'POST', '/v1/agents', {
      name: 'Reset effort agent',
      model: { id: 'claude-opus-5-5', effort: 'low' },
      system: 'p',
    });
    const updated = await request(ctx.app, 'PUT', `/v1/agents/${created.body.id}`, {
      model: 'claude-sonnet-5',
    });
    expect(updated.res.status).toBe(200);
    // The stored `low` dies with the old model — Sonnet 5's own default fills.
    expect(updated.body.model_config?.effort).toBe('high');
  });

  it('fills a default on an old row whose effort was absent', async () => {
    const ctx = context();
    const created = await request(ctx.app, 'POST', '/v1/agents', {
      name: 'Backfill agent',
      model: { id: 'claude-opus-5-5', effort: 'high' },
      system: 'p',
    });
    // Strip the stored level to mimic a row written before the fill existed.
    const stored = JSON.parse(
      (ctx.db.prepare('SELECT definition FROM agents WHERE id = ?').get(created.body.id) as {
        definition: string;
      }).definition,
    ) as Record<string, any>;
    delete stored.model_config.effort;
    ctx.db.prepare('UPDATE agents SET definition = ? WHERE id = ?')
      .run(JSON.stringify(stored), created.body.id);

    const updated = await request(ctx.app, 'POST', `/v1/agents/${created.body.id}`, {
      description: 'touch',
    });
    expect(updated.res.status).toBe(200);
    // A write through the current path resolves the documented default rather
    // than leaving the field empty for the runtime to fall back on.
    expect(updated.body.model_config?.effort).toBe('medium');
  });
});
