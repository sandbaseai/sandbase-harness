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

/** Compaction boundary honored by the projection. */
export interface CompactionBoundaryProjection {
  summary?: string;
  /** Events with `seq <= eventSeqBefore` are covered by the summary. */
  eventSeqBefore?: number;
}

/**
 * Project Event_Log into a message array suitable for the LLM.
 *
 * @param events - Events sorted by seq (ascending)
 * @param boundary - A compaction boundary `{summary, eventSeqBefore}`, or a
 *   bare summary string for legacy callers.
 */
export function eventsToMessages(
  events: SessionEvent[],
  boundary?: CompactionBoundaryProjection | string,
  privateReasoning?: (eventId: string) => string | undefined,
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

  const boundaryObj = typeof boundary === 'object' ? boundary : undefined;
  const summaryOverride = typeof boundary === 'string' ? boundary : undefined;

  let relevantEvents: SessionEvent[];
  let summary: string | undefined;
  if (boundaryObj?.eventSeqBefore !== undefined) {
    // Table-backed boundary: the summary covers every event up to this seq,
    // and the preserved tail sits after it. The notification event itself is
    // skipped by the projection switch below.
    relevantEvents = events.filter((e) => e.seq > boundaryObj.eventSeqBefore!);
    summary = boundaryObj.summary ?? summaryOverride;
  } else {
    // Legacy logs: a compacted event that still carries its summary in
    // `content` is the boundary. A notification-only compacted event (no
    // content) is not one — without a boundary row there is no way to know
    // which tail it preserved, so dropping history would be wrong.
    let boundaryIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (
        events[i].type === 'agent.thread_context_compacted' &&
        extractText(events[i].content)
      ) {
        boundaryIdx = i;
        break;
      }
    }
    relevantEvents = boundaryIdx >= 0 ? events.slice(boundaryIdx + 1) : events;
    summary =
      summaryOverride ??
      (boundaryIdx >= 0 ? extractText(events[boundaryIdx].content) : undefined);
  }

  const messages: Message[] = [];

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

      case 'user.define_outcome': {
        // The event carries no content blocks: its payload lives in `metadata`,
        // and the projection turns it back into the instruction the agent works
        // against. Without this the outcome would be durable and unread, and the
        // turn it queued would run with no criteria at all.
        flushAssistant();
        flushTools();
        const instruction = outcomeInstruction(event.metadata);
        if (instruction) {
          messages.push({ role: 'user', content: [{ type: 'text', text: instruction }] });
        }
        break;
      }

      case 'agent.thinking': {
        // OMA: reasoning parts go into assistant content
        flushTools();
        const text = privateReasoning?.(event.id) ?? extractText(event.content);
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

      case 'user.custom_tool_result': {
        // The result is an inbound event, but it is the model-facing tool result
        // for the preceding agent.custom_tool_use call, so it projects as a tool
        // result rather than as user input.
        flushAssistant();
        const customToolCallId = typeof event.metadata?.custom_tool_use_id === 'string'
          ? event.metadata.custom_tool_use_id
          : undefined;
        if (customToolCallId) {
          const toolName = toolNameById.get(customToolCallId) ?? 'unknown';
          pendingTools.push({
            type: 'tool-result',
            toolCallId: customToolCallId,
            toolName,
            output: contentBlocksToToolOutput(event.content),
            ...(event.metadata?.is_error === true ? { isError: true } : {}),
          });
        }
        break;
      }

      // Skip non-context events
      case 'agent.message_stream_start':
      case 'agent.message_chunk':
      case 'agent.message_stream_end':
      case 'system.message': {
        // Privileged system-level context, distinct from the agent's `system`
        // field: it applies to this turn and every later turn, so it projects
        // as its own `system` role turn rather than folding into the prompt.
        flushAssistant();
        flushTools();
        const systemText = contentBlocksToText(event.content);
        // A whitespace-only block is not usable context. Emitting it would put
        // an empty `system` turn in front of the model and, because the turn
        // is permanent, would do so on every later turn too.
        if (systemText && systemText.trim()) {
          messages.push({ role: 'system', content: systemText.trim() });
        }
        break;
      }

      case 'user.interrupt':
      // A steer is not re-projected into the model context. It was written to the
      // live engine session's own input channel while its turn was running, so the
      // child has already read it; projecting it here as well would deliver the
      // same instruction twice — and would do it as an ordinary user turn, which is
      // exactly what `user.steer` is not.
      case 'user.steer':
      case 'user.tool_confirmation':
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

// ============================================================
// Helpers
// ============================================================

/**
 * Rebuild a declared outcome's instruction from its persisted metadata.
 *
 * `user.define_outcome` carries `description`, `rubric` and `max_iterations`
 * instead of content blocks, so the projection reconstructs the wording the
 * agent works against. A file rubric is named by its id rather than inlined:
 * the agent may not be able to read that file, and the runtime does not put a
 * rubric into the agent's context that it cannot show it.
 */
export function outcomeInstruction(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  const description = typeof metadata.description === 'string' ? metadata.description.trim() : '';
  if (!description) return undefined;
  const rubric = metadata.rubric;
  const rubricRecord = rubric && typeof rubric === 'object' && !Array.isArray(rubric)
    ? rubric as Record<string, unknown>
    : undefined;
  const rubricText = typeof rubricRecord?.content === 'string'
    ? rubricRecord.content
    : typeof rubricRecord?.file_id === 'string'
      ? `(rubric file ${rubricRecord.file_id})`
      : '';
  const iterations = typeof metadata.max_iterations === 'number' ? metadata.max_iterations : undefined;
  return [
    'Work until the following outcome is satisfied. Do not ask for confirmation; produce the deliverable.',
    '',
    `Outcome: ${description}`,
    ...(rubricText ? ['', 'Measure your work against this rubric:', rubricText] : []),
    ...(iterations !== undefined ? ['', `Evaluation iterations allowed: ${iterations}`] : []),
  ].join('\n');
}

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

/** Flatten content blocks to the text a model reads, for non-text carriers. */
function contentBlocksToToolOutput(content?: ContentBlock[]): ToolResultPart['output'] {
  if (!content || content.length === 0) return { type: 'text', value: '' };
  if (content.every((block) => block.type === 'text')) {
    return {
      type: 'text',
      value: content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
    };
  }
  return { type: 'json', value: content };
}

function contentBlocksToText(content?: ContentBlock[]): string {
  if (!content) return '';
  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text;
        case 'image': {
          const source = block.source;
          const locator = source.url ?? source.file_id ?? (source.data ? '[embedded data]' : '[image]');
          return `[Image: ${locator}]`;
        }
        case 'document': {
          const source = block.source;
          const locator = source.url ?? source.file_id ?? source.data ?? '';
          return [block.title, block.context, locator].filter(Boolean).join('\n');
        }
        default:
          return JSON.stringify(block);
      }
    })
    .filter(Boolean)
    .join('\n');
}
