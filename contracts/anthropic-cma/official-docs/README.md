# Official CMA docs snapshot

A verbatim snapshot of the public Claude Managed Agents documentation,
crawled from `https://platform.claude.com/docs/en/managed-agents/*.md` (and
`agents-and-tools/mcp-tunnels/*.md`) on **2026-10-31**.

Purpose:

- Give the contract files in `../` a stable, reviewable baseline to diff
  against. Platform docs change without notice; every "official definition"
  claim in a contract file should be checkable against this snapshot.
- The snapshot is a reference input, not a source of truth in itself — when it
  and live docs disagree, re-crawl and update the snapshot plus the affected
  contract file in the same change.

Layout:

- `*.md` — the `managed-agents` doc tree, one file per published page.
- `mcp-tunnels/` — the `agents-and-tools/mcp-tunnels` doc tree (a separate
  URL family refused by this runtime; see [`../unsupported.md`](../unsupported.md)).

Re-crawling:

```sh
# Each page is served as markdown at its docs URL plus ".md":
curl -sSLO "https://platform.claude.com/docs/en/managed-agents/<page>.md"
```

The full page list is the file set in this directory; remove stale pages when
the upstream tree changes rather than adding alongside them.

Licensing note: these files are Anthropic's published documentation kept for
local contract review. Do not copy their prose into SandBase docs — cite the
live URL instead (see CONTRIBUTING's no-long-passages rule).
