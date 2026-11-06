import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sv from "@/messages/sv.json";
import {
  DEFAULT_SORT,
  OPEN_AFTER_DAYS,
  REPORTING_PERIODS,
  ariaSortOf,
  neighbourAnchor,
  nextSort,
  oldestFirst,
  openOf,
  percentOf,
  sortTeachers,
  type OpenLesson,
  type ReportingRateView,
  type ReportingTeacherRow,
} from "./reporting-rate";

const row = (id: string, lastName: string, firstName: string, held: number, reported: number): ReportingTeacherRow => ({
  teacherId: id,
  firstName,
  lastName,
  held,
  reported,
});

const ROWS = [
  row("t-4", "Lind", "Anna", 12, 9),
  row("t-1", "Ek", "Bo", 14, 14),
  row("t-2", "Ås", "Cecilia", 6, 2),
  row("t-3", "Berg", "David", 3, 3),
  row("t-5", "Holm", "Eva", 5, 0),
];

const names = (rows: ReportingTeacherRow[]) => rows.map((one) => one.lastName);

describe("the share of reported lessons", () => {
  it("is a whole percent, and nothing at all when nothing was held", () => {
    expect(percentOf({ held: 12, reported: 9 })).toBe(75);
    expect(percentOf({ held: 6, reported: 2 })).toBe(33);
    expect(percentOf({ held: 14, reported: 14 })).toBe(100);
    expect(percentOf({ held: 5, reported: 0 })).toBe(0);
    // A rate of nothing is not 0 %.
    expect(percentOf({ held: 0, reported: 0 })).toBeNull();
  });

  it("is never 100 while a lesson is open, however close it rounds", () => {
    expect(percentOf({ held: 1000, reported: 998 })).toBe(99);
    expect(percentOf({ held: 300, reported: 299 })).toBe(99);
    // And not above 100 if a figure ever says more were reported than held.
    expect(percentOf({ held: 4, reported: 5 })).toBe(100);
  });

  it("counts the open lessons as held minus reported, never below zero", () => {
    expect(openOf({ held: 12, reported: 9 })).toBe(3);
    expect(openOf({ held: 4, reported: 5 })).toBe(0);
  });
});

describe("sorting the teachers", () => {
  it("opens on the lowest share first, those at 100 % last in name order", () => {
    expect(DEFAULT_SORT).toEqual({ key: "share", direction: "asc" });
    expect(names(sortTeachers(ROWS, DEFAULT_SORT))).toEqual(["Holm", "Ås", "Lind", "Berg", "Ek"]);
  });

  it("breaks a tie on the name, the same way whichever way the column goes", () => {
    // Ek and Berg both stand at 100 %.
    expect(names(sortTeachers(ROWS, { key: "share", direction: "desc" }))).toEqual(["Berg", "Ek", "Lind", "Ås", "Holm"]);
  });

  it("puts equal fractions together: 1 of 3 and 2 of 6 are the same share", () => {
    const equal = [row("a", "Sten", "Per", 6, 2), row("b", "Berg", "Lo", 3, 1), row("c", "Ask", "Ul", 3, 2)];
    expect(names(sortTeachers(equal, DEFAULT_SORT))).toEqual(["Berg", "Sten", "Ask"]);
  });

  it("sorts on each of the other columns", () => {
    expect(names(sortTeachers(ROWS, { key: "teacher", direction: "asc" }))).toEqual(["Berg", "Ek", "Holm", "Lind", "Ås"]);
    expect(names(sortTeachers(ROWS, { key: "held", direction: "desc" }))).toEqual(["Ek", "Lind", "Ås", "Holm", "Berg"]);
    expect(names(sortTeachers(ROWS, { key: "reported", direction: "desc" }))).toEqual(["Ek", "Lind", "Berg", "Ås", "Holm"]);
    // Open: Lind 3, Ås 4, Holm 5, Ek and Berg 0.
    expect(names(sortTeachers(ROWS, { key: "open", direction: "desc" }))).toEqual(["Holm", "Ås", "Lind", "Berg", "Ek"]);
  });

  it("writes Swedish names in Swedish order: Å after Z", () => {
    expect(names(sortTeachers([row("1", "Ås", "A", 1, 1), row("2", "Zetterberg", "B", 1, 1)], { key: "teacher", direction: "asc" }))).toEqual([
      "Zetterberg",
      "Ås",
    ]);
  });

  it("leaves the rows it was given alone", () => {
    const before = names(ROWS);
    sortTeachers(ROWS, { key: "held", direction: "asc" });
    expect(names(ROWS)).toEqual(before);
  });
});

describe("pressing a column", () => {
  it("turns the same column round", () => {
    expect(nextSort({ key: "share", direction: "asc" }, "share")).toEqual({ key: "share", direction: "desc" });
    expect(nextSort({ key: "share", direction: "desc" }, "share")).toEqual({ key: "share", direction: "asc" });
  });

  it("starts another column where its reader looks first: names A to Ö, the lowest share, the most lessons", () => {
    expect(nextSort(DEFAULT_SORT, "teacher")).toEqual({ key: "teacher", direction: "asc" });
    expect(nextSort({ key: "held", direction: "desc" }, "share")).toEqual({ key: "share", direction: "asc" });
    expect(nextSort(DEFAULT_SORT, "held")).toEqual({ key: "held", direction: "desc" });
    expect(nextSort(DEFAULT_SORT, "reported")).toEqual({ key: "reported", direction: "desc" });
    expect(nextSort(DEFAULT_SORT, "open")).toEqual({ key: "open", direction: "desc" });
  });

  it("says aria-sort on the sorted column alone", () => {
    expect(ariaSortOf(DEFAULT_SORT, "share")).toBe("ascending");
    expect(ariaSortOf({ key: "held", direction: "desc" }, "held")).toBe("descending");
    expect(ariaSortOf(DEFAULT_SORT, "teacher")).toBeUndefined();
  });
});

