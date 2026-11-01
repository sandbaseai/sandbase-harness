import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { armDeploymentDueAt, nextCronRun, runDueScheduledDeployments } from '@/core/operations/scheduler.js';
import {
  DEPLOYMENT_RUN_JITTER_MAX_MS,
  DEPLOYMENT_RUN_JITTER_MIN_MS,
  deploymentRunJitterMs,
} from '@/core/operations/cron.js';

describe('scheduled deployment runner', () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-sched-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'Default', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_echo', 'echo', '{"name":"echo","model":"default"}')`);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('computes the next cron run in UTC', () => {
    expect(nextCronRun('*/15 * * * *', new Date('2026-07-23T10:07:30Z'))?.toISOString()).toBe('2026-07-23T10:15:00.000Z');
    expect(nextCronRun('0 9 * * 1', new Date('2026-07-20T09:00:00Z'))?.toISOString()).toBe('2026-07-27T09:00:00.000Z');
  });

  it('runs due schedules and advances next_run_at', async () => {
    db.prepare(
      `INSERT INTO scheduled_deployments (
        id, name, agent_id, environment_id, cron, payload, status, next_run_at, initial_events, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'sched_due',
      'Due schedule',
      'agent_echo',
      'env_default',
      '*/5 * * * *',
      JSON.stringify({ title: 'Due schedule session' }),
      'active',
      '2026-07-23T10:00:00.000Z',
      JSON.stringify([{ type: 'user.message', content: [{ type: 'text', text: 'run' }] }]),
      '2026-07-23T09:00:00.000Z',
      '2026-07-23T09:00:00.000Z',
    );

    const runs = await runDueScheduledDeployments(db, new SessionManager(db), { now: new Date('2026-07-23T10:01:00.000Z') });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ schedule_id: 'sched_due', status: 'created_session', trigger_type: 'scheduled' });
    const schedule = db.prepare('SELECT next_run_at, last_run_at FROM scheduled_deployments WHERE id = ?').get('sched_due') as { next_run_at: string; last_run_at: string };
    expect(schedule.last_run_at).toBe('2026-07-23T10:01:00.000Z');
    expect(schedule.next_run_at).toBe('2026-07-23T10:05:00.000Z');
  });
});

describe('deployment run jitter', () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-jitter-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'Default', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_echo', 'echo', '{"name":"echo","model":"default"}')`);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertSchedule(id: string, nextRunAt: string, lastRunAt: string | null = null): void {
    db.prepare(
      `INSERT INTO scheduled_deployments (
        id, name, agent_id, environment_id, cron, payload, status, next_run_at, last_run_at, initial_events, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, id, 'agent_echo', 'env_default', '0 * * * *',
      JSON.stringify({ title: `${id} session` }), 'active', nextRunAt, lastRunAt,
      JSON.stringify([{ type: 'user.message', content: [{ type: 'text', text: 'run' }] }]),
      '2026-07-23T09:00:00.000Z', '2026-07-23T09:00:00.000Z',
    );
  }

  it('clamps the drawn delay to the published 5 s–9 min bounds', () => {
    // A degenerate (zero or negative) interval collapses to the floor, and a
    // long interval never draws past the 9-minute ceiling.
    expect(deploymentRunJitterMs(0, () => 0.5)).toBe(DEPLOYMENT_RUN_JITTER_MIN_MS);
    expect(deploymentRunJitterMs(-1000, () => 0.5)).toBe(DEPLOYMENT_RUN_JITTER_MIN_MS);
    expect(deploymentRunJitterMs(60 * 60_000, () => 1)).toBe(DEPLOYMENT_RUN_JITTER_MAX_MS);
    // Mid-interval draws scale with the schedule and stay inside the bounds.
    const hourly = deploymentRunJitterMs(60 * 60_000, () => 0.5);
    expect(hourly).toBeGreaterThanOrEqual(DEPLOYMENT_RUN_JITTER_MIN_MS);
    expect(hourly).toBeLessThanOrEqual(DEPLOYMENT_RUN_JITTER_MAX_MS);
    expect(hourly).toBe(Math.floor(0.5 * 0.15 * 60 * 60_000));
  });

  it('does not run a schedule before its jittered due_at, then runs it at due_at', async () => {
    // Interval is one hour (last → next), so the drawn jitter is meaningful:
    // random()=0.5 → 0.5·0.15·3600000 = 270000 ms = 4.5 min after next_run_at.
    insertSchedule('sched_j', '2026-07-23T10:00:00.000Z', '2026-07-23T09:00:00.000Z');

    const manager = new SessionManager(db);
    // Just after the scheduled instant but before the jittered due_at: no run.
    const early = await runDueScheduledDeployments(db, manager, {
      now: new Date('2026-07-23T10:01:00.000Z'),
      random: () => 0.5,
    });
    expect(early).toHaveLength(0);
    // The armed due_at is the scheduled instant + the drawn jitter.
    const armed = db.prepare('SELECT next_run_at, due_at FROM scheduled_deployments WHERE id = ?').get('sched_j') as { next_run_at: string; due_at: string };
    expect(armed.next_run_at).toBe('2026-07-23T10:00:00.000Z');
    expect(armed.due_at).toBe('2026-07-23T10:04:30.000Z');

    // At the jittered instant the run fires; started_at records the actual
    // (delayed) start while scheduled_at keeps the cron instant it answered.
    const runs = await runDueScheduledDeployments(db, manager, {
      now: new Date('2026-07-23T10:04:30.000Z'),
      random: () => 0.5,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ schedule_id: 'sched_j', scheduled_at: '2026-07-23T10:00:00.000Z', started_at: '2026-07-23T10:04:30.000Z' });
  });

  it('re-arms due_at when next_run_at advances, without touching the displayed schedule', async () => {
    insertSchedule('sched_re', '2026-07-23T10:00:00.000Z', '2026-07-23T09:00:00.000Z');
    const manager = new SessionManager(db);
    await runDueScheduledDeployments(db, manager, {
      now: new Date('2026-07-23T10:05:00.000Z'),
      random: () => 0.5,
    });
    const schedule = db.prepare('SELECT next_run_at, due_at FROM scheduled_deployments WHERE id = ?').get('sched_re') as { next_run_at: string; due_at: string };
    // next_run_at is still the bare schedule instant (hourly cron → 11:00);
    // due_at carries the new jitter for the interval it now anchors (10→11h).
    expect(schedule.next_run_at).toBe('2026-07-23T11:00:00.000Z');
    expect(Date.parse(schedule.due_at)).toBeGreaterThanOrEqual(Date.parse(schedule.next_run_at));
    expect(Date.parse(schedule.due_at)).toBeLessThanOrEqual(Date.parse(schedule.next_run_at) + DEPLOYMENT_RUN_JITTER_MAX_MS);
  });

  it('advances a timed run off the answered instant, never double-firing one instant', async () => {
    // A timed run fires at `due_at` = `next_run_at` + jitter, so its start is
    // already inside the interval it consumed. The next `next_run_at` is
    // searched from `max(scheduled_at, startedAt)` — the answered instant, or
    // the actual start when the run fired long late — so the successor is
    // always the instant after the one just answered and never the same one
    // again. For a sub-hour cadence the jittered fire can land across a
    // boundary; the run still answers one instant and re-arms to the next,
    // so no instant is fired twice and none is re-armed into the past.
    const manager = new SessionManager(db);
    insertSchedule('sched_min', '2026-07-23T10:00:00.000Z', '2026-07-23T09:59:00.000Z');
    // Drive the ticks one minute apart with a heavy jitter draw.
    for (let minute = 0; minute < 8; minute++) {
      await runDueScheduledDeployments(db, manager, {
        now: new Date(Date.UTC(2026, 6, 23, 10, minute) + 1_000),
        random: () => 0.99,
      });
    }
    const instants = db
      .prepare(`SELECT scheduled_at FROM scheduled_deployment_runs WHERE schedule_id = 'sched_min' ORDER BY scheduled_at`)
      .all() as Array<{ scheduled_at: string }>;
    // Each recorded scheduled instant is distinct — the run that answered it
    // always advances `next_run_at` to a strictly later instant.
    expect(new Set(instants.map((row) => row.scheduled_at)).size).toBe(instants.length);
    // And `next_run_at` never sits behind the last fired instant.
    const row = db.prepare('SELECT next_run_at FROM scheduled_deployments WHERE id = ?').get('sched_min') as { next_run_at: string };
    const last = instants[instants.length - 1];
    if (last) expect(Date.parse(row.next_run_at)).toBeGreaterThan(Date.parse(last.scheduled_at));
  });

  it('leaves the armed schedule untouched by a manual run inside the jitter window', async () => {
    // An hourly deployment is armed to fire at 10:00 + jitter (10:04:30 with a
    // 0.5 draw). A manual run at 10:02 fires outside the cadence: it must not
    // consume the pending 10:00 instant, which still fires at its due_at.
    insertSchedule('sched_man', '2026-07-23T10:00:00.000Z', '2026-07-23T09:00:00.000Z');
    const manager = new SessionManager(db);
    await runDueScheduledDeployments(db, manager, {
      now: new Date('2026-07-23T10:01:00.000Z'),
      random: () => 0.5,
    });

    const { runSchedule } = await import('@/core/operations/scheduler.js');
    runSchedule(
      db,
      manager,
      db.prepare('SELECT * FROM scheduled_deployments WHERE id = ?').get('sched_man') as never,
      'manual',
      new Date('2026-07-23T10:02:00.000Z'),
      () => 0.5,
    );
    // The manual run left next_run_at and the armed due_at alone.
    const afterManual = db.prepare('SELECT next_run_at, due_at FROM scheduled_deployments WHERE id = ?').get('sched_man') as { next_run_at: string; due_at: string };
    expect(afterManual.next_run_at).toBe('2026-07-23T10:00:00.000Z');
    expect(afterManual.due_at).toBe('2026-07-23T10:04:30.000Z');

    // The pending 10:00 instant still fires at its jittered due_at.
    const runs = await runDueScheduledDeployments(db, manager, {
      now: new Date('2026-07-23T10:05:00.000Z'),
      random: () => 0.5,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger_type: 'scheduled', scheduled_at: '2026-07-23T10:00:00.000Z' });
    // And it advances to the next hourly instant, having consumed 10:00.
    const schedule = db.prepare('SELECT next_run_at FROM scheduled_deployments WHERE id = ?').get('sched_man') as { next_run_at: string };
    expect(schedule.next_run_at).toBe('2026-07-23T11:00:00.000Z');
  });

  it('disarms due_at when the deployment is paused', async () => {
    insertSchedule('sched_p', '2026-07-23T10:00:00.000Z', '2026-07-23T09:00:00.000Z');
    const manager = new SessionManager(db);
    // Arm the row first so the pause has something to clear.
    await runDueScheduledDeployments(db, manager, {
      now: new Date('2026-07-23T10:01:00.000Z'),
      random: () => 0.5,
    });
    expect(db.prepare('SELECT due_at FROM scheduled_deployments WHERE id = ?').get('sched_p') as { due_at: string | null }).toHaveProperty('due_at', expect.any(String));
    db.prepare(`UPDATE scheduled_deployments SET status = 'paused' WHERE id = ?`).run('sched_p');
    armDeploymentDueAt(db, db.prepare('SELECT * FROM scheduled_deployments WHERE id = ?').get('sched_p') as never);
    expect(db.prepare('SELECT due_at FROM scheduled_deployments WHERE id = ?').get('sched_p')).toMatchObject({ due_at: null });
    // And a paused row does not fire even when its old due instant arrives.
    const runs = await runDueScheduledDeployments(db, manager, {
      now: new Date('2026-07-23T10:06:00.000Z'),
      random: () => 0.5,
    });
    expect(runs).toHaveLength(0);
  });
});
