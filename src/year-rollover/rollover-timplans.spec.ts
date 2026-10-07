import type { PrismaClient } from '@prisma/client';
import { ROLLOVER_STEPS, type StepContext } from './rollover-apply';
import type { RolloverWrites } from './rollover-plan';
import {
  cohortStartYear,
  planCohortTimplans,
  type CohortTimplanInput,
  type DecidedTimplanChoice,
  type SourceTimplanRow,
} from './rollover-timplans';

/**
 * The cohort carry of timplan per årskurs, as a pure rule. The scenarios are
 * the schools P2's migration names: an F–9 school mid-way through the
 * SFS 2023:945 change (the new bilaga from åk 1 HT 2024 upwards), a 7–9
 * school (with and without the F–6 rows P2's create gives it), a year with a
 * hole in it, a draft planned in the spring, and a school that has decided
 * nothing.
 */

type Plan = { id: string; name: string; status: 'DECIDED' | 'DRAFT'; schoolForm?: string };
const NEW: Plan = { id: 'p-new', name: 'Grundskola 2024', status: 'DECIDED' };
const OLD: Plan = { id: 'p-old', name: 'Grundskola 2018', status: 'DECIDED' };
const DRAFT: Plan = { id: 'p-draft', name: 'Utkast 2028', status: 'DRAFT' };

const row = (gradeLevel: number, plan: Plan): SourceTimplanRow => ({
  gradeLevel,
  localTimplanId: plan.id,
  planName: plan.name,
  planStatus: plan.status,
  planSchoolForm: plan.schoolForm ?? 'GRUNDSKOLA',
});
const rows = (grades: number[], plan: Plan) => grades.map((grade) => row(grade, plan));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

/** A decided grundskola plan as readDecidedTimplans gives it: stadier 1–9, plus F when it plans F. */
const decidedOf = (plan: Plan, withF = true): DecidedTimplanChoice => ({
  id: plan.id,
  name: plan.name,
  status: 'DECIDED',
  schoolForm: plan.schoolForm ?? 'GRUNDSKOLA',
  appliesFromCohortTerm: 'HT2024',
  gradeLevels: withF ? range(0, 9) : range(1, 9),
});

/** A decided plan on the 2028 (tioårig) lydelse: stadier 1–4, 5–7, 8–10. */
const TIOARIG: DecidedTimplanChoice = {
  id: 'p-2028',
  name: 'Tioårig 2028',
  status: 'DECIDED',
  schoolForm: 'GRUNDSKOLA',
  appliesFromCohortTerm: 'HT2028',
  gradeLevels: range(1, 10),
};

/** Every source grade below G has a class that moves up, unless a test says otherwise; the new year is 2027/28. */
const plan = (input: Partial<CohortTimplanInput> & { source: SourceTimplanRow[] }) =>
  planCohortTimplans({
    graduatingGradeLevel: 9,
    movingCohorts: new Set(range(0, 9)),
    decided: [],
    targetStartYear: 2027,
    ...input,
  });

/** [grade, reason, plan id, from] per row, the shape every expectation reads. */
const summary = (planned: ReturnType<typeof planCohortTimplans>) =>
  planned.map((entry) => [entry.gradeLevel, entry.reason, entry.localTimplanId, entry.fromGradeLevel]);

