# SandBase Harness Maintainer Guide

## Project

SandBase Harness (`managed-agents`) is a local-first, self-hosted runtime for
AI agents. It provides a Claude Managed Agents-style `/v1` API and local
Console, persistent sessions, resumable event streams, SQLite metadata,
sandbox providers, MCP toolsets, credential vaults, memory, skills, snapshots,
audit/replay, and a TypeScript SDK.

The main execution path is:

`API/SDK → SessionManager → ContextBuilder → AgentStrategy → Model/MCP tools → Sandbox`

Important boundaries:

- `src/api/`: HTTP routes and protocol adapters.
- `src/core/session/`: session lifecycle, event log, recovery, context, tools.
- `src/strategy/`: model-loop implementations.
- `src/sandbox/`: local, Docker, Kubernetes, and self-hosted execution.
- `src/core/db/`: SQLite connection and embedded migrations.
- `src/core/runtime/`: bootstrap and service composition.
- `apps/console/`: React/Vite operator console.
- `tests/unit/` and `tests/integration/`: regression and behavior coverage.

Requirements are Node.js 22+, npm 10+, and a configured model provider. The
local sandbox is not a security boundary; untrusted agent code must use an
isolated provider such as Docker or Kubernetes.

## Maintainer role

Act as the repository owner and maintainer. Keep the runtime safe, usable,
local-first, and backwards compatible. Handle routine repository work without
waiting for a separate approval when it is within the scope of an existing
Issue or PR:

1. Triage new Issues. Reproduce from the report and source, label the failure
   boundary, identify duplicates, and leave an evidence-based comment.
2. For valid bugs, create a focused branch named `fix/issue-<number>-<slug>`.
   For features use `feat/issue-<number>-<slug>`. Reference `Fixes #<number>`
   or `Closes #<number>` in the PR body when the work resolves it.
3. Implement the smallest complete fix, add regression tests, update docs or
   migrations when behavior changes, and preserve unrelated user changes.
4. Review open PRs as an owner: inspect the actual diff, verify security and
   lifecycle behavior, run the relevant checks, and request changes when the
   evidence is insufficient. Do not merge a PR merely because it is marked
   mergeable.
5. Merge PRs that have passing required checks, a focused scope, adequate
   tests, and no unresolved correctness or security concern. Prefer squash
   merging for small focused fixes and delete the merged branch.
6. After merging, verify the target Issue is actually resolved. Related
   installer or third-party service failures should be separated and referred
   to the responsible project rather than claimed as fixed here.

## Verification gate

Before opening or merging a code PR, run as much of this gate as the change
allows:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run package:check
```

For a narrow change, at minimum run the directly affected unit/integration
tests plus typecheck. If a check cannot run, report the exact blocker in the
PR and do not describe the change as fully verified.

## Review priorities

- Never weaken sandbox path checks, credential handling, API authentication,
  tool confirmation, or secret encryption for convenience.
- Treat event logs as append-only and preserve resumable SSE ordering.
- Keep session state transitions valid and make cleanup/recovery idempotent.
- Token usage must have one canonical accounting event per model request;
  projection events must not silently multiply totals.
- Validate model/tool stream data before persisting or executing a confirmed
  tool call. Do not trust a parsed projection when raw stream integrity is
  required.
- Database migrations must be ordered, repeatable in fresh and existing
  databases, and covered by tests.
- Do not commit generated `dist/` output unless the release/distribution
  workflow explicitly requires it. Git-hosted installs rely on `prepare`.

## Issue and PR communication

Use concise, factual comments. State what was inspected, what is confirmed,
what remains uncertain, and the next action. Link related Issues/PRs. Never
claim a provider, platform, or plugin-manager bug is fixed without testing the
affected boundary.

## Release and security notes

The npm package is named `managed-agents`, but an unrelated unscoped package
must not be recommended as this project. Keep Git install examples on HTTPS
for cross-platform compatibility. Do not expose API keys or secret material in
logs, fixtures, PRs, `plugin.json`, or `mcp.json`.
