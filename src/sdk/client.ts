/**
 * managed-agents Client SDK
 *
 * A small typed wrapper over the managed-agents HTTP API. Works in Node 22+
 * (uses the global fetch). Provides ergonomic session/agent operations plus
 * SSE streaming (`tail`) and a convenience `chat` (send + stream the reply).
 */

import type { ContentBlock, SessionBudget } from '@/types/cma-protocol.js';
import type { ApiSessionStatus } from '@/types/session.js';
import { withCompatibilityHeaders } from './headers.js';

export interface ClientOptions {
  /** Base URL of the server, e.g. http://localhost:3000 */
  baseUrl: string;
  /** API key (only needed when the server has auth enabled). */
  apiKey?: string;
  /** Optional custom fetch (for testing). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface SessionSummary {
  id: string;
  type: 'session';
  agent: AgentSummary;
  environment_id: string;
  status: ApiSessionStatus;
  title?: string | null;
  resources: Array<Record<string, unknown>>;
  vault_ids: string[];
  /** Spending ceiling — always present, `null` when the session has none. */
  budget: SessionBudget | null;
  /** Engine the session was created with (local extension; the upstream shape has no such field). */
  loop_engine?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  stats: {
    /** Cumulative seconds the session spent executing. */
    active_seconds: number;
    /** Seconds since creation; frozen at the last update once terminal or archived. */
    duration_seconds: number;
  };
  /** Declared outcomes and their evaluation state, in declaration order. */
  outcome_evaluations: Array<{
    type: 'outcome_evaluation';
    outcome_id: string;
    description: string;
    result: string;
    iteration: number;
    explanation: string | null;
    completed_at: string | null;
  }>;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface AgentSummary {
  id: string;
  type: 'agent';
  name: string;
  description: string;
  system: string;
  model: string;
  /**
   * The stored model profile. `effort` is echoed here — on the agent read, the
   * version read, and a session's agent snapshot — but no provider request
   * carries it, so it does not change what the agent runs.
   */
  model_config?: { id?: string; speed: string; effort?: string };
  tools: Array<Record<string, unknown>>;
  mcp_servers: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown>>;
  status: string;
  version: number;
  /** Resolved multiagent roster — always `null`; no runtime can populate it yet. */
  multiagent: null;
  created_at: string | null;
  updated_at: string | null;
  archived_at: string | null;
}

export interface WorkspaceFileSummary {
  id: string;
  type: 'file';
  filename: string;
  media_type: string;
  size_bytes: number;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface SessionArtifactSummary extends Omit<WorkspaceFileSummary, 'type'> {
  type: 'session_artifact';
  session_id: string;
  artifact_path: string;
  preview?: string | null;
  content_url: string;
}

export interface ApiKeySummary {
  id: string;
  type: 'api_key';
  name: string;
  source: 'managed' | 'config_env';
  status: string;
  key_prefix: string;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiKeyCreateResponse extends ApiKeySummary {
  secret_key: string;
}

export interface RuntimeMetricsSummary {
  type: 'metrics_summary';
  generated_at: string;
  sessions: {
    total: number;
    by_status: Record<string, number>;
    input_tokens: number;
    output_tokens: number;
  };
  events: {
    total: number;
    by_type: Record<string, number>;
    input_tokens: number;
    output_tokens: number;
    average_duration_ms: number;
  };
  storage: {
    files: number;
    file_bytes: number;
    artifacts: number;
    artifact_bytes: number;
  };
  work_queue: Record<string, number>;
  http: {
    requests: number;
    errors: number;
    request_duration_ms: { count: number; sum: number };
  };
}

export type RuntimeSettingsState = 'configured' | 'missing_env' | 'not_set';
export type RuntimeSettingsValidationStatus = 'ok' | 'warning' | 'error';

export interface RuntimeSettingsValidationCheck {
  key: string;
  label: string;
  status: RuntimeSettingsValidationStatus;
  message: string;
}

/**
 * One settings area: the selected provider plus its free-form options.
 *
 * These are the wire field names the settings routes actually use (`provider`, not `type`);
 * see `RuntimeSettingsConfig`.
 */
export interface RuntimeSettingsArea {
  provider: string;
  options: Record<string, unknown>;
}

export interface RuntimeSettingsModel {
  vendor: string;
  /**
   * Masked to `********` by every read. Sending the mask back means "keep the stored key",
   * and sending it when nothing is stored is refused rather than written literally.
   *
   * A `${VAR}` reference is stored as a reference and must resolve in the **runtime's**
   * environment, not the client's.
   */
  api_key?: string;
  base_url?: string;
  options: Record<string, unknown>;
}

/** The settings document as stored and returned by `GET`/`PUT /v1/x/settings`. */
export interface RuntimeSettingsConfig {
  schema_version: number;
  model: RuntimeSettingsModel;
  loop_engine: RuntimeSettingsArea;
  storage: {
    metadata: RuntimeSettingsArea;
    artifacts: RuntimeSettingsArea;
  };
  memory: {
    enabled: boolean;
    provider: string;
    options: Record<string, unknown>;
  };
  sandbox: RuntimeSettingsArea;
}

/** Per-area credential state, derived from the vault rather than from the config. */
export type RuntimeSettingsSecretStates = Record<string, Record<string, RuntimeSettingsState>>;

/** The adapter catalogue the runtime reports for each settings area. */
export type RuntimeSettingsAdapters = Record<string, Array<{
  id: string;
  label: string;
  version: string;
  status: string;
  restart_policy: string;
  options_schema: Record<string, unknown>;
}>>;

/**
 * The response of `GET` and `PUT /v1/x/settings`.
 *
 * This previously described `model_provider` / `loop_engine.type` / `storage.metadata.type`
 * / `validation.checks` — a shape no route produces, matching the runtime's internal
 * registry report instead. Every documented field read as `undefined` at runtime while
 * type-checking, which is why the fields below are the routes' own.
 */
export interface RuntimeSettingsSummary {
  schema_version: number;
  revision: number;
  effective_revision: number;
  /** What was last saved. Masks secrets; changes take effect after a restart. */
  saved_config: RuntimeSettingsConfig;
  /** What the running process is actually using, so it can lag `saved_config`. */
  effective_config: RuntimeSettingsConfig;
  restart_required: boolean;
  activation_status: string;
  activation_errors: unknown[];
  diagnostics: {
    metadata: { path: string | null; health: 'ok' | 'failed' };
  };
  secret_states: RuntimeSettingsSecretStates;
  /**
   * Present on `get()`, which describes the installed adapters, and absent on `patch()`,
   * which returns the same document minus the catalogue.
   */
  adapters?: RuntimeSettingsAdapters;
}

export interface RuntimeSettingsValidationIssue {
  path: string;
  code: string;
  message: string;
}

/** The response of `POST /v1/x/settings/validate`. */
export interface RuntimeSettingsValidationResult {
  valid: boolean;
  errors: RuntimeSettingsValidationIssue[];
  warnings: RuntimeSettingsValidationIssue[];
  normalized_config?: RuntimeSettingsConfig;
}

/**
 * A partial settings document, merged over the stored one by `SettingsResource.patch`.
 *
 * `options` is merged one level deep, so patching a single option keeps its siblings.
 */
export interface RuntimeSettingsPatch {
  schema_version?: number;
  model?: Partial<RuntimeSettingsModel>;
  loop_engine?: Partial<RuntimeSettingsArea>;
  storage?: {
    metadata?: Partial<RuntimeSettingsArea>;
    artifacts?: Partial<RuntimeSettingsArea>;
  };
  memory?: Partial<RuntimeSettingsConfig['memory']>;
  sandbox?: Partial<RuntimeSettingsArea>;
}

/**
 * Thrown by `SettingsResource.patch` when the merged configuration is not valid as a whole.
 *
 * Carries the individual issues because they name the fix: a fresh workspace reports
 * `model.api_key`, and an unresolvable environment reference reports `missing_env` with the
 * variable's name — neither of which survives as prose.
 */
export class RuntimeSettingsValidationError extends Error {
  readonly errors: RuntimeSettingsValidationIssue[];
  readonly warnings: RuntimeSettingsValidationIssue[];
  readonly config: RuntimeSettingsConfig;

