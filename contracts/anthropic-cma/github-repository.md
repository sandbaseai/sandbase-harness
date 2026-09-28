# CMA Contract — github-repository

Contract area: the `github_repository` session resource — cloning a repository
into the sandbox, checking out a ref, discovering the skills it ships, and
keeping the access token out of everything the model can read. Status:
`partial`, see §7 — the wiring is in place and the shipped sandbox backends
refuse the canonical mount root. Source: `src/core/resources/github-materializer.ts`,
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

What still fails is the mount. The tree is copied through the sandbox at the
canonical `/workspace/<repo>` root, and the shipped sandbox backends confine
every path to their own workspace root: `LocalSandboxProvider` answers
`Path escapes sandbox workspace` for `/workspace/...`, and Kubernetes accepts
that root but not `/mnt/...`. A session that attaches a `github_repository`
resource is therefore accepted with a 201 and then fails at provisioning — the
same caller-visible ordering as before, from a different cause, and this is why
the entry is `partial` rather than `supported`. §4 records the gap, and
`tests/integration/session-resource-wiring.test.ts` pins the refusal so that
fixing a backend forces this status to move.

## 3. Alignment

Aligned for: the resource being declarable per session, the URL grammar and
ref handling, the token never being model-visible or persisted, the identity
freeze being refused at the route, and the discovered skills reaching the
instruction boundary. Not aligned for the mount itself: no shipped backend
accepts the root it is written to.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Mount refused by the shipped backends | The materializer is implemented, tested, and injected by the composition root, so a session with a `github_repository` resource reaches it and then fails at provisioning: the copy targets the canonical `/workspace/<repo>` root, which the shipped providers reject as outside their workspace root. The published contract describes a repository available in the sandbox. |
| Repository skills reach the prompt only as text | `discoveredRepositorySkills` has a caller now, and each discovered `SKILL.md` is read out of the sandbox into the system prompt. Pi's `--skill` flag is not given a directory for them: skill packages live inside the guest filesystem and Pi takes host paths, so a Pi session reads them from the prompt rather than loading them as packages. |
| Dead identity helper | `mountIdentityChanged` implements the freeze decision and is unit-tested, while the route enforces the same rule through a field allowlist. The rule a caller observes is enforced; the helper is not the enforcement point. |
| URL grammar | Only `https://github.com/<owner>/<repo>` is accepted. A self-hosted GitHub Enterprise host, an SSH remote, and a `.git` suffix are rejected rather than silently normalized. |
| Cache scope | Only a `commit` checkout is cacheable. A branch or tag checkout always clones fresh, trading time for the guarantee that the tree matches the ref. |
| Mount path | The canonical mount path is produced and validated locally; see [`files.md`](./files.md) for the path form itself. |
| Skill discovery path | `.claude/skills/<name>/SKILL.md` is the discovery convention. A repository using a different layout exposes no skills, which is reported rather than guessed at. A discovered file whose frontmatter carries no name and description is reported and skipped: that is the repository's own content, not a runtime failure. |
| Live mutation | Changing URL, checkout, or mount path mid-session is refused; a new session is required. |

## 5. Reason for the difference

- **The remaining gap is a backend limitation, not a design.** The materializer
  is fully written, covered at both the decision and the host layer, and injected
  by the composition root. What a caller still cannot do is mount a repository,
  because the canonical `/workspace/<repo>` root is outside every shipped
  backend's workspace root. Recording it as `partial` is the only honest status
  while a caller cannot reach the behaviour through a started runtime, however
  complete the helper is. Raising it to `supported` is a backend change plus the
  canary in `tests/integration/session-resource-wiring.test.ts`, not a prose
  change.
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
  discovered `SKILL.md` is read out of the sandbox into the system prompt, and
  the shipped backends' refusal of `/workspace/<repo>` is pinned so that fixing
  one forces the status to move.
- `tests/integration/api.test.ts` — the resource on the wire: a
  `github_repository` resource is accepted, and the token is absent from the
  response, the session detail, and the stored row.

**What these tests do not cover:** no test completes a mount through a started
runtime, because the write is refused before the tree lands — the gap recorded in
§2. The decision and host-layer suites use local fixtures for most cases. A live
smoke verification was also run on 2026-09-18 against
`https://github.com/AllureCurtain/sandbase-harness` at `main`: the production
materializer cloned the branch, mounted 343 files into the sandbox adapter,
discovered no repository skills, and left no token in the mount or reported
result. That run was made against the materializer directly, which is why it does
not contradict the mount gap. Provider-side edge cases such as rate limiting,
credential rejection, LFS, submodules, and GitHub Enterprise remain unverified.

## 7. Status

`partial`. The materializer is implemented end to end and exercised by tests at
the decision layer, the host layer, and through `SandboxLifecycle` with an
injected dependency; the composition root injects it, discovered repository
skills reach the context builder, and the identity freeze is enforced by the
resource route. It is not `supported` because the mount itself is refused: the
tree is copied to the canonical `/workspace/<repo>` root, which the shipped
sandbox backends answer with `Path escapes sandbox workspace`, so a session that
attaches a `github_repository` resource is accepted and then fails at
provisioning. The cache-key scope, the URL grammar, and the mount identity rule
are documented deviations, recorded in §4.
