import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { startRuntimeHarness, type RunningRuntime } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

const GATED_GLOB_TOOLS = [
  '  - type: agent_toolset_20260401',
  '    default_config:',
  '      enabled: false',
  '    configs:',
  '      - name: glob',
  '        enabled: true',
  '        permission_policy:',
  '          type: always_ask',
];

async function createSession(client: Anthropic) {
  const agents = await client.beta.agents.list();
  const environments = await client.beta.environments.list();
  const session = await client.beta.sessions.create({
    agent: agents.data[0]!.id,
    environment_id: environments.data[0]!.id,
  });
  expect(session.status).toBe('idle');
  return session;
}

describe('official SDK session status projection over HTTP', () => {
  it('reports approvals as idle with a requires_action stop reason and retains one-shot confirmation', async () => {
    const stub = await startStubModelServer();
    let runtime: RunningRuntime | undefined;
    try {
      runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl, agentTools: GATED_GLOB_TOOLS });
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });
      const session = await createSession(client);
      await client.beta.sessions.events.send(session.id, {
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'List the workspace files.' }] }],
      });

      await vi.waitFor(async () => {
        const page = await client.beta.sessions.events.list(session.id);
        const idle = page.data.filter((event) => event.type === 'session.status_idle').at(-1);
        expect(idle?.stop_reason.type).toBe('requires_action');
        expect((await client.beta.sessions.retrieve(session.id)).status).toBe('idle');
      }, { timeout: 30_000, interval: 50 });

      const parked = await client.beta.sessions.events.list(session.id);
      const call = parked.data.find((event) => event.type === 'agent.tool_use');
      const idle = parked.data.filter((event) => event.type === 'session.status_idle').at(-1);
      expect(call).toBeDefined();
      if (!call || !idle || idle.stop_reason.type !== 'requires_action') throw new Error('Approval was not parked');
      expect(idle.stop_reason.event_ids).toEqual([call.id]);
      expect(parked.data.filter((event) => event.type === 'agent.tool_result')).toHaveLength(0);
      expect(stub.requests).toHaveLength(1);

      const confirmation = { events: [{ type: 'user.tool_confirmation' as const, tool_use_id: call.id, result: 'allow' as const }] };
      await client.beta.sessions.events.send(session.id, confirmation);
      await vi.waitFor(async () => {
        const events = await client.beta.sessions.events.list(session.id);
        expect(events.data.filter((event) => event.type === 'session.status_idle').at(-1)?.stop_reason.type).toBe('end_turn');
        expect((await client.beta.sessions.retrieve(session.id)).status).toBe('idle');
      }, { timeout: 30_000, interval: 50 });

      const resolved = await client.beta.sessions.events.list(session.id);
      expect(resolved.data.filter((event) => event.type === 'agent.tool_result')).toHaveLength(1);
      expect(stub.requests).toHaveLength(2);
      await expect(client.beta.sessions.events.send(session.id, confirmation)).rejects.toBeInstanceOf(Anthropic.BadRequestError);
      expect((await client.beta.sessions.events.list(session.id)).data).toEqual(resolved.data);
      expect(stub.requests).toHaveLength(2);
    } finally {
      await runtime?.stop();
      await stub.close();
    }
  }, 300_000);

  it('reports a model failure as terminated and refuses new events without persisting or invoking the model', async () => {
    // A 400 is neither retryable nor one of the resumable model codes, so the
    // failure is the terminal kind rather than one the session reschedules or
    // pauses to continue from.
    const stub = await startStubModelServer({ failRequests: [1, 2, 3, 4, 5], failStatus: 400 });
    let runtime: RunningRuntime | undefined;
    try {
      runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });
      const session = await createSession(client);
      const message = { events: [{ type: 'user.message' as const, content: [{ type: 'text' as const, text: 'Hello.' }] }] };
      await client.beta.sessions.events.send(session.id, message);

      await vi.waitFor(async () => {
        expect((await client.beta.sessions.retrieve(session.id)).status).toBe('terminated');
        const events = await client.beta.sessions.events.list(session.id);
        expect(events.data.at(-1)?.type).toBe('session.status_terminated');
      }, { timeout: 30_000, interval: 50 });

      const before = await client.beta.sessions.events.list(session.id);
      const requestsBefore = stub.requests.length;
      expect(before.data.filter((event) => event.type === 'session.error')).toHaveLength(1);
      expect(before.data.filter((event) => event.type === 'session.status_running')).toHaveLength(1);
      await expect(client.beta.sessions.events.send(session.id, message)).rejects.toBeInstanceOf(Anthropic.ConflictError);
      await expect(client.post(`/v1/sessions/${session.id}/stop`, {
        headers: { 'anthropic-beta': 'managed-agents-2026-04-01' },
      })).rejects.toBeInstanceOf(Anthropic.ConflictError);
      expect((await client.beta.sessions.events.list(session.id)).data).toEqual(before.data);
      expect((await client.beta.sessions.retrieve(session.id)).status).toBe('terminated');
      expect(stub.requests).toHaveLength(requestsBefore);
    } finally {
      await runtime?.stop();
      await stub.close();
    }
  }, 300_000);
});
