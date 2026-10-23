import type { LessonRecurrence } from '@prisma/client';
import { weeksCanOverlap } from '../calendar/lesson-recurrence';

/*
 * A block on another block's times (TeachingBlocks."sameTimesAsBlockId",
 * 20261128090000), as the generate payload is built.
 *
 * "Dela terminsvis i halvklass" makes two blocks of a class's slöjd: the
 * autumn's (7A:1 textilslöjd beside 7A:2 trä- och metallslöjd) and the
 * spring's (the swap), and names the autumn's on the spring's. The engine has
 * no weeks: sent both, it gave each its own times and held both all year, so
 * 7A had slöjd twice a week and one of the two stood empty each term.
 *
 * SO THE ENGINE IS SENT ONLY THE NAMED BLOCK — the leader — and each post of
 * the other — the follower — is written at the times its leader post IN THE
 * SAME SUBJECT got, in the follower's own weeks, with its own group and
 * teachers, in the leader lesson's room (mirrorLessons). The same subject,
 * because a subject is what asks for a room type (textilsalen) and usually
 * for a teacher: the halves swap, the room and the teacher stay.
 *
 * WHAT THE ENGINE MUST STILL HOLD, it is told through the leader's posts:
 *
 *  - The follower's GROUPS are the leader's (the halves), so a half is busy at
 *    those times in every week anyway, and nothing more is needed for them.
 *    A follower on other groups is refused (BLOCK_SAME_TIMES_DIFFER).
 *  - Its TEACHERS: one the leader block has is at those times already. One it
 *    has not — the spring's textilslöjd taught by somebody else — is sent as
 *    a teacher or co-teacher of a leader post with that place empty: every
 *    post of a block is at the block's times, so that is where they are held.
 *    More than the leader's posts have room for is refused
 *    (BLOCK_SAME_TIMES_TEACHERS); two of the follower's posts with one
 *    teacher are refused as the engine refuses a block's
 *    (BLOCK_MEMBERS_SHARE_TEACHER).
 *  - Its ROOM NEEDS, buffers and ämnesfördelning are folded into the leader
 *    post's by the proxy: the larger half, the longer buffer on each group, the
 *    stricter rule (see fetchAndAnonymize).
 *
 * THE TWO NEVER RUN IN THE SAME WEEK: the same times in a week both run would
 * put a half in two rooms. They have the same lessons, or one cannot be
 * written at the other's times. Both are BLOCK_SAME_TIMES_DIFFER, judged here
 * where the week is generated, as a block's teachers and pupils are: posts,
 * teachers and periods change after the blocks are written.
 */

/** A timplanspost as the plan reads it. */
export interface SameTimesRow {
  id: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  lessonLengths: readonly number[];
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
}

/** A block of the year with the block it takes the times of, or null. */
export interface SameTimesBlock {
  id: string;
  sameTimesAsBlockId: string | null;
}

/** A follower block and the block whose times it takes. */
export interface SameTimesLink {
  leaderBlockId: string;
  followerBlockId: string;
}

/** A follower post and the leader post whose times it is written at. */
export interface Mirror {
  leaderId: string;
  followerId: string;
}

/** How a sound link is sent: what the leader's posts carry for the follower's. */
export interface MirrorPlan {
  /** Every follower post with its leader post in the same subject. */
  mirrors: Mirror[];
  /** Leader post -> the follower post on the same group, whose buffers it keeps too. */
  sameGroup: Map<string, string>;
  /** Leader post -> the follower post in the same subject, whose rule it keeps too. */
  sameSubject: Map<string, string>;
  /**
   * Leader post -> the adults it is sent with: its own, and in an empty place
   * a follower's teacher the leader block does not have.
   */
  adults: Map<string, { teacherId: string | null; coTeacherId: string | null }>;
}

export type MirrorJudgement =
  | { ok: true; plan: MirrorPlan }
  | { ok: false; code: typeof BLOCK_SAME_TIMES_DIFFER | typeof BLOCK_SAME_TIMES_TEACHERS }
  | { ok: false; code: typeof BLOCK_MEMBERS_SHARE_TEACHER; requirementId: string; otherId: string };

/** The refusals' codes, which the engine's catalogue renders (messages.py). */
export const BLOCK_SAME_TIMES_DIFFER = 'BLOCK_SAME_TIMES_DIFFER';
export const BLOCK_SAME_TIMES_TEACHERS = 'BLOCK_SAME_TIMES_TEACHERS';
/** The engine's own, for two posts of one block with one teacher. */
export const BLOCK_MEMBERS_SHARE_TEACHER = 'BLOCK_MEMBERS_SHARE_TEACHER';

/**
 * The year's links: every block naming another block of the list. A block
 * naming one that is not in the list — a block no post of the year is in —
 * has nothing to take the times of and is placed on its own.
 */
export function sameTimesLinks(blocks: readonly SameTimesBlock[]): SameTimesLink[] {
  const known = new Set(blocks.map((block) => block.id));
  return blocks
    .filter((block) => block.sameTimesAsBlockId !== null && known.has(block.sameTimesAsBlockId))
    .map((block) => ({ leaderBlockId: block.sameTimesAsBlockId as string, followerBlockId: block.id }))
    .sort((a, b) => byId(a.followerBlockId, b.followerBlockId));
}

