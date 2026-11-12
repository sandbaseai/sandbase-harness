/**
 * Build the session-facing search provider from the effective settings.
 *
 * Returns `undefined` when the subsystem is absent or its key cannot resolve —
 * the same value the capability registry reads, so admission and execution can
 * never disagree about whether `web_search` exists. A key that resolved at
 * activation but went missing later fails safe to "unavailable" rather than
 * executing with an empty credential.
 */
import type { Database } from '@/core/db/database.js';
import { resolveEnvVars } from '@/core/config/env-resolver.js';
import { resolveRuntimeSettingsSecret } from '@/core/settings/secrets.js';
import type { RuntimeSettings } from '@/core/settings/schema.js';
import { createKeenableProvider } from './keenable.js';
import { createOutcrawlProvider } from './outcrawl.js';
import { createTavilyProvider } from './tavily.js';
import type { SearchProvider } from './types.js';

export type { SearchProvider, WebSearchOutcome, WebSearchRecency, WebSearchRequest, WebSearchResultItem } from './types.js';
export { createKeenableProvider, KEENABLE_DEFAULT_BASE_URL } from './keenable.js';
export { createOutcrawlProvider, OUTCRAWL_DEFAULT_BASE_URL } from './outcrawl.js';
export { createTavilyProvider, TAVILY_DEFAULT_BASE_URL } from './tavily.js';

export interface SearchProviderDeps {
  db?: Database;
  dataDir?: string;
  fetchImpl?: typeof fetch;
}

export function searchProviderFromSettings(
  webSearch: RuntimeSettings['web_search'],
  deps: SearchProviderDeps = {},
): SearchProvider | undefined {
  if (!webSearch) return undefined;
  const resolveOption = (path: string): string | undefined => {
    const raw = webSearch.options[path.slice('web_search.options.'.length)];
    if (typeof raw !== 'string' || !raw.trim()) return undefined;
    const stored = deps.db ? resolveRuntimeSettingsSecret(deps.db, path, raw, deps.dataDir) : raw;
    if (typeof stored !== 'string' || !stored.trim()) return undefined;
    const resolved = resolveEnvVars(stored, false);
    return /\$\{[^}]+\}/.test(resolved) ? undefined : resolved;
  };
  const apiKey = resolveOption('web_search.options.api_key');
  const baseUrl = resolveOption('web_search.options.base_url');

  switch (webSearch.provider) {
    case 'tavily':
      // Tavily is key-only: without one there is no usable adapter, and an
      // unkeyed provider that fails on every call would report "configured"
      // while executing nothing.
      return apiKey ? createTavilyProvider({ apiKey, baseUrl, fetchImpl: deps.fetchImpl }) : undefined;
    case 'keenable':
      // Keenable has a keyless public endpoint, so an absent key is a usable
      // configuration. A key that is spelled but does not resolve still fails
      // safe to "unavailable" rather than silently downgrading to keyless.
      if (!apiKey?.trim() && hasOption(webSearch, 'api_key')) return undefined;
      if (!baseUrl?.trim() && hasOption(webSearch, 'base_url')) return undefined;
      return createKeenableProvider({ apiKey, baseUrl, fetchImpl: deps.fetchImpl });
    case 'outcrawl':
      // Outcrawl is key-only, like Tavily: without a usable key there is no
      // adapter to report as configured.
      return apiKey ? createOutcrawlProvider({ apiKey, baseUrl, fetchImpl: deps.fetchImpl }) : undefined;
    // The remaining ids pass schema validation but ship no adapter yet;
    // the availability check already refuses saving them.
    default:
      return undefined;
  }
}

/** Whether an option is spelled at all (a non-empty string), resolvable or not. */
function hasOption(webSearch: NonNullable<RuntimeSettings['web_search']>, key: string): boolean {
  const raw = webSearch.options[key];
  return typeof raw === 'string' && raw.trim().length > 0;
}
