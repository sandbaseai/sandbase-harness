/**
 * The two subscription modes of `GET /v1/sessions/:id/events/stream`.
 *
 * The route is called directly, with a session manager double that can push live
 * events, so what is asserted is the route's own decision: which stored events a
 * connection is given, in which order, with which `id`, and what the keepalive
 * frame looks like. The cursor-less mode is the published one — a stream without
 * a cursor carries what happens next, not a replay of the log.
 */

import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamRoutes } from '@/api/routes/stream.js';
import type { ServerDeps } from '@/api/server.js';
import type { SessionEvent } from '@/types/session.js';

const SESSION_ID = 'sess_stream';

function stored(seq: number, text = `event ${seq}`): SessionEvent {
  return {
    id: `sevt_${seq}`,
    sessionId: SESSION_ID,
    seq,
    type: 'user.message',
    content: [{ type: 'text', text }],
    createdAt: '2026-01-01T00:00:00.000Z',
  } as unknown as SessionEvent;
}

/**
 * Minimal stream deps: the route reads the session, subscribes, and backfills
 * from the event logger. `push` drives the live half of the subscription.
 */
function streamApp(events: SessionEvent[] = []) {
  const subscribers = new Set<(event: SessionEvent) => void>();
  const sessionManager = {
    get: (id: string) => (id === SESSION_ID ? { id, status: 'idle' } : undefined),
    subscribe: (_id: string, listener: (event: SessionEvent) => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    getEventLogger: () => ({ getEvents: (_id: string, afterSeq?: number) => (
      afterSeq === undefined ? events : events.filter((event) => event.seq > afterSeq)
    ) }),
  };
  const app = new Hono();
  app.route('/v1/sessions', streamRoutes({ sessionManager } as unknown as ServerDeps));
  return { app, push: (event: SessionEvent) => { for (const listener of subscribers) listener(event); } };
}

/** Frame text accumulated so far, plus a way to stop the stream. */
function frameReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const pump = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      text += decoder.decode(value, { stream: true });
    }
  };
  return {
    pump,
    get text() { return text; },
    stop: async () => { await reader.cancel().catch(() => {}); },
  };
}

