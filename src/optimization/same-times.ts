import type { LessonRecurrence } from '@prisma/client';
import { weeksCanOverlap } from '../calendar/lesson-recurrence';
import { hasShares, lessonTeachersOf, teacherIdsOf, type LessonShare } from '../common/lesson-shares';

/*
 * A block on another block's times (TeachingBlocks."sameTimesAsBlockId",
 * 20261128090000), as the generate payload is built.
 *
 * "Dela terminsvis i halvklass" makes two blocks of a class's slöjd: the
 * autumn's (7A:1 textilslöjd beside 7A:2 trä- och metallslöjd) and the
 * spring's (the swap), and names the autumn's on the spring's. Sent both, the
 * engine gives each block times of its own: held all year before it knew
 * terms, so that 7A had slöjd twice a week and one of the two stood empty
 * each term, and each in its own term since (year-periods.ts) — two
 * timetables where the school asked for one. The link is how it says so.
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
 *    (A/B-veckor: "every week" because the leader posts are sent with a
 *    parity only when every post of the link has the same one —
 *    alternatingWeeksOf in the proxy. A half held by an odd post and sat by
 *    an even follower would otherwise be free in the even weeks.)
 *    One exception: ONE SUBJECT READ BY THE HALVES IN TURN. "Dela i halvklass"
 *    with hemkunskap makes a block of one post per period, 7A:1's in the
 *    first and 7A:2's in the second, so the follower is the other half. The
 *    leader post is then sent as sat by the whole class (its pupilGroupId is
 *    the class, `holdsClass`): the class pairs with both halves, so neither
 *    has anything else at those times, and 7A:2's hemkunskap is written there
 *    in its own weeks. Its class-space rules (7A:1's daily maximum, its rasts,
 *    a reservation on 7A:1) are still 7A:1's, as they are for every post of a
 *    half; the same rules of 7A:2 do not see the mirrored lesson, which the
 *    manual says (4.2). Any other follower on other groups is refused
 *    (BLOCK_SAME_TIMES_DIFFER).
 *  - Its TEACHERS: one the leader block has is at those times already. One it
 *    has not — the spring's textilslöjd taught by somebody else — is sent as
 *    a teacher or co-teacher of a leader post with that place empty: every
 *    post of a block is at the block's times, so that is where they are held.
 *    More than the leader's posts have room for is refused
 *    (BLOCK_SAME_TIMES_TEACHERS); two of the follower's posts with one
 *    teacher are refused as the engine refuses a block's
 *    (BLOCK_MEMBERS_SHARE_TEACHER). THE COST, STATED: a leader post is
 *    held in every week of its link — its own term and the follower's
 *    (year-periods.ts) — so such a teacher is held at those times in the
 *    autumn too, and Lärarens dag (the daily cap, deltid in days, a free-day
 *    wish) counts the lessons there. For a part-timer that can make the week
 *    harder to lay, or impossible; the manual says so (4.2).
 *  - Its ROOM NEEDS, buffers and ämnesfördelning are folded into the leader
 *    post's by the proxy: the larger half, the longer buffer on each group, the
 *    stricter rule (see fetchAndAnonymize).
 *
 * DELADE LEKTIONER (a post with shares: each lesson has its own teacher). A
 * leader post sends one teacher place and one co-teacher place for all its
 * lessons, and, when it is itself shared, a list of its lessons' teachers
 * (lessonTeacherIds) in which the co-teacher may not be. So the follower's
 * teacher of lesson k is held at lesson k's times only where the leader post
 * has the same teacher on a lesson of that length. A pair of posts either of
 * which is shared is therefore judged lesson by lesson (pairLessons):
 *
 *  1. THE SAME TEACHER ON THE SAME LESSON. Each follower lesson is paired
 *     with a lesson of its own in the leader post, of the same length and
 *     with the same teacher, and is written on that lesson's times with that
 *     teacher. Hemkunskap 7.1 HT and VT, both 1 x 90 with Anna and 1 x 40
 *     with Bo, is this case: nothing new is held, and the engine is sent the
 *     leader post as it would be sent alone.
 *  2. AT MOST ONE EXTRA TEACHER. The follower lessons that find no such
 *     partner are paired with the leader's remaining lessons of their length
 *     (still the same two lists, in order), and the teachers they need that
 *     nobody on the leader block has at every lesson are the extras. One is
 *     held, as a follower's teacher always was: in the leader post's
 *     co-teacher place, which is on every lesson of the post, and so at all
 *     its times all year (the cost stated above). The place must be empty.
 *     A shared leader post has no other place: its teacher place is its
 *     lessons' list.
 *  3. EVERYTHING ELSE IS REFUSED BY NAME (BLOCK_SAME_TIMES_SPLIT_LESSONS):
 *     more than one extra teacher, an extra whose place is taken, an extra
 *     who already leads one of the leader post's other lessons (the engine
 *     refuses a co-teacher who is in the list), and lessons that cannot be
 *     paired by length. Nothing is sent, rather than a teacher written on a
 *     time the engine did not hold them at.
 *
 * ONE PAIRING, TWO READERS. The pairing is made here, once, and travels in
 * Mirror.lessons: the teachers the leader is held with are the ones its
 * pairing needs, and mirrorLessons writes each leader lesson's copy with the
 * teacher the same pairing gives it. A pair of unshared posts has no list and
 * is written as it always was.
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
  /** Delade lektioner: the lessons other teachers take (src/common/lesson-shares.ts). Absent or empty: none. */
  shares?: readonly LessonShare[];
  /** Halvklasser: the class whose half the group is, or null for a class or a teaching group. */
  halfOfId?: string | null;
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

