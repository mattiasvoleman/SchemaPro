import { addDays } from '../common/year-rollover';
import type { LoadDuty } from '../staffing/teacher-load';

/*
 * Den som har slutat i ett löneunderlag.
 *
 * A löneunderlag books time on a person, so it must not book a person after the
 * day they left. `Users.deactivatedAt` is the moment `isActive` went false
 * (Users_deactivation_is_dated stamps it, so no writer can forget it), and the
 * rule for lessons is D6's: a lesson counts to a teacher only if the teacher had
 * not left when it was over, `endsAt <= deactivatedAt`. D6 wrote that for its
 * statistics (app.absence_stats_lessons); statement E asks the same question
 * through `staffingCreditStatement`'s `endedBy`, and a vikarie's covers are
 * lessons too.
 *
 * Uppdrag are not lessons, they run by the day, and a person's rastvaktspass
 * already stops on the DAY BEFORE the school's date of the stamp (load-input.ts,
 * `chargedShift`: "a deactivated teacher's pass is charged until the day before").
 * The stored uppdrag (mentorskap, ämnesansvar) stop the same day, so that the
 * two kinds of uppdrag of one person end together; a lesson held that morning
 * is the person's, a day's share of an uppdrag is not charged for the day they
 * left. (BESLUT.)
 *
 * A person who is made active again has no `deactivatedAt` any more (the same
 * trigger clears it), so they are counted as if they had never left: the
 * history of an earlier leave is not kept, here or in D6's statistics.
 *
 * PURE.
 */

export interface Leaver {
  userId: string;
  /** When the person was deactivated. */
  at: Date;
  /** The school's date of `at`. */
  day: string;
}

/** The people in `rows` who are inactive and dated; the school's date comes from the caller (its timezone). */
export function leaversOf(
  rows: readonly { id: string; deactivatedAt: Date | null }[],
  schoolDay: (at: Date) => string,
): Map<string, Leaver> {
  const leavers = new Map<string, Leaver>();
  for (const row of rows) {
    if (!(row.deactivatedAt instanceof Date)) continue;
    leavers.set(row.id, { userId: row.id, at: row.deactivatedAt, day: schoolDay(row.deactivatedAt) });
  }
  return leavers;
}

/**
 * Does the period reach the day the person left? Then their time is cut (or, when the whole period is
 * after it, gone). A person who left after the period's last day is counted as they always were.
 */
export function leftBy(leaver: Leaver, to: string): boolean {
  return leaver.day <= to;
}

/**
 * The days of the period to ask statement E about for a person who left by its end: up to and including the
 * school's date of the stamp (the instant rule, `endedBy`, drops what was over after it that day). Null when
 * the person left before the period began: nothing is asked.
 */
export function lessonDays(leaver: Leaver, from: string, to: string): { from: string; to: string } | null {
  if (leaver.day < from) return null;
  return { from, to: leaver.day < to ? leaver.day : to };
}

/** The uppdrag with each leaver's `validTo` cut to the day before the school's date of the stamp. */
export function cutDuties(duties: readonly LoadDuty[], leavers: ReadonlyMap<string, Leaver>, yearEnd: string): LoadDuty[] {
  return duties.map((duty) => {
    const leaver = leavers.get(duty.userId);
    if (!leaver) return duty;
    const last = addDays(leaver.day, -1);
    const validTo = duty.validTo ?? yearEnd;
    return validTo <= last ? duty : { ...duty, validTo: last };
  });
}

/** A vikarie's cover is a lesson: it counts only if it was over when they left. */
export function coverStands(row: { userId: string; endsAt: string }, leavers: ReadonlyMap<string, Leaver>): boolean {
  const leaver = leavers.get(row.userId);
  return !leaver || Date.parse(row.endsAt) <= leaver.at.getTime();
}
