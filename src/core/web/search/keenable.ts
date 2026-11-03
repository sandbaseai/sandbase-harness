/**
 * Keenable adapter for the provider-neutral search contract.
 *
 * Keenable serves the same search on two endpoints: `POST /v1/search` with an
 * `X-API-Key` header, and the keyless `POST /v1/search/public` (rate limited
 * per IP, no credits) that only needs an `X-Keenable-Title` app identifier.
 * The adapter takes the keyed path when a key is configured and the public
 * path otherwise, so the provider is usable with no credential at all. The key
 * rides in a header, never in a URL or error message.
 *
 * Request mapping: `num_results` → `max_results`; `recency` → a
 * `published_after` date; a single `include_domains` host → `site`. Keenable
 * has no multi-host include, exclude, or country parameter, so those stay
 * client-side (`filterByDomainPolicy` already enforces the agent's domain
 * policy on every result URL). A `429` becomes `web_search_rate_limited`,
 * every other transport or HTTP failure `web_search_provider_failed`, so the
 * tool never throws.
 */

import type { SearchProvider, WebSearchOutcome, WebSearchRecency, WebSearchRequest, WebSearchResultItem } from './types.js';

export const KEENABLE_DEFAULT_BASE_URL = 'https://api.keenable.ai';
export const KEENABLE_TIMEOUT_MS = 30_000;
export const KEENABLE_MAX_RESPONSE_BYTES = 1_000_000;
export const KEENABLE_APP_TITLE = 'SandBase Harness';

const RECENCY_DAYS: Record<WebSearchRecency, number> = { day: 1, week: 7, month: 31, year: 366 };

export interface KeenableProviderOptions {
  /** Optional: without one the adapter uses the keyless public endpoint. */
  apiKey?: string;
  /** Defaults to the vendor endpoint; overridable for a relay or tests. */
  baseUrl?: string;
  /** Injectable fetch seam for tests; the override changes nothing else. */
  fetchImpl?: typeof fetch;
  /** Injectable timeout for tests; production callers get the default. */
  timeoutMs?: number;
  /** Injectable clock for the recency mapping in tests. */
  now?: () => Date;
}

export function createKeenableProvider(options: KeenableProviderOptions = {}): SearchProvider {
  const baseUrl = (options.baseUrl ?? KEENABLE_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? KEENABLE_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const apiKey = options.apiKey?.trim() || undefined;
  const searchUrl = apiKey ? `${baseUrl}/v1/search` : `${baseUrl}/v1/search/public`;

  return {
    id: 'keenable',
    endpointUrl: baseUrl,
    async search(request: WebSearchRequest): Promise<WebSearchOutcome> {
      const body: Record<string, unknown> = {
        query: request.query,
        max_results: request.num_results ?? 5,
      };
      if (request.recency) {
        const since = new Date(now().getTime() - RECENCY_DAYS[request.recency] * 86_400_000);
        body.published_after = since.toISOString().slice(0, 10);
      }
      if (request.include_domains?.length === 1) body.site = request.include_domains[0];

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'user-agent': 'sandbase-harness-websearch/1.0',
      };
      if (apiKey) headers['x-api-key'] = apiKey;
      else headers['x-keenable-title'] = KEENABLE_APP_TITLE;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(searchUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        return {
          ok: false,
          code: 'web_search_provider_failed',
          message: error instanceof Error && error.name === 'AbortError'
            ? `Keenable request timed out after ${timeoutMs}ms`
            : `Keenable request failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 429) {
        return {
          ok: false,
          code: 'web_search_rate_limited',
          message: apiKey ? 'Keenable rate limit reached' : 'Keenable keyless rate limit reached; configure an api_key for a higher limit',
        };
      }
      if (!response.ok) {
        return { ok: false, code: 'web_search_provider_failed', message: `Keenable returned HTTP ${response.status}` };
      }

      let text: string;
      try {
        text = await boundedText(response, KEENABLE_MAX_RESPONSE_BYTES);
      } catch (error) {
        return { ok: false, code: 'web_search_provider_failed', message: error instanceof Error ? error.message : String(error) };
      }
      let payload: { results?: unknown };
      try {
        payload = JSON.parse(text);
      } catch {
        return { ok: false, code: 'web_search_provider_failed', message: 'Keenable returned a non-JSON response' };
      }
      const results = Array.isArray(payload.results)
        ? payload.results.flatMap((item): WebSearchResultItem[] => {
          if (!item || typeof item !== 'object') return [];
          const record = item as Record<string, unknown>;
          if (typeof record.url !== 'string' || !record.url) return [];
          const snippet = typeof record.snippet === 'string' && record.snippet
            ? record.snippet
            : typeof record.description === 'string' ? record.description : '';
          return [{
            title: typeof record.title === 'string' ? record.title : '',
            url: record.url,
            content: snippet,
          }];
        })
        : [];
      return { ok: true, provider: 'keenable', results };
    },
  };
}

/** Read a response body with a byte cap; fetch has no built-in limit. */
async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`Keenable response exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}
