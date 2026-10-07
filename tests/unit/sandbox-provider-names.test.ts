/**
 * The registry↔Settings V2 name alias.
 *
 * This translation used to be reimplemented at three call sites with
 * inconsistent behavior. Collapsing it to one module only pays off if the
 * round trip is pinned, since a regression here is a persistence bug: the
 * Settings V2 document already stored in `runtime_settings.config` spells the
 * self-hosted worker `remote`, and reading it back as anything else would point
 * live sessions at a different backend.
 */

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  ENVIRONMENT_CONFIG_ERROR_CODES,
  EnvironmentConfigError,
  hostingTypeError,
  isEnvironmentConfigError,
  parseEnvironmentConfig,
  publishedEnvironmentHostingType,
  readDeclaredHostingType,
  sandboxProviderForEnvironmentConfig,
  sandboxProviderForHostingType,
  sandboxProviderForSettings,
  sandboxSettingForProvider,
  WORKSPACE_DEFAULT_SANDBOX_PROVIDER,
  workspaceDefaultSettingForEnvironmentConfig,
  type SandboxSettingProvider,
} from '@/sandbox/provider-names.js';
import { Database } from '@/core/db/database.js';
import { getOrSeedRuntimeSettings } from '@/core/settings/store.js';
import { composeRuntimeFromSettings } from '@/core/runtime/composition.js';
import { ModelRegistry } from '@/model/registry.js';
import { SHIPPED_SANDBOX_PROVIDER_TYPES } from '@/types/sandbox.js';

const SETTING_PROVIDERS: SandboxSettingProvider[] = ['local', 'docker', 'kubernetes', 'remote'];

describe('sandboxSettingForProvider', () => {
  it('maps the self-hosted worker onto its persisted spelling', () => {
    expect(sandboxSettingForProvider('self_hosted')).toBe('remote');
    // Already-translated input stays put so callers can pass either vocabulary.
    expect(sandboxSettingForProvider('remote')).toBe('remote');
  });

  it('passes through backends that share a name across both vocabularies', () => {
    expect(sandboxSettingForProvider('local')).toBe('local');
    expect(sandboxSettingForProvider('docker')).toBe('docker');
    expect(sandboxSettingForProvider('kubernetes')).toBe('kubernetes');
  });

  it('returns undefined for a backend Settings V2 has no id for', () => {
    // Reporting "no id" is what lets callers surface an unusable selection
    // instead of substituting a different backend.
    expect(sandboxSettingForProvider('mystery')).toBeUndefined();
    expect(sandboxSettingForProvider('')).toBeUndefined();
  });

  it('has an id for every backend this build ships', () => {
    for (const type of SHIPPED_SANDBOX_PROVIDER_TYPES) {
      expect(sandboxSettingForProvider(type), type).toBeDefined();
    }
  });
});

describe('sandboxProviderForSettings', () => {
  it('maps the persisted remote id back to the registry type', () => {
    expect(sandboxProviderForSettings('remote')).toBe('self_hosted');
  });

  it('passes the shared names through', () => {
    expect(sandboxProviderForSettings('local')).toBe('local');
    expect(sandboxProviderForSettings('docker')).toBe('docker');
    expect(sandboxProviderForSettings('kubernetes')).toBe('kubernetes');
  });
});

describe('name alias round trip', () => {
  it('is stable from the Settings V2 side', () => {
    for (const provider of SETTING_PROVIDERS) {
      expect(sandboxSettingForProvider(sandboxProviderForSettings(provider)), provider).toBe(provider);
    }
  });

  it('is stable from the registry side', () => {
    for (const type of SHIPPED_SANDBOX_PROVIDER_TYPES) {
      const setting = sandboxSettingForProvider(type);
      expect(setting, type).toBeDefined();
      expect(sandboxProviderForSettings(setting!), type).toBe(type);
    }
  });
});

