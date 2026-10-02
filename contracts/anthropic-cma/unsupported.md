# CMA Contract — unsupported and out-of-scope

Contract area: behaviour SandBase does not implement.
Status: mixed by entry; see the table in §2.
Source: `src/core/capabilities/matrix.ts`, `src/api/capability-errors.ts`,
`src/core/capabilities/registry.ts`, `src/api/routes/unsupported-official.ts`.

<!-- capability-status
dreams: unavailable
web-search-execution: unavailable
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
| Dreams | `unavailable` | A memory-consolidation pipeline (read memory stores and historical sessions, produce reorganized stores). Not implemented in this phase; official SDK routes explicitly refuse it with HTTP 400 `unsupported_capability`. |
| MCP tunnel | `not_applicable` | Not implemented; a hosted connectivity feature outside local-first scope. Official SDK tunnel, certificate, and token routes explicitly refuse it. |
| Hosted user profiles | `not_applicable` | Hosted user management is outside the single-tenant scope; official SDK profile routes explicitly refuse it. |
| Hosted environment Work API | `not_applicable` | Not the local worker queue API; official SDK Work routes explicitly refuse it without changing `/work-items` or worker endpoints. |
| `web_search` execution | `unavailable` | Configuration is accepted and validated, but no search provider is bundled and engine HTML scraping is not an accepted substitute, so a request enabling `web_search` fails before the session is persisted. `web_fetch` is a separate capability and does execute; see [`tools.md`](./tools.md). |
| OAuth refresh | `unavailable` | Not implemented and not scheduled: no refresh loop or refresh-failure event exists. The official MCP OAuth validation endpoint explicitly refuses the capability. A supplied refresh block is parsed, stored, and answered with an explicit warning that it will not be executed. |
| Session budget alerts | `not_applicable` | Not implemented; notifiability is a hosted billing feature with no local analogue. |

Session budget is implemented and has its own file, [`budget.md`](./budget.md).
Threads, the coordinator, the advisor, and the canonical `multiagent` roster are
**not** implemented either; they have their own file,
[`threads.md`](./threads.md), which records the gap and the refusal that keeps a
caller from assuming otherwise.

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
| Dreams | `unavailable`, not `not_applicable`: a workspace-scoped pipeline over archived sessions and memory stores belongs in a local-first runtime. What is missing is a scheduled background worker and the archived-session corpora, and this phase does not build them. |
| Failure envelope | `unsupported_capability` with `details.capabilities` is a SandBase error shape. The published contract requires the refusal, not this envelope. |
| Planned vs. unavailable | Nothing in this file is `planned` any more. `web_search` execution and OAuth refresh are both `unavailable`: neither has a safe local design, so marking either `planned` would imply an implementation is coming. |
| Coverage moved out of this file | Session budget was implemented, so it now has its own contract file. Threads, coordinator, and advisor were never implemented and also have their own file, so this file does not have to speak for a surface it cannot describe. |

## 5. Reason for the difference

- `not_applicable` entries are decisions, not gaps. Recording them in the matrix
  prevents them from being counted as missing work in a coverage report, which
  is the failure mode a single "done / not done" flag produces.
- Dreams is `unavailable` rather than `not_applicable` because the earlier
  "cloud scheduling" label was wrong: the feature is a local consolidation
  pipeline, so the honest record is "we have not built it", not "it does not
  apply here".
- `web_search` execution is `unavailable` rather than `planned` because there is
  no safe local design to plan: a search provider is a third-party service.
  Marking it `planned` would imply a local implementation is coming. `web_fetch`
  is not in this category — it executes, with the limits recorded in
  `tools.md`.
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

Mixed, per the table in §2. Two entries are `not_applicable` by design, two are
`unavailable`, and one of those two — Dreams — moved here from
`not_applicable` once its reason was corrected. Every one is recorded in the
capability matrix with its reason rather than being omitted. The entry that used
to be here and is no longer is session budget, which has its own contract file
because it was implemented. Threads, the coordinator, and the advisor stayed
out: they are `unavailable`, not `partial`, and they too have their own file
rather than a paragraph in this one.
