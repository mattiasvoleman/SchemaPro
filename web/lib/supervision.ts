/*
 * Rastvaktsschema (migration 20261207090000): what GET /api/v1/supervision-rota
 * and /api/v1/supervision-areas answer, and the arithmetic the page lays
 * them out with. The breaks, the gaps and every teacher's minutes are the
 * gateway's (src/supervision); nothing here decides what is watched, only
 * where on the page it is drawn. No hooks, so a page test that mocks the
 * queries still has it.
 */

import type { TeacherSupervision } from "@/lib/staffing-supervision";

export type { TeacherSupervision };

/** A rastvaktsområde: a place the school watches, and in which breaks. */
export interface SupervisionArea {
  id: string;
  name: string;
  siteId: string | null;
  /** Inclusive 0..12; both null: every stage. */
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  duringRasts: boolean;
  duringLunch: boolean;
  /** Rastvakter at once, 0..10; 0 warns of nothing. */
  guardsNeeded: number;
  countsAsTeaching: boolean;
  /** Passes on the area, every läsår: what a delete takes with it. */
  shiftCount: number;
}

/** A lesson of the grundschema a pass runs during: the gateway's warning, not a refusal. */
export interface LessonClash {
  subject: string;
  group: string;
  dayOfWeek: number;
  /** HH:MM */
  startTime: string;
  endTime: string;
}

/** One pass: a teacher on an area, a weekday, a time, between two dates. */
export interface SupervisionShift {
  id: string;
  academicYearId: string;
  areaId: string;
  userId: string;
  dayOfWeek: number;
  /** HH:MM */
  startTime: string;
  endTime: string;
  /** yyyy-mm-dd, null for the läsår's own bound; on the pass's weekday when set. */
  validFrom: string | null;
  validTo: string | null;
  note: string | null;
  /** The day the teacher was deactivated; the pass watches until the day before. Null while active. */
  inactiveFrom: string | null;
  /** The teacher's lessons the pass runs during; the generator does not see passes yet. */
  lessonClashes: LessonClash[];
}

/** One break of one area on one weekday, as the gateway resolves it. */
export interface SupervisionBreak {
  areaId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  /** The rasts' names, "Lunch" for a meal. */
  names: string[];
  lunch: boolean;
  needed: number;
  /** The area-day's passes that run some minute of it. */
  shiftIds: string[];
}

/** A break with fewer rastvakter than it needs, over a stretch of the year. */
export interface SupervisionGap {
  areaId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  names: string[];
  lunch: boolean;
  needed: number;
  /** The fewest passes at once, and the first stretch of the break with that few. */
  fewest: number;
  shortFrom: string;
  shortTo: string;
  /** Inclusive yyyy-mm-dd: the first and the last date of the weekday the break is short on. */
  from: string;
  to: string;
  /** Short from the läsår's first day, and until its last. */
  fromYearStart: boolean;
  toYearEnd: boolean;
}

export interface SupervisionRota {
  academicYearId: string;
  year: { startDate: string; endDate: string };
  areas: SupervisionArea[];
  shifts: SupervisionShift[];
  breaks: SupervisionBreak[];
  gaps: SupervisionGap[];
  teachers: TeacherSupervision[];
}

/** Monday to Friday, and a weekend day a break or pass of the year is on. */
export function weekdaysOf(rota: Pick<SupervisionRota, "breaks" | "shifts">): number[] {
  const days = new Set([1, 2, 3, 4, 5]);
  for (const row of [...rota.breaks, ...rota.shifts]) days.add(row.dayOfWeek);
  return [...days].sort((a, b) => a - b);
}

/** One row of an area's grid: a break window, and the weekdays it falls on. */
export interface GridRow {
  key: string;
  startTime: string;
  endTime: string;
  names: string[];
  lunch: boolean;
  /** The break on each weekday that has it. */
  days: Map<number, SupervisionBreak>;
}

/**
 * An area's grid: one row per break of its week, in the order of the day —
 * a window and the names of its rasts. A Friday whose rast is at another
 * time is a row of its own with only Friday in it, rather than a row that
 * says two different times; so is a Friday rast at Monday's time under
 * another name, rather than a row whose heading names a rast some of its
 * days do not have.
 */
