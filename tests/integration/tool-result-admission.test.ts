import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { issueSessionWorkToken } from '@/core/auth/session-work-tokens.js';
import { WorkQueue } from '@/sandbox/self-hosted-provider.js';
import type { UserEvent } from '@/types/cma-protocol.js';

const contexts: Array<{ db: Database; dir: string }> = [];
afterEach(() => {
  for (const { db, dir } of contexts.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup(provider: 'local' | 'self-hosted') {
  const dir = mkdtempSync(join(tmpdir(), 'ma-tool-result-'));
  const db = new Database(join(dir, 'test.db'));
  contexts.push({ db, dir });
  db.runMigrations();
  db.prepare("INSERT INTO environments (id, name, config) VALUES ('env_test', 'test', ?)")
    .run(JSON.stringify({ sandbox_provider: provider }));
  db.exec("INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'test', '{}')");
  for (const id of ['sess_test', 'sess_other']) {
    db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id, status) VALUES (?, 'agent_test', 'test', 'env_test', 'paused')").run(id);
  }
  const manager = new SessionManager(db);
  const execute = vi.fn(async function* () {});
  manager.setExecutor({ execute });
  const queue = new WorkQueue(db);
  const item = queue.enqueue('sess_test', 'exec', { command: 'echo test' });
  queue.claim('worker_test', 'sess_test');
  queue.accept(item, 'worker_test');
  const app = createServer({ db, sessionManager: manager, agents: [], reloadAgents: () => ({ agents: [], errors: [] }), workQueue: queue, apiKeys: ['operator-test-key'] });
  const token = issueSessionWorkToken(db, 'sess_test', 'env_test');
  const client = (credential: string) => new Anthropic({
    baseURL: 'http://runtime.test', apiKey: null, authToken: credential, maxRetries: 0,
    fetch: async (input, init) => app.request(input instanceof Request ? input : String(input), init),
  });
  const state = () => ({
    events: db.prepare('SELECT * FROM events ORDER BY rowid').all(),
    sessions: db.prepare('SELECT * FROM sessions ORDER BY id').all(),
    work: db.prepare('SELECT * FROM work_items ORDER BY id').all(),
  });
  return { manager, execute, client, token, state };
}

const answer = { type: 'user.tool_result' as const, tool_use_id: 'sevt_unissued', content: [{ type: 'text' as const, text: 'done' }] };
const refusal = { status: 400, error: { error: { type: 'invalid_request_error', code: 'self_hosted_tool_result_not_supported' } } };

describe('unsupported official tool-result admission', () => {
  it.each(['local', 'self-hosted'] as const)('refuses official SDK and direct results without effects on %s', async (provider) => {
    const ctx = setup(provider);
    const before = ctx.state();
    for (const credential of ['operator-test-key', ctx.token]) {
      await expect(ctx.client(credential).beta.sessions.events.send('sess_test', { events: [answer] })).rejects.toMatchObject(refusal);
    }
    // Exercise the runtime boundary despite the intentionally unsupported TS union.
    await expect(ctx.manager.sendEvent('sess_test', answer as unknown as UserEvent)).rejects.toMatchObject({ code: 'self_hosted_tool_result_not_supported' });
    expect(ctx.state()).toEqual(before);
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it('preflights the entire batch and preserves worker permission fences', async () => {
    const ctx = setup('self-hosted');
    const pending = ctx.manager.getEventLogger().append('sess_test', {
      type: 'agent.custom_tool_use',
      content: [{ type: 'tool_use', id: 'call_custom', name: 'lookup', input: {} }],
    });
    const before = ctx.state();
    const message = { type: 'user.message' as const, content: [{ type: 'text' as const, text: 'must not run' }] };
    await expect(ctx.client('operator-test-key').beta.sessions.events.send('sess_test', { events: [message, answer] })).rejects.toMatchObject(refusal);
    const customAnswer = { type: 'user.custom_tool_result' as const, custom_tool_use_id: pending.id, content: answer.content };
    await expect(ctx.client(ctx.token).beta.sessions.events.send('sess_test', { events: [customAnswer, answer] })).rejects.toMatchObject(refusal);
    await expect(ctx.client(ctx.token).beta.sessions.events.send('sess_other', { events: [answer] })).rejects.toMatchObject({ status: 401 });
    await expect(ctx.client(ctx.token).beta.sessions.events.send('sess_test', { events: [message, answer] })).rejects.toMatchObject({ status: 403 });
    expect(ctx.state()).toEqual(before);
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it('cannot use a result to bypass a pending built-in approval or retry acceptance', async () => {
    const ctx = setup('self-hosted');
    const pending = ctx.manager.getEventLogger().append('sess_test', {
      type: 'agent.tool_use',
      content: [{ type: 'tool_use', id: 'call_gated', name: 'bash', input: { command: 'echo test' }, requires_confirmation: true }],
    });
    const before = ctx.state();
    for (const reference of [pending.id, 'call_gated', pending.id]) {
      await expect(ctx.client(ctx.token).beta.sessions.events.send('sess_test', {
        events: [{ ...answer, tool_use_id: reference }],
      })).rejects.toMatchObject(refusal);
    }
    expect(ctx.state()).toEqual(before);
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it('refuses malformed results before recording their unvalidated payload', async () => {
    const ctx = setup('self-hosted');
    const before = ctx.state();
    for (const event of [{ type: 'user.tool_result' }, { ...answer, tool_use_id: 12, is_error: 'false', content: 'invalid' }]) {
      await expect(ctx.manager.sendEvent('sess_test', event as unknown as UserEvent)).rejects.toMatchObject({ code: 'self_hosted_tool_result_not_supported' });
    }
    expect(ctx.state()).toEqual(before);
    expect(ctx.execute).not.toHaveBeenCalled();
  });
});
