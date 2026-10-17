import type { GradeNumbering, LocalTimplanStatus } from '@prisma/client';
import { cohortYear } from '../common/timplan-coverage';
import { cohortStartYear, planFitsCohort, pupilRegime, versionGradeOf } from '../common/timplan-cohorts';
import { gradeOfPlanRow, lydelseIsTioarig } from '../common/grade-numbering';
import { speaksFor } from '../timplan/year-timplans';

/**
 * Timplan per årskurs (AcademicYearTimplans, timplan P2) carried into the new
 * läsår BY COHORT: next year's årskurs g follows the plan this year's årskurs
 * g−1 follows, when a class of this year's årskurs g−1 moves up into g.
 *
 * WHY BY COHORT. The statute versions timplaner by the term a cohort started,
 * not by calendar year: SFS 2023:945 applies to utbildning som påbörjas HT
 * 2024, so a school in 2026/27 runs åk 1–3 on the new bilaga and åk 4–9 on
 * the old one, and in 2027/28 the line has moved one grade up. Copying the
 * table grade for grade would put next year's åk 4 back on the old bilaga it
 * never started under; carrying it by cohort is the line moving with the
 * pupils, which is what the admin would otherwise retype every spring.
 *
 * A COHORT IS A CLASS THAT MOVES UP, not an attachment row. P2's
 * AcademicYearsService.create attaches every grade the newest decided plan's
 * version maps (1–9, and F when the plan plans F), whatever classes the school
 * has, so a 7–9 school's year carries rows for F–6 that no pupils stand
 * behind. Reading a cohort off those rows would carry "åk 6's" plan into a
 * new åk 7 that is in fact an intake. The rollover already knows which
 * classes move (resolveGroups: a CLASS at g−1 whose successor is at g), and
 * only those carry a plan.
 *
 * THE RULE, per grade g of the new year:
 *   - CARRIED: the source year attaches a plan to g−1, g−1 < G, and a class
 *     moves from g−1 to g. The plan is kept whatever its status: a DRAFT
 *     carried along stays attached, and the preview says it is a draft.
 *   - DEFAULT: no cohort carries a plan into g — the school's entry grade (F
 *     or åk 1 in an F–9 school, åk 7 in a 7–9 school), or a grade with no
 *     class below it. g takes a DECIDED plan that speaks for g and is of the
 *     school form the source year's plan for g is: the newest decided one of
 *     the lydelse that applies to the cohort entering g (WHICH LYDELSE).
 *   - KEPT: as DEFAULT, but no decided plan of that form speaks for g (the
 *     newest plan plans no förskoleklass, say). g keeps the plan the source
 *     year attaches to it, rather than losing its row every summer.
 * Such a grade always has a source row of its own (see WHICH GRADES), so
 * there is no third outcome: every grade of the new year gets a plan.
 *
 * WHICH LYDELSE. The reason for carrying by cohort holds for the entering
 * cohort too: it follows the lydelse in force for the term it started åk 1,
 * HT(Y − g + 1) for a new year starting HT Y (förskoleklass: HT(Y + 1), the
 * term it starts åk 1). Of the lydelser the school has decided plans for,
 * the latest whose appliesFromCohortTerm is not after that term applies; a
 * plan on a later lydelse is skipped, and the preview names it (laterPlan).
 * A school that decides its HT2028 (tioårig) plan in the spring of 2027
 * does not put next year's åk 1, who start HT2027, on it. When no decided
 * lydelse is that old — the reference data has no bilaga before SFS
 * 2023:945, so a 7–9 school's intake that started åk 1 before HT2024 has
 * none — the earliest one the school has stands in for it: the closest to
 * the cohort's own, and never a later one when an earlier exists.
 *
 * WHICH REGIME FIRST (SFS 2025:729). From HT 2028 two kinds of årskull share
 * a school: the reformed, from the new åk 1 up, whose lydelse is one from HT
 * 2028; and every older one, last year's förskoleklass included, which keeps
 * the older total (övergångsbestämmelse 12) and an older lydelse. A grade's
 * årskull is read as a pupil recorded in that one year (planFitsCohort), and
 * only plans it fits are candidates: 2A of 2028/29 (last year's F) is never
 * put on a 2028 plan by its start year alone, and the new åk 1 never on an
 * older one. A grade no decided plan fits keeps its own source row's plan
 * when that one fits, and otherwise gets no row — the preview names it
 * (unattached) rather than attach the wrong bilaga.
 *
 * WHICH GRADES. Those the source year attaches — each in the new year's
 * numbering, so a crossing into the tioårig numbering reads a source row g as
 * the new year's g + 1, the same årskull's age — and those a cohort carries a
 * plan into (s → t, the step its classes take: one årskurs, or two across the
 * reform), and any the planner names (the new åk 1 at the crossing). A 7–9 school that removed åk 1–6 from its year does not get them
 * back every summer; one that kept P2's rows keeps them, each on its default
 * as a new year would have them. A source grade at or above G graduates and
 * contributes nothing; a grade above 11 does not exist in the table (its
 * CHECK, 0..11).
 *
 * A SOURCE YEAR WITH NO ROWS AT ALL (a year from before P2, which the
 * migration did not backfill, or one whose rows were all cleared) says
 * nothing about which grades the school has, so the new year gets exactly
 * what P2's AcademicYearsService.create would have given it: the newest
 * decided plan for every grade it speaks for.
 *
 * NEVER A MIX. The new year is created by the rollover's own year step, not
 * by AcademicYearsService.create, so P2's defaults are never written for it;
 * these rows are the year's whole mapping, written in the rollover's
 * transaction (rollover-apply.ts), which refuses to add them to a year that
 * already has any.
 */

