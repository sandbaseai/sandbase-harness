/**
 * Canonical credential wire profile: `injection_location` semantics.
 *
 * The published contract resolves `injection_location` differently on create
 * and update, and treats an explicit `null` as a caller error. These tests pin
 * each published rule so the parser cannot drift back to a guess.
 */

import { describe, it, expect } from 'vitest';
import {
  CANONICAL_CREDENTIAL_TYPES,
  LOCKED_CREDENTIAL_FIELDS,
  WRITE_ONLY_CREDENTIAL_FIELDS,
  checkCredentialUpdate,
  isValidEnvVarName,
  mcpServerUrlMatches,
  parseCredentialAuth,
  resolveInjectionLocation,
  toCanonicalCredential,
} from '@/core/credentials/canonical-credential.js';

describe('resolveInjectionLocation', () => {
  it('enables both positions when the field is omitted', () => {
    const result = resolveInjectionLocation(undefined);
    expect(result).toEqual({ ok: true, value: { header: true, body: true } });
  });

  it('fills omitted fields with false when the object is supplied', () => {
    expect(resolveInjectionLocation({ header: true })).toEqual({
      ok: true,
      value: { header: true, body: false },
    });
    expect(resolveInjectionLocation({ body: true })).toEqual({
      ok: true,
      value: { header: false, body: true },
    });
  });

  it('rejects an explicit null object rather than defaulting it', () => {
    const result = resolveInjectionLocation(null);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('omit the field instead');
  });

  it('rejects an explicit null field rather than defaulting it', () => {
    const headerNull = resolveInjectionLocation({ header: null, body: true });
    expect(headerNull.ok).toBe(false);
    expect(headerNull.ok ? '' : headerNull.message).toContain('header must not be null');
  });

  it('rejects a resolved pair with both positions disabled', () => {
    const result = resolveInjectionLocation({ header: false, body: false });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('at least one');
  });

  it('rejects non-boolean field values', () => {
    const result = resolveInjectionLocation({ header: 'yes' });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('must be a boolean');
  });
});

