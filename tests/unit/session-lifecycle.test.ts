import { describe, expect, it } from 'vitest';
import { eventTypeForStatus, isAbortError, STATUS_PROJECTION } from '@/core/session/session-lifecycle.js';
import { isTerminal } from '@/core/session/state-machine.js';
import { toApiSessionStatus } from '@/api/standard.js';
import type { SessionStatus, SessionEvent } from '@/types/session.js';

describe('session lifecycle helpers', () => {
  const projections: [SessionStatus, string, SessionEvent['type'] | undefined, boolean][] = [
    ['queued', 'idle', undefined, false],
    ['running', 'running', 'session.status_running', false],
    ['retrying', 'rescheduling', 'session.status_rescheduled', false],
    ['paused', 'idle', 'session.status_idle', false],
    ['requires_action', 'idle', 'session.status_idle', false],
    ['completed', 'terminated', 'session.status_terminated', true],
    ['failed', 'terminated', 'session.status_terminated', true],
    ['cancelled', 'terminated', 'session.status_terminated', true],
    ['timed_out', 'terminated', 'session.status_terminated', true],
    ['cleanup_pending', 'terminated', 'session.status_terminated', true],
    ['archived', 'terminated', 'session.status_terminated', true],
  ];

  it('covers every internal status in the projection regressions', () => {
    expect(projections.map(([status]) => status).sort()).toEqual(Object.keys(STATUS_PROJECTION).sort());
  });

  it.each(projections)('projects %s consistently to the wire, lifecycle event, and terminal guard', (status, wire, event, terminal) => {
    expect(toApiSessionStatus(status)).toBe(wire);
    expect(['idle', 'running', 'rescheduling', 'terminated']).toContain(toApiSessionStatus(status));
    expect(eventTypeForStatus(status)).toBe(event);
    expect(isTerminal(status)).toBe(terminal);
    expect(STATUS_PROJECTION[status]).toEqual({ wire, event, terminal });
  });

  it('recognizes abort errors without treating arbitrary errors as aborts', () => {
    expect(isAbortError(Object.assign(new Error('cancelled'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError(new Error('operation aborted by user'))).toBe(true);
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
  });
});
