import { describe, expect, it } from "vitest";
import type { GradeNumbering } from "@/lib/grade-numbering";
import type { LoadQualification } from "@/lib/teacher-load";
import { qualificationCovers } from "./standard-week";

/**
 * A behörighet in a tioårig läsår.
 *
 * TeacherSubjectQualifications are stated in the nine-year numbering for good
 * (grade-numbering.ts), and a TIOARIG läsår's classes are one higher than the
 * same children in it — its 10A is the 9 a "7–9" behörighet was written for,
 * and its 7A the 6 that "7–9" never reached. So the judge reads the
 * requirement's span in NIOARIG through the year's numbering before it
 * compares, as the gateway's qualificationCovers (src/staffing/teacher-load.ts)
 * does. A nine-year läsår — NIOARIG, or no numbering at all — is the
 * comparison it always was: there 10 is specialskolans åk 10, outside 7–9.
 *
 * teacher-load.contract.test.ts replays the gateway's nine-year cases; these
 * are the tioårig ones the badge and the matrix's unqualified list hang on.
 */

const MA = "s-ma";

type JudgedYear = Parameters<typeof qualificationCovers>[2];

const BOUNDS = { startDate: "2028-08-14", endDate: "2029-06-08" };
const yearIn = (gradeNumbering?: GradeNumbering): JudgedYear =>
  gradeNumbering ? { ...BOUNDS, gradeNumbering } : { ...BOUNDS };
const TIOARIG = yearIn("TIOARIG");
const NIOARIG = yearIn("NIOARIG");
/** A year row read before the column existed, or a caller that drops it: NIOARIG. */
const UNNUMBERED = yearIn();

const qualification = (overrides: Partial<LoadQualification> = {}): LoadQualification => ({
  userId: "t-anna",
  subjectId: MA,
  minGradeLevel: 7,
  maxGradeLevel: 9,
  kind: "BEHORIG",
  validFrom: null,
  validTo: null,
  ...overrides,
});

const covers = (
  held: LoadQualification,
  span: { min: number; max: number } | null,
  year: JudgedYear,
) => qualificationCovers(held, { subjectId: MA, gradeSpan: span }, year);

describe("qualificationCovers in a tioårig läsår", () => {
  it("covers a tioårig 10A by a 7–9 behörighet: it is the 9 the row was written for", () => {
    expect(covers(qualification(), { min: 10, max: 10 }, TIOARIG)).toBe(true);
  });

  it("does not cover a nine-year 10A by the same row, numbered or not", () => {
    // Specialskolans åk 10, which 7–9 never reached.
    expect(covers(qualification(), { min: 10, max: 10 }, NIOARIG)).toBe(false);
    expect(covers(qualification(), { min: 10, max: 10 }, UNNUMBERED)).toBe(false);
  });

  it("reads a tioårig 7A as NIOARIG 6: a 1–6 row covers it and a 7–9 row falls short", () => {
    const mellan = qualification({ minGradeLevel: 1, maxGradeLevel: 6 });
    expect(covers(mellan, { min: 7, max: 7 }, TIOARIG)).toBe(true);
    expect(covers(qualification(), { min: 7, max: 7 }, TIOARIG)).toBe(false);
    // The nine-year läsår's 7A, the other way round.
    expect(covers(mellan, { min: 7, max: 7 }, NIOARIG)).toBe(false);
    expect(covers(qualification(), { min: 7, max: 7 }, NIOARIG)).toBe(true);
  });

  it("translates both ends of a group's span: tioårig 8–10 is 7–9, and 7–10 is 6–9", () => {
    // A teaching group whose members come from three classes.
    expect(covers(qualification(), { min: 8, max: 10 }, TIOARIG)).toBe(true);
    expect(covers(qualification(), { min: 7, max: 10 }, TIOARIG)).toBe(false);
  });

  it("reaches a tioårig åk 1–4 by a grundlärare F–3's 0–3: the same children", () => {
    // The new åk 1 is the förskoleklass age band, so an F–3 row covers it and
    // stops short of the tioårig åk 5.
    const f3 = qualification({ minGradeLevel: 0, maxGradeLevel: 3 });
    expect(covers(f3, { min: 1, max: 4 }, TIOARIG)).toBe(true);
    expect(covers(f3, { min: 5, max: 5 }, TIOARIG)).toBe(false);
  });

  it("still covers a group with no derivable grade by any row in the subject", () => {
    expect(covers(qualification(), null, TIOARIG)).toBe(true);
  });

  it("asks the subject and the validity window first, whatever the numbering", () => {
    const span = { min: 10, max: 10 };
    expect(qualificationCovers(qualification({ subjectId: "s-no" }), { subjectId: MA, gradeSpan: span }, TIOARIG)).toBe(
      false,
    );
    // Lapsed the summer before the year began.
    expect(covers(qualification({ validTo: "2028-06-30" }), span, TIOARIG)).toBe(false);
  });
});
