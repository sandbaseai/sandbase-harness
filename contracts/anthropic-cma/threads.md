# CMA Contract — session threads and multiagent

Contract area: threads, the `multiagent_20261001` block (subagents, dynamic
workflows, advisor), thread lifecycle and message events, thread listing and
archive.
Status: `partial` — the delegation-only `coordinator` subset is accepted and
normalized to the local delegation mechanism; threads, workflows, and the
advisor remain unimplemented. In scope under
[decision 0002](../../decisions/0002-cma-multiagent-parity.md). See §7.
Source: `src/core/session/delegation-service.ts`,
`src/core/orchestrator/agent-orchestrator.ts`, `src/core/agent/schema.ts`,
`src/core/agent/update.ts`.

<!-- capability-status
threads-and-coordinator: partial
-->

---

## 1. Official definition

As of the 2026-11-17 documentation snapshot
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
above. The older `coordinator` type is still accepted by the API — an update
that sends it, or that mixes it with `multiagent_20261001`, replaces the
stored block wholesale; see
[`official-docs/multiagent-orchestration.md`](./official-docs/multiagent-orchestration.md)
("Move from the `coordinator` type").

## 2. Current SandBase shape

**The thread surface itself still does not exist.** There is no thread resource, no thread row, no
per-thread event isolation, no `session.thread_*` or `agent.thread_message_*`
or `workflow_run.*` event, no `session_thread_id` routing, and no thread-level
budget signal. The five published thread routes — `GET
/v1/sessions/{id}/threads`, thread retrieval, events, and stream, and `POST
.../archive` — are mounted as `unsupported_capability` refusals naming
`threads-and-coordinator`, so an SDK caller gets a decodable 400 instead of a
404. A session is one event stream and one context window; the budget is
session-level only.

What exists is the **coordinator write spelling**, normalized to the local
delegation mechanism on the agent write paths:

- `src/api/routes/agents.ts` (`normalizeMultiagentField`) accepts a
  `{"type":"coordinator","agents":[…]}` block on `POST /v1/agents` and
  `POST|PUT /v1/agents/{id}` — the one `multiagent` shape upstream
  self-hosted itself accepts (`official-docs/self-hosted/differences.md`).
  `agents` is the top-level list of 1–20 predefined-agent entries; each
  entry is one of `{"type":"agent","id":"agent_…"}`, the same with
  `version`, `{"type":"self"}`, or a bare `agent_…` string
  (`src/core/agent/schema.ts`, `coordinatorMultiagentSchema`). Every
  `agent_…` id resolves against the store at write time to the loaded
  agent's name — `delegations` is name-canonical — and an id that
  resolves to nothing is a `400` naming it, rather than a roster entry
  that can only fail at execution.
- The normalized definition stores `delegations` plus
  `delegations_source: "coordinator"`. The execution layer reads the
  marker in `src/core/session/tool-resolver.ts` (`delegationContextFor`)
  and clamps the delegation root context to `maxDepth` 1 — the published
  "Delegation is one level deep" rule — where a caller-written
  `delegations` roster keeps the local extension default of 5.
- `{type:"self"}` maps to `enable_general_subagent`, not to the agent's
  own name in `delegations`: a self entry in the roster would be refused
  by cycle detection, while the local `general_subagent` tool already
  implements the one-level self-copy semantic coordinator means. A caller
  who also sends `enable_general_subagent: false` in the same request is
  refused as a contradiction.
- A `version` pin on an entry is accepted and resolved to latest: pinning
  to an archived version row is a separate feature, and the published
  entry itself defaults to latest when `version` is omitted.
- `multiagent: null` clears a coordinator-produced roster —
  `delegations`, `delegations_source`, and `enable_general_subagent` —
  and only that roster: a caller-owned `delegations` list or
  `enable_general_subagent` flag without the marker is left alone.
- Update semantics are the published wholesale replace: a coordinator
  block replaces the stored `delegations` roster outright rather than
  merging level-by-level.
- `src/core/agent/schema.ts` accepts `delegations` (a list of agent names) and
  the boolean `enable_general_subagent` directly as the local extension.
  A `multiagent` block with any other `type` — `multiagent_20261001`,
  an `advisor`, `workflows`, `subagents`, or `inline_agents` — is refused
  by name with the capability id `multiagent-roster`; a coordinator block
  that breaks a published bound is refused with the coordinator rule
  named instead.
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

