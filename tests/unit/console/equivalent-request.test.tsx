import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { equivalentSnippet, type EquivalentRequest } from '../../../apps/console/src/lib/equivalentRequest';
import { EquivalentRequestPanel } from '../../../apps/console/src/components/EquivalentRequestPanel';

const base = 'http://127.0.0.1:8787';

const createSession: EquivalentRequest = {
  method: 'POST',
  path: '/v1/sessions',
  body: {
    agent: 'agent_demo',
    environment_id: 'env_local',
    title: 'Nightly review',
    resources: [{ type: 'file', file_id: 'file_1', mount_path: '/work/doc.md', readonly: true }],
    vault_ids: [],
  },
};

describe('equivalent request snippets', () => {
  it('renders cURL with the runtime base url and the env-var credential', () => {
    const out = equivalentSnippet(createSession, base, 'curl');
    expect(out).toContain(`curl -sS -X POST '${base}/v1/sessions'`);
    expect(out).toContain('x-api-key: $ANTHROPIC_API_KEY');
    expect(out).toContain('"agent":"agent_demo"');
    // No real key ever lands in a snippet — only the variable name.
    expect(out).not.toContain('conformance-stub-key');
  });

  it('renders TypeScript through the published SDK resource method', () => {
    const out = equivalentSnippet(createSession, base, 'typescript');
    expect(out).toContain(`baseURL: '${base}'`);
    expect(out).toContain('apiKey: process.env.ANTHROPIC_API_KEY');
    expect(out).toContain('client.beta.sessions.create(');
    expect(out).toContain('"agent": "agent_demo"');
  });

  it('maps the agent create call to client.beta.agents.create', () => {
    const out = equivalentSnippet({ method: 'POST', path: '/v1/agents', body: { name: 'a', model: 'm' } }, base, 'typescript');
    expect(out).toContain('client.beta.agents.create(');
    expect(out).toContain('console.log(agent.id)');
  });

  it('falls back to fetch for endpoints without an SDK method', () => {
    const out = equivalentSnippet({ method: 'DELETE', path: '/v1/sessions/sess_1' }, base, 'typescript');
    expect(out).toContain(`fetch('${base}/v1/sessions/sess_1'`);
    expect(out).toContain(`method: 'DELETE'`);
  });

  it('renders Python literals, not JSON booleans', () => {
    const out = equivalentSnippet(createSession, base, 'python');
    expect(out).toContain('requests.post(');
    expect(out).toContain(`"${base}/v1/sessions"`);
    expect(out).toContain('os.environ["ANTHROPIC_API_KEY"]');
    expect(out).toContain('True'); // readonly: true → True
    expect(out).not.toContain('"readonly": true');
  });

  it('GET without a body omits the payload argument in every language', () => {
    const list: EquivalentRequest = { method: 'GET', path: '/v1/sessions' };
    expect(equivalentSnippet(list, base, 'curl')).not.toContain("-d '");
    expect(equivalentSnippet(list, base, 'python')).not.toContain('json=');
  });
});

describe('EquivalentRequestPanel', () => {
  it('renders the three language tabs and the snippet', () => {
    const html = renderToStaticMarkup(<EquivalentRequestPanel request={createSession} />);
    expect(html).toContain('cURL');
    expect(html).toContain('TypeScript');
    expect(html).toContain('Python');
    expect(html).toContain('client.beta.sessions.create'); // typescript tab is the default
  });

  it('renders a parse-error hint instead of a snippet when no request is available', () => {
    const html = renderToStaticMarkup(<EquivalentRequestPanel request={null} />);
    expect(html).toContain('Fix the config errors');
    expect(html).not.toContain('<pre');
  });
});
