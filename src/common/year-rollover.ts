/**
 * Läsårsrullning: what happens to each group, name and date when a läsår is
 * rolled into the next one. Pure — no database, no Nest — so the wizard can
 * say "7A blir 8A" and flag a collision while the admin is still typing.
 *
 * MIRRORED. web/lib/year-rollover.ts implements the same functions, and both
 * replay src/common/__fixtures__/year-rollover-cases.json. The gateway's
 * planner (src/year-rollover) is the authority: a preview the web computed
 * differently is corrected by the preview the server answers, and execute
 * recomputes everything again in its own transaction. The mirror only saves
 * the admin a round trip; it never decides what is written.
 *
 * DATES ARE YYYY-MM-DD STRINGS, read and written as UTC midnight, so no
 * function here depends on the timezone of the machine it runs on.
 */

import { weeklyMinutesOf } from './lesson-lengths';

export type GroupKind = 'CLASS' | 'TEACHING_GROUP';

/** What a group becomes next year. GRADUATE is decided, never requested. */
export type RolloverOutcome = 'PROMOTE' | 'CARRY' | 'SKIP' | 'GRADUATE' | 'INTAKE';

/** What an admin may ask for one group (RolloverOptionsDto.groups[].outcome). */
export type RequestedOutcome = 'PROMOTE' | 'CARRY' | 'SKIP' | 'INTAKE';

/**
 * How the successor's name came about.
 *
 *  - PROMOTED: the one digit run equal to the grade became grade + 1 (7A → 8A).
 *  - F_KLASS: a förskoleklass name (FA, F-B, Fsk C, F-klass D) became 1A/1B/…
 *  - KEPT_NO_GRADE_DIGIT: the name has no digits at all ("Ugglan"); normal for
 *    schools that name classes, informational only.
 *  - KEPT_AMBIGUOUS: digits, but not exactly one run equal to the grade
 *    ("Ma71", "7A7"); the admin should look.
 *  - KEPT: nothing to promote — CARRY, or the intake twin.
 *  - OVERRIDDEN: the admin typed the name.
 */
export type NameStatus =
  | 'PROMOTED'
  | 'F_KLASS'
  | 'KEPT_NO_GRADE_DIGIT'
  | 'KEPT_AMBIGUOUS'
  | 'KEPT'
  | 'OVERRIDDEN';

/** A request the rollover refuses with a 400 naming the group. */
export type GroupChoiceError =
  /** PROMOTE asked of a group at or above the graduating grade. */
  | 'PROMOTE_GRADUATING'
  /** PROMOTE asked of a group with no grade to promote. */
  | 'PROMOTE_WITHOUT_GRADE'
  /** INTAKE asked of anything but a class at the source's lowest class grade. */
  | 'INTAKE_NOT_LOWEST';

export interface RolloverGroupInput {
  id: string;
  name: string;
  kind: GroupKind;
  gradeLevel: number | null;
}

export interface GroupChoice {
  outcome?: RequestedOutcome;
  /** The successor's name, typed by the admin. */
  name?: string;
}

export interface ResolvedGroup {
  sourceGroupId: string;
  outcome: RolloverOutcome;
  /** The group that continues this one next year, linked by predecessorId. */
  successor: { name: string; gradeLevel: number | null } | null;
  /**
   * INTAKE: a new class for next year's intake, same name and grade as this
   * one and NO predecessor link — a link would move this year's cohort into
   * it at activation. Opened beside the successor, never instead of it.
   */
  intake: { name: string; gradeLevel: number } | null;
  nameStatus: NameStatus | null;
  /** The group carries no grade, so it is carried as it is (CARRY). */
  noGrade: boolean;
  error: GroupChoiceError | null;
}

/** Förskoleklass names: F, an optional "sk" or "-klass", a separator, a 1–3 character suffix. */
const F_KLASS = /^F(sk|-klass)?[\s-]?([A-ZÅÄÖa-zåäö0-9]{1,3})$/;

/**
 * The successor's name for a group of `gradeLevel`.
 *
 * One whole digit run equal to the grade becomes grade + 1: "7A" → "8A",
 * "Klass 7B" → "Klass 8B", and "8-2" in åk 8 → "9-2", since only the run
 * equal to the grade counts. Runs are compared as whole numbers, never as
 * characters, so "17A" is not a grade-1 name. Two runs equal to the grade
 * ("7A7") or runs but none equal ("Ma71" in åk 7) keep the name, flagged
 * KEPT_AMBIGUOUS. No digits: förskoleklass names map to åk 1 (grade 0 only),
 * everything else is kept, KEPT_NO_GRADE_DIGIT.
 */
