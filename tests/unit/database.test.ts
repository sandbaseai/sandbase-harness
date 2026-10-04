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

  it('rebuilds scheduled_deployments into the published shape and keeps old rows readable', () => {
    // Fresh: the published columns exist as soon as migrations run, and `cron`
    // is nullable so a manual-only deployment can be stored.
    const fresh = new Database(dbPath);
    fresh.runMigrations();
    const columns = columnsOf(fresh, 'scheduled_deployments');
    for (const column of ['description', 'agent_version', 'initial_events', 'resources', 'vault_ids', 'budget']) {
      expect(columns).toContain(column);
    }
    const cronColumn = fresh.prepare(`PRAGMA table_info(scheduled_deployments)`).all()
      .find((column: any) => column.name === 'cron') as { notnull: number };
    expect(cronColumn.notnull).toBe(0);
    expect(fresh.prepare('SELECT name FROM _migrations WHERE version = 52').get()).toEqual({
      name: '052_deployment_official_shape',
    });
    fresh.close();

    // Existing: a pre-052 workspace holding one deployment with the legacy
    // `payload.title`. The upgrade must keep the row readable — the title moves
    // into `metadata`, `initial_events` lands empty (which is what later makes
    // its run a classified failure), and the pause state survives untouched.
    const upgradedPath = join(tmpDir, 'upgraded-052.db');
    const upgraded = new Database(upgradedPath);
    upgraded.runMigrations(MIGRATIONS.filter((migration) => migration.version <= 51));
    expect(columnsOf(upgraded, 'scheduled_deployments')).not.toContain('initial_events');
    upgraded.exec(`
      INSERT INTO scheduled_deployments (id, name, agent_id, cron, payload, status, metadata)
      VALUES ('sched_old', 'old', 'agent_o', '0 3 * * *', '{"title":"nightly title"}', 'paused', '{"keep":"yes"}')
    `);
    upgraded.exec(`
      INSERT INTO scheduled_deployment_runs (id, schedule_id, session_id, status, trigger_type)
      VALUES ('sdr_old', 'sched_old', NULL, 'failed', 'scheduled')
    `);

    upgraded.runMigrations();
    const row = upgraded.prepare(
      'SELECT agent_version, initial_events, resources, vault_ids, budget, metadata, status FROM scheduled_deployments WHERE id = ?',
    ).get('sched_old') as Record<string, unknown>;
    expect(row.status).toBe('paused');
    expect(row.agent_version).toBeNull();
    expect(row.initial_events).toBe('[]');
    expect(row.resources).toBe('[]');
    expect(row.vault_ids).toBe('[]');
    expect(row.budget).toBeNull();
    expect(JSON.parse(row.metadata as string)).toEqual({ keep: 'yes', title: 'nightly title' });
    // The run history gained the published columns and the row survived.
    const run = upgraded.prepare(
      'SELECT id, scheduled_at, error_type FROM scheduled_deployment_runs WHERE id = ?',
    ).get('sdr_old') as Record<string, unknown>;
    expect(run.id).toBe('sdr_old');
    expect(run.scheduled_at).toBeNull();
    expect(run.error_type).toBeNull();
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
    // The status reads `queued`, not the `'pending'` the insert fell back on: that row was
    // written by a build whose vocabulary predates 048, and the upgrade renames it. Nothing
    // claimed the row, so `queued` - not held, not committed - is what it always meant.
    expect(
      upgraded.prepare('SELECT status, stopped_at FROM work_items WHERE id = ?').get('work_u'),
    ).toEqual({ status: 'queued', stopped_at: null });
    upgraded.close();
  });

  it('adds the work-item acceptance marker to a fresh workspace and to an existing one', () => {
    const fresh = new Database(join(tmpDir, 'fresh-accept.db'));
    fresh.runMigrations();
    expect(columnsOf(fresh, 'work_items')).toContain('accepted_at');
    expect(fresh.prepare('SELECT name FROM _migrations WHERE version = 46').get()).toEqual({
      name: '046_work_item_accept',
    });
    fresh.close();

    // A row claimed by an earlier build stays NULL, which reads as "held but never
    // started". That is the honest back-fill rather than a convenient one: there was no
    // accept step for it to have been accepted by, so inventing a timestamp would claim a
    // commitment nobody made - and the queue would then treat a worker that died before
    // starting the item as one that may already have run it.
    //
    // Because that back-fill landed before the vocabulary change, migration 048 then maps the
    // row's `claimed` to `queued` for exactly the same reason: the two columns agree, and both
    // say "held, not committed". A row that had been accepted would have been mapped to
    // `accepted` instead - the case the next test pins.
    const upgradedPath = join(tmpDir, 'upgraded-accept.db');
    const upgraded = new Database(upgradedPath);
    upgraded.runMigrations(MIGRATIONS.filter((migration) => migration.version <= 45));
    expect(columnsOf(upgraded, 'work_items')).not.toContain('accepted_at');
    upgraded.exec(`
      INSERT INTO work_items (id, session_id, kind, payload, status, claimed_by, claimed_at)
      VALUES ('work_a', 'sess_a', 'exec', '{"command":"echo hi"}', 'claimed', 'w1', datetime('now'))
    `);

    upgraded.runMigrations();
    expect(columnsOf(upgraded, 'work_items')).toContain('accepted_at');
    expect(
      upgraded.prepare('SELECT status, claimed_by, accepted_at FROM work_items WHERE id = ?').get('work_a'),
    ).toEqual({ status: 'queued', claimed_by: 'w1', accepted_at: null });
    upgraded.close();
  });

  it('adds the work-item abandonment marker to a fresh workspace and to an existing one', () => {
    const fresh = new Database(join(tmpDir, 'fresh-abandon.db'));
    fresh.runMigrations();
    expect(columnsOf(fresh, 'work_items')).toContain('abandoned_at');
    expect(fresh.prepare('SELECT name FROM _migrations WHERE version = 47').get()).toEqual({
      name: '047_work_item_abandon',
    });
    fresh.close();

    // An absent marker must read as "no wait gave up on this". An earlier build could not
    // abandon anything, so back-filling one would claim a decision that was never made -
    // and a reader checking whether the runtime had given up on a row would be told yes.
    const upgradedPath = join(tmpDir, 'upgraded-abandon.db');
    const upgraded = new Database(upgradedPath);
    upgraded.runMigrations(MIGRATIONS.filter((migration) => migration.version <= 46));
    expect(columnsOf(upgraded, 'work_items')).not.toContain('abandoned_at');
    upgraded.exec(`
      INSERT INTO work_items (id, session_id, kind, payload, status, claimed_by, claimed_at)
      VALUES ('work_b', 'sess_b', 'exec', '{"command":"echo hi"}', 'claimed', 'w1', datetime('now'))
    `);

    upgraded.runMigrations();
    expect(columnsOf(upgraded, 'work_items')).toContain('abandoned_at');
    expect(
      upgraded.prepare('SELECT status, abandoned_at FROM work_items WHERE id = ?').get('work_b'),
    ).toEqual({ status: 'queued', abandoned_at: null });
    upgraded.close();
  });

  it('renames the work-item status vocabulary on migration, completely and only once', () => {
    // The frozen worker-protocol spec fixes this chain - `queued -> accepted -> applied`, plus
    // `failed` and `unknown` - and requires the old words to survive only as a compatibility
    // mapping. The mapping has one genuinely interesting case: `claimed` has to be split by
    // whether the row was accepted, because that is the difference between work that never
    // started and work whose effect may already have happened.
    const fresh = new Database(join(tmpDir, 'fresh-vocabulary.db'));
    fresh.runMigrations();
    expect(fresh.prepare('SELECT name FROM _migrations WHERE version = 48').get()).toEqual({
      name: '048_work_item_status_vocabulary',
    });
    // A fresh workspace reaches the end with no rows at all, so the rename has nothing to do
    // and must not fail for that.
    expect(fresh.prepare('SELECT COUNT(*) AS c FROM work_items').get()).toEqual({ c: 0 });
    fresh.close();

    // One row per old value, all written by the earlier build. `work_c2` is the accepted one
    // and `work_c1` the unaccepted one - the pair that separates the mapping.
    const upgradedPath = join(tmpDir, 'upgraded-vocabulary.db');
    const upgraded = new Database(upgradedPath);
    upgraded.runMigrations(MIGRATIONS.filter((migration) => migration.version <= 47));
    upgraded.exec(`
      INSERT INTO work_items (id, session_id, kind, payload, status, accepted_at) VALUES
        ('work_p',  's', 'exec', '{}', 'pending', NULL),
        ('work_c1', 's', 'exec', '{}', 'claimed', NULL),
        ('work_c2', 's', 'exec', '{}', 'claimed', datetime('now')),
        ('work_d',  's', 'exec', '{}', 'done',    datetime('now')),
        ('work_f',  's', 'exec', '{}', 'failed',  datetime('now'))
    `);

    upgraded.runMigrations();
    const mapped = Object.fromEntries(
      (upgraded.prepare('SELECT id, status FROM work_items').all() as Array<{ id: string; status: string }>)
        .map((row) => [row.id, row.status]),
    );
    expect(mapped).toEqual({
      work_p: 'queued',
      work_c1: 'queued',
      work_c2: 'accepted',
      work_d: 'applied',
      work_f: 'failed',
    });

    // The rename is total in the other direction as well: no row is left carrying a word the
    // new vocabulary does not contain, which is what a reader filtering on `status` relies on.
    const surviving = upgraded.prepare(
      "SELECT DISTINCT status FROM work_items WHERE status NOT IN ('queued','accepted','applied','failed','unknown')",
    ).all();
    expect(surviving).toEqual([]);

    // And it is idempotent rather than merely repeatable: running the whole set again rewrites
    // nothing, because every value the mapping produces is already in the new vocabulary.
    upgraded.runMigrations();
    const again = Object.fromEntries(
      (upgraded.prepare('SELECT id, status FROM work_items').all() as Array<{ id: string; status: string }>)
        .map((row) => [row.id, row.status]),
    );
    expect(again).toEqual(mapped);
    upgraded.close();
  });

  it('creates the skill_versions table on a fresh workspace and backfills existing skills', () => {
    // Fresh: the table and its per-skill ordering index exist from the start.
    const fresh = new Database(dbPath);
    fresh.runMigrations();
    expect(columnsOf(fresh, 'skill_versions')).toEqual(
      expect.arrayContaining(['id', 'skill_id', 'seq', 'name', 'description', 'storage_path', 'created_at']),
    );
    expect(fresh.prepare('SELECT name FROM _migrations WHERE version = 53').get()).toEqual({
      name: '053_skill_versions',
    });
    fresh.close();

    // Existing: a workspace that stopped before the table, holding a skill whose
    // only version record is the `latest_version` pointer and a `versions` JSON
    // blob. The upgrade back-fills that pointer as seq 1 rather than leaving the
    // version routes to answer a skill that exists with no versions.
    const upgradedPath = join(tmpDir, 'upgraded-skill-versions.db');
    const upgraded = new Database(upgradedPath);
    upgraded.runMigrations(MIGRATIONS.filter((migration) => migration.version <= 51));
    expect(columnsOf(upgraded, 'skill_versions')).toEqual([]);
    upgraded.exec(`
      INSERT INTO skills (id, name, description, instructions, latest_version, versions, storage_path, created_at, updated_at)
      VALUES
        ('skill_a', 'a', 'a-desc', 'a-instructions', '1700000000001',
         '[{"id":"1700000000001","created_at":"2026-01-01T00:00:00.000Z","latest":true}]',
         '/data/skills/skill_a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('skill_b', 'b', 'b-desc', 'b-instructions', NULL, '[]', NULL,
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `);

    upgraded.runMigrations();
    const rows = upgraded.prepare(
      'SELECT id, skill_id, seq, name, description, storage_path, created_at FROM skill_versions ORDER BY skill_id',
    ).all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        id: '1700000000001',
        skill_id: 'skill_a',
        seq: 1,
        name: 'a',
        description: 'a-desc',
        storage_path: '/data/skills/skill_a',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    // A skill with no recorded version produces no row: inventing one would be
    // a version the operator never uploaded.
    expect(
      (upgraded.prepare('SELECT COUNT(*) AS c FROM skill_versions WHERE skill_id = ?').get('skill_b') as { c: number }).c,
    ).toBe(0);
    upgraded.close();
  });

  it('adds seq-based boundary columns to compaction_boundaries (054)', () => {
    // Fresh: both columns exist as soon as migrations run.
    const fresh = new Database(dbPath);
    fresh.runMigrations();
    expect(columnsOf(fresh, 'compaction_boundaries')).toEqual(
      expect.arrayContaining(['event_seq_before', 'compacted_event_id']),
    );
    expect(fresh.prepare('SELECT name FROM _migrations WHERE version = 54').get()).toEqual({
      name: '054_compaction_boundary_seq',
    });
    fresh.close();

    // Existing: a workspace that stopped at the migration before it, already
    // holding a boundary written by the legacy writer. The upgrade adds the
    // columns with safe defaults, and the row remains readable.
    const upgradedPath = join(tmpDir, 'upgraded-boundary.db');
    const upgraded = new Database(upgradedPath);
    upgraded.runMigrations(MIGRATIONS.filter((migration) => migration.version <= 51));
    expect(columnsOf(upgraded, 'compaction_boundaries')).not.toContain('event_seq_before');
    upgraded.exec(`
      INSERT INTO environments (id, name, config) VALUES ('env_b', 'local', '{}');
      INSERT INTO agents (id, name, definition) VALUES ('agent_b', 'b', '{}');
      INSERT INTO sessions (id, agent_id, agent_name, environment_id)
      VALUES ('sess_old', 'agent_b', 'b', 'env_b');
      INSERT INTO compaction_boundaries
        (id, session_id, summary, event_id_before, tokens_before, tokens_after)
      VALUES ('cmpb_old', 'sess_old', 'old summary', 'sevt_old', 100, 20)
    `);

    upgraded.runMigrations();
    expect(columnsOf(upgraded, 'compaction_boundaries')).toEqual(
      expect.arrayContaining(['event_seq_before', 'compacted_event_id']),
    );
    expect(
      upgraded
        .prepare('SELECT summary, event_seq_before, compacted_event_id FROM compaction_boundaries WHERE id = ?')
        .get('cmpb_old'),
    ).toEqual({ summary: 'old summary', event_seq_before: 0, compacted_event_id: null });
    upgraded.close();
  });

  it('adds the usage cache-bucket columns to sessions and events (055)', () => {
    // Fresh: both tables carry the columns from the start.
    const fresh = new Database(dbPath);
    fresh.runMigrations();
    expect(columnsOf(fresh, 'sessions')).toEqual(
      expect.arrayContaining(['usage_cache_read_tokens', 'usage_cache_write_tokens']),
    );
    expect(columnsOf(fresh, 'events')).toEqual(
      expect.arrayContaining(['cache_read_tokens', 'cache_write_tokens']),
    );
    expect(fresh.prepare('SELECT name FROM _migrations WHERE version = 55').get()).toEqual({
      name: '055_usage_cache_buckets',
    });
    fresh.close();

    // Existing: a workspace that stopped before the split, holding a session
    // whose recorded input is entirely uncached — prompt caching was never
    // enabled before, so its cache buckets are genuinely zero.
    const upgradedPath = join(tmpDir, 'upgraded-cache.db');
    const upgraded = new Database(upgradedPath);
    upgraded.runMigrations(MIGRATIONS.filter((migration) => migration.version <= 51));
    expect(columnsOf(upgraded, 'sessions')).not.toContain('usage_cache_read_tokens');
    upgraded.exec(`
      INSERT INTO environments (id, name, config) VALUES ('env_b', 'local', '{}');
      INSERT INTO agents (id, name, definition) VALUES ('agent_b', 'b', '{}');
      INSERT INTO sessions (id, agent_id, agent_name, environment_id, usage_tokens_in, usage_tokens_out)
      VALUES ('sess_old', 'agent_b', 'b', 'env_b', 1000, 4);
      INSERT INTO events (id, session_id, seq, type, model_used, tokens_in, tokens_out)
      VALUES ('sevt_old', 'sess_old', 1, 'span.model_request_end', 'm', 1000, 4)
    `);

    upgraded.runMigrations();
    expect(
      upgraded
        .prepare('SELECT usage_tokens_in, usage_cache_read_tokens, usage_cache_write_tokens FROM sessions WHERE id = ?')
        .get('sess_old'),
    ).toEqual({ usage_tokens_in: 1000, usage_cache_read_tokens: 0, usage_cache_write_tokens: 0 });
    expect(
      upgraded.prepare('SELECT tokens_in, cache_read_tokens FROM events WHERE id = ?').get('sevt_old'),
    ).toEqual({ tokens_in: 1000, cache_read_tokens: null });
    upgraded.close();
  });

  it('adds the is_error column to events (056)', () => {
    // Fresh: the column exists and reads back through the event logger.
    const fresh = new Database(dbPath);
    fresh.runMigrations();
    expect(columnsOf(fresh, 'events')).toEqual(expect.arrayContaining(['is_error']));
    expect(fresh.prepare('SELECT name FROM _migrations WHERE version = 56').get()).toEqual({
      name: '056_model_request_is_error',
    });
    fresh.close();

    // Existing: a workspace that stopped at 055 with a paired span already in
    // the log. The upgrade adds the column and the row reads as NULL — the
    // "outcome unknown" value the projection reports, not a guessed false.
    const upgradedPath = join(tmpDir, 'upgraded-is-error.db');
    const upgraded = new Database(upgradedPath);
    upgraded.runMigrations();
    expect(columnsOf(upgraded, 'events')).toContain('is_error');
    upgraded.close();

    const legacyPath = join(tmpDir, 'legacy-is-error.db');
    const legacy = new Database(legacyPath);
    legacy.runMigrations(MIGRATIONS.filter((migration) => migration.version <= 55));
    expect(columnsOf(legacy, 'events')).not.toContain('is_error');
    legacy.exec(`
      INSERT INTO environments (id, name, config) VALUES ('env_b', 'local', '{}');
      INSERT INTO agents (id, name, definition) VALUES ('agent_b', 'b', '{}');
      INSERT INTO sessions (id, agent_id, agent_name, environment_id)
      VALUES ('sess_old', 'agent_b', 'b', 'env_b');
      INSERT INTO events (id, session_id, seq, type, model_used, tokens_in, tokens_out)
      VALUES ('sevt_old', 'sess_old', 1, 'span.model_request_end', 'm', 1000, 4)
    `);
    legacy.runMigrations();
    expect(
      legacy.prepare('SELECT tokens_in, is_error FROM events WHERE id = ?').get('sevt_old'),
    ).toEqual({ tokens_in: 1000, is_error: null });
    legacy.close();
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