/**
 * One lesson of a leader post and the follower lesson written on it
 * (pairLessons): the leader's lesson k as the engine places it, and the
 * follower's lesson that takes its times.
 */
export interface MirroredLesson {
  minutes: number;
  /**
   * Who leads the leader's lesson, null for a lesson nobody leads; ABSENT when
   * the leader post shares nothing, whose lessons are all its teacher's and
   * come back from the engine without a teacher of their own.
   */
  leaderTeacherId?: string | null;
  /**
   * Who leads the follower's lesson, the same way: absent when the follower
   * post shares nothing, whose lessons are written with its row's teacher.
   */
  followerTeacherId?: string | null;
}

/** A follower post and the leader post whose times it is written at. */
export interface Mirror {
  leaderId: string;
  followerId: string;
  /**
   * Delade lektioner: the pairing of the two posts' lessons, one entry per
   * leader lesson, longest first. Present exactly when either post shares its
   * lessons; a pair of unshared posts is the plain mirror it always was.
   */
  lessons?: MirroredLesson[];
}

/** How a sound link is sent: what the leader's posts carry for the follower's. */
export interface MirrorPlan {
  /** Every follower post with its leader post in the same subject. */
  mirrors: Mirror[];
  /**
   * Leader post -> the follower post on the same group (or on the half the
   * leader holds as its class), whose buffers it keeps too.
   */
  sameGroup: Map<string, string>;
  /** Leader post -> the follower post in the same subject, whose rule it keeps too. */
  sameSubject: Map<string, string>;
  /**
   * Leader post -> the adults it is sent with: its own, and in an empty place
   * a follower's teacher the leader block does not have.
   */
  adults: Map<string, { teacherId: string | null; coTeacherId: string | null }>;
  /**
   * Leader post -> the class it is sent as sat by (pupilGroupId), when its
   * follower is the other half of that class (one subject read in turn; see
   * the header). Empty for every other link.
   */
  holdsClass: Map<string, string>;
}

export type MirrorJudgement =
  | { ok: true; plan: MirrorPlan }
  | { ok: false; code: typeof BLOCK_SAME_TIMES_DIFFER | typeof BLOCK_SAME_TIMES_TEACHERS }
  | { ok: false; code: typeof BLOCK_MEMBERS_SHARE_TEACHER; requirementId: string; otherId: string }
  | { ok: false; code: typeof BLOCK_SAME_TIMES_SPLIT_LESSONS; requirementId: string };

/** The refusals' codes, which the engine's catalogue renders (messages.py). */
export const BLOCK_SAME_TIMES_DIFFER = 'BLOCK_SAME_TIMES_DIFFER';
export const BLOCK_SAME_TIMES_TEACHERS = 'BLOCK_SAME_TIMES_TEACHERS';
/**
 * Two members of one parallel block whose lessons are both split between
 * teachers (delade lektioner): refused by the proxy, see fetchAndAnonymize.
 */
