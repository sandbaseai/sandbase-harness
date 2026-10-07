import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '@/api/server.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { CMA_ANTHROPIC_VERSION, CMA_MANAGED_AGENTS_BETA, CMA_RESOURCE_FAMILY_BETAS } from '@/core/cma/compatibility.js';
import { disposeConformanceContexts, makeConformanceApp, type ConformanceContext } from './support/app.js';
import { loadOfficialRoutes, missingOfficialRoutes, mountedOfficialRoutes, probeOfficialRoute, routeKey } from './support/official-routes.js';
import { matchesUnsupportedRoute, PENDING_OFFICIAL_ROUTES, UNSUPPORTED_OFFICIAL_ROUTES } from './support/unsupported-official-routes.js';

const officialRoutes = loadOfficialRoutes();
const contexts: ConformanceContext[] = [];
const headers = { 'anthropic-version': CMA_ANTHROPIC_VERSION, 'anthropic-beta': CMA_MANAGED_AGENTS_BETA };
const unsupportedRoutes = officialRoutes.filter((route) => UNSUPPORTED_OFFICIAL_ROUTES.some((entry) => matchesUnsupportedRoute(entry, route)));

function context(): ConformanceContext {
  const result = makeConformanceApp('ma-official-route-');
  contexts.push(result);
  return result;
}

