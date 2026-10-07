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

export interface DutyDraft {
  kind: TeacherDutyKind;
  label: string;
  minutesPerWeek: string;
  countsAsTeaching: boolean;
  /** "" for none. */
  subjectId: string;
  studentGroupId: string;
  /** "Blockera tid i schemat": the three fields below are read only when on. */
  blocks: boolean;
  /** "1".."7", Monday first, as AvailabilityConstraints count. */
  dayOfWeek: string;
  /** HH:MM, as `<input type="time">` writes it. */
  startTime: string;
  endTime: string;
  note: string;
}

export const EMPTY_DUTY_DRAFT: DutyDraft = {
  kind: "MENTORSKAP",
  label: "",
  minutesPerWeek: "",
  countsAsTeaching: false,
  subjectId: "",
  studentGroupId: "",
  blocks: false,
  dayOfWeek: "1",
  startTime: "",
  endTime: "",
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
  /** Null removes the slot and its constraint; an object writes or moves it. */
  blockedSlot: { dayOfWeek: number; startTime: string; endTime: string } | null;
  note: string | null;
}

export type DutyProblem =
  | { reason: "dutyLabelRequired" }
  | { reason: "dutyLabelTooLong"; max: number }
  | { reason: "dutyMinutesOutOfRange"; max: number }
  | { reason: "dutyNoteTooLong"; max: number }
  | { reason: "slotTimeRequired" }
  | { reason: "slotOffGrid"; time: string; grid: number }
  | { reason: "slotReversed"; start: string; end: string };

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
 * — and the slot as assertDutySlot does: both times on the five-minute grid,
 * start before end. A slot is only read while "Blockera tid" is on, so
 * switching it off with half-typed times does not hold the save hostage.
 */
export function validateDutyDraft(draft: DutyDraft): DutyProblem | null {
  if (!/\S/.test(draft.label)) return { reason: "dutyLabelRequired" };
  if (codePoints(draft.label.trim()) > DUTY_LABEL_MAX) {
    return { reason: "dutyLabelTooLong", max: DUTY_LABEL_MAX };
  }
  const minutes = wholeNumber(draft.minutesPerWeek);
  if (minutes === null || minutes < 1 || minutes > DUTY_MINUTES_MAX) {
    return { reason: "dutyMinutesOutOfRange", max: DUTY_MINUTES_MAX };
  }
  if (draft.blocks) {
    const start = minutesOfClock(draft.startTime);
    const end = minutesOfClock(draft.endTime);
    if (start === null || end === null) return { reason: "slotTimeRequired" };
    for (const [value, time] of [
      [start, draft.startTime],
      [end, draft.endTime],
    ] as const) {
      if (value % SLOT_GRID_MINUTES !== 0) {
        return { reason: "slotOffGrid", time, grid: SLOT_GRID_MINUTES };
      }
    }
    if (start >= end) return { reason: "slotReversed", start: draft.startTime, end: draft.endTime };
  }
  if (codePoints(draft.note.trim()) > DUTY_NOTE_MAX) {
    return { reason: "dutyNoteTooLong", max: DUTY_NOTE_MAX };
  }
  return null;
}

/**
 * The draft as POST and PATCH take it. Every key is present on both: a PATCH
 * that left blockedSlot out would keep a slot the admin just switched off,
 * and one that left the note out would keep a note they just cleared.
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
    blockedSlot: draft.blocks
      ? {
          dayOfWeek: Number(draft.dayOfWeek),
          startTime: draft.startTime,
          endTime: draft.endTime,
        }
      : null,
    note: note === "" ? null : note,
  };
}

/** A stored uppdrag as the form holds it. Seconds are cut off the slot's clocks. */
export function dutyToDraft(duty: TeacherDuty): DutyDraft {
  return {
    kind: duty.kind,
    label: duty.label,
    minutesPerWeek: String(duty.minutesPerWeek),
    countsAsTeaching: duty.countsAsTeaching,
    subjectId: duty.subjectId ?? "",
    studentGroupId: duty.studentGroupId ?? "",
    blocks: duty.blockedSlot !== null,
    dayOfWeek: String(duty.blockedSlot?.dayOfWeek ?? 1),
    startTime: duty.blockedSlot?.startTime.slice(0, 5) ?? "",
    endTime: duty.blockedSlot?.endTime.slice(0, 5) ?? "",
    note: duty.note ?? "",
  };
}
