// @vitest-environment jsdom
/**
 * The session event render table is indexed by the official
 * `BetaManagedAgentsSessionEventType` vocabulary (see
 * `apps/console/src/lib/eventTypes.ts`). These tests pin two properties:
 * every catalogued type has a renderer that tolerates a minimal event, and
 * tool calls pair with their results by correlation id — `tool_use_id`,
 * `mcp_tool_use_id`, `custom_tool_use_id` — never by name matching.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SESSION_EVENT_TYPES } from '../../../apps/console/src/lib/eventTypes';
import {
  EVENT_RENDERERS,
  describeEvent,
  eventKind,
  renderEventBody,
} from '../../../apps/console/src/components/session/eventRenderers';
import { conversationEntries } from '../../../apps/console/src/components/pages/SessionPages';
import type { SessionEvent } from '../../../apps/console/src/types';

type ToolEntry = Extract<ReturnType<typeof conversationEntries>[number], { role: 'tool' }>;

function toolEntries(events: SessionEvent[]): ToolEntry[] {
  return conversationEntries(events).filter((entry): entry is ToolEntry => entry.role === 'tool');
}

const now = '2026-10-05T12:00:00.000Z';

function minimalEvent(type: string): SessionEvent {
  const base: SessionEvent = {
    id: `evt_${type}`,
    type,
    content: null,
    created_at: now,
    processed_at: now,
    parent_event_id: null,
  };
  if (type === 'agent.tool_use' || type === 'agent.mcp_tool_use' || type === 'agent.custom_tool_use') {
    base.content = [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} }];
  }
  if (type === 'session.error') {
    base.error = { type: 'model_request_failed_error', message: 'boom', retry_status: { type: 'retrying' } };
  }
  if (type === 'span.model_request_end') {
    base.model_usage = { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 5, cache_read_input_tokens: 6 };
  }
  if (type === 'session.usage') {
    base.usage = { input_tokens: 3, output_tokens: 4 };
  }
  return base;
}

describe('the session event render table', () => {
  it('covers every official event type and renders a minimal event without throwing', () => {
    expect(SESSION_EVENT_TYPES.length).toBe(34);
    for (const type of SESSION_EVENT_TYPES) {
      const renderer = EVENT_RENDERERS[type];
      expect(renderer, `missing renderer for ${type}`).toBeDefined();
      const event = minimalEvent(type);
      expect(() => {
        const { unmount } = render(<>{renderEventBody(event)}</>);
        unmount();
      }, `renderer for ${type}`).not.toThrow();
    }
  });

  it('renders an unlisted local extension type through the generic card', () => {
    const event = minimalEvent('internal.resume_after_budget');
    const { container } = render(<>{renderEventBody(event)}</>);
    expect(container.querySelector('details')).not.toBeNull();
    expect(eventKind(event)).toBe('system');
  });

  it('surfaces the error type and retrying status on session.error', () => {
    const event = minimalEvent('session.error');
    const { container } = render(<>{renderEventBody(event)}</>);
    expect(container.textContent).toContain('model_request_failed_error');
    expect(container.textContent).toContain('boom');
    expect(container.textContent).toMatch(/retrying/i);
  });

  it('shows the model_usage buckets on span.model_request_end', () => {
    const event = minimalEvent('span.model_request_end');
    const { container } = render(<>{renderEventBody(event)}</>);
    expect(container.textContent).toContain('Cache read');
    expect(container.textContent).toContain('Cache write');
  });
});

describe('tool call/result pairing', () => {
  const toolUse: SessionEvent = {
    id: 'evt_use',
    seq: 2,
    type: 'agent.tool_use',
    content: [{ type: 'tool_use', id: 'toolu_9', name: 'lookup', input: { q: 'x' } }],
    created_at: now,
    processed_at: now,
    parent_event_id: null,
  };

  it('pairs a result with its call across unrelated events', () => {
    const tools = toolEntries([
      toolUse,
      minimalEvent('session.usage'),
      minimalEvent('agent.thinking'),
      {
        id: 'evt_result',
        seq: 5,
        type: 'agent.tool_result',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_9', name: 'lookup', content: 'done' }],
        created_at: now,
        processed_at: now,
        parent_event_id: null,
      },
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe('completed');
    expect(tools[0].result).toBe('done');
  });

  it('keeps an orphaned result in place instead of pairing it', () => {
    const tools = toolEntries([
      {
        id: 'evt_orphan',
        seq: 1,
        type: 'agent.tool_result',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_missing', content: 'late' }],
        created_at: now,
        processed_at: now,
        parent_event_id: null,
      },
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe('completed');
    expect(tools[0].result).toBe('late');
  });

  it('pairs a custom tool result addressed by the use event id', () => {
    const tools = toolEntries([
      {
        id: 'evt_custom_use',
        seq: 1,
        type: 'agent.custom_tool_use',
        content: [{ type: 'tool_use', id: 'ctu_1', name: 'lookup_weather', input: {} }],
        created_at: now,
        processed_at: now,
        parent_event_id: null,
      },
      minimalEvent('span.model_request_start'),
      {
        id: 'evt_custom_result',
        seq: 3,
        type: 'user.custom_tool_result',
        content: [{ type: 'text', text: 'sunny' }],
        custom_tool_use_id: 'evt_custom_use',
        created_at: now,
        processed_at: now,
        parent_event_id: null,
      },
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe('completed');
    expect(tools[0].result).toBe('sunny');
  });

  it('classifies kinds by the table, not by name substring', () => {
    expect(eventKind(minimalEvent('agent.custom_tool_use'))).toBe('tool');
    expect(eventKind(minimalEvent('user.custom_tool_result'))).toBe('user');
    expect(eventKind(minimalEvent('session.error'))).toBe('error');
    expect(describeEvent(minimalEvent('agent.thread_message_sent')).kind).toBe('agent');
  });
});
