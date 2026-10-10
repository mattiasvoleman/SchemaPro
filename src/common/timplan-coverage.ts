/*
 * Den lokala timplanen mot den nationella: what a school's plan in minutes per
 * week per årskurs amounts to per stadium, set beside the statute's hours —
 * computed, never stored.
 *
 * PURE ARITHMETIC. No Prisma, no clock, no school. The gateway hands in one
 * plan's entries, the school subjects they name, the national version the plan
 * is checked against and the national subject list, and gets the verdict
 * document back. web/lib/timplan-coverage.ts mirrors this file so the grid can
 * repaint a cell before the round trip; both replay
 * src/common/__fixtures__/timplan-coverage-cases.json, so neither can drift
 * from the other without a test saying so (timplan-coverage.contract.spec.ts).
 *
 * EVERY VERDICT IS A WARNING. Nothing here refuses anything: the law lets a
 * pupil's anpassade studiegång and prioriterade timplan deviate, and a rektor in
 * anpassade grundskolan decide the distribution. The codes say "under mål",
 * and the severity says how loudly — `notice` for what a school may lawfully
 * do (reduce a cell for skolans val within the cap, add a subject of its own),
 * `warning` for what the statute's own sentences rule out (a protected subject
 * reduced, a cell past the cap, a NO/SO child under its minimum, the pool or the
 * guarantee overspent).
 *
 * ## The arithmetic, in integers
 *
 * Stage hours = Σ over the stage's årskurser of minutesPerWeek × planningWeeks
 * / 60. planningWeeks is NUMERIC(4,1) — 35.6 by default — and 35.6 is not a
 * binary fraction, so every sum here is kept in MINUTE-TENTHS: minutesPerWeek ×
 * (planningWeeks × 10), an exact integer. A national cell of H hours is H × 600
 * minute-tenths. Every comparison (below, over cap, under minimum, total) is
 * made between those integers; only the figures handed out for display are
 * divided, once, at the end. 236 + 236 + 235 min/vecka of matematik over 35.6
 * weeks is 25 169.2 minutes, 0.51 h short of lågstadiets 420 — and that half
 * hour is a protected subject reduced, which float arithmetic could round away.
 *
 * Display rounding: planned hours to the nearest tenth; a DEFICIT rounded UP
 * to the tenth (and its percentage likewise), so a cell that is short at all
 * never reads "0,0 h under". The verdict was decided on the exact integers
 * before any of that. And a figure that IS short is shown rounded DOWN, so
 * planned + deficit is the target the reader sees: 231 + 230 + 230 min of
 * matematik over 35.6 weeks is 409,99 h, which to the nearest tenth read
 * "410 h planerat, 0,1 h under målet 410 h". The same holds for a NO/SO
 * child under its minimum and for a total under the guarantee.
 *
 * ## Rolling school subjects into national cells
 *
 * A plan is keyed on the SCHOOL subject; the statute on the national code.
 *
 *   * countsTowardTimplan = false (Resurs, Studiehandledning): excluded from
 *     every sum, listed nowhere. The school said it is not undervisning.
 *   * nationalCode set: its minutes go to the cell of its TOP-LEVEL code in
 *     the stage the årskurs belongs to. A child of an ämnesgrupp (BI under NO,
 *     GE under SO) rolls into the group's cell — the statute's group hours
 *     already hold the children's — and is ALSO counted against its own
 *     per-child minimum.
 *   * ALTERNATIVES. Two cells name subjects a pupil reads INSTEAD of each
 *     other: SV_SVA ("svenska eller svenska som andraspråk") and M2
 *     (språkval: one modern language, modersmål, teckenspråk … per pupil).
 *     Their school subjects are not added; per årskurs the cell takes the
 *     LONGEST of them, and the stage sum is taken over those. Adding them up
 *     reported three språkval languages at 30 + 60 min as 53,4 h of a 48 h
 *     mellanstadium cell — met, with no verdict anywhere — when each pupil got
 *     17,8 h, and lifted a plan's total past a guarantee it was short of. The
 *     longest and not the shortest, because this is the PLAN's check: it says
 *     whether the plan offers the time, and an SvA group planned beside a full
 *     Svenska ("Svenska 200 + SvA-grupp 60") offers it. That a pupil placed in
 *     the shorter alternative gets less is a per-pupil verdict (P2), and the
 *     grid shows each alternative's own row hours.
 *     A subject whose code has a merged "låg- och mellanstadiet" cell in this
 *     version (hem- och konsumentkunskap) rolls årskurs 1–6 (1–7 in
 *     specialskolan) into that one cell.
 *   * nationalCode set but no such cell in this version (språkval in åk 1–3,
 *     teckenspråk in a grundskola plan): an extra cell with 0 national hours.
 *     Its time is the school's own and counts as skolans val placed, below.
 *   * nationalCode null: see skolans val.
 *
 * ## Skolans val — the decision this module encodes
 *
 * The bilagor print "Därav skolans val 600" UNDER a total the cells already sum
 * to: skolans val is not a cell of its own but time the school TAKES from the
 * cells — at most 20 % (15 % in sameskolan) of one cell, never from svenska/SvA,
 * engelska, matematik or språkval (nor samiska in sameskolan), at most the
 * pool in all — and PLACES where it chooses. So it is accounted for on both
 * sides and needs no column anywhere:
 *
 *   * TAKEN = Σ over national cells of max(0, national − planned). That is what
 *     the pool limits; more than skolansValHours is TIMPLAN_SKOLANS_VAL_OVERSPENT.
 *   * PLACED = Σ over cells of max(0, planned − national), extra cells included,
 *     plus every counted subject WITHOUT a national code. "Programmering" with
 *     no code, or a fourth weekly matematik lesson, is skolans val time; it is
 *     added to the plan's total and reported as placed, never as an error.
 *
 * The guarantee is the total: Σ planned over every stage (cells, extra cells
 * and uncoded subjects) against totalHours. Time taken and not placed shows up
 * there as TIMPLAN_TOTAL_BELOW_GUARANTEE, which is what "the hours went
 * nowhere" means in the statute's terms.
 *
 * Only where the bilaga prints a pool. Ämnesområden (B2B) prints none — its
 * free time is the cell "Fördelningsbar undervisningstid" (FORDELNINGSBAR) —
 * and the 2028 law has published no distribution yet. The arithmetic above is
 * the same everywhere (taken and placed are still reported, against no pool);
 * what changes is what a sentence may claim, so TIMPLAN_STAGE_BELOW_NATIONAL
 * and TIMPLAN_SUBJECT_UNMAPPED carry `timeCountsAs`: 'skolansVal' where the
 * version prints a pool; otherwise 'none' for a reduced cell (the bilaga says
 * nothing of where it goes) and, for an uncoded subject, 'fordelningsbar'
 * when the version prints that cell (map the subject to it) or 'own'.
 *
 * An uncoded counted subject still gets TIMPLAN_SUBJECT_UNMAPPED — as a
 * NOTICE, saying its hours are counted as skolans val. The module cannot tell
 * "Programmering, the school's own" from "SvA, mapping forgotten" (the risk
 * the design names first: a forgotten SvA reads as a deficit in SV_SVA), and
 * the notice is how a school finds out which it was. Mentorstid belongs in
 * countsTowardTimplan = false, and the notice says that too.
 *
 * ## Per-child minima
 *
 * Checked where the plan distinguishes the children at all: a stage in which
 * at least one school subject maps to a child code (BI, FY, KE; GE, HI, RE,
 * SH). Every child of that group with a minimum in the version is then held to
 * it, and a child the school plans 0 for is under its minimum. A plan that
 * teaches NO as one integrated subject (code NO) in that stage states nothing
 * per child, and the module does not invent a split to judge — the group's own
 * hours are still checked like any other cell.
 *
 * ## Grade → stage, keyed on the version
 *
 * The mapping depends on the school form AND the lydelse; see the preamble of
 * migration 20261006120000. Årskurs 0 (förskoleklass) and any årskurs the form
 * lacks belong to no stage: their minutes are reported in gradesOutsideStages
 * and enter no sum. That is not a verdict — a school planning its F-klass in
 * the same grid has done nothing wrong — but the grid can grey the column.
 *
 * A version with no cells (SFS 2025:729: the 2028 law is enacted, its
 * fördelning is not) yields TIMPLAN_NATIONAL_DISTRIBUTION_UNPUBLISHED and no
 * cell verdicts at all: "fördelning ej publicerad", never zero hours in every
 * cell. Its total IS law (7 424 h), so the plan's total is still held to it.
 */

