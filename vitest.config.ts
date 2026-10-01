import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec,prop}.{ts,tsx}'],
    // Declare the per-test budget instead of inheriting vitest's implicit
    // 5000ms. A slow Windows machine can be roughly ten times slower than a
    // fast developer machine on this suite:
    // tests/unit/runtime-session-runtime.test.ts has measured 0.4s per test on
    // one and 3.9s per test on the other, so those tests sit against the
    // default and the vitest 5 upgrade pushed 32 tests across 11 files over it.
    // The heaviest suites in this repository declare their own budgets
    // (tests/integration/github-materialization-real.test.ts uses 60s, the
    // Kubernetes suites 240-300s); this is the budget for the rest, and it
    // still fails a genuinely hung test.
    testTimeout: 30_000,
    // The same budget for setup and teardown. `testTimeout` above does not
    // cover a hook — `hookTimeout` has its own implicit default of 10000ms —
    // so a machine slow enough to need the larger per-test budget could still
    // fail in `beforeEach`, and the failure is then reported against whichever
    // test happened to be running rather than against the shared setup that
    // actually timed out. Almost every suite here sets up a temporary database
    // and runs migrations in a hook, which is the heaviest single step in the
    // file, so holding setup to a *smaller* budget than the test it prepares is
    // the wrong way round. A genuinely hung hook still fails, at 30s instead of 10s.
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types/**/*.ts'],
    },
  },
});