  constructor(config: RuntimeSettingsConfig, validation: RuntimeSettingsValidationResult) {
    super(
      validation.errors.length > 0
        ? `Runtime settings are invalid: ${validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`
        : 'Runtime settings are invalid',
    );
    this.name = 'RuntimeSettingsValidationError';
    this.errors = validation.errors;
    this.warnings = validation.warnings;
    this.config = config;
  }
}

/**
 * Merge a partial document over a stored one, one level deep per area and one level deep
 * inside each `options` bag.
 *
 * The stored document is never mutated, and every area the patch omits is carried over —
 * which is what keeps a masked secret from being dropped: a write that sent only the area
 * being changed would fail validation, because the routes require the whole document to be
 * valid.
 */
function mergeRuntimeSettings(
  current: RuntimeSettingsConfig,
  patch: RuntimeSettingsPatch,
): RuntimeSettingsConfig {
  const mergeArea = (area: RuntimeSettingsArea, next?: Partial<RuntimeSettingsArea>): RuntimeSettingsArea => ({
    ...area,
    ...next,
    options: { ...area.options, ...(next?.options ?? {}) },
  });
  return {
    schema_version: patch.schema_version ?? current.schema_version,
    model: {
      ...current.model,
      ...patch.model,
      options: { ...current.model.options, ...(patch.model?.options ?? {}) },
    },
    loop_engine: mergeArea(current.loop_engine, patch.loop_engine),
    storage: {
      metadata: mergeArea(current.storage.metadata, patch.storage?.metadata),
      artifacts: mergeArea(current.storage.artifacts, patch.storage?.artifacts),
    },
    memory: {
      ...current.memory,
      ...patch.memory,
      options: { ...current.memory.options, ...(patch.memory?.options ?? {}) },
    },
    sandbox: mergeArea(current.sandbox, patch.sandbox),
  };
}

export interface EnvironmentSummary {
  id: string;
  type: 'environment';
  name: string;
  description: string;
  /** `unknown` is what the runtime reports for a stored config it cannot read. */
  hosting_type: 'local' | 'docker' | 'kubernetes' | 'cloud' | 'self_hosted' | 'unknown';
  sandbox_provider: string | null;
  network: Record<string, unknown>;
  packages: unknown[];
  status: 'active' | 'archived';
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  worker_keys: EnvironmentWorkerKeySummary[];
  work_queue: Record<string, number>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface EnvironmentWorkerKeySummary {
  id: string;
  type: 'environment_worker_key';
  environment_id: string;
  name: string;
  status: string;
  key_prefix: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface EnvironmentWorkerKeyCreateResponse extends EnvironmentWorkerKeySummary {
  secret_key: string;
}

export interface StreamedEvent {
  id?: string;
  /**
   * Append-only per-session sequence, and the value to send as `lastEventId`
   * when resuming: a stream opened without one carries live events only.
   * `0` on a transient frame (`agent.message_stream_*`, `event_start`,
   * `event_delta`), which is never persisted and must not advance the cursor.
   */
  seq?: number;
  type: string;
  content?: ContentBlock[] | null;
  delta?: string;
  message_id?: string;
  /**
   * Why the turn stopped, on `session.status_idle`.
   *
   * `requires_action` is the runtime asking for approval: `event_ids` names the
   * blocking events, and a client answers each one with a `user.tool_confirmation`
   * (or a `user.custom_tool_result` for a custom tool) before the turn can go on.
   * An ended turn carries `end_turn`. A model-derived event spells the same field
   * as the provider's own string, so both shapes are possible here — the object is
   * what the documented client loop reads (`docs/api.md`).
   */
  stop_reason?: string | { type: 'end_turn' | 'requires_action'; event_ids?: string[] };
  /**
   * Structured failure of a `session.error`, projected from the event's metadata
   * carrier. `type` is one of the official error types and `retry_status` is
   * the published object; the runtime's own code is preserved under `code`.
   * Absent on the transient frame the message route emits when the stream
   * itself breaks, which carries the text in `content` instead — a client
   * that only reads this field would miss that one.
   */
  error?: {
    type: string;
    message: string;
    retry_status: { type: 'retrying' | 'exhausted' | 'terminal' };
    code?: string;
  };
  /** The event's own metadata carrier, as persisted and published. */
  metadata?: Record<string, unknown>;
}

/**
 * What the engine did with one `user.steer`.
 *
 * `delivered` — the engine accepted the write.
 * `duplicate` — this `input_id` was already delivered with the same text.
 * `conflict` — this `input_id` was already used with different text.
 * `rejected` — the steer never reached a live engine session, and resending is safe.
 * `outcome_unknown` — the write may or may not have arrived; never replay it.
 */
export interface SteerReceipt {
  input_id: string;
  state: 'delivered' | 'duplicate' | 'conflict' | 'rejected' | 'outcome_unknown';
  turn_id?: string;
  detail?: string;
}

export class ManagedAgentsClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  readonly agents: AgentsResource;
  readonly sessions: SessionsResource;
  readonly files: FilesResource;
  readonly apiKeys: ApiKeysResource;
  readonly metrics: MetricsResource;
  readonly settings: SettingsResource;
  readonly environments: EnvironmentsResource;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
    this.agents = new AgentsResource(this);
    this.sessions = new SessionsResource(this);
    this.files = new FilesResource(this);
    this.apiKeys = new ApiKeysResource(this);
    this.metrics = new MetricsResource(this);
    this.settings = new SettingsResource(this);
    this.environments = new EnvironmentsResource(this);
  }

