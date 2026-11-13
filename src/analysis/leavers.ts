import { addDays } from '../common/year-rollover';
import type { LoadDuty } from '../staffing/teacher-load';

/*
 * Den som har slutat, eller varit borta, i ett löneunderlag.
 *
 * A löneunderlag books time on a person, so it must not book a person for the time they were inactive.
 * UserDeactivations (20270210090000) has a row for every period a person has been inactive: from `startsAt`,
 * the administrator's click or the last working day they named, to `endsAt`, the moment the person was made
 * active again (null while they are inactive). Users.deactivatedAt, which this module read before, is the
 * latest click and is cleared by a return, so a person who came back was counted for the weeks between
 * (LÅG-1 of the review of #280), and it could not be backdated, so the days between a last day and the click
 * were booked (LÅG-2).
 *
 * The rule for lessons is D6's: a lesson counts to a teacher only if the teacher was active when it was over,
 * which is `endsAt <= startsAt` for a person who is still away and now also holds for one who returned: a
 * lesson over at the very instant they left counts, one over strictly inside a period does not, and one over
 * at the instant they returned counts. D6 wrote that for its statistics (app.absence_stats_lessons asks the
 * same question of the same table); statement E asks it through `staffingCreditStatement`'s `away`, and a
 * vikarie's covers are lessons too.
 *
 * Uppdrag are not lessons, they run by the day, and a person's rastvaktspass already stops on the DAY BEFORE
 * the school's date of the stamp (load-input.ts, `chargedShift`: "a deactivated teacher's pass is charged
 * until the day before"). The stored uppdrag (mentorskap, ämnesansvar) stop the same day, so that the two
 * kinds of uppdrag of one person end together; a lesson held that morning is the person's, a day's share of
 * an uppdrag is not charged for the day they left. (BESLUT.) A return counts the same way from the other
 * side: the days charged again start with the school's date of `endsAt`, the day the person is active at
 * its end, so a person who left and came back the same day loses no day.
 *
 * A person is asked about only if some period of theirs reaches the days of the payroll period
 * (`touches`); everyone else is counted as they always were.
 *
 * PURE.
 */

/** One period a person was inactive, with the school's date of each end. */
export interface AwayPeriod {
  /** `startsAt`: the instant their time stops counting. */
  from: Date;
  /** `endsAt`: the instant it counts again; null while they are inactive. */
  to: Date | null;
  /** The school's date of `from`. */
  fromDay: string;
  /** The school's date of `to`; null while they are inactive. */
  toDay: string | null;
}

/** A person with every period they have been inactive, in order. */
export interface Leaver {
  userId: string;
  periods: AwayPeriod[];
}

/**
 * The people in `rows`, each with their periods in order. The school's date comes from the caller (its
 * timezone). A person without a row is not a leaver and is not in the map.
 */
export function leaversOf(
  rows: readonly { userId: string; startsAt: Date; endsAt: Date | null }[],
  schoolDay: (at: Date) => string,
): Map<string, Leaver> {
  const leavers = new Map<string, Leaver>();
  for (const row of rows) {
    const leaver = leavers.get(row.userId) ?? { userId: row.userId, periods: [] };
    leaver.periods.push({
      from: row.startsAt,
      to: row.endsAt,
      fromDay: schoolDay(row.startsAt),
      toDay: row.endsAt === null ? null : schoolDay(row.endsAt),
    });
    leavers.set(row.userId, leaver);
  }
  for (const leaver of leavers.values()) leaver.periods.sort((a, b) => a.from.getTime() - b.from.getTime());
  return leavers;
}

/** Was the person inactive at the instant? At the very instant they left, and at the one they returned, they were not. */
export function awayAt(leaver: Leaver, at: Date): boolean {
  const time = at.getTime();
  return leaver.periods.some((period) => period.from.getTime() < time && (period.to === null || time < period.to.getTime()));
}

/**
 * Does any period of the person reach the days of the payroll period? Then their time is cut (or, when the
 * whole period is inside one, gone). A person whose every period ended before the period began, or began after
 * its last day, is counted as they always were.
 */
export function touches(leaver: Leaver, from: string, to: string): boolean {
  return leaver.periods.some((period) => period.fromDay <= to && (period.toDay === null || period.toDay >= from));
}

/** True when one period covers every day of the payroll period, so that no lesson in it can have been over while the person was active. */
export function awayAllPeriod(leaver: Leaver, from: string, to: string): boolean {
  return leaver.periods.some((period) => period.fromDay < from && (period.toDay === null || period.toDay > to));
}

/** The periods as statement E asks them (`away`); the instants only. */
export function awayInstants(leaver: Leaver): { from: Date; to: Date | null }[] {
  return leaver.periods.map((period) => ({ from: period.from, to: period.to }));
}

/**
 * The days a period holds that an uppdrag is not charged for: from the school's date of `from` to the day before
 * the school's date of `to`, or without an end while the person is inactive. Empty when the person left and
 * returned the same day.
 */
function chargedOff(period: AwayPeriod): { from: string; to: string } | null {
  if (period.toDay === null) return { from: period.fromDay, to: '9999-12-31' };
  const last = addDays(period.toDay, -1);
  return last < period.fromDay ? null : { from: period.fromDay, to: last };
}

/**
 * The uppdrag with every day a leaver was inactive taken out. An uppdrag the leaver's periods do not reach is
 * the object it was; one they cut from the end is the same uppdrag with an earlier `validTo`; one with a gap in
 * the middle is two, each with the same weekly minutes. `yearEnd` stands in for a missing `validTo`, as
 * everywhere in the load's pure half.
 */
export function cutDuties(duties: readonly LoadDuty[], leavers: ReadonlyMap<string, Leaver>, yearEnd: string): LoadDuty[] {
  const result: LoadDuty[] = [];
  for (const duty of duties) {
    const leaver = leavers.get(duty.userId);
    const off = leaver ? leaver.periods.map(chargedOff).filter((range): range is { from: string; to: string } => range !== null) : [];
    if (off.length === 0) {
      result.push(duty);
      continue;
    }
    let pieces: { validFrom?: string | null; validTo?: string | null }[] = [
      { ...(duty.validFrom !== undefined ? { validFrom: duty.validFrom } : {}), ...(duty.validTo !== undefined ? { validTo: duty.validTo } : {}) },
    ];
    let changed = false;
    for (const range of off) {
      const next: typeof pieces = [];
      for (const piece of pieces) {
        const start = piece.validFrom ?? '0000-01-01';
        const end = piece.validTo ?? yearEnd;
        if (range.to < start || range.from > end) {
          next.push(piece);
          continue;
        }
        changed = true;
        if (start < range.from) next.push({ ...(piece.validFrom !== undefined ? { validFrom: piece.validFrom } : {}), validTo: addDays(range.from, -1) });
        if (range.to < end) {
          next.push({ validFrom: addDays(range.to, 1), ...(piece.validTo !== undefined ? { validTo: piece.validTo } : {}) });
        }
      }
      pieces = next;
    }
    if (!changed) {
      result.push(duty);
      continue;
    }
    for (const piece of pieces) {
      const { validFrom: _from, validTo: _to, ...rest } = duty;
      result.push({ ...rest, ...piece });
    }
  }
  return result;
}

/** A vikarie's cover is a lesson: it counts only if it was over while they were active. */
export function coverStands(row: { userId: string; endsAt: string }, leavers: ReadonlyMap<string, Leaver>): boolean {
  const leaver = leavers.get(row.userId);
  return !leaver || !awayAt(leaver, new Date(Date.parse(row.endsAt)));
}
