import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '@/core/db/database.js';
import { SessionManager, type SessionExecutor } from '@/core/session/session-manager.js';
import type { SessionStatus } from '@/types/session.js';

describe('session archive', () => {
  let directory: string;
  let database: Database;
  let manager: SessionManager;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ma-session-archive-'));
    database = new Database(join(directory, 'test.db'));
    database.runMigrations();
    database.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    database.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'test', '{}')`);
    manager = new SessionManager(database);
  });

  afterEach(async () => {
    await manager.shutdown();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('archives an idle session, emits termination, and releases its sandbox', async () => {
    const cleanupSession = vi.fn(async () => {});
    const executor: SessionExecutor = { async *execute() {}, cleanupSession };
    manager.setExecutor(executor);
    const session = manager.create({ agent: 'agent_test' });

    const archived = await manager.archive(session.id);

    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(cleanupSession).toHaveBeenCalledWith(session.id);
    expect(manager.getEventLogger().getEvents(session.id)).toEqual([
      expect.objectContaining({ type: 'session.status_terminated' }),
    ]);
  });

  it('is idempotent after the first archive', async () => {
    const cleanupSession = vi.fn(async () => {});
    manager.setExecutor({ async *execute() {}, cleanupSession });
    const session = manager.create({ agent: 'agent_test' });
    const first = await manager.archive(session.id);
    const events = manager.getEventLogger().getEvents(session.id);

    const second = await manager.archive(session.id);

    expect(second.archivedAt).toEqual(first.archivedAt);
    expect(manager.getEventLogger().getEvents(session.id)).toEqual(events);
    expect(cleanupSession).toHaveBeenCalledTimes(1);
  });

  it.each(['completed', 'failed', 'cancelled', 'timed_out', 'cleanup_pending'] as SessionStatus[])('archives an already terminal %s session without changing status or emitting an event', async (status) => {
    const cleanupSession = vi.fn(async () => {});
    manager.setExecutor({ async *execute() {}, cleanupSession });
    const session = manager.create({ agent: 'agent_test' });
    database.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, session.id);
    const before = manager.getEventLogger().getEvents(session.id);

    const archived = await manager.archive(session.id);

    expect(archived.status).toBe(status);
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(manager.getEventLogger().getEvents(session.id)).toEqual(before);
    expect(cleanupSession).not.toHaveBeenCalled();
  });

  it('refuses a running session with a stable conflict code', async () => {
    const session = manager.create({ agent: 'agent_test' });
    database.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);

    await expect(manager.archive(session.id)).rejects.toMatchObject({ code: 'session_running' });
    expect(manager.get(session.id)?.archivedAt).toBeUndefined();
    expect(manager.getEventLogger().getEvents(session.id)).toEqual([]);
  });

  it('refuses new events after archiving before anything is appended', async () => {
    const session = manager.create({ agent: 'agent_test' });
    await manager.archive(session.id);

    await expect(manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'after archive' }],
    })).rejects.toMatchObject({ code: 'session_archived' });
    expect(manager.getEventLogger().getEvents(session.id)).toHaveLength(1);
  });
});
