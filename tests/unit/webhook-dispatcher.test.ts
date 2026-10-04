import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import {
  DEFAULT_SUSTAINED_FAILURE_WINDOW_SECONDS,
  WEBHOOK_SUSTAINED_FAILURE_WINDOW_ENV,
  dispatchWebhookEvent,
  resolveWebhookSustainedFailureWindow,
  retryDueWebhookDeliveries,
} from '@/core/operations/webhook-dispatcher.js';
import { mintAndStoreWebhookSecret } from '@/core/operations/webhook-secrets.js';
import { signWebhookDelivery } from '@/core/operations/webhook-signature.js';

/**
 * The sustained-failure window is the one number in the webhook auto-disable rules the
 * published contract does not state, so it is a local policy with a default and a
 * deployment switch. Nothing else in this file touches it; these cases pin the switch's
 * contract on its own, including the states that must *not* silently become a policy.
 */
describe('webhook sustained-failure window switch', () => {
  it('defaults to ten minutes when the deployment has not set a window', () => {
    expect(DEFAULT_SUSTAINED_FAILURE_WINDOW_SECONDS).toBe(600);
    expect(resolveWebhookSustainedFailureWindow({})).toEqual({ seconds: 600, source: 'default' });
    expect(resolveWebhookSustainedFailureWindow({ [WEBHOOK_SUSTAINED_FAILURE_WINDOW_ENV]: '' }))
      .toEqual({ seconds: 600, source: 'default' });
    expect(resolveWebhookSustainedFailureWindow({ [WEBHOOK_SUSTAINED_FAILURE_WINDOW_ENV]: '   ' }))
      .toEqual({ seconds: 600, source: 'default' });
  });

  it('takes a whole number of seconds from the deployment', () => {
    expect(resolveWebhookSustainedFailureWindow({ [WEBHOOK_SUSTAINED_FAILURE_WINDOW_ENV]: '3600' }))
      .toEqual({ seconds: 3600, source: 'deployment' });
    // The bounds are inclusive; they exist to catch a typo, not to express a policy.
    expect(resolveWebhookSustainedFailureWindow({ [WEBHOOK_SUSTAINED_FAILURE_WINDOW_ENV]: '1' }))
      .toEqual({ seconds: 1, source: 'deployment' });
    expect(resolveWebhookSustainedFailureWindow({ [WEBHOOK_SUSTAINED_FAILURE_WINDOW_ENV]: '2592000' }))
      .toEqual({ seconds: 2_592_000, source: 'deployment' });
    expect(resolveWebhookSustainedFailureWindow({ [WEBHOOK_SUSTAINED_FAILURE_WINDOW_ENV]: ' 3600 ' }))
      .toEqual({ seconds: 3600, source: 'deployment' });
  });

  it('refuses a value it cannot honour rather than clamping it into a policy', () => {
    for (const configured of ['0', '-5', '1.5', 'soon', '600s', '2592001', 'Infinity']) {
      expect(resolveWebhookSustainedFailureWindow({ [WEBHOOK_SUSTAINED_FAILURE_WINDOW_ENV]: configured }))
        .toEqual({ seconds: 600, source: 'unusable' });
    }
    // A window of zero would disable an endpoint on its very first failure, which is the one
    // outcome clamping would produce, so the parsed value is refused instead.
  });
});

