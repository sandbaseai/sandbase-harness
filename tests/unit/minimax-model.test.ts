import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '@/core/db/database.js';
import { MINIMAX_MODELS } from '@/core/model/minimax.js';
import { describeSettingsAdapters } from '@/core/settings/adapters.js';
import { runtimeSettingsSchema } from '@/core/settings/schema.js';
import { getOrSeedRuntimeSettings, modelConfigFromRuntimeSettings } from '@/core/settings/store.js';
import { ModelRegistry } from '@/model/registry.js';

type CurrentModel = Extract<ReturnType<ModelRegistry['createModel']>, { specificationVersion: 'v4' }>;

const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }];

describe('MiniMax settings to SDK requests', () => {
  let directory: string;
  let db: Database;
  let requests: Array<{ url: string; body: Record<string, any> }>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ma-minimax-'));
    db = new Database(join(directory, 'settings.db'));
    db.runMigrations();
    requests = [];
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push({ url: String(url), body });
      const completion = {
        id: 'completion', created: 0, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
      if (body.stream) {
        return new Response(`data: ${JSON.stringify({
          id: 'completion', created: 0, model: body.model,
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify(completion), { headers: { 'content-type': 'application/json' } });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function model(options: Record<string, unknown> = {}, baseUrl?: string, reference = 'default') {
    const settings = runtimeSettingsSchema.parse({
      ...getOrSeedRuntimeSettings(db).effective_config,
      model: { vendor: 'minimax', api_key: 'test-key', base_url: baseUrl, options },
    });
    const registry = new ModelRegistry();
    registry.register(modelConfigFromRuntimeSettings(db, settings, directory));
    return registry.createModel(reference) as CurrentModel;
  }

  it('offers only Flash first and M3 while reporting Flash capabilities', () => {
    expect(MINIMAX_MODELS.map((entry) => entry.model_id)).toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M3']);
    expect(MINIMAX_MODELS[0]).toMatchObject({
      context_window: 1_000_000,
      max_output_tokens: 524_288,
      thinking: ['adaptive'],
      pricing_usd_per_million_tokens: { input: 0.15, output: 0.6, cache_read: 0.015, cache_write: null },
    });
    expect(describeSettingsAdapters().model.find((entry) => entry.id === 'minimax')?.options_schema).toMatchObject({
      properties: { model: { default: 'MiniMax-M3.1-Flash', enum: ['MiniMax-M3.1-Flash', 'MiniMax-M3'] } },
    });
  });

  it.each([
    ['global_en', 'https://api.minimax.io/v1/chat/completions'],
    ['cn_zh', 'https://api.minimaxi.com/v1/chat/completions'],
  ])('sends the default from %s settings without unsupported controls', async (region, url) => {
    await model({ region }).doGenerate({ prompt });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(url);
    expect(requests[0].body.model).toBe('MiniMax-M3.1-Flash');
    for (const field of ['thinking', 'reasoning_effort', 'reasoning_split', 'service_tier']) {
      expect(requests[0].body).not.toHaveProperty(field);
    }
  });

  it.each(['MiniMax-M3', 'MiniMax-M2.7', 'saved-custom-model'])('preserves saved model %s', async (id) => {
    await model({ model: id }).doGenerate({ prompt });
    expect(requests[0].body.model).toBe(id);
  });

  it.each(['MiniMax-M2.7', 'saved-custom-model'])('preserves a legacy database model %s during settings import', async (id) => {
    db.prepare(`INSERT INTO models (name, provider, model, api_key, config, is_default)
      VALUES ('default', 'minimax', ?, 'test-key', '{}', 1)`).run(id);
    const settings = getOrSeedRuntimeSettings(db, {}, directory).effective_config;
    const registry = new ModelRegistry();
    registry.register(modelConfigFromRuntimeSettings(db, settings, directory));
    await (registry.createModel('default') as CurrentModel).doGenerate({ prompt });
    expect(requests[0].body.model).toBe(id);
  });

  it('preserves explicit agent references and endpoint overrides', async () => {
    await model({ region: 'cn_zh' }, 'https://gateway.invalid/v1', 'minimax/custom-id').doGenerate({ prompt });
    expect(requests[0]).toMatchObject({ url: 'https://gateway.invalid/v1/chat/completions', body: { model: 'custom-id' } });
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('serializes Flash effort %s', async (effort) => {
    await model({ reasoning_effort: effort }).doGenerate({ prompt });
    expect(requests[0].body.reasoning_effort).toBe(effort);
  });

  it('rejects unsupported Flash effort before sending a request', () => {
    expect(() => model({ reasoning_effort: 'none' })).toThrow(/effort/);
    expect(requests).toHaveLength(0);
  });

  it.each(['MiniMax-M3', 'MiniMax-M2.7', 'saved-custom-model'])('keeps effort omitted for %s', async (id) => {
    await model({ model: id, reasoning_effort: 'high' }).doGenerate({ prompt });
    expect(requests[0].body).not.toHaveProperty('reasoning_effort');
  });

  it('keeps image and tool payloads while streaming with Flash', async () => {
    const result = await model({ reasoning_effort: 'max' }).doStream({
      prompt: [{ role: 'user', content: [
        { type: 'text', text: 'describe' },
        { type: 'file', data: { type: 'url', url: new URL('https://example.invalid/image.png') }, mediaType: 'image/png' },
      ] }],
      tools: [{ type: 'function', name: 'lookup', description: 'Look up an item', inputSchema: { type: 'object', properties: {} } }],
    });
    for await (const _part of result.stream) { /* Consume the mocked SDK stream. */ }
    expect(requests[0].body).toMatchObject({
      model: 'MiniMax-M3.1-Flash', stream: true, reasoning_effort: 'max',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'describe' },
        { type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } },
      ] }],
      tools: [{ type: 'function', function: { name: 'lookup' } }],
    });
  });
});
