import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractTypeScriptSnippets, selectTypeScriptSnippets } from '../conformance/docs-examples/extract.js';
import { renderDocsExampleScript } from '../conformance/docs-examples/harness.js';
import { docsExamplePages, getDocsExamplePage, type DocsExamplePage } from '../conformance/docs-examples/manifest.js';
import { loadDocsExampleSource } from '../conformance/docs-examples/source.js';

const temporaryRoots: string[] = [];
const page: DocsExamplePage = { id: 'unit-example', doc: 'example.md', status: 'enabled' };

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(text = 'console.log("local fixture");') {
  const root = mkdtempSync(join(tmpdir(), 'ma-docs-examples-unit-'));
  temporaryRoots.push(root);
  const docsRoot = join(root, 'docs');
  const snapshotsRoot = join(root, 'snapshots');
  mkdirSync(docsRoot);
  mkdirSync(snapshotsRoot);
  writeFileSync(join(docsRoot, page.doc), `\`\`\`typescript\n${text}\n\`\`\`\n`, 'utf8');
  const hash = createHash('sha256').update(text).digest('hex');
  writeFileSync(join(snapshotsRoot, `${page.id}.sha256`), `${hash}\n`, 'utf8');
  return { docsRoot, snapshotsRoot, hash };
}

describe('documentation example extraction', () => {
  it('extracts TypeScript fences in order with indentation, labels, and CRLF', () => {
    const markdown = '```python\nignored()\n```\n  ```typescript TypeScript\nconst first = 1;\n  ```\n```ts\nconst second = 2;\n```\n';
    expect(extractTypeScriptSnippets(markdown.replaceAll('\n', '\r\n'))).toEqual(['const first = 1;', 'const second = 2;']);
  });

  it('preserves snippet contents and selects only the configured snippets', () => {
    expect(selectTypeScriptSnippets(['first()', 'second()', 'third()'], [2, 0])).toBe('third()\n\nfirst()');
    expect(selectTypeScriptSnippets(['first()', 'second()'])).toBe('first()\n\nsecond()');
  });

  it('rejects an unclosed TypeScript fence', () => {
    expect(() => extractTypeScriptSnippets('```typescript\nunfinished()')).toThrow('Unclosed');
  });

  it.each([-1, 1, 0.5])('rejects an invalid snippet index %s', (index) => {
    expect(() => selectTypeScriptSnippets(['example()'], [index])).toThrow('out of range');
  });
});

describe('documentation example snapshots', () => {
  it('loads a local document whose extracted text matches the committed digest', () => {
    const options = fixture();
    expect(loadDocsExampleSource(page, options)).toEqual({ text: 'console.log("local fixture");', hash: options.hash });
  });

  it('refuses to run without local docs rather than silently substituting examples', () => {
    expect(() => loadDocsExampleSource(page, { docsRoot: '' })).toThrow('CMA_DOCS_DIR is required');
  });

  it('detects a deliberately changed snapshot and explains how to review and update it', () => {
    const options = fixture();
    writeFileSync(join(options.snapshotsRoot, `${page.id}.sha256`), `${'0'.repeat(64)}\n`);
    expect(() => loadDocsExampleSource(page, options)).toThrow('Official documentation changed');
    expect(() => loadDocsExampleSource(page, options)).toThrow('test:docs-examples:update-snapshots');
  });

  it('detects changes to selected documentation snippets', () => {
    const options = fixture();
    writeFileSync(join(options.docsRoot, page.doc), '```typescript\nconsole.log("changed");\n```\n');
    expect(() => loadDocsExampleSource(page, options)).toThrow('Official documentation changed');
  });

  it('ignores prose changes outside the selected snippets', () => {
    const options = fixture();
    writeFileSync(join(options.docsRoot, page.doc), 'Changed prose\n```typescript\nconsole.log("local fixture");\n```\n');
    expect(loadDocsExampleSource(page, options).hash).toBe(options.hash);
  });

  it('rejects malformed snapshots and documents without code', () => {
    const options = fixture();
    writeFileSync(join(options.snapshotsRoot, `${page.id}.sha256`), 'not-a-digest\n');
    expect(() => loadDocsExampleSource(page, options)).toThrow('Invalid docs example snapshot');
    writeFileSync(join(options.snapshotsRoot, `${page.id}.sha256`), `${options.hash}\n`);
    writeFileSync(join(options.docsRoot, page.doc), 'No executable example');
    expect(() => loadDocsExampleSource(page, options)).toThrow('No TypeScript snippets');
  });

  it('rejects documentation paths outside the configured root', () => {
    const options = fixture();
    expect(() => loadDocsExampleSource({ ...page, doc: '../outside.md' }, options)).toThrow('escapes CMA_DOCS_DIR');
  });
});

