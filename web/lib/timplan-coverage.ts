// Den lokala timplanen mot den nationella, as the browser computes it.
//
// A MIRROR OF src/common/timplan-coverage.ts, not a second opinion on it. The
// gateway computes the verdict document for GET /local-timplans/:id/check and
// for the answer to PUT /:id/entries; this copy exists so the grid on
// /admin/timplan can repaint a stage sum and its colour while the admin is
// still typing, before anything is saved. Once a save answers, the page shows
// the gateway's own document again — the two must therefore agree to the
// tenth of an hour, or a cell would turn green on a keystroke and amber on
// save. Both copies replay one fixture,
// src/common/__fixtures__/timplan-coverage-cases.json (generated from the
// gateway copy), asserted by timplan-coverage.contract.spec.ts there and
// timplan-coverage.contract.test.ts here. A case is added for both sides at
// once; the code is fixed, never the fixture.
//
// What the numbers mean — minute-tenths so 35.6 weeks never drifts, skolans
// val as time TAKEN from cells and PLACED elsewhere rather than a cell of its
// own (and claimed only where the bilaga prints a pool), Svenska/SvA and
// språkval as alternatives taken at the longest per årskurs, a short figure
// rounded down so planned + deficit is the target, the per-child minima judged
// only where the plan names a child, the grade→stage cut keyed on the lydelse,
// every verdict a warning, a plan's årskurs span cutting the stadier it is
// judged against — is argued in the gateway file's header and not repeated
// here. The body below is that
// file with the quotes this package's style uses; keep it that way, so a diff
// of the two shows only the header.

export type SchoolForm =
  | "GRUNDSKOLA"
  | "ANPASSAD_GRUNDSKOLA_AMNEN"
  | "ANPASSAD_GRUNDSKOLA_AMNESOMRADEN"
  | "SPECIALSKOLA"
  | "SAMESKOLA";

export type TimplanStage = "LAG" | "MELLAN" | "HOG" | "LAG_MELLAN";

/** The three stages an årskurs can belong to; LAG_MELLAN is a union of two. */
export type BaseStage = "LAG" | "MELLAN" | "HOG";

export interface CoverageNationalEntry {
  subjectCode: string;
  stage: TimplanStage;
  hours: number;
  minimumHoursPerChild: number | null;
  protectedFromReduction: boolean;
}

export interface CoverageVersion {
  code: string;
  schoolForm: SchoolForm;
  totalHours: number;
  skolansValHours: number | null;
  reductionCapPercent: number | null;
  /** 'HT2024' — the cohort term the lydelse first applies to. */
  appliesFromCohortTerm: string;
  entries: CoverageNationalEntry[];
}

export interface CoverageNationalSubject {
  code: string;
  parentCode: string | null;
}

export interface CoverageSubject {
  id: string;
  name: string;
  nationalCode: string | null;
  countsTowardTimplan: boolean;
}

export interface CoverageEntry {
  subjectId: string;
  gradeLevel: number;
  minutesPerWeek: number;
}

/**
 * The årskurser a plan is for, both ends included, in the numbering of the
 * plan's lydelse (the numbering of stageGrades): 4–9 is {4, 9} on a nine-year
 * form, and the tioårig grundskola of SFS 2025:729 counts 1–10. See "The
 * plan's årskurs span".
 */
export interface GradeSpan {
  gradeFrom: number;
  gradeTo: number;
}

export interface CoverageInput {
  /** planningWeeks × 10, an integer: 356 for 35.6. See planningWeeksInTenths. */
  planningWeeksTenths: number;
  version: CoverageVersion;
  nationalSubjects: CoverageNationalSubject[];
  subjects: CoverageSubject[];
  entries: CoverageEntry[];
  /** Absent or null: the whole school form, as before the span existed. */
  gradeSpan?: GradeSpan | null;
}

