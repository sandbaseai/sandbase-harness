import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { docsExamplePages } from './manifest.js';
import { extractDocsExampleSource, snapshotRoot } from './source.js';

const docsRoot = process.env.CMA_DOCS_DIR?.trim();
if (!docsRoot) throw new Error('Set CMA_DOCS_DIR to a trusted local documentation checkout before updating snapshots.');
const sources = docsExamplePages.filter((page) => page.status === 'enabled')
  .map((page) => ({ page, source: extractDocsExampleSource(page, docsRoot) }));
mkdirSync(snapshotRoot, { recursive: true });
for (const { page, source } of sources) {
  writeFileSync(join(snapshotRoot, `${page.id}.sha256`), `${source.hash}\n`, 'utf8');
  console.log(`${page.id}: ${source.hash}`);
}
