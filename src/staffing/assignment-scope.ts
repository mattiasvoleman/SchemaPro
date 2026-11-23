import type { GradeNumbering } from '../common/grade-numbering';
import { weeklyMinutesOf } from '../common/lesson-lengths';
import { teacherPartsOf } from '../common/lesson-shares';
import { changesDuringYear } from './employment-periods';
import {
  activePercentOf,
  singleGrade,
  stretchLoads,
  type GradeSpan,
  type LoadEmployment,
  type LoadInput,
  type TeacherLoadReport,
} from './teacher-load';
import { teachingWeeksByDays, type ClosedRange, type YearBounds } from './teaching-weeks';

/*
 * Undervisningsuppdragets omfattning: what the ordinance on the extent of a teacher's teaching assignment
 * (SFS 2026:1487, in force 2027-07-01) says about the year's teaching hours of each teacher, computed, never stored.
 *
 * NOT THE PUPIL'S GUARANTEED TEACHING TIME (the timplan, TimplanCredits) and NOT THE REPORT'S RIKTMÄRKE
 * (fullTimeTeachingMinutesPerWeek, the school's own weekly measure). The ordinance counts a teacher's own time in hours
 * per läsår (2 §: "den tid som lärare lägger på att genomföra undervisningen"), against a span per stage. Three things
 * the report's figures are, and this module's are not:
 *
 *   * UNWEIGHTED. The report's hours are charged: × teacherLoadPercent (0-200) and, under the Faktor model, × the
 *     subject's factor. Neither is time. The hours here are the lessons' own minutes over the weeks they run.
 *   * TEACHING ONLY. An uppdrag marked countsAsTeaching (rastvakt) meets the riktmärke in the report and is no
 *     undervisning under the ordinance; mentorskap lies outside the assignment altogether (prop. 2025/26:196 s. 41).
 *   * PLANNED, NOT HELD. A vikariat is a lesson the planned rows do not hold; the ordinance's 11 § p. 2 (a few hours a term)
 *     therefore needs no record.
 *   * SCHOOL DAYS, NOT TOUCHED WEEKS. The report charges a week whole when the year (or a row's dates) covers any day of it,
 *     which is right for a standard week. An annual figure counts the Mon-Fri days that are in the window (teachingWeeksByDays),
 *     so a läsår that starts on a Saturday does not hold a week of lessons before its first Monday: 15 lessons of 60 minutes are
 *     the same hours in a year that starts on Saturday 14 August as in one that starts on Monday the 16th.
 *
 * THE SPAN IS NOT A CAP (3 §, 8 §). "Som mest vara inom intervallet 550-650" puts the teacher's OWN highest level somewhere
 * in the span, and the rektor decides where. Only the upper edge is a limit, so only the upper edge is a verdict:
 * OVER_MAX. Between the lower edge and the upper is INSIDE: a judgement the product shows and the rektor makes. OVER_OWN
 * is for a teacher with a level of their own (a later PR) who is over it but not over the ordinance.
 *
 * PART-TIME (3 § second paragraph): the ratio of teaching to working time is the full-time one, so the span scales with
 * tjänst minus nedsättning (nedsättning is partial leave, so it is working time the teacher does not have), the same
 * weighted-by-teaching-weeks figure the report states its regulated hours by (activePercentOf).
 *
 * THE STAGE IS THE GROUP'S YEARS. A group's derived span (LoadRequirement.gradeSpan, in the läsår's own numbering) is
 * matched to the version's band for that numbering. A span inside one band is that band's; a span over two (a 6-7 group)
 * is read in the STRICTER band, the lower upper edge and the higher planning floor, so that a mixed group never gives a
 * teacher more room than either stage would. A teacher whose hours lie in two stages gets the span BLENDED by hours
 * (TOLKAT, T2): a 20-hour åk 4-6 and a 10-hour åk 7-9 share is 2/3 × 650 + 1/3 × 600. Förskoleklassen (årskurs 0) is outside
 * the ordinance (prop. s. 43-44) and its hours are counted in the teacher's total (time is time) but have no band; a group
 * with no derivable year has no band either, and says so.
 *
 * A NUMBERING WITHOUT A BAND IS NOT JUDGED. The ordinance is not amended for the ten-year grundskola (TIOARIG, from
 * 2028-07-01), and its "årskurs 1-6" and "7-9" would move the stage boundary one step when the grades are renumbered
 * (grade-numbering.ts). A year in a numbering the version has no band for is reported with its hours and NO verdict.
 *
 * HOURS OUTSIDE THE STAGES DO NOT MAKE A TEACHER OVER THE ORDINANCE (TOLKAT, T7; the user's decision on the review of #382, L-3). The
 * verdict OVER_MAX is judged on the hours that lie in a stage (3 §: årskurs 1-6 and 7-9). A teacher who is past the edge only when
 * förskoleklass or groups with no årskurs are counted in (2 § defines teaching time without a stage, prop. s. 43-44 leaves
 * förskoleklass outside the regulation) gets no OVER_MAX: the row says `overOnlyWithUnregulated`, and the report carries the
 * interpretation, so that an F-3 teacher is not marked over a limit the ordinance does not give her. The hours still count in
 * the total and in the planning (time is time), and the rektor's own level (OVER_OWN) is judged on the total.
 *
 * THE UNIT IS THE CLOCK HOUR (TOLKAT, T3): the ordinance defines no lektionstimme, and the minutes are the lessons' own.
 *
 * PLANNING (4 §, 5 §): a floor, in hours, as a share of the teaching time per stage (100 %, and 110 % for åk 7-9; the
 * 10 is a TOLKNING, said in the band's own note). "Does it fit" is asked only where the year is known, a full ferietjänst
 * (annualHours), as annualHours minus teaching minus every uppdrag. It is a NECESSARY condition (meetings and the rest are
 * not modelled), never a sufficient one: a negative answer is a certain no, a positive one is no promise.
 *
 * PURE. The rows come in; nothing here reads a database or a clock.
 */

