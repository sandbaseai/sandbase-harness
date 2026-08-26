import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LanguageModelV1 } from 'ai';
import { Database } from '@/core/db/database.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { createAiSdkV4ExecutionGuard } from '@/strategy/ai-sdk-v4-execution-guard.js';
import type { EnvironmentConfig, SandboxInstance } from '@/types/sandbox.js';

type ToolStream = {
  finishReason: 'stop' | 'length' | 'tool-calls';
  toolName?: string;
  args: string;
  rawArgs?: string;
  rawLifecycle?: boolean;
};

function scriptedToolModel(script: ToolStream): LanguageModelV1 {
  let turn = 0;

  return {
    specificationVersion: 'v1',
    provider: 'test',
    modelId: 'scripted-tool-call',
    async doGenerate() {
      throw new Error('not used');
    },
    async doStream() {
      turn += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            if (turn === 1) {
              if (script.rawLifecycle !== false) {
                controller.enqueue({
                  type: 'tool-call-delta',
                  toolCallType: 'function',
                  toolCallId: 'call_write_1',
                  toolName: script.toolName ?? 'write',
                  argsTextDelta: script.rawArgs ?? script.args,
                });
              }
              controller.enqueue({
                type: 'tool-call',
                toolCallType: 'function',
                toolCallId: 'call_write_1',
                toolName: script.toolName ?? 'write',
                args: script.args,
              });
              controller.enqueue({
                type: 'finish',
                finishReason: script.finishReason,
                usage: { promptTokens: 1, completionTokens: 1 },
              });
            } else {
              controller.enqueue({ type: 'text-delta', textDelta: 'continued' });
              controller.enqueue({
                type: 'finish',
                finishReason: 'stop',
                usage: { promptTokens: 1, completionTokens: 1 },
              });
            }
            controller.close();
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      } as any;
    },
  } as unknown as LanguageModelV1;
}

class CountingLocalSandboxProvider extends LocalSandboxProvider {
  writeCount = 0;
  writes: Array<{ path: string; content: string }> = [];

