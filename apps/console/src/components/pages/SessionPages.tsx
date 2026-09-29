import { Archive, ChevronDown, Clock, Cloud, Copy, Download, Keyboard, MessageSquare, Monitor, Plus, Search, Send, Square, X } from 'lucide-react';
import { type Dispatch, type FormEvent, type ReactNode, type SetStateAction, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { deleteJson, getPage, postJson, readEventStream } from '../../api';
import { EmptyState, FilterSelect, LoadingState, ResourceBadge, StatusPill, Toolbar } from '../Common';
import { downloadJson, formatDateShort, formatDuration, formatUsage, relativeDate, shortId, titleCase, truncateMiddle } from '../../lib/format';
import { safeMarkdownUrl } from '../../lib/markdown';
import { contiguousSessionSequence, mergeOrderedSessionEvents } from '../../lib/ordered-session-events';
import type { Agent, ConsoleData, Session, SessionEvent, ToolPermission } from '../../types';

const SESSION_EVENT_KINDS = ['user', 'agent', 'tool', 'error', 'system'] as const;
type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number];
type SessionDisplayStatus = Session['status'] | 'queued' | 'completed' | 'requires_action';

/**
 * Markdown renderer used for assistant messages.  Keep code blocks as a
 * first-class, copyable surface while leaving inline code inline.  The
 * renderer intentionally relies on react-markdown's safe AST pipeline rather
 * than injecting HTML into the conversation.
 */
function MarkdownCode(props: { children?: ReactNode; className?: string }) {
  return <code className={props.className}>{props.children}</code>;
}

function MarkdownPre(props: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const text = preRef.current?.textContent ?? '';
    if (!text) return;
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="markdownCodeBlock">
      <div className="markdownCodeHeader">
        <span>Code</span>
        <button type="button" onClick={() => void copy()} aria-label="Copy code">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre ref={preRef}>{props.children}</pre>
    </div>
  );
}

function MarkdownLink(props: { href?: string; children?: ReactNode }) {
  const external = Boolean(props.href && /^https?:\/\//i.test(props.href));
  return (
    <a
      href={props.href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noreferrer' : undefined}
    >
      {props.children}
    </a>
  );
}

function MarkdownMessage({ text }: { text: string }) {
  const normalizedText = normalizeMarkdownText(text);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={safeMarkdownUrl}
      components={{ code: MarkdownCode, pre: MarkdownPre, a: MarkdownLink }}
    >
      {normalizedText || 'No message content.'}
    </ReactMarkdown>
  );
}

export function Sessions({ data, onNewSession, onOpenSession }: { data: ConsoleData; onNewSession: () => void; onOpenSession: (session: Session) => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('active');
  const [agentId, setAgentId] = useState('all');
  const sessions = data.sessions.filter((session) => {
    const q = query.toLowerCase();
    const matchesStatus = status === 'all' || (status === 'active'
      ? !session.archived_at && session.status !== 'terminated'
      : session.status === status);
    const matchesAgent = agentId === 'all' || session.agent.id === agentId;
    const matchesQuery = session.id.toLowerCase().includes(q) || session.agent.name.toLowerCase().includes(q) || (session.title ?? '').toLowerCase().includes(q);
    return matchesStatus && matchesAgent && matchesQuery;
  });
  return (
    <section className="stack">
      <div className="pageIntro">
        <div>
          <h1>Sessions</h1>
          <p>Trace and debug managed agent sessions.</p>
        </div>
        <button className="darkButton" type="button" onClick={onNewSession}>
          <Plus size={18} />
          Create session
        </button>
      </div>
      <Toolbar
        query={query}
        onQuery={setQuery}
        placeholder="Search by session ID"
        actions={(
          <>
            <FilterSelect label="Created" value="all" onChange={() => undefined} options={[{ value: 'all', label: 'All time' }]} />
            <FilterSelect
              label="Agent"
              value={agentId}
              onChange={setAgentId}
              options={[
                { value: 'all', label: 'All' },
                ...data.agents.map((agent) => ({ value: agent.id, label: agent.name })),
              ]}
            />
            <FilterSelect label="Deployment" value="all" onChange={() => undefined} options={[{ value: 'all', label: 'All' }]} />
            <FilterSelect
              label="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'all', label: 'All' },
                { value: 'idle', label: 'Idle' },
                { value: 'running', label: 'Running' },
                { value: 'failed', label: 'Failed' },
                { value: 'terminated', label: 'Terminated' },
              ]}
            />
          </>
        )}
      />
      <div className="tablePanel sessionsTablePanel">
        <table className="sessionTable">
          <thead>
            <tr>
              <th className="selectCol"><input type="checkbox" aria-label="Select all sessions" /></th>
              <th>ID</th>
              <th>Name</th>
              <th>Status</th>
              <th>Agent</th>
              <th>Tokens in / out</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id} className="clickableRow" onClick={() => onOpenSession(session)}>
                <td className="selectCol" onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`Select ${session.id}`} /></td>
                <td>
                  <strong className="monoText">{shortId(session.id)}</strong>
                </td>
                <td>{session.title || '-'}</td>
                <td><StatusPill status={session.status} /></td>
                <td><ResourceBadge icon={<Monitor size={15} />} label={session.agent.name} /></td>
                <td>{formatUsage(session.usage)}</td>
                <td>{formatDateShort(session.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {sessions.length === 0 ? <EmptyState icon={<MessageSquare size={22} />} title="No sessions" /> : null}
      </div>
      <div className="mobileSessionList">
        {sessions.map((session) => (
          <button className="mobileAgentCard" type="button" key={session.id} onClick={() => onOpenSession(session)}>
            <span className="mobileAgentMain">
              <strong>{session.title || session.id}</strong>
              <small className="monoText">{session.id}</small>
            </span>
            <span className="mobileAgentMeta">
              <span>{session.agent.name}</span>
              <StatusPill status={session.status} />
            </span>
          </button>
        ))}
        {sessions.length === 0 ? <EmptyState icon={<MessageSquare size={22} />} title="No sessions" /> : null}
      </div>
    </section>
  );
}

