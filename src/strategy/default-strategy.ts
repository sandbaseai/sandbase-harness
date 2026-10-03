/**
 * Default Strategy
 *
 * Engine loop implementation using Vercel AI SDK `streamText` + `maxSteps`.
 * Handles the full tool-call loop automatically.
 *
 * Lifecycle hooks (invoked from inside execute()):
 * - beforeTurn: once before the loop starts
 * - afterStep: after each onStepFinish
 * - onError: on error, decides retry/abort
 * - onComplete: once after loop exits normally
 * - onCompact: stub (Context Compactor is deferred)
 *
 * Reference: OMA default-loop.ts
 */

import { nanoid } from 'nanoid';
import { jsonSchema, stepCountIs, streamText } from 'ai';
import { createAiSdkExecutionLock, type JsonSchemaLike } from 'prefix-safe-json';
import type { LanguageModel } from 'ai';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import type { SessionEvent } from '@/types/session.js';
import type { ContentBlock } from '@/types/cma-protocol.js';
import { resolveMcpServerName } from '@/core/mcp/mcp-manager.js';
import { MODEL_AUTH_FAILED_CODE, MODEL_NOT_FOUND_CODE } from '@/model/errors.js';
import { resolvedModelIdOf } from '@/model/registry.js';
import { createAiSdkV4ExecutionGuard } from './ai-sdk-v4-execution-guard.js';

/**
 * Local tool-result ceiling, re-exported from the overflow contract.
 *
 * Kept as a named export because existing callers and tests read it from this
 * module; the value itself has one definition.
 */
export { LOCAL_TOOL_RESULT_MAX_CHARS as MAX_TOOL_RESULT_CHARS } from '@/core/session/tool-output-overflow.js';
import { spillToolOutput } from '@/core/session/tool-output-overflow.js';

/**
 * Turn a model/provider error into a diagnostic message. AI SDK errors
 * (APICallError and friends) carry the useful detail — HTTP status, request
 * URL, response body, and the underlying network cause (e.g. ECONNRESET) — in
 * fields other than `message`, which is often empty. Collapsing to
 * `error.message` or `String(error)` loses all of that and produces a blank or
 * `[object Object]` session.error. This extracts the informative parts so an
 * operator can see why a turn failed.
 *
 * A status the runtime can name also becomes an error code, so a wrong model id
 * and a rejected credential stop being indistinguishable from a crashed
 * runtime in `session.error.type`.
 */
export function describeModelError(error: unknown): Error {
  const described = buildModelError(error);
  const code = providerErrorCode(error) ?? errorCodeOf(described);
  if (!code || errorCodeOf(described) === code) return described;
  // A provider error object is often thrown from more than one place (the SDK
  // re-throws it through the stream), so the code is attached to a copy rather
  // than written onto the value the caller still holds.
  const coded = new Error(described.message);
  coded.name = described.name;
  coded.stack = described.stack;
  return Object.assign(coded, { code });
}

function buildModelError(error: unknown): Error {
  if (error instanceof Error && !isEmptyErrorMessage(error)) {
    const detail = modelErrorDetail(error);
    if (detail) {
      const enriched = new Error(`${error.message} (${detail})`);
      enriched.stack = error.stack;
      return enriched;
    }
    return error;
  }

  const parts: string[] = [];
  const record = (error ?? {}) as Record<string, unknown>;
  const status = record.statusCode ?? record.status;
  if (typeof status === 'number') parts.push(`HTTP ${status}`);
  if (typeof record.url === 'string' && record.url) parts.push(`url=${redactSecrets(record.url)}`);
  const cause = record.cause as Record<string, unknown> | undefined;
  const causeCode = cause && typeof cause.code === 'string' ? cause.code : undefined;
  if (causeCode) parts.push(causeCode);
  const body = record.responseBody ?? record.data;
  if (typeof body === 'string' && body.trim()) parts.push(truncateDetail(redactSecrets(body.trim())));

  const base = error instanceof Error && error.message ? error.message
    : typeof record.name === 'string' ? record.name
      : 'model request failed';
  const message = parts.length > 0 ? `${base}: ${parts.join(' ')}` : base;
  const result = new Error(message);
  if (error instanceof Error) result.stack = error.stack;
  return result;
}

function errorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

/**
 * The model code a provider response status implies, if any.
 *
 * Only a structured status is read. A status guessed out of an error message
 * would classify a body that merely mentions "404" as a missing model, and a
 * mis-classified failure is worse than an unclassified one.
 */
function providerErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  const status = typeof record.statusCode === 'number' ? record.statusCode
    : typeof record.status === 'number' ? record.status
      : undefined;
  if (status === 404) return MODEL_NOT_FOUND_CODE;
  if (status === 401 || status === 403) return MODEL_AUTH_FAILED_CODE;
  return undefined;
}

function isEmptyErrorMessage(error: Error): boolean {
  const message = error.message?.trim() ?? '';
  return message === '' || message === '{}' || message === '[object Object]';
}

function modelErrorDetail(error: Error): string | undefined {
  const record = error as unknown as Record<string, unknown>;
  const parts: string[] = [];
  const status = record.statusCode ?? record.status;
  if (typeof status === 'number') parts.push(`HTTP ${status}`);
  const cause = record.cause as Record<string, unknown> | undefined;
  if (cause && typeof cause.code === 'string') parts.push(cause.code);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function truncateDetail(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

/**
 * Mask credential material before it is written into a persisted, UI-visible
 * session.error. Covers secret-bearing URL query params (?key=/api_key=/token=/
 * access_token=/password=/secret=), bearer tokens, and common provider key
 * prefixes (sk-, sk-ant-). Best-effort defense so a gateway that authenticates
 * via query string or echoes a key in its error body does not leak it.
 */
function redactSecrets(value: string): string {
  return value
    .replace(/([?&](?:api[-_]?key|access[-_]?token|auth|token|key|secret|password|pwd|sig|signature)=)[^&\s]+/gi, '$1***')
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1***')
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9._-]{8,}/g, 'sk-***');
}

/**
 * Build a transient (non-persisted) SessionEvent for live SSE streaming.
 * seq = 0 marks it transient so the SSE route does not treat it as a resume
 * cursor and does not dedup it against persisted events.
 */
function transientEvent(
  sessionId: string,
  type: SessionEvent['type'],
  extra: Record<string, unknown>,
): SessionEvent {
  return {
    id: `stream_${Math.random().toString(36).slice(2, 10)}`,
    sessionId,
    seq: 0,
    type,
    createdAt: new Date(),
    ...extra,
  } as SessionEvent;
}

export class DefaultStrategy implements AgentStrategy {
  readonly name = 'default';
  readonly requiresModel = true;