  /** @internal */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = withCompatibilityHeaders(path, {
      'Content-Type': 'application/json',
    });
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const envelope = await readErrorEnvelope(res);
      throw new ManagedAgentsApiError(res.status, envelope.message || res.statusText, envelope);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** @internal */
  async requestText(method: string, path: string): Promise<string> {
    const headers: Record<string, string> = withCompatibilityHeaders(path, {});
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers });
    if (!res.ok) {
      const envelope = await readErrorEnvelope(res);
      throw new ManagedAgentsApiError(res.status, envelope.message || res.statusText, envelope);
    }
    return res.text();
  }

  /** @internal - opens an SSE stream and yields parsed events. */
  async *stream(
    path: string,
    opts?: { lastEventId?: string; method?: string; body?: unknown },
  ): AsyncIterable<StreamedEvent> {
    const headers: Record<string, string> = withCompatibilityHeaders(path, {
      Accept: 'text/event-stream',
    });
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    if (opts?.lastEventId) headers['Last-Event-ID'] = opts.lastEventId;
    if (opts?.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: opts?.method ?? 'GET',
      headers,
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok || !res.body) {
      // A stream can refuse before it opens — for example a resume cursor the
      // server will not order by — and that refusal is a normal JSON error
      // response. Read it like every other route does, so the caller sees the
      // API's own message instead of a bare status text.
      const envelope = res.ok ? { message: '' } : await readErrorEnvelope(res);
      throw new ManagedAgentsApiError(res.status, envelope.message || `stream failed: ${res.statusText}`, envelope);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseSseFrame(frame);
          // Keepalives are transport, not session events: this runtime sends
          // `ping`, and older servers sent `heartbeat`. Neither may be yielded to
          // a caller, which would otherwise see a `ping` event every 15 seconds.
          const keepalive = parsed?.event === 'ping' || parsed?.event === 'heartbeat';
          if (parsed && !keepalive && parsed.data) {
            try {
              yield JSON.parse(parsed.data) as StreamedEvent;
            } catch {
              // skip malformed frames
            }
          }
        }
      }
    } finally {
      // A consumer is allowed to stop early — an approval flow reads up to the
      // frame that parks the turn, answers it, and reads on from its own cursor —
      // and that must close the response. Leaving it open keeps the pending
      // `read()` (and the socket, and the process) alive after the caller has
      // finished, which is a hang with no error to show for it.
      await reader.cancel().catch(() => {});
    }
  }
}