export function promoteName(
  name: string,
  gradeLevel: number | null,
): { name: string; status: NameStatus } {
  if (gradeLevel === null) return { name, status: 'KEPT' };
  const runs = [...name.matchAll(/\d+/g)];
  const equal = runs.filter((run) => Number(run[0]) === gradeLevel);
  if (equal.length === 1) {
    const run = equal[0]!;
    const at = run.index ?? 0;
    return {
      name: `${name.slice(0, at)}${gradeLevel + 1}${name.slice(at + run[0].length)}`,
      status: 'PROMOTED',
    };
  }
  if (equal.length > 1) return { name, status: 'KEPT_AMBIGUOUS' };
  if (gradeLevel === 0) {
    const f = F_KLASS.exec(name);
    if (f) return { name: `1${f[2]}`, status: 'F_KLASS' };
  }
  return { name, status: runs.length > 0 ? 'KEPT_AMBIGUOUS' : 'KEPT_NO_GRADE_DIGIT' };
}

/** The lowest grade any CLASS of the source carries, or null. */
export function lowestClassGrade(groups: readonly RolloverGroupInput[]): number | null {
  const grades = groups
    .filter((group) => group.kind === 'CLASS' && group.gradeLevel !== null)
    .map((group) => group.gradeLevel as number);
  return grades.length > 0 ? Math.min(...grades) : null;
}

/**
 * What each group becomes, given the graduating grade G and the admin's
 * choices.
 *
 * Defaults: a class below G is promoted, at or above G it graduates, with no
 * grade it is carried as it is. A teaching group follows the same rule when
 * carryTeachingGroups is on and is skipped when it is off. An explicit choice
 * overrides the default; a choice that cannot be honoured keeps the default
 * and carries `error`, which execute turns into a 400 naming the group.
 *
 * INTAKE is the default outcome PLUS an intake twin: the lowest-grade class
 * is still promoted (its cohort needs a successor to move into), and a new
 * class with its name and grade is opened for next year's intake.
 */
export function resolveGroups(
  groups: readonly RolloverGroupInput[],
  graduatingGradeLevel: number,
  options: { carryTeachingGroups: boolean },
  choices: ReadonlyMap<string, GroupChoice> = new Map(),
): ResolvedGroup[] {
  const lowest = lowestClassGrade(groups);
  return groups.map((group) => {
    const choice = choices.get(group.id) ?? {};
    const g = group.gradeLevel;
    const graduates = g !== null && g >= graduatingGradeLevel;
    const byDefault: RolloverOutcome =
      group.kind === 'TEACHING_GROUP' && !options.carryTeachingGroups
        ? 'SKIP'
        : g === null
          ? 'CARRY'
          : graduates
            ? 'GRADUATE'
            : 'PROMOTE';

    let outcome: RolloverOutcome = byDefault;
    let error: GroupChoiceError | null = null;
    let intake: ResolvedGroup['intake'] = null;
    switch (choice.outcome) {
      case undefined:
        break;
      case 'PROMOTE':
        if (g === null) error = 'PROMOTE_WITHOUT_GRADE';
        else if (graduates) error = 'PROMOTE_GRADUATING';
        else outcome = 'PROMOTE';
        break;
      case 'CARRY':
      case 'SKIP':
        outcome = choice.outcome;
        break;
      case 'INTAKE':
        if (group.kind !== 'CLASS' || g === null || g !== lowest) {
          error = 'INTAKE_NOT_LOWEST';
        } else {
          outcome = 'INTAKE';
          intake = { name: group.name, gradeLevel: g };
        }
        break;
    }

    // The successor: what the cohort moves into. INTAKE's cohort is promoted
    // (or graduates, in a school of one grade), exactly as without the twin.
    const continues: 'PROMOTE' | 'CARRY' | null =
      outcome === 'PROMOTE' || (outcome === 'INTAKE' && !graduates)
        ? 'PROMOTE'
        : outcome === 'CARRY'
          ? 'CARRY'
          : null;
    let successor: ResolvedGroup['successor'] = null;
    let nameStatus: NameStatus | null = null;
    if (continues === 'PROMOTE') {
      const promoted = promoteName(group.name, g);
      successor = { name: promoted.name, gradeLevel: (g as number) + 1 };
      nameStatus = promoted.status;
    } else if (continues === 'CARRY') {
      successor = { name: group.name, gradeLevel: g };
      nameStatus = 'KEPT';
    }
    const override = choice.name?.trim();
    if (successor && override && override !== successor.name) {
      successor = { ...successor, name: override };
      nameStatus = 'OVERRIDDEN';
    }
    return {
      sourceGroupId: group.id,
      outcome,
      successor,
      intake,
      nameStatus,
      noGrade: g === null,
      error,
    };
  });
}

