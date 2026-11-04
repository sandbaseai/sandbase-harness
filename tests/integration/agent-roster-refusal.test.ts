/**
 * The canonical `multiagent` roster is refused, and local delegation is not it.
 *
 * Both agent write paths must answer a roster the same way: with a 400 that
 * names the capability and the reason. A create that strips the field is the
 * worst case of the two, because the caller receives a 201 and a normal-looking
 * agent while the delegation they asked for does not exist.
 *
 * The local delegation extension is a different field with a different answer:
 * `enable_general_subagent` is accepted on both paths because the executor
 * builds delegation tools from it, and it is not presented as the canonical
 * roster.
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
  const tmpDir = mkdtempSync(join(tmpdir(), 'ma-agent-roster-'));
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
  name: 'Rosterless agent',
  model: 'gpt-4o',
  system: 'Stay put.',
};

const roster = {
  type: 'multiagent_20261001',
  subagents: { predefined_agents: [{ type: 'agent', id: 'agent_example' }] },
};

function storedDefinitions(ctx: TestContext): AgentDefinition[] {
  return (ctx.db.prepare('SELECT definition FROM agents').all() as Array<{ definition: string }>)
    .map((row) => JSON.parse(row.definition) as AgentDefinition);
}

describe('canonical multiagent roster', () => {
  it('refuses a roster on create with the capability id, before anything is stored', async () => {
    const ctx = context();

    const attempt = await request(ctx.app, 'POST', '/v1/agents', { ...definition, multiagent: roster });

    expect(attempt.res.status).toBe(400);
    expect(attempt.body.error.type).toBe('invalid_request_error');
    expect(attempt.body.error.details).toContainEqual({
      path: 'multiagent',
      message: expect.stringContaining('multiagent-roster'),
    });
    // The refusal names the reason rather than only the field, and it points at
    // the local extension the caller can use instead.
    expect(attempt.body.error.details[0].message).toContain('thread');
    expect(attempt.body.error.details[0].message).toContain('not implemented');
    expect(attempt.body.error.details[0].message).toContain('decisions/0002');
    expect(attempt.body.error.details[0].message).toContain('enable_general_subagent');
    expect(storedDefinitions(ctx)).toEqual([]);

    const inventory = await request(ctx.app, 'GET', '/v1/x/capabilities');
    expect(inventory.res.status).toBe(200);
    for (const id of ['multiagent-roster', 'threads-and-coordinator']) {
      expect(inventory.body.contract.capabilities).toContainEqual(expect.objectContaining({
        id, status: 'unavailable', reason: expect.stringContaining('decisions/0002'),
      }));
    }
  });

  it('refuses a roster on update with the same capability id', async () => {
    const ctx = context();
    const created = await request(ctx.app, 'POST', '/v1/agents', definition);
    expect(created.res.status).toBe(201);

    const attempt = await request(ctx.app, 'PUT', `/v1/agents/${created.body.id}`, { multiagent: roster });

    expect(attempt.res.status).toBe(400);
    expect(attempt.body.error.details).toContainEqual({
      path: 'multiagent',
      message: expect.stringContaining('multiagent-roster'),
    });
  });

  it('accepts the local delegation extension on both write paths', async () => {
    const ctx = context();

    const created = await request(ctx.app, 'POST', '/v1/agents', { ...definition, enable_general_subagent: true });
    expect(created.res.status).toBe(201);
    expect(storedDefinitions(ctx)[0]?.enable_general_subagent).toBe(true);

    const updated = await request(ctx.app, 'PUT', `/v1/agents/${created.body.id}`, { enable_general_subagent: false });
    expect(updated.res.status).toBe(200);
    expect(storedDefinitions(ctx)[0]?.enable_general_subagent).toBe(false);
  });
});
