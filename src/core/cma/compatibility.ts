/**
 * Anthropic compatibility header vocabulary.
 *
 * Lives outside both `src/api` and `src/sdk` because both need the same
 * literals for opposite reasons: the admission middleware admits a request by
 * them, and the first-party SDK declares itself a CMA caller with them. A
 * second copy in the SDK would let the two drift into a state where the SDK
 * sends a beta the server no longer recognizes.
 */

/** The only supported `anthropic-version` value. */
export const CMA_ANTHROPIC_VERSION = '2023-06-01';

/** `anthropic-beta` for every canonical resource except memory stores. */
export const CMA_MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';

/** `anthropic-beta` for memory-store resources. Mutually exclusive with the above. */
export const CMA_AGENT_MEMORY_BETA = 'agent-memory-2026-07-22';

export const CMA_REFUSED_RESOURCE_BETAS: Readonly<Record<string, string>> = {
  '/v1/dreams': 'dreaming-2026-04-21',
  '/v1/tunnels': 'mcp-tunnels-2026-06-22',
  '/v1/user_profiles': 'user-profiles-2026-08-18',
};
