import { createHash } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { LessonRecurrence } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { MasterLessonsService, type CreateMasterLessonResult, type UpdateMasterLessonResult } from '../calendar/master-lessons.service';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { lockCoversDemand } from '../optimization/locked-coverage';
import { lockYearForGrundschemaEdit } from '../optimization/regeneration-lock';
import { enterGrundschemaWrite } from '../publication/publish-mode';
import { REQUIREMENT_PLACEMENTS_STALE } from '../requirement-placements/placement-refusal';
import { lockPostForShares } from '../resources/requirement-shares';
import type { LayBrickDto } from './dto/lay-brick.dto';
import { BOARD_ROOM_NOT_ALLOWED, layRoomRefusal } from './lay-room';
import { boardPostOf, boardPostShape, coveringLocksOf, type KeptForCount } from '../requirement-placements/placement-board';
import { loadBlocksOfYear } from '../requirement-placements/block-placement-judge';
import { BOARD_KEPT_SELECT, BOARD_POST_SELECT, VIEW_SELECT, countedPostsOf, keptForCountOf } from '../requirement-placements/requirement-placements.service';

/*
 * ATT LÄGGA (E4): the grundschema's tray. One BRICK for each lesson a timplanspost has left, counted as Generera counts it.
 *
 * The count is demandLeftOf's (optimization/post-demand.ts), through the one function the week of förläggningar draws its posts with
 * (boardPostOf), so the figure on the board is the figure Generera sends, with one difference that is the point of a board: what is
 * already on the grundschema answers a lesson, the lessons Generera laid and nobody has locked as well as the ones it keeps. Generera deletes
 * the free ones before it counts; the board shows them standing, and a lesson that stands is not one to lay. A förläggning answers a lesson
 * as it does for Generera, and a lesson on the tray (parkeringen) answers none: it occupies nothing.
 *
 * NO PERSON IS NAMED. A brick says whose it is by id, as the post does; the page resolves names from the lists it already reads.
 */

/** One lesson still to lay. */
export interface TrayBrick {
  /** The timplanspost, and which of its lessons of this teacher and length this is (1..) among those still to lay. */
  postId: string;
  nth: number;
  /**
   * The picture this brick's part (the post's lessons of this teacher and length) was read in: the same on every brick of the part, another
   * the moment a lesson of the part is laid, put on the tray or taken away, or the post asks another number of lessons (a lesson moved in time does not change it). A write that lays a brick names it and is refused (409)
   * when it is not the part's now, so that two administrators who read the same picture do not both lay its last brick. The key to keep
   * a brick by on the page is `partKey` and `nth` together: two lengths of one post have the same `nth`.
   */
  partKey: string;
  /**
   * A lesson on the tray is a brick, namely itself (samordnarens beslut, g473 L-3): laying it moves the lesson back, and no new lesson is made.
   * The id of that lesson, or null for a brick that is no lesson yet. The parked lessons the tray names are those of the post's own kind
   * (the same class, subject, teacher and length) and no more than the part has lessons left: any other stays on the parking of the page.
   */
  lessonId: string | null;
  studentGroupId: string;
  subjectId: string;
  /** Whose lesson: the huvudlärare, or a share's teacher; null for a lesson nobody teaches. */
  teacherId: string | null;
  /** The medlärare, who is in the room for every lesson of the post: a question about where the brick can stand (E3's brick) asks for it. */
  coTeacherId: string | null;
  minutes: number;
  /** The weeks the post runs, which the lesson inherits. */
  recurrence: LessonRecurrence;
  startDate: string | null;
  endDate: string | null;
  /** A post in a parallel block is laid with its block: the members share this id. */
  blockId: string | null;
  /** Why the brick cannot be laid on its own, or null. */
  cannotPlace: 'BLOCK' | 'NO_TEACHER' | null;
  /**
   * How many times the server judges free for the brick, the hardest bricks first (E3's question). Null until the question exists: the
   * order of the tray is then the longest lessons first.
   */
  possibleTimes: number | null;
}

