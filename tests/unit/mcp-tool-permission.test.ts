import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { validateAgentDefinition } from '@/core/agent/schema.js';
import {
  defaultToolsetPermission,
  getToolPermission,
  getToolsRequiringConfirmation,
  mcpDiscoveredToolAdmitted,
  resolveToolsRequiringEvaluation,
} from '@/core/agent/standard.js';
import type { AgentDefinition } from '@/types/agent.js';

function agentWithTools(tools: AgentDefinition['tools']): AgentDefinition {
  return {
    name: 'billing',
    model: 'test-model',
    system: 'You help with billing.',
    tools,
  };
}

describe('default permission policy by toolset type', () => {
  it('defaults the built-in toolset to always_allow', () => {
    expect(defaultToolsetPermission('agent_toolset_20260401')).toBe('always_allow');
  });

  it('defaults an MCP toolset to always_ask', () => {
    expect(defaultToolsetPermission('mcp_toolset')).toBe('always_ask');
  });

  it('requires confirmation for an unconfigured MCP tool', () => {
    const agent = agentWithTools([
      { type: 'mcp_toolset', mcp_server_name: 'filesystem' },
    ]);

    // A server's tools are discovered at connect time, not declared up front,
    // so the gate is resolved per tool name rather than from a static list.
    expect(getToolPermission(agent, 'mcp__filesystem__read_file')).toBe('always_ask');
  });

  it('lists declared MCP tools that inherit the always_ask default', () => {
    const agent = agentWithTools([
      {
        type: 'mcp_toolset',
        mcp_server_name: 'filesystem',
        configs: [{ name: 'read_file' }, { name: 'write_file', permission_policy: { type: 'always_allow' } }],
      },
    ]);

    // The gate is keyed by the runtime name the model calls, not the bare
    // declared name — the strategy matches `toolCall.toolName`, which is
    // always namespaced.
    expect(getToolsRequiringConfirmation(agent)).toEqual(['mcp_filesystem_read_file']);
  });

  it('does not gate an MCP tool when the toolset opts into always_allow', () => {
    const agent = agentWithTools([
      {
        type: 'mcp_toolset',
        mcp_server_name: 'filesystem',
        default_config: { permission_policy: { type: 'always_allow' } },
        configs: [{ name: 'read_file' }],
      },
    ]);

    expect(getToolPermission(agent, 'mcp__filesystem__read_file')).toBe('always_allow');
    expect(getToolsRequiringConfirmation(agent)).toEqual([]);
  });

  it('keeps an unconfigured built-in tool auto-allowed', () => {
    const agent = agentWithTools([
      {
        type: 'agent_toolset_20260401',
        configs: [{ name: 'read' }],
      },
    ]);

    expect(getToolPermission(agent, 'read')).toBe('always_allow');
    expect(getToolsRequiringConfirmation(agent)).toEqual([]);
  });

  it('lets an explicit policy override the toolset default in both directions', () => {
    const mcpAllowed = agentWithTools([
      {
        type: 'mcp_toolset',
        mcp_server_name: 'filesystem',
        configs: [{ name: 'read_file', permission_policy: { type: 'always_allow' } }],
      },
    ]);
    const builtinAsked = agentWithTools([
      {
        type: 'agent_toolset_20260401',
        configs: [{ name: 'bash', permission_policy: { type: 'always_ask' } }],
      },
    ]);

    expect(getToolPermission(mcpAllowed, 'read_file')).toBe('always_allow');
    expect(getToolPermission(builtinAsked, 'bash')).toBe('always_ask');
  });
});

