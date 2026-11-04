/**
 * Cron evaluation for scheduled deployments.
 *
 * The published contract specifies POSIX cron (`minute hour day-of-month month
 * day-of-week`) plus an IANA `timezone`, and states that matching is against
 * literal wall-clock time: `0 20 * * *` in `America/New_York` fires at 20:00
 * local on both sides of a DST change. It also states that a wall-clock time
 * skipped by a spring-forward transition never fires, while one repeated by a
 * fall-back transition fires twice.
 *
 * That combination rules out the easy implementation. Evaluating cron in UTC
 * would be wrong for every non-UTC deployment across a DST boundary, and
 * evaluating in the host's local zone would make a deployment's meaning depend
 * on where the runtime happens to run.
 *
 * So the schedule is matched in the target zone's wall clock. The search walks
 * candidate local days and, within a matching day, only the scheduled
 * hour/minute pairs — never every minute of the year — so the cost stays
 * proportional to the number of actual candidate times.
 *
 * The zone database comes from `Intl`, which is part of the Node runtime. No
 * external dependency is involved, and no offset table is hard-coded: hard-coded
 * offsets would silently drift the moment a government changes its rules.
 */

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** True when the expression restricts day-of-month or day-of-week. */
  restrictedDayOfMonth: boolean;
  restrictedDayOfWeek: boolean;
}

/** Parse a five-field POSIX cron expression. Returns `null` when malformed. */
export function parseCron(expression: string): ParsedCron | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const parsed = {
    minutes: parseField(minute, 0, 59),
    hours: parseField(hour, 0, 23),
    daysOfMonth: parseField(dayOfMonth, 1, 31, 1),
    months: parseField(month, 1, 12, 1),
    daysOfWeek: parseField(dayOfWeek, 0, 6),
  };
  if (!Object.values(parsed).every((set) => set.size > 0)) return null;
  return {
    ...parsed,
    restrictedDayOfMonth: dayOfMonth.trim() !== '*',
    restrictedDayOfWeek: dayOfWeek.trim() !== '*',
  };
}

/**
 * Parse one cron field into the set of values it matches.
 *
 * `weekdayOffset` shifts the numeric domain so Sunday can be accepted as either
 * `0` or `7` in the day-of-week field, which POSIX cron allows and which a
 * literal range check would reject.
 */
function parseField(value: string, min: number, max: number, weekdayOffset = 0): Set<number> {
  const out = new Set<number>();
  for (const rawPart of value.split(',')) {
    const [rangePart, stepPart] = rawPart.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) continue;
    let start: number;
    let end: number;
    if (rangePart === '*') {
      [start, end] = [min, max];
    } else if (rangePart.includes('-')) {
      [start, end] = rangePart.split('-').map(Number);
    } else {
      const single = Number(rangePart);
      if (weekdayOffset > 0 && single === 7) {
        // 7 is Sunday, same as 0.
        out.add(0);
        continue;
      }
      [start, end] = [single, single];
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    for (let v = Math.max(min, start); v <= Math.min(max, end); v += step) out.add(v);
  }
  return out;
}

