/**
 * Canonical credential wire profile (CMA vaults and credentials).
 *
 * The published contract nests everything under `auth`, with one shape per
 * credential kind, and marks specific values write-only. The local runtime
 * stores a flat record, so this module is the adapter layer: it owns the
 * translation in both directions and the rules that make the translation
 * honest.
 *
 * Rules implemented:
 * - A vault carries `display_name` and optional `metadata`; `name` is the
 *   local legacy alias and is accepted on write, normalized to `display_name`.
 * - `auth.type` selects the shape: `mcp_oauth`, `static_bearer`,
 *   `environment_variable`.
 * - `mcp_oauth` / `static_bearer` are keyed by `mcp_server_url`, which must be
 *   a URL. MCP credentials are matched to a declared MCP server by URL.
 * - `environment_variable` is keyed by `secret_name` (the variable name) and
 *   carries `networking` plus `injection_location`.
 * - Write-only fields — `token`, `access_token`, `refresh_token`,
 *   `client_secret`, `secret_value` — are never echoed. The runtime stores a
 *   hint, not the value.
 * - Structural fields (`mcp_server_url`, `secret_name`, `token_endpoint`,
 *   `client_id`) are locked after creation. Changing them requires archiving
 *   the credential and creating a new one, so a credential's identity cannot
 *   drift underneath a running session.
 *
 * OAuth refresh is deliberately NOT implemented: there is no refresh loop, no
 * refresh-failure event, and no validate endpoint. Treating `refresh` as
 * accepted while never refreshing would mean a session keeps using an expired
 * access token and reports nothing, so `refresh` is parsed and then reported
 * as unsupported rather than silently stored.
 */

import { z } from 'zod';

/** Credential kinds, matching the published `auth.type` values. */
export const CANONICAL_CREDENTIAL_TYPES = ['mcp_oauth', 'static_bearer', 'environment_variable'] as const;
export type CanonicalCredentialType = (typeof CANONICAL_CREDENTIAL_TYPES)[number];

/** Local legacy `auth_type` values, kept working during migration. */
export const LEGACY_CREDENTIAL_TYPES = ['mcp_oauth', 'bearer_token', 'environment_variable'] as const;
export type LegacyCredentialType = (typeof LEGACY_CREDENTIAL_TYPES)[number];

/**
 * Fields that carry secret material. They are accepted on write and never
 * included in a response.
 */
export const WRITE_ONLY_CREDENTIAL_FIELDS = [
  'token',
  'access_token',
  'refresh_token',
  'client_secret',
  'secret_value',
] as const;

/**
 * Fields that define a credential's identity. After creation these are locked:
 * an update that changes one is refused rather than applied, because a
 * credential that silently repoints at a different server or variable is a
 * different credential wearing the same ID.
 */
export const LOCKED_CREDENTIAL_FIELDS = [
  'mcp_server_url',
  'secret_name',
  'token_endpoint',
  'client_id',
] as const;

/** How the secret is injected into outbound requests. */
export interface CredentialInjectionLocation {
  header: boolean;
  body: boolean;
}

/**
 * Resolve `injection_location` for a credential payload.
 *
 * The published behaviour differs between create and update, and neither
 * direction may be guessed:
 * - Omitting the field entirely enables BOTH locations. This is the one case
 *   where the resolved value is true/true rather than false-filled.
 * - Supplying the object with omitted fields fills them with `false`, so
 *   `{header: true}` means header-only.
 * - Supplying an explicit `null` for the object or for either field is a 400,
 *   not a request to use the default.
 * - A resolved pair with both locations disabled is a 400: a credential that
 *   injects nowhere is indistinguishable from one that never applies.
 */
export type InjectionLocationResult =
  | { ok: true; value: CredentialInjectionLocation }
  | { ok: false; message: string };

