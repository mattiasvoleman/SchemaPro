import type { CostCategory, SchoolPartView } from './analysis.types';
import { buildCostBasis, type CostInput } from './cost-basis';
import { MA, audiences, report } from './__fixtures__/school';

const HIGH: SchoolPartView = { id: 'high', name: 'Högstadiet', account: '4030', gradeFrom: 7, gradeTo: 9 };
const MID: SchoolPartView = { id: 'mid', name: 'Mellanstadiet', account: '4020', gradeFrom: 4, gradeTo: 6 };
const RATES = new Map<CostCategory, number>([
  ['TEACHER', 400],
  ['UNQUALIFIED_TEACHER', 300],
  ['SUBSTITUTE', 350],
]);

const basis = (overrides: Partial<CostInput> = {}, reportOverrides: Parameters<typeof report>[0] = {}) =>
  buildCostBasis({
    planned: report(reportOverrides),
    audiences,
    parts: [],
    numbering: 'NIOARIG',
    rates: RATES,
    substitutes: [],
    ...overrides,
  });

const cell = (result: ReturnType<typeof basis>, gradeLevel: number | null) => result.cells.find((row) => row.gradeLevel === gradeLevel)!;
const hoursOf = (userId: string, requirementOrder: number) => report().teachers.find((row) => row.userId === userId)!.assignments[requirementOrder]!.hoursPerYear;

