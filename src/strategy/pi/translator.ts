import type { CMAEventType, ContentBlock } from '@/types/cma-protocol.js';
import type { EventLogWriter } from '@/types/strategy.js';
import type { SessionEvent } from '@/types/session.js';
import { readPiJsonl, PiJsonlProtocolError } from './jsonl-reader.js';
import { PiMarkupBuffer, stripPiToolCallMarkup } from './text-markup.js';


type RawPiEvent = Record<string, unknown>;

type DurableEvent = {
  type: Exclude<CMAEventType, 'agent.message_stream_start' | 'agent.message_chunk' | 'agent.message_stream_end'>;
  content?: ContentBlock[];
  modelUsed?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  stopReason?: string;
  durationMs?: number;
  parentEventId?: string;
  isError?: boolean;
};

export interface PiTranslatorOptions {
  sessionId: string;
  model: string;
  eventLog: EventLogWriter;
  broadcast: (event: SessionEvent) => void;
  recordUsage: (
    sessionId: string,
    inputTokens: number,
    outputTokens: number,
    cache?: { read?: number; write?: number },
  ) => void;
  /**
   * Shared overflow contract. Injected rather than imported so the translator
   * stays a pure stdout reader and the spill decision, including whether a
   * file was really written, stays in one module.
   */
  spillToolOutput: (output: string) => Promise<string>;
}

export interface PiTranslationSummary {
  sawSessionHeader: boolean;
  sawFinalAssistantMessage: boolean;
  requestCount: number;
  nativeToolCount: number;
  inputTokens: number;
  outputTokens: number;
  lastTurnError?: string;
  fatalProtocolError?: string;
  stderrTail?: string;
  text: string;
}

export class PiProtocolError extends Error {
  readonly code = 'pi_protocol_error';

  constructor(message: string) {
    super(message);
    this.name = 'PiProtocolError';
  }
}

/**
 * Converts one Pi stdout JSONL stream into SandBase canonical events.
 * Durable events are appended and broadcast here; callers must not yield them
 * again or the same event would be broadcast twice by SessionManager.
 */
export class PiTranslator {
  private readonly markup = new PiMarkupBuffer();
  private readonly summary: PiTranslationSummary = {
    sawSessionHeader: false,
    sawFinalAssistantMessage: false,
    requestCount: 0,
    nativeToolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    text: '',
  };
  private lineNumber = 0;
  private requestStart?: SessionEvent;
  private requestStartedAt = 0;
  private requestUsageRecorded = false;
  private currentTurnText = '';
  private currentThinking = '';
  private finalMessageText = '';
  private transientMessageId = '';
  private transientOpen = false;

  constructor(private readonly options: PiTranslatorOptions) {}

  async consume(stdout: AsyncIterable<Uint8Array | string>): Promise<void> {
    for await (const line of readPiJsonl(stdout)) {
      this.lineNumber += 1;
      const trimmed = line.trim();
      // Some Pi builds emit a short non-JSON diagnostic on stdout. It cannot
      // grant authority, so ignore it; malformed JSON objects are different and
      // fail the turn below.
      if (!trimmed.startsWith('{')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw this.protocolError('malformed JSON event');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw this.protocolError('Pi event must be a JSON object');
      }
      const event = parsed as RawPiEvent;
      if (typeof event.type !== 'string' || event.type.length === 0) {
        throw this.protocolError('Pi event is missing a string type');
      }
      await this.handleEvent(event);
    }
  }

  /**
   * Translate one already-parsed Pi event.
   *
   * Public because the RPC transport demultiplexes stdout itself: responses and
   * extension UI requests are handled elsewhere, and only genuine agent events
   * reach the translator. Keeping the print-mode `consume()` on top of this
   * method means both transports share one translation, so an event cannot be
   * projected differently depending on how Pi was started.
   */
  async handleEvent(event: RawPiEvent): Promise<void> {
    await this.consumeEvent(event);
  }

