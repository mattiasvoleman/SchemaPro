import { SLOT_MINUTES, carriesSeconds, minutesOf } from '../common/solver-grid';
import { parseTimeString, toWallClock } from '../common/utils/time';

/**
 * An uppdrag's fixed weekly time, and the one shape of the constraint that
 * holds it.
 *
 * ONE WRITER OF THE SHAPE. A duty's slot is an UNAVAILABLE TEACHER
 * AvailabilityConstraint for the duty's own teacher, weekly, with the bare
 * word "Uppdrag" as its reason — the shape the link's triggers
 * (TeacherDutySlots_are_the_teachers, 20261017090000) accept and the
 * drawer reads back. Two paths write it: TeacherDutiesService, one duty at a
 * time, and the läsårsrullning, which carries every uppdrag's slot into the
 * next year as a NEW row (staffing Fas 5). Both take the row's data from
 * dutySlotConstraintData, so a column added to the shape is added for both,
 * and the rollover registry's audit holds the rollover's writes to it.
 *
 * SEVERAL TIMES, ONE LINK EACH (migration 20261017090000). An uppdrag holds
 * any number of times, each a TeacherDutySlots row naming one such
 * constraint; the rastvakt on Monday, Wednesday and Friday is one uppdrag
 * with three. The old one-slot column, blockedConstraintId, is retired
 * (20261022090000: no trigger, no key, held empty), so this code reads and
 * writes the link table and nothing else.
 */

/** The weekly time an uppdrag blocks, as the client writes it and reads it back. */
export interface DutySlot {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

/**
 * How many fixed times one uppdrag may hold (migration 20261017090000 gave it
 * several): three rasts a day, five days a week. A rastvakt on Monday,
 * Wednesday and Friday is three; a list longer than fifteen is a typo or an
 * import gone wrong, and every one of them is a weekly row the engine reads.
 */
export const DUTY_SLOTS_MAX = 15;

/** Two weekly times that share a minute on the same weekday. */
export function slotsOverlap(
  a: { dayOfWeek: number; startTime: string; endTime: string },
  b: { dayOfWeek: number; startTime: string; endTime: string },
): boolean {
  return (
    a.dayOfWeek === b.dayOfWeek &&
    minutesOf(a.startTime) < minutesOf(b.endTime) &&
    minutesOf(b.startTime) < minutesOf(a.endTime)
  );
}

/** Monday first, then by start: the order every reader lists an uppdrag's times in. */
export function sortSlots<T extends DutySlot>(slots: readonly T[]): T[] {
  return [...slots].sort(
    (a, b) =>
      a.dayOfWeek - b.dayOfWeek ||
      minutesOf(a.startTime) - minutesOf(b.startTime) ||
      minutesOf(a.endTime) - minutesOf(b.endTime),
  );
}

/**
 * An uppdrag's times as the client reads them, from its link rows: each
 * constraint's weekday and clocks, sorted. A link whose constraint has no
 * weekday (the guards refuse one; RLS could hide one) is no time rather than
 * half of one.
 */
export function slotsOfLinks(
  links: readonly { availabilityConstraint: { dayOfWeek: number | null; startTime: Date; endTime: Date } | null }[],
): DutySlot[] {
  const slots: DutySlot[] = [];
  for (const link of links) {
    const constraint = link.availabilityConstraint;
    if (!constraint || constraint.dayOfWeek === null) continue;
    slots.push({
      dayOfWeek: constraint.dayOfWeek,
      startTime: toWallClock(constraint.startTime),
      endTime: toWallClock(constraint.endTime),
    });
  }
  return sortSlots(slots);
}

/** What every read of an uppdrag includes to answer slotsOfLinks. */
export const WITH_SLOT_TIMES = {
  slots: {
    select: {
      availabilityConstraint: { select: { dayOfWeek: true, startTime: true, endTime: true } },
    },
  },
} as const;

/**
 * The reason a linked constraint carries: the word, never the uppdrag's label
 * or kind. availability_teacher_select hands every TEACHER of the school every
 * AvailabilityConstraints row, so whatever stands here is read by every
 * colleague — and the label ("Förstelärare matematik", "Mentor 7B") is the HR
 * data teacher_duties_teacher_own_select keeps from them. The admin reads the
 * label from the duty, which the constraint's link (TeacherDutySlots) names.
 * A carried slot gets the word too, whatever its source row said.
 */
export const DUTY_SLOT_REASON = 'Uppdrag';

/** Why a slot is not one the solver can hold, or null when it is. */
export type SlotGridFault =
  | { kind: 'SECONDS'; field: 'startTime' | 'endTime' }
  | { kind: 'OFF_GRID'; field: 'startTime' | 'endTime' }
  | { kind: 'ORDER' };

/**
 * The non-throwing core of the slot rule: whole minutes, on the solver's
 * five-minute grid, start before end. TeacherDutiesService turns a fault into
 * a 400 naming the field; the rollover carries a slot only when there is none
 * (a slot written by PostgREST can be anything the triggers let through).
 */
export function slotGridFault(slot: DutySlot): SlotGridFault | null {
  for (const field of ['startTime', 'endTime'] as const) {
    if (carriesSeconds(slot[field])) return { kind: 'SECONDS', field };
    if (minutesOf(slot[field]) % SLOT_MINUTES !== 0) return { kind: 'OFF_GRID', field };
  }
  if (minutesOf(slot.startTime) >= minutesOf(slot.endTime)) return { kind: 'ORDER' };
  return null;
}

export function isOnSolverGrid(slot: DutySlot): boolean {
  return slotGridFault(slot) === null;
}

/** The time columns of the constraint that holds a slot: weekly, never dated. */
export function dutySlotTimes(slot: DutySlot) {
  return {
    dayOfWeek: slot.dayOfWeek,
    date: null,
    startTime: parseTimeString(slot.startTime),
    endTime: parseTimeString(slot.endTime),
  };
}

/**
 * The whole row of a new slot for `userId`: every column the shape fixes,
 * the ones it leaves empty written as null, so a reader of the call (and the
 * registry audit) sees a decision rather than a default.
 */
export function dutySlotConstraintData(schoolId: string, userId: string, slot: DutySlot) {
  return {
    schoolId,
    resourceType: 'TEACHER' as const,
    userId,
    roomId: null,
    studentGroupId: null,
    minGradeLevel: null,
    maxGradeLevel: null,
    type: 'UNAVAILABLE' as const,
    reason: DUTY_SLOT_REASON,
    ...dutySlotTimes(slot),
  };
}
