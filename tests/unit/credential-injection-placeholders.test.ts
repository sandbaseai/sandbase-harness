/**
 * Placeholder materialization and delegated vault scoping in the credential
 * injection boundary.
 *
 * Two behaviors, both at `resolveSessionCredentialInjections` because that is
 * where the policy decision lives:
 *
 * - `placeholders: true` moves environment credentials out of the process as
 *   `__cred_<id>__` tokens and reports the substitution table the sandbox's
 *   egress boundary registers. A `limited` credential with no declared target
 *   host — denied outright under plaintext — is admissible here, because its
 *   value can only materialize on requests its own `allowed_hosts` covers.
 * - `vaultIds` in the target overrides the session row, which is how a
 *   delegated sub-agent inherits exactly the parent session's vaults: the
 *   child row is never persisted, and the override can only narrow to ids the
 *   parent references.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { encryptSecret } from '@/core/security/secrets.js';
import { resolveSessionCredentialInjections } from '@/core/credentials/injection.js';

const SECRET = 'placeholder-demo-secret';

function seedCredential(
  db: Database,
  dataDir: string,
  opts: { id: string; vaultId?: string; network: unknown },
): void {
  const encrypted = encryptSecret(SECRET, dataDir);
  db.prepare(
    `INSERT INTO credential_records (
      id, vault_id, name, auth_type, variable_name, value_hint, network,
      injection_locations, secret_ciphertext, secret_nonce, secret_tag, status, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, 'environment_variable', 'TOKEN', '••••cret', ?, '[]', ?, ?, ?, 'active', '{}', ?, ?)`,
  ).run(
    opts.id, opts.vaultId ?? 'vlt_a', 'token', JSON.stringify(opts.network),
    encrypted.ciphertext, encrypted.nonce, encrypted.tag, new Date().toISOString(), new Date().toISOString(),
  );
}

describe('credential injection — placeholders', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  function setup(): Database {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-credential-placeholders-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_x', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('a', 'a', '{}')`);
    db.exec(`INSERT INTO credential_vaults (id, name) VALUES ('vlt_a', 'a'), ('vlt_b', 'b')`);
    db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, vault_ids) VALUES ('sess_ph', 'a', 'a', 'env_x', 'running', '["vlt_a","vlt_b"]')`);
    return db;
  }

  afterEach(() => {
    db?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits a stable per-credential token in the environment and the real value only in the substitution table', () => {
    const db = setup();
    seedCredential(db, tmpDir!, { id: 'crd_ph', network: { type: 'unrestricted', allowed_hosts: [] } });

    const bundle = resolveSessionCredentialInjections(db, 'sess_ph', { dataDir: tmpDir, placeholders: true });

    expect(bundle.environment.TOKEN).toBe('__cred_crd_ph__');
    expect(bundle.environment.TOKEN).not.toBe(SECRET);
    expect(bundle.placeholders).toEqual([{
      credential_id: 'crd_ph',
      placeholder: '__cred_crd_ph__',
      value: SECRET,
      allowed_hosts: null,
    }]);
  });

  it('refuses an environment credential when the caller cannot substitute', () => {
    const db = setup();
    seedCredential(db, tmpDir!, { id: 'crd_plain', network: { type: 'unrestricted', allowed_hosts: [] } });

    // A boundary-less caller is the published "self-hosted" case: the contract
    // does not support environment credentials there, and plaintext would put
    // the secret inside the process, so the answer is a refusal rather than a
    // degraded materialization.
    const bundle = resolveSessionCredentialInjections(db, 'sess_ph', { dataDir: tmpDir });

    expect(bundle.environment.TOKEN).toBeUndefined();
    expect(bundle.placeholders).toEqual([]);
    expect(bundle.denied).toHaveLength(1);
    expect(bundle.denied[0]).toMatchObject({
      credential_id: 'crd_plain',
      host: null,
      reason: 'backend_unsupported',
      code: 'credential_backend_unsupported',
    });
  });

  it('admits a limited credential with no target host under placeholders, scoped to its own allowed_hosts', () => {
    const db = setup();
    seedCredential(db, tmpDir!, {
      id: 'crd_limited',
      network: { type: 'limited', allowed_hosts: ['api.example.com'] },
    });

    // Without a boundary the credential is refused before the host question is
    // even asked: plaintext would hold the secret for any destination.
    const denied = resolveSessionCredentialInjections(db, 'sess_ph', { dataDir: tmpDir });
    expect(denied.environment.TOKEN).toBeUndefined();
    expect(denied.denied[0]?.reason).toBe('backend_unsupported');

    // The placeholder shape admits: the token is inert until a request to
    // api.example.com crosses the boundary.
    const admitted = resolveSessionCredentialInjections(db, 'sess_ph', { dataDir: tmpDir, placeholders: true });
    expect(admitted.environment.TOKEN).toBe('__cred_crd_limited__');
    expect(admitted.placeholders[0]?.allowed_hosts).toEqual(['api.example.com']);
    expect(admitted.denied).toEqual([]);
  });

  it('still denies a limited credential whose named host its policy does not cover', () => {
    const db = setup();
    seedCredential(db, tmpDir!, {
      id: 'crd_offhost',
      network: { type: 'limited', allowed_hosts: ['api.example.com'] },
    });

    const bundle = resolveSessionCredentialInjections(db, 'sess_ph', {
      dataDir: tmpDir,
      placeholders: true,
      targetHost: 'unrelated.example.net',
    });
    expect(bundle.environment.TOKEN).toBeUndefined();
    expect(bundle.denied[0]?.reason).toBe('host_not_allowed');
  });
});

describe('credential injection — delegated vault scope', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  function setup(): Database {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-credential-delegation-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_x', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('a', 'a', '{}')`);
    db.exec(`INSERT INTO credential_vaults (id, name) VALUES ('vlt_a', 'a'), ('vlt_b', 'b')`);
    db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, vault_ids) VALUES ('sess_parent', 'a', 'a', 'env_x', 'running', '["vlt_a","vlt_b"]')`);
    seedCredential(db, tmpDir!, { id: 'crd_a', vaultId: 'vlt_a', network: { type: 'unrestricted', allowed_hosts: [] } });
    const encrypted = encryptSecret('vault-b-secret', tmpDir!);
    db.prepare(
      `INSERT INTO credential_records (
        id, vault_id, name, auth_type, variable_name, value_hint, network,
        injection_locations, secret_ciphertext, secret_nonce, secret_tag, status, metadata, created_at, updated_at
      ) VALUES ('crd_b', 'vlt_b', 'other', 'environment_variable', 'OTHER', '••••', ?, '[]', ?, ?, ?, 'active', '{}', ?, ?)`,
    ).run(
      JSON.stringify({ type: 'unrestricted', allowed_hosts: [] }),
      encrypted.ciphertext, encrypted.nonce, encrypted.tag, new Date().toISOString(), new Date().toISOString(),
    );
    return db;
  }

  afterEach(() => {
    db?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves an unpersisted child session against the parent vault ids', () => {
    const db = setup();
    // A delegated child row never exists; the override carries the scope, and
    // the child's own boundary is what the placeholders register on.
    const bundle = resolveSessionCredentialInjections(db, 'subsess_child', { dataDir: tmpDir, vaultIds: ['vlt_a', 'vlt_b'], placeholders: true });

    expect(bundle.environment.TOKEN).toBe('__cred_crd_a__');
    expect(bundle.environment.OTHER).toBe('__cred_crd_b__');
    expect(bundle.placeholders.map((entry) => entry.value).sort()).toEqual([SECRET, 'vault-b-secret'].sort());
    expect(bundle.vaultIds).toEqual(['vlt_a', 'vlt_b']);
  });

  it('narrows the child to the vaults the parent actually references', () => {
    const db = setup();
    const bundle = resolveSessionCredentialInjections(db, 'subsess_child', { dataDir: tmpDir, vaultIds: ['vlt_a'], placeholders: true });

    expect(bundle.environment.TOKEN).toBe('__cred_crd_a__');
    expect(bundle.environment.OTHER).toBeUndefined();
    expect(bundle.vaultIds).toEqual(['vlt_a']);
  });

  it('ignores override entries that are not vault ids', () => {
    const db = setup();
    const bundle = resolveSessionCredentialInjections(db, 'subsess_child', { dataDir: tmpDir, vaultIds: ['vlt_a', 'sess_parent', 'other-id'], placeholders: true });

    expect(bundle.vaultIds).toEqual(['vlt_a']);
  });
});
