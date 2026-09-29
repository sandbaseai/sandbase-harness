/**
 * Sandbox naming boundary.
 *
 * Three vocabularies exist for the same backends and all three are load-bearing:
 *
 * - Registry / Environment: `SandboxProviderType` — `local`, `docker`,
 *   `kubernetes`, `self_hosted`. This is what providers register under and
 *   what an Environment's `sandbox_provider` names.
 * - Settings V2: `RuntimeSettings['sandbox']['provider']` — `local`, `docker`,
 *   `kubernetes`, `remote`. This is persisted inside `runtime_settings.config`,
 *   so its accepted values cannot be renamed without a data migration.
 * - Environment `hosting_type`: `local`, `docker`, `kubernetes`, `cloud`,
 *   `self_hosted`. It mixes ownership (`cloud` is the official spelling for
 *   hosting on machines this runtime does not own, and no backend here can
 *   serve it) with materialization (`docker`, `kubernetes`), so it is
 *   translated rather than interpreted at each call site. The published CMA
 *   spells this same axis `config.type`, so both spellings are read through
 *   {@link readDeclaredHostingType} — one place, one vocabulary, and a config
 *   that declares them inconsistently is refused instead of resolved.
 *
 * The only provider difference between the first two is the self-hosted worker,
 * which Settings V2 spells `remote`. Every direction of every alias lives here
 * so the translation cannot drift: it used to be reimplemented once per call
 * site, and those copies mapped every unrecognized value to `local` — quietly
 * turning an unavailable isolated backend, or an Environment record this build
 * cannot read, into unsandboxed local execution.
 *
 * Resolution never substitutes a backend. An Environment that declares nothing
 * gets {@link DEFAULT_SANDBOX_PROVIDER}; an Environment that declares something
 * this runtime cannot serve is refused with {@link EnvironmentConfigError}.
 */

import type { SandboxProviderType } from '@/types/sandbox.js';

/** Settings V2 sandbox provider ids. Mirrors the zod enum in core/settings/schema. */
export type SandboxSettingProvider = 'local' | 'docker' | 'kubernetes' | 'remote';

const SETTING_PROVIDERS: readonly SandboxSettingProvider[] = [
  'local',
  'docker',
  'kubernetes',
  'remote',
];

/**
 * Registry type → Settings V2 id.
 *
 * Returns `undefined` for a backend Settings V2 has no id for, so callers
 * report an unusable selection rather than substituting a different backend.
 */
export function sandboxSettingForProvider(type: string): SandboxSettingProvider | undefined {
  if (type === 'self_hosted' || type === 'remote') return 'remote';
  return SETTING_PROVIDERS.find((provider) => provider === type);
}

/** Settings V2 id → registry type. */
export function sandboxProviderForSettings(provider: SandboxSettingProvider): SandboxProviderType {
  return provider === 'remote' ? 'self_hosted' : provider;
}

// ---------------------------------------------------------------------------
// Environment `hosting_type`
// ---------------------------------------------------------------------------

/**
 * The `hosting_type` vocabulary an Environment may declare.
 *
 * `cloud` is kept readable because existing rows and the official CMA shape use
 * it. No backend in this runtime can serve it, so it resolves to a refusal
 * rather than to another backend.
 */
export const ENVIRONMENT_HOSTING_TYPES = [
  'local',
  'docker',
  'kubernetes',
  'cloud',
  'self_hosted',
] as const;

export type EnvironmentHostingType = (typeof ENVIRONMENT_HOSTING_TYPES)[number];

/**
 * The two spellings of the hosting axis, in projection order.
 *
 * `hosting_type` is what this runtime's own Console, SDK, and CLI write. `type`
 * is the published CMA spelling inside `config`
 * (`config: { type: "cloud" | "self_hosted" }`, the official quickstart shape).
 * They name one vocabulary, so they are read together rather than one of them
 * being ignored: measured against the official TypeScript SDK at `0.129.0`,
 * `config: { type: "self_hosted" }` used to be accepted and reported back as
 * `hosting_type: "local"` while `config: { type: "cloud" }` was accepted
 * outright.
 */
