import type { Agent } from '../types';

/**
 * Pure logic behind the agent version diff workflow (Console-side item #9 of
 * the gap plan: side-by-side diff, restore-as-draft prefill, and the local
 * pre-save validation the edit modals run before the server round-trip).
 *
 * Everything here is framework-free so it can be unit-tested without a DOM.
 */

export type AgentDiffKind = 'unchanged' | 'changed' | 'added' | 'removed';

export interface AgentFieldDiff {
  /** Stable machine field key, also used as the React key. */
  field: string;
  label: string;
  kind: AgentDiffKind;
  /** Renderable value on the base (older) side; empty string when added. */
  base: string;
  /** Renderable value on the next (newer) side; empty string when removed. */
  next: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Enabled built-in tool names plus one entry per MCP toolset, sorted. */
export function agentToolList(agent: Agent): string[] {
  const names: string[] = [];
  // The union widens past AgentToolset so a draft carrying the legacy grouped
  // `custom_toolset` shape still diffs honestly instead of dropping silently.
  for (const toolset of (agent.tools ?? []) as Array<Agent['tools'][number] | { type: 'custom_toolset'; configs?: unknown[] }>) {
    if (toolset.type === 'custom') {
      names.push(`${toolset.name} (custom)`);
      continue;
    }
    if (toolset.type === 'mcp_toolset') {
      names.push(`${toolset.mcp_server_name} (mcp)`);
      continue;
    }
    if (toolset.type === 'custom_toolset') {
      for (const config of toolset.configs ?? []) {
        if (isPlainObject(config) && typeof config.name === 'string') names.push(`${config.name} (custom)`);
      }
      continue;
    }
    for (const [name, config] of Object.entries(toolset.configs ?? {})) {
      if (config?.enabled !== false) names.push(name);
    }
  }
  return [...new Set(names)].sort();
}

function agentSkillList(agent: Agent): string[] {
  return [...new Set((agent.skills ?? []).map((skill) => skill.skill_id))].sort();
}

function agentMcpList(agent: Agent): string[] {
  return (agent.mcp_servers ?? [])
    .map((server) => (typeof server?.name === 'string' && server.name ? server.name : 'unnamed server'))
    .sort();
}

function agentMetadataList(agent: Agent): string[] {
  return Object.entries(agent.metadata ?? {})
    .map(([key, value]) => `${key}=${String(value)}`)
    .sort();
}

function modelSpeed(agent: Agent): string {
  return agent.model_config?.speed ?? 'standard';
}

const CUSTOM_TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** One custom tool shape — shared by the canonical entry and custom_toolset configs. */
function validateCustomToolShape(tool: unknown, label: string, issues: string[]): void {
  if (!isPlainObject(tool)) {
    issues.push(`${label} must be an object.`);
    return;
  }
  if (typeof tool.name !== 'string' || !CUSTOM_TOOL_NAME.test(tool.name)) {
    issues.push(`${label} needs a name starting with a letter (letters, numbers, underscores, hyphens only).`);
  }
  if (typeof tool.description !== 'string' || !tool.description.trim()) {
    issues.push(`${label} needs a description.`);
  }
  if (!isPlainObject(tool.input_schema) && !isPlainObject(tool.parameters)) {
    issues.push(`${label} needs an input_schema JSON object.`);
  }
}

function kindFor(base: string, next: string): AgentDiffKind {
  if (base === next) return 'unchanged';
  if (!base) return 'added';
  if (!next) return 'removed';
  return 'changed';
}

/** Field-level diff of two stored agent versions, base = older, next = newer. */
export function diffAgentVersions(base: Agent, next: Agent): AgentFieldDiff[] {
  const rows: Array<{ field: string; label: string; base: string; next: string }> = [
    { field: 'name', label: 'Name', base: base.name, next: next.name },
    { field: 'description', label: 'Description', base: base.description ?? '', next: next.description ?? '' },
    { field: 'model', label: 'Model', base: base.model, next: next.model },
    { field: 'model_config', label: 'Model config', base: modelSpeed(base), next: modelSpeed(next) },
    { field: 'max_turns', label: 'Max turns', base: base.max_turns === undefined ? '' : String(base.max_turns), next: next.max_turns === undefined ? '' : String(next.max_turns) },
    { field: 'system', label: 'System prompt', base: base.system, next: next.system },
    { field: 'tools', label: 'Tools', base: agentToolList(base).join('\n'), next: agentToolList(next).join('\n') },
    { field: 'skills', label: 'Skills', base: agentSkillList(base).join('\n'), next: agentSkillList(next).join('\n') },
    { field: 'mcp_servers', label: 'MCP servers', base: agentMcpList(base).join('\n'), next: agentMcpList(next).join('\n') },
    { field: 'metadata', label: 'Metadata', base: agentMetadataList(base).join(', '), next: agentMetadataList(next).join(', ') },
  ];
  return rows.map((row) => ({
    field: row.field,
    label: row.label,
    kind: kindFor(row.base, row.next),
    base: row.base,
    next: row.next,
  }));
}

/**
 * Local pre-save validation for a parsed agent draft. This mirrors the
 * required-field checks the server performs on `POST/PUT /v1/agents` so the
 * operator sees the obvious problems before spending the round-trip; the
 * server remains the authority and re-validates everything on save.
 */
export function validateAgentDraft(draft: unknown): string[] {
  if (!isPlainObject(draft)) return ['Agent config must be a mapping of fields.'];
  const issues: string[] = [];
  if (typeof draft.name !== 'string' || !draft.name.trim()) issues.push('name is required.');
  if (typeof draft.model !== 'string' || !draft.model.trim()) issues.push('model is required.');
  if (typeof draft.system !== 'string' || !draft.system.trim()) issues.push('system prompt is required.');
  if (draft.description !== undefined && typeof draft.description !== 'string') {
    issues.push('description must be text.');
  }
  if (draft.tools !== undefined) {
    if (!Array.isArray(draft.tools)) {
      issues.push('tools must be a list of toolsets.');
    } else {
      draft.tools.forEach((toolset, index) => {
        if (!isPlainObject(toolset)) {
          issues.push(`tools[${index}] must be a toolset or custom tool entry.`);
          return;
        }
        if (toolset.type === 'custom') {
          validateCustomToolShape(toolset, `tools[${index}]`, issues);
          return;
        }
        if (toolset.type === 'custom_toolset') {
          const configs = Array.isArray(toolset.configs) ? toolset.configs : [];
          if (!configs.length) issues.push(`tools[${index}] (custom_toolset) must declare at least one tool.`);
          configs.forEach((config, configIndex) => validateCustomToolShape(config, `tools[${index}].configs[${configIndex}]`, issues));
          return;
        }
        if (toolset.type !== 'agent_toolset_20260401' && toolset.type !== 'mcp_toolset') {
          issues.push(`tools[${index}] must be an agent_toolset_20260401, mcp_toolset, custom_toolset, or custom entry.`);
          return;
        }
        if (toolset.type === 'mcp_toolset' && (typeof toolset.mcp_server_name !== 'string' || !toolset.mcp_server_name)) {
          issues.push(`tools[${index}] (mcp_toolset) needs a mcp_server_name.`);
        }
      });
    }
  }
  if (draft.skills !== undefined) {
    if (!Array.isArray(draft.skills)) {
      issues.push('skills must be a list.');
    } else {
      draft.skills.forEach((skill, index) => {
        if (!isPlainObject(skill) || typeof skill.skill_id !== 'string' || !skill.skill_id) {
          issues.push(`skills[${index}] needs a skill_id.`);
        }
      });
    }
  }
  if (draft.mcp_servers !== undefined && !Array.isArray(draft.mcp_servers)) {
    issues.push('mcp_servers must be a list.');
  }
  // The published bound: a positive integer no larger than 1000.
  if (draft.max_turns !== undefined && (!Number.isInteger(draft.max_turns) || (draft.max_turns as number) < 1 || (draft.max_turns as number) > 1000)) {
    issues.push('max_turns must be an integer between 1 and 1000.');
  }
  if (draft.enable_general_subagent !== undefined && typeof draft.enable_general_subagent !== 'boolean') {
    issues.push('enable_general_subagent must be true or false.');
  }
  if (draft.metadata !== undefined) {
    if (!isPlainObject(draft.metadata)) {
      issues.push('metadata must be a mapping of strings.');
    } else {
      for (const [key, value] of Object.entries(draft.metadata)) {
        if (typeof value !== 'string') issues.push(`metadata.${key} must be a string.`);
      }
    }
  }
  return issues;
}