export function SessionDetail({
  session,
  data,
  onBack,
  onRefresh,
  onOpenAgent,
  onNewSession,
}: {
  session: Session;
  data: ConsoleData;
  onBack: () => void;
  onRefresh: () => void;
  onOpenAgent: (agent: Agent) => void;
  onNewSession: (agentId?: string) => void;
}) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [eventError, setEventError] = useState('');
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [mode, setMode] = useState<'transcript' | 'debug'>('transcript');
  const [detailMode, setDetailMode] = useState<'rendered' | 'raw'>('rendered');
  const [filterOpen, setFilterOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [selectedKinds, setSelectedKinds] = useState<Set<SessionEventKind>>(new Set(SESSION_EVENT_KINDS));
  const [query, setQuery] = useState('');
  const [messageDraft, setMessageDraft] = useState('');
  const [messageError, setMessageError] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [confirmingToolIds, setConfirmingToolIds] = useState<Set<string>>(new Set());
  // Confirmations accepted by the API. Kept forever so a card stays collapsed
  // while the backend is still writing the tool_result (it would otherwise
  // flash back open until the next poll pairs the result).
  const [confirmedToolIds, setConfirmedToolIds] = useState<Set<string>>(new Set());
  // A ref closes the small gap before React commits the state update. This
  // makes Allow/Deny one-shot even when a user double-clicks the button.
  const confirmingToolIdsRef = useRef(new Set<string>());
  const [streamingText, setStreamingText] = useState<Record<string, string>>({});
  const [streamConnection, setStreamConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  // Only the durable tail stream owns this cursor. Transient chunks are never
  // used for Last-Event-ID because their seq is 0 and they are not replayable.
  const lastDurableSequence = useRef(0);
  const eventsRef = useRef<SessionEvent[]>([]);
  const conversationListRef = useRef<HTMLDivElement>(null);
  const shouldFollowConversation = useRef(true);
  const initialScrollDoneRef = useRef(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const agent = data.agents.find((item) => item.id === session.agent.id);
  const environment = data.environments.find((item) => item.id === session.environment_id);
  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? events[0] ?? null;
  const displayStatus = sessionDisplayStatus(session, events);
  const allEventKindsSelected = selectedKinds.size === SESSION_EVENT_KINDS.length;
  const eventFilterLabel = allEventKindsSelected
    ? 'All events'
    : selectedKinds.size === 0
      ? 'No events'
      : `${selectedKinds.size} event${selectedKinds.size === 1 ? '' : 's'}`;

  const loadEvents = async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setLoadingEvents(true);
    setEventError('');
    try {
      const page = await getPage<SessionEvent>(`/v1/sessions/${encodeURIComponent(session.id)}/events?limit=1000`);
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
  }, [session.id]);

  const applyStreamEvent = (streamEvent: { event: string; data: unknown; id?: string }) => {
    // Keepalives are not events: the stream sends `ping`, and older servers sent
    // `heartbeat`. Neither may reach the projection below.
    if (streamEvent.event === 'ping' || streamEvent.event === 'heartbeat') return;
    const payload = streamEvent.data && typeof streamEvent.data === 'object'
      ? streamEvent.data as Partial<SessionEvent> & { message_id?: string; delta?: string }
      : null;
    if (!payload) return;

    // seq 0 is live-only text rendering. The durable agent.message appended at
    // step completion is the canonical transcript record and tail replay source.
    if (streamEvent.event === 'agent.message_stream_start' && payload.message_id) {
      setStreamingText((current) => ({ ...current, [payload.message_id as string]: '' }));
      return;
    }
    if (streamEvent.event === 'agent.message_chunk' && payload.message_id) {
      setStreamingText((current) => ({
        ...current,
        [payload.message_id as string]: `${current[payload.message_id as string] ?? ''}${payload.delta ?? ''}`,
      }));
      return;
    }
    if (streamEvent.event === 'agent.message_stream_end' && payload.message_id) {
      setStreamingText((current) => {
        const next = { ...current };
        delete next[payload.message_id as string];
        return next;
      });
      return;
    }

    if (!payload.id || !payload.type || typeof payload.seq !== 'number' || payload.seq <= 0) return;
    const merged = mergeOrderedSessionEvents(eventsRef.current, [payload as SessionEvent]);
    eventsRef.current = merged;
    lastDurableSequence.current = contiguousSessionSequence(merged);
    setEvents(merged);
    setSelectedEventId((current) => current ?? payload.id ?? null);

    if ((payload.type === 'agent.tool_use' || payload.type === 'agent.mcp_tool_use')
      && toolAwaitingConfirmation(toolUseDetails(payload as SessionEvent), false)) {
      setSendingMessage(false);
    }
    if (payload.type.startsWith('session.') || payload.type === 'agent.message') void onRefresh();
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
            `/v1/sessions/${encodeURIComponent(session.id)}/events/stream`,
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
  }, [session.id]);

  useEffect(() => {
    if (!['queued', 'running', 'requires_action'].includes(displayStatus)) return undefined;
    const timer = window.setInterval(() => {
      void loadEvents({ silent: true });
      void onRefresh();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [displayStatus, session.id, onRefresh]);

  useEffect(() => {
    // Entering a session always starts pinned to the latest message.
    initialScrollDoneRef.current = false;
    shouldFollowConversation.current = true;
  }, [session.id]);

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

  const canSendMessage = messageDraft.trim().length > 0
    && !sendingMessage
    && displayStatus !== 'terminated';

  useEffect(() => {
    if (displayStatus !== 'failed') return;
    const errorEvent = [...events].reverse().find((item) => eventKind(item) === 'error');
    if (errorEvent) setMessageError(eventText(errorEvent) || eventTitle(errorEvent));
  }, [displayStatus, events]);

  const sendMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = messageDraft.trim();
    if (!content || sendingMessage) return;
    setSendingMessage(true);
    setMessageError('');
    try {
      // The tail stream is the sole durable replay authority. This request is
      // an acknowledgment only; the append-only user event and all outcomes
      // arrive on the sequence-numbered tail stream (or its REST backfill).
      await postJson(
        `/v1/sessions/${encodeURIComponent(session.id)}/messages`,
        { content, stream: false },
      );
      setMessageDraft('');
      await loadEvents({ silent: true });
      onRefresh();
    } catch (err) {
      setMessageError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendingMessage(false);
    }
  };

  const confirmTool = async (toolUseId: string, result: 'allow' | 'deny') => {
    if (!beginToolConfirmation(confirmingToolIdsRef.current, toolUseId)) return;
    setConfirmingToolIds((current) => new Set(current).add(toolUseId));
    setMessageError('');
    try {
      await postJson(`/v1/sessions/${encodeURIComponent(session.id)}/events`, toolConfirmationPayload(toolUseId, result));
      setConfirmedToolIds((current) => new Set(current).add(toolUseId));
      await loadEvents({ silent: true });
      onRefresh();
    } catch (err) {
      setMessageError(err instanceof Error ? err.message : String(err));
    } finally {
      confirmingToolIdsRef.current.delete(toolUseId);
      setConfirmingToolIds((current) => {
        const next = new Set(current);
        next.delete(toolUseId);
        return next;
      });
    }
  };

  const interrupt = async () => {
    await postJson(`/v1/sessions/${encodeURIComponent(session.id)}/events`, { events: [{ type: 'user.interrupt', content: [{ type: 'text', text: 'Run interrupted by the user.' }] }] });
    setActionsOpen(false);
    await loadEvents({ silent: true });
    onRefresh();
  };

  const composer = displayStatus === 'terminated' ? (
    <div className="sessionComposerClosed" role="note">
      <span>
        This session is {displayStatus} and cannot receive new messages. Start a new session to continue.
      </span>
      <button className="secondaryButton" type="button" onClick={() => onNewSession(session.agent.id)}>
        <Plus size={16} />New session
      </button>
    </div>
  ) : (
    <form className="sessionComposer" onSubmit={(event) => void sendMessage(event)}>
      {displayStatus === 'failed' ? (
        <div className="sessionComposerHint" role="note">
          The last turn failed. Send a message to retry — the conversation is kept.
        </div>
      ) : null}
      <textarea
        value={messageDraft}
        onChange={(event) => setMessageDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void sendMessage();
          }
        }}
        placeholder="Message this session..."
        aria-label="Message this session"
        disabled={sendingMessage}
      />
      <button className="primaryButton" type="submit" disabled={!canSendMessage}>
        <Send size={16} />
        {sendingMessage ? 'Sending...' : 'Send'}
      </button>
      {messageError ? <div className="sessionComposerError">{messageError}</div> : null}
    </form>
  );

  const archive = async () => {
    await deleteJson(`/v1/sessions/${session.id}`);
    setActionsOpen(false);
    onBack();
    onRefresh();
  };

  return (
    <section className="sessionDetail">
      <div className="sessionCrumb">
        <button type="button" className="textButton" onClick={onBack}>Sessions</button>
        <span>/</span>
        <strong>{shortId(session.id)}</strong>
      </div>

      <div className="sessionHero">
        <div className="sessionHeroMain">
          <div className="titleLine">
            <h1>{session.id}</h1>
            <StatusPill status={displayStatus} />
          </div>
          <div className="sessionMetaRow">
            <button className="resourceBadge" type="button" onClick={() => agent ? onOpenAgent(agent) : undefined}>
              <Monitor size={15} />
              {session.agent.name}
            </button>
            <ResourceBadge icon={<Cloud size={15} />} label={environment?.name ?? session.environment_id} />
            <span className="sessionTimeMeta"><Clock size={15} /><span>{relativeDate(session.created_at)} · {formatDuration(session.created_at, session.updated_at)}</span></span>
          </div>
        </div>
        <div className="sessionHeroActions">
          <div className="menuWrap">
            <button className="secondaryButton largeAction" type="button" onClick={() => setActionsOpen((open) => !open)}>
              Actions <ChevronDown size={16} />
            </button>
            {actionsOpen ? (
              <div className="agentMenu sessionActionsMenu">
                <button type="button" onClick={() => void interrupt()}><Square size={18} />Send interrupt</button>
                <button type="button" className="dangerMenuItem" onClick={() => void archive()}><Archive size={18} />Archive session</button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

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
          <button className="iconButton" type="button" title="Copy session id" onClick={() => void navigator.clipboard?.writeText(session.id)}><Copy size={18} /></button>
          <button className="iconButton" type="button" title="Download event JSON" onClick={() => downloadJson(`${session.id}-events.json`, events)}><Download size={18} /></button>
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
                    onConfirm={(toolUseId, result) => void confirmTool(toolUseId, result)}
                  />
                ) : (
                  <article key={entry.id} className={`conversationMessage ${entry.role}`}>
                    <div className="conversationMessageMeta">
                      <span>{entry.role === 'user' ? 'You' : entry.role === 'error' ? 'Session' : agent?.name ?? 'Agent'}</span>
                      <time>{eventTime(entry.event)}</time>
                    </div>
                    <div className="conversationBubble">
                      {entry.role === 'agent'
                        ? (
                          <MarkdownMessage text={entry.text} />
                        )
                        : (entry.text || 'No message content.')}
                    </div>
                  </article>
                ))}
                {Object.entries(streamingText).map(([messageId, text]) => (
                  <article key={messageId} className="conversationMessage agent streamingMessage">
                    <div className="conversationMessageMeta"><span>{agent?.name ?? 'Agent'}</span><span>Generating…</span></div>
                    <div className="conversationBubble">{text || <span className="typingIndicator" aria-label="Generating"><i /><i /><i /></span>}</div>
                  </article>
                ))}
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
                  <button type="button" key={event.id} className={`eventRow ${selectedEvent?.id === event.id ? 'active' : ''}`} onClick={() => setSelectedEventId(event.id)}>
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
                      <button className="iconButton" type="button" title="Close selection" onClick={() => setSelectedEventId(null)}><X size={18} /></button>
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
    </section>
  );
}

