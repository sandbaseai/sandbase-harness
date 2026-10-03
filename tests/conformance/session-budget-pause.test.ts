import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('official SDK session budget pause', () => {
  it('idles a turn at the spending ceiling and resumes on a budget update', async () => {
    const stub = await startStubModelServer({
      toolCalls: [{ name: 'bash', arguments: { command: 'echo conformance' } }],
    });
    const runtime = await startRuntimeHarness({
      modelBaseUrl: stub.baseUrl,
      // The stub reports 19 tokens per request; at this rate one step costs
      // ~1900 cents, so a 100-cent ceiling is crossed by the first model step.
      costProfile: {
        id: 'conformance',
        models: {
          'conformance-model': { input_per_mtok_cents: 100_000_000, output_per_mtok_cents: 100_000_000 },
        },
        web_search_per_1000_cents: 0,
        active_hour_cents: 0,
      },
    });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });
      const agents = await client.beta.agents.list();
      const environments = await client.beta.environments.list();
      const session = await client.beta.sessions.create({
        agent: agents.data[0]!.id,
        environment_id: environments.data[0]!.id,
        budget: { type: 'limit', max_list_cost: { amount: '100', currency: 'USD' } },
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'Run a command.' }] }],
      });

      const idleReason = async () => {
        const events = await client.beta.sessions.events.list(session.id);
        const idle = events.data.filter((event) => event.type === 'session.status_idle').at(-1);
        return idle && 'stop_reason' in idle && idle.stop_reason ? idle.stop_reason.type : undefined;
      };

      // The turn stops after the step that crossed the ceiling: exactly one
      // model request ran, session.usage precedes the idle, and its reason is
      // the published budget_reached — not a refusal of the next event.
      await vi.waitFor(async () => {
        expect(await idleReason()).toBe('budget_reached');
      }, { timeout: 60_000, interval: 250 });
      expect(stub.requests).toHaveLength(1);
      const firstLog = (await client.beta.sessions.events.list(session.id)).data;
      const idleIndex = firstLog.findIndex((event) => event.type === 'session.status_idle');
      expect(firstLog[idleIndex - 1]?.type).toBe('session.usage');

      // A work-starting event at the ceiling is refused with the settlement list.
      await expect(client.beta.sessions.events.send(session.id, {
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'More work.' }] }],
      })).rejects.toMatchObject({ status: 400 });

      // Raising the ceiling re-enters the loop on its own: the resumed turn
      // makes the request the pause withheld, no user.message is appended, and
      // the session settles on end_turn.
      await client.beta.sessions.update(session.id, {
        budget: { type: 'limit', max_list_cost: { amount: '5000', currency: 'USD' } },
      });
      await vi.waitFor(async () => {
        expect(stub.requests.length).toBeGreaterThanOrEqual(2);
      }, { timeout: 60_000, interval: 250 });
      await vi.waitFor(async () => {
        expect(await idleReason()).toBe('end_turn');
      }, { timeout: 60_000, interval: 250 });

      const finalLog = (await client.beta.sessions.events.list(session.id)).data;
      expect(finalLog.filter((event) => event.type === 'user.message')).toHaveLength(1);
      expect(finalLog.filter((event) => event.type === 'session.status_running').length).toBeGreaterThanOrEqual(2);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 180_000);
});
