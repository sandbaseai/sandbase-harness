# CMA Contract — sessions

Contract area: `/v1/sessions` — lifecycle, status transitions, initial events,
resources, budget.
Status: `supported` for lifecycle, initial events, and the declared-outcome loop;
`partial` for session update (`vault_ids` is a named refusal, not an accepted
field).
The session budget is a separate contract area with its own status and is not
claimed here; see `budget.md`.
Source: `src/api/routes/sessions.ts`, `src/api/routes/initial-events.ts`,
`src/api/routes/session-normalizers.ts`, `src/api/standard.ts`,
`src/core/agent/overrides.ts`, `src/core/session/session-manager.ts`.

<!-- capability-status
session-lifecycle: supported
initial-events: supported
outcome-grading: supported
session-update: partial
-->

---

## 1. Official definition

- A session runs one agent against one environment. It is created, may be
  resumed, interrupted, and terminated.
- `POST /v1/sessions` accepts optional `initial_events` processed at creation,
  so a session can start with work already queued.
- The `agent` field accepts three forms: an id string (the agent's current
  version), an object with an optional `version` (a pinned version), and
  `agent_with_overrides`, which runs a pinned or current version with part of
  its configuration replaced for this session only.
- An override is per-field and never merges: an omitted field is inherited from
  the referenced agent version, `null` (or `[]` for a list) clears it for this
  session, and any other value replaces it wholesale. Overriding a field does
  not modify the agent and does not create a version.
- Session status is one of `idle`, `running`, `rescheduling`, or `terminated`.
  Waiting for approval or a custom tool result is `idle`; the matching
  `session.status_idle` event identifies the pending action in `stop_reason`.
- `POST /v1/sessions/{id}` patches a session in place: `agent` admits only a
  `tools`/`mcp_servers` replacement, `metadata` merges with `null` per key as
  removal, `title` replaces, and a `session.updated` event reports the fields
  that changed.
- The session object carries `budget` in every state — the ceiling or `null` —
  a `stats` object with `active_seconds` and `duration_seconds`, and a
  materialized `agent` whose `version` pins the snapshot the session runs and
  whose `multiagent` resolves the roster or is `null`.
- The session-scoped event stream is the canonical way to observe progress.

## 2. Current SandBase shape

The published `user.interrupt` event interrupts active processing and leaves the
session resumable at `idle`; the session operations guide requires that state
before changing, archiving, or deleting a running session. The local
`POST /v1/sessions/{id}/stop` alias has the same interruption semantics and waits
for the execution chain to drain before returning the full session envelope.
Successful interruption reports `end_turn` and retains the sandbox. An idle
session is unchanged, even while awaiting approval; already terminal sessions
return `409` without mutation or cleanup. This local alias is deprecated,
retained for one version, and removed in the next version. It is not a published
SDK operation. Pi closes the interrupted child and starts another on the next
turn in the same sandbox. Unconfirmed child-tree cleanup retains the existing
fail-closed `cleanup_pending` state instead of claiming the workspace is safe.

`POST /v1/sessions/{id}/archive` records `archived_at` and returns the session
object. An idle session is projected to `terminated`, emits
`session.status_terminated`, and releases its sandbox; a running session returns
`409` with `session_running` and must be interrupted first. Archiving is
idempotent, and an already terminal session keeps its existing internal status
and event log while receiving the archive timestamp. Reads remain available;
new events and messages return `409` with `session_archived`. The session list's
`include_archived` behavior belongs to the later session-list work package.

`POST /v1/sessions/{id}` patches a session in place and returns the session
object. `agent` admits only `tools` and `mcp_servers`, both replacing wholesale
rather than merging; the patch is applied to the definition the session
currently resolves — its own snapshot when it has one, the current durable
agent definition when it follows one — and the merged result is validated
against the same schema as agent creation, including the `mcp_toolset` /
`mcp_servers` cross-check, before it is materialized as `agent_definition`.
The agent row and its version list are never touched. `metadata` is a merge
patch: a `null` value removes its key, `null` for the whole field is no
change, and an empty resulting bag is stored as empty. `title` replaces and
`null` clears it. `budget` moves the session's ceiling under the budget
contract's rules — an object replaces it, `null` removes it, and the move is
allowed in any non-terminal state because it only changes what the next model
request may spend; the refusal codes (`budget_create_only`,
`budget_not_raised`, `model_not_budgetable`, and the `budget_invalid_*`
family) belong to [`budget.md`](./budget.md). `vault_ids` is refused with
`vault_ids_not_updatable`, any other `agent` field with
`agent_field_not_updatable`, and an unknown top-level field with
`invalid_request_error`. An `agent` change additionally needs an externally
idle session: a running one returns `409` with `session_not_idle` and must be
interrupted first, while `title`, `metadata`, and `budget` move in any
non-terminal state. Terminated or archived sessions return `409` with
`session_terminated`.
All admitted changes land in one transaction together with exactly one
`session.updated` event, which carries only the fields that changed — the
full materialized agent snapshot under `agent`, the new ceiling or `null`
under `budget`, the whole post-update
metadata bag under `metadata` (absent when the update cleared it), and the
new `title` — and a request that changes nothing emits no event. The payload
is persisted through the metadata carrier (`metadata.session_updated`) and
projected back to the documented top-level fields, on the same route as
`session.usage`. The new configuration applies from the next turn: the
session's MCP connections are torn down so they reconnect against the updated
definition and its tool admission rule.

