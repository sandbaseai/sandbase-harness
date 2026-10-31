/**
 * Integration test: MCP client integration (Requirement 5).
 *
 * Verifies:
 * - stdio MCP server tools are discovered and namespaced
 * - degraded mode: a server that fails to connect is skipped, not fatal (R5.5)
 * - empty config → empty tool set
 * - close() tears down connections
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { McpManager, reconnectDelay } from '@/core/mcp/mcp-manager.js';
import { Database } from '@/core/db/database.js';
import { encryptSecret } from '@/core/security/secrets.js';
import { resolveSessionCredentialInjections } from '@/core/credentials/injection.js';
import { ToolResolver, type ToolResolverDeps } from '@/core/session/tool-resolver.js';
import { refreshMcpOauthCredentialsForServer } from '@/core/credentials/oauth-refresh.js';
import { serializeOAuthState } from '@/core/credentials/canonical-credential.js';
import type { McpServerConfig, AgentDefinition } from '@/types/agent.js';
import type { Session } from '@/types/session.js';
import type { SandboxInstance } from '@/types/sandbox.js';

const MOCK_SERVER = join(import.meta.dirname, '../fixtures/mock-mcp-server.mjs');
const ENV_SERVER = join(import.meta.dirname, '../fixtures/env-mcp-server.mjs');
const CREDENTIAL_SERVER = join(import.meta.dirname, '../fixtures/credential-mcp-server.mjs');

describe('MCP integration', () => {
  let manager: McpManager;

  afterEach(async () => {
    if (manager) await manager.close();
  });

  it('returns empty tools for empty server list', async () => {
    manager = new McpManager();
    const tools = await manager.connectAll([]);
    expect(Object.keys(tools)).toHaveLength(0);
  });

  it('discovers and namespaces tools from a stdio MCP server', async () => {
    manager = new McpManager();
    const servers: McpServerConfig[] = [
      { name: 'mock', type: 'stdio', command: 'node', args: [MOCK_SERVER] },
    ];
    const tools = await manager.connectAll(servers);

    // Tool should be namespaced mcp_<server>_<tool>
    expect(tools['mcp_mock_echo']).toBeDefined();

    const statuses = manager.getStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].connected).toBe(true);
    expect(statuses[0].toolCount).toBe(1);
  });

  it('degrades gracefully when a server fails to connect (R5.5)', async () => {
    manager = new McpManager();
    const servers: McpServerConfig[] = [
      { name: 'broken', type: 'stdio', command: 'this-command-does-not-exist-xyz', args: [], timeout: 3 },
    ];
    // Must NOT throw
    const tools = await manager.connectAll(servers);
    expect(Object.keys(tools)).toHaveLength(0);

    const statuses = manager.getStatuses();
    expect(statuses[0].connected).toBe(false);
    expect(statuses[0].error).toBeTruthy();
  });

  it('keeps working servers when one fails (partial degradation)', async () => {
    manager = new McpManager();
    const servers: McpServerConfig[] = [
      { name: 'broken', type: 'stdio', command: 'nonexistent-xyz', args: [], timeout: 3 },
      { name: 'mock', type: 'stdio', command: 'node', args: [MOCK_SERVER] },
    ];
    const tools = await manager.connectAll(servers);

    // The good server's tool is present despite the broken one
    expect(tools['mcp_mock_echo']).toBeDefined();

    const statuses = manager.getStatuses();
    expect(statuses.find((s) => s.name === 'broken')!.connected).toBe(false);
    expect(statuses.find((s) => s.name === 'mock')!.connected).toBe(true);
  });

  it('rejects stdio config missing command / http config missing url', async () => {
    manager = new McpManager();
    const tools = await manager.connectAll([
      { name: 'bad-stdio', type: 'stdio' } as McpServerConfig,
      { name: 'bad-http', type: 'url' } as McpServerConfig,
    ]);
    expect(Object.keys(tools)).toHaveLength(0);
    const statuses = manager.getStatuses();
    expect(statuses.every((s) => !s.connected)).toBe(true);
  });

  describe('reconnect backoff (R5.6)', () => {
    it('uses exponential backoff capped at 60s', () => {
      expect(reconnectDelay(0)).toBe(1000);
      expect(reconnectDelay(1)).toBe(2000);
      expect(reconnectDelay(2)).toBe(4000);
      expect(reconnectDelay(3)).toBe(8000);
      expect(reconnectDelay(4)).toBe(16000);
      expect(reconnectDelay(10)).toBe(60000); // capped
    });

    it('reconnects a known server and re-registers its tools', async () => {
      manager = new McpManager();
      // First connect the mock server
      await manager.connectAll([
        { name: 'mock', type: 'stdio', command: 'node', args: [MOCK_SERVER] },
      ]);

      // Simulate a reconnect (no real drop; verifies the reconnect path works)
      const delays: number[] = [];
      const tools = await manager.reconnect('mock', async (ms) => { delays.push(ms); });
      expect(tools).not.toBeNull();
      expect(tools!['mcp_mock_echo']).toBeDefined();
    });

    it('returns null for an unknown server', async () => {
      manager = new McpManager();
      const tools = await manager.reconnect('nonexistent', async () => {});
      expect(tools).toBeNull();
    });

    it('auto-reconnects and retries a tool call when the connection drops (L5)', async () => {
      manager = new McpManager();
      manager.setSleepFn(async () => {}); // no real backoff sleeps in test
      const tools = await manager.connectAll([
        { name: 'mock', type: 'stdio', command: 'node', args: [MOCK_SERVER] },
      ]);

      const echo = tools['mcp_mock_echo'] as { execute: (a: any) => Promise<any> };
      expect(echo).toBeDefined();

      // Monkey-patch the live tool to throw a connection error on first call,
      // then succeed — the wrapper should reconnect and retry transparently.
      const live = (manager as any).liveTools.get('mock');
      const original = live.echo.execute;
      let calls = 0;
      live.echo.execute = async (args: any) => {
        calls++;
        if (calls === 1) throw new Error('socket closed');
        return original(args);
      };

      const result = await echo.execute({ text: 'hi' });
      // After reconnect, the fresh tool executes normally
      expect(JSON.stringify(result)).toContain('echo: hi');
    });

    it('retries with backoff then gives up on a permanently-broken server', async () => {
      manager = new McpManager();
      await manager.connectAll([
        { name: 'broken', type: 'stdio', command: 'nonexistent-xyz', args: [], timeout: 1 },
      ]);
      const delays: number[] = [];
      const tools = await manager.reconnect('broken', async (ms) => { delays.push(ms); });
      expect(tools).toBeNull();
      // 5 attempts → 4 backoff sleeps between them: 1s,2s,4s,8s
      expect(delays).toEqual([1000, 2000, 4000, 8000]);
      const status = manager.getStatuses().find((s) => s.name === 'broken');
      expect(status!.connected).toBe(false);
    }, 15_000);
  });

  /**
   * The transport half of the credential contract: a session's Vault material
   * reaches the MCP server it declares, and the value does not reach the model.
   *
   * `contracts/anthropic-cma/credentials.md` §6 cites this file for the
   * behaviour. A stdio server can only read it from its own process
   * environment, so the assertion comes from a real subprocess reporting what it
   * was started with rather than from a stub that would prove nothing.
   */
  describe('vault credential transport', () => {
    const SECRET = 'mcp-vault-demo-secret';
    const AGENT_VALUE = 'agent-configured-value';
    const resolvers: ToolResolver[] = [];
    let db: Database | undefined;
    let tmpDir: string | undefined;
    let session: Session;

    afterEach(async () => {
      for (const resolver of resolvers.splice(0)) await resolver.cleanupSession(session.id);
      db?.close();
      db = undefined;
      if (tmpDir) {
        rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = undefined;
      }
    });

    /** A running session that attaches a vault holding one environment credential. */
    function setupVault(network: Record<string, unknown>): void {
      tmpDir = mkdtempSync(join(tmpdir(), 'ma-mcp-vault-'));
      db = new Database(join(tmpDir, 'test.db'));
      db.runMigrations();
      db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_mcp', 'local', '{}')`);
      db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_mcp', 'mcp-agent', '{}')`);
      db.exec(`INSERT INTO credential_vaults (id, name) VALUES ('vlt_mcp', 'MCP vault')`);
      db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, vault_ids) VALUES ('sess_mcp_vault', 'agent_mcp', 'mcp-agent', 'env_mcp', 'running', '["vlt_mcp"]')`);
      const encrypted = encryptSecret(SECRET, tmpDir);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO credential_records (
          id, vault_id, name, auth_type, variable_name, value_hint, network,
          injection_locations, secret_ciphertext, secret_nonce, secret_tag, status, metadata, created_at, updated_at
        ) VALUES ('crd_mcp', 'vlt_mcp', 'MCP token', 'environment_variable', 'TOKEN', '••••cret', ?, '[]', ?, ?, ?, 'active', '{}', ?, ?)`,
      ).run(JSON.stringify(network), encrypted.ciphertext, encrypted.nonce, encrypted.tag, now, now);
      session = {
        id: 'sess_mcp_vault',
        agentId: 'agent_mcp',
        agentName: 'mcp-agent',
        environmentId: 'env_mcp',
        status: 'running',
        vaultIds: ['vlt_mcp'],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as Session;
    }

    /** Resolve the tool map, and the resolver that can reconnect it after a rotation. */
    async function resolveTools(opts: { withEgressBoundary?: boolean } = {}): Promise<{
      tools: Record<string, any>;
      resolver: ToolResolver;
      registered: Array<{ placeholder: string; value: string }>;
    }> {
      const agent = {
        name: 'mcp-agent',
        model: 'gpt-4o-mini',
        system: 'use the vault',
        mcp_servers: [{
          name: 'credential',
          type: 'stdio',
          command: 'node',
          args: [CREDENTIAL_SERVER],
          // A value the agent configures itself: the Vault credential is the
          // operator's, so it has to win rather than merge.
          env: { TOKEN: AGENT_VALUE },
        }],
        tools: [{
          type: 'mcp_toolset',
          mcp_server_name: 'credential',
          default_config: { permission_policy: { type: 'always_allow' } },
        }],
      } as unknown as AgentDefinition;
      const resolver = new ToolResolver({
        delegationService: { buildDelegationTools: () => ({}) } as never,
        resolveCredentialInjections: (sessionId, target) => resolveSessionCredentialInjections(db!, sessionId, {
          dataDir: tmpDir,
          ...target,
        }),
      });
      resolvers.push(resolver);
      const registered: Array<{ placeholder: string; value: string }> = [];
      const sandbox = {
        // A stdio server's credential environment needs somewhere to substitute
        // placeholders, so a case that exercises injection gives the stub an
        // egress boundary; the boundary-less shape is the one under test above.
        ...(opts.withEgressBoundary
          ? { configureEgressSubstitutions(s: ReadonlyArray<{ placeholder: string; value: string }>) {
              registered.push(...s.map((entry) => ({ ...entry })));
            } }
          : {}),
        async writeFile() {},
        async readFile() { return ''; },
        async listFiles() { return []; },
        async execute() { return { exitCode: 0, stdout: '', stderr: '' }; },
        async destroy() {},
      } as unknown as SandboxInstance;
      return await (resolver.resolveTools(session, agent, sandbox) as Promise<Record<string, any>>)
        .then((tools) => ({ tools, resolver, registered }));
    }

    it('refuses the vault environment on a boundary-less sandbox and keeps the value out of the result', async () => {
      setupVault({ type: 'unrestricted', allowed_hosts: [] });
      const { tools } = await resolveTools();

      const result = await tools['mcp_credential_echo_env'].execute({});

      // A stdio server on a backend with no egress boundary cannot substitute
      // placeholders, so the credential is refused outright rather than handed
      // to the process in plaintext — the server runs on the agent's own value.
      expect(JSON.stringify(result)).toContain(`TOKEN=${AGENT_VALUE}`);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      const denied = db!.prepare(
        "SELECT action, metadata FROM credential_audit_events WHERE credential_id = 'crd_mcp'",
      ).all() as Array<{ action: string; metadata: string }>;
      expect(denied.length).toBeGreaterThan(0);
      expect(denied.every((row) => row.action === 'runtime_denied')).toBe(true);
      expect(JSON.parse(denied[0].metadata).reason).toBe('backend_unsupported');
    });

    it('leaves a credential the network policy denies out of the server environment', async () => {
      setupVault({ type: 'limited', allowed_hosts: ['api.example.com'] });
      const { tools } = await resolveTools();

      const result = await tools['mcp_credential_echo_env'].execute();

      // On this boundary-less sandbox the refusal lands upstream of the host
      // question — the backend cannot honor an environment credential at all.
      expect(JSON.stringify(result)).toContain(`TOKEN=${AGENT_VALUE}`);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      const actions = db!.prepare('SELECT action FROM credential_audit_events').all() as { action: string }[];
      expect(actions.map((row) => row.action)).toContain('runtime_denied');
    });

    it('reconnects the live transport so a rotated value replaces the secret the boundary substitutes', async () => {
      setupVault({ type: 'unrestricted', allowed_hosts: [] });
      // This case exercises credential injection, so the stub sandbox owns an
      // egress boundary and the credential arrives as a placeholder token.
      const { tools, resolver, registered } = await resolveTools({ withEgressBoundary: true });
      const echo = tools['mcp_credential_echo_env'] as { execute: () => Promise<unknown> };
      // The subprocess holds the opaque token, never the secret…
      expect(JSON.stringify(await echo.execute())).toContain('TOKEN=[REDACTED]');
      expect(registered.at(-1)?.value).toBe(SECRET);
      // …and the strategy never sees either — the placeholder reads as redacted.
      expect(JSON.stringify(await echo.execute())).not.toContain(SECRET);

      // Rotate the stored secret the way the rotate route does, then ask the session
      // to rebuild its transports.
      const rotated = 'rotated-mcp-vault-secret';
      const encrypted = encryptSecret(rotated, tmpDir);
      db!.prepare(
        `UPDATE credential_records
         SET secret_ciphertext = ?, secret_nonce = ?, secret_tag = ?, value_hint = ?, updated_at = ?
         WHERE id = 'crd_mcp'`,
      ).run(encrypted.ciphertext, encrypted.nonce, encrypted.tag, '••••cret', new Date().toISOString());

      // Before the reconnect the boundary still substitutes the value it was
      // registered with; a re-resolution is what moves the placeholder to the
      // rotated secret. That is the gap this closes.
      expect(registered.at(-1)?.value).toBe(SECRET);

      await resolver.refreshSessionMcpCredentials(session.id);

      // The reconnect re-resolves and re-registers: the placeholder the process
      // echoes is unchanged, but the boundary now materializes the rotated value.
      expect(registered.at(-1)).toMatchObject({ placeholder: '__cred_crd_mcp__', value: rotated });
      const fresh = JSON.stringify(await echo.execute());
      expect(fresh).not.toContain(SECRET);
      expect(fresh).not.toContain(rotated);
    });
  });

  /**
   * The network half of the credential contract: a credential keyed by
   * `mcp_server_url` authenticates the endpoint it names and no other.
   *
   * Such a credential rides request headers, so the case needs a server on the
   * other end of a socket to report what arrived; the fixture is started
   * in-process so its port is known before the server is declared and it is torn
   * down with the case. `contracts/anthropic-cma/credentials.md` §3 lists the URL
   * keying as aligned while the connection side had no caller at all.
   */
  describe('url credential scoping', () => {
    const SECRET = 'sse-vault-demo-secret';
    const resolvers: ToolResolver[] = [];
    let db: Database | undefined;
    let tmpDir: string | undefined;
    let session: Session | undefined;
    let sseServer: { url: string; close: () => Promise<void> } | undefined;

    afterEach(async () => {
      if (session) {
        for (const resolver of resolvers.splice(0)) await resolver.cleanupSession(session.id);
      }
      db?.close();
      db = undefined;
      if (tmpDir) {
        rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = undefined;
      }
      if (sseServer) {
        await sseServer.close();
        sseServer = undefined;
      }
      session = undefined;
    });

    /**
     * A session whose vault holds one MCP credential keyed to `credentialUrl`.
     *
     * The row is written the way the published routes write one: the canonical
     * `static_bearer` / `mcp_oauth` shapes record the URL and no injection
     * locations, so the assertion exercises the shape an operator actually creates
     * rather than a hand-tuned token list.
     */
    function setupVault(credentialUrl: string, authType: 'bearer_token' | 'mcp_oauth' = 'bearer_token'): void {
      tmpDir = mkdtempSync(join(tmpdir(), 'ma-mcp-url-'));
      db = new Database(join(tmpDir, 'test.db'));
      db.runMigrations();
      db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_url', 'local', '{}')`);
      db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_url', 'mcp-agent', '{}')`);
      db.exec(`INSERT INTO credential_vaults (id, name) VALUES ('vlt_url', 'MCP url vault')`);
      db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, vault_ids) VALUES ('sess_url', 'agent_url', 'mcp-agent', 'env_url', 'running', '["vlt_url"]')`);
      const encrypted = encryptSecret(SECRET, tmpDir);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO credential_records (
          id, vault_id, name, auth_type, mcp_server_url, variable_name, value_hint, network,
          injection_locations, secret_ciphertext, secret_nonce, secret_tag, status, metadata, created_at, updated_at
        ) VALUES ('crd_url', 'vlt_url', 'MCP bearer', ?, ?, null, '••••cret', ?, '[]', ?, ?, ?, 'active', '{}', ?, ?)`,
      ).run(
        authType,
        credentialUrl,
        JSON.stringify({ type: 'unrestricted', allowed_hosts: [] }),
        encrypted.ciphertext, encrypted.nonce, encrypted.tag, now, now,
      );
      session = {
        id: 'sess_url',
        agentId: 'agent_url',
        agentName: 'mcp-agent',
        environmentId: 'env_url',
        status: 'running',
        vaultIds: ['vlt_url'],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as Session;
    }

    /** Resolve the tool map a turn would use for one declared MCP server. */
    async function toolsFor(
      mcpServer: Record<string, unknown>,
      deps?: { refreshOAuthCredentials?: ToolResolverDeps['refreshOAuthCredentials'] },
    ): Promise<Record<string, any>> {
      const agent = {
        name: 'mcp-agent',
        model: 'gpt-4o-mini',
        system: 'use the vault',
        mcp_servers: [mcpServer],
        tools: [{
          type: 'mcp_toolset',
          mcp_server_name: mcpServer.name,
          default_config: { permission_policy: { type: 'always_allow' } },
        }],
      } as unknown as AgentDefinition;
      const resolver = new ToolResolver({
        delegationService: { buildDelegationTools: () => ({}) } as never,
        resolveCredentialInjections: (sessionId, target) => resolveSessionCredentialInjections(db!, sessionId, {
          dataDir: tmpDir,
          ...target,
        }),
        refreshOAuthCredentials: deps?.refreshOAuthCredentials,
      });
      resolvers.push(resolver);
      const sandbox = {
        async writeFile() {},
        async readFile() { return ''; },
        async listFiles() { return []; },
        async execute() { return { exitCode: 0, stdout: '', stderr: '' }; },
        async destroy() {},
      } as unknown as SandboxInstance;
      return await resolver.resolveTools(session!, agent, sandbox) as Record<string, any>;
    }

    /** Start the in-process SSE server the URL cases connect to. */
    async function startSseServer(): Promise<string> {
      const module = await import(
        pathToFileURL(join(import.meta.dirname, '../fixtures/sse-credential-mcp-server.mjs')).href
      ) as { startSseCredentialMcpServer: () => Promise<{ url: string; close: () => Promise<void> }> };
      sseServer = await module.startSseCredentialMcpServer();
      return sseServer.url;
    }

    it('sends a credential keyed by the declared server url as a request header', async () => {
      const url = await startSseServer();
      setupVault(url);

      const tools = await toolsFor({ name: 'scoped', type: 'url', url });
      const result = await tools['mcp_scoped_report_auth'].execute({});

      // The server reports the header it received on the wire…
      expect(JSON.stringify(result)).toContain('AUTHORIZATION=Bearer [REDACTED]');
      // …and the secret itself never reaches the strategy.
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it('attaches a stored mcp_oauth access token to the server it names', async () => {
      const url = await startSseServer();
      setupVault(url, 'mcp_oauth');

      const tools = await toolsFor({ name: 'scoped', type: 'url', url });
      const result = await tools['mcp_scoped_report_auth'].execute({});

      // The access token of an `mcp_oauth` credential is presented the same way a
      // `static_bearer` token is: this runtime holds no refresh loop, but it does
      // hold the token, and a stored credential that is never presented is not an
      // authentication path at all.
      expect(JSON.stringify(result)).toContain('AUTHORIZATION=Bearer [REDACTED]');
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it('refreshes an expired mcp_oauth token before the connect sends it', async () => {
      const url = await startSseServer();
      setupVault(url, 'mcp_oauth');
      // Expired access token plus a stored refresh token: the connect boundary
      // must refresh through the token endpoint before resolving the header.
      const refresh = encryptSecret('rt-vendor', tmpDir);
      db!.prepare(
        `UPDATE credential_records
         SET oauth_state = ?, refresh_token_ciphertext = ?, refresh_token_nonce = ?, refresh_token_tag = ?
         WHERE id = 'crd_url'`,
      ).run(
        serializeOAuthState({
          tokenEndpoint: 'https://auth.vendor.example/token',
          expiresAt: '2020-01-01T00:00:00.000Z',
          hasRefreshToken: true,
        }),
        refresh.ciphertext, refresh.nonce, refresh.tag,
      );

      const tokenCalls: string[] = [];
      const tools = await toolsFor({ name: 'scoped', type: 'url', url }, {
        refreshOAuthCredentials: (sessionId, mcpServerUrl, vaultIds) =>
          refreshMcpOauthCredentialsForServer(db!, {
            sessionId,
            mcpServerUrl,
            vaultIds,
            dataDir: tmpDir,
            fetchImpl: (async (input: any) => {
              tokenCalls.push(String(input));
              return new Response(JSON.stringify({ access_token: 'at-refreshed', expires_in: 3600 }));
            }) as typeof fetch,
          }),
      });

      const result = await tools['mcp_scoped_report_auth'].execute({});
      // The transport presented the refreshed value, and nothing in the result
      // carries it back to the strategy.
      expect(tokenCalls).toEqual(['https://auth.vendor.example/token']);
      expect(JSON.stringify(result)).toContain('AUTHORIZATION=Bearer [REDACTED]');
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(JSON.stringify(result)).not.toContain('at-refreshed');
      const stored = db!.prepare('SELECT oauth_state FROM credential_records WHERE id = ?').get('crd_url') as { oauth_state: string };
      expect(JSON.parse(stored.oauth_state).last_refresh_status).toBe('ok');
    });

    it('does not send it to a server the credential does not name', async () => {
      const url = await startSseServer();
      // The same host and port with a different path: the published rule treats a
      // different path as a genuine mismatch rather than something to normalize.
      setupVault(url.replace(/\/sse$/, '/other'));

      const tools = await toolsFor({ name: 'scoped', type: 'url', url });
      const result = await tools['mcp_scoped_report_auth'].execute({});

      expect(JSON.stringify(result)).toContain('AUTHORIZATION=none');
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it('leaves a url-keyed credential out of a caller that names no server', async () => {
      setupVault('http://127.0.0.1:9/sse');

      // A stdio server is declared without a URL, so the credential cannot apply.
      // Its tool also sees no environment, because a bearer token is not an
      // environment variable however it is stored.
      const tools = await toolsFor({
        name: 'credential',
        type: 'stdio',
        command: 'node',
        args: [CREDENTIAL_SERVER],
      });
      const result = await tools['mcp_credential_echo_env'].execute({});
      expect(JSON.stringify(result)).toContain('TOKEN=missing');

      // The boundary agrees, and an inapplicable credential is not a refusal, so
      // no denial is recorded for it either.
      const bundle = resolveSessionCredentialInjections(db!, session!.id);
      expect(bundle.request_headers).toEqual({});
      expect(bundle.denied).toHaveLength(0);
      const actions = db!.prepare('SELECT action FROM credential_audit_events').all() as { action: string }[];
      expect(actions.map((row) => row.action)).not.toContain('runtime_denied');
      expect(actions.map((row) => row.action)).not.toContain('runtime_inject');
    });
  });

  /**
   * The Environment network policy at the MCP boundary: `url` servers name an
   * endpoint the allowlist can check, `stdio` servers are runtime-spawned
   * processes that inherit the sandbox's proxy environment instead.
   */
  describe('environment network policy', () => {
    const resolvers: ToolResolver[] = [];
    let session: Session | undefined;

    const EGRESS_ENV = { HTTP_PROXY: 'http://sandbase:tok@127.0.0.1:19999', NO_PROXY: 'localhost' };

    afterEach(async () => {
      if (session) {
        for (const resolver of resolvers.splice(0)) await resolver.cleanupSession(session.id);
      }
      session = undefined;
    });

    function sessionOnEnvironment(config: Record<string, unknown>): Session {
      session = {
        id: 'sess_envpol',
        agentId: 'agent_envpol',
        agentName: 'mcp-agent',
        environmentId: 'env_envpol',
        status: 'running',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as Session;
      return session;
    }

    function resolverFor(network: Record<string, unknown> | undefined): ToolResolver {
      const resolver = new ToolResolver({
        delegationService: { buildDelegationTools: () => ({}) } as never,
        // The same shape composition.resolveEnvironmentConfig returns: the raw
        // stored config, both spellings readable by the policy normalizer.
        resolveEnvironmentConfig: () => ({
          name: 'local',
          sandbox_provider: 'local',
          ...(network ? { network } : {}),
        }) as never,
      });
      resolvers.push(resolver);
      return resolver;
    }

    const sandboxWithEgress = {
      egressEnvironment: EGRESS_ENV,
      async writeFile() {},
      async readFile() { return ''; },
      async listFiles() { return []; },
      async execute() { return { exitCode: 0, stdout: '', stderr: '' }; },
      async destroy() {},
    } as unknown as SandboxInstance;

    function agentWith(mcpServer: Record<string, unknown>): AgentDefinition {
      return {
        name: 'mcp-agent',
        model: 'gpt-4o-mini',
        system: 'test',
        mcp_servers: [mcpServer],
        tools: [{
          type: 'mcp_toolset',
          mcp_server_name: mcpServer.name,
          default_config: { permission_policy: { type: 'always_allow' } },
        }],
      } as unknown as AgentDefinition;
    }

    it('refuses a url server whose host the environment allowlist does not cover', async () => {
      const resolver = resolverFor({ type: 'limited', allowed_hosts: ['mcp.github.com'] });
      const tools = await resolver.resolveTools(
        sessionOnEnvironment({}),
        agentWith({ name: 'blocked', type: 'url', url: 'https://mcp.evil.com/sse' }),
        sandboxWithEgress,
      ) as Record<string, unknown>;

      // No tool ships for a refused server, and the refusal is recorded as a
      // policy decision on its status rather than an opaque connect error.
      expect(Object.keys(tools).some((name) => name.startsWith('mcp_blocked_'))).toBe(false);
      const status = resolver.getMcpStatus(session!.id).find((s) => s.name === 'blocked');
      expect(status?.connected).toBe(false);
      expect(status?.error).toContain('mcp.evil.com');
    });

    it('connects a url server the environment allowlist covers', async () => {
      const module = await import(
        pathToFileURL(join(import.meta.dirname, '../fixtures/sse-credential-mcp-server.mjs')).href
      ) as { startSseCredentialMcpServer: () => Promise<{ url: string; close: () => Promise<void> }> };
      const sse = await module.startSseCredentialMcpServer();
      try {
        const resolver = resolverFor({ type: 'limited', allowed_hosts: ['127.0.0.1'] });
        const tools = await resolver.resolveTools(
          sessionOnEnvironment({}),
          agentWith({ name: 'scoped', type: 'url', url: sse.url }),
          sandboxWithEgress,
        ) as Record<string, any>;
        expect(tools['mcp_scoped_report_auth']).toBeDefined();
      } finally {
        await sse.close();
      }
    });

    it('starts a stdio server with the sandbox egress environment', async () => {
      const resolver = resolverFor({ type: 'limited', allowed_hosts: ['api.github.com'] });
      const tools = await resolver.resolveTools(
        sessionOnEnvironment({}),
        agentWith({ name: 'env', type: 'stdio', command: 'node', args: [ENV_SERVER] }),
        sandboxWithEgress,
      ) as Record<string, any>;

      const result = await tools['mcp_env_report_env'].execute({});
      expect(JSON.stringify(result)).toContain(`HTTP_PROXY=${EGRESS_ENV.HTTP_PROXY}`);
    });

    it('starts a stdio server with no egress environment when the sandbox has none', async () => {
      const resolver = resolverFor(undefined);
      const bare = {
        async writeFile() {},
        async readFile() { return ''; },
        async listFiles() { return []; },
        async execute() { return { exitCode: 0, stdout: '', stderr: '' }; },
        async destroy() {},
      } as unknown as SandboxInstance;
      const tools = await resolver.resolveTools(
        sessionOnEnvironment({}),
        agentWith({ name: 'env', type: 'stdio', command: 'node', args: [ENV_SERVER] }),
        bare,
      ) as Record<string, any>;

      const result = await tools['mcp_env_report_env'].execute({});
      expect(JSON.stringify(result)).toContain('HTTP_PROXY=missing');
    });
  });
});
