# SandBase Harness — Claude Managed Agents contract

This directory records how SandBase Harness implements the Claude Managed
Agents (CMA) public contract: what matches, what deviates, and why.

## Scope

Two contract layers, kept strictly separate:

| Layer | Surface | Rule |
| --- | --- | --- |
| CMA canonical contract | `/v1/agents`, `/v1/sessions` (including `initial_events`), `/v1/sessions/:id/events(+stream)`, `/v1/files`, `/v1/memory_stores`, `/v1/vaults` | Follow the published definition. Types and semantics do not bend to fit the local implementation. |
| SandBase local extensions | `/v1/x/*`, local / Docker / Kubernetes / self-hosted sandboxes, SQLite memory, local workers | Free to differ, but must stay in the extension namespace and must not share a type or semantic with the canonical layer. |

`/v1/x/*` is deliberately excluded from CMA request admission, so a local
extension cannot be gated by a cloud beta header.

## File format

Every contract file uses the same seven sections:

1. **Official definition** — what the published contract says.
2. **Current SandBase shape** — what this runtime actually does, with file and
   symbol references.
3. **Alignment** — what matches.
4. **Differences** — what does not match, stated plainly.
5. **Reason for the difference** — why, so a future reader can judge whether the
   reason still holds.
6. **Corresponding tests** — the tests that exercise the behaviour.
7. **Status** — the capability status for this area.

A difference with no reason is an unfinished contract, not a documented
deviation. If the reason stops being true, the difference should be removed.

## Files

| File | Covers |
| --- | --- |
| [`headers.md`](./headers.md) | Compatibility header admission |
| [`pagination.md`](./pagination.md) | Collection envelopes and cursors |
| [`errors.md`](./errors.md) | Error envelope and error codes |
| [`agents.md`](./agents.md) | Agent definitions, model profile, toolsets |
| [`sessions.md`](./sessions.md) | Session lifecycle, status, initial events |
| [`budget.md`](./budget.md) | Session budget, local cost profile, usage and pause semantics |
| [`threads.md`](./threads.md) | Session threads, multi-agent roster, thread lifecycle and archive |
| [`events.md`](./events.md) | Event log, ordering, `processed_at`, `session.error` |
| [`streaming.md`](./streaming.md) | SSE delivery, resume, delta previews |
| [`tools.md`](./tools.md) | Built-in tools, web domain policy, output overflow |
| [`custom-tools.md`](./custom-tools.md) | Caller-executed tool declarations |
| [`system-message.md`](./system-message.md) | The `system.message` event domain |
| [`memory-stores.md`](./memory-stores.md) | Memory stores, scoping, limits, versions |
| [`files.md`](./files.md) | Files and file session resources |
| [`credentials.md`](./credentials.md) | Vaults, credential wire profile, rotation |
| [`github-repository.md`](./github-repository.md) | Cloning, mounting, and skill discovery for the `github_repository` resource |
| [`operations.md`](./operations.md) | Webhook delivery behaviour and scheduled deployments (published contract), plus the local outcome evaluator |
| [`capabilities.md`](./capabilities.md) | Capability reporting and status truthfulness |
| [`routes.md`](./routes.md) | The mounted `/v1` route surface, method by path |
| [`unsupported.md`](./unsupported.md) | Behaviour not implemented, and why |

## Status vocabulary

The machine-readable matrix lives in
[`src/core/capabilities/matrix.ts`](../../src/core/capabilities/matrix.ts) and is
served by `GET /v1/x/capabilities`. Statuses:

| Status | Meaning |
| --- | --- |
| `supported` | Implemented and exercised by a test |
| `partial` | Implemented for a documented subset, or with a documented deviation |
| `unavailable` | Not implemented; a dependent request fails before persisting state |
| `planned` | Not implemented and scheduled |
| `not_applicable` | Deliberately out of scope for a local-first runtime |
| `unverified` | Implemented but not confirmed against the published contract |

Every non-`supported` entry carries a reason. `not_applicable` is a decision,
not a gap: it is recorded so a coverage report does not count it as missing
work, and `unverified` exists so an unchecked claim is not counted as done.

### Machine-readable status block

Each contract file restates the status of every matrix entry that cites it, in
one block placed after the file header:

```html
<!-- capability-status
agent-crud: supported
model-object-profile: partial
-->
```

The block is the document's half of the status contract, and
`tests/unit/contract-honesty.test.ts` fails when it and the matrix disagree in
either direction — an entry that cites this file but is absent from the block, a
block line naming an entry that does not cite this file, an unknown status word,
or a status that differs from the matrix. Prose in §7 explains the statuses; the
block is what the guard reads. When a status changes, change the matrix and the
block in the same commit.

Four more properties the same guard enforces, because prose alone does not:

- Every source and test path a contract file cites in backticks must exist. A
  cited test that was renamed or never written is how a coverage claim becomes
  fiction.
- §2 is the evidence for an implementation claim, and §6 for a tested one. An
  entry that is not `unavailable` must name an existing source file in §2, and a
  `supported` entry must name an existing test in §6. A path mentioned in some
  other section is a citation, not evidence, so a difference table cannot stand
  in for an implementation.
- A capability the composition root must wire cannot be `supported` while
  nothing wires it, and cannot stay below `supported` once something wires it and
  no recorded blocker remains. A wired capability whose remaining gap is outside
  the composition root stays `partial` with that reason and the canary pinning it
  recorded beside the wiring symbol: raising the status while the canary still
  pins the gap fails, and so does leaving the status behind once the canary is
  gone.
- The `routes.md` table and the routes the server actually mounts must be equal
  as `method + path` pairs. A route documented with the wrong verb fails as
  loudly as a route that is missing, which a URL-keyed check cannot see.

## Verification

Coverage is claimed only where a test exercises the published behaviour:

1. **Schema contract tests** — field names, types, required/optional, error
   paths, defaults, response shapes. One test file per contract area.
2. **Behaviour contract tests** — event ordering, `processed_at`, status
   transitions, approval flow, memory read/write, SSE replay, in the
   integration suite.
3. **Capability tests** — a `supported` entry must genuinely work; a `partial`
   entry must return its documented limitation; an `unavailable` entry must fail
   before persisting or executing; a `not_applicable` entry must not be exposed
   as if it worked.

An official CMA SDK may be used as a **test-time protocol oracle** at a pinned
version, to observe real response and event shapes. It is not a runtime or
release dependency, and it is not a compatibility promise that the official SDK
can drive SandBase. SandBase's own acceptance is raw HTTP contract tests.

Where a published detail is not documented — error code vocabularies, for
instance — the entry is marked `unverified` rather than guessed.

## Adding a contract file

1. Copy the seven-section structure. Do not skip a section; "no difference" is a
   valid §4.
2. Cite the real file and symbol implementing the behaviour, and the real test
   file covering it. Do not cite a test that does not exist.
3. Add an entry to
   [`matrix.ts`](../../src/core/capabilities/matrix.ts), including a `reason`
   for any non-`supported` status.
4. Add the machine-readable status block described above, with one line per
   entry that cites this file.
5. Add the file to the table above, and add its area to `CAPABILITY_AREAS` in
   `matrix.ts`.
6. Run `npx vitest run tests/unit/contract-honesty.test.ts`. It is the check
   that keeps the matrix, this directory, and the mounted routes describing the
   same build.
