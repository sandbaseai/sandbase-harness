# CMA Contract — unsupported and out-of-scope

Contract area: behaviour SandBase does not implement.
Status: mixed by entry; see the table in §2.
Source: `src/core/capabilities/matrix.ts`, `src/api/capability-errors.ts`,
`src/core/capabilities/registry.ts`, `src/api/routes/unsupported-official.ts`.

<!-- capability-status
session-budget-alerts: not_applicable
mcp-tunnel: not_applicable
-->

---

## 1. Official definition

- The published contract defines several capabilities that a local-first,
  self-hosted runtime may not implement.
- A runtime must make an unsupported capability fail **before** it persists
  state or executes anything, so a caller does not end up with a partially
  applied request.

## 2. Current SandBase shape

| Capability | Status | Behaviour |
| --- | --- | --- |
| MCP tunnel | `not_applicable` | Not implemented; a hosted connectivity feature outside local-first scope. Official SDK tunnel, certificate, and token routes explicitly refuse it. |
| Hosted user profiles | `not_applicable` | Hosted user management is outside the single-tenant scope; official SDK profile routes explicitly refuse it. |
| MCP OAuth validation endpoint | `unavailable` | Token refresh runs at the MCP connect boundary (see [`credentials.md`](./credentials.md)); the dedicated `mcp_oauth_validate` endpoint is not implemented and explicitly refuses the capability. |
| Session budget alerts | `not_applicable` | Not implemented; notifiability is a hosted billing feature with no local analogue. |

Session budget is implemented and has its own file, [`budget.md`](./budget.md).
Dreams are implemented too — a session-backed memory-consolidation job — and
have their own file, [`dreams.md`](./dreams.md).
Threads, the coordinator, the advisor, and the canonical `multiagent` roster are
**not** implemented either; they have their own file,
[`threads.md`](./threads.md), which records the gap and the refusal that keeps a
caller from assuming otherwise. The five published thread routes are mounted
`unsupported_capability` refusals, so the SDK's `sessions.threads` methods get a
decodable 400 rather than a 404.

Failure mechanism:

- `unsupportedOfficialRoutes` registers only the known official methods and
  paths, returning HTTP 400 `unsupported_capability` with a static capability id,
  reason, and `docs/api-matrix.md#unsupported-official-routes` reference. It runs
  after authentication, rate limiting, and compatibility admission, never
  reading a submitted body or executing a resource operation.

- `RuntimeCapabilityRegistry.getUnavailableCapabilities` collects every
  unavailable tool an agent requests.
- `assertAgentSupported` throws `UnsupportedCapabilityError` when the list is
  non-empty.
- The API projects that error as 400 `unsupported_capability`, carrying the
  offending ids and reasons in `details.capabilities`.
- The check runs before a session is created, so a rejected request leaves no
  session, event, or resource behind.

## 3. Alignment

Aligned for: failing before persistence or execution, naming the exact
unsupported capability and its reason, and separating "not implemented" from
"deliberately out of scope".

## 4. Differences

| Difference | Detail |
| --- | --- |
| Scope decisions | MCP tunnel and session-budget alerts are `not_applicable`: SandBase is local-first and single-tenant, so a hosted connectivity or billing-notification feature has no local analogue. The published contract describes them as available capabilities. |
| Failure envelope | `unsupported_capability` with `details.capabilities` is a SandBase error shape. The published contract requires the refusal, not this envelope. |
| Planned vs. unavailable | Nothing in this file is `planned` any more. `web_search` execution moved out of this file once a provider-backed adapter shipped, and dreams moved out when the session-backed pipeline shipped; OAuth refresh remains `unavailable`: it has no safe local design, so marking it `planned` would imply an implementation is coming. |
| Coverage moved out of this file | Session budget was implemented, so it now has its own contract file. Threads, coordinator, and advisor were never implemented and also have their own file, so this file does not have to speak for a surface it cannot describe. |

## 5. Reason for the difference

- `not_applicable` entries are decisions, not gaps. Recording them in the matrix
  prevents them from being counted as missing work in a coverage report, which
  is the failure mode a single "done / not done" flag produces.
- Dreams used to sit here as `unavailable`: the earlier "cloud scheduling"
  label was wrong — the feature is a local consolidation pipeline — and once
  that pipeline shipped the entry moved to
  [`dreams.md`](./dreams.md).
- `web_search` execution used to sit here: no adapter existed, and marking it
  `planned` would have implied one was coming. A provider-backed implementation
  now ships, so the entry moved to [`tools.md`](./tools.md) — an unconfigured
  runtime still refuses the tool, but through capability admission, which is
  execution configuration rather than an unsupported surface.
- Every rejection names the specific capability, so a caller removes one field
  rather than guessing which of several declarations was refused.

## 6. Corresponding tests

- `tests/unit/capability-registry.test.ts` — the unavailable-tool collection and
  the `UnsupportedCapabilityError` path.
- `tests/integration/api.test.ts` — a request enabling an unavailable tool is
  rejected and no session is created.
- `tests/unit/loop-engine-truthfulness.test.ts` — no capability is reported as
  available when it cannot execute.
- `tests/integration/agent-roster-refusal.test.ts` — the related refusal this
  file's threads gap depends on: a canonical `multiagent` roster is rejected by
  name before anything is persisted.

## 7. Status

Mixed, per the table in §2. Two entries are `not_applicable` by design and the
rest are `unavailable`. Every one is recorded in the capability matrix with its
reason rather than being omitted. Three entries that used to be here are no
longer: session budget, `web_search` execution, and dreams each have their own
coverage because they were implemented. Threads, the coordinator, and the
advisor stayed out: they are `unavailable`, not `partial`, and they too have
their own file rather than a paragraph in this one.