export type TimplanVerdictCode =
  | "TIMPLAN_NATIONAL_DISTRIBUTION_UNPUBLISHED"
  | "TIMPLAN_SUBJECT_UNMAPPED"
  | "TIMPLAN_PROTECTED_SUBJECT_REDUCED"
  | "TIMPLAN_REDUCTION_OVER_CAP"
  | "TIMPLAN_GROUP_MINIMUM_UNMET"
  | "TIMPLAN_STAGE_BELOW_NATIONAL"
  | "TIMPLAN_PARTIAL_STAGE_BELOW_SHARE"
  | "TIMPLAN_SKOLANS_VAL_OVERSPENT"
  | "TIMPLAN_TOTAL_BELOW_GUARANTEE"
  | "TIMPLAN_TOTAL_NOT_JUDGED_FOR_SPAN";

export type TimplanVerdictSeverity = "notice" | "warning";

/**
 * One finding. `params` carries every figure the sentence needs, so the web
 * formats it under its own i18n keys and the gateway in Swedish
 * (src/timplan/timplan-verdict-messages.ts) from the same numbers.
 */
export interface TimplanVerdict {
  code: TimplanVerdictCode;
  severity: TimplanVerdictSeverity;
  /** The national cell the verdict is about; absent on plan-wide verdicts. */
  subjectCode?: string;
  stage?: TimplanStage;
  /** The ämnesgrupp child under its minimum (GROUP_MINIMUM_UNMET only). */
  childCode?: string;
  /** The school subjects behind the cell, for highlighting the grid rows. */
  subjectIds?: string[];
  params: Record<string, string | number>;
}

export interface ChildCoverage {
  subjectCode: string;
  minimumHours: number;
  plannedHours: number;
}

export interface CellCoverage {
  /** Top-level national code: MA, SV_SVA, NO, SO, HKK … */
  subjectCode: string;
  stage: TimplanStage;
  /** 0 for an extra cell: a code planned where this version prints none. */
  nationalHours: number;
  plannedHours: number;
  /** Rounded UP to the tenth; 0 when the cell is met. */
  deficitHours: number;
  surplusHours: number;
  /** deficit / national, in percent, rounded UP to the tenth. */
  reducedPercent: number;
  protectedFromReduction: boolean;
  /** Present when the version prints child minima for this group cell. */
  children?: ChildCoverage[];
  /**
   * Present on a cell of a stadium the plan's span holds PART of: `held` of the
   * stadium's `of` årskurser. nationalHours (and the children's minima) are then
   * the proportional share the plan is compared with, to the nearest tenth.
   */
  share?: { held: number; of: number };
  subjectIds: string[];
}

export interface UnmappedCoverage {
  subjectId: string;
  subjectName: string;
  plannedHours: number;
}

export interface TimplanCheck {
  versionCode: string;
  distributionPublished: boolean;
  planningWeeks: number;
  stageGrades: Record<BaseStage, number[]>;
  cells: CellCoverage[];
  unmapped: UnmappedCoverage[];
  gradesOutsideStages: number[];
  skolansVal: {
    availableHours: number | null;
    takenHours: number;
    placedHours: number;
  };
  total: {
    plannedHours: number;
    guaranteedHours: number;
    deficitHours: number;
    /** false: no cells to sum a guarantee from, and the span is part of the form (deficitHours 0). */
    judged?: false;
  };
  /**
   * Present when the plan has a span. `partial` is false when it holds every
   * årskurs of the form, and the numbers are then those of no span.
   */
  gradeSpan?: GradeSpan & { partial: boolean };
  verdicts: TimplanVerdict[];
}

const STAGE_ORDER: Record<TimplanStage, number> = { LAG: 0, LAG_MELLAN: 1, MELLAN: 2, HOG: 3 };

const VERDICT_ORDER: Record<TimplanVerdictCode, number> = {
  TIMPLAN_NATIONAL_DISTRIBUTION_UNPUBLISHED: 0,
  TIMPLAN_SUBJECT_UNMAPPED: 1,
  TIMPLAN_PROTECTED_SUBJECT_REDUCED: 2,
  TIMPLAN_REDUCTION_OVER_CAP: 3,
  TIMPLAN_GROUP_MINIMUM_UNMET: 4,
  TIMPLAN_STAGE_BELOW_NATIONAL: 5,
  TIMPLAN_PARTIAL_STAGE_BELOW_SHARE: 6,
  TIMPLAN_SKOLANS_VAL_OVERSPENT: 7,
  TIMPLAN_TOTAL_BELOW_GUARANTEE: 8,
  TIMPLAN_TOTAL_NOT_JUDGED_FOR_SPAN: 9,
};

