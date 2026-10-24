import { rastsForSpan, type RastRow } from '../calendar/rasts-for-span';
import type { ClosedRange, YearBounds } from '../staffing/teaching-weeks';

/**
 * WHICH BREAKS NOBODY WATCHES (Rastvaktsschema, 20261202090000): the breaks
 * each rastvaktsområde is watched in, and where the schedule leaves one with
 * fewer rastvakter than the area needs.
 *
 * AN AREA'S BREAKS ARE ITS STAGES'. An area is watched while any årskurs of
 * its span is out (overlap, as every stage span here matches; no span is
 * every stage): during their rasts when duringRasts, during their meal when
 * duringLunch. Each årskurs's rasts on a weekday are the rule publish and the
 * engine read (rasts-for-span.ts: a day-specific row shadows only the
 * every-day rows it overlaps); its meal is the lunchsittningar that speak
 * about it that day (a day-specific row replaces the every-day ones, the
 * engine's servings.py), or the school's lunch window where none does — and
 * no meal at all at a school whose lunch is off. The windows of the area's
 * årskurser are then laid together: two that overlap are one break, since
 * the yard has pupils on it from the first to go out to the last to come in.
 * Two that only touch stay two (the break's names stay readable), and the
 * coverage below reads them one after the other all the same.
 *
 * Only the årskurser the year has classes in: a phantom seventh year at a
 * F–6 school would otherwise eat at the school's lunch window, which no
 * sitting speaks about, and the hall would be watched for nobody.
 *
 * Weekdays are Monday to Friday, and Saturday or Sunday only where a row is
 * written for that day: "every day" is every teaching day, as for a rast.
 *
 * WATCHED, MINUTE BY MINUTE. A pass covers the minutes it runs, whatever
 * break it was planned for: two teachers 11:30–12:00 and 12:00–12:30 watch a
 * lunch of 11:30–12:30 together. A break is short of rastvakter when at some
 * minute fewer passes of the area run than it needs (guardsNeeded); the gap
 * names the fewest, and the first stretch of the break they are that few.
 * An area that needs 0 is never short.
 *
 * DATED, AS THE SCHEDULE IS. Passes have Från and Till, so the answer can
 * differ through the year: the year is cut at every date a pass of the
 * area-day starts or ends, and each stretch between is judged once. A stretch
 * with no school day on that weekday — a lov that closes the whole school, or
 * every årskurs of the area — asks nothing. Stretches with the same answer
 * are told as one, from the first date to the last, across a lov between
 * them. A lov for some grades does not narrow a break's window: it is
 * reported a day too often rather than a day too few.
 *
 * PURE. The service reads the rows (supervision.service.ts) and hands them
 * in; nothing here reads a clock or the database.
 */

export interface CoverageArea {
  id: string;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  duringRasts: boolean;
  duringLunch: boolean;
  guardsNeeded: number;
}

/** A lunchsittning, in minutes from midnight. */
export interface CoverageServing {
  minGradeLevel: number;
  maxGradeLevel: number;
  dayOfWeek: number | null;
  start: number;
  end: number;
}

export interface CoverageShift {
  id: string;
  areaId: string;
  dayOfWeek: number;
  /** Minutes from midnight. */
  start: number;
  end: number;
  /** Inclusive yyyy-mm-dd, or null for the year's own bound. */
  validFrom: string | null;
  validTo: string | null;
}

export interface CoverageInput {
  year: YearBounds;
  closures: readonly ClosedRange[];
  areas: readonly CoverageArea[];
  rasts: readonly RastRow[];
  servings: readonly CoverageServing[];
  /** The school's lunch window when its lunch is on; null when it is off. */
  lunch: { start: number; end: number } | null;
  /**
   * The årskurser the year has (its classes' gradeLevel). An area with no
   * span is watched for these, so a F–6 school's hall is not watched for a
   * seventh year's meal at the school's window. Empty (no class yet): every
   * årskurs 0..12.
   */
  grades: readonly number[];
  shifts: readonly CoverageShift[];
}

/** One break of one area on one weekday. */
export interface AreaBreak {
  areaId: string;
  dayOfWeek: number;
  start: number;
  end: number;
  /** The rasts' names in the order of the day, "Lunch" for a meal. Never empty. */
  names: string[];
  /** Whether a meal is part of it. */
  lunch: boolean;
  needed: number;
  /** The area-day's passes that run some minute of it, on any of their dates. */
  shiftIds: string[];
}

