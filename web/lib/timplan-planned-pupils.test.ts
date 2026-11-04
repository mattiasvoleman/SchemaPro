import { describe, expect, it } from "vitest";
import { linesUnderTarget, shownPupils, sourceKindOf } from "@/lib/timplan-planned-pupils";
import type { PlannedClassPupil, PlannedPupilFigure } from "@/lib/timplan-tackning";

const line = (status: PlannedPupilFigure["status"], key = "subject:ma"): PlannedPupilFigure => ({
  key,
  alternativeCode: null,
  subjectIds: ["ma"],
  targetMinutesPerWeek: 180,
  plannedMinutesPerWeek: status === "UNDER" ? 120 : 180,
  deltaMinutesPerWeek: status === "UNDER" ? -60 : 0,
  status,
  sources: [],
  doublePlannedSubjectIds: [],
  alternativeSubjectIds: [],
});
const pupil = (pupilId: string, lines: PlannedPupilFigure[] = []): PlannedClassPupil => ({
  pupilId,
  homeGroupId: "c",
  gradeLevel: 8,
  lines,
});

describe("sourceKindOf", () => {
  it("tells a class, a half, a replacing group and a teaching group apart, and a group it does not hold", () => {
    expect(sourceKindOf({ kind: "CLASS" })).toBe("class");
    expect(sourceKindOf({ kind: "TEACHING_GROUP", halfOfId: "c" })).toBe("half");
    expect(sourceKindOf({ kind: "TEACHING_GROUP", replacesSubjectId: "sv" })).toBe("replacing");
    expect(sourceKindOf({ kind: "TEACHING_GROUP", halfOfId: null, replacesSubjectId: null })).toBe("teaching");
    expect(sourceKindOf({ kind: "TEACHING_GROUP" })).toBe("teaching");
    expect(sourceKindOf(undefined)).toBeNull();
  });

  it("calls a half a half before it is anything else", () => {
    expect(sourceKindOf({ kind: "TEACHING_GROUP", halfOfId: "c", replacesSubjectId: "sv" })).toBe("half");
  });
});

describe("linesUnderTarget", () => {
  it("keeps the lines under target, not those met or without a target", () => {
    const lines = [line("MET", "a"), line("UNDER", "b"), line("NO_TARGET", "c"), line("UNDER", "d")];
    expect(linesUnderTarget(pupil("p", lines)).map((entry) => entry.key)).toEqual(["b", "d"]);
    expect(linesUnderTarget(pupil("p"))).toEqual([]);
  });
});

describe("shownPupils", () => {
  const people = [
    { id: "p1", firstName: "Bo", lastName: "Andersson" },
    { id: "p2", firstName: "Ada", lastName: "Öberg" },
    { id: "p3", firstName: "Åsa", lastName: "Nilsson" },
    { id: "p4", firstName: "Cia", lastName: "Andersson" },
  ];
  const all = ["p2", "ghost", "p4", "p1", "p3"].map((id) => pupil(id));

  it("orders by surname, then given name, in Swedish order, and a pupil the roster lacks last", () => {
    expect(shownPupils(all, people, "").map((entry) => entry.pupilId)).toEqual(["p1", "p4", "p3", "p2", "ghost"]);
  });

  it("filters by name, any term in any order, case-insensitively, and does not fold å and ö into a and o", () => {
    expect(shownPupils(all, people, "andersson").map((entry) => entry.pupilId)).toEqual(["p1", "p4"]);
    expect(shownPupils(all, people, "cia and").map((entry) => entry.pupilId)).toEqual(["p4"]);
    expect(shownPupils(all, people, "ada").map((entry) => entry.pupilId)).toEqual(["p2"]);
    expect(shownPupils(all, people, "oberg")).toEqual([]);
    expect(shownPupils(all, people, "Öberg").map((entry) => entry.pupilId)).toEqual(["p2"]);
  });

  it("matches a pupil the roster lacks with nothing but an empty filter, and leaves the input alone", () => {
    expect(shownPupils(all, people, "ghost")).toEqual([]);
    expect(shownPupils(all, people, "  ").map((entry) => entry.pupilId)).toContain("ghost");
    expect(all.map((entry) => entry.pupilId)).toEqual(["p2", "ghost", "p4", "p1", "p3"]);
  });
});