/** One row of AssignmentScopeBands, as the report reads it. */
export interface ScopeBand {
  schoolForm: string;
  gradeNumbering: GradeNumbering;
  gradeFrom: number;
  gradeTo: number;
  teachingHoursLow: number;
  teachingHoursHigh: number;
  planningFloorPercent: number;
  teachingSection: string;
  planningSection: string;
  note: string | null;
}

/** A lydelse of the ordinance with its bands. */
export interface ScopeVersion {
  code: string;
  sfs: string;
  title: string;
  /** yyyy-mm-dd, the first day it holds. */
  validFrom: string;
  /** yyyy-mm-dd, the last day it holds, inclusive; null while it has no successor. */
  validTo: string | null;
  source: string;
  bands: ScopeBand[];
}

/** The only school form Rastra has staff in. */
export const SCOPE_SCHOOL_FORM = 'GRUNDSKOLA';

/** Why a teacher has hours and no verdict. */
export type ScopeNotJudged =
  | 'NO_TEACHING'
  | 'NO_POST'
  | 'NO_STAGE';

/** Why a year has no verdict for anybody. */
export type ScopeYearReason = 'NOT_IN_FORCE' | 'NUMBERING_NOT_COVERED';

/**
 * OVER_MAX: over the ordinance's upper edge for the teacher (3 §), the one limit there is.
 * OVER_OWN: over the teacher's own level (8 §) but not over the ordinance's.
 * INSIDE: NOT OVER, at or under the upper edge. That includes a teacher far BELOW the span's lower edge: the ordinance says "som
 *   mest" and has no lower limit on teaching, so there is no UNDER, and a screen must not read INSIDE as "within 550-650 hours".
 * NOT_JUDGED: hours and no verdict (notJudged, or the year's yearReason says why).
 */
export type ScopeVerdict = 'OVER_MAX' | 'OVER_OWN' | 'INSIDE' | 'NOT_JUDGED';

