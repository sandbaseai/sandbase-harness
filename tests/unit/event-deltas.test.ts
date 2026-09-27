/**
 * `event_deltas[]` preview contract.
 *
 * The published contract makes previews an opt-in per stream connection. The
 * properties worth pinning in tests are the ones a plausible implementation
 * gets subtly wrong:
 *
 *   - only `agent.message` and `agent.thinking` are accepted, and a request is
 *     rejected outright rather than silently previewing a subset;
 *   - previews never persist, so they must not carry an `id` that a reconnecting
 *     client would send back as a resume cursor;
 *   - `event_start.event.id`, `event_delta.event_id`, and the buffered event's
 *     `id` are the same value;
 *   - `agent.thinking` previews get an `event_start` and no delta, because the
 *     buffered event carries no reasoning text and a delta would be invented.
 */

import { describe, expect, it } from 'vitest';
import {
  EVENT_DELTA_TYPES,
  EventDeltaProjector,
  MAX_EVENT_DELTAS,
  parseEventDeltas,
} from '../../src/core/session/event-deltas.js';
import type { SessionEvent } from '../../src/types/session.js';

describe('event_deltas[] request validation', () => {
  it('treats an absent parameter as "no previews"', () => {
    const parsed = parseEventDeltas(undefined);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.types).toEqual([]);
  });

  it('accepts both published preview types', () => {
    const parsed = parseEventDeltas(['agent.message', 'agent.thinking']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.types).toEqual(['agent.message', 'agent.thinking']);
    expect([...EVENT_DELTA_TYPES]).toEqual(['agent.message', 'agent.thinking']);
  });

  it('accepts a single value sent once rather than as an array', () => {
    const parsed = parseEventDeltas('agent.message');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.types).toEqual(['agent.message']);
  });

  it('collapses a repeated value instead of previewing it twice', () => {
    const parsed = parseEventDeltas(['agent.message', 'agent.message']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.types).toEqual(['agent.message']);
  });

  it('rejects an unsupported value with a 400-worthy message', () => {
    const parsed = parseEventDeltas(['agent.message', 'session.error']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain('session.error');
  });

  it('rejects an empty value rather than treating it as a no-op', () => {
    expect(parseEventDeltas(['']).ok).toBe(false);
  });

  it('rejects more than the published cap of values', () => {
    const tooMany = Array.from({ length: MAX_EVENT_DELTAS + 1 }, () => 'agent.message');
    const parsed = parseEventDeltas(tooMany);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain(String(MAX_EVENT_DELTAS));
  });

  it('accepts exactly the published cap', () => {
    const exact = Array.from({ length: MAX_EVENT_DELTAS }, () => 'agent.message');
    const parsed = parseEventDeltas(exact);
    expect(parsed.ok).toBe(true);
  });
});

