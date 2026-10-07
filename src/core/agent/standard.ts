import {
  BUILTIN_TOOL_NAMES,
  type AgentDefinition,
  type AgentToolConfig,
  type AgentToolset,
  type BuiltinAgentToolset,
  type CanonicalCustomTool,
  type CustomToolConfig,
  type McpToolset,
  type PermissionPolicyType,
} from '@/types/agent.js';
import { MCP_TOOL_PREFIX, mcpServerToolPrefix, resolveMcpServerName } from '@/core/mcp/tool-naming.js';

export const DEFAULT_AGENT_TOOLSET_TYPE = 'agent_toolset_20260401';

/**
 * Default permission policy by toolset kind, or `undefined` when the kind is
 * not governed by permission policy.
 *
 * Custom tools carry no default at all: the caller executes them and decides
 * whether to run them, so there is no policy for the runtime to apply.
 */
const DEFAULT_TOOLSET_PERMISSION: Readonly<Partial<Record<AgentToolset['type'], PermissionPolicyType>>> = {
  agent_toolset_20260401: 'always_allow',
  // An MCP server is third-party surface: a call reaches the user for approval
  // unless the agent explicitly opts out. Declaring no default here would widen
  // the local runtime to `always_allow` and auto-run third-party tools, which
  // is a security regression rather than a compatibility gap.
  mcp_toolset: 'always_ask',
  custom_toolset: undefined,
  custom: undefined,
};

/** Default permission policy for a toolset kind, or `undefined` when not governed. */
export function defaultToolsetPermission(type: AgentToolset['type']): PermissionPolicyType | undefined {
  return DEFAULT_TOOLSET_PERMISSION[type];
}

/** Project a canonical `custom` entry to the internal config shape. */
export function canonicalToConfig(tool: CanonicalCustomTool): CustomToolConfig {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    input_schema: tool.input_schema,
  };
}

/**
 * Find one custom tool's config by name, in either wire shape.
 *
 * The canonical `custom` entry carries no `enabled` flag and no permission
 * policy by design; a legacy `custom_toolset` may carry both. Returning one
 * shape here keeps every consumer from branching on the wire form.
 */
export function findCustomToolConfig(toolset: AgentToolset, toolName: string): CustomToolConfig | undefined {
  if (toolset.type === 'custom') {
    return toolset.name === toolName ? canonicalToConfig(toolset) : undefined;
  }
  if (toolset.type === 'custom_toolset') {
    return (toolset.configs ?? []).find((config) => config.name === toolName);
  }
  return undefined;
}

export function getAgentSkillIds(agent: AgentDefinition): string[] {
  return (agent.skills ?? []).map((skill) => skill.skill_id);
}

export function getEnabledToolNames(agent: AgentDefinition): string[] {
  const names = new Set<string>();
  for (const toolset of getAgentToolsets(agent)) {
    const defaultEnabled = toolset.default_config?.enabled !== false;
    // The published semantic: including the toolset enables every built-in.
    // `configs` entries only disable or reconfigure specific tools, so the
    // base set is the full inventory rather than the listed names.
    if (defaultEnabled) {
      for (const name of BUILTIN_TOOL_NAMES) names.add(name);
    }
    for (const config of toolset.configs ?? []) {
      const enabled = config.enabled ?? defaultEnabled;
      const admitted = enabled && getPermissionPolicy(config, toolset.default_config, toolset.type) !== 'never_allow';
      if (admitted) {
        names.add(config.name);
      } else {
        names.delete(config.name);
      }
    }
  }
  for (const toolset of agent.tools ?? []) {
    if (toolset.type === 'custom') {
      names.add(toolset.name);
      continue;
    }
    if (toolset.type !== 'custom_toolset') continue;
    const defaultEnabled = toolset.default_config?.enabled !== false;
    for (const config of toolset.configs ?? []) {
      const enabled = config.enabled ?? defaultEnabled;
      if (enabled && getPermissionPolicy(config, toolset.default_config, toolset.type) !== 'never_allow') {
        names.add(config.name);
      }
    }
  }
  return [...names];
}

/**
 * The tools a caller named in `configs`, without the toolset-level default.
 * Capability admission checks use this: an implicitly enabled built-in is the
 * published default rather than a request, so only an explicit declaration can
 * be refused as unsupported.
 */
