# CMA Contract — files

Contract area: `/v1/files` and file session resources.
Status: `partial` — the Files API, the mount-path form, and the reader the
provisioning pass calls are implemented, but the shipped sandbox backends refuse
the canonical mount root, so an attached file still cannot be written. See §4.
Source: `src/core/session/file-mount-path.ts`,
`src/api/routes/session-resources.ts`, `src/core/session/session-resources.ts`,
`src/core/runtime/session-runtime.ts`, `src/api/routes/files.ts`.

<!-- capability-status
file-resources: partial
file-mount-path: supported
-->

---

## 1. Official definition

- Files are uploaded, listed, and read through the files API.
- A file can be attached to a session as a resource, mounted at a path inside
  the sandbox so the agent can read it.
- The mount path is a logical sandbox path, not a host path.

## 2. Current SandBase shape

The mount-path rules are `src/core/session/file-mount-path.ts`; the resource
lifecycle is `src/core/session/session-resources.ts` and its route is
`src/api/routes/session-resources.ts`.

Files API:

- Files are uploaded, listed, and read. A file resource carries its own identity
  and a `mount_path`.
- The listing honours the published `scope_id` parameter: `scope_id` selects the
  column's local `session_id`, so a caller asking for one session's deliverables
  gets that session's files and nothing else. The scope is applied in the query
  rather than filtered after the read, so an id that names no session returns an
  empty page instead of the global list — an ignored scope answering with the
  unscoped list is the specific failure the parameter exists to prevent, and it
  is indistinguishable from a session that happens to have unfamiliar files.
- A list without `scope_id` returns every file, which is what this route returned
  before the parameter was implemented, so no existing caller changes. A
  parameter outside `scope_id` is refused by name rather than ignored. See
  [`errors.md`](./errors.md) §2.

Mount path:

- `canonicalPathFromSandboxPath` produces the canonical form, and the mount path
  is validated on the way in as well, so a caller cannot store a path the
  runtime would not accept on read.

Session file resources:

- A file resource attached to a session gets its own `sesrsc_` id, so it can be
  addressed independently of the session's resource JSON blob.
- On a running session, file resources may be added, listed, and deleted. This
  differs from `memory_store` (creation-only) and `github_repository` (token
  rotation only).

Mounting is composed and still blocked by the backends:

- `SandboxLifecycle.materializeFileResources` writes each attached file into the
  sandbox by calling an injected `fileArtifactReader`. The composition root
  supplies one: `createRuntimeSessionServices` builds it from the database and
  the artifact store
  (`createFileArtifactReader` in `src/core/session/session-resources.ts`), and
  `src/index.ts` passes the workspace data directory. The lookup is the one
  resource admission performs — `role = 'file'`, not archived, backed by an
  artifact that is on disk — so a resource the API accepted cannot fail here for
  a different reason, and an archived upload or a session artifact cannot be
  mounted through this path.
- What still fails is the write itself. The bytes go to the canonical
  `/mnt/session/uploads` root, and the shipped sandbox backends confine every
  path to their own workspace root: `LocalSandboxProvider` (and Kubernetes for
  the `/mnt/...` root) answer `Path escapes sandbox workspace`. A session created
  with a file resource therefore succeeds and then fails at provisioning, rather
  than failing at creation with a missing dependency named. The entry stays
  `partial` for that reason, and
  `tests/integration/session-resource-wiring.test.ts` pins the refusal so that
  fixing a backend forces the status to move.

## 3. Alignment

