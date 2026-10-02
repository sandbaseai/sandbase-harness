/**
 * Agent Definition Types
 *
 * Declarative agent configuration loaded from YAML/JSON files.
 */

// ============================================================
// Agent Definition (loaded from YAML)
// ============================================================

export interface AgentDefinition {
  /** Unique identifier (required) */
  name: string;
  /** Model registry reference (required). Public/config field follows Claude's string model id shape. */
  model: string;
  /** Normalized system instructions. Public/config input may omit or clear `system`. */
  system: string;
  /** Human-readable description */
  description?: string;
  /** Skill references attached to this agent. */
  skills?: AgentSkillRef[];
  /** MCP server configurations. */
  mcp_servers?: McpServerConfig[];
  /** Built-in toolsets enabled for this agent. */
  tools?: AgentToolset[];
  /** Optional local runtime model policy. Not included in Claude's minimal template shape. */
  model_config?: AgentModelConfig;
  /** Free-form metadata for templates, provenance, UI hints, etc. */
  metadata?: Record<string, unknown>;
  /** Maximum conversation turns before forced stop */
  max_turns?: number;
  /** Model temperature */
  temperature?: number;
  /** Agent names this agent can delegate to (CMA callable_agents roster) */
  delegations?: string[];
  /** Enable CMA general_subagent tool for ad-hoc sub-task delegation */
  enable_general_subagent?: boolean;
  /** Strategy name (default: 'default') */
  strategy?: string;
  /** Environment name (default: 'local') */
  environment?: string;
}

export type AgentModelSpeed = 'fast' | 'standard' | 'extended';

export interface AgentModelConfig {
  id: string;
  speed: AgentModelSpeed;
  /**
   * Canonical reasoning-effort level, retained so a read-back echoes what the
   * caller sent. Nothing varies the provider request by it: the executor
   * resolves the provider model from `model` (the id string), so this field is
   * stored and projected, not executed.
   *
   * Typed as a plain string on purpose. `core/agent/model-object.ts` owns the
   * accepted set (`MODEL_EFFORT_LEVELS`) and the schema that enforces it on the
   * way in, and this module is the shared vocabulary the core imports from — so
   * the field stays a string here rather than adding a type-only import back into
   * the core layer. The cost is that a consumer reading this type does not see the
   * five levels; the benefit is that `types/` keeps no dependency on `core/`.
   */
  effort?: string;
}

// ============================================================
// MCP Server Configuration
// ============================================================

export interface McpServerConfig {
  /** MCP server transport type. `url` mirrors Claude's managed-agent MCP shape; `stdio` is local-first. */
  type: 'url' | 'stdio';
  /** Identifier for this MCP server */
  name: string;
  /** Command to run (stdio transport) */
  command?: string;
  /** Command arguments (stdio transport) */
  args?: string[];
  /** HTTP endpoint URL (http transport) */
  url?: string;
  /** Environment variables (supports ${ENV_VAR} syntax) */
  env?: Record<string, string>;
  /** Connection timeout in seconds (default: 30) */
  timeout?: number;
}

export interface AgentSkillRef {
  type: 'custom' | 'anthropic';
  skill_id: string;
  version?: string;
}

export type PermissionPolicyType = 'always_allow' | 'always_ask' | 'never_allow';

export interface AgentToolConfig {
  enabled?: boolean;
  permission_policy?: {
    type: PermissionPolicyType;
  };
}

export interface NamedAgentToolConfig extends AgentToolConfig {
  name: string;
  /**
   * `web_fetch` / `web_search` domain scope. At most one of the two lists may
   * be set on an entry. Validated by `core/agent/web-tool-policy.ts` so the
   * published list/index error paths survive; kept here so the policy survives
   * a read-back instead of being dropped by an unknown-key strip.
   */
  allowed_domains?: string[] | null;
  blocked_domains?: string[] | null;
  /** `web_fetch` only: cap on page content folded into context. */
  max_content_tokens?: number;
  /** `web_search` only: result localization. */
  user_location?: WebUserLocation;
}

