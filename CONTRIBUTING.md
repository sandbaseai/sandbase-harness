# Contributing to SandBase Harness

SandBase Harness (`managed-agents`) is a local-first, self-hosted runtime for
AI agents. It is a single-package TypeScript runtime with a Vite Console. Keep
contributions focused, reproducible, and safe.

This is the canonical contributor guide. [`AGENTS.md`](./AGENTS.md) is an
agent-facing index and may repeat brief linked headlines of non-negotiable
rules; the rationale and procedure belong here.

## Hard rules

- Workspace runtime data — SQLite state, logs, artifacts, and session sandbox
  directories — defaults to `<workspace>/.managed-agents/`. CLI path options
  may override those locations. The template cache instead uses
  `MANAGED_AGENTS_HOME`, or the current user's `.managed-agents/` directory
  when that variable is absent. Do not write runtime data or secrets to the
  repository root or an arbitrary current working directory.
- The local sandbox is not a security boundary. It has path confinement and an
  environment allowlist but no kernel boundary. Untrusted agent code must run
  under an isolated provider such as Docker or Kubernetes.
- Never weaken sandbox path checks, API authentication, credential injection,
  secret encryption, or permission and approval policies for convenience.
- Treat the event log as append-only and preserve resumable SSE ordering.
- Keep one canonical usage record per model request. Projection events must not
  multiply aggregate token totals.
- Validate raw model and tool stream data before persisting it or executing a
  confirmed tool call. Confirmation authority is one-shot.
- Any schema change ships as a new migration. Migrations are immutable once
  they land on `main`, and must work on fresh and existing workspaces.
- Keep credentials, personal paths, host tokens, and sensitive output out of
  logs, fixtures, screenshots, commits, and public examples.

Before a substantial implementation, refactor, runtime/process change, schema
or API change, or cross-package behavior change, read this guide. Update it in
the same branch when the change establishes or changes an architecture rule,
workflow, ownership boundary, required check, or generated-artifact contract.

## One PR, one verifiable behavior

Each pull request contains one independently verifiable behavior. A feature may
span several small PRs.

Before implementing, state:

1. **Expected behavior** — what a user or API client can observe afterwards.
2. **Acceptance criteria** — the concrete scenarios that decide pass or fail.
3. **Explicit scope exclusions** — what the PR deliberately does not do and
   the follow-up that owns it.

Keep unrelated refactors, formatting, dependency updates, and capabilities in
separate PRs. A dependency that serves one feature belongs in that feature's
PR. A public API and a Console change may be in the same PR only when together
they deliver the one stated behavior and can be tested as one outcome.

Split a PR when it mixes a bug fix with a new capability, its description needs
an unrelated “also”, or a reviewer cannot express its acceptance criterion in
one sentence. If the design does not converge, document the unresolved question
and defer it rather than expanding the PR.

## Branch and worktree workflow

`main` is the integration baseline. **Do not commit directly to `main`.**

For each new topic, branch from the latest `origin/main` and use a dedicated
worktree when topics run in parallel:

```bash
git fetch origin main
git worktree add .worktrees/<feature-name> -b feat/<feature-name> origin/main
```

- Use one branch and, when applicable, one worktree per topic. Do not mix
  unrelated product work in a branch.
- Branch names use `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `test/<slug>`,
  `build/<slug>`, or `chore/<slug>`. Issue-driven work may use a public
  `fix/issue-<number>-<slug>` or `feat/issue-<number>-<slug>` name, or a
  functional slug-only name such as `feat/pi-session-continuity` when the
  Issue number should remain in Issue/PR metadata rather than the branch.
  Never put internal split identifiers such as `PR-07` in public names or
  commit subjects.
- Push the branch and open a PR against `main`; do not bypass review through a
  local fast-forward or merge.
- Before review, update from `origin/main`, resolve conflicts in the topic
  branch, preserve the stated acceptance criteria, and rerun the relevant
  checks.
- A migration already landed on `main` is immutable. If parallel unlanded work
  collides on a migration number, the later branch takes the next available
  number after updating from `main` and revalidates fresh and existing
  workspaces.

### After a pull request merges

Clean up as part of the merge, not later:

- Delete the topic branch on the remote that hosts it. For a branch in this
  repository, `gh pr merge --squash --delete-branch` does it at merge time.
  For a branch on a fork, neither that flag nor the repository's automatic
  head-branch deletion removes it (`gh` skips cross-repository branches, see
  [cli/cli#2860](https://github.com/cli/cli/issues/2860)), so delete it
  yourself: `git push <fork-remote> --delete <branch>`. The pull request keeps
  the commits and the diff, and the branch can be restored from it if it is
  needed again.
- Remove the worktree and the local branch:
  `git worktree remove .worktrees/<feature-name>`, then
  `git branch -D <branch>`. `-D` is required because a squash merge does not
  make the topic branch an ancestor of `main`, so `-d` refuses it.
- Keep a branch only while it is the base of another open pull request, or
  when its pull request was closed unmerged and will be resumed; say which in
  the pull request.
- Never delete `main` or a release branch.

## Review and pull requests

Choose the review method based on scope and risk. Self-review with suitable
validation is sufficient for low-risk, well-understood work. Use an independent
review when it materially improves confidence, especially for security-
sensitive, shared, or uncertain behavior.

For a blind review, provide only requirements, acceptance criteria, project
rules, scope boundaries, repository location, and comparison baseline. Do not
provide the implementation narrative, suspected defects, or earlier findings.
Record the method honestly in the PR.

Use [the PR template](./.github/PULL_REQUEST_TEMPLATE.md). It records the
observable change, constraints and invariants, explicit exclusions, and actual
validation evidence. Use `Fixes #<number>` or `Closes #<number>` only when the
PR fully resolves that Issue. Merge only after required CI checks pass and no
correctness or security issue remains; prefer squash merges for focused work.

