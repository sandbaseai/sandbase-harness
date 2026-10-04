import { nanoid } from 'nanoid';
import { isValidTimeZone, nextCronRun as nextCronRunInZone } from './cron.js';
import type { Database } from '@/core/db/database.js';
import type { SessionManager } from '@/core/session/session-manager.js';

export type SchedulerRunResult = {
  id: string;
  schedule_id: string;
  session_id: string | null;
  status: string;
  trigger_type: string;
  payload: string;
  error: string | null;
  started_at: string;
  completed_at: string | null;
};

/**
 * The next occurrence of a cron expression, evaluated in `timeZone`.
 *
 * An unknown zone is refused rather than silently falling back to UTC: a
 * schedule that quietly fires at the wrong hour is worse than one that fails
 * to save.
 */
export function nextCronRun(
  cron: string,
  after: Date = new Date(),
  timeZone = 'UTC',
): Date | null {
  if (!isValidTimeZone(timeZone)) return null;
  return nextCronRunInZone(cron, after, timeZone);
}

/**
 * Restore the forward schedule of every active deployment at startup.
 *
 * `runDueScheduledDeployments` only matches rows that already carry a
 * `next_run_at`, so a deployment whose next time passed while the runtime was
 * down would never be picked up again. Recomputing it at startup is not a
 * backfill — a trigger missed while the process was stopped is deliberately not
 * replayed, per the contract — it only restores the forward schedule.
 */
export function rearmScheduledDeployments(deps: { db: Database }, opts: { now?: Date } = {}): number {
  const now = opts.now ?? new Date();
  const rows = deps.db.prepare(
    `SELECT *
     FROM scheduled_deployments
     WHERE archived_at IS NULL AND status = 'active'`,
  ).all() as Array<RearmRow>;
  let updated = 0;
  for (const row of rows) {
    const stale = !row.next_run_at || row.next_run_at <= now.toISOString();
    if (!stale) continue;
    const next = nextCronRun(row.cron, now, row.timezone || 'UTC')?.toISOString() ?? null;
    deps.db.prepare(
      'UPDATE scheduled_deployments SET next_run_at = ?, updated_at = ? WHERE id = ?',
    ).run(next, now.toISOString(), row.id);
    updated += 1;
  }
  return updated;
}

type RearmRow = {
  id: string;
  cron: string;
  timezone: string | null;
  next_run_at: string | null;
};
/**
 * The run event a timed run raises, as the published contract shapes it.
 *
 * `data.type` names the resource the id belongs to, which is the local envelope's
 * convention for every operations event; the published envelope instead puts the
 * event name there, and that divergence is recorded in the contract rather than
 * half-adopted per event.
 */
export type ScheduledDeploymentEvent = {
  /** The published event name. */
  type: string;
  /** The run id `data.id` carries — a reference the receiver resolves itself. */
  subjectId: string;
};

/**
 * Where a run event goes. Injected rather than imported because this module is
 * core and must not reach for the API layer's `ServerDeps`; the callers that hold
 * a workspace know how to deliver, sign, and record one.
 */
export type ScheduledDeploymentEventSink = (event: ScheduledDeploymentEvent) => Promise<void>;

/**
 * Run every deployment whose time has come, reporting each run to `onEvent`.
 *
 * **Only this path publishes `deployment_run` events.** The published table says
 * timed runs raise them and manual runs do not, and the manual route
 * (`POST /{id}/run`) shares `runSchedule` with this one — so the rule has to live
 * on the path, not on the trigger type. It cannot key off `triggerType ===
 * 'scheduled'` either: that value is caller-supplied on the manual route, so a
 * manual run could declare itself timed and emit its way into a rule it is
 * excluded from.
 *
 * `started` is published once the run is recorded and before its outcome, not at
 * the instant the run begins. `runSchedule` is synchronous and writes its row in
 * a single terminal statement — there is no intermediate persisted state to point
 * at — and the published handler contract tells a receiver to fetch the resource
 * by `data.id` (`订阅Webhook.md:337`). Publishing earlier would send that fetch to
 * a 404 for a run that had genuinely started. The event is late rather than false;
 * the run's `started_at` records the instant it reports.
 *
 * Delivery is best-effort throughout: a subscriber that cannot be reached is
 * recorded and retried by the dispatcher, and must never stop a due deployment
 * from running or abandon the rest of the pass.
 */
