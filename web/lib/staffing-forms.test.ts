import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import {
  DEFAULT_POLICY_DRAFT,
  EMPTY_EMPLOYMENT_DRAFT,
  employmentDraftToBody,
  employmentToDraft,
  newQualificationRow,
  parseDecimal,
  policyDraftToBody,
  policyToDraft,
  qualificationRowsToBody,
  qualificationsToDraft,
  validateEmploymentDraft,
  validatePolicyDraft,
  validateQualificationRows,
  validityState,
  type EmploymentDraft,
  type PolicyDraft,
  type QualificationDraftRow,
} from "./staffing-forms";

/**
 * The forms' rules, mirrored from the three staffing DTOs. Each refusal is
 * also checked against both locales below: the cards reach these keys through
 * a variable, which is the shape i18n/messages.test.ts skips rather than
 * guesses at.
 */

const draft = (overrides: Partial<EmploymentDraft> = {}): EmploymentDraft => ({
  ...EMPTY_EMPLOYMENT_DRAFT,
  employmentPercent: "80",
  ...overrides,
});

describe("parseDecimal", () => {
  it("reads a Swedish decimal comma as a point", () => {
    expect(parseDecimal("66,667", 3)).toBe(66.667);
    expect(parseDecimal("66.667", 3)).toBe(66.667);
    expect(parseDecimal(" 80 ", 3)).toBe(80);
  });

  it("refuses more decimals than the DTO takes, and anything that is not a number", () => {
    expect(parseDecimal("66.6667", 3)).toBeNull();
    expect(parseDecimal("80%", 3)).toBeNull();
    expect(parseDecimal("", 3)).toBeNull();
    expect(parseDecimal("-5", 3)).toBeNull();
  });
});

describe("validateEmploymentDraft", () => {
  it("accepts the ordinary post", () => {
    expect(validateEmploymentDraft(draft())).toBeNull();
    expect(validateEmploymentDraft(draft({ employmentPercent: "100", reductionPercent: "20" }))).toBeNull();
    expect(validateEmploymentDraft(draft({ employmentPercent: "66,667" }))).toBeNull();
  });

  it("requires a percentage: a post with no percentage is no post", () => {
    expect(validateEmploymentDraft(draft({ employmentPercent: "" }))).toEqual({
      reason: "percentRequired",
    });
  });

  it("keeps the percentage in (0, 100] with three decimals", () => {
    for (const value of ["0", "100.5", "101", "80.1234", "åttio"]) {
      expect(validateEmploymentDraft(draft({ employmentPercent: value }))).toEqual({
        reason: "percentOutOfRange",
        decimals: 3,
      });
    }
  });

  it("keeps the nedsättning inside the post, naming both numbers", () => {
    expect(validateEmploymentDraft(draft({ reductionPercent: "90" }))).toEqual({
      reason: "reductionAbovePercent",
      reduction: 90,
      percent: 80,
    });
    // On the edge is a post with nothing left to teach, which is legal.
    expect(validateEmploymentDraft(draft({ reductionPercent: "80" }))).toBeNull();
    expect(validateEmploymentDraft(draft({ reductionPercent: "-1" }))).toEqual({
      reason: "reductionOutOfRange",
      decimals: 3,
    });
  });

  it("keeps the own riktmärke a whole number 0..2400, and lets it be empty", () => {
    expect(validateEmploymentDraft(draft({ teachingTargetMinutesPerWeek: "0" }))).toBeNull();
    expect(validateEmploymentDraft(draft({ teachingTargetMinutesPerWeek: "2400" }))).toBeNull();
    expect(validateEmploymentDraft(draft({ teachingTargetMinutesPerWeek: "2401" }))).toEqual({
      reason: "targetOutOfRange",
      max: 2400,
    });
    expect(validateEmploymentDraft(draft({ teachingTargetMinutesPerWeek: "90.5" }))).toEqual({
      reason: "targetOutOfRange",
      max: 2400,
    });
  });

  it("caps the signature at eight characters and the note at 500", () => {
    expect(validateEmploymentDraft(draft({ signature: "ANDERSSON" }))).toEqual({
      reason: "signatureTooLong",
      max: 8,
    });
    expect(validateEmploymentDraft(draft({ note: "x".repeat(501) }))).toEqual({
      reason: "noteTooLong",
      max: 500,
    });
  });
});

