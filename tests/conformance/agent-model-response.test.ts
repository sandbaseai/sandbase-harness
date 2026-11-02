import Anthropic from '@anthropic-ai/sdk';
import { serve } from '@hono/node-server';
import { expect, it } from 'vitest';
import { ManagedAgentsClient } from '@/sdk/client.js';
import { disposeConformanceContexts, makeConformanceApp } from './support/app.js';

it('projects model objects through both SDKs, versions, frozen snapshots and update events', async () => {
  const ctx = makeConformanceApp();
  const server = serve({ fetch: ctx.app.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      if (server.listening) resolve();
      else server.once('listening', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a listener');
    const baseURL = `http://127.0.0.1:${address.port}`;
    const official = new Anthropic({ baseURL, apiKey: 'test-key', authToken: null, maxRetries: 0 });
    const local = new ManagedAgentsClient({ baseUrl: baseURL });
    const bare = await official.beta.agents.create({ name: 'bare', model: 'claude-opus-5-5' });
    expect(bare.model).toEqual({ id: 'claude-opus-5-5', speed: 'standard' });
    expect((await local.agents.update(bare.id, {})).version).toBe(1);
    const model = { id: 'claude-opus-5-5', effort: { type: 'high' as const }, speed: 'fast' as const };
    const agent = await official.beta.agents.create({ name: 'profile', model });
    expect(agent.model).toEqual(model);
    const read = await local.agents.get(agent.id);
    expect((await local.agents.update(agent.id, { model: read.model })).model).toEqual(model);
    const session = await local.sessions.create({ agent: { id: agent.id, version: 1 } });
    expect(session.agent.model).toEqual(model);
    expect((await local.agents.update(agent.id, { description: 'Retain profile' })).model).toEqual(model);
    for (const version of (await local.agents.versions(agent.id)).data) expect(version.model).toEqual(model);
    expect((await local.agents.list()).data.find((item) => item.id === agent.id)?.model).toEqual(model);
    await official.beta.agents.update(agent.id, { model: { id: 'claude-opus-5-5', effort: 'low' } });
    expect((await local.sessions.get(session.id)).agent.model).toEqual(model);
    const update = await ctx.app.request(`/v1/sessions/${session.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: { tools: [{ type: 'agent_toolset_20260401' }] } }),
    });
    expect(update.status).toBe(200);
    const events = await (await ctx.app.request(`/v1/sessions/${session.id}/events`)).json() as any;
    expect(events.data.find((event: any) => event.type === 'session.updated').agent.model).toEqual(model);
    expect((await local.agents.archive(agent.id)).model).toEqual({ ...model, speed: 'standard', effort: { type: 'low' } });
    const stored = ctx.db.prepare('SELECT agent_definition FROM sessions WHERE id = ?').get(session.id) as { agent_definition: string };
    expect(JSON.parse(stored.agent_definition).model).toBe(model.id);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    disposeConformanceContexts([ctx]);
  }
});
