import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { McpManager } from '@/core/mcp/mcp-manager.js';
import { encryptSecret } from '@/core/security/secrets.js';
import { validateMcpCredential, type ValidatableCredentialRow } from '@/core/credentials/mcp-oauth-validate.js';

const TOKEN = 'test-mcp-redirect-token';
type RequestRecord = { method: string; path: string; authorization: string | undefined };
type Redirects = { stream?: string; messages?: string };

// Two real listeners make a cross-origin redirect observable: an upgrade must
// refuse it before contacting the other port, not just strip one header there.
async function startEndpoint(redirects: Redirects = {}) {
  const requests: RequestRecord[] = [];
  const streams = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    requests.push({ method: req.method ?? '', path, authorization: req.headers.authorization });
    const redirect = path === '/sse' ? redirects.stream : path === '/messages' ? redirects.messages : undefined;
    if (redirect) {
      res.writeHead(307, { location: redirect }).end();
      return;
    }
    if (req.method === 'GET' && path.endsWith('/sse')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('event: endpoint\ndata: /messages\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (req.method === 'POST' && path.endsWith('/messages')) {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        res.writeHead(202).end();
        const message = JSON.parse(body) as { id?: number; method?: string };
        if (message.id === undefined) return;
        const result = message.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'redirect-fixture', version: '1' } }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }] }
            : { content: [{ type: 'text', text: 'pong' }] };
        for (const stream of streams) {
          stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
        }
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    url: `${origin}/sse`,
    requests,
    async close() {
      for (const stream of streams) stream.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

describe('MCP redirect policy', () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
    cleanup.length = 0;
  });

  async function endpoint(redirects?: Redirects) {
    const fixture = await startEndpoint(redirects);
    cleanup.push(() => fixture.close());
    return fixture;
  }

  async function connect(url: string) {
    const manager = new McpManager({
      resolveHeaders: () => ({ Authorization: `Bearer ${TOKEN}` }),
    });
    cleanup.push(() => manager.close());
    const tools = await manager.connectAll([{ name: 'redirect', type: 'url', url, timeout: 2 }]);
    return { manager, tools };
  }

  async function probe(url: string) {
    const dataDir = mkdtempSync(join(tmpdir(), 'ma-mcp-redirect-'));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const db = new Database(join(dataDir, 'test.db'));
    cleanup.push(() => db.close());
    db.runMigrations();
    db.exec("INSERT INTO credential_vaults (id, name) VALUES ('vlt_redirect', 'redirect')");
    const secret = encryptSecret(TOKEN, dataDir);
    db.prepare(`INSERT INTO credential_records (
      id, vault_id, name, auth_type, mcp_server_url, network, injection_locations,
      secret_ciphertext, secret_nonce, secret_tag, status, metadata, created_at, updated_at
    ) VALUES ('vcrd_redirect', 'vlt_redirect', 'redirect', 'mcp_oauth', ?, ?, '[]', ?, ?, ?, 'active', '{}', ?, ?)`)
      .run(url, JSON.stringify({ type: 'unrestricted', allowed_hosts: [] }),
        secret.ciphertext, secret.nonce, secret.tag, new Date().toISOString(), new Date().toISOString());
    const row = db.prepare("SELECT * FROM credential_records WHERE id = 'vcrd_redirect'").get() as ValidatableCredentialRow;
    return validateMcpCredential(db, row, { dataDir, timeoutMs: 2_000 });
  }

  it('keeps credentials on same-origin SSE and method-preserving message redirects', async () => {
    const server = await endpoint({ stream: '/ready/sse', messages: '/ready/messages' });
    const { manager, tools } = await connect(server.url);
    expect(manager.getStatuses()[0]?.connected).toBe(true);
    const ping = tools.mcp_redirect_ping as { execute: (args: unknown) => Promise<unknown> };
    expect(await ping.execute({})).toEqual({ content: [{ type: 'text', text: 'pong' }] });
    expect(server.requests).toEqual(expect.arrayContaining([
      { method: 'GET', path: '/ready/sse', authorization: `Bearer ${TOKEN}` },
      { method: 'POST', path: '/ready/messages', authorization: `Bearer ${TOKEN}` },
    ]));
    expect(server.requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('validates a credential through same-origin SSE and message redirects', async () => {
    const server = await endpoint({ stream: '/ready/sse', messages: '/ready/messages' });
    expect(await probe(server.url)).toMatchObject({ ok: true, result: { status: 'valid', mcp_probe: null } });
    expect(server.requests).toEqual(expect.arrayContaining([
      { method: 'GET', path: '/ready/sse', authorization: `Bearer ${TOKEN}` },
      { method: 'POST', path: '/ready/messages', authorization: `Bearer ${TOKEN}` },
    ]));
  });

  it.each(['stream', 'messages'] as const)('refuses a cross-origin %s redirect before sending a session credential there', async (leg) => {
    const target = await endpoint();
    const server = await endpoint({ [leg]: `${target.origin}/${leg === 'stream' ? 'sse' : 'messages'}` });
    const { manager, tools } = await connect(server.url);
    expect(tools).toEqual({});
    expect(manager.getStatuses()[0]?.connected).toBe(false);
    expect(server.requests.some((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(target.requests).toEqual([]);
  });

  it.each(['stream', 'messages'] as const)('reports an unknown probe for a cross-origin %s redirect without sending its credential there', async (leg) => {
    const target = await endpoint();
    const server = await endpoint({ [leg]: `${target.origin}/${leg === 'stream' ? 'sse' : 'messages'}` });
    expect(await probe(server.url)).toMatchObject({
      ok: true,
      result: { status: 'unknown', mcp_probe: { method: 'initialize', http_response: { status_code: 307 } }, refresh: null },
    });
    expect(target.requests).toEqual([]);
  });
});
