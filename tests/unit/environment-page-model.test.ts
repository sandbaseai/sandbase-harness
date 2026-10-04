import { describe, expect, it } from 'vitest';
import {
  environmentDraftFromApi,
  environmentKind,
  environmentPayloadFromDraft,
  sandboxProviderForHostingType,
  splitCsv,
} from '../../apps/console/src/components/pages/EnvironmentPageModel';
import type { Environment } from '../../apps/console/src/types';

describe('environment page model helpers', () => {
  it('maps hosting types to labels and sandbox providers', () => {
    expect(environmentKind(environment({ effective_sandbox_provider: 'self_hosted' }))).toBe('Self-hosted');
    expect(environmentKind(environment({ effective_sandbox_provider: 'docker', config: { sandbox_provider: 'docker' } }))).toBe('Docker');
    expect(environmentKind(environment({ effective_sandbox_provider: 'kubernetes' }))).toBe('Kubernetes');
    expect(sandboxProviderForHostingType('self_hosted')).toBe('self_hosted');
    expect(sandboxProviderForHostingType('docker')).toBe('docker');
    expect(sandboxProviderForHostingType('kubernetes')).toBe('kubernetes');
    expect(sandboxProviderForHostingType('local')).toBe('local');
    // `cloud` names no backend — the workspace default resolves it.
    expect(sandboxProviderForHostingType('cloud')).toBeUndefined();
  });

  it('drafts the declared hosting type, not the resolved one', () => {
    // A cloud environment whose workspace default is docker still edits as
    // `cloud` — the declaration is what the config stores.
    const draft = environmentDraftFromApi(environment({
      effective_sandbox_provider: 'docker',
      config: { type: 'cloud' },
    }));
    expect(draft.hostingType).toBe('cloud');
  });

  it('builds an editor draft from API environment data', () => {
    const draft = environmentDraftFromApi(environment({
      effective_sandbox_provider: 'docker',
      config: {
        network: {
          type: 'unrestricted',
          allow_mcp_server_network_access: true,
          allow_package_manager_network_access: false,
          allowed_hosts: ['example.com'],
        },
        packages: [{ manager: 'npm', package: 'typescript' }],
        sandbox_provider: 'docker',
        image: 'node:22-bookworm',
        resources: { memory: '1g', cpu: 2 },
      },
      metadata: {
        owner: 'runtime',
        environment_keys: '[{"id":"envkey_1","name":"host"}]',
      },
    }));

    expect(draft.networkType).toBe('unrestricted');
    expect(draft.hostingType).toBe('docker');
    expect(draft.dockerImage).toBe('node:22-bookworm');
    expect(draft.dockerMemory).toBe('1g');
    expect(draft.dockerCpu).toBe('2');
    expect(draft.allowedHosts).toBe('example.com');
    expect(draft.packages).toMatchObject({ npm: 'typescript', pip: '', apt: '' });
    expect(draft.metadata).toMatchObject([{ key: 'owner', value: 'runtime' }]);
    expect(draft.preservedMetadata).toEqual({ environment_keys: '[{"id":"envkey_1","name":"host"}]' });
  });

  it('creates the API payload while preserving protected metadata', () => {
    const payload = environmentPayloadFromDraft({
      name: '  CI  ',
      description: 'runner',
      hostingType: 'docker',
      dockerImage: ' node:22-slim ',
      dockerMemory: '512m',
      dockerCpu: '1.5',
      networkType: 'limited',
      allowMcpServerNetworkAccess: true,
      allowPackageManagerNetworkAccess: true,
      allowedHosts: 'example.com, api.example.com\ninternal.local',
      packages: { apt: '', cargo: '', gem: '', go: '', npm: ' typescript , tsx ', pip: 'requests\nrich' },
      metadata: [{ id: 'm1', key: 'Owner', value: ' Team ' }],
      preservedMetadata: { environment_keys: '[]' },
    });

    expect(payload).toMatchObject({
      name: 'CI',
      config: {
        hosting_type: 'docker',
        sandbox_provider: 'docker',
        image: 'node:22-slim',
        resources: { memory: '512m', cpu: 1.5 },
        network: {
          allowed_hosts: ['example.com', 'api.example.com', 'internal.local'],
        },
        packages: {
          type: 'packages',
          apt: [],
          cargo: [],
          gem: [],
          go: [],
          npm: ['typescript', 'tsx'],
          pip: ['requests', 'rich'],
        },
      },
      metadata: { environment_keys: '[]', owner: 'Team' },
    });
  });

  it('omits sandbox_provider for cloud hosting so the workspace default resolves it', () => {
    const payload = environmentPayloadFromDraft({
      name: 'Cloud',
      description: '',
      hostingType: 'cloud',
      dockerImage: '',
      dockerMemory: '',
      dockerCpu: '',
      networkType: 'limited',
      allowMcpServerNetworkAccess: false,
      allowPackageManagerNetworkAccess: false,
      allowedHosts: '',
      packages: { apt: '', cargo: '', gem: '', go: '', npm: '', pip: '' },
      metadata: [],
      preservedMetadata: {},
    });
    expect(payload.config.hosting_type).toBe('cloud');
    expect(payload.config.sandbox_provider).toBeUndefined();
  });

  it('reads the published packages object shape', () => {
    const draft = environmentDraftFromApi(environment({
      config: { packages: { type: 'packages', npm: ['zod'], pip: ['requests', 'rich'] } },
    }));
    expect(draft.packages.npm).toBe('zod');
    expect(draft.packages.pip).toBe('requests, rich');
    expect(draft.packages.apt).toBe('');
  });

  it('splits comma and newline separated host lists', () => {
    expect(splitCsv('a.com, b.com\nc.com')).toEqual(['a.com', 'b.com', 'c.com']);
  });
});

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: 'env_test',
    type: 'environment',
    name: 'Test',
    description: 'Test environment',
    config: { type: 'cloud', networking: { type: 'unrestricted' }, packages: { type: 'packages' } },
    effective_sandbox_provider: 'local',
    packages_enforced: false,
    networking_enforced: false,
    metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    archived_at: null,
    ...overrides,
  };
}
