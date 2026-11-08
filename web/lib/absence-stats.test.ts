import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_PERIOD_DAYS,
  MIN_GROUP,
  NO_PUPILS_FOR_THE_READER,
  PERIOD_CHOICES,
  addDays,
  availableChoices,
  chartCeiling,
  groupByYear,
  isGoingOn,
  monthEnd,
  monthStart,
  periodOfChoice,
  periodQuery,
  pointsOfPupil,
  pointsOfSeries,
  schoolYearName,
  schoolYearStart,
  shiftMonth,
  type ChartPoint,
  type Figures,
  type PupilMonthView,
  type SeriesMonthView,
  type WindowView,
} from "./absence-stats";

/**
 * The web's copy of the gateway's bounds and codes, and the helpers that pick
 * a period, group months under their läsår and scale a chart. Nothing here
 * counts absence: the minutes and the percents come finished from the gateway.
 * Its file (src/absence-stats/absence-stats.ts) is read as text, because the
 * web cannot import it, and the two must say the same.
 */
const GATEWAY = readFileSync(join(__dirname, "..", "..", "src", "absence-stats", "absence-stats.ts"), "utf8");
const SERVICE = readFileSync(join(__dirname, "..", "..", "src", "absence-stats", "absence-stats.service.ts"), "utf8");

const numberOf = (name: string): number => Number(new RegExp(`export const ${name} = (\\d+)`).exec(GATEWAY)?.[1]);
const stringOf = (name: string): string | undefined => new RegExp(`export const ${name} = '([A-Z_]+)'`).exec(GATEWAY)?.[1];

