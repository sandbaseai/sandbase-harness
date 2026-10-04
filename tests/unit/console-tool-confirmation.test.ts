import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  beginToolConfirmation,
  conversationEntries,
  customToolResultPayload,
  toolAwaitingConfirmation,
  toolConfirmationPayload,
  toolUseDetails,
} from '../../apps/console/src/components/pages/SessionPages.js';
import type { SessionEvent } from '../../apps/console/src/types.js';

function firstToolEntry(events: SessionEvent[]) {
  const entry = conversationEntries(events).find((value) => value.role === 'tool');
  if (!entry) throw new Error('Expected a tool conversation entry');
  return entry;
}

const base = (content: unknown[], extras: Partial<SessionEvent> = {}): SessionEvent => ({
  id: `evt_${Math.random().toString(36).slice(2)}`,
  type: 'agent.tool_use',
  content,
  created_at: null,
  processed_at: null,
  parent_event_id: null,
  ...extras,
});

describe('Console Tool Runtime confirmation adapter', () => {
  it('shows confirmation for bash always_ask without inspecting its name', () => {
    const event = base([{
      type: 'tool_use', id: 'bash_1', name: 'bash', input: { command: 'rm -i file' },
      requires_confirmation: true,
    }], { requires_action: true });
    const entry = firstToolEntry([event]);
    expect(entry.role).toBe('tool');
    expect(entry.status).toBe('awaiting');
    expect(entry.toolUseId).toBe('bash_1');
    expect(entry.awaitingConfirmation).toBe(true);
  });

  it('shows confirmation for MCP always_ask and pairs mcp results', () => {
    const use = base([{
      type: 'tool_use', id: 'mcp_1', name: 'mcp_github.search', input: { query: 'sandbase' },
      requires_confirmation: true,
    }], { type: 'agent.mcp_tool_use', requires_action: true });
    const result = base([{
      type: 'tool_result', tool_use_id: 'mcp_1', content: 'ok', is_error: false,
    }], { type: 'agent.mcp_tool_result' });
    const entry = firstToolEntry([use, result]);
    expect(entry.status).toBe('completed');
    expect(entry.awaitingConfirmation).toBe(false);
    expect(entry.result).toBe('ok');
  });

  it('uses explicit permission fields and never falls back to tool-name guessing', () => {
    const read = base([{ type: 'tool_use', id: 'read_1', name: 'read', input: {} }]);
    expect(toolAwaitingConfirmation(toolUseDetails(read), false)).toBe(false);
    const alwaysAsk = base([{ type: 'tool_use', id: 'read_2', name: 'read', input: {}, permission: 'always_ask' }]);
    expect(toolAwaitingConfirmation(toolUseDetails(alwaysAsk), false)).toBe(true);
    const alwaysAllow = base([{ type: 'tool_use', id: 'bash_2', name: 'bash', input: {}, permission: 'always_allow' }]);
    expect(toolAwaitingConfirmation(toolUseDetails(alwaysAllow), false)).toBe(false);
  });

  it('builds the exact Allow/Deny event request body', () => {
    expect(toolConfirmationPayload('call_7', 'allow')).toEqual({
      events: [{ type: 'user.tool_confirmation', tool_use_id: 'call_7', result: 'allow' }],
    });
    expect(toolConfirmationPayload('call_7', 'deny')).toEqual({
      events: [{ type: 'user.tool_confirmation', tool_use_id: 'call_7', result: 'deny' }],
    });
  });

  it('keeps confirmation controls one-shot while submission is pending', () => {
    const inFlight = new Set<string>();
    expect(beginToolConfirmation(inFlight, 'call_pending')).toBe(true);
    expect(beginToolConfirmation(inFlight, 'call_pending')).toBe(false);
    const source = readFileSync('apps/console/src/components/pages/SessionPages.tsx', 'utf8');
    expect(source).toContain('beginToolConfirmation(confirmingToolIdsRef.current, toolUseId)');
    expect(source).toContain('toolConfirmationPayload(toolUseId, result)');
    const card = readFileSync('apps/console/src/components/session/ApprovalCard.tsx', 'utf8');
    expect(card).toContain('disabled={confirmingToolIds.has(entry.toolUseId)}');
  });

  it('maps tool results to Completed/Failed cards', () => {
    const use = base([{ type: 'tool_use', id: 'call_8', name: 'mcp_echo', input: {} }]);
    const ok = base([{ type: 'tool_result', tool_use_id: 'call_8', content: 'done' }], { type: 'agent.tool_result' });
    expect(firstToolEntry([use, ok]).status).toBe('completed');
    const failed = base([{ type: 'tool_result', tool_use_id: 'call_8', content: 'boom', is_error: true }], { type: 'agent.tool_result' });
    expect(firstToolEntry([use, failed]).status).toBe('failed');
  });
});

