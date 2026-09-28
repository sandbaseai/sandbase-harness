# CMA Contract — capabilities

Contract area: capability reporting and status truthfulness.
Status: `supported`.
Source: `src/core/capabilities/matrix.ts`,
`src/core/capabilities/registry.ts`, `src/api/routes/runtime.ts`.

<!-- capability-status
capability-inventory-endpoint: supported
capability-status-truthfulness: supported
-->

---

## 1. Official definition

- The published contract distinguishes implemented behaviour from behaviour that
  is not implemented. A caller must be able to tell what a given runtime will
  actually do before depending on it.
- A runtime that accepts a request it cannot honour is worse than one that
  refuses it.

## 2. Current SandBase shape

The matrix is `src/core/capabilities/matrix.ts`, the runtime tool inventory is
`src/core/capabilities/registry.ts`, and the route that serves both is
`src/api/routes/runtime.ts`.

Two complementary inventories are served from `GET /v1/x/capabilities`:

| Inventory | Answers | Shape |
| --- | --- | --- |
| Runtime tool inventory | "can this build execute the tool it accepted?" | `{id, kind, status: available \| unavailable, reason?}` |
| Contract matrix | "does this build implement each published behaviour, and if not, why not?" | `{area, id, status, reason, contract}[]` |

The six-value contract status enum:

| Status | Meaning |
| --- | --- |
| `supported` | implemented and exercised by a test |
| `partial` | implemented for a documented subset or with a documented deviation |
| `unavailable` | not implemented; a dependent request fails before persisting state |
| `planned` | not implemented and scheduled |
| `not_applicable` | deliberately out of scope for a local-first runtime |
| `unverified` | implemented but not confirmed against the published contract |

Properties the matrix enforces:

- Every non-`supported` entry carries a `reason`. A status without a reason
  would be a claim with no substance.
- Every entry names the contract document that carries its seven-section detail,
  so a status is traceable to prose and tests rather than standing alone.
- `capabilitySummary()` reports counts per status, so coverage is visible as a
  distribution rather than a single number. "Coverage" is not scored: a
  `not_applicable` entry is a decision, not a missing point.
- `capabilityMatrixJson()` is the single projection, so the endpoint and any
  published JSON cannot drift apart.
- `capabilityEntry(id)` throws on an unknown id, so a typo in a consumer fails
  loudly instead of silently finding nothing.

The truthfulness claim is enforced, not asserted. A guard test
(`tests/unit/contract-honesty.test.ts`) holds the matrix, the contract documents
under this directory, and the real mount graph to the same facts:

- every matrix entry's `contract` path exists and no `id` repeats;
- every contract file restates its entries' statuses in a machine-readable
  block, and the guard fails when the block and the matrix disagree in either
  direction;
- every source and test path a contract file cites in backticks exists;
- §2 is the evidence for an implementation claim: an entry that is not
  `unavailable` must name an existing source file there, and a `supported` entry
  must name an existing test in §6;
- a capability the composition root has to wire cannot be `supported` while
  nothing wires it, and cannot stay below `supported` once something does and no
  recorded blocker remains. When a wired capability is still `partial` for a
  reason outside the composition root — the container backends refusing the
  canonical mount roots and the mount path not reaching the agent's instructions,
  for the two session-resource entries — the reason and the canary that pins it
  are recorded beside the wiring symbol, and the guard fails if the status moves
  to `supported` while that canary still pins the gap;
- the routes listed in `routes.md` and the routes the server mounts are the same
  set of `method + path` pairs.

The guard is itself tested against deliberately broken fixtures — and against
copies of the real documents with a single character or verb changed — so the
check that catches a false claim cannot pass by finding nothing.

The runtime tool inventory remains separate because it answers a different
question: the matrix describes protocol coverage, while the inventory describes
what this particular build can execute. Both are returned so a client never has
to infer one from the other.

## 3. Alignment

Aligned for: reporting implemented vs. unimplemented behaviour, refusing a
request the runtime cannot honour, and keeping "not implemented" distinguishable
from "deliberately out of scope".

## 4. Differences

| Difference | Detail |
| --- | --- |
| Status vocabulary | The six-value enum is a SandBase design. The published contract requires the distinction, not this particular vocabulary. |
| Extension surface | The endpoint lives under `/v1/x/capabilities`, a local extension excluded from CMA admission. The published contract does not define a capability endpoint. |
| Unverified state | `unverified` is a SandBase addition covering behaviour that is implemented but not confirmed against upstream. |

## 5. Reason for the difference

- The six values exist because a boolean cannot express the difference between
  "we have not built this", "we chose not to build this", and "we built it but
  have not confirmed it matches". Collapsing those into two states is how a
  coverage report ends up overstating what works.
- `unverified` is deliberately not a soft `supported`. It exists so a claim that
  has not been checked against the published contract is not counted as done.
- Serving the endpoint under `/v1/x` keeps the extension namespace rule intact:
  a capability query is a local question about a local build.

## 6. Corresponding tests

- `tests/unit/capability-registry.test.ts` — runtime inventory and the
  unsupported-capability rejection path.
- `tests/unit/loop-engine-truthfulness.test.ts` — "no feature is reported as
  available when it cannot execute" cases across engines.
- `tests/integration/api.test.ts` — the HTTP response serves both inventories; the
  served matrix is checked for its entry count, an entry for every contract area, a
  `reason` on every non-`supported` entry, and a `contract` path that exists on disk.
- `tests/unit/contract-honesty.test.ts` — the guard described in §2: contract
  existence and unique ids, the status block against the matrix, cited source and
  test paths, implementation evidence for a claimed status, and the documented
  route set against `mountedRoutes()`. It also drives each check with input that
  must fail, so the guard's own teeth are covered.

## 7. Status

`supported` — both inventories are served, the six-value enum is enforced with a
required reason per entry, and the truthfulness claim is backed by a guard test
that compares the matrix, the contract documents, and the mounted route surface
rather than restating any one of them. The guard's failure modes are themselves
tested, so a renamed test file or a stale status block turns the suite red.
