import { describe, expect, it } from "vitest";
import {
  calendarBody,
  diffCalendar,
  holidayEntries,
  holidaysDuring,
  isSchoolWeekday,
  proposeYearBreaks,
  savableRows,
  swedishHolidays,
  weekdaysIn,
  type CalendarEntry,
} from "@/lib/school-calendar";
import { proposeBreak } from "@/lib/year-rollover";
import type { SchoolBreak } from "@/lib/types";

const YEAR = { startDate: "2026-08-17", endDate: "2027-06-11" };

const byKey = (year: number) => Object.fromEntries(swedishHolidays(year).map((holiday) => [holiday.key, holiday.date]));

describe("swedishHolidays", () => {
  // The dates are the ones Sweden publishes; they are written out by hand and not computed the way the code does.
  it.each([
    [2026, { GOOD_FRIDAY: "2026-04-03", EASTER_SUNDAY: "2026-04-05", EASTER_MONDAY: "2026-04-06", ASCENSION: "2026-05-14", WHIT_SUNDAY: "2026-05-24", MIDSUMMER_EVE: "2026-06-19", MIDSUMMER_DAY: "2026-06-20", ALL_SAINTS: "2026-10-31" }],
    [2027, { GOOD_FRIDAY: "2027-03-26", EASTER_SUNDAY: "2027-03-28", EASTER_MONDAY: "2027-03-29", ASCENSION: "2027-05-06", WHIT_SUNDAY: "2027-05-16", MIDSUMMER_EVE: "2027-06-25", MIDSUMMER_DAY: "2027-06-26", ALL_SAINTS: "2027-11-06" }],
    [2028, { GOOD_FRIDAY: "2028-04-14", EASTER_SUNDAY: "2028-04-16", EASTER_MONDAY: "2028-04-17", ASCENSION: "2028-05-25", WHIT_SUNDAY: "2028-06-04", MIDSUMMER_EVE: "2028-06-23", MIDSUMMER_DAY: "2028-06-24", ALL_SAINTS: "2028-11-04" }],
  ])("moves the holidays that move, in %i", (year, expected) => {
    expect(byKey(year)).toMatchObject(expected);
  });

  it("keeps the fixed days on their dates, in the order of the year", () => {
    const holidays = swedishHolidays(2027);
    expect(byKey(2027)).toMatchObject({
      NEW_YEARS_DAY: "2027-01-01",
      EPIPHANY: "2027-01-06",
      MAY_DAY: "2027-05-01",
      NATIONAL_DAY: "2027-06-06",
      CHRISTMAS_EVE: "2027-12-24",
      CHRISTMAS_DAY: "2027-12-25",
      BOXING_DAY: "2027-12-26",
      NEW_YEARS_EVE: "2027-12-31",
    });
    expect(holidays.map((holiday) => holiday.date)).toEqual([...holidays.map((holiday) => holiday.date)].sort());
    expect(holidays).toHaveLength(16);
  });

  it("says which are red days by law, and which the school is shut on all the same", () => {
    const unofficial = swedishHolidays(2027).filter((holiday) => !holiday.official).map((holiday) => holiday.name);
    expect(unofficial).toEqual(["Midsommarafton", "Julafton", "Nyårsafton"]);
  });

  it("puts every moving Saturday in its window and every Easter day on its weekday, for a hundred years", () => {
    for (let year = 2000; year < 2100; year += 1) {
      const days = byKey(year);
      expect(isSchoolWeekday(days.EASTER_SUNDAY!)).toBe(false);
      expect(isSchoolWeekday(days.GOOD_FRIDAY!)).toBe(true);
      expect(isSchoolWeekday(days.EASTER_MONDAY!)).toBe(true);
      expect(isSchoolWeekday(days.ASCENSION!) && new Date(`${days.ASCENSION}T00:00:00Z`).getUTCDay() === 4).toBe(true);
      expect(new Date(`${days.MIDSUMMER_DAY}T00:00:00Z`).getUTCDay()).toBe(6);
      expect(days.MIDSUMMER_DAY! >= `${year}-06-20` && days.MIDSUMMER_DAY! <= `${year}-06-26`).toBe(true);
      expect(new Date(`${days.MIDSUMMER_EVE}T00:00:00Z`).getUTCDay()).toBe(5);
      expect(new Date(`${days.ALL_SAINTS}T00:00:00Z`).getUTCDay()).toBe(6);
      expect(days.ALL_SAINTS! >= `${year}-10-31` && days.ALL_SAINTS! <= `${year}-11-06`).toBe(true);
    }
  });
});

