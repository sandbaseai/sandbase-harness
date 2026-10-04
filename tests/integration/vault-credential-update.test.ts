/**
 * Integration test: the published credential update verb.
 *
 * `POST /v1/vaults/{id}/credentials/{cid}` used to be unreachable — a
 * credential could be created, rotated, archived and deleted, but the
 * type-discriminated partial update the SDK's
 * `client.beta.vaults.credentials.update()` sends had no route. This suite
 * pins the implemented semantics:
 *
 *  - `display_name` and `metadata` follow the vault update's patch rules.
 *  - `auth.type` is immutable and must match the stored credential;
 *    structural fields (`mcp_server_url`, `secret_name`) are locked.
 *  - `token` / `access_token` / `secret_value` re-encrypt, rotate the
 *    `value_hint`, and write a `rotate` audit event.
 *  - `injection_location` and `networking` replace wholesale;
 *    `networking: null` clears the restriction.
 *  - `expires_at` / `refresh` are accepted with a warning, never persisted.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

const PUBLISHED = '/v1/vaults';
const LOCAL = '/v1/credential-vaults';

describe('Credential update', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function setUp(): ReturnType<typeof createServer> {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-credential-update-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare(
      "INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')",
    ).run();
    return createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
    });
  }

  async function send(
    server: ReturnType<typeof createServer>,
    method: string,
    path: string,
    body?: unknown,
  ) {
    const res = await server.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) as Record<string, any> : undefined };
  }

  async function createVault(server: ReturnType<typeof createServer>) {
    const res = await send(server, 'POST', PUBLISHED, { name: 'vault' });
    expect(res.status).toBe(201);
    return res.body!.id as string;
  }

  async function createEnvCredential(server: ReturnType<typeof createServer>, vaultId: string) {
    const res = await send(server, 'POST', `${PUBLISHED}/${vaultId}/credentials`, {
      auth: {
        type: 'environment_variable',
        secret_name: 'DEPLOY_TOKEN',
        secret_value: 'super-secret-value',
      },
      display_name: 'deploy token',
      metadata: { keep: 'y', drop: 'x' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body!.id as string;
  }

  async function createBearerCredential(server: ReturnType<typeof createServer>, vaultId: string) {
    const res = await send(server, 'POST', `${PUBLISHED}/${vaultId}/credentials`, {
      auth: { type: 'static_bearer', mcp_server_url: 'https://mcp.example.com', token: 'bearer-secret' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body!.id as string;
  }

  it('patches display_name and metadata with the same rules as the vault update', async () => {
    const server = setUp();
    const vaultId = await createVault(server);
    const credentialId = await createEnvCredential(server, vaultId);

    const res = await send(server, 'POST', `${PUBLISHED}/${vaultId}/credentials/${credentialId}`, {
      display_name: 'renamed token',
      metadata: { drop: null, added: 'z' },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body!.display_name).toBe('renamed token');
    expect(res.body!.name).toBe('renamed token');
    expect(res.body!.metadata).toEqual({ keep: 'y', added: 'z' });
  });

  it('preserves every omitted field', async () => {
    const server = setUp();
    const vaultId = await createVault(server);
    const credentialId = await createEnvCredential(server, vaultId);

    const res = await send(server, 'POST', `${PUBLISHED}/${vaultId}/credentials/${credentialId}`, {});

    expect(res.status).toBe(200);
    expect(res.body!.display_name).toBe('deploy token');
    expect(res.body!.metadata).toEqual({ keep: 'y', drop: 'x' });
    expect(res.body!.auth.injection_location).toEqual({ header: true, body: true });
  });

  it('re-encrypts a rotated secret_value and records a rotate audit event', async () => {
    const server = setUp();
    const vaultId = await createVault(server);
    const credentialId = await createEnvCredential(server, vaultId);
    const before = await send(server, 'GET', `${PUBLISHED}/${vaultId}/credentials/${credentialId}`);

    const res = await send(server, 'POST', `${PUBLISHED}/${vaultId}/credentials/${credentialId}`, {
      auth: { type: 'environment_variable', secret_value: 'rotated-secret' },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body!.value_hint).not.toBe(before.body!.value_hint);
    expect(res.body!.value_hint).toContain('cret');
    expect(JSON.stringify(res.body)).not.toContain('rotated-secret');

    const audit = await send(server, 'GET', `${PUBLISHED}/${vaultId}/audit`);
    const actions = (audit.body!.data as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('rotate');
  });

  it('replaces injection_location and networking wholesale; networking null clears to unrestricted', async () => {
    const server = setUp();
    const vaultId = await createVault(server);
    const credentialId = await createEnvCredential(server, vaultId);

    const res = await send(server, 'POST', `${PUBLISHED}/${vaultId}/credentials/${credentialId}`, {
      auth: {
        type: 'environment_variable',
        injection_location: { header: true },
        networking: { type: 'limited', allowed_hosts: ['api.example.com'] },
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body!.auth.injection_location).toEqual({ header: true, body: false });
    expect(res.body!.injection_locations).toEqual(['request_headers']);

    const cleared = await send(server, 'POST', `${PUBLISHED}/${vaultId}/credentials/${credentialId}`, {
      auth: { type: 'environment_variable', networking: null },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body!.network).toEqual({ type: 'unrestricted', allowed_hosts: [] });
  });

  it('refuses an auth.type that does not match the stored credential', async () => {
    const server = setUp();
    const vaultId = await createVault(server);
    const credentialId = await createEnvCredential(server, vaultId);

    const res = await send(server, 'POST', `${PUBLISHED}/${vaultId}/credentials/${credentialId}`, {
      auth: { type: 'static_bearer', token: 'nope' },
    });

    expect(res.status).toBe(400);
    expect(res.body!.error.message).toContain('immutable');
  });

  it('refuses a change to a locked structural field', async () => {
    const server = setUp();
    const vaultId = await createVault(server);
    const credentialId = await createEnvCredential(server, vaultId);

    const res = await send(server, 'POST', `${PUBLISHED}/${vaultId}/credentials/${credentialId}`, {
      auth: { type: 'environment_variable', secret_name: 'OTHER_NAME' },
    });

    expect(res.status).toBe(400);
    expect(res.body!.error.message).toContain('secret_name');
  });

  it('rotates a static_bearer token through the canonical spelling', async () => {
    const server = setUp();
    const vaultId = await createVault(server);
    const credentialId = await createBearerCredential(server, vaultId);

    const res = await send(server, 'POST', `${PUBLISHED}/${vaultId}/credentials/${credentialId}`, {
      auth: { type: 'static_bearer', token: 'rotated-bearer' },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body!.value_hint).toBe('••••arer');
    expect(JSON.stringify(res.body)).not.toContain('rotated-bearer');
  });

  it('warns on expires_at and refresh rather than persisting them', async () => {
    const server = setUp();
    const vaultId = await createVault(server);
    const oauth = await send(server, 'POST', `${PUBLISHED}/${vaultId}/credentials`, {
      auth: { type: 'mcp_oauth', mcp_server_url: 'https://mcp.example.com', access_token: 'oauth-secret' },
    });
    expect(oauth.status, JSON.stringify(oauth.body)).toBe(201);

    const res = await send(server, 'POST', `${PUBLISHED}/${vaultId}/credentials/${oauth.body!.id}`, {
      auth: {
        type: 'mcp_oauth',
        access_token: 'new-access-token',
        expires_at: '2027-01-01T00:00:00Z',
        refresh: { refresh_token: 'rt' },
      },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body!.value_hint).toBe('••••oken');
    expect(res.body!.warnings?.some((w: string) => w.includes('expires_at'))).toBe(true);
    expect(res.body!.warnings?.some((w: string) => w.includes('refresh'))).toBe(true);
  });

  it('refuses a secret supplied as null or empty rather than clearing it', async () => {
    const server = setUp();
    const vaultId = await createVault(server);
    const credentialId = await createEnvCredential(server, vaultId);

    const res = await send(server, 'POST', `${PUBLISHED}/${vaultId}/credentials/${credentialId}`, {
      auth: { type: 'environment_variable', secret_value: null },
    });

    expect(res.status).toBe(400);
    expect(res.body!.error.message).toContain('secret_value');
  });

  it('answers 404 on a missing credential and 404 on an archived vault', async () => {
    const server = setUp();
    const vaultId = await createVault(server);
    const credentialId = await createEnvCredential(server, vaultId);

    const missing = await send(server, 'POST', `${PUBLISHED}/${vaultId}/credentials/vcrd_missing`, { display_name: 'x' });
    expect(missing.status).toBe(404);

    const archived = await send(server, 'POST', `${PUBLISHED}/${vaultId}/archive`);
    expect(archived.status).toBe(200);
    const res = await send(server, 'POST', `${PUBLISHED}/${vaultId}/credentials/${credentialId}`, { display_name: 'x' });
    expect(res.status).toBe(404);
  });

  it('is mounted at the local prefix too', async () => {
    const server = setUp();
    const vaultId = await createVault(server);
    const credentialId = await createEnvCredential(server, vaultId);

    const res = await send(server, 'POST', `${LOCAL}/${vaultId}/credentials/${credentialId}`, {
      display_name: 'local-prefix rename',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body!.display_name).toBe('local-prefix rename');
  });
});