## Required checks

Run the narrowest relevant checks while developing. Before requesting review or
reporting completion, run the full gate:

```bash
npm run release:check
```

The component commands are:

| Command | Covers |
| --- | --- |
| `npm run typecheck` | source, tests, and Console TypeScript programs |
| `npm test` | unit, integration, and property tests |
| `npm run build` | runtime and Console builds |
| `npm run package:check` | published-package contents |
| `npm run smoke:release` | packaged CLI and example startup smoke checks |

`tsconfig.tests.json` must type-check the complete test suite, including tests
that import Console components. Do not hide errors by excluding a test group;
repair the fixture, type, or configuration instead.

Some integration suites intentionally skip when their backing service is not
available: Docker tests require a daemon and image, Kubernetes tests require a
reachable cluster, and Windows symlink cases require the appropriate privilege.
A passing run must report those skips accurately. If a check cannot run, record
the exact blocker rather than claiming full verification.

### Cross-platform expectations

Write tests against platform-neutral behavior:

- Construct filesystem expectations with `join` or `resolve`; do not compare a
  POSIX literal with a resolved Windows path.
- Build public logical identifiers with `posix.join`, never the host separator.
- Poll observable conditions with a deadline instead of using a fixed sleep.
- Resolve an available shell and skip a shell-dependent test when none exists;
  do not hardcode `/bin/sh`.

## Manual Console validation

Component and CSS tests do not prove an end-to-end conversation works. For a
user-visible Console change, run the runtime and Console against a reachable
model provider and walk the relevant acceptance scenarios. At minimum, consider
multi-turn conversation, long replies, refresh, reconnect, retry, interrupt,
repeated send, and tool approval when the change touches those paths. Record
observed behavior and known limitations without secrets or personal paths.

## Project structure

```text
sandbase-harness/
├── src/
│   ├── api/        # HTTP routes and protocol adapters
│   ├── core/       # database, runtime, session, and shared services
│   ├── model/      # model provider registry
│   ├── sandbox/    # execution providers and capabilities
│   ├── sdk/        # TypeScript client SDK
│   ├── strategy/   # model-loop implementations and stream handling
│   └── types/      # protocol and runtime types
├── apps/console/   # React/Vite operator Console
├── tests/          # unit, integration, and property coverage
├── docs/           # specifications and guides
└── examples/       # runnable examples
```

The main execution path is:

`API/SDK → SessionManager → ContextBuilder → AgentStrategy → Model/MCP tools → Sandbox`

## Generated and derived artifacts

- Migrations live in `src/core/db/migrations.ts` and are embedded in the
  runtime. Add a new migration; never edit one that has landed on `main`.
- Distribution is built into `dist/` and is not committed. Changes to entry
  points, exports, or `bin` require `npm run package:check` and
  `npm run smoke:release`.
- Public API contract changes update `docs/api.md` and `docs/api-matrix.md` in
  the same PR.
- Update `CHANGELOG.md` whenever public behavior changes.

## Code standards

- Keep TypeScript strict-mode clean and prefer established project patterns.
- Extract a source file approaching roughly 500 lines or a React component
  approaching roughly 400 lines when doing so clarifies ownership.
- Put shared Console formatting, labels, and rendering helpers under
  `apps/console/src/lib/`; do not copy them between pages.
- Keep public APIs stable unless the PR explicitly changes the API contract.
- Add focused regression coverage when changing runtime behavior, protocol
  handling, sandboxing, or session lifecycle.
- Never render model or tool output through uncontrolled HTML injection.
  Restrict link protocols and disable raw HTML in Markdown rendering.

## Documentation and text

- Source comments and documentation are written in English except for
  user-facing internationalized copy.
- English is the canonical technical source. Preserve commands, package names,
  API paths, event names, and configuration keys verbatim when translating.
- Substantial guides include prerequisites, commands, expected success evidence,
  failure branches, cleanup or rollback, and a verification date for claims
  that can go stale.
- Keep source and documentation in UTF-8 without a BOM and LF line endings, as
  enforced by `.gitattributes`. Verify file bytes before correcting terminal
  mojibake.
- Never commit U+FFFD replacement characters. Restore the original source if
  an incorrect encoding conversion introduced one.
- Local planning notes do not belong in the repository or a PR description.

## Commit messages

```text
<type>(<scope>): <description>

[optional body]
[optional footer]
```

Use `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`,
or `chore`; use the owning area as scope. Prefer one commit per focused PR, and
make the commit subject match the PR title.

## Roadmap

[`BACKLOG.md`](./BACKLOG.md) is the public product roadmap. Read it before
proposing roadmap work, and update it when a product gap is confirmed or closes.