describe("employmentDraftToBody", () => {
  it("sends numbers, every key present, and blanks as null or zero", () => {
    expect(employmentDraftToBody(draft())).toEqual({
      employmentPercent: 80,
      reductionPercent: 0,
      contractKind: "FERIE",
      teachingTargetMinutesPerWeek: null,
      signature: null,
      note: null,
    });
  });

  it("trims the strings and keeps a stated zero target", () => {
    expect(
      employmentDraftToBody(
        draft({
          reductionPercent: "20,5",
          teachingTargetMinutesPerWeek: "0",
          signature: " ANN ",
          note: " mentor 7B ",
          contractKind: "SEMESTER",
        }),
      ),
    ).toEqual({
      employmentPercent: 80,
      reductionPercent: 20.5,
      contractKind: "SEMESTER",
      teachingTargetMinutesPerWeek: 0,
      signature: "ANN",
      note: "mentor 7B",
    });
  });

  it("round-trips a stored row through the draft", () => {
    const row = {
      id: "e1",
      userId: "u1",
      academicYearId: "y1",
      employmentPercent: 66.667,
      reductionPercent: 0,
      contractKind: "FERIE" as const,
      teachingTargetMinutesPerWeek: 900,
      signature: "ANN",
      note: null,
    };
    expect(employmentDraftToBody(employmentToDraft(row))).toEqual({
      employmentPercent: 66.667,
      reductionPercent: 0,
      contractKind: "FERIE",
      teachingTargetMinutesPerWeek: 900,
      signature: "ANN",
      note: null,
    });
    expect(employmentToDraft(null)).toBe(EMPTY_EMPLOYMENT_DRAFT);
  });
});

describe("validateQualificationRows", () => {
  const row = (overrides: Partial<QualificationDraftRow> = {}): QualificationDraftRow => ({
    ...newQualificationRow("s-ma"),
    ...overrides,
  });

  it("accepts an ordered list of distinct subjects", () => {
    expect(validateQualificationRows([row(), row({ subjectId: "s-no" })])).toBeNull();
    expect(validateQualificationRows([])).toBeNull();
  });

  it("names the row whose subject is missing", () => {
    expect(validateQualificationRows([row(), row({ subjectId: "" })])).toEqual({
      reason: "subjectRequired",
      row: 2,
    });
  });

  it("refuses a reversed span and a reversed validity", () => {
    expect(
      validateQualificationRows([row({ minGradeLevel: 9, maxGradeLevel: 7 })]),
    ).toEqual({ reason: "spanReversed", row: 1, min: 9, max: 7 });
    expect(
      validateQualificationRows([row({ validFrom: "2027-01-01", validTo: "2026-06-30" })]),
    ).toEqual({ reason: "validityReversed", row: 1 });
  });

  it("refuses two rows for one subject, naming both", () => {
    expect(validateQualificationRows([row(), row({ subjectId: "s-no" }), row()])).toEqual({
      reason: "duplicateSubject",
      row: 3,
      first: 1,
    });
  });

  it("caps the list at the DTO's hundred", () => {
    const rows = Array.from({ length: 101 }, (_, i) => row({ subjectId: `s-${i}` }));
    expect(validateQualificationRows(rows)).toEqual({ reason: "tooManyRows", max: 100 });
  });

  it("sends blanks as null and round-trips stored rows", () => {
    const stored = [
      {
        id: "q1",
        userId: "u1",
        subjectId: "s-ma",
        minGradeLevel: 1,
        maxGradeLevel: 9,
        kind: "BEHORIG" as const,
        validFrom: null,
        validTo: "2028-06-30",
        note: null,
      },
    ];
    expect(qualificationRowsToBody(qualificationsToDraft(stored))).toEqual([
      {
        subjectId: "s-ma",
        minGradeLevel: 1,
        maxGradeLevel: 9,
        kind: "BEHORIG",
        validFrom: null,
        validTo: "2028-06-30",
        note: null,
      },
    ]);
  });
});

describe("validityState", () => {
  it("reads a past validTo as expired, a near one as expiring, a far one as valid", () => {
    expect(validityState(null, "2026-10-06")).toBe("VALID");
    expect(validityState("2026-10-05", "2026-10-06")).toBe("EXPIRED");
    expect(validityState("2026-10-06", "2026-10-06")).toBe("EXPIRING");
    expect(validityState("2027-01-04", "2026-10-06")).toBe("EXPIRING");
    expect(validityState("2027-01-05", "2026-10-06")).toBe("VALID");
  });
});

