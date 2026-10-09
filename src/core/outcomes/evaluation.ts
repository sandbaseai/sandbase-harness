/**
 * One outcome evaluation, published on the session's event log.
 *
 * The sequence is fixed and ordered — `start`, `ongoing`, `end` — because a
 * client watches those three to know when an outcome is being measured, that it
 * is still running, and what was decided. The `ongoing` span carries no partial
 * verdict: the grader's internal reasoning is opaque, and inventing progress
 * would be a claim the runtime cannot support.
 *
 * The end span is appended on every path, including the one where the grader
 * throws. A client waiting on `span.outcome_evaluation_end` would otherwise hang
 * on an outcome that is already over, and the failure would look like an
 * evaluation still in flight.
 */

import type { OutcomeGrader, OutcomeGradeUsage } from './grader.js';
import type { SessionEvent } from '@/types/session.js';
import type { OutcomeEvaluationResult } from '@/types/cma-protocol.js';

/** The three event types one evaluation publishes, in order. */
export const OUTCOME_EVALUATION_EVENT_TYPES = [
  'span.outcome_evaluation_start',
  'span.outcome_evaluation_ongoing',
  'span.outcome_evaluation_end',
] as const;

export type OutcomeEvaluationEventType = (typeof OUTCOME_EVALUATION_EVENT_TYPES)[number];

/** Append one span event and broadcast it to live subscribers. */
export interface OutcomeSpanLogger {
  append(input: { type: OutcomeEvaluationEventType; metadata: Record<string, unknown> }): SessionEvent;
  /**
   * Persist the grading request's usage the way a turn records its own.
   *
   * Optional so an embedder without a durable session aggregate can still
   * drive the loop; the runtime's session path always supplies it.
   */
  recordModelUsage?(usage: OutcomeGradeUsage): void;
}

export interface OutcomeEvaluationInput {
  /** Identifies the declared outcome this evaluation belongs to. */
  outcomeId: string;
  /** `0` for the evaluation of the declared outcome, `n` after the n-th revision. */
  iteration: number;
  /** What the agent was asked to produce. */
  description: string;
  /** The rubric text, already resolved from inline content or a file. */
  rubric: string;
  /** What the agent produced, as a grader-facing transcript. */
  readTranscript: () => string;
  /** The model reference the agent produced with, for the grader's scoring call. */
  model?: string;
  grader: OutcomeGrader;
  logger: OutcomeSpanLogger;
  /**
   * Whether the iteration budget is spent.
   *
   * A `needs_revision` verdict is then published as `max_iterations_reached`
   * instead: asking for another revision the loop cannot run would be a promise
   * the runtime does not keep, and a client reading the span would wait for a
   * turn that never comes. The verdict itself is unchanged — the budget, not the
   * grader, decides that no more work follows.
   */
  budgetSpent?: boolean;
}

export interface OutcomeEvaluation {
  result: OutcomeEvaluationResult;
  explanation: string;
}

/**
 * Run one evaluation: open the span, grade, close the span.
 *
 * A grader failure closes the end span as `failed` and then propagates, so the
 * evaluator's failure becomes the session's error instead of quietly ending the
 * outcome as if the deliverable had been judged.
 */
export async function runOutcomeEvaluation(input: OutcomeEvaluationInput): Promise<OutcomeEvaluation> {
  const metadata = { outcome_id: input.outcomeId, iteration: input.iteration };
  const start = input.logger.append({ type: 'span.outcome_evaluation_start', metadata });
  input.logger.append({ type: 'span.outcome_evaluation_ongoing', metadata });

  try {
    const grade = await input.grader.grade({
      description: input.description,
      rubric: input.rubric,
      transcript: input.readTranscript(),
      ...(input.model ? { model: input.model } : {}),
    });
    const result: OutcomeEvaluationResult =
      input.budgetSpent === true && grade.result === 'needs_revision' ? 'max_iterations_reached' : grade.result;
    // The grading call is a model request like any other, so its usage joins
    // the canonical record before the verdict it paid for is published.
    if (grade.usage) input.logger.recordModelUsage?.(grade.usage);
    input.logger.append({
      type: 'span.outcome_evaluation_end',
      metadata: {
        ...metadata,
        outcome_evaluation_start_id: start.id,
        result,
        explanation: grade.explanation,
        ...(grade.usage ? { usage: grade.usage } : {}),
      },
    });
    return { result, explanation: grade.explanation };
  } catch (err) {
    const explanation = err instanceof Error ? err.message : String(err);
    input.logger.append({
      type: 'span.outcome_evaluation_end',
      metadata: {
        ...metadata,
        outcome_evaluation_start_id: start.id,
        result: 'failed',
        explanation,
      },
    });
    throw err;
  }
}