export type SchoolForm =
  | 'GRUNDSKOLA'
  | 'ANPASSAD_GRUNDSKOLA_AMNEN'
  | 'ANPASSAD_GRUNDSKOLA_AMNESOMRADEN'
  | 'SPECIALSKOLA'
  | 'SAMESKOLA';

export type TimplanStage = 'LAG' | 'MELLAN' | 'HOG' | 'LAG_MELLAN';

/** The three stages an årskurs can belong to; LAG_MELLAN is a union of two. */
export type BaseStage = 'LAG' | 'MELLAN' | 'HOG';

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

export interface CoverageInput {
  /** planningWeeks × 10, an integer: 356 for 35.6. See planningWeeksInTenths. */
  planningWeeksTenths: number;
  version: CoverageVersion;
  nationalSubjects: CoverageNationalSubject[];
  subjects: CoverageSubject[];
  entries: CoverageEntry[];
}

export type TimplanVerdictCode =
  | 'TIMPLAN_NATIONAL_DISTRIBUTION_UNPUBLISHED'
  | 'TIMPLAN_SUBJECT_UNMAPPED'
  | 'TIMPLAN_PROTECTED_SUBJECT_REDUCED'
  | 'TIMPLAN_REDUCTION_OVER_CAP'
  | 'TIMPLAN_GROUP_MINIMUM_UNMET'
  | 'TIMPLAN_STAGE_BELOW_NATIONAL'
  | 'TIMPLAN_SKOLANS_VAL_OVERSPENT'
  | 'TIMPLAN_TOTAL_BELOW_GUARANTEE';

