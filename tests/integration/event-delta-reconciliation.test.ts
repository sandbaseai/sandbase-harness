/**
 * Integration test: `event_deltas[]` previews reconcile against the buffered
 * event they anticipate.
 *
 * The contract's reconciliation rule is that the id announced by `event_start`
 * and carried on every `event_delta` is the id of the `agent.message` the log
 * eventually persists. The strategy therefore mints the durable id before the
 * first delta leaves the model, broadcasts the transient carriers under it,
 * and hands the same id back to `append` when the step lands. A v4 stub model
 * drives the real strategy, event log, and projector end to end.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { LanguageModel } from 'ai';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { EventDeltaProjector, type EventDeltaFrame } from '@/core/session/event-deltas.js';
import type { StrategyContext } from '@/types/strategy.js';
import type { SessionEvent } from '@/types/session.js';

const USAGE = { inputTokens: { total: 3 }, outputTokens: { total: 2 } };
const STOP = { unified: 'stop', raw: 'stop' } as const;

/** Two-step turn: a tool call, then streamed text in two deltas. */
function toolThenTextModel(): LanguageModel {
  let streams = 0;
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'delta-model',
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
              controller.enqueue({ type: 'tool-call', toolCallId: 'tc_1', toolName: 'echo', input: '{}' });
            } else {
              controller.enqueue({ type: 'text-start', id: 'ts_1' });
              controller.enqueue({ type: 'text-delta', id: 'ts_1', delta: 'Hel' });
              controller.enqueue({ type: 'text-delta', id: 'ts_1', delta: 'lo' });
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
const TOOL_CALLS = { unified: 'tool-calls', raw: 'tool_calls' } as const;

describe('event_deltas previews reconcile against the buffered agent.message', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-event-delta-reconcile-'));
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

  it('announces the durable event id before the buffered event lands', async () => {
    const session = manager.create({ agent: 'agent_a' });
    const projector = new EventDeltaProjector(['agent.message']);
    const frames: EventDeltaFrame[] = [];
    const durableBroadcasts: SessionEvent[] = [];

    const context = {
      session: {
        ...manager.get(session.id)!,
        agentDefinition: { name: 'a', model: 'm', system: 'p' },
      },
      userEvent: { type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
      systemPrompt: 'p',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      model: toolThenTextModel(),
      tools: {
        echo: {
          description: 'echo',
          parameters: { type: 'object', properties: {} },
          execute: async () => 'echoed',
        },
      },
      sandbox: {} as any,
      eventLog: manager.getEventLogger(),
      broadcast: (event: SessionEvent) => {
        frames.push(...projector.framesFor(event));
        if (event.seq !== 0) durableBroadcasts.push(event);
      },
      config: {},
    } as unknown as StrategyContext;

    for await (const _event of new DefaultStrategy().execute(context)) {
      // Consume the generator to completion so every step lands.
    }

    const previewed = frames.find((frame) => frame.type === 'event_start');
    expect(previewed).toBeDefined();
    const previewedId = (previewed!.event as { id: string }).id;
    expect(previewedId).toMatch(/^sevt_/);

    // Every delta names the same previewed id and extends content block 0.
    const deltas = frames.filter((frame) => frame.type === 'event_delta');
    expect(deltas.map((frame) => frame.event_id)).toEqual([previewedId, previewedId]);
    expect(deltas.map((frame) => (frame.delta as { content: { text: string } }).content.text)).toEqual(['Hel', 'lo']);

    // The persisted event carries the id the previews announced, so an
    // accumulator keys the preview and the record on the same value.
    const message = manager.getEventLogger().getEvents(session.id).find((event) => event.type === 'agent.message');
    expect(message?.id).toBe(previewedId);
    expect(durableBroadcasts.map((event) => event.id)).toContain(previewedId);
    expect(message?.content).toEqual([{ type: 'text', text: 'Hello' }]);
  });
});
