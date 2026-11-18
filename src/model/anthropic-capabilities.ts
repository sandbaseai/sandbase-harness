/**
 * Anthropic model capability table.
 *
 * Per-model-id-prefix capability facts, sourced from the published Anthropic
 * documentation (verified 2026-10-05):
 *
 * - `adaptiveThinking` — the model accepts `thinking: {type: 'adaptive'}`.
 *   The models overview marks the current generation "Adaptive" (some
 *   "always on"); the installed `@ai-sdk/anthropic` capability table agrees
 *   for the 4.6+ families and marks the 4.5 generation and older as not
 *   adaptive.
 * - `effortLevels` — which `effort` levels the model accepts; an empty list
 *   means the effort parameter is not supported at all. The published effort
 *   page is the authority and the lists are not uniform: Opus 4.6 and Sonnet
 *   4.6 accept `max` but not `xhigh`, Opus 4.5 tops out at `high`, and
 *   `mythos-preview` skips `xhigh`.
 * - `effortDefault` — the level the published service resolves at save time
 *   when the caller omits `effort`. The published effort page fixes the rule:
 *   `medium` on Claude Opus 5.5 and Claude Haiku 5.5, `high` on every other
 *   model that accepts effort, `undefined` on a model with no effort support.
 * - `fastMode` — the model honours `speed: 'fast'`. The published fast-mode
 *   page lists only Opus 5.5, Opus 5, and Opus 4.8; requests for Opus 4.7
 *   error and requests for Opus 4.6 silently run at standard speed, so both
 *   are marked unsupported and refused at admission rather than degraded.
 *
 * A model id no prefix matches is *unknown*, not *incapable*: the caller gets
 * `undefined` and no provider options are sent for it. Admission only refuses
 * what this table can disprove, so a future model id is never blocked by a
 * stale table — it simply runs without these options until the table learns
 * about it.
 *
 * Lookup is `includes`-based like the provider's own table, so dated ids
 * (`claude-opus-5-20251022`) resolve to their family. Entries are ordered
 * most-specific first: `claude-opus-4` must not shadow `claude-opus-4-8`.
 */

import type { ModelEffortLevel } from '@/core/agent/model-object.js';

export interface AnthropicModelCapabilities {
  /** `thinking: {type: 'adaptive', display: 'omitted'}` may be sent. */
  adaptiveThinking: boolean;
  /** Accepted `model.effort` levels; empty means effort is unsupported. */
  effortLevels: readonly ModelEffortLevel[];
  /**
   * The level the published service resolves when a definition omits `effort`.
   * `undefined` means the model takes no effort at all, so an omitted `effort`
   * stays omitted rather than being filled with a level it cannot take.
   */
  effortDefault?: ModelEffortLevel;
  /** `speed: 'fast'` may be sent. */
  fastMode: boolean;
  /**
   * Context window in tokens. Every published Claude model is 200k standard;
   * Sonnet's 1M tier lives behind a beta flag this runtime does not send, so
   * the standard window is the honest value for compaction decisions.
   */
  contextWindow: number;
}

const ALL_EFFORT_LEVELS: readonly ModelEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const NO_XHIGH: readonly ModelEffortLevel[] = ['low', 'medium', 'high', 'max'];
const UP_TO_HIGH: readonly ModelEffortLevel[] = ['low', 'medium', 'high'];
const NO_EFFORT: readonly ModelEffortLevel[] = [];

interface TableEntry {
  prefix: string;
  capabilities: AnthropicModelCapabilities;
}

