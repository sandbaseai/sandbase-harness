/**
 * Integration test: worker-executed builtin `agent_toolset` calls on self-hosted
 * environments — upstream's `user.tool_result` surface.
 *
 * Covers the bridge a builtin `agent.tool_use` takes on a self-hosted session:
 * the strategy locks the tool's in-process executor, persists the call with
 * `awaiting_tool_result`, and enqueues a `tool_call` work item; a worker claims
 * and executes it through the same queue and `/v1/x/worker` routes as every
 * other kind; and the queue's completion hook injects the outcome back as a
 * `user.tool_result` — through `SessionManager.sendEvent`, so the parked call
 * resolves under the same admission rules a caller's answer faces.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { LanguageModel } from 'ai';
import { Database } from '@/core/db/database.js';
import { WorkQueue, SelfHostedSandboxProvider } from '@/sandbox/self-hosted-provider.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { ModelRegistry } from '@/model/registry.js';
import { createServer } from '@/api/server.js';
import { createEnvironmentWorkerKey } from '@/core/auth/environment-worker-keys.js';
import { executeWorkItem } from '@/cli/worker-commands.js';
import type { EnvironmentConfig } from '@/types/sandbox.js';

const USAGE = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const TOOL_CALLS = { unified: 'tool-calls', raw: 'tool_calls' } as const;
const STOP = { unified: 'stop', raw: 'stop' } as const;

function scriptedBashModel(turn: { count: number }): LanguageModel {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'scripted-builtin',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('not used');
    },
    async doStream() {
      turn.count += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            if (turn.count === 1) {
              const args = JSON.stringify({ command: 'echo worker-ran-this' });
              controller.enqueue({ type: 'tool-input-start', id: 'builtin_call_1', toolName: 'bash' });
              controller.enqueue({ type: 'tool-input-delta', id: 'builtin_call_1', delta: args });
              controller.enqueue({ type: 'tool-input-end', id: 'builtin_call_1' });
              controller.enqueue({ type: 'tool-call', toolCallId: 'builtin_call_1', toolName: 'bash', input: args });
              controller.enqueue({ type: 'finish', finishReason: TOOL_CALLS, usage: USAGE });
            } else {
              controller.enqueue({ type: 'text-start', id: 'text_1' });
              controller.enqueue({ type: 'text-delta', id: 'text_1', delta: 'Ran the command.' });
              controller.enqueue({ type: 'text-end', id: 'text_1' });
              controller.enqueue({ type: 'finish', finishReason: STOP, usage: USAGE });
            }
            controller.close();
          },
        }),
      } as any;
    },
  } as unknown as LanguageModel;
}

const BUILTIN_AGENT = {
  name: 'builtin-agent',
  model: 'scripted',
  system: 'Run the command the user gives you.',
  // The default `agent_toolset` enables the builtin inventory; nothing here
  // gates it behind confirmation, so the bash call parks for the worker.
  tools: [{ type: 'agent_toolset_20260401' as const }],
};

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for worker builtin turn'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

async function flushDelivery(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
}

describe('worker-executed builtin tools on self-hosted', () => {
  let db: Database;
  let tmpDir: string;
  let queue: WorkQueue;
  let manager: SessionManager;
  let executor: DefaultSessionExecutor;
  let app: ReturnType<typeof createServer>;
  let workerKey: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-wbt-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_default', 'local', '', '{}', '{}')").run();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_sh', 'sh', '', '{\"sandbox_provider\":\"self_hosted\"}', '{}')").run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_builtin', 'builtin-agent', '{}')").run();
    queue = new WorkQueue(db);
    manager = new SessionManager(db);
    const registry = new ModelRegistry();
    registry.register({ name: 'scripted', provider: 'openai', model: 'scripted', is_default: true });
    const turn = { count: 0 };
    (registry as any).createModel = () => scriptedBashModel(turn);
    executor = new DefaultSessionExecutor({
      agents: [BUILTIN_AGENT],
      modelRegistry: registry,
      sandboxProvider: new SelfHostedSandboxProvider(queue),
      resolveEnvironmentConfig: () => ({ name: 'sh', sandbox_provider: 'self_hosted', timeout: 300 } as EnvironmentConfig),
      strategy: new DefaultStrategy(),
      eventLogger: manager.getEventLogger(),
    });
    manager.setExecutor(executor);
    app = createServer({
      db,
      sessionManager: manager,
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      workQueue: queue,
    });
    workerKey = createEnvironmentWorkerKey(db, 'env_sh', { name: 'worker' }).secret_key;
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function parkSessionOnBuiltinCall(): Promise<string> {
    const session = manager.create({ agent: 'agent_builtin', environmentId: 'env_sh' });
    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'Run echo worker-ran-this.' }],
    });
    await waitFor(() => manager.get(session.id)?.status === 'requires_action'
      && queue.list().some((item) => item.sessionId === session.id && item.kind === 'tool_call'));
    return session.id;
  }

  function enqueuedItem(sessionId: string) {
    const item = queue.list().find((i) => i.sessionId === sessionId && i.kind === 'tool_call');
    expect(item).toBeDefined();
    return item!;
  }

  async function claimItem() {
    const claim = await app.request('/v1/x/worker/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker_id: 'worker_1', environment_id: 'env_sh', environment_key: workerKey }),
    });
    expect(claim.status).toBe(200);
    return claim.json() as Promise<{ id: string; kind: string; payload: Record<string, unknown> }>;
  }

  it('parks a builtin call, enqueues a tool_call item, and resumes on the worker\'s user.tool_result', async () => {
    const sessionId = await parkSessionOnBuiltinCall();
    const item = enqueuedItem(sessionId);
    expect(item.payload.tool_name).toBe('bash');
    expect(item.payload.tool_use_id).toBe('builtin_call_1');
    expect(item.payload.input).toEqual({ command: 'echo worker-ran-this' });

    // The parked call is on the log marked for a worker answer, not gated.
    const use = manager.getEventLogger().getEvents(sessionId)
      .find((event) => event.type === 'agent.tool_use');
    expect(use?.metadata?.awaiting_tool_result).toBe(true);
    const block = use?.content?.find((b) => b.type === 'tool_use') as { requires_confirmation?: boolean } | undefined;
    expect(block?.requires_confirmation).toBeUndefined();

    const claimed = await claimItem();
    expect(claimed.kind).toBe('tool_call');

    // The worker runs it and the completion is injected as a user.tool_result.
    const outcome = await executeWorkItem(
      { id: claimed.id, kind: 'tool_call', payload: claimed.payload },
      tmpDir,
    );
    const complete = await app.request('/v1/x/worker/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: claimed.id, worker_id: 'worker_1', result: outcome }),
    });
    expect(complete.status).toBe(200);

    await waitFor(() => manager.getEventLogger().getEvents(sessionId)
      .some((event) => event.type === 'user.tool_result'));
    await waitFor(() => manager.get(sessionId)?.status === 'paused');

    const events = manager.getEventLogger().getEvents(sessionId);
    const answers = events.filter((event) => event.type === 'user.tool_result');
    expect(answers).toHaveLength(1);
    expect(answers[0].metadata?.tool_use_id).toBe('builtin_call_1');
    expect(JSON.stringify(answers[0].content)).toContain('worker-ran-this');
    // The turn resumed: the model's closing message is on the log.
    expect(events.some((event) => event.type === 'agent.message'
      && JSON.stringify(event.content).includes('Ran the command.'))).toBe(true);
    await executor.cleanupSession(sessionId);
  });

  it('delivers a builtin tool error as an is_error user.tool_result', async () => {
    const sessionId = await parkSessionOnBuiltinCall();
    const claimed = await claimItem();
    const complete = await app.request('/v1/x/worker/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: claimed.id,
        worker_id: 'worker_1',
        result: { is_error: true, content: [{ type: 'text', text: 'command failed on the worker' }] },
      }),
    });
    expect(complete.status).toBe(200);

    await waitFor(() => manager.getEventLogger().getEvents(sessionId)
      .some((event) => event.type === 'user.tool_result'));

    const answer = manager.getEventLogger().getEvents(sessionId)
      .find((event) => event.type === 'user.tool_result');
    expect(answer?.metadata?.is_error).toBe(true);
    expect(JSON.stringify(answer?.content)).toContain('command failed on the worker');
    await executor.cleanupSession(sessionId);
  });

  it('refuses a second completion for the same tool_call', async () => {
    const sessionId = await parkSessionOnBuiltinCall();
    const claimed = await claimItem();
    await app.request('/v1/x/worker/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: claimed.id, worker_id: 'worker_1', result: { content: [{ type: 'text', text: 'first' }] } }),
    });

    const again = await app.request('/v1/x/worker/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: claimed.id, worker_id: 'worker_1', result: { content: [{ type: 'text', text: 'second' }] } }),
    });
    expect(again.status).toBe(409);

    await flushDelivery();
    const answers = manager.getEventLogger().getEvents(sessionId)
      .filter((event) => event.type === 'user.tool_result');
    expect(answers).toHaveLength(1);
    await executor.cleanupSession(sessionId);
  });
});
