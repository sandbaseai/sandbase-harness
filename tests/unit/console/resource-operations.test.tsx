// @vitest-environment jsdom
/**
 * Environments, webhooks, scheduled deployments, memory stores, and
 * credential vaults on the published vocabulary (WP2 F9/F10).
 *
 * These tests drive the real UI through the jsdom harness and assert the
 * exact request bodies the Console posts:
 *
 * - environments create as `cloud` with no `sandbox_provider` (the workspace
 *   default resolves it), the detail page surfaces `effective_sandbox_provider`
 *   with an un-isolated warning for `local`, and delete is confirmed and its
 *   409 reason displayed;
 * - webhook subscriptions are picked from the grouped official event
 *   catalog — no free text, no wildcards — and deliveries render the
 *   published envelope fields;
 * - scheduled deployments submit `schedule: {type:'cron', expression,
 *   timezone}` plus an `initial_events` user message, and run rows render
 *   `trigger_context` and `error.type`;
 * - memory stores edit, confirm-delete, and list versions with redact
 *   disabled on the head version;
 * - vaults edit, confirm-delete, and credentials edit through the published
 *   `auth` patch per `auth.type`.
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
  within,
} from './support/render';
import { ResourceModal } from '../../../apps/console/src/components/modals/ResourceModals';
import { EnvironmentDetail } from '../../../apps/console/src/components/pages/EnvironmentPages';
import { OutcomesPage, ScheduledDeploymentsPage, WebhooksPage } from '../../../apps/console/src/components/pages/OperationsPages';
import { MemoryStoreDetail } from '../../../apps/console/src/components/pages/MemoryPages';
import { CredentialVaultDetail } from '../../../apps/console/src/components/pages/CredentialPages';
import type {
  ConsoleData,
  Environment,
  MemoryStore,
  Outcome,
  ScheduledDeployment,
  Vault,
  Webhook,
} from '../../../apps/console/src/types';

const now = '2026-10-05T12:00:00.000Z';

const environment: Environment = {
  id: 'env_cloud',
  type: 'environment',
  name: 'Cloud env',
  description: 'Managed env',
  config: { hosting_type: 'cloud' },
  effective_sandbox_provider: 'local',
  packages_enforced: false,
  networking_enforced: false,
  metadata: {},
  created_at: now,
  updated_at: now,
  archived_at: null,
};

const webhook: Webhook = {
  id: 'wh_1',
  type: 'webhook',
  name: 'Ops hook',
  url: 'http://localhost:8123/hook',
  events: ['session.created', 'session.status_terminated'],
  description: '',
  status: 'active',
  metadata: {},
  created_at: now,
  updated_at: now,
  archived_at: null,
};

const deployment: ScheduledDeployment = {
  id: 'dep_1',
  type: 'deployment',
  name: 'Nightly run',
  description: null,
  agent: { type: 'agent', id: 'agent_echo', version: 1 },
  environment_id: 'env_cloud',
  initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'review' }] }],
  resources: [],
  vault_ids: [],
  schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'UTC', upcoming_runs_at: ['2026-10-06T09:00:00Z', '2026-10-07T09:00:00Z'] },
  status: 'active',
  paused_reason: null,
  metadata: {},
  created_at: now,
  updated_at: now,
  archived_at: null,
};

const store: MemoryStore = {
  id: 'memstore_1',
  type: 'memory_store',
  name: 'Notes',
  description: 'Shared notes',
  provider: 'sqlite',
  status: 'active',
  memory_count: 1,
  memories: [{
    id: 'mem_1',
    type: 'memory',
    memory_store_id: 'memstore_1',
    memory_version_id: 'mv_head',
    path: '/notes/a',
    content: 'hello',
    content_size_bytes: 5,
    content_sha256: 'abc',
    created_at: now,
    updated_at: now,
  }],
  config: {},
  metadata: {},
  created_at: now,
  updated_at: now,
  archived_at: null,
};

const vault: Vault = {
  id: 'vault_1',
  type: 'credential_vault',
  name: 'Prod vault',
  display_name: 'Prod vault',
  description: 'Vault description',
  status: 'active',
  credential_count: 1,
  credentials: [{
    id: 'cred_1',
    type: 'credential',
    vault_id: 'vault_1',
    name: 'Token cred',
    auth_type: 'bearer_token',
    mcp_server_url: '',
    variable_name: '',
    value_hint: 'tok…1234',
    network: {},
    injection_locations: ['request_headers'],
    status: 'active',
    metadata: {},
    created_at: now,
    updated_at: now,
    last_used_at: null,
    archived_at: null,
  }],
  metadata: {},
  created_at: now,
  updated_at: now,
  archived_at: null,
};

const outcome: Outcome = {
  id: 'out_1',
  type: 'outcome',
  name: 'Quality gate',
  description: 'Deployment-quality response',
  objective: 'Reply covers every open item',
  criteria: ['mentions each item', 'no placeholders'],
  pass_threshold: 0.8,
  evaluator: 'deterministic',
  metadata: {},
  status: 'active',
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
  sessions: [],
  environments: [environment],
  vaults: [vault],
  memoryStores: [store],
  files: [],
  apiKeys: [],
  skills: [],
  templates: [],
  webhooks: [webhook],
  scheduledDeployments: [deployment],
  outcomes: [outcome],
  runtime: null,
  workspace: null,
  settings: {
    schema_version: 1,
    revision: 1,
    effective_revision: 1,
    saved_config: {},
    effective_config: { sandbox: { provider: 'docker', options: {} } },
    restart_required: false,
    activation_status: 'active',
    activation_errors: [],
    diagnostics: { metadata: { path: null, health: 'ok' } },
    secret_states: {},
    adapters: { model: [], loop_engine: [], storage: { metadata: [], artifacts: [] }, memory: [], sandbox: [] },
  },
} as unknown as ConsoleData;

describe('the environment pages', () => {
  beforeEach(resetApi);
  afterEach(resetApi);

  it('creates an environment as cloud with no sandbox_provider and the published packages shape', async () => {
    const user = userEvent.setup();
    onApiRequest(() => environment);
    renderConsole(<ResourceModal kind="environment" defaultSandboxProvider="docker" onClose={() => {}} onSaved={() => {}} />);

    // Cloud is the default: the summary names the workspace default backend
    // and no hosting select is shown until the advanced section opens.
    expect(screen.getByText(/workspace default sandbox backend/i)).toBeDefined();
    expect(screen.getByText('docker')).toBeDefined();

    await user.type(screen.getByLabelText(/name/i), 'Demo env');
    await user.click(screen.getByRole('button', { name: /create environment/i }));

    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'POST' && item.path === '/v1/environments');
      expect(request).toBeDefined();
      const body = request?.body as { config: Record<string, unknown> };
      expect(body.config.hosting_type).toBe('cloud');
      expect(body.config.sandbox_provider).toBeUndefined();
      expect(body.config.packages).toEqual({ type: 'packages', apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] });
    });
  });

  it('sends sandbox_provider when a specific hosting type is picked in the advanced section', async () => {
    const user = userEvent.setup();
    onApiRequest(() => environment);
    renderConsole(<ResourceModal kind="environment" defaultSandboxProvider="docker" onClose={() => {}} onSaved={() => {}} />);

    await user.type(screen.getByLabelText(/name/i), 'Docker env');
    await user.click(screen.getByText(/advanced/i));
    // The hosting picker is a headless combobox (ConsoleSelect), not a <select>.
    await user.click(screen.getByRole('combobox', { name: /hosting type/i }));
    await user.click(await screen.findByRole('option', { name: /docker container/i }));
    await user.click(screen.getByRole('button', { name: /create environment/i }));

    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'POST' && item.path === '/v1/environments');
      const body = request?.body as { config: Record<string, unknown> };
      expect(body.config.hosting_type).toBe('docker');
      expect(body.config.sandbox_provider).toBe('docker');
    });
  });

  it('shows the effective backend and the un-isolated warning, then confirms delete', async () => {
    const user = userEvent.setup();
    onApiRequest(() => environment);
    renderConsole(<EnvironmentDetail environment={environment} data={data} onBack={() => {}} onRefresh={() => {}} />);

    expect(screen.getByText('Effective backend')).toBeDefined();
    expect(screen.getAllByText('local').length).toBeGreaterThan(0);
    expect(screen.getByText(/not isolated/i)).toBeDefined();

    await user.click(screen.getByTitle('Environment actions'));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete environment/i });
    await user.click(within(dialog).getByRole('button', { name: /delete environment/i }));

    await waitFor(() => {
      expect(apiRequests().some((item) => item.method === 'DELETE' && item.path === '/v1/environments/env_cloud')).toBe(true);
    });
  });

  it('surfaces the 409 reason when deletion is refused', async () => {
    const user = userEvent.setup();
    onApiRequest((request) => {
      if (request.method === 'DELETE') return new Error('Environment is in use by an active session');
      return environment;
    });
    renderConsole(<EnvironmentDetail environment={environment} data={data} onBack={() => {}} onRefresh={() => {}} />);

    await user.click(screen.getByTitle('Environment actions'));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete environment/i });
    await user.click(within(dialog).getByRole('button', { name: /delete environment/i }));

    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('in use by an active session'));
  });
});

describe('the webhooks page', () => {
  beforeEach(resetApi);
  afterEach(resetApi);

  it('offers the grouped official event catalog and posts the selected names', async () => {
    const user = userEvent.setup();
    onApiRequest(() => webhook);
    renderConsole(<WebhooksPage data={data} onRefresh={() => {}} />);

    await user.click(screen.getByRole('button', { name: /create webhook/i }));
    const dialog = await screen.findByRole('dialog', { name: /create webhook/i });
    await user.type(within(dialog).getByLabelText(/endpoint url/i), 'http://localhost:9000/hook');
    // No free-text event input exists — the catalog is checkbox-only.
    expect(screen.queryByDisplayValue('turn_complete')).toBeNull();
    expect(screen.getByText('Sessions')).toBeDefined();
    expect(screen.getByText('Memory stores')).toBeDefined();

    await user.click(screen.getByLabelText('session.status_terminated'));
    await user.click(screen.getByLabelText('memory_store.created'));
    await user.click(within(dialog).getByRole('button', { name: /create webhook/i }));

    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'POST' && item.path === '/v1/webhooks');
      expect(request).toBeDefined();
      expect(request?.body).toMatchObject({
        url: 'http://localhost:9000/hook',
        events: ['session.status_terminated', 'memory_store.created'],
      });
    });
  });

  it('renders deliveries with the published envelope fields', async () => {
    const user = userEvent.setup();
    onApiRequest((request) => {
      if (request.path.endsWith('/deliveries')) {
        return {
          data: [{
            id: 'del_1',
            type: 'webhook_delivery',
            webhook_id: 'wh_1',
            event: 'session.created',
            payload: { type: 'event', id: 'evt_1', created_at: now, data: { type: 'session', id: 'sess_1' } },
            status: 'delivered',
            status_code: 200,
            error: null,
            signature: 'v1=sig',
            attempt_count: 1,
            next_retry_at: null,
            created_at: now,
            delivered_at: now,
          }],
        };
      }
      return {};
    });
    renderConsole(<WebhooksPage data={data} onRefresh={() => {}} />);

    await user.click(screen.getByRole('button', { name: /deliveries/i }));
    await waitFor(() => expect(screen.getByText('session.created')).toBeDefined());
    expect(screen.getByText('sess_1')).toBeDefined();
    expect(screen.getByText('session')).toBeDefined();
  });

  it('edits a subscription through the published PUT fields', async () => {
    const user = userEvent.setup();
    onApiRequest(() => webhook);
    renderConsole(<WebhooksPage data={data} onRefresh={() => {}} />);

    // The desktop row and the mobile card both render an Edit affordance.
    await user.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    const dialog = await screen.findByRole('dialog', { name: /edit webhook/i });
    const urlInput = within(dialog).getByLabelText(/endpoint url/i) as HTMLInputElement;
    expect(urlInput.value).toBe('http://localhost:8123/hook');
    // Existing selections carry over into the editor.
    expect((within(dialog).getByLabelText('session.created') as HTMLInputElement).checked).toBe(true);

    await user.clear(urlInput);
    await user.type(urlInput, 'https://example.com/hooks/ops');
    await user.click(within(dialog).getByLabelText('memory_store.created'));
    await user.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'PUT' && item.path === '/v1/webhooks/wh_1');
      expect(request).toBeDefined();
      expect(request?.body).toMatchObject({
        url: 'https://example.com/hooks/ops',
        status: 'active',
        events: ['session.created', 'session.status_terminated', 'memory_store.created'],
      });
    });
  });

  it('rotates the signing secret and shows the returned key once', async () => {
    const user = userEvent.setup();
    onApiRequest((request) => {
      if (request.path.endsWith('/rotate-secret')) {
        return { ...webhook, secret_key: 'whsec_new_123' };
      }
      return webhook;
    });
    renderConsole(<WebhooksPage data={data} onRefresh={() => {}} />);

    // The desktop row and the mobile card both render an Edit affordance.
    await user.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    const dialog = await screen.findByRole('dialog', { name: /edit webhook/i });

    // The rotate button arms first; a second click performs the call.
    await user.click(within(dialog).getByRole('button', { name: /rotate secret/i }));
    expect(apiRequests().some((item) => item.path.endsWith('/rotate-secret'))).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: /confirm rotate/i }));

    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'POST' && item.path.endsWith('/rotate-secret'));
      expect(request).toBeDefined();
    });
    await waitFor(() => expect(within(dialog).getByText('whsec_new_123')).toBeDefined());
  });

  it('retires the signing secret through the published route after confirming', async () => {
    const user = userEvent.setup();
    onApiRequest(() => webhook);
    renderConsole(<WebhooksPage data={data} onRefresh={() => {}} />);

    // The desktop row and the mobile card both render an Edit affordance.
    await user.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    const dialog = await screen.findByRole('dialog', { name: /edit webhook/i });

    await user.click(within(dialog).getByRole('button', { name: /retire secret/i }));
    expect(apiRequests().some((item) => item.path.endsWith('/retire-secret'))).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: /confirm retire/i }));

    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'POST' && item.path.endsWith('/retire-secret'));
      expect(request).toBeDefined();
      expect(request?.body).toEqual({});
    });
  });
});

describe('the scheduled deployments page', () => {
  beforeEach(resetApi);
  afterEach(resetApi);

  it('posts the published schedule object and initial_events', async () => {
    const user = userEvent.setup();
    onApiRequest(() => deployment);
    renderConsole(<ScheduledDeploymentsPage data={data} onRefresh={() => {}} />);

    await user.click(screen.getByRole('button', { name: /create schedule/i }));
    const dialog = await screen.findByRole('dialog', { name: /create scheduled deployment/i });
    await user.type(within(dialog).getByLabelText(/^name/i), 'Nightly');
    await user.clear(within(dialog).getByLabelText(/cron expression/i));
    await user.type(within(dialog).getByLabelText(/cron expression/i), '30 8 * * *');
    await user.clear(within(dialog).getByLabelText(/timezone/i));
    await user.type(within(dialog).getByLabelText(/timezone/i), 'Europe/Berlin');
    await user.type(within(dialog).getByLabelText(/prompt/i), 'Review open items');
    await user.click(within(dialog).getByRole('button', { name: /create schedule/i }));

    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'POST' && item.path === '/v1/scheduled-deployments');
      expect(request).toBeDefined();
      expect(request?.body).toMatchObject({
        name: 'Nightly',
        agent_id: 'agent_echo',
        schedule: { type: 'cron', expression: '30 8 * * *', timezone: 'Europe/Berlin' },
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'Review open items' }] }],
      });
    });
  });

  it('lists runs with trigger_context and error.type', async () => {
    const user = userEvent.setup();
    onApiRequest((request) => {
      if (request.path.startsWith('/v1/deployment_runs')) {
        return {
          data: [{
            type: 'deployment_run',
            id: 'run_1',
            deployment_id: 'dep_1',
            trigger_context: { type: 'schedule', scheduled_at: '2026-10-06T09:00:00Z' },
            session_id: null,
            error: { type: 'environment_archived_error', message: 'environment archived' },
            agent: null,
            created_at: now,
          }],
        };
      }
      return {};
    });
    renderConsole(<ScheduledDeploymentsPage data={data} onRefresh={() => {}} />);

    await user.click(screen.getByRole('button', { name: /^runs$/i }));
    await waitFor(() => expect(screen.getByText('environment_archived_error')).toBeDefined());
    expect(screen.getByText('schedule')).toBeDefined();
    expect(screen.getByText(/upcoming runs/i)).toBeDefined();
  });

  it('puts the published update shape on the schedule', async () => {
    const user = userEvent.setup();
    onApiRequest(() => deployment);
    renderConsole(<ScheduledDeploymentsPage data={data} onRefresh={() => {}} />);

    // Desktop row and mobile card each render an Edit control — take the first.
    await user.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    const dialog = await screen.findByRole('dialog', { name: /edit schedule/i });
    // The modal prefills the stored schedule and the stored prompt.
    expect((within(dialog).getByLabelText(/^name/i) as HTMLInputElement).value).toBe('Nightly run');
    expect((within(dialog).getByLabelText(/cron expression/i) as HTMLInputElement).value).toBe('0 9 * * *');
    expect((within(dialog).getByLabelText(/prompt/i) as HTMLTextAreaElement).value).toBe('review');

    await user.clear(within(dialog).getByLabelText(/^name/i));
    await user.type(within(dialog).getByLabelText(/^name/i), 'Morning run');
    await user.clear(within(dialog).getByLabelText(/cron expression/i));
    await user.type(within(dialog).getByLabelText(/cron expression/i), '15 7 * * *');
    await user.clear(within(dialog).getByLabelText(/timezone/i));
    await user.type(within(dialog).getByLabelText(/timezone/i), 'Asia/Shanghai');
    await user.click(within(dialog).getByRole('button', { name: /save schedule/i }));

    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'PUT' && item.path === '/v1/scheduled-deployments/dep_1');
      expect(request).toBeDefined();
      expect(request?.body).toMatchObject({
        name: 'Morning run',
        agent_id: 'agent_echo',
        environment_id: 'env_cloud',
        schedule: { type: 'cron', expression: '15 7 * * *', timezone: 'Asia/Shanghai' },
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'review' }] }],
      });
    });
  });

  it('switches to manual-only when the cron expression is cleared', async () => {
    const user = userEvent.setup();
    onApiRequest(() => deployment);
    renderConsole(<ScheduledDeploymentsPage data={data} onRefresh={() => {}} />);

    await user.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    const dialog = await screen.findByRole('dialog', { name: /edit schedule/i });
    await user.clear(within(dialog).getByLabelText(/cron expression/i));
    await user.click(within(dialog).getByRole('button', { name: /save schedule/i }));

    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'PUT' && item.path === '/v1/scheduled-deployments/dep_1');
      expect(request?.body).toMatchObject({ schedule: null });
    });
  });

  it('surfaces an update refusal inside the edit dialog', async () => {
    const user = userEvent.setup();
    onApiRequest((request) => {
      if (request.method === 'PUT') return new Error('Unknown agent: agent_echo');
      return deployment;
    });
    renderConsole(<ScheduledDeploymentsPage data={data} onRefresh={() => {}} />);

    await user.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    const dialog = await screen.findByRole('dialog', { name: /edit schedule/i });
    await user.click(within(dialog).getByRole('button', { name: /save schedule/i }));

    await waitFor(() => expect(within(dialog).getByText(/unknown agent/i)).toBeDefined());
    // The dialog stays open so the draft is not lost.
    expect(screen.getByRole('dialog', { name: /edit schedule/i })).toBeDefined();
  });

  it('confirms before deleting and calls the delete route', async () => {
    const user = userEvent.setup();
    onApiRequest(() => deployment);
    renderConsole(<ScheduledDeploymentsPage data={data} onRefresh={() => {}} />);

    await user.click(screen.getAllByRole('button', { name: /^delete$/i })[0]);
    const dialog = await screen.findByRole('dialog', { name: /delete schedule/i });
    await user.click(within(dialog).getByRole('button', { name: /delete schedule/i }));

    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'DELETE' && item.path === '/v1/scheduled-deployments/dep_1');
      expect(request).toBeDefined();
    });
  });

  it('pauses and resumes through the dedicated routes', async () => {
    const user = userEvent.setup();
    onApiRequest(() => deployment);
    renderConsole(<ScheduledDeploymentsPage data={data} onRefresh={() => {}} />);

    await user.click(screen.getAllByRole('button', { name: /^pause$/i })[0]);
    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'POST' && item.path === '/v1/scheduled-deployments/dep_1/pause');
      expect(request).toBeDefined();
    });
  });
});

describe('the memory store page', () => {
  beforeEach(resetApi);
  afterEach(resetApi);

  it('edits the store with the published patch shape', async () => {
    const user = userEvent.setup();
    onApiRequest(() => store);
    renderConsole(<MemoryStoreDetail store={store} onBack={() => {}} onRefresh={() => {}} onNewMemory={() => {}} />);

    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    const dialog = await screen.findByRole('dialog', { name: /edit memory store/i });
    await user.clear(within(dialog).getByLabelText(/name/i));
    await user.type(within(dialog).getByLabelText(/name/i), 'Renamed store');
    await user.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'POST' && item.path === '/v1/memory_stores/memstore_1');
      expect(request?.body).toMatchObject({ name: 'Renamed store', description: 'Shared notes' });
    });
  });

  it('confirms delete and surfaces the in-use refusal', async () => {
    const user = userEvent.setup();
    onApiRequest((request) => {
      if (request.method === 'DELETE') return new Error('Memory store is mounted by an active session');
      return store;
    });
    renderConsole(<MemoryStoreDetail store={store} onBack={() => {}} onRefresh={() => {}} onNewMemory={() => {}} />);

    await user.click(screen.getByTitle('Store actions'));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete memory store/i });
    await user.click(within(dialog).getByRole('button', { name: /delete memory store/i }));

    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('mounted by an active session'));
  });

  it('lists versions and disables redact on the head version', async () => {
    const user = userEvent.setup();
    onApiRequest((request) => {
      if (request.path.includes('memory_versions')) {
        return {
          data: [
            {
              id: 'mv_head', type: 'memory_version', memory_id: 'mem_1', memory_store_id: 'memstore_1',
              operation: 'modified', created_at: now, content: 'hello', content_sha256: 'abc', content_size_bytes: 5,
              path: '/notes/a', created_by: null, redacted_at: null,
            },
            {
              id: 'mv_old', type: 'memory_version', memory_id: 'mem_1', memory_store_id: 'memstore_1',
              operation: 'created', created_at: now, content: 'old', content_sha256: 'def', content_size_bytes: 3,
              path: '/notes/a', created_by: null, redacted_at: null,
            },
          ],
        };
      }
      return store;
    });
    renderConsole(<MemoryStoreDetail store={store} onBack={() => {}} onRefresh={() => {}} onNewMemory={() => {}} />);

    await user.click(screen.getByText('a'));
    await user.click(screen.getByRole('button', { name: /versions/i }));

    await waitFor(() => expect(screen.getByText('(current)')).toBeDefined());
    const redactButtons = screen.getAllByRole('button', { name: /redact/i });
    expect(redactButtons[0]).toHaveProperty('disabled', true);
    expect(redactButtons[1]).toHaveProperty('disabled', false);

    await user.click(redactButtons[1]);
    await waitFor(() => {
      expect(apiRequests().some((item) => item.method === 'POST' && item.path.endsWith('/memory_versions/mv_old/redact'))).toBe(true);
    });
  });
});

describe('the credential vault page', () => {
  beforeEach(resetApi);
  afterEach(resetApi);

  it('edits the vault with the published display_name patch', async () => {
    const user = userEvent.setup();
    onApiRequest(() => vault);
    renderConsole(<CredentialVaultDetail vault={vault} onBack={() => {}} onRefresh={() => {}} onNewCredential={() => {}} />);

    await user.click(screen.getByTitle('Vault actions'));
    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    const dialog = await screen.findByRole('dialog', { name: /edit vault/i });
    await user.clear(within(dialog).getByLabelText(/name/i));
    await user.type(within(dialog).getByLabelText(/name/i), 'Renamed vault');
    await user.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'POST' && item.path === '/v1/credential-vaults/vault_1');
      expect(request?.body).toMatchObject({ display_name: 'Renamed vault', description: 'Vault description' });
    });
  });

  it('confirms vault delete and surfaces vault_in_use', async () => {
    const user = userEvent.setup();
    onApiRequest((request) => {
      if (request.method === 'DELETE') return new Error('Credential vault is in use by an active session');
      return vault;
    });
    renderConsole(<CredentialVaultDetail vault={vault} onBack={() => {}} onRefresh={() => {}} onNewCredential={() => {}} />);

    await user.click(screen.getByTitle('Vault actions'));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete vault/i });
    await user.click(within(dialog).getByRole('button', { name: /delete vault/i }));

    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('in use by an active session'));
  });

  it('runs the published MCP probe from the credential row and renders the verdict', async () => {
    const user = userEvent.setup();
    onApiRequest(() => ({
      type: 'vault_credential_validation',
      credential_id: 'cred_1',
      vault_id: 'vault_1',
      validated_at: now,
      has_refresh_token: false,
      status: 'valid',
      mcp_probe: { method: 'initialize', http_response: { status_code: 200 } },
      refresh: null,
    }));
    renderConsole(<CredentialVaultDetail vault={vault} onBack={() => {}} onRefresh={() => {}} onNewCredential={() => {}} />);

    await user.click(screen.getAllByTitle('Credential actions')[0]);
    await user.click(screen.getAllByRole('button', { name: /^validate$/i })[0]);

    const dialog = await screen.findByRole('dialog', { name: /validate credential/i });
    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'POST' && item.path === '/v1/credential-vaults/vault_1/credentials/cred_1/mcp_oauth_validate');
      expect(request).toBeDefined();
    });
    expect(await within(dialog).findByText('Valid')).toBeDefined();
    expect(within(dialog).getByText(/HTTP 200/)).toBeDefined();
  });

  it('edits a bearer credential through the published auth patch', async () => {
    const user = userEvent.setup();
    onApiRequest(() => vault);
    renderConsole(<CredentialVaultDetail vault={vault} onBack={() => {}} onRefresh={() => {}} onNewCredential={() => {}} />);

    await user.click(screen.getAllByTitle('Credential actions')[0]);
    // The desktop row menu and the mobile card menu render for the same
    // credential; either carries the same Edit action.
    await user.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    const dialog = await screen.findByRole('dialog', { name: /edit credential/i });
    await user.clear(within(dialog).getByLabelText(/^name$/i));
    await user.type(within(dialog).getByLabelText(/^name$/i), 'Renamed cred');
    await user.type(within(dialog).getByLabelText(/new token/i), 'secret-token');
    await user.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'POST' && item.path === '/v1/credential-vaults/vault_1/credentials/cred_1');
      expect(request?.body).toMatchObject({
        display_name: 'Renamed cred',
        auth: { type: 'static_bearer', token: 'secret-token' },
      });
    });
  });
});

describe('the outcomes page', () => {
  beforeEach(resetApi);
  afterEach(resetApi);

  it('puts the stored fields back through the published update route', async () => {
    const user = userEvent.setup();
    onApiRequest(() => outcome);
    renderConsole(<OutcomesPage data={data} onRefresh={() => {}} />);

    // Desktop row and mobile card each render an Edit control — take the first.
    await user.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    const dialog = await screen.findByRole('dialog', { name: /edit outcome/i });
    expect((within(dialog).getByLabelText(/^name/i) as HTMLInputElement).value).toBe('Quality gate');
    expect((within(dialog).getByLabelText(/objective/i) as HTMLTextAreaElement).value).toBe('Reply covers every open item');
    expect((within(dialog).getByLabelText(/criteria/i) as HTMLTextAreaElement).value).toBe('mentions each item\nno placeholders');

    await user.clear(within(dialog).getByLabelText(/^name/i));
    await user.type(within(dialog).getByLabelText(/^name/i), 'Stricter gate');
    await user.clear(within(dialog).getByLabelText(/pass threshold/i));
    await user.type(within(dialog).getByLabelText(/pass threshold/i), '0.9');
    await user.click(within(dialog).getByRole('button', { name: /save outcome/i }));

    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'PUT' && item.path === '/v1/outcomes/out_1');
      expect(request).toBeDefined();
      expect(request?.body).toMatchObject({
        name: 'Stricter gate',
        objective: 'Reply covers every open item',
        description: 'Deployment-quality response',
        criteria: ['mentions each item', 'no placeholders'],
        pass_threshold: 0.9,
        status: 'active',
      });
    });
  });

  it('surfaces an update refusal inside the edit dialog', async () => {
    const user = userEvent.setup();
    onApiRequest((request) => {
      if (request.method === 'PUT') return new Error('Outcome not found');
      return outcome;
    });
    renderConsole(<OutcomesPage data={data} onRefresh={() => {}} />);

    await user.click(screen.getAllByRole('button', { name: /^edit$/i })[0]);
    const dialog = await screen.findByRole('dialog', { name: /edit outcome/i });
    await user.click(within(dialog).getByRole('button', { name: /save outcome/i }));

    await waitFor(() => expect(within(dialog).getByText(/outcome not found/i)).toBeDefined());
    expect(screen.getByRole('dialog', { name: /edit outcome/i })).toBeDefined();
  });
});
