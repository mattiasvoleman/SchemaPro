import type { PrismaClient } from '@prisma/client';
import { ROLLOVER_STEPS, type StepContext } from './rollover-apply';
import type { RolloverWrites } from './rollover-plan';
import { planCohortTimplans, type DefaultTimplanChoice, type SourceTimplanRow } from './rollover-timplans';

/**
 * The cohort carry of timplan per årskurs, as a pure rule. The scenarios are
 * the schools P2's migration names: an F–9 school mid-way through the
 * SFS 2023:945 change (the new bilaga from åk 1 HT 2024 upwards), a 7–9
 * school, a year with a hole in it, a draft planned in the spring, and a
 * school that has decided nothing.
 */

const NEW = { id: 'p-new', name: 'Grundskola 2024', status: 'DECIDED' as const };
const OLD = { id: 'p-old', name: 'Grundskola 2018', status: 'DECIDED' as const };
const DRAFT = { id: 'p-draft', name: 'Utkast 2028', status: 'DRAFT' as const };

const row = (gradeLevel: number, plan: { id: string; name: string; status: 'DECIDED' | 'DRAFT' }): SourceTimplanRow => ({
  gradeLevel,
  localTimplanId: plan.id,
  planName: plan.name,
  planStatus: plan.status,
});
const rows = (grades: number[], plan: Parameters<typeof row>[1]) => grades.map((grade) => row(grade, plan));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

/** P2's default for a grundskola plan: stadier 1–9, plus F when it plans F. */
const defaultOf = (plan: typeof NEW, withF = true): DefaultTimplanChoice => ({
  ...plan,
  gradeLevels: withF ? range(0, 9) : range(1, 9),
});

/** [grade, reason, plan id, from] per row, the shape every expectation reads. */
const summary = (planned: ReturnType<typeof planCohortTimplans>) =>
  planned.map((entry) => [entry.gradeLevel, entry.reason, entry.localTimplanId, entry.fromGradeLevel]);