export interface NameCollision {
  /** The name as it would be written, twice or more. */
  name: string;
  sourceGroupIds: string[];
  /** true: the names differ in case only — a warning, not a block. */
  caseOnly: boolean;
}

/**
 * Names next year's groups would share. Group names are unique per (school,
 * year) by exact match, so an exact duplicate cannot be written (blocking);
 * "8a" beside "8A" can, and is listed as a warning, because two classes no
 * one can tell apart on a printed schedule are a mistake more often than not.
 */
export function nameCollisions(groups: readonly ResolvedGroup[]): NameCollision[] {
  const byExact = new Map<string, string[]>();
  for (const group of groups) {
    for (const name of [group.successor?.name, group.intake?.name]) {
      if (name === undefined) continue;
      const ids = byExact.get(name) ?? [];
      ids.push(group.sourceGroupId);
      byExact.set(name, ids);
    }
  }
  const found: NameCollision[] = [];
  for (const [name, ids] of byExact) {
    if (ids.length > 1) found.push({ name, sourceGroupIds: ids, caseOnly: false });
  }
  const byFolded = new Map<string, string[]>();
  for (const name of byExact.keys()) {
    const folded = name.toLocaleLowerCase('sv');
    byFolded.set(folded, [...(byFolded.get(folded) ?? []), name]);
  }
  for (const names of byFolded.values()) {
    if (names.length < 2) continue;
    const ids = names.flatMap((name) => byExact.get(name) ?? []);
    found.push({ name: names.sort().join(' / '), sourceGroupIds: ids, caseOnly: true });
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---- the graduating grade

export interface DecidedPlanGrades {
  schoolForm: string;
  /** ISO instant the plan was decided; the newest per form counts. */
  decidedAt: string;
  /** The highest årskurs the plan has an entry for. */
  maxGradeLevel: number | null;
}

export interface GraduatingGradeDefault {
  value: number | null;
  source: 'TIMPLAN' | 'CLASSES' | 'NONE';
  /** Set when the timplans and the classes (or two school forms) disagree: the admin chooses. */
  conflict: { timplan: number[]; classes: number | null } | null;
}

/**
 * The grade that leaves school at this hand-over, as a default the wizard
 * offers. The newest DECIDED lokal timplan of each school form says where its
 * school ends; with none, the highest class grade the source year has. When
 * those disagree — or two forms end at different grades — there is no safe
 * default and the admin is asked: a G one too low graduates a whole cohort
 * into no class, one too high invents an åk 10.
 */
export function defaultGraduatingGrade(
  plans: readonly DecidedPlanGrades[],
  classGrades: readonly (number | null)[],
): GraduatingGradeDefault {
  const newestByForm = new Map<string, DecidedPlanGrades>();
  for (const plan of plans) {
    const seen = newestByForm.get(plan.schoolForm);
    if (!seen || plan.decidedAt > seen.decidedAt) newestByForm.set(plan.schoolForm, plan);
  }
  const timplan = [
    ...new Set(
      [...newestByForm.values()]
        .map((plan) => plan.maxGradeLevel)
        .filter((grade): grade is number => grade !== null),
    ),
  ].sort((a, b) => a - b);
  const grades = classGrades.filter((grade): grade is number => grade !== null);
  const classes = grades.length > 0 ? Math.max(...grades) : null;

  if (timplan.length === 0) {
    return classes === null
      ? { value: null, source: 'NONE', conflict: null }
      : { value: classes, source: 'CLASSES', conflict: null };
  }
  const conflict =
    timplan.length > 1 || (classes !== null && classes !== timplan[0])
      ? { timplan, classes }
      : null;
  return { value: timplan.length === 1 ? timplan[0]! : null, source: 'TIMPLAN', conflict };
}

// ---- dates

const DAY_MS = 86_400_000;

export interface DayBounds {
  startDate: string;
  endDate: string;
}

const toMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);
const toDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function addDays(day: string, days: number): string {
  return toDay(toMs(day) + days * DAY_MS);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}

/**
 * Whole weeks from the source year's start to the target's: dates shifted by
 * it keep their weekday. 2026-08-17 → 2027-08-16 is 364, not 365.
 */
export function dateShiftDays(sourceStart: string, targetStart: string): number {
  return Math.round(daysBetween(sourceStart, targetStart) / 7) * 7;
}

export type MappedDate = { date: string; how: 'ANCHORED' | 'SHIFTED' };

/**
 * One date of a period, moved into the target year. A date ON a bound of the
 * source year maps to the same bound of the target — a vårtermin that ends
 * the day the year ends still ends the day the next year ends, even when the
 * whole-week shift would overshoot it by a day (BOUND_ANCHORED). Every other
 * date moves by the whole-week shift, keeping its weekday.
 *
 * A shifted date that lands less than a week outside the target is pulled
 * onto the bound it missed, and counts as anchored too. The whole-week shift
 * rounds the distance between the two starts, so a date can miss by up to
 * three days, and more when the target year is a few days shorter: a
 * höstterminsrad from 2026-08-18 (the source's second day) into a year that
 * starts on Wednesday 2027-08-18 shifts by 364 to 2027-08-17, a day early.
 * Dropping that row would lose a term of a subject over a rounding; a date a
 * week or more outside is a period that does not fit, and is still dropped.
 */
export function mapDate(
  day: string,
  source: DayBounds,
  target: DayBounds,
  shiftDays: number,
): MappedDate {
  if (day === source.startDate) return { date: target.startDate, how: 'ANCHORED' };
  if (day === source.endDate) return { date: target.endDate, how: 'ANCHORED' };
  const shifted = addDays(day, shiftDays);
  if (shifted < target.startDate && daysBetween(shifted, target.startDate) < 7) {
    return { date: target.startDate, how: 'ANCHORED' };
  }
  if (shifted > target.endDate && daysBetween(target.endDate, shifted) < 7) {
    return { date: target.endDate, how: 'ANCHORED' };
  }
  return { date: shifted, how: 'SHIFTED' };
}

export type PeriodStatus = 'UNCHANGED' | 'SHIFTED' | 'BOUND_ANCHORED' | 'DROPPED';

export interface MappedPeriod {
  startDate: string | null;
  endDate: string | null;
  status: PeriodStatus;
}

/**
 * A requirement's period in the target year. Null stays null (the year's own
 * bound, which follows the year). A period still outside the target after the
 * shift is DROPPED: the row is not carried, and the preview names it.
 */
export function mapPeriod(
  startDate: string | null,
  endDate: string | null,
  source: DayBounds,
  target: DayBounds,
  shiftDays: number,
): MappedPeriod {
  if (startDate === null && endDate === null) {
    return { startDate: null, endDate: null, status: 'UNCHANGED' };
  }
  const start = startDate === null ? null : mapDate(startDate, source, target, shiftDays);
  const end = endDate === null ? null : mapDate(endDate, source, target, shiftDays);
  const inside = (mapped: MappedDate | null) =>
    mapped === null || (mapped.date >= target.startDate && mapped.date <= target.endDate);
  const ordered = start === null || end === null || start.date <= end.date;
  const status: PeriodStatus =
    !inside(start) || !inside(end) || !ordered
      ? 'DROPPED'
      : start?.how === 'ANCHORED' || end?.how === 'ANCHORED'
        ? 'BOUND_ANCHORED'
        : 'SHIFTED';
  return { startDate: start?.date ?? null, endDate: end?.date ?? null, status };
}

// ---- ISO weeks and Easter

/** ISO year, week and weekday (1 = Monday) of a day. */
export function isoWeekOf(day: string): { year: number; week: number; weekday: number } {
  const ms = toMs(day);
  const weekday = ((new Date(ms).getUTCDay() + 6) % 7) + 1;
  const thursday = ms + (4 - weekday) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return { year, week, weekday };
}

/** 52 or 53. */
export function isoWeeksIn(year: number): number {
  return isoWeekOf(`${year}-12-28`).week;
}

/** The day of an ISO week, or null when that year has no such week. */
export function dayOfIsoWeek(year: number, week: number, weekday: number): string | null {
  if (week < 1 || week > isoWeeksIn(year)) return null;
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Weekday = ((new Date(jan4).getUTCDay() + 6) % 7) + 1;
  const mondayOfWeek1 = jan4 - (jan4Weekday - 1) * DAY_MS;
  return toDay(mondayOfWeek1 + ((week - 1) * 7 + (weekday - 1)) * DAY_MS);
}

/**
 * Whether an ISO week 53 begins between the two starts. Shifted across one,
 * a date keeps its weekday but its week number moves one down, so ODD_WEEKS
 * and EVEN_WEEKS rows trade places — 2026 has a week 53, so 2026/27 into
 * 2027/28 crosses one. The preview says so; nothing is changed for it.
 */
export function crossesIsoWeek53(sourceStart: string, targetStart: string): boolean {
  const from = Number(sourceStart.slice(0, 4));
  const to = Number(targetStart.slice(0, 4));
  for (let year = from; year <= to; year++) {
    const monday = dayOfIsoWeek(year, 53, 1);
    if (monday !== null && monday >= sourceStart && monday < targetStart) return true;
  }
  return false;
}

/** Easter Sunday (Gregorian computus, the anonymous algorithm). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ---- lov

export type BreakAnchor = 'CHRISTMAS' | 'EASTER' | 'ISO_WEEK' | 'NONE';

export interface BreakProposal {
  proposedStart: string | null;
  proposedEnd: string | null;
  anchor: BreakAnchor;
  /** The proposal lies inside the target year (false with no proposal). */
  fits: boolean;
}

