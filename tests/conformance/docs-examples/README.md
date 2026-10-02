# Official documentation examples

This suite extracts the selected TypeScript snippets from a trusted local copy
of the Claude Managed Agents documentation and runs them with the pinned official
SDK against the real local Harness CLI. A local stub replaces the model provider;
it does not replace API routes, agent storage, or environment/session creation.

## Prerequisites and execution

Use Node.js 22 or later and install the repository dependencies with `npm ci`.
Set `CMA_DOCS_DIR` to the documentation root, retaining the relative filenames
listed in `manifest.ts`. The initial enabled pages are Console onboarding, tools,
and permission policies. Only their first TypeScript example is selected;
later examples are separate flows and remain outside this initial acceptance.

```powershell
$env:CMA_DOCS_DIR = 'C:\path\to\claude-managed-agents-docs'
npm run test:docs-examples
```

```sh
export CMA_DOCS_DIR=/path/to/claude-managed-agents-docs
npm run test:docs-examples
```

Success means three passing tests. Each selected example executes in a separate
process against its own temporary runtime, database, stub model server, and local
fixtures. The script timeout is 60 seconds. The harness captures script output and
runtime logs for failures and stops its processes and removes temporary files on
completion. No real model credentials, Docker daemon, or Kubernetes cluster are
required. Run only documentation you trust: these snippets are executable code,
and the local sandbox is not a security boundary.

## Digests, skips, and drift

Redistribution permission for the official documentation excerpts has not been
verified. This repository therefore stores only SHA-256 digests, not the excerpts
or a substitute copy. When `CMA_DOCS_DIR` is unset or blank, the three execution
tests explicitly skip. A configured but missing or changed document fails rather
than skipping. CI still runs the extraction, digest-drift, and script-generation
unit tests using independently authored fixtures.

An example's digest covers the extracted, selected code before any replacement.
Prose-only changes do not require a snapshot update. Changed code or a corrupted
digest fails with the page id, expected/current digests, and a review instruction.
Review the upstream changes and the selection/replacement rules before running:

```sh
npm run test:docs-examples:update-snapshots
npm run test:docs-examples
```

The update command requires `CMA_DOCS_DIR` and writes digests only. Do not update
digests merely to make a failure disappear. To roll back an unintended refresh,
restore the affected `.sha256` files with Git and rerun the suite.

## Scope and fixtures

The manifest records snippet selection and explains every placeholder replacement.
Replacements must not change SDK methods or request structures. The harness strips
the SDK import/client constructor to point requests at the local runtime and
disables ambient SDK authentication and retries. Local agent and environment
fixtures replace illustrative ids in Console onboarding. Future file, repository,
MCP, and webhook fixtures are deliberately unsupported until implemented.

Model ids in the selected snippets are unchanged. The initial three pages use
`claude-opus-5`, registered against the stub endpoint. A passing creation example
does not prove tool execution, an approval lifecycle, or real model behavior.

Verification date: 2026-10-02. The broader release gate is
`npm run release:check`; the documentation execution tests require the explicit
local-documents setting described above.
