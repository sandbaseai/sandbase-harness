import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { configModelWarnings, ensureDefaultEnvironment, loadRuntimeConfigBootstrap } from '@/core/runtime/config-bootstrap.js';

describe('runtime config bootstrap', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function makeDb() {
    const directory = mkdtempSync(join(tmpdir(), 'ma-runtime-config-'));
    directories.push(directory);
    const db = new Database(join(directory, 'data.db'));
    db.runMigrations();
    return { db, directory };
  }

  it('seeds the default environment exactly once', () => {
    const { db } = makeDb();

    ensureDefaultEnvironment(db);
    ensureDefaultEnvironment(db);

    const rows = db.prepare('SELECT id, name, config FROM environments WHERE id = ?').all('env_default') as Array<{ id: string; name: string; config: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'env_default', name: 'local' });
    expect(JSON.parse(rows[0].config)).toMatchObject({ sandbox_provider: 'local', timeout: 300 });
    db.close();
  });

  it('returns an empty bootstrap when config is missing', () => {
    const { db, directory } = makeDb();

    const bootstrap = loadRuntimeConfigBootstrap({
      db,
      configPath: join(directory, 'missing.yaml'),
      target: 'local',
    });

    expect(bootstrap).toEqual({ models: [], settingsSeed: {}, ignoredModelKeys: [] });
    db.close();
  });

  it('loads model connection overrides, memory, and environments', () => {
    const { db, directory } = makeDb();
    const configPath = join(directory, 'managed-agents.config.yaml');
    writeFileSync(configPath, [
      'memory:',
      '  enabled: true',
      '  provider: sqlite',
      'storage:',
      '  metadata:',
      '    provider: sqlite',
      '    options: {}',
      '  artifacts:',
      '    provider: local',
      '    options:',
      '      base_path: runtime-files',
      'model:',
      '  provider: openai',
      '  api_key: ${OPENAI_API_KEY}',
      'overrides:',
      '  cloud:',
      '    model:',
      '      base_url: https://example.test/v1',
      'environments:',
      '  ci:',
      '    sandbox_provider: local',
      '    timeout: 120',
      '',
    ].join('\n'));

    const bootstrap = loadRuntimeConfigBootstrap({ db, configPath, target: 'cloud' });

    expect(bootstrap.models).toEqual([expect.objectContaining({
      name: 'default',
      provider: 'openai',
      base_url: 'https://example.test/v1',
      api_key: '${OPENAI_API_KEY}',
      is_default: true,
    })]);
    expect(bootstrap.settingsSeed).toEqual({
      memory: { enabled: true, provider: 'sqlite', options: {} },
      storage: {
        metadata: { provider: 'sqlite', options: {} },
        artifacts: { provider: 'local', options: { base_path: 'runtime-files' } },
      },
    });
    const row = db.prepare('SELECT name, config FROM environments WHERE name = ?').get('ci') as { name: string; config: string } | undefined;
    expect(row?.name).toBe('ci');
    expect(JSON.parse(row?.config ?? '{}')).toMatchObject({ sandbox_provider: 'local', timeout: 120 });
    db.close();
  });
});

describe('config.yaml model settings that will not take effect', () => {
  const directories: string[] = [];
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function bootstrapFrom(yaml: string[], target = 'local') {
    const directory = mkdtempSync(join(tmpdir(), 'ma-runtime-config-'));
    directories.push(directory);
    const db = new Database(join(directory, 'data.db'));
    databases.push(db);
    db.runMigrations();
    const configPath = join(directory, 'config.yaml');
    writeFileSync(configPath, yaml.join('\n'));
    return loadRuntimeConfigBootstrap({ db, configPath, target });
  }

  it('names the model-section keys the bootstrap never applies', () => {
    // The workspace model section supplies connection settings only: a concrete
    // model id belongs to an Agent, and the vendor `options` bag has no column
    // in the model record this file seeds. Writing either used to be dropped
    // without a word.
    const bootstrap = bootstrapFrom([
      'model:',
      '  provider: openai_compatible',
      '  base_url: https://gateway.invalid/v1',
      '  api_key: literal-secret-value',
      '  model: deepseek-v4-flash',
      '  options:',
      '    reasoning_effort: high',
      '',
    ]);

    expect(bootstrap.ignoredModelKeys).toEqual(['model', 'options']);
    expect(bootstrap.declaredModel).toEqual({
      provider: 'openai_compatible',
      base_url: 'https://gateway.invalid/v1',
      api_key_declared: true,
    });
    // What startup reports for a divergence carries presence, never the value.
    expect(Object.keys(bootstrap.declaredModel ?? {})).not.toContain('api_key');
    const reported = JSON.stringify([
      bootstrap.declaredModel,
      configModelWarnings(bootstrap, { vendor: 'openai', api_key: 'stored', options: {} }),
    ]);
    expect(reported).not.toContain('literal-secret-value');

    // With the connection settings in agreement, the ignored keys are the only
    // thing reported.
    const warnings = configModelWarnings(bootstrap, {
      vendor: 'openai_compatible',
      base_url: 'https://gateway.invalid/v1',
      api_key: 'stored',
      options: {},
    });
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toContain('"model.model" is not applied');
    expect(warnings.join('\n')).toContain('"model.options" is not applied');
  });

  it('warns when config.yaml disagrees with the settings in effect', () => {
    // The repro this exists for: edit config.yaml, restart, and the runtime
    // keeps answering with the old endpoint and says nothing.
    const bootstrap = bootstrapFrom([
      'model:',
      '  provider: openai',
      '  base_url: https://from-yaml.invalid/v1',
      '  api_key: ${YAML_KEY}',
      '',
    ]);

    const warnings = configModelWarnings(bootstrap, {
      vendor: 'openai_compatible',
      base_url: 'https://in-effect.invalid/v1',
      api_key: 'stored-secret',
      options: {},
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('https://from-yaml.invalid/v1');
    expect(warnings[0]).toContain('https://in-effect.invalid/v1');
    expect(warnings[0]).toContain('Settings > Setup');
  });

  it('warns when config.yaml declares a key that is not in effect', () => {
    const bootstrap = bootstrapFrom([
      'model:',
      '  provider: openai',
      '  api_key: ${YAML_KEY}',
      '',
    ]);

    const warnings = configModelWarnings(bootstrap, {
      vendor: 'openai',
      options: {},
    });

    expect(warnings.join('\n')).toContain('declares an api_key but none is in effect');
  });

  it('stays quiet when config.yaml agrees with the settings in effect', () => {
    const bootstrap = bootstrapFrom([
      'model:',
      '  provider: openai',
      '  base_url: https://agreed.invalid/v1',
      '  api_key: ${SHARED_KEY}',
      '',
    ]);

    expect(configModelWarnings(bootstrap, {
      vendor: 'openai',
      base_url: 'https://agreed.invalid/v1',
      api_key: 'stored-secret',
      options: {},
    })).toEqual([]);
  });

  it('does not report an unresolved env placeholder as a base URL difference', () => {
    // `legacySettingsSeed` drops a base URL whose placeholder was not exported,
    // so both sides normalize to "unset" and the two agree.
    const bootstrap = bootstrapFrom([
      'model:',
      '  provider: openai',
      '  base_url: ${MISSING_BASE_URL}',
      '',
    ]);

    expect(configModelWarnings(bootstrap, {
      vendor: 'openai',
      api_key: 'stored-secret',
      options: {},
    })).toEqual([]);
  });
});