/**
 * Next year's dates for a lov, as a proposal the admin can edit.
 *
 *  - A lov containing 24 December (jullov) moves by whole weeks to next
 *    year's 24 December (364 days, or a week more or less when that is what
 *    keeps 24 December inside it): it hangs on the date, and a whole-week
 *    move keeps its weekdays. Not by the year's own shift, which is 371
 *    across a week 53 for a school that starts in the same ISO week.
 *  - A lov containing the source year's Easter Monday (påsklov) moves with
 *    Easter: 2027-03-29 → 2028-04-17, because Easter 2028 is 16 April.
 *  - Anything else (höstlov, sportlov, studiedagar) keeps its ISO week and
 *    weekday in the next year: höstlov v44 stays v44, which a 364-day shift
 *    across 2026's week 53 would have moved to v43.
 *  - When that week does not exist next year (a week-53 lov into a 52-week
 *    year) there is no proposal, and the admin types the dates.
 */
export function proposeBreak(lov: DayBounds, source: DayBounds, target: DayBounds): BreakProposal {
  const fits = (start: string, end: string) =>
    start <= end && start >= target.startDate && end <= target.endDate;
  const yearDelta = Number(target.startDate.slice(0, 4)) - Number(source.startDate.slice(0, 4));

  const years = new Set([Number(lov.startDate.slice(0, 4)), Number(lov.endDate.slice(0, 4))]);
  const christmasYear = [...years].find((year) => {
    const christmasEve = `${year}-12-24`;
    return christmasEve >= lov.startDate && christmasEve <= lov.endDate;
  });
  if (christmasYear !== undefined) {
    // Whole weeks from this Christmas Eve to next year's, not the year's own
    // shift: a school that starts in week 34 both years shifts 371 days
    // across 2026's week 53, which would put jullov 2027 a week after
    // julafton. 364 keeps the weekdays and nearly always keeps 24 December
    // inside; when it does not (a lov that ends on julafton), the week more
    // or less that does is taken, and 364 when none does.
    const eve = `${christmasYear}-12-24`;
    const nextEve = `${christmasYear + yearDelta}-12-24`;
    const weeks = Math.round(daysBetween(eve, nextEve) / 7) * 7;
    const moved =
      [weeks, weeks + 7, weeks - 7].find(
        (days) => addDays(lov.startDate, days) <= nextEve && addDays(lov.endDate, days) >= nextEve,
      ) ?? weeks;
    const start = addDays(lov.startDate, moved);
    const end = addDays(lov.endDate, moved);
    return { proposedStart: start, proposedEnd: end, anchor: 'CHRISTMAS', fits: fits(start, end) };
  }

  const sourceEaster = easterSunday(Number(source.endDate.slice(0, 4)));
  const easterMonday = addDays(sourceEaster, 1);
  if (easterMonday >= lov.startDate && easterMonday <= lov.endDate) {
    const moved = daysBetween(sourceEaster, easterSunday(Number(target.endDate.slice(0, 4))));
    const start = addDays(lov.startDate, moved);
    const end = addDays(lov.endDate, moved);
    return { proposedStart: start, proposedEnd: end, anchor: 'EASTER', fits: fits(start, end) };
  }

  const sameWeek = (day: string) => {
    const iso = isoWeekOf(day);
    return dayOfIsoWeek(iso.year + yearDelta, iso.week, iso.weekday);
  };
  const start = sameWeek(lov.startDate);
  const end = sameWeek(lov.endDate);
  if (start === null || end === null) {
    return { proposedStart: null, proposedEnd: null, anchor: 'NONE', fits: false };
  }
  return { proposedStart: start, proposedEnd: end, anchor: 'ISO_WEEK', fits: fits(start, end) };
}

