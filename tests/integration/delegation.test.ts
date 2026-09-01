/**
 * Integration test: multi-agent delegation tools (R3).
 *
 * Verifies delegation tools are built for an agent's roster, and that invoking
 * one runs the target agent as a sub-agent returning its answer. Uses a fake
 * strategy that echoes the task so we can assert the delegated result.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { InMemoryEventLog } from '@/core/session/in-memory-event-log.js';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { LanguageModel } from 'ai';

/** Strategy that emits an agent.message echoing the last user text. */
class EchoStrategy implements AgentStrategy {
  readonly name = 'echo';
  builtTools: Record<string, unknown> = {};
  async *execute(ctx: StrategyContext) {
    this.builtTools = ctx.tools;
    const lastUser = [...ctx.messages].reverse().find((m: any) => m.role === 'user');
    const text = lastUser
      ? (lastUser as any).content.map((p: any) => p.text ?? '').join('')
      : '';
    const evt = ctx.eventLog.append(ctx.session.id, {
      type: 'agent.message',
      content: [{ type: 'text', text: `[${ctx.session.agentName}] handled: ${text}` }],
    });
    ctx.broadcast(evt);
    return;
  }
}

function fakeModel(): LanguageModel {
  return {
    specificationVersion: 'v4', provider: 'test', modelId: 't',
    supportedUrls: {},
    async doGenerate() { return { content: [], finishReason: { unified: 'stop', raw: 'stop' }, usage: {}, warnings: [] } as any; },
    async doStream() { throw new Error('unused'); },
  } as unknown as LanguageModel;
}

describe('Multi-agent delegation', () => {
  let tmpDir: string;
  let executor: DefaultSessionExecutor;
  let strategy: EchoStrategy;

  const agents: AgentDefinition[] = [
    { name: 'coordinator', model: 'm', system: 'coordinate', delegations: ['researcher'] },
    { name: 'researcher', model: 'm', system: 'research' },
    { name: 'loner', model: 'm', system: 'alone' },
  ];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-deleg-'));
    const modelRegistry = new ModelRegistry();
    (modelRegistry as any).createModel = () => fakeModel();
    strategy = new EchoStrategy();
    executor = new DefaultSessionExecutor({
      agents,
      modelRegistry,
      sandboxProvider: new LocalSandboxProvider(tmpDir),
      strategy,
      eventLogger: new InMemoryEventLog() as any,
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds delegate_to_<target> tools for the roster', async () => {
    const session = {
      id: 'sess_1', agentId: 'coordinator', agentName: 'coordinator',
      environmentId: 'env_default', status: 'running' as const,
      createdAt: new Date(), updatedAt: new Date(),
    };
    for await (const _ of executor.execute(session, { type: 'user.message', content: [{ type: 'text', text: 'hi' }] } as any)) { /* drain */ }

    expect(strategy.builtTools['delegate_to_researcher']).toBeDefined();
    // No tool for an agent not in the roster
    expect(strategy.builtTools['delegate_to_loner']).toBeUndefined();
  });

  it('running the delegation tool returns the sub-agent answer', async () => {
    const session = {
      id: 'sess_2', agentId: 'coordinator', agentName: 'coordinator',
      environmentId: 'env_default', status: 'running' as const,
      createdAt: new Date(), updatedAt: new Date(),
    };
    for await (const _ of executor.execute(session, { type: 'user.message', content: [{ type: 'text', text: 'go' }] } as any)) { /* drain */ }

    const tool = strategy.builtTools['delegate_to_researcher'] as any;
    const result = await tool.execute({ task: 'find X' });
    expect(result).toContain('[researcher] handled: find X');
  });

  it('exposes general_subagent when enabled', async () => {
    const agentsWithGeneral: AgentDefinition[] = [
      { name: 'boss', model: 'm', system: 'boss', enable_general_subagent: true },
    ];
    const modelRegistry = new ModelRegistry();
    (modelRegistry as any).createModel = () => fakeModel();
    const strat = new EchoStrategy();
    const exec = new DefaultSessionExecutor({
      agents: agentsWithGeneral,
      modelRegistry,
      sandboxProvider: new LocalSandboxProvider(tmpDir),
      strategy: strat,
      eventLogger: new InMemoryEventLog() as any,
    });
    const session = {
      id: 'sess_3', agentId: 'boss', agentName: 'boss',
      environmentId: 'env_default', status: 'running' as const,
      createdAt: new Date(), updatedAt: new Date(),
    };
    for await (const _ of exec.execute(session, { type: 'user.message', content: [{ type: 'text', text: 'go' }] } as any)) { /* drain */ }

    expect(strat.builtTools['general_subagent']).toBeDefined();
    const result = await (strat.builtTools['general_subagent'] as any).execute({ task: 'sub work' });
    expect(result).toContain('handled: sub work');
  });
});
