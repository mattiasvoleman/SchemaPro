// Delade lektioner, as the browser reads them.
//
// A MIRROR OF src/common/lesson-shares.ts, not a second opinion on it. A
// timplanspost's teacherId is its huvudlärare, who takes every lesson no
// share takes; a share is "Bo: 1 × 60", lessons of one of the row's lengths
// another teacher takes. The Timplansposter dialog lays the row's lessons out
// and judges a share list here, so it says what the gateway will refuse
// before a save does, and the load report counts each teacher's own lessons
// as the gateway does.
//
// Both copies replay src/common/__fixtures__/lesson-shares-cases.json
// (generated from the gateway copy): lesson-shares.contract.spec.ts there,
// lesson-shares.contract.test.ts here. The body below is the gateway file's
// with this package's quotes; keep it that way, so a diff of the two shows
// only the header.

import { lengthPartsOf, lessonCountOf, weeklyMinutesOf, type LessonShape } from "./lesson-lengths";

/** At most this many lessons in one share: the row's @Max(40) less the huvudlärare's one. */
export const MAX_SHARE_LESSONS = 39;

/** One share as stored: `lessons` lessons of `minutes` each, taught by `teacherId`. */
export interface LessonShare {
  /** Null when the teacher's user was deleted: that many unstaffed lessons. */
  teacherId: string | null;
  lessons: number;
  minutes: number;
}

/** A row as every reader of its teachers hands it in. */
export interface SharedRow extends LessonShape {
  teacherId: string | null;
  coTeacherId?: string | null;
  /** Absent, null or empty: no share, the row it always was. */
  shares?: readonly LessonShare[] | null;
}

/** One teacher's own lessons of a row: the huvudlärare's, or a share's. */
export interface TeacherPart {
  teacherId: string | null;
  role: "LEAD" | "SHARE";
  /** Lessons a week this teacher has of the row. */
  lessons: number;
  /** Their minutes a week, Σ of their lessons' lengths. */
  minutes: number;
}

/** One lesson of the row and its teacher. */
export interface LessonTeacher {
  minutes: number;
  teacherId: string | null;
}

export type SharesProblem =
  | "NOT_INTEGER"
  | "OUT_OF_RANGE"
  | "TEACHER_TWICE"
  | "TEACHER_ON_POST"
  | "LENGTH_NOT_ON_POST"
  | "TOO_MANY_OF_LENGTH"
  | "LEAD_KEEPS_NONE";

const sharesOf = (row: SharedRow): readonly LessonShare[] => row.shares ?? [];

/** Null last, then by id: the one order every list here is in. */
const byTeacher = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
};

/** Whether the row's lessons are split between teachers at all. */
export function hasShares(row: SharedRow): boolean {
  return sharesOf(row).length > 0;
}

/**
 * Every teacher's own part of the row: the huvudlärare first — even when null,
 * which is the row's unstaffed lessons, as a row with no teacher has always
 * read — then each share's teacher once, their lengths summed, by id with the
 * deleted (null) last. A row with no share is one part: its teacher, all of
 * its lessons and minutes, exactly lessonCountOf and weeklyMinutesOf.
 */
export function teacherPartsOf(row: SharedRow): TeacherPart[] {
  const lead: TeacherPart = {
    teacherId: row.teacherId,
    role: "LEAD",
    lessons: lessonCountOf(row),
    minutes: weeklyMinutesOf(row),
  };
  const shares = sharesOf(row);
  if (shares.length === 0) return [lead];
  const byId = new Map<string | null, TeacherPart>();
  for (const share of shares) {
    const part = byId.get(share.teacherId) ?? {
      teacherId: share.teacherId,
      role: "SHARE" as const,
      lessons: 0,
      minutes: 0,
    };
    part.lessons += share.lessons;
    part.minutes += share.lessons * share.minutes;
    byId.set(share.teacherId, part);
    lead.lessons -= share.lessons;
    lead.minutes -= share.lessons * share.minutes;
  }
  return [lead, ...[...byId.values()].sort((a, b) => byTeacher(a.teacherId, b.teacherId))];
}

