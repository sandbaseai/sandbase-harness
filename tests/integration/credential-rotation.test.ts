/**
 * Integration test: the published credential rotation, use, and audit routes.
 *
 * `docs/api.md` publishes
 * `POST /v1/credential-vaults/{vault_id}/credentials/{credential_id}/rotate`,
 * `POST .../mark-used` and `GET .../audit`, and `docs/api-matrix.md` publishes the
 * vault-scoped audit listing. These assertions keep those published paths real,
 * and pin the property that makes rotation safe to expose: the previous secret is
 * genuinely replaced, a session that attaches the vault picks up the new value,
 * and the audit trail records the change without ever recording the secret.
 *
 * The snapshot this replays asserted a `refreshSessionMcpCredentials` hook that
 * this tree does not have; that hook and its assertion are dropped here rather
 * than faked, and the session assertion reads what the injection boundary
 * actually resolves.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import type { SessionExecutor } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { decryptSecret } from '@/core/security/secrets.js';
import { resolveSessionCredentialInjections } from '@/core/credentials/injection.js';

describe('Credential rotation and audit (documented routes)', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;
  let sessionManager: SessionManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-cred-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    db.prepare("INSERT INTO credential_vaults (id, name) VALUES ('vlt_test', 'test vault')").run();
    db.prepare("INSERT INTO credential_vaults (id, name) VALUES ('vlt_other', 'other vault')").run();
    // A session that attaches the vault, so injection can be exercised end to end.
    db.prepare(
      "INSERT INTO sessions (id, agent_id, agent_name, environment_id, vault_ids) VALUES ('sess_v', 'agent_x', 'x', 'env_a', ?)",
    ).run(JSON.stringify(['vlt_test']));

    sessionManager = new SessionManager(db);
    app = createServer({
      db,
      sessionManager,
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function post(path: string, body?: unknown) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { res, body: await res.json() as any };
  }

  async function get(path: string) {
    const res = await app.request(path);
    return { res, body: await res.json() as any };
  }

  async function addCredential(input: Record<string, unknown> = {}) {
    const { res, body } = await post('/v1/credential-vaults/vlt_test/credentials', {
      name: 'github-token',
      auth_type: 'environment_variable',
      variable_name: 'GITHUB_TOKEN',
      value: 'ghp_original',
      network: { type: 'unrestricted' },
      injection_locations: ['request_headers'],
      ...input,
    });
    expect(res.status).toBe(201);
    return body as { id: string; value_hint: string };
  }

  /** Read the stored plaintext the same way the runtime would. */
  function storedSecret(credentialId: string): string {
    const row = db.prepare(
      'SELECT secret_ciphertext, secret_nonce, secret_tag FROM credential_records WHERE id = ?',
    ).get(credentialId) as { secret_ciphertext: string; secret_nonce: string; secret_tag: string };
    return decryptSecret({
      ciphertext: row.secret_ciphertext,
      nonce: row.secret_nonce,
      tag: row.secret_tag,
    });
  }

  function auditActions(where: string, ...params: unknown[]): string[] {
    return (db.prepare(
      `SELECT action FROM credential_audit_events WHERE ${where} ORDER BY created_at ASC, rowid ASC`,
    ).all(...(params as never[])) as Array<{ action: string }>).map((row) => row.action);
  }

  it('replaces the stored secret and keeps the credential identity', async () => {
    const credential = await addCredential();
    const before = db.prepare('SELECT * FROM credential_records WHERE id = ?').get(credential.id) as Record<string, unknown>;
    expect(storedSecret(credential.id)).toBe('ghp_original');

    const rotated = await post(
      `/v1/credential-vaults/vlt_test/credentials/${credential.id}/rotate`,
      { value: 'ghp_rotated' },
    );
    expect(rotated.res.status).toBe(200);
    expect(rotated.body.value_hint).toBe('••••ated');

    const after = db.prepare('SELECT * FROM credential_records WHERE id = ?').get(credential.id) as Record<string, unknown>;
    // The ciphertext actually changed, and now decrypts to the new value.
    expect(after.secret_ciphertext).not.toBe(before.secret_ciphertext);
    expect(storedSecret(credential.id)).toBe('ghp_rotated');
    // Everything that identifies the credential is untouched.
    for (const field of ['id', 'vault_id', 'name', 'auth_type', 'variable_name', 'network', 'injection_locations']) {
      expect(after[field], field).toEqual(before[field]);
    }
  });

  it('lets an attached session pick up the rotated value without recreating it', async () => {
    const credential = await addCredential();
    // The environment channel only materializes as placeholders now, so the
    // rotation observable is the value the boundary substitutes behind the
    // stable token, not the process-facing value.
    expect(resolveSessionCredentialInjections(db, 'sess_v', { targetHost: 'https://api.github.com', placeholders: true })
      .placeholders[0]?.value).toBe('ghp_original');

    await post(`/v1/credential-vaults/vlt_test/credentials/${credential.id}/rotate`, { value: 'ghp_rotated' });

    const bundle = resolveSessionCredentialInjections(db, 'sess_v', { targetHost: 'https://api.github.com', placeholders: true });
    expect(bundle.environment.GITHUB_TOKEN).toBe(`__cred_${credential.id}__`);
    expect(bundle.placeholders[0]?.value).toBe('ghp_rotated');
    expect(bundle.credentials[0].id).toBe(credential.id);
  });

  it('records a rotate audit event with actor and metadata', async () => {
    const credential = await addCredential();
    await post(`/v1/credential-vaults/vlt_test/credentials/${credential.id}/rotate`, {
      value: 'ghp_rotated',
      actor: 'operator',
      metadata: { reason: 'scheduled' },
    });

    const event = db.prepare(
      "SELECT * FROM credential_audit_events WHERE credential_id = ? AND action = 'rotate'",
    ).get(credential.id) as { actor: string; metadata: string };
    expect(event.actor).toBe('operator');
    expect(JSON.parse(event.metadata)).toEqual({ reason: 'scheduled' });

    // The audit row must not contain secret material.
    const all = JSON.stringify(db.prepare('SELECT * FROM credential_audit_events').all());
    expect(all).not.toContain('ghp_original');
    expect(all).not.toContain('ghp_rotated');
    expect(credential.value_hint).not.toContain('ghp_rotated');
  });

  it('requires a new value and rejects an unknown or retired credential', async () => {
    const credential = await addCredential();
    const rotate = (id: string, body: unknown) =>
      post(`/v1/credential-vaults/vlt_test/credentials/${id}/rotate`, body);

    expect((await rotate(credential.id, {})).res.status).toBe(400);
    expect((await rotate(credential.id, { value: '' })).res.status).toBe(400);
    // The failed attempts must not have touched the secret.
    expect(storedSecret(credential.id)).toBe('ghp_original');

    expect((await rotate('vcrd_missing', { value: 'x' })).res.status).toBe(404);
    expect((await post('/v1/credential-vaults/vlt_missing/credentials/vcrd_x/rotate', { value: 'x' })).res.status).toBe(404);

    await post(`/v1/credential-vaults/vlt_test/credentials/${credential.id}/archive`);
    const archived = await rotate(credential.id, { value: 'ghp_should_not_apply' });
    expect(archived.res.status).toBe(404);
    expect(storedSecret(credential.id)).toBe('ghp_original');
  });

  it('marks a credential used with or without a body', async () => {
    const credential = await addCredential();
    expect((db.prepare('SELECT last_used_at FROM credential_records WHERE id = ?').get(credential.id) as { last_used_at: string | null }).last_used_at).toBeNull();

    const withBody = await post(`/v1/credential-vaults/vlt_test/credentials/${credential.id}/mark-used`, {
      metadata: { source: 'cli' },
    });
    expect(withBody.res.status).toBe(200);
    expect(withBody.body.last_used_at).toBeTruthy();
    expect(auditActions('credential_id = ?', credential.id)).toEqual(['mark_used']);

    // No body at all is the common case and must still work.
    const noBody = await post(`/v1/credential-vaults/vlt_test/credentials/${credential.id}/mark-used`);
    expect(noBody.res.status).toBe(200);
    expect(auditActions('credential_id = ?', credential.id)).toEqual(['mark_used', 'mark_used']);
  });

  it('lists audit events at credential and vault scope, newest first', async () => {
    const first = await addCredential({ name: 'first' });
    const second = await addCredential({ name: 'second', variable_name: 'SECOND_TOKEN', value: 'second-value' });

    await post(`/v1/credential-vaults/vlt_test/credentials/${first.id}/rotate`, { value: 'rotated-1' });
    await post(`/v1/credential-vaults/vlt_test/credentials/${second.id}/mark-used`);

    const credentialScope = await get(`/v1/credential-vaults/vlt_test/credentials/${first.id}/audit`);
    expect(credentialScope.res.status).toBe(200);
    expect(credentialScope.body.data.map((e: any) => e.action)).toEqual(['rotate']);
    expect(credentialScope.body.data[0]).toMatchObject({
      type: 'credential_audit_event',
      vault_id: 'vlt_test',
      credential_id: first.id,
    });

    const vaultScope = await get('/v1/credential-vaults/vlt_test/audit');
    expect(vaultScope.res.status).toBe(200);
    expect(vaultScope.body.data.map((e: any) => e.action).sort()).toEqual(['mark_used', 'rotate']);
    // Another vault's events are not included.
    expect(vaultScope.body.data.every((e: any) => e.vault_id === 'vlt_test')).toBe(true);
  });

  it('keeps the audit trail after the credential is deleted', async () => {
    const credential = await addCredential();
    await post(`/v1/credential-vaults/vlt_test/credentials/${credential.id}/rotate`, { value: 'rotated' });

    const deleted = await app.request(`/v1/credential-vaults/vlt_test/credentials/${credential.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);

    // The credential is gone physically — listings, retrieve and its own
    // audit path all answer as if it never existed — but its history is not:
    // the vault-scoped trail keeps the rotate and the delete itself.
    const listed = await get('/v1/credential-vaults/vlt_test/credentials');
    expect(listed.body.data).toEqual([]);
    expect((await get(`/v1/credential-vaults/vlt_test/credentials/${credential.id}`)).res.status).toBe(404);
    expect((await get(`/v1/credential-vaults/vlt_test/credentials/${credential.id}/audit`)).res.status).toBe(404);

    const audit = await get('/v1/credential-vaults/vlt_test/audit');
    expect(audit.res.status).toBe(200);
    expect(audit.body.data.filter((e: any) => e.credential_id === credential.id).map((e: any) => e.action))
      .toEqual(['delete', 'rotate']);
  });

  it('honours the audit limit and rejects unknown vaults', async () => {
    const credential = await addCredential();
    await post(`/v1/credential-vaults/vlt_test/credentials/${credential.id}/mark-used`);
    await post(`/v1/credential-vaults/vlt_test/credentials/${credential.id}/mark-used`);
    await post(`/v1/credential-vaults/vlt_test/credentials/${credential.id}/mark-used`);

    const limited = await get(`/v1/credential-vaults/vlt_test/credentials/${credential.id}/audit?limit=2`);
    expect(limited.body.data).toHaveLength(2);

    expect((await get('/v1/credential-vaults/vlt_missing/audit')).res.status).toBe(404);
    expect((await get('/v1/credential-vaults/vlt_missing/credentials/vcrd_x/audit')).res.status).toBe(404);
    expect((await get('/v1/credential-vaults/vlt_test/credentials/vcrd_missing/audit')).res.status).toBe(404);
    expect((await post('/v1/credential-vaults/vlt_missing/credentials/vcrd_x/mark-used')).res.status).toBe(404);
  });

  /**
   * The reconnect half of the rotation contract, which the snapshot asserted and a
   * previous replay had to drop: `contracts/anthropic-cma/credentials.md` §2 promises
   * that "the runtime asks each Session's MCP manager to close and reconnect its
   * configured transports", and §6 cites a case for it.
   */
  describe('MCP reconnect', () => {
    it('asks every live session that references the rotated vault, and no other', async () => {
      const credential = await addCredential();
      const notified: string[] = [];
      sessionManager.setExecutor({
        execute: () => { throw new Error('not used by this case'); },
        refreshSessionMcpCredentials: async (sessionId: string) => { notified.push(sessionId); },
      } as unknown as SessionExecutor);

      // `sess_v` from the fixture references `vlt_test`; the other two are the
      // controls — one references a different vault, one has already finished.
      db.prepare(
        "INSERT INTO sessions (id, agent_id, agent_name, environment_id, vault_ids, status) VALUES ('sess_other', 'agent_x', 'x', 'env_a', '[\"vlt_other\"]', 'running')",
      ).run();
      db.prepare(
        "INSERT INTO sessions (id, agent_id, agent_name, environment_id, vault_ids, status) VALUES ('sess_done', 'agent_x', 'x', 'env_a', '[\"vlt_test\"]', 'completed')",
      ).run();

      const rotated = await post(`/v1/credential-vaults/vlt_test/credentials/${credential.id}/rotate`, {
        value: 'ghp_rotated',
      });

      expect(rotated.res.status).toBe(200);
      expect(notified).toEqual(['sess_v']);
    });

    it('keeps the rotation committed when a reconnect fails', async () => {
      const credential = await addCredential();
      sessionManager.setExecutor({
        execute: () => { throw new Error('not used by this case'); },
        refreshSessionMcpCredentials: async () => { throw new Error('server is down'); },
      } as unknown as SessionExecutor);

      const rotated = await post(`/v1/credential-vaults/vlt_test/credentials/${credential.id}/rotate`, {
        value: 'ghp_rotated',
      });

      // The published rule: reconnect failures do not roll back the committed
      // rotation, because the MCP status is what reports a degraded server.
      expect(rotated.res.status).toBe(200);
      expect(storedSecret(credential.id)).toBe('ghp_rotated');
      expect(auditActions('credential_id = ?', credential.id)).toContain('rotate');
    });
  });
});
