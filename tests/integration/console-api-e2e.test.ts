import React from 'react';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { SessionManager, type SessionExecutor } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { createLogger, InMemoryLogStore } from '@/core/observability/logger.js';
import { Agents } from '../../apps/console/src/components/pages/AgentPages.js';
import { Sessions } from '../../apps/console/src/components/pages/SessionPages.js';
import { Environments } from '../../apps/console/src/components/pages/EnvironmentPages.js';
import { Files, Skills } from '../../apps/console/src/components/pages/BuildPages.js';
import { CredentialVaults } from '../../apps/console/src/components/pages/CredentialPages.js';
import { MemoryStores } from '../../apps/console/src/components/pages/MemoryPages.js';
import { OutcomesPage, ScheduledDeploymentsPage, WebhooksPage } from '../../apps/console/src/components/pages/OperationsPages.js';
import { SettingsView } from '../../apps/console/src/components/pages/settings/SettingsView.js';
import type { ConsoleData } from '../../apps/console/src/types.js';

describe('Console/API no-port E2E flow', () => {
  let app: ReturnType<typeof createServer>;
  let db: Database;
  let tmpDir: string;
  let dataDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-console-api-e2e-'));
    dataDir = join(tmpDir, '.managed-agents');
    const agentsDir = join(tmpDir, 'agents');
    const skillsDir = join(tmpDir, 'skills');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(tmpDir, 'managed-agents.config.yaml'), 'models: []\n');

    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{"sandbox_provider":"local"}')`);
    const sessionManager = new SessionManager(db);
    const executor: SessionExecutor = {
      async *execute(session, event) {
        const text = event.content?.find((block: any) => block.type === 'text')?.text ?? 'message';
        yield {
          id: `sevt_${session.id}_reply`,
          sessionId: session.id,
          seq: 0,
          type: 'agent.message',
          content: [{ type: 'text', text: `echo: ${text}` }],
          createdAt: new Date(),
        };
      },
      async cleanupSession() {},
    };
    sessionManager.setExecutor(executor);
    const logStore = new InMemoryLogStore();

    app = createServer({
      db,
      sessionManager,
      agents: [],
      consoleRoot: null,
      workspace: {
        root: tmpDir,
        dataDir,
        agentsDir,
        skillsDir,
        configPath: join(tmpDir, 'managed-agents.config.yaml'),
        target: 'local',
      },
      runtime: {
        models: [],
        sandboxProviders: ['local', 'self_hosted'],
        memory: 'sqlite',
        authEnabled: false,
      },
      logger: createLogger({ level: 'debug', logStore, write: () => undefined }),
      logStore,
      reloadAgents: () => ({ agents: [], errors: [] }),
    });
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates resources through API and renders the corresponding Console pages', async () => {
    const currentSettings = await json('/v1/x/settings');
    const settingsUpdate = await putJson('/v1/x/settings', {
      revision: currentSettings.revision,
      config: {
        ...currentSettings.saved_config,
        model: {
          ...currentSettings.saved_config.model,
          vendor: 'openai',
          api_key: 'sk-test',
        },
      },
    });
    expect(settingsUpdate.status).toBe(200);
    expect(settingsUpdate.body.saved_config.model.vendor).toBe('openai');

    const legacySettingsUpdate = await postJson('/v1/x/settings/test', {
      area: 'model',
      config: {
        vendor: 'openai',
        api_key: '********',
      },
    });
    expect(legacySettingsUpdate.status).toBe(200);

    const environment = await postJson('/v1/environments', {
      name: 'E2E local',
      description: 'Console API flow environment',
      hosting_type: 'local',
      sandbox_provider: 'local',
      config: { timeout: 300 },
    });
    expect(environment.status).toBe(201);

    const agent = await postJson('/v1/agents', {
      name: 'E2E agent',
      description: 'Created by no-port E2E',
      model: 'default',
      system: 'Echo user messages.',
      tools: [{ type: 'agent_toolset_20260401' }],
      skills: [],
    });
    expect(agent.status).toBe(201);

    const file = await postJson('/v1/files', {
      name: 'brief.txt',
      content: 'hello from e2e',
      media_type: 'text/plain',
    });
    expect(file.status).toBe(201);

    const vault = await postJson('/v1/credential-vaults', {
      name: 'E2E vault',
      description: 'Vault created by no-port E2E',
    });
    expect(vault.status).toBe(201);

    const memoryStore = await postJson('/v1/memory_stores', {
      name: 'E2E memory',
      description: 'Memory store created by no-port E2E',
    });
    expect(memoryStore.status).toBe(201);

    const memory = await postJson(`/v1/memory_stores/${memoryStore.body.id}/memories`, {
      path: '/notes/e2e',
      content: 'remember this E2E flow',
    });
    expect(memory.status).toBe(201);

    const session = await postJson('/v1/sessions', {
      agent: agent.body.id,
      environment_id: environment.body.id,
      title: 'E2E session',
      resources: [{ type: 'file', file_id: file.body.id, mount_path: '/uploads/brief.txt' }],
      vault_ids: [vault.body.id],
    });
    expect(session.status, JSON.stringify(session.body)).toBe(201);

    const message = await postJson(`/v1/sessions/${session.body.id}/messages`, {
      content: 'hello',
      stream: false,
    });
    expect(message.status).toBe(200);

    const webhook = await postJson('/v1/webhooks', {
      name: 'E2E webhook',
      url: 'https://example.invalid/webhook',
      events: ['session.completed'],
    });
    expect(webhook.status).toBe(201);

    const schedule = await postJson('/v1/scheduled-deployments', {
      name: 'E2E schedule',
      agent_id: agent.body.id,
      environment_id: environment.body.id,
      cron: '0 * * * *',
      payload: { title: 'scheduled e2e' },
    });
    expect(schedule.status).toBe(201);

    const outcome = await postJson('/v1/outcomes', {
      name: 'E2E outcome',
      objective: 'The session should answer.',
      criteria: ['Agent replied'],
    });
    expect(outcome.status).toBe(201);

    const data = await loadConsoleData();

    expect(render(Agents, { data, onNewAgent: () => {}, onOpenAgent: () => {} })).toContain('E2E agent');
    expect(render(Sessions, { data, onNewSession: () => {}, onOpenSession: () => {} })).toContain('E2E session');
    expect(render(Environments, { data, onNew: () => {}, onOpenEnvironment: () => {} })).toContain('E2E local');
    expect(render(Files, { data, onRefresh: () => {} })).toContain('brief.txt');
    expect(render(CredentialVaults, { data, onNew: () => {}, onOpenVault: () => {} })).toContain('E2E vault');
    expect(render(MemoryStores, { data, onNew: () => {}, onOpenMemoryStore: () => {} })).toContain('E2E memory');
    expect(render(WebhooksPage, { data, onRefresh: () => {} })).toContain('E2E webhook');
    expect(render(ScheduledDeploymentsPage, { data, onRefresh: () => {} })).toContain('E2E schedule');
    expect(render(OutcomesPage, { data, onRefresh: () => {} })).toContain('E2E outcome');
    expect(render(Skills, { data, onRefresh: () => {} })).toContain('Skills');
    expect(render(SettingsView, { data, section: 'models', onRefresh: () => {}, setView: () => {} })).toContain('openai');
    expect(render(SettingsView, { data, section: 'api-reference', onRefresh: () => {}, setView: () => {} })).toContain('/v1/sessions');
  });

  async function loadConsoleData(): Promise<ConsoleData> {
    const [
      agents,
      sessions,
      environments,
      vaults,
      memoryStores,
      files,
      skills,
      webhooks,
      scheduledDeployments,
      outcomes,
      workspace,
      settings,
      runtime,
    ] = await Promise.all([
      page('/v1/agents'),
      page('/v1/sessions'),
      page('/v1/environments'),
      page('/v1/credential-vaults'),
      page('/v1/memory_stores'),
      page('/v1/files'),
      page('/v1/skills'),
      page('/v1/webhooks'),
      page('/v1/scheduled-deployments'),
      page('/v1/outcomes'),
      json('/v1/x/workspace'),
      json('/v1/x/settings'),
      json('/v1/x/runtime'),
    ]);

    return {
      agents,
      sessions,
      environments,
      vaults,
      memoryStores,
      files,
      apiKeys: [],
      skills,
      templates: [],
      webhooks,
      scheduledDeployments,
      outcomes,
      runtime,
      settings,
      workspace,
    };
  }

  async function page(path: string) {
    const body = await json(path);
    return body.data ?? [];
  }

  async function json(path: string) {
    const res = await app.request(path);
    expect(res.status, path).toBe(200);
    return parseJsonResponse(path, res);
  }

  async function postJson(path: string, body: unknown) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await parseJsonResponse(path, res) };
  }

  async function putJson(path: string, body: unknown) {
    const res = await app.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await parseJsonResponse(path, res) };
  }

  async function parseJsonResponse(path: string, res: Response) {
    const text = await res.text();
    try {
      return JSON.parse(text) as any;
    } catch (error) {
      throw new Error(`${path} returned non-JSON ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  function render<P extends Record<string, unknown>>(component: React.ComponentType<P>, props: P): string {
    return renderToString(React.createElement(component, props));
  }
});
