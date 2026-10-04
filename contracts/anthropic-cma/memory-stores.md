# CMA Contract — memory stores

Contract area: `/v1/memory_stores` — stores, memories, scoping, limits,
preconditions, and versions.
Status: `supported`.
Source: `src/core/memory/semantics.ts`, `src/api/routes/memory-stores.ts`,
`src/core/db/migrations.ts`.

<!-- capability-status
memory-crud: supported
memory-limits-and-preconditions: supported
memory-version-audit: supported
memory-multi-mount: supported
-->

---

## 1. Official definition

- A memory store holds named memories. A session may mount one or more stores.
- `access` is `read_write` (default) or `read_only`.
- Listing memories supports `path_prefix` and `depth` scoping.
- Limits: one memory ≤ 100 kB, one store ≤ 10,000 memories, one session ≤ 8
  stores, `instructions` ≤ 4,096 characters.
- A write may assert a content precondition so a caller cannot overwrite content
  it did not read.
- Each write is auditable as a version.
- Store memory endpoints use the `agent-memory-2026-07-22` beta.

## 2. Current SandBase shape

Constants (`semantics.ts`):

| Limit | Value |
| --- | --- |
| `MAX_MEMORY_CONTENT_BYTES` | 102,400 (100 kB) |
| `MAX_MEMORIES_PER_STORE` | 10,000 |
| `MAX_MEMORY_STORES_PER_SESSION` | 8 |
| `MAX_MEMORY_INSTRUCTIONS_CHARS` | 4,096 |
| `DEFAULT_MEMORY_ACCESS` | `read_write` |

Scoping:

- The listing implements the published `include_archived` parameter
  (`管理智能体上下文/记忆存储.md:1206`): archived stores are excluded by default and
  returned when the parameter is `true`, each with `status: "archived"` and a
  non-null `archived_at`. `false` is accepted and means the default.
- A value that is neither is a `400` rather than a fall-back to the default, and
  so is sending the parameter twice with different values. The reading lives in
  `src/api/routes/query-params.ts` and is shared with the vault listing, which
  takes the same published parameter, so the two collections cannot come to
  accept different values for it.
- Including an archived store in a listing is not an un-archive: the
  single-resource read still answers `404` for an archived store and archiving
  remains terminal.
- The listing implements the published pagination rule — `limit` (default 20,
  maximum 100) with a `page` cursor (`管理智能体上下文/Dreams.md:575`; the same rule
  governs the vault listing) — through the shared reading in
  `src/api/routes/query-params.ts`. The response carries `prev_page`/`next_page`,
  which are the cursors a caller passes back as `page`.
- The cursor is opaque and carries the ordering **and** the `include_archived`
  view that produced the page. Replaying one under the other view, or against the
  other collection, is a `400` rather than an answer to a page that never existed
  for that query.
- A `limit` outside `1..100`, a non-integer, or a repeated value is a `400` naming
  the accepted range: a caller who asked for 500 rows and received 100 — or asked
  for `abc` and received the default — has been answered as though they asked for
  something else.
- The listing orders by `created_at DESC` with `rowid DESC` as a tie-break.
  `created_at` is `datetime('now')`, so stores created in the same second share a
  timestamp; a windowed listing needs a total order to slice, or a page boundary
  can repeat or drop a row.
- A query parameter the listing does not implement is a `400` naming the parameter
  and the parameters the route accepts (`include_archived`, `limit`, `page`), rather
  than a page answered as though the request had been understood. The admission list
  (`COLLECTION_LISTING_QUERY_PARAMS`) is shared with the vault listing, which reads
  the same three parameters, so the two collections cannot come to admit different
  ones. `beta` is accepted but deliberately not advertised.
- `path_prefix` must start **and** end with `/`. This is enforced rather than
  normalized, because `/notes` and `/notes/` match different sets and silently
  fixing one to the other would change which memories a caller sees.
- Matching is by path segment: `/notes/` matches `/notes/todo.md` and
  `/notes/archive/old.md`, and does **not** match `/notes-archive/todo.md`.
- `depth` accepts only `0` or `1`; any other value is a 400 rather than being
  coerced to a nearest legal value.

Store lifecycle:

- `POST /memory_stores/:id` is the published update verb and `PUT` is kept as
  the local alias; both run the same patch semantics. `name` is validated
  against the published bound (1–255 characters, no control characters) and
  names are not unique — the schema's original `UNIQUE` was lost in a table
  rebuild, recorded rather than re-imposed. `description` clears on `null` or
  an empty string; `metadata` merges key-by-key and deletes a key on `null` or
  `""`; omitted fields are preserved.
- `DELETE /memory_stores/:id` physically removes the store and cascades over
  `memory_records` and `memory_versions` in one transaction, answering
  `{id, type: "memory_store_deleted"}`. A store mounted by a **non-terminal**
  session — a `session_resource_instances` row of type `memory_store` naming
  the store — refuses with `409` `memory_store_in_use`; a terminal session's
  mount is history and does not block.
- An archived store is read-only: the store update and every memory write
  (create, update, delete) refuse with `409` `memory_store_archived` rather
  than the `404` a missing store gets, so "archived" and "absent" answer
  differently. The single-resource read keeps its `404` for an archived store;
  `include_archived` on the listing remains the read path for it.

Preconditions:

