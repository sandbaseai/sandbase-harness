import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { LocalArtifactStore } from '@/core/storage/artifact-store.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { SnapshotManager } from '@/core/session/snapshot-manager.js';

describe('SessionManager permanent deletion', () => {
  let directory: string | undefined;
  let db: Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function setUp() {
    directory = mkdtempSync(join(tmpdir(), 'ma-session-delete-'));
    db = new Database(join(directory, 'data.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_delete',
      'delete-agent',
      JSON.stringify({ name: 'delete-agent', model: 'gpt-4o', system: 'delete' }),
    );

    const manager = new SessionManager(db);
    const cleanupSession = vi.fn(async () => undefined);
    manager.setExecutor({
      async *execute() {},
      cleanupSession,
    });
    const artifactStore = new LocalArtifactStore(join(directory, 'artifacts'));
    const snapshots = new SnapshotManager(db, artifactStore.path('snapshots'));
    manager.setSessionStorage({ artifactStore, snapshots });
    return { manager, artifactStore, snapshots };
  }

  it('deletes session-owned rows and files while preserving user files without session scope', async () => {
    const { manager, artifactStore, snapshots } = setUp();
    const session = manager.create({ agent: 'agent_delete' });
    const now = new Date().toISOString();
    const event = manager.getEventLogger().append(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'hello' }],
    });

    const generatedPath = artifactStore.path('generated.txt');
    artifactStore.writeFile(generatedPath, Buffer.from('generated'));
    db!.prepare(
      `INSERT INTO files (
        id, name, media_type, size_bytes, storage_path, role, session_id, artifact_path, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('file_generated', 'generated.txt', 'text/plain', 9, generatedPath, 'file', session.id, null, JSON.stringify({ session_output_path: 'generated.txt' }), now, now);

    const userPath = artifactStore.path('user-upload.txt');
    artifactStore.writeFile(userPath, Buffer.from('user'));
    db!.prepare(
      `INSERT INTO files (
        id, name, media_type, size_bytes, storage_path, role, session_id, artifact_path, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('file_user', 'user-upload.txt', 'text/plain', 4, userPath, 'file', session.id, null, '{}', now, now);

    const snapshotPath = join(directory!, 'artifacts', 'snapshots', session.id, 'snap.tar.gz');
    mkdirSync(join(directory!, 'artifacts', 'snapshots', session.id), { recursive: true });
    writeFileSync(snapshotPath, 'snapshot');
    db!.prepare('INSERT INTO snapshots (id, session_id, path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('snap_delete', session.id, snapshotPath, 8, now);

    db!.prepare(
      `INSERT INTO compaction_boundaries (id, session_id, summary, event_id_before, tokens_before, tokens_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('compact_delete', session.id, 'summary', event.id, 10, 2, now);
    db!.prepare(
      `INSERT INTO session_outcomes (id, session_id, outcome_id, status, score, summary, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('outcome_delete', session.id, null, 'pending', null, '', '{}', now);
    db!.prepare(
      `INSERT INTO session_resource_instances (
        id, session_id, resource_type, position, mount_path, config, secret, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('resource_delete', session.id, 'file', 0, '/mnt/session/uploads/input.txt', '{}', null, now, now);
    db!.prepare(
      `INSERT INTO pi_session_state (session_id, session_file, pi_session_id, schema_version, status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(session.id, 'session.jsonl', 'pi-session-delete', '1', 'active');

    const received: string[] = [];
    manager.subscribe(session.id, (receivedEvent) => received.push(receivedEvent.type));

    await manager.delete(session.id);

    expect(received.at(-1)).toBe('session.deleted');
    expect(manager.get(session.id)).toBeNull();
    expect(existsSync(generatedPath)).toBe(false);
    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(userPath)).toBe(true);
    expect(db!.prepare('SELECT session_id FROM files WHERE id = ?').get('file_user')).toEqual({ session_id: null });
    expect(snapshots.list(session.id)).toEqual([]);

    const tables = db!.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    ).all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const columns = db!.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'session_id')) continue;
      const rows = db!.prepare(`SELECT session_id FROM "${name.replace(/"/g, '""')}" WHERE session_id = ?`).all(session.id);
      expect(rows, name).toEqual([]);
    }
  });

  it('refuses to delete a running session without aborting or removing it', async () => {
    const { manager } = setUp();
    const session = manager.create({ agent: 'agent_delete' });
    db!.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);

    await expect(manager.delete(session.id)).rejects.toMatchObject({ code: 'session_running' });
    expect(manager.get(session.id)?.status).toBe('running');
  });
});
