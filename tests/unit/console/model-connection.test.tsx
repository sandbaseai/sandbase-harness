// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act, apiRequests, cleanup, onApiRequest, renderConsole, resetApi, screen, userEvent,
} from './support/render';
import { ModelConnectionTest } from '../../../apps/console/src/components/pages/settings/ModelConnectionTest';

const success = {
  ok: true, outcome: 'ok', model: 'openai/example-model', resolved_model: 'example-model',
  provider: 'openai', config_source: 'saved', revision: 7, elapsed_ms: 15,
};

afterEach(() => { cleanup(); resetApi(); });

describe('Console explicit model connection test', () => {
  it('sends the entered model and saved revision only after a click and displays the tested identity', async () => {
    onApiRequest(() => success);
    const onRefresh = vi.fn();
    renderConsole(<ModelConnectionTest model=" openai/example-model " agentName="assistant" revision={7} disabled={false} onRefresh={onRefresh} />);
    expect(apiRequests()).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Test model for assistant' }));
    expect(apiRequests()).toEqual([{ method: 'POST', path: '/v1/x/settings/test-model', body: { model: 'openai/example-model', revision: 7 } }]);
    expect(screen.getByRole('status').textContent).toContain('Connected: the model returned output.');
    expect(screen.getByRole('status').textContent).toContain('openai · example-model · saved revision 7 · 15 ms');
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it.each(['authentication_failed', 'model_not_found', 'not_found', 'timeout', 'configuration_invalid', 'rate_limited',
    'network_error', 'invalid_response', 'provider_error', 'cancelled'] as const)
    ('renders a translated %s outcome without claiming the model was saved', async (code) => {
      onApiRequest(() => ({ ...success, ok: false, outcome: code }));
      renderConsole(<ModelConnectionTest model="example-model" agentName="assistant" revision={7} disabled={false} onRefresh={() => {}} />);
      await userEvent.click(screen.getByRole('button', { name: 'Test model for assistant' }));
      const status = screen.getByRole('status');
      expect(status.textContent).not.toContain('setupModels.');
      expect(status.textContent).not.toContain('Connected:');
      expect(status.textContent).toContain('example-model');
      expect(apiRequests()).toHaveLength(1);
    });

  it('blocks duplicate clicks and discards a delayed result after the model or revision changes', async () => {
    let finish!: (value: typeof success) => void;
    onApiRequest(() => new Promise((resolve) => { finish = resolve; }));
    const { rerender } = renderConsole(<ModelConnectionTest model="example-model" agentName="assistant" revision={7} disabled={false} onRefresh={() => {}} />);
    await userEvent.dblClick(screen.getByRole('button', { name: 'Test model for assistant' }));
    expect(apiRequests()).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Test model for assistant' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ModelConnectionTest model="new-model" agentName="assistant" revision={8} disabled={false} onRefresh={() => {}} />);
    await act(async () => { finish(success); });
    expect(screen.getByRole('status').textContent).toBe('');
    expect((screen.getByRole('button', { name: 'Test model for assistant' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('clears an old success when the saved configuration revision changes', async () => {
    onApiRequest(() => success);
    const { rerender } = renderConsole(<ModelConnectionTest model="example-model" agentName="assistant" revision={7} disabled={false} onRefresh={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Test model for assistant' }));
    rerender(<ModelConnectionTest model="example-model" agentName="assistant" revision={8} disabled={false} onRefresh={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe('');
    expect(apiRequests()).toHaveLength(1);
  });

  it('refreshes after a rejected request and keeps raw error text out of the UI', async () => {
    onApiRequest(() => new Error('private server error'));
    const refresh = vi.fn();
    renderConsole(<ModelConnectionTest model="example-model" agentName="assistant" revision={7} disabled={false} onRefresh={refresh} />);
    await userEvent.click(screen.getByRole('button', { name: 'Test model for assistant' }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole('status').textContent).toContain('Refresh settings');
    expect(screen.getByRole('status').textContent).not.toContain('private server error');
  });

  it.each([
    { model: '  ', revision: 7, disabled: false },
    { model: 'example-model', revision: undefined, disabled: false },
    { model: 'example-model', revision: 7, disabled: true },
  ])('cannot test while inputs are unavailable or a save is in progress', async (props) => {
    renderConsole(<ModelConnectionTest {...props} agentName="assistant" onRefresh={() => {}} />);
    const button = screen.getByRole('button', { name: 'Test model for assistant' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(button);
    expect(apiRequests()).toHaveLength(0);
  });
});
