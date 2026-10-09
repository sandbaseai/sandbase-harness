import { describe, expect, it } from 'vitest';
import { normalizeRuntimeEnvironment } from '@/core/runtime/composition.js';
import { ENVIRONMENT_CONFIG_ERROR_CODES } from '@/sandbox/provider-names.js';

describe('runtime environment normalization', () => {
  it('defaults to local sandbox with a stable timeout', () => {
    expect(normalizeRuntimeEnvironment({
      id: 'env_default',
      name: 'local',
      config: '{}',
    })).toMatchObject({
      name: 'local',
      sandbox_provider: 'local',
      timeout: 300,
    });
  });

  it('maps self-hosted hosting type to self_hosted sandbox provider', () => {
    expect(normalizeRuntimeEnvironment({
      id: 'env_worker',
      name: 'worker',
      config: '{"hosting_type":"self_hosted","timeout":120}',
    })).toMatchObject({
      name: 'worker',
      sandbox_provider: 'self_hosted',
      timeout: 120,
    });
  });

  it('preserves explicit valid sandbox provider and config name', () => {
    expect(normalizeRuntimeEnvironment({
      id: 'env_docker',
      name: 'fallback',
      config: '{"name":"docker dev","sandbox_provider":"docker","network":{"type":"limited"}}',
    })).toMatchObject({
      name: 'docker dev',
      sandbox_provider: 'docker',
      network: { type: 'limited' },
    });
  });

  it('preserves the kubernetes provider and its nested settings', () => {
    expect(normalizeRuntimeEnvironment({
      id: 'env_k8s',
      name: 'cluster',
      config: '{"sandbox_provider":"kubernetes","kubernetes":{"namespace":"agents"}}',
    })).toMatchObject({
      sandbox_provider: 'kubernetes',
      kubernetes: { namespace: 'agents' },
    });
  });

  it('preserves an unknown provider so resolution can fail loudly later', () => {
    // Normalization must not rewrite a typo into the unsandboxed local
    // backend: the registry rejects it at provision time with a message
    // naming the registered providers.
    expect(normalizeRuntimeEnvironment({
      id: 'env_typo',
      name: 'typo',
      config: '{"sandbox_provider":"dokcer"}',
    })).toMatchObject({
      sandbox_provider: 'dokcer',
    });
  });

  it('honors docker and kubernetes declared only as hosting types', () => {
    // A `hosting_type` without `sandbox_provider` used to resolve to `local`,
    // so an Environment that asked for a container boundary ran on the host.
    expect(normalizeRuntimeEnvironment({
      id: 'env_docker_hosting',
      name: 'docker hosting',
      config: '{"hosting_type":"docker"}',
    })).toMatchObject({ sandbox_provider: 'docker' });

    expect(normalizeRuntimeEnvironment({
      id: 'env_k8s_hosting',
      name: 'k8s hosting',
      config: '{"hosting_type":"kubernetes"}',
    })).toMatchObject({ sandbox_provider: 'kubernetes' });

    expect(normalizeRuntimeEnvironment({
      id: 'env_local_hosting',
      name: 'local hosting',
      config: '{"hosting_type":"local"}',
    })).toMatchObject({ sandbox_provider: 'local' });
  });

  it('resolves cloud hosting to the docker backend', () => {
    // `cloud` is "the platform decides": this runtime's managed-cloud
    // substitute is a docker container on the operator's host.
    expect(normalizeRuntimeEnvironment({
      id: 'env_cloud',
      name: 'cloud',
      config: '{"hosting_type":"cloud"}',
    })).toMatchObject({ sandbox_provider: 'docker' });
  });

  it('resolves an explicitly named backend over the hosting descriptor', () => {
    // Resolution answers "where does this run": `sandbox_provider` wins, so a
    // cloud declaration with an explicit backend executes on that backend.
    expect(normalizeRuntimeEnvironment({
      id: 'env_cloud_docker',
      name: 'cloud docker',
      config: '{"hosting_type":"cloud","sandbox_provider":"docker"}',
    })).toMatchObject({ sandbox_provider: 'docker' });
  });

  it('refuses a stored config it cannot parse', () => {
    // A damaged row used to normalize to `{}` and therefore to local execution.
    try {
      normalizeRuntimeEnvironment({ id: 'env_damaged', name: 'damaged', config: '{oops' });
      expect.unreachable('a damaged config must not resolve');
    } catch (err) {
      expect((err as { code?: string }).code).toBe(ENVIRONMENT_CONFIG_ERROR_CODES.invalidConfig);
      expect((err as Error).message).toContain('env_damaged');
    }

    expect(() => normalizeRuntimeEnvironment({
      id: 'env_array',
      name: 'array',
      config: '[]',
    })).toThrow(/must be a JSON object/);
  });

  it('refuses a hosting type it does not know', () => {
    try {
      normalizeRuntimeEnvironment({
        id: 'env_unknown_hosting',
        name: 'unknown',
        config: '{"hosting_type":"team_server"}',
      });
      expect.unreachable('an unknown hosting type must not resolve');
    } catch (err) {
      expect((err as { code?: string }).code).toBe(ENVIRONMENT_CONFIG_ERROR_CODES.unsupportedHostingType);
    }
  });
});