/** Hours in one band of the version, for one teacher. */
export interface ScopeStageHours {
  gradeFrom: number;
  gradeTo: number;
  /** Teaching hours in the stage, one decimal. */
  hours: number;
  /** The span's upper and lower edge for a full-time teacher, as the band states them. The lower edge is no floor for teaching. */
  teachingHoursLow: number;
  teachingHoursHigh: number;
  planningFloorPercent: number;
}

/**
 * The rektor's assessment of one teacher as the report shows it (AssignmentScopeAssessments). A reader without HR-läs gets the
 * exception kind alone, so the verdict can say why a write was not refused; the level, the day, the note and the time are the
 * assessment of an employee, read like the post beside them.
 */
export interface ScopeAssessmentView {
  levelHours: number | null;
  exceptionKind: 'OWN_INITIATIVE' | 'SMALL_GROUP' | null;
  ownInitiativeOn: string | null;
  note: string | null;
  decidedAt: string | null;
}

export interface TeacherScope {
  userId: string;
  verdict: ScopeVerdict;
  /** Set when the verdict is NOT_JUDGED. */
  notJudged: ScopeNotJudged | null;
  /** All the teacher's teaching time over the läsår, in clock hours, one decimal, unweighted. */
  teachingHours: number;
  /** In the stages the version has a band for, one decimal. */
  stages: ScopeStageHours[];
  /** Hours outside every band: förskoleklass, or a year the version does not cover. */
  unregulatedHours: number;
  /** Hours in groups with no derivable årskurs. */
  unknownGradeHours: number;
  /**
   * The upper edge of the span for a full-time teacher, blended over the stages by hours; null when no hour lies in a
   * stage. Not a percentage of anything: it carries no part-time figure, so it is no HR data.
   */
  fullTimeHighestHours: number | null;
  /**
   * The lower edge, blended the same way. NOT a floor for teaching (3 §: "som mest"): a teacher below it is INSIDE. It is the
   * other end of the range in which the rektor places the teacher's own level (8 §), and nothing a teacher must reach.
   */
  fullTimeLowestHours: number | null;
  /**
   * The upper edge for THIS teacher: the blended edge × the active share of a full post, or the teacher's own level if
   * lower. Null for a reader without HR-läs (it gives the post back), and when nothing is judged.
   */
  highestHours: number | null;
  /** The ordinance's own upper edge for the teacher, before any level of their own: what OVER_MAX is judged against. */
  ordinanceHighestHours: number | null;
  /** Planning and follow-up, at least this many hours. Null when no hour lies in a stage. */
  planningFloorHours: number | null;
  /**
   * The part of the year's working time left after teaching and every uppdrag, in hours; null unless a full ferietjänst. It is
   * what is LEFT, not what is planned: nothing records the time a teacher puts into planning and follow-up, and meetings and
   * the rest of the year are not modelled.
   */
  remainingHours: number | null;
  /**
   * Whether remainingHours covers planningFloorHours; null where remainingHours is null. A NECESSARY condition and never a
   * sufficient one: false is a certain no (the year cannot hold the floor), true only says the floor is not ruled out and is
   * never a promise that it is met.
   */
  planningFits: boolean | null;
  /**
   * True when the teacher is past the ordinance's upper edge only because hours outside every stage are counted in (förskoleklass,
   * groups with no årskurs; T7): the verdict is then NOT OVER_MAX, and the report carries UNREGULATED_HOURS_INTERPRETATION. Absent
   * (not false) otherwise, so a report of a school with no such teacher is the report it was.
   */
  overOnlyWithUnregulated?: true;
  /**
   * The rektor's assessment of the teacher, when one is written. Absent (not null) otherwise, so a report of a school that
   * assesses nobody is the report it always was. A level lowers `highestHours` and gives OVER_OWN; an exception changes nothing
   * in the verdict, only what a write is refused for (staffing-checks.ts overScopeFinding).
   */
  assessment?: ScopeAssessmentView;
}

