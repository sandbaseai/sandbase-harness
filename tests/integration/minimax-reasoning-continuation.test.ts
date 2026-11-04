import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { toApiEvent } from '@/api/standard.js';
import { ContextBuilder } from '@/core/session/context-builder.js';
import { ContextCompactor } from '@/core/session/context-compactor.js';
import { CompactionStore } from '@/core/session/compaction-store.js';
import { TransientReasoningStore } from '@/core/session/transient-reasoning.js';
import { eventsToMessages } from '@/core/session/events-to-messages.js';

const PRIVATE = 'PRIVATE-MINIMAX-REASONING-MUST-NOT-BE-PUBLIC';
const CALL = 'call_write';
function completion(model: string, first: boolean, malformed = false, interrupted = false) {
  const envelope = { id: 'completion', created: 0, model };
  const chunks: unknown[] = first ? [
    { ...envelope, ...(malformed ? { id: 123 } : {}), choices: [{ index: 0, delta: { reasoning_content: PRIVATE }, finish_reason: null }] },
    { ...envelope, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: CALL, type: 'function', function: { name: 'write', arguments: '{"path":"result.txt","content":"once"}' } }] }, finish_reason: null }] },
  ] : [{ ...envelope, choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] }];
  if (!interrupted) chunks.push({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } } });
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + (interrupted ? '' : 'data: [DONE]\n\n');
}

