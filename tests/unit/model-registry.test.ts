import { describe, expect, it } from 'vitest';
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

  it('does not borrow credentials from a different provider for qualified model ids', () => {
    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'anthropic',
      model: 'claude-sonnet',
      api_key: '${ANTHROPIC_API_KEY}',
      is_default: true,
    });

    const resolved = registry.resolveModelConfig('openai/gpt-5.5');

    expect(resolved).toEqual({
      name: 'openai/gpt-5.5',
      provider: 'openai',
      model: 'gpt-5.5',
    });
  });
});
