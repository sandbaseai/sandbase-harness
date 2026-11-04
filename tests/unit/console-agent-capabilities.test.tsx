import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentDetail, CapabilityStatus } from '../../apps/console/src/components/pages/AgentPages.js';
import { selectEnabledCapabilities, type RuntimeCapability } from '../../apps/console/src/useRuntimeCapabilities.js';
import type { Agent, ConsoleData } from '../../apps/console/src/types.js';
import { consoleDataFixture } from '../fixtures/console-data.js';

function agentFixture(): Agent {
  return {
    id: 'agent_test',
    type: 'agent',
    name: 'Reviewer',
    description: 'Reviews pull requests',
    system: 'Review things.',
    model: 'gpt-5',
    tools: [
      {
        type: 'agent_toolset_20260401',
        configs: {
          read: { enabled: true },
          web_search: { enabled: true },
        },
      },
    ],
    skills: [],
    mcp_servers: [],
    metadata: {},
    status: 'active',
    version: 2,
    multiagent: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    archived_at: null,
  };
}

function consoleData(agent: Agent): ConsoleData {
  return consoleDataFixture({
    agents: [agent],
    runtime: {
      status: 'running', agents_loaded: 1, skills_loaded: 0, models: [],
      sandbox_providers: ['local'], memory: 'sqlite', memory_providers: [], storage_providers: [], auth_enabled: false,
    },
  });
}

describe('agent capability rows', () => {
  it('does not render the hard-coded permission copy', () => {
    const agent = agentFixture();
    const html = renderToString(
      React.createElement(AgentDetail, {
        agent,
        data: consoleData(agent),
        tab: 'agent',
        onTab: () => {},
        onBack: () => {},
        onEdit: () => {},
        onNewSession: () => {},
        onOpenSession: () => {},
        onRefresh: () => {},
      }),
    );

    expect(html).toContain('MCPs and tools');
    // The registry decides the status row now: the old row presented the schema
    // default as the only fact about the built-in tools, which is exactly the
    // copy the gap document calls out. The permission badge still renders the
    // policy the runtime would apply, so "Always allow" may legitimately remain.
    expect(html).not.toContain('Tool permissions');
  });

  it('renders a registry entry as available or unavailable with its reason', () => {
    const available: RuntimeCapability = { id: 'read', kind: 'tool', status: 'available' };
    const unavailable: RuntimeCapability = {
      id: 'web_search',
      kind: 'tool',
      status: 'unavailable',
      reason: 'No search provider is bundled.',
    };

    const availableHtml = renderToString(React.createElement(CapabilityStatus, { capability: available }));
    expect(availableHtml).toContain('status-dot-ok');
    expect(availableHtml).toContain('Available');

    const unavailableHtml = renderToString(React.createElement(CapabilityStatus, { capability: unavailable }));
    expect(unavailableHtml).toContain('status-dot-neutral');
    expect(unavailableHtml).toContain('Unavailable');
    expect(unavailableHtml).toContain('No search provider is bundled.');
  });
});

describe('selectEnabledCapabilities', () => {
  const registry: RuntimeCapability[] = [
    { id: 'read', kind: 'tool', status: 'available' },
    { id: 'bash', kind: 'tool', status: 'available' },
    { id: 'web_search', kind: 'tool', status: 'unavailable', reason: 'No search provider is bundled.' },
  ];

  it('keeps only the capabilities the agent enables, in registry order', () => {
    const selected = selectEnabledCapabilities(registry, new Set(['bash', 'read']));
    expect(selected.map((capability) => capability.id)).toEqual(['read', 'bash']);
  });

  it('carries the registry status and reason through unmodified', () => {
    const selected = selectEnabledCapabilities(registry, new Set(['web_search']));
    expect(selected).toEqual([
      { id: 'web_search', kind: 'tool', status: 'unavailable', reason: 'No search provider is bundled.' },
    ]);
  });

  it('renders nothing for an agent that enables no registry tool', () => {
    expect(selectEnabledCapabilities(registry, new Set())).toEqual([]);
  });
});
