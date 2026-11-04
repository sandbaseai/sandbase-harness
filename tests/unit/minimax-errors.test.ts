import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText, streamText } from 'ai';
import { ModelRegistry, miniMaxReplayScopeOf } from '@/model/registry.js';
import { DEFAULT_RETRY_POLICY } from '@/types/model.js';

const PRIVATE = 'PRIVATE-PROVIDER-REASONING';
afterEach(() => vi.unstubAllGlobals());

function setup(observer?: Parameters<ModelRegistry['createModel']>[1]) {
  const registry = new ModelRegistry();
  registry.register({ name: 'mini', model: 'MiniMax-M3', provider: 'minimax', api_key: 'test-key' });
  return registry.createModel('mini', observer);
}

describe('MiniMax provider error privacy', () => {
  it.each([false, true])('does not expose invalid response content, stream=%s', async (stream) => {
    const invalid = { id: 42, choices: [{ index: 0, message: { role: 'assistant', reasoning_content: PRIVATE }, delta: { reasoning_content: PRIVATE }, finish_reason: 'stop' }] };
    vi.stubGlobal('fetch', async () => stream
      ? new Response(`data: ${JSON.stringify(invalid)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      : Response.json(invalid));
    const model = setup();
    const errors: unknown[] = [];
    if (stream) {
      const result = streamText({ model, prompt: 'hello', maxRetries: 0, onError: ({ error }) => { errors.push(error); } });
      await result.consumeStream();
    } else {
      try { await generateText({ model, prompt: 'hello', maxRetries: 0 }); } catch (error) { errors.push(error); }
    }
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map(String).join()).not.toContain(PRIVATE);
    expect(JSON.stringify(errors)).not.toContain(PRIVATE);
    expect(errors.map(String).join()).toContain('MiniMax request');
  });

  it.each([401, 403, 404])('preserves HTTP %s classification without response body or header leakage', async (status) => {
    const fetch = vi.fn(async () => Response.json({ error: { message: PRIVATE } }, { status, headers: { 'x-secret': PRIVATE, 'retry-after': PRIVATE } }));
    vi.stubGlobal('fetch', fetch);
    const error = await generateText({ model: setup(), prompt: 'hello', maxRetries: 0 }).catch((error: unknown) => error);
    expect(error).toMatchObject({ statusCode: status });
    expect(String(error)).toBe(`Error: MiniMax request failed with HTTP ${status}`);
    expect(JSON.stringify(error)).not.toContain(PRIVATE);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(DEFAULT_RETRY_POLICY.classify(error as Error)).toBe(status === 404 ? 'unknown' : 'auth');
  });

  it('keeps safe Retry-After and status on retry observations and recovers once', async () => {
    const observations: unknown[] = [];
    const recovered = vi.fn();
    const fetch = vi.fn().mockImplementationOnce(async () => Response.json({ error: { message: PRIVATE } }, { status: 429, headers: { 'retry-after': '0', 'x-secret': PRIVATE } }))
      .mockImplementationOnce(async () => Response.json({ id: 'ok', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    vi.stubGlobal('fetch', fetch);
    await generateText({ model: setup({ retryObserver: { onRetryScheduled: (event) => observations.push(event), onRetryRecovered: recovered } }), prompt: 'hello', maxRetries: 0 });
    expect(observations).toMatchObject([{ type: 'rate_limit', attempt: 1, delayMs: 0, error: { statusCode: 429 } }]);
    expect(JSON.stringify(observations)).not.toContain(PRIVATE);
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('binds private replay to model, endpoint, credentials and request headers', () => {
    const registry = new ModelRegistry();
    const base = { name: 'mini', model: 'MiniMax-M3', provider: 'minimax' as const, api_key: 'key-a', base_url: 'https://minimax.invalid/v1' };
    const scope = miniMaxReplayScopeOf(registry.createModelFromConfig(base));
    expect(scope).toMatch(/^[0-9a-f]{64}$/);
    expect(miniMaxReplayScopeOf(registry.createModelFromConfig(base))).toBe(scope);
    for (const override of [{ model: 'MiniMax-M3.1-Flash' }, { api_key: 'key-b' }, { base_url: 'https://other.invalid/v1' }]) {
      expect(miniMaxReplayScopeOf(registry.createModelFromConfig({ ...base, ...override }))).not.toBe(scope);
    }
    expect(miniMaxReplayScopeOf(registry.createModelFromConfig(base, { headers: { 'X-Account': 'b' } }))).not.toBe(scope);
    expect(miniMaxReplayScopeOf(registry.createModelFromConfig({ ...base, provider: 'openai' }))).toBeUndefined();
  });

  it.each(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].flatMap((code) => [false, true].map((stream) => ({ code, stream }))))
    ('retries $code without revealing native error text, stream=$stream', async ({ code, stream }) => {
      const observations: unknown[] = [];
      const recovered = vi.fn();
      const nativeError = new TypeError('fetch failed', { cause: new Error(PRIVATE, { cause: Object.assign(new Error(PRIVATE), { code }) }) });
      const fetch = vi.fn().mockRejectedValueOnce(nativeError).mockImplementationOnce(async () => {
        const chunk = { id: 'ok', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, delta: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
        return stream ? new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }) : Response.json(chunk);
      });
      vi.stubGlobal('fetch', fetch);
      const options = { model: setup({ retryObserver: { onRetryScheduled: (event) => observations.push(event), onRetryRecovered: recovered } }), prompt: 'hello', maxRetries: 0 };
      if (stream) await streamText(options).consumeStream();
      else await generateText(options);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(observations).toMatchObject([{ type: 'timeout', attempt: 1, delayMs: 0 }]);
      expect(JSON.stringify(observations)).not.toContain(PRIVATE);
      expect(recovered).toHaveBeenCalledTimes(1);
    });
});
