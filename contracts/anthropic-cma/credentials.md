# CMA Contract — credentials and vaults

Contract area: `/v1/vaults` and vault credentials.
Status: `supported` for the wire profile, rotation, injection execution,
`mcp_oauth` token refresh, and `mcp_oauth_validate`.
Source: `src/core/credentials/canonical-credential.ts`,
`src/api/routes/credential-vaults.ts`, `src/core/credentials/policy.ts`,
`src/core/credentials/injection.ts`, `src/core/credentials/oauth-refresh.ts`,
`src/core/credentials/mcp-oauth-validate.ts`, `src/core/net/egress-proxy.ts`.

<!-- capability-status
canonical-credential-wire-profile: supported
credential-rotation: supported
credential-injection-execution: supported
oauth-refresh: supported
mcp-oauth-validation: supported
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
- A vault holds at most **20 active credentials** (`MAX_CREDENTIALS_PER_VAULT`):
  archived rows do not draw the bound down, so a vault that archived its way
  under the limit admits new credentials, and the 21st active credential is
  refused with `400` before it is persisted.
- `injection_location` is an optional object with `header` and `body` booleans,
  sibling to `networking`:
  - On create, **omitting it enables both positions**; supplying the object
    fills omitted fields with `false`.
  - An explicit `null` for the object or either field is an error; the field
    should be omitted instead.
  - At least one position must be enabled.
  - The response always returns both fields resolved.
- `mcp_oauth_validate` probes a credential against its declared MCP server:
  the `initialize` handshake runs with the stored token, an authorization
  rejection triggers the recorded refresh exchange, and the answer is a
  `vault_credential_validation` whose `status` is `valid`, `invalid`
  (authorization rejected and unrecovered — the caller should re-authorize),
  or `unknown` (transient failure — retry later), with `mcp_probe` and
  `refresh` diagnostic blocks.

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
  four characters) for display. For `mcp_oauth` that covers three secrets: the
  access token in `secret_*`, the refresh token in `refresh_token_*`, and the
  token-endpoint client secret in `client_secret_*`, each an encrypted triple
  of its own.
- `toCanonicalCredential` omits write-only fields entirely rather than masking
  them, because a mask could be mistaken for the real value. The `refresh`
  block is echoed without its secrets: `token_endpoint`, `client_id`, the
  `token_endpoint_auth` type, and `has_refresh_token` — a boolean, not the
  token.

OAuth refresh state and execution:

- `credential_records.oauth_state` (migration 058) is a non-secret JSON bag
  carrying the refresh configuration (`token_endpoint`, `client_id`,
  `token_endpoint_auth_type`), the access token's `expires_at`,
  `has_refresh_token`, and the last attempt's outcome (`last_refresh_at`,
  `last_refresh_status`, `last_refresh_error`) — the fields the API echoes and
  the Console renders.
- Refresh executes once per url-transport MCP connect, inside
  `resolveHeaders` before the injection bundle is built
  (`src/core/credentials/oauth-refresh.ts`): credentials matching the declared
  `mcp_server_url` whose `expires_at` is due are POSTed to their
  `token_endpoint`, and the response's `access_token`, `expires_in`/
  `expires_at`, and rotated `refresh_token` are re-encrypted in place. The
  connect then resolves the fresh token through the ordinary decrypt path —
  nothing downstream can tell a refresh happened, and no token material
  crosses the sandbox, model, or event boundary.
- A refresh is skipped, not failed, when the credential declares no
  `expires_at` (nothing says it is due), no `token_endpoint`, or no refresh
  token — the create/update warnings name which piece is missing. A failed
  refresh leaves the stored token in place, stamps the state on the row,
  writes a `refresh_failed` audit event, and publishes
  `vault_credential.refresh_failed`; the dedup window on `last_refresh_at`
  (60 seconds) keeps concurrent sessions and reconnect storms from repeating
  the attempt.

Validation:

