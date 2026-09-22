# CMA Contract — unsupported and out-of-scope

Contract area: behaviour SandBase does not implement.
Status: mixed by entry; see the table in §2.
Source: `src/core/capabilities/matrix.ts`, `src/api/capabilities-errors.ts`,
`src/core/capabilities/registry.ts`.

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
| Dreams | `not_applicable` | Not implemented, not scheduled. No field is accepted or stored. |
| MCP tunnel | `not_applicable` | Not implemented; a hosted connectivity feature outside local-first scope. |
| Web tool execution | `unavailable` | Configuration is accepted and validated; execution has no safe local implementation. A request enabling one fails before the session is persisted. |
| OAuth refresh | `unavailable` | Not implemented and not scheduled: no refresh loop, refresh-failure event, or validate endpoint exists. A supplied refresh block is parsed, stored, and answered with an explicit warning that it will not be executed. |
| Session budget alerts | `not_applicable` | Not implemented; notifiability is a hosted billing feature with no local analogue. |

Session budget and threads / coordinator / advisor moved out of this file once
they were implemented: see [`budget.md`](./budget.md) and
[`threads.md`](./threads.md). Both are `partial`, and this file no longer speaks
for them.

Failure mechanism:

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
| Scope decisions | Dreams, MCP tunnel, and session-budget alerts are `not_applicable`: SandBase is local-first and single-tenant, so a hosted scheduling, connectivity, or billing-notification feature has no local analogue. The published contract describes them as available capabilities. |
| Failure envelope | `unsupported_capability` with `details.capabilities` is a SandBase error shape. The published contract requires the refusal, not this envelope. |
| Planned vs. unavailable | Nothing in this file is `planned` any more. Web tool execution and OAuth refresh are both `unavailable`: neither has a safe local design, so marking either `planned` would imply an implementation is coming. |
| Coverage moved out of this file | Session budget and threads / coordinator / advisor were implemented, so they now have their own contract files. Keeping them here would have left this file describing them as absent. |

## 5. Reason for the difference

- `not_applicable` entries are decisions, not gaps. Recording them in the matrix
  prevents them from being counted as missing work in a coverage report, which
  is the failure mode a single "done / not done" flag produces.
- Web tool execution is `unavailable` rather than `planned` because there is no
  safe implementation: fetching arbitrary URLs from the host would expose the
  runtime's own network position, which is what a sandbox exists to prevent.
  Marking it `planned` would imply a local implementation is coming.
- Every rejection names the specific capability, so a caller removes one field
  rather than guessing which of several declarations was refused.

## 6. Corresponding tests

- `tests/unit/capability-registry.test.ts` — the unavailable-tool collection and
  the `UnsupportedCapabilityError` path.
- `tests/integration/api.test.ts` — a request enabling an unavailable tool is
  rejected and no session is created.
- `tests/unit/loop-engine-truthfulness.test.ts` — no capability is reported as
  available when it cannot execute.

## 7. Status

Mixed, per the table in §2. Three entries are `not_applicable` by design and two
are `unavailable`. Every one is recorded in the capability matrix with its reason
rather than being omitted. The two entries that used to be here and are no longer
have their own contract files rather than being withdrawn: threads / coordinator /
advisor is `partial`, and session budget is `planned`, because its design is
published while nothing implements it. This file's subject is behaviour that is
absent, and neither of them is.
