// The timetable's two searches for a free time: the nearest slots a refused
// drop could go to instead (suggestPlacements), and the times a set of classes
// and a teacher are free together (findOpenSlots, the create dialog's
// slot finder).
//
// Moved out of lib/conflicts.ts. Both run only after a refused drop or a press
// of the slot finder, never to draw the grid, while lib/conflicts.ts is in the
// timetable route's first load because the grid's red/green feedback needs
// it. The page reaches these through components/schedule/lesson-dialogs.ts, the
// chunk it fetches right after mounting, so they cost the route nothing.

import type { AvailabilityConstraint } from "@/lib/types";
import {
  groupsOf,
  overlaps,
  teacherIdsOf,
  validatePlacement,
  type Placement,
} from "@/lib/conflicts";
import { timeToMinutes } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Smart placement suggestions ("magic move")
// ---------------------------------------------------------------------------

export interface PlacementSuggestion {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  /** Lower = closer to the requested slot. */
  score: number;
}

/**
 * Finds the nearest conflict-free slots for a lesson, preserving its
 * duration. Scans the week on a fixed step and ranks results by distance
 * from the requested placement (same-day placements rank first).
 */
export function suggestPlacements(
  candidate: Placement,
  others: Placement[],
  constraints: AvailabilityConstraint[],
  options?: {
    dayStartMinutes?: number;
    dayEndMinutes?: number;
    days?: number[];
    stepMinutes?: number;
    limit?: number;
    studentGroupOf?: Map<string, string | null>;
  },
): PlacementSuggestion[] {
  const dayStart = options?.dayStartMinutes ?? 8 * 60;
  const dayEnd = options?.dayEndMinutes ?? 17 * 60;
  const days = options?.days ?? [1, 2, 3, 4, 5];
  const step = options?.stepMinutes ?? 15;
  const limit = options?.limit ?? 5;
  const duration = candidate.endMinutes - candidate.startMinutes;

  const suggestions: PlacementSuggestion[] = [];

  for (const day of days) {
    for (let start = dayStart; start + duration <= dayEnd; start += step) {
      if (
        day === candidate.dayOfWeek &&
        start === candidate.startMinutes
      ) {
        continue; // the (conflicting) requested slot itself
      }
      const attempt: Placement = {
        ...candidate,
        dayOfWeek: day,
        startMinutes: start,
        endMinutes: start + duration,
      };
      if (
        validatePlacement(attempt, others, constraints, options?.studentGroupOf)
          .length > 0
      ) {
        continue;
      }

      const dayDistance = Math.abs(day - candidate.dayOfWeek);
      const timeDistance = Math.abs(start - candidate.startMinutes);
      suggestions.push({
        dayOfWeek: day,
        startMinutes: start,
        endMinutes: start + duration,
        score: dayDistance * 1440 + timeDistance,
      });
    }
  }

  return suggestions.sort((a, b) => a.score - b.score).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Open-slot finder ("when can these classes meet, and with which teacher?")
// ---------------------------------------------------------------------------

export interface OpenSlotMatch {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  teacherId: string;
  /** false = the class's assigned subject teacher; true = free fallback. */
  isFallback: boolean;
}

function groupFreeAt(
  groupId: string,
  dayOfWeek: number,
  startMinutes: number,
  endMinutes: number,
  placements: Placement[],
  constraints: AvailabilityConstraint[],
): boolean {
  for (const placement of placements) {
    if (placement.dayOfWeek !== dayOfWeek) continue;
    if (!groupsOf(placement).includes(groupId)) continue;
    // Widened by the EXISTING lesson's own buffer, which is the half this
    // function can know: the class is still in the omklädningsrummet after its
    // idrott, so the twenty minutes after it are not a slot the class can meet
    // in. The buffer of the lesson being PLANNED is not knowable here — the
    // subject is being picked in the dialog and may have no requirement for
    // these groups yet — so a slot this offers is still checked by
    // validatePlacement when the lesson is actually placed.
    //
    // teacherFreeAt below is deliberately NOT widened, for the reason
    // validatePlacement states at shareTheClock.
    if (
      overlaps(
        startMinutes,
        endMinutes,
        placement.startMinutes - (placement.minutesBefore ?? 0),
        placement.endMinutes + (placement.minutesAfter ?? 0),
      )
    ) {
      return false;
    }
  }
  for (const constraint of constraints) {
    if (constraint.type !== "UNAVAILABLE" || constraint.date !== null) continue;
    if (constraint.dayOfWeek !== dayOfWeek) continue;
    if (constraint.resourceType !== "STUDENT_GROUP") continue;
    if (constraint.studentGroupId !== groupId) continue;
    if (
      overlaps(
        startMinutes,
        endMinutes,
        timeToMinutes(constraint.startTime),
        timeToMinutes(constraint.endTime),
      )
    ) {
      return false;
    }
  }
  return true;
}

function teacherFreeAt(
  teacherId: string,
  dayOfWeek: number,
  startMinutes: number,
  endMinutes: number,
  placements: Placement[],
  constraints: AvailabilityConstraint[],
): boolean {
  for (const placement of placements) {
    if (placement.dayOfWeek !== dayOfWeek) continue;
    if (!teacherIdsOf(placement).includes(teacherId)) continue;
    if (overlaps(startMinutes, endMinutes, placement.startMinutes, placement.endMinutes)) {
      return false;
    }
  }
  for (const constraint of constraints) {
    if (constraint.type !== "UNAVAILABLE" || constraint.date !== null) continue;
    if (constraint.dayOfWeek !== dayOfWeek) continue;
    if (constraint.resourceType !== "TEACHER" || constraint.userId !== teacherId) {
      continue;
    }
    if (
      overlaps(
        startMinutes,
        endMinutes,
        timeToMinutes(constraint.startTime),
        timeToMinutes(constraint.endTime),
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Finds slots where EVERY given class is free, paired with a teacher:
 * assigned subject teachers are tried first for each slot; when none of them
 * is free, any other free teacher of the subject is offered as a fallback.
 * Assigned-teacher matches always rank before fallback matches.
 */
export function findOpenSlots(options: {
  studentGroupIds: string[];
  /** Individual students who must also be free (their class + electives). */
  participantStudentIds?: string[];
  /** studentId → their class id (for participant availability). */
  studentGroupOf?: Map<string, string | null>;
  durationMinutes: number;
  /** Teachers assigned to this subject for the given classes (requirements). */
  primaryTeacherIds: string[];
  /** Other teachers who teach the subject (any class). */
  fallbackTeacherIds: string[];
  placements: Placement[];
  constraints: AvailabilityConstraint[];
  days?: number[];
  dayStartMinutes?: number;
  dayEndMinutes?: number;
  stepMinutes?: number;
  limit?: number;
}): OpenSlotMatch[] {
  const days = options.days ?? [1, 2, 3, 4, 5];
  const dayStart = options.dayStartMinutes ?? 8 * 60;
  const dayEnd = options.dayEndMinutes ?? 17 * 60;
  const step = options.stepMinutes ?? 15;
  const limit = options.limit ?? 8;
  const duration = options.durationMinutes;

  const primary = [...new Set(options.primaryTeacherIds)];
  const fallback = [...new Set(options.fallbackTeacherIds)].filter(
    (id) => !primary.includes(id),
  );

  const primaryMatches: OpenSlotMatch[] = [];
  const fallbackMatches: OpenSlotMatch[] = [];

  const participants = options.participantStudentIds ?? [];
  const effectiveGroupIds = [
    ...new Set([
      ...options.studentGroupIds,
      ...participants
        .map((studentId) => options.studentGroupOf?.get(studentId) ?? null)
        .filter((groupId): groupId is string => Boolean(groupId)),
    ]),
  ];

  for (const day of days) {
    for (let start = dayStart; start + duration <= dayEnd; start += step) {
      const end = start + duration;

      const allGroupsFree = effectiveGroupIds.every((groupId) =>
        groupFreeAt(groupId, day, start, end, options.placements, options.constraints),
      );
      if (!allGroupsFree) continue;

      // Electives: a participant may also be individually booked elsewhere.
      const participantBusy =
        participants.length > 0 &&
        options.placements.some(
          (placement) =>
            placement.dayOfWeek === day &&
            overlaps(start, end, placement.startMinutes, placement.endMinutes) &&
            (placement.studentIds ?? []).some((id) => participants.includes(id)),
        );
      if (participantBusy) continue;

      const freePrimary = primary.find((teacherId) =>
        teacherFreeAt(teacherId, day, start, end, options.placements, options.constraints),
      );
      if (freePrimary) {
        primaryMatches.push({
          dayOfWeek: day,
          startMinutes: start,
          endMinutes: end,
          teacherId: freePrimary,
          isFallback: false,
        });
        continue;
      }

      const freeFallback = fallback.find((teacherId) =>
        teacherFreeAt(teacherId, day, start, end, options.placements, options.constraints),
      );
      if (freeFallback) {
        fallbackMatches.push({
          dayOfWeek: day,
          startMinutes: start,
          endMinutes: end,
          teacherId: freeFallback,
          isFallback: true,
        });
      }
    }
  }

  return [...primaryMatches, ...fallbackMatches].slice(0, limit);
}
