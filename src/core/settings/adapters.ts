import { sandboxSettingForProvider } from '@/sandbox/provider-names.js';
import { MINIMAX_DEFAULT_MODEL, MINIMAX_ENDPOINTS, MINIMAX_MODELS, MINIMAX_PROVIDER } from '@/core/model/minimax.js';
import { PI_APPROVAL_MODE_DEFAULT, PI_APPROVAL_MODES } from '@/strategy/pi/approval-mode.js';
import {
  PI_ADAPTER_CAPABILITY_IDS,
  PI_ADAPTER_REQUIREMENTS,
  PI_LOOP_ENGINE_REASON,
} from '@/strategy/pi/capability-profile.js';
import type { SettingsAvailability } from './schema.js';

export type AdapterStatus = 'available' | 'unavailable' | 'invalid';

export type AdapterDescriptor = {
  id: string;
  label: string;
  version: string;
  status: AdapterStatus;
  restart_policy: 'none' | 'runtime';
  options_schema: Record<string, unknown>;
  /**
   * Why an adapter is unavailable, or which restriction applies when it is
   * available but limited. Omitted only when the adapter is fully available
   * with no caveat. Consumed verbatim by Settings, `POST /v1/sessions`
   * admission, and the API reference so no consumer invents its own wording.
   */
  reason?: string;
  /** External or configuration prerequisites a turn cannot run without. */
  requirements?: string[];
  /** Behaviors the adapter provides once it is available. */
  capabilities?: string[];
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
  web_search: AdapterDescriptor[];
};

/**
 * Loop engines the public contract recognizes, in display order.
 *
 * `harness`, `codex`, and `claude` stay listed so a client can discover *why*
 * they are unavailable instead of guessing at an unknown value. They are never
 * selectable and never resolve to `builtin`.
 */
export const LOOP_ENGINE_ADAPTER_IDS = ['builtin', 'pi', 'harness', 'codex', 'claude'] as const;

export type LoopEngineAdapterId = (typeof LOOP_ENGINE_ADAPTER_IDS)[number];

/** Loop engines this runtime can actually execute today. */
export const EXECUTABLE_LOOP_ENGINE_IDS = ['builtin', 'pi'] as const;

/** Stable reason text for a roadmap engine that has no executable adapter. */
export const ROADMAP_LOOP_ENGINE_REASON =
  'No execution adapter for this loop engine is implemented in this runtime.';

/** Stable reason text for a web-search provider with no shipped adapter. */
export const ROADMAP_WEB_SEARCH_REASON =
  'No search adapter for this provider is implemented in this runtime.';

/**
 * Pi is a shipped adapter, but it is not a peer of `builtin`: it drives a
 * host-local child CLI whose native tools sit outside Harness approval and
 * sandbox path policy.
 *
 * Re-exported from the Pi capability profile rather than restated here, so the
 * descriptor, the API reference, and `docs/pi-loop-engine.md` cannot end up
 * describing three slightly different engines.
 */
export { PI_LOOP_ENGINE_REASON };

/**
 * Persisted settings key for the platform-owned Pi approval mode.
 *
 * Named once so the adapter descriptor's JSON Schema, the settings schema, and
 * the tests that tie them together cannot disagree about the key this mode is
 * stored under.
 */
export const PI_APPROVAL_MODE_OPTION = 'approval_mode';

/**
 * Persisted settings key for the bounded parked wait.
 *
 * Named once so the settings schema, both engine descriptors that offer it, and
 * the sweep that reads it cannot disagree about where it lives. It is offered on
 * both engines because both can park: the builtin loop parks a custom tool call,
 * and a Pi gate parks on a person's decision. Whatever parked the session, the
 * session is the thing waiting.
 *
 * Declared with **no default** in every one of those places. The published
 * behaviour is that a parked session waits indefinitely (`权限策略.md:668`), so a
 * default would make this runtime non-conformant out of the box; the operator
 * opts in.
 */
export const REQUIRES_ACTION_TIMEOUT_OPTION = 'requires_action_timeout_seconds';

/** Shared schema fragment for the bounded parked wait, in seconds. */
const REQUIRES_ACTION_TIMEOUT_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: 2_592_000,
} as const;

/**
 * Persisted settings key for the tool-result overflow threshold.
 *
 * Offered on both engines because both enforce the same spill contract: the
 * builtin loop spills tool output itself, and the Pi translator receives the
 * same configured limit through its sink.
 */
export const TOOL_RESULT_MAX_CHARS_OPTION = 'tool_result_max_chars';

/** Shared schema fragment for the overflow threshold, in characters. */
const TOOL_RESULT_MAX_CHARS_SCHEMA = {
  type: 'integer',
  minimum: 1_000,
  maximum: 10_000_000,
  default: 100_000,
} as const;

/**
 * Single engine-discovery source of truth.
 *
 * Settings, session-creation admission, and the API reference all read this
 * list instead of maintaining their own availability table.
 */
