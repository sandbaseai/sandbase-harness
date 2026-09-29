/**
 * Integration test: the documented `managed-agents session ...` group works.
 *
 * `docs/api-matrix.md:84` documents the group as covered — "Create, message, tail,
 * inspect, and logs" — and `src/cli/session-commands.ts` implements all five. The module
 * was imported by nothing, so every one of them answered `unknown command 'session'`.
 *
 * Registering them is the small half. Each command is driven against the **real** routes
 * over a real HTTP listener and a real SQLite file, because a command can be registered
 * and still be wrong about the wire contract — which is exactly what `worker poll` was
 * (#459: it never sent the `worker_id` its completion route requires). A fetch stub would
 * have agreed with that bug.
 *
 * Driving them this way already caught one: `session create --agent <name>` was refused
 * with `400 invalid_agent_ref`, because a session's `agent` field identifies an agent by
 * **id**. See the last case.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { serve } from '@hono/node-server';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import {
  sessionCreateCommand,
  sessionInspectCommand,
  sessionLogsCommand,
  sessionMessageCommand,
  sessionTailCommand,
} from '@/cli/session-commands.js';

type RealServer = { close: (cb?: () => void) => void; closeAllConnections?: () => void };

/** Run `fn` with stdout and console.log captured, so the CLI's output is assertable. */
async function capture<T>(fn: () => Promise<T>): Promise<{ stdout: string; log: string[] }> {
  const log: string[] = [];
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    log.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } finally {
    logSpy.mockRestore();
    writeSpy.mockRestore();
  }
  return { stdout: chunks.join(''), log };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for the expected CLI output');
}