export interface SourceTimplanRow {
  gradeLevel: number;
  localTimplanId: string;
  planName: string;
  planStatus: LocalTimplanStatus;
  /** The attached plan's school form. */
  planSchoolForm: string;
  /** Its lydelse's first cohort term ('HT2024'); absent: it fits any årskull, as before the reform. */
  planAppliesFrom?: string;
}

/** A DECIDED plan the new year may default to (readDecidedTimplans). */
export interface DecidedTimplanChoice {
  id: string;
  name: string;
  status: LocalTimplanStatus;
  schoolForm: string;
  appliesFromCohortTerm: string;
  gradeLevels: readonly number[];
}

export type TimplanCarryReason = 'CARRIED' | 'DEFAULT' | 'KEPT';

export interface PlannedTimplan {
  gradeLevel: number;
  reason: TimplanCarryReason;
  /** CARRIED: the source grade whose plan this is (gradeLevel − 1). */
  fromGradeLevel: number | null;
  localTimplanId: string;
  planName: string;
  planStatus: LocalTimplanStatus;
  /**
   * DEFAULT: a more recently decided plan for the grade that was skipped
   * because its lydelse applies only to cohorts starting later; null
   * otherwise.
   */
  laterPlan: { name: string; appliesFromCohortTerm: string } | null;
}

export interface CohortTimplanInput {
  /** The source year's rows. */
  source: readonly SourceTimplanRow[];
  graduatingGradeLevel: number;
  /**
   * The grades a class moves up between (resolveGroups): source grade → the
   * new year's grade, g → g + 1, or g → g + 2 across the reform. A set names
   * source grades that move one årskurs up.
   */
  movingCohorts: ReadonlySet<number> | ReadonlyMap<number, number>;
  /** The school's decided plans, newest first (readDecidedTimplans). */
  decided: readonly DecidedTimplanChoice[];
  /** The calendar year the new läsår starts (its HT): 2027 for 2027/28. */
  targetStartYear: number;
  /** The two years' numbering (AcademicYears.gradeNumbering); absent NIOARIG. */
  sourceNumbering?: GradeNumbering;
  targetNumbering?: GradeNumbering;
  /** Grades of the new year that get a row besides the source's and the carried (the new åk 1). */
  alsoGrades?: readonly number[];
}

/** A grade of the new year the rollover leaves without a plan: no decided plan fits its årskull. */
export interface UnattachedTimplan {
  gradeLevel: number;
}

/**
 * The term-year the cohort in årskurs g of a year starting HT `year` started
 * åk 1. Moved to src/common/timplan-cohorts.ts (timplan P4), where the stage
 * module and its web mirror read it too; re-exported so this import holds.
 */
export { cohortStartYear } from '../common/timplan-cohorts';

/**
 * Of the plans (newest decided first), the newest decided one of the latest
 * lydelse that applies to a cohort starting åk 1 in `startYear`, or of the
 * earliest lydelse when none does. See WHICH LYDELSE; the candidates are
 * already the ones the årskull fits (WHICH REGIME FIRST).
 */
function forCohort(
  candidates: readonly DecidedTimplanChoice[],
  startYear: number,
): DecidedTimplanChoice | undefined {
  const years = candidates.map((plan) => cohortYear(plan.appliesFromCohortTerm));
  const applying = years.filter((year) => year <= startYear);
  const lydelse = applying.length > 0 ? Math.max(...applying) : Math.min(...years);
  return candidates.find((_, index) => years[index] === lydelse);
}

/** The table's CHECK: 0 = förskoleklass … 11 (specialskolan from 2028). */
const MAX_GRADE = 11;

/** The rows of the new year, and the grades left without one. */
export function planCohortTimplans(input: CohortTimplanInput): PlannedTimplan[] {
  return cohortTimplans(input).rows;
}

/**
 * The term-year the årskull in grade `gradeLevel` of a year starting HT `ht`
 * began åk 1, in its own numbering (an older årskull in a year from HT 2028
 * sits one above its lydelse's number); null for no årskurs.
 */
function cohortStartOf(ht: number, gradeLevel: number): number | null {
  const regime = pupilRegime([{ ht, gradeLevel }]);
  const grade = versionGradeOf(regime, ht, gradeLevel);
  return grade === null ? null : cohortStartYear(grade, ht);
}

