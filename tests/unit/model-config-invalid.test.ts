/**
 * The model configuration failure.
 *
 * `model_config_invalid` means the provider configuration itself is unusable —
 * there is no concrete model id — which is a mistake the operator can repair
 * rather than a broken runtime. The contract that follows from that is not the
 * wording of the message but the *resumability*: a turn failing this way must
 * leave the session resumable, because terminating a session over a repairable
 * configuration mistake is the failure the resumable set exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import {
  MODEL_CONFIG_INVALID_CODE,
  ModelConfigInvalidError,
  ModelCredentialUnresolvedError,
  ModelResolutionError,
  RESUMABLE_MODEL_FAILURE_CODES,
} from '@/model/errors.js';

describe('model_config_invalid', () => {
  it('is the code the resolution error carries', () => {
    const error = new ModelConfigInvalidError('missing-model', ['available-model'], 'no concrete model id');

    expect(error).toBeInstanceOf(ModelResolutionError);
    expect(error.code).toBe(MODEL_CONFIG_INVALID_CODE);
    expect(error.code).toBe('model_config_invalid');
  });

  it('is resumable, so a repairable configuration mistake does not end the session', () => {
    // The wire spelling is asserted as well as the constant: callers and the
    // session manager both match on the string, so the constant alone would not
    // pin what actually travels.
    expect(RESUMABLE_MODEL_FAILURE_CODES.has('model_config_invalid')).toBe(true);
    expect(RESUMABLE_MODEL_FAILURE_CODES.has(MODEL_CONFIG_INVALID_CODE)).toBe(true);
  });

  it('says which model was requested and what was available instead', () => {
    const error = new ModelConfigInvalidError('missing-model', ['available-model'], 'no concrete model id');

    expect(error.message).toContain('missing-model');
    expect(error.message).toContain('available-model');
  });

  it('covers an unresolved environment reference, so that mistake is resumable too', () => {
    // An unset `${VAR}` in a provider's credential is the same kind of mistake —
    // the configuration is unusable and the operator can repair it — so it
    // carries the same code instead of a new one, and inherits both the
    // resumability above and the `not_retryable` disposition a client sees.
    const error = new ModelCredentialUnresolvedError('openai', 'api_key', 'OPENAI_API_KEY');

    expect(error).toBeInstanceOf(ModelResolutionError);
    expect(error.code).toBe(MODEL_CONFIG_INVALID_CODE);
    expect(RESUMABLE_MODEL_FAILURE_CODES.has(error.code)).toBe(true);
    expect(error.message).toContain('OPENAI_API_KEY');
    expect(error.message).not.toContain('Model not found');
  });
});
