# CMA Contract — github-repository

Contract area: the `github_repository` session resource — cloning a repository
into the sandbox, checking out a ref, discovering the skills it ships, and
keeping the access token out of everything the model can read. Status:
`partial`, see §7 — the wiring is in place, the local backend mounts the
canonical root, and the repository, its checkout, and its mount path are named in
the agent's instructions, while docker refuses that root and nothing yet refuses
such a session at creation. Source: `src/core/resources/github-materializer.ts`,
`src/core/resources/github-runtime.ts`,
`src/core/session/sandbox-lifecycle.ts`, `src/core/runtime/session-runtime.ts`,
`src/api/routes/session-resources.ts`.

<!-- capability-status
github-repository-materialization: partial
github-repository-identity-freeze: supported
-->

---

## 1. Official definition

A session may attach a `github_repository` resource naming a repository URL, an
optional checkout ref, and a mount path. The runtime materializes the repository
into the session's filesystem so the agent can read it, and any skills the
repository ships become available to the agent. The access token used for the
clone is a credential, not part of the resource: it must not be observable by the
model, persisted in an event, or echoed into a log.

## 2. Current SandBase shape

`materializeGithubRepository(resource, sandbox, deps)` runs a five-phase
sequence, and every phase has a defined failure disposition:

1. **Validate and decrypt.** The URL must parse as
   `https://github.com/<owner>/<repo>` — `parseGithubRepositoryUrl` rejects
   `http://`, SSH, a `.git` suffix, and any query or fragment. The token is
   resolved through `resolveGithubToken`, reading the credential store rather
   than the resource.
2. **Reuse the cache when the ref allows it.** `githubCacheKey(url, checkout)`
   returns a key only for a `commit` checkout: `sha256(url\nsha)` truncated to 32
   characters. A branch or tag cannot be cached, because the same name resolves
   to a different commit over time and a cached checkout would silently serve a
   stale tree. A cache entry is reused only when its directory can actually be
   listed: a path that does not exist is a miss, not an empty checkout, so a
   pinned commit always clones at least once.
3. **Clone and check out.** `cloneArgs(url, checkout)` builds the argument list;
   the token is passed through the environment (`gitAuthEnv`) as a GitHub
   `Authorization: Basic` header using the `x-access-token` user, never as an
   argv element. The header value is base64-encoded, so the plaintext token is
   not present in the child process environment either. `GIT_TERMINAL_PROMPT=0`
   and an empty `GIT_ASKPASS` ensure git cannot block on or fall back to an
   interactive prompt.
4. **Discover skills before copying.** `discoverRepositorySkills(repoRoot, deps)`
   scans `.claude/skills/<name>/SKILL.md`. The scan runs against the staging
   clone rather than the mounted copy so a skill that must not be exposed cannot
   be reached through a half-copied tree.
5. **Write into the sandbox.** The tree is copied (with `.git` excluded) to the
   resolved mount path, and the discovered skills are registered as the session's
   repository skills.

Failure disposition is the part that is easy to get wrong:

- A failed phase deletes the staging directory. Nothing is left behind on disk
  for a session that never started.
- Token hygiene is enforced by `sanitizeGitOutput(text, token)`, which strips the
  token from git's own stdout/stderr before the message is turned into an error.
  `skillPathsAreTokenFree(paths, token)` asserts the discovered skill paths do
  not embed the token.
- Output is capped at `MAX_OUTPUT_CHARS = 4_000` before it reaches an error
  message, and every git invocation has a timeout of `GIT_TIMEOUT_MS = 120_000`;
  a timed-out git reports exit code `124`.
- `mountIdentityChanged(prev, next)` reports whether a running session's
  repository identity has moved. Changing the URL, the checkout, or the
  mount path requires a **new session**: the skills that were registered and the
  files the agent may already have read cannot be retroactively corrected
  mid-run.

Identity freeze is enforced where a caller can reach it:
`src/api/routes/session-resources.ts` accepts exactly one mutating field on a
`github_repository` resource (`authorization_token`), names any other field in
the 400, and tells the caller a new session is required. `mountIdentityChanged`
in `github-materializer.ts` is the decision helper the unit tests drive; the
route does not consult it, which is recorded in §4.

