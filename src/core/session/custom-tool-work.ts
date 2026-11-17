/**
 * Custom tool work completion → session answer.
 *
 * A `custom_tool` work item is enqueued when a session on a self-hosted
 * environment persists `agent.custom_tool_use` (see
 * `SelfHostedSandboxInstance.enqueueCustomToolCall`). The item's completion is
 * what answers the parked call: this module turns the recorded outcome into a
 * `user.custom_tool_result` and hands it to `SessionManager.sendEvent`, which
 * remains the sole authority for resolving the call, refusing a duplicate, and
 * queueing the resume turn. Nothing here appends an event directly — a worker
 * result that cannot pass the normal admission rules (session ended, call
 * already answered, malformed payload) is refused by the same code that
 * refuses a caller's.
 *
 * The tool-level outcome and the transport-level one stay apart, matching the
 * queue's own vocabulary. A worker that ran the tool and got an error reports
 * `applied` with `is_error: true` content; that is the tool's answer and it
 * reaches the model flagged as such. A completion recorded `failed` — the
 * worker could not run the item at all — reaches the session the same way a
 * caller's explicit error result would: `is_error: true`, because the model
 * needs the call answered and "the executor failed" is the answer.
 */

import type { ContentBlock } from '@/types/cma-protocol.js';
import type { UserCustomToolResultEvent, UserToolResultEvent } from '@/types/cma-protocol.js';
import type { WorkItem } from '@/sandbox/self-hosted-provider.js';

export interface CustomToolWorkDelivery {
  sendEvent(
    sessionId: string,
    event: UserCustomToolResultEvent,
  ): Promise<{ accepted: boolean }>;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

/**
 * The delivery channel for a `tool_call` work item — the builtin sibling of
 * `CustomToolWorkDelivery`. A `tool_call` item is a builtin `agent.tool_use`
 * the session parked for the environment's workers; its completion answers the
 * call with a `user.tool_result`, still through `SessionManager.sendEvent` so
 * the parked-call admission rules decide whether it lands.
 */
export interface ToolCallWorkDelivery {
  sendEvent(
    sessionId: string,
    event: UserToolResultEvent,
  ): Promise<{ accepted: boolean }>;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Inject a completed `custom_tool` item's outcome into its session.
 *
 * `item` is the row as `WorkQueue.complete` recorded it, so `sessionId` and
 * `payload.tool_use_id` come from the row the runtime wrote at enqueue time —
 * never from the completion body. That is the binding the whole mechanism
 * rests on: a worker cannot name a session or a call, only report on an item
 * it held.
 */
export async function deliverCustomToolWorkResult(
  deps: CustomToolWorkDelivery,
  item: WorkItem,
): Promise<void> {
  const toolUseId = typeof item.payload.tool_use_id === 'string' ? item.payload.tool_use_id : undefined;
  if (!toolUseId) {
    deps.warn?.('custom tool work item carries no tool_use_id; the parked call stays unanswered', {
      work_item_id: item.id,
      session_id: item.sessionId,
    });
    return;
  }

  const event = toCustomToolResultEvent(item, toolUseId);
  try {
    await deps.sendEvent(item.sessionId, event);
  } catch (error) {
    // A refusal is honest state, not a bug: the call may already have been
    // answered by the caller, or the session may have ended while the worker
    // ran. The item's recorded status stays the truth about the work itself.
    deps.warn?.('custom tool result was refused by the session', {
      work_item_id: item.id,
      session_id: item.sessionId,
      tool_use_id: toolUseId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Inject a completed `tool_call` item's outcome into its session.
 *
 * Mirrors {@link deliverCustomToolWorkResult}: `sessionId` and
 * `payload.tool_use_id` come from the row the runtime wrote at enqueue time,
 * so a worker can only report on an item it held — it cannot name a session or
 * a call itself. The event is the builtin answer, `user.tool_result`, which
 * `validateToolResult` admits only against the parked worker call it names.
 */
export async function deliverToolCallWorkResult(
  deps: ToolCallWorkDelivery,
  item: WorkItem,
): Promise<void> {
  const toolUseId = typeof item.payload.tool_use_id === 'string' ? item.payload.tool_use_id : undefined;
  if (!toolUseId) {
    deps.warn?.('tool_call work item carries no tool_use_id; the parked call stays unanswered', {
      work_item_id: item.id,
      session_id: item.sessionId,
    });
    return;
  }

  const event = toToolResultEvent(item, toolUseId);
  try {
    await deps.sendEvent(item.sessionId, event);
  } catch (error) {
    deps.warn?.('tool result was refused by the session', {
      work_item_id: item.id,
      session_id: item.sessionId,
      tool_use_id: toolUseId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function toToolResultEvent(item: WorkItem, toolUseId: string): UserToolResultEvent {
  const result = item.result;
  if (item.status === 'failed') {
    return {
      type: 'user.tool_result',
      tool_use_id: toolUseId,
      content: [{
        type: 'text',
        text: `Worker could not execute the tool call: ${resultMessage(result) ?? 'unknown failure'}`,
      }],
      is_error: true,
    };
  }

  const record = isRecord(result) ? result : undefined;
  if (record?.is_error === true) {
    return {
      type: 'user.tool_result',
      tool_use_id: toolUseId,
      content: validContent(record.content) ?? [{ type: 'text', text: String(record.error ?? 'tool call failed') }],
      is_error: true,
    };
  }

  const content = record ? validContent(record.content) : undefined;
  return {
    type: 'user.tool_result',
    tool_use_id: toolUseId,
    content: content ?? [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? null) }],
  };
}

function toCustomToolResultEvent(item: WorkItem, toolUseId: string): UserCustomToolResultEvent {
  const result = item.result;
  if (item.status === 'failed') {
    return {
      type: 'user.custom_tool_result',
      custom_tool_use_id: toolUseId,
      content: [{
        type: 'text',
        text: `Worker could not execute the custom tool: ${resultMessage(result) ?? 'unknown failure'}`,
      }],
      is_error: true,
    };
  }

  const record = isRecord(result) ? result : undefined;
  if (record?.is_error === true) {
    return {
      type: 'user.custom_tool_result',
      custom_tool_use_id: toolUseId,
      content: validContent(record.content) ?? [{ type: 'text', text: String(record.error ?? 'custom tool failed') }],
      is_error: true,
    };
  }

  const content = record ? validContent(record.content) : undefined;
  return {
    type: 'user.custom_tool_result',
    custom_tool_use_id: toolUseId,
    content: content ?? [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? null) }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resultMessage(result: unknown): string | undefined {
  if (typeof result === 'string') return result;
  if (isRecord(result) && typeof result.message === 'string') return result.message;
  if (isRecord(result) && typeof result.error === 'string') return result.error;
  return undefined;
}

/**
 * Content the session will accept is a non-empty array of objects carrying a
 * `type` field; anything else is folded into a text block so a worker result
 * in an unexpected shape still answers the parked call rather than leaving it
 * hanging on a malformed payload.
 */
function validContent(value: unknown): ContentBlock[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (value.some((block) => !isRecord(block) || typeof block.type !== 'string')) return undefined;
  return value as ContentBlock[];
}
