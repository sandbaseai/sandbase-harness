import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';

describe('Migration 063: Session Threads', () => {
  let testDir: string;
  let dbPath: string;
  let db: Database;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'ma-threads-migration-test-'));
    dbPath = join(testDir, 'test.db');
    db = new Database(dbPath);
    db.runMigrations();
  });

  afterEach(() => {
    if (db) db.close();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it('creates session_threads table with correct schema', () => {
    const tableInfo = db.prepare('PRAGMA table_info(session_threads)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;

    const columnNames = tableInfo.map((col) => col.name);
    expect(columnNames).toContain('id');
    expect(columnNames).toContain('session_id');
    expect(columnNames).toContain('parent_thread_id');
    expect(columnNames).toContain('agent_id');
    expect(columnNames).toContain('agent_version');
    expect(columnNames).toContain('status');
    expect(columnNames).toContain('workflow_run_id');
    expect(columnNames).toContain('created_at');
    expect(columnNames).toContain('archived_at');

    // Verify primary key
    const idCol = tableInfo.find((col) => col.name === 'id');
    expect(idCol?.pk).toBe(1);

    // Verify NOT NULL constraints
    const sessionIdCol = tableInfo.find((col) => col.name === 'session_id');
    expect(sessionIdCol?.notnull).toBe(1);

    const agentIdCol = tableInfo.find((col) => col.name === 'agent_id');
    expect(agentIdCol?.notnull).toBe(1);
  });

  it('creates required indexes on session_threads', () => {
    const indexes = db.prepare('PRAGMA index_list(session_threads)').all() as Array<{
      name: string;
      unique: number;
    }>;

    const indexNames = indexes.map((idx) => idx.name);
    expect(indexNames).toContain('idx_session_threads_session');
    expect(indexNames).toContain('idx_session_threads_parent');
    expect(indexNames).toContain('idx_session_threads_status');
    expect(indexNames).toContain('idx_session_threads_archived');
  });

  it('adds thread_id column to events table', () => {
    const tableInfo = db.prepare('PRAGMA table_info(events)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;

    const threadIdCol = tableInfo.find((col) => col.name === 'thread_id');
    expect(threadIdCol).toBeDefined();
    expect(threadIdCol?.type).toBe('TEXT');
    // Should be nullable for backward compat (NULL = primary thread)
    expect(threadIdCol?.notnull).toBe(0);
  });

  it('creates workflow_runs table with correct schema', () => {
    const tableInfo = db.prepare('PRAGMA table_info(workflow_runs)').all() as Array<{
      name: string;
    }>;

    const columnNames = tableInfo.map((col) => col.name);
    expect(columnNames).toContain('id');
    expect(columnNames).toContain('session_id');
    expect(columnNames).toContain('name');
    expect(columnNames).toContain('description');
    expect(columnNames).toContain('status');
    expect(columnNames).toContain('result_type');
    expect(columnNames).toContain('result_description');
    expect(columnNames).toContain('created_at');
    expect(columnNames).toContain('ended_at');
  });

  it('creates workflow_phases table with correct schema', () => {
    const tableInfo = db.prepare('PRAGMA table_info(workflow_phases)').all() as Array<{
      name: string;
    }>;

    const columnNames = tableInfo.map((col) => col.name);
    expect(columnNames).toContain('id');
    expect(columnNames).toContain('run_id');
    expect(columnNames).toContain('name');
    expect(columnNames).toContain('description');
    expect(columnNames).toContain('sequence_order');
    expect(columnNames).toContain('started_at');
    expect(columnNames).toContain('ended_at');
  });

  it('runs migrations in order on fresh database', () => {
    const migrations = db.prepare('SELECT version FROM _migrations ORDER BY version').all() as Array<{
      version: number;
    }>;

    // Migration 063 should be present
    const has063 = migrations.some((m) => m.version === 63);
    expect(has063).toBe(true);

    // Should have run after 062
    const versions = migrations.map((m) => m.version);
    const idx062 = versions.indexOf(62);
    const idx063 = versions.indexOf(63);
    expect(idx063).toBeGreaterThan(idx062);
  });

  it('adds index on events.thread_id', () => {
    const indexes = db.prepare('PRAGMA index_list(events)').all() as Array<{
      name: string;
    }>;

    const indexNames = indexes.map((idx) => idx.name);
    expect(indexNames).toContain('idx_events_thread');
  });
});
