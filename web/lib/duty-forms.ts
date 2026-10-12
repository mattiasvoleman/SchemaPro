import { wholeNumber } from "@/lib/staffing-forms";
import type { TeacherDuty, TeacherDutyKind } from "@/lib/types";

/*
 * The uppdrag form's draft, its bounds, and what it sends — CreateTeacherDutyDto
 * and assertDutySlot mirrored, for the reason lib/staffing-forms.ts gives: the
 * gateway refuses already, and the point of repeating it is that the sentence
 * lands next to the field before the save is pressed. Every reason is a
 * `staffing.problem_*` key with its ICU arguments beside it.
 *
 * A MODULE OF ITS OWN, not a section of staffing-forms.ts, for the bundle:
 * lib/csv.ts imports parseDecimal from there, so staffing-forms is in the
 * chunk graph of every page with an import dialog (the timplan, the
 * requirements, people), and Turbopack keeps a module whole. The uppdrag
 * form is read by one card.
 */

/** CreateTeacherDutyDto's bounds, which are the table's CHECKs. */
export const DUTY_LABEL_MAX = 80;
export const DUTY_MINUTES_MAX = 2400;
export const DUTY_NOTE_MAX = 500;
/** The schema's grid; a blocked slot off it is a 400 on the gateway. */
export const SLOT_GRID_MINUTES = 5;
/** DUTY_SLOTS_MAX on the gateway: three rasts a day, five days. */
export const DUTY_SLOTS_MAX = 15;

/** In the order the Göteborg uppdragsbeskrivning lists them, ANNAT last. */
export const DUTY_KINDS: TeacherDutyKind[] = [
  "MENTORSKAP",
  "AMNESANSVAR",
  "FORSTELARARE",
  "RASTVAKT",
  "PEDAGOGISK_LUNCH",
  "APT_KONFERENS",
  "VFU_HANDLEDNING",
  "APL",
  "ANNAT",
];

/** One fixed time as the form holds it. */
export interface SlotDraft {
  /** "1".."7", Monday first, as AvailabilityConstraints count. */
  dayOfWeek: string;
  /** HH:MM, as `<input type="time">` writes it. */
  startTime: string;
  endTime: string;
}

export const EMPTY_SLOT_DRAFT: SlotDraft = { dayOfWeek: "1", startTime: "", endTime: "" };

export interface DutyDraft {
  kind: TeacherDutyKind;
  label: string;
  minutesPerWeek: string;
  countsAsTeaching: boolean;
  /** "" for none. */
  subjectId: string;
  studentGroupId: string;
  /** Från and Till as `<input type="date">` writes them; "" for the läsår's own bound. */
  validFrom: string;
  validTo: string;
  /** "Blockera tid i schemat": the times below are read only when on. */
  blocks: boolean;
  /** The fixed weekly times (migration 20261017090000: an uppdrag holds several). */
  slots: SlotDraft[];
  note: string;
}

export const EMPTY_DUTY_DRAFT: DutyDraft = {
  kind: "MENTORSKAP",
  label: "",
  minutesPerWeek: "",
  countsAsTeaching: false,
  subjectId: "",
  studentGroupId: "",
  validFrom: "",
  validTo: "",
  blocks: false,
  slots: [EMPTY_SLOT_DRAFT],
  note: "",
};

/** The body POST /teacher-duties takes, less the teacher and the year. */
export interface DutyBody {
  kind: TeacherDutyKind;
  label: string;
  minutesPerWeek: number;
  countsAsTeaching: boolean;
  subjectId: string | null;
  studentGroupId: string | null;
  validFrom: string | null;
  validTo: string | null;
  /** The whole list: [] removes every time and its constraint; a PATCH replaces them. */
  slots: { dayOfWeek: number; startTime: string; endTime: string }[];
  note: string | null;
}

export type DutyProblem =
  | { reason: "dutyLabelRequired" }
  | { reason: "dutyLabelTooLong"; max: number }
  | { reason: "dutyMinutesOutOfRange"; max: number }
  | { reason: "dutyNoteTooLong"; max: number }
  | { reason: "dutyDatesReversed"; from: string; to: string }
  | { reason: "dutyDateOutsideYear"; date: string; start: string; end: string }
  | { reason: "slotTimeRequired"; index: number }
  | { reason: "slotOffGrid"; index: number; time: string; grid: number }
  | { reason: "slotReversed"; index: number; start: string; end: string }
  | { reason: "slotsOverlap"; index: number; other: number }
  | { reason: "slotsTooMany"; max: number };

