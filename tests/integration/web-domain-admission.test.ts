/**
 * The `allowed_domains ⊆ allowed_hosts` session admission rule.
 *
 * The published rule: under a `limited` Environment, session create and the
 * update that adds such an entry fail with a 400 when an enabled `web_fetch`
 * or `web_search` declares an `allowed_domains` entry the Environment's
 * `allowed_hosts` does not cover. `unrestricted` does not limit the tools, and
 * `blocked_domains` is never checked — blocking a host outside the allowlist
 * is a no-op, not a granted permission.
 *
 * These cases pin the admission boundary at the HTTP surface: a rejected
 * session leaves no row behind, an update that adds a covered entry succeeds,
 * and the matching asymmetry is honoured (`docs.example.com` is within
 * `["docs.example.com"]` and `["*.example.com"]`, not `["example.com"]`).
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
  const tmpDir = mkdtempSync(join(tmpdir(), 'ma-web-domain-admission-'));
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

async function createAgent(ctx: TestContext, allowed_domains: string[], tool = 'web_fetch') {
  const attempt = await request(ctx.app, 'POST', '/v1/agents', {
    name: `agent-${Math.random().toString(36).slice(2, 8)}`,
    model: 'gpt-4o',
    system: 'test',
    tools: [{
      type: 'agent_toolset_20260401',
      configs: [{ name: tool, allowed_domains }],
    }],
  });
  expect(attempt.res.status).toBe(201);
  return attempt.body.id as string;
}

describe('web domain within allowed_hosts admission', () => {
  it('refuses session create when an allowed_domains entry is outside allowed_hosts', async () => {
    const ctx = context();
    const environmentId = await createEnvironment(ctx, { type: 'limited', allowed_hosts: ['api.example.com'] });
    const agentId = await createAgent(ctx, ['docs.other.com']);

    const attempt = await request(ctx.app, 'POST', '/v1/sessions', { agent: agentId, environment_id: environmentId });

    expect(attempt.res.status).toBe(400);
    expect(attempt.body.error.message).toContain('allowed_hosts');
    // Nothing is left behind: no session row for the refused request.
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).toEqual({ n: 0 });
  });

  it('admits session create when every allowed_domains entry is covered', async () => {
    const ctx = context();
    const environmentId = await createEnvironment(ctx, { type: 'limited', allowed_hosts: ['docs.example.org', '*.example.com'] });
    const agentId = await createAgent(ctx, ['docs.example.org']);

    const attempt = await request(ctx.app, 'POST', '/v1/sessions', { agent: agentId, environment_id: environmentId });

    expect(attempt.res.status).toBe(201);
  });

  it('applies the published asymmetry: a bare host does not cover a subdomain', async () => {
    const ctx = context();
    const environmentId = await createEnvironment(ctx, { type: 'limited', allowed_hosts: ['example.com'] });
    const agentId = await createAgent(ctx, ['docs.example.com']);

    const attempt = await request(ctx.app, 'POST', '/v1/sessions', { agent: agentId, environment_id: environmentId });

    expect(attempt.res.status).toBe(400);
  });

  it('admits the same subdomain under a wildcard allowed_hosts entry', async () => {
    const ctx = context();
    const environmentId = await createEnvironment(ctx, { type: 'limited', allowed_hosts: ['*.example.com'] });
    const agentId = await createAgent(ctx, ['docs.example.com']);

    const attempt = await request(ctx.app, 'POST', '/v1/sessions', { agent: agentId, environment_id: environmentId });

    expect(attempt.res.status).toBe(201);
  });

  it('does not limit the tools under unrestricted networking', async () => {
    const ctx = context();
    const environmentId = await createEnvironment(ctx, { type: 'unrestricted' });
    const agentId = await createAgent(ctx, ['anything.example.net']);

    const attempt = await request(ctx.app, 'POST', '/v1/sessions', { agent: agentId, environment_id: environmentId });

    expect(attempt.res.status).toBe(201);
  });

  it('refuses a session update that adds an uncovered allowed_domains entry', async () => {
    const ctx = context();
    const environmentId = await createEnvironment(ctx, { type: 'limited', allowed_hosts: ['api.example.com'] });
    const agentId = await createAgent(ctx, ['api.example.com']);
    const created = await request(ctx.app, 'POST', '/v1/sessions', { agent: agentId, environment_id: environmentId });
    expect(created.res.status).toBe(201);
    const sessionId = created.body.id as string;

    const attempt = await request(ctx.app, 'POST', `/v1/sessions/${sessionId}`, {
      agent: { tools: [{ type: 'agent_toolset_20260401', configs: [{ name: 'web_fetch', allowed_domains: ['outside.net'] }] }] },
    });

    expect(attempt.res.status).toBe(400);
    expect(attempt.body.error.message).toContain('allowed_hosts');
  });

  it('admits a session update that keeps allowed_domains inside allowed_hosts', async () => {
    const ctx = context();
    const environmentId = await createEnvironment(ctx, { type: 'limited', allowed_hosts: ['api.example.com', 'cdn.example.com'] });
    const agentId = await createAgent(ctx, ['api.example.com']);
    const created = await request(ctx.app, 'POST', '/v1/sessions', { agent: agentId, environment_id: environmentId });
    const sessionId = created.body.id as string;

    const attempt = await request(ctx.app, 'POST', `/v1/sessions/${sessionId}`, {
      agent: { tools: [{ type: 'agent_toolset_20260401', configs: [{ name: 'web_fetch', allowed_domains: ['cdn.example.com'] }] }] },
    });

    expect(attempt.res.status).toBe(200);
  });
});
