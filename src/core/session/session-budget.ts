/**
 * Session budget.
 *
 * A budget is an optional hard ceiling on what a session may spend, expressed
 * as a list cost. The published contract enforces it **between model requests**,
 * pauses rather than terminates when it is reached, and only accepts events that
 * settle work already in flight. This module owns the value object and every
 * rule that decides whether a budget may exist or change; the enforcement point
 * lives in the strategy loop and the manager.
 *
 * Two local decisions are recorded here rather than hidden:
 *
 * 1. Prices come from {@link CostProfile}, not from vendor pricing. A model the
 *    profile cannot price has "no list price", and a budgeted session naming
 *    such a model is refused — the published rejection path, reached for a local
 *    reason.
 * 2. Consumed cost is derived from the append-only event log on demand instead
 *    of from a running counter column. The log is the execution source of truth,
 *    and `span.model_request_end` is already the one canonical usage record per
 *    model request, so a second counter could only disagree with it.
 */

import type { Database } from '@/core/db/database.js';
import type { SessionEvent } from '@/types/session.js';
import type { SessionBudget } from '@/types/cma-protocol.js';
import { activeSecondsFromEvents, serverToolUseFromEvents } from './session-usage.js';
import {
  centsToMicrocents,
  computeCost,
  consumptionFromEvents,
  type CostBreakdown,
  type CostProfile,
  type ModelConsumption,
} from './cost-profile.js';

// ============================================================
// Wire shape
// ============================================================

export type { MonetaryAmount, SessionBudget } from '@/types/cma-protocol.js';

/**
 * Stable error codes for every budget refusal.
 *
 * Exported so the route, the manager, and the tests compare against one
 * spelling. A literal in two places is how a client ends up being told to retry
 * something that can never succeed.
 */
export const BUDGET_ERROR_CODES = {
  /** `amount` is not an integer number of cents, or is <= 0, or has a leading zero. */
  invalidAmount: 'budget_invalid_amount',
  /** `currency` is not `USD`. */
  invalidCurrency: 'budget_invalid_currency',
  /** `type` is not `limit`, or the object has an unexpected shape. */
  invalidShape: 'budget_invalid_shape',
  /** The session was created without a budget, or its budget was removed. */
  createOnly: 'budget_create_only',
  /** The new cap is not strictly greater than the consumed list cost. */
  notRaised: 'budget_not_raised',
  /** The agent (or a roster member) runs a model with no list price. */
  modelNotBudgetable: 'model_not_budgetable',
  /** Consumption includes a model the profile cannot price, so metering stopped. */
  unpriceable: 'budget_unpriceable',
  /** A work-starting event arrived while the session is paused at its cap. */
  reached: 'budget_reached',
} as const;

export type BudgetErrorCode = typeof BUDGET_ERROR_CODES[keyof typeof BUDGET_ERROR_CODES];

/**
 * Events a session at its cap still accepts.
 *
 * Each one settles work that was already admitted: a pending approval, an
 * externally executed tool result, or an interrupt. Everything else would start
 * new model work, which is exactly what the cap forbids.
 *
 * `user.tool_result` settles a builtin call a self-hosted worker executed, the
 * same way `user.custom_tool_result` settles a caller-declared one — both are
 * admitted because they resolve work already parked rather than starting any.
 */
export const BUDGET_SETTLEMENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'user.tool_confirmation',
  'user.custom_tool_result',
  'user.tool_result',
  'user.interrupt',
]);

/** Human-readable list used in the 400 body, so the client learns what it may send. */
export const BUDGET_SETTLEMENT_EVENT_LIST = [...BUDGET_SETTLEMENT_EVENT_TYPES].join(', ');

export interface BudgetValidation {
  ok: boolean;
  budget?: SessionBudget;
  /** `null` when the caller explicitly sent `null` (remove the budget). */
  remove?: boolean;
  message?: string;
  code?: BudgetErrorCode;
}

// ============================================================
// Parsing
// ============================================================

/**
 * Validate a `budget` field from a request body.
 *
 * `undefined` means the caller said nothing, which is different from `null`
 * ("remove the budget") — collapsing the two would turn every unrelated PATCH
 * into a budget removal.
 */
export function parseSessionBudget(value: unknown): BudgetValidation {
  if (value === undefined) return { ok: true, budget: undefined };
  if (value === null) return { ok: true, remove: true };

  if (typeof value !== 'object' || Array.isArray(value)) {
    return invalid(BUDGET_ERROR_CODES.invalidShape, 'budget must be an object or null');
  }
  const record = value as Record<string, unknown>;
  if (record.type !== 'limit') {
    return invalid(BUDGET_ERROR_CODES.invalidShape, 'budget.type must be "limit"');
  }
  if (!record.max_list_cost || typeof record.max_list_cost !== 'object' || Array.isArray(record.max_list_cost)) {
    return invalid(BUDGET_ERROR_CODES.invalidShape, 'budget.max_list_cost must be an object');
  }

  const maxListCost = record.max_list_cost as Record<string, unknown>;
  if (maxListCost.currency !== 'USD') {
    return invalid(BUDGET_ERROR_CODES.invalidCurrency, 'budget.max_list_cost.currency must be "USD"');
  }

  const amount = maxListCost.amount;
  if (typeof amount !== 'string' || !/^[1-9][0-9]*$/.test(amount)) {
    return invalid(
      BUDGET_ERROR_CODES.invalidAmount,
      'budget.max_list_cost.amount must be a positive integer number of cents written as a string without a leading zero',
    );
  }

  return { ok: true, budget: { type: 'limit', max_list_cost: { amount, currency: 'USD' } } };
}

function invalid(code: BudgetErrorCode, message: string): BudgetValidation {
  return { ok: false, code, message };
}

