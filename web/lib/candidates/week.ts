import { audienceFor, type RosterIndex } from "@/lib/lesson-audience";
import { isoWeekOf, plusDays, type SheetDocument, type SheetLesson } from "@/lib/print-sheet";
import type { MasterLesson } from "@/lib/types";
import { clockOf } from "./lessons";

/*
 * One week of a candidate, as the printed week sheet draws it
 * (components/timetable-sheet/week-sheet.tsx), for a class, a teacher or a
 * room.
 *
 * A grundschema is a template, and the sheet is a real week with dates on
 * it, so the week has to be chosen: the week of today, held inside the läsår.
 * Each lesson is then drawn only where it would really run — its weeks (an
 * odd-weeks lesson is not on an even week's sheet), its dates (a lesson of
 * the spring term is not on an autumn week) and the läsår's own (the Monday
 * and Tuesday before a Wednesday start are no school days). The sheet that
 * results is a week the school would actually live, not a superposition of
 * all of them; the page offers the next week too, so an alternating lesson
 * can be seen in the parity it runs, and a first week cut short by the start
 * can be seen whole.
 */

export type WeekTargetKind = "GROUP" | "TEACHER" | "ROOM";

/** The läsår's bounds, as the year's `date` columns arrive ('YYYY-MM-DD'). */
export interface YearBounds {
  startDate: string;
  endDate: string;
}

/**
 * Monday of the week `today` falls in, held inside [start, end]. A start on
 * a Saturday or a Sunday holds it to the Monday after: the week before has
 * no day of the läsår in it at all.
 */
export function referenceMonday(year: YearBounds, today: string): string {
  const start = year.startDate.slice(0, 10);
  const end = year.endDate.slice(0, 10);
  const day = today < start ? start : today > end ? end : today;
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
  if (day === start && weekday >= 6) return plusDays(day, 8 - weekday);
  return plusDays(day, 1 - weekday);
}

/** Whether a date is a day of the läsår: the sheet draws nothing before its start or after its end. */
export function inYear(year: YearBounds, date: string): boolean {
  return date >= year.startDate.slice(0, 10) && date <= year.endDate.slice(0, 10);
}

/** The parity of the ISO week a Monday starts. */
export function parityOf(monday: string): "ODD_WEEKS" | "EVEN_WEEKS" {
  return Number(isoWeekOf(monday).split("W")[1]) % 2 === 1 ? "ODD_WEEKS" : "EVEN_WEEKS";
}

/** Whether a lesson runs on this date, a day of a week of this parity. */
export function runsOn(
  lesson: Pick<MasterLesson, "recurrence" | "startDate" | "endDate">,
  date: string,
  parity: "ODD_WEEKS" | "EVEN_WEEKS",
): boolean {
  if (lesson.recurrence !== "ALL_WEEKS" && lesson.recurrence !== parity) return false;
  if (lesson.startDate && date < lesson.startDate.slice(0, 10)) return false;
  if (lesson.endDate && date > lesson.endDate.slice(0, 10)) return false;
  return true;
}

/** Whether any lesson runs every other week, so a second week is worth offering. */
export function alternates(lessons: readonly Pick<MasterLesson, "recurrence">[]): boolean {
  return lessons.some((lesson) => lesson.recurrence !== "ALL_WEEKS");
}

/** No pupils known: a group's week falls back to the lessons that name it (lib/lesson-audience.ts). */
const NO_ROSTER: RosterIndex = { membersOf: new Map() };

/**
 * Whether a lesson belongs on the target's week.
 *
 * A group's week is decided by who sits in the lesson, as the timetable's
 * class filter decides it (lib/lesson-audience.ts audienceFor): a lesson
 * naming the class, one of its halves or the group itself, and every lesson
 * a teaching group holds any of its pupils in — 7A's week has Ma71 on it
 * when 7A's pupils are in Ma71. A candidate's lessons sit on their
 * requirement's group, and in a school whose timplan is all teaching groups
 * a week by name alone would be empty for every class. The roster is the
 * page's own (the håltimmar's); until it has arrived, the name test holds.
 */
export function concerns(
  lesson: MasterLesson,
  kind: WeekTargetKind,
  targetId: string,
  roster: RosterIndex = NO_ROSTER,
): boolean {
  if (kind === "TEACHER") return lesson.teacherId === targetId || lesson.coTeacherId === targetId;
  if (kind === "ROOM") return lesson.roomId === targetId;
  return audienceFor(lesson, targetId, roster) !== null;
}

export interface WeekNames {
  subject: (id: string) => string | null;
  group: (id: string) => string | null;
  room: (id: string) => string | null;
  teacher: (id: string) => string | null;
}

/**
 * The sheet: Monday to Sunday from `monday`, the target's lessons on each
 * day of the läsår they run, in clock order. `school` is the sheet's first
 * line, which on this page names the candidate rather than the school.
 */
export function candidateSheet(input: {
  lessons: readonly MasterLesson[];
  kind: WeekTargetKind;
  targetId: string;
  title: string;
  school: string;
  monday: string;
  year: YearBounds;
  names: WeekNames;
  roster?: RosterIndex;
}): SheetDocument {
  const parity = parityOf(input.monday);
  const days = Array.from({ length: 7 }, (_, index) => ({
    date: plusDays(input.monday, index),
    lessons: [] as SheetLesson[],
  }));
  for (const lesson of input.lessons) {
    if (!concerns(lesson, input.kind, input.targetId, input.roster)) continue;
    const day = days[lesson.dayOfWeek - 1];
    if (!day || !inYear(input.year, day.date) || !runsOn(lesson, day.date, parity)) continue;
    const groups = [lesson.studentGroupId, ...lesson.extraGroupIds].map((id) => input.names.group(id));
    day.lessons.push({
      start: clockOf(lesson.startTime),
      end: clockOf(lesson.endTime),
      subject: input.names.subject(lesson.subjectId),
      groups,
      room: lesson.roomId ? input.names.room(lesson.roomId) : null,
      teachers: [lesson.teacherId, lesson.coTeacherId]
        .filter((id): id is string => id !== null)
        .map((id) => input.names.teacher(id))
        .filter((name): name is string => name !== null),
    });
  }
  for (const day of days) {
    day.lessons.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
  }
  return {
    kind: input.kind,
    title: input.title,
    school: input.school,
    week: { from: input.monday, to: plusDays(input.monday, 6), isoWeek: isoWeekOf(input.monday) },
    days,
  };
}
