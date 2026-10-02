# CMA Contract — credentials and vaults

Contract area: `/v1/vaults` and vault credentials.
Status: `supported` for the wire profile and rotation; `partial` for injection
execution; OAuth refresh is `unavailable`, see §4 and §7.
Source: `src/core/credentials/canonical-credential.ts`,
`src/api/routes/credential-vaults.ts`, `src/core/credentials/policy.ts`.

<!-- capability-status
canonical-credential-wire-profile: supported
credential-rotation: supported
credential-injection-execution: partial
oauth-refresh: unavailable
-->

---

## 1. Official definition

- A vault carries `display_name` and optional `metadata`.
- A credential nests its type under `auth`. Each type has its own shape:
  - `mcp_oauth` — keyed by `mcp_server_url`, with `access_token` and an optional
    `refresh` block carrying `token_endpoint`, `client_id`, and
    `token_endpoint_auth`.
  - `static_bearer` — keyed by `mcp_server_url`, carrying a fixed `token`.
  - `environment_variable` — keyed by `secret_name`, carrying `secret_value`,
    `networking`, and `injection_location`.
- MCP credential types are **keyed by `mcp_server_url`**: a credential matches
  the MCP server declared with the same URL. Matching normalizes scheme and host
  case, removes a default port, and ignores a single trailing slash; a different
  path, subdomain, or non-default port is a genuine mismatch.
- Write-only fields — `token`, `access_token`, `refresh_token`,
  `client_secret`, `secret_value` — are accepted on write and never returned.
- Structural fields — `mcp_server_url`, `secret_name`, `token_endpoint`,
  `client_id` — are locked after creation. Changing one requires archiving the
  credential and creating a new one.
- `injection_location` is an optional object with `header` and `body` booleans,
  sibling to `networking`:
  - On create, **omitting it enables both positions**; supplying the object
    fills omitted fields with `false`.
  - An explicit `null` for the object or either field is an error; the field
    should be omitted instead.
  - At least one position must be enabled.
  - The response always returns both fields resolved.

## 2. Current SandBase shape

Paths:

- Vaults answer at **both** the published `/v1/vaults*` and the local
  `/v1/credential-vaults*`. They are not two implementations: one router declares
  its paths relative to its mount and `src/api/routes/resources.ts` mounts that
  same factory at both prefixes, so the two spellings cannot diverge route by
  route, and a vault route added later is reachable at both. Both prefixes are CMA
  resource paths, so both inherit the same version and beta admission — the
  published prefix is not an admission shortcut. `tests/unit/vault-path-parity.test.ts`
  asserts the parity and `tests/integration/vault-path-aliases.test.ts` asserts a
  vault created through one spelling is readable through the other.
- The local spelling is not deprecated, redirected, or removed: the Console, the
  TypeScript SDK and existing stored references all use it.

Listing:

- The vault listing implements the published `include_archived` parameter
  (`将工作委派给智能体/使用保管库进行身份验证.md:1119`): archived vaults are excluded
  by default and returned when the parameter is `true`, each with
  `status: "archived"` and a non-null `archived_at`. `false` is accepted and means
  the default.
- A value that is neither is a `400` rather than a fall-back to the default, and so
  is sending the parameter twice with different values: a request that looks
  filtered must not be answered as though it were not, and two contradictory
  values have no reading that is not a guess.
- Including an archived vault in a listing is not an un-archive: the
  single-resource read still answers `404` for an archived vault and archiving
  remains terminal.
- The listing implements the published pagination rule — `limit` (default 20,
  maximum 100) with a `page` cursor (`管理智能体上下文/Dreams.md:575`; the same rule
  governs the memory-store listing) — through the shared reading in
  `src/api/routes/query-params.ts`. `prev_page`/`next_page` are the cursors a
  caller passes back as `page`; they are `null` only at the ends of the walk.
- The cursor is opaque and carries the ordering **and** the `include_archived`
  view that produced the page. Replaying one under the other view, or against the
  memory-store listing, is a `400` rather than an answer to a page that never
  existed for that query.
- A `limit` outside `1..100`, a non-integer, or a repeated value is a `400` naming
  the accepted range: a caller who asked for 500 rows and received 100 — or asked
  for `abc` and received the default — has been answered as though they asked for
  something else.
- The listing orders by `created_at DESC` with `rowid DESC` as a tie-break.
  `created_at` is `datetime('now')`, so vaults created in the same second share a
  timestamp; a windowed listing needs a total order to slice, or a page boundary
  can repeat or drop a row.
