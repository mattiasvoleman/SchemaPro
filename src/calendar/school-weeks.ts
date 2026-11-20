/**
 * Veckor utan skoldag: the weeks of a läsår in which no lesson is written.
 *
 * A week is without school when every weekday of it that lies in the läsår
 * (Monday to Friday, the engine's SCHEDULE_DAYS) is a day no årskurs has
 * school, which is noSchoolDays — the reading publish makes when it skips a
 * lesson on a lov or a studiedag (publish-days.ts, breakCoversGroup). Two
 * readers ask which weeks they are, and they must agree or a school is told
 * one thing by the generator and another by the board:
 *
 *   - the generator's periods (src/optimization/year-periods.ts), in which a
 *     week with no school day is no period to solve;
 *   - the clash readers (findConflicts, year-clashes.ts and the board's
 *     detectConflicts, web/lib/closed-weeks.ts is the browser's copy), which
 *     do not count two lessons as a double booking when the only weeks they
 *     can meet in are such weeks. A lesson of the autumn to the 10th of
 *     January and one of the spring from the 4th share a week, and the week is
 *     jullov: nobody sits either (meetOnlyInClosedWeeks).
 *
 * PURE except readClosedWeeks, which asks the database for what the rest needs.
 * Dates are 'YYYY-MM-DD' and compare as text.
 */
import type { PrismaClient } from '@prisma/client';
import type { YearSpan } from '../common/teacher-day';
import { isoWeekNumber } from './lesson-recurrence';
import { noSchoolDays, type PublishBreak } from './publish-days';

const DAY_MS = 86_400_000;

/** The weekdays the engine plans: Monday to Friday (SCHEDULE_DAYS in optimization-engine/app/config.py). */
const SCHEDULE_WEEKDAYS = 5;

export const parseDay = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
export const dayOf = (date: Date): string => date.toISOString().slice(0, 10);
export const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY_MS);
export const mondayOf = (date: Date): Date => addDays(date, 1 - (date.getUTCDay() || 7));

/** The läsår's weeks, each as its Monday and its Sunday. */
export function weeksOfYear(year: YearSpan): { monday: string; sunday: string }[] {
  const weeks: { monday: string; sunday: string }[] = [];
  const last = parseDay(year.endDate).getTime();
  for (let monday = mondayOf(parseDay(year.startDate)); monday.getTime() <= last; monday = addDays(monday, 7)) {
    weeks.push({ monday: dayOf(monday), sunday: dayOf(addDays(monday, 6)) });
  }
  return weeks;
}

/** What tells a week with school in it from a week without (weeksWithSchool). */
export interface SchoolDays {
  /** The läsår's SchoolBreaks, whatever their kind. */
  breaks: readonly PublishBreak[];
  /** The årskurs of every group of the läsår, null for a group with no year (a nivågrupp). */
  grades: readonly (number | null)[];
}

/**
 * Which weeks of the läsår have a school day in them, from the week of its first day: false for a
 * week every weekday of which (Monday to Friday, those that lie in the läsår) is a day no årskurs
 * has school (noSchoolDays: a lov closes a day for a group by publish's rule, breakCoversGroup).
 * No break, or none read, closes nothing, and every week is true — what a school that has no
 * breaks always was.
 *
 * A week with no weekday in the läsår (it starts on a Saturday, or ends on a Sunday that is no
 * weekday of the läsår's last week) is true: no break closed it, and the cut reads it as it did.
 */
export function weeksWithSchool(year: YearSpan, schoolDays: SchoolDays | undefined): boolean[] {
  const weeks = weeksOfYear(year);
  if (!schoolDays || schoolDays.breaks.length === 0) return weeks.map(() => true);
  const off = noSchoolDays(schoolDays.breaks, schoolDays.grades, year.startDate, year.endDate);
  return weeks.map(({ monday }) => {
    let weekdaysInYear = 0;
    for (let offset = 0; offset < SCHEDULE_WEEKDAYS; offset += 1) {
      const day = dayOf(addDays(parseDay(monday), offset));
      if (day < year.startDate || day > year.endDate) continue;
      weekdaysInYear += 1;
      if (!off.has(day)) return true;
    }
    return weekdaysInYear === 0;
  });
}

