/**
 * What to do about a model failure, in the session where it happened.
 *
 * A model failure is a configuration mistake the operator repairs, not a crash,
 * so the useful thing on screen is not the code but the place to go and change
 * something. The runtime already names the variable or the model id in the
 * message; these hints add the destination, which the runtime deliberately does
 * not know (it has no notion of the Console's screens).
 *
 * Only the four codes the runtime classifies as model configuration failures get
 * a hint. Anything else — a sandbox failure, a tool failure — must not be given
 * model advice, so an unknown code returns nothing rather than a generic
 * pointer to model settings.
 */

import type { SessionEvent } from '../types';

/** The code the runtime recorded on a `session.error` event, if there is one. */
export function sessionErrorCode(event: SessionEvent): string | undefined {
  const error = event.metadata?.error;
  if (!error || typeof error !== 'object') return undefined;
  const type = (error as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

const HINTS: Record<string, string> = {
  model_not_found:
    'The provider does not serve this model id. Give the agent a model id this provider offers in Settings > Setup, '
    + 'or point the runtime at a provider that serves it in Settings > Setup.',
  model_provider_not_configured:
    'This workspace has no provider for that model reference. Configure it in Settings > Setup, or reference the '
    + 'model without its vendor prefix.',
  model_config_invalid:
    'The provider configuration cannot be used as stored. The message above names what is missing: set that variable '
    + 'in the environment the runtime was started from, or store the value in the model provider editor under Settings > '
    + 'Advanced and restart the runtime.',
  model_auth_failed:
    'The provider refused the credential. Re-enter the API key in Settings > Setup — and if the stored key is a '
    + '`${VAR}` reference, set that variable in the environment the runtime was started from. A key saved here is '
    + 'picked up at the runtime\'s next start, so restart it before sending the next turn.',
};

/** The repair sentence for a model failure code, or undefined for any other code. */
export function modelErrorHint(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return HINTS[code];
}
