# CMA Contract — agents

Contract area: `/v1/agents` — agent definitions, model profile, toolsets.
Status: `supported` for CRUD; `partial` for the model object profile; the
canonical `multiagent` block is `unavailable` (in scope under
[decision 0002](../../decisions/0002-cma-multiagent-parity.md), not implemented) and the
local delegation extension is separate. See §4.
Source: `src/core/agent/schema.ts`, `src/core/agent/update.ts`,
`src/core/agent/model-object.ts`, `src/api/routes/agents.ts`,
`src/api/routes/session-normalizers.ts`.

<!-- capability-status
agent-crud: supported
model-object-profile: partial
multiagent-roster: unavailable
local-delegation-subagent: supported
-->

---

## 1. Official definition

- An agent is a named, versioned definition: model, system prompt, tools, and
  the resources it may use.
- The pinned official SDK declares `system` optional and nullable on create.
- `model` may be a plain string, or an object carrying `id` plus optional
  `speed`, `effort`, and `inference_geo`.
- An agent may declare a `multiagent` block (`multiagent_20261001`) with
  `subagents`, `workflows`, and `advisor` members describing the delegation and
  orchestration it may use. See [`threads.md`](./threads.md).
- Tool entries may carry per-tool configuration, including the domain policy for
  `web_fetch` and `web_search`.

## 2. Current SandBase shape

The write paths are `src/core/agent/schema.ts` and `src/core/agent/update.ts`,
the model profile is `src/core/agent/model-object.ts`, and the routes are
`src/api/routes/agents.ts` with `src/api/routes/session-normalizers.ts`.

- Agent definitions are created, listed, read, and version-archived. Updating an
  agent produces a new archived version; the prior definition remains readable
  rather than being overwritten. `POST` and `PUT` on `/v1/agents/{id}` share one
  partial-update implementation: `POST` is the published verb — both published
  update examples send a body with `curl -d` and no `-X`, while the same file
  spells `-X POST` out for archive — and `PUT` is the local spelling of the same
  operation. No `PATCH` is mounted; an earlier version of this sentence claimed
  one and there is none.
- `model` normalizes to a string for execution. The object form is parsed field
  by field by `normalizeModelField`, and each field is either honoured or
  refused by name (see §4).
- On create, omitted, `null`, or empty `system` normalizes to an empty string.
  Updates keep an omitted prompt and clear it for `null` or an empty string.
  Other non-string values are refused; reads return the normalized string.
- Every agent projection returns `model` as an object with `id`, `speed`, and
  object-form `effort` when explicitly stored. This covers CRUD, versions,
  session snapshots and update events. `model_config` remains a local compatibility
  extension, omitted for standard speed without explicit effort. String readers
  must migrate to `model.id`; Console and the local SDK do so. An omitted
  `effort` is resolved to the model's documented default at save time (see §4),
  so the stored profile is self-describing. On the Anthropic provider `effort` and `speed`
  are also executed: the level reaches the request as `output_config.effort`
  and `fast` as `speed` with the published `fast-mode-2026-02-01` beta, each
  gated by the model capability table in `src/model/anthropic-capabilities.ts`,
  and a model the table marks adaptive gets
  `thinking: {type: "adaptive", display: "omitted"}` — no caller-facing
  thinking field exists because the published contract has none. On every
  other provider, and for model ids the table does not know, the profile is
  stored and echoed but nothing is sent. When `model` is
  the object form it is authoritative — the profile comes from that object, and a
  `model_config` sent beside it is ignored rather than merged, which is the
  precedence the update rule already relies on.
- Toolsets (`builtin` / `custom` / `mcp` / `skill`) are validated against a Zod
  schema before an agent is persisted; a definition that fails validation is
  rejected instead of being stored partially.
- `mcp_servers` is bounded to the published declaration: at most 20 servers,
  each `name` 1–255 characters and unique within the agent, and a `url`-type
  server's `url` at most 2,048 characters. The same bounds apply on both the
  `url` and `stdio` arms of the discriminated union.
- The `skills` array is bounded at 500 entries. The published bound is the
  deduplicated set across every agent in a session; this runtime runs one
  agent per session, so the agent's own array is the whole set and the bound
  lands on the declaration.
