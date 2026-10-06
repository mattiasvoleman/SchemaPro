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
// every verdict a warning — is argued in the gateway file's header and not
// repeated here. The body below is that
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

export interface CoverageInput {
  /** planningWeeks × 10, an integer: 356 for 35.6. See planningWeeksInTenths. */
  planningWeeksTenths: number;
  version: CoverageVersion;
  nationalSubjects: CoverageNationalSubject[];
  subjects: CoverageSubject[];
  entries: CoverageEntry[];
}

export type TimplanVerdictCode =
  | "TIMPLAN_NATIONAL_DISTRIBUTION_UNPUBLISHED"
  | "TIMPLAN_SUBJECT_UNMAPPED"
  | "TIMPLAN_PROTECTED_SUBJECT_REDUCED"
  | "TIMPLAN_REDUCTION_OVER_CAP"
  | "TIMPLAN_GROUP_MINIMUM_UNMET"
  | "TIMPLAN_STAGE_BELOW_NATIONAL"
  | "TIMPLAN_SKOLANS_VAL_OVERSPENT"
  | "TIMPLAN_TOTAL_BELOW_GUARANTEE";

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

/** The lydelse's first cohort year: 'HT2024' → 2024. */
function cohortYear(term: string): number {
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
  version: Pick<CoverageVersion, "schoolForm" | "appliesFromCohortTerm">,
): Record<BaseStage, number[]> {
  const reformed = cohortYear(version.appliesFromCohortTerm) >= 2028;
  switch (version.schoolForm) {
    case "SPECIALSKOLA":
      return { LAG: range(1, 4), MELLAN: range(5, 7), HOG: range(8, 10) };
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
  subjectIds: Set<string>;
}

const cellKey = (code: string, stage: TimplanStage): string => `${code}:${stage}`;

export function checkLocalTimplan(input: CoverageInput): TimplanCheck {
  const { version } = input;
  const weeks = input.planningWeeksTenths;
  if (!Number.isSafeInteger(weeks) || weeks <= 0) {
    throw new Error(`planningWeeksTenths ${weeks} is not a positive integer`);
  }

  const stageGrades = stageGradesFor(version);
  const stageOfGrade = new Map<number, BaseStage>();
  for (const stage of ["LAG", "MELLAN", "HOG"] as const) {
    for (const grade of stageGrades[stage]) stageOfGrade.set(grade, stage);
  }

  const parentOf = new Map(input.nationalSubjects.map((s) => [s.code, s.parentCode]));
  const topOf = (code: string): string => parentOf.get(code) ?? code;

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
    const top = topOf(code);
    const stage: TimplanStage =
      baseStage !== "HOG" && hasMergedCell.has(top) ? "LAG_MELLAN" : baseStage;
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
          if (judged && childPlanned < minimum) {
            verdicts.push({
              code: "TIMPLAN_GROUP_MINIMUM_UNMET",
              severity: "warning",
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
      code: "TIMPLAN_SKOLANS_VAL_OVERSPENT",
      severity: "warning",
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
      code: "TIMPLAN_TOTAL_BELOW_GUARANTEE",
      severity: "warning",
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
      guaranteedHours: version.totalHours,
      deficitHours: hoursUp(Math.max(0, guaranteed - plannedTotal)),
    },
    verdicts,
  };
}
