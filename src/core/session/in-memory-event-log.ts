/**
 * In-memory Event Log
 *
 * A non-persistent EventLogWriter used for ephemeral sub-agent (delegation)
 * runs. Sub-agent internals are not written to the parent session's durable
 * log — only the sub-agent's final answer surfaces as the delegation tool
 * result, keeping the parent's bijection intact.
 */

import { nanoid } from 'nanoid';
import type { EventLogWriter } from '@/types/strategy.js';
import type { SessionEvent } from '@/types/session.js';

export class InMemoryEventLog implements EventLogWriter {
  private events: SessionEvent[] = [];

  append(sessionId: string, event: Parameters<EventLogWriter['append']>[1]): SessionEvent {
    const seq = this.events.length + 1;
    const full: SessionEvent = {
      id: `mem_${nanoid(12)}`,
      sessionId,
      seq,
      type: event.type,
      content: event.content,
      modelUsed: event.modelUsed,
      tokensIn: event.tokensIn,
      tokensOut: event.tokensOut,
      stopReason: event.stopReason,
      durationMs: event.durationMs,
      parentEventId: event.parentEventId,
      delegationDepth: event.delegationDepth,
      createdAt: new Date(),
      processedAt: new Date(),
    };
    this.events.push(full);
    return full;
  }

  getLatestSeq(_sessionId: string): number {
    return this.events.length;
  }

  recordUsage(_sessionId: string, _tokensIn: number, _tokensOut: number): void {
    // Ephemeral delegated sessions have no durable session aggregate.
  }

  getEvents(): SessionEvent[] {
    return this.events;
  }
}