/** One hour in minute-tenths. */
const HOUR = 600;

/**
 * National codes whose school subjects a pupil reads INSTEAD of each other,
 * so a cell takes the longest of them per årskurs rather than their sum. See
 * "Rolling school subjects into national cells".
 */
export const TIMPLAN_ALTERNATIVE_CODES: readonly string[] = ["SV_SVA", "M2"];

/** The ämnesområden bilaga's free-time cell, where an uncoded subject belongs. */
const FREE_TIME_CODE = "FORDELNINGSBAR";

/** What a reduced cell's or an uncoded subject's time counts as, by the bilaga. */
export type TimplanTimeCountsAs = "skolansVal" | "fordelningsbar" | "own" | "none";

/**
 * Code-unit order for codes and ids, Swedish collation for names: the same on
 * every runtime, so the gateway and the web sort a report identically.
 */
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byName = (a: string, b: string): number => a.localeCompare(b, "sv");

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

/**
 * planningWeeks as an integer number of tenths: 35.6 → 356.
 *
 * Takes what a caller holds — a Prisma Decimal (anything whose toString() is
 * the decimal text), a number from a form, or the string PostgREST renders a
 * NUMERIC as — and refuses anything that is not a finite figure with at most
 * one decimal inside the column's 20.0..40.0. Never coerces a missing value to
 * 0: a plan whose weeks could not be read must fail loudly, not report every
 * stage as empty.
 */
export function planningWeeksInTenths(value: number | string | { toString(): string }): number {
  const text = typeof value === "number" ? String(value) : value.toString();
  if (!/^\d{1,3}(\.\d)?0*$/.test(text.trim())) {
    throw new Error(`planningWeeks "${text}" is not a number of weeks with one decimal`);
  }
  const tenths = Math.round(Number(text) * 10);
  if (!Number.isSafeInteger(tenths) || tenths < 200 || tenths > 400) {
    throw new Error(`planningWeeks ${text} is outside 20.0..40.0`);
  }
  return tenths;
}

/**
 * Refuses a span that is not two whole årskurser of a plan row (0..11) in
 * order. Like planningWeeks, a span that could not be read must fail loudly:
 * quietly reading it as "the whole form" would judge a 4–9 plan against the
 * lågstadium again.
 */
export function assertGradeSpan(span: GradeSpan): void {
  const { gradeFrom, gradeTo } = span;
  if (
    !Number.isInteger(gradeFrom) ||
    !Number.isInteger(gradeTo) ||
    gradeFrom < 0 ||
    gradeTo > 11 ||
    gradeFrom > gradeTo
  ) {
    throw new Error(`gradeSpan ${gradeFrom}..${gradeTo} is not a span of årskurser inside 0..11`);
  }
}

/**
 * A plan row's span: both columns set, or none. Anything that is not two
 * numbers (null, or a row that predates the columns) is the whole school form.
 */
export function gradeSpanOf(plan: {
  gradeFrom?: number | null;
  gradeTo?: number | null;
}): GradeSpan | null {
  return typeof plan.gradeFrom === "number" && typeof plan.gradeTo === "number"
    ? { gradeFrom: plan.gradeFrom, gradeTo: plan.gradeTo }
    : null;
}

/** Whether `grade` is inside the span; every årskurs is, with no span. */
export function inGradeSpan(span: GradeSpan | null | undefined, grade: number): boolean {
  return !span || (grade >= span.gradeFrom && grade <= span.gradeTo);
}

/**
 * The årskurser of each stadium that the span holds; the stadier themselves
 * with no span. A stadium with none is one the plan is not for.
 */
export function heldStageGrades(
  stageGrades: Record<BaseStage, number[]>,
  span: GradeSpan | null | undefined,
): Record<BaseStage, number[]> {
  return {
    LAG: stageGrades.LAG.filter((grade) => inGradeSpan(span, grade)),
    MELLAN: stageGrades.MELLAN.filter((grade) => inGradeSpan(span, grade)),
    HOG: stageGrades.HOG.filter((grade) => inGradeSpan(span, grade)),
  };
}

