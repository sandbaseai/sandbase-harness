/**
 * Unit tests for the Tavily search adapter.
 *
 * The adapter's contract is narrow: neutral request fields map onto Tavily's
 * `/search` body one-to-one, the key rides in the Authorization header and
 * never in a URL or error message, and every failure class returns a
 * structured `ok:false` instead of throwing — the tool surface decides how a
 * failure reads to the model.
 */

import { describe, expect, it } from 'vitest';
import { createTavilyProvider, TAVILY_DEFAULT_BASE_URL } from '@/core/web/search/tavily.js';
import type { WebSearchRequest } from '@/core/web/search/types.js';

const API_KEY = 'tvly-unit-test-key';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch seam that records the outgoing request for assertions. */
function recordingFetch(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return jsonResponse(payload, status);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const QUERY: WebSearchRequest = { query: 'sandbase harness' };

describe('createTavilyProvider', () => {
  it('posts the neutral request mapped onto Tavily body fields', async () => {
    const { calls, fetchImpl } = recordingFetch({ results: [] });
    const provider = createTavilyProvider({ apiKey: API_KEY, fetchImpl });

    expect(provider.id).toBe('tavily');
    expect(provider.endpointUrl).toBe(TAVILY_DEFAULT_BASE_URL);

    const outcome = await provider.search({
      query: 'managed agents',
      num_results: 7,
      recency: 'week',
      include_domains: ['example.com', 'docs.example.org'],
      exclude_domains: ['spam.example.net'],
      user_location: { country: 'de' },
    });

    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${TAVILY_DEFAULT_BASE_URL}/search`);
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      query: 'managed agents',
      max_results: 7,
      include_raw_content: false,
      include_answer: false,
      time_range: 'week',
      include_domains: ['example.com', 'docs.example.org'],
      exclude_domains: ['spam.example.net'],
      country: 'de',
    });
  });

  it('keeps the key out of the request URL and applies the default result cap', async () => {
    const { calls, fetchImpl } = recordingFetch({ results: [] });
    const provider = createTavilyProvider({ apiKey: API_KEY, fetchImpl });

    await provider.search(QUERY);

    expect(calls[0].url).not.toContain(API_KEY);
    expect(JSON.parse(String(calls[0].init.body)).max_results).toBe(5);
  });

  it('honors a base_url override, including a trailing slash', async () => {
    const { calls, fetchImpl } = recordingFetch({ results: [] });
    const provider = createTavilyProvider({ apiKey: API_KEY, baseUrl: 'http://127.0.0.1:8399/', fetchImpl });

    expect(provider.endpointUrl).toBe('http://127.0.0.1:8399');
    await provider.search(QUERY);
    expect(calls[0].url).toBe('http://127.0.0.1:8399/search');
  });

  it('normalizes result items and drops entries without a URL', async () => {
    const { fetchImpl } = recordingFetch({
      results: [
        { title: 'One', url: 'https://a.example/1', content: 'first snippet', score: 0.9 },
        { title: 'No URL', content: 'unreachable' },
        { url: 'https://b.example/2' },
      ],
    });
    const provider = createTavilyProvider({ apiKey: API_KEY, fetchImpl });

    const outcome = await provider.search(QUERY);

    expect(outcome).toEqual({
      ok: true,
      provider: 'tavily',
      results: [
        { title: 'One', url: 'https://a.example/1', content: 'first snippet' },
        { title: '', url: 'https://b.example/2', content: '' },
      ],
    });
  });

  it('refuses an invalid results envelope', async () => {
    const { fetchImpl } = recordingFetch({ answer: 'maybe', results: 'not-an-array' });
    const provider = createTavilyProvider({ apiKey: API_KEY, fetchImpl });

    expect(await provider.search(QUERY)).toMatchObject({ ok: false, code: 'web_search_provider_failed' });
  });

  it('maps HTTP 429 to the rate-limited code', async () => {
    const { fetchImpl } = recordingFetch({ detail: 'slow down' }, 429);
    const provider = createTavilyProvider({ apiKey: API_KEY, fetchImpl });

    expect(await provider.search(QUERY)).toEqual({
      ok: false,
      code: 'web_search_rate_limited',
      message: 'Tavily rate limit reached',
    });
  });

  it('maps other HTTP failures to provider_failed without leaking the key', async () => {
    const { fetchImpl } = recordingFetch({ detail: API_KEY }, 503);
    const provider = createTavilyProvider({ apiKey: API_KEY, fetchImpl });

    const outcome = await provider.search(QUERY);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('web_search_provider_failed');
      expect(outcome.message).toBe('Tavily returned HTTP 503');
      expect(outcome.message).not.toContain(API_KEY);
    }
  });

  it('maps a non-JSON body to provider_failed', async () => {
    const fetchImpl = (async () => new Response('gateway timeout page', { status: 200 })) as typeof fetch;
    const provider = createTavilyProvider({ apiKey: API_KEY, fetchImpl });

    const outcome = await provider.search(QUERY);
    expect(outcome).toEqual({
      ok: false,
      code: 'web_search_provider_failed',
      message: 'Tavily returned a non-JSON response',
    });
  });

  it('maps transport failures to provider_failed', async () => {
    const fetchImpl = (async () => { throw new Error('connect ECONNREFUSED'); }) as typeof fetch;
    const provider = createTavilyProvider({ apiKey: API_KEY, fetchImpl });

    const outcome = await provider.search(QUERY);
    expect(outcome).toEqual({
      ok: false,
      code: 'web_search_provider_failed',
      message: 'Tavily request or response failed',
    });
  });

  it('maps an abort to a timeout failure', async () => {
    const fetchImpl = ((url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })) as typeof fetch;
    const provider = createTavilyProvider({ apiKey: API_KEY, fetchImpl, timeoutMs: 10 });

    const outcome = await provider.search(QUERY);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('web_search_provider_failed');
      expect(outcome.message).toContain('timed out');
    }
  });
});
