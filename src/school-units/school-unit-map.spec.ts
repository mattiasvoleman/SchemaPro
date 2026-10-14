import {
  compareUnits,
  firstUnit,
  gradeOutsideUnits,
  normaliseUnitCode,
  normaliseUnitTypes,
  spansOverlap,
  unitForGrade,
  type UnitSpan,
} from './school-unit-map';

/*
 * The same cases as web/lib/school-units.test.ts: the provider places a class
 * (SS12000) and the web places it (the Klasser card, the SCB file) by one rule.
 */
const unit = (id: string, gradeFrom: number | null, gradeTo: number | null, code: string | null = null, name = id): UnitSpan => ({
  id,
  name,
  code,
  gradeFrom,
  gradeTo,
});

describe('skolenheter', () => {
  const f6 = unit('f6', 0, 6, '11111111');
  const u79 = unit('u79', 7, 9, '22222222');
  const fritids = unit('fth', null, null, '33333333');

  it('places nothing without a unit, everything in a single one, and by årskurs among several', () => {
    expect(unitForGrade([], 7)).toBeNull();
    expect(unitForGrade([u79], 3)).toBe(u79);
    expect(unitForGrade([u79], null)).toBe(u79);
    expect(unitForGrade([u79, f6], 0)).toBe(f6);
    expect(unitForGrade([u79, f6], 6)).toBe(f6);
    expect(unitForGrade([u79, f6], 7)).toBe(u79);
  });

  it('gives a grade no span holds, and no grade, to the first unit, and says so for a grade', () => {
    expect(unitForGrade([u79, f6, fritids], 10)).toBe(f6);
    expect(unitForGrade([u79, f6, fritids], null)).toBe(f6);
    expect(gradeOutsideUnits([u79, f6], 10)).toBe(true);
    expect(gradeOutsideUnits([u79, f6], 9)).toBe(false);
    expect(gradeOutsideUnits([u79], 10)).toBe(false);
  });

  it('orders by first grade, units without a span last, then code, name and id by code point', () => {
    expect([fritids, u79, f6].sort(compareUnits).map((u) => u.id)).toEqual(['f6', 'u79', 'fth']);
    expect(firstUnit([unit('b', null, null, null, 'Ö'), unit('a', null, null, null, 'Z')])!.id).toBe('a');
    expect(firstUnit([unit('b', 1, 3, null), unit('a', 1, 3, '99999999')])!.id).toBe('a');
    expect(firstUnit([unit('b', 1, 3, null, 'x'), unit('a', 1, 3, null, 'x')])!.id).toBe('a');
  });

  it('calls spans sharing an årskurs overlapping, and a unit without one overlapping nothing', () => {
    expect(spansOverlap(f6, unit('x', 6, 9))).toBe(true);
    expect(spansOverlap(f6, u79)).toBe(false);
    expect(spansOverlap(fritids, f6)).toBe(false);
  });

  it('takes a skolenhetskod as eight digits, spaces dropped, and each skolform once in order', () => {
    expect(normaliseUnitCode('1234 5678')).toBe('12345678');
    expect(normaliseUnitCode('1234567')).toBeNull();
    expect(normaliseUnitCode('1234567a')).toBeNull();
    expect(normaliseUnitTypes(['GR', 'FKLASS', 'GR'])).toEqual(['FKLASS', 'GR']);
  });
});
