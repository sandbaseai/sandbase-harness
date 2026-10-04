# CMA Contract — routes

Contract area: the canonical `/v1` route surface — which method answers which
path.
Status: `supported`. See §7.
Source: `src/api/server.ts`, `src/api/routes/agents.ts`,
`src/api/routes/api-keys.ts`, `src/api/routes/credential-vaults.ts`,
`src/api/routes/environments.ts`, `src/api/routes/files.ts`,
`src/api/routes/handoff.ts`, `src/api/routes/memory-stores.ts`,
`src/api/routes/operations.ts`, `src/api/routes/runs.ts`,
`src/api/routes/runtime.ts`, `src/api/routes/session-resources.ts`,
`src/api/routes/sessions.ts`, `src/api/routes/settings.ts`,
`src/api/routes/skills.ts`, `src/api/routes/stream.ts`,
`src/api/routes/templates.ts`, `src/api/routes/worker.ts`,
`src/api/routes/unsupported-official.ts`.

<!-- capability-status
documented-route-surface: supported
-->

---

## 1. Official definition

- A documented endpoint is one verb on one path. `POST /v1/agents` names the
  create handler; it is not satisfied by a router that answers the same URL for
  `GET`.
- A route the runtime mounts but does not document is a caller's guess. A route
  the documentation promises but the runtime does not mount is worse: the caller
  discovers it from a 404 after building a request the documentation said would
  work.

## 2. Current SandBase shape

`mountedRoutes()` in `tests/unit/support/route-table.ts` expands the real mount
graph from `src/api/server.ts`. It follows composed routers, translates the
`/v1/x` compatibility mirror back onto the canonical `/v1` path when that
canonical route is itself mounted, and reports paths with `{param}`
placeholders. The table below is that set, and
`tests/unit/contract-honesty.test.ts` asserts set equality in both directions:
every row is mounted, and every mounted route has a row.

