# CMA Contract — session budget

Contract area: `max_list_cost` enforcement, usage reporting, pause and resume.
Status: `partial`. See §7.
Source: `src/core/session/session-budget.ts`, `src/core/session/cost-profile.ts`,
`src/core/session/session-manager.ts`, `src/api/routes/sessions.ts`,
`src/api/standard.ts`, migration `035_session_budget`.

<!-- capability-status
session-budget: partial
-->

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

- `CostProfile` (`src/core/session/cost-profile.ts`) holds integer cents per
  million tokens per model. `EMPTY_COST_PROFILE` is an explicit zero profile —
  no model rates, zero runtime and web-search rates — so "this model has no list
  price" is a different statement from "this model costs nothing". An operator
  supplies rates through `MANAGED_AGENTS_COST_PROFILE` or `parseCostProfile`.
- `session-budget.ts` owns the wire value and every refusal rule. Consumption is
  aggregated from `span.model_request_end` rows — already one canonical usage
  record per model request — into exact **microcents** (1e-6 cent), so the
  between-requests comparison never depends on float rounding. Reported cents are
  that total rounded **up**, so a client reading `list_cost` is never told it
  spent less than it did.
- A session may declare a `budget` at creation. The budget is stored in a
  nullable `sessions.budget` column added by migration `035_session_budget`: SQL
  NULL means the session never had one, the JSON literal `null` means it had one
  removed, and anything else is the budget. The two "no budget" states stay
  distinguishable because the contract refuses differently for each.
- `assertSessionCanAcceptEvent` — already the admission gate for `POST
  /v1/sessions/{id}/events`, `POST /v1/sessions/{id}/messages`, both `/v1/runs`
  entry points, and the internal `sendEvent` path — refuses a work-starting event
  once the session has reached its ceiling, with the stable code
  `budget_reached`. Settlement events pass.
- The builtin loop also checks the ceiling **inside** a turn: the strategy's
  `stopWhen` calls `budgetExhausted` after each step — spend is committed per
  step in `onStepFinish`, so the check always reads the latest cost — and the
  turn ends after the step that crossed the cap instead of starting another
  model request. The session then idles with `stop_reason:
  {type: 'budget_reached'}`, `session.usage` immediately before it, and any
  tool call the loop dispatched but never executed is settled with the
  interrupted-outcome placeholder so the log stays pair-valid for a resume.
- An accepted budget update resumes the session on its own: `updateSession`
  re-enters the turn loop on an internal trigger when the last idle was
  `budget_reached` — no `user.message` is appended, the context is rebuilt
  from the event log, and a Pi session is not re-entered because the trigger
  has no Pi transport.
- `session.usage` now carries `list_cost` (whole cents, priced from the profile),
  `budget` (the value, or `null`), and `server_tool_use`.
- `POST /v1/sessions/{id}` moves the budget through `SessionManager.updateSession`
  (`updateBudget` is the budget-only spelling). An object replaces the ceiling,
  `null` removes it, and the move is allowed in any non-terminal state; the raise
  and remove rules below are evaluated inside the update's single transaction and
  reported through `session.updated`. An accepted move or removal is also what
  lifts a `budget_reached` pause — the session resumes without a further event.
- The ceiling is read by a declared outcome's revision loop as well as by admission.
  A revision turn is not an event — appending the revision and re-entering the
  executor are internal to the declaration that was already admitted — so the loop
  consults the spend before it spends anything further (the grading pass included)
  and closes the outcome with `result: "budget_reached"` on its terminal
  `span.outcome_evaluation_end`. The published consequence, "the next model request
  does not start", is what this extends to work one admitted event can keep
  starting.

## 3. Alignment

| Published clause | State |
| --- | --- |
| Budget value shape, `type: 'limit'` / `max_list_cost` nesting | Aligned. `parseSessionBudget` rejects a non-integer amount, a leading zero, an unknown currency, a wrong `type`, and a malformed shape with distinct stable codes. |
| Enforcement between model requests | Aligned, and on two levels: the builtin strategy's `stopWhen` stops a turn after the step that crossed the cap, and the admission gate refuses a work-starting event before a turn is queued. A declared outcome's revision loop stops at the ceiling before it starts another grading pass or turn. |
| Pause rather than terminate | Aligned at session level: a turn that crosses the ceiling idles with `stop_reason: {type: 'budget_reached'}`, history and sandbox are retained, `session.usage` precedes the idle, and an accepted budget update or removal resumes the session without a further event. The published pause signal is reported on the session's own `session.status_idle`; the thread-level copy needs a thread surface this runtime does not have — see §4. |
| Settlement-event whitelist at the cap | Aligned with a narrower list. See §4. |
| Refusing to attach, or to lower below consumed cost | Aligned. A budget is attachable at creation only, must be strictly greater than consumed cost, and cannot be re-added after removal. |
| `session.usage` echoes the budget and the accumulated list cost | Aligned, with `list_cost` withheld when incomplete. See §4. |
| A shared session-wide ceiling across threads | Not applicable yet: this runtime has no thread surface. Cost is aggregated per session across every `span.model_request_end` row, which is the shape a shared ceiling needs. |

