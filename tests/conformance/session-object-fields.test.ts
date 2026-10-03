/**
 * The session object the routes publish, end to end through the real router:
 * `budget` is always present, `stats` carries `active_seconds` and
 * `duration_seconds`, and the materialized agent carries `multiagent` and the
 * pinned `version`. The key-set half of this contract — every emitted key is
 * an official `BetaManagedAgentsSession` key or the `loop_engine` extension —
 * lives in `tests/unit/api-standard.test.ts`, which asserts the serializer
 * directly; this suite asserts the route wiring that feeds it real event
 * history.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLogger } from '@/core/session/event-logger.js';
import { disposeConformanceContexts, makeConformanceApp, type ConformanceContext } from './support/app.js';

const contexts: ConformanceContext[] = [];

function context() {
  const ctx = makeConformanceApp('ma-conformance-session-fields-');
  contexts.push(ctx);
  return ctx;
}

const AGENT_DEFINITION = JSON.stringify({
  name: 'fields-agent',
  model: 'conformance-model',
  system: 'Be brief.',
});

async function createSession(ctx: ConformanceContext): Promise<Record<string, unknown>> {
  const res = await ctx.app.request('/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'agent_fields', environment_id: 'env_default' }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Record<string, unknown>;
}

describe('session object fields over HTTP', () => {
  afterEach(() => {
    disposeConformanceContexts(contexts);
  });

  it('publishes budget, stats, and the snapshot agent on create, retrieve, and list', async () => {
    const ctx = context();
    ctx.db
      .prepare(`INSERT INTO agents (id, name, definition) VALUES ('agent_fields', 'fields-agent', ?)`)
      .run(AGENT_DEFINITION);

    const created = await createSession(ctx);
    expect(created.budget).toBeNull();
    expect(created.stats).toMatchObject({
      active_seconds: expect.any(Number),
      duration_seconds: expect.any(Number),
    });
    expect(created.agent).toMatchObject({ version: 1, multiagent: null });
    expect(created.outcome_evaluations).toEqual([]);

    const retrieved = await (await ctx.app.request(`/v1/sessions/${created.id}`)).json() as Record<string, any>;
    expect(retrieved.budget).toBeNull();
    expect(retrieved.agent).toMatchObject({ version: 1, multiagent: null });
    expect(retrieved.outcome_evaluations).toEqual([]);

    const listed = await (await ctx.app.request('/v1/sessions')).json() as { data: Array<Record<string, any>> };
    const row = listed.data.find((s) => s.id === created.id);
    expect(row).toBeDefined();
    expect(row!.budget).toBeNull();
    expect(row!.stats).toMatchObject({ active_seconds: expect.any(Number), duration_seconds: expect.any(Number) });
    expect(row!.outcome_evaluations).toEqual([]);
  });

  it('derives outcome_evaluations from the declaration and its end span', async () => {
    const ctx = context();
    ctx.db
      .prepare(`INSERT INTO agents (id, name, definition) VALUES ('agent_fields', 'fields-agent', ?)`)
      .run(AGENT_DEFINITION);
    const session = await createSession(ctx);

    // The same rows the grading loop appends: a declaration carrying its
    // admission-assigned outcome_id, and the closing end span that joins it.
    const logger = new EventLogger(ctx.db);
    logger.append(session.id as string, {
      type: 'user.define_outcome',
      metadata: {
        outcome_id: 'outc_route',
        description: 'Ship a working endpoint',
        rubric: { type: 'text', content: 'The endpoint returns 200' },
        max_iterations: 3,
      },
    });
    logger.append(session.id as string, { type: 'session.status_running' });
    logger.append(session.id as string, {
      type: 'span.outcome_evaluation_end',
      metadata: {
        outcome_id: 'outc_route',
        iteration: 0,
        result: 'satisfied',
        explanation: 'The endpoint returns 200.',
      },
    });

    const expected = {
      type: 'outcome_evaluation',
      outcome_id: 'outc_route',
      description: 'Ship a working endpoint',
      result: 'satisfied',
      iteration: 0,
      explanation: 'The endpoint returns 200.',
      completed_at: expect.any(String),
    };
    const retrieved = await (await ctx.app.request(`/v1/sessions/${session.id}`)).json() as {
      outcome_evaluations: unknown[];
    };
    expect(retrieved.outcome_evaluations).toEqual([expected]);

    // The list route derives the same entry from its bulk event query.
    const listed = await (await ctx.app.request('/v1/sessions')).json() as {
      data: Array<{ id: string; outcome_evaluations: unknown[] }>;
    };
    expect(listed.data.find((s) => s.id === session.id)!.outcome_evaluations).toEqual([expected]);
  });

  it('derives stats.active_seconds from the status-transition event log', async () => {
    const ctx = context();
    ctx.db
      .prepare(`INSERT INTO agents (id, name, definition) VALUES ('agent_fields', 'fields-agent', ?)`)
      .run(AGENT_DEFINITION);
    const session = await createSession(ctx);

    const logger = new EventLogger(ctx.db);
    logger.append(session.id as string, { type: 'session.status_running' });

    // The running interval is still open, so the count grows with wall time:
    // poll until it is measurably positive rather than racing a millisecond.
    await vi.waitFor(async () => {
      const body = await (await ctx.app.request(`/v1/sessions/${session.id}`)).json() as {
        stats: { active_seconds: number; duration_seconds: number };
      };
      expect(body.stats.active_seconds).toBeGreaterThan(0);
      expect(body.stats.duration_seconds).toBeGreaterThanOrEqual(body.stats.active_seconds);
    }, { timeout: 5_000, interval: 25 });

    // The list route computes the same field from a single bulk query.
    const listed = await (await ctx.app.request('/v1/sessions')).json() as {
      data: Array<{ id: string; stats: { active_seconds: number } }>;
    };
    expect(listed.data.find((s) => s.id === session.id)!.stats.active_seconds).toBeGreaterThan(0);
  });
});
