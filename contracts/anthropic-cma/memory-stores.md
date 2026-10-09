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
memory-worker-materialization: supported
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

Memory resource shape:

- A memory projects the published fields: `id`, `type: "memory"`,
  `memory_store_id`, `memory_version_id` (the version row that recorded the
  current state), `path`, `content`, `content_sha256`, `content_size_bytes`,
  `created_at`, `updated_at`. `content` is populated under `view=full` and is
  `null` under `view=basic`; the default is `basic` on list, create, and
  update, and `full` on retrieve — matching the published view defaults.
- `GET /memory_stores/:id/memories/:memoryId` retrieves one memory, `POST` is
  the published update verb (`PUT` remains a deprecated alias running the same
  semantics), and `DELETE` answers `{id, type: "memory_deleted"}` with an
  optional `expected_content_sha256` query precondition.
- A path collision — on create or on a rename — is a `409`
  `memory_path_conflict_error` naming `conflicting_path` and, when the
  blocking memory can be identified, `conflicting_memory_id`.

Preconditions:

- A write may carry a `content_sha256` precondition. A mismatch returns 409
  `memory_precondition_failed_error` (code `precondition_failed`) with the
  current hash, so the caller can retry against the real state instead of
  guessing — unless the stored state already equals the requested `content`
  and `path`, which the published contract answers with the memory itself.
- A malformed precondition — a non-object, an unknown `type`, or a missing
  hash — is a `400` `invalid_request_error` with code `invalid_precondition`.
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

The same `access` mode also fences the self-hosted worker's session work
token (the `mawt_` bearer inside a claimed work item's `secret`; see
[`work.md`](./work.md)). That token lists, reads, creates, updates, and
deletes memories only on stores its session attached — an unattached store,
or a store attached to a different session, is `401` — and a store attached
`access: "read_only"` refuses its writes and deletes with `403
permission_error`. The check reads the session's own `resources` record, so
the fence and the session retrieve a worker uses to discover its mounts can
never disagree about which stores are reachable.

Audit:

- Every memory write records a row in `memory_versions`, listable per store and
  readable per version. The projected object emits the published vocabulary —
  `operation` is `created`, `modified`, or `deleted` (the stored `updated` kind
  projects as `modified`) — plus `created_by` (a `session_actor` when a mounted
  session wrote the version) and `redacted_at`.
- `POST /memory_stores/:id/memory_versions/:versionId/redact` clears a
  version's recorded payload (`content`, `path`, `content_sha256`, and
  `content_size_bytes` all become `null`) and sets `redacted_at`, while the row
  stays listable. A `deleted` version projects the same null payload fields but
  keeps its `path`. The memory's head version is refused with `409`
  `memory_version_is_head`, because redacting it would orphan the memory's
  current content; redacting an already-redacted version is a no-op answering
  the version as it stands.

Mounting:

- A store mounts at `/mnt/memory/<slug>/`, where `slug` is the store name
  lowercased with non-alphanumeric runs collapsed to a single hyphen; a name
  with no usable characters falls back to `memory`.
- A memory store can only be attached when the session is created. Attaching one
  to a running session is refused, because memories are part of the context the
  session was built with.

Self-hosted worker materialization:

- A worker serving a session with `memory_store` resources materializes each
  store as a real directory under its workdir at the declared mount path —
  `<workdir>/mnt/memory/<slug>/` by default — with an
  `.anthropic-memory-store` marker file in the mount root, the same layout the
  published worker contract prescribes. The download and every later sync go
  through the claim's `mawt_` token against the memories routes above.
- While the worker runs, a reconcile pass executes every 15 seconds
  (`MANAGED_AGENTS_MEMORY_SYNC_INTERVAL_MS`, floored at 5000): remote edits
  write to disk, local file edits upload back through `POST`/`DELETE` with
  `content_sha256` preconditions, and a path edited on both sides resolves in
  the store's favour. `read_only` attachments pull but never upload — the
  scope fence would answer `403` anyway. On exit each mount runs one final
  sync inside a 30-second budget, then the directory and its lock are
  removed; the API store remains authoritative and the disk copy is
  disposable.
- Two workers on one host cannot mount the same store at once — an
  exclusive-create lock file in the host temp dir carries the claimant's pid —
  and a Windows host refuses memory mounts outright, matching the published
  POSIX-only worker memory contract.

## 3. Alignment

Aligned for: all four published limits, `access` default and values, the
`path_prefix` requirement, `depth` values, `content_sha256` preconditions with
the published error type, the published memory and memory-version object
shapes, the `view` projections and their per-endpoint defaults, the published
update and delete verbs and tombstones, version redaction, and per-write
version auditing.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Version retention | SandBase records versions in its own table. The published contract requires auditability without fixing a storage shape. |
| Slug fallback | A store name with no alphanumeric characters mounts at `/mnt/memory/memory/`. The published contract documents the slug rule but not this edge case. |
| Error extensions | `memory_precondition_failed_error` carries `current_content_sha256` and a `precondition_failed` code beyond the published fields, so a caller can retry without a re-read. |
| Actor attribution | `created_by` is `null` for API writes because the local runtime does not record per-key actor ids; session writes carry a `session_actor`. |

## 5. Reason for the difference

- The slug fallback exists so a store with a punctuation-only name still mounts
  somewhere predictable rather than at `/mnt/memory//`, which would be an
  invalid path.
- `current_content_sha256` travels inside the published error envelope rather
  than forcing a re-read: the published type is kept and the hash is an
  extension field, so an SDK decoder still sees the documented shape.

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
- `tests/integration/worker-memory-materialization.test.ts` — the self-hosted
  half: the `mawt_` scope admits the attached store and refuses the rest
  (including a read_only write), a mount downloads to
  `<workdir>/mnt/memory/<slug>/` with the marker, the reconcile syncs both
  directions and resolves conflicts store-wins, a read_only mount never
  uploads, the host lock blocks a second mount of one store, a Windows host is
  refused, and release removes the copy. The end-to-end `worker run` case runs
  on POSIX CI (skipped on Windows, matching the refused platform).
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
- `tests/integration/session-work-token-scope.test.ts` — the session work
  token's access to attached stores: list/read/write on `read_write`,
  `403 permission_error` on `read_only` writes and deletes, `401` on an
  unattached store or another session's store.
- `tests/conformance/memory-store-update-delete.test.ts` — the official SDK's
  `memoryStores.update` / `.delete` driven against a live runtime, including
  the archived-store refusal as a `ConflictError`.
- `tests/integration/memory-official-shape.test.ts` — the published object key
  set, `view` defaults and projections, the `POST` update verb with its `PUT`
  alias, `memory_precondition_failed_error` semantics including the
  matching-write 200, `expected_content_sha256` on delete, the
  `memory_path_conflict_error` fields, the published version vocabulary, and
  non-head versus head redaction.
- `tests/conformance/memory-official-shape.test.ts` — the official SDK's
  `memories.create/.retrieve/.update/.delete` and
  `memoryVersions.list/.redact` driven against a live runtime: the stale-hash
  retry surfaces as `ConflictError`, the head-version redact is refused, and
  the non-head redact nulls the recorded payload.
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