export function getExplicitlyEnabledToolNames(agent: AgentDefinition): string[] {
  const names = new Set<string>();
  for (const toolset of agent.tools ?? []) {
    if (toolset.type !== DEFAULT_AGENT_TOOLSET_TYPE && toolset.type !== 'custom_toolset') {
      if (toolset.type === 'custom') names.add(toolset.name);
      continue;
    }
    const defaultEnabled = toolset.default_config?.enabled !== false;
    for (const config of toolset.configs ?? []) {
      const enabled = config.enabled ?? defaultEnabled;
      if (enabled && getPermissionPolicy(config, toolset.default_config, toolset.type) !== 'never_allow') {
        names.add(config.name);
      }
    }
  }
  return [...names];
}

/** Every custom tool the agent declares, in one internal config shape. */
export function getCustomToolConfigs(agent: AgentDefinition): CustomToolConfig[] {
  return (agent.tools ?? []).flatMap((toolset) => {
    if (toolset.type === 'custom') return [canonicalToConfig(toolset)];
    if (toolset.type !== 'custom_toolset') return [];
    return (toolset.configs ?? []).map((config) => ({
      ...config,
      parameters: config.parameters ?? config.input_schema!,
    }));
  });
}

/** The model-visible names of every enabled custom tool. */
export function getCustomToolNames(agent: AgentDefinition): string[] {
  return (agent.tools ?? []).flatMap((toolset) => {
    if (toolset.type === 'custom') return [toolset.name];
    if (toolset.type !== 'custom_toolset') return [];
    const defaultEnabled = toolset.default_config?.enabled !== false;
    return (toolset.configs ?? [])
      .filter((config) => (config.enabled ?? defaultEnabled) && getPermissionPolicy(config, toolset.default_config, toolset.type) !== 'never_allow')
      .map((config) => config.name);
  });
}

export function getToolPermission(agent: AgentDefinition, toolName: string): PermissionPolicyType {
  // 1. An explicit per-tool config wins wherever the tool is declared. A config
  //    may be addressed by the bare declared name or by the namespaced runtime
  //    name, since both denote the same tool.
  for (const toolset of (agent.tools ?? [])) {
    if (toolset.type !== 'agent_toolset_20260401' && toolset.type !== 'mcp_toolset') continue;
    const candidates = toolset.type === 'mcp_toolset'
      ? [toolName, unnamespacedMcpTool(toolset.mcp_server_name, toolName)]
      : [toolName];
    const config = toolset.configs?.find(
      (item) => candidates.some((candidate) => candidate !== undefined && item.name === candidate),
    );
    if (config) return getPermissionPolicy(config, toolset.default_config, toolset.type);
  }

  // 2. A canonical custom tool is not governed by permission policy: the caller
  //    executes it and decides. Reporting a policy would fabricate governance
  //    the runtime never applies.
  for (const toolset of (agent.tools ?? [])) {
    if (toolset.type === 'custom' && toolset.name === toolName) return 'always_allow';
  }

  // 3. A legacy custom toolset carries its own policy.
  for (const toolset of (agent.tools ?? [])) {
    if (toolset.type !== 'custom_toolset') continue;
    const config = toolset.configs?.find((item) => item.name === toolName);
    if (config) return getPermissionPolicy(config, toolset.default_config, toolset.type);
  }

  // 4. A tool discovered from an MCP server is rarely named in `configs`:
  //    servers expose their tools at connect time. Falling through to
  //    `always_allow` here would auto-run third-party tools, so the owning
  //    toolset's default applies by server name before any last resort.
  const mcpToolset = findMcpToolsetForTool(agent, toolName);
  if (mcpToolset) return getPermissionPolicy(undefined, mcpToolset.default_config, mcpToolset.type);

  return 'always_allow';
}

/**
 * Whether a tool a server actually exposed should reach the model.
 *
 * An MCP server's tool list is only known after connect, so the declared
 * `configs` cannot be the whole story. The published contract resolves this by
 * making the toolset's `default_config` the admission rule for anything not
 * named: a discovered tool is admitted unless the toolset is disabled by
 * default, and a tool named in `configs` is admitted unless its own `enabled`
 * says otherwise. A tool configured `never_allow` is not merely gated — it must
 * not appear at all, or the model would be invited to call something the
 * operator forbade.
 *
 * Returning `false` here rather than gating later is what keeps a newly
 * discovered MCP tool from bypassing the `always_ask` default: shipping it and
 * hoping the confirmation layer catches it depends on the tool name matching a
 * declared config, which is exactly what discovery does not guarantee.
 */
