import { type ReactNode, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import i18n from '../../i18n';
import type { SessionEvent, ToolPermission } from '../../types';
import { shortId, titleCase, truncateMiddle } from '../../lib/format';

import { safeMarkdownUrl } from '../../lib/markdown';
import {
  SESSION_EVENT_TYPES,
  TOOL_RESULT_EVENT_TYPES,
  TOOL_USE_EVENT_TYPES,
  type SessionEventType,
} from '../../lib/eventTypes';

export type EventKind = 'user' | 'agent' | 'tool' | 'error' | 'system';

// Renderer chrome (fact labels, code-block affordances) reads the sessions
// namespace directly — these bodies render inside components that already
// re-render on language change.
const tEvents = (key: string, options?: Record<string, unknown>): string => i18n.t(`sessions:detail.events.${key}` as never, options);

/**
 * How one event type is presented. `kind` drives the colored tag and the
 * mini-map; `title`/`summary` feed the event list and inspector; `body` is
 * the rendered preview — types without a dedicated body get the generic
 * summary-plus-facts card, and types absent from the table entirely (local
 * extensions, future types) get a collapsible JSON card.
 */
export interface EventRenderer {
  kind: EventKind;
  title(event: SessionEvent): string;
  summary(event: SessionEvent): string;
  body?(event: SessionEvent): ReactNode;
}

function fallbackTitle(type: string): string {
  return titleCase(type.replaceAll('.', ' ').replaceAll('_', ' '));
}

const sessionStatusTitle = (event: SessionEvent) => tEvents('titles.sessionStatus', { status: tEvents(`statusNames.${event.type.replace('session.status_', '')}`) });
const threadStatusTitle = (event: SessionEvent) => tEvents('titles.threadStatus', { status: tEvents(`statusNames.${event.type.replace('session.thread_status_', '')}`) });

export const EVENT_RENDERERS: Record<SessionEventType, EventRenderer> = {
  'user.message': {
    kind: 'user',
    title: (event) => eventText(event) || tEvents('titles.userMessage'),
    summary: () => tEvents('summaries.userMessage'),
  },
  'user.interrupt': {
    kind: 'user',
    title: () => tEvents('titles.interrupted'),
    summary: () => tEvents('summaries.interrupted'),
  },
  'user.tool_confirmation': {
    kind: 'user',
    title: () => tEvents('titles.toolConfirmation'),
    summary: () => tEvents('summaries.toolConfirmation'),
  },
  'user.tool_result': {
    kind: 'user',
    title: () => tEvents('titles.toolResultSupplied'),
    summary: () => tEvents('summaries.toolResultSupplied'),
  },
  'user.custom_tool_result': {
    kind: 'user',
    title: () => tEvents('titles.customToolResult'),
    summary: () => tEvents('summaries.customToolResult'),
  },
  'user.define_outcome': {
    kind: 'user',
    title: () => tEvents('titles.outcomeDefined'),
    summary: (event) => typeof event.description === 'string' && event.description ? event.description : tEvents('summaries.outcomeDefined'),
  },
  'agent.message': {
    kind: 'agent',
    title: () => tEvents('titles.agentMessage'),
    summary: () => tEvents('summaries.agentMessage'),
    body: (event) => <div className="conversationBubble debugConversationBubble"><MarkdownMessage text={eventText(event)} /></div>,
  },
  'agent.thinking': {
    kind: 'agent',
    title: () => tEvents('titles.thinking'),
    summary: () => tEvents('summaries.thinking'),
    body: (event) => <div className="conversationBubble debugConversationBubble"><MarkdownMessage text={eventText(event)} /></div>,
  },
  'agent.tool_use': {
    kind: 'tool',
    title: (event) => toolUseDetails(event).toolName,
    summary: (event) => tEvents('summaries.toolCall', { tool: toolUseDetails(event).toolName }),
    body: toolBody,
  },
  'agent.mcp_tool_use': {
    kind: 'tool',
    title: (event) => toolUseDetails(event).toolName,
    summary: (event) => tEvents('summaries.mcpToolCall', { tool: toolUseDetails(event).toolName }),
    body: toolBody,
  },
  'agent.custom_tool_use': {
    kind: 'tool',
    title: (event) => tEvents('titles.customTool', { tool: toolUseDetails(event).toolName }),
    summary: (event) => tEvents('summaries.customToolParked', { tool: toolUseDetails(event).toolName }),
    body: toolBody,
  },
  'agent.tool_result': {
    kind: 'tool',
    title: () => tEvents('titles.toolResult'),
    summary: (event) => tEvents(toolResultText(event) ? 'summaries.toolResult' : 'summaries.toolResultEmpty'),
    body: toolBody,
  },
  'agent.mcp_tool_result': {
    kind: 'tool',
    title: () => tEvents('titles.mcpToolResult'),
    summary: () => tEvents('summaries.mcpToolResult'),
    body: toolBody,
  },
  'agent.thread_message_received': {
    kind: 'agent',
    title: () => tEvents('titles.threadMessageReceived'),
    summary: () => tEvents('summaries.threadMessageReceived'),
  },
  'agent.thread_message_sent': {
    kind: 'agent',
    title: () => tEvents('titles.threadMessageSent'),
    summary: () => tEvents('summaries.threadMessageSent'),
  },
  'agent.thread_context_compacted': {
    kind: 'system',
    title: () => tEvents('titles.contextCompacted'),
    summary: () => tEvents('summaries.contextCompacted'),
  },
  'session.error': {
    kind: 'error',
    title: (event) => event.error?.message || eventText(event) || tEvents('titles.sessionError'),
    summary: () => tEvents('summaries.sessionError'),
    body: sessionErrorBody,
  },
  'session.status_running': {
    kind: 'system',
    title: sessionStatusTitle,
    summary: () => tEvents('summaries.sessionRunning'),
  },
  'session.status_idle': {
    kind: 'system',
    title: sessionStatusTitle,
    summary: () => tEvents('summaries.sessionIdle'),
  },
  'session.status_rescheduled': {
    kind: 'system',
    title: sessionStatusTitle,
    summary: () => tEvents('summaries.sessionRescheduled'),
  },
  'session.status_terminated': {
    kind: 'system',
    title: sessionStatusTitle,
    summary: () => tEvents('summaries.sessionTerminated'),
  },
  'session.thread_created': {
    kind: 'system',
    title: () => tEvents('titles.threadCreated'),
    summary: () => tEvents('summaries.threadCreated'),
  },
  'session.thread_status_running': {
    kind: 'system',
    title: threadStatusTitle,
    summary: () => tEvents('summaries.threadRunning'),
  },
  'session.thread_status_idle': {
    kind: 'system',
    title: threadStatusTitle,
    summary: () => tEvents('summaries.threadIdle'),
  },
  'session.thread_status_rescheduled': {
    kind: 'system',
    title: threadStatusTitle,
    summary: () => tEvents('summaries.threadRescheduled'),
  },
  'session.thread_status_terminated': {
    kind: 'system',
    title: threadStatusTitle,
    summary: () => tEvents('summaries.threadTerminated'),
  },
  'session.updated': {
    kind: 'system',
    title: () => tEvents('titles.sessionUpdated'),
    summary: () => tEvents('summaries.sessionUpdated'),
  },
  'session.usage': {
    kind: 'system',
    title: () => tEvents('titles.usageSnapshot'),
    summary: () => tEvents('summaries.usageSnapshot'),
    body: sessionUsageBody,
  },
  'system.message': {
    kind: 'system',
    title: () => tEvents('titles.systemMessage'),
    summary: () => tEvents('summaries.systemMessage'),
    body: (event) => <div className="conversationBubble debugConversationBubble"><MarkdownMessage text={eventText(event)} /></div>,
  },
  'span.model_request_start': {
    kind: 'system',
    title: () => tEvents('titles.modelRequestStart'),
    summary: () => tEvents('summaries.modelRequestStart'),
  },
  'span.model_request_end': {
    kind: 'system',
    title: (event) => {
      const text = eventText(event);
      if (text) return tEvents('titles.modelRequestStopWithDetail', { detail: text });
      return event.model_used ? tEvents('titles.modelRequestStopWithDetail', { detail: event.model_used }) : tEvents('titles.modelRequestStop');
    },
    summary: (event) => tEvents(event.is_error ? 'summaries.modelRequestError' : 'summaries.modelRequestDone'),
    body: modelRequestEndBody,
  },
  'span.outcome_evaluation_start': {
    kind: 'system',
    title: () => tEvents('titles.outcomeEvalStart'),
    summary: () => tEvents('summaries.outcomeEvalStart'),
  },
  'span.outcome_evaluation_ongoing': {
    kind: 'system',
    title: () => tEvents('titles.outcomeEvalOngoing'),
    summary: () => tEvents('summaries.outcomeEvalOngoing'),
  },
  'span.outcome_evaluation_end': {
    kind: 'system',
    title: () => tEvents('titles.outcomeEvalEnd'),
    summary: () => tEvents('summaries.outcomeEvalEnd'),
  },
};

/**
 * Local extension types that still deserve a friendly row instead of the
 * generic card. Not part of the published union — see
 * `LOCAL_SESSION_EVENT_TYPES`.
 */
const LOCAL_RENDERERS: Record<string, EventRenderer> = {
  'session.deleted': {
    kind: 'system',
    title: () => tEvents('titles.sessionDeleted'),
    summary: () => tEvents('summaries.sessionDeleted'),
  },
  'user.steer': {
    kind: 'user',
    title: () => tEvents('titles.steer'),
    summary: () => tEvents('summaries.steer'),
  },
  'turn_complete': {
    kind: 'system',
    title: () => tEvents('titles.turnComplete'),
    summary: () => tEvents('summaries.turnComplete'),
  },
};

const GENERIC_RENDERER: EventRenderer = {
  kind: 'system',
  title: (event) => fallbackTitle(event.type),
  summary: (event) => tEvents('summaries.generic', { type: titleCase(event.type.replaceAll('.', ' ').replaceAll('_', ' ')) }),
};

export function describeEvent(event: SessionEvent): EventRenderer {
  return (EVENT_RENDERERS as Record<string, EventRenderer>)[event.type] ?? LOCAL_RENDERERS[event.type] ?? GENERIC_RENDERER;
}

export function eventKind(event: SessionEvent): EventKind {
  return describeEvent(event).kind;
}

export function eventTitle(event: SessionEvent): string {
  return describeEvent(event).title(event);
}

export function eventSummary(event: SessionEvent): string {
  return describeEvent(event).summary(event);
}

/**
 * The rendered body for the inspector's Preview tab. A type with a dedicated
 * `body` uses it; other catalogued types get the summary-plus-facts card; an
 * unlisted type (local extension or newer SDK event) gets a collapsible JSON
 * card rather than an error.
 */
export function renderEventBody(event: SessionEvent): ReactNode {
  const renderer = describeEvent(event);
  if (renderer.body) return renderer.body(event);
  if (renderer === GENERIC_RENDERER) return <UnknownEventCard event={event} />;
  return <DefaultEventBody event={event} />;
}

function DefaultEventBody({ event }: { event: SessionEvent }) {
  const text = eventText(event);
  const facts = eventFacts(event);
  return (
    <div className="renderedEvent debugEventSummary">
      <p>{text || eventSummary(event)}</p>
      {facts.length ? (
        <dl className="debugEventFacts">
          {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      ) : null}
    </div>
  );
}

/** Fallback for event types the render table does not know. */
function UnknownEventCard({ event }: { event: SessionEvent }) {
  return (
    <details className="renderedEvent debugEventSummary unknownEventCard">
      <summary>{eventSummary(event)}</summary>
      <pre>{formatToolValue({ ...event, content: event.content ?? undefined })}</pre>
    </details>
  );
}

function toolBody(event: SessionEvent): ReactNode {
  return (
    <div className="renderedEvent debugEventBody">
      <p>{eventSummary(event)}</p>
      <pre>{formatToolValue(event.content)}</pre>
    </div>
  );
}

function sessionErrorBody(event: SessionEvent): ReactNode {
  const error = event.error;
  const facts = eventFacts(event);
  const retrying = error?.retry_status?.type === 'retrying';
  return (
    <div className="renderedEvent debugEventSummary">
      {error?.type ? <p><code>{error.type}</code></p> : null}
      <p>{error?.message || eventText(event) || eventSummary(event)}</p>
      {retrying ? <p className="fieldHint">{tEvents('retrying')}</p> : null}
      {error?.retry_status && !retrying ? <p className="fieldHint">{tEvents('retryStatus')}: <code>{error.retry_status.type}</code></p> : null}
      {facts.length ? (
        <dl className="debugEventFacts">
          {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      ) : null}
    </div>
  );
}

function modelRequestEndBody(event: SessionEvent): ReactNode {
  const usage = event.model_usage;
  const facts = eventFacts(event);
  return (
    <div className="renderedEvent debugEventSummary">
      <p>{eventText(event) || eventSummary(event)}</p>
      {usage ? (
        <dl className="debugEventFacts">
          <div><dt>{tEvents('inputTokens')}</dt><dd>{usage.input_tokens}</dd></div>
          <div><dt>{tEvents('outputTokens')}</dt><dd>{usage.output_tokens}</dd></div>
          {usage.cache_read_input_tokens ? <div><dt>{tEvents('cacheRead')}</dt><dd>{usage.cache_read_input_tokens}</dd></div> : null}
          {usage.cache_creation_input_tokens ? <div><dt>{tEvents('cacheWrite')}</dt><dd>{usage.cache_creation_input_tokens}</dd></div> : null}
          {usage.speed ? <div><dt>{tEvents('speed')}</dt><dd>{usage.speed}</dd></div> : null}
        </dl>
      ) : null}
      {event.model_request_start_id ? <p className="fieldHint">{tEvents('closesRequest', { id: truncateMiddle(event.model_request_start_id, 18) })}</p> : null}
      {facts.length ? (
        <dl className="debugEventFacts">
          {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      ) : null}
    </div>
  );
}

function sessionUsageBody(event: SessionEvent): ReactNode {
  const usage = event.usage;
  if (!usage) return <DefaultEventBody event={event} />;
  return (
    <div className="renderedEvent debugEventSummary">
      <dl className="debugEventFacts">
        <div><dt>{tEvents('inputTokens')}</dt><dd>{usage.input_tokens ?? 0}</dd></div>
        <div><dt>{tEvents('outputTokens')}</dt><dd>{usage.output_tokens ?? 0}</dd></div>
        {usage.cache_read_input_tokens ? <div><dt>{tEvents('cacheRead')}</dt><dd>{usage.cache_read_input_tokens}</dd></div> : null}
        {usage.cache_creation?.ephemeral_5m_input_tokens ? <div><dt>{tEvents('cacheWrite5m')}</dt><dd>{usage.cache_creation.ephemeral_5m_input_tokens}</dd></div> : null}
        {usage.cache_creation?.ephemeral_1h_input_tokens ? <div><dt>{tEvents('cacheWrite1h')}</dt><dd>{usage.cache_creation.ephemeral_1h_input_tokens}</dd></div> : null}
        {usage.active_seconds !== undefined ? <div><dt>{tEvents('active')}</dt><dd>{formatSeconds(usage.active_seconds)}</dd></div> : null}
        {usage.list_cost ? <div><dt>{tEvents('listCost')}</dt><dd>{usage.list_cost.amount} {usage.list_cost.currency}¢</dd></div> : null}
      </dl>
    </div>
  );
}

export function eventFacts(event: SessionEvent): Array<[string, string]> {
  const facts: Array<[string, string]> = [];
  if (event.model_used) facts.push([tEvents('model'), event.model_used]);
  if (event.duration_ms !== undefined) facts.push([tEvents('duration'), formatMilliseconds(event.duration_ms)]);
  if (event.tokens_in !== undefined || event.tokens_out !== undefined) {
    facts.push([tEvents('tokens'), tEvents('tokensInOut', { in: event.tokens_in ?? 0, out: event.tokens_out ?? 0 })]);
  }
  // A model-derived stop reason is a string; a session.status_idle one is the
  // object the session contract publishes — only its `type` reads sensibly.
  if (event.stop_reason) facts.push([tEvents('stopReason'), typeof event.stop_reason === 'string' ? event.stop_reason : event.stop_reason.type]);
  if (event.parent_event_id) facts.push([tEvents('parentEvent'), shortId(event.parent_event_id)]);
  return facts;
}

export function formatMilliseconds(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} s`;
}

function formatSeconds(value: number): string {
  if (value < 60) return `${Math.round(value)} s`;
  return `${(value / 60).toFixed(1)} min`;
}

export function eventText(event: SessionEvent) {
  if (event.delta) return event.delta;
  const content = normalizeEventContent(event.content);
  if (content.length === 0) return '';
  return content.map((part) => {
    if (part && typeof part === 'object') {
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (typeof record.message === 'string') return record.message;
      if (typeof record.error === 'string') return record.error;
    }
    return typeof part === 'string' ? part : JSON.stringify(part);
  }).join('\n');
}

export function normalizeEventContent(content: SessionEvent['content']): unknown[] {
  if (Array.isArray(content)) return content;
  if (content === null || content === undefined) return [];
  return [content];
}

export function toolUseDetails(event: SessionEvent): {
  toolName: string;
  toolUseId?: string;
  input?: unknown;
  requiresConfirmation?: boolean;
  permission?: ToolPermission;
} {
  const block = findToolBlock(event, ['tool_use', 'mcp_tool_use', 'custom_tool_use']);
  const record = block as Record<string, unknown> | undefined;
  const toolName = typeof record?.name === 'string'
    ? record.name
    : typeof record?.tool_name === 'string' ? record.tool_name : fallbackTitle(event.type);
  const toolUseId = typeof record?.id === 'string'
    ? record.id
    : typeof record?.tool_use_id === 'string'
      ? record.tool_use_id
      : typeof record?.mcp_tool_use_id === 'string' ? record.mcp_tool_use_id : toolUseIdFromEvent(event);
  const metadata = event.metadata;
  const requiresConfirmation = firstBoolean(
    record?.requires_confirmation,
    record?.requiresConfirmation,
    event.requires_confirmation,
    metadata?.requires_confirmation,
    metadata?.requiresConfirmation,
  );
  const permission = firstPermission(
    record?.permission,
    event.permission,
    metadata?.permission,
  );
  return {
    toolName,
    toolUseId,
    input: record?.input ?? record?.arguments ?? record?.args,
    ...(requiresConfirmation !== undefined ? { requiresConfirmation } : {}),
    ...(permission ? { permission } : {}),
  };
}

export function toolResultDetails(event: SessionEvent): { toolName: string } {
  const block = findToolBlock(event, ['tool_result', 'mcp_tool_result']) as Record<string, unknown> | undefined;
  return { toolName: typeof block?.name === 'string' ? block.name : 'tool' };
}

export function findToolBlock(event: SessionEvent, types: string[]): unknown {
  return normalizeEventContent(event.content).find((part) => part && typeof part === 'object' && types.includes(String((part as Record<string, unknown>).type)));
}

export function toolResultText(event: SessionEvent): string {
  const block = findToolBlock(event, ['tool_result', 'mcp_tool_result']) as Record<string, unknown> | undefined;
  return formatToolText(block?.content ?? block?.output ?? block?.result ?? eventText(event));
}

export function toolResultFailed(event: SessionEvent): boolean {
  const block = findToolBlock(event, ['tool_result', 'mcp_tool_result']) as Record<string, unknown> | undefined;
  return block?.is_error === true || block?.isError === true || event.is_error === true || event.isError === true
    || event.metadata?.is_error === true;
}

export function formatToolText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => formatToolText(part)).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
    return formatToolValue(value);
  }
  return value == null ? '' : String(value);
}

export function formatToolValue(value: unknown): string {
  if (value === undefined) return tEvents('noParameters');
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function toolOperation(toolName: string): string {
  const key = toolName.toLowerCase();
  if (key.includes('bash') || key.includes('shell') || key.includes('terminal') || key === 'exec') return 'bash';
  if (key.includes('read') || key.includes('view') || key.includes('cat')) return 'read';
  if (key.includes('replace') || key.includes('patch') || key.includes('edit') || key.includes('write') || key.includes('create')) return 'replace';
  if (key.includes('glob') || key.includes('list') || key.includes('ls')) return 'list';
  if (key.includes('grep') || key.includes('search')) return 'search';
  return toolName || 'tool';
}

export function toolUseIdFromEvent(event: SessionEvent): string | undefined {
  const block = event.content?.find((part) => part && typeof part === 'object' && ['tool_use', 'mcp_tool_use', 'custom_tool_use'].includes(String((part as Record<string, unknown>).type))) as Record<string, unknown> | undefined;
  return typeof block?.id === 'string' ? block.id : event.tool_use_id ?? event.mcp_tool_use_id;
}

export function firstBoolean(...values: unknown[]): boolean | undefined {
  const value = values.find((candidate) => typeof candidate === 'boolean');
  return typeof value === 'boolean' ? value : undefined;
}

export function firstPermission(...values: unknown[]): ToolPermission | undefined {
  for (const candidate of values) {
    if (candidate === 'always_allow' || candidate === 'always_ask' || candidate === 'never_allow' || candidate === 'auto') return candidate;
    if (candidate && typeof candidate === 'object' && 'type' in candidate) {
      const type = (candidate as { type?: unknown }).type;
      if (type === 'always_allow' || type === 'always_ask' || type === 'never_allow' || type === 'auto') return type;
    }
  }
  return undefined;
}

export function toolResultId(event: SessionEvent): string | undefined {
  if (!TOOL_RESULT_EVENT_TYPES.has(event.type)) return undefined;
  const block = event.content?.find((part) => part && typeof part === 'object' && ['tool_result', 'mcp_tool_result', 'custom_tool_result'].includes(String((part as Record<string, unknown>).type))) as Record<string, unknown> | undefined;
  if (typeof block?.tool_use_id === 'string') return block.tool_use_id;
  if (typeof block?.mcp_tool_use_id === 'string') return block.mcp_tool_use_id;
  if (typeof block?.custom_tool_use_id === 'string') return block.custom_tool_use_id;
  if (typeof block?.toolUseId === 'string') return block.toolUseId;
  if (typeof block?.mcpToolUseId === 'string') return block.mcpToolUseId;
  return event.tool_use_id ?? event.mcp_tool_use_id ?? event.custom_tool_use_id;
}

export function isToolUseEvent(event: SessionEvent): boolean {
  return TOOL_USE_EVENT_TYPES.has(event.type);
}

export function isToolResultEvent(event: SessionEvent): boolean {
  return TOOL_RESULT_EVENT_TYPES.has(event.type);
}

/**
 * Markdown renderer used for assistant messages.  Keep code blocks as a
 * first-class, copyable surface while leaving inline code inline.  The
 * renderer intentionally relies on react-markdown's safe AST pipeline rather
 * than injecting HTML into the conversation.
 */
function MarkdownCode(props: { children?: ReactNode; className?: string }) {
  return <code className={props.className}>{props.children}</code>;
}

function MarkdownPre(props: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const text = preRef.current?.textContent ?? '';
    if (!text) return;
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="markdownCodeBlock">
      <div className="markdownCodeHeader">
        <span>{tEvents('code')}</span>
        <button type="button" onClick={() => void copy()} aria-label={tEvents('copyCode')}>
          {copied ? tEvents('copied') : tEvents('copy')}
        </button>
      </div>
      <pre ref={preRef}>{props.children}</pre>
    </div>
  );
}

function MarkdownLink(props: { href?: string; children?: ReactNode }) {
  const external = Boolean(props.href && /^https?:\/\//i.test(props.href));
  return (
    <a
      href={props.href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noreferrer' : undefined}
    >
      {props.children}
    </a>
  );
}

export function MarkdownMessage({ text }: { text: string }) {
  const normalizedText = normalizeMarkdownText(text);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={safeMarkdownUrl}
      components={{ code: MarkdownCode, pre: MarkdownPre, a: MarkdownLink }}
    >
      {normalizedText || i18n.t('sessions:detail.timeline.noMessageContent')}
    </ReactMarkdown>
  );
}

export function normalizeMarkdownText(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  const lines = normalized.split('\n');
  const output: string[] = [];
  let inFence = false;
  let pendingBlank = false;
  for (const line of lines) {
    const isFence = /^\s*(```|~~~)/.test(line);
    if (!inFence && line.trim() === '') {
      pendingBlank = output.length > 0;
      continue;
    }
    if (pendingBlank && output.length > 0 && output.at(-1) !== '') output.push('');
    pendingBlank = false;
    output.push(line);
    if (isFence) inFence = !inFence;
  }
  return output.join('\n').trim();
}
