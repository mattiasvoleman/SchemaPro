// Client-side conflict engine for the master timetable.
//
// Mirrors the server-side validation in `src/calendar/master-lessons.service.ts`
// (teacher/room/group double-bookings + weekly UNAVAILABLE constraints) so the
// UI can highlight existing clashes on the grid and give red/green feedback
// *during* a drag, before anything is saved. The server remains the source of
// truth — every mutation is still validated there.

import type { AvailabilityConstraint, MasterLesson } from "@/lib/types";
import { timeToMinutes } from "@/lib/utils";

export type ConflictKind = "TEACHER" | "ROOM" | "GROUP" | "AVAILABILITY";

export interface ConflictHit {
  kind: ConflictKind;
  /** The other master lesson involved, when applicable. */
  otherLessonId?: string;
}

/** Minute-based view of a lesson placement used for validation. */
export interface Placement {
  id: string | null;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  teacherId: string | null;
  coTeacherId?: string | null;
  roomId: string | null;
  studentGroupId: string;
  /** Additional classes attending. */
  extraGroupIds?: string[];
  /** Individual participating students. */
  studentIds?: string[];
}

function groupsOf(placement: Placement): string[] {
  return [placement.studentGroupId, ...(placement.extraGroupIds ?? [])];
}

function teacherIdsOf(placement: Placement): string[] {
  return [placement.teacherId, placement.coTeacherId ?? null].filter(
    (id): id is string => Boolean(id),
  );
}

