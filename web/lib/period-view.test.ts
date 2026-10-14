import { describe, expect, it } from "vitest";
import { isJudged, percentSteps, percentStepsIn, postAtStart } from "./period-view";

describe("isJudged", () => {
  it("judges a stretch with a taught week, and neither one that holds no Monday nor one that is all lov", () => {
    expect(isJudged({ effectiveFrom: "2026-11-02", teachingWeeks: 31 })).toBe(true);
    expect(isJudged({ effectiveFrom: null, teachingWeeks: 0 })).toBe(false);
    // Jullov: whole weeks, none of them taught.
    expect(isJudged({ effectiveFrom: "2026-12-21", teachingWeeks: 0 })).toBe(false);
  });
});

describe("percentSteps", () => {
  it("names each change of the tjänstgöringsgrad once, in date order", () => {
    expect(percentSteps([{ employmentPercent: 100 }, { employmentPercent: 50 }])).toEqual([100, 50]);
    expect(percentSteps([{ employmentPercent: 100 }, { employmentPercent: 80 }, { employmentPercent: 100 }])).toEqual([
      100, 80, 100,
    ]);
    // A period that changes only the nedsättning leaves the grad as it was.
    expect(percentSteps([{ employmentPercent: 100 }, { employmentPercent: 100 }])).toEqual([100]);
    expect(percentSteps([])).toEqual([]);
  });
});

describe("percentStepsIn and postAtStart", () => {
  const employment = {
    userId: "t-anna",
    employmentPercent: 100,
    reductionPercent: 0,
    contractKind: "FERIE" as const,
    teachingTargetMinutesPerWeek: null,
    signature: "ANN",
  };
  const stretch = (from: string, to: string, employmentPercent: number, reductionPercent = 0) =>
    ({ from, to, employmentPercent, reductionPercent }) as NonNullable<Parameters<typeof percentStepsIn>[0]["periods"]>[number];
  const changing = {
    employment,
    periods: [stretch("2026-08-17", "2026-08-30", 80, 10), stretch("2026-08-31", "2027-01-10", 100), stretch("2027-01-11", "2027-06-11", 50)],
  };

  it("gives a range the steps of the stretches it touches, and a post the same all year its own grad", () => {
    expect(percentStepsIn(changing, "2026-09-01", "2026-10-31")).toEqual([100]);
    expect(percentStepsIn(changing, "2026-12-01", "2027-02-28")).toEqual([100, 50]);
    expect(percentStepsIn({ employment, periods: [] }, "2026-09-01", "2026-10-31")).toEqual([100]);
    expect(percentStepsIn({ employment: null, periods: [] }, "2026-09-01", "2026-10-31")).toEqual([]);
  });

  it("states the post on the läsår's first day: a period from the first day, not the base row", () => {
    expect(postAtStart(changing)).toEqual({ employmentPercent: 80, reductionPercent: 10 });
    expect(postAtStart({ employment, periods: [] })).toEqual({ employmentPercent: 100, reductionPercent: 0 });
    expect(postAtStart({ employment: null })).toBeNull();
  });
});
