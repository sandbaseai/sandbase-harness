/**
 * Integration test: a webhook signing-secret rotation window.
 *
 * The published scheme expresses a rotation window as a space-separated
 * `webhook-signature` list. These assertions create a subscription through the
 * published route, rotate it, and check that a delivery carries both the new and
 * the previous signature until the window is retired — and that neither secret
 * comes back from a read.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { dispatchWebhookEvent } from '@/core/operations/webhook-dispatcher.js';
import { signWebhookDelivery } from '@/core/operations/webhook-signature.js';

describe('Webhook signing-secret rotation', () => {
  let db: Database;
  let tmpDir: string;
  let dataDir: string;
  let app: ReturnType<typeof createServer>;
  const fixedNow = new Date('2026-09-22T00:00:00.000Z');

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-whrot-'));
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

  async function post(path: string, body?: unknown) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { res, body: await res.json() as any };
  }

  async function get(path: string) {
    const res = await app.request(path);
    return { res, body: await res.json() as any };
  }

  async function createWebhook(url = 'https://example.com/hook') {
    const { res, body } = await post('/v1/webhooks', { url, events: ['session.status_idled'], name: url });
    expect(res.status).toBe(201);
    expect(body.secret_key).toMatch(/^whsec_/);
    return body as { id: string; secret_key: string };
  }

  /** One dispatch pass, as the repeated fetch calls it produced. */
  async function deliver() {
    const fetchImpl = vi.fn(async () => ({ status: 204 })) as unknown as typeof fetch;
    await dispatchWebhookEvent(db, { type: 'session.status_idled', subjectId: 'sess_1' }, {
      secret: 'legacy-key',
      dataDir,
      fetchImpl,
      now: () => fixedNow,
    });
    return ((fetchImpl as any).mock.calls as Array<[string, any]>).map(([url, init]) => ({
      url,
      headers: init.headers as Record<string, string>,
      body: String(init.body),
    }));
  }

  /** The signatures a delivery carried, in header order. */
  function signatures(header: string): string[] {
    return header.split(' ').filter(Boolean);
  }

  function expected(secret: string, headers: Record<string, string>, body: string): string {
    return signWebhookDelivery({
      secret,
      id: headers['webhook-id'],
      timestamp: headers['webhook-timestamp'],
      body,
    });
  }

  it('keeps the previous secret valid until it is retired', async () => {
    const created = await createWebhook();
    const previous = created.secret_key;

    const rotated = await post(`/v1/webhooks/${created.id}/rotate-secret`);
    expect(rotated.res.status).toBe(200);
    const current = rotated.body.secret_key as string;
    expect(current).toMatch(/^whsec_/);
    expect(current).not.toBe(previous);

    // The new secret is returned once and never read back; neither is the old one.
    expect(JSON.stringify(await get('/v1/webhooks'))).not.toContain(current);
    expect(JSON.stringify(await get(`/v1/webhooks/${created.id}`))).not.toContain(current);
    expect(JSON.stringify(await get(`/v1/webhooks/${created.id}`))).not.toContain(previous);

    const [first] = await deliver();
    const openWindow = signatures(first.headers['webhook-signature']);
    expect(openWindow).toHaveLength(2);
    expect(openWindow[0]).toBe(expected(current, first.headers, first.body));
    expect(openWindow[1]).toBe(expected(previous, first.headers, first.body));

    const retired = await post(`/v1/webhooks/${created.id}/retire-secret`);
    expect(retired.res.status).toBe(200);

    const [after] = await deliver();
    const closedWindow = signatures(after.headers['webhook-signature']);
    expect(closedWindow).toHaveLength(1);
    expect(closedWindow[0]).toBe(expected(current, after.headers, after.body));
    expect(closedWindow[0]).not.toBe(expected(previous, after.headers, after.body));
  });

  it('replaces the window rather than accumulating one', async () => {
    const created = await createWebhook();
    const first = created.secret_key;
    await post(`/v1/webhooks/${created.id}/rotate-secret`);
    const secondRotation = await post(`/v1/webhooks/${created.id}/rotate-secret`);
    const current = secondRotation.body.secret_key as string;

    const [delivery] = await deliver();
    const window = signatures(delivery.headers['webhook-signature']);
    expect(window).toHaveLength(2);
    expect(window[0]).toBe(expected(current, delivery.headers, delivery.body));
    // The first secret is gone: the second rotation replaced it, not appended.
    expect(window).not.toContain(expected(first, delivery.headers, delivery.body));
  });

  it('refuses an unknown subscription and mints a secret for one that had none', async () => {
    expect((await post('/v1/webhooks/wh_missing/rotate-secret')).res.status).toBe(404);
    expect((await post('/v1/webhooks/wh_missing/retire-secret')).res.status).toBe(404);

    // A subscription written before M038 holds no secret and signs with the
    // legacy derivation; rotating is the call that takes it off that derivation.
    db.prepare(
      `INSERT INTO webhooks (id, name, url, events, created_at, updated_at)
       VALUES ('wh_legacy', 'Legacy', 'https://example.com/legacy', '["session.status_idled"]', datetime('now'), datetime('now'))`,
    ).run();
    const rotated = await post('/v1/webhooks/wh_legacy/rotate-secret');
    expect(rotated.res.status).toBe(200);
    const minted = rotated.body.secret_key as string;
    expect(minted).toMatch(/^whsec_/);

    const legacyDelivery = (await deliver()).find((item) => item.url === 'https://example.com/legacy')!;
    const signed = signatures(legacyDelivery.headers['webhook-signature']);
    expect(signed).toHaveLength(1);
    expect(signed[0]).toBe(expected(minted, legacyDelivery.headers, legacyDelivery.body));
    // The legacy derivation no longer signs this endpoint.
    expect(signed[0]).not.toBe(expected('legacy-key', legacyDelivery.headers, legacyDelivery.body));
  });
});