function carrier(type: SessionEvent['type'], fields: Record<string, unknown>): SessionEvent {
  return {
    id: `stream_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'sess_1',
    seq: 0,
    type,
    createdAt: new Date(),
    ...fields,
  } as SessionEvent;
}

describe('event delta projector', () => {
  it('emits nothing when the connection did not opt in', () => {
    const projector = new EventDeltaProjector([]);
    expect(projector.active).toBe(false);
    expect(projector.framesFor(carrier('agent.message_chunk', { message_id: 'sevt_1', delta: 'hi' }))).toEqual([]);
  });

  it('opens with event_start carrying the previewed type and id, then streams deltas', () => {
    const projector = new EventDeltaProjector(['agent.message']);
    const first = projector.framesFor(carrier('agent.message_stream_start', { message_id: 'sevt_abc' }));
    expect(first).toEqual([{ type: 'event_start', event: { type: 'agent.message', id: 'sevt_abc' } }]);

    const delta = projector.framesFor(carrier('agent.message_chunk', { message_id: 'sevt_abc', delta: 'Here' }));
    expect(delta).toEqual([
      {
        type: 'event_delta',
        event_id: 'sevt_abc',
        delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'Here' } },
      },
    ]);
  });

  it('emits at most one event_start per previewed id', () => {
    const projector = new EventDeltaProjector(['agent.message']);
    projector.framesFor(carrier('agent.message_stream_start', { message_id: 'sevt_abc' }));
    const again = projector.framesFor(carrier('agent.message_stream_start', { message_id: 'sevt_abc' }));
    expect(again).toEqual([]);
  });

  it('does not fabricate a delta for agent.thinking', () => {
    const projector = new EventDeltaProjector(['agent.thinking']);
    const frames = projector.framesFor(carrier('agent.thinking_stream_start', { message_id: 'sevt_think' }));
    expect(frames).toEqual([{ type: 'event_start', event: { type: 'agent.thinking', id: 'sevt_think' } }]);
    // A thinking carrier that happens to carry text must still not produce a
    // content delta: the contract says the buffered event has no content, so
    // previewing text would render reasoning that never lands in the log.
    const followUp = projector.framesFor(carrier('agent.thinking_chunk', { message_id: 'sevt_think', delta: 'secret' }));
    expect(followUp).toEqual([]);
  });

  it('previews only the opted-in type when both are selected', () => {
    const projector = new EventDeltaProjector(['agent.thinking']);
    expect(projector.framesFor(carrier('agent.message_chunk', { message_id: 'sevt_1', delta: 'x' }))).toEqual([]);
  });

  it('reconciles by the buffered event id and allows a later preview of the same id', () => {
    const projector = new EventDeltaProjector(['agent.message']);
    projector.framesFor(carrier('agent.message_stream_start', { message_id: 'sevt_abc' }));

    projector.reconcile({
      id: 'sevt_abc',
      sessionId: 'sess_1',
      seq: 4,
      type: 'agent.message',
      createdAt: new Date(),
    } as SessionEvent);

    // A fresh preview after reconciliation is a new draft, not a duplicate.
    const next = projector.framesFor(carrier('agent.message_stream_start', { message_id: 'sevt_abc' }));
    expect(next).toHaveLength(1);
  });

  it('keeps one session\'s previews open when another session reconciles', () => {
    // `event-deltas.ts:82-88` states the use case this class exists for: "Keyed by
    // session so a projector instance can be reused across a filtered broadcast
    // without leaking previews between sessions." The tests above all drive one
    // connection, so nothing exercised the reuse. Note that `started` is keyed by
    // the previewed id alone - the session never enters the key - so what this case
    // actually pins is that the sharing is safe: reconciling one session's buffered
    // event must not close another session's open preview, because the two previews
    // are distinct ids and each is tracked on its own.
    const projector = new EventDeltaProjector(['agent.message']);

    // Session A opens a preview and streams into it.
    expect(projector.framesFor(carrier('agent.message_stream_start', { message_id: 'sevt_a', sessionId: 'sess_a' })))
      .toEqual([{ type: 'event_start', event: { type: 'agent.message', id: 'sevt_a' } }]);
    expect(projector.framesFor(carrier('agent.message_chunk', { message_id: 'sevt_a', sessionId: 'sess_a', delta: 'A' })))
      .toHaveLength(1);

    // Session B's own preview opens on the same instance: A's state must not
    // suppress it, and B's frames must name B's id.
    const bStart = projector.framesFor(carrier('agent.message_stream_start', { message_id: 'sevt_b', sessionId: 'sess_b' }));
    expect(bStart).toEqual([{ type: 'event_start', event: { type: 'agent.message', id: 'sevt_b' } }]);
    const bDelta = projector.framesFor(carrier('agent.message_chunk', { message_id: 'sevt_b', sessionId: 'sess_b', delta: 'B' }));
    expect(bDelta.map((frame) => frame.event_id ?? (frame.event as { id?: string } | undefined)?.id))
      .toEqual(['sevt_b']);

    // Session A's buffered event lands. It reconciles A's preview and nothing else.
    projector.reconcile({
      id: 'sevt_a',
      sessionId: 'sess_a',
      seq: 9,
      type: 'agent.message',
      createdAt: new Date(),
    } as SessionEvent);

    // B's preview is still open: a repeat start is still suppressed, and a further
    // chunk is still a delta rather than a second opening frame.
    expect(projector.framesFor(carrier('agent.message_stream_start', { message_id: 'sevt_b', sessionId: 'sess_b' })))
      .toEqual([]);
    const afterReconcile = projector.framesFor(carrier('agent.message_chunk', { message_id: 'sevt_b', sessionId: 'sess_b', delta: 'B2' }));
    expect(afterReconcile).toHaveLength(1);
    expect(afterReconcile[0]!.type).toBe('event_delta');

    // And A may open a fresh draft, which must not disturb B either.
    expect(projector.framesFor(carrier('agent.message_stream_start', { message_id: 'sevt_a', sessionId: 'sess_a' })))
      .toHaveLength(1);
    expect(projector.framesFor(carrier('agent.message_chunk', { message_id: 'sevt_b', sessionId: 'sess_b', delta: 'B3' })))
      .toHaveLength(1);
  });

  it('reads the content-block index from the carrier when one is supplied', () => {
    const projector = new EventDeltaProjector(['agent.message']);
    const frames = projector.framesFor(
      carrier('agent.message_chunk', { message_id: 'sevt_1', delta: 'x', index: 2 }),
    );
    // The first frame for a never-seen id is the `event_start`; the delta is next.
    expect(frames.map((frame) => frame.type)).toEqual(['event_start', 'event_delta']);
    expect(frames[1]?.delta).toEqual({
      type: 'content_delta',
      index: 2,
      content: { type: 'text', text: 'x' },
    });
  });

  it('ignores a chunk with no text rather than emitting an empty delta', () => {
    const projector = new EventDeltaProjector(['agent.message']);
    projector.framesFor(carrier('agent.message_stream_start', { message_id: 'sevt_1' }));
    expect(projector.framesFor(carrier('agent.message_chunk', { message_id: 'sevt_1', delta: '' }))).toEqual([]);
  });

  it('emits nothing for an event that is not a preview carrier', () => {
    const projector = new EventDeltaProjector(['agent.message']);
    expect(projector.framesFor({
      id: 'sevt_tool',
      sessionId: 'sess_1',
      seq: 7,
      type: 'agent.tool_use',
      createdAt: new Date(),
    } as SessionEvent)).toEqual([]);
  });

  it('never puts an id or processed_at on a preview frame', () => {
    const projector = new EventDeltaProjector(['agent.message']);
    const frames = [
      ...projector.framesFor(carrier('agent.message_stream_start', { message_id: 'sevt_1' })),
      ...projector.framesFor(carrier('agent.message_chunk', { message_id: 'sevt_1', delta: 'x' })),
    ];
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame).not.toHaveProperty('id');
      expect(frame).not.toHaveProperty('processed_at');
      expect(frame).not.toHaveProperty('seq');
    }
  });
});