/** A break with fewer rastvakter than it needs, over a stretch of the year. */
export interface CoverageGap {
  areaId: string;
  dayOfWeek: number;
  start: number;
  end: number;
  names: string[];
  lunch: boolean;
  needed: number;
  /** The fewest passes running at once, at some minute of the break. */
  fewest: number;
  /** The first stretch of the break with that few. */
  shortFrom: number;
  shortTo: number;
  /** Inclusive yyyy-mm-dd: the first and last date of the stretch. */
  from: string;
  to: string;
}

export interface Coverage {
  breaks: AreaBreak[];
  gaps: CoverageGap[];
}

const LUNCH = 'Lunch';
const DAY_MS = 24 * 60 * 60 * 1000;
const asDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
const asDay = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (day: string, days: number) => asDay(new Date(asDate(day).getTime() + days * DAY_MS));
const isoWeekday = (day: string) => {
  const weekday = asDate(day).getUTCDay();
  return weekday === 0 ? 7 : weekday;
};
const minutesOf = (time: Date) => time.getUTCHours() * 60 + time.getUTCMinutes();

interface Window {
  start: number;
  end: number;
  names: string[];
  lunch: boolean;
}

function gradesOf(area: CoverageArea, grades: readonly number[]): number[] {
  const min = area.minGradeLevel ?? 0;
  const max = area.maxGradeLevel ?? 12;
  const span = Array.from({ length: max - min + 1 }, (_, index) => min + index);
  return grades.length === 0 ? span : span.filter((grade) => grades.includes(grade));
}

/** The meal one årskurs has on one weekday: its sittings, or the school's window. */
function mealsOf(input: CoverageInput, grade: number, dayOfWeek: number): Window[] {
  if (!input.lunch) return [];
  const matching = input.servings.filter((row) => grade >= row.minGradeLevel && grade <= row.maxGradeLevel);
  const today = matching.filter((row) => row.dayOfWeek === dayOfWeek);
  const open = today.length > 0 ? today : matching.filter((row) => row.dayOfWeek === null);
  const windows = open.length > 0 ? open : [input.lunch];
  return windows.map((row) => ({ start: row.start, end: row.end, names: [LUNCH], lunch: true }));
}

function breaksOfDay(input: CoverageInput, area: CoverageArea, dayOfWeek: number): Window[] {
  const windows: Window[] = [];
  for (const grade of gradesOf(area, input.grades)) {
    if (area.duringRasts) {
      for (const rast of rastsForSpan([...input.rasts], grade, dayOfWeek)) {
        windows.push({ start: minutesOf(rast.startTime), end: minutesOf(rast.endTime), names: [rast.name], lunch: false });
      }
    }
    if (area.duringLunch) windows.push(...mealsOf(input, grade, dayOfWeek));
  }
  windows.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Window[] = [];
  for (const window of windows) {
    const last = merged[merged.length - 1];
    if (last && window.start < last.end) {
      last.end = Math.max(last.end, window.end);
      for (const name of window.names) if (!last.names.includes(name)) last.names.push(name);
      last.lunch ||= window.lunch;
    } else {
      merged.push({ ...window, names: [...window.names] });
    }
  }
  return merged;
}

/** Monday to Friday, and a weekend day a rast or sitting is written for. */
function weekdaysOf(input: CoverageInput): number[] {
  const days = new Set([1, 2, 3, 4, 5]);
  for (const row of [...input.rasts, ...input.servings]) {
    if (row.dayOfWeek !== null) days.add(row.dayOfWeek);
  }
  return [...days].sort((a, b) => a - b);
}

/** Whether a closure shuts the area on `day`: the whole school, or every årskurs of its span. */
function closedFor(area: CoverageArea, closures: readonly ClosedRange[], day: string): boolean {
  return closures.some((closure) => {
    if (day < closure.startDate || day > closure.endDate) return false;
    const min = closure.minGradeLevel ?? null;
    const max = closure.maxGradeLevel ?? null;
    if (min === null && max === null) return true;
    if (area.minGradeLevel === null || area.maxGradeLevel === null) return false;
    return (min === null || min <= area.minGradeLevel) && (max === null || max >= area.maxGradeLevel);
  });
}

