/**
 * Re-crawl the official CMA documentation snapshot and report drift.
 *
 *   node --import tsx scripts/crawl-cma-docs.ts
 *   node --import tsx scripts/crawl-cma-docs.ts --write
 *
 * The contract files in `contracts/anthropic-cma/` cite
 * `contracts/anthropic-cma/official-docs/` as their reviewable baseline. The
 * platform serves each doc page as markdown at its URL plus ".md", so a
 * re-crawl is a per-page fetch and a byte compare — no parsing, no rendering.
 *
 * The page set is the local snapshot's file list, not a fetched index: the
 * snapshot README declares "the full page list is the file set in this
 * directory", so the tool compares what is pinned and reports three outcomes
 * per page — `identical`, `changed`, or `missing` upstream (a 404). A page
 * added upstream but never snapshotted is invisible to a filename-driven
 * crawl and is the one case this cannot detect; the README's "remove stale
 * pages when the upstream tree changes" is the manual half of that check.
 *
 * Default mode is read-only and exits non-zero when any page drifts, so it can
 * gate a contract change. `--write` refreshes each changed page in place and
 * reports which it rewrote; deleting a page that went `missing` stays manual,
 * because a 404 can be a renamed page rather than a removed one.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_ROOT = join(repositoryRoot, 'contracts', 'anthropic-cma', 'official-docs');

/** The two URL families the snapshot covers, root-relative dir → URL prefix. */
const FAMILIES: Array<{ dir: string; base: string }> = [
  { dir: '', base: 'https://platform.claude.com/docs/en/managed-agents' },
  { dir: 'mcp-tunnels', base: 'https://platform.claude.com/docs/en/agents-and-tools/mcp-tunnels' },
];

const WRITE = process.argv.includes('--write');
/** Modest fan-out: enough to make 50 pages quick, not enough to trip the CDN. */
const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 20_000;

type Verdict = 'identical' | 'changed' | 'missing' | 'error';

interface PageResult {
  /** Snapshot-relative path, e.g. `scheduled-deployments.md` or `mcp-tunnels/overview.md`. */
  rel: string;
  url: string;
  verdict: Verdict;
  detail?: string;
}

/** List the snapshot's `.md` pages, excluding the README that documents it. */
function snapshotPages(): Array<{ rel: string; url: string; abs: string }> {
  const pages: Array<{ rel: string; url: string; abs: string }> = [];
  for (const { dir, base } of FAMILIES) {
    const root = join(SNAPSHOT_ROOT, dir);
    for (const entry of readdirSync(root)) {
      if (!entry.endsWith('.md') || entry === 'README.md') continue;
      const abs = join(root, entry);
      if (!statSync(abs).isFile()) continue;
      const rel = relative(SNAPSHOT_ROOT, abs);
      pages.push({ rel, url: `${base}/${entry}`, abs });
    }
  }
  return pages.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function fetchPage(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return { status: res.status, body: await res.text() };
}

async function crawlOne(page: { rel: string; url: string; abs: string }): Promise<PageResult> {
  let live: { status: number; body: string };
  try {
    live = await fetchPage(page.url);
  } catch (error) {
    return { rel: page.rel, url: page.url, verdict: 'error', detail: String(error) };
  }
  if (live.status === 404) {
    return { rel: page.rel, url: page.url, verdict: 'missing', detail: '404 upstream' };
  }
  if (live.status !== 200) {
    return { rel: page.rel, url: page.url, verdict: 'error', detail: `HTTP ${live.status}` };
  }
  const stored = readFileSync(page.abs, 'utf8');
  if (stored === live.body) {
    return { rel: page.rel, url: page.url, verdict: 'identical' };
  }
  const storedHash = createHash('sha256').update(stored, 'utf8').digest('hex').slice(0, 12);
  const liveHash = createHash('sha256').update(live.body, 'utf8').digest('hex').slice(0, 12);
  if (WRITE) {
    writeFileSync(page.abs, live.body);
    return { rel: page.rel, url: page.url, verdict: 'changed', detail: `rewrote (${storedHash} → ${liveHash})` };
  }
  return { rel: page.rel, url: page.url, verdict: 'changed', detail: `differs (${storedHash} → ${liveHash})` };
}

async function main() {
  const pages = snapshotPages();
  console.log(`crawling ${pages.length} snapshot pages${WRITE ? ' (--write)' : ''}\n`);

  const results: PageResult[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < pages.length) {
      const page = pages[cursor++];
      if (!page) return;
      const result = await crawlOne(page);
      results.push(result);
      const mark = { identical: '  ok', changed: '~ dif', missing: '! 404', error: 'x err' }[result.verdict];
      console.log(`${mark}  ${result.rel}${result.detail ? `  — ${result.detail}` : ''}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const tally = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  const drifted = results.filter((r) => r.verdict !== 'identical');
  console.log(
    `\n${tally('identical')} identical, ${tally('changed')} changed, ` +
      `${tally('missing')} missing, ${tally('error')} errored`,
  );

  if (drifted.length === 0) {
    console.log('snapshot is byte-identical to upstream');
    return;
  }
  if (!WRITE && tally('changed') > 0) {
    console.log('run with --write to refresh the changed pages in place');
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