describe("holidaysDuring", () => {
  it("lists the holidays of a läsår that fall on a school day, over New Year", () => {
    expect(holidaysDuring(YEAR).map((holiday) => `${holiday.date} ${holiday.name}`)).toEqual([
      "2026-12-24 Julafton",
      "2026-12-25 Juldagen",
      "2026-12-31 Nyårsafton",
      "2027-01-01 Nyårsdagen",
      "2027-01-06 Trettondedag jul",
      "2027-03-26 Långfredagen",
      "2027-03-29 Annandag påsk",
      "2027-05-06 Kristi himmelsfärdsdag",
    ]);
  });

  it("leaves out a holiday outside the year, and the weekend ones (Alla helgons dag, Första maj 2027)", () => {
    const names = holidaysDuring(YEAR).map((holiday) => holiday.name);
    expect(names).not.toContain("Alla helgons dag");
    expect(names).not.toContain("Första maj");
    expect(names).not.toContain("Sveriges nationaldag");
    expect(holidaysDuring({ startDate: "2026-12-28", endDate: "2026-12-30" })).toEqual([]);
  });

  it("makes each one a whole-school lov of its own day, of the kind HOLIDAY", () => {
    expect(holidayEntries(YEAR)[0]).toMatchObject({ source: "HOLIDAY", name: "Julafton", kind: "HOLIDAY", startDate: "2026-12-24", endDate: "2026-12-24", minGradeLevel: null, maxGradeLevel: null });
  });
});

describe("weekdaysIn", () => {
  it("counts the days of the school week in a range, and none in a weekend", () => {
    expect(weekdaysIn("2027-02-22", "2027-02-28")).toBe(5);
    expect(weekdaysIn("2027-02-27", "2027-02-28")).toBe(0);
    expect(weekdaysIn("2027-02-26", "2027-02-26")).toBe(1);
  });
});

describe("proposeYearBreaks", () => {
  it("proposes höstlov, jullov, sportlov and påsklov for 2026/27, on the weeks the rollover keeps", () => {
    expect(proposeYearBreaks(YEAR).map((lov) => [lov.name, lov.startDate, lov.endDate, lov.rule])).toEqual([
      ["Höstlov", "2026-10-26", "2026-10-30", "ISO_WEEK"],
      ["Jullov", "2026-12-21", "2027-01-06", "CHRISTMAS"],
      ["Sportlov", "2027-03-01", "2027-03-05", "ISO_WEEK"],
      ["Påsklov", "2027-03-29", "2027-04-02", "EASTER"],
    ]);
  });

  it("starts jullov on the first school day on or after 21 December, so julafton is always inside it", () => {
    const jullov = (year: number) => proposeYearBreaks({ startDate: `${year}-08-16`, endDate: `${year + 1}-06-12` }).find((lov) => lov.name === "Jullov")!;
    // 2025: 21 December is a Sunday; 2026 a Monday; 2029 a Friday; 2030 a Saturday; 2031 a Sunday.
    expect([2025, 2026, 2027, 2028, 2029, 2030, 2031].map((year) => jullov(year).startDate)).toEqual(["2025-12-22", "2026-12-21", "2027-12-21", "2028-12-21", "2029-12-21", "2030-12-23", "2031-12-22"]);
    for (let year = 2025; year < 2060; year += 1) {
      const lov = jullov(year);
      expect(lov.startDate <= `${year}-12-24` && lov.endDate === `${year + 1}-01-06`, String(year)).toBe(true);
      expect(isSchoolWeekday(lov.startDate), String(year)).toBe(true);
    }
  });

  it("is carried by the rollover on the same rule it was proposed by, and on a date that fits", () => {
    for (let year = 2025; year < 2035; year += 1) {
      const source = { startDate: `${year}-08-17`, endDate: `${year + 1}-06-11` };
      const target = { startDate: `${year + 1}-08-16`, endDate: `${year + 2}-06-10` };
      for (const lov of proposeYearBreaks(source)) {
        const next = proposeBreak(lov, source, target);
        expect(next.anchor, `${lov.name} ${year}`).toBe(lov.rule);
        expect(next.fits, `${lov.name} ${year}`).toBe(true);
        // The proposal for the next year names the same weeks and the same Easter the rollover moved it to.
        const again = proposeYearBreaks(target).find((other) => other.name === lov.name)!;
        if (lov.rule !== "CHRISTMAS") expect([next.proposedStart, next.proposedEnd], `${lov.name} ${year}`).toEqual([again.startDate, again.endDate]);
      }
    }
  });

  it("proposes nothing that lies outside the year it is for", () => {
    const short = { startDate: "2026-08-17", endDate: "2026-11-20" };
    expect(proposeYearBreaks(short).map((lov) => lov.name)).toEqual(["Höstlov"]);
    expect(proposeYearBreaks({ startDate: "2026-08-17", endDate: "2026-09-01" })).toEqual([]);
  });
});

