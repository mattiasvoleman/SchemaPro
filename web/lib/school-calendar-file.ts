// Skolans kalender (P4): a municipality's läsårstider, read into the entries the calendar dialog measures against the
// school's lov (lib/school-calendar.ts).
//
// Two shapes arrive. An ICS file is what a municipality's calendar page or a Skola24 / InfoMentor export offers: a
// VEVENT per lov, written as whole days (DTEND is the day AFTER the last one, RFC 5545 3.6.1). A CSV is what a
// school makes by hand, or a municipality's table: namn, start, slut and optionally typ and årskurser.
//
// NOTHING IS GUESSED SILENTLY. A row that cannot be read is a problem with its place in the file and is left out;
// a recurring event is not expanded (a läsår is dated, and an expansion is a guess at the end of the series) and
// is said so; a row that reads as a term date (Terminsstart) is kept but unticked, because it is a day school
// begins and not one it is shut. The reader never throws on a file's content: the dialog shows what came out.
import { parseCsv } from "@/lib/csv";
import { normalizeHeader } from "@/lib/csv-export";
import { addDays } from "@/lib/year-rollover";
import type { BreakKind } from "@/lib/types";
import type { CalendarEntry } from "@/lib/school-calendar";

/** The gateway takes at most this many rows in one write; a file with more is read up to it and says so. */
export const MAX_CALENDAR_ROWS = 200;

export type CalendarFileProblemCode =
  | "NOT_A_CALENDAR"
  | "NO_COLUMNS"
  | "NO_EVENTS"
  | "NO_NAME"
  | "BAD_DATE"
  | "END_BEFORE_START"
  | "BAD_GRADES"
  | "RECURRING"
  | "CANCELLED"
  | "TOO_MANY";

export interface CalendarFileProblem {
  code: CalendarFileProblemCode;
  /** The event (ICS) or the row as Excel numbers it (CSV) the problem is in; 0 for the file as a whole. */
  place: number;
  /** What was read there: the date, the name, the column. */
  value?: string;
}

export interface CalendarFile {
  format: "ICS" | "CSV";
  entries: CalendarEntry[];
  problems: CalendarFileProblem[];
}

/** A summary that is a day school begins or ends, not one it is shut. */
const TERM_DATE = /terminsstart|terminsslut|läsårsstart|läsårsslut|läsårets (första|sista)|första skoldag|sista skoldag|skolstart|skolavslutning|terminen (börjar|slutar)|höstterminen (börjar|slutar)|vårterminen (börjar|slutar)/i;

/** A summary that is the staff's day and not the pupils': the kind is STAFF_DAY. */
const STAFF_DAY = /studiedag|planeringsdag|konferensdag|kompetensdag|personaldag|utvecklingsdag|staff/i;

const kindOf = (name: string): BreakKind => (STAFF_DAY.test(name) ? "STAFF_DAY" : "HOLIDAY");

/** A real calendar day as YYYY-MM-DD, or null: 2027-02-30 is not one, and is not rolled over to 2 March. */
function realDay(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const back = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(back.getTime()) || back.toISOString().slice(0, 10) !== iso ? null : iso;
}

/**
 * A date as a cell or a file writes it: 2027-02-22, 2027/02/22, 20270222, and the day-first forms 22/2/2027,
 * 22.2.2027 and 22-2-2027. A day-first date is read day first, as a Swedish file means it; there is no month-first
 * reading, so 02/22/2027 is not a date.
 */
