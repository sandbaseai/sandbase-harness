/**
 * Integration test: archiving a deployment publishes `deployment.archived`.
 *
 * Archive is the last write route on a deployment and the one that ends the
 * resource's life, so a receiver that misses it keeps tracking a schedule it
 * should stop. The published table gives it two causes:
 *
 * > `deployment.archived` — 部署已归档，可能是直接归档，也可能是因为其智能体已被归档。
 * > 如果智能体被删除，定时部署会在其下一次计划运行时被归档；没有计划的部署不会自动归档。
 * > — `订阅Webhook.md:62`
 *
 * This file covers the **direct** cause only. The agent-archived cascade does not
 * exist in this runtime and is recorded as a gap in `operations.md` §4 rather than
 * asserted here — a test asserting it would fail, and a test asserting its absence
 * would pin a missing feature as intended.
 *
 * The interesting case is a repeat archive. `archiveById` filters
 * `archived_at IS NULL`, so the second call is a **404**, not a quiet success, and
 * that 404 is how this runtime expresses the no-op rule the published table states
 * for the sibling resource ("对已归档的环境再次归档不会发出任何事件", `:79`). The
 * case asserts both halves, because either alone passes for the wrong reason: a
 * route that never published would satisfy the silence, and a route that published
 * on every call would satisfy the 404.
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
import { CMA_ANTHROPIC_VERSION, CMA_MANAGED_AGENTS_BETA } from '@/core/cma/compatibility.js';

const CMA_HEADERS = {
  'content-type': 'application/json',
  'x-api-key': 'test-key',
  'anthropic-version': CMA_ANTHROPIC_VERSION,
  'anthropic-beta': CMA_MANAGED_AGENTS_BETA,
};

type Received = { body: any; headers: Record<string, string | string[] | undefined> };

describe('deployment.archived', () => {
  let app: ReturnType<typeof createServer>;
  let db: Database;
  let tmpDir: string;
  let receiver: Server;
  let received: Received[];
  let receiverUrl: string;
  /**
   * Whether the row named by a `deployment.archived` reference was already
   * archived **at the moment the event was delivered**.
   *
   * Checking after the route returns would prove nothing: the row is archived by
   * then whichever way round the handler did it. A receiver reacts when the event
   * arrives, so the ordering claim is only meaningful if it is measured then.
   */
  let archivedAtDelivery: boolean[];

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-deployment-archived-'));
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
    archivedAtDelivery = [];
    receiver = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : null;
        received.push({ body, headers: req.headers });
        if (body?.data?.type === 'deployment.archived' && typeof body?.data?.id === 'string') {
          const row = db.prepare('SELECT archived_at FROM scheduled_deployments WHERE id = ?').get(body.data.id) as { archived_at: string | null } | undefined;
          archivedAtDelivery.push(Boolean(row?.archived_at));
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

  async function createDeployment(name: string): Promise<string> {
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: CMA_HEADERS,
      body: JSON.stringify({ name, agent_id: 'agent_one', cron: '0 20 * * 5' }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).id;
  }

  async function archive(path: string) {
    const res = await app.request(path, { method: 'POST', headers: CMA_HEADERS });
    return { status: res.status, body: await res.json() as any };
  }

  function receivedFor(webhookId: string, event: string): Received[] {
    return received.filter((item) => item.body?.data?.type === event && item.headers?.['x-sandbase-webhook-endpoint-id'] === webhookId);
  }

  it('publishes deployment.archived with a reference to the archived deployment', async () => {
    const webhookId = await subscribe(['deployment.archived']);
    const id = await createDeployment('archived-one');

    const res = await archive(`/v1/deployments/${id}/archive`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('archived');
    expect(res.body.archived_at).not.toBeNull();

    const got = receivedFor(webhookId, 'deployment.archived');
    expect(got).toHaveLength(1);
    expect(got[0].body.data).toEqual({ type: 'deployment.archived', id, organization_id: 'org_local', workspace_id: 'wrkspc_local' });
    // The signature header set is the one the dispatcher emits, so this path did
    // not bypass signing.
    expect(got[0].headers['webhook-signature']).toBeDefined();

    // The reference resolves to something already archived at delivery time, which
    // is why the publish sits after the write. Measured inside the receiver,
    // because a read after the route returns would see archived_at either way.
    expect(archivedAtDelivery).toContain(true);
  });

  it('publishes nothing for a repeat archive, which is a 404 and not a quiet success', async () => {
    const webhookId = await subscribe(['deployment.archived']);
    const id = await createDeployment('archived-twice');

    const first = await archive(`/v1/deployments/${id}/archive`);
    expect(first.status).toBe(200);
    expect(receivedFor(webhookId, 'deployment.archived')).toHaveLength(1);

    const second = await archive(`/v1/deployments/${id}/archive`);
    // Both halves are required. The silence alone would be satisfied by a route
    // that never publishes; the 404 alone would be satisfied by a route that
    // publishes on every call. Together they say the second call was not an
    // archive and was not reported as one.
    expect(second.status).toBe(404);
    expect(receivedFor(webhookId, 'deployment.archived')).toHaveLength(1);
  });

  it('publishes nothing and still answers 404 when no deployment has that id', async () => {
    const webhookId = await subscribe(['deployment.archived']);

    const res = await archive('/v1/deployments/sched_does_not_exist/archive');
    expect(res.status).toBe(404);
    expect(res.body.error.type).toBe('not_found');
    expect(receivedFor(webhookId, 'deployment.archived')).toHaveLength(0);
  });

  it('publishes through the local scheduled-deployments spelling too', async () => {
    const webhookId = await subscribe(['deployment.archived']);
    const id = await createDeployment('archived-local');

    const res = await archive(`/v1/scheduled-deployments/${id}/archive`);
    // The route is mounted at both prefixes from one factory, so the event must
    // arrive whichever spelling the caller used.
    expect(res.status).toBe(200);
    expect(receivedFor(webhookId, 'deployment.archived')).toHaveLength(1);
    expect(receivedFor(webhookId, 'deployment.archived')[0].body.data.id).toBe(id);
  });

  it('reaches a subscription that names the event and leaves another family untouched', async () => {
    const named = await subscribe(['deployment.paused', 'deployment.unpaused', 'deployment.updated', 'deployment.archived']);
    const unrelated = await subscribe(['agent.archived']);
    const id = await createDeployment('archived-wild');

    const res = await archive(`/v1/deployments/${id}/archive`);
    expect(res.status).toBe(200);

    // The name flows through list matching rather than a special case.
    expect(receivedFor(named, 'deployment.archived')).toHaveLength(1);
    expect(received.filter((item) => item.headers?.['x-sandbase-webhook-endpoint-id'] === unrelated)).toEqual([]);
  });

  it('completes the archive even when the subscriber cannot be reached', async () => {
    const unreachable = await subscribe(['deployment.archived'], 'http://127.0.0.1:1/hook');
    const reachable = await subscribe(['deployment.archived']);
    const id = await createDeployment('archived-unreachable');

    const res = await archive(`/v1/deployments/${id}/archive`);
    // A receiver that is down must not fail the archive.
    expect(res.status).toBe(200);
    expect(res.body.archived_at).not.toBeNull();

    const failed = db.prepare(
      'SELECT * FROM webhook_deliveries WHERE event = ? AND webhook_id = ?',
    ).all('deployment.archived', unreachable) as unknown as any[];
    expect(failed).toHaveLength(1);
    expect(failed[0].status).not.toBe('delivered');
    expect(receivedFor(reachable, 'deployment.archived')).toHaveLength(1);
  });

  it('archiving an agent does not archive its deployments and publishes no deployment event', async () => {
    const webhookId = await subscribe(['deployment.archived']);
    const id = await createDeployment('archived-agent-cascade');

    // The published row gives `deployment.archived` a second cause — the agent
    // being archived — which this runtime does not implement. This case records
    // the boundary rather than blessing it: it asserts what the code does today so
    // that implementing the cascade later has to update this expectation
    // deliberately instead of discovering it by surprise.
    const agentRes = await app.request('/v1/agents/agent_one/archive', { method: 'POST', headers: CMA_HEADERS });
    expect([200, 404]).toContain(agentRes.status);

    const row = db.prepare('SELECT archived_at FROM scheduled_deployments WHERE id = ?').get(id) as { archived_at: string | null };
    expect(row.archived_at).toBeNull();
    expect(receivedFor(webhookId, 'deployment.archived')).toHaveLength(0);
  });

  it('leaves the webhook archive route publishing nothing while still archiving', async () => {
    // `webhook.*` is not in the published catalog, so it cannot be subscribed;
    // the subscription that could take a leak is the deployment one.
    const webhookId = await subscribe(['deployment.archived']);
    const created = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: CMA_HEADERS,
      body: JSON.stringify({ url: receiverUrl, events: ['deployment.archived'] }),
    });
    expect(created.status).toBe(201);
    const otherWebhookId = (await created.json()).id;

    // The shared helper now reports its outcome, so this case is what shows the
    // refactor did not quietly change the two callers that publish nothing.
    const archived = await archive(`/v1/webhooks/${otherWebhookId}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe('archived');
    expect(archived.body.archived_at).not.toBeNull();

    const deliveries = db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ?').all(otherWebhookId) as unknown as any[];
    expect(deliveries).toEqual([]);
    // The subscription created for this case received nothing either, so the
    // silence is not an artefact of the delivery query.
    expect(received.filter((item) => item.headers?.['x-sandbase-webhook-endpoint-id'] === webhookId && item.body?.data?.type === 'webhook.archived')).toEqual([]);
  });
});
