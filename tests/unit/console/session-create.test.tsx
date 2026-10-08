// @vitest-environment jsdom
/**
 * The harness example: the create-session modal from #691's regression
 * territory, now driven by real interaction instead of static markup.
 *
 * The interaction harness (`tests/unit/console/support/render.tsx`) is what
 * WP5 5.4–5.7 build on. This file exists to prove the plumbing works in CI:
 * jsdom renders, user-event clicks, and the api mock records the request a
 * submit produces. It re-covers the #698 checkout territory interactively —
 * pick Branch, type a name, submit — which the static suite cannot reach.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiRequests,
  onApiRequest,
  renderConsole,
  resetApi,
  screen,
  userEvent,
} from './support/render';
import { SessionModal } from '../../../apps/console/src/components/modals/SessionModals';
import type { ConsoleData } from '../../../apps/console/src/types';

const now = '2026-07-18T12:00:00.000Z';

/** Drives the headless ConsoleSelect: open the combobox, click the option. */
async function pickConsoleSelect(user: ReturnType<typeof userEvent.setup>, label: RegExp, optionName: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: optionName }));
}

const data = {
  agents: [{
    id: 'agent_echo',
    type: 'agent',
    name: 'Echo agent',
    description: 'Echoes input for local testing.',
    system: 'Echo.',
    model: 'local-echo',
    tools: [{ type: 'agent_toolset_20260401' }],
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
    description: 'Local test environment.',
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

describe('the interactive Console harness', () => {
  beforeEach(() => {
    resetApi();
  });

  afterEach(() => {
    resetApi();
  });

  it('records the request a repository checkout produces through real interaction', async () => {
    const user = userEvent.setup();
    onApiRequest(() => ({ id: 'sess_new', type: 'session' }));

    renderConsole(
      <SessionModal data={data} onClose={() => {}} onSaved={() => {}} onNavigate={() => {}} />,
    );

    // The agent and environment pickers gate the submit button. The picker
    // dismisses on any outside pointerdown, so open one picker at a time.
    await user.click(screen.getAllByRole('button', { name: /select an agent/i })[0]);
    await user.click(screen.getByRole('option', { name: /echo agent/i }));
    await user.click(screen.getAllByRole('button', { name: /select an environment/i })[0]);
    await user.click(screen.getByRole('option', { name: /local/i }));

    // Add a GitHub repository resource and pin a branch.
    await user.click(screen.getByRole('button', { name: /add resource/i }));
    await user.click(screen.getByRole('button', { name: 'GitHub repository' }));

    const urlInputs = screen.getAllByLabelText(/url/i);
    await user.type(urlInputs[0], 'https://github.com/owner/repo');
    const tokenInputs = screen.getAllByLabelText(/authorization token/i);
    await user.type(tokenInputs[0], 'ghp_token');

    await pickConsoleSelect(user, /checkout/i, 'Branch');
    await user.type(screen.getByLabelText(/branch name/i), 'release-1.2');

    await user.click(screen.getByRole('button', { name: /create session/i }));

    const create = apiRequests().find((request) => request.path === '/v1/sessions');
    expect(create).toBeDefined();
    expect(create?.body).toMatchObject({
      agent: 'agent_echo',
      environment_id: 'env_local',
      resources: [{
        type: 'github_repository',
        url: 'https://github.com/owner/repo',
        authorization_token: 'ghp_token',
        checkout: { type: 'branch', name: 'release-1.2' },
      }],
    });
  });

  describe('engine picker', () => {
    const settingsData = {
      ...data,
      settings: {
        saved_config: {
          loop_engine: { provider: 'builtin', options: {} },
          sandbox: { provider: 'local', options: {} },
        },
        adapters: {
          loop_engine: [
            { id: 'builtin', label: 'Default', status: 'available' },
            { id: 'pi', label: 'Pi CLI', status: 'available', requirements: ['Pi CLI available on PATH', 'local sandbox provider'] },
            { id: 'codex', label: 'Codex', status: 'unavailable' },
            { id: 'harness', label: 'Harness', status: 'unavailable' },
            { id: 'claude', label: 'Claude', status: 'unavailable' },
          ],
        },
      },
    } as unknown as ConsoleData;

    async function pickAgentAndEnvironment(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getAllByRole('button', { name: /select an agent/i })[0]);
      await user.click(screen.getByRole('option', { name: /echo agent/i }));
      await user.click(screen.getAllByRole('button', { name: /select an environment/i })[0]);
      await user.click(screen.getByRole('option', { name: /local/i }));
    }

    it('omits loop_engine when the runtime default is kept', async () => {
      const user = userEvent.setup();
      onApiRequest(() => ({ id: 'sess_new', type: 'session' }));

      renderConsole(
        <SessionModal data={settingsData} onClose={() => {}} onSaved={() => {}} onNavigate={() => {}} />,
      );

      await pickAgentAndEnvironment(user);
      await user.click(screen.getByRole('button', { name: /create session/i }));

      const create = apiRequests().find((request) => request.path === '/v1/sessions');
      expect(create?.body).toMatchObject({ agent: 'agent_echo', environment_id: 'env_local' });
      expect(create?.body).not.toHaveProperty('loop_engine');
    });

    it('sends loop_engine when an executable engine is picked', async () => {
      const user = userEvent.setup();
      onApiRequest(() => ({ id: 'sess_new', type: 'session' }));

      renderConsole(
        <SessionModal data={settingsData} onClose={() => {}} onSaved={() => {}} onNavigate={() => {}} />,
      );

      await pickAgentAndEnvironment(user);
      await pickConsoleSelect(user, /loop engine/i, 'Pi CLI');
      await user.click(screen.getByRole('button', { name: /create session/i }));

      const create = apiRequests().find((request) => request.path === '/v1/sessions');
      expect(create?.body).toMatchObject({ loop_engine: 'pi' });
    });

    it('offers only executable engines, never roadmap adapters', async () => {
      const user = userEvent.setup();

      renderConsole(
        <SessionModal data={settingsData} onClose={() => {}} onSaved={() => {}} onNavigate={() => {}} />,
      );

      await user.click(screen.getByRole('combobox', { name: /loop engine/i }));

      const options = (await screen.findAllByRole('option')).map((option) => option.textContent);
      expect(options).toEqual(expect.arrayContaining(['Default', 'Pi CLI']));
      for (const roadmap of ['Codex', 'Harness', 'Claude']) {
        expect(options).not.toContain(roadmap);
      }
    });

    it('warns when a picked engine requires the local sandbox', async () => {
      const nonLocalData = {
        ...settingsData,
        settings: {
          ...(settingsData.settings as unknown as Record<string, unknown>),
          saved_config: {
            loop_engine: { provider: 'builtin', options: {} },
            sandbox: { provider: 'docker', options: {} },
          },
        },
      } as unknown as ConsoleData;
      const user = userEvent.setup();

      renderConsole(
        <SessionModal data={nonLocalData} onClose={() => {}} onSaved={() => {}} onNavigate={() => {}} />,
      );

      await pickConsoleSelect(user, /loop engine/i, 'Pi CLI');
      expect(screen.getByText(/requires the local sandbox/i)).toBeDefined();
    });
  });

  describe('limits and initial outcome', () => {
    async function pickAgentAndEnvironment(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getAllByRole('button', { name: /select an agent/i })[0]);
      await user.click(screen.getByRole('option', { name: /echo agent/i }));
      await user.click(screen.getAllByRole('button', { name: /select an environment/i })[0]);
      await user.click(screen.getByRole('option', { name: /local/i }));
    }

    it('serializes the dollar budget to the published cents shape', async () => {
      const user = userEvent.setup();
      onApiRequest(() => ({ id: 'sess_new', type: 'session' }));

      renderConsole(
        <SessionModal data={data} onClose={() => {}} onSaved={() => {}} onNavigate={() => {}} />,
      );

      await pickAgentAndEnvironment(user);
      await user.type(screen.getByLabelText(/spend limit/i), '5.00');
      await user.click(screen.getByRole('button', { name: /create session/i }));

      const create = apiRequests().find((request) => request.path === '/v1/sessions');
      expect(create?.body).toMatchObject({
        budget: { type: 'limit', max_list_cost: { amount: '500', currency: 'USD' } },
      });
      expect(create?.body).not.toHaveProperty('initial_events');
    });

    it('sends an initial user.define_outcome when description and rubric are filled', async () => {
      const user = userEvent.setup();
      onApiRequest(() => ({ id: 'sess_new', type: 'session' }));

      renderConsole(
        <SessionModal data={data} onClose={() => {}} onSaved={() => {}} onNavigate={() => {}} />,
      );

      await pickAgentAndEnvironment(user);
      await user.type(screen.getByLabelText(/initial outcome/i), 'Ship the migration');
      await user.type(screen.getByLabelText(/^rubric$/i), 'All tests pass');
      await user.type(screen.getByLabelText(/max iterations/i), '5');
      await user.click(screen.getByRole('button', { name: /create session/i }));

      const create = apiRequests().find((request) => request.path === '/v1/sessions');
      expect(create?.body).toMatchObject({
        initial_events: [{
          type: 'user.define_outcome',
          description: 'Ship the migration',
          rubric: { type: 'text', content: 'All tests pass' },
          max_iterations: 5,
        }],
      });
    });

    it('refuses to submit a malformed budget', async () => {
      const user = userEvent.setup();
      onApiRequest(() => ({ id: 'sess_new', type: 'session' }));

      renderConsole(
        <SessionModal data={data} onClose={() => {}} onSaved={() => {}} onNavigate={() => {}} />,
      );

      await pickAgentAndEnvironment(user);
      await user.type(screen.getByLabelText(/spend limit/i), 'abc');
      await user.click(screen.getByRole('button', { name: /create session/i }));

      expect(apiRequests().find((request) => request.path === '/v1/sessions')).toBeUndefined();
      expect(screen.getByText(/valid dollar amount/i)).toBeDefined();
    });

    it('refuses to submit a half-filled outcome', async () => {
      const user = userEvent.setup();
      onApiRequest(() => ({ id: 'sess_new', type: 'session' }));

      renderConsole(
        <SessionModal data={data} onClose={() => {}} onSaved={() => {}} onNavigate={() => {}} />,
      );

      await pickAgentAndEnvironment(user);
      await user.type(screen.getByLabelText(/initial outcome/i), 'Ship the migration');
      await user.click(screen.getByRole('button', { name: /create session/i }));

      expect(apiRequests().find((request) => request.path === '/v1/sessions')).toBeUndefined();
      expect(screen.getByText(/both a description and a rubric/i)).toBeDefined();
    });
  });

  it('shows the checkout value input only after the operator picks a mode', async () => {
    const user = userEvent.setup();
    onApiRequest(() => ({ id: 'sess_new', type: 'session' }));

    renderConsole(
      <SessionModal data={data} onClose={() => {}} onSaved={() => {}} onNavigate={() => {}} />,
    );

    await user.click(screen.getByRole('button', { name: /add resource/i }));
    await user.click(screen.getByRole('button', { name: 'GitHub repository' }));

    expect(screen.queryByLabelText(/branch name/i)).toBeNull();
    expect(screen.queryByLabelText(/commit sha/i)).toBeNull();

    await pickConsoleSelect(user, /checkout/i, 'Branch');
    expect(screen.getByLabelText(/branch name/i)).toBeDefined();

    await pickConsoleSelect(user, /checkout/i, 'Commit SHA');
    expect(screen.queryByLabelText(/branch name/i)).toBeNull();
    expect(screen.getByLabelText(/commit sha/i)).toBeDefined();
  });
});
