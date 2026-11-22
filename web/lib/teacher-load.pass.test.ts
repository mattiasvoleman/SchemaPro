import { describe, expect, it } from "vitest";
import { buildTeacherLoadReport, type LoadDuty } from "@/lib/teacher-load";

/**
 * The mirror of the gateway's dutyWeeksPerYear (src/supervision/supervision-load.annual.spec.ts, granskningen av #400): a rastvaktspass
 * sits on one weekday its dates fall on, so a DATED one holds once in every week it touches; every other uppdrag counts school days.
 * The production year runs Tuesday to Thursday: 16 Wednesdays from 2 to 16 December are 8 h of 30 minutes, 15.2 weeks of days only 7.6 h.
 */
const ANNA = "t-anna";
const YEAR = { startDate: "2026-08-18", endDate: "2027-06-10" };
const policy = {
  fullTimeTeachingMinutesPerWeek: 1080,
  overAllocationTolerancePercent: 10,
  fullTimeRegulatedHoursPerYear: 1360,
  workDaysPerYear: 194,
  qualificationMode: "OFF" as const,
};
const dutyHours = (duties: LoadDuty[]) =>
  buildTeacherLoadReport({ year: YEAR, policy, employments: [], requirements: [], qualifications: [], closures: [], duties }).teachers.find(
    (teacher) => teacher.userId === ANNA,
  )!.annual.dutyHoursPerYear;
const term = { userId: ANNA, minutesPerWeek: 30, countsAsTeaching: false, validFrom: "2026-09-02", validTo: "2026-12-16" };

describe("a rastvaktspass in the annual figures", () => {
  it("holds once in every week a dated one touches: 16 Wednesdays of 30 minutes are 8 h", () => {
    expect(dutyHours([{ ...term, weekdayPass: true }])).toBe(8);
  });

  it("is counted in school days when it is no pass, as every uppdrag: 15.2 weeks of 30 minutes are 7.6 h", () => {
    expect(dutyHours([term])).toBe(7.6);
  });

  it("is counted in school days when it is not dated, pass or not: 60 minutes over the 42.6 weeks of the year", () => {
    const undated = { userId: ANNA, minutesPerWeek: 60, countsAsTeaching: false };
    expect(dutyHours([undated])).toBe(42.6);
    expect(dutyHours([{ ...undated, weekdayPass: true }])).toBe(42.6);
  });
});
