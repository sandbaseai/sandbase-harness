/**
 * Integration test: the delivered signature, recomputed independently.
 *
 * `webhook-signature.ts:93-99` says verification exists because "a signature
 * format that is only ever produced is not testable: the round trip is the
 * assertion that the format is correct." But `verifyWebhookDelivery` calls
 * `signWebhookDelivery`, and `webhook-endpoint-secret.test.ts:138` compares
 * `signPayload` against `signPayload`. Both are **self-consistency** checks: if
 * the signed content lost its delivery id, or the HMAC key became the printable
 * secret string instead of its decoded bytes, signer and verifier would move
 * together and every existing assertion would stay green.
 *
 * The three properties in that module's header are claims about **another
 * implementation** — the receiver's verifier, which reads specific headers and a
 * specific signature format. So they are checked here the way a receiver checks
 * them: `node:crypto` over the bytes that actually arrived on the wire, using
 * the endpoint secret the API returned once at creation.
 *
 * The negatives carry the weight. Recomputing with the id omitted, and with the
 * printable secret as the key, must **not** reproduce the header; that is what
 * makes the two positives mean something.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

const CMA_HEADERS = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'managed-agents-2026-04-01' };

interface Delivery {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe('Webhook delivery signatures, recomputed off the wire', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;
  let receiver: ReturnType<typeof createHttpServer>;
  let secret = '';
  let delivery: Delivery | undefined;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-webhook-signature-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_one',
      'one',
      JSON.stringify({ name: 'one', model: 'gpt-4o', system: 'p' }),
    );
    app = createServer({ db, sessionManager: new SessionManager(db), agents: [], reloadAgents: () => ({ agents: [], errors: [] }), consoleRoot: null });

    const received: Delivery[] = [];
    receiver = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ headers: req.headers as Record<string, string | string[] | undefined>, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const address = receiver.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const subscribed = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: CMA_HEADERS,
      body: JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, events: ['deployment.archived'] }),
    });
    expect(subscribed.status).toBe(201);
    const subscription = (await subscribed.json()) as { secret_key: string };
    secret = subscription.secret_key;

    const created = await app.request('/v1/deployments', {
      method: 'POST',
      headers: CMA_HEADERS,
      body: JSON.stringify({ name: 'signature-check', agent_id: 'agent_one', cron: '0 20 * * 5' }),
    });
    expect(created.status).toBe(201);
    const deploymentId = ((await created.json()) as { id: string }).id;
    const archived = await app.request(`/v1/deployments/${deploymentId}/archive`, { method: 'POST', headers: CMA_HEADERS });
    expect(archived.status).toBe(200);

    for (let i = 0; i < 60 && received.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    delivery = received[0];
    expect(delivery).toBeDefined();
  }, 30000);

  afterAll(async () => {
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function header(name: string): string {
    const value = delivery?.headers[name];
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
  }

  /** The candidates a conforming receiver reads: space-separated `v1,<base64>`. */
  function candidates(): string[] {
    return header('webhook-signature').split(' ').filter(Boolean);
  }

  /** An independent Standard Webhooks signature, not `signWebhookDelivery`. */
  function recompute(key: Buffer, id: string, timestamp: string, body: string): string {
    return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
  }

  /** The HMAC key the spec prescribes: the base64 body of the secret, decoded. */
  function decodedKey(value: string): Buffer {
    return Buffer.from(value.replace(/^whsec_/, ''), 'base64');
  }

  it('carries the headers a conforming receiver reads, with a live timestamp', () => {
    expect(header('webhook-id')).not.toBe('');
    expect(header('webhook-timestamp')).toMatch(/^\d+$/);
    const seconds = Number(header('webhook-timestamp'));
    // The receiver's freshness window is five minutes; a delivery generated now
    // has to land inside it, which is also why a retry regenerates this value.
    expect(Math.abs(Date.now() / 1000 - seconds)).toBeLessThan(300);
    expect(candidates().length).toBeGreaterThan(0);
    expect(candidates().every((candidate) => /^v1,/.test(candidate))).toBe(true);
  });

  it('reproduces the delivered signature from the wire bytes and the decoded secret', () => {
    const expected = recompute(decodedKey(secret), header('webhook-id'), header('webhook-timestamp'), delivery!.body);

    expect(candidates()).toContain(expected);
  });

  it('does not reproduce it when the delivery id is left out of the signed content', () => {
    // Body-only signing round-trips through this repo's own verifier, so only an
    // independent recomputation can tell the two apart.
    const bodyOnly = `v1,${createHmac('sha256', decodedKey(secret)).update(`${header('webhook-timestamp')}.${delivery!.body}`).digest('base64')}`;

    expect(candidates()).not.toContain(bodyOnly);
  });

  it('does not reproduce it when the printable secret is used as the key', () => {
    // The spec's key is the decoded bytes. Hashing the literal string is the
    // natural mistake and would still verify against a verifier that shared it.
    const printable = recompute(Buffer.from(secret, 'utf8'), header('webhook-id'), header('webhook-timestamp'), delivery!.body);

    expect(candidates()).not.toContain(printable);
  });
});
