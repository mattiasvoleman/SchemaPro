import fixture from './__fixtures__/grade-numbering-cases.json';
import { fromNioarig, gradeOfPlanRow, lydelseIsTioarig, planRowOf, toNioarig, toNioarigSpan, unitSpanIn, type GradeNumbering } from './grade-numbering';

/**
 * One numbering, implemented twice: web/lib/grade-numbering.ts mirrors this
 * module, and both replay src/common/__fixtures__/grade-numbering-cases.json,
 * GENERATED from this side by scripts/fixtures/grade-numbering-cases.ts. Fix
 * the code and regenerate; never edit the JSON.
 */
const { spans, planRows, lydelser, gradeSpans, unitSpans } = fixture as {
  gradeSpans: { numbering: GradeNumbering; min: number; max: number; toNioarigSpan: { min: number; max: number } | null }[];
  unitSpans: {
    numbering: GradeNumbering;
    gradeFrom: number | null;
    gradeTo: number | null;
    unitSpanIn: { gradeFrom: number; gradeTo: number } | null;
  }[];
  spans: { numbering: GradeNumbering; gradeLevel: number | null; toNioarig: number | null; fromNioarig: number | null }[];
  planRows: { planTioarig: boolean; numbering: GradeNumbering; grade: number; planRowOf: number | null; gradeOfPlanRow: number | null }[];
  lydelser: { term: string; tioarig: boolean }[];
};

describe('the numbering agrees with the shared fixture', () => {
  it('covers every årskurs 0..12 in both numberings', () => {
    expect(spans).toHaveLength(28);
    expect(planRows).toHaveLength(52);
  });

  it.each(spans.map((row) => [`${row.numbering} ${row.gradeLevel}`, row] as const))('span %s', (_name, row) => {
    expect(toNioarig(row.gradeLevel, row.numbering)).toBe(row.toNioarig);
    expect(fromNioarig(row.gradeLevel, row.numbering)).toBe(row.fromNioarig);
  });

  it.each(planRows.map((row) => [`${row.planTioarig ? 'TIOARIG' : 'NIOARIG'} plan, ${row.numbering} ${row.grade}`, row] as const))(
    'plan row %s',
    (_name, row) => {
      expect(planRowOf(row.planTioarig, row.numbering, row.grade)).toBe(row.planRowOf);
      expect(gradeOfPlanRow(row.planTioarig, row.numbering, row.grade)).toBe(row.gradeOfPlanRow);
    },
  );

  it('reads every span of årskurser and every skolenhet span the same way', () => {
    expect(gradeSpans.length).toBeGreaterThan(0);
    for (const row of gradeSpans) expect(toNioarigSpan({ min: row.min, max: row.max }, row.numbering)).toEqual(row.toNioarigSpan);
    expect(unitSpans.length).toBeGreaterThan(0);
    for (const row of unitSpans) {
      expect(unitSpanIn({ gradeFrom: row.gradeFrom, gradeTo: row.gradeTo }, row.numbering)).toEqual(row.unitSpanIn);
    }
  });

  it('reads the lydelser', () => {
    for (const row of lydelser) expect(lydelseIsTioarig(row.term)).toBe(row.tioarig);
  });
});
