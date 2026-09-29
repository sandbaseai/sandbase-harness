/**
 * The decisions `managed-agents chat` makes when a turn parks on approval.
 *
 * A turn that stops for approval ends in an ordinary `session.status_idle` whose
 * `stop_reason` is `{ type: "requires_action", event_ids: [...] }`, and the
 * published loop is to answer each entry with a `user.tool_confirmation` —
 * passing the **event** id, which is what the runtime resolves. These cases pin
 * the two halves of that: reading the ids out of the frame, and answering them
 * with the runtime's own helper. The answers a person would give are supplied
 * here, so the cases are about the decision rather than about a terminal.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  answerParkedCalls,
  approvalDecision,
  describeCall,
  parkedCallFromEvent,
  parkedCalls,
  parkedEventIds,
  pendingNotice,
  unanswerableNotice,
  type ParkedToolCall,
} from '../../src/cli/chat-approvals.js';
import type { StreamedEvent } from '../../src/sdk/client.js';

const SESSION = 'sess_test_1';

function idle(stopReason?: StreamedEvent['stop_reason']): StreamedEvent {
  return { id: 'sevt_idle', seq: 9, type: 'session.status_idle', ...(stopReason ? { stop_reason: stopReason } : {}) };
}

function toolUse(overrides: {
  id?: string;
  eventType?: string;
  name?: string;
  requiresConfirmation?: boolean;
} = {}): StreamedEvent {
  return {
    id: overrides.id ?? 'sevt_tool',
    seq: 8,
    type: overrides.eventType ?? 'agent.tool_use',
    content: [{
      type: 'tool_use',
      id: 'call_stub_1',
      name: overrides.name ?? 'bash',
      input: { command: 'echo hi' },
      ...(overrides.requiresConfirmation === false ? {} : { requires_confirmation: true }),
    }],
  };
}

/** A client that records the answers instead of sending them. */
function fakeSessions() {
  const approved: string[] = [];
  const denied: Array<{ id: string; message?: string }> = [];
  return {
    approved,
    denied,
    client: {
      approveTool: vi.fn(async (_sessionId: string, toolUseId: string) => {
        approved.push(toolUseId);
        return { accepted: true };
      }),
      denyTool: vi.fn(async (_sessionId: string, toolUseId: string, message?: string) => {
        denied.push({ id: toolUseId, message });
        return { accepted: true };
      }),
    },
  };
}

function io(overrides: Partial<{ policy: 'ask' | 'allow' | 'deny'; interactive: boolean; answers: string[] }> = {}) {
  const written: string[] = [];
  const prompts: string[] = [];
  const answers = [...(overrides.answers ?? [])];
  return {
    written,
    prompts,
    io: {
      policy: overrides.policy ?? 'ask',
      interactive: overrides.interactive ?? true,
      write: (text: string) => written.push(text),
      // An exhausted script is an input that ended, which is not a decision.
      question: async (prompt: string): Promise<string | undefined> => {
        prompts.push(prompt);
        return answers.shift();
      },
    },
  };
}

describe('reading a parked turn out of the stream', () => {
  it('takes the ids from a requires_action idle frame', () => {
    expect(parkedEventIds(idle({ type: 'requires_action', event_ids: ['sevt_a', 'sevt_b'] })))
      .toEqual(['sevt_a', 'sevt_b']);
  });

  it('names an id once, so a repeated entry is not answered twice', () => {
    // A second confirmation for a call that was already decided is refused by
    // the runtime, and a client that keeps re-sending one cannot settle.
    expect(parkedEventIds(idle({ type: 'requires_action', event_ids: ['sevt_a', 'sevt_a', 'sevt_b'] })))
      .toEqual(['sevt_a', 'sevt_b']);
  });

  it('treats every other idle frame as a turn that ended', () => {
    // The difference between "the turn finished" and "the turn is waiting for
    // you" is this one field, and getting it wrong either hangs the prompt or
    // reports an approval that was never asked for.
    expect(parkedEventIds(idle({ type: 'end_turn' }))).toEqual([]);
    expect(parkedEventIds(idle())).toEqual([]);
    expect(parkedEventIds(idle({ type: 'requires_action' }))).toEqual([]);
    expect(parkedEventIds(idle({ type: 'requires_action', event_ids: [] }))).toEqual([]);
    // A model-derived event spells `stop_reason` as the provider's own string.
    expect(parkedEventIds(idle('tool_calls'))).toEqual([]);
    expect(parkedEventIds({ seq: 3, type: 'agent.message' })).toEqual([]);
    expect(parkedEventIds({ seq: 3, type: 'session.status_terminated' })).toEqual([]);
  });

  it('describes a gated call by its event id, which is what gets answered', () => {
    const call = parkedCallFromEvent(toolUse());

    expect(call).toEqual({ eventId: 'sevt_tool', family: 'gated', name: 'bash' });
    // `id` on the block is the model's own call id, not the event id: answering
    // with it is a different (and also accepted) spelling, but the published
    // contract names the event id, so that is what this reads.
    expect(call?.eventId).not.toBe('call_stub_1');
  });

  it('ignores a tool call that was not gated', () => {
    expect(parkedCallFromEvent(toolUse({ requiresConfirmation: false }))).toBeUndefined();
  });

  it('recognizes an MCP call as gated and a custom call as a different family', () => {
    expect(parkedCallFromEvent(toolUse({ eventType: 'agent.mcp_tool_use', name: 'search' })))
      .toEqual({ eventId: 'sevt_tool', family: 'gated', name: 'search' });
    // A custom tool has no executor in the runtime, so it waits for a result only
    // the caller's own client can produce — not a decision this CLI can send.
    expect(parkedCallFromEvent(toolUse({ eventType: 'agent.custom_tool_use', name: 'lookup' })))
      .toEqual({ eventId: 'sevt_tool', family: 'custom', name: 'lookup' });
  });

  it('keeps an id it never saw a call for, so the operator still sees it', () => {
    const seen = new Map<string, ParkedToolCall>([
      ['sevt_tool', { eventId: 'sevt_tool', family: 'gated', name: 'bash' }],
    ]);

    expect(parkedCalls(['sevt_tool', 'sevt_unknown'], seen)).toEqual([
      { eventId: 'sevt_tool', family: 'gated', name: 'bash' },
      { eventId: 'sevt_unknown', family: 'gated' },
    ]);
  });
});