export function cohortTimplans(input: CohortTimplanInput): { rows: PlannedTimplan[]; unattached: UnattachedTimplan[] } {
  const { source, graduatingGradeLevel, decided, targetStartYear } = input;
  const targetNumbering = input.targetNumbering ?? 'NIOARIG';
  // A source row's own grade in the new year: the same årskull's age.
  const renumber = (grade: number) => grade + (input.sourceNumbering !== 'TIOARIG' && targetNumbering === 'TIOARIG' ? 1 : 0);
  const moves: ReadonlyMap<number, number> =
    input.movingCohorts instanceof Map
      ? input.movingCohorts
      : new Map([...(input.movingCohorts as ReadonlySet<number>)].map((grade) => [grade, grade + 1]));
  const planned = (
    gradeLevel: number,
    reason: TimplanCarryReason,
    plan: { id: string; name: string; status: LocalTimplanStatus },
    fromGradeLevel: number | null = null,
    laterPlan: PlannedTimplan['laterPlan'] = null,
  ): PlannedTimplan => ({
    gradeLevel,
    reason,
    fromGradeLevel,
    localTimplanId: plan.id,
    planName: plan.name,
    planStatus: plan.status,
    laterPlan,
  });
  const rows: PlannedTimplan[] = [];
  const unattached: UnattachedTimplan[] = [];

  /** DEFAULT for a grade of the form's decided plans the årskull fits, else KEPT `own`, else none. */
  const byDefault = (gradeLevel: number, form: string, own: SourceTimplanRow | undefined) => {
    const candidates = decided.filter((plan) => plan.schoolForm === form && speaksFor(plan, targetNumbering, gradeLevel));
    const fitting = candidates.filter((plan) => planFitsCohort(plan.appliesFromCohortTerm, targetStartYear, gradeLevel));
    const start = cohortStartOf(targetStartYear, gradeLevel);
    const chosen = start === null || fitting.length === 0 ? undefined : forCohort(fitting, start);
    if (!chosen) {
      if (own && (own.planAppliesFrom === undefined || planFitsCohort(own.planAppliesFrom, targetStartYear, gradeLevel))) {
        rows.push(planned(gradeLevel, 'KEPT', { id: own.localTimplanId, name: own.planName, status: own.planStatus }));
      } else {
        unattached.push({ gradeLevel });
      }
      return;
    }
    const newest = candidates[0]!;
    const skipped =
      newest !== chosen && cohortYear(newest.appliesFromCohortTerm) > cohortYear(chosen.appliesFromCohortTerm)
        ? { name: newest.name, appliesFromCohortTerm: newest.appliesFromCohortTerm }
        : null;
    rows.push(planned(gradeLevel, 'DEFAULT', chosen, null, skipped));
  };

  if (source.length === 0) {
    const newest = decided[0];
    if (!newest) return { rows, unattached };
    const grades = newest.gradeLevels
      .map((row) => (input.targetNumbering === undefined ? row : gradeOfPlanRowFor(newest, targetNumbering, row)))
      .filter((grade): grade is number => grade !== null && grade <= MAX_GRADE);
    for (const gradeLevel of [...new Set([...grades, ...(input.alsoGrades ?? [])])].sort((a, b) => a - b)) {
      byDefault(gradeLevel, newest.schoolForm, undefined);
    }
    return { rows, unattached };
  }

  const byGrade = new Map(source.map((row) => [row.gradeLevel, row]));
  const ownOf = new Map(source.map((row) => [renumber(row.gradeLevel), row]));
  const carriedInto = new Map<number, SourceTimplanRow>();
  for (const [from, to] of moves) {
    const row = byGrade.get(from);
    if (row && from < graduatingGradeLevel && to <= MAX_GRADE) carriedInto.set(to, row);
  }
  const grades = new Set<number>([...ownOf.keys(), ...carriedInto.keys(), ...(input.alsoGrades ?? [])]);
  const lowestForm = [...source].sort((a, b) => a.gradeLevel - b.gradeLevel)[0]!.planSchoolForm;
  for (const gradeLevel of [...grades].filter((grade) => grade <= MAX_GRADE).sort((a, b) => a - b)) {
    const below = carriedInto.get(gradeLevel);
    if (below) {
      rows.push(
        planned(gradeLevel, 'CARRIED', { id: below.localTimplanId, name: below.planName, status: below.planStatus }, below.gradeLevel),
      );
      continue;
    }
    const own = ownOf.get(gradeLevel);
    byDefault(gradeLevel, own?.planSchoolForm ?? lowestForm, own);
  }
  return { rows, unattached };
}

/** The new year's grade reading row `row` of a decided plan. */
function gradeOfPlanRowFor(plan: DecidedTimplanChoice, numbering: GradeNumbering, row: number): number | null {
  return gradeOfPlanRow(lydelseIsTioarig(plan.appliesFromCohortTerm), numbering, row);
}
