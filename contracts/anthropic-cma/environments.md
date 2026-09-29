# CMA Contract — environments

Contract area: `/v1/environments` — reusable execution environments and the
published `config` shape they carry.
Status: `supported` for the published hosting and network configuration shape,
with `cloud` refused by name because no backend here can serve it. `partial` for
the network policy: it is normalized and returned in one spelling, but no shipped
sandbox provider enforces it, and this document says so rather than implying a
declared limit is applied. See §4.
Source: `src/sandbox/provider-names.ts`,
`src/core/config/environment-network.ts`, `src/api/routes/environments.ts`.

<!-- capability-status
environment-hosting-config: supported
environment-network-policy: partial
-->

---

## 1. Official definition

- An environment is a reusable, named configuration for session runtime setup:
  a required `name`, plus optional `description`, `metadata`, and `config`.
- `config` is discriminated on `type`, the hosting axis:
  - `{ type: "cloud" }` — hosting on machines the caller does not own. It carries
    `networking` and `packages`.
  - `{ type: "self_hosted" }` — hosting on a worker the caller operates. The
    published shape declares no other config field.
- `networking` is either `{ type: "unrestricted" }` or
  `{ type: "limited" }` with optional `allowed_hosts`, `allow_mcp_servers`, and
  `allow_package_managers`.
- `packages` is an object of package-manager declarations
  (`{ type: "packages", apt?, cargo?, gem?, go?, npm?, pip? }`).
- Environments are listed, retrieved, archived, and deleted, and this surface is
  a beta one: the official TypeScript SDK reaches it through its
  `beta.environments` namespace.
- The published "管理环境" section documents list, retrieve, archive, and delete
  with bare `curl` commands, which is the published-document reference this
  repository already relies on
  (`tests/integration/environments-query-admission.test.ts:1-14`). The typed
  shape above was measured against `@anthropic-ai/sdk@0.129.0`, whose beta
  resource types are generated from the published contract.

## 2. Current SandBase shape

The routes are `src/api/routes/environments.ts`; the vocabulary and the
translation between the two spellings of the hosting axis live in
`src/sandbox/provider-names.ts`, and the network policy is normalized by
`src/core/config/environment-network.ts`.

- `POST /v1/environments`, `GET /v1/environments`,
  `GET /v1/environments/{id}`, `PUT /v1/environments/{id}`, and
  `POST /v1/environments/{id}/archive` are mounted; the full local surface,
  including worker keys and work items, is in [`routes.md`](./routes.md).
- `config.type` and `config.hosting_type` are read as **one** declaration by
  `readDeclaredHostingType`. Either spelling names the same vocabulary
  (`local`, `docker`, `kubernetes`, `cloud`, `self_hosted`), either resolves
  through the same translation, and a hosting type that is declared but is not a
  string is refused rather than read as absent.
- Two spellings that disagree are refused with `invalid_environment_config`:
  `{ "type": "docker", "hosting_type": "local" }` cannot be honoured twice, and
  silently preferring one would run the session somewhere the other spelling did
  not ask for. Agreement is accepted.
- That refusal is about one request. A spelling a **stored row** left behind is
  not a caller statement: a request that names the axis in one spelling replaces
  the stored declaration in the other, and a request that clears a spelling with
  `null` or an empty string touches only that one. Without the replacement rule,
  a row the previous version wrote with the published spelling could not be
  renamed or repaired through the local spelling — so not through the Console,
  which only ever sends that one — and a request naming the hosting type once
  would be refused for disagreeing with a value it never sent.
- `cloud` is refused at write time with `unsupported_hosting_type`, naming the
  hosting types this build can execute, exactly as the local `hosting_type`
  spelling is refused. An unrecognized value (`team_server`) is refused the same
  way, by name.