// ============================================================
// Resources
// ============================================================

class AgentsResource {
  constructor(private readonly client: ManagedAgentsClient) {}

  list(): Promise<{ data: AgentSummary[]; prev_page: string | null; next_page: string | null }> {
    return this.client.request('GET', '/v1/agents');
  }

  get(id: string): Promise<AgentSummary> {
    return this.client.request('GET', `/v1/agents/${encodeURIComponent(id)}`);
  }

  create(input: {
    name: string;
    description?: string;
    model: string | Record<string, unknown>;
    system: string;
    tools?: Array<Record<string, unknown>>;
    mcp_servers?: Array<Record<string, unknown>>;
    skills?: Array<Record<string, unknown>>;
    metadata?: Record<string, unknown>;
  }): Promise<AgentSummary> {
    return this.client.request('POST', '/v1/agents', input);
  }

  async update(id: string, input: Partial<{
    name: string;
    description: string;
    model: string | Record<string, unknown>;
    system: string;
    tools: Array<Record<string, unknown>>;
    mcp_servers: Array<Record<string, unknown>>;
    skills: Array<Record<string, unknown>>;
    metadata: Record<string, unknown>;
    expected_version: number;
  }>): Promise<AgentSummary> {
    const current = await this.get(id);
    const { expected_version, ...patch } = input;
    return this.client.request('PUT', `/v1/agents/${encodeURIComponent(id)}`, {
      name: current.name,
      description: current.description,
      model: current.model,
      system: current.system,
      tools: current.tools,
      mcp_servers: current.mcp_servers,
      skills: current.skills,
      ...patch,
      ...(expected_version !== undefined ? { expected_version } : {}),
    });
  }

