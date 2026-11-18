import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { docsExamplePages } from './manifest.js';
import { extractDocsExampleSource, officialDocsRoot, snapshotRoot } from './source.js';

// Default to the pinned snapshot; CMA_DOCS_DIR remains an override for a
// deliberate re-baseline against a live documentation checkout, which the
// digest diff then records.
const docsRoot = process.env.CMA_DOCS_DIR?.trim() || officialDocsRoot;
const sources = docsExamplePages.filter((page) => page.status === 'enabled')
  .map((page) => ({ page, source: extractDocsExampleSource(page, docsRoot) }));
mkdirSync(snapshotRoot, { recursive: true });
for (const { page, source } of sources) {
  writeFileSync(join(snapshotRoot, `${page.id}.sha256`), `${source.hash}\n`, 'utf8');
  console.log(`${page.id}: ${source.hash}`);
}
