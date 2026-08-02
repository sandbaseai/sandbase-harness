import type { Database } from '@/core/db/database.js';
import { relative, resolve, sep } from 'node:path';
import { resolveEnvVars } from '@/core/config/env-resolver.js';
import { defaultSettingsAvailability, runtimeSettingsSchema, validateRuntimeSettings, validateRuntimeSettingsCredentials, type RuntimeSettings } from './schema.js';
import { MINIMAX_PROVIDER, miniMaxModelId, miniMaxOpenAiBaseUrl } from '@/core/model/minimax.js';
import { sandboxSettingForProvider } from '@/sandbox/provider-names.js';
import type { ModelConfig } from '@/types/model.js';
import {
  cleanupUnreferencedRuntimeSettingsSecrets,
  hasRuntimeSettingsSecret,
  persistRuntimeSettingsSecrets,
  resolveRuntimeSettingsModelApiKey,
} from './secrets.js';
export {
  hasRuntimeSettingsSecret,
  maskRuntimeSettings,
  runtimeSettingsSecretStates,
  type RuntimeSettingsSecretStates,
} from './secrets.js';
export type { RuntimeSettings } from './schema.js';

export type RuntimeSettingsRecord = {
  schema_version: 1;
  revision: number;
  effective_revision: number;
  saved_config: RuntimeSettings;
  effective_config: RuntimeSettings;
  restart_required: boolean;
  activation_status: 'active' | 'pending' | 'failed';
  activation_errors: Array<{ path: string; code: string; message: string }>;
};

export type SaveRuntimeSettingsResult =
  | { ok: true; record: RuntimeSettingsRecord }
  | { ok: false; reason: 'revision_conflict'; record: RuntimeSettingsRecord };

export type RuntimeSettingsSeed = {
  memoryEnabled?: boolean;
  storage?: RuntimeSettings['storage'];
  memory?: RuntimeSettings['memory'];
};

type SettingsRow = {
  schema_version: number;
  config: string;
  effective_config: string;
  revision: number;
  effective_revision: number;
  restart_required: number;
  activation_status?: string;
  activation_errors?: string;
};

export function getOrSeedRuntimeSettings(db: Database, seed: RuntimeSettingsSeed = {}, dataDir?: string): RuntimeSettingsRecord {
  const existing = readSettingsRow(db);
  if (existing) return rowToRecord(existing);

  const legacyConfig = legacySettingsSeed(db, seed);
  const config = persistRuntimeSettingsSecrets(db, legacyConfig, legacyConfig, dataDir);
  // Settings V2 is now the secret authority. Do not preserve literal secrets
  // in the compatibility models table after importing an existing workspace.
  if (legacyConfig.model.api_key && !/^\$\{[^}]+\}$/.test(legacyConfig.model.api_key)) {
    db.prepare('UPDATE models SET api_key = NULL WHERE api_key IS NOT NULL').run();
  }
  const serialized = JSON.stringify(config);
  db.prepare(`
    INSERT INTO runtime_settings (
      id, schema_version, config, effective_config, revision, effective_revision, restart_required, activation_status, activation_errors
    ) VALUES ('default', 1, ?, ?, 1, 1, 0, 'active', '[]')
  `).run(serialized, serialized);
  return rowToRecord(readSettingsRow(db)!);
}

/** Apply the last validated saved revision during process startup. */
export function activateRuntimeSettings(
  db: Database,
  seed: RuntimeSettingsSeed = {},
  dataDir?: string,
  sandboxProviders: string[] = ['local'],
): RuntimeSettingsRecord {
  return db.transaction(() => {
    const current = getOrSeedRuntimeSettings(db, seed, dataDir);
    const activationErrors = validateSavedConfigForActivation(db, current.saved_config, sandboxProviders);
    if (activationErrors.length > 0) {
      db.prepare(`
        UPDATE runtime_settings
        SET restart_required = 1,
            activation_status = 'failed',
            activation_errors = ?,
            updated_at = datetime('now')
        WHERE id = 'default'
      `).run(JSON.stringify(activationErrors));
      return getOrSeedRuntimeSettings(db, seed, dataDir);
    }
    if (!current.restart_required) {
      if (current.activation_status !== 'active') {
        db.prepare(`
          UPDATE runtime_settings
          SET activation_status = 'active',
              activation_errors = '[]',
              updated_at = datetime('now')
          WHERE id = 'default'
        `).run();
        return getOrSeedRuntimeSettings(db, seed, dataDir);
      }
      return current;
    }
    db.prepare(`
      UPDATE runtime_settings
      SET effective_config = config,
          effective_revision = revision,
          restart_required = 0,
          activation_status = 'active',
          activation_errors = '[]',
          updated_at = datetime('now')
      WHERE id = 'default'
    `).run();
    const activated = getOrSeedRuntimeSettings(db, seed, dataDir);
    cleanupUnreferencedRuntimeSettingsSecrets(db, activated.saved_config, activated.effective_config);
    return activated;
  });
}

