/**
 * Answering the calls a `managed-agents chat` turn parked on.
 *
 * A turn that stops for approval ends in an ordinary `session.status_idle` whose
 * published `stop_reason` is `{ type: "requires_action", event_ids: [...] }`
 * (`src/api/standard.ts` projects the session-level reason onto that event). The
 * published loop is to send one `user.tool_confirmation` per entry, passing the
 * entry as `tool_use_id` — the **event** id, which is what the runtime resolves
 * first (`SessionManager.resolveConfirmedToolUse`) — and the runtime then starts
 * the turn again on its own once nothing is parked. Before this existed, `chat`
 * printed the tool name, returned to its prompt, and left the session waiting with
 * nothing said: the session could never continue from the CLI.
 *
 * Two families park a session and only one of them can be answered here
 * (`src/core/session/parked-calls.ts`):
 *
 * - an approval-gated `agent.tool_use` / `agent.mcp_tool_use`, answered with
 *   `allow` or `deny`;
 * - an `agent.custom_tool_use`, which waits for a `user.custom_tool_result` that
 *   only the caller's own client can produce — the runtime has no executor for a
 *   custom tool, which is why it parked. This CLI says so and leaves the call
 *   parked rather than answering it with a fabricated result or a decision the
 *   runtime would ignore.
 */

import type { ContentBlock } from '@/types/cma-protocol.js';
import type { ManagedAgentsClient, StreamedEvent } from '../sdk/client.js';

/** What the operator told the command line to do with an approval-gated call. */
export type ToolApprovalPolicy = 'ask' | 'allow' | 'deny';

/** One call the runtime is waiting on, as `stop_reason.event_ids` names it. */
export interface ParkedToolCall {
  /** The event id to answer with. */
  eventId: string;
  /** Which family parked: only `gated` can be answered from here. */
  family: 'gated' | 'custom';
  /** The tool's name, or `undefined` when the stream never showed the event. */
  name?: string;
}

function toolUseBlock(event: StreamedEvent): (ContentBlock & { type: 'tool_use' }) | undefined {
  return event.content?.find((block) => block.type === 'tool_use') as
    | (ContentBlock & { type: 'tool_use' })
    | undefined;
}

/**
 * The id a parked call is answered with, when the streamed event is one.
 *
 * `event.id` is the identifier the runtime publishes in `stop_reason.event_ids`
 * and resolves first, so it is what a caller sends back.
 */
export function parkedCallFromEvent(event: StreamedEvent): ParkedToolCall | undefined {
  if (event.type === 'agent.tool_use' || event.type === 'agent.mcp_tool_use') {
    const block = toolUseBlock(event);
    if (!block?.requires_confirmation || !event.id) return undefined;
    return { eventId: event.id, family: 'gated', ...(block.name ? { name: block.name } : {}) };
  }
  if (event.type === 'agent.custom_tool_use') {
    const block = toolUseBlock(event);
    if (!block?.id || !event.id) return undefined;
    return { eventId: event.id, family: 'custom', ...(block.name ? { name: block.name } : {}) };
  }
  return undefined;
}

/**
 * The ids a `session.status_idle` frame says are still waiting, or `[]`.
 *
 * Anything that is not a `requires_action` idle — an ended turn, a terminated
 * session, a frame from a different event type — yields no calls, which is how
 * the caller tells "the turn finished" from "the turn is waiting for you".
 */
