# CMA Contract — sessions

Contract area: `/v1/sessions` — lifecycle, status transitions, initial events,
resources, budget.
Status: `supported` for lifecycle and initial events. The session budget is a
separate contract area with its own status and is not claimed here; see
`budget.md` and §4.
Source: `src/api/routes/sessions.ts`, `src/api/routes/initial-events.ts`,
`src/api/standard.ts`, `src/core/session/session-manager.ts`.

---

## 1. Official definition

- A session runs one agent against one environment. It is created, may be
  resumed, interrupted, and terminated.
- `POST /v1/sessions` accepts optional `initial_events` processed at creation,
  so a session can start with work already queued.
- Session status reflects what a caller must do next: idle, running, waiting for
  action, terminated, or failed.
- The session-scoped event stream is the canonical way to observe progress.

## 2. Current SandBase shape

Status projection (`toApiSessionStatus`):

| Internal | API status |
| --- | --- |
| `running` | `running` |
| `requires_action` | `requires_action` |
| `completed` | `terminated` |
| `failed` | `failed` |
| `cancelled` | `cancelled` |
| `timed_out` | `timed_out` |
| `cleanup_pending` | `cleanup_pending` |
| anything else | `idle` |

`initial_events`:

- At most 50 events (`MAX_INITIAL_EVENTS`).
- Only `user.message` and `user.define_outcome` are accepted; any other type is
  rejected with `invalid_initial_events` and names the offending index.
- `user.message` requires a string or content-block array; a malformed payload
  is rejected rather than coerced.
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

## 3. Alignment

Aligned for: lifecycle endpoints, status vocabulary, initial event processing,
the 50-event ceiling, and the initial event type whitelist.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Session budget | Not tracked at all. `session-budget` is not a field SandBase reads, stores, or enforces. |
| Creation response | `initial_events` is not echoed back. The published contract does not state whether the creation response echoes it. |
| `cleanup_pending` | SandBase exposes this as a distinct status for local sandbox teardown. |
| Extension endpoints | Session inspection and control endpoints under `/v1/x` are local additions and are excluded from CMA admission. |

## 5. Reason for the difference

- Session budget is a deliberate non-goal: a self-hosted single-tenant runtime
  has one operator, so a per-session spend ceiling protects nobody and would add
  state that can drift from the provider's real billing. Recording this as
  `not_applicable` keeps it distinguishable from unimplemented work.
- Not echoing `initial_events` avoids presenting accepted input as restatable
  session state; the event stream is the authoritative record.
- `cleanup_pending` exists because local sandbox teardown is asynchronous and a
  caller needs to know teardown is still in progress.

## 6. Corresponding tests

- `tests/integration/api.test.ts` — session create/read/status cases, engine
  admission, and rejection of an unknown loop engine.
- `tests/unit/session-resource-instances.test.ts` — resource attach, list,
  delete, and the memory-store at-creation rule.
- `tests/unit/cma-event-contract.test.ts` — `initial_events` validation: the
  whitelist, the 50-event ceiling, the `user.define_outcome` defaulting, and the
  rejection of an unknown type by index.
- `tests/integration/initial-events-transaction.test.ts` — the transaction
  boundary: a rejected initial event leaves no session row and no attached
  resource behind, a successful batch creates the session and delivers every
  event, and the events' order and `processed_at` reflect admission.

## 7. Status

`supported` for lifecycle, status vocabulary, and initial events. Session budget
is `not_applicable` by design and is listed in the capability matrix as such.
