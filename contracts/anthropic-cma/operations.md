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
  rows, matches the event name against each subscription's `events` array
  (exact, `*`, or a `prefix.*` wildcard), and delivers synchronously, returning
  one delivery record per match.
- `makePayload` builds the local envelope
  `{type: 'webhook_event', id, event, webhook_id, data, created_at}`. The root
  `type` is the local `webhook_event` literal and the event name is a top-level
  `event` field, so the body is not the published reference envelope. The
  resource is not inlined, which is the one property it shares with the
  published shape.
- Two sources raise events. Session events reach the dispatcher through a
  broadcast listener the runtime installs (`operations-bridge.ts`), which fires
  and forgets because it runs on the hot path of every session event. Operations
  events have no such channel, so the route that causes one publishes it through
  `src/api/routes/operation-events.ts`, which awaits the attempt: these are rare
  control-plane calls, and waiting means the delivery row exists before the
  caller is told the state change succeeded. Both sources end in
  `dispatchWebhookEvent`, so matching, signing, retries and delivery rows behave
  identically; only the place the event is raised differs. A failing delivery
  never fails the state change — the result is discarded and a rejection caught.
- The event names the runtime can currently raise are therefore the session
  event types plus `deployment.created`, `deployment.paused`,
  `deployment.unpaused`, `deployment.updated`, `deployment.archived`,
  `deployment_run.started`, `deployment_run.succeeded`, and
  `deployment_run.failed`. **The
  rest of
  the published table is not emitted**: `agent.*`, `environment.*`, `vault.*`,
  `vault_credential.*`, and `deployment.deleted` are names a subscription may list
  and
  nothing produces. A subscription is accepted as written, so an unrecognized
  name is silent rather than refused. §4 records this.
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
  missing `agent_id`, a schedule with the wrong field count, or an invalid time
  zone returns before the row exists and publishes nothing — there is no id to
  name. A deployment **created already `paused`** publishes only this event: the
  pause events report a transition, and nothing moved here, so
  `deployment.paused` would assert a transition that did not happen. The receiver
  learns the status by resolving the reference, which is the mechanism the
  published contract supplies for exactly this.
- `deployment.updated` carries the same `data: {type: 'deployment', id}`
  reference, and is published by `PUT /{id}` when it changes at least one
  caller-visible field: `name`, `agent_id`, `environment_id`, `cron`, `timezone`,
  `next_run_at`, `payload`, or `metadata`. A write that changes none of them
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
  environment emits nothing. `deployment.paused` currently has one cause
  (a requested pause); it must also be raised by the automatic pause that §4
  records as unimplemented, which is why the publishing path was built before
  that cause exists.
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
- Every attempt sends the legacy `X-Managed-Agents-Signature`
  (`sha256=<hex>` over the body) *and* the published `webhook-id`,
  `webhook-timestamp` and `webhook-signature` headers, the last computed by
  `webhookDeliverySignature` over `id.timestamp.body`. The stored `signature`
  column holds the legacy value, so its meaning does not change with the header
  set. A retry keeps the delivery id and re-signs with its own timestamp, so the
  published header set is continuous across attempts.
- Each subscription is signed with its own `whsec_` secret, minted by `M038` when
  the subscription is created and returned by that response only; the row keeps it
  encrypted with the same AES-256-GCM store the credential vaults use. A
  subscription written before `M038` holds no secret and keeps the legacy
  derivation — the workspace data-directory value this runtime used before
  per-endpoint secrets existed — because inventing one during the migration would
  silently invalidate every receiver still verifying with the old key.
- Rotating a subscription mints a new secret and keeps the previous one valid — the
  `secret_previous_*` columns of `M039` — so every delivery carries both signatures,
  current first, until `retire-secret` is called. The previous secret is replaced
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
parameter** (24 h) rather than a conformed value; see §4. The published `2xx` reset of that
window is implemented — it is the success path's write, not a separate rule, and the
published contract names no other reset. The published 5–120 s jittered exponential
backoff is implemented as well.