- Both the published `/v1/vaults` and the local `/v1/credential-vaults` mount the
  same router, so the window behaves identically at both spellings.
- A query parameter the listing does not implement is a `400` naming the parameter
  and the parameters the route accepts (`include_archived`, `limit`, `page`), rather
  than a page answered as though the request had been understood. The admission list
  is derived from the parameter-name constants the readings use
  (`COLLECTION_LISTING_QUERY_PARAMS`) and is shared with the memory-store listing, so
  the two collections cannot come to admit different parameters. `beta` is accepted
  but is deliberately not advertised, because its compatibility semantics are not
  modelled and listing it would read as honouring it.
- The published archived-half opt-in applies to a vault's **credentials** too, not only
  to the vault collection: "**列出 vault 或凭证：** … 默认排除已归档的记录（传递
  `include_archived=true` 可将其包含在内）" (`将工作委派给智能体/使用保管库进行身份验证.md:1119`)
  names both in one sentence. `GET /v1/credential-vaults/{id}/credentials` reads it now.
  It did not before: `listCredentials` hardcoded `AND archived_at IS NULL`, so an archived
  credential was unreachable through the only listing that serves credentials, and nothing
  in the response said the filter had been ignored — the same defect this file's vault
  listing carried before it was fixed, in the same route module. `toCredential` already
  labelled an archived row (`status: 'archived'`, `archived_at`), so reading the parameter
  was the only missing piece, and the label is asserted as well as the membership: a row
  admitted by the filter but indistinguishable from an active one would not answer the
  question the parameter asks. Rows with `status = 'deleted'` stay excluded either way,
  because deletion keeps no audit record and is not what "archived" means. Two gaps remain
  on that listing and are **not** closed here: it is unwindowed (`next_page` is always
  `null`, so the published pagination rule is only met in the sense of an honest empty
  cursor), and a parameter it does not implement is still ignored rather than refused.

Wire profile:

- `display_name` is read from the **top level** of the payload, a sibling of
  `auth` and `metadata`. `auth.display_name` is accepted as a local alias and
  the top-level spelling wins when both are present.
- The three canonical `auth.type` values are supported. The local legacy values
  `bearer_token` (flat) and the `auth_type` + `value` + `variable_name` flat
  spelling are accepted on write and normalized.
- Supplying both `auth` and the flat spelling is rejected rather than merged:
  merging would let a flat field override a nested one, which is how a
  credential ends up pointed somewhere the caller did not intend.

Write-only handling:

- Secret material is encrypted at rest; the record stores only a hint (the last
  four characters) for display.
- `toCanonicalCredential` omits write-only fields entirely rather than masking
  them, because a mask could be mistaken for the real value.

Locked fields:

- `checkCredentialUpdate` reports **every** locked field an update tried to
  change, so the caller learns the full set rather than fixing one and
  rediscovering the next.

Rotation:

- A rotation replaces only the ciphertext, nonce, tag, and hint. The credential's
  identity, `auth_type`, name, network policy, and injection locations are
  preserved. The prior ciphertext is overwritten, so the old secret is not
  recoverable from this runtime once rotation succeeds.
- When the rotated Vault is referenced by a live Session, the runtime asks that
  Session's MCP manager to close and reconnect its configured transports, so the
  next MCP tool call uses the newly resolved credential without recreating the
  Session. A reconnect failure does not roll back the committed rotation: the
  Session is reported in the failure set the caller receives, and the MCP status
  remains the source of truth for a degraded server.

`injection_location`:

- Implemented to the published rules, including the create/update asymmetry, the
  `null` rejection, the at-least-one rule, and returning both fields resolved.
- The local legacy `injection_locations` token list is kept as a SandBase
  extension on the stored record, so a caller that wrote a token list still
  observes it. The canonical `auth` projection carries `injection_location` only
  for environment variables.
- For the two MCP types the field is not part of the create shape, so a credential
  created through the published route stores an empty list. On a credential keyed by
  `mcp_server_url` an empty list is read as "not specified" and the secret is
  presented as a request header, which is the only position a url transport offers.
  A list that was given is still read as written, so a keyed credential never gains
  a position its own record excluded.

MCP URL binding:

- `mcpServerUrlMatches` canonicalizes both sides before comparing: scheme and
  host case, a default port, and a single trailing slash are normalized, and a
  different path, subdomain, or non-default port is a mismatch. It is applied on
  the connection path: a credential keyed by `mcp_server_url` is attached only to
  the server whose URL it names, and a caller that names no server never receives
  one. A credential for another endpoint is not applicable to this call rather than
  refused for it, so the connection is attempted without authentication and no
  denial is recorded.

