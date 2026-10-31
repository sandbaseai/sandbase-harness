/**
 * One normalized shape for an Environment's network policy.
 *
 * The policy has two spellings — `config.network` (local) and
 * `config.networking` (published CMA) — and the published one used to be stored
 * and never read, so a caller could declare a limit and receive a response that
 * did not mention it. This file pins the normalizer both spellings run through:
 * the vocabulary it accepts, the values it defaults, and the keys it refuses to
 * drop.
 */

import { describe, it, expect } from 'vitest';
import {
  environmentAllowedHostsError,
  environmentAllowsEgressHost,
  environmentEgressAllowlist,
  environmentMcpServerAdmission,
  environmentNetworkPolicyOf,
  environmentWebDomainAdmission,
  normalizeEnvironmentNetwork,
  PACKAGE_MANAGER_EGRESS_HOSTS,
  sameEnvironmentNetwork,
} from '@/core/config/environment-network.js';

describe('environment network normalization', () => {
  it('translates the published permission keys into the local ones', () => {
    expect(normalizeEnvironmentNetwork({
      type: 'limited',
      allowed_hosts: ['api.example.com'],
      allow_mcp_servers: true,
      allow_package_managers: false,
    })).toEqual({
      type: 'limited',
      allowed_hosts: ['api.example.com'],
      allow_mcp_server_network_access: true,
      allow_package_manager_network_access: false,
    });
  });

  it('leaves a policy written in the local spelling as the local shape', () => {
    const policy = {
      type: 'unrestricted',
      allowed_hosts: [],
      allow_mcp_server_network_access: true,
      allow_package_manager_network_access: false,
    };
    expect(normalizeEnvironmentNetwork(policy)).toEqual(policy);
  });

  it('lets the local key win over the published alias it names', () => {
    // Two keys for one permission with different values: the local spelling is
    // the one this runtime records, so the answer cannot depend on key order.
    const aliasFirst = { type: 'limited', allow_mcp_servers: true, allow_mcp_server_network_access: false };
    const localFirst = { type: 'limited', allow_mcp_server_network_access: false, allow_mcp_servers: true };
    expect(normalizeEnvironmentNetwork(aliasFirst)?.allow_mcp_server_network_access).toBe(false);
    expect(normalizeEnvironmentNetwork(localFirst)?.allow_mcp_server_network_access).toBe(false);
  });

  it('defaults fail-closed', () => {
    // An unrecognized type is `limited`, the restrictive reading, and a
    // permission is only granted by the literal boolean `true`.
    expect(normalizeEnvironmentNetwork({})?.type).toBe('limited');
    expect(normalizeEnvironmentNetwork({ type: 'anything' })?.type).toBe('limited');
    expect(normalizeEnvironmentNetwork({ type: 'unrestricted' })?.type).toBe('unrestricted');
    expect(normalizeEnvironmentNetwork({ allow_mcp_servers: 'true' })?.allow_mcp_server_network_access).toBe(false);
    expect(normalizeEnvironmentNetwork({ allowed_hosts: 'api.example.com' })?.allowed_hosts).toEqual([]);
  });

  it('keeps only usable host patterns', () => {
    expect(normalizeEnvironmentNetwork({
      allowed_hosts: [' api.example.com ', '', 7, null, '*.internal.example.com'],
    })?.allowed_hosts).toEqual(['api.example.com', '*.internal.example.com']);
  });

  it('records keys outside the vocabulary instead of dropping them', () => {
    // The policy object is open: an experiment that adds a key must see it come
    // back rather than disappear between the request and the response.
    expect(normalizeEnvironmentNetwork({ type: 'limited', future_key: 'kept' }))
      .toMatchObject({ future_key: 'kept' });
  });

  it('names the offending allowed_hosts entry and index', () => {
    expect(environmentAllowedHostsError(['api.example.com', 'https://x.com']))
      .toContain('allowed_hosts.1');
    expect(environmentAllowedHostsError(['ok.example.com'])).toBeUndefined();
  });

  it('admits a bare hostname and a leading *. wildcard only', () => {
    expect(environmentAllowedHostsError(['example.com', '*.example.com', 'a-b.c_d.example.org']))
      .toBeUndefined();
    expect(environmentAllowedHostsError(['*.example.com'])).toBeUndefined();
  });

  it('refuses a scheme, port, path, credentials, whitespace, and a bare *', () => {
    for (const bad of ['https://x.com', 'x.com:8080', 'x.com/path', 'u@x.com', 'a b.com', '*', 'x.*.com']) {
      expect(environmentAllowedHostsError([bad]), bad).toBeDefined();
    }
    expect(environmentAllowedHostsError(['*.com'])).toBeDefined();
  });

  it('refuses an empty entry, bad labels, and consecutive dots', () => {
    // A single trailing dot is normalized away, so `example.com.` is legal;
    // the rest are malformed at the entry level.
    expect(environmentAllowedHostsError(['example.com.'])).toBeUndefined();
    for (const bad of [' ', '.example.com', 'ex..com', '-x.com', 'x-.com']) {
      expect(environmentAllowedHostsError([bad]), bad).toBeDefined();
    }
  });

  it('reports a value that is not an object as no policy at all', () => {
    // The write path refuses these in its own words; the projection reports an
    // empty policy. Either way, no normalizer invents a policy from a string.
    for (const value of [undefined, null, 'limited', 7, ['limited'], true]) {
      expect(normalizeEnvironmentNetwork(value)).toBeUndefined();
    }
  });

  it('compares policies independently of key order', () => {
    const published = normalizeEnvironmentNetwork({
      type: 'limited',
      allowed_hosts: ['a.example.com'],
      allow_package_managers: true,
    })!;
    const local = normalizeEnvironmentNetwork({
      allow_package_manager_network_access: true,
      allowed_hosts: ['a.example.com'],
      type: 'limited',
    })!;
    expect(sameEnvironmentNetwork(published, local)).toBe(true);
    expect(sameEnvironmentNetwork(published, normalizeEnvironmentNetwork({
      type: 'limited',
      allowed_hosts: ['b.example.com'],
      allow_package_managers: true,
    })!)).toBe(false);
    // A permission the published spelling grants and the local one does not is a
    // real difference, not a spelling difference.
    expect(sameEnvironmentNetwork(published, normalizeEnvironmentNetwork({
      type: 'limited',
      allowed_hosts: ['a.example.com'],
    })!)).toBe(false);
  });
});

