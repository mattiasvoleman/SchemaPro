import { describe, expect, it } from "vitest";
import { anyMealDated, dayWithin, mealHoldsDay, mealMeetsWindow, mealsOnDay, mealWeeksOf } from "./lunch-window";

const autumn = { startDate: null, endDate: "2026-12-20" };
const spring = { startDate: "2027-01-11", endDate: null };
const wholeYear = { startDate: null, endDate: null };
const march = { startDate: "2027-03-01", endDate: "2027-03-07" };

describe("mealHoldsDay", () => {
  it("holds every day for a meal with no dates, as every meal did", () => {
    expect(mealHoldsDay(wholeYear, "2026-08-15")).toBe(true);
    expect(mealHoldsDay({}, "2099-01-01")).toBe(true);
  });

  it("holds both of its own ends and nothing outside them", () => {
    expect(mealHoldsDay(march, "2027-03-01")).toBe(true);
    expect(mealHoldsDay(march, "2027-03-07")).toBe(true);
    expect(mealHoldsDay(march, "2027-02-28")).toBe(false);
    expect(mealHoldsDay(march, "2027-03-08")).toBe(false);
  });

  it("is open at the end a null stands for", () => {
    expect(mealHoldsDay(autumn, "2026-08-15")).toBe(true);
    expect(mealHoldsDay(autumn, "2026-12-21")).toBe(false);
    expect(mealHoldsDay(spring, "2027-01-10")).toBe(false);
    expect(mealHoldsDay(spring, "2027-06-30")).toBe(true);
  });
});

describe("mealMeetsWindow", () => {
  it("meets every lesson with no window: the stricter reading", () => {
    expect(mealMeetsWindow(autumn, null)).toBe(true);
    expect(mealMeetsWindow(march, undefined)).toBe(true);
    expect(mealMeetsWindow(march, wholeYear)).toBe(true);
  });

  it("does not meet a lesson of the other part of the year, and meets one that shares a day", () => {
    expect(mealMeetsWindow(spring, { startDate: "2026-08-17", endDate: "2026-12-18" })).toBe(false);
    expect(mealMeetsWindow(autumn, { startDate: "2027-01-11", endDate: "2027-06-11" })).toBe(false);
    expect(mealMeetsWindow(autumn, { startDate: "2026-12-20", endDate: "2027-01-31" })).toBe(true);
    expect(mealMeetsWindow(spring, { startDate: "2026-09-01", endDate: "2027-01-11" })).toBe(true);
  });

  it("reads a lesson with one bound as far as that bound reaches", () => {
    expect(mealMeetsWindow(march, { startDate: "2027-03-08", endDate: null })).toBe(false);
    expect(mealMeetsWindow(march, { startDate: null, endDate: "2027-02-28" })).toBe(false);
    expect(mealMeetsWindow(march, { startDate: "2027-03-05", endDate: null })).toBe(true);
  });
});

describe("the helpers a screen asks", () => {
  it("knows whether any meal holds only some weeks", () => {
    expect(anyMealDated([wholeYear, {}])).toBe(false);
    expect(anyMealDated([wholeYear, spring])).toBe(true);
    expect(anyMealDated([])).toBe(false);
  });

  it("keeps the meals of a day, and one meal of a class that eats at two times", () => {
    expect(mealsOnDay([autumn, spring], "2026-10-05")).toEqual([autumn]);
    expect(mealsOnDay([autumn, spring], "2027-02-01")).toEqual([spring]);
    expect(mealsOnDay([autumn, spring], "2026-12-29")).toEqual([]);
  });

  it("says nothing of a meal of the whole läsår, and the bounds of one of some weeks", () => {
    const say = (day: string) => `<${day}>`;
    expect(mealWeeksOf(wholeYear, say)).toBeNull();
    expect(mealWeeksOf(autumn, say)).toEqual({ kind: "to", from: "", to: "<2026-12-20>" });
    expect(mealWeeksOf(spring, say)).toEqual({ kind: "from", from: "<2027-01-11>", to: "" });
    expect(mealWeeksOf(march, say)).toEqual({ kind: "between", from: "<2027-03-01>", to: "<2027-03-07>" });
  });

  it("clamps a day to the läsår", () => {
    expect(dayWithin("2026-07-01", "2026-08-15", "2027-06-11")).toBe("2026-08-15");
    expect(dayWithin("2027-07-01", "2026-08-15", "2027-06-11")).toBe("2027-06-11");
    expect(dayWithin("2026-11-13", "2026-08-15", "2027-06-11")).toBe("2026-11-13");
    expect(dayWithin("2026-11-13", undefined, undefined)).toBe("2026-11-13");
  });
});
