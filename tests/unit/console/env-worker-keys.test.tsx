// @vitest-environment jsdom
/**
 * The self-hosted environment page's worker-key section: it lists keys through
 * `GET /v1/environments/{id}/worker-keys` and creates them through the POST of
 * the same route — the creation response's `secret_key` is revealed once in the
 * modal and never stored or listed again.
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
import { SelfHostedEnvironment } from '../../../apps/console/src/components/pages/EnvironmentDetailViews';
import type { Environment } from '../../../apps/console/src/types';

const now = '2026-07-18T12:00:00.000Z';

const environment = {
  id: 'env_self',
  type: 'environment',
  name: 'Self-hosted env',
  description: 'Worker env',
  config: { hosting_type: 'self_hosted' },
  effective_sandbox_provider: 'self_hosted',
  packages_enforced: false,
  networking_enforced: false,
  metadata: {},
  created_at: now,
  updated_at: now,
  archived_at: null,
} as Environment;

const existingKey = {
  id: 'ewk_1',
  type: 'environment_worker_key',
  environment_id: 'env_self',
  name: 'gpu-runner-1',
  status: 'active',
  key_prefix: 'mawk_Ab...Yz',
  metadata: {},
  created_at: now,
  updated_at: now,
  last_seen_at: null,
  expires_at: null,
  revoked_at: null,
};

const createdKey = {
  ...existingKey,
  id: 'ewk_2',
  name: 'runner-2',
  key_prefix: 'mawk_Cd...Wx',
  secret_key: 'mawk_CdEfGhIjKlMnOpQrStUvWxYz0123456789',
};

function renderSelfHosted() {
  return renderConsole(<SelfHostedEnvironment environment={environment} sessions={[]} />);
}

describe('the self-hosted environment keys section', () => {
  beforeEach(() => resetApi());
  afterEach(() => resetApi());

  it('lists worker keys through the published route', async () => {
    onApiRequest(() => ({ data: [existingKey], prev_page: null, next_page: null }));
    renderSelfHosted();

    await screen.findByText('gpu-runner-1');
    expect(screen.getByText('mawk_Ab...Yz')).toBeTruthy();
    expect(apiRequests().map((r) => r.path)).toContain('/v1/environments/env_self/worker-keys');
  });

  it('creates a key and reveals the one-time secret in the modal', async () => {
    onApiRequest(({ method, path }) => {
      if (method === 'POST' && path.endsWith('/worker-keys')) return createdKey;
      return { data: [existingKey], prev_page: null, next_page: null };
    });
    const user = userEvent.setup();
    renderSelfHosted();
    await screen.findByText('gpu-runner-1');

    await user.click(screen.getByRole('button', { name: /create key/i }));
    const dialog = await screen.findByRole('dialog', { name: /create environment key/i });
    await user.type(within(dialog).getByPlaceholderText(/gpu-runner-1/i), 'runner-2');
    await user.click(within(dialog).getByRole('button', { name: /^create key$/i }));

    // The secret the API returned is revealed once — with the issued prefix —
    // and the list is re-fetched so the new row lands behind it.
    await within(dialog).findByText('mawk_CdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(within(dialog).getByText('mawk_Cd...Wx')).toBeTruthy();

    const post = apiRequests().find((r) => r.method === 'POST' && r.path === '/v1/environments/env_self/worker-keys');
    expect(post?.body).toEqual({ name: 'runner-2' });

    await user.click(within(dialog).getByRole('button', { name: /done/i }));
    await waitFor(() => expect(screen.queryByText('mawk_CdEfGhIjKlMnOpQrStUvWxYz0123456789')).toBeNull());
  });

  it('surfaces a list failure instead of pretending there are no keys', async () => {
    onApiRequest(() => new Error('keys unavailable'));
    renderSelfHosted();
    await screen.findByText('keys unavailable');
  });
});
