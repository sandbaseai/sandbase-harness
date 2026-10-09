/**
 * Integration test: a self-hosted worker downloads the session's attached
 * file resources into `<workdir>/mnt/session/uploads/...` — the canonical
 * mount path mapped into the worker's own root, the same mapping every
 * work-item path takes.
 *
 * Everything runs against the real routes: the session retrieve that names
 * the attached `file` resources, the file-content route that serves the
 * bytes, and the `mawt_` scope fence that admits exactly the attached
 * `file_id`s and nothing else.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { CMA_ANTHROPIC_VERSION, CMA_MANAGED_AGENTS_BETA } from '@/core/cma/compatibility.js';

const HEADERS = {
  'content-type': 'application/json',
  'anthropic-version': CMA_ANTHROPIC_VERSION,
  'anthropic-beta': CMA_MANAGED_AGENTS_BETA,
};
const API_KEY = 'test-api-key';

describe('worker file resource materialization', () => {
  let db: Database;
  let tmpDir: string;
  let workdir: string;
  let listening: { close: (cb?: () => void) => void } | undefined;
  let baseUrl: string;
  let token: string;

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-wfile-'));
    const dataDir = join(tmpDir, 'data');
    workdir = join(tmpDir, 'work');
    mkdirSync(workdir, { recursive: true });
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();

    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db.prepare(`INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', ?)`).run(
      JSON.stringify({ name: 'x', model: 'test-model' }),
    );
    db.prepare(`INSERT INTO agents (id, name, definition) VALUES ('agent_y', 'y', ?)`).run(
      JSON.stringify({ name: 'y', model: 'test-model' }),
    );

    const app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      // Auth must be on for the mawt_ scope fence to run at all — an
      // api-key-free runtime is open and admits the token unconditionally.
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

    // Two uploaded files; the session attaches one, leaves the other out.
    const attached = await post('/v1/files', { name: 'notes.txt', media_type: 'text/plain', content: 'attached bytes' });
    expect(attached.status).toBe(201);
    const unattached = await post('/v1/files', { name: 'other.txt', media_type: 'text/plain', content: 'not for you' });
    expect(unattached.status).toBe(201);
    (db as unknown as { lastFileIds: string[] }).lastFileIds = [attached.body.id, unattached.body.id];

    db.prepare(
      "INSERT INTO sessions (id, agent_id, agent_name, environment_id, resources, status) VALUES ('sess_files', 'agent_x', 'x', 'env_a', ?, 'paused')",
    ).run(JSON.stringify([{ type: 'file', file_id: attached.body.id, mount_path: '/mnt/session/uploads/notes.txt' }]));
    db.prepare(
      "INSERT INTO sessions (id, agent_id, agent_name, environment_id, resources, status) VALUES ('sess_other', 'agent_y', 'y', 'env_a', '[]', 'paused')",
    ).run();

    token = issueSessionWorkToken(db, 'sess_files', 'env_a');
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

  it('admits the attached file to a mawt_ bearer and refuses the rest', async () => {
    const [attachedId, unattachedId] = (db as unknown as { lastFileIds: string[] }).lastFileIds;
    const get = (path: string) => fetch(`${baseUrl}${path}`, {
      headers: { ...HEADERS, authorization: `Bearer ${token}` },
    });

    const ok = await get(`/v1/files/${attachedId}/content`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('attached bytes');

    // A file the session never attached refuses; so does another session's
    // token on the attached one.
    expect((await get(`/v1/files/${unattachedId}/content`)).status).toBe(401);
    const otherToken = issueSessionWorkToken(db, 'sess_other', 'env_a');
    const other = await fetch(`${baseUrl}/v1/files/${attachedId}/content`, {
      headers: { ...HEADERS, authorization: `Bearer ${otherToken}` },
    });
    expect(other.status).toBe(401);
  });

  it('worker run writes the attached file at its mount path under the workdir', async () => {
    const queue = new WorkQueue(db);
    const itemId = queue.enqueue('sess_files', 'read', { path: '/mnt/session/uploads/notes.txt' });

    const claimRes = await fetch(`${baseUrl}/v1/x/worker/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ worker_id: 'worker_spawn' }),
    });
    const handed = (await claimRes.json()) as { id: string; secret?: string };
    expect(handed.id).toBe(itemId);
    expect(handed.secret).toBeTruthy();

    const envBackup = { ...process.env };
    process.env.MANAGED_AGENTS_SESSION_ID = 'sess_files';
    process.env.MANAGED_AGENTS_WORKER_ID = 'worker_spawn';
    process.env.MANAGED_AGENTS_BASE_URL = baseUrl;
    delete process.env.MANAGED_AGENTS_ENVIRONMENT_ID;
    delete process.env.MANAGED_AGENTS_ENVIRONMENT_KEY;
    // The /v1/x/worker/* endpoints sit behind the API key; the worker carries
    // it for claim/accept/heartbeat, while file content rides on the mawt_.
    process.env.MANAGED_AGENTS_API_KEY = API_KEY;
    try {
      await workerRunCommand(
        { workdir, maxIdleMs: '500', intervalMs: '250' },
        Readable.from([JSON.stringify(handed)]),
      );
    } finally {
      process.env = envBackup;
    }

    // The attached file landed at its canonical mount path mapped under the
    // worker root, and the work item read it back through the same path.
    expect(readFileSync(join(workdir, 'mnt', 'session', 'uploads', 'notes.txt'), 'utf8')).toBe('attached bytes');
    expect(existsSync(join(workdir, 'mnt', 'session', 'uploads', 'other.txt'))).toBe(false);
    expect(queue.get(itemId)!.status).toBe('applied');
    expect(queue.get(itemId)!.result).toBe('attached bytes');
  });
});
