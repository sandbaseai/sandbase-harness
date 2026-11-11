# Threads and Multiagent Implementation Plan

**Status:** Unavailable → Implementation plan  
**Decision:** [0002 - CMA Multiagent Parity](decisions/0002-cma-multiagent-parity.md)  
**Priority:** P0 CMA compatibility gap  
**Baseline:** 2026-11-03, after official docs update

---

## Executive Summary

The `multiagent_20261001` surface is the largest missing CMA capability. This plan breaks it into independently verifiable tracks following CONTRIBUTING.md's one-PR-one-behavior rule. Each track can be implemented, tested, and merged separately while preserving existing clients.

## What's Missing

From `contracts/anthropic-cma/threads.md` and updated `official-docs/session-threads.md`:

**Core infrastructure:**
- Durable thread identity and persistence
- Per-thread isolated event streams
- Thread lifecycle states and transitions
- Thread-targeted operations (list, retrieve, archive, interrupt)

**Multiagent block execution:**
- `subagents` — delegate to other agents
- `workflows` — background workflow runs with phases
- `advisor` — model consultations for guidance

**Event routing:**
- `session.thread_*` lifecycle events
- `agent.thread_message_sent` / `agent.thread_message_received`
- `workflow_run.*` phase and result events

**Shared resources:**
- Session budget across all threads
- Aggregate session status from thread statuses
- Shared sandbox/filesystem/vaults, isolated context

## Existing Local Mechanism

`src/core/session/delegation-service.ts` provides a simpler, one-level delegation:
- Agent fields: `delegations` (list of agent names), `enable_general_subagent` (boolean)
- Tools: `delegate_to_<name>`, `general_subagent`
- Enforcement: `src/core/orchestrator/agent-orchestrator.ts`

**This is NOT the threads surface.** Delegated runs are nested turns with no:
- Thread identity or listing
- Per-thread status or lifecycle events
- Cross-posted event announcements
- Observable thread context

## Implementation Tracks

Following BACKLOG.md §"Thread foundation and subagents" and §"Workflow runs and advisor":

### Track 1: Thread Foundation (Core Infrastructure)

**Goal:** Durable threads with isolated event streams

#### 1.1: Thread Persistence Schema
**Acceptance:**
- New `session_threads` table: `id` (sthr_*), `session_id`, `parent_thread_id`, `agent_id`, `agent_version`, `status`, `created_at`, `archived_at`
- Migration creates table, indexes on `(session_id, archived_at)` and `(session_id, status)`
- Fresh and existing workspaces both migrate cleanly

**Files:**
- `src/db/migrations/NNN-add-session-threads.ts`
- Update `src/db/schema.ts`

**Tests:**
- Migration runs forward and produces expected schema
- Indexes exist and are named consistently

#### 1.2: Thread Event Isolation
**Acceptance:**
- New `thread_id` column on `events` table (nullable, FK to `session_threads.id`)
- Primary thread events have `thread_id = NULL`
- Child thread events carry their own `thread_id`
- Event queries filter by `session_id` AND (`thread_id` = X OR `thread_id IS NULL` for primary)

**Files:**
- `src/db/migrations/NNN-add-thread-id-to-events.ts`
- Update `src/core/session/event-manager.ts` to route events by thread

**Tests:**
- Primary thread events write with `NULL` thread_id
- Child thread events write with correct `thread_id`
- Event listing filters correctly by thread

#### 1.3: Thread REST Routes (Read-Only)
**Acceptance:**
- `GET /v1/sessions/{id}/threads` lists threads (returns primary + children)
- `GET /v1/sessions/{id}/threads/{thread_id}` retrieves one thread
- `GET /v1/sessions/{id}/threads/{thread_id}/events` lists thread-scoped events
- Statuses filter (`?statuses[]=running&statuses[]=idle`) works
- Returns 400 `unsupported_capability` removed, real data returned

**Files:**
- `src/api/routes/threads.ts` (new)
- Remove refusal from `src/api/routes/session-routes.ts`
- Update capability matrix: `threads-and-coordinator` → `partial`

**Tests:**
- Primary thread always in list
- Status filter includes/excludes correctly
- Thread events return only that thread's events
- C# SDK example from `session-threads.md` compiles and runs

### Track 2: Thread Lifecycle

