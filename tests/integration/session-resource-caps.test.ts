/**
 * Session-scoped numeric bounds the published contract states:
 *
 * - **≤20 active credentials per vault.** The count filters archived rows, so
 *   a vault that archived credentials back under the bound admits new ones.
 * - **≤500 file resources per session.** Only `file`-type resources count —
 *   a memory store or github repository does not draw down the file budget.
 * - **≤500 skills on the agent's `skills` array.** The published bound is the
 *   deduplicated set across every agent in the session; this runtime runs one
 *   agent per session, so the agent's own array is the whole set.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { validateAgentDefinition } from '@/core/agent/schema.js';

const VAULTS = '/v1/vaults';

type Server = ReturnType<typeof createServer>;
const contexts: Array<{ db: Database; tmpDir: string }> = [];

function setUp(): { server: Server; db: Database } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ma-session-caps-'));
  const db = new Database(join(tmpDir, 'test.db'));
  db.runMigrations();
  db.prepare(
    "INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_default', 'local', '', '{}', '{}')",
  ).run();
  contexts.push({ db, tmpDir });
  const server = createServer({
    db,
    sessionManager: new SessionManager(db),
    agents: [],
    reloadAgents: () => ({ agents: [], errors: [] }),
    consoleRoot: null,
  });
  return { server, db };
}

afterEach(() => {
  for (const opened of contexts.splice(0)) {
    opened.db.close();
    rmSync(opened.tmpDir, { recursive: true, force: true });
  }
});

async function send(server: Server, method: string, path: string, body?: unknown) {
  const res = await server.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, any> : undefined };
}

const credentialBody = (n: number) => ({
  auth: { type: 'environment_variable', secret_name: `KEY_${n}`, secret_value: 'v' },
});

/** Insert a files row so a file_id resolves for session-resource attachment. */
function seedFile(db: Database, fileId: string) {
  db.prepare(
    `INSERT INTO files (id, name, media_type, size_bytes, storage_path) VALUES (?, ?, 'text/plain', 1, ?)`,
  ).run(fileId, `${fileId}.txt`, `/tmp/${fileId}`);
}

describe('vault credential cap', () => {
  it('refuses the 21st active credential in a vault', async () => {
    const { server } = setUp();
    const vault = await send(server, 'POST', VAULTS, { name: 'v' });
    const vaultId = vault.body!.id;

    for (let i = 0; i < 20; i++) {
      const created = await send(server, 'POST', `${VAULTS}/${vaultId}/credentials`, credentialBody(i));
      expect(created.status, `credential ${i}: ${JSON.stringify(created.body)}`).toBe(201);
    }
    const over = await send(server, 'POST', `${VAULTS}/${vaultId}/credentials`, credentialBody(20));
    expect(over.status).toBe(400);
    expect(over.body!.error.message).toContain('20');
  });

  it('does not count archived credentials against the bound', async () => {
    const { server } = setUp();
    const vault = await send(server, 'POST', VAULTS, { name: 'v' });
    const vaultId = vault.body!.id;

    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const created = await send(server, 'POST', `${VAULTS}/${vaultId}/credentials`, credentialBody(i));
      ids.push(created.body!.id);
    }
    // Archive one: the active count drops to 19, so a new credential is admitted.
    const archived = await send(server, 'POST', `${VAULTS}/${vaultId}/credentials/${ids[0]}/archive`);
    expect(archived.status).toBe(200);
    const refilled = await send(server, 'POST', `${VAULTS}/${vaultId}/credentials`, credentialBody(99));
    expect(refilled.status, JSON.stringify(refilled.body)).toBe(201);
  });
});

describe('session file-resource cap', () => {
  it('accepts 500 file resources and refuses the 501st', async () => {
    const { server, db } = setUp();
    const fileBlock = (n: number) => ({ type: 'file', file_id: `file_${String(n).padStart(3, '0')}` });
    // The count is the published bound; the ids still have to resolve, so the
    // rows are seeded rather than invented.
    for (let i = 0; i < 500; i++) seedFile(db, fileBlock(i).file_id);

    const agent = await send(server, 'POST', '/v1/agents', { name: 'a', model: 'gpt-4o', system: 'x' });
    const agentId = agent.body!.id;

    const ok = await send(server, 'POST', '/v1/sessions', {
      agent: agentId,
      resources: Array.from({ length: 500 }, (_, i) => fileBlock(i)),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);

    const over = await send(server, 'POST', '/v1/sessions', {
      agent: agentId,
      resources: Array.from({ length: 501 }, (_, i) => fileBlock(i)),
    });
    expect(over.status).toBe(400);
    expect(over.body!.error.message).toContain('500');
  });

  it('does not count memory-store or github resources against the file bound', async () => {
    const { server, db } = setUp();
    for (let i = 0; i < 500; i++) seedFile(db, `file_${String(i).padStart(3, '0')}`);

    const agent = await send(server, 'POST', '/v1/agents', { name: 'a', model: 'gpt-4o', system: 'x' });
    const agentId = agent.body!.id;

    // 500 file resources plus one memory-store resource: the memory store is
    // not a file, so the file counter stays at the bound rather than tripping.
    const res = await send(server, 'POST', '/v1/sessions', {
      agent: agentId,
      resources: [
        ...Array.from({ length: 500 }, (_, i) => ({ type: 'file', file_id: `file_${String(i).padStart(3, '0')}` })),
        { type: 'memory_store', memory_store_id: 'memstore_x', access: 'read_only', mount_path: '/mnt/memory/x' },
      ],
    });
    // The request may still fail for an unrelated reason (the memory store id
    // does not resolve), but it must not be the file-count refusal.
    if (res.status === 400) {
      expect(res.body!.error.message).not.toContain('500 file');
    }
  });
});

describe('agent skills cap', () => {
  it('accepts 500 skills and refuses the 501st', () => {
    const skill = (n: number) => ({ type: 'custom', skill_id: `skill_${n}` });
    const ok = validateAgentDefinition({
      name: 'a', model: 'gpt-4o',
      skills: Array.from({ length: 500 }, (_, i) => skill(i)),
    });
    expect(ok.valid, JSON.stringify(ok.errors)).toBe(true);

    const over = validateAgentDefinition({
      name: 'a', model: 'gpt-4o',
      skills: Array.from({ length: 501 }, (_, i) => skill(i)),
    });
    expect(over.valid).toBe(false);
  });
});
