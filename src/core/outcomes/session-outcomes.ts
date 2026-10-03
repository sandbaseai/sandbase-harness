/**
 * `outcome_evaluations` on the session object.
 *
 * The published `BetaManagedAgentsSession` requires the list, and this runtime
 * derives it from the one thing that already records every fact it needs: the
 * append-only event log. Each `user.define_outcome` event yields one entry —
 * `outcome_id` is generated at admission and written into the event's metadata
 * carrier, so the declaration and the `span.outcome_evaluation_*` triples the
 * grading loop appends share the id that joins them.
 *
 * `result` is the outcome's current state, not the last span's verdict: while
 * the outcome is still in progress it reports `pending` (declared, no work
 * yet), `running` (the agent is producing or revising), or `evaluating` (the
 * grader is scoring); once the loop closes it reports the terminal end
 * span's result — `satisfied`, `failed`, `max_iterations_reached`,
 * `interrupted`, or the local `budget_reached` extension. A `needs_revision`
 * end is deliberately *not* terminal here: the loop owes another turn, so the
 * state is `running` or `evaluating` again.
 */

import type { SessionEvent } from '@/types/session.js';

/**
 * The minimal row the derivation reads — `type`, the metadata carrier, and a
 * timestamp. `SessionEvent` satisfies it, and the session-list route's bulk
 * rows do too, so one function serves both the single read and the page.
 */
export interface OutcomeSourceEvent {
  type: string;
  metadata?: Record<string, unknown> | null;
  processedAt?: Date | string | null;
  createdAt?: Date | string | null;
}

/** One entry of the session object's `outcome_evaluations` list. */
export interface SessionOutcomeEvaluation {
  type: 'outcome_evaluation';
  /** Server-generated `outc_` id the spans reference. */
  outcome_id: string;
  /** What the agent should produce, copied from the declaration. */
  description: string;
  /** `pending`/`running`/`evaluating` while in progress; the terminal verdict once closed. */
  result: string;
  /** 0-indexed revision cycle the outcome is currently on. */
  iteration: number;
  /** The most recent evaluation's verdict text; `null` before any evaluation ran. */
  explanation: string | null;
  /** When the outcome reached its terminal result; `null` while in progress. */
  completed_at: string | null;
}

const DEFINE_TYPE = 'user.define_outcome';
const SPAN_START = 'span.outcome_evaluation_start';
const SPAN_ONGOING = 'span.outcome_evaluation_ongoing';
const SPAN_END = 'span.outcome_evaluation_end';
const SPAN_TYPES = new Set([SPAN_START, SPAN_ONGOING, SPAN_END]);

/**
 * A `needs_revision` end means another cycle follows, so the outcome is still
 * in progress. Every other end result closes the outcome. `budget_reached` is
 * the local verdict a session at its spending ceiling closes with; it is part
 * of this list deliberately, because withholding it would report an outcome
 * that can never run again as still `running`.
 */
const TERMINAL_RESULTS = new Set([
  'satisfied',
  'failed',
  'max_iterations_reached',
  'interrupted',
  'budget_reached',
]);

/** Work indicator between a declaration and its first span: a turn began. */
function isWorkEvent(type: string): boolean {
  return type === 'session.status_running' || type.startsWith('agent.');
}

function timeIso(event: OutcomeSourceEvent): string | null {
  const at = event.processedAt ?? event.createdAt;
  if (!at) return null;
  return (at instanceof Date ? at : new Date(at)).toISOString();
}

function meta(event: OutcomeSourceEvent): Record<string, unknown> {
  return (event.metadata ?? {}) as Record<string, unknown>;
}

/**
 * Derive the session object's `outcome_evaluations` from its event log.
 *
 * `events` must be in log order. The list route passes only the outcome and
 * `session.status_running` rows, which this function is written to need — it
 * never reads content blocks or token counters.
 *
 * Declarations persisted before `outcome_id` was assigned at admission carry
 * no id in their metadata, while their spans do (the loop always wrote one).
 * Those legacy outcomes are still recoverable: outcome loops run serially on
 * a session's one execution chain, so the k-th unclaimed span id in
 * first-appearance order belongs to the k-th declaration without an id.
 */
