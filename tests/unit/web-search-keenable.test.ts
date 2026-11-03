/**
 * Unit tests for the Keenable search adapter.
 *
 * The contract mirrors the Tavily adapter's: neutral request fields map onto
 * Keenable's body, the key (when configured) rides in a header and never in a
 * URL or error message, the keyless path uses the public endpoint with an app
 * identifier, and every failure class returns a structured `ok:false`.
 */

import { describe, expect, it } from 'vitest';
import { createKeenableProvider, KEENABLE_APP_TITLE, KEENABLE_DEFAULT_BASE_URL } from '@/core/web/search/keenable.js';

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
