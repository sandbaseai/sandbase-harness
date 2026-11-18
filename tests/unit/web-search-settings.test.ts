/**
 * Unit tests for the `web_search` settings subsystem.
 *
 * The coverage is the settings contract, not the vendor: schema acceptance and
 * refusal, the api_key secret lifecycle (stored pointer, env reference,
 * masking), adapter availability, and the one place that turns settings into a
 * provider — `searchProviderFromSettings` — including its fail-safe returns.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { describeSettingsAdapters, availabilityFromDescriptors } from '@/core/settings/adapters.js';
import {
  validateRuntimeSettings,
  validateRuntimeSettingsCredentials,
  type RuntimeSettings,
} from '@/core/settings/schema.js';
import {
  getOrSeedRuntimeSettings,
  maskRuntimeSettings,
  saveRuntimeSettings,
} from '@/core/settings/store.js';
import { searchProviderFromSettings } from '@/core/web/search/index.js';
import { KEENABLE_DEFAULT_BASE_URL } from '@/core/web/search/keenable.js';
import { OUTCRAWL_DEFAULT_BASE_URL } from '@/core/web/search/outcrawl.js';
import { TAVILY_DEFAULT_BASE_URL } from '@/core/web/search/tavily.js';

describe('web_search settings', () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-websearch-'));
    db = new Database(join(tmpDir, 'settings.db'));
    db.runMigrations();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(): RuntimeSettings {
    return getOrSeedRuntimeSettings(db, {}, tmpDir).saved_config;
  }

  function withWebSearch(webSearch: NonNullable<RuntimeSettings['web_search']>): RuntimeSettings {
    return { ...seed(), web_search: webSearch };
  }

  it('parses a seeded document that carries no web_search section', () => {
    const settings = getOrSeedRuntimeSettings(db, {}, tmpDir);
    expect(settings.saved_config.web_search).toBeUndefined();
  });

  it('validates a configured Tavily provider and reports it available', () => {
    const adapters = describeSettingsAdapters(['local']);
    const availability = availabilityFromDescriptors(adapters);

    expect(availability.webSearchProviders).toEqual(new Set(['tavily', 'keenable', 'outcrawl']));
    const validation = validateRuntimeSettings(
      withWebSearch({ provider: 'tavily', options: { api_key: '${TAVILY_TEST_KEY}' } }),
      availability,
    );
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('lists the planned providers but refuses to validate them as available', () => {
    const adapters = describeSettingsAdapters(['local']);
    const ids = adapters.web_search.map((descriptor) => descriptor.id);
    expect(ids).toEqual(['tavily', 'keenable', 'outcrawl', 'brave', 'exa', 'searxng']);
    expect(adapters.web_search.filter((descriptor) => descriptor.status === 'available')
      .map((descriptor) => descriptor.id)).toEqual(['tavily', 'keenable', 'outcrawl']);

    const validation = validateRuntimeSettings(
      withWebSearch({ provider: 'brave', options: { api_key: 'key' } }),
      availabilityFromDescriptors(adapters),
    );
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'web_search.provider', code: 'adapter_unavailable' }),
    ]));
  });

  it('rejects non-string api_key and base_url values', () => {
    const validation = validateRuntimeSettings(
      withWebSearch({ provider: 'tavily', options: { api_key: 42, base_url: 443 } }),
      availabilityFromDescriptors(describeSettingsAdapters(['local'])),
    );
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'web_search.options.api_key', code: 'invalid_type' }),
      expect.objectContaining({ path: 'web_search.options.base_url', code: 'invalid_type' }),
    ]));
  });

  it('rejects a base_url that is not an http(s) URL', () => {
    const validation = validateRuntimeSettings(
      withWebSearch({ provider: 'tavily', options: { api_key: 'key', base_url: 'ftp://search.test' } }),
      availabilityFromDescriptors(describeSettingsAdapters(['local'])),
    );
    expect(validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'web_search.options.base_url' }),
    ]));
  });

  it('flags an api_key env reference that cannot resolve', () => {
    // Credential resolution is a separate sweep from shape validation, the
    // same split the settings Test route composes.
    const issues = validateRuntimeSettingsCredentials(
      withWebSearch({ provider: 'tavily', options: { api_key: '${TAVILY_DEFINITELY_UNSET}' } }),
      () => false,
    );
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'web_search.options.api_key', code: 'missing_env' }),
    ]));
  });

  it('stores a literal api_key as a managed secret and masks it in reads', () => {
    const current = getOrSeedRuntimeSettings(db, {}, tmpDir);
    const saved = saveRuntimeSettings(db, {
      ...current.saved_config,
      web_search: { provider: 'tavily', options: { api_key: 'tvly-plain-secret', base_url: 'https://relay.example.com' } },
    }, current.revision, tmpDir);
    expect(saved.ok).toBe(true);

    const stored = getOrSeedRuntimeSettings(db, {}, tmpDir);
    const raw = stored.saved_config.web_search?.options.api_key;
    expect(raw).toBe('__managed_secret__:web_search.options.api_key');
    expect(maskRuntimeSettings(stored.saved_config).web_search?.options.api_key).toBe('********');
    // The plaintext never lands in the settings row.
    expect(JSON.stringify(stored.saved_config)).not.toContain('tvly-plain-secret');
  });

  it('resolves a provider from stored secret and env spellings alike', () => {
    const current = getOrSeedRuntimeSettings(db, {}, tmpDir);
    const saved = saveRuntimeSettings(db, {
      ...current.saved_config,
      web_search: { provider: 'tavily', options: { api_key: 'tvly-plain-secret' } },
    }, current.revision, tmpDir);
    expect(saved.ok).toBe(true);
    const stored = getOrSeedRuntimeSettings(db, {}, tmpDir).saved_config;

    const fromSecret = searchProviderFromSettings(stored.web_search, { db, dataDir: tmpDir });
    expect(fromSecret?.id).toBe('tavily');
    expect(fromSecret?.endpointUrl).toBe(TAVILY_DEFAULT_BASE_URL);

    process.env.WEB_SEARCH_TEST_KEY = 'tvly-env-secret';
    try {
      const fromEnv = searchProviderFromSettings(
        withWebSearch({ provider: 'tavily', options: { api_key: '${WEB_SEARCH_TEST_KEY}', base_url: 'https://relay.example.com/' } }).web_search,
        { db, dataDir: tmpDir },
      );
      expect(fromEnv?.endpointUrl).toBe('https://relay.example.com');
    } finally {
      delete process.env.WEB_SEARCH_TEST_KEY;
    }
  });

  it('returns no provider for the absent, unkeyed, and unresolvable spellings', () => {
    expect(searchProviderFromSettings(undefined, { db })).toBeUndefined();
    expect(searchProviderFromSettings(
      { provider: 'tavily', options: {} },
      { db },
    )).toBeUndefined();
    // A managed-secret pointer with no stored row fails safe to unconfigured
    // rather than executing with an empty credential.
    expect(searchProviderFromSettings(
      { provider: 'tavily', options: { api_key: '__managed_secret__:web_search.options.api_key' } },
      { db, dataDir: tmpDir },
    )).toBeUndefined();
    // Provider ids without a shipped adapter resolve to nothing even if a
    // caller reached them past validation.
    expect(searchProviderFromSettings(
      { provider: 'brave', options: { api_key: 'key' } },
      { db },
    )).toBeUndefined();
  });

  it('validates and resolves a keyless Keenable provider', () => {
    const availability = availabilityFromDescriptors(describeSettingsAdapters(['local']));
    const settings = withWebSearch({ provider: 'keenable', options: {} });
    const validation = validateRuntimeSettings(settings, availability);
    expect(validation.errors).toEqual([]);
    expect(validateRuntimeSettingsCredentials(settings, () => false)
      .filter((issue) => issue.path.startsWith('web_search'))).toEqual([]);

    const provider = searchProviderFromSettings(settings.web_search, { db });
    expect(provider?.id).toBe('keenable');
    expect(provider?.endpointUrl).toBe(KEENABLE_DEFAULT_BASE_URL);
  });

  it('fails a Keenable key that is spelled but unresolvable safe to no provider', () => {
    expect(searchProviderFromSettings(
      { provider: 'keenable', options: { api_key: '${KEENABLE_DEFINITELY_UNSET}' } },
      { db },
    )).toBeUndefined();
    expect(searchProviderFromSettings(
      { provider: 'keenable', options: { api_key: '__managed_secret__:web_search.options.api_key' } },
      { db, dataDir: tmpDir },
    )).toBeUndefined();
    process.env.KEENABLE_TEST_KEY = 'keen-env-secret';
    try {
      const keyed = searchProviderFromSettings(
        { provider: 'keenable', options: { api_key: '${KEENABLE_TEST_KEY}', base_url: 'https://relay.example.com/' } },
        { db },
      );
      expect(keyed?.id).toBe('keenable');
      expect(keyed?.endpointUrl).toBe('https://relay.example.com');
    } finally {
      delete process.env.KEENABLE_TEST_KEY;
    }
  });

  it('validates and resolves an Outcrawl provider from an env key and returns none without one', () => {
    const availability = availabilityFromDescriptors(describeSettingsAdapters(['local']));
    expect(validateRuntimeSettings(
      withWebSearch({ provider: 'outcrawl', options: { api_key: '${OUTCRAWL_TEST_KEY}' } }),
      availability,
    ).errors).toEqual([]);

    expect(searchProviderFromSettings({ provider: 'outcrawl', options: {} }, { db })).toBeUndefined();
    expect(searchProviderFromSettings(
      { provider: 'outcrawl', options: { api_key: '${OUTCRAWL_DEFINITELY_UNSET}' } },
      { db },
    )).toBeUndefined();
    expect(searchProviderFromSettings(
      { provider: 'outcrawl', options: { api_key: '__managed_secret__:web_search.options.api_key' } },
      { db, dataDir: tmpDir },
    )).toBeUndefined();

    process.env.OUTCRAWL_TEST_KEY = 'oc-env-secret';
    try {
      const fromEnv = searchProviderFromSettings(
        { provider: 'outcrawl', options: { api_key: '${OUTCRAWL_TEST_KEY}' } },
        { db },
      );
      expect(fromEnv?.id).toBe('outcrawl');
      expect(fromEnv?.endpointUrl).toBe(OUTCRAWL_DEFAULT_BASE_URL);
      const relayed = searchProviderFromSettings(
        { provider: 'outcrawl', options: { api_key: '${OUTCRAWL_TEST_KEY}', base_url: 'https://relay.example.com/' } },
        { db },
      );
      expect(relayed?.endpointUrl).toBe('https://relay.example.com');
    } finally {
      delete process.env.OUTCRAWL_TEST_KEY;
    }
  });
  it('does not downgrade a blank resolved key or unresolved relay to keyless vendor search', () => {
    process.env.KEENABLE_BLANK_KEY = '   ';
    try {
      expect(searchProviderFromSettings(
        { provider: 'keenable', options: { api_key: '${KEENABLE_BLANK_KEY}' } }, { db },
      )).toBeUndefined();
      expect(searchProviderFromSettings(
        { provider: 'keenable', options: { base_url: '${KEENABLE_MISSING_RELAY}' } }, { db },
      )).toBeUndefined();
    } finally {
      delete process.env.KEENABLE_BLANK_KEY;
    }
  });

});
