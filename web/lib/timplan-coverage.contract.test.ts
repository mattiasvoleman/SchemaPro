import { describe, expect, it } from "vitest";
import fixture from "../../src/common/__fixtures__/timplan-coverage-cases.json";
import {
  checkLocalTimplan,
  planningWeeksInTenths,
  type CoverageEntry,
  type CoverageNationalSubject,
  type CoverageSubject,
  type CoverageVersion,
  type TimplanCheck,
} from "@/lib/timplan-coverage";

/**
 * One verdict document, implemented twice, checked against one list of cases.
 *
 * The gateway answers GET /local-timplans/:id/check and PUT /:id/entries from
 * src/common/timplan-coverage.ts; the grid on /admin/timplan repaints from this
 * mirror while the admin types. If the two drift, a stage sum turns green on a
 * keystroke and the saved plan's rail says "under mål" for the same minutes.
 * The fixture was generated from the GATEWAY copy, so this test proves the web
 * arrives at the same hours to the tenth, the same deficits rounded up, the
 * same verdict codes, severities and params, and the same sort order — for
 * fifteen plans that between them reach every verdict code, every school form,
 * the unpublished 2028 lydelse and an empty plan. `toEqual`, not `toBeCloseTo`:
 * every figure is rounded by the arithmetic itself, so a mismatch is a
 * different answer, not a different ulp.
 *
 * Imported across the package boundary on purpose, as teacher-load.contract
 * does: a copy of the fixture under web/ would be two files that have to be
 * edited together, which is the drift this test exists to catch. The statute
 * is stored once in the fixture and each case names its version by code.
 */

interface FixtureCase {
  name: string;
  versionCode: string;
  planningWeeksTenths: number;
  subjects: CoverageSubject[];
  entries: CoverageEntry[];
  check: TimplanCheck;
}

const { statute, cases } = fixture as unknown as {
  statute: { versions: CoverageVersion[]; nationalSubjects: CoverageNationalSubject[] };
  cases: FixtureCase[];
};

const versionByCode = new Map(statute.versions.map((version) => [version.code, version]));

describe("the timplan check agrees with the gateway's fixture", () => {
  it("has cases to replay, reaching every verdict code", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
    const seen = new Set(cases.flatMap((entry) => entry.check.verdicts.map((v) => v.code)));
    expect(seen.size).toBe(8);
    expect(cases.some((entry) => !entry.check.distributionPublished)).toBe(true);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    expect(
      checkLocalTimplan({
        planningWeeksTenths: entry.planningWeeksTenths,
        version: versionByCode.get(entry.versionCode)!,
        nationalSubjects: statute.nationalSubjects,
        subjects: entry.subjects,
        entries: entry.entries,
      }),
    ).toEqual(entry.check);
  });
});

describe("planningWeeksInTenths reads what the browser holds", () => {
  it("takes the number a form or the API hands over, and the string PostgREST renders", () => {
    expect(planningWeeksInTenths(35.6)).toBe(356);
    expect(planningWeeksInTenths("35.6")).toBe(356);
    expect(planningWeeksInTenths("40.0")).toBe(400);
    expect(planningWeeksInTenths(20)).toBe(200);
  });

  it("refuses a value it would otherwise have to guess at, rather than reading it as 0", () => {
    expect(() => planningWeeksInTenths("")).toThrow();
    expect(() => planningWeeksInTenths("35.65")).toThrow();
    expect(() => planningWeeksInTenths(19.9)).toThrow();
    expect(() => planningWeeksInTenths(40.1)).toThrow();
    expect(() => planningWeeksInTenths("35,6")).toThrow();
  });
});