function DebugEventContent({ event }: { event: SessionEvent }) {
  const text = eventText(event);
  const kind = eventKind(event);
  const isMarkdown = event.type === 'agent.message' || event.type === 'agent.thinking';
  const facts = eventFacts(event);

  if (isMarkdown) {
    return <div className="conversationBubble debugConversationBubble"><MarkdownMessage text={text} /></div>;
  }

  if (kind === 'tool' && event.content?.length) {
    return (
      <div className="renderedEvent debugEventBody">
        <p>{eventSummary(event)}</p>
        <pre>{formatToolValue(event.content)}</pre>
      </div>
    );
  }

  return (
    <div className="renderedEvent debugEventSummary">
      <p>{text || eventSummary(event)}</p>
      {facts.length ? (
        <dl className="debugEventFacts">
          {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      ) : null}
    </div>
  );
}

function eventFacts(event: SessionEvent): Array<[string, string]> {
  const facts: Array<[string, string]> = [];
  if (event.model_used) facts.push(['Model', event.model_used]);
  if (event.duration_ms !== undefined) facts.push(['Duration', formatMilliseconds(event.duration_ms)]);
  if (event.tokens_in !== undefined || event.tokens_out !== undefined) {
    facts.push(['Tokens', `${event.tokens_in ?? 0} in · ${event.tokens_out ?? 0} out`]);
  }
  if (event.stop_reason) facts.push(['Stop reason', event.stop_reason]);
  if (event.parent_event_id) facts.push(['Parent event', shortId(event.parent_event_id)]);
  return facts;
}

function formatMilliseconds(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} s`;
}

function eventSummary(event: SessionEvent): string {
  if (event.type === 'span.model_request_start') return 'Model request started and is being processed.';
  if (event.type === 'span.model_request_end') return 'Model request completed.';
  if (event.type.startsWith('session.status_')) return `Session lifecycle update: ${titleCase(event.type.replace('session.status_', ''))}.`;
  if (event.type === 'agent.thinking') return 'Agent reasoning trace.';
  if (event.type === 'user.tool_confirmation') return 'Tool confirmation decision recorded.';
  return `Event recorded as ${titleCase(event.type.replaceAll('.', ' ').replaceAll('_', ' '))}.`;
}


function toggleSet<T>(value: T, checked: boolean, setter: Dispatch<SetStateAction<Set<T>>>) {
  setter((current) => {
    const next = new Set(current);
    if (checked) next.add(value);
    else next.delete(value);
    return next;
  });
}

function eventKind(event: SessionEvent): 'user' | 'agent' | 'tool' | 'error' | 'system' {
  if (event.type.startsWith('user.')) return 'user';
  if (event.type.startsWith('agent.')) return event.type.includes('tool') ? 'tool' : 'agent';
  if (event.type.includes('tool') || event.type.includes('mcp')) return 'tool';
  if (event.type.includes('error') || event.type.includes('failed')) return 'error';
  return 'system';
}

function eventLabel(event: SessionEvent, mode: 'transcript' | 'debug') {
  if (mode === 'debug') return truncateMiddle(event.type, 22);
  const kind = eventKind(event);
  return kind[0].toUpperCase() + kind.slice(1);
}

function eventTitle(event: SessionEvent) {
  const text = eventText(event);
  if (event.type === 'user.message') return text || 'User message';
  if (event.type === 'agent.message') return 'Agent message';
  if (event.type === 'user.interrupt') return 'Interrupted';
  if (event.type === 'session.error') return text || 'Session error';
  if (event.type.includes('model') && event.type.endsWith('start')) return 'Model request start';
  if (event.type.includes('model') && event.type.endsWith('end')) return text ? `Model request stop (${text})` : 'Model request stop';
  return titleCase(event.type.replaceAll('.', ' ').replaceAll('_', ' '));
}

function eventText(event: SessionEvent) {
  if (event.delta) return event.delta;
  const content = normalizeEventContent(event.content);
  if (content.length === 0) return '';
  return content.map((part) => {
    if (part && typeof part === 'object') {
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (typeof record.message === 'string') return record.message;
      if (typeof record.error === 'string') return record.error;
    }
    return typeof part === 'string' ? part : JSON.stringify(part);
  }).join('\n');
}

function normalizeEventContent(content: SessionEvent['content']): unknown[] {
  if (Array.isArray(content)) return content;
  if (content === null || content === undefined) return [];
  return [content];
}

type ConversationMessage = {
  id: string;
  role: 'user' | 'agent' | 'error';
  text: string;
  event: SessionEvent;
};

/**
 * Tool card for the conversation transcript.
 *
 * While the tool call is awaiting user approval the card opens automatically
 * so the Allow/Deny buttons are visible without a manual click. Once the
 * confirmation is submitted (or a result arrives) the card collapses again.
 * A manual toggle by the user is respected until the awaiting state changes.
 */
function ConversationToolCard({
  entry,
  confirmingToolIds,
  confirmedToolIds,
  onConfirm,
}: {
  entry: Extract<ConversationEntry, { role: 'tool' }>;
  confirmingToolIds: Set<string>;
  confirmedToolIds: Set<string>;
  onConfirm: (toolUseId: string, result: 'allow' | 'deny') => void;
}) {
  const awaiting = Boolean(
    entry.awaitingConfirmation
      && entry.toolUseId
      && !confirmingToolIds.has(entry.toolUseId)
      && !confirmedToolIds.has(entry.toolUseId),
  );
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const prevAwaitingRef = useRef(awaiting);
  useEffect(() => {
    if (prevAwaitingRef.current !== awaiting) {
      prevAwaitingRef.current = awaiting;
      setUserOpen(null);
    }
  }, [awaiting]);
  const open = userOpen ?? awaiting;
  return (
    <article className="conversationMessage tool">
      <details
        className="conversationToolCard"
        open={open}
        onToggle={(event) => {
          const next = (event.target as HTMLDetailsElement).open;
          if (next !== awaiting) setUserOpen(next);
        }}
      >
        <summary>
          <span className="conversationToolSummaryMain">
            <span className="conversationToolChevron" aria-hidden="true">›</span>
            <strong>{entry.operation}</strong>
            <span className="conversationToolName">{entry.toolName}</span>
          </span>
          <span className={`conversationToolStatus ${entry.status}`}>
            {entry.status === 'running' ? 'Running' : entry.status === 'awaiting' ? 'Waiting' : entry.status === 'failed' ? 'Failed' : 'Completed'}
          </span>
          <time>{eventTime(entry.event)}</time>
        </summary>
        <div className="conversationToolDetails">
          <div className="conversationToolField">
            <span>Tool</span>
            <code>{entry.toolName}</code>
          </div>
          <div className="conversationToolField">
            <span>Tool use ID</span>
            <code>{entry.toolUseId ?? 'Unknown'}</code>
          </div>
          <div className="conversationToolField">
            <span>Parameters</span>
            <pre className="conversationToolValue conversationToolParameters">{formatToolValue(entry.input)}</pre>
          </div>
          <div className="conversationToolField">
            <span>Result</span>
            <pre className="conversationToolValue conversationToolResult">{entry.result || 'No result yet.'}</pre>
          </div>
        </div>
        {entry.awaitingConfirmation && entry.toolUseId ? (
          <div className="conversationToolApproval">
            <span>Waiting for your approval</span>
            <button
              type="button"
              className="secondaryButton"
              disabled={confirmingToolIds.has(entry.toolUseId)}
              onClick={() => onConfirm(entry.toolUseId!, 'deny')}
            >
              {confirmingToolIds.has(entry.toolUseId) ? 'Submitting…' : 'Deny'}
            </button>
            <button
              type="button"
              className="primaryButton"
              disabled={confirmingToolIds.has(entry.toolUseId)}
              onClick={() => onConfirm(entry.toolUseId!, 'allow')}
            >
              {confirmingToolIds.has(entry.toolUseId) ? 'Submitting…' : 'Allow'}
            </button>
          </div>
        ) : null}
      </details>
    </article>
  );
}

type ConversationEntry = ConversationMessage | {
  id: string;
  role: 'tool';
  operation: string;
  toolName: string;
  input?: unknown;
  result: string;
  status: 'running' | 'awaiting' | 'completed' | 'failed';
  event: SessionEvent;
  toolUseId?: string;
  awaitingConfirmation?: boolean;
  requiresConfirmation?: boolean;
  permission?: ToolPermission;
};

function conversationMessages(events: SessionEvent[]): ConversationMessage[] {
  return events
    .filter((event) => event.type === 'user.message' || event.type === 'agent.message' || event.type === 'session.error' || event.type === 'user.interrupt')
    .map((event) => ({
      id: event.id,
      role: event.type === 'user.message' ? 'user' : event.type === 'session.error' ? 'error' : 'agent',
      text: event.type === 'user.interrupt' ? 'Run interrupted by the user.' : eventText(event),
      event,
    }));
}

function normalizeMarkdownText(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  const lines = normalized.split('\n');
  const output: string[] = [];
  let inFence = false;
  let pendingBlank = false;
  for (const line of lines) {
    const isFence = /^\s*(```|~~~)/.test(line);
    if (!inFence && line.trim() === '') {
      pendingBlank = output.length > 0;
      continue;
    }
    if (pendingBlank && output.length > 0 && output.at(-1) !== '') output.push('');
    pendingBlank = false;
    output.push(line);
    if (isFence) inFence = !inFence;
  }
  return output.join('\n').trim();
}

