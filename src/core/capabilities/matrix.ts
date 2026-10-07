/**
 * CMA capability matrix.
 *
 * One entry per contract area, each recording whether SandBase implements the
 * published behaviour and why. The matrix exists because "we did not implement
 * this" and "we chose not to implement this" are different facts that a single
 * boolean cannot express, and because an unverified claim must be visibly
 * unverified rather than silently counted as done.
 *
 * Contract documents under `contracts/anthropic-cma/` are the prose companion:
 * each one restates the status of the entries that cite it in a
 * `<!-- capability-status … -->` block, cites only source and test files that
 * exist, and lists the mounted route surface. `tests/unit/contract-honesty.test.ts`
 * holds all three sides — this matrix, those documents, and the real mount graph —
 * to the same fact, so none of them can drift alone.
 */

/**
 * Capability status.
 *
 * - `supported` — implemented and covered by tests that exercise the behaviour.
 * - `partial` — implemented for a documented subset, or with a documented
 *   deviation. The entry's `reason` must name the deviation.
 * - `unavailable` — not implemented; a request relying on it fails before
 *   persisting state or executing anything.
 * - `planned` — not implemented and scheduled as future work.
 * - `not_applicable` — deliberately out of scope for a local-first runtime.
 * - `unverified` — implemented, but not confirmed against the published
 *   contract or a real service. Not a claim of correctness.
 */
export const CAPABILITY_STATUSES = [
  'supported',
  'partial',
  'unavailable',
  'planned',
  'not_applicable',
  'unverified',
] as const;

export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** Contract areas, matching the file names under `contracts/anthropic-cma/`. */
export const CAPABILITY_AREAS = [
  'headers',
  'pagination',
  'errors',
  'agents',
  'sessions',
  'budget',
  'threads',
  'events',
  'streaming',
  'tools',
  'custom-tools',
  'system-message',
  'memory-stores',
  'dreams',
  'files',
  'credentials',
  'environments',
  'github-repository',
  'operations',
  'capabilities',
  'routes',
  'unsupported',
] as const;

export type CapabilityArea = (typeof CAPABILITY_AREAS)[number];

export interface CapabilityEntry {
  /** Contract area this entry describes. */
  area: CapabilityArea;
  /** Precise identity of the capability within the area. */
  id: string;
  status: CapabilityStatus;
  /** Why this status, in one sentence. Required for every non-`supported` entry. */
  reason: string;
  /** Contract document that carries the seven-section detail. */
  contract: string;
}

/**
 * The matrix.
 *
 * Statuses are deliberately conservative. A capability is only `supported`
 * when a test exercises the published behaviour; anything inferred from local
 * behaviour alone is `unverified`.
 */
