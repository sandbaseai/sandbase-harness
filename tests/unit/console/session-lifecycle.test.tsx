// @vitest-environment jsdom
/**
 * Session lifecycle interactions: archive and delete are separate actions
 * (#772 / WP1 1.13). Archive posts to the dedicated route; delete is a
 * two-step destructive action behind a confirmation that names what is
 * permanently removed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiRequests,
  onApiRequest,
  renderConsole,
  resetApi,
  screen,
  userEvent,
  waitFor,
} from './support/render';
import { SessionDetail, sessionDisplayStatus } from '../../../apps/console/src/components/pages/SessionPages';
import type { ConsoleData, Session } from '../../../apps/console/src/types';

const now = '2026-07-18T12:00:00.000Z';

const session: Session = {
  id: 'sess_abc',
  type: 'session',
  title: 'Investigate logs',
  agent: { id: 'agent_echo', type: 'agent', name: 'Echo agent', version: 1, multiagent: null },
  environment_id: 'env_local',
  status: 'idle',
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
} as Session;

const data = {
  agents: [{
    id: 'agent_echo',
    type: 'agent',
    name: 'Echo agent',
    description: '',
    system: 'Echo.',
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
  sessions: [session],
  environments: [],
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

function renderDetail() {
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

describe('SessionDetail lifecycle actions', () => {
  beforeEach(() => {
    resetApi();
    // jsdom has no scrollTo; the conversation list calls it on mount.
    Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
    onApiRequest(({ method, path }) => {
      if (method === 'GET' && path.includes('/events')) return { data: [], has_more: false };
      return { id: session.id };
    });
  });

  afterEach(() => {
    resetApi();
  });

  it('archives through the archive route, not a delete', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('button', { name: /actions/i }));
    await user.click(screen.getByRole('button', { name: /archive session/i }));

    await waitFor(() => {
      expect(apiRequests().some(
        (request) => request.method === 'POST' && request.path === '/v1/sessions/sess_abc/archive',
      )).toBe(true);
    });
    expect(apiRequests().some((request) => request.method === 'DELETE')).toBe(false);
  });

  it('deletes only after the confirmation names the permanent effect', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('button', { name: /actions/i }));
    await user.click(screen.getByRole('button', { name: /delete session/i }));

    // The confirm step warns before the destructive call goes out.
    expect(await screen.findByText(/permanently deletes/i)).toBeTruthy();
    expect(apiRequests().some((request) => request.method === 'DELETE')).toBe(false);

    const dialog = await screen.findByRole('dialog');
    await user.click(await screen.findByRole('button', { name: /^delete session$/i }));

    await waitFor(() => {
      expect(apiRequests().some(
        (request) => request.method === 'DELETE' && request.path === '/v1/sessions/sess_abc',
      )).toBe(true);
    });
    expect(dialog).toBeTruthy();
  });
});

describe('sessionDisplayStatus', () => {
  const idleEvent = (stop_reason?: { type: string; event_ids?: string[] }) => ({
    id: 'sevt_1',
    type: 'session.status_idle',
    content: null,
    stop_reason,
  });

  it('reads archived_at as its own axis over the lifecycle status', () => {
    expect(sessionDisplayStatus({ ...session, archived_at: now }, [])).toBe('archived');
    expect(sessionDisplayStatus({ ...session, status: 'terminated', archived_at: now }, [])).toBe('archived');
  });

  it('derives awaiting_action from the last status_idle stop_reason', () => {
    expect(sessionDisplayStatus(session, [idleEvent({ type: 'requires_action' }) as any])).toBe('awaiting_action');
    expect(sessionDisplayStatus(session, [idleEvent({ type: 'end_turn' }) as any])).toBe('idle');
    expect(sessionDisplayStatus(session, [idleEvent() as any])).toBe('idle');
  });

  it('passes running, rescheduling, and terminated through', () => {
    expect(sessionDisplayStatus({ ...session, status: 'running' }, [])).toBe('running');
    expect(sessionDisplayStatus({ ...session, status: 'rescheduling' }, [])).toBe('rescheduling');
    expect(sessionDisplayStatus({ ...session, status: 'terminated' }, [])).toBe('terminated');
    expect(sessionDisplayStatus(session, [])).toBe('idle');
  });

  it('reads a just-started turn as running while the snapshot still says idle', () => {
    const events = [{ id: 'sevt_9', type: 'session.status_running', content: null }];
    expect(sessionDisplayStatus(session, events as any)).toBe('running');
  });
});
