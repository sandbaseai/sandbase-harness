import { nanoid } from 'nanoid';
import { DEPLOYMENT_RUN_JITTER_MAX_MS, deploymentRunJitterMs, isValidTimeZone, nextCronRun as nextCronRunInZone } from './cron.js';
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
  scheduled_at: string | null;
  error_type: string | null;
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
export function rearmScheduledDeployments(deps: { db: Database }, opts: { now?: Date; random?: () => number } = {}): number {
  const now = opts.now ?? new Date();
  const rows = deps.db.prepare(
    `SELECT *
     FROM scheduled_deployments
     WHERE archived_at IS NULL AND status = 'active' AND cron IS NOT NULL`,
  ).all() as Array<RearmRow>;
  let updated = 0;
  for (const row of rows) {
    const stale = !row.next_run_at || row.next_run_at <= now.toISOString();
    if (!stale) continue;
    const next = nextCronRun(row.cron, now, row.timezone || 'UTC')?.toISOString() ?? null;
    // A trigger missed while the process was down is not replayed; the
    // recomputed instant is armed with its own jittered fire time, drawn
    // against the interval it now anchors.
    const dueAt = next
      ? new Date(
          Date.parse(next) +
          deploymentRunJitterMs(
            Math.max(0, Date.parse(next) - (row.last_run_at ? Date.parse(row.last_run_at) : now.getTime())),
            opts.random,
          ),
        ).toISOString()
      : null;
    deps.db.prepare(
      'UPDATE scheduled_deployments SET next_run_at = ?, due_at = ?, updated_at = ? WHERE id = ?',
    ).run(next, dueAt, now.toISOString(), row.id);
    updated += 1;
  }
  return updated;
}

