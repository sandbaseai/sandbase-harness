/**
 * Integration test: a transient model failure drives the published retry
 * lifecycle on the session — `session.error(retrying)` +
 * `session.status_rescheduled`, `session.status_running` on recovery, and
 * `session.error(exhausted)` + `session.status_idle(retries_exhausted)` when
 * the policy gives up. An interrupt during the backoff ends the wait.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import { Database } from '@/core/db/database.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { DEFAULT_RETRY_POLICY, type RetryObserver } from '@/types/model.js';
import type { EnvironmentConfig } from '@/types/sandbox.js';

type WireModel = Exclude<LanguageModel, string>;

const USAGE = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const STOP = { unified: 'stop', raw: 'stop' } as const;

function apiError(statusCode: number) {
  const err = new Error(`scripted ${statusCode}`) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/** A model that fails `doStream` the given number of times, then answers. */
function scriptedModel(failures: number, statusCode: number, answer: string): WireModel & { calls: () => number } {
  let calls = 0;
  const model = {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'scripted-retry',
    supportedUrls: {},
    calls: () => calls,
    async doGenerate() { throw new Error('not used'); },
    async doStream() {
      calls += 1;
      if (calls <= failures) throw apiError(statusCode);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 'text_1' });
            controller.enqueue({ type: 'text-delta', id: 'text_1', delta: answer });
            controller.enqueue({ type: 'text-end', id: 'text_1' });
            controller.enqueue({ type: 'finish', finishReason: STOP, usage: USAGE });
            controller.close();
          },
        }),
      } as any;
    },
  } as unknown as WireModel & { calls: () => number };
  return model;
}

