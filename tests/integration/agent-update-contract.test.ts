/**
 * Agent resource partial-update contract.
 *
 * Covers `PATCH /v1/agents/{id}` and the unified `PUT` semantics: omitted
 * fields keep their stored value, list fields replace wholesale when present,
 * metadata merges per key with `null` deleting, `name`/`model` cannot be
 * cleared, `expected_version` stays an optimistic precondition, and a no-op
 * update never mints a new version.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '@/api/server.js';
import { Database } from '@/core/db/database.js';
import { SessionManager, type SessionExecutor } from '@/core/session/session-manager.js';
import { ManagedAgentsClient } from '@/sdk/client.js';
import type { AgentDefinition } from '@/types/agent.js';

type TestContext = ReturnType<typeof createTestApp>;

const richAgent = {
  name: 'Contract agent',
  model: 'gpt-4o',
  system: 'Original system.',
  description: 'Original description.',
  mcp_servers: [{ type: 'url', name: 'tools-server', url: 'https://mcp.example.com/mcp' }],
  // `custom` tool entries are not part of this change, so the fixture uses the
  // shapes `main` accepts. The MCP toolset is kept because the merged-definition
  // revalidation must still catch a broken server/toolset pair.
  tools: [
    { type: 'mcp_toolset', mcp_server_name: 'tools-server', configs: [] },
    {
      type: 'agent_toolset_20260401',
      configs: [{ name: 'read' }, { name: 'bash' }],
    },
  ],
  skills: [{ type: 'custom', skill_id: 'research' }],
  metadata: { team: 'platform', tier: 'gold', owner: 'qa' },
  max_turns: 12,
  temperature: 0.3,
  strategy: 'default',
};

function createTestApp() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ma-agent-update-'));
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
  return { app, db, tmpDir, agents };
}

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

async function request(
  app: ReturnType<typeof createServer>,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json() as any;
  return { res, body: json };
}

async function seedAgent(ctx: TestContext, definition: Record<string, unknown> = richAgent) {
  const created = await request(ctx.app, 'POST', '/v1/agents', definition);
  expect(created.res.status).toBe(201);
  return created.body as { id: string; version: number };
}

function versionRows(ctx: TestContext, agentId: string): number[] {
  return (ctx.db
    .prepare('SELECT version FROM agent_versions WHERE agent_id = ? ORDER BY version ASC')
    .all(agentId) as Array<{ version: number }>).map((row) => row.version);
}

function storedRow(ctx: TestContext, agentId: string) {
  return ctx.db
    .prepare('SELECT name, definition, version, status, archived_at FROM agents WHERE id = ?')
    .get(agentId) as { name: string; definition: string; version: number; status: string; archived_at: string | null };
}

function sdkClient(ctx: TestContext) {
  return new ManagedAgentsClient({
    baseUrl: 'http://managed-agents.test',
    fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      return ctx.app.request(`${url.pathname}${url.search}`, init);
    },
  });
}

describe('PUT /v1/agents/:id partial update', () => {
  it('keeps every field the body omits when only system changes', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);

    const updated = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { system: 'New system.' });
    expect(updated.res.status).toBe(200);
    expect(updated.body.version).toBe(agent.version + 1);
    expect(updated.body.system).toBe('New system.');
    expect(updated.body.name).toBe('Contract agent');
    expect(updated.body.model).toBe('gpt-4o');
    expect(updated.body.description).toBe('Original description.');
    expect(updated.body.tools).toHaveLength(2);
    expect(updated.body.skills).toEqual([{ type: 'custom', skill_id: 'research' }]);
    expect(updated.body.metadata).toEqual({ team: 'platform', tier: 'gold', owner: 'qa' });

    const got = await request(ctx.app, 'GET', `/v1/agents/${agent.id}`);
    expect(got.body.system).toBe('New system.');
    expect(got.body.tools).toHaveLength(2);
  });

  it('updates description alone and model alone without touching the rest', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);

    const described = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
      description: 'Only the description changed.',
    });
    expect(described.res.status).toBe(200);
    expect(described.body.description).toBe('Only the description changed.');
    expect(described.body.system).toBe('Original system.');
    // max_turns is a local-only field that never appears in the CMA agent
    // shape; preservation is observable on the stored definition.
    expect(JSON.parse(storedRow(ctx, agent.id).definition).max_turns).toBe(12);

    const modeled = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
      model: { id: 'gpt-5', speed: 'fast' },
    });
    expect(modeled.res.status).toBe(200);
    expect(modeled.body.model).toBe('gpt-5');
    // The server echoes the derived config whole: id and speed both visible.
    expect(modeled.body.model_config).toEqual({ id: 'gpt-5', speed: 'fast' });
    expect(modeled.body.system).toBe('Original system.');
    expect(modeled.body.tools).toHaveLength(2);

    // A bare string model replaces the derived config too: no stale speed
    // may keep pointing at the previous model.
    const reverts = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { model: 'gpt-4o' });
    expect(reverts.body.model).toBe('gpt-4o');
    expect(reverts.body.model_config).toBeUndefined();
  });

  it('keeps max_turns, temperature and strategy that the Console editor never shows', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);

    // Exactly the shape `AgentEditModal` puts on the wire: the draft fields
    // and nothing else.
    const saved = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
      name: 'Contract agent',
      model: 'gpt-4o',
      description: 'Original description.',
      system: 'Console edited this.',
      mcp_servers: richAgent.mcp_servers,
      tools: richAgent.tools,
      skills: richAgent.skills,
      metadata: { team: 'platform', tier: 'platinum', owner: null },
    });
    expect(saved.res.status).toBe(200);
    expect(saved.body.system).toBe('Console edited this.');
    // The draft fields the editor never shows stay on the stored definition.
    const stored = JSON.parse(storedRow(ctx, agent.id).definition);
    expect(stored.max_turns).toBe(12);
    expect(stored.temperature).toBe(0.3);
    expect(stored.strategy).toBe('default');
    // A key the operator deleted in the editor arrives as an explicit null.
    expect(saved.body.metadata).toEqual({ team: 'platform', tier: 'platinum' });
  });

  it('replaces list fields wholesale when present and keeps them when omitted', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);

    const replaced = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
      skills: [{ type: 'anthropic', skill_id: 'pdf' }, { type: 'custom', skill_id: 'research' }],
    });
    expect(replaced.res.status).toBe(200);
    expect(replaced.body.skills).toEqual([
      { type: 'anthropic', skill_id: 'pdf' },
      { type: 'custom', skill_id: 'research' },
    ]);
    expect(replaced.body.tools).toHaveLength(2);

    // tools and mcp_servers are one contract: replacing the wiring means
    // sending both halves, and the merged definition is what gets validated.
    const rewired = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
      tools: [{ type: 'agent_toolset_20260401' }],
      mcp_servers: [],
    });
    expect(rewired.res.status).toBe(200);
    expect(rewired.body.tools).toEqual([{ type: 'agent_toolset_20260401', configs: [] }]);
    expect(rewired.body.mcp_servers).toEqual([]);
    expect(rewired.body.skills).toHaveLength(2);
  });

  it('clears list fields with an empty array or null', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);

    const emptied = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
      skills: [],
    });
    expect(emptied.res.status).toBe(200);
    expect(emptied.body.skills).toEqual([]);
    expect(emptied.body.tools).toHaveLength(2);

    const nulled = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
      tools: null,
      mcp_servers: null,
    });
    expect(nulled.res.status).toBe(200);
    expect(nulled.body.tools).toEqual([]);
    expect(nulled.body.mcp_servers).toEqual([]);
  });

  it('merges metadata per key, deletes keys on explicit null, and clears all on null', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);

    const merged = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
      metadata: { tier: 'silver', contact: 'oncall', owner: null },
    });
    expect(merged.res.status).toBe(200);
    expect(merged.body.metadata).toEqual({ team: 'platform', tier: 'silver', contact: 'oncall' });

    const cleared = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { metadata: null });
    expect(cleared.res.status).toBe(200);
    expect(cleared.body.metadata).toEqual({});

    const refilled = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { metadata: { only: 'one' } });
    expect(refilled.body.metadata).toEqual({ only: 'one' });

    // The server schema accepts any JSON metadata value; the API projection
    // stringifies it on the way out.
    const typed = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { metadata: { priority: 5 } });
    expect(typed.res.status).toBe(200);
    expect(typed.body.metadata).toEqual({ only: 'one', priority: '5' });
  });

  it('clears system and description but never name or model', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);

    const clearedSystem = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { system: null });
    expect(clearedSystem.res.status).toBe(200);
    expect(clearedSystem.body.system).toBe('');
    expect((await request(ctx.app, 'GET', `/v1/agents/${agent.id}`)).body.system).toBe('');

    const emptySystem = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { system: 'Back to work.' });
    expect(emptySystem.body.system).toBe('Back to work.');

    const clearedDescription = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { description: null });
    expect(clearedDescription.body.description).toBe('');

    const nullName = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { name: null });
    expect(nullName.res.status).toBe(400);
    expect(nullName.body.error.details).toContainEqual({
      path: 'name',
      message: 'Agent name cannot be cleared; send a new name or omit the field',
    });

    const nullModel = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { model: null });
    expect(nullModel.res.status).toBe(400);
    expect(nullModel.body.error.details).toContainEqual(expect.objectContaining({
      path: 'model',
      message: expect.stringContaining('cannot be cleared'),
    }));

    for (const body of [{ name: '' }, { model: '' }]) {
      const rejected = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, body);
      expect(rejected.res.status).toBe(400);
      expect(rejected.body.error.details[0].path).toBe(Object.keys(body)[0]);
    }
    const unchanged = await request(ctx.app, 'GET', `/v1/agents/${agent.id}`);
    expect(unchanged.body.name).toBe('Contract agent');
    expect(unchanged.body.model).toBe('gpt-4o');
  });

  it('enforces expected_version as an optimistic precondition', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);

    const conflict = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
      system: 'Never stored.',
      expected_version: 7,
    });
    expect(conflict.res.status).toBe(409);
    expect(conflict.body.error.message).toContain('is at version 1; expected version 7');
    expect(versionRows(ctx, agent.id)).toEqual([1]);

    const applied = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
      system: 'Stored with a precondition.',
      expected_version: agent.version,
    });
    expect(applied.res.status).toBe(200);
    expect(applied.body.version).toBe(2);
    expect(applied.body.system).toBe('Stored with a precondition.');

    // A numeric string is the tolerated spelling of a real precondition.
    const stringVersion = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
      description: 'Guarded by a string version.',
      expected_version: '2',
    });
    expect(stringVersion.res.status).toBe(200);
    expect(stringVersion.body.version).toBe(3);
  });

  it('rejects a malformed expected_version instead of treating it as absent', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);

    for (const malformed of [0, -3, 1.5, 'abc', '', true, {}, [], null]) {
      const rejected = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
        system: 'Would have been an unguarded write.',
        expected_version: malformed,
      });
      expect(rejected.res.status, JSON.stringify(malformed)).toBe(400);
      expect(rejected.body.error.details).toContainEqual({
        path: 'expected_version',
        message: 'expected_version must be a positive integer',
      });
    }
    // Nothing stored: the version is untouched and no snapshot was written.
    expect(storedRow(ctx, agent.id).version).toBe(1);
    expect(versionRows(ctx, agent.id)).toEqual([1]);
  });

  it('lets exactly one of two writers sharing an expected_version land', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);

    const [first, second] = await Promise.all([
      request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { system: 'Writer A.', expected_version: 1 }),
      request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { system: 'Writer B.', expected_version: 1 }),
    ]);
    const responses = [first, second];
    const landed = responses.filter((r) => r.res.status === 200);
    const clashed = responses.filter((r) => r.res.status === 409);
    expect(landed).toHaveLength(1);
    expect(clashed).toHaveLength(1);
    expect(landed[0].body.version).toBe(2);
    expect(clashed[0].body.error.type).toBe('conflict');

    // One commit means exactly one new snapshot, with no duplicate or skipped
    // version numbers.
    expect(versionRows(ctx, agent.id)).toEqual([1, 2]);
    const row = storedRow(ctx, agent.id);
    expect(row.version).toBe(2);
    expect(JSON.parse(row.definition).system).toMatch(/^Writer [AB]\.$/);
  });

  it('serializes two unguarded writers into contiguous versions', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);

    const [first, second] = await Promise.all([
      request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { description: 'Unguarded one.' }),
      request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { description: 'Unguarded two.' }),
    ]);
    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    expect([first.body.version, second.body.version].sort()).toEqual([2, 3]);
    expect(versionRows(ctx, agent.id)).toEqual([1, 2, 3]);
    expect(storedRow(ctx, agent.id).version).toBe(3);
  });

  it('rejects updates to an archived agent over both verbs', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);
    const archived = await request(ctx.app, 'POST', `/v1/agents/${agent.id}/archive`, {});
    expect(archived.res.status).toBe(200);

    for (const method of ['PUT', 'PUT']) {
      const rejected = await request(ctx.app, method, `/v1/agents/${agent.id}`, { system: 'Resurrect.' });
      expect(rejected.res.status).toBe(404);
    }
    const row = storedRow(ctx, agent.id);
    expect(row.status).toBe('archived');
    expect(row.version).toBe(1);
    expect(JSON.parse(row.definition).system).toBe('Original system.');
  });

  it('does not create a version for an update with no actual change', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);
    const rowBefore = storedRow(ctx, agent.id);
    const before = await request(ctx.app, 'GET', `/v1/agents/${agent.id}`);

    const sameSystem = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { system: 'Original system.' });
    expect(sameSystem.res.status).toBe(200);
    expect(sameSystem.body.version).toBe(1);

    const empty = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {});
    expect(empty.res.status).toBe(200);
    expect(empty.body.version).toBe(1);

    const ghostDelete = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
      metadata: { never_existed: null },
    });
    expect(ghostDelete.res.status).toBe(200);
    expect(ghostDelete.body.version).toBe(1);

    // A no-op must not fake progress: timestamps stay exactly as stored.
    expect(sameSystem.body.updated_at).toBe(before.body.updated_at);
    expect(empty.body.created_at).toBe(before.body.created_at);
    expect(versionRows(ctx, agent.id)).toEqual([1]);
    expect(storedRow(ctx, agent.id).definition).toBe(rowBefore.definition);
  });

  it('returns the complete agent, identical to GET, when the update changes nothing', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);
    const truth = (await request(ctx.app, 'GET', `/v1/agents/${agent.id}`)).body;

    // Every shape of "this changes nothing": the stored value re-sent, an empty body,
    // and a metadata deletion of a key that was never there. All three take the
    // no-new-version branch, and all three used to answer with a fabricated object —
    // `toApiAgent` was handed the raw JSON **string** from the `definition` column, so
    // `name`, `system` and `model` were absent and `description`, `tools`, `skills`
    // and `metadata` fell back to empty defaults. The body is compared whole because a
    // dropped field and a zeroed field are the same defect here, and the reference is
    // `GET` rather than a literal fixture so the two projection paths cannot silently
    // diverge again.
    for (const body of [
      { system: 'Original system.' },
      {},
      { metadata: { never_existed: null } },
    ]) {
      const updated = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, body);
      expect(updated.res.status).toBe(200);
      expect(updated.body).toEqual(truth);
    }

    // Named as well, so a failure points at the field instead of printing two large
    // objects: these are exactly the fields that were dropped or zeroed.
    const again = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { system: 'Original system.' });
    expect(again.body.name).toBe('Contract agent');
    expect(again.body.system).toBe('Original system.');
    expect(again.body.model).toBe('gpt-4o');
    expect(again.body.description).toBe('Original description.');
    expect(again.body.tools).toHaveLength(2);
    expect(again.body.skills).toEqual([{ type: 'custom', skill_id: 'research' }]);
    expect(again.body.metadata).toEqual({ team: 'platform', tier: 'gold', owner: 'qa' });

    // The fix is a projection fix only: the no-change path still writes nothing.
    expect(versionRows(ctx, agent.id)).toEqual([1]);
  });

  it('answers the same 404 as GET when the stored definition is unreadable', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);

    // A definition `GET` already refuses to serve. `activeAgentRow` filters on status
    // and archived_at, not on the definition, so this row still reaches the update
    // handler — which must not be the one place that projects an unreadable definition
    // into a well-formed-looking resource.
    ctx.db
      .prepare('UPDATE agents SET definition = ? WHERE id = ?')
      .run(JSON.stringify({ model: 'gpt-4o', system: 'no name field' }), agent.id);

    const got = await request(ctx.app, 'GET', `/v1/agents/${agent.id}`);
    const unchanged = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {});
    const changed = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { system: 'a real change' });

    expect(got.res.status).toBe(404);
    expect(unchanged.res.status).toBe(got.res.status);
    // A request that *would* change something is judged on the merged definition, so
    // it is an invalid definition rather than a missing one. Both are 4xx refusals;
    // neither may invent an agent.
    expect(changed.res.status).toBe(400);
  });

  it('applies the same partial semantics through PUT', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);

    const updated = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { system: 'PUT partial.' });
    expect(updated.res.status).toBe(200);
    expect(updated.body.system).toBe('PUT partial.');
    expect(updated.body.description).toBe('Original description.');
    expect(updated.body.tools).toHaveLength(2);
    expect(updated.body.metadata).toEqual({ team: 'platform', tier: 'gold', owner: 'qa' });
  });

  /**
   * `POST /v1/agents/{id}` is the published update verb: both published update
   * examples send a body with `curl -d` and no `-X`, which curl issues as `POST`,
   * while the same documentation file writes `-X POST` out explicitly for archive —
   * so the omission is meaningful, and no `PUT` or `PATCH` spelling appears anywhere
   * in the published set. The runtime mounted only `PUT`, so a caller who followed the
   * contract built a request the documentation said would work and got a 404.
   */
  describe('POST /v1/agents/:id is the published update verb', () => {
    it('answers the same way as PUT for a changed field, a no-change body and no body', async () => {
      const bodies: Array<{ label: string; body: unknown; changesSomething: boolean }> = [
        { label: 'a field change', body: { system: 'POST partial.' }, changesSomething: true },
        // Genuinely nothing: the value sent is the value already stored.
        { label: 'a no-change body', body: { system: 'Original system.' }, changesSomething: false },
        { label: 'an empty body', body: {}, changesSomething: false },
      ];

      for (const { label, body, changesSomething } of bodies) {
        // A fresh agent and a fresh context per case, so every case starts from the
        // same state. Sharing one agent would make the "no-change" body change
        // something — the previous case would have moved the value it re-sends — and
        // the case would pass or fail for a reason unrelated to the verb.
        const ctx = context();
        const agent = await seedAgent(ctx);
        const before = (await request(ctx.app, 'GET', `/v1/agents/${agent.id}`)).body;

        const posted = await request(ctx.app, 'POST', `/v1/agents/${agent.id}`, body);
        const afterPost = (await request(ctx.app, 'GET', `/v1/agents/${agent.id}`)).body;
        const put = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, body);

        expect(posted.res.status, `${label}: status`).toBe(put.res.status);
        expect(posted.body, `${label}: body`).toEqual(put.body);
        expect(afterPost.version, `${label}: version after POST`).toBe(
          changesSomething ? agent.version + 1 : agent.version,
        );
        // A POST that changes nothing must not move the resource, exactly as PUT does
        // not: the two verbs are one implementation.
        if (!changesSomething) {
          expect(afterPost, `${label}: stored state`).toEqual(before);
        }
      }
    });

    it('keeps partial-update semantics and the expected_version precondition', async () => {
      const ctx = context();
      const agent = await seedAgent(ctx);

      const changed = await request(ctx.app, 'POST', `/v1/agents/${agent.id}`, { description: 'POST description.' });
      expect(changed.res.status).toBe(200);
      expect(changed.body.description).toBe('POST description.');
      // Omitted fields are kept, not cleared: the verb is a spelling of the same
      // partial update, not a full replace.
      expect(changed.body.system).toBe('Original system.');
      expect(changed.body.tools).toHaveLength(2);
      expect(changed.body.version).toBe(agent.version + 1);

      const stale = await request(ctx.app, 'POST', `/v1/agents/${agent.id}`, {
        system: 'ignored',
        expected_version: agent.version,
      });
      expect(stale.res.status).toBe(409);
      expect(stale.body.error.type).toBe('conflict');
    });

    it('does not capture POST /v1/agents/:id/archive', async () => {
      // `POST /:id` and `POST /:id/archive` share a prefix. Adding the shorter pattern
      // must not shadow the archive handler, so this drives the real route rather than
      // reading the mount table.
      const ctx = context();
      const agent = await seedAgent(ctx);

      const archived = await request(ctx.app, 'POST', `/v1/agents/${agent.id}/archive`);
      expect(archived.res.status).toBe(200);
      expect(archived.body.status).toBe('archived');
      // The update handler would have answered 404 for an archived agent, so reaching
      // the archive body at all is what proves the right handler ran.
      expect(archived.body.system).toBe('Original system.');

      const updateAfterArchive = await request(ctx.app, 'POST', `/v1/agents/${agent.id}`, { system: 'too late' });
      expect(updateAfterArchive.res.status).toBe(404);
    });
  });

  describe('the published `version` spelling of the concurrency precondition', () => {
    /**
     * The published contract names this field `version`: "`version` 字段是可选的：提供它
     * 可实现乐观并发控制（不匹配时返回 409），省略它则无条件应用更新（最后写入者获胜）"
     * (`定义您的智能体/智能体设置.md:350`), and the published update example sends
     * `"version": $AGENT_VERSION` (`:361`). The runtime reads `expected_version`, and
     * `version` fell through to the unknown-field guard, so the published example was
     * answered `400 Unknown agent update field "version"` — which is why mounting the
     * published verb (#452) was necessary but not sufficient.
     */
    it('applies the precondition through `version`, identically to `expected_version`', async () => {
      // Two agents in the same state, one per spelling, so the only difference between
      // the two runs is the field name in the body.
      const perSpelling = [
        { field: 'expected_version', value: 'local' },
        { field: 'version', value: 'published' },
      ] as const;

      const results = [];
      for (const { field } of perSpelling) {
        const ctx = context();
        const agent = await seedAgent(ctx);

        const applied = await request(ctx.app, 'POST', `/v1/agents/${agent.id}`, {
          system: 'guarded write',
          [field]: agent.version,
        });
        const afterApply = (await request(ctx.app, 'GET', `/v1/agents/${agent.id}`)).body;

        // A stale value must be a 409 that does not land the write. Reading the agent
        // back is the assertion that matters: a 409 whose update still applied would be
        // the lost write this field exists to prevent.
        const stale = await request(ctx.app, 'POST', `/v1/agents/${agent.id}`, {
          system: 'stale write',
          [field]: agent.version,
        });
        const afterStale = (await request(ctx.app, 'GET', `/v1/agents/${agent.id}`)).body;

        results.push({ field, applied: applied.res.status, afterApplySystem: afterApply.system, afterApplyVersion: afterApply.version,
          stale: stale.res.status, staleType: stale.body.error?.type, afterStaleSystem: afterStale.system, afterStaleVersion: afterStale.version });
      }

      expect(results[0].applied).toBe(200);
      expect(results[1]).toEqual({ ...results[0], field: 'version' });
      // Stated as literals too, so the equality above cannot be satisfied by two
      // identically wrong answers.
      expect(results[1].afterApplySystem).toBe('guarded write');
      expect(results[1].afterApplyVersion).toBe(2);
      expect(results[1].stale).toBe(409);
      expect(results[1].staleType).toBe('conflict');
      expect(results[1].afterStaleSystem).toBe('guarded write');
      expect(results[1].afterStaleVersion).toBe(2);
    });

    it('drives the exact published example body over the published verb', async () => {
      // The shape from `智能体设置.md:357-362`: a POST with `name`, `model`, `system`
      // and `version`. `name` and `model` are read back from the stored agent rather
      // than taken from the fixture, so the body re-sends the real current values —
      // which is what the published example does with its shell variables.
      const ctx = context();
      const agent = await seedAgent(ctx);
      const truth = (await request(ctx.app, 'GET', `/v1/agents/${agent.id}`)).body;

      const published = await request(ctx.app, 'POST', `/v1/agents/${agent.id}`, {
        name: truth.name,
        model: truth.model,
        system: 'Updated from the published example.',
        version: agent.version,
      });

      expect(published.res.status).toBe(200);
      expect(published.body.system).toBe('Updated from the published example.');
      expect(published.body.name).toBe(truth.name);
      expect(published.body.model).toBe(truth.model);
      expect(published.body.version).toBe(agent.version + 1);
    });

    it('refuses two spellings that disagree instead of picking one', async () => {
      // They name one precondition, so a precedence rule would silently apply an update
      // the other value said not to.
      const ctx = context();
      const agent = await seedAgent(ctx);
      const before = (await request(ctx.app, 'GET', `/v1/agents/${agent.id}`)).body;

      const disagreed = await request(ctx.app, 'POST', `/v1/agents/${agent.id}`, {
        system: 'ambiguous write',
        version: agent.version,
        expected_version: agent.version + 1,
      });
      expect(disagreed.res.status).toBe(400);
      expect(disagreed.body.error.details).toContainEqual(expect.objectContaining({
        message: expect.stringContaining('disagree'),
      }));

      const after = (await request(ctx.app, 'GET', `/v1/agents/${agent.id}`)).body;
      expect(after).toEqual(before);

      // The order of the two keys must not change the answer.
      const reversed = await request(ctx.app, 'POST', `/v1/agents/${agent.id}`, {
        system: 'ambiguous write',
        expected_version: agent.version + 1,
        version: agent.version,
      });
      expect(reversed.res.status).toBe(400);

      // Agreeing values carry nothing to resolve, so they are accepted.
      const agreed = await request(ctx.app, 'POST', `/v1/agents/${agent.id}`, {
        system: 'agreed write',
        version: agent.version,
        expected_version: agent.version,
      });
      expect(agreed.res.status).toBe(200);
      expect(agreed.body.system).toBe('agreed write');
      expect(agreed.body.version).toBe(agent.version + 1);
    });

    it('rejects a malformed `version` rather than applying an unguarded update', async () => {
      const ctx = context();
      const agent = await seedAgent(ctx);
      const before = (await request(ctx.app, 'GET', `/v1/agents/${agent.id}`)).body;

      for (const bad of ['abc', '', 0, -1, 1.5, null, {}] as unknown[]) {
        const rejected = await request(ctx.app, 'POST', `/v1/agents/${agent.id}`, {
          system: 'unguarded',
          version: bad,
        });
        expect(rejected.res.status, `version=${JSON.stringify(bad)}`).toBe(400);
        expect(rejected.body.error.details, `version=${JSON.stringify(bad)}`).toContainEqual({
          path: 'version',
          message: 'version must be a positive integer',
        });
      }

      // None of the rejected attempts may have moved the agent. A 400 whose write
      // landed would be the unguarded update the strictness exists to prevent.
      expect((await request(ctx.app, 'GET', `/v1/agents/${agent.id}`)).body).toEqual(before);

      // A numeric string is accepted, because the published example interpolates a
      // shell variable and the value can arrive as either type.
      const asString = await request(ctx.app, 'POST', `/v1/agents/${agent.id}`, {
        system: 'string version',
        version: String(agent.version),
      });
      expect(asString.res.status).toBe(200);
      expect(asString.body.version).toBe(agent.version + 1);
    });

    it('never writes the precondition into the stored definition', async () => {
      // `version` is a precondition, not a definition field: it must not become part of
      // what the agent is, and it must not let a caller force the stored version number.
      const ctx = context();
      const agent = await seedAgent(ctx);

      const forced = await request(ctx.app, 'POST', `/v1/agents/${agent.id}`, {
        system: 'x',
        version: 99,
      });
      // 99 does not match version 1, so it is a 409 and nothing is written.
      expect(forced.res.status).toBe(409);

      const applied = await request(ctx.app, 'POST', `/v1/agents/${agent.id}`, {
        system: 'x',
        version: agent.version,
      });
      expect(applied.res.status).toBe(200);
      expect(applied.body.version).toBe(agent.version + 1);

      const stored = JSON.parse(storedRow(ctx, agent.id).definition) as Record<string, unknown>;
      expect(stored).not.toHaveProperty('version');
      expect(stored).not.toHaveProperty('expected_version');
      expect(stored.system).toBe('x');
    });

    it('reads the published spelling on the local PUT verb identically', async () => {
      // `POST` is the published verb and `PUT` is the local spelling of the same
      // operation, so the precondition cannot be a property of one verb. Asserted
      // directly rather than inferred from the POST cases, because a resolver wired
      // into only one route would leave the local verb refusing a body it accepts.
      const ctx = context();
      const agent = await seedAgent(ctx);

      const applied = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
        system: 'via PUT version',
        version: agent.version,
      });
      expect(applied.res.status).toBe(200);
      expect(applied.body.system).toBe('via PUT version');
      expect(applied.body.version).toBe(agent.version + 1);

      const stale = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
        system: 'stale',
        version: agent.version,
      });
      expect(stale.res.status).toBe(409);
      expect((await request(ctx.app, 'GET', `/v1/agents/${agent.id}`)).body.system).toBe('via PUT version');
    });
  });

  it('rejects unknown fields instead of silently discarding them', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);

    const rejected = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { nickname: 'slippy' });
    expect(rejected.res.status).toBe(400);
    expect(rejected.body.error.details).toContainEqual({
      path: 'nickname',
      message: 'Unknown agent update field "nickname"',
    });
    expect(storedRow(ctx, agent.id).version).toBe(1);
  });

  it('keeps capability admission, MCP wiring, and roster validation on the merged definition', async () => {
    const ctx = context();
    const plain = await seedAgent(ctx, {
      name: 'Plain agent',
      model: 'gpt-4o',
      system: 'Stay offline.',
    });
    // `web_fetch` executes behind the address guard, so capability admission
    // no longer refuses it. `web_search` still has no provider.
    const searchAttempt = await request(ctx.app, 'PUT', `/v1/agents/${plain.id}`, {
      tools: [{ type: 'agent_toolset_20260401', configs: [{ name: 'web_search' }] }],
    });
    expect(searchAttempt.res.status).toBe(400);
    expect(searchAttempt.body.error.type).toBe('unsupported_capability');
    expect(JSON.stringify(searchAttempt.body)).toContain('web_search');
    expect((await request(ctx.app, 'GET', `/v1/agents/${plain.id}`)).body.tools).toEqual([]);

    // A domain list on a tool that does execute is accepted by admission and
    // validated by the grammar rather than refused.
    const fetchAttempt = await request(ctx.app, 'PUT', `/v1/agents/${plain.id}`, {
      tools: [{ type: 'agent_toolset_20260401', configs: [{ name: 'web_fetch', allowed_domains: ['example.com'] }] }],
    });
    expect(fetchAttempt.res.status).toBe(200);

    const agent = await seedAgent(ctx);
    const dangling = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'ghost-server' }],
    });
    expect(dangling.res.status).toBe(400);
    expect(JSON.stringify(dangling.body)).toContain('undeclared MCP server');

    // The canonical roster is refused with the capability it names, so this
    // path and the create path answer a `multiagent` field identically rather
    // than one of them stripping it.
    const rosterAttempt = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
      multiagent: { type: 'coordinator', agents: [{ type: 'agent', id: plain.id }] },
    });
    expect(rosterAttempt.res.status).toBe(400);
    expect(rosterAttempt.body.error.details).toContainEqual({
      path: 'multiagent',
      message: expect.stringContaining('multiagent-roster'),
    });

    // The local delegation extension is a different field: both write paths
    // accept it, because the executor honours it when it builds delegation
    // tools.
    const subagentAttempt = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, {
      enable_general_subagent: true,
    });
    expect(subagentAttempt.res.status).toBe(200);
    expect(JSON.parse(storedRow(ctx, agent.id).definition).enable_general_subagent).toBe(true);
  });

  it('keeps response, stored row, versions, list, and the in-memory cache consistent', async () => {
    const ctx = context();
    const agent = await seedAgent(ctx);

    const first = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { system: 'Version two.' });
    const second = await request(ctx.app, 'PUT', `/v1/agents/${agent.id}`, { system: 'Version three.' });
    expect(second.body.version).toBe(3);

    const got = await request(ctx.app, 'GET', `/v1/agents/${agent.id}`);
    expect(got.body.version).toBe(3);
    expect(got.body.system).toBe('Version three.');

    const list = await request(ctx.app, 'GET', '/v1/agents');
    const listed = list.body.data.find((item: any) => item.id === agent.id);
    expect(listed.version).toBe(3);
    expect(listed.system).toBe('Version three.');

    const versions = await request(ctx.app, 'GET', `/v1/agents/${agent.id}/versions`);
    expect(versions.body.data.map((item: any) => item.version)).toEqual([3, 2, 1]);
    expect(versions.body.data[0].system).toBe('Version three.');
    expect(versions.body.data[2].system).toBe('Original system.');

    const row = storedRow(ctx, agent.id);
    expect(row.version).toBe(3);
    expect(JSON.parse(row.definition).system).toBe('Version three.');
    expect(versionRows(ctx, agent.id)).toEqual([1, 2, 3]);

    const cached = ctx.agents.find((item) => item.name === 'Contract agent');
    expect(cached?.system).toBe('Version three.');

    // The snapshot taken at create time is untouched by later updates.
    const firstVersion = await request(ctx.app, 'GET', `/v1/agents/${agent.id}`);
    expect(firstVersion.body.version).toBe(3);
    expect(versions.body.data.find((item: any) => item.version === 1).tools).toHaveLength(2);
  });

});
