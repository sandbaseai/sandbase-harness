import { Plus, Send } from 'lucide-react';
import type { FormEvent } from 'react';
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
  onDraft: (value: string) => void;
  onSend: (event?: FormEvent) => void;
  onNewSession: () => void;
  onAdjustBudget: () => void;
}) {
  if (displayStatus === 'terminated' || displayStatus === 'archived') {
    return (
      <div className="sessionComposerClosed" role="note">
        <span>
          This session is {displayStatus} and cannot receive new messages. Start a new session to continue.
        </span>
        <button className="secondaryButton" type="button" onClick={onNewSession}>
          <Plus size={16} />New session
        </button>
      </div>
    );
  }
  return (
    <form className="sessionComposer" onSubmit={(event) => onSend(event)}>
      {displayStatus === 'idle' && idleStopReason === 'retries_exhausted' ? (
        <div className="sessionComposerHint" role="note">
          Retries were exhausted for the last turn. The conversation is kept — send a message to continue.
        </div>
      ) : null}
      {displayStatus === 'idle' && idleStopReason === 'budget_reached' ? (
        <div className="sessionComposerHint" role="note">
          This session stopped at its budget ceiling.
          <button className="textButton" type="button" onClick={onAdjustBudget}>Adjust budget</button>
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
}
