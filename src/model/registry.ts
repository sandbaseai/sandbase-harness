/**
 * Model Provider Registry
 *
 * Manages model configurations and creates Vercel AI SDK LanguageModel instances.
 * Supports: openai (OpenAI-compatible, incl. Ollama/vLLM), anthropic, minimax.
 * Includes retry policy wrapper (Property 14).
 */

import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import { resolveEnvVars } from '@/core/config/env-resolver.js';
import { MINIMAX_PROVIDER, miniMaxOpenAiBaseUrl } from '@/core/model/minimax.js';
import {
  DEFAULT_RETRY_POLICY,
  type ModelConfig,
  type ModelProviderType,
  type RetryPolicy,
  type RuntimeConfigState,
  type RuntimeModelInfo,
} from '@/types/model.js';

export class ModelRegistry {
  private models = new Map<string, ModelConfig>();
  private defaultModelName: string | undefined;

  constructor(private readonly retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY) {}

  /**
   * Register a model configuration.
   */
  register(config: ModelConfig): void {
    this.models.set(config.name, config);
    if (config.is_default || !this.defaultModelName) {
      this.defaultModelName = config.name;
    }
  }

  /**
   * Get a registered model config by name.
   */
  get(name: string): ModelConfig | undefined {
    return this.models.get(name);
  }

  setDefault(name: string): void {
    if (!this.models.has(name)) {
      throw new ModelNotFoundError(name, Array.from(this.models.keys()));
    }
    this.defaultModelName = name;
  }

  /** Replace compatibility/bootstrap entries with the active runtime model. */
  clear(): void {
    this.models.clear();
    this.defaultModelName = undefined;
  }

  getDefaultName(): string | undefined {
    return this.defaultModelName ?? Array.from(this.models.keys())[0];
  }

  /**
   * Resolve an agent-facing model reference into a concrete provider config.
   *
   * Exact registry names still work (`default`, `anthropic`, custom aliases).
   * Otherwise, the user-provided model is treated as the concrete model id:
   * - `openai/gpt-5.5` => provider `openai`, model `gpt-5.5`
   * - `anthropic/claude-...` => provider `anthropic`, model `claude-...`
   * - `gpt-4o` => default provider credentials/base URL, model `gpt-4o`
   *
   * A `provider/model` reference whose provider is not registered does NOT
   * silently fall back to a public vendor endpoint. If the referenced provider
   * belongs to the same protocol family as the active default (e.g. an agent
   * says `openai/...` while the configured provider is `openai_compatible`
   * pointing at a self-hosted gateway), the default provider's base URL and
   * key are reused so traffic stays on the configured endpoint. A reference to
   * an unrelated, unconfigured provider is rejected rather than leaked to that
   * vendor's public API.
   */
  resolveModelConfig(name: string): ModelConfig {
    const exact = this.models.get(name);
    if (exact?.model) return exact;
    if (exact && !exact.model) {
      throw new ModelNotFoundError(name, Array.from(this.models.keys()), 'Provider configuration does not include a concrete model id. Set model on the Agent instead.');
    }

    const parsed = parseModelReference(name);

    // No provider prefix → use the active default provider's config.
    if (!parsed.provider) {
      const defaultConfig = this.getDefaultConfig();
      if (!defaultConfig) throw new ModelNotFoundError(name, Array.from(this.models.keys()));
      return { ...defaultConfig, name, model: parsed.model, is_default: false };
    }

    // Explicit provider prefix that matches a registered provider → use it.
    const exactProvider = this.findProviderConfig(parsed.provider);
    if (exactProvider) {
      return { ...exactProvider, name, provider: parsed.provider, model: parsed.model, is_default: false };
    }

    // Provider prefix with no exact match. Reuse the default provider's
    // credentials/base URL when they share a protocol family (so a configured
    // gateway is honored instead of hitting the vendor's public endpoint).
    const defaultConfig = this.getDefaultConfig();
    if (defaultConfig && providerFamily(parsed.provider) === providerFamily(defaultConfig.provider)) {
      return { ...defaultConfig, name, model: parsed.model, is_default: false };
    }

    // Unrelated, unconfigured provider: fail loud instead of leaking the
    // request to that vendor's public API with no base URL or key.
    throw new ModelNotFoundError(
      name,
      Array.from(this.models.keys()),
      `Provider "${parsed.provider}" is not configured. Configure it in Settings > Models, or reference the model without a provider prefix to use the active provider.`,
    );
  }

