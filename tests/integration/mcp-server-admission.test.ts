/**
 * `url` MCP-server admission at session create and update.
 *
 * The published rule: under a `limited` Environment with
 * `allow_mcp_server_network_access` off, session creation fails with a 400
 * when the agent declares a `url` MCP server whose host `allowed_hosts` does
 * not cover. The check belongs at create — before any session row exists —
 * not only at the connect boundary, so a session is never admitted just to
 * fail its first connect. A `stdio` server names no endpoint and is never
 * checked; `unrestricted`, an open MCP flag, and `blocked`-only policies
 * admit everything.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '@/api/server.js';
import { Database } from '@/core/db/database.js';
import { SessionManager, type SessionExecutor } from '@/core/session/session-manager.js';
import type { AgentDefinition, McpServerConfig } from '@/types/agent.js';

function createTestApp() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ma-mcp-admission-'));
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
    reloadAgents: () => ({ agents, errors: [] }),
  });
  return { app, db, tmpDir, agents };
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

async function createEnvironment(ctx: TestContext, networking: Record<string, unknown>) {
  const attempt = await request(ctx.app, 'POST', '/v1/environments', {
    name: `env-${Math.random().toString(36).slice(2, 8)}`,
    config: { networking },
  });
  expect(attempt.res.status).toBe(201);
  return attempt.body.id as string;
}

async function createAgent(ctx: TestContext, mcp_servers: McpServerConfig[]) {
  const attempt = await request(ctx.app, 'POST', '/v1/agents', {
    name: `agent-${Math.random().toString(36).slice(2, 8)}`,
    model: 'gpt-4o',
    system: 'test',
    mcp_servers,
    // Every declared url server needs a matching mcp_toolset or the agent is
    // refused on the unrelated "cannot call it" rule before admission runs.
    tools: mcp_servers.map((server) => ({
      type: 'mcp_toolset',
      mcp_server_name: server.name,
      configs: [],
    })),
  });
  expect(attempt.res.status, JSON.stringify(attempt.body)).toBe(201);
  return attempt.body.id as string;
}

describe('url MCP server allowed_hosts admission', () => {
  it('refuses session create when a url server host is outside allowed_hosts', async () => {
    const ctx = context();
    const environmentId = await createEnvironment(ctx, { type: 'limited', allowed_hosts: ['api.example.com'] });
    const agentId = await createAgent(ctx, [{ type: 'url', name: 'evil', url: 'https://mcp.evil.com/sse' }]);

    const attempt = await request(ctx.app, 'POST', '/v1/sessions', { agent: agentId, environment_id: environmentId });

    expect(attempt.res.status).toBe(400);
    expect(attempt.body.error.message).toContain('allowed_hosts');
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).toEqual({ n: 0 });
  });

  it('admits session create when the url server host is covered', async () => {
    const ctx = context();
    const environmentId = await createEnvironment(ctx, { type: 'limited', allowed_hosts: ['mcp.example.com'] });
    const agentId = await createAgent(ctx, [{ type: 'url', name: 'ok', url: 'https://mcp.example.com/sse' }]);

    const attempt = await request(ctx.app, 'POST', '/v1/sessions', { agent: agentId, environment_id: environmentId });

    expect(attempt.res.status).toBe(201);
  });

  it('admits a url server outside allowed_hosts when the policy opens MCP access', async () => {
    const ctx = context();
    const environmentId = await createEnvironment(ctx, {
      type: 'limited',
      allowed_hosts: ['api.example.com'],
      allow_mcp_servers: true,
    });
    const agentId = await createAgent(ctx, [{ type: 'url', name: 'wide', url: 'https://mcp.evil.com/sse' }]);

    const attempt = await request(ctx.app, 'POST', '/v1/sessions', { agent: agentId, environment_id: environmentId });

    expect(attempt.res.status).toBe(201);
  });

  it('admits stdio servers — they name no endpoint to check', async () => {
    const ctx = context();
    const environmentId = await createEnvironment(ctx, { type: 'limited', allowed_hosts: ['api.example.com'] });
    const agentId = await createAgent(ctx, [{ type: 'stdio', name: 'local', command: 'mcp-server' }]);

    const attempt = await request(ctx.app, 'POST', '/v1/sessions', { agent: agentId, environment_id: environmentId });

    expect(attempt.res.status).toBe(201);
  });

  it('admits a url server outside allowed_hosts under unrestricted networking', async () => {
    const ctx = context();
    const environmentId = await createEnvironment(ctx, { type: 'unrestricted' });
    const agentId = await createAgent(ctx, [{ type: 'url', name: 'any', url: 'https://mcp.anything.net/sse' }]);

    const attempt = await request(ctx.app, 'POST', '/v1/sessions', { agent: agentId, environment_id: environmentId });

    expect(attempt.res.status).toBe(201);
  });

  it('refuses a session update that swaps in an uncovered url server', async () => {
    const ctx = context();
    const environmentId = await createEnvironment(ctx, { type: 'limited', allowed_hosts: ['api.example.com'] });
    const agentId = await createAgent(ctx, []);
    const created = await request(ctx.app, 'POST', '/v1/sessions', { agent: agentId, environment_id: environmentId });
    expect(created.res.status).toBe(201);
    const sessionId = created.body.id as string;

    const attempt = await request(ctx.app, 'POST', `/v1/sessions/${sessionId}`, {
      agent: {
        mcp_servers: [{ type: 'url', name: 'evil', url: 'https://mcp.evil.com/sse' }],
        tools: [{ type: 'mcp_toolset', mcp_server_name: 'evil', configs: [] }],
      },
    });

    expect(attempt.res.status).toBe(400);
    expect(attempt.body.error.message).toContain('allowed_hosts');
  });
});
