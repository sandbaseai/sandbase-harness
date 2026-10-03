import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

type SessionEvent = { id: string; type: string } & Record<string, unknown>;

async function eventLog(client: Anthropic, sessionId: string): Promise<SessionEvent[]> {
  const events = await client.beta.sessions.events.list(sessionId);
  return events.data as unknown as SessionEvent[];
}

function lastIdleReason(log: SessionEvent[]): string | undefined {
  const idle = log.filter((event) => event.type === 'session.status_idle').at(-1);
  const reason = idle && (idle.stop_reason as { type?: string } | undefined);
  return reason?.type;
}

describe('official SDK session rescheduling', () => {
  it('publishes rescheduled, recovery, and idle when a transient error retries', async () => {
    const stub = await startStubModelServer({ failRequests: [1], failStatus: 503 });
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });
      const agents = await client.beta.agents.list();
      const environments = await client.beta.environments.list();
      const session = await client.beta.sessions.create({
        agent: agents.data[0]!.id,
        environment_id: environments.data[0]!.id,
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'Say hi.' }] }],
      });

      // The stub answers a tool call first, so a complete turn needs two
      // requests: the failed one, the retried tool-call reply, then the text.
      await vi.waitFor(async () => {
        const log = await eventLog(client, session.id);
        expect(lastIdleReason(log)).toBe('end_turn');
      }, { timeout: 60_000, interval: 250 });
      expect(stub.requests).toHaveLength(3);

      const log = await eventLog(client, session.id);
      const types = log.map((event) => event.type);
      const rescheduledAt = types.indexOf('session.status_rescheduled');
      expect(rescheduledAt).toBeGreaterThan(types.indexOf('session.status_running'));
      expect(types.lastIndexOf('session.status_running')).toBeGreaterThan(rescheduledAt);

      const errorEvent = log.find((event) => event.type === 'session.error');
      const error = errorEvent?.error as { type?: string; retry_status?: { type?: string } } | undefined;
      expect(error?.type).toBe('model_request_failed_error');
      expect(error?.retry_status?.type).toBe('retrying');
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);

  it('publishes exhausted and retries_exhausted when the policy gives up, then still answers', async () => {
    // Initial request plus three retries — every one answered 503, so the
    // policy is what ends the turn. The stub answers normally afterwards,
    // which the follow-up message exercises.
    const stub = await startStubModelServer({ failRequests: [1, 2, 3, 4], failStatus: 503 });
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });
      const agents = await client.beta.agents.list();
      const environments = await client.beta.environments.list();
      const session = await client.beta.sessions.create({
        agent: agents.data[0]!.id,
        environment_id: environments.data[0]!.id,
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'Say hi.' }] }],
      });

      await vi.waitFor(async () => {
        const log = await eventLog(client, session.id);
        expect(lastIdleReason(log)).toBe('retries_exhausted');
      }, { timeout: 60_000, interval: 250 });
      expect(stub.requests).toHaveLength(4);

      const log = await eventLog(client, session.id);
      const retryStatuses = log
        .filter((event) => event.type === 'session.error')
        .map((event) => (event.error as { retry_status?: { type?: string } } | undefined)?.retry_status?.type);
      expect(retryStatuses).toEqual(['retrying', 'retrying', 'retrying', 'exhausted']);
      expect(log.filter((event) => event.type === 'session.status_rescheduled')).toHaveLength(1);

      // The session is idle, not terminated: a new message runs another turn
      // (tool-call reply + text reply on the stub's default script).
      const retrieved = await client.beta.sessions.retrieve(session.id);
      expect(retrieved.status).toBe('idle');
      await client.beta.sessions.events.send(session.id, {
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'Try again.' }] }],
      });
      await vi.waitFor(async () => {
        const log2 = await eventLog(client, session.id);
        expect(lastIdleReason(log2)).toBe('end_turn');
      }, { timeout: 60_000, interval: 250 });
      expect(stub.requests).toHaveLength(6);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);
});
