/**
 * Vikarietimmar: the two CSV files for payroll, built in the browser from
 * GET /api/v1/cover/hours.
 *
 * IMPORTED ON CLICK (`import()` in the reports tab), so no route carries it,
 * as lib/staffing-exports.ts.
 *
 * WHAT THE FILE SAYS: who covered which lesson, when, for how many minutes —
 * Fas 3's delivered credit to the SUBSTITUTE row, in clock minutes (the
 * gateway's statement composes the very lessons Fas 3 credits). Only lessons
 * that have been held; booked ones are shown on screen and never exported.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY: the replaced teacher, the absence and
 * its reason. Payroll needs who worked when, not who was away or why; a file
 * mailed to a payroll office must not become a sick-leave register.
 *
 * Times are on the SCHOOL's clock, not the downloader's: a payroll file is
 * read on another machine, and a lesson at 08:00 is at 08:00.
 *
 * The person is named by name and e-mail — SchemaPro stores no
 * anställningsnummer — and typed "Personal" or "Vikariepool".
 */

import { serializeCsv } from "@/lib/csv-export";
import { csvDecimal } from "@/lib/staffing-exports";
import { compareSwedish } from "@/lib/sorting";
import type { CoverPersonKind, Hours } from "@/lib/cover-types";

export interface HoursPerson {
  name: string;
  email: string;
}

export interface HoursNames {
  person: (userId: string) => HoursPerson | null;
  subject: (id: string) => string;
  group: (id: string) => string;
  room: (id: string | null) => string;
  timezone: string;
}

export const HOURS_LESSON_HEADERS = ["Vikarie", "E-post", "Typ", "Datum", "Start", "Slut", "Minuter", "Ämne", "Grupp", "Sal"];
export const HOURS_SUMMARY_HEADERS = ["Vikarie", "E-post", "Typ", "Lektioner", "Minuter", "Timmar"];

const KIND_WORD: Record<CoverPersonKind, string> = { STAFF: "Personal", POOL: "Vikariepool" };

function clock(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

const unknown = (userId: string): HoursPerson => ({ name: userId, email: "" });

/** One row per held cover, by person (Swedish order), then date and start. */
export function hoursLessonsCsv(hours: Hours, names: HoursNames): string {
  const rows = hours.rows
    .map((row) => ({ row, person: names.person(row.userId) ?? unknown(row.userId) }))
    .sort(
      (a, b) =>
        compareSwedish(a.person.name, b.person.name) ||
        a.row.userId.localeCompare(b.row.userId) ||
        a.row.startsAt.localeCompare(b.row.startsAt) ||
        a.row.lessonId.localeCompare(b.row.lessonId),
    )
    .map(({ row, person }) => [
      person.name,
      person.email,
      KIND_WORD[row.kind],
      row.date,
      clock(row.startsAt, names.timezone),
      clock(row.endsAt, names.timezone),
      String(row.minutes),
      names.subject(row.subjectId),
      names.group(row.studentGroupId),
      names.room(row.roomId),
    ]);
  return serializeCsv(HOURS_LESSON_HEADERS, rows);
}

/** One row per person: lessons, minutes and hours (decimal comma, two places). */
export function hoursSummaryCsv(hours: Hours, names: HoursNames): string {
  const rows = hours.summary
    .map((line) => ({ line, person: names.person(line.userId) ?? unknown(line.userId) }))
    .sort((a, b) => compareSwedish(a.person.name, b.person.name) || a.line.userId.localeCompare(b.line.userId))
    .map(({ line, person }) => [
      person.name,
      person.email,
      KIND_WORD[line.kind],
      String(line.lessons),
      String(line.minutes),
      csvDecimal(line.minutes / 60, 2),
    ]);
  return serializeCsv(HOURS_SUMMARY_HEADERS, rows);
}

export function hoursFilename(kind: "lektioner" | "summering", from: string, to: string): string {
  return `vikarietimmar-${kind}-${from}-${to}.csv`;
}