export type TimplanVerdictSeverity = 'notice' | 'warning';

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
  };
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
  TIMPLAN_SKOLANS_VAL_OVERSPENT: 6,
  TIMPLAN_TOTAL_BELOW_GUARANTEE: 7,
};

/** One hour in minute-tenths. */
const HOUR = 600;

/**
 * National codes whose school subjects a pupil reads INSTEAD of each other,
 * so a cell takes the longest of them per årskurs rather than their sum. See
 * "Rolling school subjects into national cells".
 */
export const TIMPLAN_ALTERNATIVE_CODES: readonly string[] = ['SV_SVA', 'M2'];

/** The ämnesområden bilaga's free-time cell, where an uncoded subject belongs. */
const FREE_TIME_CODE = 'FORDELNINGSBAR';

/** What a reduced cell's or an uncoded subject's time counts as, by the bilaga. */
export type TimplanTimeCountsAs = 'skolansVal' | 'fordelningsbar' | 'own' | 'none';

/**
 * Code-unit order for codes and ids, Swedish collation for names: the same on
 * every runtime, so the gateway and the web sort a report identically.
 */
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byName = (a: string, b: string): number => a.localeCompare(b, 'sv');

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
  const text = typeof value === 'number' ? String(value) : value.toString();
  if (!/^\d{1,3}(\.\d)?0*$/.test(text.trim())) {
    throw new Error(`planningWeeks "${text}" is not a number of weeks with one decimal`);
  }
  const tenths = Math.round(Number(text) * 10);
  if (!Number.isSafeInteger(tenths) || tenths < 200 || tenths > 400) {
    throw new Error(`planningWeeks ${text} is outside 20.0..40.0`);
  }
  return tenths;
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
 * (sameskolan 1–4 / 5–7). Specialskolan's 2028 re-cut would need an årskurs 11
 * the table cannot hold and is not seeded; it keeps today's cut until it is.
 */