export function mcpDiscoveredToolAdmitted(agent: AgentDefinition, serverName: string, toolName: string): boolean {
  const toolset = (agent.tools ?? []).find(
    (candidate): candidate is McpToolset =>
      candidate.type === 'mcp_toolset' && candidate.mcp_server_name === serverName,
  );
  // No declared toolset for this server means the agent never opted into its
  // tools; they must not be admitted on the strength of the server being listed.
  if (!toolset) return false;

  const config = (toolset.configs ?? []).find((item) => item.name === toolName);
  if (config) {
    const enabled = config.enabled ?? toolset.default_config?.enabled !== false;
    return enabled && getPermissionPolicy(config, toolset.default_config, toolset.type) !== 'never_allow';
  }

  // A tool the server exposed but the agent never named is governed by the
  // toolset default alone. That default can deny as well as ask: checking only
  // `enabled` here would hand the model a tool the operator forbade, which is
  // the failure the `never_allow` rule exists to prevent.
  if (toolset.default_config?.enabled === false) return false;
  return getPermissionPolicy(undefined, toolset.default_config, toolset.type) !== 'never_allow';
}

export function getToolsRequiringConfirmation(agent: AgentDefinition): string[] {
  const customNames = new Set(getCustomToolNames(agent));
  const explicit = getEnabledToolNames(agent).filter(
    (toolName) => !customNames.has(toolName) && getToolPermission(agent, toolName) === 'always_ask',
  );

  const declared = new Set(explicit);
  for (const toolset of (agent.tools ?? [])) {
    if (toolset.type !== 'mcp_toolset') continue;
    if (getPermissionPolicy(undefined, toolset.default_config, toolset.type) !== 'always_ask') continue;
    for (const config of toolset.configs ?? []) {
      if (config.permission_policy?.type === 'always_allow') continue;
      if ((config.enabled ?? toolset.default_config?.enabled !== false) === false) continue;
      // The runtime gates by the name that reaches the model, and an MCP tool
      // always carries the `mcp_<server>_` prefix. Returning the bare declared
      // name here would never match, so the tool would run unapproved.
      declared.add(mcpServerToolPrefix(toolset.mcp_server_name) + config.name);
    }
  }
  return [...declared];
}

/**
 * Runtime names that must reach the user for approval, derived from the tool
 * map actually resolved for this turn.
 *
 * {@link getToolsRequiringConfirmation} can only enumerate declared tools, and
 * an MCP server's tool list is unknown until connect. A tool the server exposed
 * but the agent never named therefore appears in no `configs` entry, so a
 * declaration-only list cannot gate it: it is admitted by the toolset default,
 * keeps its `execute`, and the strategy — which matches `confirmTools` against
 * the model-visible name — sees no match and runs it unapproved. That is the
 * exact bypass the `always_ask` MCP default exists to prevent.
 *
 * The resolved tool map is the first point where those names exist, so the
 * decision is re-derived from it. Only namespaced MCP names are considered: the
 * unqualified-name fallback in {@link getToolPermission} is deliberate for a
 * single declared server, and applying it to built-in or delegation tool names
 * would gate tools this rule has no opinion about.
 */
export function resolveToolsRequiringConfirmation(
  agent: AgentDefinition,
  resolvedToolNames: Iterable<string>,
): string[] {
  const required = new Set(getToolsRequiringConfirmation(agent));
  for (const name of resolvedToolNames) {
    if (!name.startsWith(MCP_TOOL_PREFIX)) continue;
    if (getToolPermission(agent, name) !== 'always_ask') continue;
    required.add(name);
  }
  return [...required];
}

export function getAgentToolsets(agent: AgentDefinition): BuiltinAgentToolset[] {
  return (agent.tools ?? []).filter((toolset) => toolset.type === DEFAULT_AGENT_TOOLSET_TYPE);
}

/**
 * Runtime names governed by the `auto` permission policy, derived from the
 * tool map actually resolved for this turn.
 *
 * Same resolved-map derivation as {@link resolveToolsRequiringConfirmation}:
 * an MCP server exposes its tool list only at connect time, so a tool the
 * agent never named appears in no `configs` entry and a declaration-only list
 * cannot govern it. `getToolPermission` applies the owning toolset's default
 * to a discovered namespaced name, so a toolset-wide `auto` reaches the tools
 * the server adds later as well.
 *
 * Custom tools are excluded for the reason {@link getToolsRequiringConfirmation}
 * excludes them from the confirmation set: the caller executes them and decides
 * whether to run, so a server-side judgement would be unenforced decoration.
 * A `never_allow` custom tool is already withheld at admission; `auto` on one
 * reads as the caller's decision, exactly like `always_ask` does today.
 */
