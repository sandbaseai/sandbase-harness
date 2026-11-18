import { describe, it } from 'vitest';
import { assertDocsExampleRun, runDocsExample } from './harness.js';
import { getDocsExamplePage } from './manifest.js';

describe('official docs example: Console build (pinned official-docs snapshot)', () => {
  it('creates a session through the official SDK', async () => {
    const run = await runDocsExample(getDocsExamplePage('console-build'));
    assertDocsExampleRun(run);
  }, 180_000);
});
