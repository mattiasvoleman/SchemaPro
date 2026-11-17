import { describe, expect, it } from "vitest";
import {
  addDays,
  datesOfWeek,
  isoWeekOf,
  mondayOf,
  nearestWeekOf,
  parityOfDay,
  runsInWeek,
  shortDay,
  termOfWeek,
  weekNote,
  weeksOfYear,
  windowNote,
  yearWeekOf,
} from "@/lib/placement-weeks";

/**
 * The weeks of a läsår, as a school counts them. The facts the tests are written from are written out by hand, not computed the way
 * the code computes them: 2026 is an ISO year of 53 weeks (it starts on a Thursday), so week 53 and week 1 of 2027 are both odd.
 */

/** The echo of the page's note translator: the key, and the values in the order they were given. */
const t = (key: string, values?: Record<string, string>): string => (values ? `${key}(${Object.values(values).join("|")})` : key);

describe("week numbers and parity: the server's own (src/calendar/lesson-recurrence.ts)", () => {
  it.each([
    ["2026-08-17", 34],
    ["2026-08-23", 34],
    ["2026-08-15", 33],
    ["2026-12-21", 52],
    ["2026-12-28", 53],
    ["2027-01-01", 53],
    ["2027-01-03", 53],
    ["2027-01-04", 1],
    ["2027-06-07", 23],
  ])("%s is in week %i", (day, week) => {
    expect(isoWeekOf(day)).toBe(week);
  });

  it("has two odd weeks in a row where an ISO year of 53 weeks ends (53, then 1): parity is the week NUMBER's, not turn by turn", () => {
    expect(parityOfDay("2026-12-21")).toBe("EVEN_WEEKS");
    expect(parityOfDay("2026-12-28")).toBe("ODD_WEEKS");
    expect(parityOfDay("2027-01-04")).toBe("ODD_WEEKS");
    expect(parityOfDay("2027-01-11")).toBe("EVEN_WEEKS");
  });

  it("finds the Monday of any day of a week, Sunday included", () => {
    for (const day of ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23"]) expect(mondayOf(day)).toBe("2026-08-17");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2027-03-01", -1)).toBe("2027-02-28");
  });
});

describe("the weeks of a läsår", () => {
  it("starts a year that begins on a Saturday on the Monday after it: the week that holds the Saturday has no school day in the year", () => {
    const weeks = weeksOfYear("2026-08-15", "2027-06-11");
    expect(weeks[0]!.monday).toBe("2026-08-17");
    expect(weeks[0]!.week).toBe(34);
    expect(weeks.some((week) => week.monday === "2026-08-10")).toBe(false);
  });

  // The first week of a year that starts any day from Saturday to Wednesday: written out by hand (memory periods-are-not-terms).
  it.each([
    ["2026-08-15", "2026-08-17"],
    ["2026-08-16", "2026-08-17"],
    ["2026-08-17", "2026-08-17"],
    ["2026-08-18", "2026-08-17"],
    ["2026-08-19", "2026-08-17"],
    ["2026-08-21", "2026-08-17"],
  ])("a year that starts %s has 2026-08-17 as its first week", (start, first) => {
    expect(weeksOfYear(start, "2027-06-11")[0]!.monday).toBe(first);
  });

  it("includes the week of a Friday start (one school day) but not the week of a Saturday start", () => {
    expect(weeksOfYear("2026-08-21", "2026-09-30")[0]!.monday).toBe("2026-08-17");
    expect(weeksOfYear("2026-08-22", "2026-09-30")[0]!.monday).toBe("2026-08-24");
  });

  it("ends on the week of the last day when it is a Monday and not after a Saturday", () => {
    expect(weeksOfYear("2026-08-17", "2027-06-14").at(-1)!.monday).toBe("2027-06-14");
    expect(weeksOfYear("2026-08-17", "2027-06-12").at(-1)!.monday).toBe("2027-06-07");
    expect(weeksOfYear("2026-08-17", "2027-06-13").at(-1)!.monday).toBe("2027-06-07");
  });

  it("is every Monday once, in order, and gives each week its Friday, number, parity and term", () => {
    const weeks = weeksOfYear("2026-08-15", "2027-06-11");
    expect(weeks).toHaveLength(43);
    for (let at = 1; at < weeks.length; at++) expect(weeks[at]!.monday).toBe(addDays(weeks[at - 1]!.monday, 7));
    expect(weeks[0]).toEqual({ monday: "2026-08-17", friday: "2026-08-21", week: 34, parity: "EVEN_WEEKS", term: "HT" });
    expect(weeks.at(-1)).toEqual({ monday: "2027-06-07", friday: "2027-06-11", week: 23, parity: "ODD_WEEKS", term: "VT" });
  });

  it("keeps the two odd weeks at the turn of an ISO year of 53 weeks, and never alternates by position", () => {
    const weeks = weeksOfYear("2026-08-15", "2027-06-11");
    const at = weeks.findIndex((week) => week.monday === "2026-12-28");
    expect(weeks[at - 1]!.parity).toBe("EVEN_WEEKS");
    expect(weeks[at]!.week).toBe(53);
    expect(weeks[at]!.parity).toBe("ODD_WEEKS");
    expect(weeks[at + 1]!.week).toBe(1);
    expect(weeks[at + 1]!.parity).toBe("ODD_WEEKS");
    expect(weeks[at + 2]!.parity).toBe("EVEN_WEEKS");
  });

  it("is empty for a year that ends before it starts, and bounded for a year that never ends", () => {
    expect(weeksOfYear("2026-08-15", "2026-08-01")).toEqual([]);
    expect(weeksOfYear("2026-08-15", "9999-12-31").length).toBeLessThanOrEqual(120);
  });

  it("puts a week in the term its Thursday is in: the week that holds New Year's Day is the spring's when its Thursday is in January", () => {
    expect(termOfWeek("2026-12-21")).toBe("HT");
    expect(termOfWeek("2026-12-28")).toBe("HT");
    expect(termOfWeek("2027-01-04")).toBe("VT");
    expect(termOfWeek("2026-08-17")).toBe("HT");
    expect(termOfWeek("2027-06-07")).toBe("VT");
    expect(yearWeekOf("2027-01-04")).toMatchObject({ week: 1, parity: "ODD_WEEKS", term: "VT" });
  });
});

