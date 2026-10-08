// @vitest-environment jsdom
/**
 * Post-creation session resources and artifacts (the Resources & artifacts
 * dialog on the session page).
 *
 * The dialog reads the live instance listing — attaches, detaches, and token
 * rotations never show up in the creation-time `session.resources`
 * projection — and the artifact listing that `role: 'artifact'` file rows
 * produce, each with a download link to `/content`.
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

function makeSession(overrides: Partial<Session> = {}): Session {
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
    outcome_evaluations: [],
    metadata: {},
    created_at: now,
    updated_at: now,
    archived_at: null,
    ...overrides,
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
  files: [{
    id: 'file_notes',
    type: 'file',
    name: 'notes.md',
    media_type: 'text/markdown',
    size_bytes: 42,
    status: 'ready',
    metadata: {},
    created_at: now,
    updated_at: now,
    archived_at: null,
    preview: null,
    preview_truncated: false,
  }],
  apiKeys: [],
  skills: [],
  templates: [],
  runtime: null,
  workspace: null,
  settings: null,
} as unknown as ConsoleData;

const GITHUB_INSTANCE = {
  id: 'sri_repo',
  type: 'github_repository',
  url: 'https://github.com/sandbaseai/sandbase-harness',
  checkout: { type: 'branch', name: 'main' },
  mount_path: '/workspace/repo',
  created_at: now,
  updated_at: now,
};

const ARTIFACT = {
  id: 'file_art1',
  type: 'file',
  name: 'report.md',
  media_type: 'text/markdown',
  size_bytes: 1024,
  role: 'artifact',
  session_id: 'sess_1',
  artifact_path: '/artifacts/report.md',
  status: 'ready',
  metadata: {},
  created_at: now,
  updated_at: now,
  archived_at: null,
};

function renderDetail(
  session: Session,
  options: { instances?: unknown[]; artifacts?: unknown[] } = {},
) {
  const instances = options.instances ?? [];
  const artifacts = options.artifacts ?? [];
  onApiRequest((request) => {
    if (request.path.endsWith('/events?limit=1000')) return { data: [], next_page: null };
    if (request.path.endsWith('/resources') && request.method === 'GET') {
      return { data: instances, next_page: null };
    }
    if (request.path.endsWith('/artifacts') && request.method === 'GET') {
      return { data: artifacts, next_page: null };
    }
    if (request.path.endsWith('/resources') && request.method === 'POST') {
      return { id: 'sri_new', created_at: now, updated_at: now, ...(request.body as object) };
    }
    if (request.method === 'DELETE') return { id: 'x', type: 'session_resource_deleted' };
    if (request.method === 'POST') return { ok: true };
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

async function openResourcesDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^actions$/i }));
  await user.click(screen.getByRole('button', { name: /resources & artifacts/i }));
  await waitFor(() => expect(screen.getByRole('heading', { name: /attached resources/i })).toBeDefined());
}

describe('the session resources & artifacts dialog', () => {
  beforeEach(() => {
    resetApi();
    Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
    window.requestAnimationFrame = window.requestAnimationFrame ?? ((callback) => setTimeout(callback, 0) as unknown as number);
  });

  afterEach(() => {
    resetApi();
  });

  it('lists live resource instances and artifacts with a download link', async () => {
    const user = userEvent.setup();
    renderDetail(makeSession(), { instances: [GITHUB_INSTANCE], artifacts: [ARTIFACT] });
    await openResourcesDialog(user);

    await waitFor(() => expect(screen.getByText('https://github.com/sandbaseai/sandbase-harness')).toBeDefined());
    expect(screen.getByText('/workspace/repo')).toBeDefined();
    await waitFor(() => expect(screen.getByText('report.md')).toBeDefined());
    const download = screen.getByRole('link', { name: /download/i }) as HTMLAnchorElement;
    expect(download.href).toContain('/v1/sessions/sess_1/artifacts/file_art1/content');
    expect(download.download).toBe('report.md');
  });

  it('attaches a file resource with the published payload shape', async () => {
    const user = userEvent.setup();
    renderDetail(makeSession());
    await openResourcesDialog(user);

    await user.click(screen.getByRole('button', { name: /attach resource/i }));
    await user.click(screen.getByRole('button', { name: /^file$/i }));

    await user.click(screen.getByRole('button', { name: /select an uploaded file/i }));
    await user.click(await screen.findByRole('option', { name: /notes\.md/i }));

    await user.type(screen.getByPlaceholderText('/uploads/myfile.txt'), '/uploads/notes.md');
    await user.click(screen.getByRole('button', { name: /^attach$/i }));

    const submit = await waitFor(() => {
      const request = apiRequests().find(
        (item) => item.method === 'POST' && item.path.endsWith('/resources'),
      );
      expect(request).toBeDefined();
      return request;
    });
    expect(submit?.body).toEqual({
      type: 'file',
      file_id: 'file_notes',
      mount_path: '/uploads/notes.md',
    });
  });

  it('never offers memory_store — the route refuses it post-creation', async () => {
    const user = userEvent.setup();
    renderDetail(makeSession());
    await openResourcesDialog(user);

    await user.click(screen.getByRole('button', { name: /attach resource/i }));
    expect(screen.queryByRole('button', { name: /memory store/i })).toBeNull();
  });

  it('detaches an instance through DELETE', async () => {
    const user = userEvent.setup();
    renderDetail(makeSession(), { instances: [GITHUB_INSTANCE] });
    await openResourcesDialog(user);

    await waitFor(() => expect(screen.getByText('https://github.com/sandbaseai/sandbase-harness')).toBeDefined());
    await user.click(screen.getByRole('button', { name: /detach/i }));

    await waitFor(() => {
      expect(apiRequests().some(
        (item) => item.method === 'DELETE' && item.path.endsWith('/resources/sri_repo'),
      )).toBe(true);
    });
  });

  it('rotates a github_repository token through the single-field update', async () => {
    const user = userEvent.setup();
    renderDetail(makeSession(), { instances: [GITHUB_INSTANCE] });
    await openResourcesDialog(user);

    await waitFor(() => expect(screen.getByText('https://github.com/sandbaseai/sandbase-harness')).toBeDefined());
    await user.click(screen.getByRole('button', { name: /rotate token/i }));
    await user.type(screen.getByPlaceholderText(/ghp_/i), 'ghp_newtoken123');
    await user.click(screen.getByRole('button', { name: /^rotate$/i }));

    const submit = await waitFor(() => {
      const request = apiRequests().find(
        (item) => item.method === 'POST' && item.path.endsWith('/resources/sri_repo'),
      );
      expect(request).toBeDefined();
      return request;
    });
    expect(submit?.body).toEqual({ authorization_token: 'ghp_newtoken123' });
  });

  it('hides token rotation on a terminated session', async () => {
    const user = userEvent.setup();
    renderDetail(makeSession({ status: 'terminated' }), { instances: [GITHUB_INSTANCE] });
    await openResourcesDialog(user);

    await waitFor(() => expect(screen.getByText('https://github.com/sandbaseai/sandbase-harness')).toBeDefined());
    expect(screen.queryByRole('button', { name: /rotate token/i })).toBeNull();
  });
});
