/**
 * WHAT THE BOARD PAINTS RED, ASKED OF A WHOLE YEAR.
 *
 * The publish gate PUB_CLASHES must not become a third clash rule beside the
 * API's per-write findConflicts (master-lessons.service.ts) and the board's
 * detectConflicts (web/lib/conflicts.ts). It reports what the board already
 * shows: this module is a server mirror of detectConflicts' TEACHER, ROOM,
 * GROUP and AVAILABILITY arms, word for word in its tests, and
 * year-clashes.contract.spec.ts replays one fixture on both sides — this file
 * and web/lib/conflicts.ts — so the two cannot drift.
 *
 * NOT MIRRORED, deliberately: FRAME (ramtider), LUNCH and ROOM_LOCK, which
 * the board shows as conflicts of their own and which say something about the
 * shape of the school day rather than a double booking; and GRADE_LEVEL
 * weekly rules, which need the board's grade spans. A gate counting them
 * would ask the admin to publish "ändå" over a lunch the school chose; the
 * board still shows them, and the gate's text says it counts double bookings.
 *
 * PURE. Times are 'HH:MM' (or 'HH:MM:SS'), dates 'YYYY-MM-DD'.
 */

export type YearClashKind = 'TEACHER' | 'ROOM' | 'GROUP' | 'AVAILABILITY';

export interface YearClashLesson {
  id: string;
  subjectId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  teacherId: string | null;
  coTeacherId?: string | null;
  roomId: string | null;
  studentGroupId: string;
  extraGroupIds?: string[];
  studentIds?: string[];
  recurrence?: 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS' | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface YearClashConstraint {
  type: 'UNAVAILABLE' | 'PREFERRED_FREE' | 'PREFERRED_BUSY' | string;
  resourceType: 'TEACHER' | 'ROOM' | 'STUDENT_GROUP' | 'GRADE_LEVEL' | string;
  userId: string | null;
  roomId: string | null;
  studentGroupId: string | null;
  dayOfWeek: number | null;
  date: string | null;
  startTime: string;
  endTime: string;
}

export interface YearClashInput {
  lessons: YearClashLesson[];
  constraints: YearClashConstraint[];
  /** [studentId, their class id]: participant-aware validation. */
  studentGroupOf: Array<[string, string | null]>;
  /** Teaching-group memberships, for groups sharing pupils. */
  memberships: Array<{ studentId: string; studentGroupId: string }>;
  /** Requirement rows with a pupil buffer (ombyte, dusch). */
  pupilBuffers: Array<{ studentGroupId: string; subjectId: string; minutesBefore: number; minutesAfter: number }>;
}

export interface YearClashHit {
  kind: YearClashKind;
  otherLessonId?: string;
  pupilBufferOnly?: true;
}

const minutesOf = (time: string): number => {
  const [h, m] = time.split(':');
  return Number(h) * 60 + Number(m);
};

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean =>
  aStart < bEnd && bStart < aEnd;

interface Placement {
  id: string;
  dayOfWeek: number;
  start: number;
  end: number;
  before: number;
  after: number;
  teachers: string[];
  roomId: string | null;
  groups: string[];
  students: string[];
  recurrence: 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS';
  startDate: string | null;
  endDate: string | null;
}

function weeksCanOverlap(a: Placement, b: Placement): boolean {
  if (
    (a.recurrence === 'ODD_WEEKS' && b.recurrence === 'EVEN_WEEKS') ||
    (a.recurrence === 'EVEN_WEEKS' && b.recurrence === 'ODD_WEEKS')
  ) {
    return false;
  }
  if (a.endDate && b.startDate && a.endDate < b.startDate) return false;
  if (b.endDate && a.startDate && b.endDate < a.startDate) return false;
  return true;
}

