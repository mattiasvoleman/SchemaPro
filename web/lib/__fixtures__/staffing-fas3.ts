/**
 * Staffing Fas 3 fixtures for the web tests: one teacher's load row as
 * GET /staffing/load hands it over (assignments and annual included), shared
 * by the uppdragsbeskrivning's component and route tests and the exports.
 */

import type { TeacherLoad } from "@/lib/teacher-load";

export const uppdragLoad: TeacherLoad = {
  userId: "t-anna",
  employment: {
    userId: "t-anna",
    employmentPercent: 80,
    reductionPercent: 10,
    contractKind: "FERIE",
    teachingTargetMinutesPerWeek: null,
    signature: "ANN",
  },
  targetMinutesPerWeek: 755,
  assignedMinutesPerWeek: 660,
  peakMinutesPerWeek: 720,
  dutyMinutesPerWeek: 90,
  countedDutyMinutesPerWeek: 0,
  countedMinutesPerWeek: 660,
  balanceMinutesPerWeek: 95,
  percentOfTarget: 87.4,
  status: "UNDER",
  requirementCount: 2,
  dutyCount: 1,
  subjects: [],
  assignments: [
    {
      requirementId: "r1",
      role: "TEACHER",
      subjectId: "s-ma",
      subjectName: "Matematik",
      studentGroupId: "g-7a",
      groupName: "7A",
      gradeSpan: { min: 7, max: 7 },
      recurrence: "ALL_WEEKS",
      startDate: null,
      endDate: null,
      lessonMinutesPerWeek: 240,
      timeMinutesPerWeek: 240,
      minutesPerWeek: 240,
      hoursPerYear: 152,
    },
    {
      requirementId: "r2",
      role: "CO_TEACHER",
      subjectId: "s-sl",
      subjectName: "Slöjd",
      studentGroupId: "g-7b",
      groupName: "7B",
      gradeSpan: { min: 7, max: 7 },
      recurrence: "ODD_WEEKS",
      startDate: "2026-08-17",
      endDate: "2026-12-18",
      lessonMinutesPerWeek: 120,
      timeMinutesPerWeek: 60,
      minutesPerWeek: 42,
      hoursPerYear: 13.3,
    },
  ],
  annual: {
    assignedHoursPerYear: 165.3,
    regulatedHoursPerYear: 952,
    workDaysPerYear: 194,
    contractKind: "FERIE",
    annualHours: 1236.9,
    unregulatedHoursPerYear: 284.9,
    semesterHoursPerWeek: null,
    dutyHoursPerYear: 57,
    teachingWeeksPerYear: 38,
    percentOfRegulated: 17.4,
  },
};
