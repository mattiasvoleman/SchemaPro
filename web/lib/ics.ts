// iCalendar (.ics) export of the weekly master timetable.
//
// Each master lesson becomes a weekly-recurring VEVENT: first occurrence on
// the first matching weekday within the academic year, RRULE until the year
// ends. Times are exported as floating local times (school wall-clock).

export interface IcsLesson {
  id: string;
  dayOfWeek: number; // ISO 1-7
  startTime: string; // HH:MM[:SS]
  endTime: string;
  summary: string;
  location?: string;
  description?: string;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function icsDate(date: Date, time: string): string {
  const [h, m] = time.split(":");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${h}${m}00`
  );
}

/** First date >= `from` that falls on the ISO weekday `dayOfWeek`. */
function firstOccurrence(from: Date, dayOfWeek: number): Date {
  const date = new Date(from);
  const current = date.getDay() === 0 ? 7 : date.getDay();
  const delta = (dayOfWeek - current + 7) % 7;
  date.setDate(date.getDate() + delta);
  return date;
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
  const start = new Date(`${options.yearStart}T00:00:00`);
  const end = new Date(`${options.yearEnd}T00:00:00`);
  const until = `${options.yearEnd.replace(/-/g, "")}T235959`;
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
    const first = firstOccurrence(start, lesson.dayOfWeek);
    if (first > end) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${lesson.id}@schemapro`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${icsDate(first, lesson.startTime)}`,
      `DTEND:${icsDate(first, lesson.endTime)}`,
      `RRULE:FREQ=WEEKLY;UNTIL=${until}`,
      `SUMMARY:${escapeText(lesson.summary)}`,
      ...(lesson.location ? [`LOCATION:${escapeText(lesson.location)}`] : []),
      ...(lesson.description ? [`DESCRIPTION:${escapeText(lesson.description)}`] : []),
      "END:VEVENT",
    );
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
