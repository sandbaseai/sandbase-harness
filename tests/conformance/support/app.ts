/**
 * The shared driver for `tests/conformance/`.
 *
 * Two suites had grown their own copy of this setup, which is the point at which
 * a third copy becomes likely and the setups start to disagree — and a
 * conformance suite whose apps are built differently from each other proves less
 * than it appears to, because a difference in the harness reads as a difference
 * in the runtime.
 *
 * The contract is deliberately small and is asserted by
 * `support/driver-contract.test.ts` rather than described here: migrations run,
 * the `env_default` environment row exists, no agent rows are seeded, and no API
 * key is configured so authentication stays off. Each call gets its own temp
 * directory and its own database, and `disposeConformanceContexts` is the other
 * half of `makeConformanceApp` — teardown belongs with setup, or suites drift
 * into leaking temp directories differently.
 *
 * What this driver deliberately does **not** do: start a real HTTP listener
 * (the suites use `app.request`, which exercises the same router without a
 * port), and configure a model provider, which no shape-layer suite needs.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '@/api/server.js';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { WorkQueue } from '@/sandbox/self-hosted-provider.js';

export interface ConformanceContext {
  app: ReturnType<typeof createServer>;
  db: Database;
  tmpDir: string;
}

export function makeConformanceApp(prefix = 'ma-conformance-'): ConformanceContext {
  const tmpDir = mkdtempSync(join(tmpdir(), prefix));
  const db = new Database(join(tmpDir, 'test.db'));
  db.runMigrations();
  db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
  const app = createServer({
    db,
    sessionManager: new SessionManager(db),
    agents: [],
    reloadAgents: () => ({ agents: [], errors: [] }),
    // The official Work data plane mounts only when a queue exists; without one
    // here the conformance suite would report the implemented routes missing.
    workQueue: new WorkQueue(db),
  });
  return { app, db, tmpDir };
}

/** Close and remove every context a suite opened, and empty the list. */
export function disposeConformanceContexts(contexts: ConformanceContext[]): void {
  for (const ctx of contexts.splice(0)) {
    ctx.db.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
}
