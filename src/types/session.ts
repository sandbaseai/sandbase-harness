/**
 * Session Types
 *
 * Core session state machine types and event log types.
 */

import type { CMAEventType, ContentBlock, SessionBudget } from './cma-protocol.js';
import type { AgentDefinition, AgentOverrides } from './agent.js';

// ============================================================
// Session Status (state machine)
// ============================================================

export type SessionStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'requires_action'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'cleanup_pending';

export type ApiSessionStatus = 'idle' | 'running' | 'rescheduling' | 'terminated';

/**
 * Valid state transitions for the Session state machine.
 * Key: current state, Value: set of valid next states.
 *
 * Every non-terminal state can transition to completed/failed, because a
 * session can be stopped (completed) or hit an unrecoverable error (failed)
 * at any point in its life — including while queued or idle (paused).
 */
export const SESSION_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  queued: ['running', 'completed', 'failed', 'cancelled', 'timed_out', 'cleanup_pending'],
  running: ['paused', 'requires_action', 'completed', 'failed', 'cancelled', 'timed_out', 'cleanup_pending'],
  paused: ['running', 'completed', 'failed', 'cancelled'],
  requires_action: ['running', 'completed', 'failed', 'cancelled', 'timed_out'],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  cleanup_pending: [],
};

// ============================================================
// Session
// ============================================================

/** Engine provider frozen when the session is created. */
export type SessionLoopEngine = 'builtin' | 'pi';

export interface Session {
  id: string; // sess_xxx
  /** Persisted engine selection. Undefined is treated as builtin for legacy callers. */
  loopEngine?: SessionLoopEngine;
  agentId: string;
  agentName: string;
  agentVersion?: number;
  agentDefinition?: AgentDefinition;
  environmentId: string;
  status: SessionStatus;
  title?: string;
  contextId?: string;
  resources?: Array<Record<string, unknown>>;
  vaultIds?: string[];
  metadata?: Record<string, unknown>;
  sandboxType?: string;
  sandboxState?: Record<string, unknown>;
  usage?: {
    tokensIn: number;
    tokensOut: number;
  };
  /**
   * Spending ceiling. `undefined` means the session never had one and `null`
   * means it had one removed — two states the contract treats differently, so
   * they must stay distinguishable here.
   */
  budget?: SessionBudget | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

// ============================================================
// Session Event (persisted to Event_Log)
// ============================================================

export interface SessionEvent {
  id: string; // sevt_xxx
  sessionId: string;
  seq: number;
  type: CMAEventType;
  content?: ContentBlock[];
  modelUsed?: string;
  tokensIn?: number;
  tokensOut?: number;
  stopReason?: string;
  durationMs?: number;
  parentEventId?: string;
  delegationDepth?: number;
  /** Immutable event-specific data that does not belong in content blocks. */
  metadata?: Record<string, unknown>;
  createdAt: Date;
  processedAt?: Date;
}

// ============================================================
// Session API Params
// ============================================================

export interface CreateSessionParams {
  agent: string; // agent name or ID
  agentVersion?: number;
  /** Engine override for this session only; omitted means the effective default. */
  loopEngine?: SessionLoopEngine;
  environmentId?: string;
  /** Internal memory scope used by the current runtime; not exposed as a public API field. */
  contextId?: string;
  resources?: Array<Record<string, unknown>>;
  /**
   * Overrides how a session's `resources` are recorded as durable instances.
   *
   * The default attaches one instance per entry, which is what makes
   * `GET /v1/sessions/{id}/resources` report the resources the session was created with. The
   * seam exists so a test can inject a failure and prove the caller's transaction discards the
   * session: a session that claims a resource it does not hold is worse than none at all.
   */
  attachResources?: (sessionId: string) => void;
  vaultIds?: string[];
  title?: string;
  metadata?: Record<string, unknown>;
  /**
   * Spending ceiling. Only settable here: the contract refuses to attach a
   * budget to a session that was created without one.
   */
  budget?: SessionBudget;
  /**
   * Per-session replacements for the referenced agent's configuration
   * (`agent_with_overrides`). Omitted means the session runs the agent as
   * defined; a rejected override throws before the session row exists.
   */
  agentOverrides?: AgentOverrides;
}

export interface ListSessionsParams {
  page?: number;
  pageSize?: number;
  status?: SessionStatus | SessionStatus[];
  agentId?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}
