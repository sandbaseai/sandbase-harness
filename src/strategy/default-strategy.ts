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
import type { LanguageModel, ModelMessage } from 'ai';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import type { AutoPermissionCall, AutoPermissionVerdict } from '@/types/strategy.js';
import type { PermissionPolicyType } from '@/types/agent.js';
import type { SessionEvent } from '@/types/session.js';
import type { ContentBlock } from '@/types/cma-protocol.js';
import { resolveMcpServerName } from '@/core/mcp/mcp-manager.js';
import { runtimeToolPermission } from '@/core/agent/standard.js';
import {
  AUTO_PERMISSION_REASON_INDETERMINATE,
  createAutoPermissionEvaluator,
} from '@/core/session/auto-permission.js';
import { toolError, toolErrorText } from '@/core/tool-result-error.js';
import { MODEL_AUTH_FAILED_CODE, MODEL_NOT_FOUND_CODE } from '@/model/errors.js';
import { resolvedModelIdOf } from '@/model/registry.js';
import { anthropicCallOptions } from '@/model/anthropic-options.js';
import type { ModelEffortLevel } from '@/core/agent/model-object.js';
import { applyAnthropicCacheBreakpoints } from '@/strategy/anthropic-cache-breakpoints.js';
import {
  estimateModelMessagesTokens,
  trimInFlightToolResults,
} from '@/strategy/in-loop-context.js';
import { splitModelRequestUsage } from './model-usage.js';
import { createAiSdkV4ExecutionGuard } from './ai-sdk-v4-execution-guard.js';
import type { CustomToolCallSubmitter } from '@/sandbox/self-hosted-provider.js';

/**
 * Local tool-result ceiling, re-exported from the overflow contract.
 *
 * Kept as a named export because existing callers and tests read it from this
 * module; the value itself has one definition.
 */