export function parkedEventIds(event: StreamedEvent): string[] {
  if (event.type !== 'session.status_idle') return [];
  const reason = event.stop_reason;
  if (!reason || typeof reason === 'string' || reason.type !== 'requires_action') return [];
  // The same id can be named twice in one frame; answering it twice is a second
  // confirmation for a call that was already decided, so the first spelling wins.
  return [...new Set((reason.event_ids ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/**
 * Turn the published ids into describable calls.
 *
 * The stream carries the tool call itself before the idle frame, so the name is
 * normally known; an id the caller never saw (a stream opened mid-turn, a
 * truncated read) is still reported, without a name, instead of being dropped.
 */
export function parkedCalls(eventIds: string[], seen: Map<string, ParkedToolCall>): ParkedToolCall[] {
  return eventIds.map((eventId) => seen.get(eventId) ?? { eventId, family: 'gated' });
}

/** The decision an answer line means. Anything unrecognized denies. */
export function approvalDecision(answer: string): 'allow' | 'deny' {
  return /^\s*(y|yes|allow)\s*$/i.test(answer) ? 'allow' : 'deny';
}

/** `bash (call_stub_1)` — enough for a prompt to be answerable. */
export function describeCall(call: ParkedToolCall): string {
  return call.name ? `${call.name} (${call.eventId})` : call.eventId;
}

/** What to print when a call needs a result this CLI cannot produce. */
export function unanswerableNotice(call: ParkedToolCall, sessionId: string): string {
  return [
    `  ${describeCall(call)} needs a result only your own client can produce (a custom tool has no executor in the runtime).`,
    '  Answer it there and the turn continues:',
    `    POST /v1/sessions/${sessionId}/events`,
    `    { "events": [{ "type": "user.custom_tool_result", "custom_tool_use_id": "${call.eventId}", "content": [{ "type": "text", "text": "<result>" }] }] }`,
  ].join('\n');
}

/** What to print when nobody can be asked: the session is left waiting, not changed. */
export function pendingNotice(sessionId: string, calls: ParkedToolCall[]): string {
  return [
    `Session ${sessionId} is waiting for approval and this run cannot ask:`,
    ...calls.map((call) => `  ${describeCall(call)}${call.family === 'custom' ? ' (custom tool)' : ''}`),
    '  Nothing was answered, so the turn is still parked.',
    '  Run `chat` on a terminal to answer it, pass --tool-approval allow|deny to decide',
    '  from the command line, or answer the events above from your own client.',
  ].join('\n');
}

export interface ParkedCallsDeps {
  client: Pick<ManagedAgentsClient['sessions'], 'approveTool' | 'denyTool'>;
  sessionId: string;
  /** How the answer is obtained; `question` is only called for `ask`. */
  io: {
    policy: ToolApprovalPolicy;
    /** True when a decision can be obtained at all (a reader is attached). */
    interactive: boolean;
    write(text: string): void;
    /**
     * The line a person typed, or `undefined` when nothing can be read (no
     * reader, or the input ended). `undefined` is not a decision: it leaves the
     * call parked, because an input that ran out must not read as consent.
     */
    question(prompt: string): Promise<string | undefined>;
  };
}

export interface ParkedCallsOutcome {
  /** Calls answered with a decision. */
  answered: ParkedToolCall[];
  /** Calls left parked because only the caller's own client can answer them. */
  unanswerable: ParkedToolCall[];
  /** Calls left parked because no decision could be obtained. */
  unanswered: ParkedToolCall[];
  /** Set when an answer was refused by the runtime; the rest stays parked. */
  error?: string;
}

/**
 * Answer every parked call this CLI can answer, and report the rest.
 *
 * Answers are sent one per call, in the order the runtime published them, which
 * is the published loop. A call that could not be answered
 * leaves the session in `requires_action` on purpose: the runtime keeps the turn
 * held and no tool runs, which is the safe end for a client that cannot decide.
 *
 * A refusal is reported instead of thrown. The runtime can refuse an answer that
 * is stale or already decided, and a batch that stops halfway leaves the session
 * exactly where it was for the calls that were not sent — which the caller has to
 * say out loud, because a stack trace does not tell an operator that the session
 * is still waiting.
 */
export async function answerParkedCalls(
  calls: ParkedToolCall[],
  deps: ParkedCallsDeps,
): Promise<ParkedCallsOutcome> {
  const outcome: ParkedCallsOutcome = { answered: [], unanswerable: [], unanswered: [] };
  const { client, sessionId, io } = deps;

  for (const [index, call] of calls.entries()) {
    if (call.family === 'custom') {
      outcome.unanswerable.push(call);
      continue;
    }
    let decision: 'allow' | 'deny';
    if (io.policy === 'allow' || io.policy === 'deny') {
      decision = io.policy;
      io.write(`\n  ${decision === 'allow' ? 'Allowing' : 'Denying'} ${describeCall(call)} (--tool-approval ${io.policy}).\n`);
    } else if (io.interactive) {
      const answer = await io.question(`\n  Allow ${describeCall(call)}? [y/N] `);
      if (answer === undefined) {
        // The input ended while the call was waiting for a decision. Everything
        // from here on stays parked too: there is nobody left to ask.
        outcome.unanswered.push(...calls.slice(index).filter((rest) => rest.family === 'gated'));
        return outcome;
      }
      decision = approvalDecision(answer);
      io.write(`  ${decision === 'allow' ? 'Allowed' : 'Denied'} ${describeCall(call)}.\n`);
    } else {
      // `ask` with nobody to ask: leaving the call parked is the only safe
      // answer. A default of "allow" here would hand a tool the operator never
      // saw to a session parked precisely because a person was meant to decide.
      outcome.unanswered.push(call);
      continue;
    }
    try {
      if (decision === 'allow') await client.approveTool(sessionId, call.eventId);
      else await client.denyTool(sessionId, call.eventId, 'Denied from managed-agents chat.');
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
      outcome.unanswered.push(...calls.slice(index));
      return outcome;
    }
    outcome.answered.push(call);
  }

  return outcome;
}
