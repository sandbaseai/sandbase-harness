/**
 * Integration test: the client SDK against a real in-process server (D1).
 *
 * Starts the Hono app via @hono/node-server on a random port and drives it
 * through ManagedAgentsClient (create/list/get/sendMessage/events/tail/stop).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager, type SessionExecutor } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { ManagedAgentsClient } from '@/sdk/client.js';

describe('Client SDK', () => {
  let db: Database;
  let tmpDir: string;
  let dataDir: string;
  let client: ManagedAgentsClient;
  // Delays opening an SSE request, so a test can reproduce a slow runner where
  // the stream is not yet subscribed when a message is sent. 0 keeps every
  // other case on the normal path.
  let streamOpenDelayMs = 0;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-sdk-'));
    dataDir = join(tmpDir, '.managed-agents');
    mkdirSync(dataDir, { recursive: true });
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_echo',
      'echo',
      JSON.stringify({ name: 'echo', model: 'm', system: 'p' }),
    );

    const sessionManager = new SessionManager(db);
    // Executor that emits one agent.message then lets the session go idle.
    // It mirrors DefaultStrategy: the reply is appended to the event log and
    // then broadcast. A reply that existed only as a transient broadcast would
    // never reach a tail() client at all — the SSE route forwards transient
    // (seq 0) events as opted-in preview frames only — so the fixture must
    // persist it to exercise the real delivery path.
    const executor: SessionExecutor = {
      // eslint-disable-next-line require-yield
      async *execute(session, _event, options) {
        const reply = sessionManager.getEventLogger().append(session.id, {
          type: 'agent.message',
          content: [{ type: 'text', text: 'hello from agent' }],
        });
        options?.broadcast?.(reply);
        return;
      },
      async cleanupSession() {},
    };
    sessionManager.setExecutor(executor);

    const app = createServer({
      db,
      sessionManager,
      agents: [{ name: 'echo', model: 'm', system: 'p' }],
      reloadAgents: () => ({ agents: [], errors: [] }),
      workspace: {
        root: tmpDir,
        dataDir,
        agentsDir: join(tmpDir, 'agents'),
        skillsDir: join(tmpDir, 'skills'),
        configPath: join(tmpDir, 'managed-agents.config.yaml'),
        target: 'local',
      },
    });

    client = new ManagedAgentsClient({
      baseUrl: 'http://managed-agents.test',
      // async so the signature matches `typeof fetch`: Hono's request() can
      // return a Response synchronously, which is not assignable on its own.
      fetch: async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.toString());
        if (streamOpenDelayMs > 0 && url.pathname.endsWith('/events/stream')) {
          await new Promise((r) => setTimeout(r, streamOpenDelayMs));
        }
        return app.request(`${url.pathname}${url.search}`, init);
      },
    });
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists agents', async () => {
    const { data } = await client.agents.list();
    expect(data.map((a) => a.name)).toContain('echo');
  });

  it('creates, versions, and archives agents', async () => {
    const created = await client.agents.create({
      name: 'sdk-agent',
      model: 'm',
      system: 'hello from sdk',
    });
    expect(created.id).toMatch(/^agent_/);

    const updated = await client.agents.update(created.id, {
      system: 'updated from sdk',
      expected_version: created.version,
    });
    expect(updated.version).toBe(created.version + 1);

    const versions = await client.agents.versions(created.id);
    expect(versions.data.length).toBeGreaterThanOrEqual(2);

    const archived = await client.agents.archive(created.id);
    expect(archived.status).toBe('archived');
  });

  it('creates and gets a session', async () => {
    const s = await client.sessions.create({ agent: 'agent_echo' });
    expect(s.id).toMatch(/^sess_/);
    const got = await client.sessions.get(s.id);
    expect(got.id).toBe(s.id);
  });

  it('sends a message and reads the persisted event log back', async () => {
    const s = await client.sessions.create({ agent: 'agent_echo' });
    const ack = await client.sessions.sendMessage(s.id, 'hi there');
    expect(ack.accepted).toBe(true);

    await new Promise((r) => setTimeout(r, 60));
    const { data } = await client.sessions.events(s.id);
    const types = data.map((e) => e.type);
    // The user turn is persisted, so it is read back from the log here; the
    // agent reply is asserted through the live stream in the tail() case below.
    expect(types).toContain('user.message');
  });

  it('sends a message through the convenience endpoint without streaming', async () => {
    const s = await client.sessions.create({ agent: 'agent_echo' });
    const ack = await client.sessions.message(s.id, 'hi via messages', { stream: false });
    expect(ack.accepted).toBe(true);

    await new Promise((r) => setTimeout(r, 60));
    const { data } = await client.sessions.events(s.id);
    expect(data.map((e) => e.type)).toContain('user.message');
  });

  it('streams a message through the convenience endpoint', async () => {
    const s = await client.sessions.create({ agent: 'agent_echo' });
    const received: string[] = [];

    for await (const ev of client.sessions.message(s.id, 'go via messages')) {
      received.push(ev.type);
      if (ev.type === 'session.status_idle') break;
    }

    expect(received).toContain('user.message');
    expect(received).toContain('agent.message');
    expect(received).toContain('session.status_idle');
  });

  it('tails the live stream and receives the agent reply', async () => {
    // A fresh tail is opened by an asynchronous request, so a fixed "give the
    // stream a moment" sleep cannot prove the server has subscribed yet. Force
    // that slow path here: the SSE request is not even dispatched until long
    // after the old 50 ms sleep would have elapsed and sent the message.
    streamOpenDelayMs = 250;
    try {
      const s = await client.sessions.create({ agent: 'agent_echo' });

      // Readiness anchor. The SSE route subscribes before it replays the stored
      // log, so a persisted event that already exists can only reach this stream
      // once the server-side subscription is live. `user.interrupt` appends and
      // broadcasts without starting a turn, which keeps the anchor inert.
      await client.sessions.interrupt(s.id);

      const received: string[] = [];
      const ready = deferred();
      const tailPromise = (async () => {
        for await (const ev of client.sessions.tail(s.id)) {
          if (ev.type === 'user.interrupt') {
            ready.resolve();
            continue;
          }
          received.push(ev.type);
          if (ev.type === 'session.status_idle') return;
        }
      })();

      // Send only once the subscription is proven, never on a timer.
      await withDeadline(ready.promise, 2000, 'the live-stream subscription to open');
      await client.sessions.sendMessage(s.id, 'go');
      await withDeadline(tailPromise, 2000, 'the tailed turn to reach session.status_idle');

      expect(received).toContain('user.message');
      expect(received).toContain('agent.message');
      expect(received).toContain('session.status_idle');
    } finally {
      streamOpenDelayMs = 0;
    }
  });

  it('stops a session', async () => {
    const s = await client.sessions.create({ agent: 'agent_echo' });
    const res = await client.sessions.stop(s.id);
    expect(res.status).toBe('terminated');
  });

  it('manages files and session artifacts', async () => {
    const file = await client.files.create({ name: 'notes.txt', content: 'hello file' });
    expect(file.id).toMatch(/^file_/);
    await expect(client.files.text(file.id)).resolves.toBe('hello file');
    const files = await client.files.list();
    expect(files.data.map((item) => item.id)).toContain(file.id);

    const s = await client.sessions.create({ agent: 'agent_echo' });
    const artifact = await client.sessions.createArtifact(s.id, {
      path: '/artifacts/report.txt',
      content: 'hello artifact',
    });
    expect(artifact.artifact_path).toBe('/artifacts/report.txt');
    await expect(client.sessions.artifactText(s.id, artifact.id)).resolves.toBe('hello artifact');
    const artifacts = await client.sessions.artifacts(s.id);
    expect(artifacts.data.map((item) => item.id)).toContain(artifact.id);

    const archived = await client.files.delete(file.id);
    expect(archived.status).toBe('archived');
  });

  it('creates and deletes API keys', async () => {
    const key = await client.apiKeys.create({ name: 'SDK key' });
    expect(key.secret_key).toMatch(/^ma_/);
    const keys = await client.apiKeys.list();
    expect(keys.data.map((item) => item.id)).toContain(key.id);
    await expect(client.apiKeys.delete(key.id)).resolves.toMatchObject({ id: key.id, type: 'api_key_deleted' });
  });

  it('reads metrics helpers', async () => {
    await expect(client.metrics.prometheus()).resolves.toContain('metrics');
    const summary = await client.metrics.summary();
    expect(summary).toMatchObject({
      type: 'metrics_summary',
      sessions: expect.objectContaining({ total: expect.any(Number) }),
    });
  });

  it('throws ManagedAgentsApiError on 404', async () => {
    await expect(client.sessions.get('sess_nope')).rejects.toThrow(/API error 404/);
  });
});

/**
 * Reject once `ms` elapses without `work` settling, so a stream that never
 * delivers its terminal event names the condition it waited for instead of
 * surfacing as a generic test timeout on a later assertion.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
