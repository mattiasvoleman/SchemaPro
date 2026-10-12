import { describe, expect, it } from "vitest";
import {
  DUTY_SLOTS_MAX,
  EMPTY_DUTY_DRAFT,
  dutyDraftToBody,
  dutyToDraft,
  validateDutyDraft,
  type DutyDraft,
  type SlotDraft,
} from "./duty-forms";
import type { TeacherDuty } from "./types";

/*
 * The uppdrag form's rules, mirrored from CreateTeacherDutyDto and
 * assertDutySlots. Their sentences are checked in both locales by the list in
 * staffing-forms.test.ts, which every staffing reason goes through.
 */

const time = (dayOfWeek: string, startTime: string, endTime: string): SlotDraft => ({ dayOfWeek, startTime, endTime });

describe("validateDutyDraft", () => {
  const duty = (overrides: Partial<DutyDraft> = {}): DutyDraft => ({
    ...EMPTY_DUTY_DRAFT,
    label: "Mentor 7B",
    minutesPerWeek: "90",
    ...overrides,
  });
  const YEAR = { startDate: "2026-08-17", endDate: "2027-06-11" };

  it("accepts a plain uppdrag, one with a time on the grid, and a rastvakt on Monday, Wednesday and Friday", () => {
    expect(validateDutyDraft(duty())).toBeNull();
    expect(validateDutyDraft(duty({ blocks: true, slots: [time("2", "15:00", "16:30")] }))).toBeNull();
    expect(
      validateDutyDraft(
        duty({ blocks: true, slots: [time("1", "10:00", "10:20"), time("3", "10:00", "10:20"), time("5", "10:00", "10:20")] }),
      ),
    ).toBeNull();
  });

  it("refuses a blank label the way the CHECK does, and one over 80 code points", () => {
    expect(validateDutyDraft(duty({ label: "" }))).toEqual({ reason: "dutyLabelRequired" });
    expect(validateDutyDraft(duty({ label: "  \t " }))).toEqual({ reason: "dutyLabelRequired" });
    expect(validateDutyDraft(duty({ label: "x".repeat(80) }))).toBeNull();
    expect(validateDutyDraft(duty({ label: "x".repeat(81) }))).toEqual({
      reason: "dutyLabelTooLong",
      max: 80,
    });
    // An emoji is one code point to MaxCodePoints, two UTF-16 units to .length.
    expect(validateDutyDraft(duty({ label: "🙂".repeat(80) }))).toBeNull();
  });

  it("takes 1..2400 whole minutes", () => {
    for (const minutes of ["0", "2401", "", "1,5", "-3"]) {
      expect(validateDutyDraft(duty({ minutesPerWeek: minutes }))).toEqual({
        reason: "dutyMinutesOutOfRange",
        max: 2400,
      });
    }
    expect(validateDutyDraft(duty({ minutesPerWeek: "2400" }))).toBeNull();
  });

  it("reads the times only while they are switched on, then wants each on the grid and forwards, naming its row", () => {
    expect(validateDutyDraft(duty({ blocks: false, slots: [time("2", "15:03", "")] }))).toBeNull();
    expect(validateDutyDraft(duty({ blocks: true, slots: [time("2", "15:00", "16:00"), time("4", "", "16:00")] }))).toEqual({
      reason: "slotTimeRequired",
      index: 2,
    });
    expect(validateDutyDraft(duty({ blocks: true, slots: [time("2", "15:03", "16:00")] }))).toEqual({
      reason: "slotOffGrid",
      index: 1,
      time: "15:03",
      grid: 5,
    });
    expect(validateDutyDraft(duty({ blocks: true, slots: [time("2", "16:00", "15:00")] }))).toEqual({
      reason: "slotReversed",
      index: 1,
      start: "16:00",
      end: "15:00",
    });
    expect(validateDutyDraft(duty({ blocks: true, slots: [time("2", "15:00", "15:00")] }))).toEqual({
      reason: "slotReversed",
      index: 1,
      start: "15:00",
      end: "15:00",
    });
  });

  it("refuses two times sharing a minute on one weekday, as the gateway does; touching ends and other days are fine", () => {
    expect(
      validateDutyDraft(duty({ blocks: true, slots: [time("3", "10:00", "10:30"), time("3", "10:25", "10:45")] })),
    ).toEqual({ reason: "slotsOverlap", index: 2, other: 1 });
    expect(
      validateDutyDraft(
        duty({ blocks: true, slots: [time("3", "10:00", "10:30"), time("3", "10:30", "10:45"), time("4", "10:00", "10:30")] }),
      ),
    ).toBeNull();
    expect(
      validateDutyDraft(duty({ blocks: true, slots: Array.from({ length: DUTY_SLOTS_MAX + 1 }, (_, i) => time(String((i % 5) + 1), "08:00", "08:05")) })),
    ).toEqual({ reason: "slotsTooMany", max: DUTY_SLOTS_MAX });
  });

  it("wants Till on or after Från, and both inside the läsår when its bounds are known", () => {
    expect(validateDutyDraft(duty({ validFrom: "2027-01-07", validTo: "2026-12-18" }))).toEqual({
      reason: "dutyDatesReversed",
      from: "2027-01-07",
      to: "2026-12-18",
    });
    expect(validateDutyDraft(duty({ validFrom: "2027-03-01", validTo: "2027-03-01" }), YEAR)).toBeNull();
    expect(validateDutyDraft(duty({ validTo: "2026-12-18" }), YEAR)).toBeNull();
    expect(validateDutyDraft(duty({ validFrom: "2026-08-16" }), YEAR)).toEqual({
      reason: "dutyDateOutsideYear",
      date: "2026-08-16",
      start: "2026-08-17",
      end: "2027-06-11",
    });
    expect(validateDutyDraft(duty({ validTo: "2027-06-12" }), YEAR)).toMatchObject({ reason: "dutyDateOutsideYear" });
    // Without the year the gateway measures it; the form says nothing it cannot know.
    expect(validateDutyDraft(duty({ validTo: "2027-06-12" }))).toBeNull();
  });

  it("refuses a note over 500", () => {
    expect(validateDutyDraft(duty({ note: "n".repeat(501) }))).toEqual({
      reason: "dutyNoteTooLong",
      max: 500,
    });
  });

  it("sends every key — no times when off, no dates when empty — and round-trips a stored uppdrag", () => {
    expect(dutyDraftToBody(duty({ label: "  Mentor 7B ", note: " ", slots: [time("2", "15:00", "16:00")] }))).toEqual({
      kind: "MENTORSKAP",
      label: "Mentor 7B",
      minutesPerWeek: 90,
      countsAsTeaching: false,
      subjectId: null,
      studentGroupId: null,
      validFrom: null,
      validTo: null,
      slots: [],
      note: null,
    });
    const stored: TeacherDuty = {
      id: "d1",
      userId: "t1",
      academicYearId: "y1",
      kind: "RASTVAKT",
      label: "Rastvakt",
      minutesPerWeek: 60,
      countsAsTeaching: true,
      subjectId: null,
      studentGroupId: "g-7b",
      validFrom: "2027-01-07",
      validTo: null,
      // The gateway may send seconds; the time input holds HH:MM.
      slots: [
        { dayOfWeek: 1, startTime: "10:00:00", endTime: "10:20:00" },
        { dayOfWeek: 3, startTime: "10:00:00", endTime: "10:20:00" },
      ],
      note: "Varannan vecka",
    };
    const draft = dutyToDraft(stored);
    expect(draft).toMatchObject({ blocks: true, validFrom: "2027-01-07", validTo: "" });
    expect(dutyDraftToBody(draft)).toEqual({
      kind: "RASTVAKT",
      label: "Rastvakt",
      minutesPerWeek: 60,
      countsAsTeaching: true,
      subjectId: null,
      studentGroupId: "g-7b",
      validFrom: "2027-01-07",
      validTo: null,
      slots: [
        { dayOfWeek: 1, startTime: "10:00", endTime: "10:20" },
        { dayOfWeek: 3, startTime: "10:00", endTime: "10:20" },
      ],
      note: "Varannan vecka",
    });
  });

  it("opens an uppdrag without times switched off, with one empty row ready", () => {
    const draft = dutyToDraft({
      id: "d2", userId: "t1", academicYearId: "y1", kind: "MENTORSKAP", label: "Mentor 7B", minutesPerWeek: 90,
      countsAsTeaching: false, subjectId: null, studentGroupId: null, validFrom: null, validTo: null, slots: [], note: null,
    });
    expect(draft).toMatchObject({ blocks: false, slots: [{ dayOfWeek: "1", startTime: "", endTime: "" }], validFrom: "", validTo: "" });
  });
});