  versions(id: string): Promise<{ data: AgentSummary[]; prev_page: string | null; next_page: string | null }> {
    return this.client.request('GET', `/v1/agents/${encodeURIComponent(id)}/versions`);
  }

  archive(id: string): Promise<AgentSummary> {
    return this.client.request('POST', `/v1/agents/${encodeURIComponent(id)}/archive`, {});
  }
}

class SessionsResource {
  constructor(private readonly client: ManagedAgentsClient) {}

  create(input: {
    agent: string | { id: string; type?: 'agent'; version?: number } | {
      type: 'agent_with_overrides';
      id: string;
      version?: number;
      /**
       * Session-local replacements for the agent's configuration.
       *
       * Overrides never merge: a field that is present replaces the agent's
       * value outright, an omitted field is inherited, and `null` (or `[]` for a
       * list) clears it — except `model`, which can never be cleared.
       */
      model?: string | { id: string; speed?: string } | null;
      system?: string | null;
      tools?: Array<Record<string, unknown>> | null;
      mcp_servers?: Array<Record<string, unknown>> | null;
      skills?: Array<Record<string, unknown>> | null;
    };
    environment_id?: string;
    title?: string;
    resources?: Array<Record<string, unknown>>;
    vault_ids?: string[];
    metadata?: Record<string, string>;
  }): Promise<SessionSummary> {
    return this.client.request('POST', '/v1/sessions', input);
  }

  get(id: string): Promise<SessionSummary> {
    return this.client.request('GET', `/v1/sessions/${encodeURIComponent(id)}`);
  }

  /**
   * List sessions.
   *
   * `page` is the cursor a previous call returned in `next_page` / `prev_page`, not a
   * page number: the collection serves the canonical envelope, and a cursor carries
   * the page together with the ordering and filter it was issued under.
   */
  list(opts?: { page?: string; limit?: number; status?: string; agentId?: string }): Promise<{ data: SessionSummary[]; prev_page: string | null; next_page: string | null }> {
    const q = new URLSearchParams();
    if (opts?.page) q.set('page', opts.page);
    if (opts?.limit) q.set('limit', String(opts.limit));
    if (opts?.status) q.set('status', opts.status);
    if (opts?.agentId) q.set('agent_id', opts.agentId);
    const qs = q.toString();
    return this.client.request('GET', `/v1/sessions${qs ? `?${qs}` : ''}`);
  }

  /** Send a user text message (fire-and-forget; stream separately to see the reply). */
  sendMessage(id: string, text: string): Promise<{ accepted: boolean }> {
    return this.sendEvent(id, { type: 'user.message', content: [{ type: 'text', text }] });
  }

  /**
   * Send a user message through the session message convenience endpoint.
   *
   * Defaults to streaming the turn. Pass `{ stream: false }` for an immediate
   * `{ accepted: true }` acknowledgment.
   */
  message(
    id: string,
    content: string | ContentBlock[],
    opts: { stream: false },
  ): Promise<{ accepted: boolean }>;
  message(
    id: string,
    content: string | ContentBlock[],
    opts?: { stream?: true },
  ): AsyncIterable<StreamedEvent>;
  message(
    id: string,
    content: string | ContentBlock[],
    opts?: { stream?: boolean },
  ): Promise<{ accepted: boolean }> | AsyncIterable<StreamedEvent> {
    const path = `/v1/sessions/${encodeURIComponent(id)}/messages`;
    if (opts?.stream === false) {
      return this.client.request('POST', path, { content, stream: false });
    }
    return this.client.stream(path, { method: 'POST', body: { content, stream: true } });
  }

  sendEvent(id: string, event: {
    type: string;
    content?: ContentBlock[];
    tool_use_id?: string;
    custom_tool_use_id?: string;
    result?: 'allow' | 'deny';
    deny_message?: string;
    /** `user.steer` only. Idempotency key; replaying it must not re-apply. */
    input_id?: string;
    /** `user.steer` only. */
    text?: string;
    /** `user.steer` only. Refuses the steer unless it names the active turn. */
    expected_turn_id?: string;
  }): Promise<{ accepted: boolean; steer?: SteerReceipt }> {
    return this.client.request('POST', `/v1/sessions/${encodeURIComponent(id)}/events`, { events: [event] });
  }

  events(id: string, opts?: { limit?: number; afterId?: string; page?: string }): Promise<{ data: StreamedEvent[]; prev_page: string | null; next_page: string | null }> {
    const q = new URLSearchParams();
    if (opts?.limit) q.set('limit', String(opts.limit));
    if (opts?.afterId) q.set('after_id', opts.afterId);
    if (opts?.page) q.set('page', opts.page);
    const qs = q.toString();
    return this.client.request('GET', `/v1/sessions/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ''}`);
  }

