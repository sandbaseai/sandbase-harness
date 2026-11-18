import { describe, it } from 'vitest';
import { assertDocsExampleRun, runDocsExample } from './harness.js';
import { getDocsExamplePage } from './manifest.js';

describe('official docs example: Permission policies (pinned official-docs snapshot)', () => {
  it('creates an agent with the documented approval policy', async () => {
    const run = await runDocsExample(getDocsExamplePage('permission-policies'));
    assertDocsExampleRun(run);
  }, 180_000);
});