describe('environment egress allowlist', () => {
  const policy = (overrides: Record<string, unknown> = {}) => normalizeEnvironmentNetwork({
    type: 'limited',
    allowed_hosts: ['api.github.com', '*.example.com', 'ci.internal:8443'],
    ...overrides,
  })!;

  it('admits exact hosts, subdomains, and pinned ports', () => {
    expect(environmentAllowsEgressHost(policy(), 'api.github.com:443')).toBe(true);
    expect(environmentAllowsEgressHost(policy(), 'api.github.com')).toBe(true);
    expect(environmentAllowsEgressHost(policy(), 'v1.example.com:443')).toBe(true);
    // `*.example.com` does not cover the apex, matching the credential policy.
    expect(environmentAllowsEgressHost(policy(), 'example.com')).toBe(false);
    expect(environmentAllowsEgressHost(policy(), 'evil.github.com')).toBe(false);
    // A pattern with a port requires that port.
    expect(environmentAllowsEgressHost(policy(), 'ci.internal:8443')).toBe(true);
    expect(environmentAllowsEgressHost(policy(), 'ci.internal:443')).toBe(false);
  });

  it('widens the allowlist with package registries only when the flag is set', () => {
    const closed = policy();
    expect(environmentAllowsEgressHost(closed, 'registry.npmjs.org:443')).toBe(false);
    expect(environmentEgressAllowlist(closed)).not.toContain('registry.npmjs.org');

    const open = policy({ allow_package_manager_network_access: true });
    expect(environmentAllowsEgressHost(open, 'registry.npmjs.org:443')).toBe(true);
    expect(environmentAllowsEgressHost(open, 'pypi.org:443')).toBe(true);
    for (const host of PACKAGE_MANAGER_EGRESS_HOSTS) {
      expect(environmentEgressAllowlist(open)).toContain(host);
    }
  });

  it('reads the policy from whichever spelling the config carries', () => {
    expect(environmentNetworkPolicyOf({ network: { type: 'limited', allowed_hosts: ['a.b'] } })?.type).toBe('limited');
    expect(environmentNetworkPolicyOf({ networking: { type: 'limited', allow_mcp_servers: true } })?.allow_mcp_server_network_access).toBe(true);
    expect(environmentNetworkPolicyOf({})).toBeUndefined();
    expect(environmentNetworkPolicyOf(undefined)).toBeUndefined();
  });
});