export function toPlacement(lesson: MasterLesson): Placement {
  return {
    id: lesson.id,
    dayOfWeek: lesson.dayOfWeek,
    startMinutes: timeToMinutes(lesson.startTime),
    endMinutes: timeToMinutes(lesson.endTime),
    teacherId: lesson.teacherId,
    coTeacherId: lesson.coTeacherId,
    roomId: lesson.roomId,
    studentGroupId: lesson.studentGroupId,
    extraGroupIds: lesson.extraGroupIds,
    studentIds: lesson.studentIds,
  };
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * groupId → the set of groups sharing at least one student with it. Mirrors
 * the `groupConflicts` relation the gateway sends to the scheduling engine —
 * the manual editor must forbid exactly what generation forbids, or a drag
 * can create the clash the solver just avoided.
 */
export type GroupConflictMap = Map<string, Set<string>>;

/** Build the relation from home classes and teaching-group memberships. */
export function buildGroupConflictMap(
  studentGroupOf: Map<string, string | null>,
  memberships: Array<{ studentId: string; studentGroupId: string }>,
): GroupConflictMap {
  const groupsByStudent = new Map<string, Set<string>>();
  const add = (studentId: string, groupId: string | null) => {
    if (!groupId) return;
    let set = groupsByStudent.get(studentId);
    if (!set) groupsByStudent.set(studentId, (set = new Set()));
    set.add(groupId);
  };
  for (const [studentId, homeId] of studentGroupOf) add(studentId, homeId);
  for (const row of memberships) add(row.studentId, row.studentGroupId);

  const relation: GroupConflictMap = new Map();
  for (const groups of groupsByStudent.values()) {
    if (groups.size < 2) continue;
    for (const a of groups) {
      for (const b of groups) {
        if (a === b) continue;
        let set = relation.get(a);
        if (!set) relation.set(a, (set = new Set()));
        set.add(b);
      }
    }
  }
  return relation;
}

function groupsShareStudents(
  aGroups: string[],
  bGroups: string[],
  relation?: GroupConflictMap,
): boolean {
  if (!relation) return false;
  return aGroups.some((a) => {
    const set = relation.get(a);
    return set !== undefined && bGroups.some((b) => set.has(b));
  });
}

/**
 * Validates a single placement against the rest of the timetable and the
 * weekly UNAVAILABLE constraints. `others` should contain all lessons of the
 * academic year; the placement's own id is skipped automatically.
 */
export function validatePlacement(
  candidate: Placement,
  others: Placement[],
  constraints: AvailabilityConstraint[],
  /** studentId → their class id; enables participant-aware validation. */
  studentGroupOf?: Map<string, string | null>,
  /** Groups sharing students (see buildGroupConflictMap). */
  groupConflicts?: GroupConflictMap,
): ConflictHit[] {
  const hits: ConflictHit[] = [];

  for (const other of others) {
    if (candidate.id !== null && other.id === candidate.id) continue;
    if (other.dayOfWeek !== candidate.dayOfWeek) continue;
    if (
      !overlaps(
        candidate.startMinutes,
        candidate.endMinutes,
        other.startMinutes,
        other.endMinutes,
      )
    ) {
      continue;
    }

    const candidateTeachers = teacherIdsOf(candidate);
    const otherTeachers = teacherIdsOf(other);
    if (candidateTeachers.some((id) => otherTeachers.includes(id))) {
      hits.push({ kind: "TEACHER", otherLessonId: other.id ?? undefined });
    }
    if (candidate.roomId && other.roomId === candidate.roomId) {
      hits.push({ kind: "ROOM", otherLessonId: other.id ?? undefined });
    }
    const candidateGroups = groupsOf(candidate);
    const otherGroups = groupsOf(other);
    if (candidateGroups.some((groupId) => otherGroups.includes(groupId))) {
      hits.push({ kind: "GROUP", otherLessonId: other.id ?? undefined });
    } else if (groupsShareStudents(candidateGroups, otherGroups, groupConflicts)) {
      // Distinct groups, shared students: 7A vs Ma71. Same hard clash.
      hits.push({ kind: "GROUP", otherLessonId: other.id ?? undefined });
    }

    // Individual participants: busy when their own class attends the other
    // lesson, when they attend it individually, or symmetric.
    const otherStudents = other.studentIds ?? [];
    const candidateStudents = candidate.studentIds ?? [];
    const studentBusy =
      candidateStudents.some((studentId) => {
        if (otherStudents.includes(studentId)) return true;
        const home = studentGroupOf?.get(studentId);
        return Boolean(home && otherGroups.includes(home));
      }) ||
      otherStudents.some((studentId) => {
        const home = studentGroupOf?.get(studentId);
        return Boolean(home && candidateGroups.includes(home));
      });
    if (studentBusy) {
      hits.push({ kind: "GROUP", otherLessonId: other.id ?? undefined });
    }
  }

  for (const constraint of constraints) {
    if (constraint.type !== "UNAVAILABLE") continue;
    if (constraint.date !== null) continue; // one-off dates act at publish time
    if (constraint.dayOfWeek !== candidate.dayOfWeek) continue;

    const applies =
      (constraint.resourceType === "TEACHER" &&
        constraint.userId !== null &&
        teacherIdsOf(candidate).includes(constraint.userId)) ||
      (constraint.resourceType === "ROOM" &&
        candidate.roomId !== null &&
        constraint.roomId === candidate.roomId) ||
      (constraint.resourceType === "STUDENT_GROUP" &&
        constraint.studentGroupId !== null &&
        groupsOf(candidate).includes(constraint.studentGroupId));
    if (!applies) continue;

    if (
      overlaps(
        candidate.startMinutes,
        candidate.endMinutes,
        timeToMinutes(constraint.startTime),
        timeToMinutes(constraint.endTime),
      )
    ) {
      hits.push({ kind: "AVAILABILITY" });
    }
  }

  return hits;
}

/**
 * Detects every existing conflict on the grid. Returns a map of lessonId →
 * conflict hits (empty map means a clean timetable). O(n²) per weekday, which
 * is fine for realistic school sizes (a few thousand weekly lessons).
 */
export function detectConflicts(
  lessons: MasterLesson[],
  constraints: AvailabilityConstraint[],
  studentGroupOf?: Map<string, string | null>,
  groupConflicts?: GroupConflictMap,
): Map<string, ConflictHit[]> {
  const placements = lessons.map(toPlacement);
  const result = new Map<string, ConflictHit[]>();

  for (const placement of placements) {
    const hits = validatePlacement(placement, placements, constraints, studentGroupOf, groupConflicts);
    if (hits.length > 0 && placement.id) {
      result.set(placement.id, hits);
    }
  }

  return result;
}

/** Deduplicated conflict kinds for one lesson (for compact badge rendering). */
export function conflictKinds(hits: ConflictHit[]): ConflictKind[] {
  return [...new Set(hits.map((hit) => hit.kind))];
}

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
    if (overlaps(startMinutes, endMinutes, placement.startMinutes, placement.endMinutes)) {
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
