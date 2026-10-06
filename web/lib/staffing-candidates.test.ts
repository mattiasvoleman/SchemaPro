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
