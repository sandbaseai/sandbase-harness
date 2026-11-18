# CMA Contract — errors

Contract area: error envelope and error codes.
Status: `supported` — with the code-string caveat in §4.
Source: `src/api/routes/resource-utils.ts`, `src/api/cma-admission.ts`,
`src/api/capability-errors.ts`.

<!-- capability-status
structured-error-envelope: supported
-->

---

## 1. Official definition

- A rejected request returns a structured error object rather than a bare
  string, so a client can branch on the failure kind without parsing prose.
- The published contract groups failures by category: the request was invalid,
  the resource was absent, or the request conflicts with current state.

## 2. Current SandBase shape

The envelope helpers are `src/api/routes/resource-utils.ts`; admission failures
are raised by `src/api/cma-admission.ts` and capability refusals by
`src/api/capability-errors.ts`.

Errors are produced by shared helpers so every route answers in one shape:

| Helper | HTTP | `error.type` | Extra |
| --- | --- | --- | --- |
| `invalid(c, message, code?)` | 400 | `invalid_request_error` | optional stable `code` |
| `conflict(c, message, code?)` | 409 | `conflict` | optional stable `code` |
| `notFound(c, message)` | 404 | `not_found` | — |
| `unsupportedCapability(c, error)` | 400 | `unsupported_capability` | `details.capabilities: [{id, reason}]` |

One category, one wire value. The 400 type above is emitted from the shared
helper, from `operation-helpers.ts`'s twin of it, and from the remaining
hand-written envelopes in individual route modules — so the spelling is a
single decision applied everywhere rather than a per-family choice.

There is exactly one place where the wire type is not a literal: the session
resource routes, whose core layer (`src/core/session/session-resources.ts`)
returns a local `code` that also selects the HTTP status. That code vocabulary is
internal and stays as it is; the route translates it through an explicit
`WIRE_ERROR_TYPE` map before answering. The two were the same string, so
canonicalising only the route literals would have left three paths emitting the
legacy value — the kind of gap a value-by-value grep does not reveal.

The same `notFound` envelope answers a path this server does not serve. It is
registered as the server's fallback in `src/api/server.ts`, so an unrouted
request gets `application/json` and `error.type: "not_found"` rather than the
framework's `text/plain` body. Its message is `No route matches this request`,
which is deliberately a fixed sentence: it does not echo the requested path, and
it stays distinguishable from a route's own missing-resource message. Because
authentication, throttling, and compatibility admission are mounted before
routing, an unmatched `/v1/*` path still answers `401`, `429`, or an admission
`400` before the fallback can run.

A query parameter the route does not implement is refused the same way, by
`src/api/routes/query-params.ts`: `400 invalid_request_error`, naming the
parameter and listing the ones the route does accept. The urgency is that the
alternative is not a lesser answer but a **wrong** one — a silently dropped
filter returns `200` with an unscoped list, which looks exactly like a scoped
list that happens to contain more than the caller expected. This is the rule
`agents.md` §2 already states for request fields (`Unknown keys and unsupported
field values are rejected, not silently discarded`) applied to the query string,
which had no equivalent.

Two properties of the mechanism are deliberate:

- **The allow-list is passed by the handler that reads the parameters**, not held
  in a table in the admission module. A central route-to-parameters table would
  be a second description of the same fact and the kind that drifts; the handler
  is the only thing positioned to keep it true.
- **The refusal runs before resource lookup.** A request is judged malformed
  before any state is read, so a request that is wrong in both ways reports the
  malformation rather than a `404` that would imply the parameter was understood.
  Validation precedes reading state, the order admission middleware already uses.

`beta` is accepted on every route and **ignored**. It is not a parameter this
runtime implements: 36 published examples put it on the URL rather than in a
header, so refusing it would make this runtime unreachable from a client built
against the published documentation. It is deliberately absent from the message's
"accepts" list, because that list names implemented parameters and accepting
`beta` must not be read as honouring it.

