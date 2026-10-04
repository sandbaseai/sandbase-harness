/**
 * The webhook event catalog as a public contract.
 *
 * Two halves:
 *
 * - Subscription validation. Only catalog names may be stored — `*`,
 *   `prefix.*`, and unknown names are refused with 400 on both create and
 *   update, because a stored subscription that can never fire reads as a
 *   working one.
 * - Emission. The session stream reaches subscribers only through
 *   `webhookEventsForSessionEvent`, resource routes publish on transitions,
 *   and the no-op/idempotency rules hold: unchanged updates and repeated
 *   archives raise nothing, `agent.updated` fires only on a new version, a
 *   vault archive raises one `vault_credential.archived` per credential, and
 *   `session.budget_reached` deduplicates per (session, budget value).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { createWebhookEventListener, webhookSigningSecret } from '@/api/operations-bridge.js';
import { OFFICIAL_WEBHOOK_EVENTS } from '@/core/operations/webhook-events.js';

const WEBHOOK_SECRET = webhookSigningSecret(undefined);

describe('webhook event catalog', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;
  let sessionManager: SessionManager;

  async function postJson(path: string, body: unknown, method = 'POST') {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-webhook-catalog-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare(
      `INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{"sandbox_provider":"local"}')`,
    ).run();
    sessionManager = new SessionManager(db);
    app = createServer({
      db,
      sessionManager,
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

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('subscription validation', () => {
    const subscribe = (events: string[]) =>
      postJson('/v1/webhooks', { url: 'https://example.test/hook', events });

    it('refuses wildcards on create', async () => {
      for (const events of [['*'], ['session.*'], ['deployment.*']]) {
        const { status, body } = await subscribe(events);
        expect(status, JSON.stringify(body)).toBe(400);
      }
      // And none of them were stored.
      const listed = await app.request('/v1/webhooks');
      expect(((await listed.json()) as any).data).toHaveLength(0);
    });

    it('refuses names outside the catalog on create', async () => {
      const { status, body } = await subscribe(['turn_complete', 'bogus.event']);
      expect(status).toBe(400);
      expect(JSON.stringify(body)).toContain('turn_complete');
    });

    it('accepts every name in the catalog', async () => {
      const { status, body } = await subscribe([...OFFICIAL_WEBHOOK_EVENTS]);
      expect(status, JSON.stringify(body)).toBe(201);
      expect(body.events).toEqual([...OFFICIAL_WEBHOOK_EVENTS]);
    });

    it('refuses wildcards and unknown names on update', async () => {
      const { body: created } = await subscribe(['session.created']);
      const before = JSON.stringify(created.events);

      const wildcard = await postJson(`/v1/webhooks/${created.id}`, { events: ['*'] }, 'PUT');
      expect(wildcard.status).toBe(400);
      const unknown = await postJson(`/v1/webhooks/${created.id}`, { events: ['turn_complete'] }, 'PUT');
      expect(unknown.status).toBe(400);

      // A refused update leaves the stored subscription alone.
      const read = await app.request(`/v1/webhooks/${created.id}`);
      expect(JSON.stringify(((await read.json()) as any).events)).toBe(before);

      const accepted = await postJson(`/v1/webhooks/${created.id}`, { events: ['agent.created'] }, 'PUT');
      expect(accepted.status).toBe(200);
      expect(accepted.body.events).toEqual(['agent.created']);
    });
  });

  describe('session stream projection', () => {
    let requests: Array<{ url: string; body: string }>;
    let listener: (event: any) => void;

    function recordingFetch() {
      return (async (url: unknown, init: any) => {
        requests.push({ url: String(url), body: String(init?.body ?? '') });
        return new Response(null, { status: 204 });
      }) as typeof fetch;
    }

    /** A durable event the way the broadcast delivers one. */
    function streamEvent(type: string, metadata?: Record<string, unknown>) {
      return {
        id: `sevt_${Math.random().toString(36).slice(2, 18)}`,
        sessionId: 'sess_c',
        seq: 1,
        type,
        metadata,
        tokensIn: 0,
        tokensOut: 0,
        delegationDepth: 0,
        createdAt: new Date(),
      };
    }

    function subscribe(events: string[]) {
      db.prepare(
        `INSERT INTO webhooks (id, name, url, events, description, status, metadata, created_at, updated_at)
         VALUES ('wh_cat', 'catalog', 'https://hooks.example.test/x', ?, '', 'active', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run(JSON.stringify(events));
      db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_c', 'c', '{}')").run();
      db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id, budget) VALUES ('sess_c', 'agent_c', 'c', 'env_default', '{\"limit\":5}')").run();
      requests = [];
      listener = createWebhookEventListener({
        db,
        webhookSecret: WEBHOOK_SECRET,
        fetchImpl: recordingFetch(),
      });
    }

    const deliveredTypes = () => requests.map((r) => (JSON.parse(r.body) as any).data.type);

    it('delivers only the published names a stream event maps to', async () => {
      subscribe(['session.status_run_started', 'session.status_idled', 'agent.message', 'session.created']);

      listener(streamEvent('session.status_running'));
      listener(streamEvent('agent.message'));
      listener(streamEvent('span.model_request_start'));
      listener(streamEvent('session.status_idle'));
      await sleep(30);

      // The run and the idle arrive under their published names; the internal
      // traffic raises nothing even though `agent.message` was subscribed.
      expect(deliveredTypes()).toEqual(['session.status_run_started', 'session.status_idled']);
    });

    it('emits session.budget_reached once per budget value', async () => {
      subscribe(['session.budget_reached', 'session.status_idled']);
      const idleOnBudget = () => streamEvent('session.status_idle', {
        stop_reason: { type: 'budget_reached' },
      });

      listener(idleOnBudget());
      listener(idleOnBudget());
      await sleep(30);
      expect(deliveredTypes().filter((t) => t === 'session.budget_reached')).toHaveLength(1);

      // Raising the ceiling is a new allowance: the next idle on it reports again.
      db.prepare("UPDATE sessions SET budget = '{\"limit\":10}' WHERE id = 'sess_c'").run();
      listener(idleOnBudget());
      await sleep(30);
      expect(deliveredTypes().filter((t) => t === 'session.budget_reached')).toHaveLength(2);
    });
  });

  describe('resource lifecycle events', () => {
    function countDeliveries(event: string) {
      return (db.prepare(
        "SELECT COUNT(*) AS n FROM webhook_deliveries WHERE event = ?",
      ).get(event) as { n: number }).n;
    }

    beforeEach(() => {
      // Port 1 refuses immediately; the dispatcher still records the attempt,
      // which is what the assertions count.
      db.prepare(
        `INSERT INTO webhooks (id, name, url, events, description, status, metadata, created_at, updated_at)
         VALUES ('wh_res', 'resources', 'http://127.0.0.1:1/hook', ?, '', 'active', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run(JSON.stringify([...OFFICIAL_WEBHOOK_EVENTS]));
    });

    it('fires environment.created/updated/archived/deleted and no event on a no-op update', async () => {
      const created = await postJson('/v1/environments', { name: 'hooks-env' });
      expect(created.status).toBe(201);
      await sleep(30);
      expect(countDeliveries('environment.created')).toBe(1);

      // Re-sending the stored values is not a transition.
      await postJson(`/v1/environments/${created.body.id}`, { name: 'hooks-env' });
      await sleep(30);
      expect(countDeliveries('environment.updated')).toBe(0);

      await postJson(`/v1/environments/${created.body.id}`, { name: 'hooks-env-2' });
      await sleep(30);
      expect(countDeliveries('environment.updated')).toBe(1);

      const archive = await app.request(`/v1/environments/${created.body.id}/archive`, { method: 'POST' });
      expect(archive.status).toBe(200);
      const rearchive = await app.request(`/v1/environments/${created.body.id}/archive`, { method: 'POST' });
      expect(rearchive.status).toBe(404);
      await sleep(30);
      expect(countDeliveries('environment.archived')).toBe(1);
    });

    it('fires agent.created once, and agent.updated only when a new version is written', async () => {
      const created = await postJson('/v1/agents', {
        name: 'hooks-agent',
        description: 'a',
        model: 'gpt-4o',
        system: 'Handle requests.',
      });
      expect(created.status).toBe(201);
      await sleep(30);
      expect(countDeliveries('agent.created')).toBe(1);

      // Same definition back: no new version, no event.
      const same = await postJson(`/v1/agents/${created.body.id}`, {
        name: 'hooks-agent',
        description: 'a',
        model: 'gpt-4o',
        system: 'Handle requests.',
      }, 'PUT');
      expect(same.status).toBe(200);
      await sleep(30);
      expect(countDeliveries('agent.updated')).toBe(0);

      const changed = await postJson(`/v1/agents/${created.body.id}`, {
        name: 'hooks-agent',
        description: 'b',
        model: 'gpt-4o',
        system: 'Handle requests.',
      }, 'PUT');
      expect(changed.status).toBe(200);
      await sleep(30);
      expect(countDeliveries('agent.updated')).toBe(1);
    });

    it('fires vault_credential.archived once per credential alongside vault.archived', async () => {
      const vault = await postJson('/v1/credential-vaults', { name: 'hooks-vault' });
      expect(vault.status).toBe(201);
      for (const name of ['cred-a', 'cred-b']) {
        const cred = await postJson(`/v1/credential-vaults/${vault.body.id}/credentials`, {
          name,
          auth_type: 'environment_variable',
          variable_name: `VAR_${name}`,
          value: 'secret-value',
        });
        expect(cred.status).toBe(201);
      }
      await sleep(30);
      expect(countDeliveries('vault.created')).toBe(1);
      expect(countDeliveries('vault_credential.created')).toBe(2);

      const archived = await app.request(`/v1/credential-vaults/${vault.body.id}/archive`, { method: 'POST' });
      expect(archived.status).toBe(200);
      const rearchive = await app.request(`/v1/credential-vaults/${vault.body.id}/archive`, { method: 'POST' });
      expect(rearchive.status).toBe(404);
      await sleep(30);
      expect(countDeliveries('vault.archived')).toBe(1);
      expect(countDeliveries('vault_credential.archived')).toBe(2);
    });

    it('fires memory_store.created, memory_store.archived, and memory_store.deleted', async () => {
      const created = await postJson('/v1/memory_stores', { name: 'hooks-store' });
      expect(created.status).toBe(201);
      const archived = await app.request(`/v1/memory_stores/${created.body.id}/archive`, { method: 'POST' });
      expect(archived.status).toBe(200);
      const rearchive = await app.request(`/v1/memory_stores/${created.body.id}/archive`, { method: 'POST' });
      expect(rearchive.status).toBe(404);
      const deleted = await app.request(`/v1/memory_stores/${created.body.id}`, { method: 'DELETE' });
      expect(deleted.status).toBe(200);
      await sleep(30);
      expect(countDeliveries('memory_store.created')).toBe(1);
      expect(countDeliveries('memory_store.archived')).toBe(1);
      expect(countDeliveries('memory_store.deleted')).toBe(1);
    });
  });
});
