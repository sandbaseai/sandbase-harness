/**
 * Context Compactor (Requirement 9.15, Property 11)
 *
 * When a Session's Event_Log projected into model context exceeds a fraction
 * of the model's context window, summarize the older events with the same
 * model and record a `compaction_boundaries` row plus an
 * `agent.thread_context_compacted` notification event. On subsequent turns,
 * eventsToMessages serves `[summary, ...post-boundary events]`.
 *
 * History is split into atomic groups before the preserve tail is chosen: a
 * user turn is its own group, and everything the agent produced in reply —
 * messages, thinking, tool calls and their results, mid-turn confirmations —
 * stays in one group so a `tool_use` is never separated from its result. The
 * tail is budgeted by estimated tokens, not by message count.
 *
 * Token estimation uses a cheap 4-chars-per-token heuristic — good enough to
 * decide when to trigger without pulling in a tokenizer dependency.
 */

import { generateText, type LanguageModel } from 'ai';
import type { SessionEvent } from '@/types/session.js';
import type { AuxiliaryModelUsage } from '@/types/strategy.js';
import type { Message } from './events-to-messages.js';
import { anthropicModelCapabilities } from '@/model/anthropic-capabilities.js';

/** Fire compaction when estimated tokens exceed this fraction of the window. */
const DEFAULT_TRIGGER_FRACTION = 0.8;

/** Default context window when a model's is unknown (conservative). */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** The preserved tail never grows past this many estimated tokens. */
const PRESERVE_BUDGET_CAP = 20_000;

const SUMMARIZE_SYSTEM_PROMPT = `You are compacting a conversation to fit a context window. Produce a concise but complete summary of the conversation so far that preserves:
- Key facts, decisions, and outcomes
- Any file paths, identifiers, names, and numbers mentioned
- The current task state and what remains to be done
- Important tool results

Omit small talk and redundant restatements. Output only the summary text.`;

/**
 * Events that open a new atomic group. Everything else — agent output, tool
 * results, turn lifecycle, mid-turn `user.tool_confirmation` /
 * `user.custom_tool_result` / `user.steer` — continues the group it lands in,
 * which is what keeps a tool call paired with its result.
 */
const GROUP_START_TYPES = new Set(['user.message', 'user.define_outcome', 'system.message']);

export interface AtomicGroup {
  events: SessionEvent[];
  tokens: number;
}

/** A compaction boundary as the compactor consumes and produces it. */
export interface CompactionBoundaryInput {
  summary: string;
  /** Events with `seq <= eventSeqBefore` are covered by the summary. */
  eventSeqBefore: number;
}

export interface CompactionResult {
  summary: string;
  /** Events with `seq <= eventSeqBefore` are covered by the new summary. */
  eventSeqBefore: number;
  /** Id of the last summarized event, for the boundary row. */
  eventIdBefore: string;
  tokensBefore: number;
  tokensAfter: number;
  /** How many trailing atomic groups are preserved verbatim. */
  preservedGroupCount: number;
  /**
   * The summarize request's usage, so the caller can persist the canonical
   * usage record the way a turn does.
   */
  usage?: AuxiliaryModelUsage;
}

export interface CompactorConfig {
  triggerFraction?: number;
  contextWindowTokens?: number;
  /**
   * Explicit preserve-tail token budget. Defaults to a quarter of the context
   * window, capped at {@link PRESERVE_BUDGET_CAP}.
   */
  preserveBudgetTokens?: number;
}

export class ContextCompactor {
  constructor(private readonly config: CompactorConfig = {}) {}

  /**
   * The context window a model gets: an explicit `contextWindowTokens` config
   * wins, then the capability table's per-model value, then the conservative
   * default a model the table does not know keeps.
   */
  contextWindowFor(modelId?: string): number {
    return this.config.contextWindowTokens
      ?? (modelId ? anthropicModelCapabilities(modelId)?.contextWindow : undefined)
      ?? DEFAULT_CONTEXT_WINDOW;
  }

  /**
   * Should compaction fire for the given projected messages?
   */
  shouldCompact(messages: Message[], contextWindowTokens?: number): boolean {
    return this.shouldCompactTokens(estimateMessagesTokens(messages), contextWindowTokens);
  }

  /**
   * Same trigger against an already-measured token count — the caller supplies
   * it when a provider reports real usage rather than the chars/4 estimate.
   */
  shouldCompactTokens(tokens: number, contextWindowTokens?: number): boolean {
    const window = contextWindowTokens ?? this.config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW;
    const fraction = this.config.triggerFraction ?? DEFAULT_TRIGGER_FRACTION;
    return tokens > window * fraction;
  }

