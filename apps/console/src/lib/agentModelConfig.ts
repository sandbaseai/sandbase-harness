import type { Agent } from '../types';

/**
 * Whether an agent form must write the stored model profile back on save.
 *
 * The server omits `model_config` for the ordinary case — the local `standard`
 * speed with no reasoning effort — and every read projection omits it the same
 * way. A Console form has to make the same decision, because a save replaces the
 * stored profile: `PUT /v1/agents/{id}` deletes `model_config` whenever the body
 * carries `model` without it, and the YAML/JSON forms always carry `model`.
 *
 * `effort` is part of the profile the read returns (accepted and stored, though
 * no provider request carries it). A condition that looked only at `speed` would
 * therefore drop a level the operator never touched — an agent reading
 * `{speed: "standard", effort: "high"}` would be saved back as a plain model id.
 * Keeping the rule in one place is what stops the two modals from drifting from
 * the server's projection.
 */
export function sendsModelConfig(config: Agent['model_config'] | undefined): boolean {
  if (!config) return false;
  return config.speed !== 'standard' || Boolean(config.effort);
}