## 4. Differences

| Difference | Detail |
| --- | --- |
| Prices are local, not official | `list_cost` is computed from an operator-supplied `CostProfile`. SandBase never embeds vendor prices. With the default empty profile, no model is priced and a session cannot be budgeted at all. |
| Unpriced model ⇒ no budget | A model the profile does not list makes the session unbudgetable (`model_not_budgetable`). The published contract has authoritative prices, so the case does not arise for it. |
| `list_cost` withheld when incomplete | When any model used is unpriced, `usage.list_cost` is omitted rather than reported as a lower bound. Reporting a lower bound as a total would understate spend to a caller that is about to choose a new cap. |
| The thread-level `budget_reached` signal has no thread surface | The session pauses exactly as published — idle with `stop_reason: budget_reached`, automatic resume when an update lifts the ceiling — but the reason is carried on the session's own `session.status_idle`. The published model also reports it per thread, and this runtime has no thread surface to report it on. A work-starting event at the cap is still refused with the `budget_reached` code rather than queued, because a resumed-at-once turn would charge spend the client did not raise the ceiling for. |
| An outcome stops at the ceiling with its own verdict | A declared outcome whose session reaches the ceiling closes with `result: "budget_reached"` on its terminal `span.outcome_evaluation_end`. The published contract has no outcome-loop surface, so this is a local rule rather than a published one; `sessions.md` §4 records the outcome side of it. |
| The settlement whitelist names three events, not four | The published list also names `user.tool_result`. No client can send that event here — externally executed tool results arrive as `user.custom_tool_result` — and the refusal quotes the list back to the client, so naming an event the API would reject as unknown would be worse than omitting it. |
| No budget alerts | `session-budget-alerts` remains a deliberate non-goal, as recorded in the capability matrix. |

## 5. Reason for the difference

- **Local pricing.** A self-hosted runtime has no vendor billing feed, and
  embedding a price table would make SandBase assert numbers it cannot verify.
  Making the profile operator-supplied means the spend number is traceable to a
  configuration the operator can inspect, and an *unpriceable* session fails
  loudly instead of being metered against invented prices. This is the main
  reason the entry is `partial` rather than `supported`: the mechanism matches,
  the price source deliberately does not.
- **Withholding an incomplete total.** A partial cost is worse than none when the
  consumer is choosing a cap: it reads as "this is what you spent" and leads to a
  budget that is too low. Naming the unpriced models instead lets the operator fix
  the profile.
- **Refusing the event rather than pausing the session.** The pause vocabulary is
  thread-scoped (`session.thread_status_idle` with `stop_reason`). Emitting a
  session-level imitation would put a value in the log that no client could match
  to the published rule. Shipping the half that is provable — the next request
  does not start — keeps the observable promise without inventing the rest.

## 6. Corresponding tests

`tests/unit/session-budget.test.ts` covers budget parsing and its refusal codes,
exact-microcent cost arithmetic, unpriced-model naming, exhaustion at the
boundary (just under the cap keeps running, at the cap stops), settlement-event
acceptance at the cap, the attach/lower/remove rules, the three-state budget
(`undefined` / `null` / object), the `session.usage` payload, and derivation from
the durable log across a manager restart.
`tests/unit/outcome-loop.test.ts` covers the loop's half of the ceiling: a spent
ceiling stops the iterations without a grading pass and closes the outcome as
`budget_reached`, and the unit test also pins that this verdict is spelled the same
as the admission code.
`tests/integration/outcome-loop.test.ts` covers it through a real session: a ceiling
crossed by the declared turn grades nothing further, and a ceiling crossed by a
revision turn ends the outcome there.
`tests/unit/session-budget-pause.test.ts` covers the mid-turn half: a turn that
crosses the ceiling idles on `budget_reached` with `session.usage` immediately
before, a parked call keeps `requires_action` ahead of the ceiling reason, an
accepted raise or removal re-enters the loop on the internal resume trigger
without appending a `user.message`, an unrelated update does not resume, and a
tool call stranded by the ceiling stop is settled so the resume sees a paired
transcript.
`tests/conformance/session-budget-pause.test.ts` runs the whole arc against the
official SDK on a real runtime: one priced step crosses the cap, the stub sees
exactly one request, `budget_reached` idles with usage before it, a work event is
refused `400`, and a raise through `sessions.update` resumes the turn to
`end_turn` on its own.
`tests/unit/capability-matrix.test.ts` pins this entry's status and the
deviations its reason names.

## 7. Status

`partial`. The mechanism is implemented: consumption is priced in integer
microcents from the durable log, a session may declare a ceiling at creation, a
turn stops after the step that crossed the cap and the session idles with
`stop_reason: budget_reached` until an accepted update lifts the ceiling and
resumes it, and a work-starting event at the cap is refused before any model
request starts. It is not `supported`, because the price source is an
operator-supplied profile rather than official list prices, and because the
pause is reported on the session's own idle event only — the thread-level
`budget_reached` signal needs a thread surface this runtime does not have. It is
no longer `planned`: the behaviour is shipped and covered by tests.
