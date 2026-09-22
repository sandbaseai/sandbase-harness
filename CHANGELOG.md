# Changelog

## Unreleased

### Added

- Adds path-addressed session memory mounts. A session can mount up to eight stores at whole-segment paths; file tools persist mounted content through `memory_records`, read-only mounts reject writes, shell access is refused while mounts are attached, and existing-file updates require a content precondition.

- Records an immutable version row per memory write. A memory is overwritten in place, so previously nothing could say what a path held before, attribute a change to the session that made it, or notice that two writers raced on the same path. Every create, update, and delete now records the store, the memory, a per-memory monotonic version number, the path, the content, its SHA-256, its size in bytes, the change kind, and the session that made it, and a unique index refuses a second writer claiming a version that already exists rather than letting it overwrite the first. `GET /v1/memory_stores/{id}/memory_versions` lists a store's recorded versions newest first, optionally scoped to one memory, and `GET /v1/memory_stores/{id}/memory_versions/{versionId}` reads one by its own id.
- Attaches a resource to a session as a per-session instance with its own `sesrsc_` id, so it can be listed, read, updated, and detached without rewriting the session payload. Attachment is additive and reversible: detaching a resource from one session leaves it attached to every other session that holds it, and a session can hold more than one resource of the same type at its own position. The session row, its initial events, and its resource instances are written in one transaction, so a failure part-way through leaves neither a session that claims a resource it does not hold nor an orphaned resource row. A `memory_store` resource can only be attached at session creation, because memories are part of the context the session was built with. A github_repository `authorization_token` stays write-only and is never echoed in any response; rotating it is the only updatable field, and changing the repository, checkout, or mount path requires a new instance.
- Governs an MCP tool by its toolset's permission policy instead of letting it fall through to `always_allow`. The toolset kind supplies the default when nothing is configured — `always_ask` for an `mcp_toolset`, `always_allow` for the built-in toolset — and an explicit per-tool or toolset-wide policy overrides it in both directions. A tool the server exposed but the agent never named is governed by the same default rather than by nothing: it is admitted, it keeps no `execute` until the caller approves it, and it is listed for the strategy so the confirmation list and the resolved tool map cannot disagree. A tool the operator marked `never_allow` is not admitted at all rather than shipped and gated, because shipping it invites the model to call something the operator forbade. The runtime naming rule now lives in one dependency-free module so the permission layer reuses it instead of carrying a second copy that used a prefix the runtime never produces.
- Closes the custom tool loop. A custom tool is exposed to the model with its description and input schema and no local `execute`, a call to it is persisted as an `agent.custom_tool_use` event that parks the session in `requires_action`, and the caller answers with `user.custom_tool_result` naming the `custom_tool_use_id` — after which the turn resumes with that result as the model-facing tool result. The runtime never executes a custom tool and never fabricates a result for one. A result naming a call that is not pending, and a second result for a call that already has one, are each refused before they are appended, so a caller cannot inject an answer into a session or answer a call twice.
- Accepts a custom tool either as a canonical `custom` entry in `tools[]` or in the legacy `custom_toolset` grouping, and projects one canonical shape on every agent response. The canonical entry carries `name`, `description`, and `input_schema`, with `parameters` still accepted as a legacy alias. A tool the legacy grouping disables is dropped rather than translated into a policy, and a canonical entry carrying a `permission_policy` is refused because the caller executes the tool and decides whether to run it, so a policy field would claim governance the runtime does not hold. A name that collides with a built-in tool, a name declared twice across both shapes, and a malformed input schema are each refused with a message naming the offending entry. `getCustomToolNames`, `getCustomToolConfigs`, `canonicalToConfig`, and `findCustomToolConfig` report the same tool set for both wire shapes.
- Publishes stable admission error codes on rejected compatibility requests.
  `error.code` now names the cause (`missing_anthropic_version`,
  `unsupported_anthropic_version`, `missing_anthropic_beta`,
  `malformed_anthropic_beta`, `unsupported_anthropic_beta`,
  `conflicting_memory_store_beta`) so a client can branch on the reason
  instead of matching the message text. The `/v1/x` extension root and its
  subtree remain outside CMA admission.
