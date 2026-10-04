/**
 * Integration test: a webhook endpoint's signing secret.
 *
 * `POST /v1/webhooks` mints one secret per subscription, returns it exactly
 * once, and stores it encrypted; delivery signs with the endpoint's own key,
 * while a subscription written before M038 keeps the legacy derivation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { decryptSecret } from '@/core/security/secrets.js';
import { signWebhookDelivery } from '@/core/operations/webhook-signature.js';
import { resolveWebhookSigningSecret } from '@/core/operations/webhook-secrets.js';

describe('Webhook endpoint signing secret', () => {
  let db: Database;
  let tmpDir: string;
  let dataDir: string;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-whsec-'));
    dataDir = join(tmpDir, 'managed-agents');
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      workspace: {
        root: tmpDir,
        dataDir,
        agentsDir: join(tmpDir, 'agents'),
        skillsDir: join(tmpDir, 'skills'),
        target: 'local',
      },
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function request(path: string, init?: RequestInit) {
    const res = await app.request(path, init);
    return { res, body: await res.json() as any };
  }

  async function createWebhook(body: Record<string, unknown> = {}) {
    return request('/v1/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/hook', events: ['session.status_idled'], ...body }),
    });
  }

  /** The stored secret triple of one webhook, as the encrypted store writes it. */
  function storedSecret(id: string, handle: Database = db) {
    return handle.prepare(
      'SELECT secret_ciphertext, secret_nonce, secret_tag FROM webhooks WHERE id = ?',
    ).get(id) as { secret_ciphertext: string | null; secret_nonce: string | null; secret_tag: string | null };
  }

  /** The stored secret, decrypted, or an empty string when none is stored. */
  function decryptStoredSecret(id: string, handle: Database = db): string {
    const stored = storedSecret(id, handle);
    if (!stored.secret_ciphertext || !stored.secret_nonce || !stored.secret_tag) return '';
    return decryptSecret({
      ciphertext: stored.secret_ciphertext,
      nonce: stored.secret_nonce,
      tag: stored.secret_tag,
    }, dataDir);
  }

  it('mints one secret per endpoint, returns it once, and stores it encrypted', async () => {
    const created = await createWebhook({ name: 'receiver' });
    expect(created.res.status).toBe(201);
    expect(created.body.secret_key).toMatch(/^whsec_/);

    // No read path returns it.
    const listed = await request('/v1/webhooks');
    expect(listed.body.data[0].secret_key).toBeUndefined();
    const read = await request(`/v1/webhooks/${created.body.id}`);
    expect(read.body.secret_key).toBeUndefined();
    const updated = await request(`/v1/webhooks/${created.body.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    expect(updated.res.status).toBe(200);
    expect(updated.body.secret_key).toBeUndefined();

    // The row holds ciphertext, and it decrypts back to the returned value.
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(created.body.id) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(created.body.secret_key);
    expect(storedSecret(created.body.id).secret_ciphertext).not.toBe(created.body.secret_key);
    expect(decryptStoredSecret(created.body.id)).toBe(created.body.secret_key);
  });

  it('mints a different secret for each subscription', async () => {
    const first = await createWebhook();
    const second = await createWebhook({ url: 'https://example.com/other' });
    expect(first.body.secret_key).not.toBe(second.body.secret_key);
  });

  it('keeps the stored secret usable from another handle on the same workspace', async () => {
    const created = await createWebhook();
    const secret = created.body.secret_key as string;

    // A second handle is what a restart looks like: the value has to be readable
    // from storage rather than kept in memory.
    const reopened = new Database(join(tmpDir, 'test.db'));
    expect(decryptStoredSecret(created.body.id, reopened)).toBe(secret);
    reopened.close();
  });

  it('signs the test delivery with the endpoint secret rather than one process-wide value', async () => {
    const created = await createWebhook();
    const secret = created.body.secret_key as string;

    const tested = await request(`/v1/webhooks/${created.body.id}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'turn_complete' }),
    });
    expect(tested.res.status).toBe(202);

    const delivery = db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ?')
      .get(created.body.id) as Record<string, string>;
    const payload = JSON.parse(delivery.payload) as { id: string; created_at: string };
    const timestamp = String(Math.floor(Date.parse(payload.created_at) / 1000));
    expect(tested.body.signature).toBe(signWebhookDelivery({ secret, id: payload.id, timestamp, body: delivery.payload }));
    // The signed value is not the one the old global derivation produced.
    expect(tested.body.signature).not.toBe(signWebhookDelivery({ secret: dataDir, id: payload.id, timestamp, body: delivery.payload }));
  });

  it('keeps a subscription written before M038 on the legacy derivation', async () => {
    db.prepare(
      `INSERT INTO webhooks (id, name, url, events, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run('wh_pre_m038', 'Legacy', 'https://example.com/legacy', JSON.stringify(['session.status_idled']));

    const stored = storedSecret('wh_pre_m038');
    expect(stored.secret_ciphertext).toBeNull();
    expect(resolveWebhookSigningSecret(stored, 'legacy-key', dataDir)).toBe('legacy-key');
  });
});
