import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentEditModal, AgentModal, agentDefinitionObject } from '../../apps/console/src/components/modals/AgentModals';
import { sendsModelConfig } from '../../apps/console/src/lib/agentModelConfig';
import { validateAgentDraft } from '../../apps/console/src/lib/agentVersionDiff';
import type { Agent, ConsoleData, Template } from '../../apps/console/src/types';

const template: Template = {
  id: 'blank',
  name: 'Blank agent',
  description: 'Start from a minimal agent definition.',
  tags: ['starter'],
  agent: {
    name: 'Starter agent',
    description: 'A test agent template.',
    model: 'local-echo',
    system: 'You are a test agent.',
    mcp_servers: [],
    tools: [{ type: 'agent_toolset_20260401' }],
    skills: [],
    metadata: {},
  },
};

describe('Agent modals', () => {
  it('renders the create-agent composer without runtime icon errors', () => {
    const data = {
      templates: [template],
      runtime: { models: [{ name: 'local-echo' }] },
    } as ConsoleData;

    const html = renderToStaticMarkup(
      <AgentModal
        template={template}
        data={data}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(html).toContain('Create agent');
    expect(html).toContain('Config preview');
    expect(html).toContain('Starter agent');
    expect(html).toContain('>YAML<');
    expect(html).toContain('>JSON<');
    expect(html).toContain('configDrawerView');
  });

  // The edit form submits the YAML it shows (`PUT /v1/agents/{id}` with that
  // body), and that body replaces the stored profile. So an operator editing an
  // agent whose level was accepted must see the level in the form: hiding it
  // would save the agent back without the value the read had just returned.
  it('shows the stored effort in the edit form even at the default speed', () => {
    const agent = {
      id: 'agent_1',
      type: 'agent',
      name: 'Effort agent',
      description: '',
      system: 'You are a test agent.',
      model: 'gpt-4o',
      model_config: { id: 'gpt-4o', speed: 'standard', effort: 'high' },
      tools: [{ type: 'agent_toolset_20260401' }],
      skills: [],
      mcp_servers: [],
      metadata: {},
      status: 'active',
      version: 2,
      created_at: null,
      updated_at: null,
      archived_at: null,
    } as Agent;

    const html = renderToStaticMarkup(
      <AgentEditModal agent={agent} onClose={() => {}} onSaved={() => {}} />,
    );

    expect(html).toContain('effort: high');
    expect(html).toContain('model_config');
  });
});

describe('Console custom tool declarations', () => {
  it('emits canonical custom entries for each declared tool row', () => {
    const definition = agentDefinitionObject(
      { name: 'A', model: 'm', system: 's', tools: [{ type: 'agent_toolset_20260401' }] },
      [],
      [{ id: 'c1', name: 'lookup_ticket', description: 'Find a ticket', schemaText: '{"type":"object"}', rest: {} }],
      [],
    );

    expect(definition.tools).toEqual([
      { type: 'agent_toolset_20260401' },
      { type: 'custom', name: 'lookup_ticket', description: 'Find a ticket', input_schema: { type: 'object' } },
    ]);
  });

  it('keeps an unparseable schema visible so the draft validator blocks the save', () => {
    const definition = agentDefinitionObject(
      { name: 'A', model: 'm', system: 's' },
      [],
      [{ id: 'c1', name: 'broken', description: 'x', schemaText: '{not json', rest: {} }],
      [],
    );

    const issues = validateAgentDraft(definition);
    expect(issues.some((issue) => issue.includes('input_schema'))).toBe(true);
  });

  it('accepts the canonical and legacy custom tool shapes in pasted definitions', () => {
    expect(validateAgentDraft({
      name: 'A', model: 'm', system: 's',
      tools: [{ type: 'custom', name: 'lookup_ticket', description: 'Find a ticket', input_schema: { type: 'object' } }],
    })).toEqual([]);
    expect(validateAgentDraft({
      name: 'A', model: 'm', system: 's',
      tools: [{ type: 'custom_toolset', configs: [{ name: 'lookup_ticket', description: 'Find a ticket', parameters: { type: 'object' } }] }],
    })).toEqual([]);
    expect(validateAgentDraft({
      name: 'A', model: 'm', system: 's',
      tools: [{ type: 'custom', name: 'lookup_ticket' }],
    }).length).toBeGreaterThan(0);
  });

  it('prefills stored custom tools in the edit form', () => {
    const agent = {
      id: 'agent_1',
      type: 'agent',
      name: 'Custom tool agent',
      description: '',
      system: 'You are a test agent.',
      model: 'gpt-4o',
      tools: [
        { type: 'agent_toolset_20260401' },
        { type: 'custom', name: 'lookup_ticket', description: 'Find a ticket', input_schema: { type: 'object' } },
      ],
      skills: [],
      mcp_servers: [],
      metadata: {},
      status: 'active',
      version: 1,
      created_at: null,
      updated_at: null,
      archived_at: null,
    } as unknown as Agent;

    const html = renderToStaticMarkup(
      <AgentEditModal agent={agent} onClose={() => {}} onSaved={() => {}} />,
    );

    expect(html).toContain('lookup_ticket');
    expect(html).toContain('Find a ticket');
  });
});

describe('Console execution controls', () => {
  const base = { name: 'A', model: 'm', system: 's' };

  it('emits max_turns and the sub-agent flag only when the form carries them', () => {
    // Untouched fields stay out of the body so the partial update leaves the
    // stored values alone — that omission is the "keep stored" semantic.
    expect(agentDefinitionObject(base, [], [], [])).not.toHaveProperty('max_turns');
    expect(agentDefinitionObject(base, [], [], [])).not.toHaveProperty('enable_general_subagent');

    const definition = agentDefinitionObject({ ...base, max_turns: 25, enable_general_subagent: true }, [], [], []);
    expect(definition.max_turns).toBe(25);
    expect(definition.enable_general_subagent).toBe(true);
  });

  it('normalizes the typed turn-cap text and drops an emptied field', () => {
    expect(agentDefinitionObject({ ...base, max_turns: '30' }, [], [], []).max_turns).toBe(30);
    expect(agentDefinitionObject({ ...base, max_turns: '' }, [], [], [])).not.toHaveProperty('max_turns');
  });

  it('blocks out-of-range turn caps before the request leaves', () => {
    for (const value of [0, 1001, 2.5, NaN, '12a']) {
      const definition = agentDefinitionObject({ ...base, max_turns: value }, [], [], []);
      expect(validateAgentDraft(definition).some((issue) => issue.includes('max_turns'))).toBe(true);
    }
    expect(validateAgentDraft(agentDefinitionObject({ ...base, max_turns: 1000 }, [], [], []))).toEqual([]);
  });
});

describe('Console model profile save rule', () => {
  it('sends the profile exactly when the server would have returned one', () => {
    // The server's projection omits the ordinary case; the form must agree, or a
    // save would either drop a stored value or invent a profile that was absent.
    expect(sendsModelConfig(undefined)).toBe(false);
    expect(sendsModelConfig({ speed: 'standard' })).toBe(false);
    expect(sendsModelConfig({ speed: 'fast' })).toBe(true);
    expect(sendsModelConfig({ speed: 'extended', effort: 'max' })).toBe(true);
    expect(sendsModelConfig({ speed: 'standard', effort: 'high' })).toBe(true);
  });
});