- Cross-checks an agent definition's `mcp_servers` against the `mcp_toolset`
  entries that bind it. A toolset naming an undeclared server, a declared server
  no toolset references, and a duplicate server name are each refused with a
  message naming the offending entry. Previously all three saved successfully and
  then silently did nothing at execution time. Two toolsets may still bind the same
  declared server.
- Evaluates a scheduled deployment's cron expression in the deployment's own
  timezone instead of UTC. The same wall time resolves to a different instant in
  a different zone, and the difference moves across the year for a zone that
  observes DST. A wall time inside a spring-forward gap yields no run rather than
  a silently shifted one, a fall-back overlap resolves to one deterministic
  instant, and an unknown IANA zone name is refused rather than defaulted to UTC.
  `nextCronRun` now takes an optional zone, defaulting to UTC so an existing
  caller is unchanged.
- Signs webhook deliveries with the Standard Webhooks v1 headers. A delivery now
  carries `webhook-id`, `webhook-timestamp`, and `webhook-signature`, with the
  signature covering `id.timestamp.body` so a receiver can detect a replayed or
  altered delivery rather than only a forged one. Verification is constant-time
  and accepts several space-separated signatures in one header, which is the
  rotation window. A `whsec_`-prefixed secret is base64-decoded to key bytes and
  an unprefixed secret is used as raw UTF-8, and the legacy
  `X-Managed-Agents-Signature` header is still sent.
- Adds `POST`, `GET`, and revoke routes for a self-hosted environment's worker
  keys. Only the SHA-256 hash is stored, so `secret_key` is returned exactly once
  and list and revoke responses carry `key_prefix` instead. A claim on
  `POST /v1/x/worker/claim` may present the key as `environment_key`, which scopes
  the worker to the issuing environment; a claim naming a different environment,
  or presenting a revoked, expired, or unknown key, is refused before any work item
  changes hands. The issuing side and the consuming side now share one definition
  of the hash scheme and the status rules.
- Enforces the published memory rules on the routes that own them: content is
  capped at 100 kB measured in bytes rather than characters, a store holds at most
  10,000 memories, a store's session-level `instructions` field is capped at 4,096
  characters, and `GET /v1/memory_stores/{id}/memories` accepts `path_prefix` and
  `depth` with segment-based prefix matching. A write may carry a
  `content_sha256` precondition; a stale one is refused with `precondition_failed`
  and the current hash, and an unknown type or a missing hash is refused with
  `invalid_precondition` rather than ignored.
- Executes `web_fetch` behind an SSRF address guard. The guard refuses internal
  host names before DNS, refuses every resolution that is loopback, RFC 1918,
  link-local, or CGNAT (including IPv4-mapped IPv6 forms), and pins the connection
  to the validated address so a second resolution cannot disagree with the first.
  Every redirect hop restarts the checks, the domain lists the agent declared are
  enforced, and an oversized body, a stalled response, and a binary content type
  are each handled without inlining the content. Failures return a tool error
  rather than a fake success. `web_search` stays unavailable because no search
  provider is bundled.
- Publishes the files an agent writes under `/mnt/session/outputs/` as
  session-scoped file records after each turn, so the deliverables become
  retrievable through the Files API. The output directory is walked rather than
  reported through a side channel, recording is idempotent per (session, sandbox
  path) so a deliverable keeps one file id across passes, the number of new files
  per pass is capped, and a collection failure is swallowed because the turn has
  already completed.
- Sends the canonical Anthropic compatibility header pair from the first-party
  SDK on every `/v1/...` request: `anthropic-version: 2023-06-01` plus
  `managed-agents-2026-04-01`, or `agent-memory-2026-07-22` for a memory-store
  path. `/v1/x/...` receives no compatibility header, and a caller-supplied beta
  overrides the derived one. The three literals now have one definition shared by
  the admission middleware and the SDK, so the two cannot drift apart.