  async *execute(context: StrategyContext): AsyncIterable<SessionEvent> {
    const { session, systemPrompt, messages, model, modelConfig, tools, customToolNames, sandbox: _sandbox, eventLog, broadcast, config, abortSignal } = context;
    if (!model) throw new Error('Default strategy requires an AI SDK model');
    const maxSteps = config.maxSteps ?? 25;

    // beforeTurn hook
    if (config.beforeTurn) {
      await config.beforeTurn(context);
    }

    let totalSteps = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    const confirmTools = new Set(config.confirmTools ?? []);
    const customTools = new Set(customToolNames ?? []);
    const confirmableToolCallIds = new Set<string>();
    const customToolCallIds = new Set<string>();
    const pendingConfirmationCalls: Array<{
      toolCallId: string;
      toolName: string;
      tokensIn: number;
      tokensOut: number;
      confirmationGroupId: string;
    }> = [];
    const pendingCustomToolCalls: Array<{
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      tokensIn: number;
      tokensOut: number;
      stopReason?: string;
    }> = [];
    // The id recorded against every event this turn produces. Resolution order
    // is by how directly each source knows the request: the registry recorded
    // the id the client was built with, a caller-supplied configuration is the
    // same answer for a strategy that never built a client, and the SDK's own
    // `modelId` is the fallback for a model the registry did not construct.
    // What must never be recorded is the agent's raw reference: for a
    // gateway-style `vendor/model` id it is not what the endpoint was asked
    // for, so usage and cost would be attributed to a model that does not exist.
    const modelUsed = resolvedModelIdOf(model) ?? modelConfig?.model ?? modelIdentifier(model, '');
    const startTime = Date.now();
    // Declared MCP server names, used to attribute `agent.mcp_*` events back to
    // the server that produced them when several servers expose the same tool.
    const mcpServerNames = (session.agentDefinition?.mcp_servers ?? []).map((server) => server.name);

    try {
      // Build Vercel AI SDK tool definitions from our CoreTool map
      const confirmationToolDefinitions = Object.fromEntries(
        Object.entries(tools).filter(([name]) => confirmTools.has(name)),
      );
      const customToolDefinitions = Object.fromEntries(
        Object.entries(tools).filter(([name]) => customTools.has(name)),
      );
      const lockedConfirmationTools = createAiSdkExecutionLock(confirmationToolDefinitions);
      const lockedCustomTools = createAiSdkExecutionLock(customToolDefinitions);
      const aiTools: Record<string, any> = {};
      for (const [name, tool] of Object.entries(tools)) {
        aiTools[name] = toAiTool(lockedConfirmationTools[name] ?? lockedCustomTools[name] ?? tool);
      }
      const guard = createAiSdkV4ExecutionGuard({
        schemas: Object.fromEntries(
          Object.entries({ ...confirmationToolDefinitions, ...customToolDefinitions })
            .filter(([, tool]) => tool?.parameters && typeof tool.parameters === 'object')
            .map(([name, tool]) => [name, tool.parameters as JsonSchemaLike]),
        ),
      });

      // Convert our messages to Vercel AI SDK format
      const aiMessages = messages.map((m) => ({
        role: m.role as 'user' | 'assistant' | 'tool' | 'system',
        content: m.content as any,
      }));

      const result = streamText({
        model: model as LanguageModel,
        // The registry's middleware owns every retry: the SDK's own step-level
        // retry would re-enter it silently, multiplying requests and hiding
        // the rescheduling the session is supposed to publish.
        maxRetries: 0,
        system: systemPrompt || undefined,
        messages: aiMessages,
        tools: Object.keys(aiTools).length > 0 ? aiTools : undefined,
        stopWhen: [
          stepCountIs(maxSteps),
          // Spend is committed per step in onStepFinish below, so by the time
          // the SDK asks stopWhen the ceiling check reads that step's cost.
          // Stopping here is what makes "the request that crossed the budget
          // is the last one" true; without it a turn only discovers the cap
          // when the next event is refused.
          () => config.budgetExhausted?.() ?? false,
          // A custom tool call has no local executor, so the turn stops rather
          // than asking the SDK to run a tool that cannot produce a result.
          ...(customTools.size > 0
            ? [({ steps }: { steps: Array<{ toolCalls?: Array<{ toolName: string }> }> }) =>
              steps.at(-1)?.toolCalls?.some((call) => customTools.has(call.toolName)) ?? false]
            : []),
        ],
        temperature: config.temperature,
        maxOutputTokens: config.maxTokens,
        abortSignal,
        onStepFinish: async (step) => {
          totalSteps++;

          const tokensIn = step.usage?.inputTokens ?? 0;
          const tokensOut = step.usage?.outputTokens ?? 0;
          const stopReason = modelStopReason(step.finishReason);
          totalTokensIn += tokensIn;
          totalTokensOut += tokensOut;

          // Emit a span for this model request's token usage (A3 observability).
          const spanEvent = eventLog.append(session.id, {
            type: 'span.model_request_end',
            tokensIn,
            tokensOut,
            modelUsed,
            stopReason,
            durationMs: Date.now() - startTime,
          });
          broadcast(spanEvent);
          // Persist the aggregate once per model request. The same usage is
          // intentionally copied to projected message/tool events for local
          // attribution, so metrics must not sum those projections.
          eventLog.recordUsage(session.id, tokensIn, tokensOut);

          // Emit agent.thinking as a progress signal only. CMA defines this
          // event as "thinking started/stopped" and explicitly not as a carrier
          // for reasoning content, so the raw `step.reasoningText` is
          // deliberately not persisted here: the public event log is readable
          // over the API and reasoning traces routinely echo tool output.
          const reasoning = step.reasoningText;
          if (reasoning && reasoning.trim()) {
            const thinkingEvent = eventLog.append(session.id, {
              type: 'agent.thinking',
              modelUsed,
              stopReason,
              metadata: { signal: 'reasoning' },
            });
            broadcast(thinkingEvent);
            // The canonical preview for `agent.thinking` is `event_start` only:
            // the buffered event carries no reasoning text, so a delta would
            // have to invent content. The carrier is keyed to the persisted
            // event's id so a projector can reconcile the two.
            broadcast(transientEvent(session.id, 'agent.thinking_stream_start', {
              message_id: thinkingEvent.id,
              signal: 'reasoning',
            }));
          }

          // Emit agent.message for this step's text (OMA pattern: per-step, not end-of-loop)
          if (step.text && step.text.trim()) {
            const agentMsgEvent = eventLog.append(session.id, {
              type: 'agent.message',
              content: [{ type: 'text', text: step.text }] as ContentBlock[],
              tokensIn,
              tokensOut,
              modelUsed,
              stopReason,
              durationMs: Date.now() - startTime,
            });
            broadcast(agentMsgEvent);
          }

          // Emit events for tool calls (MCP tools get the mcp_* event type)
          if (step.toolCalls && step.toolCalls.length > 0) {
            const resultIds = new Set((step.toolResults ?? []).map((result) => result.toolCallId));
            let confirmationGroupId: string | undefined;
            for (const toolCall of step.toolCalls) {
              // A custom tool call is never executed here. It is collected and
              // persisted after the raw call passes the execution guard, so a
              // malformed call never reaches the event log.
              const isCustom = customTools.has(toolCall.toolName);
              if (isCustom) {
                if (!resultIds.has(toolCall.toolCallId)) {
                  pendingCustomToolCalls.push({
                    toolCallId: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                    input: toolCall.input as Record<string, unknown>,
                    tokensIn,
                    tokensOut,
                    stopReason,
                  });
                }
                continue;
              }
              const awaitsConfirmation = confirmTools.has(toolCall.toolName) && !resultIds.has(toolCall.toolCallId);
              if (awaitsConfirmation) {
                confirmationGroupId ??= `confirm_${nanoid(16)}`;
                pendingConfirmationCalls.push({
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  tokensIn,
                  tokensOut,
                  confirmationGroupId,
                });
                continue;
              }

              const isMcp = toolCall.toolName.startsWith('mcp_');
              const mcpServerName = isMcp ? resolveMcpServerName(toolCall.toolName, mcpServerNames) : undefined;
              const toolUseEvent = eventLog.append(session.id, {
                type: isMcp ? 'agent.mcp_tool_use' : 'agent.tool_use',
                content: [{
                  type: 'tool_use',
                  id: toolCall.toolCallId,
                  name: toolCall.toolName,
                  input: toolCall.input as Record<string, unknown>,
                }] as ContentBlock[],
                tokensIn,
                tokensOut,
                modelUsed,
                stopReason,
                ...(mcpServerName ? { metadata: { mcp_server_name: mcpServerName } } : {}),
              });
              broadcast(toolUseEvent);
            }
          }

          // Emit events for tool results (MCP tools get the mcp_* event type)
          if (step.toolResults && step.toolResults.length > 0) {
            for (const toolResult of step.toolResults) {
              const isMcp = toolResult.toolName?.startsWith('mcp_') ?? false;
              const mcpServerName = isMcp
                ? resolveMcpServerName(toolResult.toolName ?? '', mcpServerNames)
                : undefined;
              const raw = typeof toolResult.output === 'string'
                ? toolResult.output
                : JSON.stringify(toolResult.output);
              // Oversize results go through the shared overflow contract: the
              // full text is written into the sandbox and the model keeps a
              // short preview plus the path it can read back from. Slicing
              // inline here is what the contract forbids — one spill format, in
              // one module, for every tool.
              const overflow = await spillToolOutput(raw, { sessionId: session.id, sandbox: context.sandbox });
              const toolResultEvent = eventLog.append(session.id, {
                type: isMcp ? 'agent.mcp_tool_result' : 'agent.tool_result',
                content: [{
                  type: 'tool_result',
                  tool_use_id: toolResult.toolCallId,
                  content: overflow.preview,
                }] as ContentBlock[],
                modelUsed,
                stopReason,
                // The path is recorded only when a file was actually written, so
                // a sandbox that could not be written never hands the model a
                // path that does not exist.
                ...(overflow.file
                  ? { metadata: {
                    ...(mcpServerName ? { mcp_server_name: mcpServerName } : {}),
                    tool_output_overflow: overflow.file,
                  } }
                  : mcpServerName ? { metadata: { mcp_server_name: mcpServerName } } : {}),
              });
              broadcast(toolResultEvent);
            }
          }

          // afterStep hook
          if (config.afterStep) {
            await config.afterStep({
              stepIndex: totalSteps,
              type: step.toolCalls?.length ? 'tool_call' : 'text',
              toolName: step.toolCalls?.[0]?.toolName,
              tokensIn,
              tokensOut,
              durationMs: Date.now() - startTime,
            });
          }
        },
      });

      // Consume the full stream: broadcast token-level chunk events for live
      // rendering (transient — not persisted; the canonical agent.message is
      // committed per-step in onStepFinish above). Draining also drives the
      // onStepFinish callbacks to completion.
      let streaming = false;
      let messageId = '';
      let streamError: unknown;
      for await (const part of result.fullStream) {
        guard.push(part);
        if (part.type === 'text-delta') {
          if (!streaming) {
            streaming = true;
            messageId = `msg_${Date.now()}_${totalSteps}`;
            broadcast(transientEvent(session.id, 'agent.message_stream_start', { message_id: messageId }));
          }
          broadcast(
            transientEvent(session.id, 'agent.message_chunk', {
              message_id: messageId,
              delta: part.text,
            }),
          );
        } else if (part.type === 'finish-step' || part.type === 'finish') {
          if (streaming) {
            broadcast(transientEvent(session.id, 'agent.message_stream_end', { message_id: messageId }));
            streaming = false;
          }
        } else if (part.type === 'error') {
          // AI SDK v4 surfaces model/provider errors as an `error` stream part
          // rather than always throwing. Capture it so the turn fails properly
          // instead of silently going idle with no output.
          streamError = (part as { error?: unknown }).error ?? new Error('model stream error');
        }
      }
      if (streaming) {
        broadcast(transientEvent(session.id, 'agent.message_stream_end', { message_id: messageId }));
      }
      if (streamError) {
        // Preserve the provider's diagnostic detail (status/url/cause/body)
        // instead of collapsing to an empty message.
        throw describeModelError(streamError);
      }

      const guarded = guard.finish();
      for (const pendingCall of pendingCustomToolCalls) {
        const matches = guarded.decisions.filter(
          (decision) => decision.toolCallId === pendingCall.toolCallId && decision.name === pendingCall.toolName,
        );
        if (matches.length !== 1) continue;

        const authority = guard.takeDecision(matches[0].internalId);
        if (!authority || !authority.value || typeof authority.value !== 'object' || Array.isArray(authority.value)) continue;

        customToolCallIds.add(pendingCall.toolCallId);
        const customUseEvent = eventLog.append(session.id, {
          type: 'agent.custom_tool_use',
          content: [{
            type: 'tool_use',
            id: pendingCall.toolCallId,
            name: pendingCall.toolName,
            input: authority.value as Record<string, unknown>,
          }] as ContentBlock[],
          tokensIn: pendingCall.tokensIn,
          tokensOut: pendingCall.tokensOut,
          modelUsed,
          stopReason: pendingCall.stopReason,
          metadata: { custom_tool: true },
        });
        broadcast(customUseEvent);
      }

      for (const pendingCall of pendingConfirmationCalls) {
        const matches = guarded.decisions.filter(
          (decision) => decision.toolCallId === pendingCall.toolCallId && decision.name === pendingCall.toolName,
        );
        if (matches.length !== 1) continue;

        const authority = guard.takeDecision(matches[0].internalId);
        if (!authority) continue;

        confirmableToolCallIds.add(pendingCall.toolCallId);
        const isMcp = pendingCall.toolName.startsWith('mcp_');
        const toolUseEvent = eventLog.append(session.id, {
          type: isMcp ? 'agent.mcp_tool_use' : 'agent.tool_use',
          content: [{
            type: 'tool_use',
            id: pendingCall.toolCallId,
            name: pendingCall.toolName,
            input: authority.value as Record<string, unknown>,
            // The Console renders the approval card only when the tool_use
            // block (or event metadata) carries this flag. Without it the
            // session sits in requires_action with no actionable UI.
            requires_confirmation: true,
            confirmation_group_id: pendingCall.confirmationGroupId,
          }] as ContentBlock[],
          tokensIn: pendingCall.tokensIn,
          tokensOut: pendingCall.tokensOut,
          modelUsed,
          stopReason: 'tool_confirmation',
          metadata: { confirmation_group_id: pendingCall.confirmationGroupId },
        });
        broadcast(toolUseEvent);
      }

      // Detect tool calls that were emitted but have no result — these are
      // confirm-required tools (built without execute), so the SDK stopped on
      // them. Signal that the session needs user confirmation (requires_action).
      const toolCalls = await result.toolCalls;
      const toolResults = await result.toolResults;
      const resolvedIds = new Set((toolResults ?? []).map((r: any) => r.toolCallId));
      const pending = (toolCalls ?? []).filter((c: any) => !resolvedIds.has(c.toolCallId));
      const pendingConfirm = pending.filter(
        (c: any) => confirmTools.has(c.toolName) && confirmableToolCallIds.has(c.toolCallId),
      );
      // A persisted custom tool call is also parked work: the runtime is waiting
      // for the caller's result, so the session is actionable in the same way an
      // approval is.
      const pendingCustom = pending.filter(
        (c: any) => customTools.has(c.toolName) && customToolCallIds.has(c.toolCallId),
      );

      if ((pendingConfirm.length > 0 || pendingCustom.length > 0) && config.onRequiresAction) {
        config.onRequiresAction();
      }

      // onComplete hook
      if (config.onComplete) {
        await config.onComplete({
          totalSteps,
          totalTokensIn,
          totalTokensOut,
          stopReason: pendingConfirm.length > 0 ? 'tool_confirmation' : 'end_turn',
          durationMs: Date.now() - startTime,
        });
      }
    } catch (error) {
      // Enrich provider errors with diagnostic detail before they propagate,
      // so the persisted session.error is informative rather than blank.
      const described = describeModelError(error);
      // onError hook
      if (config.onError) {
        await config.onError(described);
      }
      throw described;
    }
  }
}

/**
 * Translate this codebase's `parameters` convention to the SDK's `inputSchema`.
 * A tool left on `parameters` is not rejected — it reaches the model with an
 * empty argument schema — so this conversion cannot be skipped.
 */
function modelIdentifier(model: LanguageModel, configuredModel: string): string {
  const modelId = (model as unknown as { modelId?: unknown }).modelId;
  return typeof modelId === 'string' && modelId.length > 0
    ? modelId
    : configuredModel;
}

function modelStopReason(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.unified === 'string' && record.unified.length > 0) return record.unified;
    if (typeof record.raw === 'string' && record.raw.length > 0) return record.raw;
  }
  return undefined;
}

function toAiTool(tool: any): any {
  if (!tool || typeof tool !== 'object') return tool;
  if (tool.inputSchema) return tool;
  if (!tool.parameters || typeof tool.parameters !== 'object') return tool;

  const { parameters, ...rest } = tool;
  return {
    ...rest,
    inputSchema: isAiSdkSchema(parameters) ? parameters : jsonSchema(parameters),
  };
}

function isAiSdkSchema(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    ('jsonSchema' in value || '_def' in value),
  );
}
