/**
 * Unit test: how the two day fields combine in a cron expression.
 *
 * `cron.ts:230-239` states the rule and names its source: "POSIX cron: when both
 * day fields are restricted, a day matching either one is selected; when only one
 * is restricted, only that one matters." It is the rule most often read backwards,
 * because the intuitive reading is a conjunction - "the 1st, and Mondays" - while
 * POSIX selects the union.
 *
 * The difference is not cosmetic for a scheduled deployment. `0 0 1 * 1` under the
 * published rule fires weekly (every Monday, plus the 1st of each month); under the
 * conjunction it fires only on a 1st that happens to be a Monday - roughly once
 * every seven years for a given month - so a deployment would look scheduled and
 * almost never run.
 *
 * Nothing in the suite named either field before this file: a repository-wide search
 * for the day-of-month and day-of-week field names returns no test at all, so all
 * four branches of that expression - both restricted, one restricted, the other
 * restricted, neither - were unasserted.
 */

import { describe, expect, it } from 'vitest';
import { nextCronRun, upcomingCronRuns } from '@/core/operations/cron.js';

/** A Thursday, at midday, so the next midnight is unambiguous in UTC. */
const AFTER = new Date('2026-09-24T12:00:00.000Z');

function runs(expression: string, count: number): string[] {
  return upcomingCronRuns(expression, AFTER, 'UTC', count).map((date) => date.toISOString());
}

describe('cron day-of-month and day-of-week', () => {
  it('selects the union when both day fields are restricted', () => {
    // `0 0 1 * 1`: midnight on the 1st, or on any Monday. The two expected instants
    // below are exactly the discriminating pair - 2026-09-28 is a Monday that is not
    // the 1st, and 2026-10-01 is the 1st that is not a Monday - so a conjunction
    // cannot produce this list.
    expect(runs('0 0 1 * 1', 6)).toEqual([
      '2026-09-28T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
      '2026-10-05T00:00:00.000Z',
      '2026-10-12T00:00:00.000Z',
      '2026-10-19T00:00:00.000Z',
      '2026-10-26T00:00:00.000Z',
    ]);

    // The same claim as a property, so the rule is asserted rather than only the
    // six instants: every run satisfies either field, and both one-sided kinds occur.
    const weekdays = upcomingCronRuns('0 0 1 * 1', AFTER, 'UTC', 6);
    const domOnly = weekdays.filter((date) => date.getUTCDate() === 1 && date.getUTCDay() !== 1);
    const dowOnly = weekdays.filter((date) => date.getUTCDay() === 1 && date.getUTCDate() !== 1);
    expect(domOnly.length).toBeGreaterThan(0);
    expect(dowOnly.length).toBeGreaterThan(0);
    for (const date of weekdays) {
      expect(date.getUTCDate() === 1 || date.getUTCDay() === 1).toBe(true);
    }
  });

  it('lets only the day of month matter when only that field is restricted', () => {
    // The Monday 2026-09-28 sits between the reference and the next 1st, and must not
    // be selected: with the weekday field left as `*`, it takes no part.
    expect(runs('0 0 1 * *', 3)).toEqual([
      '2026-10-01T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
      '2026-12-01T00:00:00.000Z',
    ]);
  });

  it('lets only the day of week matter when only that field is restricted', () => {
    // Mirror of the case above: the 1st of October falls between two Mondays and must
    // not be selected when the day-of-month field is `*`.
    expect(runs('0 0 * * 1', 3)).toEqual([
      '2026-09-28T00:00:00.000Z',
      '2026-10-05T00:00:00.000Z',
      '2026-10-12T00:00:00.000Z',
    ]);
  });

  it('selects every day when neither day field is restricted', () => {
    expect(runs('0 0 * * *', 3)).toEqual([
      '2026-09-25T00:00:00.000Z',
      '2026-09-26T00:00:00.000Z',
      '2026-09-27T00:00:00.000Z',
    ]);
    expect(nextCronRun('0 0 * * *', AFTER, 'UTC')?.toISOString()).toBe('2026-09-25T00:00:00.000Z');
  });
});
