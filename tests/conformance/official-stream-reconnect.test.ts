import Anthropic from '@anthropic-ai/sdk';
import { serve } from '@hono/node-server';
import { expect, it } from 'vitest';
import { disposeConformanceContexts, makeConformanceApp } from './support/app.js';

// Pinned source: official-docs/events-and-streaming.md, “Reconnect without
// missing events”. Session title updates exercise delivery without a provider.
it('reconnects through the official SDK with stream-first history and payload-ID deduplication', async () => {
  const ctx = makeConformanceApp();
  const server = serve({ fetch: ctx.app.fetch, hostname: '127.0.0.1', port: 0 });
  const controllers: AbortController[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      if (server.listening) resolve();
      else server.once('listening', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a listener');
    const historyRequests: URL[] = [];
    const official = new Anthropic({
      baseURL: `http://127.0.0.1:${address.port}`,
      apiKey: 'test-key', authToken: null, maxRetries: 0, timeout: 5_000,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.endsWith('/events') && (!init?.method || init.method === 'GET')) {
          historyRequests.push(url);
        }
        return fetch(input, init);
      },
    });
    const agent = await official.beta.agents.create({ name: 'reconnect', model: 'claude-opus-5-5' });
    const session = await official.beta.sessions.create({ agent: agent.id, environment_id: 'env_default' });
    const rows = () => ctx.db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC')
      .all(session.id) as Array<{ id: string }>;
    const update = (title: string) => official.beta.sessions.update(session.id, { title });
    await update('before the first stream');

    const reconnect = async (round: string) => {
      const before = rows();
      const controller = new AbortController();
      controllers.push(controller);
      // An idle stream must open before the first write or the 15s keepalive.
      const openingDeadline = setTimeout(() => controller.abort(), 5_000);
      const stream = await official.beta.sessions.events.stream(session.id, {}, { signal: controller.signal })
        .finally(() => clearTimeout(openingDeadline));
      try {
        await update(`${round}: before history`);
        const historyIds: string[] = [];
        const seen = new Set<string>();
        const requestStart = historyRequests.length;
        for await (const event of official.beta.sessions.events.list(session.id, { limit: 1 })) {
          historyIds.push(event.id);
          seen.add(event.id);
          // Append after the first page has been read, while subsequent pages
          // and the already-open stream can both observe the same event.
          if (historyIds.length === 1) await update(`${round}: during pagination`);
        }
        expect(historyRequests.length - requestStart).toBeGreaterThan(1);
        expect(historyRequests.slice(requestStart + 1).every((url) => url.searchParams.has('page'))).toBe(true);
        expect(historyIds).toEqual(rows().map((event) => event.id));

        await update(`${round}: live one`);
        await update(`${round}: live two`);
        const stored = rows();
        const lastId = stored.at(-1)!.id;
        const rawIds: string[] = [];
        const newIds: string[] = [];
        const tailDeadline = setTimeout(() => controller.abort(), 5_000);
        try {
          for await (const event of stream) {
            if (event.type === 'event_start' || event.type === 'event_delta') continue;
            rawIds.push(event.id);
            if (!seen.has(event.id)) {
              seen.add(event.id);
              newIds.push(event.id);
            }
            if (event.id === lastId) break;
          }
        } finally {
          clearTimeout(tailDeadline);
        }
        // The stream is live-only, overlaps history, and preserves the opaque
        // payload IDs (regardless of the numeric SSE frame IDs).
        expect(rawIds).toEqual(stored.slice(before.length).map((event) => event.id));
        expect(rawIds.filter((id) => historyIds.includes(id))).toHaveLength(2);
        expect(newIds).toEqual(stored.slice(-2).map((event) => event.id));
        expect([...historyIds, ...newIds]).toEqual(stored.map((event) => event.id));
        expect(new Set([...historyIds, ...newIds]).size).toBe(stored.length);
        expect(rows()).toEqual(stored);
        expect(stored.slice(0, before.length)).toEqual(before);
        return stored;
      } finally {
        stream.controller.abort();
      }
    };

    const first = await reconnect('first');
    await update('written while disconnected');
    const disconnected = rows();
    expect(disconnected).toHaveLength(first.length + 1);
    const second = await reconnect('second');
    expect(second.slice(0, disconnected.length)).toEqual(disconnected);
  } finally {
    for (const controller of controllers) controller.abort();
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    disposeConformanceContexts([ctx]);
  }
});