#### 2.1: Thread Creation and Status Transitions
**Acceptance:**
- `session.thread_created` event emitted when child thread starts
- `session.thread_status_running`, `_idle`, `_rescheduling`, `_terminated` follow official lifecycle
- Transitions cross-post to primary stream
- Primary thread emits `session.thread_status_running` at session start

**Files:**
- `src/core/session/thread-lifecycle.ts` (new)
- Update `src/core/session/session-manager.ts` to emit primary thread running event

**Tests:**
- Session creation emits primary `thread_status_running`
- Child thread creation cross-posts to primary
- Idle/terminated transitions emit to both streams

#### 2.2: Thread Archive and Interrupt
**Acceptance:**
- `POST /v1/sessions/{id}/threads/{thread_id}/archive` archives idle thread
- Running thread returns `thread_not_idle` error
- `user.interrupt` with `session_thread_id` targets that thread
- `user.interrupt` without field interrupts all non-archived threads

**Files:**
- Add archive handler to `src/api/routes/threads.ts`
- Update `src/core/session/interrupt-handler.ts` for targeted interrupts

**Tests:**
- Idle thread archives successfully
- Running thread archive refused
- Targeted interrupt stops only that thread
- Broadcast interrupt stops all threads

#### 2.3: Aggregate Session Status
**Acceptance:**
- Session status = aggregate of thread statuses
- Any thread `running` → session `running`
- All threads `idle` → session `idle`
- Any thread `terminated` permanently → session `terminated`
- Budget exhaustion across threads → session `budget_reached`

**Files:**
- `src/core/session/status-aggregator.ts` (new)
- Update `src/core/session/session-manager.ts` to compute aggregate

**Tests:**
- One running thread keeps session running
- Last thread idle moves session to idle
- Budget reached affects session status

### Track 3: Subagent Delegation

#### 3.1: Accept `multiagent.subagents` Block
**Acceptance:**
- `multiagent.subagents` with `inline_agents` and `predefined_agents` accepted on create/update
- Validation: 25 concurrent thread limit (not enforced yet, just validated)
- Refusal of `multiagent` key removed
- Capability matrix: `multiagent-roster` → `partial`

**Files:**
- Update `src/core/agent/schema.ts` to accept `multiagent.subagents`
- Remove roster refusal from `validateAgentDefinition`

**Tests:**
- Agent with `multiagent.subagents` saves successfully
- Inline and predefined agents both accepted
- Malformed roster rejected with clear error

#### 3.2: Spawn Subagent Threads
**Acceptance:**
- Agent tool call spawns child thread
- Child thread has isolated context
- Child shares session sandbox/filesystem/vaults
- `agent.thread_message_sent` on sender, `agent.thread_message_received` on receiver

**Files:**
- `src/core/session/subagent-spawner.ts` (new)
- Update tool execution to check for subagent delegation

**Tests:**
- Subagent tool call creates thread
- Message direction events on both streams
- Child context isolated from parent

#### 3.3: Enforce 25-Thread Limit
**Acceptance:**
- 26th concurrent child thread refused with `thread_limit_error`
- Archived threads don't count toward limit
- Primary thread, advisor, workflow run threads exempt

**Files:**
- `src/core/session/thread-limits.ts` (new)
- Check limit before spawning in `subagent-spawner.ts`

**Tests:**
- 25 children allowed
- 26th refused
- Archiving one allows new spawn

### Track 4: Workflow Runs

#### 4.1: Workflow Run Persistence
**Acceptance:**
- New `workflow_runs` table: `id` (wrun_*), `session_id`, `name`, `description`, `status`, `created_at`, `ended_at`
- New `workflow_phases` table: `id` (wrph_*), `run_id`, `name`, `description`, `started_at`, `ended_at`
- `workflow_run.created` event with phases

**Files:**
- `src/db/migrations/NNN-add-workflow-runs.ts`
- `src/core/workflows/workflow-executor.ts` (new)

**Tests:**
- Workflow run row persists
- Phases linked to run

#### 4.2: Workflow Phase Execution
**Acceptance:**
- `workflow_run.phase_started`, `_ended` events
- Phase ends carry `phase_started_id` of start event
- Workflow threads created during phase
- `workflow_run.status_running`, `_idle` transitions

**Files:**
- `src/core/workflows/phase-executor.ts` (new)
- Update thread creation to mark workflow threads

