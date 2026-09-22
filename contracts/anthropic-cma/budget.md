# CMA Contract — session budget

Contract area: `max_list_cost` enforcement, usage reporting, pause and resume.
Status: `planned`. See §7.
Source: not implemented. The design described here would live in
`src/core/session/session-budget.ts`, `src/core/session/cost-profile.ts`,
`src/core/session/session-manager.ts`, and `src/api/standard.ts`.

---

## 1. Official definition

- A session may carry a budget: `{"type": "limit", "max_list_cost":
  {"amount": "<integer cents as a string>", "currency": "USD"}}`.
- The budget is a **session-wide** ceiling shared by every thread. Each thread's
  cost is priced by the model that thread used.
- Enforcement lands **between model requests**: the request that crossed the cap
  completed, and the next one does not start.
- Reaching the cap pauses the session rather than terminating it. Every thread
  that pauses emits `session.thread_status_idle` with `stop_reason:
  budget_reached`; if a thread's last request both crossed the cap and finished
  its turn, that thread reports `end_turn` while the session still reports
  `budget_reached`.
- At the cap, only **settlement** events are accepted: `user.tool_confirmation`,
  `user.tool_result`, `user.custom_tool_result`, `user.interrupt`. A work-starting
  `user.message` is rejected.
- A budget cannot be attached to a session that has already consumed cost, and
  cannot be lowered to a value at or below what was already consumed. Removing a
  budget (`null`) and later attaching one is refused by the published contract.
- `session.usage` echoes the budget, or `null` when the session has none, and
  carries the accumulated list cost.

## 2. Current SandBase shape

None of this behaviour is implemented, so there is no current shape to compare
against. What exists today is the surface the design would have to extend:

- Nothing prices model consumption. `session.usage` is built by
  `buildSessionUsageSnapshot` in `src/core/session/session-usage.ts`, which
  reports `input_tokens`, `output_tokens` and `active_seconds` derived from the
  append-only log, and carries neither `list_cost` nor `budget`.
- No session accepts a `budget` object, and no code path refuses work because a
  ceiling was reached. A session therefore has no spending ceiling at all.
- `docs/api.md` records both fields as omitted, which is the accurate
  description of the runtime as it stands.

## 3. Alignment

Nothing is aligned yet, because nothing is implemented. These are the published
clauses an implementation would have to satisfy:

- the budget value shape and its `type: 'limit'` / `max_list_cost` nesting;
- enforcement between model requests, expressed as an engine stop condition
  rather than an abort;
- pause rather than terminate, with the session reporting `budget_reached`;
- the settlement-event whitelist at the cap;
- refusing to attach, or to lower below consumed cost;
- `session.usage` echoing the budget and the accumulated list cost;
- a shared session-wide ceiling, since delegated runs mirror their
  `span.model_request_end` onto the same session log.

## 4. Differences

These are the deviations the design intends to make from the published contract.
They are design decisions, not observations about a running system, because
there is no running system to observe.

| Difference | Detail |
| --- | --- |
| Prices are local, not official | `list_cost` would be computed from an operator-supplied `CostProfile`. SandBase never embeds vendor prices. With the default empty profile, no model is priced and a session cannot be budgeted at all. |
| Unpriced model ⇒ no budget | A model the profile does not list makes the session unbudgetable (`modelWithoutListPrice`). The published contract has authoritative prices, so the case does not arise for it. |
| `list_cost` withheld when incomplete | When any model used is unpriced, `usage.list_cost` is omitted rather than reported as a lower bound. Reporting a lower bound as a total would understate spend to a caller that is about to choose a new cap. |
| No `budget_reached` on the thread when the turn also ended | The thread reports `end_turn` whenever the turn completed, and only the session reports `budget_reached`. This matches the published rule for the both-at-once case; the session-level reason is the authoritative pause signal. |
| No rescheduling | `session.status_rescheduled` / `session.thread_status_rescheduled` would not be emitted, because no transient-error retry schedule exists. |
| Server-tool cost is always zero | `usage.server_tool_use` reports `{web_search_requests: 0, web_fetch_requests: 0}` unconditionally, because web tool execution is `unavailable`. This is a true statement about local behaviour, not a claim that the tools ran. |

## 5. Reason for the difference

- **Local pricing.** A self-hosted runtime has no vendor billing feed, and
  embedding a price table would make SandBase assert numbers it cannot verify.
  Making the profile operator-supplied means the spend number is traceable to a
  configuration the operator can inspect, and an *unpriceable* session fails
  loudly instead of being metered against invented prices. This is why the
  entry, once implemented, would still be `partial` rather than `supported`:
  the mechanism would match, the price source deliberately would not.
- **Withholding an incomplete total.** A partial cost is worse than none when the
  consumer is choosing a cap: it reads as "this is what you spent" and leads to a
  budget that is too low. Naming the unpriced models instead lets the operator
  fix the profile.
- **No rescheduling.** Emitting a retry status implies a retry loop. SandBase has
  none, and inventing the event would tell a client to wait for something that
  will not happen.

## 6. Corresponding tests

None yet, because the behaviour is unimplemented. An implementation is expected
to add coverage for budget parsing and every refusal code, exact-microcent cost
arithmetic, unpriced-model naming, exhaustion at the boundary, settlement-event
acceptance at the cap, the attach/lower/remove rules, the three-state budget
(`undefined` / `null` / object), the `session.usage` payload, and derivation from
the durable log across a restart. Until those exist, the matrix entry stays
`planned`.

## 7. Status

`planned`. The design is published here and the implementation is scheduled
work. No part of it is present in the runtime: nothing prices consumption, no
session accepts a budget, and no ceiling is enforced, so `session.usage` carries
neither `list_cost` nor `budget`. It is not `partial`, which would claim a
working mechanism with a documented deviation, and not `not_applicable`, which
would deny that the work is planned.
