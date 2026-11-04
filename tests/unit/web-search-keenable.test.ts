/**
 * Unit tests for the Keenable search adapter.
 *
 * The contract mirrors the Tavily adapter's: neutral request fields map onto
 * Keenable's body, the key (when configured) rides in a header and never in a
 * URL or error message, the keyless path uses the public endpoint with an app
 * identifier, and every failure class returns a structured `ok:false`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createWebSearchTool } from '@/core/web/web-search-tool.js';
import { normalizeEnvironmentNetwork } from '@/core/config/environment-network.js';
import { toolErrorText } from '@/core/tool-result-error.js';
import { createKeenableProvider, KEENABLE_APP_TITLE, KEENABLE_DEFAULT_BASE_URL, KEENABLE_MAX_RESPONSE_BYTES } from '@/core/web/search/keenable.js';

const API_KEY = 'keen-unit-test-key';
const NOW = () => new Date('2026-11-03T12:00:00Z');

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordingFetch(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return jsonResponse(payload, status);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('createKeenableProvider', () => {
  it('uses the keyless public endpoint with an app identifier when no key is set', async () => {
    const { calls, fetchImpl } = recordingFetch({ results: [] });
    const provider = createKeenableProvider({ fetchImpl });

    expect(provider.id).toBe('keenable');
    expect(provider.endpointUrl).toBe(KEENABLE_DEFAULT_BASE_URL);
    const outcome = await provider.search({ query: 'managed agents' });

    expect(outcome).toEqual({ ok: true, provider: 'keenable', results: [] });
    expect(calls[0].url).toBe(`${KEENABLE_DEFAULT_BASE_URL}/v1/search/public`);
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-keenable-title']).toBe(KEENABLE_APP_TITLE);
    expect(headers['x-api-key']).toBeUndefined();
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: 'managed agents', max_results: 5 });
  });

  it('uses the keyed endpoint and maps the neutral request fields', async () => {
    const { calls, fetchImpl } = recordingFetch({ results: [] });
    const provider = createKeenableProvider({ apiKey: API_KEY, baseUrl: 'https://relay.example.com/', fetchImpl, now: NOW });

    await provider.search({
      query: 'managed agents',
      num_results: 7,
      recency: 'week',
      include_domains: ['example.com'],
      exclude_domains: ['spam.example.net'],
      user_location: { country: 'de' },
    });

    expect(provider.endpointUrl).toBe('https://relay.example.com');
    expect(calls[0].url).toBe('https://relay.example.com/v1/search');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(headers['x-keenable-title']).toBeUndefined();
    expect(calls[0].url).not.toContain(API_KEY);
    // Exclusions and country have no Keenable parameter; the tool applies the
    // domain policy client-side.
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      query: 'managed agents',
      max_results: 7,
      published_after: '2026-10-27',
      site: 'example.com',
    });
  });

  it('leaves a multi-host include list to client-side filtering', async () => {
    const { calls, fetchImpl } = recordingFetch({ results: [] });
    await createKeenableProvider({ fetchImpl }).search({ query: 'q', include_domains: ['a.example', 'b.example'] });
    expect(JSON.parse(String(calls[0].init.body)).site).toBeUndefined();
  });

  it('normalizes results and drops items without a URL', async () => {
    const { fetchImpl } = recordingFetch({
      results: [
        { title: 'A', url: 'https://a.example/', snippet: 'snippet a', description: 'desc a' },
        { title: 'B', url: 'https://b.example/', description: 'desc b' },
        { title: 'no url' },
        'junk',
      ],
    });
    const outcome = await createKeenableProvider({ fetchImpl }).search({ query: 'q' });
    expect(outcome).toEqual({
      ok: true,
      provider: 'keenable',
      results: [
        { title: 'A', url: 'https://a.example/', content: 'snippet a' },
        { title: 'B', url: 'https://b.example/', content: 'desc b' },
      ],
    });
  });

  it('returns coded failures instead of throwing', async () => {
    const limited = await createKeenableProvider({ fetchImpl: recordingFetch({}, 429).fetchImpl }).search({ query: 'q' });
    expect(limited).toMatchObject({ ok: false, code: 'web_search_rate_limited' });

    const failed = await createKeenableProvider({ apiKey: API_KEY, fetchImpl: recordingFetch({}, 500).fetchImpl }).search({ query: 'q' });
    expect(failed).toMatchObject({ ok: false, code: 'web_search_provider_failed' });
    expect(JSON.stringify(failed)).not.toContain(API_KEY);

    const nonJson = await createKeenableProvider({
      fetchImpl: (async () => new Response('<html>', { status: 200 })) as typeof fetch,
    }).search({ query: 'q' });
    expect(nonJson).toMatchObject({ ok: false, code: 'web_search_provider_failed' });

    const transport = await createKeenableProvider({
      fetchImpl: (async () => { throw new Error('ECONNRESET'); }) as typeof fetch,
    }).search({ query: 'q' });
    expect(transport).toMatchObject({ ok: false, code: 'web_search_provider_failed' });
  });

  it('times out a hung request', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })) as unknown as typeof fetch;
    const outcome = await createKeenableProvider({ fetchImpl, timeoutMs: 10 }).search({ query: 'q' });
    expect(outcome).toMatchObject({ ok: false, code: 'web_search_provider_failed' });
    expect((outcome as { message: string }).message).toContain('timed out');
  });
});


describe('Keenable network and response boundaries', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it.each([undefined, API_KEY])('refuses redirected egress with key %s', async (apiKey) => {
    const targetRequests: string[] = [];
    const target = await listen((req, res) => {
      targetRequests.push(String(req.headers['x-api-key'] ?? 'keyless'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results: [] }));
    });
    const source = await listen((_req, res) => res.writeHead(307, { location: `${target}/capture` }).end());
    const provider = createKeenableProvider({ apiKey, baseUrl: source });
    const tool = createWebSearchTool({
      provider,
      environmentPolicy: normalizeEnvironmentNetwork({ type: 'limited', allowed_hosts: [new URL(source).host] }),
    });
    const result = await tool.execute({ query: 'public test query' });
    expect(toolErrorText(result)).toContain('web_search_provider_failed');
    expect(targetRequests).toEqual([]);
  });

  it('bounds body consumption after response headers arrive', async () => {
    let closed = false;
    const baseUrl = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"results":[');
      req.on('close', () => { closed = true; });
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        createKeenableProvider({ baseUrl, timeoutMs: 40 }).search({ query: 'q' }),
        new Promise((resolve) => { deadline = setTimeout(() => resolve('deadline missed'), 500); }),
      ]);
      expect(outcome).toMatchObject({ ok: false, code: 'web_search_provider_failed', message: expect.stringContaining('timed out') });
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 500 });
    } finally {
      clearTimeout(deadline);
    }
  });

  it.each([null, [], 'wrong', 123, {}, { results: null }, { results: {} }].map((payload) => ({ payload })))('codes malformed response envelopes: $payload', async ({ payload }) => {
    const baseUrl = await listen((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    });
    await expect(createKeenableProvider({ baseUrl }).search({ query: 'q' }))
      .resolves.toMatchObject({ ok: false, code: 'web_search_provider_failed' });
  });

  it('cancels an oversized response and reports the byte cap', async () => {
    let closed = false;
    const baseUrl = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('x'.repeat(KEENABLE_MAX_RESPONSE_BYTES + 1));
      req.on('close', () => { closed = true; });
    });
    const outcome = await createKeenableProvider({ baseUrl }).search({ query: 'q' });
    expect(outcome).toMatchObject({ ok: false, code: 'web_search_provider_failed', message: expect.stringContaining('byte limit') });
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 500 });
  });

  it.each([429, 500])('cancels unread HTTP %s response bodies', async (status) => {
    let closed = false;
    const baseUrl = await listen((req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.write('{');
      req.on('close', () => { closed = true; });
    });
    expect(await createKeenableProvider({ baseUrl }).search({ query: 'q' })).toMatchObject({ ok: false });
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 500 });
  });

  it('drops unsafe result URLs, caps results and scrubs echoed keys', async () => {
    const { fetchImpl } = recordingFetch({ results: [
      { url: 'javascript:alert(1)' },
      { url: 'file:///secret' },
      { url: 'https://user:password@example.com/' },
      { url: 'not a URL' },
      { url: 'https://example.com/a', title: API_KEY, snippet: API_KEY },
      { url: 'https://example.com/b' },
    ] });
    const outcome = await createKeenableProvider({ apiKey: API_KEY, fetchImpl }).search({ query: 'q', num_results: 1 });
    expect(outcome).toEqual({ ok: true, provider: 'keenable', results: [
      { url: 'https://example.com/a', title: '[REDACTED]', content: '[REDACTED]' },
    ] });
  });

  it('keeps agent domain and path filtering with the real adapter', async () => {
    const { calls, fetchImpl } = recordingFetch({ results: [
      { url: 'https://a.example/docs/one', snippet: 'allowed' },
      { url: 'https://a.example/blog/one', snippet: 'wrong path' },
      { url: 'https://b.example/docs/one', snippet: 'wrong host' },
    ] });
    const tool = createWebSearchTool({
      provider: createKeenableProvider({ fetchImpl }),
      policy: { mode: 'allowed', domains: ['a.example/docs'] },
    });
    const result = String(await tool.execute({ query: 'query unchanged' }));
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ query: 'query unchanged', site: 'a.example' });
    expect(result).toContain('https://a.example/docs/one');
    expect(result).not.toContain('wrong path');
    expect(result).not.toContain('wrong host');
  });

  it('does not echo arbitrary fetch failures or configured secrets', async () => {
    const outcome = await createKeenableProvider({
      apiKey: API_KEY,
      fetchImpl: (async () => { throw new Error(`upstream leaked ${API_KEY}`); }) as typeof fetch,
    }).search({ query: 'q' });
    expect(outcome).toMatchObject({ ok: false, code: 'web_search_provider_failed' });
    expect(JSON.stringify(outcome)).not.toContain(API_KEY);
    expect(JSON.stringify(outcome)).not.toContain('upstream leaked');
  });
});
