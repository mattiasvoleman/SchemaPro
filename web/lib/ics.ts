// iCalendar (.ics) export of the weekly master timetable.
//
// Each master lesson becomes a recurring VEVENT: DTSTART on the first date the
// lesson actually runs, RRULE until its window closes. Times are exported as
// floating local times (school wall-clock).

import type { LessonRecurrence } from "@/lib/types";
import { addDays, isoWeek } from "@/lib/utils";

export interface IcsLesson {
  id: string;
  dayOfWeek: number; // ISO 1-7
  startTime: string; // HH:MM[:SS]
  endTime: string;
  summary: string;
  location?: string;
  description?: string;
  /** Which weeks the lesson runs; absent means every week. */
  recurrence?: LessonRecurrence;
  /** YYYY-MM-DD; null or absent means the academic year's own boundary. */
  startDate?: string | null;
  endDate?: string | null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** YYYYMMDD in local time — the DATE half of every value this file writes. */
function icsDay(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function icsDate(date: Date, time: string): string {
  const [h, m] = time.split(":");
  return `${icsDay(date)}T${h}${m}00`;
}

/** First date >= `from` that falls on the ISO weekday `dayOfWeek`. */
function firstOccurrence(from: Date, dayOfWeek: number): Date {
  const date = new Date(from);
  const current = date.getDay() === 0 ? 7 : date.getDay();
  const delta = (dayOfWeek - current + 7) % 7;
  date.setDate(date.getDate() + delta);
  return date;
}

/**
 * Whether a date's ISO week matches the lesson's parity.
 *
 * The browser mirror of the parity branch in the API's runsOn
 * (src/calendar/lesson-recurrence.ts): "varannan vecka" means the ISO week
 * number is odd or even, not a count from the start of term. `isoWeek` is the
 * same ISO algorithm the server uses, year-boundary weeks 1 and 53 included —
 * if the two ever disagreed the calendar a parent subscribes to would show a
 * different week than the one the school publishes.
 */
function weekMatches(recurrence: LessonRecurrence, date: Date): boolean {
  if (recurrence === "ALL_WEEKS") return true;
  const odd = isoWeek(date) % 2 === 1;
  return recurrence === "ODD_WEEKS" ? odd : !odd;
}

/** Every date in [from, to] on the lesson's weekday that the lesson runs on. */
function occurrences(lesson: IcsLesson, from: Date, to: Date): Date[] {
  const recurrence = lesson.recurrence ?? "ALL_WEEKS";
  const dates: Date[] = [];
  for (
    let date = firstOccurrence(from, lesson.dayOfWeek);
    date <= to;
    date = addDays(date, 7)
  ) {
    if (weekMatches(recurrence, date)) dates.push(date);
  }
  return dates;
}

/**
 * Split occurrences into runs a single RRULE can state exactly.
 *
 * INTERVAL=2 counts fourteen days on from DTSTART, but the parity we mean is
 * the ISO week number — and an ISO year with 53 weeks puts week 53 next to
 * week 1, two odd weeks running. 2026/27 is such a year. No single rule spans
 * that seam, and one that tries lands the whole spring term on the wrong
 * weeks, so each side of it gets its own VEVENT.
 */
function runs(dates: Date[], strideDays: number): Date[][] {
  const segments: Date[][] = [];
  let previous: Date | undefined;
  for (const date of dates) {
    // Compared as calendar days: across a DST shift fourteen days is 335 or
    // 337 hours, so the gap cannot be measured in milliseconds.
    if (previous && icsDay(addDays(previous, strideDays)) === icsDay(date)) {
      segments[segments.length - 1].push(date);
    } else {
      segments.push([date]);
    }
    previous = date;
  }
  return segments;
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

export function buildIcs(
  lessons: IcsLesson[],
  options: { calendarName: string; yearStart: string; yearEnd: string },
): string {
  const stamp = new Date();
  const dtstamp =
    `${stamp.getUTCFullYear()}${pad(stamp.getUTCMonth() + 1)}${pad(stamp.getUTCDate())}` +
    `T${pad(stamp.getUTCHours())}${pad(stamp.getUTCMinutes())}${pad(stamp.getUTCSeconds())}Z`;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SchemaPro//Timetable//EN",
    `X-WR-CALNAME:${escapeText(options.calendarName)}`,
  ];

  for (const lesson of lessons) {
    // A lesson's own period narrows the academic year, never widens it. Dates
    // are YYYY-MM-DD, so a string comparison is a date comparison.
    const windowStart =
      lesson.startDate && lesson.startDate > options.yearStart
        ? lesson.startDate
        : options.yearStart;
    const windowEnd =
      lesson.endDate && lesson.endDate < options.yearEnd
        ? lesson.endDate
        : options.yearEnd;

    const strideDays = (lesson.recurrence ?? "ALL_WEEKS") === "ALL_WEEKS" ? 7 : 14;
    const segments = runs(
      occurrences(
        lesson,
        new Date(`${windowStart}T00:00:00`),
        new Date(`${windowEnd}T00:00:00`),
      ),
      strideDays,
    );

    segments.forEach((segment, index) => {
      const first = segment[0];
      const interval = strideDays === 14 ? ";INTERVAL=2" : "";
      // Only the closing run may run to the window's own end; an earlier one
      // has to stop on its last date or it would carry on past the seam.
      const until =
        index === segments.length - 1
          ? windowEnd.replace(/-/g, "")
          : icsDay(segment[segment.length - 1]);
      lines.push(
        "BEGIN:VEVENT",
        // The first run keeps the lesson's own UID so an existing subscription
        // does not lose the event; a split adds series beside it.
        `UID:${index === 0 ? lesson.id : `${lesson.id}-${index + 1}`}@schemapro`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART:${icsDate(first, lesson.startTime)}`,
        `DTEND:${icsDate(first, lesson.endTime)}`,
        `RRULE:FREQ=WEEKLY${interval};UNTIL=${until}T235959`,
        `SUMMARY:${escapeText(lesson.summary)}`,
        ...(lesson.location ? [`LOCATION:${escapeText(lesson.location)}`] : []),
        ...(lesson.description ? [`DESCRIPTION:${escapeText(lesson.description)}`] : []),
        "END:VEVENT",
      );
    });
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

export function downloadIcs(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
