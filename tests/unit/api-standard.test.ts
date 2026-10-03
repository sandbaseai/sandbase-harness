import { describe, expect, it } from 'vitest';
import { toApiEvent, toApiSessionStatus } from '@/api/standard.js';
import type { SessionEvent } from '@/types/session.js';

describe('standard API event serialization', () => {
  it('exposes sequence, immutable metadata, and model attribution', () => {
    const event: SessionEvent = {
      id: 'sevt_1',
      sessionId: 'sess_1',
      seq: 7,
      type: 'agent.message',
      content: [{ type: 'text', text: 'done' }],
      metadata: { request_id: 'req_1' },
      modelUsed: 'test-model',
      tokensIn: 11,
      tokensOut: 13,
      stopReason: 'stop',
      durationMs: 21,
      createdAt: new Date('2026-09-14T00:00:00.000Z'),
    };

    expect(toApiEvent(event)).toMatchObject({
      id: 'sevt_1',
      seq: 7,
      metadata: { request_id: 'req_1' },
      model_used: 'test-model',
      tokens_in: 11,
      tokens_out: 13,
      stop_reason: 'stop',
      duration_ms: 21,
    });
  });

  it('projects a durable confirmation target and idle status while awaiting approval', () => {
    const event: SessionEvent = {
      id: 'sevt_2',
      sessionId: 'sess_1',
      seq: 8,
      type: 'user.tool_confirmation',
      metadata: { tool_use_id: 'tool_1', result: 'allow', confirmation_group_id: 'confirm_1' },
      createdAt: new Date('2026-09-14T00:00:00.000Z'),
    };

    expect(toApiEvent(event)).toMatchObject({
      seq: 8,
      tool_use_id: 'tool_1',
      metadata: { result: 'allow', confirmation_group_id: 'confirm_1' },
    });
    expect(toApiSessionStatus('requires_action')).toBe('idle');
  });
});
