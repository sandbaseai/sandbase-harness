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
import { EnvVarNotFoundError, referencedEnvVars, resolveEnvVars } from '@/core/config/env-resolver.js';
import { MINIMAX_PROVIDER, miniMaxOpenAiBaseUrl } from '@/core/model/minimax.js';
import {
  ModelConfigInvalidError,
  ModelCredentialUnresolvedError,
  ModelNotFoundError,
  ModelProviderNotConfiguredError,
} from '@/model/errors.js';
import {
  DEFAULT_RETRY_POLICY,
  type ModelConfig,
  type ModelProviderType,
  type RetryObserver,
  type RetryPolicy,
  type RuntimeConfigState,
  type RuntimeModelInfo,
} from '@/types/model.js';

export {
  MODEL_AUTH_FAILED_CODE,
  MODEL_CONFIG_INVALID_CODE,
  MODEL_NOT_FOUND_CODE,
  MODEL_PROVIDER_NOT_CONFIGURED_CODE,
  ModelConfigInvalidError,
  ModelCredentialUnresolvedError,
  ModelNotFoundError,
  ModelProviderNotConfiguredError,
  ModelResolutionError,
  RESUMABLE_MODEL_FAILURE_CODES,
} from '@/model/errors.js';
export type { ModelErrorCode } from '@/model/errors.js';

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
   * - `<registered-provider>/<model>` => that provider's settings, model `<model>`
   * - `<anything-else>/<model>` => the active default provider, model passed through verbatim
   * - `<model>` => default provider credentials/base URL, model `<model>`
   *
   * The prefix rule is deliberately "only a registered provider is a prefix".
   * Gateways that route by vendor namespace (OpenRouter and the many
   * OpenAI-compatible routers shaped like it) address every model as
   * `vendor/model`, so a token this workspace has not registered as a provider
   * has to stay part of the model id. Reading it as a provider prefix is what
   * previously truncated `deepseek/deepseek-v4-flash` into
   * `deepseek-v4-flash`, an id no endpoint serves.
   *
   * A reference whose leading token is not a registered provider never reaches
   * a vendor endpoint the operator did not configure: it is served by the
   * active default provider's base URL and key. The one case still refused is a
   * namespaced id a first-party vendor API cannot possibly serve (see
   * `unserviceableNamespaceReason`), because forwarding it would replace a
   * missing provider configuration with a confusing upstream 404.
   */
  resolveModelConfig(name: string): ModelConfig {
    const available = Array.from(this.models.keys());

    const exact = this.models.get(name);
    if (exact?.model) return exact;
    if (exact && !exact.model) {
      throw new ModelConfigInvalidError(
        name,
        available,
        'Provider configuration does not include a concrete model id. Set model on the Agent instead.',
      );
    }

    const parsed = parseModelReference(name, (token) => this.findProviderConfig(token) !== undefined);

    // Nothing registered as this token's provider: the reference is the model
    // id itself, forwarded verbatim to the active default provider.
    if (!parsed.provider) {
      const defaultConfig = this.getDefaultConfig();
      if (!defaultConfig) throw new ModelNotFoundError(name, available);
      const reason = unserviceableNamespaceReason(parsed.namespace, defaultConfig.provider);
      if (reason) throw new ModelProviderNotConfiguredError(name, available, reason);
      return { ...defaultConfig, name, model: parsed.model, is_default: false };
    }

    // A registered provider is named: use its own settings. `findProviderConfig`
    // already succeeded inside `parseModelReference`, so the lookup cannot miss.
    const providerConfig = this.findProviderConfig(parsed.provider)!;
    return { ...providerConfig, name, model: parsed.model, is_default: false };
  }

  /**
   * Create a Vercel AI SDK LanguageModel instance, wrapped with the retry
   * middleware (Property 14). Resolves ${ENV_VAR} in api_key and base_url.
   */
  /**
   * The registry's retry middleware on its own, for callers that wrap a model
   * built elsewhere — one observer reports on that wrapper's retries only.
   */
  retryMiddleware(observer?: RetryObserver): LanguageModelMiddleware {
    return createRetryMiddleware(this.retryPolicy, observer);
  }

  createModel(name: string, options?: { retryObserver?: RetryObserver }): LanguageModel {
    return this.createModelFromConfig(this.resolveModelConfig(name), options);
  }

  /**
   * Build the client from an already-resolved configuration.
   *
   * Exists so a caller can resolve a reference once and build from exactly that
   * configuration rather than resolving a second time.
   *
   * A `${VAR}` reference is resolved **strictly** here, unlike the read
   * projections: `resolveEnvVars(..., false)` leaves the placeholder in place, so
   * a provider whose key comes from an unset variable used to be called with
   * `${OPENAI_API_KEY}` as the literal credential and answer 401 — a message that
   * names neither the variable nor the field. Failing before the request instead
   * is what makes the first turn say which variable is missing.
   */
  createModelFromConfig(config: ModelConfig, options?: { retryObserver?: RetryObserver }): LanguageModel {
    if (!config.model) {
      throw new ModelConfigInvalidError(
        config.name,
        Array.from(this.models.keys()),
        'Agent model id is required.',
      );
    }
    const provider = config.provider ?? 'openai';
    const resolvedApiKey = this.resolveCredential(config.api_key, provider, 'api_key');
    const resolvedBaseUrl = this.resolveCredential(config.base_url, provider, 'base_url');

    const base = createModelInstance(
      provider,
      config.model,
      resolvedApiKey,
      resolvedBaseUrl,
    );
    const middleware: LanguageModelMiddleware[] = [createRetryMiddleware(this.retryPolicy, options?.retryObserver)];
    // Only the OpenAI-compatible branches ever took a reasoning effort.
    if (config.reasoning_effort && config.provider !== 'anthropic' && config.provider !== MINIMAX_PROVIDER) {
      middleware.push(createReasoningEffortMiddleware(config.reasoning_effort));
    }
    const wrapped = wrapLanguageModel({ model: base, middleware });
    // Record the id the provider will actually be addressed with, so a turn can
    // read it back without depending on how the AI SDK exposes `modelId` through
    // a wrapper. Keyed per instance rather than stored on the registry: one
    // registry serves concurrent sessions, and a single "last resolved" field
    // would report whichever turn resolved most recently.
    resolvedModelIds.set(wrapped as object, config.model);
    return wrapped;
  }

  /**
   * Resolve one provider field, turning a `${VAR}` that supplies nothing into a
   * named error.
   *
   * Only the model client path is strict. `configState` and `publicBaseUrl` keep
   * reading the same value leniently, which is what lets a caller report *which*
   * variable is missing instead of failing to render the configuration at all.
   *
   * Two states supply nothing and both are refused here, because both end with a
   * client that was built from a credential nobody chose: the variable is unset,
   * or it is set to the empty string. The settings layer reads the second as
   * `missing_env` too (`src/core/settings/schema.ts`), so treating it as usable
   * here would leave the Console reporting a state this path does not act on.
   */
  private resolveCredential(
    value: string | undefined,
    provider: string,
    field: 'api_key' | 'base_url',
  ): string | undefined {
    if (!value) return undefined;
    let resolved: string;
    try {
      resolved = resolveEnvVars(value, true);
    } catch (error) {
      if (error instanceof EnvVarNotFoundError) {
        throw new ModelCredentialUnresolvedError(provider, field, error.varName);
      }
      throw error;
    }
    if (resolved === '') {
      // The whole value resolved to nothing, so every reference in it was empty.
      const [variable] = referencedEnvVars(value);
      throw new ModelCredentialUnresolvedError(provider, field, variable ?? value, true);
    }
    return resolved;
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

  /**
   * The registered configuration a reference's leading token names.
   *
   * Two spellings count, because both appear as the provider's own identifier:
   * the provider type (`openai`, `anthropic`, `openai_compatible`) and the
   * registry name, which is what an operator-chosen alias such as
   * `openrouter` is stored under. Provider-type matches are checked first so an
   * alias can never shadow a provider named by its type.
   */
  private findProviderConfig(provider: string): ModelConfig | undefined {
    const configs = Array.from(this.models.values());
    return configs.find((config) => config.provider === provider)
      ?? configs.find((config) => config.name === provider);
  }
}

