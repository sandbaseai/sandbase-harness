import { describe, expect, it } from 'vitest';
import { runDocsExample } from './harness.js';
import { getDocsExamplePage } from './manifest.js';

describe.skipIf(!process.env.CMA_DOCS_DIR?.trim())('official docs example: Console build (requires CMA_DOCS_DIR)', () => {
  it('creates a session through the official SDK', async () => {
    const run = await runDocsExample(getDocsExamplePage('console-build'));
    expect(run.stderr, run.stdout).toBe('');
    expect(run.code, `${run.stdout}\n${run.stderr}\n--- runtime ---\n${run.runtimeOutput}`).toBe(0);
  }, 180_000);
});
