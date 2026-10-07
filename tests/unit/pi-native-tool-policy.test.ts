/**
 * The Pi native tool policy compiler.
 *
 * `docs/pi-loop-engine.md` says a Pi session's declared tool policy is expressed
 * in Pi's own vocabulary, because Pi's native tools are not Harness tools. That
 * claim is only worth anything if the compiled flags are exactly what the child
 * receives, so these tests pin the mapping (allow, deny, no tools), the
 * fail-closed refusals, and the one place the runtime refuses to launch without
 * a policy at all.
 *
 * The flag meanings asserted here are Pi 0.84.4's own, read from its `--help`:
 * `--tools` is a comma-separated allowlist, `--exclude-tools` a denylist, and
 * `--no-builtin-tools` disables the built-in tools while leaving extension and
 * custom tools enabled.
 */

import { describe, it, expect } from 'vitest';
import { compilePiNativeToolPolicy, PiToolPolicyUnsupportedError } from '@/core/session/pi-native-tools.js';
import { assertPiAgentCanExecute } from '@/core/session/pi-policy.js';
import { PI_TOOL_ARGS_WHEN_UNSTATED, piToolArgsFor } from '@/strategy/pi-launcher.js';
import { PI_NATIVE_TOOLS, isPiNativeTool } from '@/strategy/pi/native-tools.js';
import type { AgentDefinition } from '@/types/agent.js';

function agentWithTools(tools: unknown[]): AgentDefinition {
  return { name: 'pi-agent', model: 'gpt-4o', system: 'x', tools } as AgentDefinition;
}

describe('Pi native tool vocabulary', () => {
  it('is the set Pi 0.84.4 ships, and nothing else', () => {
    expect(PI_NATIVE_TOOLS).toEqual(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'powershell']);
    expect(isPiNativeTool('read')).toBe(true);
    // A Harness tool Pi does not have must not be mistaken for a native one.
    expect(isPiNativeTool('web_fetch')).toBe(false);
  });
});

describe('compilePiNativeToolPolicy', () => {
  it('allows the Pi-native share of the enabled tools and claims no exclusion it did not send', () => {
    // Including the toolset enables every built-in; `configs` only reconfigure
    // or disable. Of the published set, Pi has native names for bash, edit,
    // read, write and grep — glob, web_fetch and web_search are engine-coverage
    // gaps that simply never reach the model.
    const plan = compilePiNativeToolPolicy(agentWithTools([
      { type: 'agent_toolset_20260401', configs: [{ name: 'read' }, { name: 'grep' }] },
    ]));

    expect(plan.allow).toEqual(['bash', 'edit', 'read', 'write', 'grep']);
    expect(plan.argv).toEqual(['--tools', 'bash,edit,read,write,grep']);
    // A tool the definition never mentions is enforced by `--tools` being an
    // allowlist, so naming it in `--exclude-tools` would misdescribe the argv.
    expect(plan.denied).toEqual([]);
    expect(plan.exposeNoTools).toBe(false);
  });

  it('moves a denied or disabled tool out of the allowlist and into --exclude-tools', () => {
    const plan = compilePiNativeToolPolicy(agentWithTools([
      {
        type: 'agent_toolset_20260401',
        configs: [
          { name: 'read' },
          { name: 'bash', permission_policy: { type: 'never_allow' } },
          { name: 'write', enabled: false },
        ],
      },
    ]));

    expect(plan.allow).toEqual(['edit', 'read', 'grep']);
    expect(plan.denied).toEqual(['bash', 'write']);
    expect(plan.argv).toEqual(['--tools', 'edit,read,grep', '--exclude-tools', 'bash,write']);
  });

  it('honours a toolset-level default, not only per-tool entries', () => {
    const plan = compilePiNativeToolPolicy(agentWithTools([
      {
        type: 'agent_toolset_20260401',
        default_config: { enabled: false },
        configs: [{ name: 'read', enabled: true }],
      },
    ]));

    // `default_config.enabled: false` empties the implicit set, so `write`
    // and `bash` stay off: the allowlist is what the agent's effective policy
    // says, not a default set.
    expect(plan.allow).toEqual(['read']);
    expect(plan.argv).toEqual(['--tools', 'read']);
  });

  it('asks Pi for no built-in tools at all when the policy enables none', () => {
    const plan = compilePiNativeToolPolicy(agentWithTools([
      { type: 'agent_toolset_20260401', default_config: { enabled: false } },
    ]));

    expect(plan.exposeNoTools).toBe(true);
    expect(plan.allow).toEqual([]);
    expect(plan.argv).toEqual(['--no-builtin-tools']);
  });

  it('refuses a declared tool Pi cannot run, but not an implicit one', () => {
    // `glob` is enabled implicitly by the bare toolset and Pi has no glob —
    // an engine-coverage gap, tolerated because the allowlist never offers it.
    const implicit = compilePiNativeToolPolicy(agentWithTools([
      { type: 'agent_toolset_20260401' },
    ]));
    expect(implicit.allow).toEqual(['bash', 'edit', 'read', 'write', 'grep']);

    // The same tool named in `configs` is declared policy: dropping it would
    // lie about what the agent may do, so it refuses instead.
    const declared = agentWithTools([
      { type: 'agent_toolset_20260401', configs: [{ name: 'glob' }] },
    ]);
    expect(() => compilePiNativeToolPolicy(declared)).toThrow(/glob/);
  });
});

