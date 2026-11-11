import { describe, expect, it } from "vitest";
import { periodDatesOf } from "@/lib/period-note";

describe("periodDatesOf", () => {
  it("reads the stretch of the läsår a refusal was counted in", () => {
    expect(
      periodDatesOf({ teachers: 1, period: 2, periodFrom: "2027-01-11", periodTo: "2027-01-17", periodStretches: 1 }),
    ).toEqual({ from: "2027-01-11", to: "2027-01-17", more: false, parity: "ALL" });
  });

  it("says when the period has other weeks too, and which weeks of it were counted", () => {
    expect(
      periodDatesOf({
        period: 0,
        periodFrom: "2026-08-17",
        periodTo: "2027-01-10",
        periodStretches: 2,
        parity: "ODD_WEEKS",
      }),
    ).toEqual({ from: "2026-08-17", to: "2027-01-10", more: true, parity: "ODD_WEEKS" });
  });

  it("is nothing for a refusal that names no period", () => {
    expect(periodDatesOf(null)).toBeNull();
    expect(periodDatesOf(undefined)).toBeNull();
    expect(periodDatesOf({ demandMinutes: 2560, capacityMinutes: 2250 })).toBeNull();
    // The engine's index alone, from an API that did not turn it into days.
    expect(periodDatesOf({ period: 1 })).toBeNull();
  });

  it("is nothing for days it cannot read", () => {
    expect(periodDatesOf({ periodFrom: "11 januari", periodTo: "2027-01-17" })).toBeNull();
    expect(periodDatesOf({ periodFrom: 20270111, periodTo: 20270117 })).toBeNull();
  });
});
