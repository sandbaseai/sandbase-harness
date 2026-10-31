/**
 * The published `system.message` admission rules beyond the content shape:
 *
 * - **Model gate.** The event is rejected with
 *   `model_does_not_support_mid_conversation_system` when the session's
 *   primary model is not on the published supported list. Only the primary
 *   model is checked; a supported-model session admits the event.
 * - **requires_action ordering.** While the session is idle on a pending tool
 *   call, a `system.message` must trail a tool-result event in the same
 *   request. Sent alone or beside a `user.message`, it is rejected until the
 *   pending call is resolved.
 * - **Text-only content.** `content` accepts 1–1000 text items; an image,
 *   document, tool_use, or tool_result block is refused rather than persisted
 *   as privileged context it was never meant to carry.
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
  const tmpDir = mkdtempSync(join(tmpdir(), 'ma-system-message-'));
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
  return { app, db, tmpDir, agents, sessionManager };
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

async function createSession(ctx: TestContext, model: string) {
  const agent = await request(ctx.app, 'POST', '/v1/agents', {
    name: `agent-${Math.random().toString(36).slice(2, 8)}`,
    model,
    system: 'test',
  });
  expect(agent.res.status).toBe(201);
  const created = await request(ctx.app, 'POST', '/v1/sessions', { agent: agent.body.id });
  expect(created.res.status, JSON.stringify(created.body)).toBe(201);
  return created.body.id as string;
}

const sendEvents = (ctx: TestContext, sessionId: string, events: unknown[]) =>
  request(ctx.app, 'POST', `/v1/sessions/${sessionId}/events`, { events });

const systemMessage = { type: 'system.message', content: [{ type: 'text', text: 'new constraint' }] };

describe('system.message model gate', () => {
  it('admits the event on a supported model', async () => {
    const ctx = context();
    const sessionId = await createSession(ctx, 'claude-opus-5');
    const attempt = await sendEvents(ctx, sessionId, [systemMessage]);
    expect(attempt.res.status, JSON.stringify(attempt.body)).toBe(200);
    expect(attempt.body.accepted).toBe(true);
  });

  it('rejects with model_does_not_support_mid_conversation_system on an unsupported model', async () => {
    const ctx = context();
    const sessionId = await createSession(ctx, 'gpt-4o');
    const attempt = await sendEvents(ctx, sessionId, [systemMessage]);
    expect(attempt.res.status).toBe(400);
    expect(attempt.body.error.code).toBe('model_does_not_support_mid_conversation_system');
  });

  it('rejects a known Claude model that is not on the supported list', async () => {
    const ctx = context();
    const sessionId = await createSession(ctx, 'claude-sonnet-4-5');
    const attempt = await sendEvents(ctx, sessionId, [systemMessage]);
    expect(attempt.res.status).toBe(400);
    expect(attempt.body.error.code).toBe('model_does_not_support_mid_conversation_system');
  });
});

describe('system.message requires_action ordering', () => {
  const setRequiresAction = (ctx: TestContext, sessionId: string) =>
    ctx.db.prepare(`UPDATE sessions SET status='requires_action' WHERE id=?`).run(sessionId);

  /** Seed a pending custom-tool call so a custom_tool_result can reference it. */
  const seedCustomToolUse = (ctx: TestContext, sessionId: string, blockId: string) =>
    ctx.sessionManager.getEventLogger().append(sessionId, {
      type: 'agent.custom_tool_use',
      content: [{ type: 'tool_use', id: blockId, name: 'lookup', input: { q: 'x' } }],
    });

  it('rejects a lone system.message while the session awaits a pending tool call', async () => {
    const ctx = context();
    const sessionId = await createSession(ctx, 'claude-opus-5');
    setRequiresAction(ctx, sessionId);
    const attempt = await sendEvents(ctx, sessionId, [systemMessage]);
    expect(attempt.res.status).toBe(400);
    expect(attempt.body.error.message).toContain('tool result');
  });

  it('rejects a system.message paired with a user.message, not a tool result', async () => {
    const ctx = context();
    const sessionId = await createSession(ctx, 'claude-opus-5');
    setRequiresAction(ctx, sessionId);
    const attempt = await sendEvents(ctx, sessionId, [
      { type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
      systemMessage,
    ]);
    expect(attempt.res.status).toBe(400);
    expect(attempt.body.error.message).toContain('tool result');
  });

  it('admits a system.message that trails a tool-answer event in the same request', async () => {
    const ctx = context();
    const sessionId = await createSession(ctx, 'claude-opus-5');
    seedCustomToolUse(ctx, sessionId, 'custom_call_1');
    setRequiresAction(ctx, sessionId);
    const attempt = await sendEvents(ctx, sessionId, [
      { type: 'user.custom_tool_result', custom_tool_use_id: 'custom_call_1', content: [{ type: 'text', text: '{"ok":true}' }] },
      systemMessage,
    ]);
    expect(attempt.res.status, JSON.stringify(attempt.body)).toBe(200);
  });

  it('admits a lone system.message when the session is not awaiting action', async () => {
    const ctx = context();
    const sessionId = await createSession(ctx, 'claude-opus-5');
    // queued/idle — no requires_action — so a lone system.message is fine.
    const attempt = await sendEvents(ctx, sessionId, [systemMessage]);
    expect(attempt.res.status, JSON.stringify(attempt.body)).toBe(200);
  });
});

describe('system.message content is text-only', () => {
  it('rejects a non-text block', async () => {
    const ctx = context();
    const sessionId = await createSession(ctx, 'claude-opus-5');
    const attempt = await sendEvents(ctx, sessionId, [
      { type: 'system.message', content: [{ type: 'image', source: { type: 'base64', data: 'aGk=' } }] },
    ]);
    expect(attempt.res.status).toBe(400);
    expect(attempt.body.error.message).toContain('text items only');
  });
});