const TABLE: readonly TableEntry[] = [
  // 5-generation: adaptive thinking, all five effort levels. Opus 5.x also
  // supports fast mode (fast-mode supported-models list). The published
  // effort page gives every 5-generation model except Opus 5.5 and Haiku 5.5
  // a `high` default; those two default to `medium`.
  { prefix: 'claude-fable-5', capabilities: { adaptiveThinking: true, effortLevels: ALL_EFFORT_LEVELS, effortDefault: 'high', fastMode: false, contextWindow: 200_000 } },
  { prefix: 'claude-mythos-5', capabilities: { adaptiveThinking: true, effortLevels: ALL_EFFORT_LEVELS, effortDefault: 'high', fastMode: false, contextWindow: 200_000 } },
  { prefix: 'claude-mythos-preview', capabilities: { adaptiveThinking: true, effortLevels: NO_XHIGH, effortDefault: 'high', fastMode: false, contextWindow: 200_000 } },
  // Opus 5.5 must precede Opus 5 — an `includes` lookup would otherwise let
  // the family entry shadow it and hand back the wrong default.
  { prefix: 'claude-opus-5-5', capabilities: { adaptiveThinking: true, effortLevels: ALL_EFFORT_LEVELS, effortDefault: 'medium', fastMode: true, contextWindow: 200_000 } },
  { prefix: 'claude-opus-5', capabilities: { adaptiveThinking: true, effortLevels: ALL_EFFORT_LEVELS, effortDefault: 'high', fastMode: true, contextWindow: 200_000 } },
  { prefix: 'claude-sonnet-5', capabilities: { adaptiveThinking: true, effortLevels: ALL_EFFORT_LEVELS, effortDefault: 'high', fastMode: false, contextWindow: 200_000 } },
  { prefix: 'claude-haiku-5-5', capabilities: { adaptiveThinking: true, effortLevels: ALL_EFFORT_LEVELS, effortDefault: 'medium', fastMode: false, contextWindow: 200_000 } },
  // 4.x generation. Opus 4.8 supports fast mode; Opus 4.7 errors on it and
  // Opus 4.6 silently degrades — both treated as unsupported here. Opus/Sonnet
  // 4.6 accept `max` but not `xhigh`; Opus 4.5 accepts effort only up to
  // `high` and no adaptive thinking; the rest take no effort at all. Every
  // 4.x model that accepts effort defaults to `high`.
  { prefix: 'claude-opus-4-8', capabilities: { adaptiveThinking: true, effortLevels: ALL_EFFORT_LEVELS, effortDefault: 'high', fastMode: true, contextWindow: 200_000 } },
  { prefix: 'claude-opus-4-7', capabilities: { adaptiveThinking: true, effortLevels: ALL_EFFORT_LEVELS, effortDefault: 'high', fastMode: false, contextWindow: 200_000 } },
  { prefix: 'claude-opus-4-6', capabilities: { adaptiveThinking: true, effortLevels: NO_XHIGH, effortDefault: 'high', fastMode: false, contextWindow: 200_000 } },
  { prefix: 'claude-sonnet-4-6', capabilities: { adaptiveThinking: true, effortLevels: NO_XHIGH, effortDefault: 'high', fastMode: false, contextWindow: 200_000 } },
  { prefix: 'claude-opus-4-5', capabilities: { adaptiveThinking: false, effortLevels: UP_TO_HIGH, effortDefault: 'high', fastMode: false, contextWindow: 200_000 } },
  { prefix: 'claude-sonnet-4-5', capabilities: { adaptiveThinking: false, effortLevels: NO_EFFORT, fastMode: false, contextWindow: 200_000 } },
  { prefix: 'claude-haiku-4-5', capabilities: { adaptiveThinking: false, effortLevels: NO_EFFORT, fastMode: false, contextWindow: 200_000 } },
  { prefix: 'claude-opus-4-1', capabilities: { adaptiveThinking: false, effortLevels: NO_EFFORT, fastMode: false, contextWindow: 200_000 } },
  { prefix: 'claude-opus-4', capabilities: { adaptiveThinking: false, effortLevels: NO_EFFORT, fastMode: false, contextWindow: 200_000 } },
  { prefix: 'claude-sonnet-4', capabilities: { adaptiveThinking: false, effortLevels: NO_EFFORT, fastMode: false, contextWindow: 200_000 } },
  { prefix: 'claude-haiku-4', capabilities: { adaptiveThinking: false, effortLevels: NO_EFFORT, fastMode: false, contextWindow: 200_000 } },
  { prefix: 'claude-3', capabilities: { adaptiveThinking: false, effortLevels: NO_EFFORT, fastMode: false, contextWindow: 200_000 } },
];

/**
 * Look up a model id's capabilities. Returns `undefined` for ids the table
 * does not cover — an unknown id is not proof of incapability, so admission
 * and the request builder must treat `undefined` as "send nothing" rather
 * than "refuse".
 */
export function anthropicModelCapabilities(modelId: string): AnthropicModelCapabilities | undefined {
  const id = modelId.toLowerCase();
  for (const entry of TABLE) {
    if (id.includes(entry.prefix)) return entry.capabilities;
  }
  return undefined;
}