export function conversationEntries(events: SessionEvent[]): ConversationEntry[] {
  const resultByToolId = new Map<string, { event: SessionEvent; text: string; failed: boolean }>();
  // Confirmation events are append-only even when the backend ignores a stale
  // one, so they are the durable record that a tool id was already confirmed —
  // unlike component state, this survives refreshes and remounts.
  const confirmedToolUseIds = new Set<string>();
  for (const event of events) {
    if (event.type === 'user.tool_confirmation' && event.tool_use_id) {
      confirmedToolUseIds.add(event.tool_use_id);
    }
    const id = toolResultId(event);
    if (!id) continue;
    resultByToolId.set(id, {
      event,
      text: toolResultText(event),
      failed: toolResultFailed(event),
    });
  }
  const toolUseIds = new Set(events.map(toolUseIdFromEvent).filter((id): id is string => Boolean(id)));
  const entries: ConversationEntry[] = [];
  for (const event of events) {
    if (event.type.includes('tool_result')) {
      const resultId = toolResultId(event);
      // A paired result is rendered with its tool_use row. Preserve an
      // orphaned result in its original position so a partial stream remains
      // truthful instead of moving evidence to the end of the transcript.
      if (resultId && toolUseIds.has(resultId)) continue;
      const orphan = resultId ? resultByToolId.get(resultId) : undefined;
      const orphanDetails = toolResultDetails(event);
      entries.push({
        id: event.id,
        role: 'tool',
        operation: toolOperation(orphanDetails.toolName),
        toolName: orphanDetails.toolName,
        input: undefined,
        result: orphan?.text ?? toolResultText(event),
        status: orphan?.failed || toolResultFailed(event) ? 'failed' : 'completed',
        event,
        ...(resultId ? { toolUseId: resultId } : {}),
      });
      continue;
    }
    if (event.type === 'user.message' || event.type === 'agent.message' || event.type === 'session.error' || event.type === 'user.interrupt') {
      entries.push({
        id: event.id,
        role: event.type === 'user.message' ? 'user' : event.type === 'session.error' ? 'error' : 'agent',
        text: event.type === 'user.interrupt' ? 'Run interrupted by the user.' : eventText(event),
        event,
      });
      continue;
    }
    if (eventKind(event) !== 'tool') continue;
    const details = toolUseDetails(event);
    const toolUseId = details.toolUseId;
    const result = toolUseId ? resultByToolId.get(toolUseId) : undefined;
    // Tool Runtime is the authority. A result-less tool use is actionable only
    // when the event carries explicit confirmation metadata and no
    // confirmation has been recorded yet. This also works when the API maps
    // `requires_action` to `idle` in the session status.
    const awaitingConfirmation = toolAwaitingConfirmation(details, Boolean(result), confirmedToolUseIds.has(details.toolUseId ?? ''));
    entries.push({
      id: event.id,
      role: 'tool',
      operation: toolOperation(details.toolName),
      toolName: details.toolName,
      input: details.input,
      result: result?.text ?? '',
      status: awaitingConfirmation ? 'awaiting' : result ? (result.failed ? 'failed' : 'completed') : 'running',
      event,
      ...(toolUseId ? { toolUseId, awaitingConfirmation } : {}),
      ...(details.requiresConfirmation !== undefined ? { requiresConfirmation: details.requiresConfirmation } : {}),
      ...(details.permission ? { permission: details.permission } : {}),
    });
  }
  return entries;
}