export const CMA_CAPABILITY_MATRIX: readonly CapabilityEntry[] = [
  {
    area: 'headers',
    id: 'compatibility-header-admission',
    status: 'partial',
    reason: 'Version, beta, and mutual-exclusion rules are enforced for any request that carries a compatibility header. A request with no compatibility header is accepted as a local caller, which the published contract does not define; this header-free path is a deliberate local-first extension for a self-hosted single-tenant runtime, recorded as such in the headers contract §4, and it is why this entry stays partial.',
    contract: 'contracts/anthropic-cma/headers.md',
  },
  {
    area: 'headers',
    id: 'extension-namespace-exclusion',
    status: 'supported',
    reason: '/v1/x/* never enters CMA admission, so local extensions cannot be gated by cloud beta headers.',
    contract: 'contracts/anthropic-cma/headers.md',
  },
  {
    area: 'pagination',
    id: 'opaque-cursors',
    status: 'partial',
    reason: 'A collection\'s envelope follows the mount: the operations router serves `/v1` with `{data, prev_page, next_page}` and its `/v1/x` mirror with the local `{data, has_more, first_id, last_id}`, chosen through one pager so no handler emits both spellings, and cursors that are readable base64url JSON rather than opaque binary. Every canonical `/v1` collection serves the canonical envelope, with no exceptions: the complete-set listings carry `{data, prev_page: null, next_page: null}` and the windowed ones carry a followable cursor — `/v1/sessions` pages by number under `{order, created_at bounds, page}` and rejects a cursor replayed under another ordering or creation window, `/v1/sessions/{id}/events` carries `{order, filter, after_id}`, `/v1/skills` and the credential audit listings use `{offset, filter}` — so a cut page says so instead of looking complete. The one listing that is neither shape is `/v1/environments/{id}/work-items`, a windowed extension that adds a `counts` object and is named in the contract.',
    contract: 'contracts/anthropic-cma/pagination.md',
  },
  {
    area: 'pagination',
    id: 'cursor-query-binding',
    status: 'supported',
    reason: 'A cursor records the ordering that produced it, and the session listing also records the creation-time bounds, so a replay under a different ordering or window is rejected rather than returning a page that never existed for that query; other session-list filters may change freely across a replay, matching the published rule that only `order` and `created_at[*]` bind a cursor.',
    contract: 'contracts/anthropic-cma/pagination.md',
  },
  {
    area: 'errors',
    id: 'structured-error-envelope',
    status: 'supported',
    reason: 'Every rejection returns {error:{type,message}} with a stable code where the caller needs to branch programmatically.',
    contract: 'contracts/anthropic-cma/errors.md',
  },
  {
    area: 'agents',
    id: 'agent-crud',
    status: 'supported',
    reason: 'Canonical agent definitions are created, listed, read, and version-archived through /v1/agents. An omitted or null system prompt on create normalizes to an empty string; updates preserve an omitted prompt and allow explicit clearing.',
    contract: 'contracts/anthropic-cma/agents.md',
  },
  {
    area: 'agents',
    id: 'model-object-profile',
    status: 'partial',
    reason: 'String and object model forms parse field by field. `effort` and `speed` are stored, returned by the read projection (the agent read, the version read, and the session snapshot), and executed on the Anthropic provider under a model capability table — `effort` becomes `output_config.effort`, `fast` becomes `speed: "fast"` with the fast-mode beta, and adaptive-thinking models receive `thinking: {type: "adaptive", display: "omitted"}`; a listed model refused a level or speed it cannot take fails admission, an unknown model id or non-Anthropic provider sends nothing, and a deployment\'s own `reasoning_effort` model setting is operator-level and separate. `inference_geo` is refused by name with `unsupported_model_field` because this runtime has no inference-geography control; and a canonical `multiagent` roster is refused by name rather than executed.',
    contract: 'contracts/anthropic-cma/agents.md',
  },
  {
    area: 'agents',
    id: 'multiagent-roster',
    status: 'unavailable',
    reason: 'A canonical `multiagent` roster is refused by name on both agent create and agent update, because no thread, coordinator, or advisor surface exists to honour it; accepting it would let a caller believe delegation by roster is in effect. Local delegation is registered separately as an extension.',
    contract: 'contracts/anthropic-cma/agents.md',
  },
  {
    area: 'agents',
    id: 'local-delegation-subagent',
    status: 'supported',
    reason: 'A local extension, not the canonical roster: `delegations` names the agents an agent may call through `delegate_to_<name>` tools, and the boolean `enable_general_subagent` exposes a `general_subagent` tool that runs a temporary copy of the agent as a one-level child that cannot delegate further. Both are string/boolean fields the published contract does not define.',
    contract: 'contracts/anthropic-cma/agents.md',
  },
  {
    area: 'sessions',
    id: 'session-lifecycle',
    status: 'supported',
    reason: 'Public session status is limited to idle, running, rescheduling, and terminated through one shared projection. Approval waits are idle; failed, cancelled, timed_out, and cleanup_pending are terminated. Failed sessions reject new input with 409 before persistence or execution, and the repeatable `statuses`/`statuses[]` list filter selects every internal state in each requested public group. A transient model failure drives the rescheduling group: the first scheduled retry in a turn writes session.error{retry_status: retrying} and session.status_rescheduled, a recovered request writes session.status_running again, and an exhausted policy writes session.error{retry_status: exhausted} and idles with stop_reason retries_exhausted rather than terminating. The deprecated local /stop alias interrupts the active turn, drains execution, and returns a full session envelope; successful builtin and Pi interruptions retain the sandbox and permit another message. Idle stops are no-ops and already terminal sessions return 409; unconfirmed Pi cleanup still fails closed. The alias is removed next version; logical deletion is unchanged. Sessions can otherwise be created, resumed, interrupted, and terminated, and a `session.status_idle` event exposes the session-level `stop_reason` object at the top level, which is where the published client reads `stop_reason.type` to decide between answering a blocking call and stopping. The object is exactly the published `{type, event_ids}`, and both parked-work families are covered: `event_ids` names approval-gated `agent.tool_use` / `agent.mcp_tool_use` calls and unanswered `agent.custom_tool_use` calls by their own event id, and a `user.tool_confirmation` or `user.custom_tool_result` may address a call by that id or by the local `tool_use` block id. The resume turn starts only once nothing is parked, so the published answer-one-id-per-entry loop works as written: each answer is recorded as it arrives and the session stays in internal `requires_action` (public `idle`) until the last one. The wait itself is unbounded by default, matching the published "waits indefinitely"; an operator may set `loop_engine.options.requires_action_timeout_seconds` to bound it, and an expired wait ends with a coded `session.error` and internal `timed_out` (public `terminated`) rather than answering the calls on the caller\'s behalf. That bound is a local extension, and it deliberately never fires on a session at its spending ceiling, which is still `requires_action` here and still waiting for a settlement event the budget accepts. The session object carries its published fields in full: `budget` always present (`null` for never-set and removed alike), `stats.active_seconds`/`stats.duration_seconds` derived from the status-transition log (the list route reads them in one bulk query), the materialized `agent` pinning `version` with `multiagent: null`, and `outcome_evaluations` projected from the declaration and evaluation spans on create, retrieve, and list (the list route shares the same bulk-query path); `loop_engine` is the sole extension key.',
    contract: 'contracts/anthropic-cma/sessions.md',
  },
  {
    area: 'sessions',
    id: 'initial-events',
    status: 'supported',
    reason: 'initial_events are validated against the documented whitelist and the 50-event ceiling, and creation plus resource attachment plus event delivery is wrapped in one local transaction so a rejected event cannot leave a half-created session. A `redacted` content block — the runtime\'s placeholder for model-withheld content — is refused there and on every other user ingress (`/messages`, the `/events` batch, `/v1/runs` input) with 400 rather than persisted.',
    contract: 'contracts/anthropic-cma/sessions.md',
  },
  {
    area: 'sessions',
    id: 'prompt-caching',
    status: 'supported',
    reason: 'A session whose model resolves to an anthropic-provider client sends cache_control: {type: "ephemeral"} breakpoints on the system prompt, the last tool definition, and the second-to-last message — the end of the previous turn — so three markers stay inside the four-breakpoint cap at the default five-minute TTL, the same automatic caching the platform applies without caller configuration. Requests to every other provider type carry none.',
    contract: 'contracts/anthropic-cma/sessions.md',
  },
  {
    area: 'sessions',
    id: 'session-update',
    status: 'supported',
    reason: '`POST /v1/sessions/{id}` applies `agent` limited to `tools`/`mcp_servers` (merged onto the resolved definition, validated like creation, and materialized as `agent_definition` without touching the agent row), a `metadata` merge patch (`null` per key removes, `null` field is no change), a `title` replace (`null` clears), a `vault_ids` rebind under creation\'s vault validation (an empty array detaches every vault, and live MCP connections are torn down so they reconnect under the new scope), and a `budget` move under the budget contract\'s rules (`budget_create_only`, `budget_not_raised`, `model_not_budgetable`, `budget_invalid_*`). An agent change requires an externally idle session (`session_not_idle` while running); title, metadata, budget, and vault bindings move in any non-terminal state, and a terminated or archived session is `session_terminated`. One `session.updated` event carries only the changed fields — the full agent snapshot, the new ceiling or `null`, the whole post-update metadata bag, the new title, the rebound vault ids — and a no-op emits none.',
    contract: 'contracts/anthropic-cma/sessions.md',
  },
  {
    area: 'budget',
    id: 'session-budget',
    status: 'partial',
    reason: 'Consumption is priced in integer microcents from the append-only log, and a session may declare a max_list_cost ceiling at creation. The builtin loop checks the ceiling inside a turn: the step that crossed the cap is the last one, the session idles with stop_reason budget_reached and a session.usage immediately before it, and an accepted budget update or removal resumes the session on its own — a tool call the ceiling stranded is settled so the resumed turn sees a paired transcript. At the ceiling the next work-starting event is refused with budget_reached while events that settle work already in flight are still accepted, so the next model request does not start; a declared outcome\'s revision loop reads the same spend and stops at the ceiling too, closing the outcome with result budget_reached rather than starting another grading pass or turn, because the loop\'s turns are internal to an event that was already admitted. Two deviations are deliberate: prices come from an operator-supplied cost profile rather than official list prices, so a session whose model the profile cannot price is refused a budget and usage.list_cost is withheld while any used model is unpriced; and the pause is reported on the session\'s own status_idle only, because the published thread-level budget_reached signal belongs to the thread surface, which this runtime does not implement.',
    contract: 'contracts/anthropic-cma/budget.md',
  },
  {
    area: 'events',
    id: 'append-only-event-log',
    status: 'supported',
    reason: 'The event log is append-only and every event carries a monotonic sequence number.',
    contract: 'contracts/anthropic-cma/events.md',
  },
  {
    area: 'events',
    id: 'processed-at-lifecycle',
    status: 'supported',
    reason: 'Inbound events record processed_at once admitted, so a client can tell queued from handled.',
    contract: 'contracts/anthropic-cma/events.md',
  },
  {
    area: 'events',
    id: 'session-error-structure',
    status: 'supported',
    reason: 'Every failure path through a turn appends session.error carrying {error:{type,message,retry_status,code}}. type is one of the eight official values, retry_status is the published {type} object, the runtime\'s own code is preserved under code, and events persisted with the legacy string disposition are normalized on projection.',
    contract: 'contracts/anthropic-cma/events.md',
  },
  {
    area: 'events',
    id: 'error-enum-completeness',
    status: 'supported',
    reason: 'Every published session.error type is one of the eight official values; the runtime\'s finer-grained local codes travel under the error.code extension rather than leaking into type. billing_error has no local producer because this runtime has no billing boundary.',
    contract: 'contracts/anthropic-cma/events.md',
  },
  {
    area: 'events',
    id: 'model-request-span-pair',
    status: 'supported',
    reason: 'Every model request brackets itself with a span.model_request_start / _end pair: the builtin strategy opens the start when the SDK prepares the step and closes the end on completion or failure, the Pi translator emits its own, and one prepareStep-to-onStepFinish cycle is one request, so middleware retries produce exactly one pair. The end carries model_request_start_id, is_error (null on rows persisted before the events.is_error column), and model_usage projected from the row\'s usage columns so input_tokens is the uncached share; the local extension fields (model_used, tokens_in/out, stop_reason, duration_ms, parent_event_id) project beside it, and model_usage.speed reports the request\'s effective speed when the run actually used fast mode.',
    contract: 'contracts/anthropic-cma/events.md',
  },
  {
    area: 'streaming',
    id: 'resumable-sse',
    status: 'supported',
    reason: 'A stream is live-only without a cursor and replays from the last delivered sequence with no gaps or duplicates when one is sent; a cursor that is not a sequence number is refused before the stream opens.',
    contract: 'contracts/anthropic-cma/streaming.md',
  },
  {
    area: 'streaming',
    id: 'agent-message-stream-preview',
    status: 'supported',
    reason: 'event_start and event_delta previews are opt-in, not persisted, and absent from the default buffered stream.',
    contract: 'contracts/anthropic-cma/streaming.md',
  },
  {
    area: 'tools',
    id: 'builtin-tool-execution',
    status: 'supported',
    reason: 'Every published built-in tool executes: file, shell, search, web_fetch, and web_search. web_search is configuration-gated like the published service — it mounts only when Settings names a search provider, and an explicit declaration on an unconfigured runtime fails admission with a reason pointing at Settings rather than dying mid-turn.',
    contract: 'contracts/anthropic-cma/tools.md',
  },
  {
    area: 'tools',
    id: 'web-fetch-execution',
    status: 'partial',
    reason: 'WebFetch executes over HTTP/HTTPS with domain policy, per-redirect revalidation, private-address rejection, timeout and byte caps, HTML text extraction, and a max_content_tokens budget; it converts text-like content only (no image or PDF rendering), the token budget is a character estimate, and TLS hostnames are verified but content is not sandboxed beyond redaction.',
    contract: 'contracts/anthropic-cma/tools.md',
  },
  {
    area: 'tools',
    id: 'web-tool-domain-policy',
    status: 'supported',
    reason: 'The domain grammar, one-of allowed/blocked exclusivity, and the empty-list rejection match the published rules.',
    contract: 'contracts/anthropic-cma/tools.md',
  },
  {
    area: 'tools',
    id: 'tool-output-overflow',
    status: 'partial',
    reason: 'Overflow has one unified contract (spill path, preview, marker, retrieval), but the local threshold is 50,000 chars rather than the published 100,000.',
    contract: 'contracts/anthropic-cma/tools.md',
  },
  {
    area: 'tools',
    id: 'mcp-tool-approval-gate',
    status: 'supported',
    reason: 'An mcp_toolset defaults to always_ask and an agent_toolset to always_allow; a tool discovered at connect time is admitted only if the toolset is enabled and not denied, and a discovered tool that inherits always_ask reaches the user for confirmation because the gate is derived from the resolved tool map, not from the declared configs alone.',
    contract: 'contracts/anthropic-cma/tools.md',
  },
  {
    area: 'custom-tools',
    id: 'custom-tool-declaration',
    status: 'supported',
    reason: 'Custom tool declarations parse to the canonical wire shape and are reflected back in the agent definition.',
    contract: 'contracts/anthropic-cma/custom-tools.md',
  },
  {
    area: 'system-message',
    id: 'system-message-events',
    status: 'supported',
    reason: 'system.message is accepted and persisted as its own event domain.',
    contract: 'contracts/anthropic-cma/system-message.md',
  },
  {
    area: 'memory-stores',
    id: 'memory-crud',
    status: 'supported',
    reason: 'Memory stores and memories support create, read, update, delete, and list with path and depth scoping. The published object fields (memory_store_id, content_sha256, memory_version_id) and view projections are emitted.',
    contract: 'contracts/anthropic-cma/memory-stores.md',
  },
  {
    area: 'memory-stores',
    id: 'memory-limits-and-preconditions',
    status: 'supported',
    reason: 'Size, per-store, per-session, and instruction limits are enforced, and content_sha256 preconditions gate writes.',
    contract: 'contracts/anthropic-cma/memory-stores.md',
  },
  {
    area: 'memory-stores',
    id: 'memory-version-audit',
    status: 'supported',
    reason: 'Each write records a memory version that can be listed and read afterwards, and a non-head version can be redacted.',
    contract: 'contracts/anthropic-cma/memory-stores.md',
  },
  {
    area: 'memory-stores',
    id: 'memory-multi-mount',
    status: 'supported',
    reason: 'A session attaches up to 8 stores, each with its own mount path, instructions, and access; one binding resolution feeds the ContextBuilder, the memory API, and the sandbox file tools, and read_only is enforced at the tool layer rather than only declared.',
    contract: 'contracts/anthropic-cma/memory-stores.md',
  },
  {
    area: 'github-repository',
    id: 'github-repository-materialization',
    status: 'supported',
    reason: 'The composition root injects the materializer, the clone is copied through the sandbox at the canonical `/workspace/<repo>` root, and the executor reads each discovered SKILL.md back out of the sandbox: on the `local` backend, which maps that root into its sandbox directory, an attached repository is cloned, checked out, its skills reach the system prompt, and the mount path, URL, and checkout are named in the agent\'s instructions. A session whose Environment selects a backend that cannot serve that root is refused when it is created, with `resource_not_mountable`, so no session is admitted that could only fail at provisioning. The supported scope is `local`: `docker` refuses every absolute path, `kubernetes` was never exercised against a cluster, and `self_hosted` resolves the path inside the worker\'s own root, so all three are refused at creation rather than served.',
    contract: 'contracts/anthropic-cma/github-repository.md',
  },
  {
    area: 'github-repository',
    id: 'github-repository-identity-freeze',
    status: 'supported',
    reason: 'Changing the repository URL, checkout, or mount path of a running session is refused by the resource PATCH route, which accepts only `authorization_token` and names every other field in the rejection: the registered skills and any files already read cannot be retroactively corrected, so a new session is required.',
    contract: 'contracts/anthropic-cma/github-repository.md',
  },
  {
    area: 'files',
    id: 'file-resources',
    status: 'supported',
    reason: 'Upload, list, read, resource identity, and canonical mount-path derivation are implemented and tested, and the composition root injects a reader built from the database and the artifact store, so an attached file is written at provisioning. On the `local` backend, which maps the canonical `/mnt/session/uploads` root into its sandbox directory, the bytes land where the resource says they are, are readable through the same path, and the mount path is named in the agent\'s instructions in both the canonical and the shell-usable spelling. A session whose Environment selects a backend that cannot serve that root is refused when it is created, with `resource_not_mountable`, so no session is admitted that could only fail at provisioning. The supported scope is `local`: `docker` refuses every absolute path, `kubernetes` rejects the upload root and was never exercised against a cluster, and `self_hosted` resolves the path inside the worker\'s own root, so all three are refused at creation rather than served.',
    contract: 'contracts/anthropic-cma/files.md',
  },
  {
    area: 'files',
    id: 'file-mount-path',
    status: 'supported',
    reason: 'The canonical mount path form is produced and validated for every file resource.',
    contract: 'contracts/anthropic-cma/files.md',
  },
  {
    area: 'credentials',
    id: 'canonical-credential-wire-profile',
    status: 'supported',
    reason: 'The nested auth profile, write-only secret fields, and locked structural fields are enforced on write and projected on read.',
    contract: 'contracts/anthropic-cma/credentials.md',
  },
  {
    area: 'credentials',
    id: 'credential-rotation',
    status: 'supported',
    reason: 'Rotating a secret replaces only the ciphertext and leaves the credential identity unchanged. The rotate route then asks every live session that references the vault to close and reconnect its MCP transports, so the next tool call is authenticated with the new value rather than the one the transport was built with; a reconnect failure is reported rather than rolled back, and the MCP status stays the source of truth for a degraded server.',
    contract: 'contracts/anthropic-cma/credentials.md',
  },
  {
    area: 'credentials',
    id: 'credential-injection-execution',
    status: 'supported',
    reason: 'Placeholder + egress substitution is the published model. On a backend that owns an egress boundary (local, docker), a turn\'s environment credentials enter the sandbox and every stdio MCP server as opaque `__cred_<id>__` tokens — `env` never prints a secret — and the session\'s egress proxy materializes the real value on the outbound request, scoped to the credential\'s own `allowed_hosts`; the substitution covers headers, the request line, and the request body, the token is stable per credential so a vault rotation re-resolution updates the value a live process resolves to, and a `limited` credential with no declared target host is admissible under this model because the value can only appear on the wire toward a host its policy covers. A url-transport MCP server still receives credentials scoped to its own `mcp_server_url` on the request headers it presents in-process, a delegated sub-agent inherits exactly the parent session\'s `vault_ids` resolved against its own freshly provisioned boundary, and model requests carry the `request_header` credentials the policy admits for the resolved endpoint host. Everything a tool hands back is redacted and retained values are cleared when the turn ends. Two honest limits: substitution happens on the proxy\'s plain-HTTP forward path — a CONNECT tunnel is opaque, so a placeholder inside an HTTPS request reaches the server literally (it fails safe rather than leaking); and a backend with no egress boundary (kubernetes, self-hosted) cannot substitute, so it keeps the plaintext materialization it always had.',
    contract: 'contracts/anthropic-cma/credentials.md',
  },
  {
    area: 'credentials',
    id: 'oauth-refresh',
    status: 'supported',
    reason: 'An mcp_oauth credential\'s auth.expires_at and auth.refresh block (token_endpoint, client_id, token_endpoint_auth) persist with the write-only refresh_token and client_secret encrypted in their own columns. At the MCP connect boundary the runtime refreshes an expired access token through the token endpoint before the header is built — the same boundary that resolves the injection, so the transport only ever sees the resulting token and a placeholder model is unaffected. A rotated refresh_token is persisted in place, a failure stamps the row\'s oauth_state, appends a refresh_failed audit event, and publishes vault_credential.refresh_failed, and a 60-second per-credential window deduplicates attempts across sessions. Two honest edges: a credential that never declared expires_at is used until replaced (the runtime cannot know it is due), and the mcp_oauth_validate endpoint still refuses with unsupported_capability — validation is not refresh.',
    contract: 'contracts/anthropic-cma/credentials.md',
  },
  {
    area: 'operations',
    id: 'webhook-subscriptions',
    status: 'partial',
    reason: 'Locally implemented, but the delivery behaviour is not the published contract. Subscriptions are managed over REST under /v1/webhooks (with the /v1/x mirror) and delivery runs from a bridge the runtime composes at startup: each durable event is projected as it is broadcast and a 60-second tick retries due deliveries and runs due deployments, while POST /v1/webhooks/dispatch and POST /v1/webhooks/retry-due remain for on-demand passes. Every attempt carries the published header names and a Standard Webhooks v1 signature over id.timestamp.body — a retry keeps the event id and signs with its own timestamp, and each subscription holds its own whsec_ secret that is returned once at creation, and a rotation window keeps the previous secret valid in a second webhook-signature entry until it is retired — manually by retire-secret, or automatically once the window has been open for the duration the deployment set (24 hours by default, settable with MANAGED_AGENTS_WEBHOOK_ROTATION_WINDOW_SECONDS and recorded at startup as webhook_rotation_window; expiry drops the previous columns, enforced where a signature is produced and swept on the retry tick, while a window opened before the since timestamp existed keeps manual-retire behaviour) — the payload is the published {type: "event", id, created_at, data: {type, id, organization_id, workspace_id}} reference envelope with webhook-id equal to the event id and local constant org/workspace values, subscriptions may only name events from the official catalog — *, prefix.*, and unknown names are refused at write time — and the session stream reaches subscribers only through the published-name projection (status events mapped, budget_reached deduplicated per session and ceiling, internal events dropped) while resource routes publish the lifecycle events for sessions, agents, environments, vaults and credentials, memory stores, and deployments; every catalog name has a producer (the coarse session lifecycle names ride the same transitions: pending at creation, running/idled/requires_action through the stream projection), the published names with no producing surface (session.thread_*, agent.deleted) are refused at subscription like any unknown name, of the three published auto-disable cases all three exist, two unconditionally and one opt-in (an attempt that observes a redirect disables the endpoint with the published disabled_reason and is never retried; an attempt whose host is an internal name or resolves to a private address is refused before any connection with its own published reason but only when the deployment sets MANAGED_AGENTS_WEBHOOK_SCREEN_PRIVATE_ADDRESSES, off by default because loopback is private and a self-hosted receiver normally shares the host; and an endpoint failing without interruption for at least a window is disabled with the published sustained-failure reason, where the contract publishes the trigger shape — duration, not attempt count, with a 2xx resetting it — but no length, so the window is a local parameter: it defaults to 10 minutes, a deployment sets its own with MANAGED_AGENTS_WEBHOOK_SUSTAINED_FAILURE_WINDOW_SECONDS, and the runtime records the window in force at startup because a deployment variable has no write path of its own). Retries follow the published jittered 5-120s exponential backoff: the ceiling doubles from 60s to 120s and each delay is drawn uniformly between 5s and that ceiling.',
    contract: 'contracts/anthropic-cma/operations.md',
  },
  {
    area: 'operations',
    id: 'scheduled-deployment-timers',
    status: 'partial',
    reason: 'The published deployment surface end to end: the object answers with type deployment, a depl_ id, a pinned {type, id, version} agent, environment_id, a required non-empty initial_events list (the session admission plus the deployment-only system.message), resources, vault_ids, budget, metadata, and a schedule object with last_run_at and the next three upcoming_runs_at — null for a manual-only deployment, because cron is nullable since M052. Both mount spellings serve create/read/update (POST the published verb, PUT the local one)/archive/pause/unpause/run/run-due from one router, and the local flat aliases (agent_id, cron, timezone, payload) remain accepted. Each run creates its session through createWithInitialEvents and records a drun_ run readable at /v1/deployment_runs (deployment_id, has_error, trigger_type, created_at filters) with trigger_context carrying scheduled_at for a timed run. Failure is asymmetric per the published contract: a missing or archived bound agent archives the deployment with no run, a recoverable session_rate_limited_error records a failed run only, and other classified failures record the run and auto-pause the deployment with paused_reason.error mirroring the run\'s classified error.type. Manual pause and unpause exist and a paused deployment still accepts a manual run; timed runs publish deployment_run.started/.succeeded/.failed and manual runs publish none, while deployment.created/.updated/.paused/.unpaused/.archived publish on their transitions including the agent-gone cascade, and DELETE removes the deployment and its run records in one transaction then publishes deployment.deleted. The runtime\'s 60-second tick runs due deployments and startup re-arms their forward schedule without replaying a missed trigger. Remaining gap: mcp_egress_blocked_error has no producing path because MCP egress is not gated.',
    contract: 'contracts/anthropic-cma/operations.md',
  },
  {
    area: 'operations',
    id: 'outcome-grading',
    status: 'supported',
    reason: 'A declared outcome projects into the turn it queues, is graded once that turn completes by a model pass in its own context window over what the agent produced, and drives its own revisions: a `needs_revision` verdict appends the explanation as a real `user.message` and runs another turn inside the same outcome, bounded by the declared `max_iterations`, whose last allowed evaluation reports `max_iterations_reached` and still leaves the agent one final turn to settle its answer. Every iteration is published on the session log as a `span.outcome_evaluation_start` / `_ongoing` / `_end` triple, admission assigns each declaration its `outc_` id and persists it so the published event and every span join on it, the session object\'s `outcome_evaluations` reports each declaration\'s current state — `pending`, `running`, `evaluating`, then the terminal end-span verdict — an interrupt closes the outcome as `interrupted` without recording a `session.error`, and a runtime that composes no grader refuses the declaration at admission with `outcome_grader_unavailable` on both ingress paths. Three rules are local: grading runs through a model provider, so a runtime with no provider closes the evaluation as `failed` with `outcome_evaluator_unavailable`; a revision turn that stops for a tool confirmation ends the outcome as `interrupted` because the loop cannot drive another turn while the session waits for a human; and a session that spends its declared ceiling closes the outcome as `budget_reached`, because the loop\'s turns are not events and no admission gate would see their model requests.',
    contract: 'contracts/anthropic-cma/sessions.md',
  },
  {
    area: 'operations',
    id: 'outcome-evaluation',
    status: 'supported',
    reason: 'Declared outcomes evaluate deterministically against the event log rather than by model judgement, so a pass/fail is reproducible. A local extension: the published contract defines no deterministic evaluator.',
    contract: 'contracts/anthropic-cma/operations.md',
  },
  {
    area: 'capabilities',
    id: 'capability-inventory-endpoint',
    status: 'supported',
    reason: '/v1/x/capabilities returns the runtime capability inventory for Console and client consumption.',
    contract: 'contracts/anthropic-cma/capabilities.md',
  },
  {
    area: 'capabilities',
    id: 'capability-status-truthfulness',
    status: 'supported',
    reason: 'The six-value status enum distinguishes unimplemented from deliberately out-of-scope and from unverified, and a guard test enforces the claim: every entry\'s contract document must restate that entry\'s status, cite no source or test file that does not exist, and list the mounted route surface with its methods.',
    contract: 'contracts/anthropic-cma/capabilities.md',
  },
  {
    area: 'environments',
    id: 'environment-hosting-config',
    status: 'supported',
    reason: 'The hosting axis has two published-and-local spellings, config.type and config.hosting_type, and both are read as one declaration by readDeclaredHostingType: either resolves through one vocabulary, a declaration that is not a string is refused instead of read as absent, and two spellings that disagree are refused with invalid_environment_config rather than resolved by precedence. cloud — the published "the platform decides" value — is accepted: it is stored as declared, and sessions on it provision on the workspace\'s configured default backend through the effective Settings V2 sandbox section, with the resolved provider reported as effective_sandbox_provider so the declaration and the execution never blur. An unrecognized hosting type is still refused at write time with unsupported_hosting_type naming the types this build can serve.',
    contract: 'contracts/anthropic-cma/environments.md',
  },
  {
    area: 'environments',
    id: 'environment-network-policy',
    status: 'partial',
    reason: 'The published config.networking object is accepted in its own vocabulary (limited/unrestricted, allowed_hosts, allow_mcp_servers, allow_package_managers) and normalized into the recorded local config.network spelling by one normalizer, with fail-closed defaults for an unrecognized type and for an unset permission, and a request declaring both spellings inconsistently refused. A limited policy is now applied: every limited sandbox gets a per-session loopback egress proxy that speaks CONNECT and absolute-URI HTTP and admits only the effective allowlist (allowed_hosts plus, when the package-manager flag is set, the curated public registry endpoints). The docker provider attaches the session container to an --internal network whose only permitted peer is a relay sidecar forwarding to the proxy, so the boundary is enforced rather than advisory; the local provider injects the proxy variables into every sandbox subprocess and stdio MCP server, which is advisory by construction — a process that ignores proxy variables egresses freely — and reports best_effort rather than claiming enforcement. The MCP connect boundary refuses a url server whose host the policy does not cover (unless allow_mcp_servers is set), web_fetch intersects the declared allowlist with its existing domain and SSRF guards at every redirect hop, and the Environment read projects networking_enforcement (enforced / best_effort / unsupported / not_applicable) from the effective backend\'s declared capability. It remains partial because the kubernetes and self-hosted providers install no egress boundary — a limited policy on them is reported as unsupported rather than applied — and because the local provider\'s enforcement is advisory by nature.',
    contract: 'contracts/anthropic-cma/environments.md',
  },
  {
    area: 'environments',
    id: 'environment-work',
    status: 'partial',
    reason: 'The entire published Work API is mounted over the local tool-execution queue. The data plane: poll claims the oldest claimable item scoped to the calling credential\'s environment and returns it in the published BetaSelfHostedWork shape with a per-claim secret (base64url JSON carrying a sessions_token minted for that claim, plus api_base_url); ack commits the claim, heartbeat renews the heartbeat lease with the published NO_HEARTBEAT first-claim sentinel and expected_last_heartbeat optimistic-concurrency check (412 carrying the server\'s current_state), update merges a metadata patch, and stop records the queue\'s stop marker. The management plane: list pages items newest-first under a keyset page cursor, retrieve answers one item through the same item-scope fence as the item verbs, and stats reports the published work_queue_stats fields computed from the lease model (depth = claimable now, pending = claimed inside its lease, workers_polling = identities seen on poll in 30s). The projection is honest about its edges: data is always {type: "session", id} because every local item belongs to a session, per-item desired_ttl_seconds is reported back rather than applied, force-stop has no distinct local mode, and result reporting stays on the local /v1/x/worker channel. Remains partial for those semantic deltas — not for missing routes; nothing in the family is a refusal.',
    contract: 'contracts/anthropic-cma/work.md',
  },
  {
    area: 'routes',
    id: 'documented-route-surface',
    status: 'supported',
    reason: 'Every mounted /v1 route is listed with its method and path in contracts/anthropic-cma/routes.md, and every listed route is mounted; the guard compares method and path together, so a documented route answering a different verb fails as loudly as a route that is missing.',
    contract: 'contracts/anthropic-cma/routes.md',
  },
  {
    area: 'dreams',
    id: 'dreams',
    status: 'supported',
    reason: 'Dreams are session-backed memory-consolidation jobs: POST /v1/dreams starts an internal pipeline session that reads one memory store (mounted read-only) and the selected session transcripts, then writes consolidated records into a new store seeded as a copy of the input — or into the input store itself under update_existing. Lifecycle is pending → running → completed/failed/canceled; cancel interrupts the pipeline session and archive is terminal-only. dream.session_id exposes the pipeline session for event streaming and audit, usage mirrors its token counters, and a failed or canceled dream keeps the partial output store. No dreaming-* beta gate: local extensions are directly usable. Console UI is not implemented.',
    contract: 'contracts/anthropic-cma/dreams.md',
  },
  {
    area: 'threads',
    id: 'threads-and-coordinator',
    status: 'unavailable',
    reason: 'Not implemented: there is no thread resource, no thread lifecycle or per-thread event isolation, no coordinator or advisor role, and no thread-scoped budget event. The five published thread routes are mounted `unsupported_capability` refusals naming this capability, so an SDK caller decodes a 400 rather than hitting a 404. A request carrying a `multiagent` roster is refused by name rather than silently stripped. Delegation exists only as the local single-level `delegations` / `enable_general_subagent` extension, which is not this surface.',
    contract: 'contracts/anthropic-cma/threads.md',
  },
  {
    area: 'unsupported',
    id: 'session-budget-alerts',
    status: 'not_applicable',
    reason: 'Budget notification is a hosted billing feature: it needs an outbound channel to a party who pays for the account, and SandBase is single-tenant and local, so the operator is already the only party to notify.',
    contract: 'contracts/anthropic-cma/unsupported.md',
  },
  {
    area: 'unsupported',
    id: 'mcp-tunnel',
    status: 'not_applicable',
    reason: 'MCP tunnel is a hosted connectivity feature outside the local-first scope.',
    contract: 'contracts/anthropic-cma/unsupported.md',
  },
  {
    area: 'tools',
    id: 'web-search-execution',
    status: 'supported',
    reason: 'web_search executes against the search provider configured in Runtime Settings (Tavily is the shipped adapter; brave, exa, and searxng validate but ship no adapter yet). The request leaves the runtime process, not the sandbox: the provider key rides in an Authorization header that never enters URLs, logs, or tool output, the Environment network policy governs the provider endpoint, and the agent\'s allowed_domains/blocked_domains map to the provider\'s include/exclude parameters with any path-suffix entries enforced client-side on the returned URLs. Failures return a coded tool result — web_search_unconfigured, web_search_rate_limited, web_search_provider_failed — rather than failing the session, and each call counts once against usage.server_tool_use.web_search_requests and the web_search cost-profile field. An unconfigured runtime keeps the earlier behavior: an explicit web_search declaration fails admission before a session is persisted.',
    contract: 'contracts/anthropic-cma/tools.md',
  },
];

