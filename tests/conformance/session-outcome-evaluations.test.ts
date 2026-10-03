/**
 * `outcome_evaluations` end to end, through the official SDK.
 *
 * The session object declares the list as required and the `define_outcome`
 * event declares a server-generated `outcome_id`; this suite drives one real
 * outcome — the stub model answers the turn, then answers the grader's request
 * with a `satisfied` verdict — and asserts that an official client sees the
 * same `outc_` id on the declaration event and on the session's evaluation
 * entry once the loop closes.
 */

import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { startRuntimeHarness, type RunningRuntime } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('official SDK outcome_evaluations over HTTP', () => {
  it('reports the declared outcome as satisfied and joins it on outcome_id', async () => {
    // Requests: (1) the turn's tool call, (2) the turn's final text, (3) the
    // grader's scoring call — which gets the verdict the loop should close on.
    const stub = await startStubModelServer({
      replyTexts: {
        3: JSON.stringify({ result: 'satisfied', explanation: 'The endpoint returns 200.' }),
      },
    });
    let runtime: RunningRuntime | undefined;
    try {
      runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });
      const agents = await client.beta.agents.list();
      const environments = await client.beta.environments.list();
      const session = await client.beta.sessions.create({
        agent: agents.data[0]!.id,
        environment_id: environments.data[0]!.id,
        initial_events: [{
          type: 'user.define_outcome',
          description: 'Ship a working endpoint',
          rubric: { type: 'text', content: 'The endpoint returns 200' },
          max_iterations: 1,
        }],
      });

      // The admission response already carries the list: the declaration is
      // accepted, work has not necessarily started, and nothing is closed.
      expect(session.outcome_evaluations).toHaveLength(1);
      expect(session.outcome_evaluations[0]!.type).toBe('outcome_evaluation');
      expect(session.outcome_evaluations[0]!.description).toBe('Ship a working endpoint');
      expect(session.outcome_evaluations[0]!.outcome_id).toMatch(/^outc_/);
      expect(session.outcome_evaluations[0]!.completed_at).toBeNull();

      // Wait for the loop to close, then re-read: the entry reports the end
      // span's verdict, iteration, explanation, and completion time.
      let evaluations: Awaited<ReturnType<typeof client.beta.sessions.retrieve>>['outcome_evaluations'] = [];
      await vi.waitFor(async () => {
        evaluations = (await client.beta.sessions.retrieve(session.id)).outcome_evaluations;
        expect(evaluations[0]?.completed_at).not.toBeNull();
      }, { timeout: 60_000, interval: 250 });

      const entry = evaluations[0]!;
      expect(entry.outcome_id).toBe(session.outcome_evaluations[0]!.outcome_id);
      expect(entry.result).toBe('satisfied');
      expect(entry.iteration).toBe(0);
      expect(entry.explanation).toBe('The endpoint returns 200.');

      // The declaration event on the log carries the same server-assigned id —
      // the field the official event shape requires and the spans reference.
      const events = await client.beta.sessions.events.list(session.id);
      const declared = events.data.find((event) => event.type === 'user.define_outcome');
      if (declared?.type !== 'user.define_outcome') throw new Error('declaration event missing');
      expect(declared.outcome_id).toBe(entry.outcome_id);
      expect(declared.max_iterations).toBe(1);
    } finally {
      await runtime?.stop();
      await stub.close();
    }
  }, 300_000);
});