describe('planCohortTimplans', () => {
  it('moves an F–9 school’s bilaga line up a grade with its cohort, and gives F the newest decided plan', () => {
    // 2026/27: F–2 on the new bilaga, 3–9 still on the old one.
    const source = [...rows(range(0, 2), NEW), ...rows(range(3, 9), OLD)];
    const planned = planCohortTimplans(source, 9, defaultOf(NEW));
    expect(summary(planned)).toEqual([
      [0, 'DEFAULT', NEW.id, null],
      [1, 'CARRIED', NEW.id, 0],
      [2, 'CARRIED', NEW.id, 1],
      [3, 'CARRIED', NEW.id, 2],
      [4, 'CARRIED', OLD.id, 3],
      [5, 'CARRIED', OLD.id, 4],
      [6, 'CARRIED', OLD.id, 5],
      [7, 'CARRIED', OLD.id, 6],
      [8, 'CARRIED', OLD.id, 7],
      [9, 'CARRIED', OLD.id, 8],
    ]);
    // Åk 9's cohort graduates and carries nothing: there is no row for 10.
    expect(planned.some((entry) => entry.gradeLevel === 10)).toBe(false);
  });

  it('makes åk 1 the entry grade when F follows no plan', () => {
    const planned = planCohortTimplans(rows(range(1, 9), OLD), 9, defaultOf(NEW, false));
    expect(summary(planned).slice(0, 2)).toEqual([
      [1, 'DEFAULT', NEW.id, null],
      [2, 'CARRIED', OLD.id, 1],
    ]);
    expect(planned).toHaveLength(9);
  });

  it('gives a 7–9 school its own three grades, åk 7 the default, and never åk 1–6 back', () => {
    const planned = planCohortTimplans(rows([7, 8, 9], OLD), 9, defaultOf(NEW));
    expect(summary(planned)).toEqual([
      [7, 'DEFAULT', NEW.id, null],
      [8, 'CARRIED', OLD.id, 7],
      [9, 'CARRIED', OLD.id, 8],
    ]);
  });

  it('treats the grade above a hole as an entry grade, and still carries the hole’s cohort from below it', () => {
    // Åk 4 was never attached this year.
    const source = [...rows(range(1, 3), NEW), ...rows(range(5, 9), OLD)];
    const planned = planCohortTimplans(source, 9, defaultOf(NEW, false));
    const byGrade = new Map(summary(planned).map((entry) => [entry[0], entry]));
    expect(byGrade.get(4)).toEqual([4, 'CARRIED', NEW.id, 3]);
    expect(byGrade.get(5)).toEqual([5, 'DEFAULT', NEW.id, null]);
    expect(byGrade.get(6)).toEqual([6, 'CARRIED', OLD.id, 5]);
  });

  it('carries a draft as a draft', () => {
    const planned = planCohortTimplans([row(6, DRAFT), row(7, OLD)], 9, defaultOf(NEW));
    expect(planned.find((entry) => entry.gradeLevel === 7)).toEqual({
      gradeLevel: 7,
      reason: 'CARRIED',
      fromGradeLevel: 6,
      localTimplanId: DRAFT.id,
      planName: 'Utkast 2028',
      planStatus: 'DRAFT',
    });
  });

  it('leaves an entry grade without a plan when the school has decided none, and still carries the cohorts', () => {
    const planned = planCohortTimplans(rows([7, 8, 9], DRAFT), 9, null);
    expect(summary(planned)).toEqual([
      [7, 'NONE', null, null],
      [8, 'CARRIED', DRAFT.id, 7],
      [9, 'CARRIED', DRAFT.id, 8],
    ]);
    expect(planned[0]).toMatchObject({ planName: null, planStatus: null });
  });

  it('leaves an entry grade the decided plan does not speak for without one', () => {
    // A sameskola-style default (1–6) for a school whose year starts at åk 7.
    const planned = planCohortTimplans(rows([7, 8], OLD), 9, { ...NEW, gradeLevels: range(1, 6) });
    expect(summary(planned)[0]).toEqual([7, 'NONE', null, null]);
  });

  it('stops at the graduating grade the admin chose, and at the table’s åk 10', () => {
    // An F–6 school: åk 6 leaves, so nothing is carried into 7.
    expect(planCohortTimplans(rows(range(1, 6), OLD), 6, null).map((entry) => entry.gradeLevel)).toEqual(range(1, 6));
    // A grade-10 cohort with G above it would land on 11, which no row may hold.
    expect(planCohortTimplans([row(10, OLD)], 12, null).map((entry) => entry.gradeLevel)).toEqual([10]);
  });

  it('gives a source year with no rows exactly P2’s default for a new year', () => {
    expect(summary(planCohortTimplans([], 9, defaultOf(NEW)))).toEqual(
      range(0, 9).map((grade) => [grade, 'DEFAULT', NEW.id, null]),
    );
    expect(planCohortTimplans([], 9, null)).toEqual([]);
  });
});

describe('the rollover’s timplans step', () => {
  const contextWith = (existing: number) => {
    const tx = {
      academicYearTimplan: {
        count: jest.fn().mockResolvedValue(existing),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const context: StepContext = {
      tx: tx as unknown as PrismaClient,
      schoolId: 'school',
      writes: {
        timplans: [
          { gradeLevel: 8, localTimplanId: OLD.id },
          { gradeLevel: 9, localTimplanId: OLD.id },
        ],
      } as RolloverWrites,
      targetYearId: 'new-year',
      groupIdByKey: new Map(),
      counts: { groups: 0, members: 0, requirements: 0, breaks: 0, classRules: 0, timplans: 0 },
    };
    return { tx, context };
  };

  it('writes the cohort rows as the new year’s whole mapping', async () => {
    const { tx, context } = contextWith(0);
    await ROLLOVER_STEPS.timplans(context);
    expect(tx.academicYearTimplan.createMany).toHaveBeenCalledWith({
      data: [
        { schoolId: 'school', academicYearId: 'new-year', gradeLevel: 8, localTimplanId: OLD.id },
        { schoolId: 'school', academicYearId: 'new-year', gradeLevel: 9, localTimplanId: OLD.id },
      ],
    });
    expect(context.counts.timplans).toBe(2);
  });

  it('refuses to mix them into a year that already has rows (P2’s defaults or anything else)', async () => {
    const { tx, context } = contextWith(9);
    await expect(ROLLOVER_STEPS.timplans(context)).rejects.toThrow('already has a timplan per årskurs');
    expect(tx.academicYearTimplan.createMany).not.toHaveBeenCalled();
  });
});
