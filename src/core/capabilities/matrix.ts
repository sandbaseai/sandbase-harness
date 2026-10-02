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
    reason: 'A collection\'s envelope follows the mount: the operations router serves `/v1` with `{data, prev_page, next_page}` and its `/v1/x` mirror with the local `{data, has_more, first_id, last_id}`, chosen through one pager so no handler emits both spellings, and cursors that are readable base64url JSON rather than opaque binary. Every canonical `/v1` collection serves the canonical envelope, with no exceptions: the complete-set listings carry `{data, prev_page: null, next_page: null}` and the windowed ones carry a followable cursor — `/v1/sessions` pages by number under `{order, filter, page}` and rejects a cursor replayed under another filter, `/v1/sessions/{id}/events` carries `{order, filter, after_id}`, `/v1/skills` and the credential audit listings use `{offset, filter}` — so a cut page says so instead of looking complete. The one listing that is neither shape is `/v1/environments/{id}/work-items`, a windowed extension that adds a `counts` object and is named in the contract.',
    contract: 'contracts/anthropic-cma/pagination.md',
  },
  {
    area: 'pagination',
    id: 'cursor-query-binding',
    status: 'supported',
    reason: 'A cursor records the ordering and the normalized filter that produced it, and a replay under a different query is rejected with invalid_page_cursor instead of returning a page that never existed for that query.',
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
    reason: 'String and object model forms parse field by field. `effort` is accepted, stored, and returned by the read projection (the agent read, the version read, and the session snapshot), but it does not change the provider request — recorded as accepted-but-no-effect rather than as executed, because the provider model is resolved from the id, so the level has no path into a request (a deployment\'s own `reasoning_effort` model setting is operator-level and separate); `inference_geo` is refused by name with `unsupported_model_field` because this runtime has no inference-geography control; and a canonical `multiagent` roster is refused by name rather than executed.',
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
    reason: 'Sessions are created, resumed, interrupted, and terminated with the canonical status transitions, and a `session.status_idle` event exposes the session-level `stop_reason` object at the top level, which is where the published client reads `stop_reason.type` to decide between answering a blocking call and stopping. The object is exactly the published `{type, event_ids}`, and both parked-work families are covered: `event_ids` names approval-gated `agent.tool_use` / `agent.mcp_tool_use` calls and unanswered `agent.custom_tool_use` calls by their own event id, and a `user.tool_confirmation` or `user.custom_tool_result` may address a call by that id or by the local `tool_use` block id. The resume turn starts only once nothing is parked, so the published answer-one-id-per-entry loop works as written: each answer is recorded as it arrives and the session stays in `requires_action` until the last one. The wait itself is unbounded by default, matching the published "waits indefinitely"; an operator may set `loop_engine.options.requires_action_timeout_seconds` to bound it, and an expired wait ends with a coded `session.error` and the terminal `timed_out` status rather than answering the calls on the caller\'s behalf. That bound is a local extension, and it deliberately never fires on a session at its spending ceiling, which is still `requires_action` here and still waiting for a settlement event the budget accepts.',
    contract: 'contracts/anthropic-cma/sessions.md',
  },
  {
    area: 'sessions',
    id: 'initial-events',
    status: 'supported',
    reason: 'initial_events are validated against the documented whitelist and the 50-event ceiling, and creation plus resource attachment plus event delivery is wrapped in one local transaction so a rejected event cannot leave a half-created session.',
    contract: 'contracts/anthropic-cma/sessions.md',
  },
  {
    area: 'budget',
    id: 'session-budget',
    status: 'partial',
    reason: 'Consumption is priced in integer microcents from the append-only log, and a session may declare a max_list_cost ceiling at creation. At the ceiling the next work-starting event is refused with budget_reached while events that settle work already in flight are still accepted, so the next model request does not start; a declared outcome\'s revision loop reads the same spend and stops at the ceiling too, closing the outcome with result budget_reached rather than starting another grading pass or turn, because the loop\'s turns are internal to an event that was already admitted. Two deviations are deliberate: prices come from an operator-supplied cost profile rather than official list prices, so a session whose model the profile cannot price is refused a budget and usage.list_cost is withheld while any used model is unpriced; and reaching the ceiling refuses the event instead of transitioning the session to a paused state, because the published thread-level budget_reached signal belongs to the thread surface, which this runtime does not implement.',
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
    reason: 'Every failure path through a turn appends session.error carrying {error:{type,message,retry_status}}, with the retry disposition derived from the error code rather than guessed.',
    contract: 'contracts/anthropic-cma/events.md',
  },
  {
    area: 'events',
    id: 'error-enum-completeness',
    status: 'unverified',
    reason: 'The published error enumeration is not exhaustively documented; local codes are not claimed to match upstream values.',
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
    status: 'partial',
    reason: 'File, shell, search, and web_fetch tools execute; web_search accepts configuration but has no search provider and fails admission before execution.',
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
    reason: 'Memory stores and memories support create, read, update, delete, and list with path and depth scoping.',
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
    reason: 'Each write records a memory version that can be listed and read afterwards.',
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
    status: 'partial',
    reason: 'A turn on a session that attaches a vault injects its unrestricted environment variables as plaintext into the sandbox command environment and into any stdio MCP server the agent declares (a vault value wins over the value the agent configured), hands a url-transport server the credentials scoped to its own `mcp_server_url` (a `static_bearer` or `mcp_oauth` credential is attached only to the endpoint it names, on the SSE request and on every message POST), redacts every value a sandbox tool hands back and every value an MCP tool returns, and clears the retained values when the turn ends. The runtime composition supplies the resolver, so a CLI-started runtime resolves the session vault while an embedder that omits it runs sessions with no vault. Three deviations: the secret itself enters the child process environment, with no opaque placeholder and no substitution at the network egress, so any command the agent runs can read it and send it out — the published model keeps the credential out of the process and replaces a placeholder on the outbound request; the delegated child path builds its own sandbox tools and does not thread credentials, so a sub-agent receives no vault environment; and nothing is injected into model requests, so a credential authenticates an outbound call rather than a completion.',
    contract: 'contracts/anthropic-cma/credentials.md',
  },
  {
    area: 'credentials',
    id: 'oauth-refresh',
    status: 'unavailable',
    reason: 'No refresh loop or refresh-failure event exists, and none is scheduled. The official MCP OAuth validation endpoint explicitly refuses the capability with unsupported_capability. A supplied refresh block is parsed, stored, and answered with an explicit warning that it will not be executed, so a caller never assumes a token was renewed.',
    contract: 'contracts/anthropic-cma/credentials.md',
  },
  {
    area: 'operations',
    id: 'webhook-subscriptions',
    status: 'partial',
    reason: 'Locally implemented, but the delivery behaviour is not the published contract. Subscriptions are managed over REST under /v1/webhooks (with the /v1/x mirror) and delivery runs from a bridge the runtime composes at startup: each durable event is projected as it is broadcast and a 60-second tick retries due deliveries and runs due deployments, while POST /v1/webhooks/dispatch and POST /v1/webhooks/retry-due remain for on-demand passes. Every attempt carries the published header names and a Standard Webhooks v1 signature over id.timestamp.body — a retry keeps the delivery id and signs with its own timestamp, and each subscription holds its own whsec_ secret that is returned once at creation, and a rotation window keeps the previous secret valid in a second webhook-signature entry until it is retired — but the payload is the local {type: "webhook_event", event, webhook_id, data, created_at} envelope rather than the published reference envelope, nothing retires the previous secret automatically, of the three published auto-disable cases all three exist, two unconditionally and one opt-in (an attempt that observes a redirect disables the endpoint with the published disabled_reason and is never retried; an attempt whose host is an internal name or resolves to a private address is refused before any connection with its own published reason but only when the deployment sets MANAGED_AGENTS_WEBHOOK_SCREEN_PRIVATE_ADDRESSES, off by default because loopback is private and a self-hosted receiver normally shares the host; and an endpoint failing without interruption for at least a window is disabled with the published sustained-failure reason, where the contract publishes the trigger shape — duration, not attempt count, with a 2xx resetting it — but no length, so the window is a local parameter: it defaults to 10 minutes, a deployment sets its own with MANAGED_AGENTS_WEBHOOK_SUSTAINED_FAILURE_WINDOW_SECONDS, and the runtime records the window in force at startup because a deployment variable has no write path of its own). Retries follow the published jittered 5-120s exponential backoff: the ceiling doubles from 60s to 120s and each delay is drawn uniformly between 5s and that ceiling.',
    contract: 'contracts/anthropic-cma/operations.md',
  },
  {
    area: 'operations',
    id: 'scheduled-deployment-timers',
    status: 'partial',
    reason: 'A stored resource with a cron cadence evaluated in the deployment\'s own IANA timezone, a run record per attempt, and session creation through the canonical SessionManager path, served at the published /v1/deployments and the local /v1/scheduled-deployments from one router. Manual pause and unpause exist (a paused deployment still accepts a manual run), runs are readable at /v1/deployment_runs with a trigger_context projected from the stored trigger type, the lifecycle events deployment.created/.updated/.paused/.unpaused/.archived are published, and deployment_run.started/.succeeded/.failed are published for timed runs only. The runtime\'s 60-second tick runs due deployments and startup re-arms their forward schedule without replaying a missed trigger. It is not the published deployment contract: there is no failure split — every session-creation error records a failed run with the single local error type deployment_run_failed and advances the cadence, with no own-agent preflight, auto-pause or auto-archive, so paused_reason only ever reads manual — trigger_context carries no scheduled_at, and deployment.deleted has no producer because no delete route exists.',
    contract: 'contracts/anthropic-cma/operations.md',
  },
  {
    area: 'operations',
    id: 'outcome-grading',
    status: 'supported',
    reason: 'A declared outcome projects into the turn it queues, is graded once that turn completes by a model pass in its own context window over what the agent produced, and drives its own revisions: a `needs_revision` verdict appends the explanation as a real `user.message` and runs another turn inside the same outcome, bounded by the declared `max_iterations`, whose last allowed evaluation reports `max_iterations_reached` and still leaves the agent one final turn to settle its answer. Every iteration is published on the session log as a `span.outcome_evaluation_start` / `_ongoing` / `_end` triple, an interrupt closes the outcome as `interrupted` without recording a `session.error`, and a runtime that composes no grader refuses the declaration at admission with `outcome_grader_unavailable` on both ingress paths. Three rules are local: grading runs through a model provider, so a runtime with no provider closes the evaluation as `failed` with `outcome_evaluator_unavailable`; a revision turn that stops for a tool confirmation ends the outcome as `interrupted` because the loop cannot drive another turn while the session waits for a human; and a session that spends its declared ceiling closes the outcome as `budget_reached`, because the loop\'s turns are not events and no admission gate would see their model requests.',
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
    reason: 'The hosting axis has two published-and-local spellings, config.type and config.hosting_type, and both are read as one declaration by readDeclaredHostingType: either resolves through one vocabulary, a declaration that is not a string is refused instead of read as absent, and two spellings that disagree are refused with invalid_environment_config rather than resolved by precedence. cloud is refused at write time with unsupported_hosting_type naming the hosting types this build can execute, so an environment this runtime cannot run is never accepted and then failed at session start. The response projects hosting_type from the declaration in either spelling, so a caller of the published shape reads back the hosting it asked for rather than the local default.',
    contract: 'contracts/anthropic-cma/environments.md',
  },
  {
    area: 'environments',
    id: 'environment-network-policy',
    status: 'partial',
    reason: 'The published config.networking object is accepted in its own vocabulary (limited/unrestricted, allowed_hosts, allow_mcp_servers, allow_package_managers) and normalized into the recorded local config.network spelling by one normalizer, with fail-closed defaults for an unrecognized type and for an unset permission, and a request declaring both spellings inconsistently refused. It is partial because nothing enforces it: no sandbox provider shipped in this runtime reads an environment network policy, so a declared limited policy with an empty allowed_hosts grants the same egress as unrestricted, which the contract file, docs/api.md, and the Console API reference state plainly. The status becomes supported when a provider applies the policy it is given.',
    contract: 'contracts/anthropic-cma/environments.md',
  },
  {
    area: 'routes',
    id: 'documented-route-surface',
    status: 'supported',
    reason: 'Every mounted /v1 route is listed with its method and path in contracts/anthropic-cma/routes.md, and every listed route is mounted; the guard compares method and path together, so a documented route answering a different verb fails as loudly as a route that is missing.',
    contract: 'contracts/anthropic-cma/routes.md',
  },
  {
    area: 'unsupported',
    id: 'dreams',
    status: 'unavailable',
    reason: 'Dreams are a memory-consolidation pipeline: they read memory stores and historical sessions and produce new, reorganized stores. This phase deliberately does not implement it; official SDK routes explicitly refuse it with unsupported_capability. Unavailable rather than not_applicable because the feature belongs in a local-first runtime — what it needs is a scheduled background worker and archived-session corpora, not a hosted service.',
    contract: 'contracts/anthropic-cma/unsupported.md',
  },
  {
    area: 'threads',
    id: 'threads-and-coordinator',
    status: 'unavailable',
    reason: 'Not implemented: there is no thread resource, no thread lifecycle or per-thread event isolation, no coordinator or advisor role, no /threads route, and no thread-scoped budget event. A request carrying a `multiagent` roster is refused by name rather than silently stripped. Delegation exists only as the local single-level `delegations` / `enable_general_subagent` extension, which is not this surface.',
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
    area: 'unsupported',
    id: 'web-search-execution',
    status: 'unavailable',
    reason: 'No search provider is bundled or configured, and search-engine HTML scraping is not an accepted substitute; enabling web_search fails admission before a session is persisted. WebFetch execution is a separate, implemented capability.',
    contract: 'contracts/anthropic-cma/unsupported.md',
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