export function resolveInjectionLocation(value: unknown): InjectionLocationResult {
  if (value === undefined) return { ok: true, value: { header: true, body: true } };
  if (value === null) {
    return { ok: false, message: 'injection_location must not be null; omit the field instead' };
  }
  const record = readRecord(value);
  if (!record) {
    return { ok: false, message: 'injection_location must be an object with header and body booleans' };
  }
  for (const field of ['header', 'body'] as const) {
    if (record[field] === null) {
      return { ok: false, message: `injection_location.${field} must not be null; omit the field instead` };
    }
    if (record[field] !== undefined && typeof record[field] !== 'boolean') {
      return { ok: false, message: `injection_location.${field} must be a boolean` };
    }
  }
  const header = record.header === true;
  const body = record.body === true;
  if (!header && !body) {
    return { ok: false, message: 'injection_location must enable at least one of header or body' };
  }
  return { ok: true, value: { header, body } };
}

/** Normalized credential, ready for the local storage shape. */
export interface NormalizedCredential {
  /** One of the local `auth_type` values. */
  authType: LegacyCredentialType;
  /** Human-readable label. */
  displayName: string;
  /** MCP server the credential is bound to; MCP kinds only. */
  mcpServerUrl?: string;
  /** Environment variable name; `environment_variable` only. */
  secretName?: string;
  /** The secret value, or `undefined` when the caller supplied none. */
  secretValue?: string;
  /** Local network policy, already normalized. */
  networking?: Record<string, unknown>;
  /** Injection location; environment variables only in the canonical profile. */
  injectionLocation?: CredentialInjectionLocation;
  /**
   * The local `injection_locations` token list, kept as a local extension.
   *
   * The canonical profile has no such field for MCP kinds — they inject into
   * the MCP transport, not into request parts — but SandBase historically
   * recorded it for every credential kind. It is preserved on the local record
   * so existing callers keep observing what they wrote, while the canonical
   * `auth` projection only ever carries `injection_location` for environment
   * variables.
   */
  legacyInjectionTokens?: string[];
  metadata: Record<string, string>;
  /** OAuth refresh block, when supplied. Recorded but not executed. */
  refresh?: OAuthRefreshBlock;
}

export interface OAuthRefreshBlock {
  tokenEndpoint?: string;
  clientId?: string;
  hasClientSecret: boolean;
  tokenEndpointAuthType?: string;
}

export type CredentialParseResult =
  | { ok: true; value: NormalizedCredential; warnings: string[] }
  | { ok: false; message: string };

// ============================================================
// Parsing
// ============================================================

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Trimmed, non-empty strings from an unknown value; anything else is dropped. */
function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

/**
 * Parse a canonical `auth` object.
 *
 * The `auth` nesting is the canonical shape. The local flat shape is also
 * accepted so existing SandBase callers keep working, but a payload supplying
 * both is rejected rather than merged: merging would let a flat field override
 * a nested one, which is exactly how a credential ends up pointed somewhere
 * the caller did not intend.
 */
export function parseCredentialAuth(body: Record<string, unknown>): CredentialParseResult {
  const auth = readRecord(body.auth);
  const flatType = readString(body.auth_type);
  const hasFlatFields = flatType !== undefined
    || body.variable_name !== undefined
    || body.value !== undefined
    || body.mcp_server_url !== undefined;

  if (auth && hasFlatFields) {
    return {
      ok: false,
      message: 'Provide either auth or the flat auth_type fields, not both',
    };
  }

  const warnings: string[] = [];
  const metadata = stringRecord(body.metadata);

  if (auth) {
    // `display_name` is a top-level sibling of `auth` in the published shape,
    // alongside `metadata`. `auth.display_name` is accepted as a local alias
    // because earlier SandBase revisions read it from inside the object; the
    // top-level spelling wins when both are present so the canonical field is
    // never shadowed by the local one.
    const displayName = readString(body.display_name);
    return parseCanonicalAuth(auth, metadata, warnings, displayName);
  }
  return parseFlatAuth(body, flatType, metadata, warnings);
}

