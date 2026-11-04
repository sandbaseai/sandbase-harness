import type { ContentBlock } from '@/types/cma-protocol.js';

/**
 * Documented maximum number of text items in one `system.message`.
 *
 * The published contract states `content` accepts 1–1000 text items. Enforcing
 * the bound here means an over-long batch is refused before it reaches the
 * append-only log, where it would be permanent.
 */
export const MAX_SYSTEM_MESSAGE_BLOCKS = 1000;

/**
 * The published `system.message` content grammar is text-only: every block is
 * `{type:"text", text}`. An image, document, tool_use, or tool_result block is
 * refused — not validated against the wider user-message vocabulary — because
 * the contract's `content` accepts text items only and a non-text block would
 * otherwise be persisted as privileged context it was never meant to carry.
 */
export function normalizeSystemMessageContent(value: unknown): ContentBlock[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > MAX_SYSTEM_MESSAGE_BLOCKS) return null;
  return value.every(isValidSystemTextBlock) ? value as ContentBlock[] : null;
}

/** Distinguish "too many blocks" from "non-text/malformed" so the API can say which. */
export function systemMessageContentError(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return 'system.message content must be a non-empty array of text items';
  }
  if (value.length > MAX_SYSTEM_MESSAGE_BLOCKS) {
    return `system.message content accepts at most ${MAX_SYSTEM_MESSAGE_BLOCKS} text items (received ${value.length})`;
  }
  const badIndex = value.findIndex((block) => !isValidSystemTextBlock(block));
  if (badIndex !== -1) {
    const type = (value[badIndex] as { type?: unknown } | null)?.type;
    return `system.message content accepts text items only; item ${badIndex} has type ${JSON.stringify(type ?? 'unknown')}`;
  }
  return undefined;
}

function isValidSystemTextBlock(value: unknown): value is ContentBlock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const block = value as Record<string, unknown>;
  return block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0;
}

/**
 * The published `system.message` supported-model list, expressed as the id
 * prefixes the capability table already resolves (`claude-opus-5-5-20260101`
 * covers `claude-opus-5`). A model the runtime cannot prove supports
 * mid-conversation system injection is refused with
 * `model_does_not_support_mid_conversation_system`, which is the published
 * refusal — matching an unknown or non-Claude id the same way a known
 * unsupported one is refused keeps the gate honest rather than optimistic.
 */
const MID_CONVERSATION_SYSTEM_PREFIXES = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
];

export function modelSupportsMidConversationSystem(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return MID_CONVERSATION_SYSTEM_PREFIXES.some((prefix) => id.includes(prefix));
}

/**
 * The `requires_action` ordering rule. While the session is idle on a pending
 * tool call, a `system.message` may not be sent on its own or paired with a
 * `user.message`: it must trail a tool-result event in the same request, so a
 * batch's first tool-answer event settles the pending call before the system
 * context lands. Returns the index of the offending `system.message`, or -1.
 */
export function systemMessageOrderingViolationIndex(
  events: ReadonlyArray<{ type?: unknown }>,
  requiresAction: boolean,
): number {
  if (!requiresAction) return -1;
  let sawToolAnswer = false;
  for (const [index, event] of events.entries()) {
    const type = typeof event?.type === 'string' ? event.type : '';
    if (type === 'user.tool_confirmation' || type === 'user.custom_tool_result') {
      sawToolAnswer = true;
      continue;
    }
    if (type === 'system.message' && !sawToolAnswer) return index;
  }
  return -1;
}