describe('Console custom tool result submission', () => {
  const customUse = (id = 'cust_1', eventId = 'evt_use'): SessionEvent => base(
    [{ type: 'tool_use', id, name: 'lookup_weather', input: { city: 'Berlin' } }],
    { id: eventId, type: 'agent.custom_tool_use', metadata: { custom_tool: true } },
  );

  const customResult = (customToolUseId: string, extras: Partial<SessionEvent> = {}): SessionEvent => base(
    [{ type: 'text', text: 'sunny, 21°C' }],
    // The API projects the accepted block id from the metadata carrier onto
    // the declared top-level `custom_tool_use_id` field.
    { type: 'user.custom_tool_result', custom_tool_use_id: customToolUseId, ...extras },
  );

  it('shows a parked custom tool call awaiting its result, not an approval', () => {
    const entry = firstToolEntry([customUse()]);
    expect(entry.role).toBe('tool');
    expect(entry.toolName).toBe('lookup_weather');
    expect(entry.toolUseId).toBe('cust_1');
    expect(entry.awaitingResult).toBe(true);
    expect(entry.awaitingConfirmation).toBeFalsy();
    expect(entry.status).toBe('awaiting');
  });

  it('pairs user.custom_tool_result by custom_tool_use_id and settles the card', () => {
    const entries = conversationEntries([customUse(), customResult('cust_1')]);
    const toolEntries = entries.filter((entry) => entry.role === 'tool');
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0].status).toBe('completed');
    expect(toolEntries[0].awaitingResult).toBeUndefined();
    expect(toolEntries[0].result).toBe('sunny, 21°C');
  });

  it('marks a result submitted with is_error as failed', () => {
    const result = customResult('cust_1', { metadata: { is_error: true } });
    expect(firstToolEntry([customUse(), result]).status).toBe('failed');
  });

  it('keeps an unpaired custom tool result in its own position', () => {
    const entries = conversationEntries([customResult('cust_missing')]);
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('tool');
    expect(entries[0].result).toBe('sunny, 21°C');
  });

  it('builds the exact user.custom_tool_result request body', () => {
    expect(customToolResultPayload('evt_use', 'sunny, 21°C', false)).toEqual({
      events: [{
        type: 'user.custom_tool_result',
        custom_tool_use_id: 'evt_use',
        content: [{ type: 'text', text: 'sunny, 21°C' }],
        is_error: false,
      }],
    });
    expect(customToolResultPayload('evt_use', 'boom', true).events[0].is_error).toBe(true);
  });

  it('passes the agent.custom_tool_use event id, not the block id', () => {
    // The published contract's `custom_tool_use_id` names the use event.
    const entry = firstToolEntry([customUse('cust_9', 'evt_nine')]);
    const source = readFileSync('apps/console/src/components/session/ApprovalCard.tsx', 'utf8');
    expect(source).toContain('onSubmitResult(entry.toolUseId!, entry.id');
    expect(entry.id).toBe('evt_nine');
  });
});
