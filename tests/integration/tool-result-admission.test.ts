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
  return { db, manager, execute, client, token, state };
}

/**
 * Persist a builtin `agent.tool_use` the way the self-hosted strategy emits it:
 * parked for a worker, carrying `awaiting_tool_result`. This is the only call a
 * `user.tool_result` may answer.
 */
function parkWorkerCall(manager: SessionManager, sessionId: string, blockId = 'call_worker') {
  return manager.getEventLogger().append(sessionId, {
    type: 'agent.tool_use',
    content: [{ type: 'tool_use', id: blockId, name: 'bash', input: { command: 'echo hi' } }],
    metadata: { awaiting_tool_result: true },
  });
}

const result = (ref: string) => ({ type: 'user.tool_result' as const, tool_use_id: ref, content: [{ type: 'text' as const, text: 'done' }] });
const notPending = { status: 400, error: { error: { type: 'invalid_request_error', code: 'tool_result_not_pending' } } };
const invalid = { status: 400, error: { error: { type: 'invalid_request_error', code: 'tool_result_invalid' } } };

describe('official tool-result admission on self-hosted', () => {
  it('accepts a worker answer to a call parked for it, by event or block id', async () => {
    const ctx = setup('self-hosted');
    for (const [blockId, reference] of [['call_a', 'call_a'], ['call_b', 'use_event_id']] as const) {
      const use = parkWorkerCall(ctx.manager, 'sess_test', blockId);
      const toolUseId = reference === 'use_event_id' ? use.id : reference;
      await ctx.client(ctx.token).beta.sessions.events.send('sess_test', { events: [result(toolUseId)] });
    }
    const answers = ctx.manager.getEventLogger().getEvents('sess_test')
      .filter((event) => event.type === 'user.tool_result');
    expect(answers).toHaveLength(2);
    // The block id is what is persisted on the answer — the event-id spelling
    // resolved to the same parked call.
    expect(answers.map((a) => a.metadata?.tool_use_id).sort()).toEqual(['call_a', 'call_b']);
  });

  it('refuses an answer for a call that was never issued', async () => {
    const ctx = setup('self-hosted');
    const before = ctx.state();
    await expect(ctx.client(ctx.token).beta.sessions.events.send('sess_test', { events: [result('sevt_unissued')] }))
      .rejects.toMatchObject(notPending);
    await expect(ctx.manager.sendEvent('sess_test', result('sevt_unissued') as unknown as UserEvent))
      .rejects.toMatchObject({ code: 'tool_result_not_pending' });
    expect(ctx.state()).toEqual(before);
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it('refuses an answer for a call the runtime ran itself', async () => {
    const ctx = setup('self-hosted');
    // A builtin call with no awaiting_tool_result marker is runtime-executed —
    // a worker result for it is refused because the call is not parked.
    ctx.manager.getEventLogger().append('sess_test', {
      type: 'agent.tool_use',
      content: [{ type: 'tool_use', id: 'call_ran', name: 'bash', input: { command: 'echo hi' } }],
    });
    const before = ctx.state();
    for (const reference of ['call_ran', 'call_ran']) {
      await expect(ctx.client(ctx.token).beta.sessions.events.send('sess_test', { events: [result(reference)] }))
        .rejects.toMatchObject(notPending);
    }
    expect(ctx.state()).toEqual(before);
  });

  it('refuses an answer for a confirmation-gated call', async () => {
    const ctx = setup('self-hosted');
    ctx.manager.getEventLogger().append('sess_test', {
      type: 'agent.tool_use',
      content: [{ type: 'tool_use', id: 'call_gated', name: 'bash', input: { command: 'echo hi' }, requires_confirmation: true }],
    });
    const before = ctx.state();
    await expect(ctx.client(ctx.token).beta.sessions.events.send('sess_test', { events: [result('call_gated')] }))
      .rejects.toMatchObject(notPending);
    expect(ctx.state()).toEqual(before);
  });

  it('refuses a second answer to a call already resolved', async () => {
    const ctx = setup('self-hosted');
    const use = parkWorkerCall(ctx.manager, 'sess_test');
    await ctx.client(ctx.token).beta.sessions.events.send('sess_test', { events: [result(use.id)] });
    const before = ctx.state();
    // A second answer — to either spelling — is refused by the same not-pending
    // check, because the first answer already resolved the parked call.
    for (const reference of [use.id, 'call_worker']) {
      await expect(ctx.client(ctx.token).beta.sessions.events.send('sess_test', { events: [result(reference)] }))
        .rejects.toMatchObject(notPending);
    }
    const answers = ctx.manager.getEventLogger().getEvents('sess_test')
      .filter((event) => event.type === 'user.tool_result');
    expect(answers).toHaveLength(1);
    expect(ctx.state().events.length).toBe(before.events.length);
  });

  it('refuses an answer for a foreign session, a malformed result, and preserves worker fences', async () => {
    const ctx = setup('self-hosted');
    const use = parkWorkerCall(ctx.manager, 'sess_test');
    // A worker token bound to sess_test cannot answer on sess_other's log.
    await expect(ctx.client(ctx.token).beta.sessions.events.send('sess_other', { events: [result(use.id)] }))
      .rejects.toMatchObject({ status: 401 });
    // Malformed bodies are refused by name before any session lookup matters.
    for (const bad of [{ type: 'user.tool_result' }, { ...result(use.id), tool_use_id: 12, is_error: 'false', content: 'invalid' }]) {
      await expect(ctx.manager.sendEvent('sess_test', bad as unknown as UserEvent))
        .rejects.toMatchObject({ code: 'tool_result_invalid' });
    }
    const answers = ctx.manager.getEventLogger().getEvents('sess_test')
      .filter((event) => event.type === 'user.tool_result');
    expect(answers).toHaveLength(0);
  });

  it('still refuses the result on a non-self-hosted session — no parked call exists to answer', async () => {
    const ctx = setup('local');
    const before = ctx.state();
    // On a local backend builtin calls run in-process, so nothing is ever
    // parked for a worker and every tool_result id is unissued.
    await expect(ctx.client('operator-test-key').beta.sessions.events.send('sess_test', { events: [result('call_any')] }))
      .rejects.toMatchObject(notPending);
    expect(ctx.state()).toEqual(before);
    expect(ctx.execute).not.toHaveBeenCalled();
  });
});
