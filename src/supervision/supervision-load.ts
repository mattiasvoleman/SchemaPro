import type { TeacherDutyKind } from '@prisma/client';
import { dutyStandardWeekMinutes, type LoadDuty } from '../staffing/teacher-load';
import { peakPerWeekByKey, teachingWeeks, type ClosedRange, type YearBounds } from '../staffing/teaching-weeks';

/**
 * RASTVAKT I BELASTNINGEN (Rastvaktsschema, 20261207090000): what a teacher's
 * passes in the rastvaktsschema add to their tjänst, and what becomes of the
 * uppdrag the school typed for rastvakt before it had a schedule.
 *
 * A PASS IS AN UPPDRAG. Each pass is one LoadDuty: its minutes (end − start)
 * once a week, Från and Till its own, counted against the target only when
 * its area says so (SupervisionArea.countsAsTeaching). It then goes through
 * exactly the arithmetic a dated uppdrag does (teacher-load.ts): its
 * standardvecka is minutes × its share of the year's teaching weeks with
 * school-wide lov out, its annual hours are its minutes over the weeks it
 * runs, and the toppvecka is the busiest ISO week. Every figure the load
 * states — uppdrag, saldo where counted, timmar per år, the toppvecka — and
 * every reader of the load (the report, the checks a write asks, the teacher
 * suggestions, the bemanningsförslag) get it through readLoadInput, so "how
 * much does Anna carry" has one answer. A pass is weekly, as an uppdrag is:
 * a Monday lov inside a week that is otherwise taught does not shorten it,
 * the same imprecision an uppdrag with fixed times has.
 *
 * THE RASTVAKT UPPDRAG BECOMES THE RAM. A school that counted rastvakt before
 * typed it as an uppdrag of the kind RASTVAKT, "60 min/vecka". Once the
 * schedule gives a teacher passes, that figure is the ram (budget) the
 * schedule is planned against, not a second rastvakt: in every week one of
 * the teacher's passes runs, their RASTVAKT uppdrag stop counting, and in
 * the weeks none does they count as before. Weeks, not days, as everything
 * an uppdrag charges is counted (passDays). So a schedule entered for the
 * spring term leaves the autumn's typed figure in place, and a teacher with
 * no pass at all — every teacher at a school that never opens the page — is
 * charged exactly the uppdrag they always were (the input is the same
 * objects, untouched). Only RASTVAKT: a mentorskap is not a rast.
 *
 * Dates are yyyy-mm-dd strings and compare as dates, as everywhere in the
 * load's pure half.
 */

/** A pass, as the load reads it. */
export interface LoadShift {
  userId: string;
  /** Minutes from midnight. */
  start: number;
  end: number;
  /** Inclusive yyyy-mm-dd, or null for the year's own bound. */
  validFrom: string | null;
  validTo: string | null;
  /** The area's SupervisionArea.countsAsTeaching. */
  countsAsTeaching: boolean;
}

/**
 * A pass as the load charges it: a deactivated teacher's runs until the day
 * before they were deactivated (`inactiveFrom`, the school's date), as it
 * watches in supervision-coverage.ts, and is no pass at all when that is
 * before it starts. Null for the latter.
 */
export function chargedShift(shift: LoadShift, inactiveFrom: string | null, year: YearBounds): LoadShift | null {
  if (inactiveFrom === null) return shift;
  const lastDay = dayBefore(inactiveFrom);
  const validTo = shift.validTo === null || shift.validTo > lastDay ? lastDay : shift.validTo;
  if (validTo < (shift.validFrom ?? year.startDate)) return null;
  return { ...shift, validTo };
}

/** An uppdrag as readLoadInput reads it: the load's fields and its kind. */
export interface KindedDuty extends LoadDuty {
  kind: TeacherDutyKind;
}

