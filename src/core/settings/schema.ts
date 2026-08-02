import { z } from 'zod';
import { MINIMAX_PROVIDER } from '@/core/model/minimax.js';

const optionsSchema = z.record(z.unknown()).default({});
const STORED_SECRET_PREFIX = '__managed_secret__:';

export const runtimeSettingsSchema = z.object({
  schema_version: z.literal(1),
  model: z.object({
    vendor: z.enum(['openai', 'anthropic', 'openai_compatible', MINIMAX_PROVIDER]),
    base_url: z.string().url().optional(),
    api_key: z.string().min(1).optional(),
    options: optionsSchema,
  }).strict(),
  loop_engine: z.object({
    provider: z.enum(['builtin', 'harness', 'codex', 'claude']),
    options: z.object({
      default_max_steps: z.number().int().min(1).max(1_000).default(25),
    }).catchall(z.unknown()),
  }).strict(),
  storage: z.object({
    metadata: z.object({
      provider: z.enum(['sqlite', 'postgres', 'mysql']),
      options: optionsSchema,
    }).strict(),
    artifacts: z.object({
      provider: z.enum(['local', 's3']),
      options: optionsSchema,
    }).strict(),
  }).strict(),
  memory: z.object({
    enabled: z.boolean(),
    provider: z.enum(['sqlite', 'memu', 'mem0']),
    options: optionsSchema,
  }).strict(),
  sandbox: z.object({
    // `remote` is the persisted spelling of the self-hosted worker backend and
    // must stay accepted for existing runtime_settings rows. See
    // sandbox/provider-names for the registry-name translation.
    provider: z.enum(['local', 'docker', 'kubernetes', 'remote']),
    options: z.object({
      timeout_seconds: z.number().int().min(1).max(86_400).default(300),
    }).catchall(z.unknown()),
  }).strict(),
}).strict();

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

export type SettingsValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export type SettingsValidationResult = {
  valid: boolean;
  normalized_config?: RuntimeSettings;
  errors: SettingsValidationIssue[];
  warnings: SettingsValidationIssue[];
};

export type SettingsAvailability = {
  modelVendors: Set<RuntimeSettings['model']['vendor']>;
  loopEngines: Set<RuntimeSettings['loop_engine']['provider']>;
  metadataStorage: Set<RuntimeSettings['storage']['metadata']['provider']>;
  artifactStorage: Set<RuntimeSettings['storage']['artifacts']['provider']>;
  memoryProviders: Set<RuntimeSettings['memory']['provider']>;
  sandboxProviders: Set<RuntimeSettings['sandbox']['provider']>;
};

export function validateRuntimeSettings(
  input: unknown,
  availability: SettingsAvailability = defaultSettingsAvailability(),
): SettingsValidationResult {
  const parsed = runtimeSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
      warnings: [],
    };
  }

  const config = parsed.data;
  const errors: SettingsValidationIssue[] = [];
  validateModelSettings(errors, config);
  validateSandboxSettings(errors, config);
  requireAvailable(errors, 'model.vendor', config.model.vendor, availability.modelVendors);
  requireAvailable(errors, 'loop_engine.provider', config.loop_engine.provider, availability.loopEngines);
  requireAvailable(errors, 'storage.metadata.provider', config.storage.metadata.provider, availability.metadataStorage);
  requireAvailable(errors, 'storage.artifacts.provider', config.storage.artifacts.provider, availability.artifactStorage);
  if (config.memory.enabled) {
    requireAvailable(errors, 'memory.provider', config.memory.provider, availability.memoryProviders);
  }
  requireAvailable(errors, 'sandbox.provider', config.sandbox.provider, availability.sandboxProviders);

  return {
    valid: errors.length === 0,
    normalized_config: config,
    errors,
    warnings: [],
  };
}

function validateModelSettings(errors: SettingsValidationIssue[], config: RuntimeSettings): void {
  const baseUrl = config.model.base_url;
  if (config.model.vendor === 'openai_compatible' && !baseUrl) {
    errors.push({
      path: 'model.base_url',
      code: 'required',
      message: 'OpenAI-compatible model vendors require a base URL',
    });
    return;
  }
  if (!baseUrl) return;
  const protocol = new URL(baseUrl).protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    errors.push({
      path: 'model.base_url',
      code: 'invalid_protocol',
      message: 'Model base URL must use http or https',
    });
  }
}

