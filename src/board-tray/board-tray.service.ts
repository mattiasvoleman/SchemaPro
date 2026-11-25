import { Injectable, NotFoundException } from '@nestjs/common';
import type { LessonRecurrence } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { boardPostOf, boardPostShape } from '../requirement-placements/placement-board';
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
  /** The timplanspost, and which of its lessons of this teacher and length this is (1..): a stable key for the brick. */
  postId: string;
  nth: number;
  studentGroupId: string;
  subjectId: string;
  /** Whose lesson: the huvudlärare, or a share's teacher; null for a lesson nobody teaches. */
  teacherId: string | null;
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

@Injectable()
export class BoardTrayService {
  constructor(private readonly prisma: PrismaService) {}

  /** The year's tray, every administrator's read, with the bricks of one class when `groupId` is given. */
  async trayOfYear(academicYearId: string, groupId: string | undefined, user: AuthenticatedUser): Promise<BoardTrayResponse> {
    return this.prisma.withRls(user, async (tx) => {
      const year = await tx.academicYear.findUnique({ where: { id: academicYearId }, select: { id: true } });
      if (!year) throw new NotFoundException('Läsåret finns inte.');
      const [posts, rows, lessons, blocks] = await Promise.all([
        tx.teachingRequirement.findMany({ where: { academicYearId }, select: BOARD_POST_SELECT, orderBy: { id: 'asc' } }),
        tx.teachingRequirementPlacement.findMany({ where: { requirement: { academicYearId } }, select: VIEW_SELECT }),
        // Every lesson standing on the grundschema: the locked and the free (not a lesson on the tray, and not one Generera wrote from a
        // förläggning, which is that förläggning's row and is counted there).
        tx.masterLesson.findMany({ where: { academicYearId, isParked: false, fromPlacement: false }, select: BOARD_KEPT_SELECT }),
        // The blocks with a lesson placed: a placed lesson of a block answers one lesson of each member.
        loadBlocksOfYear(tx, academicYearId, { onlyPlaced: true }),
      ]);
      const { slotsOf, locksByPost } = countedPostsOf(posts, rows, lessons.map(keptForCountOf), blocks);
      const views = posts.map((post) => boardPostOf(boardPostShape(post), locksByPost.get(post.id) ?? [], slotsOf.get(post.id) ?? [], ''));

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
          for (let nth = 1; nth <= part.left; nth += 1) {
            bricks.push({
              postId: view.id,
              nth,
              studentGroupId: view.studentGroupId,
              subjectId: view.subjectId,
              teacherId: part.teacherId,
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
      bricks.sort(
        (a, b) => b.minutes - a.minutes || a.postId.localeCompare(b.postId) || (a.teacherId ?? '').localeCompare(b.teacherId ?? '') || a.nth - b.nth,
      );
      return {
        academicYearId,
        bricks,
        tally,
        groups: [...leftOfGroup].map(([studentGroupId, left]) => ({ studentGroupId, left })).sort((a, b) => a.studentGroupId.localeCompare(b.studentGroupId)),
      };
    });
  }
}