Routes that read no query parameters were **not** covered at first: refusing every
parameter on a handler that declares none is the same principle but a different
mechanism, and the class was recorded as outstanding rather than assumed. One route
of it is now covered — `GET /v1/sessions/{id}/artifacts` reads no parameter and
refuses every one by name — which was safe only after measuring that the published
documentation never names that listing (no occurrence of `artifacts` in the docs
tree) and that no caller in this repository sends it a parameter. The rest of the
class remains outstanding. The case where the gap had teeth is closed too:
`GET /v1/files` now reads the published `scope_id` — so it is covered by the
refusal above — and the parameter selects the session's files rather than being
silently ignored. See [`files.md`](./files.md) §2.

Admission failures add a stable code from `CMA_ADMISSION_CODES`:

| Code | Condition |
| --- | --- |
| `missing_anthropic_version` | compatibility caller omitted the version header |
| `unsupported_anthropic_version` | version present, not `2026-10-21` or `2023-06-01` |
| `missing_anthropic_beta` | compatibility caller omitted the beta header |
| `malformed_anthropic_beta` | beta is not comma-separated identifiers |
| `unsupported_anthropic_beta` | beta does not match the resource family |
| `conflicting_memory_store_beta` | both memory betas on a memory-store path |

Memory preconditions add `precondition_failed` on a 409, carrying the current
content hash so the caller can retry against the real state.

A rejected capability carries the specific capability ids and their reasons, so
the caller learns which request field to remove rather than receiving a generic
"unsupported".

## 3. Alignment

Aligned for: structured envelope, category separation (invalid / conflict /
missing), a machine-readable code where a client must branch, an error that
names the exact offending capability, field, or precondition, and an error that
names the query parameter it refused rather than ignoring it.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Code strings | SandBase `code` values are local and stable. The published contract documents error categories, not SandBase's code vocabulary; no code string here is claimed to be an upstream value. |
| Code inventory | The local code values are pinned by `tests/unit/error-code-inventory.test.ts` against `tests/fixtures/error-codes.json`, which lists every code the scan finds in `src`. Renaming or adding one therefore fails the suite until the fixture is updated deliberately. The scan models two shapes only (`code: '<literal>'` and `_CODE = '<literal>'`), so a code built another way is invisible to it, and broadening the model is the correct response to a miss. |
| Where a code is raised | The same test also pins the module each code is raised from, against `tests/fixtures/error-code-modules.json` (`tests/unit/error-code-module-attribution.test.ts`). A code that moves between modules, or gains a second emitter, fails the suite, so following a code from the contract into the source stays truthful. The two fixtures are asserted to describe the same set of codes, so neither can be regenerated without the other being noticed. |
| Coverage of the codes | `tests/unit/error-code-coverage.test.ts` pins which test files mention each code, against `tests/fixtures/error-code-coverage.json`. Measured, **Every one of the 58 codes is now mentioned by a test** . Those are a **recorded gap, not a passing grade**: the fixture keeps the number visible and the test fails if a code silently gains or loses its only assertion. Coverage here means literal presence in the test tree, not execution. The two codes that left this list (`pi_policy_mismatch`, `outcome_rubric_file_not_found`) were never unasserted in behaviour — every reference to them went through the imported constant, so the tests moved with the value and the published string was pinned nowhere. `tests/unit/unpinned-wire-codes.test.ts` now pins both strings by value, which is what the coverage model counts. |
| `invalid_request` as a wire type | Superseded: the canonical spelling is `invalid_request_error`, and every route emits it. `invalid_request` remains a **valid alias** for the same category — a client that branches on `error.type` may treat the two as equal — until the official SDK conformance suite passes against the canonical value, at which point the alias is retired. The value was never an upstream one; the published pages that name this category use `invalid_request_error`. |
| Unknown query parameters | Refused by name, on the routes that read query parameters. The published contract does not state what an unrecognized parameter should do, so this is a local extension of the field rule in `agents.md` §2 rather than a published requirement — but the alternative is a silently unscoped answer, which is a wrong answer rather than a difference in strictness. |
| `beta` as a query parameter | Accepted everywhere and ignored, because 36 published examples send it on the URL. Accepted is not implemented: the compatibility semantics are not modelled. |
| Routes that read no query parameters | Partly covered. `GET /v1/sessions/{id}/artifacts` reads no parameter and refuses every one by name; that was safe only because the published documentation never names that listing (`artifacts` occurs zero times in the docs tree) and no caller here sends it a parameter. `GET /v1/files` now reads the published `scope_id`, so it is covered by the refusal above. The remaining routes of this class read no parameters and no published example gives them one: recorded as outstanding rather than silently included in the claim above. |
| HTTP status mapping | SandBase maps a memory content-hash mismatch to 409 `precondition_failed`. The published contract states the precondition concept but not this exact status pairing. |
| Extensions | `unsupported_capability` and `precondition_failed` are SandBase codes covering local runtime facts. |

