# CMA Contract — agents

Contract area: `/v1/agents` — agent definitions, model profile, toolsets.
Status: `supported` for CRUD; `partial` for the model object profile; the
canonical `multiagent` roster is `unavailable` and the local delegation
extension is separate. See §4.
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
- An agent may declare a `multiagent` roster describing other agents it can
  delegate to.
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
- The stored model profile is returned on every read — the agent read, the
  version listing, and a session's frozen snapshot — as `model_config`
  (`id`, `speed`, and `effort` when one was set). It is omitted for the ordinary
  case (the local `standard` speed and no `effort`), so a plain model id looks
  the same as it always did. `effort` is echoed and not executed: the provider
  model is resolved from the id string, so no request changes because of the
  level, which is why §4 records it as accepted-but-no-effect. When `model` is
  the object form it is authoritative — the profile comes from that object, and a
  `model_config` sent beside it is ignored rather than merged, which is the
  precedence the update rule already relies on.
- Toolsets (`builtin` / `custom` / `mcp` / `skill`) are validated against a Zod
  schema before an agent is persisted; a definition that fails validation is
  rejected instead of being stored partially.
- `web_tool.configuration` is fully validated (domain grammar, allowed/blocked
  exclusivity, empty-list rejection). See [`tools.md`](./tools.md).
- The update precondition is accepted under both names: `version` is the
  published spelling and `expected_version` is the local one. The published
  contract says the field is optional, that supplying it gives optimistic
  concurrency control with a `409` on a mismatch, and that omitting it applies
  the update unconditionally; that is exactly the local behaviour, so only the
  name differs. Both are read, and sending both with different values is refused
  rather than resolved by precedence.
- A canonical `multiagent` roster is **refused by name** on both write paths. An
  agent's create path checks the caller's own payload in
  `validateAgentDefinition`, because the Zod schema strips keys it does not
  declare and a stripped roster would answer 201 while doing nothing. The update
  path special-cases the key in `validateAgentUpdateRequest` so both answers are
  identical. Both name the capability `multiagent-roster` and point at the local
  extension.
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
| `model.speed` | Accepted and stored as the local config spelling; `fast` / `standard` / `extended` are local vocabulary. |
| `model.effort` | Parsed, validated, stored in the model profile, and returned by every read projection (agent, version, and session snapshot). It does not change the provider request: the model is resolved from the id, so the level has no path into a request. A deployment may set `reasoning_effort` in its own model settings, and that is operator-level — it applies to the model, not to an agent or a session. Recorded as accepted-but-no-effect rather than as executed. A level outside the published set is refused rather than stored. |
| `model.inference_geo` | Refused by name with `unsupported_model_field` when a well-formed pin is sent: this runtime has no inference-geography control, so accepting it would promise a pin it cannot hold. An unknown value is `invalid_inference_geo` first. |
| `multiagent` roster | Refused by name on create and update (capability `multiagent-roster`) because no thread, coordinator, or advisor surface exists. The published roster is not implemented. See [`threads.md`](./threads.md). |
| Local delegation extension | `delegations` plus `enable_general_subagent` is a local one-level parent/child mechanism with its own tool names (`delegate_to_<name>`, `general_subagent`). The published contract defines neither field, and this is not presented as the canonical roster. |
| Version retention | SandBase keeps prior agent versions readable in its own archive table. The published contract states versioning but not the retention mechanism. |
| Unknown create fields | The create schema is not strict, so a field neither the schema nor an explicit check declares is dropped rather than refused. The fields that matter — `multiagent` and the model profile — have explicit checks; a general unknown-field refusal is not part of this contract. |

## 5. Reason for the difference

- A local provider has no inference geography, so executing an `inference_geo`
  pin would mean inventing semantics. Refusing it by name tells the caller the
  field was understood and cannot take effect, which is the only answer they can
  act on.
- `effort` is retained rather than refused because the canonical request shape
  carries it and the value is worth preserving for a provider that can use it
  later; it is echoed on every read — a field that is stored and never returned
  is the silent loss this profile exists to prevent — and it is recorded as
  having no effect today so no caller infers a quality change from it. An agent
  override refuses it for the same reason the definition keeps it: a level set on
  a session would reach no request, so accepting one there would promise execution
  the runtime has no path for.
- The `multiagent` roster is a substantial protocol surface (threads,
  coordinator role, advisor role). Mapping a local delegation helper onto it
  would overstate coverage, and accepting the field would let a caller build on
  delegation by roster that never happens. Refusing it is the only answer that
  cannot be misread.
- The local delegation fields are documented in the contract rather than hidden,
  because a caller reading only the published contract would otherwise not know
  how to reach the one delegation mechanism this runtime has.

## 6. Corresponding tests

- `tests/conformance/agent-optional-system.test.ts` — the pinned official SDK
  creates and reads agents with omitted, null, and empty prompts over HTTP;
  updates retain an omitted prompt and clear it explicitly.

- `tests/integration/api.test.ts` — agent create/list/read/version behaviour and
  toolset rejection cases.
- `tests/unit/agent-model-object.test.ts` — the model object profile: each
  field's acceptance or refusal, `effort` carried through validation into the
  profile and reported as accepted-but-no-effect, and `inference_geo` refused by
  name.
- `tests/integration/agent-effort-echo.test.ts` — the two halves of
  accepted-but-no-effect: an agent read, the version listing, a session's frozen
  snapshot, and the session list all return the level; an update that changes only
  another field keeps it and repairs a definition still carrying it as a sibling;
  and a real turn for a definition carrying `effort: "max"` sends a provider
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

`supported` for agent CRUD and toolset validation. `partial` overall, because
the model object profile is understood but partly unexecuted: `effort` is
accepted and returned on read but has no effect on the provider request, and
`inference_geo` is refused rather than honoured. The canonical
`multiagent` roster is `unavailable` and refused by name; the local delegation
extension is `supported` and is recorded as an extension, never as the roster.