/**
 * The permission policy a resolved, model-visible tool name actually runs
 * under — `undefined` when no declared policy governs the name.
 *
 * {@link getToolPermission} answers a wider question (it projects the single
 * declared MCP server's default onto any unqualified name, which is what the
 * admission and confirmation rules want) — too wide for runtime governance: a
 * built-in name like `bash` must never inherit an MCP toolset's default, and a
 * delegation or custom name is not governed at all. This resolver is the
 * stricter reading the evaluation gate and the event projection share:
 *
 * - namespaced MCP names resolve through the owning toolset, including the
 *   toolset default for tools the server exposed but the agent never named;
 * - built-in names resolve through the built-in toolset's explicit config,
 *   falling back to the toolset `default_config` — the same grammar
 *   `docs/api.md` promises (`default_config` "overrides that default in both
 *   directions"), which `getToolPermission` only reaches for named configs;
 * - anything else — custom tools the caller executes, delegation helpers, a
 *   built-in name an agent without the built-in toolset could not have
 *   resolved — is `undefined`, so no caller fabricates governance.
 */
export function runtimeToolPermission(
  agent: AgentDefinition,
  toolName: string,
): PermissionPolicyType | undefined {
  if (getCustomToolNames(agent).includes(toolName)) return undefined;
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return getToolPermission(agent, toolName);
  const builtinToolsets = getAgentToolsets(agent);
  if (builtinToolsets.length === 0) return undefined;
  if (!BUILTIN_TOOL_NAMES.includes(toolName as (typeof BUILTIN_TOOL_NAMES)[number])) return undefined;
  for (const toolset of builtinToolsets) {
    const config = toolset.configs?.find((item) => item.name === toolName);
    if (config) return getPermissionPolicy(config, toolset.default_config, toolset.type);
  }
  // No tool named the tool: the toolset default is the declared policy. When
  // several built-in toolsets disagree — a pathological shape — the strictest
  // default wins rather than the first.
  const defaults = builtinToolsets.map(
    (toolset) => getPermissionPolicy(undefined, toolset.default_config, toolset.type),
  );
  return defaults.find((policy) => policy === 'never_allow')
    ?? defaults.find((policy) => policy === 'always_ask')
    ?? defaults.find((policy) => policy === 'auto')
    ?? 'always_allow';
}

export function resolveToolsRequiringEvaluation(
  agent: AgentDefinition,
  resolvedToolNames: Iterable<string>,
): string[] {
  const required = new Set<string>();
  for (const name of resolvedToolNames) {
    if (runtimeToolPermission(agent, name) === 'auto') required.add(name);
  }
  return [...required];
}

function getPermissionPolicy(
  config: AgentToolConfig | undefined,
  defaultConfig: AgentToolConfig | undefined,
  toolsetType: AgentToolset['type'],
): PermissionPolicyType {
  return config?.permission_policy?.type
    ?? defaultConfig?.permission_policy?.type
    ?? defaultToolsetPermission(toolsetType)
    ?? 'always_allow';
}

/**
 * Undo the runtime namespacing so a config can address a discovered tool.
 *
 * A declared MCP tool is written as its bare name (`read_file`) because that is
 * what the server calls it, while the runtime and the model see
 * `mcp_filesystem_read_file`. Comparing the two directly is how an explicit
 * `always_allow` silently fails to apply and a tool falls back to the toolset
 * default — so the bare name is recovered before the config lookup.
 */
function unnamespacedMcpTool(server: string, toolName: string): string | undefined {
  const prefix = mcpServerToolPrefix(server);
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : undefined;
}

/**
 * Resolve which declared MCP toolset owns a model-visible tool name.
 *
 * The runtime namespaces MCP tools as `mcp_<server>_<tool>`, so the server is
 * recovered by matching the name against the declared server names and taking
 * the longest match — both segments may contain underscores, and a server
 * called `fs` must not claim a tool belonging to `fs_extra`.
 *
 * A definition with exactly one MCP toolset also binds an unqualified name,
 * because there is only one server the call could belong to. With several
 * servers an unqualified name is ambiguous, and claiming a policy for it would
 * guess the wrong toolset.
 */
function findMcpToolsetForTool(agent: AgentDefinition, toolName: string): McpToolset | undefined {
  const toolsets = (agent.tools ?? []).filter((toolset): toolset is McpToolset => toolset.type === 'mcp_toolset');
  if (toolsets.length === 0) return undefined;

  const server = resolveMcpServerName(toolName, toolsets.map((toolset) => toolset.mcp_server_name));
  if (server) return toolsets.find((toolset) => toolset.mcp_server_name === server);

  return toolsets.length === 1 ? toolsets[0] : undefined;
}
