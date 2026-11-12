import { describe, expect, it } from "vitest";
import { lockPeriodDatesOf, periodDatesOf, periodDay } from "@/lib/period-note";

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

describe("lockPeriodDatesOf", () => {
  const lunch = { group: "7A", minutes: 30, windowStart: "11:00", windowEnd: "12:00", day: 1 };
  const dated = {
    ...lunch,
    lockPeriods: "0,2",
    lockFrom: "2026-08-17",
    lockTo: "2026-12-20",
    otherLockFrom: "2027-01-11",
    otherLockTo: "2027-06-11",
    lockWeeksElsewhere: 0,
  };

  it("reads the two parts of the läsår whose locked lessons close a class's lunch window between them", () => {
    expect(lockPeriodDatesOf(dated)).toEqual({
      from: "2026-08-17",
      to: "2026-12-20",
      otherFrom: "2027-01-11",
      otherTo: "2027-06-11",
      more: false,
    });
  });

  it("says when the locks run in more weeks than the two stretches named", () => {
    expect(lockPeriodDatesOf({ ...dated, lockWeeksElsewhere: 1 })?.more).toBe(true);
    // No count at all is no more weeks, not an error.
    const { lockWeeksElsewhere: _unsaid, ...without } = dated;
    expect(lockPeriodDatesOf(without)?.more).toBe(false);
  });

  it("is nothing for a refusal one period's locks cause alone, which reads as it always did", () => {
    expect(lockPeriodDatesOf(null)).toBeNull();
    expect(lockPeriodDatesOf(undefined)).toBeNull();
    expect(lockPeriodDatesOf(lunch)).toBeNull();
    // The engine's periods alone, from an API that did not turn them into days.
    expect(lockPeriodDatesOf({ ...lunch, lockPeriods: "0,2" })).toBeNull();
  });

  it("is nothing unless every one of the four days can be read", () => {
    for (const key of ["lockFrom", "lockTo", "otherLockFrom", "otherLockTo"] as const) {
      expect(lockPeriodDatesOf({ ...dated, [key]: "11 januari" })).toBeNull();
      expect(lockPeriodDatesOf({ ...dated, [key]: 20270111 })).toBeNull();
      const { [key]: _gone, ...rest } = dated;
      expect(lockPeriodDatesOf(rest)).toBeNull();
    }
  });
});

describe("periodDay", () => {
  it("writes a day of the läsår out in the reader's language, as the day it was written", () => {
    expect(periodDay("2027-01-11", "sv")).toBe("11 januari 2027");
    expect(periodDay("2027-01-11", "en")).toBe("11 January 2027");
    // The first and the last day of a year stay in it, whatever the reader's clock.
    expect(periodDay("2026-12-31", "sv")).toBe("31 december 2026");
    expect(periodDay("2027-01-01", "en")).toBe("1 January 2027");
  });
});
