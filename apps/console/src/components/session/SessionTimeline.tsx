import { ChevronDown, Copy, Download, Keyboard, MessageSquare, Search, Info, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EmptyState, LoadingState } from '../Common';
import { eventKind, eventText, eventTitle, MarkdownMessage, renderEventBody } from './eventRenderers';
import { downloadJson } from '../../lib/format';
import { modelErrorHint, sessionErrorCode } from '../../lib/modelErrorHints';
import type { SessionEvent } from '../../types';
import {
  SESSION_EVENT_KINDS,
  conversationEntries,
  conversationMessages,
  eventLabel,
  eventTime,
  toggleSet,
  type SessionEventKind,
} from './conversation';
import { ConversationToolCard } from './ApprovalCard';
import type { StreamConnection } from './useSessionStream';

/**
 * The session's event timeline: the Transcript conversation pane with its
 * streaming previews and follow-scroll, and the Debug pane with the kind
 * filter, minimap, event list, and inspector. Pure presentation — the event
 * data arrives from `useSessionStream`; approvals are delegated to the page.
 */
export function SessionTimeline({
  sessionId,
  events,
  streamingText,
  loadingEvents,
  eventError,
  streamConnection,
  agentName,
  selectedEvent,
  onSelectEvent,
  confirmingToolIds,
  confirmedToolIds,
  onConfirm,
  onSubmitResult,
  composer,
}: {
  sessionId: string;
  events: SessionEvent[];
  streamingText: Record<string, Record<number, string>>;
  loadingEvents: boolean;
  eventError: string;
  streamConnection: StreamConnection;
  agentName?: string;
  /** Inspector selection. The stream hook owns it so a load can re-pin it. */
  selectedEvent: SessionEvent | null;
  onSelectEvent: (id: string | null) => void;
  confirmingToolIds: Set<string>;
  confirmedToolIds: Set<string>;
  onConfirm: (toolUseId: string, result: 'allow' | 'deny') => void;
  onSubmitResult: (toolUseId: string, customToolUseEventId: string, text: string, isError: boolean) => void;
  composer: ReactNode;
}) {
  const [mode, setMode] = useState<'transcript' | 'debug'>('transcript');
  const [detailMode, setDetailMode] = useState<'rendered' | 'raw'>('rendered');
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedKinds, setSelectedKinds] = useState<Set<SessionEventKind>>(new Set(SESSION_EVENT_KINDS));
  const [query, setQuery] = useState('');
  const conversationListRef = useRef<HTMLDivElement>(null);
  const shouldFollowConversation = useRef(true);
  const initialScrollDoneRef = useRef(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const allEventKindsSelected = selectedKinds.size === SESSION_EVENT_KINDS.length;
  const eventFilterLabel = allEventKindsSelected
    ? 'All events'
    : selectedKinds.size === 0
      ? 'No events'
      : `${selectedKinds.size} event${selectedKinds.size === 1 ? '' : 's'}`;

  useEffect(() => {
    // Entering a session always starts pinned to the latest message.
    initialScrollDoneRef.current = false;
    shouldFollowConversation.current = true;
  }, [sessionId]);

  useEffect(() => {
    if (loadingEvents) return;
    const list = conversationListRef.current;
    if (!list || !shouldFollowConversation.current) return;
    const frame = window.requestAnimationFrame(() => {
      // The first scroll after entering a session jumps instantly instead of
      // animating from the top, and waits one extra frame so the freshly
      // rendered transcript has its full height before measuring.
      const instant = !initialScrollDoneRef.current;
      initialScrollDoneRef.current = true;
      window.requestAnimationFrame(() => {
        list.scrollTo({ top: list.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
        setShowJumpToLatest(false);
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [events, streamingText, loadingEvents]);

  const visibleEvents = events.filter((event) => {
    const kind = eventKind(event);
    if (mode === 'transcript' && !['user', 'agent', 'tool', 'error'].includes(kind)) return false;
    if (!selectedKinds.has(kind)) return false;
    const text = `${event.type} ${eventText(event)} ${event.id}`.toLowerCase();
    return text.includes(query.toLowerCase());
  });

  return (
    <>
      <div className="sessionToolbar">
        <div className="segment compactSegment">
          <button type="button" className={mode === 'transcript' ? 'active' : ''} onClick={() => setMode('transcript')}>Transcript</button>
          <button type="button" className={mode === 'debug' ? 'active' : ''} onClick={() => setMode('debug')}>Debug</button>
        </div>
        <div className="filterWrap">
          <button className="filterButton" type="button" aria-expanded={filterOpen} onClick={() => setFilterOpen((open) => !open)}>
            <span className="filterButtonLabel"><span className="filterButtonDot" />{eventFilterLabel}</span>
            <ChevronDown size={15} />
          </button>
          {filterOpen ? (
            <div className="eventFilterMenu" role="group" aria-label="Event filters">
              <div className="eventFilterHeader">
                <strong>Show events</strong>
                <span>{selectedKinds.size} of {SESSION_EVENT_KINDS.length}</span>
              </div>
              <div className="eventFilterOptions">
                {SESSION_EVENT_KINDS.map((kind) => (
                  <label key={kind}>
                    <input
                      type="checkbox"
                      checked={selectedKinds.has(kind)}
                      onChange={(event) => toggleSet(kind, event.target.checked, setSelectedKinds)}
                    />
                    <span className="eventFilterCheck" aria-hidden="true">✓</span>
                    <span>{kind[0].toUpperCase() + kind.slice(1)}</span>
                  </label>
                ))}
              </div>
              <div className="eventFilterFooter">
                <span>Filter the event stream</span>
                <button type="button" onClick={() => setSelectedKinds(new Set(SESSION_EVENT_KINDS))}>Reset filters</button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="sessionSearch">
          <Search size={18} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search events" aria-label="Search events" />
        </div>
        <div className="sessionIconActions">
          <button className="iconButton" type="button" title="Keyboard shortcuts"><Keyboard size={18} /></button>
          <button className="iconButton" type="button" title="Copy session id" onClick={() => void navigator.clipboard?.writeText(sessionId)}><Copy size={18} /></button>
          <button className="iconButton" type="button" title="Download event JSON" onClick={() => downloadJson(`${sessionId}-events.json`, events)}><Download size={18} /></button>
        </div>
      </div>

      <div className="sessionTimeline">
        {mode === 'transcript' ? (
          <div className="conversationPane">
            <div className="conversationHeader">
              <div>
                <strong>Conversation</strong>
                <span>{conversationMessages(events).length} messages</span>
              </div>
              <span className={`streamStatus ${streamConnection}`}>
                <span className="streamStatusDot" />
                {streamConnection === 'connected' ? 'Live' : streamConnection === 'reconnecting' ? 'Reconnecting' : 'Connecting'}
              </span>
            </div>
            {eventError ? <div className="banner error inlineBanner">{eventError}</div> : null}
            {loadingEvents ? <LoadingState /> : null}
            {!loadingEvents ? (
              <div
                ref={conversationListRef}
                className="conversationList"
                aria-live="polite"
                onScroll={(event) => {
                  const list = event.currentTarget;
                  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 72;
                  shouldFollowConversation.current = nearBottom;
                  setShowJumpToLatest(!nearBottom);
                }}
              >
                {conversationEntries(events).map((entry) => entry.role === 'tool' ? (
                  <ConversationToolCard
                    key={entry.id}
                    entry={entry}
                    confirmingToolIds={confirmingToolIds}
                    confirmedToolIds={confirmedToolIds}
                    onConfirm={onConfirm}
                    onSubmitResult={onSubmitResult}
                  />
                ) : (
                  <article key={entry.id} className={`conversationMessage ${entry.role}`}>
                    <div className="conversationMessageMeta">
                      <span>{entry.role === 'user' ? 'You' : entry.role === 'error' ? 'Session' : agentName ?? 'Agent'}</span>
                      <time>{eventTime(entry.event)}</time>
                    </div>
                    <div className="conversationBubble">
                      {entry.role === 'agent'
                        ? (
                          <MarkdownMessage text={entry.text} />
                        )
                        : (entry.text || 'No message content.')}
                    </div>
                    {entry.role === 'error' ? <ModelErrorHint event={entry.event} /> : null}
                  </article>
                ))}
                {Object.entries(streamingText).map(([eventId, blocks]) => {
                  const text = Object.keys(blocks)
                    .map(Number)
                    .sort((a, b) => a - b)
                    .map((index) => blocks[index])
                    .join('');
                  return (
                    <article key={eventId} className="conversationMessage agent streamingMessage">
                      <div className="conversationMessageMeta"><span>{agentName ?? 'Agent'}</span><span>Generating…</span></div>
                      <div className="conversationBubble">{text || <span className="typingIndicator" aria-label="Generating"><i /><i /><i /></span>}</div>
                    </article>
                  );
                })}
                {conversationMessages(events).length === 0 && Object.keys(streamingText).length === 0 ? (
                  <EmptyState icon={<MessageSquare size={22} />} title="Start the conversation" />
                ) : null}
              </div>
            ) : null}
            {showJumpToLatest ? (
              <button
                type="button"
                className="conversationJumpLatest"
                onClick={() => {
                  shouldFollowConversation.current = true;
                  setShowJumpToLatest(false);
                  conversationListRef.current?.scrollTo({ top: conversationListRef.current.scrollHeight, behavior: 'smooth' });
                }}
              >
                New messages ↓
              </button>
            ) : null}
            {composer}
          </div>
        ) : (
          <>
            <div className="eventMiniMap">
              {events.slice(0, 42).map((event) => <span key={event.id} className={`miniEvent ${eventKind(event)}`} title={event.type} />)}
            </div>
            <div className="eventPane">
              <div className="eventList">
                {eventError ? <div className="banner error inlineBanner">{eventError}</div> : null}
                {loadingEvents ? <LoadingState /> : null}
                {!loadingEvents && visibleEvents.map((event) => (
                  <button type="button" key={event.id} className={`eventRow ${selectedEvent?.id === event.id ? 'active' : ''}`} onClick={() => onSelectEvent(event.id)}>
                    <span className={`eventType ${eventKind(event)}`}>{eventLabel(event, mode)}</span>
                    <strong>{eventTitle(event)}</strong>
                    <time>{eventTime(event)}</time>
                  </button>
                ))}
                {!loadingEvents && visibleEvents.length === 0 ? <EmptyState icon={<MessageSquare size={22} />} title="No events" /> : null}
              </div>
              <div className="eventInspector">
                {selectedEvent ? (
                  <>
                    <div className="eventInspectorHeader">
                      <button className="iconButton" type="button" title="Close selection" onClick={() => onSelectEvent(null)}><X size={18} /></button>
                      <div><span className={`eventType ${eventKind(selectedEvent)}`}>{selectedEvent.type}</span><h2>{eventTitle(selectedEvent)}</h2><p>{eventTime(selectedEvent)}</p></div>
                      <div className="inspectorViewControl"><span>View</span><div className="segment tinySegment"><button type="button" className={detailMode === 'rendered' ? 'active' : ''} onClick={() => setDetailMode('rendered')}>Preview</button><button type="button" className={detailMode === 'raw' ? 'active' : ''} onClick={() => setDetailMode('raw')}>Raw</button></div></div>
                    </div>
                    {detailMode === 'rendered' ? <DebugEventContent event={selectedEvent} /> : <pre className="rawEvent">{JSON.stringify(selectedEvent, null, 2)}</pre>}
                  </>
                ) : <EmptyState icon={<MessageSquare size={22} />} title="Select an event" />}
              </div>
            </div>
            {composer}
          </>
        )}
      </div>
    </>
  );
}

function DebugEventContent({ event }: { event: SessionEvent }) {
  return <>{renderEventBody(event)}</>;
}

/**
 * The repair for a model failure, under the message that reported it.
 *
 * The runtime names what is wrong (the variable, the model id) but not where to go
 * in this Console, so the hint is added here rather than in the message. A failure
 * that is not about the model renders nothing at all.
 */
function ModelErrorHint({ event }: { event: SessionEvent }) {
  const hint = modelErrorHint(sessionErrorCode(event));
  if (!hint) return null;
  return (
    <div className="modelErrorHint">
      <Info size={14} />
      <span>{hint}</span>
    </div>
  );
}
