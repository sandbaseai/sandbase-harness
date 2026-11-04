import { APICallError } from 'ai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { Database } from '@/core/db/database.js';
import { ModelRegistry } from '@/model/registry.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '@/types/model.js';
import { validateRuntimeSettings, validateRuntimeSettingsCredentials } from './schema.js';
import { hasRuntimeSettingsSecret, modelConfigFromRuntimeSettings, type RuntimeSettingsRecord } from './store.js';

export const MODEL_CONNECTION_TIMEOUT_MS = 20_000;
export const MODEL_CONNECTION_MAX_TOKENS = 32;

export type ModelConnectionCode =
  | 'ok' | 'configuration_invalid' | 'authentication_failed' | 'model_not_found'
  | 'not_found' | 'timeout' | 'cancelled' | 'rate_limited' | 'network_error' | 'invalid_response' | 'provider_error';

export interface ModelConnectionResult {
  ok: boolean;
  outcome: ModelConnectionCode;
  model: string;
  resolved_model?: string;
  provider: string;
  config_source: 'saved';
  revision: number;
  elapsed_ms: number;
  http_status?: number;
}

/** A single diagnostic request, outside the session/usage lifecycle. Never return upstream data. */
export async function testModelConnection(params: {
  db: Database;
  dataDir?: string;
  settings: RuntimeSettingsRecord;
  model: string;
  signal?: AbortSignal;
}): Promise<ModelConnectionResult> {
  const started = performance.now();
  const { db, dataDir, settings, model: reference } = params;
  const config = settings.saved_config;
  let resolvedModel: string | undefined;
  const result = (code: ModelConnectionCode, httpStatus?: number): ModelConnectionResult => ({
    ok: code === 'ok', outcome: code, model: reference,
    ...(resolvedModel ? { resolved_model: resolvedModel } : {}),
    provider: config.model.vendor, config_source: 'saved', revision: settings.revision,
    elapsed_ms: Math.round(performance.now() - started),
    ...(httpStatus !== undefined && httpStatus >= 400 && httpStatus < 600 ? { http_status: httpStatus } : {}),
  });

  // Validate only model readiness: an unrelated adapter may still await repair.
  const issues = [
    ...validateRuntimeSettings(config).errors,
    ...validateRuntimeSettingsCredentials(config, (path) => hasRuntimeSettingsSecret(db, path)),
  ];
  if (config.model.api_key === '********'
    || issues.some((issue) => issue.path === 'model' || issue.path.startsWith('model.'))) {
    return result('configuration_invalid');
  }

  let client: ReturnType<ModelRegistry['createModelFromConfig']>;
  try {
    const noRetryPolicy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, maxRetries: () => 0 };
    const registry = new ModelRegistry(noRetryPolicy);
    const configured = modelConfigFromRuntimeSettings(db, config, dataDir);
    registry.register(configured);
    const resolved = registry.resolveModelConfig(reference);
    if (resolved.provider !== configured.provider) return result('configuration_invalid');
    resolvedModel = resolved.model;
    client = registry.createModelFromConfig(resolved, { retryObserver: undefined }) as LanguageModelV4;
  } catch {
    // Includes missing/empty env variables and failed secret decryption. Messages
    // can contain credential values or URLs, so diagnostics use fixed codes only.
    return result('configuration_invalid');
  }

  const deadline = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; deadline.abort(); }, MODEL_CONNECTION_TIMEOUT_MS);
  const signal = params.signal ? AbortSignal.any([deadline.signal, params.signal]) : deadline.signal;
  try {
    signal.throwIfAborted();
    // Call the same SDK adapter directly: no generateText retry/step loop or
    // automatic warning logging that could include untrusted provider output.
    const response = await client.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }],
      maxOutputTokens: MODEL_CONNECTION_MAX_TOKENS,
      abortSignal: signal,
    });
    signal.throwIfAborted();
    const hasOutput = response.content.some((part) => (
      (part.type === 'text' || part.type === 'reasoning') && part.text.trim().length > 0
    ));
    return result(hasOutput ? 'ok' : 'invalid_response');
  } catch (error) {
    if (timedOut) return result('timeout');
    if (signal.aborted) return result('cancelled');
    if (APICallError.isInstance(error)) {
      const status = error.statusCode;
      if (status === 401 || status === 403) return result('authentication_failed', status);
      if (status === 408 || status === 504) return result('timeout', status);
      if (status === 429) return result('rate_limited', status);
      // A 404 can mean a bad base URL. Only an explicit model code identifies
      // a missing model; never guess from an upstream message or echo it back.
      if (isMissingModel(error.data)) return result('model_not_found', status);
      if (status === 404) return result('not_found', status);
      if (status !== undefined) return result(status < 400 ? 'invalid_response' : 'provider_error', status);
      return result('network_error');
    }
    // SDK/provider parse exceptions can carry the complete upstream response body.
    // Keep only the already-classified HTTP status and never return or log causes.
    if (error instanceof Error && error.message === 'Invalid JSON response') {
      const status = statusFromCause(error.cause);
      return result('invalid_response', status);
    }
    if (isTransportError(error)) return result('network_error');
    return result('invalid_response');
  } finally {
    clearTimeout(timer);
  }
}

function statusFromCause(error: unknown): number | undefined {
  if (!APICallError.isInstance(error)) return undefined;
  const status = error.statusCode;
  return status !== undefined && status >= 400 && status < 600 ? status : undefined;
}

function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'TypeError'
    || error.name === 'FetchError'
    || (typeof error.cause === 'object' && error.cause !== null && 'code' in error.cause);
}

function isMissingModel(data: unknown): boolean {
  if (!data || typeof data !== 'object' || !('error' in data)) return false;
  const detail = data.error;
  if (!detail || typeof detail !== 'object') return false;
  return ('code' in detail && detail.code === 'model_not_found')
    || ('type' in detail && detail.type === 'model_not_found');
}
