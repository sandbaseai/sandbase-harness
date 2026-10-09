import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { ModelRegistry } from '@/model/registry.js';
import { composeRuntimeFromSettings } from '@/core/runtime/composition.js';
import { getOrSeedRuntimeSettings, saveRuntimeSettings } from '@/core/settings/store.js';
import {
  hostingTypeError,
  sandboxProviderForEnvironmentConfig,
  sandboxProviderForHostingType,
  workspaceDefaultSettingForEnvironmentConfig,
} from '@/sandbox/provider-names.js';

/**
 * `config.type: "cloud"` is the official "the platform decides" declaration.
 * The managed service answers it with an Anthropic-owned container; this
 * runtime's equivalent is the `docker` backend on the operator's host with
 * the published reference sandbox image — never a silently substituted
 * `local`.
 */
describe('cloud hosting resolution', () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-cloud-hosting-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const insertEnvironment = (id: string, config: Record<string, unknown>) => {
    db.prepare('INSERT INTO environments (id, name, config) VALUES (?, ?, ?)')
      .run(id, id, JSON.stringify(config));
  };

  it('resolves cloud to the docker backend, not to the workspace default', () => {
    expect(sandboxProviderForHostingType('cloud', 'test')).toBe('docker');
    expect(sandboxProviderForEnvironmentConfig({ type: 'cloud' }, 'test')).toBe('docker');
    expect(sandboxProviderForEnvironmentConfig({ hosting_type: 'cloud' }, 'test'))
      .toBe('docker');
    // The write path accepts the declaration for either spelling.
    expect(hostingTypeError('cloud')).toBeUndefined();
    expect(hostingTypeError('edge_cluster')).toContain('edge_cluster');
  });

  it('seeds the workspace default from a cloud declaration as docker', () => {
    // Seeding happens when a cloud row is the only record a pre-Settings-V2
    // workspace has to derive its default from. `cloud` means docker here,
    // so that is the backend the seed names.
    expect(workspaceDefaultSettingForEnvironmentConfig({ type: 'cloud' }, 'test')).toBe('docker');
    expect(workspaceDefaultSettingForEnvironmentConfig({}, 'test')).toBe('local');
    expect(workspaceDefaultSettingForEnvironmentConfig({ hosting_type: 'docker' }, 'test')).toBe('docker');
  });

  it('serves a cloud environment on docker regardless of the workspace default', () => {
    insertEnvironment('env_default', { sandbox_provider: 'local', timeout: 300 });
    insertEnvironment('env_cloud', { type: 'cloud', networking: { type: 'unrestricted' } });
    insertEnvironment('env_explicit_local', { hosting_type: 'local' });
    insertEnvironment('env_self_hosted', { type: 'self_hosted' });

    const initial = getOrSeedRuntimeSettings(db, {}, tmpDir);
    const changed = {
      ...initial.saved_config,
      model: { ...initial.saved_config.model, api_key: 'test-key' },
      sandbox: {
        provider: 'kubernetes' as const,
        options: { image: 'node:22-bookworm', timeout_seconds: 120 },
      },
    };
    const saved = saveRuntimeSettings(db, changed, initial.revision, tmpDir);
    expect(saved.ok).toBe(true);

    const composition = composeRuntimeFromSettings({
      db,
      dataDir: tmpDir,
      modelRegistry: new ModelRegistry(),
      sandboxProviders: ['local', 'docker', 'kubernetes'],
    });
    expect(composition.settings.activation_status).toBe('active');

    // `cloud` resolves to docker itself; it does not read the Settings
    // selection the way `env_default` does.
    const cloud = composition.resolveEnvironmentConfig('env_cloud');
    expect(cloud?.sandbox_provider).toBe('docker');
    // The workspace default keeps reading the Settings selection.
    expect(composition.resolveEnvironmentConfig('env_default')?.sandbox_provider).toBe('kubernetes');
    // Explicit declarations are not overridden by the workspace default.
    expect(composition.resolveEnvironmentConfig('env_explicit_local')?.sandbox_provider).toBe('local');
    expect(composition.resolveEnvironmentConfig('env_self_hosted')?.sandbox_provider).toBe('self_hosted');
  });

  it('keeps the cloud declaration on the stored record while resolving it to docker', () => {
    insertEnvironment('env_cloud', { type: 'cloud' });
    const composition = composeRuntimeFromSettings({
      db,
      dataDir: tmpDir,
      modelRegistry: new ModelRegistry(),
      sandboxProviders: ['local', 'docker'],
    });
    const resolved = composition.resolveEnvironmentConfig('env_cloud');
    expect(resolved?.sandbox_provider).toBe('docker');
    // `type` is part of the merged config, so the declaration survives the
    // resolution — the runtime does not rewrite what the caller declared.
    expect(resolved?.type).toBe('cloud');
  });
});
