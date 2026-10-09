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
      reductionPercent: 0,
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
