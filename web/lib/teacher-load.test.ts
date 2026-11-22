import { describe, expect, it } from "vitest";
import {
  buildTeacherLoadReport,
  qualificationCovers,
  strongestCoveringQualification,
  type LoadQualification,
  type LoadRequirement,
} from "@/lib/teacher-load";

/**
 * The load report's mirror in a tioårig läsår.
 *
 * teacher-load.contract.test.ts replays the gateway's fixture, and every year
 * in it is nine-year. The gateway judges a behörighet through the year's
 * numbering (src/staffing/teacher-load.ts, JudgedYear): a TIOARIG läsår's 10A
 * is the 9 a "7–9" was written for, and its 11 the NIOARIG 10 that row never
 * reached. The rule itself is pinned in standard-week.test.ts; these rows pin
 * that the year the report and the strongest-kind pick are handed reaches it
 * with its numbering on, and that what the report names stays in the year's
 * own numbering. The cases are the gateway spec's ("Tioårig grundskola").
 */

const MA = "s-ma";
const ANNA = "t-anna";

type JudgedYear = Parameters<typeof qualificationCovers>[2];

const BOUNDS = { startDate: "2028-08-21", endDate: "2029-06-15" };
const TIOARIG_YEAR: JudgedYear = { ...BOUNDS, gradeNumbering: "TIOARIG" };
const NIOARIG_YEAR: JudgedYear = { ...BOUNDS, gradeNumbering: "NIOARIG" };
/** A year row read before the column existed: NIOARIG. */
const UNNUMBERED: JudgedYear = { ...BOUNDS };

const qualification = (overrides: Partial<LoadQualification> = {}): LoadQualification => ({
  userId: ANNA,
  subjectId: MA,
  minGradeLevel: 7,
  maxGradeLevel: 9,
  kind: "BEHORIG",
  validFrom: null,
  validTo: null,
  ...overrides,
});

const requirement = (gradeSpan: { min: number; max: number }): LoadRequirement => ({
  id: "req-x",
  subjectId: MA,
  subjectName: "Matematik",
  studentGroupId: "g-x",
  groupName: `${gradeSpan.min}A`,
  teacherId: ANNA,
  coTeacherId: null,
  lessonsPerWeek: 3,
  minutesPerLesson: 60,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  gradeSpan,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
});

const reportOn = (gradeSpan: { min: number; max: number }, year: JudgedYear) =>
  buildTeacherLoadReport({
    year,
    policy: null,
    employments: [],
    requirements: [requirement(gradeSpan)],
    qualifications: [qualification()],
    closures: [],
    duties: [],
  });

describe("the load report in a tioårig läsår", () => {
  it("flags no tioårig 10A under a 7–9 behörighet, and flags the 11 with its span as the year numbers it", () => {
    expect(reportOn({ min: 10, max: 10 }, TIOARIG_YEAR).unqualifiedAssignments).toEqual([]);
    expect(reportOn({ min: 11, max: 11 }, TIOARIG_YEAR).unqualifiedAssignments).toEqual([
      expect.objectContaining({ userId: ANNA, role: "TEACHER", groupName: "11A", gradeSpan: { min: 11, max: 11 } }),
    ]);
  });

  it("flags the same 10A in a nine-year läsår, numbered or not, as it always did", () => {
    for (const year of [NIOARIG_YEAR, UNNUMBERED]) {
      expect(reportOn({ min: 10, max: 10 }, year).unqualifiedAssignments).toEqual([
        expect.objectContaining({ userId: ANNA, gradeSpan: { min: 10, max: 10 } }),
      ]);
    }
  });

  it("changes nothing but the behörighet: the teachers' figures are the nine-year ones", () => {
    const tioarig = reportOn({ min: 10, max: 10 }, TIOARIG_YEAR);
    const nioarig = reportOn({ min: 10, max: 10 }, UNNUMBERED);
    expect(tioarig.teachers).toEqual(nioarig.teachers);
    expect(tioarig.unstaffedRequirements).toEqual(nioarig.unstaffedRequirements);
  });

  it("picks the strongest kind among the rows that hold the tioårig span read in NIOARIG", () => {
    const held = [
      // NIOARIG 10–10: holds the tioårig 11 only, not the 10A's NIOARIG 9.
      qualification({ kind: "LEGITIMATION", minGradeLevel: 10, maxGradeLevel: 10 }),
      qualification({ kind: "TILLATEN", minGradeLevel: 7, maxGradeLevel: 9 }),
      qualification({ kind: "BEHORIG", minGradeLevel: 4, maxGradeLevel: 9 }),
    ];
    const tenA = { subjectId: MA, gradeSpan: { min: 10, max: 10 } };
    expect(strongestCoveringQualification(held, ANNA, tenA, TIOARIG_YEAR)).toBe("BEHORIG");
    // Specialskolans 10 in a nine-year läsår: only the 10–10 row holds it.
    expect(strongestCoveringQualification(held, ANNA, tenA, NIOARIG_YEAR)).toBe("LEGITIMATION");
    expect(strongestCoveringQualification(held, ANNA, tenA, UNNUMBERED)).toBe("LEGITIMATION");
  });
});

/**
 * The annual figures of a läsår that starts on a Saturday (granskningen av #382, L-5): the weeks are counted in school days, as in
 * the gateway (src/staffing/assignment-scope.spec.ts), so the browser's annual card says the hours the gateway's report says.
 */
describe("the annual figures count school days", () => {
  const SATURDAY = { startDate: "2026-08-15", endDate: "2027-06-11" };
  const fifteenLessons = { ...requirement({ min: 4, max: 6 }), lessonsPerWeek: 15, minutesPerLesson: 60, teacherLoadPercent: 100, startDate: null, endDate: null };
  const employment = {
    userId: ANNA,
    employmentPercent: 100,
    reductionPercent: 0,
    contractKind: "FERIE" as const,
    teachingTargetMinutesPerWeek: null,
    signature: null,
  };
  const policy = {
    fullTimeTeachingMinutesPerWeek: 1080,
    overAllocationTolerancePercent: 10,
    fullTimeRegulatedHoursPerYear: 1360,
    workDaysPerYear: 194,
    qualificationMode: "OFF" as const,
  };
  const annualOf = (year: typeof SATURDAY, extra: Partial<Parameters<typeof buildTeacherLoadReport>[0]> = {}) =>
    buildTeacherLoadReport({
      year,
      policy,
      employments: [employment],
      requirements: [{ ...fifteenLessons, teacherId: ANNA }],
      qualifications: [],
      closures: [],
      duties: [],
      ...extra,
    }).teachers.find((teacher) => teacher.userId === ANNA)!.annual;

  it("is 43 weeks and 645 h in a year that starts on a Saturday, as in one that starts on the Monday", () => {
    const saturday = annualOf(SATURDAY);
    const monday = annualOf({ startDate: "2026-08-17", endDate: "2027-06-11" });
    expect([saturday.teachingWeeksPerYear, saturday.assignedHoursPerYear]).toEqual([43, 645]);
    expect([monday.teachingWeeksPerYear, monday.assignedHoursPerYear]).toEqual([43, 645]);
  });

  it("weights a post that halves from a Monday by the school days of each stretch: 62.8 % of 1 360 h is 854 h, and not 63.6 %", () => {
    const changing = {
      ...employment,
      periods: [{ validFrom: "2026-11-02", validTo: "2027-06-11", employmentPercent: 50, reductionPercent: 0, teachingTargetMinutesPerWeek: null }],
    };
    expect(annualOf(SATURDAY, { employments: [changing] }).regulatedHoursPerYear).toBe(854);
  });
});
