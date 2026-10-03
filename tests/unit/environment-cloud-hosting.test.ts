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
  WORKSPACE_DEFAULT_SANDBOX_PROVIDER,
  workspaceDefaultSettingForEnvironmentConfig,
} from '@/sandbox/provider-names.js';

/**
 * `config.type: "cloud"` is the official "the platform decides" declaration.
 * This runtime has no managed cloud backend, so the platform it stands in for
 * is the workspace itself: `cloud` resolves to the same sandbox provider the
 * workspace's effective Settings select — never to a silently substituted
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

  it('resolves cloud to the workspace-default sentinel, not to a backend', () => {
    expect(sandboxProviderForHostingType('cloud', 'test')).toBe(WORKSPACE_DEFAULT_SANDBOX_PROVIDER);
    expect(sandboxProviderForEnvironmentConfig({ type: 'cloud' }, 'test')).toBe(WORKSPACE_DEFAULT_SANDBOX_PROVIDER);
    expect(sandboxProviderForEnvironmentConfig({ hosting_type: 'cloud' }, 'test'))
      .toBe(WORKSPACE_DEFAULT_SANDBOX_PROVIDER);
    // The write path accepts the declaration for either spelling.
    expect(hostingTypeError('cloud')).toBeUndefined();
    expect(hostingTypeError('edge_cluster')).toContain('edge_cluster');
  });

  it('seeds the workspace default from a cloud declaration the way an undeclared one seeds', () => {
    // Seeding happens when a cloud row is the only record a pre-Settings-V2
    // workspace has to derive its default from. `cloud` defers to the default,
    // so the seed is the same `local` an empty declaration produces — the
    // platform's answer to "the platform decides", not a substitution.
    expect(workspaceDefaultSettingForEnvironmentConfig({ type: 'cloud' }, 'test')).toBe('local');
    expect(workspaceDefaultSettingForEnvironmentConfig({}, 'test')).toBe('local');
    expect(workspaceDefaultSettingForEnvironmentConfig({ hosting_type: 'docker' }, 'test')).toBe('docker');
  });

  it('serves a cloud environment from the sandbox provider Settings selects', () => {
    insertEnvironment('env_default', { sandbox_provider: 'local', timeout: 300 });
    insertEnvironment('env_cloud', { type: 'cloud', networking: { type: 'unrestricted' } });
    insertEnvironment('env_explicit_local', { hosting_type: 'local' });
    insertEnvironment('env_self_hosted', { type: 'self_hosted' });

    const initial = getOrSeedRuntimeSettings(db, {}, tmpDir);
    const changed = {
      ...initial.saved_config,
      model: { ...initial.saved_config.model, api_key: 'test-key' },
      sandbox: {
        provider: 'docker' as const,
        options: { image: 'node:22-bookworm', timeout_seconds: 120 },
      },
    };
    const saved = saveRuntimeSettings(db, changed, initial.revision, tmpDir);
    expect(saved.ok).toBe(true);

    const composition = composeRuntimeFromSettings({
      db,
      dataDir: tmpDir,
      modelRegistry: new ModelRegistry(),
      sandboxProviders: ['local', 'docker'],
    });
    expect(composition.settings.activation_status).toBe('active');

    // `cloud` reads the effective Settings selection, options included.
    const cloud = composition.resolveEnvironmentConfig('env_cloud');
    expect(cloud?.sandbox_provider).toBe('docker');
    expect(cloud?.image).toBe('node:22-bookworm');
    // The workspace default keeps behaving the same way it always has.
    expect(composition.resolveEnvironmentConfig('env_default')?.sandbox_provider).toBe('docker');
    // Explicit declarations are not overridden by the workspace default.
    expect(composition.resolveEnvironmentConfig('env_explicit_local')?.sandbox_provider).toBe('local');
    expect(composition.resolveEnvironmentConfig('env_self_hosted')?.sandbox_provider).toBe('self_hosted');
  });

  it('keeps the cloud declaration on the stored record while resolving it away', () => {
    insertEnvironment('env_cloud', { type: 'cloud' });
    const composition = composeRuntimeFromSettings({
      db,
      dataDir: tmpDir,
      modelRegistry: new ModelRegistry(),
      sandboxProviders: ['local'],
    });
    const resolved = composition.resolveEnvironmentConfig('env_cloud');
    expect(resolved?.sandbox_provider).toBe('local');
    // `type` is part of the merged config, so the declaration survives the
    // resolution — the runtime does not rewrite what the caller declared.
    expect(resolved?.type).toBe('cloud');
  });
});
