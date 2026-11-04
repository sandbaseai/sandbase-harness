/**
 * Creation-time agent overrides over the wire.
 *
 * `contracts/anthropic-cma/sessions.md` §2 says a session may run an agent with
 * part of its configuration replaced, and that the refusals are code-carrying
 * 400s that leave no session behind. The unit test pins the resolution rules;
 * this file pins the three seams a resolver alone cannot prove: that the
 * override reaches the session's own frozen snapshot (which is what the loop
 * reads), that the durable agent and its version list are untouched, and that a
 * refused override creates nothing.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { loadSkills } from '@/core/skills/loader.js';

describe('agent_with_overrides over the API', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let app: ReturnType<typeof createServer>;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function setupApp(): void {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-agent-overrides-'));
    const skillsDir = join(tmpDir, 'skills');
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    // The creation path resolves the agent from the store, so the fixtures write
    // rows rather than handing a definition to the server.
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_echo-agent',
      'echo-agent',
      JSON.stringify({ name: 'echo-agent', model: 'gpt-4o', system: 'You are a test agent.', tools: [] }),
    );
    // The `tools`-clearing exception is only reachable for an agent that has
    // skills, because skills are what the `read` tool is needed for.
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_skill-agent',
      'skill-agent',
      JSON.stringify({
        name: 'skill-agent',
        model: 'gpt-4o',
        system: 'Skill agent.',
        tools: [{ type: 'agent_toolset_20260401', configs: [] }],
        skills: [{ type: 'custom', skill_id: 'skill_writer' }],
      }),
    );
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      skills: loadSkills(skillsDir).skills,
      workspace: {
        root: tmpDir,
        dataDir: tmpDir,
        agentsDir: join(tmpDir, 'agents'),
        skillsDir,
        target: 'local',
      },
    });
  }

  async function post(path: string, body: unknown) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { res, body: await res.json() as any };
  }

  async function get(path: string) {
    const res = await app.request(path);
    return { res, body: await res.json() as any };
  }

  function count(table: 'sessions' | 'agent_versions'): number {
    const row = db!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  }

  it('runs the session on the resolved configuration and leaves the agent alone', async () => {
    setupApp();
    const versionsBefore = count('agent_versions');

    const { res, body } = await post('/v1/sessions', {
      agent: {
        type: 'agent_with_overrides',
        id: 'agent_echo-agent',
        model: 'gpt-4o-mini',
        system: 'Override prompt.',
      },
    });

    expect(res.status).toBe(201);
    // The creation response reports the configuration the session will run, and
    // the reference still names the agent it was derived from.
    expect(body.agent).toMatchObject({
      id: 'agent_echo-agent',
      version: 1,
      model: { id: 'gpt-4o-mini', speed: 'standard' },
      system: 'Override prompt.',
    });

    // The frozen snapshot is what the loop reads, so the override has to be in
    // it rather than only in the response body.
    const row = db!.prepare('SELECT agent_definition FROM sessions WHERE id = ?').get(body.id) as { agent_definition: string };
    const frozen = JSON.parse(row.agent_definition) as { model: string; system: string };
    expect(frozen.model).toBe('gpt-4o-mini');
    expect(frozen.system).toBe('Override prompt.');

    // The durable agent and its version list are untouched: an override never
    // versions the agent.
    const durable = await get('/v1/agents/agent_echo-agent');
    expect(durable.body).toMatchObject({ model: { id: 'gpt-4o' }, system: 'You are a test agent.' });
    expect(count('agent_versions')).toBe(versionsBefore);
  });

  it('leaves a session created without overrides following the agent', async () => {
    setupApp();
    const { res, body } = await post('/v1/sessions', { agent: { id: 'agent_echo-agent' } });
    expect(res.status).toBe(201);
    expect(body.agent).toMatchObject({ model: { id: 'gpt-4o' }, system: 'You are a test agent.' });

    const row = db!.prepare('SELECT agent_definition FROM sessions WHERE id = ?').get(body.id) as { agent_definition: string | null };
    expect(row.agent_definition).toBeNull();
  });

  it('refuses every override it cannot honour, and creates nothing', async () => {
    setupApp();
    const cases = [
      { label: 'model cleared', agent: { type: 'agent_with_overrides', id: 'agent_echo-agent', model: null }, code: 'agent_model_required' },
      { label: 'unknown field', agent: { type: 'agent_with_overrides', id: 'agent_echo-agent', max_turns: 3 }, code: 'invalid_agent_overrides' },
      { label: 'malformed field', agent: { type: 'agent_with_overrides', id: 'agent_echo-agent', system: 5 }, code: 'invalid_agent_override_field' },
      { label: 'tools cleared under skills', agent: { type: 'agent_with_overrides', id: 'agent_skill-agent', tools: [] }, code: 'agent_tools_cleared_with_skills' },
      { label: 'unknown agent type', agent: { type: 'agent_with_overrides_v2', id: 'agent_echo-agent' }, code: 'invalid_agent_ref' },
    ];

    for (const { label, agent, code } of cases) {
      const { res, body } = await post('/v1/sessions', { agent });
      expect(res.status, label).toBe(400);
      expect(body.error.code, label).toBe(code);
      expect(count('sessions'), label).toBe(0);
    }
  });

  it('refuses the override form on the run facade instead of ignoring it', async () => {
    setupApp();
    const { res, body } = await post('/v1/runs', {
      agent: { type: 'agent_with_overrides', id: 'agent_echo-agent', system: 'Override prompt.' },
      input: 'hello',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(body)).toContain('agent_with_overrides is not supported on /v1/runs');
    expect(count('sessions')).toBe(0);
  });
});