/**
 * Whether the follower's posts can be written at the leader's times, and how
 * the leader's posts are sent for them. `chained`: the leader is itself on a
 * third block's times, which no writer of the API makes and this does not
 * follow.
 */
export function planMirror(
  leaders: readonly SameTimesRow[],
  followers: readonly SameTimesRow[],
  chained = false,
): MirrorJudgement {
  const differ = { ok: false, code: BLOCK_SAME_TIMES_DIFFER } as const;
  if (chained || leaders.length === 0 || leaders.length !== followers.length) return differ;
  const lead = [...leaders].sort((a, b) => byId(a.id, b.id));
  const follow = [...followers].sort((a, b) => byId(a.id, b.id));

  // One post per subject on each side, and the same subjects.
  const leaderBySubject = new Map(lead.map((row) => [row.subjectId, row]));
  if (leaderBySubject.size !== lead.length || new Set(follow.map((row) => row.subjectId)).size !== follow.length) {
    return differ;
  }
  const pairs: { leader: SameTimesRow; follower: SameTimesRow }[] = [];
  for (const follower of follow) {
    const leader = leaderBySubject.get(follower.subjectId);
    if (!leader) return differ;
    pairs.push({ leader, follower });
  }

  // The same groups, the halves swapped between the subjects or not.
  const groups = (rows: readonly SameTimesRow[]) => rows.map((row) => row.studentGroupId).sort(byId).join(',');
  if (groups(lead) !== groups(follow)) return differ;
  const leaderByGroup = new Map(lead.map((row) => [row.studentGroupId, row]));

  // The same lessons, and never a week in common.
  for (const { leader, follower } of pairs) {
    if (!sameLessons(leader, follower)) return differ;
  }
  if (lead.some((leader) => follow.some((follower) => weeksCanOverlap(leader, follower)))) return differ;

  // The follower's teachers, each at one of its posts only: at the block's
  // times they would be in two rooms in the follower's weeks.
  for (const [index, first] of follow.entries()) {
    for (const second of follow.slice(index + 1)) {
      const theirs = new Set(adultsOf(second));
      if (adultsOf(first).some((id) => theirs.has(id))) {
        return { ok: false, code: BLOCK_MEMBERS_SHARE_TEACHER, requirementId: first.id, otherId: second.id };
      }
    }
  }

  // The follower's teachers the leader block does not have, each in an empty
  // place: first its own subject's leader post, then any.
  const adults = new Map(lead.map((row) => [row.id, { teacherId: row.teacherId, coTeacherId: row.coTeacherId }]));
  const present = new Set(lead.flatMap(adultsOf));
  const seat = (leaderId: string, teacherId: string): boolean => {
    const places = adults.get(leaderId)!;
    if (places.teacherId === null) places.teacherId = teacherId;
    else if (places.coTeacherId === null) places.coTeacherId = teacherId;
    else return false;
    return true;
  };
  for (const { leader, follower } of pairs) {
    for (const teacherId of adultsOf(follower)) {
      if (present.has(teacherId)) continue;
      present.add(teacherId);
      if (seat(leader.id, teacherId)) continue;
      if (!lead.some((other) => other.id !== leader.id && seat(other.id, teacherId))) {
        return { ok: false, code: BLOCK_SAME_TIMES_TEACHERS };
      }
    }
  }

  return {
    ok: true,
    plan: {
      mirrors: pairs.map(({ leader, follower }) => ({ leaderId: leader.id, followerId: follower.id })),
      sameGroup: new Map(follow.map((follower) => [leaderByGroup.get(follower.studentGroupId)!.id, follower.id])),
      sameSubject: new Map(pairs.map(({ leader, follower }) => [leader.id, follower.id])),
      adults,
    },
  };
}

/**
 * The engine's lessons with every mirrored post's beside them: each lesson
 * of a leader post again for each of its follower posts, at the same day,
 * clock and room. Lessons of other posts pass as they are.
 */
export function mirrorLessons<T extends { requirementId: string | null }>(
  lessons: readonly T[],
  mirrors: readonly Mirror[],
): T[] {
  if (mirrors.length === 0) return [...lessons];
  const followersOf = new Map<string, string[]>();
  for (const mirror of mirrors) {
    followersOf.set(mirror.leaderId, [...(followersOf.get(mirror.leaderId) ?? []), mirror.followerId]);
  }
  return [
    ...lessons,
    ...lessons.flatMap((lesson) =>
      lesson.requirementId === null
        ? []
        : (followersOf.get(lesson.requirementId) ?? []).map((followerId) => ({ ...lesson, requirementId: followerId })),
    ),
  ];
}

function sameLessons(a: SameTimesRow, b: SameTimesRow): boolean {
  return (
    a.lessonsPerWeek === b.lessonsPerWeek &&
    a.minutesPerLesson === b.minutesPerLesson &&
    a.lessonLengths.length === b.lessonLengths.length &&
    a.lessonLengths.every((minutes, index) => minutes === b.lessonLengths[index])
  );
}

function adultsOf(row: Pick<SameTimesRow, 'teacherId' | 'coTeacherId'>): string[] {
  return [row.teacherId, row.coTeacherId].filter((id): id is string => id !== null);
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
