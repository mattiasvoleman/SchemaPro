import { describe, expect, it } from "vitest";
import fixture from "../../src/common/__fixtures__/lesson-shares-cases.json";
import {
  MAX_SHARE_LESSONS,
  canonicalShares,
  hasShares,
  lessonTeachersOf,
  sharesProblem,
  teacherIdsOf,
  teacherPartsOf,
  type LessonShare,
  type SharedRow,
} from "@/lib/lesson-shares";

/**
 * Delade lektioner, implemented twice, checked against one list of cases — the
 * web half of src/common/lesson-shares.contract.spec.ts. The fixture was
 * generated from the GATEWAY copy, so this proves the dialog lays a row's
 * lessons out, sums each teacher's part and refuses a share list exactly as
 * the PATCH will. Imported across the package boundary on purpose: one
 * fixture, never two files edited together.
 */
describe("delade lektioner agree with the gateway's fixture", () => {
  it("pins the bound the CHECK and the DTO share", () => {
    expect(fixture.constants).toEqual({ MAX_SHARE_LESSONS });
  });

  it.each(fixture.rows.map((entry) => [entry.name, entry] as const))("row: %s", (_name, entry) => {
    const row = entry.row as SharedRow;
    expect({
      hasShares: hasShares(row),
      parts: teacherPartsOf(row),
      lessons: lessonTeachersOf(row),
      teacherIds: teacherIdsOf(row),
    }).toEqual({ hasShares: entry.hasShares, parts: entry.parts, lessons: entry.lessons, teacherIds: entry.teacherIds });
  });

  it.each(fixture.problems.map((entry) => [entry.name, entry] as const))("problem: %s", (_name, entry) => {
    expect(sharesProblem(entry.row as SharedRow, entry.shares as LessonShare[])).toBe(entry.problem);
  });

  it.each(fixture.canonical.map((entry) => [entry.name, entry] as const))("canonical: %s", (_name, entry) => {
    expect(canonicalShares(entry.shares as LessonShare[])).toEqual(entry.canonical);
  });
});