  /**
   * Count a native tool call whose durable `tool_use` the caller emits itself.
   *
   * A gated call is published by the gate, not by `tool_execution_start`,
   * because the gate — not the raw execution frame — is what makes the call
   * approvable and what records the input a decision was made against. The
   * count still has to move so a summary cannot report fewer native calls than
   * the run produced.
   */
  noteNativeToolCall(): void {
    this.summary.nativeToolCount += 1;
  }

  /** Flushes cross-chunk text and closes any request left open at EOF. */
  finish(): PiTranslationSummary {
    const remaining = this.markup.flush();
    if (remaining) this.appendTransientText(remaining);
    this.endTransientMessage();
    if (this.currentThinking) this.appendThinking();
    if (this.requestStart) this.finishRequest(undefined, undefined);
    if (!this.summary.sawFinalAssistantMessage && this.currentTurnText) {
      this.appendFinalMessage(this.currentTurnText);
    }
    return { ...this.summary };
  }

  get result(): PiTranslationSummary {
    return { ...this.summary };
  }

  private async consumeEvent(event: RawPiEvent): Promise<void> {
    switch (event.type) {
      case 'session':
        if (event.id !== undefined && typeof event.id !== 'string') {
          throw this.protocolError('session.id must be a string when present');
        }
        this.summary.sawSessionHeader = true;
        return;
      case 'agent_start':
        return;
      case 'turn_start':
        this.endTransientMessage();
        this.beginRequest();
        this.currentTurnText = '';
        this.currentThinking = '';
        this.finalMessageText = '';
        this.summary.sawFinalAssistantMessage = false;
        this.summary.lastTurnError = undefined;
        return;
      case 'message_update':
        this.consumeMessageUpdate(event);
        return;
      case 'message_end':
        this.consumeMessageEnd(event);
        return;
      case 'tool_execution_start':
        this.consumeToolStart(event);
        return;
      case 'tool_execution_end':
        await this.consumeToolEnd(event);
        return;
      case 'turn_end':
        this.consumeTurnEnd(event);
        return;
      case 'error':
        this.summary.lastTurnError = extractString(event.message) || 'Pi reported an error';
        return;
      case 'auto_retry_end':
        if (typeof event.success !== 'boolean') throw this.protocolError('auto_retry_end.success must be boolean');
        if (!event.success) {
          this.summary.lastTurnError = extractString(event.finalError) || 'Pi exhausted automatic retries';
        }
        return;
      case 'agent_end':
        return;
      default:
        // Unknown events are deliberately inert. They never become a tool,
        // approval, or executable authority.
        return;
    }
  }

