# CMA Contract — session threads and multiagent

Contract area: threads, the `multiagent_20261001` block (subagents, dynamic
workflows, advisor), thread lifecycle and message events, thread listing and
archive.
Status: `unavailable`. See §7.
Source: `src/core/session/delegation-service.ts`,
`src/core/orchestrator/agent-orchestrator.ts`, `src/core/agent/schema.ts`,
`src/core/agent/update.ts`.

<!-- capability-status
threads-and-coordinator: unavailable
-->

---

## 1. Official definition

As of the 2026-10-31 documentation snapshot
([`official-docs/multiagent-orchestration.md`](./official-docs/multiagent-orchestration.md),
[`official-docs/session-threads.md`](./official-docs/session-threads.md),
[`official-docs/workflow-runs.md`](./official-docs/workflow-runs.md)):

- An agent's `multiagent` block carries `type: "multiagent_20261001"` with three
  independent members: `subagents` (the agent delegates to other agents),
  `workflows` (the agent writes a program that runs many agents in phases as a
  background **workflow run**), and `advisor` (the primary thread consults a
  model for guidance). Each has `inline_agents` and `predefined_agents`
  sub-settings; predefined entries take `{type: 'agent', id, version?}`,
  `{type: 'self'}`, or a bare agent id string.
- Every agent runs in its own **session thread**: a context-isolated event
  stream with its own conversation history. All agents share the session's
  sandbox, filesystem, and vaults, but not their context.
- The **primary thread** is the session-level event stream itself. Its
  `parent_thread_id` is `null`; a full thread list includes it.
- At most **25 concurrent child threads** (idle ones count until archived);
  the primary thread, advisor consultations, and a workflow run's threads are
  exempt. Delegation is one level deep.
- A thread's transitions are announced as `session.thread_created` (carrying
  `workflow_run_id` on a run's threads, `null` elsewhere),
  `session.thread_status_running`, `session.thread_status_idle` (with
  `stop_reason`), `session.thread_status_rescheduled`, and
  `session.thread_status_terminated`. Every session emits
  `session.thread_status_running` for its primary thread; child transitions are
  cross-posted to the primary stream.
- Message direction is named **relative to the stream the event appears on**:
  `agent.thread_message_sent` on the sender's stream, carrying
  `to_session_thread_id` / `to_agent_name`; `agent.thread_message_received` on
  the receiver's stream, carrying `from_session_thread_id` / `from_agent_name`.
- `GET /v1/sessions/{session_id}/threads` lists them (with a `statuses[]`
  filter); `POST /v1/sessions/{session_id}/threads/{thread_id}/archive`
  archives one. Only an idle thread is archivable, and a thread parked on
  `requires_action` counts as idle.
- `user.interrupt` carrying `session_thread_id` stops that thread; omitting it
  interrupts every non-archived thread including the primary one.
- Session status is the aggregate of thread statuses, and the session budget is
  one shared ceiling across threads.

### Workflow runs

An agent with `workflows` enabled writes a workflow — a program that runs
other agents in phases — and the server runs it in the background as one
**workflow run**. A session can have several open runs. Runs emit their own
events on the session stream:

- `workflow_run.created` (`wrun_` id; carries `name`, `description`, and
  `phases`, each `{id: 'wrph_…', name, description}`),
- `workflow_run.status_running`, `workflow_run.status_idle`,
- `workflow_run.phase_started`, `workflow_run.phase_ended` (the latter carrying
  `phase_started_id` of the start event it closes),
- `workflow_run.status_ended` (carrying `result`:
  `{type: 'completed'|'stopped'|'error'}`, errors including `timeout_error`,
  `program_error`, `thread_limit_error`, `unknown_error`),
- `workflow_run.error` (an error of a run, or a refused start;
  `workflow_run_id` is `null` when no run was created).

While a run is open, session update, archive, delete, and run-thread archive
are refused with `error.details.error_code: "workflow_run_open"`. Runs have no
REST listing route — they are observed only through the session event stream.
Published limits: 64 concurrent run threads, 10 open runs per session, 1,000
agents per run, 24-hour default lifetime.

An earlier revision of this section described a `multiagent.agents` roster
with `advisor` entries. The published shape is the `multiagent_20261001` type
above; the roster model no longer appears in the current documentation.

## 2. Current SandBase shape

**None of this surface exists.** There is no thread resource, no thread row, no
per-thread event isolation, no `session.thread_*` or `agent.thread_message_*`
or `workflow_run.*` event, no `session_thread_id` routing, and no thread-level
budget signal. The five published thread routes — `GET
/v1/sessions/{id}/threads`, thread retrieval, events, and stream, and `POST
.../archive` — are mounted as `unsupported_capability` refusals naming
`threads-and-coordinator`, so an SDK caller gets a decodable 400 instead of a
404. A session is one event stream and one context window; the budget is
session-level only.

