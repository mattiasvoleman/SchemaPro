/**
 * Lektionslogg: the types of the gateway's answers (src/lesson-log) and the
 * pure steps between them and the screen. No React and no fetching: the
 * hooks are lib/lesson-log-queries.ts, loaded only by the pages and lazy
 * cards that show a log, so the core-tier routes carry neither.
 *
 * A log is a lesson's topic and homework, which the teacher chooses to
 * write and the pupils on the lesson and their guardians read. A note is the
 * lesson's own teacher's to its substitute, which only staff read. Nobody is
 * told that either was written, and neither can be answered: messages
 * between school and home stay in the school's lärplattform.
 */

/** The database's limits (20261203090000), in characters. */
export const TOPIC_MAX = 200;
export const HOMEWORK_MAX = 1000;
export const NOTE_MAX = 2000;

export type LessonCallerRole = "REGULAR" | "SUBSTITUTE" | "COLLEAGUE" | "ADMIN";

export interface LessonLogText {
  topic: string | null;
  homework: string | null;
  writtenBy: string | null;
  updatedAt: string;
}

export interface SubstituteNoteText {
  body: string;
  writtenBy: string | null;
  updatedAt: string;
}

/** GET /api/v1/lesson-logs/lessons/:id. Times are HH:MM on the school's clock. */
export interface LessonLogLesson {
  lesson: {
    id: string;
    date: string;
    start: string;
    end: string;
    status: string;
    subject: string;
    subjectColor: string | null;
    groups: string[];
    room: string | null;
    teachers: { name: string; role: string }[];
  };
  role: LessonCallerRole;
  may: { writeLog: boolean; readNote: boolean; writeNote: boolean };
  log: LessonLogText | null;
  note: SubstituteNoteText | null;
}

/** GET /api/v1/lesson-logs?from&to: one of the caller's own lessons with something written. */
export interface LessonLogEntry {
  lessonId: string;
  topic: string | null;
  homework: string | null;
  /** A teacher's own lessons only. */
  substituteNote?: string | null;
}

/** GET /api/v1/lesson-logs/handed-over: a lesson the teacher handed over for an absence. */
export interface HandedOverLesson {
  lessonId: string;
  date: string;
  startsAt: string;
  endsAt: string;
  subjectId: string;
  studentGroupId: string;
  roomId: string | null;
  status: string;
  /** The cover decision: SUBSTITUTE, CANCELLED, SUPERVISED_STUDY or CO_TEACHER. */
  decision: string;
  /** Whether the teacher has left the substitute a note. */
  noted: boolean;
}

/** The board's status words (coverStatus) for a decision. */
export const DECISION_STATUS: Readonly<Record<string, string>> = {
  SUBSTITUTE: "COVERED",
  CANCELLED: "CANCELLED",
  SUPERVISED_STUDY: "HANDLED_SUPERVISED_STUDY",
  CO_TEACHER: "HANDLED_CO_TEACHER",
};

export interface ClassBookLesson {
  id: string;
  date: string;
  start: string;
  end: string;
  status: string;
  subject: string;
  groups: string[];
  room: string | null;
  teachers: { name: string; substitute: boolean }[];
  topic: string | null;
  homework: string | null;
  /** Another group's lesson: how many of the class's pupils are on it; null for the class's own. */
  attending: number | null;
}

/** GET /api/v1/lesson-logs/class-book. */
export interface ClassBook {
  school: string;
  group: { id: string; name: string; kind: string };
  from: string;
  to: string;
  timezone: string;
  pupils: number;
  lessons: ClassBookLesson[];
}

/** The gateway's longest periods, in days (lesson-log.service.ts, class-book.service.ts). */
export const RANGE_MAX_DAYS = 42;
export const CLASS_BOOK_MAX_DAYS = 200;

/**
 * Trimmed, and null for nothing, as the gateway stores it: what a form
 * compares against the saved text to know whether anything changed.
 */
export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.replace(/\r\n?/g, "\n").replace(/^[ \t\n]+|[ \t\n]+$/g, "");
  return trimmed === "" ? null : trimmed;
}

/** Characters as the database counts them: a code point each. */
export function textLength(value: string): number {
  return [...value].length;
}

/** Whether the log's form says something other than what is saved. */
export function logChanged(saved: LessonLogText | null, topic: string, homework: string): boolean {
  return cleanText(topic) !== (saved?.topic ?? null) || cleanText(homework) !== (saved?.homework ?? null);
}

/** Whether the note's form says something other than what is saved. */
export function noteChanged(saved: SubstituteNoteText | null, body: string): boolean {
  return cleanText(body) !== (saved?.body ?? null);
}

/** The entries by lesson id, for a list that walks the week's lessons. */
export function entriesByLesson(entries: readonly LessonLogEntry[] | undefined): Map<string, LessonLogEntry> {
  return new Map((entries ?? []).map((entry) => [entry.lessonId, entry]));
}

/** A YYYY-MM-DD shifted by whole days, by its components (no reader zone involved). */
export function shiftDay(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/** Days from `from` to `to`, both counted; 0 when `to` is before `from`. */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}

/** A YYYY-MM-DD that exists in the calendar. */
export function isDay(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** The klassbok's period as it opens: Monday to Friday of the week holding `today`. */
export function defaultPeriod(today: string): { from: string; to: string } {
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
  const from = shiftDay(today, 1 - weekday);
  return { from, to: shiftDay(from, 4) };
}

/**
 * The period a route opens the klassbok on: the URL's days when they are
 * days, else Monday to Friday of the school's week, worked out once on the
 * server (a plain module, so a server page may call it). A default from
 * `new Date()` in the client component would be the server's
 * day in the HTML and the reader's in the browser, and around midnight on a
 * Monday the two are different weeks.
 */
export function classBookPeriod(from: string | null, to: string | null, now = new Date()): { from: string; to: string } {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(now);
  const fallback = defaultPeriod(today);
  return { from: isDay(from) ? from : fallback.from, to: isDay(to) ? to : fallback.to };
}

/** The klassbok's lessons by date, in the order the gateway gave them. */
export function byDate(lessons: readonly ClassBookLesson[]): Array<{ date: string; lessons: ClassBookLesson[] }> {
  const days: Array<{ date: string; lessons: ClassBookLesson[] }> = [];
  for (const lesson of lessons) {
    const last = days[days.length - 1];
    if (last && last.date === lesson.date) last.lessons.push(lesson);
    else days.push({ date: lesson.date, lessons: [lesson] });
  }
  return days;
}