Scheduled deployments live in `src/api/routes/deployments.ts` and are mounted at
**both** `/v1/deployments` (the published spelling) and `/v1/scheduled-deployments`
(the historical local one). One factory, two mounts: the routes are declared
relative to the mount, so the pair cannot diverge route by route. The module
exposes create, read, update, archive, `POST /:id/run`, `GET /:id/runs`,
`POST /run-due`, `POST /:id/pause` and `POST /:id/unpause`. It is a separate module
rather than part of `operations.ts` because that file also serves `/webhooks` and
`/outcomes` from one router, and making its paths relative to alias the
deployments would have placed those families under `/v1/deployments/` too.

A deployment's lifecycle state is `active` / `paused` / `archived`, and `paused`
carries a reason. `POST /:id/pause` writes `{"type": "manual"}` and
`POST /:id/unpause` clears it; the create and update routes derive the same value
from the status they write, so a deployment cannot read as paused with no reason
merely because it was paused through a different route. Pausing suppresses
scheduled triggers only — a manual `run` still works, and an archived deployment
is a 404 on every route rather than a paused one.

A deployment's **runs** are a second module, `src/api/routes/deployment-runs.ts`,
mounted once from `operations.ts` at `/deployment_runs`. It is a top-level
resource in the published contract with its own id, not a sub-path of a
deployment, so it cannot be a path alias of the nested `GET /deployments/{id}/runs`:
that route answers a different question, and a path alias cannot express a
top-level collection narrowed by a query parameter. Mounting it from
`operationsRoutes` is what gives it the `/v1/x/deployment_runs` mirror with the
legacy envelope for free, and why one registration serves both.

The run projection is a **read view**: `schedule_id` becomes `deployment_id` and
`started_at` becomes `created_at` on the way out only, and nothing that writes a
run row changes. `agent` is joined from the session the run created, so it is the
agent that ran and the version it ran as; a run that failed before a session
existed has no recorded version, so it reports `version: null` and the
deployment's current `agent_id` rather than a guess. `error` is lifted from the
stored message string into the published `{type, message}` object, and
`trigger_context.scheduled_at` is omitted because the runtime records when a run
started, not when its trigger was due.

`scheduler.ts` is the run engine:

- `nextCronRun` refuses an unrecognized zone rather than defaulting to UTC and
  delegates the arithmetic to `cron.ts`.
- `runDueScheduledDeployments` selects active, unarchived rows whose
  `next_run_at` is due and runs each one.
- `runSchedule` computes the next occurrence in the deployment's own zone,
  creates a session through `sessionManager.create`, records a
  `scheduled_deployment_runs` row, and advances `last_run_at` / `next_run_at` in
  both the success and the failure path.
- Failure handling is symmetric inside one `try`/`catch`: success records a
  `created_session` run, and any thrown error records a `failed` run with the
  message. There is no rate-limit branch, no `classifyRunError`, no
  `pauseForError`, no preflight of the deployment's own agent, no auto-pause and
  no auto-archive.
- `initial_events` is never passed. The session is created with `agent`,
  `environmentId`, `title` and a `metadata` block carrying
  `scheduled_deployment_id`, `scheduled_deployment_run_id` and `trigger_type`,
  so the trigger is a value in run metadata rather than a stored
  `trigger_context`. The published `trigger_context` object is **projected** from
  that stored value by the run collection, read-only, and carries only `type`.

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

**Signature arithmetic — correct, but only half-wired.**
`webhook-signature.ts` implements the published scheme: `whsec_` + base64 key
derivation, `id.timestamp.body` as the signed content, `v1,<base64>` output, a
constant-time verifier, and a space-separated rotation window.
`verifyWebhookDelivery` recomputes the signature, so the format is asserted
rather than assumed. The header set is wired into every attempt: a retry keeps
the delivery id and carries its own timestamp. The one local choice left is the
persisted `signature` column, which holds the legacy value.

