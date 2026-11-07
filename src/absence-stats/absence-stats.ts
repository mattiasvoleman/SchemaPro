/*
 * Frånvarostatistik över tid (20270121090000): the vocabulary the migration,
 * the gateway and the web share, and the arithmetic of the figures. The
 * minutes themselves are counted in the database (app.absence_stats_*), by
 * the definition Frånvarobevakningen and /admin/reports count by; what is
 * here only adds them up, compares a month with the same month a year before,
 * and shapes what the web draws.
 */

/** The job's name in the runner, in JobRuns and in JobClaims. */
export const ABSENCE_STATS_JOB = 'absence-stats';
/** The tick: whether a school's night is due is the claim's question, asked every five minutes. */
export const ABSENCE_STATS_INTERVAL_MS = 5 * 60 * 1000;
/** Schools claimed per tick, run one after another; the next tick takes the next five. */
export const SCHOOLS_PER_TICK = 5;
/**
 * The school-local hour from which a school's night may be claimed: with the
 * day's registers long saved, after the gallring's 03:00, the SS12000 nightly,
 * Frånvarobevakningen's 05:00 and Rapporteringsgradens 06:00 (whose definition
 * of a held lesson it reads live), before anyone reads a term's figures.
 */
export const ABSENCE_STATS_HOUR_LOCAL = 7;
/** Months older than the last 62 days a night may count that have no row yet (app.absence_stats_plan). */
export const BACKFILL_MONTHS = 3;

/**
 * The smallest group a stored or shown figure rests on: app.absence_stats_min_group() and the CHECK
 * AbsenceStatsMonths_a_group_has_five_pupils. absence-stats-definition.spec.ts holds the three to one number.
 */
export const MIN_GROUP = 5;

/** The longest period one read covers, in days (the database's limit; a läsår is 365). */
export const MAX_PERIOD_DAYS = 1200;

/** The minutes of a late arrival that count as ogiltig frånvaro, at most the lesson's length. */
export const LATE_MINUTES = 15;

/** The SQLSTATEs of the refusals the database gives (class AS). */
export const ABSENCE_STATS_NOT_YOURS = 'ABSENCE_STATS_NOT_YOURS';
export const ABSENCE_STATS_NO_PUPILS_FOR_THE_READER = 'ABSENCE_STATS_NO_PUPILS_FOR_THE_READER';
export const ABSENCE_STATS_NO_SUCH_PUPIL = 'ABSENCE_STATS_NO_SUCH_PUPIL';
export const ABSENCE_STATS_NO_SUCH_CLASS = 'ABSENCE_STATS_NO_SUCH_CLASS';
export const ABSENCE_STATS_BAD_PERIOD = 'ABSENCE_STATS_BAD_PERIOD';

/** The minutes of each kind, as the database adds them. */
export interface RawFigures {
  /** Minutes with a mark that is not UNKNOWN, on a lesson that was held. */
  recordedMinutes: number;
  /** EXCUSED. */
  validMinutes: number;
  /** ABSENT. */
  absentMinutes: number;
  /** LATE, at most LATE_MINUTES a mark. */
  lateMinutes: number;
  /** The number of LATE marks. */
  lateCount: number;
}

/** The minutes of each kind and what they come to as a share of the recorded minutes (one decimal, percent). */
export interface Figures extends RawFigures {
  /** ABSENT + LATE: ogiltig frånvaro, as the report and the watch add it. */
  invalidMinutes: number;
  validPct: number | null;
  invalidPct: number | null;
  /** Giltig and ogiltig together. */
  totalPct: number | null;
}

/** Held lessons and the share of them with a saved register (Rapporteringsgrad's definition). */
export interface Reporting {
  held: number;
  reported: number;
  ratePct: number | null;
}

/** `part` of `whole` in percent with one decimal; null with nothing to divide by. */
export function pct(part: number, whole: number): number | null {
  if (!(whole > 0)) return null;
  return Math.round((part * 1000) / whole) / 10;
}

export function figuresOf(raw: RawFigures): Figures {
  const invalid = raw.absentMinutes + raw.lateMinutes;
  return {
    ...raw,
    invalidMinutes: invalid,
    validPct: pct(raw.validMinutes, raw.recordedMinutes),
    invalidPct: pct(invalid, raw.recordedMinutes),
    totalPct: pct(raw.validMinutes + invalid, raw.recordedMinutes),
  };
}

export function reportingOf(held: number, reported: number): Reporting {
  return { held, reported, ratePct: pct(reported, held) };
}

export function addFigures(a: RawFigures, b: RawFigures): RawFigures {
  return {
    recordedMinutes: a.recordedMinutes + b.recordedMinutes,
    validMinutes: a.validMinutes + b.validMinutes,
    absentMinutes: a.absentMinutes + b.absentMinutes,
    lateMinutes: a.lateMinutes + b.lateMinutes,
    lateCount: a.lateCount + b.lateCount,
  };
}

