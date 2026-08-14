import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describeSettingsAdapters, availabilityFromDescriptors } from '@/core/settings/adapters.js';
import { validateRuntimeSettings, validateRuntimeSettingsCredentials, type RuntimeSettings } from '@/core/settings/schema.js';
import { testRuntimeSettingsArea, testRuntimeSettingsAreaWithFetch } from '@/core/settings/test.js';
import { Database } from '@/core/db/database.js';
import { activateRuntimeSettings, getOrSeedRuntimeSettings, localArtifactStorageDir, maskRuntimeSettings, modelConfigFromRuntimeSettings, runtimeSettingsSecretStates, saveRuntimeSettings } from '@/core/settings/store.js';
import { composeRuntimeFromSettings } from '@/core/runtime/composition.js';
import { ModelRegistry } from '@/model/registry.js';

// Typed rather than inferred: without the annotation the literal widens
// (`schema_version: number`, `provider: string`) and every spread of it into a
// RuntimeSettings parameter fails to type-check.
const validConfig: RuntimeSettings = {
  schema_version: 1,
  model: { vendor: 'openai', api_key: '${OPENAI_API_KEY}', options: {} },
  loop_engine: { provider: 'builtin', options: { default_max_steps: 25 } },
  storage: {
    metadata: { provider: 'sqlite', options: {} },
    artifacts: { provider: 'local', options: { base_path: 'files' } },
  },
  memory: { enabled: true, provider: 'sqlite', options: {} },
  sandbox: { provider: 'local', options: { timeout_seconds: 300 } },
};

