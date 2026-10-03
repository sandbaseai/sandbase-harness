/**
 * `outcomeEvaluationsFromEvents` — the pure derivation behind the session
 * object's `outcome_evaluations` list.
 *
 * The route-level half lives in `tests/conformance/session-object-fields.test.ts`
 * (which rows the bulk query fetches) and the lifecycle half in
 * `tests/integration/outcome-grading.test.ts` (which events a real grading run
 * appends); this file pins the state machine itself: pending/running/
 * evaluating/terminal, declaration order, and the legacy-id claim.
 */

import { describe, expect, it } from 'vitest';
import {
  outcomeEvaluationsFromEvents,
  type OutcomeSourceEvent,
} from '@/core/outcomes/session-outcomes.js';

function define(metadata: Record<string, unknown>, createdAt = '2026-01-01T00:00:00.000Z'): OutcomeSourceEvent {
  return { type: 'user.define_outcome', metadata, createdAt };
}

function span(
  type: 'start' | 'ongoing' | 'end',
  metadata: Record<string, unknown>,
  processedAt = '2026-01-01T00:00:01.000Z',
): OutcomeSourceEvent {
  return { type: `span.outcome_evaluation_${type}`, metadata, processedAt };
}

const DECLARE = { outcome_id: 'outc_a', description: 'Ship a working endpoint' };