export { DEFAULT_TOOL_RESULT_MAX_CHARS as MAX_TOOL_RESULT_CHARS } from '@/core/session/tool-output-overflow.js';
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
  if (typeof record.url === 'string' && record.url) parts.push(`url=${redactSecrets(record.url)}`);
  const body = record.responseBody ?? record.data;
  if (typeof body === 'string' && body.trim()) parts.push(truncateDetail(redactSecrets(body.trim())));
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
    // Calls whose `execute` returned a ToolResultError marker. The wrapper in
    // `toAiTool` unwraps the marker back to its message so the model-visible
    // text is unchanged; the id recorded here flags the emitted tool_result.
    const failedToolResultCallIds = new Set<string>();
    // SDK `tool-error` stream parts keyed by call id. Neither `step.toolCalls`
    // nor `step.toolResults` retains the real error for a call that threw or
    // failed input validation, so the paired error result below reads it here.
    const toolStreamErrors = new Map<string, unknown>();
    const pendingConfirmationCalls: Array<{
      toolCallId: string;
      toolName: string;
      tokensIn: number;
      tokensOut: number;
      confirmationGroupId: string;
      permissionMeta?: Record<string, unknown>;
    }> = [];
    const pendingCustomToolCalls: Array<{
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      tokensIn: number;
      tokensOut: number;
      stopReason?: string;
    }> = [];
    // Calls governed by `permission_policy: {type: "auto"}` are judged per
    // invocation before they may execute. The SDK's `needsApproval` hook is
    // the gate: `allow` runs, `deny` is answered by the wrapped `execute` with
    // a synthetic error result, and `ask` leaves the call unexecuted so the
    // turn parks on the same confirmation path `always_ask` uses. The map
    // records each verdict so the emitted `agent.tool_use` can publish it and
    // the deny path can refuse without ever running the tool.
    const autoTools = new Set(config.autoTools ?? []);
    const autoVerdicts = new Map<string, AutoPermissionVerdict>();
    const evaluateAutoCall = autoTools.size > 0
      ? async (call: AutoPermissionCall): Promise<AutoPermissionVerdict> => {
          try {
            if (config.evaluateToolPermission) {
              return await config.evaluateToolPermission(call);
            }
            const evaluation = await createAutoPermissionEvaluator(model)(call);
            // The judge's request is a model request too, so it records the
            // same canonical pair a turn-end span does: the event for the
            // request plus the session-aggregate update.
            const usageEvent = eventLog.recordAuxiliaryModelUsage(session.id, evaluation.usage, {
              purpose: 'auto_permission',
              modelUsed,
            });
            broadcast(usageEvent);
            return evaluation.verdict;
          } catch {
            // A judge that cannot answer fails closed to the approval gate.
            return { type: 'ask', reasonCode: AUTO_PERMISSION_REASON_INDETERMINATE };
          }
        }
      : undefined;
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
    // The `span.model_request_start` for the step currently in flight. One
    // `prepareStep`→`onStepFinish` cycle is one model request: the registry's
    // retry middleware lives below the SDK step, so a retried request keeps a
    // single pair instead of gaining a span per HTTP attempt. A failed request
    // reaches `onError` with this id still set and closes `is_error: true`.
    let inFlightRequestStart: SessionEvent | undefined;
    // Agent-level `model.effort`/`model.speed` land on the request here, gated
    // by the capability table so an option is only sent to a model that takes
    // it — unknown ids get nothing rather than a request the provider rejects.
    // `requestSpeed` doubles as the `model_usage.speed` the paired end span
    // publishes: it is the tier the request ran under, not merely the one
    // configured.
    const anthropicOptions = typeof model === 'object' && model.provider === 'anthropic.messages'
      ? anthropicCallOptions({
          modelId: modelUsed,
          effort: config.modelOptions?.effort as ModelEffortLevel | undefined,
          speed: config.modelOptions?.speed,
        })
      : undefined;
    const requestSpeed = anthropicOptions?.anthropic.speed;
    // Durable `agent.message` ids are minted per step in `prepareStep` —
    // before the step's request is issued, so before any of its deltas can
    // reach the consumer loop. Both the preview carrier broadcasts (which run
    // when the consumer pulls `text-delta` parts) and the buffered append in
    // `onStepFinish` (which runs stream-transform-side, possibly ahead of the
    // consumer) read the same slot: the index is the step number on both
    // sides, so no cross-side ordering is required.
    const mintedMessageIds: string[] = [];
    // The SDK runs `onStepFinish` stream-transform-side, after the consumer
    // has pulled the step's `finish-step` part — so by the time the buffered
    // `agent.message` is broadcast, every `event_deltas[]` preview for it has
    // already reached subscribers, and durable events go out in append order.
    // Delaying them would invert seq order on the wire (a later step's
    // `span.model_request_start` would overtake the queue) and cursor-following
    // consumers drop out-of-order frames, so they are broadcast directly.
    const closeRequestSpan = (isError: boolean): void => {
      // Clear before appending: a failed append must not invite a second end.
      const start = inFlightRequestStart;
      inFlightRequestStart = undefined;
      if (!start) return;
      const spanEvent = eventLog.append(session.id, {
        type: 'span.model_request_end',
        modelUsed,
        parentEventId: start.id,
        isError,
        durationMs: Date.now() - startTime,
        ...(requestSpeed ? { speed: requestSpeed } : {}),
      });
      broadcast(spanEvent);
    };

    try {
      // Build Vercel AI SDK tool definitions from our CoreTool map
      const confirmationToolDefinitions = Object.fromEntries(
        Object.entries(tools).filter(([name]) => confirmTools.has(name)),
      );
      const customToolDefinitions = Object.fromEntries(
        Object.entries(tools).filter(([name]) => customTools.has(name)),
      );
      const autoToolDefinitions = Object.fromEntries(
        Object.entries(tools).filter(([name]) => autoTools.has(name)),
      );
      const lockedConfirmationTools = createAiSdkExecutionLock(confirmationToolDefinitions);
      const lockedCustomTools = createAiSdkExecutionLock(customToolDefinitions);
      const aiTools: Record<string, any> = {};
      for (const [name, tool] of Object.entries(tools)) {
        const base = lockedConfirmationTools[name] ?? lockedCustomTools[name]
          ?? (autoTools.has(name) && evaluateAutoCall
            ? autoPermissionTool(tool, name, evaluateAutoCall, autoVerdicts)
            : tool);
        aiTools[name] = toAiTool(base, failedToolResultCallIds);
      }
      const guard = createAiSdkV4ExecutionGuard({
        schemas: Object.fromEntries(
          Object.entries({ ...confirmationToolDefinitions, ...customToolDefinitions, ...autoToolDefinitions })
            .filter(([, tool]) => tool?.parameters && typeof tool.parameters === 'object')
            .map(([name, tool]) => [name, tool.parameters as JsonSchemaLike]),
        ),
      });

      // Convert our messages to Vercel AI SDK format
      const aiMessages = messages.map((m) => ({
        role: m.role as 'user' | 'assistant' | 'tool' | 'system',
        content: m.content as any,
      }));

      // Anthropic requests carry the fixed prompt-cache breakpoints (system
      // prompt, last tool, second-to-last message); every other provider sees
      // the unchanged shape — `model.provider` survives the retry-middleware
      // wrap, so it stays the routing fact rather than a config echo. The
      // `model` union admits a bare string id, which carries no provider.
      const cacheShape = typeof model === 'object' && model.provider === 'anthropic.messages'
        ? applyAnthropicCacheBreakpoints({
            systemPrompt: systemPrompt || undefined,
            messages: aiMessages,
            tools: Object.keys(aiTools).length > 0 ? aiTools : undefined,
          })
        : undefined;

      const result = streamText({
        model: model as LanguageModel,
        // The registry's middleware owns every retry: the SDK's own step-level
        // retry would re-enter it silently, multiplying requests and hiding
        // the rescheduling the session is supposed to publish.
        maxRetries: 0,
        system: cacheShape ? cacheShape.system : systemPrompt || undefined,
        messages: cacheShape ? cacheShape.messages : aiMessages,
        tools: cacheShape ? cacheShape.tools : (Object.keys(aiTools).length > 0 ? aiTools : undefined),
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
        providerOptions: anthropicOptions,
        abortSignal,
        // The span opens when the SDK prepares the step's request, not when the
        // answer lands, so a request that never completes still has a start to
        // pair with — `onError` below closes it `is_error: true`.
        prepareStep: (options: { messages: ModelMessage[] }) => {
          // A start left over at this point means the previous step errored
          // without tripping `onError`; close it rather than leaking a start
          // with no end.
          closeRequestSpan(true);
          inFlightRequestStart = eventLog.append(session.id, {
            type: 'span.model_request_start',
            modelUsed,
          });
          broadcast(inFlightRequestStart);
          mintedMessageIds.push(`sevt_${nanoid(16)}`);

          // The turn-level compactor only runs before a turn starts. A long
          // tool loop can assemble a request over the provider's window
          // before the next turn's check ever runs — when the outgoing
          // estimate crosses the trigger (the same 80% the compactor uses),
          // replace stale tool outputs with a placeholder so the request
          // still fits. The event log keeps the untrimmed payloads; only the
          // in-flight projection is rewritten.
          const contextWindow = context.config.contextWindowTokens;
          if (contextWindow !== undefined
            && estimateModelMessagesTokens(options.messages) > contextWindow * 0.8) {
            const trimmed = trimInFlightToolResults(options.messages, contextWindow * 0.7);
            if (trimmed) return { messages: trimmed };
          }
          return undefined;
        },
        onError: () => {
          closeRequestSpan(true);
        },
        onStepFinish: async (step) => {
          totalSteps++;

          // The recorded input is only the uncached share; the cache buckets
          // travel separately so a cache read is never billed at the full rate.
          const { input: tokensIn, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens } =
            splitModelRequestUsage(step.usage);
          const tokensOut = step.usage?.outputTokens ?? 0;
          const stopReason = modelStopReason(step.finishReason);
          totalTokensIn += tokensIn;
          totalTokensOut += tokensOut;

          // Emit a span for this model request's token usage (A3 observability).
          // `isError: false` and the parent id travel with it: the projection
          // turns the pair into the published `model_request_start_id` /
          // `is_error` / `model_usage` shape.
          const startId = inFlightRequestStart?.id;
          inFlightRequestStart = undefined;
          const spanEvent = eventLog.append(session.id, {
            type: 'span.model_request_end',
            tokensIn,
            tokensOut,
            cacheReadTokens,
            cacheWriteTokens,
            modelUsed,
            stopReason,
            durationMs: Date.now() - startTime,
            parentEventId: startId,
            isError: false,
            ...(requestSpeed ? { speed: requestSpeed } : {}),
          });
          broadcast(spanEvent);
          // Persist the aggregate once per model request. The same usage is
          // intentionally copied to projected message/tool events for local
          // attribution, so metrics must not sum those projections.
          eventLog.recordUsage(session.id, tokensIn, tokensOut, {
            read: cacheReadTokens,
            write: cacheWriteTokens,
          });

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
              // The id was minted in prepareStep so the `event_deltas[]`
              // previews — broadcast from the consumer loop — and this buffered
              // event name the same id, letting accumulators reconcile the two.
              id: mintedMessageIds[totalSteps - 1],
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
              const autoVerdict = autoVerdicts.get(toolCall.toolCallId);
              const awaitsConfirmation =
                (confirmTools.has(toolCall.toolName) || autoVerdict?.type === 'ask')
                && !resultIds.has(toolCall.toolCallId);
              if (awaitsConfirmation) {
                confirmationGroupId ??= `confirm_${nanoid(16)}`;
                pendingConfirmationCalls.push({
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  tokensIn,
                  tokensOut,
                  confirmationGroupId,
                  permissionMeta: toolPermissionMetadata(
                    governedPolicyOf(session, toolCall.toolName, customTools),
                    autoVerdict,
                    false,
                    true,
                  ),
                });
                continue;
              }

              const isMcp = toolCall.toolName.startsWith('mcp_');
              const mcpServerName = isMcp ? resolveMcpServerName(toolCall.toolName, mcpServerNames) : undefined;
              const permissionMeta = toolPermissionMetadata(
                governedPolicyOf(session, toolCall.toolName, customTools),
                autoVerdict,
                resultIds.has(toolCall.toolCallId),
                false,
              );
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
                ...(mcpServerName || permissionMeta
                  ? { metadata: { ...(mcpServerName ? { mcp_server_name: mcpServerName } : {}), ...permissionMeta } }
                  : {}),
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
              // A refused or failed execution is flagged at two layers that
              // must agree: the `is_error` content block is the wire shape, the
              // event-level `isError` is the persisted column consumers query.
              // Sources: our own ToolResultError marker (the wrapper recorded
              // the id) and the MCP protocol's `isError` result field.
              const isToolError =
                failedToolResultCallIds.has(toolResult.toolCallId) ||
                (isMcp && (toolResult.output as { isError?: boolean } | undefined)?.isError === true);
              // Oversize results go through the shared overflow contract: the
              // full text is written into the sandbox and the model keeps a
              // short preview plus the path it can read back from. Slicing
              // inline here is what the contract forbids — one spill format, in
              // one module, for every tool.
              const overflow = await spillToolOutput(raw, {
                sessionId: session.id,
                sandbox: context.sandbox,
                limit: config.toolResultMaxChars,
              });
              const toolResultEvent = eventLog.append(session.id, {
                type: isMcp ? 'agent.mcp_tool_result' : 'agent.tool_result',
                content: [{
                  type: 'tool_result',
                  tool_use_id: toolResult.toolCallId,
                  content: overflow.preview,
                  ...(isToolError ? { is_error: true } : {}),
                }] as ContentBlock[],
                ...(isToolError ? { isError: true } : {}),
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

          // A call the SDK never executed — an input that fails schema
          // validation is the observed case: the SDK returns a `tool-error`
          // part to the model, and that part is not in `step.toolResults`.
          // The call already produced an `agent.tool_use` above, so it must
          // pair with an explicit error result — otherwise the append-only
          // log holds a use that looks forever unanswered, which is exactly
          // what callers of the pairing contract read as a parked call.
          if (step.toolCalls && step.toolCalls.length > 0) {
            const resultIds = new Set((step.toolResults ?? []).map((result) => result.toolCallId));
            for (const toolCall of step.toolCalls) {
              if (resultIds.has(toolCall.toolCallId)) continue;
              if (customTools.has(toolCall.toolName) || confirmTools.has(toolCall.toolName)) continue;
              // An `auto` call the judge parked is already on the confirmation
              // path — a synthetic error here would claim it failed.
              if (autoVerdicts.get(toolCall.toolCallId)?.type === 'ask') continue;
              const isMcp = toolCall.toolName.startsWith('mcp_');
              // The SDK's `tool-error` stream part carries the real failure —
              // a thrown execute error or the input-validation message — while
              // `toolCall.error` covers the invalid-call path. Prefer the
              // stream part; both beat a generic placeholder.
              const streamError = toolStreamErrors.get(toolCall.toolCallId);
              const error = streamError ?? (toolCall as { error?: unknown }).error;
              const message = error instanceof Error
                ? error.message
                : typeof error === 'string' && error.length > 0
                  ? error
                  : 'Tool call produced no result.';
              const toolErrorEvent = eventLog.append(session.id, {
                type: isMcp ? 'agent.mcp_tool_result' : 'agent.tool_result',
                content: [{
                  type: 'tool_result',
                  tool_use_id: toolCall.toolCallId,
                  content: message,
                  is_error: true,
                }] as ContentBlock[],
                isError: true,
                modelUsed,
                stopReason,
              });
              broadcast(toolErrorEvent);
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
      // `mintedMessageIds` is indexed by step: `prepareStep` pushes before the
      // request, the `start-step` stream part names the same step here, and
      // `onStepFinish` appends under `mintedMessageIds[totalSteps - 1]`.
      let consumedStepIndex = -1;
      let streamError: unknown;
      for await (const part of result.fullStream) {
        guard.push(part);
        if (part.type === 'start-step') {
          consumedStepIndex++;
          messageId = mintedMessageIds[consumedStepIndex] ?? '';
        } else if (part.type === 'text-delta') {
          if (!streaming) {
            streaming = true;
            // The durable `agent.message` id was minted in prepareStep so that
            // `event_deltas[]` previews announce the id the buffered event
            // lands under; the fallback covers streams that omit start-step.
            if (!messageId) messageId = `sevt_${nanoid(16)}`;
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
        } else if (part.type === 'tool-error') {
          // A `tool-error` part never lands in `step.toolResults`, so this map
          // is the only place the paired error result can read the real cause.
          // Parts for a step stream before its finish-step, which means the
          // map is already populated when onStepFinish runs for that step.
          toolStreamErrors.set(part.toolCallId, (part as { error?: unknown }).error);
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
        // A self-hosted environment's worker answers the call itself: the
        // sandbox instance owns the queue, and the event must already be on
        // the log so the worker's completion can resolve the parked call by
        // its tool_use block id. Providers without the capability leave the
        // call parked for the caller, and a queue write that fails does the
        // same - the parked event is the honest record in both cases.
        try {
          (_sandbox as Partial<CustomToolCallSubmitter>).enqueueCustomToolCall?.({
            name: pendingCall.toolName,
            toolUseId: pendingCall.toolCallId,
            input: authority.value,
          });
        } catch {
          // Enqueueing is best-effort; the parked event is the record.
        }
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
          metadata: {
            confirmation_group_id: pendingCall.confirmationGroupId,
            ...pendingCall.permissionMeta,
          },
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
        (c: any) => (confirmTools.has(c.toolName) || autoVerdicts.get(c.toolCallId)?.type === 'ask')
          && confirmableToolCallIds.has(c.toolCallId),
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
      // A request that died without tripping the stream's `onError` still has
      // its start in flight; close the pair before the turn unwinds.
      closeRequestSpan(true);
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

function toAiTool(tool: any, failedToolResultCallIds?: Set<string>): any {
  if (!tool || typeof tool !== 'object') return tool;
  const converted = tool.inputSchema
    ? tool
    : tool.parameters && typeof tool.parameters === 'object'
      ? (() => {
          const { parameters, ...rest } = tool;
          return {
            ...rest,
            inputSchema: isAiSdkSchema(parameters) ? parameters : jsonSchema(parameters),
          };
        })()
      : tool;

  // A ToolResultError return is the tool layer's way of saying "this text is a
  // refusal or failure". Unwrap it here — never inside execute — so the SDK
  // sees the same plain string the model always received, while the emitted
  // tool_result can be flagged is_error without string-sniffing content.
  const execute = converted.execute;
  if (typeof execute !== 'function' || !failedToolResultCallIds) return converted;
  return {
    ...converted,
    execute: async (input: unknown, options?: { toolCallId?: string }) => {
      const output = await execute(input, options);
      const errText = toolErrorText(output);
      if (errText === undefined) return output;
      if (options?.toolCallId) failedToolResultCallIds.add(options.toolCallId);
      return errText;
    },
  };
}

function isAiSdkSchema(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    ('jsonSchema' in value || '_def' in value),
  );
}

/**
 * Attach the `auto` permission gate to a resolved tool.
 *
 * The SDK consults `needsApproval` per call, before execution: the callback
 * runs the evaluator once, records the verdict under the call id, and returns
 * `true` only for `ask` — the SDK then emits the call without executing it,
 * which is exactly the parked shape the confirmation path already handles.
 *
 * `deny` cannot return `true` — that would park a call the judge already
 * condemned — so it returns `false` and the wrapped `execute` answers with a
 * ToolResultError: the model reads the refusal as an ordinary error result,
 * and the emitted `agent.tool_result` is flagged `is_error` by the same
 * marker every other refusal uses. The tool's own `execute` never runs.
 */
function autoPermissionTool(
  tool: any,
  name: string,
  evaluate: (call: AutoPermissionCall) => Promise<AutoPermissionVerdict>,
  verdicts: Map<string, AutoPermissionVerdict>,
): any {
  const execute = tool?.execute;
  return {
    ...tool,
    needsApproval: async (input: unknown, options: { toolCallId?: string }) => {
      const verdict = await evaluate({
        toolName: name,
        input: input && typeof input === 'object' ? input as Record<string, unknown> : {},
        toolCallId: options?.toolCallId ?? '',
      });
      if (options?.toolCallId) verdicts.set(options.toolCallId, verdict);
      return verdict.type === 'ask';
    },
    execute: typeof execute === 'function'
      ? async (input: unknown, options?: { toolCallId?: string }) => {
          const verdict = options?.toolCallId ? verdicts.get(options.toolCallId) : undefined;
          if (verdict?.type === 'deny') {
            return toolError(
              `Tool call denied by permission policy evaluation (${verdict.reasonCode}).`,
            );
          }
          return execute(input, options);
        }
      : execute,
  };
}

/**
 * The resolved permission policy governing a model-visible tool name, or
 * `undefined` for caller-executed custom tools, which permission policy does
 * not govern by design.
 */
function governedPolicyOf(
  session: { agentDefinition?: { tools?: unknown[] } },
  toolName: string,
  customTools: Set<string>,
): PermissionPolicyType | undefined {
  if (customTools.has(toolName)) return undefined;
  const agent = session.agentDefinition as Parameters<typeof runtimeToolPermission>[0] | undefined;
  return agent ? runtimeToolPermission(agent, toolName) : undefined;
}

/**
 * The permission evidence an `agent.tool_use` event carries.
 *
 * `evaluated_permission` is the invocation's outcome; `evaluation` names the
 * resolved policy arm that produced it, carrying the judge's verdict under
 * `auto`. The `evaluation` field is absent only when the call was refused
 * before any policy applied — an unvalidated call that never reached the
 * evaluator — which reads as `evaluated_permission: "deny"`. `never_allow`
 * produces no event at all because the tool is withheld upstream.
 */
function toolPermissionMetadata(
  policy: PermissionPolicyType | undefined,
  verdict: AutoPermissionVerdict | undefined,
  hasResult: boolean,
  parked: boolean,
): Record<string, unknown> | undefined {
  if (policy === undefined || policy === 'never_allow') return undefined;
  if (policy === 'auto') {
    if (!verdict) return { permission: 'auto', evaluated_permission: 'deny' };
    return {
      permission: 'auto',
      evaluated_permission: verdict.type,
      evaluation: {
        type: 'auto',
        evaluated_permission: verdict.type,
        ...(verdict.type === 'allow' ? {} : { reason_code: verdict.reasonCode }),
      },
    };
  }
  if (parked) {
    return {
      permission: policy,
      evaluated_permission: 'ask',
      evaluation: { type: 'always_ask' },
    };
  }
  if (!hasResult) return { permission: policy, evaluated_permission: 'deny' };
  return {
    permission: policy,
    evaluated_permission: 'allow',
    evaluation: { type: 'always_allow' },
  };
}
