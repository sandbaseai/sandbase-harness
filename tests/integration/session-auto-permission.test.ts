/**
 * Integration test: the `auto` permission policy.
 *
 * A tool declared `permission_policy: {type: 'auto'}` keeps its executor and
 * is judged per invocation by a model evaluator plugged into the AI SDK's
 * `needsApproval` gate:
 *
 * - `allow` executes the call and records `evaluated_permission: "allow"`.
 * - `deny` never executes: the model reads a synthetic error tool_result and
 *   the event records `evaluated_permission: "deny"`.
 * - `ask` parks the call through the same `user.tool_confirmation` path an
 *   `always_ask` tool takes — including every evaluator failure, which must
 *   degrade to the approval gate and never to silent execution.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LanguageModel } from 'ai';
import { Database } from '@/core/db/database.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import type { EnvironmentConfig, SandboxInstance } from '@/types/sandbox.js';

type ScriptedCall = { id: string; toolName?: string; args: string };

type Script = {
  calls: ScriptedCall[];
  /**
   * The judge's answer per evaluation. The evaluator prompt embeds the tool
   * name and input, so a script can key the verdict off the call itself.
   */
  judge: (prompt: string) => string | Error;
};

const USAGE = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const JUDGE_USAGE = { inputTokens: { total: 5 }, outputTokens: { total: 3 } };

function scriptedModel(script: Script): LanguageModel {
  let turn = 0;

  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'scripted-tool-call',
    supportedUrls: {},
    // The evaluator's `generateText` is the only doGenerate caller in a turn.
    async doGenerate(options: any) {
      const answer = script.judge(JSON.stringify(options?.prompt ?? []));
      if (answer instanceof Error) throw answer;
      return {
        content: [{ type: 'text', text: answer }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: JUDGE_USAGE,
        warnings: [],
      } as any;
    },
    async doStream() {
      turn += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            if (turn === 1) {
              for (const call of script.calls) {
                const toolName = call.toolName ?? 'write';
                controller.enqueue({ type: 'tool-input-start', id: call.id, toolName });
                controller.enqueue({ type: 'tool-input-delta', id: call.id, delta: call.args });
                controller.enqueue({ type: 'tool-input-end', id: call.id });
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: call.id,
                  toolName,
                  input: call.args,
                });
              }
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
                usage: USAGE,
              });
            } else {
              controller.enqueue({ type: 'text-start', id: 'txt_1' });
              controller.enqueue({ type: 'text-delta', id: 'txt_1', delta: 'continued' });
              controller.enqueue({ type: 'text-end', id: 'txt_1' });
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: USAGE,
              });
            }
            controller.close();
          },
        }),
      } as any;
    },
  } as unknown as LanguageModel;
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

