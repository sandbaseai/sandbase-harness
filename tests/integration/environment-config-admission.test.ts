/**
 * An Environment's published `config` shape is interpreted, or refused.
 *
 * Measured against the official TypeScript SDK at `0.131.0`, the quickstart
 * shape `config: { type: "self_hosted" }` was accepted and read back as
 * `hosting_type: "local"` with `sandbox_provider: null`, `config: { type:
 * "cloud" }` was refused by name, and `config: { networking: … }` was stored
 * without ever being read. An official client could therefore declare a backend
 * and a network policy and get neither, which is the failure this file pins.
 *
 * Every case asserts what the request did to stored state as well as what it
 * answered, because "refused" and "accepted but ignored" read the same in a
 * status code alone.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('environment config admission', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-environment-config-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const post = async (body: Record<string, unknown>) => {
    const res = await app.request('/v1/environments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  };

  const put = async (id: string, body: Record<string, unknown>) => {
    const res = await app.request(`/v1/environments/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  };

  const storedConfig = (id: string): Record<string, unknown> => {
    const row = db.prepare('SELECT config FROM environments WHERE id = ?').get(id) as { config: string };
    return JSON.parse(row.config) as Record<string, unknown>;
  };

  const environmentCount = (name: string): number =>
    (db.prepare('SELECT COUNT(*) AS count FROM environments WHERE name = ?').get(name) as { count: number }).count;

  it('reads the published config.type as the hosting type', async () => {
    const { status, body } = await post({ name: 'published-self-hosted', config: { type: 'self_hosted' } });

    expect(status).toBe(201);
    // Reported as the hosting the caller asked for, on the published axis.
    expect(body.config.type).toBe('self_hosted');
    // Nothing named a backend, so the effective backend resolves from the hosting type.
    expect(body.effective_sandbox_provider).toBe('self_hosted');

    const read = await app.request(`/v1/environments/${body.id}`);
    expect((await read.json() as any).config.type).toBe('self_hosted');
  });

  it('resolves the published type the same way the local spelling resolves', async () => {
    const published = await post({ name: 'published-docker', config: { type: 'docker' } });
    const local = await post({ name: 'local-docker', config: { hosting_type: 'docker' } });

    expect(published.status).toBe(201);
    expect(local.status).toBe(201);
    // A backend this runtime serves projects to `cloud` on the published axis —
    // "the platform decides" — and the effective backend is reported separately.
    expect(published.body.config.type).toBe('cloud');
    expect(published.body.config.type).toBe(local.body.config.type);
    expect(published.body.effective_sandbox_provider).toBe('docker');
    expect(published.body.effective_sandbox_provider).toBe(local.body.effective_sandbox_provider);
  });

  it('accepts published cloud hosting and resolves it to the docker backend', async () => {
    const { status, body } = await post({ name: 'published-cloud', config: { type: 'cloud' } });

    expect(status).toBe(201);
    // `cloud` is the official "the platform decides" value: the declaration is
    // preserved, and the effective backend is docker — this runtime's
    // managed-cloud substitute.
    expect(body.config.type).toBe('cloud');
    expect(body.effective_sandbox_provider).toBe('docker');
    expect(storedConfig(body.id).type).toBe('cloud');
  });

  it('refuses an unknown published type by name', async () => {
    const { status, body } = await post({ name: 'published-unknown', config: { type: 'team_server' } });

    expect(status).toBe(400);
    expect(body.error.code).toBe('unsupported_hosting_type');
    expect(body.error.message).toContain('team_server');
    expect(body.error.message).toContain('local, docker, kubernetes, cloud, self_hosted');
    expect(environmentCount('published-unknown')).toBe(0);
  });

  it('refuses two spellings of the hosting type that disagree', async () => {
    const { status, body } = await post({
      name: 'hosting-conflict',
      config: { type: 'docker', hosting_type: 'local' },
    });

    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('invalid_environment_config');
    expect(body.error.message).toContain('docker');
    expect(body.error.message).toContain('local');
    expect(environmentCount('hosting-conflict')).toBe(0);
  });

  it('accepts two spellings that agree', async () => {
    const { status, body } = await post({
      name: 'hosting-agreement',
      config: { type: 'self_hosted', hosting_type: 'self_hosted' },
    });

    expect(status).toBe(201);
    expect(body.config.type).toBe('self_hosted');
    expect(storedConfig(body.id).type).toBe('self_hosted');
  });

  it('refuses a hosting declaration that cannot be a name, in either spelling', async () => {
    const published = await post({ name: 'published-object', config: { type: { type: 'cloud' } } });
    expect(published.status).toBe(400);
    expect(published.body.error.code).toBe('invalid_environment_config');
    expect(published.body.error.message).toContain('type must be a string');

    const local = await post({ name: 'local-number', config: { hosting_type: 7 } });
    expect(local.status).toBe(400);
    expect(local.body.error.message).toContain('hosting_type must be a string');
    expect(environmentCount('published-object')).toBe(0);
    expect(environmentCount('local-number')).toBe(0);
  });

  it('normalizes the published networking policy into the recorded local key', async () => {
    const { status, body } = await post({
      name: 'published-networking',
      config: {
        type: 'self_hosted',
        networking: {
          type: 'limited',
          allowed_hosts: ['api.example.com'],
          allow_mcp_servers: true,
          allow_package_managers: false,
        },
      },
    });

    expect(status).toBe(201);
    // The stored local spelling is echoed, and the published `networking`
    // projection carries the same policy in the official key names.
    expect(body.config.network).toEqual({
      type: 'limited',
      allowed_hosts: ['api.example.com'],
      allow_mcp_server_network_access: true,
      allow_package_manager_network_access: false,
    });
    expect(body.config.networking).toEqual({
      type: 'limited',
      allowed_hosts: ['api.example.com'],
      allow_mcp_servers: true,
      allow_package_managers: false,
    });
    // One stored spelling: the published key is consumed on ingress rather than
    // stored as a second declaration of the same policy.
    expect(storedConfig(body.id).network).toEqual(body.config.network);
    expect(storedConfig(body.id).networking).toBeUndefined();
  });

  it('keeps the local network keys a policy was written with', async () => {
    const policy = {
      type: 'unrestricted',
      allowed_hosts: [],
      allow_mcp_server_network_access: false,
      allow_package_manager_network_access: true,
    };
    const { status, body } = await post({ name: 'local-network', config: { network: policy } });

    expect(status).toBe(201);
    expect(body.config.network).toEqual(policy);
  });

  it('refuses two network spellings that disagree and accepts two that agree', async () => {
    const disagreement = await post({
      name: 'network-conflict',
      config: {
        network: { type: 'limited', allowed_hosts: ['a.example.com'] },
        networking: { type: 'limited', allowed_hosts: ['b.example.com'] },
      },
    });

    expect(disagreement.status).toBe(400);
    expect(disagreement.body.error.code).toBe('invalid_environment_config');
    expect(disagreement.body.error.message).toContain('config.networking');
    expect(environmentCount('network-conflict')).toBe(0);

    const agreement = await post({
      name: 'network-agreement',
      config: {
        network: { type: 'limited', allowed_hosts: ['a.example.com'], allow_mcp_servers: true },
        networking: { type: 'limited', allowed_hosts: ['a.example.com'], allow_mcp_servers: true },
      },
    });

    expect(agreement.status).toBe(201);
    expect(agreement.body.config.network.allowed_hosts).toEqual(['a.example.com']);
    expect(agreement.body.config.network.allow_mcp_server_network_access).toBe(true);
  });

  it('refuses a network policy that is not an object', async () => {
    const published = await post({ name: 'networking-string', config: { networking: 'limited' } });
    expect(published.status).toBe(400);
    expect(published.body.error.code).toBe('invalid_environment_config');
    expect(published.body.error.message).toContain('config.networking must be an object');

    const local = await post({ name: 'network-array', config: { network: ['limited'] } });
    expect(local.status).toBe(400);
    expect(local.body.error.message).toContain('network must be an object');
    expect(environmentCount('networking-string')).toBe(0);
    expect(environmentCount('network-array')).toBe(0);
  });

  it('reports a policy a stored row wrote in the published spelling', async () => {
    db.prepare('INSERT INTO environments (id, name, description, config, metadata) VALUES (?, ?, ?, ?, ?)').run(
      'env_legacy_networking',
      'legacy',
      '',
      JSON.stringify({ hosting_type: 'local', networking: { type: 'limited', allowed_hosts: ['legacy.example.com'] } }),
      '{}',
    );

    const res = await app.request('/v1/environments/env_legacy_networking');
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.config.networking.type).toBe('limited');
    expect(body.config.networking.allowed_hosts).toEqual(['legacy.example.com']);
  });

  it('translates a stored published policy on update, and lets a newer one replace it', async () => {
    db.prepare('INSERT INTO environments (id, name, description, config, metadata) VALUES (?, ?, ?, ?, ?)').run(
      'env_stored_networking',
      'stored',
      '',
      JSON.stringify({ hosting_type: 'local', networking: { type: 'limited', allowed_hosts: ['old.example.com'] } }),
      '{}',
    );

    const renamed = await put('env_stored_networking', { name: 'stored-renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.config.network.allowed_hosts).toEqual(['old.example.com']);
    // The local key is the record after a write; the published one is consumed.
    expect(storedConfig('env_stored_networking').networking).toBeUndefined();

    const replaced = await put('env_stored_networking', {
      config: { network: { type: 'unrestricted' } },
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.config.network.type).toBe('unrestricted');
    expect(replaced.body.config.network.allow_mcp_server_network_access).toBe(false);
  });

  it('clears a policy a client removes with null, in either spelling', async () => {
    const created = await post({
      name: 'clearable',
      config: { network: { type: 'limited', allowed_hosts: ['a.example.com'] } },
    });
    expect(created.status).toBe(201);
    expect(created.body.config.network.allowed_hosts).toEqual(['a.example.com']);

    const cleared = await put(created.body.id, { config: { network: null } });
    expect(cleared.status).toBe(200);
    // Cleared, not stored as a policy nothing can read. With nothing declared
    // the published projection reports `unrestricted`, which is also what the
    // sandbox runs — the policy is recorded, not enforced.
    expect(cleared.body.config.network).toBeUndefined();
    expect(cleared.body.config.networking).toEqual({ type: 'unrestricted' });
    expect(storedConfig(created.body.id).network).toBeUndefined();

    const republished = await put(created.body.id, {
      config: { networking: { type: 'unrestricted' } },
    });
    expect(republished.status).toBe(200);
    const clearedAgain = await put(created.body.id, { config: { networking: null } });
    expect(clearedAgain.status).toBe(200);
    expect(clearedAgain.body.config.networking).toEqual({ type: 'unrestricted' });
  });

  it('lets a request naming one spelling repair a stored published declaration', async () => {
    // Reachable state: the version that stored `config` verbatim accepted the
    // published shape, so rows holding only `config.type` exist.
    db.prepare('INSERT INTO environments (id, name, description, config, metadata) VALUES (?, ?, ?, ?, ?)').run(
      'env_stored_type',
      'published',
      '',
      JSON.stringify({ type: 'cloud' }),
      '{}',
    );

    const before = await app.request('/v1/environments/env_stored_type');
    expect((await before.json() as any).config.type).toBe('cloud');

    // The Console editor only ever sends the local spelling; without superseding
    // the stored twin this would answer 400 for disagreeing with a value the
    // request never wrote, and the row could not be repaired at all.
    const repaired = await put('env_stored_type', { hosting_type: 'local', sandbox_provider: 'local' });
    expect(repaired.status).toBe(200);
    // `local` projects to `cloud` on the published axis — the platform-served
    // value — and the effective backend reports the declaration's resolution.
    expect(repaired.body.config.type).toBe('cloud');
    expect(repaired.body.config.hosting_type).toBe('local');
    expect(repaired.body.effective_sandbox_provider).toBe('local');
    expect(storedConfig('env_stored_type').type).toBeUndefined();
    expect(storedConfig('env_stored_type').hosting_type).toBe('local');
  });

  it('reports a stored declaration it cannot resolve with no effective backend', async () => {
    db.prepare('INSERT INTO environments (id, name, description, config, metadata) VALUES (?, ?, ?, ?, ?)').run(
      'env_conflicting',
      'conflicting',
      '',
      JSON.stringify({ hosting_type: 'local', type: 'docker' }),
      '{}',
    );

    const res = await app.request('/v1/environments/env_conflicting');
    const body = await res.json() as any;
    // Resolution refuses this record (`invalid_environment_config`), so the
    // projection must not present a backend a session on it would not use.
    expect(body.effective_sandbox_provider).toBeNull();

    // Declaring one spelling supersedes the stored twin, which repairs it.
    const repaired = await put('env_conflicting', { hosting_type: 'local' });
    expect(repaired.status).toBe(200);
    expect(repaired.body.effective_sandbox_provider).toBe('local');
    expect(storedConfig('env_conflicting').type).toBeUndefined();
  });

  it('refuses an update over a stored policy that is not an object, and names the repair', async () => {
    db.prepare('INSERT INTO environments (id, name, description, config, metadata) VALUES (?, ?, ?, ?, ?)').run(
      'env_damaged_policy',
      'damaged policy',
      '',
      JSON.stringify({ hosting_type: 'local', networking: 'limited' }),
      '{}',
    );

    const renamed = await put('env_damaged_policy', { name: 'renamed' });
    expect(renamed.status).toBe(400);
    expect(renamed.body.error.code).toBe('invalid_environment_config');
    expect(renamed.body.error.message).toContain('stored networking is not an object');
    expect(renamed.body.error.message).toContain('config.network');
    // Nothing changed: the failed update did not drop the value it could not read.
    expect(storedConfig('env_damaged_policy').networking).toBe('limited');
    expect((db.prepare('SELECT name FROM environments WHERE id = ?').get('env_damaged_policy') as { name: string }).name)
      .toBe('damaged policy');

    // The repair the message names: a declaration in the request supersedes the
    // stored value, in either spelling.
    const repaired = await put('env_damaged_policy', {
      config: { network: { type: 'limited', allowed_hosts: ['a.example.com'] } },
    });
    expect(repaired.status).toBe(200);
    expect(repaired.body.config.network.allowed_hosts).toEqual(['a.example.com']);
    expect(storedConfig('env_damaged_policy').networking).toBeUndefined();

    const cleared = await put('env_damaged_policy', { config: { network: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.config.networking).toEqual({ type: 'unrestricted' });
  });

  it('lets null clear a policy an older row stored in the published spelling', async () => {
    db.prepare('INSERT INTO environments (id, name, description, config, metadata) VALUES (?, ?, ?, ?, ?)').run(
      'env_legacy_clear',
      'legacy clear',
      '',
      JSON.stringify({ hosting_type: 'local', networking: { type: 'limited', allowed_hosts: ['legacy.example.com'] } }),
      '{}',
    );

    const cleared = await put('env_legacy_clear', { config: { network: null } });
    expect(cleared.status).toBe(200);
    // Cleared through either spelling: the request named the policy, so the
    // stored twin does not come back.
    expect(cleared.body.config.networking).toEqual({ type: 'unrestricted' });
    expect(storedConfig('env_legacy_clear').network).toBeUndefined();
    expect(storedConfig('env_legacy_clear').networking).toBeUndefined();

    const republished = await put('env_legacy_clear', {
      config: { networking: { type: 'unrestricted' } },
    });
    expect(republished.status).toBe(200);
    const clearedPublished = await put('env_legacy_clear', { config: { networking: null } });
    expect(clearedPublished.status).toBe(200);
    expect(clearedPublished.body.config.networking).toEqual({ type: 'unrestricted' });
  });

  it('accepts the published network spelling as a top-level field too', async () => {
    // The local `network` is an accepted top-level alias, so its published twin
    // must be one: dropping it silently answered 201 while storing no policy.
    const { status, body } = await post({
      name: 'top-level-networking',
      networking: { type: 'limited', allowed_hosts: ['top.example.com'], allow_mcp_servers: true },
    });

    expect(status).toBe(201);
    expect(body.config.network.allowed_hosts).toEqual(['top.example.com']);
    expect(body.config.network.allow_mcp_server_network_access).toBe(true);
  });

  it('fills the unset permission flags with the restrictive default', async () => {
    const { status, body } = await post({
      name: 'defaults',
      config: { networking: { type: 'limited', allowed_hosts: ['only.example.com'] } },
    });

    expect(status).toBe(201);
    expect(body.config.network.allow_mcp_server_network_access).toBe(false);
    expect(body.config.network.allow_package_manager_network_access).toBe(false);
    // `unrestricted` is the only type that widens anything, so anything else is limited.
    expect(body.config.network.type).toBe('limited');
  });
});
