/**
 * Events-to-Messages Mapper
 *
 * Core bijection pattern (ref: OMA history.ts):
 * Converts Event_Log entries into Vercel AI SDK CoreMessage[] format.
 *
 * Rules (from OMA, verified against reference):
 * 1. Pre-pass: build toolNameById map across ALL events for cross-window lookup
 * 2. Respect last compaction boundary with non-empty summary
 * 3. Skip session.* / span.* / turn_complete events (not in model context)
 * 4. Project agent.thinking as 'reasoning' parts in assistant messages
 * 5. Flush ordering: user.message → flushAssistant + flushTools
 *    agent.thinking/message/tool_use → flushTools first
 *    agent.tool_result → flushAssistant first
 * 6. Iterate strictly by seq
 */

import type { SessionEvent } from '@/types/session.js';
import type { ContentBlock } from '@/types/cma-protocol.js';

// ============================================================
// Message Types (Vercel AI SDK compatible)
// ============================================================

export interface UserMessage {
  role: 'user';
  content: ContentPart[];
}

export interface AssistantMessage {
  role: 'assistant';
  content: AssistantContentPart[];
}

export interface ToolMessage {
  role: 'tool';
  content: ToolResultPart[];
}

export interface SystemMessage {
  role: 'system';
  content: string;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mediaType?: string };

export type AssistantContentPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; providerOptions?: Record<string, unknown> }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: Record<string, unknown> };

export type ToolResultPart = {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output:
    | { type: 'text'; value: string }
    | { type: 'json'; value: unknown };
};

export type Message = UserMessage | AssistantMessage | ToolMessage | SystemMessage;

// ============================================================
// Main Function
// ============================================================

/**
 * Project Event_Log into a message array suitable for the LLM.
 *
 * @param events - Events sorted by seq (ascending)
 * @param compactionSummary - Optional summary text from compaction boundary
 */
export function eventsToMessages(
  events: SessionEvent[],
  compactionSummary?: string,
): Message[] {
  // Pre-pass: build toolName lookup across ALL events (OMA pattern)
  const toolNameById = new Map<string, string>();
  for (const event of events) {
    if (
      event.type === 'agent.tool_use' ||
      event.type === 'agent.mcp_tool_use' ||
      event.type === 'agent.custom_tool_use'
    ) {
      const block = event.content?.find((b) => b.type === 'tool_use') as
        | { type: 'tool_use'; id: string; name: string } | undefined;
      if (block) {
        toolNameById.set(block.id, block.name);
      }
    }
  }

  // Find last compaction boundary with non-empty summary
  let boundaryIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'agent.thread_context_compacted') {
      // In our MVP, any compaction boundary is honored
      boundaryIdx = i;
      break;
    }
  }

  // Determine start index (events after boundary)
  const startIdx = boundaryIdx >= 0 ? boundaryIdx + 1 : 0;
  const relevantEvents = events.slice(startIdx);

  const messages: Message[] = [];

  // Resolve the summary: explicit param overrides, else read from the
  // boundary event's own content (that's where the compactor stores it).
  const summary =
    compactionSummary ??
    (boundaryIdx >= 0 ? extractText(events[boundaryIdx].content) : undefined);

  // Inject compaction summary as opening context
  if (summary) {
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: `<conversation-summary>\n${summary}\n</conversation-summary>` }],
    });
  }

  // Walk events and build messages
  let pendingAssistant: AssistantContentPart[] = [];
  let pendingTools: ToolResultPart[] = [];

  const flushAssistant = () => {
    if (pendingAssistant.length > 0) {
      messages.push({ role: 'assistant', content: pendingAssistant });
      pendingAssistant = [];
    }
  };

  const flushTools = () => {
    if (pendingTools.length > 0) {
      messages.push({ role: 'tool', content: pendingTools });
      pendingTools = [];
    }
  };

  for (const event of relevantEvents) {
    switch (event.type) {
      case 'user.message': {
        flushAssistant();
        flushTools();
        const parts = userContentToParts(event.content);
        messages.push({ role: 'user', content: parts });
        break;
      }

      case 'agent.thinking': {
        // OMA: reasoning parts go into assistant content
        flushTools();
        const text = extractText(event.content);
        if (text) {
          pendingAssistant.push({ type: 'reasoning', text });
        }
        break;
      }

      case 'agent.message': {
        flushTools();
        const text = extractText(event.content);
        if (text) {
          pendingAssistant.push({ type: 'text', text });
        }
        break;
      }

      case 'agent.tool_use':
      case 'agent.mcp_tool_use':
      case 'agent.custom_tool_use': {
        flushTools();
        const block = event.content?.find((b) => b.type === 'tool_use') as
          | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
          | undefined;
        if (block) {
          pendingAssistant.push({
            type: 'tool-call',
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
          });
        }
        break;
      }

      case 'agent.tool_result':
      case 'agent.mcp_tool_result': {
        // Flush assistant first (tool_use must be in a committed assistant message)
        flushAssistant();
        const resultBlock = event.content?.find((b) => b.type === 'tool_result') as
          | { type: 'tool_result'; tool_use_id: string; content: unknown }
          | undefined;
        if (resultBlock) {
          const toolName = toolNameById.get(resultBlock.tool_use_id) ?? 'unknown';
          pendingTools.push({
            type: 'tool-result',
            toolCallId: resultBlock.tool_use_id,
            toolName,
            output: typeof resultBlock.content === 'string'
              ? { type: 'text', value: resultBlock.content }
              : { type: 'json', value: resultBlock.content },
          });
        }
        break;
      }

      // Skip non-context events
      case 'agent.message_stream_start':
      case 'agent.message_chunk':
      case 'agent.message_stream_end':
      case 'user.interrupt':
      case 'user.tool_confirmation':
      case 'user.custom_tool_result':
      case 'session.status_idle':
      case 'session.status_running':
      case 'session.status_rescheduled':
      case 'session.status_terminated':
      case 'session.error':
      case 'session.deleted':
      case 'span.model_request_start':
      case 'span.model_request_end':
      case 'turn_complete':
      case 'agent.thread_context_compacted':
        break;

      default:
        break;
    }
  }

  // Flush remaining
  flushAssistant();
  flushTools();

  return messages;
}

// ============================================================
// Helpers
// ============================================================

function userContentToParts(content?: ContentBlock[]): ContentPart[] {
  if (!content || content.length === 0) return [{ type: 'text', text: '' }];

  const parts: ContentPart[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' && 'source' in block) {
      const src = (block as any).source;
      if (src?.data) {
        parts.push({ type: 'image', image: src.data, mediaType: src.media_type });
      } else if (src?.url) {
        parts.push({ type: 'text', text: `[Image: ${src.url}]` });
      }
    }
    // Documents and other blocks → text fallback
    else {
      parts.push({ type: 'text', text: JSON.stringify(block) });
    }
  }
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

function extractText(content?: ContentBlock[]): string {
  if (!content) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