describe("which weeks a lesson runs in", () => {
  const every = { recurrence: "ALL_WEEKS" as const, startDate: null, endDate: null };

  it("runs a lesson of every week in every week", () => {
    expect(runsInWeek(every, 3, "2026-08-17")).toBe(true);
    expect(runsInWeek(every, 3, "2026-08-24")).toBe(true);
  });

  it("runs an odd-weeks lesson in the odd weeks only, and an even-weeks lesson in the even ones", () => {
    const odd = { ...every, recurrence: "ODD_WEEKS" as const };
    const even = { ...every, recurrence: "EVEN_WEEKS" as const };
    expect(runsInWeek(odd, 2, "2026-08-17")).toBe(false); // week 34
    expect(runsInWeek(odd, 2, "2026-08-24")).toBe(true); // week 35
    expect(runsInWeek(even, 2, "2026-08-17")).toBe(true);
    expect(runsInWeek(even, 2, "2026-08-24")).toBe(false);
    // week 53 and week 1: both odd
    expect(runsInWeek(odd, 2, "2026-12-28")).toBe(true);
    expect(runsInWeek(odd, 2, "2027-01-04")).toBe(true);
    expect(runsInWeek(even, 2, "2027-01-04")).toBe(false);
  });

  it("asks the lesson's OWN DAY of the week against its dates: a window that ends on a Tuesday holds that week's Tuesday and not its Thursday", () => {
    const untilTuesday = { ...every, endDate: "2026-12-15" };
    expect(runsInWeek(untilTuesday, 2, "2026-12-14")).toBe(true);
    expect(runsInWeek(untilTuesday, 4, "2026-12-14")).toBe(false);
    expect(runsInWeek(untilTuesday, 1, "2026-12-21")).toBe(false);
  });

  it("starts a window on its day: the Monday before a Wednesday start is not in it, the Wednesday is", () => {
    const fromWednesday = { ...every, startDate: "2026-08-19" };
    expect(runsInWeek(fromWednesday, 1, "2026-08-17")).toBe(false);
    expect(runsInWeek(fromWednesday, 3, "2026-08-17")).toBe(true);
    expect(runsInWeek(fromWednesday, 5, "2026-08-17")).toBe(true);
  });

  it("holds an HT post out of the spring and a VT post out of the autumn", () => {
    const autumn = { ...every, endDate: "2026-12-18" };
    const spring = { ...every, startDate: "2027-01-11" };
    expect(runsInWeek(autumn, 3, "2026-12-14")).toBe(true);
    expect(runsInWeek(autumn, 3, "2027-01-11")).toBe(false);
    expect(runsInWeek(spring, 3, "2026-12-14")).toBe(false);
    expect(runsInWeek(spring, 3, "2027-01-11")).toBe(true);
  });

  it("takes a date that comes with a time of day as the day it is", () => {
    expect(runsInWeek({ ...every, startDate: "2026-08-19T00:00:00.000Z" }, 1, "2026-08-17")).toBe(false);
  });
});

