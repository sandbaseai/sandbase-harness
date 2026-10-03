/**
 * Unit tests for Session Manager.
 * Validates: session create/get/list/stop lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';

describe('Session Manager', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-test-'));
    const dbPath = join(tmpDir, 'test.db');
    db = new Database(dbPath);
    db.runMigrations();

    // Insert default environment
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    // Insert a test agent
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'test-agent', '{}')`);

    manager = new SessionManager(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates a session with queued status', () => {
      const session = manager.create({ agent: 'agent_test' });
      expect(session.id).toMatch(/^sess_/);
      expect(session.status).toBe('queued');
      expect(session.agentId).toBe('agent_test');
    });

    it('stores context_id when provided', () => {
      const session = manager.create({ agent: 'agent_test', contextId: 'ctx_abc' });
      expect(session.contextId).toBe('ctx_abc');
    });

    it('stores metadata when provided', () => {
      const session = manager.create({
        agent: 'agent_test',
        metadata: { project: 'test' },
      });
      expect(session.metadata).toEqual({ project: 'test' });
    });

    it('refuses an Environment whose config cannot be resolved', () => {
      // The session row must not exist at all: a session that can only fail
      // when it provisions a sandbox would already have accepted work.
      db.prepare(`INSERT INTO environments (id, name, config) VALUES ('env_team', 'team', '{"hosting_type":"team_server"}')`).run();
      db.prepare(`INSERT INTO environments (id, name, config) VALUES ('env_damaged', 'damaged', '{oops')`).run();

      expect(() => manager.create({ agent: 'agent_test', environmentId: 'env_team' }))
        .toThrow(/not a known hosting type/);
      expect(() => manager.create({ agent: 'agent_test', environmentId: 'env_damaged' }))
        .toThrow(/not valid JSON/);
      expect(db.prepare(`SELECT COUNT(*) AS count FROM sessions`).get()).toEqual({ count: 0 });
    });

    it('resolves a container backend declared only as a hosting type', () => {
      db.prepare(`INSERT INTO environments (id, name, config) VALUES ('env_docker_hosting', 'docker', '{"hosting_type":"docker"}')`).run();
      // Creation succeeds — the backend exists — and the session points at the
      // Environment that names it, not at the workspace default.
      const session = manager.create({ agent: 'agent_test', environmentId: 'env_docker_hosting' });
      expect(session.environmentId).toBe('env_docker_hosting');
    });
  });

  describe('event admission', () => {
    it('does not execute already queued turns after the first turn fails', async () => {
      const execute = vi.fn(async function* () {
        throw new Error('unrecoverable model failure');
      });
      manager.setExecutor({ execute });
      const session = manager.create({ agent: 'agent_test' });
      const first = manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'first' }] });
      const second = manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'second' }] });
      await Promise.all([first, second]);
      await vi.waitFor(() => expect(manager.get(session.id)!.status).toBe('failed'));
      await expect(manager.stop(session.id)).rejects.toThrow('terminal state: failed');

      expect(manager.get(session.id)!.status).toBe('failed');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(manager.getEventLogger().getEvents(session.id).filter((event) => event.type === 'session.status_running')).toHaveLength(1);
    });

    it('refuses failed-session input before recording events or invoking the executor', async () => {
      const execute = vi.fn(async function* () {});
      manager.setExecutor({ execute });
      const session = manager.create({ agent: 'agent_test' });
      manager.getEventLogger().append(session.id, {
        type: 'agent.tool_use',
        content: [{ type: 'tool_use', id: 'call_unresolved', name: 'glob', input: { pattern: '*' } }],
      });
      db.prepare(`UPDATE sessions SET status = 'failed' WHERE id = ?`).run(session.id);
      const before = manager.getEventLogger().getEvents(session.id);

      await expect(manager.sendEvent(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'continue' }],
      })).rejects.toThrow(/terminal state: failed/);
      expect(manager.getEventLogger().getEvents(session.id)).toEqual(before);
      expect(manager.get(session.id)!.status).toBe('failed');
      expect(execute).not.toHaveBeenCalled();
    });

    it('refuses to accept an event for a session whose Environment stopped resolving', () => {
      db.prepare(`INSERT INTO environments (id, name, config) VALUES ('env_docker_hosting', 'docker', '{"hosting_type":"docker"}')`).run();
      const session = manager.create({ agent: 'agent_test', environmentId: 'env_docker_hosting' });
      // A later edit replaced the Environment with a hosting type this runtime
      // cannot run. Admission must refuse before the append-only log or any
      // execution, rather than resolving to the local backend.
      db.prepare(`UPDATE environments SET config = '{"hosting_type":"team_server"}' WHERE id = 'env_docker_hosting'`).run();
      expect(() => manager.assertSessionCanAcceptEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'hi' }] } as never))
        .toThrow(/not a known hosting type/);
      expect(manager.getEventLogger().getEvents(session.id)).toHaveLength(0);
    });
  });

  describe('get', () => {
    it('retrieves a created session', () => {
      const created = manager.create({ agent: 'agent_test' });
      const retrieved = manager.get(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.status).toBe('queued');
    });

    it('returns null for non-existent session', () => {
      expect(manager.get('sess_nonexist')).toBeNull();
    });
  });

  describe('list', () => {
    it('lists sessions with pagination', () => {
      for (let i = 0; i < 5; i++) {
        manager.create({ agent: 'agent_test', title: `session-${i}` });
      }

      const page1 = manager.list({ pageSize: 3 });
      expect(page1.data).toHaveLength(3);
      expect(page1.total).toBe(5);
      expect(page1.hasMore).toBe(true);

      const page2 = manager.list({ page: 2, pageSize: 3 });
      expect(page2.data).toHaveLength(2);
      expect(page2.hasMore).toBe(false);
    });

    it('returns empty when no sessions exist', () => {
      const result = manager.list();
      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('stop', () => {
    it('leaves an idle session unchanged', async () => {
      const session = manager.create({ agent: 'agent_test' });
      await manager.stop(session.id);
      const stopped = manager.get(session.id);
      expect(stopped!.status).toBe('queued');
    });

    it('throws for non-existent session', async () => {
      await expect(manager.stop('sess_nonexist')).rejects.toThrow('Session not found');
    });
  });

  describe('subscribe', () => {
    it('receives events when broadcast', async () => {
      const session = manager.create({ agent: 'agent_test' });
      const received: any[] = [];
      manager.subscribe(session.id, (evt) => received.push(evt));

      await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'hello' }] });
      expect(received.length).toBeGreaterThan(0);
    });

    it('unsubscribe stops receiving events', async () => {
      const session = manager.create({ agent: 'agent_test' });
      const received: any[] = [];
      const unsub = manager.subscribe(session.id, (evt) => received.push(evt));
      unsub();

      await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'hello' }] });
      expect(received).toHaveLength(0);
    });
  });

  describe('automatic continuation', () => {
    it('keeps non-terminal sessions queryable for the next user event', () => {
      const session = manager.create({ agent: 'agent_test' });
      const current = manager.get(session.id);
      expect(current!.status).toBe('queued');
      expect(current!.id).toBe(session.id);
    });
  });
});