export function describeLoopEngineAdapters(): AdapterDescriptor[] {
  return [
    descriptor('builtin', 'Default', true, 'runtime', objectSchema({
      default_max_steps: { type: 'integer', minimum: 1, maximum: 1000, default: 25 },
      [REQUIRES_ACTION_TIMEOUT_OPTION]: REQUIRES_ACTION_TIMEOUT_SCHEMA,
      [TOOL_RESULT_MAX_CHARS_OPTION]: TOOL_RESULT_MAX_CHARS_SCHEMA,
    }), {
      capabilities: ['harness-tool-loop', 'tool-confirmation', 'sandbox-providers'],
    }),
    // The shipped adapter is selectable. The Settings test probes the external
    // executable, and a turn still fails explicitly if it is absent.
    descriptor('pi', 'Pi CLI', true, 'runtime', objectSchema({
      default_max_steps: { type: 'integer', minimum: 1, maximum: 1000, default: 25 },
      timeout_seconds: { type: 'integer', minimum: 1, maximum: 86400, default: 300 },
      // Platform-owned: an agent definition cannot reach this key, so an agent
      // cannot make its own gated tool calls unattended. The default is stated
      // so a Console that reads only the schema offers the interactive mode.
      [PI_APPROVAL_MODE_OPTION]: {
        type: 'string',
        enum: [...PI_APPROVAL_MODES],
        default: PI_APPROVAL_MODE_DEFAULT,
      },
      [REQUIRES_ACTION_TIMEOUT_OPTION]: REQUIRES_ACTION_TIMEOUT_SCHEMA,
      [TOOL_RESULT_MAX_CHARS_OPTION]: TOOL_RESULT_MAX_CHARS_SCHEMA,
    }), {
      reason: PI_LOOP_ENGINE_REASON,
      requirements: [...PI_ADAPTER_REQUIREMENTS],
      capabilities: [...PI_ADAPTER_CAPABILITY_IDS],
    }),
    descriptor('harness', 'Harness', false, 'runtime', objectSchema(), { reason: ROADMAP_LOOP_ENGINE_REASON }),
    descriptor('codex', 'Codex', false, 'runtime', objectSchema(), { reason: ROADMAP_LOOP_ENGINE_REASON }),
    descriptor('claude', 'Claude', false, 'runtime', objectSchema(), { reason: ROADMAP_LOOP_ENGINE_REASON }),
  ];
}

/** Look up one loop-engine descriptor, or `undefined` for a value outside the contract. */
export function loopEngineDescriptor(id: string): AdapterDescriptor | undefined {
  return describeLoopEngineAdapters().find((item) => item.id === id);
}

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
    loop_engine: describeLoopEngineAdapters(),
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
    web_search: [
      descriptor('tavily', 'Tavily', true, 'runtime', objectSchema({
        api_key: { type: 'string', format: 'password', default: '${TAVILY_API_KEY}' },
        base_url: { type: 'string', format: 'uri', default: 'https://api.tavily.com' },
      }), {
        capabilities: ['web_search'],
      }),
      // Keenable works keyless (public endpoint, rate limited per IP); an
      // optional api_key switches to the keyed endpoint. No `${ENV}` default,
      // so an unset variable never turns the keyless setup into an error.
      descriptor('keenable', 'Keenable', true, 'runtime', objectSchema({
        api_key: { type: 'string', format: 'password' },
        base_url: { type: 'string', format: 'uri', default: 'https://api.keenable.ai' },
      }), {
        capabilities: ['web_search'],
      }),
      descriptor('outcrawl', 'Outcrawl', true, 'runtime', objectSchema({
        api_key: { type: 'string', format: 'password', default: '${OUTCRAWL_API_KEY}' },
        base_url: { type: 'string', format: 'uri', default: 'https://api.outcrawl.ai' },
      }), {
        capabilities: ['web_search'],
      }),
      // Listed so a client can discover why they are unavailable; each ships
      // as its own adapter PR (searxng is the self-hosted, keyless one).
      descriptor('brave', 'Brave Search', false, 'runtime', objectSchema(), { reason: ROADMAP_WEB_SEARCH_REASON }),
      descriptor('exa', 'Exa', false, 'runtime', objectSchema(), { reason: ROADMAP_WEB_SEARCH_REASON }),
      descriptor('searxng', 'SearXNG', false, 'runtime', objectSchema(), { reason: ROADMAP_WEB_SEARCH_REASON }),
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
    webSearchProviders: availableIds(descriptors.web_search),
  } as SettingsAvailability;
}

function descriptor(
  id: string,
  label: string,
  available: boolean,
  restartPolicy: AdapterDescriptor['restart_policy'],
  optionsSchema: Record<string, unknown>,
  details: Pick<AdapterDescriptor, 'reason' | 'requirements' | 'capabilities'> = {},
): AdapterDescriptor {
  return {
    id,
    label,
    version: '1',
    status: available ? 'available' : 'unavailable',
    restart_policy: restartPolicy,
    options_schema: optionsSchema,
    ...(details.reason ? { reason: details.reason } : {}),
    ...(details.requirements?.length ? { requirements: details.requirements } : {}),
    ...(details.capabilities?.length ? { capabilities: details.capabilities } : {}),
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