/** Characters as the gateway's MaxCodePoints counts them: an emoji is one. */
const codePoints = (value: string) => [...value].length;

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOfClock = (value: string) => {
  const match = CLOCK.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/**
 * The first reason the uppdrag cannot be saved, or null.
 *
 * The label is checked as the DTO and the CHECK check it — at least one
 * non-blank character (the /\S/ rule P1 settled on), at most 80 code points
 * — Till not before Från (the CHECK) and both inside the läsår when its
 * bounds are known (the gateway reads them FOR SHARE and says the same), and
 * every time as assertDutySlots does: on the five-minute grid, start before
 * end, no two sharing a minute on one weekday. Times are only read while
 * "Blockera tid" is on, so switching it off with half-typed times does not
 * hold the save hostage. A slot problem names its row, counted from 1.
 */
export function validateDutyDraft(
  draft: DutyDraft,
  year?: { startDate: string; endDate: string } | null,
): DutyProblem | null {
  if (!/\S/.test(draft.label)) return { reason: "dutyLabelRequired" };
  if (codePoints(draft.label.trim()) > DUTY_LABEL_MAX) {
    return { reason: "dutyLabelTooLong", max: DUTY_LABEL_MAX };
  }
  const minutes = wholeNumber(draft.minutesPerWeek);
  if (minutes === null || minutes < 1 || minutes > DUTY_MINUTES_MAX) {
    return { reason: "dutyMinutesOutOfRange", max: DUTY_MINUTES_MAX };
  }
  if (draft.validFrom !== "" && draft.validTo !== "" && draft.validTo < draft.validFrom) {
    return { reason: "dutyDatesReversed", from: draft.validFrom, to: draft.validTo };
  }
  if (year) {
    for (const date of [draft.validFrom, draft.validTo]) {
      if (date !== "" && (date < year.startDate || date > year.endDate)) {
        return { reason: "dutyDateOutsideYear", date, start: year.startDate, end: year.endDate };
      }
    }
  }
  if (draft.blocks) {
    if (draft.slots.length > DUTY_SLOTS_MAX) return { reason: "slotsTooMany", max: DUTY_SLOTS_MAX };
    const read: { day: string; start: number; end: number }[] = [];
    for (const [position, slot] of draft.slots.entries()) {
      const index = position + 1;
      const start = minutesOfClock(slot.startTime);
      const end = minutesOfClock(slot.endTime);
      if (start === null || end === null) return { reason: "slotTimeRequired", index };
      for (const [value, time] of [
        [start, slot.startTime],
        [end, slot.endTime],
      ] as const) {
        if (value % SLOT_GRID_MINUTES !== 0) {
          return { reason: "slotOffGrid", index, time, grid: SLOT_GRID_MINUTES };
        }
      }
      if (start >= end) return { reason: "slotReversed", index, start: slot.startTime, end: slot.endTime };
      const other = read.findIndex((held) => held.day === slot.dayOfWeek && held.start < end && start < held.end);
      if (other >= 0) return { reason: "slotsOverlap", index, other: other + 1 };
      read.push({ day: slot.dayOfWeek, start, end });
    }
  }
  if (codePoints(draft.note.trim()) > DUTY_NOTE_MAX) {
    return { reason: "dutyNoteTooLong", max: DUTY_NOTE_MAX };
  }
  return null;
}

/**
 * The draft as POST and PATCH take it. Every key is present on both: a PATCH
 * that left the times out would keep times the admin just switched off, one
 * that left Till out would keep a date they just cleared, and one that left
 * the note out would keep a note they just cleared.
 */
export function dutyDraftToBody(draft: DutyDraft): DutyBody {
  const note = draft.note.trim();
  return {
    kind: draft.kind,
    label: draft.label.trim(),
    minutesPerWeek: wholeNumber(draft.minutesPerWeek) ?? 0,
    countsAsTeaching: draft.countsAsTeaching,
    subjectId: draft.subjectId === "" ? null : draft.subjectId,
    studentGroupId: draft.studentGroupId === "" ? null : draft.studentGroupId,
    validFrom: draft.validFrom === "" ? null : draft.validFrom,
    validTo: draft.validTo === "" ? null : draft.validTo,
    slots: draft.blocks
      ? draft.slots.map((slot) => ({
          dayOfWeek: Number(slot.dayOfWeek),
          startTime: slot.startTime,
          endTime: slot.endTime,
        }))
      : [],
    note: note === "" ? null : note,
  };
}

/** A stored uppdrag as the form holds it. Seconds are cut off the times' clocks. */
export function dutyToDraft(duty: TeacherDuty): DutyDraft {
  const slots = (duty.slots ?? []).map((slot) => ({
    dayOfWeek: String(slot.dayOfWeek),
    startTime: slot.startTime.slice(0, 5),
    endTime: slot.endTime.slice(0, 5),
  }));
  return {
    kind: duty.kind,
    label: duty.label,
    minutesPerWeek: String(duty.minutesPerWeek),
    countsAsTeaching: duty.countsAsTeaching,
    subjectId: duty.subjectId ?? "",
    studentGroupId: duty.studentGroupId ?? "",
    validFrom: duty.validFrom ?? "",
    validTo: duty.validTo ?? "",
    blocks: slots.length > 0,
    slots: slots.length > 0 ? slots : [EMPTY_SLOT_DRAFT],
    note: duty.note ?? "",
  };
}