  private consumeMessageUpdate(event: RawPiEvent): void {
    const nested = event.assistantMessageEvent;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
      throw this.protocolError('message_update.assistantMessageEvent must be an object');
    }
    const update = nested as RawPiEvent;
    if (typeof update.type !== 'string') throw this.protocolError('assistantMessageEvent.type must be a string');
    if (update.type === 'text_delta') {
      if (typeof update.delta !== 'string') throw this.protocolError('text_delta.delta must be a string');
      const text = this.markup.push(update.delta);
      if (text) this.appendTransientText(text);
      return;
    }
    if (update.type === 'thinking_delta') {
      if (typeof update.delta !== 'string') throw this.protocolError('thinking_delta.delta must be a string');
      this.currentThinking += update.delta;
    }
  }

  private consumeMessageEnd(event: RawPiEvent): void {
    const message = objectValue(event.message, 'message_end.message');
    this.beginRequest();
    const text = extractText(message.content);
    if (text) this.appendFinalMessage(stripPiToolCallMarkup(text));
    const thinking = extractThinking(message.content);
    if (thinking) this.currentThinking += thinking;
    this.recordUsage(message.usage);
  }

  private consumeToolStart(event: RawPiEvent): void {
    this.beginRequest();
    const id = stringValue(event.toolCallId ?? event.tool_call_id);
    const name = stringValue(event.toolName ?? event.tool_name ?? event.name);
    if (!id || !name) throw this.protocolError('tool_execution_start requires toolCallId and toolName');
    const input = normalizeInput(event.args ?? event.input ?? event.arguments);
    this.appendDurable({
      type: name.startsWith('mcp_') ? 'agent.mcp_tool_use' : 'agent.tool_use',
      content: [{ type: 'tool_use', id, name, input }],
      modelUsed: this.options.model,
    });
    this.summary.nativeToolCount += 1;
  }

  private async consumeToolEnd(event: RawPiEvent): Promise<void> {
    const id = stringValue(event.toolCallId ?? event.tool_call_id);
    if (!id) throw this.protocolError('tool_execution_end requires toolCallId');
    const rawResult = event.result ?? event.output ?? event.content ?? '';
    // Same spill contract as the built-in strategy: one marker, one
    // retained-size accounting, and a path only when a file was written.
    const result = await this.options.spillToolOutput(extractResult(rawResult));
    const isError = event.isError === true || event.is_error === true;
    this.appendDurable({
      type: id.startsWith('mcp_') ? 'agent.mcp_tool_result' : 'agent.tool_result',
      content: [{ type: 'tool_result', tool_use_id: id, content: result, ...(isError ? { is_error: true } : {}) }],
      modelUsed: this.options.model,
    });
  }

  private consumeTurnEnd(event: RawPiEvent): void {
    const message = event.message === undefined ? undefined : objectValue(event.message, 'turn_end.message');
    if (message) {
      const text = extractText(message.content);
      if (text) this.appendFinalMessage(stripPiToolCallMarkup(text));
      const thinking = extractThinking(message.content);
      if (thinking) this.currentThinking += thinking;
      this.recordUsage(message.usage);
      const stopReason = stringValue(message.stopReason ?? message.stop_reason);
      if (stopReason === 'error') {
        this.summary.lastTurnError = stringValue(message.errorMessage ?? message.error_message)
          || this.summary.lastTurnError
          || 'Pi ended the turn with an error';
      }
      this.finishRequest(stopReason, stopReason === 'error' ? true : false);
    } else {
      this.finishRequest(undefined, undefined);
    }
    if (this.currentThinking) this.appendThinking();
    this.endTransientMessage();
  }

  private beginRequest(): void {
    if (this.requestStart) return;
    this.requestStartedAt = Date.now();
    this.requestUsageRecorded = false;
    this.requestStart = this.appendDurable({
      type: 'span.model_request_start',
      modelUsed: this.options.model,
    });
  }

  private finishRequest(stopReason: string | undefined, isError: boolean | undefined): void {
    if (!this.requestStart) return;
    this.appendDurable({
      type: 'span.model_request_end',
      modelUsed: this.options.model,
      tokensIn: this.requestInputTokens,
      tokensOut: this.requestOutputTokens,
      cacheReadTokens: this.requestCacheReadTokens,
      cacheWriteTokens: this.requestCacheWriteTokens,
      stopReason,
      durationMs: Math.max(0, Date.now() - this.requestStartedAt),
      parentEventId: this.requestStart.id,
      isError,
    });
    this.requestStart = undefined;
    this.requestInputTokens = 0;
    this.requestOutputTokens = 0;
    this.requestCacheReadTokens = 0;
    this.requestCacheWriteTokens = 0;
  }

  private requestInputTokens = 0;
  private requestOutputTokens = 0;
  private requestCacheReadTokens = 0;
  private requestCacheWriteTokens = 0;

  private recordUsage(raw: unknown): void {
    if (this.requestUsageRecorded || !raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const usage = raw as RawPiEvent;
    const input = numberValue(usage.input ?? usage.inputTokens ?? usage.input_tokens);
    const output = numberValue(usage.output ?? usage.outputTokens ?? usage.output_tokens);
    const cacheRead = numberValue(usage.cacheRead ?? usage.cache_read_input_tokens ?? usage.cache_read);
    const cacheWrite = numberValue(usage.cacheWrite ?? usage.cache_creation_input_tokens ?? usage.cache_write);
    this.requestInputTokens = input;
    this.requestOutputTokens = output;
    this.requestCacheReadTokens = cacheRead;
    this.requestCacheWriteTokens = cacheWrite;
    this.summary.inputTokens += input;
    this.summary.outputTokens += output;
    this.summary.requestCount += 1;
    this.options.recordUsage(this.options.sessionId, input, output, { read: cacheRead, write: cacheWrite });
    this.requestUsageRecorded = true;
  }

  private appendFinalMessage(text: string): void {
    const normalized = text.trim();
    if (!normalized || normalized === this.finalMessageText) return;
    this.finalMessageText = normalized;
    this.currentTurnText = normalized;
    this.summary.sawFinalAssistantMessage = true;
    this.appendDurable({
      type: 'agent.message',
      content: [{ type: 'text', text: normalized }],
      modelUsed: this.options.model,
    });
    this.endTransientMessage();
  }

  private appendThinking(): void {
    const thinking = stripPiToolCallMarkup(this.currentThinking).trim();
    this.currentThinking = '';
    if (!thinking) return;
    this.appendDurable({
      type: 'agent.thinking',
      content: [{ type: 'text', text: thinking }],
      modelUsed: this.options.model,
    });
  }

  private appendTransientText(text: string): void {
    if (!this.transientOpen) {
      this.transientMessageId = `pi_msg_${this.options.sessionId}_${this.lineNumber}`;
      this.transientOpen = true;
      this.broadcastTransient('agent.message_stream_start', { message_id: this.transientMessageId });
    }
    this.currentTurnText += text;
    this.broadcastTransient('agent.message_chunk', {
      message_id: this.transientMessageId,
      delta: text,
    });
  }

  private endTransientMessage(): void {
    if (!this.transientOpen) return;
    this.broadcastTransient('agent.message_stream_end', { message_id: this.transientMessageId });
    this.transientMessageId = '';
    this.transientOpen = false;
  }

  private appendDurable(event: DurableEvent): SessionEvent {
    const persisted = this.options.eventLog.append(this.options.sessionId, event);
    this.options.broadcast(persisted);
    return persisted;
  }

  private broadcastTransient(type: 'agent.message_stream_start' | 'agent.message_chunk' | 'agent.message_stream_end', fields: Record<string, unknown>): void {
    const event = {
      id: `pi_transient_${this.options.sessionId}_${this.lineNumber}_${type}`,
      sessionId: this.options.sessionId,
      seq: 0,
      type,
      ...fields,
      createdAt: new Date(),
    } as unknown as SessionEvent;
    this.options.broadcast(event);
  }

  private protocolError(message: string): PiProtocolError {
    return new PiProtocolError(`Pi stdout line ${this.lineNumber}: ${message}`);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function objectValue(value: unknown, label: string): RawPiEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PiProtocolError(`${label} must be an object`);
  }
  return value as RawPiEvent;
}

