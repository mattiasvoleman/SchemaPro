// Client-side conflict engine for the master timetable.
//
// Mirrors the server-side validation in `src/calendar/master-lessons.service.ts`
// (teacher/room/group double-bookings + weekly UNAVAILABLE constraints) so the
// UI can highlight existing clashes on the grid and give red/green feedback
// *during* a drag, before anything is saved. The server remains the source of
// truth — every mutation is still validated there.

import type {
  AvailabilityConstraint,
  LessonRecurrence,
  MasterLesson,
} from "@/lib/types";
import { breaksFrame, type FrameTime } from "@/lib/frame-times";
import { spanMeetsRule, type GradeSpan } from "@/lib/grade-span";
import { timeToMinutes } from "@/lib/utils";

/**
 * FRAME is its own kind rather than a second AVAILABILITY.
 *
 * The two are answered differently by the person reading them. "Läraren är
 * upptagen" is about one row and is fixed by moving one lesson; "åk 4 slutar
 * 15:00" is about the shape of the school day, and the fix may be the frame
 * rather than the lesson. Folding them together would make the grid say the
 * same sentence for both.
 */
export type ConflictKind =
  | "TEACHER"
  | "ROOM"
  | "GROUP"
  | "AVAILABILITY"
  | "FRAME"
  | "LUNCH"
  | "ROOM_LOCK";

export interface ConflictHit {
  kind: ConflictKind;
  /** The other master lesson involved, when applicable. */
  otherLessonId?: string;
  /**
   * GROUP only: the two lessons do not overlap on the clock at all, and the
   * clash exists solely because the PUPILS need time on one side or the other —
   * ombyte before idrotten, dusch after it.
   *
   * A flag rather than a sentence, because lib/ holds no user-facing text: the
   * page turns it into the Swedish the API's own 409 uses. It is here because
   * the kind alone misleads in exactly this case — "the group is busy" over a
   * slot an admin can see is empty reads as a bug in the grid, not as a rule
   * the school itself configured.
   *
   * NOT a ConflictKind of its own, deliberately. The API reports this as a
   * GROUP conflict with a different message (master-lessons.service.ts,
   * findConflicts), and this file exists to mirror its verdicts — a kind the
   * server never sends would be a second vocabulary for one rule.
   */
  pupilBufferOnly?: true;
}

/**
 * Minutes the PUPILS of a lesson are occupied outside it: ombyte before
 * idrotten, dusch and ombyte after it.
 *
 * The browser mirror of the API's own PupilBuffer. Written on the
 * TeachingRequirement, so it is said once per (class, subject) and read here
 * per lesson — see buildPupilBufferMap for how a lesson reaches its row.
 */
export interface PupilBuffer {
  minutesBefore: number;
  minutesAfter: number;
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
  /** Which weeks the lesson runs; absent means every week. */
  recurrence?: LessonRecurrence;
  startDate?: string | null;
  endDate?: string | null;
  /**
   * The pupils' own minutes on either side of this lesson. Absent — the file's
   * convention for an optional argument — means none are checked, which is the
   * honest reading of a caller that has not loaded the timplan: every school
   * carries 0 here today and most always will, and with both absent every test
   * below collapses to the exact half-open one the check has always used.
   */
  minutesBefore?: number;
  minutesAfter?: number;
}

/**
 * Whether two placements can ever fall in the same week.
 *
 * The browser mirror of the API's weeksCanOverlap: a lesson on odd weeks and
 * one on even weeks may share a slot, a room and a teacher. The two must agree
 * — if the grid says a slot is free and the API disagrees, the drag is
 * rejected after the fact; if the grid is the lenient one, the school is shown
 * a schedule the API will never accept.
 */
export function weeksCanOverlap(a: Placement, b: Placement): boolean {
  const first = a.recurrence ?? "ALL_WEEKS";
  const second = b.recurrence ?? "ALL_WEEKS";
  if (
    (first === "ODD_WEEKS" && second === "EVEN_WEEKS") ||
    (first === "EVEN_WEEKS" && second === "ODD_WEEKS")
  ) {
    return false;
  }

  // Dates are YYYY-MM-DD, so a string comparison is a date comparison.
  if (a.endDate && b.startDate && a.endDate < b.startDate) return false;
  if (b.endDate && a.startDate && b.endDate < a.startDate) return false;

  return true;
}

