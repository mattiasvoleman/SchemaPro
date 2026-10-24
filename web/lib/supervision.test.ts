import { describe, expect, it } from "vitest";
import { supervisionOf } from "./staffing-supervision";
import {
  gapsOfBreak,
  gridRowsOf,
  otherShiftsOf,
  shiftBody,
  shiftDraftFault,
  weekdaysOf,
  wholeYear,
  type ShiftDraft,
  type SupervisionBreak,
  type SupervisionGap,
  type SupervisionShift,
} from "./supervision";

/**
 * Rastvaktsschema: the page draws what the gateway resolved. These are the
 * layout rules — a row per break window, a pass in no break apart, a gap on
 * its own cell — and the dialog's checks, which are the gateway's rules
 * asked early, not new ones.
 */

const brk = (dayOfWeek: number, startTime: string, endTime: string, rest: Partial<SupervisionBreak> = {}): SupervisionBreak => ({
  areaId: "garden",
  dayOfWeek,
  startTime,
  endTime,
  names: ["Förmiddagsrast"],
  lunch: false,
  needed: 1,
  shiftIds: [],
  ...rest,
});
const shift = (id: string, dayOfWeek: number, startTime: string, endTime: string, rest: Partial<SupervisionShift> = {}): SupervisionShift => ({
  id,
  academicYearId: "year",
  areaId: "garden",
  userId: "anna",
  dayOfWeek,
  startTime,
  endTime,
  validFrom: null,
  validTo: null,
  note: null,
  ...rest,
});
const YEAR = { startDate: "2026-08-17", endDate: "2027-06-11" };

describe("the grid", () => {
  it("makes one row per break window, Friday's own time a row of its own, in the order of the day", () => {
    const breaks = [
      brk(1, "12:00", "12:30", { names: ["Lunch"], lunch: true }),
      brk(1, "10:00", "10:20"),
      brk(2, "10:00", "10:20", { names: ["Rast 2"] }),
      brk(5, "10:05", "10:25"),
      brk(1, "10:00", "10:20", { areaId: "hall" }),
    ];
    const rows = gridRowsOf({ breaks }, "garden");
    expect(rows.map((row) => [row.key, [...row.days.keys()], row.names])).toEqual([
      ["10:00-10:20", [1, 2], ["Förmiddagsrast", "Rast 2"]],
      ["10:05-10:25", [5], ["Förmiddagsrast"]],
      ["12:00-12:30", [1], ["Lunch"]],
    ]);
    expect(rows[2]!.lunch).toBe(true);
  });

  it("sets apart the passes that run in no break of their area-day", () => {
    const breaks = [brk(1, "10:00", "10:20", { shiftIds: ["a"] })];
    const shifts = [shift("a", 1, "10:00", "10:20"), shift("bus", 3, "15:00", "15:15"), shift("x", 1, "07:45", "08:00", { areaId: "hall" })];
    expect(otherShiftsOf({ breaks, shifts }, "garden").map((row) => row.id)).toEqual(["bus"]);
  });

  it("finds a break's gaps by its area, day and window", () => {
    const gap = (dayOfWeek: number, startTime: string): SupervisionGap => ({
      ...brk(dayOfWeek, startTime, "10:20"),
      fewest: 0,
      shortFrom: startTime,
      shortTo: "10:20",
      from: YEAR.startDate,
      to: YEAR.endDate,
    });
    const gaps = [gap(1, "10:00"), gap(2, "10:00"), gap(1, "10:05")];
    expect(gapsOfBreak({ gaps }, brk(1, "10:00", "10:20"))).toEqual([gaps[0]]);
  });

  it("shows Monday to Friday, and a weekend day only where something is", () => {
    expect(weekdaysOf({ breaks: [], shifts: [] })).toEqual([1, 2, 3, 4, 5]);
    expect(weekdaysOf({ breaks: [brk(6, "10:00", "10:20")], shifts: [shift("s", 7, "09:00", "09:30")] })).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("calls dates the whole year when they reach both of its bounds or say none", () => {
    expect(wholeYear({ from: null, to: null }, YEAR)).toBe(true);
    expect(wholeYear({ from: YEAR.startDate, to: YEAR.endDate }, YEAR)).toBe(true);
    expect(wholeYear({ from: "2027-01-07", to: null }, YEAR)).toBe(false);
  });
});

describe("the pass dialog", () => {
  const draft = (rest: Partial<ShiftDraft> = {}): ShiftDraft => ({
    areaId: "garden",
    userId: "anna",
    dayOfWeek: 1,
    startTime: "10:00",
    endTime: "10:20",
    validFrom: "",
    validTo: "",
    note: "",
    ...rest,
  });

  it("names the first thing the gateway would refuse", () => {
    expect(shiftDraftFault(draft(), YEAR)).toBeNull();
    expect(shiftDraftFault(draft({ areaId: "" }), YEAR)).toBe("areaMissing");
    expect(shiftDraftFault(draft({ userId: "" }), YEAR)).toBe("teacherMissing");
    expect(shiftDraftFault(draft({ endTime: "" }), YEAR)).toBe("timeMissing");
    expect(shiftDraftFault(draft({ endTime: "10:00" }), YEAR)).toBe("endBeforeStart");
    expect(shiftDraftFault(draft({ validFrom: "2027-01-08", validTo: "2027-01-07" }), YEAR)).toBe("toBeforeFrom");
    expect(shiftDraftFault(draft({ validTo: "2027-06-30" }), YEAR)).toBe("outsideYear");
    // Without the year's bounds the dates are the gateway's to judge.
    expect(shiftDraftFault(draft({ validTo: "2027-06-30" }), null)).toBeNull();
    expect(shiftDraftFault(draft({ note: "x".repeat(201) }), YEAR)).toBe("noteTooLong");
    // Code points, as the gateway counts them: 200 emoji are 200 characters.
    expect(shiftDraftFault(draft({ note: "🙂".repeat(200) }), YEAR)).toBeNull();
  });

  it("sends empty dates and note as null and clocks as HH:MM", () => {
    expect(shiftBody(draft({ startTime: "10:00:00", note: "  Norra delen " }))).toEqual({
      areaId: "garden",
      userId: "anna",
      dayOfWeek: 1,
      startTime: "10:00",
      endTime: "10:20",
      validFrom: null,
      validTo: null,
      note: "Norra delen",
    });
  });
});

describe("supervisionOf", () => {
  it("finds a teacher's line, and none without a schedule or a pass", () => {
    const line = {
      userId: "anna",
      shiftCount: 2,
      minutesPerWeek: 50,
      countedMinutesPerWeek: 0,
      peakMinutesPerWeek: 50,
      hoursPerYear: 33.3,
      ramMinutesPerWeek: 60,
      ramCountedMinutesPerWeek: 0,
    };
    expect(supervisionOf({ supervision: { teachers: [line] } }, "anna")).toBe(line);
    expect(supervisionOf({ supervision: { teachers: [line] } }, "bo")).toBeNull();
    expect(supervisionOf({ supervision: null }, "anna")).toBeNull();
    expect(supervisionOf(undefined, "anna")).toBeNull();
  });
});