describe('buildCostBasis: where the hours land', () => {
  const result = basis();

  it("shares a row's hours equally over the pupils on it, each share in the årskurs of that pupil's class", () => {
    // MaN is p1 (7A) and p5 (8A): ANNA's and CY's hour is half in each årskurs.
    const planned = report();
    const anna = planned.teachers.find((row) => row.userId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')!;
    const man = anna.assignments.find((row) => row.studentGroupId === 'gman')!.hoursPerYear;
    const seven = anna.assignments.find((row) => row.studentGroupId === 'g7a')!.hoursPerYear;
    const cy = planned.teachers.find((row) => row.userId === 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')!.assignments[0]!.hoursPerYear;
    expect(cell(result, 7).hours.TEACHER).toBeCloseTo(seven + (man + cy) / 2, 1);
  });

  it("charges the hours of a row nobody sits on to the group's own årskurs, and says so", () => {
    // BO's 9A row: no pupil on it.
    expect(cell(result, 9).pupils).toBe(0);
    expect(cell(result, 9).hours.UNQUALIFIED_TEACHER).toBe(hoursOf('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1));
    expect(result.notices).toContainEqual({ code: 'ANALYSIS_ROWS_WITHOUT_PUPILS', params: { rows: 1 } });
  });

  it('puts a teacher whom no behörighet covers in the category of the unqualified, and never counts an hour twice', () => {
    const everything = result.total.hours;
    const assigned = report().teachers.flatMap((row) => row.assignments).reduce((sum, row) => sum + row.hoursPerYear, 0);
    expect(everything.TEACHER + everything.UNQUALIFIED_TEACHER).toBeCloseTo(assigned, 1);
    expect(everything.UNQUALIFIED_TEACHER).toBeCloseTo(hoursOf('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 0) + hoursOf('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1), 1);
    expect(everything.SUBSTITUTE).toBe(0);
  });

  it('treats every teacher as TEACHER, and says so, when the school has recorded no behörighet', () => {
    const none = basis({}, { qualifications: [] });
    expect(none.total.hours.UNQUALIFIED_TEACHER).toBe(0);
    expect(none.notices).toContainEqual({ code: 'ANALYSIS_QUALIFICATIONS_NOT_RECORDED', params: {} });
    expect(none.total.hours.TEACHER).toBeCloseTo(result.total.hours.TEACHER + result.total.hours.UNQUALIFIED_TEACHER, 1);
  });

  it("adds the vikarie's held lessons in clock hours, spread as a row is", () => {
    // 90 minutes of cover in 8A's mathematics: 1.5 hours over two pupils of one årskurs.
    const withCover = basis({ substitutes: [{ studentGroupId: 'g8a', subjectId: MA, minutes: 90 }] });
    expect(withCover.total.hours.SUBSTITUTE).toBe(1.5);
    expect(cell(withCover, 8).hours.SUBSTITUTE).toBe(1.5);
    expect(cell(withCover, 7).hours.SUBSTITUTE).toBe(0);
    // Cover in the mathematics group lands half in each årskurs of its pupils.
    const group = basis({ substitutes: [{ studentGroupId: 'gman', subjectId: MA, minutes: 120 }] });
    expect(cell(group, 7).hours.SUBSTITUTE).toBe(1);
    expect(cell(group, 8).hours.SUBSTITUTE).toBe(1);
  });
});

describe('buildCostBasis: the cost', () => {
  it('prices each category at the school\'s rate and divides by the pupils of the årskurs', () => {
    const result = basis();
    const seven = cell(result, 7);
    const expected = seven.hours.TEACHER * 400 + seven.hours.UNQUALIFIED_TEACHER * 300 + seven.hours.SUBSTITUTE * 350;
    expect(seven.cost).toBeCloseTo(expected, 0);
    expect(seven.pupils).toBe(4);
    expect(seven.costPerPupil).toBeCloseTo(expected / 4, 0);
    expect(seven.hoursPerPupil).toBeCloseTo((seven.hours.TEACHER + seven.hours.UNQUALIFIED_TEACHER) / 4, 1);
  });

  it('has no cost per pupil for an årskurs without pupils, and keeps its hours', () => {
    const nine = cell(basis(), 9);
    expect(nine).toMatchObject({ pupils: 0, hoursPerPupil: null, costPerPupil: null });
    expect(nine.cost).toBeGreaterThan(0);
  });

  it('knows no cost, not a zero one, where a category with hours has no rate', () => {
    const rates = new Map(RATES);
    rates.delete('UNQUALIFIED_TEACHER');
    const result = basis({ rates });
    expect(result.missingRates).toEqual(['UNQUALIFIED_TEACHER']);
    expect(cell(result, 7).cost).toBeNull();
    expect(cell(result, 7).costPerPupil).toBeNull();
    // 8A has only TEACHER hours and is priced.
    expect(cell(result, 8).cost).not.toBeNull();
    expect(result.total.cost).toBeNull();
    expect(result.notices).toContainEqual({ code: 'ANALYSIS_RATE_MISSING', params: { category: 'UNQUALIFIED_TEACHER' } });
  });

  it('does not miss a rate for a category that carries no hours', () => {
    const rates = new Map<CostCategory, number>([['TEACHER', 400], ['UNQUALIFIED_TEACHER', 300]]);
    const result = basis({ rates });
    expect(result.missingRates).toEqual([]);
    expect(result.total.cost).not.toBeNull();
  });

  it('states no rate at all as no cost anywhere', () => {
    const result = basis({ rates: new Map() });
    expect(result.cells.every((row) => row.cost === null)).toBe(true);
    expect(result.missingRates).toEqual(['TEACHER', 'UNQUALIFIED_TEACHER']);
  });
});

describe('buildCostBasis: skoldelar', () => {
  it('groups the årskurser under their skoldel with a subtotal each, in skoldel order, and the rest last', () => {
    const result = basis({ parts: [HIGH, MID] });
    expect(result.cells.map((row) => [row.gradeLevel, row.schoolPartId])).toEqual([
      [7, 'high'],
      [8, 'high'],
      [9, 'high'],
    ]);
    expect(result.parts).toHaveLength(1);
    const part = result.parts[0]!;
    expect(part).toMatchObject({ schoolPartId: 'high', name: 'Högstadiet', account: '4030', pupils: 6 });
    expect(part.hours.TEACHER).toBeCloseTo(result.total.hours.TEACHER, 1);
    expect(part.cost).toBeCloseTo(result.total.cost!, 0);
  });

  it('puts an årskurs no skoldel holds on a line of its own and says which', () => {
    const result = basis({ parts: [{ ...HIGH, gradeFrom: 8 }] });
    expect(result.parts.map((row) => row.schoolPartId)).toEqual(['high', null]);
    expect(result.parts[1]).toMatchObject({ name: null, account: null });
    expect(result.cells.map((row) => [row.gradeLevel, row.schoolPartId])).toEqual([
      [8, 'high'],
      [9, 'high'],
      [7, null],
    ]);
    expect(result.notices).toContainEqual({ code: 'ANALYSIS_GRADES_WITHOUT_PART', params: { grades: '7' } });
  });

  it('says that the school has no skoldel, and then reads per årskurs alone', () => {
    const result = basis();
    expect(result.notices).toContainEqual({ code: 'ANALYSIS_NO_SCHOOL_PARTS', params: {} });
    expect(result.cells.map((row) => row.gradeLevel)).toEqual([7, 8, 9]);
    expect(result.cells.every((row) => row.schoolPartId === null)).toBe(true);
    expect(result.parts).toHaveLength(1);
  });

  it("reads a tioårig läsår's årskurser through the nine-year numbering of the skoldel", () => {
    // In a ten-year läsår åk 8 is the nine-year 7: a 7–9 skoldel holds 8, 9 and 10.
    const result = basis({ parts: [HIGH], numbering: 'TIOARIG' });
    expect(cell(result, 7).schoolPartId).toBeNull();
    expect(cell(result, 8).schoolPartId).toBe('high');
    expect(cell(result, 9).schoolPartId).toBe('high');
  });
});

describe('buildCostBasis: pupils without an årskurs', () => {
  it('keeps pupils and hours that have no årskurs in a cell of their own, last', () => {
    const odd = {
      ...audiences,
      gradeOf: new Map([...audiences.gradeOf, ['p9', null as number | null]]),
      pupilsPerGrade: new Map<number | null, number>([...audiences.pupilsPerGrade, [null, 1]]),
      audienceOf: (groupId: string, subjectId: string) => (groupId === 'gman' ? ['p9'] : audiences.audienceOf(groupId, subjectId)),
    };
    const result = basis({ audiences: odd });
    expect(result.cells[result.cells.length - 1]).toMatchObject({ gradeLevel: null, pupils: 1 });
    expect(result.cells[result.cells.length - 1]!.hours.TEACHER).toBeGreaterThan(0);
  });
});
