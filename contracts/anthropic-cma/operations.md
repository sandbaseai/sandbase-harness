# CMA Contract — operations

Contract area: the operational surface that runs without a caller driving it —
webhook subscriptions and their delivery behaviour, and scheduled deployments.
Status: `partial` for both, see §4 and §7.
Source: `src/api/routes/operations.ts`,
`src/core/operations/webhook-dispatcher.ts`,
`src/core/operations/webhook-signature.ts`, `src/core/operations/cron.ts`,
`src/core/operations/scheduler.ts`, `src/core/operations/outcome-evaluator.ts`.

<!-- capability-status
webhook-subscriptions: partial
scheduled-deployment-timers: partial
outcome-evaluation: supported
-->

---

## 1. Official definition

Two published documents cover this area:

- **Webhooks.** A subscription is created with a URL and a list of event names.
  A delivery is a *reference*, not the resource: the body is
  `{type: "event", id, created_at, data}`, where the root `type` is the literal
  `event` and the event's own name and subject live in
  `data.type` / `data.id`. The receiver performs a `GET` by that pair to read
  current state. Requests carry `webhook-id`, `webhook-timestamp` and
  `webhook-signature`; the signature is a Standard Webhooks `v1,<base64>`
  HMAC-SHA256 computed over `id + "." + timestamp + "." + body`. Delivery
  retries up to three times per endpoint and event with 5–120 s jittered
  exponential backoff, and the same `event.id` is carried on every attempt so a
  receiver can deduplicate. An endpoint is automatically `disabled` with a
  machine-readable `disabled_reason` on a `3xx` (never followed), on a URL that
  resolves to a non-public address, or after a sustained duration of failures —
  and a single `2xx` resets that window. Disabling is reversible; events
  published while disabled are not replayed.
- **Scheduled deployments.** A deployment is a stored session template plus a
  cron cadence and a timezone. Triggers produce deployment-run records with a
  `trigger_context` (`schedule` with `scheduled_at`, or `manual`). Lifecycle
  changes are published as `deployment.*` and `deployment_run.*` webhook
  events. The failure behaviour is asymmetric by design: a rate-limited session
  creation is recorded as a run and *not* retried (the next cadence tries
  again), an archived *child* agent or other unrecoverable session-creation
  failure records a failed run and *auto-pauses* the deployment with
  `paused_reason.error.type` mirroring the run's `error.type`, and the
  deployment's *own* agent being archived or deleted auto-archives the
  deployment in the same operation **without** recording a run.

## 2. Current SandBase shape

Webhooks live under `/v1/webhooks`, mounted at both `/v1` and `/v1/x` by
`src/api/server.ts`, so the compatibility mirror is real. Subscriptions are
created, read, updated and archived over REST, and `operations.ts` adds a
test-delivery route, a delivery list, a manual `POST /webhooks/dispatch` and a
manual `POST /webhooks/retry-due`. There is no disable or re-enable route, and
nothing in the runtime writes `webhooks.status` after creation: a subscription
is created `active` (the schema default) and stays `active` until archived.

`webhook-dispatcher.ts` is the delivery engine:

- `dispatchWebhookEvent` selects `archived_at IS NULL AND status = 'active'`
  rows, matches the event name against each subscription's `events` array by
  exact name, and delivers synchronously, returning one delivery record per
  match. The `*` and `prefix.*` wildcard spellings are gone rather than merely
  unused: `POST` and `PUT` under `/v1/webhooks` validate every entry against
  `OFFICIAL_WEBHOOK_EVENTS` (`src/core/operations/webhook-events.ts`, the
  `BetaWebhook*EventData.type` union transcribed from
  `@anthropic-ai/sdk@0.131.0` minus the four names this runtime can never
  produce — the `session.thread_*` family and `agent.deleted`) and answer
  `400` naming each unrecognized entry, so a stored subscription can only
  ever name an event the published contract defines and this runtime can
  raise.
- `makePayload` builds the published envelope
  `{type: 'event', id, created_at, data: {type, id, organization_id, workspace_id, ...}}`.
  The root `type` is the literal `event`, the root `id` is the `whe_` webhook
  event id, and the event's own name and subject live in `data.type` /
  `data.id`, so the body is the published reference: a receiver resolves the
  resource by that pair rather than trusting a snapshot. `organization_id` and
  `workspace_id` are the local constants `org_local` / `wrkspc_local`, and
  event-specific extras (such as `vault_id`) merge into `data` beside them.
  A session-derived event gets a deterministic `whe_` id —
  `sessionEventWebhookId` hashes the stream event id and the webhook event
  name — so one stream event can raise more than one webhook event without two
  deliveries sharing a `webhook-id`.
- Two sources raise events, and both pass through the catalog. Session stream
  events reach the dispatcher through a broadcast listener the runtime installs
  (`operations-bridge.ts`), which fires and forgets because it runs on the hot
  path of every session event — but only after `webhookEventsForSessionEvent`
  projects the durable event onto the published names. A stream event with no
  published counterpart (`agent.message`, `user.message`, `span.model_request_*`,
  `session.usage`, `session.error`) is dropped, so a subscription sees catalog
  names and nothing else. One stream event can raise two webhook events — an
  idle with `stop_reason.type: "budget_reached"` raises `session.status_idled`
  and `session.budget_reached` — and the budget companion fires at most once
  per `(session, budget value)`, so a session that idles twice on the same
  ceiling reports it once while a raised ceiling re-arms it. Operations events
  have no stream, so the route that causes one publishes it through
  `src/api/routes/operation-events.ts`, which awaits the attempt: these are rare
  control-plane calls, and waiting means the delivery row exists before the
  caller is told the state change succeeded. Both sources end in
  `dispatchWebhookEvent`, so matching, signing, retries and delivery rows behave
  identically; only the place the event is raised differs. A failing delivery
  never fails the state change — the result is discarded and a rejection caught.
- The catalog names the runtime emits — every catalog name has a producer:

  | Family | Emitted | Published names refused at subscription |
  | --- | --- | --- |
  | sessions | `session.created`, `session.pending`, `session.updated`, `session.archived`, `session.deleted`, `session.status_run_started`, `session.status_idled`, `session.status_rescheduled`, `session.status_terminated`, `session.running`, `session.idled`, `session.requires_action`, `session.budget_reached`, `session.outcome_evaluation_ended` | `session.thread_*` (refused — no multiagent surface) |
  | agents | `agent.created`, `agent.updated` (a new version only), `agent.archived` | `agent.deleted` (refused — no delete route) |
  | environments | `environment.created`, `environment.updated` (a changed field only), `environment.archived`, `environment.deleted` | — |
  | vaults | `vault.created`, `vault.archived`, `vault.deleted`, `vault_credential.created`, `vault_credential.archived`, `vault_credential.deleted`, `vault_credential.refresh_failed` (OAuth refresh at the MCP connect boundary) | — |
  | memory stores | `memory_store.created`, `memory_store.archived`, `memory_store.deleted` | — |
  | deployments | `deployment.created`, `deployment.updated`, `deployment.paused`, `deployment.unpaused`, `deployment.archived`, `deployment.deleted` | — |
  | deployment runs | `deployment_run.started`, `deployment_run.succeeded`, `deployment_run.failed` | — |

  Session lifecycle events that have no stream event of their own —
  `session.created`, `session.pending` (every session begins `queued`), and
  `session.archived` — are published on the transition:
  the REST routes through `operation-events.ts`, and a timed run that
  materialized a session from `runDueScheduledDeployments`, so a repeated
  archive and a failed run raise nothing. `session.updated` and
  `session.deleted` ride the stream because the session manager already writes
  those durable events. A vault archive
  publishes one `vault_credential.archived` per live credential alongside the
  vault's own event, per the published table.