**Runtime wiring is in place.** `SandboxLifecycle` materializes repositories
through an injected `githubMaterializer`
(`src/core/session/sandbox-lifecycle.ts`), and the composition root supplies one:
`createRuntimeSessionServices` builds the default with `createGithubMaterializer`
from `src/core/resources/github-runtime.ts`, caching under the workspace data
directory and decrypting a resource's token against the same directory the API
routes encrypted it with. `src/index.ts` passes that directory. A skill a
repository ships does reach the prompt: `discoveredRepositorySkills` records the
names at materialization, `discoveredRepositorySkillFiles` turns them into the
paths inside the mounted tree, and the executor reads each `SKILL.md` back
through the sandbox and hands it to the context builder, which appends it to the
same `# Available Skills` section an assigned skill uses.

What still fails is the mount on `docker`. The tree is copied through the sandbox
at the canonical `/workspace/<repo>` root. The local backend maps that root into
its sandbox directory, so a repository attached to a local session is cloned,
checked out, and readable at the mount path, and its `.claude/skills` are read
back out of the same tree (see §6 for exactly what the
`tests/integration/local-canonical-roots.test.ts` case does and does not stand
in for). `docker` refuses the absolute path outright, and that refusal is not yet
an admission decision: a session on docker is accepted with a 201 and then fails
at provisioning. `kubernetes` resolves an absolute path against its own
`/workspace`, so it accepts this mount — and only nothing-under-`/mnt` is
refused there, which this resource never touches — but that was not exercised
against a cluster, and no creation-time admission exists on any backend yet. The
mount path, URL, and checkout are named in the agent's instructions, in the
canonical spelling and — on the local backend — the shell-usable one
(`src/core/session/session-resource-prompt.ts`). The admission gap is why the
entry is `partial` rather than `supported`. §4 records it, and
`tests/integration/session-resource-wiring.test.ts` pins the docker refusal so
that fixing it forces this status to move.

## 3. Alignment

Aligned for: the resource being declarable per session, the URL grammar and
ref handling, the token never being model-visible or persisted, the identity
freeze being refused at the route, the discovered skills reaching the
instruction boundary, the mount path being announced to the agent with the URL,
checkout, and shell-usable spelling, and the mount itself on the local backend.
Not aligned for docker, whose refusal is not yet an admission decision.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Mount refused by docker | The materializer is implemented, tested, and injected by the composition root, so a session with a `github_repository` resource reaches it. On the local backend it mounts at the canonical `/workspace/<repo>` root, and `kubernetes` accepts the same path inside its own `/workspace`. `docker` rejects it as an absolute path, so a session on docker fails at provisioning instead of being refused at creation. The published contract describes a repository available in the sandbox. |
| Repository skills reach the prompt only as text | `discoveredRepositorySkills` has a caller now, and each discovered `SKILL.md` is read out of the sandbox into the system prompt. Pi's `--skill` flag is not given a directory for them: skill packages live inside the guest filesystem and Pi takes host paths, so a Pi session reads them from the prompt rather than loading them as packages. |
| Dead identity helper | `mountIdentityChanged` implements the freeze decision and is unit-tested, while the route enforces the same rule through a field allowlist. The rule a caller observes is enforced; the helper is not the enforcement point. |
| URL grammar | Only `https://github.com/<owner>/<repo>` is accepted. A self-hosted GitHub Enterprise host, an SSH remote, and a `.git` suffix are rejected rather than silently normalized. |
| Cache scope | Only a `commit` checkout is cacheable. A branch or tag checkout always clones fresh, trading time for the guarantee that the tree matches the ref. |
| Mount path | The canonical mount path is produced and validated locally; see [`files.md`](./files.md) for the path form itself. |
| Skill discovery path | `.claude/skills/<name>/SKILL.md` is the discovery convention. A repository using a different layout exposes no skills, which is reported rather than guessed at. A discovered file whose frontmatter carries no name and description is reported and skipped: that is the repository's own content, not a runtime failure. |
| Live mutation | Changing URL, checkout, or mount path mid-session is refused; a new session is required. |

## 5. Reason for the difference

- **The remaining gap is a backend limitation plus an admission gap, not a
  design.** The materializer is fully written, covered at both the decision and
  the host layer, and injected by the composition root; on the local backend a
  caller can mount a repository, read it at the published path, and see the path,
  URL, and checkout named in the agent's instructions, and kubernetes resolves the
  same root inside its own workspace. What a caller still cannot do is mount one on
  docker (its confinement refuses every absolute path, and that refusal is not yet
  an admission decision). Recording it as `partial` is the only honest status while
  part of the published behaviour is unreachable through a started runtime, however
  complete the helper is. Raising it to `supported` is an
  admission change plus the canary in
  `tests/integration/session-resource-wiring.test.ts`, not a prose change.