- A write may carry a `content_sha256` precondition. A mismatch returns 409
  `precondition_failed` with the current hash, so the caller can retry against
  the real state instead of guessing.
- The hash is computed over UTF-8 bytes, matching what `memoryContentBytes`
  measures for the size limit, so the two checks cannot disagree.

Multiple stores per session:

A session may attach up to `MAX_MEMORY_STORES_PER_SESSION` stores, each with its
own `mount_path`, `instructions`, and `access`. Three surfaces consume the same
resolution rather than each deriving their own view:

| Surface | What it reads |
| --- | --- |
| `ContextBuilder` | The prompt sections, one per attached store, using that store's `instructions` |
| Memory API | Reads and writes routed to the store whose `mount_path` prefixes the memory path |
| Sandbox file tools | The mount paths that must be protected under a `read_only` store |

`resolveMemoryBindings` (`src/core/memory/bindings.ts`) is the single source of
truth for that resolution. A surface that re-derived the bindings could disagree
about which store owns a path, and the disagreement would surface as a write
landing in the wrong store.

`read_only` is enforced at the tool layer, not merely declared:
`buildSandboxTools(..., memoryMounts)` receives the bindings and blocks a call
before it is executed —

- `write` and `edit` are refused when the target path is inside a `read_only`
  mount (`pathInMount`);
- `bash` is refused when the command names a path inside a `read_only` mount
  (`commandNamesPath`), since a shell redirect would otherwise write there;
- a `read_write` mount is left unguarded, and a session with no store attached
  changes nothing about tool behaviour.

The enforcement lives at the tool layer because that is the only place that sees
the path before the sandbox does. A check performed later would have to undo a
write that already happened.

Audit:

- Every memory write records a row in `memory_versions`, listable per store and
  readable per version.

Mounting:

- A store mounts at `/mnt/memory/<slug>/`, where `slug` is the store name
  lowercased with non-alphanumeric runs collapsed to a single hyphen; a name
  with no usable characters falls back to `memory`.
- A memory store can only be attached when the session is created. Attaching one
  to a running session is refused, because memories are part of the context the
  session was built with.

## 3. Alignment

Aligned for: all four published limits, `access` default and values, the
`path_prefix` requirement, `depth` values, `content_sha256` preconditions, and
per-write version auditing.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Precondition status | A mismatch is a 409 `precondition_failed`. The published contract states the precondition concept without fixing the status pairing. |
| Version retention | SandBase records versions in its own table. The published contract requires auditability without fixing a storage shape. |
| Slug fallback | A store name with no alphanumeric characters mounts at `/mnt/memory/memory/`. The published contract documents the slug rule but not this edge case. |

## 5. Reason for the difference

- 409 was chosen over 400 because the request was well-formed; the stored state
  had moved. A 400 would tell the caller to fix their request, which is the
  wrong next action.
- The slug fallback exists so a store with a punctuation-only name still mounts
  somewhere predictable rather than at `/mnt/memory//`, which would be an
  invalid path.

## 6. Corresponding tests

- `tests/unit/memory-semantics.test.ts` — 36 cases: byte and character limits,
  segment matching, `depth` values, precondition evaluation, slug generation,
  and mount path derivation.
- `tests/unit/memory.test.ts` — store and memory CRUD.
- `tests/integration/api.test.ts` — the memory beta mutual-exclusion rule and
  the at-creation attachment rule for session resources.
- `tests/integration/memory-mounts.test.ts` — the multi-store behaviour: several
  stores bound at once with the longest nested mount winning and a lookalike
  workspace path staying an ordinary workspace path, each store read back through
  its own binding, `read_only` blocking `write` / `edit` / `bash` at the tool
  layer (including a literal `//mnt/memory/...` path) while leaving a
  `read_write` mount unguarded, an absent provider failing closed, and the
  ContextBuilder searching every bound store while extraction reaches only the
  writable ones.
- `tests/integration/memory-wiring.test.ts` — the legacy `context_id` memory path
  still injects its own section, so the resource-scoped path did not replace it.
- `tests/integration/memory-store-list-include-archived.test.ts` — the published
  listing parameter: archived excluded by default and included on request with
  the archived label intact, `false` equal to omitting it, a malformed value and
  a repeated parameter each refused, the archived store still `404` on its own
  read, and the refusal worded identically to the vault listing's so the shared
  implementation cannot drift.
- `tests/integration/memory-store-update-delete.test.ts` — the update patch
  semantics (name bound, description clear, metadata merge), the PUT alias, the
  in-use and archived write refusals, and the delete cascade over
  `memory_records` and `memory_versions`.
- `tests/conformance/memory-store-update-delete.test.ts` — the official SDK's
  `memoryStores.update` / `.delete` driven against a live runtime, including
  the archived-store refusal as a `ConflictError`.
- `tests/integration/collection-pagination.test.ts` — the published `limit`/`page`
  window on this listing and the vault listing together: the default page of 20,
  a walk that partitions the collection exactly once, `prev_page` returning the
  page it came from, the last full page ending the walk, a malformed or replayed
  cursor refused, the newest-first ordering measured against distinct timestamps,
  and both collections answering the same refusal for the same `limit`.

## 7. Status

`supported` — limits, scoping, preconditions, version auditing, multi-store
mounting, and tool-layer read-only enforcement are implemented and covered by
tests.
