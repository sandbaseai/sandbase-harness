/**
 * Unit tests for the vault credential runtime network policy.
 *
 * The injection boundary must authorize before decryption, keep denied secrets
 * out of every output, and avoid marking a denied credential as used.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { encryptSecret } from '@/core/security/secrets.js';
import { resolveSessionCredentialInjections } from '@/core/credentials/injection.js';
import {
  CREDENTIAL_POLICY_CODES,
  authorizeCredentialNetwork,
  hostMatchesPattern,
  normalizeCredentialNetworkPolicy,
  normalizeHost,
  parseCredentialNetworkPolicy,
} from '@/core/credentials/policy.js';

describe('credential network policy', () => {
  describe('normalization and matching', () => {
    it('keeps explicit unrestricted and degrades malformed shapes to limited', () => {
      expect(normalizeCredentialNetworkPolicy({ type: 'unrestricted', allowed_hosts: [] })).toEqual({ type: 'unrestricted', allowed_hosts: [] });
      expect(normalizeCredentialNetworkPolicy(undefined)).toEqual({ type: 'limited', allowed_hosts: [] });
      expect(normalizeCredentialNetworkPolicy('nonsense')).toEqual({ type: 'limited', allowed_hosts: [] });
      expect(normalizeCredentialNetworkPolicy({ allowed_hosts: ['a.com', 7, '', '  b.com  '] })).toEqual({
        type: 'limited', allowed_hosts: ['a.com', 'b.com'],
      });
    });

    it('parses missing and corrupt stored policy values fail closed', () => {
      expect(parseCredentialNetworkPolicy(null)).toEqual({ type: 'limited', allowed_hosts: [] });
      expect(parseCredentialNetworkPolicy('{not json')).toEqual({ type: 'limited', allowed_hosts: [] });
      expect(parseCredentialNetworkPolicy('{"type":"limited","allowed_hosts":["api.example.com"]}')).toEqual({
        type: 'limited', allowed_hosts: ['api.example.com'],
      });
    });

    it('normalizes hosts and URLs', () => {
      expect(normalizeHost('API.Example.com')).toBe('api.example.com');
      expect(normalizeHost('api.example.com:8443')).toBe('api.example.com:8443');
      expect(normalizeHost('https://api.example.com/v1/things?q=1')).toBe('api.example.com');
      expect(normalizeHost('https://user:pass@api.example.com:443/x')).toBe('api.example.com:443');
      expect(normalizeHost('api.example.com.')).toBe('api.example.com');
      expect(normalizeHost('   ')).toBeUndefined();
    });

    it('matches exact hosts, subdomain wildcards, and optional ports', () => {
      expect(hostMatchesPattern('api.example.com', 'API.example.com')).toBe(true);
      expect(hostMatchesPattern('api.example.com', 'example.com')).toBe(false);
      expect(hostMatchesPattern('a.example.com', '*.example.com')).toBe(true);
      expect(hostMatchesPattern('a.b.example.com', '*.example.com')).toBe(true);
      expect(hostMatchesPattern('example.com', '*.example.com')).toBe(false);
      expect(hostMatchesPattern('notexample.com', '*.example.com')).toBe(false);
      expect(hostMatchesPattern('api.example.com:8443', 'api.example.com:8443')).toBe(true);
      expect(hostMatchesPattern('api.example.com:8443', 'api.example.com:443')).toBe(false);
      expect(hostMatchesPattern('api.example.com:8443', 'api.example.com')).toBe(true);
      expect(hostMatchesPattern('anything.example.com', '*')).toBe(false);
    });

    it('returns stable allow/deny decisions', () => {
      const policy = { type: 'limited' as const, allowed_hosts: ['api.example.com', '*.internal.test'] };
      expect(authorizeCredentialNetwork(policy, 'api.example.com')).toMatchObject({ allowed: true });
      expect(authorizeCredentialNetwork(policy, 'x.internal.test')).toMatchObject({ allowed: true });
      expect(authorizeCredentialNetwork(policy, 'evil.test')).toMatchObject({
        allowed: false, reason: 'host_not_allowed', code: CREDENTIAL_POLICY_CODES.host_not_allowed,
      });
      expect(authorizeCredentialNetwork(policy)).toMatchObject({
        allowed: false, reason: 'host_unverified', code: CREDENTIAL_POLICY_CODES.host_unverified,
      });
      expect(authorizeCredentialNetwork({ type: 'unrestricted', allowed_hosts: [] })).toMatchObject({ allowed: true });
    });
  });

  describe('resolveSessionCredentialInjections enforcement', () => {
    let db: Database;
    let tmpDir: string;
    const vaultId = 'vlt_policy';

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'ma-cred-test-'));
      db = new Database(join(tmpDir, 'test.db'));
      db.runMigrations();
      db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_test', 'local', '{}')`);
      db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'test-agent', '{}')`);
      db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, vault_ids) VALUES ('sess_test', 'agent_test', 'test-agent', 'env_test', 'running', '["${vaultId}"]')`);
      db.prepare('INSERT INTO credential_vaults (id, name) VALUES (?, ?)').run(vaultId, 'policy vault');
    });

    afterEach(() => {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function insertCredential(opts: {
      id: string;
      network: { type: string; allowed_hosts: string[] };
      authType?: 'bearer_token' | 'environment_variable';
      variableName?: string;
      locations?: string[];
      value?: string;
      invalidCiphertext?: boolean;
      mcpServerUrl?: string;
    }) {
      const value = opts.value ?? 'super-secret-value';
      const encrypted = encryptSecret(value);
      db.prepare(
        `INSERT INTO credential_records (
          id, vault_id, name, auth_type, variable_name, value_hint, network,
          injection_locations, secret_ciphertext, secret_nonce, secret_tag, mcp_server_url, status, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '{}', ?, ?)`,
      ).run(
        opts.id,
        vaultId,
        opts.id,
        opts.authType ?? 'environment_variable',
        opts.variableName ?? opts.id.toUpperCase(),
        '••••alue',
        JSON.stringify(opts.network),
        JSON.stringify(opts.locations ?? ['request_headers']),
        opts.invalidCiphertext ? 'not-valid-ciphertext' : encrypted.ciphertext,
        opts.invalidCiphertext ? 'not-valid-nonce' : encrypted.nonce,
        opts.invalidCiphertext ? 'not-valid-tag' : encrypted.tag,
        opts.mcpServerUrl ?? null,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    }

    function auditActions(credentialId: string) {
      return db.prepare('SELECT action, metadata FROM credential_audit_events WHERE credential_id = ? ORDER BY created_at ASC')
        .all(credentialId) as Array<{ action: string; metadata: string }>;
    }

    it('injects an allowed credential and marks it used', () => {
      insertCredential({ id: 'crd_allowed', network: { type: 'limited', allowed_hosts: ['api.example.com'] } });
      const bundle = resolveSessionCredentialInjections(db, 'sess_test', { targetHost: 'https://api.example.com/v1' });
      expect(bundle.environment.CRD_ALLOWED).toBe('super-secret-value');
      expect(bundle.denied).toEqual([]);
      expect(auditActions('crd_allowed').map((row) => row.action)).toEqual(['runtime_inject']);
      expect((db.prepare('SELECT last_used_at FROM credential_records WHERE id = ?').get('crd_allowed') as { last_used_at: string | null }).last_used_at).not.toBeNull();
    });

    it('denies before decrypting and does not mark a denied credential used', () => {
      insertCredential({
        id: 'crd_blocked',
        network: { type: 'limited', allowed_hosts: ['api.example.com'] },
        invalidCiphertext: true,
      });
      const bundle = resolveSessionCredentialInjections(db, 'sess_test', { targetHost: 'evil.test' });
      expect(bundle.environment).toEqual({});
      expect(bundle.request_headers).toEqual({});
      expect(bundle.request_body).toEqual({});
      expect(bundle.credentials).toEqual([]);
      expect(bundle.denied).toHaveLength(1);
      expect(bundle.denied[0]).toMatchObject({
        credential_id: 'crd_blocked', host: 'evil.test', reason: 'host_not_allowed', code: CREDENTIAL_POLICY_CODES.host_not_allowed,
      });
      expect(auditActions('crd_blocked').map((row) => row.action)).toEqual(['runtime_denied']);
      expect((db.prepare('SELECT last_used_at FROM credential_records WHERE id = ?').get('crd_blocked') as { last_used_at: string | null }).last_used_at).toBeNull();
      expect(JSON.stringify(auditActions('crd_blocked'))).not.toContain('secret');
    });

    it('denies limited credentials when no target host is supplied', () => {
      insertCredential({ id: 'crd_unverified', network: { type: 'limited', allowed_hosts: ['api.example.com'] } });
      const bundle = resolveSessionCredentialInjections(db, 'sess_test');
      expect(bundle.environment).toEqual({});
      expect(bundle.denied[0]).toMatchObject({ host: null, reason: 'host_unverified', code: CREDENTIAL_POLICY_CODES.host_unverified });
    });

    it('still injects explicit unrestricted credentials without a target host', () => {
      insertCredential({ id: 'crd_open', network: { type: 'unrestricted', allowed_hosts: [] } });
      const bundle = resolveSessionCredentialInjections(db, 'sess_test');
      expect(bundle.environment.CRD_OPEN).toBe('super-secret-value');
      expect(bundle.denied).toEqual([]);
    });

    it('keeps allowed and denied credentials in the same bundle', () => {
      insertCredential({ id: 'crd_ok', network: { type: 'unrestricted', allowed_hosts: [] } });
      insertCredential({ id: 'crd_no', network: { type: 'limited', allowed_hosts: ['only.test'] } });
      const bundle = resolveSessionCredentialInjections(db, 'sess_test', { targetHost: 'api.example.com' });
      expect(Object.keys(bundle.environment)).toEqual(['CRD_OK']);
      expect(bundle.denied.map((entry) => entry.credential_id)).toEqual(['crd_no']);
    });

    it('keeps session vault isolation and empty sessions', () => {
      db.prepare("UPDATE sessions SET vault_ids = '[]' WHERE id = 'sess_test'").run();
      expect(resolveSessionCredentialInjections(db, 'sess_test', { targetHost: 'api.example.com' })).toMatchObject({ vaultIds: [], credentials: [], denied: [] });
      expect(() => resolveSessionCredentialInjections(db, 'sess_missing')).toThrow(/Session not found/);
    });

    it('honours injection locations for bearer tokens', () => {
      insertCredential({
        id: 'crd_bearer',
        network: { type: 'unrestricted', allowed_hosts: [] },
        authType: 'bearer_token',
        locations: ['request_headers', 'request_body'],
      });
      const bundle = resolveSessionCredentialInjections(db, 'sess_test', { targetHost: 'api.example.com' });
      expect(bundle.request_headers.Authorization).toBe('Bearer super-secret-value');
      expect(bundle.request_body.crd_bearer).toBe('super-secret-value');
    });

    it('does not give a keyed credential a position its record excluded', () => {
      // The boundary's rule for keyed credentials has two halves: "for a keyed row
      // an empty list means 'not specified' rather than 'nowhere'", and "a list that
      // was given is still respected as written, including one that enables the body
      // only, so a keyed credential never gains a position its record explicitly
      // excluded". The case above shows the second half failing open for an *unkeyed*
      // row, where the list is consulted either way, so it cannot see this: the
      // keyed default is the branch that would hand out a header the record refused.
      insertCredential({
        id: 'crd_body_only',
        network: { type: 'unrestricted', allowed_hosts: [] },
        authType: 'bearer_token',
        mcpServerUrl: 'https://here.example.com/mcp',
        locations: ['request_body'],
      });

      const bundle = resolveSessionCredentialInjections(db, 'sess_test', {
        mcpServerUrl: 'https://here.example.com/mcp',
        targetHost: 'https://here.example.com/mcp',
      });

      // The list was given, so the empty-location default does not apply to it.
      expect(bundle.request_headers.Authorization).toBeUndefined();
      expect(bundle.request_body.crd_body_only).toBe('super-secret-value');
      expect(bundle.credentials.map((entry) => entry.injection_locations)).toEqual([['request_body']]);
    });

    it('does not decrypt a credential that belongs to another server', () => {
      // The boundary says of a credential keyed by `mcp_server_url` that "the check
      // sits above the decrypt call, the secret is not even decrypted". The suite
      // already shows the *outcome* for an inapplicable credential - no header, no
      // denial, no audit row - and neither of those observations can tell whether
      // the ciphertext was touched, because not injecting it looks the same either
      // way. It can be told by handing the inapplicable row a ciphertext that cannot
      // be decrypted: reaching the decrypt would then throw, so resolving at all is
      // the evidence. This is the same instrument the host-policy case uses above.
      insertCredential({
        id: 'crd_other',
        network: { type: 'unrestricted', allowed_hosts: [] },
        authType: 'bearer_token',
        mcpServerUrl: 'https://other.example.com/mcp',
        invalidCiphertext: true,
      });
      insertCredential({
        id: 'crd_here',
        network: { type: 'unrestricted', allowed_hosts: [] },
        authType: 'bearer_token',
        mcpServerUrl: 'https://here.example.com/mcp',
      });

      const bundle = resolveSessionCredentialInjections(db, 'sess_test', {
        mcpServerUrl: 'https://here.example.com/mcp',
        targetHost: 'https://here.example.com/mcp',
      });

      // The credential for this server is the only one that arrives.
      expect(bundle.request_headers.Authorization).toBe('Bearer super-secret-value');
      expect(bundle.credentials.map((entry) => entry.id)).toEqual(['crd_here']);
      // Being inapplicable is still not a refusal, and it left no audit trail.
      expect(bundle.denied).toEqual([]);
      expect(auditActions('crd_other')).toEqual([]);
      expect((db.prepare('SELECT last_used_at FROM credential_records WHERE id = ?').get('crd_other') as { last_used_at: string | null }).last_used_at).toBeNull();
    });
  });
});
