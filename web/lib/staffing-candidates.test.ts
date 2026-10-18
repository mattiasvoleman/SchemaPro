import { describe, expect, it } from "vitest";
import { candidateQualification, candidateRemaining } from "./staffing-candidates";

const YEAR = { startDate: "2026-08-17", endDate: "2027-06-11" };

const row = (overrides: Partial<Parameters<typeof candidateQualification>[0][number]> = {}) => ({
  userId: "t-anna",
  subjectId: "s-ma",
  minGradeLevel: 7,
  maxGradeLevel: 9,
  kind: "BEHORIG" as const,
  validFrom: null,
  validTo: null,
  ...overrides,
});

describe("candidateQualification", () => {
  it("says nothing at all when the school has recorded nothing", () => {
    expect(candidateQualification([], "t-anna", "s-ma", { min: 7, max: 7 }, YEAR)).toEqual({
      recorded: false,
    });
  });

  it("names the strongest kind that covers the subject and the whole span", () => {
    const rows = [row(), row({ kind: "LEGITIMATION", minGradeLevel: 7, maxGradeLevel: 7 })];
    // 7–7 is inside both; the legitimation wins.
    expect(candidateQualification(rows, "t-anna", "s-ma", { min: 7, max: 7 }, YEAR)).toEqual({
      recorded: true,
      kind: "LEGITIMATION",
    });
    // 7–9 is covered by the behörig row only.
    expect(candidateQualification(rows, "t-anna", "s-ma", { min: 7, max: 9 }, YEAR)).toEqual({
      recorded: true,
      kind: "BEHORIG",
    });
  });

  it("reads another subject, another teacher, a lapsed row or a short span as none", () => {
    const rows = [row()];
    // `recorded: true` in every case: the school HAS rows, they just do not
    // cover this one — which is what earns the "saknar behörighet" badge.
    const none = { recorded: true, kind: null };
    expect(candidateQualification(rows, "t-anna", "s-no", { min: 7, max: 7 }, YEAR)).toEqual(none);
    expect(candidateQualification(rows, "t-bo", "s-ma", { min: 7, max: 7 }, YEAR)).toEqual(none);
    expect(candidateQualification(rows, "t-anna", "s-ma", { min: 4, max: 9 }, YEAR)).toEqual(none);
    expect(
      candidateQualification([row({ validTo: "2026-06-30" })], "t-anna", "s-ma", { min: 7, max: 7 }, YEAR),
    ).toEqual(none);
  });

  it("covers a group with no derivable grade by any row in the subject", () => {
    expect(candidateQualification([row()], "t-anna", "s-ma", null, YEAR)).toEqual({
      recorded: true,
      kind: "BEHORIG",
    });
  });

  /*
   * A tioårig läsår. The requirements page hands over its yearBounds with the
   * year's numbering on it, and a behörighet is stated in NIOARIG
   * (grade-numbering.ts): the span the badge is asked about is the class's
   * own, in the year's numbering, and the cover rule reads it over — so a
   * tioårig 10A is the 9 Anna's 7–9 was written for, and a tioårig 7A the 6
   * it never reached. The matrix's unqualified list asks the same rule.
   */
  describe("in a tioårig läsår", () => {
    const BOUNDS = { startDate: "2028-08-14", endDate: "2029-06-08" };
    const TIOARIG = { ...BOUNDS, gradeNumbering: "TIOARIG" as const };
    const NIOARIG = { ...BOUNDS, gradeNumbering: "NIOARIG" as const };
    const mellan = row({ kind: "LEGITIMATION", minGradeLevel: 1, maxGradeLevel: 6 });

    it("badges a tioårig 10A by the 7–9 row, and a tioårig 7A by the 1–6 row", () => {
      expect(candidateQualification([row(), mellan], "t-anna", "s-ma", { min: 10, max: 10 }, TIOARIG)).toEqual({
        recorded: true,
        kind: "BEHORIG",
      });
      expect(candidateQualification([row(), mellan], "t-anna", "s-ma", { min: 7, max: 7 }, TIOARIG)).toEqual({
        recorded: true,
        kind: "LEGITIMATION",
      });
    });

    it("leaves a tioårig 10A unqualified for a teacher whose rows stop at 6", () => {
      expect(candidateQualification([mellan], "t-anna", "s-ma", { min: 10, max: 10 }, TIOARIG)).toEqual({
        recorded: true,
        kind: null,
      });
    });

    it("reads the same spans as they are in a nine-year läsår, numbered or not", () => {
      // 10 is specialskolans åk 10 there, outside 7–9; 7 is inside it.
      for (const year of [NIOARIG, BOUNDS]) {
        expect(candidateQualification([row(), mellan], "t-anna", "s-ma", { min: 10, max: 10 }, year)).toEqual({
          recorded: true,
          kind: null,
        });
        expect(candidateQualification([row(), mellan], "t-anna", "s-ma", { min: 7, max: 7 }, year)).toEqual({
          recorded: true,
          kind: "BEHORIG",
        });
      }
    });
  });
});

describe("candidateRemaining", () => {
  const report = {
    teachers: [
      { userId: "t-anna", balanceMinutesPerWeek: 180 },
      { userId: "t-bo", balanceMinutesPerWeek: -120 },
      { userId: "t-cilla", balanceMinutesPerWeek: null },
      { userId: "t-david", balanceMinutesPerWeek: 0 },
    ],
  };

  it("reads the balance off the report's row", () => {
    expect(candidateRemaining(report, "t-anna")).toEqual({ status: "REMAINING", minutes: 180 });
    expect(candidateRemaining(report, "t-bo")).toEqual({ status: "OVER", minutes: 120 });
    expect(candidateRemaining(report, "t-david")).toEqual({ status: "REMAINING", minutes: 0 });
  });

  it("is NO_TARGET for a teacher without a target, absent from the report, or before it arrived", () => {
    expect(candidateRemaining(report, "t-cilla")).toEqual({ status: "NO_TARGET" });
    expect(candidateRemaining(report, "t-nobody")).toEqual({ status: "NO_TARGET" });
    expect(candidateRemaining(undefined, "t-anna")).toEqual({ status: "NO_TARGET" });
  });
});
