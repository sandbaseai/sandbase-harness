/**
 * Model resolution errors.
 *
 * These are the model-resolution codes only, not a general error taxonomy: they
 * name the configuration outcomes a caller has to be able to tell apart, plus
 * the authentication refusal a provider returns once a request has been made.
 * Every one of them used to surface as `internal_error`, which reads as a
 * runtime crash and points an operator at the wrong layer.
 *
 * The code travels on the error's `code` property, which `SessionManager`
 * already projects into `session.error.type` and classifies for
 * `retry_status` — so a code added here is visible to a client without a new
 * carrier.
 */

/** The requested model id is not available on the configured provider. */
export const MODEL_NOT_FOUND_CODE = 'model_not_found';

/** The reference names a provider that this workspace has not configured. */
export const MODEL_PROVIDER_NOT_CONFIGURED_CODE = 'model_provider_not_configured';

/** The provider configuration itself is unusable (no concrete model id). */
export const MODEL_CONFIG_INVALID_CODE = 'model_config_invalid';

/** The provider refused the request's credentials (HTTP 401/403). */
export const MODEL_AUTH_FAILED_CODE = 'model_auth_failed';

export type ModelErrorCode =
  | typeof MODEL_NOT_FOUND_CODE
  | typeof MODEL_PROVIDER_NOT_CONFIGURED_CODE
  | typeof MODEL_CONFIG_INVALID_CODE
  | typeof MODEL_AUTH_FAILED_CODE;

/**
 * Codes whose cause is a fixable configuration mistake rather than a broken
 * runtime. A turn that fails with one of these leaves the session resumable:
 * the operator corrects the provider or the agent's model and sends the next
 * event, instead of the runtime publishing `session.status_terminated` for a
 * mistake the caller can repair.
 */
export const RESUMABLE_MODEL_FAILURE_CODES: ReadonlySet<string> = new Set([
  MODEL_NOT_FOUND_CODE,
  MODEL_PROVIDER_NOT_CONFIGURED_CODE,
  MODEL_CONFIG_INVALID_CODE,
  MODEL_AUTH_FAILED_CODE,
]);

export class ModelResolutionError extends Error {
  constructor(
    public readonly code: ModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelResolutionError';
  }
}

/**
 * The shared message shape. Kept in one place so every resolution failure ends
 * with the same actionable list of what this workspace does have registered.
 */
function resolutionMessage(modelName: string, available: string[], detail?: string): string {
  const suggestion = available.length > 0
    ? `Available models: ${available.join(', ')}`
    : 'No models registered. Add a model provider in Dashboard Settings > Setup';
  return `Model not found: "${modelName}". ${detail ? `${detail} ` : ''}${suggestion}`;
}

export class ModelNotFoundError extends ModelResolutionError {
  constructor(
    public readonly modelName: string,
    public readonly available: string[],
    detail?: string,
  ) {
    super(MODEL_NOT_FOUND_CODE, resolutionMessage(modelName, available, detail));
    this.name = 'ModelNotFoundError';
  }
}

export class ModelProviderNotConfiguredError extends ModelResolutionError {
  constructor(
    public readonly modelName: string,
    public readonly available: string[],
    detail: string,
  ) {
    super(MODEL_PROVIDER_NOT_CONFIGURED_CODE, resolutionMessage(modelName, available, detail));
    this.name = 'ModelProviderNotConfiguredError';
  }
}

export class ModelConfigInvalidError extends ModelResolutionError {
  constructor(
    public readonly modelName: string,
    public readonly available: string[],
    detail: string,
  ) {
    super(MODEL_CONFIG_INVALID_CODE, resolutionMessage(modelName, available, detail));
    this.name = 'ModelConfigInvalidError';
  }
}

/**
 * A provider's credential or endpoint is written as `${VAR}` and that variable
 * cannot supply a value: it is not set in the runtime's environment, or it is set
 * to the empty string.
 *
 * This is a configuration mistake, so it carries {@link MODEL_CONFIG_INVALID_CODE}
 * rather than a code of its own: the session is left resumable, the request is
 * classified `not_retryable`, and a Console that already knows how to render
 * `model_config_invalid` needs no new case. What it adds over the generic message
 * is the two facts an operator cannot guess from a provider's 401 — which
 * variable is missing, and which field of which provider references it — plus the
 * fixes that actually apply.
 *
 * The empty case is the same mistake wearing a subtler face: `api_key: ${KEY}`
 * with `KEY=""` resolves, so a client built from it would send an empty
 * credential and the provider's 401 would name nothing. The settings layer
 * already treats that value as `missing_env` (`src/core/settings/schema.ts`), and
 * the strict path here has to agree with it or the Console would report a state
 * the runtime does not act on.
 *
 * The message deliberately does not use the shared `Model not found:` prefix. The
 * model is not the problem here; sending the caller to look at the model id would
 * be the same misdirection this error exists to remove.
 */
export class ModelCredentialUnresolvedError extends ModelResolutionError {
  constructor(
    public readonly provider: string,
    public readonly field: 'api_key' | 'base_url',
    public readonly variable: string,
    /** True when the variable exists but is empty, so the message can say which. */
    emptyValue = false,
  ) {
    const state = emptyValue
      ? `is set to an empty value in the runtime's environment`
      : `is not set in the runtime's environment`;
    const fix = field === 'api_key'
      ? `Set ${variable} in the environment the runtime was started from, paste a literal key in Dashboard Settings > Setup, or remove the reference from the provider configuration.`
      : `Set ${variable} in the environment the runtime was started from, write the endpoint literally in the model provider editor under Dashboard Settings > Advanced, or remove the reference from the provider configuration.`;
    super(
      MODEL_CONFIG_INVALID_CODE,
      `Provider "${provider}" takes its ${field} from environment variable ${variable}, which ${state}. ${fix}`,
    );
    this.name = 'ModelCredentialUnresolvedError';
  }
}
