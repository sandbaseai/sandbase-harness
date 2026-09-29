import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MODEL_CONFIG_INVALID_CODE,
  MODEL_NOT_FOUND_CODE,
  MODEL_PROVIDER_NOT_CONFIGURED_CODE,
  ModelCredentialUnresolvedError,
  ModelRegistry,
  resolvedModelIdOf,
} from '@/model/registry.js';

/** The `code` a throwing call reports, or undefined when it does not throw. */
function codeOfThrow(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

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
    // URL/key (same protocol family), not hit api.openai.com. The model id
    // travels verbatim: a gateway addresses its models as `vendor/model`, so
    // stripping the leading token would address a model it does not serve.
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
      model: 'openai/gpt-5.6-luna',
      api_key: '${SANDBASE_API_KEY}',
      base_url: 'https://api.sandbase.ai/v1',
      is_default: false,
    });
  });

  it('classifies a missing model, a missing provider, and an unusable provider config apart', () => {
    // All three used to throw the same `ModelNotFoundError`, whose cause a
    // caller could not tell from a runtime crash. They are distinct fixes, so
    // they are distinct codes.
    const empty = new ModelRegistry();
    expect(codeOfThrow(() => empty.resolveModelConfig('gpt-4o'))).toBe(MODEL_NOT_FOUND_CODE);

    const unusable = new ModelRegistry();
    unusable.register({ name: 'default', provider: 'openai', api_key: 'k', is_default: true });
    expect(codeOfThrow(() => unusable.resolveModelConfig('default'))).toBe(MODEL_CONFIG_INVALID_CODE);
    expect(codeOfThrow(() => unusable.createModelFromConfig({ name: 'x', provider: 'openai' })))
      .toBe(MODEL_CONFIG_INVALID_CODE);

    const anthropicOnly = new ModelRegistry();
    anthropicOnly.register({ name: 'default', provider: 'anthropic', model: 'claude-sonnet', api_key: 'k', is_default: true });
    expect(codeOfThrow(() => anthropicOnly.resolveModelConfig('openai/gpt-5.5')))
      .toBe(MODEL_PROVIDER_NOT_CONFIGURED_CODE);
  });

  it('forwards any vendor namespace when the configured endpoint is a router', () => {
    // An OpenAI-compatible endpoint is the routing authority for its own model
    // ids: a router serves `anthropic/...` and `deepseek/...` side by side, so
    // refusing one of them would break the gateway shapes this resolution
    // exists to support. Only a first-party vendor API, which cannot serve
    // another vendor's namespaced id at all, refuses.
    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'openai_compatible',
      api_key: 'k',
      base_url: 'https://router.invalid/v1',
      is_default: true,
    });

    expect(registry.resolveModelConfig('anthropic/claude-sonnet-4')).toMatchObject({
      provider: 'openai_compatible',
      model: 'anthropic/claude-sonnet-4',
      base_url: 'https://router.invalid/v1',
    });
  });
});

