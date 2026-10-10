import { cohortYear, stageGradesFor, type BaseStage, type SchoolForm } from './timplan-coverage';

/*
 * Årskullar och lydelser: which national timplan a pupil's stadium is judged
 * against, and how a year's årskurs is read across the 2028 reform.
 *
 * PURE. No Prisma, no clock, no school. src/timplan/timplan-stage.service.ts
 * and the stage module (timplan-stage.ts) use it, and web/lib/timplan-cohorts.ts
 * mirrors it body for body for /admin/timplan's notice, which must not pull the
 * whole stage module into that route's bundle (Turbopack keeps a module whole).
 * Both replay the stage fixture (src/common/__fixtures__/timplan-stage-cases.json).
 *
 * ## The sources, and what each says (read 2026-10-10)
 *
 *   * SFS 2023:945 (skolförordningen bilaga 1, 3, 4; utfärdad 2023-12-21, i
 *     kraft 2024-07-01), övergångsbestämmelse 3: "För stadier som en elev har
 *     avslutat före ikraftträdandet gäller bilaga 1, 3 och 4 i den äldre
 *     lydelsen." It applies BY STAGE (appliesBy STAGES_NOT_COMPLETED).
 *   * SFS 2025:729 (skollagen, the tioårig grundskola; utfärdad 2025-06-19, i
 *     kraft 2026-07-01, tillämpas på utbildning efter 2028-06-30), with
 *     10 kap. 3 § (lågstadiet åk 1–4, mellanstadiet 5–7, högstadiet 8–10) and
 *     10 kap. 5 § (7 424 h). Övergångsbestämmelse 4: a pupil in förskoleklass
 *     2027/28 begins directly in åk 2, and one who in HT 2028 would have begun
 *     åk 2 or higher begins one årskurs higher ("Detta gäller dock inte om
 *     annat beslutas" — individual exceptions are not modelled).
 *     Övergångsbestämmelse 12: those pupils keep 10 kap. 5 § första stycket in
 *     the older lydelse — the 6 890 h TOTAL. It applies BY COHORT
 *     (COHORTS_STARTING). The law says nothing of the older cohorts'
 *     distribution per subject after 2028.
 *   * SFS 2026:1243 (skollagen; utfärdad 2026-06-18, i kraft 2028-07-02)
 *     makes timplaner part of the läroplaner (1 kap. 11 §), behind prop.
 *     2025/26:194 (rskr. 2025/26:327); the distribution will come in a
 *     läroplan förordning. Skolverket's proposals are due 14 May 2027
 *     (U2026/01483, 2026-08-20). Nothing is published as of 2026-10-10.
 *
 * Every figure the module produces is the REFERENCE DATA's ("referensdata:
 * SFS …"), never a statement of law.
 *
 * ## The regime: before or after the reform
 *
 * PRE_2028 | REFORMED_2028, decided in this order (the order matters):
 *
 *   1. any year the pupil is recorded in that starts before HT 2028 gives
 *      PRE_2028: everyone in school before HT 2028, förskoleklass included,
 *      falls under övergångsbestämmelserna 4 and 12;
 *   2. otherwise the årskurs recorded in the year starting HT 2028: 1 or
 *      lower is REFORMED_2028 (the first cohort of the new åk 1);
 *   3. otherwise the earliest recorded year, by arithmetic: årskurs − (HT −
 *      2028) ≤ 1 is REFORMED_2028.
 *
 * A single formula would turn an old-cohort pupil who repeats new åk 2 in
 * 2029/30 into REFORMED (2 − 1 = 1); rule 1 keeps them PRE.
 *
 * ## The version grade
 *
 * Years starting HT 2028 or later are read in the NEW numbering (as the
 * rollover will write them once its 2028 step ships; until then the rollover
 * preview warns, ROLLOVER_2028_RENUMBERING). A PRE_2028 pupil there sits one
 * årskurs above the numbering their lydelse uses, so their version grade is
 * årskurs − 1; everybody else's is the årskurs. Stage membership and the plan
 * row a future grade reads are both judged on the version grade. Årskurs 0 in
 * a year from HT 2028 is no grade at all: förskoleklassen ends
 * (övergångsbestämmelse 5) — the caller says so and puts it in no stage.
 *
 * ## The stage cut
 *
 * The regime's numbering: PRE_2028 reads the lydelser of today (1–3 / 4–6 /
 * 7–9; specialskolan 1–4 / 5–7 / 8–10; sameskolan 1–3 / 4–6), REFORMED_2028
 * the tioårig cut stageGradesFor gives a lydelse from HT 2028 (1–4 / 5–7 /
 * 8–10; sameskolan 1–4 / 5–7). Specialskolan's 2028 cut is 1–5 / 6–8 / 9–11
 * (SFS 2025:729 12 kap. 3 §); its 8 604 h version is not seeded because
 * årskurs 11 does not fit the tables' 0..10, so a reformed specialskola pupil
 * reads VERSION_NOT_IN_REFERENCE until it is.
 *
 * ## Which version, per stage
 *
 * stageVersionFor filters by REGIME first, then by the version's own rule:
 *
 *   * REFORMED_2028: the COHORTS_STARTING versions of the form whose
 *     appliesFromCohortTerm is not after the term the pupil began åk 1 — the
 *     latest of them. (A PRE_2028 pupil at version grade 1 in 2028/29 has
 *     cohortStartYear 2028 too, the same as SFS 2025:729's HT2028; selecting
 *     by cohort alone would hand them the new version.)
 *   * PRE_2028: the STAGES_NOT_COMPLETED versions whose lydelse was in force
 *     before the stage ended: the stage's last grade is sat in the year
 *     starting HT X and ends in June X + 1, and a lydelse applying from HT Y
 *     came into force on 1 July Y, so it applies iff X ≥ Y — the latest of
 *     them. None (a stage finished before 1 July 2024) is the older bilaga,
 *     not in the reference data: null, and the caller says so.
 *
 * A PRE_2028 stage with a year from HT 2028 is still read against SFS
 * 2023:945's cells. That is an assumption of the reference data, not law
 * (övergångsbestämmelse 12 keeps the total only), and stageAssumesOldDistribution
 * says when the caller must say so.
 */

