/**
 * Unit tests for the Database layer and migrations.
 * Validates: Property 17 — migration idempotency (Requirement 8.4).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { MIGRATIONS } from '@/core/db/migrations.js';

/** The columns of one table, as SQLite reports them. */
function columnsOf(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

describe('Database migrations', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-db-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates all expected tables on first run', () => {
    const db = new Database(dbPath);
    db.runMigrations();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain('agents');
    expect(names).toContain('environments');
    expect(names).toContain('sessions');
    expect(names).toContain('events');
    expect(names).toContain('compaction_boundaries');
    expect(names).toContain('models');
    expect(names).toContain('snapshots');
    expect(names).toContain('memories');
    expect(names).toContain('runtime_settings');
    expect(names).toContain('runtime_settings_secrets');
    expect(names).toContain('_migrations');
    db.close();
  });

  it('is idempotent — running migrations repeatedly is a no-op (Property 17)', () => {
    const db = new Database(dbPath);
    db.runMigrations();

    // Insert some data
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_x', 'x', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')`);

    // Run migrations again — should not error, drop tables, or lose data
    db.runMigrations();
    db.runMigrations();

    const envCount = (db.prepare('SELECT COUNT(*) as c FROM environments').get() as { c: number }).c;
    const agentCount = (db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number }).c;
    const migrationCount = (db.prepare('SELECT COUNT(*) as c FROM _migrations').get() as { c: number }).c;
    const distinctMigrations = (db.prepare('SELECT COUNT(DISTINCT version) as c FROM _migrations').get() as { c: number }).c;

    expect(envCount).toBe(1);
    expect(agentCount).toBe(1);
    // Each migration recorded exactly once regardless of how many times run
    expect(migrationCount).toBe(distinctMigrations);
    db.close();
  });

  it('persists data across reopen', () => {
    const db1 = new Database(dbPath);
    db1.runMigrations();
    db1.exec(`INSERT INTO environments (id, name, config) VALUES ('env_p', 'persist', '{}')`);
    db1.close();

    const db2 = new Database(dbPath);
    db2.runMigrations(); // should detect already-applied, not recreate
    const row = db2.prepare('SELECT name FROM environments WHERE id = ?').get('env_p') as { name: string };
    expect(row.name).toBe('persist');
    db2.close();
  });

  it('adds the Pi session binding columns to a fresh workspace and to an existing one', () => {
    // Fresh: the two columns exist as soon as migrations run.
    const fresh = new Database(dbPath);
    fresh.runMigrations();
    expect(columnsOf(fresh, 'pi_session_state')).toEqual(expect.arrayContaining(['work_dir', 'policy_fingerprint']));
    expect(fresh.prepare('SELECT name FROM _migrations WHERE version = 41').get()).toEqual({
      name: '041_pi_session_policy_binding',
    });
    fresh.close();

    // Existing: a workspace that stopped at the migration before it. The row a
    // session wrote then has to survive the upgrade with no recorded binding,
    // because the resume path treats an unrecorded value as nothing to compare
    // rather than as a contract it can invent.
    const upgradedPath = join(tmpDir, 'upgraded.db');
    const upgraded = new Database(upgradedPath);
    upgraded.runMigrations(MIGRATIONS.filter((migration) => migration.version <= 40));
    expect(columnsOf(upgraded, 'pi_session_state')).not.toContain('work_dir');
    upgraded.exec(`INSERT INTO environments (id, name, config) VALUES ('env_u', 'u', '{}')`);
    upgraded.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_u', 'u', '{}')`);
    upgraded.exec(`
      INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, resources, vault_ids, loop_engine)
      VALUES ('sess_u', 'agent_u', 'u', 'env_u', 'paused', '[]', '[]', 'pi')
    `);
    upgraded.exec(`
      INSERT INTO pi_session_state (session_id, session_file, pi_session_id, schema_version, status)
      VALUES ('sess_u', '/tmp/sess_u.jsonl', 'pi-u', '1', 'active')
    `);

    upgraded.runMigrations();
    expect(columnsOf(upgraded, 'pi_session_state')).toEqual(expect.arrayContaining(['work_dir', 'policy_fingerprint']));
    expect(upgraded.prepare(
      'SELECT session_id, work_dir, policy_fingerprint FROM pi_session_state WHERE session_id = ?',
    ).get('sess_u')).toEqual({ session_id: 'sess_u', work_dir: null, policy_fingerprint: null });
    upgraded.close();
  });

  it('adds the deployment paused_reason column to a fresh workspace and to an existing one', () => {
    // Fresh: the column exists as soon as migrations run.
    const fresh = new Database(dbPath);
    fresh.runMigrations();
    expect(columnsOf(fresh, 'scheduled_deployments')).toContain('paused_reason');
    expect(fresh.prepare('SELECT name FROM _migrations WHERE version = 42').get()).toEqual({
      name: '042_scheduled_paused_reason',
    });
    fresh.close();

    // Existing: a workspace that stopped before it, holding a deployment that was
    // already paused. The upgrade must leave that row readable with **no** recorded
    // reason rather than back-filling `{"type": "manual"}`, because the runtime did
    // not observe who paused it and a reason it invented would be indistinguishable
    // from one it saw.
    const upgradedPath = join(tmpDir, 'upgraded-paused.db');
    const upgraded = new Database(upgradedPath);
    upgraded.runMigrations(MIGRATIONS.filter((migration) => migration.version <= 41));
    expect(columnsOf(upgraded, 'scheduled_deployments')).not.toContain('paused_reason');
    upgraded.exec(`
      INSERT INTO scheduled_deployments (id, name, agent_id, cron, status)
      VALUES ('sched_u', 'u', 'agent_u', '0 3 * * *', 'paused')
    `);

    upgraded.runMigrations();
    expect(columnsOf(upgraded, 'scheduled_deployments')).toContain('paused_reason');
    expect(
      upgraded.prepare('SELECT status, paused_reason FROM scheduled_deployments WHERE id = ?').get('sched_u'),
    ).toEqual({ status: 'paused', paused_reason: null });
    upgraded.close();
  });

  it('adds the work-item stop marker to a fresh workspace and to an existing one', () => {
    // Fresh: the column exists as soon as migrations run.
    const fresh = new Database(dbPath);
    fresh.runMigrations();
    expect(columnsOf(fresh, 'work_items')).toContain('stopped_at');
    expect(fresh.prepare('SELECT name FROM _migrations WHERE version = 45').get()).toEqual({
      name: '045_work_item_stop',
    });
    fresh.close();

    // Existing: a workspace that stopped at the migration before it, holding work that
    // was queued and never claimed. The upgrade must leave that row **unmarked**, because
    // an absent marker has to mean "not stopped" - the session that queued it may still
    // be running, and back-filling a stop would strand work nobody had stopped.
    const upgradedPath = join(tmpDir, 'upgraded-stop.db');
    const upgraded = new Database(upgradedPath);
    upgraded.runMigrations(MIGRATIONS.filter((migration) => migration.version <= 44));
    expect(columnsOf(upgraded, 'work_items')).not.toContain('stopped_at');
    upgraded.exec(`
      INSERT INTO work_items (id, session_id, kind, payload)
      VALUES ('work_u', 'sess_u', 'exec', '{"command":"echo hi"}')
    `);

    upgraded.runMigrations();
    expect(columnsOf(upgraded, 'work_items')).toContain('stopped_at');
    expect(
      upgraded.prepare('SELECT status, stopped_at FROM work_items WHERE id = ?').get('work_u'),
    ).toEqual({ status: 'pending', stopped_at: null });
    upgraded.close();
  });

  it('transaction rolls back on error', () => {
    const db = new Database(dbPath);
    db.runMigrations();

    expect(() =>
      db.transaction(() => {
        db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_t', 't', '{}')`);
        throw new Error('boom');
      }),
    ).toThrow('boom');

    const count = (db.prepare('SELECT COUNT(*) as c FROM environments').get() as { c: number }).c;
    expect(count).toBe(0); // rolled back
    db.close();
  });
});
