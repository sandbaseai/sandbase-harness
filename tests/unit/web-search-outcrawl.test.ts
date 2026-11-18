/**
 * Unit tests for the Outcrawl search adapter.
 *
 * The adapter's contract is narrow: the neutral request maps onto Outcrawl's
 * `/v1/search` body (`query`, `limit`), the key rides in the Authorization
 * header and never in a URL, a result or an error message, redirects are
 * refused, and every failure class returns a structured `ok:false` instead of
 * throwing.
 */

import { describe, expect, it } from 'vitest';
import { createOutcrawlProvider, OUTCRAWL_DEFAULT_BASE_URL } from '@/core/web/search/outcrawl.js';
import type { WebSearchRequest } from '@/core/web/search/types.js';

const API_KEY = 'oc-unit-test-key';

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

describe('createOutcrawlProvider', () => {
  it('posts the neutral request mapped onto the Outcrawl search body', async () => {
    const { calls, fetchImpl } = recordingFetch({ hits: [] });
    const provider = createOutcrawlProvider({ apiKey: API_KEY, fetchImpl });

    expect(provider.id).toBe('outcrawl');
    expect(provider.endpointUrl).toBe(OUTCRAWL_DEFAULT_BASE_URL);

    const outcome = await provider.search({
      query: 'managed agents',
      num_results: 7,
      recency: 'week',
      include_domains: ['example.com'],
      exclude_domains: ['spam.example.net'],
      user_location: { country: 'de' },
    });

    expect(outcome).toEqual({ ok: true, provider: 'outcrawl', results: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${OUTCRAWL_DEFAULT_BASE_URL}/v1/search`);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.redirect).toBe('error');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: 'managed agents', limit: 7 });
  });

  it('keeps the key out of the request URL and applies the default result cap', async () => {
    const { calls, fetchImpl } = recordingFetch({ hits: [] });
    const provider = createOutcrawlProvider({ apiKey: API_KEY, fetchImpl });

    await provider.search(QUERY);

    expect(calls[0].url).not.toContain(API_KEY);
    expect(JSON.parse(String(calls[0].init.body)).limit).toBe(5);
  });

  it('honors a base_url override, including a trailing slash', async () => {
    const { calls, fetchImpl } = recordingFetch({ hits: [] });
    const provider = createOutcrawlProvider({ apiKey: API_KEY, baseUrl: 'https://relay.example.com/', fetchImpl });

    expect(provider.endpointUrl).toBe('https://relay.example.com');
    await provider.search(QUERY);
    expect(calls[0].url).toBe('https://relay.example.com/v1/search');
  });

  it('normalizes hits and drops rows without a usable URL', async () => {
    const { fetchImpl } = recordingFetch({
      hits: [
        { url: 'https://a.example/1', title: 'One', snippet: 'first snippet', rank: 1 },
        { url: 'https://b.example/2', rank: 2 },
        { title: 'No URL', snippet: 'dropped' },
        { url: 'ftp://c.example/3', title: 'Wrong scheme' },
        { url: 'https://user:pass@d.example/4', title: 'Credentials in URL' },
        'not-an-object',
      ],
      usage: { credits: '3' },
      warnings: [{ code: 'engines_refused' }],
    });
    const provider = createOutcrawlProvider({ apiKey: API_KEY, fetchImpl });

    expect(await provider.search(QUERY)).toEqual({
      ok: true,
      provider: 'outcrawl',
      results: [
        { title: 'One', url: 'https://a.example/1', content: 'first snippet' },
        { title: '', url: 'https://b.example/2', content: '' },
      ],
    });
  });

  it('caps the results at the requested count', async () => {
    const hits = Array.from({ length: 4 }, (_, index) => ({ url: `https://a.example/${index}`, title: `T${index}` }));
    const { fetchImpl } = recordingFetch({ hits });
    const provider = createOutcrawlProvider({ apiKey: API_KEY, fetchImpl });

    const outcome = await provider.search({ query: 'q', num_results: 2 });
    expect(outcome.ok && outcome.results.map((result) => result.url)).toEqual(['https://a.example/0', 'https://a.example/1']);
  });

  it('scrubs a configured key echoed in a result', async () => {
    const { fetchImpl } = recordingFetch({
      hits: [{ url: `https://a.example/?k=${API_KEY}`, title: `t ${API_KEY}`, snippet: `s ${API_KEY}` }],
    });
    const provider = createOutcrawlProvider({ apiKey: API_KEY, fetchImpl });

    const outcome = await provider.search(QUERY);
    expect(JSON.stringify(outcome)).not.toContain(API_KEY);
    expect(outcome.ok && outcome.results[0].title).toBe('t [REDACTED]');
  });

  it('refuses an invalid results envelope', async () => {
    for (const payload of [{ hits: 'not-an-array' }, { results: [] }, [], null]) {
      const { fetchImpl } = recordingFetch(payload);
      const provider = createOutcrawlProvider({ apiKey: API_KEY, fetchImpl });

      expect(await provider.search(QUERY)).toEqual({
        ok: false,
        code: 'web_search_provider_failed',
        message: 'Outcrawl returned an invalid results response',
      });
    }
  });

  it('maps HTTP 429 to the rate-limited code', async () => {
    const { fetchImpl } = recordingFetch({ message: 'slow down' }, 429);
    const provider = createOutcrawlProvider({ apiKey: API_KEY, fetchImpl });

    expect(await provider.search(QUERY)).toEqual({
      ok: false,
      code: 'web_search_rate_limited',
      message: 'Outcrawl rate limit reached',
    });
  });

  it('maps other HTTP failures to provider_failed without leaking the key', async () => {
    const { fetchImpl } = recordingFetch({ message: API_KEY }, 401);
    const provider = createOutcrawlProvider({ apiKey: API_KEY, fetchImpl });

    const outcome = await provider.search(QUERY);
    expect(outcome).toEqual({
      ok: false,
      code: 'web_search_provider_failed',
      message: 'Outcrawl returned HTTP 401',
    });
  });

  it('maps a non-JSON body to provider_failed', async () => {
    const fetchImpl = (async () => new Response('gateway timeout page', { status: 200 })) as typeof fetch;
    const provider = createOutcrawlProvider({ apiKey: API_KEY, fetchImpl });

    expect(await provider.search(QUERY)).toEqual({
      ok: false,
      code: 'web_search_provider_failed',
      message: 'Outcrawl returned a non-JSON response',
    });
  });

  it('maps an oversized body to provider_failed', async () => {
    const fetchImpl = (async () => new Response('x'.repeat(1_000_001), { status: 200 })) as typeof fetch;
    const provider = createOutcrawlProvider({ apiKey: API_KEY, fetchImpl });

    expect(await provider.search(QUERY)).toEqual({
      ok: false,
      code: 'web_search_provider_failed',
      message: 'Outcrawl response exceeds the 1000000-byte limit',
    });
  });

  it('maps transport failures to provider_failed', async () => {
    const fetchImpl = (async () => { throw new Error(`connect ECONNREFUSED ${API_KEY}`); }) as typeof fetch;
    const provider = createOutcrawlProvider({ apiKey: API_KEY, fetchImpl });

    expect(await provider.search(QUERY)).toEqual({
      ok: false,
      code: 'web_search_provider_failed',
      message: 'Outcrawl request or response failed',
    });
  });

  it('maps an abort to a timeout failure', async () => {
    const fetchImpl = ((_url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })) as typeof fetch;
    const provider = createOutcrawlProvider({ apiKey: API_KEY, fetchImpl, timeoutMs: 10 });

    expect(await provider.search(QUERY)).toEqual({
      ok: false,
      code: 'web_search_provider_failed',
      message: 'Outcrawl request timed out after 10ms',
    });
  });
});
