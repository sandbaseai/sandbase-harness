import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentEditModal } from '../../apps/console/src/components/modals/AgentModals.js';
import { AgentVersionsPanel } from '../../apps/console/src/components/pages/AgentPages.js';
import { diffAgentVersions, validateAgentDraft } from '../../apps/console/src/lib/agentVersionDiff.js';
import type { Agent } from '../../apps/console/src/types.js';

function agentFixture(version: number, overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent_test',
    type: 'agent',
    name: 'Reviewer',
    description: 'Reviews pull requests',
    system: 'Base prompt',
    model: 'gpt-5',
    tools: [],
    skills: [],
    mcp_servers: [],
    metadata: {},
    status: 'active',
    version,
    multiagent: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    archived_at: null,
    ...overrides,
  };
}

describe('diffAgentVersions', () => {
  it('marks changed, added, removed, and unchanged fields', () => {
    const base = agentFixture(1, {
      system: 'Old prompt',
      tools: [{ type: 'agent_toolset_20260401', configs: { bash: { enabled: true } } }],
      skills: [{ type: 'custom', skill_id: 'triage' }],
    });
    const next = agentFixture(2, {
      system: 'New prompt',
      tools: [{ type: 'agent_toolset_20260401', configs: { bash: { enabled: true }, web_search: { enabled: true } } }],
      skills: [],
    });

    const diffs = diffAgentVersions(base, next);
    const byField = new Map(diffs.map((diff) => [diff.field, diff]));

    expect(byField.get('system')).toMatchObject({ kind: 'changed', base: 'Old prompt', next: 'New prompt' });
    expect(byField.get('tools')?.kind).toBe('changed');
    expect(byField.get('tools')?.next).toContain('web_search');
    expect(byField.get('skills')).toMatchObject({ kind: 'removed', next: '' });
    expect(byField.get('name')?.kind).toBe('unchanged');
    expect(byField.get('model')?.kind).toBe('unchanged');
  });

  it('reports model_config.speed as standard when unset', () => {
    const base = agentFixture(1);
    const next = agentFixture(2, { model_config: { speed: 'extended' } });
    const diffs = diffAgentVersions(base, next);
    expect(diffs.find((diff) => diff.field === 'model_config')).toMatchObject({ kind: 'changed', base: 'standard', next: 'extended' });
  });
});

describe('validateAgentDraft', () => {
  it('flags missing required fields on an empty draft', () => {
    const issues = validateAgentDraft({});
    expect(issues).toEqual(expect.arrayContaining([
      'name is required.',
      'model is required.',
      'system prompt is required.',
    ]));
  });

  it('accepts a minimal valid draft', () => {
    expect(validateAgentDraft({ name: 'A', model: 'gpt-5', system: 'Do the thing.' })).toEqual([]);
  });

  it('checks toolset and skill shapes', () => {
    const issues = validateAgentDraft({
      name: 'A',
      model: 'gpt-5',
      system: 'prompt',
      tools: [{ type: 'mcp_toolset' }, { type: 'nonsense' }],
      skills: [{}],
      metadata: { team: 42 },
    });
    expect(issues.some((issue) => issue.includes('mcp_server_name'))).toBe(true);
    expect(issues.some((issue) => issue.includes('tools[1]'))).toBe(true);
    expect(issues.some((issue) => issue.includes('skills[0]'))).toBe(true);
    expect(issues.some((issue) => issue.includes('metadata.team'))).toBe(true);
  });

  it('rejects non-object input', () => {
    expect(validateAgentDraft('nope')).toEqual(['Agent config must be a mapping of fields.']);
  });
});

describe('AgentVersionsPanel', () => {
  it('renders a side-by-side diff between the selected versions', () => {
    const base = agentFixture(1, { system: 'Old prompt' });
    const next = agentFixture(2, { system: 'New prompt', tools: [{ type: 'agent_toolset_20260401' }] });
    const html = renderToString(
      React.createElement(AgentVersionsPanel, {
        agent: next,
        versions: [base, next],
        loading: false,
        error: '',
        onRestore: () => {},
        onTest: () => {},
      }),
    );

    expect(html).toContain('versionsPanel');
    expect(html).toContain('System prompt');
    expect(html).toContain('Old prompt');
    expect(html).toContain('New prompt');
    expect(html).toContain('diffBadge changed');
    expect(html).toContain('Restore as draft');
    expect(html).toContain('Test this agent');
  });

  it('marks the current version and disables restoring it', () => {
    const current = agentFixture(2, { system: 'Same' });
    const html = renderToString(
      React.createElement(AgentVersionsPanel, {
        agent: current,
        versions: [current],
        loading: false,
        error: '',
        onRestore: () => {},
        onTest: () => {},
      }),
    );
    expect(html).toContain('versionItem current');
    expect(html).toContain('disabled');
  });

  it('renders the error banner and empty state', () => {
    const html = renderToString(
      React.createElement(AgentVersionsPanel, {
        agent: agentFixture(1),
        versions: [],
        loading: false,
        error: 'request failed',
        onRestore: () => {},
        onTest: () => {},
      }),
    );
    expect(html).toContain('request failed');
    expect(html).not.toContain('diffTable');
  });
});

describe('AgentEditModal draft restore', () => {
  it('prefills from the restored version and says so', () => {
    const agent = agentFixture(3);
    const draft = agentFixture(1, { system: 'Legacy prompt' });
    const html = renderToString(
      React.createElement(AgentEditModal, { agent, initialDraft: draft, onClose: () => {}, onSaved: () => {} }),
    );
    expect(html).toContain('Draft restored from v1');
    expect(html).toContain('Legacy prompt');
    expect(html).toContain('Config preview');
    expect(html).toContain('All good');
  });

  it('shows validation issues and blocks an invalid draft', () => {
    const agent = agentFixture(3);
    const draft = agentFixture(1, { system: '' });
    const html = renderToString(
      React.createElement(AgentEditModal, { agent, initialDraft: draft, onClose: () => {}, onSaved: () => {} }),
    );
    expect(html).toContain('The agent needs instructions.');
    expect(html).toContain('disabled');
  });
});
