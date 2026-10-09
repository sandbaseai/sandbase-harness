/**
 * `POST /v1/x/sessions/:id/outcomes/evaluate` usage persistence.
 *
 * The model-assisted evaluator's scoring call is a model request like any
 * other: when it reports usage, the route records the canonical pair — one
 * auxiliary-marked `span.model_request_end` plus the session-aggregate
 * update — so `/v1/x/metrics/summary`'s two aggregates do not diverge on a
 * request no turn produced. The deterministic evaluator makes no model call,
 * so it must leave no trace.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('outcome evaluation usage persistence', () => {
  let db: Database;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let evaluateOutcome: ((input: never) => Promise<{
    status: 'passed' | 'failed' | 'inconclusive';
    score: number;
    summary: string;
    details: Record<string, unknown>;
  }>) | undefined;

  function app() {
    return createServer({
      db,
      sessionManager,
      agents: [{ name: 'a', model: 'm', system: 'p' }],
      consoleRoot: null,
      workspace: {
        root: tmpDir,
        dataDir: tmpDir,
        agentsDir: tmpDir,
        skillsDir: tmpDir,
        target: 'local',
      },
      reloadAgents: () => ({ agents: [], errors: [] }),
      ...(evaluateOutcome ? { evaluateOutcome } : {}),
    } as never);
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-out-eval-usage-'));
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_a', 'a', '{}')`);
    sessionManager = new SessionManager(db);
    evaluateOutcome = undefined;
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function postJson(path: string, body: unknown) {
    const res = await app().request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { res, body: (await res.json()) as any };
  }

  async function evaluate(sessionId: string, outcomeMetadata: Record<string, unknown>) {
    const outcome = await postJson('/v1/x/outcomes', {
      name: 'ship it',
      objective: 'ship a working endpoint',
      criteria: ['returns 200'],
      metadata: outcomeMetadata,
    });
    expect(outcome.res.status).toBe(201);
    return postJson(`/v1/x/sessions/${sessionId}/outcomes/evaluate`, {
      outcome_id: outcome.body.id,
    });
  }

  function sessionUsage(sessionId: string) {
    return db.prepare(
      `SELECT usage_tokens_in AS i, usage_tokens_out AS o,
              usage_cache_read_tokens AS r, usage_cache_write_tokens AS w
       FROM sessions WHERE id = ?`,
    ).get(sessionId) as { i: number; o: number; r: number; w: number };
  }

  it('persists the scoring request’s usage as the canonical span-plus-aggregate pair', async () => {
    evaluateOutcome = async () => ({
      status: 'passed',
      score: 1,
      summary: 'met',
      details: {
        evaluator: 'model_assisted',
        model: 'model-x',
        model_usage: {
          input_tokens: 12,
          output_tokens: 4,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      },
    });

    const session = sessionManager.create({ agent: 'agent_a' });
    const { res } = await evaluate(session.id, { evaluator: 'model_assisted' });
    expect(res.status).toBe(201);

    const usage = sessionUsage(session.id);
    expect(usage).toEqual({ i: 12, o: 4, r: 3, w: 2 });

    const span = db.prepare(
      `SELECT tokens_in AS i, tokens_out AS o, cache_read_tokens AS r,
              cache_write_tokens AS w, model_used AS model, metadata
       FROM events WHERE session_id = ? AND type = 'span.model_request_end'`,
    ).get(session.id) as
      | { i: number; o: number; r: number | null; w: number | null; model: string | null; metadata: string }
      | undefined;
    expect(span).toBeDefined();
    expect({ i: span!.i, o: span!.o, r: span!.r, w: span!.w }).toEqual({ i: 12, o: 4, r: 3, w: 2 });
    expect(span!.model).toBe('model-x');
    expect(JSON.parse(span!.metadata).auxiliary).toBe('outcome_evaluation');
  });

  it('records nothing when the deterministic evaluator runs — no model call happened', async () => {
    const session = sessionManager.create({ agent: 'agent_a' });
    const { res } = await evaluate(session.id, {});
    expect(res.status).toBe(201);

    expect(sessionUsage(session.id)).toEqual({ i: 0, o: 0, r: 0, w: 0 });
    const spans = db.prepare(
      `SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND type = 'span.model_request_end'`,
    ).get(session.id) as { count: number };
    expect(spans.count).toBe(0);
  });
});