/** groupId → the groups sharing at least one pupil with it (buildGroupConflictMap). */
function groupConflictMap(input: YearClashInput): Map<string, Set<string>> {
  const groupsByStudent = new Map<string, Set<string>>();
  const add = (studentId: string, groupId: string | null) => {
    if (!groupId) return;
    let set = groupsByStudent.get(studentId);
    if (!set) groupsByStudent.set(studentId, (set = new Set()));
    set.add(groupId);
  };
  for (const [studentId, home] of input.studentGroupOf) add(studentId, home);
  for (const row of input.memberships) add(row.studentId, row.studentGroupId);
  const relation = new Map<string, Set<string>>();
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

/**
 * lessonId → its hits, for every lesson with at least one; the map
 * detectConflicts returns, restricted to the four kinds above.
 */
export function yearClashes(input: YearClashInput): Map<string, YearClashHit[]> {
  const buffers = new Map<string, { before: number; after: number }>();
  for (const row of input.pupilBuffers) {
    if (row.minutesBefore === 0 && row.minutesAfter === 0) continue;
    buffers.set(`${row.studentGroupId}:${row.subjectId}`, { before: row.minutesBefore, after: row.minutesAfter });
  }
  const placements: Placement[] = input.lessons.map((lesson) => {
    const groups = [lesson.studentGroupId, ...(lesson.extraGroupIds ?? [])];
    let before = 0;
    let after = 0;
    for (const groupId of groups) {
      const buffer = buffers.get(`${groupId}:${lesson.subjectId}`);
      if (!buffer) continue;
      before = Math.max(before, buffer.before);
      after = Math.max(after, buffer.after);
    }
    return {
      id: lesson.id,
      dayOfWeek: lesson.dayOfWeek,
      start: minutesOf(lesson.startTime),
      end: minutesOf(lesson.endTime),
      before,
      after,
      teachers: [lesson.teacherId, lesson.coTeacherId ?? null].filter((id): id is string => Boolean(id)),
      roomId: lesson.roomId,
      groups,
      students: lesson.studentIds ?? [],
      recurrence: lesson.recurrence ?? 'ALL_WEEKS',
      startDate: lesson.startDate ?? null,
      endDate: lesson.endDate ?? null,
    };
  });
  const relation = groupConflictMap(input);
  const homeOf = new Map(input.studentGroupOf);
  const shareStudents = (a: string[], b: string[]): boolean =>
    a.some((x) => {
      const set = relation.get(x);
      return set !== undefined && b.some((y) => set.has(y));
    });

  const byDay = new Map<number, Placement[]>();
  for (const placement of placements) {
    const list = byDay.get(placement.dayOfWeek);
    if (list) list.push(placement);
    else byDay.set(placement.dayOfWeek, [placement]);
  }

  const result = new Map<string, YearClashHit[]>();
  for (const candidate of placements) {
    const hits: YearClashHit[] = [];
    for (const other of byDay.get(candidate.dayOfWeek) ?? []) {
      if (other.id === candidate.id) continue;
      const shareTheClock = overlaps(candidate.start, candidate.end, other.start, other.end);
      const sharePupilTime = overlaps(
        candidate.start - candidate.before,
        candidate.end + candidate.after,
        other.start - other.before,
        other.end + other.after,
      );
      if (!shareTheClock && !sharePupilTime) continue;
      if (!weeksCanOverlap(candidate, other)) continue;
      if (shareTheClock && candidate.teachers.some((id) => other.teachers.includes(id))) {
        hits.push({ kind: 'TEACHER', otherLessonId: other.id });
      }
      if (shareTheClock && candidate.roomId && other.roomId === candidate.roomId) {
        hits.push({ kind: 'ROOM', otherLessonId: other.id });
      }
      const groupClash =
        candidate.groups.some((groupId) => other.groups.includes(groupId)) ||
        shareStudents(candidate.groups, other.groups);
      const studentBusy =
        candidate.students.some((studentId) => {
          if (other.students.includes(studentId)) return true;
          const home = homeOf.get(studentId);
          return Boolean(home && other.groups.includes(home));
        }) ||
        other.students.some((studentId) => {
          const home = homeOf.get(studentId);
          return Boolean(home && candidate.groups.includes(home));
        });
      if (sharePupilTime && (groupClash || studentBusy)) {
        hits.push({
          kind: 'GROUP',
          otherLessonId: other.id,
          ...(shareTheClock ? {} : { pupilBufferOnly: true as const }),
        });
      }
    }
    for (const constraint of input.constraints) {
      if (constraint.type !== 'UNAVAILABLE') continue;
      if (constraint.date !== null) continue;
      if (constraint.dayOfWeek !== null && constraint.dayOfWeek !== candidate.dayOfWeek) continue;
      const applies =
        (constraint.resourceType === 'TEACHER' &&
          constraint.userId !== null &&
          candidate.teachers.includes(constraint.userId)) ||
        (constraint.resourceType === 'ROOM' && candidate.roomId !== null && constraint.roomId === candidate.roomId) ||
        (constraint.resourceType === 'STUDENT_GROUP' &&
          constraint.studentGroupId !== null &&
          candidate.groups.includes(constraint.studentGroupId));
      if (!applies) continue;
      if (overlaps(candidate.start, candidate.end, minutesOf(constraint.startTime), minutesOf(constraint.endTime))) {
        hits.push({ kind: 'AVAILABILITY' });
      }
    }
    if (hits.length > 0) result.set(candidate.id, hits);
  }
  return result;
}

/**
 * The clashes as pairs, each once: what the gate counts. A pair is (kind,
 * the two lesson ids sorted); an AVAILABILITY hit is the lesson alone.
 */
export function clashPairs(
  clashes: Map<string, YearClashHit[]>,
): Array<{ kind: YearClashKind; lessonIds: string[] }> {
  const seen = new Set<string>();
  const pairs: Array<{ kind: YearClashKind; lessonIds: string[] }> = [];
  for (const [lessonId, hits] of [...clashes.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const hit of hits) {
      const ids = hit.otherLessonId ? [lessonId, hit.otherLessonId].sort() : [lessonId];
      const key = `${hit.kind}:${ids.join(':')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ kind: hit.kind, lessonIds: ids });
    }
  }
  return pairs;
}
