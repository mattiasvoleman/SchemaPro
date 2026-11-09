import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { LessonRecurrence, Prisma, PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { MasterLessonsService } from '../calendar/master-lessons.service';
import type { GradeNumbering } from '../common/grade-numbering';
import { requirementPlacementsConflict, rethrowPrismaError } from '../common/utils/prisma-errors';
import { requireSchoolId } from '../common/utils/request-context';
import { parseTimeString, toWallClock } from '../common/utils/time';
import { PrismaService } from '../database/prisma.service';
import { lockCoversDemand } from '../optimization/locked-coverage';
import { PRESERVED_FROM_REGENERATION } from '../optimization/preserved-lessons';
import { lockYearForGrundschemaEdit } from '../optimization/regeneration-lock';
import { rostersOfYear } from '../year-rollover/projected-rosters';
import type { ReplacePlacementsDto } from './dto/requirement-placements.dto';
import { placedLessonsOf, placementFitOf, type PlacementPost } from './placement-fit';
import {
  clockText,
  judgePlacements,
  type JudgedPlacement,
  type PlacementParams,
  type PlacementRefusalReason,
  type PlacementVerdict,
} from './placement-judge';
import { placementRefusedConflict } from './placement-refusal';

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
  roomId: string;
  roomName: string;
  recurrence: LessonRecurrence;
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
}

/** Where a lesson stands, as a request states it or a stored row has it. */
export interface PlacementSlot {
  dayOfWeek: number;
  startMinutes: number;
  minutes: number;
  roomId: string;
  recurrence: LessonRecurrence;
}

const VIEW_SELECT = {
  id: true,
  requirementId: true,
  dayOfWeek: true,
  startTime: true,
  minutes: true,
  roomId: true,
  recurrence: true,
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
  _count: { select: { shares: true } },
  academicYear: { select: { isActive: true, predecessorId: true, gradeNumbering: true } },
} as const;

type PostRow = Prisma.TeachingRequirementGetPayload<{ select: typeof POST_SELECT }>;

type StoredView = {
  id: string;
  requirementId: string;
  dayOfWeek: number;
  startTime: Date;
  minutes: number;
  roomId: string;
  recurrence: LessonRecurrence;
  room: { name: string };
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
    roomName: row.room.name,
    recurrence: row.recurrence,
  };
}

const slotOf = (row: StoredView): PlacementSlot => ({
  dayOfWeek: row.dayOfWeek,
  startMinutes: minutesOfClock(row.startTime),
  minutes: row.minutes,
  roomId: row.roomId,
  recurrence: row.recurrence,
});

