/**
 * Anthropic compatibility header vocabulary.
 *
 * Lives outside both `src/api` and `src/sdk` because both need the same
 * literals for opposite reasons: the admission middleware admits a request by
 * them, and the first-party SDK declares itself a CMA caller with them. A
 * second copy in the SDK would let the two drift into a state where the SDK
 * sends a beta the server no longer recognizes.
 */

/**
 * The `anthropic-version` values admitted on a canonical `/v1` request.
 *
 * The managed-agents contract publishes `2026-10-21`: it is the version every
 * official-docs example sends and the version the official SDK sends from
 * 1.x on. `2023-06-01` stays admitted because it is the value the 0.x SDK line
 * sent — the version the earlier pin of this contract recorded — and a
 * caller on that SDK line is still a legitimate CMA client; refusing it would
 * be an upgrade trap the published contract does not describe.
 */
export const CMA_ANTHROPIC_VERSION = '2026-10-21';
export const CMA_LEGACY_ANTHROPIC_VERSION = '2023-06-01';
export const CMA_ADMITTED_ANTHROPIC_VERSIONS: readonly string[] = [
  CMA_ANTHROPIC_VERSION,
  CMA_LEGACY_ANTHROPIC_VERSION,
];

/** `anthropic-beta` for every canonical resource except memory stores. */
export const CMA_MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';

/** `anthropic-beta` for memory-store resources. Mutually exclusive with the above. */
export const CMA_AGENT_MEMORY_BETA = 'agent-memory-2026-07-22';

/**
 * Resource-family betas admitted on their own path family instead of
 * `managed-agents-2026-04-01`, so the official SDK's per-resource beta
 * headers reach the route. A family in this map is not necessarily a
 * refusal: `/v1/dreams` is implemented and admits `dreaming-2026-04-21`
 * because the SDK's dreams client sends it, while the tunnel and profile
 * families remain mounted refusals.
 */
export const CMA_RESOURCE_FAMILY_BETAS: Readonly<Record<string, string>> = {
  '/v1/dreams': 'dreaming-2026-04-21',
  '/v1/tunnels': 'mcp-tunnels-2026-06-22',
  '/v1/user_profiles': 'user-profiles-2026-08-18',
};
