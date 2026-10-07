import { SLOT_MINUTES, carriesSeconds, minutesOf } from '../common/solver-grid';
import { parseTimeString } from '../common/utils/time';

/**
 * An uppdrag's fixed weekly time, and the one shape of the constraint that
 * holds it.
 *
 * ONE WRITER OF THE SHAPE. A duty's slot is an UNAVAILABLE TEACHER
 * AvailabilityConstraint for the duty's own teacher, weekly, with the bare
 * word "Uppdrag" as its reason — the shape the Fas 2 triggers
 * (TeacherDuties_block_is_the_teachers, 20261007090000) accept and the
 * drawer reads back. Two paths write it: TeacherDutiesService, one duty at a
 * time, and the läsårsrullning, which carries every uppdrag's slot into the
 * next year as a NEW row (staffing Fas 5). Both take the row's data from
 * dutySlotConstraintData, so a column added to the shape is added for both,
 * and the rollover registry's audit holds the rollover's writes to it.
 */

/** The weekly time an uppdrag blocks, as the client writes it and reads it back. */
export interface DutySlot {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

/**
 * The reason a linked constraint carries: the word, never the uppdrag's label
 * or kind. availability_teacher_select hands every TEACHER of the school every
 * AvailabilityConstraints row, so whatever stands here is read by every
 * colleague — and the label ("Förstelärare matematik", "Mentor 7B") is the HR
 * data teacher_duties_teacher_own_select keeps from them. The admin reads the
 * label from the duty, which the constraint names through blockedConstraintId.
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
