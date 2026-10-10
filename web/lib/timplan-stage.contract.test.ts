import { describe, expect, it } from "vitest";
import fixture from "../../src/common/__fixtures__/timplan-stage-cases.json";
import { cohortNotice, type CohortClass, type CohortNoticeRow } from "@/lib/timplan-cohorts";
import type { SchoolForm } from "@/lib/timplan-coverage";
import {
  computePupilStages,
  summarizeClassStages,
  type ClassStageSummary,
  type StageCoverage,
  type StageInput,
} from "@/lib/timplan-stage";

/**
 * Stadiesummor per elev, implemented twice, checked against one list of cases.
 *
 * The gateway answers GET /timplan-stages from src/common/timplan-stage.ts and
 * src/common/timplan-cohorts.ts; the Stadium tab paints an opened class from
 * its drill-down through lib/timplan-stage.ts, and /admin/timplan paints
 * "Timplaner per årskull" through lib/timplan-cohorts.ts. The fixture was
 * GENERATED from the gateway copy (scripts/fixtures/timplan-stage-cases.ts),
 * so this test proves the browser arrives at the same regime, the same
 * version per stage, the same hours to the tenth, the same statuses and
 * verdicts in the same order, and the same class min / median / max — for the
 * spec's 21 cases (a deleted class, a deactivated and reactivated pupil, a
 * repeated grade either side of 2028, an old-cohort pupil at version grade 1
 * in 2028/29, a home class without a grade among them) and the cohort
 * notice's own cases. `toEqual`, not `toBeCloseTo`: every figure is rounded by
 * the arithmetic itself, so a mismatch is a different answer.
 *
 * Imported across the package boundary on purpose, as the other timplan
 * contracts do: one fixture, never two files edited together.
 */

interface FixtureCase {
  name: string;
  input: StageInput;
  coverage: StageCoverage;
  classes: ClassStageSummary[];
}

interface CohortCase {
  name: string;
  schoolForm: SchoolForm;
  classes: CohortClass[];
  versions: Parameters<typeof cohortNotice>[1];
  notice: CohortNoticeRow[];
}

const { cases, cohortCases } = fixture as unknown as { cases: FixtureCase[]; cohortCases: CohortCase[] };

describe("stadiesummor agree with the gateway's fixture", () => {
  it("has the spec's 21 cases, the two boundary cases and the cohort cases, reaching every cell status", () => {
    // 22 and 23 sit on the module's own boundaries — a shortfall of 59, 60
    // and 61 minutes, a grade recorded at 994 and 995 per mille — so a mirror
    // that moves one by a minute or a per mille fails here.
    expect(cases.map((entry) => Number(entry.name.split(".")[0]))).toEqual(
      Array.from({ length: 24 }, (_, i) => i + 1),
    );
    expect(cohortCases.length).toBeGreaterThanOrEqual(2);
    const statuses = new Set(
      cases.flatMap((entry) =>
        entry.coverage.pupils.flatMap((pupil) =>
          pupil.stages.flatMap((stage) => stage.cells.map((cell) => cell.status)),
        ),
      ),
    );
    expect([...statuses].sort()).toEqual(["BELOW", "BELOW_WITHIN_CAP", "MET", "NO_NATIONAL", "UNRECORDED"]);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    const coverage = computePupilStages(entry.input);
    expect(coverage).toEqual(entry.coverage);
    expect(summarizeClassStages(coverage)).toEqual(entry.classes);
  });

  it.each(cohortCases.map((entry) => [entry.name, entry] as const))("the cohort notice: %s", (_name, entry) => {
    expect(cohortNotice(entry.classes, entry.versions, entry.schoolForm)).toEqual(entry.notice);
  });

  it("paints a class from its drill-down exactly as the overview does", () => {
    // The Stadium tab's use: the gateway's class rows are summarizeClassStages
    // over the whole school; an opened class is the same function over that
    // class's pupils alone. Per class, the two must be the same row.
    for (const entry of cases) {
      for (const row of entry.classes) {
        const pupils = entry.coverage.pupils.filter((pupil) => pupil.homeGroupId === row.studentGroupId);
        const own = summarizeClassStages({ asOfDate: entry.coverage.asOfDate, pupils });
        expect(own.find((candidate) => candidate.stage === row.stage)).toEqual(row);
      }
    }
  });
});