/**
 * Förlagda poster, the gateway's side: a timplanspost's förläggningar read,
 * judged and replaced (see placement-judge.ts for what a row is held to, and
 * placement-fit.ts for what makes a set of rows fit a post).
 *
 * The rows are the post's. The class, the subject and the teachers are read
 * from the post at every judgment, so a teacher changed on the post is
 * answered at the next view or Generera, not refused at the change.
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
      const verdicts = await this.judge(tx, user, post, rows.map(slotOf));
      return { placements: rows.map(viewOf), verdicts };
    });
  }

  /**
   * Replaces the post's förläggningar with the request's list (empty removes
   * them). Refused with 409, and nothing written, for the first of: rows that
   * do not fit the post (REQUIREMENT_PLACEMENTS_DO_NOT_FIT, with the rule),
   * and the first row the week does not hold (REQUIREMENT_PLACEMENT_REFUSED,
   * with its index in the request, the reason and what it clashes with).
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
          roomId: row.roomId,
          recurrence: row.recurrence,
        }));
        await this.assertRoomsExist(tx, wanted);

        const fit = placementFitOf(placementPostOf(post), wanted);
        if (fit !== null) throw requirementPlacementsConflict(fit);

        const verdicts = await this.judge(tx, user, post, wanted);
        const refused = verdicts.find((verdict) => !verdict.ok);
        if (refused) throw placementRefusedConflict(refused);

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
            })),
          });
        }
        const written = await tx.teachingRequirementPlacement.findMany({
          where: { requirementId: id },
          select: VIEW_SELECT,
          orderBy: [...VIEW_ORDER],
        });
        return { placements: written.map(viewOf), verdicts: written.map((_, index) => ({ index, ok: true })) };
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
    const ids = [...new Set(slots.map((slot) => slot.roomId))];
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
   * activation would place, and a year two steps ahead is refused, R6).
   */
  private async judge(
    tx: PrismaClient,
    user: AuthenticatedUser,
    post: PostRow,
    slots: readonly PlacementSlot[],
  ): Promise<PlacementVerdict[]> {
    if (slots.length === 0) return [];
    const schoolId = requireSchoolId(user);
    const basis = await rostersOfYear(tx, user, post.academicYearId, {
      isActive: post.academicYear.isActive,
      predecessorId: post.academicYear.predecessorId,
    });
    const [beside, lockedMinutes] = await Promise.all([this.besideOf(tx, post), this.lockedMinutesOf(tx, post)]);
    return judgePlacements(tx, this.masters, {
      academicYearId: post.academicYearId,
      schoolId,
      gradeNumbering: post.academicYear.gradeNumbering as GradeNumbering,
      basis,
      rows: slots.map((slot) => judgedOf(post, slot)),
      beside,
      demand: new Map([
        [post.id, { post, lockedMinutes, placed: placedLessonsOf(post, slots) }],
      ]),
    });
  }

  /** The year's other posts' förläggningar, as they stand. */
  private async besideOf(tx: PrismaClient, post: { id: string; academicYearId: string }): Promise<JudgedPlacement[]> {
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
        requirement: {
          select: { studentGroupId: true, subjectId: true, teacherId: true, coTeacherId: true, startDate: true, endDate: true },
        },
      },
      orderBy: [{ requirementId: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      requirementId: row.requirementId,
      ...row.requirement,
      dayOfWeek: row.dayOfWeek,
      startMinutes: minutesOfClock(row.startTime),
      minutes: row.minutes,
      roomId: row.roomId,
      recurrence: row.recurrence,
    }));
  }

  /**
   * The minutes of the lessons the grundschema already answers the post with,
   * the way Generera counts them (lockCoversDemand over the lessons it keeps).
   * A lesson Generera wrote from a förläggning is not among them unless
   * somebody has made it a lesson Generera keeps; then it answers the post,
   * and the rows that place the same lesson are over the demand.
   */
  private async lockedMinutesOf(
    tx: PrismaClient,
    post: { academicYearId: string; studentGroupId: string; subjectId: string; recurrence: LessonRecurrence; startDate: Date | null; endDate: Date | null },
  ): Promise<number[]> {
    const lessons = await tx.masterLesson.findMany({
      where: {
        academicYearId: post.academicYearId,
        studentGroupId: post.studentGroupId,
        subjectId: post.subjectId,
        isParked: false,
        OR: PRESERVED_FROM_REGENERATION,
      },
      select: { startTime: true, endTime: true, recurrence: true, startDate: true, endDate: true },
    });
    return lessons
      .filter((lesson) => lockCoversDemand(lesson, post))
      .map((lesson) => minutesOfClock(lesson.endTime) - minutesOfClock(lesson.startTime));
  }
}

/** What the fit reads of a post. */
function placementPostOf(post: {
  lessonsPerWeek: number;
  minutesPerLesson: number;
  lessonLengths: number[];
  recurrence: LessonRecurrence;
  blockId: string | null;
  _count: { shares: number };
}): PlacementPost {
  return {
    lessonsPerWeek: post.lessonsPerWeek,
    minutesPerLesson: post.minutesPerLesson,
    lessonLengths: post.lessonLengths,
    recurrence: post.recurrence,
    blockId: post.blockId,
    shareCount: post._count.shares,
  };
}

/** A row of the post as the judge reads it: the slot is the row's, the class, subject, teachers and window the post's. */
function judgedOf(
  post: {
    id: string;
    studentGroupId: string;
    subjectId: string;
    teacherId: string | null;
    coTeacherId: string | null;
    startDate: Date | null;
    endDate: Date | null;
  },
  slot: PlacementSlot,
): JudgedPlacement {
  return {
    id: null,
    requirementId: post.id,
    studentGroupId: post.studentGroupId,
    subjectId: post.subjectId,
    teacherId: post.teacherId,
    coTeacherId: post.coTeacherId,
    dayOfWeek: slot.dayOfWeek,
    startMinutes: slot.startMinutes,
    minutes: slot.minutes,
    roomId: slot.roomId,
    recurrence: slot.recurrence,
    startDate: post.startDate,
    endDate: post.endDate,
  };
}
