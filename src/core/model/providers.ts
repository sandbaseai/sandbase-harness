import type { Database } from '@/core/db/database.js';
import { resolveEnvVars } from '@/core/config/env-resolver.js';
import type { ModelConfig, RuntimeModelInfo } from '@/types/model.js';
import { nanoid } from 'nanoid';

export type ModelProviderRecord = ModelConfig & {
  created_at: string;
  updated_at: string;
  is_default: boolean;
};

export type ModelProviderInput = {
  name?: unknown;
  provider?: unknown;
  model?: unknown;
  base_url?: unknown;
  api_key?: unknown;
  is_default?: unknown;
};

export function listModelProviders(db: Database): ModelProviderRecord[] {
  const rows = db.prepare(`
    SELECT name, provider, model, base_url, api_key, is_default, created_at, COALESCE(updated_at, created_at) AS updated_at
    FROM models
    ORDER BY is_default DESC, created_at DESC, name ASC
  `).all() as Array<{
    name: string;
    provider: string;
    model: string | null;
    base_url: string | null;
    api_key: string | null;
    is_default: number;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    name: row.name,
    provider: row.provider,
    model: row.model ?? undefined,
    base_url: row.base_url ?? undefined,
    api_key: row.api_key ?? undefined,
    is_default: row.is_default === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

function createModelProvider(db: Database, input: ModelProviderInput): ModelProviderRecord {
  const record = normalizeInput(input);
  const count = db.prepare('SELECT COUNT(*) AS count FROM models').get() as { count: number };
  const makeDefault = Boolean(record.is_default) || count.count === 0;
  const now = new Date().toISOString();

  return db.transaction(() => {
    if (makeDefault) {
      db.prepare('UPDATE models SET is_default = 0, updated_at = ?').run(now);
    }
    db.prepare(`
      INSERT INTO models (name, provider, model, base_url, api_key, config, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.name,
      record.provider,
      record.model ?? null,
      record.base_url ?? null,
      record.api_key ?? null,
      '{}',
      makeDefault ? 1 : 0,
      now,
      now,
    );
    return getModelProvider(db, record.name) as ModelProviderRecord;
  });
}

export function seedModelProviders(db: Database, configs: ModelConfig[]): ModelProviderRecord[] {
  if (configs.length === 0 || listModelProviders(db).length > 0) return listModelProviders(db);
  for (const [index, config] of configs.entries()) {
    createModelProvider(db, {
      name: config.name,
      provider: config.provider,
      model: config.model,
      base_url: config.base_url,
      api_key: config.api_key,
      is_default: index === 0,
    });
  }
  return listModelProviders(db);
}

export function toRuntimeModelInfo(record: ModelProviderRecord): RuntimeModelInfo {
  return {
    name: record.name,
    provider: record.provider,
    ...(record.model ? { model: record.model } : {}),
    base_url: publicBaseUrl(record.base_url),
    api_key_state: configState(record.api_key),
    base_url_state: configState(record.base_url),
    is_default: record.is_default,
  };
}

function getModelProvider(db: Database, name: string): ModelProviderRecord | undefined {
  return listModelProviders(db).find((model) => model.name === name);
}

function normalizeInput(input: ModelProviderInput): ModelConfig {
  const provider = cleanString(input.provider) || 'openai';
  const model = cleanString(input.model);

  const name = cleanString(input.name) || `${provider}-${nanoid(8)}`;
  if (name.length > 80) {
    throw new Error('name must be 80 characters or fewer');
  }

  return {
    name,
    provider,
    model,
    base_url: cleanString(input.base_url),
    api_key: cleanString(input.api_key),
    is_default: Boolean(input.is_default),
  };
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const ENV_PLACEHOLDER = /\$\{[^}]+\}/;

function configState(value?: string): RuntimeModelInfo['api_key_state'] {
  if (!value) return 'not_set';
  const resolved = resolveEnvVars(value, false);
  // A variable that is unset leaves its `${VAR}` behind; one that is set to the
  // empty string resolves to nothing. Both are a credential a client cannot use,
  // and `secretState` (`src/core/settings/secrets.ts`) already reports both as
  // `missing_env` — reporting `configured` here would have the Console tell the
  // operator a key is in place while the model client refuses to build one.
  if (ENV_PLACEHOLDER.test(resolved) || (ENV_PLACEHOLDER.test(value) && resolved === '')) {
    return 'missing_env';
  }
  return 'configured';
}

function publicBaseUrl(value?: string): string | undefined {
  if (!value) return undefined;
  const resolved = resolveEnvVars(value, false);
  if (ENV_PLACEHOLDER.test(resolved) || (ENV_PLACEHOLDER.test(value) && resolved === '')) return undefined;
  return resolved;
}