/**
 * Every class in the room, not just the one the placement is named for.
 *
 * Exported because gaps.ts has to ask the same question of its probes, and a
 * multi-group probe is not an edge case there — buildProbes folds a search over
 * several classes into ONE placement carrying the rest in extraGroupIds. A
 * second copy of this line in that file read only the first of them, and a
 * frame closing the morning for the second class was silently not applied.
 */
export function groupsOf(placement: Placement): string[] {
  return [placement.studentGroupId, ...(placement.extraGroupIds ?? [])];
}

/**
 * Both teachers in the room, not just the one the lesson is filed under.
 *
 * Exported for the same reason its neighbour `groupsOf` is: the timetable's own
 * filter asked `lesson.teacherId === filter` and therefore hid every lesson a
 * teacher only CO-taught — and filed a lesson carrying only a coTeacherId
 * under "no teacher at all" in the per-teacher lanes. A second copy of this one
 * line in that file is how that stayed true.
 */
export function teacherIdsOf(placement: Placement): string[] {
  return [placement.teacherId, placement.coTeacherId ?? null].filter(
    (id): id is string => Boolean(id),
  );
}

/**
 * (class, subject) → the minutes its pupils are occupied outside the lesson.
 *
 * HOW A LESSON REACHES ITS REQUIREMENT. It cannot name one: MasterLesson has no
 * teachingRequirementId, in the API's schema any more than in lib/types.ts. What
 * it does carry is the pair a requirement is unique on within a läsår — group
 * and subject — which is the same key the API's own findConflicts maps buffers
 * with, and the same key admin/requirements indexes its matrix on.
 *
 * Only the rows carrying a number go in. The overwhelmingly common map is
 * therefore empty, every lookup misses, and nothing about the clash check
 * changes.
 */
export type PupilBufferMap = Map<string, PupilBuffer>;

export function buildPupilBufferMap(
  requirements: Array<{
    studentGroupId: string;
    subjectId: string;
    minutesBefore: number;
    minutesAfter: number;
  }>,
): PupilBufferMap {
  const map: PupilBufferMap = new Map();
  for (const requirement of requirements) {
    if (requirement.minutesBefore === 0 && requirement.minutesAfter === 0) continue;
    map.set(`${requirement.studentGroupId}:${requirement.subjectId}`, {
      minutesBefore: requirement.minutesBefore,
      minutesAfter: requirement.minutesAfter,
    });
  }
  return map;
}

/**
 * The buffer a lesson inherits, read off its PRIMARY class's requirement.
 *
 * One answer per lesson rather than one per class on it, which is the reading
 * the API argues at the same lookup: an extra class joining the same idrott
 * changes in the same omklädningsrum on the same minutes, so the lesson has one
 * answer — and taking the widest of several requirements would let a class that
 * merely joins lengthen the occupancy for everybody, which no row says.
 */
export function pupilBufferOf(
  buffers: PupilBufferMap | undefined,
  lesson: { studentGroupId: string; subjectId: string },
): PupilBuffer | undefined {
  return buffers?.get(`${lesson.studentGroupId}:${lesson.subjectId}`);
}

