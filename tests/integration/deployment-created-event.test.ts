/**
 * Integration test: creating a deployment publishes `deployment.created`.
 *
 * Creation is the first thing that happens to a deployment and the one event a
 * receiver cannot reconstruct from any other. `deployment.updated` reports changes
 * to something that already existed, so a subscriber that starts after the create
 * but before the first update has no way to learn the deployment is there at all.
 * The published table lists the event (`订阅Webhook.md:58`).
 *
 * Two properties carry most of the weight. A create that was **refused** publishes
 * nothing, because there is no id to name and an event pointing at a row that was
 * never inserted would send a receiver to a 404. And a deployment created already
 * `paused` publishes only this event, not a pause event: the pause events report a
 * transition, and nothing moved.
 *
 * Delivery is asserted against a real HTTP receiver on an ephemeral loopback port,
 * and every assertion is scoped to the subscription its own case created — the
 * fixture is shared and one event is delivered to every matching subscription.
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
describe('deployment.created', () => {
  let app: ReturnType<typeof createServer>;
  let db: Database;
  let tmpDir: string;
  let receiver: Server;
  let received: Received[];
  let receiverUrl: string;
  /**
   * Whether the row named by a `deployment.created` reference existed **at the
   * moment the event was delivered**.
   *
   * Checking this after the create returns would prove nothing: the row exists by
   * then regardless of the order inside the handler. A receiver reacts when the
   * event arrives, so the ordering claim is only meaningful if it is measured
   * then — which means asking the database from inside the receiver.
   */
  let resolvableAtDelivery: boolean[];

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-deployment-created-'));
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
    resolvableAtDelivery = [];
    receiver = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : null;
        received.push({ body, headers: req.headers });
        if (body?.data?.type === 'deployment.created' && typeof body?.data?.id === 'string') {
          const row = db.prepare('SELECT id FROM scheduled_deployments WHERE id = ?').get(body.data.id);
          resolvableAtDelivery.push(Boolean(row));
        }
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

  async function create(body: Record<string, unknown>, path = '/v1/deployments') {
    const res = await app.request(path, { method: 'POST', headers: CMA_HEADERS, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  function receivedFor(webhookId: string, event: string): Received[] {
    return received.filter((item) => item.body?.data?.type === event && item.headers?.['x-sandbase-webhook-endpoint-id'] === webhookId);
  }

  it('publishes deployment.created with a reference to the new deployment', async () => {
    const webhookId = await subscribe(['deployment.created']);

    const res = await create({ name: 'created-one', agent_id: 'agent_one', cron: '0 20 * * 5' });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('scheduled_deployment');

    const got = receivedFor(webhookId, 'deployment.created');
    expect(got).toHaveLength(1);
    expect(got[0].body.data).toEqual({ type: 'deployment.created', id: res.body.id, organization_id: 'org_local', workspace_id: 'wrkspc_local' });
    // The signature header set is the one the dispatcher emits, so this path did
    // not bypass signing.
    expect(got[0].headers['webhook-signature']).toBeDefined();

    // The reference resolves: the row existed when the event was delivered, which
    // is why the publish sits after the insert. Measured inside the receiver,
    // because a read after the create returns would find the row either way.
    expect(resolvableAtDelivery).toContain(true);

    const read = await app.request(`/v1/deployments/${res.body.id}`, { headers: CMA_HEADERS });
    expect(read.status).toBe(200);
  });

  it('publishes nothing when the create is refused for a missing name', async () => {
    const webhookId = await subscribe(['deployment.created']);

    const res = await create({ agent_id: 'agent_one', cron: '0 20 * * 5' });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
    expect(receivedFor(webhookId, 'deployment.created')).toHaveLength(0);
  });

  it('publishes nothing when the create is refused for a missing agent_id', async () => {
    const webhookId = await subscribe(['deployment.created']);

    const res = await create({ name: 'no-agent', cron: '0 20 * * 5' });
    expect(res.status).toBe(400);
    expect(receivedFor(webhookId, 'deployment.created')).toHaveLength(0);
  });

  it('publishes nothing when the create is refused for a schedule with the wrong field count', async () => {
    const webhookId = await subscribe(['deployment.created']);

    // Four fields. Note what this does *not* claim: `parseScheduleFields` checks
    // the field count and the time zone, not the content of each field, so a
    // five-token expression whose tokens are not cron runs is accepted here and
    // only fails later when the next run is computed. That is existing behaviour
    // and outside this change; the case below therefore uses a refusal the route
    // actually performs, rather than the one I first assumed it did.
    const res = await create({ name: 'bad-cron', agent_id: 'agent_one', cron: '0 20 * *' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('five fields');
    expect(receivedFor(webhookId, 'deployment.created')).toHaveLength(0);
  });

  it('publishes nothing when the create is refused for an invalid time zone', async () => {
    const webhookId = await subscribe(['deployment.created']);

    const res = await create({ name: 'bad-tz', agent_id: 'agent_one', cron: '0 20 * * 5', timezone: 'Mars/Olympus' });
    expect(res.status).toBe(400);
    expect(receivedFor(webhookId, 'deployment.created')).toHaveLength(0);
  });

  it('publishes nothing when the create is refused for a body that is not an object', async () => {
    const webhookId = await subscribe(['deployment.created']);

    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: CMA_HEADERS,
      body: JSON.stringify(['not', 'an', 'object']),
    });
    expect(res.status).toBe(400);
    expect(receivedFor(webhookId, 'deployment.created')).toHaveLength(0);
  });

  it('publishes only deployment.created for a deployment created already paused', async () => {
    const webhookId = await subscribe(['deployment.created', 'deployment.paused', 'deployment.unpaused']);

    const res = await create({ name: 'born-paused', agent_id: 'agent_one', cron: '0 20 * * 5', status: 'paused' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('paused');
    expect(res.body.paused_reason).toEqual({ type: 'manual' });

    expect(receivedFor(webhookId, 'deployment.created')).toHaveLength(1);
    // No transition happened, so no transition event: the receiver learns the
    // status by resolving the created reference, which is the published mechanism.
    expect(receivedFor(webhookId, 'deployment.paused')).toHaveLength(0);
    expect(receivedFor(webhookId, 'deployment.unpaused')).toHaveLength(0);
  });

  it('publishes through the local scheduled-deployments spelling too', async () => {
    const webhookId = await subscribe(['deployment.created']);

    const res = await create({ name: 'created-local', agent_id: 'agent_one', cron: '0 20 * * 5' }, '/v1/scheduled-deployments');
    expect(res.status).toBe(201);
    expect(receivedFor(webhookId, 'deployment.created')).toHaveLength(1);
    expect(receivedFor(webhookId, 'deployment.created')[0].body.data.id).toBe(res.body.id);
  });

  it('reaches a subscription that names the event and leaves another family untouched', async () => {
    const named = await subscribe(['deployment.paused', 'deployment.unpaused', 'deployment.updated', 'deployment.created']);
    const unrelated = await subscribe(['agent.created']);

    const res = await create({ name: 'created-wild', agent_id: 'agent_one', cron: '0 20 * * 5' });
    expect(res.status).toBe(201);

    // The name flows through list matching rather than a special case.
    expect(receivedFor(named, 'deployment.created')).toHaveLength(1);
    const everything = received.filter((item) => item.headers?.['x-sandbase-webhook-endpoint-id'] === unrelated);
    expect(everything).toEqual([]);
  });

  it('completes the create even when the subscriber cannot be reached', async () => {
    const unreachable = await subscribe(['deployment.created'], 'http://127.0.0.1:1/hook');
    const reachable = await subscribe(['deployment.created']);

    const res = await create({ name: 'created-unreachable', agent_id: 'agent_one', cron: '0 20 * * 5' });
    // The row is committed and 201 is returned either way: a receiver that is down
    // must not fail a create.
    expect(res.status).toBe(201);

    const failed = db.prepare(
      'SELECT * FROM webhook_deliveries WHERE event = ? AND webhook_id = ?',
    ).all('deployment.created', unreachable) as unknown as any[];
    expect(failed).toHaveLength(1);
    expect(failed[0].status).not.toBe('delivered');
    // The reachable subscriber still got it, so the two are independent.
    expect(receivedFor(reachable, 'deployment.created')).toHaveLength(1);
  });
});