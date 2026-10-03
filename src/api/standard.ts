import type { AgentDefinition, AgentToolset, McpServerConfig } from '@/types/agent.js';
import type { OutcomeRubric } from '@/types/cma-protocol.js';
import type { ApiSessionStatus, Session, SessionEvent, SessionLoopEngine, SessionStatus } from '@/types/session.js';
import type { SessionBudget, SessionStatusIdleEvent } from '@/types/cma-protocol.js';
import { projectSessionError, type SessionErrorPayload } from '@/core/session/session-error.js';
import { STATUS_PROJECTION } from '@/core/session/session-lifecycle.js';
import { isTerminal } from '@/core/session/state-machine.js';
import type { SessionOutcomeEvaluation } from '@/core/outcomes/session-outcomes.js';

export interface ApiPage<T extends { id: string }> {
  data: T[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

export interface ApiCursorPage<T> {
  data: T[];
  prev_page: string | null;
  next_page: string | null;
}

/**
 * Encode a cursor for a canonical collection.
 *
 * The payload is the sort state the page was produced from, so a cursor cannot
 * be replayed against a different ordering. It is base64url-encoded rather than
 * encrypted because it carries no secret; the opacity is there to keep callers
 * from constructing one, not to hide anything.
 */
export function encodeCursor(state: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

export interface DecodedCursor {
  ok: boolean;
  state?: Record<string, unknown>;
}

/** Decode a cursor, rejecting anything that is not a well-formed object. */
export function decodeCursor(cursor: string): DecodedCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    return { ok: true, state: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

/**
 * Normalize a collection's filter into a stable, comparable token.
 *
 * Keys are sorted and empty values dropped, so two requests that filter
 * identically produce the same token — otherwise a cursor would be rejected for
 * a difference the caller cannot observe (an omitted `status` versus an empty
 * one). The result is what gets stored in the cursor, which is why it must be
 * canonical rather than merely equal.
 */
export function normalizeCollectionFilter(
  filter: Record<string, string | undefined | null>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const key of Object.keys(filter).sort()) {
    const value = filter[key];
    if (value !== undefined && value !== null && value !== '') normalized[key] = value;
  }
  return normalized;
}

/**
 * Why a decoded cursor cannot be replayed against this query, or `undefined`
 * when it can.
 *
 * The published contract says a cursor encodes the sort request that produced
 * it and must not be reused across a different `order` or an incompatible
 * filter. Enforcing only the ordering half was a silent-corruption path: the
 * same cursor replayed under a different filter is accepted by a page-number
 * scheme, and the caller reads a page that never existed for that filter.
 */
export function cursorQueryMismatch(
  state: Record<string, unknown> | undefined,
  expected: { order?: string; filter?: Record<string, string> },
): string | undefined {
  if (expected.order !== undefined) {
    const order = state?.order;
    if (typeof order === 'string' && order !== expected.order) {
      return 'next_page was issued for a different ordering.';
    }
  }
  if (expected.filter !== undefined) {
    const filter = state?.filter;
    if (filter !== undefined) {
      if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
        return 'next_page was issued for a different filter.';
      }
      const actual = normalizeCollectionFilter(filter as Record<string, string>);
      if (JSON.stringify(actual) !== JSON.stringify(expected.filter)) {
        return 'next_page was issued for a different filter.';
      }
    }
  }
  return undefined;
}

/**
 * Build a canonical cursor page from a slice and its continuation state.
 *
 * `prev` is supplied by the caller because a forward-only scan cannot infer it;
 * passing `null` is honest for the first page rather than inventing a cursor
 * that would not resolve.
 */
export function cursorPageOf<T>(
  data: T[],
  cursors: { prev?: string | null; next?: string | null },
): ApiCursorPage<T> {
  return {
    data,
    prev_page: cursors.prev ?? null,
    next_page: cursors.next ?? null,
  };
}

export interface CollectionPager<T> {
  list(items: T[]): ApiCursorPage<T> | ApiPage<T & { id: string }>;
  /** Render directly on a Hono context, preserving the optional status code. */
  json(c: { json: (body: unknown, status?: number) => Response }, items: T[], status?: number): Response;
}

/**
 * Build a pager for one collection under one envelope.
 *
 * Cursors are `null` in both shapes here: these operations collections are
 * returned as a complete result set, and inventing a `next_page` that a caller
 * could follow into an empty page would be worse than admitting the end. The
 * parameter is kept so the canonical shape is produced by the same function
 * that will carry real cursors once a collection is actually windowed.
 */
/**
 * One canonical page of an offset-windowed listing.
 *
 * This is the semantic the skills listing, the agent version history and the memory version history
 * all need, and it used to be written three times. The window is an offset carried by the cursor, the
 * cursor also carries the filter that produced it so it cannot be replayed against a different one, a
 * malformed cursor is refused rather than read as page one, and the limit is clamped into 1..100 with a
 * default of 20. An **absent** cursor means the first page — offset 0 — and only a present cursor must
 * carry a usable offset; getting that backwards makes every first page a 400.
 */
export function offsetCursorPage<T>(
  rows: T[],
  options: { limit?: string; page?: string; filter?: Record<string, string | null | undefined> },
): { ok: true; page: ApiCursorPage<T> } | { ok: false; message: string } {
  const limit = Math.max(1, Math.min(Number(options.limit ?? 20) || 20, 100));
  const filter = normalizeCollectionFilter(options.filter ?? {});
  const decoded = options.page === undefined ? { ok: true as const, state: undefined } : decodeCursor(options.page);
  if (!decoded.ok) return { ok: false, message: 'page must be a cursor returned by this endpoint' };
  const mismatch = cursorQueryMismatch(decoded.state, { filter });
  if (mismatch) return { ok: false, message: mismatch };
  const state = decoded.state as { offset?: unknown } | undefined;
  const offset = state === undefined
    ? 0
    : typeof state.offset === 'number' && Number.isInteger(state.offset) && state.offset >= 0
      ? state.offset
      : undefined;
  if (offset === undefined) return { ok: false, message: 'page must be a cursor returned by this endpoint' };

  const data = rows.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  const prevOffset = offset - limit;
  return {
    ok: true,
    page: cursorPageOf(data, {
      prev: offset > 0 && prevOffset >= 0 ? encodeCursor({ offset: prevOffset, filter }) : null,
      next: nextOffset < rows.length ? encodeCursor({ offset: nextOffset, filter }) : null,
    }),
  };
}
export function collectionPager<T extends { id: string }>(
  shape: 'canonical' | 'legacy',
): CollectionPager<T> {
  return {
    list(items) {
      return shape === 'canonical' ? cursorPageOf(items, {}) : pageOf(items);
    },
    json(c, items, status) {
      const body = shape === 'canonical' ? cursorPageOf(items, {}) : pageOf(items);
      return status === undefined ? c.json(body) : c.json(body, status);
    },
  };
}

export interface ApiAgent {
  id: string;
  type: 'agent';
  name: string;
  description: string;
  system: string;
  model: string;
  model_config?: {
    id?: string;
    speed: 'fast' | 'standard' | 'extended';
    /** Canonical effort level, echoed from the definition. No request body carries it. */
    effort?: string;
  };
  tools: AgentToolset[];
  mcp_servers: ApiMcpServer[];
  skills: Array<{
    type: 'custom' | 'anthropic';
    skill_id: string;
    version?: string;
  }>;
  metadata: Record<string, string>;
  status: 'active' | 'archived';
  version: number;
  /**
   * Resolved multiagent roster. Always `null` in this runtime — a declared
   * roster is refused by name (`multiagent-roster`), so a populated value can
   * never appear here today.
   */
  multiagent: null;
  created_at: string | null;
  updated_at: string | null;
  archived_at: string | null;
}

export type ApiMcpServer =
  | { type: 'url'; name: string; url: string }
  | { type: 'stdio'; name: string; command: string; args: string[]; env: Record<string, string> };

export interface ApiSession {
  id: string;
  type: 'session';
  title: string | null;
  agent: ApiAgent | { id: string; type: 'agent'; name: string; version: number; multiagent: null };
  environment_id: string;
  /** Engine frozen when the session was created, not the current Settings default. */
  loop_engine: SessionLoopEngine;
  status: ApiSessionStatus;
  resources: ApiSessionResource[];
  vault_ids: string[];
  /**
   * Spending ceiling, always present: `null` covers both a session that never
   * had one and one whose ceiling was removed — the published shape does not
   * distinguish them (the runtime still does, internally: a removed budget
   * cannot be re-added).
   */
  budget: SessionBudget | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  stats: ApiSessionStats;
  /**
   * The session's declared outcomes and their current evaluation state,
   * derived from the event log: one entry per `user.define_outcome`, in
   * declaration order. `pending`/`running`/`evaluating` while in progress and
   * the terminal end-span verdict once closed — `needs_revision` is a span
   * verdict, not a resource state, so it never appears here.
   */
  outcome_evaluations: SessionOutcomeEvaluation[];
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ApiSessionStats {
  /** Cumulative seconds the session spent executing (its `running` intervals). */
  active_seconds: number;
  /**
   * Seconds since creation. For a terminated or archived session this is
   * frozen at the final update; for a live one it counts up to the read.
   */
  duration_seconds: number;
}

export type ApiSessionResource =
  | { type: 'file'; file_id: string; mount_path: string }
  | { type: 'github_repository'; url?: string; repository_id?: string; checkout?: unknown; mount_path?: string }
  | { type: 'memory_store'; memory_store_id: string; access?: 'read_write' | 'read_only'; instructions?: string; mount_path?: string };

export interface ApiEvent {
  id: string;
  seq: number;
  type: string;
  content: unknown[] | null;
  metadata?: Record<string, unknown>;
  /**
   * The tool call this event pairs with.
   *
   * On `user.tool_confirmation` it is the value the caller sent. On
   * `agent.tool_result` it is lifted from the `tool_result` block, because the
   * declared `AgentToolResultEvent.tool_use_id` is a top-level field and a
   * client reading the event list otherwise sees it only inside `content`.
   */
  tool_use_id?: string;
  /**
   * Id of the custom tool call a `user.custom_tool_result` answers.
   *
   * Lifted from the metadata carrier, because the event has no content block
   * that names it. The accepted value's meaning is documented in
   * `contracts/anthropic-cma/tools.md`.
   */
  custom_tool_use_id?: string;
  /**
   * Structured payload of a `session.error`, projected from the metadata
   * carrier. `type` is always one of the official error types; the runtime's
   * own code travels under `code` when one was recorded.
   */
  error?: SessionErrorPayload;
  /**
   * Server that produced an `agent.mcp_tool_use` / `agent.mcp_tool_result`.
   * Without it, two MCP servers exposing the same tool name are
   * indistinguishable in the event log.
   */
  mcp_server_name?: string;
  /** Tool-use this MCP result answers. */
  mcp_tool_use_id?: string;
  /**
   * Name and input of a `tool_use` block, lifted to the top level where
   * `src/types/cma-protocol.ts` and the published client loop read them.
   * `content` still carries the block: this is a projection, not a move. The
   * top-level `id` is the event id and is not replaced by the tool-call id.
   */
  name?: string;
  input?: Record<string, unknown>;
  /**
   * Usage snapshot carried by `session.usage`. Emitted immediately before
   * `session.status_idle`. `list_cost` is present only when a cost profile
   * priced every model the session used — a partial total is withheld rather
   * than reported as one. `budget` echoes the session's budget, or `null` when
   * it has none, and `server_tool_use` counts the built-in web tools, of which
   * this runtime has none.
   */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    active_seconds: number;
    list_cost?: number;
    budget?: SessionBudget | null;
    server_tool_use?: {
      web_search_requests: number;
      web_fetch_requests: number;
    };
  };
  /**
   * `user.define_outcome` payload, lifted from the metadata carrier.
   *
   * The event has no `content` blocks, so the server-assigned outcome id, the
   * description, the rubric and the iteration budget are the event's whole
   * payload: persisted through metadata and projected back here rather than
   * sent as an empty `content` array. `outcome_id` is absent only on events
   * persisted before the id existed.
   */
  outcome_id?: string;
  description?: string;
  rubric?: OutcomeRubric;
  max_iterations?: number | null;
  /**
   * `session.updated` payload, lifted from the metadata carrier. Each field is
   * present only when the update changed it: `agent` is the session's full
   * materialized agent snapshot (the same projection `toApiSession` reports),
   * `budget` the new ceiling or `null` on removal, `metadata` the session's
   * full metadata bag (which replaces the carrier's own position at the top
   * level for this event type), and `title` the new title.
   */
  agent?: ApiAgent | { id: string; type: 'agent'; name: string };
  budget?: SessionBudget | null;
  title?: string | null;
  model_used?: string;
  tokens_in?: number;
  tokens_out?: number;
  /**
   * Why the turn ended. Two declared shapes share this field name and are
   * distinguished by the event type, exactly as the published contract has it:
   *
   * - a **string** on a model-derived event, from the `events.stop_reason`
   *   column — the provider's own reason for one response;
   * - an **object** on `session.status_idle`, from the metadata carrier — the
   *   session-level reason, which the published client reads as
   *   `stop_reason.type` (`会话事件流.md:1893`). Both share the name because
   *   both published shapes spell it `stop_reason`.
   */
  stop_reason?: string | NonNullable<SessionStatusIdleEvent['stop_reason']>;
  duration_ms?: number;
  delta?: string;
  message_id?: string;
  created_at: string | null;
  processed_at: string | null;
  parent_event_id: string | null;
}

export function pageOf<T extends { id: string }>(data: T[], hasMore = false): ApiPage<T> {
  return {
    data,
    has_more: hasMore,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}

export function agentId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return `agent_${slug || 'untitled'}`;
}

/**
 * Project an agent's tools to the canonical wire shape.
 *
 * A legacy `custom_toolset` grouping is flattened to independent canonical
 * `custom` entries, dropping a tool the grouping disabled or denied rather than
 * echoing the grouping back as written. Every other toolset passes through.
 */
function toApiToolsets(toolsets: AgentToolset[]): AgentToolset[] {
  return toolsets.flatMap((toolset): AgentToolset[] => {
    if (toolset.type === 'custom') return [toolset];
    if (toolset.type !== 'custom_toolset') return [toolset];
    const defaultEnabled = toolset.default_config?.enabled !== false;
    return (toolset.configs ?? [])
      .filter((config) => (config.enabled ?? defaultEnabled) !== false)
      .filter((config) => config.permission_policy?.type !== 'never_allow')
      .map((config) => ({
        type: 'custom' as const,
        name: config.name,
        description: config.description,
        input_schema: config.parameters ?? config.input_schema!,
      }));
  });
}

/**
 * The model profile as the read projection returns it.
 *
 * `effort` is echoed because the definition retains it: a value that is stored but
 * never returned is the silent loss the model profile exists to prevent, and the
 * published response shape is documented as echoing the profile it was given. The
 * field carries no execution behind it — the provider model is resolved from the
 * id — which is why the matrix records `effort` as accepted-but-no-effect rather
 * than as executed.
 *
 * `model_config` is still omitted for the ordinary case (the local `standard`
 * speed and no effort), so this projection is unchanged for every agent that never
 * sent either. Definitions written before `effort` moved inside `model_config`
 * kept it beside the config, and are honoured here rather than losing the value on
 * their first read after the change.
 */
function apiModelConfig(agent: AgentDefinition): ApiAgent['model_config'] | undefined {
  const config = agent.model_config;
  if (!config) return undefined;
  const effort = config.effort ?? (agent as { effort?: string }).effort;
  if (config.speed === 'standard' && !effort) return undefined;
  return {
    id: config.id,
    speed: config.speed,
    ...(effort ? { effort } : {}),
  };
}

export function toApiAgent(
  agent: AgentDefinition,
  dates?: {
    id?: string;
    createdAt?: string | null;
    updatedAt?: string | null;
    archivedAt?: string | null;
    status?: 'active' | 'archived';
    version?: number;
  },
): ApiAgent {
  const modelConfig = apiModelConfig(agent);
  return {
    id: dates?.id ?? agentId(agent.name),
    type: 'agent',
    name: agent.name,
    description: agent.description ?? '',
    system: agent.system,
    model: agent.model,
    ...(modelConfig ? { model_config: modelConfig } : {}),
    tools: toApiToolsets(agent.tools ?? []),
    mcp_servers: toApiMcpServers(agent.mcp_servers ?? []),
    skills: agent.skills ?? [],
    metadata: parseStringRecord(agent.metadata),
    status: dates?.status ?? (dates?.archivedAt ? 'archived' : 'active'),
    version: dates?.version ?? 1,
    multiagent: null,
    created_at: dates?.createdAt ?? null,
    updated_at: dates?.updatedAt ?? null,
    archived_at: dates?.archivedAt ?? null,
  };
}

export function toApiSession(
  session: Session,
  agent?: AgentDefinition,
  derived?: { activeSeconds?: number; outcomeEvaluations?: SessionOutcomeEvaluation[]; now?: Date },
): ApiSession {
  return {
    id: session.id,
    type: 'session',
    title: session.title ?? null,
    agent: agent
      ? toApiAgent(agent, { id: session.agentId, version: session.agentVersion })
      : { id: session.agentId, type: 'agent', name: session.agentName, version: session.agentVersion ?? 1, multiagent: null },
    environment_id: session.environmentId,
    // Legacy rows predate explicit engine selection and were executed by builtin.
    loop_engine: session.loopEngine ?? 'builtin',
    status: toApiSessionStatus(session.status),
    resources: parseJsonArray<Record<string, unknown>>(session.resources).map(toApiSessionResource),
    vault_ids: parseJsonArray(session.vaultIds),
    budget: session.budget ?? null,
    usage: {
      input_tokens: session.usage?.tokensIn ?? 0,
      output_tokens: session.usage?.tokensOut ?? 0,
    },
    stats: {
      active_seconds: derived?.activeSeconds ?? 0,
      duration_seconds: durationSeconds(session, derived?.now ?? new Date()),
    },
    outcome_evaluations: derived?.outcomeEvaluations ?? [],
    metadata: parseStringRecord(session.metadata),
    created_at: toIsoString(session.createdAt),
    updated_at: toIsoString(session.updatedAt),
    archived_at: session.archivedAt ? toIsoString(session.archivedAt) : null,
  };
}

/**
 * Seconds since creation. A terminal or archived session freezes at its last
 * update — after that nothing can append a new interval anyway; a live session
 * counts up to the read.
 */
function durationSeconds(session: Session, now: Date): number {
  const end = isTerminal(session.status) || session.archivedAt ? session.updatedAt : now;
  return Math.max(0, (end.getTime() - session.createdAt.getTime()) / 1000);
}

export function toApiEvent(event: SessionEvent): ApiEvent {
  const streamEvent = event as SessionEvent & { delta?: string; message_id?: string };
  // `session.usage` is persisted through the generic metadata carrier (the
  // events table has no per-type payload column) and projected to its
  // documented top-level field here.
  const usage = event.type === 'session.usage'
    ? metadataObject(event, 'usage') as ApiEvent['usage']
    : undefined;
  // `session.error` is persisted through the generic metadata carrier (the
  // events table has no per-type payload column) and projected to its
  // documented top-level field here, on the same route as `session.usage`.
  // `projectSessionError` normalizes both generations of stored payload: new
  // events already carry the official `type` and object `retry_status`; old
  // events store the local code in `type` and a string disposition, which the
  // projection reclassifies rather than leaking.
  const error = event.type === 'session.error'
    ? projectSessionError(metadataObject(event, 'error'))
    : undefined;
  const mcpServerName = metadataString(event, 'mcp_server_name');
  const mcpToolUseId = event.type === 'agent.mcp_tool_result' ? contentToolUseId(event) : undefined;
  // A tool event carries its payload inside `content[0]`, but both the declared
  // types in `src/types/cma-protocol.ts` and the published client loop read
  // `name` and `input` at the top level: the loop resolves a blocking event id
  // from `stop_reason.event_ids`, then reads `toolEvent.name` and
  // `toolEvent.input` off the event it found, so without this projection the call
  // cannot be made at all. `id` is deliberately not among the lifted fields — the
  // top-level `id` is the *event* id, which is the value that same loop answers
  // with, and overwriting it with the tool-call id would break the addressing.
  // The tool-call id stays reachable as `content[0].id`.
  // `content` is kept as well: this is a projection, not a move.
  const toolUse = contentToolUseBlock(event);
  const toolUseId = event.type === 'agent.tool_result' ? contentToolUseId(event) : undefined;
  // `user.custom_tool_result` has no content block that names the call it
  // answers — the accepted value lives in the metadata carrier — while
  // `UserCustomToolResultEvent` declares `custom_tool_use_id` as a top-level
  // field. A client reading the declared type gets `undefined` without this.
  const customToolUseId = event.type === 'user.custom_tool_result'
    ? metadataString(event, 'custom_tool_use_id')
    : undefined;
  // `user.define_outcome` is persisted through the generic metadata carrier and
  // projected to its documented top-level fields, on the same route as `session.usage`
  // and `session.error`.
  const defineOutcome = event.type === 'user.define_outcome'
    ? {
        ...(typeof event.metadata?.outcome_id === 'string' ? { outcome_id: event.metadata.outcome_id } : {}),
        ...(typeof event.metadata?.description === 'string' ? { description: event.metadata.description } : {}),
        ...(event.metadata?.rubric ? { rubric: event.metadata.rubric as OutcomeRubric } : {}),
        // `max_iterations` is `number | null` on the official event: present
        // even when the declaration left the default unset.
        max_iterations: typeof event.metadata?.max_iterations === 'number' ? event.metadata.max_iterations : null,
      }
    : undefined;
  // `session.status_idle` persists the session-level reason as an object in the
  // metadata carrier — the events table has no column for one — and the
  // published client reads it at the top level: the documented loop is
  // `select(.type == "session.status_idle") | .stop_reason.type`, which yields
  // the empty string while the object stays nested, so a conforming client
  // cannot tell "awaiting your answer" from "the turn ended". `metadata` keeps
  // the object as well, because `src/api/routes/runs.ts` reads the persisted
  // path to choose between a `202` and a terminal body: this is a projection,
  // not a move.
  //
  // This is deliberately the *only* event type that gains an object here. A
  // model event's `stop_reason` is the provider's string from the column, and a
  // status event has no model response behind it, so the two cannot collide;
  // the object is spread after the column anyway so an idle event's own reason
  // wins if one ever carried both.
  const sessionStopReason = event.type === 'session.status_idle'
    ? metadataObject(event, 'stop_reason') as NonNullable<SessionStatusIdleEvent['stop_reason']> | undefined
    : undefined;
  // `session.updated` persists its changed-fields payload through the metadata
  // carrier (`metadata.session_updated`), the same route `session.usage` takes.
  // The stored `agent` entry is the merged definition plus the session's agent
  // coordinates, which this projection turns back into the full snapshot the
  // session read reports. `metadata` is special among the lifted fields: on the
  // published event it IS the session's metadata bag, so it takes the field
  // over the carrier — the carrier still holds it under `session_updated`.
  const sessionUpdate = event.type === 'session.updated'
    ? metadataObject(event, 'session_updated')
    : undefined;
  const sessionUpdateAgent = sessionUpdate?.agent !== undefined
    ? toApiAgent(sessionUpdate.agent as AgentDefinition, {
        id: sessionUpdate.agent_id as string | undefined,
        version: sessionUpdate.agent_version as number | undefined,
      })
    : undefined;
  return {
    id: event.id,
    seq: event.seq,
    type: event.type,
    content: event.content ?? null,
    ...(event.type === 'session.updated'
      // For this event type the published `metadata` IS the session's bag, so
      // the carrier is never projected — a change that did not touch metadata
      // would otherwise leak the internal `session_updated` wrapper.
      ? (sessionUpdate?.metadata !== undefined ? { metadata: sessionUpdate.metadata as Record<string, unknown> } : {})
      : event.metadata !== undefined ? { metadata: event.metadata } : {}),
    ...(event.type === 'user.tool_confirmation' && typeof event.metadata?.tool_use_id === 'string'
      ? { tool_use_id: event.metadata.tool_use_id }
      : {}),
    ...(usage ? { usage } : {}),
    ...(error ? { error } : {}),
    ...(defineOutcome ?? {}),
    ...(sessionUpdateAgent ? { agent: sessionUpdateAgent } : {}),
    ...(sessionUpdate?.budget !== undefined ? { budget: sessionUpdate.budget as SessionBudget | null } : {}),
    ...(sessionUpdate?.title !== undefined ? { title: sessionUpdate.title as string | null } : {}),
    ...(mcpServerName ? { mcp_server_name: mcpServerName } : {}),
    ...(mcpToolUseId ? { mcp_tool_use_id: mcpToolUseId } : {}),
    ...(toolUseId ? { tool_use_id: toolUseId } : {}),
    ...(customToolUseId ? { custom_tool_use_id: customToolUseId } : {}),
    ...(toolUse ?? {}),
    ...(event.modelUsed !== undefined ? { model_used: event.modelUsed } : {}),
    ...(event.tokensIn !== undefined ? { tokens_in: event.tokensIn } : {}),
    ...(event.tokensOut !== undefined ? { tokens_out: event.tokensOut } : {}),
    ...(event.stopReason !== undefined ? { stop_reason: event.stopReason } : {}),
    ...(sessionStopReason ? { stop_reason: sessionStopReason } : {}),
    ...(event.durationMs !== undefined ? { duration_ms: event.durationMs } : {}),
    ...(streamEvent.delta !== undefined ? { delta: streamEvent.delta } : {}),
    ...(streamEvent.message_id !== undefined ? { message_id: streamEvent.message_id } : {}),
    created_at: event.createdAt ? toIsoString(event.createdAt) : null,
    processed_at: event.processedAt ? toIsoString(event.processedAt) : null,
    parent_event_id: event.parentEventId ?? null,
  };
}

export function toApiSessionStatus(status: SessionStatus): ApiSession['status'] {
  return STATUS_PROJECTION[status].wire;
}

function toApiSessionResource(resource: Record<string, unknown>): ApiSessionResource {
  if (resource.type === 'github_repository') {
    const safeResource = { ...resource };
    delete safeResource.authorization_token;
    return safeResource as ApiSessionResource;
  }
  return resource as ApiSessionResource;
}

function toApiMcpServers(servers: McpServerConfig[]): ApiMcpServer[] {
  return servers.map((server) => {
    if (server.type === 'url') {
      return { type: 'url', name: server.name, url: server.url ?? '' };
    }
    return {
      type: 'stdio',
      name: server.name,
      command: server.command ?? '',
      args: server.args ?? [],
      env: redactEnv(server.env ?? {}),
    };
  });
}

function redactEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(env).map((key) => [key, '${' + key + '}']));
}

