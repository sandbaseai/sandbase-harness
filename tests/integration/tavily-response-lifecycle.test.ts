import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTavilyProvider, TAVILY_MAX_RESPONSE_BYTES } from '@/core/web/search/tavily.js';

const KEY = 'tvly-lifecycle-test-key';
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function listen(handler: (response: ServerResponse) => void) {
  const server = createServer((_req, response) => handler(response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('adapter deadline missed')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

describe('Tavily response lifecycle with real HTTP', () => {
  it('times out and closes a body stalled after headers', async () => {
    let closed = false;
    const baseUrl = await listen((response) => {
      response.on('close', () => { closed = true; });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"results":[');
    });
    const outcome = await bounded(createTavilyProvider({ apiKey: KEY, baseUrl, timeoutMs: 100 }).search({ query: 'q' }));
    expect(outcome).toMatchObject({ ok: false, code: 'web_search_provider_failed', message: expect.stringContaining('timed out') });
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it.each([429, 503])('closes an unread HTTP %s body without waiting for its end', async (status) => {
    let closed = false;
    const baseUrl = await listen((response) => {
      response.on('close', () => { closed = true; });
      response.writeHead(status);
      response.write('{');
    });
    const outcome = await bounded(createTavilyProvider({ apiKey: KEY, baseUrl }).search({ query: 'q' }));
    expect(outcome).toMatchObject({ ok: false, code: status === 429 ? 'web_search_rate_limited' : 'web_search_provider_failed' });
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it('cancels an oversized unfinished body', async () => {
    let closed = false;
    const baseUrl = await listen((response) => {
      response.on('close', () => { closed = true; });
      response.writeHead(200);
      response.write('x'.repeat(TAVILY_MAX_RESPONSE_BYTES + 1));
    });
    expect(await bounded(createTavilyProvider({ apiKey: KEY, baseUrl }).search({ query: 'q' })))
      .toMatchObject({ ok: false, code: 'web_search_provider_failed', message: expect.stringContaining('byte limit') });
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it.each([null, [], 'wrong', 123, {}, { results: null }, { results: {} }].map((payload) => ({ payload })))('rejects invalid envelope $payload', async ({ payload }) => {
    const baseUrl = await listen((response) => response.end(JSON.stringify(payload)));
    await expect(createTavilyProvider({ apiKey: KEY, baseUrl }).search({ query: 'q' }))
      .resolves.toMatchObject({ ok: false, code: 'web_search_provider_failed' });
  });

  it('keeps empty results successful and releases the completed response', async () => {
    const baseUrl = await listen((response) => response.end('{"results":[]}'));
    await expect(createTavilyProvider({ apiKey: KEY, baseUrl }).search({ query: 'q' }))
      .resolves.toEqual({ ok: true, provider: 'tavily', results: [] });
  });

  it.each(['transport', 'body'])('does not expose arbitrary %s errors', async (stage) => {
    const fetchImpl = (async () => {
      if (stage === 'transport') throw new Error(`private upstream ${KEY}`);
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error(`private upstream ${KEY}`)); } }));
    }) as typeof fetch;
    const outcome = await createTavilyProvider({ apiKey: KEY, fetchImpl }).search({ query: 'q' });
    expect(outcome).toEqual({ ok: false, code: 'web_search_provider_failed', message: 'Tavily request or response failed' });
  });

  it('cancels a pending injected body read even when it ignores the fetch signal', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const outcome = await bounded(createTavilyProvider({ apiKey: KEY, timeoutMs: 20, fetchImpl: (async () => response) as typeof fetch }).search({ query: 'q' }));
    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining('timed out') });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
});