- Accepts `system.message` as an inbound session event alongside the `user.*`
  family. The payload uses the same content-block vocabulary as `user.message` and
  must be a non-empty array of at most 1000 valid blocks; an over-long batch is
  reported as a size violation naming the ceiling rather than as a generic shape
  error. The event projects as its own `system` role turn, so it applies to the
  accompanying turn and every later turn rather than folding into the agent's
  top-level prompt. A message that arrives while an assistant turn is pending
  flushes that turn first, and one with no usable text is dropped instead of
  projected as an empty turn.
- Spills an oversized tool result into the sandbox and gives the model a short
  preview plus the path it can read the full content back from, through one
  contract shared by the built-in tool path, the MCP tool path, and the Pi stdout
  translator. The spill path is recorded on the `agent.tool_result` event only
  when a file was actually written, and a failed spill degrades to a path-less
  preview instead of failing the turn. The local ceiling stays at 50,000
  characters rather than the published 100,000, because a local runtime persists
  every event into SQLite.
- Lets a session event stream opt into token-level previews with a repeated
  `event_deltas[]` query parameter for `agent.message` and `agent.thinking`. An
  unsupported value, an empty value, or more than 100 values is rejected with
  `invalid_request` before the stream opens. Preview frames carry `event_start`
  and `event_delta`, never carry an `id` or `processed_at`, and are never
  persisted, so they cannot advance the resume cursor. `agent.thinking` gets an
  `event_start` only, because the buffered event carries no reasoning text and a
  delta would have to invent content.

- Adds `POST /v1/runs`, which starts one turn and returns its result without
  driving the session lifecycle. `response_mode` selects `wait` (200 with
  the output and usage), `sse` (event stream), or `async` (202 with a
  query handle); `max_wait_seconds` bounds only the wait and answers 202 with
  `wait_deadline_reached` when it elapses, leaving the turn running. A refusal
  before a turn starts answers with its own status, and a failure raised while
  waiting or streaming is recorded once as `session.error` so it replays from
  the session's event log. Session budgets are not part of this endpoint.

- Lets `POST /v1/sessions` start a session in one call with an optional
  `initial_events` array of `user.message` events. A non-empty list yields a
  `running` session whose event log already holds every supplied event, in
  order; an absent field and an empty array still create an idle session. The
  batch is validated and written inside the creation transaction, so a rejected
  batch leaves no session row and no partial history behind.
- Attributes `agent.mcp_tool_use` and `agent.mcp_tool_result` events to the MCP
  server that produced them. Both events carry `mcp_server_name`, results also
  carry `mcp_tool_use_id`, and the identity is projected onto the public API
  event, so two servers exposing the same tool name stay distinguishable in the
  durable log.
- Writes a `session.usage` snapshot event immediately before every
  `session.status_idle`. The snapshot reports the session's aggregate
  input/output token counters plus `active_seconds`, the wall-clock time the
  harness loop spent executing the session, derived from the append-only event
  log so it survives restarts without a migration. Cost, budget, and
  server-tool counters are omitted rather than reported as zero.

- Makes new-session `loop_engine` admission fail closed. The optional request
  override resolves against one Settings descriptor source, freezes the selected
  executable engine on the session, returns stable `loop_engine_invalid` and
  `loop_engine_not_supported` errors before persistence, and documents that Pi
  native tools are outside Harness approval and sandbox path policy.

- Exposes `GET /v1/x/capabilities` as the canonical inventory for locally
  executable built-in tools. Agent create/update and session creation now
  reject enabled `web_fetch` and `web_search` requests with a structured
  `unsupported_capability` error before persistence or model/tool execution.

### Changed
- Carries a structured `{ type, message, retry_status }` payload in a top-level
  `error` field on every `session.error`. `type` is the stable code the runtime
  attached, or `internal_error` when the failure carries none, and `retry_status`
  is derived from that code rather than guessed: `pi_session_busy` is `retryable`,
  the Pi admission codes, the loop-engine codes, `pi_timed_out`,
  `pi_cleanup_pending`, and `unsupported_capability` are `not_retryable`, and any
  other code is `unknown`. An aborted turn still records no `session.error`.
