# CMA Contract — headers and admission

Contract area: request admission for `/v1` canonical endpoints.
Status: `partial` — one documented deviation, see §4.
Source: Claude Managed Agents public documentation (`anthropic-version`,
`anthropic-beta` compatibility headers) plus `src/api/cma-admission.ts`.

<!-- capability-status
compatibility-header-admission: partial
extension-namespace-exclusion: supported
-->

---

## 1. Official definition

- Ordinary Managed Agents requests carry both `anthropic-version: 2023-06-01`
  and `anthropic-beta: managed-agents-2026-04-01`.
- Memory store endpoints switch the beta to `agent-memory-2026-07-22`. The two
  beta values are mutually exclusive: a request carrying both is not a request
  in either surface.
- Event streaming, resource endpoints, and SDK requests follow the same
  admission rule as the collection endpoints they belong to.
- A missing or wrong compatibility header fails before the request reaches
  resource logic.

## 2. Current SandBase shape

`src/api/cma-admission.ts` implements the admission decision. Admission is
**opt-in by signal**: it only engages when the request carries at least one of
`x-api-key`, `anthropic-version`, or `anthropic-beta`. A request with none of
them is a local caller and falls back to the local API contract.

| Input | Decision |
| --- | --- |
| no `x-api-key`, no `anthropic-version`, no `anthropic-beta` | not a CMA request; local contract applies |
| any compatibility header present, `anthropic-version` missing | 400 `missing_anthropic_version` |
| `anthropic-version` present and not `2023-06-01` | 400 `unsupported_anthropic_version` |
| any compatibility header present, `anthropic-beta` missing | 400 `missing_anthropic_beta` |
| `anthropic-beta` not comma-separated non-empty identifiers | 400 `malformed_anthropic_beta` |
| both `managed-agents-2026-04-01` and `agent-memory-2026-07-22` on a memory-store path | 400 `conflicting_memory_store_beta` |
| memory-store path, beta lacks `agent-memory-2026-07-22` | 400 `unsupported_anthropic_beta` |
| `GET /v1/memory_stores/:id/memories`, beta is either recognized value | allowed (sole documented exception) |
| refused Dreams, tunnels, or user-profile path, beta is its native SDK beta or `managed-agents-2026-04-01` | admitted to an explicit `unsupported_capability` refusal |
| other canonical path, beta lacks `managed-agents-2026-04-01` | 400 `unsupported_anthropic_beta` |
| `/v1/x/*` | never enters CMA admission, not gated |

The local Console and first-party SDK send the canonical headers by default
rather than relying on the header-free local path.

The native betas recognized only for refused resource families are
`dreaming-2026-04-21` for `/v1/dreams`, `mcp-tunnels-2026-06-22` for
`/v1/tunnels`, and `user-profiles-2026-08-18` for `/v1/user_profiles`.
Version, missing/malformed beta, authentication, and rate-limit checks still
apply. No supported resource is admitted under one of these native betas.

## 3. Alignment

Aligned for: version value, recognized beta values, memory beta mutual
exclusion, the memory listing exception, and the `/v1/x` extension boundary.
The published contract requires the headers; SandBase additionally accepts a
request that omits them entirely, as described in §4.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Header-free local path | A request carrying none of the three compatibility headers is treated as a local caller and is not admission-checked. The published contract has no header-free path. This is a deliberate **local-first extension** and the reason `compatibility-header-admission` stays `partial`; a request that carries any compatibility header is still admitted by the published beta and version rules. |
| Error code naming | SandBase returns its own stable `code` values for each admission failure. The published contract documents the header requirement, not SandBase's code strings. |
| Admission trigger | SandBase engages admission on the presence of `x-api-key` alone, without requiring a beta header first. The published contract does not define this intermediate state. |

## 5. Reason for the difference

- The header-free local path exists because SandBase is self-hosted: requiring
  cloud beta headers for a local single-tenant runtime would be a naming ritual
  with no security value. It is documented as a local extension rather than
  presented as canonical.
- Error code strings are a local projection of the published failure
  categories. They are stable for local clients but are not claimed to be the
  upstream strings.
- Admission triggers on any compatibility header so a client that sends
  `x-api-key` and forgets the beta pair is told exactly which header is
  missing, rather than silently falling through to the local contract.

## 6. Corresponding tests

- `tests/integration/api.test.ts` — admission rejection cases and the memory
  beta mutual-exclusion case.
- `tests/unit/canonical-credential.test.ts` — credential-side shape rules that
  apply once admission has passed.
- `tests/conformance/official-route-coverage.test.ts` — unmodified SDK refusal
  calls, native-beta confinement, and version/beta validation before refusal.

## 7. Status

`partial` — the admission contract is enforced and tested; the local bearer
path and the local error-code strings are documented deviations rather than
upstream behaviour. The second entry this file carries,
`extension-namespace-exclusion`, is `supported`: `/v1/x/*` never enters CMA
admission at all (the last row of the table in §2), so a local extension cannot
be gated by a cloud beta header.
