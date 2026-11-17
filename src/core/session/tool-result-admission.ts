import type { SessionEvent } from '@/types/session.js';

export const TOOL_RESULT_NOT_PENDING_CODE = 'tool_result_not_pending';
export const TOOL_RESULT_INVALID_CODE = 'tool_result_invalid';

/** `user.tool_result` named no call that is currently parked for a worker. */
export class ToolResultNotPendingError extends Error {
  readonly code = TOOL_RESULT_NOT_PENDING_CODE;

  constructor(message = 'user.tool_result does not reference a pending tool call') {
    super(message);
    this.name = 'ToolResultNotPendingError';
  }
}

/** `user.tool_result` is malformed before any session lookup runs. */
export class ToolResultInvalidError extends Error {
  readonly code = TOOL_RESULT_INVALID_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'ToolResultInvalidError';
  }
}

/**
 * Admission for `user.tool_result`, the self-hosted worker answer channel.
 *
 * A `user.tool_result` is only meaningful against a call this runtime actually
 * parked for a worker — a builtin `agent.tool_use` marked
 * `awaiting_tool_result` whose block id the event names (the event id spelling
 * resolves to the block id at this boundary, exactly as the confirmation path
 * already resolves both spellings). Anything else is refused before the event
 * is persisted: a result for a call the runtime ran itself, a call that was
 * never issued, a foreign session's call, or a second answer to a call already
 * resolved. The named codes keep the refusal specific so a worker cannot tell
 * the difference between "no such call" and "that call is not yours to answer"
 * only by probing.
 *
 * The parked set is derived from the log itself rather than a separate map —
 * the same definition `stop_reason.event_ids` and the executor's resume gate
 * read, so a result admitted here is one the session is genuinely waiting on.
 */
export interface ToolResultAdmissionTarget {
  /** The canonical `tool_use` block id the answer is recorded under. */
  blockId: string;
}

export function validateToolResult(
  event: { type: string; tool_use_id?: unknown; content?: unknown; is_error?: unknown },
  events: SessionEvent[],
): ToolResultAdmissionTarget {
  if (typeof event.tool_use_id !== 'string' || event.tool_use_id.trim().length === 0) {
    throw new ToolResultInvalidError('Invalid tool result: tool_use_id must be a non-empty string');
  }
  if (event.content !== undefined
    && (!Array.isArray(event.content) || event.content.some((block) => !isValidResultBlock(block)))) {
    throw new ToolResultInvalidError('Invalid tool result: content must be an array of text, image, or document blocks');
  }
  if (event.is_error !== undefined && typeof event.is_error !== 'boolean') {
    throw new ToolResultInvalidError('Invalid tool result: is_error must be a boolean');
  }

  const target = resolveWorkerToolUse(event.tool_use_id, events);
  if (!target) {
    throw new ToolResultNotPendingError();
  }

  // The duplicate check is keyed on the canonical block id, so answering the
  // same parked call twice — including once with each spelling — is refused.
  // It runs after resolution so an unissued id still reports not-pending, while
  // a real call that already has its answer reports the more specific reason.
  for (const loggedEvent of events) {
    if (loggedEvent.type === 'user.tool_result'
      && loggedEvent.metadata?.tool_use_id === target.blockId) {
      throw new ToolResultNotPendingError('Invalid tool result: the tool call is not pending');
    }
    // A result the runtime itself wrote (an in-process execution, a deny, or an
    // orphan reconciliation) also settles the call: admitting a worker answer on
    // top would let a caller overwrite a resolved call's outcome.
    if (loggedEvent.type === 'agent.tool_result' || loggedEvent.type === 'agent.mcp_tool_result') {
      const block = loggedEvent.content?.find((item) => item.type === 'tool_result') as
        | { type: 'tool_result'; tool_use_id: string } | undefined;
      if (block?.tool_use_id === target.blockId) {
        throw new ToolResultNotPendingError('Invalid tool result: the tool call is not pending');
      }
    }
  }

  return target;
}

/**
 * Resolve a `user.tool_result`'s `tool_use_id` to a parked worker-executed call.
 *
 * Only a builtin `agent.tool_use` carrying the `awaiting_tool_result` marker
 * qualifies: that is the one call shape this runtime hands to a worker and the
 * only one a `user.tool_result` may answer. An approval-gated call, an MCP
 * call, a custom call, and a call the runtime executed all resolve to
 * nothing — each has its own answer channel and none of them is this one. The
 * event id is matched before the block id, matching the two-spelling rule the
 * confirmation and custom-result resolvers already follow.
 */
function resolveWorkerToolUse(
  reference: string,
  events: SessionEvent[],
): ToolResultAdmissionTarget | undefined {
  for (const loggedEvent of events) {
    if (loggedEvent.type !== 'agent.tool_use') continue;
    if (loggedEvent.metadata?.awaiting_tool_result !== true) continue;
    const block = loggedEvent.content?.find((item) => item.type === 'tool_use') as
      | { type: 'tool_use'; id: string }
      | undefined;
    if (!block) continue;
    if (loggedEvent.id !== reference && block.id !== reference) continue;
    return { blockId: block.id };
  }
  return undefined;
}

function isValidResultBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
  const record = block as Record<string, unknown>;
  if (record.type === 'text') return typeof record.text === 'string';
  if (record.type === 'image' || record.type === 'document') return Boolean(record.source && typeof record.source === 'object');
  return false;
}
