import type { LessonRecurrence } from '@prisma/client';
import type { LessonShare } from '../common/lesson-shares';
import type { BlockPlacementsRule } from '../common/utils/prisma-errors';
import { blockFitOf, type PlacementBlockMember } from '../requirement-placements/block-placement-fit';
import { placedLessonsOf, placedTaughtOf } from '../requirement-placements/placement-fit';
import type { TaughtLesson } from './locked-coverage';
import type { PlacementVerdict } from '../requirement-placements/placement-judge';
import type {
  AiEngineConflictAnalysis,
  AiEngineConflictDetail,
  AnonymousPinnedLesson,
} from './interfaces/ai-engine-payload.interface';

/*
 * FÖRLAGDA POSTER IN GENERERA: a förläggning as the lock it is to the week.
 *
 * A förläggning (TeachingRequirementPlacement) is one of a timplanspost's
 * lessons the school placed before Generera. To the engine it is what a lesson
 * locked in the grundschema has always been, so the fetch reads each as one:
 * a row of the shape the preserved masters are read in, beside them, and every
 * reader of those — the fixed lessons, the groups at school, the pupils'
 * cohorts, the shared rooms' seats, the post's locked days, a teacher's
 * weekdays — reads it with no second path. Two things differ, and they are
 * here:
 *
 *  1. WHAT IT TAKES OFF THE POST. A preserved lesson cancels a lesson of its
 *     post only when it runs the post's weeks (lockCoversDemand); a
 *     förläggning of odd weeks on an every-week post cancels one TOGETHER with
 *     its even partner (placedLessonsOf, the pair). So a placed row is never
 *     read as a covering lock, and the post loses `placedMinutesOf` instead,
 *     after its locks (withoutPlaced, the order placementsFitBesideLocks
 *     judges in).
 *  2. WHERE IT ENDS. Not a preserved row: a placed lesson is written by the
 *     run, locked and marked as Generera's own (MasterLesson.fromPlacement),
 *     so the next run writes it again from the förläggning as it then stands.
 *     It is kept apart from `preservedRows`, which the candidate basis and an
 *     apply compare with the preserved masters in the database, and it is
 *     written by writeRegeneration beside the engine's lessons.
 *
 * A FÖRLÄGGNING WITH NO ROOM (20270213090000) IS NOT A LOCK. A lock has to name
 * its room, and no proof of an impossible week can name a lock. A förläggning
 * that leaves the room to the engine is sent as a PINNED LESSON on its post
 * (AnonymousRequirement.pinnedLessons, optimization-engine/app/solver/pins.py):
 * the post keeps the lesson in its demand, the engine holds it at that weekday
 * and start in a room it chooses, and holds it to every rule a lesson it places
 * is held to (the school's rules: a lock is a fact, a pin is not — DEPLOYMENT.md
 * 21.3). So such a row is no preserved lesson: it is no fixed lesson, it takes
 * nothing off the post, it tells no weekday to the post's `lockedDays` or the
 * teacher's `lockedWeekdays` (the engine would count the lesson twice), and
 * `placements` does not name it. The run writes the lesson the answer holds
 * for it, with the room the engine chose, locked and marked the same
 * (writtenFromPins). A row WITH a room is the lock it was, byte for byte.
 *
 * A BLOCK'S FÖRLÄGGNING IS A PINNED LESSON OF EVERY MEMBER, ROOM OR NO ROOM (20270218090000). One lesson of a
 * parallel block (TeachingBlockPlacement) is read as one row per member (blockPlacedLessonRowsOf), marked
 * `blockPlacementId`, and it is a pinned lesson even when the member chose a room: a lock inside a block makes the
 * block partly locked, which Generera refuses (BLOCK_PARTLY_LOCKED, parallel-blocks.ts), and a pin with a room does
 * the same job. So the marker, and not the room, is what tells a pin from a lock for these rows, and lockedRowsOf and
 * pinnedRowsOf are the ONLY place that says so: everything that reads "the förläggningar as locks" (the fixed lessons,
 * what the post is asked for, its locked days, the teacher's weekdays, `placements`, the kept timetable and the
 * coverage base) reads lockedRowsOf, and a block row is in none of them. The engine holds place k of a block at the same
 * day and start for every member or for none (PLACED_LESSONS_OF_BLOCK_DIFFER), which the rows' order gives: for each
 * member the block's lessons in the order (day, start, id of the lesson), so each takes the same place k in its post's
 * lessons, which are the same for every member (TB409). A block row has no row of its own in the database, so its id is
 * derived and the staleness key is built from the block's rows themselves (blockPlacementsKeyOf).
 *
 * DELADE LEKTIONER (20270208090000). On a post that shares its lessons a
 * förläggning names its own teacher, and the lock is THAT teacher's: the
 * fixed lesson the engine plans around, the judge's clash, the lesson
 * written. It is taken off that teacher's part of the post (placedTaughtOf,
 * withoutPlacedShared), never another's. The post's medlärare is in the room
 * for every lesson, a placed one too, as before.
 */

