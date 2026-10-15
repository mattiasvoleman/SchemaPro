import { describe, expect, it } from "vitest";
import { compareYears } from "./staffing-compare";
import type { TeacherLoad } from "./teacher-load";

const load = (userId: string, overrides: Partial<TeacherLoad> = {}): TeacherLoad => ({
  userId,
  employment: {
    userId,
    employmentPercent: 100,
    reductionPercent: 0,
    contractKind: "FERIE",
    teachingTargetMinutesPerWeek: null,
    signature: null,
  },
  targetMinutesPerWeek: 1080,
  assignedMinutesPerWeek: 900,
  peakMinutesPerWeek: 900,
  dutyMinutesPerWeek: 60,
  countedDutyMinutesPerWeek: 60,
  countedMinutesPerWeek: 960,
  balanceMinutesPerWeek: 120,
  percentOfTarget: 88.9,
  status: "UNDER",
  requirementCount: 3,
  dutyCount: 1,
  subjects: [],
  assignments: [],
  annual: {
    assignedHoursPerYear: 600,
    regulatedHoursPerYear: 1360,
    workDaysPerYear: 194,
    contractKind: "FERIE",
    annualHours: null,
    unregulatedHoursPerYear: null,
    semesterHoursPerWeek: null,
    dutyHoursPerYear: 0,
    teachingWeeksPerYear: 38,
    percentOfRegulated: null,
  },
  ...overrides,
});