  /**
   * Create a Vercel AI SDK LanguageModel instance, wrapped with the retry
   * middleware (Property 14). Resolves ${ENV_VAR} in api_key and base_url.
   */
  createModel(name: string): LanguageModel {
    const config = this.resolveModelConfig(name);
    if (!config.model) {
      throw new ModelNotFoundError(name, Array.from(this.models.keys()), 'Agent model id is required.');
    }
    const resolvedApiKey = config.api_key ? resolveEnvVars(config.api_key, false) : undefined;
    const resolvedBaseUrl = config.base_url ? resolveEnvVars(config.base_url, false) : undefined;

    const base = createModelInstance(
      config.provider,
      config.model,
      resolvedApiKey,
      resolvedBaseUrl,
    );
    const middleware: LanguageModelMiddleware[] = [createRetryMiddleware(this.retryPolicy)];
    // Only the OpenAI-compatible branches ever took a reasoning effort.
    if (config.reasoning_effort && config.provider !== 'anthropic' && config.provider !== MINIMAX_PROVIDER) {
      middleware.push(createReasoningEffortMiddleware(config.reasoning_effort));
    }
    return wrapLanguageModel({ model: base, middleware });
  }

  /**
   * Health check: attempt a minimal test against the model.
   * Returns false on any error, does not throw.
   */
  async healthCheck(name: string): Promise<boolean> {
    try {
      const model = this.createModel(name);
      // Just verify the model object was created successfully
      // A real health check would do a 1-token completion, but that costs money
      return model !== null && model !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * List all registered model names.
   */
  listNames(): string[] {
    return Array.from(this.models.keys());
  }

  /**
   * List model metadata that is safe to expose through runtime introspection.
   * Never includes raw API keys or resolved base URLs.
   */
  listRuntimeInfo(): RuntimeModelInfo[] {
    const defaultName = this.getDefaultName();
    return Array.from(this.models.values())
      .sort((a, b) => Number(b.name === defaultName) - Number(a.name === defaultName) || a.name.localeCompare(b.name))
      .map((config) => ({
      name: config.name,
      provider: config.provider ?? 'unknown',
      ...(config.model ? { model: config.model } : {}),
      base_url: publicBaseUrl(config.base_url),
      api_key_state: configState(config.api_key),
      base_url_state: configState(config.base_url),
      is_default: config.name === defaultName,
    }));
  }

  private getDefaultConfig(): ModelConfig | undefined {
    const defaultName = this.getDefaultName();
    return defaultName ? this.models.get(defaultName) : undefined;
  }

  private findProviderConfig(provider: string): ModelConfig | undefined {
    return Array.from(this.models.values()).find((config) => config.provider === provider);
  }
}

const ENV_PLACEHOLDER = /\$\{[^}]+\}/;
const QUALIFIED_MODEL = /^([a-zA-Z][a-zA-Z0-9_-]*)\/(.+)$/;

/**
 * Group providers by wire protocol. Providers in the same family can share a
 * base URL and key: `anthropic` speaks the Anthropic Messages API, while
 * `openai`, `ollama`, `minimax`, `openai_compatible`, and any custom provider
 * are all handled through the OpenAI-compatible client (see
 * createModelInstance). Used to decide whether an agent's `provider/model`
 * reference may reuse the active default provider's endpoint.
 */
function providerFamily(provider: ModelProviderType): 'anthropic' | 'openai' {
  return provider === 'anthropic' ? 'anthropic' : 'openai';
}

function parseModelReference(name: string): { provider?: ModelProviderType; model: string } {
  const trimmed = name.trim();
  const match = QUALIFIED_MODEL.exec(trimmed);
  if (!match) return { model: trimmed };
  return { provider: match[1], model: match[2] };
}

function configState(value?: string): RuntimeConfigState {
  if (!value) return 'not_set';
  const resolved = resolveEnvVars(value, false);
  return ENV_PLACEHOLDER.test(resolved) ? 'missing_env' : 'configured';
}

function publicBaseUrl(value?: string): string | undefined {
  if (!value) return undefined;
  const resolved = resolveEnvVars(value, false);
  return ENV_PLACEHOLDER.test(resolved) ? undefined : resolved;
}

// ============================================================
// Retry Middleware (Property 14)
// ============================================================

/**
 * Wrap model generate/stream calls with the retry policy:
 * - network timeout: retry up to 3x, no backoff
 * - rate limit (429): honor Retry-After, up to 3x
 * - auth (401/403): never retry
 */
function createRetryMiddleware(policy: RetryPolicy): LanguageModelMiddleware {
  const runWithRetry = async <T>(fn: () => PromiseLike<T>): Promise<T> => {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        const type = policy.classify(err);
        const max = policy.maxRetries(type);
        if (attempt >= max) throw err;
        const headers = extractHeaders(err);
        const delay = policy.getDelay(type, attempt, headers);
        if (delay > 0) await sleep(delay);
        attempt++;
      }
    }
  };

  return {
    wrapGenerate: async ({ doGenerate }) => runWithRetry(doGenerate),
    // Streaming: retry only applies to establishing the stream (the initial
    // call). Once bytes flow, mid-stream failures are surfaced to the caller.
    wrapStream: async ({ doStream }) => runWithRetry(doStream),
  };
}

