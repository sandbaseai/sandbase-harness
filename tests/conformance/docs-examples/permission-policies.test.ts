import { describe, expect, it } from 'vitest';
import { runDocsExample } from './harness.js';
import { getDocsExamplePage } from './manifest.js';

describe.skipIf(!process.env.CMA_DOCS_DIR?.trim())('official docs example: Permission policies (requires CMA_DOCS_DIR)', () => {
  it('creates an agent with the documented approval policy', async () => {
    const run = await runDocsExample(getDocsExamplePage('permission-policies'));
    expect(run.stderr, run.stdout).toBe('');
    expect(run.code, `${run.stdout}\n${run.stderr}\n--- runtime ---\n${run.runtimeOutput}`).toBe(0);
  }, 180_000);
});
