/**
 * Integration test: multi-turn conversations + sandbox lifecycle + serialization.
 *
 * Verifies the fixes for:
 * - Bug 1: sessions go idle (paused) after a turn, not terminal — multi-turn works
 * - Bug 2: the sandbox is provisioned once and reused across turns
 * - Bug 3: concurrent sendEvents are serialized (no overlapping turns)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager, type SessionExecutor } from '@/core/session/session-manager.js';
import type { Session, SessionEvent } from '@/types/session.js';

/** A mock executor that records how often it provisions/cleans up per session. */
class MockExecutor implements SessionExecutor {
  provisions = new Map<string, number>();
  cleanups = new Map<string, number>();
  activeTurns = 0;
  maxConcurrentTurns = 0;
  turnCount = 0;

  async *execute(session: Session): AsyncIterable<SessionEvent> {
    this.activeTurns++;
    this.maxConcurrentTurns = Math.max(this.maxConcurrentTurns, this.activeTurns);
    this.turnCount++;

    // Simulate provisioning a sandbox once per session
    this.provisions.set(session.id, (this.provisions.get(session.id) ?? 0) + 1);

    // Simulate async work
    await new Promise((r) => setTimeout(r, 20));

    this.activeTurns--;
    // Yield nothing (no agent output needed for this test)
  }

  async cleanupSession(sessionId: string): Promise<void> {
    this.cleanups.set(sessionId, (this.cleanups.get(sessionId) ?? 0) + 1);
  }
}

