/**
 * Outcome grader.
 *
 * The grader decides whether an outcome-driven session has met its rubric, in
 * its own context window: the prompt carries the description, the rubric and the
 * transcript of what the agent produced, and never the agent's system prompt or
 * tool configuration, so the evaluation is not anchored to how the agent chose
 * to work.
 *
 * Three verdicts are the grader's to give. `max_iterations_reached` and
 * `interrupted` are decided by the loop that drives it: they describe the
 * iteration budget and the session's lifecycle, not the deliverable.
 */

import { generateText } from 'ai';
import type { ModelRegistry } from '@/model/registry.js';

export type OutcomeGradeResult = 'satisfied' | 'needs_revision' | 'failed';

/**
 * Stable code carried by a grader that cannot run.
 *
 * Exported as a constant because `session.error.retry_status` is derived from
 * it: no model provider is a configuration problem rather than a transient one,
 * and reporting `unknown` would invite a client to retry a call that cannot
 * succeed until an operator configures a provider.
 */
export const OUTCOME_EVALUATOR_UNAVAILABLE_CODE = 'outcome_evaluator_unavailable';

export interface OutcomeGradeInput {
  /** What the agent was asked to produce. */
  description: string;
  /** The rubric the deliverable is measured against. */
  rubric: string;
  /** What the agent produced: its messages, tool calls and their results. */
  transcript: string;
  /**
   * The model reference the deliverable was produced with, for the grader's own
   * scoring call. Provider configurations carry no pinned model id — the Agent
   * names the model — so the default provider alone cannot answer `createModel`;
   * the session's agent reference is what resolves.
   */
  model?: string;
}

export interface OutcomeGrade {
  result: OutcomeGradeResult;
  /** Why the criteria passed or failed — the loop feeds this back to the agent. */
  explanation: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
  };
}

export interface OutcomeGrader {
  grade(input: OutcomeGradeInput): Promise<OutcomeGrade>;
}

export class OutcomeEvaluatorUnavailableError extends Error {
  readonly code = OUTCOME_EVALUATOR_UNAVAILABLE_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'OutcomeEvaluatorUnavailableError';
  }
}

/**
 * Build a grader backed by a language model.
 *
 * The whole prompt is the description, the rubric and the transcript. A model
 * call that throws is reported as an unavailable evaluator rather than as a
 * verdict: a network failure is not evidence about the deliverable.
 */
export function createModelOutcomeGrader(modelRegistry: ModelRegistry): OutcomeGrader {
  return {
    async grade(input) {
      const modelName = input.model ?? modelRegistry.getDefaultName();
      if (!modelName) {
        throw new OutcomeEvaluatorUnavailableError(
          'No default model provider is configured; the outcome grader cannot evaluate the deliverable.',
        );
      }
      let model: ReturnType<ModelRegistry['createModel']>;
      let response: Awaited<ReturnType<typeof generateText>>;
      try {
        model = modelRegistry.createModel(modelName);
      } catch (err) {
        // An unresolvable reference — including the bare provider name, which
        // carries no model id — is the same fact as no provider at all: the
        // grader cannot run, and that is configuration, not a verdict.
        throw new OutcomeEvaluatorUnavailableError(
          `Outcome grader model "${modelName}" could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        response = await generateText({
          model,
          temperature: 0,
          prompt: [
            'You are grading whether an agent session met an outcome.',
            'Use only the rubric and the transcript. Do not reward effort, only satisfied criteria.',
            'Return only compact JSON: {"result":"satisfied|needs_revision|failed","explanation":"..."}',
            'Use "satisfied" only when every rubric criterion is met.',
            'Use "needs_revision" when the deliverable is close and specific fixes remain.',
            'Use "failed" when the rubric cannot be satisfied by this deliverable.',
            '',
            `Outcome: ${input.description}`,
            '',
            `Rubric:\n${input.rubric}`,
            '',
            `Transcript:\n${input.transcript.slice(0, 24_000)}`,
          ].join('\n'),
        });
      } catch (err) {
        throw new OutcomeEvaluatorUnavailableError(
          `Outcome grader model call failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const parsed = parseGradeResponse(response.text);
      const usage = response.usage as {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
      } | undefined;
      return {
        result: parsed.result,
        explanation: parsed.explanation,
        ...(usage
          ? {
              usage: {
                input_tokens: usage.inputTokens ?? 0,
                output_tokens: usage.outputTokens ?? 0,
                ...(typeof usage.cachedInputTokens === 'number'
                  ? { cache_read_input_tokens: usage.cachedInputTokens }
                  : {}),
              },
            }
          : {}),
      };
    },
  };
}

function parseGradeResponse(text: string): { result: OutcomeGradeResult; explanation: string } {
  const trimmed = text.trim();
  const json = trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(json);
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    // An unparseable answer is not a pass; the explanation below says so.
  }

  const result: OutcomeGradeResult = parsed.result === 'satisfied' || parsed.result === 'failed'
    ? parsed.result
    : 'needs_revision';
  const explanation = typeof parsed.explanation === 'string' && parsed.explanation.trim()
    ? parsed.explanation.trim()
    : 'The grader returned no explanation.';
  return { result, explanation };
}