export function parseDateCell(value: string): string | null {
  const text = value.trim();
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (match) return realDay(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match) return realDay(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (match) return realDay(Number(match[3]), Number(match[2]), Number(match[1]));
  return null;
}

// ---- ICS

/** RFC 5545 3.1: a line that continues on the next one starts with a space or a tab there. */
const unfold = (text: string): string[] => text.replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");

/** RFC 5545 3.3.11: \n, \, \; and \\ in a text value. */
const unescapeText = (value: string): string =>
  value.replace(/\\([nN,;\\])/g, (_all, char: string) => (char === "n" || char === "N" ? " " : char)).trim();

interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

function readProperty(line: string): IcsProperty | null {
  // The value starts at the first colon outside a quoted parameter value.
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return null;
  const [name, ...rest] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const param of rest) {
    const equals = param.indexOf("=");
    if (equals > 0) params[param.slice(0, equals).toUpperCase()] = param.slice(equals + 1).replace(/^"|"$/g, "");
  }
  return { name: name!.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** The zone a school's days are counted in, which a time written in UTC (…Z) is read in. */
const SCHOOL_ZONE = "Europe/Stockholm";
const schoolClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: SCHOOL_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** A UTC instant as the school's wall clock reads it: 25 October 23:00Z is midnight of 26 October in Stockholm. */
function onSchoolClock(year: number, month: number, day: number, hour: number, minute: number, second: number) {
  const parts: Record<string, number> = {};
  for (const part of schoolClock.formatToParts(new Date(Date.UTC(year, month - 1, day, hour, minute, second)))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return { year: parts["year"]!, month: parts["month"]!, day: parts["day"]!, hour: parts["hour"]!, minute: parts["minute"]!, second: parts["second"]! };
}

/**
 * 20261026 or 20261026T000000(Z): the day it names, and whether it names a time of the day. A time with a Z is an
 * instant in UTC, and the day it names is the school's: a whole-day event a calendar program wrote as midnight of
 * Stockholm in UTC (20261025T230000Z) is the 26th, not the 25th. A time with no Z, or with a TZID, is read as written.
 */
function icsDate(value: string): { day: string; hasTime: boolean; midnight: boolean } | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!match) return null;
  let [year, month, dayOfMonth] = [Number(match[1]), Number(match[2]), Number(match[3])];
  let [hour, minute, second] = [Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0)];
  const hasTime = match[4] !== undefined;
  if (hasTime && match[7] === "Z" && realDay(year, month, dayOfMonth) && hour < 24 && minute < 60 && second < 61) {
    ({ year, month, day: dayOfMonth, hour, minute, second } = onSchoolClock(year, month, dayOfMonth, hour, minute, second));
  }
  const day = realDay(year, month, dayOfMonth);
  if (!day) return null;
  return { day, hasTime, midnight: hasTime && hour === 0 && minute === 0 && second === 0 };
}

function readIcs(text: string): CalendarFile {
  const problems: CalendarFileProblem[] = [];
  const entries: CalendarEntry[] = [];
  let event: IcsProperty[] | null = null;
  let number = 0;

  for (const line of unfold(text)) {
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      event = [];
      number += 1;
      continue;
    }
    if (upper === "END:VEVENT") {
      const current = event ?? [];
      event = null;
      const find = (name: string) => current.find((property) => property.name === name);
      const summary = unescapeText(find("SUMMARY")?.value ?? "");
      if (find("STATUS")?.value.trim().toUpperCase() === "CANCELLED") {
        problems.push({ code: "CANCELLED", place: number, value: summary });
        continue;
      }
      if (find("RRULE")) {
        problems.push({ code: "RECURRING", place: number, value: summary });
        continue;
      }
      if (!summary) {
        problems.push({ code: "NO_NAME", place: number });
        continue;
      }
      const start = icsDate(find("DTSTART")?.value ?? "");
      if (!start) {
        problems.push({ code: "BAD_DATE", place: number, value: find("DTSTART")?.value ?? "" });
        continue;
      }
      const endProperty = find("DTEND");
      let end = start.day;
      if (endProperty) {
        const parsed = icsDate(endProperty.value);
        if (!parsed) {
          problems.push({ code: "BAD_DATE", place: number, value: endProperty.value });
          continue;
        }
        // A whole-day event ends the day BEFORE its DTEND; one with a time ends on it, unless that time is
        // midnight, which is the same exclusive end.
        const exclusive = (!parsed.hasTime && !start.hasTime) || (parsed.midnight && parsed.day > start.day);
        end = exclusive ? addDays(parsed.day, -1) : parsed.day;
      }
      if (end < start.day) {
        problems.push({ code: "END_BEFORE_START", place: number, value: summary });
        continue;
      }
      entries.push({
        key: `FILE:${entries.length}`,
        source: "FILE",
        name: summary.slice(0, 120),
        kind: kindOf(summary),
        startDate: start.day,
        endDate: end,
        minGradeLevel: null,
        maxGradeLevel: null,
        origin: `event:${number}`,
        ...(TERM_DATE.test(summary) ? { looksLikeTermDate: true } : {}),
      });
      continue;
    }
    if (event) {
      const property = readProperty(line);
      if (property) event.push(property);
    }
  }
  if (number === 0) problems.push({ code: "NO_EVENTS", place: 0 });
  return { format: "ICS", ...capped(entries, problems) };
}

// ---- CSV

