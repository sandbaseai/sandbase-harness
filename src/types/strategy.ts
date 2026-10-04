/**
 * Agent Strategy Types
 *
 * Pluggable engine loop interface. Controls how sessions process events:
 * context building → LLM call → response parsing → tool execution → loop.
 */

import type { LanguageModel } from 'ai';
import type { ModelConfig } from './model.js';
import type { SandboxInstance } from './sandbox.js';
import type { Session, SessionEvent, TurnTrigger } from './session.js';

// ============================================================
// Agent Strategy Interface
// ============================================================

export interface AgentStrategy {
  readonly name: string; // 'default' | 'planner' | 'rag' | ...
  /** Defaults to true. Set false when the strategy owns model transport itself. */
  readonly requiresModel?: boolean;

  /**
   * Execute a complete session turn.
   * Internally manages lifecycle hooks (beforeTurn/afterStep/onCompact/onError/onComplete).
   * Yields SessionEvent objects for real-time broadcasting.
   */
  execute(context: StrategyContext): AsyncIterable<SessionEvent>;

  /**
   * Release whatever this strategy owns for one session.
   *
   * Optional because an in-process strategy owns nothing per session. A strategy
   * that drives a session-owned child process implements it, so reaching a
   * terminal state actually stops the engine instead of leaving it running with
   * the session's work directory held open.
   */
  disposeSession?(sessionId: string): Promise<void>;
}

// ============================================================
// Strategy Context (passed to execute)
// ============================================================

export interface StrategyContext {
  session: Session;
  /** The incoming trigger — a wire user event, or an internal resume that
   *  carries no prompt: a strategy reading `userEvent` must tolerate the
   *  `internal.*` types, which name re-entry on the transcript the log holds. */
  userEvent: TurnTrigger;
  /** Agent system prompt (with any injected skills). Sent to the model. */
  systemPrompt: string;
  messages: CoreMessage[];
  /** Resolved selected model configuration, including no AI SDK construction. */
  modelConfig?: ModelConfig;
  /** Explicit skill directories for engines that support managed skill loading. */
  skillDirs?: string[];
  /** Constructed only for strategies that require the AI SDK model transport. */
  model?: LanguageModel;
  tools: Record<string, CoreTool>;
  /** Names resolved from custom tools. They are exposed to the model but never executed locally. */
  customToolNames?: ReadonlySet<string>;
  sandbox: SandboxInstance;
  eventLog: EventLogWriter;
  broadcast: (event: SessionEvent) => void;
  config: AgentStrategyConfig;
  /** Signal that aborts the turn when the user sends user.interrupt. */
  abortSignal?: AbortSignal;
}

// ============================================================
// Strategy Configuration (lifecycle hooks)
// ============================================================

export interface AgentStrategyConfig {
  /** Maximum steps in the tool loop (default: 25) */
  maxSteps?: number;
  /** Max tokens per LLM call */
  maxTokens?: number;
  /** Temperature override */
  temperature?: number;
  /** Tool names that require user confirmation before running (no auto-execute). */
  confirmTools?: string[];
  /** Called by the strategy when a tool call needs user confirmation — the
   *  session should transition to requires_action and await user.tool_confirmation. */
  onRequiresAction?: () => void;
  /**
   * Checked once per step, after that step's spend has been committed — a true
   * answer stops the turn at the session's budget ceiling instead of starting
   * another model request. Absent means "no ceiling", which is exactly what a
   * session without a budget is.
   */
  budgetExhausted?: () => boolean;
  /** Called once before the maxSteps loop starts */
  beforeTurn?: (ctx: StrategyContext) => Promise<void>;
  /** Called after each tool-loop step completes */
  afterStep?: (step: StepResult) => Promise<void>;
  /** Called when context compaction is triggered */
  onCompact?: (summary: string) => Promise<void>;
  /** Called on execution error; return 'retry' or 'abort' */
  onError?: (error: Error) => Promise<'retry' | 'abort'>;
  /** Called once after the loop exits normally */
  onComplete?: (result: CompletionResult) => Promise<void>;
  /**
   * The agent's `model` profile options (`effort`, `speed`), carried beside the
   * id so a strategy can map them onto provider-specific request options. A
   * strategy that owns its transport (Pi) ignores this.
   *
   * `effort` is a plain string here for the same reason `AgentModelConfig`
   * keeps it one: the accepted set lives in `core/agent/model-object.ts` and
   * `types/` takes no dependency on `core/`.
   */
  modelOptions?: { effort?: string; speed?: string };
}

// ============================================================
// Step & Completion Results
// ============================================================

export interface StepResult {
  stepIndex: number;
  type: 'tool_call' | 'text' | 'thinking';
  toolName?: string;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
}

export interface CompletionResult {
  totalSteps: number;
  totalTokensIn: number;
  totalTokensOut: number;
  stopReason: 'end_turn' | 'max_steps' | 'tool_confirmation' | 'error';
  durationMs: number;
}

// ============================================================
// Event Log Writer (subset exposed to Strategy)
// ============================================================

export interface EventLogWriter {
  append(sessionId: string, event: {
    type: SessionEvent['type'];
    content?: SessionEvent['content'];
    modelUsed?: string;
    tokensIn?: number;
    tokensOut?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    stopReason?: string;
    durationMs?: number;
    parentEventId?: string;
    /** `span.model_request_end` only: whether the request ended in an error. */
    isError?: boolean;
    /** `span.model_request_end` only: the speed tier the request ran at. */
    speed?: 'standard' | 'fast';
    delegationDepth?: number;
    metadata?: Record<string, unknown>;
    /**
     * Pre-generated id for events previewed on `event_deltas[]` connections:
     * the previewed id must equal the buffered event's id, so the producer
     * mints it before streaming and hands it back here. Omitted elsewhere.
     */
    id?: string;
  }): SessionEvent;
  getLatestSeq(sessionId: string): number;
  /**
   * Record canonical model usage for the owning session.
   *
   * `tokensIn` is the uncached share of the request's input; the prompt-cache
   * buckets travel in `cache` so a cache read is never priced or reported as
   * a full-rate input token.
   */
  recordUsage(
    sessionId: string,
    tokensIn: number,
    tokensOut: number,
    cache?: { read?: number; write?: number },
  ): void;
}

// ============================================================
// Re-exports from Vercel AI SDK (for convenience)
// These are opaque here; actual types come from 'ai' package
// ============================================================

/** Vercel AI SDK CoreMessage (user/assistant/tool messages) */
export type CoreMessage = {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: unknown;
  [key: string]: unknown;
};

/** Vercel AI SDK CoreTool definition */
export type CoreTool = {
  description?: string;
  parameters: unknown;
  execute?: (...args: unknown[]) => Promise<unknown>;
  [key: string]: unknown;
};