describe('webhook dispatcher', () => {
  let db: Database;
  let tmpDir: string;
  const fixedNow = new Date('2026-07-23T00:00:00.000Z');

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-whd-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dispatches matching webhooks and stores signed delivered records', async () => {
    db.prepare(
      `INSERT INTO webhooks (id, name, url, events, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('wh_ok', 'OK', 'https://example.com/hook', JSON.stringify(['session.status_running']), fixedNow.toISOString(), fixedNow.toISOString());
    const fetchImpl = vi.fn(async () => ({ status: 204 })) as unknown as typeof fetch;

    const results = await dispatchWebhookEvent(db, {
      type: 'session.status_running',
      subjectId: 'sess_1',
    }, { secret: 'secret', fetchImpl, now: () => fixedNow });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = (fetchImpl as any).mock.calls[0];
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    // The published BetaWebhookEvent envelope: the body is exactly
    // {type, id, created_at, data}, and data is a reference — the receiver
    // fetches current state by data.type/data.id.
    expect(Object.keys(body).sort()).toEqual(['created_at', 'data', 'id', 'type']);
    expect(body.type).toBe('event');
    expect(body.id).toMatch(/^whe_/);
    expect(Object.keys(body.data).sort()).toEqual(['id', 'organization_id', 'type', 'workspace_id']);
    expect(body.data).toMatchObject({
      type: 'session.status_running',
      id: 'sess_1',
      organization_id: 'org_local',
      workspace_id: 'wrkspc_local',
    });
    expect(init.headers['X-Managed-Agents-Signature']).toBeUndefined();
    expect(init.headers['x-sandbase-webhook-endpoint-id']).toBe('wh_ok');
    expect(results[0]).toMatchObject({
      webhook_id: 'wh_ok',
      status: 'delivered',
      status_code: 204,
      attempt_count: 1,
      next_retry_at: null,
    });
  });

  it('sends the published Standard Webhooks v1 headers', async () => {
    db.prepare(
      `INSERT INTO webhooks (id, name, url, events, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('wh_hdr', 'HDR', 'https://example.com/hook', JSON.stringify(['session.status_idled']), fixedNow.toISOString(), fixedNow.toISOString());
    const fetchImpl = vi.fn(async () => ({ status: 204 })) as unknown as typeof fetch;

    await dispatchWebhookEvent(db, {
      type: 'session.status_idled',
      subjectId: 'sess_1',
      id: 'whe_fixed',
    }, { secret: 'whsec_secret_value', fetchImpl, now: () => fixedNow });

    const [, init] = (fetchImpl as any).mock.calls[0];
    const headers = init.headers as Record<string, string>;
    // The published set, keyed by the event id — `webhook-id` is the id inside
    // the body, which is what a receiver deduplicates on.
    expect(headers['webhook-id']).toBe('whe_fixed');
    expect(headers['webhook-timestamp']).toBe(String(Math.floor(fixedNow.getTime() / 1000)));
    expect(headers['webhook-signature']).toMatch(/^v1,/);

    // The signature really does cover id.timestamp.body.
    const expected = signWebhookDelivery({
      secret: 'whsec_secret_value',
      id: headers['webhook-id'],
      timestamp: headers['webhook-timestamp'],
      body: String(init.body),
    });
    expect(headers['webhook-signature']).toBe(expected);
  });

  it('queues failed deliveries for retry and later marks them delivered', async () => {
    db.prepare(
      `INSERT INTO webhooks (id, name, url, events, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('wh_retry', 'Retry', 'https://example.com/retry', JSON.stringify(['turn_complete']), fixedNow.toISOString(), fixedNow.toISOString());
    const failingFetch = vi.fn(async () => ({ status: 503 })) as unknown as typeof fetch;

    const first = await dispatchWebhookEvent(db, {
      type: 'turn_complete',
      subjectId: 'sess_1',
    }, { secret: 'secret', fetchImpl: failingFetch, now: () => fixedNow });

    expect(first[0]).toMatchObject({
      status: 'pending_retry',
      status_code: 503,
      attempt_count: 1,
    });
    // The retry delay is jittered into the published 5-120 s window, so attempt 1 is asserted as a
    // window rather than an exact instant: it backs off somewhere inside [5, 60] s.
    const retryAt = Date.parse(first[0].next_retry_at as string);
    expect(retryAt).toBeGreaterThanOrEqual(Date.parse('2026-07-23T00:00:05.000Z'));
    expect(retryAt).toBeLessThanOrEqual(Date.parse('2026-07-23T00:01:00.000Z'));

    const successfulFetch = vi.fn(async () => ({ status: 200 })) as unknown as typeof fetch;
    const retried = await retryDueWebhookDeliveries(db, {
      secret: 'secret',
      fetchImpl: successfulFetch,
      now: () => new Date('2026-07-23T00:02:00.000Z'),
    });

    expect(successfulFetch).toHaveBeenCalledOnce();
    expect(retried[0]).toMatchObject({
      status: 'delivered',
      status_code: 200,
      attempt_count: 2,
      next_retry_at: null,
    });

    // The retry is the same delivery, so it carries the published header set the
    // first attempt carried: `webhook-id` stays the event id inside the body so a
    // receiver can deduplicate, and the timestamp is this attempt's, which is
    // what the receiver's freshness window checks.
    const eventId = (JSON.parse(String((failingFetch as any).mock.calls[0][1].body)) as { id: string }).id;
    const [, retryInit] = (successfulFetch as any).mock.calls[0];
    const retryHeaders = retryInit.headers as Record<string, string>;
    expect(retryHeaders['webhook-id']).toBe(eventId);
    expect(retryHeaders['webhook-timestamp']).toBe(String(Math.floor(new Date('2026-07-23T00:02:00.000Z').getTime() / 1000)));
    expect(retryHeaders['X-Managed-Agents-Signature']).toBeUndefined();
    expect(retryHeaders['webhook-signature']).toBe(signWebhookDelivery({
      secret: 'secret',
      id: retryHeaders['webhook-id'],
      timestamp: retryHeaders['webhook-timestamp'],
      body: String(retryInit.body),
    }));
  });

  it('keeps one delivery id and re-signs every attempt with its own timestamp', async () => {
    db.prepare(
      `INSERT INTO webhooks (id, name, url, events, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('wh_multi', 'Multi', 'https://example.com/multi', JSON.stringify(['turn_failed']), fixedNow.toISOString(), fixedNow.toISOString());

    const secret = 'whsec_MQ==';
    const attemptOne = vi.fn(async () => ({ status: 503 })) as unknown as typeof fetch;
    const attemptTwo = vi.fn(async () => ({ status: 503 })) as unknown as typeof fetch;
    const attemptThree = vi.fn(async () => ({ status: 200 })) as unknown as typeof fetch;
    const times = [
      fixedNow,
      new Date('2026-07-23T00:02:00.000Z'),
      new Date('2026-07-23T00:05:00.000Z'),
    ];

    const [first] = await dispatchWebhookEvent(db, { type: 'turn_failed', subjectId: 'sess_1' }, { secret, fetchImpl: attemptOne, now: () => times[0] });
    const [second] = await retryDueWebhookDeliveries(db, { secret, fetchImpl: attemptTwo, now: () => times[1] });
    const [third] = await retryDueWebhookDeliveries(db, { secret, fetchImpl: attemptThree, now: () => times[2] });

    // One delivery across three attempts, so a receiver can deduplicate on the id.
    expect([second.id, third.id]).toEqual([first.id, first.id]);
    expect([first.attempt_count, second.attempt_count, third.attempt_count]).toEqual([1, 2, 3]);
    expect(third).toMatchObject({ status: 'delivered', status_code: 200 });

    const eventId = (JSON.parse(String((attemptOne as any).mock.calls[0][1].body)) as { id: string }).id;
    const attempts = [attemptOne, attemptTwo, attemptThree];
    attempts.forEach((fetchImpl, index) => {
      const [, init] = (fetchImpl as any).mock.calls[0];
      const headers = init.headers as Record<string, string>;
      expect(headers['webhook-id']).toBe(eventId);
      expect(headers['webhook-timestamp']).toBe(String(Math.floor(times[index].getTime() / 1000)));
      expect(headers['webhook-signature']).toBe(signWebhookDelivery({
        secret,
        id: eventId,
        timestamp: headers['webhook-timestamp'],
        body: String(init.body),
      }));
    });
  });

  it('signs each endpoint with its own secret and leaves a legacy row on the old key', async () => {
    const dataDir = join(tmpDir, 'data');
    const insert = db.prepare(
      `INSERT INTO webhooks (id, name, url, events, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('wh_fresh', 'Fresh', 'https://example.com/fresh', JSON.stringify(['turn_complete']), fixedNow.toISOString(), fixedNow.toISOString());
    insert.run('wh_legacy', 'Legacy', 'https://example.com/legacy', JSON.stringify(['turn_complete']), fixedNow.toISOString(), fixedNow.toISOString());
    // Only the first endpoint has a minted secret; the second is what a row
    // written before M038 looks like.
    const minted = mintAndStoreWebhookSecret(db, 'wh_fresh', dataDir);

    const fetchImpl = vi.fn(async () => ({ status: 204 })) as unknown as typeof fetch;
    await dispatchWebhookEvent(db, { type: 'turn_complete', subjectId: 'sess_1' }, {
      secret: 'legacy-key',
      dataDir,
      fetchImpl,
      now: () => fixedNow,
    });

    const calls = (fetchImpl as any).mock.calls as Array<[string, any]>;
    const fresh = calls.find(([url]) => url === 'https://example.com/fresh')!;
    const legacy = calls.find(([url]) => url === 'https://example.com/legacy')!;

    // The minted endpoint signs with the value its receiver was given...
    expect(fresh[1].headers['webhook-signature']).toBe(signWebhookDelivery({
      secret: minted,
      id: fresh[1].headers['webhook-id'],
      timestamp: fresh[1].headers['webhook-timestamp'],
      body: String(fresh[1].body),
    }));
    // ...and not with the value the runtime used before per-endpoint secrets, so
    // one endpoint's key is not another endpoint's key.
    expect(fresh[1].headers['webhook-signature']).not.toBe(signWebhookDelivery({
      secret: 'legacy-key',
      id: fresh[1].headers['webhook-id'],
      timestamp: fresh[1].headers['webhook-timestamp'],
      body: String(fresh[1].body),
    }));

    // A row with no stored secret keeps the legacy derivation, so upgrading does
    // not invalidate a receiver that verifies today.
    expect(legacy[1].headers['webhook-signature']).toBe(signWebhookDelivery({
      secret: 'legacy-key',
      id: legacy[1].headers['webhook-id'],
      timestamp: legacy[1].headers['webhook-timestamp'],
      body: String(legacy[1].body),
    }));
  });
});