/** The field names of an exported interface of one of the gateway's files. */
function fieldsOf(source: string, name: string): string[] {
  const body = new RegExp(`export interface ${name}(?: extends \\w+)? \\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? "";
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]!);
}

describe("the bounds and the codes are the gateway's", () => {
  it("says the same smallest group and longest period", () => {
    expect(MIN_GROUP).toBe(numberOf("MIN_GROUP"));
    expect(MAX_PERIOD_DAYS).toBe(numberOf("MAX_PERIOD_DAYS"));
  });

  it("knows the code of the refusal the huvudman's läsare gets for a pupil", () => {
    expect(NO_PUPILS_FOR_THE_READER).toBe(stringOf("ABSENCE_STATS_NO_PUPILS_FOR_THE_READER"));
  });

  it("reads the views with the fields the gateway sends", () => {
    // A field the gateway renames would make a page read undefined as a figure: the names are pinned here.
    const figures = fieldsOf(GATEWAY, "Figures");
    expect(figures).toEqual(["invalidMinutes", "validPct", "invalidPct", "totalPct"]);
    expect(fieldsOf(GATEWAY, "RawFigures")).toEqual(["recordedMinutes", "validMinutes", "absentMinutes", "lateMinutes", "lateCount"]);
    expect(fieldsOf(GATEWAY, "Reporting")).toEqual(["held", "reported", "ratePct"]);
    expect(fieldsOf(GATEWAY, "SeriesMonthView")).toEqual([
      "month",
      "throughDay",
      "partial",
      "classNames",
      "pupils",
      "pupilsRegistered",
      "figures",
      "reporting",
      "previousYear",
    ]);
    expect(fieldsOf(GATEWAY, "PupilMonthView")).toEqual(["month", "figures", "lessons", "previousYear"]);
    expect(fieldsOf(GATEWAY, "PatternsView")).toEqual(["groupSize", "suppressed", "weekdays", "slots", "subjects"]);
    expect(fieldsOf(SERVICE, "WindowView")).toEqual(["firstMonth", "today", "year", "minGroup"]);
    expect(fieldsOf(SERVICE, "ClassPupilsView")).toEqual(["window", "classId", "period", "pupils", "heldOut"]);
    expect(fieldsOf(SERVICE, "PupilStatsView")).toEqual([
      "window",
      "student",
      "marksFrom",
      "marksTo",
      "months",
      "total",
      "classSeries",
      "period",
      "patterns",
    ]);
  });
});

const WINDOW: WindowView = {
  firstMonth: "2024-08-01",
  today: "2026-11-07",
  year: { name: "2026/2027", from: "2026-08-17", to: "2027-06-11" },
  minGroup: 5,
};

describe("the dates of the school's calendar", () => {
  it("steps whole days and months without a time zone in the way", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
    expect(monthStart("2026-11-07")).toBe("2026-11-01");
    expect(shiftMonth("2026-11-07", -12)).toBe("2025-11-01");
    expect(shiftMonth("2026-12-15", 1)).toBe("2027-01-01");
    expect(monthEnd("2028-02-10")).toBe("2028-02-29");
  });

  it("knows the month that is going on, and no other", () => {
    // The figures run to yesterday: on the 1st the month before is the last one counted, and it is over.
    expect(isGoingOn("2026-11-01", "2026-11-07")).toBe(true);
    expect(isGoingOn("2026-10-01", "2026-11-07")).toBe(false);
    expect(isGoingOn("2026-10-01", "2026-11-01")).toBe(false);
    expect(isGoingOn("2026-11-01", "2026-12-01")).toBe(false);
  });
});

describe("the period a read covers", () => {
  it("asks for no dates at all for the läsår so far, which is the gateway's own default", () => {
    expect(periodOfChoice("YEAR", WINDOW)).toBeNull();
    expect(periodQuery(null)).toBe("");
  });

  it("names the previous läsår from the first of its first month to the last of its last", () => {
    expect(periodOfChoice("PREVIOUS", WINDOW)).toEqual({ from: "2025-08-01", to: "2026-06-30" });
    expect(periodOfChoice("PREVIOUS", { ...WINDOW, year: null })).toBeNull();
  });

  it("counts the last 90 days back from yesterday, and all three läsår from the window's first month", () => {
    expect(periodOfChoice("LAST_90", WINDOW)).toEqual({ from: "2026-08-09", to: "2026-11-06" });
    expect(periodOfChoice("ALL", WINDOW)).toEqual({ from: "2024-08-01", to: "2026-11-06" });
  });

  it("never asks for more days than the database reads at once", () => {
    for (const choice of PERIOD_CHOICES) {
      const period = periodOfChoice(choice, WINDOW);
      if (!period) continue;
      const days = (Date.parse(period.to) - Date.parse(period.from)) / 86_400_000;
      expect(days, choice).toBeLessThanOrEqual(MAX_PERIOD_DAYS);
      expect(period.from <= period.to, choice).toBe(true);
    }
  });

  it("offers the previous läsår only when the window reaches back to it", () => {
    expect(availableChoices(WINDOW)).toEqual(["YEAR", "PREVIOUS", "LAST_90", "ALL"]);
    expect(availableChoices({ ...WINDOW, firstMonth: "2026-08-01" })).toEqual(["YEAR", "LAST_90", "ALL"]);
    expect(availableChoices({ ...WINDOW, year: null })).toEqual(["YEAR", "LAST_90", "ALL"]);
  });

  it("writes the dates into the query", () => {
    expect(periodQuery({ from: "2025-08-01", to: "2026-06-30" })).toBe("?from=2025-08-01&to=2026-06-30");
  });
});

const row = (month: string) => ({ month });

describe("months under their läsår", () => {
  it("starts a läsår in August and names it with the year it ends in", () => {
    expect(schoolYearStart("2025-08-01")).toBe(2025);
    expect(schoolYearStart("2026-07-01")).toBe(2025);
    expect(schoolYearStart("2026-01-01")).toBe(2025);
    expect(schoolYearName(2025)).toBe("2025/26");
    expect(schoolYearName(2099)).toBe("2099/00");
  });

  it("groups the rows by läsår, oldest first, each keeping its own order", () => {
    const groups = groupByYear([row("2026-09-01"), row("2025-09-01"), row("2026-01-01"), row("2025-12-01")]);
    expect(groups.map((group) => [group.name, group.rows.map((one) => one.month)])).toEqual([
      ["2025/26", ["2025-09-01", "2026-01-01", "2025-12-01"]],
      ["2026/27", ["2026-09-01"]],
    ]);
  });
});

const figures = (validPct: number | null, invalidPct: number | null, totalPct = (validPct ?? 0) + (invalidPct ?? 0)): Figures => ({
  recordedMinutes: 1000,
  validMinutes: 10,
  absentMinutes: 5,
  lateMinutes: 2,
  lateCount: 1,
  invalidMinutes: 7,
  validPct,
  invalidPct,
  totalPct,
});

const reporting = { held: 10, reported: 9, ratePct: 90 };

describe("the chart's points", () => {
  it("takes the shares the gateway computed, and none for a month with no figure", () => {
    const series: SeriesMonthView[] = [
      {
        month: "2026-10-01",
        throughDay: "2026-10-31",
        partial: false,
        classNames: [],
        pupils: 20,
        pupilsRegistered: 20,
        figures: figures(2, 3),
        reporting,
        previousYear: { month: "2025-10-01", figures: figures(1, 1.5), reporting },
      },
      {
        month: "2026-11-01",
        throughDay: "2026-11-06",
        partial: true,
        classNames: [],
        pupils: 3,
        pupilsRegistered: 3,
        figures: null,
        reporting,
        previousYear: null,
      },
    ];
    expect(pointsOfSeries(series)).toEqual([
      { month: "2026-10-01", validPct: 2, invalidPct: 3, previousPct: 2.5, partial: false },
      { month: "2026-11-01", validPct: null, invalidPct: null, previousPct: null, partial: true },
    ]);
  });

  it("marks the pupil's month that is going on, from the school's today", () => {
    const months: PupilMonthView[] = [
      { month: "2026-10-01", figures: null, lessons: 0, previousYear: null },
      { month: "2026-11-01", figures: figures(1, 2), lessons: 12, previousYear: { month: "2025-11-01", figures: null } },
    ];
    expect(pointsOfPupil(months, "2026-11-07")).toEqual([
      { month: "2026-10-01", validPct: null, invalidPct: null, previousPct: null, partial: false },
      { month: "2026-11-01", validPct: 1, invalidPct: 2, previousPct: null, partial: true },
    ]);
  });

  it("scales the axis to the smallest round number the tallest bar, or last year's tick, fits under", () => {
    const point = (validPct: number | null, invalidPct: number | null, previousPct: number | null = null): ChartPoint => ({
      month: "2026-10-01",
      validPct,
      invalidPct,
      previousPct,
      partial: false,
    });
    expect(chartCeiling([])).toBe(5);
    expect(chartCeiling([point(null, null)])).toBe(5);
    expect(chartCeiling([point(1, 3.9)])).toBe(5);
    expect(chartCeiling([point(2, 3.1)])).toBe(10);
    expect(chartCeiling([point(1, 1, 12)])).toBe(20);
    expect(chartCeiling([point(10, 12)])).toBe(25);
    expect(chartCeiling([point(30, 20)])).toBe(50);
    expect(chartCeiling([point(60, 30)])).toBe(100);
    expect(chartCeiling([point(80, 40)])).toBe(100);
  });
});
