import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('official SDK vault update/delete and credential retrieve/delete', () => {
  it('updates a vault with metadata patch semantics, then deletes it', async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });

      const created = await client.beta.vaults.create({
        display_name: 'sdk-vault',
        metadata: { keep: '1', drop: '2' },
      });

      expect(created.type).toBe('vault');
      expect((await client.beta.vaults.retrieve(created.id)).type).toBe('vault');
      const listed = await client.beta.vaults.list();
      expect(listed.data).toContainEqual(expect.objectContaining({ id: created.id, type: 'vault' }));

      const updated = await client.beta.vaults.update(created.id, {
        display_name: 'sdk-vault-renamed',
        metadata: { drop: null, added: '3' },
      });
      expect(updated.id).toBe(created.id);
      expect(updated.type).toBe('vault');
      expect(updated.display_name).toBe('sdk-vault-renamed');
      expect(updated.metadata).toEqual({ keep: '1', added: '3' });

      const deleted = await client.beta.vaults.delete(created.id);
      expect(deleted).toEqual({ id: created.id, type: 'vault_deleted' });
      await expect(client.beta.vaults.retrieve(created.id)).rejects.toBeInstanceOf(Anthropic.NotFoundError);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);

  it('retrieves and deletes a credential without exposing secret material', async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });

      const vault = await client.beta.vaults.create({ display_name: 'sdk-vault-creds' });
      const created = await client.beta.vaults.credentials.create(vault.id, {
        display_name: 'Deploy token',
        auth: {
          type: 'environment_variable',
          secret_name: 'DEPLOY_TOKEN',
          secret_value: 'conformance-secret-value',
          networking: { type: 'unrestricted' },
          injection_location: { header: true, body: false },
        },
      });

      const retrieved = await client.beta.vaults.credentials.retrieve(created.id, { vault_id: vault.id });
      expect(retrieved.id).toBe(created.id);
      expect(retrieved.vault_id).toBe(vault.id);
      expect(JSON.stringify(retrieved)).not.toContain('conformance-secret-value');

      const deleted = await client.beta.vaults.credentials.delete(created.id, { vault_id: vault.id });
      expect(deleted).toEqual({ id: created.id, type: 'vault_credential_deleted' });
      await expect(
        client.beta.vaults.credentials.retrieve(created.id, { vault_id: vault.id }),
      ).rejects.toBeInstanceOf(Anthropic.NotFoundError);

      // The enclosing vault still deletes cleanly, proving the credential row
      // was physically gone rather than hidden behind a status flag.
      const vaultDeleted = await client.beta.vaults.delete(vault.id);
      expect(vaultDeleted.type).toBe('vault_deleted');
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);
});