function createHarness(script: Script): Harness {
  const workspace = mkdtempSync(join(tmpdir(), 'ma-auto-permission-'));
  const db = new Database(join(workspace, 'test.db'));
  db.runMigrations();
  db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
  db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_auto', 'auto-agent', '{}')`);

  const manager = new SessionManager(db);
  const modelRegistry = new ModelRegistry();
  const model = scriptedModel(script);
  (modelRegistry as any).createModel = () => model;
  const sandboxProvider = new CountingLocalSandboxProvider(workspace);
  manager.setExecutor(new DefaultSessionExecutor({
    agents: [{
      name: 'auto-agent',
      model: 'test',
      system: 'Use the write tool.',
      tools: [{
        type: 'agent_toolset_20260401',
        default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
        configs: [{
          name: 'write',
          enabled: true,
          permission_policy: { type: 'auto' },
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

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for session state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function requestToolCall(harness: Harness): Promise<string> {
  const session = harness.manager.create({ agent: 'agent_auto' });
  await harness.manager.sendEvent(session.id, {
    type: 'user.message',
    content: [{ type: 'text', text: 'write the file' }],
  } as any);
  return session.id;
}

function toolUseEvents(harness: Harness, sessionId: string) {
  return harness.manager.getEventLogger().getEvents(sessionId)
    .filter((event) => event.type === 'agent.tool_use');
}

function toolResultEvents(harness: Harness, sessionId: string) {
  return harness.manager.getEventLogger().getEvents(sessionId)
    .filter((event) => event.type === 'agent.tool_result');
}

const allowAll = () => '{"decision":"allow"}';
const writeCall = (id: string, path: string): ScriptedCall => ({
  id,
  args: JSON.stringify({ path, content: `content of ${path}` }),
});

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.db.close();
    rmSync(harness.workspace, { recursive: true, force: true });
  }
});

describe('auto permission — allow', () => {
  it('executes an allowed call exactly once and records the verdict', async () => {
    const harness = createHarness({ calls: [writeCall('call_1', 'note.txt')], judge: allowAll });
    const sessionId = await requestToolCall(harness);
    await waitFor(() => harness.manager.get(sessionId)?.status === 'paused');

    expect(harness.sandboxProvider.writes).toEqual([
      { path: 'note.txt', content: 'content of note.txt' },
    ]);
    const [use] = toolUseEvents(harness, sessionId);
    expect(use.metadata).toMatchObject({
      permission: 'auto',
      evaluated_permission: 'allow',
      evaluation: { type: 'auto', evaluated_permission: 'allow' },
    });
    expect((use.content?.[0] as any).requires_confirmation).toBeUndefined();
    // A completed call is paired with a non-error result.
    const [result] = toolResultEvents(harness, sessionId);
    expect((result.content?.[0] as any).is_error).toBeFalsy();
  });

  it('joins the judge request into the session usage aggregate', async () => {
    const harness = createHarness({ calls: [writeCall('call_1', 'note.txt')], judge: allowAll });
    const sessionId = await requestToolCall(harness);
    await waitFor(() => harness.manager.get(sessionId)?.status === 'paused');

    const row = harness.db
      .prepare(`SELECT usage_tokens_in AS tin, usage_tokens_out AS tout FROM sessions WHERE id = ?`)
      .get(sessionId) as { tin: number; tout: number };
    // Two agent steps (the tool call, then the continuation after its
    // result) plus the judge's 5/3: the evaluation is a model request and
    // must be accounted like one.
    expect(row.tin).toBe(1 + 1 + 5);
    expect(row.tout).toBe(1 + 1 + 3);
  });
});

describe('auto permission — deny', () => {
  it('never executes, answers the model with an error result, and records deny', async () => {
    const harness = createHarness({
      calls: [writeCall('call_1', 'secret.txt')],
      judge: () => '{"decision":"deny"}',
    });
    const sessionId = await requestToolCall(harness);
    await waitFor(() => harness.manager.get(sessionId)?.status === 'paused');

    expect(harness.sandboxProvider.writeCount).toBe(0);
    const [use] = toolUseEvents(harness, sessionId);
    expect(use.metadata).toMatchObject({
      permission: 'auto',
      evaluated_permission: 'deny',
      evaluation: { type: 'auto', evaluated_permission: 'deny', reason_code: 'high_risk' },
    });
    const [result] = toolResultEvents(harness, sessionId);
    expect((result.content?.[0] as any).is_error).toBe(true);
    // The turn continued: the refusal is a tool result the model reads, not a
    // session failure.
    expect(harness.manager.getEventLogger().getEvents(sessionId)
      .some((event) => event.type === 'agent.message')).toBe(true);
  });
});

describe('auto permission — ask', () => {
  it('parks the call on the confirmation path and executes it once on allow', async () => {
    const harness = createHarness({
      calls: [writeCall('call_1', 'review.txt')],
      judge: () => '{"decision":"ask"}',
    });
    const sessionId = await requestToolCall(harness);
    await waitFor(() => harness.manager.get(sessionId)?.status === 'requires_action');
    expect(harness.sandboxProvider.writeCount).toBe(0);

    const [use] = toolUseEvents(harness, sessionId);
    expect((use.content?.[0] as any).requires_confirmation).toBe(true);
    expect(use.metadata).toMatchObject({
      permission: 'auto',
      evaluated_permission: 'ask',
      evaluation: { type: 'auto', evaluated_permission: 'ask', reason_code: 'indeterminate' },
    });

    await harness.manager.sendEvent(sessionId, {
      type: 'user.tool_confirmation', tool_use_id: 'call_1', result: 'allow',
    } as any);
    await waitFor(() => harness.sandboxProvider.writeCount === 1);
    await waitFor(() => harness.manager.get(sessionId)?.status === 'paused');
    expect(harness.sandboxProvider.writes).toEqual([
      { path: 'review.txt', content: 'content of review.txt' },
    ]);
  });
});

describe('auto permission — fail closed', () => {
  it.each([
    ['an unreadable answer', () => 'I cannot decide right now'],
    ['an unrecognized decision', () => '{"decision":"execute_anyway"}'],
    ['a judge that throws', () => new Error('provider down')],
  ])('parks the call for human approval on %s', async (_label, judge) => {
    const harness = createHarness({ calls: [writeCall('call_1', 'held.txt')], judge });
    const sessionId = await requestToolCall(harness);
    await waitFor(() => harness.manager.get(sessionId)?.status === 'requires_action');

    // The one thing a broken evaluator must never do is run the tool.
    expect(harness.sandboxProvider.writeCount).toBe(0);
    const [use] = toolUseEvents(harness, sessionId);
    expect((use.content?.[0] as any).requires_confirmation).toBe(true);
    expect(use.metadata).toMatchObject({
      permission: 'auto',
      evaluated_permission: 'ask',
      evaluation: { type: 'auto', evaluated_permission: 'ask', reason_code: 'indeterminate' },
    });
    // And no error result was paired: the call is legitimately unanswered.
    expect(toolResultEvents(harness, sessionId)).toHaveLength(0);
  });
});

describe('auto permission — mixed calls', () => {
  it('applies each call its own verdict inside one model step', async () => {
    const harness = createHarness({
      calls: [writeCall('call_a', 'a.txt'), writeCall('call_b', 'b.txt')],
      judge: (prompt) => prompt.includes('a.txt') ? '{"decision":"allow"}' : '{"decision":"deny"}',
    });
    const sessionId = await requestToolCall(harness);
    await waitFor(() => harness.manager.get(sessionId)?.status === 'paused');

    expect(harness.sandboxProvider.writes).toEqual([
      { path: 'a.txt', content: 'content of a.txt' },
    ]);
    const uses = toolUseEvents(harness, sessionId);
    expect(uses).toHaveLength(2);
    const byCall = new Map(uses.map((use) => [(use.content?.[0] as any).id, use.metadata]));
    expect(byCall.get('call_a')).toMatchObject({ evaluated_permission: 'allow' });
    expect(byCall.get('call_b')).toMatchObject({
      evaluated_permission: 'deny',
      evaluation: { type: 'auto', evaluated_permission: 'deny', reason_code: 'high_risk' },
    });
  });
});
