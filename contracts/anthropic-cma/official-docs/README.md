# Official CMA docs snapshot

A verbatim snapshot of the public Claude Managed Agents documentation,
crawled from `https://platform.claude.com/docs/en/managed-agents/*.md` (and
`agents-and-tools/mcp-tunnels/*.md`) on **2026-10-31**, and verified
byte-identical on a **2026-11-01** re-crawl (41 managed-agents pages plus 9
mcp-tunnels pages; no page added, removed, or changed upstream).

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
# Byte-diff every snapshot page against its live ".md" URL; exits non-zero on drift.
npm run docs:crawl
# Refresh each changed page in place (a page that went 404 stays manual — a 404
# can be a rename rather than a removal).
npm run docs:crawl -- --write
```

Each page is served as markdown at its docs URL plus ".md"
(`https://platform.claude.com/docs/en/managed-agents/<page>.md`), and the full
page list is the file set in this directory — the crawl diffs what is pinned,
so a page added upstream but never snapshotted is the one change it cannot
see. Remove stale pages when the upstream tree changes rather than adding
alongside them.

Licensing note: these files are Anthropic's published documentation kept for
local contract review. Do not copy their prose into SandBase docs — cite the
live URL instead (see CONTRIBUTING's no-long-passages rule).
