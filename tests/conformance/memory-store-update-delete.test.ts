import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('official SDK memory store update and delete', () => {
  it('updates a store with patch semantics, then deletes it', async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });

      const created = await client.beta.memoryStores.create({
        name: 'sdk-store',
        description: 'before',
        metadata: { keep: '1', drop: '2' },
      });

      const updated = await client.beta.memoryStores.update(created.id, {
        name: 'sdk-store-renamed',
        description: '',
        metadata: { drop: null, added: '3' },
      });
      expect(updated.id).toBe(created.id);
      expect(updated.name).toBe('sdk-store-renamed');
      expect(updated.description).toBe('');
      expect(updated.metadata).toEqual({ keep: '1', added: '3' });

      const deleted = await client.beta.memoryStores.delete(created.id);
      expect(deleted).toEqual({ id: created.id, type: 'memory_store_deleted' });
      await expect(client.beta.memoryStores.retrieve(created.id)).rejects.toBeInstanceOf(Anthropic.NotFoundError);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);

  it('refuses an update on an archived store through the official client', async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });
      const created = await client.beta.memoryStores.create({ name: 'sdk-archived' });
      await client.beta.memoryStores.archive(created.id);

      const error = await client.beta.memoryStores.update(created.id, { name: 'still-readonly' }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(Anthropic.ConflictError);
      expect((error as { status: number }).status).toBe(409);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);
});
