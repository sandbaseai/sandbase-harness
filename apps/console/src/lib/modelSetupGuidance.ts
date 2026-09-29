/**
 * The setup facts a Console needs to guide a model choice.
 *
 * The runtime answers these questions already, but in three different places and
 * two different shapes: the provider's credential state lives in
 * `settings.secret_states` and `runtime.models[].api_key_state`, the agent that
 * has to carry a model id is in `data.agents`, and the update contract lives on
 * `PUT /v1/agents/{id}`. Keeping the derivations here — pure, no fetching —
 * is what lets the Setup page and its tests agree on the wording of "this
 * provider's key is missing" and "this is the model id your vendor is usually
 * addressed with", instead of each surface inventing its own.
 *
 * Nothing here reads `process.env`: the Console cannot see the runtime's
 * environment, so the only trustworthy statement is the one the runtime made
 * (`missing_env`), never a guess made from the browser.
 */

import type { Agent, RuntimeConfigState, RuntimeSettings } from '../types';

const ENV_REFERENCE = /\$\{([^}]+)\}/g;

/** Every `${VAR}` name a configured value references, in order, without repeats. */
export function referencedVariables(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set([...value.matchAll(ENV_REFERENCE)].map((match) => match[1]))];
}

export type SetupModelProvider = {
  vendor: string;
  baseUrl?: string;
  /** What the runtime said about the stored key: set, missing its variable, or absent. */
  keyState: RuntimeConfigState;
  /** Variables the stored key references, whether or not they resolve. */
  keyVariables: string[];
  /** The referenced variables to name when the runtime reports `missing_env`. */
  missingKeyVariables: string[];
};

export function setupModelProvider(settings: RuntimeSettings | null): SetupModelProvider | null {
  if (!settings) return null;
  const model = settings.saved_config.model;
  const keyState = settings.secret_states.model.api_key;
  const keyVariables = referencedVariables(model.api_key);
  return {
    vendor: model.vendor,
    baseUrl: model.base_url,
    keyState,
    keyVariables,
    missingKeyVariables: keyState === 'missing_env' ? keyVariables : [],
  };
}

/**
 * The model id a vendor is usually addressed with.
 *
 * Kept to the ids this project already names elsewhere — `init` writes `gpt-4o`,
 * the docs use `claude-sonnet-4` and `MiniMax-M3`, and the official-SDK example
 * documents DeepSeek as `deepseek-chat` — because a Console that invents an id
 * sends the user to a 404 that reads like their mistake. An arbitrary
 * OpenAI-compatible endpoint gets no suggestion at all: only that endpoint knows
 * its ids, so the field says so instead of guessing.
 */
export function suggestedModelId(vendor: string, baseUrl?: string): string | undefined {
  switch (vendor) {
    case 'openai':
      return 'gpt-4o';
    case 'anthropic':
      return 'claude-sonnet-4';
    case 'minimax':
      return 'MiniMax-M3';
    case 'openai_compatible':
      return /(^|\.)deepseek\.com$/i.test(hostOf(baseUrl)) ? 'deepseek-chat' : undefined;
    default:
      return undefined;
  }
}

function hostOf(baseUrl?: string): string {
  if (!baseUrl) return '';
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return '';
  }
}

export type AgentModelUpdate =
  | { ok: true; body: { model: string; version: number } }
  | { ok: false; error: string };

/**
 * The body for changing exactly one agent's model.
 *
 * `PUT /v1/agents/{id}` is a partial update, so sending `model` alone leaves the
 * system prompt, tools, skills and MCP servers untouched — the alternative, the
 * full YAML round-trip the edit modal does, makes a one-word change carry every
 * other field with it. `version` is the precondition the contract publishes:
 * without it a save applied to a definition the user never saw would silently
 * discard whatever else changed in between.
 */
export function agentModelUpdateBody(agent: Agent, model: string): AgentModelUpdate {
  const trimmed = model.trim();
  if (!trimmed) {
    return { ok: false, error: `Enter the model id ${agent.name} should use.` };
  }
  if (trimmed === agent.model) {
    return { ok: false, error: `${agent.name} already uses ${trimmed}.` };
  }
  return { ok: true, body: { model: trimmed, version: agent.version } };
}

/** The one-line hint under the model field, phrased for what the provider actually knows. */
export function agentModelFieldHint(provider: SetupModelProvider | null): string {
  if (!provider) return 'Agent models are provider-independent; the runtime resolves them once a provider is configured.';
  const suggestion = suggestedModelId(provider.vendor, provider.baseUrl);
  if (provider.vendor === 'openai_compatible') {
    return suggestion
      ? `This endpoint is DeepSeek, so \`${suggestion}\` is the id to use.`
      : 'Use the exact model id this endpoint serves. The runtime forwards it unchanged.';
  }
  return suggestion
    ? `For this provider, that is usually \`${suggestion}\`.`
    : 'Use the exact model id this provider serves.';
}

/**
 * What to say after the provider form saves.
 *
 * The restart is not optional advice. A settings write is recorded as
 * `restart_required: true` / `activation_status: pending` and only becomes the
 * runtime's `effective_config` at the next start, so a turn sent before that
 * restart is still built from the previous provider — measured on a runtime whose
 * saved key was corrected, a turn afterwards still failed with the old
 * `model_config_invalid` and no request left the process. The message therefore
 * names the restart before the remaining step, not after it.
 */
export const providerSavedMessage =
  'Model provider saved. Restart the runtime once to apply it, then set the model each agent below should use.';

/**
 * The note above the agent list while a saved provider is not active yet.
 *
 * `restart_required` is the runtime's own statement that `saved_config` is ahead
 * of `effective_config`, which is exactly the window in which a model id the user
 * just set is correct but the request still goes to the old endpoint. The runtime
 * distinguishes a revision that is merely waiting for the next start
 * (`activation_status: pending`) from one it refused to activate
 * (`failed`, with `activation_errors` naming the offending path), and the two need
 * different advice: a restart applies the first, and only a repair does the
 * second. `activation_status` is read first because a failed activation keeps
 * `restart_required` set, so restarting alone would leave the user where they are.
 */
export function pendingRestartNote(
  restartRequired: boolean | undefined,
  activationStatus?: RuntimeSettings['activation_status'],
): string | undefined {
  if (activationStatus === 'failed') {
    return 'The saved provider could not be activated. Fix the highlighted field in Settings > Advanced → Model provider editor, save, then restart the runtime once.';
  }
  if (!restartRequired) return undefined;
  return 'The saved provider is not active yet. Restart the runtime once, then send the first message.';
}
