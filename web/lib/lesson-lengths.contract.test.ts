import { describe, expect, it } from "vitest";
import fixture from "../../src/common/__fixtures__/lesson-lengths-cases.json";
import {
  LESSON_GRID_MINUTES,
  LESSON_MAX_MINUTES,
  LESSON_MIN_MINUTES,
  MAX_DISTINCT_LENGTHS,
  MAX_LESSONS_PER_WEEK,
  canonicalShape,
  isMixed,
  lengthPartsOf,
  lengthsProblem,
  lessonCountOf,
  lessonMinutesOf,
  longestLessonOf,
  shapeFromParts,
  shortestLessonOf,
  weeklyMinutesOf,
  type LengthPart,
  type LessonShape,
} from "@/lib/lesson-lengths";

/**
 * Lektionslängder, implemented twice, checked against one list of cases — the
 * web half of src/common/lesson-lengths.contract.spec.ts.
 *
 * If the two copies drift, the Timplansposter matrix says 160 minutes for
 * 1 × 80 + 1 × 40 while GET /timplan-coverage and the staffing report say 120
 * for the same row. The fixture was generated from the GATEWAY copy, so this
 * proves the browser arrives at the same counts, minutes, parts, canonical
 * rows and problems. The constants block is asserted here too: a grid or a
 * bound that moves on one side alone fails a test, not a solve.
 *
 * Imported across the package boundary on purpose, as the timplan-planned
 * contract does: one fixture, never two files edited together. A lessonsPerWeek
 * of "NaN" in the fixture is JSON's spelling of a half-typed form field.
 */

type FixtureShape = Omit<LessonShape, "lessonsPerWeek"> & { lessonsPerWeek: number | "NaN" };

const shapeOf = (row: FixtureShape): LessonShape => ({
  ...row,
  lessonsPerWeek: row.lessonsPerWeek === "NaN" ? Number.NaN : row.lessonsPerWeek,
});

describe("lektionslängder agree with the gateway's fixture", () => {
  it("pins the bounds the engine, the CHECK and the gateway share", () => {
    expect(fixture.constants).toEqual({
      LESSON_MIN_MINUTES,
      LESSON_MAX_MINUTES,
      LESSON_GRID_MINUTES,
      MAX_LESSONS_PER_WEEK,
      MAX_DISTINCT_LENGTHS,
    });
  });

  it("reaches uniform and split rows, every problem and the null answer", () => {
    expect(fixture.rows.some((c) => c.isMixed)).toBe(true);
    expect(fixture.rows.some((c) => !c.isMixed)).toBe(true);
    expect(new Set(fixture.problems.map((c) => c.problem)).size).toBe(7);
  });

  it.each(fixture.rows.map((entry) => [entry.name, entry] as const))("row: %s", (_name, entry) => {
    const row = shapeOf(entry.row as FixtureShape);
    expect({
      isMixed: isMixed(row),
      lessonCount: lessonCountOf(row),
      lessonMinutes: lessonMinutesOf(row),
      weeklyMinutes: weeklyMinutesOf(row),
      shortest: shortestLessonOf(row),
      longest: longestLessonOf(row),
      parts: lengthPartsOf(row),
    }).toEqual({
      isMixed: entry.isMixed,
      lessonCount: entry.lessonCount,
      lessonMinutes: entry.lessonMinutes,
      weeklyMinutes: entry.weeklyMinutes,
      shortest: entry.shortest,
      longest: entry.longest,
      parts: entry.parts,
    });
  });

  it.each(fixture.canonical.map((entry) => [entry.name, entry] as const))(
    "canonical: %s",
    (_name, entry) => {
      expect(canonicalShape(entry.lengths)).toEqual(entry.shape);
    },
  );

  it.each(fixture.parts.map((entry) => [entry.name, entry] as const))("parts: %s", (_name, entry) => {
    expect(shapeFromParts(entry.parts as LengthPart[])).toEqual(entry.shape);
  });

  it.each(fixture.problems.map((entry) => [entry.name, entry] as const))(
    "problem: %s",
    (_name, entry) => {
      expect(lengthsProblem(entry.lengths)).toBe(entry.problem);
    },
  );
});