export const BLOCK_MEMBERS_SPLIT = 'BLOCK_MEMBERS_SPLIT';
/** A post of either block whose lessons are split between teachers (see the header). */
export const BLOCK_SAME_TIMES_SPLIT_LESSONS = 'BLOCK_SAME_TIMES_SPLIT_LESSONS';
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

  // The same groups, the halves swapped between the subjects or not — or one
  // post on each side, on the two halves of one class (see the header).
  const groups = (rows: readonly SameTimesRow[]) => rows.map((row) => row.studentGroupId).sort(byId).join(',');
  const holdsClass = new Map<string, string>();
  if (groups(lead) !== groups(follow)) {
    const [leader] = lead;
    const [follower] = follow;
    const theClass = lead.length === 1 ? (leader!.halfOfId ?? null) : null;
    if (theClass === null || (follower!.halfOfId ?? null) !== theClass) return differ;
    holdsClass.set(leader!.id, theClass);
  }
  // The leader post a follower's group is held by: the one on its group, or
  // the one sent as its class.
  const leaderByGroup = new Map(lead.map((row) => [row.studentGroupId, row]));
  const holderOf = (follower: SameTimesRow) =>
    leaderByGroup.get(follower.studentGroupId) ?? lead.find((leader) => holdsClass.has(leader.id))!;

  // Never a week in common, and the same lessons. A post with shares whose
  // lessons cannot be paired with the leader's by length is the third case of
  // the header, said by name: the shares are what the school can change.
  if (lead.some((leader) => follow.some((follower) => weeksCanOverlap(leader, follower)))) return differ;
  for (const { leader, follower } of pairs) {
    if (sameLessons(leader, follower)) continue;
    if (hasShares(leader) || hasShares(follower)) {
      return { ok: false, code: BLOCK_SAME_TIMES_SPLIT_LESSONS, requirementId: follower.id };
    }
    return differ;
  }

  // The follower's teachers, each at one of its posts only: at the block's
  // times they would be in two rooms in the follower's weeks. A teacher of a
  // share is a teacher of the post, as the engine reads a block's members.
  for (const [index, first] of follow.entries()) {
    for (const second of follow.slice(index + 1)) {
      const theirs = new Set(teacherIdsOf(second));
      if (teacherIdsOf(first).some((id) => theirs.has(id))) {
        return { ok: false, code: BLOCK_MEMBERS_SHARE_TEACHER, requirementId: first.id, otherId: second.id };
      }
    }
  }

  // The follower's teachers the leader block does not have, each in an empty
  // place: first its own subject's leader post, then any. A shared leader
  // post has only its co-teacher place, which is on every lesson: its teacher
  // place is its lessons' list (the header).
  const adults = new Map(lead.map((row) => [row.id, { teacherId: row.teacherId, coTeacherId: row.coTeacherId }]));
  // Held at every lesson of the leader block: an unshared post's teachers, a
  // shared post's co-teacher. A shared post's leads are on their own lessons.
  const present = new Set(lead.flatMap(everywhere));
  const onTheBlock = new Set(lead.flatMap(teacherIdsOf));
  const leaderOf = (id: string) => lead.find((row) => row.id === id)!;
  const seat = (leaderId: string, teacherId: string): boolean => {
    const places = adults.get(leaderId)!;
    if (places.teacherId === null && !hasShares(leaderOf(leaderId))) places.teacherId = teacherId;
    else if (places.coTeacherId === null) places.coTeacherId = teacherId;
    else return false;
    return true;
  };
  const split = (follower: SameTimesRow) =>
    ({ ok: false, code: BLOCK_SAME_TIMES_SPLIT_LESSONS, requirementId: follower.id }) as const;

  // Posts with shares first, so that the one place they may use is theirs.
  const mirrorLessonsOf = new Map<string, MirroredLesson[]>();
  for (const { leader, follower } of pairs) {
    if (!hasShares(leader) && !hasShares(follower)) continue;
    const paired = pairLessons(leader, follower);
    mirrorLessonsOf.set(follower.id, paired.map((lesson) => mirroredLessonOf(lesson, leader, follower)));
    // Who the follower's lessons need held at every lesson of the leader's
    // block: a teacher who leads the very leader lesson the follower's lesson
    // is written on is held there already; the follower's co-teacher is on
    // every lesson of it.
    const needed = new Set<string>();
    for (const lesson of paired) {
      if (lesson.follower !== null && lesson.follower !== lesson.leader && !present.has(lesson.follower)) {
        needed.add(lesson.follower);
      }
    }
    if (follower.coTeacherId !== null && !present.has(follower.coTeacherId)) needed.add(follower.coTeacherId);
    if (needed.size === 0) continue;
    const [extra] = needed;
    if (needed.size > 1 || onTheBlock.has(extra!) || !seat(leader.id, extra!)) return split(follower);
  }
  for (const { leader, follower } of pairs) {
    if (hasShares(leader) || hasShares(follower)) continue;
    for (const teacherId of adultsOf(follower)) {
      if (present.has(teacherId)) continue;
      // A teacher who leads a lesson of a shared post in the leader block, and
      // so is on it at that slot only: seated on another post of the block, the
      // teacher would be on two members of it, which the engine refuses in
      // terms that name the leader's posts. Said here, by the follower. With no
      // shared post in the block every teacher on it is present, so this never
      // reaches a link without delade lektioner.
      if (onTheBlock.has(teacherId)) return split(follower);
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
      mirrors: pairs.map(({ leader, follower }) => ({
        leaderId: leader.id,
        followerId: follower.id,
        ...(mirrorLessonsOf.has(follower.id) ? { lessons: mirrorLessonsOf.get(follower.id)! } : {}),
      })),
      sameGroup: new Map(follow.map((follower) => [holderOf(follower).id, follower.id])),
      sameSubject: new Map(pairs.map(({ leader, follower }) => [leader.id, follower.id])),
      adults,
      holdsClass,
    },
  };
}