export function stageGradesFor(
  version: Pick<CoverageVersion, 'schoolForm' | 'appliesFromCohortTerm'>,
): Record<BaseStage, number[]> {
  const reformed = cohortYear(version.appliesFromCohortTerm) >= 2028;
  switch (version.schoolForm) {
    case 'SPECIALSKOLA':
      return { LAG: range(1, 4), MELLAN: range(5, 7), HOG: range(8, 10) };
    case 'SAMESKOLA':
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
  subjectIds: Set<string>;
}

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
  return { top, stage: baseStage !== 'HOG' && mergedCodes.has(top) ? 'LAG_MELLAN' : baseStage };
}

export function checkLocalTimplan(input: CoverageInput): TimplanCheck {
  const { version } = input;
  const weeks = input.planningWeeksTenths;
  if (!Number.isSafeInteger(weeks) || weeks <= 0) {
    throw new Error(`planningWeeksTenths ${weeks} is not a positive integer`);
  }

  const stageGrades = stageGradesFor(version);
  const stageOfGrade = new Map<number, BaseStage>();
  for (const stage of ['LAG', 'MELLAN', 'HOG'] as const) {
    for (const grade of stageGrades[stage]) stageOfGrade.set(grade, stage);
  }

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
  for (const entry of version.entries) {
    if (parentOf.get(entry.subjectCode)) continue;
    newCell(entry.subjectCode, entry.stage, entry.hours * HOUR, entry.protectedFromReduction);
  }
  for (const entry of version.entries) {
    const parent = parentOf.get(entry.subjectCode);
    if (!parent) continue;
    // A child line without its group's cell cannot be seeded (P0's self-check
    // 4c); were one to appear, it is held as an extra group cell's minimum.
    const cell =
      cells.get(cellKey(parent, entry.stage)) ?? newCell(parent, entry.stage, 0, false);
    cell.minima.set(entry.subjectCode, entry.hours * HOUR);
  }
  const hasMergedCell = new Set(
    version.entries.filter((e) => e.stage === 'LAG_MELLAN').map((e) => e.subjectCode),
  );

  const subjects = new Map(input.subjects.map((s) => [s.id, s]));
  const unmapped = new Map<string, { subject: CoverageSubject; planned: number }>();
  const outside = new Set<number>();
  // Stages in which a group's children are distinguished by the plan at all.
  const childMapped = new Set<string>();

  for (const entry of input.entries) {
    const subject = subjects.get(entry.subjectId);
    if (!subject || !subject.countsTowardTimplan || entry.minutesPerWeek <= 0) continue;
    const baseStage = stageOfGrade.get(entry.gradeLevel);
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
  const unmappedCountsAs: TimplanTimeCountsAs = poolPrinted
    ? 'skolansVal'
    : version.entries.some((e) => e.subjectCode === FREE_TIME_CODE)
      ? 'fordelningsbar'
      : 'own';
  const verdicts: TimplanVerdict[] = [];
  const sortedCells = [...cells.values()].sort(
    (a, b) =>
      byCode(a.subjectCode, b.subjectCode) || STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage],
  );

  if (!published) {
    verdicts.push({
      code: 'TIMPLAN_NATIONAL_DISTRIBUTION_UNPUBLISHED',
      severity: 'notice',
      params: { versionCode: version.code, totalHours: version.totalHours },
    });
  }

  const sortedUnmapped = [...unmapped.values()].sort(
    (a, b) => byName(a.subject.name, b.subject.name) || byCode(a.subject.id, b.subject.id),
  );
  for (const { subject, planned } of sortedUnmapped) {
    verdicts.push({
      code: 'TIMPLAN_SUBJECT_UNMAPPED',
      severity: 'notice',
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
  const cap = version.reductionCapPercent;

  const cellCoverage: CellCoverage[] = sortedCells.map((cell) => {
    const deficit = Math.max(0, cell.national - cell.planned);
    const surplus = Math.max(0, cell.planned - cell.national);
    taken += deficit;
    placed += surplus;
    plannedTotal += cell.planned;
    const subjectIds = [...cell.subjectIds].sort(byCode);
    const where = { subjectCode: cell.subjectCode, stage: cell.stage, subjectIds };

    // A cell that is short shows its planned figure rounded down, so planned
    // + deficit reads as the target (see "Display rounding").
    const plannedShown = deficit > 0 ? hoursDown(cell.planned) : hours(cell.planned);
    if (deficit > 0) {
      const figures = {
        nationalHours: cell.national / HOUR,
        plannedHours: plannedShown,
        deficitHours: hoursUp(deficit),
        reducedPercent: percentUp(deficit, cell.national),
      };
      if (cell.protectedFromReduction) {
        verdicts.push({ code: 'TIMPLAN_PROTECTED_SUBJECT_REDUCED', severity: 'warning', ...where, params: figures });
      } else if (cap !== null && deficit * 100 > cap * cell.national) {
        verdicts.push({
          code: 'TIMPLAN_REDUCTION_OVER_CAP',
          severity: 'warning',
          ...where,
          params: { ...figures, capPercent: cap },
        });
      } else {
        verdicts.push({
          code: 'TIMPLAN_STAGE_BELOW_NATIONAL',
          severity: 'notice',
          ...where,
          params: { ...figures, timeCountsAs: poolPrinted ? 'skolansVal' : 'none' },
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
          if (judged && childPlanned < minimum) {
            verdicts.push({
              code: 'TIMPLAN_GROUP_MINIMUM_UNMET',
              severity: 'warning',
              ...where,
              childCode,
              params: {
                childCode,
                minimumHours: minimum / HOUR,
                plannedHours: childShown,
                deficitHours: hoursUp(minimum - childPlanned),
              },
            });
          }
          return { subjectCode: childCode, minimumHours: minimum / HOUR, plannedHours: childShown };
        });
    }

    return {
      subjectCode: cell.subjectCode,
      stage: cell.stage,
      nationalHours: cell.national / HOUR,
      plannedHours: plannedShown,
      deficitHours: hoursUp(deficit),
      surplusHours: hours(surplus),
      reducedPercent: percentUp(deficit, cell.national),
      protectedFromReduction: cell.protectedFromReduction,
      ...(children ? { children } : {}),
      subjectIds,
    };
  });

  for (const { planned } of sortedUnmapped) {
    placed += planned;
    plannedTotal += planned;
  }

  const pool = version.skolansValHours;
  if (pool !== null && taken > pool * HOUR) {
    verdicts.push({
      code: 'TIMPLAN_SKOLANS_VAL_OVERSPENT',
      severity: 'warning',
      params: {
        takenHours: hoursUp(taken),
        availableHours: pool,
        overspentHours: hoursUp(taken - pool * HOUR),
      },
    });
  }

  const guaranteed = version.totalHours * HOUR;
  const totalShown = plannedTotal < guaranteed ? hoursDown(plannedTotal) : hours(plannedTotal);
  if (plannedTotal < guaranteed) {
    verdicts.push({
      code: 'TIMPLAN_TOTAL_BELOW_GUARANTEE',
      severity: 'warning',
      params: {
        plannedHours: totalShown,
        guaranteedHours: version.totalHours,
        deficitHours: hoursUp(guaranteed - plannedTotal),
      },
    });
  }

  verdicts.sort(
    (a, b) =>
      VERDICT_ORDER[a.code] - VERDICT_ORDER[b.code] ||
      (a.stage ? STAGE_ORDER[a.stage] : -1) - (b.stage ? STAGE_ORDER[b.stage] : -1) ||
      byCode(a.subjectCode ?? '', b.subjectCode ?? '') ||
      byCode(a.childCode ?? '', b.childCode ?? ''),
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
      guaranteedHours: version.totalHours,
      deficitHours: hoursUp(Math.max(0, guaranteed - plannedTotal)),
    },
    verdicts,
  };
}
