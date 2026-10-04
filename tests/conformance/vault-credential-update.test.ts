import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('official SDK credential update', () => {
  it('applies the published partial update and never echoes secret material', async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });

      const vault = await client.beta.vaults.create({ display_name: 'sdk-vault-update' });
      const created = await client.beta.vaults.credentials.create(vault.id, {
        display_name: 'Deploy token',
        auth: {
          type: 'environment_variable',
          secret_name: 'DEPLOY_TOKEN',
          secret_value: 'conformance-secret-value',
          networking: { type: 'unrestricted' },
          injection_location: { header: true, body: true },
        },
      });

      const updated = await client.beta.vaults.credentials.update(created.id, {
        vault_id: vault.id,
        display_name: 'Rotated deploy token',
        metadata: { rotated: 'yes' },
        auth: {
          type: 'environment_variable',
          secret_value: 'conformance-rotated-secret',
          injection_location: { header: true },
        },
      });

      expect(updated.id).toBe(created.id);
      expect(updated.display_name).toBe('Rotated deploy token');
      expect(JSON.stringify(updated)).not.toContain('conformance-rotated-secret');
      const auth = updated.auth as { type: string; injection_location?: { header: boolean; body: boolean } };
      expect(auth.injection_location).toEqual({ header: true, body: false });

      // A type mismatch is refused: `auth.type` is immutable.
      await expect(
        client.beta.vaults.credentials.update(created.id, {
          vault_id: vault.id,
          auth: { type: 'static_bearer', token: 'nope' },
        }),
      ).rejects.toBeInstanceOf(Anthropic.BadRequestError);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);
});