const ENV_PLACEHOLDER = /\$\{[^}]+\}/;
const QUALIFIED_MODEL = /^([a-zA-Z][a-zA-Z0-9_-]*)\/(.+)$/;

/**
 * The upstream model id each constructed client was addressed with.
 *
 * `model_used` and the usage records built from it have to name the model the
 * provider was actually asked for. The agent's raw reference is not that id
 * once a gateway-style `vendor/model` reference is in play, and reading the SDK
 * wrapper's own `modelId` couples the recorded value to a third party's
 * internals. A WeakMap keeps the association with the client instance and lets
 * both be collected together.
 */
const resolvedModelIds = new WeakMap<object, string>();

/** The upstream model id a client built by this registry was addressed with. */
export function resolvedModelIdOf(model: unknown): string | undefined {
  return model && typeof model === 'object' ? resolvedModelIds.get(model as object) : undefined;
}

/**
 * Provider types that are a first-party vendor's own API. These three are the
 * hardcoded endpoints `createModelInstance` builds a client for, and each
 * serves only its own model ids — so a namespaced id naming another vendor
 * cannot be served by them.
 *
 * Every other committed provider type (`openai_compatible`, `ollama`, or a
 * custom name) is an endpoint the operator pointed the runtime at, which makes
 * that endpoint the routing authority for a vendor namespace.
 */
