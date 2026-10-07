/**
 * An Environment's network policy, in one spelling.
 *
 * The policy has two spellings for one object, and both are load-bearing:
 *
 * - `config.network` is the local spelling, written by this runtime's Console,
 *   SDK, and CLI: `{ type, allowed_hosts, allow_mcp_server_network_access,
 *   allow_package_manager_network_access }`.
 * - `config.networking` is the published CMA spelling inside `config`:
 *   `{ type: "unrestricted" | "limited", allowed_hosts, allow_mcp_servers,
 *   allow_package_managers }`.
 *
 * Measured against the official TypeScript SDK at `0.131.0`, `config.networking`
 * was stored as written and never read, so an official client could declare a
 * limited policy and receive a response that never mentioned it. Both spellings
 * are normalized here — one function, one stored shape — so a stored policy
 * cannot depend on which spelling arrived.
 *
 * Normalization is fail-closed in the same sense the credential network policy
 * is: an unrecognized `type` is `limited` rather than `unrestricted`, and a
 * permission flag is only `true` when it is literally `true`. Keys outside the
 * documented vocabulary are preserved rather than dropped; they are recorded and
 * echoed without being interpreted.
 *
 * Enforcement lives elsewhere: `src/core/net/egress-proxy.ts` is the boundary
 * subprocess traffic crosses, `src/sandbox/` providers install it, and
 * `src/core/session/tool-resolver.ts` applies the policy to the MCP connect
 * boundary and `web_fetch`. This module owns the shared read of the policy —
 * the effective allowlist, the MCP admission decision — so every consumer
 * interprets the same declaration the same way.
 */

import { hostMatchesPattern } from '@/core/credentials/policy.js';

export type EnvironmentNetworkType = 'limited' | 'unrestricted';

/** The local spelling's keys, which are also what a normalized policy carries. */
export interface EnvironmentNetworkPolicy extends Record<string, unknown> {
  type: EnvironmentNetworkType;
  allowed_hosts: string[];
  allow_mcp_server_network_access: boolean;
  allow_package_manager_network_access: boolean;
}

/** Published key → local key, for the two permissions the CMA spells differently. */
export const ENVIRONMENT_NETWORK_ALIASES: Readonly<Record<string, string>> = {
  allow_mcp_servers: 'allow_mcp_server_network_access',
  allow_package_managers: 'allow_package_manager_network_access',
};

/**
 * Normalize a policy written in either spelling.
 *
 * Returns `undefined` for a value that is not an object at all (`undefined`,
 * `null`, a string, an array), which is "no policy declared" for the caller to
 * report in its own words — the write path refuses it, the projection reports
 * an empty policy.
 */
export function normalizeEnvironmentNetwork(value: unknown): EnvironmentNetworkPolicy | undefined {
  if (!isPlainObject(value)) return undefined;

  // Local spellings are read first so a published alias can never override the
  // local key it names, whatever order the two arrive in.
  const canonical: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!(key in ENVIRONMENT_NETWORK_ALIASES)) canonical[key] = entry;
  }
  for (const [alias, local] of Object.entries(ENVIRONMENT_NETWORK_ALIASES)) {
    if (alias in value && !(local in canonical)) canonical[local] = value[alias];
  }

  return {
    ...canonical,
    type: value.type === 'unrestricted' ? 'unrestricted' : 'limited',
    allowed_hosts: toStringArray(value.allowed_hosts),
    allow_mcp_server_network_access: canonical.allow_mcp_server_network_access === true,
    allow_package_manager_network_access: canonical.allow_package_manager_network_access === true,
  };
}

/**
 * Whether two normalized policies say the same thing.
 *
 * Used to refuse one request that declares both spellings with different
 * content, which is the same rule the hosting axis applies to `hosting_type` and
 * the published `type`: two spellings of one thing that disagree cannot both be
 * honoured, and picking one would apply a policy the caller did not write.
 */
export function sameEnvironmentNetwork(
  left: EnvironmentNetworkPolicy,
  right: EnvironmentNetworkPolicy,
): boolean {
  return fingerprint(left) === fingerprint(right);
}

/** Key-order-independent rendering, so two equal policies compare equal. */
function fingerprint(policy: EnvironmentNetworkPolicy): string {
  return JSON.stringify(
    Object.keys(policy).sort().map((key) => [key, policy[key]]),
  );
}