- A **timed** run publishes `deployment_run.started` and then exactly one of
  `deployment_run.succeeded` / `deployment_run.failed`, and all three name the same
  run: `data: {type: 'deployment_run', id: <run id>}`, the id of the
  `scheduled_deployment_runs` row. The published table states that the outcome's
  `data.id` is the same as the run's `deployment_run.started` id, which is why the
  three names are one behaviour rather than three. `succeeded` is raised for a run
  whose row is `created_session` and `failed` for `failed`; the two never both
  fire. **A manual run publishes nothing** — including
  `POST /v1/deployments/{id}/run` with `trigger_type: "scheduled"`, because that
  field is caller-supplied and the published rule is about the kind of run, not
  about what the caller calls it. The rule therefore lives on the timed path
  (`runDueScheduledDeployments`, reached by the background tick and by
  `POST /v1/deployments/run-due`) rather than on the shared `runSchedule`, so a
  manual run cannot declare its way into a timed-only rule.
- `deployment_run.started` is published once the run is **recorded**, before its
  outcome and not at the instant it begins. `runSchedule` is synchronous and writes
  its row in a single terminal statement, and the published handler contract tells
  a receiver to branch on `data.type` and fetch the resource by `data.id`, so
  publishing earlier would send that fetch to a 404 for a run that had genuinely
  started. The event is late, which a receiver can act on, rather than early and
  false. Delivery is best-effort: a subscriber that cannot be reached is recorded
  and retried by the dispatcher and never stops a due deployment from running or
  abandons the rest of the pass.
- `deployment.archived` carries the same `data: {type: 'deployment', id}`
  reference, and is published by a successful archive **after** the row is
  written, so a receiver that resolves the reference at delivery time sees
  `archived_at` set rather than an unarchived deployment. It is published only
  when the archive actually happened: `archiveById` filters `archived_at IS NULL`,
  so a repeat archive is a **404** rather than a quiet success, and that 404 is
  how this runtime expresses the no-op rule the published table states for the
  sibling resource — archiving an already-archived environment emits nothing.
  Archiving a webhook or an outcome still publishes nothing, because no published
  archived event exists for those resources; the shared helper now reports
  whether it archived anything and each caller decides, which is what keeps one
  definition of "did the archive happen" instead of a second copy of the guard.
- `deployment.created` carries the same `data: {type: 'deployment', id}`
  reference, and is published by a successful create **after** the row is
  inserted, so a receiver that resolves the reference when the event arrives finds
  the deployment rather than a 404. A create refused for a missing `name`, a
  missing or unknown agent, a missing `environment_id`, absent or empty
  `initial_events`, a schedule with the wrong field count, or an invalid time
  zone returns before the row exists and publishes nothing — there is no id to
  name. A deployment **created already `paused`** publishes only this event: the
  pause events report a transition, and nothing moved here, so
  `deployment.paused` would assert a transition that did not happen. The receiver
  learns the status by resolving the reference, which is the mechanism the
  published contract supplies for exactly this.
- `deployment.updated` carries the same `data: {type: 'deployment', id}`
  reference, and is published by the update route (`POST` or `PUT /{id}`) when
  it changes at least one caller-visible field: `name`, `description`, `agent`,
  `environment_id`, `initial_events`, `resources`, `vault_ids`, `budget`,
  `schedule`, `next_run_at`, or `metadata`. A write that changes none of them
  publishes nothing, which is the rule the published table states for the sibling
  resource's update event ("无操作的更新不会发出任何事件"). Two exclusions are
  deliberate. `status` and `paused_reason` belong to the pause transition, which
  has dedicated events and which the two pause routes also perform — if this
  event covered them, `POST /{id}/pause` would have to publish
  `deployment.updated` as well, contradicting the published design of a dedicated
  event for that transition. And `updated_at` moves on every write by
  construction, so counting it would make the no-op rule unreachable. The stored
  `payload` and `metadata` are compared **structurally** rather than as text:
  they are serializations, so a text comparison would report a change for the
  same object re-sent with its keys in another order — a change the caller did
  not make and cannot avoid, since they do not know the order the server wrote.
  `equalJsonObject` in `operation-helpers.ts` is that comparison. One `PUT` can
  change both a field and the pause state, in which case both events are
  published, one per change.
- `deployment.paused` and `deployment.unpaused` carry
  `data: {type: 'deployment', id}`, which is the reference shape the published
  contract describes by `data.type` / `data.id`. They are published only when
  the pause state actually changes: the pause route is deliberately idempotent,
  so a repeat pause is the ordinary retry path, and the published table states
  the same rule for the nearest comparable event — archiving an already-archived
  environment emits nothing. `deployment.paused` has two causes — a requested
  pause and the automatic pause the scheduler performs after an unrecoverable
  trigger failure — and both route through the same publish path.
- **The pause state has three doors, and the decision to publish lives in one
  place.** `POST /{id}/pause`, `POST /{id}/unpause`, and the `status` field of
  `PUT /{id}` all write it. `publishPauseTransition(deps, id, previous, next)`
  in `operation-events.ts` owns the rule — publish `deployment.paused` when the
  state becomes `paused`, `deployment.unpaused` when it becomes `active`, and
  nothing when it does not change — and every one of the three routes calls it
  with the state it read before writing and the state it wrote. The update route
  previously wrote `status` directly and published nothing, so a pause through it
  produced the durable state and told no subscriber. Keeping the rule in one
  function is also what stops the three doors from disagreeing: a route cannot
  omit the decision, only pass the wrong pair of values. The events are derived
  from the stored state, so the sequence holds whichever route performs each
  transition.
- Every attempt sends the published `webhook-id`,
  `webhook-timestamp` and `webhook-signature` headers, the last computed by
  `webhookDeliverySignature` over `id.timestamp.body`. `webhook-id` is the
  event id inside the body — what a receiver deduplicates on — and
  `x-sandbase-webhook-endpoint-id` carries the subscription id the body no
  longer names. The legacy `X-Managed-Agents-Signature` header is gone: a
  receiver verifying the old `sha256=` body HMAC sees an unsigned delivery, so
  the removal is recorded in the changelog rather than shipped silently. The
  stored `signature` column holds the `v1` value of the latest attempt. A retry
  keeps the same event id and `webhook-id` — read back out of the stored
  payload, so a `webhook_event` row written before this change falls back to
  the delivery id rather than crashing — and re-signs with its own timestamp,
  so the published header set is continuous across attempts.
- Each subscription is signed with its own `whsec_` secret, minted by `M038` when
  the subscription is created and returned by that response only; the row keeps it
  encrypted with the same AES-256-GCM store the credential vaults use. A
  subscription written before `M038` holds no secret and keeps the legacy
  derivation — the workspace data-directory value this runtime used before
  per-endpoint secrets existed — because inventing one during the migration would
  silently invalidate every receiver still verifying with the old key.
