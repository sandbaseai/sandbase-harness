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

export type RetryableErrorType = 'timeout' | 'rate_limit' | 'auth' | 'unknown';

export interface RetryPolicy {
  /** Classify an error for retry decision */
  classify(error: unknown): RetryableErrorType;
  /** Get max retries for an error type */
  maxRetries(type: RetryableErrorType): number;
  /** Get delay before next retry in ms (0 = immediate) */
  getDelay(type: RetryableErrorType, attempt: number, headers?: Headers): number;
}

/**
 * Default retry policy per design.md:
 * - timeout: 3 retries, no backoff
 * - rate_limit: 3 retries, honor Retry-After header
 * - auth (401/403): 0 retries (immediate failure)
 * - unknown: 0 retries
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  classify(error: unknown): RetryableErrorType {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('econnreset')) {
        return 'timeout';
      }
      if (msg.includes('429') || msg.includes('rate limit')) {
        return 'rate_limit';
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
      case 'auth':
        return 0;
      case 'unknown':
        return 0;
    }
  },
  getDelay(type: RetryableErrorType, _attempt: number, headers?: Headers): number {
    if (type === 'rate_limit' && headers) {
      const retryAfter = headers.get('retry-after');
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) return seconds * 1000;
      }
    }
    // timeout: no backoff (immediate retry)
    return 0;
  },
};
