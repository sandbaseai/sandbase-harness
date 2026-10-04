/**
 * Event Logger (append-only)
 *
 * Manages the Event_Log for sessions. Append-only — no update/delete.
 * Auto-increments `seq` per session, generates `sevt_` prefixed IDs.
 */

import { nanoid } from 'nanoid';
import type { Database } from '@/core/db/database.js';
import type { SessionEvent } from '@/types/session.js';
import type { CMAEventType, ContentBlock } from '@/types/cma-protocol.js';

export class EventLogger {
  constructor(private readonly db: Database) {}

  /**
   * Append an event to the log. Returns the persisted event with generated ID and seq.
   */
  append(
    sessionId: string,
    event: {
      type: CMAEventType;
      content?: ContentBlock[];
      modelUsed?: string;
      tokensIn?: number;
      tokensOut?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      stopReason?: string;
      durationMs?: number;
      parentEventId?: string;
      /** Only meaningful on `span.model_request_end`; NULL on every other row. */
      isError?: boolean;
      /** `span.model_request_end` only: the speed tier the request ran at. */
      speed?: 'standard' | 'fast';
      delegationDepth?: number;
      metadata?: Record<string, unknown>;
      /**
       * Pre-generated id for events that were previewed on `event_deltas[]`
       * connections: the previewed id must equal the buffered event's id, so
       * the producer mints the id before streaming and hands it back here.
       * Omitted everywhere else.
       */
      id?: string;
    },
  ): SessionEvent {
    const id = event.id ?? `sevt_${nanoid(16)}`;
    const seq = this.getLatestSeq(sessionId) + 1;
    const now = new Date();

    const stmt = this.db.prepare(`
      INSERT INTO events (id, session_id, seq, type, content, model_used, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, stop_reason, duration_ms, parent_event_id, is_error, speed, delegation_depth, metadata, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      sessionId,
      seq,
      event.type,
      event.content ? JSON.stringify(event.content) : null,
      event.modelUsed ?? null,
      event.tokensIn ?? 0,
      event.tokensOut ?? 0,
      event.cacheReadTokens ?? null,
      event.cacheWriteTokens ?? null,
      event.stopReason ?? null,
      event.durationMs ?? null,
      event.parentEventId ?? null,
      event.isError === undefined ? null : event.isError ? 1 : 0,
      event.speed ?? null,
      event.delegationDepth ?? 0,
      JSON.stringify(event.metadata ?? {}),
      now.toISOString(),
    );

    return {
      id,
      sessionId,
      seq,
      type: event.type,
      content: event.content,
      modelUsed: event.modelUsed,
      tokensIn: event.tokensIn,
      tokensOut: event.tokensOut,
      cacheReadTokens: event.cacheReadTokens,
      cacheWriteTokens: event.cacheWriteTokens,
      stopReason: event.stopReason,
      durationMs: event.durationMs,
      parentEventId: event.parentEventId,
      isError: event.isError,
      speed: event.speed,
      delegationDepth: event.delegationDepth,
      metadata: event.metadata,
      createdAt: now,
      processedAt: now,
    };
  }

  /**
   * Get all events for a session, optionally starting after a given seq.
   */
  getEvents(sessionId: string, afterSeq?: number): SessionEvent[] {
    const sql = afterSeq !== undefined
      ? 'SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC'
      : 'SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC';

    const stmt = this.db.prepare(sql);
    const rows = (afterSeq !== undefined ? stmt.all(sessionId, afterSeq) : stmt.all(sessionId)) as unknown as EventRow[];

    return rows.map(rowToEvent);
  }

  /**
   * The status-transition rows `activeSecondsFromTicks` reads, for a set of
   * sessions in one query. A session listing needs stats per row, and reading
   * every full event log per row would make the page size the cost driver for
   * a projection that only needs three event types.
   */
  getStatusEventTicks(sessionIds: readonly string[]): StatusEventTick[] {
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => '?').join(', ');
    const stmt = this.db.prepare(
      `SELECT session_id, type, processed_at, created_at FROM events
       WHERE session_id IN (${placeholders})
         AND type IN ('session.status_running', 'session.status_idle', 'session.status_terminated')
       ORDER BY session_id, seq ASC`,
    );
    const rows = stmt.all(...sessionIds) as Array<{
      session_id: string;
      type: string;
      processed_at: string | null;
      created_at: string | null;
    }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      type: row.type,
      processedAt: row.processed_at ? new Date(row.processed_at) : null,
      createdAt: row.created_at ? new Date(row.created_at) : null,
    }));
  }

  /**
   * The rows `outcomeEvaluationsFromEvents` reads, for a set of sessions in one
   * query: the outcome declaration and evaluation spans — plus
   * `session.status_running`, the only signal that separates `pending` from
   * `running` before a span exists — with their metadata carriers parsed.
   */
  getOutcomeEventRows(sessionIds: readonly string[]): OutcomeEventRow[] {
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => '?').join(', ');
    const stmt = this.db.prepare(
      `SELECT session_id, type, metadata, processed_at, created_at FROM events
       WHERE session_id IN (${placeholders})
         AND type IN ('user.define_outcome', 'span.outcome_evaluation_start',
                      'span.outcome_evaluation_ongoing', 'span.outcome_evaluation_end',
                      'session.status_running')
       ORDER BY session_id, seq ASC`,
    );
    const rows = stmt.all(...sessionIds) as Array<{
      session_id: string;
      type: string;
      metadata: string | null;
      processed_at: string | null;
      created_at: string | null;
    }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      type: row.type,
      metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
      processedAt: row.processed_at ? new Date(row.processed_at) : null,
      createdAt: row.created_at ? new Date(row.created_at) : null,
    }));
  }

  /**
   * Get the latest seq number for a session. Returns 0 if no events exist.
   */
  getLatestSeq(sessionId: string): number {
    const stmt = this.db.prepare('SELECT MAX(seq) as max_seq FROM events WHERE session_id = ?');
    const row = stmt.get(sessionId) as { max_seq: number | null } | undefined;
    return row?.max_seq ?? 0;
  }

  /**
   * Add usage from one model request to the session aggregate.
   * Callers must invoke this once per model request, not once per event
   * projection, because several events may describe the same request.
   */
  recordUsage(
    sessionId: string,
    tokensIn: number,
    tokensOut: number,
    cache?: { read?: number; write?: number },
  ): void {
    this.db.prepare(`
      UPDATE sessions
      SET usage_tokens_in = COALESCE(usage_tokens_in, 0) + ?,
          usage_tokens_out = COALESCE(usage_tokens_out, 0) + ?,
          usage_cache_read_tokens = COALESCE(usage_cache_read_tokens, 0) + ?,
          usage_cache_write_tokens = COALESCE(usage_cache_write_tokens, 0) + ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(tokensIn, tokensOut, cache?.read ?? 0, cache?.write ?? 0, sessionId);
  }
}

// ============================================================
// Internal helpers
// ============================================================

/** One status-transition row, as {@link EventLogger.getStatusEventTicks} returns it. */
export interface StatusEventTick {
  sessionId: string;
  type: string;
  processedAt: Date | null;
  createdAt: Date | null;
}

/** One outcome-relevant row, as {@link EventLogger.getOutcomeEventRows} returns it. */
export interface OutcomeEventRow {
  sessionId: string;
  type: string;
  metadata: Record<string, unknown> | null;
  processedAt: Date | null;
  createdAt: Date | null;
}

interface EventRow {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  content: string | null;
  model_used: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  stop_reason: string | null;
  duration_ms: number | null;
  parent_event_id: string | null;
  is_error: number | null;
  speed: string | null;
  delegation_depth: number;
  metadata: string | null;
  created_at: string;
  processed_at: string | null;
}

function parseMetadata(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function rowToEvent(row: EventRow): SessionEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    type: row.type as CMAEventType,
    content: row.content ? JSON.parse(row.content) : undefined,
    modelUsed: row.model_used ?? undefined,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    cacheReadTokens: row.cache_read_tokens ?? undefined,
    cacheWriteTokens: row.cache_write_tokens ?? undefined,
    stopReason: row.stop_reason ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    parentEventId: row.parent_event_id ?? undefined,
    isError: row.is_error === null ? undefined : row.is_error === 1,
    speed: row.speed === 'fast' ? 'fast' : row.speed === 'standard' ? 'standard' : undefined,
    delegationDepth: row.delegation_depth,
    metadata: parseMetadata(row.metadata),
    createdAt: new Date(row.created_at),
    processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
  };
}