function parseStringRecord(value: unknown): Record<string, string> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, recordValue]) => [key, String(recordValue)]),
    );
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parseStringRecord(parsed);
  } catch {
    return {};
  }
}

function parseJsonArray<T = any>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Object-valued metadata entry, or `undefined` when the shape is not an object. */
function metadataObject(event: SessionEvent, key: string): Record<string, unknown> | undefined {
  const value = event.metadata?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function metadataString(event: SessionEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `tool_use_id` carried inside a `tool_result` content block. */
function contentToolUseId(event: SessionEvent): string | undefined {
  const block = event.content?.find((item) => item.type === 'tool_result') as
    | { type: 'tool_result'; tool_use_id?: unknown }
    | undefined;
  return typeof block?.tool_use_id === 'string' && block.tool_use_id.length > 0
    ? block.tool_use_id
    : undefined;
}

/**
 * Top-level projection of a `tool_use` content block.
 *
 * Only `name` and `input` are lifted. The block's own `id` is deliberately left
 * where it is: on this wire the top-level `id` is the persisted event id, which
 * is what a client answers with and what `stop_reason.event_ids` names, so
 * copying the tool-call id over it would break the addressing. `input` is copied
 * as-is, because the block is what the runtime persisted and re-shaping it here
 * would make the stream disagree with the log. Returns `undefined` for every
 * other event type, so a field cannot leak onto an event whose declared type has
 * no such field.
 */
function contentToolUseBlock(
  event: SessionEvent,
): { name?: string; input?: Record<string, unknown> } | undefined {
  if (
    event.type !== 'agent.tool_use'
    && event.type !== 'agent.mcp_tool_use'
    && event.type !== 'agent.custom_tool_use'
  ) {
    return undefined;
  }
  const block = event.content?.find((item) => item.type === 'tool_use') as
    | { type: 'tool_use'; name?: unknown; input?: unknown }
    | undefined;
  if (!block) return undefined;
  const name = typeof block.name === 'string' && block.name.length > 0 ? block.name : undefined;
  const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input)
    ? block.input as Record<string, unknown>
    : undefined;
  if (name === undefined && input === undefined) return undefined;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(input !== undefined ? { input } : {}),
  };
}