- Treats a session file resource's `mount_path` as a logical path inside the
  session instead of an internal sandbox path. `/data.csv` is accepted and maps
  under the runtime's own mount root, the full relative path is preserved rather
  than flattened to its basename, an omitted or blank path defaults to the file
  id, and traversal-shaped paths are still rejected. The historical `/uploads/`
  spelling remains accepted as a logical path.
- Accepts the canonical agent `model` object form and carries `effort` through
  to the stored agent instead of dropping it. `speed` keeps its `standard`
  default and also accepts the `extended` local value. An unrecognized key and a
  well-formed `inference_geo` pin are both refused with
  `unsupported_model_field`, the latter because a local runtime has no
  inference-geography control to honour, so accepting the pin would misrepresent
  the agent's data-residency property. A malformed `speed` or `effort` is
  refused with its own code and the accepted value set rather than defaulted.

- Validates `web_fetch` and `web_search` domain lists against the published
  grammar on agent create/update and session creation. One list per entry, a
  non-empty list of at most 64 hostnames, no IP or internal host, no scheme,
  port, credentials, wildcard, or path on a `web_fetch` domain, no duplicates,
  and `max_content_tokens` or `user_location` only on the tool that accepts it.
  A rejected list answers `400 invalid_request_error` naming the list and
  zero-based index. Whether a web tool can execute is unchanged and still
  refused by capability admission.

### Highlights

- Adds the opt-in Pi CLI loop-engine foundation. New Pi sessions persist their
  selected engine, launch one restricted print-mode subprocess per text user
  turn, use a safe session file and private `models.json` with
  `$SANDBASE_PI_API_KEY`, and fail explicitly when the Pi CLI is unavailable.
- Translates validated Pi stdout JSONL into the same SQLite-backed CMA event
  log used by the builtin engine. Final text, native tool trajectory, spans,
  usage, retry/error state, and terminal completion are durable; text deltas
  remain transient and bounded stderr is redacted diagnostics only. Pi native
- Adds Pi session-file lease and SQLite-backed continuity proof. Live owners
  receive retryable busy responses; stale owners are recovered explicitly;
  mismatched/corrupt/refused resumes are visible errors. Pi cancellation,
  timeout, and unknown process-tree cleanup are distinct `cancelled`,
  `timed_out`, and `cleanup_pending` states, and retained workspaces are never
  released on uncertain cleanup.

### Fixes

- Anchors the inbound `/v1` rate-limit window to the request that opened it
  instead of to the wall-clock minute. Every bucket used to be cleared at each
  minute boundary, so two writes 10 ms apart that fell on opposite sides of
  `12:01:00` were both allowed and a one-write budget was spent twice inside 60
  seconds. A window now runs a full minute from its first counted request, so a
  burst straddling a boundary is throttled, and `Retry-After` reports the time
  until the caller's own window expires rather than the time to the next minute.
  Buckets, budgets, exemptions, and the 429 body are unchanged.

- Keeps OpenAI-compatible streaming sessions alive when a gateway fragments a
  tool call across many SSE deltas and emits an empty or missing
  `tool_calls[].type`. The runtime rewrites only that field on the wire, so
  argument fragments and every other byte are preserved and the stream no
  longer aborts with a schema validation failure. Non-SSE and error responses
  are passed through untouched.

- Makes approval-gated tool calls durable and atomic per model step. Every
  confirmation decision, group identifier, and paired tool result is stored in
  the append-only event log; a model continuation begins only after the full
  group is resolved. Sessions expose `requires_action` directly while pending.
- Makes Console session replay sequence-aware. The Console now treats the
  resumable event tail as the single durable source, merges REST snapshots by
  sequence, and never advances a replay cursor for transient text chunks.
- Adds `seq` and immutable `metadata` to public event responses and aligns SSE
  envelopes with REST. Model-attributed event projections include the selected
  model and provider stop reason when available.