- `web_tool.configuration` is fully validated (domain grammar, allowed/blocked
  exclusivity, empty-list rejection). See [`tools.md`](./tools.md).
- The update precondition is accepted under both names: `version` is the
  published spelling and `expected_version` is the local one. The published
  contract says the field is optional, that supplying it gives optimistic
  concurrency control with a `409` on a mismatch, and that omitting it applies
  the update unconditionally; that is exactly the local behaviour, so only the
  name differs. Both are read, and sending both with different values is refused
  rather than resolved by precedence.
- A canonical `multiagent` block with `type` other than `coordinator` is
  **refused by name** on both write paths. A `{"type":"coordinator","agents":[…]}`
  block — the delegation-only subset upstream self-hosted accepts — is
  normalized on the `/v1/agents` write paths rather than refused: each
  `agent_…` entry resolves to the loaded agent's name, the roster is stored in
  `delegations` with `delegations_source: "coordinator"` so the published
  one-level depth rule applies, `{type:"self"}` maps to
  `enable_general_subagent`, and `multiagent: null` clears a
  coordinator-produced roster. An `agent_…` id that resolves to nothing is a
  `400` at write time, and a `version` pin resolves to latest rather than to an
  archived version row. Every other shape — `multiagent_20261001`, `advisor`,
  `workflows`, `subagents`, `inline_agents` — is still refused with
  `multiagent-roster`. The resolution lives in
  `src/api/routes/agents.ts` (`normalizeMultiagentField`), which runs before
  `validateAgentDefinition`/`validateAgentUpdateRequest`, because the
  validators hold no store to resolve ids against; reaching a validator with
  the raw block still answers a named refusal rather than a silent strip.
- Local delegation is a separate extension, not the roster: `delegations` is a
  list of agent names, and the boolean `enable_general_subagent` exposes one
  extra tool that runs a temporary copy of the agent for a single level. Both
  write paths accept it, because `DelegationService` builds delegation tools from
  exactly those fields.

## 3. Alignment

Aligned for: agent identity and versioning, toolset structure and validation,
the string model form, web tool configuration shape, and refusing a declared
field the runtime cannot honour instead of dropping it.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Default `model.effort` | The save-time fill is implemented: a definition that omits `effort` is stored with the model's documented default (the published effort page fixes `medium` on Claude Opus 5.5 and Claude Haiku 5.5, `high` on every other effort-capable model), so the stored profile is self-describing and every read — the agent read, the version read, the frozen session snapshot — returns the level the runtime executes. An explicit `effort` always wins; a model the capability table does not know keeps `effort` absent rather than inventing a level, and a no-effort model (Haiku 4.5) stores none. The update path honours the published exception: an unchanged `id` keeps the stored effort on an omitted-effort update, a changed `id` resets to the new model's default. `extended` speed and `model_config` remain local extensions. |
| `model.speed` | Executed on the Anthropic provider when the model supports it: `fast` is sent as `speed: "fast"` and the provider attaches the `fast-mode-2026-02-01` beta. The capability table (`src/model/anthropic-capabilities.ts`) holds the published fast-mode list — Opus 5.5, Opus 5, Opus 4.8 — and `fast` on a listed model that cannot take it is refused at create/update with `unsupported_model_speed` rather than stored and silently degraded. `standard` and the local `extended` produce no wire field. A model id the table does not know is accepted and sends nothing. |
| `model.effort` | Parsed, validated, stored in the model profile, and returned by every read projection (agent, version, and session snapshot). On the Anthropic provider the level reaches the request as `output_config.effort` — capability-gated per level, because the published lists are not uniform (Opus 4.6 and Sonnet 4.6 take `max` but not `xhigh`; Opus 4.5 tops out at `high`; Haiku 4.5 takes no effort). A listed model refused its level fails create/update with `unsupported_model_effort` naming the allowed set; a level outside the published vocabulary is `invalid_model_effort`. Models outside the table, and every non-Anthropic provider, accept the field and send nothing. A deployment may also set `reasoning_effort` in its own model settings — operator-level, applying to the model rather than to an agent. |
| `model.inference_geo` | Refused by name with `unsupported_model_field` when a well-formed pin is sent: this runtime has no inference-geography control, so accepting it would promise a pin it cannot hold. An unknown value is `invalid_inference_geo` first. |
| `multiagent` block | `{"type":"coordinator"}` is accepted and normalized to `delegations` (ids resolved to names at write, `version` resolved to latest, `{type:"self"}` → `enable_general_subagent`, `multiagent: null` clears a coordinator-produced roster). Every other `type` or member — `multiagent_20261001`, `advisor`, `workflows`, `subagents`, `inline_agents` — is refused by name with capability `multiagent-roster` on create and update, and a coordinator block that breaks a published bound (1–20 entries, a recognized entry form, no extra keys) is refused with the coordinator rule named. See [`threads.md`](./threads.md). |
| `max_turns` | Local extension, not a published field: the published model counts turns client-side, so no server cap exists there. Here it is a positive-integer server-side turn limit validated on create and update, stored on the definition, executed by the builtin strategy (agent value, else the workspace `default_max_steps`), and echoed on every agent projection. It is absent — never `null` — on definitions that do not set it. |
| Local delegation extension | `delegations` plus `enable_general_subagent` is a local one-level parent/child mechanism with its own tool names (`delegate_to_<name>`, `general_subagent`). The published contract defines neither field, and this is not presented as the canonical roster. |
| Version retention | SandBase keeps prior agent versions readable in its own archive table. The published contract states versioning but not the retention mechanism. |
| Unknown create fields | The create schema is not strict, so a field neither the schema nor an explicit check declares is dropped rather than refused. The fields that matter — `multiagent` and the model profile — have explicit checks; a general unknown-field refusal is not part of this contract. |

