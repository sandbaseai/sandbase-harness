/**
 * Agent Strategy Types
 *
 * Pluggable engine loop interface. Controls how sessions process events:
 * context building → LLM call → response parsing → tool execution → loop.
 */

import type { LanguageModel } from 'ai';
import type { SandboxInstance } from './sandbox.js';
import type { Session, SessionEvent } from './session.js';

// ============================================================
// Agent Strategy Interface
// ============================================================

export interface AgentStrategy {
  readonly name: string; // 'default' | 'planner' | 'rag' | ...

  /**
   * Execute a complete session turn.
   * Internally manages lifecycle hooks (beforeTurn/afterStep/onCompact/onError/onComplete).
   * Yields SessionEvent objects for real-time broadcasting.
   */
  execute(context: StrategyContext): AsyncIterable<SessionEvent>;
}

// ============================================================
// Strategy Context (passed to execute)
// ============================================================

export interface StrategyContext {
  session: Session;
  /** Agent system prompt (with any injected skills). Sent to the model. */
  systemPrompt: string;
  messages: CoreMessage[];
  model: LanguageModel;
  tools: Record<string, CoreTool>;
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
    stopReason?: string;
    durationMs?: number;
    parentEventId?: string;
    delegationDepth?: number;
  }): SessionEvent;
  getLatestSeq(sessionId: string): number;
  /** Record canonical model usage for the owning session. */
  recordUsage(sessionId: string, tokensIn: number, tokensOut: number): void;
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
