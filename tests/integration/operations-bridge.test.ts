/**
 * Integration test: the operations bridge.
 *
 * The webhook primitives (signing, delivery records, retry backoff) and the
 * deployment scheduler both existed and were tested, but nothing projected a
 * session event to a webhook subscription, and nothing honoured a due schedule
 * unless a caller POSTed to the route. These assertions pin the wiring: the
 * broadcast listener, the timers, the composition, and the startup re-arm.
 *
 * Adapted from the reviewed snapshot rather than replayed verbatim: the
 * snapshot seeded a plaintext `secret` column that M038 replaced with an
 * encrypted per-endpoint secret. The deliveries now carry the published
 * `{type: "event", ...}` envelope; the seeded `webhook_event` payloads below
 * are pre-migration rows kept so the retry path proves it does not crash on
 * them and falls back to the delivery id for `webhook-id`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createLogger } from '@/core/observability/logger.js';
import { WEBHOOK_HEADERS, verifyWebhookDelivery } from '@/core/operations/webhook-signature.js';
import { WEBHOOK_SUSTAINED_FAILURE_WINDOW_ENV } from '@/core/operations/webhook-dispatcher.js';
import { rearmScheduledDeployments } from '@/core/operations/scheduler.js';
import {
  composeOperations,
  createWebhookEventListener,
  startOperationsTimers,
  webhookSigningSecret,
} from '@/api/operations-bridge.js';

const WEBHOOK_SECRET = webhookSigningSecret(undefined);

describe('Operations bridge (webhooks + scheduled deployments)', () => {
  let db: Database;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let requests: Array<{ url: string; body: string; headers: Record<string, string> }>;

  /** A fetch double that records every request and answers from a queue. */
  function recordingFetch(statuses: number[] = []) {
    const queue = [...statuses];
    return (async (url: unknown, init: any) => {
      requests.push({
        url: String(url),
        body: String(init?.body ?? ''),
        headers: { ...(init?.headers as Record<string, string>) },
      });
      const status = queue.length > 0 ? queue.shift()! : 204;
      return new Response(status === 204 ? null : 'body', { status });
    }) as typeof fetch;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-bridge-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id) VALUES ('sess_a', 'agent_x', 'x', 'env_a')").run();
    // No stored secret: this subscription predates per-endpoint secrets, so the
    // workspace-derived key signs it.
    db.prepare(
      `INSERT INTO webhooks (id, name, url, events, description, status, metadata, created_at, updated_at)
       VALUES ('wh_test', 'local', 'https://hooks.example.test/sessions', '["session.status_idled"]', '', 'active', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    requests = [];
    sessionManager = new SessionManager(db);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('projects a durable session event to a matching subscription', async () => {
    sessionManager.setBroadcastListener(
      createWebhookEventListener({ db, webhookSecret: WEBHOOK_SECRET, fetchImpl: recordingFetch() }),
    );

    await sessionManager.sendEvent('sess_a', {
      type: 'session.status_idle',
      content: [{ type: 'text', text: 'hello' }],
    } as never);
    await sleep(30);

    expect(requests).toHaveLength(1);
    const [delivery] = requests;
    // The published envelope: the body is an event envelope whose `data` is a
    // reference — a receiver resolves `data.id` through the API rather than
    // trusting a shipped snapshot.
    const payload = JSON.parse(delivery.body) as Record<string, any>;
    expect(payload).toMatchObject({
      type: 'event',
      data: {
        type: 'session.status_idled',
        id: 'sess_a',
        organization_id: 'org_local',
        workspace_id: 'wrkspc_local',
      },
    });
    expect(payload.id).toMatch(/^whe_/);
    expect(payload).not.toHaveProperty('webhook_id');
    expect(delivery.headers[WEBHOOK_HEADERS.id]).toBe(payload.id);
    // The published header set, verifiable with the key that signs it.
    expect(verifyWebhookDelivery({
      secret: WEBHOOK_SECRET,
      id: delivery.headers[WEBHOOK_HEADERS.id],
      timestamp: delivery.headers[WEBHOOK_HEADERS.timestamp],
      body: delivery.body,
      signatureHeader: delivery.headers[WEBHOOK_HEADERS.signature],
    })).toBe(true);

    const rows = db.prepare('SELECT status FROM webhook_deliveries WHERE webhook_id = ?').all('wh_test') as Array<{ status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('delivered');
  });

  it('retries a due delivery and runs a due deployment on its timer', async () => {
    db.prepare(
      `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status, status_code, error, signature, attempt_count, next_retry_at, created_at)
       VALUES ('whd_due', 'wh_test', 'user.message', '{"type":"webhook_event","event":"user.message"}', 'pending_retry', 503, 'HTTP 503', 'sha256=seed', 1, ?, ?)`,
    ).run(new Date(Date.now() - 5_000).toISOString(), new Date(Date.now() - 10_000).toISOString());
    db.prepare(
      `INSERT INTO scheduled_deployments (id, name, agent_id, environment_id, cron, status, next_run_at, created_at, updated_at)
       VALUES ('sched_due', 'due', 'agent_x', 'env_a', '* * * * *', 'active', ?, datetime('now'), datetime('now'))`,
    ).run(new Date(Date.now() - 60_000).toISOString());

    const stop = startOperationsTimers({
      db,
      sessionManager,
      webhookSecret: WEBHOOK_SECRET,
      fetchImpl: recordingFetch(),
      intervalMs: 15,
    });
    await sleep(80);
    stop();

    // The due delivery was retried by the tick rather than by a caller...
    expect(requests.some((request) => request.url === 'https://hooks.example.test/sessions')).toBe(true);
    const delivery = db.prepare('SELECT status, attempt_count FROM webhook_deliveries WHERE id = ?')
      .get('whd_due') as { status: string; attempt_count: number };
    expect(delivery.status).toBe('delivered');
    expect(delivery.attempt_count).toBe(2);

    // ...and the due deployment ran, with no POST to `run-due`.
    const runs = db.prepare('SELECT id FROM scheduled_deployment_runs WHERE schedule_id = ?').all('sched_due');
    expect(runs.length).toBeGreaterThan(0);
  });

  it('records the auto-disable window it composes with, and the composed value is the one used', async () => {
    // The switch is a deployment variable, so it has no write path of its own to record a
    // change; the record the bridge writes at start-up is that change trail. It has to name
    // the value the deliveries actually use, or it is a log line about nothing.
    vi.stubEnv(WEBHOOK_SUSTAINED_FAILURE_WINDOW_ENV, '1');
    const lines: string[] = [];
    const { stopOperationsTimers } = composeOperations({
      db,
      sessionManager,
      webhookSecret: WEBHOOK_SECRET,
      fetchImpl: recordingFetch([500]),
      intervalMs: 60_000,
      logger: createLogger({ level: 'info', write: (line) => lines.push(line) }),
    });
    stopOperationsTimers();

    const record = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.msg === 'webhook_disable_window');
    expect(record).toMatchObject({ level: 'info', window_seconds: 1, source: 'deployment' });

    // Cleared after the composition. Two seconds of uninterrupted failure is overdue against
    // the second this composition recorded and nowhere near the ten-minute default, so the
    // endpoint can only be disabled here if the listener carries the recorded value instead
    // of re-reading the switch on every delivery.
    vi.stubEnv(WEBHOOK_SUSTAINED_FAILURE_WINDOW_ENV, '');
    db.prepare('UPDATE webhooks SET failing_since = ? WHERE id = ?')
      .run(new Date(Date.now() - 2_000).toISOString(), 'wh_test');

    await sessionManager.sendEvent('sess_a', {
      type: 'session.status_idle',
      content: [{ type: 'text', text: 'streak' }],
    } as never);
    await sleep(30);

    expect(db.prepare('SELECT status, disabled_reason FROM webhooks WHERE id = ?').get('wh_test'))
      .toMatchObject({
        status: 'disabled',
        disabled_reason: 'auto-disabled after sustained delivery failures',
      });
    vi.unstubAllEnvs();
  });

  it('composes a listener and a timer, and stopping clears the timer', async () => {
    const { stopOperationsTimers } = composeOperations({
      db,
      sessionManager,
      webhookSecret: WEBHOOK_SECRET,
      fetchImpl: recordingFetch(),
      intervalMs: 15,
    });

    // The listener half is live: one durable event reaches the subscription.
    await sessionManager.sendEvent('sess_a', {
      type: 'session.status_idle',
      content: [{ type: 'text', text: 'composed' }],
    } as never);
    await sleep(30);
    expect(requests).toHaveLength(1);

    stopOperationsTimers();

    // The timer half is gone: a delivery that is due right now is not retried,
    // which is what proves the stop function reaches the interval.
    db.prepare(
      `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status, status_code, error, signature, attempt_count, next_retry_at, created_at)
       VALUES ('whd_after_stop', 'wh_test', 'user.message', '{"type":"webhook_event","event":"user.message"}', 'pending_retry', 503, 'HTTP 503', 'sha256=seed', 1, ?, ?)`,
    ).run(new Date(Date.now() - 5_000).toISOString(), new Date(Date.now() - 10_000).toISOString());
    await sleep(60);
    expect(requests).toHaveLength(1);
  });

  it('restores a stale forward schedule at startup and leaves a future one alone', () => {
    const now = new Date('2026-09-22T12:00:00.000Z');
    const insert = db.prepare(
      `INSERT INTO scheduled_deployments (id, name, agent_id, environment_id, cron, status, next_run_at, created_at, updated_at)
       VALUES (?, ?, 'agent_x', 'env_a', '* * * * *', 'active', ?, datetime('now'), datetime('now'))`,
    );
    insert.run('sched_stale', 'stale', '2026-09-22T11:00:00.000Z');
    insert.run('sched_future', 'future', '2026-09-22T13:00:00.000Z');

    expect(rearmScheduledDeployments({ db }, { now })).toBe(1);

    const stale = db.prepare('SELECT next_run_at FROM scheduled_deployments WHERE id = ?')
      .get('sched_stale') as { next_run_at: string };
    const future = db.prepare('SELECT next_run_at FROM scheduled_deployments WHERE id = ?')
      .get('sched_future') as { next_run_at: string };
    // Scheduled forward, not replayed at the moment the process was down.
    expect(new Date(stale.next_run_at).getTime()).toBeGreaterThan(now.getTime());
    expect(future.next_run_at).toBe('2026-09-22T13:00:00.000Z');
  });
});