describe('outcomeEvaluationsFromEvents', () => {
  it('returns an empty list when no outcome was declared', () => {
    expect(outcomeEvaluationsFromEvents([])).toEqual([]);
    expect(outcomeEvaluationsFromEvents([
      { type: 'user.message' },
      { type: 'session.status_running' },
      span('end', { outcome_id: 'outc_x', result: 'satisfied', iteration: 0 }),
    ])).toEqual([]);
  });

  it('reports a declared outcome with no work yet as pending', () => {
    const [entry] = outcomeEvaluationsFromEvents([define(DECLARE)]);
    expect(entry).toEqual({
      type: 'outcome_evaluation',
      outcome_id: 'outc_a',
      description: 'Ship a working endpoint',
      result: 'pending',
      iteration: 0,
      explanation: null,
      completed_at: null,
    });
  });

  it('reports running once the turn has begun, before any span exists', () => {
    const events = [
      define(DECLARE),
      { type: 'session.status_running' },
    ];
    expect(outcomeEvaluationsFromEvents(events)[0]!.result).toBe('running');
  });

  it('bounds the running signal to the declaration that owns the turn', () => {
    // The status event belongs to the first outcome's turn; the second
    // declaration, appended while it runs, has not started.
    const events = [
      define(DECLARE),
      { type: 'session.status_running' },
      define({ outcome_id: 'outc_b', description: 'second' }),
    ];
    const [first, second] = outcomeEvaluationsFromEvents(events);
    expect(first!.result).toBe('running');
    expect(second!.result).toBe('pending');
  });

  it('reports evaluating while a start or ongoing span is open', () => {
    const events = [
      define(DECLARE),
      { type: 'session.status_running' },
      span('start', { outcome_id: 'outc_a', iteration: 0 }),
      span('ongoing', { outcome_id: 'outc_a', iteration: 0 }),
    ];
    const [entry] = outcomeEvaluationsFromEvents(events);
    expect(entry).toMatchObject({ result: 'evaluating', iteration: 0, completed_at: null });
  });

  it('reports the terminal end-span verdict with its timestamp', () => {
    const events = [
      define(DECLARE),
      span('start', { outcome_id: 'outc_a', iteration: 0 }),
      span('end', {
        outcome_id: 'outc_a',
        iteration: 0,
        result: 'satisfied',
        explanation: 'The endpoint returns 200.',
      }, '2026-01-01T00:00:05.000Z'),
    ];
    const [entry] = outcomeEvaluationsFromEvents(events);
    expect(entry).toEqual({
      type: 'outcome_evaluation',
      outcome_id: 'outc_a',
      description: 'Ship a working endpoint',
      result: 'satisfied',
      iteration: 0,
      explanation: 'The endpoint returns 200.',
      completed_at: '2026-01-01T00:00:05.000Z',
    });
  });

  it('keeps a needs_revision outcome in progress and counts the next cycle', () => {
    const events = [
      define(DECLARE),
      span('end', {
        outcome_id: 'outc_a',
        iteration: 0,
        result: 'needs_revision',
        explanation: 'Missing the error path.',
      }),
    ];
    const [entry] = outcomeEvaluationsFromEvents(events);
    expect(entry).toMatchObject({
      result: 'running',
      iteration: 1,
      explanation: 'Missing the error path.',
      completed_at: null,
    });
  });

  it('uses the last matching end span when several evaluations ran', () => {
    const events = [
      define(DECLARE),
      span('end', { outcome_id: 'outc_a', iteration: 0, result: 'needs_revision', explanation: 'one' }),
      span('end', {
        outcome_id: 'outc_a',
        iteration: 1,
        result: 'failed',
        explanation: 'Cannot be met.',
      }, '2026-01-01T00:00:09.000Z'),
    ];
    const [entry] = outcomeEvaluationsFromEvents(events);
    expect(entry).toMatchObject({
      result: 'failed',
      iteration: 1,
      explanation: 'Cannot be met.',
      completed_at: '2026-01-01T00:00:09.000Z',
    });
  });

  it('keeps declaration order and joins spans by outcome_id, not position', () => {
    const events = [
      define({ outcome_id: 'outc_a', description: 'first' }),
      define({ outcome_id: 'outc_b', description: 'second' }),
      // The second outcome's span precedes the first's in the log: spans join
      // on outcome_id, so order in the list still follows the declarations.
      span('end', { outcome_id: 'outc_b', iteration: 0, result: 'satisfied' }),
      span('end', { outcome_id: 'outc_a', iteration: 0, result: 'failed' }),
    ];
    const [first, second] = outcomeEvaluationsFromEvents(events);
    expect(first!.outcome_id).toBe('outc_a');
    expect(first!.result).toBe('failed');
    expect(second!.outcome_id).toBe('outc_b');
    expect(second!.result).toBe('satisfied');
  });

  it('claims span ids for declarations persisted before outcome_id existed', () => {
    // A pre-id declaration has no metadata.outcome_id, but the loop always
    // wrote one into its spans. Loops run serially, so the leftover span id
    // belongs to the unclaimed declaration.
    const events = [
      define({ description: 'legacy outcome' }),
      { type: 'session.status_running' },
      span('start', { outcome_id: 'outc_legacy_real', iteration: 0 }),
      span('end', { outcome_id: 'outc_legacy_real', iteration: 0, result: 'satisfied' }),
    ];
    const [entry] = outcomeEvaluationsFromEvents(events);
    expect(entry).toMatchObject({
      outcome_id: 'outc_legacy_real',
      result: 'satisfied',
      description: 'legacy outcome',
    });
  });

  it('leaves a placeholder id on a legacy declaration that never ran', () => {
    const events = [
      define({ description: 'never ran' }),
      define({ outcome_id: 'outc_new', description: 'modern' }),
      { type: 'session.status_running' },
    ];
    const [legacy, modern] = outcomeEvaluationsFromEvents(events);
    // No leftover span id exists, so the placeholder stands in: the entry is
    // honest about being pending rather than inventing a verdict.
    expect(legacy!.result).toBe('pending');
    expect(legacy!.outcome_id).toMatch(/^outc_/);
    expect(modern!.outcome_id).toBe('outc_new');
    expect(modern!.result).toBe('running');
  });

  it('treats every terminal verdict the loop can write as terminal', () => {
    for (const result of ['satisfied', 'failed', 'max_iterations_reached', 'interrupted', 'budget_reached']) {
      const [entry] = outcomeEvaluationsFromEvents([
        define(DECLARE),
        span('end', { outcome_id: 'outc_a', iteration: 2, result }),
      ]);
      expect(entry!.result).toBe(result);
      expect(entry!.completed_at).not.toBeNull();
    }
  });
});
