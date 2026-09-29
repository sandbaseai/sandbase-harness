import { describe, expect, it, vi } from 'vitest';
import { createEventStreamParser, readEventStream } from '../../apps/console/src/api.js';
import {
  contiguousSessionSequence,
  mergeOrderedSessionEvents,
} from '../../apps/console/src/lib/ordered-session-events.js';
import type { SessionEvent } from '../../apps/console/src/types.js';

function event(id: string, seq: number): SessionEvent {
  return {
    id,
    seq,
    type: 'agent.message',
    content: [],
    created_at: null,
    processed_at: null,
    parent_event_id: null,
  };
}

describe('Console durable session event projection', () => {
  it('keeps the resume cursor at the highest contiguous sequence during interleaving', () => {
    let projected = mergeOrderedSessionEvents([], [event('evt_1', 1)]);
    projected = mergeOrderedSessionEvents(projected, [event('evt_3', 3)]);
    expect(projected.map((item) => item.seq)).toEqual([1, 3]);
    expect(contiguousSessionSequence(projected)).toBe(1);

    projected = mergeOrderedSessionEvents(projected, [event('evt_2', 2)]);
    expect(projected.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(contiguousSessionSequence(projected)).toBe(3);
  });

  it('merges a late REST snapshot without dropping tail events or persisting chunks', () => {
    const tail = mergeOrderedSessionEvents([], [event('evt_3', 3)]);
    const snapshot = [event('evt_1', 1), event('evt_2', 2), { ...event('chunk', 0), type: 'agent.message_chunk' }];
    const projected = mergeOrderedSessionEvents(tail, snapshot);

    expect(projected.map((item) => item.id)).toEqual(['evt_1', 'evt_2', 'evt_3']);
    expect(contiguousSessionSequence(projected)).toBe(3);
  });
});

describe('Console SSE parser', () => {
  it('parses arbitrarily split fields and flushes a final event at EOF', () => {
    const received: Array<{ event: string; id?: string; data: unknown }> = [];
    const parser = createEventStreamParser((value) => received.push(value));

    parser.push('id: 7\nev');
    parser.push('ent: agent.message\ndata: {"id":"evt_7",');
    parser.push('"seq":7,"type":"agent.message"}');
    parser.finish();

    expect(received).toEqual([{
      id: '7',
      event: 'agent.message',
      data: { id: 'evt_7', seq: 7, type: 'agent.message' },
    }]);
  });

  it('sends the resume cursor even when it is zero, and omits it only when asked', async () => {
    // A stream without a cursor carries live events only, so the session page
    // always names where to resume from — `0` included, which replays the log the
    // page would otherwise miss while its own history read is still in flight.
    const headers: Array<Record<string, string>> = [];
    const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
      headers.push(init.headers as Record<string, string>);
      return new Response('id: 1\nevent: user.message\ndata: {"seq":1}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', fetchStub);
    try {
      const received: unknown[] = [];
      await readEventStream('/v1/sessions/sess_1/events/stream', (event) => received.push(event), {
        lastEventId: '0',
      });
      expect(headers[0]['Last-Event-ID']).toBe('0');
      expect(received).toHaveLength(1);

      await readEventStream('/v1/sessions/sess_1/events/stream', () => {});
      expect(headers[1]['Last-Event-ID']).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
