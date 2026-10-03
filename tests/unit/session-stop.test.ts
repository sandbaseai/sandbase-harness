import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '@/core/db/database.js';
import { SessionManager, type SessionExecutor } from '@/core/session/session-manager.js';
import type { SessionStatus } from '@/types/session.js';

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

describe('resumable session stop', () => {
  let directory: string;
  let database: Database;
  let manager: SessionManager;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ma-session-stop-'));
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

  it.each(['builtin', 'pi'] as const)('drains an interrupted %s turn without releasing its sandbox and accepts another message', async (loopEngine) => {
    manager = new SessionManager(database, undefined, loopEngine);
    const started = deferred();
    const unwind = deferred();
    const cleanupSession = vi.fn(async () => {});
    let turns = 0;
    const executor: SessionExecutor = {
      async *execute(_session, _event, options) {
        turns += 1;
        if (turns !== 1) return;
        const signal = options!.abortSignal!;
        const aborted = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        started.resolve();
        await aborted;
        await unwind.promise;
        throw Object.assign(new Error('Interrupted'), { name: 'AbortError' });
      },
      cleanupSession,
    };
    manager.setExecutor(executor);
    const session = manager.create({ agent: 'agent_test' });
    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'first' }] });
    await started.promise;
    const stop = manager.stop(session.id);
    let settled = false;
    void stop.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(manager.get(session.id)?.status).toBe('running');
    expect(cleanupSession).not.toHaveBeenCalled();
    unwind.resolve();
    await stop;

    expect(manager.get(session.id)?.status).toBe('paused');
    const events = manager.getEventLogger().getEvents(session.id);
    expect(events.at(-1)).toMatchObject({ type: 'session.status_idle', metadata: { stop_reason: { type: 'end_turn' } } });
    expect(events.some((event) => event.type === 'session.status_terminated' || event.type === 'session.error')).toBe(false);
    expect(cleanupSession).not.toHaveBeenCalled();
    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'continue' }] });
    await vi.waitFor(() => {
      expect(turns).toBe(2);
      expect(manager.get(session.id)?.status).toBe('paused');
    });
    expect(cleanupSession).not.toHaveBeenCalled();
  });

  it.each(['queued', 'paused', 'requires_action'] as SessionStatus[])('does not change an idle %s session or append events', async (status) => {
    const session = manager.create({ agent: 'agent_test' });
    database.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, session.id);
    const before = manager.getEventLogger().getEvents(session.id);
    await manager.stop(session.id);
    await manager.stop(session.id);
    expect(manager.get(session.id)?.status).toBe(status);
    expect(manager.getEventLogger().getEvents(session.id)).toEqual(before);
  });

  it.each(['completed', 'failed', 'cancelled', 'timed_out', 'cleanup_pending'] as SessionStatus[])('refuses an already terminal %s session without mutation or cleanup', async (status) => {
    const cleanupSession = vi.fn(async () => {});
    manager.setExecutor({ async *execute() {}, cleanupSession });
    const session = manager.create({ agent: 'agent_test' });
    database.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, session.id);
    const before = manager.getEventLogger().getEvents(session.id);
    await expect(manager.stop(session.id)).rejects.toThrow(`terminal state: ${status}`);
    expect(manager.get(session.id)?.status).toBe(status);
    expect(manager.getEventLogger().getEvents(session.id)).toEqual(before);
    expect(cleanupSession).not.toHaveBeenCalled();
  });
});
