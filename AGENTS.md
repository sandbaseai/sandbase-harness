# SandBase Harness Agent Instructions

This file is the agent-facing shortcut and role index. The canonical
contributor guide — hard rules, worktree workflow, review policy, required
checks, generated-artifact contracts, code standards, and PR requirements —
lives in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

Read `CONTRIBUTING.md` before touching code. Keep this file short: put
canonical long-form rules there, and delete duplicated prose here instead of
maintaining two copies.

## Project identity

SandBase Harness (`managed-agents`) is a local-first, self-hosted runtime for
AI agents. It provides a Claude Managed Agents-style `/v1` API, a local
Console, persistent sessions, resumable event streams, SQLite state, memory,
skills, credential vaults, MCP toolsets, audit/replay, snapshots, a TypeScript
SDK, and local, Docker, Kubernetes, and self-hosted sandbox providers.

This is an independent SandBase open-source project. It is not an official
Anthropic, DeepSeek, or DSH implementation. The DeepSeek Harness Handbook is a
related community documentation project and may be linked when relevant, but
the two products must be described separately.

## Orientation

The main execution path is:

`API/SDK → SessionManager → ContextBuilder → AgentStrategy → Model/MCP tools → Sandbox`

The directory map is in
[`CONTRIBUTING.md#project-structure`](./CONTRIBUTING.md#project-structure).
Known gaps and planned work are in [`BACKLOG.md`](./BACKLOG.md).

The local sandbox is not a security boundary. Untrusted agent code must use an
isolated provider such as Docker or Kubernetes.

## Session start

Before choosing work:

1. Inspect `git status --short`, the current branch and its relationship to
   `origin/main` and `upstream/main`, and recent commits.
2. Read the README, open Issues, open PRs, and recent releases.
3. Confirm the working tree is clean enough to start a new topic. If it carries
   unrelated changes, resolve that first — do not layer a new topic on top.
4. Create a worktree for the topic. See
   [`CONTRIBUTING.md#branch-and-worktree-workflow`](./CONTRIBUTING.md#branch-and-worktree-workflow).
5. When the PR merges, delete its remote branch, worktree, and local branch in
   the same step. See
   [`CONTRIBUTING.md#after-a-pull-request-merges`](./CONTRIBUTING.md#after-a-pull-request-merges).

## Non-negotiables

These are enforced by
[`CONTRIBUTING.md#hard-rules`](./CONTRIBUTING.md#hard-rules) and
[`CONTRIBUTING.md#one-pr-one-verifiable-behavior`](./CONTRIBUTING.md#one-pr-one-verifiable-behavior).
The headlines, because they are the ones most often violated under time
pressure:

- One PR, one independently verifiable behavior. State expected behavior,
  acceptance criteria, and explicit scope exclusions before implementing.
- Public topic branches use functional slugs; a GitHub Issue remains linked in
  the Issue/PR metadata, and internal split identifiers never enter branch or
  commit names.
- No direct commits to `main`. Every change goes through a worktree branch and
  a PR.
- Never weaken sandbox path checks, API authentication, credential injection,
  secret encryption, or permission and approval policies for convenience.
- Confirmation authority is one-shot. Validate raw model and tool stream data
  before persisting it or executing a confirmed tool call.
- The event log is append-only; resumable SSE ordering is preserved.
- One canonical usage record per model request.
- Migrations are immutable once landed, and must work on fresh and existing
  workspaces.
- Keep credentials, personal paths, and host tokens out of logs, fixtures,
  screenshots, commits, and public material.

## Role A: project maintenance

Act as the project owner and maintainer. Within the repository scope, handle
routine safe work autonomously.

### Issue triage

1. Triage each Issue using source evidence. Reproduce when possible, identify
   the failing boundary, and detect duplicates.
2. Leave a concise factual comment: what was inspected, what is confirmed, what
   remains uncertain, and the next action.
3. Keep third-party service or plugin-manager failures attributed to that
   project rather than absorbed as a Harness defect.
4. Implement the smallest complete fix with a regression test. Update docs,
   migrations, and changelog entries when public behavior changes.

### PR review and merge

1. Review the actual diff, not the title or the mergeability flag.
2. Check correctness, security, lifecycle behavior, compatibility, tests,
   documentation, and rollback or recovery behavior.
3. Follow
   [`CONTRIBUTING.md#review-policy`](./CONTRIBUTING.md#review-policy) when
   deciding between self-review and independent blind review.
4. After merging, verify the target Issue and the user-facing behavior. Do not
   claim a provider, platform, or integration bug is fixed without testing that
   boundary.

### Verification honesty

Run the narrowest relevant checks during development and the full gate before
requesting review or reporting completion; see
[`CONTRIBUTING.md#required-checks`](./CONTRIBUTING.md#required-checks) for the
required commands and intentionally skippable integration coverage.

Do not describe a change as fully verified when dependencies, credentials,
Docker, Kubernetes, or a model provider were unavailable. Record the exact
blocker instead. Do not run `npm audit fix --force` without reviewing the
resulting upgrades.

## Role B: project promotion

Promote SandBase Harness through useful, accurate, organic discovery. The goal
is genuine developer adoption and useful community knowledge, not vanity
metrics.

Documentation language, translation, and guide-completeness rules are in
[`CONTRIBUTING.md#documentation-and-language`](./CONTRIBUTING.md#documentation-and-language).

### Content

- Keep the README the fastest path to a working local runtime.
- Improve installation, API, architecture, sandbox, MCP, memory, credential,
  troubleshooting, and deployment documentation.
- Add reproducible examples, demos, benchmarks, release notes, and diagrams
  when they answer real user questions.
- Do not copy long passages from upstream documentation. Explain, test, and
  attribute instead.

### Community distribution

- Share relevant fixes, demos, and operational lessons in appropriate GitHub
  Discussions, Show & Tell threads, MCP/agent communities, and related Awesome
  lists only when the material directly helps that audience.
- Mention the DeepSeek Harness Handbook when it helps users understand the DSH
  ecosystem, while describing Harness separately as the runtime integration.
- Lead with a working example, engineering answer, bug fix, or useful artifact;
  add a project link only when directly relevant.
- Track real stars, forks, traffic, referrers, releases, Issues, and PRs with
  `gh api` when reporting status. Re-check changing metrics before publishing.

### Promotion status audit

For every external promotion recorded in `docs/promotion.md`:

1. Query the current PR or Issue state with `gh pr view` or `gh issue view`.
2. If a PR is merged, inspect the target repository's default branch and verify
   that the SandBase entry is still present before moving it to verified
   discovery.
3. If a PR is closed without merge, keep it out of verified discovery and
   record the closure reason when available.
4. Read new maintainer comments before opening another submission. Respond to
   actionable feedback once, with source links and an explicit disclosure of
   project affiliation.
5. Search the target repository for existing SandBase references before
   submitting. Do not create a duplicate PR when an open PR or public entry
   already exists.

Use `verified public discovery` only for a reachable public entry on the
target's current published branch or catalog. A submitted form, open PR,
generated preview, or stale cached page remains `pending` until that condition
is verified.

### Promotion boundaries

- Never spam, mass-comment, manufacture engagement, purchase or fake stars,
  impersonate upstream projects, or promise guaranteed growth.
- Never claim official DeepSeek, Anthropic, DSH, or community endorsement.
- Never expose API keys, credentials, personal paths, or private user data in
  promotional material.
- Never modify or delete another project's formal repository, active PR fork,
  or content without explicit authority.

## Communication and handoff

Use concise, factual comments. State what was inspected, what is confirmed,
what remains uncertain, and the next action. Link related Issues and PRs.

At the end of each maintenance or promotion session, record:

- current branch and repository baseline;
- Issues triaged and PRs reviewed, opened, or merged;
- files, commits, and external links changed;
- verification results and known warnings;
- open blockers and the next safe action.

Keep the current promotion handoff in [docs/promotion.md](docs/promotion.md),
and distinguish verified public listings from pending submissions.

Default authorization covers routine work inside this repository, but it does
not override platform permissions, required external approvals, secret
handling, or destructive-action safeguards. Stop and report when those are
needed.
