import { defineConfig, devices } from '@playwright/test';

/**
 * Console E2E smoke (WP5 F13). One Chromium project, one ordered scenario in
 * `tests/e2e/console-smoke.spec.ts`; the spec starts the stub model server,
 * the real runtime, and the Vite dev server itself, so this config only
 * describes the browser run. `npm run test:e2e` invokes it — the suite is a
 * separate CI job and intentionally not part of `release:check`, so local
 * development does not need a browser download.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  // The scenario spawns a tsx runtime, waits for health, and lets a turn run
  // to completion — none of that is fast, so the default 30s is far too tight.
  timeout: 180_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