- Rotating a subscription mints a new secret and keeps the previous one valid — the
  `secret_previous_*` columns of `M039` — so every delivery carries both signatures,
  current first, until the window closes. The window is bounded: `M059`'s
  `secret_previous_since` stamps when it opened, and once it has been open for the
  deployment's configured duration the previous secret is retired — dropped from
  the row, not just filtered from the header — by the next delivery's signing pass
  or by the retry tick's sweep, whichever comes first. `retire-secret` remains the
  manual early close, and a window opened before `M059` has no recorded start, so
  it keeps manual-retire behaviour rather than expiring on a clock nobody chose.
  The previous secret is replaced
  rather than accumulated, so rotating twice without retiring leaves one window
  rather than a growing list, and rotating a subscription that had no stored secret
  is the call that takes it off the legacy derivation, which is why the new value is
  returned by that response alone.
- `nextRetryAt` doubles a ceiling per attempt — 60 s, then 120 s — and draws
  the delay uniformly between 5 s and that ceiling, with `maxAttempts`
  defaulting to 3. The jitter source is injectable (`opts.random`) so the
  window is asserted deterministically.
- `retryDueWebhookDeliveries` takes `pending_retry` rows whose `next_retry_at`
  has elapsed, joined to a non-archived active subscription, and re-attempts up
  to 50 of them.
- A failure is recorded on the delivery row (`pending_retry` until the ceiling,
  then `failed`). The subscription carries the failure streak
  (`webhooks.failing_since`) and, when one of the three disable rules below
  fires, its `status` and `disabled_reason`.

The runtime composes an operations bridge at startup: it registers a broadcast
listener that projects every durable session event to the matching subscriptions,
re-arms the forward schedule of active deployments, and starts one 60-second tick
that retries due deliveries and runs due deployments. `POST /v1/webhooks/dispatch`
and `POST /v1/webhooks/retry-due` remain for a caller that wants a pass on demand.
Three disable rules are implemented. The first published one: an attempt that observes a
`3xx` sets the endpoint to `disabled` with `disabled_reason` exactly
`auto-disabled: endpoint URL returned a redirect (3xx)`, and that attempt is terminal
rather than retried. The redirect is never followed — `postWebhook` sends with
`redirect: 'manual'` — because the address is chosen by the subscriber, so following one
would have the payload replayed wherever that subscriber likes with the `webhook-*`
signature headers still attached and still valid for the body. The second: an attempt
whose endpoint host is an internal name or resolves to a private address is refused
before any connection, with the published reason
`auto-disabled: endpoint URL resolved to an invalid address` — but only when the
deployment turns the screening on (`MANAGED_AGENTS_WEBHOOK_SCREEN_PRIVATE_ADDRESSES`),
because loopback is a private address and a self-hosted receiver normally shares the host;
see §4 for why that default is a recorded deviation rather than an oversight. The third:
an endpoint whose deliveries fail without interruption for at least the local window is
disabled with the published reason
`auto-disabled after sustained delivery failures`, and that attempt is terminal. The
published trigger for it is the *duration* of uninterrupted failure rather than a delivery
count, and a `2xx` resets the window, so the streak is stored (`webhooks.failing_since`,
migration 044) rather than counted in memory, and the success path writes the reset. The
contract states the trigger's shape but not its length, so the window is a **local
parameter** — ten minutes by default, settable per deployment with
`MANAGED_AGENTS_WEBHOOK_SUSTAINED_FAILURE_WINDOW_SECONDS`, and recorded at startup —
rather than a conformed value; see §4. The published `2xx` reset of that
window is implemented — it is the success path's write, not a separate rule, and the
published contract names no other reset. The published 5–120 s jittered exponential
backoff is implemented as well.

Scheduled deployments live in `src/api/routes/deployments.ts` and are mounted at
**both** `/v1/deployments` (the published spelling) and `/v1/scheduled-deployments`
(the historical local one). One factory, two mounts: the routes are declared
relative to the mount, so the pair cannot diverge route by route. The module
exposes create, read, update (`POST` and `PUT` share one handler: `POST` is the
published verb, `PUT` the local spelling), archive, `POST /:id/run`,
`GET /:id/runs`, `POST /run-due`, `POST /:id/pause` and `POST /:id/unpause`. It is
a separate module rather than part of `operations.ts` because that file also
serves `/webhooks` and `/outcomes` from one router, and making its paths
relative to alias the deployments would have placed those families under
`/v1/deployments/` too.

A deployment answers with the **published object shape**: `type: 'deployment'`,
a `depl_` id, `agent: {type, id, version}` pinned at create, `environment_id`,
`initial_events`, `resources`, `vault_ids`, `budget`, `metadata`, a `schedule`
object (`{type: 'cron', expression, timezone, last_run_at, upcoming_runs_at}` or
`null` for a manual-only deployment), `status`, `paused_reason`,
`created_at`/`updated_at`, and `archived_at`. The stored columns keep their
local spellings; the projection renames on the way out. The local flat request
aliases (`agent_id`, `cron`, `timezone`, `next_run_at`, `payload`) are still
accepted on write, so an existing caller does not break.

Creating a deployment requires `name`, an agent reference, `environment_id` and
a non-empty `initial_events` list. The admission is
`normalizeInitialEvents(value, {allowSystemMessage: true})` — the same
normalizer sessions use, with the deployment-only third type `system.message`
added, since a deployment is privileged enough to seed context. A run then
hands the list to `sessionManager.createWithInitialEvents`, so the session a
deployment materializes starts exactly as an API-created one does; a
`system.message` is injected as context but does not open a turn.

A deployment's lifecycle state is `active` / `paused` / `archived`, and `paused`
carries a reason. `POST /:id/pause` writes `{"type": "manual"}` and
`POST /:id/unpause` clears it; an automatic pause after an unrecoverable
trigger failure writes
`{"type": "error", "error": {"type": <classified error>, "message": <message>}}`.
The create and update routes derive the same value from the status they write,
so a deployment cannot read as paused with no reason merely because it was
paused through a different route. Archive is a separate axis: archiving a paused
deployment leaves `status` reporting `paused`, because the published object
carries both fields and one does not erase the other. Pausing suppresses
scheduled triggers only — a manual `run` still works, and an archived
deployment is a 404 on every route rather than a paused one.

A deployment's **runs** are a second module, `src/api/routes/deployment-runs.ts`,
mounted once from `operations.ts` at `/deployment_runs`. It is a top-level
resource in the published contract with its own id, not a sub-path of a
deployment, so it cannot be a path alias of the nested `GET /deployments/{id}/runs`:
that route answers a different question, and a path alias cannot express a
top-level collection narrowed by a query parameter. Mounting it from
`operationsRoutes` is what gives it the `/v1/x/deployment_runs` mirror with the
legacy envelope for free, and why one registration serves both.

The run projection is a **read view**: `schedule_id` becomes `deployment_id`,
`started_at` becomes `created_at`, and run ids are minted with the published
`drun_` prefix on the way in and out. `agent` is joined from the session the run
created, so it is the agent that ran and the version it ran as; a run that
failed before a session existed has no recorded version, so it reports the
deployment's pinned `agent_version` rather than a guess. `error` is lifted from
the stored `{error, error_type}` pair into the published `{type, message}`
object with the classified vocabulary the scheduler wrote
(`environment_archived_error`, `vault_not_found_error`, …; a row written before
classification reports `unknown_error`), and `trigger_context` carries
`scheduled_at` once the scheduler records the due instant it matched on the run
row.