  /**
   * Token budget for the verbatim tail: a quarter of the usable window, never
   * more than {@link PRESERVE_BUDGET_CAP}.
   */
  preserveBudget(contextWindowTokens?: number): number {
    if (this.config.preserveBudgetTokens !== undefined) return this.config.preserveBudgetTokens;
    const window = contextWindowTokens ?? this.config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW;
    return Math.min(Math.floor(window / 4), PRESERVE_BUDGET_CAP);
  }

  /**
   * Split events into atomic groups. A group break happens only at a
   * group-start event; tool calls and their results therefore share a group
   * even when confirmations or lifecycle events sit between them.
   */
  splitAtomicGroups(events: SessionEvent[]): AtomicGroup[] {
    const groups: AtomicGroup[] = [];
    let current: AtomicGroup | undefined;
    for (const event of events) {
      if (GROUP_START_TYPES.has(event.type) || !current) {
        current = { events: [], tokens: 0 };
        groups.push(current);
      }
      current.events.push(event);
      current.tokens += estimateEventTokens(event);
    }
    return groups;
  }

  /**
   * Summarize the events before the preserved tail into a single summary via
   * the model. Returns the new boundary, or null when there is nothing worth
   * compacting.
   */
  async compact(
    events: SessionEvent[],
    priorBoundary: CompactionBoundaryInput | null,
    model: LanguageModel,
    contextWindowTokens?: number,
  ): Promise<CompactionResult | null> {
    const window = contextWindowTokens ?? this.config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW;
    const scope = priorBoundary
      ? events.filter((e) => e.seq > priorBoundary.eventSeqBefore)
      : events;
    const groups = this.splitAtomicGroups(scope);
    if (groups.length <= 1) return null; // one turn cannot be split

    // The newest group always survives. When it alone overflows the whole
    // window there is nothing compaction can do — the tool-output overflow
    // path or a model error handles it.
    const lastGroup = groups[groups.length - 1];
    if (lastGroup.tokens > window) return null;

    const budget = this.preserveBudget(window);
    let keptTokens = lastGroup.tokens;
    let startIdx = groups.length - 1;
    for (let i = groups.length - 2; i >= 0; i--) {
      if (keptTokens + groups[i].tokens > budget) break;
      keptTokens += groups[i].tokens;
      startIdx = i;
    }
    // Every group fits in the tail: nothing to summarize away.
    if (startIdx === 0) return null;

    const summarizedGroups = groups.slice(0, startIdx);
    const lastSummarized = summarizedGroups[summarizedGroups.length - 1].events;
    const firstKept = groups[startIdx].events[0];
    const eventSeqBefore = firstKept.seq - 1;

    const transcript = [
      ...(priorBoundary ? [`Earlier conversation summary:\n${priorBoundary.summary}\n`] : []),
      ...summarizedGroups
        .flatMap((group) => group.events.map(renderEvent))
        .filter((line) => line.length > 0),
    ].join('\n\n');

    const tokensBefore =
      (priorBoundary ? Math.ceil(priorBoundary.summary.length / 4) : 0) +
      groups.reduce((sum, group) => sum + group.tokens, 0);

    const response = await generateText({
      model,
      // Retries belong to the registry's middleware, not a second layer here.
      maxRetries: 0,
      system: SUMMARIZE_SYSTEM_PROMPT,
      prompt: `Summarize this conversation:\n\n${transcript}`,
    });

    const summary = response.text.trim();
    const tokensAfter = Math.ceil(summary.length / 4) + keptTokens;

    return {
      summary,
      eventSeqBefore,
      eventIdBefore: lastSummarized[lastSummarized.length - 1].id,
      tokensBefore,
      tokensAfter,
      preservedGroupCount: groups.length - startIdx,
      usage: response.usage,
    };
  }
}

// ============================================================
// Token estimation
// ============================================================

export function estimateMessageTokens(m: Message): number {
  const s = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  return Math.ceil(s.length / 4);
}

export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

export function estimateEventTokens(e: SessionEvent): number {
  const s = JSON.stringify(e.content ?? []) + JSON.stringify(e.metadata ?? {});
  return Math.ceil(s.length / 4);
}

/**
 * Render one event as a transcript line for the summarizer. Non-context
 * events (lifecycle, spans, notifications) render to an empty line.
 */
function renderEvent(e: SessionEvent): string {
  const text = (e.content ?? [])
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text;
        case 'tool_use':
          return `[tool-call ${block.name}] ${JSON.stringify(block.input)}`;
        case 'tool_result':
          return `[tool-result] ${JSON.stringify(block.content)}`;
        default:
          return JSON.stringify(block);
      }
    })
    .filter(Boolean)
    .join(' ');
  if (!text) return '';
  return `${e.type}: ${text}`;
}
