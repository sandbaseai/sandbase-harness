import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTypeScriptSnippets, selectTypeScriptSnippets } from './extract.js';
import type { DocsExamplePage } from './manifest.js';

export const snapshotRoot = join(dirname(fileURLToPath(import.meta.url)), 'snapshots');

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
    throw new Error(`Documentation page escapes CMA_DOCS_DIR: ${page.doc}`);
  }
  const snippets = extractTypeScriptSnippets(readFileSync(documentPath, 'utf8'));
  const text = selectTypeScriptSnippets(snippets, page.snippets);
  if (!text.trim()) throw new Error(`No TypeScript snippets selected for ${page.id}`);
  return { text, hash: createHash('sha256').update(text, 'utf8').digest('hex') };
}

export function loadDocsExampleSource(page: DocsExamplePage, options: SourceOptions = {}): DocsExampleSource {
  const docsRoot = (options.docsRoot ?? process.env.CMA_DOCS_DIR)?.trim();
  if (!docsRoot) {
    throw new Error('CMA_DOCS_DIR is required: official documentation excerpts are not redistributed in this repository.');
  }
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
