# Official documentation examples

This suite extracts the selected TypeScript snippets from the pinned
`contracts/anthropic-cma/official-docs/` snapshot — the same byte-pinned
upstream the contract layer aligns against — and runs them with the pinned
official SDK against the real local Harness CLI. A local stub replaces the
model provider; it does not replace API routes, agent storage, or
environment/session creation.

Because the source is the committed snapshot, the suite is an honest oracle:
it fails when upstream drifts (also caught by `npm run docs:crawl`) *and* when
the runtime deviates from a snippet it claims to conform to.

## Prerequisites and execution

Use Node.js 22 or later and install the repository dependencies with `npm ci`.
No `CMA_DOCS_DIR` is required — the committed snapshot is the default docs
root, so the suite always runs rather than silently skipping. Set
`CMA_DOCS_DIR` only to drift-check the selected snippets against a live
documentation checkout; the digest mismatch then names the changed page.

The initial enabled pages are onboarding, tools, and permission policies.
Only their selected TypeScript snippets run; the manifest records the index
and the verdict for each.

```sh
npm run test:docs-examples
```

Success means the enabled pages' snippets all execute cleanly. Each selected
example executes in a separate process against its own temporary runtime,
database, stub model server, and local fixtures. The script timeout is 60
seconds. The harness captures script output and runtime logs for failures and
stops its processes and removes temporary files on completion. No real model
credentials, Docker daemon, or Kubernetes cluster are required.

## Per-snippet verdicts

Each selected snippet carries a verdict in `manifest.ts`:

- **`conforms`** — the runtime is expected to reproduce the published
  behaviour; the test asserts the documented call succeeds.
- **`deviation`** — the runtime intentionally diverges, and the verdict names
  the contract §4 row that records the difference. A deviation snippet asserts
  the *recorded* difference, never upstream conformance — a deviation dressed
  as conformance is exactly what this verdict exists to prevent.

A bare `snippets: [0]` entry is shorthand for `{ index: 0, verdict:
{ kind: 'conforms' } }`.

## Digests and drift

The committed `snapshots/<page>.sha256` files pin the extracted, selected
snippet text from the `official-docs/` snapshot. Prose-only changes do not
require a snapshot update. Changed code or a corrupted digest fails with the
page id, expected/current digests, and a review instruction. When upstream
drift is intentional, review the upstream changes and the
selection/replacement rules, then run:

```sh
npm run test:docs-examples:update-snapshots
npm run test:docs-examples
```

The update command reads the pinned snapshot (or `CMA_DOCS_DIR` when set for a
re-baseline) and writes digests only. Do not update digests merely to make a
failure disappear. To roll back an unintended refresh, restore the affected
`.sha256` files with Git and rerun the suite.

## Scope and fixtures

The manifest records snippet selection and explains every placeholder
replacement. Replacements must not change SDK methods or request structures.
The harness strips the SDK import/client constructor to point requests at the
local runtime and disables ambient SDK authentication and retries. Local agent
and environment fixtures replace illustrative ids in the onboarding example.
Future file, repository, MCP, and webhook fixtures are deliberately
unsupported until implemented.

Model ids in the selected snippets are unchanged. The initial pages use the
model ids the docs print (`claude-opus-5-5`), which the runtime accepts
against the stub endpoint. A passing creation example does not prove tool
execution, an approval lifecycle, or real model behavior.

## Live-model validation

`scripts/docs-examples-live.mjs` reuses this suite but swaps the stub model
server for the real Anthropic provider, so the same enabled snippets prove
actual model behavior rather than provider-shape compatibility. It needs the
operator's own key and is never run in CI:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
node --import tsx scripts/docs-examples-live.mjs
```

`DOCS_EXAMPLES_LIVE_MODEL` overrides the default model (`claude-sonnet-4-6`),
and `DOCS_EXAMPLES_LIVE_BASE_URL` points the provider at an
Anthropic-compatible endpoint (relay, gateway, or proxy). A custom endpoint is
recorded in the evidence file's environment line so the run cannot be mistaken
for api.anthropic.com. Each page still gets its own temporary runtime and
workspace, and the script writes a summary table to
`docs/test-evidence/live-docs-examples-<date>.md` — one row per page with the
exit code, duration, the session's usage buckets (including cache reads and
writes, which is where a cache hit would show), final status, and stop_reason,
plus the Node/SDK versions and runtime commit. The key, request bodies, and
model reply text are never recorded, so the evidence file is safe to commit.

The broader release gate is `npm run release:check`; the documentation
execution tests run in the required `npm test` path because their source is
the committed snapshot.
