export interface UnsupportedOfficialRoute {
  pattern: RegExp;
  /**
   * When present, only these HTTP methods are refused at the matching path —
   * a route family where some verbs are implemented and others are not
   * (the Work API is exactly that shape) must not mark the whole path
   * unsupported.
   */
  methods?: readonly string[];
  reason: string;
}

export const UNSUPPORTED_OFFICIAL_ROUTES: ReadonlyArray<UnsupportedOfficialRoute> = [
  { pattern: /^\/v1\/tunnels(?:\/|$)/, reason: 'MCP tunnels require hosted connectivity outside the local-first scope.' },
  { pattern: /^\/v1\/user_profiles(?:\/|$)/, reason: 'Hosted user profile management is outside the single-tenant runtime scope.' },
  { pattern: /^\/v1\/vaults\/[^/]+\/credentials\/[^/]+\/mcp_oauth_validate$/, reason: 'MCP OAuth tokens refresh at the injection boundary; a dedicated validation endpoint is not implemented.' },
  { pattern: /^\/v1\/sessions\/[^/]+\/threads(?:\/|$)/, reason: 'Session threads belong to the multiagent surface this runtime does not implement.' },
];

/** Whether an extracted official route falls under a refusal entry. */
export function matchesUnsupportedRoute(
  entry: UnsupportedOfficialRoute,
  route: { method: string; path: string },
): boolean {
  return entry.pattern.test(route.path) && (!entry.methods || entry.methods.includes(route.method));
}

/**
 * Official SDK routes whose mount is deferred to a tracked implementation PR.
 * Empty: every route in the pinned inventory is either served or a mounted
 * refusal — the structure stays so a future deferral has a declared home.
 */
export const PENDING_OFFICIAL_ROUTES: ReadonlyArray<{ route: string; reason: string; followUp: string }> = [];