export const NO_FIGURES: RawFigures = { recordedMinutes: 0, validMinutes: 0, absentMinutes: 0, lateMinutes: 0, lateCount: 0 };

const DAY_MS = 86_400_000;

/** A date string as a UTC midnight, and back: dates here are the school's calendar days, never instants. */
export const dayOf = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
export const asIso = (value: Date): string => value.toISOString().slice(0, 10);

/** The first day of the month `delta` months from the month holding `day`. */
export function shiftMonth(day: string, delta: number): string {
  const [year, month] = day.split('-').map(Number) as [number, number];
  const at = new Date(Date.UTC(year, month - 1 + delta, 1));
  return asIso(at);
}

/** The first day of the month holding `day`. */
export const monthStart = (day: string): string => `${day.slice(0, 7)}-01`;

/** The last day of the month holding `day`. */
export function monthEnd(day: string): string {
  return asIso(new Date(dayOf(shiftMonth(day, 1)).getTime() - DAY_MS));
}

/** The months from `from` to `to` (each a first day), both included; empty when to is before from. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let month = monthStart(from); month <= monthStart(to) && out.length < 600; month = shiftMonth(month, 1)) out.push(month);
  return out;
}

/** One row of app.absence_stats_series, as the service reads it. */
export interface SeriesRow {
  month: string;
  throughDay: string;
  classId: string | null;
  className: string | null;
  pupils: number;
  pupilsRegistered: number;
  /** Null when fewer than MIN_GROUP pupils had a registered mark. */
  figures: RawFigures | null;
  lessonsHeld: number;
  lessonsReported: number;
}

export interface SeriesMonthView {
  /** The month's first day. */
  month: string;
  /** The last day counted: the month's last, or yesterday for the month that is going on. */
  throughDay: string;
  /** The month is not over: its figures are of the days so far. */
  partial: boolean;
  /** The classes the row is of (a class and its predecessors can both have days in a month at the handover); empty for the school. */
  classNames: string[];
  /** The pupils that belonged to the group some day of the month. */
  pupils: number;
  /** Of them, the pupils with a registered mark: the pupils the minutes rest on. */
  pupilsRegistered: number;
  /** Null when fewer than MIN_GROUP pupils had a mark: no figure is shown or kept. */
  figures: Figures | null;
  reporting: Reporting;
  /** The same month a year before, when the series has it. */
  previousYear: { month: string; figures: Figures | null; reporting: Reporting } | null;
}

/**
 * The rows of one month, one view. A class and its predecessor can both have a
 * row in the month of the handover (August); they are added together, and the
 * figures are none if either row had none (a missing part is not zero).
 */
export function mergeMonth(rows: SeriesRow[]): SeriesRow {
  const first = rows[0] as SeriesRow;
  if (rows.length === 1) return first;
  const figures = rows.every((row) => row.figures !== null) ? rows.reduce<RawFigures>((sum, row) => addFigures(sum, row.figures as RawFigures), NO_FIGURES) : null;
  return {
    month: first.month,
    throughDay: rows.map((row) => row.throughDay).reduce((a, b) => (a > b ? a : b)),
    classId: null,
    className: rows.map((row) => row.className).filter((name): name is string => name !== null).join(', ') || null,
    pupils: rows.reduce((sum, row) => sum + row.pupils, 0),
    pupilsRegistered: rows.reduce((sum, row) => sum + row.pupilsRegistered, 0),
    figures,
    lessonsHeld: rows.reduce((sum, row) => sum + row.lessonsHeld, 0),
    lessonsReported: rows.reduce((sum, row) => sum + row.lessonsReported, 0),
  };
}

/** The series of a school or a class, month by month, each with the same month a year before. */
export function buildSeries(rows: SeriesRow[]): SeriesMonthView[] {
  const byMonth = new Map<string, SeriesRow[]>();
  for (const row of rows) byMonth.set(row.month, [...(byMonth.get(row.month) ?? []), row]);
  const merged = [...byMonth.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, parts]) => mergeMonth(parts));
  const index = new Map(merged.map((row) => [row.month, row]));
  const view = (row: SeriesRow) => ({
    figures: row.figures ? figuresOf(row.figures) : null,
    reporting: reportingOf(row.lessonsHeld, row.lessonsReported),
  });
  return merged.map((row) => {
    const before = index.get(shiftMonth(row.month, -12));
    return {
      month: row.month,
      throughDay: row.throughDay,
      partial: row.throughDay < monthEnd(row.month),
      classNames: row.className ? row.className.split(', ') : [],
      pupils: row.pupils,
      pupilsRegistered: row.pupilsRegistered,
      ...view(row),
      previousYear: before ? { month: before.month, ...view(before) } : null,
    };
  });
}

