import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('official SDK session delete', () => {
  it('permanently deletes through the published sessions resource', async () => {
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

      const deleted = await client.beta.sessions.delete(session.id);
      expect(deleted).toEqual({ id: session.id, type: 'session_deleted' });
      await expect(client.beta.sessions.retrieve(session.id)).rejects.toBeInstanceOf(Anthropic.NotFoundError);
      await expect(client.beta.sessions.events.list(session.id)).rejects.toBeInstanceOf(Anthropic.NotFoundError);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);
});
