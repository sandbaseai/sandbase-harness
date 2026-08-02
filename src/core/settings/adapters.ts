import { sandboxSettingForProvider } from '@/sandbox/provider-names.js';
import { MINIMAX_DEFAULT_MODEL, MINIMAX_ENDPOINTS, MINIMAX_MODELS, MINIMAX_PROVIDER } from '@/core/model/minimax.js';
import type { SettingsAvailability } from './schema.js';

export type AdapterStatus = 'available' | 'unavailable' | 'invalid';

export type AdapterDescriptor = {
  id: string;
  label: string;
  version: string;
  status: AdapterStatus;
  restart_policy: 'none' | 'runtime';
  options_schema: Record<string, unknown>;
};

export type SettingsAdapterDescriptors = {
  model: AdapterDescriptor[];
  loop_engine: AdapterDescriptor[];
  storage: {
    metadata: AdapterDescriptor[];
    artifacts: AdapterDescriptor[];
  };
  memory: AdapterDescriptor[];
  sandbox: AdapterDescriptor[];
};

export function describeSettingsAdapters(installedSandboxes: string[] = ['local']): SettingsAdapterDescriptors {
  const knownSandboxIds = new Set<string>(['local', 'docker', 'kubernetes', 'remote']);
  // A registered backend Settings V2 has no id for stays visible as `invalid`
  // rather than being folded into an id that means something else.
  const normalizedSandboxIds = installedSandboxes.map((item) => sandboxSettingForProvider(item) ?? item);
  const sandboxAvailable = new Set(normalizedSandboxIds);
  const invalidSandboxes = [...new Set(normalizedSandboxIds)]
    .filter((item) => !knownSandboxIds.has(item))
    .map((item) => invalidDescriptor(item, `Unknown sandbox (${item})`, 'runtime', objectSchema()));
  return {
    model: [
      descriptor('openai', 'OpenAI', true, 'runtime', objectSchema()),
      descriptor('anthropic', 'Anthropic', true, 'runtime', objectSchema()),
      descriptor(MINIMAX_PROVIDER, 'MiniMax', true, 'runtime', objectSchema({
        model: { type: 'string', enum: MINIMAX_MODELS.map((model) => model.model_id), default: MINIMAX_DEFAULT_MODEL },
        region: { type: 'string', enum: ['global_en', 'cn_zh'], default: 'global_en' },
        openai_base_url: { type: 'string', format: 'uri', default: MINIMAX_ENDPOINTS.global_en.openai_base_url },
        anthropic_base_url: { type: 'string', format: 'uri', default: MINIMAX_ENDPOINTS.global_en.anthropic_base_url },
        cn_openai_base_url: { type: 'string', format: 'uri', default: MINIMAX_ENDPOINTS.cn_zh.openai_base_url },
        cn_anthropic_base_url: { type: 'string', format: 'uri', default: MINIMAX_ENDPOINTS.cn_zh.anthropic_base_url },
        docs_root: { type: 'string', format: 'uri', default: MINIMAX_ENDPOINTS.global_en.docs_root },
        cn_docs_root: { type: 'string', format: 'uri', default: MINIMAX_ENDPOINTS.cn_zh.docs_root },
      })),
      descriptor('openai_compatible', 'OpenAI compatible', true, 'runtime', objectSchema()),
    ],
    loop_engine: [
      descriptor('builtin', 'Default', true, 'runtime', objectSchema({
        default_max_steps: { type: 'integer', minimum: 1, maximum: 1000, default: 25 },
      })),
      descriptor('harness', 'Harness', false, 'runtime', objectSchema()),
      descriptor('codex', 'Codex', false, 'runtime', objectSchema()),
      descriptor('claude', 'Claude', false, 'runtime', objectSchema()),
    ],
    storage: {
      metadata: [
        descriptor('sqlite', 'SQLite', true, 'runtime', objectSchema()),
        descriptor('postgres', 'Postgres', false, 'runtime', objectSchema({
          connection_string: { type: 'string', format: 'password', default: '${DATABASE_URL}' },
        })),
        descriptor('mysql', 'MySQL', false, 'runtime', objectSchema({
          connection_string: { type: 'string', format: 'password', default: '${DATABASE_URL}' },
        })),
      ],
      artifacts: [
        descriptor('local', 'Local filesystem', true, 'runtime', objectSchema({
          base_path: { type: 'string', default: 'files' },
        })),
        descriptor('s3', 'S3-compatible', false, 'runtime', objectSchema({
          endpoint: { type: 'string', format: 'uri', default: 'https://s3.amazonaws.com' },
          bucket: { type: 'string', default: '${S3_BUCKET}' },
          region: { type: 'string', default: '${AWS_REGION}' },
          access_key: { type: 'string', format: 'password', default: '${AWS_ACCESS_KEY_ID}' },
          secret_key: { type: 'string', format: 'password', default: '${AWS_SECRET_ACCESS_KEY}' },
          force_path_style: { type: 'boolean', default: false },
        })),
      ],
    },
    memory: [
      descriptor('sqlite', 'SQLite', true, 'runtime', objectSchema()),
      descriptor('memu', 'MemU', false, 'runtime', objectSchema({
        api_key: { type: 'string', format: 'password' },
      })),
      descriptor('mem0', 'mem0', false, 'runtime', objectSchema({
        api_key: { type: 'string', format: 'password' },
      })),
    ],
    sandbox: [
      descriptor('local', 'Local', sandboxAvailable.has('local'), 'runtime', objectSchema({
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 86400, default: 300 },
      })),
      descriptor('docker', 'Docker', sandboxAvailable.has('docker'), 'runtime', objectSchema({
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 86400, default: 300 },
        image: { type: 'string' },
      })),
      descriptor('kubernetes', 'Kubernetes', sandboxAvailable.has('kubernetes'), 'runtime', objectSchema({
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 86400, default: 300 },
        image: { type: 'string' },
        namespace: {
          type: 'string',
          default: 'default',
          // RFC 1123 label, the same constraint the provider enforces. Declared
          // here so the Console rejects it on save instead of letting the first
          // session fail at provision time.
          pattern: '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$',
          maxLength: 63,
        },
        context: { type: 'string' },
        kubeconfig: { type: 'string' },
        service_account: { type: 'string' },
      })),
      descriptor('remote', 'Remote', sandboxAvailable.has('remote'), 'runtime', objectSchema({
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 86400, default: 300 },
        endpoint: { type: 'string', format: 'uri', default: '${MANAGED_AGENTS_API_URL}' },
        api_key: { type: 'string', format: 'password', default: '${MANAGED_AGENTS_WORKER_API_KEY}' },
      })),
      ...invalidSandboxes,
    ],
  };
}