export function toolAwaitingConfirmation(
  details: Pick<ReturnType<typeof toolUseDetails>, 'requiresConfirmation' | 'permission' | 'toolUseId'>,
  hasResult: boolean,
  alreadyConfirmed = false,
): boolean {
  return Boolean(
    details.toolUseId
      && !hasResult
      && !alreadyConfirmed
      && (details.requiresConfirmation === true || details.permission === 'always_ask'),
  );
}

export function toolConfirmationPayload(toolUseId: string, result: 'allow' | 'deny') {
  return { events: [{ type: 'user.tool_confirmation' as const, tool_use_id: toolUseId, result }] };
}

/** Atomically claims a tool id for a confirmation submission. */
export function beginToolConfirmation(inFlight: Set<string>, toolUseId: string): boolean {
  if (inFlight.has(toolUseId)) return false;
  inFlight.add(toolUseId);
  return true;
}

export function toolUseDetails(event: SessionEvent): {
  toolName: string;
  toolUseId?: string;
  input?: unknown;
  requiresConfirmation?: boolean;
  permission?: ToolPermission;
} {
  const block = findToolBlock(event, ['tool_use', 'mcp_tool_use']);
  const record = block as Record<string, unknown> | undefined;
  const toolName = typeof record?.name === 'string'
    ? record.name
    : typeof record?.tool_name === 'string' ? record.tool_name : eventTitle(event);
  const toolUseId = typeof record?.id === 'string'
    ? record.id
    : typeof record?.tool_use_id === 'string'
      ? record.tool_use_id
      : typeof record?.mcp_tool_use_id === 'string' ? record.mcp_tool_use_id : toolUseIdFromEvent(event);
  const metadata = event.metadata;
  const requiresConfirmation = firstBoolean(
    record?.requires_confirmation,
    record?.requiresConfirmation,
    event.requires_confirmation,
    metadata?.requires_confirmation,
    metadata?.requiresConfirmation,
  );
  const permission = firstPermission(
    record?.permission,
    event.permission,
    metadata?.permission,
  );
  return {
    toolName,
    toolUseId,
    input: record?.input ?? record?.arguments ?? record?.args,
    ...(requiresConfirmation !== undefined ? { requiresConfirmation } : {}),
    ...(permission ? { permission } : {}),
  };
}

