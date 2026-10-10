// Årskullar och lydelser, as the browser computes them.
//
// A MIRROR OF src/common/timplan-cohorts.ts, not a second opinion on it: which
// national timplan a pupil's stadium is judged against, how a year's årskurs
// is read across the 2028 reform, and the "Timplaner per årskull" notice.
// /admin/timplan paints that notice from this file without a request, and the
// Stadium tab on Täckning reads the same rows from the gateway — so the two
// must agree. Both copies replay src/common/__fixtures__/timplan-stage-cases.json
// (its cohortCases), asserted by timplan-stage.contract.spec.ts there and
// timplan-stage.contract.test.ts here. Fix the code on both sides at once and
// regenerate the fixture; never edit the JSON.
//
// A file of its own, and not a section of lib/timplan-stage.ts, for the
// bundle: /admin/timplan imports this and nothing of the stage module, because
// Turbopack keeps a module whole and the page has 9 KB of its 190 left.
//
// The sources the regimes, the version grade and the stage cuts rest on —
// SFS 2023:945 övergångsbestämmelse 3, SFS 2025:729 (utfärdad 2025-06-19, i
// kraft 2026-07-01, tillämpas efter 2028-06-30) övergångsbestämmelserna 4, 5
// and 12, SFS 2026:1243 (utfärdad 2026-06-18) and U2026/01483 (2026-08-20),
// all read on 2026-10-10 — are quoted in the gateway file's header and not
// repeated here. Every figure is the REFERENCE DATA's, never a statement of
// law. The body below is that file with the quotes this package's style uses;
// keep it that way, so a diff of the two shows only the header.

import { cohortYear, stageGradesFor, type BaseStage, type SchoolForm } from "@/lib/timplan-coverage";

export type Regime = "PRE_2028" | "REFORMED_2028";

/** The HT the tioårig grundskola is first applied in. */
export const REFORM_HT = 2028;

/** The term-year the cohort in årskurs g of a year starting HT `year` started åk 1. */
export function cohortStartYear(gradeLevel: number, year: number): number {
  return gradeLevel === 0 ? year + 1 : year - gradeLevel + 1;
}

/**
 * The HT a läsår starting on `date` (YYYY-MM-DD) belongs to: a year starting
 * from July on is that year's HT, one starting earlier the previous year's.
 */
export function htOf(date: string): number {
  const year = Number(date.slice(0, 4));
  return Number(date.slice(5, 7)) >= 7 ? year : year - 1;
}

/** A year a pupil is recorded in: its HT and the årskurs recorded there. */
export interface CohortYear {
  ht: number;
  gradeLevel: number | null;
}

/** PRE_2028 or REFORMED_2028, by the three rules of the header. */
export function pupilRegime(years: readonly CohortYear[]): Regime {
  if (years.some((year) => year.ht < REFORM_HT)) return "PRE_2028";
  const known = years.filter((year): year is { ht: number; gradeLevel: number } => year.gradeLevel !== null);
  const reformYear = known.filter((year) => year.ht === REFORM_HT);
  if (reformYear.length > 0) {
    return Math.min(...reformYear.map((year) => year.gradeLevel)) <= 1 ? "REFORMED_2028" : "PRE_2028";
  }
  if (known.length === 0) return "PRE_2028";
  const earliest = known.reduce((a, b) => (b.ht < a.ht ? b : a));
  return earliest.gradeLevel - (earliest.ht - REFORM_HT) <= 1 ? "REFORMED_2028" : "PRE_2028";
}

/**
 * The årskurs a pupil's lydelse speaks of, for an årskurs recorded in the year
 * starting HT `ht`; null for no grade at all (unknown, or förskoleklass after
 * it ended, or below it).
 */
export function versionGradeOf(regime: Regime, ht: number, gradeLevel: number | null): number | null {
  if (gradeLevel === null) return null;
  if (ht >= REFORM_HT && gradeLevel === 0) return null;
  const grade = regime === "PRE_2028" && ht >= REFORM_HT ? gradeLevel - 1 : gradeLevel;
  return grade < 0 ? null : grade;
}

/** Which version grades make each base stage, in the regime's numbering. */
export function stageCutOf(regime: Regime, schoolForm: SchoolForm): Record<BaseStage, number[]> {
  return stageGradesFor({ schoolForm, appliesFromCohortTerm: regime === "REFORMED_2028" ? `HT${REFORM_HT}` : "HT2024" });
}

/** The base stage a version grade belongs to, or null (förskoleklass, a grade the form lacks). */
export function baseStageOf(cut: Record<BaseStage, number[]>, versionGrade: number | null): BaseStage | null {
  if (versionGrade === null) return null;
  for (const stage of ["LAG", "MELLAN", "HOG"] as const) {
    if (cut[stage].includes(versionGrade)) return stage;
  }
  return null;
}

/** What stageVersionFor needs of a version. */
export interface CohortVersion {
  code: string;
  schoolForm: SchoolForm;
  appliesFromCohortTerm: string;
  appliesBy: "STAGES_NOT_COMPLETED" | "COHORTS_STARTING";
}

/**
 * The version a stage is judged against, or null when the reference data has
 * none (see "Which version, per stage"). `cohortStartHT` is the term-year the
 * pupil began åk 1 in their regime's numbering; `stageEndHT` the HT of the year
 * the stage's last grade is (or will be) sat in.
 */