type RearmRow = {
  id: string;
  cron: string;
  timezone: string | null;
  next_run_at: string | null;
  last_run_at?: string | null;
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
/**
 * Arm a deployment's `due_at` — the persisted fire instant for its current
 * `next_run_at`.
 *
 * `due_at` is `next_run_at + jitter`, drawn once and stored so a 60-second due
 * pass reads the same deadline every tick. Re-rolling per pass would let an
 * unlucky schedule postpone itself indefinitely. A row is (re)armed whenever
 * its `next_run_at` moves: on the lazy backfill for rows armed before the
 * column existed, and after each run advances the schedule. Rows with no
 * `next_run_at` — manual-only, or one whose cadence ran out — carry a NULL
 * `due_at` and never match the due query.
 *
 * The delay is `deploymentRunJitterMs` over the interval the run fires into.
 * `last_run_at` anchors the previous scheduled instant for a timed schedule;
 * a deployment with no prior run measures the interval from `now` instead.
 */
export function armDeploymentDueAt(
  db: Database,
  schedule: { id: string; cron: string | null; status?: string | null; timezone?: string | null; next_run_at: string | null; last_run_at?: string | null },
  opts: { now?: Date; random?: () => number } = {},
): string | null {
  const nextRunAt = schedule.next_run_at;
  // A non-active row is disarmed rather than jittered: `due_at` only ever names
  // a fire that can happen, and a paused deployment's next instant is the one
  // resume re-arms for, not this one.
  if (!schedule.cron || !nextRunAt || (schedule.status !== undefined && schedule.status !== 'active')) {
    db.prepare('UPDATE scheduled_deployments SET due_at = NULL WHERE id = ?').run(schedule.id);
    return null;
  }
  const now = opts.now ?? new Date();
  const nextMs = Date.parse(nextRunAt);
  const anchorMs = schedule.last_run_at ? Date.parse(schedule.last_run_at) : now.getTime();
  const intervalMs = Number.isFinite(nextMs) && Number.isFinite(anchorMs) ? nextMs - anchorMs : 0;
  const dueAt = new Date(nextMs + deploymentRunJitterMs(Math.max(0, intervalMs), opts.random));
  db.prepare('UPDATE scheduled_deployments SET due_at = ? WHERE id = ?').run(dueAt.toISOString(), schedule.id);
  return dueAt.toISOString();
}

export async function runDueScheduledDeployments(
  db: Database,
  sessionManager: SessionManager,
  opts: { now?: Date; onEvent?: ScheduledDeploymentEventSink; random?: () => number } = {},
): Promise<SchedulerRunResult[]> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  // (Re)arming: a row needs a fresh `due_at` whenever the one it holds was not
  // drawn for its current `next_run_at` — NULL for rows armed before the column
  // existed, and stale when `next_run_at` moved underneath it (a raw write that
  // bypassed the armed paths). A `due_at` is only valid for the instant it was
  // drawn from: it must sit inside `[next_run_at, next_run_at + 9min]`. Outside
  // that window it describes a different schedule and is re-drawn rather than
  // trusted, so the pass reads a stable deadline instead of re-rolling per tick.
  const unarmed = db.prepare(
    `SELECT id, cron, timezone, next_run_at, last_run_at, due_at
     FROM scheduled_deployments
     WHERE archived_at IS NULL
       AND status = 'active'
       AND cron IS NOT NULL
       AND next_run_at IS NOT NULL`,
  ).all() as Array<{ id: string; cron: string; timezone: string | null; next_run_at: string; last_run_at: string | null; due_at: string | null }>;
  for (const row of unarmed) {
    const nextMs = Date.parse(row.next_run_at);
    const dueMs = row.due_at ? Date.parse(row.due_at) : Number.NaN;
    const stale = !Number.isFinite(dueMs)
      || dueMs < nextMs
      || dueMs > nextMs + DEPLOYMENT_RUN_JITTER_MAX_MS;
    if (stale) armDeploymentDueAt(db, row, { now, random: opts.random });
  }
  const rows = db.prepare(
    `SELECT *
     FROM scheduled_deployments
     WHERE archived_at IS NULL
       AND status = 'active'
       AND due_at IS NOT NULL
       AND due_at <= ?
     ORDER BY due_at ASC, created_at ASC
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
    const outcome = runSchedule(db, sessionManager, schedule, 'scheduled', now, opts.random);
    // A deployment whose agent is gone is archived rather than run: the
    // published rule records no run for it, so there is no id to emit against.
    // Its archive is still a lifecycle event a subscriber is owed.
    if (outcome.archivedDeployment) {
      await emit({ type: 'deployment.archived', subjectId: schedule.id });
      continue;
    }
    const result = outcome.run!;
    // A scheduled run that materialized a session is a session creation like
    // any other: `session.created` names the session it produced, and the run
    // events name the run, which is what the published table uses to tie an
    // outcome to the run that started.
    if (result.session_id) {
      await emit({ type: 'session.created', subjectId: result.session_id });
      // Same coarse lifecycle as a created session: it begins queued, which
      // the published catalog names `pending`.
      await emit({ type: 'session.pending', subjectId: result.session_id });
    }
    await emit({ type: 'deployment_run.started', subjectId: result.id });
    await emit({
      type: result.status === 'created_session' ? 'deployment_run.succeeded' : 'deployment_run.failed',
      subjectId: result.id,
    });
    if (outcome.pausedDeployment) {
      await emit({ type: 'deployment.paused', subjectId: schedule.id });
    }
    results.push(result);
  }
  return results;
}

/**
 * What one trigger attempt produced.
 *
 * `run` is the recorded run row, or `null` when the published contract says no
 * run is recorded at all — a deployment whose agent is archived (or gone) is
 * itself archived, and a run for it would record a failure that can never be
 * anything else. `pausedDeployment` reports that this attempt auto-paused the
 * deployment under the unrecoverable-error rule; the caller publishes
 * `deployment.paused` so the event follows the transition, not the route.
 */
export type ScheduleRunOutcome = {
  run: SchedulerRunResult | null;
  archivedDeployment?: boolean;
  pausedDeployment?: boolean;
};

/**
 * The run-error vocabulary the published run object reports.
 *
 * A failure the schedule can outlive — `session_rate_limited_error` — keeps the
 * deployment active so the next fire retries. Everything else names a
 * condition waiting on an operator (or an unknown one, which the contract
 * treats the same way), so it pauses the deployment with `paused_reason:
 * {type: 'error', error}` carrying the run's error.
 */
const RECOVERABLE_RUN_ERRORS = new Set(['session_rate_limited_error']);

/**
 * Classify a trigger failure into the published `error.type` vocabulary.
 *
 * The checks run in the order the published contract reads: the agent's
 * absence archives the deployment upstream of any run, then the environment
 * the session cannot start without, then the inputs the session's own
 * admission would reject. Anything left — a budget refusal, an engine
 * capability, a damaged definition — is `unknown_error` rather than a guessed
 * category, and the stored message still says what actually failed.
 */
function classifyTriggerFailure(
  db: Database,
  schedule: ScheduleRow,
): { type: string; message: string } | null {
  if (!schedule.agent_id) {
    return { type: 'session_creation_rejected_error', message: 'deployment has no agent to run' };
  }
  const initialEvents = parseJsonArray(schedule.initial_events);
  if (initialEvents.length === 0) {
    return {
      type: 'session_creation_rejected_error',
      message: 'deployment has no initial_events; update it before it can run',
    };
  }
  if (schedule.environment_id) {
    const env = db.prepare('SELECT id, archived_at FROM environments WHERE id = ?').get(schedule.environment_id) as { id: string; archived_at: string | null } | undefined;
    if (!env) {
      return { type: 'environment_not_found_error', message: `Environment not found: ${schedule.environment_id}` };
    }
    if (env.archived_at) {
      return { type: 'environment_archived_error', message: `Environment ${schedule.environment_id} is archived` };
    }
  }
  for (const vaultId of parseJsonArray(schedule.vault_ids)) {
    const vault = db.prepare('SELECT id, archived_at FROM credential_vaults WHERE id = ?').get(String(vaultId)) as { id: string; archived_at: string | null } | undefined;
    if (!vault) {
      return { type: 'vault_not_found_error', message: `Credential vault not found: ${String(vaultId)}` };
    }
    if (vault.archived_at) {
      return { type: 'vault_archived_error', message: `Credential vault ${String(vaultId)} is archived` };
    }
  }
  for (const resource of parseJsonArray(schedule.resources)) {
    if (!resource || typeof resource !== 'object') continue;
    const record = resource as Record<string, unknown>;
    if (record.type === 'file' && typeof record.file_id === 'string') {
      const file = db.prepare('SELECT id, archived_at FROM files WHERE id = ?').get(record.file_id) as { id: string; archived_at: string | null } | undefined;
      if (!file || file.archived_at) {
        return { type: 'file_not_found_error', message: `File not found: ${record.file_id}` };
      }
    }
    if (record.type === 'memory_store' && typeof record.memory_store_id === 'string') {
      const store = db.prepare('SELECT id, archived_at FROM memory_stores WHERE id = ?').get(record.memory_store_id) as { id: string; archived_at: string | null } | undefined;
      if (store?.archived_at) {
        return { type: 'memory_store_archived_error', message: `Memory store ${record.memory_store_id} is archived` };
      }
    }
  }
  return null;
}

/**
 * The agent a deployment is bound to, or `null` when it is gone.
 *
 * "Gone" covers both a row that was never there and an archived one: the
 * published rule auto-archives the deployment when its agent is archived, and
 * a missing agent can never produce a run for the same reason, so the two
 * share the archive rather than diverging into a run that only says "the row
 * is missing".
 */
function deploymentAgentStillExists(db: Database, agentId: string | null): boolean {
  if (!agentId) return false;
  const row = db.prepare('SELECT id, status, archived_at FROM agents WHERE id = ?').get(agentId) as { id: string; status: string; archived_at: string | null } | undefined;
  return !!row && row.status !== 'archived' && !row.archived_at;
}

/**
 * Attempt one trigger of a deployment.
 *
 * The contract's three outcomes, in order:
 *
 * 1. The deployment's agent is gone — archived or deleted — so the deployment
 *    itself is archived and no run is recorded. A run would only ever say
 *    "the agent is missing", which the archived deployment already says.
 * 2. Session creation failed. A run row records the classified `error.type`
 *    and message, and unless the failure is one the next fire can outlive —
 *    `session_rate_limited_error` — the deployment is paused with
 *    `paused_reason: {type: 'error', error}`.
 * 3. The session exists. A run row records it, and the deployment's
 *    `last_run_at`/`next_run_at` advance. `last_run_at` only moves on timed
 *    runs — the published schedule field reports the most recent *scheduled*
 *    start, so a manual `run` must not overwrite it.
 *
 * The session is created through `createWithInitialEvents` with the
 * deployment's stored configuration — the same entry point `POST /v1/sessions`
 * uses — so a triggered session starts executing its `initial_events` rather
 * than sitting idle, and its resources, vaults, budget, and pinned agent
 * version are the ones the deployment declared.
 */
export function runSchedule(
  db: Database,
  sessionManager: SessionManager,
  schedule: ScheduleRow,
  triggerType: string,
  startedAtDate: Date = new Date(),
  random?: () => number,
): ScheduleRunOutcome {
  const runId = `drun_${nanoid(18)}`;
  const startedAt = startedAtDate.toISOString();
  const timeZone = scheduleTimeZone(schedule);
  const nextRun = schedule.cron
    ? nextCronRun(schedule.cron, startedAtDate, timeZone)?.toISOString() ?? null
    : null;
  // The cron instant this run answered. For a timed trigger it is the due
  // `next_run_at` the pass matched on; for a manual run there is none.
  const scheduledAt = triggerType === 'scheduled' ? (schedule.next_run_at ?? startedAt) : null;

  if (!deploymentAgentStillExists(db, schedule.agent_id)) {
    db.prepare(
      `UPDATE scheduled_deployments
       SET archived_at = COALESCE(archived_at, ?), updated_at = ?
       WHERE id = ?`,
    ).run(new Date().toISOString(), new Date().toISOString(), schedule.id);
    return { run: null, archivedDeployment: true };
  }

  const recordRun = (
    sessionId: string | null,
    failure: { type: string; message: string } | null,
  ): SchedulerRunResult => {
    db.prepare(
      `INSERT INTO scheduled_deployment_runs (
        id, schedule_id, session_id, status, trigger_type, payload, error,
        scheduled_at, error_type, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      schedule.id,
      sessionId,
      failure ? 'failed' : 'created_session',
      triggerType,
      JSON.stringify(parseJsonArray(schedule.initial_events)),
      failure?.message ?? null,
      scheduledAt,
      failure?.type ?? null,
      startedAt,
      new Date().toISOString(),
    );
    return db.prepare('SELECT * FROM scheduled_deployment_runs WHERE id = ?').get(runId) as SchedulerRunResult;
  };

  let sessionId: string | null = null;
  let failure = classifyTriggerFailure(db, schedule);
  if (!failure) {
    try {
      const session = sessionManager.createWithInitialEvents({
        agent: schedule.agent_id,
        ...(typeof schedule.agent_version === 'number' ? { agentVersion: schedule.agent_version } : {}),
        environmentId: schedule.environment_id ?? undefined,
        title: deploymentRunTitle(schedule),
        resources: parseJsonArray(schedule.resources) as Array<Record<string, unknown>>,
        vaultIds: parseJsonArray(schedule.vault_ids).map(String),
        contextId: memoryScopeFromDeploymentResources(schedule.resources),
        metadata: {
          scheduled_deployment_id: schedule.id,
          deployment_id: schedule.id,
          scheduled_deployment_run_id: runId,
          deployment_run_id: runId,
          trigger_type: triggerType,
        },
        ...(schedule.budget ? { budget: parseObject(schedule.budget) as never } : {}),
      }, parseJsonArray(schedule.initial_events) as never[]);
      sessionId = session.id;
    } catch (err) {
      failure = { type: 'unknown_error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  const run = recordRun(sessionId, failure);
  const pause = failure !== null && !RECOVERABLE_RUN_ERRORS.has(failure.type);
  // The fire instant tracks the schedule instant the run just armed: a timed
  // run re-draws jitter for the new `next_run_at`, a paused or manual-only
  // deployment carries none so the due pass leaves it alone. `last_run_at`
  // anchors the interval this next run fires into.
  const nextDueAt = pause || !schedule.cron || !nextRun
    ? null
    : new Date(
        Date.parse(nextRun) +
        deploymentRunJitterMs(
          Math.max(0, Date.parse(nextRun) - Date.parse(startedAt)),
          random,
        ),
      ).toISOString();
  db.prepare(
    `UPDATE scheduled_deployments
     SET last_run_at = ?, next_run_at = ?, due_at = ?, status = ?, paused_reason = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    triggerType === 'scheduled' ? startedAt : schedule.last_run_at ?? null,
    nextRun,
    nextDueAt,
    pause ? 'paused' : schedule.status ?? 'active',
    pause ? JSON.stringify({ type: 'error', error: { type: failure!.type, message: failure!.message } }) : null,
    new Date().toISOString(),
    schedule.id,
  );
  return { run, pausedDeployment: pause };
}

function parseJsonArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(typeof value === 'string' && value ? value : '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function deploymentRunTitle(schedule: ScheduleRow): string {
  const payloadTitle = parseObject(schedule.payload).title;
  return typeof payloadTitle === 'string' && payloadTitle.trim()
    ? payloadTitle.trim()
    : `Scheduled run: ${schedule.name}`;
}

function memoryScopeFromDeploymentResources(raw: unknown): string | undefined {
  for (const resource of parseJsonArray(raw)) {
    const record = resource as Record<string, unknown> | null;
    if (record?.type === 'memory_store' && typeof record.memory_store_id === 'string') {
      return record.memory_store_id;
    }
  }
  return undefined;
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
  agent_version?: number | null;
  environment_id: string | null;
  cron: string | null;
  payload: string;
  status?: string;
  last_run_at?: string | null;
  next_run_at?: string | null;
  due_at?: string | null;
  initial_events?: string;
  resources?: string;
  vault_ids?: string;
  budget?: string | null;
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
