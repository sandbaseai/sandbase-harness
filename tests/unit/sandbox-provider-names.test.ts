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
  environmentHostingProjection,
  hostingTypeError,
  isEnvironmentConfigError,
  parseEnvironmentConfig,
  sandboxProviderForEnvironmentConfig,
  sandboxProviderForHostingType,
  sandboxProviderForSettings,
  sandboxSettingForProvider,
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

  it('refuses cloud hosting instead of resolving it to a backend', () => {
    // `cloud` names hosting on machines this runtime does not own. No backend
    // here can serve it, and reading it as `local` is what ran those sessions
    // unsandboxed on the runtime host.
    expect(() => sandboxProviderForHostingType('cloud', 'Environment env_x'))
      .toThrow(EnvironmentConfigError);
    try {
      sandboxProviderForHostingType('cloud', 'Environment env_x');
      expect.unreachable('cloud hosting must not resolve');
    } catch (err) {
      expect(isEnvironmentConfigError(err)).toBe(true);
      expect((err as EnvironmentConfigError).code).toBe(ENVIRONMENT_CONFIG_ERROR_CODES.unsupportedHostingType);
      expect((err as Error).message).toContain('Environment env_x');
      expect((err as Error).message).toContain('no cloud execution backend');
    }
  });

  it('refuses a hosting type it does not know', () => {
    expect(hostingTypeError('team_server')).toContain('not a known hosting type');
    expect(hostingTypeError('cloud')).toContain('no cloud execution backend');
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
    // Such a record is not reported as local either.
    expect(environmentHostingProjection({ sandbox_provider: 7 })).toBe('unknown');
    expect(environmentHostingProjection({ hosting_type: [] })).toBe('unknown');
  });

  it('reports hosting from the backend when no hosting type is declared', () => {
    // `kubernetes` used to be reported as `cloud`, which described hosting this
    // runtime does not have.
    expect(environmentHostingProjection({ sandbox_provider: 'kubernetes' })).toBe('kubernetes');
    expect(environmentHostingProjection({ sandbox_provider: 'docker' })).toBe('docker');
    expect(environmentHostingProjection({ sandbox_provider: 'self_hosted' })).toBe('self_hosted');
    expect(environmentHostingProjection({ hosting_type: 'self_hosted' })).toBe('self_hosted');
    // A declared hosting type is echoed, including one this build refuses, so
    // the operator can see what the record actually says.
    expect(environmentHostingProjection({ hosting_type: 'cloud' })).toBe('cloud');
    expect(environmentHostingProjection({ hosting_type: 'team_server' })).toBe('team_server');
    // Nothing declared resolves to the default backend the runtime uses.
    expect(environmentHostingProjection({})).toBe('local');
  });

  it('refuses to seed a workspace default with a backend Settings V2 cannot name', () => {
    expect(workspaceDefaultSettingForEnvironmentConfig({ hosting_type: 'self_hosted' }, 'The default'))
      .toBe('remote');
    expect(() => workspaceDefaultSettingForEnvironmentConfig({ hosting_type: 'cloud' }, 'The default'))
      .toThrow(EnvironmentConfigError);
    expect(() => workspaceDefaultSettingForEnvironmentConfig({ sandbox_provider: 'microsandbox' }, 'The default'))
      .toThrow(EnvironmentConfigError);
  });

  it('reads the published config.type as the hosting type', () => {
    // Measured against the official TypeScript SDK at 0.129.0: this shape used
    // to be accepted and resolved to `local` because only `hosting_type` was read.
    expect(sandboxProviderForEnvironmentConfig({ type: 'self_hosted' }, 'Environment env_x')).toBe('self_hosted');
    expect(sandboxProviderForEnvironmentConfig({ type: 'docker' }, 'Environment env_x')).toBe('docker');
    expect(sandboxProviderForEnvironmentConfig({ type: 'kubernetes' }, 'Environment env_x')).toBe('kubernetes');
    expect(sandboxProviderForEnvironmentConfig({ type: 'local' }, 'Environment env_x')).toBe('local');
  });

  it('refuses the published cloud hosting with the same code as the local spelling', () => {
    try {
      sandboxProviderForEnvironmentConfig({ type: 'cloud' }, 'Environment env_x');
      expect.unreachable('published cloud hosting must not resolve');
    } catch (err) {
      expect(isEnvironmentConfigError(err)).toBe(true);
      expect((err as EnvironmentConfigError).code).toBe(ENVIRONMENT_CONFIG_ERROR_CODES.unsupportedHostingType);
      expect((err as Error).message).toContain('no cloud execution backend');
    }
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

  it('reports the published hosting type as the local projection', () => {
    expect(environmentHostingProjection({ type: 'self_hosted' })).toBe('self_hosted');
    // Echoed even when this build refuses to execute it, like the local spelling.
    expect(environmentHostingProjection({ type: 'cloud' })).toBe('cloud');
    expect(environmentHostingProjection({ type: 'team_server' })).toBe('team_server');
    // A declaration that is not a name is not reported as the local default.
    expect(environmentHostingProjection({ type: 7 })).toBe('unknown');
    // The hosting declaration is preferred to the backend, which is how the
    // local `hosting_type` has always been projected.
    expect(environmentHostingProjection({ type: 'docker', sandbox_provider: 'local' })).toBe('docker');
    expect(environmentHostingProjection({ sandbox_provider: 'docker' })).toBe('docker');
    expect(environmentHostingProjection({})).toBe('local');
  });

  it('reports two stored spellings that disagree as unreadable, not as runnable', () => {
    // Resolution refuses this record, so a projection naming one of the two
    // values would present a backend a session on it would not use.
    expect(environmentHostingProjection({ hosting_type: 'local', type: 'docker' })).toBe('unknown');
    expect(() => sandboxProviderForEnvironmentConfig(
      { hosting_type: 'local', type: 'docker' },
      'Environment env_x',
    )).toThrow(EnvironmentConfigError);
    // Agreement is readable, and so is either spelling alone.
    expect(environmentHostingProjection({ hosting_type: 'docker', type: 'docker' })).toBe('docker');
    expect(environmentHostingProjection({ type: 'self_hosted' })).toBe('self_hosted');
  });
});

describe('the workspace default Environment seed', () => {
  it('refuses to seed from a published hosting type it cannot serve, and boots once settings exist', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-provider-names-'));
    const db = new Database(join(directory, 'settings.db'));
    try {
      db.runMigrations();
      db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
      const first = getOrSeedRuntimeSettings(db, {}, directory);

      // The row the version before this one wrote: it stored the published
      // shape verbatim, so the cloud declaration it ignored is now read.
      db.exec(`UPDATE environments SET config = '{"type":"cloud"}' WHERE id = 'env_default'`);
      // A workspace that already has settings boots: the row seeds nothing, and
      // the Environment refuses its own sessions instead.
      expect(() => getOrSeedRuntimeSettings(db, {}, directory)).not.toThrow();
      expect(getOrSeedRuntimeSettings(db, {}, directory).effective_config.sandbox)
        .toEqual(first.effective_config.sandbox);

      // With no settings row, the seed refuses rather than substituting local
      // for a workspace default that declares hosting it cannot serve.
      db.exec('DELETE FROM runtime_settings');
      expect(() => getOrSeedRuntimeSettings(db, {}, directory)).toThrow(/no cloud execution backend/);
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