describe('session CLI group', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let listening: RealServer | undefined;

  afterEach(async () => {
    if (listening) {
      const server = listening;
      listening = undefined;
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    db?.close();
    db = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  /** A real runtime on a real port, with one agent and one environment to run in. */
  async function startRuntime() {
    const dir = mkdtempSync(join(tmpdir(), 'ma-session-cli-'));
    tmpDir = dir;
    db = new Database(join(dir, 'test.db'));
    db.runMigrations();
    db.prepare(
      "INSERT INTO environments (id, name, description, config, metadata) VALUES ('local', 'local', '', '{}', '{}')",
    ).run();

    const app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
    });

    // The agent is created through the API rather than inserted, so the CLI's own agent
    // lookup is exercised against a definition the runtime produced.
    const created = await app.request('/v1/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'assistant', model: 'gpt-4o', system: 'You are a test agent.' }),
    });
    // Read the body once: `Response` bodies are single-use, so reading it for a failure
    // message and then parsing it would throw instead of reporting the real status.
    const createdText = await created.text();
    expect(created.status, createdText).toBe(201);
    const agentId = (JSON.parse(createdText) as { id: string }).id;

    const port = await new Promise<number>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        listening = server as unknown as RealServer;
        resolve(info.port);
      });
    });

    return { app, port, agentId, env: { port: String(port), environment: 'local' } };
  }

  async function seedEvent(app: ReturnType<typeof createServer>, sessionId: string, text: string) {
    // `POST /v1/sessions/{id}/events` takes a batch (`events` must be an array), not a
    // single event.
    const res = await app.request(`/v1/sessions/${sessionId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ type: 'user.message', content: [{ type: 'text', text }] }] }),
    });
    const body = await res.text();
    expect(res.status, body).toBeLessThan(300);
  }

  async function createSession(
    app: ReturnType<typeof createServer>,
    agentId: string,
  ): Promise<string> {
    const res = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: agentId, environment_id: 'local' }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(201);
    return (JSON.parse(text) as { id: string }).id;
  }

  it('creates a session through the real route and prints its id', async () => {
    const { env, agentId } = await startRuntime();

    const { log } = await capture(() => sessionCreateCommand({ ...env, agent: agentId }));

    const printed = log.join('\n').trim();
    expect(printed).toMatch(/^sess_/);
    // The printed id is the session that actually exists, not merely a well-formed one.
    expect(db!.prepare('SELECT agent_name FROM sessions WHERE id = ?').get(printed)).toMatchObject({
      agent_name: 'assistant',
    });
  });

  it('defaults to the first loaded agent when --agent is omitted', async () => {
    const { port } = await startRuntime();

    const { log } = await capture(() =>
      sessionCreateCommand({ port: String(port), environment: 'local' }));

    const printed = log.join('\n').trim();
    expect(printed).toMatch(/^sess_/);
    expect(db!.prepare('SELECT agent_name FROM sessions WHERE id = ?').get(printed)).toMatchObject({
      agent_name: 'assistant',
    });
  });

  it('sends a message without streaming and records the user message', async () => {
    const { app, env, agentId } = await startRuntime();
    const sessionId = await createSession(app, agentId);

    const { log } = await capture(() =>
      sessionMessageCommand(sessionId, { ...env, message: 'hello from the CLI', stream: false }));

    expect(log.join('\n')).toContain('accepted');
    // `stream: false` means the runtime acknowledged the message, so the event must be in
    // the log — an acknowledgment with nothing persisted would satisfy the output alone.
    const events = await app.request(`/v1/sessions/${sessionId}/events`);
    const body = await events.json() as { data: Array<{ type: string; content?: unknown }> };
    const userMessage = body.data.find((event) => event.type === 'user.message');
    expect(userMessage).toBeDefined();
    expect(JSON.stringify(userMessage!.content)).toContain('hello from the CLI');
  });

  it("inspects a session, printing the runtime's own values", async () => {
    const { app, env, agentId } = await startRuntime();
    const sessionId = await createSession(app, agentId);
    await seedEvent(app, sessionId, 'first');
    await seedEvent(app, sessionId, 'second');

    const human = await capture(() => sessionInspectCommand(sessionId, env));
    const text = human.log.join('\n');
    expect(text).toContain(sessionId);
    expect(text).toContain('assistant');
    // The count is read from the runtime, so it is asserted as a number and a lower bound
    // rather than against a guessed literal that would encode today's event shape.
    const counted = Number(/events: (\d+)/.exec(text)?.[1]);
    expect(Number.isInteger(counted)).toBe(true);
    expect(counted).toBeGreaterThanOrEqual(2);

    const json = await capture(() => sessionInspectCommand(sessionId, { ...env, json: true }));
    const parsed = JSON.parse(json.log.join('\n')) as {
      session: { id: string; agent: { name: string } };
      events: Array<{ type: string }>;
    };
    expect(parsed.session.id).toBe(sessionId);
    expect(parsed.session.agent.name).toBe('assistant');
    expect(parsed.events.length).toBeGreaterThanOrEqual(2);
  });

  it('prints every recorded event as one JSON line per event', async () => {
    const { app, env, agentId } = await startRuntime();
    const sessionId = await createSession(app, agentId);
    await seedEvent(app, sessionId, 'logged one');
    await seedEvent(app, sessionId, 'logged two');

    const { log } = await capture(() => sessionLogsCommand(sessionId, env));

    // Every line must parse on its own: the command is documented as a log dump, and one
    // unparseable line would make it unusable as one.
    const parsed = log.map((line) => JSON.parse(line) as { type: string; content?: unknown });
    expect(parsed.filter((event) => event.type === 'user.message').length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(parsed)).toContain('logged one');
    expect(JSON.stringify(parsed)).toContain('logged two');
  });

  it('tails the real event stream and reports the events it receives', async () => {
    // `tail` is documented as a stream that does not exit on its own, so this test has to
    // end it the way nothing else can: by closing the connection. The command reads the
    // recorded log first — a stream opened without a cursor carries live events only — and
    // then subscribes from the last sequence it printed, so a seeded event must appear
    // without a second write and an event written afterwards must still be followed.
    //
    // What is asserted is the printed output. What is deliberately NOT asserted is how the
    // forced close surfaces: it reaches the SDK as a transport `TypeError: terminated`,
    // but a real client ends a tail with SIGINT, which never resumes the generator. Pinning
    // that error would pin the transport, not the behavior.
    const { app, env, agentId } = await startRuntime();
    const sessionId = await createSession(app, agentId);
    await seedEvent(app, sessionId, 'tail me');

    const log: string[] = [];
    const chunks: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      log.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    const tailing = sessionTailCommand(sessionId, env).catch(() => {
      // The forced close is a transport event, not a behavior under test.
    });

    try {
      await waitFor(() => [...log, ...chunks].join('\n').includes('tail me'));
      // The follow half: this write happens after the command read the log, so it can only
      // arrive through the subscription the command resumed.
      await seedEvent(app, sessionId, 'followed live');
      await waitFor(() => [...log, ...chunks].join('\n').includes('followed live'));
    } finally {
      listening!.closeAllConnections?.();
      await tailing;
      logSpy.mockRestore();
      writeSpy.mockRestore();
    }

    // The events arrived on the real SSE route and were rendered by the command's own
    // printer — `user.message` goes through the JSON branch, so the payload is visible.
    const printed = [...log, ...chunks].join('\n');
    expect(printed).toContain('tail me');
    // Exactly once: the log read prints the recorded event and the subscription resumes
    // after it. A subscription that replayed the whole log as well would print it twice,
    // so this is what pins "read the log, then follow from what it printed" rather than
    // "follow and let the server replay".
    expect(printed.match(/tail me/g)).toHaveLength(1);
    expect(printed).toContain('followed live');
    expect(printed).toContain('user.message');
  });

  it('refuses an agent name, because a session\'s `agent` field takes an id', async () => {
    // The boundary this pins: the route requires an `agent_...` id
    // (`src/api/routes/sessions.ts:84`), and every published example passes
    // `$AGENT_ID`, so `--agent` is an id and not a name. Recording the refusal means a
    // later change that tries to accept a name has to confront it — and it cannot simply
    // resolve one, because agent names are not unique (migration M013 rebuilds `agents`
    // without the `UNIQUE` that `name` originally carried).
    const { env } = await startRuntime();

    // Asserted through the thrown error's own fields rather than `toMatchObject`: an
    // `Error`'s `message` is non-enumerable, so a matcher silently ignores it.
    const refusal = await capture(() => sessionCreateCommand({ ...env, agent: 'assistant' })).then(
      () => undefined,
      (error: { status?: number; message?: string }) => error,
    );
    expect(refusal).toBeDefined();
    expect(refusal!.status).toBe(400);
    expect(refusal!.message).toContain('agent must be a standard agent id');
    // The published envelope carries a machine-readable `code` (`invalid_agent_ref`) and
    // `type` here, but the SDK keeps only `error.message`
    // (`src/sdk/client.ts:327-332`), so a caller cannot branch on the code — it has to
    // match the human text. Asserted as absent so that fixing the SDK error surface shows
    // up as a failing test rather than passing silently.
    expect(refusal!.message).not.toContain('invalid_agent_ref');
  });
});
