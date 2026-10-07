import type { LocalTimplanStatus } from '@prisma/client';

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
 *     class below it. g takes the newest DECIDED plan that speaks for g and
 *     is of the school form the source year's plan for g is.
 *   - KEPT: as DEFAULT, but no decided plan of that form speaks for g (the
 *     newest plan plans no förskoleklass, say). g keeps the plan the source
 *     year attaches to it, rather than losing its row every summer.
 * Such a grade always has a source row of its own (see WHICH GRADES), so
 * there is no third outcome: every grade of the new year gets a plan.
 *
 * WHICH GRADES. Those the source year attaches, and those a cohort carries a
 * plan into. A 7–9 school that removed åk 1–6 from its year does not get them
 * back every summer; one that kept P2's rows keeps them, each on its default
 * as a new year would have them. A source grade at or above G graduates and
 * contributes nothing; a grade above 10 does not exist in the table (its
 * CHECK, 0..10).
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
}

export interface CohortTimplanInput {
  /** The source year's rows. */
  source: readonly SourceTimplanRow[];
  graduatingGradeLevel: number;
  /** Source grades g−1 a class moves up from, into g (resolveGroups). */
  movingCohorts: ReadonlySet<number>;
  /** The school's decided plans, newest first (readDecidedTimplans). */
  decided: readonly DecidedTimplanChoice[];
}

/** The table's CHECK: 0 = förskoleklass … 10. */
const MAX_GRADE = 10;

export function planCohortTimplans(input: CohortTimplanInput): PlannedTimplan[] {
  const { source, graduatingGradeLevel, movingCohorts, decided } = input;
  const planned = (
    gradeLevel: number,
    reason: TimplanCarryReason,
    plan: { id: string; name: string; status: LocalTimplanStatus },
    fromGradeLevel: number | null = null,
  ): PlannedTimplan => ({
    gradeLevel,
    reason,
    fromGradeLevel,
    localTimplanId: plan.id,
    planName: plan.name,
    planStatus: plan.status,
  });

  if (source.length === 0) {
    const newest = decided[0];
    return newest ? newest.gradeLevels.map((gradeLevel) => planned(gradeLevel, 'DEFAULT', newest)) : [];
  }

  const byGrade = new Map(source.map((row) => [row.gradeLevel, row]));
  const carries = (gradeLevel: number) =>
    gradeLevel < graduatingGradeLevel && movingCohorts.has(gradeLevel) && byGrade.has(gradeLevel);
  const grades = new Set<number>();
  for (const row of source) {
    grades.add(row.gradeLevel);
    if (carries(row.gradeLevel) && row.gradeLevel + 1 <= MAX_GRADE) grades.add(row.gradeLevel + 1);
  }
  const out: PlannedTimplan[] = [];
  for (const gradeLevel of [...grades].sort((a, b) => a - b)) {
    if (carries(gradeLevel - 1)) {
      const below = byGrade.get(gradeLevel - 1)!;
      out.push(
        planned(gradeLevel, 'CARRIED', { id: below.localTimplanId, name: below.planName, status: below.planStatus }, below.gradeLevel),
      );
      continue;
    }
    // Not carried, so the grade is in the set by its own source row.
    const own = byGrade.get(gradeLevel)!;
    const fallback = decided.find(
      (plan) => plan.gradeLevels.includes(gradeLevel) && plan.schoolForm === own.planSchoolForm,
    );
    out.push(
      fallback
        ? planned(gradeLevel, 'DEFAULT', fallback)
        : planned(gradeLevel, 'KEPT', { id: own.localTimplanId, name: own.planName, status: own.planStatus }),
    );
  }
  return out;
}
