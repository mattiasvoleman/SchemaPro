import { describe, expect, it } from "vitest";
import {
  EMPTY_DUTY_DRAFT,
  dutyDraftToBody,
  dutyToDraft,
  validateDutyDraft,
  type DutyDraft,
} from "./duty-forms";

/*
 * The uppdrag form's rules, mirrored from CreateTeacherDutyDto and
 * assertDutySlot. Their sentences are checked in both locales by the list in
 * staffing-forms.test.ts, which every staffing reason goes through.
 */

describe("validateDutyDraft", () => {
  const duty = (overrides: Partial<DutyDraft> = {}): DutyDraft => ({
    ...EMPTY_DUTY_DRAFT,
    label: "Mentor 7B",
    minutesPerWeek: "90",
    ...overrides,
  });

  it("accepts a plain uppdrag, and one with a slot on the grid", () => {
    expect(validateDutyDraft(duty())).toBeNull();
    expect(
      validateDutyDraft(duty({ blocks: true, dayOfWeek: "2", startTime: "15:00", endTime: "16:30" })),
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

  it("reads the slot only while it is switched on, then wants it on the grid and forwards", () => {
    expect(validateDutyDraft(duty({ blocks: false, startTime: "15:03" }))).toBeNull();
    expect(validateDutyDraft(duty({ blocks: true, startTime: "", endTime: "16:00" }))).toEqual({
      reason: "slotTimeRequired",
    });
    expect(validateDutyDraft(duty({ blocks: true, startTime: "15:03", endTime: "16:00" }))).toEqual({
      reason: "slotOffGrid",
      time: "15:03",
      grid: 5,
    });
    expect(validateDutyDraft(duty({ blocks: true, startTime: "16:00", endTime: "15:00" }))).toEqual({
      reason: "slotReversed",
      start: "16:00",
      end: "15:00",
    });
    expect(validateDutyDraft(duty({ blocks: true, startTime: "15:00", endTime: "15:00" }))).toEqual({
      reason: "slotReversed",
      start: "15:00",
      end: "15:00",
    });
  });

  it("refuses a note over 500", () => {
    expect(validateDutyDraft(duty({ note: "n".repeat(501) }))).toEqual({
      reason: "dutyNoteTooLong",
      max: 500,
    });
  });

  it("sends every key, the slot as null when off, and round-trips a stored uppdrag", () => {
    expect(dutyDraftToBody(duty({ label: "  Mentor 7B ", note: " " }))).toEqual({
      kind: "MENTORSKAP",
      label: "Mentor 7B",
      minutesPerWeek: 90,
      countsAsTeaching: false,
      subjectId: null,
      studentGroupId: null,
      blockedSlot: null,
      note: null,
    });
    const stored = {
      id: "d1",
      userId: "t1",
      academicYearId: "y1",
      kind: "APT_KONFERENS" as const,
      label: "APT",
      minutesPerWeek: 120,
      countsAsTeaching: true,
      subjectId: null,
      studentGroupId: "g-7b",
      blockedConstraintId: "c1",
      // The gateway may send seconds; the time input holds HH:MM.
      blockedSlot: { dayOfWeek: 2, startTime: "15:00:00", endTime: "17:00:00" },
      note: "Varannan vecka",
    };
    expect(dutyDraftToBody(dutyToDraft(stored))).toEqual({
      kind: "APT_KONFERENS",
      label: "APT",
      minutesPerWeek: 120,
      countsAsTeaching: true,
      subjectId: null,
      studentGroupId: "g-7b",
      blockedSlot: { dayOfWeek: 2, startTime: "15:00", endTime: "17:00" },
      note: "Varannan vecka",
    });
  });
});
