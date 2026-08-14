# Claude Managed Agents Gap Spec

Reviewed: 2026-07-23

Repository:

- Local path: `/Users/liyb/Documents/Codex/2026-07-16/new-chat-2/managed-agents`
- Remote: `https://github.com/sandbaseai/sandbase-harness.git`
- Local HEAD reviewed: `b8979f1e9778f8cc1e56a5cc86048340afd16eec`
- Remote freshness: not verified in this sandbox because outbound SSH to GitHub is blocked.
- Worktree state: dirty, with substantial existing product changes. This review preserves the worktree and does not re-clone over it.

## 1. Product direction

`managed-agents` should be an open-source, local-first Console/runtime for Forward Deployed Engineers to design, validate, run, inspect, and hand off Claude Managed Agents-style workflows.

The project should not pretend to be the hosted Claude platform. It should provide a truthful local subset:

- Claude-style mental model: agents, sessions, environments, files, skills, credential vaults, memory stores, API keys, schedules, webhooks, outcomes, logs, and monitoring.
- Local-first runtime: SQLite metadata, local artifact storage, local/Docker/self-hosted sandbox providers, local Dashboard.
- Honest settings: one active model provider, one loop engine, one metadata store, one artifact store, one memory backend, and one sandbox backend.
- Roadmap visibility without fake UI: Postgres, S3, mem0, MemU, remote sandbox, MCP tunnels, OAuth refresh, Codex/Claude loop adapters, and Harness should stay disabled until there is a real adapter, validation probe, and tests.
- Validation before trust: every runtime-affecting setting must be probe-validated, not merely schema-validated.

## 2. Claude Managed Agents baseline

The public Claude Managed Agents surface is broader than a Dashboard. For this project, treat Claude as the product-reference mental model, not a feature-by-feature clone target.

Baseline capabilities to compare against:

| Area | Claude-style expectation | Local product interpretation |
| --- | --- | --- |
| Agents | Persisted agent definitions with model/runtime intent, system prompt, built-in tools, MCP toolsets, skills, metadata, archive/version history. | Keep the resource shape and versioned authoring flow. Reject or clearly disable unsupported capabilities. |
| Sessions | Long-running sessions with persisted events, streaming, resumability, interrupts, tool use/results, custom results, artifacts, and usage/debug views. | Provide reliable local event logs, replay/export, trace filters, artifact/resource mounts, and handoff bundles. |
| Environments | Cloud or self-hosted execution templates with sandbox, package, workspace, and network policy. | Settings chooses the active sandbox backend; named Environments are reusable session templates validated against that backend. |
| Tools and MCP | Built-in shell/file/web tools, MCP servers/toolsets, permission policies, and hosted tunnel workflows. | Implement a safe local subset. MCP stdio/url can be supported; hosted tunnels remain roadmap until lifecycle/auth/reconnect exist. |
| Resources | Files, skills, credential vaults, memory stores, and external context mounted into sessions. | Keep table-first resources and explicit mount previews. Separate backend settings from user-facing resources. |
| Credentials | Static/OAuth/env credentials, scoped injection, host/egress controls, refresh/revoke, and audit. | Encrypted local vaults are useful; runtime-boundary policy enforcement is P0. OAuth lifecycle is roadmap. |
| Memory | Memory stores plus beta-gated agent-memory semantics. | SQLite/in-memory local backend first; mem0/MemU/database adapters are roadmap until validated. |
| Operations | Webhooks, scheduled deployments, outcomes/evals, run history, logs, monitoring, CLI/SDK examples. | Implement local operations honestly with delivery/run/eval history and automatic event wiring. |
| Compatibility | Beta/header behavior and unsupported feature behavior are explicit. | Add a central compatibility/capability policy. Unknown or partial features must produce warnings/errors. |

Reference links:

- https://www.anthropic.com/engineering/managed-agents
- https://platform.claude.com/docs/en/managed-agents/overview
- https://platform.claude.com/docs/en/managed-agents/tools
- https://platform.claude.com/docs/en/managed-agents/credential-vaults
- https://platform.claude.com/docs/en/managed-agents/memory
- https://platform.claude.com/docs/en/managed-agents/mcp-tunnels
- https://platform.claude.com/docs/en/managed-agents/webhooks
- https://platform.claude.com/docs/en/managed-agents/scheduled-deployments
- https://platform.claude.com/docs/en/managed-agents/outcomes
- https://blog.cloudflare.com/claude-managed-agents/

