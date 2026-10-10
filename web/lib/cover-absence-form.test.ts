import { describe, expect, it } from "vitest";
import type { Absence } from "@/lib/cover-types";
import {
  absenceBody,
  absenceFormError,
  absenceFormOf,
  absencePatch,
  absencePeriodText,
  emptyAbsenceForm,
  shiftDate,
  type AbsenceForm,
} from "./cover-absence-form";

/**
 * The absence form's own checks mirror the gateway's periodOf and DTO, so an
 * admin hears "högst 186 dagar" before a round trip, and the body sent is the
 * one the gateway's CreateAbsenceDto takes: no times for whole days, no
 * reason for "Ange inte", and never a free-text field.
 */

const TODAY = "2026-10-12";
const form = (overrides: Partial<AbsenceForm> = {}): AbsenceForm => ({
  ...emptyAbsenceForm(TODAY, "t-anna"),
  ...overrides,
});

const absence = (startsAt: Date, endsAt: Date, overrides: Partial<Absence> = {}): Absence => ({
  id: "a-1",
  userId: "t-anna",
  startsAt: startsAt.toISOString(),
  endsAt: endsAt.toISOString(),
  wholeDays: true,
  reasonId: null,
  status: "ACTIVE",
  phase: "PLANNED",
  selfReported: false,
  createdAt: startsAt.toISOString(),
  counts: { open: 0, covered: 0, cancelled: 0, handled: 0, passedOpen: 0 },
  ...overrides,
});

describe("absenceFormError", () => {
  it("accepts a whole day today", () => {
    expect(absenceFormError(form(), TODAY, "ADMIN")).toBeNull();
  });

  it("asks for a teacher and an ordered range", () => {
    expect(absenceFormError(form({ userId: "" }), TODAY, "ADMIN")).toBe("teacher");
    expect(absenceFormError(form({ to: "2026-10-11" }), TODAY, "ADMIN")).toBe("range");
  });

  it("allows 186 days and not 187, as the gateway's CHECK and DTO", () => {
    expect(absenceFormError(form({ to: shiftDate(TODAY, 185) }), TODAY, "ADMIN")).toBeNull();
    expect(absenceFormError(form({ to: shiftDate(TODAY, 186) }), TODAY, "ADMIN")).toBe("tooLong");
  });

  it("asks a part day for a time, and on one day for an end after the start", () => {
    expect(absenceFormError(form({ partDay: true }), TODAY, "ADMIN")).toBe("times");
    expect(absenceFormError(form({ partDay: true, startTime: "10:00", endTime: "09:00" }), TODAY, "ADMIN")).toBe("times");
    expect(absenceFormError(form({ partDay: true, startTime: "10:00" }), TODAY, "ADMIN")).toBeNull();
    // Across days, a late start on the first and an early end on the last is fine.
    expect(
      absenceFormError(form({ to: "2026-10-13", partDay: true, startTime: "13:00", endTime: "09:00" }), TODAY, "ADMIN"),
    ).toBeNull();
  });

  it("lets an admin go 30 days back and a teacher only from today ('sjuk i dag' at 07:00 works)", () => {
    expect(absenceFormError(form({ from: shiftDate(TODAY, -30) }), TODAY, "ADMIN")).toBeNull();
    expect(absenceFormError(form({ from: shiftDate(TODAY, -31) }), TODAY, "ADMIN")).toBe("tooFarBack");
    expect(absenceFormError(form(), TODAY, "TEACHER")).toBeNull();
    expect(absenceFormError(form({ from: shiftDate(TODAY, -1) }), TODAY, "TEACHER")).toBe("fromToday");
  });

  it("does not hold an edit of a running absence to the backdating rule", () => {
    expect(absenceFormError(form({ from: shiftDate(TODAY, -60) }), TODAY, "ADMIN", false)).toBeNull();
  });
});

describe("the bodies", () => {
  it("sends whole days without times and 'Ange inte' without a reason", () => {
    expect(absenceBody(form({ to: "2026-10-14" }))).toEqual({ userId: "t-anna", from: TODAY, to: "2026-10-14" });
  });

  it("sends a part day's times and the chosen category, and nothing else", () => {
    const body = absenceBody(form({ partDay: true, startTime: "08:00", endTime: "12:00", reasonId: "r-sick" }));
    expect(body).toEqual({ userId: "t-anna", from: TODAY, to: TODAY, startTime: "08:00", endTime: "12:00", reasonId: "r-sick" });
    expect(Object.keys(body)).not.toContain("note");
  });

  it("drops times the admin unticked and a cleared reason as nulls on an edit", () => {
    expect(absencePatch(form({ partDay: false, startTime: "08:00", reasonId: "" }))).toEqual({
      from: TODAY,
      to: TODAY,
      startTime: null,
      endTime: null,
      reasonId: null,
    });
  });
});

describe("absenceFormOf", () => {
  it("reads a whole-day period back as its first and last day", () => {
    const stored = absence(new Date(2026, 9, 12, 0, 0), new Date(2026, 9, 15, 0, 0));
    expect(absenceFormOf(stored)).toMatchObject({ from: "2026-10-12", to: "2026-10-14", partDay: false });
  });

  it("reads a part day back with its times", () => {
    const stored = absence(new Date(2026, 9, 12, 8, 0), new Date(2026, 9, 12, 12, 0), { wholeDays: false, reasonId: "r-1" });
    expect(absenceFormOf(stored)).toMatchObject({
      from: "2026-10-12",
      to: "2026-10-12",
      partDay: true,
      startTime: "08:00",
      endTime: "12:00",
      reasonId: "r-1",
    });
  });

  it("writes the period as the register shows it", () => {
    const whole = absence(new Date(2026, 9, 12, 0, 0), new Date(2026, 9, 13, 0, 0));
    const part = absence(new Date(2026, 9, 12, 8, 0), new Date(2026, 9, 12, 12, 0));
    expect(absencePeriodText(whole, "sv")).not.toContain("–");
    expect(absencePeriodText(part, "sv")).toContain("08:00–12:00");
  });
});