export const ENVIRONMENT_HOSTING_FIELDS = ['hosting_type', 'type'] as const;

export type EnvironmentHostingField = (typeof ENVIRONMENT_HOSTING_FIELDS)[number];

/**
 * The hosting type a config declares, or why its declaration cannot be read.
 *
 * A reason is returned rather than thrown so the write path can answer 400 with
 * the same words the resolution path throws: one config must not produce two
 * different explanations depending on which caller reads it.
 */
export type DeclaredHostingDeclaration =
  | { ok: true; value?: string }
  | { ok: false; code: EnvironmentConfigErrorCode; message: string };

/**
 * Read `hosting_type` and the published `type` as one declaration.
 *
 * `undefined`, `null`, and an empty string mean "not declared" in either
 * spelling. Two spellings that disagree are refused rather than resolved by
 * precedence: the runtime cannot know which one the caller meant, and picking
 * one would run the session somewhere the other spelling did not ask for.
 */
export function readDeclaredHostingType(
  config: Record<string, unknown>,
  context: string,
): DeclaredHostingDeclaration {
  const declared: Array<{ field: EnvironmentHostingField; value: string }> = [];
  for (const field of ENVIRONMENT_HOSTING_FIELDS) {
    const value = config[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      return {
        ok: false,
        code: ENVIRONMENT_CONFIG_ERROR_CODES.invalidConfig,
        message: `${context} declares ${field} as `
          + `${Array.isArray(value) ? 'an array' : typeof value}, which cannot name a hosting type.`,
      };
    }
    if (value.trim()) declared.push({ field, value: value.trim() });
  }

  if (declared.length === 0) return { ok: true };
  const [first, ...rest] = declared;
  const disagreement = rest.find((entry) => entry.value !== first.value);
  if (disagreement) {
    return {
      ok: false,
      code: ENVIRONMENT_CONFIG_ERROR_CODES.invalidConfig,
      message: `${context} declares ${first.field} "${first.value}" and ${disagreement.field} `
        + `"${disagreement.value}", two spellings of one hosting type that disagree. `
        + 'Declare the hosting type once, or make both spellings name the same one.',
    };
  }
  return { ok: true, value: first.value };
}

/**
 * Reported as an Environment's `hosting_type` when its stored config cannot be
 * read at all.
 *
 * A projection has to say something, and the one thing it must not say is
 * `local`: an operator who reads `local`, edits the Environment, and saves it
 * would rewrite an unreadable record into local execution. This value is
 * deliberately unservable, so writing it back is refused and the record has to
 * be repaired instead — the runtime refuses to execute such an Environment
 * either way.
 */
export const UNREADABLE_HOSTING_TYPE = 'unknown';

/**
 * Hosting values that name a backend this runtime can actually run.
 *
 * `self_hosted` keeps its public spelling: it is the official value for a
 * machine the caller owns, and the self-hosted worker is the backend for it.
 */
const EXECUTABLE_HOSTING_PROVIDERS: Readonly<Record<string, SandboxProviderType>> = {
  local: 'local',
  docker: 'docker',
  kubernetes: 'kubernetes',
  self_hosted: 'self_hosted',
};

/**
 * Backend an Environment that declares no backend at all resolves to.
 *
 * A default is only correct for "nothing was declared". An unreadable or
 * unsupported declaration is refused instead — see
 * {@link sandboxProviderForEnvironmentConfig}.
 */
export const DEFAULT_SANDBOX_PROVIDER: SandboxProviderType = 'local';

export const ENVIRONMENT_CONFIG_ERROR_CODES = {
  /** The stored `environments.config` could not be read as a JSON object. */
  invalidConfig: 'invalid_environment_config',
  /** `hosting_type` names hosting this runtime has no execution backend for. */
  unsupportedHostingType: 'unsupported_hosting_type',
  /** A declared backend that no settings-level workspace default can name. */
  unresolvableSandboxProvider: 'unresolvable_sandbox_provider',
} as const;