describe('answering the parked calls', () => {
  it('allows every gated call under --tool-approval allow, and answers the event id', async () => {
    const { client, approved, denied } = fakeSessions();
    const { io: i, written } = io({ policy: 'allow' });

    const outcome = await answerParkedCalls(
      [
        { eventId: 'sevt_a', family: 'gated', name: 'bash' },
        { eventId: 'sevt_b', family: 'gated', name: 'glob' },
      ],
      { client, sessionId: SESSION, io: i },
    );

    expect(approved).toEqual(['sevt_a', 'sevt_b']);
    expect(denied).toEqual([]);
    expect(outcome.answered.map((call) => call.eventId)).toEqual(['sevt_a', 'sevt_b']);
    expect(outcome.unanswerable).toEqual([]);
    // The operator chose this policy on the command line, so the run says so
    // rather than appearing to have asked someone.
    expect(written.join('')).toContain('--tool-approval allow');
  });

  it('denies with a message under --tool-approval deny, and never executes the tool', async () => {
    const { client, approved, denied } = fakeSessions();
    const { io: i } = io({ policy: 'deny' });

    const outcome = await answerParkedCalls(
      [{ eventId: 'sevt_a', family: 'gated', name: 'bash' }],
      { client, sessionId: SESSION, io: i },
    );

    expect(approved).toEqual([]);
    expect(denied).toHaveLength(1);
    expect(denied[0].id).toBe('sevt_a');
    expect(denied[0].message).toBeTruthy();
    expect(outcome.answered).toHaveLength(1);
  });

  it('asks once per call and reads the answer, denying anything that is not a yes', async () => {
    const { client, approved, denied } = fakeSessions();
    const { io: i, prompts } = io({ answers: ['y', ''] });

    const outcome = await answerParkedCalls(
      [
        { eventId: 'sevt_a', family: 'gated', name: 'bash' },
        { eventId: 'sevt_b', family: 'gated', name: 'glob' },
      ],
      { client, sessionId: SESSION, io: i },
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('bash');
    expect(prompts[0]).toContain('sevt_a');
    expect(approved).toEqual(['sevt_a']);
    expect(denied.map((entry) => entry.id)).toEqual(['sevt_b']);
    expect(outcome.answered).toHaveLength(2);
  });

  it('leaves the calls parked when there is nobody to ask', async () => {
    // `-m` is documented as non-interactive, and a redirected stdin has nobody
    // behind it. Defaulting to allow here would hand a tool the operator never
    // saw to a session that parked precisely because a person was meant to
    // decide, so nothing is sent and the caller reports the state instead.
    const { client, approved, denied } = fakeSessions();
    const { io: i, prompts } = io({ policy: 'ask', interactive: false });

    const outcome = await answerParkedCalls(
      [{ eventId: 'sevt_a', family: 'gated', name: 'bash' }],
      { client, sessionId: SESSION, io: i },
    );

    expect(approved).toEqual([]);
    expect(denied).toEqual([]);
    expect(prompts).toEqual([]);
    expect(outcome.answered).toEqual([]);
    expect(outcome.unanswered.map((call) => call.eventId)).toEqual(['sevt_a']);
  });

  it('leaves the rest parked when the input ends while a call waits for its answer', async () => {
    // stdin can end between two prompts. An answer that exists is used, and the
    // calls after it stay parked: a prompt nobody can read is not consent, and
    // it must not crash the run either.
    const { client, approved, denied } = fakeSessions();
    const { io: i, prompts } = io({ answers: ['y'] });

    const outcome = await answerParkedCalls(
      [
        { eventId: 'sevt_a', family: 'gated', name: 'bash' },
        { eventId: 'sevt_b', family: 'gated', name: 'glob' },
      ],
      { client, sessionId: SESSION, io: i },
    );

    expect(approved).toEqual(['sevt_a']);
    expect(denied).toEqual([]);
    expect(prompts).toHaveLength(2);
    expect(outcome.answered.map((call) => call.eventId)).toEqual(['sevt_a']);
    expect(outcome.unanswered.map((call) => call.eventId)).toEqual(['sevt_b']);
  });

  it('reports an answer the runtime refused instead of throwing, and sends no more', async () => {
    // The runtime can refuse an answer that is stale or already decided. A
    // stack trace would not tell the operator that the session is still held.
    const { client } = fakeSessions();
    client.approveTool = vi.fn(async (_sessionId: string, toolUseId: string) => {
      if (toolUseId === 'sevt_b') throw new Error('API error 409: already answered');
      return { accepted: true };
    });
    const { io: i } = io({ policy: 'allow' });

    const outcome = await answerParkedCalls(
      [
        { eventId: 'sevt_a', family: 'gated', name: 'bash' },
        { eventId: 'sevt_b', family: 'gated', name: 'glob' },
        { eventId: 'sevt_c', family: 'gated', name: 'read' },
      ],
      { client, sessionId: SESSION, io: i },
    );

    expect(outcome.answered.map((call) => call.eventId)).toEqual(['sevt_a']);
    expect(outcome.error).toContain('already answered');
    expect(outcome.unanswered.map((call) => call.eventId)).toEqual(['sevt_b', 'sevt_c']);
  });

  it('reports a custom call as unanswerable without sending anything for it', async () => {
    const { client, approved, denied } = fakeSessions();
    const { io: i } = io({ policy: 'allow' });

    const outcome = await answerParkedCalls(
      [
        { eventId: 'sevt_gated', family: 'gated', name: 'bash' },
        { eventId: 'sevt_custom', family: 'custom', name: 'lookup_customer' },
      ],
      { client, sessionId: SESSION, io: i },
    );

    expect(approved).toEqual(['sevt_gated']);
    expect(denied).toEqual([]);
    expect(outcome.unanswerable.map((call) => call.eventId)).toEqual(['sevt_custom']);
    expect(outcome.answered.map((call) => call.eventId)).toEqual(['sevt_gated']);
  });
});

describe('what the CLI prints when it stops', () => {
  it('reads a decision from the answer line, defaulting to deny', () => {
    expect(approvalDecision('y')).toBe('allow');
    expect(approvalDecision(' Y ')).toBe('allow');
    expect(approvalDecision('yes')).toBe('allow');
    expect(approvalDecision('allow')).toBe('allow');
    expect(approvalDecision('')).toBe('deny');
    expect(approvalDecision('n')).toBe('deny');
    expect(approvalDecision('maybe later')).toBe('deny');
    // Nothing but an explicit yes allows a tool to run.
    expect(approvalDecision('y e s')).toBe('deny');
  });

  it('names the call by tool and id, or by id alone when the stream never showed it', () => {
    expect(describeCall({ eventId: 'sevt_a', family: 'gated', name: 'bash' })).toBe('bash (sevt_a)');
    expect(describeCall({ eventId: 'sevt_a', family: 'gated' })).toBe('sevt_a');
  });

  it('tells the operator the session is still waiting and how to answer it', () => {
    const text = pendingNotice(SESSION, [{ eventId: 'sevt_a', family: 'gated', name: 'bash' }]);

    expect(text).toContain(SESSION);
    expect(text).toContain('sevt_a');
    expect(text).toContain('--tool-approval allow|deny');
    expect(text).toContain('still parked');
  });

  it('gives the exact custom-tool request, which is the only thing that resumes it', () => {
    const text = unanswerableNotice({ eventId: 'sevt_custom', family: 'custom', name: 'lookup' }, SESSION);

    expect(text).toContain('lookup (sevt_custom)');
    expect(text).toContain(`/v1/sessions/${SESSION}/events`);
    expect(text).toContain('user.custom_tool_result');
    expect(text).toContain('"custom_tool_use_id": "sevt_custom"');
  });
});
