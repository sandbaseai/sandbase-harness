// @vitest-environment jsdom
/**
 * `user.define_outcome` on the session page (WP5 F5).
 *
 * The published outcome flow is a session event, not a resource: the session
 * page's Actions menu opens a form posting `user.define_outcome` with the
 * description, a text or file rubric, and an optional `max_iterations`, and
 * the session's `outcome_evaluations` render above the conversation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiRequests,
  onApiRequest,
  renderConsole,
  resetApi,
  screen,
  userEvent,
  waitFor,
} from './support/render';
import { SessionDetail } from '../../../apps/console/src/components/pages/SessionPages';
import type { ConsoleData, Session } from '../../../apps/console/src/types';

const now = '2026-10-05T12:00:00.000Z';

function makeSession(evaluations: Session['outcome_evaluations'] = []): Session {
  return {
    id: 'sess_1',
    type: 'session',
    title: null,
    agent: { id: 'agent_echo', type: 'agent', name: 'Echo agent', version: 1, multiagent: null },
    environment_id: 'env_local',
    status: 'idle',
    resources: [],
    vault_ids: [],
    budget: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    stats: { active_seconds: 0, duration_seconds: 0 },
    outcome_evaluations: evaluations,
    metadata: {},
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
}

const data = {
  agents: [{
    id: 'agent_echo',
    type: 'agent',
    name: 'Echo agent',
    description: '',
    system: '',
    model: 'local-echo',
    tools: [],
    skills: [],
    mcp_servers: [],
    metadata: {},
    status: 'active',
    version: 1,
    created_at: now,
    updated_at: now,
    archived_at: null,
  }],
  sessions: [],
  environments: [{
    id: 'env_local',
    type: 'environment',
    name: 'Local',
    description: '',
    hosting_type: 'local',
    sandbox_provider: 'local',
    network: {},
    packages: [],
    status: 'active',
    config: {},
    metadata: {},
    created_at: now,
    updated_at: now,
    archived_at: null,
  }],
  vaults: [],
  memoryStores: [],
  files: [],
  apiKeys: [],
  skills: [],
  templates: [],
  runtime: null,
  workspace: null,
  settings: null,
} as unknown as ConsoleData;

function renderDetail(session: Session) {
  onApiRequest((request) => {
    if (request.path.endsWith('/events?limit=1000')) return { data: [], next_page: null };
    if (request.path.endsWith('/events')) return { ok: true };
    return {};
  });
  return renderConsole(
    <SessionDetail
      session={session}
      data={data}
      onBack={() => {}}
      onRefresh={() => {}}
      onOpenAgent={() => {}}
      onNewSession={() => {}}
    />,
  );
}

describe('the session page outcome flow', () => {
  beforeEach(() => {
    resetApi();
    Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
    window.requestAnimationFrame = window.requestAnimationFrame ?? ((callback) => setTimeout(callback, 0) as unknown as number);
  });

  afterEach(() => {
    resetApi();
  });

  it('posts user.define_outcome with the published field shape', async () => {
    const user = userEvent.setup();
    renderDetail(makeSession());

    await user.click(screen.getByRole('button', { name: /^actions$/i }));
    await user.click(screen.getByRole('button', { name: /define outcome/i }));

    await user.type(screen.getByPlaceholderText(/successful session/i), 'Summarize the repo');
    await user.type(screen.getByPlaceholderText(/criteria the grader/i), 'A README summary under 200 words');
    await user.type(screen.getByPlaceholderText('3'), '5');
    await user.click(screen.getByRole('button', { name: /^define outcome$/i }));

    const submit = await waitFor(() => {
      const request = apiRequests().find(
        (item) => item.method === 'POST' && item.path.endsWith('/events'),
      );
      expect(request).toBeDefined();
      return request;
    });
    expect(submit?.body).toEqual({
      events: [{
        type: 'user.define_outcome',
        description: 'Summarize the repo',
        rubric: { type: 'text', content: 'A README summary under 200 words' },
        max_iterations: 5,
      }],
    });
  });

  it('requires a rubric — the published field is not optional', async () => {
    const user = userEvent.setup();
    renderDetail(makeSession());

    await user.click(screen.getByRole('button', { name: /^actions$/i }));
    await user.click(screen.getByRole('button', { name: /define outcome/i }));

    await user.type(screen.getByPlaceholderText(/successful session/i), 'Summarize the repo');
    await user.click(screen.getByRole('button', { name: /^define outcome$/i }));

    await waitFor(() => expect(screen.getByText(/rubric text is required/i)).toBeDefined());
    expect(apiRequests().some((item) => item.method === 'POST' && item.path.endsWith('/events'))).toBe(false);
  });

  it('renders outcome_evaluations with verdict, iteration, and explanation', async () => {
    renderDetail(makeSession([{
      type: 'outcome_evaluation',
      outcome_id: 'out_1',
      description: 'Summarize the repo',
      result: 'satisfied',
      iteration: 2,
      explanation: 'The summary met the word limit.',
      completed_at: now,
    }]));

    await waitFor(() => expect(screen.getByText('Summarize the repo')).toBeDefined());
    expect(screen.getByText('satisfied')).toBeDefined();
    expect(screen.getByText('iteration 2')).toBeDefined();
    expect(screen.getByText('The summary met the word limit.')).toBeDefined();
  });
});