describe("validatePolicyDraft", () => {
  const policy = (overrides: Partial<PolicyDraft> = {}): PolicyDraft => ({
    ...DEFAULT_POLICY_DRAFT,
    ...overrides,
  });

  it("accepts the defaults, with and without a riktmärke", () => {
    expect(validatePolicyDraft(policy())).toBeNull();
    expect(validatePolicyDraft(policy({ fullTimeTeachingMinutesPerWeek: "1080" }))).toBeNull();
  });

  it("mirrors every bound of UpsertStaffingPolicyDto", () => {
    expect(validatePolicyDraft(policy({ fullTimeTeachingMinutesPerWeek: "0" }))).toEqual({
      reason: "riktmarkeOutOfRange",
      max: 2400,
    });
    expect(validatePolicyDraft(policy({ fullTimeTeachingMinutesPerWeek: "2401" }))).toEqual({
      reason: "riktmarkeOutOfRange",
      max: 2400,
    });
    expect(validatePolicyDraft(policy({ fullTimeRegulatedHoursPerYear: "2501" }))).toEqual({
      reason: "regulatedOutOfRange",
      max: 2500,
    });
    expect(validatePolicyDraft(policy({ fullTimeAnnualHours: "0" }))).toEqual({
      reason: "annualOutOfRange",
      max: 2500,
    });
    expect(validatePolicyDraft(policy({ workDaysPerYear: "261" }))).toEqual({
      reason: "workDaysOutOfRange",
      max: 260,
    });
    expect(validatePolicyDraft(policy({ semesterHoursPerWeek: "60,5" }))).toEqual({
      reason: "semesterHoursOutOfRange",
      max: 60,
    });
    expect(validatePolicyDraft(policy({ semesterHoursPerWeek: "40.25" }))).toEqual({
      reason: "semesterHoursOutOfRange",
      max: 60,
    });
    expect(validatePolicyDraft(policy({ overAllocationTolerancePercent: "51" }))).toEqual({
      reason: "toleranceOutOfRange",
      max: 50,
    });
  });

  it("refuses reglerad arbetstid above the annual hours, naming both", () => {
    expect(
      validatePolicyDraft(policy({ fullTimeRegulatedHoursPerYear: "1800", fullTimeAnnualHours: "1767" })),
    ).toEqual({ reason: "regulatedAboveAnnual", regulated: 1800, annual: 1767 });
  });

  it("sends numbers, the empty riktmärke as null, and round-trips a row", () => {
    expect(policyDraftToBody(policy({ semesterHoursPerWeek: "37,5" }))).toEqual({
      fullTimeTeachingMinutesPerWeek: null,
      fullTimeRegulatedHoursPerYear: 1360,
      fullTimeAnnualHours: 1767,
      workDaysPerYear: 194,
      semesterHoursPerWeek: 37.5,
      qualificationMode: "WARN",
      overAllocationMode: "WARN",
      overAllocationTolerancePercent: 10,
      loadModel: "MINUTES",
      // Always present: PUT replaces the row and absent means ALLOW.
      unstaffedGeneration: "ALLOW",
      // Likewise: absent means "share nothing".
      shareEmploymentWithIntegrations: false,
    });
    const row = {
      fullTimeTeachingMinutesPerWeek: 1080,
      fullTimeRegulatedHoursPerYear: 1360,
      fullTimeAnnualHours: 1767,
      workDaysPerYear: 194,
      semesterHoursPerWeek: 40,
      qualificationMode: "REFUSE" as const,
      overAllocationMode: "OFF" as const,
      overAllocationTolerancePercent: 5,
      loadModel: "FACTOR" as const,
      unstaffedGeneration: "REFUSE" as const,
      shareEmploymentWithIntegrations: true,
    };
    expect(policyDraftToBody(policyToDraft(row))).toEqual(row);
    // A row from a gateway older than staffing Fas 3 shares nothing.
    const { shareEmploymentWithIntegrations: _dropped, ...older } = row;
    expect(policyToDraft(older).shareEmploymentWithIntegrations).toBe(false);
    expect(policyToDraft(null)).toBe(DEFAULT_POLICY_DRAFT);
  });
});

describe("every refusal has a sentence in both locales", () => {
  /*
   * The reasons above are reached through a variable in the cards, so the
   * i18n sweep cannot see them. Listed here by hand, which is the one place
   * a new reason has to be added for the test to notice its missing Swedish.
   */
  const reasons = [
    "percentRequired",
    "percentOutOfRange",
    "reductionOutOfRange",
    "reductionAbovePercent",
    "targetOutOfRange",
    "signatureTooLong",
    "noteTooLong",
    "subjectRequired",
    "spanReversed",
    "validityReversed",
    "duplicateSubject",
    "tooManyRows",
    "riktmarkeOutOfRange",
    "regulatedOutOfRange",
    "annualOutOfRange",
    "regulatedAboveAnnual",
    "workDaysOutOfRange",
    "semesterHoursOutOfRange",
    "toleranceOutOfRange",
    "dutyLabelRequired",
    "dutyLabelTooLong",
    "dutyMinutesOutOfRange",
    "dutyNoteTooLong",
    "slotTimeRequired",
    "slotOffGrid",
    "slotReversed",
  ];
  type Messages = { staffing: Record<string, string> };

  it.each(reasons)("%s", (reason) => {
    expect(typeof (sv as unknown as Messages).staffing[`problem_${reason}`]).toBe("string");
    expect(typeof (en as unknown as Messages).staffing[`problem_${reason}`]).toBe("string");
  });
});
