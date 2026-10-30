/**
 * PUB_OTHER_SCHOOL: what the school's grundschema does to the other schools
 * of its huvudman, and they to it (Delade lokaler och lärare). Read at every
 * publish, on both schools, so the school that publishes last sees a clash
 * whichever side made it:
 *
 *   TEACHER        a lesson of a shared teacher here meets the teacher's
 *                  lesson at the other school, the walk between the schools
 *                  counted on both sides;
 *   LENT_ROOM      a lesson here in a room the school has lent, in an
 *                  approved window of the loan;
 *   BORROWED_ROOM  a lesson in the school's own room for a borrowed one, at
 *                  a time on a date it runs that the approved loans
 *                  together do not cover (src/sharing/loan-coverage.ts,
 *                  the rule the generator and the bookings read too: two
 *                  loans side by side cover a lesson together, and a lov
 *                  of its group is no date it runs, so an autumn and a
 *                  spring loan around the jullov do too).
 *
 * Weeks count here as they do on the board (src/calendar/lesson-recurrence):
 * an odd-week lesson never meets an even-week one, nor a lesson whose dates
 * do not meet. The lesson's dates are the ones the publish materialises,
 * clipped to its window by the caller.
 *
 * PURE.
 */
import type { LessonRecurrence } from '@prisma/client';
import { coveredEveryRun, minutesOfClock, type CoverLoan } from '../sharing/loan-coverage';

export interface PublishedLesson {
  id: string;
  /** The lead and the co-teacher, this school's rows. */
  teacherIds: string[];
  roomId: string | null;
  dayOfWeek: number;
  /** 'HH:MM'. */
  startTime: string;
  endTime: string;
  recurrence: LessonRecurrence;
  /** 'YYYY-MM-DD', inclusive, already within the publish window. */
  startDate: string;
  endDate: string;
  /** The days a lov covers the lesson's group: the publish writes nothing then. */
  offDays?: ReadonlySet<string>;
}

export interface BusyLesson {
  teacherId: string;
  schoolId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  recurrence: LessonRecurrence;
  startDate: string;
  endDate: string;
  travelMinutes: number | null;
}

export interface LoanWindow {
  loanId: string;
  /** The owner's room (a loan the school lends) or the school's own room for it (one it borrows). */
  roomId: string;
  schoolId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  startDate: string;
  endDate: string;
}

export type OtherSchoolClash =
  | { kind: 'TEACHER'; lessonId: string; teacherId: string; busy: BusyLesson }
  | { kind: 'LENT_ROOM'; lessonId: string; window: LoanWindow }
  | { kind: 'BORROWED_ROOM'; lessonId: string; roomId: string };

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const isoWeek = (day: string): number => {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const first = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstWeekday = first.getUTCDay() === 0 ? 7 : first.getUTCDay();
  first.setUTCDate(first.getUTCDate() + 4 - firstWeekday);
  return Math.round((date.getTime() - first.getTime()) / (7 * 86_400_000)) + 1;
};
const addDays = (day: string, days: number): string => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/**
 * Whether two weekly templates on one weekday share a date: their periods
 * meet, and some date of the weekday in the common period is in a week both
 * run. Exact, where weeksCanOverlap is the board's cheaper "can ever": a
 * common period of one odd week holds no even-week lesson.
 */
export function shareADate(
  dayOfWeek: number,
  a: { recurrence: LessonRecurrence; startDate: string; endDate: string },
  b: { recurrence: LessonRecurrence; startDate: string; endDate: string },
): boolean {
  const from = a.startDate > b.startDate ? a.startDate : b.startDate;
  const to = a.endDate < b.endDate ? a.endDate : b.endDate;
  if (from > to) return false;
  // The first date of the weekday in the common period, then week by week.
  // Three weeks settle the parity: ISO years of 53 weeks put two odd weeks
  // in a row (week 53 and week 1, as 2026–2027 does), so two would miss
  // every even week of a period that begins in week 53.
  const start = new Date(`${from}T00:00:00Z`);
  const weekday = start.getUTCDay() === 0 ? 7 : start.getUTCDay();
  let day = addDays(from, (dayOfWeek - weekday + 7) % 7);
  for (let i = 0; i < 3 && day <= to; i++, day = addDays(day, 7)) {
    const odd = isoWeek(day) % 2 === 1;
    const runs = (r: LessonRecurrence) => r === 'ALL_WEEKS' || (r === 'ODD_WEEKS') === odd;
    if (runs(a.recurrence) && runs(b.recurrence)) return true;
  }
  return false;
}

export function otherSchoolClashes(input: {
  lessons: readonly PublishedLesson[];
  busy: readonly BusyLesson[];
  lent: readonly LoanWindow[];
  borrowed: readonly LoanWindow[];
  /** The school's own rooms for borrowed rooms, every loan's, approved or not. */
  localRoomIds: ReadonlySet<string>;
}): OtherSchoolClash[] {
  const clashes: OtherSchoolClash[] = [];
  for (const lesson of input.lessons) {
    if (lesson.startDate > lesson.endDate) continue;
    const start = minutesOf(lesson.startTime);
    const end = minutesOf(lesson.endTime);

    for (const busy of input.busy) {
      if (busy.dayOfWeek !== lesson.dayOfWeek || !lesson.teacherIds.includes(busy.teacherId)) continue;
      const walk = Math.max(0, busy.travelMinutes ?? 0);
      if (!(start < minutesOf(busy.endTime) + walk && minutesOf(busy.startTime) - walk < end)) continue;
      if (!shareADate(lesson.dayOfWeek, lesson, busy)) continue;
      clashes.push({ kind: 'TEACHER', lessonId: lesson.id, teacherId: busy.teacherId, busy });
    }

    if (lesson.roomId === null) continue;
    for (const window of input.lent) {
      if (window.roomId !== lesson.roomId || window.dayOfWeek !== lesson.dayOfWeek) continue;
      if (!(start < minutesOf(window.endTime) && minutesOf(window.startTime) < end)) continue;
      if (!shareADate(lesson.dayOfWeek, lesson, { ...window, recurrence: 'ALL_WEEKS' })) continue;
      clashes.push({ kind: 'LENT_ROOM', lessonId: lesson.id, window });
    }

    if (input.localRoomIds.has(lesson.roomId)) {
      const loans: CoverLoan[] = input.borrowed
        .filter((window) => window.roomId === lesson.roomId)
        .map((window) => ({
          dayOfWeek: window.dayOfWeek,
          start: minutesOfClock(window.startTime),
          end: minutesOfClock(window.endTime),
          startDate: window.startDate,
          endDate: window.endDate,
        }));
      const runs = (date: string) =>
        !lesson.offDays?.has(date) && (lesson.recurrence === 'ALL_WEEKS' || (lesson.recurrence === 'ODD_WEEKS') === (isoWeek(date) % 2 === 1));
      if (!coveredEveryRun(loans, lesson.dayOfWeek, start, end, lesson.startDate, lesson.endDate, runs)) {
        clashes.push({ kind: 'BORROWED_ROOM', lessonId: lesson.id, roomId: lesson.roomId });
      }
    }
  }
  return clashes;
}