/** The lydelse's first cohort year: 'HT2024' → 2024. */
export function cohortYear(term: string): number {
  const match = /^(?:HT|VT)(\d{4})$/.exec(term);
  return match ? Number(match[1]) : 0;
}

/**
 * Which årskurser make each stadium, for this version.
 *
 * Today's lydelser (migration 20261006120000's table): nine-year forms 1–3 /
 * 4–6 / 7–9; specialskolan 1–4 / 5–7 / 8–10; sameskolan 1–3 / 4–6 and no
 * högstadium. A lydelse applying from 2028 or later is the tioårig grundskola:
 * förskoleklassen becomes årskurs 1, and the forms run 1–4 / 5–7 / 8–10
 * (sameskolan 1–4 / 5–7; specialskolan, eleven årskurser, 1–5 / 6–8 / 9–11 —
 * SFS 2025:729 10 kap. 3 §, 11 kap. 4 §, 12 kap. 3 §, 13 kap. 3 §).
 */
export function stageGradesFor(
  version: Pick<CoverageVersion, "schoolForm" | "appliesFromCohortTerm">,
): Record<BaseStage, number[]> {
  const reformed = cohortYear(version.appliesFromCohortTerm) >= 2028;
  switch (version.schoolForm) {
    case "SPECIALSKOLA":
      return reformed
        ? { LAG: range(1, 5), MELLAN: range(6, 8), HOG: range(9, 11) }
        : { LAG: range(1, 4), MELLAN: range(5, 7), HOG: range(8, 10) };
    case "SAMESKOLA":
      return reformed
        ? { LAG: range(1, 4), MELLAN: range(5, 7), HOG: [] }
        : { LAG: range(1, 3), MELLAN: range(4, 6), HOG: [] };
    default:
      return reformed
        ? { LAG: range(1, 4), MELLAN: range(5, 7), HOG: range(8, 10) }
        : { LAG: range(1, 3), MELLAN: range(4, 6), HOG: range(7, 9) };
  }
}

/** Minute-tenths → hours to the nearest tenth. */
const hours = (minuteTenths: number): number => Math.round(minuteTenths / 60) / 10;

/** Minute-tenths → hours rounded DOWN to the tenth: a figure that is short reads short. */
const hoursDown = (minuteTenths: number): number => Math.floor(minuteTenths / 60) / 10;

/** Minute-tenths → hours rounded UP to the tenth: a shortfall never reads 0,0. */
const hoursUp = (minuteTenths: number): number => Math.ceil(minuteTenths / 60) / 10;

/** part / whole in percent, rounded UP to the tenth. */
const percentUp = (part: number, whole: number): number =>
  whole === 0 ? 0 : Math.ceil((part * 1000) / whole) / 10;

interface CellAccumulator {
  subjectCode: string;
  stage: TimplanStage;
  national: number;
  planned: number;
  protectedFromReduction: boolean;
  /** child code → minimum in minute-tenths, for the children this cell prints. */
  minima: Map<string, number>;
  /** child code → planned minute-tenths. */
  childPlanned: Map<string, number>;
  /** årskurs → the longest alternative's minute-tenths (alternative codes only). */
  longestByGrade: Map<number, number>;
  /** Set when the plan's span holds part of the cell's stadium: national is then the share. */
  share?: Share;
  subjectIds: Set<string>;
}

/** `held` of a stadium's `of` årskurser. */
interface Share {
  held: number;
  of: number;
}

/** A cell of a plan without a span, or of a stadium the span holds whole. */
const WHOLE: Share = { held: 1, of: 1 };

const cellKey = (code: string, stage: TimplanStage): string => `${code}:${stage}`;

/**
 * The national cell a national code's minutes go to in a base stage: its
 * TOP-LEVEL code (a child of an ämnesgrupp rolls into the group's cell), in
 * the merged LAG_MELLAN cell when the version prints one for that code
 * outside högstadiet. P1's roll-up, shared with the stage module
 * (timplan-stage.ts), so a pupil's stage cells are cut exactly as a plan's.
 */
export function nationalCellOf(
  code: string,
  baseStage: BaseStage,
  parentOf: ReadonlyMap<string, string | null>,
  mergedCodes: ReadonlySet<string>,
): { top: string; stage: TimplanStage } {
  const top = parentOf.get(code) ?? code;
  return { top, stage: baseStage !== "HOG" && mergedCodes.has(top) ? "LAG_MELLAN" : baseStage };
}