function parseCanonicalAuth(
  auth: Record<string, unknown>,
  metadata: Record<string, string>,
  warnings: string[],
  topLevelDisplayName?: string,
): CredentialParseResult {
  const type = readString(auth.type);
  if (!type) return { ok: false, message: 'auth.type is required' };
  if (!(CANONICAL_CREDENTIAL_TYPES as readonly string[]).includes(type)) {
    return { ok: false, message: `auth.type must be one of ${CANONICAL_CREDENTIAL_TYPES.join(', ')}` };
  }

  const displayName = topLevelDisplayName ?? readString(auth.display_name);

  if (type === 'environment_variable') {
    const secretName = readString(auth.secret_name);
    if (!secretName) return { ok: false, message: 'auth.secret_name is required for environment_variable credentials' };
    if (!isValidEnvVarName(secretName)) {
      return { ok: false, message: 'auth.secret_name must be a valid environment variable name' };
    }
    const injection = resolveInjectionLocation(auth.injection_location);
    if (!injection.ok) return { ok: false, message: `auth.${injection.message}` };
    return {
      ok: true,
      warnings,
      value: {
        authType: 'environment_variable',
        displayName: displayName ?? secretName,
        secretName,
        ...(readString(auth.secret_value) ? { secretValue: readString(auth.secret_value)! } : {}),
        ...(objectRecord(auth.networking) ? { networking: objectRecord(auth.networking)! } : {}),
        injectionLocation: injection.value,
        metadata,
      },
    };
  }

  // mcp_oauth and static_bearer share the `mcp_server_url` key.
  const mcpServerUrl = readString(auth.mcp_server_url);
  if (!mcpServerUrl) return { ok: false, message: `auth.mcp_server_url is required for ${type} credentials` };
  if (!isHttpUrl(mcpServerUrl)) {
    return { ok: false, message: 'auth.mcp_server_url must be an http(s) URL' };
  }

  if (type === 'static_bearer') {
    const token = readString(auth.token);
    return {
      ok: true,
      warnings,
      value: {
        authType: 'bearer_token',
        displayName: displayName ?? 'Static bearer',
        mcpServerUrl,
        ...(token ? { secretValue: token } : {}),
        metadata,
      },
    };
  }

  // mcp_oauth. The refresh block is parsed so a caller learns whether it will
  // be honoured, rather than finding out when the access token expires.
  const refresh = readRecord(auth.refresh);
  let refreshBlock: OAuthRefreshBlock | undefined;
  if (refresh) {
    const tokenEndpointAuth = readRecord(refresh.token_endpoint_auth);
    refreshBlock = {
      ...(readString(refresh.token_endpoint) ? { tokenEndpoint: readString(refresh.token_endpoint)! } : {}),
      ...(readString(refresh.client_id) ? { clientId: readString(refresh.client_id)! } : {}),
      hasClientSecret: readString(tokenEndpointAuth?.client_secret) !== undefined,
      ...(readString(tokenEndpointAuth?.type) ? { tokenEndpointAuthType: readString(tokenEndpointAuth?.type)! } : {}),
    };
    warnings.push(
      'auth.refresh is recorded but not executed: this runtime does not refresh OAuth access tokens, so an expired token will fail the outbound request.',
    );
  }

  const accessToken = readString(auth.access_token);
  return {
    ok: true,
    warnings,
    value: {
      authType: 'mcp_oauth',
      displayName: displayName ?? 'MCP OAuth',
      mcpServerUrl,
      ...(accessToken ? { secretValue: accessToken } : {}),
      ...(refreshBlock ? { refresh: refreshBlock } : {}),
      metadata,
    },
  };
}