The session object itself always carries `budget` — the ceiling, or `null` in
both the never-set and removed states, which the published shape does not
distinguish — and a `stats` object: `active_seconds` sums the session's
`running` intervals from the event log (the list route derives it from one
bulk status-transition query rather than a full event read per row), and
`duration_seconds` counts from creation to the last update for a terminated
or archived session and to the read for a live one. The materialized `agent`
pins `version` to the session snapshot and reports `multiagent: null` — a
declared roster is refused by name, so a populated value can never appear.
`outcome_evaluations` is derived from the event log on every read path: one
entry per `user.define_outcome`, in declaration order, reporting `pending`,
`running`, or `evaluating` while in progress and the terminal end-span verdict
once closed (see *Declared outcome evaluation* below). The list route derives
it from one bulk query over the outcome and status events rather than a full
event read per row. `loop_engine` remains on the object as a local extension.

`DELETE /v1/sessions/{id}` permanently removes the session row, event history,
session-owned resources, snapshots, and generated files. It returns
`{id, type: "session_deleted"}`; an active `running` session returns `409` with
`session_running` and must be interrupted to `idle` first. User-uploaded files
are retained but are no longer scoped to the deleted session. A live event stream
writes its final `session.deleted` event and then closes; deleted sessions are no
longer retrievable or readable through their event endpoint.

The routes are `src/api/routes/sessions.ts` with
`src/api/routes/initial-events.ts` and `src/api/routes/session-normalizers.ts`;
the lifecycle and the outcome loop live in `src/core/session/session-manager.ts`;
override resolution is `src/core/agent/overrides.ts`; the wire projection is
`src/api/standard.ts`.

Status projection (`STATUS_PROJECTION` in
`src/core/session/session-lifecycle.ts`, shared by `toApiSessionStatus` and
`eventTypeForStatus`):

| Internal | API status | Lifecycle event | Terminal |
| --- | --- | --- | --- |
| `queued` | `idle` | None | No |
| `running` | `running` | `session.status_running` | No |
| `retrying` | `rescheduling` | `session.status_rescheduled` | No |
| `paused` | `idle` | `session.status_idle` | No |
| `requires_action` | `idle` | `session.status_idle` | No |
| `completed` | `terminated` | `session.status_terminated` | Yes |
| `failed` | `terminated` | `session.status_terminated` | Yes |
| `cancelled` | `terminated` | `session.status_terminated` | Yes |
| `timed_out` | `terminated` | `session.status_terminated` | Yes |
| `cleanup_pending` | `terminated` | `session.status_terminated` | Yes |
| `archived` | `terminated` | `session.status_terminated` | Yes |

`rescheduling` is emitted by the internal `retrying` state: a model request
that fails with a transient provider error (429, a 5xx server error, 529
overloaded, or a transport timeout) is retried by the registry's middleware
under the published backoff — the first scheduled wait in a turn writes
`session.error{retry_status: {type: 'retrying'}}` and `session.status_rescheduled`,
a recovered request writes `session.status_running`, and a policy that gives up
writes `session.error{retry_status: {type: 'exhausted'}}` and idles with
`stop_reason: {type: 'retries_exhausted'}` rather than terminating. A
`user.interrupt` during the backoff ends the wait and idles with `end_turn`.
`GET /v1/sessions` takes
the published parameter set: `limit` and the `page` cursor, `order` (`asc` or
`desc` by `created_at`, default `desc`), `agent_id` with an `agent_version`
that applies only beside it, `include_archived` (archived rows are excluded
otherwise), `memory_store_id` (sessions holding a live `memory_store` resource
with that id), `deployment_id` (sessions created by that scheduled
deployment), a repeatable `statuses` filter — the SDK's `statuses[]` spelling
is accepted too — whose every value must be one of the published four and
which selects all internal states in each requested public group, and
`created_at[gt|gte|lt|lte]` bounds. A value outside the published set, an
unparseable timestamp, or any other parameter is a `400` by name; the former
local `status` parameter is gone, so a filter on internally `failed` sessions
is expressed as `statuses=terminated`. A `page` cursor binds the `order` and
the `created_at[*]` window it was issued under — replaying either differently
is a `400` — while every other filter may change freely across a replay.
Terminal sessions, including `failed`, reject new
messages and events with `409` before input persistence or execution. Fixable
model-configuration errors that already leave a session `paused` remain
resumable; this does not revive a `failed` session.

