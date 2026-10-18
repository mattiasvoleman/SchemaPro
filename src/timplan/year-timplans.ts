import type { GradeNumbering, LocalTimplanStatus, Prisma } from '@prisma/client';
import { gradeOfPlanRow, lydelseIsTioarig, planRowOf } from '../common/grade-numbering';
import { htOf, planFitsCohort } from '../common/timplan-cohorts';
import { stageGradesFor, type CoverageVersion } from '../common/timplan-coverage';

/**
 * Which lokal timplan each årskurs of a läsår follows — AcademicYearTimplans,
 * migration 20261007130000 — read and seeded in one place, so the year dialog's
 * PUT, a new year's defaults and the coverage report agree on what a row means.
 *
 * "No plan for this grade" is the ABSENCE of a row (localTimplanId is NOT
 * NULL). A draft plan may be attached — next year is planned in the spring,
 * before the huvudman decides — and every reader marks it: planStatus is
 * carried on every row this module hands out.
 */

/** One (årskurs → plan) row as the API states it. */
export interface YearTimplanRow {
  gradeLevel: number;
  localTimplanId: string;
  planName: string;
  planStatus: LocalTimplanStatus;
  /**
   * Whether the plan's lydelse numbers its rows the tioårig way (applies from
   * HT 2028): with the year's gradeNumbering, which row of the plan the
   * årskurs reads (grade-numbering.ts, planRowOf).
   */
  planTioarig: boolean;
}

/** The year's rows, by årskurs. */
export async function readYearTimplans(
  tx: Prisma.TransactionClient,
  academicYearId: string,
): Promise<YearTimplanRow[]> {
  const rows = await tx.academicYearTimplan.findMany({
    where: { academicYearId },
    orderBy: { gradeLevel: 'asc' },
    select: {
      gradeLevel: true,
      localTimplanId: true,
      localTimplan: {
        select: { name: true, status: true, nationalVersion: { select: { appliesFromCohortTerm: true } } },
      },
    },
  });
  return rows.map((row) => ({
    gradeLevel: row.gradeLevel,
    localTimplanId: row.localTimplanId,
    planName: row.localTimplan.name,
    planStatus: row.localTimplan.status,
    planTioarig: lydelseIsTioarig(row.localTimplan.nationalVersion.appliesFromCohortTerm),
  }));
}

/**
 * A NEW läsår's defaults: every årskurs the school's newest DECIDED plan can
 * speak for, attached to that plan.
 *
 * "Can speak for" is the grades its national version maps to a stadium
 * (stageGradesFor: 1–9 for today's grundskola, 1–10 for specialskolan, 1–6 for
 * sameskolan, 1–10 under the 2028 lydelse), plus årskurs 0 when the plan
 * itself has förskoleklass entries — the statute has no F-klass stage, so only
 * the school's own rows say it plans one. A grade the version has no stage
 * for is left unattached rather than guessed: the year dialog shows it empty
 * and the coverage report says TIMPLAN_YEAR_GRADE_UNATTACHED.
 *
 * NEWEST by decidedAt — the plan the huvudman decided last is the one a new
 * year starts from; a school whose åk 7–9 still follow the older plan says so
 * in the dialog (the deep-dive's cohort note: the admin writes it, nothing
 * infers it). A draft is never a default: attaching one is a choice somebody
 * makes in the dialog, not something a year acquires by being created.
 *
 * No DECIDED plan, nothing attached and nothing said: that is today's
 * behaviour for every school, and the migration is behaviour-neutral for the
 * same reason (no backfill for existing years).
 *
 * Written with the caller's transaction, so the year and its defaults commit
 * together or not at all.
 */
export async function attachDefaultTimplans(
  tx: Prisma.TransactionClient,
  schoolId: string,
  academicYearId: string,
  numbering: GradeNumbering = 'NIOARIG',
  startDate?: string,
): Promise<YearTimplanRow[]> {
  const plan = await readDefaultTimplan(tx);
  if (!plan || plan.gradeLevels.length === 0) return [];
  // The plan's grades are its lydelse's rows; the year attaches the årskurser
  // that read them (an older plan's 1–9 are a TIOARIG year's 2–10).
  const gradeLevels = plan.gradeLevels
    .map((row) => gradeOfPlanRow(lydelseIsTioarig(plan.appliesFromCohortTerm), numbering, row))
    .filter((grade): grade is number => grade !== null && grade <= MAX_ATTACHABLE_GRADE);

  // Each årskurs follows the plan only when its årskull may (planFitsCohort):
  // from HT 2028 a plan on SFS 2025:729 is for the new åk 1 alone, and an
  // older plan for everybody above it. An årskurs it does not fit takes the
  // newest decided plan of the same form that speaks for it and fits, or none.
  const ht = startDate === undefined ? null : htOf(startDate);
  const fits = (candidate: DecidedTimplan, grade: number) =>
    ht === null || planFitsCohort(candidate.appliesFromCohortTerm, ht, grade);
  let others: DecidedTimplan[] | null = null;
  const rows: YearTimplanRow[] = [];
  for (const gradeLevel of gradeLevels) {
    let chosen: DecidedTimplan | undefined = fits(plan, gradeLevel) ? plan : undefined;
    if (!chosen) {
      others ??= (await readDecidedTimplans(tx)).filter((other) => other.id !== plan.id && other.schoolForm === plan.schoolForm);
      chosen = others.find((other) => speaksFor(other, numbering, gradeLevel) && fits(other, gradeLevel));
    }
    if (!chosen) continue;
    rows.push({
      gradeLevel,
      localTimplanId: chosen.id,
      planName: chosen.name,
      planStatus: chosen.status,
      planTioarig: lydelseIsTioarig(chosen.appliesFromCohortTerm),
    });
  }
  if (rows.length === 0) return [];

  await tx.academicYearTimplan.createMany({
    data: rows.map((row) => ({
      schoolId,
      academicYearId,
      gradeLevel: row.gradeLevel,
      localTimplanId: row.localTimplanId,
    })),
  });
  return rows;
}