function parseFlatAuth(
  body: Record<string, unknown>,
  flatType: string | undefined,
  metadata: Record<string, string>,
  warnings: string[],
): CredentialParseResult {
  if (!flatType) return { ok: false, message: 'auth.type is required' };
  if (!(LEGACY_CREDENTIAL_TYPES as readonly string[]).includes(flatType)) {
    return {
      ok: false,
      message: `auth_type must be one of ${LEGACY_CREDENTIAL_TYPES.join(', ')}`,
    };
  }
  const type = flatType as LegacyCredentialType;
  const displayName = readString(body.name) ?? readString(body.display_name) ?? '';

  // The flat legacy shape learned `injection_locations` as a token list before
  // the canonical `injection_location` object existed. Both spellings are
  // resolved here so every credential leaves this parser with one canonical
  // location, and so the "omit means both enabled" rule cannot be applied on
  // one path and missed on the other.
  const flatLocation = resolveFlatInjectionLocation(body.injection_locations);
  if (!flatLocation.ok) return { ok: false, message: flatLocation.message };
  const legacyTokens = Array.isArray(body.injection_locations)
    ? Array.from(new Set(arrayOfStrings(body.injection_locations)))
    : undefined;

  if (type === 'environment_variable') {
    const secretName = readString(body.variable_name);
    if (!secretName) return { ok: false, message: 'variable_name is required' };
    const value = readString(body.value);
    if (!value) return { ok: false, message: 'variable_name and value are required' };
    return {
      ok: true,
      warnings,
      value: {
        authType: 'environment_variable',
        displayName: displayName || secretName,
        secretName,
        secretValue: value,
        injectionLocation: flatLocation.value,
        ...(legacyTokens ? { legacyInjectionTokens: legacyTokens } : {}),
        metadata,
      },
    };
  }

  const mcpServerUrl = readString(body.mcp_server_url);
  if (!mcpServerUrl) return { ok: false, message: 'mcp_server_url is required' };
  const value = readString(body.value);
  if (type === 'bearer_token' && !value) return { ok: false, message: 'value is required' };

  return {
    ok: true,
    warnings,
    value: {
      authType: type,
      displayName: displayName || mcpServerUrl,
      mcpServerUrl,
      ...(value ? { secretValue: value } : {}),
      ...(legacyTokens ? { legacyInjectionTokens: legacyTokens } : {}),
      metadata,
    },
  };
}

/**
 * Resolve the legacy `injection_locations` token list to a canonical location.
 *
 * The legacy field was a list of tokens; a token list cannot express "explicitly
 * disable both", so an empty or absent list is read as the canonical default
 * (both enabled). An unknown token is still refused rather than dropped, because
 * silently ignoring `['headers']` would leave the caller believing the secret is
 * injected where it is not.
 */
function resolveFlatInjectionLocation(value: unknown): InjectionLocationResult {
  if (value === undefined) return { ok: true, value: { header: true, body: true } };
  if (value === null) return { ok: true, value: { header: true, body: true } };
  if (!Array.isArray(value)) {
    return { ok: false, message: 'injection_locations must be an array of request_headers or request_body' };
  }
  if (value.length === 0) return { ok: true, value: { header: true, body: true } };
  const allowed = new Set(['request_headers', 'request_body']);
  const invalidLocation = value.find((item) => typeof item !== 'string' || !allowed.has(item));
  if (invalidLocation !== undefined) {
    return { ok: false, message: 'injection_locations must contain only request_headers or request_body' };
  }
  return {
    ok: true,
    value: {
      header: value.includes('request_headers'),
      body: value.includes('request_body'),
    },
  };
}

/** Environment variable names: letters, digits, underscore; not starting with a digit. */
export function isValidEnvVarName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringRecord(value: unknown): Record<string, string> {
  const record = objectRecord(value);
  if (!record) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') out[key] = item;
  }
  return out;
}

// ============================================================
// Update rules
// ============================================================

export type CredentialUpdateCheck =
  | { ok: true }
  | { ok: false; locked: string[]; message: string };

/**
 * Reject an update that tries to change a locked structural field.
 *
 * Report the offending fields so the caller learns which ones require
 * archiving and recreating, instead of having the change silently ignored.
 */
export function checkCredentialUpdate(
  patch: Record<string, unknown>,
  existing: { mcpServerUrl?: string | null; secretName?: string | null },
): CredentialUpdateCheck {
  const locked: string[] = [];
  if (patch.mcp_server_url !== undefined && patch.mcp_server_url !== existing.mcpServerUrl) locked.push('mcp_server_url');
  if (patch.secret_name !== undefined && patch.secret_name !== existing.secretName) locked.push('secret_name');
  if (patch.token_endpoint !== undefined) locked.push('token_endpoint');
  if (patch.client_id !== undefined) locked.push('client_id');

  if (locked.length > 0) {
    return {
      ok: false,
      locked,
      message: `${locked.join(', ')} cannot be changed after creation; archive the credential and create a new one`,
    };
  }
  return { ok: true };
}

