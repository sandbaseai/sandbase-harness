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

    await user.selectOptions(screen.getByLabelText(/checkout/i), 'branch');
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

    await user.selectOptions(screen.getByLabelText(/checkout/i), 'branch');
    expect(screen.getByLabelText(/branch name/i)).toBeDefined();

    await user.selectOptions(screen.getByLabelText(/checkout/i), 'commit');
    expect(screen.queryByLabelText(/branch name/i)).toBeNull();
    expect(screen.getByLabelText(/commit sha/i)).toBeDefined();
  });
});
