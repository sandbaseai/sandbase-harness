# CMA Contract — dreams

Contract area: `/v1/dreams` — session-backed memory-consolidation jobs.
Status: `supported`. See §7.
Source: `src/api/routes/dreams.ts`, `src/core/dreams/dream.ts`,
`src/core/dreams/runner.ts`, `src/core/db/migrations.ts` (M060).

<!-- capability-status
dreams: supported
-->

---

## 1. Official definition

- A dream (`drm_*`) is an asynchronous job: it reads **one memory store** and a
  set of **session transcripts**, runs a consolidation pipeline, and writes the
  result to a memory store.
- `POST /v1/dreams` takes `inputs` (exactly one `{type:'memory_store'}` entry
  and one `{type:'sessions', session_ids}` entry with 1–100 unique ids),
  optional `instructions` (1–4096 characters), and `model` (an id string).
- Lifecycle: `pending → running → completed | failed | canceled`. Terminal
  statuses never move again. `POST .../cancel` applies to `pending` or
  `running`; `POST .../archive` applies to terminal statuses only.
- `outputs` names the memory store holding the result — empty until the dream
  records one. The output is a **new store** that starts as a copy of the
  input; the input is never modified. A `failed` or `canceled` dream keeps
  whatever the output store already holds.
- `session_id` names the session running the pipeline; streaming that session's
  events follows the run. `usage` mirrors its token counters and can still move
  briefly after a cancel.
- `GET /v1/dreams` lists newest-first and supports `limit` (default 20, max
  100), `page`, and `include_archived`. `GET /v1/dreams/{id}` retrieves one.

The published documentation as crawled 2026-10-31
([`official-docs/dreams.md`](./official-docs/dreams.md)) describes only these
parameters. `output_behavior`, a `{id, speed}` model object, repeatable
`statuses` filters, and `created_at` bounds are **not in the published doc**;
the pinned SDK may accept them, but this contract treats them as
local-extension surface until a published source confirms them.

## 2. Current SandBase shape

The routes live in `src/api/routes/dreams.ts`; the job lifecycle lives in
`src/core/dreams/runner.ts`; rows persist in the `dreams` table (migration 060).

- A create validates the request shape, the input store (exists, not archived),
  and the session ids (all exist), then inserts a `pending` row and starts the
  pipeline in the same request. **Starting** means: an internal agent
  (`agent_sandbase_dream`) is ensured, the output store is created as a copy of
  the input for `create_new`, and a dedicated session is created through the
  same `createWithInitialEvents` path a scheduled deployment uses — with the
  input store mounted read-only and the output store mounted writable, the
  selected transcripts packaged as context events, and the resolved model
  frozen into the session's agent snapshot.
- The pipeline session is an ordinary session: `dream.session_id` retrieves it,
  its events stream over the usual SSE endpoints, and its event log stays
  durable after the dream ends. When the dream terminalizes the session is
  archived so its sandbox releases.
- Model resolution follows the published precedence for a local extension:
  the request's `model`, then the `dreams.model` runtime setting, then the
  workspace default model. A create that cannot resolve any of the three is
  refused.
- Status reconciliation runs on every read and list, and in the operations
  tick, so a dream nobody is polling still finishes and releases its sandbox.
  A session that idles on `end_turn` completes the dream; a session that idles
  on `budget_reached` or `retries_exhausted`, or that fails or times out, fails
  the dream. The output store keeps whatever was written.
- `cancel` marks the dream `canceled` and then interrupts and archives the
  pipeline session, so the response reports the final state rather than a
  request that may or may not land.
- List supports `include_archived`, repeatable `statuses`/`statuses[]`,
  `created_at[gt]`/`created_at[lt]`, and the shared `limit`/`page` cursor
  window. Archived dreams remain retrievable by id.

## 3. Alignment

Aligned for: the request shape (`inputs`, `instructions`, `model`), the
lifecycle vocabulary and terminal rules, the new-store seeded-copy output
semantics, cancel and archive state rules, the `session_id` audit surface, the
usage projection, and sorted-session-id echoes. The `output_behavior` field
(including `update_existing`), repeatable `statuses`/`statuses[]` list filters,
and `created_at[gt|lt]` bounds are **local extensions** — accepted and
implemented, but not part of the published definition.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Beta gate | None. The published contract is explicit: "Dream endpoints require the `dreaming-2026-04-21` beta header. The `managed-agents-2026-04-01` header on its own doesn't grant access to dreams" (`official-docs/dreams.md` "Required beta headers"). The local stance admits the resource directly because the official SDK's dreams client already sends the family beta — "The SDK sets the right header on each call" — so refusing a request whose beta header is correct would break that client for no local gain. Recorded as a deliberate divergence rather than a claimed parity with the published gate. |
| Session id prefix | The pipeline session id uses the local `sess_` prefix rather than the published `sesn_`, matching every other session this runtime creates. |
| Dream webhooks | No `dream.*` operation events are published; the lifecycle is observable through the resource itself and the session event stream. |
| Console UI | None in this phase; dreams are reachable through the API and SDK only. |
| Workspace scoping | Single-tenant runtime: the published "same workspace" checks are trivially satisfied — every store and session id resolves against the one local database. |

## 5. Reason for the difference

- A session-backed implementation is chosen over a standalone worker because
  the published surface already describes the pipeline as a session callers can
  stream. Reusing `createWithInitialEvents` gives the dream the same tool
  admission, memory-mount, and event-log guarantees every other session gets,
  instead of a second pipeline machinery that could diverge from them.
- `pending` exists in the schema for the create/launch boundary and for crash
  recovery — a row whose session was never created is restarted by the next
  sweep — rather than for queueing, because a local runtime has no scheduler
  backlog the state would describe.
- The input store is mounted read-only rather than copied piecemeal so the
  contract's "the dream doesn't change it" is enforced by the mount itself,
  not by trusting the pipeline to behave.
- Reconcile-on-read plus a tick sweep is chosen over a dedicated job queue:
  the dream table already carries the durable state, and both readers and the
  existing operations timer can converge it without a second scheduling
  system.
- `output_behavior` (with `update_existing`) and the list filters are kept as
  accepted local extensions: they were added against an SDK surface ahead of
  the published doc, and a caller holding an SDK that already sends them sees
  working behaviour rather than an unexpected refusal. If the published doc
  later documents them, this section's wording moves, not the behaviour.

## 6. Corresponding tests

- `tests/unit/dream-shape.test.ts` — create-param validation (inputs shape, session
  id bounds and dedup/sort, instructions bound, model forms, output_behavior)
  and row projection.
- `tests/integration/dreams.test.ts` — create/retrieve/list/cancel/archive over
  real HTTP, input-store copy semantics, session-id audit surface, validation
  failures, state transitions, partial-output retention, and the
  `update_existing` single-writer conflict.
- `tests/conformance/official-route-coverage.test.ts` — the dreams routes are
  mounted and SDK-decodable rather than refused.

## 7. Status

`supported` — all five published routes are mounted and functional, the
lifecycle and output/cancel/archive semantics match the published contract,
and the remaining deltas (no beta gate, `sess_` pipeline ids, no Console UI or
webhook events) are documented in §4.
