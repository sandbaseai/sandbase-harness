/**
 * Integration test: one canonical usage record per model request.
 *
 * `event-logger.ts:102-106` states the rule in the code it implements: "Add
 * usage from one model request to the session aggregate. Callers must invoke
 * this once per model request, not once per event projection, because several
 * events may describe the same request."
 *
 * Nothing asserts it. `api.test.ts:1044-1046` runs a fake executor that reports
 * no usage at all and therefore expects `input_tokens: 0, output_tokens: 0`,
 * which is correct for that fake and says nothing about a real provider's
 * numbers. `api.test.ts:1071` asserts `expect.any(Number)`, which a runtime that
 * recorded zero for every request would also satisfy. The provider's own
 * `prompt_tokens`/`completion_tokens` are therefore never compared with what the
 * runtime publishes, and neither is the accumulation rule.
 *
 * The socket is the only thing stubbed, as in `model-qualified-reference.test.ts`:
 * the agent definition, model resolution, OpenAI-compatible request, streamed
 * answer, the usage the provider reports in its final chunk, the aggregate
 * column and the projected wire event are all real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { toApiEvent } from '@/api/standard.js';

const GATEWAY_MODEL = 'deepseek/deepseek-v4-flash';
const GATEWAY_BASE_URL = 'https://gateway.invalid/v1';
/** What the provider reports for one request in this suite. */
const PROMPT_TOKENS = 7;
const COMPLETION_TOKENS = 4;

/** One OpenAI-compatible stream, whose final chunk carries the provider's usage. */
function sseBody(text: string): string {
  const chunk = (choices: unknown[], usage?: unknown) => `data: ${JSON.stringify({
    id: 'chatcmpl_1',
    object: 'chat.completion.chunk',
    created: 0,
    model: GATEWAY_MODEL,
    choices,
    ...(usage ? { usage } : {}),
  })}`;
  return [
    chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
    chunk([{ index: 0, delta: { content: text }, finish_reason: null }]),
    chunk([{ index: 0, delta: {}, finish_reason: 'stop' }], {
      prompt_tokens: PROMPT_TOKENS,
      completion_tokens: COMPLETION_TOKENS,
      total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
    }),
    'data: [DONE]',
  ].join('\n\n') + '\n\n';
}

async function waitFor<T>(probe: () => T | undefined, description: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('Session usage is one addition per model request', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-usage-per-request-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_gateway', 'gateway-agent', '{}')`);
    manager = new SessionManager(db);

    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'openai_compatible',
      api_key: 'test-key',
      base_url: GATEWAY_BASE_URL,
      is_default: true,
    });
    manager.setExecutor(new DefaultSessionExecutor({
      agents: [{ name: 'gateway-agent', model: GATEWAY_MODEL, system: 'p' }],
      modelRegistry: registry,
      sandboxProvider: new LocalSandboxProvider(tmpDir),
      strategy: new DefaultStrategy(),
      eventLogger: manager.getEventLogger(),
    }));

    vi.stubGlobal('fetch', async () => new Response(sseBody('hello'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function usageEvents(sessionId: string) {
    return manager.getEventLogger().getEvents(sessionId).filter((event) => event.type === 'session.usage');
  }

  /** Send one user message and wait for the turn's own usage snapshot to land. */
  async function turn(sessionId: string, expectedSnapshots: number): Promise<void> {
    await manager.sendEvent(sessionId, {
      type: 'user.message',
      content: [{ type: 'text', text: 'hi' }],
    } as never);
    await waitFor(
      () => (usageEvents(sessionId).length >= expectedSnapshots ? true : undefined),
      `usage snapshot ${expectedSnapshots}`,
    );
  }

  it('publishes the numbers the provider reported, and nothing it did not', async () => {
    const session = manager.create({ agent: 'agent_gateway' });
    await turn(session.id, 1);

    const events = usageEvents(session.id);
    expect(events).toHaveLength(1);
    const snapshot = (events[0].metadata as { usage: Record<string, unknown> }).usage;

    // The provider's numbers, not a re-derivation and not zero.
    expect(snapshot.input_tokens).toBe(PROMPT_TOKENS);
    expect(snapshot.output_tokens).toBe(COMPLETION_TOKENS);
    // The session aggregate agrees with the published snapshot.
    expect(manager.get(session.id)!.usage).toEqual({ tokensIn: PROMPT_TOKENS, tokensOut: COMPLETION_TOKENS });

    // Cost, budget and server-tool counters are deliberately omitted rather than
    // reported as zero, because this runtime has no truthful value for them.
    expect(Object.keys(snapshot).sort()).toEqual(['active_seconds', 'input_tokens', 'output_tokens']);

    // And the same values are what a client reads off the wire projection.
    expect(toApiEvent(events[0]).usage).toEqual({
      input_tokens: PROMPT_TOKENS,
      output_tokens: COMPLETION_TOKENS,
      active_seconds: expect.any(Number),
    });
  });

  it('adds a second request to the aggregate instead of replacing or duplicating it', async () => {
    const session = manager.create({ agent: 'agent_gateway' });
    await turn(session.id, 1);
    await turn(session.id, 2);

    // Two requests, so twice the provider's numbers. A second request that reset
    // the counters would read as one request, and one that double-counted a
    // single request would read as four.
    expect(manager.get(session.id)!.usage).toEqual({
      tokensIn: PROMPT_TOKENS * 2,
      tokensOut: COMPLETION_TOKENS * 2,
    });
  });

  it('snapshots the running total once per request, in order', async () => {
    const session = manager.create({ agent: 'agent_gateway' });
    await turn(session.id, 1);
    await turn(session.id, 2);

    const totals = usageEvents(session.id).map(
      (event) => {
        const usage = (event.metadata as { usage: { input_tokens: number; output_tokens: number } }).usage;
        return { input: usage.input_tokens, output: usage.output_tokens };
      },
    );

    // One snapshot per request, each describing the total after that request. The
    // second is not a repeat of the first, and there is no third from the events
    // the first request produced.
    expect(totals).toEqual([
      { input: PROMPT_TOKENS, output: COMPLETION_TOKENS },
      { input: PROMPT_TOKENS * 2, output: COMPLETION_TOKENS * 2 },
    ]);
  });
});
