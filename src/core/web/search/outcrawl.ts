/**
 * Outcrawl adapter for the provider-neutral search contract.
 *
 * One POST to `{baseUrl}/v1/search`; the key rides in the `Authorization`
 * header, never in a URL or an error message. `num_results` maps to `limit`.
 * Outcrawl's search has no domain, recency or country parameters in this
 * mapping, so the tool enforces the agent's domain policy on every result URL
 * and the other preferences are ignored. Response `hits` map `snippet` → the
 * content field; a `429` becomes `web_search_rate_limited`, every other
 * transport or HTTP failure `web_search_provider_failed`, so the tool never
 * throws.
 */

import type { SearchProvider, WebSearchOutcome, WebSearchRequest, WebSearchResultItem } from './types.js';

export const OUTCRAWL_DEFAULT_BASE_URL = 'https://api.outcrawl.ai';
export const OUTCRAWL_TIMEOUT_MS = 30_000;
export const OUTCRAWL_MAX_RESPONSE_BYTES = 1_000_000;

export interface OutcrawlProviderOptions {
  apiKey: string;
  /** Defaults to the vendor endpoint; overridable for a relay or tests. */
  baseUrl?: string;
  /** Injectable fetch seam for tests; the override changes nothing else. */
  fetchImpl?: typeof fetch;
  /** Injectable timeout for tests; production callers get the default. */
  timeoutMs?: number;
}

export function createOutcrawlProvider(options: OutcrawlProviderOptions): SearchProvider {
  const baseUrl = (options.baseUrl ?? OUTCRAWL_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? OUTCRAWL_TIMEOUT_MS;

  return {
    id: 'outcrawl',
    endpointUrl: baseUrl,
    async search(request: WebSearchRequest): Promise<WebSearchOutcome> {
      const limit = request.num_results ?? 5;
      const body = { query: request.query, limit };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response | undefined;
      try {
        response = await fetchImpl(`${baseUrl}/v1/search`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
            'user-agent': 'sandbase-harness-websearch/1.0',
          },
          body: JSON.stringify(body),
          // The tool admits this endpoint against the Environment policy.
          // Redirects could escape that admission and forward the key.
          redirect: 'error',
          signal: controller.signal,
        });
        if (response.status === 429) {
          return { ok: false, code: 'web_search_rate_limited', message: 'Outcrawl rate limit reached' };
        }
        if (!response.ok) {
          return { ok: false, code: 'web_search_provider_failed', message: `Outcrawl returned HTTP ${response.status}` };
        }

        const text = await boundedText(response, OUTCRAWL_MAX_RESPONSE_BYTES, controller.signal);
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          return { ok: false, code: 'web_search_provider_failed', message: 'Outcrawl returned a non-JSON response' };
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
          || !Array.isArray((payload as { hits?: unknown }).hits)) {
          return { ok: false, code: 'web_search_provider_failed', message: 'Outcrawl returned an invalid results response' };
        }
        // A configured vendor secret is not necessarily in the session's
        // vault redactor. Never return it even if a relay echoes it.
        const scrub = (value: string) => options.apiKey ? value.replaceAll(options.apiKey, '[REDACTED]') : value;
        const results = (payload as { hits: unknown[] }).hits.flatMap((item): WebSearchResultItem[] => {
          if (!item || typeof item !== 'object') return [];
          const record = item as Record<string, unknown>;
          if (typeof record.url !== 'string' || !validResultUrl(record.url)) return [];
          return [{
            title: scrub(typeof record.title === 'string' ? record.title : ''),
            url: scrub(record.url),
            content: scrub(typeof record.snippet === 'string' ? record.snippet : ''),
          }];
        }).slice(0, limit);
        return { ok: true, provider: 'outcrawl', results };
      } catch (error) {
        return {
          ok: false,
          code: 'web_search_provider_failed',
          message: controller.signal.aborted
            ? `Outcrawl request timed out after ${timeoutMs}ms`
            : error instanceof ResponseTooLargeError
              ? `Outcrawl response exceeds the ${OUTCRAWL_MAX_RESPONSE_BYTES}-byte limit`
              : 'Outcrawl request or response failed',
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

function validResultUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
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
