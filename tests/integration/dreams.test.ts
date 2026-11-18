/**
 * Integration tests for the Dreams resource (`/v1/dreams`).
 *
 * A dream is durable state plus a pipeline session doing the work, so these
 * tests run the real stack: HTTP route → dreams row → SessionManager →
 * executor → a stub strategy whose tool calls land in the real
 * SqliteMemoryMountAdapter. That is what makes the assertions meaningful —
 * `outputs` names a store a caller can then read, `session_id` names a
 * session whose event stream exists, and "partial output kept" is measured on
 * the store, not on a mock.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { SqliteMemoryMountAdapter } from '@/core/memory/mount-adapter.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { createServer } from '@/api/server.js';
import { sweepDreams } from '@/core/dreams/runner.js';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import type { LanguageModel } from 'ai';

const HEADERS = { 'content-type': 'application/json' };

function fakeModel(): LanguageModel {
  return {
    specificationVersion: 'v4', provider: 'test', modelId: 't',
    supportedUrls: {},
    async doGenerate() { return { content: [], finishReason: { unified: 'stop', raw: 'stop' }, usage: {}, warnings: [] } as any; },
    async doStream() { throw new Error('unused'); },
  } as unknown as LanguageModel;
}

/**
 * The pipeline writes through its mounted output store with the ordinary
 * write tool — the same path a real model would take — so what it leaves
 * behind is what the store holds, partial writes included.
 */
class DreamPipelineStrategy implements AgentStrategy {
  readonly name = 'dream-stub';
  contexts: StrategyContext[] = [];
  constructor(private readonly behavior: 'write' | 'write-then-fail' | 'noop' = 'write') {}

  async *execute(ctx: StrategyContext) {
    this.contexts.push(ctx);
    const writable = (ctx.session.resources ?? []).find(
      (resource) => (resource as { access?: string }).access !== 'read_only',
    ) as { mount_path?: string } | undefined;
    if (this.behavior !== 'noop' && writable?.mount_path) {
      const write = ctx.tools.write as { execute?: (input: unknown) => Promise<unknown> } | undefined;
      await write?.execute?.({ path: `${writable.mount_path}/consolidated.md`, content: 'consolidated fact' });
    }
    if (this.behavior === 'write-then-fail') throw new Error('pipeline exploded mid-write');
    return;
  }
}

interface Harness {
  db: Database;
  app: ReturnType<typeof createServer>;
  manager: SessionManager;
  strategy: DreamPipelineStrategy;
  requestedModels: string[];
  tmpDir: string;
}

function harness(options: { executor?: boolean; behavior?: 'write' | 'write-then-fail' | 'noop'; defaultModel?: string } = {}): Harness {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ma-dreams-'));
  const db = new Database(join(tmpDir, 'test.db'));
  db.runMigrations();
  db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
  db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_one', 'one', '{"name":"one","model":"m"}')`);

  const manager = new SessionManager(db);
  const strategy = new DreamPipelineStrategy(options.behavior ?? 'write');
  const requestedModels: string[] = [];

  if (options.executor !== false) {
    const modelRegistry = new ModelRegistry();
    (modelRegistry as any).createModel = (name: string) => {
      requestedModels.push(name);
      return fakeModel();
    };
    (modelRegistry as any).resolveModelConfig = (name: string) => ({ name });
    manager.setExecutor(new DefaultSessionExecutor({
      agents: [],
      modelRegistry,
      sandboxProvider: new LocalSandboxProvider(tmpDir),
      strategy,
      eventLogger: manager.getEventLogger(),
      memoryMount: new SqliteMemoryMountAdapter(db),
    } as never));
  }

  const app = createServer({
    db,
    sessionManager: manager,
    agents: [],
    consoleRoot: null,
    runtime: {
      models: options.defaultModel ? [{ name: options.defaultModel, is_default: true } as never] : [],
      sandboxProviders: ['local'],
      memory: 'sqlite',
      authEnabled: false,
    },
    reloadAgents: () => ({ agents: [], errors: [] }),
  } as never);

  return { db, app, manager, strategy, requestedModels, tmpDir };
}

