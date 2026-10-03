/**
 * Integration test: crash recovery / orphan reconciliation (R9.10, Property 10).
 *
 * Simulates a process crash mid-turn (a session left 'running' with an
 * unresolved tool_use) and verifies reconcileOrphans() injects a placeholder
 * tool_result and resets the session to idle so the message sequence stays
 * valid and the session can continue.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { EventLogger } from '@/core/session/event-logger.js';
import { eventsToMessages } from '@/core/session/events-to-messages.js';
import { INTERRUPTED_TOOL_OUTCOME_MESSAGE } from '@/core/session/session-recovery.js';

describe('Crash recovery', () => {
  let db: Database;
  let manager: SessionManager;
  let logger: EventLogger;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-crash-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_echo', 'echo', '{}')`);
    manager = new SessionManager(db);
    logger = manager.getEventLogger();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Directly create a session stuck in 'running' with an orphaned tool_use. */
  function createOrphanedSession(): string {
    const session = manager.create({ agent: 'agent_echo' });
    // Simulate a mid-turn crash: running status + tool_use with no result
    db.prepare(`UPDATE sessions SET status = 'running' WHERE id = ?`).run(session.id);
    logger.append(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'run a command' }],
    });
    logger.append(session.id, {
      type: 'agent.tool_use',
      content: [{ type: 'tool_use', id: 'call_123', name: 'bash', input: { command: 'sleep 100' } }],
    });
    // ...crash happens here — no tool_result ever written
    return session.id;
  }

  /** The recorded placeholder content for one orphaned call, whichever result type paired it. */
  function placeholderContent(sessionId: string, toolUseId: string): string {
    const result = logger.getEvents(sessionId).find(
      (e) =>
        (e.type === 'agent.tool_result' || e.type === 'agent.mcp_tool_result')
        && (e.content?.[0] as any)?.tool_use_id === toolUseId,
    );
    expect(result, `no placeholder result for ${toolUseId}`).toBeDefined();
    return (result!.content![0] as any).content as string;
  }

  /**
   * What the message must *say*, independent of its exact wording.
   *
   * Comparing against the exported constant alone is not enough, and this was
   * measured rather than assumed: setting the constant to the legacy
   * "retry if needed" sentence left every `toBe(INTERRUPTED_TOOL_OUTCOME_MESSAGE)`
   * assertion **passing**, because both sides moved together. Such an assertion
   * pins *consistency* between the call sites — which is worth having, since the two
   * paths used to disagree — but it cannot pin the meaning. These properties are
   * what actually pin the meaning, and they are applied at every call site so that
   * a rewrite of one path cannot quietly reintroduce the defect.
   */
  function expectStatesOutcomeIsUnknown(content: string): void {
    // The instruction that must never come back: it asserts the effect probably did
    // not happen, which the runtime cannot know.
    expect(content).not.toMatch(/retry/i);
    expect(content).toMatch(/unknown/i);
    expect(content).toMatch(/outcome/i);
    expect(content).toMatch(/interrupted/i);
  }

  it('injects placeholder tool_result for orphaned tool_use', () => {
    const sessionId = createOrphanedSession();

    const count = manager.reconcileOrphans();
    expect(count).toBe(1);

    const events = logger.getEvents(sessionId);
    const resultEvent = events.find(
      (e) =>
        e.type === 'agent.tool_result' &&
        (e.content?.[0] as any)?.tool_use_id === 'call_123',
    );
    expect(resultEvent).toBeDefined();
    expect((resultEvent!.content![0] as any).is_error).toBe(true);
  });

  it('records that the interrupted call\'s external outcome is unknown', () => {
    const sessionId = createOrphanedSession();
    manager.reconcileOrphans();

    const content = placeholderContent(sessionId, 'call_123');
    // Consistency with the other path, and the meaning itself — the latter is what
    // a shared constant cannot check on its own.
    expect(content).toBe(INTERRUPTED_TOOL_OUTCOME_MESSAGE);
    expectStatesOutcomeIsUnknown(content);
  });

  it('does not tell the model to retry the interrupted call', () => {
    // The defect this replaces: the placeholder said "retry if needed", which
    // asserts the effect probably did not happen and invites a second one for a
    // call that may already have written a file or sent a request.
    const sessionId = createOrphanedSession();
    manager.reconcileOrphans();

    expect(placeholderContent(sessionId, 'call_123')).not.toMatch(/retry/i);
  });

  it('records the same, non-retrying message when a new message replaces an unresolved idle call', () => {
    const session = manager.create({ agent: 'agent_echo' });
    logger.append(session.id, {
      type: 'agent.tool_use',
      content: [{ type: 'tool_use', id: 'call_parked', name: 'glob', input: { pattern: '*' } }],
    });
    db.prepare(`UPDATE sessions SET status = 'paused' WHERE id = ?`).run(session.id);

    return manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'continue' }] })
      .then(() => {
        const content = placeholderContent(session.id, 'call_parked');
        expect(content).toBe(INTERRUPTED_TOOL_OUTCOME_MESSAGE);
        expectStatesOutcomeIsUnknown(content);
      });
  });

  it('records the same, non-retrying message for an orphaned MCP tool call', () => {
    // MCP tools reach the same path through `resultType`, and the sentence has to
    // hold for them too: an MCP call is dispatched to a server exactly once and its
    // effect is equally unknown.
    const session = manager.create({ agent: 'agent_echo' });
    db.prepare(`UPDATE sessions SET status = 'running' WHERE id = ?`).run(session.id);
    logger.append(session.id, {
      type: 'agent.mcp_tool_use',
      content: [{ type: 'tool_use', id: 'call_mcp', name: 'search', input: {} }],
    });

    manager.reconcileOrphans();

    // The result type follows the use type, so an MCP call is paired by an MCP result.
    const result = logger.getEvents(session.id).find((e) => e.type === 'agent.mcp_tool_result');
    expect(result).toBeDefined();
    const content = (result!.content![0] as any).content as string;
    expect(content).toBe(INTERRUPTED_TOOL_OUTCOME_MESSAGE);
    expectStatesOutcomeIsUnknown(content);
  });

  it('resets orphaned session to idle (paused) so it can continue', () => {
    const sessionId = createOrphanedSession();
    manager.reconcileOrphans();
    expect(manager.get(sessionId)!.status).toBe('paused');
  });

  it('produces a valid paired message sequence after reconciliation', () => {
    const sessionId = createOrphanedSession();
    manager.reconcileOrphans();

    const events = logger.getEvents(sessionId);
    const messages = eventsToMessages(events);

    // The assistant tool-call must be followed by a tool result — no orphan
    const toolMsg = messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect((toolMsg as any).content[0].toolCallId).toBe('call_123');
  });

  it('does not double-inject if a tool_result already exists', () => {
    const session = manager.create({ agent: 'agent_echo' });
    db.prepare(`UPDATE sessions SET status = 'running' WHERE id = ?`).run(session.id);
    logger.append(session.id, {
      type: 'agent.tool_use',
      content: [{ type: 'tool_use', id: 'call_ok', name: 'bash', input: {} }],
    });
    logger.append(session.id, {
      type: 'agent.tool_result',
      content: [{ type: 'tool_result', tool_use_id: 'call_ok', content: 'done' }],
    });

    manager.reconcileOrphans();

    const results = logger
      .getEvents(session.id)
      .filter((e) => e.type === 'agent.tool_result');
    expect(results).toHaveLength(1); // no extra placeholder injected
  });

  it('ignores sessions not in running state', () => {
    const session = manager.create({ agent: 'agent_echo' }); // status = queued
    const count = manager.reconcileOrphans();
    expect(count).toBe(0);
    expect(manager.get(session.id)!.status).toBe('queued');
  });
});