describe('documentation example script generation', () => {
  it('removes only the SDK bootstrap, including multiline options, without changing API calls', () => {
    const source = [
      'import Anthropic from "@anthropic-ai/sdk";',
      'import { join } from "node:path";',
      'const client = new Anthropic({',
      '  apiKey: "documentation-placeholder",',
      '  baseURL: String("documentation-placeholder"),',
      '});',
      'const result = await client.beta.agents.list();',
      'console.log(join("one", "two"), result);',
    ].join('\n');
    const script = renderDocsExampleScript(page, source);
    expect(script.match(/import Anthropic/g)).toHaveLength(1);
    expect(script.match(/const client = new Anthropic/g)).toHaveLength(1);
    expect(script).not.toContain('documentation-placeholder');
    expect(script).toContain('import { join } from "node:path";');
    expect(script).toContain('const result = await client.beta.agents.list();');
    expect(script).toContain('authToken: null');
  });

  it('replaces only declared placeholders and supplies requested local fixtures', () => {
    const configured: DocsExamplePage = {
      ...page,
      fixtures: ['agent', 'environment'],
      replacements: [{ from: 'PLACEHOLDER', to: 'fixtureAgent.id', why: 'Use the locally created agent.' }],
    };
    const script = renderDocsExampleScript(configured, 'console.log(PLACEHOLDER);');
    expect(script).toContain('const fixtureAgent = await client.beta.agents.create(');
    expect(script).toContain('const fixtureEnvironment = await client.beta.environments.create(');
    expect(script).toContain('console.log(fixtureAgent.id);');
    expect(script).not.toContain('PLACEHOLDER');
  });

  it('preserves an API call on the same line as the removed client constructor', () => {
    const script = renderDocsExampleScript(page, 'const client = new Anthropic({}); await client.beta.agents.list();');
    expect(script).toContain('await client.beta.agents.list();');
    expect(script.match(/const client = new Anthropic/g)).toHaveLength(1);
  });

  it('does not retain global regex state across runs', () => {
    const configured: DocsExamplePage = {
      ...page,
      replacements: [{ from: /PLACEHOLDER/g, to: 'localValue', why: 'Use a fixture value.' }],
    };
    expect(renderDocsExampleScript(configured, 'PLACEHOLDER; PLACEHOLDER;'))
      .toBe(renderDocsExampleScript(configured, 'PLACEHOLDER; PLACEHOLDER;'));
  });

  it('rejects stale replacements and fixtures that have not been implemented', () => {
    expect(() => renderDocsExampleScript({ ...page, replacements: [{ from: 'missing', to: 'local', why: 'Fixture substitution.' }] }, 'console.log(1);'))
      .toThrow('replacement did not match');
    expect(() => renderDocsExampleScript({ ...page, fixtures: ['mcp_server'] }, 'console.log(1);'))
      .toThrow('Unsupported docs example fixture');
  });

  it('enables exactly the initial three pages and rejects unknown or pending entries', () => {
    expect(docsExamplePages.filter((entry) => entry.status === 'enabled').map((entry) => entry.id))
      .toEqual(['console-build', 'tools', 'permission-policies']);
    expect(getDocsExamplePage('tools').doc).toBe('定义您的智能体/工具.md');
    expect(() => getDocsExamplePage('not-a-page')).toThrow('Unknown');
    expect(() => getDocsExamplePage('quickstart')).toThrow('not enabled');
    expect(new Set(docsExamplePages.map((entry) => entry.id)).size).toBe(docsExamplePages.length);
    expect(docsExamplePages.filter((entry) => entry.status === 'enabled').every((entry) => entry.selectionReason)).toBe(true);
  });
});