**Tests:**
- Phase lifecycle events emitted
- Phase threads spawn and run
- Phase completion triggers next phase

#### 4.3: Workflow Result and Error Handling
**Acceptance:**
- `workflow_run.status_ended` with result type (`completed`, `stopped`, `error`)
- Error types: `timeout_error`, `program_error`, `thread_limit_error`, `unknown_error`
- `workflow_run.error` event on failures
- `workflow_run_open` gate on session operations

**Files:**
- Add error handling to `workflow-executor.ts`
- Add open-run check to session update/archive/delete

**Tests:**
- Successful run emits `completed`
- Timeout/error emit correct error type
- Session update refused while run open

### Track 5: Advisor Consultations

#### 5.1: Accept `multiagent.advisor` Block
**Acceptance:**
- `multiagent.advisor` with configuration accepted
- Advisor consultations exempt from 25-thread limit
- Capability: `multiagent-advisor` → `supported`

**Files:**
- Update `src/core/agent/schema.ts` to accept `multiagent.advisor`

**Tests:**
- Agent with advisor configuration saves

#### 5.2: Execute Advisor Consultations
**Acceptance:**
- Primary thread calls advisor for guidance
- Advisor creates ephemeral consultation thread
- Advisor result returned to primary thread
- No cross-posted events (advisor is internal)

**Files:**
- `src/core/session/advisor-service.ts` (new)

**Tests:**
- Advisor consultation completes
- Result returned to primary thread
- No events leaked to primary stream

### Track 6: Shared Budget

#### 6.1: Thread-Level Budget Signals
**Acceptance:**
- Session budget shared across all threads
- `budget_reached` stops in-progress thread
- Other threads can continue if under ceiling
- Aggregate status reflects budget exhaustion

**Files:**
- Update `src/core/session/budget-tracker.ts` for thread-scoped tracking

**Tests:**
- One thread exhausts budget, stops
- Other threads under ceiling continue
- Session status reflects budget state

## Testing Strategy

### Conformance Tests
- Pin to `official-docs/session-threads.md` SDK examples
- C#/Java/TypeScript snippets compile and run
- Event stream replay workflow from docs

### Integration Tests
- Full subagent delegation flow: spawn → run → return result
- Workflow run: create → phases → completion
- Advisor consultation: call → guidance → resume
- Thread lifecycle: create → run → idle → archive

### Load Tests
- 25 concurrent threads at limit
- Multiple workflow runs in one session
- Budget exhaustion across threads

## Migration Path

### Phase 1: Infrastructure (No Breaking Changes)
- Add tables, columns (nullable)
- Primary thread runs as before
- Existing sessions unmigrated, new ones opt-in

### Phase 2: Enable Multiagent
- Accept `multiagent` block
- Spawn child threads
- Capability status: `partial` → `supported`

### Phase 3: Full Workflow Surface
- Workflow runs execute
- Advisor consultations
- All events emitted

## Excluded from Scope

Per official contract, these remain out of scope:
- MCP tunnels (hosted connectivity)
- User profiles (hosted user management)
- Inference geo pinning (local providers have no geography control)

## Success Criteria

From BACKLOG.md:

> Primary and child threads have durable identity, isolated context, shared resources and budget, published status/message events, limits, archive and interrupt behavior, and restart/replay coverage. Only implemented `multiagent` members may be admitted.

**Done when:**
- ✅ Thread REST routes return real data (no refusals)
- ✅ Subagent delegation spawns threads with isolated context
- ✅ Workflow runs execute with phase events
- ✅ Advisor consultations complete
- ✅ 25-thread limit enforced
- ✅ Session budget shared across threads
- ✅ Official SDK examples from `session-threads.md` work
- ✅ Capability matrix: `threads-and-coordinator` = `supported`

## Next Immediate Action

**Start with Track 1.1: Thread Persistence Schema**

1. Create migration `NNN-add-session-threads.ts`
2. Run on fresh workspace
3. Run on existing workspace with sessions
4. Verify schema and indexes
5. Write tests
6. Open PR: "feat(threads): add session threads persistence schema"

---

**Note:** This is a planning document only. Implementation will proceed one track at a time, each as a separate PR, following CONTRIBUTING.md rules. All work remains local until explicitly committed per the project workflow.