- Records the session budget capability as `planned` instead of `partial`. The
  matrix entry claimed enforcement, pause semantics, the settlement-event
  whitelist, a session-wide ceiling and an operator-supplied cost profile, while
  `session-budget.ts`, `cost-profile.ts`, and their tests are absent from the
  tree: nothing priced model consumption and no session accepted a budget. The
  contract documents disagreed with each other as well, `sessions.md` calling the
  budget `not_applicable` and `unsupported.md` calling it `partial`. The entry and
  both documents now state that the design is published and nothing implements it.

### Security

- Redacts credential secrets from values that are logged or returned. A redactor
  bound to one injection bundle replaces every secret it holds wherever it appears,
  including nested objects and arrays, and `clear()` drops the held secrets so the
  redactor cannot be reused after the turn ends. A secret belonging to a different
  bundle is not redacted, and a value containing no secret is returned unchanged.
  The canonical credential shape rejects an unknown field rather than ignoring it.

- Stops persisting raw model reasoning in the public event log. `agent.thinking`
  is now emitted as a content-free progress signal carrying
  `metadata.signal = "reasoning"`, so reasoning traces that echo tool output are
  no longer readable through the REST event listing or the SSE stream.
- Adds credential-scoped, in-process inbound rate limiting after authentication.
  Protected runtimes use independent read/write fixed windows, structured 429
  responses, health/preflight exemptions, dynamic managed-key posture, and
  environment overrides; open local runtimes remain unlimited by default.

- Enforces credential vault network policy at the injection boundary. Limited
  credentials require a verified matching target host before decryption; denied
  credentials are omitted from injection outputs, audited without secret values,
  and do not update `last_used_at`. This helper boundary does not yet claim
  universal web/MCP/custom-tool caller propagation.

- Admits CMA `/v1` requests that use `x-api-key` or Anthropic compatibility
  headers before route business logic: required version/beta headers are
  validated with stable structured errors, memory-store routes require their
  own memory beta, and existing `Authorization: Bearer` requests without CMA
  headers retain their behavior. Authentication accepts exactly one credential
  source per request; dual `Authorization` and `x-api-key` inputs are rejected.
  Memory-store requests reject combined managed-agents and agent-memory betas,
  while the documented memory listing accepts either beta.
- Updates `prefix-safe-json` `0.4.2` -> `0.4.3`, a security release fixing
  GHSA-3xpw-9694-2xxp: the AI SDK adapter used to silently drop raw stream
  events once it had already observed a call's own terminal, and
  `takeDecision()` used to read a decision snapshot frozen at `finish()`
  time instead of live coordinator diagnostics, so late or contradictory
  lifecycle evidence for a tool call could fail to revoke its execution
  authority. No public API change. Confirmed the exact vulnerable-then-fixed
  behavior against this integration's own `createAiSdkV4ExecutionGuard`
  wrapper (`tests/integration/post-terminal-authority.test.ts`), not just
  the library's own test suite.

### Documentation

- Documents the verified git-hosted DSH install flow: the first add fails with
  `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` until the exact key pnpm prints is
  added under `allowBuilds:` in the profile's `pnpm-workspace.yaml`; the
  second add runs `prepare`, builds `dist/`, creates both bins, and joins the
  bundle layer. Verified end to end on Windows with DSH `0.1.1-rc.2`.

### Console

- Shows the effective permission policy on each toolset header of the agent page. The policy is not visible in the definition — an `mcp_toolset` requires approval even when no `default_config` is written — so the page previously showed an MCP server's name and nothing about how its tools would be treated, and hardcoded "Always allow" for the built-in toolset. An operator can now tell a gated third-party server from an ungated one, and a reader checking the claim that the Console shows "Always Allow" has UI evidence for it. The badge carries the policy in its text and in a class name, so the policies are distinguishable without relying on colour alone.
- Improves the staged conversation experience with streaming message
  projection, resource selection, safe Markdown rendering, tool confirmation
  states, and event metadata needed by the Console.

## 0.3.8 - 2026-08-30

### Fixes

