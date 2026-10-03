import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('official SDK session archive', () => {
  it('archives through the published sessions resource and rejects new events', async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });
      const agents = await client.beta.agents.list();
      const environments = await client.beta.environments.list();
      const session = await client.beta.sessions.create({
        agent: agents.data[0]!.id,
        environment_id: environments.data[0]!.id,
      });

      const archived = await client.beta.sessions.archive(session.id);
      expect(archived).toMatchObject({ id: session.id, type: 'session', status: 'terminated' });
      expect(archived.archived_at).toEqual(expect.any(String));

      const events = await client.beta.sessions.events.list(session.id);
      expect(events.data.at(-1)).toMatchObject({ type: 'session.status_terminated' });
      await expect(client.beta.sessions.events.send(session.id, {
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'after archive' }] }],
      })).rejects.toBeInstanceOf(Anthropic.ConflictError);

      await expect(client.beta.sessions.archive(session.id)).resolves.toMatchObject({
        id: session.id,
        archived_at: archived.archived_at,
      });
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);
});
