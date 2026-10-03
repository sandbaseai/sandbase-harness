/**
/** Integration coverage for the permanent session delete boundary. */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import type { Session, SessionEvent } from '@/types/session.js';
import type { UserEvent } from '@/types/cma-protocol.js';

describe('Session deletion and the retained event log', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function setUp(): ReturnType<typeof createServer> {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-delete-log-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_delete',
      'delete',
      JSON.stringify({ name: 'delete', model: 'gpt-4o', system: 'p' }),
    );
    const sessionManager = new SessionManager(db, undefined, 'pi', undefined, (engine) => engine === 'builtin' || engine === 'pi');
    sessionManager.setExecutor({
      async *execute(session: Session, _event: UserEvent): AsyncIterable<SessionEvent> {
        yield {
          id: 'sevt_fake_agent_message',
          sessionId: session.id,
          seq: 0,
          type: 'agent.message',
          content: [{ type: 'text', text: 'echo' }],
          createdAt: new Date(),
        };
      },
    });
    return createServer({ db, sessionManager, agents: [], reloadAgents: () => ({ agents: [], errors: [] }), consoleRoot: null });
  }

  async function sessionWithEvents(server: ReturnType<typeof createServer>, count: number): Promise<string> {
    const created = await server.request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'agent_delete' }),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    if (count > 0) {
      const appended = await server.request(`/v1/sessions/${id}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: Array.from({ length: count }, () => ({ type: 'user.interrupt' })) }),
      });
      expect(appended.status).toBe(200);
    }
    return id;
  }

  async function events(server: ReturnType<typeof createServer>, id: string, query = ''): Promise<Response> {
    const res = await server.request(`/v1/sessions/${id}/events${query}`);
    return res;
  }

  it('deletes the session row and all event history', async () => {
    const server = setUp();
    const id = await sessionWithEvents(server, 2);
    const before = await events(server, id);
    expect(before.status).toBe(200);
    const beforeBody = await before.json() as { data: Array<{ type: string }> };
    expect(beforeBody.data.map((event) => event.type)).toEqual(['user.interrupt', 'user.interrupt']);

    const del = await server.request(`/v1/sessions/${id}`, { method: 'DELETE' });

    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ id, type: 'session_deleted' });
    expect((await server.request(`/v1/sessions/${id}`)).status).toBe(404);
    expect((await events(server, id)).status).toBe(404);
  });

  it('refuses deletion while a session is running', async () => {
    const server = setUp();
    const id = await sessionWithEvents(server, 0);
    db!.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(id);

    const response = await server.request(`/v1/sessions/${id}`, { method: 'DELETE' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'session_running' } });
  });
});