| Method | Path | Registered by |
| --- | --- | --- |
| GET | `/v1/agents` | `src/api/routes/agents.ts` |
| POST | `/v1/agents` | `src/api/routes/agents.ts` |
| GET | `/v1/agents/{id}` | `src/api/routes/agents.ts` |
| PUT | `/v1/agents/{id}` | `src/api/routes/agents.ts` |
| POST | `/v1/agents/{id}` | `src/api/routes/agents.ts` |
| POST | `/v1/agents/{id}/archive` | `src/api/routes/agents.ts` |
| GET | `/v1/agents/{id}/versions` | `src/api/routes/agents.ts` |
| GET | `/v1/api-keys` | `src/api/routes/api-keys.ts` |
| POST | `/v1/api-keys` | `src/api/routes/api-keys.ts` |
| DELETE | `/v1/api-keys/{id}` | `src/api/routes/api-keys.ts` |
| GET | `/v1/credential-vaults` | `src/api/routes/credential-vaults.ts` |
| POST | `/v1/credential-vaults` | `src/api/routes/credential-vaults.ts` |
| GET | `/v1/credential-vaults/{id}` | `src/api/routes/credential-vaults.ts` |
| POST | `/v1/credential-vaults/{id}/archive` | `src/api/routes/credential-vaults.ts` |
| GET | `/v1/credential-vaults/{id}/audit` | `src/api/routes/credential-vaults.ts` |
| GET | `/v1/credential-vaults/{id}/credentials` | `src/api/routes/credential-vaults.ts` |
| POST | `/v1/credential-vaults/{id}/credentials` | `src/api/routes/credential-vaults.ts` |
| DELETE | `/v1/credential-vaults/{id}/credentials/{credentialId}` | `src/api/routes/credential-vaults.ts` |
| POST | `/v1/credential-vaults/{id}/credentials/{credentialId}/archive` | `src/api/routes/credential-vaults.ts` |
| GET | `/v1/credential-vaults/{id}/credentials/{credentialId}/audit` | `src/api/routes/credential-vaults.ts` |
| POST | `/v1/credential-vaults/{id}/credentials/{credentialId}/mark-used` | `src/api/routes/credential-vaults.ts` |
| POST | `/v1/credential-vaults/{id}/credentials/{credentialId}/rotate` | `src/api/routes/credential-vaults.ts` |
| GET | `/v1/vaults` | `src/api/routes/credential-vaults.ts` |
| POST | `/v1/vaults` | `src/api/routes/credential-vaults.ts` |
| GET | `/v1/vaults/{id}` | `src/api/routes/credential-vaults.ts` |
| POST | `/v1/vaults/{id}/archive` | `src/api/routes/credential-vaults.ts` |
| GET | `/v1/vaults/{id}/audit` | `src/api/routes/credential-vaults.ts` |
| GET | `/v1/vaults/{id}/credentials` | `src/api/routes/credential-vaults.ts` |
| POST | `/v1/vaults/{id}/credentials` | `src/api/routes/credential-vaults.ts` |
| DELETE | `/v1/vaults/{id}/credentials/{credentialId}` | `src/api/routes/credential-vaults.ts` |
| POST | `/v1/vaults/{id}/credentials/{credentialId}/archive` | `src/api/routes/credential-vaults.ts` |
| GET | `/v1/vaults/{id}/credentials/{credentialId}/audit` | `src/api/routes/credential-vaults.ts` |
| POST | `/v1/vaults/{id}/credentials/{credentialId}/mark-used` | `src/api/routes/credential-vaults.ts` |
| POST | `/v1/vaults/{id}/credentials/{credentialId}/rotate` | `src/api/routes/credential-vaults.ts` |
| GET | `/v1/environments` | `src/api/routes/environments.ts` |
| POST | `/v1/environments` | `src/api/routes/environments.ts` |
| DELETE | `/v1/environments/{id}` | `src/api/routes/environments.ts` |
| GET | `/v1/environments/{id}` | `src/api/routes/environments.ts` |
| POST | `/v1/environments/{id}` | `src/api/routes/environments.ts` |
| PUT | `/v1/environments/{id}` | `src/api/routes/environments.ts` |
| POST | `/v1/environments/{id}/archive` | `src/api/routes/environments.ts` |
| GET | `/v1/environments/{id}/worker-keys` | `src/api/routes/environments.ts` |
| POST | `/v1/environments/{id}/worker-keys` | `src/api/routes/environments.ts` |
| POST | `/v1/environments/{id}/worker-keys/{keyId}/revoke` | `src/api/routes/environments.ts` |
| GET | `/v1/environments/{id}/work-items` | `src/api/routes/environments.ts` |
| GET | `/v1/files` | `src/api/routes/files.ts` |
| POST | `/v1/files` | `src/api/routes/files.ts` |
| DELETE | `/v1/files/{id}` | `src/api/routes/files.ts` |
| GET | `/v1/files/{id}` | `src/api/routes/files.ts` |
| GET | `/v1/files/{id}/content` | `src/api/routes/files.ts` |
| GET | `/v1/memory_stores` | `src/api/routes/memory-stores.ts` |
| POST | `/v1/memory_stores` | `src/api/routes/memory-stores.ts` |
| DELETE | `/v1/memory_stores/{id}` | `src/api/routes/memory-stores.ts` |
| GET | `/v1/memory_stores/{id}` | `src/api/routes/memory-stores.ts` |
| POST | `/v1/memory_stores/{id}` | `src/api/routes/memory-stores.ts` |
| PUT | `/v1/memory_stores/{id}` | `src/api/routes/memory-stores.ts` |
| POST | `/v1/memory_stores/{id}/archive` | `src/api/routes/memory-stores.ts` |
| GET | `/v1/memory_stores/{id}/memories` | `src/api/routes/memory-stores.ts` |
| POST | `/v1/memory_stores/{id}/memories` | `src/api/routes/memory-stores.ts` |
| DELETE | `/v1/memory_stores/{id}/memories/{memoryId}` | `src/api/routes/memory-stores.ts` |
| PUT | `/v1/memory_stores/{id}/memories/{memoryId}` | `src/api/routes/memory-stores.ts` |
| GET | `/v1/memory_stores/{id}/memory_versions` | `src/api/routes/memory-stores.ts` |
| GET | `/v1/memory_stores/{id}/memory_versions/{versionId}` | `src/api/routes/memory-stores.ts` |
| GET | `/v1/outcomes` | `src/api/routes/operations.ts` |
| POST | `/v1/outcomes` | `src/api/routes/operations.ts` |
| GET | `/v1/outcomes/{id}` | `src/api/routes/operations.ts` |
| PUT | `/v1/outcomes/{id}` | `src/api/routes/operations.ts` |
| POST | `/v1/outcomes/{id}/archive` | `src/api/routes/operations.ts` |
| POST | `/v1/runs` | `src/api/routes/runs.ts` |
| GET | `/v1/deployments` | `src/api/routes/deployments.ts` |
| POST | `/v1/deployments` | `src/api/routes/deployments.ts` |
| GET | `/v1/deployments/{id}` | `src/api/routes/deployments.ts` |
| PUT | `/v1/deployments/{id}` | `src/api/routes/deployments.ts` |
| POST | `/v1/deployments/{id}/archive` | `src/api/routes/deployments.ts` |
| POST | `/v1/deployments/{id}/pause` | `src/api/routes/deployments.ts` |
| POST | `/v1/deployments/{id}/unpause` | `src/api/routes/deployments.ts` |
| POST | `/v1/deployments/{id}/run` | `src/api/routes/deployments.ts` |
| GET | `/v1/deployments/{id}/runs` | `src/api/routes/deployments.ts` |
| POST | `/v1/deployments/run-due` | `src/api/routes/deployments.ts` |
| GET | `/v1/deployment_runs` | `src/api/routes/deployment-runs.ts` |
| GET | `/v1/deployment_runs/{id}` | `src/api/routes/deployment-runs.ts` |
| GET | `/v1/scheduled-deployments` | `src/api/routes/deployments.ts` |
| POST | `/v1/scheduled-deployments` | `src/api/routes/deployments.ts` |
| GET | `/v1/scheduled-deployments/{id}` | `src/api/routes/deployments.ts` |
| PUT | `/v1/scheduled-deployments/{id}` | `src/api/routes/deployments.ts` |
| POST | `/v1/scheduled-deployments/{id}/archive` | `src/api/routes/deployments.ts` |
| POST | `/v1/scheduled-deployments/{id}/pause` | `src/api/routes/deployments.ts` |
| POST | `/v1/scheduled-deployments/{id}/unpause` | `src/api/routes/deployments.ts` |
| POST | `/v1/scheduled-deployments/{id}/run` | `src/api/routes/deployments.ts` |
| GET | `/v1/scheduled-deployments/{id}/runs` | `src/api/routes/deployments.ts` |
| POST | `/v1/scheduled-deployments/run-due` | `src/api/routes/deployments.ts` |
| GET | `/v1/sessions` | `src/api/routes/sessions.ts` |
| POST | `/v1/sessions` | `src/api/routes/sessions.ts` |
| POST | `/v1/sessions/{id}/archive` | `src/api/routes/sessions.ts` |
| DELETE | `/v1/sessions/{id}` | `src/api/routes/sessions.ts` |
| GET | `/v1/sessions/{id}` | `src/api/routes/sessions.ts` |
| POST | `/v1/sessions/{id}` | `src/api/routes/sessions.ts` |
| GET | `/v1/sessions/{id}/artifacts` | `src/api/routes/sessions.ts` |
| POST | `/v1/sessions/{id}/artifacts` | `src/api/routes/sessions.ts` |
| GET | `/v1/sessions/{id}/artifacts/{artifactId}/content` | `src/api/routes/sessions.ts` |
| GET | `/v1/sessions/{id}/events` | `src/api/routes/sessions.ts` |
| POST | `/v1/sessions/{id}/events` | `src/api/routes/sessions.ts` |
| GET | `/v1/sessions/{id}/events/stream` | `src/api/routes/stream.ts` |
| POST | `/v1/sessions/{id}/messages` | `src/api/routes/sessions.ts` |
| GET | `/v1/sessions/{id}/outcomes` | `src/api/routes/operations.ts` |
| POST | `/v1/sessions/{id}/outcomes` | `src/api/routes/operations.ts` |
| POST | `/v1/sessions/{id}/outcomes/evaluate` | `src/api/routes/operations.ts` |
| GET | `/v1/sessions/{id}/resources` | `src/api/routes/session-resources.ts` |
| POST | `/v1/sessions/{id}/resources` | `src/api/routes/session-resources.ts` |
| DELETE | `/v1/sessions/{id}/resources/{resourceId}` | `src/api/routes/session-resources.ts` |
| GET | `/v1/sessions/{id}/resources/{resourceId}` | `src/api/routes/session-resources.ts` |
| PATCH | `/v1/sessions/{id}/resources/{resourceId}` | `src/api/routes/session-resources.ts` |
| POST | `/v1/sessions/{id}/stop` | `src/api/routes/sessions.ts` — deprecated local `user.interrupt` alias; removed next version |
| GET | `/v1/skills` | `src/api/routes/skills.ts` |
| POST | `/v1/skills` | `src/api/routes/skills.ts` |
| DELETE | `/v1/skills/{skillId}` | `src/api/routes/skills.ts` |
| GET | `/v1/skills/{skillId}` | `src/api/routes/skills.ts` |
| GET | `/v1/webhooks` | `src/api/routes/operations.ts` |
| POST | `/v1/webhooks` | `src/api/routes/operations.ts` |
| GET | `/v1/webhooks/{id}` | `src/api/routes/operations.ts` |
| PUT | `/v1/webhooks/{id}` | `src/api/routes/operations.ts` |
| POST | `/v1/webhooks/{id}/archive` | `src/api/routes/operations.ts` |
| GET | `/v1/webhooks/{id}/deliveries` | `src/api/routes/operations.ts` |
| POST | `/v1/webhooks/{id}/retire-secret` | `src/api/routes/operations.ts` |
| POST | `/v1/webhooks/{id}/rotate-secret` | `src/api/routes/operations.ts` |
| POST | `/v1/webhooks/{id}/test` | `src/api/routes/operations.ts` |
| POST | `/v1/webhooks/dispatch` | `src/api/routes/operations.ts` |
| POST | `/v1/webhooks/retry-due` | `src/api/routes/operations.ts` |
| GET | `/v1/x/capabilities` | `src/api/routes/runtime.ts` |
| GET | `/v1/x/handoff-bundles` | `src/api/routes/handoff.ts` |
| GET | `/v1/x/handoff-bundles/{id}` | `src/api/routes/handoff.ts` |
| GET | `/v1/x/health` | `src/api/routes/runtime.ts` |
| GET | `/v1/x/logs` | `src/api/routes/runtime.ts` |
| GET | `/v1/x/mcp/status` | `src/api/routes/runtime.ts` |
| GET | `/v1/x/metrics` | `src/api/routes/runtime.ts` |
| GET | `/v1/x/metrics/summary` | `src/api/routes/runtime.ts` |
| POST | `/v1/x/reload` | `src/api/routes/runtime.ts` |
| POST | `/v1/x/restart` | `src/api/routes/runtime.ts` |
| GET | `/v1/x/runtime` | `src/api/routes/runtime.ts` |
| POST | `/v1/x/sessions/{id}/handoff-bundle` | `src/api/routes/handoff.ts` |
| GET | `/v1/x/settings` | `src/api/routes/settings.ts` |
| PUT | `/v1/x/settings` | `src/api/routes/settings.ts` |
| POST | `/v1/x/settings/test` | `src/api/routes/settings.ts` |
| POST | `/v1/x/settings/validate` | `src/api/routes/settings.ts` |
| GET | `/v1/x/templates` | `src/api/routes/templates.ts` |
| POST | `/v1/x/worker/accept` | `src/api/routes/worker.ts` |
| POST | `/v1/x/worker/claim` | `src/api/routes/worker.ts` |
| POST | `/v1/x/worker/heartbeat` | `src/api/routes/worker.ts` |
| POST | `/v1/x/worker/complete` | `src/api/routes/worker.ts` |
| GET | `/v1/x/workspace` | `src/api/routes/runtime.ts` |