- Builds missing `dist/` entries during git-hosted installs through `prepare`,
  so DSH can install `git+https://github.com/sandbaseai/sandbase-harness.git`
  without a prior local `npm run build`. Published packages that already ship
  `dist/` skip the rebuild. MCP image builds install dependencies with
  `--ignore-scripts` because the Dockerfile copies `package.json` before
  `scripts/`.
- Counts model usage once per model request in runtime metrics and persists
  aggregate input/output token usage on each session.
- Validates confirmed tool calls against raw AI SDK v4 stream lifecycle data,
  rejects malformed or incomplete calls, and grants one-shot execution
  authority only after validation.
- Documents the maintainer and organic project-promotion workflow in
  `AGENTS.md` and keeps the DeepSeek Harness Handbook discovery link current.

## Unreleased

## 0.3.7 - 2026-08-20

### Fixes

- Makes the DeepSeek Harness bundle boot in a clean Web profile when
  `MANAGED_AGENTS_API_KEY` is unset by keeping all MCP `env` values string-typed.
- Resolves the MCP entry from the installed profile instead of requiring a
  globally linked `managed-agents-mcp` executable on `PATH`.
- Replaces the ambiguous npm-name installation command with a pinned local
  source install, preventing resolution of the unrelated unscoped package.

## 0.3.6 - 2026-08-20

### Fixes

- Restores the documented `/v1` operations API for webhooks, scheduled
  deployments, and outcomes while retaining `/v1/x` compatibility aliases.
- Exposes all three operations screens in the primary Console navigation and
  routes `#scheduled-deployments` to its intended page.
- Wires the complete Memory Stores implementation to prevent list and detail
  views from crashing on missing runtime bindings.

## 0.3.5 - 2026-08-20

### Highlights

- **Agent Skills compatibility metadata**: validates and preserves the standard
  optional `compatibility` field (1–500 characters), exposes it through the API,
  and renders it safely in Console search and detail views.
- **Instant Codespaces evaluation**: adds a development-container configuration
  and documented one-click path to build and open the local Console without
  preparing a host Node.js environment.
- **Verified DSH onboarding**: adds runtime/auth preflight checks and links the
  bilingual DeepSeek Harness developer walkthrough and operator tools.
- **Release-aligned Agent Plugin**: pins the portable MCP plugin to the v0.3.5
  multi-architecture bridge image produced from this tag.

## 0.3.4 - 2026-08-19

### Highlights

- **Published MCP container**: release tags now produce public multi-platform
  `linux/amd64` and `linux/arm64` images in GitHub Container Registry.
- **Verifiable supply chain**: images carry OCI and MCP ownership labels and a
  GitHub build-provenance attestation tied to the release digest.
- **Registry-ready metadata**: adds a version-aligned `server.json` for the
  official MCP Registry OCI distribution format.

## 0.3.3 - 2026-08-19

### Highlights

- **First-class MiniMax provider**: adds MiniMax to Settings V2 and the
  runtime provider boundary, with global and mainland China endpoints.
- **Current MiniMax models**: supports `MiniMax-M3` as the default and
  `MiniMax-M2.7` as an explicit alternative.
- **Verified setup guide**: documents environment-variable credentials,
  regional endpoint selection, agent model IDs, and configuration checks.

## 0.3.2 - 2026-08-15

### Highlights

- **Containerized MCP bridge**: adds `Dockerfile.mcp` and `.dockerignore` for
  the six-tool stdio bridge, with OCI and MCP server metadata.
- **Verified container build**: CI now builds the production MCP image from a
  clean checkout so broken Docker packaging blocks future changes.
- **Release-aligned quick start**: source, Docker, installation, deployment,
  and DeepSeek Harness examples now pin the immutable v0.3.2 tag that contains
  every referenced file.
- **Project trust and discovery**: adds security and contribution policies,
  private vulnerability reporting, and a direct SandBase Agent Skills link.

## 0.3.0 - 2026-08-14

### Highlights

- **DeepSeek Harness integration**: ships an installable Cordis bundle and the
  `managed-agents-mcp` stdio server so DSH can create and inspect agents,
  manage persistent sessions, stream turns, retrieve artifacts, and cancel
  runs through MCP.
