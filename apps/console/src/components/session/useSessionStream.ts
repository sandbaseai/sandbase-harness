import { useEffect, useRef, useState } from 'react';
import { getPage, readEventStream } from '../../api';
import { contiguousSessionSequence, mergeOrderedSessionEvents } from '../../lib/ordered-session-events';
import type { Session, SessionEvent } from '../../types';
import { sessionDisplayStatus, toolAwaitingConfirmation } from './conversation';
import { toolUseDetails } from './eventRenderers';

export type StreamConnection = 'connecting' | 'connected' | 'reconnecting';

/**
 * The session's event feed: the initial REST backfill, the resumable SSE tail
 * with `event_deltas[]` previews, and the poll that covers a running session.
 *
 * Returns the merged durable event list, the per-event streaming previews, the
 * selected inspector event, and `loadEvents` for callers that mutate the log
 * (sending a message, confirming a tool) and want a fresh read afterwards.
 */
export function useSessionStream({
  session,
  onRefresh,
  onToolAwaiting,
}: {
  session: Session;
  onRefresh: () => void;
  /** A gated tool call arrived while a message send was in flight. */
  onToolAwaiting?: () => void;
}) {
  const sessionId = session.id;
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [eventError, setEventError] = useState('');
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  // Previewed events keyed by the durable event id announced in `event_start`;
  // each value is per-content-block text so `delta.index` stays meaningful.
  const [streamingText, setStreamingText] = useState<Record<string, Record<number, string>>>({});
  const [streamConnection, setStreamConnection] = useState<StreamConnection>('connecting');
  // Only the durable tail stream owns this cursor. Transient chunks are never
  // used for Last-Event-ID because their seq is 0 and they are not replayable.
  const lastDurableSequence = useRef(0);
  const eventsRef = useRef<SessionEvent[]>([]);

  const loadEvents = async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setLoadingEvents(true);
    setEventError('');
    try {
      const page = await getPage<SessionEvent>(`/v1/sessions/${encodeURIComponent(sessionId)}/events?limit=1000`);
      const merged = mergeOrderedSessionEvents(eventsRef.current, page.data);
      eventsRef.current = merged;
      lastDurableSequence.current = contiguousSessionSequence(merged);
      setEvents(merged);
      setSelectedEventId((current) => current && merged.some((item) => item.id === current) ? current : merged.at(-1)?.id ?? null);
      return merged;
    } catch (err) {
      setEventError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      if (!options.silent) setLoadingEvents(false);
    }
  };

  useEffect(() => {
    // Session IDs have independent append-only sequences. Reset every replay
    // reference before opening the new stream so a previous session cannot
    // suppress or skip events from this session.
    eventsRef.current = [];
    lastDurableSequence.current = 0;
    setEvents([]);
    setStreamingText({});
    void loadEvents();
  }, [sessionId]);

  const applyPreviewFrame = (frameType: 'event_start' | 'event_delta', data: unknown) => {
    const frame = data && typeof data === 'object' ? data as Record<string, unknown> : null;
    if (!frame) return;
    if (frameType === 'event_start') {
      const previewed = frame.event && typeof frame.event === 'object'
        ? frame.event as { type?: string; id?: string }
        : null;
      if (previewed?.type === 'agent.message' && previewed.id) {
        setStreamingText((current) => current[previewed.id!] ? current : { ...current, [previewed.id!]: {} });
      }
      return;
    }
    const eventId = typeof frame.event_id === 'string' ? frame.event_id : null;
    const delta = frame.delta && typeof frame.delta === 'object' ? frame.delta as Record<string, unknown> : null;
    const content = delta?.content && typeof delta.content === 'object' ? delta.content as Record<string, unknown> : null;
    const text = content?.type === 'text' && typeof content.text === 'string' ? content.text : null;
    // Deltas may be dropped or reordered; a delta for an id that never saw an
    // `event_start` on this connection is ignored rather than materialising a
    // preview out of order.
    if (!eventId || delta?.type !== 'content_delta' || !text) return;
    const index = typeof delta.index === 'number' && Number.isInteger(delta.index) && delta.index >= 0
      ? delta.index
      : 0;
    setStreamingText((current) => {
      if (!(eventId in current)) return current;
      const blocks = { ...current[eventId] };
      blocks[index] = `${blocks[index] ?? ''}${text}`;
      return { ...current, [eventId]: blocks };
    });
  };

  const applyStreamEvent = (streamEvent: { event: string; data: unknown; id?: string }) => {
    // Keepalives are not events: the stream sends `ping`, and older servers sent
    // `heartbeat`. Neither may reach the projection below.
    if (streamEvent.event === 'ping' || streamEvent.event === 'heartbeat') return;
    // `event_deltas[]` preview frames: `event_start` announces the durable
    // event id it previews, `event_delta` extends one content block. Neither is
    // an event itself and neither touches the durable merge below.
    if (streamEvent.event === 'event_start' || streamEvent.event === 'event_delta') {
      applyPreviewFrame(streamEvent.event, streamEvent.data);
      return;
    }
    const payload = streamEvent.data && typeof streamEvent.data === 'object'
      ? streamEvent.data as Partial<SessionEvent>
      : null;
    if (!payload) return;

    if (!payload.id || !payload.type || typeof payload.seq !== 'number' || payload.seq <= 0) return;

    // The buffered event closes its own preview: a preview is only a prefix,
    // so the persisted record replaces it rather than merging with it. A
    // lifecycle event that ends generation sweeps any preview whose buffered
    // event will never land (a whitespace-only turn, a mid-stream abort).
    const endsGeneration = payload.type === 'session.status_idle'
      || payload.type === 'session.status_terminated'
      || payload.type === 'session.deleted'
      || payload.type === 'session.error';
    setStreamingText((current) => {
      if (endsGeneration) return {};
      if (!payload.id || !(payload.id in current)) return current;
      const next = { ...current };
      delete next[payload.id];
      return next;
    });

    const merged = mergeOrderedSessionEvents(eventsRef.current, [payload as SessionEvent]);
    eventsRef.current = merged;
    lastDurableSequence.current = contiguousSessionSequence(merged);
    setEvents(merged);
    setSelectedEventId((current) => current ?? payload.id ?? null);

    if ((payload.type === 'agent.tool_use' || payload.type === 'agent.mcp_tool_use')
      && toolAwaitingConfirmation(toolUseDetails(payload as SessionEvent), false)) {
      onToolAwaiting?.();
    }
    if (payload.type.startsWith('session.') || payload.type === 'agent.message') onRefresh();
  };

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let retry = 0;
    const connect = async () => {
      while (!cancelled) {
        try {
          setStreamConnection(retry > 0 ? 'reconnecting' : 'connecting');
          setStreamConnection('connected');
          // Always name where to resume, cursor `0` included: a stream without a
          // cursor carries live events only, so a subscription opened before this
          // page's own history read finishes — or one that races an event written
          // between the read and the subscribe — would miss it. Resuming from 0
          // replays the log, which the projection below already merges by seq.
          await readEventStream(
            `/v1/sessions/${encodeURIComponent(sessionId)}/events/stream?event_deltas%5B%5D=agent.message`,
            applyStreamEvent,
            { signal: controller.signal, lastEventId: String(lastDurableSequence.current) },
          );
          retry = 0;
        } catch (err) {
          if (cancelled || controller.signal.aborted) return;
          retry += 1;
          setStreamConnection('reconnecting');
          setEventError(err instanceof Error ? err.message : String(err));
          await new Promise((resolve) => window.setTimeout(resolve, Math.min(5000, 500 * retry)));
        }
      }
    };
    void connect();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sessionId]);

  const displayStatus = sessionDisplayStatus(session, events);

  useEffect(() => {
    if (!['running', 'rescheduling', 'awaiting_action'].includes(displayStatus)) return undefined;
    const timer = window.setInterval(() => {
      void loadEvents({ silent: true });
      onRefresh();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [displayStatus, sessionId, onRefresh]);

  return {
    events,
    displayStatus,
    loadingEvents,
    eventError,
    selectedEventId,
    setSelectedEventId,
    streamingText,
    streamConnection,
    loadEvents,
  };
}
