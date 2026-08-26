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

import { jsonSchema, streamText } from 'ai';
import { createAiSdkExecutionLock, type JsonSchemaLike } from 'prefix-safe-json';
import type { LanguageModelV1 } from 'ai';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import type { SessionEvent } from '@/types/session.js';
import type { ContentBlock } from '@/types/cma-protocol.js';
import { createAiSdkV4ExecutionGuard } from './ai-sdk-v4-execution-guard.js';

/** Max characters retained per tool result (OMA parity). */
const MAX_TOOL_RESULT_CHARS = 50_000;

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

  async *execute(context: StrategyContext): AsyncIterable<SessionEvent> {
    const { session, systemPrompt, messages, model, tools, sandbox: _sandbox, eventLog, broadcast, config, abortSignal } = context;
    const maxSteps = config.maxSteps ?? 25;

    // beforeTurn hook
    if (config.beforeTurn) {
      await config.beforeTurn(context);
    }

    let totalSteps = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    const confirmTools = new Set(config.confirmTools ?? []);
    const confirmableToolCallIds = new Set<string>();
    const pendingConfirmationCalls: Array<{
      toolCallId: string;
      toolName: string;
      tokensIn: number;
      tokensOut: number;
    }> = [];
    const startTime = Date.now();

    try {
      // Build Vercel AI SDK tool definitions from our CoreTool map
      const confirmationToolDefinitions = Object.fromEntries(
        Object.entries(tools).filter(([name]) => confirmTools.has(name)),
      );
      const lockedConfirmationTools = createAiSdkExecutionLock(confirmationToolDefinitions);
      const aiTools: Record<string, any> = {};
      for (const [name, tool] of Object.entries(tools)) {
        aiTools[name] = toAiTool(lockedConfirmationTools[name] ?? tool);
      }
      const guard = createAiSdkV4ExecutionGuard({
        schemas: Object.fromEntries(
          Object.entries(confirmationToolDefinitions)
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
        model: model as LanguageModelV1,
        system: systemPrompt || undefined,
        messages: aiMessages,
        tools: Object.keys(aiTools).length > 0 ? aiTools : undefined,
        maxSteps,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        toolCallStreaming: true,
        abortSignal,
        onStepFinish: async (step) => {
          totalSteps++;

          const tokensIn = step.usage?.promptTokens ?? 0;
          const tokensOut = step.usage?.completionTokens ?? 0;
          totalTokensIn += tokensIn;
          totalTokensOut += tokensOut;

          // Emit a span for this model request's token usage (A3 observability).
          const spanEvent = eventLog.append(session.id, {
            type: 'span.model_request_end',
            tokensIn,
            tokensOut,
            durationMs: Date.now() - startTime,
          });
          broadcast(spanEvent);
          // Persist the aggregate once per model request. The same usage is
          // intentionally copied to projected message/tool events for local
          // attribution, so metrics must not sum those projections.
          eventLog.recordUsage(session.id, tokensIn, tokensOut);

          // Emit agent.thinking for reasoning output (extended-thinking models)
          const reasoning = (step as { reasoning?: string }).reasoning;
          if (reasoning && reasoning.trim()) {
            const thinkingEvent = eventLog.append(session.id, {
              type: 'agent.thinking',
              content: [{ type: 'text', text: reasoning }] as ContentBlock[],
            });
            broadcast(thinkingEvent);
          }

          // Emit agent.message for this step's text (OMA pattern: per-step, not end-of-loop)
          if (step.text && step.text.trim()) {
            const agentMsgEvent = eventLog.append(session.id, {
              type: 'agent.message',
              content: [{ type: 'text', text: step.text }] as ContentBlock[],
              tokensIn,
              tokensOut,
              durationMs: Date.now() - startTime,
            });
            broadcast(agentMsgEvent);
          }

          // Emit events for tool calls (MCP tools get the mcp_* event type)
          if (step.toolCalls && step.toolCalls.length > 0) {
            const resultIds = new Set((step.toolResults ?? []).map((result) => result.toolCallId));
            for (const toolCall of step.toolCalls) {
              const awaitsConfirmation = confirmTools.has(toolCall.toolName) && !resultIds.has(toolCall.toolCallId);
              if (awaitsConfirmation) {
                pendingConfirmationCalls.push({
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  tokensIn,
                  tokensOut,
                });
                continue;
              }

              const isMcp = toolCall.toolName.startsWith('mcp_');
              const toolUseEvent = eventLog.append(session.id, {
                type: isMcp ? 'agent.mcp_tool_use' : 'agent.tool_use',
                content: [{
                  type: 'tool_use',
                  id: toolCall.toolCallId,
                  name: toolCall.toolName,
                  input: toolCall.args as Record<string, unknown>,
                }] as ContentBlock[],
                tokensIn,
                tokensOut,
              });
              broadcast(toolUseEvent);
            }
          }

          // Emit events for tool results (MCP tools get the mcp_* event type)
          if (step.toolResults && step.toolResults.length > 0) {
            for (const toolResult of step.toolResults) {
              const isMcp = toolResult.toolName?.startsWith('mcp_') ?? false;
              const raw = typeof toolResult.result === 'string'
                ? toolResult.result
                : JSON.stringify(toolResult.result);
              const capped = raw.length > MAX_TOOL_RESULT_CHARS
                ? raw.slice(0, MAX_TOOL_RESULT_CHARS) + `\n\n[truncated: ${raw.length - MAX_TOOL_RESULT_CHARS} more chars]`
                : raw;
              const toolResultEvent = eventLog.append(session.id, {
                type: isMcp ? 'agent.mcp_tool_result' : 'agent.tool_result',
                content: [{
                  type: 'tool_result',
                  tool_use_id: toolResult.toolCallId,
                  content: capped,
                }] as ContentBlock[],
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
              delta: part.textDelta,
            }),
          );
        } else if (part.type === 'step-finish' || part.type === 'finish') {
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
        throw streamError instanceof Error ? streamError : new Error(String(streamError));
      }

      const guarded = guard.finish();
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
          }] as ContentBlock[],
          tokensIn: pendingCall.tokensIn,
          tokensOut: pendingCall.tokensOut,
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

      if (pendingConfirm.length > 0 && config.onRequiresAction) {
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
      // onError hook
      if (config.onError) {
        const decision = await config.onError(error instanceof Error ? error : new Error(String(error)));
        if (decision === 'retry') {
          // For now, just re-throw — retry logic would need loop wrapping
          throw error;
        }
      }
      throw error;
    }
  }
}

function toAiTool(tool: any): any {
  if (!tool || typeof tool !== 'object') return tool;
  if (!tool.parameters || typeof tool.parameters !== 'object') return tool;
  if (isAiSdkSchema(tool.parameters)) return tool;

  return {
    ...tool,
    parameters: jsonSchema(tool.parameters),
  };
}

function isAiSdkSchema(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    ('jsonSchema' in value || '_def' in value),
  );
}