/** A förläggning as the fetch reads it. */
export interface PlacementRead {
  id: string;
  requirementId: string;
  dayOfWeek: number;
  /** TIME(0), midnight UTC. */
  startTime: Date;
  minutes: number;
  /** Null: the school left the room to the engine (a pinned lesson; 20270213090000). */
  roomId: string | null;
  recurrence: LessonRecurrence;
  /** As stored: the lesson's teacher on a post that shares its lessons, null on one that shares nothing. */
  teacherId: string | null;
}

/** The post's fields a placed lesson takes: who sits it, who teaches it, its window. */
export interface PlacedPost {
  id: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
  /** Delade lektioner: present and not empty on a post that shares its lessons. */
  shares?: readonly LessonShare[] | null;
}

/**
 * A förläggning as a lock: the preserved masters' shape, so the fetch reads it
 * where it reads them. `id` is the förläggning's own (a placed lesson has no
 * master until the run writes it); no extra class and no named pupil, since
 * the lesson is the post's.
 */
export interface PlacedLessonRow {
  id: string;
  /** The förläggning's post. */
  requirementId: string;
  subjectId: string;
  studentGroupId: string;
  /** Who teaches it: the förläggning's own teacher on a shared post, else the post's. */
  teacherId: string | null;
  coTeacherId: string | null;
  /**
   * The room, null for a pinned lesson: the engine chooses it, and the row is then no preserved lesson (the file's
   * first paragraphs). Stated by lockedRowsOf and pinnedRowsOf, the only places that tell the two apart.
   */
  roomId: string | null;
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
  minutes: number;
  extraGroups: { studentGroupId: string }[];
  participants: { studentId: string }[];
  /**
   * Delade lektioner: the post shares its lessons, so `teacherId` is the
   * förläggning's own and the write keeps it; otherwise the write takes the
   * post's teacher as it reads it then, as it always did.
   */
  ownTeacher: boolean;
  /** The förläggning's own column, as stored (null on a post that shares nothing): what the staleness key compares. */
  placementTeacherId: string | null;
  /**
   * Set on a member's lesson of a block's förläggning (blockPlacementRowsOf): the id of the lesson of the block. Such a row is
   * a pinned lesson whether or not it has a room (lockedRowsOf, pinnedRowsOf), and it has no row of its own in the database.
   */
  blockPlacementId?: string;
  /** The block, on a block row. */
  blockId?: string;
  /** The rule the block's lessons break (block-placement-fit.ts), or null or absent when they fit: asked by the pre-flight. */
  blockFit?: BlockPlacementsRule | null;
}

/**
 * The förläggningar of the year's posts as locks, in a stable order (post, day,
 * clock, id) so two reads of one school send the same payload in the same
 * order. A row whose post is not among `posts` is left out: the posts are the
 * year's (the key says so), and one missing is a post the fetch did not read.
 */