/**
 * Look up one entry.
 *
 * Throws on an unknown id so a typo cannot silently find nothing, and returns a
 * copy so a consumer cannot mutate the shared matrix by holding an entry.
 */
export function capabilityEntry(id: string): CapabilityEntry {
  const entry = CMA_CAPABILITY_MATRIX.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown capability: ${id}`);
  return { ...entry };
}

/** Entries with a given status. Returns copies, for the same reason. */
export function capabilitiesWithStatus(status: CapabilityStatus): CapabilityEntry[] {
  return CMA_CAPABILITY_MATRIX.filter((entry) => entry.status === status).map((entry) => ({ ...entry }));
}

/** Grouped counts, useful for a coverage summary in the Console or a report. */
export function capabilitySummary(): Record<CapabilityStatus, number> {
  const summary = Object.fromEntries(CAPABILITY_STATUSES.map((status) => [status, 0])) as Record<CapabilityStatus, number>;
  for (const entry of CMA_CAPABILITY_MATRIX) summary[entry.status] += 1;
  return summary;
}

/**
 * Machine-readable projection.
 *
 * This is what `/v1/x/capabilities` serves and what a Console renders, so the
 * registry and any published JSON cannot drift apart.
 */
export function capabilityMatrixJson(): {
  type: 'capability_matrix';
  statuses: readonly CapabilityStatus[];
  summary: Record<CapabilityStatus, number>;
  capabilities: CapabilityEntry[];
} {
  return {
    type: 'capability_matrix',
    statuses: CAPABILITY_STATUSES,
    summary: capabilitySummary(),
    capabilities: CMA_CAPABILITY_MATRIX.map((entry) => ({ ...entry })),
  };
}
