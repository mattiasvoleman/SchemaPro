import { describe, expect, it } from "vitest";
import type { ClassStageSummary } from "@/lib/timplan-stage";
import {
  gradeList,
  gradesOfParam,
  listedPupils,
  pupilsInStages,
  stageHours,
  stageTables,
  type StagePupilView,
} from "@/lib/timplan-stage-view";

const row = (studentGroupId: string, stage: ClassStageSummary["stage"], pupils: number, codes: string[]): ClassStageSummary => ({
  studentGroupId,
  stage,
  versionCodes: [],
  pupils,
  completePupils: 0,
  backfilledPupils: 0,
  cells: codes.map((code) => ({
    code,
    nationalHours: null,
    pupils,
    planned: { min: 0, median: 0, max: 0 },
    projected: { min: 0, median: 0, max: 0 },
    belowNational: 0,
    projectedBelowNational: 0,
    unrecordedPupils: 0,
  })),
});

const names: Record<string, string> = { a: "10A", b: "9A", c: "9B", d: "4A" };

describe("the Stadium tab's view", () => {
  it("cuts the overview into one table per stage, by age, classes in name order with numbers read as numbers", () => {
    const tables = stageTables(
      [row("a", "HOG", 20, ["MA"]), row("c", "HOG", 22, ["SV_SVA"]), row("b", "HOG", 21, ["MA", "EN"]), row("d", "LAG_MELLAN", 25, ["HKK"]), row("d", "MELLAN", 25, ["MA"])],
      (id) => names[id]!,
    );
    expect(tables.map((table) => table.stage)).toEqual(["LAG_MELLAN", "MELLAN", "HOG"]);
    const hog = tables[2]!;
    expect(hog.rows.map((entry) => names[entry.studentGroupId])).toEqual(["9A", "9B", "10A"]);
    expect(hog.codes).toEqual(["EN", "MA", "SV_SVA"]);
  });

  it("counts each pupil once, not again for HKK's merged cell", () => {
    expect(pupilsInStages([row("d", "LAG_MELLAN", 25, []), row("d", "MELLAN", 25, []), row("a", "HOG", 20, [])])).toBe(45);
  });

  it("lists the pupils with a warning by name, or the whole class", () => {
    const pupil = (pupilId: string, severity: "warning" | "notice" | null): StagePupilView => ({
      pupilId,
      homeGroupId: "a",
      regime: "PRE_2028",
      cohortStartHT: 2018,
      schoolForm: "GRUNDSKOLA",
      stages: [],
      verdicts:
        severity === null
          ? []
          : [{ code: "TIMPLAN_PUPIL_STAGE_BELOW_NATIONAL", severity, pupilId, params: {}, message: "" }],
    });
    const pupils = [pupil("p3", "warning"), pupil("p1", null), pupil("p2", "notice"), pupil("p0", "warning")];
    const name = (id: string) => ({ p0: "Örjan", p1: "Ada", p2: "Bo", p3: "Åsa" })[id]!;
    expect(listedPupils(pupils, false, name).map((entry) => name(entry.pupilId))).toEqual(["Åsa", "Örjan"]);
    expect(listedPupils(pupils, true, name).map((entry) => name(entry.pupilId))).toEqual(["Ada", "Bo", "Åsa", "Örjan"]);
  });

  it("writes hours and grade lists in the reader's language", () => {
    expect(stageHours(1234.5, "sv")).toBe("1 234,5 h");
    expect(stageHours(409, "en")).toBe("409 h");
    expect(gradeList(gradesOfParam("4, 5, 6"), "sv")).toBe("4, 5 och 6");
    expect(gradeList(gradesOfParam("4, 5"), "en")).toBe("4 and 5");
    expect(gradesOfParam("")).toEqual([]);
  });
});
