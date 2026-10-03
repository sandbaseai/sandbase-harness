import Anthropic from '@anthropic-ai/sdk';
import type { BetaManagedAgentsSession } from '@anthropic-ai/sdk/resources/beta/sessions/sessions';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startRuntimeHarness, type RunningRuntime } from './support/runtime-server.js';
import { startStubModelServer, STUB_REPLY_TEXT } from './support/stub-model-server.js';

const betaHeaders = { 'anthropic-beta': 'managed-agents-2026-04-01' };

function stopSession(client: Anthropic, sessionId: string) {
  return client.post<BetaManagedAgentsSession>(`/v1/sessions/${sessionId}/stop`, { headers: betaHeaders });
}

describe('official SDK resumable session interruption over HTTP', () => {
  it.each(['stop', 'user.interrupt'] as const)('%s retains the sandbox and permits another turn', async (operation) => {
    const stub = await startStubModelServer({ holdRequests: [1] });
    let runtime: RunningRuntime | undefined;
    try {
      runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });
      const agents = await client.beta.agents.list();
      const environments = await client.beta.environments.list();
      const session = await client.beta.sessions.create({
        agent: agents.data[0]!.id,
        environment_id: environments.data[0]!.id,
      });
      await client.beta.sessions.events.send(session.id, {
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'Begin the first turn.' }] }],
      });
      await vi.waitFor(async () => {
        expect(stub.requests).toHaveLength(1);
        expect((await client.beta.sessions.retrieve(session.id)).status).toBe('running');
      }, { timeout: 30_000, interval: 50 });
      const sentinel = join(runtime.workspaceDir, '.managed-agents', 'sandbox', session.id, 'retained.txt');
      writeFileSync(sentinel, 'retained across interruption');

      if (operation === 'stop') {
        expect(await stopSession(client, session.id)).toMatchObject({
          id: session.id, type: 'session', status: 'idle', agent: { id: agents.data[0]!.id },
        });
      } else {
        await client.beta.sessions.events.send(session.id, { events: [{ type: 'user.interrupt' }] });
      }
      await vi.waitFor(async () => {
        expect((await client.beta.sessions.retrieve(session.id)).status).toBe('idle');
        const events = await client.beta.sessions.events.list(session.id);
        expect(events.data.filter((event) => event.type === 'session.status_idle').at(-1)?.stop_reason.type).toBe('end_turn');
      }, { timeout: 30_000, interval: 50 });
      const interrupted = await client.beta.sessions.events.list(session.id);
      expect(interrupted.data.some((event) => event.type === 'session.status_terminated' || event.type === 'session.error')).toBe(false);
      expect(readFileSync(sentinel, 'utf8')).toBe('retained across interruption');
      expect(stub.requests).toHaveLength(1);

      await client.beta.sessions.events.send(session.id, {
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'Continue the same session.' }] }],
      });
      await vi.waitFor(async () => {
        const events = await client.beta.sessions.events.list(session.id);
        expect(events.data.filter((event) => event.type === 'session.status_running')).toHaveLength(2);
        expect(events.data.some((event) => event.type === 'agent.message'
          && event.content.some((block) => block.type === 'text' && block.text === STUB_REPLY_TEXT))).toBe(true);
        expect((await client.beta.sessions.retrieve(session.id)).status).toBe('idle');
      }, { timeout: 30_000, interval: 50 });
      expect(readFileSync(sentinel, 'utf8')).toBe('retained across interruption');

      const before = await client.beta.sessions.events.list(session.id);
      const requestsBefore = stub.requests.length;
      expect((await stopSession(client, session.id)).status).toBe('idle');
      expect((await stopSession(client, session.id)).status).toBe('idle');
      expect((await client.beta.sessions.events.list(session.id)).data).toEqual(before.data);
      expect(stub.requests).toHaveLength(requestsBefore);
      await expect(stopSession(client, 'sess_missing')).rejects.toBeInstanceOf(Anthropic.NotFoundError);
    } finally {
      await runtime?.stop();
      await stub.close();
    }
  }, 300_000);
});
