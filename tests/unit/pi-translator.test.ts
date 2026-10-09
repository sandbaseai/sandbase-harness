import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@/types/session.js';
import { PiTranslator, type PiTranslatorOptions } from '@/strategy/pi/translator.js';
import { PiStderrTail } from '@/strategy/pi/stderr-tail.js';

function fakeSink() {
  let seq = 0;
  const events: SessionEvent[] = [];
  const broadcasts: SessionEvent[] = [];
  const usage: Array<[string, number, number]> = [];
  const options: PiTranslatorOptions = {
    sessionId: 'sess_pi_fixture',
    model: 'fixture-model',
    eventLog: {
      append(_sessionId, event) {
        const persisted = {
          id: `sevt_${++seq}`,
          sessionId: 'sess_pi_fixture',
          seq,
          type: event.type,
          content: event.content,
          modelUsed: event.modelUsed,
          tokensIn: event.tokensIn,
          tokensOut: event.tokensOut,
          stopReason: event.stopReason,
          durationMs: event.durationMs,
          parentEventId: event.parentEventId,
          createdAt: new Date(),
          processedAt: new Date(),
        } as SessionEvent;
        events.push(persisted);
        return persisted;
      },
      getLatestSeq: () => seq,
      recordUsage: () => undefined,
      recordAuxiliaryModelUsage: (_sessionId, _usage, _options) =>
        ({ id: 'sevt_aux', sessionId: 'sess_pi_fixture', seq: ++seq, type: 'span.model_request_end', createdAt: new Date() } as SessionEvent),
    },
    broadcast: (event) => broadcasts.push(event),
    recordUsage: (sessionId, input, output) => usage.push([sessionId, input, output]),
    // The translator no longer caps output itself; the shared overflow
    // contract does. The double under the local ceiling is a pass-through.
    spillToolOutput: async (output) => output,
  };
  return { options, events, broadcasts, usage };
}

async function* lines(values: string[]) {
  for (const value of values) yield `${value}\n`;
}

describe('Pi stdout translator', () => {
  it('converts text/tool/usage events and appends durable events before broadcasting', async () => {
    const sink = fakeSink();
    const translator = new PiTranslator(sink.options);
    await translator.consume(lines([
      '{"type":"session","id":"pi_fixture"}',
      '{"type":"agent_start"}',
      '{"type":"turn_start"}',
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello "}}',
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"world"}}',
      '{"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"echo hi"}}',
      '{"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":"hi","isError":false}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello world"}],"usage":{"input":3,"output":2}}}',
      '{"type":"turn_end","message":{"role":"assistant","model":"fixture-model","usage":{"input":3,"output":2},"stopReason":"stop"}}',
    ]));
    const summary = translator.finish();

    expect(summary).toMatchObject({ sawSessionHeader: true, sawFinalAssistantMessage: true, requestCount: 1, inputTokens: 3, outputTokens: 2 });
    expect(sink.usage).toEqual([['sess_pi_fixture', 3, 2]]);
    expect(sink.events.map((event) => event.type)).toEqual([
      'span.model_request_start',
      'agent.tool_use',
      'agent.tool_result',
      'agent.message',
      'span.model_request_end',
    ]);
    expect(sink.events.find((event) => event.type === 'agent.tool_use')?.content?.[0]).not.toHaveProperty('requires_confirmation');
    expect(sink.events.find((event) => event.type === 'agent.message')?.content).toEqual([{ type: 'text', text: 'Hello world' }]);
    expect(sink.broadcasts.filter((event) => event.seq === 0).map((event) => event.type)).toEqual([
      'agent.message_stream_start', 'agent.message_chunk', 'agent.message_chunk', 'agent.message_stream_end',
    ]);
    expect(sink.broadcasts.filter((event) => event.seq > 0).map((event) => event.type)).toEqual(sink.events.map((event) => event.type));
  });

  it('keeps unknown events inert and rejects malformed protocol events', async () => {
    const sink = fakeSink();
    const translator = new PiTranslator(sink.options);
    await translator.consume(lines([
      '{"type":"session","id":"pi_fixture"}',
      '{"type":"future_event","toolCallId":"must_not_gain_authority"}',
    ]));
    translator.finish();
    expect(sink.events).toHaveLength(0);

    const malformed = new PiTranslator(fakeSink().options);
    await expect(malformed.consume(lines(['{"type":"tool_execution_start","toolName":"bash"}']))).rejects.toThrow('toolCallId');
    const invalidJson = new PiTranslator(fakeSink().options);
    await expect(invalidJson.consume(lines(['{"type":"session"', 'warning']))).rejects.toThrow('malformed JSON');
  });

  it('bounds and redacts stderr independently of stdout authority', () => {
    const tail = new PiStderrTail(20, ['secret-value']);
    tail.append('prefix secret-value ');
    tail.append('authorization: Bearer abc123\nfinal');
    expect(tail.text().length).toBeLessThanOrEqual(100);
    expect(tail.text()).not.toContain('secret-value');
    expect(tail.text()).not.toContain('abc123');
  });
});