- `POST /v1/vaults/{id}/credentials/{credential_id}/mcp_oauth_validate`
  (and the same path under `/v1/credential-vaults`) runs the published
  `vault_credential_validation` probe
  (`src/core/credentials/mcp-oauth-validate.ts`): the credential's network
  policy is checked before anything is decrypted, the stored access token is
  decrypted only in memory, and a real `initialize` handshake is attempted
  against the declared `mcp_server_url` through the same
  `SSEClientTransport` path a session connect uses — with the probe's fetch
  wrapped so a failed HTTP exchange is captured as `mcp_probe.http_response`
  (`status_code`, `content_type`, a body truncated past ~4 KB, token material
  scrubbed to `••••`).
- A completed handshake is `valid`. An HTTP 401 is the recovery path: when
  the credential carries a refresh configuration the same exchange the
  injection boundary runs is attempted once — deliberately **without**
  consulting the 60-second dedup window, because operator-initiated
  diagnosis must report a refresh that actually ran — and a success is
  re-probed once with the persisted token. The outcome is reported in
  `refresh` (`succeeded`, `no_refresh_token`, `failed`, or `connect_error`)
  with its own `http_response` capture on a failed exchange. A 4xx refresh
  rejection is `invalid`, `no_refresh_token` after a 401 is `invalid`, and
  transport failure, a 5xx/429 probe or refresh response, a malformed
  handshake, and any timeout are `unknown` — transient is never reported as
  a rejection.
- The response carries `type`, `credential_id`, `vault_id`, `validated_at`,
  `has_refresh_token`, `status`, `mcp_probe`, and `refresh`, and appends a
  `validate` credential audit event recording the verdict. A missing or
  archived-vault credential is a `404`, a non-MCP-typed credential or an
  `mcp_oauth` row without `mcp_server_url` is a `400`, and a network policy
  that does not cover the server host is refused before any wire traffic —
  the probe is the one path where the secret touches the wire, and it follows
  the same rules the injection boundary does.

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
- On a backend that owns an egress boundary — `local` and `docker`, which run
  every session's outbound HTTP through the environment egress proxy —
  environment credentials are emitted as **placeholders**: the process receives
  `__cred_<credential_id>__`, the bundle's substitution table is registered on
  the sandbox's proxy (`SandboxInstance.configureEgressSubstitutions`), and the
  proxy replaces the token with the real value on the wire, in request headers,
  the request line, and the request body, only toward a host the credential's
  own `allowed_hosts` covers. `env` cannot print the secret because the secret
  never enters the process.
- Under that model a `limited` credential with no declared target host is
  admissible: what denied it under plaintext was the guarantee the secret could
  go anywhere, and the boundary supplies exactly that guarantee. A named host
  outside `allowed_hosts` is still refused.
- Substitution rides the proxy's plain-HTTP forward path; a CONNECT tunnel is
  opaque, so a placeholder sent inside an HTTPS request reaches the server
  literally — it fails closed rather than leaking, and HTTPS API use from
  inside the sandbox should be reached through a `static_bearer`/`mcp_oauth`
  credential on a url transport or through in-process injection.
- A backend with no egress boundary (`kubernetes`, `self-hosted`) cannot
  substitute, so its environment credentials are **refused**, not degraded to
  plaintext. The published contract does not support `environment_variable`
  on a self-hosted sandbox, and the only honorable local reading of that rule
  is that a caller with no substitution boundary has nothing that can honor
  the credential — plaintext in the process is the very exposure the
  placeholder model rules out. The refusal (`credential_backend_unsupported`,
  `runtime_denied`) lands before decryption, at the same point a network
  denial would.
- A shell command declares no target host, so only credentials the policy admits
  without one reach the environment. On a boundary-less backend none reach it
  at all — the environment credential is refused upstream — while on a backend
  with a boundary a `limited` credential is admitted scoped to its own
  `allowed_hosts`, as above.
