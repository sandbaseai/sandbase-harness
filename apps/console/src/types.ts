/**
 * The canonical envelope: a `/v1` collection the pagination contract has converted.
 *
 * `contracts/anthropic-cma/pagination.md` §2 maps the two envelopes and §4 names the
 * collections still on the local one.
 */
export type CursorPage<T> = {
  data: T[];
  prev_page: string | null;
  next_page: string | null;
};

/** The local envelope: `/v1/x` collections, and `/v1` collections not converted yet. */
export type Page<T> = {
  data: T[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
};

export type Agent = {
  id: string;
  type: 'agent';
  name: string;
  description: string;
  system: string;
  model: string;
  /**
   * The stored model profile. `effort` is echoed by the API read but does not
   * reach a provider request; see `lib/agentModelConfig.ts` for the save rule.
   */
  model_config?: { id?: string; speed: string; effort?: string };
  tools: AgentToolset[];
  skills: SkillRef[];
  mcp_servers: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  status: string;
  version: number;
  /** Resolved multiagent roster — always `null`; no runtime can populate it yet. */
  multiagent: null;
  created_at: string | null;
  updated_at: string | null;
  archived_at: string | null;
};

export type AgentToolset = BuiltinToolset | McpToolset;

export type BuiltinToolset = {
  type: 'agent_toolset_20260401';
  configs?: Record<string, ToolConfig>;
  default_config?: ToolConfig;
};

export type McpToolset = {
  type: 'mcp_toolset';
  mcp_server_name: string;
  configs?: Record<string, ToolConfig>;
  default_config?: ToolConfig;
};

export type ToolConfig = {
  enabled?: boolean;
  permission_policy?: { type: 'always_allow' | 'always_ask' | 'never_allow' };
};

export type SkillRef = { type: 'custom' | 'anthropic'; skill_id: string; version?: string };

export type Session = {
  id: string;
  type: 'session';
  title: string | null;
  agent: Agent | { id: string; type: 'agent'; name: string; version: number; multiagent: null };
  environment_id: string;
  status: 'idle' | 'running' | 'rescheduling' | 'terminated';
  resources: Array<Record<string, unknown>>;
  vault_ids: string[];
  /** Spending ceiling — always present, `null` when the session has none. */
  budget: { type: 'limit'; max_list_cost: { amount: string; currency: 'USD' } } | null;
  usage: { input_tokens: number; output_tokens: number };
  stats: { active_seconds: number; duration_seconds: number };
  /** Declared outcomes and their evaluation state, in declaration order. */
  outcome_evaluations: Array<{
    type: 'outcome_evaluation';
    outcome_id: string;
    description: string;
    result: string;
    iteration: number;
    explanation: string | null;
    completed_at: string | null;
  }>;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type SessionEvent = {
  id: string;
  /** Append-only per-session sequence; 0 is transient SSE-only output. */
  seq?: number;
  type: string;
  content: unknown[] | null;
  /**
   * Tool Runtime authority. These fields are optional while older API
   * responses are still in use; the Console must never infer permission from
   * a tool name.
   */
  requires_confirmation?: boolean;
  permission?: ToolPermission;
  requires_action?: boolean;
  metadata?: Record<string, unknown>;
  /** Some protocol adapters put the result correlation id on the event. */
  tool_use_id?: string;
  mcp_tool_use_id?: string;
  is_error?: boolean;
  isError?: boolean;
  delta?: string;
  message_id?: string;
  model_used?: string;
  tokens_in?: number;
  tokens_out?: number;
  stop_reason?: string | { type: string; event_ids?: string[] };
  duration_ms?: number;
  created_at: string | null;
  processed_at: string | null;
  parent_event_id: string | null;
};

export type ToolPermission = 'always_allow' | 'always_ask' | 'never_allow';

export type SessionResourceDraft =
  | { type: 'file'; file_id: string; mount_path: string }
  | { type: 'github_repository'; url: string; authorization_token: string; checkout: { mode: 'default' | 'branch' | 'commit'; value: string }; mount_path: string }
  | { type: 'memory_store'; memory_store_id: string; access: 'read_write' | 'read_only'; instructions: string };

export type WorkspaceFile = {
  id: string;
  type: 'file';
  name: string;
  media_type: string;
  size_bytes: number;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  preview: string | null;
  preview_truncated: boolean;
};

export type ApiKey = {
  id: string;
  type: 'api_key';
  name: string;
  source: 'managed' | 'config_env';
  key_prefix: string;
  status: string;
  created_at: string | null;
  updated_at: string | null;
  last_used_at: string | null;
  archived_at: string | null;
};

export type ApiKeyCreateResponse = ApiKey & {
  secret_key: string;
};

export type EnvironmentHostingType = 'cloud' | 'local' | 'docker' | 'self_hosted';
export type EnvironmentNetworkType = 'limited' | 'unrestricted';
export type EnvironmentPackageDraft = { id: string; manager: string; package: string };
export type MetadataDraft = { id: string; key: string; value: string };

export type EnvironmentDraft = {
  name: string;
  description: string;
  hostingType: EnvironmentHostingType;
  dockerImage: string;
  dockerMemory: string;
  dockerCpu: string;
  networkType: EnvironmentNetworkType;
  allowMcpServerNetworkAccess: boolean;
  allowPackageManagerNetworkAccess: boolean;
  allowedHosts: string;
  packages: EnvironmentPackageDraft[];
  metadata: MetadataDraft[];
  preservedMetadata: Record<string, unknown>;
};

export type Environment = {
  id: string;
  type: 'environment';
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  /** Local extension: the backend sessions on this Environment actually provision. */
  effective_sandbox_provider: string | null;
  packages_enforced: boolean;
  networking_enforced: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type Vault = {
  id: string;
  type: 'credential_vault';
  name: string;
  description: string;
  status: string;
  credential_count: number;
  credentials: VaultCredential[];
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type CredentialAuthType = 'mcp_oauth' | 'bearer_token' | 'environment_variable';

export type VaultCredential = {
  id: string;
  type: 'credential';
  vault_id: string;
  name: string;
  auth_type: CredentialAuthType;
  mcp_server_url: string;
  variable_name: string;
  value_hint: string;
  network: Record<string, unknown>;
  injection_locations: string[];
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  archived_at: string | null;
};

export type MemoryStore = {
  id: string;
  type: 'memory_store';
  name: string;
  description: string;
  provider: string;
  status: string;
  memory_count: number;
  memories: MemoryRecord[];
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type MemoryRecord = {
  id: string;
  type: 'memory';
  memory_store_id: string;
  memory_version_id: string | null;
  path: string;
  content: string | null;
  content_size_bytes: number;
  content_sha256: string;
  created_at: string;
  updated_at: string;
};

export type Skill = {
  id: string;
  type: 'skill';
  name: string;
  display_title: string | null;
  description: string;
  compatibility: string | null;
  source: 'custom' | 'anthropic';
  latest_version: string | null;
  versions: Array<{ id: string; created_at: string | null; latest: boolean }>;
  created_at: string | null;
  updated_at: string | null;
  file: string | null;
};

export type Template = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  summary: string;
  skill_ids: string[];
  agent: {
    name: string;
    model: string;
    model_config?: { id?: string; speed: string; effort?: string };
    description?: string;
    system: string;
    mcp_servers?: Array<Record<string, unknown>>;
    tools: AgentToolset[];
    skills: SkillRef[];
    metadata?: Record<string, unknown>;
  };
};

export type Webhook = {
  id: string;
  type: 'webhook';
  name: string;
  url: string;
  events: string[];
  description: string;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type ScheduledDeployment = {
  id: string;
  type: 'scheduled_deployment';
  name: string;
  agent_id: string;
  environment_id: string | null;
  cron: string;
  payload: Record<string, unknown>;
  status: string;
  last_run_at: string | null;
  next_run_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type Outcome = {
  id: string;
  type: 'outcome';
  name: string;
  description: string;
  objective: string;
  criteria: unknown[];
  pass_threshold: number;
  evaluator: string;
  metadata: Record<string, unknown>;
  status: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type RuntimeConfigState = 'configured' | 'missing_env' | 'not_set';

export type RuntimeModel = {
  name: string;
  provider: string;
  model: string;
  base_url?: string;
  api_key_state: RuntimeConfigState;
  base_url_state: RuntimeConfigState;
  is_default: boolean;
};

export type RuntimeMemoryProviderKind = 'in_memory' | 'sqlite' | 'database' | 'mem0' | 'memu';
export type RuntimeMemoryProviderStatus = 'active' | 'adapter_required';

export type RuntimeMemoryProvider = {
  name: string;
  provider: RuntimeMemoryProviderKind;
  provider_label: string;
  connection_url?: string;
  connection_url_state: RuntimeConfigState;
  api_key_state: RuntimeConfigState;
  is_default: boolean;
  status: RuntimeMemoryProviderStatus;
  runtime_capable: boolean;
  created_at: string;
  updated_at: string;
};

export type RuntimeStorageProviderRole = 'metadata' | 'artifact';
export type RuntimeStorageProviderKind = 'sqlite' | 'postgres' | 'mysql' | 'local_filesystem' | 's3';
export type RuntimeStorageProviderStatus = 'active' | 'init_required' | 'adapter_required';

export type RuntimeStorageProvider = {
  name: string;
  role: RuntimeStorageProviderRole;
  provider: RuntimeStorageProviderKind;
  provider_label: string;
  connection_url?: string;
  connection_url_state: RuntimeConfigState;
  bucket?: string;
  region?: string;
  base_path?: string;
  access_key_state: RuntimeConfigState;
  secret_key_state: RuntimeConfigState;
  is_default: boolean;
  status: RuntimeStorageProviderStatus;
  runtime_capable: boolean;
  initialized_at?: string;
  created_at: string;
  updated_at: string;
};

export type Runtime = {
  status: string;
  agents_loaded: number;
  skills_loaded: number;
  models: RuntimeModel[];
  sandbox_providers: string[];
  memory: string;
  memory_providers: RuntimeMemoryProvider[];
  storage_providers: RuntimeStorageProvider[];
  auth_enabled: boolean;
};

export type SettingsAdapterDescriptor = {
  id: string;
  label: string;
  version: string;
  status: 'available' | 'unavailable' | 'invalid';
  restart_policy: 'none' | 'runtime';
  options_schema: Record<string, unknown>;
};

export type RuntimeSettingsConfig = {
  schema_version: 1;
  model: { vendor: 'openai' | 'anthropic' | 'openai_compatible' | 'minimax'; base_url?: string; api_key?: string; options: Record<string, unknown> };
  loop_engine: {
    provider: 'builtin' | 'harness' | 'codex' | 'claude';
    options: {
      default_max_steps: number;
      /**
       * Platform-owned Pi gate behaviour, mirroring
       * `loop_engine.options.approval_mode` in Runtime Settings.
       */
      approval_mode?: 'interactive' | 'preauthorized_once';
      [key: string]: unknown;
    };
  };
  storage: {
    metadata: { provider: 'sqlite' | 'postgres' | 'mysql'; options: Record<string, unknown> };
    artifacts: { provider: 'local' | 's3'; options: Record<string, unknown> };
  };
  memory: { enabled: boolean; provider: 'sqlite' | 'memu' | 'mem0'; options: Record<string, unknown> };
  sandbox: { provider: 'local' | 'docker' | 'kubernetes' | 'remote'; options: { timeout_seconds: number; [key: string]: unknown } };
};

export type RuntimeSettings = {
  schema_version: 1;
  revision: number;
  effective_revision: number;
  saved_config: RuntimeSettingsConfig;
  effective_config: RuntimeSettingsConfig;
  restart_required: boolean;
  activation_status: 'active' | 'pending' | 'failed';
  activation_errors: Array<{ path: string; code: string; message: string }>;
  diagnostics: { metadata: { path: string | null; health: 'ok' | 'failed' } };
  secret_states: { model: { api_key: RuntimeConfigState } };
  adapters: {
    model: SettingsAdapterDescriptor[];
    loop_engine: SettingsAdapterDescriptor[];
    storage: { metadata: SettingsAdapterDescriptor[]; artifacts: SettingsAdapterDescriptor[] };
    memory: SettingsAdapterDescriptor[];
    sandbox: SettingsAdapterDescriptor[];
  };
};

export type RuntimeMetricsSummary = {
  type: 'metrics_summary';
  generated_at: string;
  sessions: {
    total: number;
    by_status: Record<string, number>;
    input_tokens: number;
    output_tokens: number;
  };
  events: {
    total: number;
    by_type: Record<string, number>;
    input_tokens: number;
    output_tokens: number;
    average_duration_ms: number;
  };
  storage: {
    files: number;
    file_bytes: number;
    artifacts: number;
    artifact_bytes: number;
  };
  work_queue: Record<string, number>;
  http: {
    requests: number;
    errors: number;
    request_duration_ms: { count: number; sum: number };
  };
};

export type RuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type RuntimeLogEntry = {
  level: RuntimeLogLevel;
  time: string;
  msg: string;
  line: string;
  [key: string]: unknown;
};

export type Workspace = {
  type: 'workspace';
  name: string;
  root?: string;
  configDir?: string;
  dataDir?: string;
  databasePath?: string;
  agentsDir?: string;
  skillsDir?: string;
  configPath?: string;
  logFile?: string;
  logsDir?: string;
  target?: string;
  directories?: {
    root?: string;
    agents?: string;
    skills?: string;
    data?: string;
    database?: string;
    config?: string;
    logs?: string;
    logFile?: string;
  };
};

export type ConsoleData = {
  agents: Agent[];
  sessions: Session[];
  environments: Environment[];
  vaults: Vault[];
  memoryStores: MemoryStore[];
  files: WorkspaceFile[];
  apiKeys: ApiKey[];
  skills: Skill[];
  templates: Template[];
  webhooks: Webhook[];
  scheduledDeployments: ScheduledDeployment[];
  outcomes: Outcome[];
  runtime: Runtime | null;
  workspace: Workspace | null;
  settings: RuntimeSettings | null;
};

export type ViewId =
  | 'agents'
  | 'sessions'
  | 'environments'
  | 'environment-detail'
  | 'credential-vaults'
  | 'credential-vault-detail'
  | 'memory-stores'
  | 'memory-store-detail'
  | 'skills'
  | 'files'
  | 'workspace'
  | 'runtime'
  | 'models'
  | 'loop-engine'
  | 'storage'
  | 'memory'
  | 'sandbox'
  | 'logs'
  | 'monitoring'
  | 'api-reference'
  | 'api-keys'
  | 'webhooks'
  | 'scheduled-deployments'
  | 'outcomes'
  | 'advanced'
  | 'observability'
  | 'agent-detail'
  | 'session-detail'
  | 'settings';

export type AgentTab = 'agent' | 'sessions' | 'deployments' | 'observability';
