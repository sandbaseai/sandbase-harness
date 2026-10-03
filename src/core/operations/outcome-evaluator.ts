import { generateText } from 'ai';
import type { ModelRegistry } from '@/model/registry.js';

export type OutcomeEvaluationInput = {
  transcript: string;
  criteria: string[];
  objective: string;
  passThreshold: number;
  evaluator: string;
};

export type OutcomeEvaluationResult = {
  status: 'passed' | 'failed' | 'inconclusive';
  score: number;
  summary: string;
  details: Record<string, unknown>;
};

export type OutcomeEvaluator = (input: OutcomeEvaluationInput) => Promise<OutcomeEvaluationResult> | OutcomeEvaluationResult;

export function evaluateDeterministicOutcome(input: OutcomeEvaluationInput): OutcomeEvaluationResult {
  const normalizedCriteria = input.criteria.length > 0 ? input.criteria : [input.objective];
  const checks = normalizedCriteria.map((criterion) => {
    const tokens = criterion
      .toLowerCase()
      .replace(/[^a-z0-9_\-\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3);
    const matched = tokens.length === 0
      ? false
      : tokens.some((token) => input.transcript.includes(token));
    return { criterion, matched };
  });
  const matchedCount = checks.filter((check) => check.matched).length;
  const score = checks.length === 0 ? 0 : matchedCount / checks.length;
  const status = score >= input.passThreshold ? 'passed' : score > 0 ? 'inconclusive' : 'failed';
  return {
    status,
    score,
    summary: `${matchedCount}/${checks.length} outcome criteria matched by the session transcript.`,
    details: {
      evaluator: 'deterministic_transcript_matcher',
      pass_threshold: input.passThreshold,
      checks,
    },
  };
}

export function createModelAssistedOutcomeEvaluator(modelRegistry: ModelRegistry): OutcomeEvaluator {
  return async (input) => {
    const modelName = modelRegistry.getDefaultName();
    if (!modelName) {
      return unsupportedModelEvaluator(input, 'No default model provider is configured.');
    }

    try {
      const model = modelRegistry.createModel(modelName);
      const response = await generateText({
        model,
        // Retries belong to the registry's middleware, not a second layer here.
        maxRetries: 0,
        temperature: 0,
        prompt: [
          'Evaluate whether an agent session satisfied an outcome.',
          'Return only compact JSON with fields: score (0..1), status (passed|failed|inconclusive), summary, checks.',
          `Pass threshold: ${input.passThreshold}`,
          `Objective: ${input.objective}`,
          `Criteria: ${JSON.stringify(input.criteria.length ? input.criteria : [input.objective])}`,
          `Transcript:\n${input.transcript.slice(0, 24_000)}`,
        ].join('\n\n'),
      });
      const parsed = parseModelEvaluation(response.text);
      const score = clampScore(parsed.score);
      const status = normalizeModelStatus(parsed.status, score, input.passThreshold);
      return {
        status,
        score,
        summary: typeof parsed.summary === 'string' && parsed.summary.trim()
          ? parsed.summary.trim()
          : `Model-assisted evaluator scored this session ${score.toFixed(2)}.`,
        details: {
          evaluator: input.evaluator,
          model: modelName,
          pass_threshold: input.passThreshold,
          checks: Array.isArray(parsed.checks) ? parsed.checks : [],
        },
      };
    } catch (err: any) {
      return unsupportedModelEvaluator(input, err?.message ?? String(err));
    }
  };
}

function unsupportedModelEvaluator(input: OutcomeEvaluationInput, reason: string): OutcomeEvaluationResult {
  return {
    status: 'inconclusive',
    score: 0,
    summary: `Model-assisted evaluation could not run: ${reason}`,
    details: {
      evaluator: input.evaluator,
      pass_threshold: input.passThreshold,
      unsupported: true,
      reason,
    },
  };
}

function parseModelEvaluation(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const json = trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { summary: trimmed };
  }
}

function clampScore(value: unknown): number {
  const score = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score));
}

function normalizeModelStatus(value: unknown, score: number, passThreshold: number): OutcomeEvaluationResult['status'] {
  if (value === 'passed' || value === 'failed' || value === 'inconclusive') return value;
  return score >= passThreshold ? 'passed' : score > 0 ? 'inconclusive' : 'failed';
}
