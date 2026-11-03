import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { attachDefaultTimplans, defaultTimplanGrades, readDecidedTimplans } from './year-timplans';

/*
 * What a new läsår attaches a decided plan to. The grades are the stadier's
 * (the version's cut), plus förskoleklass when the plan plans one — and, since
 * 20261219090000, only those the plan's årskurs span holds: a 4–9 plan was never
 * written for the lågstadium, and a year that attached it there would put a
 * grade's pupils under a plan that says nothing of them.
 */

const B1 = { schoolForm: 'GRUNDSKOLA', appliesFromCohortTerm: 'HT2024' } as const;
const LAW_2028 = { schoolForm: 'GRUNDSKOLA', appliesFromCohortTerm: 'HT2028' } as const;
const B4 = { schoolForm: 'SAMESKOLA', appliesFromCohortTerm: 'HT2024' } as const;

describe('defaultTimplanGrades', () => {
  it('is every årskurs of the version with no span, förskoleklassen when the plan plans one', () => {
    expect(defaultTimplanGrades(B1, false)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(defaultTimplanGrades(B1, true)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(defaultTimplanGrades(B1, false, null)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(defaultTimplanGrades(B4, false)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('is only the årskurser of the span: a 4–9 plan does not speak for the lågstadium', () => {
    expect(defaultTimplanGrades(B1, false, { gradeFrom: 4, gradeTo: 9 })).toEqual([4, 5, 6, 7, 8, 9]);
    expect(defaultTimplanGrades(B1, false, { gradeFrom: 0, gradeTo: 5 })).toEqual([1, 2, 3, 4, 5]);
    expect(defaultTimplanGrades(B1, false, { gradeFrom: 6, gradeTo: 9 })).toEqual([6, 7, 8, 9]);
    expect(defaultTimplanGrades(B1, false, { gradeFrom: 1, gradeTo: 9 })).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('takes förskoleklassen only where the span holds årskurs 0', () => {
    expect(defaultTimplanGrades(B1, true, { gradeFrom: 0, gradeTo: 5 })).toEqual([0, 1, 2, 3, 4, 5]);
    expect(defaultTimplanGrades(B1, true, { gradeFrom: 4, gradeTo: 9 })).toEqual([4, 5, 6, 7, 8, 9]);
    expect(defaultTimplanGrades(B1, false, { gradeFrom: 0, gradeTo: 5 })).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads the span in the numbering of the version’s lydelse', () => {
    expect(defaultTimplanGrades(LAW_2028, false, { gradeFrom: 5, gradeTo: 10 })).toEqual([5, 6, 7, 8, 9, 10]);
    expect(defaultTimplanGrades(LAW_2028, false, { gradeFrom: 1, gradeTo: 4 })).toEqual([1, 2, 3, 4]);
  });
});

describe('the decided plans a läsår chooses among', () => {
  let tx: TxMock;
  beforeEach(() => {
    tx = createTxMock();
  });

  const plan = (overrides: Record<string, unknown> = {}) => ({
    id: 'plan-1',
    name: 'Grundskolan 4–9',
    status: 'DECIDED',
    schoolForm: 'GRUNDSKOLA',
    nationalVersion: B1,
    gradeFrom: null,
    gradeTo: null,
    entries: [],
    ...overrides,
  });

  it('reads the span of every decided plan and gives it its årskurser, and a plan without one all of the form', async () => {
    tx.localTimplan.findMany.mockResolvedValue([
      plan({ gradeFrom: 4, gradeTo: 9 }),
      plan({ id: 'plan-2', name: 'Hela', gradeFrom: null, gradeTo: null }),
    ]);

    const plans = await readDecidedTimplans(tx as never);

    expect(plans.map((p) => p.gradeLevels)).toEqual([[4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 5, 6, 7, 8, 9]]);
    expect(tx.localTimplan.findMany.mock.calls[0]![0].select).toMatchObject({ gradeFrom: true, gradeTo: true });
  });

  it('attaches a new year only to the årskurser a decided span plan is for', async () => {
    tx.localTimplan.findFirst.mockResolvedValue(plan({ gradeFrom: 4, gradeTo: 9 }));
    tx.academicYearTimplan.createMany.mockResolvedValue({ count: 6 });

    const rows = await attachDefaultTimplans(tx as never, 'school-1', 'year-1');

    expect(rows.map((row) => row.gradeLevel)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(tx.academicYearTimplan.createMany).toHaveBeenCalledWith({
      data: [4, 5, 6, 7, 8, 9].map((gradeLevel) => ({
        schoolId: 'school-1',
        academicYearId: 'year-1',
        gradeLevel,
        localTimplanId: 'plan-1',
      })),
    });
  });

  it('keeps attaching every årskurs of the form for a plan without a span', async () => {
    tx.localTimplan.findFirst.mockResolvedValue(plan());
    tx.academicYearTimplan.createMany.mockResolvedValue({ count: 9 });

    const rows = await attachDefaultTimplans(tx as never, 'school-1', 'year-1');

    expect(rows.map((row) => row.gradeLevel)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