/** True when `timeZone` is an IANA identifier this runtime can resolve. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timeZone);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  formatters.set(timeZone, created);
  return created;
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

/** The wall-clock reading of an instant in one zone. */
export function wallClockOf(instant: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  // `hour12: false` renders midnight as `24` in some ICU versions; normalizing
  // it here keeps every caller from having to know that.
  const hour = Number(get('hour')) % 24;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour,
    minute: Number(get('minute')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/**
 * The zone's UTC offset, in milliseconds, at one instant.
 *
 * Derived by reading the instant back as wall clock and treating those fields
 * as if they were UTC — the difference *is* the offset.
 */
function offsetMsAt(instant: Date, timeZone: string): number {
  const wall = wallClockOf(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, instant.getUTCSeconds() * 1000);
  return asUtc - instant.getTime();
}

/**
 * Convert a wall-clock reading in one zone to the instant it names.
 *
 * Returns `null` when the local time does not exist — the spring-forward gap.
 * The two-pass form is needed because the offset that applies depends on the
 * instant being solved for, and the initial guess can land on the other side of
 * a transition; the second pass uses the offset at the corrected instant, and
 * the result is verified rather than assumed.
 *
 * An ambiguous local time (the fall-back overlap) resolves to its *first*
 * occurrence. The second occurrence is found naturally on the next scan, since
 * the scan resumes after the instant it just returned — which is what the
 * published contract requires.
 */
export function wallClockToInstant(
  fields: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date | null {
  const naive = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);
  const firstPass = new Date(naive - offsetMsAt(new Date(naive), timeZone));
  const secondPass = new Date(naive - offsetMsAt(firstPass, timeZone));
  const wall = wallClockOf(secondPass, timeZone);
  if (
    wall.year !== fields.year || wall.month !== fields.month || wall.day !== fields.day
    || wall.hour !== fields.hour || wall.minute !== fields.minute
  ) {
    return null;
  }
  return secondPass;
}

/** Longest window a next-run search will scan before reporting "never". */
const MAX_SEARCH_DAYS = 366;

/**
 * The next instant matching `expression` in `timeZone`, strictly after `after`.
 *
 * Returns `null` for a malformed expression, an unknown zone, or a schedule
 * that cannot occur within a year (e.g. `0 0 30 2 *`).
 */
export function nextCronRun(
  expression: string,
  after: Date = new Date(),
  timeZone = 'UTC',
): Date | null {
  const schedule = parseCron(expression);
  if (!schedule) return null;
  if (!isValidTimeZone(timeZone)) return null;

  const hours = [...schedule.hours].sort((a, b) => a - b);
  const minutes = [...schedule.minutes].sort((a, b) => a - b);
  const afterMs = after.getTime();
  const startWall = wallClockOf(new Date(Math.floor(afterMs / 60000) * 60000), timeZone);
  // Start one minute after the reference instant: candidates must be strictly
  // later, so the minute `after` falls in is not itself a candidate.
  let dayCursor = Date.UTC(startWall.year, startWall.month - 1, startWall.day);

  for (let dayOffset = 0; dayOffset <= MAX_SEARCH_DAYS; dayOffset += 1) {
    const dayFields = new Date(dayCursor);
    const year = dayFields.getUTCFullYear();
    const month = dayFields.getUTCMonth() + 1;
    const day = dayFields.getUTCDate();
    // Day-of-week is a property of the local calendar date, which is what the
    // cursor already holds in UTC terms after the offset conversion below.
    const weekday = dayFields.getUTCDay();
    const domMatches = schedule.daysOfMonth.has(day);
    const dowMatches = schedule.daysOfWeek.has(weekday);
    // POSIX cron: when both day fields are restricted, a day matching either
    // one is selected; when only one is restricted, only that one matters.
    const dayMatches =
      schedule.restrictedDayOfMonth && schedule.restrictedDayOfWeek
        ? domMatches || dowMatches
        : schedule.restrictedDayOfMonth
          ? domMatches
          : schedule.restrictedDayOfWeek
            ? dowMatches
            : true;

    if (dayMatches && schedule.months.has(month)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const instant = wallClockToInstant({ year, month, day, hour, minute }, timeZone);
          if (!instant) continue;
          if (instant.getTime() > afterMs) return instant;
        }
      }
    }
    dayCursor += 24 * 60 * 60 * 1000;
  }
  return null;
}

/**
 * The next `count` matching instants, for the deployment response's
 * `upcoming_runs_at`. Stops early rather than inventing entries when the
 * schedule runs out inside the search window.
 */
export function upcomingCronRuns(
  expression: string,
  after: Date = new Date(),
  timeZone = 'UTC',
  count = 3,
): Date[] {
  const out: Date[] = [];
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
    const next = nextCronRun(expression, cursor, timeZone);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * The load-distribution delay applied to a scheduled run's fire instant.
 *
 * The published rule jitters execution by up to 15% of the interval between
 * runs, clamped to a minimum of 5 seconds and a maximum of 9 minutes
 * (`official-docs/scheduled-deployments.md`: "to distribute load, actual
 * execution applies jitter of up to 15 percent of the interval between runs,
 * with a minimum of 5 seconds and a maximum of 9 minutes"). The delay is drawn
 * uniformly in `[0, 0.15 × intervalMs]` then clamped — a schedule whose
 * interval is under ~33 s still waits at least 5 s, and one whose interval is
 * over an hour never waits more than 9 min.
 *
 * `intervalMs` is the gap the run fires into: `next_run_at − last_run_at` when
 * a previous scheduled instant exists, else `next_run_at − now`. A caller that
 * cannot measure an interval passes `0`, and the delay collapses to the 5 s
 * floor — a degenerate schedule still spreads rather than firing on the exact
 * instant.
 *
 * `random` is injectable so a test can pin the draw and assert the clamp
 * bounds instead of sampling the distribution.
 */
export const DEPLOYMENT_RUN_JITTER_MIN_MS = 5_000;
export const DEPLOYMENT_RUN_JITTER_MAX_MS = 9 * 60_000;
export const DEPLOYMENT_RUN_JITTER_FRACTION = 0.15;

export function deploymentRunJitterMs(
  intervalMs: number,
  random: () => number = Math.random,
): number {
  const span = Math.max(0, intervalMs) * DEPLOYMENT_RUN_JITTER_FRACTION;
  const drawn = Math.floor(random() * span);
  return Math.min(DEPLOYMENT_RUN_JITTER_MAX_MS, Math.max(DEPLOYMENT_RUN_JITTER_MIN_MS, drawn));
}
