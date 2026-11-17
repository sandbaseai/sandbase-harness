import type { SessionEvent } from '@/types/session.js';

export interface OrphanedToolUse {
  id: string;
  resultType: 'agent.tool_result' | 'agent.mcp_tool_result';
}

/**
 * What the log records for a tool call that was dispatched but never returned.
 *
 * The runtime knows exactly one thing here: no `tool_result` was written. It does
 * **not** know whether the call took effect, and for a call that already wrote a
 * file, sent an HTTP request or ran a shell command, the effect may well have
 * happened. So the message states the uncertainty and stops.
 *
 * It carried `retry if needed` before, which is an instruction to do the one thing
 * that must not be done: repeat an external side effect on the strength of a
 * guess. A message that is *wrong about the world* is worse than a vague one — it
 * converts an unknown into a false negative, and the caller acts on it.
 *
 * This is deliberately not a failure either. The call is completed with
 * `is_error: true` so the message sequence stays paired and the turn can continue;
 * what must not be claimed is the outcome. A later change that retries a crashed
 * tool call, or that distinguishes pure from impure ones, is a decision this
 * message makes possible rather than one it makes.
 */
export const INTERRUPTED_TOOL_OUTCOME_MESSAGE =
  'Tool call was interrupted before its result was recorded; its external outcome is unknown. '
  + 'It may or may not have taken effect.';

export function findOrphanedToolUses(events: SessionEvent[]): OrphanedToolUse[] {
  const toolUses = new Map<string, OrphanedToolUse>();
  const resolved = new Set<string>();

  for (const event of events) {
    if (event.type === 'agent.tool_use' || event.type === 'agent.mcp_tool_use') {
      const block = event.content?.find((item) => item.type === 'tool_use') as
        | { type: 'tool_use'; id: string }
        | undefined;
      if (block) {
        toolUses.set(block.id, {
          id: block.id,
          resultType: event.type === 'agent.mcp_tool_use'
            ? 'agent.mcp_tool_result'
            : 'agent.tool_result',
        });
      }
    } else if (event.type === 'agent.tool_result' || event.type === 'agent.mcp_tool_result') {
      const block = event.content?.find((item) => item.type === 'tool_result') as
        | { type: 'tool_result'; tool_use_id: string }
        | undefined;
      if (block) resolved.add(block.tool_use_id);
    } else if (event.type === 'user.tool_result') {
      // A worker-executed builtin call's answer pairs the same way a runtime
      // result does — by block id, carried on the event's metadata. Without
      // this the recovery pass would rewrite a parked worker call as
      // "interrupted" while the session is still legitimately waiting on it.
      const id = event.metadata?.tool_use_id;
      if (typeof id === 'string') resolved.add(id);
    }
  }

  return Array.from(toolUses.values()).filter((toolUse) => !resolved.has(toolUse.id));
}
