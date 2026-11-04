import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '@/core/db/database.js';
import { SessionManager, type SessionExecutor } from '@/core/session/session-manager.js';
import { toApiEvent } from '@/api/standard.js';
import type { CostProfile } from '@/core/session/cost-profile.js';
import type { AgentDefinition } from '@/types/agent.js';

/** Prices the fixture agent's model so a budget may attach to its sessions. */
const PROFILE: CostProfile = {
  id: 'test',
  models: {
    'conformance-model': { input_per_mtok_cents: 1000, output_per_mtok_cents: 1000 },
  },
  web_search_per_1000_cents: 0,
  active_hour_cents: 0,
};

const AGENT_DEFINITION: AgentDefinition = {
  name: 'test-agent',
  model: 'conformance-model',
  system: 'You are a test agent.',
  tools: [
    {
      type: 'agent_toolset_20260401',
      configs: [{ name: 'glob', enabled: true }],
    },
  ],
};

const NEW_TOOLS: AgentDefinition['tools'] = [
  {
    type: 'agent_toolset_20260401',
    configs: [
      { name: 'glob', enabled: true },
      { name: 'read', enabled: true },
    ],
  },
];

describe('session update', () => {
  let directory: string;
  let database: Database;
  let manager: SessionManager;

  const agentRowDefinition = (): string =>
    (database.prepare('SELECT definition FROM agents WHERE id = ?').get('agent_test') as { definition: string }).definition;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ma-session-update-'));
    database = new Database(join(directory, 'test.db'));
    database.runMigrations();
    database.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    database
      .prepare(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'test-agent', ?)`)
      .run(JSON.stringify(AGENT_DEFINITION));
    manager = new SessionManager(database);
  });

  afterEach(async () => {
    await manager.shutdown();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('renames a session and reports only the title on session.updated', async () => {
    const session = manager.create({ agent: 'agent_test' });

    const updated = await manager.updateSession(session.id, { title: 'Renamed' });

    expect(updated.title).toBe('Renamed');
    expect(manager.get(session.id)?.title).toBe('Renamed');
    const events = manager.getEventLogger().getEvents(session.id);
    expect(events).toHaveLength(1);
    const apiEvent = toApiEvent(events[0]!);
    expect(apiEvent.type).toBe('session.updated');
    expect(apiEvent.title).toBe('Renamed');
    expect(apiEvent.agent).toBeUndefined();
    expect(apiEvent.metadata).toBeUndefined();
  });

  it('clears the title when sent null and reports title: null', async () => {
    const session = manager.create({ agent: 'agent_test', title: 'Original' });

    const updated = await manager.updateSession(session.id, { title: null });

    expect(updated.title).toBeUndefined();
    const events = manager.getEventLogger().getEvents(session.id);
    expect(toApiEvent(events[0]!).title).toBeNull();
  });

  it('merges metadata per key, deletes on null, and reports the resulting bag', async () => {
    const session = manager.create({ agent: 'agent_test', metadata: { a: '1' } });

    const updated = await manager.updateSession(session.id, { metadata: { b: '2', a: null } });

    expect(updated.metadata).toEqual({ b: '2' });
    expect(manager.get(session.id)?.metadata).toEqual({ b: '2' });
    const events = manager.getEventLogger().getEvents(session.id);
    expect(events).toHaveLength(1);
    const apiEvent = toApiEvent(events[0]!);
    expect(apiEvent.metadata).toEqual({ b: '2' });
    expect(apiEvent.title).toBeUndefined();
    expect(apiEvent.agent).toBeUndefined();
  });

  it('omits the metadata field when the update clears the whole bag', async () => {
    const session = manager.create({ agent: 'agent_test', metadata: { a: '1' } });

    const updated = await manager.updateSession(session.id, { metadata: { a: null } });

    expect(updated.metadata).toEqual({});
    const events = manager.getEventLogger().getEvents(session.id);
    expect(events).toHaveLength(1);
    expect(toApiEvent(events[0]!).metadata).toBeUndefined();
  });

  it('treats a null metadata field as no change', async () => {
    const session = manager.create({ agent: 'agent_test', metadata: { a: '1' } });

    const updated = await manager.updateSession(session.id, { metadata: null });

    expect(updated.metadata).toEqual({ a: '1' });
    expect(manager.getEventLogger().getEvents(session.id)).toEqual([]);
  });

  it('materializes an agent snapshot on a tools swap and emits the full snapshot', async () => {
    const resetMcp = vi.fn(async () => {});
    const executor: SessionExecutor = { async *execute() {}, resetSessionMcpConnections: resetMcp };
    manager.setExecutor(executor);
    const session = manager.create({ agent: 'agent_test' });
    expect(session.agentDefinition).toBeUndefined();
    const agentBefore = agentRowDefinition();

    const updated = await manager.updateSession(session.id, { agent: { tools: NEW_TOOLS } });

    // The session now carries its own definition; the agent row it came from
    // is untouched.
    expect(updated.agentDefinition?.tools).toEqual(NEW_TOOLS);
    expect(manager.get(session.id)?.agentDefinition?.tools).toEqual(NEW_TOOLS);
    expect(agentRowDefinition()).toBe(agentBefore);
    expect(resetMcp).toHaveBeenCalledWith(session.id);

    const events = manager.getEventLogger().getEvents(session.id);
    expect(events).toHaveLength(1);
    const apiEvent = toApiEvent(events[0]!);
    expect(apiEvent.type).toBe('session.updated');
    expect(apiEvent.agent).toMatchObject({
      id: 'agent_test',
      type: 'agent',
      name: 'test-agent',
      model: { id: 'conformance-model', speed: 'standard' },
      tools: NEW_TOOLS,
    });
    expect(apiEvent.metadata).toBeUndefined();
    expect(apiEvent.title).toBeUndefined();
  });

  it('accepts an mcp_toolset that names a server in the same update', async () => {
    const session = manager.create({ agent: 'agent_test' });

    const updated = await manager.updateSession(session.id, {
      agent: {
        tools: [{ type: 'mcp_toolset', mcp_server_name: 'srv', configs: [] }],
        mcp_servers: [{ name: 'srv', type: 'url', url: 'https://example.com/mcp' }],
      },
    });

    expect(updated.agentDefinition?.mcp_servers).toEqual([{ name: 'srv', type: 'url', url: 'https://example.com/mcp' }]);
    expect(manager.getEventLogger().getEvents(session.id)).toHaveLength(1);
  });

  it('rejects an mcp_toolset naming a server the new list does not have', async () => {
    const session = manager.create({ agent: 'agent_test' });

    await expect(manager.updateSession(session.id, {
      agent: { tools: [{ type: 'mcp_toolset', mcp_server_name: 'missing', configs: [] }] },
    })).rejects.toMatchObject({ code: 'invalid_agent_definition' });
    expect(manager.get(session.id)?.agentDefinition).toBeUndefined();
    expect(manager.getEventLogger().getEvents(session.id)).toEqual([]);
  });

  it('rejects an agent field that is not tools or mcp_servers by name', async () => {
    const session = manager.create({ agent: 'agent_test' });

    await expect(manager.updateSession(session.id, {
      agent: { model: 'other-model' } as never,
    })).rejects.toMatchObject({ code: 'agent_field_not_updatable' });
    expect(manager.getEventLogger().getEvents(session.id)).toEqual([]);
  });

  it('treats an agent patch carrying neither tools nor mcp_servers as no change', async () => {
    const session = manager.create({ agent: 'agent_test' });

    const updated = await manager.updateSession(session.id, { agent: {} });

    expect(updated.agentDefinition).toBeUndefined();
    expect(manager.getEventLogger().getEvents(session.id)).toEqual([]);
  });

  it('does not materialize a snapshot or emit an event for an identical tools rewrite', async () => {
    const session = manager.create({ agent: 'agent_test' });

    const updated = await manager.updateSession(session.id, { agent: { tools: AGENT_DEFINITION.tools } });

    expect(updated.agentDefinition).toBeUndefined();
    expect(manager.get(session.id)?.agentDefinition).toBeUndefined();
    expect(manager.getEventLogger().getEvents(session.id)).toEqual([]);
  });

  it('emits nothing for a request that changes no field', async () => {
    const session = manager.create({ agent: 'agent_test', title: 'Same', metadata: { a: '1' } });

    const updated = await manager.updateSession(session.id, { title: 'Same', metadata: { a: '1' } });

    expect(updated.title).toBe('Same');
    expect(manager.getEventLogger().getEvents(session.id)).toEqual([]);
  });

  it('applies an agent plus metadata plus title patch atomically in one event', async () => {
    const session = manager.create({ agent: 'agent_test', metadata: { a: '1' } });

    const updated = await manager.updateSession(session.id, {
      agent: { tools: NEW_TOOLS },
      metadata: { b: '2' },
      title: 'Renamed',
    });

    expect(updated.title).toBe('Renamed');
    expect(updated.metadata).toEqual({ a: '1', b: '2' });
    expect(updated.agentDefinition?.tools).toEqual(NEW_TOOLS);
    const events = manager.getEventLogger().getEvents(session.id);
    expect(events).toHaveLength(1);
    const apiEvent = toApiEvent(events[0]!);
    expect(apiEvent.title).toBe('Renamed');
    expect(apiEvent.metadata).toEqual({ a: '1', b: '2' });
    expect(apiEvent.agent).toMatchObject({ tools: NEW_TOOLS });
  });

  it('leaves the session untouched when one field of a mixed update fails', async () => {
    const session = manager.create({ agent: 'agent_test', metadata: { a: '1' } });

    await expect(manager.updateSession(session.id, {
      agent: { model: 'other-model' } as never,
      metadata: { b: '2' },
      title: 'Renamed',
    })).rejects.toMatchObject({ code: 'agent_field_not_updatable' });

    const persisted = manager.get(session.id)!;
    expect(persisted.metadata).toEqual({ a: '1' });
    expect(persisted.title).toBeUndefined();
    expect(persisted.agentDefinition).toBeUndefined();
    expect(manager.getEventLogger().getEvents(session.id)).toEqual([]);
  });

  it('refuses an agent change on a running session but still accepts a rename', async () => {
    const session = manager.create({ agent: 'agent_test' });
    database.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);

    await expect(manager.updateSession(session.id, {
      agent: { tools: NEW_TOOLS },
    })).rejects.toMatchObject({ code: 'session_not_idle' });

    const renamed = await manager.updateSession(session.id, { title: 'While running' });
    expect(renamed.title).toBe('While running');
    expect(manager.getEventLogger().getEvents(session.id)).toHaveLength(1);
  });

  it('rebinds vault_ids, reports them on session.updated, and tears down MCP connections', async () => {
    const resetMcp = vi.fn(async () => {});
    const executor: SessionExecutor = { async *execute() {}, resetSessionMcpConnections: resetMcp };
    manager.setExecutor(executor);
    const session = manager.create({ agent: 'agent_test', vaultIds: ['vlt_one'] });
    expect(session.vaultIds).toEqual(['vlt_one']);

    const updated = await manager.updateSession(session.id, { vault_ids: ['vlt_two', 'vlt_three'] });

    expect(updated.vaultIds).toEqual(['vlt_two', 'vlt_three']);
    expect(manager.get(session.id)?.vaultIds).toEqual(['vlt_two', 'vlt_three']);
    const apiEvent = toApiEvent(manager.getEventLogger().getEvents(session.id)[0]!);
    expect(apiEvent.type).toBe('session.updated');
    expect(apiEvent.vault_ids).toEqual(['vlt_two', 'vlt_three']);
    expect(apiEvent.title).toBeUndefined();
    // A live transport holds the headers it was built with; the teardown makes
    // a detached vault's credentials unreachable instead of lingering.
    expect(resetMcp).toHaveBeenCalledWith(session.id);
  });

  it('detaches every vault on an empty vault_ids array', async () => {
    const session = manager.create({ agent: 'agent_test', vaultIds: ['vlt_one'] });

    const updated = await manager.updateSession(session.id, { vault_ids: [] });

    expect(updated.vaultIds).toEqual([]);
    const apiEvent = toApiEvent(manager.getEventLogger().getEvents(session.id)[0]!);
    expect(apiEvent.vault_ids).toEqual([]);
  });

  it('treats a reordered or unchanged vault_ids set as a no-op', async () => {
    const session = manager.create({ agent: 'agent_test', vaultIds: ['vlt_one', 'vlt_two'] });

    const same = await manager.updateSession(session.id, { vault_ids: ['vlt_two', 'vlt_one'] });
    expect(same.vaultIds).toEqual(['vlt_one', 'vlt_two']);

    const unchanged = await manager.updateSession(session.id, { vault_ids: ['vlt_one', 'vlt_two'] });
    expect(unchanged.vaultIds).toEqual(['vlt_one', 'vlt_two']);
    expect(manager.getEventLogger().getEvents(session.id)).toEqual([]);
  });

  it('moves the budget through the update path and reports it on session.updated', async () => {
    manager.setCostProfile(PROFILE);
    const session = manager.create({
      agent: 'agent_test',
      budget: { type: 'limit', max_list_cost: { amount: '10', currency: 'USD' } },
    });

    const updated = await manager.updateSession(session.id, {
      budget: { type: 'limit', max_list_cost: { amount: '50', currency: 'USD' } },
    });

    expect(updated.budget?.max_list_cost.amount).toBe('50');
    const events = manager.getEventLogger().getEvents(session.id);
    expect(events).toHaveLength(1);
    const apiEvent = toApiEvent(events[0]!);
    expect(apiEvent.type).toBe('session.updated');
    expect(apiEvent.budget).toEqual({ type: 'limit', max_list_cost: { amount: '50', currency: 'USD' } });
    expect(apiEvent.title).toBeUndefined();
    expect(apiEvent.agent).toBeUndefined();
  });

  it('removes the budget with null and reports budget: null', async () => {
    manager.setCostProfile(PROFILE);
    const session = manager.create({
      agent: 'agent_test',
      budget: { type: 'limit', max_list_cost: { amount: '10', currency: 'USD' } },
    });

    const updated = await manager.updateSession(session.id, { budget: null });

    expect(updated.budget).toBeNull();
    const apiEvent = toApiEvent(manager.getEventLogger().getEvents(session.id)[0]!);
    expect(apiEvent.budget).toBeNull();
  });

  it('refuses an update on a terminated session', async () => {
    const session = manager.create({ agent: 'agent_test' });
    database.prepare("UPDATE sessions SET status = 'completed' WHERE id = ?").run(session.id);

    await expect(manager.updateSession(session.id, { title: 'Nope' }))
      .rejects.toMatchObject({ code: 'session_terminated' });
    expect(manager.getEventLogger().getEvents(session.id)).toEqual([]);
  });

  it('refuses an update on an archived session', async () => {
    manager.setExecutor({ async *execute() {}, cleanupSession: async () => {} });
    const session = manager.create({ agent: 'agent_test' });
    await manager.archive(session.id);

    await expect(manager.updateSession(session.id, { title: 'Nope' }))
      .rejects.toMatchObject({ code: 'session_terminated' });
  });

  it('rejects a session that does not exist', async () => {
    await expect(manager.updateSession('sess_missing', { title: 'Nope' }))
      .rejects.toThrow(/not found/i);
  });
});
