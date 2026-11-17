import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { LessonRecurrence, Prisma, PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { MasterLessonsService } from '../calendar/master-lessons.service';
import type { GradeNumbering } from '../common/grade-numbering';
import { requirementPlacementsConflict, rethrowPrismaError } from '../common/utils/prisma-errors';
import { requireSchoolId } from '../common/utils/request-context';
import { parseTimeString, toWallClock } from '../common/utils/time';
import { PrismaService } from '../database/prisma.service';
import type { TaughtLesson } from '../optimization/locked-coverage';
import { judgeDemandOf } from '../optimization/post-demand';
import { keptMastersWhere } from '../optimization/preserved-lessons';
import { lockYearForGrundschemaEdit } from '../optimization/regeneration-lock';
import { rostersOfYear } from '../year-rollover/projected-rosters';
import type { ReplacePlacementsDto } from './dto/requirement-placements.dto';
import {
  placedByRowsOf,
  placementFitOf,
  teacherMisfitOf,
  type PlacementFitReason,
  type PlacementPost,
} from './placement-fit';
import { judgePlacementTeachersNow } from './placement-teachers';
import {
  boardPostOf,
  boardPostShape,
  coveringLocksOf,
  keptViewOf,
  lessonsLeftOf,
  mealViewOf,
  type BoardPlacementView,
  type BoardPost,
  type KeptForCount,
} from './placement-board';
import { lockPostForShares } from '../resources/requirement-shares';
import {
  clockText,
  judgedRowOf,
  judgePlacements,
  type JudgedPlacement,
  type PlacementParams,
  type PlacementRefusalReason,
  type PlacementVerdict,
} from './placement-judge';
import { placementRefusedConflict, placementsStaleConflict } from './placement-refusal';
import { placementWarnings } from './placement-warning-reads';
import type { PlacementWarning, PlacementWarningView } from './placement-warnings';
import { readOtherSchoolHolds } from '../optimization/other-school-holds';
import { boardBlockOf, type PlacementBoardWithBlocks } from './block-placement-board';
import { besideRowsOfBlocks, judgedRowsOfBlock, loadBlocksOfYear, memberSlotsOfBlock } from './block-placement-judge';
import { rowsKeyOf } from './placement-rows-key';
import { sentIndexOf, unchangedOf } from './placement-unchanged';

/** One förlagd lektion as the API states it (the dialog's row and the timplan's märke). */
export interface RequirementPlacementView {
  id: string;
  requirementId: string;
  dayOfWeek: number;
  /** HH:MM. */
  startTime: string;
  /** HH:MM, the start and the length. */
  endTime: string;
  minutes: number;
  /** Null: the school left the room to the engine, which chooses it at every Generera (20270213090000). */
  roomId: string | null;
  /** Null with no room. */
  roomName: string | null;
  recurrence: LessonRecurrence;
  /** Delade lektioner: whose lesson, on a post that shares its lessons; null on one that shares nothing. */
  teacherId: string | null;
}

export interface PlacementVerdictView {
  index: number;
  ok: boolean;
  reason?: PlacementRefusalReason;
  params?: PlacementParams;
}

export interface RequirementPlacementsResponse {
  placements: RequirementPlacementView[];
  verdicts: PlacementVerdictView[];
  /**
   * The key of these rows (rowsKeyOf): what a client sends back as `baseKey` to say that its next write is made on top of
   * them. After a PUT it is the key of the rows just written, so that a client can chain its writes without reading again.
   */
  rowsKey: string;
  /**
   * What the week the school has fixed says about these rows (placement-warnings.ts), one entry per warning, each naming
   * its row in `placements`. Additive: an older client ignores it. A warning never refuses a save.
   */
  warnings: PlacementWarningView[];
}

/** Where a lesson stands, as a request states it or a stored row has it, and whose it is on a shared post. */
export interface PlacementSlot {
  dayOfWeek: number;
  startMinutes: number;
  minutes: number;
  /** Null: the room is the engine's to choose. */
  roomId: string | null;
  recurrence: LessonRecurrence;
  teacherId: string | null;
}

const VIEW_SELECT = {
  id: true,
  requirementId: true,
  dayOfWeek: true,
  startTime: true,
  minutes: true,
  roomId: true,
  recurrence: true,
  teacherId: true,
  room: { select: { name: true } },
} as const;

/** The same order for every list, so a verdict's index is a row's place in the answer. */
const VIEW_ORDER = [{ dayOfWeek: 'asc' }, { startTime: 'asc' }, { recurrence: 'asc' }, { id: 'asc' }] as const;

const POST_SELECT = {
  id: true,
  schoolId: true,
  academicYearId: true,
  studentGroupId: true,
  subjectId: true,
  teacherId: true,
  coTeacherId: true,
  lessonsPerWeek: true,
  minutesPerLesson: true,
  lessonLengths: true,
  recurrence: true,
  blockId: true,
  startDate: true,
  endDate: true,
  // Delade lektioner: who teaches which lessons (lessonTeachersOf sorts them itself).
  shares: { select: { teacherId: true, lessons: true, minutes: true } },
  academicYear: { select: { isActive: true, predecessorId: true, gradeNumbering: true, startDate: true, endDate: true } },
} as const;

/** What the week of förläggningar reads of every post of the year. */
const BOARD_POST_SELECT = {
  id: true,
  studentGroupId: true,
  subjectId: true,
  teacherId: true,
  coTeacherId: true,
  lessonsPerWeek: true,
  minutesPerLesson: true,
  lessonLengths: true,
  recurrence: true,
  blockId: true,
  startDate: true,
  endDate: true,
  minutesBefore: true,
  minutesAfter: true,
  shares: { select: { teacherId: true, lessons: true, minutes: true } },
} as const;

/** What the week reads of a lesson Generera keeps: where it stands and whose it is, no pupil. */
const BOARD_KEPT_SELECT = {
  id: true,
  dayOfWeek: true,
  startTime: true,
  endTime: true,
  studentGroupId: true,
  subjectId: true,
  teacherId: true,
  coTeacherId: true,
  roomId: true,
  recurrence: true,
  startDate: true,
  endDate: true,
  isLocked: true,
  isGenerated: true,
  extraGroups: { select: { studentGroupId: true } },
} as const;

type PostRow = Prisma.TeachingRequirementGetPayload<{ select: typeof POST_SELECT }>;

type StoredView = {
  id: string;
  requirementId: string;
  dayOfWeek: number;
  startTime: Date;
  minutes: number;
  roomId: string | null;
  recurrence: LessonRecurrence;
  teacherId: string | null;
  room: { name: string } | null;
};

const minutesOfClock = (time: Date): number => time.getUTCHours() * 60 + time.getUTCMinutes();

function viewOf(row: StoredView): RequirementPlacementView {
  const start = minutesOfClock(row.startTime);
  return {
    id: row.id,
    requirementId: row.requirementId,
    dayOfWeek: row.dayOfWeek,
    startTime: toWallClock(row.startTime),
    endTime: clockText(start + row.minutes),
    minutes: row.minutes,
    roomId: row.roomId,
    roomName: row.room?.name ?? null,
    recurrence: row.recurrence,
    teacherId: row.teacherId,
  };
}

/** A stored row as the key reads it (placement-rows-key.ts): its columns and its id, the start as a time of day. */
type KeyedRow = Parameters<typeof rowsKeyOf>[0][number];

const keyedOf = (row: StoredView): KeyedRow => ({
  id: row.id,
  requirementId: row.requirementId,
  dayOfWeek: row.dayOfWeek,
  startTime: row.startTime,
  minutes: row.minutes,
  roomId: row.roomId,
  recurrence: row.recurrence,
  teacherId: row.teacherId,
});

const slotOf = (row: StoredView): PlacementSlot => ({
  dayOfWeek: row.dayOfWeek,
  startMinutes: minutesOfClock(row.startTime),
  minutes: row.minutes,
  roomId: row.roomId,
  recurrence: row.recurrence,
  teacherId: row.teacherId,
});

type BoardPostRow = Prisma.TeachingRequirementGetPayload<{ select: typeof BOARD_POST_SELECT }>;

/** A lesson Generera keeps as the count reads it: with its length. */
const keptForCountOf = <T extends { startTime: Date; endTime: Date }>(lesson: T): T & { minutes: number } => ({
  ...lesson,
  minutes: minutesOfClock(lesson.endTime) - minutesOfClock(lesson.startTime),
});

/**
 * What every post's count is made of, from what the year holds: each post's rows as the count reads them (a block's lesson is one of
 * each member's lessons placed), the rows as the key reads them, and each post's covering locks. The week of förläggningar counts
 * and judges with them, and the question of whether the engine has anything to place counts with the same ones.
 */
function countedPostsOf(
  posts: readonly BoardPostRow[],
  rows: readonly StoredView[],
  kept: readonly KeptForCount[],
  blocks: Awaited<ReturnType<typeof loadBlocksOfYear>>,
) {
  const slotsOf = new Map<string, PlacementSlot[]>();
  const keyedOfPost = new Map<string, KeyedRow[]>();
  for (const row of rows) {
    const list = slotsOf.get(row.requirementId);
    if (list) list.push(slotOf(row));
    else slotsOf.set(row.requirementId, [slotOf(row)]);
    const keyed = keyedOfPost.get(row.requirementId);
    if (keyed) keyed.push(keyedOf(row));
    else keyedOfPost.set(row.requirementId, [keyedOf(row)]);
  }
  // A block's lesson is one of each member's lessons placed: the member's count and demand read it so.
  for (const block of blocks) {
    for (const [memberId, slots] of memberSlotsOfBlock(block, block.rows)) slotsOf.set(memberId, [...(slotsOf.get(memberId) ?? []), ...slots]);
  }
  const locksByPost = new Map(posts.map((post) => [post.id, coveringLocksOf(boardPostShape(post), kept)]));
  return { slotsOf, keyedOfPost, locksByPost };
}

/**
 * Förlagda poster, the gateway's side: a timplanspost's förläggningar read,
 * judged and replaced (see placement-judge.ts for what a row is held to, and
 * placement-fit.ts for what makes a set of rows fit a post).
 *
 * The rows are the post's. The class, the subject and the teachers are read
 * from the post at every judgment, so a teacher changed on the post is
 * answered at the next view or Generera, not refused at the change. On a post
 * with delade lektioner each row names its own teacher (placement-fit.ts),
 * which a change of the post's teachers carries along or refuses
 * (placement-teachers.ts), and the row is judged against that teacher's week.
 */
@Injectable()
export class RequirementPlacementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly masters: MasterLessonsService,
  ) {}

  /** The year's förläggningar, for the märke on the timplan. A read, every administrator's. */
  async listOfYear(academicYearId: string, user: AuthenticatedUser): Promise<RequirementPlacementView[]> {
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.teachingRequirementPlacement.findMany({
        where: { requirement: { academicYearId } },
        select: VIEW_SELECT,
        orderBy: [{ requirementId: 'asc' }, ...VIEW_ORDER],
      });
      return rows.map(viewOf);
    });
  }

  /** One post's förläggningar, each judged now: the week moves under a row between a save and a view. */
  async listOfPost(id: string, user: AuthenticatedUser): Promise<RequirementPlacementsResponse> {
    return this.prisma.withRls(user, async (tx) => {
      const post = await this.postOf(tx, id);
      const rows = await tx.teachingRequirementPlacement.findMany({
        where: { requirementId: id },
        select: VIEW_SELECT,
        orderBy: [...VIEW_ORDER],
      });
      const { verdicts, rows: judgedRows, beside } = await this.judged(tx, user, post, rows.map(slotOf));
      const warnings = await this.warningsOf(tx, user, post, judgedRows, beside);
      return {
        placements: rows.map(viewOf),
        verdicts,
        rowsKey: rowsKeyOf(rows.map(keyedOf)),
        warnings: warningViewsOf(warnings, post.id, (index) => rows[index]!.id),
      };
    });
  }

  /**
   * THE WEEK OF FÖRLÄGGNINGAR: every row of the year with its verdict, every
   * post's lessons counted the way Generera counts them, and the lessons and
   * meals the rows are held against. One read of the year for the page that
   * shows them in a week (admin/placements), before and after a run.
   *
   * The rows are judged by judgePlacements as Generera's pre-flight judges them
   * (every row of the year at once, none held beside), not by a second rule, and
   * a post's `left` is demandLeftOf's, which Generera's fetch reads. The judge's
   * input is put together by the same functions on both sides: a row by
   * judgedRowOf, a post's locks and placed lessons by judgeDemandOf, the lessons
   * kept by keptMastersWhere (review of #315, MEDEL-1; the adapter probe's vv6
   * reads one world through both and requires the same input and verdicts). A read:
   * every administrator's. It names no person (the judge names a class and a
   * subject; a teacher is an id the page resolves, as it does for the list of
   * the year's rows), and it asks nothing of the caller's own person, so a login
   * with none (the huvudman's reader) is answered in the same shape.
   */
  async boardOfYear(academicYearId: string, user: AuthenticatedUser): Promise<PlacementBoardWithBlocks> {
    return this.prisma.withRls(user, async (tx) => {
      const year = await tx.academicYear.findUnique({
        where: { id: academicYearId },
        select: { isActive: true, predecessorId: true, gradeNumbering: true, startDate: true, endDate: true },
      });
      if (!year) throw new NotFoundException('Läsåret finns inte.');
      const [posts, rows, keptRows, mealRows, blocks, written, held] = await Promise.all([
        tx.teachingRequirement.findMany({ where: { academicYearId }, select: BOARD_POST_SELECT, orderBy: { id: 'asc' } }),
        tx.teachingRequirementPlacement.findMany({
          where: { requirement: { academicYearId } },
          select: { ...VIEW_SELECT, updatedAt: true },
          orderBy: [{ requirementId: 'asc' }, ...VIEW_ORDER],
        }),
        // What Generera keeps (and the rows are held against): the same read, the same filter.
        tx.masterLesson.findMany({
          where: keptMastersWhere(academicYearId),
          select: BOARD_KEPT_SELECT,
          orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }, { id: 'asc' }],
        }),
        // The meals the school placed by hand: the only ones a row is held to (placement-judge.ts).
        tx.lunchSitting.findMany({
          where: { academicYearId, isGenerated: false },
          select: { id: true, studentGroupId: true, dayOfWeek: true, startTime: true, endTime: true, startDate: true, endDate: true },
          orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }, { id: 'asc' }],
        }),
        // Förlagda block: every block of the year with its members and lessons (block-placement-judge.ts).
        loadBlocksOfYear(tx, academicYearId),
        // What Generera last wrote from them (BoardTimetableView): the grundschema's own count and newest createdAt.
        tx.masterLesson.aggregate({
          where: { academicYearId, fromPlacement: true },
          _count: { _all: true },
          _max: { createdAt: true },
        }),
        // Other schools' hold on this school's teachers and rooms, which the judge holds a row to (OTHER_SCHOOL): bands in the week.
        readOtherSchoolHolds(tx, academicYearId, requireSchoolId(user)),
      ]);

      const kept = keptRows.map(keptForCountOf);
      const postById = new Map(posts.map((post) => [post.id, post]));
      const { slotsOf, keyedOfPost, locksByPost } = countedPostsOf(posts, rows, kept, blocks);
      const ofBlocks = blocks.map((block) => ({ block, ...judgedRowsOfBlock(block, block.rows) }));

      // The posts' rows first, then each block's, one row per lesson and member (judgedRowsOfBlock).
      const judgedRows = [...rows.map((row) => judgedRowOf(postById.get(row.requirementId)!, slotOf(row), row.id)), ...ofBlocks.flatMap((entry) => entry.judged)];
      // Every row of the year at once, as Generera's pre-flight judges them, against the lessons it keeps and each other.
      const verdicts: PlacementVerdict[] =
        judgedRows.length === 0
          ? []
          : await judgePlacements(tx, this.masters, {
              academicYearId,
              schoolId: requireSchoolId(user),
              gradeNumbering: year.gradeNumbering as GradeNumbering,
              basis: await rostersOfYear(tx, user, academicYearId, { isActive: year.isActive, predecessorId: year.predecessorId }),
              rows: judgedRows,
              beside: [],
              demand: new Map(
                [...slotsOf].map(([postId, slots]) => {
                  const post = postById.get(postId)!;
                  return [postId, judgeDemandOf(post, locksByPost.get(postId) ?? [], placedByRowsOf(post, slots))] as const;
                }),
              ),
            });

      const boardPosts = posts.map((post) =>
        boardPostOf(boardPostShape(post), locksByPost.get(post.id) ?? [], slotsOf.get(post.id) ?? [], rowsKeyOf(keyedOfPost.get(post.id) ?? [])),
      );
      // What the fixed week says of every row, with the lessons Generera keeps and the meals placed by hand read once above, and
      // whether the engine has anything to place (the posts are counted: a class's lunch refuses only then).
      const warned = await placementWarnings(tx, user, {
        academicYearId,
        year,
        rows: judgedRows,
        beside: [],
        kept,
        meals: mealRows,
        lessonsLeft: lessonsLeftOf(boardPosts),
      });
      const originOfJudged = ofBlocks.flatMap((entry) => entry.origins.map((origin) => ({ origin, block: entry.block })));
      const warnings: PlacementWarningView[] = warned.flatMap((list, index) => {
        if (list.length === 0) return [];
        const post = index < rows.length ? rows[index]! : null;
        const block = post === null ? originOfJudged[index - rows.length]! : null;
        const rowId = post !== null ? post.id : block!.block.rows[block!.origin.index]?.id;
        if (rowId === undefined || rowId === null) return [];
        return list.map(
          (warning): PlacementWarningView => ({
            rowId,
            requirementId: post !== null ? post.requirementId : block!.origin.requirementId,
            ...(block !== null ? { blockId: block.origin.blockId } : {}),
            ...warning,
          }),
        );
      });

      const placements: BoardPlacementView[] = rows.map((row, index) => {
        const verdict = verdicts[index] ?? { index, ok: true };
        return {
          ...viewOf(row),
          changedAt: row.updatedAt.toISOString(),
          verdict: { ok: verdict.ok, ...(verdict.reason ? { reason: verdict.reason } : {}), ...(verdict.params ? { params: verdict.params } : {}) },
        };
      });
      return {
        academicYearId,
        timetable: { placedLessons: written._count._all, writtenAt: written._max.createdAt?.toISOString() ?? null },
        placements,
        posts: boardPosts,
        kept: kept.map(keptViewOf),
        meals: mealRows.map(mealViewOf),
        warnings,
        holds: held.holds.map((hold) => ({
          kind: hold.kind,
          resourceKind: hold.resourceKind,
          resourceId: hold.resourceId,
          dayOfWeek: hold.dayOfWeek,
          startTime: hold.startTime.slice(0, 5),
          endTime: hold.endTime.slice(0, 5),
          schools: hold.schools,
        })),
        blocks: ofBlocks.map((entry) => {
          // This block's verdicts: the rows after the posts' and the earlier blocks'.
          const start = rows.length + ofBlocks.slice(0, ofBlocks.indexOf(entry)).reduce((sum, earlier) => sum + earlier.judged.length, 0);
          return boardBlockOf(entry.block, verdicts.slice(start, start + entry.judged.length), entry.origins);
        }),
      };
    });
  }

  /**
   * Replaces the post's förläggningar with the request's list (empty removes
   * them). Refused with 409, and nothing written, for the first of: rows that
   * do not fit the post (REQUIREMENT_PLACEMENTS_DO_NOT_FIT, with the rule),
   * and the first NEW or CHANGED row the week does not hold
   * (REQUIREMENT_PLACEMENT_REFUSED, with its index in the request, the reason
   * and what it clashes with). A row the post has already is not refused when
   * it has stopped holding: it is let stand and named in the answer's verdicts
   * (placement-unchanged.ts), so that a post with two such rows can be mended
   * one row at a time.
   *
   * Written beside other grundschema edits and never inside a rewrite of the
   * year (the year's edit lock, 409 SCHEDULE_BUSY), so that it cannot land in
   * the middle of a Generera's write: the rows Generera reads and the lessons
   * it writes from them are then one list. Changing a förläggning moves
   * nothing in the grundschema; it counts from the next Generera.
   */
  async replace(id: string, dto: ReplacePlacementsDto, user: AuthenticatedUser): Promise<RequirementPlacementsResponse> {
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const post = await this.postOf(tx, id);
        await lockYearForGrundschemaEdit(tx, post.academicYearId);

        const wanted: PlacementSlot[] = dto.placements.map((row) => ({
          dayOfWeek: row.dayOfWeek,
          startMinutes: minutesOfClock(parseTimeString(row.startTime)),
          minutes: row.minutes,
          roomId: row.roomId ?? null,
          recurrence: row.recurrence,
          teacherId: row.teacherId ?? null,
        }));
        await this.assertRoomsExist(tx, wanted);

        const shape = placementPostOf(post);
        const fit = placementFitOf(shape, wanted);
        if (fit !== null) throw requirementPlacementsConflict(fit, fitIndexOf(shape, wanted, fit));

        const { verdicts, rows: judgedRows, beside } = await this.judged(tx, user, post, wanted);
        // Refused for the rows the save puts there, not for the ones the post already has: a post whose rows have stopped
        // holding is mended one row at a time, and the rows still not holding are said in the answer (placement-unchanged.ts).
        const failing = verdicts.filter((verdict) => !verdict.ok);
        if (failing.length > 0) {
          const stored = await tx.teachingRequirementPlacement.findMany({
            where: { requirementId: id },
            select: VIEW_SELECT,
            orderBy: [...VIEW_ORDER],
          });
          const unchanged = unchangedOf(wanted, stored.map(slotOf));
          const refused = failing.find((verdict) => !unchanged[verdict.index]);
          if (refused) throw placementRefusedConflict(refused);
        }

        // The post's row first, as every other writer of its förläggningar takes it (the PATCH, the staffing
        // proposal and the import hold it and then move the rows): DELETE first locks the rows and the trigger
        // then waits for the post, which a writer holding the post and waiting for the rows closes into a
        // deadlock (review of #298, LÅG-1).
        await lockPostForShares(tx, id);
        // On top of what the client read (`baseKey`): asked of the rows as they stand NOW, with the post locked and
        // before anything is deleted. Asked before the lock, two writers who both read the same list would both pass it
        // and the second would silently replace the first's; asked after it, the second reads what the first committed
        // (every statement sees the rows committed when it starts) and is refused. A write that gives no key is not asked.
        if (dto.baseKey !== undefined || failing.length > 0) {
          const current = await tx.teachingRequirementPlacement.findMany({
            where: { requirementId: id },
            select: VIEW_SELECT,
            orderBy: [...VIEW_ORDER],
          });
          if (dto.baseKey !== undefined && rowsKeyOf(current.map(keyedOf)) !== dto.baseKey) throw placementsStaleConflict(id);
          // A row let stand because the post had it must be in the list the post has now, locked: if somebody wrote the post
          // between that read and this lock the row was never judged as a new one, and the client reads the post again.
          if (failing.length > 0) {
            const now = unchangedOf(wanted, current.map(slotOf));
            if (failing.some((verdict) => !now[verdict.index])) throw placementsStaleConflict(id);
          }
        }
        // The post's rows are replaced as one list: the old ones go and the new ones are one INSERT, so the
        // trigger, which judges the post's rows when each statement is done, sees the whole set (a pair is two
        // rows). Flat createMany, never a nested create (it drops schoolId at runtime).
        await tx.teachingRequirementPlacement.deleteMany({ where: { requirementId: id } });
        if (wanted.length > 0) {
          await tx.teachingRequirementPlacement.createMany({
            data: wanted.map((slot) => ({
              schoolId: post.schoolId,
              requirementId: id,
              dayOfWeek: slot.dayOfWeek,
              startTime: parseTimeString(clockText(slot.startMinutes)),
              minutes: slot.minutes,
              roomId: slot.roomId,
              recurrence: slot.recurrence,
              teacherId: slot.teacherId,
            })),
          });
        }
        // Delade lektioner: the database's rules per teacher, deferred to the end of
        // the transaction, asked for now, so that a refusal is this statement's.
        await judgePlacementTeachersNow(tx);
        const written = await tx.teachingRequirementPlacement.findMany({
          where: { requirementId: id },
          select: VIEW_SELECT,
          orderBy: [...VIEW_ORDER],
        });
        // The rows let stand that still do not hold are named (a verdict that is not ok), at the place the answer has them.
        const sent = sentIndexOf(written.map(slotOf), wanted);
        // What the week says of the rows now written, at their places in the answer. A save is never refused for it.
        const warned = await this.warningsOf(tx, user, post, judgedRows, beside);
        return {
          placements: written.map(viewOf),
          verdicts: written.map((_, index): PlacementVerdictView => {
            const verdict = verdicts[sent[index] ?? -1];
            return verdict && !verdict.ok
              ? { index, ok: false, ...(verdict.reason ? { reason: verdict.reason } : {}), ...(verdict.params ? { params: verdict.params } : {}) }
              : { index, ok: true };
          }),
          rowsKey: rowsKeyOf(written.map(keyedOf)),
          warnings: warningViewsOf(
            written.map((_, index) => warned[sent[index] ?? -1] ?? []),
            id,
            (index) => written[index]!.id,
          ),
        };
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  private async postOf(tx: PrismaClient, id: string): Promise<PostRow> {
    const post = await tx.teachingRequirement.findUnique({ where: { id }, select: POST_SELECT });
    if (!post) throw new NotFoundException('Timplansposten finns inte.');
    return post;
  }

  /**
   * A room the school does not have is the caller's mistake, said by name.
   * Row-level security shows the school's own rooms only, so another school's
   * room reads as absent here, as it does to the foreign key.
   */
  private async assertRoomsExist(tx: PrismaClient, slots: readonly PlacementSlot[]): Promise<void> {
    // A row with no room asks for none: the engine chooses it (20270213090000).
    const ids = [...new Set(slots.flatMap((slot) => (slot.roomId === null ? [] : [slot.roomId])))];
    if (ids.length === 0) return;
    const found = new Set((await tx.room.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((room) => room.id));
    if (ids.some((roomId) => !found.has(roomId))) {
      throw new BadRequestException('placements: en sal finns inte i skolan.');
    }
  }

  /**
   * The post's rows judged against the kept lessons, the year's other posts'
   * förläggningar and each other. The year's classes are read on the basis the
   * hand edit uses (a year not yet activated is judged on the pupils its
   * activation would place, and a year two steps ahead is refused, R6). The rows
   * as the judge read them and the rows beside are returned with the verdicts,
   * so that the warnings count over the very same week without reading it again.
   */
  private async judged(
    tx: PrismaClient,
    user: AuthenticatedUser,
    post: PostRow,
    slots: readonly PlacementSlot[],
  ): Promise<{ verdicts: PlacementVerdict[]; rows: JudgedPlacement[]; beside: JudgedPlacement[] }> {
    if (slots.length === 0) return { verdicts: [], rows: [], beside: [] };
    const schoolId = requireSchoolId(user);
    const basis = await rostersOfYear(tx, user, post.academicYearId, {
      isActive: post.academicYear.isActive,
      predecessorId: post.academicYear.predecessorId,
    });
    const beside = await this.besideOf(tx, post);
    const locks = await this.locksOf(tx, post);
    const rows = slots.map((slot) => judgedRowOf(post, slot));
    const verdicts = await judgePlacements(tx, this.masters, {
      academicYearId: post.academicYearId,
      schoolId,
      gradeNumbering: post.academicYear.gradeNumbering as GradeNumbering,
      basis,
      rows,
      beside,
      demand: new Map([[post.id, judgeDemandOf(post, locks, placedByRowsOf(post, slots))]]),
    });
    return { verdicts, rows, beside };
  }

  /** What the fixed week says of the post's rows (placement-warnings.ts), a list per row. */
  private warningsOf(tx: PrismaClient, user: AuthenticatedUser, post: PostRow, rows: readonly JudgedPlacement[], beside: readonly JudgedPlacement[]): Promise<PlacementWarning[][]> {
    return placementWarnings(tx, user, {
      academicYearId: post.academicYearId,
      year: { startDate: post.academicYear.startDate, endDate: post.academicYear.endDate },
      rows,
      beside,
      lessonsLeft: () => this.yearHasLessonsLeft(tx, post.academicYearId),
    });
  }

  /**
   * Whether any post of the year has a lesson left for the engine to place, counted as the week of förläggningar counts it (the same
   * reads, the same functions). Asked by a post's read or save only when the answer changes what a lunch warning says: Generera does not
   * call the engine for a year with nothing left, so the class's lunch cannot refuse it (placement-warnings.ts, ASKED).
   */
  private async yearHasLessonsLeft(tx: PrismaClient, academicYearId: string): Promise<boolean> {
    const [posts, rows, keptRows, blocks] = await Promise.all([
      tx.teachingRequirement.findMany({ where: { academicYearId }, select: BOARD_POST_SELECT, orderBy: { id: 'asc' } }),
      tx.teachingRequirementPlacement.findMany({ where: { requirement: { academicYearId } }, select: VIEW_SELECT }),
      tx.masterLesson.findMany({ where: keptMastersWhere(academicYearId), select: BOARD_KEPT_SELECT }),
      loadBlocksOfYear(tx, academicYearId),
    ]);
    const { slotsOf, locksByPost } = countedPostsOf(posts, rows, keptRows.map(keptForCountOf), blocks);
    // The rows' key is a write's, and the count has no use for it.
    return lessonsLeftOf(posts.map((post) => boardPostOf(boardPostShape(post), locksByPost.get(post.id) ?? [], slotsOf.get(post.id) ?? [], '')));
  }

  /**
   * The year's other posts' förläggningar, as they stand, and the lessons of the year's blocks as the rows of their
   * members (block-placement-judge.ts), `exceptBlockId` left out: the block being written has its own rows.
   */
  async besideOf(
    tx: PrismaClient,
    post: { id: string; academicYearId: string },
    exceptBlockId?: string,
  ): Promise<JudgedPlacement[]> {
    const rows = await tx.teachingRequirementPlacement.findMany({
      where: { requirement: { academicYearId: post.academicYearId }, requirementId: { not: post.id } },
      select: {
        id: true,
        requirementId: true,
        dayOfWeek: true,
        startTime: true,
        minutes: true,
        roomId: true,
        recurrence: true,
        teacherId: true,
        requirement: {
          select: {
            studentGroupId: true,
            subjectId: true,
            teacherId: true,
            coTeacherId: true,
            startDate: true,
            endDate: true,
            _count: { select: { shares: true } },
          },
        },
      },
      orderBy: [{ requirementId: 'asc' }, { id: 'asc' }],
    });
    const ofBlocks = besideRowsOfBlocks(
      await loadBlocksOfYear(tx, post.academicYearId, { onlyPlaced: true, ...(exceptBlockId ? { except: exceptBlockId } : {}) }),
    );
    return [...rows.map(({ requirement: { _count, ...requirement }, ...row }) => ({
      id: row.id,
      requirementId: row.requirementId,
      ...requirement,
      // Delade lektioner: the lesson's own teacher on a post that shares its lessons.
      teacherId: _count.shares > 0 ? row.teacherId : requirement.teacherId,
      dayOfWeek: row.dayOfWeek,
      startMinutes: minutesOfClock(row.startTime),
      minutes: row.minutes,
      roomId: row.roomId,
      recurrence: row.recurrence,
    })), ...ofBlocks];
  }

  /**
   * The lessons the grundschema already answers the post with, each its
   * minutes and its teacher, the way Generera counts them: the lessons it keeps
   * (keptMastersWhere) of the post's class and subject, and the ones of them that
   * cover the post's weeks (coveringLocksOf, which the week of förläggningar
   * counts a post's locks with from the same lessons: review of #315, LÅG-6,
   * where the dialog's own copy of the filter could drop an arm unseen). A lesson
   * Generera wrote from a förläggning is not among them unless somebody has made
   * it a lesson Generera keeps; then it answers the post, and the rows that place
   * the same lesson are over the demand.
   */
  async locksOf(
    tx: PrismaClient,
    post: Pick<BoardPost, 'studentGroupId' | 'subjectId' | 'recurrence' | 'startDate' | 'endDate'> & { academicYearId: string },
  ): Promise<TaughtLesson[]> {
    const lessons = await tx.masterLesson.findMany({
      where: { ...keptMastersWhere(post.academicYearId), studentGroupId: post.studentGroupId, subjectId: post.subjectId },
      select: { studentGroupId: true, subjectId: true, startTime: true, endTime: true, recurrence: true, startDate: true, endDate: true, teacherId: true },
    });
    return coveringLocksOf(
      post,
      lessons.map((lesson) => ({ ...lesson, minutes: minutesOfClock(lesson.endTime) - minutesOfClock(lesson.startTime) })),
    );
  }
}

/** The warnings of a list of rows as an answer states them: each names its row in the answer, by the answer's own id. */
function warningViewsOf(
  warnings: readonly (readonly PlacementWarning[])[],
  requirementId: string,
  rowIdAt: (index: number) => string,
): PlacementWarningView[] {
  return warnings.flatMap((list, index) => list.map((warning): PlacementWarningView => ({ rowId: rowIdAt(index), requirementId, ...warning })));
}

/** What the fit reads of a post. */
function placementPostOf(post: {
  lessonsPerWeek: number;
  minutesPerLesson: number;
  lessonLengths: number[];
  recurrence: LessonRecurrence;
  blockId: string | null;
  teacherId: string | null;
  shares: { teacherId: string | null; lessons: number; minutes: number }[];
}): PlacementPost {
  return {
    lessonsPerWeek: post.lessonsPerWeek,
    minutesPerLesson: post.minutesPerLesson,
    lessonLengths: post.lessonLengths,
    recurrence: post.recurrence,
    blockId: post.blockId,
    teacherId: post.teacherId,
    shares: post.shares,
  };
}

/**
 * Which of the request's rows a refusal of the rules per teacher is about, for
 * the dialog to say it at that row: the first that names nobody (NO_TEACHER),
 * else the one teacherMisfitOf answers, and for PAIR_ROOM the first half of a
 * pair with no room. The post's own other rules are about the set and name no row.
 */
function fitIndexOf(post: PlacementPost, rows: readonly PlacementSlot[], fit: PlacementFitReason): { index?: number } {
  if (fit === 'NO_TEACHER') return { index: rows.findIndex((row) => row.teacherId === null) };
  // The first half of a pair that names no room: the dialog says it at that row.
  if (fit === 'PAIR_ROOM') return { index: rows.findIndex((row) => row.recurrence !== 'ALL_WEEKS' && row.roomId === null) };
  if (fit.startsWith('TEACHER')) {
    const misfit = teacherMisfitOf(post, rows);
    if (misfit) return { index: misfit.index };
  }
  return {};
}
