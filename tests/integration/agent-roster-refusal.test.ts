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
    expect(inventory.body.contract.capabilities).toContainEqual(expect.objectContaining({
      id: 'multiagent-roster', status: 'unavailable', reason: expect.stringContaining('decisions/0002'),
    }));
    // The coordinator subset is accepted, so the threads capability reports
    // partial — the roster is honoured; threads, workflows, and the advisor
    // are still unimplemented.
    expect(inventory.body.contract.capabilities).toContainEqual(expect.objectContaining({
      id: 'threads-and-coordinator', status: 'partial', reason: expect.stringContaining('coordinator'),
    }));
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

/**
 * The coordinator subset is the one `multiagent` shape upstream self-hosted
 * itself accepts: `{"type":"coordinator","agents":[1–20 predefined-agent
 * entries]}`. It is normalized to `delegations` at write time — every
 * `agent_…` id resolves to a loaded agent's name — with `delegations_source`
 * recording the provenance so the published one-level rule applies, and
 * `{type:"self"}` mapping to `enable_general_subagent`.
 */
describe('coordinator multiagent acceptance', () => {
  const coordinatorFor = (targetId: string) => ({
    type: 'coordinator',
    agents: [{ type: 'agent', id: targetId }],
  });

  async function createTarget(ctx: TestContext, name = 'Delegate target') {
    const target = await request(ctx.app, 'POST', '/v1/agents', {
      name,
      model: 'gpt-4o',
      system: 'Answer tasks.',
    });
    expect(target.res.status).toBe(201);
    return target.body.id as string;
  }

  it('accepts a coordinator block on create and normalizes it to delegations', async () => {
    const ctx = context();
    const targetId = await createTarget(ctx);

    const created = await request(ctx.app, 'POST', '/v1/agents', {
      ...definition,
      name: 'Coordinator',
      multiagent: coordinatorFor(targetId),
    });

    expect(created.res.status).toBe(201);
    const stored = storedDefinitions(ctx).find((agent) => agent.name === 'Coordinator');
    expect(stored?.delegations).toEqual(['Delegate target']);
    expect(stored?.delegations_source).toBe('coordinator');
    // The canonical block is a write spelling: the read projection reports the
    // normalized roster fields and no stored `multiagent` block.
    expect((stored as unknown as Record<string, unknown>).multiagent).toBeUndefined();
  });

  it('resolves the bare-string and version-pinned entry forms to the same name', async () => {
    const ctx = context();
    const targetId = await createTarget(ctx, 'Pinned target');

    const created = await request(ctx.app, 'POST', '/v1/agents', {
      ...definition,
      name: 'Coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [targetId, { type: 'agent', id: targetId, version: 3 }],
      },
    });

    expect(created.res.status).toBe(201);
    const stored = storedDefinitions(ctx).find((agent) => agent.name === 'Coordinator');
    // Version pins resolve to latest — the archived-version lookup is a
    // separate feature and the published entry itself defaults to latest when
    // `version` is omitted.
    expect(stored?.delegations).toEqual(['Pinned target', 'Pinned target']);
  });

  it('maps {type:"self"} to enable_general_subagent', async () => {
    const ctx = context();

    const created = await request(ctx.app, 'POST', '/v1/agents', {
      ...definition,
      name: 'Self coordinator',
      multiagent: { type: 'coordinator', agents: [{ type: 'self' }] },
    });

    expect(created.res.status).toBe(201);
    const stored = storedDefinitions(ctx).find((agent) => agent.name === 'Self coordinator');
    // `self` is the local one-level self-copy mechanism, not a roster name:
    // a name in `delegations` would be refused by cycle detection.
    expect(stored?.enable_general_subagent).toBe(true);
    expect(stored?.delegations).toEqual([]);
  });

  it('refuses a dangling agent id at write time', async () => {
    const ctx = context();

    const attempt = await request(ctx.app, 'POST', '/v1/agents', {
      ...definition,
      multiagent: { type: 'coordinator', agents: [{ type: 'agent', id: 'agent_nonexistent' }] },
    });

    expect(attempt.res.status).toBe(400);
    expect(attempt.body.error.details[0].path).toBe('multiagent.agents');
    expect(attempt.body.error.details[0].message).toContain('agent_nonexistent');
    expect(storedDefinitions(ctx)).toEqual([]);
  });

  it('refuses a coordinator block carrying roster members with the coordinator rule named', async () => {
    const ctx = context();
    const targetId = await createTarget(ctx);

    for (const extra of [
      { advisor: { model: 'any' } },
      { workflows: {} },
      { subagents: {} },
      { inline_agents: {} },
    ]) {
      const attempt = await request(ctx.app, 'POST', '/v1/agents', {
        ...definition,
        multiagent: { type: 'coordinator', agents: [{ type: 'agent', id: targetId }], ...extra },
      });
      expect(attempt.res.status).toBe(400);
      expect(attempt.body.error.details[0].message).toContain('coordinator');
    }
  });

  it('enforces the 1–20 agents bound', async () => {
    const ctx = context();
    const targetId = await createTarget(ctx);

    const empty = await request(ctx.app, 'POST', '/v1/agents', {
      ...definition,
      multiagent: { type: 'coordinator', agents: [] },
    });
    expect(empty.res.status).toBe(400);
    expect(empty.body.error.details[0].message).toContain('coordinator');

    const over = await request(ctx.app, 'POST', '/v1/agents', {
      ...definition,
      multiagent: {
        type: 'coordinator',
        agents: Array.from({ length: 21 }, () => ({ type: 'agent', id: targetId })),
      },
    });
    expect(over.res.status).toBe(400);
    expect(over.body.error.details[0].message).toContain('coordinator');
  });

  it('refuses a caller roster beside the block rather than merging', async () => {
    const ctx = context();
    const targetId = await createTarget(ctx);

    // Coordinator replaces wholesale: an explicit `delegations` list in the
    // same request is superseded by the block, not merged with it.
    const created = await request(ctx.app, 'POST', '/v1/agents', {
      ...definition,
      name: 'Coordinator',
      delegations: ['Nobody'],
      multiagent: coordinatorFor(targetId),
    });
    expect(created.res.status).toBe(201);
    const stored = storedDefinitions(ctx).find((agent) => agent.name === 'Coordinator');
    expect(stored?.delegations).toEqual(['Delegate target']);
  });

  it('replaces the stored roster wholesale on update', async () => {
    const ctx = context();
    const firstId = await createTarget(ctx, 'First target');
    const secondId = await createTarget(ctx, 'Second target');
    const created = await request(ctx.app, 'POST', '/v1/agents', {
      ...definition,
      name: 'Coordinator',
      multiagent: coordinatorFor(firstId),
    });
    expect(created.res.status).toBe(201);

    const updated = await request(ctx.app, 'PUT', `/v1/agents/${created.body.id}`, {
      multiagent: coordinatorFor(secondId),
    });

    expect(updated.res.status).toBe(200);
    const stored = storedDefinitions(ctx).find((agent) => agent.name === 'Coordinator');
    expect(stored?.delegations).toEqual(['Second target']);
    expect(stored?.delegations_source).toBe('coordinator');
  });

  it('multiagent: null clears a coordinator-produced roster and leaves a caller-owned one alone', async () => {
    const ctx = context();
    const targetId = await createTarget(ctx);
    const created = await request(ctx.app, 'POST', '/v1/agents', {
      ...definition,
      name: 'Coordinator',
      multiagent: { type: 'coordinator', agents: [{ type: 'agent', id: targetId }, { type: 'self' }] },
    });
    expect(created.res.status).toBe(201);
    let stored = storedDefinitions(ctx).find((agent) => agent.name === 'Coordinator');
    expect(stored?.delegations_source).toBe('coordinator');
    expect(stored?.enable_general_subagent).toBe(true);

    const cleared = await request(ctx.app, 'PUT', `/v1/agents/${created.body.id}`, { multiagent: null });
    expect(cleared.res.status).toBe(200);
    stored = storedDefinitions(ctx).find((agent) => agent.name === 'Coordinator');
    // The upstream "clears the whole block" rule lands on every field the
    // coordinator normalization wrote: roster, provenance, and the self flag.
    expect(stored?.delegations).toBeUndefined();
    expect(stored?.delegations_source).toBeUndefined();
    expect(stored?.enable_general_subagent).toBeUndefined();

    // A caller-owned roster written through the local extension is not the
    // canonical block, so the same `null` leaves it alone.
    const localOnly = await request(ctx.app, 'POST', '/v1/agents', {
      ...definition,
      name: 'Local roster',
      delegations: ['Delegate target'],
      enable_general_subagent: true,
    });
    expect(localOnly.res.status).toBe(201);
    const untouched = await request(ctx.app, 'PUT', `/v1/agents/${localOnly.body.id}`, { multiagent: null });
    expect(untouched.res.status).toBe(200);
    stored = storedDefinitions(ctx).find((agent) => agent.name === 'Local roster');
    expect(stored?.delegations).toEqual(['Delegate target']);
    expect(stored?.enable_general_subagent).toBe(true);
  });
});