The coordinator **roster declaration** is aligned: upstream self-hosted
accepts `{"type":"coordinator","agents":[1–20 predefined-agent entries]}`, and
SandBase accepts the same shape on both agent write paths, resolves each
`agent_…` id to the loaded agent, and honours `multiagent: null` as a roster
clear. The observable surface is *not* aligned: official delegation is
delivered as child threads — listable, context-isolated, individually
interruptible — while a delegated run here is an internal nested turn that
returns its result inline. Delegation itself is what the caller asked for;
threads are what upstream reports back, and that reporting does not exist.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Threads | Absent. No thread resource, no lifecycle events, no per-thread context isolation. The five published thread routes are mounted as `unsupported_capability` refusals rather than 404s. A coordinator-declared delegation runs as a nested turn, not a thread — no thread listing, follow-up, or per-thread status is observable. |
| Coordinator `multiagent` | Accepted and normalized to `delegations` with `delegations_source: "coordinator"` — ids resolved to names at write time, `{type:"self"}` mapped to `enable_general_subagent`, `version` resolved to latest, `null` clearing a coordinator-produced roster, wholesale replace on update, and the delegation depth clamped to the published one level. Delivery is the local nested-turn mechanism, not child threads. |
| Subagent, workflow, and advisor surfaces | Absent beyond the coordinator roster. No `workflows`/`advisor`/`subagents`/`inline_agents` member is accepted — a coordinator block carrying one is refused with the coordinator rule named, and every other `multiagent` `type` is refused under `multiagent-roster`. No advisor consultation is held and no `workflow_run.*` event is emitted. |
| Workflow runs | Absent. No run is created, no phase events exist, and the `workflow_run_open` gate has nothing to guard. Workflow runs have no published REST route, so no route-level refusal exists either — the refusal lives on the agent write path that would have enabled them. |
| Thread-scoped budget | Absent. The budget is one session-level ceiling; no `budget_reached` signal is emitted per thread. |
| Interrupt targeting | Absent. `user.interrupt` targets the session; a thread id has nothing to route to. |
| Local delegation extension | `delegations` and `enable_general_subagent` are a parent/child mechanism with its own tool names. The coordinator roster is normalized into it, so the two spellings share one execution path; a coordinator-sourced roster is additionally clamped to depth 1. It is recorded as a local extension, never as the canonical multiagent surface. |

## 5. Reason for the difference

- [Decision 0002](../../decisions/0002-cma-multiagent-parity.md) supersedes
  the permanent exclusion in decision 0001. This is now an implementation gap:
  threads, subagent delegation beyond the roster, workflows, advisor
  consultations, and per-thread event routing need their own persistence and
  execution model.
  [The roadmap](../../BACKLOG.md#cma-compatibility) records the acceptance
  criteria; a scope change alone does not implement any of them.
- The coordinator subset is accepted because upstream self-hosted accepts it,
  and it is the one `multiagent` shape whose semantics map honestly onto a
  mechanism this runtime has: a roster of predefined agents the caller may
  delegate to. Refusing it would break the one multiagent request a
  self-hosted SDK caller can legitimately send.
- Everything else is still refused because the alternative is worse than the
  gap. Accepting a `multiagent_20261001` block and storing it would let a
  caller build on delegation by roster or workflow — a controller that spawns
  threads, a UI that lists them, a run that starts agents — none of which
  would ever happen, and the caller would only find out from behaviour rather
  than from an error.
- An incomplete implementation must not be enabled. Thread identity without
  context isolation, or a `workflow_run.created` with no run behind it, would
  be a surface that reports work it did not do. The runtime reports the gap and
  tells the caller which local field to use instead.

## 6. Corresponding tests

- `tests/integration/agent-roster-refusal.test.ts` — coordinator accepted on
  create and update with `delegations` populated; `multiagent_20261001`,
  `advisor`, `workflows`-carrying, >20-entry, and malformed coordinator blocks
  refused with the bound named; the roster refusal still naming
  `multiagent-roster`; and `multiagent: null` clearing a coordinator-produced
  roster only.
- `tests/integration/delegation.test.ts` — the local delegation extension: the
  tools built for an agent's `delegations` list, and a delegated run returning
  its result. Evidence that this mechanism exists and is *not* a thread surface.
- `tests/unit/orchestrator.test.ts` — the delegation checks: target not in the
  roster, chain, and depth.
- `tests/unit/schema-validator.test.ts` — the coordinator schema: the three
  entry forms, `{type:"self"}`, the 1–20 bound, `strict()` extra-key refusals
  (`advisor`, `subagents`, `workflows`, `inline_agents`), unknown `type`, and
  missing `agents`.

## 7. Status

`partial` — in scope under
[decision 0002](../../decisions/0002-cma-multiagent-parity.md), which supersedes
[decision 0001](../../decisions/0001-multiagent-out-of-scope.md).
The delegation-only coordinator subset is implemented: the write paths accept
`{"type":"coordinator","agents":[…]}`, normalize it to `delegations` with the
one-level rule applied, honour `multiagent: null` as a roster clear, and keep
every other `multiagent` shape refused. The runtime still has no thread
resource, no subagent surface beyond the roster, no workflow-run or advisor
surface, no thread lifecycle or message-direction events, no per-thread event
isolation, and no thread-scoped budget signal. The published thread routes
stay mounted refusals returning `unsupported_capability` with the
`threads-and-coordinator` capability id. The neighbouring local delegation
extension is recorded separately in the capability matrix and is not
presented as threads.