`scheduler.ts` is the run engine:

- `nextCronRun` refuses an unrecognized zone rather than defaulting to UTC and
  delegates the arithmetic to `cron.ts`.
- `runDueScheduledDeployments` selects active, unarchived rows whose
  `next_run_at` is due and runs each one.
- `runSchedule` **preflights** the deployment's dependencies before touching a
  session: the bound agent, the environment, every vault id, every file
  resource, and the memory store are each checked, and each failure maps onto
  the published error vocabulary (`agent_archived_error`,
  `environment_not_found_error`, `environment_archived_error`,
  `vault_not_found_error`, `vault_archived_error`, `file_not_found_error`,
  `memory_store_archived_error`). An error the normalizer or session manager
  throws during creation is classified too — the session-creation rejection a
  caller refused becomes `session_creation_rejected_error`, and anything
  unclassified lands as `unknown_error`.
- The published asymmetry is implemented: a **missing or archived agent**
  archives the deployment and records **no run**; a **recoverable
  `session_rate_limited_error`** records a failed run and nothing else; every
  other classified failure records a failed run **and auto-pauses** the
  deployment with `paused_reason: {type: 'error', error: {type, message}}`
  mirroring the run's `error`.
- The session is created through `sessionManager.createWithInitialEvents` with
  the deployment's pinned agent version, environment, title, resources,
  `vault_ids`, memory-store context, budget and `initial_events`, and the run
  row records `scheduled_at` — the due instant the trigger matched — alongside
  `started_at`. Success advances `last_run_at` / `next_run_at`; a manual run
  advances neither the last-run timestamp nor the cadence.

`timezone` is a real column on `scheduled_deployments` (migration `M037`) and
`scheduleTimeZone` reads it, falling back to `UTC` for a row written before the
column existed. The create and update routes validate the name, so a stored
schedule is always evaluable. The deployment routes publish `deployment.created`,
`.updated`, `.paused`, `.unpaused` and `.archived`, and the timed path publishes
`deployment_run.started`, `.succeeded` and `.failed`; §4 records the scope of each.

## 3. Alignment

Alignment is partial, and asymmetric between the two sub-areas.

**Cron semantics — aligned.** `cron.ts` evaluates a five-field expression in the
deployment's IANA zone, a wall time inside a spring-forward gap yields no run
rather than a shifted one, and a fall-back overlap resolves to its first
instant. `nextCronRun` refuses an unknown zone, and `M037` plus the route-level
validation means the stored zone is the zone the cadence actually runs in.

**Signature arithmetic — wired through.**
`webhook-signature.ts` implements the published scheme: `whsec_` + base64 key
derivation, `id.timestamp.body` as the signed content, `v1,<base64>` output, a
constant-time verifier, and a space-separated rotation window.
`verifyWebhookDelivery` recomputes the signature, so the format is asserted
rather than assumed. The header set is wired into every attempt: `webhook-id`
is the event id inside the body, a retry keeps it and carries its own
timestamp, and the persisted `signature` column records the `v1` value of the
latest attempt.

