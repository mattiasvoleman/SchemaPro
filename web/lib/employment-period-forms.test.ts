import { describe, expect, it } from "vitest";
import {
  EMPTY_PERIOD_DRAFT,
  periodDraftToBody,
  periodToDraft,
  validatePeriodDraft,
  type PeriodDraft,
} from "./employment-period-forms";
import type { TeacherEmploymentPeriod } from "./types";

const YEAR = { startDate: "2026-08-17", endDate: "2027-06-11" };
const draft = (overrides: Partial<PeriodDraft> = {}): PeriodDraft => ({
  ...EMPTY_PERIOD_DRAFT,
  validFrom: "2026-11-01",
  employmentPercent: "80",
  ...overrides,
});
const spring: TeacherEmploymentPeriod = {
  id: "p-spring",
  employmentId: "e1",
  validFrom: "2027-01-07",
  validTo: null,
  employmentPercent: 75,
  reductionPercent: 0,
  teachingTargetMinutesPerWeek: null,
};

describe("validatePeriodDraft", () => {
  it("takes a period from 1 November at 80 %, open to the year's end", () => {
    expect(validatePeriodDraft(draft(), YEAR, [])).toBeNull();
  });

  it("asks for Från, and for Till after it", () => {
    expect(validatePeriodDraft(draft({ validFrom: "" }), YEAR, [])).toEqual({ reason: "periodFromRequired" });
    expect(validatePeriodDraft(draft({ validTo: "2026-10-31" }), YEAR, [])).toEqual({
      reason: "periodDatesReversed",
      from: "2026-11-01",
      to: "2026-10-31",
    });
  });

  it("holds the figures to the post's own bounds, the nedsättning inside the period's post", () => {
    expect(validatePeriodDraft(draft({ employmentPercent: "" }), YEAR, [])).toEqual({ reason: "percentRequired" });
    expect(validatePeriodDraft(draft({ employmentPercent: "100,5" }), YEAR, [])?.reason).toBe("percentOutOfRange");
    expect(validatePeriodDraft(draft({ reductionPercent: "90" }), YEAR, [])).toEqual({
      reason: "reductionAbovePercent",
      reduction: 90,
      percent: 80,
    });
    expect(validatePeriodDraft(draft({ teachingTargetMinutesPerWeek: "2401" }), YEAR, [])?.reason).toBe(
      "targetOutOfRange",
    );
  });

  it("keeps the dates inside the läsår, read by its day even as timestamps", () => {
    expect(validatePeriodDraft(draft({ validFrom: "2026-08-10" }), YEAR, [])).toEqual({
      reason: "periodOutsideYear",
      date: "2026-08-10",
      start: "2026-08-17",
      end: "2027-06-11",
    });
    expect(
      validatePeriodDraft(draft({ validTo: "2027-06-11" }), {
        startDate: "2026-08-17T00:00:00.000Z",
        endDate: "2027-06-11T00:00:00.000Z",
      }, []),
    ).toBeNull();
  });

  it("refuses a period that holds no Monday, as the gateway does — a week is the post on its Monday", () => {
    expect(validatePeriodDraft(draft({ validFrom: "2026-11-10", validTo: "2026-11-13" }), YEAR, [])).toEqual({
      reason: "periodHoldsNoWeek",
      from: "2026-11-10",
      to: "2026-11-13",
    });
    expect(validatePeriodDraft(draft({ validFrom: "2026-11-10", validTo: "2026-11-16" }), YEAR, [])).toBeNull();
  });

  it("names the period a draft overlaps, and lets a period be rewritten over its own dates", () => {
    expect(validatePeriodDraft(draft({ validTo: "2027-01-07" }), YEAR, [spring])).toEqual({
      reason: "periodOverlaps",
      from: "2027-01-07",
      to: "2027-06-11",
    });
    expect(validatePeriodDraft(draft({ validTo: "2027-01-06" }), YEAR, [spring])).toBeNull();
    expect(validatePeriodDraft(periodToDraft(spring), YEAR, [spring], spring.id)).toBeNull();
  });

  it("leaves the date rules to the save while the year has not loaded", () => {
    expect(validatePeriodDraft(draft({ validFrom: "2026-08-10" }), null, [spring])).toBeNull();
  });
});

describe("the period's body", () => {
  it("sends Till as null when empty, the decimal comma as a point, no nedsättning as 0 and no own target as null", () => {
    expect(periodDraftToBody(draft({ employmentPercent: "66,667" }))).toEqual({
      validFrom: "2026-11-01",
      validTo: null,
      employmentPercent: 66.667,
      reductionPercent: 0,
      teachingTargetMinutesPerWeek: null,
    });
  });

  it("round-trips a stored period through its draft", () => {
    const stored = { ...spring, validTo: "2027-03-31", reductionPercent: 10, teachingTargetMinutesPerWeek: 700 };
    expect(periodDraftToBody(periodToDraft(stored))).toEqual({
      validFrom: "2027-01-07",
      validTo: "2027-03-31",
      employmentPercent: 75,
      reductionPercent: 10,
      teachingTargetMinutesPerWeek: 700,
    });
  });
});
