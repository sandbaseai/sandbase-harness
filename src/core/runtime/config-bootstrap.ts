import { existsSync, readFileSync } from 'node:fs';
import { nanoid } from 'nanoid';
import { parse as parseYaml } from 'yaml';
import type { Database } from '@/core/db/database.js';
import { normalizeModelSource, type RuntimeSettings, type RuntimeSettingsSeed } from '@/core/settings/store.js';
import type { ModelConfig } from '@/types/model.js';

/** The `model` section config.yaml declared, reduced to what the seed applies. */
export type DeclaredConfigModel = {
  /** Raw provider/vendor key, as written. */
  provider: string;
  /** Base URL, unresolved, exactly as written. */
  base_url?: string;
  /** Whether a key was declared at all. The value itself is never reported. */
  api_key_declared: boolean;
};

export type RuntimeConfigBootstrap = {
  models: ModelConfig[];
  settingsSeed: RuntimeSettingsSeed;
  /**
   * What config.yaml's `model` section asked for.
   *
   * Returned so startup can report a config.yaml edit that will not take effect
   * instead of leaving the operator to discover it by watching an endpoint
   * answer with the old values.
   */
  declaredModel?: DeclaredConfigModel;
  /**
   * Keys in the `model` section that this bootstrap never applies, by name.
   * Two are read and dropped: a concrete `model` id (an Agent declares its own)
   * and the vendor-specific `options` bag, which the `models` table has no
   * column for.
   */
  ignoredModelKeys: string[];
};

export function ensureDefaultEnvironment(db: Database): void {
  const envCheck = db.prepare('SELECT id FROM environments WHERE id = ?').get('env_default');
  if (!envCheck) {
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{"sandbox_provider":"local","timeout":300}')`);
  }
}

export function loadRuntimeConfigBootstrap({
  db,
  configPath,
  target,
}: {
  db: Database;
  configPath: string;
  target: string;
}): RuntimeConfigBootstrap {
  if (!existsSync(configPath)) return { models: [], settingsSeed: {}, ignoredModelKeys: [] };

  const configContent = readFileSync(configPath, 'utf-8');
  const config = parseYaml(configContent) as any;
  const declared = mergeConfigModelSections(config, target);
  const models = readConfigModels(declared);
  const settingsSeed = readConfigSettingsSeed(config);

  seedConfigEnvironments(db, config);

  return {
    models,
    settingsSeed,
    ...(declared ? { declaredModel: declaredConfigModel(declared) } : {}),
    ignoredModelKeys: ignoredModelKeys(declared),
  };
}

/**
 * The `model` section for this target: the base section with the target's
 * `overrides.<target>.model` merged over it, exactly as the seed applies it.
 */
function mergeConfigModelSections(config: any, target: string): Record<string, any> | undefined {
  const baseModel = config.model && typeof config.model === 'object' ? config.model : undefined;
  const overrideModel = config.overrides?.[target]?.model && typeof config.overrides[target].model === 'object'
    ? config.overrides[target].model
    : undefined;
  if (!baseModel && !overrideModel) return undefined;
  return { ...baseModel, ...overrideModel };
}

function declaredConfigModel(model: Record<string, any>): DeclaredConfigModel {
  return {
    provider: String(model.provider ?? model.vendor ?? 'openai'),
    ...(typeof model.base_url === 'string' ? { base_url: model.base_url } : {}),
    api_key_declared: typeof model.api_key === 'string' && model.api_key.length > 0,
  };
}

/**
 * Keys the `model` section declares that the seed does not apply, so a startup
 * warning can name them.
 *
 * The seed takes connection settings only: provider, base URL, key. A concrete
 * `model` id belongs to an Agent, and the vendor-specific `options` bag has no
 * column in the `models` table the seed comes from. A value under either key was
 * written to the file, read, dropped, and never mentioned.
 */
function ignoredModelKeys(model: Record<string, any> | undefined): string[] {
  if (!model) return [];
  const ignored: string[] = [];
  if (typeof model.model === 'string' && model.model.trim()) ignored.push('model');
  if (model.options && typeof model.options === 'object' && Object.keys(model.options).length > 0) ignored.push('options');
  return ignored;
}

function readConfigModels(model: Record<string, any> | undefined): ModelConfig[] {
  if (!model) return [];
  if (!model.provider && !model.vendor && !model.base_url && !model.api_key) return [];
  return [{
    name: 'default',
    provider: model.provider ?? model.vendor ?? 'openai',
    base_url: model.base_url,
    api_key: model.api_key,
    is_default: true,
  } as ModelConfig];
}