- Restricting the URL grammar is a security decision: accepting an arbitrary git
  remote would turn a resource declaration into an arbitrary-code-fetch
  primitive, and SSH remotes would require key material the runtime does not
  manage. A rejected URL fails before any clone begins.
- Not caching branch checkouts is the honest reading of what a cache key means.
  A branch name is not an identity, so caching on it would make correctness
  depend on how recently the cache was populated.
- Refusing a live identity change is a consequence of skills being registered at
  provisioning: the session's prompt has already named the discovered skills, and
  the agent may have read files from the old tree. Silently swapping the tree
  would leave the prompt describing something that is no longer there.
- Passing the token through the environment rather than argv is not a stylistic
  choice: on many systems argv is world-readable through the process table, so an
  argv token is a token disclosed to every local process.

## 6. Corresponding tests

- `tests/unit/github-materialization.test.ts` — decision logic: the URL grammar,
  cache-key scope (commit only), clone argument construction, token-bearing
  environment rather than argv, output sanitization, skill discovery, mount
  identity comparison, and the failure paths that must clean up staging. It also
  drives the `SandboxLifecycle` mount path with an injected materializer.
- `tests/integration/github-materialization-real.test.ts` — the host-side
  primitives against a real `git` binary: clone, checkout, cache reuse, timeout
  behaviour, and that the token never appears in the captured output.
- `tests/integration/session-resource-wiring.test.ts` — the mount path through
  the composition root: a repository URL outside the published grammar is
  answered by the default materializer rather than by a missing dependency, a
  discovered `SKILL.md` is read out of the sandbox into the system prompt, and the
  docker refusal of `/workspace/<repo>` (and of the upload root, which the file
  entry owns) is pinned against `dockerWorkspacePath` so that fixing it forces the
  status to move. The repository's git transport is a test double there; the
  wiring it proves is which dependency the composition root reaches.
- `tests/integration/local-canonical-roots.test.ts` — the mount path on the real
  `LocalSandboxProvider`: the tree is written at `/workspace/<repo>`, its
  `.claude/skills` are read back through the same sandbox, and the skill text
  reaches the system prompt. The git transport is a test double here too: the case
  proves that the sandbox accepts the canonical mount root and that the read-back
  works, not that `createGithubMaterializer` clones. That half is covered by the
  decision and host-layer suites above, and no test runs the production
  materializer end to end against a `LocalSandboxProvider`.
- `tests/integration/session-resources-prompt.test.ts` — the announcement of the
  mount: a session that attaches a repository and a file turns once, and the
  prompt the strategy received names the URL, the `main` checkout, the
  `/workspace/<repo>` mount path, the shell-usable spelling on the local backend,
  and never the `authorization_token` the caller supplied.
- `tests/integration/api.test.ts` — the resource on the wire: a
  `github_repository` resource is accepted, and the token is absent from the
  response, the session detail, and the stored row.

**What these tests do not cover:** no test completes a mount on docker, because
the write is refused before the tree lands — the gap recorded in §2 — and the
kubernetes path is unexercised (no cluster in CI). No test drives the production
clone through the local backend: `tests/integration/local-canonical-roots.test.ts`
replaces the transport, and the suites that use the real one stop at the host
layer or a recording sandbox. The decision and host-layer suites use local
fixtures for most cases. A live
smoke verification was also run on 2026-09-18 against
`https://github.com/AllureCurtain/sandbase-harness` at `main`: the production
materializer cloned the branch, mounted 343 files into the sandbox adapter,
discovered no repository skills, and left no token in the mount or reported
result. That run was made against the materializer directly. Provider-side edge
cases such as rate limiting, credential rejection, LFS, submodules, and GitHub
Enterprise remain unverified.

## 7. Status

`partial`. The materializer is implemented end to end and exercised by tests at
the decision layer, the host layer, through `SandboxLifecycle` with an injected
dependency, and on the real local backend; the composition root injects it,
discovered repository skills reach the context builder, the mount path, checkout,
and URL are named in the agent's instructions, and the identity freeze is enforced
by the resource route. It is not `supported` because `docker` refuses an absolute
path, so a session that attaches a `github_repository` resource there is accepted
and then fails at provisioning rather than being refused at creation (kubernetes
accepts the canonical `/workspace/<repo>` root on a code reading, unverified
against a cluster). The cache-key scope, the URL grammar, and the mount identity
rule are documented deviations, recorded in §4.