export function toPlacement(lesson: MasterLesson, buffers?: PupilBufferMap): Placement {
  // Spread rather than defaulted to 0, so a caller that knows nothing about the
  // timplan produces exactly the placement it always did.
  const buffer = pupilBufferOf(buffers, lesson);
  return {
    ...(buffer ?? {}),
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
    recurrence: lesson.recurrence,
    startDate: lesson.startDate,
    endDate: lesson.endDate,
  };
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Whether two placements occupy the same PUPILS at any minute — each span
 * widened by its own buffer before the comparison.
 *
 * Both lessons' buffers count, and either can be what brings the two together:
 * the candidate's own dusch running into the next lesson, or the next lesson's
 * ombyte reaching back into the candidate. Absent means 0 on both sides, at
 * which point this is `overlaps` on the teaching spans.
 */
function pupilsOverlap(a: Placement, b: Placement): boolean {
  return overlaps(
    a.startMinutes - (a.minutesBefore ?? 0),
    a.endMinutes + (a.minutesAfter ?? 0),
    b.startMinutes - (b.minutesBefore ?? 0),
    b.endMinutes + (b.minutesAfter ?? 0),
  );
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
  /**
   * groupId → the years it holds, for GRADE_LEVEL rules.
   *
   * Omitted, year rules are skipped rather than guessed at — which is what this
   * function did for every caller until now, silently. See buildGradeSpans.
   */
  gradeSpanOf?: Map<string, GradeSpan>,
  /**
   * The school's ramtider. Omitted, frames are not checked — which is what
   * every caller did before they existed, and the honest reading of a list
   * that has not loaded yet. An empty array is a different fact: a school with
   * no frames, where every hour is inside the day.
   */
  frames?: FrameTime[],
  /**
   * The lunch each group was given, by groupId and weekday.
   *
   * Omitted, meals are not checked. A band drawn on the grid with no validator
   * behind it looks like a rule and behaves like decoration: the lesson lands
   * on top of the meal, the stripe still shows, and nothing says a word.
   */
  lunchOf?: Map<string, { startMinutes: number; endMinutes: number }>,
  /**
   * The school's room locks, and the lesson's subject and stage to read them
   * with. Omitted, locks are not checked.
   *
   * MUST NOT BE PASSED TO THE DRAG PREDICATE. validateChange treats any hit as
   * a refusal and builds its candidate with the lesson's CURRENT room, since a
   * drag moves time and not place. Feed a room lock into it and the day a
   * school writes one, every lesson of that subject already sitting elsewhere
   * becomes undraggable in time — silently, for a reason unrelated to the move.
   * A lock violation is a visible conflict; see detectConflicts.
   */
  roomLock?: RoomLockCheck,
): ConflictHit[] {
  const hits: ConflictHit[] = [];

  for (const other of others) {
    if (candidate.id !== null && other.id === candidate.id) continue;
    if (other.dayOfWeek !== candidate.dayOfWeek) continue;

    /**
     * THE EXACT half-open test the check has always used, and the only one the
     * teacher and the room arms below are allowed to see.
     *
     * A DECISION, NOT AN OVERSIGHT. The buffer blocks the PUPILS. The
     * idrottslärare neither changes nor showers with the class and may teach the
     * slot on either side; the gymnastiksal stands empty for those same minutes,
     * because the children are in the omklädningsrummet and not in it. Widening
     * these two arms would cost an idrottslärare a third of a teachable week and
     * make a scarce hall unbookable around every lesson — refusing placements
     * that are perfectly true. The API reasons its own two arms out the same way
     * (master-lessons.service.ts, shareTheClock), and so does the solver's room
     * arm; this file exists to say what they say.
     */
    const shareTheClock = overlaps(
      candidate.startMinutes,
      candidate.endMinutes,
      other.startMinutes,
      other.endMinutes,
    );
    // Wider whenever either lesson carries a buffer, and identical to
    // shareTheClock when neither does — which is every school today.
    const sharePupilTime = pupilsOverlap(candidate, other);
    if (!shareTheClock && !sharePupilTime) continue;

    // Sharing a time slot is only a clash if some week holds both: slöjd on
    // odd weeks and hemkunskap on even weeks may share slot, room and teacher.
    if (!weeksCanOverlap(candidate, other)) continue;

    const candidateTeachers = teacherIdsOf(candidate);
    const otherTeachers = teacherIdsOf(other);
    if (shareTheClock && candidateTeachers.some((id) => otherTeachers.includes(id))) {
      hits.push({ kind: "TEACHER", otherLessonId: other.id ?? undefined });
    }
    if (shareTheClock && candidate.roomId && other.roomId === candidate.roomId) {
      hits.push({ kind: "ROOM", otherLessonId: other.id ?? undefined });
    }
    const candidateGroups = groupsOf(candidate);
    const otherGroups = groupsOf(other);
    const groupClash =
      candidateGroups.some((groupId) => otherGroups.includes(groupId)) ||
      // Distinct groups, shared students: 7A vs Ma71. Same hard clash.
      groupsShareStudents(candidateGroups, otherGroups, groupConflicts);

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

    // One clash with this lesson is one hit, whichever check found it. The
    // checks overlap by design — a class and one of its own students in both
    // lessons trips all of them — and a caller counting raw hits would
    // otherwise read one clash as two.
    //
    // The pupil arm, and the ONLY arm the buffer widens: `sharePupilTime`
    // rather than `shareTheClock`. A lesson can reach this point on the wider
    // test alone, in which case the groups clash and the clocks do not, and the
    // hit says so — see ConflictHit.pupilBufferOnly for why the kind cannot.
    if (sharePupilTime && (groupClash || studentBusy)) {
      hits.push({
        kind: "GROUP",
        otherLessonId: other.id ?? undefined,
        ...(shareTheClock ? {} : { pupilBufferOnly: true as const }),
      });
    }
  }

  for (const constraint of constraints) {
    if (constraint.type !== "UNAVAILABLE") continue;
    if (constraint.date !== null) continue; // one-off dates act at publish time
    // A rule with no weekday applies to EVERY teaching day — the engine reads
    // it that way (TimeGrid.window_to_absolute_range), and this line used to
    // read it as applying to none, because `null !== 1`. The rules page cannot
    // create such a row today, so this is a divergence closed before it is
    // reached rather than a bug anyone has hit.
    if (constraint.dayOfWeek !== null && constraint.dayOfWeek !== candidate.dayOfWeek) {
      continue;
    }

    const applies =
      (constraint.resourceType === "TEACHER" &&
        constraint.userId !== null &&
        teacherIdsOf(candidate).includes(constraint.userId)) ||
      (constraint.resourceType === "ROOM" &&
        candidate.roomId !== null &&
        constraint.roomId === candidate.roomId) ||
      (constraint.resourceType === "STUDENT_GROUP" &&
        constraint.studentGroupId !== null &&
        groupsOf(candidate).includes(constraint.studentGroupId)) ||
      // A year rule names no row at all — it carries a span instead, and
      // reaches whichever groups overlap it. Without this branch it matched
      // nothing: the solver refused to place åk 4 after 15:00 while this
      // function let a lesson be dragged there and reported no conflict.
      (constraint.resourceType === "GRADE_LEVEL" &&
        groupsOf(candidate).some((groupId) =>
          spanMeetsRule(gradeSpanOf?.get(groupId), constraint),
        ));
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

  // The frames last, so a lesson that is both double-booked and outside the
  // day reports the booking first — that is the one whose fix is unambiguous.
  if (
    frames !== undefined &&
    breaksFrame(
      frames,
      groupsOf(candidate),
      gradeSpanOf,
      candidate.dayOfWeek,
      candidate.startMinutes,
      candidate.endMinutes,
    )
  ) {
    hits.push({ kind: "FRAME" });
  }

  // The meal last of all. A lesson dropped on a class's own lunch is a real
  // clash — the children are in the dining hall — but it is the one the school
  // is most likely to want anyway, so it reports after everything else.
  if (lunchOf !== undefined) {
    for (const groupId of groupsOf(candidate)) {
      const sitting = lunchOf.get(`${groupId}:${candidate.dayOfWeek}`);
      if (
        sitting &&
        overlaps(
          candidate.startMinutes,
          candidate.endMinutes,
          sitting.startMinutes,
          sitting.endMinutes,
        )
      ) {
        hits.push({ kind: "LUNCH" });
        break;
      }
    }
  }

  // The room the school locked. Last, because it is the one hit that says
  // nothing about WHEN the lesson is — it would be just as true at any other
  // time, and a reader scanning a list wants the time clashes first.
  if (roomLock !== undefined && roomLock(candidate)) {
    hits.push({ kind: "ROOM_LOCK" });
  }

  return hits;
}

/** Whether this placement sits in a room its subject's locks forbid. */
export type RoomLockCheck = (placement: Placement) => boolean;

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
  /** groupId → the years it holds; without it GRADE_LEVEL rules are skipped. */
  gradeSpanOf?: Map<string, GradeSpan>,
  /** The school's ramtider; without them frames are not checked. */
  frames?: FrameTime[],
  /** Each group's meal by `groupId:weekday`; without it meals are not checked. */
  lunchOf?: Map<string, { startMinutes: number; endMinutes: number }>,
  /** The school's room locks; without them locks are not checked. */
  roomLock?: RoomLockCheck,
  /**
   * The pupils' ombyte and dusch per (class, subject). Without it the buffers
   * are not checked — which is what every caller did before they existed.
   *
   * Passed here rather than baked into the lessons, because this function maps
   * them to placements itself: a caller has no seam to inject them through.
   */
  pupilBuffers?: PupilBufferMap,
): Map<string, ConflictHit[]> {
  const placements = lessons.map((lesson) => toPlacement(lesson, pupilBuffers));
  const result = new Map<string, ConflictHit[]>();

  for (const placement of placements) {
    const hits = validatePlacement(
      placement,
      placements,
      constraints,
      studentGroupOf,
      groupConflicts,
      gradeSpanOf,
      frames,
      lunchOf,
      roomLock,
    );
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
