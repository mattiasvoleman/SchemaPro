/*
 * A printed week (Utskrift och inbäddning, 20261102090000): the one document
 * every week sheet is drawn from — Schemavisaren's page, its embedded frame,
 * the admin's print set, and a pupil's, a guardian's or a teacher's own
 * printout. components/timetable-sheet/week-sheet.tsx draws it; nothing here
 * imports a component, so a server page and a client page read it alike.
 *
 * What a sheet of a class, a teacher or a room holds is the gateway's
 * whitelist (app.timetable_week_days): the shape is lib/public-timetable.ts's
 * PublicWeek, with a validity added. A person's own week is mapped here from
 * what their page already shows — the print is the page on paper, never a
 * read of its own.
 */

import type { PublicLesson } from "@/lib/public-timetable";
import type { FamilySchedule } from "@/lib/family-schedule";

/** A class or group, a teacher, a room — or one pupil's own week. */
export type SheetKind = "GROUP" | "TEACHER" | "ROOM" | "PUPIL";

export interface SheetLesson extends PublicLesson {
  /** A person's own week only: "Vikarie" on a lesson their teacher covers, or they cover. */
  note?: string | null;
  /**
   * A teacher's own week only: a rastvaktspass (Rastvakt i vardagen), one
   * line on paper — its time, "Rastvakt", whose it is that day and where —
   * as a 15-minute block holds no more; `relieved` when somebody else has it.
   */
  duty?: boolean;
  relieved?: boolean;
}

export interface SheetDay {
  date: string;
  lessons: SheetLesson[];
  meals?: { start: string; end: string }[];
}

/** A run of dates one publication is valid for ("Giltig fr.o.m./t.o.m."). */
export interface ValidityPeriod {
  from: string;
  to: string;
}

export interface SheetDocument {
  kind: SheetKind;
  title: string;
  school: string;
  week: { from: string; to: string; isoWeek: string };
  days: SheetDay[];
  /** The periods the week's days are valid for; absent when not asked, empty when nothing published covers them. */
  validity?: ValidityPeriod[];
}

const DAY_MS = 86_400_000;
const pad = (value: number) => String(value).padStart(2, "0");

/** HH:MM of minutes since midnight. */
export const clockOf = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** A YYYY-MM-DD of a local Date (the week picker's), by its own components. */
export const dayOf = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** A YYYY-MM-DD shifted by whole days, in UTC arithmetic. */
export const plusDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** "2026-W42" of a Monday. */
export function isoWeekOf(monday: string): string {
  const at = new Date(`${monday}T00:00:00Z`);
  const thursday = new Date(at.getTime() + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstMonday = firstThursday.getTime() - ((firstThursday.getUTCDay() + 6) % 7) * DAY_MS;
  const week = Math.floor((at.getTime() - firstMonday) / (7 * DAY_MS)) + 1;
  return `${year}-W${pad(week)}`;
}

/** The ISO week number of a sheet's week. */
export const weekNumberOf = (document: Pick<SheetDocument, "week">): number => Number(document.week.isoWeek.split("W")[1]);

/** Seven days from `monday`, empty. */
function emptyWeek(monday: string): SheetDay[] {
  return Array.from({ length: 7 }, (_, index) => ({ date: plusDays(monday, index), lessons: [] }));
}

/** What a grid lesson of a person's own page is, for the sheet. */
export interface GridLessonLike {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  title: string;
  subtitle?: string;
  room?: string;
  cancelled?: boolean;
  duty?: boolean;
  relieved?: boolean;
}

export interface GridBandLike {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
}

/**
 * A teacher's or a pupil's own week from what their page draws
 * (components/schedule/week-schedule.tsx): each lesson's subject, its line
 * (the group, and "Vikarie" where the page says so) and its room, and the
 * meals among the bands. Rasts are left off paper: the page shows them as
 * stripes behind the day, and a printed week of stripes reads as lessons.
 */
export function sheetFromGrid(input: {
  kind: "TEACHER" | "PUPIL";
  title: string;
  school: string;
  weekStart: Date;
  lessons: readonly GridLessonLike[];
  meals?: readonly GridBandLike[];
}): SheetDocument {
  const monday = dayOf(input.weekStart);
  const days = emptyWeek(monday);
  for (const lesson of input.lessons) {
    const day = days[lesson.dayOfWeek - 1];
    if (!day) continue;
    day.lessons.push({
      start: clockOf(lesson.startMinutes),
      end: clockOf(lesson.endMinutes),
      subject: lesson.title,
      groups: lesson.subtitle ? [lesson.subtitle] : [],
      room: lesson.room ?? null,
      teachers: [],
      cancelled: lesson.cancelled ?? false,
      ...(lesson.duty ? { duty: true } : {}),
      ...(lesson.relieved ? { relieved: true } : {}),
    });
  }
  for (const meal of input.meals ?? []) {
    const day = days[meal.dayOfWeek - 1];
    if (!day) continue;
    (day.meals ??= []).push({ start: clockOf(meal.startMinutes), end: clockOf(meal.endMinutes) });
  }
  for (const day of days) {
    day.lessons.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : 1));
    day.meals?.sort((a, b) => (a.start < b.start ? -1 : 1));
  }
  return { kind: input.kind, title: input.title, school: input.school, week: { from: monday, to: plusDays(monday, 6), isoWeek: isoWeekOf(monday) }, days };
}

/**
 * A guardian's child's week from the family schedule the page already read
 * (GET /family/schedule, recorded in the read log as SCHEDULE when it was
 * read): the times on the school's clock as they came, subject, room and
 * the teachers as the school names them to families, "Inställd", "Vikarie"
 * where the page says so, and the class's lunch.
 */
export function sheetFromFamily(schedule: FamilySchedule, school: string, substitute: string): SheetDocument {
  const days = emptyWeek(schedule.week.from);
  const dayAt = new Map(days.map((day) => [day.date, day]));
  for (const lesson of schedule.lessons) {
    const day = dayAt.get(lesson.date);
    if (!day) continue;
    day.lessons.push({
      start: lesson.start,
      end: lesson.end,
      subject: lesson.subject,
      groups: [],
      room: lesson.room,
      teachers: lesson.teachers,
      cancelled: lesson.status === "CANCELLED",
      note: lesson.substitute && lesson.status !== "CANCELLED" ? substitute : null,
    });
  }
  for (const lunch of schedule.lunches) {
    const day = dayAt.get(lunch.date);
    if (!day) continue;
    (day.meals ??= []).push({ start: lunch.start, end: lunch.end });
  }
  for (const day of days) {
    day.lessons.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : 1));
    day.meals?.sort((a, b) => (a.start < b.start ? -1 : 1));
  }
  // The week's Sunday from its Monday: the seven days drawn are that week's whatever else is said.
  const week = { from: schedule.week.from, to: plusDays(schedule.week.from, 6), isoWeek: schedule.week.isoWeek };
  return { kind: "PUPIL", title: schedule.student.firstName, school, week, days };
}
