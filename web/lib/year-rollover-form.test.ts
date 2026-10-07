import { describe, expect, it } from "vitest";
import {
  defaultTarget,
  isCalendarDay,
  messageValues,
  nextYearName,
  rolloverOptions,
  successorOf,
  yearStatus,
  type RolloverFormState,
} from "@/lib/year-rollover-form";

const form = (overrides: Partial<RolloverFormState> = {}): RolloverFormState => ({
  name: "2027/28",
  startDate: "2027-08-16",
  endDate: "2028-06-09",
  graduatingGradeLevel: null,
  groups: {},
  carryTeachingGroups: true,
  carryTeachingGroupMembers: true,
  keepTeachers: true,
  carryClassRules: true,
  carryStaffing: true,
  breaks: {},
  ...overrides,
});

describe("nextYearName", () => {
  it.each([
    ["2026/2027", "2027/2028"],
    ["2026/27", "2027/28"],
    ["Läsår 26-27", "Läsår 27-28"],
    ["HT26–VT27", "HT27–VT28"],
    ["1999/00", "2000/01"],
    ["2099/99", "2100/00"],
  ])("counts %s up to %s, keeping each run's width", (name, next) => {
    expect(nextYearName(name)).toBe(next);
  });

  it("gives nothing for a name with no digits, rather than the same name back", () => {
    expect(nextYearName("Innevarande läsår")).toBe("");
  });
});

describe("defaultTarget", () => {
  it("moves both dates 52 weeks, so the year starts on the same weekday", () => {
    expect(defaultTarget({ name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11" })).toEqual({
      name: "2027/28",
      startDate: "2027-08-16",
      endDate: "2028-06-09",
    });
  });
});

describe("yearStatus", () => {
  const active = { startDate: "2026-08-17" };

  it("places years against the active one, not against today", () => {
    expect(yearStatus({ isActive: true, startDate: "2026-08-17", endDate: "2027-06-11" }, active, "2026-10-07")).toBe("ACTIVE");
    // Next year is still to come even on the day after the old one ended:
    // only activation makes it current.
    expect(yearStatus({ isActive: false, startDate: "2027-08-16", endDate: "2028-06-09" }, active, "2027-06-20")).toBe("UPCOMING");
    expect(yearStatus({ isActive: false, startDate: "2025-08-18", endDate: "2026-06-12" }, active, "2026-10-07")).toBe("FINISHED");
  });

  it("falls back to today when no year is active", () => {
    expect(yearStatus({ isActive: false, startDate: "2025-08-18", endDate: "2026-06-12" }, null, "2026-10-07")).toBe("FINISHED");
    expect(yearStatus({ isActive: false, startDate: "2026-08-17", endDate: "2027-06-11" }, null, "2026-10-07")).toBe("UPCOMING");
  });
});

describe("successorOf", () => {
  it("finds the year whose predecessor is this one", () => {
    const years = [
      { id: "a", predecessorId: null },
      { id: "b", predecessorId: "a" },
    ];
    expect(successorOf(years, "a")?.id).toBe("b");
    expect(successorOf(years, "b")).toBeNull();
  });
});

describe("isCalendarDay", () => {
  it("accepts a day that exists and nothing else", () => {
    expect(isCalendarDay("2028-02-29")).toBe(true);
    expect(isCalendarDay("2027-02-29")).toBe(false);
    expect(isCalendarDay("2027-8-16")).toBe(false);
    expect(isCalendarDay("")).toBe(false);
  });
});

describe("rolloverOptions", () => {
  it("is null until there is a name and two real days to preview", () => {
    expect(rolloverOptions(form({ name: "   " }))).toBeNull();
    expect(rolloverOptions(form({ startDate: "" }))).toBeNull();
    expect(rolloverOptions(form({ endDate: "2028-02-30" }))).toBeNull();
  });

  it("sends the defaults' switches, and leaves G to the server until it is chosen", () => {
    expect(rolloverOptions(form({ name: " 2027/28 " }))).toEqual({
      name: "2027/28",
      startDate: "2027-08-16",
      endDate: "2028-06-09",
      carryTeachingGroups: true,
      carryTeachingGroupMembers: true,
      keepTeachers: true,
      carryClassRules: true,
      carryStaffing: true,
    });
    expect(rolloverOptions(form({ graduatingGradeLevel: 9 }))?.graduatingGradeLevel).toBe(9);
    // 0 is a grade (förskoleklass), not "unset".
    expect(rolloverOptions(form({ graduatingGradeLevel: 0 }))?.graduatingGradeLevel).toBe(0);
  });

  it("always sends carryStaffing, off as well as on: the server reads an absent field as off", () => {
    expect(rolloverOptions(form({ carryStaffing: false }))?.carryStaffing).toBe(false);
    expect(rolloverOptions(form())?.carryStaffing).toBe(true);
  });

  it("sends only real choices, in id order, and never a blank name", () => {
    const options = rolloverOptions(
      form({
        groups: {
          "g-b": { outcome: "SKIP" },
          "g-a": { name: "  8 Ugglan " },
          "g-c": { name: "   " },
          "g-d": {},
        },
      }),
    );
    expect(options?.groups).toEqual([
      { sourceGroupId: "g-a", name: "8 Ugglan" },
      { sourceGroupId: "g-b", outcome: "SKIP" },
    ]);
  });

  it("sends each selected lov, with only the dates that were typed and are days", () => {
    const options = rolloverOptions(
      form({
        breaks: {
          "b-2": {},
          "b-1": { startDate: "2027-10-25", endDate: "2027-10-3" },
        },
      }),
    );
    expect(options?.breaks).toEqual([
      { sourceBreakId: "b-1", startDate: "2027-10-25" },
      { sourceBreakId: "b-2" },
    ]);
  });
});

describe("messageValues", () => {
  it("joins lists, so a message can name every colliding group", () => {
    expect(messageValues({ names: ["8A", "8B"], count: 2, year: "2026/27" })).toEqual({
      names: "8A, 8B",
      count: 2,
      year: "2026/27",
    });
    expect(messageValues(undefined)).toEqual({});
  });
});