GitHub resource boundary:

Session execution:

- `DefaultSessionExecutor` resolves the session's vaults once per turn with
  `resolveSessionCredentialInjections`, injects the resulting `environment` into
  the sandbox command environment, redacts every value a sandbox tool hands back,
  and clears the retained values when the turn ends. The resolver is supplied by
  the runtime composition (`src/index.ts` → `createRuntimeSessionServices` → the
  executor), so a runtime started by the CLI has the path; an embedder that
  assembles these services without a credential store runs sessions with no vault.
- A shell command declares no target host, so only credentials the policy admits
  without one reach the environment. A `limited` credential is denied for a shell
  command exactly as it is denied for any other call without a target host.
- The same resolved `environment` starts a stdio MCP server the agent declares,
  and a vault value wins over the `env` the agent configured itself. A
  url-transport server is handed the credentials scoped to its own URL as request
  headers, on the initial SSE request and on every message POST. Values an MCP tool
  returns are scrubbed the way a sandbox tool's return value is, and the resolver's
  bundle is cleared after each use so nothing outlives the call.
- The delegated child path is **not** covered: `DelegationService` builds its own
  sandbox tools and does not thread credentials, so a sub-agent receives no vault
  environment. Nothing is injected into model requests either.

- A `github_repository.authorization_token` is a separate encrypted
  session-resource secret, matching the official CMA GitHub resource shape. It
  is not resolved from `vault_ids`; Vault credentials are used for MCP and
  environment-variable authentication. A future `credential_id` reference may
  be offered as a SandBase extension, but it must not replace the canonical
  resource field or make GitHub mounts depend on an unrelated Vault.

## 3. Alignment

Aligned for: the nested `auth` profile, all three type shapes, MCP keying by
URL with normalization, write-only secret handling, locked structural fields,
the `injection_location` create rules and the both-fields-resolved read
projection, rotation that preserves identity and reconnects the MCP transports of
the sessions that reference the vault, the published `/v1/vaults*` paths, and the
session path that injects a
vault's environment into its own sandbox commands and into a stdio MCP server the
agent declares, attaches a `static_bearer` credential to the url-transport server
whose URL it was keyed to, and redacts what each of them returns.
There is no credential update route: structural fields are locked, so a change
means archive and recreate.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Credential exposure in the sandbox | This is a **security-model** difference, not a placement detail. SandBase puts the secret itself into the sandbox command environment as plaintext, so any command the agent runs can read it and send it anywhere it can reach. The published model keeps the secret out of the process and substitutes it at the network egress, so the value the model's code can observe is an opaque placeholder. There is no placeholder in this runtime and no egress substitution: `vault_ids` currently means "export these secrets into the process". |
| OAuth refresh | There is no refresh loop or refresh-failure event. The official MCP OAuth validation endpoint explicitly returns HTTP 400 `unsupported_capability` under both vault prefixes, without executing validation. A supplied `refresh` block is parsed, recorded, and reported back as **not executed**, with a warning on the response. |
| Legacy ingress | The flat `auth_type` spelling and the `injection_locations` token list are accepted for backward compatibility. The published contract defines neither. |
| Read projection | The canonical `auth` object is additive on read: it is returned beside the local `auth_type` / `name` / `variable_name` / `injection_locations` fields. The Console credential pages render and search on those local fields (`CredentialPages.tsx`, `CredentialVaultPages.tsx`) and `tests/integration/api.test.ts` asserts them, so dropping them is a Console migration rather than a wire change. |
| Local network policy | `networking` normalization uses the same shared normalizer the runtime policy uses, so a stored policy and an enforced policy cannot disagree. The published contract states the field and its meaning, not the normalization detail. |
| Audit | Rotations append a credential audit event. The published contract requires rotation semantics without fixing an audit shape. |
| Delegated execution | A session's vault environment reaches its own sandbox commands and a stdio MCP server it declares, but the delegated child path builds its own sandbox tools and receives none. The published contract does not describe sub-agent credential scope, so this is recorded as a boundary rather than presented as alignment. |
| Local management routes answer at the published prefix too | `rotate`, `mark-used` and both `audit` routes are local extensions with no published equivalent, and they are reachable under `/v1/vaults*` as well as `/v1/credential-vaults*`. The alias is a mount, not a curated list, so a caller who learned the published spelling does not have to learn which routes answer at it. This is recorded rather than curated because curating would create exactly the per-route divergence the mount prevents. |

