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
 * Measured against the official TypeScript SDK at `0.129.0`, `config.networking`
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
 * **What this module does not do.** It records and normalizes a policy; it does
 * not enforce one. No sandbox provider shipped in this runtime reads an
 * Environment's network policy, which `docs/api.md` and the capability matrix
 * state plainly rather than implying that a declared limit is applied.
 */

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
