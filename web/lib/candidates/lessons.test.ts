import { describe, expect, it } from "vitest";
import { candidateWeek, clockOf, currentWeek, isPreserved, replacedLessons, type OriginMaster } from "./lessons";
import type { CandidateLesson } from "./types";

function master(overrides: Partial<OriginMaster> = {}): OriginMaster {
  return {
    id: "m-1",
    academicYearId: "y-1",
    subjectId: "s-ma",
    studentGroupId: "g-7a",
    teacherId: "t-1",
    coTeacherId: null,
    roomId: "r-1",
    dayOfWeek: 1,
    startTime: "08:00:00",
    endTime: "09:00:00",
    isLocked: false,
    isParked: false,
    isGenerated: true,
    recurrence: "ALL_WEEKS",
    startDate: null,
    endDate: null,
    extraGroupIds: [],
    studentIds: [],
    ...overrides,
  };
}

const lesson = (overrides: Partial<CandidateLesson> = {}): CandidateLesson => ({
  requirementId: "req-1",
  subjectId: "s-ma",
  studentGroupId: "g-7a",
  teacherId: "t-1",
  coTeacherId: null,
  roomId: "r-2",
  dayOfWeek: 2,
  startTime: "10:00",
  endTime: "11:00",
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  ...overrides,
});

describe("isPreserved — the gateway's PRESERVED_FROM_REGENERATION on the browser's rows", () => {
  it("replaces only a generated, unlocked lesson for its own group alone", () => {
    expect(isPreserved(master())).toBe(false);
  });

  it.each([
    ["handmade", { isGenerated: false }],
    ["locked", { isLocked: true }],
    ["attended by another class", { extraGroupIds: ["g-7b"] }],
    ["attended by named pupils", { studentIds: ["p-1"] }],
  ])("keeps a lesson that is %s", (_, overrides) => {
    expect(isPreserved(master(overrides))).toBe(true);
  });

  it("reads a lesson whose origin was not said as handmade, the column's default", () => {
    expect(isPreserved(master({ isGenerated: undefined }))).toBe(true);
  });
});

describe("the weeks a comparison is made of", () => {
  const draft = [
    master({ id: "gen" }),
    master({ id: "gen-parked", isParked: true }),
    master({ id: "locked", isLocked: true, dayOfWeek: 3 }),
    master({ id: "hand-parked", isGenerated: false, isParked: true }),
  ];

  it("draws the current week without what is on the tray", () => {
    expect(currentWeek(draft).map((row) => row.id)).toEqual(["gen", "locked"]);
  });

  it("counts every generated lesson as replaced, parked or not, as the apply deletes them", () => {
    expect(replacedLessons(draft).map((row) => row.id)).toEqual(["gen", "gen-parked"]);
  });

  it("builds a candidate's week from the preserved lessons on the grid and the candidate's own", () => {
    const week = candidateWeek(draft, [lesson(), lesson({ dayOfWeek: 4, startTime: "13:00", endTime: "14:00" })], "y-1");

    expect(week.map((row) => row.id)).toEqual(["locked", "candidate-lesson-0", "candidate-lesson-1"]);
    expect(week[1]).toMatchObject({
      academicYearId: "y-1",
      subjectId: "s-ma",
      studentGroupId: "g-7a",
      roomId: "r-2",
      dayOfWeek: 2,
      startTime: "10:00",
      endTime: "11:00",
      isLocked: false,
      isParked: false,
      extraGroupIds: [],
      studentIds: [],
    });
  });

  it("keeps a candidate lesson's weeks and dates, which come from its requirement", () => {
    const [placed] = candidateWeek([], [lesson({ recurrence: "ODD_WEEKS", startDate: "2027-01-07", endDate: null })]);
    expect(placed).toMatchObject({ recurrence: "ODD_WEEKS", startDate: "2027-01-07", endDate: null });
  });

  it("reads both clocks to the minute", () => {
    expect(clockOf("08:05:00")).toBe("08:05");
    expect(clockOf("08:05")).toBe("08:05");
  });
});
