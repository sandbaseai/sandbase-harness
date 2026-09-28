import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentEditModal, AgentModal } from '../../apps/console/src/components/modals/AgentModals';
import { sendsModelConfig } from '../../apps/console/src/lib/agentModelConfig';
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
    expect(html).toContain('Agent config');
    expect(html).toContain('Starter agent');
    expect(html).toContain('<option value="yaml"');
    expect(html).toContain('<option value="json"');
    expect(html).toContain('class="yamlKey"');
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
