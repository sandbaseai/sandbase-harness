/**
 * Integration test for the Managed Agents API.
 * Validates: Requirements 7.1, 7.2, 7.3, 7.6
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { loadSkills } from '@/core/skills/loader.js';
import { createLogger, InMemoryLogStore } from '@/core/observability/logger.js';
import { composeRuntimeFromSettings } from '@/core/runtime/composition.js';
import { activateRuntimeSettings, getOrSeedRuntimeSettings, saveRuntimeSettings } from '@/core/settings/store.js';
import { ModelRegistry } from '@/model/registry.js';
import {
  CAPABILITY_AREAS,
  CAPABILITY_STATUSES,
  CMA_CAPABILITY_MATRIX,
  capabilityMatrixJson,
} from '@/core/capabilities/matrix.js';
import type { Session, SessionEvent, SessionStatus } from '@/types/session.js';
import type { UserEvent } from '@/types/cma-protocol.js';
import type { RuntimeModelInfo } from '@/types/model.js';

describe('Managed Agents API', () => {
  let app: ReturnType<typeof createServer>;
  let db: Database;
  let tmpDir: string;
  let dataDir: string;
  let agentsDir: string;
  let skillsDir: string;
  let logStore: InMemoryLogStore;
  let restartRequested = false;
  let runtimeModelsData: RuntimeModelInfo[] = [];

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-api-test-'));
    agentsDir = join(tmpDir, 'agents');
    skillsDir = join(tmpDir, 'skills');
    dataDir = join(tmpDir, '.managed-agents');
    const configPath = join(tmpDir, '.managed-agents', 'config.yaml');
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(agentsDir, 'echo-agent.yaml'), 'name: echo-agent\nmodel: claude-sonnet-4-6\n');
    mkdirSync(join(skillsDir, 'research'), { recursive: true });
    writeFileSync(join(skillsDir, 'research', 'SKILL.md'), '---\nname: research\ndescription: Use cited sources.\n---\n# Research\n\nUse cited sources.\n');
    writeFileSync(configPath, 'model:\n  provider: openai\n  api_key: secret-value\n');
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO credential_vaults (id, name) VALUES ('vlt_test', 'test vault')`);
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_echo-agent',
      'echo-agent',
      JSON.stringify({
        name: 'echo-agent',
        model: 'gpt-4o',
        system: 'Echo back what the user says.',
      }),
    );

    const sessionManager = new SessionManager(db, undefined, 'pi', undefined, (engine) => engine === 'builtin' || engine === 'pi');
    sessionManager.setExecutor({
      async *execute(session: Session, event: UserEvent): AsyncIterable<SessionEvent> {
        // UserEvent is a discriminated union and only some members carry
        // content, so narrow rather than reaching through the union.
        const blocks = event.type === 'user.message' ? event.content : undefined;
        const text = blocks?.find((block) => block.type === 'text')?.text ?? '';
        yield {
          id: 'sevt_fake_agent_message',
          sessionId: session.id,
          seq: 0,
          type: 'agent.message',
          content: [{ type: 'text', text: `echo: ${text}` }],
          createdAt: new Date(),
        };
      },
    });

    logStore = new InMemoryLogStore();
    const logger = createLogger({ level: 'debug', logStore, write: () => undefined });
    logger.info('test_runtime_ready', { component: 'integration' });

    runtimeModelsData = [{
      name: 'local',
      provider: 'openai',
      model: 'gpt-4o',
      api_key_state: 'configured',
      base_url_state: 'not_set',
      is_default: true,
    }];

    app = createServer({
      db,
      sessionManager,
      agents: [
        {
          name: 'echo-agent',
          model: 'gpt-4o',
          system: 'Echo back what the user says.',
        },
      ],
      consoleRoot: null,
      workspace: {
        root: tmpDir,
        dataDir,
        agentsDir,
        skillsDir,
        configPath,
        target: 'local',
      },
      runtime: {
        models: runtimeModelsData,
        sandboxProviders: ['local'],
        memory: 'disabled',
        authEnabled: false,
      },
      skills: loadSkills(skillsDir).skills,
      logger,
      logStore,
      restart: () => {
        restartRequested = true;
        logger.warn('test_restart_called', { component: 'integration' });
      },
      listRuntimeModels: () => runtimeModelsData,
      registerModelProvider: (provider) => {
        const next: RuntimeModelInfo = {
          name: provider.name,
          provider: provider.provider,
          model: provider.model,
          base_url: provider.base_url,
          api_key_state: provider.api_key ? 'configured' : 'not_set',
          base_url_state: provider.base_url ? 'configured' : 'not_set',
          is_default: Boolean(provider.is_default),
        };
        runtimeModelsData = runtimeModelsData.filter((model) => model.name !== next.name);
        if (next.is_default) {
          runtimeModelsData = runtimeModelsData.map((model) => ({ ...model, is_default: false }));
        }
        runtimeModelsData.unshift(next);
      },
      setDefaultRuntimeModel: (name) => {
        runtimeModelsData = runtimeModelsData.map((model) => ({ ...model, is_default: model.name === name }));
      },
      reloadAgents: () => ({ agents: [], errors: [] }),
    });
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function getJson(path: string) {
    const res = await app.request(path);
    return { res, body: await res.json() as any };
  }

  async function postJson(path: string, body: unknown, method: 'POST' | 'PUT' = 'POST') {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { res, body: await res.json() as any };
  }

  function expectPage(body: any) {
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.has_more).toBe('boolean');
    expect(body.first_id === null || typeof body.first_id === 'string').toBe(true);
    expect(body.last_id === null || typeof body.last_id === 'string').toBe(true);
  }

  /**
   * The canonical envelope, for the collections the contract has converted.
   *
   * `contracts/anthropic-cma/pagination.md` §4 names the collections still on the
   * local shape, so which helper a path uses is a statement about the contract
   * rather than about this file's convenience.
   */
  function expectCursorPage(body: any) {
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.prev_page === null || typeof body.prev_page === 'string').toBe(true);
    expect(body.next_page === null || typeof body.next_page === 'string').toBe(true);
    expect(body).not.toHaveProperty('has_more');
    expect(body).not.toHaveProperty('first_id');
    expect(body).not.toHaveProperty('last_id');
  }

  describe('GET /', () => {
    it('returns server info', async () => {
      const res = await app.request('/');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('managed-agents');
    });
  });

  describe('GET /dashboard', () => {
    it('requires the built Console artifact', async () => {
      const res = await app.request('/dashboard');
      expect(res.status).toBe(503);
      expect(res.headers.get('content-type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('Dashboard not built');
    });

    it('redirects the legacy /ui path to /dashboard', async () => {
      const res = await app.request('/ui');
      expect(res.status).toBe(308);
      expect(res.headers.get('location')).toBe('/dashboard');
    });
  });

  describe('POST /v1/sessions', () => {
    it('creates a session', async () => {
      const res = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'agent_echo-agent' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toMatch(/^sess_/);
      expect(body.status).toBe('idle');
      expect(body.agent.id).toBe('agent_echo-agent');
      expect(body.agent.name).toBe('echo-agent');
      expect(body.loop_engine).toBe('pi');
    });
    it('creates a session with initial events in one call', async () => {
      const res = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: 'agent_echo-agent',
          initial_events: [{ type: 'user.message', content: 'hello' }],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toMatch(/^sess_/);
      // A non-empty list starts the loop in the same call.
      expect(body.status).toBe('running');
      // The creation response does not echo the batch.
      expect(body).not.toHaveProperty('initial_events');

      const events = ((await (await app.request(`/v1/sessions/${body.id}/events`)).json()) as any).data as any[];
      const userMessages = events.filter((event) => event.type === 'user.message');
      expect(userMessages).toHaveLength(1);
      expect(JSON.stringify(userMessages[0])).toContain('hello');
    });

    it('treats an empty initial_events array like an omitted field', async () => {
      const res = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'agent_echo-agent', initial_events: [] }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.status).toBe('idle');

      const events = ((await (await app.request(`/v1/sessions/${body.id}/events`)).json()) as any).data as any[];
      expect(events.filter((event) => event.type === 'user.message')).toHaveLength(0);
    });

    it('rejects an invalid initial_events batch without creating a session', async () => {
      const before = ((await (await app.request('/v1/sessions')).json()) as any).data.length;

      const notAnArray = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'agent_echo-agent', initial_events: 'nope' }),
      });
      expect(notAnArray.status).toBe(400);
      expect((await notAnArray.json()).error.code).toBe('invalid_initial_events');

      const tooMany = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: 'agent_echo-agent',
          initial_events: Array.from({ length: 51 }, () => ({ type: 'user.message', content: 'x' })),
        }),
      });
      expect(tooMany.status).toBe(400);
      expect((await tooMany.json()).error.code).toBe('too_many_initial_events');

      const wrongType = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'agent_echo-agent', initial_events: [{ type: 'user.interrupt' }] }),
      });
      expect(wrongType.status).toBe(400);
      expect((await wrongType.json()).error.code).toBe('invalid_initial_event_type');

      const badContent = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'agent_echo-agent', initial_events: [{ type: 'user.message', content: 42 }] }),
      });
      expect(badContent.status).toBe(400);
      expect((await badContent.json()).error.code).toBe('invalid_initial_events');

      const after = ((await (await app.request('/v1/sessions')).json()) as any).data.length;
      expect(after).toBe(before);
    });


    it('freezes an explicit executable loop engine in create, detail, and list responses', async () => {
      const created = await postJson('/v1/sessions', { agent: 'agent_echo-agent', loop_engine: 'builtin' });
      expect(created.res.status).toBe(201);
      expect(created.body.loop_engine).toBe('builtin');

      const detail = await getJson(`/v1/sessions/${created.body.id}`);
      expect(detail.body.loop_engine).toBe('builtin');

      const list = await getJson('/v1/sessions');
      const listed = (list.body.data as Array<{ id: string; loop_engine: string }>)
        .find((session) => session.id === created.body.id);
      expect(listed?.loop_engine).toBe('builtin');
    });

    it('rejects unavailable or invalid engines before creating a session row', async () => {
      for (const [loop_engine, code] of [
        ['codex', 'loop_engine_not_supported'],
        ['gpt-5', 'loop_engine_invalid'],
        [42, 'loop_engine_invalid'],
      ] as const) {
        const before = (db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
        const rejected = await postJson('/v1/sessions', { agent: 'agent_echo-agent', loop_engine });
        expect(rejected.res.status).toBe(400);
        expect(rejected.body.error.code).toBe(code);
        const after = (db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
        expect(after).toBe(before);
      }
    });

    it('keeps the Pi policy gate on explicit engine selection', async () => {
      // Pi has no MCP transport, so an enabled `mcp_toolset` is a capability the
      // agent declares and Pi cannot provide. Selecting the engine explicitly must
      // still run admission and refuse it rather than silently dropping the
      // toolset. (`always_ask` no longer stands here: it is admitted and gated,
      // which the test below asserts.)
      db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
        'agent_pi_admission_mcp',
        'pi-admission-mcp',
        JSON.stringify({
          name: 'pi-admission-mcp',
          model: 'gpt-4o',
          system: 'Use the tools.',
          tools: [{ type: 'mcp_toolset', mcp_server_name: 'tools-server', configs: [] }],
        }),
      );

      const rejected = await postJson('/v1/sessions', {
        agent: 'agent_pi_admission_mcp',
        loop_engine: 'pi',
      });
      expect(rejected.res.status).toBe(400);
      expect(rejected.body.error.code).toBe('pi_tool_policy_not_supported');
      expect(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE agent_id = ?')
        .get('agent_pi_admission_mcp')).toEqual({ count: 0 });
      db.prepare('DELETE FROM agents WHERE id = ?').run('agent_pi_admission_mcp');
    });

    it('reports executable capabilities and rejects unavailable web tools before persistence', async () => {
      const capabilities = await getJson('/v1/x/capabilities');
      expect(capabilities.res.status).toBe(200);
      expect(capabilities.body).toMatchObject({ type: 'capability_inventory' });
      expect(capabilities.body.capabilities).toContainEqual({ id: 'read', kind: 'tool', status: 'available' });
      expect(capabilities.body.capabilities).toContainEqual({
        id: 'web_fetch',
        kind: 'tool',
        status: 'available',
      });
      expect(capabilities.body.capabilities).toContainEqual({
        id: 'web_search',
        kind: 'tool',
        status: 'unavailable',
        reason: 'No search provider is bundled or configured in this runtime; web_search declarations are accepted but not executable.',
      });

      const webAgent = {
        name: 'web-agent',
        model: 'gpt-4o',
        system: 'Use web tools.',
        tools: [{
          type: 'agent_toolset_20260401',
          configs: [{ name: 'web_fetch' }, { name: 'web_search' }],
        }],
      };
      const agentCountBefore = (db.prepare('SELECT COUNT(*) AS count FROM agents').get() as { count: number }).count;
      const rejectedAgent = await postJson('/v1/agents', webAgent);
      expect(rejectedAgent.res.status).toBe(400);
      expect(rejectedAgent.body.error).toEqual({
        type: 'unsupported_capability',
        message: 'Agent requests unavailable runtime capabilities: web_search',
        details: {
          capabilities: [
            { id: 'web_search', reason: 'No search provider is bundled or configured in this runtime; web_search declarations are accepted but not executable.' },
          ],
        },
      });
      expect((db.prepare('SELECT COUNT(*) AS count FROM agents').get() as { count: number }).count).toBe(agentCountBefore);

      db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
        'agent_legacy-web',
        'legacy-web',
        JSON.stringify(webAgent),
      );
      const sessionCountBefore = (db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
      const rejectedSession = await postJson('/v1/sessions', { agent: 'agent_legacy-web' });
      expect(rejectedSession.res.status).toBe(400);
      expect(rejectedSession.body.error).toEqual(rejectedAgent.body.error);
      expect((db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(sessionCountBefore);
      db.prepare('DELETE FROM agents WHERE id = ?').run('agent_legacy-web');
    });

    it('serves the contract matrix beside the runtime tool inventory', async () => {
      const { res, body } = await getJson('/v1/x/capabilities');
      expect(res.status).toBe(200);
      expect(body.type).toBe('capability_inventory');
      // The inventory half keeps its shape and its status codes.
      expect(body.capabilities).toContainEqual({ id: 'read', kind: 'tool', status: 'available' });

      const contract = body.contract;
      // Verbatim, not merely consistent in shape: `/v1/x/capabilities` is the
      // machine copy of `matrix.ts`, and a field that drifts from the module is
      // a capability claim nothing else would catch.
      expect(contract).toEqual(capabilityMatrixJson());
      expect(contract.type).toBe('capability_matrix');
      expect(contract.statuses).toEqual([...CAPABILITY_STATUSES]);
      // The served entry count agrees with the matrix data, so the endpoint cannot
      // serve a stale subset of it.
      expect(contract.capabilities).toHaveLength(CMA_CAPABILITY_MATRIX.length);

      const areas = new Set<string>(CAPABILITY_AREAS);
      const statuses = new Set<string>(CAPABILITY_STATUSES);
      for (const entry of contract.capabilities) {
        expect(areas.has(entry.area), `unknown contract area ${entry.area}`).toBe(true);
        expect(statuses.has(entry.status), `unknown status ${entry.status}`).toBe(true);
        if (entry.status !== 'supported') {
          expect(entry.reason, `${entry.id} carries no reason`).toBeTruthy();
        }
        expect(entry.contract.startsWith('contracts/anthropic-cma/')).toBe(true);
        expect(existsSync(join(process.cwd(), entry.contract)), `${entry.contract} is missing`).toBe(true);
      }

      // Every area the matrix declares is represented in the response. Areas carry
      // more than one entry, so the property is coverage rather than a single entry.
      for (const area of CAPABILITY_AREAS) {
        expect(
          contract.capabilities.some((entry: { area: string }) => entry.area === area),
          `no entry for contract area ${area}`,
        ).toBe(true);
      }

      // The summary describes the entries the response actually carries.
      const derived: Record<string, number> = Object.fromEntries(CAPABILITY_STATUSES.map((status) => [status, 0]));
      for (const entry of contract.capabilities) derived[entry.status] += 1;
      expect(contract.summary).toEqual(derived);
    });

    it('accepts standard agent refs, resources, vault ids, and redacts repository tokens', async () => {
      // Both of these are inputs to the create below, and both are asserted at the
      // step that produces them. Without this the case could only report the 400 it
      // gets one step later, when `file_id` or `memory_store_id` arrives undefined -
      // which is what happened once under load, and left the fault unnamed.
      const { res: storeRes, body: store } = await postJson('/v1/memory_stores', {
        name: 'Session resource memory',
        description: 'Mounted session memory.',
      });
      expect(storeRes.status, 'creating the memory store the session mounts').toBe(201);
      expect(typeof store.id, 'the created memory store carries an id').toBe('string');

      const { res: fileRes, body: file } = await postJson('/v1/files', {
        name: 'resource.txt',
        media_type: 'text/plain',
        content: 'session resource',
      });
      expect(fileRes.status, 'creating the file the session mounts').toBe(201);
      expect(typeof file.id, 'the created file carries an id').toBe('string');
      const { res, body } = await postJson('/v1/sessions', {
        title: 'resource run',
        agent: { id: 'agent_echo-agent', type: 'agent', version: 1 },
        environment_id: 'env_default',
        vault_ids: ['vlt_test'],
        resources: [
          { type: 'file', file_id: file.id, mount_path: '/uploads/file.txt' },
          {
            type: 'github_repository',
            url: 'https://github.com/example/repo',
            authorization_token: 'ghp_super_secret_token',
            checkout: { type: 'branch', name: 'main' },
            mount_path: '/workspace/repo',
          },
          { type: 'memory_store', memory_store_id: store.id, mount_path: '/memory' },
        ],
        metadata: { source: 'contract-test' },
      });

      // Name the inputs and echo the reason, so a refusal here says which of the
      // three references it rejected rather than only that the status was 400.
      expect(
        res.status,
        `creating the session over store=${store.id} file=${file.id}: ${body?.error?.message ?? 'no error message'}`,
      ).toBe(201);
      expect(body.agent.id).toBe('agent_echo-agent');
      expect(body.environment_id).toBe('env_default');
      expect(body.title).toBe('resource run');
      expect(body.vault_ids).toEqual(['vlt_test']);
      expect(body.metadata.source).toBe('contract-test');
      expect(body.resources).toHaveLength(3);
      expect(JSON.stringify(body.resources)).not.toContain('ghp_super_secret_token');
      expect(body.resources.find((resource: any) => resource.type === 'github_repository').authorization_token).toBeUndefined();
      expect(body.resources.find((resource: any) => resource.type === 'memory_store').memory_store_id).toBe(store.id);

      const detail = await app.request(`/v1/sessions/${body.id}`);
      expect(JSON.stringify(await detail.json())).not.toContain('ghp_super_secret_token');
      const stored = db.prepare('SELECT resources FROM sessions WHERE id = ?').get(body.id) as { resources: string };
      expect(stored.resources).not.toContain('ghp_super_secret_token');
      expect(stored.resources).toContain('encrypted_secret');
    });

    it('rejects session resources that do not reference existing workspace resources', async () => {
      const { res, body } = await postJson('/v1/sessions', {
        agent: 'agent_echo-agent',
        resources: [{ type: 'file', file_id: 'file_missing', mount_path: '/uploads/missing.txt' }],
      });

      expect(res.status).toBe(400);
      expect(body.error.message).toContain('File not found');
    });

    it('rejects malformed session environment, vault, and resource references', async () => {
      const missingEnvironment = await postJson('/v1/sessions', {
        agent: 'agent_echo-agent',
        environment_id: 'env_missing',
      });
      expect(missingEnvironment.res.status).toBe(400);
      expect(missingEnvironment.body.error.message).toContain('Environment not found');

      const malformedVault = await postJson('/v1/sessions', {
        agent: 'agent_echo-agent',
        vault_ids: ['vlt_test', 42],
      });
      expect(malformedVault.res.status).toBe(400);
      expect(malformedVault.body.error.message).toContain('vault_ids[1]');

      const missingVault = await postJson('/v1/sessions', {
        agent: 'agent_echo-agent',
        vault_ids: ['vlt_missing'],
      });
      expect(missingVault.res.status).toBe(400);
      expect(missingVault.body.error.message).toContain('Credential vault not found');

      const malformedCheckout = await postJson('/v1/sessions', {
        agent: 'agent_echo-agent',
        resources: [
          {
            type: 'github_repository',
            url: 'https://github.com/example/repo',
            authorization_token: 'ghp_super_secret_token',
            checkout: ['main'],
          },
        ],
      });
      expect(malformedCheckout.res.status).toBe(400);
      expect(malformedCheckout.body.error.message).toContain('checkout');

      const missingMemoryStore = await postJson('/v1/sessions', {
        agent: 'agent_echo-agent',
        resources: [{ type: 'memory_store', memory_store_id: 'memstore_missing' }],
      });
      expect(missingMemoryStore.res.status).toBe(400);
      expect(missingMemoryStore.body.error.message).toContain('Memory store not found');
    });

    it('rejects Pi named non-local Environments before session persistence with a stable client error', async () => {
      db.prepare('INSERT INTO environments (id, name, config) VALUES (?, ?, ?)').run(
        'env_pi_docker',
        'Pi Docker',
        JSON.stringify({ sandbox_provider: 'docker' }),
      );

      const { res, body } = await postJson('/v1/sessions', {
        agent: 'agent_echo-agent',
        environment_id: 'env_pi_docker',
      });

      expect(res.status).toBe(400);
      expect(body).toEqual({
        error: {
          type: 'invalid_request_error',
          code: 'pi_sandbox_provider_not_supported',
          message: 'Pi loop engine requires the local sandbox provider because it needs a host-accessible work directory.',
        },
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE environment_id = ?').get('env_pi_docker'))
        .toEqual({ count: 0 });
      db.prepare('DELETE FROM environments WHERE id = ?').run('env_pi_docker');
    });

    it('refuses an Environment the runtime cannot resolve before the session exists', async () => {
      db.prepare('INSERT INTO environments (id, name, config) VALUES (?, ?, ?)').run(
        'env_unservable',
        'Unservable hosting',
        JSON.stringify({ hosting_type: 'edge_cluster' }),
      );
      db.prepare('INSERT INTO environments (id, name, config) VALUES (?, ?, ?)').run(
        'env_damaged',
        'Damaged config',
        '{oops',
      );

      const unservable = await postJson('/v1/sessions', {
        agent: 'agent_echo-agent',
        environment_id: 'env_unservable',
      });
      expect(unservable.res.status).toBe(400);
      expect(unservable.body.error.code).toBe('unsupported_hosting_type');
      expect(unservable.body.error.message).toContain('hosting_type "edge_cluster"');

      const damaged = await postJson('/v1/sessions', {
        agent: 'agent_echo-agent',
        environment_id: 'env_damaged',
      });
      expect(damaged.res.status).toBe(400);
      expect(damaged.body.error.code).toBe('invalid_environment_config');

      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sessions WHERE environment_id IN ('env_unservable', 'env_damaged')`,
      ).get()).toEqual({ count: 0 });
      db.prepare(`DELETE FROM environments WHERE id IN ('env_unservable', 'env_damaged')`).run();
    });

    it('admits Pi sessions for agents requesting always_ask instead of refusing them', async () => {
      db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
        'agent_pi_always_ask',
        'pi-always-ask',
        JSON.stringify({
          name: 'pi-always-ask',
          model: 'gpt-4o',
          system: 'Ask first.',
          tools: [{
            type: 'agent_toolset_20260401',
            configs: [{ name: 'bash', permission_policy: { type: 'always_ask' } }],
          }],
        }),
      );

      const { res, body } = await postJson('/v1/sessions', { agent: 'agent_pi_always_ask' });

      // This request used to answer `pi_always_ask_not_supported` with no session
      // row. The managed gate replaces that refusal: the session is created, and
      // the decision is asked for when the tool is called rather than before the
      // session exists, so the approval the client renders is one the runtime can
      // actually consume.
      expect(res.status).toBe(201);
      expect(body.error).toBeUndefined();
      expect(body.loop_engine).toBe('pi');
      expect(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE agent_id = ?').get('agent_pi_always_ask'))
        .toEqual({ count: 1 });
      db.prepare('DELETE FROM sessions WHERE agent_id = ?').run('agent_pi_always_ask');
      db.prepare('DELETE FROM agents WHERE id = ?').run('agent_pi_always_ask');
    });

    it('maps a legacy Pi resume with an unenforceable policy to the stable client error', async () => {
      db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
        'agent_pi_legacy_mcp',
        'pi-legacy-mcp',
        JSON.stringify({
          name: 'pi-legacy-mcp',
          model: 'gpt-4o',
          system: 'Use the tools.',
          tools: [{ type: 'mcp_toolset', mcp_server_name: 'tools-server', configs: [] }],
        }),
      );
      // Model a PI row created before the creation-time policy gate landed.
      const legacy = new SessionManager(db, undefined, 'builtin').create({ agent: 'agent_pi_legacy_mcp' });
      db.prepare('UPDATE sessions SET loop_engine = ? WHERE id = ?').run('pi', legacy.id);
      const expected = {
        error: {
          type: 'invalid_request_error',
          code: 'pi_tool_policy_not_supported',
          message: 'Pi 0.84.4 has no MCP transport; mcp_toolset "tools-server" cannot be enforced',
        },
      };

      const eventResult = await postJson(`/v1/sessions/${legacy.id}/events`, {
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'resume' }] }],
      });
      expect(eventResult.res.status).toBe(400);
      expect(eventResult.body).toEqual(expected);

      const messageResult = await postJson(`/v1/sessions/${legacy.id}/messages`, {
        content: 'resume',
        stream: false,
      });
      expect(messageResult.res.status).toBe(400);
      expect(messageResult.body).toEqual(expected);

      // Streaming is the default; preflight must reject before committing an
      // SSE response so clients receive the same stable HTTP error.
      const streamedMessageResult = await postJson(`/v1/sessions/${legacy.id}/messages`, {
        content: 'resume',
      });
      expect(streamedMessageResult.res.status).toBe(400);
      expect(streamedMessageResult.body).toEqual(expected);

      const history = await getJson(`/v1/sessions/${legacy.id}/events`);
      expect(history.res.status).toBe(200);
      expect(history.body.data).toEqual([]);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(legacy.id);
      db.prepare('DELETE FROM agents WHERE id = ?').run('agent_pi_legacy_mcp');
    });

    it('rejects unsupported Pi user events before persisting an event batch', async () => {
      const created = await postJson('/v1/sessions', { agent: 'agent_echo-agent' });
      expect(created.res.status).toBe(201);
      const expected = {
        error: {
          type: 'invalid_request_error',
          code: 'pi_user_event_not_supported',
          message: 'Pi loop engine supports only user.message, user.interrupt, user.steer, and user.tool_confirmation events.',
        },
      };
      const unsupportedEvents = [
        // `user.tool_confirmation` used to be refused here; it now settles a gate
        // the Pi session raised, so a custom-tool result is the remaining inbound
        // event with no Pi transport behind it.
        {
          type: 'user.custom_tool_result',
          custom_tool_use_id: 'tool_1',
          content: [{ type: 'text', text: 'result' }],
        },
      ];

      for (const event of unsupportedEvents) {
        const result = await postJson(`/v1/sessions/${created.body.id}/events`, { events: [event] });
        expect(result.res.status).toBe(400);
        expect(result.body).toEqual(expected);
      }

      // Preflight every element before calling sendEvent so no valid prefix is
      // logged when a later event is unsupported by the persisted Pi engine.
      const mixed = await postJson(`/v1/sessions/${created.body.id}/events`, {
        events: [
          { type: 'user.message', content: [{ type: 'text', text: 'do not persist' }] },
          unsupportedEvents[0],
        ],
      });
      expect(mixed.res.status).toBe(400);
      expect(mixed.body).toEqual(expected);

      const history = await getJson(`/v1/sessions/${created.body.id}/events`);
      expect(history.res.status).toBe(200);
      expect(history.body.data).toEqual([]);

      const interrupted = await postJson(`/v1/sessions/${created.body.id}/events`, {
        events: [{ type: 'user.interrupt' }],
      });
      expect(interrupted.res.status).toBe(200);
      const interruptedHistory = await getJson(`/v1/sessions/${created.body.id}/events`);
      expect(interruptedHistory.body.data.map((event: { type: string }) => event.type)).toEqual(['user.interrupt']);
    });

    it('accepts user.steer as its own event and answers a refused steer as not accepted', async () => {
      const created = await postJson('/v1/sessions', { agent: 'agent_echo-agent' });
      expect(created.res.status).toBe(201);
      const sessionId = created.body.id as string;

      // This runtime's executor owns no live engine session, so the steer cannot be
      // delivered. The answer has to say so rather than acknowledging a delivery
      // the engine never saw.
      const steered = await postJson(`/v1/sessions/${sessionId}/events`, {
        events: [{ type: 'user.steer', input_id: 'steer_1', text: 'be brief' }],
      });
      expect(steered.res.status).toBe(200);
      expect(steered.body).toEqual({
        accepted: false,
        steer: {
          input_id: 'steer_1',
          state: 'rejected',
          detail: 'no live engine session is accepting steering for this session',
        },
      });

      // The event is its own kind in the log — never projected into a user.message
      // — and it carries the receipt a client reads back.
      const history = await getJson(`/v1/sessions/${sessionId}/events`);
      expect(history.res.status).toBe(200);
      expect(history.body.data.map((event: { type: string }) => event.type)).toEqual(['user.steer']);
      expect(history.body.data[0].content).toEqual([{ type: 'text', text: 'be brief' }]);
      expect(history.body.data[0].metadata).toMatchObject({
        input_id: 'steer_1',
        steer_state: 'rejected',
      });

      // A later read-back cannot turn it into a turn: no agent reply was produced
      // for it, and no `turn_complete` was published.
      expect(history.body.data.some((event: { type: string }) => event.type === 'agent.message')).toBe(false);
    });

    it('refuses a steer that is missing its idempotency key or text', async () => {
      const created = await postJson('/v1/sessions', { agent: 'agent_echo-agent' });
      const sessionId = created.body.id as string;

      const cases: Array<[Record<string, unknown>, string]> = [
        [{ type: 'user.steer', text: 'be brief' }, 'input_id'],
        [{ type: 'user.steer', input_id: 'steer_1', text: '' }, 'text'],
        [{ type: 'user.steer', input_id: 'steer_1', text: 'x', expected_turn_id: 7 }, 'expected_turn_id'],
      ];
      for (const [event, field] of cases) {
        const result = await postJson(`/v1/sessions/${sessionId}/events`, { events: [event] });
        expect(result.res.status).toBe(400);
        expect(result.body.error.message).toContain(field);
      }

      // Neither refused steer left a durable record: a steer the runtime cannot
      // account for is refused, not stored for a later turn.
      const history = await getJson(`/v1/sessions/${sessionId}/events`);
      expect(history.body.data).toEqual([]);
    });

    it('rejects without agent field', async () => {
      const res = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('ignores unknown fields (Property 15 - forward compatibility)', async () => {
      const res = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: 'agent_echo-agent',
          unknown_field: 'should be ignored',
          nested: { also: 'ignored' },
        }),
      });
      expect(res.status).toBe(201);
    });
  });

  describe('GET /v1/sessions', () => {
    it('retrieves and filters every internal status by its public projection, including pagination', async () => {
      db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)')
        .run('agent_status-projection', 'status-projection', '{}');
      const manager = new SessionManager(db);
      const groups: Record<string, SessionStatus[]> = {
        idle: ['queued', 'paused', 'requires_action'],
        running: ['running'],
        terminated: ['completed', 'failed', 'cancelled', 'timed_out', 'cleanup_pending'],
        rescheduling: [],
      };

      for (const [wire, statuses] of Object.entries(groups)) {
        const expectedIds: string[] = [];
        for (const status of statuses) {
          const session = manager.create({ agent: 'agent_status-projection' });
          db.prepare('UPDATE sessions SET status = ?, created_at = ? WHERE id = ?')
            .run(status, new Date(Date.UTC(2026, 0, 1, 0, 0, expectedIds.length)).toISOString(), session.id);
          expectedIds.push(session.id);
          const response = await app.request(`/v1/sessions/${session.id}`);
          expect(response.status).toBe(200);
          expect((await response.json()).status).toBe(wire);
        }

        const receivedIds: string[] = [];
        let cursor: string | null = null;
        do {
          const response = await app.request(`/v1/sessions?statuses[]=${wire}&agent_id=agent_status-projection&limit=2${cursor ? `&page=${encodeURIComponent(cursor)}` : ''}`);
          expect(response.status).toBe(200);
          const page = await response.json();
          expectCursorPage(page);
          expect(page.data.every((session: { status: string }) => session.status === wire)).toBe(true);
          receivedIds.push(...page.data.map((session: { id: string }) => session.id));
          cursor = page.next_page;
        } while (cursor);
        expect(receivedIds.sort()).toEqual(expectedIds.sort());
      }
      // `failed` is not one of the published four: the internally failed
      // session already surfaced inside the terminated group above, and naming
      // it as a filter value earns the same 400 as any other invalid value.
      const failedResponse = await app.request('/v1/sessions?statuses=failed&agent_id=agent_status-projection');
      expect(failedResponse.status).toBe(400);
      const failedSession = db.prepare('SELECT id, status FROM sessions WHERE status = ?').get('failed') as { id: string; status: string };
      expect(failedSession.status).toBe('failed');
      const singleResponse = await app.request(`/v1/sessions/${failedSession.id}`);
      expect((await singleResponse.json()).status).toBe('terminated');
    });

    it('lists sessions with pagination', async () => {
      // Create a few sessions
      for (let i = 0; i < 3; i++) {
        await app.request('/v1/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: 'agent_echo-agent' }),
        });
      }

      const res = await app.request('/v1/sessions?limit=2');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeLessThanOrEqual(2);
      expectCursorPage(body);
    });
  });

  describe('GET /v1/sessions/:id', () => {
    it('returns session detail', async () => {
      const createRes = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'agent_echo-agent' }),
      });
      const { id } = await createRes.json();

      const res = await app.request(`/v1/sessions/${id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(id);
    });

    it('returns 404 for non-existent session', async () => {
      const res = await app.request('/v1/sessions/sess_nonexist');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /v1/sessions/:id/stop', () => {
    it.each(['completed', 'failed', 'cancelled', 'timed_out', 'cleanup_pending'])('returns 409 for an already terminal %s session', async (status) => {
      const createRes = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'agent_echo-agent' }),
      });
      const { id } = await createRes.json();
      db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, id);
      const response = await app.request(`/v1/sessions/${id}/stop`, { method: 'POST' });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { type: 'conflict' } });
    });

    it('returns an unchanged idle session envelope', async () => {
      const createRes = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'agent_echo-agent' }),
      });
      const { id } = await createRes.json();

      const res = await app.request(`/v1/sessions/${id}/stop`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id, type: 'session', status: 'idle', agent: { id: 'agent_echo-agent' } });

      const getRes = await app.request(`/v1/sessions/${id}`);
      const session = await getRes.json();
      expect(session.status).toBe('idle');
    });
  });

  describe('POST /v1/sessions/:id/events - validation', () => {
    async function createSession() {
      const res = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'agent_echo-agent' }),
      });
      return (await res.json()).id as string;
    }

    it('rejects empty body (no type) with 400', async () => {
      const id = await createSession();
      const res = await app.request(`/v1/sessions/${id}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe('invalid_request_error');
    });

    it('rejects non-user event types with 400', async () => {
      const id = await createSession();
      const res = await app.request(`/v1/sessions/${id}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [{ type: 'agent.message', content: [] }] }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for events on non-existent session', async () => {
      const res = await app.request('/v1/sessions/sess_nope/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [{ type: 'user.message', content: [{ type: 'text', text: 'hi' }] }] }),
      });
      expect(res.status).toBe(404);
    });

    it('refuses an event when the session Environment no longer resolves', async () => {
      db.prepare('INSERT INTO environments (id, name, config) VALUES (?, ?, ?)').run(
        'env_local_hosting',
        'Local hosting',
        JSON.stringify({ hosting_type: 'local' }),
      );
      const created = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'agent_echo-agent', environment_id: 'env_local_hosting' }),
      });
      expect(created.status).toBe(201);
      const sessionId = (await created.json()).id as string;

      // The Environment is edited into a hosting type this runtime cannot run.
      // Admission must report that as a client error before the append-only log
      // or any execution, instead of resolving to the local backend.
      db.prepare(`UPDATE environments SET config = '{"hosting_type":"edge_cluster"}' WHERE id = 'env_local_hosting'`).run();
      const res = await app.request(`/v1/sessions/${sessionId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [{ type: 'user.message', content: [{ type: 'text', text: 'hi' }] }] }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('unsupported_hosting_type');
      expect(db.prepare('SELECT COUNT(*) AS count FROM events WHERE session_id = ?').get(sessionId))
        .toEqual({ count: 0 });
      // Archived rather than deleted: the session still references this row.
      db.prepare(`UPDATE environments SET archived_at = datetime('now') WHERE id = 'env_local_hosting'`).run();
    });
  });

  describe('POST /v1/sessions/:id/messages', () => {
    async function createSession() {
      const res = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'agent_echo-agent' }),
      });
      return (await res.json()).id as string;
    }

    it('accepts a string message without streaming', async () => {
      const id = await createSession();
      const res = await app.request(`/v1/sessions/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hi', stream: false }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ accepted: true });
    });

    it('rejects invalid message content with 400', async () => {
      const id = await createSession();
      const res = await app.request(`/v1/sessions/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(null),
      });

      expect(res.status).toBe(400);
    });

    it('streams a message turn by default', async () => {
      const id = await createSession();
      const res = await app.request(`/v1/sessions/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: [{ type: 'text', text: 'hello' }] }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const text = await res.text();
      expect(text).toContain('event: user.message');
      expect(text).toContain('event: agent.message');
      expect(text).toContain('echo: hello');
      expect(text).toContain('event: session.status_idle');
    });

    it('emits a session.usage snapshot immediately before session.status_idle', async () => {
      const id = await createSession();
      const res = await app.request(`/v1/sessions/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hello' }),
      });

      const text = await res.text();
      const usageAt = text.indexOf('event: session.usage');
      const idleAt = text.indexOf('event: session.status_idle');
      expect(usageAt).toBeGreaterThan(-1);
      expect(usageAt).toBeLessThan(idleAt);

      const events = ((await (await app.request(`/v1/sessions/${id}/events`)).json()) as any).data as any[];
      const usageIndex = events.findIndex((event) => event.type === 'session.usage');
      const idleIndex = events.findIndex((event) => event.type === 'session.status_idle');
      expect(usageIndex).toBeGreaterThan(-1);
      expect(idleIndex).toBe(usageIndex + 1);

      const usage = events[usageIndex].usage;
      expect(usage.input_tokens).toBe(0);
      expect(usage.output_tokens).toBe(0);
      expect(usage.active_seconds).toBeGreaterThanOrEqual(0);
      // Capabilities this runtime does not have are omitted, not zeroed.
      expect(usage).not.toHaveProperty('list_cost');
      expect(usage).not.toHaveProperty('budget');
      expect(usage).not.toHaveProperty('server_tool_use');
    });

    describe('POST /v1/runs', () => {
    async function postRun(body: Record<string, unknown>) {
      return app.request('/v1/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    it('runs one turn and returns its output and usage', async () => {
      const res = await postRun({ agent: 'agent_echo-agent', input: 'hello' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.run_id).toMatch(/^sess_/);
      expect(body.session_id).toBe(body.run_id);
      expect(body.status).toBe('completed');
      expect(JSON.stringify(body.output)).toContain('echo: hello');
      expect(body.usage).toMatchObject({ input_tokens: expect.any(Number), output_tokens: expect.any(Number) });

      // The input is durable, so the turn replays from the session log.
      const events = ((await (await app.request(`/v1/sessions/${body.run_id}/events`)).json()) as any).data as any[];
      expect(events.some((event) => event.type === 'user.message')).toBe(true);
      expect(events.some((event) => event.type === 'session.status_idle')).toBe(true);
    });

    it('accepts an async run with a query handle', async () => {
      const res = await postRun({
        agent: 'agent_echo-agent',
        input: 'hello',
        response_mode: 'async',
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.run_id).toMatch(/^sess_/);
      expect(body.status).toBe('running');
      expect(body.events_url).toBe(`/v1/sessions/${body.run_id}/events`);
      expect(body.stream_url).toBe(`/v1/sessions/${body.run_id}/events/stream`);
    });

    it('streams the session events in sse mode', async () => {
      const res = await postRun({
        agent: 'agent_echo-agent',
        input: 'hello',
        response_mode: 'sse',
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const text = await res.text();
      expect(text).toContain('event: user.message');
      expect(text).toContain('event: agent.message');
      expect(text).toContain('event: session.status_idle');
    });

    it('answers 202 with a deadline marker when the wait budget elapses', async () => {
      const res = await postRun({
        agent: 'agent_echo-agent',
        input: 'hello',
        max_wait_seconds: 0,
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.wait_deadline_reached).toBe(true);
      expect(body.status).toBe('running');
      // The transport deadline did not stop the turn.
      const session = await (await app.request(`/v1/sessions/${body.run_id}`)).json();
      expect(session.id).toBe(body.run_id);
    });

    it('rejects an unusable request before a session exists', async () => {
      const before = ((await (await app.request('/v1/sessions')).json()) as any).data.length;

      const unknownEngine = await postRun({ agent: 'agent_echo-agent', input: 'hi', loop_engine: 'harness' });
      expect(unknownEngine.status).toBe(400);
      expect((await unknownEngine.json()).error.code).toBe('loop_engine_not_supported');

      const bogusEngine = await postRun({ agent: 'agent_echo-agent', input: 'hi', loop_engine: 'nope' });
      expect(bogusEngine.status).toBe(400);
      expect((await bogusEngine.json()).error.code).toBe('loop_engine_invalid');

      const emptyArray = await postRun({ agent: 'agent_echo-agent', input: [] });
      expect(emptyArray.status).toBe(400);

      const wrongType = await postRun({ agent: 'agent_echo-agent', input: 42 });
      expect(wrongType.status).toBe(400);

      const badMode = await postRun({ agent: 'agent_echo-agent', input: 'hi', response_mode: 'later' });
      expect(badMode.status).toBe(400);

      const after = ((await (await app.request('/v1/sessions')).json()) as any).data.length;
      expect(after).toBe(before);
    });
  });

  it('returns 404 for messages on non-existent sessions', async () => {
      const res = await app.request('/v1/sessions/sess_nope/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hi' }),
      });
      expect(res.status).toBe(404);
    });

    it('returns 409 for messages on terminal (completed) sessions', async () => {
      const id = await createSession();
      db.prepare("UPDATE sessions SET status = 'completed' WHERE id = ?").run(id);

      const res = await app.request(`/v1/sessions/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hi' }),
      });
      expect(res.status).toBe(409);
    });

    it('rejects all failed-session ingress without changing the event log', async () => {
      const id = await createSession();
      db.prepare(`UPDATE sessions SET status = 'failed' WHERE id = ?`).run(id);

      const before = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq').all(id);
      const requests = [
        { path: 'messages', body: { content: 'retry', stream: false } },
        { path: 'messages', body: { content: 'retry', stream: true } },
        { path: 'events', body: { events: [{ type: 'user.message', content: [{ type: 'text', text: 'retry' }] }, { type: 'user.interrupt' }] } },
        { path: 'events', body: { events: [{ type: 'user.tool_confirmation', tool_use_id: 'call_pending', result: 'allow' }] } },
      ];
      for (const request of requests) {
        const res = await app.request(`/v1/sessions/${id}/${request.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.body),
        });
        expect(res.status).toBe(409);
        expect((await res.json()).error.type).toBe('conflict');
        expect(db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq').all(id)).toEqual(before);
        expect(db.prepare('SELECT status FROM sessions WHERE id = ?').get(id)).toEqual({ status: 'failed' });
      }
    });
  });

  describe('GET /v1/sessions/:id/events', () => {
    it('returns 404 for non-existent session', async () => {
      const res = await app.request('/v1/sessions/sess_nope/events');
      expect(res.status).toBe(404);
    });

    it('returns events with id cursors for a valid session', async () => {
      const createRes = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'agent_echo-agent' }),
      });
      const { id } = await createRes.json();

      const res = await app.request(`/v1/sessions/${id}/events`);
      expect(res.status).toBe(200);
      const body = await res.json();
      // The published envelope: `has_more` / `first_id` / `last_id` appear nowhere in
      // the published contract, so asserting them here asserted the defect.
      expectCursorPage(body);
      expect(body.next_page).toBeNull();
      expect(body.prev_page).toBeNull();
    });
  });

  describe('GET /v1/agents', () => {
    it('lists loaded agents', async () => {
      const res = await app.request('/v1/agents');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('echo-agent');
    });
  });

  describe('POST /v1/agents', () => {
    it('stores created agents in SQLite without writing source YAML files', async () => {
      const { res, body } = await postJson('/v1/agents', {
        name: 'runtime-agent',
        description: 'Created through the API.',
        model: 'claude-sonnet-5',
        system: 'Handle runtime requests.',
        tools: [{ type: 'agent_toolset_20260401' }],
      });

      expect(res.status).toBe(201);
      expect(body.id).toMatch(/^agent_/);
      expect(body.id).not.toBe('agent_runtime-agent');
      expect(body.name).toBe('runtime-agent');
      expect(existsSync(join(agentsDir, 'runtime-agent.yaml'))).toBe(false);
      expect(existsSync(join(agentsDir, 'Runtime agent.yaml'))).toBe(false);

      const row = db.prepare('SELECT definition FROM agents WHERE id = ?').get(body.id) as
        | { definition: string }
        | undefined;
      expect(row).toBeDefined();
      expect(JSON.parse(row!.definition).name).toBe('runtime-agent');

      const list = await getJson('/v1/agents');
      expect(list.body.data.some((item: any) => item.id === body.id)).toBe(true);
    });

    it('allows duplicate display names because ids are server generated', async () => {
      const definition = {
        name: 'duplicate-name-agent',
        model: 'gpt-4o',
        system: 'Handle duplicate names.',
      };

      const first = await postJson('/v1/agents', definition);
      const second = await postJson('/v1/agents', definition);

      expect(first.res.status).toBe(201);
      expect(second.res.status).toBe(201);
      expect(first.body.name).toBe('duplicate-name-agent');
      expect(second.body.name).toBe('duplicate-name-agent');
      expect(first.body.id).toMatch(/^agent_/);
      expect(second.body.id).toMatch(/^agent_/);
      expect(second.body.id).not.toBe(first.body.id);
    });
  });

  describe('GET /v1/agents/:id', () => {
    it('does not resolve agents by bare name', async () => {
      const res = await app.request('/v1/agents/echo-agent');
      expect(res.status).toBe(404);
    });

    it('returns agent detail by prefixed id', async () => {
      const res = await app.request('/v1/agents/agent_echo-agent');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('echo-agent');
      expect(body.model).toBe('gpt-4o');
    });

    it('returns 404 for non-existent agent', async () => {
      const res = await app.request('/v1/agents/nonexist');
      expect(res.status).toBe(404);
    });
  });

  describe('standard API page contracts', () => {
    it('returns standard page envelopes for collection endpoints', async () => {
      // Converted to the canonical envelope: the collections that return their
      // complete set, so both cursors are null and no local field is present, plus
      // the windowed skills listing, whose cursor can be followed.
      const cursorCollectionPaths = [
        '/v1/agents',
        '/v1/api-keys',
        '/v1/credential-vaults',
        '/v1/environments',
        '/v1/files',
        '/v1/memory_stores',
        '/v1/sessions',
        '/v1/skills',
      ];
      // Still on the local envelope: the `/v1/x` mirror of the operations surface.
      const collectionPaths = [
        '/v1/x/templates',
      ];

      for (const path of cursorCollectionPaths) {
        const { res, body } = await getJson(path);
        expect(res.status, path).toBe(200);
        expectCursorPage(body);
      }

      for (const path of collectionPaths) {
        const { res, body } = await getJson(path);
        expect(res.status, path).toBe(200);
        expectPage(body);
      }
    });

    it('exposes workspace, runtime, templates, and standard skills metadata for the console', async () => {
      const workspaceRes = await app.request('/v1/x/workspace');
      expect(workspaceRes.status).toBe(200);
      const workspace = await workspaceRes.json();
      expect(workspace.type).toBe('workspace');
      expect(workspace.name).toBeTruthy();
      expect(workspace.directories).toBeDefined();
      expect(typeof workspace.directories).toBe('object');

      const runtimeRes = await app.request('/v1/x/runtime');
      expect(runtimeRes.status).toBe(200);
      const runtime = await runtimeRes.json();
      expect(runtime.type).toBe('runtime');
      expect(runtime.status).toBe('running');
      expect(runtime.agents_loaded).toBeGreaterThanOrEqual(1);
      expect(runtime.models[0]).toMatchObject({
        name: 'local',
        api_key_state: 'configured',
      });
      expect(runtime.models[0]).not.toHaveProperty('api_key');

      const templatesRes = await app.request('/v1/x/templates');
      const templates = await templatesRes.json();
      const incidentCommander = templates.data.find((item: any) => item.name === 'Incident commander');
      expect(incidentCommander).toBeDefined();
      expect(incidentCommander.agent.model).toBe('gpt-4o');
      expect(templates.data.every((item: any) => item.agent.model === 'gpt-4o')).toBe(true);
      expect(incidentCommander.agent.tools.some((tool: any) => tool.type === 'mcp_toolset' && tool.mcp_server_name === 'sentry')).toBe(true);
      expect(templates.data.every((item: any) => item.type === 'template')).toBe(true);

      const skillsRes = await app.request('/v1/skills');
      const skills = await skillsRes.json();
      expectCursorPage(skills);
      expect(skills.data.some((item: any) => item.id === 'pptx' && item.source === 'anthropic')).toBe(true);
      expect(skills.data.some((item: any) => item.id === 'skill_research' && item.source === 'custom')).toBe(true);
      expect(skills.data.every((item: any) => item.type === 'skill')).toBe(true);
    });

    it('seeds Settings V2 secrets with the workspace data directory when read through the API', async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'ma-settings-api-seed-'));
      const workspaceDataDir = join(workspaceRoot, '.managed-agents');
      mkdirSync(workspaceDataDir, { recursive: true });
      const workspaceDb = new Database(join(workspaceRoot, 'settings-api-seed.db'));
      try {
        workspaceDb.runMigrations();
        workspaceDb.prepare('INSERT INTO models (name, provider, model, api_key, is_default) VALUES (?, ?, ?, ?, 1)').run(
          'legacy',
          'openai',
          'gpt-4o',
          'legacy-secret-value',
        );
        const seedApp = createServer({
          db: workspaceDb,
          sessionManager: new SessionManager(workspaceDb),
          agents: [],
          consoleRoot: null,
          workspace: {
            root: workspaceRoot,
            dataDir: workspaceDataDir,
            agentsDir: join(workspaceRoot, 'agents'),
            skillsDir: join(workspaceRoot, 'skills'),
            target: 'local',
          },
          runtime: {
            models: [],
            sandboxProviders: ['local'],
            memory: 'disabled',
            authEnabled: false,
          },
          skills: [],
          reloadAgents: () => ({ agents: [], errors: [] }),
        });

        const response = await seedApp.request('/v1/x/settings');
        const body = await response.json() as any;

        expect(response.status).toBe(200);
        expect(body.secret_states.model.api_key).toBe('configured');
        expect(existsSync(join(workspaceDataDir, 'secrets.key'))).toBe(true);
        expect(JSON.stringify(body)).not.toContain('legacy-secret-value');
      } finally {
        workspaceDb.close();
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('reports saved model secret state without being confused by retained effective secrets', async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'ma-settings-api-secret-state-'));
      const workspaceDataDir = join(workspaceRoot, '.managed-agents');
      mkdirSync(workspaceDataDir, { recursive: true });
      const workspaceDb = new Database(join(workspaceRoot, 'settings-api-secret-state.db'));
      try {
        workspaceDb.runMigrations();
        workspaceDb.prepare('INSERT INTO models (name, provider, model, api_key, is_default) VALUES (?, ?, ?, ?, 1)').run(
          'legacy',
          'openai',
          'gpt-4o',
          'legacy-secret-value',
        );
        const seedApp = createServer({
          db: workspaceDb,
          sessionManager: new SessionManager(workspaceDb),
          agents: [],
          consoleRoot: null,
          workspace: {
            root: workspaceRoot,
            dataDir: workspaceDataDir,
            agentsDir: join(workspaceRoot, 'agents'),
            skillsDir: join(workspaceRoot, 'skills'),
            target: 'local',
          },
          runtime: {
            models: [],
            sandboxProviders: ['local'],
            memory: 'disabled',
            authEnabled: false,
          },
          skills: [],
          reloadAgents: () => ({ agents: [], errors: [] }),
        });
        await seedApp.request('/v1/x/settings');
        const row = workspaceDb.prepare('SELECT config FROM runtime_settings WHERE id = ?').get('default') as { config: string };
        const savedConfig = JSON.parse(row.config);
        savedConfig.model.api_key = '${SETTINGS_V2_MISSING_MODEL_KEY}';
        workspaceDb.prepare(`
          UPDATE runtime_settings
          SET config = ?, revision = 2, restart_required = 1
          WHERE id = 'default'
        `).run(JSON.stringify(savedConfig));

        const response = await seedApp.request('/v1/x/settings');
        const body = await response.json() as any;

        expect(response.status).toBe(200);
        expect(body.secret_states.model.api_key).toBe('missing_env');
        expect(workspaceDb.prepare('SELECT path FROM runtime_settings_secrets').all()).toEqual([{ path: 'model.api_key' }]);
      } finally {
        workspaceDb.close();
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('returns persisted Settings activation failures through the read API', async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'ma-settings-api-activation-failure-'));
      const workspaceDataDir = join(workspaceRoot, '.managed-agents');
      mkdirSync(workspaceDataDir, { recursive: true });
      const workspaceDb = new Database(join(workspaceRoot, 'settings-api-activation-failure.db'));
      try {
        workspaceDb.runMigrations();
        const failureApp = createServer({
          db: workspaceDb,
          sessionManager: new SessionManager(workspaceDb),
          agents: [],
          consoleRoot: null,
          workspace: {
            root: workspaceRoot,
            dataDir: workspaceDataDir,
            agentsDir: join(workspaceRoot, 'agents'),
            skillsDir: join(workspaceRoot, 'skills'),
            target: 'local',
          },
          runtime: {
            models: [],
            sandboxProviders: ['local'],
            memory: 'disabled',
            authEnabled: false,
          },
          skills: [],
          reloadAgents: () => ({ agents: [], errors: [] }),
        });
        const seeded = await failureApp.request('/v1/x/settings');
        const body = await seeded.json() as any;
        workspaceDb.prepare(`
          UPDATE runtime_settings
          SET config = ?, revision = 2, restart_required = 1
          WHERE id = 'default'
        `).run(JSON.stringify({
          ...body.saved_config,
          loop_engine: { provider: 'codex', options: { default_max_steps: 25 } },
        }));

        activateRuntimeSettings(workspaceDb, {}, workspaceDataDir);
        const failed = await failureApp.request('/v1/x/settings');
        const failedBody = await failed.json() as any;

        expect(failed.status).toBe(200);
        expect(failedBody).toMatchObject({
          revision: 2,
          effective_revision: 1,
          restart_required: true,
          activation_status: 'failed',
        });
        expect(failedBody.activation_errors).toContainEqual(expect.objectContaining({
          path: 'loop_engine.provider',
          code: 'adapter_unavailable',
        }));
        expect(failedBody.effective_config.loop_engine.provider).toBe('builtin');

        const repair = await failureApp.request('/v1/x/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            revision: failedBody.revision,
            config: {
              ...failedBody.effective_config,
              model: { ...failedBody.effective_config.model, api_key: 'repair-secret' },
              loop_engine: { provider: 'builtin', options: { default_max_steps: 88 } },
            },
          }),
        });
        const repairBody = await repair.json() as any;
        expect(repair.status).toBe(200);
        expect(repairBody).toMatchObject({
          revision: 3,
          effective_revision: 1,
          restart_required: true,
          activation_status: 'pending',
          activation_errors: [],
        });

        const pending = await failureApp.request('/v1/x/settings');
        const pendingBody = await pending.json() as any;
        expect(pendingBody.activation_status).toBe('pending');
        expect(pendingBody.activation_errors).toEqual([]);
        activateRuntimeSettings(workspaceDb, {}, workspaceDataDir);
        const active = await failureApp.request('/v1/x/settings');
        const activeBody = await active.json() as any;
        expect(activeBody).toMatchObject({
          revision: 3,
          effective_revision: 3,
          restart_required: false,
          activation_status: 'active',
          activation_errors: [],
        });
        expect(activeBody.effective_config.loop_engine.options.default_max_steps).toBe(88);
      } finally {
        workspaceDb.close();
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('does not expose legacy provider endpoints after Settings V2 cutover', async () => {
      for (const path of [
        '/v1/x/model-providers',
        '/v1/x/model-providers/local-llm/default',
        '/v1/x/memory-providers',
        '/v1/x/memory-providers/transient-context/default',
        '/v1/x/storage-providers',
        '/v1/x/storage-providers/fast-local-artifacts/initialize',
        '/v1/x/storage-providers/fast-local-artifacts/default',
      ]) {
        const res = await app.request(path);
        expect(res.status, path).toBe(404);
      }
    });

    it('exposes and validates the versioned Settings V2 document', async () => {
      const settings = await getJson('/v1/x/settings');
      expect(settings.res.status).toBe(200);
      expect(settings.body).toMatchObject({
        schema_version: 1,
        revision: 1,
        restart_required: false,
        effective_revision: 1,
        activation_status: 'active',
        secret_states: { model: { api_key: 'not_set' } },
        saved_config: {
          schema_version: 1,
          loop_engine: { provider: 'builtin' },
          storage: {
            metadata: { provider: 'sqlite' },
            artifacts: { provider: 'local' },
          },
          memory: { provider: 'sqlite' },
          sandbox: { provider: 'local' },
        },
      });
      expect(settings.body.diagnostics.metadata).toMatchObject({ health: 'ok' });
      expect(settings.body.adapters.loop_engine).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'builtin', status: 'available' }),
        expect.objectContaining({ id: 'codex', status: 'unavailable' }),
      ]));
      expect(settings.body.adapters.loop_engine.find((item: any) => item.id === 'builtin').options_schema.properties.default_max_steps).toMatchObject({
        type: 'integer',
        minimum: 1,
        maximum: 1000,
      });
      expect(settings.body.adapters.storage.artifacts.find((item: any) => item.id === 'local').options_schema.properties.base_path).toMatchObject({
        type: 'string',
        default: 'files',
      });
      expect(JSON.stringify(settings.body)).not.toContain('test-api-key');

      const valid = await postJson('/v1/x/settings/validate', {
        ...settings.body.saved_config,
        model: { ...settings.body.saved_config.model, api_key: 'validation-only-key' },
      });
      expect(valid.res.status).toBe(200);
      expect(valid.body).toMatchObject({ valid: true, errors: [] });
      expect(JSON.stringify(valid.body)).not.toContain('validation-only-key');

      const missingCredential = await postJson('/v1/x/settings/validate', settings.body.saved_config);
      expect(missingCredential.body).toMatchObject({ valid: false });
      expect(missingCredential.body.errors).toContainEqual(expect.objectContaining({ path: 'model.api_key', code: 'required' }));

      const missingModelTestCredential = await postJson('/v1/x/settings/test', {
        area: 'model',
        config: settings.body.saved_config.model,
      });
      expect(missingModelTestCredential.res.status).toBe(422);
      expect(missingModelTestCredential.body).toMatchObject({ ok: false, area: 'model', status: 'failed' });
      expect(missingModelTestCredential.body.errors).toContainEqual(expect.objectContaining({ path: 'model.api_key', code: 'required' }));

      const modelTest = await postJson('/v1/x/settings/test', {
        area: 'model',
        config: { ...settings.body.saved_config.model, vendor: 'openai', api_key: 'test-api-key' },
      });
      expect(modelTest.res.status).toBe(200);
      expect(modelTest.body).toMatchObject({ ok: true, area: 'model', status: 'ok' });
      expect(modelTest.body.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'api_key', status: 'ok' }),
      ]));
      expect(JSON.stringify(modelTest.body)).not.toContain('test-api-key');

      const artifactTest = await postJson('/v1/x/settings/test', {
        area: 'storage.artifacts',
        config: settings.body.saved_config.storage.artifacts,
      });
      expect(artifactTest.res.status).toBe(200);
      expect(artifactTest.body).toMatchObject({ ok: true, area: 'storage.artifacts', status: 'ok' });

      const invalidTestArea = await postJson('/v1/x/settings/test', {
        area: 'storage',
        config: settings.body.saved_config.storage,
      });
      expect(invalidTestArea.res.status).toBe(400);
      expect(invalidTestArea.body.error).toMatchObject({
        type: 'invalid_request_error',
      });

      const unavailable = await postJson('/v1/x/settings/validate', {
        ...settings.body.saved_config,
        loop_engine: {
          ...settings.body.saved_config.loop_engine,
          provider: 'codex',
        },
      });
      expect(unavailable.res.status).toBe(200);
      expect(unavailable.body.valid).toBe(false);
      expect(unavailable.body.errors).toContainEqual(expect.objectContaining({
        path: 'loop_engine.provider',
        code: 'adapter_unavailable',
      }));

      const missingCompatibleBaseUrl = await postJson('/v1/x/settings/validate', {
        ...settings.body.saved_config,
        model: { vendor: 'openai_compatible', api_key: 'validation-only-key', options: {} },
      });
      expect(missingCompatibleBaseUrl.body).toMatchObject({ valid: false });
      expect(missingCompatibleBaseUrl.body.errors).toContainEqual(expect.objectContaining({
        path: 'model.base_url',
        code: 'required',
      }));

      const missingOptionSecretEnv = await postJson('/v1/x/settings/validate', {
        ...settings.body.saved_config,
        model: { ...settings.body.saved_config.model, api_key: 'validation-only-key' },
        memory: {
          ...settings.body.saved_config.memory,
          enabled: true,
          options: { access_token: '${SETTINGS_V2_MISSING_MEMORY_KEY}' },
        },
      });
      expect(missingOptionSecretEnv.body).toMatchObject({ valid: false });
      expect(missingOptionSecretEnv.body.errors).toContainEqual(expect.objectContaining({
        path: 'memory.options.access_token',
        code: 'missing_env',
      }));

      const disabledMemorySecretEnv = await postJson('/v1/x/settings/validate', {
        ...settings.body.saved_config,
        model: { ...settings.body.saved_config.model, api_key: 'validation-only-key' },
        memory: {
          ...settings.body.saved_config.memory,
          enabled: false,
          provider: 'mem0',
          options: { api_key: '${SETTINGS_V2_MISSING_DISABLED_MEMORY_KEY}' },
        },
      });
      expect(disabledMemorySecretEnv.body).toMatchObject({ valid: true });

      const forgedManagedSecret = await postJson('/v1/x/settings/validate', {
        ...settings.body.saved_config,
        model: { ...settings.body.saved_config.model, api_key: '__managed_secret__:model.api_key' },
      });
      expect(forgedManagedSecret.body).toMatchObject({ valid: false });
      expect(forgedManagedSecret.body.errors).toContainEqual(expect.objectContaining({
        path: 'model.api_key',
        code: 'secret_not_configured',
      }));

      const updatedConfig = {
        ...settings.body.saved_config,
        model: {
          ...settings.body.saved_config.model,
          api_key: 'settings-secret-value',
        },
        loop_engine: {
          ...settings.body.saved_config.loop_engine,
          options: { default_max_steps: 42 },
        },
      };
      const saved = await postJson('/v1/x/settings', { revision: settings.body.revision, config: updatedConfig }, 'PUT');
      expect(saved.res.status).toBe(200);
      expect(saved.body).toMatchObject({ revision: 2, restart_required: true, secret_states: { model: { api_key: 'configured' } } });
      expect(saved.body.saved_config.loop_engine.options.default_max_steps).toBe(42);
      expect(saved.body.effective_config.loop_engine.options.default_max_steps).toBe(25);
      expect(JSON.stringify(saved.body)).not.toContain('settings-secret-value');
      const auditLogs = logStore.list({ query: 'runtime_settings_saved' });
      expect(auditLogs.at(-1)).toMatchObject({
        msg: 'runtime_settings_saved',
        old_revision: 1,
        new_revision: 2,
        restart_required: true,
      });
      expect(auditLogs.at(-1)?.changed_paths).toEqual(expect.arrayContaining([
        'loop_engine.options.default_max_steps',
        'model.api_key',
      ]));
      expect(auditLogs.at(-1)?.line).not.toContain('settings-secret-value');
      expect(auditLogs.at(-1)?.line).not.toContain('__managed_secret__');
      expect(auditLogs.at(-1)?.line).not.toContain('********');

      activateRuntimeSettings(db, {}, dataDir);
      const afterActivation = await getJson('/v1/x/settings');
      expect(afterActivation.res.status).toBe(200);
      expect(afterActivation.body.restart_required).toBe(false);
      expect(afterActivation.body.effective_config.loop_engine.options.default_max_steps).toBe(42);

      const preservedMaskedSecret = await postJson('/v1/x/settings', {
        revision: afterActivation.body.revision,
        config: {
          ...afterActivation.body.saved_config,
          loop_engine: {
            ...afterActivation.body.saved_config.loop_engine,
            options: { default_max_steps: 43 },
          },
        },
      }, 'PUT');
      expect(preservedMaskedSecret.res.status).toBe(200);
      expect(preservedMaskedSecret.body).toMatchObject({
        revision: 3,
        secret_states: { model: { api_key: 'configured' } },
      });
      expect(preservedMaskedSecret.body.saved_config.model.api_key).toBe('********');
      expect(JSON.stringify(preservedMaskedSecret.body)).not.toContain('settings-secret-value');
      activateRuntimeSettings(db, {}, dataDir);
      const afterMaskedPreserve = await getJson('/v1/x/settings');
      expect(afterMaskedPreserve.body.restart_required).toBe(false);

      const stale = await postJson('/v1/x/settings', { revision: 1, config: updatedConfig }, 'PUT');
      expect(stale.res.status).toBe(409);

      const invalidRevision = await postJson('/v1/x/settings', { revision: 0, config: updatedConfig }, 'PUT');
      expect(invalidRevision.res.status).toBe(400);
      expect(invalidRevision.body.error).toMatchObject({
        type: 'invalid_request_error',
        message: 'revision must be a positive integer',
      });

      const rotatedSecret = await postJson('/v1/x/settings', {
        revision: afterMaskedPreserve.body.revision,
        config: {
          ...afterMaskedPreserve.body.saved_config,
          model: {
            ...afterMaskedPreserve.body.saved_config.model,
            api_key: 'rotated-settings-secret-value',
            options: {
              access_key: 'rotated-settings-option-secret',
            },
          },
        },
      }, 'PUT');
      expect(rotatedSecret.res.status).toBe(200);
      const rotatedAudit = logStore.list({ query: 'runtime_settings_saved' }).at(-1);
      expect(rotatedAudit?.changed_paths).toContain('model.api_key');
      expect(rotatedAudit?.changed_paths).toContain('model.options.access_key');
      expect(rotatedAudit?.line).not.toContain('rotated-settings-secret-value');
      expect(rotatedAudit?.line).not.toContain('rotated-settings-option-secret');
    });

    it('uses runtime-registered non-local sandbox availability for settings APIs', async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'ma-settings-api-sandbox-registry-'));
      const workspaceDataDir = join(workspaceRoot, '.managed-agents');
      mkdirSync(workspaceDataDir, { recursive: true });
      const workspaceDb = new Database(join(workspaceRoot, 'sandbox-registry.db'));
      try {
        workspaceDb.runMigrations();
        const sandboxApp = createServer({
          db: workspaceDb,
          sessionManager: new SessionManager(workspaceDb),
          agents: [],
          consoleRoot: null,
          workspace: {
            root: workspaceRoot,
            dataDir: workspaceDataDir,
            agentsDir: join(workspaceRoot, 'agents'),
            skillsDir: join(workspaceRoot, 'skills'),
            target: 'local',
          },
          runtime: {
            models: [],
            sandboxProviders: ['local', 'docker', 'self_hosted'],
            memory: 'disabled',
            authEnabled: false,
          },
          skills: [],
          reloadAgents: () => ({ agents: [], errors: [] }),
        });

        const settingsResponse = await sandboxApp.request('/v1/x/settings');
        const settings = await settingsResponse.json() as any;
        expect(settingsResponse.status).toBe(200);
        expect(settings.adapters.sandbox).toContainEqual(expect.objectContaining({
          id: 'docker',
          status: 'available',
        }));
        expect(settings.adapters.sandbox).toContainEqual(expect.objectContaining({
          id: 'remote',
          status: 'available',
        }));

        const dockerConfig = {
          ...settings.saved_config,
          model: { ...settings.saved_config.model, api_key: 'registry-test-key' },
          sandbox: { provider: 'docker' as const, options: { timeout_seconds: 300 } },
        };
        const validationResponse = await sandboxApp.request('/v1/x/settings/validate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(dockerConfig),
        });
        const validation = await validationResponse.json() as any;
        expect(validationResponse.status).toBe(200);
        expect(validation).toMatchObject({ valid: true });

        const testResponse = await sandboxApp.request('/v1/x/settings/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            area: 'sandbox',
            config: dockerConfig.sandbox,
            full_config: dockerConfig,
          }),
        });
        const testResult = await testResponse.json() as any;
        expect(testResponse.status).toBe(200);
        expect(testResult).toMatchObject({
          ok: true,
          area: 'sandbox',
          status: 'skipped',
        });
        expect(testResult.checks).toContainEqual(expect.objectContaining({
          name: 'sandbox_live_health',
          status: 'skipped',
        }));

        const remoteMissingCredential = {
          ...settings.saved_config,
          sandbox: {
            provider: 'remote' as const,
            options: {
              timeout_seconds: 300,
              api_key: '${SETTINGS_V2_MISSING_REMOTE_SANDBOX_KEY}',
            },
          },
        };
        const remoteTestResponse = await sandboxApp.request('/v1/x/settings/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            area: 'sandbox',
            config: remoteMissingCredential.sandbox,
            full_config: remoteMissingCredential,
          }),
        });
        const remoteTest = await remoteTestResponse.json() as any;
        expect(remoteTestResponse.status).toBe(422);
        expect(remoteTest.errors).toContainEqual(expect.objectContaining({
          path: 'sandbox.options.api_key',
          code: 'missing_env',
        }));
        expect(remoteTest.errors).not.toContainEqual(expect.objectContaining({
          path: 'model.api_key',
        }));
      } finally {
        workspaceDb.close();
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('exposes recent runtime logs through the extension API', async () => {
      const { res, body } = await getJson('/v1/x/logs?limit=10&q=test_runtime_ready');
      expect(res.status).toBe(200);
      expectPage(body);
      expect(body.data.some((entry: any) => entry.msg === 'test_runtime_ready')).toBe(true);
      expect(body.data[0]).toHaveProperty('line');

      const warnOnly = await getJson('/v1/x/logs?level=warn&limit=10');
      expect(warnOnly.res.status).toBe(200);
      expect(warnOnly.body.data.every((entry: any) => ['warn', 'error'].includes(entry.level))).toBe(true);
    });

    it('schedules runtime restart through the extension API', async () => {
      restartRequested = false;
      const { res, body } = await postJson('/v1/x/restart', {});
      expect(res.status).toBe(202);
      expect(body).toMatchObject({ restarting: true, status: 'scheduled' });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(restartRequested).toBe(true);
      expect(logStore.list({ query: 'test_restart_called' })).toHaveLength(1);
    });

    it('creates, retrieves, lists, and deletes skills through /v1/skills', async () => {
      const skillContent = `---
name: contract-skill
description: Exercises the standard skill API.
compatibility: Requires network access and Python 3.9+
---

# Contract Skill

Use this in API tests.
`;
      const create = await postJson('/v1/skills', {
        display_title: 'Contract Skill',
        files: [
          { path: 'contract-skill/SKILL.md', content: skillContent },
          { path: 'contract-skill/resources/example.txt', content: 'resource' },
        ],
      });

      expect(create.res.status).toBe(201);
      expect(create.body.id).toMatch(/^skill_[A-Za-z0-9_-]+$/);
      expect(create.body.id).not.toBe('skill_contract-skill');
      expect(create.body.type).toBe('skill');
      expect(create.body.source).toBe('custom');
      expect(create.body.display_title).toBe('Contract Skill');
      expect(create.body.compatibility).toBe('Requires network access and Python 3.9+');
      expect(create.body.latest_version).toBeTruthy();

      const skillId = create.body.id;
      const storedSkill = db.prepare('SELECT instructions, storage_path FROM skills WHERE id = ?').get(skillId) as
        | { instructions: string; storage_path: string | null }
        | undefined;
      expect(storedSkill).toBeDefined();
      expect(storedSkill!.instructions).toContain('Use this in API tests.');
      expect(storedSkill!.storage_path).toBe(join(dataDir, 'skills', skillId));
      expect(existsSync(storedSkill!.storage_path!)).toBe(true);
      expect(existsSync(join(storedSkill!.storage_path!, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(storedSkill!.storage_path!, 'resources', 'example.txt'))).toBe(true);
      expect(existsSync(join(skillsDir, 'contract-skill'))).toBe(false);

      const get = await getJson(`/v1/skills/${skillId}`);
      expect(get.res.status).toBe(200);
      expect(get.body.id).toBe(skillId);
      expect(get.body.name).toBe('contract-skill');
      expect(get.body.description).toBe('Exercises the standard skill API.');
      expect(get.body.compatibility).toBe('Requires network access and Python 3.9+');

      const customList = await getJson('/v1/skills?source=custom');
      expect(customList.body.data.some((item: any) => item.id === skillId)).toBe(true);
      expect(customList.body.data.every((item: any) => item.source === 'custom')).toBe(true);

      const del = await app.request(`/v1/skills/${skillId}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      expect(await del.json()).toEqual({ id: skillId, type: 'skill_deleted' });
      expect(existsSync(storedSkill!.storage_path!)).toBe(false);
      const archived = db.prepare('SELECT archived_at FROM skills WHERE id = ?').get(skillId) as
        | { archived_at: string | null }
        | undefined;
      expect(archived?.archived_at).toBeTruthy();

      const missing = await app.request(`/v1/skills/${skillId}`);
      expect(missing.status).toBe(404);
    });

    it('extracts zip skill packages before validating SKILL.md', async () => {
      const zip = makeStoredZip([
        {
          path: 'zip-skill/SKILL.md',
          content: `---
name: zip-skill
description: Uploaded from a compressed package.
---

# Zip Skill
`,
        },
        { path: 'zip-skill/resources/example.txt', content: 'resource' },
        { path: 'zip-skill/.DS_Store', content: 'ignored' },
        { path: '__MACOSX/zip-skill/._SKILL.md', content: 'ignored' },
      ]);

      const create = await postJson('/v1/skills', {
        files: [{ filename: 'zip-skill.zip', base64: zip.toString('base64') }],
      });

      expect(create.res.status).toBe(201);
      expect(create.body.id).toMatch(/^skill_[A-Za-z0-9_-]+$/);
      expect(create.body.id).not.toBe('skill_zip-skill');
      expect(create.body.name).toBe('zip-skill');
      expect(create.body.display_title).toBe('zip-skill');

      const get = await getJson(`/v1/skills/${create.body.id}`);
      expect(get.res.status).toBe(200);
      expect(get.body.description).toBe('Uploaded from a compressed package.');

      const del = await app.request(`/v1/skills/${create.body.id}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
    });

    it('rejects zip skill packages whose declared unpacked size exceeds the limit', async () => {
      const zip = makeStoredZip([
        { path: 'huge-skill/SKILL.md', content: '', declaredSize: 8 * 1024 * 1024 + 1 },
      ]);

      const create = await postJson('/v1/skills', {
        files: [{ filename: 'huge-skill.zip', base64: zip.toString('base64') }],
      });

      expect(create.res.status).toBe(400);
      expect(create.body.error.message).toContain('8MB');
    });

    it('rejects invalid skill uploads with standard validation messages', async () => {
      const flat = await postJson('/v1/skills', {
        files: [{ path: 'SKILL.md', content: '---\nname: flat\ndescription: invalid\n---\nBody' }],
      });
      expect(flat.res.status).toBe(400);
      expect(flat.body.error.message).toContain('top-level directory');

      const missingFrontmatter = await postJson('/v1/skills', {
        files: [{ path: 'bad-skill/SKILL.md', content: '# No frontmatter' }],
      });
      expect(missingFrontmatter.res.status).toBe(400);
      expect(missingFrontmatter.body.error.message).toContain('YAML frontmatter');
    });

    it('creates and exposes file resources without leaking internal paths', async () => {
      const create = await postJson('/v1/files', {
        name: 'notes.md',
        media_type: 'text/markdown',
        content: '# Notes\n\nSession mountable file.',
      });
      expect(create.res.status).toBe(201);
      expect(create.body.id).toMatch(/^file_/);
      expect(create.body.type).toBe('file');
      expect(create.body.name).toBe('notes.md');
      expect(create.body.media_type).toBe('text/markdown');
      expect(create.body.size_bytes).toBeGreaterThan(0);
      expect(create.body.preview).toContain('Session mountable file');
      expect(create.body.storage_path).toBeUndefined();

      const { res, body } = await getJson('/v1/files');
      expect(res.status).toBe(200);
      expectCursorPage(body);
      const listed = body.data.find((file: any) => file.id === create.body.id);
      expect(listed).toBeDefined();
      expect(JSON.stringify(body)).not.toContain('.managed-agents');
      expect(JSON.stringify(body)).not.toContain('secrets.key');

      const content = await app.request(`/v1/files/${create.body.id}/content`);
      expect(content.status).toBe(200);
      expect(content.headers.get('content-type')).toContain('text/markdown');
      expect(await content.text()).toContain('# Notes');

      const archive = await app.request(`/v1/files/${create.body.id}`, { method: 'DELETE' });
      expect(archive.status).toBe(200);
      expect((await archive.json() as any).status).toBe('archived');

      const afterArchive = await getJson('/v1/files');
      expect(afterArchive.body.data.some((file: any) => file.id === create.body.id)).toBe(false);
    });

    it('always generates file ids and keeps storage inside the managed files directory', async () => {
      const create = await postJson('/v1/files', {
        id: 'file_/../../escape.txt',
        name: 'escape.txt',
        content: 'should stay managed',
      });

      expect(create.res.status).toBe(201);
      expect(create.body.id).toMatch(/^file_/);
      expect(create.body.id).not.toBe('file_/../../escape.txt');
      expect(existsSync(join(dataDir, 'escape.txt'))).toBe(false);
    });

    it('stores file resources under the effective Settings V2 artifact base path', async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'ma-settings-api-artifact-path-'));
      const workspaceDataDir = join(workspaceRoot, '.managed-agents');
      mkdirSync(workspaceDataDir, { recursive: true });
      const workspaceDb = new Database(join(workspaceRoot, 'artifact-path.db'));
      try {
        workspaceDb.runMigrations();
        const initial = getOrSeedRuntimeSettings(workspaceDb, {}, workspaceDataDir);
        const changed = {
          ...initial.saved_config,
          model: { ...initial.saved_config.model, api_key: 'model-secret' },
          storage: {
            ...initial.saved_config.storage,
            artifacts: { provider: 'local' as const, options: { base_path: 'artifacts-v2' } },
          },
        };
        const saved = saveRuntimeSettings(workspaceDb, changed, initial.revision, workspaceDataDir);
        expect(saved.ok).toBe(true);
        const modelRegistry = new ModelRegistry();
        const runtimeComposition = composeRuntimeFromSettings({
          db: workspaceDb,
          dataDir: workspaceDataDir,
          modelRegistry,
          settingsSeed: { memoryEnabled: false },
          sandboxProviders: ['local'],
        });
        const artifactApp = createServer({
          db: workspaceDb,
          sessionManager: new SessionManager(workspaceDb),
          agents: [],
          consoleRoot: null,
          workspace: {
            root: workspaceRoot,
            dataDir: workspaceDataDir,
            agentsDir: join(workspaceRoot, 'agents'),
            skillsDir: join(workspaceRoot, 'skills'),
            target: 'local',
          },
          runtime: {
            models: modelRegistry.listRuntimeInfo(),
            sandboxProviders: ['local'],
            memory: 'disabled',
            authEnabled: false,
          },
          artifactStore: () => runtimeComposition.artifactStore,
          skills: [],
          reloadAgents: () => ({ agents: [], errors: [] }),
        });

        const response = await artifactApp.request('/v1/files', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'configured.txt', content: 'configured artifact path' }),
        });
        const body = await response.json() as any;
        const row = workspaceDb.prepare('SELECT storage_path FROM files WHERE id = ?').get(body.id) as { storage_path: string };

        expect(response.status).toBe(201);
        expect(row.storage_path.startsWith(join(workspaceDataDir, 'artifacts-v2'))).toBe(true);
        expect(existsSync(row.storage_path)).toBe(true);
        expect(existsSync(join(workspaceDataDir, 'files', body.id))).toBe(false);

        const content = await artifactApp.request(`/v1/files/${body.id}/content`);
        expect(content.status).toBe(200);
        expect(await content.text()).toBe('configured artifact path');

        const archived = await artifactApp.request(`/v1/files/${body.id}`, { method: 'DELETE' });
        expect(archived.status).toBe(200);
        const archivedBody = await archived.json() as any;
        expect(archivedBody.status).toBe('archived');
        const missingContent = await artifactApp.request(`/v1/files/${body.id}/content`);
        expect(missingContent.status).toBe(404);
      } finally {
        workspaceDb.close();
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('uploads file resources with multipart form data', async () => {
      const form = new FormData();
      form.append(
        'file',
        new Blob(['uploaded through the console'], { type: 'text/plain' }),
        'sandbase-upload-test.txt',
      );

      const res = await app.request('/v1/files', {
        method: 'POST',
        body: form,
      });
      const body = await res.json() as any;

      expect(res.status).toBe(201);
      expect(body.id).toMatch(/^file_/);
      expect(body.name).toBe('sandbase-upload-test.txt');
      expect(body.media_type).toBe('text/plain');
      expect(body.size_bytes).toBe(28);
      expect(body.preview).toContain('uploaded through the console');

      const content = await app.request(`/v1/files/${body.id}/content`);
      expect(content.status).toBe(200);
      expect(content.headers.get('content-disposition')).toContain('sandbase-upload-test.txt');
      expect(await content.text()).toBe('uploaded through the console');
    });
  });

  describe('PUT /v1/environments/:id', () => {
    it('creates, gets, and archives environment resources', async () => {
      const { res, body } = await postJson('/v1/environments', {
        name: 'Contract runner',
        description: 'Configuration template for sessions and code execution.',
        config: {
          hosting_type: 'self_hosted',
          sandbox_provider: 'self_hosted',
          network: {
            type: 'limited',
            allow_mcp_server_network_access: false,
            allow_package_manager_network_access: false,
            allowed_hosts: ['api.example.com'],
          },
          packages: [{ manager: 'pip', package: 'pytest==8.3.4' }],
        },
        metadata: { tier: 'qa' },
      });

      expect(res.status).toBe(201);
      expect(body.id).toMatch(/^env_/);
      expect(body.type).toBe('environment');
      expect(body.archived_at).toBeNull();
      expect(body.config.type).toBe('self_hosted');
      expect(body.effective_sandbox_provider).toBe('self_hosted');
      expect(body.config.network.allowed_hosts).toEqual(['api.example.com']);
      expect(body.config.networking.allowed_hosts).toEqual(['api.example.com']);
      expect(body.config.packages.pip).toEqual(['pytest==8.3.4']);
      expect(body.packages_enforced).toBe(false);
      expect(body.networking_enforced).toBe(false);

      const getRes = await app.request(`/v1/environments/${body.id}`);
      expect(getRes.status).toBe(200);
      expect((await getRes.json()).metadata.tier).toBe('qa');

      const archiveRes = await app.request(`/v1/environments/${body.id}/archive`, { method: 'POST' });
      expect(archiveRes.status).toBe(200);
      expect((await archiveRes.json()).archived_at).not.toBeNull();

      const getArchived = await app.request(`/v1/environments/${body.id}`);
      expect(getArchived.status).toBe(404);
    });

    it('ignores client-supplied environment ids', async () => {
      const first = await postJson('/v1/environments', { id: 'env_duplicate_contract', name: 'Duplicate contract' });
      const second = await postJson('/v1/environments', { id: 'env_duplicate_contract', name: 'Duplicate contract' });

      expect(first.res.status).toBe(201);
      expect(second.res.status).toBe(201);
      expect(first.body.id).toMatch(/^env_/);
      expect(second.body.id).toMatch(/^env_/);
      expect(first.body.id).not.toBe('env_duplicate_contract');
      expect(second.body.id).not.toBe('env_duplicate_contract');
      expect(first.body.id).not.toBe(second.body.id);
    });

    it('generates environment ids and allows duplicate display names', async () => {
      const first = await postJson('/v1/environments', { name: 'Reusable environment' });
      const second = await postJson('/v1/environments', { name: 'Reusable environment' });

      expect(first.res.status).toBe(201);
      expect(second.res.status).toBe(201);
      expect(first.body.id).toMatch(/^env_/);
      expect(second.body.id).toMatch(/^env_/);
      expect(first.body.id).not.toBe(second.body.id);
      expect(first.body.name).toBe('Reusable environment');
      expect(second.body.name).toBe('Reusable environment');
    });

    it('preserves local hosting for desktop runtimes', async () => {
      const { res, body } = await postJson('/v1/environments', {
        name: 'Local desktop',
        description: 'Runs sessions on the local machine.',
        config: {
          hosting_type: 'local',
          sandbox_provider: 'local',
        },
      });

      expect(res.status).toBe(201);
      expect(body.config.hosting_type).toBe('local');
      expect(body.config.sandbox_provider).toBe('local');
      // `local` projects to `cloud` on the published axis: it is a backend the
      // platform (this workspace) serves, and the effective field names it.
      expect(body.config.type).toBe('cloud');
      expect(body.effective_sandbox_provider).toBe('local');
    });

    it('reports a backend-declared environment with the backend it resolves to', async () => {
      const { res, body } = await postJson('/v1/environments', {
        name: 'Kubernetes runner',
        config: {
          sandbox_provider: 'kubernetes',
          kubernetes: { namespace: 'agents' },
        },
      });

      expect(res.status).toBe(201);
      // A runtime-served backend projects to `cloud` on the published axis —
      // the platform decides where it runs — and the effective field names the
      // backend sessions actually provision.
      expect(body.config.type).toBe('cloud');
      expect(body.effective_sandbox_provider).toBe('kubernetes');

      const updated = await app.request(`/v1/environments/${body.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Kubernetes runner',
          description: 'Container template for console sessions.',
          config: {
            hosting_type: 'kubernetes',
            sandbox_provider: 'kubernetes',
            network: {
              type: 'limited',
              allow_mcp_server_network_access: false,
              allow_package_manager_network_access: true,
              allowed_hosts: ['api.github.com'],
            },
            packages: [{ manager: 'pip', package: 'ruff==0.5.0' }],
          },
          metadata: { owner: 'platform' },
        }),
      });

      expect(updated.status).toBe(200);
      const updatedBody = await updated.json();
      expect(updatedBody.name).toBe('Kubernetes runner');
      expect(updatedBody.description).toBe('Container template for console sessions.');
      expect(updatedBody.config.type).toBe('cloud');
      expect(updatedBody.effective_sandbox_provider).toBe('kubernetes');
      expect(updatedBody.config.network.allowed_hosts).toEqual(['api.github.com']);
      expect(updatedBody.config.networking.allowed_hosts).toEqual(['api.github.com']);
      expect(updatedBody.config.packages.pip).toEqual(['ruff==0.5.0']);
      expect(updatedBody.config.hosting_type).toBe('kubernetes');
      expect(updatedBody.metadata.owner).toBe('platform');
    });

    it('accepts cloud hosting as the workspace-default declaration, and refuses what cannot name a backend', async () => {
      // `cloud` is the official "the platform decides" value: this runtime has
      // no managed cloud service, so the workspace's configured default backend
      // serves it — the same one `env_default` runs on.
      const cloudOnly = await postJson('/v1/environments', {
        name: 'Cloud only',
        config: { type: 'cloud', networking: { type: 'unrestricted' } },
      });
      expect(cloudOnly.res.status).toBe(201);
      expect(cloudOnly.body.config.type).toBe('cloud');
      expect(cloudOnly.body.config.networking).toEqual({ type: 'unrestricted' });
      expect(cloudOnly.body.effective_sandbox_provider).toBe('local');

      // A declared backend still wins over the hosting declaration, so an
      // explicit provider keeps deciding where sessions provision.
      const cloudWithBackend = await postJson('/v1/environments', {
        name: 'Cloud with backend',
        hosting_type: 'cloud',
        sandbox_provider: 'docker',
      });
      expect(cloudWithBackend.res.status).toBe(201);
      expect(cloudWithBackend.body.effective_sandbox_provider).toBe('docker');

      const unknownHosting = await postJson('/v1/environments', {
        name: 'Unknown hosting',
        config: { hosting_type: 'team_server' },
      });
      expect(unknownHosting.res.status).toBe(400);
      expect(unknownHosting.body.error.message).toContain('not a known hosting type');

      // A malformed declaration is refused rather than dropped: dropping it
      // would create an Environment that resolves to the local backend while
      // the caller believed it had asked for something else.
      const malformedHosting = await postJson('/v1/environments', {
        name: 'Malformed hosting',
        config: { hosting_type: 7 },
      });
      expect(malformedHosting.res.status).toBe(400);
      expect(malformedHosting.body.error.message).toContain('hosting_type must be a string');

      const malformedConfig = await postJson('/v1/environments', {
        name: 'Malformed config',
        config: 'hosting_type=cloud',
      });
      expect(malformedConfig.res.status).toBe(400);
      expect(malformedConfig.body.error.message).toContain('config must be an object');
    });

    it('keeps a stored cloud declaration on update, and lets a write change it', async () => {
      // Rows written before `cloud` resolved still declare it; a rename keeps
      // the declaration, and a write that names another hosting type supersedes
      // it — a deliberate change, not a rename that quietly becomes local.
      db.prepare(
        `INSERT INTO environments (id, name, config) VALUES ('env_legacy_cloud', 'legacy cloud', '{"hosting_type":"cloud"}')`,
      ).run();
      try {
        const renamed = await app.request('/v1/environments/env_legacy_cloud', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'renamed' }),
        });
        expect(renamed.status).toBe(200);
        const renamedBody = await renamed.json();
        expect(renamedBody.config.type).toBe('cloud');
        expect(renamedBody.config.hosting_type).toBe('cloud');
        expect(renamedBody.effective_sandbox_provider).toBe('local');

        const repaired = await app.request('/v1/environments/env_legacy_cloud', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'repaired', config: { hosting_type: 'local', sandbox_provider: 'local' } }),
        });
        expect(repaired.status).toBe(200);
        expect((await repaired.json()).config.hosting_type).toBe('local');
      } finally {
        db.prepare(`DELETE FROM environments WHERE id = 'env_legacy_cloud'`).run();
      }
    });

    it('refuses to merge over a config that is not valid JSON', async () => {
      db.prepare(
        `INSERT INTO environments (id, name, config) VALUES ('env_damaged', 'damaged', '{oops')`,
      ).run();
      try {
        // Reading it reports the damage rather than the backend an empty config
        // would resolve to, so the Console cannot show `local` for a row whose
        // backend is unknown and then save it back as a local Environment.
        const read = await app.request('/v1/environments/env_damaged');
        expect(read.status).toBe(200);
        const damaged = await read.json();
        // The damage is reported as "no backend a session could use" rather
        // than as the backend an empty config would resolve to.
        expect(damaged.effective_sandbox_provider).toBeNull();

        const renamed = await app.request('/v1/environments/env_damaged', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'renamed' }),
        });
        expect(renamed.status).toBe(400);
        expect((await renamed.json()).error.code).toBe('invalid_environment_config');

        // Saving the projection back is refused too, and the message names the
        // hosting type rather than a backend the operator never chose.
        const savedBack = await app.request('/v1/environments/env_damaged', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'renamed', config: { hosting_type: 'unknown', sandbox_provider: 'cloud' } }),
        });
        expect(savedBack.status).toBe(400);
        expect((await savedBack.json()).error.message).toContain('hosting_type "unknown"');

        const repaired = await app.request('/v1/environments/env_damaged', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'repaired', config: { hosting_type: 'local', sandbox_provider: 'local' } }),
        });
        expect(repaired.status).toBe(200);
        expect((await repaired.json()).config.hosting_type).toBe('local');
      } finally {
        db.prepare(`DELETE FROM environments WHERE id = 'env_damaged'`).run();
      }
    });

    it('accepts standard top-level environment fields', async () => {
      const { res, body } = await postJson('/v1/environments', {
        name: 'Standard top level',
        description: 'Uses the same shape as the Console create form.',
        hosting_type: 'docker',
        sandbox_provider: 'docker',
        network: {
          type: 'limited',
          allow_mcp_server_network_access: false,
          allow_package_manager_network_access: true,
          allowed_hosts: ['docs.anthropic.com'],
        },
        packages: [{ manager: 'npm', package: 'tsx@latest' }],
      });

      expect(res.status).toBe(201);
      expect(body.config.hosting_type).toBe('docker');
      expect(body.config.sandbox_provider).toBe('docker');
      expect(body.config.type).toBe('cloud');
      expect(body.effective_sandbox_provider).toBe('docker');
      expect(body.config.network.allowed_hosts).toEqual(['docs.anthropic.com']);
      expect(body.config.packages.npm).toEqual(['tsx@latest']);
    });

    it('rejects a sandbox_provider that is not a known backend', async () => {
      // Normalization preserves whatever name was written so provisioning can
      // fail loudly rather than substituting a weaker backend. That makes the
      // write path the only place a typo can still be caught early.
      const typo = await postJson('/v1/environments', {
        name: 'Typo backend',
        config: { sandbox_provider: 'dokcer' },
      });
      expect(typo.res.status).toBe(400);
      expect(typo.body.error.message).toContain('not a known sandbox backend');
      expect(typo.body.error.message).toContain('docker');

      const hostingValue = await postJson('/v1/environments', {
        name: 'Hosting value as backend',
        config: { sandbox_provider: 'cloud' },
      });
      expect(hostingValue.res.status).toBe(400);

      const update = await app.request('/v1/environments/env_default', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { sandbox_provider: 'nope' } }),
      });
      expect(update.status).toBe(400);
    });

    it('accepts a known backend whose transport is unavailable in this runtime', async () => {
      // This runtime registers only `local`. Authoring an Environment for a
      // backend that is not currently reachable stays allowed — that is a
      // deployment condition, not a malformed request — and provisioning is
      // where the unavailability is reported.
      const { res, body } = await postJson('/v1/environments', {
        name: 'Kubernetes elsewhere',
        config: { sandbox_provider: 'kubernetes' },
      });

      expect(res.status).toBe(201);
      expect(body.effective_sandbox_provider).toBe('kubernetes');
    });

    it('returns 404 for non-existent environments', async () => {
      const res = await app.request('/v1/environments/env_nope', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Missing' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('Credential vaults', () => {
    it('supports detail, all standard credential auth types, active filtering, and vault archive', async () => {
      const { res: vaultRes, body: vault } = await postJson('/v1/credential-vaults', {
        name: 'Contract vault',
        description: 'Shared credentials for contract tests.',
        metadata: { owner: 'qa' },
      });
      expect(vaultRes.status).toBe(201);
      expect(vault.type).toBe('credential_vault');

      const credentialInputs = [
        {
          name: 'OAuth MCP',
          auth_type: 'mcp_oauth',
          mcp_server_url: 'https://mcp.example.com/mcp',
          injection_locations: ['request_headers'],
        },
        {
          name: 'Bearer MCP',
          auth_type: 'bearer_token',
          // A static_bearer is keyed by its server URL in the canonical profile,
          // so the flat alias needs it too; the assertions below are unchanged.
          mcp_server_url: 'https://mcp.example.com/mcp',
          value: 'secret-bearer-token',
          network: { type: 'unrestricted', allowed_hosts: ['api.example.com'] },
          injection_locations: ['request_headers', 'request_headers', 'request_body'],
        },
        {
          name: 'Env credential',
          auth_type: 'environment_variable',
          variable_name: 'MY_API_KEY',
          value: 'secret-env-token',
        },
      ];

      const createdCredentials = [];
      for (const input of credentialInputs) {
        const { res, body } = await postJson(`/v1/credential-vaults/${vault.id}/credentials`, input);
        expect(res.status).toBe(201);
        expect(body.type).toBe('credential');
        expect(body.value).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain('secret-');
        createdCredentials.push(body);
      }

      const bearer = createdCredentials.find((item: any) => item.auth_type === 'bearer_token');
      expect(bearer.network.type).toBe('unrestricted');
      expect(bearer.injection_locations).toEqual(['request_headers', 'request_body']);

      const detailRes = await app.request(`/v1/credential-vaults/${vault.id}`);
      expect(detailRes.status).toBe(200);
      const detail = await detailRes.json();
      expect(detail.credential_count).toBe(3);
      expect(detail.credentials).toHaveLength(3);

      const archiveRes = await app.request(`/v1/credential-vaults/${vault.id}/credentials/${createdCredentials[0].id}/archive`, { method: 'POST' });
      expect(archiveRes.status).toBe(200);
      const deleteRes = await app.request(`/v1/credential-vaults/${vault.id}/credentials/${createdCredentials[1].id}`, { method: 'DELETE' });
      expect(deleteRes.status).toBe(200);

      const activeRes = await app.request(`/v1/credential-vaults/${vault.id}/credentials`);
      const active = await activeRes.json();
      expectCursorPage(active);
      expect(active.data.map((item: any) => item.id)).toEqual([createdCredentials[2].id]);

      const archiveVaultRes = await app.request(`/v1/credential-vaults/${vault.id}/archive`, { method: 'POST' });
      expect(archiveVaultRes.status).toBe(200);
      expect((await archiveVaultRes.json()).status).toBe('archived');

      const archivedDetailRes = await app.request(`/v1/credential-vaults/${vault.id}`);
      expect(archivedDetailRes.status).toBe(404);
      const archivedCredentialCreate = await postJson(`/v1/credential-vaults/${vault.id}/credentials`, {
        auth_type: 'mcp_oauth',
        mcp_server_url: 'https://mcp.example.com',
      });
      expect(archivedCredentialCreate.res.status).toBe(404);
    });

    it('creates a vault and stores credential metadata without returning the secret value', async () => {
      const vaultRes = await app.request('/v1/credential-vaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Production vault' }),
      });
      expect(vaultRes.status).toBe(201);
      const vault = await vaultRes.json();
      expect(vault.id).toMatch(/^vlt_/);
      expect(vault.credential_count).toBe(0);
      expect(vault.credentials).toEqual([]);

      const credentialRes = await app.request(`/v1/credential-vaults/${vault.id}/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'API token',
          id: 'vcrd_client_supplied',
          auth_type: 'environment_variable',
          variable_name: 'MY_API_KEY',
          value: 'sk-test-secret-value',
          network: { type: 'limited', allowed_hosts: ['api.example.com'] },
          injection_locations: ['request_headers'],
        }),
      });
      expect(credentialRes.status).toBe(201);
      const credential = await credentialRes.json();
      expect(credential.id).toMatch(/^vcrd_/);
      expect(credential.id).not.toBe('vcrd_client_supplied');
      expect(credential.variable_name).toBe('MY_API_KEY');
      expect(credential.value).toBeUndefined();
      expect(credential.value_hint).toBe('••••alue');
      expect(credential.network.allowed_hosts).toEqual(['api.example.com']);
      expect(credential.injection_locations).toEqual(['request_headers']);
      expect(JSON.stringify(credential)).not.toContain('sk-test-secret-value');

      const storedCredential = db.prepare(
        'SELECT secret_ciphertext, secret_nonce, secret_tag FROM credential_records WHERE id = ?',
      ).get(credential.id) as { secret_ciphertext: string; secret_nonce: string; secret_tag: string };
      expect(storedCredential.secret_ciphertext).toBeTruthy();
      expect(storedCredential.secret_nonce).toBeTruthy();
      expect(storedCredential.secret_tag).toBeTruthy();
      expect(storedCredential.secret_ciphertext).not.toContain('sk-test-secret-value');

      const listRes = await app.request('/v1/credential-vaults');
      const list = await listRes.json();
      const listedVault = list.data.find((item: any) => item.id === vault.id);
      expect(listedVault.credential_count).toBe(1);
      expect(listedVault.credentials[0].value).toBeUndefined();
      expect(listedVault.credentials[0].value_hint).toBe('••••alue');
    });

    it('allows duplicate credential vault display names', async () => {
      const first = await postJson('/v1/credential-vaults', { id: 'vlt_client_supplied', name: 'Shared credentials' });
      const second = await postJson('/v1/credential-vaults', { id: 'vlt_client_supplied', name: 'Shared credentials' });

      expect(first.res.status).toBe(201);
      expect(second.res.status).toBe(201);
      expect(first.body.id).toMatch(/^vlt_/);
      expect(second.body.id).toMatch(/^vlt_/);
      expect(first.body.id).not.toBe('vlt_client_supplied');
      expect(second.body.id).not.toBe('vlt_client_supplied');
      expect(first.body.id).not.toBe(second.body.id);
      expect(first.body.name).toBe('Shared credentials');
      expect(second.body.name).toBe('Shared credentials');
    });

    it('rejects non-standard credential injection locations', async () => {
      const vaultRes = await app.request('/v1/credential-vaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Strict vault' }),
      });
      const vault = await vaultRes.json();

      const credentialRes = await app.request(`/v1/credential-vaults/${vault.id}/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth_type: 'bearer_token',
          value: 'sk-test-secret-value',
          injection_locations: ['headers'],
        }),
      });
      expect(credentialRes.status).toBe(400);
      expect((await credentialRes.json()).error.message).toContain('request_headers');
    });

    it('archives and deletes credentials within a vault', async () => {
      const vaultRes = await app.request('/v1/credential-vaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Lifecycle vault' }),
      });
      const vault = await vaultRes.json();
      const credentialRes = await app.request(`/v1/credential-vaults/${vault.id}/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth_type: 'mcp_oauth',
          mcp_server_url: 'https://mcp.example.com',
        }),
      });
      const credential = await credentialRes.json();

      const archiveRes = await app.request(`/v1/credential-vaults/${vault.id}/credentials/${credential.id}/archive`, { method: 'POST' });
      expect(archiveRes.status).toBe(200);
      expect((await archiveRes.json()).status).toBe('archived');

      const deleteRes = await app.request(`/v1/credential-vaults/${vault.id}/credentials/${credential.id}`, { method: 'DELETE' });
      expect(deleteRes.status).toBe(200);
      expect((await deleteRes.json()).status).toBe('deleted');
    });
  });

  describe('Memory stores', () => {
    it('supports detail, normalized path conflicts, active memory filtering, and store archive', async () => {
      const { res: storeRes, body: store } = await postJson('/v1/memory_stores', {
        name: 'Contract memory store',
        description: 'Persistent memory for contract tests.',
        metadata: { owner: 'qa' },
      });
      expect(storeRes.status).toBe(201);
      expect(store.type).toBe('memory_store');
      expect(store.memory_count).toBe(0);

      const { res: memoryRes, body: memory } = await postJson(`/v1/memory_stores/${store.id}/memories`, {
        path: '/folder/a',
        content: 'alpha',
        metadata: { kind: 'note' },
      });
      expect(memoryRes.status).toBe(201);
      expect(memory.path).toBe('/folder/a');

      const duplicate = await postJson(`/v1/memory_stores/${store.id}/memories`, {
        path: '/folder//a',
        content: 'duplicate',
      });
      expect(duplicate.res.status).toBe(409);
      expect(duplicate.body.error.type).toBe('memory_path_conflict_error');

      const detailRes = await app.request(`/v1/memory_stores/${store.id}`);
      expect(detailRes.status).toBe(200);
      const detail = await detailRes.json();
      expect(detail.memory_count).toBe(1);
      expect(detail.memories[0].content).toBe('alpha');

      const deleteRes = await app.request(`/v1/memory_stores/${store.id}/memories/${memory.id}`, { method: 'DELETE' });
      expect(deleteRes.status).toBe(200);

      const memoriesRes = await app.request(`/v1/memory_stores/${store.id}/memories`);
      const memories = await memoriesRes.json();
      expectCursorPage(memories);
      expect(memories.data).toEqual([]);

      const archiveStoreRes = await app.request(`/v1/memory_stores/${store.id}/archive`, { method: 'POST' });
      expect(archiveStoreRes.status).toBe(200);
      expect((await archiveStoreRes.json()).status).toBe('archived');

      const archivedDetailRes = await app.request(`/v1/memory_stores/${store.id}`);
      expect(archivedDetailRes.status).toBe(404);
      const archivedMemoryCreate = await postJson(`/v1/memory_stores/${store.id}/memories`, {
        path: '/folder/b',
        content: 'beta',
      });
      // An archived store is read-only by name: writes refuse with the
      // archived conflict rather than the 404 a missing store gets.
      expect(archivedMemoryCreate.res.status).toBe(409);
      expect((archivedMemoryCreate.body as any).error.code).toBe('memory_store_archived');
    });

    it('creates a memory store and manages memories by path', async () => {
      const storeRes = await app.request('/v1/memory_stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Research notes',
          id: 'memstore_client_supplied',
          description: 'Persistent notes for agents.',
        }),
      });
      expect(storeRes.status).toBe(201);
      const store = await storeRes.json();
      expect(store.id).toMatch(/^memstore_/);
      expect(store.id).not.toBe('memstore_client_supplied');
      expect(store.memory_count).toBe(0);
      expect(store.memories).toEqual([]);

      const memoryRes = await app.request(`/v1/memory_stores/${store.id}/memories?view=full`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/note/d',
          id: 'mem_client_supplied',
          content: 'ddd',
        }),
      });
      expect(memoryRes.status).toBe(201);
      const memory = await memoryRes.json();
      expect(memory.id).toMatch(/^mem_/);
      expect(memory.id).not.toBe('mem_client_supplied');
      expect(memory.path).toBe('/note/d');
      expect(memory.content).toBe('ddd');

      const updateRes = await app.request(`/v1/memory_stores/${store.id}/memories/${memory.id}?view=full`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'updated' }),
      });
      expect(updateRes.status).toBe(200);
      expect((await updateRes.json()).content).toBe('updated');

      const listRes = await app.request('/v1/memory_stores');
      const list = await listRes.json();
      const listedStore = list.data.find((item: any) => item.id === store.id);
      expect(listedStore.memory_count).toBe(1);
      expect(listedStore.memories[0].path).toBe('/note/d');

      const deleteRes = await app.request(`/v1/memory_stores/${store.id}/memories/${memory.id}`, { method: 'DELETE' });
      expect(deleteRes.status).toBe(200);
      expect((await deleteRes.json()).type).toBe('memory_deleted');

      const recreateRes = await app.request(`/v1/memory_stores/${store.id}/memories?view=full`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/note/d',
          content: 'recreated',
        }),
      });
      expect(recreateRes.status).toBe(201);
      expect((await recreateRes.json()).content).toBe('recreated');
    });

    it('rejects memory paths that are not file-like absolute paths', async () => {
      const storeRes = await app.request('/v1/memory_stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Absolute paths only' }),
      });
      const store = await storeRes.json();
      const res = await app.request(`/v1/memory_stores/${store.id}/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'note/d', content: 'ddd' }),
      });
      expect(res.status).toBe(400);

      const rootRes = await app.request(`/v1/memory_stores/${store.id}/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/', content: 'ddd' }),
      });
      expect(rootRes.status).toBe(400);

      const directoryRes = await app.request(`/v1/memory_stores/${store.id}/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/note/', content: 'ddd' }),
      });
      expect(directoryRes.status).toBe(400);
    });
  });

  describe('DELETE /v1/sessions/:id', () => {
    it('permanently deletes a session and returns the official deletion envelope', async () => {
      const createRes = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'agent_echo-agent' }),
      });
      const { id } = await createRes.json();

      const delRes = await app.request(`/v1/sessions/${id}`, { method: 'DELETE' });
      expect(delRes.status).toBe(200);
      const delBody = await delRes.json();
      expect(delBody).toEqual({ id, type: 'session_deleted' });

      const retrieveRes = await app.request(`/v1/sessions/${id}`);
      expect(retrieveRes.status).toBe(404);

      const eventsRes = await app.request(`/v1/sessions/${id}/events`);
      expect(eventsRes.status).toBe(404);
    });

    it('returns 404 for non-existent session', async () => {
      const res = await app.request('/v1/sessions/sess_nope', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
  });

  describe('agent identity consistency', () => {
    it('session.agent.id resolves via GET /v1/agents/:id', async () => {
      const createRes = await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'agent_echo-agent' }),
      });
      const session = await createRes.json();

      const agentRes = await app.request(`/v1/agents/${session.agent.id}`);
      expect(agentRes.status).toBe(200);
      const agent = await agentRes.json();
      expect(agent.id).toBe(session.agent.id);
    });
  });

  describe('GET /v1/x/health', () => {
    it('returns health status', async () => {
      const res = await app.request('/v1/x/health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('healthy');
    });
  });

  describe('GET /v1/x/metrics', () => {
    it('returns 200 (metrics disabled without a registry)', async () => {
      const res = await app.request('/v1/x/metrics');
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('metrics');
    });
  });

  describe('POST /v1/x/reload', () => {
    it('reloads agents', async () => {
      const res = await app.request('/v1/x/reload', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reloaded).toBe(true);
    });
  });
});

function makeStoredZip(entries: Array<{ path: string; content: string; declaredSize?: number }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const content = Buffer.from(entry.content, 'utf8');
    const declaredSize = entry.declaredSize ?? content.length;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(declaredSize, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);

    localOffset += localHeader.length + name.length + content.length;
  }

  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([local, central, eocd]);
}