export function saveRuntimeSettings(
  db: Database,
  config: RuntimeSettings,
  expectedRevision: number,
  dataDir?: string,
): SaveRuntimeSettingsResult {
  return db.transaction(() => {
    const current = getOrSeedRuntimeSettings(db, {}, dataDir);
    if (current.revision !== expectedRevision) {
      return { ok: false, reason: 'revision_conflict', record: current } as const;
    }
    const persisted = persistRuntimeSettingsSecrets(db, current.saved_config, config, dataDir, current.effective_config);
    const nextRevision = current.revision + 1;
    const result = db.prepare(`
      UPDATE runtime_settings
      SET config = ?,
          revision = ?,
          restart_required = 1,
          activation_status = 'pending',
          activation_errors = '[]',
          updated_at = datetime('now')
      WHERE id = 'default' AND revision = ?
    `).run(JSON.stringify(persisted), nextRevision, expectedRevision);
    if (Number(result.changes) !== 1) {
      return { ok: false, reason: 'revision_conflict', record: getOrSeedRuntimeSettings(db, {}, dataDir) } as const;
    }
    return { ok: true, record: getOrSeedRuntimeSettings(db, {}, dataDir) } as const;
  });
}

/**
 * Builds the one runtime model configuration from the effective Settings V2
 * document. Model IDs remain adapter implementation details rather than a
 * Dashboard setting; the resolved ID can be surfaced as diagnostics only.
 */
export function modelConfigFromRuntimeSettings(
  db: Database,
  config: RuntimeSettings,
  dataDir?: string,
): ModelConfig {
  const miniMax = config.model.vendor === MINIMAX_PROVIDER;
  return {
    name: 'default',
    provider: config.model.vendor,
    ...(miniMax ? { model: miniMaxModelId(config.model.options.model) } : {}),
    base_url: miniMax ? miniMaxOpenAiBaseUrl(config.model.options, config.model.base_url) : config.model.base_url,
    api_key: resolveRuntimeSettingsModelApiKey(db, config.model.api_key, dataDir),
    is_default: true,
  };
}

/** Resolve the active local artifact directory without permitting data-dir escapes. */
export function localArtifactStorageDir(dataDir: string, config: RuntimeSettings): string {
  if (config.storage.artifacts.provider !== 'local') {
    throw new Error(`Artifact provider "${config.storage.artifacts.provider}" is not available`);
  }
  const configured = config.storage.artifacts.options.base_path;
  const basePath = typeof configured === 'string' && configured.trim() ? configured.trim() : 'files';
  const root = resolve(dataDir);
  const target = resolve(root, basePath);
  const relativePath = relative(root, target);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || relativePath.includes(`${sep}..${sep}`)) {
    throw new Error('Artifact base_path must be a non-empty path inside the runtime data directory');
  }
  return target;
}

function readSettingsRow(db: Database): SettingsRow | undefined {
  return db.prepare(`
    SELECT schema_version, config, effective_config, revision, effective_revision, restart_required,
           activation_status, activation_errors
    FROM runtime_settings WHERE id = 'default'
  `).get() as SettingsRow | undefined;
}

function rowToRecord(row: SettingsRow): RuntimeSettingsRecord {
  const savedResult = parseRuntimeSettingsResult(row.config);
  const effectiveResult = parseRuntimeSettingsResult(row.effective_config);
  const saved = savedResult.config;
  const effective = effectiveResult.config;
  const persistedActivationErrors = parseActivationErrors(row.activation_errors);
  if (!saved && !effective) {
    throw new Error('Runtime settings contain no valid saved or effective configuration.');
  }
  const effectiveConfig = effective ?? saved!;
  const savedConfig = saved ?? effectiveConfig;
  const pending = row.restart_required === 1 || row.revision !== row.effective_revision;
  const failed = !saved || row.activation_status === 'failed';
  return {
    schema_version: 1,
    revision: row.revision,
    effective_revision: row.effective_revision,
    saved_config: savedConfig,
    effective_config: effectiveConfig,
    restart_required: !saved || pending,
    activation_status: failed ? 'failed' : pending ? 'pending' : 'active',
    activation_errors: !saved ? savedResult.errors : row.activation_status === 'failed' ? persistedActivationErrors : [],
  };
}

