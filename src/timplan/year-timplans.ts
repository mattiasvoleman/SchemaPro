import type { LocalTimplanStatus, Prisma } from '@prisma/client';
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
      localTimplan: { select: { name: true, status: true } },
    },
  });
  return rows.map((row) => ({
    gradeLevel: row.gradeLevel,
    localTimplanId: row.localTimplanId,
    planName: row.localTimplan.name,
    planStatus: row.localTimplan.status,
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
): Promise<YearTimplanRow[]> {
  const plan = await readDefaultTimplan(tx);
  if (!plan || plan.gradeLevels.length === 0) return [];

  await tx.academicYearTimplan.createMany({
    data: plan.gradeLevels.map((gradeLevel) => ({
      schoolId,
      academicYearId,
      gradeLevel,
      localTimplanId: plan.id,
    })),
  });
  return plan.gradeLevels.map((gradeLevel) => ({
    gradeLevel,
    localTimplanId: plan.id,
    planName: plan.name,
    planStatus: plan.status,
  }));
}

/** The plan a new year's grades default to, and which grades it speaks for. */
export interface DefaultTimplan {
  id: string;
  name: string;
  status: LocalTimplanStatus;
  /** Ascending; empty when the version maps no grade to a stadium. */
  gradeLevels: number[];
}

/**
 * The school's newest DECIDED plan and the grades it can speak for — the
 * default rule above, read without writing. attachDefaultTimplans writes it
 * into a new year; the läsårsrullning reads it for the grades no cohort
 * carries a plan into (src/year-rollover/rollover-timplans.ts), so the two
 * cannot disagree about which plan is "newest" or which grades it covers.
 */
export async function readDefaultTimplan(tx: Prisma.TransactionClient): Promise<DefaultTimplan | null> {
  const plan = await tx.localTimplan.findFirst({
    where: { status: 'DECIDED' },
    orderBy: [{ decidedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      status: true,
      nationalVersion: { select: { schoolForm: true, appliesFromCohortTerm: true } },
      entries: { where: { gradeLevel: 0 }, select: { gradeLevel: true }, take: 1 },
    },
  });
  if (!plan) return null;
  return {
    id: plan.id,
    name: plan.name,
    status: plan.status,
    gradeLevels: defaultTimplanGrades(plan.nationalVersion, plan.entries.length > 0),
  };
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
