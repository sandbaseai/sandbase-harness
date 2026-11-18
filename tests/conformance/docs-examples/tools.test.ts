import { describe, it } from 'vitest';
import { assertDocsExampleRun, runDocsExample } from './harness.js';
import { getDocsExamplePage } from './manifest.js';

describe('official docs example: Tools (pinned official-docs snapshot)', () => {
  it('creates an agent with the documented toolset shape', async () => {
    const run = await runDocsExample(getDocsExamplePage('tools'));
    assertDocsExampleRun(run);
  }, 180_000);
});