// Guards the wiring, not just the config object: asserting only that
// resolveModelConfig keeps the field would pass even if it never reached the model.
describe('ModelRegistry qualified model reference on the wire', () => {
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

  function gatewayRegistry(): ModelRegistry {
    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'openai_compatible',
      api_key: 'test-key',
      base_url: 'https://gateway.invalid/v1',
      is_default: true,
    });
    return registry;
  }

  const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }];

  it('sends a vendor-namespaced model id to the provider unchanged', async () => {
    // `https://api.sandbase.ai/v1` (like every OpenRouter-shaped gateway)
    // addresses models as `vendor/model`. Reading `deepseek` as a provider
    // prefix truncated this to `deepseek-v4-flash`, an id no endpoint serves,
    // so nothing on that endpoint could be addressed at all. The assertion is
    // on the request body: a response-shaped assertion passes even when the
    // provider was asked for the wrong model.
    const fetchStub = stubFetch();

    await (gatewayRegistry().createModel('deepseek/deepseek-v4-flash') as any).doGenerate({ prompt });

    expect(fetchStub.body()['model']).toBe('deepseek/deepseek-v4-flash');
    expect(fetchStub.url()).toBe('https://gateway.invalid/v1/chat/completions');
  });

  it('sends an unqualified model id to the provider unchanged', async () => {
    const fetchStub = stubFetch();

    await (gatewayRegistry().createModel('deepseek-v4-flash') as any).doGenerate({ prompt });

    expect(fetchStub.body()['model']).toBe('deepseek-v4-flash');
  });

  it('still reads a registered provider prefix as a provider selector', async () => {
    const registry = gatewayRegistry();
    registry.register({
      name: 'openai',
      provider: 'openai',
      api_key: 'openai-key',
      base_url: 'https://api.openai.invalid/v1',
    });
    const fetchStub = stubFetch();

    await (registry.createModel('openai/gpt-5.5') as any).doGenerate({ prompt });

    // The prefix selected the provider, so the model id it is addressed with is
    // the part after the prefix — and it went to that provider's endpoint.
    expect(fetchStub.body()['model']).toBe('gpt-5.5');
    expect(fetchStub.url()).toBe('https://api.openai.invalid/v1/chat/completions');
  });

  it('records the id the provider was asked for, not the agent reference', () => {
    // `model_used` and the usage records projected from it must name a model
    // that exists upstream; recording the agent's reference verbatim would
    // attribute spend to an id the endpoint never served.
    const registry = gatewayRegistry();

    expect(resolvedModelIdOf(registry.createModel('deepseek/deepseek-v4-flash')))
      .toBe('deepseek/deepseek-v4-flash');
    expect(resolvedModelIdOf(registry.createModel('deepseek-v4-flash')))
      .toBe('deepseek-v4-flash');
  });

  it('keeps two resolved models apart when both are alive at once', () => {
    // The readback above creates a model and reads it in the same statement, so it
    // would still pass if the registry kept one "last resolved" id: each assertion
    // sees its own write. `registry.ts:172-176` says why that is not enough - "one
    // registry serves concurrent sessions, and a single 'last resolved' field would
    // report whichever turn resolved most recently" - and concurrent sessions means
    // two instances held at the same time. Creating both before reading either is
    // what makes the difference observable.
    const registry = gatewayRegistry();
    const qualified = registry.createModel('deepseek/deepseek-v4-flash');
    const bare = registry.createModel('deepseek-v4-flash');

    expect(resolvedModelIdOf(qualified)).toBe('deepseek/deepseek-v4-flash');
    expect(resolvedModelIdOf(bare)).toBe('deepseek-v4-flash');
    // Reading one must not disturb the other, in either order.
    expect(resolvedModelIdOf(qualified)).toBe('deepseek/deepseek-v4-flash');
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

/**
 * A `${VAR}` reference is the difference between "the operator pasted a key" and
 * "the operator pasted a variable name". `init` writes the second into
 * `config.yaml`, so this is the ordinary first-run shape, and leaving the
 * placeholder in place sent `${OPENAI_API_KEY}` to the provider as the credential.
 */
describe('ModelRegistry unresolved environment references', () => {
  const KEY_VAR = 'SANDBASE_TEST_CONFORMANCE_KEY';
  const URL_VAR = 'SANDBASE_TEST_CONFORMANCE_URL';

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function registryWith(fields: Partial<{ api_key: string; base_url: string }>): ModelRegistry {
    const registry = new ModelRegistry();
    registry.register({
      name: 'deepseek',
      provider: 'openai_compatible',
      api_key: fields.api_key,
      base_url: fields.base_url ?? 'https://api.deepseek.invalid/v1',
      is_default: true,
    });
    return registry;
  }

  it('refuses the turn instead of sending the placeholder, naming variable and field', () => {
    const registry = registryWith({ api_key: `\${${KEY_VAR}}` });

    let thrown: unknown;
    try {
      registry.createModel('deepseek-chat');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ModelCredentialUnresolvedError);
    const error = thrown as ModelCredentialUnresolvedError;
    // The three facts a provider's 401 cannot give: which variable, which field,
    // and which provider configuration to edit.
    expect(error.variable).toBe(KEY_VAR);
    expect(error.field).toBe('api_key');
    expect(error.provider).toBe('openai_compatible');
    // The code is the existing configuration one, so a client that already
    // renders `model_config_invalid` needs no new case and the session stays
    // resumable.
    expect(error.code).toBe(MODEL_CONFIG_INVALID_CODE);
    expect(error.message).toContain(KEY_VAR);
    expect(error.message).toContain('api_key');
    expect(error.message).toContain('Dashboard Settings > Setup');
    expect(error.message).toContain('is not set in the runtime');
  });

  it('refuses a variable that is set to the empty string, the same way the settings layer reads it', () => {
    // `KEY=""` resolves, so a lenient reading builds a client that sends an empty
    // credential and the provider's `401` names nothing. The settings layer
    // already calls this state `missing_env` (`src/core/settings/schema.ts`), and
    // a runtime that acted on the empty value instead would contradict the Console.
    vi.stubEnv(KEY_VAR, '');

    let thrown: unknown;
    try {
      registryWith({ api_key: `\${${KEY_VAR}}` }).createModel('deepseek-chat');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ModelCredentialUnresolvedError);
    const error = thrown as ModelCredentialUnresolvedError;
    expect(error.variable).toBe(KEY_VAR);
    expect(error.code).toBe(MODEL_CONFIG_INVALID_CODE);
    expect(error.message).toContain('is set to an empty value');
  });

  it('names the endpoint field when the unset reference is the base URL', () => {
    const registry = registryWith({ api_key: 'literal-key', base_url: `\${${URL_VAR}}` });

    expect(() => registry.createModel('deepseek-chat')).toThrow(ModelCredentialUnresolvedError);
    try {
      registry.createModel('deepseek-chat');
    } catch (error) {
      expect((error as ModelCredentialUnresolvedError).field).toBe('base_url');
      expect((error as Error).message).toContain(URL_VAR);
    }
  });

  it('sends the resolved value, not the reference, once the variable is set', async () => {
    vi.stubEnv(KEY_VAR, 'resolved-key-value');
    let authorization = '';
    vi.stubGlobal('fetch', async (_url: unknown, init: { headers?: Record<string, string> }) => {
      authorization = init?.headers?.authorization ?? init?.headers?.Authorization ?? '';
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

    const registry = registryWith({ api_key: `\${${KEY_VAR}}` });
    const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }];
    await (registry.createModel('deepseek-chat') as any).doGenerate({ prompt });

    expect(authorization).toBe('Bearer resolved-key-value');
    expect(authorization).not.toContain('${');
  });

  it('still reports the unresolved reference through runtime introspection', () => {
    // The read path stays lenient on purpose: a Console cannot tell an operator
    // which variable to set if reading the configuration is what fails.
    const info = registryWith({ api_key: `\${${KEY_VAR}}` }).listRuntimeInfo();

    expect(info[0]?.api_key_state).toBe('missing_env');
    expect(info[0]?.api_key_state).not.toBe('configured');
  });

  it('reports a variable that is set to the empty string as missing, like the strict path does', () => {
    // Reading and writing have to agree here, or the Console would show a key as
    // configured while every turn is refused for not having one.
    vi.stubEnv(KEY_VAR, '');
    const info = registryWith({ api_key: `\${${KEY_VAR}}` }).listRuntimeInfo();

    expect(info[0]?.api_key_state).toBe('missing_env');
    expect(info[0]?.base_url_state).toBe('configured');
  });

  it('builds a provider that has no credential at all, which is not a missing variable', () => {
    // An endpoint that needs no key (a local gateway, a test double) configures
    // none, and strictness must not turn "absent" into "unresolved": the resolver
    // itself rejects `undefined`, so the guard in front of it is what keeps this
    // case working, and it is pinned here rather than assumed.
    const registry = registryWith({});

    expect(() => registry.createModel('deepseek-chat')).not.toThrow();
  });
});
