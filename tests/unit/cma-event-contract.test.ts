/**
 * The `user.define_outcome` event contract, and the `initial_events` whitelist.
 *
 * `contracts/anthropic-cma/sessions.md` §2 states that only `user.message` and
 * `user.define_outcome` are accepted on creation, that `user.define_outcome` is
 * defaulted, and that a type outside the whitelist is rejected by index. §6 cites this
 * file for those claims, so every assertion here is about a sentence in the contract
 * rather than about a helper's shape.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OUTCOME_MAX_ITERATIONS,
  MAX_INITIAL_EVENTS,
  MAX_OUTCOME_MAX_ITERATIONS,
  normalizeDefineOutcome,
  normalizeInitialEvents,
} from '@/api/routes/initial-events.js';
import { toApiEvent } from '@/api/standard.js';
import type { SessionEvent } from '@/types/session.js';

const message = (text: string) => ({ type: 'user.message', content: [{ type: 'text', text }] });

/** A persisted event, as the log stores one: payload in `metadata`. */
function persistedEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: 'sevt_test',
    sessionId: 'sess_test',
    seq: 1,
    type: 'user.define_outcome',
    metadata: {
      outcome_id: 'outc_test',
      description: 'Ship a working endpoint',
      rubric: { type: 'text', content: 'The endpoint returns 200' },
      max_iterations: 5,
    },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    processedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as SessionEvent;
}

describe('initial_events validation', () => {
  it('treats an omitted or empty list as no initial events', () => {
    expect(normalizeInitialEvents(undefined)).toEqual({ ok: true, events: [] });
    expect(normalizeInitialEvents(null)).toEqual({ ok: true, events: [] });
    expect(normalizeInitialEvents([])).toEqual({ ok: true, events: [] });
  });

  it('accepts user.message and user.define_outcome, defaulting the iteration budget', () => {
    const result = normalizeInitialEvents([
      message('start'),
      {
        type: 'user.define_outcome',
        description: 'Ship a working endpoint',
        rubric: { type: 'text', content: 'The endpoint returns 200' },
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.events).toHaveLength(2);
    expect(result.events?.[0]).toEqual(message('start'));
    expect(result.events?.[1]).toMatchObject({
      type: 'user.define_outcome',
      description: 'Ship a working endpoint',
      rubric: { type: 'text', content: 'The endpoint returns 200' },
      max_iterations: DEFAULT_OUTCOME_MAX_ITERATIONS,
    });
  });

  it('rejects an event type outside the documented whitelist by index', () => {
    const result = normalizeInitialEvents([message('ok'), { type: 'user.interrupt' }]);

    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_initial_event_type');
    expect(result.message).toContain('initial_events[1].type');
    expect(result.message).toContain('user.define_outcome');
  });

  it('rejects more than the published ceiling', () => {
    const result = normalizeInitialEvents(Array.from({ length: MAX_INITIAL_EVENTS + 1 }, (_, i) => message(`m${i}`)));

    expect(result.ok).toBe(false);
    expect(result.code).toBe('too_many_initial_events');
  });

  it('rejects an element that is not an object and a malformed message payload', () => {
    expect(normalizeInitialEvents(['nope']).code).toBe('invalid_initial_events');
    const malformed = normalizeInitialEvents([{ type: 'user.message', content: { text: 'object' } }]);
    expect(malformed.ok).toBe(false);
    expect(malformed.message).toContain('initial_events[0].content');
  });

  it('reports a malformed outcome with the index it sits at', () => {
    const result = normalizeInitialEvents([
      message('ok'),
      { type: 'user.define_outcome', rubric: { type: 'text', content: 'x' } },
    ]);

    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_initial_events');
    expect(result.message).toContain('initial_events[1].description is required');
  });
});

describe('user.define_outcome normalization', () => {
  const valid = { description: 'Ship it', rubric: { type: 'text', content: 'Tests pass' } };

  it('defaults the budget and accepts both rubric forms', () => {
    const text = normalizeDefineOutcome(valid);
    expect(text.ok).toBe(true);
    if (text.ok) expect(text.event.max_iterations).toBe(DEFAULT_OUTCOME_MAX_ITERATIONS);

    const file = normalizeDefineOutcome({ description: 'Ship it', rubric: { type: 'file', file_id: 'file_1' } });
    expect(file.ok).toBe(true);
    if (file.ok) expect(file.event.rubric).toEqual({ type: 'file', file_id: 'file_1' });
  });

  it('requires a description and a well-formed rubric', () => {
    expect(normalizeDefineOutcome({ rubric: { type: 'text', content: 'x' } })).toMatchObject({ ok: false, message: 'description is required' });
    expect(normalizeDefineOutcome({ description: '  ', rubric: { type: 'text', content: 'x' } })).toMatchObject({ ok: false });
    expect(normalizeDefineOutcome({ description: 'x' })).toMatchObject({ ok: false, message: 'rubric is required' });
    expect(normalizeDefineOutcome({ description: 'x', rubric: { type: 'text' } })).toMatchObject({ ok: false });
    expect(normalizeDefineOutcome({ description: 'x', rubric: { type: 'file' } })).toMatchObject({ ok: false });
    expect(normalizeDefineOutcome({ description: 'x', rubric: { type: 'other' } })).toMatchObject({ ok: false, message: 'rubric.type must be text or file' });
  });

  it('rejects an out-of-range or non-integer budget rather than clamping it', () => {
    const tooHigh = normalizeDefineOutcome({ ...valid, max_iterations: MAX_OUTCOME_MAX_ITERATIONS + 1 });
    expect(tooHigh.ok).toBe(false);
    if (!tooHigh.ok) expect(tooHigh.message).toContain(`between 1 and ${MAX_OUTCOME_MAX_ITERATIONS}`);

    expect(normalizeDefineOutcome({ ...valid, max_iterations: 0 }).ok).toBe(false);
    expect(normalizeDefineOutcome({ ...valid, max_iterations: 2.5 }).ok).toBe(false);
    expect(normalizeDefineOutcome({ ...valid, max_iterations: MAX_OUTCOME_MAX_ITERATIONS }).ok).toBe(true);
  });
});

describe('user.define_outcome projection', () => {
  it('lifts the payload out of the metadata carrier to top-level fields', () => {
    const projected = toApiEvent(persistedEvent());

    expect(projected.type).toBe('user.define_outcome');
    expect(projected.content).toBeNull();
    expect(projected.outcome_id).toBe('outc_test');
    expect(projected.description).toBe('Ship a working endpoint');
    expect(projected.rubric).toEqual({ type: 'text', content: 'The endpoint returns 200' });
    expect(projected.max_iterations).toBe(5);
  });

  it('reports max_iterations as null on a declaration that predates the carrier', () => {
    const projected = toApiEvent(persistedEvent({
      metadata: { description: 'Ship it', rubric: { type: 'text', content: 'x' } },
    }));

    // `max_iterations` is `number | null` on the published event: present even
    // when the stored declaration has no budget to project, and `outcome_id` is
    // absent only on events persisted before admission assigned it.
    expect(projected.max_iterations).toBeNull();
    expect(projected).not.toHaveProperty('outcome_id');
  });

  it('does not project those fields onto another event type', () => {
    const projected = toApiEvent(persistedEvent({ type: 'user.message' }));

    expect(projected).not.toHaveProperty('description');
    expect(projected).not.toHaveProperty('rubric');
    expect(projected).not.toHaveProperty('max_iterations');
    expect(projected).not.toHaveProperty('outcome_id');
  });
});
