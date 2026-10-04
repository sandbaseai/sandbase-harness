import { Plus, Send, Target } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { deleteJson, postJson } from '../../api';
import { StatusPill } from '../Common';
import { Modal } from '../Modal';
import { DefineOutcomeModal, SessionSettingsModal } from '../modals/SessionModals';
import { SessionComposer } from '../session/SessionComposer';
import { SessionHero } from '../session/SessionHero';
import { SessionTimeline } from '../session/SessionTimeline';
import { useSessionStream } from '../session/useSessionStream';
import { beginToolConfirmation, customToolResultPayload, toolConfirmationPayload } from '../session/conversation';
// Test and sibling consumers import these helpers from this module; the
// implementations live in `session/` since the F14 split. Keep the re-export
// so those imports keep resolving to the same functions.
export { Sessions } from './SessionsListPage';
export {
  conversationEntries,
  sessionDisplayStatus,
  toolAwaitingConfirmation,
  toolConfirmationPayload,
  customToolResultPayload,
  beginToolConfirmation,
} from '../session/conversation';
export { toolResultId, toolUseDetails } from '../session/eventRenderers';
import { relativeDate, shortId } from '../../lib/format';
import type { Agent, ConsoleData, Session } from '../../types';

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [defineOutcomeOpen, setDefineOutcomeOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [actionError, setActionError] = useState('');
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

  const agent = data.agents.find((item) => item.id === session.agent.id);
  const environment = data.environments.find((item) => item.id === session.environment_id);

  const {
    events,
    displayStatus,
    loadingEvents,
    eventError,
    selectedEventId,
    setSelectedEventId,
    streamingText,
    streamConnection,
    loadEvents,
  } = useSessionStream({
    session,
    onRefresh,
    onToolAwaiting: () => setSendingMessage(false),
  });
  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? events[0] ?? null;

  const canSendMessage = messageDraft.trim().length > 0
    && !sendingMessage
    && displayStatus !== 'terminated'
    && displayStatus !== 'archived';

  // An idle session still tells the operator why it stopped: retry exhaustion
  // and the budget ceiling both resolve through a message or a budget raise.
  const lastIdleEvent = [...events].reverse().find((event) => event.type === 'session.status_idle');
  const idleStopReason = lastIdleEvent && typeof lastIdleEvent.stop_reason === 'object'
    ? lastIdleEvent.stop_reason?.type
    : undefined;

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

  const submitCustomToolResult = async (toolUseId: string, customToolUseEventId: string, text: string, isError: boolean) => {
    if (!beginToolConfirmation(confirmingToolIdsRef.current, toolUseId)) return;
    setConfirmingToolIds((current) => new Set(current).add(toolUseId));
    setMessageError('');
    try {
      await postJson(`/v1/sessions/${encodeURIComponent(session.id)}/events`, customToolResultPayload(customToolUseEventId, text, isError));
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
    await loadEvents({ silent: true });
    onRefresh();
  };

  const archive = async () => {
    try {
      await postJson(`/v1/sessions/${encodeURIComponent(session.id)}/archive`, {});
      await loadEvents({ silent: true });
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteSession = async () => {
    try {
      await deleteJson(`/v1/sessions/${encodeURIComponent(session.id)}`);
      setDeleteConfirmOpen(false);
      onBack();
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      setDeleteConfirmOpen(false);
    }
  };

  const composer = (
    <SessionComposer
      displayStatus={displayStatus}
      idleStopReason={idleStopReason}
      messageDraft={messageDraft}
      messageError={messageError}
      sendingMessage={sendingMessage}
      canSendMessage={canSendMessage}
      onDraft={setMessageDraft}
      onSend={(event) => void sendMessage(event)}
      onNewSession={() => onNewSession(session.agent.id)}
      onAdjustBudget={() => setSettingsOpen(true)}
    />
  );

  return (
    <section className="sessionDetail">
      <SessionHero
        session={session}
        displayStatus={displayStatus}
        agent={agent}
        environmentName={environment?.name}
        onBack={onBack}
        onOpenAgent={onOpenAgent}
        onSettings={() => setSettingsOpen(true)}
        onDefineOutcome={() => setDefineOutcomeOpen(true)}
        onInterrupt={() => void interrupt()}
        onArchive={() => void archive()}
        onDelete={() => setDeleteConfirmOpen(true)}
      />

      {(session.outcome_evaluations ?? []).length > 0 ? (
        <div className="outcomeStrip" aria-label="Outcome evaluations">
          {(session.outcome_evaluations ?? []).map((evaluation) => (
            <div key={evaluation.outcome_id} className="outcomeCard">
              <div className="outcomeCardHead">
                <Target size={15} />
                <strong>{evaluation.description}</strong>
                <StatusPill status={evaluation.result} />
              </div>
              <div className="outcomeCardMeta">
                <span>iteration {evaluation.iteration}</span>
                {evaluation.completed_at ? <span>{relativeDate(evaluation.completed_at)}</span> : null}
              </div>
              {evaluation.explanation ? <p className="outcomeExplanation">{evaluation.explanation}</p> : null}
            </div>
          ))}
        </div>
      ) : null}

      <SessionTimeline
        sessionId={session.id}
        events={events}
        streamingText={streamingText}
        loadingEvents={loadingEvents}
        eventError={eventError}
        streamConnection={streamConnection}
        agentName={agent?.name}
        selectedEvent={selectedEvent}
        onSelectEvent={setSelectedEventId}
        confirmingToolIds={confirmingToolIds}
        confirmedToolIds={confirmedToolIds}
        onConfirm={(toolUseId, result) => void confirmTool(toolUseId, result)}
        onSubmitResult={(toolUseId, eventId, text, isError) => void submitCustomToolResult(toolUseId, eventId, text, isError)}
        composer={composer}
      />

      {actionError ? <div className="banner error inlineBanner">{actionError}</div> : null}

      {settingsOpen ? (
        <SessionSettingsModal
          session={session}
          idle={displayStatus === 'idle'}
          onClose={() => setSettingsOpen(false)}
          onSaved={async () => {
            setSettingsOpen(false);
            await loadEvents({ silent: true });
            onRefresh();
          }}
        />
      ) : null}

      {defineOutcomeOpen ? (
        <DefineOutcomeModal
          session={session}
          data={data}
          onClose={() => setDefineOutcomeOpen(false)}
          onSaved={async () => {
            setDefineOutcomeOpen(false);
            await loadEvents({ silent: true });
            onRefresh();
          }}
        />
      ) : null}

      {deleteConfirmOpen ? (
        <Modal
          title="Delete session"
          subtitle={`${session.title || session.id} (${shortId(session.id)})`}
          onClose={() => setDeleteConfirmOpen(false)}
        >
          <p className="modalBody">
            This permanently deletes the session, its event history, and files
            the session generated. The agent, environment, skills, vaults, and
            uploaded files are not affected.
          </p>
          <div className="modalActions">
            <button className="secondaryButton" type="button" onClick={() => setDeleteConfirmOpen(false)}>Cancel</button>
            <button className="dangerButton" type="button" onClick={() => void deleteSession()}>Delete session</button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
