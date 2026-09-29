/**
 * SSE Streaming Route
 *
 * GET /v1/sessions/:id/events/stream — Server-Sent Events endpoint
 *
 * Resume support: the client may pass `Last-Event-ID` header (or `last_event_id`
 * query param) carrying the last seq it saw. With a cursor, all stored events
 * with seq > lastSeq are backfilled before live events — deduping by seq so an
 * event that lands between backfill and live subscription is never sent twice
 * or dropped (OMA consolidation pattern). Without one, the stream is live-only:
 * it delivers what happens next and replays nothing, so a client that also wants
 * the recorded log reads it from `GET /events` and resumes from what it has.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SessionEvent } from '@/types/session.js';
import { toApiEvent } from '@/api/standard.js';
import { EventDeltaProjector, parseEventDeltas } from '@/core/session/event-deltas.js';
import type { ServerDeps } from '../server.js';
import { rejectUnexpectedQueryParams } from './query-params.js';

/**
 * Read the resume cursor a connection asked for.
 *
 * Absent (or blank) means live-only. A value has to be a safe integer: it is the
 * numeric `seq` this stream uses as its `id`, and that is the only cursor the log
 * can be resumed from. An event id from `GET /events` is a different string, and
 * a value the log cannot order by is refused before the stream opens rather than
 * silently treated as "replay everything" or as "replay nothing" — a number too
 * large to compare exactly is the second of those, because every real `seq` is
 * then below it and the connection would never receive a persisted event again.
 */
function parseResumeCursor(raw: string): { ok: true; seq?: number } | { ok: false; message: string } {
  if (raw === '') return { ok: true };
  const seq = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isSafeInteger(seq) || seq < 0) {
    return {
      ok: false,
      message: 'Last-Event-ID must be the numeric seq of the last event you saw, '
        + 'or omitted for a stream that carries live events only. '
        + `Received ${JSON.stringify(raw.slice(0, 40))}.`,
    };
  }
  return { ok: true, seq };
}

/**
 * The two spellings of one cursor have to agree, like every other pair of
 * spellings this API reads: resolving a disagreement by precedence would resume
 * from a position the caller named in only one of the two.
 */
function resolveResumeCursor(
  header: string | undefined,
  query: string | undefined,
): { ok: true; seq?: number } | { ok: false; message: string } {
  const fromHeader = parseResumeCursor((header ?? '').trim());
  const fromQuery = parseResumeCursor((query ?? '').trim());
  if (!fromHeader.ok) return fromHeader;
  if (!fromQuery.ok) return fromQuery;
  if (fromHeader.seq !== undefined && fromQuery.seq !== undefined && fromHeader.seq !== fromQuery.seq) {
    return {
      ok: false,
      message: 'Last-Event-ID and last_event_id name different positions; send one cursor, or send both with the same value.',
    };
  }
  return { ok: true, seq: fromHeader.seq ?? fromQuery.seq };
}

export function streamRoutes(deps: ServerDeps) {
  const app = new Hono();
  const { sessionManager } = deps;

  // GET /:id/events/stream — SSE stream
  app.get('/:id/events/stream', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, ['event_deltas', 'event_deltas[]', 'last_event_id']);
    if (rejected) return rejected;
    const sessionId = c.req.param('id');
    const session = sessionManager.get(sessionId);

    if (!session) {
      return c.json({ error: { type: 'not_found', message: 'Session not found' } }, 404);
    }

    // `event_deltas[]` is rejected before the stream opens: a 400 must arrive as
    // a normal response, not as an error on an established event stream.
    const requestedDeltas = [
      ...c.req.queries('event_deltas') ?? [],
      ...c.req.queries('event_deltas[]') ?? [],
    ];
    const parsedDeltas = parseEventDeltas(requestedDeltas.length > 0 ? requestedDeltas : undefined);
    if (!parsedDeltas.ok) {
      return c.json({ error: { type: 'invalid_request_error', message: parsedDeltas.message } }, 400);
    }
    const projector = new EventDeltaProjector(parsedDeltas.types);

    // Parse resume cursor from Last-Event-ID header or query param
    const cursor = resolveResumeCursor(c.req.header('Last-Event-ID'), c.req.query('last_event_id'));
    if (!cursor.ok) {
      return c.json({ error: { type: 'invalid_request_error', message: cursor.message } }, 400);
    }
    const resumeFromSeq = cursor.seq;

    return streamSSE(c, async (stream) => {
      let closed = false;
      let maxEmittedSeq = resumeFromSeq ?? 0;

      // Buffer live events that arrive during backfill so nothing is lost.
      const liveBuffer: SessionEvent[] = [];
      let backfilling = true;

      const writeEvent = async (event: SessionEvent) => {
        // Transient events (seq === 0) are broadcast-only: they are never
        // persisted, don't advance the resume cursor, and skip dedup.
        const transient = event.seq === 0;
        if (!transient) {
          if (event.seq <= maxEmittedSeq) return; // dedup persisted events
          maxEmittedSeq = event.seq;
        }

        // Opted-in previews are emitted ahead of the buffered event they
        // anticipate. They carry no `id`, so they must not set the resume
        // cursor a reconnecting client would send back.
        for (const frame of projector.framesFor(event)) {
          await stream.writeSSE({ event: frame.type, data: JSON.stringify(frame) });
        }

        if (transient) return;

        // A buffered event closes its own preview on this connection.
        projector.reconcile(event);

        await stream.writeSSE({
          id: String(event.seq),
          event: event.type,
          data: JSON.stringify(toApiEvent(event)),
        });
      };

      // Subscribe first — while backfilling, buffer; after, write directly.
      const unsubscribe = sessionManager.subscribe(sessionId, (event) => {
        if (closed) return;
        if (backfilling) {
          liveBuffer.push(event);
        } else {
          void writeEvent(event).catch(() => {
            closed = true;
          });
        }
      });

      // Backfill stored events with seq > the cursor. A connection without one
      // asked for the live stream, so nothing recorded is replayed to it.
      if (resumeFromSeq !== undefined) {
        try {
          const stored = sessionManager
            .getEventLogger()
            .getEvents(sessionId, resumeFromSeq);
          for (const event of stored) {
            if (closed) break;
            await writeEvent(event);
          }
        } catch {
          // Backfill best-effort; continue to live
        }
      }

      // Flush any events buffered during backfill, then go live
      backfilling = false;
      for (const event of liveBuffer) {
        if (closed) break;
        await writeEvent(event);
      }
      liveBuffer.length = 0;

      // Periodic keepalive. The published stream sends `event: ping` with a JSON
      // body and the official SDK skips that event name, so it is invisible to a
      // client that only handles the documented event types. It carries no `id`:
      // a keepalive must not advance the resume cursor.
      const keepalive = setInterval(() => {
        if (closed) {
          clearInterval(keepalive);
          return;
        }
        stream.writeSSE({ event: 'ping', data: JSON.stringify({ type: 'ping' }) }).catch(() => {
          closed = true;
          clearInterval(keepalive);
        });
      }, 15_000);

      // Clean up on client disconnect
      stream.onAbort(() => {
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
      });

      // Hold the stream open until aborted
      while (!closed) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      clearInterval(keepalive);
      unsubscribe();
    });
  });

  return app;
}
