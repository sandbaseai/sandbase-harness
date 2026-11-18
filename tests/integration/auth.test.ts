/**
 * Integration test: API authentication (F1).
 *
 * Verifies:
 * - auth disabled by default (no keys) → all routes open
 * - auth enabled (keys configured) → /v1 routes require Bearer token
 * - public paths (/, /dashboard, /dashboard/assets/*, /v1/x/health) stay open even when auth is enabled
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { countActiveManagedApiKeys, validateManagedApiKey } from '@/core/auth/api-keys.js';

function makeApp(apiKeys?: string[], corsOrigins: string[] = []) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ma-auth-'));
  const db = new Database(join(tmpDir, 'test.db'));
  db.runMigrations();
  db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
  db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_a', 'a', '{}')`);
  const app = createServer({
    db,
    sessionManager: new SessionManager(db),
    agents: [{ name: 'a', model: 'm', system: 'p' }],
    apiKeys,
    corsOrigins,
    reloadAgents: () => ({ agents: [], errors: [] }),
  });
  return { app, db, tmpDir };
}

function makeDynamicApp() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ma-auth-dynamic-'));
  const db = new Database(join(tmpDir, 'test.db'));
  db.runMigrations();
  db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
  db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_a', 'a', '{}')`);
  const app = createServer({
    db,
    sessionManager: new SessionManager(db),
    agents: [{ name: 'a', model: 'm', system: 'p' }],
    hasApiKeys: () => countActiveManagedApiKeys(db) > 0,
    validateApiKey: (key) => validateManagedApiKey(db, key),
    runtime: {
      models: [],
      sandboxProviders: ['local'],
      memory: 'disabled',
      authEnabled: false,
    },
    reloadAgents: () => ({ agents: [], errors: [] }),
  });
  return { app, db, tmpDir };
}

describe('API authentication', () => {
  describe('auth disabled (default)', () => {
    let ctx: ReturnType<typeof makeApp>;
    beforeEach(() => { ctx = makeApp(); });
    afterEach(() => { ctx.db.close(); rmSync(ctx.tmpDir, { recursive: true, force: true }); });

    it('allows /v1/agents without a token', async () => {
      const res = await ctx.app.request('/v1/agents');
      expect(res.status).toBe(200);
    });

    it('rejects duplicate credential sources even when auth is disabled or the path is public', async () => {
      const duplicateHeaders = {
        Authorization: 'Bearer secret-key-1',
        'x-api-key': 'secret-key-1',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'managed-agents-2026-04-01',
      };
      const expected = {
        error: {
          type: 'authentication_error',
          message: 'Missing or invalid API key. Provide exactly one of "Authorization: Bearer <key>" or "x-api-key: <key>".',
        },
      };

      const disabled = await ctx.app.request('/v1/agents', { headers: duplicateHeaders });
      expect(disabled.status).toBe(401);
      expect(await disabled.json()).toEqual(expected);

      const protectedCtx = makeApp(['secret-key-1']);
      try {
        const publicPath = await protectedCtx.app.request('/v1/x/health', { headers: duplicateHeaders });
        expect(publicPath.status).toBe(401);
        expect(await publicPath.json()).toEqual(expected);
      } finally {
        protectedCtx.db.close();
        rmSync(protectedCtx.tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('CORS policy', () => {
    let ctx: ReturnType<typeof makeApp>;
    beforeEach(() => { ctx = makeApp(undefined, ['https://console.example.com']); });
    afterEach(() => { ctx.db.close(); rmSync(ctx.tmpDir, { recursive: true, force: true }); });

    it('allows localhost browser origins for the local Dashboard', async () => {
      const res = await ctx.app.request('/v1/x/health', {
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    });

    it('allows explicitly configured deployment origins', async () => {
      const res = await ctx.app.request('/v1/x/health', {
        headers: { Origin: 'https://console.example.com' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('https://console.example.com');
    });

    it('does not emit wildcard CORS for untrusted origins', async () => {
      const res = await ctx.app.request('/v1/x/health', {
        headers: { Origin: 'https://evil.example.com' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  describe('auth enabled', () => {
    let ctx: ReturnType<typeof makeApp>;
    beforeEach(() => { ctx = makeApp(['secret-key-1', 'secret-key-2']); });
    afterEach(() => { ctx.db.close(); rmSync(ctx.tmpDir, { recursive: true, force: true }); });

    it('rejects /v1/agents without a token (401)', async () => {
      const res = await ctx.app.request('/v1/agents');
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.type).toBe('authentication_error');
    });

    it('rejects an invalid token (401)', async () => {
      const res = await ctx.app.request('/v1/agents', {
        headers: { Authorization: 'Bearer wrong-key' },
      });
      expect(res.status).toBe(401);
    });

    it('preserves Bearer authentication without CMA compatibility headers', async () => {
      const res = await ctx.app.request('/v1/agents', {
        headers: { Authorization: 'Bearer secret-key-1' },
      });
      expect(res.status).toBe(200);
    });

    it('authenticates CMA requests with x-api-key and the managed-agents headers', async () => {
      const res = await ctx.app.request('/v1/agents', {
        headers: {
          'x-api-key': 'secret-key-1',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'managed-agents-2026-04-01',
        },
      });
      expect(res.status).toBe(200);
    });

    it.each([
      [
        'an invalid Bearer credential with a valid x-api-key',
        { Authorization: 'Bearer wrong-key', 'x-api-key': 'secret-key-1' },
      ],
      [
        'a valid Bearer credential with an invalid x-api-key',
        { Authorization: 'Bearer secret-key-1', 'x-api-key': 'wrong-key' },
      ],
      [
        'different valid Bearer and x-api-key credentials',
        { Authorization: 'Bearer secret-key-1', 'x-api-key': 'secret-key-2' },
      ],
      [
        'matching valid Bearer and x-api-key credentials',
        { Authorization: 'Bearer secret-key-1', 'x-api-key': 'secret-key-1' },
      ],
    ])('rejects %s', async (_caseName, credentials) => {
      const res = await ctx.app.request('/v1/agents', {
        headers: {
          ...credentials,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'managed-agents-2026-04-01',
        },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: {
          type: 'authentication_error',
          message: 'Missing or invalid API key. Provide exactly one of "Authorization: Bearer <key>" or "x-api-key: <key>".',
        },
      });
    });

    it('accepts a comma-separated beta header containing the required CMA beta', async () => {
      const res = await ctx.app.request('/v1/agents', {
        headers: {
          'x-api-key': 'secret-key-1',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'another-compatible-beta, managed-agents-2026-04-01',
        },
      });
      expect(res.status).toBe(200);
    });

    it.each([
      [
        'missing anthropic-version',
        { 'x-api-key': 'secret-key-1', 'anthropic-beta': 'managed-agents-2026-04-01' },
        'Missing required header: anthropic-version.',
        'missing_anthropic_version',
      ],
      [
        'missing anthropic-beta',
        { 'x-api-key': 'secret-key-1', 'anthropic-version': '2023-06-01' },
        'Missing required header: anthropic-beta.',
        'missing_anthropic_beta',
      ],
      [
        'unsupported anthropic-version',
        {
          'x-api-key': 'secret-key-1',
          'anthropic-version': '2024-01-01',
          'anthropic-beta': 'managed-agents-2026-04-01',
        },
        'Unsupported anthropic-version. Expected "2026-10-21".',
        'unsupported_anthropic_version',
      ],
      [
        'unsupported anthropic-beta',
        {
          'x-api-key': 'secret-key-1',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'managed-agents-2025-01-01',
        },
        'Unsupported anthropic-beta. Expected "managed-agents-2026-04-01".',
        'unsupported_anthropic_beta',
      ],
      [
        'malformed comma-separated anthropic-beta',
        {
          'x-api-key': 'secret-key-1',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'managed-agents-2026-04-01,,another-compatible-beta',
        },
        'Malformed anthropic-beta header. Provide comma-separated beta identifiers.',
        'malformed_anthropic_beta',
      ],
    ])('rejects %s before CMA business logic', async (_caseName, headers, message, code) => {
      const res = await ctx.app.request('/v1/agents', { headers });
      expect(res.status).toBe(400);
      // The code is part of the published contract, so the wire value is
      // pinned here rather than read from the module under test.
      expect(await res.json()).toEqual({
        error: { type: 'invalid_request_error', code, message },
      });
    });

    it('requires the agent-memory beta for memory-store routes before writes', async () => {
      const rejected = await ctx.app.request('/v1/memory_stores', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'secret-key-1',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'managed-agents-2026-04-01',
        },
        body: JSON.stringify({ name: 'blocked-store' }),
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({
        error: {
          type: 'invalid_request_error',
          code: 'unsupported_anthropic_beta',
          message: 'Unsupported anthropic-beta. Expected "agent-memory-2026-07-22".',
        },
      });
      expect(ctx.db.prepare('SELECT id FROM memory_stores').all()).toHaveLength(0);

      const accepted = await ctx.app.request('/v1/memory_stores', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'secret-key-1',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'another-compatible-beta, agent-memory-2026-07-22',
        },
        body: JSON.stringify({ name: 'admitted-store' }),
      });
      expect(accepted.status).toBe(201);
      const store = await accepted.json() as { id: string };

      const combinedBetas = await ctx.app.request('/v1/memory_stores', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'secret-key-1',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'managed-agents-2026-04-01, agent-memory-2026-07-22',
        },
        body: JSON.stringify({ name: 'combined-betas' }),
      });
      expect(combinedBetas.status).toBe(400);
      expect(await combinedBetas.json()).toEqual({
        error: {
          type: 'invalid_request_error',
          code: 'conflicting_memory_store_beta',
          message: 'Do not combine managed-agents and agent-memory beta headers for memory-store requests.',
        },
      });
      expect(ctx.db.prepare('SELECT id FROM memory_stores').all()).toHaveLength(1);

      for (const beta of ['managed-agents-2026-04-01', 'agent-memory-2026-07-22']) {
        const listing = await ctx.app.request(`/v1/memory_stores/${store.id}/memories`, {
          headers: {
            'x-api-key': 'secret-key-1',
            'anthropic-version': '2023-06-01',
            'anthropic-beta': beta,
          },
        });
        expect(listing.status).toBe(200);
      }
    });

    it('accepts any of the configured keys', async () => {
      const res = await ctx.app.request('/v1/agents', {
        headers: { Authorization: 'Bearer secret-key-2' },
      });
      expect(res.status).toBe(200);
    });

    it('lists configured API keys without exposing raw secrets', async () => {
      const res = await ctx.app.request('/v1/api-keys', {
        headers: { Authorization: 'Bearer secret-key-1' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data[0].source).toBe('config_env');
      expect(body.data[0].secret_key).toBeUndefined();
      expect(body.data[0].key_prefix).toContain('...');
      expect(body.data[0].key_prefix).not.toBe('secret-key-1');

      const deleteRes = await ctx.app.request(`/v1/api-keys/${body.data[0].id}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer secret-key-1' },
      });
      expect(deleteRes.status).toBe(400);
    });

    it('keeps /v1/x/health public', async () => {
      const res = await ctx.app.request('/v1/x/health');
      expect(res.status).toBe(200);
    });

    it('keeps the exact /v1/x extension root outside CMA admission', async () => {
      const res = await ctx.app.request('/v1/x', {
        headers: {
          'x-api-key': 'secret-key-1',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'malformed,,beta',
        },
      });
      expect(res.status).toBe(404);
    });

    it('keeps root (/) public', async () => {
      const res = await ctx.app.request('/');
      expect(res.status).toBe(200);
    });

    it('keeps the console shell and static assets public', async () => {
      const shell = await ctx.app.request('/dashboard');
      expect(shell.status).not.toBe(401);

      const asset = await ctx.app.request('/dashboard/assets/app.js');
      expect(asset.status).not.toBe(401);

      const legacyShell = await ctx.app.request('/ui');
      expect(legacyShell.status).not.toBe(401);
    });

    it('is case-insensitive on the Bearer scheme', async () => {
      const res = await ctx.app.request('/v1/agents', {
        headers: { Authorization: 'bearer secret-key-1' },
      });
      expect(res.status).toBe(200);
    });
  });

  describe('database-managed API keys', () => {
    let ctx: ReturnType<typeof makeDynamicApp>;
    beforeEach(() => { ctx = makeDynamicApp(); });
    afterEach(() => { ctx.db.close(); rmSync(ctx.tmpDir, { recursive: true, force: true }); });

    it('creates a key, enables auth, accepts the returned secret, and deletes the key', async () => {
      const before = await ctx.app.request('/v1/agents');
      expect(before.status).toBe(200);

      const createRes = await ctx.app.request('/v1/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'CI key' }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json() as { id: string; secret_key: string; key_prefix: string };
      expect(created.id).toMatch(/^key_/);
      expect(created.secret_key).toMatch(/^ma_/);
      expect(created.key_prefix).not.toContain(created.secret_key);

      const runtimeRes = await ctx.app.request('/v1/x/runtime', {
        headers: { Authorization: `Bearer ${created.secret_key}` },
      });
      expect(runtimeRes.status).toBe(200);
      expect((await runtimeRes.json()).auth_enabled).toBe(true);

      const unauthorized = await ctx.app.request('/v1/agents');
      expect(unauthorized.status).toBe(401);

      const authorized = await ctx.app.request('/v1/agents', {
        headers: { Authorization: `Bearer ${created.secret_key}` },
      });
      expect(authorized.status).toBe(200);

      const listRes = await ctx.app.request('/v1/api-keys', {
        headers: { Authorization: `Bearer ${created.secret_key}` },
      });
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json();
      expect(listBody.data).toHaveLength(1);
      expect(listBody.data[0].last_used_at).toBeTruthy();

      const deleteRes = await ctx.app.request(`/v1/api-keys/${created.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${created.secret_key}` },
      });
      expect(deleteRes.status).toBe(200);
      expect((await deleteRes.json()).type).toBe('api_key_deleted');

      const afterDelete = await ctx.app.request('/v1/agents', {
        headers: { Authorization: `Bearer ${created.secret_key}` },
      });
      expect(afterDelete.status).toBe(200);
    });
  });
});
