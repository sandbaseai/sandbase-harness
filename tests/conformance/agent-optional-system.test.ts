import Anthropic from '@anthropic-ai/sdk';
import { serve } from '@hono/node-server';
import { describe, expect, it } from 'vitest';
import { disposeConformanceContexts, makeConformanceApp } from './support/app.js';

describe('official SDK optional agent system prompt', () => {
  it('normalizes create inputs and preserves or clears the prompt on update', async () => {
    const context = makeConformanceApp();
    const server = serve({ fetch: context.app.fetch, hostname: '127.0.0.1', port: 0 });
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        if (server.listening) return resolveListen();
        server.once('listening', resolveListen);
        server.once('error', rejectListen);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected an HTTP listener');
      const client = new Anthropic({
        baseURL: `http://127.0.0.1:${address.port}`,
        apiKey: 'conformance-stub-key',
        authToken: null,
        maxRetries: 0,
        timeout: 10_000,
      });
      for (const input of [{}, { system: null }, { system: '' }]) {
        const agent = await client.beta.agents.create({ name: 'optional-system', model: 'claude-opus-5', ...input });
        expect(agent.system).toBe('');
        expect((await client.beta.agents.retrieve(agent.id)).system).toBe('');
        const prompted = await client.beta.agents.update(agent.id, { system: 'Retain this prompt.' });
        expect(prompted.system).toBe('Retain this prompt.');
        const renamed = await client.beta.agents.update(agent.id, { name: 'renamed-agent' });
        expect(renamed.system).toBe('Retain this prompt.');
        for (const system of [null, '']) {
          await client.beta.agents.update(agent.id, { system: 'Clear this prompt.' });
          const cleared = await client.beta.agents.update(agent.id, { system });
          expect(cleared.system).toBe('');
          expect((await client.beta.agents.retrieve(agent.id)).system).toBe('');
        }
        await expect(client.beta.agents.update(agent.id, { system: 42 as never }))
          .rejects.toMatchObject({ status: 400 });
      }
      await expect(client.beta.agents.create({ name: 'invalid-system', model: 'claude-opus-5', system: 42 as never }))
        .rejects.toMatchObject({ status: 400 });
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
      disposeConformanceContexts([context]);
    }
  });
});