function toolResultDetails(event: SessionEvent): { toolName: string } {
  const block = findToolBlock(event, ['tool_result', 'mcp_tool_result']) as Record<string, unknown> | undefined;
  return { toolName: typeof block?.name === 'string' ? block.name : 'tool' };
}

function findToolBlock(event: SessionEvent, types: string[]): unknown {
  return normalizeEventContent(event.content).find((part) => part && typeof part === 'object' && types.includes(String((part as Record<string, unknown>).type)));
}

function toolResultText(event: SessionEvent): string {
  const block = findToolBlock(event, ['tool_result', 'mcp_tool_result']) as Record<string, unknown> | undefined;
  return formatToolText(block?.content ?? block?.output ?? block?.result ?? eventText(event));
}

function toolResultFailed(event: SessionEvent): boolean {
  const block = findToolBlock(event, ['tool_result', 'mcp_tool_result']) as Record<string, unknown> | undefined;
  return block?.is_error === true || block?.isError === true || event.is_error === true || event.isError === true
    || event.type.includes('error') || event.type.includes('failed');
}

function formatToolText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => formatToolText(part)).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
    return formatToolValue(value);
  }
  return value == null ? '' : String(value);
}

function formatToolValue(value: unknown): string {
  if (value === undefined) return 'No parameters.';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function toolOperation(toolName: string): string {
  const key = toolName.toLowerCase();
  if (key.includes('bash') || key.includes('shell') || key.includes('terminal') || key === 'exec') return 'bash';
  if (key.includes('read') || key.includes('view') || key.includes('cat')) return 'read';
  if (key.includes('replace') || key.includes('patch') || key.includes('edit') || key.includes('write') || key.includes('create')) return 'replace';
  if (key.includes('glob') || key.includes('list') || key.includes('ls')) return 'list';
  if (key.includes('grep') || key.includes('search')) return 'search';
  return toolName || 'tool';
}

function toolUseIdFromEvent(event: SessionEvent): string | undefined {
  const block = event.content?.find((part) => part && typeof part === 'object' && ['tool_use', 'mcp_tool_use'].includes(String((part as Record<string, unknown>).type))) as Record<string, unknown> | undefined;
  return typeof block?.id === 'string' ? block.id : event.tool_use_id ?? event.mcp_tool_use_id;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  const value = values.find((candidate) => typeof candidate === 'boolean');
  return typeof value === 'boolean' ? value : undefined;
}

function firstPermission(...values: unknown[]): ToolPermission | undefined {
  for (const candidate of values) {
    if (candidate === 'always_allow' || candidate === 'always_ask' || candidate === 'never_allow') return candidate;
    if (candidate && typeof candidate === 'object' && 'type' in candidate) {
      const type = (candidate as { type?: unknown }).type;
      if (type === 'always_allow' || type === 'always_ask' || type === 'never_allow') return type;
    }
  }
  return undefined;
}

export function toolResultId(event: SessionEvent): string | undefined {
  if (!event.type.includes('tool_result')) return undefined;
  const block = event.content?.find((part) => part && typeof part === 'object' && ['tool_result', 'mcp_tool_result'].includes(String((part as Record<string, unknown>).type))) as Record<string, unknown> | undefined;
  if (typeof block?.tool_use_id === 'string') return block.tool_use_id;
  if (typeof block?.mcp_tool_use_id === 'string') return block.mcp_tool_use_id;
  if (typeof block?.toolUseId === 'string') return block.toolUseId;
  if (typeof block?.mcpToolUseId === 'string') return block.mcpToolUseId;
  return event.tool_use_id ?? event.mcp_tool_use_id;
}

function sessionDisplayStatus(session: Session, events: SessionEvent[]): SessionDisplayStatus {
  // Session status is an authoritative server-side state-machine field. The
  // event log is used only to refine fresh lifecycle progress while a snapshot
  // is pending; tool cards never decide whether a session requires action.
  if (session.status === 'requires_action') return 'requires_action';
  if (session.status === 'terminated') return 'terminated';
  if (session.status === 'failed') return 'failed';
  if (session.status === 'running') return 'running';

  const lastStatus = [...events].reverse().find((event) => event.type.startsWith('session.status_'));
  if (!lastStatus) return session.status;
  if (lastStatus.type === 'session.status_running') return 'running';
  if (lastStatus.type === 'session.status_terminated') return 'terminated';
  return 'idle';
}

function eventTime(event: SessionEvent) {
  const value = event.processed_at ?? event.created_at;
  if (!value) return '-';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}