**The deployment paths are now aligned, and a run is readable as the published
resource; the rest is local behaviour that overlaps the published contract in name
only.** A deployment answers at the published `/v1/deployments*` as well as the
local `/v1/scheduled-deployments*`, from one router mounted twice, and a run
answers at the published `/v1/deployment_runs*` with the published field names.
The delivery envelope, the disable policy, the retry schedule, the update verb,
the run error vocabulary and `trigger_context.scheduled_at`, the failure
behaviour, and the deployment lifecycle events are all either absent or
implemented differently, as §4 records.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Delivery payload envelope | The published body is `{type: "event", id, created_at, data: {type, id}}` so a receiver reads current state by `data.type` / `data.id`. The local body is `{type: "webhook_event", id, event, webhook_id, data, created_at}`. A handler written for the published envelope cannot read this one. The new deployment events carry the published `data: {type, id}` reference inside that envelope; the envelope itself is unchanged, so this narrows the divergence without closing it. |
| Event coverage | The published table names events across agents, environments, vaults and credentials, deployments, deployment runs, and sessions. The runtime raises the session event types, the five deployment lifecycle events and the three timed-run events listed in the webhook event vocabulary row below. A subscription listing a name nothing produces is accepted and simply silent, which is indistinguishable from "that event has not happened yet" — so a receiver cannot tell an unimplemented event from a quiet one. Recorded rather than papered over by refusing unknown names, which would break a subscription created against the published list. |
| `deployment.paused` causes | The published description covers a requested pause **and** an automatic pause after a non-recoverable trigger failure, and states that recoverable failures including rate limits do not pause. Only the requested cause exists: the automatic one needs the failure taxonomy of the run path, which the `M042` migration comment records as arriving with that work. The event is raised only when the state changes, so a repeat pause is silent. |
| `deployment.created` scope | Emitted by both mount prefixes of the create route. A create refused before the insert publishes nothing. A deployment created already `paused` is reported by `deployment.created` alone, not by `deployment.paused`: that pair reports a transition, and a resource coming into existence paused has not moved from anything. |
| `deployment.archived` causes | Only the **direct** cause exists. The published row gives a second one — the deployment's agent being archived — and adds that an agent's deletion archives its scheduled deployments **at the next scheduled run**, while a deployment with no schedule is never auto-archived. Neither is implemented: `POST /v1/agents/{id}/archive` (`src/api/routes/agents.ts:164`) updates only the `agents` table and touches no `scheduled_deployments` row, and `src/core/operations/scheduler.ts` reads deployments and re-arms `next_run_at` / `last_run_at` without ever archiving one. The prerequisite the published rule assumes is also absent: a deployment here cannot have "no schedule" — `cron` is `NOT NULL` and every create arms `next_run_at` — so a deployment that is never auto-archived has no representation. That is a behaviour of the scheduler and the agent route, recorded here rather than half-built. |
| `deployment.deleted` | Not applicable yet: there is no `DELETE` route for a deployment in any API route module, so no behaviour exists to carry the event. The published row states the event is the final result because there is no object to fetch; emitting it requires a delete route first, which is its own change. |
| `deployment.updated` scope | Emitted by `PUT /{id}` for the eight field changes listed in §2. It does **not** cover the pause state or `updated_at`, for the reasons given in §2 — the pause transition has its own events and `updated_at` moves on every write. The published trigger ("部署属性已更改") is broader than that on its face, so this is a recorded narrowing rather than full coverage; the alternative would be one call reporting two events a receiver did not ask to be distinguished by. A change to the schedule's derived `next_run_at` counts, because it is a field `PUT` writes and a caller reads. |
| No-op events | A repeat pause or resume raises nothing, because nothing changed. The published table states this rule explicitly for `environment.archived` ("对已归档的环境再次归档不会发出任何事件") and for `environment.updated` ("无操作的更新不会发出任何事件"); the same rule is applied to a `PUT` that changes no field, and to these two, rather than a second rule invented. |
| Automatic disable | All three published cases are implemented. The `3xx` case: an attempt that observes a redirect disables the endpoint with `disabled_reason` **exactly** `auto-disabled: endpoint URL returned a redirect (3xx)`, on the first attempt or on a retry that observes one, and that delivery is terminal — no retry is scheduled, and the retry-due pass returns nothing for it even a day later, because the published contract states a response that triggers auto-disable is never retried while the three-attempt ceiling still applies to every other failure. The private-address case: implemented, but **opt-in per deployment** rather than unconditional (see the next row for the switch and the reason). `disabled_reason` is reported only while the endpoint is disabled in both cases, and `PUT /v1/webhooks/{id}` clears it when an operator re-enables the endpoint, so an active endpoint never advertises a resolved reason. The disable is reachable and reversible, which is the order these landed in: the dispatcher already selected `status = 'active'`, so disabling before a re-enable path existed would have taken an endpoint that retried forever and made it permanently dead. The third case: an endpoint whose deliveries fail without interruption for at least the local window is disabled with `disabled_reason` **exactly** `auto-disabled after sustained delivery failures`, and that attempt is terminal too — on a first attempt or on a retry, which is where it usually fires, because the retries are what carry a streak across the window. The published reason for this case has a different form from the other two (no `: ` and no parenthetical) and is written verbatim rather than normalised. The published `2xx` reset of this window is implemented as the success path's write, and no other reset exists in the published contract — an earlier version of this row ended by calling that reset absent, which contradicted the sentence before it. The published jittered `5–120` s exponential backoff is implemented too; see the retry backoff row.
| Sustained-failure window (local value) | The published contract states the **shape** of this trigger and not its value: the condition is the duration of uninterrupted failure rather than a delivery count, and a `2xx` resets the window, but no length is published. This runtime uses **24 hours**, recorded as a **local parameter** rather than as a conformed value — the number is chosen long enough that an ordinary outage, which is precisely what the published sentence exists to tolerate, cannot reach it. Two consequences are deliberate: the streak is **stored** (`webhooks.failing_since`, migration 044) because an in-process counter would reset on every restart and the rule would never fire in the deployment it exists for, and the **success path writes the reset**, so repeated failures interrupted by any `2xx` never accumulate toward a disable. Re-enabling an endpoint clears the streak, so a recovered endpoint starts a fresh window instead of returning already overdue. |
| Private-address rule | **Implemented behind an opt-in deployment switch, off by default** — a recorded deviation from the published case, which is unconditional. With `MANAGED_AGENTS_WEBHOOK_SCREEN_PRIVATE_ADDRESSES` set to an affirmative value, an attempt whose endpoint host is an internal name (`localhost`, `.local`, `.internal`, …) or resolves to any address the shared `address-policy.ts` classifier calls private is **not connected at all**: the endpoint is disabled with the published reason `auto-disabled: endpoint URL resolved to an invalid address`, the attempt is terminal, and a resolver answer mixing public and private addresses is refused rather than raced. Why opt-in: loopback *is* a private address, this runtime is local-first, and its receiver is normally on the same host — every webhook test in this repository delivers to a loopback listener — so enforcing the rule by default would disable the receiver a self-hosted deployment exists to talk to, and the dispatcher selects `status = 'active'`, so it would take working setups and switch them off. The published rule is written for a hosted control plane whose subscribers are necessarily remote and whose destination can be chosen by something other than the operator; here an authenticated operator chooses the URL, which is also why `web_fetch`'s strict default is right for `web_fetch` and not transferable to this path. When the switch is on, same-host delivery no longer works — that is what turning it on means. |
| Retry backoff | Aligned with the published 5–120 s jittered exponential backoff: the ceiling doubles per attempt (60 s, then 120 s) and each delay is drawn uniformly between 5 s and that ceiling, so endpoints that fail together do not retry together. The three-attempt ceiling matches the published one, and the published rule that a response triggering auto-disable is never retried holds for all three disable cases: the attempt that triggers one is terminal, first attempt or retry alike. |
| Secret rotation | A window is opened by `POST /v1/webhooks/{id}/rotate-secret` and closed by `POST /v1/webhooks/{id}/retire-secret`, with both signatures carried in `webhook-signature` while it is open. Nothing retires the previous secret automatically: the operator decides when the old value stops being accepted, because only they know when every receiver has moved. |
| Delivery trigger | The runtime's own bridge ticks every 60 seconds and projects each durable event as it is broadcast, so an unwatched runtime delivers; `POST /webhooks/dispatch` and `POST /webhooks/retry-due` remain for on-demand passes. The tick is when a due retry is picked up; the retry delay itself follows the retry backoff row. |
| Subscription management surface | REST under `/v1/webhooks` with the `/v1/x` mirror. `PUT /{id}` is the enable/disable surface: it writes the published `status` field, and omitting it leaves the stored value unchanged like every other field in that partial update, so a rename cannot silently re-enable an endpoint an operator switched off. |
| Webhook event vocabulary | Subscriptions name SandBase event types, and are accepted as written — an unrecognized name is silent rather than refused. Producers exist for the deployment lifecycle (`deployment.created`, `.paused`, `.unpaused`, `.updated`, `.archived`) and for timed runs (`deployment_run.started`, `.succeeded`, `.failed`); `agent.*`, `environment.*`, `vault.*`, `vault_credential.*` and `deployment.deleted` have none. The runtime also publishes its own names (`turn_complete`, `span.*`), which are not in the published table. The local envelope carries the event name on the top-level `event` field while the published one carries it in `data.type` — see the delivery payload envelope row. The `session.updated` name recorded here earlier had no producer either and has been removed rather than kept as a documented event; see `events.md` §4. |
| Deployment endpoint paths | Both spellings are served: the published `/v1/deployments` and the historical local `/v1/scheduled-deployments`. They are one router mounted twice (`src/api/routes/deployments.ts`), so they cannot diverge route by route, and the local spelling is neither deprecated nor redirected. The published contract also updates a deployment with `POST /v1/deployments/{id}` while this runtime uses `PUT`; the verb is not aliased, so a client written against the published verb still gets no route for that one call. |
| Deployment control surface | Create, read, update, archive, manual run, run-due, **pause and unpause**. `POST /{id}/pause` records `paused_reason: {"type": "manual"}`; `POST /{id}/unpause` clears it and resumes from the next scheduled instant. Pause suppresses the scheduler and leaves the `run` endpoint open, which the published contract requires. The automatic pause after a non-recoverable trigger failure is **not** implemented, so `paused_reason` only ever holds `manual`: a caller can tell "paused by a person" from "not paused", but not yet from "paused by the runtime". |
| Paused semantics | A paused deployment still accepts a manual `run`. The route previously refused any status but `active`, which was reachable only through `paused` — the one status `定时部署.md:490` says must still run. The scheduler path was already correct (`runDueScheduledDeployments` selects `status = 'active'`), so pause already suppressed timed runs and only the manual path was wrongly closed. Unpausing does not catch up missed triggers: a stored `next_run_at` that has already passed is recomputed forward, and one still in the future is left alone. |
| Pause reason | `paused_reason` is a column added by `M042`, derived from `status` on every write path (create and update included) so the two cannot disagree. It reads `null` on a row that was paused before the migration, rather than back-filling `manual`: the runtime did not observe who paused it, and an invented reason would be indistinguishable from an observed one. |
| Deployment run collection | `GET /v1/deployment_runs` and `GET /v1/deployment_runs/{id}` exist and carry the published field names. `deployment_id` and `has_error` are the two filters implemented, and a parameter outside that set is now **refused by name** rather than ignored. The published reference page that would list every filter is not available offline, so a third *published* filter would still be refused as unknown — which is the honest failure, but it is a refusal this runtime would be wrong about rather than a silently unscoped answer. |
| Deployment run error type | The published `error.type` values name causes (`environment_archived_error`, `agent_archived_error`, `session_rate_limited_error`). This runtime cannot supply one: `sessionManager.create` throws bare `Error`s with free-text messages, so classification would mean matching on message strings. The published `{type, message}` **shape** is emitted with a single local `deployment_run_failed` type, which says the run failed and that the runtime did not classify it. Introducing the published vocabulary is a change to the session-creation error path, not to this projection. |
| Deployment run trigger context | `trigger_context.type` is `schedule` for a timed run (the runtime stores `scheduled`) and `manual` for a hand-triggered one, passed through unchanged because the published docs show only the timed case. `trigger_context.scheduled_at` is **absent**: the runtime records when a run started, not the instant its trigger was due, and does not persist the due instant on the run row. Reporting `started_at` there would answer a question about the schedule with a fact about execution. |
| Deployment run agent | `agent` is `{type, id, version}` taken from the session the run created, so both are the ones that ran. On a failed run there is no session and no recorded version, so `version` is `null` and `id` is the deployment's **current** agent — which may have changed since the attempt. Persisting the resolved agent on the run row at attempt time is a separate change. |
| Deployment run ids | Stored run ids keep their local `srun_` prefix. The published sample uses `drun_`, but an id is opaque to the client and the value is already returned by the nested route and recorded in session metadata, so it is not renamed. |
| Deployment run event cause | Only a **timed** run raises `deployment_run` events. `runSchedule` is shared by the timed path and the manual route, and the manual route's `trigger_type` is caller-supplied, so the rule is enforced by publishing from the timed path (`runDueScheduledDeployments`, reached by the background tick and by `POST /v1/deployments/run-due`) rather than by testing the trigger type; keying off `trigger_type === 'scheduled'` would let `POST /v1/deployments/{id}/run {"trigger_type":"scheduled"}` emit. `deployment_run.started` is published once the run is **recorded**, before its outcome, not at the instant it begins: `runSchedule` is synchronous and writes its row in a single terminal statement, and the published handler contract has a receiver fetch the resource by `data.id`, so publishing earlier would send that fetch to a 404 for a run that had genuinely started. There is no persisted in-progress run state for `started` to point at, and adding one is a change to the run status vocabulary rather than to this event. |
| Trigger representation | `trigger_type` is a key in the session's and the run's metadata; no `trigger_context` column is stored. The published `trigger_context` is projected from it on the run collection and carries only `type`, as the run trigger context row above records. |
| Session startup | `sessionManager.create` without `initial_events`; a schedule cannot seed startup events the way the canonical session path can. |
| Failure behaviour | Symmetric: every thrown session-creation error records a `failed` run and advances the cadence. No split by error class, no failure class recorded beyond the message, no preflight, no auto-pause, no auto-archive. |
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
- The deployment failure split is absent because the scheduler never grew a
  preflight step. Recording the failure and advancing the cadence does not lose
  the error, but it does lose the operator signal the published contract
  provides, so the asymmetry is documented as missing rather than approximated.
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
  subscriptions with a stored signed delivery record, the published header set
  on every attempt with the delivery id unchanged across a two-attempt retry,
  and a failed delivery queued as `pending_retry` and later marked delivered.
