# Roadmap

This public roadmap tracks product work for `managed-agents`. It describes
project-owned features only. Reviewed on **2026-11-02** against `0a7f8a4`, the
official documentation snapshot from 2026-10-31, and the pinned official SDK
`0.131.0`. The 50 pinned documentation pages were byte-identical to their live
URLs on 2026-11-02; the crawl does not discover pages absent from the snapshot.

## CMA compatibility

Full compatibility with the published CMA behavior is the target, not a claim
about the current release. [Decision 0002](decisions/0002-cma-multiagent-parity.md)
restores multiagent to that target. The implementation inventory is
[`matrix.ts`](src/core/capabilities/matrix.ts), with field and lifecycle detail
in [`contracts/anthropic-cma`](contracts/anthropic-cma/README.md).

The pinned SDK inventory has 110 method/path pairs: 90 resource mounts and 20
explicit refusals, with no deferred mounts. After the scope correction the
59 matrix entries comprise 46 `supported`, 9 `partial`, 2 `unavailable`, and
2 `not_applicable`. These are inventories, not a completion percentage:
entries include local extensions, and a supported operation can still have
documented field or backend limitations. Hosted user-profile refusals are
tracked in the route inventory and are not a separate matrix entry.

### Protocol and execution gaps

Each row is an implementation track, not one combined PR. Split the row into
independently verifiable behaviors before implementation; preserve existing
clients through an explicit migration when changing a published response.

