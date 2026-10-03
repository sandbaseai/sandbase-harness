# CMA Contract — events

Contract area: the session event log — event domains, ordering, `processed_at`,
and `session.error`.
Status: `supported`.
Source: `src/api/standard.ts` (`toApiEvent`), `src/core/session/session-manager.ts`,
`src/core/session/session-error.ts`, `src/core/db/migrations.ts`.

<!-- capability-status
append-only-event-log: supported
processed-at-lifecycle: supported
session-error-structure: supported
error-enum-completeness: supported
-->

---

## 1. Official definition

- The event log is append-only. Events are never rewritten or removed.
- Events belong to domains: inbound user events, outbound agent events,
  lifecycle events, tool events, and system events.
- Inbound events carry `processed_at` once admitted, so a client can tell queued
  from handled.
- `session.error` carries a structured error object rather than a bare string.
- Evaluation of a declared outcome is observable as span events:
  `span.outcome_evaluation_start`, `span.outcome_evaluation_ongoing` and
  `span.outcome_evaluation_end`. The end event carries the verdict, so a client
  can distinguish "still being measured" from "measured, and this is the
  answer".

## 2. Current SandBase shape

The append path and the row shape are `src/core/session/session-manager.ts` and
`src/core/db/migrations.ts`; the wire projection is `toApiEvent` in
`src/api/standard.ts`.

- Every event carries a monotonically increasing per-session `seq`. Ordering is
  `created_at` with a `rowid` tiebreak, because `created_at` has second
  precision and two events in the same second must still order deterministically.
- Event payloads are stored in `events.metadata` and projected through
  `toApiEvent`, so a new field does not require a schema migration.
- `processed_at` is recorded once an inbound event is admitted.
- `session.error` carries a structured payload whose `error.type` is one of the
  eight official values, whose `error.retry_status` is the published
  `{type}` object, and whose `error.code` — a local extension — preserves the
  runtime's own error code so the classification stays official without losing
  the distinction a caller may need. Events persisted before this shape stored
  the local code in `type` and a string disposition in `retry_status`; the
  projection normalizes both on the way out (`retryable` → `retrying`, the
  other strings → `terminal`, the stored `type` reclassified and preserved as
  `code`). `src/core/session/session-error.ts` owns both directions.
- A tool event carries its payload in `content[0]` and also projects `name` and
  `input` to the top level for `agent.tool_use`, `agent.mcp_tool_use` and
  `agent.custom_tool_use`, `tool_use_id` for `agent.tool_result`, and
  `custom_tool_use_id` for `user.custom_tool_result`. The top-level `id` stays the
  persisted event id and `content` is unchanged; [`tools.md`](./tools.md) records
  why the two ids must not be conflated.
- `session.usage` is emitted before the session goes idle, so a client reading
  the stream observes usage before the terminal status.
- `session.status_idle` carries the session-level `stop_reason` **object at the
  top level**, which is where the published client reads
  `stop_reason.type` to choose between answering a blocking call and stopping. Its
  `event_ids` names the parked calls by their own event id — both the
  approval-gated `agent.tool_use` / `agent.mcp_tool_use` calls and the unanswered
  `agent.custom_tool_use` calls — and a `user.tool_confirmation` or
  `user.custom_tool_result` may address a call by that id, or by the local
  `tool_use` block id. The object is exactly the published `{type, event_ids}`. It
  is persisted in the metadata carrier and lifted by `toApiEvent`, so `metadata`
  keeps it too; a model-derived event keeps the provider's `stop_reason`
  **string** from the `events.stop_reason` column, and the two shapes are
  distinguished by event type. [`sessions.md`](./sessions.md) records both.
- The listed calls are exactly the ones still holding the turn back: while
  `event_ids` is non-empty no resume turn starts, and the turn starts when the
  last one is answered. Both the array and that gate read one definition
  (`src/core/session/parked-calls.ts`), so an entry can never name a call the
  gate is not waiting on, nor the gate wait on a call the array omits.
- When an operator has configured a bounded parked wait, that wait ends as a
  coded `session.error` (`requires_action_timeout`) plus the terminal `timed_out`
  status, which publishes `session.status_terminated` — the same pairing the Pi
  child's own timeout already used. The reason is the code, not the prose message.
  The event is appended once per session and the parked calls are left unanswered.
  With no bound configured — the default — none of this happens.
