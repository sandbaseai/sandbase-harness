/**
 * Context Compactor (Requirement 9.15, Property 11)
 *
 * When a Session's Event_Log projected into model context exceeds a fraction
 * of the model's context window, summarize the older messages with the same
 * model and write an `agent.thread_context_compacted` boundary event. On
 * subsequent turns, eventsToMessages honors the latest boundary and serves
 * `[summary, ...post-boundary events]` instead of the full history.
 *
 * Token estimation uses a cheap 4-chars-per-token heuristic — good enough to
 * decide when to trigger without pulling in a tokenizer dependency.
 */

import { generateText, type LanguageModel } from 'ai';
import type { Message } from './events-to-messages.js';

/** Fire compaction when estimated tokens exceed this fraction of the window. */
const DEFAULT_TRIGGER_FRACTION = 0.8;

/** Default context window when a model's is unknown (conservative). */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** How many recent messages to always preserve verbatim (never summarized). */
const PRESERVE_TAIL_MESSAGES = 4;

const SUMMARIZE_SYSTEM_PROMPT = `You are compacting a conversation to fit a context window. Produce a concise but complete summary of the conversation so far that preserves:
- Key facts, decisions, and outcomes
- Any file paths, identifiers, names, and numbers mentioned
- The current task state and what remains to be done
- Important tool results

Omit small talk and redundant restatements. Output only the summary text.`;

export interface CompactionResult {
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  preservedTailCount: number;
}

export interface CompactorConfig {
  triggerFraction?: number;
  contextWindowTokens?: number;
  preserveTailMessages?: number;
}

export class ContextCompactor {
  constructor(private readonly config: CompactorConfig = {}) {}

  /**
   * Should compaction fire for the given projected messages?
   */
  shouldCompact(messages: Message[], contextWindowTokens?: number): boolean {
    const window = contextWindowTokens ?? this.config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW;
    const fraction = this.config.triggerFraction ?? DEFAULT_TRIGGER_FRACTION;
    return estimateMessagesTokens(messages) > window * fraction;
  }

  /**
   * Summarize the older messages (all but the preserved tail) into a single
   * summary string via the model. Returns null if there's nothing worth
   * compacting (too few messages).
   */
  async compact(messages: Message[], model: LanguageModel): Promise<CompactionResult | null> {
    const preserveTail = this.config.preserveTailMessages ?? PRESERVE_TAIL_MESSAGES;
    if (messages.length <= preserveTail + 1) {
      return null; // not enough history to bother
    }

    const older = messages.slice(0, messages.length - preserveTail);
    const tokensBefore = estimateMessagesTokens(messages);

    const transcript = older
      .map((m) => `${m.role.toUpperCase()}: ${renderContent(m)}`)
      .join('\n\n');

    const { text } = await generateText({
      model,
      system: SUMMARIZE_SYSTEM_PROMPT,
      prompt: `Summarize this conversation:\n\n${transcript}`,
    });

    const summary = text.trim();
    // Estimate post-compaction: summary + preserved tail
    const tail = messages.slice(messages.length - preserveTail);
    const tokensAfter = Math.ceil(summary.length / 4) + estimateMessagesTokens(tail);

    return {
      summary,
      tokensBefore,
      tokensAfter,
      preservedTailCount: preserveTail,
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

function renderContent(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .map((part: any) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'reasoning') return `[thinking] ${part.text}`;
      if (part.type === 'tool-call') return `[tool-call ${part.toolName}] ${JSON.stringify(part.args)}`;
      if (part.type === 'tool-result') return `[tool-result] ${JSON.stringify(part.result)}`;
      return JSON.stringify(part);
    })
    .join(' ');
}