const lov = (over: Partial<SchoolBreak> & { name: string }): SchoolBreak => ({
  id: `id-${over.name}`,
  academicYearId: "y1",
  kind: "HOLIDAY",
  startDate: "2026-10-26",
  endDate: "2026-10-30",
  minGradeLevel: null,
  maxGradeLevel: null,
  ...over,
});

const entry = (over: Partial<CalendarEntry> & { name: string }): CalendarEntry => ({
  key: `k-${over.name}-${over.startDate ?? "2026-10-26"}`,
  source: "FILE",
  kind: "HOLIDAY",
  startDate: "2026-10-26",
  endDate: "2026-10-30",
  minGradeLevel: null,
  maxGradeLevel: null,
  ...over,
});

const statuses = (entries: CalendarEntry[], existing: SchoolBreak[] = []) =>
  diffCalendar(entries, existing, YEAR).rows.map((row) => row.status);

describe("diffCalendar", () => {
  it("says SAME for a lov the year has, whatever the case of its name, and NEW for the rest", () => {
    expect(statuses([entry({ name: "HÖSTLOV" }), entry({ name: "Sportlov", startDate: "2027-03-01", endDate: "2027-03-05" })], [lov({ name: "Höstlov" })])).toEqual(["SAME", "NEW"]);
  });

  it("says CHANGED for the name of one lov on other days, and carries the lov it moves", () => {
    const diff = diffCalendar([entry({ name: "Höstlov", startDate: "2026-11-02", endDate: "2026-11-06" })], [lov({ name: "Höstlov" })], YEAR);
    expect(diff.rows[0]).toMatchObject({ status: "CHANGED", existing: { id: "id-Höstlov" } });
  });

  it("does not take a name the year's lov share for a move: Studiedag beside Studiedag is a new one", () => {
    const existing = [lov({ name: "Studiedag", startDate: "2026-09-14", endDate: "2026-09-14", kind: "STAFF_DAY" }), lov({ name: "Studiedag", startDate: "2026-11-09", endDate: "2026-11-09", kind: "STAFF_DAY" })];
    expect(statuses([entry({ name: "Studiedag", startDate: "2027-01-08", endDate: "2027-01-08", kind: "STAFF_DAY" })], existing)).toEqual(["NEW"]);
  });

  it("does not take a lov of other årskurser for the one that moves: Prao for åk 9 and a file's Prao for the whole school are two", () => {
    const existing = [lov({ name: "Prao", startDate: "2026-11-02", endDate: "2026-11-06", minGradeLevel: 9, maxGradeLevel: 9 })];
    const wide = entry({ name: "Prao", startDate: "2026-11-09", endDate: "2026-11-13" });
    // A "move" writes the entry's årskurser (none: every group), so the row would widen the week to the whole school.
    expect(statuses([wide], existing)).toEqual(["NEW"]);
    const diff = diffCalendar([wide], existing, YEAR);
    expect(calendarBody("y1", savableRows(diff, new Set([wide.key])), false).breaks[0]).not.toHaveProperty("id");
    // The same årskurser is still a move.
    expect(statuses([{ ...wide, minGradeLevel: 9, maxGradeLevel: 9 }], existing)).toEqual(["CHANGED"]);
  });

  it("does not take a name two entries share for a move either", () => {
    const rows = [entry({ name: "Höstlov", startDate: "2026-11-02", endDate: "2026-11-06" }), entry({ name: "Höstlov", startDate: "2027-01-11", endDate: "2027-01-15" })];
    expect(statuses(rows, [lov({ name: "Höstlov" })])).toEqual(["NEW", "NEW"]);
  });

  it("says OUTSIDE for a day before the läsår, after it, or an end before the start; WEEKEND for a lov of Saturday and Sunday", () => {
    expect(
      statuses([
        entry({ name: "Sommarlov", startDate: "2027-06-07", endDate: "2027-06-18" }),
        entry({ name: "Förra året", startDate: "2026-05-01", endDate: "2026-05-01" }),
        entry({ name: "Baklänges", startDate: "2026-10-30", endDate: "2026-10-26" }),
        entry({ name: "Alla helgons dag", startDate: "2026-10-31", endDate: "2026-11-01" }),
      ]),
    ).toEqual(["OUTSIDE", "OUTSIDE", "OUTSIDE", "WEEKEND"]);
  });

  it("covers a holiday inside a lov the year has, and one inside another entry, and keeps the longer entry", () => {
    const diff = diffCalendar(
      [
        entry({ name: "Annandag påsk", source: "HOLIDAY", startDate: "2027-03-29", endDate: "2027-03-29" }),
        entry({ name: "Påsklov", source: "PROPOSAL", startDate: "2027-03-29", endDate: "2027-04-02" }),
        entry({ name: "Trettondedag jul", source: "HOLIDAY", startDate: "2027-01-06", endDate: "2027-01-06" }),
      ],
      [lov({ name: "Jullov", startDate: "2026-12-21", endDate: "2027-01-08" })],
      YEAR,
    );
    expect(diff.rows.map((row) => row.status)).toEqual(["COVERED", "NEW", "COVERED"]);
    expect(diff.rows[0]!.coveredBy?.name).toBe("Påsklov");
    expect(diff.rows[2]!.existing?.name).toBe("Jullov");
  });

  it("keeps the file's row of two that take the same days, a file over a proposal over a holiday", () => {
    const rows = [
      entry({ name: "Påsklov", source: "PROPOSAL", startDate: "2027-03-29", endDate: "2027-04-02", key: "p" }),
      entry({ name: "Påsklov (kommunen)", source: "FILE", startDate: "2027-03-29", endDate: "2027-04-02", key: "f" }),
    ];
    const diff = diffCalendar(rows, [], YEAR);
    expect(Object.fromEntries(diff.rows.map((row) => [row.entry.key, row.status]))).toEqual({ p: "COVERED", f: "NEW" });
  });

  it("does not take a lov narrowed to some årskurser to cover the whole school", () => {
    const existing = [lov({ name: "Prao", startDate: "2026-10-26", endDate: "2026-10-30", minGradeLevel: 9, maxGradeLevel: 9 })];
    expect(statuses([entry({ name: "Studiedag", startDate: "2026-10-27", endDate: "2026-10-27", kind: "STAFF_DAY" })], existing)).toEqual(["NEW"]);
    expect(statuses([entry({ name: "Studiedag åk 9", startDate: "2026-10-27", endDate: "2026-10-27", kind: "STAFF_DAY", minGradeLevel: 9, maxGradeLevel: 9 })], existing)).toEqual(["COVERED"]);
  });

  it("names the lov of the year a NEW entry shares days with, as a warning and not a stop", () => {
    const diff = diffCalendar([entry({ name: "Studiedag", startDate: "2026-10-29", endDate: "2026-11-03", kind: "STAFF_DAY", minGradeLevel: 7, maxGradeLevel: 8 })], [lov({ name: "Höstlov" })], YEAR);
    expect(diff.rows[0]).toMatchObject({ status: "NEW" });
    expect(diff.rows[0]!.overlaps.map((other) => other.name)).toEqual(["Höstlov"]);
  });

  it("lists the lov of the year that no entry named, and never as something to remove", () => {
    const diff = diffCalendar([entry({ name: "Höstlov" })], [lov({ name: "Höstlov" }), lov({ name: "Friluftsdag", startDate: "2027-05-20", endDate: "2027-05-20" })], YEAR);
    expect(diff.onlyHere.map((other) => other.name)).toEqual(["Friluftsdag"]);
  });
});

