/**
 * Unit tests for the usage accounting identity on `GET /metrics/summary`.
 *
 * The endpoint reports the same total twice, computed two ways:
 *   events.input_tokens    SUM(tokens_in) FROM events WHERE type = 'span.model_request_end'
 *   sessions.input_tokens  SUM(usage_tokens_in) FROM sessions
 *
 * Since `bdd164a6d` those are meant to agree. Nothing checked that they do.
 * These tests check it, against the route's own SQL, and check that the check
 * can fail. They need no ground truth and no vendor account.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { EventLogger } from '@/core/session/event-logger.js';
import { runtimeRoutes } from '@/api/routes/runtime.js';
import type { ServerDeps } from '@/api/server.js';

interface MetricsSummary {
  sessions: { input_tokens: number; output_tokens: number };
  events: { input_tokens: number; output_tokens: number };
}

/**
 * Read the two aggregates from the real handler. `/metrics/summary` reaches for
 * `deps.db` and optional-chains everything else, so the route can be mounted on
 * a database alone.
 */
async function metricsSummary(db: Database): Promise<MetricsSummary> {
  const app = runtimeRoutes({ db } as unknown as ServerDeps);
  const res = await app.request('/metrics/summary');
  expect(res.status).toBe(200);
  return (await res.json()) as MetricsSummary;
}

/**
 * One model request, logged the way `default-strategy.ts` logs it: the
 * canonical span, the projected events that copy the same numbers for local
 * attribution, and one `recordUsage` call for the session aggregate.
 */
function logModelRequest(
  logger: EventLogger,
  sessionId: string,
  tokensIn: number,
  tokensOut: number,
  options: { projections?: number; recordAggregate?: boolean } = {},
): void {
  const { projections = 2, recordAggregate = true } = options;

  logger.append(sessionId, {
    type: 'span.model_request_end',
    tokensIn,
    tokensOut,
    durationMs: 42,
  });

  // These carry the same usage on purpose. They are why the metrics query
  // filters on the span type instead of summing the column.
  for (let i = 0; i < projections; i++) {
    logger.append(sessionId, { type: 'agent.message', tokensIn, tokensOut });
  }

  if (recordAggregate) {
    logger.recordUsage(sessionId, tokensIn, tokensOut);
  }
}

describe('usage accounting identity', () => {
  let db: Database;
  let logger: EventLogger;
  let tmpDir: string;

  const seedSession = (sessionId: string): void => {
    db.prepare(
      `INSERT INTO sessions (id, agent_id, agent_name, environment_id, status)
       VALUES (?, 'agent_test', 'test-agent', 'env_test', 'running')`,
    ).run(sessionId);
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-usage-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_test', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'test-agent', '{}')`);
    seedSession('sess_a');
    logger = new EventLogger(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('holds over a single model request', async () => {
    logModelRequest(logger, 'sess_a', 120, 30);

    const summary = await metricsSummary(db);
    expect(summary.events.input_tokens).toBe(summary.sessions.input_tokens);
    expect(summary.events.output_tokens).toBe(summary.sessions.output_tokens);
    expect(summary.events.input_tokens).toBe(120);
    expect(summary.events.output_tokens).toBe(30);
  });

  it('holds across many requests and several sessions', async () => {
    seedSession('sess_b');
    seedSession('sess_c');

    logModelRequest(logger, 'sess_a', 120, 30);
    logModelRequest(logger, 'sess_a', 80, 20, { projections: 5 });
    logModelRequest(logger, 'sess_b', 7, 1, { projections: 0 });
    logModelRequest(logger, 'sess_c', 1024, 256, { projections: 3 });

    const summary = await metricsSummary(db);
    expect(summary.events.input_tokens).toBe(summary.sessions.input_tokens);
    expect(summary.events.output_tokens).toBe(summary.sessions.output_tokens);
    expect(summary.events.input_tokens).toBe(1231);
    expect(summary.events.output_tokens).toBe(307);
  });

  it('holds on a session that made no model request', async () => {
    seedSession('sess_idle');
    logger.append('sess_idle', { type: 'user.message' });

    const summary = await metricsSummary(db);
    expect(summary.events.input_tokens).toBe(summary.sessions.input_tokens);
    expect(summary.events.input_tokens).toBe(0);
  });

  it('reports the span total rather than the whole column', async () => {
    // Guards the `WHERE type = 'span.model_request_end'` filter. Without it the
    // projections are counted too, which is the shape of the original defect.
    logModelRequest(logger, 'sess_a', 120, 30, { projections: 2 });

    const unfiltered = db.prepare(
      `SELECT COALESCE(SUM(tokens_in), 0) AS input_tokens FROM events`,
    ).get() as { input_tokens: number };
    expect(unfiltered.input_tokens).toBe(360);

    const summary = await metricsSummary(db);
    expect(summary.events.input_tokens).toBe(120);
    expect(summary.sessions.input_tokens).toBe(120);
  });

  describe('the identity can fail', () => {
    it('detects a span that never reached the session aggregate', async () => {
      logModelRequest(logger, 'sess_a', 120, 30, { recordAggregate: false });

      const summary = await metricsSummary(db);
      expect(summary.events.input_tokens).not.toBe(summary.sessions.input_tokens);
      expect(summary.events.input_tokens).toBe(120);
      expect(summary.sessions.input_tokens).toBe(0);
    });

    it('detects a session aggregate written without a span', async () => {
      logger.recordUsage('sess_a', 120, 30);

      const summary = await metricsSummary(db);
      expect(summary.events.input_tokens).not.toBe(summary.sessions.input_tokens);
      expect(summary.events.input_tokens).toBe(0);
      expect(summary.sessions.input_tokens).toBe(120);
    });

    it('detects the silent no-op when recordUsage targets a missing session', async () => {
      // `recordUsage` is a bare UPDATE and does not check the changes count, so
      // this increments nothing and raises nothing. Foreign keys are disabled
      // only to let the span exist without its session row, which is the state a
      // partially applied migration or a manual repair can leave behind.
      db.exec('PRAGMA foreign_keys = OFF');
      logger.append('sess_missing', {
        type: 'span.model_request_end',
        tokensIn: 120,
        tokensOut: 30,
        durationMs: 42,
      });
      expect(() => logger.recordUsage('sess_missing', 120, 30)).not.toThrow();
      db.exec('PRAGMA foreign_keys = ON');

      const summary = await metricsSummary(db);
      expect(summary.events.input_tokens).not.toBe(summary.sessions.input_tokens);
      expect(summary.events.input_tokens).toBe(120);
      expect(summary.sessions.input_tokens).toBe(0);
    });
  });
});
