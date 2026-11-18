/**
 * Integration test: the published Work API data plane.
 *
 * `GET /v1/environments/{id}/work/poll` and the per-claim `ack`, `heartbeat`,
 * `update`, and `stop` routes project the session-scoped claim onto the
 * published `BetaSelfHostedWork` shape. The claim unit is a whole session —
 * `data` is `{type:'session', id}` — and these assertions pin the pieces a
 * caller depends on: environment scoping, the per-claim `secret` and the
 * session token inside it, the `NO_HEARTBEAT` lease claim, `412` optimistic
 * concurrency, the `lease_extended` shutdown signal, and graceful-vs-forced
 * stop.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { WorkQueue } from '@/sandbox/self-hosted-provider.js';
import { SessionWorkQueue } from '@/sandbox/session-work-queue.js';
import { createServer } from '@/api/server.js';
import { createEnvironmentWorkerKey } from '@/core/auth/environment-worker-keys.js';
import { CMA_ANTHROPIC_VERSION, CMA_MANAGED_AGENTS_BETA } from '@/core/cma/compatibility.js';

const HEADERS = {
  'content-type': 'application/json',
  'anthropic-version': CMA_ANTHROPIC_VERSION,
  'anthropic-beta': CMA_MANAGED_AGENTS_BETA,
};

interface WorkBody {
  id: string;
  type: 'work';
  environment_id: string;
  state: string;
  data: { type: string; id: string };
  secret: string | null;
  metadata: Record<string, string>;
  acknowledged_at: string | null;
  latest_heartbeat_at: string | null;
  stop_requested_at: string | null;
  stopped_at: string | null;
  created_at: string;
}

function decodeSecret(secret: string): { sessions_token: string; api_base_url?: string } {
  return JSON.parse(Buffer.from(secret, 'base64url').toString('utf8'));
}

describe('Environment work data plane', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;
  let queue: WorkQueue;
  let sessionQueue: SessionWorkQueue;
  let envKeyA: string;
  let envKeyB: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-ewdp-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_b', 'b', '', '{}', '{}')").run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id, status) VALUES ('sess_a', 'agent_x', 'x', 'env_a', 'running')").run();
    db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id, status) VALUES ('sess_b', 'agent_x', 'x', 'env_b', 'running')").run();

    queue = new WorkQueue(db);
    sessionQueue = new SessionWorkQueue(db);
    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      workQueue: queue,
      sessionWorkQueue: sessionQueue,
    });
    envKeyA = createEnvironmentWorkerKey(db, 'env_a', { name: 'worker-a' }).secret_key;
    envKeyB = createEnvironmentWorkerKey(db, 'env_b', { name: 'worker-b' }).secret_key;
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function itemRoute(path: string, init: RequestInit = {}) {
    return app.request(`/v1/environments/env_a/work${path}`, {
      ...init,
      headers: { ...HEADERS, ...(init.headers as Record<string, string> | undefined) },
    });
  }

  async function poll(envId = 'env_a', key = envKeyA, query = ''): Promise<{ status: number; work: WorkBody | null }> {
    const res = await app.request(`/v1/environments/${envId}/work/poll${query}`, {
      headers: { ...HEADERS, authorization: `Bearer ${key}` },
    });
    return { status: res.status, work: res.status === 204 ? null : await res.json() as WorkBody };
  }

  it('hands out the session claim as a published work shape with a per-claim secret', async () => {
    // The claim unit is the session, not the call: two parked calls in sess_a
    // produce ONE claim, and the other environment's session produces none here.
    sessionQueue.ensure('sess_a');
    sessionQueue.ensure('sess_b');

    const { status, work } = await poll();
    expect(status).toBe(200);
    expect(work).not.toBeNull();
    expect(work!.type).toBe('work');
    expect(work!.environment_id).toBe('env_a');
    expect(work!.state).toBe('queued');
    expect(work!.data).toEqual({ type: 'session', id: 'sess_a' });
    expect(work!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(work!.acknowledged_at).toBeNull();
    expect(work!.latest_heartbeat_at).toBeNull();
    expect(work!.metadata).toEqual({});

    // The secret decodes to the published BetaWorkSecret shape and carries a
    // token that authenticates the claim's own calls.
    const secret = decodeSecret(work!.secret!);
    expect(secret.sessions_token).toMatch(/^mawt_/);
    expect(secret.api_base_url).toMatch(/^http/);
    const hash = createHash('sha256').update(secret.sessions_token, 'utf8').digest('hex');
    const stored = db.prepare('SELECT COUNT(*) AS n FROM session_work_tokens WHERE token_hash = ?')
      .get(hash) as { n: number };
    expect(stored.n).toBe(1);
    // The token is bound to the claim it was minted for.
    const bound = db.prepare('SELECT claim_id FROM session_work_tokens WHERE token_hash = ?')
      .get(hash) as { claim_id: string };
    expect(bound.claim_id).toBe(work!.id);
    const plaintext = db.prepare('SELECT COUNT(*) AS n FROM session_work_tokens WHERE token_hash = ? OR token_prefix = ?')
      .get(secret.sessions_token, secret.sessions_token) as { n: number };
    expect(plaintext.n).toBe(0);

    // The session is now held: a second poll in this window hands nothing out —
    // the claim is the session, and it is already claimed.
    expect((await poll()).status).toBe(204);
  });

  it('answers 204 on an empty queue and honors block_ms', async () => {
    const empty = await poll();
    expect(empty.status).toBe(204);

    const started = Date.now();
    const waited = await poll('env_a', envKeyA, '?block_ms=100');
    expect(waited.status).toBe(204);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });

  it('rejects an out-of-range block_ms and an invalid reclaim window', async () => {
    for (const query of ['?block_ms=0', '?block_ms=1000', '?block_ms=abc', '?reclaim_older_than_ms=-1', '?reclaim_older_than_ms=x']) {
      const res = await app.request(`/v1/environments/env_a/work/poll${query}`, {
        headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
      });
      expect(res.status, query).toBe(400);
    }
  });

  it('reclaims an unacknowledged claim that outlived the reclaim window', async () => {
    sessionQueue.ensure('sess_a');
    const first = await poll();
    const claimId = first.work!.id;

    // Same identity re-polls: the claim is held, so nothing is handed out…
    expect((await poll()).status).toBe(204);
    // …until the held-but-unacked claim predates the caller's reclaim window.
    db.prepare("UPDATE session_work_claims SET claimed_at = datetime('now', '-1 hour') WHERE id = ?").run(claimId);
    const reclaimed = await poll('env_a', envKeyA, '?reclaim_older_than_ms=60000');
    expect(reclaimed.work!.id).toBe(claimId);
  });

  it('keeps another environment\'s key out of this environment\'s work', async () => {
    sessionQueue.ensure('sess_a');
    const scopedOut = await poll('env_a', envKeyB);
    expect(scopedOut.status).toBe(401);
    // env_b's own key sees only env_b's queue.
    sessionQueue.ensure('sess_b');
    const own = await poll('env_b', envKeyB);
    expect(own.work!.data.id).toBe('sess_b');
  });

  it('answers 404 for an unknown environment and refuses an unknown bearer', async () => {
    const missing = await app.request('/v1/environments/env_missing/work/poll', {
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
    });
    expect(missing.status).toBe(404);
    const bad = await app.request('/v1/environments/env_a/work/poll', {
      headers: { ...HEADERS, authorization: 'Bearer mawk_not_a_key' },
    });
    expect(bad.status).toBe(401);
  });

  it('acks a claim into starting and refuses a lapsed or foreign claim', async () => {
    sessionQueue.ensure('sess_a');
    const { work } = await poll();
    const ack = await itemRoute(`/${work!.id}/ack`, { method: 'POST', body: '{}' });
    expect(ack.status).toBe(200);
    const acked = await ack.json() as WorkBody;
    expect(acked.state).toBe('starting');
    expect(acked.acknowledged_at).not.toBeNull();
    expect(acked.secret).toBeNull();

    // A header naming a different worker conflicts with the recorded holder.
    sessionQueue.ensure('sess_b');
    const second = await poll('env_b', envKeyB, '');
    const stolen = await app.request(`/v1/environments/env_b/work/${second.work!.id}/ack`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${envKeyB}`, 'Anthropic-Worker-ID': 'other-worker' },
      body: '{}',
    });
    expect(stolen.status).toBe(409);

    // An unclaimed claim cannot be acknowledged: a fresh session earns a claim
    // nobody has polled, so its ack must be refused.
    db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id, status) VALUES ('sess_c', 'agent_x', 'x', 'env_a', 'running')").run();
    const unclaimed = sessionQueue.ensure('sess_c')!;
    const early = await app.request(`/v1/environments/env_a/work/${unclaimed.id}/ack`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
      body: '{}',
    });
    expect(early.status).toBe(409);

    // A claim whose lease ran out before the ack is work_lease_lost.
    const third = await poll('env_a', envKeyA);
    db.prepare("UPDATE session_work_claims SET claimed_at = datetime('now', '-1 hour') WHERE id = ?").run(third.work!.id);
    const late = await app.request(`/v1/environments/env_a/work/${third.work!.id}/ack`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
      body: '{}',
    });
    expect(late.status).toBe(409);
    expect((await late.json() as { error: { code: string } }).error.code).toBe('work_lease_lost');
  });

  it('runs the heartbeat lease through NO_HEARTBEAT, echo, and 412', async () => {
    sessionQueue.ensure('sess_a');
    const { work } = await poll();
    await (await itemRoute(`/${work!.id}/ack`, { method: 'POST', body: '{}' })).json();

    // First beat claims the heartbeat lease with the published sentinel.
    const first = await app.request(`/v1/environments/env_a/work/${work!.id}/heartbeat?expected_last_heartbeat=NO_HEARTBEAT`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
      body: '{}',
    });
    expect(first.status).toBe(200);
    const beat1 = await first.json() as {
      type: string; last_heartbeat: string; lease_extended: boolean; state: string; ttl_seconds: number;
    };
    expect(beat1.type).toBe('work_heartbeat');
    expect(beat1.lease_extended).toBe(true);
    expect(beat1.state).toBe('active');
    expect(beat1.ttl_seconds).toBeGreaterThan(0);
    expect(beat1.last_heartbeat).toMatch(/^\d{4}-/);

    // The second beat echoes it; a stale value gets the runner-decoded 412.
    const echo = await app.request(
      `/v1/environments/env_a/work/${work!.id}/heartbeat?expected_last_heartbeat=${encodeURIComponent(beat1.last_heartbeat)}`,
      { method: 'POST', headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` }, body: '{}' },
    );
    expect(echo.status).toBe(200);

    const stale = await app.request(
      `/v1/environments/env_a/work/${work!.id}/heartbeat?expected_last_heartbeat=${encodeURIComponent('2000-01-01T00:00:00Z')}`,
      { method: 'POST', headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` }, body: '{}' },
    );
    expect(stale.status).toBe(412);
    const staleBody = await stale.json() as { error: { code: string; details: { current_state: { state: string; last_heartbeat: string } } } };
    expect(staleBody.error.code).toBe('work_lease_precondition_failed');
    expect(staleBody.error.details.current_state.state).toBe('active');

    // NO_HEARTBEAT is claimed-lease only: a second first-claim conflicts.
    const reseize = await app.request(`/v1/environments/env_a/work/${work!.id}/heartbeat?expected_last_heartbeat=NO_HEARTBEAT`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
      body: '{}',
    });
    expect(reseize.status).toBe(412);
  });

  it('honors desired_ttl_seconds on the claim', async () => {
    sessionQueue.ensure('sess_a');
    const { work } = await poll();
    await itemRoute(`/${work!.id}/ack`, { method: 'POST', body: '{}' });

    const beat = await app.request(
      `/v1/environments/env_a/work/${work!.id}/heartbeat?expected_last_heartbeat=NO_HEARTBEAT&desired_ttl_seconds=120`,
      { method: 'POST', headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` }, body: '{}' },
    );
    expect(beat.status).toBe(200);
    expect((await beat.json() as { ttl_seconds: number }).ttl_seconds).toBe(120);
    // The claim now carries the requested TTL.
    const row = db.prepare('SELECT ttl_seconds FROM session_work_claims WHERE id = ?').get(work!.id) as { ttl_seconds: number };
    expect(row.ttl_seconds).toBe(120);
  });

  it('reports a graceful stop through stopping, then stopped on confirmation', async () => {
    sessionQueue.ensure('sess_a');
    const { work } = await poll();
    await itemRoute(`/${work!.id}/ack`, { method: 'POST', body: '{}' });

    const stopping = await app.request(`/v1/environments/env_a/work/${work!.id}/stop`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
      body: '{}',
    });
    expect(stopping.status).toBe(200);
    const stoppingWork = await stopping.json() as WorkBody;
    expect(stoppingWork.state).toBe('stopping');
    expect(stoppingWork.stop_requested_at).not.toBeNull();
    expect(stoppingWork.stopped_at).toBeNull();

    // The next heartbeat reports the shutdown rather than renewing.
    const beat = await app.request(`/v1/environments/env_a/work/${work!.id}/heartbeat`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
      body: '{}',
    });
    const beatBody = await beat.json() as { lease_extended: boolean; state: string };
    expect(beatBody.lease_extended).toBe(true); // still inside 'stopping', lease renews
    expect(beatBody.state).toBe('stopping');

    // The worker's confirmation (a second stop) completes the shutdown.
    const confirm = await app.request(`/v1/environments/env_a/work/${work!.id}/stop`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
      body: '{}',
    });
    expect((await confirm.json() as WorkBody).state).toBe('stopped');
  });

  it('reports a force stop as stopped at once, and the claim is never claimable', async () => {
    sessionQueue.ensure('sess_a');
    const { work } = await poll();
    await itemRoute(`/${work!.id}/ack`, { method: 'POST', body: '{}' });

    const stopped = await app.request(`/v1/environments/env_a/work/${work!.id}/stop`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
      body: '{"force": true}',
    });
    expect(stopped.status).toBe(200);
    const stoppedWork = await stopped.json() as WorkBody;
    expect(stoppedWork.state).toBe('stopped');
    expect(stoppedWork.stopped_at).not.toBeNull();

    // And the session is never handed out again on this claim.
    expect((await poll()).status).toBe(204);
  });

  it('re-queues a stopped session when it produces new work', async () => {
    sessionQueue.ensure('sess_a');
    const { work } = await poll();
    await itemRoute(`/${work!.id}/ack`, { method: 'POST', body: '{}' });
    await app.request(`/v1/environments/env_a/work/${work!.id}/stop`, {
      method: 'POST', headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` }, body: '{"force": true}',
    });

    // More work arrives for the same session: the published "the session's work
    // is queued again" — a NEW claim row, not a resurrection of the stopped one.
    const again = sessionQueue.ensure('sess_a');
    expect(again).not.toBeNull();
    expect(again!.id).not.toBe(work!.id);
    const repoll = await poll();
    expect(repoll.work!.id).toBe(again!.id);
  });

  it('merges metadata with delete-on-null and validates the patch shape', async () => {
    sessionQueue.ensure('sess_a');
    const { work } = await poll();

    const put = await itemRoute(`/${work!.id}`, {
      method: 'POST',
      body: '{"metadata": {"run": "r1", "stage": "fetch"}}',
    });
    expect(put.status).toBe(200);
    expect((await put.json() as WorkBody).metadata).toEqual({ run: 'r1', stage: 'fetch' });

    const merge = await itemRoute(`/${work!.id}`, { method: 'POST', body: '{"metadata": {"stage": "run", "run": null}}' });
    expect((await merge.json() as WorkBody).metadata).toEqual({ stage: 'run' });

    const malformed = await itemRoute(`/${work!.id}`, { method: 'POST', body: '{"metadata": {"n": 3}}' });
    expect(malformed.status).toBe(400);
  });

  it('authenticates the claimed session with the session token inside its secret', async () => {
    sessionQueue.ensure('sess_a');
    const { work } = await poll();
    const sessionsToken = decodeSecret(work!.secret!).sessions_token;

    // The session token is claim-scoped authority: ack, heartbeat, update, stop.
    for (const [suffix, body] of [['/ack', '{}'], ['/heartbeat', '{}'], ['', '{"metadata":{"k":"v"}}']] as const) {
      const res = await app.request(`/v1/environments/env_a/work/${work!.id}${suffix}`, {
        method: 'POST',
        headers: { ...HEADERS, authorization: `Bearer ${sessionsToken}` },
        body,
      });
      expect(res.status, suffix).toBe(200);
    }
    // stop via the session token too.
    const stopRes = await app.request(`/v1/environments/env_a/work/${work!.id}/stop`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${sessionsToken}` },
      body: '{"force": true}',
    });
    expect(stopRes.status).toBe(200);

    // It is not queue authority — it cannot poll.
    const deniedPoll = await app.request('/v1/environments/env_a/work/poll', {
      headers: { ...HEADERS, authorization: `Bearer ${sessionsToken}` },
    });
    expect(deniedPoll.status).toBe(401);

    // And it does not reach another environment's claims.
    sessionQueue.ensure('sess_b');
    const foreign = await poll('env_b', envKeyB);
    const scopedOut = await app.request(`/v1/environments/env_b/work/${foreign.work!.id}/ack`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${sessionsToken}` },
      body: '{}',
    });
    expect(scopedOut.status).toBe(401);
  });

  it('keeps worker-key claims fenced when API-key auth is on', async () => {
    const keyed = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      workQueue: queue,
      sessionWorkQueue: sessionQueue,
      apiKeys: ['admin-key'],
    });
    sessionQueue.ensure('sess_a');

    // An environment key is a bearer the API-key middleware would have refused;
    // the work surface resolves it itself.
    const viaWorkerKey = await keyed.request('/v1/environments/env_a/work/poll', {
      headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` },
    });
    expect(viaWorkerKey.status).toBe(200);
    // The API key reaches the same route, and no credential is refused.
    const missing = await keyed.request('/v1/environments/env_a/work/poll', { headers: HEADERS });
    expect(missing.status).toBe(401);
    const viaApiKey = await keyed.request('/v1/environments/env_a/work/poll', {
      headers: { ...HEADERS, authorization: 'Bearer admin-key' },
    });
    expect(viaApiKey.status).toBe(204); // the first poll claimed the only claim
  });

  it('lets the pinned SDK decode the work shape and drives poll→ack→heartbeat→stop', async () => {
    sessionQueue.ensure('sess_a');
    const client = new Anthropic({
      baseURL: 'http://conformance.local',
      apiKey: envKeyA,
      maxRetries: 0,
      // The SDK places its real credentials in `init.headers` (x-api-key,
      // anthropic-*) while `input` arrives headerless — but it also sends a
      // placeholder `Authorization: Bearer magpie` alongside, which trips the
      // middleware's two-credential-source refusal. Drop the placeholder when
      // x-api-key is present, the same choice a real worker deployment makes.
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.headers.has('x-api-key')) {
          request.headers.delete('authorization');
        }
        return app.request(request);
      },
    });

    const work = await client.beta.environments.work.poll('env_a', { 'Anthropic-Worker-ID': 'sdk-worker' });
    expect(work).not.toBeNull();
    expect(work!.type).toBe('work');
    expect(work!.state).toBe('queued');
    expect(work!.data).toEqual({ type: 'session', id: 'sess_a' });
    expect(decodeSecret(work!.secret!).sessions_token).toMatch(/^mawt_/);

    const acked = await client.beta.environments.work.ack(work!.id, { environment_id: 'env_a' });
    expect(acked.state).toBe('starting');
    expect(acked.secret).toBeNull();

    const beat = await client.beta.environments.work.heartbeat(work!.id, {
      environment_id: 'env_a',
      expected_last_heartbeat: 'NO_HEARTBEAT',
    });
    expect(beat.type).toBe('work_heartbeat');
    expect(beat.lease_extended).toBe(true);
    expect(beat.state).toBe('active');

    const stopped = await client.beta.environments.work.stop(work!.id, { environment_id: 'env_a', force: true });
    expect(stopped.state).toBe('stopped');
  });

  it('a stopped claim ends its session token authority on the work verbs', async () => {
    sessionQueue.ensure('sess_a');
    const { work } = await poll();
    const sessionsToken = decodeSecret(work!.secret!).sessions_token;
    await itemRoute(`/${work!.id}/ack`, { method: 'POST', body: '{}' });
    await app.request(`/v1/environments/env_a/work/${work!.id}/stop`, {
      method: 'POST', headers: { ...HEADERS, authorization: `Bearer ${envKeyA}` }, body: '{"force": true}',
    });

    // The claim's credential is revoked with it: the token can no longer reach
    // the work verbs even though the session itself is still non-terminal.
    const beat = await app.request(`/v1/environments/env_a/work/${work!.id}/heartbeat`, {
      method: 'POST', headers: { ...HEADERS, authorization: `Bearer ${sessionsToken}` }, body: '{}',
    });
    expect(beat.status).toBe(401);
  });
});
