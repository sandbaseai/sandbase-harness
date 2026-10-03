/**
 * Session Types
 *
 * Core session state machine types and event log types.
 */

import type { CMAEventType, ContentBlock, SessionBudget, UserEvent } from './cma-protocol.js';
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
  | 'cleanup_pending'
  | 'archived';

export type ApiSessionStatus = 'idle' | 'running' | 'rescheduling' | 'terminated';

/**
 * Valid state transitions for the Session state machine.
 * Key: current state, Value: set of valid next states.
 *
 * Every non-terminal state can transition to completed/failed, because a
 * session can be logically deleted (completed) or hit an unrecoverable error (failed)
 * at any point in its life — including while queued or idle (paused).
 */
export const SESSION_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  queued: ['running', 'completed', 'failed', 'cancelled', 'timed_out', 'cleanup_pending', 'archived'],
  running: ['paused', 'requires_action', 'completed', 'failed', 'cancelled', 'timed_out', 'cleanup_pending', 'archived'],
  paused: ['running', 'completed', 'failed', 'cancelled', 'archived'],
  requires_action: ['running', 'completed', 'failed', 'cancelled', 'timed_out', 'archived'],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  cleanup_pending: [],
  archived: [],
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
  archivedAt?: Date;
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

/**
 * The `agent` object an UpdateSession request accepts.
 *
 * Only the tool surface is session-updatable — `tools` and `mcp_servers`
 * replace wholesale rather than merge. Every other definition field belongs
 * to `agents.update` and is refused by name (`agent_field_not_updatable`).
 */
export interface SessionAgentUpdate {
  tools?: AgentDefinition['tools'];
  mcp_servers?: AgentDefinition['mcp_servers'];
}

/**
 * Parameters for `SessionManager.updateSession`.
 *
 * `vault_ids` is part of the published parameter set but refused rather than
 * applied (`vault_ids_not_updatable`); `budget` moves the session's ceiling
 * under the budget contract's rules. `metadata` is a merge patch — `null` per
 * key removes it, `null` for the whole field is no change — and `title` is a
 * plain replace where `null` clears.
 */
export interface UpdateSessionParams {
  agent?: SessionAgentUpdate;
  budget?: SessionBudget | null;
  metadata?: Record<string, unknown> | null;
  title?: string | null;
  vault_ids?: string[];
}

export interface ListSessionsParams {
  page?: number;
  pageSize?: number;
  /**
   * Internal statuses to match (OR). The route projects the published
   * `statuses[]` values back through `STATUS_PROJECTION`; internal callers may
   * name internal statuses directly. An empty array matches nothing.
   */
  statuses?: SessionStatus[];
  agentId?: string;
  /** Only meaningful alongside `agentId`: the pinned-version filter. */
  agentVersion?: number;
  /** `created_at` direction. Defaults to `desc` (newest first). */
  order?: 'asc' | 'desc';
  /** Include sessions whose `archived_at` is set. Defaults to excluding them. */
  includeArchived?: boolean;
  /** Sessions holding a live `memory_store` resource with this store id. */
  memoryStoreId?: string;
  /** Sessions created by this scheduled deployment. */
  deploymentId?: string;
  /** Creation-time bounds; each value is an ISO timestamp. */
  createdAt?: { gt?: string; gte?: string; lt?: string; lte?: string };
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/**
 * Internal trigger that re-enters the turn loop after a budget update lifts a
 * session's spending ceiling. It is deliberately not a `UserEvent`: nothing is
 * appended to the log for it, so a `user.message` carrier would fabricate a
 * user utterance into context projection, memory extraction, and the event
 * contract the log is published under.
 */
export interface ResumeAfterBudgetTrigger {
  type: 'internal.resume_after_budget';
}

/** What the executor's turn loop may be entered with: a wire event, or an internal resume. */
export type TurnTrigger = UserEvent | ResumeAfterBudgetTrigger;