## 5. Reason for the difference

- Plaintext injection is recorded as a difference rather than folded into
  "alignment" because the two models give a caller different guarantees. Under
  the published model, running untrusted code beside a credential is survivable:
  the code sees a placeholder and the real value is attached on the way out.
  Here the value is in the environment, so the same untrusted code can read it,
  print it, or post it elsewhere. Writing this as an injection-location detail
  would tell a caller their secret never reaches the process, which is the
  opposite of what happens.
- OAuth refresh is reported rather than silently stored because the failure mode
  matters: a session would keep presenting an expired access token and report
  nothing. A warning that reaches the caller is the difference between a
  diagnosable auth failure and a mystery.
- The legacy spelling is accepted so existing SandBase callers keep working, but
  it is documented as legacy rather than presented as canonical.
- Rotation preserving identity follows from the locking rule: if identity
  fields cannot change, a rotation that changed them would be a new credential
  wearing an old id.

## 6. Corresponding tests

- `tests/unit/canonical-credential.test.ts` — 26 cases: `injection_location`
  create/update asymmetry and `null` rejection, all three auth shapes, the
  both-spellings rejection, MCP URL normalization and mismatch cases, locked
  field reporting, and write-only omission from the projection.
- `tests/integration/canonical-credential-wire.test.ts` — each canonical type
  created through the published endpoint and read back through it: the nested
  round trip with its resolved `injection_location`, the `static_bearer` name on
  the wire, the `refresh` warning, the mixed-shape refusal, the legacy flat alias,
  the missing-field refusals, and that no response carries the secret.
- `tests/integration/credential-execution.test.ts` — the executor resolves the
  session's vault, the bash tool receives `{env: {TOKEN: …}}`, the string the
  strategy sees is redacted, and no persisted event carries the secret.
- `tests/unit/credential-policy.test.ts` — network policy normalization.
- `tests/unit/credential-redaction.test.ts` — secret material never appears in
  a response.
- `tests/integration/api.test.ts` — vault and credential CRUD, rotation,
  and canonical response shape.
- `tests/integration/mcp.test.ts` — a real stdio MCP server reports the value it
  was started with, proving the session's Vault environment credential reached the
  process and that the agent's own `env` value lost to it; the same case under a
  `limited` credential shows the refusal reaching the audit trail instead. A real
  SSE server reports the header it received, which is `Bearer` plus the credential
  keyed to its URL and `none` for a credential keyed elsewhere or for a caller that
  names no server. The transport half of the rotation expectation is asserted in
  this file too: a row that is rotated in place leaves the connected process holding
  the previous value until the session is asked to reconnect, after which the same
  tool wrapper reports the new one; `tests/integration/credential-rotation.test.ts`
  covers the route that asks for it.
- `tests/integration/credential-rotation.test.ts` — the rotation route notifies
  every active Session that references the rotated Vault.
- `tests/integration/vault-path-aliases.test.ts` — both spellings over HTTP: a
  vault created at the published path read back at both, identical list payloads,
  a credential created at one spelling and read at the other with the secret still
  masked, archive hiding the vault from both lists and 404ing on both, every local
  management route reachable at the published prefix, and the published prefix
  admitted under the managed-agents beta and refused without it.
- `tests/unit/vault-path-parity.test.ts` — the mounted route table gives every
  canonical vault route a published twin and every published route a canonical
  one, with anchors so the comparison cannot pass by finding nothing.
- `tests/integration/vault-list-include-archived.test.ts` — the published listing
  parameter: archived excluded by default and included on request with the
  archived label intact, `false` equal to omitting it, a malformed value and a
  repeated parameter each refused, both prefixes agreeing, and the archived vault
  still `404` on its own read.
- `tests/integration/collection-pagination.test.ts` — the published `limit`/`page`
  window on this listing and the memory-store listing together: the default page
  of 20, a walk that partitions the collection exactly once, `prev_page` returning
  the page it came from, the last full page ending the walk, a malformed or
  replayed cursor refused, the newest-first ordering measured against distinct
  timestamps, and the two mounts windowing identically.

## 7. Status

`supported` for the wire profile, write-only handling, locked fields, and
rotation. `partial` for injection execution: the sandbox environment path works
and is tested, but it exports the plaintext secret into the process and has no
egress substitution, and the delegated child path receives no vault. OAuth
refresh is `unavailable` and is recorded as such in the capability matrix rather
than presented as supported.
