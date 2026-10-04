import type { Dispatch, SetStateAction } from 'react';
import {
  isToolResultEvent,
  isToolUseEvent,
  toolResultDetails,
  toolResultFailed,
  toolResultId,
  toolResultText,
  toolOperation,
  toolUseDetails,
  toolUseIdFromEvent,
  eventKind,
  eventText,
} from './eventRenderers';
import { truncateMiddle } from '../../lib/format';
import type { Session, SessionEvent, ToolPermission } from '../../types';

export const SESSION_EVENT_KINDS = ['user', 'agent', 'tool', 'error', 'system'] as const;
export type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number];
export type SessionDisplayStatus = 'idle' | 'awaiting_action' | 'running' | 'rescheduling' | 'terminated' | 'archived';

export function toggleSet<T>(value: T, checked: boolean, setter: Dispatch<SetStateAction<Set<T>>>) {
  setter((current) => {
    const next = new Set(current);
    if (checked) next.add(value);
    else next.delete(value);
    return next;
  });
}

export function eventLabel(event: SessionEvent, mode: 'transcript' | 'debug') {
  if (mode === 'debug') return truncateMiddle(event.type, 22);
  const kind = eventKind(event);
  return kind[0].toUpperCase() + kind.slice(1);
}

export type ConversationMessage = {
  id: string;
  role: 'user' | 'agent' | 'error';
  text: string;
  event: SessionEvent;
};

export type ConversationEntry = ConversationMessage | {
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
  /** `agent.custom_tool_use` parked for a caller-supplied result. */
  awaitingResult?: boolean;
  requiresConfirmation?: boolean;
  permission?: ToolPermission;
};

/** Transcript text: a `session.error` bubble prefers the projected message. */
function sessionEventText(event: SessionEvent): string {
  if (event.type === 'session.error') return event.error?.message || eventText(event);
  return eventText(event);
}

export function conversationMessages(events: SessionEvent[]): ConversationMessage[] {
  return events
    .filter((event) => event.type === 'user.message' || event.type === 'agent.message' || event.type === 'session.error' || event.type === 'user.interrupt')
    .map((event) => ({
      id: event.id,
      role: event.type === 'user.message' ? 'user' : event.type === 'session.error' ? 'error' : 'agent',
      text: event.type === 'user.interrupt' ? 'Run interrupted by the user.' : sessionEventText(event),
      event,
    }));
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
  // A `custom_tool_use_id` names the use *event* id per the published
  // contract; the runtime also accepts the block id. Index both so either
  // spelling pairs.
  for (const event of events) {
    if (isToolUseEvent(event)) toolUseIds.add(event.id);
  }
  const entries: ConversationEntry[] = [];
  for (const event of events) {
    if (isToolResultEvent(event)) {
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
        text: event.type === 'user.interrupt' ? 'Run interrupted by the user.' : sessionEventText(event),
        event,
      });
      continue;
    }
    if (!isToolUseEvent(event)) continue;
    const details = toolUseDetails(event);
    const toolUseId = details.toolUseId;
    const result = (toolUseId ? resultByToolId.get(toolUseId) : undefined) ?? resultByToolId.get(event.id);
    // Tool Runtime is the authority. A result-less tool use is actionable only
    // when the event carries explicit confirmation metadata and no
    // confirmation has been recorded yet. This also works when the API maps
    // `requires_action` to `idle` in the session status.
    const awaitingConfirmation = toolAwaitingConfirmation(details, Boolean(result), confirmedToolUseIds.has(details.toolUseId ?? ''));
    // A custom tool call is parked not for approval but for its result: the
    // runtime has no executor for it, so the caller supplies one. Pairing by
    // `custom_tool_use_id` means the card settles itself once the result lands.
    const awaitingResult = event.type === 'agent.custom_tool_use' && !result;
    entries.push({
      id: event.id,
      role: 'tool',
      operation: toolOperation(details.toolName),
      toolName: details.toolName,
      input: details.input,
      result: result?.text ?? '',
      status: awaitingConfirmation || awaitingResult ? 'awaiting' : result ? (result.failed ? 'failed' : 'completed') : 'running',
      event,
      ...(toolUseId ? { toolUseId, awaitingConfirmation } : {}),
      ...(awaitingResult ? { awaitingResult: true } : {}),
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

/**
 * A custom tool call is answered by `custom_tool_use_id` naming the
 * `agent.custom_tool_use` **event** id (the published contract's spelling; the
 * runtime also resolves the tool-call block id). `is_error` is sent explicitly
 * so an unchecked box cannot be misread as an omitted field.
 */
export function customToolResultPayload(customToolUseEventId: string, text: string, isError: boolean) {
  return {
    events: [{
      type: 'user.custom_tool_result' as const,
      custom_tool_use_id: customToolUseEventId,
      content: [{ type: 'text' as const, text }],
      is_error: isError,
    }],
  };
}

/** Atomically claims a tool id for a confirmation submission. */
export function beginToolConfirmation(inFlight: Set<string>, toolUseId: string): boolean {
  if (inFlight.has(toolUseId)) return false;
  inFlight.add(toolUseId);
  return true;
}

export function sessionDisplayStatus(session: Session, events: SessionEvent[]): SessionDisplayStatus {
  // `archived_at` is its own axis — an archived session displays as archived
  // regardless of the lifecycle status it keeps underneath.
  if (session.archived_at) return 'archived';
  if (session.status === 'terminated') return 'terminated';
  if (session.status === 'rescheduling') return 'rescheduling';
  // Session status is an authoritative server-side state-machine field; the
  // event log only refines freshness while a snapshot is pending — a turn
  // that just started reads running before the session row refreshes.
  const lastStatus = [...events].reverse().find((event) => event.type.startsWith('session.status_'));
  if (session.status === 'running' || lastStatus?.type === 'session.status_running') return 'running';
  const stopReason = lastStatus?.type === 'session.status_idle' && typeof lastStatus.stop_reason === 'object'
    ? lastStatus.stop_reason?.type
    : undefined;
  if (stopReason === 'requires_action') return 'awaiting_action';
  return 'idle';
}

export function eventTime(event: SessionEvent) {
  const value = event.processed_at ?? event.created_at;
  if (!value) return '-';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}
