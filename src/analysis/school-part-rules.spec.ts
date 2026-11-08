import type { SchoolPartView } from './analysis.types';
import { byGrade, overlapOf, partOfGrade, spanLabel, spansShareGrade } from './school-part-rules';

const part = (id: string, name: string, gradeFrom: number, gradeTo: number): SchoolPartView => ({
  id,
  name,
  account: `40${id}`,
  gradeFrom,
  gradeTo,
});

const LOW = part('1', 'Lågstadiet', 0, 3);
const MID = part('2', 'Mellanstadiet', 4, 6);
const HIGH = part('3', 'Högstadiet', 7, 9);

describe('spansShareGrade and overlapOf', () => {
  it('shares an årskurs when the spans touch at one grade, not when they are next to each other', () => {
    expect(spansShareGrade(LOW, { gradeFrom: 3, gradeTo: 4 })).toBe(true);
    expect(spansShareGrade(LOW, MID)).toBe(false);
    expect(spansShareGrade(MID, LOW)).toBe(false);
    expect(spansShareGrade({ gradeFrom: 5, gradeTo: 5 }, MID)).toBe(true);
  });

  it('names the skoldel already holding an årskurs, and none that is only next to it', () => {
    expect(overlapOf([LOW, MID, HIGH], { gradeFrom: 6, gradeTo: 7 })?.name).toBe('Mellanstadiet');
    expect(overlapOf([LOW, MID, HIGH], { gradeFrom: 4, gradeTo: 6 }, '2')).toBeNull();
    expect(overlapOf([LOW, HIGH], { gradeFrom: 4, gradeTo: 6 })).toBeNull();
    expect(overlapOf([], { gradeFrom: 0, gradeTo: 9 })).toBeNull();
  });
});

describe('partOfGrade', () => {
  const parts = [HIGH, LOW, MID];

  it('finds the skoldel of an årskurs of the nine-year numbering', () => {
    expect(partOfGrade(parts, 0, 'NIOARIG')?.name).toBe('Lågstadiet');
    expect(partOfGrade(parts, 6, 'NIOARIG')?.name).toBe('Mellanstadiet');
    expect(partOfGrade(parts, 9, 'NIOARIG')?.name).toBe('Högstadiet');
  });

  it('reads a tioårig läsår through toNioarig: its åk 8 is the nine-year 7, its åk 1 förskoleklass', () => {
    expect(partOfGrade(parts, 8, 'TIOARIG')?.name).toBe('Högstadiet');
    expect(partOfGrade(parts, 7, 'TIOARIG')?.name).toBe('Mellanstadiet');
    expect(partOfGrade(parts, 1, 'TIOARIG')?.name).toBe('Lågstadiet');
  });

  it('is null for a class without an årskurs and for an årskurs no skoldel holds', () => {
    expect(partOfGrade(parts, null, 'NIOARIG')).toBeNull();
    expect(partOfGrade([LOW], 7, 'NIOARIG')).toBeNull();
    expect(partOfGrade([], 7, 'NIOARIG')).toBeNull();
  });
});

describe('spanLabel and byGrade', () => {
  it('writes förskoleklass as F and a single årskurs alone', () => {
    expect(spanLabel(LOW)).toBe('F–3');
    expect(spanLabel(MID)).toBe('4–6');
    expect(spanLabel({ gradeFrom: 9, gradeTo: 9 })).toBe('9');
    expect(spanLabel({ gradeFrom: 0, gradeTo: 0 })).toBe('F');
  });

  it('orders by årskurs, then by name', () => {
    const twin = part('4', 'Annan', 7, 9);
    expect([HIGH, MID, LOW, twin].sort(byGrade).map((p) => p.name)).toEqual(['Lågstadiet', 'Mellanstadiet', 'Annan', 'Högstadiet']);
  });
});