describe('official SDK route coverage', () => {
  afterEach(() => disposeConformanceContexts(contexts));

  it('mounts every route except exact, tracked deferrals', async () => {
    const { app } = context();
    const missing = missingOfficialRoutes(app, officialRoutes, PENDING_OFFICIAL_ROUTES);
    expect(missing, `Missing official SDK routes:\n${missing.join('\n')}`).toEqual([]);
    const pending = new Set(PENDING_OFFICIAL_ROUTES.map((entry) => entry.route));
    const unserved: string[] = [];
    for (const route of officialRoutes.filter((entry) => !pending.has(routeKey(entry)))) {
      const response = await probeOfficialRoute(app, route);
      const text = await response.text();
      if (response.status === 404 && text.includes('No route matches')) {
        unserved.push(routeKey(route));
      }
    }
    expect(unserved, `Unserved official SDK routes:\n${unserved.join('\n')}`).toEqual([]);
  });

  it('keeps exceptions nonempty, current, unique, and nonoverlapping', () => {
    const mounted = mountedOfficialRoutes(context().app);
    for (const entry of UNSUPPORTED_OFFICIAL_ROUTES) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(officialRoutes.some((route) => matchesUnsupportedRoute(entry, route)), entry.pattern.toString()).toBe(true);
    }
    const keys = new Set(officialRoutes.map(routeKey));
    expect(new Set(PENDING_OFFICIAL_ROUTES.map((entry) => entry.route)).size).toBe(PENDING_OFFICIAL_ROUTES.length);
    for (const entry of PENDING_OFFICIAL_ROUTES) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.followUp).toMatch(/^https:\/\/github\.com\/sandbaseai\/sandbase-harness\/issues\/\d+$/);
      expect(keys.has(entry.route), `Stale pending route: ${entry.route}`).toBe(true);
      expect(mounted.has(entry.route), `Remove the now-mounted pending route: ${entry.route}`).toBe(false);
    }
    for (const route of officialRoutes) {
      const unsupported = UNSUPPORTED_OFFICIAL_ROUTES.filter((entry) => matchesUnsupportedRoute(entry, route));
      expect(unsupported.length, routeKey(route)).toBeLessThanOrEqual(1);
      if (unsupported.length) expect(PENDING_OFFICIAL_ROUTES.some((entry) => entry.route === routeKey(route))).toBe(false);
    }
  });

  it('names the missing route when its deferral is removed', () => {
    const { app } = context();
    const route = { method: 'GET', path: '/v1/coverage_fixture/:id' };
    expect(missingOfficialRoutes(app, [route], [{ route: routeKey(route) }])).toEqual([]);
    expect(missingOfficialRoutes(app, [route], [])).toEqual([routeKey(route)]);
  });

  it.each(unsupportedRoutes)('rejects $method $path with the compatibility reference', async (route) => {
    const { app, db } = context();
    const before = db.prepare('SELECT total_changes() AS count').get();
    const response = await probeOfficialRoute(app, route);
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = await response.json() as { error: { type: string; message: string; details: { capabilities: { id: string; reason: string }[] } } };
    expect(body.error.type).toBe('unsupported_capability');
    expect(body.error.message).toContain('docs/api-matrix.md#unsupported-official-routes');
    expect(body.error.details.capabilities).toHaveLength(1);
    expect(body.error.details.capabilities[0].reason.length).toBeGreaterThan(0);
    expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
  });

  it('lets unmodified SDK resource methods decode the unsupported-capability envelope', async () => {
    const { app } = context();
    const client = new Anthropic({
      baseURL: 'http://conformance.local', apiKey: 'route-test-key', authToken: null,
      maxRetries: 0, fetch: async (input, init) => app.request(input, init),
    });
    const expected = { status: 400, error: { error: { type: 'unsupported_capability' } } };
    // Dreams and Work are served, not refused: an unknown id decodes the real
    // route's 404 rather than the unsupported-capability envelope. The work
    // surface resolves its own credential set, so the probe goes in
    // credential-free — the conformance app runs open, and an unknown bearer
    // would be refused at authentication before reaching the item lookup.
    const anonymous = new Anthropic({
      baseURL: 'http://conformance.local', apiKey: 'route-test-key', authToken: null,
      maxRetries: 0,
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.delete('authorization');
        headers.delete('x-api-key');
        return app.request(input, { ...init, headers });
      },
    });
    for (const notFoundProbe of [
      client.beta.dreams.retrieve('x_probe'),
      anonymous.beta.environments.work.retrieve('x_probe', { environment_id: 'x_probe' }),
    ]) {
      await expect(notFoundProbe).rejects.toMatchObject({
        status: 404, error: { error: { type: 'not_found' } },
      });
    }
    await expect(client.beta.tunnels.retrieve('x_probe')).rejects.toMatchObject(expected);
    await expect(client.beta.userProfiles.retrieve('x_probe')).rejects.toMatchObject(expected);
    await expect(client.beta.vaults.credentials.mcpOAuthValidate('x_probe', { vault_id: 'x_probe' })).rejects.toMatchObject(expected);
    await expect(client.beta.sessions.threads.list('x_probe')).rejects.toMatchObject(expected);
    await expect(client.beta.sessions.threads.retrieve('x_probe', { session_id: 'x_probe' })).rejects.toMatchObject(expected);
    await expect(client.beta.sessions.threads.archive('x_probe', { session_id: 'x_probe' })).rejects.toMatchObject(expected);
    await expect(client.beta.sessions.threads.events.list('x_probe', { session_id: 'x_probe' })).rejects.toMatchObject(expected);
  });

  it('preserves the vault alias for OAuth refusal without reading its body', async () => {
    const { app } = context();
    for (const prefix of ['/v1/vaults', '/v1/credential-vaults']) {
      const response = await app.request(`${prefix}/x_probe/credentials/x_probe/mcp_oauth_validate`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{',
      });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: { type: string } }).error.type).toBe('unsupported_capability');
    }
  });

  it('preserves authentication, header admission, and rate limiting before refusal', async () => {
    const { db } = context();
    const app = createServer({
      db, sessionManager: new SessionManager(db), agents: [], reloadAgents: () => ({ agents: [], errors: [] }),
      apiKeys: ['route-test-key'], inboundRateLimit: { enabled: true, readPerMinute: 2, writePerMinute: 2 },
    });
    const path = '/v1/tunnels';
    expect((await app.request(path, { headers })).status).toBe(401);
    const unauthorizedBeta = await app.request(path, { headers: { ...headers, 'x-api-key': 'route-test-key', 'anthropic-beta': 'wrong-beta' } });
    expect((await unauthorizedBeta.json() as { error: { code: string } }).error.code).toBe('unsupported_anthropic_beta');
    expect((await app.request(path, { headers: { ...headers, 'x-api-key': 'route-test-key' } })).status).toBe(400);
    expect((await app.request(path, { headers: { ...headers, 'x-api-key': 'route-test-key' } })).status).toBe(429);
  });

  it.each(Object.values(CMA_RESOURCE_FAMILY_BETAS))('never admits an unrelated resource under family beta %s', async (beta) => {
    const { app } = context();
    for (const path of ['/v1/agents', '/v1/memory_stores', '/v1/dreamscape']) {
      const response = await app.request(path, { headers: { ...headers, 'anthropic-beta': beta } });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: { code: string } }).error.code).toBe('unsupported_anthropic_beta');
    }
  });

  it.each(Object.entries(CMA_RESOURCE_FAMILY_BETAS))('still validates version and beta headers on %s', async (path, beta) => {
    const { app } = context();
    for (const [requestHeaders, code] of [
      [{ 'anthropic-beta': beta }, 'missing_anthropic_version'],
      [{ 'anthropic-version': 'unsupported-version', 'anthropic-beta': beta }, 'unsupported_anthropic_version'],
      [{ 'anthropic-version': CMA_ANTHROPIC_VERSION }, 'missing_anthropic_beta'],
      [{ ...headers, 'anthropic-beta': ',' }, 'malformed_anthropic_beta'],
    ] as const) {
      const response = await app.request(path, { headers: requestHeaders });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: { code: string } }).error.code).toBe(code);
    }
  });

  it('keeps unrelated paths, verbs, and existing worker/resource routes outside the refusal', async () => {
    const { app } = context();
    for (const path of ['/v1/dreamscape', '/v1/dreams/x_probe/not_a_method', '/v1/other/mcp_oauth_validate']) {
      expect((await app.request(path, { headers })).status, path).toBe(404);
    }
    expect((await app.request('/v1/dreams', { method: 'DELETE', headers })).status).toBe(404);
    for (const path of ['/v1/environments/x_probe', '/v1/environments/x_probe/work-items', '/v1/vaults/x_probe/credentials']) {
      const response = await app.request(path, { headers });
      const body = await response.json() as { error: { type: string; message: string } };
      expect(body.error.type, path).not.toBe('unsupported_capability');
      expect(body.error.message, path).not.toContain('No route matches');
    }
  });
});
