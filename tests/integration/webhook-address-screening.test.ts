/**
 * A webhook endpoint whose URL resolves into a network the operator has not exposed is
 * disabled, not contacted — when the deployment opts into the screening.
 *
 * The published delivery behaviour's second auto-disable case: when the runtime connects,
 * an endpoint URL that resolves to a non-public IP address is disabled immediately with the
 * reason `auto-disabled: endpoint URL resolved to an invalid address`.
 *
 * Two things about this change are deliberate and are what most of these tests are about.
 *
 * **It is opt-in.** This runtime is local-first and its receiver is normally on the same
 * host — every webhook test in this repository delivers to a loopback listener, and loopback
 * *is* a private address — so enforcing the published rule by default would disable the
 * receiver a self-hosted deployment exists to talk to. The default is asserted here as
 * behaviour, not assumed: test "delivers to a private address when the deployment has not
 * opted in" would fail if a later change made the screening unconditional.
 *
 * **The blocking test asserts a packet count.** A hermetic test can only make loopback
 * reachable, so a loopback endpoint plus a guard that refuses loopback is the only
 * arrangement in which "the runtime did not connect" is measurable rather than inferred.
 * The listener's request count is that measurement; asserting the delivery row alone would
 * pass even if the packet had been sent and the row written afterwards.
 *
 * A stubbed `fetch` could not carry either claim: it can show that a guard was consulted,
 * not that no connection was attempted.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { isPrivateAddress } from '@/core/web/address-policy.js';
import {
  dispatchWebhookEvent,
  retryDueWebhookDeliveries,
  webhookAddressPolicyFromEnv,
  type WebhookAddressPolicy,
} from '@/core/operations/webhook-dispatcher.js';

const EVENT = 'turn_complete';
const PUBLISHED_REASON = 'auto-disabled: endpoint URL resolved to an invalid address';

/** The published policy, as a deployment turns it on. */
const strictPolicy = (lookupAddresses: WebhookAddressPolicy['lookupAddresses']): WebhookAddressPolicy => ({
  lookupAddresses,
  isAddressAllowed: (address) => !isPrivateAddress(address),
});

type Stub = {
  url: string;
  requests: () => number;
  close: () => Promise<void>;
};