/**
 * Pass `reasoning_effort` as a call-time provider option: the provider dropped
 * the constructor settings argument that used to carry it.
 */
function createReasoningEffortMiddleware(reasoningEffort: string): LanguageModelMiddleware {
  return {
    transformParams: async ({ params }) => ({
      ...params,
      providerOptions: {
        ...params.providerOptions,
        openai: { reasoningEffort, ...params.providerOptions?.openai },
      },
    }),
  };
}

function extractHeaders(err: unknown): Headers | undefined {
  if (err && typeof err === 'object' && 'responseHeaders' in err) {
    const h = (err as { responseHeaders?: unknown }).responseHeaders;
    if (h instanceof Headers) return h;
    if (h && typeof h === 'object') {
      return new Headers(h as Record<string, string>);
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// Model Factory
// ============================================================

/**
 * `.chat(model)` not `openai(model)`: the bare call now targets the Responses
 * API, which Ollama/vLLM/DeepSeek/minimax do not implement.
 */
function createModelInstance(
  provider: ModelProviderType,
  model: string,
  apiKey?: string,
  baseUrl?: string,
) {
  switch (provider) {
    case 'openai':
    case 'ollama': {
      const openai = createOpenAI({
        apiKey: apiKey ?? 'ollama', // Ollama doesn't need a key
        baseURL: baseUrl,
      });
      return openai.chat(model);
    }
    case MINIMAX_PROVIDER: {
      const minimax = createOpenAI({
        apiKey: apiKey ?? '',
        baseURL: miniMaxOpenAiBaseUrl({}, baseUrl),
      });
      return minimax.chat(model);
    }
    case 'anthropic': {
      const anthropic = createAnthropic({
        apiKey: apiKey,
        baseURL: baseUrl,
      });
      return anthropic(model);
    }
    default: {
      // Treat unknown providers as OpenAI-compatible
      const openaiCompat = createOpenAI({
        apiKey: apiKey ?? '',
        baseURL: baseUrl,
      });
      return openaiCompat.chat(model);
    }
  }
}

// ============================================================
// Errors
// ============================================================

export class ModelNotFoundError extends Error {
  constructor(
    public readonly modelName: string,
    public readonly available: string[],
    detail?: string,
  ) {
    const suggestion = available.length > 0
      ? `Available models: ${available.join(', ')}`
      : 'No models registered. Add a model provider in Dashboard Settings > Models';
    super(`Model not found: "${modelName}". ${detail ? `${detail} ` : ''}${suggestion}`);
    this.name = 'ModelNotFoundError';
  }
}