- `tests/integration/webhook-endpoint-secret.test.ts` — the secret returned once at
  creation and absent from every read, the row holding ciphertext that decrypts
  back to it (including from a second handle), a different secret per
  subscription, a test delivery signed with the endpoint's own secret, and a
  subscription written before `M038` still resolving to the legacy key.
- `tests/integration/webhook-secret-rotation.test.ts` — a rotation returns the new
  secret once and no read returns either value, a delivery carries the current
  signature first and the previous one second until `retire-secret` closes the
  window, a second rotation replaces the window rather than appending to it, an
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
- `tests/unit/scheduler.test.ts` — the next cron run, and running due schedules
  while advancing `next_run_at`.
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
  rather than the first; a `deployment.*` wildcard matching and an unrelated
  subscriber receiving nothing at all; both mount prefixes publishing; a repeat
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
  success) using an unknown agent so session creation genuinely throws; a manual
  run publishing nothing while still recording its run; **a manual run passing
  `trigger_type: "scheduled"`** publishing nothing, which is the case that
  distinguishes the path-based rule from the obvious one, since that field is
  caller-supplied; no due deployment publishing nothing; the wildcard matcher
  reaching both events while another family stays untouched; a subscriber on an
  unreachable port leaving **both** due runs executed *and* its failed attempts
  recorded for retry; and the background tick — the other door onto the timed path
  — reporting its runs too.