  artifacts(id: string): Promise<{ data: SessionArtifactSummary[]; prev_page: string | null; next_page: string | null }> {
    return this.client.request('GET', `/v1/sessions/${encodeURIComponent(id)}/artifacts`);
  }

  createArtifact(id: string, input: {
    path: string;
    content: string;
    media_type?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionArtifactSummary> {
    return this.client.request('POST', `/v1/sessions/${encodeURIComponent(id)}/artifacts`, input);
  }

  artifactText(id: string, artifactId: string): Promise<string> {
    return this.client.requestText('GET', `/v1/sessions/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}/content`);
  }

  /** @deprecated Interrupt the active turn, retaining the sandbox for another message. Prefer interrupt(). */
  stop(id: string): Promise<SessionSummary> {
    return this.client.request('POST', `/v1/sessions/${encodeURIComponent(id)}/stop`);
  }

  archive(id: string): Promise<SessionSummary> {
    return this.client.request('POST', `/v1/sessions/${encodeURIComponent(id)}/archive`);
  }

  delete(id: string): Promise<{ deleted: boolean }> {
    return this.client.request('DELETE', `/v1/sessions/${encodeURIComponent(id)}`);
  }

  interrupt(id: string): Promise<{ accepted: boolean }> {
    return this.sendEvent(id, { type: 'user.interrupt' });
  }

  /**
   * Steer a live engine session without starting a new turn.
   *
   * `inputId` is an idempotency key: repeating it with the same `text` is
   * answered as a `duplicate` rather than applied twice, and repeating it with
   * different text is refused as a `conflict`. An `outcome_unknown` receipt must
   * never be retried — the write may already have reached the engine.
   */
  steer(id: string, input: {
    inputId: string;
    text: string;
    expectedTurnId?: string;
  }): Promise<{ accepted: boolean; steer?: SteerReceipt }> {
    return this.sendEvent(id, {
      type: 'user.steer',
      input_id: input.inputId,
      text: input.text,
      ...(input.expectedTurnId ? { expected_turn_id: input.expectedTurnId } : {}),
    });
  }

  approveTool(id: string, toolUseId: string): Promise<{ accepted: boolean }> {
    return this.sendEvent(id, { type: 'user.tool_confirmation', tool_use_id: toolUseId, result: 'allow' });
  }

  denyTool(id: string, toolUseId: string, message?: string): Promise<{ accepted: boolean }> {
    return this.sendEvent(id, {
      type: 'user.tool_confirmation',
      tool_use_id: toolUseId,
      result: 'deny',
      ...(message ? { deny_message: message } : {}),
    });
  }

  customToolResult(
    id: string,
    customToolUseId: string,
    content: string | ContentBlock[],
  ): Promise<{ accepted: boolean }> {
    const blocks = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;
    return this.sendEvent(id, {
      type: 'user.custom_tool_result',
      custom_tool_use_id: customToolUseId,
      content: blocks,
    });
  }

  /**
   * Tail a session's event stream (never closes until aborted).
   *
   * Without `lastEventId` the stream carries live events only — nothing already
   * recorded is replayed — so a caller that also wants the log reads
   * `sessions.events(id)` and passes the sequence it reached as `lastEventId`
   * (which replays the events after it, with no gap against that read).
   */
  tail(id: string, opts?: { lastEventId?: string }): AsyncIterable<StreamedEvent> {
    return this.client.stream(`/v1/sessions/${encodeURIComponent(id)}/events/stream`, opts);
  }

  /**
   * Send a message and stream the reply. Yields events until the session goes
   * idle. Opens the stream BEFORE sending to avoid missing early events.
   */
  async *chat(id: string, text: string): AsyncIterable<StreamedEvent> {
    const stream = this.message(id, text);
    for await (const event of stream) {
      yield event;
      if (event.type === 'session.status_idle' || event.type === 'session.status_terminated') {
        return;
      }
    }
  }
}

class FilesResource {
  constructor(private readonly client: ManagedAgentsClient) {}

  list(): Promise<{ data: WorkspaceFileSummary[]; prev_page: string | null; next_page: string | null }> {
    return this.client.request('GET', '/v1/files');
  }

  get(id: string): Promise<WorkspaceFileSummary> {
    return this.client.request('GET', `/v1/files/${encodeURIComponent(id)}`);
  }

  create(input: { name: string; content: string; media_type?: string; metadata?: Record<string, unknown> }): Promise<WorkspaceFileSummary> {
    return this.client.request('POST', '/v1/files', input);
  }

  text(id: string): Promise<string> {
    return this.client.requestText('GET', `/v1/files/${encodeURIComponent(id)}/content`);
  }

  delete(id: string): Promise<WorkspaceFileSummary> {
    return this.client.request('DELETE', `/v1/files/${encodeURIComponent(id)}`);
  }
}

class ApiKeysResource {
  constructor(private readonly client: ManagedAgentsClient) {}

  list(): Promise<{ data: ApiKeySummary[]; prev_page: string | null; next_page: string | null }> {
    return this.client.request('GET', '/v1/api-keys');
  }

  create(input: { name: string; metadata?: Record<string, unknown> }): Promise<ApiKeyCreateResponse> {
    return this.client.request('POST', '/v1/api-keys', input);
  }

  delete(id: string): Promise<{ id: string; type: 'api_key_deleted' }> {
    return this.client.request('DELETE', `/v1/api-keys/${encodeURIComponent(id)}`);
  }
}

class MetricsResource {
  constructor(private readonly client: ManagedAgentsClient) {}

  prometheus(): Promise<string> {
    return this.client.requestText('GET', '/v1/x/metrics');
  }

  summary(): Promise<RuntimeMetricsSummary> {
    return this.client.request('GET', '/v1/x/metrics/summary');
  }
}

class SettingsResource {
  constructor(private readonly client: ManagedAgentsClient) {}

  get(): Promise<RuntimeSettingsSummary> {
    return this.client.request('GET', '/v1/x/settings');
  }

  /**
   * Update runtime settings from a partial document.
   *
   * The runtime mounts `PUT /v1/x/settings`, which replaces the whole document under an
   * optimistic-concurrency `revision` guard — **there is no `PATCH` route**, which is what
   * this method used to send, so it answered `404 No route matches this request` every time.
   * A partial update is therefore composed as read-merge-write: read the current revision
   * and `saved_config`, merge `input` over it, and write the result back with the revision
   * that was read. `revision` is not a parameter because a caller has no way to obtain a
   * fresher one than this method can.
   *
   * Two requests are made when the merge is invalid and two when it is valid: `validate()`
   * runs first so a refusal carries its issues. The route answers a bad write with a bare
   * `validation_error` whose detail the shared error path drops (#464), and the detail is
   * the whole value — it names the missing `model.api_key` or the unresolvable environment
   * variable. The extra round trip is the price of not silently losing it; `PUT` re-validates
   * server-side, so this is a diagnostic, not a guarantee.
   *
   * Secrets survive the round trip: reads mask them as `********` and the store treats that
   * sentinel as "keep the stored value", so a patch of an unrelated area does not overwrite a
   * stored key. A concurrent writer makes the write fail with `409` rather than losing one of
   * the two updates, and that surfaces as a `ManagedAgentsApiError` — the SDK cannot know
   * whether re-applying the same patch is still meaningful.
   */
  async patch(input: RuntimeSettingsPatch = {}): Promise<RuntimeSettingsSummary> {
    const current = await this.get();
    const config = mergeRuntimeSettings(current.saved_config, input);
    const validation = await this.validate(config);
    if (!validation.valid) throw new RuntimeSettingsValidationError(config, validation);
    return this.client.request('PUT', '/v1/x/settings', { revision: current.revision, config });
  }

  /**
   * Validate a candidate settings document without saving it.
   *
   * The route validates whatever it is given as a **complete** document, so a partial one
   * reports every area it does not mention. Pass the stored document (from `get()`) to ask
   * whether the current settings are valid, or a merged document to ask about a change.
   */
  validate(config: RuntimeSettingsPatch): Promise<RuntimeSettingsValidationResult> {
    return this.client.request('POST', '/v1/x/settings/validate', config);
  }
}

class EnvironmentsResource {
  constructor(private readonly client: ManagedAgentsClient) {}

  list(): Promise<{ data: EnvironmentSummary[]; prev_page: string | null; next_page: string | null }> {
    return this.client.request('GET', '/v1/environments');
  }

  get(id: string): Promise<EnvironmentSummary> {
    return this.client.request('GET', `/v1/environments/${encodeURIComponent(id)}`);
  }

  create(input: {
    name: string;
    description?: string;
    /** The published `config.type` spelling is accepted too; `cloud` is refused. */
    hosting_type?: 'local' | 'docker' | 'kubernetes' | 'cloud' | 'self_hosted';
    sandbox_provider?: string;
    network?: Record<string, unknown>;
    packages?: unknown[];
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<EnvironmentSummary> {
    return this.client.request('POST', '/v1/environments', input);
  }

  update(id: string, input: Partial<{
    name: string;
    description: string;
    /** The published `config.type` spelling is accepted too; `cloud` is refused. */
    hosting_type: 'local' | 'docker' | 'kubernetes' | 'cloud' | 'self_hosted';
    sandbox_provider: string;
    network: Record<string, unknown>;
    packages: unknown[];
    config: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }>): Promise<EnvironmentSummary> {
    return this.client.request('PUT', `/v1/environments/${encodeURIComponent(id)}`, input);
  }

  archive(id: string): Promise<EnvironmentSummary> {
    return this.client.request('POST', `/v1/environments/${encodeURIComponent(id)}/archive`, {});
  }

  workerKeys(id: string): Promise<{ data: EnvironmentWorkerKeySummary[]; prev_page: string | null; next_page: string | null }> {
    return this.client.request('GET', `/v1/environments/${encodeURIComponent(id)}/worker-keys`);
  }

  createWorkerKey(id: string, input: { name?: string; expires_at?: string; metadata?: Record<string, unknown> } = {}): Promise<EnvironmentWorkerKeyCreateResponse> {
    return this.client.request('POST', `/v1/environments/${encodeURIComponent(id)}/worker-keys`, input);
  }

  revokeWorkerKey(id: string, keyId: string): Promise<EnvironmentWorkerKeySummary> {
    return this.client.request('POST', `/v1/environments/${encodeURIComponent(id)}/worker-keys/${encodeURIComponent(keyId)}/revoke`, {});
  }
}

// ============================================================
// Errors + SSE parsing
// ============================================================

/**
 * The published error envelope: `{"error":{"type":..., "code":..., "message":...}}`.
 *
 * `type` is the canonical error class (D11: `invalid_request_error`, with `not_found` and
 * `conflict` deliberately kept as their own), and `code` names a specific cause within it.
 * A caller branches on these; the message is prose and is not a stable interface.
 */
export interface ApiErrorEnvelope {
  type?: string;
  code?: string;
}

export class ManagedAgentsApiError extends Error {
  /**
   * The envelope's `type`, e.g. `invalid_request_error`.
   *
   * `undefined` when the response carried no envelope — a non-JSON body, or a transport that
   * failed before the runtime answered.
   */
  readonly type?: string;
  /** The envelope's `code`, e.g. `invalid_agent_ref`, when the cause is specific enough to name. */
  readonly code?: string;

  constructor(
    public readonly status: number,
    message: string,
    envelope: ApiErrorEnvelope = {},
  ) {
    super(`API error ${status}: ${message}`);
    this.name = 'ManagedAgentsApiError';
    this.type = envelope.type;
    this.code = envelope.code;
  }
}

/**
 * Read a failed response's published envelope, consuming the body exactly once.
 *
 * The previous version called `res.json()` and then `res.text()` on the same response. A
 * `Response` body is single-use, so the fallback could never succeed — and `error.type` and
 * `error.code` were never read at all, which is what made the runtime's whole error taxonomy
 * unreachable from the SDK.
 *
 * A body that is not JSON is returned as the message, which is what the dead fallback was for;
 * a JSON body that is not an envelope keeps the previous `statusText` fallback, so only the
 * envelope's fields are newly reachable.
 */
async function readErrorEnvelope(res: Response): Promise<{ message: string } & ApiErrorEnvelope> {
  const raw = await res.text().catch(() => '');
  if (!raw) return { message: '' };
  try {
    const parsed = JSON.parse(raw) as { error?: { type?: unknown; code?: unknown; message?: unknown } } | null;
    const error = parsed?.error;
    if (!error || typeof error !== 'object') return { message: '' };
    return {
      message: typeof error.message === 'string' ? error.message : '',
      ...(typeof error.type === 'string' ? { type: error.type } : {}),
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
    };
  } catch {
    return { message: raw };
  }
}

function parseSseFrame(frame: string): { event?: string; data?: string; id?: string } | null {
  const result: { event?: string; data?: string; id?: string } = {};
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) result.event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    else if (line.startsWith('id:')) result.id = line.slice(3).trim();
  }
  if (dataLines.length) result.data = dataLines.join('\n');
  return Object.keys(result).length ? result : null;
}
