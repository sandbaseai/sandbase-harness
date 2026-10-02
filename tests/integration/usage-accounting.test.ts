/**
 * Integration test: the usage accounting identity holds over a real turn.
 *
 * The unit test asserts the identity against a hand-built log. This one drives
 * `DefaultStrategy` with a mock model of known usage, so it also covers the two
 * write paths themselves: the `span.model_request_end` append and the
 * `recordUsage` call that must accompany it, at `default-strategy.ts:190` and
 * `:199`. Drop either one and this goes red.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { runtimeRoutes } from '@/api/routes/runtime.js';
import type { ServerDeps } from '@/api/server.js';
import type { LanguageModelV1 } from 'ai';

const PROMPT_TOKENS = 120;
const COMPLETION_TOKENS = 30;

function usageReportingModel(): LanguageModelV1 {
  const usage = { promptTokens: PROMPT_TOKENS, completionTokens: COMPLETION_TOKENS };
  return {
    specificationVersion: 'v1',
    provider: 'test',
    modelId: 'usage-reporting',
    async doGenerate() {
      return {
        text: 'ok',
        finishReason: 'stop',
        usage,
        rawCall: { rawPrompt: null, rawSettings: {} },
      } as any;
    },
    async doStream() {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-delta', textDelta: 'ok' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
            controller.close();
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      } as any;
    },
  } as unknown as LanguageModelV1;
}

interface MetricsSummary {
  sessions: { input_tokens: number; output_tokens: number };
  events: { input_tokens: number; output_tokens: number };
}

async function metricsSummary(db: Database): Promise<MetricsSummary> {
  const app = runtimeRoutes({ db } as unknown as ServerDeps);
  const res = await app.request('/metrics/summary');
  expect(res.status).toBe(200);
  return (await res.json()) as MetricsSummary;
}

describe('usage accounting identity over a real turn', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-usage-e2e-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_u', 'u', '{}')`);

    manager = new SessionManager(db);
    const modelRegistry = new ModelRegistry();
    (modelRegistry as any).createModel = () => usageReportingModel();
    manager.setExecutor(new DefaultSessionExecutor({
      agents: [{ name: 'u', model: 'm', system: 'p' }],
      modelRegistry,
      sandboxProvider: new LocalSandboxProvider(tmpDir),
      strategy: new DefaultStrategy(),
      eventLogger: manager.getEventLogger(),
    }));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runTurn(sessionId: string, text: string): Promise<void> {
    await manager.sendEvent(sessionId, {
      type: 'user.message',
      content: [{ type: 'text', text }],
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  it('agrees with itself after one turn, and reports the model usage once', async () => {
    const session = manager.create({ agent: 'agent_u' });
    await runTurn(session.id, 'hi');

    expect(manager.get(session.id)!.status).toBe('paused');
    const events = manager.getEventLogger().getEvents(session.id);
    expect(events.some((event) => event.type === 'session.error')).toBe(false);

    const spans = events.filter((event) => event.type === 'span.model_request_end');
    expect(spans).toHaveLength(1);

    const summary = await metricsSummary(db);
    expect(summary.events.input_tokens).toBe(summary.sessions.input_tokens);
    expect(summary.events.output_tokens).toBe(summary.sessions.output_tokens);
    expect(summary.events.input_tokens).toBe(PROMPT_TOKENS);
    expect(summary.events.output_tokens).toBe(COMPLETION_TOKENS);
  });

  it('still agrees after a second turn on the same session', async () => {
    const session = manager.create({ agent: 'agent_u' });
    await runTurn(session.id, 'first');
    await runTurn(session.id, 'second');

    const spans = manager.getEventLogger().getEvents(session.id)
      .filter((event) => event.type === 'span.model_request_end');
    expect(spans).toHaveLength(2);

    const summary = await metricsSummary(db);
    expect(summary.events.input_tokens).toBe(summary.sessions.input_tokens);
    expect(summary.events.input_tokens).toBe(PROMPT_TOKENS * 2);
    expect(summary.events.output_tokens).toBe(COMPLETION_TOKENS * 2);
  });

  it('still agrees across two sessions', async () => {
    const a = manager.create({ agent: 'agent_u' });
    const b = manager.create({ agent: 'agent_u' });
    await runTurn(a.id, 'hi');
    await runTurn(b.id, 'hi');

    const summary = await metricsSummary(db);
    expect(summary.events.input_tokens).toBe(summary.sessions.input_tokens);
    expect(summary.events.input_tokens).toBe(PROMPT_TOKENS * 2);
  });

  it('counts the request once even though other events carry the same usage', async () => {
    // The projected events copy the model's usage for local attribution. This is
    // what the metrics filter exists to exclude, so assert the copies are really
    // there rather than trusting the filter against an empty case.
    const session = manager.create({ agent: 'agent_u' });
    await runTurn(session.id, 'hi');

    const carriers = manager.getEventLogger().getEvents(session.id)
      .filter((event) => (event.tokensIn ?? 0) > 0 || (event.tokensOut ?? 0) > 0);
    expect(carriers.length).toBeGreaterThan(1);

    const naiveTotal = carriers.reduce((sum, event) => sum + (event.tokensIn ?? 0), 0);
    expect(naiveTotal).toBeGreaterThan(PROMPT_TOKENS);

    const summary = await metricsSummary(db);
    expect(summary.events.input_tokens).toBe(PROMPT_TOKENS);
    expect(summary.sessions.input_tokens).toBe(PROMPT_TOKENS);
  });
});