- `config.networking` is normalized into `config.network` by
  `normalizeEnvironmentNetwork` and the published key is consumed: one stored
  policy, one spelling, whichever spelling arrived. `allow_mcp_servers` becomes
  `allow_mcp_server_network_access` and `allow_package_managers` becomes
  `allow_package_manager_network_access`; `allowed_hosts` is filtered to usable
  host patterns, and a key outside the documented vocabulary is preserved as
  written. The defaults are fail-closed: an unrecognized `type` is read as the
  restrictive `limited`, and a permission flag is granted only by the literal
  boolean `true`.
- A request that declares both network spellings with different content is
  refused with `invalid_environment_config`, for the same reason the hosting
  spellings are. `null` in either spelling clears the recorded policy, which is
  how a client removes a field here, and it clears a policy an older row stored
  in the other spelling too. A policy written by an older row in the published
  spelling is still reported: the projection reads either key, and the next write
  records it under the local one. A stored policy that is not an object is
  refused with a message naming the replacing request rather than dropped
  silently.
- The response projects `hosting_type` from the declaration — either spelling —
  so a caller of the published shape reads back the hosting it asked for rather
  than the `local` default, and `network` in the normalized local spelling. A
  stored declaration the resolution path would refuse — two spellings that
  disagree, or a value that is not a name — projects as `unknown`, so a record is
  never reported as runnable while a session on it would be refused.
- **The policy is recorded, not enforced.** No sandbox provider shipped in this
  runtime reads an environment's network policy, which is why the capability is
  `partial` rather than `supported` and why §4 states it as a difference.

## 3. Alignment

Aligned for: the published hosting axis (`type`, both values understood, `cloud`
refused rather than misread), the published `networking` object including its
`limited` / `unrestricted` forms and its two permission keys, the fail-closed
reading of a policy (limited, and a permission denied, unless the caller declared
otherwise), refusing an environment this runtime cannot execute instead of
accepting it and failing at session start, and reporting a declared policy back
to the caller.

## 4. Differences

| Difference | Detail |
| --- | --- |
| `config.type: "cloud"` | Refused with `unsupported_hosting_type` and the available values, at write time. No backend here serves cloud hosting, and mapping it onto the local backend is what previously ran such sessions unsandboxed on the runtime host. |
| Hosting spellings that disagree | Refused with `invalid_environment_config` rather than resolved by precedence. The published shape has one spelling, so a request carrying both is a caller error this runtime cannot guess at. A stored row that already holds both is refused at resolution and projects as `unknown`; naming either spelling in an update replaces it. |
| Workspace default seeding | `env_default` seeds the workspace `sandbox.provider` setting on a workspace that has no settings row. An `env_default` declaring a hosting type this build cannot execute refuses that seeding rather than substituting `local`, so such a workspace does not start until the row is repaired — with an update, or in the database when the runtime is not running. The local `hosting_type` spelling behaved this way before this change; the published `cloud` spelling is newly readable and was previously stored and ignored, so the state is reachable from data the previous version accepted. |
| Network policy enforcement | Normalized, stored, and returned, but not applied: no shipped provider reads it. A session whose environment declares `limited` with an empty `allowed_hosts` gets the same egress as an environment that declares `unrestricted`. |
| `config.packages` | Recorded and echoed as written, not interpreted, and the response's top-level `packages` stays the local list shape. Nothing installs declared packages for any provider, so the published object shape and the local `{ manager, package }` list are both inert configuration today. |
| Published delete | Not mounted. `POST /v1/environments/{id}/archive` is the local lifecycle verb; archived environments are excluded from the listing rather than removed. |
| Environment listing | Serves its whole set rather than a window, and accepts no query parameter ([`pagination.md`](./pagination.md)). The route surface, with its verbs, is in [`routes.md`](./routes.md). |

## 5. Reason for the difference

- `cloud` cannot be executed here: there is no cloud execution backend, so the
  only answers are a refusal that names the alternatives or an acceptance that
  lies about where the work will run. The refusal reuses the message and code the
  local `hosting_type` spelling already produced, so one cause has one code.