What does exist is a **different, smaller mechanism**, and it is not this
surface:

- `src/core/agent/schema.ts` accepts `delegations` (a list of agent names) and
  the boolean `enable_general_subagent`, and refuses a canonical `multiagent`
  roster by name with the capability id `multiagent-roster`. Both write paths
  refuse it: the create path in `validateAgentDefinition` and the update path in
  `validateAgentUpdateRequest` via `src/core/agent/update.ts`, which special-cases
  the key rather than reporting it as merely unknown.
- `src/core/session/delegation-service.ts` builds one tool per allowed target
  (`delegate_to_<name>`) plus `general_subagent`, which runs a temporary copy of
  the agent for one level. `src/core/orchestrator/agent-orchestrator.ts`
  (`validateDelegation`) enforces the allowed-target list, the chain, and the
  maximum depth.
- A delegated run is a nested turn with its own sandbox handle and its own
  context. It has no identity, no listing, no per-thread status, and no
  cross-posted lifecycle events, so it cannot be observed the way a thread can.

An earlier revision of this file described a `thread-manager.ts`, a
`multiagent.ts`, and a `session-threads.ts` route. None of those files exist in
the tree. The description was removed rather than reinterpreted, because a
contract document that describes a module nobody can open is worse than a
contract document that records the gap.

## 3. Alignment

None. The only neighbouring concept is delegation, and the local mechanism
differs from the published surface in field names, in lifecycle, and in what a
caller can observe: a thread is a first-class, listable, context-isolated stream
with its own status transitions, while a delegated run is an internal turn.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Threads | Absent. No thread resource, no lifecycle events, no per-thread context isolation. The five published thread routes are mounted as `unsupported_capability` refusals rather than 404s. |
| Subagent, workflow, and advisor surfaces | Absent. No `subagents`/`workflows`/`advisor` behaviour exists, no advisor consultation is held, and no `workflow_run.*` event is emitted. The `multiagent_20261001` shape has no executor here. |
| Canonical `multiagent` | A `multiagent` block in any shape — the `multiagent_20261001` type or a bare roster — is **refused by name** on both agent write paths rather than stored and ignored. The refusal names the capability `multiagent-roster` and points at the local extension. |
| Workflow runs | Absent. No run is created, no phase events exist, and the `workflow_run_open` gate has nothing to guard. Workflow runs have no published REST route, so no route-level refusal exists either — the refusal lives on the agent write path that would have enabled them. |
| Thread-scoped budget | Absent. The budget is one session-level ceiling; no `budget_reached` signal is emitted per thread. |
| Interrupt targeting | Absent. `user.interrupt` targets the session; a thread id has nothing to route to. |
| Local delegation extension | `delegations` and `enable_general_subagent` are a one-level parent/child mechanism with its own tool names. It is recorded as a local extension, never as the canonical multiagent surface. |

## 5. Reason for the difference

- The gap is a scope decision, not an oversight: threads, subagent delegation,
  dynamic workflows, advisor consultations, and per-thread event routing are a
  protocol surface of their own, and this phase implements none of them.
- The refusal exists because the alternative is worse than the gap. Accepting a
  `multiagent` block and storing it would let a caller build on delegation by
  roster or workflow — a controller that spawns threads, a UI that lists them,
  a run that starts agents — none of which would ever happen, and the caller
  would only find out from behaviour rather than from an error.
- A partial implementation was rejected on purpose. Thread identity without
  context isolation, or a `workflow_run.created` with no run behind it, would
  be a surface that reports work it did not do. The runtime reports the gap and
  tells the caller which local field to use instead.

## 6. Corresponding tests

- `tests/integration/agent-roster-refusal.test.ts` — the refusal of a canonical
  roster on create and update before anything is persisted, and the acceptance of
  the local `enable_general_subagent` extension on both write paths.
- `tests/integration/delegation.test.ts` — the local delegation extension: the
  tools built for an agent's `delegations` list, and a delegated run returning
  its result. Evidence that this mechanism exists and is *not* a thread surface.
- `tests/unit/orchestrator.test.ts` — the delegation checks: target not in the
  roster, chain, and depth.

## 7. Status

`unavailable` — nothing in this contract area is implemented. The runtime has no
thread resource, no subagent/workflow/advisor surface, no thread lifecycle or
message-direction events, no `workflow_run.*` events, no per-thread event
isolation, and no thread-scoped budget signal. The published thread routes are
mounted refusals returning `unsupported_capability` with the
`threads-and-coordinator` capability id, and the agent write path refuses the
`multiagent` block by name. The neighbouring local delegation extension is
recorded separately in the capability matrix and is not presented as threads.