/** Search-result localization; shape mirrors the Messages API parameter. */
export interface WebUserLocation {
  type?: string;
  country?: string;
  timezone?: string;
}

export type AgentToolset = BuiltinAgentToolset | McpToolset | CustomToolset | CanonicalCustomTool;

export interface JsonSchema {
  type?: string;
  [key: string]: unknown;
}

export interface CustomToolConfig extends AgentToolConfig {
  /** Stable model-visible name for the externally executed tool. */
  name: string;
  /** Human-readable description sent to the model. */
  description: string;
  /** JSON Schema for the tool input. `input_schema` is accepted on ingress. */
  parameters: JsonSchema;
  input_schema?: JsonSchema;
}

/**
 * Canonical CMA custom tool declaration.
 *
 * The published contract inlines an independent `tools[]` entry instead of
 * grouping custom tools under a toolset. It deliberately carries no permission
 * policy: the caller executes the tool and decides whether to run it, so a
 * policy field would claim governance the runtime does not have. SandBase
 * accepts this shape on ingress and projects it back on every agent response.
 */
export interface CanonicalCustomTool {
  type: 'custom';
  name: string;
  description: string;
  /** Canonical JSON Schema field name. `parameters` is accepted as a legacy alias. */
  input_schema: JsonSchema;
  parameters?: JsonSchema;
  /** Legacy-only: accepted from `custom_toolset` input, never projected canonically. */
  enabled?: boolean;
}

/** Legacy SandBase grouping of custom tools. Accepted on ingress, projected as {@link CanonicalCustomTool}. */
export interface CustomToolset {
  type: 'custom_toolset';
  configs?: CustomToolConfig[];
  default_config?: AgentToolConfig;
}

export interface BuiltinAgentToolset {
  type: 'agent_toolset_20260401';
  configs?: NamedAgentToolConfig[];
  default_config?: AgentToolConfig;
}

export interface McpToolset {
  type: 'mcp_toolset';
  mcp_server_name: string;
  configs?: NamedAgentToolConfig[];
  default_config?: AgentToolConfig;
}

// ============================================================
// Agent Runtime State
// ============================================================

export type AgentStatus = 'active' | 'error' | 'disabled';

export interface AgentRecord {
  id: string; // agent_xxx
  name: string;
  definition: AgentDefinition;
  status: AgentStatus;
  errorMessage?: string;
  loadedAt: Date;
  updatedAt: Date;
}

// ============================================================
// Agent Load Result
// ============================================================

export interface AgentLoadError {
  file: string;
  reason: string;
  field?: string;
}

export interface AgentLoadResult {
  agents: AgentDefinition[];
  errors: AgentLoadError[];
}

// ============================================================
// Per-session Agent Overrides
// ============================================================

/**
 * Session-local replacements for an agent's configuration.
 *
 * Each field follows the published three-rule contract: omitted inherits the
 * referenced agent version, `null` (or `[]` for a list) clears it for this
 * session, and any other value replaces it wholesale. Overrides never merge
 * with the agent's own configuration, and they never modify the agent or create
 * a version.
 *
 * See `core/agent/overrides.ts` for the resolution and its documented
 * exceptions.
 */
export interface AgentOverrides {
  /** Replaces the agent's model. `null` is refused — a session always needs one. */
  model?: { id: string; speed?: AgentModelSpeed; effort?: string } | null;
  /** Replaces the agent's system prompt. `null` clears it. */
  system?: string | null;
  /** Replaces the agent's toolsets. `null` or `[]` clears them. */
  tools?: AgentToolset[] | null;
  /** Replaces the agent's MCP servers. `null` or `[]` clears them. */
  mcp_servers?: McpServerConfig[] | null;
  /** Replaces the agent's skills. `null` or `[]` clears them. */
  skills?: AgentSkillRef[] | null;
}