- **Verified integration guide**: adds a reproducible DSH configuration,
  permission boundaries, troubleshooting guidance, and compatibility evidence
  against DeepSeek Harness commit `47f9438`.
- **DeepSeek V4 reasoning controls**: forwards Settings V2 `reasoning_effort`
  values to OpenAI-compatible model requests and documents a verified
  DeepSeek V4 setup.
- **Distribution metadata**: corrects package repository links to
  `sandbaseai/sandbase-harness` and adds Glama maintainer metadata for MCP
  directory verification.

## 0.2.0 - 2026-08-01

### Breaking changes

- **Workspace state directory moved**: runtime state (database, config, logs)
  now lives at `<workspace>/.managed-agents/` instead of
  `~/.managed-agents/<name>-<hash>/`. Existing workspaces need their state
  moved manually or will re-initialize on next start.
- **`composeRuntimeFromSettings`**: the `memorySeedEnabled` parameter was
  removed; use `settingsSeed: { memoryEnabled: true }` instead.
- **Legacy provider endpoints permanently removed**: `/v1/x/model-providers`,
  `/memory-providers`, `/storage-providers` return 404. Use
  `/v1/x/settings` to configure providers.

### Highlights

- **Runtime decomposition**: the monolithic route and session files are split
  into focused modules (environments, files, credential-vaults, memory-stores,
  runtime, settings, templates, session-normalizers, session-stream,
  session-records, session-lifecycle, session-recovery, secrets,
  skill-packages, skill-resources, resource-utils). `resources.ts` and
  `extended.ts` are now pure composition roots.
- **Sandbox backends**: local process, Docker (with per-session container
  labels and path confinement), and Kubernetes (kubectl exec/cp transport)
  are shipped; Environment write-side validation rejects unknown providers.
- **Docker environment mode**: `hosting_type: docker` with image/resources
  fields in the Environment config.
- **Console improvements**: YAML/JSON agent config editor, fix modal crashes,
  session send failure handling, environment editor polish, settings form
  splitting.
- **Release gate**: `npm run release:check` covers typecheck (src + tests),
  full test suite, production build, package dry-run, CLI init smoke, and
  example workspace startup.
- **Model registry**: `resolveModelConfig()` supports `openai/gpt-5.5`-style
  qualified model references.
- **Workspace registry**: `managed-agents init` and
  `createRegisteredWorkspace` write config to `.managed-agents/config.yaml`,
  consistent with the runtime's path resolution.

### Stats

- 75 test files, 569 tests (up from 67 / 544 in 0.1.0).
- 24 new source modules, 7 new test files.
- `release:check` passes on a clean checkout.

## 0.1.0 - 2026-07-18

First public release of `managed-agents`.

### Highlights

- Local-first managed agent runtime with a Claude Managed Agents-style `/v1`
  API surface.
- React Dashboard for agents, sessions, environments, credential vaults,
  memory stores, files, skills, settings, logs, monitoring, and API reference.
- SQLite-backed runtime state stored outside source-controlled workspaces by
  default.
- Settings V2 for one workspace model vendor, loop engine, storage backends,
  context-memory backend, sandbox provider, API keys, validation, and restart
  flows.
- Session lifecycle, event replay, resumable SSE streams, memory resources,
  file resources, credential vaults, snapshots, local/Docker/self-hosted
  sandbox registration, MCP tools, and skill packages.
- TypeScript SDK and CLI commands for init, start, list, reload, chat, deploy
  guidance, and templates.
- Release gate covering typecheck, tests, production build, package dry-run,
  CLI init smoke, and example workspace startup smoke.

### Known first-release boundaries

- One active model vendor, one built-in loop engine, SQLite metadata storage,
  local artifact storage, SQLite memory, and runtime-registered sandbox
  providers are supported in 0.1.0.
- Planned adapters such as S3, Postgres/MySQL, mem0, MemU, Harness, Codex, and
  Claude loop engines remain unavailable until their runtime implementations
  are added.
- Live remote model credential checks and production deployment examples are
  tracked as follow-up work.