describe('environment MCP server admission', () => {
  const limited = (overrides: Record<string, unknown> = {}) => normalizeEnvironmentNetwork({
    type: 'limited',
    allowed_hosts: ['mcp.github.com'],
    ...overrides,
  })!;

  it('refuses a url server whose host the policy does not cover', () => {
    const refusal = environmentMcpServerAdmission(limited(), {
      type: 'url',
      url: 'https://mcp.evil.com/sse',
    });
    expect(refusal).toContain('mcp.evil.com');
  });

  it('admits a url server whose host is covered', () => {
    expect(environmentMcpServerAdmission(limited(), {
      type: 'url',
      url: 'https://mcp.github.com/sse',
    })).toBeUndefined();
  });

  it('admits any url server when the policy opens MCP access', () => {
    expect(environmentMcpServerAdmission(limited({ allow_mcp_server_network_access: true }), {
      type: 'url',
      url: 'https://mcp.evil.com/sse',
    })).toBeUndefined();
  });

  it('admits stdio servers — their egress is bounded at the subprocess, not here', () => {
    expect(environmentMcpServerAdmission(limited(), { type: 'stdio' })).toBeUndefined();
  });

  it('admits everything under an unrestricted or absent policy', () => {
    const url = { type: 'url', url: 'https://mcp.evil.com/sse' };
    expect(environmentMcpServerAdmission(normalizeEnvironmentNetwork({ type: 'unrestricted' }), url)).toBeUndefined();
    expect(environmentMcpServerAdmission(undefined, url)).toBeUndefined();
  });
});

describe('environment web domain admission', () => {
  const limited = (allowed_hosts: string[] = ['api.example.com', '*.example.org']) =>
    normalizeEnvironmentNetwork({ type: 'limited', allowed_hosts })!;

  const agent = (allowed_domains: unknown, tool = 'web_fetch') => ({
    tools: [{
      type: 'agent_toolset_20260401',
      configs: [{ name: tool, allowed_domains }],
    }],
  });

  it('refuses an allowed_domains entry the allowlist does not cover', () => {
    const refusal = environmentWebDomainAdmission(limited(), agent(['docs.other.com']));
    expect(refusal?.tool).toBe('web_fetch');
    expect(refusal?.domain).toBe('docs.other.com');
    expect(refusal?.message).toContain('allowed_hosts');
  });

  it('admits an entry covered by an exact host and by a wildcard', () => {
    expect(environmentWebDomainAdmission(limited(), agent(['api.example.com']))).toBeUndefined();
    expect(environmentWebDomainAdmission(limited(), agent(['docs.example.org']))).toBeUndefined();
  });

  it('applies the published matching asymmetry: a bare host does not cover a subdomain', () => {
    // `docs.example.com` is within `["docs.example.com"]` and `["*.example.com"]`
    // but not `["example.com"]` — the tool entry covers its subdomains, an
    // allowed_hosts entry covers only the exact host unless it starts `*.`.
    expect(environmentWebDomainAdmission(limited(['example.com']), agent(['docs.example.com']))?.domain)
      .toBe('docs.example.com');
    expect(environmentWebDomainAdmission(limited(['docs.example.com']), agent(['docs.example.com'])))
      .toBeUndefined();
    expect(environmentWebDomainAdmission(limited(['*.example.com']), agent(['docs.example.com'])))
      .toBeUndefined();
  });

  it('reduces a web_search path suffix to its host before matching', () => {
    expect(environmentWebDomainAdmission(limited(['docs.example.org']), agent(['docs.example.org/search'], 'web_search')))
      .toBeUndefined();
    expect(environmentWebDomainAdmission(limited(['docs.example.org']), agent(['other.com/search'], 'web_search'))?.domain)
      .toBe('other.com/search');
  });

  it('skips a disabled entry and a blocked_domains list', () => {
    expect(environmentWebDomainAdmission(limited(), {
      tools: [{ type: 'agent_toolset_20260401', configs: [{ name: 'web_fetch', enabled: false, allowed_domains: ['x.com'] }] }],
    })).toBeUndefined();
    expect(environmentWebDomainAdmission(limited(), {
      tools: [{ type: 'agent_toolset_20260401', configs: [{ name: 'web_fetch', blocked_domains: ['x.com'] }] }],
    })).toBeUndefined();
  });

  it('checks every enabled web-tool entry across toolsets', () => {
    const multi = {
      tools: [
        { type: 'agent_toolset_20260401', configs: [{ name: 'web_fetch', allowed_domains: ['api.example.com'] }] },
        { type: 'agent_toolset_20260401', configs: [{ name: 'web_search', allowed_domains: ['outside.net'] }] },
      ],
    };
    expect(environmentWebDomainAdmission(limited(), multi)?.tool).toBe('web_search');
  });

  it('admits everything under an unrestricted or absent policy', () => {
    const def = agent(['anything.example.net']);
    expect(environmentWebDomainAdmission(normalizeEnvironmentNetwork({ type: 'unrestricted' }), def)).toBeUndefined();
    expect(environmentWebDomainAdmission(undefined, def)).toBeUndefined();
  });
});