/**
 * Project a stored credential to the canonical `auth` shape, dropping secrets.
 *
 * The nested shape is what a canonical client expects, and the write-only
 * fields are simply absent — the runtime holds a hint, so there is no value
 * that could be masked and mistaken for the real one.
 */
export function toCanonicalCredential(input: {
  id: string;
  vaultId: string;
  displayName: string;
  authType: LegacyCredentialType;
  mcpServerUrl?: string | null;
  secretName?: string | null;
  injectionLocation?: CredentialInjectionLocation;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}): Record<string, unknown> {
  const type: CanonicalCredentialType = input.authType === 'bearer_token' ? 'static_bearer' : input.authType;

  const auth: Record<string, unknown> = { type };
  if (type === 'environment_variable') {
    if (input.secretName) auth.secret_name = input.secretName;
    if (input.injectionLocation) auth.injection_location = input.injectionLocation;
  } else if (input.mcpServerUrl) {
    auth.mcp_server_url = input.mcpServerUrl;
  }

  return {
    id: input.id,
    type: 'credential',
    vault_id: input.vaultId,
    display_name: input.displayName,
    auth,
    metadata: input.metadata,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
  };
}

/**
 * Whether a credential's `mcp_server_url` matches a declared MCP server URL.
 *
 * Both sides are canonicalized first — scheme and host lowercased, default
 * port and a single trailing slash removed — so a case, port, or trailing
 * slash difference does not silently prevent a credential from being applied.
 * A different path, subdomain, or non-default port is a genuine mismatch.
 */
export function mcpServerUrlMatches(credentialUrl: string, declaredUrl: string): boolean {
  return canonicalServerUrl(credentialUrl) === canonicalServerUrl(declaredUrl);
}

function canonicalServerUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    const protocol = url.protocol.toLowerCase();
    const host = url.hostname.toLowerCase();
    const defaultPort = (protocol === 'https:' && url.port === '443') || (protocol === 'http:' && url.port === '80');
    const port = url.port && !defaultPort ? `:${url.port}` : '';
    const path = url.pathname.replace(/\/+$/, '');
    return `${protocol}//${host}${port}${path}`;
  } catch {
    return undefined;
  }
}

// ============================================================
// Schema fragments
// ============================================================

/**
 * Canonical `injection_location`.
 *
 * `null` is refused at the schema level for the object and for each field: the
 * published contract treats an explicit `null` as a caller error and asks for
 * the field to be omitted instead. `resolveInjectionLocation` owns the
 * "at least one enabled" rule so the schema stays a shape check.
 */
export const credentialInjectionLocationSchema = z.object({
  header: z.boolean().nullish(),
  body: z.boolean().nullish(),
}).superRefine((value, ctx) => {
  if (value.header === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'injection_location.header must not be null' });
  }
  if (value.body === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'injection_location.body must not be null' });
  }
});

export const oauthRefreshSchema = z.object({
  token_endpoint: z.string().optional(),
  client_id: z.string().optional(),
  token_endpoint_auth: z
    .object({
      type: z.string().optional(),
      client_secret: z.string().optional(),
    })
    .optional(),
});

export const canonicalAuthSchema = z.union([
  z.object({
    type: z.literal('mcp_oauth'),
    display_name: z.string().optional(),
    mcp_server_url: z.string().min(1, 'mcp_server_url is required'),
    access_token: z.string().optional(),
    refresh_token: z.string().optional(),
    refresh: oauthRefreshSchema.optional(),
  }),
  z.object({
    type: z.literal('static_bearer'),
    display_name: z.string().optional(),
    mcp_server_url: z.string().min(1, 'mcp_server_url is required'),
    token: z.string().optional(),
  }),
  z.object({
    type: z.literal('environment_variable'),
    display_name: z.string().optional(),
    secret_name: z.string().min(1, 'secret_name is required'),
    secret_value: z.string().optional(),
    networking: z.record(z.string(), z.unknown()).optional(),
    injection_location: credentialInjectionLocationSchema.optional(),
  }),
]);
