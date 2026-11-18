/**
 * How a declared `limited` network policy projects onto the Environment API.
 *
 * The policy is now applied — but at the strength the effective sandbox
 * backend can deliver, and the response must say which. `enforced` is only
 * claimed where the provider's capability declares a real egress boundary;
 * anything weaker reports `best_effort` or `unsupported` rather than imply a
 * boundary that does not exist.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { sandboxCapabilities } from '@/types/sandbox.js';

describe('environment networking enforcement projection', () => {
  let db: Database;
  let tmpDir: string;

  const appFor = (caps: Record<string, 'enforced' | 'best_effort' | 'none'> = {}) =>
    createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      sandboxCapabilities: (type) =>
        caps[type] !== undefined
          ? sandboxCapabilities({ networkPolicyEnforcement: caps[type] })
          : undefined,
    });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-environment-enforcement-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const post = async (body: Record<string, unknown>) => {
    const res = await appFor({
      local: 'best_effort',
      docker: 'enforced',
      kubernetes: 'enforced',
      self_hosted: 'best_effort',
    }).request('/v1/environments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  };

  it('reports a docker-backed limited policy as enforced', async () => {
    const { status, body } = await post({
      name: 'limited-docker',
      hosting_type: 'docker',
      config: { networking: { type: 'limited', allowed_hosts: ['api.github.com'] } },
    });
    expect(status).toBe(201);
    expect(body.networking_enforcement).toBe('enforced');
    expect(body.networking_enforced).toBe(true);
  });

  it('reports a local-backed limited policy as best effort, not enforced', async () => {
    const { status, body } = await post({
      name: 'limited-local',
      config: { network: { type: 'limited', allowed_hosts: ['api.github.com'] } },
    });
    expect(status).toBe(201);
    expect(body.networking_enforcement).toBe('best_effort');
    expect(body.networking_enforced).toBe(false);
  });

  it('reports a kubernetes-backed limited policy as enforced through the NetworkPolicy boundary', async () => {
    const { status, body } = await post({
      name: 'limited-k8s',
      config: { type: 'kubernetes', networking: { type: 'limited', allowed_hosts: ['api.github.com'] } },
    });
    expect(status).toBe(201);
    expect(body.networking_enforcement).toBe('enforced');
    expect(body.networking_enforced).toBe(true);
  });

  it('reports a self-hosted limited policy as best effort, not enforced', async () => {
    const { status, body } = await post({
      name: 'limited-self-hosted',
      config: { type: 'self_hosted', networking: { type: 'limited', allowed_hosts: ['api.github.com'] } },
    });
    expect(status).toBe(201);
    expect(body.networking_enforcement).toBe('best_effort');
    expect(body.networking_enforced).toBe(false);
  });

  it('reports not_applicable when the policy is not limited', async () => {
    const { status, body } = await post({
      name: 'unrestricted-local',
      config: { network: { type: 'unrestricted' } },
    });
    expect(status).toBe(201);
    expect(body.networking_enforcement).toBe('not_applicable');
    expect(body.networking_enforced).toBe(false);
  });

  it('reports unsupported rather than guessing when no capability source exists', async () => {
    const app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
    });
    const res = await app.request('/v1/environments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'limited-no-registry',
        config: { network: { type: 'limited', allowed_hosts: ['a.b'] } },
      }),
    });
    const body = await res.json() as any;
    expect(res.status).toBe(201);
    expect(body.networking_enforcement).toBe('unsupported');
  });
});
