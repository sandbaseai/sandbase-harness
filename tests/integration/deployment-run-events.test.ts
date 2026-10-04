/**
 * Integration test: a timed deployment run publishes its lifecycle.
 *
 * Three published events had no emitter — `deployment_run.started`,
 * `deployment_run.succeeded`, `deployment_run.failed` (`订阅Webhook.md:69-71`) —
 * so a subscription to any of them was accepted and could never fire. The table
 * ties them together: the outcome carries `data.id`, the **run** id, and states
 * that it is *the same id as that run's `deployment_run.started` event*. It also
 * states the family-wide rule that **只有定时运行会发出 `deployment_run`
 * 事件；手动运行不会**.
 *
 * That rule is why this file tests the manual route so carefully. `runSchedule`
 * is shared by the timed path and the manual route, and the manual route takes a
 * **caller-supplied** `trigger_type`
 * (`stringField(body.value.trigger_type) ?? 'manual'`), so a manual run can
 * declare itself timed. Publication therefore keys off the *path*, not the trigger
 * type, and the case that proves it is a manual run passing
 * `trigger_type: "scheduled"` — the one that would emit if the rule had been
 * written the obvious way.
 *
 * The published handler contract tells a receiver to branch on `data.type` and
 * **fetch the resource by `data.id`** (`订阅Webhook.md:337`). So every event
 * asserted here is checked for resolvability *inside the receiver*, at delivery
 * time. That measurement is what pins the ordering decision: `runSchedule` is
 * synchronous and writes its row in one terminal statement, so `started` is
 * published once the run is recorded rather than at the instant it begins —
 * publishing earlier would send that fetch to a 404 for a run that had genuinely
 * started.
 *
 * Delivery is asserted against a real HTTP receiver on an ephemeral loopback port,
 * and every assertion is scoped to the subscription its own case created.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { loadSkills } from '@/core/skills/loader.js';
import { createLogger, InMemoryLogStore } from '@/core/observability/logger.js';
import { createServer } from '@/api/server.js';
import { startOperationsTimers } from '@/api/operations-bridge.js';
import { CMA_ANTHROPIC_VERSION, CMA_MANAGED_AGENTS_BETA } from '@/core/cma/compatibility.js';

const CMA_HEADERS = {
  'content-type': 'application/json',
  'x-api-key': 'test-key',
  'anthropic-version': CMA_ANTHROPIC_VERSION,
  'anthropic-beta': CMA_MANAGED_AGENTS_BETA,
};

/** One delivered body, plus what the receiver could resolve when it arrived. */
type Received = {
  body: any;
  headers: Record<string, string | string[] | undefined>;
  /** The run row named by `data.id`, read **at delivery time**. */
  runAtDelivery: { status: string } | null;
};