## 3. Current local inventory

Static review evidence:

| Area | Local evidence | Status |
| --- | --- | --- |
| Runtime/API | `src/api/server.ts`, `src/api/routes/*`, `src/core/runtime/*` | Broad local API exists. Needs capability/compat source of truth. |
| Agents | `src/api/routes/agents.ts`, `src/core/agent/*`, `apps/console/src/components/pages/AgentPages.tsx` | CRUD, schema, versions, and Console pages exist. Needs validate/test/diff workflow. |
| Sessions | `src/api/routes/sessions.ts`, `src/core/session/*`, `SessionPages.tsx`, `SessionModals.tsx` | Session lifecycle/events/tools exist. Needs trace/export/replay polish. |
| Tools | `src/core/session/tool-resolver.ts`, `src/core/agent/schema.ts` | Local shell/file/search-by-files tools exist. Important gap: schema accepts `web_fetch` and `web_search`, but resolver does not execute them. |
| MCP | `src/core/mcp/mcp-manager.ts`, agent schema MCP server configs | stdio/url-style MCP shape exists. Hosted tunnel behavior is absent and should remain roadmap. |
| Environments/sandbox | `src/sandbox/*`, `EnvironmentPages.tsx`, `src/core/session/sandbox-lifecycle.ts` | Local/Docker/self-hosted shapes exist. Needs validation against active Settings sandbox. |
| Credentials | `src/core/credentials/injection.ts`, resource routes, `CredentialPages.tsx` | Encrypted/redacted storage exists. Runtime-boundary allow-host/injection enforcement is incomplete. |
| Memory | `src/core/memory/*`, `MemoryPages.tsx` | SQLite/in-memory base exists. Settings backend vs Memory Store resource split is correct. |
| Files/artifacts | Resource APIs, Files page, artifact/session routes | Local artifact path is credible. S3 should not be configurable until adapter/probes exist. |
| Skills | `src/core/skills/*`, `src/api/routes/skills.ts`, `BuildPages.tsx` | Catalog/upload/version flow exists. Needs capability-driven warnings and continued drawer/table polish. |
| Settings | `src/core/settings/schema.ts`, `RuntimeSettings.tsx`, `SettingsPage.tsx` | Correct one-active-stack shape. Validation is too structural and should move to real probes. |
| Operations | `src/core/operations/*`, `OperationsPages.tsx`, `OperationsSettings.tsx` | Webhook/schedule/outcome primitives exist. Automatic runtime wiring and detail UX remain. |
| CLI/SDK/docs | `src/cli/*`, `src/sdk/*`, `docs/*`, `tests/*` | Useful alpha surface. Docs/API matrix must stay aligned with actual local subset. |

## 4. Settings model spec

Settings must be boring, explicit, and testable. Avoid marketplace-style “many providers” UI until providers truly exist.

### 4.1 Models

Current product decision:

- Configure one active model vendor/provider.
- Do not ask normal users for model id in Settings.
- Advanced/raw JSON can support model-specific overrides later, but the main UI should show:
  - vendor
  - base URL
  - API key environment variable/reference
  - validation state

Acceptance:

- No fake model list.
- No “Add provider” button.
- Missing API key is visible as a validation warning/error.
- Provider probe can verify the configured endpoint/key once implemented.

### 4.2 Loop engine

Current product decision:

- One active loop engine.
- `managed-agents` is implemented.
- `harness`, `codex`, and `claude` are roadmap adapters until there is executable adapter code.

Acceptance:

- Main UI shows one selected engine and its validation state.
- Roadmap engines are disabled with explanation.
- Engine validation can build or dry-run an execution plan.

### 4.3 Storage

Current product decision:

- Storage is global and has two flat slots:
  - metadata storage
  - artifact storage
- Metadata starts with SQLite.
- Artifact storage starts with local filesystem.
- Postgres/S3 appear only after real adapters and probes exist.

Acceptance:

- No fake provider table.
- Metadata card displays SQLite path/state.
- Artifact card displays local path/state.
- Validation performs actual open/migrate/read/write checks for metadata and write/read/delete checks for artifacts.

### 4.4 Memory

Current product decision:

- Settings > Memory configures the context memory backend.
- Memory Stores remain resource objects outside Settings.
- SQLite/in-memory are local implementations.
- mem0, MemU, and external DB backends are adapters, not UI promises.

Acceptance:

- Main UI shows one backend.
- Roadmap backends are disabled until implemented.
- Validation performs isolated CRUD/search.
- Memory Store pages do not masquerade as backend configuration.

### 4.5 Sandbox

Current product decision:

- Settings > Sandbox configures the active backend.
- Environments define reusable session templates/policies that run on that backend.
- Local/Docker/self-hosted can be shown only when available/implemented.
- Remote/cloud sandbox is roadmap.

Acceptance:

- Main UI shows one active backend.
- Backend availability is probed.
- Environment templates are validated against active backend capabilities.
- Self-hosted controls are hidden or disabled when self-hosted is unavailable.

### 4.6 Raw config escape hatch

If a Settings section is not ready for a polished form UI, prefer a raw JSON/YAML editor over fake controls.

Acceptance:

- Raw editor has schema validation before save.
- Raw editor has probe validation before marking “ready”.
- Invalid config never silently persists as active runtime config.

Canonical shape:

```yaml
model_provider:
  vendor: openai-compatible
  base_url: ${OPENAI_BASE_URL}
  api_key_env: OPENAI_API_KEY

loop_engine:
  type: managed-agents
  config: {}

storage:
  metadata:
    type: sqlite
    path: <workspace>/.managed-agents/data.db
  artifacts:
    type: local_filesystem
    path: <workspace>/.managed-agents/files

memory:
  backend:
    type: sqlite
    connection_url: <workspace>/.managed-agents/memory.db

sandbox:
  type: local
  config: {}
```

## 5. Gap list and priorities

### P0. Public-alpha blockers

#### P0.1 Capability registry and compatibility policy

Problem:

- Agent schema accepts capabilities that are not executable locally.
- There is no single source of truth for implemented, partial, unsupported, and roadmap features.

Evidence:

- `src/core/agent/schema.ts` accepts `web_fetch` and `web_search`.
- `src/core/session/tool-resolver.ts` only builds executable local tools for `bash`, `read`, `write`, `edit`, `glob`, and `grep`, plus MCP/delegation.

Required work:

1. Add `src/core/capabilities/registry.ts`.
2. Add `src/core/compat/policy.ts` for Claude-style beta/header behavior.
3. Add `GET /v1/x/capabilities`.
4. Reject unsupported executable capabilities during agent save and session startup, or implement them safely.
5. Console must render capability state from the registry rather than hard-coded marketing copy.

Tests:

- Unit test capability registry output.
- API test: `web_fetch`/`web_search` cannot be saved or started as runnable unless implemented.
- API test: accepted, unknown, and unsupported beta headers behave according to policy.
- Console test: unsupported/roadmap capabilities render disabled with reason.

#### P0.2 Probe-based Settings validation

Problem:

- Settings has a good shape, but validation is mostly structural.
- Users need to know whether the runtime stack can actually run.

Required work:

1. Move validation probes to `src/core/settings/validation.ts`.
2. Add probe result type:
   - key
   - status
   - message
   - duration_ms
   - checked_at
   - remediation
3. Probe:
   - model provider endpoint/API key reference
   - loop engine dry execution plan
   - SQLite metadata open/migrate/read/write transaction
   - local artifact write/read/delete
   - memory backend isolated CRUD/search
   - sandbox harmless dry-run or provider health
4. Add or harden `POST /v1/x/settings/validate`.
5. Console Settings sections must show section-level validation state and detailed probe output.

Tests:

- Unit tests for every probe with temp directories/databases.
- Integration test for settings validation endpoint.
- Console static test proving there are no fake Add-provider controls.

#### P0.3 Credential runtime policy enforcement

Problem:

- Vault storage/redaction is useful, but the security boundary is the runtime execution path.
- Secrets must not reach web/MCP/custom tools unless the current session, vault, host, and injection mode allow it.

Required work:

1. Introduce `CredentialPolicyContext`.
2. Enforce `allowed_hosts` before any web/MCP request receives a credential.
3. Inject only credentials attached to the current session.
4. Validate injection compatibility:
   - environment variable
   - HTTP header
   - bearer token
   - MCP OAuth-like credential
5. Emit audit allow/deny/mismatch events without exposing raw secrets.

Tests:

- Credential attached to session A is unavailable in session B.
- Disallowed host fails before injection.
- Wrong injection location fails.
- Logs/API/Console previews never reveal raw secret values.

#### P0.4 Canonical API and docs truthfulness

Problem:

- Local APIs/docs are growing quickly. Public alpha needs a clear supported subset.

Required work:

1. Keep `docs/api-matrix.md` generated or manually aligned with actual routes.
2. Mark partial/roadmap features consistently in docs and Console.
3. Reject unsupported features early with structured errors.
4. README must say “local-first Claude-style runtime,” not “full Claude Managed Agents replacement.”

Tests:

- Route matrix smoke test.
- README/API docs guardrail test for fake hosted claims.

### P1. Strong local parity

#### P1.1 Agent authoring workflow

Required work:

- Validate-before-save preview.
- Capability warnings from `/v1/x/capabilities`.
- Side-by-side version diff.
- Copy old version to draft.
- “Test this agent” creates a session with selected environment/resources.

Tests:

- Console tests for validation preview, diff, rollback draft, and test-session launch.

#### P1.2 Session trace/export/replay

Required work:

- Normalize event taxonomy.
- Filters for user/assistant/tool/result/error/runtime/artifact.
- Highlight waiting-for-confirmation and waiting-for-custom-result states.
- Export replayable evidence bundle for FDE handoff.

Tests:

- Replay bundle contains agent version, settings snapshot, environment, resources, events, artifacts, and redacted credentials.

#### P1.3 Environment vs Sandbox validation

Required work:

- Validate Environment templates against active sandbox backend.
- Display unsupported package/network/workspace policies before session start.
- Hide or disable self-hosted worker controls unless self-hosted capability is enabled.

Tests:

- Environment using unsupported policy cannot start silently.

#### P1.4 Console UI completion

Required work:

- Table-first resource pages.
- No default-open drawers unless a row is selected.
- Settings layout stays dense, neutral, and Claude/Codex-like.
- Select/dropdown z-index works in toolbars, cards, modals, and drawers.
- API reference examples never cause horizontal page scroll.

Tests:

- Static guardrails for removed fake/stale controls.
- Browser visual verification when local server permissions allow it.

### P2. Operations and adapter expansion

Required work:

- Webhook create/edit/detail and delivery history.
- Automatic runtime event dispatch to webhooks.
- Scheduled deployment next-run, due-runner, timezone, and run history.
- Outcome deterministic evaluator and optional model-assisted evaluator after provider validation.
- Postgres metadata adapter.
- S3 artifact adapter.
- mem0/MemU memory adapters.
- OAuth refresh/revoke lifecycle for MCP credentials.
- MCP tunnel lifecycle/auth/reconnect/discovery.
- Remote/cloud sandbox adapter.

Rule:

- Do not expose a configurable adapter until adapter code, validation probe, and tests exist.

### P3. FDE handoff differentiators

These are not required for Claude parity, but they can make the open-source project more brand-distinct:

- One-click FDE handoff bundle: spec, run transcript, artifacts, env/settings snapshot, credential redaction report, and deployment notes.
- Agent readiness score: capability truth, settings validation, secret boundaries, environment compatibility, tests, and docs.
- Customer workspace template: cloneable package for a specific deployment.
- Runbook generator from successful session traces.
- Eval packs bundled with agents.

## 6. Implementation plan

Recommended sequence:

1. P0.1 Capability registry + compatibility policy.
2. P0.1 Web tool truthfulness: reject or implement `web_fetch`/`web_search`.
3. P0.2 Settings validation probes.
4. P0.3 Credential runtime policy enforcement.
5. P1.1 Agent editor validate/test/version-diff workflow.
6. P1.2 Session trace/export/replay bundle.
7. P1.3 Environment/sandbox validation.
8. P1.4 Console UI completion and browser visual QA.
9. P2 Operations event wiring and history UX.
10. P2 adapters only when real implementations are ready.

## 7. Done criteria for public alpha

Public alpha can be cut when:

- Fresh clone installs, builds, and runs locally.
- Dashboard starts at `/dashboard`.
- Settings configures exactly one active runtime stack and validates it with probes.
- Unsupported Claude-style capabilities are either executable or rejected early.
- Secrets are scoped to session/vault/tool/host and redacted everywhere else.
- A user can create an agent, create a session, mount files/skills/vaults/memory, run the session, inspect events/artifacts, and export a handoff bundle.
- Docs accurately distinguish implemented, partial, and roadmap behavior.
- Tests cover runtime settings, capability policy, credential policy, sessions, resources, operations primitives, Console guardrails, and SDK/CLI smoke flows.
