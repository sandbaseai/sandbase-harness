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
  normalizeEnvironmentNetwork,
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
