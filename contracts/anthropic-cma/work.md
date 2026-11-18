# CMA Contract — environment work

Contract area: `/v1/environments/{id}/work` — the self-hosted worker's
session-work surface.
Status: `partial`. Both planes are implemented over a real session-claim
store — the data plane (poll, ack, heartbeat, update, stop) and the
management reads (list, retrieve, stats) — and the claim unit is the
published one: a whole session, with the parked per-call items as the work a
held claim *contains*. `partial` because a handful of documented deltas
remain (the `started_at` projection, the stats' lease-based meaning, the
separate result channel), not because any route is refused.
Source: `src/api/routes/environment-work.ts`,
`src/sandbox/session-work-queue.ts`,
`src/core/auth/session-work-tokens.ts`,
`src/core/auth/session-work-scope.ts`,
`src/core/auth/environment-worker-keys.ts`,
`src/sandbox/self-hosted-provider.ts`.

<!-- capability-status
environment-work: partial
-->

---

## 1. Official definition

- A work item is a session-scoped unit a self-hosted worker claims. `poll`
  long-polls the queue and returns one item whose `secret` carries the
  per-claim credential (`{sessions_token, api_base_url?}` as base64url JSON);
  `ack` moves it `queued → starting`; `heartbeat` keeps the lease, with
  `expected_last_heartbeat` as optimistic concurrency and `NO_HEARTBEAT`
  claiming the lease on the first beat, and accepts `desired_ttl_seconds` as
  the claim's requested TTL; `POST /work/{id}` merges a metadata patch;
  `stop` requests graceful or forced shutdown; `retrieve`, `list`, and
  `stats` are the management read surface.
- The published state enum is `queued | starting | active | stopping |
  stopped`.
- The calls a claimed session contains — `exec`/`tool_call`/`custom_tool`/
  `read`/`write`/`list` — are drained under the held claim, never claimed
  individually on this wire.
- Authentication is the environment worker key on the management-facing side,
  and on the claimed item the `sessions_token` inside its `secret` — never the
  account credential.

## 2. Current SandBase shape

The data plane lives in `src/api/routes/environment-work.ts`, mounted ahead
of the refusal router in `src/api/server.ts`, and projects
`SessionWorkQueue` in `src/sandbox/session-work-queue.ts` — a real
session-claim store, held in its own `session_work_claims` table from
migration 064 in `src/core/db/migrations.ts` — onto the published work item.
`session_work_tokens` is the per-claim bearer table, now carrying a
`claim_id` that binds each minted `mawt_` to the claim that issued it. The
per-call `work_items` rows keep their own lease/accept/`unknown`/stop fences
and become the calls a held claim contains.

The claim lifecycle is `queued → claimed → accepted → stopping → stopped`,
and it is deliberately **not** the `work_items` chain on the same table —
the two lifecycles have different post-commit rules, so a single sweep would
have to guess which claim it was acting on. A session claim is re-claimable
after its lease lapses because its content is server-recorded parked calls
(a new worker resumes rather than replays a side effect), while an accepted
per-call item must go `unknown` because it *is* the side effect. The partial
unique index on `session_id WHERE status != 'stopped'` enforces one live
claim per session; a stopped row frees the session for a NEW claim, which is
what makes "the session's work is queued again" possible.

- `GET .../work/poll` claims the oldest claimable session claim scoped to
  the environment named in the path — live (non-`stopped`, session not
  terminal) and either never held or held under a lapsed lease — honoring
  `block_ms` (1–999, a real long-poll) and `reclaim_older_than_ms`
  (default 5000, the unacknowledged-claim window). The lapse window is
  two-valued on purpose, matching the published split: an unacknowledged
  `claimed` claim is reclaimed by the caller's window, while an `accepted`/
  `stopping` claim is governed by its own TTL. An empty queue answers `204`.
  The claimed item's `secret` is minted per claim: a fresh `mawt_...`
  session token bound to `claim_id`, wrapped in the published
  `BetaWorkSecret` shape with `api_base_url` set to this runtime's origin so
  the runner's downstream calls come back here. `secret` is null on every
  other path.
- `POST .../work/:id/ack` is the published commitment point: the claim must
  still be held, inside its lease, unstopped, and — when the
  `Anthropic-Worker-ID` header is present — held by that worker. A stopped
  or lapsed claim answers `409 work_lease_lost`. Re-acknowledging is
  idempotent for the holder.