/**
 * What a figure rests on beyond the ordinance's own words. `cause` says whose row it explains: absent for a band's note (every
 * card shows it), UNREGULATED_HOURS for the interpretation of a teacher marked `overOnlyWithUnregulated` (only that card does).
 */
export interface ScopeInterpretation {
  section: string;
  note: string;
  cause?: 'UNREGULATED_HOURS';
}

/**
 * T7: hours outside the stages are counted, but are no reason to say OVER_MAX. Paragraphs: 2 § (what teaching time is), 3 § (which stages).
 * The note is shown on the card of the teacher it explains, on the rektor's drawer AND on the teacher's own page, where every other
 * sentence speaks to her ("din", "du"): it names nobody, so it reads right on both.
 */
export const UNREGULATED_HOURS_INTERPRETATION: ScopeInterpretation = {
  section: '2 § och 3 §',
  note:
    'Tolkning (T7): timmar i förskoleklass och i grupper utan årskurs ligger utanför förordningens stadier (3 § nämner årskurs 1-6 och 7-9, ' +
    'och propositionen säger att förskoleklassen inte omfattas) men är undervisningstid enligt 2 §. Räknas de med är undervisningstiden över högsta nivån, ' +
    'och räknas de inte med är den det inte. Rastra Schema säger över högsta nivån bara när timmarna i stadierna ensamma går över, ' +
    'och visar annars den här orsaken.',
  cause: 'UNREGULATED_HOURS',
};