describe("the arrows between periods", () => {
  const view = (over: Partial<ReportingRateView>): ReportingRateView => ({
    period: "WEEK",
    anchor: "2026-11-04",
    from: "2026-11-02",
    to: "2026-11-08",
    yearName: null,
    previousAnchor: "2026-11-01",
    nextAnchor: "2026-11-09",
    through: "2026-11-03",
    total: { held: 0, reported: 0 },
    teachers: [],
    ...over,
  });

  it("take the days the gateway names for a week and a month", () => {
    expect(neighbourAnchor(view({}), -1)).toBe("2026-11-01");
    expect(neighbourAnchor(view({}), 1)).toBe("2026-11-09");
    const month = view({ period: "MONTH", from: "2026-11-01", to: "2026-11-30", previousAnchor: "2026-10-31", nextAnchor: "2026-12-01" });
    expect(neighbourAnchor(month, -1)).toBe("2026-10-31");
    expect(neighbourAnchor(month, 1)).toBe("2026-12-01");
  });

  it("aim into the neighbouring läsår, not at the summer between two: the day before one starts has no läsår", () => {
    // 2026/27 runs 17 August to 11 June; the day before it, 16 August, is in the gap.
    const year = view({ period: "YEAR", from: "2026-08-17", to: "2027-06-11", yearName: "2026/27", previousAnchor: "2026-08-16", nextAnchor: "2027-06-12" });
    expect(neighbourAnchor(year, -1)).toBe("2026-01-13");
    expect(neighbourAnchor(year, 1)).toBe("2028-01-13");
    // Mid-year is inside a year that starts in mid-August and ends in mid-June, or on the first of July and the 30th of June.
    for (const [from, to] of [["2025-08-18", "2026-06-10"], ["2025-07-01", "2026-06-30"]] as const) {
      const middle = neighbourAnchor(year, -1)!;
      expect(middle >= from && middle <= to).toBe(true);
    }
  });

  it("have nowhere to go from a period that does not exist", () => {
    const none = view({ period: "YEAR", from: null, to: null, previousAnchor: null, nextAnchor: null });
    expect(neighbourAnchor(none, -1)).toBeNull();
    expect(neighbourAnchor(none, 1)).toBeNull();
  });
});

describe("the open lessons", () => {
  const lesson = (lessonId: string, startsAt: string): OpenLesson => ({
    lessonId,
    date: startsAt.slice(0, 10),
    startsAt,
    endsAt: startsAt,
    subjectName: "Svenska",
    groupName: "7A",
    overdue: false,
  });

  it("come oldest first, whatever order they were sent in", () => {
    const sent = [
      lesson("c", "2026-11-03T08:10:00.000Z"),
      lesson("a", "2026-11-02T10:40:00.000Z"),
      lesson("b", "2026-11-02T08:10:00.000Z"),
    ];
    expect(oldestFirst(sent).map((one) => one.lessonId)).toEqual(["b", "a", "c"]);
    // And the list it was given is left as it was.
    expect(sent.map((one) => one.lessonId)).toEqual(["c", "a", "b"]);
  });

  it("order two lessons at the same time by id, so the list does not shuffle between reads", () => {
    const same = "2026-11-02T08:10:00.000Z";
    expect(oldestFirst([lesson("z", same), lesson("m", same)]).map((one) => one.lessonId)).toEqual(["m", "z"]);
  });
});

/**
 * The web's copy of the gateway's vocabulary and bounds. The gateway's file
 * (src/reporting-rate/reporting-rate.ts, the root of the DTOs) is read as text,
 * because the web cannot import it, and the two must say the same: a limit
 * that differs is a select that offers what the gateway refuses, or one that
 * leaves out what it would take.
 */
describe("the vocabulary and the bounds are the gateway's", () => {
  const GATEWAY = readFileSync(join(__dirname, "..", "..", "src", "reporting-rate", "reporting-rate.ts"), "utf8");
  const numberOf = (name: string): number => Number(new RegExp(`export const ${name} = (\\d+)`).exec(GATEWAY)?.[1]);

  it("says the same periods", () => {
    const line = /export const REPORTING_PERIODS = \[([^\]]*)\]/.exec(GATEWAY)?.[1] ?? "";
    expect([...REPORTING_PERIODS]).toEqual([...line.matchAll(/'([A-Z]+)'/g)].map((match) => match[1]));
  });

  it("says the same limit in days, and the same default", () => {
    const found = /export const OPEN_AFTER_DAYS = \{ min: (\d+), max: (\d+) \}/.exec(GATEWAY);
    expect({ min: OPEN_AFTER_DAYS.min, max: OPEN_AFTER_DAYS.max }).toEqual({ min: Number(found?.[1]), max: Number(found?.[2]) });
    expect(OPEN_AFTER_DAYS.standard).toBe(numberOf("DEFAULT_OPEN_AFTER_DAYS"));
  });

  it("tells the teacher how far back the list of open lessons looks, as many days as the gateway asks for", () => {
    const days = numberOf("OPEN_LESSONS_DAYS");
    expect(days).toBeGreaterThan(0);
    expect(sv.reportingRate.teacher.open.description).toContain(`de senaste ${days} dagarna`);
    expect(sv.reportingRate.teacher.open.emptyBody).toContain(`de senaste ${days} dagarna`);
  });
});
