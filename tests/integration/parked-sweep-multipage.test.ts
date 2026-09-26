/**
 * Integration test: the bounded-parked-wait sweep crosses more than one page.
 *
 * `parked-wait-sweep.ts:69-73` states a rule and explains the bug it prevents:
 * "Always re-read the first page rather than walking page numbers. Ending a
 * session removes it from `requires_action`, which shifts every later row down
 * by one — so a forward walk would step over the row that moved into the slot it
 * just left. Re-reading stops when a pass ends nothing."
 *
 * That defence is invisible to the existing suite. `parked-wait-timeout.test.ts`
 * covers the bound itself thoroughly — indefinite by default, the coded error on
 * expiry, the ceiling exclusion (D23), idempotence, several sessions in one pass
 * — but every case seeds a handful of sessions, so the first page always contains
 * all of them and the re-read loop only ever runs its second iteration to observe
 * zero and break. A regression to "fetch page 1, then page 2" would skip exactly
 * the rows that shifted up, leaving those sessions parked forever, and **every
 * existing assertion would still pass**: the sessions the first page happened to
 * hold are still ended, and the count assertions are all inside one page.
 *
 * With `SCAN_PAGE_SIZE = 200`, the boundary is one more than a page. Both cases
 * below seed 205 expired sessions, so the sweep must re-read rather than advance:
 * a single forward pass can only ever see the first 200.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { sweepExpiredParkedWaits } from '@/core/operations/parked-wait-sweep.js';
import { REQUIRES_ACTION_TIMEOUT_OPTION } from '@/core/settings/adapters.js';
import {
  activateRuntimeSettings,
  getOrSeedRuntimeSettings,
  saveRuntimeSettings,
} from '@/core/settings/store.js';
import type { CostProfile } from '@/core/session/cost-profile.js';

const PROFILE: CostProfile = {
  id: 'test',
  models: { 'model-priced': { input_per_mtok_cents: 1000, output_per_mtok_cents: 1000 } },
  web_search_per_1000_cents: 0,
  active_hour_cents: 0,
};

const NOW = new Date('2026-09-24T12:00:00.000Z');
/** One more than the sweep's page size, so a single forward pass cannot see them all. */
const OVER_ONE_PAGE = 205;

describe('Bounded parked wait across more than one page', () => {
  let db: Database | undefined;
  let workspace: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  });

  function setUp(): { db: Database; manager: SessionManager; workspace: string } {
    workspace = mkdtempSync(join(process.env.TEMP ?? process.cwd(), 'ma-parked-multipage-'));
    const database = new Database(join(workspace, 'test.db'));
    database.runMigrations();
    database.exec("INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')");
    database.exec("INSERT INTO agents (id, name, definition) VALUES ('agent_parked', 'parked-agent', '{}')");
    const sessionManager = new SessionManager(database);
    sessionManager.setCostProfile(PROFILE);
    db = database;
    return { db: database, manager: sessionManager, workspace };
  }

  function setBound(database: Database, seconds: number, dir: string): void {
    const initial = getOrSeedRuntimeSettings(database, {}, dir);
    const changed = {
      ...initial.saved_config,
      model: { ...initial.saved_config.model, api_key: 'model-secret' },
      loop_engine: {
        provider: 'builtin' as const,
        options: { ...initial.saved_config.loop_engine.options, [REQUIRES_ACTION_TIMEOUT_OPTION]: seconds },
      },
    };
    const saved = saveRuntimeSettings(database, changed, initial.revision, dir);
    if (!saved.ok) throw new Error(`settings save refused: ${saved.reason}`);
    const activated = activateRuntimeSettings(database, {}, dir);
    if (activated.activation_status === 'failed') {
      throw new Error(`settings activation failed: ${JSON.stringify(activated.activation_errors)}`);
    }
  }

  /** Park a session the way the model loop does, then set the status. */
  function park(
    database: Database,
    sessionManager: SessionManager,
    blockId: string,
    parkedAt: Date,
  ): string {
    const session = sessionManager.create({ agent: 'agent_parked' });
    sessionManager.getEventLogger().append(session.id, {
      type: 'agent.custom_tool_use',
      content: [{ type: 'tool_use', id: blockId, name: 'lookup_customer', input: {} }] as never,
    });
    database.prepare('UPDATE events SET created_at = ? WHERE session_id = ?')
      .run(parkedAt.toISOString(), session.id);
    database.prepare("UPDATE sessions SET status='requires_action' WHERE id=?").run(session.id);
    return session.id;
  }

  it('ends every expired session when there are more than a page of them', () => {
    const { db: database, manager: sessionManager, workspace: dir } = setUp();
    setBound(database, 300, dir);

    const expired: string[] = [];
    for (let i = 0; i < OVER_ONE_PAGE; i++) {
      expired.push(park(database, sessionManager, `custom_${i}`, new Date(NOW.getTime() - 500_000)));
    }

    const ended = sweepExpiredParkedWaits({ db: database, sessionManager, dataDir: dir, now: NOW });

    // Every one of them, not just the first page's worth.
    expect(ended).toHaveLength(OVER_ONE_PAGE);
    expect(new Set(ended)).toEqual(new Set(expired));
    const stillParked = sessionManager.list({ status: 'requires_action', page: 1, pageSize: 1000 });
    expect(stillParked.data).toHaveLength(0);
  }, 60_000);

  it('sweeps several pages without ending a session whose bound has not passed', () => {
    const { db: database, manager: sessionManager, workspace: dir } = setUp();
    setBound(database, 300, dir);

    for (let i = 0; i < OVER_ONE_PAGE; i++) {
      park(database, sessionManager, `custom_${i}`, new Date(NOW.getTime() - 500_000));
    }
    const fresh = park(database, sessionManager, 'custom_fresh', new Date(NOW.getTime() - 10_000));

    const ended = sweepExpiredParkedWaits({ db: database, sessionManager, dataDir: dir, now: NOW });

    // Crossing pages must not become over-reach: the unexpired session is the one
    // the re-read loop has to keep seeing and keep leaving alone.
    expect(ended).toHaveLength(OVER_ONE_PAGE);
    expect(ended).not.toContain(fresh);
    expect(sessionManager.get(fresh)?.status).toBe('requires_action');
  }, 60_000);
});
