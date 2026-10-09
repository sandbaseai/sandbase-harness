/**
 * Auxiliary model-request usage — the canonical record for a model call that
 * ran outside the streamed turn: a compaction summary, an outcome grading
 * pass, a permission judgement.
 *
 * `recordAuxiliaryModelUsage` writes the same pair a turn produces — one
 * `span.model_request_end` plus the session-aggregate update — so the
 * session row and the event log cannot diverge on a request the turn loop
 * never saw. The span is marked `metadata.auxiliary` so context measurement
 * does not anchor on a request that carried the transcript.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { EventLogger } from '@/core/session/event-logger.js';

describe('recordAuxiliaryModelUsage', () => {
  let db: Database;
  let logger: EventLogger;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-aux-usage-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_1', 'a', '{}')`);
    db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status)
             VALUES ('sess_1', 'agent_1', 'a', 'env_default', 'idle')`);
    logger = new EventLogger(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function sessionUsage() {
    return db.prepare(
      `SELECT usage_tokens_in AS i, usage_tokens_out AS o,
              usage_cache_read_tokens AS r, usage_cache_write_tokens AS w
       FROM sessions WHERE id = 'sess_1'`,
    ).get() as { i: number; o: number; r: number; w: number };
  }

  function spanSums() {
    return db.prepare(
      `SELECT COALESCE(SUM(tokens_in),0) AS i, COALESCE(SUM(tokens_out),0) AS o,
              COALESCE(SUM(cache_read_tokens),0) AS r, COALESCE(SUM(cache_write_tokens),0) AS w
       FROM events WHERE session_id = 'sess_1' AND type = 'span.model_request_end'`,
    ).get() as { i: number; o: number; r: number; w: number };
  }

  it('appends an auxiliary-marked end span and updates the session aggregate identically', () => {
    const event = logger.recordAuxiliaryModelUsage('sess_1', {
      inputTokens: 100,
      inputTokenDetails: { noCacheTokens: 40, cacheReadTokens: 50, cacheWriteTokens: 10 },
      outputTokens: 7,
    }, { purpose: 'context_compaction', modelUsed: 'model-x' });

    expect(event.type).toBe('span.model_request_end');
    expect(event.tokensIn).toBe(40);
    expect(event.tokensOut).toBe(7);
    expect(event.cacheReadTokens).toBe(50);
    expect(event.cacheWriteTokens).toBe(10);
    expect(event.isError).toBe(false);
    expect(event.metadata).toEqual({ auxiliary: 'context_compaction' });

    const usage = sessionUsage();
    expect(usage).toEqual({ i: 40, o: 7, r: 50, w: 10 });
    // The two aggregates the metrics summary reports must not diverge on a
    // request the turn loop never produced.
    expect(spanSums()).toEqual(usage);
  });

  it('records one canonical pair per request across several auxiliary calls', () => {
    logger.recordAuxiliaryModelUsage('sess_1', { inputTokens: 5, outputTokens: 2 }, { purpose: 'auto_permission' });
    logger.recordAuxiliaryModelUsage('sess_1', { inputTokens: 8, outputTokens: 3 }, { purpose: 'outcome_evaluation' });
    logger.recordAuxiliaryModelUsage('sess_1', undefined, { purpose: 'outcome_evaluation' });

    const spans = db.prepare(
      `SELECT metadata FROM events WHERE session_id = 'sess_1' AND type = 'span.model_request_end' ORDER BY seq`,
    ).all() as { metadata: string }[];
    expect(spans).toHaveLength(3);
    expect(spans.map((s) => JSON.parse(s.metadata).auxiliary)).toEqual([
      'auto_permission',
      'outcome_evaluation',
      'outcome_evaluation',
    ]);
    // A request the provider reported no usage for still exists in the log —
    // it just contributes nothing.
    expect(sessionUsage()).toEqual({ i: 13, o: 5, r: 0, w: 0 });
    expect(spanSums()).toEqual({ i: 13, o: 5, r: 0, w: 0 });
  });
});
