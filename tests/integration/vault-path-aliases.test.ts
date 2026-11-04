/**
 * Integration test: vaults answer at the published paths.
 *
 * The published contract addresses vaults at `/v1/vaults*`, while this runtime's
 * own paths are `/v1/credential-vaults*`. Both are served by one router mounted
 * twice, and this file is where that claim is checked over HTTP rather than
 * asserted about the code: a vault created through one spelling must be readable
 * through the other, because "the two spellings are the same resource" is exactly
 * the property a caller depends on when they follow the published documentation
 * and something else in their toolchain still uses the local one.
 *
 * The published prefix is also a CMA resource path, so it inherits the same
 * version and beta admission as the canonical one. That half is asserted here
 * too: a new path that quietly skipped admission would be a security-shaped
 * regression dressed up as an alias.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import {
  CMA_AGENT_MEMORY_BETA,
  CMA_ANTHROPIC_VERSION,
  CMA_MANAGED_AGENTS_BETA,
} from '@/core/cma/compatibility.js';

const CANONICAL = '/v1/credential-vaults';
const PUBLISHED = '/v1/vaults';

describe('Vault paths, published and local', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let app: ReturnType<typeof createServer> | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    app = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function setUp(): ReturnType<typeof createServer> {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-vault-alias-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare(
      "INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')",
    ).run();
    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
    });
    return app;
  }

  async function send(
    server: ReturnType<typeof createServer>,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await server.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) as Record<string, any> : undefined };
  }

  it('creates a vault at the published path and reads it back at both', async () => {
    const server = setUp();

    const created = await send(server, 'POST', PUBLISHED, { name: 'deploy secrets' });
    expect(created.status).toBe(201);
    expect(created.body?.name).toBe('deploy secrets');
    expect(created.body?.type).toBe('vault');
    const id = created.body!.id as string;

    // The same vault, addressed either way. This is the whole feature: a caller
    // following the published documentation and a caller using the local spelling
    // are looking at one resource.
    const viaPublished = await send(server, 'GET', `${PUBLISHED}/${id}`);
    const viaCanonical = await send(server, 'GET', `${CANONICAL}/${id}`);
    expect(viaPublished.status).toBe(200);
    expect(viaCanonical.status).toBe(200);
    expect(viaPublished.body).toEqual({ ...viaCanonical.body, type: 'vault' });
    expect(viaCanonical.body?.type).toBe('credential_vault');
  });

  it('lists the same vaults at both spellings', async () => {
    const server = setUp();
    await send(server, 'POST', CANONICAL, { name: 'one' });
    await send(server, 'POST', PUBLISHED, { name: 'two' });

    const published = await send(server, 'GET', PUBLISHED);
    const canonical = await send(server, 'GET', CANONICAL);
    expect(published.status).toBe(200);
    expect(canonical.status).toBe(200);
    expect(published.body).toEqual({
      ...canonical.body,
      data: canonical.body!.data.map((vault: Record<string, unknown>) => ({ ...vault, type: 'vault' })),
    });
    expect(canonical.body!.data.every((vault: Record<string, unknown>) => vault.type === 'credential_vault')).toBe(true);
    expect((published.body!.data as { name: string }[]).map((vault) => vault.name).sort())
      .toEqual(['one', 'two']);
  });

  it.each([PUBLISHED, CANONICAL])('preserves shared state and the mount kind through %s lifecycle', async (prefix) => {
    const server = setUp();
    const kind = prefix === PUBLISHED ? 'vault' : 'credential_vault';
    const other = prefix === PUBLISHED ? CANONICAL : PUBLISHED;
    const otherKind = prefix === PUBLISHED ? 'credential_vault' : 'vault';
    const created = await send(server, 'POST', prefix, {
      display_name: 'shared', metadata: { keep: 'yes', remove: 'old' },
    });
    expect(created.status).toBe(201);
    expect(created.body?.type).toBe(kind);
    const id = created.body!.id as string;

    const updated = await send(server, 'POST', `${other}/${id}`, {
      display_name: 'renamed', metadata: { remove: null, added: 'new' },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ id, type: otherKind, metadata: { keep: 'yes', added: 'new' } });
    const read = await send(server, 'GET', `${prefix}/${id}`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ ...updated.body, type: kind });

    // Page cursors address the shared collection, not a representation.
    await send(server, 'POST', other, { display_name: 'newer' });
    const first = await send(server, 'GET', `${prefix}?limit=1`);
    expect(first.status).toBe(200);
    expect(first.body!.data[0].type).toBe(kind);
    expect(first.body!.next_page).toEqual(expect.any(String));
    const next = await send(server, 'GET', `${other}?limit=1&page=${encodeURIComponent(first.body!.next_page)}`);
    expect(next.status).toBe(200);
    expect(next.body!.data).toEqual([{ ...read.body, type: otherKind }]);

    const archived = await send(server, 'POST', `${prefix}/${id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ id, type: kind, status: 'archived' });
    for (const [path, expectedKind] of [[prefix, kind], [other, otherKind]]) {
      const listed = await send(server, 'GET', `${path}?include_archived=true`);
      expect(listed.status).toBe(200);
      expect(listed.body!.data).toContainEqual(expect.objectContaining({
        id, type: expectedKind, status: 'archived',
      }));
    }
    const deleted = await send(server, 'DELETE', `${other}/${id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ id, type: 'vault_deleted' });
    expect((await send(server, 'GET', `${prefix}/${id}`)).status).toBe(404);
  });

  it('answers the nested credential paths at both spellings', async () => {
    const server = setUp();
    const created = await send(server, 'POST', PUBLISHED, { name: 'vault' });
    const id = created.body!.id as string;

    const added = await send(server, 'POST', `${PUBLISHED}/${id}/credentials`, {
      display_name: 'Deploy key',
      auth: { type: 'environment_variable', secret_name: 'DEPLOY_KEY', secret_value: 'sk-live-9f3a' },
    });
    expect(added.status).toBe(201);

    // Read back through the *other* spelling: the credential sub-resource is the
    // same resource, and the secret is still masked on both.
    const viaCanonical = await send(server, 'GET', `${CANONICAL}/${id}/credentials`);
    expect(viaCanonical.status).toBe(200);
    const [credential] = viaCanonical.body!.data as Record<string, any>[];
    expect(credential.display_name).toBe('Deploy key');
    expect(JSON.stringify(credential)).not.toContain('sk-live-9f3a');

    const viaPublished = await send(server, 'GET', `${PUBLISHED}/${id}/credentials`);
    expect(viaPublished.body).toEqual(viaCanonical.body);
  });

  it('archives a vault at the published path and hides it from both lists', async () => {
    const server = setUp();
    const created = await send(server, 'POST', PUBLISHED, { name: 'temporary' });
    const id = created.body!.id as string;

    const archived = await send(server, 'POST', `${PUBLISHED}/${id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body?.type).toBe('vault');

    // Archived means gone from the collection under either spelling, and a read
    // by id is a 404 under either spelling.
    for (const prefix of [PUBLISHED, CANONICAL]) {
      const listed = await send(server, 'GET', prefix);
      expect((listed.body!.data as { id: string }[]).map((vault) => vault.id)).not.toContain(id);
      const read = await send(server, 'GET', `${prefix}/${id}`);
      expect(read.status).toBe(404);
      expect(read.body?.error?.type).toBe('not_found');
    }
  });

  it('keeps every vault route reachable at both prefixes', async () => {
    const server = setUp();
    // The `rotate`, `mark-used`, `audit` and credential-audit routes are local
    // management extensions with no published equivalent. They are aliased all the
    // same, because the alias is a mount rather than a curated list: a caller who
    // learned one spelling does not have to learn which routes answer at it.
    const created = await send(server, 'POST', PUBLISHED, { name: 'vault' });
    const id = created.body!.id as string;
    const added = await send(server, 'POST', `${CANONICAL}/${id}/credentials`, {
      display_name: 'Key',
      auth: { type: 'environment_variable', secret_name: 'ROTATE_KEY', secret_value: 'sk-live-9f3a' },
    });
    // Asserted rather than assumed: without it a failed create would turn every
    // call below into a 404 and the test would report the wrong cause.
    expect(added.status).toBe(201);
    const credentialId = added.body!.id as string;
    expect(credentialId).toBeTruthy();

    const rotated = await send(
      server,
      'POST',
      `${PUBLISHED}/${id}/credentials/${credentialId}/rotate`,
      { value: 'sk-live-rotated' },
    );
    expect(rotated.status).toBe(200);

    const used = await send(server, 'POST', `${PUBLISHED}/${id}/credentials/${credentialId}/mark-used`);
    expect(used.status).toBe(200);

    for (const path of [
      `${PUBLISHED}/${id}/audit`,
      `${PUBLISHED}/${id}/credentials/${credentialId}/audit`,
    ]) {
      const res = await send(server, 'GET', path);
      expect(res.status).toBe(200);
    }
  });

  it('admits the published prefix under the managed-agents beta, like the canonical one', async () => {
    const server = setUp();
    const compatibility = {
      'x-api-key': 'test-key',
      'anthropic-version': CMA_ANTHROPIC_VERSION,
      'anthropic-beta': CMA_MANAGED_AGENTS_BETA,
    };

    for (const prefix of [CANONICAL, PUBLISHED]) {
      const res = await send(server, 'GET', prefix, undefined, compatibility);
      expect(res.status).toBe(200);
    }
  });

  it('refuses the published prefix without the beta, rather than letting it slip past admission', async () => {
    const server = setUp();

    // A compatibility caller that declares no beta at all is refused, naming the
    // missing header — the new path is inside admission, not outside it.
    const withoutBeta = await send(server, 'GET', PUBLISHED, undefined, {
      'x-api-key': 'test-key',
      'anthropic-version': CMA_ANTHROPIC_VERSION,
    });
    expect(withoutBeta.status).toBe(400);
    expect(withoutBeta.body?.error?.code ?? withoutBeta.body?.error?.type).toBeDefined();

    // And the agent-memory beta does not admit it. This is the assertion that
    // matters: `/v1/vaults` must not inherit the one memory-store exception, so a
    // vault path requires the same beta under either spelling.
    const wrongBeta = await send(server, 'GET', PUBLISHED, undefined, {
      'x-api-key': 'test-key',
      'anthropic-version': CMA_ANTHROPIC_VERSION,
      'anthropic-beta': CMA_AGENT_MEMORY_BETA,
    });
    const canonicalWrongBeta = await send(server, 'GET', CANONICAL, undefined, {
      'x-api-key': 'test-key',
      'anthropic-version': CMA_ANTHROPIC_VERSION,
      'anthropic-beta': CMA_AGENT_MEMORY_BETA,
    });
    expect(wrongBeta.status).toBe(400);
    expect(wrongBeta.body).toEqual(canonicalWrongBeta.body);
  });
});