export function stageVersionFor<V extends CohortVersion>(
  versions: readonly V[],
  schoolForm: SchoolForm,
  regime: Regime,
  cohortStartHT: number | null,
  stageEndHT: number | null,
): V | null {
  const applying = versions.filter((version) => {
    if (version.schoolForm !== schoolForm) return false;
    const from = cohortYear(version.appliesFromCohortTerm);
    if (regime === "REFORMED_2028") {
      return version.appliesBy === "COHORTS_STARTING" && cohortStartHT !== null && from <= cohortStartHT;
    }
    return version.appliesBy === "STAGES_NOT_COMPLETED" && stageEndHT !== null && stageEndHT >= from;
  });
  if (applying.length === 0) return null;
  return applying.reduce((a, b) =>
    cohortYear(b.appliesFromCohortTerm) > cohortYear(a.appliesFromCohortTerm) ||
    (cohortYear(b.appliesFromCohortTerm) === cohortYear(a.appliesFromCohortTerm) && b.code > a.code)
      ? b
      : a,
  );
}

/** Whether a PRE_2028 stage reads SFS 2023:945's cells for a year from HT 2028 (an assumption). */
export function stageAssumesOldDistribution(regime: Regime, yearHTs: readonly number[]): boolean {
  return regime === "PRE_2028" && yearHTs.some((ht) => ht >= REFORM_HT);
}

/** A class the cohort notice lists. */
export interface CohortClass {
  id: string;
  name: string;
  gradeLevel: number | null;
  /** The HT of the class's läsår. */
  ht: number;
}

export interface CohortNoticeStage {
  stage: BaseStage;
  versionCode: string | null;
  /** The version has cells; false is "fördelning ej publicerad". */
  distributionPublished: boolean;
  /** A PRE_2028 stage read against SFS 2023:945's cells for a year from HT 2028. */
  assumed: boolean;
}

export interface CohortNoticeRow {
  /** The HT the cohort began åk 1 (in its own numbering). */
  cohortStartHT: number;
  regime: Regime;
  classIds: string[];
  classNames: string[];
  stages: CohortNoticeStage[];
}

/**
 * "Timplaner per årskull": per cohort of the classes given (the active year's,
 * and its rolled successor's), and for the first reformed cohort (HT 2028)
 * whether or not a class holds it yet, which version each of its stages is
 * judged against. A class is read as a pupil recorded in that one year would
 * be. Classes without an årskurs are left out.
 */
export function cohortNotice<V extends CohortVersion & { entryCount: number }>(
  classes: readonly CohortClass[],
  versions: readonly V[],
  schoolForm: SchoolForm,
): CohortNoticeRow[] {
  const rows = new Map<string, CohortNoticeRow & { yearHTs: Set<number>; latest: { ht: number; grade: number } }>();
  const add = (cohortStartHT: number, regime: Regime, latest: { ht: number; grade: number }, cls: CohortClass | null) => {
    const key = `${regime}:${cohortStartHT}`;
    let row = rows.get(key);
    if (!row) {
      row = { cohortStartHT, regime, classIds: [], classNames: [], stages: [], yearHTs: new Set(), latest };
      rows.set(key, row);
    }
    if (cls) {
      row.classIds.push(cls.id);
      row.classNames.push(cls.name);
      row.yearHTs.add(cls.ht);
    }
    if (latest.ht > row.latest.ht) row.latest = latest;
  };
  for (const cls of classes) {
    if (cls.gradeLevel === null) continue;
    const regime = pupilRegime([{ ht: cls.ht, gradeLevel: cls.gradeLevel }]);
    // Förskoleklass counts (before 2028 it is a cohort about to start åk 1 —
    // 2027/28's starts directly in åk 2); a class with no årskurs does not.
    const grade = versionGradeOf(regime, cls.ht, cls.gradeLevel);
    if (grade === null) continue;
    add(cohortStartYear(grade, cls.ht), regime, { ht: cls.ht, grade }, cls);
  }
  // The first reformed cohort, always: it is what the notice is for.
  add(REFORM_HT, "REFORMED_2028", { ht: REFORM_HT, grade: 1 }, null);

  const out: CohortNoticeRow[] = [];
  for (const row of rows.values()) {
    const cut = stageCutOf(row.regime, schoolForm);
    const stages: CohortNoticeStage[] = [];
    for (const stage of ["LAG", "MELLAN", "HOG"] as const) {
      const grades = cut[stage];
      if (grades.length === 0) continue;
      const last = grades[grades.length - 1]!;
      const stageEndHT = row.latest.ht + (last - row.latest.grade);
      const version = stageVersionFor(versions, schoolForm, row.regime, row.cohortStartHT, stageEndHT);
      const yearHTs = grades.map((grade) => row.latest.ht + (grade - row.latest.grade));
      stages.push({
        stage,
        versionCode: version?.code ?? null,
        distributionPublished: (version?.entryCount ?? 0) > 0,
        assumed: version !== null && stageAssumesOldDistribution(row.regime, yearHTs),
      });
    }
    const order = row.classNames.map((name, index) => ({ name, id: row.classIds[index]! }));
    order.sort((a, b) => a.name.localeCompare(b.name, "sv") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out.push({
      cohortStartHT: row.cohortStartHT,
      regime: row.regime,
      classIds: order.map((entry) => entry.id),
      classNames: order.map((entry) => entry.name),
      stages,
    });
  }
  return out.sort((a, b) => a.cohortStartHT - b.cohortStartHT || (a.regime < b.regime ? -1 : a.regime > b.regime ? 1 : 0));
}