The session-level `stop_reason` (`toApiEvent`):

- A `session.status_idle` event carries the session-level reason as an **object
  at the top level**, which is where the published client reads it:
  `select(.type == "session.status_idle") | .stop_reason.type`. The published
  loop uses that value to choose between answering a blocking call and stopping.
- It is persisted in the generic metadata carrier (`lifecycleMetadataFor` writes
  `metadata.stop_reason`), so the projection lifts it and `metadata` keeps it —
  this is a projection, not a move. `src/api/routes/runs.ts` reads the persisted
  path to choose between a `202` with `wait_deadline_reached` and a terminal
  body, and that reader is unaffected.
- `type` is `requires_action` when the session is waiting for a tool
  confirmation or for a custom tool result, and `end_turn` when it paused with
  nothing outstanding. An interrupt reports `end_turn` too: the published
  contract states there is no dedicated interrupt reason, so no separate value is
  invented here.
- `event_ids` names the parked calls by their own **event** id — the `id` the
  event listing reports for that event. Both parked-work families are included,
  because the published contract parks them the same way: an approval-gated
  `agent.tool_use` / `agent.mcp_tool_use`, and an `agent.custom_tool_use` the
  caller has not answered. That is the address the published client sends back,
  so the two halves of the exchange agree. Resolution is still tracked by the
  `tool_use` **block** id, because a tool result pairs to its call by tool-call
  id, so a call that already has a result is excluded even though the array
  reports event ids.
- The object carries exactly the published shape, `{ type, event_ids }`. It
  previously also carried `action_type`, a local field absent from the published
  contract and read by nothing; with both families able to be parked at once no
  single value of it was true, so it is no longer written.
- A `user.tool_confirmation` may address an approval-gated call by that event id
  **or** by the `tool_use` block id, and a `user.custom_tool_result` may address
  a custom tool call the same two ways. The block id is in both cases a
  documented local fallback, kept because this runtime's own callers and tests
  answer with one; widening which identifier *selects* the call does not widen
  authority, since the pending check and the one-shot resolution still decide
  whether anything runs. Whichever arrives, the confirmation event's
  `metadata.tool_use_id`, the `agent.tool_result` appended for a decision, and the
  result's `metadata.custom_tool_use_id` all carry the **block** id, and a second
  answer for one call is refused whichever spelling it uses.
- **The resume turn starts only once nothing is parked.** Each answer is recorded
  as it arrives and the session stays in `requires_action` while any call is
  still waiting, so the published client's loop — one answer per entry of
  `event_ids`, in turn — works as written and the last answer is what starts the
  turn. Starting it earlier would carry a tool call with no result, which
  providers refuse with `Tool result is missing for tool call <id>`, terminating
  a session over a documented answer. The gate and the `event_ids` array are one
  definition (`src/core/session/parked-calls.ts`), so "the array is non-empty" and
  "no turn may start" cannot disagree.
- **The wait is unbounded unless an operator bounds it.** By default a parked
  session waits exactly as the published contract says — indefinitely — and
  nothing about that path changes. An operator may set
  `loop_engine.options.requires_action_timeout_seconds`, and a session parked
  longer than that is ended with a `session.error` carrying
  `requires_action_timeout`, reaching `timed_out` (published as
  `session.status_terminated`). The bound is measured from the event that parked
  the session, not from when a sweep noticed it. The parked calls are **not**
  answered: the session stops waiting, and nobody decides on the caller's behalf
  what the tools returned. The setting is a local extension and §4 records it.
- An idle event whose metadata carries no `stop_reason` omits the top-level field
  rather than sending `null`.
- Model-derived events keep the provider's `stop_reason` **string** from the
  `events.stop_reason` column. The two shapes share the field name because both
  published shapes spell it `stop_reason`; they are distinguished by event type
  and a status event has no model response behind it.

`initial_events`:

- At most 50 events (`MAX_INITIAL_EVENTS`).
- Only `user.message` and `user.define_outcome` are accepted; any other type is
  rejected with `invalid_initial_event_type` and names the offending index.
- `user.message` requires a string or content-block array; a malformed payload
  is rejected rather than coerced.
- `user.define_outcome` requires a `description` and a `rubric`, which is either
  `{type: "text", content}` or `{type: "file", file_id}`; `max_iterations` defaults to
  3 and is rejected outside 1..20 rather than clamped. A malformed payload is reported
  as `invalid_initial_events` with the index and the offending field. The admitted
  event is normalized, so the log holds the default rather than an absent budget.
- The creation response deliberately does not echo `initial_events`: the events
  are observable on the session's own event stream, and echoing them would
  suggest they are session state rather than accepted input.
- Creation is one local transaction: the session row, its resource attachments,
  and the delivery of every `initial_events` entry are wrapped together, so an
  event rejected at admission rolls the whole creation back. The alternative —
  creating the session first and then admitting events — would leave a
  half-created session with no durable record of which events were accepted, and
  a caller retrying would have no way to tell whether the first attempt partly
  took effect.

Session resources:

- Attached at creation from the canonical `resources` array.
- Resource instances carry their own `sesrsc_` id and support lifecycle
  operations. See `files.md` and `credentials.md`.

Session agent reference (`agent_with_overrides`):

- The overridable fields are exactly `model`, `system`, `tools`, `mcp_servers`
  and `skills`. Any other field in the object is refused with
  `invalid_agent_overrides` rather than ignored, because a caller that sends one
  believes it changed how the session runs.
- A session created with overrides stores the resolved configuration as its own
  snapshot (`sessions.agent_definition`, the same column a version pin uses),
  and that snapshot is what the loop reads. `agent_id` and `agent_version` keep
  pointing at the agent and version the session was derived from, and the agent
  row and its version list are untouched.
- Capability admission and the Pi agent policy judge the resolved configuration,
  not the base agent, so an override cannot pass a gate on the agent and then
  execute with a tool or model set the gate never saw.
- Four refusals, each a code-carrying 400 reported before the session row
  exists, so a refused override creates nothing:
  - `agent_model_required` — `model: null`; a session always needs a model;
  - `agent_tools_cleared_with_skills` — `tools` cleared (null or `[]`) while the
    effective `skills` is non-empty, because skills need the `read` tool;
  - `agent_mcp_server_not_found` — the resolved definition binds an
    `mcp_toolset` to a server the effective `mcp_servers` does not declare;
  - `invalid_agent_override_field` (malformed field, named in the message) and
    `invalid_agent_overrides` (unknown field). A malformed `model` keeps the
    model profile's own codes (`invalid_model`, `invalid_model_speed`,
    `unsupported_model_field`), the same ones the agent definition path
    publishes for that field.
- A `model` override replaces the whole model object: the agent's own `effort`
  is not inherited, and an `effort` inside the override is refused (see §4). A
  session that replaces only other fields reports the agent's profile, level
  included; the one that switches model reports the replacement profile, which
  carries no level — the agent's is not inherited, and no model-to-level mapping
  exists to supply one.
- A malformed reference is refused with `invalid_agent_ref` and an absent one
  with `agent_required`, so "malformed" and "missing" are distinguishable.
- `POST /v1/runs` accepts only the two pinning forms: the override form is
  refused there with a 400 naming the reason, rather than accepted and ignored.

Declared outcome evaluation:

- A `user.define_outcome` event is an instruction as well as a record: its
  `description` and rubric project into the turn's context, so the queued turn
  works against declared criteria. A `{type: "file"}` rubric names its file
  rather than inlining it. Admission assigns the outcome its `outc_` id and
  persists it on the event itself, so the published event carries a top-level
  `outcome_id` and every `span.outcome_evaluation_*` the loop appends
  references the same value.
- The session object's `outcome_evaluations` reports one entry per
  declaration, joined on that id: `description` from the event;
  `iteration`, `result`, `explanation`, and `completed_at` from the last
  matching `span.outcome_evaluation_end`. Before any end the entry reports
  `evaluating` while a start or ongoing span is open, `running` once the
  declaration's own turn began, and `pending` otherwise — `needs_revision` is
  a span verdict, not a resource state, so it never appears as `result`.
- Once that turn completes, the runtime appends
  `span.outcome_evaluation_start`, `span.outcome_evaluation_ongoing` and
  `span.outcome_evaluation_end`, and the end event carries the verdict
  (`satisfied | needs_revision | failed`), an explanation and the id of the start
  event it closes. See `events.md` for the payloads.
