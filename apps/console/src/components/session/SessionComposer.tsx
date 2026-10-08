import { Navigation, Plus, Send } from 'lucide-react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionDisplayStatus } from './conversation';

/**
 * The message composer at the foot of the session timeline. A terminal or
 * archived session renders a closed notice with a link to start a new one;
 * an idle session explains a retry-exhausted or budget stop inline because
 * both resolve through this composer (send again, or raise the budget).
 */
export function SessionComposer({
  displayStatus,
  idleStopReason,
  messageDraft,
  messageError,
  sendingMessage,
  canSendMessage,
  sendMode,
  onSendMode,
  onDraft,
  onSend,
  onNewSession,
  onAdjustBudget,
}: {
  displayStatus: SessionDisplayStatus;
  idleStopReason: string | undefined;
  messageDraft: string;
  messageError: string;
  sendingMessage: boolean;
  canSendMessage: boolean;
  sendMode: 'message' | 'steer';
  onSendMode: (mode: 'message' | 'steer') => void;
  onDraft: (value: string) => void;
  onSend: (event?: FormEvent) => void;
  onNewSession: () => void;
  onAdjustBudget: () => void;
}) {
  const { t } = useTranslation('sessions');
  if (displayStatus === 'terminated' || displayStatus === 'archived') {
    return (
      <div className="sessionComposerClosed" role="note">
        <span>
          {t('detail.composer.closed', { status: displayStatus })}
        </span>
        <button className="button secondary" type="button" onClick={onNewSession}>
          <Plus size={16} />{t('detail.composer.newSession')}
        </button>
      </div>
    );
  }
  return (
    <form className="sessionComposer" onSubmit={(event) => onSend(event)}>
      {displayStatus === 'idle' && idleStopReason === 'retries_exhausted' ? (
        <div className="sessionComposerHint" role="note">
          {t('detail.composer.retriesExhausted')}
        </div>
      ) : null}
      {displayStatus === 'idle' && idleStopReason === 'budget_reached' ? (
        <div className="sessionComposerHint" role="note">
          {t('detail.composer.budgetReached')}
          <button className="linkButton" type="button" onClick={onAdjustBudget}>{t('detail.composer.adjustBudget')}</button>
        </div>
      ) : null}
      {displayStatus === 'running' ? (
        <div className="segment compactSegment composerSendMode" role="group" aria-label={t('detail.composer.modeLabel')}>
          <button type="button" className={sendMode === 'message' ? 'active' : ''} onClick={() => onSendMode('message')}>
            {t('detail.composer.modeReply')}
          </button>
          <button type="button" className={sendMode === 'steer' ? 'active' : ''} onClick={() => onSendMode('steer')}>
            {t('detail.composer.modeSteer')}
          </button>
        </div>
      ) : null}
      {sendMode === 'steer' && displayStatus === 'running' ? (
        <div className="sessionComposerHint" role="note">
          {t('detail.composer.steerHint')}
        </div>
      ) : null}
      <textarea
        value={messageDraft}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSend();
          }
        }}
        placeholder={sendMode === 'steer' && displayStatus === 'running' ? t('detail.composer.steerPlaceholder') : t('detail.composer.placeholder')}
        aria-label={sendMode === 'steer' && displayStatus === 'running' ? t('detail.composer.steerPlaceholder') : t('detail.composer.placeholder')}
        disabled={sendingMessage}
      />
      <button className="button primary" type="submit" disabled={!canSendMessage}>
        {sendMode === 'steer' && displayStatus === 'running' ? <Navigation size={16} /> : <Send size={16} />}
        {sendingMessage
          ? t('detail.composer.sending')
          : sendMode === 'steer' && displayStatus === 'running'
            ? t('detail.composer.sendSteer')
            : t('detail.composer.send')}
      </button>
      {messageError ? <div className="sessionComposerError">{messageError}</div> : null}
    </form>
  );
}
