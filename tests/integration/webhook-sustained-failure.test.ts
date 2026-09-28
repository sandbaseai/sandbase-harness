/**
 * The third published auto-disable case: an endpoint that fails for a sustained duration is
 * disabled.
 *
 * The published sentence (`订阅Webhook.md`): 向端点的传递在一段持续时间内连续失败，原因为
 * `auto-disabled after sustained delivery failures`。触发条件是端点不间断失败的持续时长，而非
 * 传递次数。一次 `2xx` 即可重置该窗口. Three things follow, and each is a test here rather
 * than an implementation detail:
 *
 * **The trigger is elapsed time, not a delivery count.** So the streak has to be stored: a
 * counter in process memory would reset on every restart and the rule would never fire in the
 * deployment it exists for. The tests drive elapsed time through the dispatcher's injectable
 * `now`, and one of them seeds a stored streak directly to represent history.
 *
 * **A `2xx` resets the window, which makes the success path part of the rule.** The
 * distinguishing test is "a `2xx` clears the streak": it sets a streak start a week in the past,
 * delivers a success, and then checks that the next failure *starts* the window instead of
 * resuming it. An implementation that only ever incremented a failure counter would pass every
 * other test here and fail that one.
 *
 * **The window's value is not published**, so no test asserts a number the contract does not
 * state as though it were conformed. What the tests do assert is the local policy the runtime
 * ships: the default is **ten minutes**, written out rather than read from the constant that
 * defines it so the policy is pinned by behaviour, and a deployment can set its own with
 * `MANAGED_AGENTS_WEBHOOK_SUSTAINED_FAILURE_WINDOW_SECONDS`. That switch is exercised the way
 * a deployment sets it rather than through an injected option, because the switch is the
 * surface an operator actually has.
 *
 * The receivers are real HTTP listeners, so a delivery that is supposed to happen is observed
 * happening, and the terminal assertions are about the rows the dispatcher writes afterwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import {
  WEBHOOK_SUSTAINED_FAILURE_WINDOW_ENV,
  dispatchWebhookEvent,
  retryDueWebhookDeliveries,
} from '@/core/operations/webhook-dispatcher.js';

const EVENT = 'session.status_idled';
const REASON = 'auto-disabled after sustained delivery failures';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = new Date('2026-03-01T00:00:00.000Z');

const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

type Stub = {
  url: string;
  requests: () => number;
  setStatus: (status: number) => void;
  close: () => Promise<void>;
};

describe('webhook sustained-failure auto-disable', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;
  const stubs: Stub[] = [];

  beforeEach(() => {
    // Pinned to "unset" so the default is what these cases measure. An empty value is how the
    // parser spells "no switch", which is also what a deployment that never set it has.
    vi.stubEnv(WEBHOOK_SUSTAINED_FAILURE_WINDOW_ENV, '');
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-webhook-sustained-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare(
      `INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{"sandbox_provider":"local"}')`,
    ).run();
    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      skills: [],
      workspace: {
        root: tmpDir,
        dataDir: tmpDir,
        agentsDir: tmpDir,
        skillsDir: tmpDir,
        configPath: join(tmpDir, 'config.yaml'),
        target: 'local',
      },
      runtime: { models: [], sandboxProviders: ['local'], memory: 'disabled', authEnabled: false },
      reloadAgents: () => ({ agents: [], errors: [] }),
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const stub of stubs.splice(0)) await stub.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function stub(initialStatus: number): Promise<Stub> {
    let status = initialStatus;
    let count = 0;
    const server = createHttpServer((_req, res) => {
      count += 1;
      res.statusCode = status;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const started: Stub = {
      url: `http://127.0.0.1:${port}/hook`,
      requests: () => count,
      setStatus: (next) => {
        status = next;
      },
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
    stubs.push(started);
    return started;
  }

  function subscribe(id: string, url: string): void {
    db.prepare(
      `INSERT INTO webhooks (id, name, url, events, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, id, url, JSON.stringify(['*']), T0.toISOString(), T0.toISOString());
  }

  function webhookRow(id: string) {
    return db
      .prepare('SELECT status, disabled_reason, failing_since FROM webhooks WHERE id = ?')
      .get(id) as { status: string; disabled_reason: string | null; failing_since: string | null };
  }

  async function dispatchAt(when: Date) {
    return dispatchWebhookEvent(
      db,
      { event: EVENT, id: `evt_${when.getTime()}`, created_at: when.toISOString(), data: { ok: true } },
      { secret: 'whsec_sustained_test', now: () => when },
    );
  }

  it('disables an endpoint whose failures outlast the window, and stops retrying', async () => {
    const endpoint = await stub(500);
    subscribe('wh_sustained', endpoint.url);

    // The first failure opens the streak. It is an ordinary failure, so it still retries.
    const first = await dispatchAt(T0);
    expect(first[0]).toMatchObject({ status: 'pending_retry', next_retry_at: expect.any(String) });
    expect(webhookRow('wh_sustained')).toMatchObject({ status: 'active', disabled_reason: null });
    expect(webhookRow('wh_sustained').failing_since).toBe(T0.toISOString());

    // A failure a day later belongs to the same uninterrupted run, so the window has elapsed.
    const second = await dispatchAt(at(DAY + HOUR));
    expect(second[0]).toMatchObject({ status: 'failed', next_retry_at: null });
    expect(webhookRow('wh_sustained')).toMatchObject({
      status: 'disabled',
      disabled_reason: REASON,
    });

    // Both attempts really were delivered — the disable is about duration, not about a
    // connection that never happened.
    expect(endpoint.requests()).toBe(2);

    // Terminal: the disabled endpoint schedules nothing, so nothing is due even much later.
    const due = await retryDueWebhookDeliveries(db, {
      secret: 'whsec_sustained_test',
      now: () => at(2 * DAY),
    });
    expect(due).toEqual([]);
  });

  it('clears the streak on a `2xx`, so interrupted failures never accumulate', async () => {
    const endpoint = await stub(500);
    subscribe('wh_interrupted', endpoint.url);
    // History: this endpoint has been failing for a week.
    db.prepare('UPDATE webhooks SET failing_since = ? WHERE id = ?').run(
      at(-7 * DAY).toISOString(),
      'wh_interrupted',
    );

    // One success resets the window. This is the published reset rule, and it is a write.
    endpoint.setStatus(204);
    const delivered = await dispatchAt(T0);
    expect(delivered[0]).toMatchObject({ status: 'delivered' });
    expect(webhookRow('wh_interrupted').failing_since).toBeNull();

    // The next failure therefore starts a fresh window rather than resuming the week-old one:
    // the endpoint is still active even though it has failed across a week.
    endpoint.setStatus(500);
    const failed = await dispatchAt(at(HOUR));
    expect(failed[0]).toMatchObject({ status: 'pending_retry' });
    expect(webhookRow('wh_interrupted')).toMatchObject({ status: 'active', disabled_reason: null });
    expect(webhookRow('wh_interrupted').failing_since).toBe(at(HOUR).toISOString());
  });

  it('measures the local default of ten minutes on both sides of its boundary', async () => {
    const endpoint = await stub(500);
    subscribe('wh_inside', endpoint.url);

    await dispatchAt(T0);
    // One millisecond short of the default window: the streak is still running, so the
    // endpoint stays active and the attempt is still retried. The ten minutes are written
    // out rather than read from the constant the code defines, so this case pins the policy
    // by its behaviour and fails if the default is moved.
    const windowMs = 10 * MINUTE;
    const inside = await dispatchAt(at(windowMs - 1));

    expect(inside[0]).toMatchObject({ status: 'pending_retry' });
    expect(webhookRow('wh_inside').status).toBe('active');
    // The streak start is the first failure's, not the latest one: the window measures the
    // whole run, so a repeated failure must not restart the clock and postpone the rule.
    expect(webhookRow('wh_inside').failing_since).toBe(T0.toISOString());

    // Inclusive at the boundary: exactly ten minutes after the streak opened, it is overdue.
    const boundary = await dispatchAt(at(windowMs));
    expect(boundary[0]).toMatchObject({ status: 'failed', next_retry_at: null });
    expect(webhookRow('wh_inside')).toMatchObject({ status: 'disabled', disabled_reason: REASON });
    // The disable is about elapsed time, not about a connection that never happened.
    expect(endpoint.requests()).toBe(3);
  });

  it('takes the window from the deployment switch instead of the default', async () => {
    const sixHours = 6 * 3600;
    vi.stubEnv(WEBHOOK_SUSTAINED_FAILURE_WINDOW_ENV, String(sixHours));
    const endpoint = await stub(500);
    subscribe('wh_configured', endpoint.url);

    await dispatchAt(T0);
    // Half an hour is three times the default and still inside this deployment's window, so a
    // window that ignored the switch would disable the endpoint here.
    const inside = await dispatchAt(at(30 * MINUTE));
    expect(inside[0]).toMatchObject({ status: 'pending_retry' });
    expect(webhookRow('wh_configured').status).toBe('active');

    const outside = await dispatchAt(at(sixHours * 1000));
    expect(outside[0]).toMatchObject({ status: 'failed', next_retry_at: null });
    expect(webhookRow('wh_configured')).toMatchObject({
      status: 'disabled',
      disabled_reason: REASON,
    });
    expect(endpoint.requests()).toBe(3);
  });

  it('applies the rule to a retry, where the streak has usually already crossed the window', async () => {
    const endpoint = await stub(500);
    subscribe('wh_retry', endpoint.url);
    db.prepare(
      `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status, status_code, error,
        signature, attempt_count, next_retry_at, created_at)
       VALUES ('whd_seed', 'wh_retry', ?, '{}', 'pending_retry', 500, 'HTTP 500', 'sha256=x', 1, ?, ?)`,
    ).run(EVENT, T0.toISOString(), T0.toISOString());
    db.prepare('UPDATE webhooks SET failing_since = ? WHERE id = ?').run(
      at(-2 * DAY).toISOString(),
      'wh_retry',
    );

    const due = await retryDueWebhookDeliveries(db, {
      secret: 'whsec_sustained_test',
      now: () => T0,
    });

    expect(due[0]).toMatchObject({ status: 'failed', next_retry_at: null });
    expect(webhookRow('wh_retry')).toMatchObject({ status: 'disabled', disabled_reason: REASON });
    expect(endpoint.requests()).toBe(1);
  });

  it('restarts the window when an operator re-enables the endpoint', async () => {
    // Otherwise the endpoint would return already overdue and be disabled again by its first
    // failure, which would make the published "re-enable it to recover" remedy useless.
    subscribe('wh_reenable', 'http://127.0.0.1:1/hook');
    db.prepare(
      `UPDATE webhooks SET status = 'disabled', disabled_reason = ?, failing_since = ? WHERE id = 'wh_reenable'`,
    ).run(REASON, at(-2 * DAY).toISOString());

    const res = await app.request('/v1/webhooks/wh_reenable', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(webhookRow('wh_reenable')).toMatchObject({
      status: 'active',
      disabled_reason: null,
      failing_since: null,
    });
    // The streak is internal bookkeeping; no published field carries it, so it must not leak
    // into the projection a receiver or the Console reads.
    expect(body).not.toHaveProperty('failing_since');
  });
});