function normalizeInput(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'string') {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new PiProtocolError('tool arguments are not valid JSON'); }
    return normalizeInput(parsed);
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new PiProtocolError('tool arguments must be a JSON object');
  return value as Record<string, unknown>;
}

function extractString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as RawPiEvent;
    return stringValue(record.message ?? record.error ?? record.text) ?? JSON.stringify(value);
  }
  return value === undefined || value === null ? '' : String(value);
}

function extractResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as RawPiEvent;
    if (typeof record.content === 'string') return record.content;
    if (Array.isArray(record.content)) return extractText(record.content) || JSON.stringify(record.content);
  }
  return value === undefined || value === null ? '' : JSON.stringify(value);
}


function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.flatMap((block) => {
    if (!block || typeof block !== 'object') return [];
    const record = block as RawPiEvent;
    if (record.type === 'text' || record.type === 'output_text') {
      return typeof record.text === 'string' ? [record.text] : [];
    }
    return [];
  }).join('');
}

function extractThinking(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.flatMap((block) => {
    if (!block || typeof block !== 'object') return [];
    const record = block as RawPiEvent;
    if (record.type === 'thinking' || record.type === 'reasoning') {
      return typeof record.text === 'string' ? [record.text] : [];
    }
    return [];
  }).join('');
}
