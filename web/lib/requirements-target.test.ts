import { describe, expect, it } from "vitest";
import {
  buildTargetView,
  draftHint,
  targetInput,
  toneOf,
  type DraftFields,
  type TargetSources,
} from "@/lib/requirements-target";
import { computePlannedCoverage } from "@/lib/timplan-planned";

/**
 * Mål mode's data layer: the input it assembles from what the matrix holds,
 * the matrix-shaped index over the module's answer, and the dialog hint.
 *
 * The arithmetic itself is lib/timplan-planned.ts's and is held to the
 * gateway by its own contract test; what is pinned here is that this file
 * hands it the right rows and reads the right figure back out — the class of
 * bug where every number is computed correctly for the wrong cell.
 *
 * The läsår is 2026-08-17 (a Monday) to 2027-06-11 (a Friday), no lov, so an
 * all-weeks post is worth its face value per standardvecka and 43 weeks a
 * year: 180 min/vecka is 129 h.
 */

const year = { startDate: "2026-08-17", endDate: "2027-06-11" };

const subjects = [
  { id: "s-ma", name: "Matematik", nationalCode: "MA", countsTowardTimplan: true },
  { id: "s-sv", name: "Svenska", nationalCode: "SV_SVA", countsTowardTimplan: true },
  { id: "s-sva", name: "Svenska som andraspråk", nationalCode: "SV_SVA", countsTowardTimplan: true },
  { id: "s-bi", name: "Bild", nationalCode: "BL", countsTowardTimplan: true },
  { id: "s-mt", name: "Mentorstid", nationalCode: null, countsTowardTimplan: false },
];

const groups = [
  { id: "g-7a", name: "7A", kind: "CLASS" as const, gradeLevel: 7 },
  { id: "g-8a", name: "8A", kind: "CLASS" as const, gradeLevel: 8 },
  { id: "g-9a", name: "9A", kind: "CLASS" as const, gradeLevel: 9 },
  { id: "g-sva7", name: "SvA7", kind: "TEACHING_GROUP" as const, gradeLevel: null },
];

const plans = [
  {
    id: "p-decided",
    name: "Grundskola 2026",
    status: "DECIDED" as const,
    entries: [
      { subjectId: "s-ma", gradeLevel: 7, minutesPerWeek: 175 },
      { subjectId: "s-sv", gradeLevel: 7, minutesPerWeek: 180 },
      { subjectId: "s-sva", gradeLevel: 7, minutesPerWeek: 180 },
      { subjectId: "s-bi", gradeLevel: 7, minutesPerWeek: 60 },
    ],
  },
  {
    id: "p-draft",
    name: "Utkast 2027",
    status: "DRAFT" as const,
    entries: [{ subjectId: "s-ma", gradeLevel: 8, minutesPerWeek: 180 }],
  },
];

const attachments = [
  { gradeLevel: 7, localTimplanId: "p-decided" },
  { gradeLevel: 8, localTimplanId: "p-draft" },
];

const row = (
  id: string,
  studentGroupId: string,
  subjectId: string,
  lessonsPerWeek: number,
  minutesPerLesson: number,
) => ({
  id,
  studentGroupId,
  subjectId,
  lessonsPerWeek,
  minutesPerLesson,
  recurrence: "ALL_WEEKS" as const,
  startDate: null,
  endDate: null,
});

const requirements = [
  // 175 planned as 3 × 60: the generator's own rounding, which is on target.
  row("r-ma7", "g-7a", "s-ma", 3, 60),
  // Svenska carried whole by the class; SvA has no post of its own.
  row("r-sv7", "g-7a", "s-sv", 3, 60),
  // Bild is the short one: 40 of 60.
  row("r-bi7", "g-7a", "s-bi", 1, 40),
  // 8A plans matematik at 4 × 60 against the draft's 180: a lesson over.
  row("r-ma8", "g-8a", "s-ma", 4, 60),
  row("r-sva-group", "g-sva7", "s-sva", 3, 60),
];