- The grader runs in its own context window over what the agent produced: its
  messages, tool calls and their results. The system prompt, the session's
  lifecycle events, the outcome instruction and any earlier verdict are excluded,
  so an evaluation is not anchored to the runtime's scaffolding or to its own
  previous answer.
- The rubric comes from the declared outcome: inline text is used directly and a
  file rubric is read from the upload the Files API stored. A rubric file that
  cannot be read refuses the evaluation with `outcome_rubric_file_not_found`
  rather than grading against an empty rubric.
- A grader that cannot run — no model provider configured — closes the end event
  as `failed` and surfaces `session.error` with code
  `outcome_evaluator_unavailable` and `retry_status: { "type": "terminal" }`. The
  evaluation is never silently skipped: an ungraded outcome and a failed outcome
  would otherwise be indistinguishable to a client.
- A turn that threw is not graded, and the end event is appended on every path so
  a client waiting on `span.outcome_evaluation_end` cannot hang.
- A `needs_revision` verdict starts another iteration: the explanation is appended
  as a real `user.message` and a further turn runs inside the same outcome, so the
  revision is visible in the log and the next turn reads its context from it. The
  loop stops at the first `satisfied` or `failed`, at the declared `max_iterations`
  (the last allowed evaluation reports `max_iterations_reached` and the agent still
  gets one final turn to settle its answer), when the session is interrupted, or
  when the session reaches the spending ceiling it declared. An interrupt closes the
  outcome as `interrupted`; a spent ceiling closes it as `budget_reached`, which is
  the code admission refuses the next work-starting event with. Neither records a
  `session.error`. A re-declared outcome on the same session is graded again, under
  a new `outcome_id`.
- A runtime that composes no grader refuses `user.define_outcome` at admission
  with `outcome_grader_unavailable` (400) on both ingress paths, rather than
  accepting an outcome it can never evaluate.

## 3. Alignment

Aligned for: lifecycle endpoints, status vocabulary, initial event processing,
the 50-event ceiling, the initial event type whitelist, the three `agent`
reference forms, the tri-state override rule, session update (`agent` limited
to `tools`/`mcp_servers`, `metadata` merge patch, `title` replace), the
`session.updated` event carrying only the changed fields, the server-assigned
`outcome_id` on `user.define_outcome`, and the session object's published
fields: `budget` always present (`null` when there is no ceiling),
`stats.active_seconds`/`stats.duration_seconds`, `outcome_evaluations`
projected from the event log on create, retrieve, and list, and the
materialized `agent` with a pinned `version` and `multiagent: null`.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Session budget | Owned by [`budget.md`](./budget.md), which is `partial`. `/v1/sessions` accepts a `budget` at creation and echoes it back, and rejects a malformed one before the session is persisted; pricing and the ceiling rules are that contract's subject, not this one's. `POST /v1/sessions/{id}` moves it under that contract's rules and reports the change through `session.updated`. |
| `vault_ids` on update | Refused with `vault_ids_not_updatable` on `POST /v1/sessions/{id}`; the published parameter is reserved and the refusal keeps a caller from believing its bindings moved. |
| `loop_engine` on the object | Local extension with no published equivalent: the engine selection frozen at creation (`builtin` for legacy rows). It is additive and collides with no published field. |
| Creation response | `initial_events` is not echoed back. The published contract does not state whether the creation response echoes it. |
| Automatic rescheduling | Implemented for transient model failures: a retryable error schedules a wait, reports `session.status_rescheduled` (internal `retrying`), and either recovers to `running` or idles as `retries_exhausted` once the policy gives up. Retry counts and delays come from the local retry policy, not a published schedule. |
| `cleanup_pending` | Internal fail-closed state for local sandbox teardown, projected to public `terminated`; the event log retains the cleanup error. |
| Extension endpoints | Session inspection and control endpoints under `/v1/x` are local additions and are excluded from CMA admission. |
| Override refusal codes | `agent_model_required` is the published code for a cleared `model`. `agent_tools_cleared_with_skills`, `agent_mcp_server_not_found`, `invalid_agent_override_field`, `invalid_agent_overrides`, `invalid_agent_ref` and `agent_required` are SandBase spellings for the same conditions, published so a client can distinguish them without parsing prose. |
| `model.effort` in an override | Refused with `invalid_agent_override_field` rather than accepted and ignored. A definition retains `effort` and the read projection returns it — including a session's frozen snapshot, which reports the profile it resolved — but the provider model is resolved from the agent's model id, so a level set on a session would reach no request. Only a deployment's own `reasoning_effort` model setting reaches a provider, and that is operator-level. The refusal names the definition as where to set it. |
| MCP cross-check scope | The published exception covers clearing `mcp_servers`. Locally the same check runs on the resolved definition, so a `tools` override that binds an `mcp_toolset` to an undeclared server is refused with `agent_mcp_server_not_found` instead of persisting a toolset that silently does nothing. |
| Outcome grader is provider-backed | Grading runs through a model provider. With none configured the evaluation closes as `failed` and the session records `outcome_evaluator_unavailable` with `retry_status: { "type": "terminal" }` rather than reporting a verdict the runtime cannot produce. |
| No grader composed | `user.define_outcome` is refused at admission with `outcome_grader_unavailable` on both ingress paths, rather than accepted as an outcome the runtime can never evaluate. |
| Outcome iteration stopped for confirmation | A revision turn that stops for a tool confirmation ends the outcome as `interrupted`: the loop cannot drive another turn while the session waits for a human, and an outcome does not resume by itself. The published contract does not describe what a confirmation does to an outcome's iteration. |
| Outcome verdict at the spending ceiling | A session that spends its declared ceiling during an outcome closes it with `result: "budget_reached"` on the outcome's own end span, and the session itself idles with `stop_reason: budget_reached` until an accepted budget update resumes it. The ceiling is enforced between model requests and the loop's turns are not events, so the verdict is how a client learns why the iterations stopped; `budget.md` owns the ceiling itself. |
| Bounded parked wait | `loop_engine.options.requires_action_timeout_seconds` is a local runtime setting with no published equivalent, and the published contract states the opposite default: the session "会话会无限期等待响应" — it waits indefinitely (`权限策略.md:668`). The key is therefore absent unless an operator sets it, so the default path **is** the published behaviour, and it is offered on both loop engines because both can park. It is not reachable from an agent definition, so no agent can widen or remove its own bound. Two rules are local with it: the bound is measured from the event that parked the session rather than from when a sweep noticed it, and a `requires_action` session at its spending ceiling is never ended by it, because such a session waits on a settlement event the budget still accepts rather than on work it cannot pay for. |

