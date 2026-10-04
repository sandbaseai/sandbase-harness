/**
 * Integration test: webhook delivery must not follow an HTTP redirect.
 *
 * The address a delivery is sent to is chosen by the subscriber, and
 * `postWebhook` used to omit `redirect`, so Node's default (`follow`) applied. A
 * subscriber answering `302` therefore had the entire delivery — payload plus the
 * `webhook-*` signature headers, still valid for that body — re-sent to whatever
 * address the redirect named. That is a server-side-request-forgery path with a
 * signed payload attached, and the signature is what makes it worse than a bare
 * POST: a receiver that verifies `webhook-signature` accepts the replay.
 *
 * Two real loopback servers are used rather than a stub, because the claim is
 * about what `fetch` does with a `3xx`. A mocked fetch can only assert that an
 * option was passed; it cannot show that the request reaches the redirect target,
 * which is the whole defect. The second server counts requests, so "the target was
 * not contacted" is measured rather than inferred.
 *
 * The `location` header is asserted too: with `redirect: 'manual'` the response is
 * left unread by the runtime, so a future change can report *where* an endpoint
 * tried to send the delivery.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { dispatchWebhookEvent } from '@/core/operations/webhook-dispatcher.js';

describe('webhook delivery does not follow redirects', () => {
  let db: Database;
  let tmpDir: string;
  const fixedNow = new Date('2026-07-23T00:00:00.000Z');
  const servers: Server[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-whredir-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
  });

  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A loopback server that records every request it receives. */
  async function listen(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{ port: number; hits: string[] }> {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      handler(req, res);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    return { port: address.port, hits };
  }

  function subscribe(id: string, url: string) {
    db.prepare(
      `INSERT INTO webhooks (id, name, url, events, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, id, url, JSON.stringify(['session.status_idled', 'session.status_terminated']), fixedNow.toISOString(), fixedNow.toISOString());
  }

  function deliveryRow(id: string) {
    return db.prepare(
      'SELECT status, status_code, attempt_count, error, next_retry_at FROM webhook_deliveries WHERE webhook_id = ?',
    ).get(id) as {
      status: string; status_code: number | null; attempt_count: number;
      error: string | null; next_retry_at: string | null;
    };
  }

  it('records a 302 as a failure and never contacts the redirect target', async () => {
    // The internal service the redirect points at. If the delivery is followed,
    // this server sees a POST carrying the signed payload.
    const target = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    const redirector = await listen((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${target.port}/internal-admin` });
      res.end();
    });
    subscribe('wh_redir', `http://127.0.0.1:${redirector.port}/hook`);

    const results = await dispatchWebhookEvent(db, {
      type: 'session.status_idled',
      subjectId: 'sess_1',
    }, { secret: 'whsec_redir_test', now: () => fixedNow });

    // The redirector was reached once, as the configured endpoint.
    expect(redirector.hits).toEqual(['POST /hook']);
    // The redirect target was never contacted. Measured pre-fix, this server
    // received `GET /internal-admin` with an empty body but *all four* signature
    // headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`,
    // `X-Managed-Agents-Signature`) intact. A 302 is converted to a GET by the
    // fetch spec, so the payload itself is not replayed here; the request to an
    // endpoint-chosen internal address, carrying the signature headers, is the
    // exposure. The 307 case below is the one that replays the signed body.
    expect(target.hits).toEqual([]);

    // The 302 is observed rather than followed, so it is not a success. It is also
    // not a retryable failure: observing a redirect is the published auto-disable
    // condition, so this attempt is terminal and the endpoint is disabled. The
    // retry policy was left alone when the follow behaviour was fixed ("a redirect
    // is retried under the existing bounded policy, which this change deliberately
    // does not alter"); that deferral is what this now completes. The disable itself
    // is asserted in `webhook-redirect-disable.test.ts`.
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      webhook_id: 'wh_redir',
      status: 'failed',
      status_code: 302,
      attempt_count: 1,
    });
    expect(results[0].next_retry_at).toBeNull();

    expect(deliveryRow('wh_redir')).toMatchObject({
      status: 'failed',
      status_code: 302,
      attempt_count: 1,
      error: 'HTTP 302',
      next_retry_at: null,
    });
  });

  it('does not follow a 307, which would replay the POST body', async () => {
    // 307 preserves the method and body, so following it re-sends the exact signed
    // payload rather than converting it to a GET. Measured pre-fix, this target
    // received `POST /elsewhere` with the full event body and a `webhook-signature`
    // that validates it — a valid, signed delivery an internal service would accept.
    const target = await listen((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    const redirector = await listen((_req, res) => {
      res.writeHead(307, { Location: `http://127.0.0.1:${target.port}/elsewhere` });
      res.end();
    });
    subscribe('wh_307', `http://127.0.0.1:${redirector.port}/hook`);

    const results = await dispatchWebhookEvent(db, {
      type: 'session.status_terminated',
      subjectId: 'sess_1',
    }, { secret: 'whsec_redir_test', now: () => fixedNow });

    expect(target.hits).toEqual([]);
    // A 307 is a redirect like any other, so it takes the same terminal path: the
    // published rule is about the response class, not about which code it is.
    expect(results[0]).toMatchObject({ status: 'failed', status_code: 307 });
    expect(results[0].next_retry_at).toBeNull();
  });

  it('reads a successful delivery exactly as before', async () => {
    // The change must not disturb ordinary delivery: a 2xx still succeeds and is
    // not queued for retry.
    const endpoint = await listen((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    subscribe('wh_ok', `http://127.0.0.1:${endpoint.port}/hook`);

    const results = await dispatchWebhookEvent(db, {
      type: 'session.status_idled',
      subjectId: 'sess_1',
    }, { secret: 'whsec_redir_test', now: () => fixedNow });

    expect(endpoint.hits).toEqual(['POST /hook']);
    expect(results[0]).toMatchObject({
      status: 'delivered',
      status_code: 204,
      attempt_count: 1,
      next_retry_at: null,
    });
    expect(deliveryRow('wh_ok').next_retry_at).toBeNull();
  });

  it('still fails a non-redirect error response the same way', async () => {
    const endpoint = await listen((_req, res) => {
      res.writeHead(503);
      res.end('nope');
    });
    subscribe('wh_503', `http://127.0.0.1:${endpoint.port}/hook`);

    const results = await dispatchWebhookEvent(db, {
      type: 'session.status_terminated',
      subjectId: 'sess_1',
    }, { secret: 'whsec_redir_test', now: () => fixedNow });

    expect(results[0]).toMatchObject({
      status: 'pending_retry',
      status_code: 503,
      attempt_count: 1,
      error: 'HTTP 503',
    });
    expect(results[0].next_retry_at).not.toBeNull();
  });

  it('leaves the redirect location readable at the call site', async () => {
    // Not exposed in the delivery record yet, but the fix must not consume the
    // response in a way that hides where the endpoint tried to send the delivery.
    const target = await listen((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    const location = `http://127.0.0.1:${target.port}/wherever`;
    const redirector = await listen((_req, res) => {
      res.writeHead(302, { Location: location });
      res.end();
    });
    subscribe('wh_loc', `http://127.0.0.1:${redirector.port}/hook`);

    // A fetch that mirrors the runtime's own call, to assert what the call site
    // can see. `response.url` is the configured endpoint, not the target.
    const res = await fetch(`http://127.0.0.1:${redirector.port}/hook`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(location);
    expect(res.url).toBe(`http://127.0.0.1:${redirector.port}/hook`);
    expect(target.hits).toEqual([]);
  });
});