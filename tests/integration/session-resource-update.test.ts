/**
 * The published session-resource lifecycle verbs.
 *
 * The published contract's update verb is `POST
 * /v1/sessions/{id}/resources/{rid}` carrying `authorization_token` — the
 * runtime only had `PATCH`, so the SDK's
 * `client.beta.sessions.resources.update()` could not reach it. `POST` is now
 * the handler and `PATCH` stays mounted as a deprecated alias. Delete answers
 * the published `{id, type: "session_resource_deleted"}` tombstone instead of
 * the detached instance object.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('session resource update and delete verbs', () => {
  let db: Database;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let app: ReturnType<typeof createServer>;

  const repositoryResource = () => ({
    type: 'github_repository',
    url: 'https://github.com/example/repo',
    authorization_token: 'ghp_probe',
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-resource-update-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare(
      `INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{"sandbox_provider":"local"}')`,
    ).run();
    db.prepare(
      `INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{
         "name":"x","model":"gpt-4o-mini","instructions":"test",
         "tools":[{"type":"agent_toolset_20260401"}]
       }')`,
    ).run();

    sessionManager = new SessionManager(db);
    app = createServer({
      db,
      sessionManager,
      agents: [{ id: 'agent_x', name: 'x', model: 'gpt-4o-mini', instructions: 'test' } as any],
      skills: [],
      workspace: {
        root: tmpDir,
        dataDir: tmpDir,
        agentsDir: tmpDir,
        skillsDir: tmpDir,
        configPath: join(tmpDir, 'config.yaml'),
        target: 'local',
      },
      runtime: { models: [], sandboxProviders: ['local'], memory: 'disabled', authEnabled: false },
      reloadAgents: () => ({ agents: [], errors: [] }),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function request(path: string, method: string, body?: unknown) {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  async function post(path: string, body: unknown) {
    return request(path, 'POST', body);
  }

  async function get(path: string) {
    return request(path, 'GET');
  }

  async function sessionWithRepository() {
    const created = await post('/v1/sessions', { agent: 'agent_x', resources: [repositoryResource()] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const listed = await get(`/v1/sessions/${created.body.id}/resources`);
    const resourceId = listed.body.data[0].id as string;
    expect(resourceId).toMatch(/^sesrsc_/);
    return { sessionId: created.body.id as string, resourceId };
  }

  it('rotates a github_repository token through the published POST verb', async () => {
    const { sessionId, resourceId } = await sessionWithRepository();

    const updated = await post(`/v1/sessions/${sessionId}/resources/${resourceId}`, {
      authorization_token: 'ghp_rotated',
    });

    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.id).toBe(resourceId);
    expect(updated.body.type).toBe('github_repository');
    expect(updated.body.authorization_token).not.toBe('ghp_rotated');
  });

  it('keeps PATCH as a working deprecated alias of the same handler', async () => {
    const { sessionId, resourceId } = await sessionWithRepository();

    const updated = await request(`/v1/sessions/${sessionId}/resources/${resourceId}`, 'PATCH', {
      authorization_token: 'ghp_rotated_via_patch',
    });

    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.id).toBe(resourceId);
  });

  it('refuses an update on a resource type that cannot rotate', async () => {
    const uploaded = await post('/v1/files', { name: 'note.txt', media_type: 'text/plain', content: 'hi' });
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    const created = await post('/v1/sessions', { agent: 'agent_x' });
    const attached = await post(`/v1/sessions/${created.body.id}/resources`, {
      type: 'file',
      file_id: uploaded.body.id,
    });
    expect(attached.status, JSON.stringify(attached.body)).toBe(201);

    const updated = await post(`/v1/sessions/${created.body.id}/resources/${attached.body.id}`, {
      authorization_token: 'ghp_anything',
    });

    expect(updated.status).toBe(400);
    expect(updated.body.error.message).toContain('only github_repository resources support updates');
  });

  it('refuses update fields other than authorization_token', async () => {
    const { sessionId, resourceId } = await sessionWithRepository();

    const updated = await post(`/v1/sessions/${sessionId}/resources/${resourceId}`, {
      authorization_token: 'ghp_rotated',
      mount_path: '/elsewhere',
    });

    expect(updated.status).toBe(400);
    expect(updated.body.error.message).toContain('mount_path');
  });

  it('answers the published tombstone on delete and 404 on a second delete', async () => {
    const { sessionId, resourceId } = await sessionWithRepository();

    const deleted = await request(`/v1/sessions/${sessionId}/resources/${resourceId}`, 'DELETE');
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ id: resourceId, type: 'session_resource_deleted' });

    const again = await request(`/v1/sessions/${sessionId}/resources/${resourceId}`, 'DELETE');
    expect(again.status).toBe(404);
    const retrieved = await get(`/v1/sessions/${sessionId}/resources/${resourceId}`);
    expect(retrieved.status).toBe(404);
  });
});