const people = [
  { id: "u-1", role: "STUDENT", isActive: true, studentGroupId: "g-7a" },
  { id: "u-2", role: "STUDENT", isActive: true, studentGroupId: "g-7a" },
  { id: "u-gone", role: "STUDENT", isActive: false, studentGroupId: "g-7a" },
  { id: "t-1", role: "TEACHER", isActive: true, studentGroupId: null },
];

const memberships = [{ studentId: "u-2", studentGroupId: "g-sva7" }];

const sources: TargetSources = {
  year,
  closures: [],
  attachments,
  plans,
  subjects,
  groups,
  requirements,
  people,
  memberships,
};

const fields = (overrides: Partial<DraftFields> = {}): DraftFields => ({
  lessonsPerWeek: "3",
  minutesPerLesson: "60",
  recurrence: "ALL_WEEKS",
  startDate: "",
  endDate: "",
  ...overrides,
});

describe("targetInput", () => {
  it("hands the module active pupils only, each with the groups they are a member of", () => {
    const input = targetInput(sources);
    expect(input.pupils).toEqual([
      { id: "u-1", homeGroupId: "g-7a", groupIds: [] },
      { id: "u-2", homeGroupId: "g-7a", groupIds: ["g-sva7"] },
    ]);
    expect(input.includePupils).toBe(true);
    expect(input.requirements.map((entry) => entry.id)).toEqual(requirements.map((entry) => entry.id));
  });
});

describe("buildTargetView", () => {
  const input = targetInput(sources);
  const view = buildTargetView(computePlannedCoverage(input), plans);

  it("reads each cell at its own coordinates, judged on its line", () => {
    expect(view.cell("g-7a", "s-ma")).toEqual({
      planned: 180,
      target: 175,
      delta: 5,
      tone: "met",
      alternative: false,
      partnerSubjectIds: [],
    });
    expect(view.cell("g-7a", "s-bi")).toMatchObject({ planned: 40, target: 60, delta: -20, tone: "under" });
    expect(view.cell("g-8a", "s-ma")).toMatchObject({ planned: 240, target: 180, delta: 60, tone: "over" });
  });

  it("does not call an empty SvA cell a deficit when Svenska meets the shared target", () => {
    expect(view.cell("g-7a", "s-sva")).toEqual({
      planned: 0,
      target: 180,
      delta: 0,
      tone: "met",
      alternative: true,
      partnerSubjectIds: ["s-sv"],
    });
  });

  it("has no cell for a teaching group, a subject outside the timplan, or an unattached class", () => {
    expect(view.cell("g-sva7", "s-sva")).toBeNull();
    expect(view.cell("g-7a", "s-mt")).toBeNull();
    expect(view.summary("g-9a")).toMatchObject({ localTimplanId: null, linesWithTarget: 0 });
  });

  it("counts a class's coverage over its pupils and sums the columns over classes", () => {
    // Matematik and Svenska/SvA reach both pupils; Bild reaches neither.
    expect(view.summary("g-7a")).toMatchObject({ linesWithTarget: 3, linesCovered: 2 });
    expect(view.subjectTotals.get("s-ma")).toEqual({
      planned: 420,
      target: 355,
      plannedHours: 301,
      targetHours: 254.4,
    });
    // SvA is one cell, 7A's own: the teaching group's 180 is not a class's.
    expect(view.subjectTotals.get("s-sva")).toMatchObject({ planned: 0, target: 180 });
    expect(view.total).toEqual({
      planned: 640,
      target: 595,
      plannedHours: 458.7,
      targetHours: 426.4,
    });
  });

  it("names the årskurser without a plan and the plans that are drafts", () => {
    expect(view.unattachedGrades).toEqual([9]);
    expect(view.draftPlans).toEqual([{ id: "p-draft", name: "Utkast 2027", gradeLevels: [8] }]);
    expect(view.emptyPlanGrades).toEqual([]);
  });

  it("names an årskurs whose plan gives it no minutes, instead of a 0/0 that looks covered", () => {
    const empty = buildTargetView(
      computePlannedCoverage({
        year,
        closures: [],
        plans,
        attachments: [{ gradeLevel: 9, localTimplanId: "p-decided" }],
        subjects,
        groups,
        requirements: [],
        pupils: [],
        includePupils: true,
      }),
      plans,
    );
    expect(empty.emptyPlanGrades).toEqual([{ gradeLevel: 9, planName: "Grundskola 2026" }]);
    expect(empty.summary("g-9a")).toMatchObject({ localTimplanId: "p-decided", linesWithTarget: 0 });
  });

  it("maps every status to a tone", () => {
    expect(toneOf("UNPLANNED")).toBe("unplanned");
    expect(toneOf("PUPILS")).toBe("pupils");
    expect(toneOf("NO_TARGET")).toBe("none");
  });
});

