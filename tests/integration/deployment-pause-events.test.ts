/**
 * Integration test: pausing and resuming a deployment publishes a webhook event.
 *
 * The pause lifecycle was durable and silent: `POST /{id}/pause` set `status` and
 * `paused_reason` and returned, so a subscriber that asked to be told when a
 * deployment stops producing runs had to poll. The published event table lists
 * `deployment.paused` and `deployment.unpaused`, and the published description of
 * `deployment.paused` covers *both* a requested pause and the automatic pause the
 * runtime does not implement yet — which is the reason to build the publishing
 * path now, so the automatic cause emits through it rather than beside it.
 *
 * Delivery is asserted against a real HTTP receiver bound to an ephemeral
 * loopback port, not against a delivery row alone. A row proves the dispatcher was
 * asked; the received request proves the event reached a subscriber, which is the
 * behaviour that was missing. The row is asserted too, because it is the record a
 * receiver that was down would be retried from.
 *
 * Every assertion is scoped to the subscription a case created. The fixture is
 * shared and the receiver accumulates, and a pause is delivered to *every*
 * matching active subscription — so a count taken over the whole table measures
 * the other cases as much as this one. The first version of this file did exactly
 * that and passed for the wrong reason until its own no-op case failed; the
 * scoping is what makes these cases independent.
 *
 * The no-op cases matter more than they look. The pause route is deliberately
 * idempotent, so "pause an already-paused deployment" is the ordinary retry path,
 * and an event there would report a change that did not happen.
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
import { CMA_ANTHROPIC_VERSION, CMA_MANAGED_AGENTS_BETA } from '@/core/cma/compatibility.js';

const CMA_HEADERS = {
  'content-type': 'application/json',
  'x-api-key': 'test-key',
  'anthropic-version': CMA_ANTHROPIC_VERSION,
  'anthropic-beta': CMA_MANAGED_AGENTS_BETA,
};

type Received = { body: any; headers: Record<string, string | string[] | undefined> };

describe('Deployment pause webhook events', () => {
  let app: ReturnType<typeof createServer>;
  let db: Database;
  let tmpDir: string;
  let receiver: Server;
  let received: Received[];
  let receiverUrl: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-deploy-events-'));
    const agentsDir = join(tmpDir, 'agents');
    const skillsDir = join(tmpDir, 'skills');
    const dataDir = join(tmpDir, '.managed-agents');
    const configPath = join(dataDir, 'config.yaml');
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(configPath, 'model:\n  provider: openai\n  api_key: secret-value\n');

    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_one', 'one', '{}')`);

    const sessionManager = new SessionManager(db);
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
        received.push({ body: raw ? JSON.parse(raw) : null, headers: req.headers });
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

  async function createDeployment(name: string): Promise<string> {
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: CMA_HEADERS,
      body: JSON.stringify({ name, agent_id: 'agent_one', cron: '0 20 * * 5' }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).id;
  }

  async function post(path: string) {
    const res = await app.request(path, { method: 'POST', headers: CMA_HEADERS });
    return { status: res.status, body: await res.json() };
  }

  /** Deliveries recorded for one subscription, which is what makes a case independent. */
  function deliveriesFor(webhookId: string, event: string): any[] {
    return db.prepare(
      'SELECT * FROM webhook_deliveries WHERE event = ? AND webhook_id = ?',
    ).all(event, webhookId) as unknown as any[];
  }

  /** Events the receiver took for one subscription. */
  function receivedFor(webhookId: string, event: string): Received[] {
    return received.filter((item) => item.body?.data?.type === event && item.headers?.['x-sandbase-webhook-endpoint-id'] === webhookId);
  }

  it('publishes deployment.paused to a subscriber, carrying a reference to the deployment', async () => {
    const webhookId = await subscribe(['deployment.paused']);
    const id = await createDeployment('pause-me');

    const res = await post(`/v1/deployments/${id}/pause`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paused');

    // The event reached a real receiver.
    const got = receivedFor(webhookId, 'deployment.paused');
    expect(got).toHaveLength(1);
    // A reference, not the object: the published contract says a body carries the
    // event's type and id and the receiver fetches current state itself.
    expect(got[0].body.data).toEqual({ type: 'deployment.paused', id, organization_id: 'org_local', workspace_id: 'wrkspc_local' });
    // The signature header set is the one the dispatcher already emits, so this
    // path did not bypass signing.
    expect(got[0].headers['webhook-id']).toBeDefined();
    expect(got[0].headers['webhook-signature']).toBeDefined();

    // The delivery is recorded too, which is what a retry sweep works from.
    const rows = deliveriesFor(webhookId, 'deployment.paused');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('delivered');
  });

  it('publishes deployment.unpaused when the schedule resumes', async () => {
    const webhookId = await subscribe(['deployment.unpaused']);
    const id = await createDeployment('resume-me');
    await post(`/v1/deployments/${id}/pause`);

    const res = await post(`/v1/deployments/${id}/unpause`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.paused_reason).toBeNull();

    const got = receivedFor(webhookId, 'deployment.unpaused');
    expect(got).toHaveLength(1);
    expect(got[0].body.data).toEqual({ type: 'deployment.unpaused', id, organization_id: 'org_local', workspace_id: 'wrkspc_local' });
  });

  it('publishes nothing when the pause changes nothing', async () => {
    const webhookId = await subscribe(['deployment.paused']);
    const id = await createDeployment('double-pause');
    await post(`/v1/deployments/${id}/pause`);
    expect(receivedFor(webhookId, 'deployment.paused')).toHaveLength(1);

    // Idempotent by design, so this is the ordinary retry path rather than an
    // edge case. An event here would report a change that did not happen.
    const again = await post(`/v1/deployments/${id}/pause`);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('paused');
    expect(receivedFor(webhookId, 'deployment.paused')).toHaveLength(1);
    expect(deliveriesFor(webhookId, 'deployment.paused')).toHaveLength(1);
  });

  it('publishes nothing when the resume changes nothing', async () => {
    const webhookId = await subscribe(['deployment.unpaused']);
    const id = await createDeployment('double-unpause');

    const res = await post(`/v1/deployments/${id}/unpause`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(receivedFor(webhookId, 'deployment.unpaused')).toHaveLength(0);
    expect(deliveriesFor(webhookId, 'deployment.unpaused')).toHaveLength(0);
  });

  it('publishes through the local scheduled-deployments spelling too', async () => {
    const webhookId = await subscribe(['deployment.paused']);
    const id = await createDeployment('local-spelling');

    const res = await post(`/v1/scheduled-deployments/${id}/pause`);
    expect(res.status).toBe(200);
    // Same handler behind one factory mounted twice, so the event is emitted by
    // the code path rather than by one prefix.
    expect(receivedFor(webhookId, 'deployment.paused')).toHaveLength(1);
  });

  it('reaches a subscription that names the event and leaves an unrelated one untouched', async () => {
    const named = await subscribe(['deployment.paused', 'deployment.unpaused', 'deployment.updated', 'deployment.archived']);
    const unrelated = await subscribe(['agent.created']);
    const id = await createDeployment('wildcards');

    await post(`/v1/deployments/${id}/pause`);

    // The name flows through list matching rather than a special case.
    expect(receivedFor(named, 'deployment.paused')).toHaveLength(1);
    // Nothing at all reached the subscriber on another family — asserted over every
    // event it could have taken, not just the two new names.
    const everything = received.filter((item) => item.headers?.['x-sandbase-webhook-endpoint-id'] === unrelated);
    expect(everything).toEqual([]);
  });

  it('delivers to every matching subscription, not the first', async () => {
    const first = await subscribe(['deployment.paused']);
    const second = await subscribe(['deployment.paused', 'deployment.unpaused']);
    const id = await createDeployment('two-subscribers');

    await post(`/v1/deployments/${id}/pause`);

    expect(receivedFor(first, 'deployment.paused')).toHaveLength(1);
    expect(receivedFor(second, 'deployment.paused')).toHaveLength(1);
  });

  it('completes the pause even when the subscriber cannot be reached', async () => {
    // Port 1 on loopback refuses immediately, so this fails fast without network
    // egress. A receiver that is down must not turn a completed control-plane
    // change into an error.
    const webhookId = await subscribe(['deployment.paused'], 'http://127.0.0.1:1/hook');
    const id = await createDeployment('unreachable');

    const res = await post(`/v1/deployments/${id}/pause`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paused');

    const row = db.prepare('SELECT status FROM scheduled_deployments WHERE id = ?').get(id) as any;
    expect(row.status).toBe('paused');
    // The failed attempt is recorded rather than lost, which is what the retry
    // sweep acts on.
    const failed = deliveriesFor(webhookId, 'deployment.paused');
    expect(failed).toHaveLength(1);
    expect(failed[0].status).not.toBe('delivered');
  });
});