let h: Harness;

beforeEach(() => {
  h = harness();
});

afterEach(() => {
  h.db.close();
  rmSync(h.tmpDir, { recursive: true, force: true });
});

function createStore(name = 'input', record?: { path: string; content: string }): string {
  const id = `memstore_${nanoid(12)}`;
  h.db.prepare('INSERT INTO memory_stores (id, name, description, provider, config, metadata) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, '', 'sqlite', '{}', '{}');
  if (record) {
    const adapter = new SqliteMemoryMountAdapter(h.db);
    const created = adapter.create(id, record.path, record.content);
    if (!created.ok) throw new Error(`seed memory failed: ${created.error.message}`);
  }
  return id;
}

function createSourceSession(text: string): string {
  const session = h.manager.create({ agent: 'agent_one' });
  h.manager.getEventLogger().append(session.id, {
    type: 'user.message',
    content: [{ type: 'text', text }],
  });
  return session.id;
}

async function postDream(body: Record<string, unknown>) {
  const res = await h.app.request('/v1/dreams', { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any, headers: res.headers };
}

function dreamBody(storeId: string, sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    inputs: [
      { type: 'memory_store', memory_store_id: storeId },
      { type: 'sessions', session_ids: [sessionId] },
    ],
    model: 'dream-model',
    ...extra,
  };
}

async function getDream(id: string) {
  const res = await h.app.request(`/v1/dreams/${id}`, { headers: HEADERS });
  return { status: res.status, body: await res.json() as any };
}

async function waitForTerminal(id: string, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last = await getDream(id);
  while (['pending', 'running'].includes(last.body.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    last = await getDream(id);
  }
  return last;
}

describe('POST /v1/dreams validation', () => {
  it('refuses malformed bodies before any row exists', async () => {
    const storeId = createStore();
    const sessionId = createSourceSession('source transcript');

    for (const [label, body] of [
      ['empty body', {}],
      ['no memory store', { inputs: [{ type: 'sessions', session_ids: [sessionId] }] }],
      ['no sessions', { inputs: [{ type: 'memory_store', memory_store_id: storeId }] }],
      ['duplicate sessions', { ...dreamBody(storeId, sessionId), inputs: [{ type: 'memory_store', memory_store_id: storeId }, { type: 'sessions', session_ids: [sessionId, sessionId] }] }],
      ['instructions over 4096', { ...dreamBody(storeId, sessionId), instructions: 'x'.repeat(4097) }],
      ['fast speed refused', { ...dreamBody(storeId, sessionId), model: { id: 'm', speed: 'fast' } }],
      ['update_existing on another store', { ...dreamBody(storeId, sessionId), output_behavior: { type: 'update_existing', memory_store_id: 'memstore_other' } }],
      ['unknown field', { ...dreamBody(storeId, sessionId), extra_field: 1 }],
    ] as const) {
      const res = await postDream(body);
      expect(res.status, label).toBe(400);
      expect(res.body.error.type, label).toBe('invalid_request_error');
    }
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM dreams').get() as { n: number }).toEqual({ n: 0 });
  });

  it('refuses unknown resources by name', async () => {
    const storeId = createStore();
    const sessionId = createSourceSession('x');

    const badStore = await postDream(dreamBody('memstore_missing', sessionId));
    expect(badStore.status).toBe(400);
    expect(badStore.body.error.code).toBe('memory_store_not_found');

    const badSession = await postDream(dreamBody(storeId, 'sess_missing'));
    expect(badSession.status).toBe(400);
    expect(badSession.body.error.code).toBe('session_not_found');

    h.db.prepare("UPDATE memory_stores SET archived_at = datetime('now') WHERE id = ?").run(storeId);
    const archived = await postDream(dreamBody(storeId, sessionId));
    expect(archived.status).toBe(400);
    expect(archived.body.error.code).toBe('memory_store_archived');
  });

  it('refuses to create a dream when no model resolves', async () => {
    const noModelHarness = harness(); // runtime.models is empty and no settings default
    try {
      const storeId = `memstore_${nanoid(12)}`;
      noModelHarness.db.prepare('INSERT INTO memory_stores (id, name, description, provider, config, metadata) VALUES (?, ?, ?, ?, ?, ?)')
        .run(storeId, 's', '', 'sqlite', '{}', '{}');
      const session = noModelHarness.manager.create({ agent: 'agent_one' });
      const res = await noModelHarness.app.request('/v1/dreams', {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({
          inputs: [
            { type: 'memory_store', memory_store_id: storeId },
            { type: 'sessions', session_ids: [session.id] },
          ],
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error.code).toBe('model_not_configured');
    } finally {
      noModelHarness.db.close();
      rmSync(noModelHarness.tmpDir, { recursive: true, force: true });
    }
  });
});

describe('dream lifecycle', () => {
  it('runs pending → running → completed and leaves a readable output store', async () => {
    const storeId = createStore('facts', { path: '/a.md', content: 'source fact' });
    const sessionId = createSourceSession('user prefers concise answers');

    const created = await postDream(dreamBody(storeId, sessionId, { instructions: 'keep it short' }));
    expect(created.status).toBe(201);
    const dream = created.body;
    expect(dream.id).toMatch(/^drm_/);
    expect(dream.type).toBe('dream');
    expect(dream.status).toBe('running');
    expect(dream.model).toEqual({ id: 'dream-model' });
    expect(dream.output_behavior).toEqual({ type: 'create_new' });
    expect(dream.instructions).toBe('keep it short');
    expect(dream.session_id).toMatch(/^sess_/);
    expect(dream.inputs).toEqual([
      { type: 'memory_store', memory_store_id: storeId },
      { type: 'sessions', session_ids: [sessionId] },
    ]);
    // The output store is recorded at start, so a caller can watch it fill.
    expect(dream.outputs).toEqual([{ type: 'memory_store', memory_store_id: expect.stringMatching(/^memstore_/) }]);
    const outputStoreId = dream.outputs[0].memory_store_id;

    const finished = await waitForTerminal(dream.id);
    expect(finished.body.status).toBe('completed');
    expect(finished.body.ended_at).toBeTruthy();
    expect(finished.body.error).toBeNull();

    // create_new seeded the output store as a copy of the input, and the
    // pipeline's own write landed beside it.
    const adapter = new SqliteMemoryMountAdapter(h.db);
    const copied = adapter.read(outputStoreId, '/a.md');
    expect(copied.ok && copied.value.content).toBe('source fact');
    const written = adapter.read(outputStoreId, '/consolidated.md');
    expect(written.ok && written.value.content).toBe('consolidated fact');

    // The input store is untouched under create_new.
    expect(adapter.list(storeId).ok && adapter.list(storeId)).toBeTruthy();
    const inputRecords = adapter.list(storeId);
    expect(inputRecords.ok && inputRecords.value.map((r) => r.path)).toEqual(['/a.md']);

    // The pipeline session is auditable through the public session surface.
    const sessionRes = await h.app.request(`/v1/sessions/${dream.session_id}`, { headers: HEADERS });
    expect(sessionRes.status).toBe(200);
    const eventsRes = await h.app.request(`/v1/sessions/${dream.session_id}/events`, { headers: HEADERS });
    expect(eventsRes.status).toBe(200);

    // The resolved request model reached the executor, not the placeholder.
    expect(h.requestedModels).toEqual(['dream-model']);
  });

  it('falls back to the workspace default model when the request omits one', async () => {
    const withDefault = harness({ defaultModel: 'workspace-default-model' });
    try {
      const storeId = `memstore_${nanoid(12)}`;
      withDefault.db.prepare('INSERT INTO memory_stores (id, name, description, provider, config, metadata) VALUES (?, ?, ?, ?, ?, ?)')
        .run(storeId, 's', '', 'sqlite', '{}', '{}');
      const session = withDefault.manager.create({ agent: 'agent_one' });
      const res = await withDefault.app.request('/v1/dreams', {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({
          inputs: [
            { type: 'memory_store', memory_store_id: storeId },
            { type: 'sessions', session_ids: [session.id] },
          ],
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.model).toEqual({ id: 'workspace-default-model' });
      // The frozen session snapshot must carry the resolved model, not the
      // pipeline definition's placeholder.
      const row = withDefault.db.prepare('SELECT agent_definition FROM sessions WHERE id = ?').get(body.session_id) as { agent_definition: string };
      expect(JSON.parse(row.agent_definition).model).toBe('workspace-default-model');
    } finally {
      withDefault.db.close();
      rmSync(withDefault.tmpDir, { recursive: true, force: true });
    }
  });

  it('fails with structured error and keeps the partially written output store', async () => {
    const failing = harness({ behavior: 'write-then-fail' });
    try {
      const storeId = `memstore_${nanoid(12)}`;
      failing.db.prepare('INSERT INTO memory_stores (id, name, description, provider, config, metadata) VALUES (?, ?, ?, ?, ?, ?)')
        .run(storeId, 's', '', 'sqlite', '{}', '{}');
      const session = failing.manager.create({ agent: 'agent_one' });
      const res = await failing.app.request('/v1/dreams', {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({
          inputs: [
            { type: 'memory_store', memory_store_id: storeId },
            { type: 'sessions', session_ids: [session.id] },
          ],
          model: 'dream-model',
        }),
      });
      const dream = (await res.json()) as any;
      const outputStoreId = dream.outputs[0].memory_store_id;

      const deadline = Date.now() + 8_000;
      let final = dream;
      while (final.status !== 'failed' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        final = (await (await failing.app.request(`/v1/dreams/${dream.id}`, { headers: HEADERS })).json()) as any;
      }
      expect(final.status).toBe('failed');
      expect(final.error).toMatchObject({ type: 'internal_error' });
      expect(final.error.message).toBeTruthy();

      const adapter = new SqliteMemoryMountAdapter(failing.db);
      const partial = adapter.read(outputStoreId, '/consolidated.md');
      expect(partial.ok && partial.value.content).toBe('consolidated fact');
    } finally {
      failing.db.close();
      rmSync(failing.tmpDir, { recursive: true, force: true });
    }
  });

  it('writes into the input store under update_existing and conflicts on a second writer', async () => {
    const storeId = createStore('mutable');
    const sessionId = createSourceSession('x');

    const created = await postDream(dreamBody(storeId, sessionId, {
      output_behavior: { type: 'update_existing', memory_store_id: storeId },
    }));
    expect(created.status).toBe(201);
    expect(created.body.outputs).toEqual([{ type: 'memory_store', memory_store_id: storeId }]);

    const finished = await waitForTerminal(created.body.id);
    expect(finished.body.status).toBe('completed');
    const adapter = new SqliteMemoryMountAdapter(h.db);
    expect(adapter.read(storeId, '/consolidated.md').ok).toBe(true);

    // Single-writer rule: a second update_existing dream while one is still
    // active is the published 409 conflict_error. Keep the first writer active
    // by marking a fresh dream running directly — deterministic without timing.
    h.db.prepare(
      `INSERT INTO dreams (id, status, inputs, instructions, model, output_behavior, input_store_id, output_store_id)
       VALUES ('drm_holder', 'running', '[]', NULL, '{}', ?, ?, ?)`,
    ).run(JSON.stringify({ type: 'update_existing', memory_store_id: storeId }), storeId, storeId);
    const conflict = await postDream(dreamBody(storeId, sessionId, {
      output_behavior: { type: 'update_existing', memory_store_id: storeId },
    }));
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.type).toBe('conflict_error');
    expect(conflict.body.error.code).toBe('target_store_held');
    expect(conflict.body.error.message).toContain('drm_holder');
    expect(conflict.headers.get('x-should-retry')).toBe('false');
  });
});

describe('cancel and archive', () => {
  it('cancels an active dream, interrupts the pipeline session, and refuses a second cancel', async () => {
    // No executor: the pipeline session stays queued, so the dream is running
    // without a turn in flight — cancel semantics are deterministic here.
    const idle = harness({ executor: false });
    try {
      const storeId = `memstore_${nanoid(12)}`;
      idle.db.prepare('INSERT INTO memory_stores (id, name, description, provider, config, metadata) VALUES (?, ?, ?, ?, ?, ?)')
        .run(storeId, 's', '', 'sqlite', '{}', '{}');
      const session = idle.manager.create({ agent: 'agent_one' });
      const created = await (await idle.app.request('/v1/dreams', {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({
          inputs: [
            { type: 'memory_store', memory_store_id: storeId },
            { type: 'sessions', session_ids: [session.id] },
          ],
          model: 'm',
        }),
      })).json() as any;
      expect(created.status).toBe('running');

      const canceled = await idle.app.request(`/v1/dreams/${created.id}/cancel`, { method: 'POST', headers: HEADERS });
      expect(canceled.status).toBe(200);
      const canceledBody = await canceled.json() as any;
      expect(canceledBody.status).toBe('canceled');
      expect(canceledBody.ended_at).toBeTruthy();

      // The pipeline session was stopped and archived — its log stays readable.
      const pipeline = idle.db.prepare('SELECT status FROM sessions WHERE id = ?').get(created.session_id) as { status: string };
      expect(['cancelled', 'archived']).toContain(pipeline.status);

      const again = await idle.app.request(`/v1/dreams/${created.id}/cancel`, { method: 'POST', headers: HEADERS });
      expect(again.status).toBe(400);
      expect(((await again.json()) as any).error.code).toBe('dream_not_active');
    } finally {
      idle.db.close();
      rmSync(idle.tmpDir, { recursive: true, force: true });
    }
  });

  it('refuses archive while active, archives a terminal dream, and is idempotent', async () => {
    const storeId = createStore();
    const sessionId = createSourceSession('x');
    const created = await postDream(dreamBody(storeId, sessionId));

    const active = await h.app.request(`/v1/dreams/${created.body.id}/archive`, { method: 'POST', headers: HEADERS });
    expect(active.status).toBe(400);
    expect(((await active.json()) as any).error.code).toBe('dream_active');

    const finished = await waitForTerminal(created.body.id);
    expect(finished.body.status).toBe('completed');

    const archived = await h.app.request(`/v1/dreams/${created.body.id}/archive`, { method: 'POST', headers: HEADERS });
    expect(archived.status).toBe(200);
    expect(((await archived.json()) as any).archived_at).toBeTruthy();

    const repeat = await h.app.request(`/v1/dreams/${created.body.id}/archive`, { method: 'POST', headers: HEADERS });
    expect(repeat.status).toBe(200);
  });
});

describe('GET /v1/dreams listing', () => {
  it('lists newest first, filters by statuses and created bounds, and paginates', async () => {
    const storeId = createStore();
    const s1 = createSourceSession('a');
    const s2 = createSourceSession('b');
    const first = (await postDream(dreamBody(storeId, s1))).body;
    const second = (await postDream(dreamBody(storeId, s2))).body;
    await h.app.request(`/v1/dreams/${first.id}/cancel`, { method: 'POST', headers: HEADERS });
    await waitForTerminal(second.id);

    const all = await (await h.app.request('/v1/dreams', { headers: HEADERS })).json() as any;
    expect(all.data.map((d: any) => d.id)).toEqual([second.id, first.id]);

    const runningOnly = await (await h.app.request('/v1/dreams?statuses=running', { headers: HEADERS })).json() as any;
    expect(runningOnly.data.map((d: any) => d.id)).toEqual([]);
    const canceledOnly = await (await h.app.request('/v1/dreams?statuses=canceled', { headers: HEADERS })).json() as any;
    expect(canceledOnly.data.map((d: any) => d.id)).toEqual([first.id]);
    const sdkSpelling = await (await h.app.request('/v1/dreams?statuses[]=canceled', { headers: HEADERS })).json() as any;
    expect(sdkSpelling.data).toHaveLength(1);
    const badStatus = await h.app.request('/v1/dreams?statuses=bogus', { headers: HEADERS });
    expect(badStatus.status).toBe(400);

    const bounded = await (await h.app.request('/v1/dreams?created_at[gt]=2030-01-01T00:00:00Z', { headers: HEADERS })).json() as any;
    expect(bounded.data).toHaveLength(0);
    const badTs = await h.app.request('/v1/dreams?created_at[gt]=not-a-date', { headers: HEADERS });
    expect(badTs.status).toBe(400);

    const page1 = await (await h.app.request('/v1/dreams?limit=1', { headers: HEADERS })).json() as any;
    expect(page1.data).toHaveLength(1);
    expect(page1.next_page).toBeTruthy();
    const page2 = await (await h.app.request(`/v1/dreams?limit=1&page=${encodeURIComponent(page1.next_page)}`, { headers: HEADERS })).json() as any;
    expect(page2.data).toHaveLength(1);
    expect(page2.data[0].id).not.toBe(page1.data[0].id);

    const unknownParam = await h.app.request('/v1/dreams?bogus=1', { headers: HEADERS });
    expect(unknownParam.status).toBe(400);
  });

  it('hides archived dreams by default and includes them on include_archived=true', async () => {
    const storeId = createStore();
    const sessionId = createSourceSession('x');
    const created = await postDream(dreamBody(storeId, sessionId));
    await waitForTerminal(created.body.id);
    await h.app.request(`/v1/dreams/${created.body.id}/archive`, { method: 'POST', headers: HEADERS });

    const without = await (await h.app.request('/v1/dreams', { headers: HEADERS })).json() as any;
    expect(without.data.find((d: any) => d.id === created.body.id)).toBeUndefined();
    const withArchived = await (await h.app.request('/v1/dreams?include_archived=true', { headers: HEADERS })).json() as any;
    expect(withArchived.data.find((d: any) => d.id === created.body.id)?.archived_at).toBeTruthy();

    // An archived dream remains retrievable — like the SDK, archive is a
    // listing filter, not a deletion.
    const fetched = await getDream(created.body.id);
    expect(fetched.status).toBe(200);
    expect(fetched.body.status).toBe('completed');
  });
});

describe('dream recovery', () => {
  it('sweepDreams starts a pending dream that never reached a session', async () => {
    const storeId = createStore();
    const sessionId = createSourceSession('x');
    h.db.prepare(
      `INSERT INTO dreams (id, status, inputs, model, output_behavior, input_store_id)
       VALUES ('drm_orphan', 'pending', ?, ?, ?, ?)`,
    ).run(
      JSON.stringify([
        { type: 'memory_store', memory_store_id: storeId },
        { type: 'sessions', session_ids: [sessionId] },
      ]),
      JSON.stringify({ id: 'dream-model' }),
      JSON.stringify({ type: 'create_new' }),
      storeId,
    );

    await sweepDreams({ db: h.db, sessionManager: h.manager });
    const row = h.db.prepare('SELECT status, session_id FROM dreams WHERE id = ?').get('drm_orphan') as { status: string; session_id: string | null };
    expect(row.status).toBe('running');
    expect(row.session_id).toMatch(/^sess_/);
  });

  it('reconciles a dream whose pipeline session was cancelled externally', async () => {
    const idle = harness({ executor: false });
    try {
      const storeId = `memstore_${nanoid(12)}`;
      idle.db.prepare('INSERT INTO memory_stores (id, name, description, provider, config, metadata) VALUES (?, ?, ?, ?, ?, ?)')
        .run(storeId, 's', '', 'sqlite', '{}', '{}');
      const session = idle.manager.create({ agent: 'agent_one' });
      const created = await (await idle.app.request('/v1/dreams', {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({
          inputs: [
            { type: 'memory_store', memory_store_id: storeId },
            { type: 'sessions', session_ids: [session.id] },
          ],
          model: 'm',
        }),
      })).json() as any;

      // The pipeline session ends out from under the dream — archive is what
      // a queued session's termination looks like — and the next read must
      // report canceled rather than a stuck running row.
      await idle.manager.archive(created.session_id);
      const synced = await idle.app.request(`/v1/dreams/${created.id}`, { headers: HEADERS });
      const body = await synced.json() as any;
      expect(body.status).toBe('canceled');
    } finally {
      idle.db.close();
      rmSync(idle.tmpDir, { recursive: true, force: true });
    }
  });

  it('fails with input_memory_store_unavailable when the input store is archived mid-run', async () => {
    // The published Errors table names this cause: the input store is an
    // ordinary resource with no hold, so archiving it under a `running` dream
    // is legal, and the reconcile must report the published type rather than
    // leaving the dream running against a store it can no longer read.
    const idle = harness({ executor: false });
    try {
      const storeId = `memstore_${nanoid(12)}`;
      idle.db.prepare('INSERT INTO memory_stores (id, name, description, provider, config, metadata) VALUES (?, ?, ?, ?, ?, ?)')
        .run(storeId, 's', '', 'sqlite', '{}', '{}');
      const session = idle.manager.create({ agent: 'agent_one' });
      const created = await (await idle.app.request('/v1/dreams', {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({
          inputs: [
            { type: 'memory_store', memory_store_id: storeId },
            { type: 'sessions', session_ids: [session.id] },
          ],
          model: 'm',
        }),
      })).json() as any;
      expect(created.status).toBe('running');

      const archived = await idle.app.request(`/v1/memory_stores/${storeId}/archive`, { method: 'POST', headers: HEADERS });
      expect(archived.status).toBe(200);

      const synced = await idle.app.request(`/v1/dreams/${created.id}`, { headers: HEADERS });
      const body = await synced.json() as any;
      expect(body.status).toBe('failed');
      expect(body.error).toMatchObject({ type: 'input_memory_store_unavailable' });
    } finally {
      idle.db.close();
      rmSync(idle.tmpDir, { recursive: true, force: true });
    }
  });

  it('fails with input_session_unavailable when an input session is deleted mid-run', async () => {
    const idle = harness({ executor: false });
    try {
      const storeId = `memstore_${nanoid(12)}`;
      idle.db.prepare('INSERT INTO memory_stores (id, name, description, provider, config, metadata) VALUES (?, ?, ?, ?, ?, ?)')
        .run(storeId, 's', '', 'sqlite', '{}', '{}');
      const session = idle.manager.create({ agent: 'agent_one' });
      const created = await (await idle.app.request('/v1/dreams', {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({
          inputs: [
            { type: 'memory_store', memory_store_id: storeId },
            { type: 'sessions', session_ids: [session.id] },
          ],
          model: 'm',
        }),
      })).json() as any;
      expect(created.status).toBe('running');

      // The source session is idle (a create with no executor never runs a
      // turn), so the delete route accepts it — exactly the mid-run removal the
      // published cause names.
      const deleted = await idle.app.request(`/v1/sessions/${session.id}`, { method: 'DELETE', headers: HEADERS });
      expect(deleted.status).toBe(200);

      const synced = await idle.app.request(`/v1/dreams/${created.id}`, { headers: HEADERS });
      const body = await synced.json() as any;
      expect(body.status).toBe('failed');
      expect(body.error).toMatchObject({ type: 'input_session_unavailable' });
    } finally {
      idle.db.close();
      rmSync(idle.tmpDir, { recursive: true, force: true });
    }
  });
});

describe('CMA admission on dreams', () => {
  it('admits the dreaming resource-family beta and the managed-agents beta', async () => {
    const storeId = createStore();
    const sessionId = createSourceSession('x');
    for (const beta of ['dreaming-2026-04-21', 'managed-agents-2026-04-01']) {
      const res = await h.app.request('/v1/dreams', {
        method: 'POST',
        headers: {
          ...HEADERS,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': beta,
        },
        body: JSON.stringify(dreamBody(storeId, sessionId)),
      });
      // Admitted: reaches the route (201), never unsupported_anthropic_beta.
      expect(res.status, beta).toBe(201);
    }
  });
});