/** Whether [from, to] holds a school day on the weekday for the area. */
function holdsASchoolDay(area: CoverageArea, closures: readonly ClosedRange[], dayOfWeek: number, from: string, to: string): boolean {
  let day = addDays(from, (dayOfWeek - isoWeekday(from) + 7) % 7);
  for (; day <= to; day = addDays(day, 7)) {
    if (!closedFor(area, closures, day)) return true;
  }
  return false;
}

/** The fewest passes at once over [start, end), and the first stretch with that few. */
function fewestOver(
  passes: readonly CoverageShift[],
  start: number,
  end: number,
): { fewest: number; shortFrom: number; shortTo: number } {
  const points = new Set([start, end]);
  for (const pass of passes) {
    if (pass.start > start && pass.start < end) points.add(pass.start);
    if (pass.end > start && pass.end < end) points.add(pass.end);
  }
  const cuts = [...points].sort((a, b) => a - b);
  let fewest = Infinity;
  let shortFrom = start;
  let shortTo = end;
  for (let index = 0; index + 1 < cuts.length; index += 1) {
    const from = cuts[index]!;
    const to = cuts[index + 1]!;
    const running = passes.filter((pass) => pass.start <= from && pass.end >= to).length;
    if (running < fewest) {
      fewest = running;
      shortFrom = from;
      shortTo = to;
    } else if (running === fewest && from === shortTo) {
      shortTo = to;
    }
  }
  return { fewest: fewest === Infinity ? 0 : fewest, shortFrom, shortTo };
}

const runsThrough = (pass: CoverageShift, from: string, to: string) =>
  (pass.validFrom === null || pass.validFrom <= from) && (pass.validTo === null || pass.validTo >= to);

/** The year cut at every date one of the passes starts or stops. */
function stretchesOf(passes: readonly CoverageShift[], year: YearBounds): { from: string; to: string }[] {
  const cuts = new Set([year.startDate, addDays(year.endDate, 1)]);
  for (const pass of passes) {
    if (pass.validFrom !== null && pass.validFrom > year.startDate && pass.validFrom <= year.endDate) cuts.add(pass.validFrom);
    if (pass.validTo !== null && pass.validTo >= year.startDate && pass.validTo < year.endDate) cuts.add(addDays(pass.validTo, 1));
  }
  const sorted = [...cuts].sort();
  return sorted.slice(0, -1).map((from, index) => ({ from, to: addDays(sorted[index + 1]!, -1) }));
}

export function supervisionCoverage(input: CoverageInput): Coverage {
  const breaks: AreaBreak[] = [];
  const gaps: CoverageGap[] = [];
  const weekdays = weekdaysOf(input);
  for (const area of input.areas) {
    for (const dayOfWeek of weekdays) {
      const windows = breaksOfDay(input, area, dayOfWeek);
      if (windows.length === 0) continue;
      const passes = input.shifts.filter((shift) => shift.areaId === area.id && shift.dayOfWeek === dayOfWeek);
      const stretches = stretchesOf(passes, input.year);
      for (const window of windows) {
        breaks.push({
          areaId: area.id,
          dayOfWeek,
          start: window.start,
          end: window.end,
          names: window.names,
          lunch: window.lunch,
          needed: area.guardsNeeded,
          shiftIds: passes.filter((pass) => pass.start < window.end && pass.end > window.start).map((pass) => pass.id),
        });
        if (area.guardsNeeded === 0) continue;
        let open: CoverageGap | null = null;
        for (const stretch of stretches) {
          if (!holdsASchoolDay(area, input.closures, dayOfWeek, stretch.from, stretch.to)) continue;
          const running = passes.filter((pass) => runsThrough(pass, stretch.from, stretch.to));
          const short = fewestOver(running, window.start, window.end);
          if (short.fewest >= area.guardsNeeded) {
            open = null;
            continue;
          }
          if (open && open.fewest === short.fewest && open.shortFrom === short.shortFrom && open.shortTo === short.shortTo) {
            open.to = stretch.to;
            continue;
          }
          open = {
            areaId: area.id,
            dayOfWeek,
            start: window.start,
            end: window.end,
            names: window.names,
            lunch: window.lunch,
            needed: area.guardsNeeded,
            ...short,
            from: stretch.from,
            to: stretch.to,
          };
          gaps.push(open);
        }
      }
    }
  }
  return { breaks, gaps };
}
