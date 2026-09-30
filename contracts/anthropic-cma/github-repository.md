# CMA Contract — github-repository

Contract area: the `github_repository` session resource — cloning a repository
into the sandbox, checking out a ref, discovering the skills it ships, and
keeping the access token out of everything the model can read. Status:
`supported` on the `local` backend, see §7 — the wiring is in place, the local
backend mounts the canonical root, the repository, its checkout, and its mount
path are named in the agent's instructions, and a session whose Environment
selects a backend that cannot serve that root (`docker`, `kubernetes`,
`self_hosted`) is refused when it is created with `resource_not_mountable`.
Source: `src/core/resources/github-materializer.ts`,
`src/core/resources/github-runtime.ts`,
`src/core/resources/resource-mountability.ts`,
`src/core/session/sandbox-lifecycle.ts`, `src/core/runtime/session-runtime.ts`,
`src/api/routes/session-resources.ts`.

<!-- capability-status
github-repository-materialization: supported
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
   characters. A branch cannot be cached, because the same name resolves
   to a different commit over time and a cached checkout would silently serve a
   stale tree; an absent checkout names no revision at all, so it is not cached
   either. A cache entry is reused only when its directory can actually be
   listed: a path that does not exist is a miss, not an empty checkout, so a
   pinned commit always clones at least once.
3. **Clone and check out.** `cloneArgs(url, checkout)` builds the argument list;
   the token is passed through the environment (`gitAuthEnv`) as a GitHub
   `Authorization: Basic` header using the `x-access-token` user, never as an
   argv element. The header value is base64-encoded, so the plaintext token is
   not present in the child process environment either. `GIT_TERMINAL_PROMPT=0`
   and an empty `GIT_ASKPASS` ensure git cannot block on or fall back to an
   interactive prompt. An absent checkout is the remote's **default branch**,
   which a clone already follows when no `--branch` is passed; `HEAD` is a local
   ref name, not a branch a remote serves. The default is therefore never spelled
   as `--branch HEAD`: a real remote refuses that with `fatal: Remote branch HEAD
   not found in upstream origin`, which failed the mount for exactly the
   resources that asked for no revision in particular.
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

The mount itself is out of reach on the backends that cannot serve the canonical
root. The tree is copied through the sandbox at the canonical
`/workspace/<repo>` root. The local backend maps that root into its sandbox
directory, so a repository attached to a local session is cloned, checked out,
and readable at the mount path, and its `.claude/skills` are read back out of the
same tree (see §6 for exactly what the
`tests/integration/local-canonical-roots.test.ts` case does and does not stand
in for). `docker` refuses the absolute path outright, Kubernetes resolves an
absolute path against its own `/workspace` (so it accepts this mount, but its
acceptance was never exercised against a cluster), and for a `self_hosted` worker
the path is the operator's process to interpret: the worker maps an absolute path
into its own root, so the runtime can neither verify nor enforce that the tree
lands where the resource, the agent's instructions, and a reader would look for
it. None of the three is served, and none of them is
silently accepted either: a session that declares this resource on one of them is
**refused when it is created**, with `resource_not_mountable`, before any session
row, resource instance, or event exists, so the caller learns which backend
refused and why instead of meeting the failure at provisioning
(`src/core/resources/resource-mountability.ts`). The mount path, URL, and
checkout are named in the agent's instructions, in the canonical spelling and —
on the local backend — the shell-usable one
(`src/core/session/session-resource-prompt.ts`). That is why the entry is
`supported` for the `local` backend, which is the scope it states. §4 records the
backend differences, `tests/integration/resource-admission-refusal.test.ts`
drives the refusal, and `tests/integration/session-resource-wiring.test.ts` pins
the docker path check the refusal rests on.

## 3. Alignment

Aligned for: the resource being declarable per session, the URL grammar and
ref handling, the token never being model-visible or persisted, the identity
freeze being refused at the route, the discovered skills reaching the
instruction boundary, the mount path being announced to the agent with the URL,
checkout, and shell-usable spelling, and the mount itself on the local backend.
Not aligned for `docker`, `kubernetes`, or `self_hosted`: those are refused at
creation rather than served, so no claim is made that they mount a repository.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Backends that cannot serve the mount root | The materializer is implemented, tested, and injected by the composition root, so a session with a `github_repository` resource reaches it. On the local backend it mounts at the canonical `/workspace/<repo>` root. `docker` rejects that path as an absolute path, `kubernetes` resolves it against its own `/workspace` but was never exercised against a cluster, and a `self_hosted` worker interprets the path inside its own root — the runtime cannot hold that process to the canonical root. A session on one of the three is refused at creation with `resource_not_mountable` rather than accepted and failed at provisioning, so the supported scope is `local`. |
| Repository skills reach the prompt only as text | `discoveredRepositorySkills` has a caller now, and each discovered `SKILL.md` is read out of the sandbox into the system prompt. Pi's `--skill` flag is not given a directory for them: skill packages live inside the guest filesystem and Pi takes host paths, so a Pi session reads them from the prompt rather than loading them as packages. |
| Dead identity helper | `mountIdentityChanged` implements the freeze decision and is unit-tested, while the route enforces the same rule through a field allowlist. The rule a caller observes is enforced; the helper is not the enforcement point. |
| URL grammar | Only `https://github.com/<owner>/<repo>` is accepted. A self-hosted GitHub Enterprise host, an SSH remote, and a `.git` suffix are rejected rather than silently normalized. |
| Cache scope | Only a `commit` checkout is cacheable. A branch checkout, and an absent checkout, always clone fresh, trading time for the guarantee that the tree matches the ref. |
| Mount path | The canonical mount path is produced and validated locally; see [`files.md`](./files.md) for the path form itself. |
| Skill discovery path | `.claude/skills/<name>/SKILL.md` is the discovery convention. A repository using a different layout exposes no skills, which is reported rather than guessed at. A discovered file whose frontmatter carries no name and description is reported and skipped: that is the repository's own content, not a runtime failure. |
| Live mutation | Changing URL, checkout, or mount path mid-session is refused; a new session is required. |