## 5. Reason for the difference

- A local provider has no inference geography, so executing an `inference_geo`
  pin would mean inventing semantics. Refusing it by name tells the caller the
  field was understood and cannot take effect, which is the only answer they can
  act on.
- The save-time `effort` default is written onto the definition, not applied
  at read or request time: the published service resolves per-model defaults
  into the stored object, so filling at save makes the local definition
  self-describing the same way — a session snapshot then carries the level the
  runtime actually executes rather than whatever the provider happened to fall
  back to. The table is sourced from the published effort page (`medium` on
  Opus 5.5 and Haiku 5.5, `high` on every other effort-capable model); a model
  that page does not cover is deliberately given no invented level, because a
  stored default the docs do not name would be a guess dressed as the model's
  own contract. The update path follows the published exception rather than
  whole-object replacement for `effort` alone: an unchanged `id` keeps its
  stored level, a changed `id` resets to the new model's default — the same
  rule the official docs spell out, applied at the merge boundary where the
  stored value is still in hand.
- `effort` is executed on Anthropic and retained elsewhere rather than
  refused: the canonical request shape carries it, so a definition keeps the
  value even where it cannot take effect — a field that is stored and never
  returned is the silent loss this profile exists to prevent. On a known model
  the runtime can prove a level does nothing — `xhigh` on Sonnet 4.6, any
  effort on Haiku 4.5 — so that combination is refused at admission; on a
  model id the capability table does not know it cannot prove anything, so the
  value is kept and simply not sent. An agent override refuses `effort` on
  every model: the published contract says a level set on a session override
  does not take effect, so accepting one there would promise execution the
  contract itself rules out.
- Adaptive thinking is runtime-selected rather than caller-configured: the
  published agent contract has no thinking field, so the runtime sends
  `thinking: {type: "adaptive", display: "omitted"}` for the models that
  support it and nothing for the rest. `omitted` keeps thinking content out of
  the response, matching the policy of never persisting reasoning traces.
- The `multiagent` block is a substantial protocol surface (threads, subagent
  delegation, dynamic workflows, advisor consultations). The one member
  upstream self-hosted itself accepts — the delegation-only `coordinator` —
  maps honestly onto the local delegation mechanism: its `agents` list is a
  predefined-agent roster, `delegations` is the runtime's roster field, and
  the one-level rule is enforced through the coordinator provenance marker.
  Refusing *that* shape would refuse the one multiagent form a self-hosted
  SDK caller can actually send. Every other shape is still refused rather
  than stored and ignored, because accepting `multiagent_20261001` or an
  `advisor` would let a caller build on delegation, workflow runs, or
  consultations that never happen.