describe('environment hosting_type resolution', () => {
  it('translates every hosting type this runtime can serve', () => {
    const context = 'Environment env_x';
    expect(sandboxProviderForEnvironmentConfig({ hosting_type: 'local' }, context)).toBe('local');
    expect(sandboxProviderForEnvironmentConfig({ hosting_type: 'docker' }, context)).toBe('docker');
    expect(sandboxProviderForEnvironmentConfig({ hosting_type: 'kubernetes' }, context)).toBe('kubernetes');
    // `self_hosted` stays the public value for a machine the caller owns.
    expect(sandboxProviderForEnvironmentConfig({ hosting_type: 'self_hosted' }, context)).toBe('self_hosted');
  });

  it('resolves cloud hosting to the workspace-default sentinel, not to a backend', () => {
    // `cloud` is the official "the platform decides" value. The sentinel is a
    // resolution marker — the caller that owns the effective Settings swaps in
    // the workspace default, and nothing here pretends a managed cloud exists.
    expect(sandboxProviderForHostingType('cloud', 'Environment env_x'))
      .toBe(WORKSPACE_DEFAULT_SANDBOX_PROVIDER);
    expect(sandboxProviderForEnvironmentConfig({ hosting_type: 'cloud' }, 'Environment env_x'))
      .toBe(WORKSPACE_DEFAULT_SANDBOX_PROVIDER);
    expect(sandboxProviderForEnvironmentConfig({ type: 'cloud' }, 'Environment env_x'))
      .toBe(WORKSPACE_DEFAULT_SANDBOX_PROVIDER);
  });

  it('refuses a hosting type it does not know', () => {
    expect(hostingTypeError('team_server')).toContain('not a known hosting type');
    expect(hostingTypeError('cloud')).toBeUndefined();
    expect(hostingTypeError('docker')).toBeUndefined();
    expect(() => sandboxProviderForEnvironmentConfig({ hosting_type: 'team_server' }, 'Environment env_x'))
      .toThrow(EnvironmentConfigError);
  });

  it('lets an explicit backend win over a hosting descriptor', () => {
    expect(sandboxProviderForEnvironmentConfig(
      { hosting_type: 'docker', sandbox_provider: 'kubernetes' },
      'Environment env_x',
    )).toBe('kubernetes');
    // An unknown provider name is preserved for the registry to reject, which
    // is what keeps an out-of-tree backend usable.
    expect(sandboxProviderForEnvironmentConfig({ sandbox_provider: 'microsandbox' }, 'Environment env_x'))
      .toBe('microsandbox');
  });

  it('defaults only an Environment that declares nothing at all', () => {
    expect(sandboxProviderForEnvironmentConfig({}, 'Environment env_x')).toBe('local');
    expect(sandboxProviderForEnvironmentConfig({ timeout: 60 }, 'Environment env_x')).toBe('local');
    // A declared-but-empty value names no backend, so it is not a declaration.
    expect(sandboxProviderForEnvironmentConfig({ sandbox_provider: '   ' }, 'Environment env_x')).toBe('local');
  });

  it('refuses a stored config it cannot read', () => {
    expect(() => parseEnvironmentConfig('{oops', 'Environment env_x')).toThrow(EnvironmentConfigError);
    expect(() => parseEnvironmentConfig('"a string"', 'Environment env_x')).toThrow(EnvironmentConfigError);
    expect(() => parseEnvironmentConfig('[]', 'Environment env_x')).toThrow(EnvironmentConfigError);
    try {
      parseEnvironmentConfig('{oops', 'Environment env_x');
      expect.unreachable('an unreadable config must not resolve');
    } catch (err) {
      expect((err as EnvironmentConfigError).code).toBe(ENVIRONMENT_CONFIG_ERROR_CODES.invalidConfig);
      expect((err as Error).message).toContain('Environment env_x');
    }
    expect(parseEnvironmentConfig('{"hosting_type":"docker"}', 'Environment env_x')).toEqual({ hosting_type: 'docker' });
  });

  it('refuses a declaration that is not a name instead of reading it as absent', () => {
    // `sandbox_provider: 7` is a damaged record, not an Environment that
    // declares nothing: reading it as absent is what ran it locally.
    expect(() => sandboxProviderForEnvironmentConfig({ sandbox_provider: 7 }, 'Environment env_x'))
      .toThrow(/declares sandbox_provider as number/);
    expect(() => sandboxProviderForEnvironmentConfig({ hosting_type: { type: 'cloud' } }, 'Environment env_x'))
      .toThrow(/declares hosting_type as object/);
    // `null` and an empty string are how a client clears a field.
    expect(sandboxProviderForEnvironmentConfig({ sandbox_provider: null }, 'Environment env_x')).toBe('local');
    expect(sandboxProviderForEnvironmentConfig({ hosting_type: '' }, 'Environment env_x')).toBe('local');
    // Such a record does not read as a clean declaration either.
    expect(readDeclaredHostingType({ hosting_type: 7 }, 'Environment').ok).toBe(false);
    expect(readDeclaredHostingType({ hosting_type: [] }, 'Environment').ok).toBe(false);
  });

  it('projects the published two-value hosting axis', () => {
    // `self_hosted` only when the declaration names a caller-operated worker;
    // every backend this runtime itself serves is `cloud`, the published
    // "the platform decides" value.
    expect(publishedEnvironmentHostingType({ sandbox_provider: 'kubernetes' })).toBe('cloud');
    expect(publishedEnvironmentHostingType({ sandbox_provider: 'docker' })).toBe('cloud');
    expect(publishedEnvironmentHostingType({ sandbox_provider: 'self_hosted' })).toBe('self_hosted');
    expect(publishedEnvironmentHostingType({ hosting_type: 'self_hosted' })).toBe('self_hosted');
    expect(publishedEnvironmentHostingType({ type: 'self_hosted' })).toBe('self_hosted');
    expect(publishedEnvironmentHostingType({ hosting_type: 'cloud' })).toBe('cloud');
    // An unreadable declaration is `cloud` too — `effective_sandbox_provider`
    // is where "cannot be resolved" is reported.
    expect(publishedEnvironmentHostingType({ hosting_type: 'team_server' })).toBe('cloud');
    expect(publishedEnvironmentHostingType({})).toBe('cloud');
  });

  it('refuses to seed a workspace default with a backend Settings V2 cannot name', () => {
    expect(workspaceDefaultSettingForEnvironmentConfig({ hosting_type: 'self_hosted' }, 'The default'))
      .toBe('remote');
    // `cloud` defers to the workspace default, which is what the undeclared
    // seed is — `local`, the same value a config that declares nothing seeds.
    expect(workspaceDefaultSettingForEnvironmentConfig({ hosting_type: 'cloud' }, 'The default'))
      .toBe('local');
    expect(() => workspaceDefaultSettingForEnvironmentConfig({ sandbox_provider: 'microsandbox' }, 'The default'))
      .toThrow(EnvironmentConfigError);
  });

  it('reads the published config.type as the hosting type', () => {
    // Measured against the official TypeScript SDK at 0.131.0: this shape used
    // to be accepted and resolved to `local` because only `hosting_type` was read.
    expect(sandboxProviderForEnvironmentConfig({ type: 'self_hosted' }, 'Environment env_x')).toBe('self_hosted');
    expect(sandboxProviderForEnvironmentConfig({ type: 'docker' }, 'Environment env_x')).toBe('docker');
    expect(sandboxProviderForEnvironmentConfig({ type: 'kubernetes' }, 'Environment env_x')).toBe('kubernetes');
    expect(sandboxProviderForEnvironmentConfig({ type: 'local' }, 'Environment env_x')).toBe('local');
  });

  it('reads the published cloud hosting as the workspace-default declaration', () => {
    expect(sandboxProviderForEnvironmentConfig({ type: 'cloud' }, 'Environment env_x'))
      .toBe(WORKSPACE_DEFAULT_SANDBOX_PROVIDER);
    // An unrecognized published value is refused by name, not defaulted.
    try {
      sandboxProviderForEnvironmentConfig({ type: 'team_server' }, 'Environment env_x');
      expect.unreachable('an unknown published hosting type must not resolve');
    } catch (err) {
      expect((err as EnvironmentConfigError).code).toBe(ENVIRONMENT_CONFIG_ERROR_CODES.unsupportedHostingType);
      expect((err as Error).message).toContain('team_server');
    }
  });

  it('refuses two hosting spellings that disagree instead of picking one', () => {
    try {
      sandboxProviderForEnvironmentConfig({ type: 'docker', hosting_type: 'local' }, 'Environment env_x');
      expect.unreachable('a disagreeing hosting declaration must not resolve');
    } catch (err) {
      expect(isEnvironmentConfigError(err)).toBe(true);
      expect((err as EnvironmentConfigError).code).toBe(ENVIRONMENT_CONFIG_ERROR_CODES.invalidConfig);
      expect((err as Error).message).toContain('hosting_type "local"');
      expect((err as Error).message).toContain('type "docker"');
    }
    // Agreement is not a conflict, and the backend resolves as declared.
    expect(sandboxProviderForEnvironmentConfig(
      { type: 'docker', hosting_type: 'docker' },
      'Environment env_x',
    )).toBe('docker');
    // A whitespace-only value in one spelling names nothing, so it cannot conflict.
    expect(sandboxProviderForEnvironmentConfig(
      { type: 'docker', hosting_type: '   ' },
      'Environment env_x',
    )).toBe('docker');
  });

  it('refuses a published hosting declaration that cannot be a name', () => {
    expect(() => sandboxProviderForEnvironmentConfig({ type: { type: 'cloud' } }, 'Environment env_x'))
      .toThrow(/declares type as object/);
    expect(() => sandboxProviderForEnvironmentConfig({ type: 7 }, 'Environment env_x'))
      .toThrow(/declares type as number/);
    // `null` and an empty string are how a client clears a field.
    expect(sandboxProviderForEnvironmentConfig({ type: null }, 'Environment env_x')).toBe('local');
    expect(sandboxProviderForEnvironmentConfig({ type: '' }, 'Environment env_x')).toBe('local');
  });

  it('reports the published hosting type on the two-value axis', () => {
    expect(publishedEnvironmentHostingType({ type: 'self_hosted' })).toBe('self_hosted');
    expect(publishedEnvironmentHostingType({ type: 'cloud' })).toBe('cloud');
    expect(publishedEnvironmentHostingType({ type: 'team_server' })).toBe('cloud');
    // A declaration that is not a name projects `cloud` — "cannot be resolved"
    // is reported through `effective_sandbox_provider`, not the hosting axis.
    expect(publishedEnvironmentHostingType({ type: 7 })).toBe('cloud');
    // The hosting declaration is preferred to the backend on the axis.
    expect(publishedEnvironmentHostingType({ type: 'docker', sandbox_provider: 'local' })).toBe('cloud');
    expect(publishedEnvironmentHostingType({ sandbox_provider: 'docker' })).toBe('cloud');
    expect(publishedEnvironmentHostingType({})).toBe('cloud');
  });

  it('reports two stored spellings that disagree as unresolvable, not as runnable', () => {
    // Resolution refuses this record, so a projection naming one of the two
    // values would present a backend a session on it would not use.
    expect(readDeclaredHostingType({ hosting_type: 'local', type: 'docker' }, 'Environment').ok).toBe(false);
    expect(() => sandboxProviderForEnvironmentConfig(
      { hosting_type: 'local', type: 'docker' },
      'Environment env_x',
    )).toThrow(EnvironmentConfigError);
    // Agreement is readable, and so is either spelling alone.
    const agreed = readDeclaredHostingType({ hosting_type: 'docker', type: 'docker' }, 'Environment');
    expect(agreed.ok && agreed.value).toBe('docker');
    expect(publishedEnvironmentHostingType({ type: 'self_hosted' })).toBe('self_hosted');
  });
});