## 5. Reason for the difference

- Session budget has its own contract file rather than a clause here. A ceiling is
  priced from an operator-supplied profile and enforced at event admission, so it
  changes what an accepted event is allowed to start — a session-ingress concern
  whose evidence is a refusal code, not a lifecycle transition.
- Not echoing `initial_events` avoids presenting accepted input as restatable
  session state; the event stream is the authoritative record.
- Internal `cleanup_pending` exists because local sandbox teardown is asynchronous
  and must not release a workspace until child-tree cleanup is proved. Its public
  status stays `terminated`, and its error details remain in the event log.
- Delete is logical because the event log is append-only by project rule: a
  physical delete would remove events a resumable stream or an audit may still
  read. Stopping a running session instead of refusing it keeps delete usable
  as the single cleanup call a local operator makes.
- An override that cannot be honoured is refused rather than repaired: a session
  that quietly ran the base agent after a caller asked for a different one is the
  failure the override exists to prevent, and the same reasoning makes an
  unexecutable `effort` a refusal instead of a no-op field.
- `loop_engine` stays on the object because the engine is a real, persisted
  property a local operator must be able to read; it is additive, so a client
  written against the published shape ignores it.
- The MCP cross-check runs on the resolved definition because the defect does not
  depend on which field introduced the binding. The agent definition path already
  refuses an undeclared server reference; letting an override reach the same state
  through the other field would be the same check applied to half the inputs.

## 6. Corresponding tests

- `tests/integration/api.test.ts` — session create/read/status cases, engine
  admission, and rejection of an unknown loop engine.
- `tests/unit/session-resource-instances.test.ts` — resource attach, list,
  delete, and the memory-store at-creation rule.
- `tests/unit/session-delete.test.ts` — permanent deletion, running-session
  refusal, session-owned file and snapshot cleanup, and all `session_id` child
  tables.
- `tests/integration/session-delete-log-position.test.ts` — the deleted session
  and its event history are no longer readable.
- `tests/integration/event-stream-subscription.test.ts` — a live stream closes
  after writing `session.deleted`.
- `tests/unit/session-archive.test.ts` and `tests/conformance/session-archive.test.ts` — archive
  state, idempotency, terminal-session handling, write refusal, and official SDK shape.
- `tests/unit/session-update.test.ts` and `tests/conformance/session-update.test.ts` — the
  update semantics: title replace/clear, the metadata merge patch including a cleared bag,
  snapshot materialization on a tools swap with the agent row untouched, the named refusals
  (`vault_ids`, `budget`, a non-tool `agent` field), idle admission for an agent change,
  no-op suppression of `session.updated`, and the published SDK update over HTTP.
