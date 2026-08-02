import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RuntimeSettingsEditor,
  applyRuntimeSettingsDefaults,
  mergeRuntimeSettingsSectionJson,
  preserveCandidateSecrets,
  runtimeSettingsSectionJson,
} from '../../apps/console/src/components/pages/settings/RuntimeSettingsEditor';
import { SettingsGeneral } from '../../apps/console/src/components/pages/settings/SettingsGeneral';
import { SettingsLogs } from '../../apps/console/src/components/pages/settings/SettingsLogs';
import {
  LoopEngineSettingsForm,
  MemorySettingsForm,
  ModelSettingsForm,
  SandboxSettingsForm,
  StorageSettingsForm,
  optionDefaultsForAdapter,
} from '../../apps/console/src/components/pages/settings/RuntimeSettingsForms';
import type { ConsoleData, RuntimeSettings, RuntimeSettingsConfig } from '../../apps/console/src/types';

const config: RuntimeSettingsConfig = {
  schema_version: 1,
  model: { vendor: 'openai', options: {} },
  loop_engine: { provider: 'builtin', options: { default_max_steps: 25 } },
  storage: { metadata: { provider: 'sqlite', options: {} }, artifacts: { provider: 'local', options: { base_path: 'files' } } },
  memory: { enabled: true, provider: 'sqlite', options: {} },
  sandbox: { provider: 'local', options: { timeout_seconds: 300 } },
};

const metadataStorageAdapters = [
  { id: 'sqlite', label: 'SQLite', status: 'available' as const, options_schema: {} },
  {
    id: 'postgres',
    label: 'Postgres',
    status: 'unavailable' as const,
    options_schema: { type: 'object', properties: { connection_string: { type: 'string', default: '${DATABASE_URL}' } } },
  },
  {
    id: 'mysql',
    label: 'MySQL',
    status: 'unavailable' as const,
    options_schema: { type: 'object', properties: { connection_string: { type: 'string', default: '${DATABASE_URL}' } } },
  },
];

const artifactStorageAdapters = [
  {
    id: 'local',
    label: 'Local filesystem',
    status: 'available' as const,
    options_schema: { type: 'object', properties: { base_path: { type: 'string', default: 'files' } } },
  },
  {
    id: 's3',
    label: 'S3-compatible',
    status: 'unavailable' as const,
    options_schema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', default: 'https://s3.amazonaws.com' },
        bucket: { type: 'string', default: '${S3_BUCKET}' },
        region: { type: 'string', default: '${AWS_REGION}' },
        access_key: { type: 'string', default: '${AWS_ACCESS_KEY_ID}' },
        secret_key: { type: 'string', default: '${AWS_SECRET_ACCESS_KEY}' },
        force_path_style: { type: 'boolean', default: false },
      },
    },
  },
];