/**
 * Model settings in config.yaml that the running workspace will not apply.
 *
 * Only the first start imports this file: it seeds the `models` table and, from
 * it, the saved Settings document. Every later start reads the saved document,
 * so an operator who edits `model.base_url` in config.yaml, restarts, and
 * watches `GET /v1/x/runtime` answer with the old endpoint gets no explanation
 * at all. Rather than making the file win on every start — which would silently
 * revert a Dashboard setting at the next restart — the runtime says which
 * source is in effect and what differed.
 *
 * Returns an empty list when the file and the effective settings agree, so a
 * workspace that never diverged stays quiet. Secret values are never included;
 * only whether a key was declared.
 */
export function configModelWarnings(
  bootstrap: RuntimeConfigBootstrap,
  effective: RuntimeSettings['model'],
): string[] {
  const warnings: string[] = [];
  const source = 'config.yaml only seeds a workspace on its first start. After that the saved Settings document (Settings > Setup) is the single effective model configuration';

  for (const key of bootstrap.ignoredModelKeys) {
    warnings.push(`config.yaml "model.${key}" is not applied: the workspace model section supplies the provider, base URL and API key, while a concrete model id belongs to an Agent and the vendor options bag has no column in the model record this file seeds.`);
  }

  const declared = bootstrap.declaredModel;
  if (declared) {
    // Both sides go through the same normalization the first-time import uses,
    // so the comparison cannot report a difference that is only a spelling one.
    const declaredSource = normalizeModelSource(declared.provider, declared.base_url);
    const inEffect = normalizeModelSource(effective.vendor, effective.base_url);
    const differences: string[] = [];
    if (declaredSource.vendor !== inEffect.vendor) {
      differences.push(`vendor is "${declaredSource.vendor}" in config.yaml but "${inEffect.vendor}" in effect`);
    }
    if (declaredSource.base_url !== inEffect.base_url) {
      differences.push(`base_url is ${describeUrl(declaredSource.base_url)} in config.yaml but ${describeUrl(inEffect.base_url)} in effect`);
    }
    if (declared.api_key_declared && !effective.api_key) {
      differences.push('config.yaml declares an api_key but none is in effect');
    }
    if (differences.length > 0) {
      warnings.push(`config.yaml model settings differ from the effective settings (${differences.join('; ')}). ${source}. Update it there, or start from a fresh workspace to re-import config.yaml.`);
    }
  }

  return warnings;
}

function describeUrl(value: string | undefined): string {
  return value ? `"${value}"` : 'unset';
}

function seedConfigEnvironments(db: Database, config: any): void {
  if (!config.environments || typeof config.environments !== 'object') return;
  for (const [name, envConfig] of Object.entries(config.environments as Record<string, any>)) {
    const envId = `env_${nanoid(18)}`;
    const existing = db.prepare('SELECT id FROM environments WHERE name = ?').get(name);
    if (!existing) {
      db.prepare('INSERT INTO environments (id, name, config) VALUES (?, ?, ?)').run(
        envId,
        name,
        JSON.stringify(envConfig),
      );
    }
  }
}

function readConfigSettingsSeed(config: any): RuntimeSettingsSeed {
  const seed: RuntimeSettingsSeed = {};
  const storage = readStorageSeed(config.storage);
  if (storage) seed.storage = storage;
  const memory = readMemorySeed(config.memory);
  if (memory) seed.memory = memory;
  return seed;
}

function readStorageSeed(value: unknown): RuntimeSettings['storage'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const config = value as Record<string, any>;
  const metadata = config.metadata && typeof config.metadata === 'object' ? config.metadata : {};
  const artifacts = config.artifacts && typeof config.artifacts === 'object' ? config.artifacts : {};
  const metadataProvider = metadata.provider === 'postgres' || metadata.provider === 'mysql' ? metadata.provider : 'sqlite';
  const artifactProvider = artifacts.provider === 's3' ? 's3' : 'local';
  return {
    metadata: {
      provider: metadataProvider,
      options: plainOptions(metadata.options),
    },
    artifacts: {
      provider: artifactProvider,
      options: {
        ...(artifactProvider === 'local' ? { base_path: 'files' } : {}),
        ...plainOptions(artifacts.options),
      },
    },
  };
}

function readMemorySeed(value: unknown): RuntimeSettings['memory'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const config = value as Record<string, any>;
  const provider = config.provider === 'memu' || config.provider === 'mem0' ? config.provider : 'sqlite';
  return {
    enabled: config.enabled !== false,
    provider,
    options: plainOptions(config.options),
  };
}

function plainOptions(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}