export function placedLessonRowsOf(
  placements: readonly PlacementRead[],
  posts: ReadonlyMap<string, PlacedPost>,
): PlacedLessonRow[] {
  return placements
    .flatMap((row): PlacedLessonRow[] => {
      const post = posts.get(row.requirementId);
      if (!post) return [];
      const ownTeacher = (post.shares ?? []).length > 0;
      return [
        {
          id: row.id,
          requirementId: row.requirementId,
          subjectId: post.subjectId,
          studentGroupId: post.studentGroupId,
          teacherId: ownTeacher ? row.teacherId : post.teacherId,
          coTeacherId: post.coTeacherId,
          roomId: row.roomId,
          dayOfWeek: row.dayOfWeek,
          startTime: row.startTime,
          endTime: new Date(row.startTime.getTime() + row.minutes * 60_000),
          recurrence: row.recurrence,
          startDate: post.startDate,
          endDate: post.endDate,
          minutes: row.minutes,
          extraGroups: [],
          participants: [],
          ownTeacher,
          placementTeacherId: row.teacherId,
        },
      ];
    })
    .sort(
      (a, b) =>
        compare(a.requirementId, b.requirementId) ||
        a.dayOfWeek - b.dayOfWeek ||
        a.startTime.getTime() - b.startTime.getTime() ||
        compare(a.id, b.id),
    );
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A row that names a room, which is sent as the lock it has always been. */
export type LockedPlacedRow = PlacedLessonRow & { roomId: string };

/** A member's lesson of a block's förläggning: always a pinned lesson, with a room or not. */
const isBlockRow = (row: PlacedLessonRow): boolean => row.blockPlacementId !== undefined;

/** The förläggningar that name a room and are no block's lesson: locks, and everything the fetch reads of a lock reads them. */
export function lockedRowsOf(rows: readonly PlacedLessonRow[]): LockedPlacedRow[] {
  return rows.filter((row): row is LockedPlacedRow => row.roomId !== null && !isBlockRow(row));
}

/** The förläggningar that are pinned lessons of their posts: those that leave the room to the engine, and every block's lesson. */
export function pinnedRowsOf(rows: readonly PlacedLessonRow[]): PlacedLessonRow[] {
  return rows.filter((row) => row.roomId === null || isBlockRow(row));
}

/** A block's förläggning as the fetch reads it. */
export interface BlockPlacementRead {
  id: string;
  blockId: string;
  dayOfWeek: number;
  /** TIME(0), midnight UTC. */
  startTime: Date;
  minutes: number;
  recurrence: LessonRecurrence;
  /** The block's link to the block whose times it takes (a follower is not placed itself). */
  block: { sameTimesAsBlockId: string | null };
  /** The rooms the members chose for this lesson; a member not named has its room chosen by the engine. */
  rooms: readonly { requirementId: string; roomId: string }[];
}

/** A member of a block as the fetch reads it: the post's own fields and its lessons. */
export type BlockMemberPlaced = PlacedPost & PlacementBlockMember & { blockId: string | null };

/**
 * The block's förläggningar as one pinned lesson of every member: a row per lesson and member, marked
 * `blockPlacementId` (the file's paragraph on blocks). In the stable order (day, start, id of the lesson) and, for a lesson,
 * the members in id order, so that grouped by post each member's rows come in the same order and take the same place k
 * in the post's lessons. A block with no member sends nothing. A block whose lessons do not fit it (blockFitOf: a
 * membership change left them wrong) carries the rule on its rows, which the pre-flight refuses by name.
 */
export function blockPlacedLessonRowsOf(
  reads: readonly BlockPlacementRead[],
  members: readonly BlockMemberPlaced[],
): PlacedLessonRow[] {
  const byBlock = new Map<string, BlockMemberPlaced[]>();
  for (const member of members) {
    if (member.blockId === null) continue;
    const list = byBlock.get(member.blockId);
    if (list) list.push(member);
    else byBlock.set(member.blockId, [member]);
  }
  const misfit = new Map<string, BlockPlacementsRule | null>();
  for (const [blockId, list] of byBlock) {
    const own = reads.filter((read) => read.blockId === blockId);
    const sameTimesAsBlockId = own[0]?.block.sameTimesAsBlockId ?? null;
    misfit.set(
      blockId,
      blockFitOf(
        { id: blockId, sameTimesAsBlockId, members: list },
        // The rooms of members only: a room row for a post that has left the block is no member's and is not read (the migration's
        // preamble), so it is not a reason to refuse the run either.
        own.map((read) => ({
          minutes: read.minutes,
          recurrence: read.recurrence,
          rooms: read.rooms.filter((room) => list.some((member) => member.id === room.requirementId)),
        })),
      )?.reason ?? null,
    );
  }
  return [...reads]
    .sort(
      (a, b) =>
        a.dayOfWeek - b.dayOfWeek || a.startTime.getTime() - b.startTime.getTime() || compare(a.id, b.id),
    )
    .flatMap((read) =>
      [...(byBlock.get(read.blockId) ?? [])]
        .sort((a, b) => compare(a.id, b.id))
        .map(
          (post): PlacedLessonRow => ({
            id: `${read.id}:${post.id}`,
            requirementId: post.id,
            subjectId: post.subjectId,
            studentGroupId: post.studentGroupId,
            teacherId: post.teacherId,
            coTeacherId: post.coTeacherId,
            roomId: read.rooms.find((room) => room.requirementId === post.id)?.roomId ?? null,
            dayOfWeek: read.dayOfWeek,
            startTime: read.startTime,
            endTime: new Date(read.startTime.getTime() + read.minutes * 60_000),
            recurrence: read.recurrence,
            startDate: post.startDate,
            endDate: post.endDate,
            minutes: read.minutes,
            extraGroups: [],
            participants: [],
            ownTeacher: false,
            placementTeacherId: null,
            blockPlacementId: read.id,
            blockId: read.blockId,
            blockFit: misfit.get(read.blockId) ?? null,
          }),
        ),
    );
}

/**
 * The block's förläggningar as one comparable string, by what a write writes from them: their own ids (which a save
 * replaces), where and how long, the weeks and the rooms the members chose. Built from the rows themselves, never from
 * the members' derived rows, whose ids are not in the database. Generera reads them again under the year's lock and
 * refuses a write (GENERATE_STALE) when they moved while the solver ran.
 */
export function blockPlacementsKeyOf(reads: readonly Omit<BlockPlacementRead, 'block'>[]): string {
  return reads
    .map((read) =>
      [
        read.id,
        read.blockId,
        read.dayOfWeek,
        read.startTime.toISOString(),
        read.minutes,
        read.recurrence,
        ...read.rooms.map((room) => `${room.requirementId}=${room.roomId}`).sort(),
      ].join('|'),
    )
    .sort()
    .join('\n');
}

/** Each post's lessons its förläggningar place, one length each (placedLessonsOf). */
export function placedMinutesOf(
  rows: readonly PlacedLessonRow[],
  posts: ReadonlyMap<string, PlacedPost>,
): Map<string, number[]> {
  const byPost = new Map<string, PlacedLessonRow[]>();
  for (const row of rows) {
    const list = byPost.get(row.requirementId);
    if (list) list.push(row);
    else byPost.set(row.requirementId, [row]);
  }
  const placed = new Map<string, number[]>();
  for (const [postId, list] of byPost) {
    const post = posts.get(postId);
    if (post) placed.set(postId, placedLessonsOf(post, list));
  }
  return placed;
}

/**
 * Delade lektioner: each shared post's lessons its förläggningar place, each
 * with its teacher (placedTaughtOf). Only posts that share their lessons.
 */
export function placedTaughtByPost(
  rows: readonly PlacedLessonRow[],
  posts: ReadonlyMap<string, PlacedPost>,
): Map<string, TaughtLesson[]> {
  const byPost = new Map<string, PlacedLessonRow[]>();
  for (const row of rows) {
    if (!row.ownTeacher) continue;
    const list = byPost.get(row.requirementId);
    if (list) list.push(row);
    else byPost.set(row.requirementId, [row]);
  }
  const placed = new Map<string, TaughtLesson[]>();
  for (const [postId, list] of byPost) {
    const post = posts.get(postId);
    if (post) placed.set(postId, placedTaughtOf(post, list));
  }
  return placed;
}

/**
 * withoutPlaced on a shared post: the lessons left once its förläggningar are
 * taken off, each the exact length AND teacher it places, in the post's order
 * (the engine's lessonTeacherIds). A placed lesson with none of its own left
 * takes nothing (the judge refused it by name before, OVER_DEMAND): Bo's
 * förläggning never takes Anna's lesson.
 */
export function withoutPlacedShared(remaining: readonly TaughtLesson[], placed: readonly TaughtLesson[]): TaughtLesson[] {
  const left = [...remaining];
  for (const lesson of placed) {
    const at = left.findIndex((one) => one.minutes === lesson.minutes && one.teacherId === lesson.teacherId);
    if (at >= 0) left.splice(at, 1);
  }
  return left;
}

/**
 * The post's lessons left once its förläggningar are taken off, each the exact
 * length it places. A length with no lesson left takes nothing: the judge has
 * refused that förläggning by name before (OVER_DEMAND), so this is never
 * reached with one, and taking the nearest instead would answer a question the
 * school did not ask.
 */
export function withoutPlaced(remaining: readonly number[], placed: readonly number[]): number[] {
  const left = [...remaining];
  for (const minutes of placed) {
    const at = left.indexOf(minutes);
    if (at >= 0) left.splice(at, 1);
  }
  return left;
}

/** The weekday's clock as HH:MM. */
const clockOf = (time: Date): string => time.toISOString().slice(11, 16);

/** The clock the payload carries, HH:MM:SS. */
const payloadClockOf = (time: Date): string => time.toISOString().slice(11, 19);

/**
 * PINNED LESSONS: where the engine is told to hold lessons of one post
 * (AnonymousRequirement.pinnedLessons). `lessons` are the lessons the post's
 * entry SENDS, in the order the entry sends them — longest first, and within a
 * length the order lessonTeacherIds has — which is the engine's own order
 * (lesson_minutes(), then lessonTeacherIds[k]), because a place in the list is
 * a lesson of the entry and nothing else says which. `rows` are the post's
 * pinned förläggningar (pinnedRowsOf), in the stable order the fetch reads
 * them.
 *
 * Each row takes the first place still free whose lesson is its length, and on
 * a post that shares its lessons its teacher's: the lesson the school pinned
 * is the one that teacher teaches, as a förläggning's own teacher is the lock's
 * (placedTaughtOf). `endTime` is the start and the length of THAT lesson, the
 * check the engine makes of the gateway's places (it answers 422 to one that
 * does not hold). A row that finds no place is returned in `unplaced` and
 * pins nothing: the judge has refused it by name before (OVER_DEMAND, the post
 * has no lesson of that length left), so this is never reached with one, and
 * putting it on another length's place would pin a lesson the school did not.
 *
 * `places` is undefined when nothing is pinned: the key is sent only on a post
 * with a pinned lesson, so every other entry is byte for byte what it was, and
 * the engine refuses a list with none in it.
 */
export function pinnedPlacesOf(
  lessons: readonly TaughtLesson[],
  rows: readonly PlacedLessonRow[],
  /** A block's lesson with a room says it in the payload's id (pinnedRowsOf: no other pinned row has one). */
  anonRoom?: (realId: string) => string,
): { places: (AnonymousPinnedLesson | null)[] | undefined; unplaced: PlacedLessonRow[] } {
  const places: (AnonymousPinnedLesson | null)[] = lessons.map(() => null);
  const unplaced: PlacedLessonRow[] = [];
  for (const row of rows) {
    const at = lessons.findIndex(
      (lesson, index) =>
        places[index] === null && lesson.minutes === row.minutes && (!row.ownTeacher || lesson.teacherId === row.teacherId),
    );
    if (at < 0) {
      unplaced.push(row);
      continue;
    }
    if (row.roomId !== null && !anonRoom) throw new Error('A pinned lesson with a room needs the payload id of the room (pinnedPlacesOf).');
    places[at] = {
      dayOfWeek: row.dayOfWeek as AnonymousPinnedLesson['dayOfWeek'],
      startTime: payloadClockOf(row.startTime),
      endTime: payloadClockOf(row.endTime),
      ...(row.roomId !== null ? { roomId: anonRoom!(row.roomId) } : {}),
    };
  }
  return { places: places.some((place) => place !== null) ? places : undefined, unplaced };
}

/** What a lesson of an answer says of itself, which is what a pinned row is known by (the answer has no lesson index). */
export interface AnsweredLesson {
  requirementId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  /** HH:MM:SS from the engine, HH:MM in a stored candidate. */
  startTime: string;
  endTime: string;
  /** Present on a lesson of a post sent with its teachers (resolveLessons). */
  teacherId?: string | null;
}

const minutesOfClock = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/**
 * THE LESSON THAT CAME BACK FOR A PINNED ROW. The answer has no lesson index:
 * a pinned lesson comes back among the post's other lessons, and is known by
 * the post, the weekday, the start, the length and, on a post that shares its
 * lessons, the teacher. The engine holds a pin to exactly those, so one is
 * there for each row or the engine did not do what it was asked.
 *
 * Each row takes the first lesson that is its own and none else takes it (a post
 * cannot hold two lessons of one class at one hour, so two rows of one post
 * never want the same). The row is returned as the lesson it is written as: its
 * own weekday, start and length, and THE ROOM THE ENGINE CHOSE, which is what a
 * pinned row has in place of one. `rest` are the lessons no row claimed, which
 * are written as the engine's; `missing` the rows the answer holds no lesson
 * for, which makes the answer one to another request (the write refuses it).
 */
export function writtenFromPins<L extends AnsweredLesson>(
  rows: readonly PlacedLessonRow[],
  lessons: readonly L[],
): { rest: L[]; pinned: PlacedLessonRow[]; missing: PlacedLessonRow[] } {
  const rest = [...lessons];
  const pinned: PlacedLessonRow[] = [];
  const missing: PlacedLessonRow[] = [];
  for (const row of rows) {
    const start = clockOf(row.startTime);
    const at = rest.findIndex(
      (lesson) =>
        lesson.requirementId === row.requirementId &&
        lesson.dayOfWeek === row.dayOfWeek &&
        lesson.startTime.slice(0, 5) === start &&
        minutesOfClock(lesson.endTime) - minutesOfClock(lesson.startTime) === row.minutes &&
        (!row.ownTeacher || (lesson.teacherId ?? null) === row.teacherId) &&
        // A pin that names a room (a block's lesson with a member's own room) is held in THAT room: an answer in another room is
        // an answer to another request, not a lesson to write there in silence (a lock with a room is written from the row itself).
        (row.roomId === null || lesson.roomId === row.roomId),
    );
    if (at < 0) {
      missing.push(row);
      continue;
    }
    const [lesson] = rest.splice(at, 1);
    pinned.push({ ...row, roomId: lesson!.roomId });
  }
  return { rest, pinned, missing };
}

/**
 * The room a refusal names for a row with none: the one value `room` takes that is
 * no room's id. The engine's own catalogue says "in {room}" and has no sentence
 * for a row with no room, so the sentence the page renders chooses its words on
 * this value (PLACEMENT_CANNOT_STAND, web/messages).
 */
export const ANY_ROOM = 'ANY_ROOM';

/** The value `block` takes for a row that is no block's lesson (see ANY_ROOM). */
export const NO_BLOCK = 'NO_BLOCK';

/**
 * GENERERA'S PRE-FLIGHT REFUSAL: the förläggningar that cannot stand where
 * they are placed, judged at this run (placement-judge.ts) since the week
 * moves under a row after it was saved — a teacher changed on the post, a
 * reservation written, a lesson locked. Said in the ids the payload uses, so
 * it reaches the school through realiseConflicts as the engine's own refusals
 * do: `requirement` and `room` are named back, the day and clock are the
 * row's. One line per row that does not stand, under one summary.
 */
export function placementsRefusalOf(
  rows: readonly PlacedLessonRow[],
  verdicts: readonly PlacementVerdict[],
  anon: { requirement: (realId: string) => string; room: (realId: string) => string; block?: (realId: string) => string },
): AiEngineConflictAnalysis | null {
  const refused = verdicts.filter((verdict) => !verdict.ok);
  if (refused.length === 0) return null;
  const conflicts: AiEngineConflictDetail[] = refused.flatMap((verdict): AiEngineConflictDetail[] => {
    const row = rows[verdict.index];
    if (!row) return [];
    const requirement = anon.requirement(row.requirementId);
    const room = row.roomId === null ? ANY_ROOM : anon.room(row.roomId);
    const params: Record<string, string | number> = {
      requirement,
      room,
      day: row.dayOfWeek,
      start: clockOf(row.startTime),
      end: clockOf(row.endTime),
      reason: verdict.reason ?? 'UNKNOWN',
      ...sentenceParams(verdict.params),
      // A member's lesson of a block's förläggning is said by the block as well, and the web's sentence chooses its words on it
      // (NO_BLOCK: the one value that is no block's name, as ANY_ROOM is no room's: a message's select needs the argument given).
      block: row.blockId !== undefined && anon.block ? anon.block(row.blockId) : NO_BLOCK,
    };
    return [
      {
        category: 'PLACEMENT',
        code: PLACEMENT_CANNOT_STAND,
        params,
        message: `A placed lesson cannot stand where it is placed (${params.reason}).`,
        requirementIds: [requirement],
        roomIds: row.roomId === null ? [] : [room],
        constraintIds: [],
        resourceIds: [],
      },
    ];
  });
  return {
    summary:
      `${refused.length} placed lesson(s) on the timplan can no longer stand where they are placed, ` +
      'so the week was not sent. A placed lesson never gives way: move or remove the placement on its timplanspost.',
    summaryCode: PLACEMENTS_REFUSED_SUMMARY,
    summaryParams: { count: refused.length },
    conflicts,
  };
}

/**
 * What the sentence takes from the verdict, beside the row's own day and clock:
 * the lesson it meets as one neutral phrase, "8B Matematik" (class and subject,
 * never a person), the reservation's resource and the other schools. The
 * verdict's `day`, `start` and `end` are the OTHER lesson's, and must not stand
 * in for the förläggning's own in "placed on {day} {start}–{end}".
 */
function sentenceParams(params: PlacementVerdict['params']): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const className = params?.['className'];
  const subjectName = params?.['subjectName'];
  const other = [className, subjectName].filter((part) => typeof part === 'string' && part !== '').join(' ');
  if (other !== '') out['other'] = other;
  for (const key of ['resource', 'schools'] as const) {
    const value = params?.[key];
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return out;
}

/** The pre-flight's codes, in the engine's catalogue (app/messages.py). */
export const PLACEMENTS_REFUSED_SUMMARY = 'PLACEMENTS_REFUSED_SUMMARY';
export const PLACEMENT_CANNOT_STAND = 'PLACEMENT_CANNOT_STAND';

/**
 * A placed lesson as Generera writes it: the post's lesson at the
 * förläggning's day, clock, room and weeks, locked and marked as the run's
 * own. The one place outside the fetch that turns a förläggning into a master
 * lesson.
 *
 * WHO TEACHES IT AND ITS WINDOW ARE THE POST'S AS THE WRITE READS IT, the way
 * the engine's lessons of the same post are stamped (writeRegeneration): a
 * teacher changed while the solver ran reaches both alike. On a shared post the
 * teacher is the förläggning's own, which a change of the post's teachers
 * moves (placement-teachers.ts) and the staleness key then sees. A
 * förläggning whose post the write no longer finds is null, and the caller
 * refuses the write.
 */
export function placedLessonWritesOf(
  rows: readonly PlacedLessonRow[],
  posts: ReadonlyMap<string, Pick<PlacedPost, 'teacherId' | 'coTeacherId' | 'startDate' | 'endDate'>>,
  ids: { schoolId: string; academicYearId: string },
) {
  const writes = [];
  for (const row of rows) {
    const post = posts.get(row.requirementId);
    if (!post) return null;
    writes.push({
      schoolId: ids.schoolId,
      academicYearId: ids.academicYearId,
      subjectId: row.subjectId,
      studentGroupId: row.studentGroupId,
      // Delade lektioner: a shared post's förläggning is its own teacher's.
      teacherId: row.ownTeacher ? row.teacherId : (post.teacherId ?? null),
      coTeacherId: post.coTeacherId ?? null,
      roomId: row.roomId,
      dayOfWeek: row.dayOfWeek,
      startTime: row.startTime,
      endTime: row.endTime,
      recurrence: row.recurrence,
      startDate: post.startDate ?? null,
      endDate: post.endDate ?? null,
      // Generera's own, so the next run replaces it (PRESERVED_FROM_REGENERATION),
      // and locked, so nothing between two runs moves it.
      isGenerated: true,
      isLocked: true,
      fromPlacement: true,
    });
  }
  return writes;
}

/**
 * The year's förläggningar as one comparable string, by what a write writes
 * from them: Generera reads them again under the year's lock and refuses a
 * write (GENERATE_STALE) when they moved while the solver ran, since the
 * week it was handed was laid around the old ones.
 */
export function placementsKeyOf(
  rows: readonly Pick<
    PlacementRead,
    'id' | 'requirementId' | 'dayOfWeek' | 'startTime' | 'minutes' | 'roomId' | 'recurrence' | 'teacherId'
  >[],
): string {
  return rows
    .map((row) =>
      [
        row.id,
        row.requirementId,
        row.dayOfWeek,
        row.startTime.toISOString(),
        row.minutes,
        // No room is a row of its own kind (a pinned lesson), and the same row given a room is another week.
        row.roomId ?? '',
        row.recurrence,
        // Delade lektioner: a förläggning handed to another teacher is a week for another timplan.
        row.teacherId ?? '',
      ].join('|'),
    )
    .sort()
    .join('\n');
}

/** The förläggningar a run was handed, as the staleness key reads the stored rows: their own teacher column. */
export function storedPlacementsOf(rows: readonly PlacedLessonRow[]) {
  // A block's lesson has no row of its own in the table the key reads: its own key is blockPlacementsKeyOf's.
  return rows.filter((row) => !isBlockRow(row)).map((row) => ({ ...row, teacherId: row.placementTeacherId }));
}
