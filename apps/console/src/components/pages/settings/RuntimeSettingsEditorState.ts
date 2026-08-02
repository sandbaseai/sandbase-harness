import type { ConsoleData, RuntimeSettingsConfig } from '../../../types';
import { optionDefaultsForAdapter } from './RuntimeSettingsFormShared';
import type { SettingsSection } from './navigation';

export type RuntimeSettingsSection = Extract<SettingsSection, 'models' | 'loop-engine' | 'storage' | 'memory' | 'sandbox'>;
type SettingsAdapters = NonNullable<ConsoleData['settings']>['adapters'];

export function testAreaForSection(section: RuntimeSettingsSection): 'model' | 'loop_engine' | 'memory' | 'sandbox' {
  if (section === 'models') return 'model';
  if (section === 'loop-engine') return 'loop_engine';
  if (section === 'memory') return 'memory';
  return 'sandbox';
}

export function configKeyForSection(section: Exclude<RuntimeSettingsSection, 'storage'>): 'model' | 'loop_engine' | 'memory' | 'sandbox' {
  if (section === 'models') return 'model';
  if (section === 'loop-engine') return 'loop_engine';
  if (section === 'memory') return 'memory';
  return 'sandbox';
}

function sectionKeyForRuntimeSettings(section: RuntimeSettingsSection): 'model' | 'loop_engine' | 'storage' | 'memory' | 'sandbox' {
  if (section === 'models') return 'model';
  if (section === 'loop-engine') return 'loop_engine';
  if (section === 'storage') return 'storage';
  if (section === 'memory') return 'memory';
  return 'sandbox';
}

export function isSettingsPathInSection(path: string, section: RuntimeSettingsSection): boolean {
  const key = sectionKeyForRuntimeSettings(section);
  return path === key || path.startsWith(`${key}.`);
}

export function applyRuntimeSettingsDefaults(
  config: RuntimeSettingsConfig,
  adapters: SettingsAdapters,
): RuntimeSettingsConfig {
  return {
    ...config,
    model: {
      ...config.model,
      base_url: config.model.base_url ?? defaultModelBaseUrl(config.model.vendor),
      api_key: config.model.api_key ?? defaultModelApiKey(config.model.vendor),
      options: config.model.options ?? {},
    },
    loop_engine: {
      ...config.loop_engine,
      options: {
        ...optionDefaultsForAdapter(adapters.loop_engine, config.loop_engine.provider),
        ...config.loop_engine.options,
      } as RuntimeSettingsConfig['loop_engine']['options'],
    },
    storage: {
      metadata: {
        ...config.storage.metadata,
        options: {
          ...optionDefaultsForAdapter(adapters.storage.metadata, config.storage.metadata.provider),
          ...config.storage.metadata.options,
        },
      },
      artifacts: {
        ...config.storage.artifacts,
        options: {
          ...optionDefaultsForAdapter(adapters.storage.artifacts, config.storage.artifacts.provider),
          ...config.storage.artifacts.options,
        },
      },
    },
    memory: {
      ...config.memory,
      options: {
        ...optionDefaultsForAdapter(adapters.memory, config.memory.provider),
        ...config.memory.options,
      },
    },
    sandbox: {
      ...config.sandbox,
      options: {
        ...optionDefaultsForAdapter(adapters.sandbox, config.sandbox.provider),
        ...config.sandbox.options,
      } as RuntimeSettingsConfig['sandbox']['options'],
    },
  };
}

function defaultModelBaseUrl(vendor: RuntimeSettingsConfig['model']['vendor']): string {
  if (vendor === 'anthropic') return 'https://api.anthropic.com';
  if (vendor === 'minimax') return 'https://api.minimax.io/v1';
  if (vendor === 'openai_compatible') return 'http://localhost:11434/v1';
  return 'https://api.openai.com/v1';
}

function defaultModelApiKey(vendor: RuntimeSettingsConfig['model']['vendor']): string {
  if (vendor === 'anthropic') return '${ANTHROPIC_API_KEY}';
  if (vendor === 'minimax') return '${MINIMAX_API_KEY}';
  if (vendor === 'openai') return '${OPENAI_API_KEY}';
  return '${MODEL_API_KEY}';
}

export function runtimeSettingsSectionJson(config: RuntimeSettingsConfig, section: RuntimeSettingsSection): string {
  return JSON.stringify(orderedRuntimeSettingsSection(config, section), null, 2);
}

function orderedRuntimeSettingsSection(config: RuntimeSettingsConfig, section: RuntimeSettingsSection): unknown {
  if (section === 'models') {
    return orderedObject({
      vendor: config.model.vendor,
      base_url: config.model.base_url,
      api_key: config.model.api_key,
      options: config.model.options,
    });
  }
  if (section === 'loop-engine') {
    return orderedObject({
      provider: config.loop_engine.provider,
      options: config.loop_engine.options,
    });
  }
  if (section === 'storage') {
    return {
      metadata: orderedObject({
        provider: config.storage.metadata.provider,
        options: config.storage.metadata.options,
      }),
      artifacts: orderedObject({
        provider: config.storage.artifacts.provider,
        options: config.storage.artifacts.options,
      }),
    };
  }
  if (section === 'memory') {
    return orderedObject({
      enabled: config.memory.enabled,
      provider: config.memory.provider,
      options: config.memory.options,
    });
  }
  return orderedObject({
    provider: config.sandbox.provider,
    options: config.sandbox.options,
  });
}

function orderedObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function mergeRuntimeSettingsSectionJson(
  config: RuntimeSettingsConfig,
  section: RuntimeSettingsSection,
  value: string,
): RuntimeSettingsConfig | null {
  try {
    const parsed = JSON.parse(value);
    return {
      ...config,
      [sectionKeyForRuntimeSettings(section)]: parsed,
    };
  } catch {
    return null;
  }
}

export function stableSettingsJson(value: RuntimeSettingsConfig): string {
  return stableStringify(value);
}

export function preserveCandidateSecrets(
  normalized: RuntimeSettingsConfig,
  candidate: RuntimeSettingsConfig,
): RuntimeSettingsConfig {
  return preserveCandidateSecretsAtPath(normalized, candidate, '') as RuntimeSettingsConfig;
}

function preserveCandidateSecretsAtPath(normalized: unknown, candidate: unknown, path: string): unknown {
  if (normalized === '********'
    && isRuntimeSettingsSecretPath(path)
    && typeof candidate === 'string'
    && candidate !== '********') {
    return candidate;
  }
  if (Array.isArray(normalized) || Array.isArray(candidate)) return normalized;
  if (!normalized || typeof normalized !== 'object' || !candidate || typeof candidate !== 'object') return normalized;
  return Object.fromEntries(Object.entries(normalized as Record<string, unknown>).map(([key, value]) => {
    const childPath = path ? `${path}.${key}` : key;
    return [key, preserveCandidateSecretsAtPath(value, (candidate as Record<string, unknown>)[key], childPath)];
  }));
}

function isRuntimeSettingsSecretPath(path: string): boolean {
  if (path === 'model.api_key') return true;
  if (!path.includes('.options.')) return false;
  const key = path.split('.').at(-1) ?? '';
  return /(api[_-]?key|access[_-]?key|secret|token|password|credential)/i.test(key);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
