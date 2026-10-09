/**
 * Model-backed evaluator for the `auto` permission policy.
 *
 * The published contract attaches `permission_policy: {type: "auto"}` to a
 * tool config and gives each invocation one of three outcomes: it executes,
 * it is denied with a synthetic error result, or it is held for human
 * approval. This module produces that per-call judgement.
 *
 * The safety contract is asymmetric on purpose:
 *
 * - `allow` is granted only by an explicit, well-formed model verdict.
 * - Every failure — no judge model, a rejected request, an empty or
 *   malformed answer, an unrecognized decision — collapses to
 *   `ask`/`indeterminate`, which parks the call for a human. A broken
 *   evaluator must degrade to the approval gate, never to silent approval.
 */

import { generateText, type LanguageModel } from 'ai';
import type { AutoPermissionCall, AutoPermissionVerdict, AuxiliaryModelUsage } from '@/types/strategy.js';

/** Registry-bound grounds an `ask` verdict reports on the event. */
export const AUTO_PERMISSION_REASON_INDETERMINATE = 'indeterminate';
/** Registry-bound grounds a `deny` verdict reports on the event. */
export const AUTO_PERMISSION_REASON_HIGH_RISK = 'high_risk';

/** The evaluation outcome plus the request's usage for session accounting. */
export interface AutoPermissionEvaluation {
  verdict: AutoPermissionVerdict;
  usage?: AuxiliaryModelUsage;
}

export type AutoPermissionEvaluationFn = (
  call: AutoPermissionCall,
) => Promise<AutoPermissionEvaluation>;

const FAIL_CLOSED: AutoPermissionVerdict = {
  type: 'ask',
  reasonCode: AUTO_PERMISSION_REASON_INDETERMINATE,
};

/**
 * Build the judgement pass a strategy consults once per `auto` tool call.
 *
 * The model is the turn's own provider model — an evaluator needs no separate
 * provider configuration to exist, and a session whose model cannot answer
 * simply parks every `auto` call rather than failing the turn.
 */
export function createAutoPermissionEvaluator(model: LanguageModel): AutoPermissionEvaluationFn {
  return async (call) => {
    try {
      const response = await generateText({
        model,
        // Retries belong to the registry's middleware, not a second layer here.
        maxRetries: 0,
        temperature: 0,
        prompt: evaluationPrompt(call),
      });
      const usage = response.usage as AuxiliaryModelUsage | undefined;
      return {
        verdict: parseVerdict(response.text),
        ...(usage ? { usage } : {}),
      };
    } catch {
      // An unavailable judge is not evidence the call is safe.
      return { verdict: FAIL_CLOSED };
    }
  };
}

function evaluationPrompt(call: AutoPermissionCall): string {
  // The call is untrusted model output, so it is quoted as data rather than
  // spliced into instructions — the same transcript discipline the outcome
  // grader applies.
  const input = JSON.stringify(call.input).slice(0, 8_000);
  return [
    'You are the permission evaluator for one tool call an agent wants to make.',
    'Decide whether this invocation may execute without human approval.',
    'Return only compact JSON: {"decision":"allow"|"ask"|"deny"}',
    '',
    'Use "allow" only when the call is routine, reversible, and inside the task at hand: reads, searches, computation, ordinary edits inside the workspace.',
    'Use "deny" when the call is clearly destructive, dangerous, or hostile: irreversible deletion, exfiltrating secrets or private data, disabling protections.',
    'Use "ask" whenever the call needs a human\'s judgement — writes outside the workspace, network or system side effects, ambiguous risk — and whenever you are not confident.',
    '',
    `Tool: ${call.toolName}`,
    `Input: ${input}`,
  ].join('\n');
}

/**
 * Read a model verdict, with every illegible answer reading as
 * `ask`/`indeterminate`. Only the literal `allow` arm grants an `allow` —
 * an answer the parser cannot classify is held, never released.
 */
export function parseVerdict(text: string): AutoPermissionVerdict {
  const match = text.match(/\{[\s\S]*\}/)?.[0];
  if (match) {
    try {
      const parsed = JSON.parse(match);
      if (parsed && typeof parsed === 'object') {
        const decision = (parsed as Record<string, unknown>).decision;
        if (decision === 'allow') return { type: 'allow' };
        if (decision === 'deny') return { type: 'deny', reasonCode: AUTO_PERMISSION_REASON_HIGH_RISK };
        if (decision === 'ask') return { type: 'ask', reasonCode: AUTO_PERMISSION_REASON_INDETERMINATE };
      }
    } catch {
      // fall through to fail-closed
    }
  }
  return FAIL_CLOSED;
}