function parseActivationErrors(value: string | undefined): Array<{ path: string; code: string; message: string }> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is { path: string; code: string; message: string } => (
      item
      && typeof item === 'object'
      && typeof item.path === 'string'
      && typeof item.code === 'string'
      && typeof item.message === 'string'
    ));
  } catch {
    return [];
  }
}

function parseRuntimeSettingsResult(value: string): {
  config?: RuntimeSettings;
  errors: Array<{ path: string; code: string; message: string }>;
} {
  try {
    const parsed = JSON.parse(value);
    const result = runtimeSettingsSchema.safeParse(parsed);
    if (result.success) return { config: result.data, errors: [] };
    return { errors: result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code, message: issue.message })) };
  } catch (error) {
    return { errors: [{ path: '', code: 'invalid_json', message: error instanceof Error ? error.message : 'Settings JSON is invalid' }] };
  }
}

function validateSavedConfigForActivation(db: Database, config: RuntimeSettings, sandboxProviders: string[]): Array<{ path: string; code: string; message: string }> {
  const availability = defaultSettingsAvailability();
  // Sandbox availability can depend on runtime-discovered providers. The other
  // shipped Settings V2 areas are static in schema version 1.
  availability.sandboxProviders = new Set(sandboxProviders
    .map(sandboxSettingForProvider)
    .filter((value): value is RuntimeSettings['sandbox']['provider'] => Boolean(value)));
  const result = validateRuntimeSettings(config, availability);
  return [
    ...result.errors,
    ...validateRuntimeSettingsCredentials(config, (path) => hasRuntimeSettingsSecret(db, path)),
  ];
}

function parseRuntimeSettings(value: string): RuntimeSettings | undefined {
  try {
    const parsed = JSON.parse(value);
    const result = runtimeSettingsSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function legacySettingsSeed(db: Database, seed: RuntimeSettingsSeed): RuntimeSettings {
  const model = db.prepare(`
    SELECT provider, base_url, api_key
    FROM models
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1
  `).get() as { provider: string; base_url: string | null; api_key: string | null } | undefined;
  const environment = db.prepare(`
    SELECT config FROM environments
    WHERE archived_at IS NULL
    ORDER BY CASE WHEN id = 'env_default' THEN 0 ELSE 1 END, created_at ASC
    LIMIT 1
  `).get() as { config: string } | undefined;
  const envConfig = parseObject(environment?.config);
  const vendor = normalizeVendor(model?.provider);
  const baseUrl = resolvedOptionalUrl(model?.base_url ?? undefined);
  // Seeding from pre-Settings-V2 workspace data: an absent or unrecognized
  // legacy value means "was never configured", so local is the right seed here.
  // This is the one place a default is correct — runtime resolution must still
  // fail loud rather than substitute a backend (see sandbox/registry).
  const sandbox = typeof envConfig.sandbox_provider === 'string'
    ? sandboxSettingForProvider(envConfig.sandbox_provider) ?? 'local'
    : 'local';
  const memoryEnabled = seed.memory?.enabled ?? seed.memoryEnabled === true;

  return {
    schema_version: 1,
    model: {
      vendor,
      ...(baseUrl ? { base_url: baseUrl } : {}),
      ...(model?.api_key ? { api_key: model.api_key } : {}),
      options: {},
    },
    loop_engine: { provider: 'builtin', options: { default_max_steps: 25 } },
    storage: seed.storage ?? {
      metadata: { provider: 'sqlite', options: {} },
      artifacts: { provider: 'local', options: { base_path: 'files' } },
    },
    memory: seed.memory ?? { enabled: memoryEnabled, provider: 'sqlite', options: {} },
    sandbox: {
      provider: sandbox,
      options: { timeout_seconds: numberValue(envConfig.timeout) ?? 300 },
    },
  };
}

function resolvedOptionalUrl(value?: string): string | undefined {
  if (!value) return undefined;
  const resolvedValue = resolveEnvVars(value, false).trim();
  if (!resolvedValue || /\$\{[^}]+\}/.test(resolvedValue)) return undefined;
  return resolvedValue;
}

function normalizeVendor(provider?: string): RuntimeSettings['model']['vendor'] {
  if (provider === 'anthropic') return 'anthropic';
  if (provider === MINIMAX_PROVIDER) return MINIMAX_PROVIDER;
  if (!provider || provider === 'openai') return 'openai';
  return 'openai_compatible';
}

function parseObject(value?: string): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