export function outcomeEvaluationsFromEvents(
  events: readonly OutcomeSourceEvent[],
): SessionOutcomeEvaluation[] {
  const defines = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === DEFINE_TYPE);
  if (defines.length === 0) return [];

  // Claimed ids come from the declarations themselves; the leftovers, in the
  // order their spans first appear, are the legacy ids to hand out.
  const declaredIds = new Set(
    defines.map(({ event }) => meta(event).outcome_id).filter((id): id is string => typeof id === 'string'),
  );
  const unclaimedSpanIds: string[] = [];
  for (const event of events) {
    if (!SPAN_TYPES.has(event.type)) continue;
    const id = meta(event).outcome_id;
    if (typeof id === 'string' && !declaredIds.has(id) && !unclaimedSpanIds.includes(id)) {
      unclaimedSpanIds.push(id);
    }
  }

  let legacyIndex = 0;
  return defines.map(({ event: define, index: defineIndex }, defineOrdinal) => {
    const metadata = meta(define);
    // A declaration whose id was never written claims the next leftover span
    // id; with none left, a placeholder keeps the entry honest (its outcome
    // predates the id's arrival, so no span will ever reference it).
    const hasDeclaredId = typeof metadata.outcome_id === 'string';
    const outcomeId = hasDeclaredId
      ? (metadata.outcome_id as string)
      : unclaimedSpanIds[legacyIndex] ?? `outc_legacy_${defineOrdinal}`;
    if (!hasDeclaredId) legacyIndex += 1;

    const nextDefineIndex = defines[defineOrdinal + 1]?.index ?? events.length;
    const spans = events.filter(
      (event) => SPAN_TYPES.has(event.type) && meta(event).outcome_id === outcomeId,
    );
    const ends = spans.filter((event) => event.type === SPAN_END);
    const lastEnd = ends.at(-1);
    const lastEndResult = lastEnd ? meta(lastEnd).result : undefined;
    const lastEndIteration = spanIteration(lastEnd);
    const lastEndExplanation =
      lastEnd && typeof meta(lastEnd).explanation === 'string' ? meta(lastEnd).explanation as string : null;

    // Terminal: the last end closed the outcome.
    if (lastEnd && typeof lastEndResult === 'string' && TERMINAL_RESULTS.has(lastEndResult)) {
      return {
        type: 'outcome_evaluation',
        outcome_id: outcomeId,
        description: typeof metadata.description === 'string' ? metadata.description : '',
        result: lastEndResult,
        iteration: lastEndIteration ?? 0,
        explanation: lastEndExplanation,
        completed_at: timeIso(lastEnd),
      };
    }

    // An evaluation in flight is any start/ongoing after the last end — or
    // simply any start/ongoing when the last end was a needs_revision verdict,
    // because the next cycle's start is what proves the grader is scoring now.
    const openSpan = spans.at(-1);
    if (openSpan && openSpan !== lastEnd) {
      return {
        type: 'outcome_evaluation',
        outcome_id: outcomeId,
        description: typeof metadata.description === 'string' ? metadata.description : '',
        result: 'evaluating',
        iteration: spanIteration(openSpan) ?? (lastEnd ? (lastEndIteration ?? -1) + 1 : 0),
        explanation: lastEndExplanation,
        completed_at: null,
      };
    }

    // A needs_revision end with no newer span means the loop owes another turn.
    if (lastEnd) {
      return {
        type: 'outcome_evaluation',
        outcome_id: outcomeId,
        description: typeof metadata.description === 'string' ? metadata.description : '',
        result: 'running',
        iteration: (lastEndIteration ?? -1) + 1,
        explanation: lastEndExplanation,
        completed_at: null,
      };
    }

    // No spans yet: `running` once the declaration's own turn has begun —
    // bounded by the next declaration so a later outcome's turn is not counted
    // as this one's work.
    const workBegan = events
      .slice(defineIndex + 1, nextDefineIndex)
      .some((event) => isWorkEvent(event.type));
    return {
      type: 'outcome_evaluation',
      outcome_id: outcomeId,
      description: typeof metadata.description === 'string' ? metadata.description : '',
      result: workBegan ? 'running' : 'pending',
      iteration: 0,
      explanation: null,
      completed_at: null,
    };
  });
}

function spanIteration(event: OutcomeSourceEvent | undefined): number | undefined {
  if (!event) return undefined;
  const value = meta(event).iteration;
  return typeof value === 'number' ? value : undefined;
}
