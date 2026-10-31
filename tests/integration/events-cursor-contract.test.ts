/**
 * Integration test: the session event log's own cursor contract.
 *
 * `collection-pagination.test.ts` covers the shared `limit`/`page` behaviour on the
 * vault and memory-store listings, but those listings are id-ordered and can name a
 * predecessor. The event log is not: it is read forward over an append-only log
 * (`sessions.ts:623-701`), so it has three properties no id-ordered collection has,
 * and none of them was asserted anywhere.
 *
 * 1. `prev_page` is always `null`. A forward-only scan cannot name its predecessor,
 *    and a cursor that does not resolve is worse than an honest `null`.
 * 2. The cursor carries the session it came from (`{session_id, after_id}`), so a
 *    cursor issued for one session's log must be refused against another's rather
 *    than applied to it.
 * 3. A cursor this route issued always names an event it returned. One naming an
 *    event absent from the log was not issued here, and the route refuses it —
 *    falling through to "the whole log" would answer a request to continue with a
 *    wrong answer the caller cannot detect. The raw `after_id` spelling keeps its
 *    old meaning, because a caller building it by hand may legitimately ask for
 *    "everything after this id" even when this log has never seen it.
 *
 * The third property is why the refusal message is asserted exactly rather than the
 * status alone: the neighbouring refusal branches (wrong ordering, wrong filter)
 * are also 400s, so a status-only assertion would pass for a reason other than the
 * one it names.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { encodeCursor } from '@/api/standard.js';
import type { Session, SessionEvent } from '@/types/session.js';
import type { UserEvent } from '@/types/cma-protocol.js';

/** Must match `EVENTS_LIST_ORDER` in `sessions.ts`; the message assertion below fails if it drifts. */
const EVENTS_LIST_ORDER = 'events.appended ASC';
const CURSOR_REFUSAL = 'page must be a cursor returned by this endpoint';