export function gridRowsOf(rota: Pick<SupervisionRota, "breaks">, areaId: string): GridRow[] {
  const rows = new Map<string, GridRow>();
  for (const row of rota.breaks) {
    if (row.areaId !== areaId) continue;
    const key = `${row.startTime}-${row.endTime}-${row.names.join("|")}`;
    const found = rows.get(key);
    if (found) {
      found.days.set(row.dayOfWeek, row);
      found.lunch ||= row.lunch;
    } else {
      rows.set(key, {
        key,
        startTime: row.startTime,
        endTime: row.endTime,
        names: [...row.names],
        lunch: row.lunch,
        days: new Map([[row.dayOfWeek, row]]),
      });
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.startTime.localeCompare(b.startTime) ||
      a.endTime.localeCompare(b.endTime) ||
      a.names.join(", ").localeCompare(b.names.join(", "), "sv"),
  );
}

/** An area's passes that run in no break of their day: the entrance at 07:45, the bus at 15:00. */
export function otherShiftsOf(rota: Pick<SupervisionRota, "breaks" | "shifts">, areaId: string): SupervisionShift[] {
  const inBreaks = new Set(rota.breaks.filter((row) => row.areaId === areaId).flatMap((row) => row.shiftIds));
  return rota.shifts
    .filter((shift) => shift.areaId === areaId && !inBreaks.has(shift.id))
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime));
}

/** The gaps of one break: the stretches of the year it is short of rastvakter. */
export function gapsOfBreak(rota: Pick<SupervisionRota, "gaps">, brk: SupervisionBreak): SupervisionGap[] {
  return rota.gaps.filter(
    (gap) =>
      gap.areaId === brk.areaId &&
      gap.dayOfWeek === brk.dayOfWeek &&
      gap.startTime === brk.startTime &&
      gap.endTime === brk.endTime,
  );
}

/** "08:05" from "08:05:00" or "08:05". */
export const clockOf = (value: string) => value.slice(0, 5);

const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
/** A wall clock of one day, 00:00 to 23:59. */
const isClock = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(clockOf(value));

/** A pass as the dialog edits it: clocks and dates as typed. */
export interface ShiftDraft {
  areaId: string;
  userId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  validFrom: string;
  validTo: string;
  note: string;
}

export type ShiftDraftFault =
  | "areaMissing"
  | "teacherMissing"
  | "startMissing"
  | "endMissing"
  | "endBeforeStart"
  | "toBeforeFrom"
  | "fromOutsideYear"
  | "toOutsideYear"
  | "noWeekday"
  | "noteTooLong";

export type ShiftField = "area" | "teacher" | "start" | "end" | "from" | "to" | "note";

/** The dialog field each fault is said beside, and focused on a refused save. */
export const FAULT_FIELD: Readonly<Record<ShiftDraftFault, ShiftField>> = {
  areaMissing: "area",
  teacherMissing: "teacher",
  startMissing: "start",
  endMissing: "end",
  endBeforeStart: "end",
  toBeforeFrom: "to",
  fromOutsideYear: "from",
  toOutsideYear: "to",
  noWeekday: "to",
  noteTooLong: "note",
};

/**
 * The field a fault is said at, for this draft: a pass that never runs is
 * Från's where Till is the läsår's own (empty), as the gateway names it.
 */
export function faultFieldOf(fault: ShiftDraftFault, draft: Pick<ShiftDraft, "validFrom" | "validTo">): ShiftField {
  return fault === "noWeekday" && draft.validFrom && !draft.validTo ? "from" : FAULT_FIELD[fault];
}