export interface BoardTrayResponse {
  academicYearId: string;
  /** The bricks of the class asked for, or of the year; the longest lessons first, in a fixed order. */
  bricks: TrayBrick[];
  /** The year's, whichever class the bricks are of: the head's number ("771 av 809 lektioner lagda"). */
  tally: {
    /** The lessons the year's posts ask for. */
    lessons: number;
    /** Answered by a lesson that stands on the grundschema, locked or free. */
    laid: number;
    /** Answered by a förläggning, which Generera writes (E4b writes it by hand). */
    placedByRow: number;
    /** Still to lay: the bricks. */
    left: number;
  };
  /** For each class with a post, the bricks it has left: the number beside the class in the picker. */
  groups: Array<{ studentGroupId: string; left: number }>;
}

/** Ids sort by their characters, whatever the locale. */
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const minutesOfTime = (time: Date): number => time.getUTCHours() * 60 + time.getUTCMinutes();

/** The problem `code` of a brick that cannot be laid on its own (a post in a block is laid with the block; a lesson nobody teaches is given a teacher first). */
export const BOARD_BRICK_CANNOT_BE_LAID = 'BOARD_BRICK_CANNOT_BE_LAID';

/** What laying a brick answers: the lesson it made (or the parked lesson it moved back), and whether it stands without a room. */
export interface LayBrickResult {
  lesson: CreateMasterLessonResult | UpdateMasterLessonResult;
  /** "Utan sal": the lesson is laid, locked, and has no room. */
  noRoom: boolean;
}

const clockOf = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

