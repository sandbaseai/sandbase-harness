/**
 * Integration test: a self-hosted worker materializes a session's attached
 * memory stores as real directories under `<workdir>/mnt/memory/<mount>/`,
 * keeps them reconciled against the memory API on the sync interval, and
 * flushes a final sync before the copy is removed — the published worker
 * memory contract.
 *
 * Everything runs against the real memory routes and the real `mawt_` scope
 * fence: the session retrieve that names the attached stores, the memories
 * list/write/delete routes the sync drives, and the read-only refusal that
 * scope already enforces.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { WorkQueue } from '@/sandbox/self-hosted-provider.js';
import { createServer } from '@/api/server.js';
import { issueSessionWorkToken } from '@/core/auth/session-work-tokens.js';
import { workerRunCommand } from '@/cli/worker-commands.js';
import {
  MEMORY_MARKER_FILE,
  mountSessionMemoryStores,
  reconcileMemoryMount,
  releaseSessionMemoryMounts,
  type WorkerMemoryConfig,
} from '@/cli/worker-memory.js';
import { CMA_AGENT_MEMORY_BETA, CMA_ANTHROPIC_VERSION, CMA_MANAGED_AGENTS_BETA } from '@/core/cma/compatibility.js';

const HEADERS = {
  'content-type': 'application/json',
  'anthropic-version': CMA_ANTHROPIC_VERSION,
  'anthropic-beta': CMA_MANAGED_AGENTS_BETA,
};
// Memory-store routes are their own beta family; combining it with the
// managed-agents beta is an explicit 400 in the admission middleware.
const MEMORY_HEADERS = {
  'content-type': 'application/json',
  'anthropic-version': CMA_ANTHROPIC_VERSION,
  'anthropic-beta': CMA_AGENT_MEMORY_BETA,
};
const API_KEY = 'test-api-key';
const itPosix = it.skipIf(process.platform === 'win32');

describe('worker memory store materialization', () => {
  let db: Database;
  let tmpDir: string;
  let workdir: string;
  let lockDir: string;
  let listening: { close: (cb?: () => void) => void } | undefined;
  let baseUrl: string;
  let token: string;
  let storeId: string;
  let otherStoreId: string;

  const headersFor = (path: string) =>
    path.startsWith('/v1/memory_stores') ? MEMORY_HEADERS : HEADERS;
  const post = async (path: string, body: unknown, bearer: string = API_KEY) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { ...headersFor(path), authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  const get = async (path: string, bearer: string = API_KEY) => {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { ...headersFor(path), authorization: `Bearer ${bearer}` },
    });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  const memories = async (id: string) => {
    const res = await get(`/v1/memory_stores/${id}/memories?view=full`);
    return res.body.data as Array<{ id: string; path: string; content: string }>;
  };
  const workerConfig = (): WorkerMemoryConfig => ({
    baseUrl,
    sessionToken: token,
    root: workdir,
    requestTimeoutMs: 5000,
    // The POSIX gate is exercised explicitly below; the sync mechanics are
    // platform-agnostic and run on every host.
    platform: 'linux',
    lockDir,
  });

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-wmem-'));
    const dataDir = join(tmpDir, 'data');
    workdir = join(tmpDir, 'work');
    lockDir = join(tmpDir, 'locks');
    mkdirSync(workdir, { recursive: true });
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();

    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db.prepare(`INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', ?)`).run(
      JSON.stringify({ name: 'x', model: 'test-model' }),
    );

    const app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      apiKeys: [API_KEY],
      workQueue: new WorkQueue(db),
      workspace: {
        root: tmpDir,
        dataDir,
        agentsDir: join(tmpDir, 'agents'),
        skillsDir: join(tmpDir, 'skills'),
        target: 'local',
      },
    });
    const port = await new Promise<number>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        listening = server as unknown as { close: (cb?: () => void) => void };
        resolve(info.port);
      });
    });
    baseUrl = `http://127.0.0.1:${port}`;

    // A store the session attaches (one memory in it) and one it does not.
    const store = await post('/v1/memory_stores', { name: 'scratch' });
    expect(store.status).toBe(201);
    storeId = store.body.id;
    const rec = await post(`/v1/memory_stores/${storeId}/memories`, { path: '/notes.md', content: 'remember this' });
    expect(rec.status).toBe(201);
    const other = await post('/v1/memory_stores', { name: 'unattached' });
    otherStoreId = other.body.id;

    db.prepare(
      "INSERT INTO sessions (id, agent_id, agent_name, environment_id, resources, status) VALUES ('sess_mem', 'agent_x', 'x', 'env_a', ?, 'paused')",
    ).run(JSON.stringify([
      { type: 'memory_store', memory_store_id: storeId, mount_path: '/mnt/memory/context', access: 'read_write' },
    ]));
    db.prepare(
      "INSERT INTO sessions (id, agent_id, agent_name, environment_id, resources, status) VALUES ('sess_ro', 'agent_x', 'x', 'env_a', ?, 'paused')",
    ).run(JSON.stringify([
      { type: 'memory_store', memory_store_id: storeId, mount_path: '/mnt/memory/context', access: 'read_only' },
    ]));

    token = issueSessionWorkToken(db, 'sess_mem', 'env_a');
  });

  afterEach(async () => {
    if (listening) {
      const server = listening;
      listening = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    db?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('mawt_ admits the attached store and refuses the rest', async () => {
    expect((await get(`/v1/memory_stores/${storeId}/memories`, token)).status).toBe(200);
    expect((await get(`/v1/memory_stores/${otherStoreId}/memories`, token)).status).toBe(401);
    const otherToken = issueSessionWorkToken(db, 'sess_other_missing', 'env_a');
    expect((await get(`/v1/memory_stores/${storeId}/memories`, otherToken)).status).toBe(401);
    // A read_only attachment refuses writes through the same token.
    const roToken = issueSessionWorkToken(db, 'sess_ro', 'env_a');
    const res = await fetch(`${baseUrl}/v1/memory_stores/${storeId}/memories`, {
      method: 'POST',
      headers: { ...MEMORY_HEADERS, authorization: `Bearer ${roToken}` },
      body: JSON.stringify({ path: '/x.md', content: 'no' }),
    });
    expect(res.status).toBe(403);
  });

  it('mounts the store with a marker, syncs both directions, and releases', async () => {
    const config = workerConfig();
    const mounts = await mountSessionMemoryStores(config, [
      { type: 'memory_store', memory_store_id: storeId, mount_path: '/mnt/memory/context', access: 'read_write' },
    ]);
    expect(mounts).toHaveLength(1);
    const dir = mounts[0].dir;
    // Canonical layout: <workdir>/mnt/memory/<slug-or-mount>/ with the marker.
    expect(dir).toBe(join(workdir, 'mnt', 'memory', 'context'));
    expect(readFileSync(join(dir, MEMORY_MARKER_FILE), 'utf8')).toContain(storeId);
    expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toBe('remember this');

    // A second worker on this host cannot mount the same store.
    await expect(
      mountSessionMemoryStores(config, [
        { type: 'memory_store', memory_store_id: storeId, mount_path: '/mnt/memory/other', access: 'read_only' },
      ]),
    ).rejects.toThrow('already mounted');

    // Local write + a remote write reconcile in both directions.
    writeFileSync(join(dir, 'agent-edit.md'), 'agent wrote this');
    await post(`/v1/memory_stores/${storeId}/memories`, { path: '/remote.md', content: 'operator wrote this' });
    await reconcileMemoryMount(config, mounts[0]);
    expect(readFileSync(join(dir, 'remote.md'), 'utf8')).toBe('operator wrote this');
    const afterSync = await memories(storeId);
    expect(afterSync.find((m) => m.path === '/agent-edit.md')?.content).toBe('agent wrote this');

    // Conflict: both sides edited /notes.md — the store's newer version wins.
    writeFileSync(join(dir, 'notes.md'), 'local loses');
    const row = (await memories(storeId)).find((m) => m.path === '/notes.md')!;
    await post(`/v1/memory_stores/${storeId}/memories/${row.id}`, { content: 'store wins' });
    await reconcileMemoryMount(config, mounts[0]);
    expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toBe('store wins');
    expect((await memories(storeId)).find((m) => m.path === '/notes.md')?.content).toBe('store wins');

    // Release: final sync, then the copy and the lock are gone.
    await releaseSessionMemoryMounts(mounts);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(mounts[0].lockPath)).toBe(false);
    // The lock freed, so a later worker can mount the store again.
    const again = await mountSessionMemoryStores(config, [
      { type: 'memory_store', memory_store_id: storeId, mount_path: '/mnt/memory/context', access: 'read_only' },
    ]);
    await releaseSessionMemoryMounts(again, { finalSync: false });
  });

  it('a read_only mount never uploads the agent side', async () => {
    const roToken = issueSessionWorkToken(db, 'sess_ro', 'env_a');
    const config = { ...workerConfig(), sessionToken: roToken };
    const mounts = await mountSessionMemoryStores(config, [
      { type: 'memory_store', memory_store_id: storeId, mount_path: '/mnt/memory/context', access: 'read_only' },
    ]);
    writeFileSync(join(mounts[0].dir, 'sneaky.md'), 'should not upload');
    await reconcileMemoryMount(config, mounts[0]);
    expect((await memories(storeId)).find((m) => m.path === '/sneaky.md')).toBeUndefined();
    await releaseSessionMemoryMounts(mounts, { finalSync: false });
  });

  it('refuses to mount on a Windows host', async () => {
    const config = { ...workerConfig(), platform: 'win32' as NodeJS.Platform };
    await expect(
      mountSessionMemoryStores(config, [
        { type: 'memory_store', memory_store_id: storeId, mount_path: '/mnt/memory/context' },
      ]),
    ).rejects.toThrow('POSIX');
  });

  itPosix('worker run mounts the store, serves items against it, and flushes on exit', async () => {
    const queue = new WorkQueue(db);
    const readItem = queue.enqueue('sess_mem', 'read', { path: '/mnt/memory/context/notes.md' });
    const writeItem = queue.enqueue('sess_mem', 'write', { path: '/mnt/memory/context/final.md', content: 'flushed at exit' });

    const claimRes = await fetch(`${baseUrl}/v1/x/worker/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ worker_id: 'worker_mem' }),
    });
    const handed = (await claimRes.json()) as { id: string; secret?: string };
    expect(handed.id).toBe(readItem);
    expect(handed.secret).toBeTruthy();

    const envBackup = { ...process.env };
    process.env.MANAGED_AGENTS_SESSION_ID = 'sess_mem';
    process.env.MANAGED_AGENTS_WORKER_ID = 'worker_mem';
    process.env.MANAGED_AGENTS_BASE_URL = baseUrl;
    process.env.MANAGED_AGENTS_API_KEY = API_KEY;
    delete process.env.MANAGED_AGENTS_ENVIRONMENT_ID;
    delete process.env.MANAGED_AGENTS_ENVIRONMENT_KEY;
    try {
      await workerRunCommand(
        { workdir, maxIdleMs: '500', intervalMs: '250' },
        Readable.from([JSON.stringify(handed)]),
      );
    } finally {
      process.env = envBackup;
    }

    // The mounted file was readable inside the session, and the write the
    // agent made under the mount uploaded in the worker's final sync.
    expect(queue.get(readItem)!.status).toBe('applied');
    expect(queue.get(readItem)!.result).toBe('remember this');
    expect(queue.get(writeItem)!.status).toBe('applied');
    const after = await memories(storeId);
    expect(after.find((m) => m.path === '/final.md')?.content).toBe('flushed at exit');
    // Exit tore the copy down.
    expect(existsSync(join(workdir, 'mnt', 'memory', 'context'))).toBe(false);
  });
});
