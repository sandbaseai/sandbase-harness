/**
 * `effort` is accepted, stored, and echoed — and it does not reach the provider.
 *
 * The canonical `model` object carries `effort`, and a definition's level has no
 * path into a request: the executor resolves the provider model from the id
 * string (`agent.model`), so no request changes because of it. (A deployment's own
 * `reasoning_effort` model setting is a separate, operator-level control, which is
 * why the claim here is about the definition field and not about the runtime.)
 * The honest shape for that is "accepted-but-no-effect", which has two halves
 * that must both be true:
 *
 * 1. **the value comes back.** An agent read, a version read, and a session
 *    snapshot all return it, because a definition that stores a field and never
 *    shows it is the silent loss the model profile exists to prevent;
 * 2. **the provider never sees it.** A real turn for a definition carrying
 *    `effort: "max"` sends the same OpenAI-compatible request body it would send
 *    without it.
 *
 * If only the second half held, `effort` would be a dropped field; if only the
 * first, the runtime would be advertising an execution it does not have.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '@/api/server.js';
import { Database } from '@/core/db/database.js';
import { SessionManager, type SessionExecutor } from '@/core/session/session-manager.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import type { AgentDefinition } from '@/types/agent.js';

function createTestApp() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ma-agent-effort-'));
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

const definition = {
  name: 'Effortful agent',
  model: { id: 'gpt-4o', effort: 'high' },
  system: 'Think hard.',
};

describe('the model profile echoes the effort the definition carries', () => {
  it('returns it on create and on every read, including a version', async () => {
    const ctx = context();

    const created = await request(ctx.app, 'POST', '/v1/agents', definition);
    expect(created.res.status).toBe(201);
    expect(created.body.model).toBe('gpt-4o');
    expect(created.body.model_config).toEqual({ id: 'gpt-4o', speed: 'standard', effort: 'high' });

    const read = await request(ctx.app, 'GET', `/v1/agents/${created.body.id}`);
    expect(read.body.model_config).toEqual({ id: 'gpt-4o', speed: 'standard', effort: 'high' });

    // An update that does not mention `model` keeps the stored level, and the
    // response says so rather than reporting the agent as if it had none.
    const updated = await request(ctx.app, 'PUT', `/v1/agents/${created.body.id}`, {
      description: 'Now with a description.',
    });
    expect(updated.res.status).toBe(200);
    expect(updated.body.model_config).toEqual({ id: 'gpt-4o', speed: 'standard', effort: 'high' });

    // The version read is the same projection, so an archived version does not
    // lose a field the caller sent with it.
    const versions = await request(ctx.app, 'GET', `/v1/agents/${created.body.id}/versions`);
    expect(versions.res.status).toBe(200);
    const archived = versions.body.data.find((entry: any) => entry.version === 1);
    expect(archived.model_config).toEqual({ id: 'gpt-4o', speed: 'standard', effort: 'high' });
  });

  it('echoes it in the frozen session snapshot, not only from the live agent', async () => {
    const ctx = context();
    const created = await request(ctx.app, 'POST', '/v1/agents', definition);

    // A pinned reference is what makes a session store its own definition; an
    // unpinned session deliberately keeps following the agent and stores none.
    const session = await request(ctx.app, 'POST', '/v1/sessions', {
      agent: { id: created.body.id, version: 1 },
    });
    expect(session.res.status).toBe(201);
    expect(session.body.agent.model_config).toEqual({
      id: 'gpt-4o',
      speed: 'standard',
      effort: 'high',
    });
    const stored = ctx.db.prepare('SELECT agent_definition FROM sessions WHERE id = ?')
      .get(session.body.id) as { agent_definition: string | null };
    expect(stored.agent_definition).not.toBeNull();

    // The frozen definition is the source: changing the agent afterwards must not
    // change what this session reports, or the read is not the snapshot at all.
    const live = JSON.parse(
      (ctx.db.prepare('SELECT definition FROM agents WHERE id = ?').get(created.body.id) as {
        definition: string;
      }).definition,
    ) as Record<string, unknown>;
    delete (live.model_config as { effort?: string }).effort;
    ctx.db.prepare('UPDATE agents SET definition = ? WHERE id = ?')
      .run(JSON.stringify(live), created.body.id);

    const read = await request(ctx.app, 'GET', `/v1/sessions/${session.body.id}`);
    expect(read.body.agent.model_config).toEqual({ id: 'gpt-4o', speed: 'standard', effort: 'high' });
  });

  it('honours the local `model_config` spelling rather than dropping the level', async () => {
    const ctx = context();

    // The response returns `effort` inside `model_config`, so a caller that sends
    // that same object back must not have it silently discarded on the way in.
    const created = await request(ctx.app, 'POST', '/v1/agents', {
      name: 'Local spelling agent',
      model: 'gpt-4o',
      system: 'Stay put.',
      model_config: { id: 'gpt-4o', speed: 'fast', effort: 'low' },
    });

    expect(created.res.status).toBe(201);
    expect(created.body.model_config).toEqual({ id: 'gpt-4o', speed: 'fast', effort: 'low' });
  });

  it('reads the level a definition stored beside the config before this was fixed', async () => {
    const ctx = context();
    const created = await request(ctx.app, 'POST', '/v1/agents', definition);

    // The shape an earlier version wrote: `effort` as a sibling of the profile.
    // Those rows are in existing workspaces, and reading one back must not look
    // like the value was never stored — the definition schema is not strict, so a
    // plain re-validation would strip the key.
    const stored = JSON.parse(
      (ctx.db.prepare('SELECT definition FROM agents WHERE id = ?').get(created.body.id) as {
        definition: string;
      }).definition,
    ) as Record<string, unknown>;
    const { effort } = stored.model_config as { effort?: string };
    delete (stored.model_config as { effort?: string }).effort;
    stored.effort = effort;
    ctx.db.prepare('UPDATE agents SET definition = ? WHERE id = ?')
      .run(JSON.stringify(stored), created.body.id);

    const read = await request(ctx.app, 'GET', `/v1/agents/${created.body.id}`);
    expect(read.body.model_config).toEqual({ id: 'gpt-4o', speed: 'standard', effort: 'high' });
  });

  it('reads the same older spelling out of a session snapshot', async () => {
    const ctx = context();
    const created = await request(ctx.app, 'POST', '/v1/agents', definition);
    const session = await request(ctx.app, 'POST', '/v1/sessions', {
      agent: { id: created.body.id, version: 1 },
    });

    // A session snapshot is read back with a plain parse rather than a
    // re-validation, so the projection itself has to tolerate the older spelling
    // on this path — the definition-row path folds it before validating.
    const snapshot = JSON.parse(
      (ctx.db.prepare('SELECT agent_definition FROM sessions WHERE id = ?').get(session.body.id) as {
        agent_definition: string;
      }).agent_definition,
    ) as Record<string, unknown>;
    const { effort } = snapshot.model_config as { effort?: string };
    delete (snapshot.model_config as { effort?: string }).effort;
    snapshot.effort = effort;
    ctx.db.prepare('UPDATE sessions SET agent_definition = ? WHERE id = ?')
      .run(JSON.stringify(snapshot), session.body.id);

    const read = await request(ctx.app, 'GET', `/v1/sessions/${session.body.id}`);
    expect(read.body.agent.model_config).toEqual({ id: 'gpt-4o', speed: 'standard', effort: 'high' });
  });

  it('keeps the level when a definition written before the fix is updated', async () => {
    const ctx = context();
    const created = await request(ctx.app, 'POST', '/v1/agents', definition);

    // Put the row back into the shape the previous version wrote, then change a
    // field that has nothing to do with the model. The update reads the stored
    // definition through the folding reader, so the level survives and is
    // rewritten in the current spelling — a patch that silently dropped it would
    // be the same loss this change exists to remove, one version later.
    const stored = JSON.parse(
      (ctx.db.prepare('SELECT definition FROM agents WHERE id = ?').get(created.body.id) as {
        definition: string;
      }).definition,
    ) as Record<string, unknown>;
    const { effort } = stored.model_config as { effort?: string };
    delete (stored.model_config as { effort?: string }).effort;
    stored.effort = effort;
    ctx.db.prepare('UPDATE agents SET definition = ? WHERE id = ?')
      .run(JSON.stringify(stored), created.body.id);

    const updated = await request(ctx.app, 'POST', `/v1/agents/${created.body.id}`, {
      description: 'Now with a description.',
    });

    expect(updated.res.status).toBe(200);
    expect(updated.body.description).toBe('Now with a description.');
    expect(updated.body.model_config).toEqual({ id: 'gpt-4o', speed: 'standard', effort: 'high' });

    // The archived version carries the level inside the profile too, so a later
    // session pinned to this version does not freeze the old shape.
    const version = JSON.parse(
      (ctx.db.prepare('SELECT definition FROM agent_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 1')
        .get(created.body.id) as { definition: string }).definition,
    ) as Record<string, unknown>;
    expect(version.model_config).toEqual({ id: 'gpt-4o', speed: 'standard', effort: 'high' });
    expect(version).not.toHaveProperty('effort');
  });

  it('still omits the profile when there is nothing to report', async () => {
    const ctx = context();

    // The projection's omission rule is unchanged: a plain model id with the local
    // default speed returns no `model_config`, so existing clients see the same
    // response they saw before.
    const created = await request(ctx.app, 'POST', '/v1/agents', {
      name: 'Plain agent',
      model: 'gpt-4o',
      system: 'Stay put.',
    });

    expect(created.res.status).toBe(201);
    expect(created.body).not.toHaveProperty('model_config');
  });

  it('refuses an unknown level instead of storing it unvalidated', async () => {
    const ctx = context();

    const attempt = await request(ctx.app, 'POST', '/v1/agents', {
      ...definition,
      model: { id: 'gpt-4o', effort: 'maximum' },
    });

    // The canonical object form is a union of the object and the bare string, so a
    // level outside the published set fails as a shape error at `model`, the way an
    // unknown `speed` does; the issue is reported at the union, not at
    // `model.effort`. What matters here is that nothing is stored: a level the
    // runtime cannot validate must not become a definition it echoes back as
    // accepted.
    expect(attempt.res.status).toBe(400);
    expect(attempt.body.error.type).toBe('invalid_request_error');
    expect(attempt.body.error.details.length).toBeGreaterThan(0);
    const rows = ctx.db.prepare('SELECT id FROM agents').all();
    expect(rows).toEqual([]);
  });

  it('refuses an unknown level sent in the local spelling, naming that field', async () => {
    const ctx = context();

    // The spelling the response returns is a request shape too, and there the
    // field is its own schema member, so this path can name it.
    const attempt = await request(ctx.app, 'POST', '/v1/agents', {
      name: 'Local spelling refusal',
      model: 'gpt-4o',
      system: 'Stay put.',
      model_config: { id: 'gpt-4o', speed: 'standard', effort: 'maximum' },
    });

    expect(attempt.res.status).toBe(400);
    expect(attempt.body.error.details).toContainEqual(
      expect.objectContaining({ path: 'model_config.effort' }),
    );
    expect(ctx.db.prepare('SELECT id FROM agents').all()).toEqual([]);
  });

  it('reports the level on the session list as well as the session read', async () => {
    const ctx = context();
    const created = await request(ctx.app, 'POST', '/v1/agents', definition);
    const session = await request(ctx.app, 'POST', '/v1/sessions', {
      agent: { id: created.body.id, version: 1 },
    });

    const list = await request(ctx.app, 'GET', '/v1/sessions');
    expect(list.res.status).toBe(200);
    const listed = (list.body.data as Array<{ id: string; agent: { model_config?: unknown } }>)
      .find((entry) => entry.id === session.body.id);
    expect(listed?.agent.model_config).toEqual({ id: 'gpt-4o', speed: 'standard', effort: 'high' });
  });

  it('reports a non-default speed without inventing a level', async () => {
    const ctx = context();

    const created = await request(ctx.app, 'POST', '/v1/agents', {
      name: 'Fast agent',
      model: { id: 'gpt-4o', speed: 'fast' },
      system: 'Stay put.',
    });

    expect(created.res.status).toBe(201);
    expect(created.body.model_config).toEqual({ id: 'gpt-4o', speed: 'fast' });
  });
});

/** The provider wire the executor talks to, with only the socket stubbed. */
describe('effort does not reach the provider request', () => {
  const GATEWAY_MODEL = 'deepseek/deepseek-v4-flash';
  const GATEWAY_BASE_URL = 'https://gateway.invalid/v1';

  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;
  let requests: Array<{ url: string; body: Record<string, unknown> }>;

  function sseBody(text: string): string {
    const chunk = (choices: unknown[], usage?: unknown) => `data: ${JSON.stringify({
      id: 'chatcmpl_1',
      object: 'chat.completion.chunk',
      created: 0,
      model: GATEWAY_MODEL,
      choices,
      ...(usage ? { usage } : {}),
    })}`;
    return [
      chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
      chunk([{ index: 0, delta: { content: text }, finish_reason: null }]),
      chunk([{ index: 0, delta: {}, finish_reason: 'stop' }], { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }),
      'data: [DONE]',
    ].join('\n\n') + '\n\n';
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-agent-effort-provider-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_gateway', 'gateway-agent', '{}')`);
    manager = new SessionManager(db);

    requests = [];
    vi.stubGlobal('fetch', async (url: unknown, init: { body?: string }) => {
      requests.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
      return new Response(sseBody('hello'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sends the same request body a definition without the level sends', async () => {
    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'openai_compatible',
      api_key: 'test-key',
      base_url: GATEWAY_BASE_URL,
      is_default: true,
    });
    const agent: AgentDefinition = {
      name: 'gateway-agent',
      model: GATEWAY_MODEL,
      system: 'p',
      // The level the definition carries. Nothing on the request path reads it:
      // the executor resolves the provider model from `agent.model`.
      model_config: { id: GATEWAY_MODEL, speed: 'standard', effort: 'max' },
    };
    manager.setExecutor(new DefaultSessionExecutor({
      agents: [agent],
      modelRegistry: registry,
      sandboxProvider: new LocalSandboxProvider(tmpDir),
      strategy: new DefaultStrategy(),
      eventLogger: manager.getEventLogger(),
    }));

    const created = manager.create({ agent: 'agent_gateway' });
    await manager.sendEvent(created.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'hi' }],
    } as never);
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && requests.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // The turn really ran against the provider...
    expect(requests).toHaveLength(1);
    expect(requests[0].body['model']).toBe(GATEWAY_MODEL);
    // ...and the level is not in the request, under either of the spellings a
    // reasoning-effort middleware uses. This is the "no effect" half of
    // accepted-but-no-effect: an echo without execution, not a hidden pivot.
    expect(requests[0].body).not.toHaveProperty('effort');
    expect(requests[0].body).not.toHaveProperty('reasoning_effort');
    expect(requests[0].body).not.toHaveProperty('reasoning');
  });
});