// ---- volume against the timplan

export interface VolumeRow {
  subjectId: string;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  /** Lektionslängder, longest first; empty or absent on a uniform row. */
  lessonLengths?: readonly number[];
  recurrence: 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS';
  startDate: string | null;
  endDate: string | null;
}

export interface VolumeFinding {
  subjectId: string;
  /** The carried rows' minutes per week, averaged over the target year. */
  carried: number;
  /** The decided plan's minutes per week for the target grade. */
  planned: number;
}

/**
 * A row's minutes per week averaged over the year: a vårtermin-only subject
 * at 2 × 60 is about 60 a week over the year, which is what a lokal timplan's
 * minutes per week mean. Odd or even weeks count half. A split row's week is
 * its lessons' minutes (lesson-lengths.ts weeklyMinutesOf): 1 × 80 + 1 × 40
 * is 120.
 */
export function averageWeeklyMinutes(row: VolumeRow, year: DayBounds): number {
  const perWeek = weeklyMinutesOf(row) * (row.recurrence === 'ALL_WEEKS' ? 1 : 0.5);
  const start = row.startDate ?? year.startDate;
  const end = row.endDate ?? year.endDate;
  const share = (daysBetween(start, end) + 1) / (daysBetween(year.startDate, year.endDate) + 1);
  return perWeek * Math.max(0, Math.min(1, share));
}

