/**
 * Unit tests for Event Logger.
 * Validates: Property 7 — Event_Log append-only invariant.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { EventLogger } from '@/core/session/event-logger.js';

describe('Event Logger', () => {
  let db: Database;
  let logger: EventLogger;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-test-'));
    const dbPath = join(tmpDir, 'test.db');
    db = new Database(dbPath);
    db.runMigrations();

    // Insert a dummy session for FK constraint
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_test', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'test-agent', '{}')`);
    db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status) VALUES ('sess_test', 'agent_test', 'test-agent', 'env_test', 'running')`);

    logger = new EventLogger(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('append', () => {
    it('appends an event with auto-incremented seq', () => {
      const event = logger.append('sess_test', {
        type: 'user.message',
        content: [{ type: 'text', text: 'Hello' }],
      });

      expect(event.id).toMatch(/^sevt_/);
      expect(event.seq).toBe(1);
      expect(event.sessionId).toBe('sess_test');
      expect(event.type).toBe('user.message');
    });

    it('increments seq on each append', () => {
      const e1 = logger.append('sess_test', { type: 'user.message' });
      const e2 = logger.append('sess_test', { type: 'agent.message' });
      const e3 = logger.append('sess_test', { type: 'agent.tool_use' });

      expect(e1.seq).toBe(1);
      expect(e2.seq).toBe(2);
      expect(e3.seq).toBe(3);
    });

    it('preserves content blocks', () => {
      const content = [{ type: 'text' as const, text: 'Hello world' }];
      const event = logger.append('sess_test', { type: 'agent.message', content });
      expect(event.content).toEqual(content);
    });
  });

  describe('getEvents', () => {
    it('returns all events in seq order', () => {
      logger.append('sess_test', { type: 'user.message' });
      logger.append('sess_test', { type: 'agent.message' });
      logger.append('sess_test', { type: 'agent.tool_use' });

      const events = logger.getEvents('sess_test');
      expect(events).toHaveLength(3);
      expect(events[0].seq).toBe(1);
      expect(events[1].seq).toBe(2);
      expect(events[2].seq).toBe(3);
    });

    it('supports afterSeq filter', () => {
      logger.append('sess_test', { type: 'user.message' });
      logger.append('sess_test', { type: 'agent.message' });
      logger.append('sess_test', { type: 'agent.tool_use' });

      const events = logger.getEvents('sess_test', 1);
      expect(events).toHaveLength(2);
      expect(events[0].seq).toBe(2);
    });

    it('returns empty array for non-existent session', () => {
      const events = logger.getEvents('sess_nonexist');
      expect(events).toEqual([]);
    });
  });

  describe('getLatestSeq', () => {
    it('returns 0 for empty session', () => {
      expect(logger.getLatestSeq('sess_test')).toBe(0);
    });

    it('returns the highest seq after appends', () => {
      logger.append('sess_test', { type: 'user.message' });
      logger.append('sess_test', { type: 'agent.message' });
      expect(logger.getLatestSeq('sess_test')).toBe(2);
    });
  });

  describe('recordUsage', () => {
    it('accumulates canonical model-request usage on the session', () => {
      logger.recordUsage('sess_test', 120, 30);
      logger.recordUsage('sess_test', 80, 20);

      const row = db.prepare(
        'SELECT usage_tokens_in, usage_tokens_out FROM sessions WHERE id = ?',
      ).get('sess_test') as { usage_tokens_in: number; usage_tokens_out: number };

      expect(row).toEqual({ usage_tokens_in: 200, usage_tokens_out: 50 });
    });

    it('does not change usage when the session does not exist', () => {
      expect(() => logger.recordUsage('sess_missing', 10, 5)).not.toThrow();
    });
  });

  describe('append-only invariant (Property 7)', () => {
    it('event count monotonically increases', () => {
      const counts: number[] = [];
      for (let i = 0; i < 10; i++) {
        logger.append('sess_test', { type: 'user.message' });
        counts.push(logger.getEvents('sess_test').length);
      }
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i]).toBeGreaterThan(counts[i - 1]);
      }
    });

    it('previously appended events are never modified', () => {
      const e1 = logger.append('sess_test', {
        type: 'user.message',
        content: [{ type: 'text', text: 'original' }],
      });
      logger.append('sess_test', { type: 'agent.message' });
      logger.append('sess_test', { type: 'agent.tool_use' });

      const events = logger.getEvents('sess_test');
      const retrieved = events.find((e) => e.id === e1.id);
      expect(retrieved?.content).toEqual([{ type: 'text', text: 'original' }]);
      expect(retrieved?.seq).toBe(1);
    });
  });
});