function validateSandboxSettings(errors: SettingsValidationIssue[], config: RuntimeSettings): void {
  if (config.sandbox.provider !== 'remote') return;
  const endpoint = config.sandbox.options.endpoint;
  if (typeof endpoint !== 'string' || !endpoint.trim()) {
    errors.push({
      path: 'sandbox.options.endpoint',
      code: 'required',
      message: 'Remote sandbox requires a worker API URL',
    });
    return;
  }
  try {
    const protocol = new URL(endpoint).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') {
      errors.push({
        path: 'sandbox.options.endpoint',
        code: 'invalid_protocol',
        message: 'Remote sandbox worker API URL must use http or https',
      });
    }
  } catch {
    errors.push({
      path: 'sandbox.options.endpoint',
      code: 'invalid_url',
      message: 'Remote sandbox worker API URL must be a valid URL',
    });
  }
}

export function validateRuntimeSettingsCredentials(
  config: RuntimeSettings,
  hasStoredSecret: (path: string) => boolean = () => false,
): SettingsValidationIssue[] {
  const errors: SettingsValidationIssue[] = [];
  const value = config.model.api_key;
  if (!value) {
    errors.push({ path: 'model.api_key', code: 'required', message: 'A model API key is required' });
  }
  collectSecretCredentialIssues(config.model, 'model', hasStoredSecret, errors);
  collectSecretCredentialIssues(config.loop_engine, 'loop_engine', hasStoredSecret, errors);
  collectSecretCredentialIssues(config.storage, 'storage', hasStoredSecret, errors);
  if (config.memory.enabled) {
    collectSecretCredentialIssues(config.memory, 'memory', hasStoredSecret, errors);
  }
  collectSecretCredentialIssues(config.sandbox, 'sandbox', hasStoredSecret, errors);
  return errors;
}

export function defaultSettingsAvailability(): SettingsAvailability {
  return {
    modelVendors: new Set(['openai', 'anthropic', 'openai_compatible', MINIMAX_PROVIDER]),
    loopEngines: new Set(['builtin']),
    metadataStorage: new Set(['sqlite']),
    artifactStorage: new Set(['local']),
    memoryProviders: new Set(['sqlite']),
    sandboxProviders: new Set(['local']),
  };
}

function requireAvailable<T extends string>(
  errors: SettingsValidationIssue[],
  path: string,
  value: T,
  available: Set<T>,
): void {
  if (available.has(value)) return;
  errors.push({
    path,
    code: 'adapter_unavailable',
    message: `Adapter "${value}" is not available in this runtime`,
  });
}

function collectSecretCredentialIssues(
  value: unknown,
  path: string,
  hasStoredSecret: (path: string) => boolean,
  errors: SettingsValidationIssue[],
): void {
  if (typeof value === 'string') {
    if (!isSecretPath(path)) return;
    if (value.startsWith(STORED_SECRET_PREFIX)) {
      const referencedPath = value.slice(STORED_SECRET_PREFIX.length);
      if (referencedPath !== path || !hasStoredSecret(path)) {
        errors.push({
          path,
          code: 'secret_not_configured',
          message: `The stored secret reference at ${path} has no stored value`,
        });
      }
      return;
    }
    if (value === '********' && !hasStoredSecret(path)) {
      errors.push({
        path,
        code: 'secret_not_configured',
        message: `The masked secret at ${path} has no stored value`,
      });
      return;
    }
    const environment = /^\$\{([^}]+)\}$/.exec(value);
    if (environment && !process.env[environment[1]]) {
      errors.push({ path, code: 'missing_env', message: `${environment[1]} is not set` });
    }
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    collectSecretCredentialIssues(item, path ? `${path}.${key}` : key, hasStoredSecret, errors);
  }
}

function isSecretPath(path: string): boolean {
  if (path === 'model.api_key') return true;
  if (!path.includes('.options.')) return false;
  const key = path.split('.').at(-1) ?? '';
  return /(api[_-]?key|access[_-]?key|secret|token|password|credential)/i.test(key);
}
