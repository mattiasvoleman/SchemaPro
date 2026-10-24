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
  /** yyyy-mm-dd, null for the läsår's own bound. */
  validFrom: string | null;
  validTo: string | null;
  note: string | null;
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
 * An area's grid: one row per break window of its week, in the order of the
 * day. A Friday whose rast is at another time is a row of its own with only
 * Friday in it, rather than a row that says two different times.
 */
export function gridRowsOf(rota: Pick<SupervisionRota, "breaks">, areaId: string): GridRow[] {
  const rows = new Map<string, GridRow>();
  for (const row of rota.breaks) {
    if (row.areaId !== areaId) continue;
    const key = `${row.startTime}-${row.endTime}`;
    const found = rows.get(key);
    if (found) {
      found.days.set(row.dayOfWeek, row);
      for (const name of row.names) if (!found.names.includes(name)) found.names.push(name);
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
  return [...rows.values()].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime));
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
  | "timeMissing"
  | "endBeforeStart"
  | "toBeforeFrom"
  | "outsideYear"
  | "noWeekday"
  | "noteTooLong";

/** The dialog field each fault is said beside, and focused on a refused save. */
export const FAULT_FIELD: Readonly<Record<ShiftDraftFault, "area" | "teacher" | "start" | "end" | "from" | "to" | "note">> = {
  areaMissing: "area",
  teacherMissing: "teacher",
  timeMissing: "start",
  endBeforeStart: "end",
  toBeforeFrom: "to",
  outsideYear: "from",
  noWeekday: "to",
  noteTooLong: "note",
};

/**
 * What the gateway would refuse in a draft, asked before it is sent so the
 * dialog can name the field: the same rules as SupervisionService (start
 * before end, Till not before Från, both inside the läsår), not new ones.
 */
export function shiftDraftFault(
  draft: ShiftDraft,
  year: { startDate: string; endDate: string } | null,
): ShiftDraftFault | null {
  if (!draft.areaId) return "areaMissing";
  if (!draft.userId) return "teacherMissing";
  if (!isClock(draft.startTime) || !isClock(draft.endTime)) return "timeMissing";
  if (minutes(draft.endTime) <= minutes(draft.startTime)) return "endBeforeStart";
  if (draft.validFrom && draft.validTo && draft.validTo < draft.validFrom) return "toBeforeFrom";
  if (year) {
    for (const value of [draft.validFrom, draft.validTo]) {
      if (value && (value < year.startDate || value > year.endDate)) return "outsideYear";
    }
  }
  if (draft.validFrom && draft.validTo) {
    const from = new Date(`${draft.validFrom}T00:00:00Z`);
    const first = from.getUTCDay() === 0 ? 7 : from.getUTCDay();
    const offset = (draft.dayOfWeek - first + 7) % 7;
    if (new Date(from.getTime() + offset * 86_400_000).toISOString().slice(0, 10) > draft.validTo) return "noWeekday";
  }
  if ([...draft.note.trim()].length > 200) return "noteTooLong";
  return null;
}

/** The body a draft is saved as: empty dates and note as null, clocks as HH:MM. */
export function shiftBody(draft: ShiftDraft) {
  return {
    areaId: draft.areaId,
    userId: draft.userId,
    dayOfWeek: draft.dayOfWeek,
    startTime: clockOf(draft.startTime),
    endTime: clockOf(draft.endTime),
    validFrom: draft.validFrom || null,
    validTo: draft.validTo || null,
    note: draft.note.trim() || null,
  };
}

/**
 * The teacher's other pass that shares a minute with the draft on its
 * weekday, on a date both run: the clash the gateway would refuse
 * (SUPERVISION_SHIFT_CLASH, the table's one-place-at-a-time EXCLUDE), found
 * in the schedule the page already holds so the dialog can name it before
 * the save. Null without one, or without a complete window.
 */
export function clashOf(
  draft: ShiftDraft,
  shifts: readonly SupervisionShift[],
  selfId: string | null,
): SupervisionShift | null {
  if (!draft.userId || !isClock(draft.startTime) || !isClock(draft.endTime)) return null;
  const start = minutes(draft.startTime);
  const end = minutes(draft.endTime);
  const from = draft.validFrom || null;
  const to = draft.validTo || null;
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
