import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('official SDK memory official shape', () => {
  it('runs create → retrieve → preconditioned update → stale-retry conflict → delete', async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });

      const store = await client.beta.memoryStores.create({ name: 'sdk-mem-shape' });

      const memory = await client.beta.memoryStores.memories.create(store.id, {
        path: '/notes/sdk',
        content: 'v1',
      });
      expect(memory.type).toBe('memory');
      expect(memory.memory_store_id).toBe(store.id);
      expect(memory.memory_version_id).toMatch(/^memver_/);
      // Create defaults to the `basic` view: hash and size are present,
      // content is not.
      expect(memory.content).toBeNull();
      expect(memory.content_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(memory.content_size_bytes).toBeGreaterThan(0);

      const retrieved = await client.beta.memoryStores.memories.retrieve(memory.id, {
        memory_store_id: store.id,
      });
      expect(retrieved.content).toBe('v1');
      expect(retrieved.content_sha256).toBe(memory.content_sha256);

      const updated = await client.beta.memoryStores.memories.update(memory.id, {
        memory_store_id: store.id,
        content: 'v2',
        precondition: { type: 'content_sha256', content_sha256: retrieved.content_sha256 ?? undefined },
      });
      expect(updated.id).toBe(memory.id);
      expect(updated.content_sha256).not.toBe(retrieved.content_sha256);

      // Retrying the write with the now-stale hash is a published 409.
      const conflict = await client.beta.memoryStores.memories.update(memory.id, {
        memory_store_id: store.id,
        content: 'v3',
        precondition: { type: 'content_sha256', content_sha256: retrieved.content_sha256 ?? undefined },
      }).then(() => null, (error: unknown) => error);
      expect(conflict).toBeInstanceOf(Anthropic.ConflictError);
      expect((conflict as { status: number }).status).toBe(409);

      const deleted = await client.beta.memoryStores.memories.delete(memory.id, {
        memory_store_id: store.id,
      });
      expect(deleted).toEqual({ id: memory.id, type: 'memory_deleted' });
      await expect(
        client.beta.memoryStores.memories.retrieve(memory.id, { memory_store_id: store.id }),
      ).rejects.toBeInstanceOf(Anthropic.NotFoundError);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);

  it('lists versions under the published vocabulary and redacts a non-head version', async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });

      const store = await client.beta.memoryStores.create({ name: 'sdk-mem-versions' });
      const memory = await client.beta.memoryStores.memories.create(store.id, {
        path: '/notes/versioned',
        content: 'v1-secret',
      });
      await client.beta.memoryStores.memories.update(memory.id, {
        memory_store_id: store.id,
        content: 'v2-public',
      });

      const versions = await client.beta.memoryStores.memoryVersions.list(store.id, {
        memory_id: memory.id,
      });
      expect(versions.data.map((row) => row.operation)).toEqual(['modified', 'created']);
      expect(versions.data[0].type).toBe('memory_version');
      expect(versions.data[0].memory_store_id).toBe(store.id);
      expect(versions.data[0].content).toBeNull();

      const [head, first] = versions.data;
      const refused = await client.beta.memoryStores.memoryVersions.redact(head.id, {
        memory_store_id: store.id,
      }).then(() => null, (error: unknown) => error);
      expect(refused).toBeInstanceOf(Anthropic.ConflictError);

      const redacted = await client.beta.memoryStores.memoryVersions.redact(first.id, {
        memory_store_id: store.id,
      });
      expect(redacted.redacted_at).not.toBeNull();
      expect(redacted.content).toBeNull();
      expect(redacted.path).toBeNull();
      expect(redacted.content_sha256).toBeNull();

      const still = await client.beta.memoryStores.memories.retrieve(memory.id, {
        memory_store_id: store.id,
      });
      expect(still.content).toBe('v2-public');
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);
});
