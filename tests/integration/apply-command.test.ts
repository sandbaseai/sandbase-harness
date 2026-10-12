/**
 * Integration test: `managed-agents apply` drives the real routes.
 *
 * The published `ant apply` contract — a frontmatter manifest creates the
 * resource the first time and updates it afterwards, with resolved ids
 * recorded in a lock file — is only meaningful if the wire calls land. Each
 * assertion below therefore runs against a real HTTP listener and a real
 * SQLite file, and every write is read back through a different route than
 * the one that wrote it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { serve } from '@hono/node-server';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { applyCommand, APPLY_LOCK_FILE } from '@/cli/apply-command.js';

type RealServer = { close: (cb?: () => void) => void; closeAllConnections?: () => void };

async function capture<T>(fn: () => Promise<T>) {
  const log: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    log.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  try {
    return { result: await fn(), log };
  } finally {
    logSpy.mockRestore();
  }
}

const AGENT_MD = `---
name: Coding Assistant
model: claude-opus-5-5
tools:
  - type: agent_toolset_20260401
---

You are a helpful coding assistant.
`;

const ENVIRONMENT_YAML = `name: quickstart-env
config:
  type: local
`;

const DEPLOYMENT_MD = `---
name: Weekly scan
agent: Coding Assistant
environment: quickstart-env
schedule:
  type: cron
  expression: "0 20 * * 5"
  timezone: UTC
---

Run the weekly compliance scan.
`;

describe('apply command', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let listening: RealServer | undefined;

  afterEach(async () => {
    if (listening) {
      const server = listening;
      listening = undefined;
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    db?.close();
    db = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  async function startRuntime() {
    const dir = mkdtempSync(join(tmpdir(), 'ma-apply-'));
    tmpDir = dir;
    db = new Database(join(dir, 'test.db'));
    db.runMigrations();
    const app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
    });
    const port = await new Promise<number>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        listening = server as unknown as RealServer;
        resolve(info.port);
      });
    });
    return { app, port, dir };
  }

  function writeManifest(dir: string, name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  }

  it('creates an agent from a frontmatter markdown file and records the id in the lock file', async () => {
    const { app, port, dir } = await startRuntime();
    const agentFile = writeManifest(dir, 'coding-assistant.md', AGENT_MD);
    const lockPath = join(dir, APPLY_LOCK_FILE);

    const { log } = await capture(() =>
      applyCommand([agentFile], { port: String(port), lockFile: lockPath }));

    expect(log.join('\n')).toContain('Created agent:');
    const read = await app.request('/v1/agents');
    const agents = (await read.json() as { data: Array<{ id: string; name: string; system: string }> }).data;
    const agent = agents.find((a) => a.name === 'Coding Assistant');
    expect(agent).toBeDefined();
    // The body below the frontmatter became the system prompt.
    expect(agent!.system).toContain('helpful coding assistant');

    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { resources: Record<string, { id: string; kind: string }> };
    const key = Object.keys(lock.resources).find((k) => k.endsWith('coding-assistant.md'));
    expect(key).toBeDefined();
    expect(lock.resources[key!].id).toBe(agent!.id);
    expect(lock.resources[key!].kind).toBe('agent');
  });

  it('updates the same agent on a second apply rather than creating a duplicate', async () => {
    const { app, port, dir } = await startRuntime();
    const agentFile = writeManifest(dir, 'coding-assistant.md', AGENT_MD);
    const lockPath = join(dir, APPLY_LOCK_FILE);

    await capture(() => applyCommand([agentFile], { port: String(port), lockFile: lockPath }));
    writeFileSync(agentFile, AGENT_MD.replace('helpful coding assistant', 'helpful coding agent'));
    const { log } = await capture(() =>
      applyCommand([agentFile], { port: String(port), lockFile: lockPath }));

    expect(log.join('\n')).toContain('Updated agent:');
    const agents = (await (await app.request('/v1/agents')).json() as { data: Array<{ name: string; system: string }> }).data;
    expect(agents.filter((a) => a.name === 'Coding Assistant')).toHaveLength(1);
    expect(agents[0].system).toContain('helpful coding agent');
  });

  it('applies an environment yaml document', async () => {
    const { app, port, dir } = await startRuntime();
    const envFile = writeManifest(dir, 'environment.yaml', ENVIRONMENT_YAML);
    const lockPath = join(dir, APPLY_LOCK_FILE);

    const { log } = await capture(() =>
      applyCommand([envFile], { port: String(port), lockFile: lockPath }));

    expect(log.join('\n')).toContain('Created environment:');
    const environments = (await (await app.request('/v1/environments')).json() as { data: Array<{ name: string; config: Record<string, unknown> }> }).data;
    const env = environments.find((e) => e.name === 'quickstart-env');
    expect(env).toBeDefined();
    // `config.type: "local"` resolves to the local backend; the projection
    // reports the declared hosting axis on `config.type` and the resolved
    // backend on `effective_sandbox_provider`.
    expect((env as { effective_sandbox_provider?: string }).effective_sandbox_provider).toBe('local');
  });

  it('applies the agent+environment+deployment triple in one command, resolving agent by name', async () => {
    const { app, port, dir } = await startRuntime();
    const agentFile = writeManifest(dir, 'coding-assistant.md', AGENT_MD);
    const envFile = writeManifest(dir, 'environment.yaml', ENVIRONMENT_YAML);
    const deploymentFile = writeManifest(dir, 'deployment.md', DEPLOYMENT_MD);
    const lockPath = join(dir, APPLY_LOCK_FILE);

    const { log } = await capture(() =>
      applyCommand([agentFile, envFile, deploymentFile], { port: String(port), lockFile: lockPath }));

    const printed = log.join('\n');
    expect(printed).toContain('Created agent:');
    expect(printed).toContain('Created environment:');
    expect(printed).toContain('Created deployment:');

    const deployments = (await (await app.request('/v1/deployments')).json() as { data: Array<{ name: string; agent: { id: string }; environment_id: string | null; initial_events: Array<{ type: string; content: unknown }> }> }).data;
    const deployment = deployments.find((d) => d.name === 'Weekly scan');
    expect(deployment).toBeDefined();
    // `agent: Coding Assistant` resolved to the id the first file created.
    const agents = (await (await app.request('/v1/agents')).json() as { data: Array<{ id: string; name: string }> }).data;
    expect(deployment!.agent.id).toBe(agents.find((a) => a.name === 'Coding Assistant')!.id);
    // `environment: quickstart-env` resolved the same way through the env file.
    const environments = (await (await app.request('/v1/environments')).json() as { data: Array<{ id: string; name: string }> }).data;
    expect(deployment!.environment_id).toBe(environments.find((e) => e.name === 'quickstart-env')!.id);
    // The body became the initial user.message (the route normalizes the text
    // into content blocks, so the assertion reads through them).
    const firstEvent = deployment!.initial_events[0];
    expect(firstEvent.type).toBe('user.message');
    expect(JSON.stringify(firstEvent.content)).toContain('weekly compliance scan');
  });

  it('refuses a deployment manifest with neither initial_events nor a body', async () => {
    const { port, dir } = await startRuntime();
    const deploymentFile = writeManifest(dir, 'deployment.md', `---
name: Empty
agent: agent_missing
schedule:
  type: cron
  expression: "0 20 * * 5"
---
`);
    const lockPath = join(dir, APPLY_LOCK_FILE);
    await expect(
      applyCommand([deploymentFile], { port: String(port), lockFile: lockPath }),
    ).rejects.toThrow(/initial_events|body/);
  });

  it('refuses a file that is none of the three kinds', async () => {
    const { port, dir } = await startRuntime();
    const bad = writeManifest(dir, 'notes.md', 'just text, no frontmatter');
    await expect(
      applyCommand([bad], { port: String(port), lockFile: join(dir, APPLY_LOCK_FILE) }),
    ).rejects.toThrow(/frontmatter/);
  });

  it('refuses a missing file before contacting the server', async () => {
    const { port, dir } = await startRuntime();
    await expect(
      applyCommand([join(dir, 'nope.md')], { port: String(port), lockFile: join(dir, APPLY_LOCK_FILE) }),
    ).rejects.toThrow(/not found/);
    expect(existsSync(join(dir, APPLY_LOCK_FILE))).toBe(false);
  });
});
