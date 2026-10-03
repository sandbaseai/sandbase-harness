/**
 * Model Provider Types
 *
 * Unified interface for model providers (OpenAI, Anthropic, Ollama, vLLM, etc.)
 * All providers are abstracted through the Vercel AI SDK LanguageModel interface.
 */

import type { LanguageModel } from 'ai';

// ============================================================
// Model Provider Interface
// ============================================================

export interface ModelProvider {
  readonly name: string;
  readonly type: ModelProviderType;

  /** Create a Vercel AI SDK-compatible LanguageModel instance */
  createModel(config: ModelConfig): LanguageModel;

  /** Health check — returns false on any error, does not throw */
  healthCheck(): Promise<boolean>;
}

// ============================================================
// Model Configuration
// ============================================================

export type ModelProviderType = 'openai' | 'anthropic' | 'ollama' | 'minimax' | string;

export interface ModelConfig {
  /** Reference name in the model registry */
  name: string;
  /** Provider type */
  provider: ModelProviderType;
  /** Resolved model identifier from an Agent (e.g. 'gpt-4o'). Provider-only configs omit this. */
  model?: string;
  /** API endpoint (supports ${ENV_VAR} syntax) */
  base_url?: string;
  /** Authentication key (supports ${ENV_VAR} syntax) */
  api_key?: string;
  /** Temperature override */
  temperature?: number;
  /** Max tokens override */
  max_tokens?: number;
  /** Provider reasoning effort (for example `max` with DeepSeek V4 Pro). */
  reasoning_effort?: string;
  /** Whether this provider is the default for new agents and templates */
  is_default?: boolean;
}

export type RuntimeConfigState = 'configured' | 'missing_env' | 'not_set';

export interface RuntimeModelInfo {
  name: string;
  provider: string;
  model?: string;
  base_url?: string;
  api_key_state: RuntimeConfigState;
  base_url_state: RuntimeConfigState;
  is_default: boolean;
}

// ============================================================
// Model Registry Types
// ============================================================

export interface ModelRegistryEntry {
  config: ModelConfig;
  provider: ModelProvider;
}

// ============================================================
// Retry Policy (applied in ModelRegistry wrapper)
// ============================================================

export type RetryableErrorType = 'timeout' | 'rate_limit' | 'server_error' | 'overloaded' | 'auth' | 'unknown';

export interface RetryPolicy {
  /** Classify an error for retry decision */
  classify(error: unknown): RetryableErrorType;
  /** Get max retries for an error type */
  maxRetries(type: RetryableErrorType): number;
  /** Get delay before next retry in ms (0 = immediate) */
  getDelay(type: RetryableErrorType, attempt: number, headers?: Headers): number;
}

/**
 * Per-turn view into the retry middleware's decisions. The session layer
 * supplies one for the duration of a single turn so a transient failure shows
 * up on the wire as `session.status_rescheduled` rather than only existing
 * inside the model wrapper. The observer is consulted at scheduling time —
 * after the delay is known — and once more when a retried request succeeds.
 */
export interface RetryObserver {
  onRetryScheduled(info: { attempt: number; delayMs: number; type: RetryableErrorType; error: unknown }): void;
  onRetryRecovered(): void;
  /**
   * Fires once, just before the middleware rethrows a retryable error whose
   * retries ran out — the one place a caller can learn "this failure is the
   * policy giving up" regardless of how the SDK wraps the propagated error.
   */
  onRetryExhausted?(info: { attempt: number; type: RetryableErrorType; error: unknown }): void;
}

/** HTTP statuses the published contract treats as a retryable provider overload. */
const SERVER_ERROR_STATUSES = new Set([500, 502, 503, 504]);
const OVERLOADED_STATUS = 529;

/** HTTP status attached to a provider error (`APICallError.statusCode`). */
function httpStatusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { statusCode?: unknown; status?: unknown };
  const status = typeof record.statusCode === 'number' ? record.statusCode
    : typeof record.status === 'number' ? record.status
    : undefined;
  return status !== undefined && status >= 400 && status < 600 ? status : undefined;
}

function retryAfterDelay(headers?: Headers): number | undefined {
  const retryAfter = headers?.get('retry-after');
  if (!retryAfter) return undefined;
  const seconds = parseInt(retryAfter, 10);
  return isNaN(seconds) ? undefined : seconds * 1000;
}

/**
 * Default retry policy per design.md:
 * - timeout: 3 retries, no backoff
 * - rate limit (429): 3 retries, honor Retry-After header
 * - server_error (500/502/503/504) and overloaded (529): 3 retries,
 *   exponential backoff 1s/2s/4s, honoring Retry-After
 * - auth (401/403): 0 retries (immediate failure)
 * - unknown: 0 retries
 *
 * `statusCode` wins over the message: an error that names a status is what the
 * provider answered, while a message that happens to contain "429" could be
 * quoting anything.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  classify(error: unknown): RetryableErrorType {
    const status = httpStatusOf(error);
    if (status !== undefined) {
      if (status === 429) return 'rate_limit';
      if (status === OVERLOADED_STATUS) return 'overloaded';
      if (SERVER_ERROR_STATUSES.has(status)) return 'server_error';
      if (status === 401 || status === 403) return 'auth';
      return 'unknown';
    }
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('econnreset')) {
        return 'timeout';
      }
      if (msg.includes('429') || msg.includes('rate limit')) {
        return 'rate_limit';
      }
      if (msg.includes('overloaded')) {
        return 'overloaded';
      }
      if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden')) {
        return 'auth';
      }
    }
    return 'unknown';
  },
  maxRetries(type: RetryableErrorType): number {
    switch (type) {
      case 'timeout':
        return 3;
      case 'rate_limit':
        return 3;
      case 'server_error':
        return 3;
      case 'overloaded':
        return 3;
      case 'auth':
        return 0;
      case 'unknown':
        return 0;
    }
  },
  getDelay(type: RetryableErrorType, attempt: number, headers?: Headers): number {
    if (type === 'server_error' || type === 'overloaded') {
      return retryAfterDelay(headers) ?? 1000 * 2 ** attempt;
    }
    if (type === 'rate_limit') {
      const delay = retryAfterDelay(headers);
      if (delay !== undefined) return delay;
    }
    // timeout, and rate_limit with no Retry-After: no backoff (immediate retry)
    return 0;
  },
};
