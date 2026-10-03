# API Reference

`managed-agents` exposes a local-first JSON API under `/v1`. The Dashboard, the
TypeScript SDK, and external automation all use the same resource model: agents,
sessions, environments, credential vaults, memory stores, files, skills, API
keys, and runtime operations.

The API is intentionally close to Claude Managed Agents while remaining local
and inspectable. Resource metadata is stored in SQLite, uploaded assets live
under the runtime data directory, and session timelines are persisted as
replayable events.

## Interactive Reference

Open `Settings > API reference` in the Dashboard for an in-product reference page
modeled after platform API docs:

- endpoint navigation grouped by resource
- method/path headers for each operation
- header, query, body, and return field descriptions
- copyable `curl` examples generated from the active runtime base URL
- TypeScript SDK and Skill upload examples

Use this page when integrating a local runtime into scripts, CI jobs, desktop
apps, or an internal control plane. It reflects the server you are connected to,
including whether bearer authentication is currently enabled.

## Runtime Contract

The local server exposes the Dashboard and API from the same origin:

```text
Dashboard: http://127.0.0.1:3000/dashboard
API:       http://127.0.0.1:3000/v1
```

All timestamps are RFC 3339 strings. Identifiers are opaque tagged ids such as
`agent_...`, `sess_...`, `env_...`, `skill_...`, and `memstore_...`; clients
should not infer meaning from their length or suffix.

## CMA Compatibility Headers and Authentication

Authentication is disabled by default for local development. It is enabled when
at least one API key exists. Keys can be supplied through
`MANAGED_AGENTS_API_KEY` or created through `/v1/api-keys`.

CMA clients may authenticate with either header when authentication is enabled:

```text
x-api-key: ma_local_example
Authorization: Bearer ma_local_example
```

Use exactly one credential scheme per request. A request carrying both
`Authorization` and `x-api-key` is rejected with `401 authentication_error`,
even if the values match; this prevents credential-source ambiguity at proxy
and middleware boundaries.

Requests using `x-api-key`, or either Anthropic compatibility header, are
admitted before CMA route handlers run. They must include:

```text
anthropic-version: 2023-06-01
```

Normal CMA resources require the managed-agents beta:

```text
anthropic-beta: managed-agents-2026-04-01
```

Memory-store resources (`/v1/memory_stores` and descendants) instead require:

```text
anthropic-beta: agent-memory-2026-07-22
```

The explicitly refused SDK resources also recognize their native beta:
`dreaming-2026-04-21` for `/v1/dreams`, `mcp-tunnels-2026-06-22` for
`/v1/tunnels`, and `user-profiles-2026-08-18` for `/v1/user_profiles`.
This lets unmodified SDK methods reach `unsupported_capability`; it does not
enable these capabilities or admit these betas on other resources. The canonical
managed-agents beta remains accepted on the refusal paths.

Do not combine that beta with `managed-agents-2026-04-01` on a memory-store
request: admission rejects the pair with `400 invalid_request_error`. The documented
read-only exception, `GET /v1/memory_stores/{id}/memories`, accepts either of
those two betas when sent alone.

`anthropic-beta` accepts comma-separated identifiers; the required identifier
must appear in the list. Missing, malformed, or unsupported compatibility
headers return `400` with the standard `invalid_request_error` error envelope before
route business logic executes. Runtime extension endpoints under `/v1/x` do not
use CMA header admission.

Existing bearer callers that omit the CMA compatibility headers remain supported
unchanged. A bearer request that sends either compatibility header is validated
by the same CMA policy. Raw API keys are never returned from list or retrieve
responses. A newly created managed key returns `secret_key` once; store it
before discarding the response.

### Headers sent by the first-party SDK

The published SDK sends the canonical pair on every `/v1/...` request:

```text
anthropic-version: 2023-06-01
anthropic-beta: managed-agents-2026-04-01
```

A memory-store request carries `agent-memory-2026-07-22` instead. The two betas are
mutually exclusive by contract: a memory-store request is not a managed-agents
request, and a request carrying both is in neither surface. Which one applies is
chosen from the request path inside the SDK, so a caller cannot send the wrong
family by omission.

`/v1/x/...` is the SandBase extension surface. Admission does not gate it and no
published beta describes it, so the SDK sends no compatibility header there.

A caller-supplied `anthropic-beta` overrides the derived one; unrelated caller
headers are passed through untouched.

## Pagination and Errors

Collection responses. A canonical `/v1` collection carries cursors:

```json
{
  "data": [],
  "prev_page": null,
  "next_page": null
}
```

An extension collection under `/v1/x` — and a canonical collection the contract has
not converted yet, listed in `contracts/anthropic-cma/pagination.md` §4 — carries the
local fields:

```json
{
  "data": [],
  "has_more": false,
  "first_id": null,
  "last_id": null
}
```

Error responses:

```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "name is required"
  }
}
```

Common error types are `invalid_request_error`, `not_found`, `conflict`,
`not_available`, and `internal_error`.

A path the server does not serve answers the same `not_found` envelope with the
same `application/json` content type, so a client decodes one shape whether the
resource is missing or the route is. The message for an unrouted path is
`No route matches this request`, which keeps it distinguishable from a missing
resource's own message such as `Agent not found: <id>`. Authentication,
throttling, and compatibility admission run before routing, so an unmatched
`/v1/*` path still answers `401`, `429`, or an admission `400` when those apply.

