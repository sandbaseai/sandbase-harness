/**
 * One outcome evaluation: the span triple, and what the grader is allowed to see.
 *
 * `contracts/anthropic-cma/events.md` §2 says an evaluation appends exactly three
 * events in order, that the end event is appended on every path, and that it
 * carries the verdict. These tests pin the sequence itself and the two failure
 * shapes a sequence alone cannot express: a grader that throws still closes the
 * span, and the transcript handed to the grader excludes the runtime's own
 * scaffolding.
 */

import { describe, it, expect } from 'vitest';
import { runOutcomeEvaluation } from '@/core/outcomes/evaluation.js';
import { createModelOutcomeGrader } from '@/core/outcomes/grader.js';
import { outcomeTranscript } from '@/core/session/outcome-transcript.js';
import { eventsToMessages } from '@/core/session/events-to-messages.js';
import type { SessionEvent } from '@/types/session.js';

let seq = 0;
function appendSpy() {
  const appended: Array<{ type: string; metadata: Record<string, unknown> }> = [];
  return {
    appended,
    logger: {
      append: (input: { type: string; metadata: Record<string, unknown> }) => {
        appended.push(input);
        seq += 1;
        return { id: `sevt_${seq}` } as SessionEvent;
      },
    },
  };
}

const request = {
  outcomeId: 'outc_test',
  iteration: 0,
  description: 'Ship a working endpoint',
  rubric: '- returns 200',
};

describe('runOutcomeEvaluation', () => {
  it('appends the span triple in order and publishes the verdict', async () => {
    const { appended, logger } = appendSpy();
    const evaluation = await runOutcomeEvaluation({
      ...request,
      grader: { grade: async () => ({ result: 'satisfied', explanation: 'The endpoint returns 200.' }) },
      logger,
      readTranscript: () => 'assistant: done',
    });

    expect(appended.map((event) => event.type)).toEqual([
      'span.outcome_evaluation_start',
      'span.outcome_evaluation_ongoing',
      'span.outcome_evaluation_end',
    ]);
    expect(evaluation).toEqual({ result: 'satisfied', explanation: 'The endpoint returns 200.' });

    const [start, ongoing, end] = appended;
    expect(start.metadata).toEqual({ outcome_id: 'outc_test', iteration: 0 });
    // The in-flight marker carries no verdict: there is nothing to report yet.
    expect(ongoing.metadata).toEqual({ outcome_id: 'outc_test', iteration: 0 });
    expect(end.metadata).toMatchObject({
      outcome_id: 'outc_test',
      iteration: 0,
      result: 'satisfied',
      explanation: 'The endpoint returns 200.',
      outcome_evaluation_start_id: 'sevt_1',
    });
  });

  it('carries needs_revision through as the verdict the loop will act on', async () => {
    const { appended, logger } = appendSpy();
    const evaluation = await runOutcomeEvaluation({
      ...request,
      grader: { grade: async () => ({ result: 'needs_revision', explanation: 'The response body is empty.' }) },
      logger,
      readTranscript: () => 'assistant: drafted the handler',
    });
    expect(evaluation.result).toBe('needs_revision');
    expect(appended.at(-1)?.metadata.result).toBe('needs_revision');
  });

  it('records the grading request’s usage before publishing the verdict', async () => {
    const { appended, logger } = appendSpy();
    const recorded: unknown[] = [];
    const evaluation = await runOutcomeEvaluation({
      ...request,
      grader: {
        grade: async () => ({
          result: 'satisfied',
          explanation: 'ok',
          usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3 },
        }),
      },
      logger: { ...logger, recordModelUsage: (usage) => recorded.push(usage) },
      readTranscript: () => 'assistant: done',
    });

    expect(evaluation.result).toBe('satisfied');
    expect(recorded).toEqual([{ input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3 }]);
    // The verdict span still carries the usage it published, unchanged.
    expect(appended.at(-1)?.metadata.usage).toEqual({
      input_tokens: 12,
      output_tokens: 4,
      cache_read_input_tokens: 3,
    });
  });

  it('closes the evaluation when the grader throws, then propagates the failure', async () => {
    const { appended, logger } = appendSpy();
    await expect(runOutcomeEvaluation({
      ...request,
      grader: { grade: async () => { throw new Error('no model provider'); } },
      logger,
      readTranscript: () => '',
    })).rejects.toThrow('no model provider');

    // A client waiting on the end event must not hang on an evaluation that is over.
    const end = appended.at(-1)!;
    expect(end.type).toBe('span.outcome_evaluation_end');
    expect(end.metadata).toMatchObject({ result: 'failed', explanation: 'no model provider' });
  });

  it('refuses to grade when no provider is configured, with its own code', async () => {
    const grader = createModelOutcomeGrader({ getDefaultName: () => undefined } as never);
    const { appended, logger } = appendSpy();
    await expect(runOutcomeEvaluation({ ...request, grader, logger, readTranscript: () => '' }))
      .rejects.toMatchObject({ code: 'outcome_evaluator_unavailable' });
    expect(appended.at(-1)?.metadata.result).toBe('failed');
  });
});

describe('outcomeTranscript', () => {
  it('carries what the agent produced and nothing else', () => {
    const events = [
      { id: 'sevt_1', sessionId: 'sess_1', seq: 1, type: 'session.status_running', createdAt: new Date() },
      {
        id: 'sevt_2',
        sessionId: 'sess_1',
        seq: 2,
        type: 'user.define_outcome',
        metadata: { description: 'Ship an endpoint', rubric: { type: 'text', content: 'returns 200' } },
        createdAt: new Date(),
      },
      {
        id: 'sevt_3',
        sessionId: 'sess_1',
        seq: 3,
        type: 'agent.message',
        content: [{ type: 'text', text: 'Added the handler.' }],
        createdAt: new Date(),
      },
      {
        id: 'sevt_4',
        sessionId: 'sess_1',
        seq: 4,
        type: 'span.outcome_evaluation_end',
        metadata: { outcome_id: 'outc_1', iteration: 0, result: 'needs_revision' },
        createdAt: new Date(),
      },
    ] as SessionEvent[];

    const transcript = outcomeTranscript(events);
    expect(transcript).toBe('assistant: Added the handler.');
    // The earlier verdict and the outcome instruction are excluded on purpose:
    // an evaluation anchored to either is not measuring the deliverable.
    expect(transcript).not.toContain('needs_revision');
    expect(transcript).not.toContain('Ship an endpoint');
  });
});

describe('outcomeInstruction projection', () => {
  it('turns a persisted outcome into the instruction the agent works against', () => {
    const messages = eventsToMessages([{
      id: 'sevt_1',
      sessionId: 'sess_1',
      seq: 1,
      type: 'user.define_outcome',
      metadata: {
        description: 'Ship a working endpoint',
        rubric: { type: 'text', content: 'returns 200' },
        max_iterations: 5,
      },
      createdAt: new Date(),
    } as SessionEvent]);

    const text = messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content.map((part) => ('text' in part ? part.text : '')).join(''))
      .join('\n');
    expect(text).toContain('Ship a working endpoint');
    expect(text).toContain('returns 200');
    expect(text).toContain('Evaluation iterations allowed: 5');
  });
});
