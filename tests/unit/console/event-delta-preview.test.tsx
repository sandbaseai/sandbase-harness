// @vitest-environment jsdom
/**
 * `event_deltas[]` previews on the session page (WP5 F4).
 *
 * The Console opts the stream into `agent.message` previews with
 * `event_deltas[]=agent.message`. `event_start` opens a preview keyed by the
 * durable event id it announces, `event_delta` extends one content block of
 * it, and the buffered `agent.message` — which lands under that same id —
 * replaces the preview rather than duplicating it. A delta that arrives
 * before its `event_start` is ignored: dropped or reordered frames must not
 * materialise a preview out of order.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  act,
  apiRequests,
  onApiRequest,
  renderConsole,
  resetApi,
  screen,
  waitFor,
} from './support/render';
import { SessionDetail } from '../../../apps/console/src/components/pages/SessionPages';
import type { ConsoleData, Session } from '../../../apps/console/src/types';

const now = '2026-10-05T12:00:00.000Z';

const session: Session = {
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
  outcome_evaluations: [],
  metadata: {},
  created_at: now,
  updated_at: now,
  archived_at: null,
};

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
  sessions: [session],
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

type StreamEvent = { event: string; data: unknown; id?: string };

function renderDetail() {
  onApiRequest((request) => {
    if (request.path.endsWith('/events?limit=1000')) return { data: [], next_page: null };
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

function streamHandler() {
  const request = apiRequests().find(
    (item) => item.method === 'GET' && item.path.includes('/events/stream'),
  );
  return request?.body as (event: StreamEvent) => void;
}

function delta(eventId: string, text: string): StreamEvent {
  return {
    event: 'event_delta',
    data: {
      type: 'event_delta',
      event_id: eventId,
      delta: { type: 'content_delta', index: 0, content: { type: 'text', text } },
    },
  };
}

describe('the session page event_deltas preview', () => {
  beforeEach(() => {
    resetApi();
    Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
    window.requestAnimationFrame = window.requestAnimationFrame ?? ((callback) => setTimeout(callback, 0) as unknown as number);
  });

  afterEach(() => {
    resetApi();
  });

  it('opens the stream with event_deltas[]=agent.message', async () => {
    renderDetail();
    await waitFor(() => {
      const request = apiRequests().find(
        (item) => item.method === 'GET' && item.path.includes('/events/stream'),
      );
      expect(request).toBeDefined();
      expect(request!.path).toContain('event_deltas%5B%5D=agent.message');
    });
  });

  it('renders event_start + deltas as a preview, then the buffered event replaces it', async () => {
    renderDetail();
    await waitFor(() => expect(streamHandler()).toBeDefined());
    const onEvent = streamHandler();

    act(() => {
      onEvent({ event: 'event_start', data: { type: 'event_start', event: { type: 'agent.message', id: 'sevt_1' } } });
      onEvent(delta('sevt_1', 'Hel'));
      onEvent(delta('sevt_1', 'lo'));
    });

    // The preview is the concatenation of the delta prefix.
    await waitFor(() => expect(screen.getByText('Hello')).toBeDefined());
    expect(screen.getByText(/generating/i)).toBeDefined();

    // The buffered event lands under the announced id: the preview is gone
    // and the durable record renders instead — once.
    act(() => {
      onEvent({
        event: 'agent.message',
        id: '7',
        data: {
          id: 'sevt_1',
          seq: 7,
          type: 'agent.message',
          content: [{ type: 'text', text: 'Hello' }],
          created_at: now,
          processed_at: now,
        },
      });
    });

    await waitFor(() => expect(screen.queryByText(/generating/i)).toBeNull());
    expect(screen.getAllByText('Hello')).toHaveLength(1);
  });

  it('ignores a delta that arrives before its event_start', async () => {
    renderDetail();
    await waitFor(() => expect(streamHandler()).toBeDefined());
    const onEvent = streamHandler();

    act(() => onEvent(delta('sevt_orphan', 'orphaned')));

    // No preview materialised: the frame is dropped, not replayed later.
    await waitFor(() => {
      const request = apiRequests().find(
        (item) => item.method === 'GET' && item.path.includes('/events/stream'),
      );
      expect(request).toBeDefined();
    });
    expect(screen.queryByText('orphaned')).toBeNull();
    expect(screen.queryByText(/generating/i)).toBeNull();
  });
});