Known unsupported official SDK operations instead return HTTP 400 with
`error.type: "unsupported_capability"`, a message pointing to
`docs/api-matrix.md#unsupported-official-routes`, and
`error.details.capabilities` containing the capability id and reason. These
explicit refusals cover Dreams, MCP tunnels, hosted user profiles, the hosted
environment Work API, and MCP OAuth validation; they do not create resources or
execute work. Authentication, throttling, and compatibility admission still run
first. Only the documented official methods and paths are registered; unrelated
paths or verbs keep the normal not-found behavior. See the
[compatibility table](./api-matrix.md#unsupported-official-routes).

### Unsupported Official Operations

All operations in this table return HTTP 400 `unsupported_capability`, not a
resource response. The MCP OAuth refusal is mounted through the shared vault
router, so both vault spellings preserve the same behavior.

| Method | Path |
| --- | --- |
| GET, POST | `/v1/dreams` |
| GET | `/v1/dreams/{id}` |
| POST | `/v1/dreams/{id}/archive` |
| POST | `/v1/dreams/{id}/cancel` |
| GET, POST | `/v1/tunnels` |
| GET | `/v1/tunnels/{id}` |
| POST | `/v1/tunnels/{id}/archive` |
| POST | `/v1/tunnels/{id}/reveal_token` |
| POST | `/v1/tunnels/{id}/rotate_token` |
| GET, POST | `/v1/tunnels/{id}/certificates` |
| GET | `/v1/tunnels/{id}/certificates/{certificate_id}` |
| POST | `/v1/tunnels/{id}/certificates/{certificate_id}/archive` |
| GET, POST | `/v1/user_profiles` |
| GET, POST | `/v1/user_profiles/{id}` |
| POST | `/v1/user_profiles/{id}/enrollment_url` |
| GET | `/v1/environments/{id}/work` |
| GET | `/v1/environments/{id}/work/poll` |
| GET | `/v1/environments/{id}/work/stats` |
| GET, POST | `/v1/environments/{id}/work/{work_id}` |
| POST | `/v1/environments/{id}/work/{work_id}/ack` |
| POST | `/v1/environments/{id}/work/{work_id}/heartbeat` |
| POST | `/v1/environments/{id}/work/{work_id}/stop` |
| POST | `/v1/vaults/{id}/credentials/{credential_id}/mcp_oauth_validate` |
| POST | `/v1/credential-vaults/{id}/credentials/{credential_id}/mcp_oauth_validate` |

A query parameter a route does not implement is refused rather than ignored:

```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "Unknown query parameter \"bogus\". This route accepts: limit, page, order, agent_id, agent_version, include_archived, memory_store_id, deployment_id, statuses[], statuses, created_at[gt], created_at[gte], created_at[lt], created_at[lte]."
  }
}
```

A dropped filter is worse than an error, because the response is plausible:
`GET /v1/sessions?include_archived=true` used to answer `200` with the same list
it would have returned without the parameter, so a caller had no way to tell that
their filter never applied. The refusal names the parameter and lists the ones
that route accepts. It is decided before the resource is looked up, so a request
that is wrong in both ways reports the parameter rather than a `404` that would
imply it was understood.

`beta` is accepted on every route and ignored. It is not a parameter this runtime
implements — the published examples put it on the URL (`?beta=true`) rather than
in a header, so refusing it would break a client built against the published
documentation. It is not listed among a route's accepted parameters, because
those are the ones that do something.

Routes that read no query parameters are not covered by this yet, so they still
ignore everything. No published example gives any of them a parameter.

The file listing is scoped by the published `scope_id`:

```
GET /v1/files?scope_id=<session_id>
```

That returns the files recorded for that session — the deliverables an agent
wrote under `/mnt/session/outputs/` — and omitting `scope_id` keeps the full
listing, so no existing caller changes. A `scope_id` naming no session returns an
**empty page** rather than falling back to the global list: an ignored scope
answered with the unscoped list is indistinguishable from a session that happens
to contain files the caller does not recognise, which is the failure the
parameter exists to prevent. A file uploaded directly through `POST /v1/files`
records no session, so it appears in the full listing and in no scoped one.

The scoped listing sits behind the same compatibility gate as the rest of the
resource surface, so a caller presenting itself as a CMA client without the beta
is refused rather than answered.

A rejected compatibility request also carries a stable `error.code`, so a
client can branch on the cause instead of matching the message text. The
admission codes are:

| Code | Cause |
| --- | --- |
| `missing_anthropic_version` | A compatibility caller omitted `anthropic-version`. |
| `unsupported_anthropic_version` | `anthropic-version` is present but not the supported value. |
| `missing_anthropic_beta` | A compatibility caller omitted `anthropic-beta`. |
| `malformed_anthropic_beta` | `anthropic-beta` is not comma-separated identifiers. |
| `unsupported_anthropic_beta` | The beta does not match the resource family being addressed. |
| `conflicting_memory_store_beta` | Both memory-store betas were sent on a memory-store request. |

These values are part of the published contract and will not change once
released.

### Rate limits

Inbound `/v1` throttling is a single-process fixed one-minute window with
independent credential buckets. Each window is anchored to the request that
opened it and expires one minute later, so a burst that straddles a wall-clock
minute boundary is still counted against one budget rather than being allowed
twice:

| Request class | Methods | Default budget |
| --- | --- | --- |
| Write | `POST`, `PUT`, `PATCH`, `DELETE` | 300 / minute |
| Read | `GET`, `HEAD` | 1200 / minute |

The limiter runs after authentication and before CMA request admission. An
exceeded budget returns HTTP `429` with `error.type: "rate_limit_error"`,
`error.code: "inbound_rate_limited"`, a positive `Retry-After` value, and
`X-RateLimit-Limit`/`X-RateLimit-Remaining` headers. Invalid credentials remain
`401` and do not consume a valid credential's bucket. `/v1/x/health` and CORS
`OPTIONS` preflight requests are exempt; preflight is handled by CORS before
route middleware and is not counted.

A runtime with no API keys is unlimited by default. Set
`MANAGED_AGENTS_INBOUND_RATE_LIMIT=on` to force the limiter, or `off` to
suppress the default on a key-protected runtime. Use
`MANAGED_AGENTS_INBOUND_RATE_LIMIT_READ` and
`MANAGED_AGENTS_INBOUND_RATE_LIMIT_WRITE` for positive per-minute overrides.
Managed API key creation/removal updates the default auth-linked posture after
startup. The limiter is in-process and fixed-window; it is best-effort
throttling, not distributed state or DDoS protection. Forwarded IP fallback is
not a trusted proxy security boundary.

## API Keys

API keys control bearer-token authentication for the local runtime. Managed keys
are stored in SQLite as SHA-256 hashes. Keys from config or environment variables
are shown as read-only `config_env` records.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/api-keys` | List managed and configured API keys. |
| `POST` | `/v1/api-keys` | Create a managed API key. |
| `DELETE` | `/v1/api-keys/{key_id}` | Delete a managed API key. |

Create a key:

```bash
curl -X POST http://127.0.0.1:3000/v1/api-keys \
  -H "Content-Type: application/json" \
  -d '{ "name": "Local Console" }'
```

Create response:

```json
{
  "id": "key_abc123",
  "type": "api_key",
  "name": "Local Console",
  "source": "managed",
  "key_prefix": "ma_abc123...wxyz",
  "status": "active",
  "created_at": "2026-07-12T00:00:00.000Z",
  "updated_at": "2026-07-12T00:00:00.000Z",
  "last_used_at": null,
  "archived_at": null,
  "secret_key": "ma_full_secret_returned_once"
}
```

List response entries omit `secret_key`:

```json
{
  "id": "key_abc123",
  "type": "api_key",
  "name": "Local Console",
  "source": "managed",
  "key_prefix": "ma_abc123...wxyz",
  "status": "active",
  "last_used_at": "2026-07-12T00:01:00.000Z"
}
```

## Agents

Agents are SQLite-backed runtime resources. Optional YAML files in the configured
agents directory can seed a workspace, but creates and updates are persisted in
the local database.

Agent ids are object identifiers. Seeded YAML agents use deterministic ids on
import; API and Console-created agents receive server-generated `agent_...` ids.
Names are display fields and do not need to be unique.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/agents` | List loaded agents. |
| `POST` | `/v1/agents` | Create an agent resource. |
| `GET` | `/v1/agents/{agent_id}` | Retrieve an agent. |
| `POST` | `/v1/agents/{agent_id}` | Save a new agent version. The published update verb. |
| `PUT` | `/v1/agents/{agent_id}` | Save a new agent version. Local spelling of the same operation. |
| `GET` | `/v1/agents/{agent_id}/versions` | List versions known to the local store. |
| `POST` | `/v1/agents/{agent_id}/archive` | Archive an agent. |

Create an agent:

```bash
curl -X POST http://127.0.0.1:3000/v1/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "assistant",
    "description": "Helps with development tasks.",
    "model": "default",
    "system": "You are a helpful assistant.",
    "mcp_servers": [],
    "tools": [{ "type": "agent_toolset_20260401" }],
    "skills": [],
    "metadata": {}
  }'
```

Agent response:

```json
{
  "id": "agent_01JAbcdefghijklmnopqrstuvw",
  "type": "agent",
  "name": "assistant",
  "description": "Helps with development tasks.",
  "model": "default",
  "status": "active",
  "version": 1,
  "created_at": "2026-07-12T00:00:00.000Z",
  "updated_at": "2026-07-12T00:00:00.000Z",
  "archived_at": null
}
```

Update an agent with optimistic version checking:

```bash
curl -X PUT http://127.0.0.1:3000/v1/agents/agent_abc123 \
  -H "Content-Type: application/json" \
  -d '{
    "name": "assistant",
    "description": "Updated instructions.",
    "model": "default",
    "system": "You are a helpful assistant. Prefer concise answers.",
    "tools": [{ "type": "agent_toolset_20260401" }],
    "skills": [],
    "expected_version": 1
  }'
```

When `expected_version` is present and does not match the current agent
version, the API returns `409 conflict`. Each successful create/update writes an
immutable snapshot returned by `/v1/agents/{agent_id}/versions`.

The precondition is also accepted under its published name, `version` — the
field the CMA contract documents ("`version` 字段是可选的：提供它可实现乐观并发控制
（不匹配时返回 409），省略它则无条件应用更新（最后写入者获胜）"). `version` and
`expected_version` are one precondition, so sending both with different values is
a `400` rather than a precedence rule; sending both with the same value is
accepted. A present-but-malformed value is a `400` for the field that carried
it, never a silent downgrade to an unconditional update.

### Updating an agent

`POST` and `PUT` on `/v1/agents/{agent_id}` both accept a partial definition and
apply the same update semantics, so a client that only shows a subset of the
definition can save without resending every field. `POST` is the published verb;
`PUT` is the local spelling of the same operation. There is no `PATCH` on this
path — an earlier revision of this page claimed one:

| Rule | Behaviour |
| --- | --- |
| Omitted field | Keeps its stored value. |
| Present scalar | Replaces its value. |
| `tools`, `mcp_servers`, `skills` | Replace wholesale when present. |
| `metadata` | Merges per key; a key set to `null` is deleted. |
| `null` on a clearable field | Clears it, the same as `[]` for a list field. |
| `name`, `model` | Cannot be cleared; a clear attempt gets its own message. |
| Unknown field | Rejected with a message naming it, not silently discarded. |

The merged definition is revalidated against the full agent schema before it is
persisted, so a request that changes one side of a coupled pair is judged on the
pair it produces. Replacing `model` without an explicit `model_config` drops the
stale config rather than leaving a previous id and speed pointing at the old model.
On create, omitted, `null`, or empty `system` normalizes to an empty string.
On update, an omitted `system` keeps the existing prompt; `null` or an empty
string clears it. Non-string, non-null values are rejected on both write paths.

The optimistic-lock precondition is accepted as either `expected_version` or the
published `version`: absent means no precondition, and a malformed value is a `400`
rather than a silent downgrade to an unguarded update. A successful update writes a new
immutable version, and an update that changes nothing writes no version at all.

### MCP servers and toolsets

An MCP toolset grants the tools a declared MCP server provides, so `mcp_servers`
and the `mcp_toolset` entries in `tools` are one contract. An agent definition is
rejected with `400 invalid_request_error` when either side names something the
other does not:

- an `mcp_toolset` naming a server absent from `mcp_servers` — the toolset has no
  transport to connect to;
- a declared `mcp_servers` entry that no `mcp_toolset` references — the server is
  invisible to the agent;
- two `mcp_servers` entries with the same name — a toolset reference would be
  ambiguous.

Each rejection names the offending entry. Two toolsets may bind the same declared
server; that is a legitimate fan-out of one transport across two tool groups.

Whether a bound server is reachable, and whether it actually exposes the tools its
toolset configs name, is checked at connection time rather than at save time.

An MCP tool is governed by the permission policy of the toolset that binds its
server. When nothing is configured, the toolset kind supplies the default: an
`mcp_toolset` requires approval and the built-in toolset does not, because an MCP
server is third-party surface and a call to it reaches the user before it runs.
An explicit `permission_policy` on a tool config, or a `default_config` on the
toolset, overrides that default in both directions. A tool the server exposed
but the agent never named is admitted under the same default rather than under
no rule at all: it carries no local `execute` until the caller approves it, and
it appears in the confirmation list the runtime matches against the model-visible
name. A tool the operator marked `never_allow` is not admitted at all rather than
shipped and gated, because shipping it would invite the model to call something
the operator forbade.

### Custom tools

A custom tool is declared as an independent `tools[]` entry carrying `type: "custom"`, with `name`, `description`, and `input_schema`. The legacy `custom_toolset` grouping is still accepted on write, with `parameters` accepted as an alias for `input_schema`, and is projected back as flat canonical `custom` entries, so a client reading an agent sees one shape regardless of how it was written. A tool the legacy grouping disables — a config with `enabled: false`, or every config under a `default_config` of `enabled: false` — is dropped rather than translated into a policy. A canonical entry carrying a `permission_policy` is refused with `400 invalid_request_error`: the caller executes the tool and decides whether to run it, so a policy field would claim governance the runtime does not have. A name that collides with a built-in tool, a name declared twice across both shapes, and a malformed input schema are each refused with a message naming the offending entry.

### Agent model object

`model` accepts either the bare model id string or the canonical object form.

```json
{ "id": "claude-opus-5", "speed": "standard", "effort": "high" }
```

| Field | Accepted values | Behaviour |
| --- | --- | --- |
| `id` | non-empty string | Required. |
| `speed` | `standard` \| `fast` \| `extended` | Optional; defaults to `standard`. `extended` is a local extension, not a published value. |
| `effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max`, or `{ "type": <level> }` | Optional. Parsed, validated, stored in the agent's model profile, and returned by every read — the agent read, the version listing, and a session's frozen snapshot. It does not change the provider request: the model is resolved from the id, so the level has no path into a request (accepted-but-no-effect). A deployment's own `reasoning_effort` model setting is what a provider that accepts one sees, and it is operator-level rather than per agent. |
| `inference_geo` | `us` \| `global` | Refused with `unsupported_model_field`. A local runtime has no inference-geography control, so honouring the pin is not possible. |

An unrecognized key is also refused with `unsupported_model_field`, and the error
lists every known field so the request can be corrected. A malformed `speed`
or `effort` is refused with its own stable code and the accepted value set
rather than being silently defaulted.

A read returns the stored profile as `model_config` — `id`, `speed`, and
`effort` when one was set. It is omitted for the ordinary case (the local
`standard` speed and no `effort`), so an agent that never sent either looks the
same as before; a definition that carries `effort` reports it on the agent read,
on the version listing, and inside a session's `agent` snapshot. When `model` is
sent as the object form it is authoritative: the profile is derived from that
object, and a `model_config` sent beside it is ignored rather than merged.

## Sessions

Sessions run an agent in an environment and persist a resumable event log.

The public session `status` is one of `idle`, `running`, `rescheduling`, or
`terminated`. Internal `queued`, `paused`, and `requires_action` project to
`idle`; internal `retrying` projects to `rescheduling`; `completed`, `failed`,
`cancelled`, `timed_out`, `cleanup_pending`, and `archived` project to
`terminated`. Error and cleanup details remain in the event log.
`rescheduling` is emitted while a transient model failure is being retried:
the first scheduled retry in a turn writes `session.error` with
`retry_status: {"type": "retrying"}` and `session.status_rescheduled`, a
request that succeeds after a retry writes `session.status_running`, and a
retry policy that gives up writes `session.error` with `"type": "exhausted"`
and idles with `stop_reason: {"type": "retries_exhausted"}` — the session
stays usable. A `user.interrupt` during the wait ends it with `end_turn`.

The repeatable `statuses` (or `statuses[]`) list filter selects every internal
state in each requested public group, including paused and approval-waiting
sessions for `idle` and all terminal states for `terminated`. `rescheduling`
selects sessions retrying a failed model request. Terminal sessions, including `failed`, reject new
messages and events with `409` before input is persisted or another model/tool
turn starts. Create a new session after a terminal failure; fixable
configuration errors that already leave the internal state `paused` still allow
another turn. The former local `status` parameter is removed — a filter on
internally failed sessions is expressed as `statuses=terminated`.

Every session response carries the published object fields: `budget` is always
present — the ceiling or `null` — and `stats` reports `active_seconds` (the
session's cumulative `running` time, derived from its event log) and
`duration_seconds` (time since creation, frozen at the last update once the
session is terminal or archived). The embedded `agent` is the session's frozen
snapshot: `version` pins the definition the session runs, and `multiagent` is
always `null` because a declared roster is refused rather than silently
dropped. `loop_engine` is a local extension on top of the published shape.
`outcome_evaluations` is derived from the session's event log on create,
retrieve, and list: one entry per `user.define_outcome`, in declaration order —
`pending` before its turn begins, `running` while the agent works or revises,
`evaluating` while the grader scores, and the terminal end-span verdict
(`satisfied`, `failed`, `max_iterations_reached`, `interrupted`, or the local
`budget_reached`) once closed. `needs_revision` is a span verdict, not a
resource state, so it never appears there.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/sessions` | List sessions. |
| `POST` | `/v1/sessions` | Create a session. |
| `GET` | `/v1/sessions/{session_id}` | Retrieve a session. |
| `POST` | `/v1/sessions/{session_id}` | Update a session: `agent` (`tools`/`mcp_servers` only), `metadata`, `title`. |
| `POST` | `/v1/sessions/{session_id}/messages` | Send a user message and optionally stream. |
| `POST` | `/v1/sessions/{session_id}/events` | Append user events. |
| `GET` | `/v1/sessions/{session_id}/events` | List persisted events. |
| `GET` | `/v1/sessions/{session_id}/events/stream` | Stream live events with SSE. |
| `POST` | `/v1/sessions/{session_id}/stop` | Deprecated local alias: interrupt the active turn and return the session. |
| `POST` | `/v1/sessions/{session_id}/archive` | Archive a session and return it. |
| `DELETE` | `/v1/sessions/{session_id}` | Permanently delete a session and its session-owned state. |

The published way to interrupt a turn is to send `user.interrupt` through
the events endpoint and wait for `idle`. The local `/stop` alias aborts the
active turn, waits for the execution chain to drain, and returns the same
session envelope as retrieve. Successful interruption leaves `idle` with
`session.status_idle.stop_reason.type: "end_turn"`, retains the sandbox, and
allows another message. An idle session is unchanged, including pending tool
approvals. A missing session returns `404`; an already terminal session returns
`409` without mutation or cleanup. Pi may close its interrupted child, but the
next turn launches another child in the retained sandbox; unconfirmed child-tree
cleanup still leaves `cleanup_pending` (public `terminated`) and never claims a
resumable workspace. The alias is deprecated, retained for one version, and will
be removed in the next version. It is not archive or delete.

Archiving records `archived_at` and keeps the session and its history readable.
An idle session emits `session.status_terminated`, releases its sandbox, and
returns `status: "terminated"`; a running session returns `409` with
`session_running` until it is interrupted. Repeating the archive is idempotent.
New events and messages on an archived session return `409` with
`session_archived`. Archived sessions are excluded from the collection unless
`include_archived=true` is sent on the list request.

`GET /v1/sessions` takes the published query parameters: `limit` (default 20,
cap 1000) and the `page` cursor it returns; `order=asc|desc` sorting by
`created_at` (default `desc`); `agent_id`, with `agent_version` applying only
beside it (sent alone it is ignored); `include_archived=true|false`;
`memory_store_id`, matching sessions holding a `memory_store` resource with
that id; `deployment_id`, matching sessions created by that scheduled
deployment; a repeatable `statuses` (or the SDK's `statuses[]`) filter whose
values must be `idle`, `running`, `rescheduling`, or `terminated` — each
selects every internal state in that public group, and `rescheduling` matches
nothing yet; and `created_at[gt]`, `created_at[gte]`, `created_at[lt]`, and
`created_at[lte]` creation-time bounds. An invalid status value, an
unparseable timestamp or `order`, a non-integer `agent_version`, or a
parameter outside this set is a `400` naming it. A `page` cursor binds the
`order` and `created_at[*]` window it was issued under and is refused when
either changes on replay; the remaining filters may change freely across a
replay.

Updating a session patches it in place. `agent` admits only `tools` and
`mcp_servers`, which replace wholesale and are merged onto the definition the
session resolves today — its own snapshot or the agent it follows — before the
result is materialized as the session's snapshot; the agent itself is never
changed. `metadata` merges per key with `null` removing a key (`null` for the
whole field is no change), and `title` replaces with `null` clearing. An agent
change needs an idle session: a running one returns `409` with
`session_not_idle` and must be interrupted first, while `title`, `metadata`,
and `budget` move in any non-terminal state. `budget` moves the session's
ceiling under the budget rules below — an object replaces it, `null` removes
it — with refusals spelled `budget_create_only`, `budget_not_raised`,
`model_not_budgetable`, or the `budget_invalid_*` family for a malformed
value. `vault_ids` returns `vault_ids_not_updatable`, an `agent` field outside
the pair returns `agent_field_not_updatable`, and a terminated or archived
session returns `409` with `session_terminated`. A change emits one
`session.updated` event carrying only the fields that changed — the full
agent snapshot, the new ceiling or `null`, the whole post-update metadata
bag, the new title — and a no-op request emits
none. The new configuration applies from the next turn.

Deleting a session is permanent. A running session returns `409` with
`session_running` and must be interrupted to `idle` first. Otherwise the runtime
emits `session.deleted` to live event streams, closes those streams after the
event is written, removes the session row and event history, releases the
sandbox, removes snapshots and session-generated files, and returns
`{id, type: "session_deleted"}`. User-uploaded files are retained but are
detached from the deleted session; retrieving the deleted session or its events
returns `404`.

Listing persisted events returns the canonical envelope `{data, prev_page, next_page}` with a
followable `next_page` cursor to pass back as `page`; the local `after_id` names the same
position and is also accepted. `limit` still caps the page. `prev_page` is always `null`,
because the scan is forward-only and a cursor that does not resolve would be worse than an
honest null. A `page` this route did not issue — malformed, issued for another session or
another ordering, or naming an event not in the log — is a `400` rather than a silent
restart from the first event.

Create a session:

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "agent_assistant",
    "environment_id": "env_default",
    "title": "Local test",
    "resources": [],
    "vault_ids": [],
    "metadata": { "source": "docs" }
  }'
```

`loop_engine` is optional and selects the execution engine for this session only.
Omit it to use the effective Settings default. The selected engine is persisted
and frozen on the session, so later Settings changes do not switch an existing
session. Every session response returns the frozen `loop_engine` value.

Admission is fail-closed and happens before the session row, event log, or
sandbox is touched:

| Requested value | Result |
| --- | --- |
| omitted or `null` | Effective Settings `loop_engine.provider` is used. |
| `builtin` | Harness tool loop, confirmation, and sandbox policy. |
| `pi` | Local Pi CLI adapter; requires Pi on `PATH` and the local sandbox. |
| `harness`, `codex`, `claude` | `400` with `loop_engine_not_supported` and the descriptor reason. |
| any other value or type | `400` with `loop_engine_invalid`. |

The Pi adapter is available but limited: Runs the Pi CLI as a session-owned RPC child against the host-local work directory; Pi native tools are not governed by Harness approval or sandbox path policy, and an always_ask native tool is gated by a SandBase-managed Pi extension before it executes. An unavailable engine is never silently downgraded to `builtin`.

Pin a session to an immutable agent version snapshot:

```json
{
  "agent": {
    "id": "agent_abc123",
    "type": "agent",
    "version": 1
  },
  "environment_id": "env_default",
  "title": "Replay version 1"
}
```

When `agent.version` is supplied, the runtime stores that agent definition
snapshot on the session. Later edits to the agent do not change the pinned
session's prompt, tools, or skills.

Supported session resources:

```json
[
  {
    "type": "file",
    "file_id": "file_abc123",
    "mount_path": "/uploads/input.txt"
  },
  {
    "type": "github_repository",
    "url": "https://github.com/owner/repo",
    "authorization_token": "ghp_example",
    "checkout": { "type": "branch", "name": "main" },
    "mount_path": "/workspace/repo"
  },
  {
    "type": "memory_store",
    "memory_store_id": "memstore_abc123",
    "mount_path": "/mnt/memory/project-notes",
    "access": "read_write",
    "instructions": "Use this for durable project notes."
  }
]
```

A `github_repository` resource's `checkout` is a typed reference —
`{ "type": "branch", "name": "<branch>" }` or
`{ "type": "commit", "sha": "<sha>" }`; a bare string such as `"main"`, an
unknown type, or an empty name or sha is a `400` rather than a value carried
forward. Omitting `checkout` clones the repository's own default branch, which is
also what the agent is told it is mounted at. Only a `commit` checkout is cached
between sessions; a branch and a default-branch clone are re-resolved every time.

A `memory_store` resource defaults to `/mnt/memory/<slugged-store-name>` when `mount_path` is omitted. Mounted paths are whole-segment paths; traversal and duplicate mount paths are rejected, and a session may attach at most eight stores. The `read`, `write`, `edit`, `glob`, and `grep` tools address mounted content through `memory_records`; read-only mounts reject writes, and shell access is refused while any memory mount is attached because arbitrary shell changes cannot be persisted safely. Updates to existing mounted files require a `precondition_sha256` value so stale content cannot overwrite a newer version.

A `file` and a `github_repository` resource are both materialized at provisioning,
into the canonical roots the runtime reserves for them
(`/mnt/session/uploads/...` and `/workspace/<repo>`). The `local` backend maps
those roots into the session's sandbox directory, so on a local session the
resource is written where the resource says it is. The other shipped backends do
not serve those roots, so the runtime does not accept the session at all: `docker`
refuses every absolute
path, `kubernetes` resolves an absolute path against its own `/workspace` and so
refuses the upload root (and its acceptance of the repository root was never
exercised against a cluster), and a `self_hosted` worker resolves the path inside
its own root, which the runtime can neither verify nor enforce. A
session that declares either resource on one of those three is refused when it is
created, with `resource_not_mountable` and `400`, and nothing is created — no
session row, no resource instance, no event — so the failure names the backend
and the resource instead of surfacing at provisioning. The same refusal applies to
attaching a resource to an existing session
(`POST /v1/sessions/{id}/resources`). The mount path
is named in the agent's instructions — see
[Session resources](#session-resources). See
[Mounting a file into a session](#mounting-a-file-into-a-session) for the file
case and `contracts/anthropic-cma/github-repository.md` for the repository case;
both capabilities are recorded as `supported` for the `local` backend, which is
the backend that serves them.

Only `user.*` events can be appended by clients:

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions/SESSION_ID/events \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      {
        "type": "user.message",
        "content": [{ "type": "text", "text": "Hello" }]
      }
    ]
  }'
```

Tool confirmation and client-side custom tool result events are also appended
through the same endpoint:

```json
{
  "events": [
    {
      "type": "user.tool_confirmation",
      "tool_use_id": "toolu_abc123",
      "result": "allow"
    },
    {
      "type": "user.custom_tool_result",
      "custom_tool_use_id": "customu_abc123",
      "content": [{ "type": "text", "text": "Result returned by an external client-side tool." }]
    }
  ]
}
```

The runtime supports the whole loop rather than only the event protocol. A declared custom tool is exposed to the model with its description and input schema, a call to it is persisted as an `agent.custom_tool_use` event which parks the session in `requires_action`, and the caller answers with `user.custom_tool_result` naming the `custom_tool_use_id`, after which the turn resumes with that result as the model-facing tool result. The runtime never executes a custom tool itself and never fabricates a result for one, so the caller is the only thing that can answer a call — which is why a result naming a call that is not pending, and a second result for a call that already has one, are each refused with `400 invalid_request_error` instead of being appended.

Send and stream a message:

```bash
curl -N -X POST http://127.0.0.1:3000/v1/sessions/SESSION_ID/messages \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello", "stream": true}'
```

Resume the event stream:

```bash
curl -N http://127.0.0.1:3000/v1/sessions/SESSION_ID/events/stream \
  -H "Last-Event-ID: 42"
```

A stream opened **without** a cursor carries live events only: it does not replay
the session's history, because a client that wants the log reads `GET /events`
(or resumes from what it has). `Last-Event-ID: 0` is a cursor, and replays the
whole log. A cursor must be a safe integer — the numeric `seq` this stream uses
as its `id`, which is the only value the log can resume from — and anything else
answers `400 invalid_request_error` before the stream opens, rather than being
silently read as "replay everything" or as "replay nothing". A value too large to
compare exactly is refused with the rest, because every real `seq` is below it
and the connection would never receive a persisted event again. A blank header is
no cursor, and a `Last-Event-ID` that disagrees with `last_event_id` is refused
rather than resolved by precedence.

Every 15 seconds an open stream sends a keepalive frame, which a client skips
rather than treating as an event:

```
event: ping
data: {"type":"ping"}
```

It carries no `id`, so it never moves the resume cursor.

Opt into token-level previews on one connection:

```bash
curl -N "http://127.0.0.1:3000/v1/sessions/SESSION_ID/events/stream?event_deltas[]=agent.message"
```

`event_deltas[]` is repeated once per preview type. Two types are accepted:
`agent.message` and `agent.thinking`. An unsupported value, an empty value, and
more than 100 values each return `400 invalid_request_error` before the stream opens, so
the rejection arrives as a normal response rather than as an error frame on an
established stream. Exactly 100 values are accepted, and a repeated value is
collapsed rather than previewed twice.

An opted-in connection receives `event_start` and `event_delta` frames ahead of the
buffered event they anticipate:

```json
{ "type": "event_start", "event": { "type": "agent.message", "id": "sevt_01J..." } }
{ "type": "event_delta", "event_id": "sevt_01J...", "delta": { "type": "content_delta", "index": 0, "content": { "type": "text", "text": "Hel" } } }
```

Previews are never persisted. A preview frame carries no `id` and no
`processed_at`, so it must not advance the `Last-Event-ID` cursor; the only
identifier it carries is the id of the event it previews, which is what an
accumulator keys on to reconcile the preview against the buffered event when it
lands. At most one `event_start` is emitted per previewed id.

A preview is a prefix, not the full text. Deltas may be dropped under load, so
render the buffered event as the record and treat the accumulated preview as a
draft.

`agent.message` previews carry incremental text. `agent.thinking` receives an
`event_start` only, because the buffered `agent.thinking` event carries no
reasoning text and a delta would have to invent content.

### system.message

A session accepts `system.message` as an inbound event alongside the `user.*`
family. The payload uses the same content-block vocabulary as `user.message`:

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions/SESSION_ID/events \

  -H "Content-Type: application/json" \

  -d '{"events": [{"type": "system.message", "content": [{"type": "text", "text": "Answer in Japanese."}]}]}'
```

`content` must be a non-empty array of at most 1000 valid blocks. An empty array,
a bare string, a block whose text is empty or whitespace-only, and a batch over
the ceiling each return `400 invalid_request_error`. A size violation is reported as a
size violation, naming the ceiling, rather than as a generic shape error.

`system.message` is privileged system-level context, not a user turn. It applies to
the accompanying turn and every later turn, in contrast to the agent's `system`
field, which sets the top-level prompt. In the model context it projects as its own
`system` role turn; a `system.message` that arrives while an assistant turn is
pending flushes that turn first, and one whose blocks carry no usable text is
dropped rather than projected as an empty turn.

### Event ordering and metadata

Persisted event responses include an append-only per-session `seq` and optional
`metadata`. The same envelope is used by `GET /events` and the resumable event
tail. SSE uses the numeric `seq` as its `id`; send the highest contiguous value
received as `Last-Event-ID` to replay only later durable events, and send nothing
to receive live events only. Transient
`agent.message_stream_*` events have `seq: 0`, are not replayed, and must not
advance that cursor.

Model-derived events may include `model_used`, `tokens_in`, `tokens_out`,
`stop_reason`, and `duration_ms`. Token fields on event projections provide
local attribution only; session usage is recorded once per model request and
is the source for aggregate token totals.

Approval-gated `tool_use` blocks include `requires_confirmation: true` and a
`confirmation_group_id`. The corresponding `user.tool_confirmation` event
stores its target and decision in event metadata. The session stays in
internal `requires_action` until every tool use in that group has a paired result.
The session response exposes that state as `status: "idle"`; the event's
`stop_reason.type: "requires_action"` identifies the outstanding action.

The matching `session.status_idle` event carries a session-level `stop_reason`
**object at the top level**, which is where the published client reads it:

```bash
# the reason the turn ended: "requires_action" or "end_turn"
jq -r 'select(.type == "session.status_idle") | .stop_reason.type // empty'
```

| `stop_reason.type` | Meaning |
| --- | --- |
| `requires_action` | The session is waiting for an answer to a blocking tool call. `event_ids` lists the parked calls, by their own event id. |
| `budget_reached` | The turn stopped after the step that crossed the session's spending ceiling. An accepted budget update or removal resumes the session on its own; a work-starting event before that is refused with `budget_reached`. A parked call still wins over this reason — see `requires_action`. |
| `retries_exhausted` | The retry policy gave up on a transient model failure after `session.status_rescheduled`. The session stays usable — a later `user.message` starts a new turn. |
| `end_turn` | The turn ended with nothing outstanding. An interrupt reports `end_turn` as well; there is no separate interrupt reason. |

The object is also kept under `metadata.stop_reason`, and is exactly the
published `{type, event_ids}`. An idle event with no reason omits the field
rather than sending `null`.

Each entry in `event_ids` is the `id` of the parked event — an approval-gated
`agent.tool_use` / `agent.mcp_tool_use`, or an `agent.custom_tool_use` the caller
has not answered — and that is the value to answer with:

```json
{ "type": "user.tool_confirmation", "tool_use_id": "<event id from event_ids>", "result": "allow" }
```

```json
{ "type": "user.custom_tool_result", "custom_tool_use_id": "<event id from event_ids>", "content": [{ "type": "text", "text": "{\"name\":\"Ada\"}" }] }
```

The `tool_use` block id is also accepted in both fields, as a local convenience.
Whichever you send, the confirmation event's `metadata.tool_use_id`, the
`agent.tool_result` written for a decision, and a custom tool result's
`metadata.custom_tool_use_id` all carry the block id, which is what a
`tool_result` pairs against, and a second answer for the same call is refused
either way.

A custom tool call that has been answered stops being listed in `event_ids`.

**Answer every id, then the turn resumes.** Each answer is recorded as it
arrives, and the session stays in `requires_action` while any call in
`event_ids` is still unanswered. The turn starts when the last one is answered.
So a loop that sends one answer per entry — as the published client does — is
the supported path, and sending only some of them leaves the session waiting
rather than failing it:

```bash
# Answer every parked call; the last one starts the turn.
for id in $(jq -r '.stop_reason.event_ids[]' <<<"$idle_event"); do
  # ... send the matching tool_confirmation or custom_tool_result for "$id"
done
```

Waiting is not an error and not a timeout: nothing changes until you answer the
rest. A partial answer never terminates the session and never records a
`session.error`.

#### Bounding the wait (optional, off by default)

By default a parked session waits indefinitely, exactly as the protocol
specifies. An operator can bound that wait, which is useful for an unattended
deployment where nobody is coming back to answer:

```jsonc
// runtime settings → loop_engine.options
{ "requires_action_timeout_seconds": 3600 }
```

With a bound set, a session parked longer than that is ended: a `session.error`
carrying `requires_action_timeout` (`retry_status.type: "terminal"`) is appended
and the session reaches internal `timed_out`, published as `status: "terminated"`
and `session.status_terminated`.

- The bound is measured from the event that parked the session, so a session that
  had already been parked longer than the bound when the runtime started ends on
  the next pass instead of restarting its clock.
- The parked calls are **not** answered. The session stops waiting; the runtime
  does not decide on your behalf what your tools returned, so nothing enters the
  log that you did not send.
- A session that is also at its spending ceiling is **never** ended this way. It
  is still waiting for the very event that settles its spend, and that answer is
  still accepted.
- Nothing is configured by default, and the key is not reachable from an agent
  definition, so an agent cannot widen or remove its own bound.

Tool events carry their payload both in `content[0]` and at the top level, so a
client can read a call without unpacking the block:

| Event | Top-level fields |
| --- | --- |
| `agent.tool_use` | `name`, `input` |
| `agent.mcp_tool_use` | `name`, `input`, `mcp_server_name` |
| `agent.custom_tool_use` | `name`, `input` |
| `agent.tool_result` | `tool_use_id` |
| `agent.mcp_tool_result` | `mcp_tool_use_id` |
| `user.custom_tool_result` | `custom_tool_use_id` |
| `user.tool_confirmation` | `tool_use_id` |

A field the persisted block does not carry is omitted rather than sent as
`null`. The top-level `id` on a tool event is the event's own id, not the
tool-call id: the tool-call id stays available as `content[0].id`, and the two
are different values.

Session event records may include optional execution metadata when available:
`model_used`, `tokens_in`, `tokens_out`, `stop_reason`, and `duration_ms`.
Clients should treat absent fields as unknown and preserve the event's existing
append-only ordering and SSE resume semantics.

### Steering a live turn

A `user.steer` event carries a mid-turn instruction to the engine session that is
already running the turn, instead of waiting for it or starting another one:

```json
{
  "events": [
    {
      "type": "user.steer",
      "input_id": "steer_1",
      "text": "Prefer the smaller change.",
      "expected_turn_id": "piturn_1"
    }
  ]
}
```

It is its own event and never becomes a `user.message`. A message is queued on
the session's serialized execution chain and starts a turn, whereas this
instruction is written to the running turn's own input channel — a steer routed
through the chain would be applied only after the turn it was meant to influence
had ended. Because there is nothing to steer without a turn, a steer is refused
rather than buffered for a later one.

The response reports what the engine actually did with it:

```json
{
  "accepted": true,
  "steer": { "input_id": "steer_1", "state": "delivered", "turn_id": "piturn_1" }
}
```

| `state` | Meaning |
| --- | --- |
| `delivered` | The engine accepted the write. |
| `duplicate` | This `input_id` was already delivered with the same text; nothing was sent a second time. |
| `conflict` | This `input_id` was already used with different text. The steer is refused, never merged into the earlier one. |
| `rejected` | No live engine session was accepting steering: there is no turn in flight, the turn has already closed steer admission, the child is gone, or `expected_turn_id` did not name the active turn. Resending is safe. |
| `outcome_unknown` | The write was not acknowledged. It must never be replayed, because the engine may already have acted on it. |

`accepted` is `false` for `rejected` and `conflict` only. An `outcome_unknown`
steer is reported as accepted, because telling a caller it failed would invite
exactly the replay the contract forbids.

The rest of the steer contract:

- `input_id` is an idempotency key, and a repeat with the same text is answered
  as the same receipt rather than applied twice.
- One steer may be in flight per turn; a second steer while one is pending is
  refused with a receipt that says so, not queued behind it.
- Steer admission closes before the turn's completion marker is published, and
  receipts already accepted settle before it, so a client that has seen a turn
  finish never afterwards watches a steer land in it.
- A steer carries text and nothing else. It cannot start work, expose a tool, or
  change the turn's tool policy, so it is never able to run a tool.
- The event is persisted with its receipt in `metadata` (`input_id`,
  `steer_state`, and `turn_id` / `detail` when present), so a client reading the
  log back can tell a delivered steer from one the engine never heard.

The event is answered only by an engine that owns a live input channel for the
session. The `pi` engine does; the builtin loop is turn-serialized, so a steer
there is refused the same way as one for a session with no turn in flight.

The TypeScript SDK exposes the same call as
`sessions.steer(id, { inputId, text, expectedTurnId? })`.

### session.error

Every failed turn appends one `session.error` carrying a structured payload in a
top-level `error` field:

```json
{
  "id": "sevt_01J...",
  "seq": 12,
  "type": "session.error",
  "content": [{ "type": "text", "text": "Provider \"openai\" takes its api_key from environment variable OPENAI_API_KEY, which is not set in the runtime's environment. ..." }],
  "error": {
    "type": "model_request_failed_error",
    "message": "Provider \"openai\" takes its api_key from environment variable OPENAI_API_KEY, which is not set in the runtime's environment. ...",
    "retry_status": { "type": "terminal" },
    "code": "model_config_invalid"
  }
}
```

`type` is one of the eight official error classifications —
`unknown_error`, `model_overloaded_error`, `model_rate_limited_error`,
`model_request_failed_error`, `mcp_connection_failed_error`,
`mcp_authentication_failed_error`, `billing_error`, and
`credential_host_unreachable_error` — and `code` is the stable local code the
runtime attached to the failure, or `internal_error` when the failure carries
none. `content` still carries the message as a text block, so a client that
only renders content keeps working.

A provider credential or endpoint written as `${VAR}` is resolved before the
request is built. When the variable is not set in the runtime's own environment
the turn fails with `model_config_invalid` and a message naming the variable, the
field (`api_key` or `base_url`), and the provider, and **no request is sent**:
the alternative this replaced left the placeholder in place, so
`${OPENAI_API_KEY}` travelled as the credential and the provider answered `401`
with a message that named neither. The message carries the three repairs that
apply — set the variable in the environment the runtime was started from, write
the value literally in the model provider editor under `Dashboard Settings >
Advanced`, or remove the reference —
and the session is left resumable, so a later turn on it runs once one of them is
done. Saving that literal value through `PUT /v1/x/settings` is only in effect
after the runtime restarts (the write stays `restart_required` until the next
start), which the settings response reports and the Console's Setup page states.
That code and that classification are the builtin engine's. With
`loop_engine.provider: "pi"` the same unset reference is refused one step earlier
— the launcher resolves the model's credential before it spawns the Pi CLI, so no
request is sent there either, and its message names the variable — but it is
reported as `unknown_error` with `code: "internal_error"` and the session is
left `failed` rather than resumable. Only the code and the session's ability to
continue differ; making the Pi path raise the same error is a decision this
document does not make.

Which path can reach that failure is worth stating, because the two write paths
differ. `PUT /v1/x/settings` refuses a document whose `model.api_key` (or another
secret path) is an unresolved `${VAR}` before it is stored, answering `422` with
the `missing_env` issue naming the variable; the workspace configuration file
(`.managed-agents/config.yaml`, which `init` writes as
`api_key: ${OPENAI_API_KEY}`) is read at start-up with no such check, and a
variable that was set when settings were saved can also be gone from a later
start's environment. Both reach the refusal above. The turn is where a provider
is first contacted; the runtime names the variable earlier than that when it can —
a workspace configuration that cannot be activated reports `activation_status:
"failed"` with `activation_errors` naming it in the settings response, from the
first start.

Two states supply no value and both are refused: the variable is unset, or it is
set to the empty string. The settings layer reports either as `missing_env`, and
the model client treats either as a configuration mistake rather than sending an
empty credential the provider would answer with an unattributed `401`.

`retry_status` is the published object `{ "type": "retrying" | "exhausted" |
"terminal" }`, derived from `code`, never guessed from the message:

| `retry_status.type` | Meaning | Codes |
| --- | --- | --- |
| `retrying` | Transient; the same request may succeed. | `pi_session_busy`, `work_queue_timeout`, and each scheduled model retry during `rescheduling` |
| `exhausted` | The retry policy gave up; the turn ended, the session did not. | the final model error of an exhausted retry wait — the session idles with `stop_reason: retries_exhausted` and still accepts a new message |
| `terminal` | The runtime will refuse this request again, or the failure is not classified. | `pi_cleanup_pending`, `pi_timed_out`, `pi_rpc_gate_unavailable`, `pi_rpc_gate_lost`, `pi_rpc_approval_not_pending`, `pi_rpc_protocol_error`, `pi_rpc_timeout`, `pi_rpc_outcome_unknown`, `pi_always_ask_not_supported`, `pi_tool_policy_not_supported`, `pi_sandbox_provider_not_supported`, `pi_user_event_not_supported`, `pi_message_content_not_supported`, `loop_engine_not_supported`, `loop_engine_invalid`, `unsupported_capability`, `requires_action_timeout`, `work_outcome_unknown`, `work_lease_lost`, `outcome_evaluator_unavailable`, `outcome_rubric_file_not_found`, `model_not_found`, `model_provider_not_configured`, `model_config_invalid`, `model_auth_failed`, any other code, and a failure with no code |

`pi_always_ask_not_supported` is retained in that table but is no longer produced:
an `always_ask` native tool is now decided by the Pi session's pre-execution gate
instead of being refused at admission, and the code stays classified for sessions
created by an earlier build so a client branching on it does not lose the
distinction. The three gate codes are the new permanent failures — the gate
extension did not load, a gated call executed with no decision attached, or a
`user.tool_confirmation` named a gate this runtime was not waiting on.

The runtime produces all three values: `retrying` while a transient model
retry is scheduled, `exhausted` when that policy gives up, and `terminal` for
everything the runtime will not retry. Events persisted before this
shape existed stored the local code in `type` and a string disposition —
`retryable`, `not_retryable`, or `unknown` — in `retry_status`; the projection
normalizes them on the way out, so a client reading an old log sees the same
published shape (`retryable` → `retrying`, the other two → `terminal`, and the
stored `type` reclassified and preserved as `code`).

A turn aborted by the caller is not a failure and records no `session.error`.

### Runs

`POST /v1/runs` starts one turn and returns its result, so a client does not have to
drive the session lifecycle by hand. A run is one turn of one session, so
`run_id` and `session_id` are always the same value.

```json
{
  "agent": "agent_echo-agent",
  "input": "Summarize this repo.",
  "response_mode": "wait",
  "max_wait_seconds": 60
}
```

`response_mode` selects how the answer is delivered:

| Mode | Response |
| --- | --- |
| `wait` (default) | 200 with `run_id`, `session_id`, `status`, `output` (the `agent.message` content blocks), and `usage`. |
| `sse` | An SSE stream of the session's events, ending on a terminal event. |
| `async` | 202 with `run_id`, `session_id`, `status`, `events_url`, and `stream_url`. `stream_url` is the session's event stream, which carries live events only unless the caller resumes from a cursor (`events_url` first, then its last `seq` as `Last-Event-ID`). |

`max_wait_seconds` bounds only the `wait` mode, from 0 to 3600. When it elapses
with the turn still working, the answer is 202 with the query handle and
`wait_deadline_reached: true`. That is a transport deadline, not an execution
timeout: the session keeps running and its terminal state is not pre-empted.

The optional `session` object applies session fields at creation: `title`,
`resources`, `vault_ids`, and `metadata`. A `file` or `github_repository` in
`session.resources` is admitted on the same terms as session creation, so a run on
an environment whose `sandbox_provider` cannot serve the canonical mount roots
(`docker`, `kubernetes`, `self_hosted`) is refused with `400` and code
`resource_not_mountable` before the session row exists.

A refusal that happens before a turn starts is answered with its own status
rather than as a runtime fault: an unavailable engine returns
`loop_engine_not_supported`, an unknown value returns `loop_engine_invalid`,
an unresolvable environment returns its own configuration code, a resource its
backend cannot mount returns `resource_not_mountable`, and an unknown agent
returns 404. A failure raised while waiting or streaming is
recorded once into the session's event log as `session.error`, so it replays
from `GET /v1/sessions/{id}/events` exactly like one the turn loop recorded
itself.

Session budgets are not part of this endpoint.

### Starting a session with initial events

`POST /v1/sessions` accepts an optional `initial_events` array so a client can
start the agent loop in the same call that creates the session:

```json
{
  "agent": "agent_echo-agent",
  "initial_events": [{ "type": "user.message", "content": "Summarize this repo." }]
}
```

`user.define_outcome` is the other accepted type: it carries the session's success
criteria instead of a message.

```json
{
  "agent": "agent_echo-agent",
  "initial_events": [{
    "type": "user.define_outcome",
    "description": "Ship a working endpoint",
    "rubric": { "type": "text", "content": "The endpoint returns 200" },
    "max_iterations": 5
  }]
}
```

`rubric` is either `{ "type": "text", "content": "..." }` or
`{ "type": "file", "file_id": "file_..." }`, and `max_iterations` defaults to 3 and is
capped at 20 — a value outside that range is rejected rather than lowered, because
quietly shrinking the budget would change how much work the outcome may do. The
admitted event is normalized before it is written, and admission assigns the
outcome its server-generated `outc_` id, which the event listing projects back as
top-level `outcome_id`, `description`, `rubric` and `max_iterations` fields. Every
`span.outcome_evaluation_*` the loop appends references the same `outcome_id`, and
so does the session's `outcome_evaluations` entry.

A non-empty list produces a session whose status is `running` and whose event
log already contains every supplied event, in order. An absent field and an
empty array behave the same way: the session is created idle.

The declaration is also the instruction: the event projects into the agent's
context as the outcome description plus the rubric, so the turn it queues works
against the criteria instead of ignoring them.

Once that turn completes, the outcome is measured and the measurement is
published on the session's event log as three events, in order:

| Event | Payload |
| --- | --- |
| `span.outcome_evaluation_start` | `outcome_id`, `iteration` |
| `span.outcome_evaluation_ongoing` | `outcome_id`, `iteration` |
| `span.outcome_evaluation_end` | `outcome_id`, `iteration`, `result`, `explanation`, `outcome_evaluation_start_id` |

`iteration` counts from `0`: it is `0` for the evaluation of the declared outcome and
`n` for the re-evaluation after the n-th revision. `result` is `satisfied`,
`needs_revision`, `failed`, `max_iterations_reached`, `interrupted` or
`budget_reached`, and the end event is appended on every path — including when the
grader could not run — so a client watching for it never hangs on an evaluation
that is already over. The
grader runs in its own context window over what the agent produced: its messages,
tool calls and tool results, never the system prompt or an earlier verdict.

A `needs_revision` verdict drives the next iteration. The runtime appends the
grader's explanation to the session log as a real `user.message` and runs another
turn inside the same outcome, so the revision is visible in the log and the next
turn reads its instruction from it. The loop ends at the first `satisfied` or
`failed`, at the declared `max_iterations`, or when the session is interrupted:

- the last allowed evaluation reports `max_iterations_reached` instead of asking
  for a revision the budget cannot run, and the agent still gets one final turn to
  settle its answer before the session goes idle;
- an interrupt closes the outcome with one further
  `span.outcome_evaluation_end` carrying `result: "interrupted"` and an empty
  `outcome_evaluation_start_id`, because the close is not tied to one evaluation,
  and records no `session.error`;
- a revision turn that stops for a tool confirmation ends the outcome as
  `interrupted` too: the loop cannot drive another turn while the session waits
  for a human, and the session reports `idle` with a `requires_action` stop reason;
- a session that reaches its spending ceiling stops iterating: the loop spends
  nothing more — not the grader pass that would measure the turn that just ran, not
  the revision turn, and not the settling turn — and the outcome closes with one
  further `span.outcome_evaluation_end` carrying `result: "budget_reached"` and an
  empty `outcome_evaluation_start_id`. Admission still refuses the next
  work-starting event with `budget_reached`, so one name covers both facts.

Each iteration is observable: one revision `user.message` per revision and one
`span.outcome_evaluation_start` / `_ongoing` / `_end` triple per evaluation.

Grading needs a model provider. With none configured the evaluation closes as
`failed` and the session records `session.error` with code
`outcome_evaluator_unavailable` and `retry_status.type: "terminal"`, because a
missing provider is a configuration problem rather than a transient one. A
`{ "type": "file" }` rubric is read from the uploaded file; if it cannot be read
the refusal is `outcome_rubric_file_not_found` rather than a verdict against an
empty rubric. A runtime that composes no grader at all refuses the declaration at
admission with `outcome_grader_unavailable` (400) instead of accepting an outcome
it can never evaluate.

Validation runs before any session row, event, or sandbox exists, and creation
and the events commit together, so a rejected batch leaves no session and no
partial history behind:

| Rejection | Error code |
| --- | --- |
| `initial_events` is not an array | `invalid_initial_events` |
| More than 50 events | `too_many_initial_events` |
| An element is not an object | `invalid_initial_events` |
| An element's `type` is neither `user.message` nor `user.define_outcome` | `invalid_initial_event_type` |
| A message `content` is neither a string nor an array of content blocks | `invalid_initial_events` |
| An outcome lacks a `description`, has a malformed `rubric`, or sets `max_iterations` outside 1..20 | `invalid_initial_events` |
| The runtime composes no outcome grader, so a declared outcome could never be measured | `outcome_grader_unavailable` |

The same normalization runs on a live event: `POST /v1/sessions/{id}/events` with a
malformed `user.define_outcome` answers `400` with code `invalid_define_outcome` and
writes nothing.

The creation response does not echo `initial_events`; list the session's events
to confirm what was written.

### Overriding an agent for one session

`agent` accepts a third form, `agent_with_overrides`, which runs an agent with
part of its configuration replaced for this session only:

```json
{
  "agent": {
    "type": "agent_with_overrides",
    "id": "agent_echo-agent",
    "model": "claude-sonnet-4",
    "system": "Answer only in haiku."
  }
}
```

The overridable fields are `model`, `system`, `tools`, `mcp_servers` and
`skills`. The rule is per field: an omitted field is inherited from the
referenced version, `null` (or `[]` for a list) clears it for this session, and
a value replaces it wholesale. Overrides never merge, so a `tools` override has
to list every tool the session should have.

| Refusal | Error code |
| --- | --- |
| `model: null` | `agent_model_required` |
| `tools` cleared while the effective `skills` is non-empty | `agent_tools_cleared_with_skills` |
| The effective `tools` binds an `mcp_toolset` to a server `mcp_servers` does not declare | `agent_mcp_server_not_found` |
| A field is malformed; the message names it | `invalid_agent_override_field` |
| The object carries a field the contract does not let a session override | `invalid_agent_overrides` |
| The reference itself is malformed | `invalid_agent_ref` |

A malformed `model` reports the model profile's own codes — `invalid_model`,
`invalid_model_speed`, `unsupported_model_field` — the same ones an agent
definition reports for that field. `model.effort` is refused with
`invalid_agent_override_field`: the provider model is resolved from the agent's
model id, so a level set on a session would reach no request. The agent
definition is where the level is retained and echoed — set it there and every
session that runs the agent, snapshot included, reports it.

The override modifies nothing: it does not touch the agent and does not create a
version. The session stores the resolved configuration as its own snapshot, and
`agent.id` and `agent.version` still name the agent and version it was derived
from, while the agent's own read-back is unchanged. Every refusal above is a 400
raised before the session row exists, so a rejected override creates nothing.

`POST /v1/runs` accepts only the two pinning forms; the override form is refused
there instead of being accepted and ignored.

### Declaring a spending ceiling

`POST /v1/sessions` accepts an optional `budget`, so a runaway loop stops at a
cost the client chose:

```json
{
  "agent": "agent_echo-agent",
  "budget": { "type": "limit", "max_list_cost": { "amount": "500", "currency": "USD" } }
}
```

`amount` is an integer number of cents written as a string — `"25.00"`, `"0"`,
and `"0125"` are all rejected — and `currency` is `USD`. The budget can only be
set at creation: the runtime refuses to attach one to a session that was created
without it, refuses to re-attach one after a removal, and refuses a cap at or
below what the session has already consumed.

Cost is priced from an operator-supplied profile (`MANAGED_AGENTS_COST_PROFILE`),
not from vendor prices, so a model the profile does not list has no list price.
A budgeted session that would run an unpriced model is refused rather than
metered against an invented rate. With no profile configured, no model is priced
and no session can be budgeted.

| Rejection | Error code |
| --- | --- |
| `amount` is not a positive integer string, or has a leading zero | `budget_invalid_amount` |
| `currency` is not `USD` | `budget_invalid_currency` |
| `type` is not `limit`, the shape is wrong, or `budget` is `null` | `budget_invalid_shape` |
| The session's model has no list price in the configured profile | `model_not_budgetable` |

A turn also stops *inside* the ceiling: the builtin loop checks the spend after
each model step, so the step that crossed the cap is the last one. The session
then idles with `stop_reason: {type: 'budget_reached'}` — `session.usage`
immediately before it — and a tool call the loop dispatched but never executed
is settled with an interrupted-outcome result so the transcript stays paired.
An accepted budget update through `POST /v1/sessions/{id}` (a raise or `null`)
resumes the session on its own: the turn loop re-enters without a `user.message`
and continues from the event log. A `requires_action` reason outranks the
ceiling — a parked call waiting on its answer is reported first.

Once a session has reached its ceiling, an event that would start new model work
is refused with `budget_reached`, and only events that settle work already in
flight are accepted — the refusal names them. This stops the *next* model
request rather than aborting one in progress: the request that crossed the cap
has already completed and been charged.

A declared outcome stops at the ceiling too. The loop reads the session's spend
before it spends anything, so a session that reaches its ceiling during an outcome
runs no further iteration and no further grading pass, and the outcome closes with
`result: "budget_reached"` on its terminal `span.outcome_evaluation_end`. The
ceiling is enforced there as well as at admission because a revision turn is not an
event: it is internal to the declaration that was already admitted.

The creation response reports the budget back as `budget`, or omits the field
when the session has none. A session whose budget was removed reports `null`
instead, which is how a client tells "never had one" from "had one removed".

### MCP tool identity

`agent.mcp_tool_use` and `agent.mcp_tool_result` events carry the MCP server
that produced the call as `mcp_server_name`, so two servers exposing the same
tool name stay distinguishable in the log. Tool results additionally carry
`mcp_tool_use_id`, the tool use they answer. Non-MCP tool events carry neither
field.

### Usage snapshots

`session.usage` is written immediately before every `session.status_idle`, so a
client can settle the finished turn before it observes the idle transition:

```json
{
  "type": "session.usage",
  "usage": {
    "input_tokens": 5000,
    "output_tokens": 3200,
    "active_seconds": 12.5,
    "list_cost": 7,
    "budget": { "type": "limit", "max_list_cost": { "amount": "500", "currency": "USD" } },
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 }
  }
}
```

`active_seconds` is the wall-clock time the harness loop was executing the
session, derived from the `session.status_running` → `session.status_idle`
intervals in the durable log. `list_cost` is withheld when it cannot be
computed in full, because a lower bound reported as the total would understate
spend to a client that is choosing a new cap; the remaining fields are always
present, because the runtime holds a true value for each:

| Field | Status |
| --- | --- |
| `input_tokens`, `output_tokens` | Reported from the session's aggregate token counters. |
| `active_seconds` | Reported. Single-threaded session, so "at least one thread running" is the sum of the turn intervals. |
| `list_cost` | Accumulated list cost in whole cents, priced from the operator's cost profile. Omitted when any model the session used has no list price. |
| `budget` | The session's budget, or `null` when it has none. |
| `server_tool_use` | Reported. Both counters are zero: no built-in web tool exists to count. |

`active_seconds` appears only on the snapshot event. The session envelope keeps
its accumulated token counters and does not recompute activity time per
request; read the latest `session.usage` event or the log for that.

## Files

Files can be uploaded once and mounted into sessions.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/files` | List active files. |
| `POST` | `/v1/files` | Upload a file. |
| `GET` | `/v1/files/{file_id}` | Retrieve file metadata and preview. |
| `GET` | `/v1/files/{file_id}/content` | Download file content. |
| `DELETE` | `/v1/files/{file_id}` | Archive a file. |

Multipart upload:

```bash
curl -X POST http://127.0.0.1:3000/v1/files \
  -F "file=@notes.txt"
```

JSON upload:

```bash
curl -X POST http://127.0.0.1:3000/v1/files \
  -H "Content-Type: application/json" \
  -d '{
    "name": "notes.txt",
    "media_type": "text/plain",
    "content": "hello",
    "encoding": "utf8"
  }'
```

The per-file upload limit is 10 MB.

### Session outputs

An agent's deliverables are the files it writes under `/mnt/session/outputs/`
inside its sandbox. After a turn finishes the runtime walks that directory and
publishes what it finds as session-scoped file records, so the deliverables become
retrievable through the Files API. The directory is walked rather than reported
through a side channel, because the agent writes with ordinary shell and file
tools that record nothing.

Publishing is idempotent per (session, sandbox path). A second pass over an
unchanged output root refreshes the same records instead of minting duplicates, so
the same deliverable keeps one file id, and a file the agent rewrote keeps the id a
caller already holds. The number of new files recorded in one pass is capped, which
guards against a runaway agent filling the artifact store in a single turn.

Collection is best-effort: a failure is swallowed because the turn has already
completed, and the next turn re-reads the same directory.

### Mounting a file into a session

A file attached to a session carries a `mount_path` that is a logical path inside
the session, not a sandbox path. The runtime maps it under its own mount root, so
the caller never has to know the sandbox layout:

```json
{ "type": "file", "file_id": "file_01J...", "mount_path": "/data.csv" }
```

| Input `mount_path` | Resulting sandbox path |
| --- | --- |
| `/data.csv` | `/mnt/session/uploads/data.csv` |
| `/src/main.py` | `/mnt/session/uploads/src/main.py` |
| omitted or blank | `/mnt/session/uploads/<file_id>` |
| `/uploads/file.txt` | `/mnt/session/uploads/file.txt` |

The whole relative path is preserved, so a nested layout is not flattened to its
basename. Validation runs on the logical path before the mapping, and a path that
is relative, contains `.` or `..`, contains an empty segment, contains a backslash
or a NUL byte, or names the bare root is rejected with `invalid_request_error`.

The historical `/uploads/` prefix is still accepted as a logical path, so an
existing request keeps working; it simply no longer maps to the mount root
itself, which is why `/uploads/file.txt` and `/file.txt` both land at
`/mnt/session/uploads/file.txt`.

On the `local` backend the bytes are written at that sandbox path and read back
from it, so `LocalSandboxProvider` recognizes the canonical `/mnt/session/...`
and `/workspace/...` roots by mapping them into the session's sandbox directory.
A command string is not rewritten: the shell resolves an absolute path against
the host filesystem, so inside a command the same file is named by its
sandbox-relative spelling (`mnt/session/uploads/file.txt`), and a tool that
reaches the sandbox through the runtime's file API can use the canonical path.
The system prompt's `# Session Resources` section names the mounted path to the
agent — the canonical spelling, plus the sandbox-relative one on the `local`
backend (see [Session Resources](#session-resources) below). The backend it names
is the one recorded when the session's sandbox was provisioned, so editing an
Environment's `sandbox_provider` after a session is bound does not change what
that session's instructions say: the sandbox in hand is the one serving it.
The container backends still do not mount it: `docker` rejects an absolute path
outright and `kubernetes` rejects anything outside `/workspace`. A session that
attaches a file resource on one of those, or on a `self_hosted` worker (which
resolves the path inside its own root), is refused
when it is created with `resource_not_mountable` and `400`, before any record
exists, instead of being accepted and failing at provisioning
(`Path escapes sandbox workspace`). The same refusal answers an attempt to attach
the resource to an existing session on such a backend. The capability is recorded
as `supported` for the `local` backend in `contracts/anthropic-cma/files.md`,
which is the scope the entry states.

## Session Artifacts

Artifacts are generated outputs associated with a session. They use the same
local artifact storage backend as uploaded files, but are listed under the
session instead of `/v1/files`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/sessions/{session_id}/artifacts` | List generated artifacts for a session. |
| `POST` | `/v1/sessions/{session_id}/artifacts` | Record a generated artifact. |
| `GET` | `/v1/sessions/{session_id}/artifacts/{artifact_id}/content` | Download artifact content. |

Artifact paths must start with `/artifacts/`:

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions/SESSION_ID/artifacts \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/artifacts/report.md",
    "name": "report.md",
    "media_type": "text/markdown",
    "content": "# Run report\n\nGenerated locally."
  }'
```

Text, Markdown, JSON, YAML, HTML, and SVG artifacts include inline previews in
metadata responses. Raw storage paths are never returned.

### Memory versions

A memory is overwritten in place, so every write also records an immutable
version row carrying the store, the memory, a per-memory monotonic version
number, the path, the content, its SHA-256, its size in bytes, the change kind,
and the session that made it. A memory's history is therefore reconstructable
without diffing snapshots of the store, and a second writer claiming a version
that already exists is refused by a unique index rather than overwriting the
first. Numbering is per memory, so two memories in one store do not share a
sequence. The live memory row is unchanged by reading a version.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/memory_stores/{memory_store_id}/memory_versions` | List recorded versions, newest first. |
| `GET` | `/v1/memory_stores/{memory_store_id}/memory_versions/{version_id}` | Read one recorded version. |

Pass `memory_id` to the listing to read the history of one memory alone. The
recorded content hash is the same digest the store's precondition checks use, so
a version can be verified without trusting the row.

### Session resources

A resource attached to a session is a per-session instance with its own
`sesrsc_` id, so it can be addressed, updated, and detached without rewriting
the session payload. Attachment is additive and reversible: detaching a resource
from one session leaves it attached to every other session that holds it.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/sessions/{session_id}/resources` | List the session's resource instances in position order. |
| `POST` | `/v1/sessions/{session_id}/resources` | Attach a file or github_repository resource to a session. |
| `GET` | `/v1/sessions/{session_id}/resources/{resource_id}` | Read one resource instance. |
| `PATCH` | `/v1/sessions/{session_id}/resources/{resource_id}` | Rotate a github_repository authorization token. |
| `DELETE` | `/v1/sessions/{session_id}/resources/{resource_id}` | Detach a resource from the session. |

A resource passed in a session's `resources` at creation is recorded as an
instance in the same call, so it appears in the list above immediately and can
be addressed by id; attaching one to an existing session uses the `POST` route.
A `file` or `github_repository` resource is materialized at a canonical absolute
in-sandbox path, so a session whose Environment selects a backend that cannot
serve that path (`docker`, `kubernetes`, `self_hosted`) is refused with `400` and
code `resource_not_mountable` — at creation, and on the `POST` route above — and
nothing is written: no session row, no resource instance, no event. The message
names the backend, the resource type, and the alternative, so the caller does not
have to reproduce a provisioning failure to learn what to change. The backend
decided on is the one the session's Environment names — the same authority
creation uses — so an Environment edited after a sandbox was bound can refuse a
resource that the bound sandbox could serve, and, the other way round, can accept
one that the bound sandbox will refuse at its next provisioning: the decision
follows the Environment, not the sandbox in hand, so the refusal is conservative
only when the Environment is the stricter of the two. Binding a session to a
sandbox and re-reading the Environment on every attachment are both deliberate;
the alternative would be accepting a mount the named backend cannot serve. An
Environment that cannot be resolved at all — a damaged config, or a row
declaring a hosting type this runtime does not know —
is answered with its own `400` and code
(`unsupported_hosting_type`), not a `500`, on this route as on creation.
A `memory_store` resource can only be attached when the session is created,
because memories are part of the context the session was built with; attaching
one later is refused with `400 invalid_request_error`, and a `memory_store`
instance cannot be detached. A github_repository `authorization_token` is
write-only and is never echoed in any response, and rotating it is the only
updatable field: changing the repository, checkout, or mount path requires a new
resource instance.

The runtime also tells the agent where its resources are. A session that declares
at least one `file` or `github_repository` resource carries a `# Session
Resources` section in its system prompt, naming each file's sandbox path and each
repository's URL, checkout, and mount path; on the `local` backend the section
also gives the sandbox-relative spelling a shell command needs, because a local
command resolves an absolute path against the host rather than the sandbox. A
session with no such resource has no section, and a resource's
`authorization_token` never reaches it.

## Skills

Skills are reusable instruction packages. See [Skills](skills.md) for package
format and upload rules.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/skills` | List skills. |
| `POST` | `/v1/skills` | Upload a skill package. |
| `GET` | `/v1/skills/{skill_id}` | Retrieve a skill. |
| `DELETE` | `/v1/skills/{skill_id}` | Delete a custom skill. |

List query parameters:

| Parameter | Purpose |
| --- | --- |
| `limit` | Page size, maximum 100. |
| `page` | Cursor from `next_page`. |
| `source` | `custom` or `anthropic`. |

Upload:

```bash
zip -r code-review-assistant.zip code-review-assistant

curl -X POST http://127.0.0.1:3000/v1/skills \
  -F "files=@code-review-assistant.zip"
```

Skill list responses include `next_page` in addition to the common page fields.

## Environments

Environments describe where sessions run.
Environment names are human-readable labels and do not need to be unique. Use
the returned `env_...` id when creating sessions or updating an environment.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/environments` | List environments. |
| `POST` | `/v1/environments` | Create an environment. |
| `GET` | `/v1/environments/{environment_id}` | Retrieve an environment. |
| `PUT` | `/v1/environments/{environment_id}` | Update an environment. |
| `POST` | `/v1/environments/{environment_id}/archive` | Archive an environment. |
| `GET` | `/v1/environments/{environment_id}/worker-keys` | List self-hosted worker keys without raw secrets. |
| `POST` | `/v1/environments/{environment_id}/worker-keys` | Generate a worker key. The raw key is returned once. |
| `POST` | `/v1/environments/{environment_id}/worker-keys/{key_id}/revoke` | Revoke a worker key. |
| `GET` | `/v1/environments/{environment_id}/work-items` | Inspect recent self-hosted queue items (windowed by `limit`, no continuation) and per-status `counts` for the environment's whole queue. |

Create:

```bash
curl -X POST http://127.0.0.1:3000/v1/environments \
  -H "Content-Type: application/json" \
  -d '{
    "name": "local-dev",
    "description": "Local development environment",
    "config": {
      "type": "cloud",
      "networking": {
        "type": "limited",
        "allow_package_managers": true,
        "allow_mcp_servers": false,
        "allowed_hosts": []
      }
    }
}'
```

An environment's backend is resolved fail-closed, and the resolution is the same
one sessions use:

- `sandbox_provider` names the execution backend and always wins when it is
  present. It is stored exactly as written and validated by the sandbox
  registry, so an unregistered name is refused there by name rather than
  replaced with another backend. A runtime that registers a provider this build
  does not ship can still name it.
- Otherwise the hosting type selects the backend: `local`, `docker`,
  `kubernetes`, and `self_hosted` map to the backend of the same name. `cloud` —
  the published "the platform decides" value — resolves to the workspace's
  configured default backend: the `sandbox.provider` the active Settings V2
  configuration carries, with its backend-specific options (image, Kubernetes
  namespace, timeout) applied.
- Otherwise the environment runs on `local`, the runtime default. An
  environment that declares neither is the only case that resolves to `local`;
  a declaration this runtime cannot serve is never lowered to it.

The published CMA `config` shape is read rather than stored and ignored:

- `config.type` is the published spelling of the local `hosting_type`, and both
  are read as one declaration. A client that sends
  `"config": {"type": "self_hosted"}` gets `hosting_type: "self_hosted"` back
  instead of the local default, and the value selects the backend through the
  resolution above. `null` and `""` mean "not declared" in either spelling; any
  other non-string is refused rather than read as undeclared.
- Two spellings that disagree — `"type": "docker"` beside
  `"hosting_type": "local"` — are refused with `400` and code
  `invalid_environment_config`: one environment cannot run in two places, so the
  runtime refuses instead of picking one. Sending both with the same value is
  accepted. That is about what one request declares: a spelling an *older row*
  already holds is not a caller statement, so an update that names the axis in
  one spelling replaces the stored declaration in the other. A row the previous
  version wrote as `"config": {"type": "cloud"}` can therefore be renamed or
  repaired with `"hosting_type": "local"`, including from the Console, which only
  ever sends that spelling; clearing a spelling with `null` or `""` touches only
  that one.
- `config.networking` is normalized into the recorded local `config.network`
  before it is stored, under the local key names: `allow_mcp_servers` becomes
  `allow_mcp_server_network_access`, and `allow_package_managers` becomes
  `allow_package_manager_network_access`. The published key is consumed rather
  than stored beside its local twin, so a stored environment holds one policy in
  one spelling. The defaults are fail-closed: an unrecognized `type` reads as
  `limited`, and a permission that is absent or not the boolean `true` reads as
  denied. Sending both spellings with different content is refused with
  `invalid_environment_config`. Sending `network: null` — or `networking: null`,
  which is the same policy — clears the recorded policy, including one an older
  row stored in the other spelling; any other value that is
  not an object is refused. A stored policy that is not an object at all is
  refused with a message naming the update that replaces it, so a damaged row is
  repaired by declaring a policy rather than being un-updatable.
- A stored declaration the resolution refuses — two spellings that disagree, or a
  value that is not a name — is reported with a null `effective_sandbox_provider`
  rather than as a backend, so a listing never presents as runnable an
  environment whose sessions are refused.
- `config.packages` is preserved as written. No provider in this runtime
  installs packages, in either the published object shape or the local list
  shape, so a declaration there does not reach a sandbox — the response marks
  this with `packages_enforced: false`. The response's `config.packages` field
  reports the published per-manager object shape; the local array spelling a
  stored config may carry is folded into it.

`hosting_type: "cloud"` — and the published `config: {"type": "cloud"}` — is
accepted and means "the platform decides": sessions on that environment
provision on the workspace's configured default sandbox backend. The record
keeps the `cloud` declaration; the response's `effective_sandbox_provider`
reports which backend it resolves to. An *unrecognized* hosting type is still
refused with `400 invalid_request_error` and code `unsupported_hosting_type`,
and the message names the hosting types this build can serve.

A `config` that is not a JSON object, a stored `config` that is not valid JSON,
a declared `hosting_type` / `type` / `sandbox_provider` that is not a string, or
a `sandbox_provider` that names no shipped backend is refused with code
`invalid_environment_config`; a hosting type this runtime cannot execute is
refused with `unsupported_hosting_type`; an update that does not supply a
replacement `config` cannot be applied over a damaged record.

### Network policy

An environment's network policy is recorded and returned, and **nothing enforces
it**: no sandbox provider shipped in this runtime reads it, so
`{"type": "limited", "allowed_hosts": []}` reaches the same network as
`{"type": "unrestricted"}`. Store the declaration — a provider that can apply it
will read the stored shape — but do not treat it as a sandbox boundary. A
credential vault's own `allowed_hosts` policy is a different thing and *is*
enforced when the credential is injected.

Resolution failures surface at `POST /v1/sessions`, before any session row is
written, and at `POST /v1/sessions/{id}/events`, before any event is appended,
so a session whose environment cannot be resolved never accepts work. The
Environment response keeps the declaration and the execution separate:
`config.type` reports the published hosting axis the caller declared —
`self_hosted`, or `cloud` for every backend this runtime itself serves — while
`effective_sandbox_provider` reports the backend sessions on it actually
provision: `kubernetes` on a Kubernetes environment, the workspace default on a
`cloud` one. An environment whose stored `config` cannot be read resolves to no
backend, so `effective_sandbox_provider` is `null` rather than `local` and
repairing it is a deliberate choice: an update that does not carry a
replacement `config` is refused.

`env_default` is the workspace fallback Environment, so its backend is the
workspace runtime setting (`sandbox.provider`) and its stored `config` is the
legacy seed those settings were derived from; a named Environment decides its own
backend as described above. A stored `cloud` declaration on `env_default` — the
published `config: {"type": "cloud"}` spelling included, which a version before
this one accepted and stored verbatim — asks the workspace default to decide,
so it seeds the same platform default a config that declares nothing does. A
workspace whose `env_default` declares a hosting type this runtime cannot
serve at all still refuses to derive its runtime settings on a workspace that
has no settings row yet, rather than quietly seeding the local backend the
declaration did not ask for. Repair the row with an update that names one
spelling, which replaces the other one rather than disagreeing with it:
`PUT /v1/environments/env_default {"hosting_type": "local"}`.

Worker keys and work queues are advanced self-hosted controls. They are not
needed for the default local runtime.

Generate a self-hosted worker key:

```bash
curl -X POST http://127.0.0.1:3000/v1/environments/ENV_ID/worker-keys \
  -H "Content-Type: application/json" \
  -d '{"name":"fde-laptop"}'
```

Responses include `secret_key` only on creation. Later list/detail responses
return `key_prefix`, status, timestamps, and metadata only.

Run a local worker:

```bash
export MANAGED_AGENTS_ENVIRONMENT_KEY='mawk_...'
managed-agents worker poll \
  --environment-id ENV_ID \
  --workdir /path/to/worker/root
```

Worker polling is scoped by the environment key when supplied. The worker can
execute `exec`, `read`, `write`, and `list` work items inside `--workdir`.

Pass `--once` to claim and run at most one item and exit, which is also what makes
the command usable from a test or a cron job; without it the worker polls until it
is stopped. `--interval-ms` sets the delay between polls when the queue is empty
and `--worker-id` sets the identity reported on both the claim and the completion
(default `worker_<pid>`). The claim is bounded by `--claim-timeout-ms` (default
`10000`), and it is the request whose absence of a bound was least visible: it is
issued once per iteration rather than from a timer, so a claim the runtime never
answered was a silent total stall - no item, no report, no retry, and no message.
A claim that **failed** was worse, because nothing caught it and the error ended the
worker, so a runtime that blinked killed every worker pointed at it. Both are now one
behaviour: an item is run only when the claim produced one, and a claim that produced
none - refused, failed, or never answered, the last as the machine-readable
`work_claim_unconfirmed` naming its bound - is logged and the worker polls again after
`--interval-ms`. One limit is worth stating: a claim whose response was lost may still
have created the row, so that item is stranded until its lease lapses. It is not lost -
its `accepted_at` is still null, so it stays `queued` and the sweep re-hands it, which is
the "unaccepted intent stays reclaimable" rule doing its job. While an item runs the
worker renews its own claim every
`--heartbeat-ms` (default `20000`), because the claim carries a lease window and a
long item would otherwise be reclaimed and handed to a second worker while the first
was still running it. A renewal refused with `work_lease_lost` - the session that
queued the work has ended and stopped it - stops the item instead: the command is
signalled and the item is reported failed with that code, because continuing would be
running work nobody is waiting for, and the renewal is the only way the stop reaches
the process holding the command. Every other renewal failure, including a transport
error and the refusal that means the item belongs to another worker, is only a
suspicion and leaves the item running: a command stopped halfway leaves a half-applied
side effect, and the work is still wanted. Each renewal is bounded by
`--heartbeat-timeout-ms` (default `10000`, half the renewal interval), and here the
bound is worth more than it looks: the renewal is issued from a timer, so a runtime
that accepted the connection and never answered did not park the worker once but
again on **every tick**, and no tick ever reached the warning, because a promise that
never settles never reaches the `catch` that prints one. With the bound the worker
warns with the machine-readable `work_heartbeat_unconfirmed` and the bound it waited,
so "the runtime is not answering my renewals" is readable directly instead of
surfacing late as a claim that quietly lapsed and an item the queue moved to
`unknown`. It deliberately does not change the rule above - a timeout is the same
kind of suspicion as a transport error, so the item **keeps running**, and
`work_lease_lost` remains the only renewal answer that aborts one. Before running an
item the worker asks the
runtime to confirm its claim with `POST /v1/x/worker/accept`, and waits at most
`--ack-timeout-ms` (default `10000`) for the answer. A refusal means the item is not
run and not reported; so does an answer that never arrives, because an unconfirmed
claim is one the worker cannot prove it still holds. The two are reported
differently on purpose - a refusal names the status the runtime returned, while an
expired bound fails with the machine-readable `work_accept_unconfirmed` and the
bound it waited - since a runtime that refused and a runtime that went quiet need
different diagnoses. In both cases the worker warns, runs nothing, reports nothing,
and keeps polling. An unusable `--port`, `--interval-ms`, `--claim-timeout-ms`,
`--heartbeat-ms`,
`--heartbeat-timeout-ms`, `--complete-timeout-ms` or
`--ack-timeout-ms` stops the worker at startup with a message naming the option: an
unparseable interval would otherwise become a poll loop with no delay at all.

Reporting an outcome is a separate step from producing one, and the worker treats
them as separate facts. A completion the runtime refuses - `409` once the lease has
lapsed and the item has moved to `unknown`, or a `5xx` - is a failure to **deliver**
the outcome, not a failure of the work, so the item is never re-run and never
re-reported as failed. The worker warns with the machine-readable
`work_completion_undelivered` and the status it was refused with, or, when no answer
arrived at all, that the request did not reach the runtime, and then keeps polling.
The completion is bounded by `--complete-timeout-ms` (default `10000`), and a bound
that expires is reported as its **own** code, `work_completion_unconfirmed`, because
"did not reach the runtime" is true for a refused connection and false for a timeout:
a request that timed out may have arrived and been applied, so the row may already say
`applied` while only this worker does not know. That warning says the outcome may
already have been recorded, which is the fact that decides whether anyone should look
at the row. The completion is never sent twice either way, because the first request
may already have taken effect and the queue refuses a late write to an item it has
moved on. While a completion hangs the item keeps its lease, but the worker stops
polling until the bound expires, so one unanswered completion stops every later item
from being claimed.
The queue already holds the truth: an item whose outcome was not delivered keeps its
lease and becomes `unknown` when the lease lapses, which is the record that says the
outcome may have happened and must not be replayed. A command that genuinely failed is
still reported failed with its own error, and that report is delivered through the
same step - so a refusal to deliver it leaves the item unrecorded rather than turning
the worker's inability to report into a claim about the work.

The server waits on a work item with a bound of its own, and when that bound passes
the failure carries a code rather than only a message, because the ways it can end
call for opposite responses. `work_queue_timeout` means no worker ever claimed the
item, so nothing has run and submitting the intent again is safe.
`work_outcome_unknown` means a worker claimed it and no result came back, so the
effect may already have happened on the operator's machine and a blind replay can
duplicate it. That answer stays conservative even for a claimed item whose executor
never accepted it, where it is knowable that nothing ran: an unaccepted claim stays
reclaimable once its lease expires, so the queue re-offers that item to the next
worker and executes it rather than losing it, and a caller told to resubmit would
run alongside the copy the queue is about to hand out. Giving up on such an item is
recorded on the row, which distinguishes an attempt abandoned before starting from
one that died mid-command, but the record refuses nothing - the queue still re-offers
the work.

Acceptance is the line between those two answers, and the queue treats the two sides
differently rather than reporting them differently. An item whose lease lapses
**without** an accepted ack is handed to the next worker, because nothing ran. An item
whose lease lapses **after** the holder accepted it is never handed out again: the
holder committed to running it, so the effect may already have happened, and
re-offering it would duplicate that effect on the operator's machine. Such an item
moves to status `unknown`, which is the queue's own record that a start happened and
its outcome is not known - it is not claimable, and a late completion from the old
holder is refused rather than accepted, because the queue cannot un-record that the
outcome was uncertain. `unknown` is a terminal status here and a handoff rather than a
resolution: deciding whether an effect may be retried depends on the tool, so this
layer records the uncertainty instead of guessing at it. A live holder is unaffected,
since renewing its claim keeps its item out of the window.

`work_lease_lost` means the session ended and stopped the
work, so no result is wanted at all. A stop is reported ahead of the item's state,
because an item the session stopped while nobody held it is still `queued`, and reporting that
as "submit it again" would send work back to a session that has ended. A result
reported before the deadline still resolves the wait, stopped work included: the
marker says the result is not wanted, not that the effect did not happen.

#### Work-item status

An item is in exactly one of five states, and the chain is about **commitment** rather
than about who is holding the row. That distinction is the reason the vocabulary is
worded this way: a status column cannot be read correctly if the same word has to mean
both "somebody took it" and "the effect may already have happened".

```
                 claim (lease only)          accept
   [enqueue] ──────────┐                        │
       │               ▼                        ▼
       └──────────► queued ─────────────────► accepted ─────────► applied
                      ▲  │                      │  │
      reclaim after   │  │ wait gives up        │  │ complete(failed)
      lease lapses    │  │ (nothing ran)        │  ▼
      (nothing ran)   └──┘                      │ failed
                                               │ lease lapses
                                               ▼
                                            unknown
```

| Status | Means | Claimable again? |
| --- | --- | --- |
| `queued` | Nobody has committed to running it. Covers both an item nobody has touched and one a worker holds a lease on but has not accepted. | Yes - immediately if never claimed, otherwise once the lease lapses. |
| `accepted` | A worker confirmed the claim and committed to running it, so the effect may already have happened. | No. If the lease lapses the item becomes `unknown` instead. |
| `applied` | The effect happened. | No - terminal. |
| `failed` | It was attempted and did not succeed. | No - terminal. |
| `unknown` | It was accepted and the outcome is not known either way. | No - terminal, and never replayed. |

The transitions, stated so they can be checked against the code:

- **enqueue** creates `queued`;
- **claim** takes a lease and leaves the row `queued` - taking a lease is not a change of
  commitment, so nothing about the status moves;
- **accept** is the only transition into `accepted`, and it re-checks the lease window at
  that moment, so a claim whose window passed in the gap between claiming and starting is
  refused rather than accepted;
- **complete** moves `queued` or `accepted` to `applied`, or to `failed` when the result is
  a failure;
- a **stop** records `stopped_at` and does not move the status: it is a decision about the
  work, not a statement about the effect;
- the only transition into `unknown` is an accepted item whose lease lapsed without a
  result;
- `queued` is the only status a claim can take, so `accepted` is never handed to a second
  worker.

Workspaces created before this vocabulary was fixed are renamed once, on migration: the
old `pending` and unaccepted `claimed` both become `queued`, an accepted `claimed`
becomes `accepted`, and `done` becomes `applied`. `failed` and `unknown` keep their names.
The old words are never written again.

### Self-hosted worker keys

A self-hosted environment's worker keys are issued, listed, and revoked over the
API:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/environments/{id}/worker-keys` | Issue a key. Returns `secret_key` exactly once. |
| `GET` | `/v1/environments/{id}/worker-keys` | List keys with `key_prefix`, status, and last-seen metadata. |
| `POST` | `/v1/environments/{id}/worker-keys/{key_id}/revoke` | Revoke a key. |

Only the SHA-256 hash of a key is stored, so `secret_key` is present in the
creation response and can never be read back; list and revoke responses carry
`key_prefix` instead. A create body accepts `name` (required, at most 80
characters), an optional `expires_at` ISO 8601 timestamp, and optional `metadata`.

A claim on `POST /v1/x/worker/claim` may present the key as `environment_key`,
which scopes the worker to that environment for both the claim filter and the
key's expiry and revocation rules. A claim naming a different environment than the
key's scope is refused, and a claim presenting a revoked, expired, or unknown key
is refused before any work item changes hands. A claim without a key is unscoped,
which is what a runtime that has not issued any worker keys expects.

## Credential Vaults

Credential vaults group secrets that sessions can attach by id.
Vault names are human-readable labels and do not need to be unique. Use the
returned `vlt_...` id when attaching a vault to a session.

Every route below is served under **two** prefixes: `/v1/vaults*`, which is the
path the published contract addresses vaults at, and `/v1/credential-vaults*`,
which is this runtime's own spelling and the one the Console and the TypeScript
SDK use. They are the same routes and the same rows — one router mounted twice,
so the two cannot drift apart — and the local spelling is neither deprecated nor
redirected. The published prefix requires the same `anthropic-beta` as the local
one.

Listing vaults excludes archived ones by default and takes the published
`include_archived` parameter: `?include_archived=true` returns archived vaults
too, each with `status: "archived"` and a non-null `archived_at`, while
`include_archived=false` means the same as omitting it. Any other value — `1`,
`yes`, an empty string — is a `400`, and so is sending the parameter twice with
contradictory values, rather than a silent fall-back to the default. Including an
archived vault in a listing does not make it retrievable on its own:
`GET /v1/vaults/{vault_id}` still answers `404` for an archived vault and
archiving remains terminal.

Listing vaults is paginated: `limit` defaults to 20 and may not exceed 100, and
the response's `prev_page`/`next_page` are the cursors to pass back as `page`.
Newest first, with the ordering and the `include_archived` view recorded in the
cursor — replaying one under the other view, or against the memory-store listing,
is a `400` rather than an answer to a page that never existed for that query. A
`limit` that is not an integer in `1..100`, or that is sent more than once, is a
`400` naming the accepted range instead of falling back to the default. A query
parameter the listing does not implement is also a `400`, naming it and naming the
parameters the route does accept: `include_archived`, `limit`, `page`. The same three
are accepted on `GET /v1/memory_stores`, and `beta` is accepted everywhere without
being advertised.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/vaults`, `/v1/credential-vaults` | List vaults. Archived vaults are excluded unless `?include_archived=true`. |
| `POST` | `/v1/vaults`, `/v1/credential-vaults` | Create a vault. |
| `GET` | `/v1/vaults/{vault_id}`, `/v1/credential-vaults/{vault_id}` | Retrieve a vault. |
| `POST` | `/v1/vaults/{vault_id}/archive`, `/v1/credential-vaults/{vault_id}/archive` | Archive a vault. |
| `GET` | `/v1/vaults/{vault_id}/credentials`, `/v1/credential-vaults/{vault_id}/credentials` | List credentials. |
| `POST` | `/v1/vaults/{vault_id}/credentials`, `/v1/credential-vaults/{vault_id}/credentials` | Add a credential. |
| `POST` | `/v1/vaults/{vault_id}/credentials/{credential_id}/rotate`, `/v1/credential-vaults/{vault_id}/credentials/{credential_id}/rotate` | Replace the encrypted secret value. |
| `POST` | `/v1/vaults/{vault_id}/credentials/{credential_id}/mark-used`, `/v1/credential-vaults/{vault_id}/credentials/{credential_id}/mark-used` | Mark a credential as used and append an audit event. |
| `GET` | `/v1/vaults/{vault_id}/credentials/{credential_id}/audit`, `/v1/credential-vaults/{vault_id}/credentials/{credential_id}/audit` | List credential audit events. |
| `GET` | `/v1/vaults/{vault_id}/audit`, `/v1/credential-vaults/{vault_id}/audit` | List every credential audit event in a vault. |
| `POST` | `/v1/vaults/{vault_id}/credentials/{credential_id}/archive`, `/v1/credential-vaults/{vault_id}/credentials/{credential_id}/archive` | Archive a credential. |
| `DELETE` | `/v1/vaults/{vault_id}/credentials/{credential_id}`, `/v1/credential-vaults/{vault_id}/credentials/{credential_id}` | Delete a credential. |

Credential `auth_type` values:

- `mcp_oauth`
- `bearer_token`
- `environment_variable`

The canonical spelling nests the type under `auth` — `mcp_oauth`, `static_bearer`
(the local name for `bearer_token`) and `environment_variable` — with
`display_name` as a top-level sibling of `auth`.

Add a credential:

```bash
curl -X POST http://127.0.0.1:3000/v1/credential-vaults/VAULT_ID/credentials \
  -H "Content-Type: application/json" \
  -d '{
    "name": "github-token",
    "auth_type": "environment_variable",
    "variable_name": "GITHUB_TOKEN",
    "value": "ghp_example",
    "network": {
      "type": "limited",
      "allowed_hosts": ["api.github.com"]
    },
    "injection_locations": ["request_headers"]
  }'
```

Secret values are encrypted at rest. Responses return `value_hint`, not the raw
secret.

The same credential in the canonical nested shape, which is what a read projects:

```bash
curl -X POST http://127.0.0.1:3000/v1/credential-vaults/VAULT_ID/credentials \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "Deploy key",
    "auth": {
      "type": "environment_variable",
      "secret_name": "DEPLOY_KEY",
      "secret_value": "ghp_example",
      "injection_location": { "header": true, "body": false }
    }
  }'
```

`static_bearer` and `mcp_oauth` are keyed by `mcp_server_url` and carry `token` and
`access_token` respectively; an `mcp_oauth` create may also send a `refresh` block,
and the response then carries a `warnings` entry saying the refresh is not
executed, because this runtime holds no OAuth refresh loop. Omitting
`injection_location` enables both positions, supplying the object fills omitted
fields with `false`, and the response always resolves both. A payload supplying
both `auth` and a flat field is refused rather than merged, so a flat field can
never silently override a nested one. The flat spelling above stays accepted as a
legacy alias, and a read projects the canonical `auth` object either way, beside
the local fields existing callers already read.

Rotate a credential:

```bash
curl -X POST http://127.0.0.1:3000/v1/credential-vaults/VAULT_ID/credentials/CREDENTIAL_ID/rotate \
  -H "Content-Type: application/json" \
  -d '{
    "value": "new-secret-value",
    "actor": "operator",
    "metadata": { "reason": "scheduled rotation" }
  }'
```

A rotation also asks every live session that references the vault to close and
reconnect its MCP transports, so a tool call after the rotation presents the new
value rather than the one the transport was connected with. A reconnect failure is
reported to the caller instead of rolling the rotation back, and
`GET /v1/x/mcp/status?session_id=...` shows a server that did not come back.

Runtime code can use the internal `resolveSessionCredentialInjections` helper to
resolve scoped credentials for a session. For a `limited` credential, the caller
must provide a target host and the host must match `allowed_hosts` before the
secret is decrypted. Exact hosts, `*.example.com` subdomains, and optional
ports are supported; a bare `*` does not mean unrestricted. Missing or malformed
policy, an empty allow-list, or an unverified target is denied. Denial happens
before decryption, produces only non-secret `runtime_denied` audit metadata, and
does not update `last_used_at`. Explicit `unrestricted` is the only policy that
can inject without a target host. The helper is an injection-boundary contract,
and the runtime's own turn path is a caller of it: `src/index.ts` builds a
resolver from it and hands that to the executor, which uses the no-host form for a
shell command and for a stdio MCP server, because neither names a host. A
url-transport MCP server is the host-scoped form: the declared URL is passed as the
target host and as the `mcp_server_url` the credential has to be keyed by, so a
`static_bearer` credential authenticates the endpoint it names and no other, and one
keyed elsewhere is inapplicable to the call rather than refused for it. Web tools and
custom tools still name no host, so universal enforcement cannot be claimed for them.
A stdio MCP server is a caller of the no-host form: the session's `unrestricted`
environment variables are passed to its process and an MCP tool's return value is
scrubbed, while a `limited` credential is denied for it the same way it is denied
for a shell command.

### Memory limits, scope, and preconditions

Memory writes and lists are bounded by the published rules, enforced on the routes
that own them:

| Rule | Limit | Behaviour |
| --- | --- | --- |
| Content size | 100 kB | Measured in bytes, so multi-byte content is measured in bytes and not in characters. |
| Per-store capacity | 10,000 memories | A write that would exceed the cap is refused; existing memories stay readable and editable. |
| Instructions length | 4,096 characters | The session-level `instructions` field on an attached store. An absent field is not capped. |

`GET /v1/memory_stores/{id}/memories` accepts `path_prefix` and `depth`.
`path_prefix` must be an absolute path ending in `/`. `depth` must be `0` or `1`,
where `0` lists the whole subtree and `1` lists only direct children. Prefix
matching is segment-based, so a sibling directory that merely shares a string
prefix is not selected.

A write may carry a precondition:

```json
{
  "precondition": {
    "type": "content_sha256",
    "content_sha256": "<hash of the content the caller last read>"
  }
}
```

The write is refused with `409 conflict` and code `precondition_failed` when the
stored content no longer matches, and the refusal carries
`current_content_sha256` so a caller can retry without a separate re-read. An
unknown precondition type, and a precondition with no hash, are each refused with
code `invalid_precondition` rather than treated as a no-op.

## Memory Stores

Memory stores persist named memory entries that can be mounted into sessions.
Memory store names are human-readable labels and do not need to be unique.

Listing stores excludes archived ones by default and takes the published
`include_archived` parameter: `?include_archived=true` returns archived stores
too, each with `status: "archived"` and a non-null `archived_at`, while
`include_archived=false` means the same as omitting it. Any other value — `1`,
`yes`, an empty string — is a `400`, and so is sending the parameter twice with
contradictory values, rather than a silent fall-back to the default. This is the
same parameter, and the same reading of it, as the vault listing. Including an
archived store in a listing does not make it retrievable on its own:
`GET /v1/memory_stores/{store_id}` still answers `404` for an archived store and
archiving remains terminal.

Listing stores is paginated under the same rule as the vault listing: `limit`
defaults to 20 and may not exceed 100, `prev_page`/`next_page` are the cursors to
pass back as `page`, and a cursor issued for another view or another collection is
refused rather than followed. An unimplemented query parameter is a `400` naming it
and naming the accepted three, exactly as on the vault listing.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/memory_stores` | List memory stores. Archived stores are excluded unless `?include_archived=true`. |
| `POST` | `/v1/memory_stores` | Create a memory store. |
| `GET` | `/v1/memory_stores/{store_id}` | Retrieve a memory store. |
| `POST` | `/v1/memory_stores/{store_id}/archive` | Archive a memory store. |
| `GET` | `/v1/memory_stores/{store_id}/memories` | List memories. |
| `POST` | `/v1/memory_stores/{store_id}/memories` | Add a memory. |
| `PUT` | `/v1/memory_stores/{store_id}/memories/{memory_id}` | Update a memory. |
| `DELETE` | `/v1/memory_stores/{store_id}/memories/{memory_id}` | Delete a memory. |

Create a memory:

```bash
curl -X POST http://127.0.0.1:3000/v1/memory_stores/STORE_ID/memories \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/notes/release",
    "content": "Keep release notes concise."
  }'
```

Memory paths must start with `/` and must not end with `/`.

## Operations

Operations APIs persist local control-plane definitions for callbacks,
scheduled runs, and run-quality checks. The current runtime stores these
resources, exposes them through the API, and includes manual validation actions
for webhook test delivery, scheduled run-now, and deterministic outcome
evaluation. A background worker delivers webhook events and runs cron
schedules, so an unwatched runtime still delivers.

The event names the runtime raises are the session event types plus
`deployment.created`, `deployment.paused`, `deployment.unpaused`,
`deployment.updated`, `deployment.archived`, `deployment_run.started`,
`deployment_run.succeeded`, and `deployment_run.failed`. The rest of
the published event table — `agent.*`, `environment.*`, `vault.*`,
`vault_credential.*`, and `deployment.deleted` — is
accepted in a subscription and never produced, so a receiver cannot distinguish
an unimplemented event from a quiet one.

A **timed** run publishes `deployment_run.started` and then exactly one of
`deployment_run.succeeded` / `deployment_run.failed`; all three name the same run,
by `data.id`, which is what `GET /v1/deployment_runs/{id}` accepts. A manual run
publishes none of them, and that is a rule about the kind of run rather than about
the `trigger_type` a caller sends: a manual run that passes
`trigger_type: "scheduled"` still reports nothing. `started` arrives once the run
has been recorded rather than at the instant it begins, so a receiver that fetches
the run it names finds it.

Archiving a deployment publishes `deployment.archived` once the row is archived,
so a receiver that resolves the reference sees `archived_at` set. A repeat archive
publishes nothing and answers `404` rather than succeeding quietly, which is how
this runtime expresses the published no-op rule; archiving a webhook or an outcome
publishes nothing, because no archived event exists for those resources.

Creating a deployment publishes `deployment.created` once the row exists, so a
receiver that resolves the reference finds it; a create refused for a missing
name, a missing agent, a bad schedule, or an unknown time zone publishes nothing,
because there is no id to name. A deployment created already paused publishes that
event alone — a resource coming into existence paused has not moved from anything,
so there is no transition for `deployment.paused` to report.

Updating a deployment publishes `deployment.updated` when the call changes at
least one field, and nothing when it changes none — the stored `payload` and
`metadata` are compared structurally, so re-sending the same content with its keys
in a different order is not a change. The pause state is excluded from that event
and reported by `deployment.paused` / `deployment.unpaused` instead, so a call
that changes both publishes one event per change.

Pausing a deployment publishes `deployment.paused` and resuming publishes
`deployment.unpaused`, each carrying `data: {type: 'deployment', id}`: a
reference rather than the object, so a receiver fetches the current state
itself. The pause state has three doors — `POST /{id}/pause`,
`POST /{id}/unpause`, and the `status` field of `PUT /{id}` — and the event
follows the state change rather than the route, so a pause performed by updating
a deployment is published exactly like one performed by pausing it. Nothing is
published when the call changes nothing, which matters because all three doors
are idempotent and a repeat is the ordinary retry path. A subscription that
cannot be reached does not fail the call — the state change is already committed
and the failed attempt is recorded for the retry sweep.

### Webhooks
Every delivery attempt carries the Standard Webhooks v1 headers:

```text
webhook-id: <delivery id>
webhook-timestamp: <unix seconds>
webhook-signature: v1,<base64 hmac over "<id>.<timestamp>.<body>">
```

The signature covers the id, the timestamp, and the exact request body, so a
receiver can detect a replayed or altered delivery rather than only a forged one.
Verification is constant-time, and the signature header may carry several
space-separated signatures — that is how the spec expresses a rotation window, so
an operator can roll a secret without dropping in-flight deliveries.

`POST /v1/webhooks` mints one signing secret per subscription and returns it
exactly once as `secret_key`; no read path returns it afterwards. The signing key
is derived from that secret: a `whsec_`-prefixed value is base64-decoded to its
key bytes, and an unprefixed value is used as raw UTF-8, so a subscription written
before per-endpoint secrets existed keeps producing valid signatures with the
runtime's own value.

`POST /v1/webhooks/{webhook_id}/rotate-secret` mints a new secret and returns it
once. While the window it opens is open, every delivery carries both signatures in
`webhook-signature`, newest first, so a receiver can install the new value and keep
verifying with the old one until every deployment has moved;
`POST /v1/webhooks/{webhook_id}/retire-secret` closes the window and leaves only
the current secret signing. Nothing closes it automatically, because only the
operator knows when the last receiver has moved. A second rotation replaces the
window rather than adding to it.

The legacy `X-Managed-Agents-Signature` header is still sent, so an existing
receiver keeps working. A retry keeps the same `webhook-id` and signs with its own
`webhook-timestamp`, so the published header set is continuous across attempts and
a receiver can deduplicate on the id.

An endpoint is automatically disabled — `status: "disabled"` with a
machine-readable `disabled_reason` — when a delivery observes a `3xx` (never
followed), when address screening refuses the connection, or when deliveries have
failed without interruption for the sustained-failure window. That window's length
is a local parameter rather than a published one: the contract states the trigger's
shape (a duration, reset by a single `2xx`) and not its length. It defaults to ten
minutes, and a deployment sets its own in whole seconds with
`MANAGED_AGENTS_WEBHOOK_SUSTAINED_FAILURE_WINDOW_SECONDS` (`1` to `2592000`;
anything else is refused rather than clamped, because a window of zero would
disable an endpoint on its first failure). The runtime records the window it
resolved at startup as a `webhook_disable_window` log line carrying the value and
whether it came from the deployment, from the default, or was refused — a
deployment variable has no write path of its own, so that record is its change
trail. Disabling is reversible through `PUT /v1/webhooks/{webhook_id}`, and events
published while an endpoint is disabled are not replayed.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/webhooks` | List webhook subscriptions. |
| `POST` | `/v1/webhooks` | Create a webhook subscription and mint its signing secret, returned once. |
| `GET` | `/v1/webhooks/{webhook_id}` | Retrieve a webhook subscription. |
| `PUT` | `/v1/webhooks/{webhook_id}` | Update a webhook subscription. |
| `POST` | `/v1/webhooks/{webhook_id}/archive` | Archive a webhook subscription. |
| `GET` | `/v1/webhooks/{webhook_id}/deliveries` | List webhook delivery records. |
| `POST` | `/v1/webhooks/{webhook_id}/test` | Record a signed test delivery without requiring an external network call. |
| `POST` | `/v1/webhooks/{webhook_id}/rotate-secret` | Mint a new signing secret and keep the previous one valid until it is retired. |
| `POST` | `/v1/webhooks/{webhook_id}/retire-secret` | Close the rotation window: only the current secret is accepted afterwards. |
| `POST` | `/v1/webhooks/dispatch` | Dispatch an event to matching active webhooks. |
| `POST` | `/v1/webhooks/retry-due` | Retry failed deliveries whose retry time has arrived. |

```bash
curl -X POST http://127.0.0.1:3000/v1/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Session events",
    "url": "https://example.com/managed-agents/webhook",
    "events": ["session.status_running", "session.status_terminated"]
  }'
```

Delivery responses include a `signature` field using the `sha256=...` format.
Failed dispatches are stored as `pending_retry` until their next retry time or
as `failed` after the maximum attempts.

### Scheduled Deployments
A schedule's cron expression is evaluated in the deployment's own timezone, not in
UTC. `0 9 * * *` with `timezone: "Asia/Tokyo"` fires at 09:00 Tokyo time, which is
a different instant from 09:00 UTC, and the difference moves across the year
because a zone that observes DST shifts by an hour while one that does not does
not.

Wall-clock arithmetic handles the two cases a naive conversion gets wrong: a
**spring-forward gap**, where the requested wall time does not exist in the zone,
yields no run rather than a silently shifted one, and a **fall-back overlap**,
where the same wall time occurs twice, resolves to one deterministic instant.

An unknown IANA zone name is refused rather than defaulted to UTC. `next_run_at`
is stored as an absolute instant, so a runtime that was down when a schedule came
due still computes the next occurrence from the persisted value rather than from
when it happened to restart.

The cadence is read from either the flat `cron` and `timezone` fields or the
canonical `schedule: { "type": "cron", "expression": ..., "timezone": ... }`
object; both resolve to one expression and one zone, so a canonical client and a
local one cannot disagree about what a deployment's cadence is. Both fields are
echoed on every deployment response, and an update that changes the cadence
re-arms `next_run_at` in the resolved zone unless the update supplies its own.

Every route below is served under **two** prefixes: `/v1/deployments*`, which is
the path the published contract addresses a deployment at, and
`/v1/scheduled-deployments*`, which is this runtime's own spelling and the one the
Console and the TypeScript SDK use. They are the same routes and the same rows —
one router mounted twice, so the two cannot drift apart — and the local spelling
is neither deprecated nor redirected.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/deployments`, `/v1/scheduled-deployments` | List scheduled deployment plans. |
| `POST` | `/v1/deployments`, `/v1/scheduled-deployments` | Create a scheduled deployment plan. |
| `GET` | `/v1/deployments/{schedule_id}`, `/v1/scheduled-deployments/{schedule_id}` | Retrieve a scheduled deployment plan. |
| `PUT` | `/v1/deployments/{schedule_id}`, `/v1/scheduled-deployments/{schedule_id}` | Update a scheduled deployment plan. |
| `POST` | `/v1/deployments/{schedule_id}/pause`, `/v1/scheduled-deployments/{schedule_id}/pause` | Stop the schedule from producing timed runs. Recorded as `paused_reason: {"type": "manual"}`. |
| `POST` | `/v1/deployments/{schedule_id}/unpause`, `/v1/scheduled-deployments/{schedule_id}/unpause` | Resume the schedule from the next scheduled instant, clearing `paused_reason`. |
| `POST` | `/v1/deployments/{schedule_id}/archive`, `/v1/scheduled-deployments/{schedule_id}/archive` | Archive a scheduled deployment plan. |
| `GET` | `/v1/deployments/{schedule_id}/runs`, `/v1/scheduled-deployments/{schedule_id}/runs` | List schedule run records. |
| `POST` | `/v1/deployments/{schedule_id}/run`, `/v1/scheduled-deployments/{schedule_id}/run` | Manually trigger a schedule and create a session. A paused schedule still runs by hand. |
| `POST` | `/v1/deployments/run-due`, `/v1/scheduled-deployments/run-due` | Run all active schedules whose `next_run_at` is due. |

Pausing suppresses the timed path only. A paused deployment keeps its sessions
running, still accepts a manual `run`, and reads `paused_reason` as
`{"type": "manual"}` so an operator can tell an intentional pause apart from a
deployment that was never paused. Resuming does **not** catch up the trigger
instants that elapsed while it was paused: the schedule picks up at the next
instant, so a deployment paused over a weekend does not fire every missed run at
once. An archived deployment is a 404 on every route, including `run` — pause and
archive are different states and only one of them is reversible.

### Deployment runs

Each attempt to trigger a deployment — timed or manual — records a deployment run.
Runs are their own resource, addressable at the top level, because the published
`deployment_run` event carries a run id and a caller needs a route that resolves
it.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/deployment_runs` | List runs, newest first. `?deployment_id=` narrows to one deployment and `?has_error=true\|false` to failed or successful ones. |
| `GET` | `/v1/deployment_runs/{deployment_run_id}` | Retrieve one run. |

```bash
curl "http://127.0.0.1:3000/v1/deployment_runs?deployment_id=$DEPLOYMENT_ID&has_error=true"
curl "http://127.0.0.1:3000/v1/deployment_runs/$RUN_ID"
```

A run carries the published field names: `deployment_id`, `trigger_context`,
`session_id`, `error` as `{type, message}`, `agent` as `{type, id, version}`, and
`created_at`. Three of those are projections of local storage rather than stored
fields, and each is partial:

- `error.type` is the local `deployment_run_failed`. The published vocabulary
  names causes (`environment_archived_error`, `agent_archived_error`,
  `session_rate_limited_error`) and this runtime does not classify a failure —
  session creation throws a free-text message — so the shape is honoured and the
  cause is not invented.
- `trigger_context.scheduled_at` is absent. The runtime records when a run
  *started*, not the instant its trigger was *due*, and does not persist the due
  instant on the run row.
- `agent` comes from the session the run created, so it is the agent that ran and
  the version it ran as. A run that failed before a session existed reports
  `version: null` and the deployment's current `agent_id`.

`has_error` with any value other than `true` or `false` is refused rather than
ignored, so a filtered question is never answered with an unfiltered list. The
same routes also answer under `/v1/x/deployment_runs` with the older
`has_more`-style envelope, and the nested
`GET /v1/deployments/{id}/runs` keeps its original field names for existing
consumers.

```bash
curl -X POST http://127.0.0.1:3000/v1/scheduled-deployments \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Morning smoke",
    "agent_id": "agent_...",
    "environment_id": "env_...",
    "cron": "0 9 * * 1",
    "timezone": "Asia/Tokyo",
    "payload": {
      "title": "Daily FDE smoke"
    }
  }'
```

Manual and due runs create a session with schedule metadata and store a
`scheduled_deployment_run` record. A cadence is a standard five-field cron
expression using `*`, comma lists, ranges, and step values, and it is evaluated in
the deployment's `timezone`.

### Outcomes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/outcomes` | List outcome definitions. |
| `POST` | `/v1/outcomes` | Create an outcome definition. |
| `GET` | `/v1/outcomes/{outcome_id}` | Retrieve an outcome definition. |
| `PUT` | `/v1/outcomes/{outcome_id}` | Update an outcome definition. |
| `POST` | `/v1/outcomes/{outcome_id}/archive` | Archive an outcome definition. |
| `GET` | `/v1/sessions/{session_id}/outcomes` | List recorded session outcome evaluations. |
| `POST` | `/v1/sessions/{session_id}/outcomes` | Record a session outcome evaluation. |
| `POST` | `/v1/sessions/{session_id}/outcomes/evaluate` | Run the built-in deterministic transcript evaluator for an outcome. |

```bash
curl -X POST http://127.0.0.1:3000/v1/outcomes \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Release readiness",
    "objective": "The agent should produce a concise release-readiness summary.",
    "criteria": ["Mentions tests", "Mentions risks"]
  }'
```

Outcome definitions accept `pass_threshold` from `0` to `1`. The local
deterministic evaluator records `passed` when the transcript score meets the
threshold, `inconclusive` for partial matches below the threshold, and `failed`
when no criteria match.

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions/SESSION_ID/outcomes \
  -H "Content-Type: application/json" \
  -d '{
    "outcome_id": "out_...",
    "status": "passed",
    "score": 0.92,
    "summary": "The run met release-readiness criteria."
  }'
```

The built-in evaluator is deterministic and local: it compares outcome criteria
against persisted session event text, records a score, and stores the result in
`session_outcomes`.

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions/SESSION_ID/outcomes/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "outcome_id": "out_..."
  }'
```

## Runtime Extension Endpoints

Extension endpoints expose local runtime operations.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/x/health` | Health check. |
| `GET` | `/v1/x/runtime` | Runtime status. |
| `GET` | `/v1/x/capabilities` | Truthful inventory of locally executable built-in capabilities, plus the CMA contract matrix. |
| `GET` | `/v1/x/workspace` | Workspace paths and metadata. |
| `GET` | `/v1/x/settings` | Read the versioned Settings V2 runtime document. |
| `POST` | `/v1/x/settings/validate` | Validate a complete Settings V2 document without saving. |
| `POST` | `/v1/x/settings/test` | Test one settings area without saving. |
| `PUT` | `/v1/x/settings` | Save a validated Settings V2 document. |
| `GET` | `/v1/x/templates` | Built-in agent templates. |
| `POST` | `/v1/x/reload` | Reload file-backed agents. |
| `POST` | `/v1/x/restart` | Restart the local runtime process when the server was started through the CLI. |
| `GET` | `/v1/x/logs?limit=200&level=info&q=term` | Recent in-process structured runtime logs. |
| `GET` | `/v1/x/metrics` | Prometheus metrics, when enabled. |
| `GET` | `/v1/x/metrics/summary` | JSON runtime summary for Dashboard monitoring and SDK helpers. |
| `GET` | `/v1/x/mcp/status?session_id=...` | MCP connection status for a session. |
| `POST` | `/v1/x/worker/accept` | Self-hosted sandbox worker confirms, immediately before running an item, that its claim is still held, the work is not stopped, and the lease is still live. A claim is a lease on running an item rather than ownership of it, and the window can pass between claiming and starting - the worker returns from the claim, resolves its workdir, and may be a process that was paused or descheduled - so an item whose window passed is claimable and would run on two machines. The lease condition is deliberately stricter here than on `/v1/x/worker/heartbeat`: a renewal concerns an item already in flight whose effect cannot be un-run, while an acceptance authorizes starting one, and a lapsed claim is reclaimable at any instant. A refusal answers `409` with `work_lease_lost` for both a stopped item and a lapsed lease - the instruction to the worker is the same, do not run it, and the message says which - or `409` without a code when another worker holds the item, which means the work is alive for its holder. `404` for an unknown id. Re-accepting is idempotent for the holder. A refusal is never a completion: the worker must not run the item and must not report a result, which would assert an effect that never happened. |
| `POST` | `/v1/x/worker/claim` | Self-hosted sandbox worker claims pending tool-execution work. The claim carries a lease window; a claim older than the window is treated as abandoned and may be claimed again. Work whose session has ended is never handed out, and that exclusion is read from the session's own status rather than only from the stop marker on the row: the marker is written when a session releases its sandbox, which a terminal session is allowed to skip, so the claim predicate asks the session directly. An item enqueued after the session reached a terminal status is recorded as stopped rather than inserted as claimable, in the same statement as the insert. Work for a session id with no row, and for one that is merely not running and therefore still resumable, stays claimable. |
| `POST` | `/v1/x/worker/heartbeat` | Self-hosted sandbox worker renews the lease on work it still holds, so an item that outlives the window is not handed to another worker while it is still running. A renewal from a worker that does not hold the item is refused with `409`. A renewal on work whose session has ended is refused with `409` and the engine-neutral code `work_lease_lost`, which tells a worker that is already executing the item to stop: the stop marker is persisted server-side, and this response is the only channel through which the process running the command learns of it. |
| `POST` | `/v1/x/worker/complete` | Self-hosted sandbox worker reports completed or failed work. A completion from a worker that does not hold the claim is refused with `409`, and an unknown item answers `404`. |
| `POST` | `/v1/x/sessions/{session_id}/handoff-bundle` | Export a session as a replayable handoff bundle. |
| `GET` | `/v1/x/handoff-bundles?session_id=...&limit=...` | List stored handoff bundles, newest first. |
| `GET` | `/v1/x/handoff-bundles/{bundle_id}` | Retrieve one stored bundle payload (immutable). |

### Handoff bundles

A handoff bundle is the "hand this session to a person or team" export: the recorded evidence of one session, packaged so a recipient can inspect and replay it without access to this runtime. Three open standards carry the packaging so a recipient can verify it with off-the-shelf tooling: RO-Crate 1.1 (`ro_crate`) describes what is in the package, BagIt (`bagit`, RFC 8493) provides sha512 integrity manifests for every part plus a self-digest of the manifest itself, and an in-toto statement in a DSSE envelope (`attestation`) signs the parts with an Ed25519 key derived from the runtime secret key material. That signature proves the bundle came from this runtime and is intact; it is a local trust root, not a proof of authorship, and a team that needs third-party-verifiable provenance can re-sign the envelope with its own key.

The create request accepts optional `label`, `target_host`, `include_message_content`, and `include_file_content`. Replay semantics are explicit: `replay.mode` is `recorded_replay`, recorded tool outputs are used as stubs, tools are never re-executed, and model requests are never re-issued, while `resume` and `fresh_run` are listed in `unsupported_modes` rather than implied.

Content is excluded by default, mirroring the OTel GenAI content-capture posture: message bodies and file bytes stay out unless `include_message_content` or `include_file_content` is set, and each excluded body is replaced by a byte count and sha256 reference. Credential secrets never enter a bundle — denied and injected credentials are described by metadata only, and any transcript field whose key names a secret is replaced with `[redacted]` and listed in `redaction.scrubbed_fields`.

Bundles are stored immutably: `GET /v1/x/handoff-bundles/{bundle_id}` returns exactly the payload that was stored.

`GET /v1/x/runtime` returns runtime-safe introspection data. Model entries expose
configuration metadata only:

```json
{
  "type": "runtime",
  "status": "running",
  "models": [
    {
      "name": "local",
      "provider": "openai",
      "model": "gpt-4o",
      "api_key_state": "configured",
      "base_url_state": "not_set"
    }
  ],
  "auth_enabled": true
}
```

`GET /v1/x/capabilities` is the source of truth for built-in tool availability.
It returns stable capability records with a `status` and, when unavailable, a
human-readable `reason`. The same response carries the CMA contract matrix under
`contract`, so a client reads local executability and protocol coverage from one
call instead of inferring one from the other:

```json
{
  "type": "capability_inventory",
  "capabilities": [
    { "id": "read", "kind": "tool", "status": "available" },
    {
      "id": "web_fetch",
      "kind": "tool",
      "status": "unavailable",
      "reason": "No safe executable implementation is available in this runtime."
    }
  ],
  "contract": {
    "type": "capability_matrix",
    "statuses": ["supported", "partial", "unavailable", "planned", "not_applicable", "unverified"],
    "summary": { "supported": 31, "partial": 10, "unavailable": 5, "planned": 0, "not_applicable": 2, "unverified": 1 },
    "capabilities": [
      {
        "area": "capabilities",
        "id": "capability-inventory-endpoint",
        "status": "supported",
        "reason": "/v1/x/capabilities returns the runtime capability inventory for Console and client consumption.",
        "contract": "contracts/anthropic-cma/capabilities.md"
      }
    ]
  }
}
```

Both arrays are abridged above; a real response carries every capability record
and every matrix entry. Each matrix entry names its `area`, its `status`, a
`reason` whenever the status is not `supported`, and the `contract` document that
carries the seven-section detail for that behaviour.

Agent create/update and session creation reject enabled unavailable capabilities
with `400 unsupported_capability` before an agent or session is persisted. In
particular, `web_fetch` and `web_search` cannot reach model or tool execution
until safe runtime implementations exist.

### Tool output overflow

A tool result larger than the local ceiling is written into the sandbox and the
model receives a short preview plus the path it can read the full content back
from. The preview opens with one marker line and reports the original and
retained character counts:

```text
[tool output overflow]
original_chars: 184320
preview_chars: 2000
file: /mnt/session/tool_outputs/sess_01J-9f3k2j1x8q.txt
file_bytes: 184320
The full output is available at the path above.
```

The `agent.tool_result` event records the spill path in its `tool_output_overflow`
metadata. That field is present only when a file was actually written: when no
sandbox is available or the write fails, the preview reports `file: none` and no
path is recorded, so a client is never pointed at a file that does not exist. A
failed spill never fails the turn.

One spill format serves every tool. The built-in tool path, the MCP tool path, and
the Pi stdout translator all call the same contract, so no tool can invent its own
truncation marker or its own retained-size accounting.

The local ceiling is 50,000 characters rather than the published 100,000. A local
runtime persists every event into SQLite, so the ceiling also bounds what one
session log can grow to.

### Executing web_fetch

`web_fetch` executes behind one guard chain, applied in this order:

1. **URL shape** — only `http:` and `https:`, no embedded credentials, and a length
   cap. A malformed or exotic URL is a refusal, not a request.
2. **Internal host names** — `localhost` and the `.local` / `.internal` /
   `.localhost` / `.localdomain` / `.invalid` family are refused before DNS,
   because a resolver can be pointed anywhere.
3. **Domain policy** — `allowed_domains` (exact host or subdomain) or
   `blocked_domains`, exactly the lists the agent definition declared. No list
   means any public host is reachable.
4. **Address guard** — every DNS result is checked against loopback, RFC 1918,
   link-local, CGNAT, and their IPv6 equivalents, and the connection is pinned to
   the validated address through a custom `lookup`. Pinning is what closes DNS
   rebinding: the address the guard checked is the address the socket connects
   to, so a second resolution cannot disagree with the first.
5. **Redirects** — every hop restarts checks 1-4, so a 302 to a forbidden or
   internal host is refused at that hop, with a bounded hop count.
6. **Response limits** — a byte cap aborts oversized bodies, a per-request timeout
   bounds slow ones, and only text-like content types are decoded; binary content
   is reported as its media type and size, never inlined.
7. **Context limits** — the extracted text is capped by `max_content_tokens` before
   it reaches the model.

Failures return an `Error: ...` result string — the same shape every other built-in
tool uses — so the model sees a real tool error rather than a fake success, and the
strategy persists it as a normal `agent.tool_result`.

The transport override surface (resolver, address guard, limits) is
constructor-level only. An agent definition cannot reach it, so no model-facing or
API-facing input can relax the guard.

`web_search` remains unavailable: no search provider is bundled or configured, so an
enabled entry is still refused by capability admission. `GET /v1/x/capabilities`
reports the two tools separately, because a missing safe implementation and a
missing provider are different facts.

### Web tool domain lists

`web_fetch` and `web_search` accept an optional domain list. Expressing a list is
independent of being able to run the tool: a disabled `web_fetch` with a
`blocked_domains` list is a storable declaration of intent, while an enabled
`web_fetch` is still refused by capability admission.

Agent create/update and session creation enforce these rules:

| Rule | Detail |
| --- | --- |
| One list per entry | `allowed_domains` or `blocked_domains`, never both. |
| Non-empty | An empty list is ambiguous and rejected; `null` means no restriction. |
| Size | 1-64 domains, each 1-255 characters. |
| Hostname shape | Plain ASCII hostname. No scheme, port, credentials, wildcard, whitespace, or path. No label may start or end with a hyphen. |
| Not an address | Any IP form is rejected, including bracketed IPv6 and numeric shorthand such as `127.1`. |
| Not internal | `localhost`, `.localhost`, `.local`, `.internal`, `.localdomain`, and `.invalid` are rejected. |
| Not a suffix | Bare registry suffixes such as `com`, `co.uk`, and single-label names such as `intranet` are rejected. |
| Path suffix | `web_fetch` domains carry no path; `web_search` may carry one suffix without whitespace or any of `? # $ , | ^ !`. |
| Unique | Duplicates are rejected after lowercasing and stripping one trailing slash. `www.example.com` does not stand in for `example.com`. |

`max_content_tokens` is accepted only on `web_fetch`; `user_location` only on
`web_search`.

A rejected list answers `400 invalid_request_error` naming the exact list and
zero-based index, for example `tools.0.configs.1.allowed_domains.2`.

The runtime never returns raw API keys or resolved secret values to the Console.

Settings V2 is the source of truth for model vendor, loop engine, storage,
memory, and sandbox configuration. Responses include both the saved document and
the effective document currently used by the process. Response excerpt:

```json
{
  "schema_version": 1,
  "revision": 2,
  "effective_revision": 1,
  "saved_config": {
    "schema_version": 1,
    "model": {
      "vendor": "openai",
      "base_url": "https://api.openai.com/v1",
      "api_key": "********",
      "options": {}
    }
  },
  "effective_config": {},
  "restart_required": true,
  "activation_status": "pending",
  "activation_errors": [],
  "diagnostics": {
    "metadata": {
      "path": ".managed-agents/data.db",
      "health": "ok"
    }
  },
  "secret_states": {
    "model": {
      "api_key": "configured"
    }
  },
  "adapters": {
    "loop_engine": [
      {
        "id": "builtin",
        "label": "Default",
        "status": "available",
        "restart_policy": "runtime",
        "options_schema": {
          "type": "object",
          "properties": {
            "default_max_steps": {
              "type": "integer",
              "minimum": 1,
              "maximum": 1000,
              "default": 25
            }
          },
          "additionalProperties": true
        }
      }
    ]
  }
}
```

Secret-looking adapter option keys, including `api_key`, `access_key`,
`secret`, `token`, `password`, and `credential`, are always masked in public
settings responses.
Adapter descriptors include backend-owned `options_schema` metadata for
adapter-specific options.

The Dashboard validates a changed candidate before enabling save, and API
clients should follow the same sequence: `GET /v1/x/settings`, edit the complete
document, `POST /v1/x/settings/validate`, optionally `POST /v1/x/settings/test`,
then `PUT /v1/x/settings` with the current `revision`. A successful save updates
`saved_config` and sets `restart_required` when the running process still uses
the older `effective_config`. The next CLI-managed restart promotes the last
valid saved revision to `effective_config`. If a saved row is corrupted outside
the API, startup keeps the last valid effective document instead of activating
the bad candidate and returns `activation_status: "failed"` with
`activation_errors` on subsequent settings reads until the saved document is
repaired.

Validate a candidate document:

```bash
curl -X POST http://127.0.0.1:3000/v1/x/settings/validate \
  -H "Content-Type: application/json" \
  -d @settings.json
```

Test one area without saving:

```bash
curl -X POST http://127.0.0.1:3000/v1/x/settings/test \
  -H "Content-Type: application/json" \
  -d '{
    "area": "storage.artifacts",
    "config": {
      "provider": "local",
      "options": {
        "base_path": "files"
      }
    }
}'
```

Model tests apply the same credential validation used by validate and save.
Other area tests are scoped to their adapter so local storage, memory, and
sandbox diagnostics can run before a model API key has been configured.
Those scoped checks still validate credentials that belong to the tested area.
Docker sandbox checks currently skip live daemon/image validation. Remote
sandbox checks require the worker API URL and key, then call
`/v1/x/health` on that remote worker API.

Save the complete document with optimistic concurrency:

```bash
curl -X PUT http://127.0.0.1:3000/v1/x/settings \
  -H "Content-Type: application/json" \
  -d '{
    "revision": 2,
    "config": {
      "schema_version": 1,
      "model": {
        "vendor": "openai",
        "api_key": "${OPENAI_API_KEY}",
        "options": {}
      },
      "loop_engine": {
        "provider": "builtin",
        "options": {
          "default_max_steps": 25
        }
      },
      "storage": {
        "metadata": {
          "provider": "sqlite",
          "options": {}
        },
        "artifacts": {
          "provider": "local",
          "options": {
            "base_path": "files"
          }
        }
      },
      "memory": {
        "enabled": true,
        "provider": "sqlite",
        "options": {}
      },
      "sandbox": {
        "provider": "local",
        "options": {
          "timeout_seconds": 300
        }
      }
    }
  }'
```

Literal secrets are encrypted at rest. API responses return masked placeholders
and `secret_states`; they never return plaintext or ciphertext.

`loop_engine.options.approval_mode` selects how a gated Pi native tool call is
answered. `interactive` (the default, and the resolution for an omitted key)
waits for a person; `preauthorized_once` lets the runtime answer one call itself
under a platform-owned rule. The key is optional, so a document written before it
existed stays valid unchanged, and an unrecognized name is refused by
`validate` and by `PUT` at the path `loop_engine.options.approval_mode` instead
of being coerced to the default. Selecting the mode is the preauthorization
authority and nothing more: every gated call still consumes exactly one durable
decision, an automatically allowed call is recorded and published as
`confirmation_source: "platform"` rather than as an approval a person gave, a
call the rule does not name keeps waiting for a person, and no part of the mode
becomes a standing permission or widens the agent's declared tool policy.

Successful saves emit a `runtime_settings_saved` structured log with only the
old revision, new revision, changed JSON paths, and restart flag. Secret values
and internal managed-secret references are not logged.

`GET /v1/x/logs` returns a standard page envelope with the most recent log
entries captured by the current process. `level` is a minimum severity filter
(`debug`, `info`, `warn`, or `error`), and `q` searches the rendered log line.
The in-memory buffer is intended for local operations and is reset when the
runtime restarts.

`POST /v1/x/restart` schedules a local runtime restart and returns:

```json
{
  "restarting": true,
  "status": "scheduled"
}
```

Embedded test servers or custom hosts that do not provide a restart hook return
`501 unsupported`. When available, restart stops accepting requests, drains the
session manager, closes SQLite, and starts a new process with the same command
line arguments.

## Pi lifecycle status boundary

When `loop_engine.provider` is `pi`, internal `cancelled`, `timed_out`,
`cleanup_pending`, and `failed` all project to public `terminated`; the event
log retains the distinct child-process outcomes. `cleanup_pending` is fail-closed: the
runtime has not proved that the process tree released the workspace, so it does
not clean up or accept a new turn. A live cross-runtime Pi session-file owner
returns a retryable `pi_session_busy` error. Resume refusal, corrupt headers,
path/schema mismatch, and missing SQLite continuity proof are visible errors;
they never silently start a second Pi history. A resume is also bound to the
contract the recorded turns ran under: the work directory they ran in, and a
fingerprint of the compiled tool plan, the model, and the approval mode, are
compared with what `pi_session_state` recorded, and a resume that differs is
refused with the stable code `pi_policy_mismatch` — naming whether the directory
or the policy changed — rather than continuing the conversation under a contract
its own durable events do not describe. A session recorded before that binding
existed has no recorded value to compare against and still resumes.

Pi-native tool events are trajectory records only while no policy gates them:
they do not run through the builtin `ToolResolver`, receive no Harness local path
confinement, and execute inside the Pi child. A native tool the agent declares
`always_ask` is the exception. The session loads a SandBase-managed Pi extension
for that tool, so the call is intercepted before it executes and the tool_use the
session publishes carries `requires_confirmation: true`,
`confirmation_group_id`, and the input a decision is being made against. The
request is recorded durably in `pi_tool_interactions`, the session reports
`idle` with a `requires_action` stop reason, and the matching `user.tool_confirmation` resolves that one
pending call: it is consumed by a conditional update, so a duplicate, mismatched,
or late decision is refused instead of executing anything. A decision that cannot
be recorded, a gate extension that did not load, a decision whose replacement
input is not a plain object, and a transport that dies while a decision is pending
all deny the call rather than letting it run. Docker and Kubernetes Pi transport
are not part of this local demo.

The decision a gated call waits for does not have to be a person's. When the
operator selected `loop_engine.options.approval_mode: "preauthorized_once"`, the
runtime answers a gated call itself under the platform-owned rule that mode
installs, through the same conditional consume: the decision is recorded with
`decision_source: "platform"`, the published `agent.tool_use` carries
`requires_confirmation: false` with `confirmation_source: "platform"` and
`confirmation_decision: "allow"` (or `"deny"` when the rule refuses the call),
and the session does not report `requires_action` for it. An automatically allowed
call is still spent by being applied — a replay of the same call, a mismatched
decision, and a person's answer for a call the platform already decided are all
refused — the next gated call is decided again instead of inheriting a standing
permission, a call the rule does not name keeps waiting for a person, and every
path that cannot consume a trustworthy decision still denies.