/**
 * Where a promoted class's carried rows differ from the decided plan for the
 * grade it is promoted into, per subject, in whole minutes. A subject the
 * plan gives 0 and the class does not read is no finding. Not a block:
 * requirements are carried by cohort, and the plan is what P2's generator
 * will compute volumes from — this only says where the two part.
 */
export function volumeFindings(
  rows: readonly VolumeRow[],
  planned: ReadonlyMap<string, number>,
  year: DayBounds,
): VolumeFinding[] {
  const carried = new Map<string, number>();
  for (const row of rows) {
    carried.set(row.subjectId, (carried.get(row.subjectId) ?? 0) + averageWeeklyMinutes(row, year));
  }
  const subjects = [...new Set([...carried.keys(), ...planned.keys()])].sort();
  const found: VolumeFinding[] = [];
  for (const subjectId of subjects) {
    const have = Math.round(carried.get(subjectId) ?? 0);
    const want = Math.round(planned.get(subjectId) ?? 0);
    if (have !== want) found.push({ subjectId, carried: have, planned: want });
  }
  return found;
}

// ---- class rules across a stage change

export interface FrameWindow {
  minGradeLevel: number;
  maxGradeLevel: number;
  dayOfWeek: number | null;
  /** HH:MM */
  startTime: string;
  endTime: string;
}

/**
 * Whether the school day of grade g and of grade g + 1 differ — a class rule
 * written for 7A's day (FrameTimes for åk 7) may not fit 8A's. Compared as
 * the set of (weekday, start, end) windows covering each grade.
 */
export function frameChanges(frames: readonly FrameWindow[], gradeLevel: number): boolean {
  const signature = (grade: number) =>
    frames
      .filter((frame) => frame.minGradeLevel <= grade && grade <= frame.maxGradeLevel)
      .map((frame) => `${frame.dayOfWeek ?? '*'}|${frame.startTime}|${frame.endTime}`)
      .sort()
      .join(',');
  return signature(gradeLevel) !== signature(gradeLevel + 1);
}
