import type { LocalTimplanStatus } from '@prisma/client';

/**
 * Timplan per årskurs (AcademicYearTimplans, timplan P2) carried into the new
 * läsår BY COHORT: next year's årskurs g follows the plan this year's årskurs
 * g−1 follows.
 *
 * WHY BY COHORT. The statute versions timplaner by the term a cohort started,
 * not by calendar year: SFS 2023:945 applies to utbildning som påbörjas HT
 * 2024, so a school in 2026/27 runs åk 1–3 on the new bilaga and åk 4–9 on
 * the old one, and in 2027/28 the line has moved one grade up. Copying the
 * table grade for grade would put next year's åk 4 back on the old bilaga it
 * never started under; carrying it by cohort is the line moving with the
 * pupils, which is what the admin would otherwise retype every spring.
 *
 * THE RULE, per grade g of the new year:
 *   - CARRIED: the source year attaches a plan to g−1 and that cohort does
 *     not graduate (g−1 < G). The plan is kept whatever its status: a DRAFT
 *     carried along stays attached, and the preview says it is a draft.
 *   - DEFAULT: no source row for g−1 — the school's entry grade (F or åk 1
 *     in an F–9 school, åk 7 in a 7–9 school), or a gap the admin left —
 *     and g is a grade the source year attaches. g takes the newest DECIDED
 *     plan, by P2's own default rule (readDefaultTimplan), provided that
 *     plan speaks for g; otherwise NONE.
 *   - NONE: as DEFAULT, but no decided plan speaks for g. No row is written;
 *     the coverage report says TIMPLAN_YEAR_GRADE_UNATTACHED, as it does for
 *     any grade without one.
 *
 * WHICH GRADES. Those the source year attaches, and those a cohort carries a
 * plan into: g is in the new year when the source has a row for g, or for
 * g−1 below G. A 7–9 school that removed åk 1–6 from its year does not get
 * them back every summer. A source grade at or above G graduates and
 * contributes nothing; a grade above 10 does not exist in the table (its
 * CHECK, 0..10).
 *
 * A SOURCE YEAR WITH NO ROWS AT ALL (a year from before P2, which the
 * migration did not backfill, or one whose rows were all cleared) says
 * nothing about which grades the school has, so the new year gets exactly
 * what P2's AcademicYearsService.create would have given it: the default
 * plan for every grade it speaks for.
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
}

export interface DefaultTimplanChoice {
  id: string;
  name: string;
  status: LocalTimplanStatus;
  gradeLevels: readonly number[];
}

export type TimplanCarryReason = 'CARRIED' | 'DEFAULT' | 'NONE';

export interface PlannedTimplan {
  gradeLevel: number;
  reason: TimplanCarryReason;
  /** CARRIED: the source grade whose plan this is (gradeLevel − 1). */
  fromGradeLevel: number | null;
  localTimplanId: string | null;
  planName: string | null;
  planStatus: LocalTimplanStatus | null;
}

/** The table's CHECK: 0 = förskoleklass … 10. */
const MAX_GRADE = 10;

export function planCohortTimplans(
  source: readonly SourceTimplanRow[],
  graduatingGradeLevel: number,
  defaultPlan: DefaultTimplanChoice | null,
): PlannedTimplan[] {
  const fromDefault = (gradeLevel: number): PlannedTimplan =>
    defaultPlan && defaultPlan.gradeLevels.includes(gradeLevel)
      ? {
          gradeLevel,
          reason: 'DEFAULT',
          fromGradeLevel: null,
          localTimplanId: defaultPlan.id,
          planName: defaultPlan.name,
          planStatus: defaultPlan.status,
        }
      : { gradeLevel, reason: 'NONE', fromGradeLevel: null, localTimplanId: null, planName: null, planStatus: null };

  if (source.length === 0) {
    return (defaultPlan?.gradeLevels ?? []).map(fromDefault);
  }

  const byGrade = new Map(source.map((row) => [row.gradeLevel, row]));
  const grades = new Set<number>();
  for (const row of source) {
    grades.add(row.gradeLevel);
    const next = row.gradeLevel + 1;
    if (row.gradeLevel < graduatingGradeLevel && next <= MAX_GRADE) grades.add(next);
  }
  return [...grades]
    .sort((a, b) => a - b)
    .map((gradeLevel) => {
      const below = byGrade.get(gradeLevel - 1);
      if (below && below.gradeLevel < graduatingGradeLevel) {
        return {
          gradeLevel,
          reason: 'CARRIED' as const,
          fromGradeLevel: below.gradeLevel,
          localTimplanId: below.localTimplanId,
          planName: below.planName,
          planStatus: below.planStatus,
        };
      }
      return fromDefault(gradeLevel);
    });
}