async function waitFor<T>(
  probe: () => T | undefined | null,
  description: string,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('Multi-turn + sandbox lifecycle', () => {
  let db: Database;
  let manager: SessionManager;
  let executor: MockExecutor;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-mt-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_echo', 'echo', '{}')`);

    manager = new SessionManager(db);
    executor = new MockExecutor();
    manager.setExecutor(executor);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function userMsg(text: string) {
    return { type: 'user.message', content: [{ type: 'text' as const, text }] } as any;
  }

  it('session goes idle (paused) after a turn, not terminal', async () => {
    const session = manager.create({ agent: 'agent_echo' });
    await manager.sendEvent(session.id, userMsg('hello'));

    // Wait for the async turn to complete
    await waitFor(
      () => (manager.get(session.id)?.status === 'paused' ? 'paused' : undefined),
      'session status paused after the first turn',
    );

    const after = manager.get(session.id);
    expect(after!.status).toBe('paused'); // idle, awaiting next input — NOT completed
  });

  it('accepts a second message after the first turn (multi-turn works)', async () => {
    const session = manager.create({ agent: 'agent_echo' });

    await manager.sendEvent(session.id, userMsg('msg1'));
    await waitFor(
      () => (manager.get(session.id)?.status === 'paused' ? 'paused' : undefined),
      'session status paused before the second turn',
    );

    // Second message must be accepted (was previously rejected with 409)
    const res = await manager.sendEvent(session.id, userMsg('msg2'));
    expect(res.accepted).toBe(true);

    await waitFor(
      () => (executor.turnCount === 2 ? executor.turnCount : undefined),
      'second turn completion',
    );
    expect(executor.turnCount).toBe(2);
  });

  it('serializes concurrent turns (no overlap)', async () => {
    const session = manager.create({ agent: 'agent_echo' });

    // Fire three messages back-to-back without awaiting
    await manager.sendEvent(session.id, userMsg('a'));
    await manager.sendEvent(session.id, userMsg('b'));
    await manager.sendEvent(session.id, userMsg('c'));

    // Wait for all turns to drain
    await waitFor(
      () => (executor.turnCount === 3 ? executor.turnCount : undefined),
      'all serialized turns to complete',
    );

    expect(executor.maxConcurrentTurns).toBe(1); // never ran two turns at once
    expect(executor.turnCount).toBe(3);
  });

  it('retains the sandbox on stop and accepts a continuation', async () => {
    const session = manager.create({ agent: 'agent_echo' });
    await manager.sendEvent(session.id, userMsg('hi'));
    await waitFor(
      () => (manager.get(session.id)?.status === 'paused' ? 'paused' : undefined),
      'session status paused before stop',
    );

    await manager.stop(session.id);
    expect(executor.cleanups.has(session.id)).toBe(false);
    expect(manager.get(session.id)!.status).toBe('paused');
    await manager.sendEvent(session.id, userMsg('continue'));
    await waitFor(
      () => executor.turnCount === 2 && manager.get(session.id)?.status === 'paused' ? true : undefined,
      'continued turn completion',
    );
    expect(executor.cleanups.has(session.id)).toBe(false);
  });

  it('stop() aborts and drains an in-flight turn without cleanup', async () => {
    let turnFinished = false;
    let cleanedUp = false;
    let cleanupBeforeTurnEnd = false;

    const slow: SessionExecutor = {
      // eslint-disable-next-line require-yield
      async *execute(_session, _event, options) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 300);
          options?.abortSignal?.addEventListener('abort', () => { clearTimeout(t); resolve(); });
        });
        turnFinished = true;
      },
      async cleanupSession() {
        // If cleanup runs before the turn unwinds, that's the H1 bug
        if (!turnFinished) cleanupBeforeTurnEnd = true;
        cleanedUp = true;
      },
    };
    manager.setExecutor(slow);

    const session = manager.create({ agent: 'agent_echo' });
    await manager.sendEvent(session.id, userMsg('go'));
    await new Promise((r) => setTimeout(r, 30)); // let the turn start

    await manager.stop(session.id);

    expect(turnFinished).toBe(true);
    expect(cleanedUp).toBe(false);
    expect(cleanupBeforeTurnEnd).toBe(false);
  });

  it('releases the sandbox on delete', async () => {
    const session = manager.create({ agent: 'agent_echo' });
    await manager.sendEvent(session.id, userMsg('hi'));
    await waitFor(
      () => (manager.get(session.id)?.status === 'paused' ? 'paused' : undefined),
      'session status paused before delete',
    );

    await manager.delete(session.id);
    expect(executor.cleanups.get(session.id)).toBe(1);
  });

  it('broadcasts agent events produced during a turn to live subscribers', async () => {
    // Executor that emits an agent.message via the broadcast callback (the
    // path onStepFinish uses). Verifies the broadcast wiring reaches SSE subs.
    const broadcastingExecutor: SessionExecutor = {
      // eslint-disable-next-line require-yield
      async *execute(session, _event, options) {
        options?.broadcast?.({
          id: 'sevt_agent',
          sessionId: session.id,
          seq: 99,
          type: 'agent.message',
          content: [{ type: 'text', text: 'live reply' }],
          createdAt: new Date(),
        });
        return;
      },
      async cleanupSession() {},
    };
    manager.setExecutor(broadcastingExecutor);

    const session = manager.create({ agent: 'agent_echo' });
    const received: string[] = [];
    manager.subscribe(session.id, (e) => received.push(e.type));

    await manager.sendEvent(session.id, userMsg('hi'));
    await waitFor(
      () => (received.includes('agent.message') ? true : undefined),
      'agent.message broadcast',
    );
    expect(received).toContain('agent.message');
  });
});

describe('Interrupt handling', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-int-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_echo', 'echo', '{}')`);
    manager = new SessionManager(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('aborts a running turn and returns the session to idle (paused)', async () => {
    let aborted = false;

    // Executor that runs a long turn and honors the abort signal
    const slowExecutor: SessionExecutor = {
      async *execute(_session, _event, options) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5000);
          options?.abortSignal?.addEventListener('abort', () => {
            aborted = true;
            clearTimeout(timer);
            resolve();
          });
        });
        // Simulate that the abort throws, as streamText would
        if (options?.abortSignal?.aborted) {
          throw new Error('AbortError: operation aborted');
        }
      },
      async cleanupSession() {},
    };
    manager.setExecutor(slowExecutor);

    const session = manager.create({ agent: 'agent_echo' });
    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'long task' }],
    } as any);

    // Wait for the turn to start
    await waitFor(
      () => (manager.get(session.id)?.status === 'running' ? 'running' : undefined),
      'turn to start',
    );
    expect(manager.get(session.id)!.status).toBe('running');

    // Interrupt it
    await manager.sendEvent(session.id, { type: 'user.interrupt' } as any);

    // Wait for the turn to unwind
    await waitFor(() => (aborted ? true : undefined), 'turn abort');
    await waitFor(
      () => (manager.get(session.id)?.status === 'paused' ? 'paused' : undefined),
      'session status paused after interrupt',
    );
  });
});