## 5. Reason for the difference

- **The remaining difference is a backend limitation, not a design.** The
  materializer is fully written, covered at both the decision and the host layer,
  and injected by the composition root; on the local backend a caller can mount a
  repository, read it at the published path, and see the path, URL, and checkout
  named in the agent's instructions. What a caller cannot do is mount one on
  docker (its confinement refuses every absolute path), on Kubernetes (its
  acceptance of `/workspace` was never exercised against a cluster), or on a
  `self_hosted` worker (which maps the path into its own root, so the canonical
  root is not the runtime's to promise). Those three are refused at
  creation with `resource_not_mountable` instead of being accepted and failed at
  provisioning, so a caller learns immediately which backend cannot serve the
  resource. Being refused is not being served, so the entry states the `local`
  scope it is `supported` for rather than implying every backend serves it. A
  backend that starts serving the canonical roots is a backend change plus the
  refusal list in `src/core/resources/resource-mountability.ts`, not a prose
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
  cache-key scope (commit only; a branch and an absent checkout both name no
  cached revision), clone argument construction (including that an absent
  checkout is a plain default-branch clone with no `--branch`), token-bearing
  environment rather than argv, output sanitization, skill discovery, mount
  identity comparison, and the failure paths that must clean up staging. It also
  drives the `SandboxLifecycle` mount path with an injected materializer.
- `tests/integration/github-materialization-real.test.ts` — the host-side
  primitives against a real `git` binary: clone, checkout, cache reuse, timeout
  behaviour, that the token never appears in the captured output, and that both
  the default-branch clone command and a resource with no checkout materialize a
  real repository rather than failing the clone.
- `tests/integration/session-resource-wiring.test.ts` — the mount path through
  the composition root: a repository URL outside the published grammar is
  answered by the default materializer rather than by a missing dependency, a
  discovered `SKILL.md` is read out of the sandbox into the system prompt, and the
  docker refusal of `/workspace/<repo>` (and of the upload root, which the file
  entry owns) is pinned against `dockerWorkspacePath`. The repository's git
  transport is a test double there; the wiring it proves is which dependency the
  composition root reaches.
- `tests/integration/resource-admission-refusal.test.ts` — the admission decision
  built on that refusal: `POST /v1/sessions` and `POST /v1/runs` with a repository
  (or file) resource on a backend that cannot serve the root answer 400 with
  `resource_not_mountable` and leave no session row, resource instance, or event;
  attaching one to an existing session on such a backend is refused the same way;
  and the same resources on `local` are admitted and recorded.
- `tests/unit/resource-mountability.test.ts` — the decision table itself: which
  backends refuse which mounted resource types, that `local` and an unknown
  backend are left alone, and that the refusal message names the backend, the
  resource, and the alternative.
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
the write is refused before the tree lands — the backend difference recorded in §2
— and the kubernetes path is unexercised (no cluster in CI). The admission
refusal is covered for every backend the runtime ships, because it is a decision
made before any sandbox is reached; what is not covered is a successful mount
there. No test drives the production
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

`supported` on the `local` backend. The materializer is implemented end to end and
exercised by tests at the decision layer, the host layer, through
`SandboxLifecycle` with an injected dependency, and on the real local backend; the
composition root injects it, discovered repository skills reach the context
builder, the mount path, checkout, and URL are named in the agent's instructions,
and the identity freeze is enforced by the resource route. The other shipped
backends do not serve the canonical root, and the runtime no longer pretends they
do: a session that attaches this resource on one of them — `docker` refuses every
absolute path, kubernetes was never exercised against a cluster, and a
`self_hosted` worker resolves the path inside its own root — is refused when it is
created,
with `resource_not_mountable`, and leaves nothing behind. That refusal is what the
`local` scope in this entry means. The cache-key scope, the URL grammar, and the
mount identity rule are documented deviations, recorded in §4.