describe('webhook address screening', () => {
  let db: Database;
  let tmpDir: string;
  const stubs: Stub[] = [];
  const lookups: string[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-webhook-address-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    lookups.length = 0;
  });

  afterEach(async () => {
    for (const stub of stubs.splice(0)) await stub.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A real loopback receiver, so "was it contacted" is a measured fact. */
  async function stub(): Promise<Stub> {
    let count = 0;
    const server = createHttpServer((_req, res) => {
      count += 1;
      res.statusCode = 204;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const started: Stub = {
      url: `http://127.0.0.1:${port}/hook`,
      requests: () => count,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
    stubs.push(started);
    return started;
  }

  function subscribe(id: string, url: string) {
    db.prepare(
      `INSERT INTO webhooks (id, name, url, events, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, id, url, JSON.stringify([EVENT]), '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z');
  }

  function webhookRow(id: string) {
    return db.prepare('SELECT status, disabled_reason FROM webhooks WHERE id = ?').get(id) as {
      status: string;
      disabled_reason: string | null;
    };
  }

  function deliveryRow(id: string) {
    return db
      .prepare('SELECT status, status_code, error, next_retry_at FROM webhook_deliveries WHERE webhook_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(id) as { status: string; status_code: number | null; error: string | null; next_retry_at: string | null };
  }

  /** The resolver the deployment would use, recording the names it was asked about. */
  function resolverReturning(...addresses: string[]) {
    return async (hostname: string) => {
      lookups.push(hostname);
      return addresses;
    };
  }

  async function dispatch(policy?: WebhookAddressPolicy) {
    return dispatchWebhookEvent(db, { type: EVENT, subjectId: 'sess_1' }, {
      secret: 'whsec_address_test',
      ...(policy ? { addressPolicy: policy } : {}),
    });
  }

  it('disables the endpoint without connecting when the resolved address is private', async () => {
    const endpoint = await stub();
    subscribe('wh_private', endpoint.url);

    const results = await dispatch(strictPolicy(resolverReturning('127.0.0.1')));

    // The measurement: the receiver was never contacted, so no signed payload reached it.
    expect(endpoint.requests()).toBe(0);
    expect(results[0]).toMatchObject({ webhook_id: 'wh_private', status: 'failed', status_code: null });
    expect(results[0].next_retry_at).toBeNull();

    const row = webhookRow('wh_private');
    expect(row.status).toBe('disabled');
    expect(row.disabled_reason).toBe(PUBLISHED_REASON);

    // Terminal, so nothing becomes due later; the retry-due pass also filters on the
    // endpoint still being active, which is why the row is re-read afterwards.
    const due = await retryDueWebhookDeliveries(db, {
      secret: 'whsec_address_test',
      addressPolicy: strictPolicy(resolverReturning('127.0.0.1')),
      now: () => new Date(Date.now() + 86_400_000),
    });
    expect(due).toEqual([]);
    expect(deliveryRow('wh_private').status).toBe('failed');
  });

  it('refuses a host name that resolves private, not only a literal address', async () => {
    // A name, not an address: the literal form is screening case one, and this is the rule
    // the published contract states in terms of what the URL *resolves to*. No listener is
    // needed because a refusal never connects to anything.
    subscribe('wh_named', 'http://webhook.example.test/hook');

    await dispatch(strictPolicy(resolverReturning('10.1.2.3')));

    expect(lookups).toEqual(['webhook.example.test']);
    expect(webhookRow('wh_named')).toMatchObject({
      status: 'disabled',
      disabled_reason: PUBLISHED_REASON,
    });
    // The refusal names the address it refused, which is what an operator needs to act on.
    expect(deliveryRow('wh_named').error).toContain('10.1.2.3');
  });

  it('refuses an internal host name without consulting the resolver', async () => {
    subscribe('wh_internal', 'http://metadata.internal/hook');

    await dispatch(strictPolicy(resolverReturning('93.184.216.34')));

    // Refused on the name, so resolver state cannot change the answer.
    expect(lookups).toEqual([]);
    expect(webhookRow('wh_internal')).toMatchObject({
      status: 'disabled',
      disabled_reason: PUBLISHED_REASON,
    });
  });

  it('fails closed when one of several answers is disallowed', async () => {
    // Which answer a connection would use is not something the screening decides, so a host
    // that answers with both a public and a private address is refused rather than raced.
    subscribe('wh_mixed', 'http://mixed.example.test/hook');

    await dispatch(strictPolicy(resolverReturning('93.184.216.34', '127.0.0.1')));

    expect(webhookRow('wh_mixed').disabled_reason).toBe(PUBLISHED_REASON);
    expect(deliveryRow('wh_mixed').error).toContain('127.0.0.1');
  });

  it('delivers normally when every answer is allowed', async () => {
    const endpoint = await stub();
    subscribe('wh_allowed', endpoint.url);

    // The guard is honoured as given rather than hardcoded to the private-address
    // classifier: this policy allows exactly what the strict one refuses.
    const results = await dispatch({
      lookupAddresses: resolverReturning('127.0.0.1'),
      isAddressAllowed: () => true,
    });

    expect(endpoint.requests()).toBe(1);
    expect(results[0]).toMatchObject({ status: 'delivered', status_code: 204 });
    expect(webhookRow('wh_allowed')).toMatchObject({ status: 'active', disabled_reason: null });
  });

  it('delivers to a private address when the deployment has not opted in', async () => {
    const endpoint = await stub();
    subscribe('wh_default', endpoint.url);

    const results = await dispatch();

    // This is the local-first default, and it is asserted rather than assumed: a loopback
    // receiver is the normal self-hosted deployment, so making the screening unconditional
    // would break it. If this test ever fails, that decision was reversed by accident.
    expect(endpoint.requests()).toBe(1);
    expect(results[0]).toMatchObject({ webhook_id: 'wh_default', status: 'delivered', status_code: 204 });
    expect(webhookRow('wh_default')).toMatchObject({ status: 'active', disabled_reason: null });
  });

  it('screens a retry too, and disables on the address it finds', async () => {
    const endpoint = await stub();
    subscribe('wh_retry', endpoint.url);

    // First attempt with no screening against an endpoint that fails: a retry is queued.
    db.prepare(
      `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status, status_code, error,
        signature, attempt_count, next_retry_at, created_at)
       VALUES ('whd_seed', 'wh_retry', ?, '{}', 'pending_retry', 500, 'HTTP 500', 'sha256=x', 1, ?, ?)`,
    ).run(EVENT, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    expect(webhookRow('wh_retry').status).toBe('active');

    const due = await retryDueWebhookDeliveries(db, {
      secret: 'whsec_address_test',
      addressPolicy: strictPolicy(resolverReturning('127.0.0.1')),
      now: () => new Date('2026-07-01T00:00:00.000Z'),
    });

    expect(endpoint.requests()).toBe(0);
    expect(due[0]).toMatchObject({ status: 'failed', next_retry_at: null });
    expect(webhookRow('wh_retry').disabled_reason).toBe(PUBLISHED_REASON);
  });

  it('turns the screening on only for an explicit opt-in value', () => {
    // A variable nobody set, or one set to a value that reads as "off", must not change
    // delivery behaviour; only an explicit affirmative switches it on.
    expect(webhookAddressPolicyFromEnv({})).toBeUndefined();
    expect(webhookAddressPolicyFromEnv({ MANAGED_AGENTS_WEBHOOK_SCREEN_PRIVATE_ADDRESSES: '' })).toBeUndefined();
    expect(webhookAddressPolicyFromEnv({ MANAGED_AGENTS_WEBHOOK_SCREEN_PRIVATE_ADDRESSES: '0' })).toBeUndefined();
    expect(webhookAddressPolicyFromEnv({ MANAGED_AGENTS_WEBHOOK_SCREEN_PRIVATE_ADDRESSES: 'off' })).toBeUndefined();
    expect(webhookAddressPolicyFromEnv({ MANAGED_AGENTS_WEBHOOK_SCREEN_PRIVATE_ADDRESSES: 'no' })).toBeUndefined();

    const policy = webhookAddressPolicyFromEnv({
      MANAGED_AGENTS_WEBHOOK_SCREEN_PRIVATE_ADDRESSES: 'true',
    });
    expect(policy).toBeDefined();
    // The enabled policy is the published one: every private class is refused, and a
    // public address is not.
    expect(policy!.isAddressAllowed('127.0.0.1')).toBe(false);
    expect(policy!.isAddressAllowed('10.0.0.5')).toBe(false);
    expect(policy!.isAddressAllowed('192.168.1.20')).toBe(false);
    expect(policy!.isAddressAllowed('169.254.169.254')).toBe(false);
    expect(policy!.isAddressAllowed('::1')).toBe(false);
    expect(policy!.isAddressAllowed('fd00::1')).toBe(false);
    expect(policy!.isAddressAllowed('93.184.216.34')).toBe(true);
  });
});