- `POST .../work/:id/heartbeat` renews the claim lease and maintains the
  heartbeat anchor as a separate epoch (`heartbeat_at`), because the
  published first beat presents `NO_HEARTBEAT` to claim a lease that poll
  deliberately does not create. `desired_ttl_seconds` is honored per claim:
  it restamps `ttl_seconds`, and the response reports the effective TTL. A
  stale `expected_last_heartbeat` answers `412` carrying the server's
  `current_state` under `error.details.current_state`, the shape the
  official runner reads. A stopped or terminal claim answers `200` with
  `lease_extended: false` and the projected state — the shutdown signal.
- `POST .../work/:id` merges `metadata` key-by-key (`null` deletes, omitted
  preserves) and returns the claim. It is the published update verb only —
  result reporting for contained calls stays on the local
  `/v1/x/worker/complete` channel.
- `POST .../work/:id/stop` reads `force` as the real distinction: a graceful
  stop marks the claim `stopping` so the holder finishes or cancels its
  in-flight call and confirms, while `force: true` writes `stopped` at once.
  A second stop on a `stopping` claim is the confirmation that completes it.
  Either way the claim is never claimable again and the `mawt_` bound to it
  is revoked; the contained items are not marked `stopped_at` — a session
  that produces more work earns a new claim, and its parked calls must still
  be answerable under it.
- `GET .../work` lists the environment's claims newest-first with the
  published `{data, next_page}` page shape: `limit` bounds the page (1–200,
  default 50) and `page` carries the keyset cursor the route issued for the
  previous page — opaque base64url JSON over the row's
  `(created_at, rowid)` pair, the same pair the ordering uses, so a page
  boundary cannot skip or repeat rows sharing a second. A malformed `limit`
  or a cursor this route did not issue is `400`, not a silent rewind.
- `GET .../work/:id` returns one claim through the same item-scope fence as
  the item verbs: environment mismatch answers 404, and a session token
  reads only its own session's claim.
- `GET .../work/stats` answers the published `work_queue_stats` shape:
  `depth` counts what a poll could hand out now (unclaimed, or held past its
  reclaim window/lease), `pending` counts claimed-but-unacknowledged work
  inside its window, `oldest_queued_at` is the oldest row in that live
  population, and `workers_polling` counts identities seen on `poll` inside
  30 seconds. Stopped claims and dead sessions' claims count in neither.
- The claimed item's `data` is `{type: "session", id}` — the session the
  claim serves — and the published states collapse onto the claim's markers:
  `stopped`/`stopping` are the real rows, `accepted` reads `starting` until
  the first heartbeat lands then `active` (the `heartbeat_at` column's
  presence, not a timestamp compare, decides — a poll, ack, and first beat
  inside one second would otherwise compare equal), and both unheld and
  held-unacknowledged read `queued` because the published surface has no
  separate "held but not yet acknowledged" state — that population is what
  `pending` counts.