describe('parseCredentialAuth canonical auth', () => {
  it('parses an environment variable credential with an explicit location', () => {
    const result = parseCredentialAuth({
      auth: {
        type: 'environment_variable',
        secret_name: 'NOTION_API_KEY',
        secret_value: 'ntn_secret',
        networking: { type: 'limited', allowed_hosts: ['api.notion.com'] },
        injection_location: { header: true },
      },
      display_name: 'Notion key',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authType).toBe('environment_variable');
    expect(result.value.displayName).toBe('Notion key');
    expect(result.value.secretName).toBe('NOTION_API_KEY');
    expect(result.value.secretValue).toBe('ntn_secret');
    expect(result.value.injectionLocation).toEqual({ header: true, body: false });
  });

  it('defaults an environment variable location to both positions when omitted', () => {
    const result = parseCredentialAuth({
      auth: { type: 'environment_variable', secret_name: 'MY_KEY', secret_value: 'v' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.injectionLocation).toEqual({ header: true, body: true });
  });

  it('requires mcp_server_url for static_bearer', () => {
    const result = parseCredentialAuth({ auth: { type: 'static_bearer', token: 'lsk' } });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('mcp_server_url is required');
  });

  it('parses a static_bearer credential keyed by its MCP server', () => {
    const result = parseCredentialAuth({
      auth: { type: 'static_bearer', mcp_server_url: 'https://mcp.linear.app/mcp', token: 'lin_api_key' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authType).toBe('bearer_token');
    expect(result.value.mcpServerUrl).toBe('https://mcp.linear.app/mcp');
    expect(result.value.secretValue).toBe('lin_api_key');
  });

  it('records an OAuth refresh block but warns that it will not run', () => {
    const result = parseCredentialAuth({
      auth: {
        type: 'mcp_oauth',
        mcp_server_url: 'https://mcp.example.com/mcp',
        access_token: 'at',
        refresh: {
          token_endpoint: 'https://auth.example.com/token',
          client_id: 'client-1',
          token_endpoint_auth: { type: 'client_secret_post', client_secret: 'cs' },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refresh).toEqual({
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      hasClientSecret: true,
      tokenEndpointAuthType: 'client_secret_post',
    });
    expect(result.warnings.join(' ')).toContain('not executed');
  });

  it('refuses a payload that supplies both auth and the flat spelling', () => {
    const result = parseCredentialAuth({
      auth: { type: 'static_bearer', mcp_server_url: 'https://mcp.example.com/mcp' },
      auth_type: 'bearer_token',
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('not both');
  });

  it('rejects an unknown canonical auth type', () => {
    const result = parseCredentialAuth({ auth: { type: 'api_key', secret_name: 'X' } });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain(CANONICAL_CREDENTIAL_TYPES.join(', '));
  });
});

describe('parseCredentialAuth flat legacy auth', () => {
  it('keeps the flat environment variable shape working', () => {
    const result = parseCredentialAuth({
      auth_type: 'environment_variable',
      variable_name: 'MY_API_KEY',
      value: 'secret-env-token',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.secretName).toBe('MY_API_KEY');
    expect(result.value.secretValue).toBe('secret-env-token');
    // Omitting the local token list means both positions, matching the
    // canonical default rather than injecting nowhere.
    expect(result.value.injectionLocation).toEqual({ header: true, body: true });
  });

  it('preserves an explicit local token list for an MCP credential', () => {
    const result = parseCredentialAuth({
      auth_type: 'bearer_token',
      mcp_server_url: 'https://mcp.example.com/mcp',
      value: 'secret',
      injection_locations: ['request_headers', 'request_headers', 'request_body'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.legacyInjectionTokens).toEqual(['request_headers', 'request_body']);
  });

  it('refuses an unsupported local injection token', () => {
    const result = parseCredentialAuth({
      auth_type: 'mcp_oauth',
      mcp_server_url: 'https://mcp.example.com/mcp',
      injection_locations: ['headers'],
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('request_headers');
  });

  it('requires a value for a flat bearer credential', () => {
    const result = parseCredentialAuth({
      auth_type: 'bearer_token',
      mcp_server_url: 'https://mcp.example.com/mcp',
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('value is required');
  });
});

describe('credential structural rules', () => {
  it('accepts a credential update that leaves identity fields alone', () => {
    const result = checkCredentialUpdate({ token: 'new-token' }, { mcpServerUrl: 'https://mcp.example.com/mcp' });
    expect(result.ok).toBe(true);
  });

  it('reports every locked field an update tried to change', () => {
    const result = checkCredentialUpdate(
      { mcp_server_url: 'https://other.example.com/mcp', secret_name: 'OTHER_KEY', client_id: 'c2' },
      { mcpServerUrl: 'https://mcp.example.com/mcp', secretName: 'MY_KEY' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.locked).toEqual(expect.arrayContaining(['mcp_server_url', 'secret_name', 'client_id']));
    expect(result.message).toContain('archive the credential');
  });

  it('does not treat an unchanged structural field as locked', () => {
    const result = checkCredentialUpdate(
      { mcp_server_url: 'https://mcp.example.com/mcp' },
      { mcpServerUrl: 'https://mcp.example.com/mcp' },
    );
    expect(result.ok).toBe(true);
  });

  it('matches MCP server URLs after normalizing case, port, and trailing slash', () => {
    expect(mcpServerUrlMatches('https://MCP.Example.com:443/mcp/', 'https://mcp.example.com/mcp')).toBe(true);
    expect(mcpServerUrlMatches('http://mcp.example.com:80/mcp', 'http://mcp.example.com/mcp')).toBe(true);
  });

  it('treats a different path, subdomain, or non-default port as a mismatch', () => {
    expect(mcpServerUrlMatches('https://mcp.example.com/other', 'https://mcp.example.com/mcp')).toBe(false);
    expect(mcpServerUrlMatches('https://sub.mcp.example.com/mcp', 'https://mcp.example.com/mcp')).toBe(false);
    expect(mcpServerUrlMatches('https://mcp.example.com:8443/mcp', 'https://mcp.example.com/mcp')).toBe(false);
  });

  it('validates environment variable names', () => {
    expect(isValidEnvVarName('MY_API_KEY')).toBe(true);
    expect(isValidEnvVarName('_private')).toBe(true);
    expect(isValidEnvVarName('1STARTS_WITH_DIGIT')).toBe(false);
    expect(isValidEnvVarName('has-dash')).toBe(false);
    expect(isValidEnvVarName('')).toBe(false);
  });
});

describe('toCanonicalCredential', () => {
  it('projects an environment variable credential with its location and no secret', () => {
    const projected = toCanonicalCredential({
      id: 'vcrd_1',
      vaultId: 'vlt_1',
      displayName: 'Notion key',
      authType: 'environment_variable',
      secretName: 'NOTION_API_KEY',
      injectionLocation: { header: true, body: false },
      metadata: { owner: 'qa' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(projected.auth).toEqual({
      type: 'environment_variable',
      secret_name: 'NOTION_API_KEY',
      injection_location: { header: true, body: false },
    });
    // Write-only fields must be absent, not masked: a mask could be mistaken
    // for the secret itself.
    for (const field of WRITE_ONLY_CREDENTIAL_FIELDS) {
      expect(projected).not.toHaveProperty(field);
      expect(projected.auth).not.toHaveProperty(field);
    }
  });

  it('maps the local bearer auth_type onto the canonical static_bearer name', () => {
    const projected = toCanonicalCredential({
      id: 'vcrd_2',
      vaultId: 'vlt_1',
      displayName: 'Linear key',
      authType: 'bearer_token',
      mcpServerUrl: 'https://mcp.linear.app/mcp',
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(projected.auth).toEqual({ type: 'static_bearer', mcp_server_url: 'https://mcp.linear.app/mcp' });
  });

  it('declares exactly the locked structural fields the contract lists', () => {
    expect([...LOCKED_CREDENTIAL_FIELDS]).toEqual([
      'mcp_server_url',
      'secret_name',
      'token_endpoint',
      'client_id',
    ]);
  });
});