const FIRST_PARTY_VENDOR_PROVIDERS: ReadonlySet<string> = new Set([
  'openai',
  'anthropic',
  MINIMAX_PROVIDER,
]);

/**
 * Group providers by wire protocol. `anthropic` speaks the Anthropic Messages
 * API; `openai`, `ollama`, `minimax`, `openai_compatible`, and any custom
 * provider are all handled through the OpenAI-compatible client (see
 * createModelInstance).
 */
function providerFamily(provider: ModelProviderType): 'anthropic' | 'openai' {
  return provider === 'anthropic' ? 'anthropic' : 'openai';
}

/**
 * Split an agent-facing reference into a provider selector and a model id.
 *
 * `provider` is set only when the leading token names a provider this registry
 * actually has; `namespace` records that the reference looked qualified at all,
 * whether or not the token resolved, so the caller can tell
 * `deepseek/deepseek-v4-flash` (a gateway-style model id) from a bare
 * `gpt-4o`.
 */
function parseModelReference(
  name: string,
  isProviderToken: (token: string) => boolean,
): { provider?: ModelProviderType; model: string; namespace?: string } {
  const trimmed = name.trim();
  const match = QUALIFIED_MODEL.exec(trimmed);
  if (!match) return { model: trimmed };
  if (!isProviderToken(match[1])) return { model: trimmed, namespace: match[1] };
  return { provider: match[1], model: match[2], namespace: match[1] };
}

/**
 * The reason a qualified reference cannot be served, or undefined when it can
 * be forwarded verbatim.
 *
 * An unregistered leading token is normally part of a gateway-style model id,
 * and forwarding the whole thing to the configured endpoint is the only reading
 * that works for an OpenAI-compatible router. It is refused in exactly one
 * situation: the configured endpoint is one of the three first-party vendor
 * APIs and the namespace names the other wire protocol. `api.anthropic.com`
 * cannot serve `openai/gpt-5.5` and `api.openai.com` cannot serve
 * `anthropic/claude-sonnet-4`; sending it anyway answers with an upstream 404
 * that hides the real problem — a provider that was never configured.
 *
 * An `openai_compatible` endpoint (or any other operator-run one) is
 * deliberately never refused here: a router is expected to serve
 * `anthropic/...` alongside `deepseek/...`, and refusing would break exactly
 * the gateway shapes this resolution exists to support.
 */
function unserviceableNamespaceReason(
  namespace: string | undefined,
  defaultProvider: ModelProviderType,
): string | undefined {
  if (!namespace) return undefined;
  if (!FIRST_PARTY_VENDOR_PROVIDERS.has(defaultProvider)) return undefined;
  if (providerFamily(namespace) === providerFamily(defaultProvider)) return undefined;
  return providerFamily(namespace) === 'anthropic'
    ? `Provider "${namespace}" is not configured, and the configured provider "${defaultProvider}" speaks the OpenAI-compatible API rather than the Anthropic Messages API. Configure an Anthropic provider in Settings > Setup, set the workspace model vendor to "openai_compatible" when the endpoint is a router, or reference the model without a vendor namespace.`
    : `Provider "${namespace}" is not configured, and the configured provider "${defaultProvider}" cannot serve an OpenAI-compatible model id. Configure that provider in Settings > Setup, or reference the model without a vendor namespace.`;
}

function configState(value?: string): RuntimeConfigState {
  if (!value) return 'not_set';
  const resolved = resolveEnvVars(value, false);
  // Kept in step with `configState` in `src/core/model/providers.ts`, which
  // answers the same question for the DB-backed provider list, and with
  // `secretState` in `src/core/settings/secrets.ts`: a reference to a variable
  // that is unset *or* empty is a credential no client can use, and the strict
  // path in `createModelFromConfig` refuses both.
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

// ============================================================
// Retry Middleware (Property 14)
// ============================================================

/**
 * Marks an error that surfaced only because the retry policy was exhausted —
 * `runTurn` reads it to publish `retries_exhausted` rather than guessing from
 * the error's own text whether the model was asked more than once.
 */
const RETRIES_EXHAUSTED = Symbol('retriesExhausted');

export function isRetriesExhausted(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as Record<symbol, unknown>)[RETRIES_EXHAUSTED] === true;
}

function markRetriesExhausted(err: unknown): void {
  if (typeof err === 'object' && err !== null) {
    Object.defineProperty(err, RETRIES_EXHAUSTED, { value: true, configurable: true });
  }
}