const COLUMN_ALIASES = {
  name: ["namn", "lov", "benamning", "rubrik", "titel", "summary", "name", "handelse", "beskrivning"],
  start: ["start", "fran", "startdatum", "forstadag", "from", "datum", "date", "startdate", "franochmed"],
  end: ["slut", "till", "slutdatum", "sistadag", "end", "to", "enddate", "tillochmed"],
  kind: ["typ", "art", "kind", "sort"],
  minGrade: ["franarskurs", "minarskurs", "mingradelevel", "arskursfran", "franak"],
  maxGrade: ["tillarskurs", "maxarskurs", "maxgradelevel", "arskurstill", "tillak"],
} as const;

function readCsv(text: string): CalendarFile {
  const problems: CalendarFileProblem[] = [];
  const parsed = parseCsv(text);
  const normalized = parsed.headers.map(normalizeHeader);
  const column = (aliases: readonly string[]): number => normalized.findIndex((header) => aliases.includes(header));
  const at = {
    name: column(COLUMN_ALIASES.name),
    start: column(COLUMN_ALIASES.start),
    end: column(COLUMN_ALIASES.end),
    kind: column(COLUMN_ALIASES.kind),
    minGrade: column(COLUMN_ALIASES.minGrade),
    maxGrade: column(COLUMN_ALIASES.maxGrade),
  };
  if (parsed.headers.length === 0 || at.name < 0 || at.start < 0) {
    problems.push({ code: "NO_COLUMNS", place: 0, value: parsed.headers.join(", ") });
    return { format: "CSV", entries: [], problems };
  }

  const entries: CalendarEntry[] = [];
  parsed.rows.forEach((row, index) => {
    const place = parsed.rowNumbers[index] ?? index + 2;
    const name = row[at.name]!.trim();
    if (!name) {
      problems.push({ code: "NO_NAME", place });
      return;
    }
    const start = parseDateCell(row[at.start]!);
    if (!start) {
      problems.push({ code: "BAD_DATE", place, value: row[at.start] });
      return;
    }
    const endCell = at.end >= 0 ? row[at.end]!.trim() : "";
    const end = endCell === "" ? start : parseDateCell(endCell);
    if (!end) {
      problems.push({ code: "BAD_DATE", place, value: endCell });
      return;
    }
    if (end < start) {
      problems.push({ code: "END_BEFORE_START", place, value: name });
      return;
    }
    const gradeCell = (position: number): number | null | "bad" => {
      const cell = position >= 0 ? row[position]!.trim() : "";
      if (cell === "") return null;
      const grade = Number(cell.replace(/^åk\s*/i, ""));
      return Number.isInteger(grade) && grade >= 0 && grade <= 12 ? grade : "bad";
    };
    const min = gradeCell(at.minGrade);
    const max = gradeCell(at.maxGrade);
    if (min === "bad" || max === "bad" || (min === null) !== (max === null) || (min !== null && max !== null && min > max)) {
      problems.push({ code: "BAD_GRADES", place, value: name });
      return;
    }
    const kindCell = at.kind >= 0 ? row[at.kind]!.trim() : "";
    entries.push({
      key: `FILE:${entries.length}`,
      source: "FILE",
      name: name.slice(0, 120),
      kind: kindCell !== "" ? kindOf(kindCell) : kindOf(name),
      startDate: start,
      endDate: end,
      minGradeLevel: min,
      maxGradeLevel: max,
      origin: `row:${place}`,
      ...(TERM_DATE.test(name) ? { looksLikeTermDate: true } : {}),
    });
  });
  if (entries.length === 0 && problems.length === 0) problems.push({ code: "NO_EVENTS", place: 0 });
  return { format: "CSV", ...capped(entries, problems) };
}

/** The first rows the gateway takes in one write, and a problem for the ones left. */
function capped(entries: CalendarEntry[], problems: CalendarFileProblem[]): Pick<CalendarFile, "entries" | "problems"> {
  if (entries.length <= MAX_CALENDAR_ROWS) return { entries, problems };
  return {
    entries: entries.slice(0, MAX_CALENDAR_ROWS),
    problems: [...problems, { code: "TOO_MANY", place: 0, value: String(entries.length) }],
  };
}

/**
 * A file's text as the entries it holds, and what could not be read. An ICS file is told by its content (a
 * VCALENDAR) or its name; anything else is read as a CSV.
 */
export function readCalendarFile(text: string, fileName: string): CalendarFile {
  const body = text.replace(/^﻿/, "");
  if (/^\s*BEGIN:VCALENDAR/i.test(body) || /\.ics$/i.test(fileName)) {
    if (!/BEGIN:VCALENDAR/i.test(body)) return { format: "ICS", entries: [], problems: [{ code: "NOT_A_CALENDAR", place: 0 }] };
    return readIcs(body);
  }
  return readCsv(body);
}