/** Whether a decided plan has a row for årskurs `grade` of a year in `numbering`. */
export function speaksFor(
  plan: { appliesFromCohortTerm: string; gradeLevels: readonly number[] },
  numbering: GradeNumbering,
  grade: number,
): boolean {
  const row = planRowOf(lydelseIsTioarig(plan.appliesFromCohortTerm), numbering, grade);
  return row !== null && plan.gradeLevels.includes(row);
}

/** AcademicYearTimplans_gradeLevel_is_sane's top (20261126090000). */
const MAX_ATTACHABLE_GRADE = 11;

/** A DECIDED plan, and the grades it speaks for by default. */
export interface DecidedTimplan {
  id: string;
  name: string;
  status: LocalTimplanStatus;
  /** The plan's own school form (its national version's, by the composite key). */
  schoolForm: string;
  /** Its national version's first cohort term, 'HT2024'. */
  appliesFromCohortTerm: string;
  /** Ascending; empty when the version maps no grade to a stadium. */
  gradeLevels: number[];
}

/** "Newest" for every reader: decided last, then created last, then by id. */
const NEWEST_DECIDED_FIRST = [
  { decidedAt: 'desc' as const },
  { createdAt: 'desc' as const },
  { id: 'asc' as const },
];
const DECIDED_SELECT = {
  id: true,
  name: true,
  status: true,
  schoolForm: true,
  nationalVersion: { select: { schoolForm: true, appliesFromCohortTerm: true } },
  entries: { where: { gradeLevel: 0 }, select: { gradeLevel: true }, take: 1 },
} as const;

function decidedTimplanOf(plan: {
  id: string;
  name: string;
  status: LocalTimplanStatus;
  schoolForm: string;
  nationalVersion: Pick<CoverageVersion, 'schoolForm' | 'appliesFromCohortTerm'>;
  entries: unknown[];
}): DecidedTimplan {
  return {
    id: plan.id,
    name: plan.name,
    status: plan.status,
    schoolForm: plan.schoolForm,
    appliesFromCohortTerm: plan.nationalVersion.appliesFromCohortTerm,
    gradeLevels: defaultTimplanGrades(plan.nationalVersion, plan.entries.length > 0),
  };
}

/**
 * The school's newest DECIDED plan and the grades it can speak for — the
 * default rule above, read without writing.
 */
export async function readDefaultTimplan(tx: Prisma.TransactionClient): Promise<DecidedTimplan | null> {
  const plan = await tx.localTimplan.findFirst({
    where: { status: 'DECIDED' },
    orderBy: NEWEST_DECIDED_FIRST,
    select: DECIDED_SELECT,
  });
  return plan ? decidedTimplanOf(plan) : null;
}

/**
 * Every DECIDED plan of the school, newest first by the same order as
 * readDefaultTimplan, so its first element IS that default. The
 * läsårsrullning chooses among them per grade (src/year-rollover/
 * rollover-timplans.ts): a grade no cohort carries a plan into takes the
 * newest that speaks for it, which is not always the newest of all.
 */
export async function readDecidedTimplans(tx: Prisma.TransactionClient): Promise<DecidedTimplan[]> {
  const plans = await tx.localTimplan.findMany({
    where: { status: 'DECIDED' },
    orderBy: NEWEST_DECIDED_FIRST,
    select: DECIDED_SELECT,
  });
  return (plans ?? []).map(decidedTimplanOf);
}

/**
 * The grades a plan of this national version speaks for by default: its
 * stadier's grades, plus förskoleklass when the plan itself plans one.
 */
export function defaultTimplanGrades(
  version: Pick<CoverageVersion, 'schoolForm' | 'appliesFromCohortTerm'>,
  plansForskoleklass: boolean,
): number[] {
  const stages = stageGradesFor(version);
  const grades = new Set([...stages.LAG, ...stages.MELLAN, ...stages.HOG]);
  if (plansForskoleklass) grades.add(0);
  return [...grades].sort((a, b) => a - b);
}
