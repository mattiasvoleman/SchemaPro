import { describe, expect, it } from "vitest";
import { travelOf } from "./staffing-travel";

describe("travelOf", () => {
  it("is nothing at a school with no travel figure, whoever asks", () => {
    expect(travelOf(undefined, "t")).toBeNull();
    expect(travelOf({ travel: null }, "t")).toBeNull();
    expect(travelOf({}, "t")).toBeNull();
  });

  it("is the teacher's walks, or none at all at a school that has a figure", () => {
    const report = { travel: { teachers: [{ userId: "anna", minutesPerWeek: 30, peakMinutesPerWeek: 45, hoursPerYear: 19.5 }] } };
    expect(travelOf(report, "anna")).toEqual({ userId: "anna", minutesPerWeek: 30, peakMinutesPerWeek: 45, hoursPerYear: 19.5 });
    expect(travelOf(report, "bo")).toEqual({ userId: "bo", minutesPerWeek: 0, peakMinutesPerWeek: 0, hoursPerYear: 0 });
  });
});
