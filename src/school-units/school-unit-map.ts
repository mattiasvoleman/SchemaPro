import type { SchoolUnitType } from '@prisma/client';

/**
 * Which skolenhet something belongs to (migration 20261031090000). The span
 * is the map: a class is the unit's whose gradeFrom..gradeTo holds its
 * gradeLevel, and spans never overlap within a school (SU409).
 *
 *   * no unit: nothing (the caller does what it did before skolenheter);
 *   * one unit: everything is that unit's;
 *   * several: the unit whose span holds the grade; a grade no span holds,
 *     and what has no grade (a room, an undervisningsgrupp without one),
 *     is the first unit's.
 *
 * The first unit: lowest gradeFrom (units without a span last), then code
 * (units without one last), then name, then id, each compared by code
 * point so the order is the same wherever it is computed. web/lib/school-units.ts
 * is the same rule; school-unit-map.spec.ts and its web twin hold the same
 * cases.
 */

/** S1 SchoolTypesEnum values a unit may hold, in the order SchemaPro lists them. */
export const SCHOOL_UNIT_TYPES: readonly SchoolUnitType[] = ['FKLASS', 'FTH', 'GR', 'GRS', 'TR', 'SP', 'SAM'];

export interface UnitSpan {
  id: string;
  name: string;
  code: string | null;
  gradeFrom: number | null;
  gradeTo: number | null;
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The order units are listed and the first unit is taken in. */
export function compareUnits(a: UnitSpan, b: UnitSpan): number {
  if (a.gradeFrom !== b.gradeFrom) {
    if (a.gradeFrom === null) return 1;
    if (b.gradeFrom === null) return -1;
    return a.gradeFrom - b.gradeFrom;
  }
  if (a.code !== b.code) {
    if (a.code === null) return 1;
    if (b.code === null) return -1;
    return byCodePoint(a.code, b.code);
  }
  return byCodePoint(a.name, b.name) || byCodePoint(a.id, b.id);
}

export function firstUnit<T extends UnitSpan>(units: readonly T[]): T | null {
  return units.length === 0 ? null : [...units].sort(compareUnits)[0]!;
}

/** The unit whose span holds `grade`, if one does. */
export function unitHolding<T extends UnitSpan>(units: readonly T[], grade: number | null): T | null {
  if (grade === null) return null;
  return units.find((unit) => unit.gradeFrom !== null && unit.gradeTo !== null && unit.gradeFrom <= grade && grade <= unit.gradeTo) ?? null;
}

/** The unit a class (or anything with an årskurs, or none) belongs to; null only when the school has no unit. */
export function unitForGrade<T extends UnitSpan>(units: readonly T[], grade: number | null): T | null {
  if (units.length <= 1) return units[0] ?? null;
  return unitHolding(units, grade) ?? firstUnit(units);
}

/** Whether `grade` falls to the first unit only because no span holds it (several units). */
export function gradeOutsideUnits(units: readonly UnitSpan[], grade: number | null): boolean {
  return units.length > 1 && unitHolding(units, grade) === null;
}

/** Whether two spans share an årskurs. */
export function spansOverlap(a: Pick<UnitSpan, 'gradeFrom' | 'gradeTo'>, b: Pick<UnitSpan, 'gradeFrom' | 'gradeTo'>): boolean {
  if (a.gradeFrom === null || a.gradeTo === null || b.gradeFrom === null || b.gradeTo === null) return false;
  return a.gradeFrom <= b.gradeTo && b.gradeFrom <= a.gradeTo;
}

/** Skolenhetskoder are eight digits; spaces a register print puts in are dropped. Null when not one. */
export function normaliseUnitCode(value: string): string | null {
  const digits = value.replace(/\s+/g, '');
  return /^[0-9]{8}$/.test(digits) ? digits : null;
}

/** The types once each, in SCHOOL_UNIT_TYPES order. */
export function normaliseUnitTypes(types: readonly SchoolUnitType[]): SchoolUnitType[] {
  return SCHOOL_UNIT_TYPES.filter((type) => types.includes(type));
}
