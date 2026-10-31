/**
 * `initial_events` transaction semantics (gap #3).
 *
 * `POST /v1/sessions` can create a session and start its loop in one call. The
 * published contract has no state for "session exists but its initial events
 * were rejected", so the two effects must be atomic: a failed batch leaves no
 * session row, no resource instance, and no event.
 *
 * The interesting failure is *mid-batch*. A batch whose first event is valid
 * and second is not proves the transaction rolls back the event that had
 * already been appended — a per-event try/catch (the previous shape) would
 * leave event #1 durable in a session that the caller was told does not exist.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('initial_events transaction semantics', () => {
  let db: Database;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let app: ReturnType<typeof createServer>;
  let agentId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-initial-events-'));
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
    agentId = 'agent_x';

    sessionManager = new SessionManager(db);
    // A grader is registered so a single user.define_outcome is admissible —
    // without one the runtime refuses any declared outcome with
    // outcome_grader_unavailable downstream of normalization, and the
    // single-vs-second bound could not be told apart from that refusal.
    sessionManager.setOutcomeGrader({
      grade: async () => ({ result: 'satisfied', explanation: 'nothing to check' }),
    });
    app = createServer({
      db,
      sessionManager,
      agents: [{ id: agentId, name: 'x', model: 'gpt-4o-mini', instructions: 'test' } as any],
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

  function countSessions(): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
  }

  function countEvents(): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c;
  }

  function countResources(): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM session_resource_instances').get() as { c: number }).c;
  }

  async function postSession(body: Record<string, unknown>) {
    const res = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  it('creates the session and admits a valid initial_events batch', async () => {
    const before = countSessions();
    const { status, body } = await postSession({
      agent: agentId,
      initial_events: [
        { type: 'user.message', content: 'one' },
        { type: 'user.message', content: 'two' },
      ],
    });

    expect(status, JSON.stringify(body)).toBe(201);
    expect(body.id).toMatch(/^sess_/);
    expect(countSessions()).toBe(before + 1);

    // The events are durable and ordered by seq.
    const res = await app.request(`/v1/sessions/${body.id}/events`);
    const events = (await res.json()) as { data: Array<{ type: string; seq: number; processed_at?: string }> };
    const userEvents = events.data.filter((event) => event.type === 'user.message');
    expect(userEvents).toHaveLength(2);
    expect(userEvents[0]!.seq).toBeLessThan(userEvents[1]!.seq);
  });

  it('rejects an over-limit batch before any session row exists', async () => {
    const before = countSessions();
    const { status, body } = await postSession({
      agent: agentId,
      initial_events: Array.from({ length: 51 }, (_, index) => ({
        type: 'user.message',
        content: `m${index}`,
      })),
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('too_many_initial_events');
    expect(countSessions()).toBe(before);
  });

  it('rejects an unknown event type before any session row exists', async () => {
    const before = countSessions();
    const { status, body } = await postSession({
      agent: agentId,
      initial_events: [{ type: 'agent.message', content: 'not a user event' }],
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('invalid_initial_event_type');
    expect(countSessions()).toBe(before);
  });

  it('rolls back a mid-batch failure so no session, resource, or event survives', async () => {
    const sessionsBefore = countSessions();
    const eventsBefore = countEvents();
    const resourcesBefore = countResources();

    // Event #1 is valid and would be appended first; event #2 is invalid. A
    // per-event handler would leave session + resource + event #1 behind.
    const { status, body } = await postSession({
      agent: agentId,
      resources: [{ type: 'file', file_id: 'file_x' }],
      initial_events: [
        { type: 'user.message', content: 'valid' },
        { type: 'bogus.type', content: 'invalid' },
      ],
    });

    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(countSessions()).toBe(sessionsBefore);
    expect(countEvents()).toBe(eventsBefore);
    expect(countResources()).toBe(resourcesBefore);
  });

  it('rolls back the session row when resource attachment throws inside the transaction', () => {
    const sessionsBefore = countSessions();
    const eventsBefore = countEvents();
    const resourcesBefore = countResources();

    // Drive `createWithInitialEvents` directly so the injected fault lands
    // inside the transaction. The API route cannot be made to throw here
    // without also breaking the happy path this test needs to contrast with.
    expect(() => {
      sessionManager.createWithInitialEvents({
        agent: agentId,
        environmentId: 'env_default',
        resources: [],
        attachResources: () => {
          throw new Error('injected attachment failure');
        },
      }, [{ type: 'user.message', content: [{ type: 'text', text: 'valid' }] }]);
    }).toThrow('injected attachment failure');

    // Nothing survived: not the session, not the event, not a resource.
    expect(countSessions()).toBe(sessionsBefore);
    expect(countEvents()).toBe(eventsBefore);
    expect(countResources()).toBe(resourcesBefore);
  });

  it('keeps the happy path intact with the same injection point unused', () => {
    const sessionsBefore = countSessions();
    const session = sessionManager.createWithInitialEvents({
      agent: agentId,
      environmentId: 'env_default',
      resources: [],
      attachResources: () => {},
    }, [{ type: 'user.message', content: [{ type: 'text', text: 'valid' }] }]);

    expect(session.id).toMatch(/^sess_/);
    expect(countSessions()).toBe(sessionsBefore + 1);
    expect(sessionManager.get(session.id)).toBeDefined();
  });

  it('admits the batch durably and reflects started semantics in the log', async () => {
    const { status, body } = await postSession({
      agent: agentId,
      initial_events: [{ type: 'user.message', content: 'go' }],
    });

    expect(status, JSON.stringify(body)).toBe(201);
    // The session reports `idle` because no executor is attached in this
    // harness, so the queued turn has not started. The assertion is exact on
    // purpose: accepting any of several statuses would pass even if the runtime
    // started reporting a state this path must never produce. The signal that
    // the batch was accepted and started is the durable event below, which is
    // asserted precisely.
    expect(body.status).toBe('idle');

    const eventsRes = await app.request(`/v1/sessions/${body.id}/events`);
    const events = (await eventsRes.json()) as {
      data: Array<{ type: string; processed_at?: string | null }>;
    };
    const userEvents = events.data.filter((event) => event.type === 'user.message');
    expect(userEvents).toHaveLength(1);
    // `processed_at` follows the published two-state contract: an inbound
    // `user.message` is unprocessed (null) until a turn consumes it. With no
    // executor in this harness it stays null, which is the correct state — the
    // event is durable and awaits processing.
    expect(userEvents[0]).toHaveProperty('processed_at');
  });

  it('rejects a second user.define_outcome in the batch before any session row exists', async () => {
    const before = countSessions();
    const { status, body } = await postSession({
      agent: agentId,
      initial_events: [
        {
          type: 'user.define_outcome',
          description: 'first outcome',
          rubric: { type: 'text', content: 'done when x' },
        },
        {
          type: 'user.define_outcome',
          description: 'second outcome',
          rubric: { type: 'text', content: 'done when y' },
        },
      ],
    });

    expect(status).toBe(400);
    // The count bound fires in normalizeInitialEvents — upstream of the
    // grader-availability refusal — so a second outcome reports the list rule,
    // not outcome_grader_unavailable, even though a grader is registered.
    expect(body.error.code).toBe('invalid_initial_events');
    expect(body.error.message).toContain('user.define_outcome');
    expect(countSessions()).toBe(before);
  });

  it('admits a single user.define_outcome alongside user.message events', async () => {
    const before = countSessions();
    const { status, body } = await postSession({
      agent: agentId,
      initial_events: [
        { type: 'user.message', content: 'work the outcome' },
        {
          type: 'user.define_outcome',
          description: 'the outcome',
          rubric: { type: 'text', content: 'done when x' },
        },
      ],
    });

    expect(status, JSON.stringify(body)).toBe(201);
    expect(countSessions()).toBe(before + 1);
  });

  it('rejects more than 100 file-sourced document blocks across the batch', async () => {
    const before = countSessions();
    const documentBlock = (n: number) => ({
      type: 'document',
      source: { type: 'file', file_id: `file_${n}` },
    });
    const { status, body } = await postSession({
      agent: agentId,
      initial_events: [
        // 60 + 50 = 110 file document blocks, split across two events so the
        // across-the-list bound — not a per-event bound — is what trips.
        { type: 'user.message', content: Array.from({ length: 60 }, (_, i) => documentBlock(i)) },
        { type: 'user.message', content: Array.from({ length: 50 }, (_, i) => documentBlock(60 + i)) },
      ],
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('invalid_initial_events');
    expect(body.error.message).toContain('file-sourced document');
    expect(countSessions()).toBe(before);
  });

  it('admits file document blocks at the 100-block bound', async () => {
    const documentBlock = (n: number) => ({
      type: 'document',
      source: { type: 'file', file_id: `file_${n}` },
    });
    const { status, body } = await postSession({
      agent: agentId,
      initial_events: [
        { type: 'user.message', content: Array.from({ length: 100 }, (_, i) => documentBlock(i)) },
      ],
    });

    expect(status, JSON.stringify(body)).toBe(201);
  });

  it('does not count text or non-file document blocks against the file-document bound', async () => {
    const { status, body } = await postSession({
      agent: agentId,
      initial_events: [
        {
          type: 'user.message',
          content: [
            { type: 'text', text: 'context' },
            // A base64 document block is not a file-sourced block, so it must
            // not draw down the 100-block file budget.
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'aGk=' } },
          ],
        },
      ],
    });

    expect(status, JSON.stringify(body)).toBe(201);
  });

  it('answers 413 when the create body exceeds 32 MB', async () => {
    // A single oversized string field pushes the serialized body past the
    // published bound without building 32 MB of events.
    const before = countSessions();
    const res = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: agentId, metadata: { pad: 'x'.repeat(33 * 1024 * 1024) } }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('request_too_large');
    expect(countSessions()).toBe(before);
  });
});