describe('Runtime Settings forms', () => {
  it('renders field-level validation errors', () => {
    const html = renderToStaticMarkup(<ModelSettingsForm adapters={[{ id: 'openai', label: 'OpenAI', status: 'available' }]} config={config} onChange={() => {}} apiKeyConfigured={false} errors={{ 'model.api_key': 'A model API key is required' }} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('A model API key is required');
  });

  it('preserves newly-entered secrets after validate returns a masked normalized config', () => {
    const candidate = {
      ...config,
      model: {
        ...config.model,
        api_key: 'new-model-secret',
        options: {
          access_key: 'new-access-key',
          normal: 'value',
        },
      },
    };
    const normalized = {
      ...candidate,
      model: {
        ...candidate.model,
        api_key: '********',
        options: {
          access_key: '********',
          normal: 'value',
        },
      },
    };

    expect(preserveCandidateSecrets(normalized, candidate).model).toMatchObject({
      api_key: 'new-model-secret',
      options: {
        access_key: 'new-access-key',
        normal: 'value',
      },
    });
    expect(preserveCandidateSecrets(normalized, {
      ...candidate,
      model: {
        ...candidate.model,
        api_key: '********',
        options: { access_key: '********', normal: 'value' },
      },
    }).model).toMatchObject({
      api_key: '********',
      options: { access_key: '********' },
    });
  });

  it('shows JSON for only the selected settings section', () => {
    const sandboxJson = runtimeSettingsSectionJson(config, 'sandbox');

    expect(sandboxJson).toContain('"provider": "local"');
    expect(sandboxJson).toContain('"timeout_seconds": 300');
    expect(sandboxJson).not.toContain('"storage"');
    expect(sandboxJson).not.toContain('"memory"');
    expect(sandboxJson).not.toContain('"model"');
  });

  it('formats model JSON with top-level fields first and options last', () => {
    const modelJson = runtimeSettingsSectionJson({
      ...config,
      model: {
        vendor: 'openai',
        base_url: 'https://api.openai.com/v1',
        api_key: '${OPENAI_API_KEY}',
        options: {},
      },
    }, 'models');

    expect(modelJson).toBe(`{
  "vendor": "openai",
  "base_url": "https://api.openai.com/v1",
  "api_key": "\${OPENAI_API_KEY}",
  "options": {}
}`);
    expect(modelJson).not.toContain('"temperature"');
    expect(modelJson).not.toContain('"max_tokens"');
  });

  it('merges section JSON back into the full runtime settings document', () => {
    const merged = mergeRuntimeSettingsSectionJson(config, 'sandbox', '{ "provider": "local", "options": { "timeout_seconds": 120 } }');

    expect(merged?.sandbox).toEqual({ provider: 'local', options: { timeout_seconds: 120 } });
    expect(merged?.model).toEqual(config.model);
    expect(merged?.storage).toEqual(config.storage);
    expect(mergeRuntimeSettingsSectionJson(config, 'sandbox', '{')).toBeNull();
  });

  it('makes masked API key preservation explicit', () => {
    const html = renderToStaticMarkup(<ModelSettingsForm adapters={[{ id: 'openai', label: 'OpenAI', status: 'available' }]} config={{ ...config, model: { ...config.model, api_key: '********' } }} onChange={() => {}} apiKeyConfigured={true} />);
    expect(html).toContain('placeholder="********"');
    expect(html).toContain('The full key is stored encrypted');
    expect(html).toContain('Keep ******** to preserve it');
  });

  it('renders metadata diagnostics and vertically flattened artifact settings', () => {
    const html = renderToStaticMarkup(
      <StorageSettingsForm
        metadataAdapters={metadataStorageAdapters}
        artifactAdapters={artifactStorageAdapters}
        config={config}
        onChange={() => {}}
        diagnostics={{ path: '/tmp/data.db', health: 'ok' }}
      />,
    );
    expect(html).toContain('/tmp/data.db');
    expect(html).toContain('Metadata storage');
    expect(html).toContain('Artifact storage');
    expect(html).toContain('Advanced JSON options');
    expect(html).not.toContain('<table');
  });

  it('renders multiple metadata and artifact storage providers without enabling unavailable adapters', () => {
    const s3Config: RuntimeSettingsConfig = {
      ...config,
      storage: {
        metadata: { provider: 'postgres', options: { connection_string: '${DATABASE_URL}' } },
        artifacts: {
          provider: 's3',
          options: {
            endpoint: 'https://s3.amazonaws.com',
            bucket: 'managed-agents-artifacts',
            region: 'us-east-1',
            access_key: '${AWS_ACCESS_KEY_ID}',
            secret_key: '${AWS_SECRET_ACCESS_KEY}',
            force_path_style: false,
          },
        },
      },
    };

    const html = renderToStaticMarkup(
      <StorageSettingsForm
        metadataAdapters={metadataStorageAdapters}
        artifactAdapters={artifactStorageAdapters}
        config={s3Config}
        onChange={() => {}}
        diagnostics={{ path: '/tmp/data.db', health: 'ok' }}
      />,
    );

    expect(html).toContain('value="postgres"');
    expect(html).toContain('Postgres - unavailable');
    expect(html).toContain('MySQL - unavailable');
    expect(html).toContain('S3-compatible - unavailable');
    expect(html).toContain('Connection string');
    expect(html).toContain('${DATABASE_URL}');
    expect(html).toContain('Endpoint');
    expect(html).toContain('Bucket');
    expect(html).toContain('Region');
    expect(html).toContain('Access key');
    expect(html).toContain('Secret key');
    expect(html).toContain('Path-style requests');
    expect(html).toContain('Storage adapter availability');
    expect(html).toMatch(/value="postgres" disabled=""/);
    expect(html).toMatch(/value="mysql" disabled=""/);
    expect(html).toMatch(/value="s3" disabled=""/);
  });

  it('derives option defaults from storage adapter schemas', () => {
    expect(optionDefaultsForAdapter(metadataStorageAdapters, 'postgres')).toEqual({ connection_string: '${DATABASE_URL}' });
    expect(optionDefaultsForAdapter(artifactStorageAdapters, 's3')).toEqual({
      endpoint: 'https://s3.amazonaws.com',
      bucket: '${S3_BUCKET}',
      region: '${AWS_REGION}',
      access_key: '${AWS_ACCESS_KEY_ID}',
      secret_key: '${AWS_SECRET_ACCESS_KEY}',
      force_path_style: false,
    });
  });

  it('renders advanced JSON options across configurable forms', () => {
    const adapters = [{ id: 'builtin', label: 'Default', status: 'available' }];
    expect(renderToStaticMarkup(<ModelSettingsForm adapters={[{ id: 'openai', label: 'OpenAI', status: 'available' }]} config={config} onChange={() => {}} apiKeyConfigured={false} />)).not.toContain('formOptionsEditor');
    expect(renderToStaticMarkup(<LoopEngineSettingsForm adapters={adapters} config={config} onChange={() => {}} />)).toContain('default_max_steps');
    expect(renderToStaticMarkup(<MemorySettingsForm adapters={[{ id: 'sqlite', label: 'SQLite', status: 'available' }]} config={config} onChange={() => {}} />)).toContain('formOptionsEditor');
    expect(renderToStaticMarkup(<SandboxSettingsForm adapters={[{ id: 'local', label: 'Local', status: 'available' }]} config={config} onChange={() => {}} />)).toContain('timeout_seconds');
  });

  it('hydrates display defaults from adapter schemas without model option fields', () => {
    const adapters: RuntimeSettings['adapters'] = {
      model: [{ id: 'openai', label: 'OpenAI', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
      loop_engine: [{ id: 'builtin', label: 'Default', version: '1', status: 'available', restart_policy: 'runtime', options_schema: { type: 'object', properties: { default_max_steps: { type: 'integer', default: 25 } } } }],
      storage: {
        metadata: [{ id: 'sqlite', label: 'SQLite', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
        artifacts: [{ id: 'local', label: 'Local filesystem', version: '1', status: 'available', restart_policy: 'runtime', options_schema: { type: 'object', properties: { base_path: { type: 'string', default: 'files' } } } }],
      },
      memory: [{ id: 'sqlite', label: 'SQLite', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
      sandbox: [{ id: 'local', label: 'Local', version: '1', status: 'available', restart_policy: 'runtime', options_schema: { type: 'object', properties: { timeout_seconds: { type: 'integer', default: 300 } } } }],
    };
    const sparse = {
      ...config,
      model: { vendor: 'openai' as const, options: {} },
      loop_engine: { provider: 'builtin' as const, options: {} as RuntimeSettingsConfig['loop_engine']['options'] },
      storage: { metadata: { provider: 'sqlite' as const, options: {} }, artifacts: { provider: 'local' as const, options: {} } },
      sandbox: { provider: 'local' as const, options: {} as RuntimeSettingsConfig['sandbox']['options'] },
    };
    const hydrated = applyRuntimeSettingsDefaults(sparse, adapters);

    expect(hydrated.model).toMatchObject({
      vendor: 'openai',
      base_url: 'https://api.openai.com/v1',
      api_key: '${OPENAI_API_KEY}',
      options: {},
    });
    expect(hydrated.loop_engine.options.default_max_steps).toBe(25);
    expect(hydrated.storage.artifacts.options.base_path).toBe('files');
    expect(hydrated.sandbox.options.timeout_seconds).toBe(300);
  });

  it('hydrates MiniMax display defaults from the selected model vendor', () => {
    const adapters: RuntimeSettings['adapters'] = {
      model: [{ id: 'minimax', label: 'MiniMax', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
      loop_engine: [{ id: 'builtin', label: 'Default', version: '1', status: 'available', restart_policy: 'runtime', options_schema: { type: 'object', properties: { default_max_steps: { type: 'integer', default: 25 } } } }],
      storage: { metadata: [], artifacts: [] },
      memory: [],
      sandbox: [{ id: 'local', label: 'Local', version: '1', status: 'available', restart_policy: 'runtime', options_schema: { type: 'object', properties: { timeout_seconds: { type: 'integer', default: 300 } } } }],
    };
    const hydrated = applyRuntimeSettingsDefaults({
      ...config,
      model: { vendor: 'minimax' as const, options: {} },
    }, adapters);

    expect(hydrated.model).toMatchObject({
      vendor: 'minimax',
      base_url: 'https://api.minimax.io/v1',
      api_key: '${MINIMAX_API_KEY}',
      options: {},
    });
  });

  it('renders memory and loop engine as single-backend forms instead of provider tables', () => {
    const loop = renderToStaticMarkup(<LoopEngineSettingsForm adapters={[{ id: 'builtin', label: 'Default', status: 'available' }]} config={config} onChange={() => {}} />);
    const memory = renderToStaticMarkup(<MemorySettingsForm adapters={[{ id: 'sqlite', label: 'SQLite', status: 'available' }]} config={config} onChange={() => {}} />);

    expect(loop).not.toContain('<table');
    expect(loop).not.toContain('Add provider');
    expect(memory).not.toContain('<table');
    expect(memory).not.toContain('Add provider');
    expect(memory).toContain('settingsHeroCard');
    expect(memory).toContain('Memory retrieval is enabled');
    expect(memory).toContain('toggleSwitch');
    expect(memory).toContain('Selected provider');
    expect(memory).toContain('SQLite');
  });

  it('disables unavailable sandboxes and links to Environments', () => {
    const adapters = [
      { id: 'local', label: 'Local', status: 'available' as const },
      { id: 'docker', label: 'Docker', status: 'unavailable' as const },
      { id: 'mystery', label: 'Unknown sandbox (mystery)', status: 'invalid' as const },
    ];
    const html = renderToStaticMarkup(<SandboxSettingsForm adapters={adapters} config={config} onChange={() => {}} />);
    expect(html).toMatch(/value="docker" disabled=""/);
    expect(html).toMatch(/value="mystery" disabled=""/);
    expect(html).toContain('href="#environments"');
    expect(html).toContain('Docker: unavailable');
    expect(html).toContain('Unknown sandbox (mystery): invalid');
    expect(html).toContain('providerStateBadge error');
  });

  it('renders provider-specific Docker and remote sandbox options', () => {
    const adapters = [
      { id: 'local', label: 'Local', status: 'available' as const, options_schema: { type: 'object', properties: { timeout_seconds: { type: 'integer', default: 300 } } } },
      { id: 'docker', label: 'Docker', status: 'available' as const, options_schema: { type: 'object', properties: { timeout_seconds: { type: 'integer', default: 300 }, image: { type: 'string' } } } },
      {
        id: 'remote',
        label: 'Remote',
        status: 'available' as const,
        options_schema: {
          type: 'object',
          properties: {
            timeout_seconds: { type: 'integer', default: 300 },
            endpoint: { type: 'string', default: '${MANAGED_AGENTS_API_URL}' },
            api_key: { type: 'string', default: '${MANAGED_AGENTS_WORKER_API_KEY}' },
          },
        },
      },
    ];
    const remoteConfig: RuntimeSettingsConfig = {
      ...config,
      sandbox: {
        provider: 'remote',
        options: {
          timeout_seconds: 300,
          endpoint: '${MANAGED_AGENTS_API_URL}',
          api_key: '${MANAGED_AGENTS_WORKER_API_KEY}',
        },
      },
    };
    const dockerConfig: RuntimeSettingsConfig = {
      ...config,
      sandbox: {
        provider: 'docker',
        options: {
          timeout_seconds: 300,
          image: 'node:22-bookworm',
        },
      },
    };

    const remoteHtml = renderToStaticMarkup(<SandboxSettingsForm adapters={adapters} config={remoteConfig} onChange={() => {}} />);
    const dockerHtml = renderToStaticMarkup(<SandboxSettingsForm adapters={adapters} config={dockerConfig} onChange={() => {}} />);

    expect(remoteHtml).toContain('remote → self_hosted worker queue');
    expect(remoteHtml).toContain('Worker API URL');
    expect(remoteHtml).toContain('${MANAGED_AGENTS_API_URL}');
    expect(remoteHtml).toContain('Worker API key');
    expect(remoteHtml).toContain('worker endpoints enabled');
    expect(dockerHtml).toContain('Image');
    expect(dockerHtml).toContain('node:22-bookworm');
  });

  it('renders activation failure state without repeating restart controls per settings page', () => {
    const data = {
      settings: {
        schema_version: 1,
        revision: 3,
        effective_revision: 2,
        saved_config: config,
        effective_config: config,
        restart_required: true,
        activation_status: 'failed',
        activation_errors: [{ path: 'sandbox.provider', code: 'adapter_unavailable', message: 'Adapter "docker" is not available in this runtime' }],
        diagnostics: { metadata: { path: '/tmp/data.db', health: 'ok' } },
        secret_states: { model: { api_key: 'not_set' } },
        adapters: {
          model: [{ id: 'openai', label: 'OpenAI', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
          loop_engine: [{ id: 'builtin', label: 'Default', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
          storage: { metadata: [], artifacts: [] },
          memory: [{ id: 'sqlite', label: 'SQLite', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
          sandbox: [{ id: 'local', label: 'Local', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
        },
      } satisfies RuntimeSettings,
    } as unknown as ConsoleData;

    const html = renderToStaticMarkup(<RuntimeSettingsEditor data={data} section="sandbox" onRefresh={() => {}} />);

    expect(html).not.toContain('Restart required');
    expect(html).not.toContain('Restart runtime');
    expect(html).toContain('Saved settings are not active');
    expect(html).toContain('Fix the highlighted field');
    expect(html).toContain('Adapter &quot;docker&quot; is not available in this runtime');
  });

  it('keeps secondary settings actions behind a compact more menu by default', () => {
    const data = {
      settings: {
        schema_version: 1,
        revision: 3,
        effective_revision: 3,
        saved_config: config,
        effective_config: config,
        restart_required: false,
        activation_status: 'active',
        activation_errors: [],
        diagnostics: { metadata: { path: '/tmp/data.db', health: 'ok' } },
        secret_states: { model: { api_key: 'not_set' } },
        adapters: {
          model: [{ id: 'openai', label: 'OpenAI', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
          loop_engine: [{ id: 'builtin', label: 'Default', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
          storage: { metadata: [], artifacts: [] },
          memory: [{ id: 'sqlite', label: 'SQLite', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
          sandbox: [{ id: 'local', label: 'Local', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
        },
      } satisfies RuntimeSettings,
    } as unknown as ConsoleData;

    const html = renderToStaticMarkup(<RuntimeSettingsEditor data={data} section="memory" onRefresh={() => {}} />);

    expect(html).toContain('More settings actions');
    expect(html).toContain('Save settings');
    expect(html).not.toContain('Validate</button>');
    expect(html).not.toContain('Check configuration');
    expect(html).not.toContain('Discard');
  });

  it('keeps the General settings page focused without duplicate shortcut cards', () => {
    const data = {
      runtime: {
        status: 'running',
        models: [{ name: 'default' }],
        sandbox_providers: ['local', 'self_hosted'],
        auth_enabled: false,
        memory: 'disabled',
      },
      workspace: {
        name: 'managed-agents',
        root: '/repo/managed-agents',
        target: 'local',
        configDir: '/repo/managed-agents/.managed-agents',
        dataDir: '/tmp/managed-agents',
      },
      sessions: [],
      apiKeys: [],
    } as unknown as ConsoleData;

    const html = renderToStaticMarkup(<SettingsGeneral data={data} setView={() => {}} />);

    expect(html).toContain('Setup');
    expect(html).toContain('Model provider');
    expect(html).toContain('Local defaults');
    expect(html).toContain('Next step');
    expect(html).not.toContain('settingsOverviewGrid');
    expect(html).not.toContain('settingsOverviewCard');
    expect(html).not.toContain('One default model vendor');
    expect(html).not.toContain('HTTP endpoints, SDK snippets');
  });

  it('renders Logs with an expanded console layout', () => {
    const data = {
      runtime: {
        status: 'running',
      },
      workspace: {
        dataDir: '/tmp/managed-agents',
      },
    } as unknown as ConsoleData;

    const html = renderToStaticMarkup(<SettingsLogs data={data} />);

    expect(html).toContain('settingsLogsPage');
    expect(html).toContain('runtimeLogPanel');
    expect(html).toContain('Runtime logs');
    expect(html).toContain('No runtime logs captured yet');
  });

  it('shows activation errors only on the affected settings section', () => {
    const data = {
      settings: {
        schema_version: 1,
        revision: 3,
        effective_revision: 2,
        saved_config: config,
        effective_config: config,
        restart_required: true,
        activation_status: 'failed',
        activation_errors: [{ path: 'model.api_key', code: 'missing_secret', message: 'A model API key is required' }],
        diagnostics: { metadata: { path: '/tmp/data.db', health: 'ok' } },
        secret_states: { model: { api_key: 'not_set' } },
        adapters: {
          model: [{ id: 'openai', label: 'OpenAI', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
          loop_engine: [{ id: 'builtin', label: 'Default', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
          storage: { metadata: [], artifacts: [] },
          memory: [{ id: 'sqlite', label: 'SQLite', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
          sandbox: [{ id: 'local', label: 'Local', version: '1', status: 'available', restart_policy: 'runtime', options_schema: {} }],
        },
      } satisfies RuntimeSettings,
    } as unknown as ConsoleData;

    const modelsHtml = renderToStaticMarkup(<RuntimeSettingsEditor data={data} section="models" onRefresh={() => {}} />);
    const loopHtml = renderToStaticMarkup(<RuntimeSettingsEditor data={data} section="loop-engine" onRefresh={() => {}} />);

    expect(modelsHtml).toContain('Saved settings are not active');
    expect(modelsHtml).toContain('A model API key is required');
    expect(loopHtml).not.toContain('Saved settings are not active');
    expect(loopHtml).not.toContain('A model API key is required');
  });
});
