import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText, jsonSchema, stepCountIs, streamText, tool } from 'ai';
import { ModelRegistry } from '@/model/registry.js';

const REASONING = 'PRIVATE-REASONING-ROUNDTRIP';
const models = ['MiniMax-M3', 'MiniMax-M3.1-Flash'];

afterEach(() => vi.unstubAllGlobals());

function provider(modelId: string, reasoning: boolean) {
  const requests: any[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const first = requests.length === 1;
    const toolCalls = [{ id: 'call_lookup', type: 'function', function: { name: 'lookup', arguments: '{"city":"Paris"}' } }];
    const message = first
      ? { role: 'assistant', content: null, ...(reasoning ? { reasoning_content: REASONING } : {}), tool_calls: toolCalls }
      : { role: 'assistant', content: 'sunny' };
    const envelope = { id: 'reply', model: modelId, created: 0 };
    const usage = { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } };
    if (!body.stream) return Response.json({ ...envelope, choices: [{ index: 0, message, finish_reason: first ? 'tool_calls' : 'stop' }], usage });
    const chunks: unknown[] = [];
    if (first && reasoning) {
      for (const piece of ['PRIVATE-', 'REASONING-ROUNDTRIP']) chunks.push({ ...envelope, choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }] });
    }
    chunks.push({ ...envelope, choices: [{ index: 0, delta: first ? { tool_calls: toolCalls.map((call) => ({ index: 0, ...call })) } : { content: 'sunny' }, finish_reason: null }] });
    chunks.push({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }], usage });
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const registry = new ModelRegistry();
  registry.register({ name: 'minimax', provider: 'minimax', model: modelId, api_key: 'test-key', base_url: 'https://minimax.invalid/v1' });
  return { model: registry.createModel('minimax'), requests };
}

const tools = { lookup: tool({ inputSchema: jsonSchema<{ city: string }>({ type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false }), execute: async () => 'sunny' }) };

describe('MiniMax reasoning in provider tool history', () => {
  it.each(models.flatMap((modelId) => [false, true].flatMap((stream) => [false, true].map((reasoning) => ({ modelId, stream, reasoning })))))
   ('$modelId stream=$stream reasoning=$reasoning', async ({ modelId, stream, reasoning }) => {
      const { model, requests } = provider(modelId, reasoning);
      const options = { model, messages: [{ role: 'user' as const, content: 'weather in Paris' }], tools, stopWhen: stepCountIs(3), maxRetries: 0 };
      const result = stream ? streamText(options) : await generateText(options);
      if ('consumeStream' in result) await result.consumeStream();
      expect(await result.text).toBe('sunny');
      expect(requests).toHaveLength(2);
      const history = requests[1].messages.find((message: any) => message.role === 'assistant');
      if (reasoning) expect(history.reasoning_content).toBe(REASONING);
      else expect(history).not.toHaveProperty('reasoning_content');
      expect(history.tool_calls).toMatchObject([{ id: 'call_lookup', function: { name: 'lookup', arguments: '{"city":"Paris"}' } }]);
      expect(requests[1].messages.find((message: any) => message.role === 'tool')).toMatchObject({ tool_call_id: 'call_lookup', content: 'sunny' });
      expect((await result.steps).map((step) => step.usage.inputTokens)).toEqual([10, 10]);
      // Continuing with the caller-owned SDK history preserves earlier metadata.
      const responseMessages = await result.responseMessages;
      await generateText({ model, messages: [...options.messages, ...responseMessages, { role: 'user', content: 'and tomorrow?' }], maxRetries: 0 });
      const next = requests[2].messages.find((message: any) => message.role === 'assistant');
      if (reasoning) expect(next.reasoning_content).toBe(REASONING);
      expect(requests.every((request) => request.model === modelId)).toBe(true);
      if (stream) expect(requests[0].stream_options).toEqual({ include_usage: true });
    });
});
