# CMA Contract — environment work

Contract area: `/v1/environments/{id}/work` — the self-hosted worker's
session-work surface.
Status: `partial`. Both planes are implemented over the local tool-execution
queue — the data plane (poll, ack, heartbeat, update, stop) and the
management reads (list, retrieve, stats). `partial` because the projection
carries documented deltas (item granularity, per-item TTL, forced stop, the
stats' lease-based meaning), not because any route is refused.
Source: `src/api/routes/environment-work.ts`,
`src/core/auth/session-work-tokens.ts`,
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
  claiming the lease on the first beat; `POST /work/{id}` merges a metadata
  patch; `stop` requests graceful or forced shutdown; `retrieve`, `list`, and
  `stats` are the management read surface.
- The published state enum is `queued | starting | active | stopping |
  stopped`.
- Authentication is the environment worker key on the management-facing side,
  and on the claimed item the `sessions_token` inside its `secret` — never the
  account credential.

## 2. Current SandBase shape

The data plane lives in `src/api/routes/environment-work.ts`, mounted ahead of
the refusal router in `src/api/server.ts`, and projects the local
`WorkQueue` in `src/sandbox/self-hosted-provider.ts` — which is a
tool-execution queue, not a session queue — onto the published work item.
Three storage additions back it: `work_items.metadata` and
`work_items.heartbeat_at` from migration 061 in `src/core/db/migrations.ts`,
and `session_work_tokens`, the per-claim bearer table.

- `GET .../work/poll` claims the oldest claimable item scoped to the
  environment named in the path, honoring `block_ms` (1–999, a real
  long-poll) and `reclaim_older_than_ms` (default 5000). An empty queue
  answers `204`. The claimed item's `secret` is minted per claim: a fresh
  `mawt_...` session token hashed into `session_work_tokens`, wrapped in the
  published `BetaWorkSecret` shape with `api_base_url` set to this runtime's
  origin so the runner's downstream calls come back here. `secret` is null on
  every other path.
- `POST .../work/:id/ack` is the queue's `accept` fence under the published
  name: claimed, inside its lease, unstopped, and — when the
  `Anthropic-Worker-ID` header is present — held by that worker. A stopped or
  lapsed item answers `409 work_lease_lost`.
- `POST .../work/:id/heartbeat` renews the lease and maintains the heartbeat
  anchor as a separate epoch (`heartbeat_at`), because the published first
  beat presents `NO_HEARTBEAT` to claim a lease that poll deliberately does
  not create. A stale `expected_last_heartbeat` answers `412` carrying the
  server's `current_state` under `error.details.current_state`, the shape the
  official runner reads. A stopped or terminal item answers `200` with
  `lease_extended: false` and the projected state — the shutdown signal.
- `POST .../work/:id` merges `metadata` key-by-key (`null` deletes, omitted
  preserves) and returns the item. It is the published update verb only —
  result reporting stays on the local `/v1/x/worker/complete` channel.
- `POST .../work/:id/stop` writes the same stop marker the local
  session-stop writes: the item can never be claimed again and the holder
  learns from its next heartbeat. `force` is read but selects nothing —
  the marker is already the immediate form.
- `GET .../work` lists the environment's items newest-first with the
  published `{data, next_page}` page shape: `limit` bounds the page (1–200,
  default 50) and `page` carries the keyset cursor the route issued for the
  previous page — opaque base64url JSON over the row's
  `(created_at, rowid)` pair, the same pair the ordering uses, so a page
  boundary cannot skip or repeat rows sharing a second. A malformed `limit`
  or a cursor this route did not issue is `400`, not a silent rewind.
- `GET .../work/:id` returns one item through the same item-scope fence as
  the item verbs: environment mismatch answers 404, and a session token
  reads only its own session's items.
- `GET .../work/stats` answers the published `work_queue_stats` shape:
  `depth` counts what a poll could hand out now (unclaimed, or claimed past
  the queue lease), `pending` counts claimed-but-unacknowledged work inside
  its lease, `oldest_queued_at` is the oldest row in that live population,
  and `workers_polling` counts identities seen on `poll` inside 30 seconds.
- Authentication accepts the environment worker key, the claimed item's
  `mawt_` session token (scoped to the item's own session), or a managed API
  key — resolved by the route itself because the global API-key middleware
  exempts this prefix so worker bearers reach it. A credential scoped to a
  different environment is refused; when no API keys are configured the route
  inherits the runtime's open local-first posture.
- The session token is item authority, not queue authority: `poll`, `list`,
  and `stats` refuse it outright, while the item routes — `ack`,
  `heartbeat`, `update`, `stop`, and `retrieve` — admit it only for its own
  session's items.

## 3. Alignment

Aligned for: all eight published routes and their wire shapes, the published
state enum, `204` on an empty poll, per-claim `secret` in the `BetaWorkSecret`
shape, `NO_HEARTBEAT` lease claiming, `expected_last_heartbeat` optimistic
concurrency with a `412` the official runner decodes, metadata merge
semantics, `{data, next_page}` cursor listing the SDK's `PageCursor`
iterates, the `work_queue_stats` field set, and environment-scoped
worker-key authentication.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Item granularity | The queue underneath is tool-call-scoped, not session-scoped. `data` is always `{type: "session", id}` — the session every local item belongs to — and the per-call payload stays on the local worker channel. One session's items are individual work units, not one session-level claim. |
| `started_at` | Equals `accepted_at`: the queue has no separate "execution began" signal, so the commit timestamp stands in for both fields. |
| `desired_ttl_seconds` | Read but not honored per item: the lease is a queue-level constant and the heartbeat response reports the effective `ttl_seconds`. |
| `force` on stop | No distinct forced mode exists locally; the stop marker is already immediate. The field is validated, not ignored. |
| Result channel | The published surface has no result field; completions and failures travel on `POST /v1/x/worker/complete`, which keeps its own worker identity and lease fences. |
| `latest_heartbeat_at` | The official heartbeat anchor only (`heartbeat_at`). The local claim timestamp is not reported as a heartbeat. |
| Stats backing | The published counters are Redis stream metrics; here they read the lease columns: `pending` is a claim inside its lease, `depth` is everything claimable (including a claim whose lease ran out), and dead population — stopped rows and ended sessions — counts in neither. `workers_polling` is an in-memory 30-second window, empty after a restart, which matches the metric's own definition. |
| List ordering | Newest first (`created_at, rowid` descending); the published contract does not state an order. The `page` cursor is an opaque base64url keyset issued by this route — stable under concurrent enqueues, not a generic cursor for other surfaces. |
| Open-mode auth | When no API keys are configured, a request carrying no credential is allowed — the runtime's local-first posture — while a presented credential must still validate. |

## 5. Reason for the difference

- The local queue predates the published surface and owns real safety
  semantics the projection must not weaken: claim is a lease, accept is the
  execution commitment, a lapsed *accepted* claim moves to `unknown` rather
  than being silently replayed, and a stopped item can never be claimed again.
  Mapping `ack` onto `accept` keeps the replay fence exactly where it was.
- `heartbeat_at` is a separate column because the published protocol anchors
  the heartbeat lease at the first beat, not at poll — `claimed_at` is already
  set by then, so reusing it would make `NO_HEARTBEAT` unmatchable and every
  first beat would 412.
- The stats counters are computed from the lease columns rather than a
  stream's lag/PEL bookkeeping because the queue has no stream to measure —
  the lease is the closest honest equivalent, and it partitions the live
  population the same way the published definitions do.
- `GET /work/poll` must register before `GET /work/:workId` in the route
  table: the router serves literal matches in registration order, so the
  parameter route would otherwise read `poll` as a work id. `stats` precedes
  it for the same reason.

## 6. Corresponding tests

- `tests/integration/environment-work-data-plane.test.ts` — poll claims and
  the `204` empty path, environment scoping, per-claim secret issuance and
  session-token authentication, ack transitions and lease refusal, heartbeat
  renewal with `NO_HEARTBEAT` and `412` precondition failure, stop signaling
  through `lease_extended: false`, metadata merge, and the SDK decoding the
  response shapes.
- `tests/integration/environment-work-management-plane.test.ts` — list
  ordering, keyset cursor pagination including the same-second collision
  case, retrieve scoping, session-token item vs queue authority, the stats
  counters' lease-based meaning, and the SDK's `list`/`retrieve`/`stats`
  decoders.
- `tests/integration/self-hosted.test.ts` — the queue semantics the
  projection rests on: lease, accept, reclaim, stop, and the `unknown` sweep.
- `tests/conformance/official-route-coverage.test.ts` — every official route
  is mounted, and nothing in the work family remains a refusal.

## 7. Status

`partial`. Every published route in the family is mounted and answered; the
remaining deltas are semantic — the `session`-only `data` projection, the
queue-level lease standing in for per-item TTL, the single stop mode, and
the lease-derived stats — each recorded in §4 rather than hidden.
