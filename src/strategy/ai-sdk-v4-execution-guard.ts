import {
  createAiSdkExecutionGuard,
  type ExecutionDecision,
  type ExecutionGuardOptions,
  type ExecuteDecision,
  type ToolCallExecutionGateFinalResult,
} from 'prefix-safe-json';

/**
 * AI SDK v4 exposes the same raw argument bytes under older fullStream part
 * names. Translate those lifecycle names without rebuilding bytes from the
 * parsed tool-call projection.
 */
export function createAiSdkV4ExecutionGuard(options?: ExecutionGuardOptions) {
  const guard = createAiSdkExecutionGuard(options);
  const started = new Set<string>();
  const ended = new Set<string>();

  return {
    push(part: any): void {
      if (part?.type === 'tool-call-streaming-start') {
        started.add(part.toolCallId);
        guard.push({
          type: 'tool-input-start',
          id: part.toolCallId,
          toolName: part.toolName,
        });
        return;
      }

      if (part?.type === 'tool-call-delta') {
        guard.push({
          type: 'tool-input-delta',
          id: part.toolCallId,
          delta: part.argsTextDelta,
        });
        return;
      }

      if (part?.type === 'tool-call') {
        if (started.has(part.toolCallId) && !ended.has(part.toolCallId)) {
          ended.add(part.toolCallId);
          guard.push({ type: 'tool-input-end', id: part.toolCallId });
        }
        guard.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
        });
        return;
      }

      guard.push(part);
    },
    finish(): ToolCallExecutionGateFinalResult {
      return guard.finish();
    },
    takeDecision(internalId: string): ExecuteDecision | undefined {
      return guard.takeDecision(internalId);
    },
    snapshot(): readonly ExecutionDecision[] {
      return guard.snapshot();
    },
  };
}
