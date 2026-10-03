/**
 * Session State Machine
 *
 * Enforces valid status transitions for the Session lifecycle.
 * Valid transitions:
 *   queued → running
 *   running → paused | requires_action | completed | failed
 *   paused → running
 *   requires_action → running | timed_out
 *
 * `requires_action → timed_out` is how a configured parked-wait bound ends a
 * session nobody answered (`parked-wait.ts`). It reaches the same terminal
 * status the Pi child's own timeout already used, which was simply not
 * reachable from the one state that waits on a caller.
 *
 * Terminal states are completed, failed, cancelled, timed_out, cleanup_pending, and archived.
 * cleanup_pending and archived deliberately have no outbound transition: the workspace
 * remains retained until an operator can prove child-tree cleanup.
 */

import { type SessionStatus, SESSION_TRANSITIONS } from '@/types/session.js';

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: SessionStatus,
    public readonly to: SessionStatus,
  ) {
    super(`Invalid session state transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Attempt a state transition. Throws InvalidTransitionError if not allowed.
 */
export function transition(current: SessionStatus, next: SessionStatus): SessionStatus {
  const allowed = SESSION_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new InvalidTransitionError(current, next);
  }
  return next;
}

/**
 * Check if a transition is valid without throwing.
 */
export function canTransition(current: SessionStatus, next: SessionStatus): boolean {
  return SESSION_TRANSITIONS[current].includes(next);
}

/**
 * Check if a status is terminal (no outbound transitions).
 */
export function isTerminal(status: SessionStatus): boolean {
  return SESSION_TRANSITIONS[status].length === 0;
}