export function checkLocalTimplan(input: CoverageInput): TimplanCheck {
  const { version } = input;
  const weeks = input.planningWeeksTenths;
  if (!Number.isSafeInteger(weeks) || weeks <= 0) {
    throw new Error(`planningWeeksTenths ${weeks} is not a positive integer`);
  }

  const span = input.gradeSpan ?? null;
  if (span !== null) assertGradeSpan(span);

  const stageGrades = stageGradesFor(version);
  const stageOfGrade = new Map<number, BaseStage>();
  for (const stage of ["LAG", "MELLAN", "HOG"] as const) {
    for (const grade of stageGrades[stage]) stageOfGrade.set(grade, stage);
  }
  // An årskurs outside the span belongs to no stadium of this plan, whatever
  // the form says (see "The plan's årskurs span").
  const stageOfHeldGrade = (grade: number): BaseStage | undefined =>
    inGradeSpan(span, grade) ? stageOfGrade.get(grade) : undefined;
  // How much of a cell's stadium the plan holds. The merged låg- och
  // mellanstadiet cell spans both stadiers' årskurser.
  const shareOf = (stage: TimplanStage): Share => {
    if (span === null) return WHOLE;
    const grades =
      stage === "LAG_MELLAN" ? [...stageGrades.LAG, ...stageGrades.MELLAN] : stageGrades[stage];
    return { held: grades.filter((grade) => inGradeSpan(span, grade)).length, of: grades.length };
  };
  // Whole minute-tenths, so every comparison below stays between integers: a
  // whole cell is untouched, a share (a rounded estimate by nature) is rounded
  // once, here.
  const scaled = (minuteTenths: number, share: Share): number =>
    share.held === share.of ? minuteTenths : Math.round((minuteTenths * share.held) / share.of);
  const allGrades = [...stageGrades.LAG, ...stageGrades.MELLAN, ...stageGrades.HOG];
  const partial = span !== null && allGrades.some((grade) => !inGradeSpan(span, grade));

  const parentOf = new Map(input.nationalSubjects.map((s) => [s.code, s.parentCode]));

  // The version's printed cells: top-level codes become cells, child lines
  // become minima on their group's cell in the same stage.
  const cells = new Map<string, CellAccumulator>();
  const newCell = (code: string, stage: TimplanStage, national: number, prot: boolean) => {
    const cell: CellAccumulator = {
      subjectCode: code,
      stage,
      national,
      planned: 0,
      protectedFromReduction: prot,
      minima: new Map(),
      childPlanned: new Map(),
      longestByGrade: new Map(),
      subjectIds: new Set(),
    };
    cells.set(cellKey(code, stage), cell);
    return cell;
  };
  // What the version prints, and what of it this plan holds: the guarantee and
  // the pool of a span are the held part of these.
  let printedNational = 0;
  let heldNational = 0;
  for (const entry of version.entries) {
    if (parentOf.get(entry.subjectCode)) continue;
    printedNational += entry.hours * HOUR;
    const share = shareOf(entry.stage);
    // A stadium the span lacks: not a cell of this plan, not judged.
    if (share.held === 0) continue;
    const cell = newCell(
      entry.subjectCode,
      entry.stage,
      scaled(entry.hours * HOUR, share),
      entry.protectedFromReduction,
    );
    if (share.held < share.of) cell.share = share;
    heldNational += cell.national;
  }
  for (const entry of version.entries) {
    const parent = parentOf.get(entry.subjectCode);
    if (!parent) continue;
    const share = shareOf(entry.stage);
    if (share.held === 0) continue;
    // A child line without its group's cell cannot be seeded (P0's self-check
    // 4c); were one to appear, it is held as an extra group cell's minimum.
    const cell =
      cells.get(cellKey(parent, entry.stage)) ?? newCell(parent, entry.stage, 0, false);
    cell.minima.set(entry.subjectCode, scaled(entry.hours * HOUR, share));
  }
  const hasMergedCell = new Set(
    version.entries.filter((e) => e.stage === "LAG_MELLAN").map((e) => e.subjectCode),
  );

  const subjects = new Map(input.subjects.map((s) => [s.id, s]));
  const unmapped = new Map<string, { subject: CoverageSubject; planned: number }>();
  const outside = new Set<number>();
  // Stages in which a group's children are distinguished by the plan at all.
  const childMapped = new Set<string>();

  for (const entry of input.entries) {
    const subject = subjects.get(entry.subjectId);
    if (!subject || !subject.countsTowardTimplan || entry.minutesPerWeek <= 0) continue;
    const baseStage = stageOfHeldGrade(entry.gradeLevel);
    if (!baseStage) {
      outside.add(entry.gradeLevel);
      continue;
    }
    const minuteTenths = entry.minutesPerWeek * weeks;

    if (subject.nationalCode === null) {
      const current = unmapped.get(subject.id) ?? { subject, planned: 0 };
      current.planned += minuteTenths;
      unmapped.set(subject.id, current);
      continue;
    }

    const code = subject.nationalCode;
    const { top, stage } = nationalCellOf(code, baseStage, parentOf, hasMergedCell);
    const cell = cells.get(cellKey(top, stage)) ?? newCell(top, stage, 0, false);
    cell.subjectIds.add(subject.id);
    if (TIMPLAN_ALTERNATIVE_CODES.includes(top)) {
      const longest = cell.longestByGrade.get(entry.gradeLevel) ?? 0;
      cell.longestByGrade.set(entry.gradeLevel, Math.max(longest, minuteTenths));
      continue;
    }
    cell.planned += minuteTenths;
    if (code !== top) {
      cell.childPlanned.set(code, (cell.childPlanned.get(code) ?? 0) + minuteTenths);
      childMapped.add(cellKey(top, stage));
    }
  }

  for (const cell of cells.values()) {
    for (const minuteTenths of cell.longestByGrade.values()) cell.planned += minuteTenths;
  }

  const published = version.entries.length > 0;
  const poolPrinted = published && version.skolansValHours !== null;
  // The bilaga's pool for the whole form, and the plan's share of it: the
  // fraction of the printed national hours that the plan holds.
  const pool =
    version.skolansValHours !== null && partial && published && printedNational > 0
      ? Math.round((version.skolansValHours * 10 * heldNational) / printedNational) / 10
      : version.skolansValHours;
  const unmappedCountsAs: TimplanTimeCountsAs = poolPrinted
    ? "skolansVal"
    : version.entries.some((e) => e.subjectCode === FREE_TIME_CODE)
      ? "fordelningsbar"
      : "own";
  const verdicts: TimplanVerdict[] = [];
  const sortedCells = [...cells.values()].sort(
    (a, b) =>
      byCode(a.subjectCode, b.subjectCode) || STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage],
  );

  if (!published) {
    verdicts.push({
      code: "TIMPLAN_NATIONAL_DISTRIBUTION_UNPUBLISHED",
      severity: "notice",
      params: { versionCode: version.code, totalHours: version.totalHours },
    });
  }

  const sortedUnmapped = [...unmapped.values()].sort(
    (a, b) => byName(a.subject.name, b.subject.name) || byCode(a.subject.id, b.subject.id),
  );
  for (const { subject, planned } of sortedUnmapped) {
    verdicts.push({
      code: "TIMPLAN_SUBJECT_UNMAPPED",
      severity: "notice",
      subjectIds: [subject.id],
      params: {
        subjectId: subject.id,
        subjectName: subject.name,
        plannedHours: hours(planned),
        timeCountsAs: unmappedCountsAs,
      },
    });
  }

  let taken = 0;
  let placed = 0;
  let plannedTotal = 0;
  // The partly held cells, as one group: what they are short of their shares
  // and what they are short by in all, net of what they are over.
  let takenFromShares = 0;
  let shareShortNet = 0;
  const cap = version.reductionCapPercent;

  const cellCoverage: CellCoverage[] = sortedCells.map((cell) => {
    const deficit = Math.max(0, cell.national - cell.planned);
    const surplus = Math.max(0, cell.planned - cell.national);
    taken += deficit;
    placed += surplus;
    plannedTotal += cell.planned;
    if (cell.share) {
      takenFromShares += deficit;
      shareShortNet += cell.national - cell.planned;
    }
    const subjectIds = [...cell.subjectIds].sort(byCode);
    const where = { subjectCode: cell.subjectCode, stage: cell.stage, subjectIds };

    // A cell that is short shows its planned figure rounded down, so planned
    // + deficit reads as the target (see "Display rounding").
    const plannedShown = deficit > 0 ? hoursDown(cell.planned) : hours(cell.planned);
    // The target as shown: the cell's hours, or a share of them to the tenth.
    // A share that is short is shown as planned + deficit, so the sentence adds
    // up: 33⅓ h of nothing planned read "0 h planerat, 33,4 h under andelen
    // 33,3 h" while the target was rounded to the nearest and the deficit up.
    const nationalShown = cell.share
      ? deficit > 0
        ? Math.round((plannedShown + hoursUp(deficit)) * 10) / 10
        : hours(cell.national)
      : cell.national / HOUR;
    if (deficit > 0) {
      const figures = {
        nationalHours: nationalShown,
        plannedHours: plannedShown,
        deficitHours: hoursUp(deficit),
        reducedPercent: percentUp(deficit, cell.national),
      };
      if (cell.share) {
        // Only ever a notice, protected or not (see "The plan's årskurs span").
        verdicts.push({
          code: "TIMPLAN_PARTIAL_STAGE_BELOW_SHARE",
          severity: "notice",
          ...where,
          params: { ...figures, heldGrades: cell.share.held, ofGrades: cell.share.of },
        });
      } else if (cell.protectedFromReduction) {
        verdicts.push({ code: "TIMPLAN_PROTECTED_SUBJECT_REDUCED", severity: "warning", ...where, params: figures });
      } else if (cap !== null && deficit * 100 > cap * cell.national) {
        verdicts.push({
          code: "TIMPLAN_REDUCTION_OVER_CAP",
          severity: "warning",
          ...where,
          params: { ...figures, capPercent: cap },
        });
      } else {
        verdicts.push({
          code: "TIMPLAN_STAGE_BELOW_NATIONAL",
          severity: "notice",
          ...where,
          params: { ...figures, timeCountsAs: poolPrinted ? "skolansVal" : "none" },
        });
      }
    }

    let children: ChildCoverage[] | undefined;
    if (cell.minima.size > 0) {
      const judged = childMapped.has(cellKey(cell.subjectCode, cell.stage));
      children = [...cell.minima.entries()]
        .sort(([a], [b]) => byCode(a, b))
        .map(([childCode, minimum]) => {
          const childPlanned = cell.childPlanned.get(childCode) ?? 0;
          const childShown = childPlanned < minimum ? hoursDown(childPlanned) : hours(childPlanned);
          const minimumShown = cell.share
            ? childPlanned < minimum
              ? Math.round((childShown + hoursUp(minimum - childPlanned)) * 10) / 10
              : hours(minimum)
            : minimum / HOUR;
          if (judged && childPlanned < minimum) {
            const figures = {
              childCode,
              minimumHours: minimumShown,
              plannedHours: childShown,
              deficitHours: hoursUp(minimum - childPlanned),
            };
            verdicts.push(
              cell.share
                ? {
                    code: "TIMPLAN_PARTIAL_STAGE_BELOW_SHARE",
                    severity: "notice",
                    ...where,
                    childCode,
                    params: { ...figures, heldGrades: cell.share.held, ofGrades: cell.share.of },
                  }
                : { code: "TIMPLAN_GROUP_MINIMUM_UNMET", severity: "warning", ...where, childCode, params: figures },
            );
          }
          return { subjectCode: childCode, minimumHours: minimumShown, plannedHours: childShown };
        });
    }

    return {
      subjectCode: cell.subjectCode,
      stage: cell.stage,
      nationalHours: nationalShown,
      plannedHours: plannedShown,
      deficitHours: hoursUp(deficit),
      surplusHours: hours(surplus),
      reducedPercent: percentUp(deficit, cell.national),
      protectedFromReduction: cell.protectedFromReduction,
      ...(children ? { children } : {}),
      ...(cell.share ? { share: cell.share } : {}),
      subjectIds,
    };
  });

  for (const { planned } of sortedUnmapped) {
    placed += planned;
    plannedTotal += planned;
  }

  if (pool !== null && taken > pool * HOUR) {
    // A warning when the cells held whole alone overspend it; else the partly
    // held cells' deficits are what does, and they are an estimate.
    const firm = taken - takenFromShares > pool * HOUR;
    verdicts.push({
      code: "TIMPLAN_SKOLANS_VAL_OVERSPENT",
      severity: firm ? "warning" : "notice",
      params: {
        takenHours: hoursUp(taken),
        availableHours: pool,
        overspentHours: hoursUp(taken - pool * HOUR),
        ...(partial ? { estimated: 1 } : {}),
        ...(firm ? {} : { fromShares: 1 }),
      },
    });
  }

  // The guarantee of a span is the sum of the cells it holds. A version with
  // no cells has only the whole form's total, which a part of the form is not
  // held to.
  const totalJudged = !(partial && !published);
  const guaranteed = partial && published ? heldNational : version.totalHours * HOUR;
  // A guarantee derived from the cells held is shown, when the plan is short of
  // it, as planned + deficit like a share (see "Display rounding").
  const guaranteedShown =
    partial && published
      ? plannedTotal < guaranteed
        ? Math.round((hoursDown(plannedTotal) + hoursUp(guaranteed - plannedTotal)) * 10) / 10
        : hours(guaranteed)
      : version.totalHours;
  const totalShown =
    totalJudged && plannedTotal < guaranteed ? hoursDown(plannedTotal) : hours(plannedTotal);
  if (!totalJudged) {
    verdicts.push({
      code: "TIMPLAN_TOTAL_NOT_JUDGED_FOR_SPAN",
      severity: "notice",
      params: {
        totalHours: version.totalHours,
        gradeFrom: span!.gradeFrom,
        gradeTo: span!.gradeTo,
      },
    });
  } else if (plannedTotal < guaranteed) {
    // The partly held cells' net shortfall is an estimate: with it counted as
    // met, is the plan still short? Then it is a warning; else a notice.
    const firm = plannedTotal + Math.max(0, shareShortNet) < guaranteed;
    verdicts.push({
      code: "TIMPLAN_TOTAL_BELOW_GUARANTEE",
      severity: firm ? "warning" : "notice",
      params: {
        plannedHours: totalShown,
        guaranteedHours: guaranteedShown,
        deficitHours: hoursUp(guaranteed - plannedTotal),
        ...(partial ? { estimated: 1 } : {}),
        ...(firm ? {} : { fromShares: 1 }),
      },
    });
  }

  verdicts.sort(
    (a, b) =>
      VERDICT_ORDER[a.code] - VERDICT_ORDER[b.code] ||
      (a.stage ? STAGE_ORDER[a.stage] : -1) - (b.stage ? STAGE_ORDER[b.stage] : -1) ||
      byCode(a.subjectCode ?? "", b.subjectCode ?? "") ||
      byCode(a.childCode ?? "", b.childCode ?? ""),
  );

  return {
    versionCode: version.code,
    distributionPublished: published,
    planningWeeks: weeks / 10,
    stageGrades,
    cells: cellCoverage,
    unmapped: sortedUnmapped.map(({ subject, planned }) => ({
      subjectId: subject.id,
      subjectName: subject.name,
      plannedHours: hours(planned),
    })),
    gradesOutsideStages: [...outside].sort((a, b) => a - b),
    // Without a published distribution every coded minute sits in an extra
    // cell, and "placed" would read as the whole plan. Nothing can be taken
    // from cells that do not exist either, so the pool is simply not stated.
    skolansVal: published
      ? { availableHours: pool, takenHours: hoursUp(taken), placedHours: hours(placed) }
      : { availableHours: null, takenHours: 0, placedHours: 0 },
    total: {
      plannedHours: totalShown,
      guaranteedHours: guaranteedShown,
      deficitHours: totalJudged ? hoursUp(Math.max(0, guaranteed - plannedTotal)) : 0,
      ...(totalJudged ? {} : { judged: false as const }),
    },
    ...(span !== null ? { gradeSpan: { ...span, partial } } : {}),
    verdicts,
  };
}