export async function runDueScheduledDeployments(
  db: Database,
  sessionManager: SessionManager,
  opts: { now?: Date; onEvent?: ScheduledDeploymentEventSink } = {},
): Promise<SchedulerRunResult[]> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const rows = db.prepare(
    `SELECT *
     FROM scheduled_deployments
     WHERE archived_at IS NULL
       AND status = 'active'
       AND next_run_at IS NOT NULL
       AND next_run_at <= ?
     ORDER BY next_run_at ASC, created_at ASC
     LIMIT 50`,
  ).all(nowIso) as ScheduleRow[];
  const emit = async (event: ScheduledDeploymentEvent): Promise<void> => {
    try {
      await opts.onEvent?.(event);
    } catch {
      // A failed delivery cannot be improved on in-band, and the run it describes
      // has already been recorded; the next tick picks up anything still due.
    }
  };
  const results: SchedulerRunResult[] = [];
  for (const schedule of rows) {
    const result = runSchedule(db, sessionManager, schedule, 'scheduled', now);
    // A scheduled run that materialized a session is a session creation like
    // any other: `session.created` names the session it produced, and the run
    // events name the run, which is what the published table uses to tie an
    // outcome to the run that started.
    if (result.session_id) {
      await emit({ type: 'session.created', subjectId: result.session_id });
    }
    await emit({ type: 'deployment_run.started', subjectId: result.id });
    await emit({
      type: result.status === 'created_session' ? 'deployment_run.succeeded' : 'deployment_run.failed',
      subjectId: result.id,
    });
    results.push(result);
  }
  return results;
}

export function runSchedule(
  db: Database,
  sessionManager: SessionManager,
  schedule: ScheduleRow,
  triggerType: string,
  startedAtDate: Date = new Date(),
): SchedulerRunResult {
  const runId = `srun_${nanoid(18)}`;
  const startedAt = startedAtDate.toISOString();
  const payload = parseObject(schedule.payload);
  const timeZone = scheduleTimeZone(schedule);
  const nextRun = nextCronRun(schedule.cron, startedAtDate, timeZone)?.toISOString() ?? null;
  try {
    const session = sessionManager.create({
      agent: schedule.agent_id,
      environmentId: schedule.environment_id ?? undefined,
      title: typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : `Scheduled run: ${schedule.name}`,
      metadata: {
        scheduled_deployment_id: schedule.id,
        scheduled_deployment_run_id: runId,
        trigger_type: triggerType,
      },
    });
    db.prepare(
      `INSERT INTO scheduled_deployment_runs (
        id, schedule_id, session_id, status, trigger_type, payload, error, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, schedule.id, session.id, 'created_session', triggerType, JSON.stringify(payload), null, startedAt, new Date().toISOString());
    db.prepare(
      'UPDATE scheduled_deployments SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
    ).run(startedAt, nextRun, new Date().toISOString(), schedule.id);
  } catch (err) {
    db.prepare(
      `INSERT INTO scheduled_deployment_runs (
        id, schedule_id, session_id, status, trigger_type, payload, error, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, schedule.id, null, 'failed', triggerType, JSON.stringify(payload), err instanceof Error ? err.message : String(err), startedAt, new Date().toISOString());
    db.prepare(
      'UPDATE scheduled_deployments SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
    ).run(startedAt, nextRun, new Date().toISOString(), schedule.id);
  }
  return db.prepare('SELECT * FROM scheduled_deployment_runs WHERE id = ?').get(runId) as SchedulerRunResult;
}

function parseCron(cron: string): ParsedCron | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const parsed = {
    minutes: parseField(minute, 0, 59),
    hours: parseField(hour, 0, 23),
    daysOfMonth: parseField(dayOfMonth, 1, 31),
    months: parseField(month, 1, 12),
    daysOfWeek: parseField(dayOfWeek, 0, 6),
  };
  return Object.values(parsed).every((set) => set.size > 0) ? parsed : null;
}

function parseField(value: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const rawPart of value.split(',')) {
    const [rangePart, stepPart] = rawPart.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) continue;
    const [start, end] = rangePart === '*'
      ? [min, max]
      : rangePart.includes('-')
        ? rangePart.split('-').map(Number)
        : [Number(rangePart), Number(rangePart)];
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    for (let value = Math.max(min, start); value <= Math.min(max, end); value += step) out.add(value);
  }
  return out;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export type ScheduleRow = {
  id: string;
  name: string;
  agent_id: string;
  environment_id: string | null;
  cron: string;
  payload: string;
};

type ParsedCron = {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
};
/**
 * The zone a schedule's cron is evaluated in.
 *
 * Read from the row's `timezone` column, with `UTC` as the default for a row
 * written before per-schedule zones existed. An unrecognized value is treated
 * as UTC rather than refused here, because a stored schedule must still run;
 * the create and update routes validate the name.
 */
function scheduleTimeZone(schedule: ScheduleRow): string {
  const raw = (schedule as { timezone?: unknown }).timezone;
  return typeof raw === 'string' && raw.length > 0 ? raw : 'UTC';
}