- The network policy is kept rather than dropped because the declaration is real
  information: a caller who wrote a limit should see it stored and returned, and
  a future provider that can enforce it must not have to ask callers to rewrite
  their configuration. It is documented as unenforced because a policy that is
  silently ignored is worse than one that is visibly recorded. When a provider
  reads it, this entry becomes `supported` and this row and §4 lose the
  difference.
- `packages` follows the same rule: the declaration is preserved verbatim so no
  caller loses data, and no install is claimed, because installing a package set
  is a provider feature with ordering and lockfile semantics that nothing here
  implements. Refusing the published object shape instead would reject a
  configuration for a field the runtime can store faithfully but not act on.
- The two-spelling refusals exist because the runtime has exactly one place to
  run a session and one policy to apply. Accepting two disagreeing declarations
  and picking one would make the effective configuration depend on which
  spelling a call site happened to read first.
- The rule applies to what one request declares, not to what a row already holds:
  a stored twin that disagrees is a legacy artifact of the spelling this runtime
  did not yet read, and refusing an update because of it would leave the record
  repairable only in the spelling the caller did not write. Stored records the
  runtime cannot resolve are still refused where they matter — resolution, and
  the workspace-default seed — and are reported as `unknown` rather than as a
  backend, so nothing is lowered to `local` and nothing is displayed as runnable
  when it is not.
- Inside one policy object, the local key wins over the published alias that
  names the same permission, because the local key is the one this runtime
  records. The result can only be stricter than the published spelling alone —
  never more permissive — which is why a mixed object is read rather than
  refused, and why the unit tests pin the direction.
- The workspace-default seed refuses rather than substituting a backend because
  that seed *is* the backend of every session created without an explicit
  Environment: defaulting it to `local` would run exactly those sessions on the
  runtime host. The cost is an unstartable workspace whose `env_default` declares
  hosting this build cannot serve, which §4 records.

## 6. Corresponding tests

- `tests/integration/environment-config-admission.test.ts` — every branch of the
  write path: the published `type` accepted and resolved, `cloud` and unknown
  values refused with `unsupported_hosting_type`, disagreeing hosting spellings
  refused with `invalid_environment_config`, non-string declarations refused,
  `networking` normalized into the local key with the published key consumed,
  network spellings compared, non-object policies refused, defaults filled, the
  refusal leaving no row behind, a request naming one spelling repairing a stored
  declaration in the other, a damaged stored policy refused with the repair it
  needs and then repaired or cleared, `null` clearing a policy an older row wrote
  in the published spelling, and the published network spelling accepted as a
  top-level field.
- `tests/unit/environment-network.test.ts` — the normalizer: alias translation,
  local precedence over an alias, fail-closed defaults, host-pattern filtering,
  unknown keys preserved, non-objects reported as no policy, and key-order
  independent comparison.
- `tests/unit/sandbox-provider-names.test.ts` — the alias at the naming
  boundary: resolution and projection from either spelling, `cloud` and unknown
  values refused with the same code as the local spelling, disagreement refused
  and projected as unreadable rather than as a backend, a non-name declaration
  refused instead of read as absent, and the workspace-default seed refusing a
  published hosting type it cannot serve while a workspace that already has
  settings still seeds.
- `tests/integration/api.test.ts` — the local environment surface: create, get,
  archive, the key-shaped response, and the session path that refuses an
  environment whose hosting type cannot execute.
- `tests/unit/contract-honesty.test.ts` — the matrix entries below, this file's
  status block, the routes, and the cited paths describing the same build.

## 7. Status

`supported` for the published configuration shape: the hosting axis is read in
both spellings through one vocabulary, `cloud` and unknown values are refused by
name with an actionable message and the documented code, the published network
vocabulary is accepted, and the response reports the hosting and the policy the
record actually holds. `partial` overall, for the reason §4 records: the network
policy is stored and returned but not enforced by any shipped provider, so a
declared limit does not yet change what a session may reach.