/**
 * The row's lessons longest first, each with its teacher: within a length the
 * huvudlärare's, then each share's by teacher (null last). The order of
 * lessonMinutesOf and of the engine's lesson_minutes(), so the k-th entry is
 * the payload's k-th lesson. A row with no share is every lesson its teacher's.
 */
export function lessonTeachersOf(row: SharedRow): LessonTeacher[] {
  const shares = [...sharesOf(row)].sort((a, b) => byTeacher(a.teacherId, b.teacherId));
  const lessons: LessonTeacher[] = [];
  for (const part of lengthPartsOf(row)) {
    const ofLength = shares.filter((share) => share.minutes === part.minutes);
    const shared = ofLength.reduce((sum, share) => sum + share.lessons, 0);
    for (let i = 0; i < part.count - shared; i += 1) {
      lessons.push({ minutes: part.minutes, teacherId: row.teacherId });
    }
    for (const share of ofLength) {
      for (let i = 0; i < share.lessons; i += 1) {
        lessons.push({ minutes: part.minutes, teacherId: share.teacherId });
      }
    }
  }
  return lessons;
}

/**
 * Everyone the row names as a teacher of some lesson: the huvudlärare, every
 * share's teacher, the medlärare — each once, nulls left out. The answer to
 * "does this person teach this post?", which a row with no share answers with
 * its two columns, as every such reader always did.
 */
export function teacherIdsOf(row: SharedRow): string[] {
  const ids = [row.teacherId, ...sharesOf(row).map((share) => share.teacherId), row.coTeacherId ?? null];
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

/**
 * Shares as a writer stores them: one entry per (teacher, length), lessons
 * summed, longest first and then by teacher with null last. The input's own
 * minutes are kept; a writer fills a uniform row's in before asking.
 */
export function canonicalShares(shares: readonly LessonShare[]): LessonShare[] {
  const merged = new Map<string, LessonShare>();
  for (const share of shares) {
    const key = `${share.teacherId ?? ""}:${share.minutes}`;
    const entry = merged.get(key);
    if (entry) entry.lessons += share.lessons;
    else merged.set(key, { teacherId: share.teacherId, lessons: share.lessons, minutes: share.minutes });
  }
  return [...merged.values()].sort((a, b) => b.minutes - a.minutes || byTeacher(a.teacherId, b.teacherId));
}

/**
 * Why these shares cannot be stored on this row, or null. First each share on
 * its own (whole numbers, 1..39 lessons), then the list (one teacher once per
 * length), then the four rules the trigger holds: no share is the row's own
 * teacher or medlärare, every length is the row's, no length is taken more
 * than the row has it, and the huvudlärare keeps a lesson.
 */
export function sharesProblem(row: SharedRow, shares: readonly LessonShare[]): SharesProblem | null {
  if (shares.length === 0) return null;
  if (shares.some((share) => !Number.isInteger(share.lessons) || !Number.isInteger(share.minutes))) {
    return "NOT_INTEGER";
  }
  if (shares.some((share) => share.lessons < 1 || share.lessons > MAX_SHARE_LESSONS)) return "OUT_OF_RANGE";
  const seen = new Set<string>();
  for (const share of shares) {
    if (share.teacherId === null) continue;
    const key = `${share.teacherId}:${share.minutes}`;
    if (seen.has(key)) return "TEACHER_TWICE";
    seen.add(key);
  }
  if (
    shares.some(
      (share) =>
        share.teacherId !== null &&
        (share.teacherId === row.teacherId || share.teacherId === (row.coTeacherId ?? null)),
    )
  ) {
    return "TEACHER_ON_POST";
  }
  const parts = lengthPartsOf(row);
  if (shares.some((share) => !parts.some((part) => part.minutes === share.minutes))) {
    return "LENGTH_NOT_ON_POST";
  }
  for (const part of parts) {
    const taken = shares
      .filter((share) => share.minutes === part.minutes)
      .reduce((sum, share) => sum + share.lessons, 0);
    if (taken > part.count) return "TOO_MANY_OF_LENGTH";
  }
  const taken = shares.reduce((sum, share) => sum + share.lessons, 0);
  if (taken > lessonCountOf(row) - 1) return "LEAD_KEEPS_NONE";
  return null;
}
