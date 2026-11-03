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
    tx.localTimplan.findMany.mockResolvedValue([plan({ gradeFrom: 4, gradeTo: 9 })]);
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
    // Newest first, and only decided plans: a draft is never a default.
    expect(tx.localTimplan.findMany.mock.calls[0]![0]).toMatchObject({
      where: { status: 'DECIDED' },
      orderBy: [{ decidedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    });
  });

  it('keeps attaching every årskurs of the form for a plan without a span', async () => {
    tx.localTimplan.findMany.mockResolvedValue([plan()]);
    tx.academicYearTimplan.createMany.mockResolvedValue({ count: 9 });

    const rows = await attachDefaultTimplans(tx as never, 'school-1', 'year-1');

    expect(rows.map((row) => row.gradeLevel)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  describe('two decided plans with different spans', () => {
    // Newest first, as the query gives them: F–3 was decided after 4–9.
    const f3 = () => plan({ id: 'plan-f-3', name: 'Grundskolan F–3', gradeFrom: 0, gradeTo: 3 });
    const from4 = () => plan({ id: 'plan-4-9', name: 'Grundskolan 4–9', gradeFrom: 4, gradeTo: 9 });
    const attached = (rows: { gradeLevel: number; localTimplanId: string }[]) =>
      rows.map((row) => [row.gradeLevel, row.localTimplanId]);

    it('attaches each årskurs to the plan that speaks for it, not only the newest plan’s årskurser', async () => {
      tx.localTimplan.findMany.mockResolvedValue([f3(), from4()]);
      tx.academicYearTimplan.createMany.mockResolvedValue({ count: 9 });

      const rows = await attachDefaultTimplans(tx as never, 'school-1', 'year-1');

      expect(attached(rows)).toEqual([
        [1, 'plan-f-3'],
        [2, 'plan-f-3'],
        [3, 'plan-f-3'],
        [4, 'plan-4-9'],
        [5, 'plan-4-9'],
        [6, 'plan-4-9'],
        [7, 'plan-4-9'],
        [8, 'plan-4-9'],
        [9, 'plan-4-9'],
      ]);
      expect(tx.academicYearTimplan.createMany).toHaveBeenCalledTimes(1);
    });

    it('gives an årskurs both speak for to the newest of them', async () => {
      const overlapping = plan({ id: 'plan-1-6', name: 'Grundskolan 1–6', gradeFrom: 1, gradeTo: 6 });
      tx.localTimplan.findMany.mockResolvedValue([overlapping, from4()]);
      tx.academicYearTimplan.createMany.mockResolvedValue({ count: 9 });

      const rows = await attachDefaultTimplans(tx as never, 'school-1', 'year-1');

      expect(attached(rows)).toEqual([
        ...[1, 2, 3, 4, 5, 6].map((grade) => [grade, 'plan-1-6']),
        ...[7, 8, 9].map((grade) => [grade, 'plan-4-9']),
      ]);
    });

    it('leaves a gap no plan covers unattached', async () => {
      tx.localTimplan.findMany.mockResolvedValue([f3(), plan({ id: 'plan-7-9', name: '7–9', gradeFrom: 7, gradeTo: 9 })]);
      tx.academicYearTimplan.createMany.mockResolvedValue({ count: 6 });

      const rows = await attachDefaultTimplans(tx as never, 'school-1', 'year-1');

      expect(rows.map((row) => row.gradeLevel)).toEqual([1, 2, 3, 7, 8, 9]);
    });

    it('does not attach another school form’s plan to a year of the newest plan’s form', async () => {
      const special = plan({ id: 'plan-special', name: 'Specialskolan', schoolForm: 'SPECIALSKOLA', nationalVersion: { schoolForm: 'SPECIALSKOLA', appliesFromCohortTerm: 'HT2024' } });
      tx.localTimplan.findMany.mockResolvedValue([f3(), special]);
      tx.academicYearTimplan.createMany.mockResolvedValue({ count: 3 });

      const rows = await attachDefaultTimplans(tx as never, 'school-1', 'year-1');

      expect(attached(rows)).toEqual([[1, 'plan-f-3'], [2, 'plan-f-3'], [3, 'plan-f-3']]);
    });

    it('attaches nothing when there is no decided plan', async () => {
      tx.localTimplan.findMany.mockResolvedValue([]);
      await expect(attachDefaultTimplans(tx as never, 'school-1', 'year-1')).resolves.toEqual([]);
      expect(tx.academicYearTimplan.createMany).not.toHaveBeenCalled();
    });
  });
});