- The same resolved `environment` starts a stdio MCP server the agent declares,
  and a vault value wins over the `env` the agent configured itself. A
  url-transport server is handed the credentials scoped to its own URL as request
  headers, on the initial SSE request and on every message POST — that transport
  runs inside the runtime process, so it presents real values rather than
  placeholders. Values an MCP tool returns are scrubbed the way a sandbox tool's
  return value is, and the resolver's bundle is cleared after each use so nothing
  outlives the call.
- A delegated sub-agent inherits exactly the parent session's `vault_ids`: the
  child's synthetic session row is never persisted, so the resolver takes the
  parent's list as an explicit override — a child can never reach a credential
  its parent does not reference — and its own freshly provisioned sandbox is
  the boundary its placeholders register on.
- Model requests are covered on the request side: the executor resolves the
  endpoint host the model configuration points at and hands the provider client
  the `request_header` credentials the policy admits for that host, so a
  credential scoped to the model API authenticates the completion call.
- The placeholder token is stable per credential, so a rotation re-resolution
  replaces the value behind it: a process spawned before the rotation still
  holds the token, and its next substituted request carries the new secret.

- A `github_repository.authorization_token` is a separate encrypted
  session-resource secret, matching the official CMA GitHub resource shape. It
  is not resolved from `vault_ids`; Vault credentials are used for MCP and
  environment-variable authentication. A future `credential_id` reference may
  be offered as a SandBase extension, but it must not replace the canonical
  resource field or make GitHub mounts depend on an unrelated Vault.

Vault and credential lifecycle:

- Vault create accepts `display_name` (the published `VaultCreateParams` field)
  or the local `name` spelling; a body carrying both is a `400`, and the vault
  object projects both `name` and `display_name` with the same value.
- `POST /v1/vaults/{vault_id}` is the published update verb (`VaultUpdateParams`).
  `display_name` (1–255 characters) replaces the name — the local `name` spelling
  is accepted as an alias, and a body carrying both is a `400`; `description`
  replaces with `null` clearing; `metadata` is a merge patch where a `null` or
  empty-string value deletes the key and omitted keys are preserved. An archived
  vault refuses the write with `409 vault_archived`; a missing one is `404`.