- `tests/unit/agent-overrides.test.ts` — override parsing and resolution: the
  tri-state rule per field, the refusal codes, the cross-check on the resolved
  definition, and that the base definition is never mutated.
- `tests/integration/session-agent-overrides.test.ts` — the same behaviour over
  the wire: the override reaches the session's frozen snapshot while the durable
  agent and its version list stay untouched, a session without overrides keeps
  following the agent, every refusal is a code-carrying 400 that creates nothing,
  and `/v1/runs` refuses the override form.
- `tests/integration/outcome-grading.test.ts` — a declared outcome reaches the
  agent's context, the completed turn is graded, the span triple reaches the
  event log in order, and a runtime with no provider records
  `outcome_evaluator_unavailable` with `retry_status: { "type": "terminal" }`.
- `tests/unit/outcome-loop.test.ts` and `tests/integration/outcome-loop.test.ts` —
  the revision loop: a `needs_revision` verdict appended as a real `user.message`
  with the executor re-entered for it, the spent budget reported as
  `max_iterations_reached` with one final settling turn, an interrupt closing the
  outcome as `interrupted` with no `session.error` (including one that lands inside
  a revision turn and one that stops for a tool confirmation), a session that spends
  its declared ceiling closing the outcome as `budget_reached` without another
  grading pass or turn, and `outcome_grader_unavailable` as a 400 on both ingress
  paths with nothing written.
- `tests/unit/model-retry.test.ts` — retry classification by `statusCode` and
  message, the 1s/2s/4s backoff and `Retry-After`, observer notification
  order, and abort-aware waits.
- `tests/integration/session-rescheduling.test.ts` and
  `tests/conformance/session-rescheduling.test.ts` — the `rescheduling`
  lifecycle: `session.error(retrying)` before `session.status_rescheduled`,
  `session.status_running` on recovery, `exhausted` and `retries_exhausted` on
  policy exhaustion with the session still answering a later message, and
  `end_turn` when an interrupt aborts the wait — in-process and through the
  official SDK on a real runtime.
- `tests/unit/cma-event-contract.test.ts` — `initial_events` validation: the
  whitelist, the 50-event ceiling, the `user.define_outcome` defaulting and its
  rejection cases, and the projection that lifts the payload out of the metadata
  carrier.
- `tests/integration/define-outcome-event.test.ts` — the same contract over the
  wire: an initial outcome reaches the log and returns projected on the event
  listing, a live malformed outcome is refused with `invalid_define_outcome` while
  a valid one is stored, and a rejected creation leaves no session behind.
- `tests/integration/initial-events-transaction.test.ts` — the transaction
  boundary: a rejected initial event leaves no session row and no attached
  resource behind, a successful batch creates the session and delivers every
  event, and the events' order and `processed_at` reflect admission.
- `tests/integration/session-stop-reason.test.ts` — the projected session-level
  `stop_reason`: `stop_reason.type` readable at the top level of a real
  `requires_action` pause and of a paused session reporting `end_turn`, the
  persisted `metadata.stop_reason` path a `202` decision reads still resolving
  and agreeing with the projection, the provider's `stop_reason` string on a
  model event left untouched, no other event type gaining an object, and an idle
  event with no reason omitting the field rather than sending `null`.
- `tests/integration/approval-event-id.test.ts` — the event-id exchange both
  ways: `event_ids` naming the pending event's own id and not the block id, a
  decision sent with that event id executing the tool, the block id still
  accepted, the deny result and the confirmation metadata both recorded under the
  block id so the model-facing pairing survives, a second decision refused even
  when it uses the other spelling, an id naming neither refused, a resolved call
  not re-decidable by its event id, and the refusal surfacing as
  `400 invalid_request_error` over the real route.
- `tests/integration/custom-tool-event-id.test.ts` — the same exchange for the
  custom tool family: a parked `agent.custom_tool_use` listed by its event id, an
  answer naming it accepted and the model resumed with the paired result, the
  block-id spelling still accepted, the persisted `metadata.custom_tool_use_id`
  staying the block id, an answered call no longer listed while an unanswered one
  is kept, a second answer refused even when it uses the other spelling, an id
  naming nothing refused, and the projected object carrying exactly
  `{type, event_ids}` with no `action_type`.