Reading the table:

- The path column is the canonical `/v1` spelling. A `/v1/x/...` row is an
  extension route with no canonical twin, because the mirror of a canonical
  route is the same route rather than a second one — that is why
  `POST /v1/agents` appears once instead of twice.
- A `{param}` placeholder is one path segment. `{id}` and `{credentialId}` in
  the same row mean two different parameters, not a repeated one.
- The third column is the module that registers the handler, so a documented
  route can be traced to code without searching the router tree.

### Explicit Unsupported Official Operations

These mounts are refusals, not implemented resource operations. Each returns
HTTP 400 `unsupported_capability` with a compatibility-table reference after
authentication, throttling, and header admission. Unknown verbs or descendants
remain unserved. See [`unsupported.md`](./unsupported.md).

| Method | Path | Registered by |
| --- | --- | --- |
| GET | `/v1/dreams` | `src/api/routes/unsupported-official.ts` |
| GET | `/v1/dreams/{id}` | `src/api/routes/unsupported-official.ts` |
| GET | `/v1/environments/{id}/work` | `src/api/routes/unsupported-official.ts` |
| GET | `/v1/environments/{id}/work/{workId}` | `src/api/routes/unsupported-official.ts` |
| GET | `/v1/environments/{id}/work/poll` | `src/api/routes/unsupported-official.ts` |
| GET | `/v1/environments/{id}/work/stats` | `src/api/routes/unsupported-official.ts` |
| GET | `/v1/tunnels` | `src/api/routes/unsupported-official.ts` |
| GET | `/v1/tunnels/{id}` | `src/api/routes/unsupported-official.ts` |
| GET | `/v1/tunnels/{id}/certificates` | `src/api/routes/unsupported-official.ts` |
| GET | `/v1/tunnels/{id}/certificates/{certificateId}` | `src/api/routes/unsupported-official.ts` |
| GET | `/v1/user_profiles` | `src/api/routes/unsupported-official.ts` |
| GET | `/v1/user_profiles/{id}` | `src/api/routes/unsupported-official.ts` |
| POST | `/v1/dreams` | `src/api/routes/unsupported-official.ts` |
| POST | `/v1/dreams/{id}/archive` | `src/api/routes/unsupported-official.ts` |
| POST | `/v1/dreams/{id}/cancel` | `src/api/routes/unsupported-official.ts` |
| POST | `/v1/environments/{id}/work/{workId}` | `src/api/routes/unsupported-official.ts` |
| POST | `/v1/environments/{id}/work/{workId}/ack` | `src/api/routes/unsupported-official.ts` |
| POST | `/v1/environments/{id}/work/{workId}/heartbeat` | `src/api/routes/unsupported-official.ts` |
| POST | `/v1/environments/{id}/work/{workId}/stop` | `src/api/routes/unsupported-official.ts` |
| POST | `/v1/tunnels` | `src/api/routes/unsupported-official.ts` |
| POST | `/v1/tunnels/{id}/archive` | `src/api/routes/unsupported-official.ts` |
| POST | `/v1/tunnels/{id}/certificates` | `src/api/routes/unsupported-official.ts` |
| POST | `/v1/tunnels/{id}/certificates/{certificateId}/archive` | `src/api/routes/unsupported-official.ts` |
| POST | `/v1/tunnels/{id}/reveal_token` | `src/api/routes/unsupported-official.ts` |
| POST | `/v1/tunnels/{id}/rotate_token` | `src/api/routes/unsupported-official.ts` |
| POST | `/v1/user_profiles` | `src/api/routes/unsupported-official.ts` |
| POST | `/v1/user_profiles/{id}` | `src/api/routes/unsupported-official.ts` |
| POST | `/v1/user_profiles/{id}/enrollment_url` | `src/api/routes/unsupported-official.ts` |
| POST | `/v1/vaults/{id}/credentials/{credentialId}/mcp_oauth_validate` | `src/api/routes/credential-vaults.ts` |
| POST | `/v1/credential-vaults/{id}/credentials/{credentialId}/mcp_oauth_validate` | `src/api/routes/credential-vaults.ts` |