- Authentication accepts the environment worker key, the claimed item's
  `mawt_` session token (scoped to the claim's own session), or a managed
  API key — resolved by the route itself because the global API-key
  middleware exempts this prefix so worker bearers reach it. A credential
  scoped to a different environment is refused; when no API keys are
  configured the route inherits the runtime's open local-first posture.
- The session token is item authority, not queue authority: `poll`, `list`,
  and `stats` refuse it outright, while the item routes — `ack`,
  `heartbeat`, `update`, `stop`, and `retrieve` — admit it only for its own
  session's claim.
- The contained calls drain under the held claim on the local
  `/v1/x/worker` channel: `POST /v1/x/worker/claim-session` acquires (or
  re-acquires) the session's live claim for a `worker run` process —
  materializing it if missing, holding it, and acknowledging it in one step
  so the drain gate sees `accepted` — and `POST /v1/x/worker/claim` then
  hands out that session's parked items. A `session_id`-scoped claim is
  gated on `drainableBy` (the caller holds the session's `accepted`, live
  claim); an unscoped claim draws only from sessions the worker already
  claims, so a process that holds nothing can never be handed a call.
- Beyond the work family the same `mawt_` bearer is the worker's
  session-level credential — the published worker flow holds nothing else.
  `src/core/auth/session-work-scope.ts` admits it on exactly the calls the
  runner makes: `GET /v1/sessions/{id}` for its own session (the `resources`
  list is what tells the worker which stores to materialize), the session's
  event list and stream (`GET .../events`, `GET .../events/stream`), the
  event answer channel (`POST .../events`, fenced in the route to
  `user.tool_result` and `user.custom_tool_result` — the token cannot steer,
  speak for the user, or declare an outcome), and the `memories`
  sub-resources of every memory store the session attached
  (`/v1/memory_stores/{id}/memories[/{memoryId}]`). A store attached
  `access: "read_only"` admits the reads and refuses the writes with `403
  permission_error`; every other route — a different session, an unattached
  store, the store-level memory routes, or anything else — answers `401`,
  and the token stops authenticating the moment its session reaches a
  terminal state or its claim is stopped or re-claimed.
- The queue also carries two tool-answer kinds beside
  `exec`/`read`/`write`/`list`. `custom_tool`: when a session on a self-hosted
  environment persists `agent.custom_tool_use`, the session's sandbox enqueues
  the call as work — payload `{tool_name, tool_use_id, input}` — and a worker
  runs it through the tools it was started with; the recorded completion is
  injected back into the session as the call's `user.custom_tool_result`. See
  [`custom-tools.md`](./custom-tools.md). `tool_call`: when a session on a
  self-hosted environment persists a builtin `agent.tool_use` that is not
  confirmation-gated, the session's sandbox enqueues it the same way — the
  published "your integration provides `agent_toolset` results" semantic — and
  the recorded completion is injected back as the call's `user.tool_result`.

Aligned for: all eight published routes and their wire shapes, the
session-scoped claim unit, the published state enum, `204` on an empty poll,
per-claim `secret` in the `BetaWorkSecret` shape, `NO_HEARTBEAT` lease
claiming, `expected_last_heartbeat` optimistic concurrency with a `412` the
official runner decodes, `desired_ttl_seconds` retuning the claim's lease,
graceful/forced stop as a real distinction, metadata merge semantics,
`{data, next_page}` cursor listing the SDK's `PageCursor` iterates, the
`work_queue_stats` field set, environment-scoped worker-key authentication,
the per-claim `sessions_token` authorizing the runner's session-level calls
(session retrieve, event list/stream/answers, attached memory stores with
`read_only` enforced), and the contained per-call items drained under a held
claim through `custom_tool` and `tool_call`.

## 4. Differences

| Difference | Detail |
| --- | --- |
| `started_at` | Equals `accepted_at`: the claim's ack is the commit the published surface reports as the start of service, and there is no separate "execution began" marker on the claim row. |
| Contained-item drain | The per-call items a held claim contains are drained on the local `/v1/x/worker` channel (and the session's event stream), not on this wire — the published surface has no verb for them, which is the correct reading, but the channel itself is local. A session claim that lapses is re-claimable rather than `unknown`; the `unknown` sweep applies only to the contained `work_items`, which are the actual side effects. |
| Result channel | Work update is metadata-only. The official SDK answers built-in calls through session `user.tool_result`, which this runtime accepts for a builtin call it parked for the worker (`tool_result_not_pending` / `tool_result_invalid` name the refusals: an unissued id, a call the runtime ran, a confirmation-gated call, a duplicate, or a malformed body). Local completions and failures travel on `POST /v1/x/worker/complete`, which keeps its own worker identity and lease fences. |
| `latest_heartbeat_at` | The official heartbeat anchor only (`heartbeat_at`). The claim timestamp is not reported as a heartbeat. |
| Stats backing | The published counters are Redis stream metrics; here they read the claim's lease columns: `pending` is a held-unacknowledged claim inside its reclaim window, `depth` is everything claimable (including a claim whose lease ran out), and dead population — stopped rows and ended sessions — counts in neither. `workers_polling` is an in-memory 30-second window, empty after a restart, which matches the metric's own definition. |
| List ordering | Newest first (`created_at, rowid` descending); the published contract does not state an order. The `page` cursor is an opaque base64url keyset issued by this route — stable under concurrent enqueues, not a generic cursor for other surfaces. |
| Open-mode auth | When no API keys are configured, a request carrying no credential is allowed — the runtime's local-first posture — while a presented credential must still validate. |

## 5. Reason for the difference

- The claim lives in its own table because its lifecycle is genuinely
  different from the `work_items` chain, not merely renamed. A session claim
  that lapses is safe to re-claim — its content is server-side parked calls,
  so a fresh worker resumes them — while an accepted per-call item must go
  `unknown` once its window passes because it is the side effect and a
  silent replay is the failure the fence exists to prevent. Two lifecycles
  on one sweep would have to guess which claim a row was, so they do not
  share a table; the partial unique index on `session_id WHERE status !=
  'stopped'` is what makes the claim's "one live claim per session, freed on
  stop" rule enforceable without resurrecting a terminal row.
- `heartbeat_at` is a separate column because the published protocol anchors
  the heartbeat lease at the first beat, not at poll — `claimed_at` is
  already set by then, so reusing it would make `NO_HEARTBEAT` unmatchable
  and every first beat would 412.
- `stopping`/`stopped` are real claim states because the published `force`
  distinction is real: graceful exists to let the in-flight call finish
  before the claim retires, and a forced stop is the immediate form. A
  single "stop means stopped" model would either kill in-flight work on a
  graceful request or delay a forced one.
- The stats counters are computed from the lease columns rather than a
  stream's lag/PEL bookkeeping because the queue has no stream to measure —
  the lease is the closest honest equivalent, and it partitions the live
  population the same way the published definitions do.
- `GET /work/poll` must register before `GET /work/:workId` in the route
  table: the router serves literal matches in registration order, so the
  parameter route would otherwise read `poll` as a work id. `stats` precedes
  it for the same reason.

## 6. Corresponding tests

- `tests/unit/session-work-queue.test.ts` — the claim lifecycle at the store:
  poll/ack/heartbeat/force-stop as one chain, `NO_HEARTBEAT` then echoed-
  anchor renewal, the reclaim window vs the claim TTL, one-holder mutual
  exclusion, `drainableBy` gating, graceful-then-confirming stop, the NEW
  claim after stop, `mawt_` revocation on reclaim and stop, terminal-session
  retirement, and the stats counters' claim-based meaning.
- `tests/integration/environment-work-data-plane.test.ts` — poll claims and
  the `204` empty path, environment scoping, per-claim secret issuance and
  session-token authentication, ack transitions and lease refusal, heartbeat
  renewal with `NO_HEARTBEAT` and `412` precondition failure, stop signaling
  through `lease_extended: false`, metadata merge, graceful vs forced stop,
  the NEW claim a stopped session's next work earns, and the SDK decoding
  the response shapes.
- `tests/integration/environment-work-management-plane.test.ts` — list
  ordering, keyset cursor pagination including the same-second collision
  case, retrieve scoping, session-token item vs queue authority, the stats
  counters' lease-based meaning, and the SDK's `list`/`retrieve`/`stats`
  decoders.
- `tests/integration/worker-poll-cli.test.ts` — the worker side end to end:
  `worker poll` claims the session on `work/poll`, acks it, drains its
  contained calls under `drainableBy`, and heartbeats the claim between
  items; `worker run` acquires the claim through `/claim-session` (or
  continues the poller's handed claim), drains the session only, and exits
  on claim-stop, session-end, or the idle bound.
- `tests/integration/worker-custom-tools.test.ts` — the `custom_tool` kind
  end to end: enqueue on persisted `agent.custom_tool_use`, claim/complete
  through the worker routes, `user.custom_tool_result` injection and resume,
  error/duplicate/ended-session behavior, and worker-side tool registry.
- `tests/integration/session-work-token-scope.test.ts` — the token's
  session-level scope: its own session's retrieve, event list, and stream;
  tool-answer events admitted while steer/message/outcome refuse `403`;
  attached store list/read/write with `read_only` refusing writes; another
  session's routes and unattached stores refused `401`; and the token dead
  the moment its session ends.
- `tests/integration/self-hosted.test.ts` — the per-call queue semantics the
  contained items keep: lease, accept, reclaim, stop, and the `unknown`
  sweep.
- `tests/conformance/official-route-coverage.test.ts` — every official route
  is mounted, and nothing in the work family remains a refusal.

## 7. Status

`partial`. Every published route in the family is mounted and answered, and
the claim unit is the published session scope with a real lifecycle —
`poll`/`ack`/`heartbeat`/`stop` operate on one claim object that the
contained calls drain under. The remaining deltas are semantic: the
`started_at` projection, the contained-item drain living on the local
worker channel rather than this wire, the separate result channel, and the
lease-derived stats — each recorded in §4 rather than hidden.
