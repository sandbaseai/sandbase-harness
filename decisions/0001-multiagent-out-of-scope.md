# 0001 — Multiagent surface is permanently out of scope

Date: 2026-11-01
Status: decided
Scope: `multiagent_20261001` agent block, session threads, subagent /
workflow / advisor surfaces, `session.thread_*` / `agent.thread_message_*` /
`workflow_run.*` events, `/v1/sessions/{id}/threads*` routes.

## Decision

The published multiagent surface is **declared out of scope** for this
runtime rather than left as an open gap. The capability matrix records the
surface as `not_applicable` — a decision, not a missing point — alongside
`/v1/tunnels` and `/v1/user_profiles`.

Nothing changes mechanically: the thread routes stay mounted
`unsupported_capability` refusals, and the `multiagent` block stays refused
by name on both agent write paths. The change is in how the gap is *read*:
a caller no longer finds an unimplemented area that might be implemented
later, but a recorded boundary.

## Why

- The surface is a protocol of its own — threads as first-class,
  context-isolated streams; a background workflow-run engine; per-thread
  status aggregation and interrupt routing — not an increment on the
  single-session runtime this project is.
- Dynamic workflows are a research-preview surface upstream: they need a
  real background engine, a run lifecycle, and the `workflow_run_open`
  lifecycle gate, none of which exist here. A half-built version would
  report work it did not do.
- An honest refusal plus a documented local extension
  (`delegations` / `enable_general_subagent`) fits the project's
  contract-honesty posture better than a partial implementation that
  overstates coverage.
- `unavailable` reads as "not yet"; `not_applicable` reads as the decision
  it is.

## Consequence

- `threads-and-coordinator` and `multiagent-roster` report
  `not_applicable` in the capability matrix, with `threads.md` and
  `agents.md` still carrying the detail of what is refused and how.
- The local one-level delegation extension remains `supported` and is
  recorded as an extension, never as the published multiagent surface.
- A reversal is a new decision record, not an edit to this one.
