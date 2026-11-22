import { describe, expect, it } from "vitest";
import { buildTeacherLoadReport, type LoadEmployment, type LoadInput, type LoadRequirement } from "@/lib/teacher-load";

/**
 * The mirror of src/staffing/teacher-load.stretch-days.spec.ts (granskningen av #400): a post that changes during a läsår that starts on
 * a Saturday is weighted by school days, 21 + 22 weeks and not 22 + 22, in the year's target, the saldo, the percentage, the stretches'
 * `teachingWeeks` and which stretch is judged. The counted minutes are the same.
 */
const YEAR = { startDate: "2026-08-15", endDate: "2027-06-11" };
const policy = {
  fullTimeTeachingMinutesPerWeek: 1080,
  overAllocationTolerancePercent: 10,
  fullTimeRegulatedHoursPerYear: 1360,
  workDaysPerYear: 194,
  qualificationMode: "OFF" as const,
};
const row: LoadRequirement = {
  id: "r1",
  subjectId: "ma",
  subjectName: "Matematik",
  studentGroupId: "g1",
  groupName: "5A",
  teacherId: "anna",
  coTeacherId: null,
  lessonsPerWeek: 17,
  minutesPerLesson: 50,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  gradeSpan: { min: 5, max: 5 },
};
const post = (employmentPercent: number, periods: NonNullable<LoadEmployment["periods"]>): LoadEmployment => ({
  userId: "anna",
  employmentPercent,
  reductionPercent: 0,
  contractKind: "FERIE",
  teachingTargetMinutesPerWeek: null,
  signature: "ANNA",
  periods,
});
const period = (validFrom: string, employmentPercent: number) => ({ validFrom, validTo: null, employmentPercent, reductionPercent: 0, teachingTargetMinutesPerWeek: null });
const annaOf = (employment: LoadEmployment) => {
  const input: LoadInput = { year: YEAR, policy, employments: [employment], requirements: [row], qualifications: [], closures: [], duties: [] };
  return buildTeacherLoadReport(input).teachers.find((teacher) => teacher.userId === "anna")!;
};

describe("a post that changes during a läsår that starts on a Saturday", () => {
  it("weights the year by school days: a target of 860 and not 865, and the counted minutes the same", () => {
    const anna = annaOf(post(100, [period("2027-01-11", 60)]));
    expect(anna.targetMinutesPerWeek).toBe(860);
    expect(anna.balanceMinutesPerWeek).toBe(10);
    expect(anna.percentOfTarget).toBe(98.8);
    expect((anna.periods ?? []).map((one) => one.teachingWeeks)).toEqual([21, 22]);
    expect(anna.annual.regulatedHoursPerYear).toBe(1081.7);
    expect(anna.countedMinutesPerWeek).toBe(850);
    expect((anna.periods ?? []).map((one) => one.countedMinutesPerWeek)).toEqual([850, 850]);
    expect(anna.status).toBe("OVER");
  });

  it("leaves the standardvecka alone: a term course is its whole weeks over the stretch's whole weeks, 16 of 22 in the autumn and 16 of 44 in the year", () => {
    const term: LoadRequirement = { ...row, id: "r2", studentGroupId: "g2", groupName: "5B", lessonsPerWeek: 3, minutesPerLesson: 60, startDate: "2026-09-02", endDate: "2026-12-18" };
    const input: LoadInput = { year: YEAR, policy, employments: [post(100, [period("2027-01-11", 60)])], requirements: [row, term], qualifications: [], closures: [], duties: [] };
    const anna = buildTeacherLoadReport(input).teachers.find((teacher) => teacher.userId === "anna")!;
    expect((anna.periods ?? []).map((one) => one.countedMinutesPerWeek)).toEqual([981, 850]);
    expect(anna.countedMinutesPerWeek).toBe(915);
    expect(anna.assignedMinutesPerWeek).toBe(915);
  });

  it("judges no stretch that holds only the weekend", () => {
    const anna = annaOf(post(50, [period("2026-08-17", 100)]));
    expect((anna.periods ?? []).map((one) => one.teachingWeeks)).toEqual([0, 43]);
    expect(anna.targetMinutesPerWeek).toBe(1080);
    expect(anna.balanceMinutesPerWeek).toBe(230);
    expect(anna.status).toBe("UNDER");
    expect(anna.countedMinutesPerWeek).toBe(850);
  });
});