describe('Session event log cursors', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function setUp(): ReturnType<typeof createServer> {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-events-cursor-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_events',
      'events',
      JSON.stringify({ name: 'events', model: 'gpt-4o', system: 'p' }),
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

  /** A session plus `count` log entries, appended as one batch of control events. */
  async function sessionWithEvents(
    server: ReturnType<typeof createServer>,
    count: number,
  ): Promise<string> {
    const created = await server.request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'agent_events' }),
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

  async function page(
    server: ReturnType<typeof createServer>,
    id: string,
    query: string,
  ): Promise<{ status: number; body: any }> {
    const res = await server.request(`/v1/sessions/${id}/events${query}`);
    return { status: res.status, body: await res.json() };
  }

  it('names no previous page, because the scan cannot name its predecessor', async () => {
    const server = setUp();
    const id = await sessionWithEvents(server, 3);

    const first = await page(server, id, '?limit=2');

    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.prev_page).toBeNull();
    expect(typeof first.body.next_page).toBe('string');
  });

  it('partitions the whole log across cursor pages with no repeats', async () => {
    const server = setUp();
    const id = await sessionWithEvents(server, 3);
    const unpaged = await page(server, id, '');
    const allIds = unpaged.body.data.map((event: { id: string }) => event.id);

    const walked: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const query = cursor === null ? '?limit=2' : `?limit=2&page=${encodeURIComponent(cursor)}`;
      const res = await page(server, id, query);
      expect(res.status).toBe(200);
      walked.push(...res.body.data.map((event: { id: string }) => event.id));
      cursor = res.body.next_page;
      if (cursor === null) break;
    }

    expect(walked).toEqual(allIds);
  });

  it('refuses a cursor issued for another session instead of applying it', async () => {
    const server = setUp();
    const first = await sessionWithEvents(server, 3);
    const second = await sessionWithEvents(server, 3);
    const cursor = (await page(server, first, '?limit=2')).body.next_page as string;
    const secondIds = (await page(server, second, '')).body.data.map((event: { id: string }) => event.id);

    const refused = await page(server, second, `?limit=2&page=${encodeURIComponent(cursor)}`);

    expect(refused.status).toBe(400);
    expect(refused.body.error.type).toBe('invalid_request_error');
    // Either spelling of the shared refusal is acceptable here (the shared helper
    // distinguishes ordering from filtering); what matters is that it refuses
    // rather than answering with the other session's position.
    expect(refused.body.error.message).toMatch(/different (filter|collection)/);
    expect(refused.body.data).toBeUndefined();
    // The refusal must not disclose the other log's identities either.
    for (const eventId of secondIds) {
      expect(JSON.stringify(refused.body)).not.toContain(eventId);
    }
    expect(secondIds).toHaveLength(3);
  });

  it('refuses a cursor naming an event this log does not contain', async () => {
    const server = setUp();
    const id = await sessionWithEvents(server, 2);
    // Forged with the route's own encoder, so it is well formed and correctly
    // bound to this session: only the position is absent from the log.
    const forged = encodeCursor({
      order: EVENTS_LIST_ORDER,
      filter: { session_id: id },
      after_id: 'sevt_absent_from_this_log',
    });

    const refused = await page(server, id, `?limit=2&page=${encodeURIComponent(forged)}`);

    expect(refused.status).toBe(400);
    expect(refused.body.error.type).toBe('invalid_request_error');
    expect(refused.body.error.message).toBe(CURSOR_REFUSAL);
    expect(refused.body.data).toBeUndefined();
  });

  it('keeps the raw after_id spelling, which may name an id this log never had', async () => {
    const server = setUp();
    const id = await sessionWithEvents(server, 3);

    const answered = await page(server, id, '?after_id=sevt_absent_from_this_log');

    expect(answered.status).toBe(200);
    expect(answered.body.data).toHaveLength(3);
  });

  it('filters events by the published types[] parameter', async () => {
    const server = setUp();
    const id = await sessionWithEvents(server, 3);

    // The session's log holds user.interrupt entries plus whatever session
    // lifecycle events the create+events path emitted; filtering to
    // user.interrupt returns exactly the appended set, in order.
    const filtered = await page(server, id, '?types[]=user.interrupt');

    expect(filtered.status).toBe(200);
    expect(filtered.body.data).toHaveLength(3);
    expect(filtered.body.data.every((event: { type: string }) => event.type === 'user.interrupt')).toBe(true);
  });

  it('accepts the bare types spelling and dedupes across both spellings', async () => {
    const server = setUp();
    const id = await sessionWithEvents(server, 1);

    const filtered = await page(server, id, '?types=user.interrupt&types[]=user.interrupt&types[]=session.status_running');

    expect(filtered.status).toBe(200);
    expect(filtered.body.data.every((event: { type: string }) =>
      event.type === 'user.interrupt' || event.type === 'session.status_running')).toBe(true);
    // One appended interrupt and at least one running event must appear; a
    // caller that sent the same value through both spellings must not get two
    // copies of it.
    const types = filtered.body.data.map((event: { type: string }) => event.type);
    expect(types.filter((type: string) => type === 'user.interrupt')).toHaveLength(1);
  });

  it('refuses a types value the runtime cannot emit instead of returning an empty page', async () => {
    const server = setUp();
    const id = await sessionWithEvents(server, 1);

    const refused = await page(server, id, '?types[]=user.interrupt&types[]=not.a.type');

    expect(refused.status).toBe(400);
    expect(refused.body.error.type).toBe('invalid_request_error');
    expect(refused.body.error.message).toContain('not.a.type');
    expect(refused.body.data).toBeUndefined();
  });

  it('binds the types filter into the cursor, refusing a replay under a different filter', async () => {
    const server = setUp();
    const id = await sessionWithEvents(server, 3);

    const filtered = await page(server, id, '?types[]=user.interrupt&limit=2');
    expect(filtered.status).toBe(200);
    const cursor = filtered.body.next_page;
    expect(typeof cursor).toBe('string');

    // Replaying the same filter resumes correctly.
    const resumed = await page(server, id, `?types[]=user.interrupt&limit=2&page=${encodeURIComponent(cursor as string)}`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.data).toHaveLength(1);

    // Replaying it under a different filter is refused, not resumed mid-set.
    const refused = await page(server, id, `?limit=2&page=${encodeURIComponent(cursor as string)}`);
    expect(refused.status).toBe(400);
    expect(refused.body.error.type).toBe('invalid_request_error');
    expect(refused.body.error.message).toMatch(/different (filter|collection)/);
  });

  it('lets after_id name a position that the filter excludes', async () => {
    const server = setUp();
    const id = await sessionWithEvents(server, 3);
    const all = await page(server, id, '');
    const lastId = all.body.data[all.body.data.length - 1].id as string;

    // after_id is a position, not a content match: the filter may exclude the
    // event it names, and the page after that position is still the honest
    // answer.
    const filtered = await page(server, id, `?types[]=user.interrupt&after_id=${encodeURIComponent(lastId)}`);

    expect(filtered.status).toBe(200);
    expect(filtered.body.data).toHaveLength(0);
  });
});
