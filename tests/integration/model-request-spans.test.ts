/**
 * Integration test: `span.model_request_start` / `span.model_request_end` in
 * the published paired shape.
 *
 * The model is a v4 stub — the strategy, the event log, the pairing column and
 * the wire projection are all real. One `prepareStep`→`onStepFinish` cycle is
 * one model request, so a two-step turn must produce two ordered pairs, and a
 * request that dies before finishing must still close — `is_error: true` — on
 * the start it opened.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { LanguageModel } from 'ai';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import type { StrategyContext } from '@/types/strategy.js';
import type { SessionEvent } from '@/types/session.js';
import { toApiEvent } from '@/api/standard.js';

const USAGE = { inputTokens: { total: 3 }, outputTokens: { total: 2 } };
const STOP = { unified: 'stop', raw: 'stop' } as const;
const TOOL_CALLS = { unified: 'tool-calls', raw: 'tool_calls' } as const;

/** First stream: one tool call. Later streams: plain text. */
function toolThenTextModel(): LanguageModel {
  let streams = 0;
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'span-model',
    supportedUrls: {},
    async doGenerate() {
      return { content: [{ type: 'text', text: 'ok' }], finishReason: STOP, usage: USAGE, warnings: [] } as any;
    },
    async doStream() {
      streams += 1;
      const first = streams === 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            if (first) {
              controller.enqueue({ type: 'tool-input-start', id: 'tc_1', toolName: 'echo' });
              controller.enqueue({ type: 'tool-input-delta', id: 'tc_1', delta: '{}' });
              controller.enqueue({ type: 'tool-input-end', id: 'tc_1' });
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'tc_1',
                toolName: 'echo',
                input: '{}',
              });
            } else {
              controller.enqueue({ type: 'text-start', id: 'ts_1' });
              controller.enqueue({ type: 'text-delta', id: 'ts_1', delta: 'done' });
              controller.enqueue({ type: 'text-end', id: 'ts_1' });
            }
            controller.enqueue({ type: 'finish', finishReason: first ? TOOL_CALLS : STOP, usage: USAGE });
            controller.close();
          },
        }),
      } as any;
    },
  } as unknown as LanguageModel;
}

/** Every request's `doStream` rejects — no step ever reaches `onStepFinish`. */
function failingModel(): LanguageModel {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'span-model',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('provider unreachable');
    },
    async doStream() {
      throw new Error('provider unreachable');
    },
  } as unknown as LanguageModel;
}

describe('span.model_request pairs follow the published shape', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-model-request-spans-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_a', 'a', '{}')`);
    manager = new SessionManager(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function contextFor(sessionId: string, model: LanguageModel): StrategyContext {
    const session = manager.get(sessionId)!;
    return {
      session: {
        ...session,
        agentDefinition: { name: 'a', model: 'm', system: 'p' },
      },
      userEvent: { type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
      systemPrompt: 'p',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      model,
      tools: {
        echo: {
          description: 'echo',
          parameters: { type: 'object', properties: {} },
          execute: async () => 'echoed',
        },
      },
      sandbox: {} as any,
      eventLog: manager.getEventLogger(),
      broadcast: () => {},
      config: {},
    } as unknown as StrategyContext;
  }

  async function runTurn(model: LanguageModel): Promise<SessionEvent[]> {
    const session = manager.create({ agent: 'agent_a' });
    for await (const _event of new DefaultStrategy().execute(contextFor(session.id, model))) {
      // The log is the assertion surface; the yielded stream is consumed only
      // so the generator runs to completion.
    }
    return manager.getEventLogger().getEvents(session.id);
  }

  it('pairs one start and one end per model request, in request order', async () => {
    const events = await runTurn(toolThenTextModel());
    const spans = events.filter((event) => event.type.startsWith('span.model_request'));

    // A tool-calling step plus the answering step: two requests, two pairs.
    expect(spans.map((event) => event.type)).toEqual([
      'span.model_request_start',
      'span.model_request_end',
      'span.model_request_start',
      'span.model_request_end',
    ]);

    const starts = spans.filter((event) => event.type === 'span.model_request_start');
    const ends = spans.filter((event) => event.type === 'span.model_request_end');
    // Each end points back at its own start, in order — not at the other pair's.
    expect(ends.map((event) => event.parentEventId)).toEqual(starts.map((event) => event.id));
    for (const end of ends) {
      expect(end.isError).toBe(false);
    }

    // The start is a bare progress signal; the end carries the request's usage
    // in the published `model_usage` shape, alongside the local extension fields.
    const apiEnd = toApiEvent(ends[0]);
    expect(apiEnd.model_request_start_id).toBe(starts[0].id);
    expect(apiEnd.is_error).toBe(false);
    expect(apiEnd.model_usage).toEqual({
      input_tokens: 3,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(apiEnd.tokens_in).toBe(3);
    expect(apiEnd.tokens_out).toBe(2);
    expect(apiEnd.model_used).toBe('span-model');
    expect(apiEnd.parent_event_id).toBe(starts[0].id);
  });

  it('closes the open start with an error end when the request dies', async () => {
    const session = manager.create({ agent: 'agent_a' });
    await expect(async () => {
      for await (const _event of new DefaultStrategy().execute(contextFor(session.id, failingModel()))) {
        // consumed only to drive the generator
      }
    }).rejects.toThrow();

    const events = manager.getEventLogger().getEvents(session.id);
    const spans = events.filter((event) => event.type.startsWith('span.model_request'));

    // The request opened a start and never reached onStepFinish — the end that
    // still lands is the error close, paired to that start.
    expect(spans.map((event) => event.type)).toEqual([
      'span.model_request_start',
      'span.model_request_end',
    ]);
    const [start, end] = spans;
    expect(end.parentEventId).toBe(start.id);
    expect(end.isError).toBe(true);

    const apiEnd = toApiEvent(end);
    expect(apiEnd.is_error).toBe(true);
    expect(apiEnd.model_request_start_id).toBe(start.id);
    // No tokens were ever reported for the request; the row reports zeros
    // rather than a fabricated total.
    expect(apiEnd.model_usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
});