@Injectable()
export class BoardTrayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly masters: MasterLessonsService,
  ) {}

  /** The year's tray, every administrator's read, with the bricks of one class when `groupId` is given. */
  async trayOfYear(academicYearId: string, groupId: string | undefined, user: AuthenticatedUser): Promise<BoardTrayResponse> {
    return this.prisma.withRls(user, (tx) => this.trayIn(tx, academicYearId, groupId));
  }

  /**
   * LAY A BRICK (E4): the part's brick becomes a locked lesson of the post, or the parked lesson that is the brick is moved back and locked.
   *
   * One transaction, and the write is made on top of the picture the reader read: the part is read again under the post's lock, and a request
   * whose `partKey` is not the part's now is refused with 409 REQUIREMENT_PLACEMENTS_STALE (the code the week of förläggningar answers the same
   * way) and nothing is written, so that two administrators who read the same brick do not both lay it. The locks are taken in the order every
   * writer of the grundschema takes them: the mode and the year first, then the post.
   *
   * The lesson is the school's (handgjord) and locked, so Generera keeps it and counts it for the post. It is laid through the hand edit's own
   * write (createIn and updateIn), so it is judged as every other hand edit is (the one judge), logged, announced and warned about as one.
   *
   * DIREKT (P5, beslut 8; g490 M-5). A parked lesson laid back moves its calendar rows as any drag does (parking leaves them standing), and it asks the school's
   * question through the write it is made with: updateIn is MasterLessonsService.update, which calls requireDirectReachAnswered after propagateTemplateChange,
   * in this transaction, with propagatedLessons + removedCalendarLessons, so 409 DIRECT_REACH_UNANSWERED rolls the whole lay back. A brick that is no lesson yet
   * (createIn) reaches nobody: its calendar rows come with the next generation of the calendar. A second call here, with the same number in the same
   * transaction, could never answer differently, so there is none; probe-direkt-fragan.ts (i) holds it against a real database, and a lay that left the
   * hand edit's write would have to ask the question itself.
   */
  async lay(dto: LayBrickDto, user: AuthenticatedUser): Promise<LayBrickResult> {
    return this.prisma.withRls(user, async (tx) => {
      const year = await tx.academicYear.findUnique({ where: { id: dto.academicYearId }, select: { id: true } });
      if (!year) throw new NotFoundException('Läsåret finns inte.');
      const post = await tx.teachingRequirement.findUnique({ where: { id: dto.postId }, select: { academicYearId: true } });
      if (!post || post.academicYearId !== dto.academicYearId) throw new NotFoundException('Timplansposten finns inte i läsåret.');
      await enterGrundschemaWrite(tx, requireSchoolId(user));
      await lockYearForGrundschemaEdit(tx, dto.academicYearId);
      await lockPostForShares(tx, dto.postId);

      const bricks = (await this.trayIn(tx, dto.academicYearId, undefined)).bricks.filter(
        (brick) => brick.postId === dto.postId && brick.minutes === dto.minutes && brick.teacherId === (dto.teacherId ?? null),
      );
      const brick = bricks[0];
      if (!brick || brick.partKey !== dto.partKey) throw staleConflict(dto.postId);
      // Every brick of the part is a lesson on the tray (a brick is that lesson, namely itself): a request that names none of them asks for a new
      // lesson beside the parked one, which would stay on the tray while the post counts the new one. The picture the request read is not the part's
      // way of being laid now; it names the lesson (`lessonId` of the brick) or it is stale.
      if (dto.lessonId === undefined && bricks.every((entry) => entry.lessonId !== null)) throw staleConflict(dto.postId);
      if (brick.cannotPlace !== null) {
        throw new ConflictException({
          message:
            brick.cannotPlace === 'BLOCK'
              ? 'Lektionen ligger i ett parallellt block och läggs med blocket.'
              : 'Lektionen har ingen lärare och kan inte läggas förrän posten har en.',
          code: BOARD_BRICK_CANNOT_BE_LAID,
          params: { requirementId: dto.postId, reason: brick.cannotPlace },
        });
      }
      return this.writeBrick(
        tx,
        brick,
        {
          academicYearId: dto.academicYearId,
          postId: dto.postId,
          dayOfWeek: dto.dayOfWeek,
          startTime: dto.startTime,
          roomId: dto.roomId ?? null,
          lessonId: dto.lessonId,
          exempt: dto.exempt,
          ownLessonIds: new Set(bricks.flatMap((entry) => (entry.lessonId === null ? [] : [entry.lessonId]))),
        },
        user,
      );
    });
  }

  /**
   * THE WRITE OF A LAID BRICK, which lay and the fill's Ta in (board-fill) share: the room the generator would not take is refused, and the brick becomes a
   * locked lesson through the hand edit's own write (updateIn for the lesson on the tray, createIn for a brick that is no lesson yet), so it is judged,
   * logged, announced and asked about in Direkt as every other hand edit is. The caller has taken the locks and read the brick under them.
   */
  async writeBrick(
    tx: PrismaClient,
    brick: TrayBrick,
    at: {
      academicYearId: string;
      postId: string;
      dayOfWeek: number;
      startTime: string;
      roomId: string | null;
      lessonId?: string;
      exempt?: LayBrickDto['exempt'];
      /** The lessons on the tray that are bricks of this part: the lesson named must be one of them. */
      ownLessonIds: ReadonlySet<string>;
    },
    user: AuthenticatedUser,
  ): Promise<LayBrickResult> {
    const roomId = at.roomId;
    // A room the generator would not put the lesson in is refused as such, and "Utan sal" (no room) is the way to lay the brick all the same.
    const refusedRoom = roomId === null ? null : await layRoomRefusal(tx, user, { academicYearId: at.academicYearId, studentGroupId: brick.studentGroupId, subjectId: brick.subjectId, roomId });
    if (refusedRoom !== null) {
      throw new ConflictException({
        message: 'Salen passar inte lektionen (platser, typ eller årskurser): välj en annan sal eller lägg den utan sal.',
        code: BOARD_ROOM_NOT_ALLOWED,
        params: { roomId: roomId!, reason: refusedRoom },
      });
    }
    const endTime = clockOf(Number(at.startTime.slice(0, 2)) * 60 + Number(at.startTime.slice(3, 5)) + brick.minutes);
    if (at.lessonId !== undefined) {
      // The brick that is a lesson on the tray: only one of the part's own (the tray names them, and no other), moved back where it was put.
      if (!at.ownLessonIds.has(at.lessonId)) throw staleConflict(at.postId);
      const lesson = await this.masters.updateIn(
        tx,
        at.lessonId,
        { isParked: false, dayOfWeek: at.dayOfWeek, startTime: at.startTime, endTime, roomId, isLocked: true, exempt: at.exempt },
        user,
      );
      return { lesson, noRoom: roomId === null };
    }
    const lesson = await this.masters.createIn(
      tx,
      {
        academicYearId: at.academicYearId,
        subjectId: brick.subjectId,
        studentGroupId: brick.studentGroupId,
        teacherId: brick.teacherId,
        coTeacherId: brick.coTeacherId,
        roomId,
        dayOfWeek: at.dayOfWeek,
        startTime: at.startTime,
        endTime,
        isLocked: true,
        recurrence: brick.recurrence,
        startDate: brick.startDate,
        endDate: brick.endDate,
        exempt: at.exempt,
      },
      user,
    );
    return { lesson, noRoom: roomId === null };
  }

  /** The year's tray read inside a transaction the caller holds (the fill's propose and apply read it under their own locks). */
  async trayIn(tx: PrismaClient, academicYearId: string, groupId: string | undefined): Promise<BoardTrayResponse> {
    const year = await tx.academicYear.findUnique({ where: { id: academicYearId }, select: { id: true } });
    if (!year) throw new NotFoundException('Läsåret finns inte.');
    const [posts, rows, lessons, aside, blocks] = await Promise.all([
      tx.teachingRequirement.findMany({ where: { academicYearId }, select: BOARD_POST_SELECT, orderBy: { id: 'asc' } }),
      tx.teachingRequirementPlacement.findMany({ where: { requirement: { academicYearId } }, select: VIEW_SELECT }),
      // Every lesson standing on the grundschema: the locked and the free (not a lesson on the tray, and not one Generera wrote from a
      // förläggning, which is that förläggning's row and is counted there).
      tx.masterLesson.findMany({ where: { academicYearId, isParked: false, fromPlacement: false }, select: BOARD_KEPT_SELECT }),
      // What stands aside from that count: the lessons on the tray (parkeringen: bricks themselves) and the lessons Generera wrote from a
      // förläggning (counted by their rows, unless the row has gone: g473 L-4). One read for the two.
      tx.masterLesson.findMany({
        where: { academicYearId, OR: [{ isParked: true, fromPlacement: false }, { isParked: false, fromPlacement: true }] },
        select: { ...BOARD_KEPT_SELECT, isParked: true, fromPlacement: true },
      }),
      // The blocks with a lesson placed: a placed lesson of a block answers one lesson of each member.
      loadBlocksOfYear(tx, academicYearId, { onlyPlaced: true }),
    ]);
    const { slotsOf } = countedPostsOf(posts, rows, lessons.map(keptForCountOf), blocks);
    // A lesson Generera wrote from a förläggning is answered by its row (or its block's lesson). When the row has been taken away the lesson stays
    // until the next Generera (preserved-lessons.ts), and then it answers a lesson itself: the ones no slot of the post's class and subject
    // accounts for, time by time, are counted as standing lessons.
    const slotLeft = new Map<string, number>();
    for (const post of posts) {
      for (const slot of slotsOf.get(post.id) ?? []) {
        const key = `${post.studentGroupId}|${post.subjectId}|${slot.dayOfWeek}|${slot.startMinutes}|${slot.minutes}`;
        slotLeft.set(key, (slotLeft.get(key) ?? 0) + 1);
      }
    }
    const orphans: Array<typeof aside[number] & { minutes: number }> = [];
    for (const written of aside.filter((lesson) => lesson.fromPlacement).map(keptForCountOf)) {
      const key = `${written.studentGroupId}|${written.subjectId}|${written.dayOfWeek}|${minutesOfTime(written.startTime)}|${written.minutes}`;
      const accounted = slotLeft.get(key) ?? 0;
      if (accounted > 0) slotLeft.set(key, accounted - 1);
      else orphans.push(written);
    }
    const covering: KeptForCount[] = [...lessons.map(keptForCountOf), ...orphans];
    const locksByPost = new Map(posts.map((post) => [post.id, coveringLocksOf(boardPostShape(post), covering)]));
    const views = posts.map((post) => boardPostOf(boardPostShape(post), locksByPost.get(post.id) ?? [], slotsOf.get(post.id) ?? [], ''));
    // The lessons on the tray, by their kind: a part takes at most as many of them as it has lessons left.
    const parked = aside.filter((lesson) => lesson.isParked).map(keptForCountOf).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const tally = { lessons: 0, laid: 0, placedByRow: 0, left: 0 };
    const leftOfGroup = new Map<string, number>();
    const bricks: TrayBrick[] = [];
    for (const view of views) {
      leftOfGroup.set(view.studentGroupId, leftOfGroup.get(view.studentGroupId) ?? 0);
      for (const part of view.parts) {
        tally.lessons += part.count;
        tally.laid += part.locked;
        tally.placedByRow += part.placed;
        tally.left += part.left;
        leftOfGroup.set(view.studentGroupId, (leftOfGroup.get(view.studentGroupId) ?? 0) + part.left);
        if (groupId !== undefined && view.studentGroupId !== groupId) continue;
        // Of the post's own kind, and one that answers the post when it stands: the weeks it runs enclose the post's (lockCoversDemand, as the count
        // reads a standing lesson). A parked lesson of every week beside a post of odd weeks is laid back as itself and answers nothing of the post,
        // so the post would show the same brick again after the lay.
        const shape = boardPostShape(posts.find((entry) => entry.id === view.id)!);
        const own = parked.filter(
          (lesson) =>
            lesson.studentGroupId === view.studentGroupId &&
            lesson.subjectId === view.subjectId &&
            lesson.teacherId === part.teacherId &&
            lesson.minutes === part.minutes &&
            lockCoversDemand(lesson, shape),
        );
        const taken = own.slice(0, part.left);
        const partKey = createHash('sha256')
          .update(JSON.stringify([view.id, part.teacherId, part.minutes, part.count, part.locked, part.placed, part.left, taken.map((lesson) => lesson.id)]))
          .digest('hex')
          .slice(0, 16);
        for (let nth = 1; nth <= part.left; nth += 1) {
          bricks.push({
            postId: view.id,
            nth,
            partKey,
            lessonId: taken[nth - 1]?.id ?? null,
            studentGroupId: view.studentGroupId,
            subjectId: view.subjectId,
            teacherId: part.teacherId,
            coTeacherId: view.coTeacherId,
            minutes: part.minutes,
            recurrence: view.recurrence,
            startDate: view.startDate,
            endDate: view.endDate,
            blockId: view.cannotPlace === 'BLOCK' ? (posts.find((post) => post.id === view.id)?.blockId ?? null) : null,
            cannotPlace: view.cannotPlace ?? part.cannotPlace,
            possibleTimes: null,
          });
        }
      }
    }
    // The longest lessons first, then in a fixed order, so that a brick keeps its place from one read to the next.
    bricks.sort((a, b) => b.minutes - a.minutes || order(a.postId, b.postId) || order(a.teacherId ?? '', b.teacherId ?? '') || a.nth - b.nth);
    return {
      academicYearId,
      bricks,
      tally,
      groups: [...leftOfGroup].map(([studentGroupId, left]) => ({ studentGroupId, left })).sort((a, b) => order(a.studentGroupId, b.studentGroupId)),
    };
  }
}

/** The 409 of a lay made on top of a part somebody has changed since: the week of förläggningars code, said for the post's bricks. */
function staleConflict(requirementId: string): ConflictException {
  return new ConflictException({
    message: 'Postens brickor har ändrats sedan du läste dem. Läs om dem och försök igen.',
    code: REQUIREMENT_PLACEMENTS_STALE,
    params: { requirementId },
  });
}