describe("the week of the other parity, for the other half of a pair", () => {
  const weeks = weeksOfYear("2026-08-15", "2027-06-11");

  it("is the next week when it has the parity, else the one before", () => {
    expect(nearestWeekOf(weeks, "2026-08-17", "ODD_WEEKS")!.monday).toBe("2026-08-24");
    expect(nearestWeekOf(weeks, "2026-08-24", "EVEN_WEEKS")!.monday).toBe("2026-08-31");
  });

  it("goes back across the end of an ISO year of 53 weeks: the week after week 53 is odd too", () => {
    // From week 53 (odd) asking for an even week: week 1 (the next) is odd, so the one before, week 52.
    expect(nearestWeekOf(weeks, "2026-12-28", "EVEN_WEEKS")!.monday).toBe("2026-12-21");
    // From week 1 (odd): the next, week 2, is even.
    expect(nearestWeekOf(weeks, "2027-01-04", "EVEN_WEEKS")!.monday).toBe("2027-01-11");
  });

  it("is the last week asking forward from it, then the one before", () => {
    expect(nearestWeekOf(weeks, "2027-06-07", "EVEN_WEEKS")!.monday).toBe("2027-05-31");
  });

  it("is null for a week that is not in the year and for a year with no week of that parity", () => {
    expect(nearestWeekOf(weeks, "2026-08-10", "ODD_WEEKS")).toBeNull();
    expect(nearestWeekOf([yearWeekOf("2026-08-24")], "2026-08-24", "EVEN_WEEKS")).toBeNull();
  });
});

describe("what a card says of the dates it runs", () => {
  const year = { startDate: "2026-08-15", endDate: "2027-06-11" };
  const note = (startDate: string | null, endDate: string | null) => windowNote({ startDate, endDate }, year, "sv", t);

  it("says nothing for a lesson that runs the whole year", () => {
    expect(note(null, null)).toBeNull();
  });

  it("says HT for the autumn's whole (no start, or from the year's start, to a day in December)", () => {
    expect(note(null, "2026-12-18")).toBe("HT");
    expect(note("2026-08-15", "2026-12-18")).toBe("HT");
    expect(note("2026-08-10", "2026-12-31")).toBe("HT");
  });

  it("says VT for the spring's whole (from a day in January to the year's end)", () => {
    expect(note("2027-01-11", null)).toBe("VT");
    expect(note("2027-01-11", "2027-06-11")).toBe("VT");
    expect(note("2027-01-11", "2027-06-30")).toBe("VT");
  });

  it("says the dates where the window is not a whole term: it is always true, HT and VT are only the short way of saying the clean ones", () => {
    expect(note("2026-08-24", "2026-10-30")).toBe("range(24 aug.|30 okt.)");
    expect(note(null, "2026-10-30")).toBe("until(30 okt.)");
    expect(note("2026-11-02", null)).toBe("from(2 nov.)");
    // Autumn from the 24th of August is not the whole autumn only by a week: it reads as dates, the cautious way.
    expect(note("2026-08-24", "2026-12-18")).toBe("range(24 aug.|18 dec.)");
    // A spring window that ends in March is not the spring.
    expect(note("2027-01-11", "2027-03-12")).toBe("range(11 jan.|12 mars)");
    // A window that starts in February is not a VT.
    expect(note("2027-02-01", null)).toBe("from(1 feb.)");
    // A window that ends in November is not an HT.
    expect(note(null, "2026-11-27")).toBe("until(27 nov.)");
  });

  it("writes the day in the reader's language", () => {
    expect(shortDay("2026-12-18", "sv")).toBe("18 dec.");
    expect(shortDay("2026-12-18", "en")).toBe("18 Dec");
  });
});

describe("what a card says of its weeks", () => {
  const year = { startDate: "2026-08-15", endDate: "2027-06-11" };

  it("says the parity and the dates together, parity first", () => {
    expect(weekNote({ recurrence: "ODD_WEEKS", startDate: null, endDate: "2026-12-18" }, year, "sv", t)).toBe("odd · HT");
    expect(weekNote({ recurrence: "EVEN_WEEKS", startDate: "2027-01-11", endDate: null }, year, "sv", t)).toBe("even · VT");
    expect(weekNote({ recurrence: "ODD_WEEKS", startDate: null, endDate: null }, year, "sv", t)).toBe("odd");
    expect(weekNote({ recurrence: "ALL_WEEKS", startDate: null, endDate: "2026-10-30" }, year, "sv", t)).toBe("until(30 okt.)");
  });

  it("says nothing for a lesson of every week of the whole year", () => {
    expect(weekNote({ recurrence: "ALL_WEEKS", startDate: null, endDate: null }, year, "sv", t)).toBeNull();
  });

  it("says 'period' where the year is not known, as the grid always has", () => {
    expect(weekNote({ recurrence: "ALL_WEEKS", startDate: "2026-09-01", endDate: null }, null, "sv", t)).toBe("period");
    expect(weekNote({ recurrence: "EVEN_WEEKS", startDate: null, endDate: null }, null, "sv", t)).toBe("even");
  });
});

describe("the dates under the week's days", () => {
  it("gives Monday to Friday as local days, across a month and a year", () => {
    expect(datesOfWeek("2026-12-28").map((date) => [date.getFullYear(), date.getMonth() + 1, date.getDate()])).toEqual([
      [2026, 12, 28],
      [2026, 12, 29],
      [2026, 12, 30],
      [2026, 12, 31],
      [2027, 1, 1],
    ]);
  });
});