describe('auto permission policy', () => {
  it('is accepted by the agent definition schema on configs and defaults', () => {
    const perTool = validateAgentDefinition({
      name: 'a', model: 'm', system: 's',
      tools: [{
        type: 'agent_toolset_20260401',
        configs: [{ name: 'bash', permission_policy: { type: 'auto' } }],
      }],
    });
    const perDefault = validateAgentDefinition({
      name: 'a', model: 'm', system: 's',
      tools: [{
        type: 'agent_toolset_20260401',
        default_config: { permission_policy: { type: 'auto' } },
      }],
    });
    expect(perTool.valid).toBe(true);
    expect(perDefault.valid).toBe(true);
  });

  it('still rejects a policy value outside the published set', () => {
    const result = validateAgentDefinition({
      name: 'a', model: 'm', system: 's',
      tools: [{
        type: 'agent_toolset_20260401',
        configs: [{ name: 'bash', permission_policy: { type: 'sometimes' } }],
      }],
    });
    expect(result.valid).toBe(false);
  });

  it('resolves an explicit auto tool without touching the confirmation gate', () => {
    const agent = agentWithTools([
      {
        type: 'agent_toolset_20260401',
        configs: [{ name: 'bash', permission_policy: { type: 'auto' } }],
      },
    ]);

    expect(getToolPermission(agent, 'bash')).toBe('auto');
    // Evaluation is a superset of the approval gate, not a kind of it: an
    // `auto` tool is never a static `always_ask`.
    expect(getToolsRequiringConfirmation(agent)).toEqual([]);
    expect(resolveToolsRequiringEvaluation(agent, ['bash', 'read'])).toEqual(['bash']);
  });

  it('applies a toolset-wide auto default to every tool it governs', () => {
    const agent = agentWithTools([
      {
        type: 'agent_toolset_20260401',
        default_config: { permission_policy: { type: 'auto' } },
      },
    ]);

    expect(resolveToolsRequiringEvaluation(agent, ['bash', 'read'])).toEqual(['bash', 'read']);
  });

  it('covers an MCP tool the server exposed but the agent never named', () => {
    // The resolved map is the first place the discovered name exists, so the
    // derivation runs off that map — the same derivation `always_ask` uses.
    const agent = agentWithTools([
      {
        type: 'mcp_toolset',
        mcp_server_name: 'filesystem',
        default_config: { permission_policy: { type: 'auto' } },
      },
    ]);

    expect(resolveToolsRequiringEvaluation(agent, ['mcp_filesystem_read_file', 'bash']))
      .toEqual(['mcp_filesystem_read_file']);
  });

  it('lets a per-tool entry out of a toolset-wide auto default', () => {
    const agent = agentWithTools([
      {
        type: 'agent_toolset_20260401',
        default_config: { permission_policy: { type: 'auto' } },
        configs: [{ name: 'read', permission_policy: { type: 'always_allow' } }],
      },
    ]);

    expect(resolveToolsRequiringEvaluation(agent, ['bash', 'read'])).toEqual(['bash']);
  });

  it('never evaluates a never_allow tool — it is excluded upstream instead', () => {
    const agent = agentWithTools([
      {
        type: 'agent_toolset_20260401',
        default_config: { permission_policy: { type: 'auto' } },
        configs: [{ name: 'bash', permission_policy: { type: 'never_allow' } }],
      },
    ]);

    expect(getToolPermission(agent, 'bash')).toBe('never_allow');
    expect(resolveToolsRequiringEvaluation(agent, ['bash', 'read'])).toEqual(['read']);
  });

  it('excludes caller-executed custom tools from evaluation', () => {
    const agent = agentWithTools([
      { type: 'agent_toolset_20260401', default_config: { permission_policy: { type: 'auto' } } },
      { type: 'custom', name: 'my_tool', description: 'caller runs this', input_schema: { type: 'object' } },
    ] as never);

    expect(resolveToolsRequiringEvaluation(agent, ['my_tool', 'bash'])).toEqual(['bash']);
  });
});