Aligned for: upload/list/read, the scoped listing, resource attachment, canonical
mount path form, independent resource identity, and the reader the provisioning
pass calls — an attached file is read back from the Files API's own row and
artifact.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Resource identity | SandBase gives each session resource instance its own `sesrsc_` id. The published contract documents independent resource identity; the id prefix is a local spelling. |
| Deleting a running-session file resource | SandBase soft-deletes (`deleted_at`), so the record survives for audit while the resource stops being live. The published contract allows deletion without fixing the mechanism. |
| Mount root | SandBase mounts under its own sandbox root layout. The published contract specifies a logical path, not a host directory. |
| What a scoped listing contains | `scope_id` selects files whose recorded session is that session. A file created directly through `POST /v1/files` records no session, so it appears in the unscoped listing and in **no** scoped one — it is not attributed to a session that did not create it. The published contract describes session outputs; it does not state where a session-less upload should appear, so the choice is to leave it unattributed rather than guess an owner. |
| The listing excludes `role = 'artifact'` | Rows written with `role = 'artifact'` are outside this listing in both scoped and unscoped form. That predates the scope parameter and is unchanged by it; recorded here because a caller reasoning about "every file for this session" should know the listing is not the whole table. |
| The shipped backends refuse the mount root | The mount path is derived and validated, and the reader is wired, but the write lands on `/mnt/session/uploads`, which the shipped providers reject as outside their workspace root. Recorded as `partial` rather than `supported` until a backend accepts the canonical roots. |

## 5. Reason for the difference

- Independent resource ids exist so `PATCH`/`DELETE` can address one resource
  without rewriting the whole session payload. Rewriting an array to change one
  entry is how concurrent edits lose each other's changes.
- Soft delete keeps an audit trail: a resource that was attached to a session
  and later removed is a fact worth retaining, and a hard delete would erase
  the evidence that it was ever mounted.
- The reader is injected rather than imported so the lifecycle stays free of
  host storage concerns, and a test can attach a fixture file. The composition
  root is where the host-facing default belongs, because that is the only layer
  holding the workspace directory, the database, and the artifact store at once.
  It is wired there now rather than in the lifecycle, and the entry stays
  `partial` only because the mount still cannot be written on the shipped
  backends.

## 6. Corresponding tests

- `tests/unit/file-mount-path.test.ts` — canonical mount path derivation and
  validation.
- `tests/unit/session-resource-instances.test.ts` — attach, list, delete, and
  independent id assignment against a real database.
- `tests/integration/api.test.ts` — adding and removing a file resource on a
  running session, and addressing a resource by its own id.
- `tests/integration/session-resources.test.ts` — the provisioning pass that
  writes an attached file into the sandbox: the canonical mount path under
  `/mnt/session/uploads`, a legacy pre-canonical row, the write happening after a
  snapshot restore and exactly once per bound sandbox, and a traversal path
  cleaning up the failed provision. The reader is injected by the test, which is
  the way a unit-level case drives one dependency at a time.
- `tests/integration/session-resource-wiring.test.ts` — the same pass through the
  composition root instead of a hand-built lifecycle: an uploaded file's bytes
  reach the sandbox at `/mnt/session/uploads/notes/input.txt` for a session
  created by `POST /v1/sessions` and by `POST /v1/runs`, a resource whose row is
  gone is reported as `File not found` by the default reader, and the shipped
  backends' refusal of the canonical root is pinned so that fixing one forces the
  status to move.
- `tests/unit/file-artifact-reader.test.ts` — the default reader's row
  semantics: the bytes the Files API stored, an archived file, a row whose
  artifact is gone, and a session artifact, each answered as the resource
  admission check would answer it.
- `tests/integration/files-scope-id.test.ts` — the scoped listing: one session's
  files are returned and another's are not (asserted in both directions, so the
  case cannot pass by the filter always selecting the same session), an unknown
  scope returns an empty page rather than the global list, a session-less file is
  absent from every scoped listing, an unscoped request keeps the previous global
  listing, an unimplemented parameter is refused by name, and the compatibility
  gate still refuses an ungated request that carries a scope.

## 7. Status

`partial` — file upload/list/read, mount path derivation, resource identity, the
running-session resource lifecycle, and the reader the provisioning pass calls
are implemented and covered by tests. It is not `supported` because the write
itself is refused: the bytes go to the canonical `/mnt/session/uploads` root and
the shipped sandbox backends confine every path to their own workspace root, so a
session that attaches a file is accepted and then fails at provisioning. The
mount-path entry is `supported` on its own, because path derivation and
validation are complete and tested.
