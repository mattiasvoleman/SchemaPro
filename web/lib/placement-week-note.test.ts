import { describe, expect, it } from "vitest";
import { shortDay, weekNote, windowNote } from "@/lib/placement-week-note";

/** What a card says of its weeks: the parity and the dates, the short way where the window is a whole term and the dates where it is not. */

/** The echo of the page's note translator: the key, and the values in the order they were given. */
const t = (key: string, values?: Record<string, string>): string => (values ? `${key}(${Object.values(values).join("|")})` : key);

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
