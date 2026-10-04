export const UNSUPPORTED_OFFICIAL_ROUTES: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\/v1\/dreams(?:\/|$)/, reason: 'The memory-consolidation pipeline is not implemented in this phase.' },
  { pattern: /^\/v1\/tunnels(?:\/|$)/, reason: 'MCP tunnels require hosted connectivity outside the local-first scope.' },
  { pattern: /^\/v1\/user_profiles(?:\/|$)/, reason: 'Hosted user profile management is outside the single-tenant runtime scope.' },
  { pattern: /^\/v1\/environments\/[^/]+\/work(?:\/|$)/, reason: 'The hosted Work API is not the local worker queue API.' },
  { pattern: /^\/v1\/vaults\/[^/]+\/credentials\/[^/]+\/mcp_oauth_validate$/, reason: 'The runtime has no MCP OAuth refresh or validation service.' },
];

export const PENDING_OFFICIAL_ROUTES = [
  ['GET /v1/memory_stores/:id/memories/:id', 'Memory retrieval'],
  ['POST /v1/memory_stores/:id/memories/:id', 'Official memory update method'],
  ['POST /v1/memory_stores/:id/memory_versions/:id/redact', 'Memory-version redaction'],
  ['DELETE /v1/vaults/:id', 'Vault deletion'],
  ['POST /v1/vaults/:id', 'Vault update'],
  ['GET /v1/vaults/:id/credentials/:id', 'Credential retrieval'],
  ['POST /v1/vaults/:id/credentials/:id', 'Credential update'],
  ['POST /v1/deployments/:id', 'Official deployment update method'],
  ['POST /v1/sessions/:id/resources/:id', 'Official session resource update method'],
  ['GET /v1/skills/:id/versions', 'Skill-version listing'],
  ['POST /v1/skills/:id/versions', 'Skill-version upload'],
  ['GET /v1/skills/:id/versions/:id', 'Skill-version retrieval'],
  ['DELETE /v1/skills/:id/versions/:id', 'Skill-version deletion'],
  ['GET /v1/skills/:id/versions/:id/content', 'Skill-version content'],
  ['GET /v1/sessions/:id/threads', 'Multi-agent thread listing'],
  ['GET /v1/sessions/:id/threads/:id', 'Multi-agent thread retrieval'],
  ['GET /v1/sessions/:id/threads/:id/events', 'Multi-agent thread events'],
  ['GET /v1/sessions/:id/threads/:id/stream', 'Multi-agent thread streaming'],
  ['POST /v1/sessions/:id/threads/:id/archive', 'Multi-agent thread archive'],
].map(([route, reason]) => ({
  route,
  reason,
  followUp: 'https://github.com/sandbaseai/sandbase-harness/issues/706',
}));