describe("draftHint", () => {
  const input = targetInput(sources);

  it("says the target and that 3 × 60 covers 175", () => {
    expect(draftHint(input, "g-7a", "s-ma", fields())).toEqual({
      kind: "target",
      gradeLevel: 7,
      draft: false,
      target: 175,
      planned: 180,
      delta: 5,
      status: "MET",
      lessonsPerWeek: 3,
      minutesPerLesson: 60,
      partnerSubjectIds: [],
    });
  });

  it("follows the fields: the edited post replaces the stored one", () => {
    expect(draftHint(input, "g-7a", "s-ma", fields({ lessonsPerWeek: "2" }))).toMatchObject({
      planned: 120,
      delta: -55,
      status: "UNDER",
    });
    expect(draftHint(input, "g-7a", "s-ma", fields({ lessonsPerWeek: "5" }))).toMatchObject({
      planned: 300,
      status: "OVER",
    });
  });

  it("counts odd weeks by their share of the year, not at face value", () => {
    const hint = draftHint(input, "g-7a", "s-ma", fields({ recurrence: "ODD_WEEKS" }));
    expect(hint).toMatchObject({ status: "UNDER" });
    expect(hint && hint.kind === "target" ? hint.planned : null).toBeLessThan(100);
  });

  it("states the target alone while the fields hold no post the API would take", () => {
    expect(draftHint(input, "g-7a", "s-ma", fields({ lessonsPerWeek: "" }))).toMatchObject({
      kind: "target",
      target: 175,
      planned: null,
      status: null,
    });
    expect(draftHint(input, "g-7a", "s-ma", fields({ minutesPerLesson: "12" }))).toMatchObject({
      planned: null,
    });
  });

  it("judges Svenska with SvA as one line", () => {
    expect(draftHint(input, "g-7a", "s-sva", fields({ lessonsPerWeek: "1" }))).toMatchObject({
      target: 180,
      // Svenska's 180 stays; SvA's 60 joins it on the line.
      planned: 240,
      partnerSubjectIds: ["s-sv"],
    });
  });

  it("marks a draft plan and explains the cells without a target", () => {
    expect(draftHint(input, "g-8a", "s-ma", fields())).toMatchObject({ kind: "target", draft: true });
    expect(draftHint(input, "g-8a", "s-bi", fields())).toEqual({
      kind: "noTarget",
      gradeLevel: 8,
      draft: true,
    });
    expect(draftHint(input, "g-9a", "s-ma", fields())).toEqual({ kind: "noPlan", gradeLevel: 9 });
    expect(draftHint(input, "g-7a", "s-mt", fields())).toEqual({
      kind: "notCounted",
      gradeLevel: 7,
      draft: false,
    });
    expect(draftHint(input, "g-sva7", "s-sva", fields())).toEqual({ kind: "teachingGroup" });
    expect(draftHint(input, "g-unknown", "s-ma", fields())).toBeNull();
  });
});