describe("the body that is saved", () => {
  it("holds the ticked NEW and CHANGED rows, a CHANGED one with the id of the lov it moves", () => {
    const diff = diffCalendar(
      [
        entry({ name: "Höstlov", startDate: "2026-11-02", endDate: "2026-11-06", key: "a" }),
        entry({ name: "Sportlov", startDate: "2027-03-01", endDate: "2027-03-05", key: "b" }),
        entry({ name: "Påsklov", startDate: "2027-03-29", endDate: "2027-04-02", key: "c" }),
        entry({ name: "Sommarlov", startDate: "2027-06-14", endDate: "2027-06-18", key: "d" }),
      ],
      [lov({ name: "Höstlov" })],
      YEAR,
    );
    const rows = savableRows(diff, new Set(["a", "b", "d"]));
    expect(rows.map((row) => row.entry.key)).toEqual(["a", "b"]);
    expect(calendarBody("y1", rows, true)).toEqual({
      academicYearId: "y1",
      dryRun: true,
      breaks: [
        { id: "id-Höstlov", name: "Höstlov", kind: "HOLIDAY", startDate: "2026-11-02", endDate: "2026-11-06", minGradeLevel: null, maxGradeLevel: null },
        { name: "Sportlov", kind: "HOLIDAY", startDate: "2027-03-01", endDate: "2027-03-05", minGradeLevel: null, maxGradeLevel: null },
      ],
    });
  });
});
