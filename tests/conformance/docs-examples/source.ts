import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTypeScriptSnippets, selectTypeScriptSnippets } from './extract.js';
import { resolveSnippetSelections, type DocsExamplePage } from './manifest.js';

const thisDir = dirname(fileURLToPath(import.meta.url));

/**
 * The pinned upstream snapshot this suite is keyed to. The selected snippets
 * are read from `contracts/anthropic-cma/official-docs/` — the same
 * byte-pinned baseline the contract layer aligns against — so the oracle
 * fails when upstream drifts (caught by `npm run docs:crawl`) *and* when the
 * runtime deviates from a snippet it claims to conform to.
 *
 * `CMA_DOCS_DIR` still overrides the root for a manual drift-check against a
 * live documentation checkout, but it is no longer required: the committed
 * snapshot is the default and the suite always runs.
 */
export const officialDocsRoot = resolve(thisDir, '..', '..', '..', 'contracts', 'anthropic-cma', 'official-docs');

export const snapshotRoot = join(thisDir, 'snapshots');

export interface DocsExampleSource {
  text: string;
  hash: string;
}

interface SourceOptions {
  docsRoot?: string;
  snapshotsRoot?: string;
}

export function extractDocsExampleSource(page: DocsExamplePage, docsRoot: string): DocsExampleSource {
  const documentPath = resolve(docsRoot, page.doc);
  const documentRelativePath = relative(resolve(docsRoot), documentPath);
  if (documentRelativePath === '..' || documentRelativePath.startsWith(`..${sep}`)
    || isAbsolute(documentRelativePath)) {
    throw new Error(`Documentation page escapes the docs root: ${page.doc}`);
  }
  const snippets = extractTypeScriptSnippets(readFileSync(documentPath, 'utf8'));
  const selected = resolveSnippetSelections(page);
  const indexes = selected.length > 0 ? selected.map((selection) => selection.index) : undefined;
  const text = selectTypeScriptSnippets(snippets, indexes);
  if (!text.trim()) throw new Error(`No TypeScript snippets selected for ${page.id}`);
  return { text, hash: createHash('sha256').update(text, 'utf8').digest('hex') };
}

export function loadDocsExampleSource(page: DocsExamplePage, options: SourceOptions = {}): DocsExampleSource {
  // CMA_DOCS_DIR is an override for a manual drift check; the committed
  // official-docs snapshot is the default source of truth.
  const docsRoot = (options.docsRoot ?? process.env.CMA_DOCS_DIR)?.trim() || officialDocsRoot;
  const snapshotPath = join(options.snapshotsRoot ?? snapshotRoot, `${page.id}.sha256`);
  const expectedHash = readFileSync(snapshotPath, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error(`Invalid docs example snapshot for ${page.id}`);
  const source = extractDocsExampleSource(page, docsRoot);
  if (source.hash !== expectedHash) {
    throw new Error([
      `Official documentation changed for ${page.id}.`,
      `  document: ${page.doc}`,
      `  expected snapshot: ${expectedHash}`,
      `  current document: ${source.hash}`,
      'Review the selected snippets and replacements, then run npm run test:docs-examples:update-snapshots.',
    ].join('\n'));
  }
  return source;
}