describe("compareYears", () => {
  it("is the union of both years' teachers, so who left and who is new are rows", () => {
    const rows = compareYears([load("t-b"), load("t-new")], [load("t-b"), load("t-gone")]);
    expect(rows.map((row) => [row.userId, row.change])).toEqual([
      ["t-b", "SAME"],
      ["t-gone", "LEFT"],
      ["t-new", "NEW"],
    ]);
    const gone = rows.find((row) => row.userId === "t-gone")!;
    expect(gone.thisYear).toBeNull();
    expect(gone.countedDelta).toBeNull();
    expect(gone.lastYear?.countedMinutesPerWeek).toBe(960);
  });

  it("compares a post that changes during the year by where it starts, and keeps its steps", () => {
    const stretch = (from: string, to: string, employmentPercent: number, reductionPercent = 0) =>
      ({ from, to, employmentPercent, reductionPercent }) as NonNullable<TeacherLoad["periods"]>[number];
    const [row] = compareYears(
      // 100 % on the first day this year too, 50 % from January.
      [load("t-b", { periods: [stretch("2026-08-17", "2027-01-10", 100), stretch("2027-01-11", "2027-06-11", 50, 10)] })],
      [load("t-b")],
    );
    expect(row!.thisYear).toMatchObject({ employmentPercent: 100, employmentSteps: [100, 50], reductionPercent: 0 });
    expect(row!.lastYear).toMatchObject({ employmentPercent: 100, employmentSteps: [100] });
    expect(row!.employmentDelta).toBe(0);
    expect(row!.reductionChanged).toBe(false);
    // The year starts the same, but the post halves in January: a change, so "Visa bara ändrade" keeps it.
    expect(row!.change).toBe("CHANGED");
  });

  it("marks a post whose grad and nedsättning change in another order, so the row can show it", () => {
    const stretch = (from: string, to: string, employmentPercent: number, reductionPercent = 0) =>
      ({ from, to, employmentPercent, reductionPercent }) as NonNullable<TeacherLoad["periods"]>[number];
    // Last year the grad went first (80 % from January, then a nedsättning from March); this year the nedsättning.
    const gradFirst = load("t-b", {
      periods: [stretch("2025-08-18", "2026-01-11", 100), stretch("2026-01-12", "2026-03-01", 80), stretch("2026-03-02", "2026-06-12", 80, 20)],
    });
    const reductionFirst = load("t-b", {
      periods: [stretch("2026-08-17", "2027-01-10", 100), stretch("2027-01-11", "2027-02-28", 100, 20), stretch("2027-03-01", "2027-06-11", 80, 20)],
    });
    const [row] = compareYears([reductionFirst], [gradFirst]);
    expect(row!.change).toBe("CHANGED");
    // Each projection alone reads the same both years…
    expect(row!.thisYear!.employmentSteps).toEqual(row!.lastYear!.employmentSteps);
    expect(row!.thisYear!.reductionSteps).toEqual(row!.lastYear!.reductionSteps);
    // …so the row says it is the order, with the steps together.
    expect(row!.stepsInAnotherOrder).toBe(true);
    expect(row!.thisYear!.stretchSteps).toEqual([
      { employmentPercent: 100, reductionPercent: 0 },
      { employmentPercent: 100, reductionPercent: 20 },
      { employmentPercent: 80, reductionPercent: 20 },
    ]);
    // A post that differs in a projection shows that projection, not the combined steps.
    const [halving] = compareYears([reductionFirst], [load("t-b")]);
    expect(halving!.stepsInAnotherOrder).toBe(false);
  });

  it("calls a nedsättning from January a change, and the same changing post in both years none", () => {
    const stretch = (from: string, to: string, employmentPercent: number, reductionPercent = 0) =>
      ({ from, to, employmentPercent, reductionPercent }) as NonNullable<TeacherLoad["periods"]>[number];
    const unionTime = load("t-b", {
      periods: [stretch("2026-08-17", "2027-01-10", 100), stretch("2027-01-11", "2027-06-11", 100, 20)],
    });
    const [union] = compareYears([unionTime], [load("t-b")]);
    expect(union!.change).toBe("CHANGED");
    // What the row shows for it: the nedsättning's steps, the year starting as last year did.
    expect(union!.thisYear).toMatchObject({ reductionPercent: 0, reductionSteps: [0, 20], employmentSteps: [100] });
    expect(union!.lastYear!.reductionSteps).toEqual([0]);
    expect(union!.reductionChanged).toBe(false);
    const halving = (from: string, to: string, spring: string) =>
      load("t-b", { periods: [stretch(from, to, 100), stretch(spring, "2027-06-11", 50)] });
    expect(
      compareYears([halving("2026-08-17", "2027-01-10", "2027-01-11")], [halving("2025-08-18", "2026-01-11", "2026-01-12")])[0]!
        .change,
    ).toBe("SAME");
  });

  it("subtracts this year from last: counted minutes and tjänst %", () => {
    const [row] = compareYears(
      [
        load("t-b", {
          countedMinutesPerWeek: 840,
          employment: { ...load("t-b").employment!, employmentPercent: 80 },
        }),
      ],
      [load("t-b")],
    );
    expect(row).toMatchObject({ countedDelta: -120, employmentDelta: -20, change: "CHANGED" });
    expect(row!.thisYear).toEqual({
      employmentPercent: 80,
      employmentSteps: [80],
      reductionPercent: 0,
      reductionSteps: [0],
      postSteps: ["80000/0"],
      stretchSteps: [{ employmentPercent: 80, reductionPercent: 0 }],
      countedMinutesPerWeek: 840,
      percentOfTarget: 88.9,
    });
  });

  it("counts a nedsättning that changed as a change, and a target that moved alone as none", () => {
    const reduced = load("t-b", { employment: { ...load("t-b").employment!, reductionPercent: 20 } });
    expect(compareYears([reduced], [load("t-b")])[0]!).toMatchObject({ change: "CHANGED", reductionChanged: true });
    // A changed row says what changed: the nedsättning has no column of its own.
    expect(compareYears([load("t-b")], [load("t-b")])[0]!.reductionChanged).toBe(false);
    // The school's riktmärke moved: the teacher's own figures did not.
    expect(compareYears([load("t-b", { percentOfTarget: 95 })], [load("t-b")])[0]!.change).toBe("SAME");
  });

  it("has no tjänst % delta when either year has no post, and still compares the minutes", () => {
    const [row] = compareYears([load("t-b", { employment: null })], [load("t-b")]);
    expect(row).toMatchObject({ employmentDelta: null, countedDelta: 0, change: "CHANGED" });
    expect(row!.thisYear?.employmentPercent).toBeNull();
  });

  it("does not call three-decimal noise a change", () => {
    const [row] = compareYears(
      [load("t-b", { employment: { ...load("t-b").employment!, employmentPercent: 66.6670001 } })],
      [load("t-b", { employment: { ...load("t-b").employment!, employmentPercent: 66.667 } })],
    );
    expect(row!.change).toBe("SAME");
    expect(row!.employmentDelta).toBe(0);
  });
});