describe('Settings V2 schema', () => {
  it('normalizes a valid built-in configuration', () => {
    const result = validateRuntimeSettings(validConfig);
    expect(result.valid).toBe(true);
    expect(result.normalized_config?.loop_engine.options.default_max_steps).toBe(25);
  });

  it('rejects unknown top-level keys', () => {
    const result = validateRuntimeSettings({ ...validConfig, unexpected: true });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === 'unrecognized_keys')).toBe(true);
  });

  it('rejects adapters that are planned but unavailable', () => {
    const result = validateRuntimeSettings({
      ...validConfig,
      loop_engine: { provider: 'codex', options: { default_max_steps: 25 } },
      memory: { enabled: true, provider: 'mem0', options: {} },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'loop_engine.provider', code: 'adapter_unavailable' }),
      expect.objectContaining({ path: 'memory.provider', code: 'adapter_unavailable' }),
    ]));
  });

  it('requires http or https base URLs and openai-compatible base_url', () => {
    const missing = validateRuntimeSettings({
      ...validConfig,
      model: { vendor: 'openai_compatible', api_key: '${OPENAI_API_KEY}', options: {} },
    });
    expect(missing.valid).toBe(false);
    expect(missing.errors).toContainEqual(expect.objectContaining({
      path: 'model.base_url',
      code: 'required',
    }));

    const invalidProtocol = validateRuntimeSettings({
      ...validConfig,
      model: { vendor: 'openai', base_url: 'ftp://api.example.test/v1', api_key: '${OPENAI_API_KEY}', options: {} },
    });
    expect(invalidProtocol.valid).toBe(false);
    expect(invalidProtocol.errors).toContainEqual(expect.objectContaining({
      path: 'model.base_url',
      code: 'invalid_protocol',
    }));
  });

  it('uses installed sandbox capabilities during validation', () => {
    const descriptors = describeSettingsAdapters(['local', 'docker']);
    const result = validateRuntimeSettings({
      ...validConfig,
      sandbox: { provider: 'docker', options: { timeout_seconds: 300 } },
    }, availabilityFromDescriptors(descriptors));
    expect(result.valid).toBe(true);
  });

  it('skips live health checks for registered Docker sandbox checks', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-sandbox-test-'));
    const db = new Database(join(directory, 'settings.db'));
    try {
      const result = await testRuntimeSettingsArea({
        db,
        dataDir: directory,
        area: 'sandbox',
        config: {
          ...validConfig,
          sandbox: { provider: 'docker', options: { timeout_seconds: 300 } },
        },
      });

      expect(result).toMatchObject({
        ok: true,
        area: 'sandbox',
        status: 'skipped',
        checks: [
          expect.objectContaining({
            name: 'sandbox_live_health',
            status: 'skipped',
          }),
        ],
      });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires a remote sandbox worker API URL during validation', () => {
    const descriptors = describeSettingsAdapters(['local', 'self_hosted']);
    const result = validateRuntimeSettings({
      ...validConfig,
      sandbox: { provider: 'remote', options: { timeout_seconds: 300, api_key: 'worker-key' } },
    }, availabilityFromDescriptors(descriptors));

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({
      path: 'sandbox.options.endpoint',
      code: 'required',
    }));
  });

  it('checks remote sandbox worker API health when configured', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-remote-sandbox-test-'));
    const db = new Database(join(directory, 'settings.db'));
    try {
      const result = await testRuntimeSettingsAreaWithFetch({
        db,
        dataDir: directory,
        area: 'sandbox',
        config: {
          ...validConfig,
          sandbox: {
            provider: 'remote',
            options: {
              timeout_seconds: 300,
              endpoint: 'https://worker.example.test',
              api_key: 'worker-key',
            },
          },
        },
      }, async (input, init) => {
        expect(String(input)).toBe('https://worker.example.test/v1/x/health');
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer worker-key');
        return new Response(JSON.stringify({ status: 'healthy' }), { status: 200 });
      });

      expect(result).toMatchObject({
        ok: true,
        area: 'sandbox',
        status: 'ok',
      });
      expect(result.checks).toContainEqual(expect.objectContaining({
        name: 'remote_health',
        status: 'ok',
      }));
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails remote sandbox health checks when the worker API is unreachable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-remote-sandbox-test-'));
    const db = new Database(join(directory, 'settings.db'));
    try {
      const result = await testRuntimeSettingsAreaWithFetch({
        db,
        dataDir: directory,
        area: 'sandbox',
        config: {
          ...validConfig,
          sandbox: {
            provider: 'remote',
            options: {
              timeout_seconds: 300,
              endpoint: 'https://worker.example.test',
              api_key: 'worker-key',
            },
          },
        },
      }, async () => new Response('nope', { status: 503 }));

      expect(result).toMatchObject({
        ok: false,
        area: 'sandbox',
        status: 'failed',
      });
      expect(result.checks).toContainEqual(expect.objectContaining({
        name: 'remote_health',
        status: 'failed',
        message: 'Remote sandbox worker API returned HTTP 503.',
      }));
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports unknown runtime sandbox providers as invalid capabilities', () => {
    const descriptors = describeSettingsAdapters(['local', 'mystery']);
    const availability = availabilityFromDescriptors(descriptors);

    expect(descriptors.sandbox).toContainEqual(expect.objectContaining({
      id: 'mystery',
      label: 'Unknown sandbox (mystery)',
      status: 'invalid',
    }));
    expect([...availability.sandboxProviders]).toEqual(['local']);
  });

  it('keeps adapter descriptor ids unique within each registry group', () => {
    const descriptors = describeSettingsAdapters(['local', 'docker', 'self_hosted', 'mystery']);
    const groups = [
      descriptors.model,
      descriptors.loop_engine,
      descriptors.storage.metadata,
      descriptors.storage.artifacts,
      descriptors.memory,
      descriptors.sandbox,
    ];

    for (const group of groups) {
      const ids = group.map((adapter) => adapter.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('keeps planned adapters out of the default saveable availability set', () => {
    const descriptors = describeSettingsAdapters();
    const availability = availabilityFromDescriptors(descriptors);

    expect([...availability.loopEngines]).toEqual(['builtin']);
    expect([...availability.metadataStorage]).toEqual(['sqlite']);
    expect([...availability.artifactStorage]).toEqual(['local']);
    expect([...availability.memoryProviders]).toEqual(['sqlite']);
    expect([...availability.sandboxProviders]).toEqual(['local']);
    expect(descriptors.loop_engine.find((adapter) => adapter.id === 'codex')?.status).toBe('unavailable');
    expect(descriptors.storage.artifacts.find((adapter) => adapter.id === 's3')?.status).toBe('unavailable');
    expect(descriptors.memory.find((adapter) => adapter.id === 'mem0')?.status).toBe('unavailable');
  });

  it('rejects missing and unresolved model credentials', () => {
    expect(validateRuntimeSettingsCredentials({ ...validConfig, model: { vendor: 'openai', options: {} } })).toContainEqual(
      expect.objectContaining({ path: 'model.api_key', code: 'required' }),
    );
    expect(validateRuntimeSettingsCredentials({ ...validConfig, model: { vendor: 'openai', api_key: '${SETTINGS_V2_MISSING_KEY}', options: {} } })).toContainEqual(
      expect.objectContaining({ path: 'model.api_key', code: 'missing_env' }),
    );
  });

  it('rejects unresolved and unbacked adapter option secrets', () => {
    const unresolved = validateRuntimeSettingsCredentials({
      ...validConfig,
      model: { vendor: 'openai', api_key: 'model-key', options: {} },
      memory: { enabled: true, provider: 'sqlite', options: { access_token: '${SETTINGS_V2_MISSING_MEMORY_KEY}' } },
    });
    expect(unresolved).toContainEqual(expect.objectContaining({
      path: 'memory.options.access_token',
      code: 'missing_env',
    }));

    const masked = validateRuntimeSettingsCredentials({
      ...validConfig,
      model: { vendor: 'openai', api_key: 'model-key', options: { access_key: '********', access_token: '********' } },
    });
    expect(masked).toContainEqual(expect.objectContaining({
      path: 'model.options.access_key',
      code: 'secret_not_configured',
    }));
    expect(masked).toContainEqual(expect.objectContaining({
      path: 'model.options.access_token',
      code: 'secret_not_configured',
    }));

    expect(validateRuntimeSettingsCredentials({
      ...validConfig,
      model: { vendor: 'openai', api_key: 'model-key', options: { access_key: '********' } },
    }, (path) => path === 'model.options.access_key')).toEqual([]);
  });

  it('does not require memory option credentials while memory is disabled', () => {
    expect(validateRuntimeSettingsCredentials({
      ...validConfig,
      model: { vendor: 'openai', api_key: 'model-key', options: {} },
      memory: { enabled: false, provider: 'mem0', options: { api_key: '${SETTINGS_V2_MISSING_DISABLED_MEMORY_KEY}' } },
    })).toEqual([]);
  });

  it('rejects unbacked or mismatched managed secret references', () => {
    expect(validateRuntimeSettingsCredentials({
      ...validConfig,
      model: { vendor: 'openai', api_key: '__managed_secret__:model.api_key', options: {} },
    })).toContainEqual(expect.objectContaining({
      path: 'model.api_key',
      code: 'secret_not_configured',
    }));

    expect(validateRuntimeSettingsCredentials({
      ...validConfig,
      model: { vendor: 'openai', api_key: '__managed_secret__:model.options.access_key', options: {} },
    }, () => true)).toContainEqual(expect.objectContaining({
      path: 'model.api_key',
      code: 'secret_not_configured',
    }));

    expect(validateRuntimeSettingsCredentials({
      ...validConfig,
      model: { vendor: 'openai', api_key: '__managed_secret__:model.api_key', options: {} },
    }, (path) => path === 'model.api_key')).toEqual([]);
  });
});

describe('Settings V2 activation', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('activates the saved revision on the next runtime start', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    const initial = getOrSeedRuntimeSettings(db);
    const changed = {
      ...initial.saved_config,
      model: { ...initial.saved_config.model, api_key: 'model-secret' },
      loop_engine: { provider: 'builtin' as const, options: { default_max_steps: 64 } },
    };
    const saved = saveRuntimeSettings(db, changed, initial.revision, directory);
    expect(saved.ok).toBe(true);
    expect(getOrSeedRuntimeSettings(db).restart_required).toBe(true);
    const activated = activateRuntimeSettings(db);
    expect(activated.restart_required).toBe(false);
    expect(activated.effective_config.loop_engine.options.default_max_steps).toBe(64);
    db.close();
  });

  it('retains the last valid effective settings when the saved config is corrupted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-corrupt-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    const initial = getOrSeedRuntimeSettings(db);
    const invalidSaved = {
      ...initial.saved_config,
      loop_engine: { provider: 'missing-engine', options: { default_max_steps: 64 } },
    };
    db.prepare(`
      UPDATE runtime_settings
      SET config = ?, revision = 2, restart_required = 1
      WHERE id = 'default'
    `).run(JSON.stringify(invalidSaved));

    const activated = activateRuntimeSettings(db);

    expect(activated.restart_required).toBe(true);
    expect(activated.revision).toBe(2);
    expect(activated.effective_revision).toBe(1);
    expect(activated.activation_status).toBe('failed');
    expect(activated.activation_errors).toContainEqual(expect.objectContaining({ path: 'loop_engine.provider' }));
    expect(activated.saved_config.loop_engine.options.default_max_steps).toBe(25);
    expect(activated.effective_config.loop_engine.options.default_max_steps).toBe(25);
    expect(getOrSeedRuntimeSettings(db).activation_status).toBe('failed');
    expect(getOrSeedRuntimeSettings(db).activation_errors).toContainEqual(expect.objectContaining({ path: 'loop_engine.provider' }));
    db.close();
  });

  it('rejects newer schema versions during activation without replacing the effective config', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-newer-schema-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    const initial = getOrSeedRuntimeSettings(db);
    db.prepare(`
      UPDATE runtime_settings
      SET config = ?, revision = 2, restart_required = 1
      WHERE id = 'default'
    `).run(JSON.stringify({
      ...initial.saved_config,
      schema_version: 2,
      loop_engine: { provider: 'builtin', options: { default_max_steps: 99 } },
    }));

    const activated = activateRuntimeSettings(db);

    expect(activated.activation_status).toBe('failed');
    expect(activated.activation_errors).toContainEqual(expect.objectContaining({
      path: 'schema_version',
      code: 'invalid_literal',
    }));
    expect(activated.effective_revision).toBe(1);
    expect(activated.effective_config.loop_engine.options.default_max_steps).toBe(25);
    db.close();
  });

  it('refuses to activate schema-valid settings that select unavailable adapters', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-unavailable-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    const initial = getOrSeedRuntimeSettings(db);
    const invalidSaved = {
      ...initial.saved_config,
      loop_engine: { provider: 'codex', options: { default_max_steps: 64 } },
    };
    db.prepare(`
      UPDATE runtime_settings
      SET config = ?, revision = 2, restart_required = 1
      WHERE id = 'default'
    `).run(JSON.stringify(invalidSaved));

    const activated = activateRuntimeSettings(db);

    expect(activated.restart_required).toBe(true);
    expect(activated.activation_status).toBe('failed');
    expect(activated.activation_errors).toContainEqual(expect.objectContaining({
      path: 'loop_engine.provider',
      code: 'adapter_unavailable',
    }));
    expect(activated.effective_revision).toBe(1);
    expect(activated.effective_config.loop_engine.provider).toBe('builtin');
    expect(getOrSeedRuntimeSettings(db).activation_status).toBe('failed');
    db.close();
  });

  it('clears activation failure state when a repaired settings revision is saved and activated', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-repair-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    const initial = getOrSeedRuntimeSettings(db);
    db.prepare(`
      UPDATE runtime_settings
      SET config = ?, revision = 2, restart_required = 1
      WHERE id = 'default'
    `).run(JSON.stringify({
      ...initial.saved_config,
      loop_engine: { provider: 'codex', options: { default_max_steps: 25 } },
    }));
    const failed = activateRuntimeSettings(db, {}, directory);
    expect(failed.activation_status).toBe('failed');
    expect(failed.activation_errors.length).toBeGreaterThan(0);

    const repaired = saveRuntimeSettings(db, {
      ...failed.effective_config,
      model: { ...failed.effective_config.model, api_key: 'repaired-model-secret' },
      loop_engine: { provider: 'builtin', options: { default_max_steps: 77 } },
    }, failed.revision, directory);

    expect(repaired.ok).toBe(true);
    if (repaired.ok) {
      expect(repaired.record.activation_status).toBe('pending');
      expect(repaired.record.activation_errors).toEqual([]);
      expect(repaired.record.effective_revision).toBe(1);
      const activated = activateRuntimeSettings(db, {}, directory);
      expect(activated.activation_status).toBe('active');
      expect(activated.activation_errors).toEqual([]);
      expect(activated.restart_required).toBe(false);
      expect(activated.effective_revision).toBe(repaired.record.revision);
      expect(activated.effective_config.loop_engine.options.default_max_steps).toBe(77);
    }
    db.close();
  });

  it('refuses to activate sandbox providers that are not registered in the runtime', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-sandbox-unavailable-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    const initial = getOrSeedRuntimeSettings(db);
    const dockerSaved = {
      ...initial.saved_config,
      model: { ...initial.saved_config.model, api_key: 'activation-secret' },
      sandbox: { provider: 'docker', options: { timeout_seconds: 300 } },
    };
    db.prepare(`
      UPDATE runtime_settings
      SET config = ?, revision = 2, restart_required = 1
      WHERE id = 'default'
    `).run(JSON.stringify(dockerSaved));

    const failed = activateRuntimeSettings(db, {}, directory, ['local']);

    expect(failed.activation_status).toBe('failed');
    expect(failed.activation_errors).toContainEqual(expect.objectContaining({
      path: 'sandbox.provider',
      code: 'adapter_unavailable',
    }));
    expect(failed.effective_config.sandbox.provider).toBe('local');

    const activated = activateRuntimeSettings(db, {}, directory, ['local', 'docker']);
    expect(activated.activation_status).toBe('active');
    expect(activated.effective_config.sandbox.provider).toBe('docker');
    db.close();
  });

  it('refuses to activate settings whose required credential no longer resolves', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-missing-env-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    const initial = getOrSeedRuntimeSettings(db);
    const invalidSaved = {
      ...initial.saved_config,
      model: { ...initial.saved_config.model, api_key: '${SETTINGS_V2_MISSING_ACTIVATION_KEY}' },
    };
    db.prepare(`
      UPDATE runtime_settings
      SET config = ?, revision = 2, restart_required = 1
      WHERE id = 'default'
    `).run(JSON.stringify(invalidSaved));

    const activated = activateRuntimeSettings(db);

    expect(activated.restart_required).toBe(true);
    expect(activated.activation_status).toBe('failed');
    expect(activated.activation_errors).toContainEqual(expect.objectContaining({
      path: 'model.api_key',
      code: 'missing_env',
    }));
    expect(activated.effective_revision).toBe(1);
    expect(activated.effective_config.model.api_key).toBeUndefined();
    const persisted = getOrSeedRuntimeSettings(db);
    expect(persisted.activation_status).toBe('failed');
    expect(persisted.activation_errors).toContainEqual(expect.objectContaining({
      path: 'model.api_key',
      code: 'missing_env',
    }));
    db.close();
  });

  it('encrypts sensitive adapter options and preserves masked values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-options-secret-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    const initial = getOrSeedRuntimeSettings(db);
    const changed = {
      ...initial.saved_config,
      model: { ...initial.saved_config.model, api_key: 'model-secret', options: { access_key: 'adapter-access-key', access_token: 'adapter-secret' } },
    };
    expect(saveRuntimeSettings(db, changed, initial.revision, directory).ok).toBe(true);
    const row = db.prepare(`SELECT config FROM runtime_settings WHERE id = 'default'`).get() as { config: string };
    expect(row.config).not.toContain('model-secret');
    expect(row.config).not.toContain('adapter-access-key');
    expect(row.config).not.toContain('adapter-secret');
    expect(db.prepare(`SELECT path FROM runtime_settings_secrets ORDER BY path`).all()).toEqual([
      { path: 'model.api_key' },
      { path: 'model.options.access_key' },
      { path: 'model.options.access_token' },
    ]);
    const masked = maskRuntimeSettings(getOrSeedRuntimeSettings(db).saved_config);
    expect(masked.model.options).toMatchObject({ access_key: '********', access_token: '********' });
    const saved = getOrSeedRuntimeSettings(db);
    expect(saveRuntimeSettings(db, { ...saved.saved_config, model: { ...saved.saved_config.model, api_key: '********', options: { access_key: '********', access_token: '********' } } }, saved.revision, directory).ok).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM runtime_settings_secrets`).get()).toEqual({ count: 3 });
    const preserved = getOrSeedRuntimeSettings(db);
    expect(saveRuntimeSettings(db, { ...preserved.saved_config, model: { vendor: 'openai', api_key: '${OPENAI_API_KEY}', options: {} } }, preserved.revision, directory).ok).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM runtime_settings_secrets`).get()).toEqual({ count: 0 });
    db.close();
  });

  it('keeps secrets referenced by the pending effective config until activation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-pending-secret-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    const initial = getOrSeedRuntimeSettings(db);
    expect(saveRuntimeSettings(db, {
      ...initial.saved_config,
      model: { ...initial.saved_config.model, api_key: 'model-secret', options: { access_key: 'adapter-access-key' } },
    }, initial.revision, directory).ok).toBe(true);
    activateRuntimeSettings(db, {}, directory);
    const active = getOrSeedRuntimeSettings(db);

    const previousOpenAiKey = process.env.SETTINGS_V2_PRESENT_OPENAI_KEY;
    process.env.SETTINGS_V2_PRESENT_OPENAI_KEY = 'present';
    try {
      expect(saveRuntimeSettings(db, {
        ...active.saved_config,
        model: { vendor: 'openai', api_key: '${SETTINGS_V2_PRESENT_OPENAI_KEY}', options: {} },
      }, active.revision, directory).ok).toBe(true);

      expect(db.prepare(`SELECT path FROM runtime_settings_secrets ORDER BY path`).all()).toEqual([
        { path: 'model.api_key' },
        { path: 'model.options.access_key' },
      ]);

      activateRuntimeSettings(db, {}, directory);

      expect(db.prepare(`SELECT COUNT(*) AS count FROM runtime_settings_secrets`).get()).toEqual({ count: 0 });
    } finally {
      if (previousOpenAiKey === undefined) delete process.env.SETTINGS_V2_PRESENT_OPENAI_KEY;
      else process.env.SETTINGS_V2_PRESENT_OPENAI_KEY = previousOpenAiKey;
    }
    db.close();
  });

  it('reports model secret state from the saved config instead of retained effective secrets', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-secret-state-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    const initial = getOrSeedRuntimeSettings(db);
    expect(saveRuntimeSettings(db, {
      ...initial.saved_config,
      model: { ...initial.saved_config.model, api_key: 'model-secret', options: {} },
    }, initial.revision, directory).ok).toBe(true);
    activateRuntimeSettings(db, {}, directory);
    const active = getOrSeedRuntimeSettings(db);

    expect(saveRuntimeSettings(db, {
      ...active.saved_config,
      model: { vendor: 'openai', api_key: '${SETTINGS_V2_MISSING_MODEL_KEY}', options: {} },
    }, active.revision, directory).ok).toBe(true);
    const pendingEnv = getOrSeedRuntimeSettings(db);

    expect(runtimeSettingsSecretStates(db, pendingEnv.saved_config).model.api_key).toBe('missing_env');
    expect(db.prepare(`SELECT path FROM runtime_settings_secrets`).all()).toEqual([{ path: 'model.api_key' }]);

    db.close();
  });

  it('builds the default runtime model from the effective settings without a UI model ID', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-model-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    const initial = getOrSeedRuntimeSettings(db);
    const config = {
      ...initial.effective_config,
      model: { vendor: 'anthropic' as const, options: { reasoning_effort: 'max' } },
    };
    const model = modelConfigFromRuntimeSettings(db, config, directory);
    expect(model).toMatchObject({ name: 'default', provider: 'anthropic', reasoning_effort: 'max' });
    expect(model.model).toBeUndefined();
    db.close();
  });

  it('seeds workspaces without a legacy model row as OpenAI instead of openai-compatible', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-legacy-model-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();

    const settings = getOrSeedRuntimeSettings(db);

    expect(settings.saved_config.model.vendor).toBe('openai');
    expect(settings.saved_config.model.base_url).toBeUndefined();
    expect(validateRuntimeSettings(settings.saved_config).valid).toBe(true);
    db.close();
  });

  it('does not seed unresolved environment placeholders as Settings V2 model URLs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-placeholder-url-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    db.prepare(`
      INSERT INTO models (name, provider, model, base_url, api_key, config, is_default)
      VALUES (?, ?, ?, ?, ?, '{}', 1)
    `).run('default', 'openai', 'gpt-4o', '${OPENAI_BASE_URL}', '${OPENAI_API_KEY}');

    const settings = getOrSeedRuntimeSettings(db, {}, directory);

    expect(settings.saved_config.model).toMatchObject({
      vendor: 'openai',
      api_key: '${OPENAI_API_KEY}',
      options: {},
    });
    expect(settings.saved_config.model.base_url).toBeUndefined();
    expect(validateRuntimeSettings(settings.saved_config).valid).toBe(true);
    db.close();
  });

  it('seeds resolved environment model URLs into Settings V2', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-resolved-url-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    process.env.TEST_MANAGED_AGENTS_BASE_URL = 'https://models.example.test/v1';
    db.prepare(`
      INSERT INTO models (name, provider, model, base_url, api_key, config, is_default)
      VALUES (?, ?, ?, ?, ?, '{}', 1)
    `).run('default', 'openai', 'gpt-4o', '${TEST_MANAGED_AGENTS_BASE_URL}', '${OPENAI_API_KEY}');

    const settings = getOrSeedRuntimeSettings(db, {}, directory);

    expect(settings.saved_config.model.base_url).toBe('https://models.example.test/v1');
    expect(validateRuntimeSettings(settings.saved_config).valid).toBe(true);
    db.close();
    delete process.env.TEST_MANAGED_AGENTS_BASE_URL;
  });

  it('seeds Settings V2 memory enablement from runtime bootstrap configuration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-memory-seed-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();

    const settings = getOrSeedRuntimeSettings(db, { memoryEnabled: true }, directory);

    expect(settings.saved_config.memory).toMatchObject({
      enabled: true,
      provider: 'sqlite',
    });
    db.close();
  });

  it('seeds the workspace sandbox fallback from the default Environment record', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-environment-seed-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    db.prepare(`INSERT INTO environments (id, name, config) VALUES (?, ?, ?)`).run(
      'env_default',
      'default',
      JSON.stringify({ sandbox_provider: 'self_hosted', timeout: 900 }),
    );

    const settings = getOrSeedRuntimeSettings(db, {}, directory);

    expect(settings.saved_config.sandbox).toEqual({
      provider: 'remote',
      options: { timeout_seconds: 900 },
    });
    db.close();
  });

  it('ignores fake legacy provider rows that were never wired to the runtime', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-legacy-provider-rows-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    db.exec(`UPDATE memory_providers SET is_default = 0`);
    db.prepare(`
      INSERT INTO memory_providers (name, provider, connection_url, api_key, config, is_default, status)
      VALUES (?, ?, ?, ?, ?, 1, 'active')
    `).run('fake-mem0', 'mem0', 'https://mem0.example.test', 'legacy-memory-secret', '{}');
    db.exec(`UPDATE storage_providers SET is_default = 0 WHERE role IN ('metadata', 'artifact')`);
    db.prepare(`
      INSERT INTO storage_providers (name, role, provider, connection_url, config, is_default, status, initialized_at)
      VALUES (?, 'metadata', 'postgres', ?, '{}', 1, 'active', datetime('now'))
    `).run('fake-postgres', 'postgres://db.example.test/app');
    db.prepare(`
      INSERT INTO storage_providers (name, role, provider, bucket, region, access_key, secret_key, config, is_default, status, initialized_at)
      VALUES (?, 'artifact', 's3', ?, ?, ?, ?, '{}', 1, 'active', datetime('now'))
    `).run('fake-s3', 'settings-bucket', 'us-east-1', 'legacy-access-key', 'legacy-secret-key');

    const settings = getOrSeedRuntimeSettings(db, { memoryEnabled: true }, directory);

    expect(settings.saved_config.memory).toMatchObject({
      enabled: true,
      provider: 'sqlite',
      options: {},
    });
    expect(settings.saved_config.storage).toMatchObject({
      metadata: { provider: 'sqlite', options: {} },
      artifacts: { provider: 'local', options: { base_path: 'files' } },
    });
    expect(JSON.stringify(settings.saved_config)).not.toContain('legacy-memory-secret');
    expect(JSON.stringify(settings.saved_config)).not.toContain('legacy-access-key');
    expect(JSON.stringify(settings.saved_config)).not.toContain('legacy-secret-key');
    db.close();
  });

  it('imports literal legacy model secrets into encrypted Settings V2 storage', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-legacy-secret-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    db.prepare('INSERT INTO models (name, provider, model, api_key, is_default) VALUES (?, ?, ?, ?, 1)').run(
      'legacy',
      'openai',
      'gpt-4o',
      'legacy-secret-value',
    );

    const settings = getOrSeedRuntimeSettings(db, {}, directory);
    const row = db.prepare(`SELECT config FROM runtime_settings WHERE id = 'default'`).get() as { config: string };
    const legacyModel = db.prepare('SELECT api_key FROM models WHERE name = ?').get('legacy') as { api_key: string | null };

    expect(settings.saved_config.model.api_key).toBe('__managed_secret__:model.api_key');
    expect(row.config).not.toContain('legacy-secret-value');
    expect(db.prepare(`SELECT path FROM runtime_settings_secrets`).get()).toEqual({ path: 'model.api_key' });
    expect(legacyModel.api_key).toBeNull();
    db.close();
  });

  it('rolls back secret mutations when the settings update fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-rollback-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    const initial = getOrSeedRuntimeSettings(db);
    db.exec(`CREATE TRIGGER reject_runtime_settings_update BEFORE UPDATE ON runtime_settings BEGIN SELECT RAISE(ABORT, 'rejected'); END`);
    expect(() => saveRuntimeSettings(db, {
      ...initial.saved_config,
      model: { ...initial.saved_config.model, api_key: 'must-rollback', options: {} },
    }, initial.revision, directory)).toThrow(/rejected/);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM runtime_settings_secrets`).get()).toEqual({ count: 0 });
    expect(getOrSeedRuntimeSettings(db).revision).toBe(1);
    db.close();
  });

  it('resolves local artifact storage beneath the runtime data directory', () => {
    expect(localArtifactStorageDir('/tmp/runtime', validConfig)).toBe('/tmp/runtime/files');
    expect(() => localArtifactStorageDir('/tmp/runtime', {
      ...validConfig,
      storage: { ...validConfig.storage, artifacts: { provider: 'local' as const, options: { base_path: '../escape' } } },
    })).toThrow(/inside the runtime data directory/);
  });

  it('composes runtime settings into model, memory, artifact, and environment defaults', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-runtime-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_named', 'docker-env', '{"sandbox_provider":"docker","timeout":900}')`);
    const initial = getOrSeedRuntimeSettings(db);
    const changed = {
      ...initial.saved_config,
      model: { ...initial.saved_config.model, api_key: 'model-secret' },
      memory: { enabled: false, provider: 'sqlite' as const, options: {} },
      sandbox: { provider: 'local' as const, options: { timeout_seconds: 123 } },
      storage: {
        ...initial.saved_config.storage,
        artifacts: { provider: 'local' as const, options: { base_path: 'artifacts-v2' } },
      },
    };
    expect(saveRuntimeSettings(db, changed, initial.revision, directory).ok).toBe(true);
    const registry = new ModelRegistry();
    const runtime = composeRuntimeFromSettings({
      db,
      dataDir: directory,
      modelRegistry: registry,
      settingsSeed: { memoryEnabled: true },
    });

    expect(registry.getDefaultName()).toBe('default');
    expect(runtime.memory).toBeUndefined();
    expect(runtime.artifactStore.rootPath()).toBe(join(directory, 'artifacts-v2'));
    expect(runtime.resolveEnvironmentConfig('env_default')).toMatchObject({ sandbox_provider: 'local', timeout: 123 });
    expect(runtime.resolveEnvironmentConfig('env_named')).toMatchObject({ sandbox_provider: 'docker', timeout: 900 });
    db.close();
  });

  it('uses runtime sandbox availability while composing pending settings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-runtime-sandbox-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    const initial = getOrSeedRuntimeSettings(db);
    const changed = {
      ...initial.saved_config,
      model: { ...initial.saved_config.model, api_key: 'model-secret' },
      sandbox: { provider: 'docker' as const, options: { timeout_seconds: 321 } },
    };
    expect(saveRuntimeSettings(db, changed, initial.revision, directory).ok).toBe(true);

    const localOnly = composeRuntimeFromSettings({
      db,
      dataDir: directory,
      modelRegistry: new ModelRegistry(),
      settingsSeed: { memoryEnabled: false },
      sandboxProviders: ['local'],
    });
    expect(localOnly.settings.activation_status).toBe('failed');
    expect(localOnly.resolveEnvironmentConfig('env_default')).toMatchObject({ sandbox_provider: 'local' });

    const dockerCapable = composeRuntimeFromSettings({
      db,
      dataDir: directory,
      modelRegistry: new ModelRegistry(),
      settingsSeed: { memoryEnabled: false },
      sandboxProviders: ['local', 'docker'],
    });
    expect(dockerCapable.settings.activation_status).toBe('active');
    expect(dockerCapable.resolveEnvironmentConfig('env_default')).toMatchObject({ sandbox_provider: 'docker', timeout: 321 });
    db.close();
  });
});