- One outcome evaluation appends exactly three events, in order, and the end
  event is appended on every path — including the one where the grader throws or
  cannot run, so a client waiting on it cannot hang on an outcome that is already
  over. Each carries `outcome_id` and `iteration` (`0` is the evaluation of the
  declared outcome, `n` the re-evaluation after the n-th revision). The end event
  adds `result`, `explanation`, and the id of the start event it closes. `result`
  is `satisfied | needs_revision | failed` after a grading pass,
  `max_iterations_reached` when the grader asked for a revision that the spent
  budget cannot run, and `budget_reached` when the session spent its ceiling before
  the loop could finish. The `ongoing` event carries no partial verdict: the grader's
  reasoning is opaque, and progress that cannot be observed would be invented.
- An interrupt, or a session that reached its spending ceiling, closes the outcome
  with one further `span.outcome_evaluation_end` carrying `result: "interrupted"` or
  `"budget_reached"` and an empty `outcome_evaluation_start_id`. The close is not
  tied to one evaluation, and the empty id is what keeps it distinguishable from the
  end event of an evaluation that actually ran.
- A revision is a real `user.message`: the grader's explanation is appended to the
  same log, so the next turn reads its instruction from the log rather than from
  memory, and a replayed session reconstructs the same sequence.
- A `user.define_outcome` payload rides in `metadata` and is projected back into
  the agent's context as the turn's instruction; the event has no content blocks
  of its own. Admission assigns the outcome its `outc_` id and persists it on the
  same carrier, so the published event carries top-level `outcome_id`,
  `description`, `rubric`, and `max_iterations` (`null` when the declaration left
  the default unset), and every `span.outcome_evaluation_*` the loop appends
  references the same id — declarations written before the id existed are the
  only events without it.

## 3. Alignment

Aligned for: append-only semantics, deterministic ordering, `processed_at`
lifecycle, structured `session.error`, and usage-before-idle ordering.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Error `code` extension | `error.type` is always one of the eight official values. The runtime's own code travels under `error.code`, a local extension the published shape does not define: a self-hosted runtime's failures (Pi transport, work queue, parked wait) are finer-grained than the official vocabulary, and dropping the code would lose the distinction. `billing_error` is part of the enumeration but has no local producer — this runtime has no billing boundary. |
| Event metadata storage | SandBase stores event payloads in a metadata column rather than per-field columns. This is a storage choice with no wire effect. |
| Local event types | SandBase emits extension event types under `/v1/x` that are not part of the canonical domain set. |
| `session.updated` fields | `session.updated` is emitted when `POST /v1/sessions/{id}` changes the agent snapshot, metadata, title, or budget; the event carries only the changed fields, and a no-op update appends nothing. |
| Outcome span vocabulary | `span.outcome_evaluation_*` is the local spelling for the outcome evaluation spans. The three-event shape and the verdict vocabulary are a SandBase profile: they are recorded here rather than presented as a verified upstream enumeration. |
| Outcome progression | The grader's own reasoning is not published while an evaluation runs. `span.outcome_evaluation_ongoing` marks that the evaluation is in flight and carries no content, because a partial verdict derived from nothing would be a claim about the deliverable that the runtime cannot support. |

## 5. Reason for the difference

- The local `code` field exists because the official `type` enumeration is
  coarser than what the runtime knows: a client that only branches on `type`
  works unchanged, while one that needs the local distinction can read `code`.
- Storing payloads in metadata keeps the log forward-compatible. Adding a
  column per new event field would make migrations the bottleneck for changes
  that have no storage requirement.

## 6. Corresponding tests

- `tests/integration/api.test.ts` — event list and stream ordering assertions,
  and the rejection of an unsupported `event_deltas[]` value.
- `tests/unit/event-logger.test.ts` — the append path assigns a monotonically
  increasing `seq` and the listing returns events in that order, plus the
  `afterSeq` filter a resuming reader uses.
- `tests/unit/session-error-shape.test.ts` — the two directions of the
  projection: every local code classifies into an official `type` (and
  `billing_error` is never produced), the three local dispositions publish as
  the `{type}` object, and events persisted with the legacy string
  `retry_status` and a code in `type` are normalized on the way out.