describe('planCohortTimplans', () => {
  it('moves an F–9 school’s bilaga line up a grade with its cohort, and gives F the newest decided plan', () => {
    // 2026/27: F–2 on the new bilaga, 3–9 still on the old one.
    const source = [...rows(range(0, 2), NEW), ...rows(range(3, 9), OLD)];
    const planned = plan({ source, decided: [decidedOf(NEW), decidedOf(OLD)] });
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
    const planned = plan({ source: rows(range(1, 9), OLD), decided: [decidedOf(NEW, false), decidedOf(OLD, false)] });
    expect(summary(planned).slice(0, 2)).toEqual([
      [1, 'DEFAULT', NEW.id, null],
      [2, 'CARRIED', OLD.id, 1],
    ]);
    expect(planned).toHaveLength(9);
  });

  it('gives a 7–9 school its own three grades, åk 7 the default, and never åk 1–6 back', () => {
    const planned = plan({ source: rows([7, 8, 9], OLD), movingCohorts: new Set([7, 8]), decided: [decidedOf(NEW)] });
    expect(summary(planned)).toEqual([
      [7, 'DEFAULT', NEW.id, null],
      [8, 'CARRIED', OLD.id, 7],
      [9, 'CARRIED', OLD.id, 8],
    ]);
  });

  it('reads a cohort off a class that moves up, not off the F–6 rows P2’s create gave a 7–9 school', () => {
    // The year was created when OLD was the newest decided plan, so P2's
    // create attached OLD to F–9; the school has classes in åk 7–9 only.
    // NEW has been decided since. Åk 7 is the intake and takes NEW; no class
    // moves out of åk 6, so nothing is "carried" from it.
    const planned = plan({
      source: rows(range(0, 9), OLD),
      movingCohorts: new Set([7, 8]),
      decided: [decidedOf(NEW), decidedOf(OLD)],
    });
    expect(summary(planned)).toEqual([
      ...range(0, 7).map((grade) => [grade, 'DEFAULT', NEW.id, null]),
      [8, 'CARRIED', OLD.id, 7],
      [9, 'CARRIED', OLD.id, 8],
    ]);
  });

  it('carries nothing out of a grade whose classes stay (CARRY) or are skipped', () => {
    const planned = plan({ source: rows([7, 8, 9], OLD), movingCohorts: new Set([8]), decided: [decidedOf(NEW)] });
    expect(summary(planned)).toEqual([
      [7, 'DEFAULT', NEW.id, null],
      [8, 'DEFAULT', NEW.id, null],
      [9, 'CARRIED', OLD.id, 8],
    ]);
  });

  it('treats the grade above a hole as an entry grade, and still carries the hole’s cohort from below it', () => {
    // Åk 4 was never attached this year.
    const source = [...rows(range(1, 3), NEW), ...rows(range(5, 9), OLD)];
    const planned = plan({ source, decided: [decidedOf(NEW, false)] });
    const byGrade = new Map(summary(planned).map((entry) => [entry[0], entry]));
    expect(byGrade.get(4)).toEqual([4, 'CARRIED', NEW.id, 3]);
    expect(byGrade.get(5)).toEqual([5, 'DEFAULT', NEW.id, null]);
    expect(byGrade.get(6)).toEqual([6, 'CARRIED', OLD.id, 5]);
  });

  it('carries a draft as a draft', () => {
    const planned = plan({ source: [row(6, DRAFT), row(7, OLD)], decided: [decidedOf(NEW)] });
    expect(planned.find((entry) => entry.gradeLevel === 7)).toEqual({
      gradeLevel: 7,
      reason: 'CARRIED',
      fromGradeLevel: 6,
      localTimplanId: DRAFT.id,
      planName: 'Utkast 2028',
      planStatus: 'DRAFT',
      laterPlan: null,
    });
  });

  it('gives F the newest decided plan that plans F, when the newest of all does not', () => {
    // F follows OLD, which plans förskoleklass; NEW, decided since, does not.
    const planned = plan({ source: rows(range(0, 9), OLD), decided: [decidedOf(NEW, false), decidedOf(OLD)] });
    expect(summary(planned)[0]).toEqual([0, 'DEFAULT', OLD.id, null]);
  });

  it('keeps a grade’s own plan when no decided plan speaks for it, instead of dropping its row', () => {
    // F follows a draft; the only decided plan plans no förskoleklass.
    const source = [row(0, DRAFT), ...rows(range(1, 9), OLD)];
    const planned = plan({ source, decided: [decidedOf(NEW, false)] });
    expect(planned[0]).toEqual({
      gradeLevel: 0,
      reason: 'KEPT',
      fromGradeLevel: null,
      localTimplanId: DRAFT.id,
      planName: 'Utkast 2028',
      planStatus: 'DRAFT',
      laterPlan: null,
    });
    expect(planned.map((entry) => entry.gradeLevel)).toEqual(range(0, 9));
  });

  it('keeps an entry grade’s own plan when the school has decided none, and still carries the cohorts', () => {
    const planned = plan({ source: rows([7, 8, 9], DRAFT), movingCohorts: new Set([7, 8]) });
    expect(summary(planned)).toEqual([
      [7, 'KEPT', DRAFT.id, null],
      [8, 'CARRIED', DRAFT.id, 7],
      [9, 'CARRIED', DRAFT.id, 8],
    ]);
  });

  it('defaults a grade only to a plan of its own school form', () => {
    // Åk 1 follows an anpassad grundskola plan; the newest decided plan is a
    // grundskola plan, so åk 1 takes the newest decided anpassad one, or
    // keeps its own when there is none.
    const ANPASSAD: Plan = { id: 'p-anp', name: 'Anpassad 2023', status: 'DECIDED', schoolForm: 'ANPASSAD_GRUNDSKOLA_AMNEN' };
    const source = rows(range(1, 9), ANPASSAD);
    expect(summary(plan({ source, decided: [decidedOf(NEW, false)] }))[0]).toEqual([1, 'KEPT', ANPASSAD.id, null]);
    expect(summary(plan({ source, decided: [decidedOf(NEW, false), decidedOf(ANPASSAD, false)] }))[0]).toEqual([
      1,
      'DEFAULT',
      ANPASSAD.id,
      null,
    ]);
  });

  it('counts a cohort’s start from the term it starts åk 1', () => {
    expect(cohortStartYear(1, 2027)).toBe(2027);
    expect(cohortStartYear(7, 2027)).toBe(2021);
    // Förskoleklass starts åk 1 the year after.
    expect(cohortStartYear(0, 2027)).toBe(2028);
  });

  it('does not give the cohort entering åk 1 in HT2027 a plan on the HT2028 lydelse, and names the one it skipped', () => {
    // Decided in the spring of 2027, after the HT2024 plan.
    const planned = plan({ source: rows(range(1, 9), OLD), decided: [TIOARIG, decidedOf(NEW, false)] });
    expect(planned[0]).toEqual({
      gradeLevel: 1,
      reason: 'DEFAULT',
      fromGradeLevel: null,
      localTimplanId: NEW.id,
      planName: NEW.name,
      planStatus: 'DECIDED',
      laterPlan: { name: 'Tioårig 2028', appliesFromCohortTerm: 'HT2028' },
    });
  });

  it('gives the HT2028 plan to the cohort that starts åk 1 under it', () => {
    const planned = plan({
      source: rows(range(1, 9), OLD),
      decided: [TIOARIG, decidedOf(NEW, false)],
      targetStartYear: 2028,
    });
    expect(planned[0]).toMatchObject({ gradeLevel: 1, reason: 'DEFAULT', localTimplanId: TIOARIG.id, laterPlan: null });
  });

  it('stands the earliest lydelse the school has in for one older than any, never a later one', () => {
    // A 7–9 school's intake in HT2027 started åk 1 in HT2021, before every
    // lydelse in the reference data; HT2024 is the closest it has.
    const planned = plan({
      source: rows([7, 8, 9], OLD),
      movingCohorts: new Set([7, 8]),
      decided: [TIOARIG, decidedOf(NEW)],
    });
    expect(planned[0]).toMatchObject({
      gradeLevel: 7,
      reason: 'DEFAULT',
      localTimplanId: NEW.id,
      laterPlan: { name: 'Tioårig 2028', appliesFromCohortTerm: 'HT2028' },
    });
    // With only the later lydelse decided, it is the one there is.
    expect(plan({ source: rows([7, 8, 9], OLD), movingCohorts: new Set([7, 8]), decided: [TIOARIG] })[0]).toMatchObject({
      gradeLevel: 7,
      reason: 'DEFAULT',
      localTimplanId: TIOARIG.id,
      laterPlan: null,
    });
  });

  it('stops at the graduating grade the admin chose, and at the table’s åk 10', () => {
    // An F–6 school: åk 6 leaves, so nothing is carried into 7.
    expect(plan({ source: rows(range(1, 6), OLD), graduatingGradeLevel: 6 }).map((entry) => entry.gradeLevel)).toEqual(
      range(1, 6),
    );
    // A grade-10 cohort with G above it would land on 11, which no row may hold.
    expect(
      plan({ source: [row(10, OLD)], graduatingGradeLevel: 12, movingCohorts: new Set([10]) }).map(
        (entry) => entry.gradeLevel,
      ),
    ).toEqual([10]);
  });

  it('gives a source year with no rows exactly P2’s default for a new year', () => {
    expect(summary(plan({ source: [], decided: [decidedOf(NEW), decidedOf(OLD)] }))).toEqual(
      range(0, 9).map((grade) => [grade, 'DEFAULT', NEW.id, null]),
    );
    expect(plan({ source: [] })).toEqual([]);
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
