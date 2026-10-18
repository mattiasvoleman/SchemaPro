import { describe, expect, it } from "vitest";
import {
  compareUnits,
  firstUnit,
  gradeOutsideUnits,
  normaliseUnitCode,
  spansOverlap,
  unitForGrade,
  unitHolding,
  type UnitSpan,
} from "./school-units";

/*
 * The same cases as the gateway's src/school-units/school-unit-map.spec.ts:
 * the web places a class (the Klasser card, the SCB file) and the provider
 * places it (SS12000) by one rule.
 */
const unit = (id: string, gradeFrom: number | null, gradeTo: number | null, code: string | null = null, name = id): UnitSpan => ({
  id,
  name,
  code,
  gradeFrom,
  gradeTo,
});

describe("skolenheter", () => {
  const f6 = unit("f6", 0, 6, "11111111");
  const u79 = unit("u79", 7, 9, "22222222");
  const fritids = unit("fth", null, null, "33333333");

  it("places nothing without a unit, everything in a single one, and by årskurs among several", () => {
    expect(unitForGrade([], 7)).toBeNull();
    expect(unitForGrade([u79], 3)).toBe(u79);
    expect(unitForGrade([u79], null)).toBe(u79);
    expect(unitForGrade([u79, f6], 0)).toBe(f6);
    expect(unitForGrade([u79, f6], 6)).toBe(f6);
    expect(unitForGrade([u79, f6], 7)).toBe(u79);
  });

  it("gives a grade no span holds, and no grade, to the first unit, and says so for a grade", () => {
    expect(unitForGrade([u79, f6, fritids], 10)).toBe(f6);
    expect(unitForGrade([u79, f6, fritids], null)).toBe(f6);
    expect(gradeOutsideUnits([u79, f6], 10)).toBe(true);
    expect(gradeOutsideUnits([u79, f6], 9)).toBe(false);
    expect(gradeOutsideUnits([u79], 10)).toBe(false);
  });

  // A unit's span is stated in the nine-year numbering for good. A tioårig
  // läsår (SFS 2025:729) reads it as övergångsbestämmelse 5 reads an
  // approval: one årskurs up, an approval from åk 1 also for the new åk 1.
  it("places a tioårig läsår by the span read one up: F–6 holds 1–7, 7–9 holds 8–10", () => {
    expect(unitForGrade([u79, f6], 1, "TIOARIG")).toBe(f6);
    expect(unitForGrade([u79, f6], 7, "TIOARIG")).toBe(f6);
    expect(unitForGrade([u79, f6], 8, "TIOARIG")).toBe(u79);
    expect(unitForGrade([u79, f6], 10, "TIOARIG")).toBe(u79);
    expect(gradeOutsideUnits([u79, f6], 7, "TIOARIG")).toBe(false);
    expect(gradeOutsideUnits([u79, f6], 10, "TIOARIG")).toBe(false);
    // Past the top, and the åk 0 a tioårig läsår has none of: no span holds it.
    expect(gradeOutsideUnits([u79, f6], 11, "TIOARIG")).toBe(true);
    expect(gradeOutsideUnits([u79, f6], 0, "TIOARIG")).toBe(true);
  });

  it("gives a tioårig läsår’s new åk 1 to the 1–6 unit, and nothing to one for förskoleklass alone", () => {
    const fk = unit("fk", 0, 0, "44444444");
    const u16 = unit("u16", 1, 6, "55555555");
    expect(unitForGrade([u16, fk], 1, "TIOARIG")).toBe(u16);
    expect(unitForGrade([u16, fk], 7, "TIOARIG")).toBe(u16);
    expect(unitHolding([u16, fk], 0, "TIOARIG")).toBeNull();
    expect(gradeOutsideUnits([u16, fk], 1, "TIOARIG")).toBe(false);
    // Nine-year, as before: F is the förskoleklass unit's, 1 the 1–6 unit's.
    expect(unitForGrade([u16, fk], 0, "NIOARIG")).toBe(fk);
    expect(unitForGrade([u16, fk], 1, "NIOARIG")).toBe(u16);
    expect(unitHolding([u16, fk], 7, "NIOARIG")).toBeNull();
  });

  it("keeps the first unit the nine-year one in a tioårig läsår, for no grade and a grade no span holds", () => {
    // F alone holds nothing in a tioårig läsår, and is still the first unit.
    const fk = unit("fk", 0, 0, "44444444");
    const u16 = unit("u16", 1, 6, "55555555");
    expect(unitForGrade([u16, fk], null, "TIOARIG")).toBe(fk);
    expect(unitForGrade([u16, fk], 9, "TIOARIG")).toBe(fk);
    expect(unitForGrade([u79, f6, fritids], null, "TIOARIG")).toBe(f6);
    expect(unitForGrade([u79, f6, fritids], 11, "TIOARIG")).toBe(f6);
    // A single unit holds everything in either numbering.
    expect(unitForGrade([fk], 1, "TIOARIG")).toBe(fk);
    expect(gradeOutsideUnits([fk], 1, "TIOARIG")).toBe(false);
  });

  it("places a nine-year läsår named NIOARIG exactly as one with no numbering", () => {
    for (const grade of [null, 0, 1, 6, 7, 9, 10]) {
      expect(unitForGrade([u79, f6, fritids], grade, "NIOARIG")).toBe(unitForGrade([u79, f6, fritids], grade));
      expect(gradeOutsideUnits([u79, f6], grade, "NIOARIG")).toBe(gradeOutsideUnits([u79, f6], grade));
    }
    expect(unitForGrade([u79, f6], 7, "NIOARIG")).toBe(u79);
    expect(unitForGrade([u79, f6], 0, "NIOARIG")).toBe(f6);
    expect(gradeOutsideUnits([u79, f6], 10, "NIOARIG")).toBe(true);
  });

  it("orders by first grade, units without a span last, then code, name and id by code point", () => {
    expect([fritids, u79, f6].sort(compareUnits).map((u) => u.id)).toEqual(["f6", "u79", "fth"]);
    expect(firstUnit([unit("b", null, null, null, "Ö"), unit("a", null, null, null, "Z")])!.id).toBe("a");
    expect(firstUnit([unit("b", 1, 3, null), unit("a", 1, 3, "99999999")])!.id).toBe("a");
    expect(firstUnit([unit("b", 1, 3, null, "x"), unit("a", 1, 3, null, "x")])!.id).toBe("a");
  });

  it("calls spans sharing an årskurs overlapping, and a unit without one overlapping nothing", () => {
    expect(spansOverlap(f6, unit("x", 6, 9))).toBe(true);
    expect(spansOverlap(f6, u79)).toBe(false);
    expect(spansOverlap(fritids, f6)).toBe(false);
  });

  it("takes a skolenhetskod as eight digits, spaces dropped", () => {
    expect(normaliseUnitCode("1234 5678")).toBe("12345678");
    expect(normaliseUnitCode("1234567")).toBeNull();
    expect(normaliseUnitCode("1234567a")).toBeNull();
  });
});
