import type { LessonRecurrence } from '@prisma/client';
import { isoWeekNumber } from '../calendar/lesson-recurrence';
import { hasTravel, walksOfDay, type PlacedLesson, type SiteMap } from '../common/site-travel';
import { teachingWeeks, type ClosedRange, type YearBounds } from './teaching-weeks';

/**
 * RESTID IS ARBETSTID (Skolområden och restid, 20261124090000): the minutes a
 * teacher spends getting between two sites in the middle of a working day,
 * read off their grundschema.
 *
 * WHERE IT GOES. Beside the undervisning, as an uppdrag that does not count
 * as teaching sits beside it (teacher-load.ts): the load report states a
 * teacher's restid per standardvecka and per läsår, and NOTHING reads it
 * against the riktmärke — not the saldo, the status, the staffing checks, the
 * bemanningsförslag or the vikarie ranking's target. A walk is not a lesson,
 * and a school that wants a travelling teacher to teach less says so where it
 * already does: in the post's target or an uppdrag. SCB's Pedagogisk
 * personal reads undervisningstid per subject and the post's
 * tjänstgöringsomfattning, and SS12000's Duty the post's grade and annual
 * hours; restid is neither, so neither file changes.
 *
 * WHAT IS COUNTED. Every school day of the läsår: each day from the year's
 * first to its last that no school-wide lov closes, with the lessons of the
 * grundschema that run on it — their weekday, their weeks (odd, even), their
 * Från and Till, and not a lesson whose class a lov for some grades closes
 * that day (its class's årskurs inside the lov's span, as the published
 * calendar drops it, publish-days.ts). On each such day
 * the walks between one lesson and the next (common/site-travel.ts walksOfDay)
 * are the teacher's: lead and co-teacher alike, whatever the gap. A walk to
 * or from a room on no site, or between two sites with no figure, is unknown
 * and counts nothing. A parked lesson is no lesson.
 *
 * THE FIGURES. Per läsår, the sum (hours, one decimal). Per standardvecka,
 * that sum over the year's teaching weeks with school-wide lov out — the
 * frame an undated uppdrag is taken over — so a teacher who walks one Monday
 * in two reads half a walk a week. The busiest week, as the toppvecka is for
 * teaching, so a week that does not fit is not averaged away.
 *
 * WHOSE GRUNDSCHEMA. The reader's (published-grundschema.ts): the
 * administrator's draft, a teacher's published one.
 */

/** A lesson of the grundschema as the count reads it. */
export interface TravelMaster {
  id: string;
  teacherIds: readonly string[];
  /** ISO weekday, 1 = Monday. */
  dayOfWeek: number;
  /** Minutes from midnight. */
  start: number;
  end: number;
  roomId: string | null;
  recurrence: LessonRecurrence;
  /** Inclusive yyyy-mm-dd, or null for the year's own bound. */
  startDate: string | null;
  endDate: string | null;
  /** The class's årskurs, for a lov that closes some grades; null for a group without one. */
  gradeLevel?: number | null;
}

export interface TeacherTravel {
  userId: string;
  /** The year's walks over its teaching weeks, whole minutes. */
  minutesPerWeek: number;
  /** The busiest ISO week's walks, whole minutes. */
  peakMinutesPerWeek: number;
  /** The year's walks, hours to one decimal. */
  hoursPerYear: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const asDay = (date: Date): string => date.toISOString().slice(0, 10);
const round1 = (value: number): number => Math.round(value * 10) / 10;

/** A lov for some grades closes a lesson whose class's årskurs it spans; one without a grade it never closes. */
function closedForGrade(closure: ClosedRange, gradeLevel: number | null | undefined): boolean {
  if (gradeLevel === null || gradeLevel === undefined) return false;
  const min = closure.minGradeLevel ?? null;
  const max = closure.maxGradeLevel ?? null;
  return (min === null || gradeLevel >= min) && (max === null || gradeLevel <= max);
}

function runsOn(master: TravelMaster, day: string, odd: boolean): boolean {
  if (master.startDate !== null && day < master.startDate) return false;
  if (master.endDate !== null && day > master.endDate) return false;
  if (master.recurrence === 'ODD_WEEKS') return odd;
  if (master.recurrence === 'EVEN_WEEKS') return !odd;
  return true;
}

/**
 * Every teacher's restid over the year, for the teachers who walk at all;
 * none at a school with no travel figure.
 */
export function travelLoad(
  map: SiteMap,
  masters: readonly TravelMaster[],
  year: YearBounds,
  closures: readonly ClosedRange[],
): TeacherTravel[] {
  if (!hasTravel(map) || masters.length === 0) return [];
  const schoolWide = closures.filter((c) => (c.minGradeLevel ?? null) === null && (c.maxGradeLevel ?? null) === null);
  const someGrades = closures.filter((c) => !schoolWide.includes(c));
  const byTeacherDay = new Map<string, TravelMaster[]>();
  for (const master of masters) {
    for (const teacher of new Set(master.teacherIds)) {
      const key = `${teacher}|${master.dayOfWeek}`;
      const list = byTeacherDay.get(key);
      if (list) list.push(master);
      else byTeacherDay.set(key, [master]);
    }
  }
  const teachers = [...new Set(masters.flatMap((master) => master.teacherIds))];
  const annual = new Map<string, number>();
  const weekly = new Map<string, Map<string, number>>();

  const first = new Date(`${year.startDate}T00:00:00.000Z`);
  const last = new Date(`${year.endDate}T00:00:00.000Z`);
  for (let date = first; date.getTime() <= last.getTime(); date = new Date(date.getTime() + DAY_MS)) {
    const day = asDay(date);
    if (schoolWide.some((closure) => day >= closure.startDate && day <= closure.endDate)) continue;
    const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
    const monday = asDay(new Date(date.getTime() - (weekday - 1) * DAY_MS));
    const odd = isoWeekNumber(new Date(`${monday}T00:00:00.000Z`)) % 2 === 1;
    const closedToday = someGrades.filter((closure) => day >= closure.startDate && day <= closure.endDate);
    for (const teacher of teachers) {
      const lessons = (byTeacherDay.get(`${teacher}|${weekday}`) ?? []).filter(
        (master) =>
          runsOn(master, day, odd) && !closedToday.some((closure) => closedForGrade(closure, master.gradeLevel)),
      );
      if (lessons.length < 2) continue;
      const placed: PlacedLesson[] = lessons.map((master) => ({
        id: master.id,
        start: master.start,
        end: master.end,
        roomId: master.roomId,
      }));
      const minutes = walksOfDay(map, placed).reduce((sum, walk) => sum + walk.minutes, 0);
      if (minutes === 0) continue;
      annual.set(teacher, (annual.get(teacher) ?? 0) + minutes);
      const weeks = weekly.get(teacher) ?? new Map<string, number>();
      weeks.set(monday, (weeks.get(monday) ?? 0) + minutes);
      weekly.set(teacher, weeks);
    }
  }

  const weeks = teachingWeeks({}, year, [...schoolWide], null);
  return [...annual.entries()]
    .map(([userId, minutes]) => ({
      userId,
      minutesPerWeek: weeks > 0 ? Math.round(minutes / weeks) : 0,
      peakMinutesPerWeek: Math.max(0, ...(weekly.get(userId)?.values() ?? [])),
      hoursPerYear: round1(minutes / 60),
    }))
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}