- `tests/integration/deployment-archived-event.test.ts` — `deployment.archived`
  published by a direct archive with a reference that resolves to an already
  archived row, measured **inside the receiver** so the ordering claim means
  something; a repeat archive asserted on **both** halves (the `404` and the
  silence), because either alone passes for the wrong reason; a 404 for an
  unknown id publishing nothing; both mount prefixes; the wildcard and `prefix.*`
  matchers reaching it while another family stays untouched; an unreachable
  subscriber leaving the archive committed; the agent-archived cascade recorded
  as **absent** so implementing it later must update the expectation
  deliberately; and the webhook archive route still publishing nothing, which is
  what shows the shared helper's new outcome did not quietly change the two
  callers that publish nothing.
- `tests/integration/deployment-created-event.test.ts` — `deployment.created`
  published by a successful create with a reference that resolves, measured
  **inside the receiver** so the ordering claim means something (a read after the
  create returns would find the row either way); each of the four refusals
  publishing nothing; a deployment created already `paused` publishing the create
  and no pause event; both mount prefixes; the wildcard and `prefix.*` matchers
  reaching it while another family stays untouched; and an unreachable subscriber
  leaving the create committed.
- `tests/integration/deployment-updated-event.test.ts` — `deployment.updated`
  published for each of the eight fields `PUT` writes, each one asserted twice:
  once changed, once re-sent unchanged, so an emitter that fires on every write
  fails half of them. Plus the structural-comparison cases — the same `payload`
  content in a different key order, and the same again nested, neither of which is
  a change — next to the neighbour that does differ; a `PUT` sending back exactly
  what the resource holds, which an implementation counting `updated_at` would
  publish; a `PUT` changing both a field and the pause state, which publishes both
  events; a `PUT` changing only the pause state, which publishes only the pause
  event; both mount prefixes; an archived deployment still answering 404 in
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
  reason rather than a back-filled one.
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