describe('fail-closed refusals', () => {
  it('refuses a tool Pi 0.84.4 does not have instead of dropping it', () => {
    const definition = agentWithTools([
      { type: 'agent_toolset_20260401', configs: [{ name: 'web_fetch' }] },
    ]);

    expect(() => compilePiNativeToolPolicy(definition)).toThrow(PiToolPolicyUnsupportedError);
    // The message names the declaration: "this agent cannot run on Pi" is only
    // actionable once the operator knows which entry caused it.
    expect(() => compilePiNativeToolPolicy(definition)).toThrow(/web_fetch/);
  });

  it('refuses an MCP toolset the agent could actually use', () => {
    expect(() => compilePiNativeToolPolicy(agentWithTools([
      { type: 'mcp_toolset', mcp_server_name: 'filesystem' },
    ]))).toThrow(/no MCP transport/);
  });

  it('accepts a fully disabled MCP toolset, because nothing is expected to run through it', () => {
    const plan = compilePiNativeToolPolicy(agentWithTools([
      { type: 'mcp_toolset', mcp_server_name: 'filesystem', default_config: { enabled: false } },
      { type: 'agent_toolset_20260401', configs: [{ name: 'read' }] },
    ]));

    expect(plan.allow).toEqual(['bash', 'edit', 'read', 'write', 'grep']);
  });

  it('reports a gated tool as gated, and admits the agent that declares it', () => {
    const definition = agentWithTools([
      {
        type: 'agent_toolset_20260401',
        configs: [{ name: 'read' }, { name: 'bash', permission_policy: { type: 'always_ask' } }],
      },
    ]);

    // Admission used to refuse this agent with `pi_always_ask_not_supported`,
    // because a launch without a gate would have run the tool with nobody asked.
    // The gate is what replaces that refusal: the plan names the tool the launch
    // must load the gate extension for, and the agent runs.
    const plan = assertPiAgentCanExecute(definition);
    expect(plan.gate).toEqual(['bash']);
    // Gated is not denied: `bash` stays in the allowlist and is decided per call,
    // so it must not appear in `--exclude-tools` either.
    expect(plan.allow).toEqual(['bash', 'edit', 'read', 'write', 'grep']);
    expect(plan.argv).toEqual(['--tools', 'bash,edit,read,write,grep']);
  });

  it('refuses a tool declared auto — Pi has no per-call model judgement to apply', () => {
    // The gate decides a call by blocking for a person; `auto` asks for a
    // model evaluation the extension cannot run. Compiling it as allowed or
    // gated would both silently change the declared policy, so admission
    // refuses with the same code a tool Pi lacks carries.
    const definition = agentWithTools([
      {
        type: 'agent_toolset_20260401',
        configs: [{ name: 'bash', permission_policy: { type: 'auto' } }],
      },
    ]);

    expect(() => compilePiNativeToolPolicy(definition)).toThrow(PiToolPolicyUnsupportedError);
    expect(() => assertPiAgentCanExecute(definition)).toThrow(/auto.*bash|bash.*auto/i);
  });

  it('refuses a toolset-wide auto default even when no tool names it explicitly', () => {
    const definition = agentWithTools([
      {
        type: 'agent_toolset_20260401',
        default_config: { permission_policy: { type: 'auto' } },
      },
    ]);

    expect(() => assertPiAgentCanExecute(definition)).toThrow(PiToolPolicyUnsupportedError);
  });

  it('returns the plan from admission for an agent that needs no gate', () => {
    const plan = assertPiAgentCanExecute(agentWithTools([
      { type: 'agent_toolset_20260401', configs: [{ name: 'grep' }] },
    ]));

    expect(plan.argv).toEqual(['--tools', 'bash,edit,read,write,grep']);
  });
});

describe('the tool policy one launch uses', () => {
  it('uses the compiled plan when the request states one', () => {
    expect(piToolArgsFor({ toolArgs: ['--tools', 'read'] })).toEqual(['--tools', 'read']);
  });

  it('exposes no built-in tool when the request states no policy at all', () => {
    // Omitted is not "unrestricted": it is the strict end of Pi's own surface, so
    // a launch that cannot state its policy cannot widen the agent's.
    expect(piToolArgsFor({})).toEqual(PI_TOOL_ARGS_WHEN_UNSTATED);
    expect(PI_TOOL_ARGS_WHEN_UNSTATED).toEqual(['--no-builtin-tools']);
  });

  it('enforces a denied or disabled tool by exclusion instead of refusing the agent', () => {
    const definition = agentWithTools([
      {
        type: 'agent_toolset_20260401',
        configs: [
          { name: 'read' },
          { name: 'bash', permission_policy: { type: 'never_allow' } },
          { name: 'write', enabled: false },
        ],
      },
    ]);

    // The plan is what the launch sends, so the same tools admission compiled are
    // the ones the child is told about.
    expect(compilePiNativeToolPolicy(definition).denied).toEqual(['bash', 'write']);
    expect(assertPiAgentCanExecute(definition).argv)
      .toEqual(['--tools', 'edit,read,grep', '--exclude-tools', 'bash,write']);
  });
});
