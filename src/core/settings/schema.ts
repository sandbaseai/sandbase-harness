import { z } from 'zod';
import { MINIMAX_PROVIDER } from '@/core/model/minimax.js';
import { CANONICAL_TOOL_RESULT_MAX_CHARS } from '@/core/session/tool-output-overflow.js';
import { PI_APPROVAL_MODES } from '@/strategy/pi/approval-mode.js';

const optionsSchema = z.record(z.string(), z.unknown()).default({});
const STORED_SECRET_PREFIX = '__managed_secret__:';
/**
 * Web-search provider ids the settings document recognizes.
 *
 * The enum lists the providers the contract plans, not only the ones with a
 * shipped adapter — an id outside it is a validation error naming the field,
 * while an id inside it but without an adapter is refused by the availability
 * check (`adapter_unavailable`), mirroring how `loop_engine` lists engines
 * this runtime cannot execute.
 */
export const WEB_SEARCH_PROVIDER_IDS = ['tavily', 'keenable', 'outcrawl', 'brave', 'exa', 'searxng'] as const;
export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDER_IDS)[number];
const COMPLETE_ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export const runtimeSettingsSchema = z.object({
  schema_version: z.literal(1),
  model: z.object({
    vendor: z.enum(['openai', 'anthropic', 'openai_compatible', MINIMAX_PROVIDER]),
    base_url: z.union([
      z.string().url().refine((value) => !value.includes('${'), {
        message: 'Model base URL must not contain partial environment references',
      }),
      z.string().regex(COMPLETE_ENV_REFERENCE),
    ]).optional(),
    api_key: z.string().min(1).optional(),
    options: optionsSchema,
  }).strict(),
  loop_engine: z.object({
    provider: z.enum(['builtin', 'pi', 'harness', 'codex', 'claude']),
    options: z.object({
      default_max_steps: z.number().int().min(1).max(1_000).default(25),
      // Platform-owned Pi gate behaviour, declared here as well as in the adapter
      // descriptor so a misspelled mode is a Settings error rather than a
      // silently ignored key. Optional rather than defaulted, so a settings row
      // written before this mode existed stays valid unchanged, and runtime
      // resolution fails safe to `interactive`: unattended operation has to be
      // chosen explicitly.
      approval_mode: z.enum(PI_APPROVAL_MODES).optional(),
      // How long a session may stay parked waiting for a caller's answer before
      // the runtime ends it (`parked-wait.ts`). Optional with **no default**, for
      // a contract reason rather than a stylistic one: the published behaviour is
      // that the session "waits indefinitely for a response"
      // (`权限策略.md:668`), so defaulting this would make the runtime
      // non-conformant out of the box. Absent means the published indefinite
      // wait. The upper bound is 30 days — a typo guard, not a policy, since a
      // bound an operator sets has to be one they could plausibly mean.
      requires_action_timeout_seconds: z.number().int().min(1).max(2_592_000).optional(),
      // Tool-result overflow threshold (`tool-output-overflow.ts`). Defaults to
      // the published 100,000 so an untouched deployment conforms; both bounds
      // are typo guards — under a thousand characters nearly every result would
      // spill, and tens of millions would defeat the point of the bound.
      tool_result_max_chars: z.number().int().min(1_000).max(10_000_000).default(CANONICAL_TOOL_RESULT_MAX_CHARS),
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
  /**
   * Search provider configuration for the `web_search` built-in tool.
   *
   * Optional: a row persisted before this subsystem existed must still parse,
   * and an absent section is the honest spelling of "no search provider is
   * configured" — the capability stays `unavailable` and an agent that
   * declares the tool fails admission. `options.api_key` is matched by the
   * secret-path rules, so it gains `__managed_secret__` storage, `${ENV}`
   * references, and Console masking without extra wiring.
   */
  web_search: z.object({
    provider: z.enum(WEB_SEARCH_PROVIDER_IDS),
    options: optionsSchema,
  }).strict().optional(),
  /**
   * Dream pipeline defaults.
   *
   * Optional for the same reason `web_search` is: a settings row persisted
   * before this section existed must still parse, and an absent section is the
   * honest spelling of "no dream-specific model" — a dream request without a
   * `model` then falls back to the workspace default.
   */
  dreams: z.object({
    // A model registry reference, same vocabulary as an agent's `model` field.
    model: z.string().min(1).max(256).optional(),
  }).strict().optional(),
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
  webSearchProviders: Set<WebSearchProviderId>;
};

export function validateRuntimeSettings(
  input: unknown,
  availability: SettingsAvailability = defaultSettingsAvailability(),
  environment: NodeJS.ProcessEnv = process.env,
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
  validateModelSettings(errors, config, environment);
  validateSandboxSettings(errors, config);
  validatePiSandboxCompatibility(errors, config);
  requireAvailable(errors, 'model.vendor', config.model.vendor, availability.modelVendors);
  requireAvailable(errors, 'loop_engine.provider', config.loop_engine.provider, availability.loopEngines);
  requireAvailable(errors, 'storage.metadata.provider', config.storage.metadata.provider, availability.metadataStorage);
  requireAvailable(errors, 'storage.artifacts.provider', config.storage.artifacts.provider, availability.artifactStorage);
  if (config.memory.enabled) {
    requireAvailable(errors, 'memory.provider', config.memory.provider, availability.memoryProviders);
  }
  requireAvailable(errors, 'sandbox.provider', config.sandbox.provider, availability.sandboxProviders);
  if (config.web_search) {
    requireAvailable(errors, 'web_search.provider', config.web_search.provider, availability.webSearchProviders);
    validateWebSearchSettings(errors, config.web_search);
  }

  return {
    valid: errors.length === 0,
    normalized_config: config,
    errors,
    warnings: [],
  };
}

function validateModelSettings(
  errors: SettingsValidationIssue[],
  config: RuntimeSettings,
  environment: NodeJS.ProcessEnv,
): void {
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

  const envReference = COMPLETE_ENV_REFERENCE.exec(baseUrl);
  const resolvedBaseUrl = envReference ? environment[envReference[1]] : baseUrl;
  if (resolvedBaseUrl === undefined) {
    errors.push({
      path: 'model.base_url',
      code: 'missing_env',
      message: `${envReference![1]} is not set`,
    });
    return;
  }
  if (resolvedBaseUrl.includes('${')) {
    errors.push({
      path: 'model.base_url',
      code: 'unresolved_env_reference',
      message: 'Model base URL contains unresolved environment references',
    });
    return;
  }

  try {
    const protocol = new URL(resolvedBaseUrl).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') {
      errors.push({
        path: 'model.base_url',
        code: 'invalid_protocol',
        message: 'Model base URL must use http or https',
      });
    }
  } catch {
    errors.push({
      path: 'model.base_url',
      code: 'invalid_url',
      message: 'Model base URL must be a valid URL',
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

/**
 * Field-level checks a configured web_search provider must pass.
 *
 * `api_key` must be *present*, not necessarily resolvable here — a literal, a
 * `${ENV}` reference, and a `__managed_secret__` pointer are all accepted
 * spellings, and the credential sweep decides whether the spelled value can
 * resolve. `base_url` overrides the vendor endpoint; it is operator-level
 * configuration, so only the URL shape is checked — the guard against an
 * unreachable host is the settings Test probe, not schema validation.
 */
function validateWebSearchSettings(
  errors: SettingsValidationIssue[],
  webSearch: NonNullable<RuntimeSettings['web_search']>,
): void {
  const apiKey = webSearch.options.api_key;
  if (apiKey !== undefined && typeof apiKey !== 'string') {
    errors.push({
      path: 'web_search.options.api_key',
      code: 'invalid_type',
      message: 'Web search api_key must be a string',
    });
  }
  const baseUrl = webSearch.options.base_url;
  if (baseUrl === undefined) return;
  if (typeof baseUrl !== 'string') {
    errors.push({
      path: 'web_search.options.base_url',
      code: 'invalid_type',
      message: 'Web search base_url must be a string',
    });
    return;
  }
  if (/^\$\{[^}]+\}$/.test(baseUrl)) return;
  try {
    const protocol = new URL(baseUrl).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') {
      errors.push({
        path: 'web_search.options.base_url',
        code: 'invalid_protocol',
        message: 'Web search base_url must use http or https',
      });
    }
  } catch {
    errors.push({
      path: 'web_search.options.base_url',
      code: 'invalid_url',
      message: 'Web search base_url must be a valid URL',
    });
  }
}

function validatePiSandboxCompatibility(errors: SettingsValidationIssue[], config: RuntimeSettings): void {
  if (config.loop_engine.provider !== 'pi' || config.sandbox.provider === 'local') return;
  errors.push({
    path: 'sandbox.provider',
    code: 'incompatible_adapter',
    message: 'Pi loop engine requires the local sandbox provider because it needs a host-accessible work directory',
  });
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
  if (config.web_search) {
    collectSecretCredentialIssues(config.web_search, 'web_search', hasStoredSecret, errors);
  }
  return errors;
}

export function defaultSettingsAvailability(): SettingsAvailability {
  return {
    modelVendors: new Set(['openai', 'anthropic', 'openai_compatible', MINIMAX_PROVIDER]),
    loopEngines: new Set(['builtin', 'pi']),
    metadataStorage: new Set(['sqlite']),
    artifactStorage: new Set(['local']),
    memoryProviders: new Set(['sqlite']),
    sandboxProviders: new Set(['local']),
    // Tavily, Keenable and Outcrawl ship adapters; the other ids validate but
    // fail the availability check until their adapters land.
    webSearchProviders: new Set<WebSearchProviderId>(['tavily', 'keenable', 'outcrawl']),
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
    const environment = COMPLETE_ENV_REFERENCE.exec(value);
    if (environment) {
      const resolved = process.env[environment[1]];
      if (resolved === undefined) {
        errors.push({ path, code: 'missing_env', message: `${environment[1]} is not set` });
      } else if (resolved === '') {
        // Set, but supplies nothing: the same unusable secret as an unset one,
        // and saying "not set" of a variable that is set would send the operator
        // looking for the wrong mistake.
        errors.push({ path, code: 'missing_env', message: `${environment[1]} is set to an empty value` });
      } else if (resolved.includes('${')) {
        errors.push({
          path,
          code: 'unresolved_env_reference',
          message: `${path} contains unresolved environment references`,
        });
      }
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
