/**
 * The school's skolenheter (migration 20261031090000), and which one a class
 * belongs to. The span is the map: a class is the unit's whose
 * gradeFrom..gradeTo holds its årskurs, and spans never overlap within a
 * school.
 *
 *   * no unit: nothing (SCB's SkolenhetsKod stays empty, as before);
 *   * one unit: everything is that unit's;
 *   * several: the unit whose span holds the grade; a grade no span holds,
 *     and what has no grade, is the first unit's.
 *
 * The first unit: lowest gradeFrom (units without a span last), then code
 * (units without one last), then name, then id, by code point.
 * src/school-units/school-unit-map.ts is the same rule in the gateway;
 * school-units.test.ts and school-unit-map.spec.ts hold the same cases.
 */

import type { GradeNumbering } from "@/lib/grade-numbering";

/** S1 SchoolTypesEnum values a unit may hold, in the order SchemaPro lists them. */
export const SCHOOL_UNIT_TYPES = ["FKLASS", "FTH", "GR", "GRS", "TR", "SP", "SAM"] as const;
export type SchoolUnitType = (typeof SCHOOL_UNIT_TYPES)[number];

export interface SchoolUnit {
  id: string;
  name: string;
  code: string | null;
  schoolTypes: SchoolUnitType[];
  gradeFrom: number | null;
  gradeTo: number | null;
  /** Linked to the SS12000 source: name, code and skolformer are the source's. */
  fromSource: boolean;
}

export type UnitSpan = Pick<SchoolUnit, "id" | "name" | "code" | "gradeFrom" | "gradeTo">;

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

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

/**
 * A skolenhet's årskurser in a läsår of `numbering`: as stated in NIOARIG,
 * and in TIOARIG as SFS 2025:729 övergångsbestämmelse 5 reads an approval —
 * the gateway's unitSpanIn (src/common/grade-numbering.ts), replayed from the
 * shared fixture by grade-numbering.contract.test.ts. Here and not in
 * lib/grade-numbering.ts, which every importer bundles whole.
 */
export function unitSpanIn(
  span: { gradeFrom: number | null; gradeTo: number | null },
  numbering: GradeNumbering,
): { gradeFrom: number; gradeTo: number } | null {
  if (span.gradeFrom === null || span.gradeTo === null) return null;
  if (numbering === "NIOARIG") return { gradeFrom: span.gradeFrom, gradeTo: span.gradeTo };
  if (span.gradeTo === 0) return null;
  return { gradeFrom: span.gradeFrom <= 1 ? 1 : span.gradeFrom + 1, gradeTo: span.gradeTo + 1 };
}

/** The unit holding `grade` in a läsår of `numbering` (unitSpanIn, as the gateway's school-unit-map reads it). */
export function unitHolding<T extends UnitSpan>(
  units: readonly T[],
  grade: number | null,
  numbering: GradeNumbering = "NIOARIG",
): T | null {
  if (grade === null) return null;
  return (
    units.find((unit) => {
      const span = unitSpanIn(unit, numbering);
      return span !== null && span.gradeFrom <= grade && grade <= span.gradeTo;
    }) ?? null
  );
}

/** The unit a class (or anything with an årskurs, or none) belongs to; null only when the school has no unit. */
export function unitForGrade<T extends UnitSpan>(
  units: readonly T[],
  grade: number | null,
  numbering: GradeNumbering = "NIOARIG",
): T | null {
  if (units.length <= 1) return units[0] ?? null;
  return unitHolding(units, grade, numbering) ?? firstUnit(units);
}

/** Whether `grade` falls to the first unit only because no span holds it (several units). */
export function gradeOutsideUnits(
  units: readonly UnitSpan[],
  grade: number | null,
  numbering: GradeNumbering = "NIOARIG",
): boolean {
  return units.length > 1 && unitHolding(units, grade, numbering) === null;
}

export function spansOverlap(
  a: Pick<UnitSpan, "gradeFrom" | "gradeTo">,
  b: Pick<UnitSpan, "gradeFrom" | "gradeTo">,
): boolean {
  if (a.gradeFrom === null || a.gradeTo === null || b.gradeFrom === null || b.gradeTo === null) return false;
  return a.gradeFrom <= b.gradeTo && b.gradeFrom <= a.gradeTo;
}

/** Eight digits once the spaces a register prints are dropped; null otherwise. */
export function normaliseUnitCode(value: string): string | null {
  const digits = value.replace(/\s+/g, "");
  return /^[0-9]{8}$/.test(digits) ? digits : null;
}