  override async provision(sessionId: string, config: EnvironmentConfig): Promise<SandboxInstance> {
    const sandbox = await super.provision(sessionId, config);
    const provider = this;
    return new Proxy(sandbox, {
      get(target, property, receiver) {
        if (property === 'writeFile') {
          return async (path: string, content: string) => {
            provider.writeCount += 1;
            provider.writes.push({ path, content });
            return target.writeFile(path, content);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}

type Harness = {
  manager: SessionManager;
  db: Database;
  workspace: string;
  sandboxProvider: CountingLocalSandboxProvider;
};

const harnesses: Harness[] = [];

function createHarness(script: ToolStream): Harness {
  const workspace = mkdtempSync(join(tmpdir(), 'ma-confirm-reliability-'));
  const db = new Database(join(workspace, 'test.db'));
  db.runMigrations();
  db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
  db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_write', 'write-agent', '{}')`);

  const manager = new SessionManager(db);
  const modelRegistry = new ModelRegistry();
  const model = scriptedToolModel(script);
  (modelRegistry as any).createModel = () => model;
  const sandboxProvider = new CountingLocalSandboxProvider(workspace);
  manager.setExecutor(new DefaultSessionExecutor({
    agents: [{
      name: 'write-agent',
      model: 'test',
      system: 'Use the write tool.',
      tools: [{
        type: 'agent_toolset_20260401',
        default_config: {
          enabled: true,
          permission_policy: { type: 'always_allow' },
        },
        configs: [{
          name: 'write',
          enabled: true,
          permission_policy: { type: 'always_ask' },
        }],
      }],
    }],
    modelRegistry,
    sandboxProvider,
    strategy: new DefaultStrategy(),
    eventLogger: manager.getEventLogger(),
  }));

  const harness = { manager, db, workspace, sandboxProvider };
  harnesses.push(harness);
  return harness;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for session state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function requestToolCall(harness: Harness): Promise<string> {
  const session = harness.manager.create({ agent: 'agent_write' });
  await harness.manager.sendEvent(session.id, {
    type: 'user.message',
    content: [{ type: 'text', text: 'write the file' }],
  } as any);
  return session.id;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.db.close();
    rmSync(harness.workspace, { recursive: true, force: true });
  }
});

describe('tool confirmation stream reliability', () => {
  it('executes a safely completed, schema-valid call exactly once after confirmation', async () => {
    const harness = createHarness({
      finishReason: 'tool-calls',
      args: JSON.stringify({ path: 'safe.txt', content: 'safe' }),
    });
    const sessionId = await requestToolCall(harness);
    await waitFor(() => harness.manager.get(sessionId)?.status === 'requires_action');

    const projectedCalls = harness.manager.getEventLogger().getEvents(sessionId)
      .filter((event) => event.type === 'agent.tool_use');
    expect(projectedCalls).toHaveLength(1);
    expect(harness.sandboxProvider.writeCount).toBe(0);

    const confirmation = {
      type: 'user.tool_confirmation',
      tool_use_id: 'call_write_1',
      result: 'allow',
    } as const;
    await harness.manager.sendEvent(sessionId, confirmation as any);
    await waitFor(() => harness.sandboxProvider.writeCount === 1);
    await waitFor(() => harness.manager.get(sessionId)?.status === 'paused');

    await harness.manager.sendEvent(sessionId, confirmation as any);
    await waitFor(() => harness.manager.get(sessionId)?.status === 'paused');
    expect(harness.sandboxProvider.writeCount).toBe(1);
  });

  it('does not persist or execute a call from a length-limited stream', async () => {
    const harness = createHarness({
      finishReason: 'length',
      args: JSON.stringify({ path: 'length.txt', content: 'incomplete turn' }),
    });
    const sessionId = await requestToolCall(harness);
    await waitFor(() => harness.manager.get(sessionId)?.status === 'paused');

    const projectedCalls = harness.manager.getEventLogger().getEvents(sessionId)
      .filter((event) => event.type === 'agent.tool_use');
    expect(projectedCalls).toHaveLength(0);
    expect(harness.sandboxProvider.writeCount).toBe(0);
  });

  it('does not execute malformed JSON', async () => {
    const harness = createHarness({ finishReason: 'tool-calls', args: '{"path":' });
    const sessionId = await requestToolCall(harness);
    await waitFor(() => harness.manager.get(sessionId)?.status === 'failed');

    expect(harness.manager.getEventLogger().getEvents(sessionId)
      .filter((event) => event.type === 'agent.tool_use')).toHaveLength(0);
    expect(harness.sandboxProvider.writeCount).toBe(0);
  });

  it('does not persist or execute schema-invalid input', async () => {
    const harness = createHarness({
      finishReason: 'tool-calls',
      args: JSON.stringify({ path: 'missing-content.txt' }),
    });
    const sessionId = await requestToolCall(harness);
    await waitFor(() => harness.manager.get(sessionId)?.status === 'paused');

    expect(harness.manager.getEventLogger().getEvents(sessionId)
      .filter((event) => event.type === 'agent.tool_use')).toHaveLength(0);
    expect(harness.sandboxProvider.writeCount).toBe(0);
  });

  it('does not execute an unknown tool call', async () => {
    const harness = createHarness({
      finishReason: 'tool-calls',
      toolName: 'unknown_tool',
      args: '{}',
    });
    const sessionId = await requestToolCall(harness);
    await waitFor(() => harness.manager.get(sessionId)?.status === 'failed');

    expect(harness.sandboxProvider.writeCount).toBe(0);
  });

  it('does not trust a parsed projection when the raw lifecycle is missing', async () => {
    const harness = createHarness({
      finishReason: 'tool-calls',
      args: JSON.stringify({ path: 'projection-only.txt', content: 'projection' }),
      rawLifecycle: false,
    });
    const sessionId = await requestToolCall(harness);
    await waitFor(() => harness.manager.get(sessionId)?.status === 'paused');

    expect(harness.manager.getEventLogger().getEvents(sessionId)
      .filter((event) => event.type === 'agent.tool_use')).toHaveLength(0);
    expect(harness.sandboxProvider.writeCount).toBe(0);
  });

  it('executes raw arguments rather than a conflicting parsed projection', async () => {
    const rawArgs = JSON.stringify({ path: 'raw.txt', content: 'raw' });
    const harness = createHarness({
      finishReason: 'tool-calls',
      rawArgs,
      args: JSON.stringify({ path: 'projection.txt', content: 'projection' }),
    });
    const sessionId = await requestToolCall(harness);
    await waitFor(() => harness.manager.get(sessionId)?.status === 'requires_action');

    const toolUse = harness.manager.getEventLogger().getEvents(sessionId)
      .find((event) => event.type === 'agent.tool_use');
    expect((toolUse?.content?.[0] as any)?.input).toEqual(JSON.parse(rawArgs));

    await harness.manager.sendEvent(sessionId, {
      type: 'user.tool_confirmation',
      tool_use_id: 'call_write_1',
      result: 'allow',
    } as any);
    await waitFor(() => harness.sandboxProvider.writeCount === 1);
    expect(harness.sandboxProvider.writes).toEqual([
      { path: 'raw.txt', content: 'raw' },
    ]);
  });

  it('provides one-shot authority and rejects duplicate raw identity', () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    };
    const guard = createAiSdkV4ExecutionGuard({ schemas: { write: schema } });
    const args = JSON.stringify({ path: 'once.txt', content: 'once' });
    guard.push({ type: 'tool-call-streaming-start', toolCallId: 'once', toolName: 'write' });
    guard.push({ type: 'tool-call-delta', toolCallId: 'once', toolName: 'write', argsTextDelta: args });
    guard.push({ type: 'tool-call', toolCallId: 'once', toolName: 'write', args: JSON.parse(args) });
    guard.push({ type: 'finish', finishReason: 'tool-calls' });

    const decision = guard.finish().decisions[0];
    expect(decision.action).toBe('execute');
    expect(guard.takeDecision(decision.internalId)?.value).toEqual(JSON.parse(args));
    expect(guard.takeDecision(decision.internalId)).toBeUndefined();

    const duplicate = createAiSdkV4ExecutionGuard({ schemas: { write: schema } });
    for (let index = 0; index < 2; index += 1) {
      duplicate.push({ type: 'tool-call-streaming-start', toolCallId: 'duplicate', toolName: 'write' });
      duplicate.push({ type: 'tool-call-delta', toolCallId: 'duplicate', toolName: 'write', argsTextDelta: args });
      duplicate.push({ type: 'tool-call', toolCallId: 'duplicate', toolName: 'write', args: JSON.parse(args) });
    }
    duplicate.push({ type: 'finish', finishReason: 'tool-calls' });
    const duplicateResult = duplicate.finish();
    expect(duplicateResult.decisions.every((item) => item.action !== 'execute')).toBe(true);
  });
});