export interface ScopeReport {
  /** The lydelse the year was judged against; null when none holds on the year's first day. */
  version: Pick<ScopeVersion, 'code' | 'sfs' | 'title' | 'validFrom' | 'validTo' | 'source'> | null;
  /** Set when no teacher is judged because of the year itself. */
  yearReason: ScopeYearReason | null;
  /** What the bands rest on beyond the ordinance's own words, by paragraph. */
  interpretations: ScopeInterpretation[];
  teachers: TeacherScope[];
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** The version that holds on a day (yyyy-mm-dd); the one whose first day is latest if two did (the database refuses it). */
export function versionInForce(versions: readonly ScopeVersion[], day: string): ScopeVersion | null {
  let best: ScopeVersion | null = null;
  for (const version of versions) {
    if (version.validFrom > day) continue;
    if (version.validTo !== null && version.validTo < day) continue;
    if (best === null || version.validFrom > best.validFrom) best = version;
  }
  return best;
}

type Placed = { kind: 'BAND'; band: ScopeBand } | { kind: 'UNREGULATED' } | { kind: 'UNKNOWN' };

/**
 * The band a group's years belong to. A span inside one band is that band's; one over several is the STRICTER (the lowest
 * upper edge, then the highest planning floor). Årskurs 0 (förskoleklass) is no band's, and a span that is only 0, or
 * holds no band's year at all, is unregulated; no span is unknown.
 */
export function placeSpan(span: GradeSpan | null, bands: readonly ScopeBand[]): Placed {
  if (span === null) return { kind: 'UNKNOWN' };
  const touched = bands.filter((band) => band.gradeFrom <= span.max && band.gradeTo >= span.min);
  if (touched.length === 0) return { kind: 'UNREGULATED' };
  let strictest = touched[0]!;
  for (const band of touched) {
    if (
      band.teachingHoursHigh < strictest.teachingHoursHigh ||
      (band.teachingHoursHigh === strictest.teachingHoursHigh && band.planningFloorPercent > strictest.planningFloorPercent)
    ) {
      strictest = band;
    }
  }
  return { kind: 'BAND', band: strictest };
}

interface Hours {
  byBand: Map<ScopeBand, number>;
  unregulated: number;
  unknown: number;
}

/**
 * Each teacher's teaching hours over the läsår, split by band: the lessons' own minutes (a shared row per teacher's own
 * lessons, a co-teacher the whole row, as the report charges them) over the weeks the row runs, counted in school days, / 60.
 * Never × a teacherLoadPercent, never × a factor.
 */
/**
 * A row's school-day weeks over the year, memoised on the row OBJECT. teachingWeeksByDays walks the year a day at a time, about 0,2 ms
 * a row, and a write asks it of every row the teacher has, twice (before and after), once per row of a requirements file: 1 000 rows
 * of a school with 1 800 posts cost 10 s of it, in a transaction that holds the posts' locks and times out at 15 s (review of #404, H-1).
 * The rows of a file are the same objects from one judgement to the next (RequirementImportChecks.apply replaces the one it writes),
 * so all but that one are found here. An entry is used only while everything the arithmetic reads is what it was: the year and the
 * closures (by identity and length), the row's recurrence and dates, and the year it teaches (the one grade the group holds).
 */
const WEEKS_OF_ROW = new WeakMap<
  object,
  { year: YearBounds; closures: ClosedRange[] | undefined; closuresLength: number; grade: number | null; recurrence: unknown; startDate: unknown; endDate: unknown; weeks: number }
>();

function schoolDayWeeksOf(requirement: LoadInput['requirements'][number], input: LoadInput): number {
  const grade = singleGrade(requirement.gradeSpan);
  const kept = WEEKS_OF_ROW.get(requirement);
  if (
    kept !== undefined &&
    kept.year === input.year &&
    kept.closures === input.closures &&
    kept.closuresLength === (input.closures?.length ?? 0) &&
    kept.grade === grade &&
    kept.recurrence === requirement.recurrence &&
    kept.startDate === requirement.startDate &&
    kept.endDate === requirement.endDate
  ) {
    return kept.weeks;
  }
  const weeks = teachingWeeksByDays(requirement, input.year, input.closures, grade);
  WEEKS_OF_ROW.set(requirement, {
    year: input.year,
    closures: input.closures,
    closuresLength: input.closures?.length ?? 0,
    grade,
    recurrence: requirement.recurrence,
    startDate: requirement.startDate,
    endDate: requirement.endDate,
    weeks,
  });
  return weeks;
}

function hoursPerTeacher(input: LoadInput, bands: readonly ScopeBand[]): Map<string, Hours> {
  const hours = new Map<string, Hours>();
  const slot = (userId: string): Hours => {
    let h = hours.get(userId);
    if (!h) {
      h = { byBand: new Map(), unregulated: 0, unknown: 0 };
      hours.set(userId, h);
    }
    return h;
  };
  for (const requirement of input.requirements) {
    const weeks = schoolDayWeeksOf(requirement, input);
    if (weeks === 0) continue;
    const placed = placeSpan(requirement.gradeSpan, bands);
    const parts = teacherPartsOf(requirement).map((part) => ({ userId: part.teacherId, minutes: part.minutes }));
    // The co-teacher is in the room for every lesson and is charged the whole row, as the report does.
    parts.push({ userId: requirement.coTeacherId, minutes: weeklyMinutesOf(requirement) });
    for (const part of parts) {
      if (part.userId === null) continue;
      const own = (part.minutes * weeks) / 60;
      const h = slot(part.userId);
      if (placed.kind === 'BAND') h.byBand.set(placed.band, (h.byBand.get(placed.band) ?? 0) + own);
      else if (placed.kind === 'UNREGULATED') h.unregulated += own;
      else h.unknown += own;
    }
  }
  return hours;
}

/**
 * The year's scope report, for every teacher with a post or with teaching.
 *
 * `versions` is every lydelse the table holds (a handful of rows); the year's first day picks one. `report` is the load
 * report of the same input, for the working time (annualHours) and the uppdrag's hours. `ownLevelHours`, when given, is a
 * teacher's own highest level at full time, never above the ordinance's: a rektor's placement in the span (8 §).
 */
export function buildScopeReport(
  input: LoadInput,
  report: Pick<TeacherLoadReport, 'teachers'>,
  versions: readonly ScopeVersion[],
  options: { ownLevelHours?: ReadonlyMap<string, number> } = {},
): ScopeReport {
  const version = versionInForce(versions, input.year.startDate);
  const numbering: GradeNumbering = input.year.gradeNumbering ?? 'NIOARIG';
  const bands = (version?.bands ?? []).filter((b) => b.schoolForm === SCOPE_SCHOOL_FORM && b.gradeNumbering === numbering);
  const yearReason: ScopeYearReason | null = version === null ? 'NOT_IN_FORCE' : bands.length === 0 ? 'NUMBERING_NOT_COVERED' : null;
  const hours = hoursPerTeacher(input, yearReason === null ? bands : []);
  const reportByUser = new Map(report.teachers.map((teacher) => [teacher.userId, teacher]));
  const employmentByUser = new Map<string, LoadEmployment>(input.employments.map((row) => [row.userId, row]));

  const teachers: TeacherScope[] = [];
  const userIds = new Set<string>([...employmentByUser.keys(), ...hours.keys()]);
  for (const userId of [...userIds].sort()) {
    const h = hours.get(userId) ?? { byBand: new Map<ScopeBand, number>(), unregulated: 0, unknown: 0 };
    const employment = employmentByUser.get(userId) ?? null;
    const inBands = [...h.byBand.values()].reduce((sum, value) => sum + value, 0);
    const total = inBands + h.unregulated + h.unknown;
    const stages: ScopeStageHours[] = [...h.byBand.entries()]
      .map(([band, value]) => ({
        gradeFrom: band.gradeFrom,
        gradeTo: band.gradeTo,
        hours: round1(value),
        teachingHoursLow: band.teachingHoursLow,
        teachingHoursHigh: band.teachingHoursHigh,
        planningFloorPercent: band.planningFloorPercent,
      }))
      .sort((a, b) => a.gradeFrom - b.gradeFrom);

    const assessment = input.scopeAssessments?.get(userId);
    const base: TeacherScope = {
      userId,
      verdict: 'NOT_JUDGED',
      notJudged: null,
      teachingHours: round1(total),
      stages,
      unregulatedHours: round1(h.unregulated),
      unknownGradeHours: round1(h.unknown),
      fullTimeHighestHours: null,
      fullTimeLowestHours: null,
      highestHours: null,
      ordinanceHighestHours: null,
      planningFloorHours: null,
      remainingHours: null,
      planningFits: null,
      ...(assessment ? { assessment } : {}),
    };
    if (yearReason !== null) {
      teachers.push(base);
      continue;
    }
    if (total === 0) {
      teachers.push({ ...base, notJudged: 'NO_TEACHING' });
      continue;
    }
    if (inBands === 0) {
      teachers.push({ ...base, notJudged: 'NO_STAGE' });
      continue;
    }
    // Blended by hours over the stages that have a band (T2).
    let high = 0;
    let low = 0;
    let planning = 0;
    for (const [band, value] of h.byBand) {
      high += (value / inBands) * band.teachingHoursHigh;
      low += (value / inBands) * band.teachingHoursLow;
      planning += (value * band.planningFloorPercent) / 100;
    }
    const withFloor: TeacherScope = {
      ...base,
      fullTimeHighestHours: round1(high),
      fullTimeLowestHours: round1(low),
      planningFloorHours: round1(planning),
    };
    if (employment === null) {
      teachers.push({ ...withFloor, notJudged: 'NO_POST' });
      continue;
    }

    // Part-time: the span scales with tjänst minus nedsättning, weighted by teaching weeks over the post's stretches.
    const stretches = changesDuringYear(employment, input.year) ? stretchLoads(input, employment) : null;
    const active = activePercentOf(employment, stretches);
    const share = active === null ? 0 : active / 100;
    const ordinanceHighest = high * share;
    // The rektor's level: an explicit map (a caller's what-if) first, then the assessment the input carries.
    const own = options.ownLevelHours?.get(userId) ?? assessment?.levelHours ?? undefined;
    const ownHighest = own === undefined ? null : Math.min(own, high) * share;
    const highest = ownHighest === null ? ordinanceHighest : Math.min(ownHighest, ordinanceHighest);
    // Judged on the printed figures: 650.04 h prints as 650.0 and is not over 650.0.
    const shown = round1(total);
    // OVER_MAX is judged on the hours in a stage (T7): förskoleklass and groups with no årskurs are counted in the total but are
    // outside the ordinance's stages, and past the edge only with them is a cause of its own and no OVER_MAX.
    const overInStages = round1(inBands) > round1(ordinanceHighest);
    const overOnlyWithUnregulated = !overInStages && shown > round1(ordinanceHighest);
    // OVER_OWN needs a level of the teacher's own under the ordinance's edge: without one, "over the line that was set" would
    // name the ordinance's own line.
    const verdict: ScopeVerdict = overInStages
      ? 'OVER_MAX'
      : round1(highest) < round1(ordinanceHighest) && shown > round1(highest)
        ? 'OVER_OWN'
        : 'INSIDE';

    // Does the year's working time hold the floor? Only for a full ferietjänst, whose year is the school's own figure.
    const annual = reportByUser.get(userId)?.annual;
    let remaining: number | null = null;
    if (annual && annual.annualHours !== null) {
      remaining = round1(annual.annualHours - total - annual.dutyHoursPerYear);
    }
    teachers.push({
      ...withFloor,
      verdict,
      highestHours: round1(highest),
      ordinanceHighestHours: round1(ordinanceHighest),
      remainingHours: remaining,
      planningFits: remaining === null ? null : remaining >= round1(planning),
      ...(overOnlyWithUnregulated ? { overOnlyWithUnregulated: true as const } : {}),
    });
  }

  const seen = new Set<string>();
  const interpretations: ScopeReport['interpretations'] = [];
  for (const band of bands) {
    if (band.note !== null && !seen.has(band.note)) {
      seen.add(band.note);
      interpretations.push({ section: band.planningSection, note: band.note });
    }
  }
  if (teachers.some((teacher) => teacher.overOnlyWithUnregulated)) interpretations.push(UNREGULATED_HOURS_INTERPRETATION);
  return {
    version: version
      ? { code: version.code, sfs: version.sfs, title: version.title, validFrom: version.validFrom, validTo: version.validTo, source: version.source }
      : null,
    yearReason,
    interpretations,
    teachers,
  };
}

/**
 * One teacher's scope over the year as `input` states it, for a write's before and after: the same figures the report gives
 * (buildScopeReport), computed over the rows that name the teacher alone, so the cost of asking is the teacher's own rows and not
 * the school's. The report passed in is empty, so the working time left and whether it holds the planning floor are not
 * asked: a write is judged on the teaching hours and the span.
 */
export function scopeOfTeacher(
  input: LoadInput,
  versions: readonly ScopeVersion[],
  userId: string,
  options: { ownLevelHours?: ReadonlyMap<string, number> } = {},
): TeacherScope | null {
  const mine: LoadInput = {
    ...input,
    requirements: input.requirements.filter(
      (row) => row.teacherId === userId || row.coTeacherId === userId || (row.shares ?? []).some((share) => share.teacherId === userId),
    ),
    employments: input.employments.filter((row) => row.userId === userId),
  };
  return buildScopeReport(mine, { teachers: [] }, versions, options).teachers.find((row) => row.userId === userId) ?? null;
}

/**
 * The same teacher's figures for a reader who may not read the post's percentages (hr-visibility.ts): the verdict
 * stays, and every figure that is the span × the post, or the working time less the teaching, goes, because with the
 * ordinance's span known either gives the percentage back.
 */
export function hideScopeHr(teacher: TeacherScope): TeacherScope {
  const hidden: TeacherScope = { ...teacher, highestHours: null, ordinanceHighestHours: null, remainingHours: null, planningFits: null };
  if (teacher.assessment) {
    hidden.assessment = { levelHours: null, exceptionKind: teacher.assessment.exceptionKind, ownInitiativeOn: null, note: null, decidedAt: null };
  }
  return hidden;
}