describe('Settings V2 sandbox options reach the sandbox provider', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function seedWorkspace(sandbox: Record<string, unknown>) {
    const directory = mkdtempSync(join(tmpdir(), 'ma-settings-sandbox-options-'));
    directories.push(directory);
    const db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    const initial = getOrSeedRuntimeSettings(db);
    expect(saveRuntimeSettings(db, {
      ...initial.saved_config,
      model: { ...initial.saved_config.model, api_key: 'model-secret' },
      sandbox: sandbox as never,
    }, initial.revision, directory).ok).toBe(true);
    return { db, directory };
  }

  it('projects kubernetes options onto the Environment the provider consumes', () => {
    // Regression guard: these options are what the Console form writes. They
    // used to be dropped between Settings V2 and EnvironmentConfig, so a
    // configured namespace/context/ServiceAccount silently had no effect and
    // Pods landed in `default` with the ambient context.
    const { db, directory } = seedWorkspace({
      provider: 'kubernetes',
      options: {
        timeout_seconds: 600,
        image: 'python:3.12-slim',
        namespace: 'agent-sandboxes',
        context: 'staging',
        kubeconfig: '/tmp/kubeconfig',
        service_account: 'agent-runner',
      },
    });

    const runtime = composeRuntimeFromSettings({
      db,
      dataDir: directory,
      modelRegistry: new ModelRegistry(),
      settingsSeed: { memoryEnabled: false },
      sandboxProviders: ['local', 'kubernetes'],
    });

    expect(runtime.settings.activation_status).toBe('active');
    expect(runtime.resolveEnvironmentConfig('env_default')).toMatchObject({
      sandbox_provider: 'kubernetes',
      timeout: 600,
      image: 'python:3.12-slim',
      kubernetes: {
        namespace: 'agent-sandboxes',
        context: 'staging',
        kubeconfig: '/tmp/kubeconfig',
        service_account: 'agent-runner',
      },
    });
    db.close();
  });

  it('omits backend-specific keys that were left blank', () => {
    // An empty ServiceAccount must stay absent rather than becoming "", since
    // the Pod manifest keys token mounting off its presence.
    const { db, directory } = seedWorkspace({
      provider: 'kubernetes',
      options: { timeout_seconds: 300, namespace: 'agents', context: '   ', service_account: '' },
    });

    const config = composeRuntimeFromSettings({
      db,
      dataDir: directory,
      modelRegistry: new ModelRegistry(),
      settingsSeed: { memoryEnabled: false },
      sandboxProviders: ['local', 'kubernetes'],
    }).resolveEnvironmentConfig('env_default');

    expect(config?.kubernetes).toEqual({ namespace: 'agents' });
    expect(config?.image).toBeUndefined();
    db.close();
  });

  it('leaves the kubernetes block absent for backends that do not use it', () => {
    const { db, directory } = seedWorkspace({
      provider: 'local',
      options: { timeout_seconds: 300 },
    });

    const config = composeRuntimeFromSettings({
      db,
      dataDir: directory,
      modelRegistry: new ModelRegistry(),
      settingsSeed: { memoryEnabled: false },
      sandboxProviders: ['local'],
    }).resolveEnvironmentConfig('env_default');

    expect(config).toMatchObject({ sandbox_provider: 'local' });
    expect(config?.kubernetes).toBeUndefined();
    db.close();
  });
});