- `DELETE /v1/vaults/{vault_id}` physically removes the vault and every credential
  it holds and answers the published tombstone `{id, type: "vault_deleted"}`. A
  session references a vault through its `vault_ids` list: a **non-terminal**
  session blocks the delete with `409 vault_in_use` (a live session holds MCP
  transports built from the vault's credentials), while a terminal session keeps
  its `vault_ids` as history and does not block. An archived vault may be deleted
  — archival hides it, deletion removes it. Each credential gets a `delete` audit
  event before its row goes, and a `vault.deleted` plus per-credential
  `vault_credential.deleted` operation event is published after the transaction.
- `GET /v1/vaults/{vault_id}/credentials/{credential_id}` retrieves one
  credential. The projection carries the canonical `auth` object, the local
  fields, and `value_hint` — never the secret material, on this route or any
  other.
- `POST /v1/vaults/{vault_id}/credentials/{credential_id}` is the published
  credential update (`CredentialUpdateParams`). `display_name` (1–255
  characters) replaces the name with the local `name` spelling accepted as an
  alias, and `metadata` is the same merge patch the vault update runs. `auth`
  is a type-discriminated partial update: `auth.type` is immutable and must
  match the stored credential (`static_bearer` is the canonical spelling of a
  stored `bearer_token`), and a change to a locked structural field
  (`mcp_server_url`, `secret_name`, `token_endpoint`, `client_id`) is a `400`
  naming the field. `token` / `access_token` / `secret_value` are re-encrypted,
  rotate `value_hint`, write a `rotate` audit event, and rebuild the live MCP
  transports of sessions referencing the vault, exactly as the `rotate` route
  does. `injection_location` and `networking` replace wholesale, and
  `networking: null` clears the restriction to unrestricted. For `mcp_oauth`,
  `expires_at` and the `refresh` block persist into the credential's stored
  OAuth state — a `refresh.token_endpoint` or `refresh.client_id` that differs
  from the stored value is refused as the same locked-field `400` the top-level
  spellings produce, `token_endpoint_auth.type` and a new `client_secret` or
  `refresh_token` update in place, and `refresh: null` clears the refresh
  configuration so the token is used until replaced. A block that leaves the
  credential unrefreshable (no `token_endpoint`, or no refresh token) still
  answers a warning naming the missing piece.
- `DELETE /v1/vaults/{vault_id}/credentials/{credential_id}` is a physical
  delete that answers `{id, type: "vault_credential_deleted"}`; a second delete
  is `404`. The audit trail survives: the `delete` event and every earlier event
  stay readable at vault scope (`GET /v1/vaults/{vault_id}/audit`), and the
  audit table's foreign keys were dropped in migration 051 so the trail is not
  part of the deleted resource. Rows the old soft delete left with
  `status = 'deleted'` were already invisible to every listing and read and
  answer `404` here too.

## 3. Alignment

Aligned for: the nested `auth` profile, all three type shapes, MCP keying by
URL with normalization, write-only secret handling, locked structural fields,
the `injection_location` create rules and the both-fields-resolved read
projection, rotation that preserves identity and reconnects the MCP transports of
the sessions that reference the vault, the published `/v1/vaults*` paths, the
published vault update/delete and credential retrieve/update/delete verbs with
their `vault_in_use`/`vault_archived` refusals and tombstone envelopes, and the
session path that injects a
vault's environment into its own sandbox commands and into a stdio MCP server the
agent declares, attaches a `static_bearer` credential to the url-transport server
whose URL it was keyed to, and redacts what each of them returns. On backends
with an egress boundary the process never holds the secret: the placeholder the
environment carries materializes on the wire, scoped to the credential's own
`allowed_hosts`, and delegated children inherit the parent's vault scope against
their own boundary.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Credential exposure in the sandbox | Closed for backends with an egress boundary: the local and docker providers run a per-session egress proxy, and environment credentials enter processes only as `__cred_<id>__` placeholders the proxy replaces on the wire toward a host the credential's own `allowed_hosts` covers. One residual limit, recorded rather than hidden: substitution happens on the proxy's HTTP forward path only — a CONNECT tunnel is opaque, so a placeholder inside an HTTPS request is sent literally and fails closed. A backend with no boundary (`kubernetes`, `self-hosted`) is not an exposure case anymore: the published contract does not support `environment_variable` where nothing substitutes it, so the credential is refused (`credential_backend_unsupported`, `runtime_denied`) before decryption rather than materialized as plaintext. `vault_ids` on such a backend still means "export these secrets" only for the MCP-keyed types, which ride request headers the runtime itself presents. |
| OAuth refresh | Implemented for `mcp_oauth` at the injection boundary: when a url-transport MCP connect resolves its headers, a credential whose `expires_at` is past (minus a 30-second skew) is refreshed against its `token_endpoint` before the bundle is built — the transport only ever sees the resulting access token. Token-endpoint authentication follows `token_endpoint_auth.type` (`client_secret_basic` default, `client_secret_post`, `none`), a rotated `refresh_token` is persisted encrypted in place, and a response without one keeps the stored token. A failure stamps the row's `oauth_state` (`last_refresh_at`, status, a sanitized error — never token material), appends a `refresh_failed` audit event, publishes `vault_credential.refresh_failed`, and still lets the connect proceed with the stored value; a 60-second per-credential window deduplicates attempts so concurrent sessions and reconnect storms cannot hammer the endpoint. A credential with no `expires_at` or no refresh token is used until replaced — the runtime cannot know it is due, and the create/update response says so. `mcp_oauth_validate` reuses the same exchange: a 401 probe triggers one refresh attempt under the same audit/publish bookkeeping, deliberately ignoring the dedup window because a diagnostic must report a refresh that ran. |
| Legacy ingress | The flat `auth_type` spelling and the `injection_locations` token list are accepted for backward compatibility. The published contract defines neither. |
| Vault `type` | The published vault object carries `"type": "vault"` (`official-docs/vaults.md:140`); this runtime answers `"type": "credential_vault"`. The local value is the internal resource kind the Console and stored references already branch on, so renaming it to the published string would be a breaking wire change for every existing reader — recorded as a deliberate divergence rather than parity. The `vlt_` id, `display_name`, `metadata`, and timestamp fields are unchanged from the published shape. |
| Read projection | The canonical `auth` object is additive on read: it is returned beside the local `auth_type` / `name` / `variable_name` / `injection_locations` fields. The Console credential pages render and search on those local fields (`CredentialPages.tsx`, `CredentialVaultPages.tsx`) and `tests/integration/api.test.ts` asserts them, so dropping them is a Console migration rather than a wire change. |
| Local network policy | `networking` normalization uses the same shared normalizer the runtime policy uses, so a stored policy and an enforced policy cannot disagree. The published contract states the field and its meaning, not the normalization detail. |
| Audit | Rotations append a credential audit event. The published contract requires rotation semantics without fixing an audit shape. |
| Delegated execution | A delegated sub-agent inherits the parent session's `vault_ids` — passed as an explicit resolution override because the child's synthetic session row is never persisted — resolved under the same policy against the child's own provisioned boundary, so a child's injection scope can never exceed its parent's. The published contract does not describe sub-agent credential scope, so this is recorded as the local reading rather than presented as canonical. |
| Model requests | A model request carries the `request_header` credentials the credential policy admits for the resolved endpoint host, so a credential scoped to the model API authenticates the completion. The client lives in the runtime process, so it presents real values rather than placeholders; the body channel is not applied to model requests. |
| Local management routes answer at the published prefix too | `rotate`, `mark-used` and both `audit` routes are local extensions with no published equivalent, and they are reachable under `/v1/vaults*` as well as `/v1/credential-vaults*`. The alias is a mount, not a curated list, so a caller who learned the published spelling does not have to learn which routes answer at it. This is recorded rather than curated because curating would create exactly the per-route divergence the mount prevents. |

## 5. Reason for the difference

- Placeholder substitution is scoped to the proxy's HTTP forward path and to
  backends that own a boundary because those are the only places the runtime can
  truthfully materialize a value. A CONNECT tunnel is ciphertext from the
  proxy's seat — rewriting inside it would require terminating TLS, which a
  loopback boundary cannot honestly do. A provider without a proxy has no wire
  to substitute on, and the published contract does not support
  `environment_variable` on a self-hosted sandbox at all, so the credential is
  refused rather than degraded to a plaintext export the caller never asked for.
  Both residuals are stated plainly rather than folded into "supported",
  because pretending a boundary-less backend honors the credential would be the
  silent materialization this boundary exists to prevent.
- OAuth refresh runs at the injection boundary rather than on a timer because
  that is the only point the runtime knows a token is about to be presented: a
  background loop would refresh credentials no session is using, and refreshing
  at connect time means the header that ships is already the fresh one. The
  failure path is deliberately loud — audit row, stamped state, webhook — for
  the reason it was warned before it was implemented: a session silently
  presenting an expired token is a mystery, not an auth failure.
- A failed refresh leaves the stored token untouched and lets the connect
  proceed, because the endpoint's own 401 is a more honest signal than a
  withheld credential, and the stamped `oauth_state` is what the API and the
  Console report.
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
  the wire, the persisted `refresh`/`expires_at` echo with its warnings, the
  mixed-shape refusal, the legacy flat alias,
  the missing-field refusals, and that no response carries the secret.
- `tests/integration/credential-execution.test.ts` — the executor refuses the
  environment credential on a boundary-less sandbox (denial audited, no secret
  in the command environment), and a sandbox that owns an egress boundary
  receives `{env: {TOKEN: '__cred_crd_exec__'}}` while the boundary is handed
  the real value in its substitution table.
- `tests/unit/credential-injection-placeholders.test.ts` — the placeholder
  emission rules: the stable `__cred_<id>__` token, the `credential_backend_unsupported`
  refusal for a boundary-less caller, a `limited` credential admitted under
  placeholders with its own `allowed_hosts` scope, a named-but-uncovered host
  still denied, and the delegated-vault override resolving an unpersisted child
  to exactly the vault ids it is handed.
- `tests/unit/egress-proxy.test.ts` — the substitution half of the boundary:
  a placeholder materialized in a request header and a request body with its
  recomputed length, a scoped credential not materializing outside its
  `allowed_hosts`, the upsert that makes a rotation re-resolution update the
  value a live process's token resolves to, and substitution working in the
  allow-all mode a policy-less environment binds.
- `tests/unit/credential-policy.test.ts` — network policy normalization and
  the enforcement half: host-policy denial, the boundary-less environment
  refusal recorded as `credential_backend_unsupported`, bearer-token
  request-header injection, and the URL-keyed applicability rules.
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
- `tests/integration/vault-update-delete.test.ts` — the published lifecycle
  verbs: `display_name`/`metadata` patch semantics with a `null` key delete and
  omitted-field preservation, `vault_archived` on an archived update, the
  `vault_deleted` tombstone and physical removal of the vault and its
  credentials, `vault_in_use` only for a non-terminal session reference, a
  terminal session's `vault_ids` history not blocking, delete-on-archived
  allowed, credential retrieve carrying no secret material, the
  `vault_credential_deleted` tombstone and second-delete `404`, the audit trail
  surviving at vault scope, and both prefixes serving the same verbs.
- `tests/integration/vault-credential-update.test.ts` — the published update:
  `display_name`/`metadata` patch rules, `auth.type` immutability, locked
  structural fields, secret rotation re-encrypting and writing a `rotate`
  audit event, wholesale `injection_location`/`networking` replacement with
  `networking: null` clearing, `expires_at`/`refresh` persistence including the
  locked-endpoint refusal and the unrefreshable warnings, a null
  secret refused, and both prefixes.
- `tests/unit/credential-oauth-refresh.test.ts` — the refresh path itself: a
  due token refreshed against its endpoint with each `token_endpoint_auth`
  mode, a rotated `refresh_token` persisted, a response without one keeping
  the stored token, `expires_in`/`expires_at` projecting the new expiry, a
  not-due or unrefreshable credential skipped, a failure stamping the row,
  auditing `refresh_failed`, and publishing `vault_credential.refresh_failed`,
  the retry-window dedup, and the URL-keyed scoping.
- `tests/conformance/vault-credential-update.test.ts` — the pinned official
  SDK's `credentials.update()` against the live runtime: the partial update
  applies, no secret material is echoed, and a type mismatch is a 400.
- `tests/integration/collection-pagination.test.ts` — the published `limit`/`page`
  window on this listing and the memory-store listing together: the default page
  of 20, a walk that partitions the collection exactly once, `prev_page` returning
  the page it came from, the last full page ending the walk, a malformed or
  replayed cursor refused, the newest-first ordering measured against distinct
  timestamps, and the two mounts windowing identically.
- `tests/conformance/doc-curl-examples.test.ts` — the doc's vault-create body
  replayed verbatim through `?beta=true`: the published `vlt_` id,
  `display_name`, and `metadata` fields, and the `credential_vault` type the §4
  divergence row records.

## 7. Status

`supported` for the wire profile, write-only handling, locked fields,
rotation, injection execution — placeholder emission, egress
substitution, delegated vault inheritance, and model request headers, with
the CONNECT-opacity residual recorded in §4 and the boundary-less-backend
environment credential refused rather than materialized — and
`mcp_oauth` refresh: expiry-tracked tokens refreshed at the connect boundary,
rotated refresh tokens persisted, failures audited, stamped, and published.
`mcp_oauth_validate` is `supported` under both prefixes — a live
`initialize` probe with refresh recovery, reported as the published
`vault_credential_validation` — and a credential that never declared
`expires_at` is used until replaced, because nothing can know it is due.