/** One row of app.absence_stats_classes. */
export interface ClassRow {
  classId: string;
  className: string;
  yearName: string | null;
  monthsCounted: number;
  pupils: number;
  pupilsRegistered: number;
  /** Null when no month of the period had a figure. */
  figures: RawFigures | null;
  lessonsHeld: number;
  lessonsReported: number;
}

export interface ClassSummaryView {
  classId: string;
  className: string;
  yearName: string | null;
  /** The months of the period that have a figure (the others had fewer than MIN_GROUP pupils with a mark). */
  monthsCounted: number;
  pupils: number;
  pupilsRegistered: number;
  figures: Figures | null;
  reporting: Reporting;
}

export function buildClasses(rows: ClassRow[]): ClassSummaryView[] {
  return rows.map((row) => ({
    classId: row.classId,
    className: row.className,
    yearName: row.yearName,
    monthsCounted: row.monthsCounted,
    pupils: row.pupils,
    pupilsRegistered: row.pupilsRegistered,
    figures: row.figures ? figuresOf(row.figures) : null,
    reporting: reportingOf(row.lessonsHeld, row.lessonsReported),
  }));
}

/** One row of app.absence_stats_patterns. */
export interface PatternRow {
  dimension: 'WEEKDAY' | 'SLOT' | 'SUBJECT' | 'ALL';
  key: string;
  label: string;
  groupSize: number;
  suppressed: boolean;
  figures: RawFigures | null;
}

export interface PatternCell {
  /** The ISO weekday 1..7, the pass's start time HH:MM, or the subject's id. */
  key: string;
  /** The subject's name; the key for the others. */
  label: string;
  figures: Figures;
}

export interface PatternsView {
  /** The pupils with a registered mark behind the pattern: 1 for a pupil. */
  groupSize: number;
  /** A class with fewer than MIN_GROUP pupils with a mark in the period: no pattern is given. */
  suppressed: boolean;
  weekdays: PatternCell[];
  slots: PatternCell[];
  /** Largest share of ogiltig frånvaro first. */
  subjects: PatternCell[];
}

const byShare = (a: PatternCell, b: PatternCell): number =>
  (b.figures.totalPct ?? -1) - (a.figures.totalPct ?? -1) || b.figures.recordedMinutes - a.figures.recordedMinutes || a.label.localeCompare(b.label, 'sv') || a.key.localeCompare(b.key);

export function buildPatterns(rows: PatternRow[]): PatternsView {
  const suppressed = rows.some((row) => row.suppressed);
  const groupSize = rows.reduce((most, row) => Math.max(most, row.groupSize), 0);
  const cells = (dimension: PatternRow['dimension']): PatternCell[] =>
    rows
      .filter((row) => row.dimension === dimension && row.figures !== null)
      .map((row) => ({ key: row.key, label: row.label || row.key, figures: figuresOf(row.figures as RawFigures) }));
  return {
    groupSize,
    suppressed,
    weekdays: cells('WEEKDAY').sort((a, b) => Number(a.key) - Number(b.key)),
    slots: cells('SLOT').sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    subjects: cells('SUBJECT').sort(byShare),
  };
}

/** One row of app.absence_stats_pupil. */
export interface PupilMonthRow {
  month: string;
  figures: RawFigures;
  lessons: number;
}

export interface PupilMonthView {
  month: string;
  /** Null for a month with no registered mark: nothing was reported for the pupil, which is not the same as no absence. */
  figures: Figures | null;
  /** The pupil's lessons with a registered mark. */
  lessons: number;
  previousYear: { month: string; figures: Figures | null } | null;
}

/** The pupil's months over `months` (first days), the ones without a mark as nothing, each with the same month a year before. */
export function buildPupilMonths(rows: PupilMonthRow[], months: string[]): PupilMonthView[] {
  const index = new Map(rows.map((row) => [row.month, row]));
  const figures = (month: string): Figures | null => {
    const row = index.get(month);
    return row ? figuresOf(row.figures) : null;
  };
  return months.map((month) => ({
    month,
    figures: figures(month),
    lessons: index.get(month)?.lessons ?? 0,
    previousYear: months.includes(shiftMonth(month, -12)) ? { month: shiftMonth(month, -12), figures: figures(shiftMonth(month, -12)) } : null,
  }));
}

/** What the months of a pupil add up to. */
export function totalOf(rows: PupilMonthRow[]): Figures | null {
  if (rows.length === 0) return null;
  return figuresOf(rows.reduce<RawFigures>((sum, row) => addFigures(sum, row.figures), NO_FIGURES));
}