- The local delegation fields are documented in the contract rather than hidden,
  because a caller reading only the published contract would otherwise not know
  how to reach the one delegation mechanism this runtime has.

## 6. Corresponding tests

- `tests/conformance/agent-model-response.test.ts` — official and local SDK reads,
  round-trip object effort, versions, frozen snapshots, update events and archive.

- `tests/conformance/agent-optional-system.test.ts` — the pinned official SDK
  creates and reads agents with omitted, null, and empty prompts over HTTP;
  updates retain an omitted prompt and clear it explicitly.

- `tests/conformance/doc-curl-examples.test.ts` — the agent-setup bodies
  replayed verbatim through `?beta=true`: the `agent_toolset_20260401` create
  reading back the published object, and the `inference_geo` doc pin refused
  by name rather than stored.

- `tests/integration/api.test.ts` — agent create/list/read/version behaviour and
  toolset rejection cases.
- `tests/unit/schema-validator.test.ts` — the declaration bounds: the
  `mcp_servers` 20-server cap, the 1–255 server-name bound on both union arms,
  and the 2,048-character url bound.
- `tests/unit/agent-model-object.test.ts` — the model object profile: each
  field's acceptance or refusal, `effort` carried through validation into the
  profile, and `inference_geo` refused by name.
- `tests/unit/anthropic-model-options.test.ts` — the capability table's
  per-level facts and prefix resolution; the `providerOptions` builder's
  gating; and admission refusing `fast` on a non-fast-mode model, an
  unsupported level, and any effort on an effort-less model, through both the
  `model` object and the `model_config` spelling.
- `tests/integration/anthropic-model-options.test.ts` — a real Anthropic-shaped
  turn carries `output_config.effort`, `speed`, the fast-mode beta header, and
  adaptive thinking for a capable model; a listed model that takes none and an
  unknown model id both send none.
- `tests/integration/agent-effort-default.test.ts` — the save-time default
  fill: `medium` on Opus 5.5, `high` on a default-to-high model, explicit
  `effort` winning, no invented level on an unknown or no-effort model, the
  session snapshot carrying the filled level, and the update rule's
  unchanged-id preserve / changed-id reset.
- `tests/integration/agent-effort-echo.test.ts` — the two halves of
  stored-and-echoed on a provider with no effort parameter: an agent read, the
  version listing, a session's frozen snapshot, and the session list all
  return the level; an update that changes only another field keeps it and
  repairs a definition still carrying it as a sibling; and a real turn for a
  definition carrying `effort: "max"` sends an OpenAI-compatible provider
  request without it.
- `tests/integration/agent-update-contract.test.ts` — the unified partial-update
  semantics, the unknown-field refusal, the roster refusal on the update path,
  and both spellings of the concurrency precondition including the published
  update example's body over the published verb.
- `tests/integration/agent-roster-refusal.test.ts` — the create path's roster
  refusal before anything is persisted, the same refusal on update, and the
  acceptance of the local `enable_general_subagent` extension on both paths.
- `tests/unit/web-tool-policy.test.ts` — per-tool web configuration validation.

## 7. Status

`supported` for agent CRUD and toolset validation. `partial` overall for the
model object profile: `effort` and `speed` are executed on the Anthropic
provider under the capability table — with admission refusing what a listed
model cannot take — and stored-not-sent elsewhere, while `inference_geo` is
refused rather than honoured. The canonical
`multiagent` block is split: the delegation-only `{"type":"coordinator"}`
subset is accepted and normalized to `delegations` under
`threads-and-coordinator` (recorded `partial` in
[`threads.md`](./threads.md)), while `multiagent-roster` stays `unavailable`
for `multiagent_20261001`, `advisor`, `workflows`, `subagents`, and
`inline_agents` — in scope under
[decision 0002](../../decisions/0002-cma-multiagent-parity.md); the local delegation
extension is `supported` and is recorded as an extension, never as the
published multiagent surface.