/** One teacher's rastvakt, as GET /staffing/load's `supervision` states it. */
export interface TeacherSupervision {
  userId: string;
  /** Passes of the year. */
  shiftCount: number;
  /** The passes' standardvecka, whole minutes. */
  minutesPerWeek: number;
  /** The part counted against the target (areas marked countsAsTeaching). */
  countedMinutesPerWeek: number;
  /** The busiest ISO week of the passes, whole minutes. */
  peakMinutesPerWeek: number;
  /** The passes over the weeks they run, hours to one decimal. */
  hoursPerYear: number;
  /**
   * The ram: the teacher's RASTVAKT uppdrag over the whole year, standardvecka,
   * whole minutes — what the schedule is planned against. Null without one.
   */
  ramMinutesPerWeek: number | null;
  /** The part of the ram still counted: the weeks no pass runs in. */
  ramCountedMinutesPerWeek: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const dayAfter = (day: string): string =>
  new Date(new Date(`${day}T00:00:00.000Z`).getTime() + DAY_MS).toISOString().slice(0, 10);
const dayBefore = (day: string): string =>
  new Date(new Date(`${day}T00:00:00.000Z`).getTime() - DAY_MS).toISOString().slice(0, 10);
const round1 = (value: number): number => Math.round(value * 10) / 10;

/** A pass as the uppdrag it is charged as. */
export function shiftAsDuty(shift: LoadShift): LoadDuty {
  return {
    userId: shift.userId,
    minutesPerWeek: shift.end - shift.start,
    countsAsTeaching: shift.countsAsTeaching,
    // Only when dated, as readLoadInput writes an uppdrag.
    ...(shift.validFrom ? { validFrom: shift.validFrom } : {}),
    ...(shift.validTo ? { validTo: shift.validTo } : {}),
  };
}

/** [from, to] inclusive, inside the year. */
interface Span {
  from: string;
  to: string;
}

function clamp(validFrom: string | null | undefined, validTo: string | null | undefined, year: YearBounds): Span | null {
  const from = validFrom && validFrom > year.startDate ? validFrom : year.startDate;
  const to = validTo && validTo < year.endDate ? validTo : year.endDate;
  return from <= to ? { from, to } : null;
}

const weekday = (day: string): number => {
  const value = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return value === 0 ? 7 : value;
};
const shift = (day: string, days: number): string =>
  new Date(new Date(`${day}T00:00:00.000Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);

/**
 * The weeks some pass of the teacher runs in, as disjoint spans in order,
 * each from a Monday to a Sunday (or the year's bound). WHOLE WEEKS because
 * an uppdrag is weekly: the week arithmetic (teaching-weeks.ts) charges every
 * ISO week a period touches as a week, so a ram cut at the day a pass ends —
 * a Friday Till, a one-day pass — would leave a piece in the same week as
 * the pass, and that week would be charged the ram and the pass both. A week
 * belongs to the passes if one of them runs in it, and the ram counts only
 * in the weeks none does.
 */
function passDays(shifts: readonly LoadShift[], year: YearBounds): Span[] {
  const spans = shifts
    .map((pass) => clamp(pass.validFrom, pass.validTo, year))
    .filter((span): span is Span => span !== null)
    .map((span) => clamp(shift(span.from, 1 - weekday(span.from)), shift(span.to, 7 - weekday(span.to)), year)!)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.from <= dayAfter(last.to)) {
      if (span.to > last.to) last.to = span.to;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** A duty's dates less the covered spans: the pieces it still runs alone. */
function uncoveredPieces(duty: LoadDuty, covered: readonly Span[], year: YearBounds): Span[] {
  const own = clamp(duty.validFrom, duty.validTo, year);
  if (!own) return [];
  const pieces: Span[] = [];
  let from = own.from;
  for (const span of covered) {
    if (span.to < from) continue;
    if (span.from > own.to) break;
    // span.from <= own.to here, so the day before it is inside the duty.
    if (span.from > from) pieces.push({ from, to: dayBefore(span.from) });
    from = dayAfter(span.to);
    if (from > own.to) return pieces;
  }
  if (from <= own.to) pieces.push({ from, to: own.to });
  return pieces;
}

/**
 * The year's uppdrag with the rastvaktsschema in them: every pass as an
 * uppdrag, and each RASTVAKT uppdrag of a teacher with passes cut down to the
 * dates none of their passes runs. A teacher without a pass keeps their
 * uppdrag as the same objects; with no pass at all the list is returned as it
 * came.
 */
export function withSupervision(
  duties: readonly KindedDuty[],
  shifts: readonly LoadShift[],
  year: YearBounds,
): LoadDuty[] {
  const strip = ({ kind: _kind, ...duty }: KindedDuty): LoadDuty => duty;
  if (shifts.length === 0) return duties.map(strip);
  const byTeacher = new Map<string, LoadShift[]>();
  for (const shift of shifts) {
    const list = byTeacher.get(shift.userId);
    if (list) list.push(shift);
    else byTeacher.set(shift.userId, [shift]);
  }
  const covered = new Map([...byTeacher].map(([userId, own]) => [userId, passDays(own, year)]));
  const out: LoadDuty[] = [];
  for (const duty of duties) {
    const spans = covered.get(duty.userId);
    if (duty.kind !== 'RASTVAKT' || !spans || spans.length === 0) {
      out.push(strip(duty));
      continue;
    }
    for (const piece of uncoveredPieces(duty, spans, year)) {
      out.push({
        userId: duty.userId,
        minutesPerWeek: duty.minutesPerWeek,
        countsAsTeaching: duty.countsAsTeaching,
        validFrom: piece.from,
        validTo: piece.to,
      });
    }
  }
  for (const shift of shifts) out.push(shiftAsDuty(shift));
  return out;
}

/**
 * Each teacher's rastvakt beside their load, for the teachers with a pass:
 * the passes' figures, and the ram their RASTVAKT uppdrag set. `duties` are
 * the year's uppdrag as stored, before withSupervision.
 */
export function supervisionOfTeachers(
  duties: readonly KindedDuty[],
  shifts: readonly LoadShift[],
  year: YearBounds,
  closures: ClosedRange[],
): TeacherSupervision[] {
  if (shifts.length === 0) return [];
  const asDuties = shifts.map(shiftAsDuty);
  const standardWeek = (duty: LoadDuty) => dutyStandardWeekMinutes(duty, year, closures);
  const peaks = peakPerWeekByKey(
    asDuties.map((duty) => ({ duty, startDate: duty.validFrom ?? null, endDate: duty.validTo ?? null })),
    year,
    (item) => item.duty.userId,
    (item) => item.duty.minutesPerWeek,
  );
  const teachers = [...new Set(shifts.map((shift) => shift.userId))].sort();
  return teachers.map((userId) => {
    const own = asDuties.filter((duty) => duty.userId === userId);
    const spans = passDays(
      shifts.filter((shift) => shift.userId === userId),
      year,
    );
    // An uppdrag's annual hours, as teacher-load.ts counts a dated one: its
    // minutes over the teaching weeks it runs, school-wide lov out (a null
    // grade applies only those).
    const annual = own.reduce(
      (sum, duty) =>
        sum +
        duty.minutesPerWeek *
          teachingWeeks({ startDate: duty.validFrom ?? null, endDate: duty.validTo ?? null }, year, closures, null),
      0,
    );
    const ram = duties.filter((duty) => duty.userId === userId && duty.kind === 'RASTVAKT');
    const ramKept = ram.flatMap((duty) =>
      uncoveredPieces(duty, spans, year).map((piece) => ({
        minutesPerWeek: duty.minutesPerWeek,
        validFrom: piece.from,
        validTo: piece.to,
      })),
    );
    return {
      userId,
      shiftCount: own.length,
      minutesPerWeek: Math.round(own.reduce((sum, duty) => sum + standardWeek(duty), 0)),
      countedMinutesPerWeek: Math.round(
        own.filter((duty) => duty.countsAsTeaching).reduce((sum, duty) => sum + standardWeek(duty), 0),
      ),
      peakMinutesPerWeek: Math.round(peaks.get(userId) ?? 0),
      hoursPerYear: round1(annual / 60),
      ramMinutesPerWeek: ram.length === 0 ? null : Math.round(ram.reduce((sum, duty) => sum + standardWeek(duty), 0)),
      ramCountedMinutesPerWeek: Math.round(
        ramKept.reduce((sum, duty) => sum + dutyStandardWeekMinutes(duty, year, closures), 0),
      ),
    };
  });
}

/**
 * A teacher's ram alone: their RASTVAKT uppdrag over the whole year,
 * standardvecka, whole minutes; null without one. For a teacher the schedule
 * has no pass for yet, whose ram therefore still counts whole.
 */
export function rastvaktRam(
  duties: readonly KindedDuty[],
  userId: string,
  year: YearBounds,
  closures: ClosedRange[],
): number | null {
  const ram = duties.filter((duty) => duty.userId === userId && duty.kind === 'RASTVAKT');
  if (ram.length === 0) return null;
  return Math.round(ram.reduce((sum, duty) => sum + dutyStandardWeekMinutes(duty, year, closures), 0));
}
