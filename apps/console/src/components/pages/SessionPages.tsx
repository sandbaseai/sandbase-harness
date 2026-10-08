import { Plus, Send, Target } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { deleteJson, postJson } from '../../api';
import { StatusDot, type Tone } from '../console-ui';
import { ConfirmDeleteModal } from '../DangerZone';
import { DefineOutcomeModal, SessionResourcesModal, SessionSettingsModal } from '../modals/SessionModals';
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

function outcomeTone(result: string): Tone {
  if (result === 'satisfied') return 'ok';
  if (result === 'pending' || result === 'evaluating') return 'pending';
  if (result === 'failed') return 'danger';
  return 'neutral';
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
  const { t } = useTranslation('sessions');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [defineOutcomeOpen, setDefineOutcomeOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  const [messageDraft, setMessageDraft] = useState('');
  const [messageError, setMessageError] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [sendMode, setSendMode] = useState<'message' | 'steer'>('message');
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

  // The usage receipt rides the latest `session.usage` snapshot; the session
  // row's own usage totals are the fallback while no snapshot has landed.
  const usageEvent = [...events].reverse().find((event) => event.type === 'session.usage' && event.usage);
  const usageReceipt = usageEvent?.usage
    ? {
        inputTokens: usageEvent.usage.input_tokens ?? 0,
        outputTokens: usageEvent.usage.output_tokens ?? 0,
        costAmount: usageEvent.usage.list_cost?.amount,
        costCurrency: usageEvent.usage.list_cost?.currency,
      }
    : session.usage
      ? { inputTokens: session.usage.input_tokens, outputTokens: session.usage.output_tokens }
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

  /**
   * A steer is not a turn: it writes the drafted text to the turn in flight
   * under a fresh idempotency key, and the receipt — not the request — says
   * whether the engine heard it. `delivered` and `duplicate` both mean the
   * engine holds the instruction; everything else surfaces the returned
   * detail, and `outcome_unknown` is deliberately never retried by the client.
   */
  const sendSteer = async () => {
    const text = messageDraft.trim();
    if (!text || sendingMessage) return;
    setSendingMessage(true);
    setMessageError('');
    try {
      const response = await postJson<{ accepted: boolean; steer?: { input_id: string; state: string; turn_id?: string; detail?: string } }>(
        `/v1/sessions/${encodeURIComponent(session.id)}/events`,
        { events: [{ type: 'user.steer', input_id: crypto.randomUUID(), text }] },
      );
      const state = response.steer?.state ?? (response.accepted ? 'delivered' : 'rejected');
      if (state === 'delivered' || state === 'duplicate') {
        setMessageDraft('');
      } else {
        const fallback =
          state === 'conflict'
            ? t('detail.composer.steerState.conflict')
            : state === 'outcome_unknown'
              ? t('detail.composer.steerState.outcome_unknown')
              : t('detail.composer.steerState.rejected');
        setMessageError(response.steer?.detail ?? fallback);
      }
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
    await deleteJson(`/v1/sessions/${encodeURIComponent(session.id)}`);
    onBack();
    onRefresh();
  };

  const composer = (
    <SessionComposer
      displayStatus={displayStatus}
      idleStopReason={idleStopReason}
      messageDraft={messageDraft}
      messageError={messageError}
      sendingMessage={sendingMessage}
      canSendMessage={canSendMessage}
      sendMode={sendMode}
      onSendMode={setSendMode}
      onDraft={setMessageDraft}
      onSend={(event) => {
        event?.preventDefault();
        if (sendMode === 'steer' && displayStatus === 'running') {
          void sendSteer();
        } else {
          void sendMessage();
        }
      }}
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
        usage={usageReceipt}
        onBack={onBack}
        onOpenAgent={onOpenAgent}
        onSettings={() => setSettingsOpen(true)}
        onDefineOutcome={() => setDefineOutcomeOpen(true)}
        onResources={() => setResourcesOpen(true)}
        onInterrupt={() => void interrupt()}
        onArchive={() => void archive()}
        onDelete={() => setDeleteConfirmOpen(true)}
      />

      {(session.outcome_evaluations ?? []).length > 0 ? (
        <div className="outcomeStrip" aria-label={t('detail.outcome.evaluations')}>
          {(session.outcome_evaluations ?? []).map((evaluation) => (
            <div key={evaluation.outcome_id} className="outcomeCard">
              <div className="outcomeCardHead">
                <Target size={15} />
                <strong>{evaluation.description}</strong>
                <StatusDot tone={outcomeTone(evaluation.result)} label={evaluation.result} />
              </div>
              <div className="outcomeCardMeta">
                <span>{t('detail.outcome.iteration', { n: evaluation.iteration })}</span>
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

      {resourcesOpen ? (
        <SessionResourcesModal
          session={session}
          data={data}
          onClose={() => setResourcesOpen(false)}
          onChanged={onRefresh}
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
        <ConfirmDeleteModal
          title={t('detail.deleteTitle')}
          subject={`${session.title || session.id} (${shortId(session.id)})`}
          consequence={t('detail.deleteConsequence')}
          confirmLabel={t('detail.deleteConfirm')}
          onClose={() => setDeleteConfirmOpen(false)}
          onConfirm={deleteSession}
        />
      ) : null}
    </section>
  );
}