export function availabilityFromDescriptors(descriptors: SettingsAdapterDescriptors): SettingsAvailability {
  return {
    modelVendors: availableIds(descriptors.model),
    loopEngines: availableIds(descriptors.loop_engine),
    metadataStorage: availableIds(descriptors.storage.metadata),
    artifactStorage: availableIds(descriptors.storage.artifacts),
    memoryProviders: availableIds(descriptors.memory),
    sandboxProviders: availableIds(descriptors.sandbox),
  } as SettingsAvailability;
}

function descriptor(
  id: string,
  label: string,
  available: boolean,
  restartPolicy: AdapterDescriptor['restart_policy'],
  optionsSchema: Record<string, unknown>,
): AdapterDescriptor {
  return {
    id,
    label,
    version: '1',
    status: available ? 'available' : 'unavailable',
    restart_policy: restartPolicy,
    options_schema: optionsSchema,
  };
}

function invalidDescriptor(
  id: string,
  label: string,
  restartPolicy: AdapterDescriptor['restart_policy'],
  optionsSchema: Record<string, unknown>,
): AdapterDescriptor {
  return {
    id,
    label,
    version: '1',
    status: 'invalid',
    restart_policy: restartPolicy,
    options_schema: optionsSchema,
  };
}

function objectSchema(properties: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: true,
    properties,
  };
}

function availableIds<T extends string>(items: AdapterDescriptor[]): Set<T> {
  return new Set(items.filter((item) => item.status === 'available').map((item) => item.id as T));
}