/**
 * Well-known package-registry hosts `allow_package_manager_network_access`
 * opens under a `limited` policy.
 *
 * The flag names a *kind* of traffic, not a host list, so the concrete hosts
 * are this runtime's curated reading of it — the public endpoints each shipped
 * package manager's default configuration contacts. A mirror or a private
 * registry belongs in `allowed_hosts`, not in this list.
 */
export const PACKAGE_MANAGER_EGRESS_HOSTS: readonly string[] = [
  // npm / yarn
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  // pip
  'pypi.org',
  'files.pythonhosted.org',
  // go modules
  'proxy.golang.org',
  'sum.golang.org',
  'index.golang.org',
  // cargo
  'index.crates.io',
  'static.crates.io',
  'crates.io',
  // rubygems
  'rubygems.org',
  '*.rubygems.org',
  // maven
  'repo.maven.apache.org',
  'repo1.maven.org',
  // nuget
  'api.nuget.org',
  // common distribution package mirrors
  'archive.ubuntu.com',
  'security.ubuntu.com',
  'deb.debian.org',
  'security.debian.org',
];

/**
 * The host patterns a `limited` policy's egress boundary must admit: the
 * declared `allowed_hosts` plus the package-registry set when the policy
 * opens package-manager access.
 *
 * One list serves every enforcement point — the egress proxy subprocesses get,
 * and the `web_fetch` bound — so the same policy cannot allow a host in one
 * place and refuse it in another. MCP servers are governed separately by
 * {@link environmentMcpServerAdmission}: `allow_mcp_server_network_access`
 * is a statement about MCP endpoints, not a general widening of the host list.
 */
export function environmentEgressAllowlist(policy: EnvironmentNetworkPolicy): string[] {
  return [
    ...policy.allowed_hosts,
    ...(policy.allow_package_manager_network_access ? PACKAGE_MANAGER_EGRESS_HOSTS : []),
  ];
}

/**
 * Whether a `limited` policy admits the host at all, registry widening
 * included. The port rule matches `hostMatchesPattern`: a pattern carrying a
 * port requires it, a bare pattern is port-agnostic.
 */
export function environmentAllowsEgressHost(
  policy: EnvironmentNetworkPolicy,
  host: string,
): boolean {
  return environmentEgressAllowlist(policy).some((pattern) => hostMatchesPattern(host, pattern));
}

/**
 * The MCP connect admission decision under a policy.
 *
 * A stdio server is a local subprocess — it declares no endpoint, so there is
 * no host to check; its egress is bounded the same way every session
 * subprocess is (proxy environment where the backend supplies one). A `url`
 * server names its destination, and under `limited` that destination must be
 * covered by `allowed_hosts` unless `allow_mcp_server_network_access` opens
 * MCP endpoints generally. An `unrestricted` or absent policy admits
 * everything. Returns the refusal message, or `undefined` when admitted.
 */
export function environmentMcpServerAdmission(
  policy: EnvironmentNetworkPolicy | undefined,
  server: { type: string; url?: string },
): string | undefined {
  if (!policy || policy.type !== 'limited') return undefined;
  if (server.type !== 'url' || !server.url) return undefined;
  if (policy.allow_mcp_server_network_access) return undefined;

  const host = normalizePolicyHost(server.url);
  if (host && policy.allowed_hosts.some((pattern) => hostMatchesPattern(host, pattern))) {
    return undefined;
  }
  return `MCP server endpoint ${host ? `"${host}"` : `"${server.url}"`} is not covered by the environment's `
    + 'allowed_hosts and the policy does not allow MCP server network access';
}

/** Read the policy a resolved EnvironmentConfig carries, whatever spelling it arrived in. */
export function environmentNetworkPolicyOf(
  config: { network?: unknown; networking?: unknown } | undefined,
): EnvironmentNetworkPolicy | undefined {
  if (!config) return undefined;
  return normalizeEnvironmentNetwork(config.network) ?? normalizeEnvironmentNetwork(config.networking);
}

/** Normalize a URL or host[:port] into `host` / `host:port` for pattern matching. */
function normalizePolicyHost(value: string): string | undefined {
  let raw = value.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    raw = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    // fall through to the raw split
  }
  raw = raw.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  return raw || undefined;
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