/** The cap in whole cents. */
export function budgetCapCents(budget: SessionBudget): number {
  return Number.parseInt(budget.max_list_cost.amount, 10);
}

/** The cap in the exact unit enforcement compares against. */
export function budgetCapMicrocents(budget: SessionBudget): number {
  return centsToMicrocents(budgetCapCents(budget));
}

// ============================================================
// Consumed list cost
// ============================================================

export interface SessionSpend extends CostBreakdown {
  /** Whether a budget can meter this session at all. */
  meterable: boolean;
}

/**
 * Consumed list cost for a session, derived from its event log.
 *
 * Reads one indexed aggregate per distinct model rather than replaying the whole
 * log: `idx_events_type` covers `(session_id, type)`, and grouping by
 * `model_used` means a session that switched models still prices each request at
 * the rate for the model that actually served it.
 */
export function sessionSpend(
  db: Database,
  sessionId: string,
  profile: CostProfile,
  events: readonly SessionEvent[] = [],
): SessionSpend {
  const rows = db.prepare(`
    SELECT model_used AS model,
           SUM(COALESCE(tokens_in, 0)) AS input_tokens,
           SUM(COALESCE(tokens_out, 0)) AS output_tokens,
           SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
           SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens
    FROM events
    WHERE session_id = ? AND type = 'span.model_request_end'
    GROUP BY model_used
  `).all(sessionId) as unknown as Array<{
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
  }>;

  const consumptions: ModelConsumption[] = rows.map((row) => ({
    model: row.model && row.model.length > 0 ? row.model : '(unknown-model)',
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    cacheWriteTokens: row.cache_write_tokens ?? 0,
  }));

  const breakdown = computeCost(profile, consumptions, {
    activeSeconds: events.length > 0 ? activeSecondsFromEvents(events) : 0,
    webSearchRequests: serverToolUseFromEvents(events).web_search_requests,
  });

  return { ...breakdown, meterable: breakdown.unpricedModels.length === 0 };
}

/**
 * Whether a session may adopt or keep a budget, given the models it runs.
 *
 * Called with the *declared* models at creation. A caller that omits a model the
 * session later runs is caught by {@link sessionSpend} reporting it as
 * unpriced, which the published contract answers by refusing further budget
 * changes and telling the client to remove the budget.
 */
export function unpricedDeclaredModels(
  profile: CostProfile,
  models: readonly string[],
): string[] {
  return models.filter((model) => !profile.models[model]);
}

/**
 * Whether the session has reached its cap.
 *
 * Compare in microcents: reported cents are rounded, so a session whose true
 * spend is 49.9999 cents against a 50-cent cap must not be paused, and one at
 * 50.0001 must be. Using the rounded value would make the boundary flip on
 * display precision instead of on spend.
 */
export function budgetReached(spend: SessionSpend, budget: SessionBudget): boolean {
  // A session whose consumption includes an unpriceable model cannot be
  // metered. The published contract says the budget may then pause the session
  // and that changing it is refused until the budget is removed.
  if (!spend.meterable) return true;
  return spend.microcents >= budgetCapMicrocents(budget);
}

/** Whether an event may be accepted while the session sits at its cap. */
export function isSettlementEvent(type: string): boolean {
  return BUDGET_SETTLEMENT_EVENT_TYPES.has(type);
}

/** Attach a code without inventing an error subclass per refusal. */
export function budgetError(code: BudgetErrorCode, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/**
 * Whether a thrown value is one of this module's refusals.
 *
 * The route uses it to choose 400 over 500: every budget refusal is a
 * well-formed request asking for something the contract forbids, never an
 * internal failure.
 */
export function isBudgetError(error: unknown): error is Error & { code: BudgetErrorCode } {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && BUDGET_ERROR_CODE_SET.has(code as BudgetErrorCode);
}

// Membership, not a prefix: `model_not_budgetable` is a budget refusal that
// does not spell itself with the `budget_` prefix.
const BUDGET_ERROR_CODE_SET: ReadonlySet<BudgetErrorCode> = new Set(
  Object.values(BUDGET_ERROR_CODES),
);

/**
 * Serialize for the `sessions.budget` column.
 *
 * A removal is stored as the JSON literal `null`, not as a SQL NULL, so the
 * column keeps three distinguishable states: no row value means the session
 * never had a budget, `'null'` means it had one removed, and anything else is
 * the budget. The contract treats the first two differently — one refuses to
 * attach a budget, the other refuses to re-add one — so collapsing them would
 * make the refusal message wrong for half the callers.
 */
export function serializeBudget(budget: SessionBudget | null): string {
  return JSON.stringify(budget);
}

/**
 * Read the stored budget back.
 *
 * Returns `undefined` both for "never had a budget" and for a value that cannot
 * be read back. That last case is deliberate: a ceiling the runtime cannot parse
 * is one it cannot honour, and reporting it as "removed" would refuse the
 * client's next valid budget for a reason that is not true.
 */
export function deserializeBudget(value: string | null | undefined): SessionBudget | null | undefined {
  if (value === null || value === undefined) return undefined;
  if (value.trim() === 'null') return null;
  try {
    const parsed = parseSessionBudget(JSON.parse(value));
    return parsed.ok && parsed.budget ? parsed.budget : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Consumption aggregated from an already-loaded event list.
 *
 * Used by projections that hold the log in memory anyway; the DB-backed
 * {@link sessionSpend} is the enforcement path.
 */
export function spendFromEvents(
  events: readonly SessionEvent[],
  profile: CostProfile,
): SessionSpend {
  const breakdown = computeCost(profile, consumptionFromEvents(events), {
    activeSeconds: activeSecondsFromEvents(events),
  });
  return { ...breakdown, meterable: breakdown.unpricedModels.length === 0 };
}