- `tests/conformance/session-error.test.ts` — the official SDK decodes the
  wire shape end to end: a model request the stub refuses with `401` arrives
  as `model_request_failed_error` with `retry_status.type` `terminal`.
- `tests/unit/cma-event-contract.test.ts` — the `user.define_outcome` event
  contract and the `initial_events` whitelist it is admitted through.
- `tests/integration/session-error-paths.test.ts` — the production paths, driven
  through `SessionManager.runTurn`: a model failure, a tool failure, and a
  sandbox failure each produce a structured payload; a busy session reports
  `retry_status.type` `retrying` and stays `paused`, a timed-out turn reports
  `terminal` and becomes `timed_out`, an unsupported capability reports
  `terminal`, an unrecognized code reports `terminal`, and a codeless failure
  falls back to `code: internal_error`. Every admission refusal (Pi policy,
  sandbox provider, user event, loop engine) is asserted by its preserved
  `code` rather than by a literal, so a code renamed in one place and not the
  other fails here. A user abort records no `session.error` at all.
- `tests/unit/model-error.test.ts` — the message carried into the payload is
  enriched with provider detail and has secrets redacted before it is persisted.
- `tests/unit/outcome-evaluation.test.ts` — one evaluation appends the three span
  events in order with the declared outcome's id and iteration, the end event
  carries the verdict and the explanation and names the start event it closes, a
  grader that throws still closes the end event before the failure propagates,
  and the transcript excludes the runtime's own scaffolding.
- `tests/integration/outcome-grading.test.ts` — the same sequence through a
  session: a declared outcome reaches the agent's context, the completed turn is
  graded with the span triple on the event listing, and a runtime with no
  provider records `session.error` with `outcome_evaluator_unavailable` and
  `retry_status.type` `terminal`.
- `tests/unit/outcome-loop.test.ts` — the loop's span bookkeeping: one triple per
  evaluation with `iteration` counting from 0, the budget verdict on the last
  allowed evaluation, one revision message per revision, and the closes that name
  no evaluation — `interrupted` and `budget_reached` — carrying an empty
  `outcome_evaluation_start_id`.
- `tests/integration/outcome-loop.test.ts` — the same through a session: the
  revision `user.message` in the event listing, the executor re-entered for it,
  the status a stop leaves behind, the ceiling ending an outcome before its next
  grading pass or turn, and the admission refusal that keeps a declared outcome off
  a runtime with no grader.
- `tests/integration/tool-event-fields.test.ts` — the tool-event projection: the
  lifted `name` / `input` / `tool_use_id` / `custom_tool_use_id` fields, the
  top-level `id` remaining the event id, `content` unchanged, and no field
  reaching an event type that declares none.
- `tests/integration/session-stop-reason.test.ts` — the `session.status_idle`
  projection: the object readable at the top level for both `requires_action` and
  `end_turn`, the metadata carrier kept and agreeing, the model-event string
  untouched, and the field omitted rather than `null` when there is no reason.
- `tests/integration/approval-event-id.test.ts` — the event-id address: the
  pending call's own event id reported in `event_ids` and not the block id, a
  decision naming it executed, the block-id spelling still accepted, and every
  refusal — a second decision for one call, an id naming nothing, a resolved
  call — preserved.
- `tests/integration/custom-tool-event-id.test.ts` — the same for a parked custom
  tool call, including that answering one call drops it from the array while an
  unanswered one stays, and that the projected object carries exactly
  `{type, event_ids}`.
- `tests/unit/parked-calls.test.ts` — the shared parked-set definition both the
  array and the gate read: which event types park, the event id reported versus
  the block id that resolves, and resolution by each result kind.
- `tests/integration/resume-gate.test.ts` — that definition's consequence on a
  live session: a partial answer leaves the session in `requires_action` with no
  error and no turn across every combination of parked families, and the last
  answer resumes it with every call paired.

## 7. Status

`supported` for append-only ordering, `processed_at`, structured
`session.error`, and the outcome evaluation span sequence. The error code
vocabulary and the outcome span vocabulary are `unverified` against upstream and
are recorded that way in the capability matrix.
