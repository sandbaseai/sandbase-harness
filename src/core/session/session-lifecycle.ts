import type { ApiSessionStatus, SessionEvent, SessionStatus } from '@/types/session.js';

export const STATUS_PROJECTION: Record<SessionStatus, {
  wire: ApiSessionStatus;
  event: SessionEvent['type'] | undefined;
  terminal: boolean;
}> = {
  queued: { wire: 'idle', event: undefined, terminal: false },
  running: { wire: 'running', event: 'session.status_running', terminal: false },
  retrying: { wire: 'rescheduling', event: 'session.status_rescheduled', terminal: false },
  paused: { wire: 'idle', event: 'session.status_idle', terminal: false },
  requires_action: { wire: 'idle', event: 'session.status_idle', terminal: false },
  completed: { wire: 'terminated', event: 'session.status_terminated', terminal: true },
  failed: { wire: 'terminated', event: 'session.status_terminated', terminal: true },
  cancelled: { wire: 'terminated', event: 'session.status_terminated', terminal: true },
  timed_out: { wire: 'terminated', event: 'session.status_terminated', terminal: true },
  cleanup_pending: { wire: 'terminated', event: 'session.status_terminated', terminal: true },
  archived: { wire: 'terminated', event: 'session.status_terminated', terminal: true },
};

export function eventTypeForStatus(status: SessionStatus): SessionEvent['type'] | undefined {
  return STATUS_PROJECTION[status].event;
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'))
  );
}