/** One lesson of the leader post with the follower lesson written on it, both with their leads. */
interface PairedLesson {
  minutes: number;
  leader: string | null;
  follower: string | null;
}

/**
 * The two posts' lessons paired, one per leader lesson, longest first and in
 * lessonTeachersOf's order within a length. A pure function of the two rows,
 * so the leader is held and the follower written by the same pairing.
 *
 *  1. Each follower lesson, in order, takes the first leader lesson not yet
 *     taken of its length AND with its teacher: the same teacher on the same
 *     lesson. These pairings are as many as there are, whatever order they
 *     are taken in, since a lesson of a length and a teacher is only ever
 *     paired with one of the same.
 *  2. The follower lessons left take, in order, the first leader lesson left
 *     of their length. sameLessons has said the lengths are the same lists,
 *     so each finds one.
 */
export function pairLessons(
  leader: Pick<SameTimesRow, 'teacherId' | 'coTeacherId' | 'lessonsPerWeek' | 'minutesPerLesson' | 'lessonLengths' | 'shares'>,
  follower: Pick<SameTimesRow, 'teacherId' | 'coTeacherId' | 'lessonsPerWeek' | 'minutesPerLesson' | 'lessonLengths' | 'shares'>,
): PairedLesson[] {
  const mine = lessonTeachersOf(leader);
  const theirs = lessonTeachersOf(follower);
  const partnerOf: number[] = theirs.map(() => -1);
  const taken = mine.map(() => false);
  const take = (index: number, match: (lesson: (typeof mine)[number]) => boolean) => {
    const at = mine.findIndex((lesson, i) => !taken[i] && match(lesson));
    if (at < 0) return;
    taken[at] = true;
    partnerOf[index] = at;
  };
  theirs.forEach((lesson, index) =>
    take(index, (other) => other.minutes === lesson.minutes && other.teacherId === lesson.teacherId),
  );
  theirs.forEach((lesson, index) => {
    if (partnerOf[index] === -1) take(index, (other) => other.minutes === lesson.minutes);
  });
  return mine.map((lesson, at) => {
    const index = partnerOf.indexOf(at);
    return { minutes: lesson.minutes, leader: lesson.teacherId, follower: index === -1 ? null : theirs[index]!.teacherId };
  });
}

/** A pairing entry as Mirror carries it: a lead only for a side whose lessons have leads of their own. */
function mirroredLessonOf(lesson: PairedLesson, leader: SameTimesRow, follower: SameTimesRow): MirroredLesson {
  return {
    minutes: lesson.minutes,
    ...(hasShares(leader) ? { leaderTeacherId: lesson.leader } : {}),
    ...(hasShares(follower) ? { followerTeacherId: lesson.follower } : {}),
  };
}

