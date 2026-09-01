import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRegistry } from '@/model/registry.js';

describe('ModelRegistry runtime introspection', () => {
  it('returns safe model metadata without secrets', () => {
    const registry = new ModelRegistry();
    registry.register({
      name: 'configured',
      provider: 'openai',
      model: 'gpt-4o',
      api_key: 'secret-value',
      base_url: '${MISSING_BASE_URL}',
    });

    const models = registry.listRuntimeInfo();

    expect(models).toEqual([{
      name: 'configured',
      provider: 'openai',
      model: 'gpt-4o',
      api_key_state: 'configured',
      base_url_state: 'missing_env',
      is_default: true,
    }]);
    expect(JSON.stringify(models)).not.toContain('secret-value');
    expect(JSON.stringify(models)).not.toContain('MISSING_BASE_URL');
  });

  it('uses user-provided qualified model ids with matching provider settings', () => {
    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'openai',
      model: 'gpt-4o',
      api_key: '${OPENAI_API_KEY}',
      base_url: 'https://api.openai.com/v1',
      is_default: true,
    });

    const resolved = registry.resolveModelConfig('openai/gpt-5.5');

    expect(resolved).toMatchObject({
      name: 'openai/gpt-5.5',
      provider: 'openai',
      model: 'gpt-5.5',
      api_key: '${OPENAI_API_KEY}',
      base_url: 'https://api.openai.com/v1',
      is_default: false,
    });
  });

  it('preserves provider reasoning effort for resolved model ids', () => {
    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'openai_compatible',
      api_key: '${DEEPSEEK_API_KEY}',
      base_url: 'https://api.deepseek.com/v1',
      reasoning_effort: 'max',
      is_default: true,
    });

    expect(registry.resolveModelConfig('deepseek-v4-pro')).toMatchObject({
      model: 'deepseek-v4-pro',
      reasoning_effort: 'max',
    });
  });

  it('uses the default provider settings for unqualified user model ids', () => {
    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'openai',
      model: 'gpt-4o',
      api_key: '${OPENAI_API_KEY}',
      is_default: true,
    });

    const resolved = registry.resolveModelConfig('gpt-4.1');

    expect(resolved).toMatchObject({
      name: 'gpt-4.1',
      provider: 'openai',
      model: 'gpt-4.1',
      api_key: '${OPENAI_API_KEY}',
      is_default: false,
    });
  });

  it('rejects a qualified model id whose provider is unrelated and unconfigured', () => {
    // Previously this returned a bare {provider:'openai'} config with no base
    // URL/key, which silently sent the request to OpenAI's public endpoint even
    // though only Anthropic was configured. Now it fails loud instead of
    // leaking traffic to an unconfigured vendor.
    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'anthropic',
      model: 'claude-sonnet',
      api_key: '${ANTHROPIC_API_KEY}',
      is_default: true,
    });

    expect(() => registry.resolveModelConfig('openai/gpt-5.5')).toThrow(/not configured/);
  });

  it('reuses the default provider endpoint for a same-family qualified model id', () => {
    // An agent references `openai/...` while the configured provider is an
    // openai_compatible gateway. The request must stay on the configured base
    // URL/key (same protocol family), not hit api.openai.com.
    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'openai_compatible',
      api_key: '${SANDBASE_API_KEY}',
      base_url: 'https://api.sandbase.ai/v1',
      is_default: true,
    });

    const resolved = registry.resolveModelConfig('openai/gpt-5.6-luna');

    expect(resolved).toMatchObject({
      name: 'openai/gpt-5.6-luna',
      provider: 'openai_compatible',
      model: 'gpt-5.6-luna',
      api_key: '${SANDBASE_API_KEY}',
      base_url: 'https://api.sandbase.ai/v1',
      is_default: false,
    });
  });
});

// Guards the wiring, not just the config object: asserting only that
// resolveModelConfig keeps the field would pass even if it never reached the model.
describe('ModelRegistry reasoning effort wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Capture the request the provider would send. */
  function stubFetch(): { body: () => Record<string, unknown>; url: () => string } {
    let captured: Record<string, unknown> = {};
    let url = '';
    vi.stubGlobal('fetch', async (requestUrl: unknown, init: { body?: string }) => {
      url = String(requestUrl);
      captured = JSON.parse(init?.body ?? '{}');
      return new Response(
        JSON.stringify({
          id: 'x',
          created: 0,
          model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    return { body: () => captured, url: () => url };
  }

  const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }];

  it('sends the configured reasoning effort to the provider', async () => {
    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'openai_compatible',
      api_key: 'test-key',
      base_url: 'https://example.invalid/v1',
      reasoning_effort: 'high',
      is_default: true,
    });

    const fetchStub = stubFetch();
    await (registry.createModel('deepseek-v4-pro') as any).doGenerate({ prompt });

    expect(fetchStub.body()).toMatchObject({ reasoning_effort: 'high' });
  });

  it('omits reasoning effort when none is configured', async () => {
    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'openai_compatible',
      api_key: 'test-key',
      base_url: 'https://example.invalid/v1',
      is_default: true,
    });

    const fetchStub = stubFetch();
    await (registry.createModel('deepseek-v4-pro') as any).doGenerate({ prompt });

    expect(fetchStub.body()).not.toHaveProperty('reasoning_effort');
  });

  // DeepSeek/Ollama/vLLM/minimax implement /chat/completions but not /responses.
  it('targets the chat completions endpoint for OpenAI-compatible providers', async () => {
    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'openai_compatible',
      api_key: 'test-key',
      base_url: 'https://example.invalid/v1',
      is_default: true,
    });

    const fetchStub = stubFetch();
    await (registry.createModel('deepseek-v4-pro') as any).doGenerate({ prompt });

    expect(fetchStub.url()).toBe('https://example.invalid/v1/chat/completions');
  });
});