/**
 * The weeks of a läsår in which no lesson is written, for the readers that ask whether two lessons
 * can meet: the Mondays of the weeks weeksWithSchool says are false, and the läsår's own first and
 * last day, outside which nothing is read as closed.
 */
export interface ClosedWeeks {
  from: string;
  to: string;
  mondays: ReadonlySet<string>;
}

/** The closed weeks of the läsår, or null where no week is closed (a school with no lov that takes a whole week). */
export function closedWeeksOf(year: YearSpan, schoolDays: SchoolDays | undefined): ClosedWeeks | null {
  const school = weeksWithSchool(year, schoolDays);
  const mondays = weeksOfYear(year)
    .filter((_, week) => !school[week])
    .map((week) => week.monday);
  return mondays.length === 0 ? null : { from: year.startDate, to: year.endDate, mondays: new Set(mondays) };
}

/**
 * The closed weeks of a läsår from the database: its breaks, its days and the årskurs of every one of
 * its groups. Null — and the later two reads never made — for a year that has no break at all, which is
 * most of them, so a reader pays one statement for the rule where a year has no lov and three where it has
 * one.
 */
export async function readClosedWeeks(tx: PrismaClient, academicYearId: string): Promise<ClosedWeeks | null> {
  const breaks = await tx.schoolBreak.findMany({
    where: { academicYearId },
    select: { startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
  });
  if (breaks.length === 0) return null;
  const year = await tx.academicYear.findUnique({ where: { id: academicYearId }, select: { startDate: true, endDate: true } });
  if (!year) return null;
  const groups = await tx.studentGroup.findMany({ where: { academicYearId }, select: { gradeLevel: true } });
  return closedWeeksOf(
    { startDate: dayOf(year.startDate), endDate: dayOf(year.endDate) },
    { breaks, grades: groups.map((group) => group.gradeLevel) },
  );
}

/** The weeks a lesson is held in, as the clash readers have them: ISO days, null for the läsår's own bound. */
export interface HeldWeeks {
  recurrence?: 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS' | null;
  startDate?: string | null;
  endDate?: string | null;
}

/**
 * Whether two lessons can meet ONLY in weeks no lesson is written in — in which case they are no double
 * booking, whatever they share. False when they might meet in a week with school, and false whenever
 * this cannot be said: no closed week, an overlap that reaches outside the läsår or is empty. A reader
 * asks it after its own "can they ever meet" (weeksCanOverlap), so the answer there is only ever made
 * narrower, and only by weeks that hold nothing:
 *
 *     clash  =  weeksCanOverlap(a, b)  &&  !meetOnlyInClosedWeeks(a, b, closed)
 *
 * The weeks asked are those the overlap of the two windows touches, a null bound being the läsår's own,
 * and of them only those of a parity both lessons run in (an odd lesson never sits an even week). A
 * pair whose overlap has no week of a common parity is not answered here (false), as weeksCanOverlap
 * does not answer it either.
 *
 * It is the generator's relation (year-periods.ts: two entries meet where a week with school holds a
 * date of each), so the generator may lay two posts on one hour exactly where the board accepts them.
 */
export function meetOnlyInClosedWeeks(a: HeldWeeks, b: HeldWeeks, closed: ClosedWeeks | null | undefined): boolean {
  if (!closed) return false;
  const aStart = a.startDate ?? closed.from;
  const bStart = b.startDate ?? closed.from;
  const aEnd = a.endDate ?? closed.to;
  const bEnd = b.endDate ?? closed.to;
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  if (start > end || start < closed.from || end > closed.to) return false;
  const first = a.recurrence ?? 'ALL_WEEKS';
  const second = b.recurrence ?? 'ALL_WEEKS';
  let asked = false;
  for (let monday = mondayOf(parseDay(start)); dayOf(monday) <= end; monday = addDays(monday, 7)) {
    const odd = isoWeekNumber(monday) % 2 === 1;
    const sits = (recurrence: typeof first): boolean =>
      recurrence === 'ALL_WEEKS' || (recurrence === 'ODD_WEEKS') === odd;
    if (!sits(first) || !sits(second)) continue;
    asked = true;
    if (!closed.mondays.has(dayOf(monday))) return false;
  }
  return asked;
}