/**
 * The engine's lessons with every mirrored post's beside them: each lesson
 * of a leader post again for each of its follower posts, at the same day,
 * clock and room. Lessons of other posts pass as they are.
 *
 * Delade lektioner: a mirror with a pairing (Mirror.lessons) writes each
 * leader lesson's copy with the teacher the pairing gives it — the follower's
 * lead of that lesson — and takes the leader's teacher off a copy whose
 * follower shares nothing, since its lessons are its row's. The leader's
 * lessons of one length and lead are interchangeable, so they take the
 * pairing's entries in day and clock order, whatever order the engine
 * answered in. A leader lesson the pairing has no entry for (the engine
 * placed one the request did not ask for) gets no copy, and the follower's
 * demand then fails as an answer to another request.
 */
export function mirrorLessons<
  T extends {
    requirementId: string | null;
    dayOfWeek?: number;
    startTime?: string;
    endTime?: string;
    roomId?: string | null;
    teacherId?: string | null;
  },
>(lessons: readonly T[], mirrors: readonly Mirror[]): T[] {
  if (mirrors.length === 0) return [...lessons];
  const mirrorsOf = new Map<string, Mirror[]>();
  for (const mirror of mirrors) {
    mirrorsOf.set(mirror.leaderId, [...(mirrorsOf.get(mirror.leaderId) ?? []), mirror]);
  }
  // Each leader lesson's pairing entry, per mirror that has one.
  const paired = new Map<Mirror, Map<number, MirroredLesson>>();
  for (const mirror of mirrors) {
    if (!mirror.lessons) continue;
    const pool = [...mirror.lessons];
    // The length tells lessons apart only where the post has more than one;
    // a uniform post's lengths were never read back from the answer, and the
    // engine's own count is what the demand check holds it to.
    const byLength = new Set(pool.map((entry) => entry.minutes)).size > 1;
    const assigned = new Map<number, MirroredLesson>();
    const own = lessons
      .map((lesson, index) => ({ lesson, index }))
      .filter(({ lesson }) => lesson.requirementId === mirror.leaderId)
      .sort((a, b) => byLessonPlace(a.lesson, b.lesson) || a.index - b.index);
    for (const { lesson, index } of own) {
      const minutes = minutesBetween(lesson.startTime, lesson.endTime);
      const at = pool.findIndex(
        (entry) =>
          (!byLength || entry.minutes === minutes) &&
          (entry.leaderTeacherId === undefined
            ? lesson.teacherId === undefined
            : lesson.teacherId !== undefined && entry.leaderTeacherId === lesson.teacherId),
      );
      if (at < 0) continue;
      assigned.set(index, pool.splice(at, 1)[0]!);
    }
    paired.set(mirror, assigned);
  }
  return [
    ...lessons,
    ...lessons.flatMap((lesson, index) =>
      lesson.requirementId === null
        ? []
        : (mirrorsOf.get(lesson.requirementId) ?? []).flatMap((mirror): T[] => {
            if (!mirror.lessons) return [{ ...lesson, requirementId: mirror.followerId }];
            const entry = paired.get(mirror)?.get(index);
            if (!entry) return [];
            const { teacherId: _leads, ...rest } = lesson;
            return [
              {
                ...rest,
                requirementId: mirror.followerId,
                ...(entry.followerTeacherId !== undefined ? { teacherId: entry.followerTeacherId } : {}),
              } as T,
            ];
          }),
    ),
  ];
}

/** Day, then clock, then room: a place in the week that does not depend on the order lessons came in. */
function byLessonPlace(
  a: { dayOfWeek?: number; startTime?: string; endTime?: string; roomId?: string | null },
  b: typeof a,
): number {
  return (
    (a.dayOfWeek ?? 0) - (b.dayOfWeek ?? 0) ||
    byId(a.startTime ?? '', b.startTime ?? '') ||
    byId(a.endTime ?? '', b.endTime ?? '') ||
    byId(a.roomId ?? '', b.roomId ?? '')
  );
}

/** A lesson's length from its HH:MM[:SS] clocks; NaN when a clock is missing, which no pairing entry equals. */
function minutesBetween(start: string | undefined, end: string | undefined): number {
  const minutes = (clock: string | undefined) => {
    const match = /^(\d{2}):(\d{2})/.exec(clock ?? '');
    return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
  };
  return minutes(end) - minutes(start);
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

/**
 * Who is at every lesson of a leader post: an unshared post's teachers, a
 * shared post's co-teacher alone — its leads are each on their own lessons.
 */
function everywhere(row: SameTimesRow): string[] {
  return hasShares(row) ? adultsOf({ teacherId: null, coTeacherId: row.coTeacherId }) : adultsOf(row);
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