describe('MiniMax private continuation through the session executor', () => {
  let workspace: string;
  let db: Database;
  let manager: SessionManager;
  let executor: DefaultSessionExecutor;
  let registry: ModelRegistry;
  let requests: any[];
  let broadcasts: unknown[];

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ma-minimax-continuation-'));
    db = new Database(join(workspace, 'test.db')); db.runMigrations();
    db.exec("INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')");
    db.exec("INSERT INTO agents (id, name, definition) VALUES ('agent_write', 'writer', '{}')");
    manager = new SessionManager(db); registry = new ModelRegistry(); requests = []; broadcasts = [];
    manager.setBroadcastListener((event) => broadcasts.push(event));
  });
  afterEach(async () => { await manager.shutdown(); vi.unstubAllGlobals(); db.close(); rmSync(workspace, { recursive: true, force: true }); });

  function configure(model: string, ask: boolean, malformed = false, interrupted = false, custom = false) {
    registry.register({ name: 'default', provider: 'minimax', model, api_key: 'test-key', base_url: 'https://minimax.invalid/v1' });
    executor = new DefaultSessionExecutor({ agents: [{ name: 'writer', model, system: 'Use the write tool.', tools: custom ? [{ type: 'custom_toolset', configs: [{ name: 'write', description: 'Write externally', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }] }] : [{ type: 'agent_toolset_20260401', default_config: { enabled: false, permission_policy: { type: ask ? 'always_ask' : 'always_allow' } }, configs: [{ name: 'write', enabled: true }] }] }], modelRegistry: registry, sandboxProvider: new LocalSandboxProvider(workspace), strategy: new DefaultStrategy(), eventLogger: manager.getEventLogger() });
    manager.setExecutor(executor);
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); requests.push(body);
      return new Response(completion(model, requests.length === 1, malformed, interrupted), { headers: { 'content-type': 'text/event-stream' } });
    });
  }
  async function send(sessionId: string, text = 'write the file') {
    const before = requests.length;
    await manager.sendEvent(sessionId, { type: 'user.message', content: [{ type: 'text', text }] });
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(before));
    await vi.waitFor(() => expect(['paused', 'requires_action', 'failed']).toContain(manager.get(sessionId)?.status));
  }
  function publicData(sessionId: string) {
    const events = manager.getEventLogger().getEvents(sessionId);
    expect(JSON.stringify(events)).not.toContain(PRIVATE);
    expect(JSON.stringify(events.map(toApiEvent))).not.toContain(PRIVATE);
    expect(JSON.stringify(broadcasts)).not.toContain(PRIVATE);
    return events;
  }

  it.each(['MiniMax-M3', 'MiniMax-M3.1-Flash'].flatMap((model) => [false, true].map((ask) => ({ model, ask }))))
    ('$model retains private reasoning across approval=$ask and later user turns', async ({ model, ask }) => {
      configure(model, ask);
      const session = manager.create({ agent: 'agent_write' });
      await send(session.id);
      if (ask) {
        expect(manager.get(session.id)?.status).toBe('requires_action');
        await manager.sendEvent(session.id, { type: 'user.tool_confirmation', tool_use_id: CALL, result: 'allow' });
        await vi.waitFor(() => expect(manager.get(session.id)?.status).toBe('paused'));
        await expect(manager.sendEvent(session.id, { type: 'user.tool_confirmation', tool_use_id: CALL, result: 'allow' })).rejects.toThrow('not awaiting approval');
      }
      expect(readFileSync(join(workspace, 'sandbox', session.id, 'result.txt'), 'utf8')).toBe('once');
      expect(requests).toHaveLength(2);
      expect(requests[1].messages.find((message: any) => message.role === 'assistant').reasoning_content).toBe(PRIVATE);
      await send(session.id, 'thank you');
      expect(requests).toHaveLength(3);
      expect(requests[2].messages.find((message: any) => message.role === 'assistant').reasoning_content).toBe(PRIVATE);
      const events = publicData(session.id);
      expect(events.filter((event) => event.type === 'span.model_request_end')).toHaveLength(3);
      expect(events.filter((event) => event.type === 'agent.tool_result')).toHaveLength(1);
      expect(manager.get(session.id)?.usage).toEqual({ tokensIn: 21, tokensOut: 12, cacheReadTokens: 9, cacheWriteTokens: 0 });
      const other = manager.create({ agent: 'agent_write' }); await send(other.id, 'hello');
      expect(JSON.stringify(requests[3])).not.toContain(PRIVATE);
      // Endpoint change invalidates replay even when the provider/model ID is unchanged.
      registry.register({ name: 'default', provider: 'minimax', model, api_key: 'test-key', base_url: 'https://another.invalid/v1' });
      await send(session.id, 'new endpoint');
      expect(JSON.stringify(requests[4])).not.toContain(PRIVATE);
    });

  it('retains private replay across a custom tool result and clears it on cleanup', async () => {
    configure('MiniMax-M3.1-Flash', false, false, false, true);
    const session = manager.create({ agent: 'agent_write' }); await send(session.id);
    expect(manager.get(session.id)?.status).toBe('requires_action');
    const call = publicData(session.id).find((event) => event.type === 'agent.custom_tool_use')!;
    const answer = { type: 'user.custom_tool_result' as const, custom_tool_use_id: call.id, content: [{ type: 'text' as const, text: 'written' }] };
    await manager.sendEvent(session.id, answer);
    await vi.waitFor(() => expect(manager.get(session.id)?.status).toBe('paused'));
    expect(requests[1].messages.find((message: any) => message.role === 'assistant').reasoning_content).toBe(PRIVATE);
    expect(requests[1].messages.find((message: any) => message.role === 'tool').tool_call_id).toBe(CALL);
    await expect(manager.sendEvent(session.id, answer)).rejects.toThrow('not pending');
    publicData(session.id);
    await executor.cleanupSession(session.id);
    await send(session.id, 'continue after cleanup');
    expect(JSON.stringify(requests[2])).not.toContain(PRIVATE);
  });

  it.each([{ malformed: true, interrupted: false }, { malformed: false, interrupted: true }])
    ('refuses invalid stream authority and keeps errors private: %o', async ({ malformed, interrupted }) => {
      configure('MiniMax-M3.1-Flash', true, malformed, interrupted);
      const session = manager.create({ agent: 'agent_write' }); await send(session.id);
      const events = publicData(session.id);
      expect(events.filter((event) => event.type === 'agent.tool_use')).toHaveLength(0);
      expect(manager.get(session.id)?.status).not.toBe('requires_action');
      await expect(manager.sendEvent(session.id, { type: 'user.tool_confirmation', tool_use_id: CALL, result: 'allow' })).rejects.toThrow('terminal state: failed');
    });

  it('refuses confirmation for duplicate keys in raw MiniMax tool arguments', async () => {
    configure('MiniMax-M3.1-Flash', true);
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      const body = completion('MiniMax-M3.1-Flash', requests.length === 1).replace(
        JSON.stringify('{"path":"result.txt","content":"once"}'),
        JSON.stringify('{"path":"result.txt","path":"other.txt","content":"once"}'),
      );
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const session = manager.create({ agent: 'agent_write' }); await send(session.id);
    expect(publicData(session.id).filter((event) => event.type === 'agent.tool_use')).toHaveLength(0);
    expect(manager.get(session.id)?.status).not.toBe('requires_action');
    await expect(manager.sendEvent(session.id, { type: 'user.tool_confirmation', tool_use_id: CALL, result: 'allow' })).rejects.toThrow(/not awaiting approval|terminal state/);
  });

  it.each(['rate_limit', 'interrupt'])('preserves a completed tool step when the next request ends with %s', async (failure) => {
    configure('MiniMax-M3.1-Flash', false);
    let failNext = true;
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      if (requests.length > 1 && failNext) {
        if (failure === 'rate_limit') return Response.json({ error: { message: PRIVATE } }, { status: 429, headers: { 'retry-after': '0' } });
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException('Aborted', 'AbortError'));
          if (init.signal?.aborted) abort();
          else init.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return new Response(completion('MiniMax-M3.1-Flash', requests.length === 1), { headers: { 'content-type': 'text/event-stream' } });
    });
    const session = manager.create({ agent: 'agent_write' });
    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'write the file' }] });
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(1));
    if (failure === 'interrupt') await manager.sendEvent(session.id, { type: 'user.interrupt' });
    await vi.waitFor(() => expect(manager.get(session.id)?.status).toBe('paused'));
    const before = publicData(session.id);
    expect(before.filter((event) => event.type === 'agent.tool_result')).toHaveLength(1);
    expect(manager.get(session.id)?.usage).toEqual({ tokensIn: 7, tokensOut: 4, cacheReadTokens: 3, cacheWriteTokens: 0 });
    expect(requests).toHaveLength(failure === 'rate_limit' ? 5 : 2);
    failNext = false;
    await send(session.id, 'continue');
    expect(requests.at(-1).messages.find((message: any) => message.role === 'assistant').reasoning_content).toBe(PRIVATE);
    const after = publicData(session.id);
    expect(after.filter((event) => event.type === 'agent.tool_result')).toHaveLength(1);
    expect(manager.get(session.id)?.usage).toEqual({ tokensIn: 14, tokensOut: 8, cacheReadTokens: 6, cacheWriteTokens: 0 });
  });

  it.each([false, true])('budgets private reasoning without sending it to the summarizer, legacy=%s', async (legacy) => {
    const session = manager.create({ agent: 'agent_write' });
    const logger = manager.getEventLogger();
    logger.append(session.id, { type: 'user.message', content: [{ type: 'text', text: 'old question' }] });
    const old = logger.append(session.id, { type: 'agent.thinking', metadata: { signal: 'reasoning' } });
    logger.append(session.id, { type: 'agent.message', content: [{ type: 'text', text: 'old answer' }] });
    logger.append(session.id, { type: 'user.message', content: [{ type: 'text', text: 'current question' }] });
    const live = logger.append(session.id, { type: 'agent.thinking', metadata: { signal: 'reasoning' } });
    const replay = new TransientReasoningStore().forSession(session.id, 'scope');
    replay.remember(old.id, PRIVATE.repeat(30));
    replay.remember(live.id, 'PRIVATE-LIVE');
    const prompts: unknown[] = [];
    const model = {
      specificationVersion: 'v4' as const, modelId: 'test', provider: 'minimax.chat', supportedUrls: {},
      async doGenerate(params: unknown) {
        prompts.push(params);
        return { content: [{ type: 'text' as const, text: 'public summary' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] };
      },
      async doStream() { throw new Error('unused'); },
    };
    const compactor = new ContextCompactor({ contextWindowTokens: 400, preserveBudgetTokens: 100 });
    expect(compactor.shouldCompact(eventsToMessages(logger.getEvents(session.id)))).toBe(false);
    const builder = new ContextBuilder({ eventLogger: logger, compactor, compactionStore: legacy ? undefined : new CompactionStore(db) });
    const context = await builder.build(session, { name: 'writer', model: 'test', system: 'test' }, { type: 'user.message', content: [{ type: 'text', text: 'current question' }] }, model, (event) => broadcasts.push(event), { transientReasoning: replay });
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts)).toContain('old answer');
    expect(JSON.stringify(prompts)).not.toContain('PRIVATE');
    expect(replay.get(old.id)).toBeUndefined();
    expect(replay.get(live.id)).toBe(legacy ? undefined : 'PRIVATE-LIVE');
    expect(JSON.stringify(context.messages)).toContain('public summary');
    expect(JSON.stringify(context.messages)).not.toContain(PRIVATE);
    if (!legacy) expect(JSON.stringify(context.messages)).toContain('PRIVATE-LIVE');
    publicData(session.id);
  });
});