export type EnvironmentConfigErrorCode =
  (typeof ENVIRONMENT_CONFIG_ERROR_CODES)[keyof typeof ENVIRONMENT_CONFIG_ERROR_CODES];

/**
 * An Environment that cannot be resolved to an execution backend.
 *
 * Thrown instead of substituting a backend. "Asked for an isolated sandbox and
 * got an unsandboxed host subprocess" is a security regression rather than a
 * degraded experience, and a stored record the operator cannot read must not
 * decide where code runs either.
 */
export class EnvironmentConfigError extends Error {
  constructor(
    readonly code: EnvironmentConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EnvironmentConfigError';
  }
}

export function isEnvironmentConfigError(error: unknown): error is EnvironmentConfigError {
  return error instanceof EnvironmentConfigError;
}

/**
 * Read an Environment's stored config, refusing anything unreadable.
 *
 * A config this build cannot parse used to normalize to `{}` and therefore to
 * the local backend, which is why a damaged row silently downgraded execution.
 */
export function parseEnvironmentConfig(config: string, context: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch (error) {
    throw new EnvironmentConfigError(
      ENVIRONMENT_CONFIG_ERROR_CODES.invalidConfig,
      `${context} has a config that is not valid JSON `
        + `(${error instanceof Error ? error.message : 'unparseable'}). Repair the Environment before `
        + 'running sessions on it; the runtime will not substitute a local backend.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EnvironmentConfigError(
      ENVIRONMENT_CONFIG_ERROR_CODES.invalidConfig,
      `${context} config must be a JSON object.`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Translate a declared `hosting_type` into the backend that serves it.
 *
 * `cloud` is refused explicitly. It names hosting on infrastructure the runtime
 * operator does not own; this runtime ships no such backend, so honoring the
 * value could only mean running somewhere the caller did not choose.
 */
export function sandboxProviderForHostingType(
  hostingType: string,
  context: string,
): SandboxProviderType {
  const provider = EXECUTABLE_HOSTING_PROVIDERS[hostingType];
  if (provider) return provider;
  throw new EnvironmentConfigError(
    ENVIRONMENT_CONFIG_ERROR_CODES.unsupportedHostingType,
    `${context} ${hostingTypeRefusal(hostingType)}`,
  );
}

/**
 * Why a declared `hosting_type` cannot be served.
 *
 * Shared by the write path (refusing the value before it is stored) and the
 * resolution path (refusing a row that already holds it), so a caller cannot
 * read two different reasons for the same value.
 */
export function hostingTypeRefusal(hostingType: string): string {
  if (hostingType === 'cloud') {
    return 'hosting_type "cloud" is not supported: this runtime has no cloud execution backend. '
      + `Use one of: ${Object.keys(EXECUTABLE_HOSTING_PROVIDERS).join(', ')}.`;
  }
  return `hosting_type "${hostingType}" is not a known hosting type `
    + `(known: ${ENVIRONMENT_HOSTING_TYPES.join(', ')}). `
    + `This runtime can execute: ${Object.keys(EXECUTABLE_HOSTING_PROVIDERS).join(', ')}.`;
}

/**
 * Resolve the backend an Environment's stored config names.
 *
 * `sandbox_provider` wins when present and is preserved verbatim: availability
 * is the sandbox registry's call, so an out-of-tree provider name still reaches
 * the registry, which reports the backends it actually has. A config that
 * declares only a hosting type — either spelling — is translated, and a config
 * that declares neither gets {@link DEFAULT_SANDBOX_PROVIDER}.
 *
 * A declaration that is present but is not a name — a number, an object — is
 * refused like any other unreadable config, and so is a pair of spellings that
 * disagree. Treating either as absent is what made a damaged record resolve to
 * `local`.
 */
export function sandboxProviderForEnvironmentConfig(
  config: Record<string, unknown>,
  context: string,
): SandboxProviderType {
  const declaredProvider = declaredName(config.sandbox_provider, 'sandbox_provider', context);
  if (declaredProvider) return declaredProvider;
  const declaredHosting = readDeclaredHostingType(config, context);
  if (!declaredHosting.ok) throw new EnvironmentConfigError(declaredHosting.code, declaredHosting.message);
  return declaredHosting.value
    ? sandboxProviderForHostingType(declaredHosting.value, context)
    : DEFAULT_SANDBOX_PROVIDER;
}

/**
 * The public `hosting_type` projection for an Environment.
 *
 * A declared hosting type is echoed, in either spelling — the published `type`
 * is reported as the local `hosting_type` so a caller of the official shape
 * reads back the hosting it asked for instead of the `local` default. Otherwise
 * the declared backend names the same thing — reporting `kubernetes` as `cloud`
 * described hosting this runtime does not have — and a config that declares
 * neither is reported as the backend it resolves to. A value this runtime does
 * not recognize is echoed verbatim rather than replaced, so a stored record is
 * never displayed as a backend it did not name, and a declaration that is not a
 * name at all — or two spellings that disagree, which the resolution path
 * refuses — is reported as {@link UNREADABLE_HOSTING_TYPE} rather than as a
 * backend a session on this record would not use.
 */
export function environmentHostingProjection(config: Record<string, unknown>): string {
  // Read through the same function resolution uses, so a record cannot be
  // reported as runnable and refused when a session is created on it.
  const declared = readDeclaredHostingType(config, 'Environment');
  if (!declared.ok) return UNREADABLE_HOSTING_TYPE;
  if (declared.value) return declared.value;
  const provider = config.sandbox_provider;
  if (provider === undefined || provider === null) return DEFAULT_SANDBOX_PROVIDER;
  if (typeof provider !== 'string') return UNREADABLE_HOSTING_TYPE;
  return provider.trim() || DEFAULT_SANDBOX_PROVIDER;
}

/**
 * Whether a declared `hosting_type` can be served, reported as the API's
 * write-time refusal message instead of a throw.
 *
 * Both vocabularies are validated at write time because a value unusable in
 * either one used to be accepted here and only fail — or silently run locally —
 * when a session booted.
 */
export function hostingTypeError(hostingType: string): string | undefined {
  return EXECUTABLE_HOSTING_PROVIDERS[hostingType] ? undefined : hostingTypeRefusal(hostingType);
}

/**
 * The workspace default backend an Environment names, as a Settings V2 id.
 *
 * Settings V2 can only name the backends its schema has ids for, so a declared
 * backend outside that set cannot become the workspace default. Returning
 * `local` for it is what previously turned an unrecognized default into
 * unsandboxed execution; this refuses instead.
 */
export function workspaceDefaultSettingForEnvironmentConfig(
  config: Record<string, unknown>,
  context: string,
): SandboxSettingProvider {
  const provider = sandboxProviderForEnvironmentConfig(config, context);
  const setting = sandboxSettingForProvider(provider);
  if (setting) return setting;
  throw new EnvironmentConfigError(
    ENVIRONMENT_CONFIG_ERROR_CODES.unresolvableSandboxProvider,
    `${context} names sandbox_provider "${provider}", which cannot be the workspace default backend. `
      + `Use one of: ${Object.keys(EXECUTABLE_HOSTING_PROVIDERS).join(', ')}.`,
  );
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Read a declared backend or hosting name, refusing a declaration that is not a
 * name.
 *
 * `undefined`/`null` and an empty string mean "not declared" — how a client
 * clears a field — while a number or an object cannot name a backend and is a
 * damaged record, not an absent one.
 */
function declaredName(value: unknown, key: string, context: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new EnvironmentConfigError(
      ENVIRONMENT_CONFIG_ERROR_CODES.invalidConfig,
      `${context} declares ${key} as ${Array.isArray(value) ? 'an array' : typeof value}, `
        + 'which cannot name an execution backend.',
    );
  }
  return nonEmptyString(value);
}