describe('deployment_run lifecycle events', () => {
  let app: ReturnType<typeof createServer>;
  let db: Database;
  let sessionManager: SessionManager;
  let tmpDir: string;
  let dataDir: string;
  let receiver: Server;
  let received: Received[];
  let receiverUrl: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-deployment-run-events-'));
    const agentsDir = join(tmpDir, 'agents');
    const skillsDir = join(tmpDir, 'skills');
    dataDir = join(tmpDir, '.managed-agents');
    const configPath = join(dataDir, 'config.yaml');
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(configPath, 'model:\n  provider: openai\n  api_key: secret-value\n');

    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_one', 'one', '{}')`);

    sessionManager = new SessionManager(db);
    const logStore = new InMemoryLogStore();
    const logger = createLogger({ level: 'debug', logStore, write: () => undefined });

    app = createServer({
      db,
      sessionManager,
      agents: [],
      consoleRoot: null,
      workspace: { root: tmpDir, dataDir, agentsDir, skillsDir, configPath, target: 'local' },
      runtime: { models: [], sandboxProviders: ['local'], memory: 'disabled', authEnabled: false },
      skills: loadSkills(skillsDir).skills,
      logger,
      logStore,
      restart: () => undefined,
      listRuntimeModels: () => [],
      registerModelProvider: () => undefined,
      setDefaultRuntimeModel: () => undefined,
      reloadAgents: () => ({ agents: [], errors: [] }),
    });

    received = [];
    receiver = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : null;
        const id = typeof body?.data?.id === 'string' ? body.data.id : null;
        const row = id
          ? db.prepare('SELECT status FROM scheduled_deployment_runs WHERE id = ?').get(id) as { status: string } | undefined
          : undefined;
        received.push({ body, headers: req.headers, runAtDelivery: row ?? null });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const address = receiver.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    receiverUrl = `http://127.0.0.1:${port}/hook`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function subscribe(events: string[], url = receiverUrl): Promise<string> {
    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: CMA_HEADERS,
      body: JSON.stringify({ url, events }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).id;
  }

  /**
   * A deployment that is already due, written directly.
   *
   * Going through `POST /v1/deployments` would arm `next_run_at` in the future, so
   * the only way to have a genuinely due run is to write the row. An unknown
   * `agentId` is what makes a run fail: `sessionManager.create` throws
   * `Agent not found`, which is the real failure path, not a simulated one.
   */
  function insertDueDeployment(id: string, agentId = 'agent_one'): void {
    db.prepare(
      `INSERT INTO scheduled_deployments (id, name, agent_id, cron, payload, status, next_run_at)
       VALUES (?, ?, ?, '0 20 * * 5', '{}', 'active', '2020-01-01T00:00:00.000Z')`,
    ).run(id, id, agentId);
  }

  async function runDue() {
    const res = await app.request('/v1/deployments/run-due', { method: 'POST', headers: CMA_HEADERS });
    return { status: res.status, body: await res.json() as any };
  }

  async function runNow(id: string, body: Record<string, unknown> = {}) {
    const res = await app.request(`/v1/deployments/${id}/run`, {
      method: 'POST',
      headers: CMA_HEADERS,
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  }

  function receivedFor(webhookId: string, event: string): Received[] {
    return received.filter(
      (item) => item.body?.data?.type === event && item.headers?.['x-sandbase-webhook-endpoint-id'] === webhookId,
    );
  }

  function runRow(runId: string): { status: string; trigger_type: string } | undefined {
    return db.prepare('SELECT status, trigger_type FROM scheduled_deployment_runs WHERE id = ?').get(runId) as
      | { status: string; trigger_type: string }
      | undefined;
  }

  it('publishes started then succeeded, both naming the same run', async () => {
    const webhookId = await subscribe(['deployment_run.started', 'deployment_run.succeeded']);
    insertDueDeployment('sched_ok');

    const res = await runDue();
    expect(res.status).toBe(202);

    const started = receivedFor(webhookId, 'deployment_run.started');
    const succeeded = receivedFor(webhookId, 'deployment_run.succeeded');
    expect(started).toHaveLength(1);
    expect(succeeded).toHaveLength(1);

    const runId = started[0].body.data.id as string;
    expect(runId).toMatch(/^srun_/);
    // The published rule: the outcome's id is the same id as the started event's.
    expect(succeeded[0].body.data.id).toBe(runId);
    // And it is the row's own id, so the id a receiver is given is the id it can
    // fetch.
    expect(runRow(runId)).toMatchObject({ status: 'created_session', trigger_type: 'scheduled' });

    // Ordering is asserted by position in the shared delivery log, not per event
    // name, because filtering by name would hide an outcome that overtook its
    // start.
    const order = received
      .filter((item) => item.headers?.['x-sandbase-webhook-endpoint-id'] === webhookId)
      .map((item) => item.body?.data?.type);
    expect(order).toEqual(['deployment_run.started', 'deployment_run.succeeded']);
  });

  it('names the run resource and a reference the receiver can resolve', async () => {
    const webhookId = await subscribe(['deployment_run.succeeded']);
    insertDueDeployment('sched_shape');

    await runDue();

    const got = receivedFor(webhookId, 'deployment_run.succeeded');
    expect(got).toHaveLength(1);
    expect(got[0].body.type).toBe('event');
    expect(got[0].body.data.id).toMatch(/^srun_/);
    // Resolvability is measured in the receiver, at delivery time. A run published
    // before its row existed would read back as null here.
    expect(got[0].runAtDelivery).not.toBeNull();
    expect(got[0].runAtDelivery?.status).toBe('created_session');
    expect(got[0].headers['x-sandbase-webhook-endpoint-id']).toBe(webhookId);
    expect(got[0].headers['webhook-signature']).toBeDefined();
    expect(got[0].headers['webhook-id']).toBe(got[0].body.id);
  });

  it('leaves started resolvable too, because the run is recorded before it is reported', async () => {
    const webhookId = await subscribe(['deployment_run.started']);
    insertDueDeployment('sched_started_resolves');

    await runDue();

    const got = receivedFor(webhookId, 'deployment_run.started');
    expect(got).toHaveLength(1);
    // This is the documented consequence of the synchronous scheduler: the row
    // exists by the time `started` is delivered. Publishing it *before* the run
    // would make this null, which is exactly why it is asserted.
    expect(got[0].runAtDelivery).not.toBeNull();
  });

  it('publishes started then failed when the run cannot create a session', async () => {
    const webhookId = await subscribe([
      'deployment_run.started',
      'deployment_run.succeeded',
      'deployment_run.failed',
    ]);
    // An agent that does not exist, so session creation genuinely throws.
    insertDueDeployment('sched_bad_agent', 'agent_missing');

    await runDue();

    const started = receivedFor(webhookId, 'deployment_run.started');
    const failed = receivedFor(webhookId, 'deployment_run.failed');
    const succeeded = receivedFor(webhookId, 'deployment_run.succeeded');
    expect(started).toHaveLength(1);
    expect(failed).toHaveLength(1);
    // The split is exclusive: a failed run must not also report success.
    expect(succeeded).toHaveLength(0);

    const runId = failed[0].body.data.id as string;
    expect(runId).toBe(started[0].body.data.id);
    expect(runRow(runId)).toMatchObject({ status: 'failed', trigger_type: 'scheduled' });
    expect(failed[0].runAtDelivery?.status).toBe('failed');
  });

  it('publishes nothing for a manual run', async () => {
    const webhookId = await subscribe(['deployment_run.started', 'deployment_run.succeeded', 'deployment_run.failed']);
    insertDueDeployment('sched_manual');

    const res = await runNow('sched_manual');
    expect(res.status).toBe(201);

    expect(receivedFor(webhookId, 'deployment_run.started')).toHaveLength(0);
    expect(receivedFor(webhookId, 'deployment_run.succeeded')).toHaveLength(0);
    expect(receivedFor(webhookId, 'deployment_run.failed')).toHaveLength(0);
    // The run itself happened and was recorded — the silence is about reporting,
    // not about the run being skipped.
    const rows = db.prepare('SELECT * FROM scheduled_deployment_runs WHERE schedule_id = ?').all('sched_manual') as
      Array<{ status: string; trigger_type: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'created_session', trigger_type: 'manual' });
  });

  it('publishes nothing for a manual run that declares itself scheduled', async () => {
    const webhookId = await subscribe(['deployment_run.started', 'deployment_run.succeeded', 'deployment_run.failed']);
    insertDueDeployment('sched_forged');

    // `trigger_type` is caller-supplied on this route, so a rule written as
    // `triggerType === 'scheduled'` would emit here. The rule is on the path
    // instead, which is the whole reason this case exists.
    const res = await runNow('sched_forged', { trigger_type: 'scheduled' });
    expect(res.status).toBe(201);

    expect(receivedFor(webhookId, 'deployment_run.started')).toHaveLength(0);
    expect(receivedFor(webhookId, 'deployment_run.succeeded')).toHaveLength(0);
    const rows = db.prepare('SELECT status, trigger_type FROM scheduled_deployment_runs WHERE schedule_id = ?').all('sched_forged') as
      Array<{ status: string; trigger_type: string }>;
    // The forged trigger type is still stored as given — this change governs
    // reporting, not what the route records.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'created_session', trigger_type: 'scheduled' });
  });

  it('publishes nothing when no deployment is due', async () => {
    const webhookId = await subscribe(['deployment_run.started', 'deployment_run.succeeded', 'deployment_run.failed']);

    const res = await runDue();
    expect(res.status).toBe(202);

    const mine = received.filter((item) => item.headers?.['x-sandbase-webhook-endpoint-id'] === webhookId);
    expect(mine).toHaveLength(0);
  });

  it('reaches a subscription that names the events and leaves another family alone', async () => {
    const runWebhook = await subscribe(['deployment_run.started', 'deployment_run.succeeded', 'deployment_run.failed']);
    const otherWebhook = await subscribe(['environment.archived']);
    insertDueDeployment('sched_wildcard');

    await runDue();

    const events = received
      .filter((item) => item.headers?.['x-sandbase-webhook-endpoint-id'] === runWebhook)
      .map((item) => item.body?.data?.type);
    expect(events).toEqual(['deployment_run.started', 'deployment_run.succeeded']);
    expect(receivedFor(otherWebhook, 'deployment_run.succeeded')).toHaveLength(0);
    expect(received.filter((item) => item.headers?.['x-sandbase-webhook-endpoint-id'] === otherWebhook)).toHaveLength(0);
  });

  it('runs every due deployment even when the subscriber cannot be reached', async () => {
    // Port 1 refuses immediately: no network egress, and no timing dependence.
    const deadWebhook = await subscribe(['deployment_run.started', 'deployment_run.succeeded', 'deployment_run.failed'], 'http://127.0.0.1:1/hook');
    insertDueDeployment('sched_dead_one');
    insertDueDeployment('sched_dead_two');

    const res = await runDue();
    expect(res.status).toBe(202);

    // Both runs happened: a delivery failure must not stop a due deployment, nor
    // abandon the rest of the pass.
    for (const id of ['sched_dead_one', 'sched_dead_two']) {
      const rows = db.prepare('SELECT status FROM scheduled_deployment_runs WHERE schedule_id = ?').all(id) as
        Array<{ status: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('created_session');
    }
    // And the failed attempts were recorded for retry rather than lost.
    const deliveries = db.prepare(
      "SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id = ? AND status != 'succeeded'",
    ).get(deadWebhook) as { n: number };
    expect(deliveries.n).toBeGreaterThan(0);
  });

  it('reports runs triggered by the background tick, the other door onto the timed path', async () => {
    const webhookId = await subscribe(['deployment_run.started', 'deployment_run.succeeded', 'deployment_run.failed']);
    insertDueDeployment('sched_tick');

    const stop = startOperationsTimers({
      db,
      sessionManager,
      webhookSecret: dataDir,
      dataDir,
      intervalMs: 25,
    });
    try {
      // The tick is background work, so the assertion is "eventually", with a
      // generous deadline; it does not depend on the tick firing at a fixed
      // instant, which is what would make it flaky.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && receivedFor(webhookId, 'deployment_run.succeeded').length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      stop();
    }

    const got = receivedFor(webhookId, 'deployment_run.succeeded');
    expect(got).toHaveLength(1);
    expect(runRow(got[0].body.data.id)).toMatchObject({ status: 'created_session', trigger_type: 'scheduled' });
  });
});
