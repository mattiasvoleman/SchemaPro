import { describe, expect, it } from "vitest";
import { fitsAServing, servingsFor, type LunchServing } from "@/lib/lunch-servings";

const serving = (
  id: string,
  min: number,
  max: number,
  start: string,
  end: string,
  dayOfWeek: number | null = null,
): LunchServing => ({
  id,
  minGradeLevel: min,
  maxGradeLevel: max,
  dayOfWeek,
  startTime: `${start}:00`,
  endTime: `${end}:00`,
  seats: null,
});

const span = (min: number, max: number) => ({ min, max });
const ids = (rows: LunchServing[]) => rows.map((row) => row.id);

describe("servingsFor", () => {
  it("says nothing when the school has declared none", () => {
    // Empty means "no sitting speaks about this stage", which leaves the
    // school-wide lunch window in place — not a refusal.
    expect(servingsFor([], span(4, 6), 1)).toEqual([]);
  });

  it("ignores a sitting written for another stage", () => {
    expect(ids(servingsFor([serving("a", 7, 9, "12:20", "13:00")], span(4, 4), 1))).toEqual(
      [],
    );
  });

  it("says nothing about a group whose years are unknown", () => {
    expect(servingsFor([serving("a", 0, 12, "11:00", "11:40")], undefined, 1)).toEqual([]);
  });

  it("matches on overlap, not containment", () => {
    // A 3-4 group touches a 4-6 sitting at exactly one year, and its year-4
    // children are the ones the sitting is about.
    const rows = [serving("a", 4, 6, "11:40", "12:20")];
    expect(ids(servingsFor(rows, span(3, 4), 1))).toEqual(["a"]);
    expect(ids(servingsFor(rows, span(2, 3), 1))).toEqual([]);
  });

  it("gives a straddling group both stages' sittings", () => {
    /*
     * UNION, and the opposite of what frames do. Intersecting a 4-6 sitting
     * with a 7-9 one leaves a 6-7 group nowhere — two disjoint windows have no
     * overlap — and the class would be refused a meal the school has room for
     * twice over.
     */
    const rows = [serving("a", 4, 6, "11:40", "12:20"), serving("b", 7, 9, "12:20", "13:00")];
    expect(ids(servingsFor(rows, span(6, 7), 1))).toEqual(["a", "b"]);
  });

  it("lets a weekday row replace the every-day row rather than widen it", () => {
    const rows = [
      serving("all", 7, 9, "12:20", "13:00"),
      serving("fri", 7, 9, "11:40", "12:20", 5),
    ];

    expect(ids(servingsFor(rows, span(7, 9), 1))).toEqual(["all"]);
    expect(ids(servingsFor(rows, span(7, 9), 5))).toEqual(["fri"]);
  });

  it("keeps every wave a school wrote by hand for one stage", () => {
    // No unique key on the table, precisely so a hall smaller than its 7-9 can
    // have both waves written down.
    const rows = [
      serving("first", 7, 9, "11:40", "12:10"),
      serving("second", 7, 9, "12:20", "12:50"),
    ];
    expect(ids(servingsFor(rows, span(7, 9), 1))).toEqual(["first", "second"]);
  });
});

describe("fitsAServing", () => {
  it("is true when nothing was declared", () => {
    expect(fitsAServing([], span(4, 6), 1, 30)).toBe(true);
  });

  it("is true when a sitting is long enough", () => {
    expect(fitsAServing([serving("a", 4, 6, "11:40", "12:20")], span(4, 6), 1, 30)).toBe(
      true,
    );
  });

  it("is true at exactly the meal's length", () => {
    expect(fitsAServing([serving("a", 4, 6, "11:00", "11:30")], span(4, 6), 1, 30)).toBe(
      true,
    );
  });

  it("is false when the only sitting is shorter than the meal", () => {
    expect(fitsAServing([serving("a", 4, 6, "11:00", "11:20")], span(4, 6), 1, 30)).toBe(
      false,
    );
  });

  it("is true when one of several waves is long enough", () => {
    // The short wave contributes nothing rather than condemning the stage.
    const rows = [
      serving("short", 7, 9, "11:40", "11:50"),
      serving("long", 7, 9, "12:20", "12:50"),
    ];
    expect(fitsAServing(rows, span(7, 9), 1, 30)).toBe(true);
  });

  it("reads the weekday's own sittings, not the week's", () => {
    const rows = [
      serving("all", 7, 9, "12:00", "13:00"),
      serving("fri", 7, 9, "11:40", "11:50", 5),
    ];
    expect(fitsAServing(rows, span(7, 9), 1, 30)).toBe(true);
    expect(fitsAServing(rows, span(7, 9), 5, 30)).toBe(false);
  });
});
