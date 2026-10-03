import type { Database } from '@/core/db/database.js';
import type { MemoryProvider } from '@/core/memory/memory-provider.js';
import { SqliteMemoryProvider } from '@/core/memory/sqlite-memory-provider.js';
import type { RuntimeSettings } from '@/core/settings/schema.js';
import { activateRuntimeSettings, localArtifactStorageDir, modelConfigFromRuntimeSettings, type RuntimeSettingsRecord, type RuntimeSettingsSeed } from '@/core/settings/store.js';
import { LocalArtifactStore } from '@/core/storage/artifact-store.js';
import type { ModelRegistry } from '@/model/registry.js';
import {
  parseEnvironmentConfig,
  sandboxProviderForEnvironmentConfig,
  sandboxProviderForSettings,
  WORKSPACE_DEFAULT_SANDBOX_PROVIDER,
} from '@/sandbox/provider-names.js';
import type { EnvironmentConfig, KubernetesEnvironmentConfig } from '@/types/sandbox.js';

export interface RuntimeComposition {
  settings: RuntimeSettingsRecord;
  memory?: MemoryProvider;
  artifactStore: LocalArtifactStore;
  resolveEnvironmentConfig(environmentId: string): EnvironmentConfig | undefined;
}

export function composeRuntimeFromSettings({
  db,
  dataDir,
  modelRegistry,
  settingsSeed,
  sandboxProviders = ['local'],
}: {
  db: Database;
  dataDir: string;
  modelRegistry: ModelRegistry;
  /**
   * Values used only when `runtime_settings` has no row yet. `RuntimeSettingsSeed`
   * already carries `memoryEnabled`, so there is one way to express a seed
   * rather than a separate flag that has to be merged in here.
   */
  settingsSeed?: RuntimeSettingsSeed;
  sandboxProviders?: string[];
}): RuntimeComposition {
  const settings = activateRuntimeSettings(db, settingsSeed ?? {}, dataDir, sandboxProviders);
  const effectiveSettings = settings.effective_config;

  modelRegistry.clear();
  modelRegistry.register(modelConfigFromRuntimeSettings(db, effectiveSettings, dataDir));

  const memory = effectiveSettings.memory.enabled && effectiveSettings.memory.provider === 'sqlite'
    ? new SqliteMemoryProvider(db)
    : undefined;
  const artifactStore = new LocalArtifactStore(localArtifactStorageDir(dataDir, effectiveSettings));

  return {
    settings,
    memory,
    artifactStore,
    resolveEnvironmentConfig(environmentId: string): EnvironmentConfig | undefined {
      const row = db.prepare('SELECT id, name, config FROM environments WHERE id = ? AND archived_at IS NULL').get(environmentId) as
        | { id: string; name: string; config: string }
        | undefined;
      if (!row) return undefined;
      const environment = normalizeRuntimeEnvironment(row);
      // env_default is the workspace fallback; named Environments remain
      // explicit session-level sandbox overrides — unless they declared
      // `type: "cloud"`, the published "platform decides" value, which on
      // this runtime resolves to the workspace's configured default backend.
      if (row.id !== 'env_default' && environment.sandbox_provider !== WORKSPACE_DEFAULT_SANDBOX_PROVIDER) {
        return environment;
      }
      return {
        ...environment,
        ...sandboxConfigFromSettings(effectiveSettings.sandbox),
      } as EnvironmentConfig;
    },
  };
}

export function normalizeRuntimeEnvironment(row: { id: string; name: string; config: string }): EnvironmentConfig {
  const context = `Environment ${row.id}${row.name ? ` ("${row.name}")` : ''}`;
  const parsed = parseEnvironmentConfig(row.config, context);
  // The declared backend — or the hosting type behind it — decides where this
  // Environment runs. An unreadable row or a value this runtime cannot serve
  // is refused here instead of being replaced by the local backend, which used
  // to run isolated configurations on the host with no error at all. `cloud`
  // reads as the workspace-default sentinel and is substituted by the caller
  // that owns the effective Settings.
  const sandboxProvider = sandboxProviderForEnvironmentConfig(parsed, context);

  return {
    ...parsed,
    name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : row.name || row.id,
    sandbox_provider: sandboxProvider,
    timeout: typeof parsed.timeout === 'number' ? parsed.timeout : 300,
  };
}

/**
 * Project the Settings V2 sandbox section onto the Environment shape the
 * providers consume.
 *
 * Settings V2 keeps backend-specific values in a flat `options` bag (that is
 * what the adapter `options_schema` describes and what the Console form
 * writes), while providers read `EnvironmentConfig`. Without this translation
 * every backend-specific setting a user configured — namespace, kubeconfig,
 * image — was silently dropped and the backend ran on its own defaults.
 */
function sandboxConfigFromSettings(
  sandbox: RuntimeSettings['sandbox'],
): Pick<EnvironmentConfig, 'sandbox_provider' | 'timeout' | 'image' | 'kubernetes'> {
  const options = sandbox.options;
  const image = stringOption(options.image);
  const kubernetes: KubernetesEnvironmentConfig = {
    ...optionalString('namespace', options.namespace),
    ...optionalString('context', options.context),
    ...optionalString('kubeconfig', options.kubeconfig),
    ...optionalString('service_account', options.service_account),
  };

  return {
    sandbox_provider: sandboxProviderForSettings(sandbox.provider),
    timeout: options.timeout_seconds,
    ...(image ? { image } : {}),
    ...(Object.keys(kubernetes).length > 0 ? { kubernetes } : {}),
  };
}

function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalString(key: string, value: unknown): Record<string, string> {
  const resolved = stringOption(value);
  return resolved ? { [key]: resolved } : {};
}
