import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from '@/core/db/database.js';
import { loadAgents } from '@/core/agent/loader.js';
import { importAgentSeeds, loadActiveAgentsFromDb } from '@/core/agent/store.js';
import { loadSkills } from '@/core/skills/loader.js';
import { importSkillSeeds, loadCustomSkillsFromDb } from '@/core/skills/store.js';
import { ensureDefaultEnvironment, loadRuntimeConfigBootstrap } from '@/core/runtime/config-bootstrap.js';
import { seedModelProviders } from '@/core/model/providers.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('examples/basic smoke', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ma-example-basic-'));
  const dataDir = join(tmpDir, '.managed-agents');
  const exampleRoot = resolve('examples/basic');
  const db = new Database(join(tmpDir, 'data.db'));

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads the example workspace and exposes agents, skills, environments, and sessions through the API app', async () => {
    mkdirSync(dataDir, { recursive: true });
    db.runMigrations();

    // The path the README tells a reader to start from: the example keeps its
    // configuration inside `.managed-agents`, and a smoke test that reads a file
    // which does not exist would load defaults and never notice.
    const configPath = join(exampleRoot, '.managed-agents', 'config.yaml');
    expect(existsSync(configPath)).toBe(true);

    // Loaded the way the runtime loads it (`src/index.ts` uses this bootstrap,
    // not the legacy `models:` reader in `bootstrap.ts`, which does not know this
    // file's shape). Every field the example documents is asserted below, so
    // emptying or editing the file fails here rather than loading defaults.
    const bootstrap = loadRuntimeConfigBootstrap({ db, configPath, target: 'local' });

    expect(bootstrap.declaredModel).toEqual({
      provider: 'openai',
      base_url: '${OPENAI_BASE_URL}',
      api_key_declared: true,
    });
    expect(bootstrap.models).toHaveLength(1);
    expect(bootstrap.models[0]).toMatchObject({
      provider: 'openai',
      base_url: '${OPENAI_BASE_URL}',
      api_key: '${OPENAI_API_KEY}',
    });
    // `storage:` is what makes the artifacts directory a workspace path rather
    // than a default; the example's `base_path` is the one the README documents.
    expect(bootstrap.settingsSeed.storage?.metadata.provider).toBe('sqlite');
    expect(bootstrap.settingsSeed.storage?.artifacts.options).toMatchObject({ base_path: 'files' });
    // Neither a concrete model id nor an options bag belongs in this section.
    expect(bootstrap.ignoredModelKeys).toEqual([]);

    // The environment the file declares, read before the default is ensured: a
    // test that inserted its own `local` environment could not tell whether the
    // `environments:` block was there at all.
    const seeded = db.prepare('SELECT name, config FROM environments').all() as Array<{ name: string; config: string }>;
    expect(seeded.map((row) => row.name)).toEqual(['local']);
    expect(JSON.parse(seeded[0].config)).toEqual({ sandbox_provider: 'local', timeout: 300 });

    ensureDefaultEnvironment(db);
    seedModelProviders(db, bootstrap.models);

    const agentLoad = loadAgents(join(exampleRoot, 'agents'));
    expect(agentLoad.errors).toEqual([]);
    expect(importAgentSeeds(db, agentLoad.agents)).toEqual([]);

    const skillLoad = loadSkills(join(exampleRoot, 'skills'));
    expect(skillLoad.errors).toEqual([]);
    importSkillSeeds(db, skillLoad.skills);

    const agents = loadActiveAgentsFromDb(db);
    const skills = loadCustomSkillsFromDb(db);
    const sessionManager = new SessionManager(db);
    const app = createServer({
      db,
      sessionManager,
      agents,
      skills,
      workspace: {
        root: exampleRoot,
        dataDir,
        agentsDir: join(exampleRoot, 'agents'),
        skillsDir: join(exampleRoot, 'skills'),
        configPath,
        target: 'local',
      },
      runtime: {
        models: [],
        sandboxProviders: ['local'],
        memory: bootstrap.settingsSeed.memory ? 'sqlite' : 'disabled',
        authEnabled: false,
      },
      reloadAgents: () => ({ agents, errors: [] }),
    });

    const workspace = await getJson(app, '/v1/x/workspace');
    expect(workspace.name).toBe('basic');

    const agentPage = await getJson(app, '/v1/agents');
    const assistant = agentPage.data.find((agent: any) => agent.name === 'workspace-assistant');
    expect(assistant).toBeDefined();
    // The model id belongs to the agent, so the example has to name one a real
    // endpoint serves: this is the value the README tells a reader to replace if
    // their provider does not offer it.
    expect(assistant.model).toBe('gpt-4o');

    const skillPage = await getJson(app, '/v1/skills');
    expect(skillPage.data.map((skill: any) => skill.name)).toContain('code-review');

    const envPage = await getJson(app, '/v1/environments');
    expect(envPage.data.some((environment: any) => environment.name === 'local')).toBe(true);

    const sessionRes = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'agent_workspace-assistant', environment_id: 'env_default', title: 'example smoke' }),
    });
    expect(sessionRes.status).toBe(201);
    const session = await sessionRes.json() as any;
    expect(session.id).toMatch(/^sess_/);
  });
});

async function getJson(app: ReturnType<typeof createServer>, path: string) {
  const res = await app.request(path);
  expect(res.status, path).toBe(200);
  return res.json() as Promise<any>;
}