## 3. Alignment

Aligned for: the canonical `/v1` collections the published contract defines
(agents, sessions and their events and stream, files, memory stores, runs, and
vaults and deployments under both their published and their local spelling), one
verb per documented action, and no documented route that is absent from the
running server.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Extension routes | `/v1/x/*` (runtime, settings, metrics, logs, workspace, templates, handoff bundles, worker claim/complete) are local surfaces the published contract does not define, kept in the extension namespace so no cloud beta header can gate them. |
| Local collections | `/v1/skills`, `/v1/api-keys`, `/v1/credential-vaults`, `/v1/scheduled-deployments`, `/v1/webhooks` and `/v1/outcomes` are SandBase resources. The published contract describes neither their paths nor their verbs. `/v1/environments` is not one of them: it is a published beta surface, read through its own contract file, and a caller of the published shape reaches the same routes. |
| Aliased resources | Vaults and deployments answer at both spellings — `/v1/vaults*` beside `/v1/credential-vaults*`, and `/v1/deployments*` beside `/v1/scheduled-deployments*`. Each pair is one router mounted twice, so the two cannot diverge route by route, and the local spelling is neither deprecated nor redirected. The aliases are mounts rather than curated lists, so a local extension route is reachable at the published prefix too: `/v1/vaults/{id}/audit` and `/v1/deployments/run-due` have no published equivalent but answer nonetheless, because a caller who learned the published spelling should not have to learn which routes answer at it. |
| Lifecycle verbs | `/v1/agents/{id}/archive`, `/v1/sessions/{id}/stop`, `/v1/environments/{id}/archive`, `/v1/memory_stores/{id}/archive`, `/v1/scheduled-deployments/{id}/run` and their siblings are local action spellings. The deployment actions are the exception: `archive`, `run`, `pause` and `unpause` are all published for a deployment, so their `/v1/deployments/{id}/...` spellings are documented rather than extensions. `run-due` remains a local convenience route with no published equivalent. |
| Mirror visibility | The `/v1/x` mirror of a canonical route is deliberately not a second documented route: it answers the same handler and would otherwise double every row in this table. |

## 5. Reason for the difference

- The extension namespace exists so local capability can grow without
  pretending to be part of the published API. Keeping the extension routes in
  this table rather than a separate document means "what this build answers" is
  one list, and the extension/canonical boundary is a column reader can see.
- The mirror is excluded from the table because documenting it as a distinct
  route would claim two contracts for one handler. A client that needs the
  mirror spelling has `pagination.md` and `headers.md`, which describe the
  mirror's envelope and admission rules.
- A local action verb (archive, stop, run) is recorded here rather than hidden,
  so a caller reading only the published contract is not misled into expecting
  a `DELETE` that does not exist.

## 6. Corresponding tests

- `tests/unit/contract-honesty.test.ts` — the route-set equality guard: it reads
  the real mount graph through `mountedRoutes()`, parses this table, compares
  `"METHOD /path/{}"` keys, and fails in both directions. One case feeds the
  parser deliberately broken input to prove a documented `POST` on a
  `GET`-only path is caught.

## 7. Status

`supported` — the mounted method+path set and the documented method+path set are
equal, asserted against the expanded mount graph rather than a second
hand-written table, so adding or removing a route requires editing this
document in the same change.