const DAY_MS = 86_400_000;
const isoWeekday = (day: string) => {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
};
const addDays = (day: string, days: number) =>
  new Date(new Date(`${day}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);

/**
 * The first and the last day of `dayOfWeek` from `from` to `to`, inclusive;
 * null when the span has none.
 */
export function weekdaySpan(dayOfWeek: number, from: string, to: string): { first: string; last: string } | null {
  const first = addDays(from, (dayOfWeek - isoWeekday(from) + 7) % 7);
  const last = addDays(to, -((isoWeekday(to) - dayOfWeek + 7) % 7));
  return first <= last ? { first, last } : null;
}

/**
 * A pass's dates when its weekday changes: a date already on the old weekday
 * (as the gateway stores them) moves to the new one in the same ISO week, as
 * the gateway moves a stored date the PATCH does not retype; a date typed off
 * the weekday is left as typed.
 */
export function datesForNewWeekday(
  draft: Pick<ShiftDraft, "dayOfWeek" | "validFrom" | "validTo">,
  dayOfWeek: number,
): { validFrom: string; validTo: string } {
  const move = (date: string) =>
    date && isoWeekday(date) === draft.dayOfWeek ? addDays(date, dayOfWeek - draft.dayOfWeek) : date;
  return { validFrom: move(draft.validFrom), validTo: move(draft.validTo) };
}

/**
 * A draft's dates as the gateway stores them (SupervisionService
 * datesOnTheWeekday): Från forward to the pass's first weekday, Till back to
 * its last, an empty one left empty — the läsår's own bound.
 */
export function datesOnTheWeekday(
  draft: Pick<ShiftDraft, "dayOfWeek" | "validFrom" | "validTo">,
  year: { startDate: string; endDate: string } | null,
): { validFrom: string; validTo: string } {
  const from = draft.validFrom || year?.startDate || "";
  const to = draft.validTo || year?.endDate || "";
  if (!from || !to) return { validFrom: draft.validFrom, validTo: draft.validTo };
  const span = weekdaySpan(draft.dayOfWeek, from, to);
  if (!span) return { validFrom: draft.validFrom, validTo: draft.validTo };
  return { validFrom: draft.validFrom ? span.first : "", validTo: draft.validTo ? span.last : "" };
}

/**
 * What the gateway would refuse in a draft, asked before it is sent so the
 * dialog can name the field: the same rules as SupervisionService (start
 * before end, Till not before Från, both inside the läsår, and the pass's
 * weekday between them, an empty date read as the läsår's own), not new ones.
 */
export function shiftDraftFault(
  draft: ShiftDraft,
  year: { startDate: string; endDate: string } | null,
): ShiftDraftFault | null {
  if (!draft.areaId) return "areaMissing";
  if (!draft.userId) return "teacherMissing";
  if (!isClock(draft.startTime)) return "startMissing";
  if (!isClock(draft.endTime)) return "endMissing";
  if (minutes(draft.endTime) <= minutes(draft.startTime)) return "endBeforeStart";
  if (draft.validFrom && draft.validTo && draft.validTo < draft.validFrom) return "toBeforeFrom";
  if (year && draft.validFrom && (draft.validFrom < year.startDate || draft.validFrom > year.endDate)) return "fromOutsideYear";
  if (year && draft.validTo && (draft.validTo < year.startDate || draft.validTo > year.endDate)) return "toOutsideYear";
  const from = draft.validFrom || year?.startDate;
  const to = draft.validTo || year?.endDate;
  if (from && to && !weekdaySpan(draft.dayOfWeek, from, to)) return "noWeekday";
  if ([...draft.note.trim()].length > 200) return "noteTooLong";
  return null;
}

/**
 * The body a draft is saved as: empty dates and note as null, clocks as
 * HH:MM, and the dates on the pass's weekday as the gateway stores them.
 */
export function shiftBody(draft: ShiftDraft, year: { startDate: string; endDate: string } | null = null) {
  const dates = datesOnTheWeekday(draft, year);
  return {
    areaId: draft.areaId,
    userId: draft.userId,
    dayOfWeek: draft.dayOfWeek,
    startTime: clockOf(draft.startTime),
    endTime: clockOf(draft.endTime),
    validFrom: dates.validFrom || null,
    validTo: dates.validTo || null,
    note: draft.note.trim() || null,
  };
}

/**
 * The teacher's other pass that shares a minute with the draft on its
 * weekday, on a date both run (the draft's dates moved onto its weekday): the clash the gateway would refuse
 * (SUPERVISION_SHIFT_CLASH, the table's one-place-at-a-time EXCLUDE), found
 * in the schedule the page already holds so the dialog can name it before
 * the save. Null without one, or without a complete window.
 */
export function clashOf(
  draft: ShiftDraft,
  shifts: readonly SupervisionShift[],
  selfId: string | null,
  year: { startDate: string; endDate: string } | null = null,
): SupervisionShift | null {
  if (!draft.userId || !isClock(draft.startTime) || !isClock(draft.endTime)) return null;
  const start = minutes(draft.startTime);
  const end = minutes(draft.endTime);
  // The dates the pass would be stored with, as the EXCLUDE reads them.
  const dates = datesOnTheWeekday(draft, year);
  const from = dates.validFrom || null;
  const to = dates.validTo || null;
  return (
    shifts.find(
      (other) =>
        other.id !== selfId &&
        other.userId === draft.userId &&
        other.dayOfWeek === draft.dayOfWeek &&
        minutes(other.startTime) < end &&
        minutes(other.endTime) > start &&
        (to === null || other.validFrom === null || other.validFrom <= to) &&
        (from === null || other.validTo === null || other.validTo >= from),
    ) ?? null
  );
}

/**
 * A gap's dates as a new pass's: a bound on the läsår's own is left empty,
 * so the pass follows the year if its bounds move, as an undated one does.
 */
export function datesOfGap(
  gap: Pick<SupervisionGap, "from" | "to" | "fromYearStart" | "toYearEnd">,
): { validFrom: string; validTo: string } {
  return {
    validFrom: gap.fromYearStart ? "" : gap.from,
    validTo: gap.toYearEnd ? "" : gap.to,
  };
}

/** How many breaks the gaps are about: one break short in two stretches of the year is one break. */
export function brokenBreakCount(gaps: readonly SupervisionGap[]): number {
  return new Set(gaps.map((gap) => `${gap.areaId}|${gap.dayOfWeek}|${gap.startTime}|${gap.endTime}`)).size;
}