| Track | Current evidence | Completion criteria |
| --- | --- | --- |
| Agent model defaults | [`agents.md §4`](contracts/anthropic-cma/agents.md#4-differences): `model` now returns an object; omitted effort still follows runtime/provider configuration rather than an official per-model default saved on the definition. | Source-backed per-model effort defaults resolve at save time and execute consistently; migrations, updates, session overrides and historical snapshots preserve their documented semantics. |
| Self-hosted tool answers | [`reference.md`](contracts/anthropic-cma/official-docs/reference.md) defines `user.tool_result` for self-hosted `agent_toolset` calls. Admission now explicitly refuses it as `self_hosted_tool_result_not_supported`; it previously acknowledged and persisted results without consuming them. The local queue has no durable mapping from sandbox operations to official tool-use event IDs. | Persist guarded tool-call identity before dispatch and coordinate session-scoped Work claims with the local completion channel. A worker can settle its outstanding built-in call and resume grouped calls across restart; wrong-session, duplicate, malformed, and unissued answers fail without executing twice. |
| Work item lifecycle | [`work.md §4`](contracts/anthropic-cma/work.md#4-differences): the backing queue is tool-call-scoped; per-item TTL and forced stop differ from the published session claim. | An official worker serves a session from one claim, with the published heartbeat, TTL, stop, and recovery semantics. Lost accepted work is never replayed blindly. |
| Thread foundation and subagents | [`threads.md`](contracts/anthropic-cma/threads.md): no durable threads, isolated event histories, aggregate status, or thread-targeted interrupts exist. Both related capabilities are `unavailable`. | Primary and child threads have durable identity, isolated context, shared resources and budget, published status/message events, limits, archive and interrupt behavior, and restart/replay coverage. Only implemented `multiagent` members may be admitted. |
| Workflow runs and advisor | [`threads.md`](contracts/anthropic-cma/threads.md) records the published lifecycle, limits, and `workflow_run_open` gate; no executor exists. | Separate changes implement persisted background runs and phase events, lifecycle gates and recovery, and advisor consultations. Tests cover shared spend and interruption without broadening tool or credential authority. |
| Sandbox network enforcement | [`environments.md §4`](contracts/anthropic-cma/environments.md#4-differences): Docker enforces its proxy boundary, local is advisory, Kubernetes/self-hosted install none. | Each supported restricted backend passes bypass and allowed-egress tests at its actual boundary. Reads continue to report the effective strength; unsupported configurations never claim enforcement. |
| HTTPS environment credentials | [`credentials.md §4`](contracts/anthropic-cma/credentials.md#4-differences): placeholders are substituted on HTTP forwarding only; CONNECT is opaque. | A reviewed design authenticates an HTTPS request to an allowed host without revealing the secret to the model or sandbox. Disallowed hosts and redirects fail closed. Do not fall back to plaintext environment exports. |
| Deployment failure classification | [`scheduler.ts`](src/core/operations/scheduler.ts) maps creation throws to `unknown_error`; the MCP admission boundary now gates hosts, but no `mcp_egress_blocked_error` projection exists. | A deployment blocked by MCP egress records the published error and pause reason; unrelated errors retain their own classification. |
| Remaining documented subsets | [`tools.md`](contracts/anthropic-cma/tools.md), [`agents.md`](contracts/anthropic-cma/agents.md), [`budget.md`](contracts/anthropic-cma/budget.md), [`operations.md`](contracts/anthropic-cma/operations.md), and [`dreams.md`](contracts/anthropic-cma/dreams.md) record WebFetch content limits, `inference_geo` refusal, local prices, webhook behavior, and dream admission differences. | Review each difference against a concrete official-client scenario. Implement supported behavior in separate PRs, or retain a specifically justified limitation in the contract and inventory. |

### Scope decisions still limiting full compatibility

MCP tunnels, hosted user profiles, and session-budget notifications remain
excluded by the current implementation policy; see
[`unsupported.md`](contracts/anthropic-cma/unsupported.md). They remain visible
differences from the full target, not completed features. Determine their
self-hosted equivalents before changing their status or accepting requests.
Likewise, `config.type: "cloud"` currently selects operator-owned Docker; it
does not provide Anthropic-managed hosting.

Self-hosted refusal of `file` and `github_repository` resources matches the
official resource restriction and is not a missing parity feature. Kubernetes
mount support is a separate local-backend gap below.

### Verification and delivery gaps

| Track | Current evidence | Completion criteria |
| --- | --- | --- |
| Official documentation scenarios | [`docs-examples/manifest.ts`](tests/conformance/docs-examples/manifest.ts) still uses an external Chinese tree, enables three snippets, and contains outdated exclusions for Dreams and Work. [`doc-curl-examples.test.ts`](tests/conformance/doc-curl-examples.test.ts) transcribes selected bodies and intentionally asserts some local deviations. | Bind executable scenarios to the pinned snapshot, review digests and fixtures, and separate official conformance assertions from documented deviations. Required CI must execute the selected scenarios rather than silently skip them. |
| Upstream change discovery | [`crawl-cma-docs.ts`](scripts/crawl-cma-docs.ts) compares only the local page set; SDK upgrade [#955](https://github.com/sandbaseai/sandbase-harness/pull/955) is still open at this baseline. | Detect added/renamed upstream pages and review SDK route/type changes before updating pins. Keep every new unsupported route explicit. |
| Real execution boundaries | Local conformance run on 2026-11-02: 144 passed, 4 skipped (three external-doc tests and the Docker SDK quickstart). CI at the baseline passed Quality, Test, E2E, and Build. | Record complete SDK turns on Docker, real MCP/HTTPS credential flows, worker recovery, budget resume, and scheduled runs against the exact tested build. Report unavailable providers and skipped suites separately. |
| Settings readiness | [`test.ts`](src/core/settings/test.ts) checks model configuration and key presence without making a model request. | Offer an explicit live probe whose result distinguishes valid configuration from successful provider authentication and model execution. Keep credentials out of diagnostics. |
| Release delivery | Latest release at this baseline is `v0.3.8` (2026-08-30); the README install command targets it while the compatibility table describes newer main. | Pass the release gate on a named commit, publish a new tested artifact and release notes, and align quickstart and versioned compatibility evidence with that artifact. |

## Recently completed

These are implemented on main, not promises about the older `v0.3.8` release:

- All Console-related tests now participate in `typecheck:tests`. The 13
  file exclusions were removed after repairing drifted fixtures and narrowing
  a tool-result assertion; the full test TypeScript program passes without
  weakening production types or disabling checks.
- The official stream-first reconnect workflow is now verified with SDK
  `0.131.0` over real local HTTP: full-history pagination, overlap deduplication
  by payload ID, ordered live events, and writes recovered after disconnection.
  The numeric SSE cursor is a local extension, not a demonstrated incompatibility
  with this workflow. This provider-free check uses `session.updated` events
  ([`streaming.md`](contracts/anthropic-cma/streaming.md#3-alignment)).
- Published vault responses now use `type: "vault"` across create/read/list/update/archive,
  while the local prefix preserves `credential_vault` over the same records
  ([`credentials.md`](contracts/anthropic-cma/credentials.md#4-differences)).

- Environment package installation at provisioning, including failure handling
  and package-manager network admission ([#961](https://github.com/sandbaseai/sandbase-harness/pull/961)).
- Declarative agent/environment/deployment `apply` with a durable lock file
  ([#962](https://github.com/sandbaseai/sandbase-harness/pull/962)).
- Session CLI commands and typed SDK conversation/history helpers
  ([#852](https://github.com/sandbaseai/sandbase-harness/pull/852),
  [#854](https://github.com/sandbaseai/sandbase-harness/pull/854)).
- Session filesystem snapshots and restore wiring for backends with a host
  filesystem
  ([`snapshot-manager.ts`](src/core/session/snapshot-manager.ts),
  [`snapshot-wiring.test.ts`](tests/integration/snapshot-wiring.test.ts)).
- Docker restricted egress, OAuth refresh, Dreams, Work API route coverage,
  and Console session MCP diagnostics; their remaining subsets are tracked
  above rather than presenting the whole feature as unimplemented.

## Near Term

- Close the protocol gaps above and establish official-client scenario coverage
  before broadening the multiagent and worker execution models.
- Improve template validation and authoring commands.
- Add richer runtime metrics for model usage, tool duration, and session state.

## Runtime

- Add optional long-term memory provider support.
- Expand context-window metadata and compaction controls.
- Improve graceful shutdown reporting for in-flight turns.
- Re-evaluate the state database's write durability only together with its
  contract. Connections hold `journal_mode=WAL`, `foreign_keys=ON`,
  `busy_timeout=5000`, `synchronous=FULL` and `trusted_schema=OFF`, and
  `src/core/db/pragmas.ts` refuses a connection that cannot show those values.
  `synchronous=FULL` is deliberate: local write volume is low and writes are
  serialized by an immediate transaction, so one fsync per commit is affordable
  and it covers the host crash that `NORMAL` does not. Changing a value means
  changing that rationale, the expected value in the pragma spec and the
  recovery guarantee together; dropping `busy_timeout` or the immediate
  transaction would reintroduce the deferred-transaction conflict the CLI and
  the server hit when they share one `data.db`. `fullfsync` and
  `checkpoint_fullfsync` are the one part of the recipe this runtime does not
  claim, because Node's bundled SQLite defines no
  `SQLITE_ENABLE_FULLFSYNC` and the pragma verifies as a plain flag either way;
  add them, to the spec and the verification together, when a Node release
  enables F_FULLFSYNC and a macOS host can confirm it.

## Sandboxes

- Harden local sandbox defaults. The local backend now wraps commands in
  `sandbox-exec` (macOS) or `bubblewrap` (Linux) when the tool is present —
  writes confined to the workdir — but that is a best-effort boundary, not a
  VM. Remaining hardening: network namespacing (today the egress proxy is
  env-level), resource limits, and a confinement story for Windows hosts.
- Expand Docker examples and resource-limit coverage.
- Run the Kubernetes live-cluster suites in CI. They exist and pass against a
  real cluster, but they skip when no cluster is reachable, so nothing currently
  enforces them. See CONTRIBUTING.md for how to run them locally.
- Handle Pod eviction and node pressure mid-session. Provision now fails fast on
  terminal image and config errors, but a Pod evicted after a session is running
  surfaces only as command failures.
- Serve `file` resources on the `kubernetes` backend: it currently resolves
  absolute paths inside its own `/workspace` and refuses the
  `/mnt/session/uploads` root at session creation (`resource_not_mountable`).
- Add incremental command output (`streamingExec`) once a consumer exists for
  it: today tool results reach the model as a single value, so the capability is
  declared and reported as unsupported rather than implemented.
- Improve self-hosted worker ergonomics.
- Add provider packages for additional isolated execution backends.

## Dashboard

- Add clearer error and reconnect states.
- Expand model and skill diagnostics; session MCP status is already available.
- Add read-only configuration inspection.

## CLI and SDK

- Expand inspection beyond the existing session and environment commands.
- Add richer SDK examples.
- Extend event-filter and cursor helpers beyond the existing conversation,
  history, follow, and inspection helpers as new official scenarios require.

## Documentation

- Keep public documentation in English.
- Keep public documentation focused on this project.
- Keep public documentation focused on release-facing project behavior.
- Add deployment guides after the runtime behavior is stable.
- Add a versioned compatibility matrix before the first stable release.