`partial` for both, and the reason is no longer narrow. Cron-in-zone, the
signature arithmetic, the per-endpoint secret, the published headers on every
attempt, the background tick that delivers without a caller, the
`deployment.paused` / `deployment.unpaused` pair across all three doors onto the
pause state, `deployment.updated` for the field changes a `PUT` makes,
`deployment.created` on both mount prefixes, `deployment.archived` for the
direct cause, the three `deployment_run.*` events for a timed run, the
published `/v1/deployments` alias, the jittered retry backoff, and the redirect
and sustained-failure auto-disable rules are the aligned parts. The published
delivery envelope, the private-address rule as a default (it is opt-in here),
the automatic pause cause, the `deployment.archived` agent-cascade cause,
`deployment.deleted`, `trigger_context.scheduled_at`, the rest of the published
event table, the asymmetric failure split and a persisted in-progress run state
are absent or differ, and are listed in §4 so that "covered by a contract" does
not read as "implemented". Neither entry is `supported`; neither is `unavailable`, because
the resource, the delivery engine, the scheduler and the run records are real
and exercised by the tests in §6. No claim is made that a client written against
the published contract works unchanged.

The two `supported` entries in this area are different in kind from the pair
above: `outcome-evaluation` (this file) is a deterministic evaluator the
published contract does not define, and `outcome-grading` (recorded in
`sessions.md`) projects a declared outcome into a graded, self-revising loop.
They are supported because that behaviour is implemented and tested, not because
the published deployment contract is met. The status block at the top of this
file carries this file's three entries, so the two groups cannot be read as one.