async function waitFor(probe: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('Session rescheduling — transient model retry is visible', () => {
  let db: Database | undefined;
  let workspace: string | undefined;
  let manager: SessionManager | undefined;
  let executor: DefaultSessionExecutor | undefined;
  let sessionId: string | undefined;

  afterEach(async () => {
    if (executor && sessionId) await executor.cleanupSession(sessionId).catch(() => {});
    db?.close();
    db = undefined;
    manager = undefined;
    executor = undefined;
    sessionId = undefined;
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  });

  /**
   * `delayMs` keeps the backoff observable without slowing the suite: the real
   * policy's 1s/2s/4s values are covered in `model-retry.test.ts`.
   */
  async function setUp(model: WireModel, delayMs: number) {
    workspace = mkdtempSync(join(process.env.TEMP ?? process.cwd(), 'ma-resched-'));
    db = new Database(join(workspace, 'test.db'));
    db.runMigrations();
    db.exec("INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')");
    db.exec("INSERT INTO agents (id, name, definition) VALUES ('agent_r', 'r-agent', '{}')");

    manager = new SessionManager(db);
    const registry = new ModelRegistry({ ...DEFAULT_RETRY_POLICY, getDelay: () => delayMs });
    registry.register({ name: 'scripted', provider: 'openai', model: 'scripted', is_default: true });
    (registry as any).createModel = (_name: string, options?: { retryObserver?: RetryObserver }) =>
      wrapLanguageModel({ model, middleware: [registry.retryMiddleware(options?.retryObserver)] });
    executor = new DefaultSessionExecutor({
      agents: [{ name: 'r-agent', model: 'scripted', system: 'x' }],
      modelRegistry: registry,
      sandboxProvider: new LocalSandboxProvider(workspace),
      resolveEnvironmentConfig: () => ({ name: 'local', sandbox_provider: 'local' } as EnvironmentConfig),
      strategy: new DefaultStrategy(),
      eventLogger: manager.getEventLogger(),
    });
    manager.setExecutor(executor);

    const session = manager.create({ agent: 'agent_r' });
    sessionId = session.id;
    return session.id;
  }

  function events() {
    return manager!.getEventLogger().getEvents(sessionId!);
  }

  function typesOf(kind: string) {
    return events().filter((e) => e.type === kind);
  }

  function retryStatus(e: { metadata?: unknown }) {
    return (e.metadata as { error?: { retry_status?: { type?: string } } } | undefined)?.error?.retry_status?.type;
  }

  it('publishes rescheduled → running → idle when one retry recovers', async () => {
    const model = scriptedModel(1, 503, 'recovered');
    const id = await setUp(model, 5);
    await manager!.sendEvent(id, { type: 'user.message', content: [{ type: 'text', text: 'go' }] } as any);

    await waitFor(() => manager!.get(id)?.status === 'paused', 'idle after recovery');
    expect(model.calls()).toBe(2);

    const order = events().map((e) => e.type);
    const rescheduledAt = order.indexOf('session.status_rescheduled');
    const lastRunningAt = order.lastIndexOf('session.status_running');
    const idleAt = order.lastIndexOf('session.status_idle');
    expect(rescheduledAt).toBeGreaterThan(order.indexOf('session.status_running'));
    expect(lastRunningAt).toBeGreaterThan(rescheduledAt);
    expect(idleAt).toBeGreaterThan(lastRunningAt);

    const errorEvents = typesOf('session.error');
    expect(errorEvents).toHaveLength(1);
    expect(retryStatus(errorEvents[0])).toBe('retrying');
    const idle = typesOf('session.status_idle').at(-1);
    expect((idle?.metadata as { stop_reason?: { type?: string } })?.stop_reason?.type).toBe('end_turn');
  });

  it('publishes exhausted and idles with retries_exhausted, then answers a new message', async () => {
    // First turn: initial + 3 retries, all 503 → exhausted. The scripted model
    // still succeeds on later calls, which the follow-up message exercises.
    const model = scriptedModel(4, 503, 'second turn ok');
    const id = await setUp(model, 5);
    await manager!.sendEvent(id, { type: 'user.message', content: [{ type: 'text', text: 'go' }] } as any);

    await waitFor(() => manager!.get(id)?.status === 'paused', 'idle after exhaustion');
    expect(model.calls()).toBe(4);

    // One scheduled error per retry wait, then the exhausted one.
    const errorEvents = typesOf('session.error');
    expect(errorEvents.map(retryStatus)).toEqual(['retrying', 'retrying', 'retrying', 'exhausted']);
    // One rescheduled event, not three.
    expect(typesOf('session.status_rescheduled')).toHaveLength(1);
    const idle = typesOf('session.status_idle').at(-1);
    expect((idle?.metadata as { stop_reason?: { type?: string } })?.stop_reason?.type).toBe('retries_exhausted');

    // The session is idle, not failed: another message runs another turn.
    await manager!.sendEvent(id, { type: 'user.message', content: [{ type: 'text', text: 'again' }] } as any);
    await waitFor(
      () => events().some((e) => e.type === 'agent.message' && JSON.stringify(e.content).includes('second turn ok')),
      'second turn reply',
    );
    expect(manager!.get(id)?.status).toBe('paused');
    const lastIdle = typesOf('session.status_idle').at(-1);
    expect((lastIdle?.metadata as { stop_reason?: { type?: string } })?.stop_reason?.type).toBe('end_turn');
  });

  it('interrupt during the retry wait aborts the backoff and idles with end_turn', async () => {
    // Long backoff: the turn parks in `retrying` until interrupted.
    const model = scriptedModel(1, 503, 'unreached');
    const id = await setUp(model, 30_000);
    await manager!.sendEvent(id, { type: 'user.message', content: [{ type: 'text', text: 'go' }] } as any);

    await waitFor(() => manager!.get(id)?.status === 'retrying', 'retry wait');

    // A rescheduling session is still "running" for archive/delete admission.
    await expect(manager!.archive(id)).rejects.toMatchObject({ code: 'session_running' });
    await expect(manager!.delete(id)).rejects.toMatchObject({ code: 'session_running' });

    await manager!.sendEvent(id, { type: 'user.interrupt' } as any);
    await waitFor(() => manager!.get(id)?.status === 'paused', 'idle after interrupt');

    // The backoff never fired a second request, and the close reports end_turn.
    expect(model.calls()).toBe(1);
    const idle = typesOf('session.status_idle').at(-1);
    expect((idle?.metadata as { stop_reason?: { type?: string } })?.stop_reason?.type).toBe('end_turn');
  }, 15000);

  it('projects retrying as rescheduling on the wire', async () => {
    const model = scriptedModel(1, 503, 'unreached');
    const id = await setUp(model, 30_000);
    await manager!.sendEvent(id, { type: 'user.message', content: [{ type: 'text', text: 'go' }] } as any);
    await waitFor(() => manager!.get(id)?.status === 'retrying', 'retry wait');

    const { toApiSession } = await import('@/api/standard.js');
    const api = toApiSession(manager!.get(id)!);
    expect(api.status).toBe('rescheduling');

    await manager!.sendEvent(id, { type: 'user.interrupt' } as any);
    await waitFor(() => manager!.get(id)?.status === 'paused', 'idle after interrupt');
  }, 15000);
});