/** Let queued microtasks and the stream's own writes settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('session event stream subscription modes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays nothing without a cursor and delivers what happens next', async () => {
    const { app, push } = streamApp([stored(1), stored(2)]);
    const response = await app.request(`/v1/sessions/${SESSION_ID}/events/stream`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const frames = frameReader(response);
    void frames.pump();
    await settle();
    // The recorded log is not this connection's business: no cursor was sent.
    expect(frames.text).toBe('');

    push(stored(3, 'live'));
    await settle();
    expect(frames.text).toContain('event: user.message');
    expect(frames.text).toContain('id: 3');
    expect(frames.text).toContain('live');
    expect(frames.text).not.toContain('id: 1');
    expect(frames.text).not.toContain('id: 2');
    await frames.stop();
  });

  it('closes after writing a live session.deleted event', async () => {
    const { app, push } = streamApp();
    const response = await app.request(`/v1/sessions/${SESSION_ID}/events/stream`);
    const frames = frameReader(response);
    const pump = frames.pump();
    await settle();

    push({ ...stored(1), type: 'session.deleted' });
    await pump;

    expect(frames.text).toContain('event: session.deleted');
    expect(frames.text).toContain('id: 1');
  });

  it('replays stored events after the cursor, in order, before live ones', async () => {
    const { app, push } = streamApp([stored(1), stored(2), stored(3)]);
    const response = await app.request(`/v1/sessions/${SESSION_ID}/events/stream`, {
      headers: { 'Last-Event-ID': '2' },
    });
    const frames = frameReader(response);
    void frames.pump();
    await settle();

    expect(frames.text).toContain('id: 3');
    expect(frames.text).not.toContain('id: 1');
    expect(frames.text).not.toContain('id: 2');
    // The cursor itself is not re-sent: the client already has it.
    expect(frames.text.indexOf('id: 3')).toBeGreaterThan(-1);

    push(stored(4, 'live'));
    await settle();
    expect(frames.text).toContain('id: 4');
    expect(frames.text.indexOf('id: 3')).toBeLessThan(frames.text.indexOf('id: 4'));
    await frames.stop();
  });

  it('replays the whole log for cursor 0, and reads the query spelling too', async () => {
    const { app } = streamApp([stored(1), stored(2)]);
    const header = await app.request(`/v1/sessions/${SESSION_ID}/events/stream`, {
      headers: { 'Last-Event-ID': '0' },
    });
    const fromHeader = frameReader(header);
    void fromHeader.pump();
    await settle();
    expect(fromHeader.text).toContain('id: 1');
    expect(fromHeader.text).toContain('id: 2');
    await fromHeader.stop();

    const query = await app.request(`/v1/sessions/${SESSION_ID}/events/stream?last_event_id=1`);
    const fromQuery = frameReader(query);
    void fromQuery.pump();
    await settle();
    expect(fromQuery.text).toContain('id: 2');
    expect(fromQuery.text).not.toContain('id: 1');
    await fromQuery.stop();
  });

  it('never delivers a stored event twice when it also arrives live', async () => {
    const { app, push } = streamApp([stored(1), stored(2)]);
    const response = await app.request(`/v1/sessions/${SESSION_ID}/events/stream`, {
      headers: { 'Last-Event-ID': '1' },
    });
    const frames = frameReader(response);
    void frames.pump();
    await settle();

    // An event that lands after the backfill read is deduped by seq rather than
    // sent twice: the connection is live by then, and seq 2 was already written.
    push(stored(2));
    push(stored(3, 'after'));
    await settle();
    expect(frames.text.match(/id: 2/g)?.length).toBe(1);
    expect(frames.text.match(/id: 3/g)?.length).toBe(1);
    await frames.stop();
  });

  it('buffers an event that arrives while the backfill read is still running', async () => {
    // The window for this branch is inside the backfill loop, so the double
    // broadcasts from within `getEvents`: seq 2 is then both a stored event and a
    // live one, and seq 3 exists only live. Both must be written once, in order,
    // after the stored event the read returns.
    const subscribers = new Set<(event: SessionEvent) => void>();
    const sessionManager = {
      get: (id: string) => (id === SESSION_ID ? { id, status: 'idle' } : undefined),
      subscribe: (_id: string, listener: (event: SessionEvent) => void) => {
        subscribers.add(listener);
        return () => subscribers.delete(listener);
      },
      getEventLogger: () => ({
        getEvents: (_id: string, afterSeq?: number) => {
          for (const listener of subscribers) listener(stored(3, 'live during backfill'));
          return afterSeq === undefined ? [] : [stored(1), stored(2)].filter((event) => event.seq > afterSeq);
        },
      }),
    };
    const app = new Hono();
    app.route('/v1/sessions', streamRoutes({ sessionManager } as unknown as ServerDeps));

    const response = await app.request(`/v1/sessions/${SESSION_ID}/events/stream`, {
      headers: { 'Last-Event-ID': '1' },
    });
    const frames = frameReader(response);
    void frames.pump();
    await settle();

    expect(frames.text.match(/id: 2/g)?.length).toBe(1);
    expect(frames.text.match(/id: 3/g)?.length).toBe(1);
    expect(frames.text.indexOf('id: 2')).toBeLessThan(frames.text.indexOf('id: 3'));
    await frames.stop();
  });

  it('refuses a cursor the log cannot order by, before opening the stream', async () => {
    const { app } = streamApp([stored(1)]);
    for (const value of [
      'sevt_abc', '-1', '1.5', '1e3', '+1', '1 2',
      // Too large to compare exactly: every real seq is below it, so accepting it
      // would look like a replay that never delivers a persisted event again.
      '99999999999999999999', '9'.repeat(400),
    ]) {
      const response = await app.request(`/v1/sessions/${SESSION_ID}/events/stream`, {
        headers: { 'Last-Event-ID': value },
      });
      expect(response.status, value).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
      const body = await response.json() as { error: { type: string; message: string } };
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.message).toContain('Last-Event-ID');
    }
    // A blank cursor is not a cursor: the connection is live-only, not refused.
    const blank = await app.request(`/v1/sessions/${SESSION_ID}/events/stream`, {
      headers: { 'Last-Event-ID': '   ' },
    });
    expect(blank.status).toBe(200);
    await blank.body?.cancel().catch(() => {});
  });

  it('refuses two cursors that name different positions', async () => {
    const { app } = streamApp([stored(1), stored(2)]);
    const conflicting = await app.request(
      `/v1/sessions/${SESSION_ID}/events/stream?last_event_id=2`,
      { headers: { 'Last-Event-ID': '1' } },
    );
    expect(conflicting.status).toBe(400);
    const body = await conflicting.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('different positions');

    // Agreement is accepted, and a blank beside a value is not a disagreement.
    const agreeing = await app.request(
      `/v1/sessions/${SESSION_ID}/events/stream?last_event_id=1`,
      { headers: { 'Last-Event-ID': '1' } },
    );
    expect(agreeing.status).toBe(200);
    await agreeing.body?.cancel().catch(() => {});

    const blankQuery = await app.request(
      `/v1/sessions/${SESSION_ID}/events/stream?last_event_id=`,
      { headers: { 'Last-Event-ID': '1' } },
    );
    expect(blankQuery.status).toBe(200);
    await blankQuery.body?.cancel().catch(() => {});
  });

  it('keeps the connection alive with a `ping` frame carrying JSON', async () => {
    vi.useFakeTimers();
    const { app } = streamApp([]);
    const response = await app.request(`/v1/sessions/${SESSION_ID}/events/stream`);
    const frames = frameReader(response);
    void frames.pump();
    expect(frames.text).toBe('');

    await vi.advanceTimersByTimeAsync(15_000);
    // A keepalive is not an event: it names itself in the payload like every
    // other frame here, and carries no `id`, so it cannot move the cursor.
    expect(frames.text).toBe('event: ping\ndata: {"type":"ping"}\n\n');
    await frames.stop();
  });
});
