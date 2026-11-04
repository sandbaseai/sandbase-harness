import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '@/api/server.js';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { getOrSeedRuntimeSettings, saveRuntimeSettings, type RuntimeSettings } from '@/core/settings/store.js';
import { MODEL_CONNECTION_TIMEOUT_MS, testModelConnection, type ModelConnectionResult } from '@/core/settings/model-connection.js';

describe('explicit live model connection test', () => {
  let dir: string;
  let db: Database;
  let baseUrl: string;
  let server: ReturnType<typeof createHttpServer>;
  let requests: Array<{ path: string; body: Record<string, unknown>; headers: IncomingMessage['headers'] }>;
  let respond: (res: ServerResponse) => void;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ma-model-connection-'));
    db = new Database(join(dir, 'data.db'));
    db.runMigrations();
    requests = [];
    respond = (res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }));
    };
    server = createHttpServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({ path: req.url!, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      respond(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function saved(model: Partial<RuntimeSettings['model']> = {}) {
    const initial = getOrSeedRuntimeSettings(db, {}, dir);
    const save = saveRuntimeSettings(db, {
      ...initial.saved_config,
      model: { vendor: 'openai_compatible', api_key: 'connection-fixture-key', base_url: baseUrl, options: {}, ...model },
    }, initial.revision, dir);
    if (!save.ok) throw new Error('Fixture save conflicted');
    return save.record;
  }

  function app() {
    return createServer({
      db, sessionManager: new SessionManager(db), agents: [], reloadAgents: () => ({ agents: [], errors: [] }),
      apiKeys: ['runtime-fixture-key'],
      workspace: { root: dir, dataDir: dir, agentsDir: join(dir, 'agents'), skillsDir: join(dir, 'skills'), target: 'local' },
    });
  }

  function post(body: unknown, apiKey: string | undefined = 'runtime-fixture-key') {
    return app().request('/v1/x/settings/test-model', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
      body: JSON.stringify(body),
    });
  }

  it('uses saved encrypted credentials and the entered model without mutating settings or session state', async () => {
    const settings = saved();
    const secrets = db.prepare('SELECT * FROM runtime_settings_secrets').all();
    const res = await post({ model: 'router/example-model', revision: settings.revision });
    expect(res.status).toBe(200);
    const body = await res.json() as ModelConnectionResult;
    expect(body).toMatchObject({ ok: true, outcome: 'ok', model: 'router/example-model', resolved_model: 'router/example-model',
      provider: 'openai_compatible', revision: settings.revision, config_source: 'saved' });
    expect(body.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/v1/chat/completions');
    expect(requests[0].headers.authorization).toBe('Bearer connection-fixture-key');
    expect(requests[0].body).toMatchObject({ model: 'router/example-model', max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with OK.' }] });
    expect(requests[0].body).not.toHaveProperty('tools');
    expect(getOrSeedRuntimeSettings(db, {}, dir)).toEqual(settings);
    expect(settings.effective_revision).toBeLessThan(settings.revision);
    expect(db.prepare('SELECT * FROM runtime_settings_secrets').all()).toEqual(secrets);
    expect(settings.saved_config.model.api_key).toMatch(/^__managed_secret__:/);
    for (const table of ['sessions', 'events', 'agents']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(JSON.stringify(body)).not.toContain('connection-fixture-key');
    expect(JSON.stringify(body)).not.toContain(baseUrl);
    expect(body).not.toHaveProperty('text');
  });

  it.each(['openai', 'minimax'] as const)('reuses %s provider reference resolution', async (vendor) => {
    const settings = saved({ vendor });
    const res = await post({ model: `${vendor}/example-model`, revision: settings.revision });
    expect(await res.json()).toMatchObject({ ok: true, resolved_model: 'example-model', provider: vendor });
    expect(requests).toHaveLength(1);
    expect(requests[0].body.model).toBe('example-model');
  });

  it('uses Anthropic Messages with environment credentials and endpoint resolution', async () => {
    vi.stubEnv('MA_CONNECTION_TEST_KEY', 'anthropic-fixture-key');
    vi.stubEnv('MA_CONNECTION_TEST_URL', baseUrl);
    const settings = saved({ vendor: 'anthropic', api_key: '${MA_CONNECTION_TEST_KEY}', base_url: '${MA_CONNECTION_TEST_URL}' });
    respond = (res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-test',
        content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 } }));
    };
    expect(await (await post({ model: 'anthropic/claude-test', revision: settings.revision })).json())
      .toMatchObject({ ok: true, resolved_model: 'claude-test' });
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/v1/messages');
    expect(requests[0].headers['x-api-key']).toBe('anthropic-fixture-key');
    expect(requests[0].body).toMatchObject({ model: 'claude-test', max_tokens: 32 });
    expect(requests[0].body).not.toHaveProperty('tools');
  });

  it.each([
    [401, 'authentication_failed', 'invalid_api_key'], [403, 'authentication_failed', 'forbidden'],
    [404, 'model_not_found', 'model_not_found'], [400, 'model_not_found', 'model_not_found'],
    [404, 'not_found', 'not_found'], [429, 'rate_limited', 'rate_limit'],
    [500, 'provider_error', 'server_error'], [529, 'provider_error', 'overloaded'],
    [408, 'timeout', 'timeout'], [504, 'timeout', 'timeout'],
  ])('classifies HTTP %s as %s without retrying or exposing upstream content', async (status, code, errorCode) => {
    const settings = saved();
    respond = (res) => {
      res.writeHead(Number(status), { 'Content-Type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify({ error: { code: errorCode, type: 'provider_error', message: 'connection-fixture-key private-upstream-detail' } }));
    };
    const res = await post({ model: 'example-model', revision: settings.revision });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, outcome: code, http_status: status });
    expect(JSON.stringify(body)).not.toMatch(/connection-fixture-key|private-upstream-detail/);
    expect(requests).toHaveLength(1);
  });

  it('reports an Anthropic not_found_error without pretending the endpoint is known to be correct', async () => {
    const settings = saved({ vendor: 'anthropic' });
    respond = (res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model: private-model' } }));
    };
    expect(await (await post({ model: 'claude-missing', revision: settings.revision })).json())
      .toMatchObject({ ok: false, outcome: 'not_found', http_status: 404 });
  });

  it.each(['not-json', '{}', '{"choices":[]}', '{"choices":[{"index":0,"message":{"content":""}}]}'])
    ('does not treat unusable HTTP 200 output as a successful model execution', async (response) => {
      const settings = saved();
      respond = (res) => { res.setHeader('Content-Type', 'application/json'); res.end(response); };
      expect(await (await post({ model: 'example-model', revision: settings.revision })).json())
        .toMatchObject({ ok: false, outcome: 'invalid_response' });
      expect(requests).toHaveLength(1);
    });

  it('does not expose provider response bodies from a malformed response', async () => {
    const settings = saved();
    respond = (res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"private-upstream-detail":"never show this"}');
    };
    const warnings: string[] = [];
    const originalEmitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error) => { warnings.push(String(warning)); }) as typeof process.emitWarning;
    try {
      const result = await (await post({ model: 'example-model', revision: settings.revision })).json();
      expect(result).toMatchObject({ ok: false, outcome: 'invalid_response' });
      expect(JSON.stringify(result)).not.toContain('private-upstream-detail');
      expect(warnings.join('\n')).not.toContain('private-upstream-detail');
    } finally {
      process.emitWarning = originalEmitWarning;
    }
  });

  it('reports connection failures without retrying or exposing their address', async () => {
    const settings = saved();
    respond = (res) => res.destroy();
    expect(await (await post({ model: 'example-model', revision: settings.revision })).json())
      .toMatchObject({ ok: false, outcome: 'network_error' });
    expect(requests).toHaveLength(1);
  });

  it('aborts a hanging provider at the deadline and closes the request', async () => {
    const settings = saved();
    let started!: () => void;
    let closed!: () => void;
    const reachedProvider = new Promise<void>((resolve) => { started = resolve; });
    const disconnected = new Promise<void>((resolve) => { closed = resolve; });
    respond = (res) => { res.once('close', closed); started(); };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = post({ model: 'example-model', revision: settings.revision });
    await reachedProvider;
    await vi.advanceTimersByTimeAsync(MODEL_CONNECTION_TIMEOUT_MS);
    expect(await (await pending).json()).toMatchObject({ ok: false, outcome: 'timeout' });
    await disconnected;
    expect(requests).toHaveLength(1);
  });

  it('honors an already cancelled caller without contacting the provider', async () => {
    const settings = saved();
    expect(await testModelConnection({ db, dataDir: dir, settings, model: 'example-model', signal: AbortSignal.abort() }))
      .toMatchObject({ ok: false, outcome: 'cancelled' });
    expect(requests).toHaveLength(0);
  });

  it('does not send a first-party Anthropic reference with the OpenAI-compatible credential', async () => {
      const settings = saved({ vendor: 'openai' });
      const result = await (await post({ model: 'anthropic/model-served-elsewhere', revision: settings.revision })).json();
      expect(result).toMatchObject({ ok: false, outcome: 'configuration_invalid', model: 'anthropic/model-served-elsewhere' });
      expect(requests).toHaveLength(0);
  });

  it('preserves unregistered vendor namespaces as gateway model IDs', async () => {
    const settings = saved();
    expect(await (await post({ model: 'unknown-provider/example-model', revision: settings.revision })).json())
      .toMatchObject({ ok: true, resolved_model: 'unknown-provider/example-model' });
    expect(requests[0].body.model).toBe('unknown-provider/example-model');
  });

  it.each([undefined, '', '********', '${MA_CONNECTION_MISSING_KEY}', '__managed_secret__:wrong.key'])
    ('fails closed with an unavailable stored credential (%s)', async (key) => {
      const settings = saved();
      const config = { ...settings.saved_config, model: { ...settings.saved_config.model, api_key: key } };
      // Simulate corrupted/outdated state without letting save normalize it.
      db.prepare('UPDATE runtime_settings SET config = ?').run(JSON.stringify(config));
      expect(await (await post({ model: 'example-model', revision: settings.revision })).json())
        .toMatchObject({ ok: false, outcome: 'configuration_invalid' });
      expect(requests).toHaveLength(0);
    });

  it('fails closed on missing, empty, or invalid endpoint environment variables', async () => {
    const settings = saved({ base_url: '${MA_CONNECTION_TEST_URL}' });
    for (const endpoint of [undefined, '', 'file:///private/local-data']) {
      vi.stubEnv('MA_CONNECTION_TEST_URL', endpoint);
      expect(await (await post({ model: 'example-model', revision: settings.revision })).json())
        .toMatchObject({ ok: false, outcome: 'configuration_invalid' });
    }
    expect(requests).toHaveLength(0);
  });

  it('does not block a model probe on an unrelated adapter configuration', async () => {
    const settings = saved();
    settings.saved_config.sandbox.provider = 'remote';
    db.prepare('UPDATE runtime_settings SET config = ?').run(JSON.stringify(settings.saved_config));
    expect(await (await post({ model: 'example-model', revision: settings.revision })).json()).toMatchObject({ ok: true });
  });

  it('rejects stale revisions, unauthenticated requests, and arbitrary provider overrides before networking', async () => {
    const settings = saved();
    expect((await post({ model: 'example-model', revision: 1 })).status).toBe(409);
    expect((await post({ model: 'example-model', revision: settings.revision }, '')).status).toBe(401);
    for (const body of [null, [], {}, { model: '', revision: 2 }, { model: 'm', revision: '2' },
      { model: 'x'.repeat(257), revision: 2 }, { model: 'm', revision: 2, base_url: baseUrl },
      { model: 'm', revision: 2, api_key: 'replacement-key' }]) {
      expect((await post(body)).status).toBe(400);
    }
    const invalidJson = await app().request('/v1/x/settings/test-model', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'runtime-fixture-key' }, body: '{',
    });
    expect(invalidJson.status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it('limits each caller to five provider tests per minute', async () => {
    const settings = saved();
    const runtime = app();
    const request = () => runtime.request('/v1/x/settings/test-model', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'runtime-fixture-key' },
      body: JSON.stringify({ model: 'example-model', revision: settings.revision }),
    });
    for (let count = 0; count < 5; count++) {
      expect((await request()).status).toBe(200);
    }
    expect((await request()).status).toBe(429);
    expect(requests).toHaveLength(5);
  });

  it('does not create runtime settings while testing an uninitialized workspace', async () => {
    db.prepare("DELETE FROM runtime_settings WHERE id = 'default'").run();
    expect(await (await post({ model: 'example-model', revision: 1 })).json())
      .toMatchObject({ ok: false, outcome: 'configuration_invalid', provider: 'unconfigured', revision: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM runtime_settings WHERE id = 'default'").get()).toEqual({ n: 0 });
    expect(requests).toHaveLength(0);
  });

  it('leaves the original model configuration check offline', async () => {
    const settings = saved();
    const res = await app().request('/v1/x/settings/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'runtime-fixture-key' },
      body: JSON.stringify({ area: 'model', config: settings.saved_config.model }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(requests).toHaveLength(0);
  });
});
