// @vitest-environment jsdom
/**
 * `user.steer` in the session composer.
 *
 * A steer is not a message: while a turn is in flight the composer offers a
 * steer mode that posts `user.steer` — `input_id` idempotency key plus text —
 * through `/v1/sessions/{id}/events`, and the returned receipt decides the
 * outcome shown to the operator rather than the request being assumed
 * delivered.
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

function makeSession(status: Session['status']): Session {
  return {
    id: 'sess_1',
    type: 'session',
    title: null,
    agent: { id: 'agent_echo', type: 'agent', name: 'Echo agent', version: 1, multiagent: null },
    environment_id: 'env_local',
    status,
    resources: [],
    vault_ids: [],
    budget: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    stats: { active_seconds: 0, duration_seconds: 0 },
    outcome_evaluations: [],
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

function renderDetail(session: Session, steerReceipt: unknown = { accepted: true, steer: { input_id: 'in_1', state: 'delivered', turn_id: 'turn_1' } }) {
  onApiRequest((request) => {
    if (request.path.endsWith('/events?limit=1000')) return { data: [], next_page: null };
    if (request.path.endsWith('/events')) return steerReceipt;
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

describe('the session composer steer mode', () => {
  beforeEach(() => {
    resetApi();
    Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
    window.requestAnimationFrame = window.requestAnimationFrame ?? ((callback) => setTimeout(callback, 0) as unknown as number);
  });

  afterEach(() => {
    resetApi();
  });

  it('posts user.steer with an input_id and the drafted text while a turn is running', async () => {
    const user = userEvent.setup();
    renderDetail(makeSession('running'));

    await user.click(screen.getByRole('button', { name: /^steer$/i }));
    await user.type(screen.getByPlaceholderText(/steer the running turn/i), 'Focus on the README first');
    await user.click(screen.getByRole('button', { name: /^send steer$/i }));

    const submit = await waitFor(() => {
      const request = apiRequests().find(
        (item) => item.method === 'POST' && item.path.endsWith('/events'),
      );
      expect(request).toBeDefined();
      return request;
    });
    const body = submit?.body as { events: Array<Record<string, unknown>> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0].type).toBe('user.steer');
    expect(body.events[0].text).toBe('Focus on the README first');
    expect(typeof body.events[0].input_id).toBe('string');
    expect((body.events[0].input_id as string).length).toBeGreaterThan(0);
  });

  it('clears the draft when the receipt reports delivered', async () => {
    const user = userEvent.setup();
    renderDetail(makeSession('running'));

    await user.click(screen.getByRole('button', { name: /^steer$/i }));
    const textarea = screen.getByPlaceholderText(/steer the running turn/i);
    await user.type(textarea, 'Skip the tests');
    await user.click(screen.getByRole('button', { name: /^send steer$/i }));

    await waitFor(() => {
      expect(apiRequests().some((item) => item.method === 'POST' && item.path.endsWith('/events'))).toBe(true);
    });
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe(''));
  });

  it('keeps the draft and surfaces the detail when the receipt reports outcome_unknown', async () => {
    const user = userEvent.setup();
    renderDetail(makeSession('running'), {
      accepted: false,
      steer: { input_id: 'in_1', state: 'outcome_unknown', detail: 'delivery timed out — do not resend' },
    });

    await user.click(screen.getByRole('button', { name: /^steer$/i }));
    const textarea = screen.getByPlaceholderText(/steer the running turn/i);
    await user.type(textarea, 'Skip the tests');
    await user.click(screen.getByRole('button', { name: /^send steer$/i }));

    await waitFor(() => expect(screen.getByText(/delivery timed out/i)).toBeDefined());
    expect((textarea as HTMLTextAreaElement).value).toBe('Skip the tests');
  });

  it('offers no steer affordance while the session is idle', async () => {
    renderDetail(makeSession('idle'));

    await waitFor(() => expect(screen.getByPlaceholderText(/message this session/i)).toBeDefined());
    expect(screen.queryByRole('button', { name: /^steer$/i })).toBeNull();
  });
});