/**
 * Wrap model generate/stream calls with the retry policy:
 * - network timeout: retry up to 3x, no backoff
 * - rate limit (429): honor Retry-After, up to 3x
 * - server error (5xx) / overloaded (529): exponential backoff, up to 3x
 * - auth (401/403): never retry
 *
 * The optional observer is per model instance — `createModel` is called once
 * per turn, so one observer reports on exactly one turn's retries. The wait
 * itself is abort-aware: a `user.interrupt` during the backoff ends the wait
 * instead of letting a retry land after the turn was asked to stop.
 */
function createRetryMiddleware(policy: RetryPolicy, observer?: RetryObserver): LanguageModelMiddleware {
  // One middleware instance wraps one model for one turn, so calls within that
  // turn share this flag: a success after any scheduled retry is a recovery
  // even when it landed on a different call's first attempt.
  let everRetried = false;
  const runWithRetry = async <T>(fn: () => PromiseLike<T>, signal?: AbortSignal): Promise<T> => {
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? abortError();
      try {
        const result = await fn();
        if (everRetried) {
          everRetried = false;
          observer?.onRetryRecovered();
        }
        return result;
      } catch (err) {
        if (signal?.aborted) throw err;
        const type = policy.classify(err);
        const max = policy.maxRetries(type);
        if (attempt >= max) {
          if (max > 0) {
            markRetriesExhausted(err);
            observer?.onRetryExhausted?.({ attempt, type, error: err });
          }
          throw err;
        }
        const headers = extractHeaders(err);
        const delay = policy.getDelay(type, attempt, headers);
        attempt++;
        everRetried = true;
        observer?.onRetryScheduled({ attempt, delayMs: delay, type, error: err });
        if (delay > 0) await sleep(delay, signal);
      }
    }
  };

  return {
    wrapGenerate: async ({ doGenerate, params }) => runWithRetry(doGenerate, params.abortSignal),
    // Streaming: retry only applies to establishing the stream (the initial
    // call). Once bytes flow, mid-stream failures are surfaced to the caller.
    wrapStream: async ({ doStream, params }) => runWithRetry(doStream, params.abortSignal),
  };
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? abortError());
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
        fetch: createSseCompatFetch(),
      });
      return openai.chat(model);
    }
    case MINIMAX_PROVIDER: {
      const minimax = createOpenAI({
        apiKey: apiKey ?? '',
        baseURL: miniMaxOpenAiBaseUrl({}, baseUrl),
        fetch: createSseCompatFetch(),
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
        fetch: createSseCompatFetch(),
      });
      return openaiCompat.chat(model);
    }
  }
}

// ============================================================
// OpenAI-compatible SSE compatibility layer
// ============================================================

/**
 * Some OpenAI-compatible gateways fragment a single tool call across many
 * SSE deltas and emit `type: ""` (or omit `type`) on most of them, carrying
 * only argument fragments. The AI SDK validates every chunk against the
 * OpenAI wire schema, so the first empty `type` aborts the stream and
 * terminates the session.
 *
 * This fetch wrapper rewrites only that field on the wire (`""`/missing ->
 * `"function"`), leaving every other byte — including argument fragments
 * split across deltas — untouched, so nothing else can be corrupted.
 * Non-SSE responses and already-compliant streams pass through unchanged.
 */
export function createSseCompatFetch(underlying: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await underlying(input, init);
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || !contentType.includes('text/event-stream') || !response.body) {
      return response;
    }
    const body = response.body.pipeThrough(createToolCallTypeSanitizer());
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * Rewrite `tool_calls[].type` from `""`/missing to `"function"` in each SSE
 * `data:` line. Lines that fail to parse or need no change are passed
 * through byte-for-byte.
 */
export function sanitizeSseLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:') || trimmed === 'data: [DONE]') return line;
  const payload = trimmed.slice(5).trim();
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return line; }
  let changed = false;
  for (const choice of (parsed as { choices?: Array<{ delta?: { tool_calls?: Array<{ type?: string }> } }> }).choices ?? []) {
    for (const toolCall of choice.delta?.tool_calls ?? []) {
      if (toolCall.type === '' || toolCall.type === undefined) {
        toolCall.type = 'function';
        changed = true;
      }
    }
  }
  if (!changed) return line;
  return 'data: ' + JSON.stringify(parsed) + '\n';
}

function createToolCallTypeSanitizer(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex + 1);
        buffer = buffer.slice(newlineIndex + 1);
        controller.enqueue(encoder.encode(sanitizeSseLine(line)));
      }
    },
    flush(controller) {
      if (buffer) controller.enqueue(encoder.encode(sanitizeSseLine(buffer)));
    },
  });
}

// ============================================================
// Errors
// ============================================================
//
// `src/model/errors.ts` owns the model-resolution error classes and their codes
// (re-exported at the top of this module). They live in their own file so the
// strategy layer can classify a provider failure by code without importing the
// provider clients.
