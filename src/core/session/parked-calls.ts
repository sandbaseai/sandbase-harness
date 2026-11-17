/**
 * The calls a session is waiting on, derived from its event log alone.
 *
 * This is one definition on purpose. It is read from two sides that must never
 * disagree: the `stop_reason` projection tells a client which ids to answer
 * (`event_ids`), and the executor's resume gate decides whether a turn may
 * start. If those two ever derive the parked set differently, a client is either
 * told to answer a call the gate does not know about, or a turn starts against a
 * tool-result sequence that is still missing a call — which providers reject
 * with "Tool result is missing for tool call <id>" and the session is terminated
 * for what was a documented, well-formed answer.
 *
 * Three families park a session, and the published contract parks them the same
 * way — the session pauses with `stop_reason.type: "requires_action"` and the
 * blocking events' ids in `stop_reason.event_ids`, and the client answers each
 * one:
 *
 * - an approval-gated `agent.tool_use` / `agent.mcp_tool_use` carrying
 *   `requires_confirmation`, answered by `user.tool_confirmation`;
 * - a builtin `agent.tool_use` on a self-hosted environment, marked
 *   `metadata.awaiting_tool_result`, which the environment's worker executes
 *   and answers with `user.tool_result`. It carries no `requires_confirmation`:
 *   approval is not the reason it is parked — execution lives on the worker —
 *   and the confirmation channel would route the answer to the wrong executor;
 * - an `agent.custom_tool_use` the caller has not answered, answered by
 *   `user.custom_tool_result`. It carries no `requires_confirmation`: the
 *   runtime has no executor for a custom tool, which is why it is parked at all.
 *
 * A call is resolved when something in the log answers it, and each answer is
 * recorded under the `tool_use` **block** id — the built-in and MCP result
 * blocks, the deny result `ToolResolver` writes, a custom result's
 * `metadata.custom_tool_use_id`, and a worker result's
 * `metadata.tool_use_id`. So resolution is tracked by block id while the
 * event id is what gets reported, and the two are carried side by side rather
 * than conflated: a call whose block id is resolved is excluded even though its
 * event id is what the array names.
 */

import type { SessionEvent } from '@/types/session.js';

/** One call the session is waiting on: what to report, and what resolves it. */
export interface ParkedCall {
  /** The event's own id — what `stop_reason.event_ids` reports and a client answers with. */
  eventId: string;
  /** The `tool_use` block id — what an answer is recorded under and pairs against. */
  blockId: string;
  /**
   * When the call was parked: the `createdAt` of the event that emitted it.
   *
   * Carried because a bounded wait has to be measured from when the session
   * actually stopped, not from when a later pass noticed it. A bound derived
   * from the observer's own clock would restart on every sweep tick and would
   * start from zero after a restart, so a session parked for a week would look
   * freshly parked to a runtime that had just booted.
   */
  parkedAt: Date;
}

export function parkedCalls(events: SessionEvent[]): ParkedCall[] {
  const resolved = new Set<string>();
  const parked: ParkedCall[] = [];

  for (const event of events) {
    if (event.type === 'agent.tool_result' || event.type === 'agent.mcp_tool_result') {
      const block = event.content?.find((item) => item.type === 'tool_result') as
        | { type: 'tool_result'; tool_use_id: string }
        | undefined;
      if (block) resolved.add(block.tool_use_id);
      continue;
    }
    if (event.type === 'user.custom_tool_result') {
      const id = event.metadata?.custom_tool_use_id;
      if (typeof id === 'string') resolved.add(id);
      continue;
    }
    if (event.type === 'user.tool_result') {
      const id = event.metadata?.tool_use_id;
      if (typeof id === 'string') resolved.add(id);
      continue;
    }
    if (event.type === 'agent.custom_tool_use') {
      const block = event.content?.find((item) => item.type === 'tool_use') as
        | { type: 'tool_use'; id: string }
        | undefined;
      if (block) parked.push({ eventId: event.id, blockId: block.id, parkedAt: event.createdAt });
      continue;
    }
    if (event.type !== 'agent.tool_use' && event.type !== 'agent.mcp_tool_use') continue;
    const block = event.content?.find((item) => item.type === 'tool_use') as
      | { type: 'tool_use'; id: string; requires_confirmation?: boolean }
      | undefined;
    if (block && (block.requires_confirmation || event.metadata?.awaiting_tool_result === true)) {
      parked.push({ eventId: event.id, blockId: block.id, parkedAt: event.createdAt });
    }
  }

  return parked.filter((call) => !resolved.has(call.blockId));
}