describe('the workspace default Environment seed', () => {
  it('seeds the platform default from a cloud env_default, like an undeclared row', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-provider-names-'));
    const db = new Database(join(directory, 'settings.db'));
    try {
      db.runMigrations();
      db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
      const first = getOrSeedRuntimeSettings(db, {}, directory);

      // `cloud` asks the workspace default to decide — which is exactly what a
      // seed is. It must not refuse boot the way an unservable concrete backend
      // does, and it must not seed anything but the platform default.
      db.exec(`UPDATE environments SET config = '{"type":"cloud"}' WHERE id = 'env_default'`);
      expect(() => getOrSeedRuntimeSettings(db, {}, directory)).not.toThrow();
      expect(getOrSeedRuntimeSettings(db, {}, directory).effective_config.sandbox)
        .toEqual(first.effective_config.sandbox);

      db.exec('DELETE FROM runtime_settings');
      const reseeded = getOrSeedRuntimeSettings(db, {}, directory);
      expect(reseeded.saved_config.sandbox.provider).toBe('local');
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('persisted remote settings', () => {
  it('reads an existing remote configuration back as the self-hosted backend', () => {
    // Simulates a workspace whose runtime_settings row predates this change.
    const directory = mkdtempSync(join(tmpdir(), 'ma-provider-names-'));
    const db = new Database(join(directory, 'settings.db'));
    try {
      db.runMigrations();
      db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
      const seeded = getOrSeedRuntimeSettings(db, {}, directory);
      db.prepare(`UPDATE runtime_settings SET config = ?, effective_config = ? WHERE id = 'default'`).run(
        JSON.stringify({
          ...seeded.saved_config,
          model: { ...seeded.saved_config.model, api_key: '${OPENAI_API_KEY}' },
          sandbox: { provider: 'remote', options: { timeout_seconds: 900, endpoint: 'https://worker.example.test' } },
        }),
        JSON.stringify({
          ...seeded.effective_config,
          sandbox: { provider: 'remote', options: { timeout_seconds: 900, endpoint: 'https://worker.example.test' } },
        }),
      );

      const runtime = composeRuntimeFromSettings({
        db,
        dataDir: directory,
        modelRegistry: new ModelRegistry(),
        settingsSeed: { memoryEnabled: false },
        sandboxProviders: ['local', 'self_hosted'],
      });

      expect(runtime.resolveEnvironmentConfig('env_default')).toMatchObject({
        sandbox_provider: 'self_hosted',
        timeout: 900,
      });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
