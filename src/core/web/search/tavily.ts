/**
 * Tavily adapter for the provider-neutral search contract.
 *
 * One POST to `{baseUrl}/search`; the key rides in the `Authorization` header
 * — Tavily accepts it there, and a header keeps the key out of URLs and any
 * request-body logging. Response items map `content` → the snippet field; a
 * `429` becomes `web_search_rate_limited`, every other transport or HTTP
 * failure `web_search_provider_failed`, so the tool never throws.
 */

import type { SearchProvider, WebSearchOutcome, WebSearchRequest, WebSearchResultItem } from './types.js';

export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com';
export const TAVILY_TIMEOUT_MS = 30_000;
export const TAVILY_MAX_RESPONSE_BYTES = 1_000_000;

export interface TavilyProviderOptions {
  apiKey: string;
  /** Defaults to the vendor endpoint; overridable for a relay or tests. */
  baseUrl?: string;
  /** Injectable fetch seam for tests; the override changes nothing else. */
  fetchImpl?: typeof fetch;
  /** Injectable timeout for tests; production callers get the default. */
  timeoutMs?: number;
}

export function createTavilyProvider(options: TavilyProviderOptions): SearchProvider {
  const baseUrl = (options.baseUrl ?? TAVILY_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? TAVILY_TIMEOUT_MS;

  return {
    id: 'tavily',
    endpointUrl: baseUrl,
    async search(request: WebSearchRequest): Promise<WebSearchOutcome> {
      const body: Record<string, unknown> = {
        query: request.query,
        max_results: request.num_results ?? 5,
        // Snippets only: raw page content is what web_fetch is for, and
        // answer-generation credits are spend the operator did not ask for.
        include_raw_content: false,
        include_answer: false,
      };
      if (request.recency) body.time_range = request.recency;
      if (request.include_domains?.length) body.include_domains = request.include_domains;
      if (request.exclude_domains?.length) body.exclude_domains = request.exclude_domains;
      if (request.user_location?.country) body.country = request.user_location.country;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response | undefined;
      try {
        response = await fetchImpl(`${baseUrl}/search`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
            'user-agent': 'sandbase-harness-websearch/1.0',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (response.status === 429) {
          return { ok: false, code: 'web_search_rate_limited', message: 'Tavily rate limit reached' };
        }
        if (!response.ok) {
          return { ok: false, code: 'web_search_provider_failed', message: `Tavily returned HTTP ${response.status}` };
        }

        const text = await boundedText(response, TAVILY_MAX_RESPONSE_BYTES, controller.signal);
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          return { ok: false, code: 'web_search_provider_failed', message: 'Tavily returned a non-JSON response' };
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
          || !Array.isArray((payload as { results?: unknown }).results)) {
          return { ok: false, code: 'web_search_provider_failed', message: 'Tavily returned an invalid results response' };
        }
        const results = (payload as { results: unknown[] }).results.flatMap((item): WebSearchResultItem[] => {
          if (!item || typeof item !== 'object') return [];
          const record = item as Record<string, unknown>;
          return typeof record.url === 'string' && record.url
            ? [{
              title: typeof record.title === 'string' ? record.title : '',
              url: record.url,
              content: typeof record.content === 'string' ? record.content : '',
            }]
            : [];
        });
        return { ok: true, provider: 'tavily', results };
      } catch (error) {
        return {
          ok: false,
          code: 'web_search_provider_failed',
          message: controller.signal.aborted
            ? `Tavily request timed out after ${timeoutMs}ms`
            : error instanceof ResponseTooLargeError
              ? `Tavily response exceeds the ${TAVILY_MAX_RESPONSE_BYTES}-byte limit`
              : 'Tavily request or response failed',
        };
      } finally {
        clearTimeout(timer);
        controller.abort();
        // Error statuses return without reading the body. Release that stream
        // without awaiting a potentially stalled underlying cancellation.
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      }
    },
  };
}

class ResponseTooLargeError extends Error {}

/** Bound body consumption by both bytes and the full request deadline. */
async function boundedText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let complete = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        complete = true;
        break;
      }
      received += value.byteLength;
      if (received > maxBytes) throw new ResponseTooLargeError();
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}
