/**
 * Declared-outcome grading through a session.
 *
 * `contracts/anthropic-cma/sessions.md` §2 says a declared outcome is graded
 * once the turn it queued completes, that the evaluation is published as a span
 * triple, and that a grader which cannot run is reported rather than silently
 * skipped. The unit test pins the sequence and the transcript; this file pins
 * the seam a unit test cannot reach — that `SessionManager.runTurn` actually
 * grades the declared outcome, on the session's own durable log, and that the
 * verdict is readable from the event listing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager, type SessionExecutor } from '@/core/session/session-manager.js';
import type { EventLogger } from '@/core/session/event-logger.js';
import { toApiEvent } from '@/api/standard.js';
import { outcomeEvaluationsFromEvents } from '@/core/outcomes/session-outcomes.js';
import { createModelOutcomeGrader } from '@/core/outcomes/grader.js';
import type { OutcomeGrade, OutcomeGradeInput } from '@/core/outcomes/grader.js';
import { isOutcomeGraderUnavailableError } from '@/core/outcomes/loop.js';
import type { Session, SessionEvent } from '@/types/session.js';

/** An executor that finishes a turn normally, appending one agent message. */
class CompletingExecutor implements SessionExecutor {
  constructor(private readonly logger: EventLogger) {}

  async *execute(session: Session): AsyncIterable<SessionEvent> {
    // The real executor persists its own events; doing it here is what puts the
    // agent's output into the log the grader reads.
    yield this.logger.append(session.id, {
      type: 'agent.message',
      content: [{ type: 'text', text: 'Added the endpoint handler.' }],
    });
  }

  async cleanupSession(): Promise<void> {}
}

const OUTCOME_EVENT = {
  type: 'user.define_outcome',
  description: 'Ship a working endpoint',
  rubric: { type: 'text', content: 'The endpoint returns 200' },
  max_iterations: 3,
} as const;

describe('declared outcome grading', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-outcome-grade-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')`);
    manager = new SessionManager(db);
    manager.setExecutor(new CompletingExecutor(manager.getEventLogger()));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create a session, declare its outcome as an initial event, and settle. */
  async function runDeclaredOutcome() {
    const session = manager.createWithInitialEvents({ agent: 'agent_x' }, [OUTCOME_EVENT as never]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return session;
  }

  it('grades the declared outcome and publishes the span triple on the log', async () => {
    const seen: OutcomeGradeInput[] = [];
    manager.setOutcomeGrader({
      grade: async (input) => {
        seen.push(input);
        return { result: 'satisfied', explanation: 'The endpoint returns 200.' } satisfies OutcomeGrade;
      },
    });

    const session = await runDeclaredOutcome();
    const events = manager.getEventLogger().getEvents(session.id);
    const spans = events.filter((event) => event.type.startsWith('span.outcome_evaluation'));

    expect(spans.map((event) => event.type)).toEqual([
      'span.outcome_evaluation_start',
      'span.outcome_evaluation_ongoing',
      'span.outcome_evaluation_end',
    ]);

    // The grader saw the declared rubric and the agent's own output, and nothing
    // about the runtime's scaffolding.
    expect(seen).toHaveLength(1);
    expect(seen[0].description).toBe('Ship a working endpoint');
    expect(seen[0].rubric).toBe('The endpoint returns 200');
    expect(seen[0].transcript).toContain('Added the endpoint handler.');

    const end = toApiEvent(spans.at(-1)!);
    expect(end.type).toBe('span.outcome_evaluation_end');
    expect(end.metadata).toMatchObject({
      iteration: 0,
      result: 'satisfied',
      explanation: 'The endpoint returns 200.',
    });
    // A satisfied verdict ends the outcome: no revision message is appended and
    // no second evaluation runs. The revision path is pinned in outcome-loop.test.ts.
    expect(spans.filter((event) => event.type === 'span.outcome_evaluation_end')).toHaveLength(1);
    expect(events.some((event) => event.type === 'user.message')).toBe(false);
  });

  it('assigns the outcome_id at admission and joins declaration, spans, and projection on it', async () => {
    manager.setOutcomeGrader({
      grade: async () => ({ result: 'satisfied', explanation: 'Met.' }),
    });

    const session = await runDeclaredOutcome();
    const events = manager.getEventLogger().getEvents(session.id);
    const declared = events.find((event) => event.type === 'user.define_outcome')!;
    const outcomeId = declared.metadata?.outcome_id;

    // The id is generated when the event is admitted — an `outc_` string the
    // caller never sent — and persisted on the declaration itself.
    expect(outcomeId).toMatch(/^outc_/);

    // Every span the loop appended references that same id.
    for (const span of events.filter((event) => event.type.startsWith('span.outcome_evaluation'))) {
      expect(span.metadata?.outcome_id).toBe(outcomeId);
    }

    // The published event carries it at the top level, as the official shape requires.
    const projected = toApiEvent(declared);
    expect(projected.outcome_id).toBe(outcomeId);

    // And the session object's outcome_evaluations entry is derivable from the log.
    expect(outcomeEvaluationsFromEvents(events)).toEqual([
      expect.objectContaining({
        type: 'outcome_evaluation',
        outcome_id: outcomeId,
        description: 'Ship a working endpoint',
        result: 'satisfied',
        iteration: 0,
        explanation: 'Met.',
        completed_at: expect.any(String),
      }),
    ]);
  });

  it('reports a grader with no provider as the session error instead of a verdict', async () => {
    manager.setOutcomeGrader(createModelOutcomeGrader({ getDefaultName: () => undefined } as never));

    const session = await runDeclaredOutcome();
    const events = manager.getEventLogger().getEvents(session.id);
    const error = events.find((event) => event.type === 'session.error');

    expect(error).toBeDefined();
    expect(toApiEvent(error!).error).toMatchObject({
      type: 'unknown_error',
      code: 'outcome_evaluator_unavailable',
      retry_status: { type: 'terminal' },
    });
    // The evaluation is still closed, so a client waiting on the end event sees
    // the outcome fail rather than hang.
    const end = events.filter((event) => event.type === 'span.outcome_evaluation_end').at(-1)!;
    expect(end.metadata).toMatchObject({ result: 'failed' });
  });

  it('refuses a declared outcome when the runtime composes no grader', () => {
    // No setOutcomeGrader: the runtime could never measure this outcome, so the
    // declaration is refused at admission instead of accepted and left ungraded.
    let thrown: unknown;
    try {
      manager.createWithInitialEvents({ agent: 'agent_x' }, [OUTCOME_EVENT as never]);
    } catch (err) {
      thrown = err;
    }
    expect(isOutcomeGraderUnavailableError(thrown)).toBe(true);
    // The refusal is raised inside the creation transaction, so neither the
    // session nor any event survives it.
    expect((db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count).toBe(0);
  });

  it('does not grade a turn that was not declared as an outcome', async () => {
    let grades = 0;
    manager.setOutcomeGrader({
      grade: async () => {
        grades += 1;
        return { result: 'satisfied', explanation: 'nothing to check' };
      },
    });

    const session = manager.create({ agent: 'agent_x' });
    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'just a message' }],
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(grades).toBe(0);
    expect(manager.getEventLogger().getEvents(session.id)
      .some((event) => event.type === 'span.outcome_evaluation_start')).toBe(false);
  });
});