**The deployment surface is now the published one, object and lifecycle
alike.** A deployment answers at the published `/v1/deployments*` as well as
the local `/v1/scheduled-deployments*` from one router mounted twice, with the
published object shape, the published update verb (`POST`, with `PUT` kept as
the local spelling), `initial_events` driving session creation, the
`drun_`-identified run resource at `/v1/deployment_runs*`, classified run
errors, `trigger_context.scheduled_at`, the asymmetric failure behaviour
(auto-pause on an unrecoverable cause, auto-archive with no run when the agent
is gone), and the deployment lifecycle events. What still differs is narrower:
the private-address default, the catalogue names with no producing surface,
and the entries §4 records.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Delivery payload envelope | Now the published body: `{type: "event", id, created_at, data: {type, id, organization_id, workspace_id}}`, verified end-to-end by the official SDK's `client.beta.webhooks.unwrap` (conformance test §6). `organization_id` / `workspace_id` are the local constants `org_local` / `wrkspc_local` — a real org/workspace does not exist locally, and the constants keep the field set a receiver destructures. `data.type` carries the published event name: the session stream is projected through `webhookEventsForSessionEvent` rather than forwarded raw, so the names a receiver sees are the catalog's. |
| Event coverage | Every catalog name has a producer — the per-family split is the table in §2. The coarse session lifecycle names ride the durable status events: `session.pending` fires at creation because a session begins `queued`, `session.running` accompanies `session.status_run_started`, and a `session.status_idle` raises `session.idled` — or `session.requires_action` when its `stop_reason.type` is `requires_action`, because a parked session is waiting on an answer, not idle. The four published names with no producing surface — the `session.thread_*` family (no multiagent surface) and `agent.deleted` (no delete route) — are **refused at subscription** like any name outside the catalog, because a stored subscription that can never fire reads as a working one; the refusal is the honest answer and the names re-enter the catalog when their surface exists. |
| `deployment.paused` causes | Both published causes are implemented: a requested pause writes `paused_reason: {"type": "manual"}`, and an unrecoverable trigger failure writes `{"type": "error", "error": {"type": <run's error.type>, "message": <message>}}` in the same operation that records the failed run. The recoverable case (`session_rate_limited_error`) records the run and does **not** pause, matching the published rule. The event is raised only when the state changes, so a repeat pause is silent. |
| `deployment.created` scope | Emitted by both mount prefixes of the create route. A create refused before the insert publishes nothing. A deployment created already `paused` is reported by `deployment.created` alone, not by `deployment.paused`: that pair reports a transition, and a resource coming into existence paused has not moved from anything. |
| `deployment.archived` causes | Both published causes are implemented. The direct one is the archive route. The cascade is the scheduler's preflight: a timed pass that finds the bound agent missing or archived archives the deployment and records **no run** — the published "at the next scheduled run" timing, made real by `cron` being nullable since `M052`, which also gives "a deployment with no schedule" its representation (`schedule: null`). A manual `run` on a deployment whose agent is gone answers `409` and archives it too, with `deployment.archived` published in both paths. `POST /v1/agents/{id}/archive` itself still touches no `scheduled_deployments` row, so the cascade fires at the next trigger or manual run, not eagerly at the agent's archive — the same delay the published rule describes. |
| `deployment.deleted` | Emitted by `DELETE /v1/deployments/{id}` (and the `/v1/scheduled-deployments` twin), which removes the deployment and its run records in one transaction and answers `{id, type: "deployment_deleted"}`. The event is published after the write — the published row states it is the final result because there is no object to fetch, and that ordering makes it so. Sessions a run created are independent resources and survive the delete; only the run rows, which carry the deployment's hard `schedule_id` foreign key, are removed. |
| `deployment.updated` scope | Emitted by the update route (`POST` or `PUT /{id}`) for the writable-field changes listed in §2. It does **not** cover the pause state or `updated_at`, for the reasons given in §2 — the pause transition has its own events and `updated_at` moves on every write. The published trigger ("部署属性已更改") is broader than that on its face, so this is a recorded narrowing rather than full coverage; the alternative would be one call reporting two events a receiver did not ask to be distinguished by. A change to the schedule's derived `next_run_at` counts, because it is a field the update writes and a caller reads. |
| No-op events | A repeat pause or resume raises nothing, because nothing changed. The published table states this rule explicitly for `environment.archived` ("对已归档的环境再次归档不会发出任何事件") and for `environment.updated` ("无操作的更新不会发出任何事件"); the same rule is applied to a `PUT` that changes no field, and to these two, rather than a second rule invented. |
| Automatic disable | All three published cases are implemented. The `3xx` case: an attempt that observes a redirect disables the endpoint with `disabled_reason` **exactly** `auto-disabled: endpoint URL returned a redirect (3xx)`, on the first attempt or on a retry that observes one, and that delivery is terminal — no retry is scheduled, and the retry-due pass returns nothing for it even a day later, because the published contract states a response that triggers auto-disable is never retried while the three-attempt ceiling still applies to every other failure. The private-address case: implemented, but **opt-in per deployment** rather than unconditional (see the next row for the switch and the reason). `disabled_reason` is reported only while the endpoint is disabled in both cases, and `PUT /v1/webhooks/{id}` clears it when an operator re-enables the endpoint, so an active endpoint never advertises a resolved reason. The disable is reachable and reversible, which is the order these landed in: the dispatcher already selected `status = 'active'`, so disabling before a re-enable path existed would have taken an endpoint that retried forever and made it permanently dead. The third case: an endpoint whose deliveries fail without interruption for at least the local window is disabled with `disabled_reason` **exactly** `auto-disabled after sustained delivery failures`, and that attempt is terminal too — on a first attempt or on a retry, which is where it usually fires, because the retries are what carry a streak across the window. The published reason for this case has a different form from the other two (no `: ` and no parenthetical) and is written verbatim rather than normalised. The published `2xx` reset of this window is implemented as the success path's write, and no other reset exists in the published contract — an earlier version of this row ended by calling that reset absent, which contradicted the sentence before it. The published jittered `5–120` s exponential backoff is implemented too; see the retry backoff row.
| Sustained-failure window (local value) | The published contract states the **shape** of this trigger and not its value: the condition is the duration of uninterrupted failure rather than a delivery count, and a `2xx` resets the window, but no length is published. This runtime defaults to **10 minutes**, recorded as a **local parameter** rather than as a conformed value, and a deployment sets its own with `MANAGED_AGENTS_WEBHOOK_SUSTAINED_FAILURE_WINDOW_SECONDS` (whole seconds, `1` to `2592000`; anything else is refused rather than clamped, because a window of zero would disable an endpoint on its first failure). The value in force is **recorded by the runtime at startup** as `webhook_disable_window` with the window and whether it came from the deployment, from the default, or was refused — a deployment-level variable has no write path of its own, so that record is its change trail. Two consequences are deliberate: the streak is **stored** (`webhooks.failing_since`, migration 044) because an in-process counter would reset on every restart and the rule would never fire in the deployment it exists for, and the **success path writes the reset**, so repeated failures interrupted by any `2xx` never accumulate toward a disable. Re-enabling an endpoint clears the streak, so a recovered endpoint starts a fresh window instead of returning already overdue. |
| Private-address rule | **Implemented behind an opt-in deployment switch, off by default** — a recorded deviation from the published case, which is unconditional. With `MANAGED_AGENTS_WEBHOOK_SCREEN_PRIVATE_ADDRESSES` set to an affirmative value, an attempt whose endpoint host is an internal name (`localhost`, `.local`, `.internal`, …) or resolves to any address the shared `address-policy.ts` classifier calls private is **not connected at all**: the endpoint is disabled with the published reason `auto-disabled: endpoint URL resolved to an invalid address`, the attempt is terminal, and a resolver answer mixing public and private addresses is refused rather than raced. Why opt-in: loopback *is* a private address, this runtime is local-first, and its receiver is normally on the same host — every webhook test in this repository delivers to a loopback listener — so enforcing the rule by default would disable the receiver a self-hosted deployment exists to talk to, and the dispatcher selects `status = 'active'`, so it would take working setups and switch them off. The published rule is written for a hosted control plane whose subscribers are necessarily remote and whose destination can be chosen by something other than the operator; here an authenticated operator chooses the URL, which is also why `web_fetch`'s strict default is right for `web_fetch` and not transferable to this path. When the switch is on, same-host delivery no longer works — that is what turning it on means. |
| Retry backoff | Aligned with the published 5–120 s jittered exponential backoff: the ceiling doubles per attempt (60 s, then 120 s) and each delay is drawn uniformly between 5 s and that ceiling, so endpoints that fail together do not retry together. The three-attempt ceiling matches the published one, and the published rule that a response triggering auto-disable is never retried holds for all three disable cases: the attempt that triggers one is terminal, first attempt or retry alike. |
| Secret rotation | A window is opened by `POST /v1/webhooks/{id}/rotate-secret` and closed either by `POST /v1/webhooks/{id}/retire-secret` or by the window's configured duration running out, with both signatures carried in `webhook-signature` while it is open. The published contract names no duration, so this is a local parameter: the default is **24 hours**, a deployment sets its own with `MANAGED_AGENTS_WEBHOOK_ROTATION_WINDOW_SECONDS` (whole seconds, `1` to `2592000`; anything else is refused rather than clamped), and the value in force is recorded at startup as `webhook_rotation_window`. Retirement drops the previous secret from the row — it is enforced where a signature is produced, on the first attempt and on a retry, and the retry tick also sweeps windows that expired while no delivery was due. A window opened before `M059` has no recorded start and never auto-expires: retiring it remains the operator's call, the same way `M038` refused to invent secrets for pre-secret rows. |
| Delivery trigger | The runtime's own bridge ticks every 60 seconds and projects each durable event as it is broadcast, so an unwatched runtime delivers; `POST /webhooks/dispatch` and `POST /webhooks/retry-due` remain for on-demand passes. The tick is when a due retry is picked up; the retry delay itself follows the retry backoff row. |
| Subscription management surface | REST under `/v1/webhooks` with the `/v1/x` mirror. `PUT /{id}` is the enable/disable surface: it writes the published `status` field, and omitting it leaves the stored value unchanged like every other field in that partial update, so a rename cannot silently re-enable an endpoint an operator switched off. |
| Webhook event vocabulary | Subscriptions name events from `OFFICIAL_WEBHOOK_EVENTS` — the 44-name union transcribed from `BetaWebhook*EventData.type` in `@anthropic-ai/sdk@0.131.0`, minus the four names this runtime can never produce (`session.thread_*` and `agent.deleted`). Both write paths (`POST /v1/webhooks`, `PUT /v1/webhooks/{id}`) refuse a name outside it, including the `*` and `prefix.*` spellings the dispatcher used to honour, with `400` naming the offenders. The session stream is projected: `session.status_running` arrives as `session.status_run_started` and `session.running`, `session.status_idle` as `session.status_idled` plus `session.idled` — or `session.requires_action` when the idle's `stop_reason.type` is `requires_action`, and `session.budget_reached` when it names `budget_reached`, deduplicated per session and budget value — `span.outcome_evaluation_end` as `session.outcome_evaluation_ended`, and every other stream event is dropped — `agent.message`, `user.message`, `span.model_request_*`, `session.usage` and `session.error` are session telemetry, not webhook events. |
| Deployment endpoint paths | Both spellings are served: the published `/v1/deployments` and the historical local `/v1/scheduled-deployments`. They are one router mounted twice (`src/api/routes/deployments.ts`), so they cannot diverge route by route, and the local spelling is neither deprecated nor redirected. The published update verb `POST /v1/deployments/{id}` is aliased onto the same handler `PUT` serves, so a client written against the published verb works; the two verbs are indistinguishable by response. |
| Deployment control surface | Create, read, update, archive, manual run, run-due, **pause and unpause**. `POST /{id}/pause` records `paused_reason: {"type": "manual"}`; `POST /{id}/unpause` clears it and resumes from the next scheduled instant. Pause suppresses the scheduler and leaves the `run` endpoint open, which the published contract requires. The automatic pause after a non-recoverable trigger failure **is** implemented, so `paused_reason` holds `manual` or the `error` form mirroring the failed run's `error.type` — a caller can tell "paused by a person" from "paused by the runtime" and from "not paused". |
| Deployment object shape | The response carries the published object: `type: 'deployment'`, `depl_` ids, `agent` as `{type, id, version}` pinned at create (falling back to the agent's current version when no historical version row exists, the same resolution a session snapshot performs), `environment_id`, `initial_events`, `resources`, `vault_ids`, `budget`, `metadata`, and a `schedule` object with `last_run_at` and `upcoming_runs_at` — the next three instants while the deployment is active, empty once archived. `schedule` is `null` for a deployment with no cadence (`cron` is nullable since `M052`). The local flat write aliases (`agent_id`, `cron`, `timezone`, `next_run_at`, `payload`) remain accepted on create and update; `payload` keeps its stored column for compatibility, and `M052` copies a `payload.title` into `metadata` when metadata has none. A legacy row written before `initial_events` existed projects `initial_events: []` — the honest answer, since the runtime did not record startup events for it and its next run will fail with `session_creation_rejected_error` rather than inventing a template it never had. |
| Paused semantics | A paused deployment still accepts a manual `run`. The route previously refused any status but `active`, which was reachable only through `paused` — the one status `定时部署.md:490` says must still run. The scheduler path was already correct (`runDueScheduledDeployments` selects `status = 'active'`), so pause already suppressed timed runs and only the manual path was wrongly closed. Unpausing does not catch up missed triggers: a stored `next_run_at` that has already passed is recomputed forward, and one still in the future is left alone. |
| Pause reason | `paused_reason` is a column added by `M042`, derived from `status` on every write path (create and update included) so the two cannot disagree. It reads `null` on a row that was paused before the migration, rather than back-filling `manual`: the runtime did not observe who paused it, and an invented reason would be indistinguishable from an observed one. |
| Deployment run collection | `GET /v1/deployment_runs` and `GET /v1/deployment_runs/{id}` exist and carry the published field names. `deployment_id`, `has_error`, `trigger_type` (`schedule`/`manual`, translated onto the stored `scheduled`), and the `created_at[gt/gte/lt/lte]` bounds are implemented, and a parameter outside that set is **refused by name** rather than ignored. The published reference page that would list every filter is not available offline, so a further *published* filter would still be refused as unknown — which is the honest failure, but it is a refusal this runtime would be wrong about rather than a silently unscoped answer. |
| Deployment run error type | The published vocabulary is emitted: the scheduler's preflight classifies `environment_not_found_error`, `environment_archived_error`, `vault_not_found_error`, `vault_archived_error`, `file_not_found_error`, `memory_store_archived_error` and `agent_archived_error` from the row's own references, and creation-time throws become `session_creation_rejected_error`, `session_rate_limited_error` or `unknown_error`. A run row written before `M052` added `error_type` reports `unknown_error`, which is the honest answer for "the runtime did not classify this". One vocabulary member has no producing path here: `mcp_egress_blocked_error` — MCP egress is not gated by this runtime, so no failure can reach it. |
| Deployment run trigger context | `trigger_context.type` is `schedule` for a timed run (the runtime stores `scheduled`) and `manual` for a hand-triggered one, passed through unchanged because the published docs show only the timed case. `trigger_context.scheduled_at` is **recorded**: the scheduler persists the due instant the pass matched on the run row (`scheduled_at`, `M052`), so a schedule run reports the cron instant it answered rather than the wall-clock moment execution began. Rows written before the column existed report the type alone. |
| Deployment run agent | `agent` is `{type, id, version}` taken from the session the run created, so both are the ones that ran. On a failed run there is no session, so `id` is the deployment's current agent and `version` its pinned `agent_version` — `null` for a row written before pinning existed. Persisting the resolved agent on the run row at attempt time is a separate change. |
| Deployment run ids | Run ids are minted `drun_`, matching the published sample. Rows written before the rename keep their `srun_` ids — an id is opaque to a client and already recorded in session metadata, so it is not rewritten. |
| Deployment run event cause | Only a **timed** run raises `deployment_run` events. `runSchedule` is shared by the timed path and the manual route, and the manual route's `trigger_type` is caller-supplied, so the rule is enforced by publishing from the timed path (`runDueScheduledDeployments`, reached by the background tick and by `POST /v1/deployments/run-due`) rather than by testing the trigger type; keying off `trigger_type === 'scheduled'` would let `POST /v1/deployments/{id}/run {"trigger_type":"scheduled"}` emit. `deployment_run.started` is published once the run is **recorded**, before its outcome, not at the instant it begins: `runSchedule` is synchronous and writes its row in a single terminal statement, and the published handler contract has a receiver fetch the resource by `data.id`, so publishing earlier would send that fetch to a 404 for a run that had genuinely started. There is no persisted in-progress run state for `started` to point at, and adding one is a change to the run status vocabulary rather than to this event. |
| Trigger representation | `trigger_type` is stored on the run row and the published `trigger_context` is projected from it, carrying `scheduled_at` once the scheduler records the due instant, as the run trigger context row above records. |
| Session startup | Implemented: the deployment's `initial_events` are admitted at create (with `system.message` allowed alongside `user.message` and `user.define_outcome`) and each run calls `sessionManager.createWithInitialEvents`, which injects a `system.message` as context without opening a turn and queues the user events that do. A `system.message`-only list creates an idle session by design. |
| Failure behaviour | Asymmetric, per the published design: a missing or archived bound agent archives the deployment and records no run; a recoverable `session_rate_limited_error` records a failed run and nothing else; every other classified failure records a failed run **and** auto-pauses the deployment with `paused_reason.error` mirroring `run.error`. The cadence advances on every outcome so a failing deployment does not retry inside one pass. |
| Re-arming after downtime | A startup step: the operations bridge recomputes the forward `next_run_at` of every active deployment whose stored time is missing or has passed (`rearmScheduledDeployments`), and its 60-second tick runs the rows that fall due. A trigger missed while the process was stopped is deliberately not replayed. |
| Outcome evaluation | The published contract has no deterministic outcome evaluator; `evaluateDeterministicOutcome` is a local extension used by the operations routes. |
| Collection envelope | The operations collections are canonical `/v1` resources: under `/v1` they carry `{data, prev_page, next_page}`, and the `/v1/x` mirror they were first published on keeps the local `has_more` / `first_id` / `last_id` shape for its existing consumers. The shape is chosen per mount rather than per endpoint. |

## 5. Reason for the difference

- The runtime implemented the operations *resources* first — a subscription
  table, a delivery table, a schedule table, a run table — and the published
  contract describes the hosted service's *lifecycle* behaviour on top of the
  same resources. The gap is behavioural, not structural, which is why the
  entries are `partial` rather than `unavailable`.
- The private-address disable rule is opt-in rather than default-on. The
  published rule defends a multi-tenant service against agent-authored URLs,
  and a self-hosted runtime pointing a webhook at `127.0.0.1` is exactly the
  case a default-on rule would break; §4 records the switch and its
  consequence.
- The runtime owns the delivery loop now, and owns its shutdown story with it: the
  timer is `unref`'d so it cannot keep a process alive on its own, and the runtime
  stopper clears it. The earlier caller-driven design avoided that responsibility
  at the cost of delivering nothing while nobody polled, which is the trade this
  replaces.
- The deployment failure asymmetry is implemented as a preflight step rather
  than by inspecting a thrown session error: the bound agent, environment,
  vaults, file resources and memory store are checked in order before a session
  is attempted, because a bare thrown `Error` cannot carry the cause
  ("environment archived" and "environment missing" arrive identically). The
  check is read-only, and anything the preflight cannot classify lands as
  `unknown_error` rather than being guessed.
- Fire-and-forget remains the right disposition for both: a webhook delivery
  must not be able to fail a turn, and a deployment runs on its own cadence.

## 6. Corresponding tests

- `tests/unit/webhook-signature.test.ts` — secret minting (`whsec_` + base64,
  distinct per call), key derivation (decoded bytes, unprefixed raw UTF-8, and
  the malformed-body fallback), coverage (the `v1,<base64>` form and
  `id.timestamp.body` binding), verification (a correctly signed delivery, a
  tampered body, id or timestamp, a wrong secret, an empty header, and any
  signature in a rotation window), and the published header names.
- `tests/unit/webhook-dispatcher.test.ts` — dispatch to matching active
  subscriptions with a stored signed delivery record, the exact published
  envelope key set (`{type, id, created_at, data}` with
  `{type, id, organization_id, workspace_id}` inside `data`), `webhook-id`
  equal to the event id, no legacy signature header, and a retry keeping the
  event id while re-signing with its own timestamp.
- `tests/conformance/webhook-unwrap.test.ts` — a real delivery to a live
  receiver verified by the official SDK's `client.beta.webhooks.unwrap`, and a
  one-byte body mutation rejected by the same call.
- `tests/unit/webhook-events.test.ts` — the catalog itself (the SDK union
  minus the names nothing produces, no wildcards, uniqueness), the refusal helper's order-preserving offender
  list, every row of the stream projection including the `budget_reached`
  companion on `metadata.stop_reason`, the internal events that must drop, and
  the budget dedup key.
- `tests/integration/webhook-event-catalog.test.ts` — the subscription boundary
  and the emission rules end to end: `*`, `prefix.*`, and unknown names refused
  on create and update with the stored list untouched; every catalog name
  accepted; a mixed stream delivering only the published names a subscription
  listed; `session.budget_reached` once per budget value and again after the
  ceiling moves; environment create/change/no-op/archive covering the
  `environment.*` family including the no-event-on-no-op and re-archive rules;
  `agent.updated` firing only when a new version is written; a vault archive
  raising one `vault_credential.archived` per credential; and the memory-store
  pair.
- `tests/integration/webhook-endpoint-secret.test.ts` — the secret returned once at
  creation and absent from every read, the row holding ciphertext that decrypts
  back to it (including from a second handle), a different secret per
  subscription, a test delivery signed with the endpoint's own secret, and a
  subscription written before `M038` still resolving to the legacy key.
- `tests/integration/webhook-secret-rotation.test.ts` — a rotation returns the new
  secret once and no read returns either value, a delivery carries the current
  signature first and the previous one second until `retire-secret` closes the
  window, a window that has run out retires the previous secret on the next
  signing pass and the retry tick sweeps one that expired with no delivery due,
  a pre-`M059` window with no recorded start stays on manual retirement,
  a second rotation replaces the window rather than appending to it, an
  unknown subscription is a 404, and a subscription with no stored secret gains one
  and leaves the legacy derivation behind.
- `tests/integration/operations-bridge.test.ts` — the broadcast
  listener projects a durable event to a matching subscription, the timers retry a
  due delivery and run a due deployment, a composed runtime has both a listener
  and a running timer that its stop function clears, and the startup re-arm
  restores a stale forward schedule while leaving a future one alone.
- `tests/unit/cron-timezone.test.ts` — the field grammar, the refusal of a
  malformed or out-of-range field and of an unknown zone, the same wall time
  resolving to different instants per zone, the instant moving across a DST
  boundary, a spring-forward gap reporting no run, and successive occurrences
  without a repeat.
- `tests/unit/scheduler.test.ts` — the next cron run, running due schedules
  while advancing `next_run_at`, the classified preflight failures, the
  auto-pause with a mirrored `paused_reason.error`, the recoverable
  `session_rate_limited_error` that does not pause, and the missing-agent
  archive that records no run.
- `tests/integration/scheduled-deployment-timezone.test.ts` — the stored
  `timezone` column and its `NOT NULL DEFAULT 'UTC'` shape, the zone being
  resolved into `next_run_at`, both accepted wire shapes (`cron` + `timezone`,
  and the nested `schedule` object), an unknown zone refused with no row
  written, cadence re-arming on update, and a runner-level check that two due
  rows differing only in `timezone` advance in their own zones.
- `tests/unit/outcome-evaluator.test.ts` — deterministic criteria evaluation and
  the honest unsupported result when no model provider exists.
- `tests/integration/deployment-pause-resume.test.ts` — pause recording
  `{"type": "manual"}` and unpause clearing it, the same on the create and update
  paths, a paused deployment still producing a **run record** from a manual `run`,
  the scheduler path producing none, missed trigger instants not being caught up
  (asserted by the absent run, not only by `next_run_at`), a future `next_run_at`
  left alone, idempotence, and an archived deployment 404ing on pause, unpause and
  run.
- `tests/integration/deployment-pause-events.test.ts` — the pause and resume
  events delivered to a real HTTP receiver on an ephemeral loopback port, with
  the recorded delivery asserted alongside the received request; the
  `{type: 'deployment', id}` reference; delivery to every matching subscription
  rather than the first; a subscription naming the event among several matching
  and an unrelated subscriber receiving nothing at all; both mount prefixes publishing; a repeat
  pause and a repeat resume raising nothing; and an unreachable subscriber
  leaving the pause committed with the failed attempt recorded for the retry
  sweep. Every assertion is scoped to the subscription its case created, because
  the fixture is shared and one pause is delivered to every matching
  subscription.
- `tests/integration/deployment-update-pause-events.test.ts` — the same two
  events reached through all three doors onto the pause state: `PUT` setting and
  clearing `status`, a `PUT` that re-sends the status already stored, a `PUT`
  that changes an unrelated field, and a `PUT` on a paused deployment that leaves
  it paused — none of which publish — plus the two pause routes asserted again
  because the refactor rewrote that code, a mixed sequence where the transition
  is derived from the stored state rather than from the route that acted, and
  both mount prefixes.
- `tests/integration/deployment-run-events.test.ts` — the timed-run lifecycle:
  `started` then `succeeded` in delivered order, both naming the *same* run id and
  that id being the row's own; resolvability of the run measured **inside the
  receiver** at delivery time, for the outcome and for `started`; the
  success/failure split asserted as exclusive (a failed run must not also report
  success) using a legacy row with empty `initial_events` so session creation
  genuinely throws; a manual
  run publishing nothing while still recording its run; **a manual run passing
  `trigger_type: "scheduled"`** publishing nothing, which is the case that
  distinguishes the path-based rule from the obvious one, since that field is
  caller-supplied; no due deployment publishing nothing; a subscription naming
  both run events receiving them while another family stays untouched; a subscriber on an
  unreachable port leaving **both** due runs executed *and* its failed attempts
  recorded for retry; and the background tick — the other door onto the timed path
  — reporting its runs too.
- `tests/integration/deployment-archived-event.test.ts` — `deployment.archived`
  published by a direct archive with a reference that resolves to an already
  archived row, measured **inside the receiver** so the ordering claim means
  something; a repeat archive asserted on **both** halves (the `404` and the
  silence), because either alone passes for the wrong reason; a 404 for an
  unknown id publishing nothing; both mount prefixes; a subscription naming the
  event among several reaching it while another family stays untouched; an unreachable
  subscriber leaving the archive committed; the agent-archived cascade —
  archiving the bound agent and running the due pass archives the deployment
  with `deployment.archived` delivered and **no run recorded**; and the webhook
  archive route still publishing nothing, which is
  what shows the shared helper's new outcome did not quietly change the two
  callers that publish nothing.
- `tests/integration/deployment-created-event.test.ts` — `deployment.created`
  published by a successful create with a reference that resolves, measured
  **inside the receiver** so the ordering claim means something (a read after the
  create returns would find the row either way); each of the four refusals
  publishing nothing; a deployment created already `paused` publishing the create
  and no pause event; both mount prefixes; a subscription naming the event among
  several reaching it while another family stays untouched; and an unreachable subscriber
  leaving the create committed.
- `tests/integration/deployment-updated-event.test.ts` — `deployment.updated`
  published for each writable field the update route accepts, each one asserted
  twice: once changed, once re-sent unchanged, so an emitter that fires on every
  write fails half of them. Plus the structural-comparison cases — the same
  `metadata` content in a different key order, and the same `initial_events`
  re-sent, neither of which is a change — next to the neighbour that does
  differ; an update sending back exactly
  what the resource holds, which an implementation counting `updated_at` would
  publish; an update changing both a field and the pause state, which publishes
  both events; an update changing only the pause state, which publishes only the
  pause event; both mount prefixes; an archived deployment still answering 404 in
  silence; and an unreachable subscriber leaving the update committed with the
  failed attempt recorded for the retry sweep.
- `tests/integration/deployment-runs-collection.test.ts` — the top-level run
  collection and item routes: the published shape on a run that really created a
  session, the `error` object and the agent fallback on one that really failed,
  both filters, the unusable-`has_error` refusal, the unfiltered ordering, the
  404, agreement with the nested route on every field both describe, and the
  legacy mirror's own envelope.
- `tests/unit/database.test.ts` — `M042` on a fresh workspace and on one that
  stopped at `M041`, where an already-paused deployment upgrades with no recorded
  reason rather than a back-filled one; and `M052` on a fresh workspace, on an
  old workspace's rows preserved across the rebuild, and on the `payload.title`
  → `metadata` move.
- `tests/integration/deployment-official-shape.test.ts` — the published object
  end to end: the `depl_`/`drun_` id prefixes and the exact published key set;
  the `environment_id` and non-empty `initial_events` admission including the
  deployment-only `system.message` and the `user.tool_confirmation` refusal;
  the pinned `{type, id, version}` agent; `POST` update semantics
  (description cleared by `null`, `schedule: null` removing the cadence,
  metadata key deletion); the published list filters; a manual run on a paused
  deployment with a `manual` trigger_context and a session that carries the
  initial events; an archived environment's run classified
  `environment_archived_error` and auto-pausing; an archived agent's run
  answering 409 with the deployment archived and no run recorded; and the
  `trigger_type` / `created_at` run filters.
- `tests/conformance/deployment-official-shape.test.ts` — the official SDK end
  to end over HTTP: `beta.deployments.create` → `run` → the run's session
  executing its `initial_events` to an agent reply, the `deploymentRuns`
  collection and item routes, and `update` through the published verb.
- `tests/integration/deployment-path-aliases.test.ts` — both deployment spellings
  over HTTP: a deployment created at the published path read back at both,
  identical lists, update and archive at the published path with archive hiding it
  from both, the short-circuit refusals (`run` on a non-active deployment, an
  unknown id) answering identically at both, every route reachable at the
  published prefix, no other resource family appearing under either prefix, and
  the `/v1/x` mirror still serving its own collection envelope for both spellings.
- `tests/unit/deployment-path-parity.test.ts` — the mounted route table gives
  every canonical deployment route a published twin and every published route a
  canonical one, every one of them still sourced from
  `src/api/routes/deployments.ts`, and no webhook or outcome route below either
  prefix.

## 7. Status

`partial` for the webhook half and close to `supported` for deployments.
Cron-in-zone, the signature arithmetic, the per-endpoint secret, the published
headers on every attempt, the background tick that delivers without a caller,
the `deployment.paused` / `deployment.unpaused` pair across all doors onto the
pause state, `deployment.updated` for the writable-field changes,
`deployment.created` on both mount prefixes, `deployment.archived` for **both**
causes — the direct route and the agent cascade at the next trigger — the three
`deployment_run.*` events for a timed run, the published `/v1/deployments`
surface with its object shape, `POST` update verb, `initial_events` admission
(including `system.message`), the `drun_` run resource at
`/v1/deployment_runs`, the classified run-error vocabulary,
`trigger_context.scheduled_at`, the asymmetric failure behaviour — no run and
auto-archive when the agent is gone, a failed run only for a recoverable
`session_rate_limited_error`, a failed run plus auto-pause for every other
unrecoverable cause — the jittered retry backoff, the redirect
and sustained-failure auto-disable rules, the published delivery envelope, the
catalog-bounded subscription vocabulary, the session-stream projection onto the
published names, and the resource lifecycle events across agents,
environments, vaults, memory stores and deployments are the aligned parts. The
private-address rule as a default (it is opt-in here), the
`mcp_egress_blocked_error` value with no producing path, the published catalog
names refused at subscription for having no producing surface
(`session.thread_*`, `agent.deleted`), and a persisted in-progress run state
are absent or differ, and are listed in §4 so that "covered by a contract" does
not read as "implemented". Neither entry is `supported`; neither is `unavailable`, because
the resource, the delivery engine, the scheduler and the run records are real
and exercised by the tests in §6. A client written against the published
deployment surface — the official SDK's `beta.deployments` and
`beta.deploymentRuns` — now works end to end, which the conformance test in §6
asserts over real HTTP; the webhooks and the refused unproducible names keep
the area `partial` as a whole.

The two `supported` entries in this area are different in kind from the pair
above: `outcome-evaluation` (this file) is a deterministic evaluator the
published contract does not define, and `outcome-grading` (recorded in
`sessions.md`) projects a declared outcome into a graded, self-revising loop.
They are supported because that behaviour is implemented and tested, not because
the published deployment contract is met. The status block at the top of this
file carries this file's three entries, so the two groups cannot be read as one.