describe('MCP tool discovery admission', () => {
  const mcpAgent = (toolset: Record<string, unknown>) => agentWithTools([toolset] as never);

  it('admits a tool the server exposes but the agent never named', () => {
    // A server's real tool list is only known after tools/list, so an unnamed
    // tool is normal rather than suspicious. It is still governed by the
    // toolset default, which is why admission alone cannot mean "ungated".
    const agent = mcpAgent({ type: 'mcp_toolset', mcp_server_name: 'filesystem' });

    expect(mcpDiscoveredToolAdmitted(agent, 'filesystem', 'read_file')).toBe(true);
    expect(mcpDiscoveredToolAdmitted(agent, 'filesystem', 'some_tool_added_later')).toBe(true);
  });

  it('admits a discovered tool only if its owning toolset is still enabled', () => {
    const agent = mcpAgent({
      type: 'mcp_toolset',
      mcp_server_name: 'filesystem',
      default_config: { enabled: false },
    });

    expect(mcpDiscoveredToolAdmitted(agent, 'filesystem', 'read_file')).toBe(false);
  });

  it('refuses a tool whose own config disables it', () => {
    const agent = mcpAgent({
      type: 'mcp_toolset',
      mcp_server_name: 'filesystem',
      configs: [{ name: 'write_file', enabled: false }],
    });

    expect(mcpDiscoveredToolAdmitted(agent, 'filesystem', 'write_file')).toBe(false);
    expect(mcpDiscoveredToolAdmitted(agent, 'filesystem', 'read_file')).toBe(true);
  });

  it('refuses a tool the operator marked never_allow instead of merely gating it', () => {
    // `never_allow` is a prohibition, not an approval prompt. Shipping the tool
    // and relying on the confirmation layer would invite the model to call it.
    const agent = mcpAgent({
      type: 'mcp_toolset',
      mcp_server_name: 'filesystem',
      configs: [{ name: 'delete_file', permission_policy: { type: 'never_allow' } }],
    });

    expect(mcpDiscoveredToolAdmitted(agent, 'filesystem', 'delete_file')).toBe(false);
  });

  it('refuses every tool of a server the agent declared no toolset for', () => {
    // The server being listed in mcp_servers is not an opt-in to its tools.
    const agent = mcpAgent({ type: 'mcp_toolset', mcp_server_name: 'other' });

    expect(mcpDiscoveredToolAdmitted(agent, 'filesystem', 'read_file')).toBe(false);
  });

  it('keeps an explicitly always_allow tool admitted under an always_ask toolset', () => {
    const agent = mcpAgent({
      type: 'mcp_toolset',
      mcp_server_name: 'filesystem',
      configs: [{ name: 'read_file', permission_policy: { type: 'always_allow' } }],
    });

    expect(mcpDiscoveredToolAdmitted(agent, 'filesystem', 'read_file')).toBe(true);
    expect(getToolPermission(agent, 'mcp_filesystem_read_file')).toBe('always_allow');
  });

  it('still gates an admitted but unconfigured tool, so discovery is not approval', () => {
    const agent = mcpAgent({ type: 'mcp_toolset', mcp_server_name: 'filesystem' });

    expect(mcpDiscoveredToolAdmitted(agent, 'filesystem', 'read_file')).toBe(true);
    expect(getToolPermission(agent, 'mcp_filesystem_read_file')).toBe('always_ask');
  });

  it('refuses a discovered tool when the toolset default denies the whole server', () => {
    // A toolset-wide prohibition covers tools the server adds later. Checking
    // only `enabled` here would ship a tool the operator forbade.
    const agent = mcpAgent({
      type: 'mcp_toolset',
      mcp_server_name: 'filesystem',
      default_config: { permission_policy: { type: 'never_allow' } },
    });

    expect(mcpDiscoveredToolAdmitted(agent, 'filesystem', 'read_file')).toBe(false);
    expect(mcpDiscoveredToolAdmitted(agent, 'filesystem', 'added_later')).toBe(false);
  });

  it('resolves the owning toolset of a namespaced tool when several servers are declared', () => {
    // The runtime name is `mcp_<server>_<tool>`. Resolving it against a
    // double-underscore prefix — the shape an earlier local list assumed —
    // matched nothing, so every discovered tool fell through to `always_allow`
    // as soon as a second server made the single-server fallback unavailable.
    const agent = agentWithTools([
      { type: 'mcp_toolset', mcp_server_name: 'issue_tracker' },
      { type: 'mcp_toolset', mcp_server_name: 'logs', default_config: { permission_policy: { type: 'always_allow' } } },
    ] as never);

    expect(getToolPermission(agent, 'mcp_issue_tracker_delete_issue')).toBe('always_ask');
    expect(getToolPermission(agent, 'mcp_logs_read_entries')).toBe('always_allow');
  });

  it('prefers the longest server-name match so a similar name cannot claim a tool', () => {
    // `fs` is a prefix of `fs_extra`; a tool of `fs_extra` must not inherit the
    // policy of `fs`.
    const agent = agentWithTools([
      { type: 'mcp_toolset', mcp_server_name: 'fs' },
      { type: 'mcp_toolset', mcp_server_name: 'fs_extra', default_config: { permission_policy: { type: 'always_allow' } } },
    ] as never);

    expect(getToolPermission(agent, 'mcp_fs_extra_write')).toBe('always_allow');
    expect(getToolPermission(agent, 'mcp_fs_read')).toBe('always_ask');
  });
});
