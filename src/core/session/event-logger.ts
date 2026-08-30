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
      stopReason?: string;
      durationMs?: number;
      parentEventId?: string;
      delegationDepth?: number;
    },
  ): SessionEvent {
    const id = `sevt_${nanoid(16)}`;
    const seq = this.getLatestSeq(sessionId) + 1;
    const now = new Date();

    const stmt = this.db.prepare(`
      INSERT INTO events (id, session_id, seq, type, content, model_used, tokens_in, tokens_out, stop_reason, duration_ms, parent_event_id, delegation_depth, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      event.stopReason ?? null,
      event.durationMs ?? null,
      event.parentEventId ?? null,
      event.delegationDepth ?? 0,
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
      stopReason: event.stopReason,
      durationMs: event.durationMs,
      parentEventId: event.parentEventId,
      delegationDepth: event.delegationDepth,
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
  recordUsage(sessionId: string, tokensIn: number, tokensOut: number): void {
    this.db.prepare(`
      UPDATE sessions
      SET usage_tokens_in = COALESCE(usage_tokens_in, 0) + ?,
          usage_tokens_out = COALESCE(usage_tokens_out, 0) + ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(tokensIn, tokensOut, sessionId);
  }
}

// ============================================================
// Internal helpers
// ============================================================

interface EventRow {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  content: string | null;
  model_used: string | null;
  tokens_in: number;
  tokens_out: number;
  stop_reason: string | null;
  duration_ms: number | null;
  parent_event_id: string | null;
  delegation_depth: number;
  created_at: string;
  processed_at: string | null;
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
    stopReason: row.stop_reason ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    parentEventId: row.parent_event_id ?? undefined,
    delegationDepth: row.delegation_depth,
    createdAt: new Date(row.created_at),
    processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
  };
}
