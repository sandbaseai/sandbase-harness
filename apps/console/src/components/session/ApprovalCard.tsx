import { useEffect, useRef, useState } from 'react';
import { formatToolValue } from './eventRenderers';
import { eventTime, type ConversationEntry } from './conversation';

/**
 * Tool card for the conversation transcript.
 *
 * While the tool call is awaiting user approval the card opens automatically
 * so the Allow/Deny buttons are visible without a manual click. Once the
 * confirmation is submitted (or a result arrives) the card collapses again.
 * A manual toggle by the user is respected until the awaiting state changes.
 */
export function ConversationToolCard({
  entry,
  confirmingToolIds,
  confirmedToolIds,
  onConfirm,
  onSubmitResult,
}: {
  entry: Extract<ConversationEntry, { role: 'tool' }>;
  confirmingToolIds: Set<string>;
  confirmedToolIds: Set<string>;
  onConfirm: (toolUseId: string, result: 'allow' | 'deny') => void;
  onSubmitResult: (toolUseId: string, customToolUseEventId: string, text: string, isError: boolean) => void;
}) {
  const awaitingResult = Boolean(
    entry.awaitingResult && entry.toolUseId && !confirmedToolIds.has(entry.toolUseId),
  );
  const awaiting = Boolean(
    (entry.awaitingConfirmation || awaitingResult)
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
        {awaitingResult && entry.toolUseId ? (
          <CustomToolResultForm
            submitting={confirmingToolIds.has(entry.toolUseId)}
            onSubmit={(text, isError) => onSubmitResult(entry.toolUseId!, entry.id, text, isError)}
          />
        ) : null}
      </details>
    </article>
  );
}

/**
 * Result form for a parked `agent.custom_tool_use` — the runtime cannot
 * execute a custom tool, so the caller supplies the result. Submitting writes
 * a `user.custom_tool_result` event; the paired card settles when it lands.
 */
export function CustomToolResultForm({
  submitting,
  onSubmit,
}: {
  submitting: boolean;
  onSubmit: (text: string, isError: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [isError, setIsError] = useState(false);
  return (
    <form
      className="conversationToolApproval conversationToolResultForm"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(text, isError);
      }}
    >
      <span>Waiting for this tool's result</span>
      <textarea
        className="conversationToolResultInput"
        rows={3}
        placeholder="Tool result…"
        value={text}
        disabled={submitting}
        onChange={(event) => setText(event.target.value)}
      />
      <label className="conversationToolResultError">
        <input
          type="checkbox"
          checked={isError}
          disabled={submitting}
          onChange={(event) => setIsError(event.target.checked)}
        />
        Mark as error
      </label>
      <button type="submit" className="primaryButton" disabled={submitting || text.trim() === ''}>
        {submitting ? 'Submitting…' : 'Submit result'}
      </button>
    </form>
  );
}