- `tests/integration/resume-gate.test.ts` — the resume rule, on the real strategy
  and status transition: a partial answer to two custom calls, to a gated call
  with a custom call parked, and to a custom call with a gated call parked each
  leave the session in `requires_action` with no `session.error` and no turn,
  drop only the answered call from `event_ids`, and resume with everything paired
  once the last answer arrives; two gated calls in one confirmation group keep
  their existing behaviour; and a single parked call still resumes in one step.
- `tests/unit/parked-calls.test.ts` — the shared parked-set definition's own edge
  cases: both families and the MCP event types reported together in log order,
  an event id distinct from the block id in what is reported versus what resolves,
  resolution by each result kind regardless of order in the log, a result that
  answers a different call not resolving anything, an unconfirmed `tool_use`
  ignored, and a malformed or unrelated event ignored.
- `tests/unit/parked-wait.test.ts` — the bounded-wait rule: no bound configured
  means no expiry, a zero or negative bound is treated as none rather than as
  "expire now", the bound is measured from the oldest parked call, a session that
  is parked but not the parked status or that has nothing parked is kept, and a
  session at its ceiling is never expired.
- `tests/integration/parked-wait-timeout.test.ts` — the same rule on the real
  settings store, session manager and sweep: the default stays an indefinite
  wait; a bound configured through the settings store and activated ends a parked
  session with the coded `session.error` and the `timed_out` status; the parked
  calls are left unanswered; an already-expired session ends on the first pass;
  a gated call parks and expires the same way; a session at its ceiling is
  untouched and still accepts its `user.custom_tool_result`; several expired
  sessions end in one pass while an unexpired one stays; a second pass is a
  no-op; and a bound that was saved but never activated has no effect.
- `tests/unit/settings.test.ts` — the setting's document validation (accepted,
  refused by name when nonsensical, and not defaulted) and its publication in
  both engine descriptors with no default.
- `tests/integration/custom-tool-execution.test.ts` — the pre-existing closure
  path, unchanged: a custom tool call pauses the session and the caller's result,
  sent by block id, resumes the model with the paired tool result.
- `tests/unit/api-standard.test.ts` — the session object's published key set,
  compared against the `BetaManagedAgentsSession` field list transcribed from
  `@anthropic-ai/sdk@0.129.0` (only `loop_engine` may be extra), plus
  `budget` always present, `stats` timing, and `agent.version`/`multiagent`.
- `tests/conformance/session-object-fields.test.ts` — the same fields over the
  wire on create, retrieve, and list, `stats.active_seconds` derived from
  the status-transition log on both the single-session read and the bulk list
  path, and `outcome_evaluations` derived from the declaration and its end
  span on both read paths.
- `tests/unit/session-outcomes.test.ts` — the `outcome_evaluations` derivation
  itself: `pending`, `running`, `evaluating`, every terminal verdict,
  declaration order, the `needs_revision`-is-not-terminal rule, and the
  legacy-id claim for declarations persisted before `outcome_id` existed.
- `tests/integration/outcome-grading.test.ts` — the admission-assigned
  `outcome_id` joining the persisted declaration, its span triple, and the
  projected `outcome_evaluations` entry on a real grading run.
- `tests/conformance/session-outcome-evaluations.test.ts` — the official SDK
  reading `outcome_evaluations` end to end: one real outcome against the stub
  model, `satisfied` verdict, and the same `outc_` id on the declaration
  event and the session entry.
- `tests/integration/session-list-filters.test.ts` — every published list
  parameter over the real route: both `statuses` spellings and their
  validation, `order`, `include_archived`, `agent_id`/`agent_version`,
  `memory_store_id`, `deployment_id`, and the `created_at[*]` bounds.
- `tests/conformance/session-list.test.ts` — the official SDK's
  `sessions.list` driving `statuses[]`, `order`, `include_archived`, and
  cursor auto-pagination end to end.

## 7. Status

`supported` for lifecycle, status vocabulary, initial events, the `agent`
reference including `agent_with_overrides`, and the declared-outcome loop:
grading runs in its own context window over what the agent produced, a
`needs_revision` verdict is appended as a real `user.message` and re-enters the
executor, and the loop is bounded by the declared `max_iterations`. The session
object's published fields are emitted in full — `budget` always present,
`stats` derived from the event log, `outcome_evaluations` projected from the
declaration and evaluation spans on every read path, and the snapshot `agent`
carrying `version` and `multiagent: null`. Session
update is `supported` for `agent.tools`/`mcp_servers`, `metadata`, `title`,
and `budget` with `session.updated`; `vault_ids` on that route is a named
refusal rather than an accepted field, which the matrix records under the
session-update capability. The session budget is `partial` in its own
contract file, and this file does not claim it.