export type Regime = 'PRE_2028' | 'REFORMED_2028';

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
  if (years.some((year) => year.ht < REFORM_HT)) return 'PRE_2028';
  const known = years.filter((year): year is { ht: number; gradeLevel: number } => year.gradeLevel !== null);
  const reformYear = known.filter((year) => year.ht === REFORM_HT);
  if (reformYear.length > 0) {
    return Math.min(...reformYear.map((year) => year.gradeLevel)) <= 1 ? 'REFORMED_2028' : 'PRE_2028';
  }
  if (known.length === 0) return 'PRE_2028';
  const earliest = known.reduce((a, b) => (b.ht < a.ht ? b : a));
  return earliest.gradeLevel - (earliest.ht - REFORM_HT) <= 1 ? 'REFORMED_2028' : 'PRE_2028';
}

/**
 * The årskurs a pupil's lydelse speaks of, for an årskurs recorded in the year
 * starting HT `ht`; null for no grade at all (unknown, or förskoleklass after
 * it ended, or below it).
 */
export function versionGradeOf(regime: Regime, ht: number, gradeLevel: number | null): number | null {
  if (gradeLevel === null) return null;
  if (ht >= REFORM_HT && gradeLevel === 0) return null;
  const grade = regime === 'PRE_2028' && ht >= REFORM_HT ? gradeLevel - 1 : gradeLevel;
  return grade < 0 ? null : grade;
}

/** Which version grades make each base stage, in the regime's numbering. */
export function stageCutOf(regime: Regime, schoolForm: SchoolForm): Record<BaseStage, number[]> {
  return stageGradesFor({ schoolForm, appliesFromCohortTerm: regime === 'REFORMED_2028' ? `HT${REFORM_HT}` : 'HT2024' });
}

/** The base stage a version grade belongs to, or null (förskoleklass, a grade the form lacks). */
export function baseStageOf(cut: Record<BaseStage, number[]>, versionGrade: number | null): BaseStage | null {
  if (versionGrade === null) return null;
  for (const stage of ['LAG', 'MELLAN', 'HOG'] as const) {
    if (cut[stage].includes(versionGrade)) return stage;
  }
  return null;
}

/** What stageVersionFor needs of a version. */
export interface CohortVersion {
  code: string;
  schoolForm: SchoolForm;
  appliesFromCohortTerm: string;
  appliesBy: 'STAGES_NOT_COMPLETED' | 'COHORTS_STARTING';
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
    if (regime === 'REFORMED_2028') {
      return version.appliesBy === 'COHORTS_STARTING' && cohortStartHT !== null && from <= cohortStartHT;
    }
    return version.appliesBy === 'STAGES_NOT_COMPLETED' && stageEndHT !== null && stageEndHT >= from;
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
  return regime === 'PRE_2028' && yearHTs.some((ht) => ht >= REFORM_HT);
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
  add(REFORM_HT, 'REFORMED_2028', { ht: REFORM_HT, grade: 1 }, null);

  const out: CohortNoticeRow[] = [];
  for (const row of rows.values()) {
    const cut = stageCutOf(row.regime, schoolForm);
    const stages: CohortNoticeStage[] = [];
    for (const stage of ['LAG', 'MELLAN', 'HOG'] as const) {
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
    order.sort((a, b) => a.name.localeCompare(b.name, 'sv') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
