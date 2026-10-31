/**
 * Runtime network policy for vault credentials.
 *
 * A credential record declares `network` as
 * `{ type: 'unrestricted' | 'limited', allowed_hosts: string[] }`. The
 * injection resolver consults this policy before decrypting a secret.
 *
 * Matching is deliberately small and predictable:
 * - `unrestricted` allows every host;
 * - an exact pattern matches only that host;
 * - `*.example.com` matches subdomains, not the apex;
 * - a bare `*` is not a wildcard; use explicit `unrestricted` instead;
 * - an optional `:port` must match the target port, while a pattern without a
 *   port is port-agnostic.
 *
 * A limited policy without a verifiable target host is denied. Unknown network
 * destinations are not evidence of authorization.
 */

export type CredentialNetworkMode = 'unrestricted' | 'limited';

export interface CredentialNetworkPolicy {
  type: CredentialNetworkMode;
  allowed_hosts: string[];
}

export type CredentialPolicyDenyReason = 'host_not_allowed' | 'host_unverified' | 'backend_unsupported';

/** Stable machine-readable codes; callers must not depend on message text. */
export const CREDENTIAL_POLICY_CODES: Record<CredentialPolicyDenyReason, string> = {
  host_not_allowed: 'credential_host_not_allowed',
  host_unverified: 'credential_host_unverified',
  backend_unsupported: 'credential_backend_unsupported',
};

export interface CredentialNetworkAuthorization {
  allowed: boolean;
  reason?: CredentialPolicyDenyReason;
  code?: string;
  host?: string;
  message?: string;
}

/** Invalid shapes degrade to the most restrictive legal policy. */
export function normalizeCredentialNetworkPolicy(value: unknown): CredentialNetworkPolicy {
  const record = isPlainObject(value) ? value : {};
  return {
    type: record.type === 'unrestricted' ? 'unrestricted' : 'limited',
    allowed_hosts: toStringArray(record.allowed_hosts),
  };
}

/** Parse the JSON network column of a credential record. */
export function parseCredentialNetworkPolicy(value: string | null | undefined): CredentialNetworkPolicy {
  if (!value) return { type: 'limited', allowed_hosts: [] };
  try {
    return normalizeCredentialNetworkPolicy(JSON.parse(value));
  } catch {
    return { type: 'limited', allowed_hosts: [] };
  }
}

/** Normalize a host or URL into `host` or `host:port`, lowercased. */
export function normalizeHost(value: string): string | undefined {
  const parsed = parseHostLike(value);
  if (!parsed) return undefined;
  return parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host;
}

/** True when targetHost satisfies one allowed_hosts pattern. */
export function hostMatchesPattern(targetHost: string, pattern: string): boolean {
  const target = parseHostLike(targetHost);
  const rule = parseHostLike(pattern);
  if (!target || !rule) return false;
  if (rule.port && rule.port !== target.port) return false;
  if (rule.host === '*') return false;
  if (rule.host.startsWith('*.')) {
    const suffix = rule.host.slice(1);
    return target.host.length > suffix.length && target.host.endsWith(suffix);
  }
  return target.host === rule.host;
}

/** Decide whether a policy authorizes injecting a credential for a host. */
export function authorizeCredentialNetwork(
  policy: CredentialNetworkPolicy,
  targetHost?: string | null,
): CredentialNetworkAuthorization {
  const host = targetHost ? normalizeHost(targetHost) : undefined;
  if (policy.type === 'unrestricted') return { allowed: true, ...(host ? { host } : {}) };
  if (!host) return deny('host_unverified', 'the target host is unknown, so a limited credential policy cannot be satisfied');
  if (policy.allowed_hosts.some((pattern) => hostMatchesPattern(host, pattern))) return { allowed: true, host };
  return deny('host_not_allowed', `host "${host}" is not covered by allowed_hosts`, host);
}

function deny(reason: CredentialPolicyDenyReason, detail: string, host?: string): CredentialNetworkAuthorization {
  return {
    allowed: false,
    reason,
    code: CREDENTIAL_POLICY_CODES[reason],
    ...(host ? { host } : {}),
    message: `Credential network policy denied injection: ${detail}`,
  };
}

interface ParsedHost {
  host: string;
  port: string | null;
}

function parseHostLike(value: string): ParsedHost | null {
  let raw = value.trim();
  if (!raw) return null;
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  raw = raw.split(/[/?#]/)[0];
  const at = raw.lastIndexOf('@');
  if (at >= 0) raw = raw.slice(at + 1);
  raw = raw.toLowerCase();
  if (!raw) return null;

  let host = raw;
  let port: string | null = null;
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close < 0) return null;
    host = raw.slice(0, close + 1);
    const rest = raw.slice(close + 1);
    if (rest.startsWith(':') && rest.slice(1)) port = rest.slice(1);
  } else {
    const index = raw.lastIndexOf(':');
    const candidate = index >= 0 ? raw.slice(index + 1) : '';
    if (index >= 0 && /^\d+$/.test(candidate)) {
      host = raw.slice(0, index);
      port = candidate;
    }
  }

  host = host.replace(/\.+$/, '');
  return host ? { host, port } : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}