### When the unwitnessed codes happen

All 58 codes are asserted by tests, so the tests are their documentation. Nothing is left to record here; the file is kept because the conditions test and the fixture that produced it still describe how the set was closed. **The module and line are checked by `tests/unit/error-code-conditions.test.ts`; the sentences are not machine-checked** — they are readings of the emitter, so treat a wrong sentence as a documentation bug rather than a broken invariant.


## 5. Reason for the difference

- The invalid-request spelling was unified because the two values were in use at
  once, so a client branching on `error.type` had to know which route family it
  was talking to in order to compare one category. The alias is time-limited
  rather than permanent: a permanent second spelling would be a second contract.
- Local code strings exist because a client that retries needs to distinguish a
  fixable request bug from a state conflict. Collapsing every 400 into one
  opaque body would make correct retry logic impossible, which the admission
  module records as its own rationale.
- 409 for a failed precondition reflects that the request was well-formed but
  the stored state moved. 400 would imply the caller's request was malformed,
  which it was not.

## 6. Corresponding tests

- `tests/integration/api.test.ts` — rejection cases assert `error.type` and the
  presence of a stable code; resource lifecycle cases assert 404 vs 409.
- `tests/integration/unrouted-path-404.test.ts` — an unrouted path in the
  managed-agents, extension, and non-`/v1` namespaces, and an unmounted verb on a
  mounted path, each answer the JSON `not_found` envelope; a missing resource
  keeps its own message; the Console surface keeps its status codes; and
  authentication still precedes routing.
- `tests/unit/memory-semantics.test.ts` — precondition evaluation returns
  `precondition_failed` with the current hash.
- `tests/integration/invalid-request-spelling.test.ts` — a rejection from each
  route family that can answer 400, including the session resource path whose
  type comes from the core `code`, all report `invalid_request_error`; and a
  source scan asserts no route module emits the legacy literal as a wire type,
  so the canonical spelling cannot drift back one envelope at a time.
- `tests/integration/query-param-admission.test.ts` — every handler that reads a
  query parameter is driven with one it does not implement, and each case asserts
  the refusal, the advertised list, and that `beta` is accepted without being
  advertised; the Console's and the SDK's own parameters are pinned as still
  accepted, and one case pins the ordering rule by sending a bad parameter with a
  session that does not exist.
- `tests/integration/session-artifacts-query-admission.test.ts` — a route that
  reads no parameter: an unimplemented parameter is refused by name with no
  envelope in the body, several unimplemented parameters are all named, `beta` is
  still accepted without being advertised, a bare request still lists the
  artifacts, and the refusal precedes the session lookup in both directions.
- `tests/integration/files-scope-id.test.ts` — the one route whose published
  parameter was being ignored: the scope filters (in both directions), an unknown
  scope is an empty page rather than the global list, and an unimplemented
  parameter on that route is refused by name.

## 7. Status

`supported` — the envelope and category separation are enforced and tested. The
specific code strings are a documented local projection, not an upstream claim.
Query-parameter refusal covers the routes that read query parameters, and one route
that reads none — the artifacts listing, which refuses every parameter by name. The
rest of that class is recorded in §4 as outstanding.
