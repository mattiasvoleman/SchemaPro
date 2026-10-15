import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { weeksCanOverlap } from './lesson-recurrence';
import type { LessonRecurrence } from '@prisma/client';
import { RealtimeService } from '../realtime/realtime.service';
import { requireSchoolId } from '../common/utils/request-context';
import { enterGrundschemaWrite } from '../publication/publish-mode';
import { propagateTemplateChange, reconcilableLessons } from './propagate-template';
import { NotificationsService } from '../notifications/notifications.service';
import { parseTimeString } from '../common/utils/time';
import type { CreateMasterLessonDto } from './dto/create-master-lesson.dto';
import type { UpdateMasterLessonDto } from './dto/update-master-lesson.dto';
import type { LockBlockDto, MoveBlockCardDto } from './dto/block-card.dto';
import { lessonQualificationFindings } from '../staffing/staffing-enforcement';
import {
  settleFindings,
  type StaffingRole,
  type StaffingWarning,
} from '../staffing/staffing-checks';
import { constraintsOfYear } from '../staffing/duty-slot-year';
import {
  countHomePupils,
  readHomeClassesOf,
  readHomePupils,
  rostersOfYear,
  SETTLED_CURRENT,
  type RosterBasis,
} from '../year-rollover/projected-rosters';
import {
  distributionBreaches,
  distributionWarning,
  effectiveDistribution,
  hasDistributionRule,
  type DistributionWarning,
} from '../common/subject-distribution';
import { requirementName } from '../optimization/optimization-proxy.service';
import { BLOCK_SPLIT, blockMoveOf, readLessonBlock, sameSlot, type BlockSlot } from './block-lessons';

export interface MasterLessonConflict {
  kind: 'TEACHER' | 'ROOM' | 'GROUP' | 'AVAILABILITY';
  message: string;
  /** The other master lesson involved, when applicable. */
  masterLessonId?: string;
}

/**
 * Minutes the PUPILS of a lesson are occupied outside it: ombyte before
 * idrotten, dusch and ombyte after. Written on the TeachingRequirement, so it is
 * said once per (class, subject) and read here per lesson — over every class
 * attending that lesson, widest wins, which `widestBufferOf` argues.
 *
 * It blocks the children and nothing else. The teacher and the room arms of the
 * clash check keep the exact half-open test — see findConflicts, which states
 * why.
 */
interface PupilBuffer {
  minutesBefore: number;
  minutesAfter: number;
}

/** The timplanspost behind a lesson, with its subject's default and both names. */
interface DistributionPost {
  ownDistribution: boolean;
  maxLessonsPerDay: number | null;
  minDaysBetween: number | null;
  subjectMaxLessonsPerDay: number | null;
  subjectMinDaysBetween: number | null;
  subjectName: string;
  groupName: string | null;
}

/** What a lesson nobody wrote a number for occupies outside itself: nothing. */
const NO_BUFFER: PupilBuffer = { minutesBefore: 0, minutesAfter: 0 };

export interface MasterLessonResult {
  id: string;
  academicYearId: string;
  subjectId: string;
  studentGroupId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  roomId: string | null;
  teacherId: string | null;
  coTeacherId: string | null;
  isLocked: boolean;
  /** Set aside on the tray; occupies nothing until put back. */
  isParked: boolean;
  recurrence: LessonRecurrence;
  /** YYYY-MM-DD, or null for "the academic year's own boundary". */
  startDate: string | null;
  endDate: string | null;
  extraGroupIds: string[];
  studentIds: string[];
}

/**
 * A hand edit that moved one member of a parallel block away from the others:
 * the block is split, and the lesson is the school's (block-lessons.ts).
 */
export interface BlockSplitWarning {
  code: typeof BLOCK_SPLIT;
  params: { block: string };
}

/**
 * What a hand edit is told beside the saved lesson: the staffing policy's WARN
 * about a teacher it put on the lesson, the ämnesfördelning the timplanspost
 * is held to when the edit breaks it, and a parallel block the move split.
 * Each is a code from the engine catalogue and its params, rendered by the
 * page; none is a refusal.
 */
export type LessonWarning = StaffingWarning | DistributionWarning | BlockSplitWarning;

export interface CreateMasterLessonResult extends MasterLessonResult {
  /** The ämnesfördelning the new lesson breaks; empty when it breaks none. */
  warnings: LessonWarning[];
}

export interface UpdateMasterLessonResult extends MasterLessonResult {
  /** Future calendar lessons that were moved along with the template. */
  propagatedLessons: number;
  /**
   * Future, attendance-free calendar lessons dropped because the template's
   * new weeks no longer cover the date they sat on.
   */
  removedCalendarLessons: number;
  /**
   * What the staffing policy's WARN mode says about a teacher this PATCH put on
   * the lesson (STAFF_TEACHER_NOT_QUALIFIED only — see update()), and the
   * ämnesfördelning the moved lesson breaks (DISTRIBUTION_*). Empty when
   * nothing was found.
   */
  warnings: LessonWarning[];
}

/** A block card moved as one (moveBlockCard): every member, as written. */
export interface MoveBlockCardResult {
  lessons: MasterLessonResult[];
  /** Future calendar lessons moved along with the members, summed. */
  propagatedLessons: number;
  removedCalendarLessons: number;
  /** The ämnesfördelning a member breaks on its new day; never a refusal. */
  warnings: LessonWarning[];
}

/** A block locked or unlocked (lockBlock): the lessons whose lock changed. */
export interface LockBlockResult {
  blockId: string;
  isLocked: boolean;
  lessonIds: string[];
  /** The block's lessons on the tray, which no lock reaches: the generation refuses a block while they are there. */
  parked: number;
}

/** The problem `code` of a card whose lessons no longer stand together. */
export const BLOCK_CARD_STALE = 'BLOCK_CARD_STALE';
/** The problem `code` of lessons that are not one block's card. */
export const NOT_A_BLOCK_CARD = 'NOT_A_BLOCK_CARD';

/** A lesson the clash scan holds a candidate against: one of its day, or one moved with it. */
interface DayLesson {
  id: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  studentGroupId: string;
  subjectId: string;
  startTime: Date;
  endTime: Date;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
  subject: { name: string };
  extraGroups: Array<{ studentGroupId: string }>;
  participants: Array<{ studentId: string }>;
}

export interface DeleteMasterLessonResult {
  id: string;
  /** Future, attendance-free calendar lessons that were removed with it. */
  removedCalendarLessons: number;
}

/**
 * Manual adjustments to the master timetable after (or instead of) AI
 * generation. Every change is validated against the rest of the timetable so
 * an admin cannot introduce a double-booking by hand:
 *
 * - the teacher must not teach another lesson in the same slot,
 * - the room must not host another lesson in the same slot,
 * - the student group must not have another lesson in the same slot,
 * - weekly `UNAVAILABLE` constraints for the teacher/room/group must not
 *   cover the slot.
 *
 * On conflict the request fails with 409 and a machine-readable conflict
 * list so the UI can show exactly what collided.
 *
 * Every mutation is recorded in `ScheduleChangeLogs` (append-only audit
 * trail) with a before/after snapshot.
 */
@Injectable()
export class MasterLessonsService {
  private readonly logger = new Logger(MasterLessonsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------

  /**
   * The academic year is looked up under RLS because `schoolId` is taken from
   * it; the subject, group, teachers, room, extra classes and participants are
   * used as they arrived. That is deliberate — each of them is named through a
   * composite (id, schoolId) foreign key, so a lesson carrying this school's
   * `schoolId` cannot name another school's row (20260822130000). RLS is no
   * help here: PostgreSQL runs referential-integrity checks as the referenced
   * table's owner with row security off, so a foreign key to a row the caller
   * cannot even SELECT still validates.
   *
   * A refused reference surfaces as P2003, which the exception filter renders
   * as 400 "references a resource that does not exist" — which is what a
   * foreign id is, from inside the caller's tenant.
   */
  async create(
    dto: CreateMasterLessonDto,
    user: AuthenticatedUser,
  ): Promise<CreateMasterLessonResult> {
    return this.prisma.withRls(user, async (tx) => {
      const mode = await enterGrundschemaWrite(tx, requireSchoolId(user));
      const year = await tx.academicYear.findUnique({
        where: { id: dto.academicYearId },
        select: { id: true, schoolId: true, isActive: true, predecessorId: true },
      });
      if (!year) {
        throw new NotFoundException('Academic year not found.');
      }
      // Whose classes these are (projected-rosters.ts), from the flags just
      // read: nothing more is asked of the active year, and a rolled year
      // not yet activated judges pupil clashes on the pupils its activation
      // would place — so next year's grundschema can be laid by hand in
      // spring. A year two steps ahead is refused there (R6).
      const rosters = await rostersOfYear(tx, user, year.id, year);

      const candidate = {
        dayOfWeek: dto.dayOfWeek,
        startMinutes: toMinutes(parseTimeString(dto.startTime)),
        endMinutes: toMinutes(parseTimeString(dto.endTime)),
        teacherId: dto.teacherId ?? null,
        // Both teachers, or a create naming a co-teacher is checked against
        // half the room: _detectConflicts reads candidate.coTeacherId (:476)
        // and would have found undefined on every create.
        coTeacherId: dto.coTeacherId ?? null,
        roomId: dto.roomId ?? null,
        // Deduped before both the conflict scan and the nested create read it.
        // MasterLessonGroups is unique per (lesson, group), so a group named
        // twice fails that insert with a P2002, which HttpExceptionFilter
        // answers with a 409 "same unique identifier already exists" — a
        // harmless payload refused with a conflict that does not exist.
        extraGroupIds: [...new Set(dto.extraGroupIds ?? [])].filter(
          (groupId) => groupId !== dto.studentGroupId,
        ),
        studentIds: dto.studentIds ?? [],
        recurrence: dto.recurrence ?? 'ALL_WEEKS',
        startDate: parseDateOrNull(dto.startDate),
        endDate: parseDateOrNull(dto.endDate),
      };
      if (candidate.startMinutes >= candidate.endMinutes) {
        throw new BadRequestException('startTime must be before endTime.');
      }

      const conflicts = await this.findConflicts(
        tx,
        rosters,
        {
          id: null,
          academicYearId: dto.academicYearId,
          studentGroupId: dto.studentGroupId,
          subjectId: dto.subjectId,
        },
        candidate,
      );
      if (conflicts.length > 0) {
        const unique = [...new Set(conflicts.map((conflict) => conflict.message))];
        throw new ConflictException(unique.join(' '));
      }

      const created = await tx.masterLesson.create({
        data: {
          schoolId: year.schoolId,
          academicYearId: dto.academicYearId,
          subjectId: dto.subjectId,
          studentGroupId: dto.studentGroupId,
          teacherId: dto.teacherId ?? null,
          coTeacherId: dto.coTeacherId ?? null,
          roomId: dto.roomId ?? null,
          dayOfWeek: dto.dayOfWeek,
          startTime: parseTimeString(dto.startTime),
          endTime: parseTimeString(dto.endTime),
          isLocked: dto.isLocked ?? false,
          // Said out loud although the column already defaults to false. This
          // is the hand-placed lesson — the one regeneration must never take
          // for its own — and the claim reads here, where an admin's intent
          // enters the system, rather than in a schema default a later
          // migration is free to move. Not taken from the DTO on purpose
          // either: ownership follows from which code path ran, and no request
          // may declare itself the optimizer.
          isGenerated: false,
          recurrence: dto.recurrence ?? 'ALL_WEEKS',
          startDate: parseDateOrNull(dto.startDate),
          endDate: parseDateOrNull(dto.endDate),
          extraGroups: {
            create: candidate.extraGroupIds.map((studentGroupId) => ({
              schoolId: year.schoolId,
              studentGroupId,
            })),
          },
          participants: {
            create: [...new Set(candidate.studentIds)].map((studentId) => ({
              schoolId: year.schoolId,
              studentId,
            })),
          },
        },
        select: LESSON_SELECT,
      });

      const result = toResult(created);
      await this.writeChangeLog(tx, {
        schoolId: year.schoolId,
        academicYearId: dto.academicYearId,
        masterLessonId: created.id,
        actorId: user.userId ?? null,
        action: 'CREATE',
        before: null,
        after: result,
      });

      // Read after the write, from the week as it now stands: the new lesson
      // is in it, and a breach it is no part of is not this edit's to report.
      const warnings = await this.distributionWarnings(tx, created);

      this.logger.log(`Master lesson created manually [lesson=${created.id}]`);
      this.announce(year.schoolId, mode);
      return { ...result, warnings };
    });
  }

  // ---------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------

  async update(
    id: string,
    dto: UpdateMasterLessonDto,
    user: AuthenticatedUser,
  ): Promise<UpdateMasterLessonResult> {
    return this.prisma.withRls(user, async (tx) => {
      const mode = await enterGrundschemaWrite(tx, requireSchoolId(user));
      const lesson = await tx.masterLesson.findUnique({
        where: { id },
        select: {
          ...LESSON_SELECT,
          school: {
            select: {
              id: true,
              timezone: true,
              // Whether the lesson's year is one R1 or R2 settles (the active
              // year, or one outside every chain), counted inside the
              // school's statement. A selected `academicYear` relation would
              // be a statement of its own; this way a lesson dragged in the
              // active year makes one statement fewer than when the refusal
              // scanned every läsår, and none more.
              _count: {
                select: {
                  academicYears: { where: { AND: [SETTLED_CURRENT, { masterLessons: { some: { id } } }] } },
                },
              },
            },
          },
        },
      });
      if (!lesson) {
        throw new NotFoundException('Master lesson not found.');
      }
      // As on create. The same basis goes to the behörighet span below, so the
      // clash check and the warning read one set of pupils.
      const rosters = await rostersOfYear(tx, user, lesson.academicYearId, {
        settledCurrent: lesson.school._count.academicYears > 0,
      });

      // Merge the patch onto the current slot.
      const candidate = {
        dayOfWeek: dto.dayOfWeek ?? lesson.dayOfWeek,
        startMinutes:
          dto.startTime !== undefined
            ? toMinutes(parseTimeString(dto.startTime))
            : toMinutes(lesson.startTime),
        endMinutes:
          dto.endTime !== undefined
            ? toMinutes(parseTimeString(dto.endTime))
            : toMinutes(lesson.endTime),
        teacherId: dto.teacherId !== undefined ? dto.teacherId : lesson.teacherId,
        coTeacherId:
          dto.coTeacherId !== undefined ? dto.coTeacherId : lesson.coTeacherId,
        roomId: dto.roomId !== undefined ? dto.roomId : lesson.roomId,
        // Deduped for the same unique constraint as on create. Here the 409
        // came only after deleteMany had cleared the rows inside the same
        // transaction: rolled back, so nothing was lost, but the refusal
        // arrived after the work it refused had already begun.
        extraGroupIds: [
          ...new Set(
            dto.extraGroupIds !== undefined
              ? dto.extraGroupIds
              : lesson.extraGroups.map((entry) => entry.studentGroupId),
          ),
        ].filter((groupId) => groupId !== lesson.studentGroupId),
        studentIds:
          dto.studentIds !== undefined
            ? dto.studentIds
            : lesson.participants.map((entry) => entry.studentId),
        // A field the caller left out keeps the lesson's current value, so a
        // move never silently widens the weeks it occupies.
        recurrence: dto.recurrence ?? lesson.recurrence,
        startDate:
          dto.startDate !== undefined ? parseDateOrNull(dto.startDate) : lesson.startDate,
        endDate:
          dto.endDate !== undefined ? parseDateOrNull(dto.endDate) : lesson.endDate,
      };
      if (candidate.startMinutes >= candidate.endMinutes) {
        throw new BadRequestException('startTime must be before endTime.');
      }

      // A lesson being set aside occupies nothing, so there is nothing for it
      // to clash with — the whole point of the tray is that A can leave slot X
      // while B is still there. Everything else, including putting a parked
      // lesson back, is a placement and is checked like one.
      const parking = dto.isParked === true;
      const conflicts = parking
        ? []
        : await this.findConflicts(
            tx,
            rosters,
            {
              id: lesson.id,
              academicYearId: lesson.academicYearId,
              studentGroupId: lesson.studentGroupId,
              // No PATCH moves a lesson to another subject, so the stored one is
              // the one whose requirement carries the buffer.
              subjectId: lesson.subjectId,
            },
            candidate,
          );
      if (conflicts.length > 0) {
        // The exception filter forwards `message` as the problem detail, so
        // the conflict list is folded into it for the UI to display.
        const unique = [...new Set(conflicts.map((conflict) => conflict.message))];
        throw new ConflictException(unique.join(' '));
      }

      /*
       * Behörighet for whoever this PATCH puts on the lesson — the timplan's
       * question, asked of the lesson's own attendance (its classes and named
       * pupils) over the läsår. Only behörighet: the load report is computed
       * from the timplan, not from lessons, so a lesson has no load to be over.
       * Asked of a teacher the PATCH names anew; keeping the one it had is not
       * an assignment. REFUSE is a 409 here, before anything is written.
       */
      const assignees: { userId: string; role: StaffingRole }[] = [];
      if (dto.teacherId && dto.teacherId !== lesson.teacherId) {
        assignees.push({ userId: dto.teacherId, role: 'TEACHER' });
      }
      if (dto.coTeacherId && dto.coTeacherId !== lesson.coTeacherId) {
        assignees.push({ userId: dto.coTeacherId, role: 'CO_TEACHER' });
      }
      const warnings: LessonWarning[] =
        assignees.length > 0
          ? settleFindings(
              await lessonQualificationFindings(tx, {
                schoolId: lesson.school.id,
                academicYearId: lesson.academicYearId,
                subjectId: lesson.subjectId,
                groupIds: [lesson.studentGroupId, ...candidate.extraGroupIds],
                studentIds: candidate.studentIds,
                assignees,
                rosters,
              }),
            )
          : [];

      /*
       * A PARALLEL BLOCK'S LESSON MOVED BY HAND (block-lessons.ts, blockMoveOf).
       * Out of its card — other members of its block stood beside it — it
       * splits the block: the lesson is the school's from now on, so the next
       * generation refuses the block as partly locked instead of undoing the
       * move unasked, and the save says so. From no card onto a slot where
       * members stand, it joins their card and takes the card's owner, and its
       * lock unless this PATCH changes the lesson's — an undo of a split, or
       * "flytta tillbaka med blocket", puts the block back as the generation
       * will place it. A move from no card to no card is any move.
       *
       * Asked of a move that leaves the lesson placed — another slot or other
       * weeks, or put back from the tray — and of weeks written as they stood,
       * which the lesson dialog does on every save and an undo on every
       * restore: one statement. A lesson set aside, or edited while it stays
       * on the tray, occupies nothing and is no move of a block's.
       */
      const placedAfter = dto.isParked === false || (!lesson.isParked && dto.isParked !== true);
      const landing: BlockSlot = {
        dayOfWeek: candidate.dayOfWeek,
        startTime: clockOf(candidate.startMinutes),
        endTime: clockOf(candidate.endMinutes),
        recurrence: candidate.recurrence,
        startDate: toDateStringOrNull(candidate.startDate),
        endDate: toDateStringOrNull(candidate.endDate),
      };
      const origin: BlockSlot = {
        dayOfWeek: lesson.dayOfWeek,
        startTime: toHHMM(lesson.startTime),
        endTime: toHHMM(lesson.endTime),
        recurrence: lesson.recurrence,
        startDate: toDateStringOrNull(lesson.startDate),
        endDate: toDateStringOrNull(lesson.endDate),
      };
      const movesTheLesson = placedAfter && (lesson.isParked || !sameSlot(landing, origin));
      const writesWindow =
        dto.recurrence !== undefined || dto.startDate !== undefined || dto.endDate !== undefined;
      const block =
        movesTheLesson || (writesWindow && placedAfter) ? await readLessonBlock(tx, lesson) : null;
      const inBlock = block !== null && block.siblings.length > 0;
      const blockMove =
        inBlock && movesTheLesson ? blockMoveOf(block, lesson.isParked ? null : origin, landing) : null;
      // The weeks written as they stood, on a block's lesson that does not
      // move: the dialog's every save. Handing it to the school here would
      // leave its whole block refused as partly locked by a room change.
      const restatesWindow = inBlock && !movesTheLesson;
      if (block && blockMove?.kind === 'split') {
        warnings.push({ code: BLOCK_SPLIT, params: { block: block.name } });
      }

      const updated = await tx.masterLesson.update({
        where: { id },
        data: {
          dayOfWeek: candidate.dayOfWeek,
          ...(dto.isParked !== undefined ? { isParked: dto.isParked } : {}),
          ...(dto.startTime !== undefined
            ? { startTime: parseTimeString(dto.startTime) }
            : {}),
          ...(dto.endTime !== undefined
            ? { endTime: parseTimeString(dto.endTime) }
            : {}),
          ...(dto.roomId !== undefined ? { roomId: dto.roomId } : {}),
          ...(dto.teacherId !== undefined ? { teacherId: dto.teacherId } : {}),
          ...(dto.coTeacherId !== undefined ? { coTeacherId: dto.coTeacherId } : {}),
          ...(dto.isLocked !== undefined ? { isLocked: dto.isLocked } : {}),
          ...(dto.recurrence !== undefined ? { recurrence: dto.recurrence } : {}),
          ...(dto.startDate !== undefined
            ? { startDate: parseDateOrNull(dto.startDate) }
            : {}),
          ...(dto.endDate !== undefined
            ? { endDate: parseDateOrNull(dto.endDate) }
            : {}),
          /*
           * Writing a window hands the lesson to whoever wrote it.
           *
           * Regeneration replaces what the optimizer made and nobody has since
           * touched. A generated lesson now arrives carrying its requirement's
           * window, so the window by itself no longer says who put it there.
           * Without this line an administrator who narrows a generated lesson
           * to odd weeks, or to one term, leaves `isGenerated` true — and the
           * next regeneration deletes the very intent they just expressed,
           * without saying so.
           *
           * Only a window flips ownership, not every edit, and the difference
           * is what the engine can express. It has no notion of weeks at all,
           * so a window is unreproducible and preserving it is the only way not
           * to lose it. A moved time it can express perfectly well and simply
           * decided otherwise about — pinning that is what the lock is for, and
           * the lock is visible on the lesson. Flipping here on every edit would
           * make each nudge a second, invisible lock and leave the padlock
           * meaning nothing.
           */
          ...(writesWindow && !restatesWindow ? { isGenerated: false } : {}),
          // The block's say comes last: joining a card makes the lesson the
          // card's, whatever the window above said (the window is the card's
          // own, or the slot would not be the card's), and a split is the
          // school's.
          ...(blockMove?.kind === 'join'
            ? {
                isGenerated: blockMove.isGenerated,
                ...((dto.isLocked === undefined || dto.isLocked === lesson.isLocked) &&
                blockMove.isLocked !== null
                  ? { isLocked: blockMove.isLocked }
                  : {}),
              }
            : blockMove?.kind === 'split'
              ? { isGenerated: false }
              : {}),
          ...(dto.extraGroupIds !== undefined
            ? {
                extraGroups: {
                  deleteMany: {},
                  create: candidate.extraGroupIds.map((studentGroupId) => ({
                    schoolId: lesson.school.id,
                    studentGroupId,
                  })),
                },
              }
            : {}),
          ...(dto.studentIds !== undefined
            ? {
                participants: {
                  deleteMany: {},
                  create: [...new Set(candidate.studentIds)].map((studentId) => ({
                    schoolId: lesson.school.id,
                    studentId,
                  })),
                },
              }
            : {}),
        },
        select: LESSON_SELECT,
      });

      // In DRAFT the edit is a draft: the calendar keeps what was published
      // until a publish carries the change over (src/publication).
      const { moved: propagatedLessons, removed: removedCalendarLessons } =
        dto.propagate === false || mode === 'DRAFT'
          ? { moved: 0, removed: 0 }
          : await propagateTemplateChange(tx, lesson, updated, {
              timezone: lesson.school.timezone,
              schoolId: lesson.school.id,
            });

      // The ämnesfördelning, asked of the week as the PATCH leaves it. A
      // warning and never a 409: a school that puts two idrott lessons on one
      // Monday by hand has decided to, and the generator still keeps the rule
      // for every lesson it places (see common/subject-distribution.ts).
      // Asked only of an edit that can change which days the post's lessons
      // run on — another weekday, other weeks, back from the tray — so a
      // lesson nudged within its own day costs no statement for it.
      const movesTheWeek =
        candidate.dayOfWeek !== lesson.dayOfWeek ||
        dto.recurrence !== undefined ||
        dto.startDate !== undefined ||
        dto.endDate !== undefined ||
        (lesson.isParked && dto.isParked === false);
      if (movesTheWeek) {
        warnings.push(...(await this.distributionWarnings(tx, updated)));
      }

      const before = toResult(lesson);
      const after = toResult(updated);
      await this.writeChangeLog(tx, {
        schoolId: lesson.school.id,
        academicYearId: lesson.academicYearId,
        masterLessonId: lesson.id,
        actorId: user.userId ?? null,
        action: 'UPDATE',
        before,
        after,
      });

      this.logger.log(
        `Master lesson adjusted [lesson=${id}, propagated=${propagatedLessons}, removed=${removedCalendarLessons}]`,
      );
      this.announce(lesson.school.id, mode);

      // In-app schedule-change notice to affected classes once published
      // lessons actually moved — or disappeared, which the class needs to
      // hear about just as much.
      if (propagatedLessons > 0 || removedCalendarLessons > 0) {
        // The notice describes the lesson as it is after this update, so it
        // goes to the roster attending it after this update. Read off the
        // stored row, a class the same patch attached never heard about the
        // lessons it now has, and a class it detached was told about a slot
        // that is no longer theirs. The roster is the one reader's
        // (lesson-roster.ts): the classes, their teaching groups and the
        // pupils named on the lesson, as they are now.
        const recipients = await this.notifications.recipientsForLessons(tx, [
          { groupIds: [lesson.studentGroupId, ...after.extraGroupIds], participantIds: after.studentIds },
        ]);
        const subject = await tx.subject.findUnique({
          where: { id: lesson.subjectId },
          select: { name: true },
        });
        await this.notifications.notifyUsers(tx, {
          schoolId: lesson.school.id,
          userIds: recipients,
          type: 'SCHEDULE_CHANGED',
          meta: {
            subjectName: subject?.name ?? '',
            dayOfWeek: after.dayOfWeek,
            startTime: after.startTime,
            endTime: after.endTime,
          },
        });
      }

      return { ...after, propagatedLessons, removedCalendarLessons, warnings };
    });
  }

  // ---------------------------------------------------------------------
  // Block i schemat: a parallel block's card, moved and locked as one
  // ---------------------------------------------------------------------

  /**
   * Moves a block card — the lessons of a parallel block's members that stand
   * in one slot — to another slot, as ONE move.
   *
   * THE LESSONS MUST BE THE WHOLE CARD. One läsår and one block (by each
   * lesson's post, the key block-lessons.ts reads it by), one lesson per
   * member — else a 400 NOT_A_BLOCK_CARD — and every lesson of the block in
   * that slot, all placed, read under a row lock: else a 409
   * BLOCK_CARD_STALE, because a page that no longer shows what it was asked
   * about would move lessons it did not see, or leave one behind and split
   * the block unasked.
   *
   * JUDGED AS ONE MOVE by the PATCH's own clash check (findConflicts): each
   * member against the rest of the new day with the card's lessons left out
   * of where they stood, and against the members after it at the new slot, so
   * a clash among them is named once. Any clash refuses the whole card with
   * the PATCH's 409, each sentence after the member it is about.
   *
   * THE OWNER STAYS: the engine places a block's lessons together, so a card
   * it placed is still its own after a move it could have made, and the next
   * generation places the block again (block-lessons.ts). Only day and clock
   * are written; weeks, rooms, teachers and locks are each member's own. A
   * lesson of the block the card lands beside joins it and takes its owner.
   *
   * The UPDATE is held to the slot the card was read in, so a member moved by
   * someone else between the read and the write refuses the card as stale.
   * Then per member what the PATCH does after its write: the published
   * calendar, the ämnesfördelning on a new day, the change log, and one
   * notice per member whose published lessons moved.
   */
  async moveBlockCard(dto: MoveBlockCardDto, user: AuthenticatedUser): Promise<MoveBlockCardResult> {
    const startTime = parseTimeString(dto.startTime);
    const endTime = parseTimeString(dto.endTime);
    if (toMinutes(startTime) >= toMinutes(endTime)) {
      throw new BadRequestException('startTime must be before endTime.');
    }
    return this.prisma.withRls(user, async (tx) => {
      const mode = await enterGrundschemaWrite(tx, requireSchoolId(user));
      // The card's rows held to COMMIT before they are read, so the room,
      // teacher and weeks propagated below are the ones written, not ones a
      // concurrent PATCH has since replaced. NO KEY UPDATE: calendar lessons
      // reference these rows, and FOR UPDATE would wait out every writer of
      // one (prisma.service.ts, Isolation).
      await tx.$queryRaw`
        SELECT 1 FROM "MasterLessons" WHERE "id" = ANY(${dto.lessonIds}::uuid[]) FOR NO KEY UPDATE`;
      const lessons = await tx.masterLesson.findMany({
        where: { id: { in: dto.lessonIds } },
        select: {
          ...LESSON_SELECT,
          isGenerated: true,
          subject: { select: { name: true } },
          studentGroup: { select: { name: true } },
          school: {
            select: {
              id: true,
              timezone: true,
              // As in update(): whether the year is one R1 or R2 settles.
              _count: {
                select: {
                  academicYears: {
                    where: { AND: [SETTLED_CURRENT, { masterLessons: { some: { id: dto.lessonIds[0] } } }] },
                  },
                },
              },
            },
          },
        },
        orderBy: { id: 'asc' },
      });
      // A lesson gone since the page read it is a stale card, not a 404.
      if (lessons.length !== dto.lessonIds.length) throw blockCardStale();
      const leader = lessons[0]!;
      const notACard = () =>
        new BadRequestException({
          message:
            'lessonIds: lektionerna är inte ett parallellt blocks lektioner i samma tid, en per post i blocket.',
          code: NOT_A_BLOCK_CARD,
        });
      if (lessons.some((lesson) => lesson.academicYearId !== leader.academicYearId)) throw notACard();
      const slotOf = (lesson: (typeof lessons)[number]): BlockSlot => ({
        dayOfWeek: lesson.dayOfWeek,
        startTime: toHHMM(lesson.startTime),
        endTime: toHHMM(lesson.endTime),
        recurrence: lesson.recurrence,
        startDate: toDateStringOrNull(lesson.startDate),
        endDate: toDateStringOrNull(lesson.endDate),
      });
      const posts = await tx.teachingRequirement.findMany({
        where: {
          academicYearId: leader.academicYearId,
          OR: lessons.map((lesson) => ({ studentGroupId: lesson.studentGroupId, subjectId: lesson.subjectId })),
        },
        select: { studentGroupId: true, subjectId: true, blockId: true },
      });
      const blockOf = new Map(posts.map((post) => [`${post.studentGroupId}:${post.subjectId}`, post.blockId]));
      const keys = lessons.map((lesson) => `${lesson.studentGroupId}:${lesson.subjectId}`);
      const blockId = blockOf.get(keys[0]!) ?? null;
      if (blockId === null || new Set(keys).size !== keys.length || keys.some((key) => blockOf.get(key) !== blockId)) {
        throw notACard();
      }
      // One block's lessons that no longer stand together, or a card that has
      // more lessons than the page named: stale. A card moved without one of
      // its lessons would split the block unasked.
      const origin = slotOf(leader);
      const block = await readLessonBlock(tx, leader);
      const named = new Set(dto.lessonIds);
      const standing = (block?.siblings ?? []).filter((sibling) => sameSlot(sibling, origin));
      if (
        lessons.some((lesson) => lesson.isParked || !sameSlot(slotOf(lesson), origin)) ||
        standing.some((sibling) => !named.has(sibling.id))
      ) {
        throw blockCardStale();
      }

      const rosters = await rostersOfYear(tx, user, leader.academicYearId, {
        settledCurrent: leader.school._count.academicYears > 0,
      });
      const placed: DayLesson[] = lessons.map((lesson) => ({ ...lesson, startTime, endTime }));
      const refusals: string[] = [];
      for (const [index, lesson] of lessons.entries()) {
        const conflicts = await this.findConflicts(
          tx,
          rosters,
          {
            id: lesson.id,
            academicYearId: lesson.academicYearId,
            studentGroupId: lesson.studentGroupId,
            subjectId: lesson.subjectId,
          },
          {
            dayOfWeek: dto.dayOfWeek,
            startMinutes: toMinutes(startTime),
            endMinutes: toMinutes(endTime),
            teacherId: lesson.teacherId,
            coTeacherId: lesson.coTeacherId,
            roomId: lesson.roomId,
            extraGroupIds: lesson.extraGroups.map((entry) => entry.studentGroupId),
            studentIds: lesson.participants.map((entry) => entry.studentId),
            recurrence: lesson.recurrence,
            startDate: lesson.startDate,
            endDate: lesson.endDate,
          },
          { excludeIds: dto.lessonIds, alongside: placed.slice(index + 1) },
        );
        const name = requirementName(lesson.subject.name, lesson.studentGroup.name);
        refusals.push(...conflicts.map((conflict) => `${name}: ${conflict.message}`));
      }
      if (refusals.length > 0) {
        throw new ConflictException([...new Set(refusals)].join(' '));
      }

      const { count } = await tx.masterLesson.updateMany({
        where: {
          id: { in: dto.lessonIds },
          dayOfWeek: leader.dayOfWeek,
          startTime: leader.startTime,
          endTime: leader.endTime,
          recurrence: leader.recurrence,
          startDate: leader.startDate,
          endDate: leader.endDate,
          isParked: false,
        },
        data: { dayOfWeek: dto.dayOfWeek, startTime, endTime },
      });
      if (count !== lessons.length) throw blockCardStale();
      // Lessons of the block the card lands beside — a member moved there
      // alone before — join it, as a single lesson moved onto a card does: the
      // card's owner, when its lessons agree on one. Without it the block
      // stands whole on the board while the next generation refuses it as
      // partly locked for an owner nothing on screen shows.
      const landing: BlockSlot = { ...origin, dayOfWeek: dto.dayOfWeek, startTime: dto.startTime, endTime: dto.endTime };
      const owner = lessons.every((lesson) => lesson.isGenerated)
        ? true
        : lessons.every((lesson) => !lesson.isGenerated)
          ? false
          : null;
      const joining = (block?.siblings ?? []).filter(
        (sibling) => !named.has(sibling.id) && sameSlot(sibling, landing) && owner !== null && sibling.isGenerated !== owner,
      );
      if (joining.length > 0) {
        await tx.masterLesson.updateMany({
          where: { id: { in: joining.map((sibling) => sibling.id) } },
          data: { isGenerated: owner! },
        });
      }

      let propagatedLessons = 0;
      let removedCalendarLessons = 0;
      const warnings: LessonWarning[] = [];
      const results: MasterLessonResult[] = [];
      const notices: { lesson: (typeof lessons)[number]; after: MasterLessonResult }[] = [];
      for (const lesson of lessons) {
        const updated = { ...lesson, dayOfWeek: dto.dayOfWeek, startTime, endTime };
        const { moved, removed } =
          dto.propagate === false || mode === 'DRAFT'
            ? { moved: 0, removed: 0 }
            : await propagateTemplateChange(tx, lesson, updated, {
                timezone: lesson.school.timezone,
                schoolId: lesson.school.id,
              });
        propagatedLessons += moved;
        removedCalendarLessons += removed;
        if (dto.dayOfWeek !== lesson.dayOfWeek) {
          warnings.push(...(await this.distributionWarnings(tx, updated)));
        }
        const after = toResult(updated);
        await this.writeChangeLog(tx, {
          schoolId: lesson.school.id,
          academicYearId: lesson.academicYearId,
          masterLessonId: lesson.id,
          actorId: user.userId ?? null,
          action: 'UPDATE',
          before: toResult(lesson),
          after,
        });
        results.push(after);
        if (moved > 0 || removed > 0) notices.push({ lesson, after });
      }

      this.logger.log(
        `Block card moved [block=${blockId}, lessons=${lessons.length}, propagated=${propagatedLessons}, removed=${removedCalendarLessons}]`,
      );
      this.announce(leader.school.id, mode);
      // As update() tells a class its published lessons moved: one notice per
      // member, to the roster attending it, about its own subject.
      for (const { lesson, after } of notices) {
        const recipients = await this.notifications.recipientsForLessons(tx, [
          { groupIds: [lesson.studentGroupId, ...after.extraGroupIds], participantIds: after.studentIds },
        ]);
        await this.notifications.notifyUsers(tx, {
          schoolId: lesson.school.id,
          userIds: recipients,
          type: 'SCHEDULE_CHANGED',
          meta: {
            subjectName: lesson.subject.name,
            dayOfWeek: after.dayOfWeek,
            startTime: after.startTime,
            endTime: after.endTime,
          },
        });
      }
      return { lessons: results, propagatedLessons, removedCalendarLessons, warnings };
    });
  }

  /**
   * Locks or unlocks a parallel block's lessons: every lesson of every member,
   * or the ones `lessonIds` names among them.
   *
   * WHOLE BLOCKS, because the generation refuses a block with some lessons
   * locked while the rest are still to place (BLOCK_PARTLY_LOCKED): a lock on
   * one card of a block would only move the refusal to the next generation.
   * The placed lessons only: a lesson on the tray is no placement to keep,
   * and while one is there its post still has a lesson to place, which the
   * answer's `parked` says.
   *
   * A lock changes no slot, so nothing is held against the week and the
   * published calendar has nothing to follow; the change log has a row per
   * lesson whose lock changed, and only those are answered, for the undo.
   */
  async lockBlock(dto: LockBlockDto, user: AuthenticatedUser): Promise<LockBlockResult> {
    return this.prisma.withRls(user, async (tx) => {
      const mode = await enterGrundschemaWrite(tx, requireSchoolId(user));
      const block = await tx.teachingBlock.findUnique({
        where: { id: dto.blockId },
        select: {
          id: true,
          schoolId: true,
          academicYearId: true,
          requirements: { select: { studentGroupId: true, subjectId: true } },
        },
      });
      if (!block) throw new NotFoundException('Blocket finns inte.');
      const all =
        block.requirements.length === 0
          ? []
          : await tx.masterLesson.findMany({
              where: {
                academicYearId: block.academicYearId,
                OR: block.requirements.map((post) => ({
                  studentGroupId: post.studentGroupId,
                  subjectId: post.subjectId,
                })),
              },
              select: LESSON_SELECT,
            });
      // The placed lessons only. A lesson on the tray is neither sent to the
      // engine nor counted against its post, so a lock on it would keep it on
      // the tray through the next generation beside the lesson the engine
      // places for it; it is counted instead, and the page says so.
      const lessons = all.filter((lesson) => !lesson.isParked);
      const parked = all.length - lessons.length;
      if (dto.lessonIds) {
        const ofBlock = new Set(lessons.map((lesson) => lesson.id));
        if (dto.lessonIds.some((id) => !ofBlock.has(id))) {
          throw new BadRequestException('lessonIds: varje lektion måste höra till blockets poster.');
        }
      }
      const named = dto.lessonIds ? new Set(dto.lessonIds) : null;
      const targets = lessons.filter(
        (lesson) => (named === null || named.has(lesson.id)) && lesson.isLocked !== dto.isLocked,
      );
      if (targets.length > 0) {
        await tx.masterLesson.updateMany({
          where: { id: { in: targets.map((lesson) => lesson.id) } },
          data: { isLocked: dto.isLocked },
        });
        for (const lesson of targets) {
          await this.writeChangeLog(tx, {
            schoolId: block.schoolId,
            academicYearId: block.academicYearId,
            masterLessonId: lesson.id,
            actorId: user.userId ?? null,
            action: 'UPDATE',
            before: toResult(lesson),
            after: toResult({ ...lesson, isLocked: dto.isLocked }),
          });
        }
        this.logger.log(`Block ${dto.isLocked ? 'locked' : 'unlocked'} [block=${block.id}, lessons=${targets.length}]`);
        this.announce(block.schoolId, mode);
      }
      return { blockId: block.id, isLocked: dto.isLocked, lessonIds: targets.map((lesson) => lesson.id), parked };
    });
  }

  /**
   * The ämnesfördelning breaches this lesson is part of, as warnings.
   *
   * The rule is the timplanspost's — its own when it carries one, else its
   * subject's — found by the post's own key, (läsår, class, subject), which is
   * how a lesson answers a post everywhere else (the optimiser's subtraction,
   * coverage). The week it is asked of is that post's lessons as they stand
   * after the write, every one but a parked one, which occupies nothing; and
   * a lesson on the tray breaks nothing itself. Only breaches that include THIS
   * lesson are reported: a Monday the school had already doubled before the
   * edit is the subject dialog's to list, not this save's to repeat.
   *
   * ONE STATEMENT FOR A SCHOOL WITHOUT A RULE, which is every school today:
   * the post, its subject's default and the two names it would be called by
   * come back in one joined read, since the same three through Prisma's
   * relations are three statements on a write path whose statements are
   * budgeted (projected-rosters.budget.spec.ts). The week is a second
   * statement, read only when there is a rule to hold it to. Under the
   * caller's RLS like every other read here: a post the caller cannot see is
   * no post, and says nothing.
   */
  private async distributionWarnings(
    tx: PrismaClient,
    lesson: {
      id: string;
      academicYearId: string;
      studentGroupId: string;
      subjectId: string;
      isParked: boolean;
    },
  ): Promise<DistributionWarning[]> {
    if (lesson.isParked) return [];
    const [post] = await tx.$queryRaw<DistributionPost[]>`
      SELECT r."ownDistribution", r."maxLessonsPerDay", r."minDaysBetween",
             s."maxLessonsPerDay" AS "subjectMaxLessonsPerDay",
             s."minDaysBetween" AS "subjectMinDaysBetween",
             s."name" AS "subjectName", g."name" AS "groupName"
        FROM "TeachingRequirements" r
        JOIN "Subjects" s ON s."id" = r."subjectId"
        JOIN "StudentGroups" g ON g."id" = r."studentGroupId"
       WHERE r."academicYearId" = ${lesson.academicYearId}::uuid
         AND r."studentGroupId" = ${lesson.studentGroupId}::uuid
         AND r."subjectId" = ${lesson.subjectId}::uuid`;
    if (!post) return [];
    const rule = effectiveDistribution(post, {
      maxLessonsPerDay: post.subjectMaxLessonsPerDay,
      minDaysBetween: post.subjectMinDaysBetween,
    });
    if (!hasDistributionRule(rule)) return [];

    const week = await tx.masterLesson.findMany({
      where: {
        academicYearId: lesson.academicYearId,
        studentGroupId: lesson.studentGroupId,
        subjectId: lesson.subjectId,
        isParked: false,
      },
      select: { id: true, dayOfWeek: true, recurrence: true, startDate: true, endDate: true },
    });
    const name = requirementName(post.subjectName, post.groupName);
    return distributionBreaches(
      rule,
      week.map((row) => ({
        id: row.id,
        dayOfWeek: row.dayOfWeek,
        recurrence: row.recurrence,
        startDate: toDateStringOrNull(row.startDate),
        endDate: toDateStringOrNull(row.endDate),
      })),
    )
      .filter((breach) => breach.lessonIds.includes(lesson.id))
      .map((breach) => distributionWarning(breach, name));
  }

  // ---------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------

  async remove(
    id: string,
    user: AuthenticatedUser,
  ): Promise<DeleteMasterLessonResult> {
    return this.prisma.withRls(user, async (tx) => {
      const mode = await enterGrundschemaWrite(tx, requireSchoolId(user));
      const lesson = await tx.masterLesson.findUnique({
        where: { id },
        select: { ...LESSON_SELECT, schoolId: true },
      });
      if (!lesson) {
        throw new NotFoundException('Master lesson not found.');
      }

      // Remove still-SCHEDULED materialized lessons that have not begun and
      // carry no attendance. Lessons already begun or held and lessons with
      // attendance stay (history must remain accurate); the FK sets their
      // masterLessonId to null.
      //
      // Not in DRAFT: the deletion is a draft, and its published rows stay
      // until a publish settles them. The database records which rows they
      // were (PublicationPendingRemovals, 20261011100000), in this statement's
      // own trigger, before the key is set to null.
      const { count: removedCalendarLessons } =
        mode === 'DRAFT'
          ? { count: 0 }
          : await tx.calendarLesson.deleteMany({
              where: reconcilableLessons(id),
            });

      await tx.masterLesson.delete({ where: { id } });

      await this.writeChangeLog(tx, {
        schoolId: lesson.schoolId,
        academicYearId: lesson.academicYearId,
        masterLessonId: lesson.id,
        actorId: user.userId ?? null,
        action: 'DELETE',
        before: toResult(lesson),
        after: null,
      });

      this.logger.log(
        `Master lesson deleted [lesson=${id}, removedCalendarLessons=${removedCalendarLessons}]`,
      );

      this.announce(lesson.schoolId, mode);
      return { id, removedCalendarLessons };
    });
  }

  // ---------------------------------------------------------------------
  // Conflict detection
  // ---------------------------------------------------------------------

  /**
   * groupId → its pupils, from BOTH sides of the roster.
   *
   * A home class holds its pupils through User.studentGroupId; a teaching group
   * holds them through StudentGroupMembers. Reading only one of the two answers
   * "no shared pupils" for every pairing that matters, since the interesting
   * pair is always one of each.
   */
  private async rosterOf(
    tx: PrismaClient,
    basis: RosterBasis,
    groupIds: Set<string>,
  ): Promise<Map<string, Set<string>>> {
    const membersOf = new Map<string, Set<string>>();
    if (groupIds.size === 0) return membersOf;
    const ids = [...groupIds];
    const add = (groupId: string, studentId: string) => {
      const set = membersOf.get(groupId);
      if (set) set.add(studentId);
      else membersOf.set(groupId, new Set([studentId]));
    };

    // The home side through the year's basis (projected-rosters.ts), with
    // this reader's own filter — none: every pupil whose class it is counts.
    const [homeClass, teachingGroups] = await Promise.all([
      readHomePupils(tx, basis, {}, ids),
      tx.studentGroupMember.findMany({
        where: { studentGroupId: { in: ids } },
        select: { studentId: true, studentGroupId: true },
      }),
    ]);
    for (const pupil of homeClass) {
      if (pupil.studentGroupId) add(pupil.studentGroupId, pupil.id);
    }
    for (const row of teachingGroups) add(row.studentGroupId, row.studentId);
    return membersOf;
  }

  /**
   * (class, subject) → the minutes its pupils are occupied outside the lesson.
   *
   * HOW A LESSON REACHES ITS REQUIREMENT. It cannot name one: `MasterLessons`
   * has no `teachingRequirementId` column, and there is no join to invent. What
   * it does carry is the three ids the requirement is unique on —
   * `@@unique([schoolId, academicYearId, studentGroupId, subjectId])` — so
   * (year, group, subject) identifies exactly one requirement row. That is the
   * same key the regeneration path already maps demand with
   * (optimization-proxy.service.ts, preservedByDemand, which says so in as many
   * words), and it is the cheapest correct source: one indexed read of the
   * year's requirements answers for the candidate and for every lesson it might
   * meet, instead of a lookup per lesson.
   *
   * ONLY the rows that carry a number. Every school has zeroes today and most
   * always will, so the common answer is an empty map: every lookup then reads
   * NO_BUFFER, the windows below collapse to the exact half-open test the check
   * has always used, and the whole mechanism costs one query that finds nothing.
   *
   * The year's rows, not the candidate's group's: a lesson is looked up under
   * every class attending it (see `widestBufferOf`), and a guest class's
   * requirement has to be in the same map for that to mean anything.
   */
  private async pupilBuffersOf(
    tx: PrismaClient,
    academicYearId: string,
  ): Promise<Map<string, PupilBuffer>> {
    const rows = await tx.teachingRequirement.findMany({
      where: {
        academicYearId,
        OR: [{ minutesBefore: { gt: 0 } }, { minutesAfter: { gt: 0 } }],
      },
      select: {
        studentGroupId: true,
        subjectId: true,
        minutesBefore: true,
        minutesAfter: true,
      },
    });
    return new Map(
      rows.map((row) => [
        `${row.studentGroupId}:${row.subjectId}`,
        { minutesBefore: row.minutesBefore, minutesAfter: row.minutesAfter },
      ]),
    );
  }

  private async findConflicts(
    tx: PrismaClient,
    /** The year's roster basis: every pupil read below is read through it. */
    basis: RosterBasis,
    lesson: {
      /** Null when validating a brand-new lesson. */
      id: string | null;
      academicYearId: string;
      studentGroupId: string;
      /** Needed to find the requirement that carries the pupil buffer. */
      subjectId: string;
    },
    candidate: {
      dayOfWeek: number;
      startMinutes: number;
      endMinutes: number;
      teacherId: string | null;
      coTeacherId?: string | null;
      roomId: string | null;
      /** Additional classes attending (participant-aware validation). */
      extraGroupIds?: string[];
      /** Individual participating students. */
      studentIds?: string[];
      /** Which weeks the candidate runs; defaults to every week. */
      recurrence?: LessonRecurrence;
      startDate?: Date | null;
      endDate?: Date | null;
    },
    /**
     * A block card's move (moveBlockCard): the card's lessons are not where
     * they stood (`excludeIds`), and the ones moved with this candidate are
     * where they go (`alongside`), so the card is held against the rest of
     * the week and its members against each other, as one move.
     */
    options: { excludeIds?: readonly string[]; alongside?: readonly DayLesson[] } = {},
  ): Promise<MasterLessonConflict[]> {
    const conflicts: MasterLessonConflict[] = [];
    const candidateTeachers = [candidate.teacherId, candidate.coTeacherId ?? null]
      .filter((id): id is string => Boolean(id));
    const candidateGroups = new Set<string>([
      lesson.studentGroupId,
      ...(candidate.extraGroupIds ?? []),
    ]);
    const candidateStudents = [...new Set(candidate.studentIds ?? [])];

    // Home classes of the individual participants — a student is busy
    // whenever their own class has a lesson.
    const studentGroupOf = new Map<string, string | null>();
    if (candidateStudents.length > 0) {
      const students = await readHomeClassesOf(tx, basis, candidateStudents);
      for (const student of students) {
        studentGroupOf.set(student.id, student.studentGroupId);
      }
    }

    const sameDay = await tx.masterLesson.findMany({
      where: {
        academicYearId: lesson.academicYearId,
        dayOfWeek: candidate.dayOfWeek,
        // A parked lesson keeps its old day and time only as a memory of where
        // it was. Reading that as a placement would refuse B the very slot A
        // was lifted out of to make room for it.
        isParked: false,
        ...(options.excludeIds?.length
          ? { id: { notIn: [...new Set([...(lesson.id ? [lesson.id] : []), ...options.excludeIds])] } }
          : lesson.id
            ? { id: { not: lesson.id } }
            : {}),
      },
      select: {
        id: true,
        teacherId: true,
        coTeacherId: true,
        roomId: true,
        studentGroupId: true,
        // The other half of the key its own pupil buffer is found by; the name
        // beside it is for the message, and the id is for the lookup.
        subjectId: true,
        startTime: true,
        endTime: true,
        recurrence: true,
        startDate: true,
        endDate: true,
        subject: { select: { name: true } },
        extraGroups: { select: { studentGroupId: true } },
        participants: { select: { studentId: true } },
      },
    });

    const candidateWeeks = {
      recurrence: candidate.recurrence ?? 'ALL_WEEKS',
      startDate: candidate.startDate ?? null,
      endDate: candidate.endDate ?? null,
    };

    /**
     * The pupil buffers of every requirement in the year that has one.
     *
     * Read before the narrowing below, because the narrowing now depends on
     * them: a buffer can bring two lessons together that do not touch on the
     * clock, so the exact test cannot decide on its own which lessons are worth
     * asking about. Skipped when the day is empty — there is nothing to be early
     * or late for — and otherwise one query that finds nothing at the vast
     * majority of schools. See pupilBuffersOf.
     */
    const others: DayLesson[] = [
      ...sameDay,
      ...(options.alongside ?? []).filter((other) => other.id !== lesson.id),
    ];
    const buffers =
      others.length === 0
        ? new Map<string, PupilBuffer>()
        : await this.pupilBuffersOf(tx, lesson.academicYearId);
    /**
     * One buffer for a lesson: the WIDEST before and the WIDEST after among the
     * requirements of the classes attending it, for this subject.
     *
     * Not the primary class's. The pupils of a visiting class change and shower
     * too, and the lesson holds all of them — one omklädningsrum, one set of
     * minutes — so the only figure that covers everybody on it is the largest.
     * Erring towards blocking too long is the right direction here: the opposite
     * error puts a class in its next lesson while it is still in duschen, which
     * is not a placement anybody can rescue afterwards, while a block that is
     * ten minutes too generous only costs a slot.
     *
     * THE COST, STATED: a guest class with a longer rule lengthens the block for
     * the HOST class as well. 7A's idrott, ten minutes of ombyte, joined by 7B
     * whose row says twenty, is refused around twenty for both — 7A's own row
     * never said so. That is accepted deliberately, and it is the price of the
     * paragraph above; a school that does not want it gives the two classes the
     * same number, which is the honest reading of two classes sharing a lesson
     * anyway.
     *
     * A class with no row of its own contributes nothing rather than a zero:
     * `buffers` holds only the requirements somebody wrote a number on (see
     * pupilBuffersOf), so a guest with no rule cannot shrink the host's.
     */
    const widestBufferOf = (
      groupIds: Iterable<string>,
      subjectId: string,
    ): PupilBuffer => {
      let widest = NO_BUFFER;
      for (const groupId of groupIds) {
        const buffer = buffers.get(`${groupId}:${subjectId}`);
        if (!buffer) continue;
        widest = {
          minutesBefore: Math.max(widest.minutesBefore, buffer.minutesBefore),
          minutesAfter: Math.max(widest.minutesAfter, buffer.minutesAfter),
        };
      }
      return widest;
    };

    /** Every class ON a lesson: the one it belongs to, plus the classes joining. */
    const groupsAttending = (other: {
      studentGroupId: string;
      extraGroups: { studentGroupId: string }[];
    }): string[] => [
      other.studentGroupId,
      ...other.extraGroups.map((entry) => entry.studentGroupId),
    ];

    /** The candidate's own buffer, over its primary class and its guests alike. */
    const candidateBuffer = widestBufferOf(candidateGroups, lesson.subjectId);
    const pupilStart = candidate.startMinutes - candidateBuffer.minutesBefore;
    const pupilEnd = candidate.endMinutes + candidateBuffer.minutesAfter;

    // Narrowed before the roster is loaded below, so a day with fifty lessons
    // and one overlap still asks about one overlap. Sharing a time slot is only
    // a clash if some week holds both lessons: slöjd on odd weeks and
    // hemkunskap on even weeks may share the slot, the room and the teacher —
    // that is the point of alternating weeks.
    //
    // The widest of the tests below, deliberately: this is the PUPIL window, and
    // both lessons' buffers count. Either can be what brings the two together —
    // the candidate's own shower running into the other lesson, or the other
    // lesson's ombyte reaching back into the candidate. The teacher and the room
    // arms narrow it again inside the loop, where `shareTheClock` says why.
    //
    // The other lesson's buffer is taken over ITS attending classes, by the same
    // rule as the candidate's: the widest wins on both sides, or a guest class's
    // longer rule would hold on the lesson being placed and be forgotten on the
    // lesson it is placed against.
    const clashing = others.filter((other) => {
      if (!weeksCanOverlap(candidateWeeks, other)) return false;
      const buffer = widestBufferOf(groupsAttending(other), other.subjectId);
      return (
        toMinutes(other.startTime) - buffer.minutesBefore < pupilEnd &&
        pupilStart < toMinutes(other.endTime) + buffer.minutesAfter
      );
    });

    /**
     * Which pupils each group in play holds.
     *
     * The group comparison below asks whether two groups are THE SAME. 4.1 and
     * 4ma1 are not, and they hold Alva and Bo both — so the API accepted a
     * double-booking that the web client's own engine (lib/conflicts.ts,
     * groupsShareStudents) has always refused. Every writer that is not that
     * client — the solver, an import, the mobile app, curl — went straight
     * past it.
     */
    // Empty when nothing overlaps, and rosterOf then asks the database nothing:
    // the common save lands on a day that is busy but not at this hour.
    const groupsInPlay =
      clashing.length === 0
        ? new Set<string>()
        : new Set<string>([
            ...candidateGroups,
            ...clashing.flatMap(groupsAttending),
          ]);
    const membersOf = await this.rosterOf(tx, basis, groupsInPlay);
    const candidatePupils = new Set<string>();
    for (const groupId of candidateGroups) {
      for (const studentId of membersOf.get(groupId) ?? []) {
        candidatePupils.add(studentId);
      }
    }

    for (const other of clashing) {
      /**
       * The EXACT half-open test the check has always used, and the ONLY test
       * the teacher and the room arms below are allowed to see.
       *
       * THIS IS A DECISION, NOT AN OVERSIGHT. The buffer blocks the PUPILS. The
       * idrottslärare does not change or shower with the class and is free to
       * teach the slot on either side; the gymnastiksal stands empty for those
       * same minutes, because the children are in the omklädningsrummet and not
       * in it. Widening these two arms would cost an idrottslärare a third of
       * their teachable week and make a hall that is already scarce unbookable
       * for half an hour around every lesson — refusing placements that are
       * perfectly true. The solver reasons its own room arm out the same way:
       * "a room needs no time to become itself again"
       * (scheduler_solver.py:3834-3838).
       *
       * `clashing` is now the wider pupil window, so without this the two arms
       * would inherit it silently — which is exactly the refusal the decision
       * forbids.
       */
      const shareTheClock =
        toMinutes(other.startTime) < candidate.endMinutes &&
        candidate.startMinutes < toMinutes(other.endTime);

      // Hoisted above the buffer it feeds: the same set answers "do the two
      // lessons share a class" below and "whose ombyte does this lesson hold"
      // here, and they must not be allowed to disagree.
      const otherGroups = new Set<string>(groupsAttending(other));
      const otherBuffer = widestBufferOf(otherGroups, other.subjectId);
      /**
       * The refusal a clash the BUFFER ALONE created earns, in place of the
       * plain-overlap one.
       *
       * An admin looking at 09:00-10:00 beside 10:00-11:00, refused with "the
       * group already has Idrott och hälsa in this slot", reads it as a bug in
       * the grid: there is no overlap anywhere on their screen. Naming the
       * ombyte and the minutes it costs makes the refusal something they can act
       * on — move the lesson, or lower the number on the timplan.
       *
       * Swedish, because unlike the messages beside it this sentence exists to
       * explain a mechanism the school itself configured, and it is folded
       * straight into the 409 the admin reads.
       */
      const changing = (who: string): string =>
        `${who}: ` +
        [ombyteOf('den här lektionen', candidateBuffer), ombyteOf(other.subject.name, otherBuffer)]
          .filter((part): part is string => part !== null)
          .join(', och ') +
        '.';

      const otherTeachers = [other.teacherId, other.coTeacherId].filter(Boolean);
      if (shareTheClock && candidateTeachers.some((id) => otherTeachers.includes(id))) {
        conflicts.push({
          kind: 'TEACHER',
          message: `Teacher already teaches ${other.subject.name} in this slot.`,
          masterLessonId: other.id,
        });
      }
      if (shareTheClock && candidate.roomId && other.roomId === candidate.roomId) {
        conflicts.push({
          kind: 'ROOM',
          message: `Room is already booked for ${other.subject.name} in this slot.`,
          masterLessonId: other.id,
        });
      }
      if ([...candidateGroups].some((groupId) => otherGroups.has(groupId))) {
        conflicts.push({
          kind: 'GROUP',
          message: shareTheClock
            ? `The group already has ${other.subject.name} in this slot.`
            : changing('Klassen är upptagen med ombyte eller dusch i den här tiden'),
          masterLessonId: other.id,
        });
      } else {
        // Different groups, same pupils: 4.1 against 4ma1. The clash is the
        // pupil's, not the group's, and it is exactly as hard.
        const shared = [...otherGroups].some((groupId) =>
          [...(membersOf.get(groupId) ?? [])].some((studentId) =>
            candidatePupils.has(studentId),
          ),
        );
        if (shared) {
          conflicts.push({
            kind: 'GROUP',
            message: shareTheClock
              ? `Students of this group already have ${other.subject.name} in this slot.`
              : changing(
                  'Elever i gruppen är upptagna med ombyte eller dusch i den här tiden',
                ),
            masterLessonId: other.id,
          });
        }
      }

      // Individual participants: busy if their own class attends the other
      // lesson, or they participate in it individually.
      const otherStudents = new Set(
        other.participants.map((entry) => entry.studentId),
      );
      const busyStudent = candidateStudents.find((studentId) => {
        const homeGroup = studentGroupOf.get(studentId);
        return (
          otherStudents.has(studentId) ||
          (homeGroup !== null &&
            homeGroup !== undefined &&
            otherGroups.has(homeGroup))
        );
      });
      if (busyStudent) {
        conflicts.push({
          kind: 'GROUP',
          message: shareTheClock
            ? `A participating student already has ${other.subject.name} in this slot.`
            : changing(
                'En deltagande elev är upptagen med ombyte eller dusch i den här tiden',
              ),
          masterLessonId: other.id,
        });
      }
      // Symmetric: students individually attending the other lesson whose
      // home class is one of the candidate's classes.
      if (other.participants.length > 0 && !busyStudent) {
        const reverse = await countHomePupils(
          tx,
          basis,
          { id: { in: other.participants.map((entry) => entry.studentId) } },
          [...candidateGroups],
        );
        if (reverse > 0) {
          conflicts.push({
            kind: 'GROUP',
            message: shareTheClock
              ? `A student of this class attends ${other.subject.name} in this slot.`
              : changing(
                  'En elev i klassen är upptagen med ombyte eller dusch i den här tiden',
                ),
            masterLessonId: other.id,
          });
        }
      }
    }

    // Weekly (recurring) unavailability for the involved resources.
    //
    // Measured against the lesson itself, buffer and all left out, including on
    // the STUDENT_GROUP arm. A constraint is a rule about when a resource may be
    // TAUGHT, and the buffer is not teaching — widening this would refuse an
    // idrott that ends exactly where the group's afternoon stops, over twenty
    // minutes of showering that the rule was never written about. If a school
    // wants those minutes held too it can say so by moving the constraint, which
    // is a sentence it already has. Deliberately out of scope here rather than
    // forgotten.
    const constraints = await tx.availabilityConstraint.findMany({
      where: {
        type: 'UNAVAILABLE',
        dayOfWeek: candidate.dayOfWeek,
        date: null,
        OR: [
          ...candidateTeachers.map((teacherId) => ({
            resourceType: 'TEACHER' as const,
            userId: teacherId,
          })),
          ...(candidate.roomId
            ? [{ resourceType: 'ROOM' as const, roomId: candidate.roomId }]
            : []),
          {
            resourceType: 'STUDENT_GROUP' as const,
            studentGroupId: { in: [...candidateGroups] },
          },
        ],
        // An uppdrag's slot blocks only its own läsår.
        AND: [constraintsOfYear(lesson.academicYearId)],
      },
      select: { resourceType: true, startTime: true, endTime: true },
    });

    for (const constraint of constraints) {
      const overlaps =
        toMinutes(constraint.startTime) < candidate.endMinutes &&
        candidate.startMinutes < toMinutes(constraint.endTime);
      if (!overlaps) continue;

      const label =
        constraint.resourceType === 'TEACHER'
          ? 'The teacher is unavailable in this slot.'
          : constraint.resourceType === 'ROOM'
            ? 'The room is unavailable in this slot.'
            : 'The student group is unavailable in this slot.';
      conflicts.push({ kind: 'AVAILABILITY', message: label });
    }

    return conflicts;
  }

  /**
   * The staff room hears of a DIRECT change, exactly as before; a DRAFT
   * change is a draft, and only the school's admins hear of it.
   */
  private announce(schoolId: string, mode: 'DIRECT' | 'DRAFT'): void {
    if (mode === 'DRAFT') this.realtime.notifyMasterTimetableChanged(schoolId, { draft: true });
    else this.realtime.notifyMasterTimetableChanged(schoolId);
  }

  // ---------------------------------------------------------------------
  // Audit trail
  // ---------------------------------------------------------------------

  private async writeChangeLog(
    tx: PrismaClient,
    entry: {
      schoolId: string;
      academicYearId: string;
      masterLessonId: string | null;
      actorId: string | null;
      action: 'CREATE' | 'UPDATE' | 'DELETE' | 'REGENERATE';
      before: MasterLessonResult | null;
      after: MasterLessonResult | null;
    },
  ): Promise<void> {
    await tx.scheduleChangeLog.create({
      data: {
        schoolId: entry.schoolId,
        academicYearId: entry.academicYearId,
        masterLessonId: entry.masterLessonId,
        actorId: entry.actorId,
        action: entry.action,
        before: (entry.before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (entry.after ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }
}

// ---------------------------------------------------------------------------

const LESSON_SELECT = {
  id: true,
  academicYearId: true,
  subjectId: true,
  studentGroupId: true,
  teacherId: true,
  coTeacherId: true,
  roomId: true,
  dayOfWeek: true,
  startTime: true,
  endTime: true,
  isLocked: true,
  isParked: true,
  recurrence: true,
  startDate: true,
  endDate: true,
  extraGroups: { select: { studentGroupId: true } },
  participants: { select: { studentId: true } },
} as const;

interface LessonRecord {
  id: string;
  academicYearId: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  isLocked: boolean;
  isParked: boolean;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
  extraGroups: Array<{ studentGroupId: string }>;
  participants: Array<{ studentId: string }>;
}

function toResult(lesson: LessonRecord): MasterLessonResult {
  return {
    id: lesson.id,
    academicYearId: lesson.academicYearId,
    subjectId: lesson.subjectId,
    studentGroupId: lesson.studentGroupId,
    dayOfWeek: lesson.dayOfWeek,
    startTime: toHHMM(lesson.startTime),
    endTime: toHHMM(lesson.endTime),
    roomId: lesson.roomId,
    teacherId: lesson.teacherId,
    coTeacherId: lesson.coTeacherId,
    isLocked: lesson.isLocked,
    isParked: lesson.isParked,
    recurrence: lesson.recurrence,
    // Dates go out as YYYY-MM-DD: the column is a DATE, and an ISO timestamp
    // would invite a timezone shift on the way back in.
    startDate: toDateStringOrNull(lesson.startDate),
    endDate: toDateStringOrNull(lesson.endDate),
    extraGroupIds: lesson.extraGroups.map((entry) => entry.studentGroupId),
    studentIds: lesson.participants.map((entry) => entry.studentId),
  };
}

function toDateStringOrNull(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/** `YYYY-MM-DD` (or null/undefined) to the midnight-UTC date a DATE column holds. */
function parseDateOrNull(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

function toMinutes(time: Date): number {
  return time.getUTCHours() * 60 + time.getUTCMinutes();
}

/**
 * One lesson's buffer as half a sentence: "Idrott och hälsa kräver 10 min ombyte
 * före och 20 min dusch och ombyte efter".
 *
 * Null when the lesson has no buffer at all, so the refusal names only the
 * lesson that actually costs the minutes. A clash is never explained by two
 * empty buffers — if both were empty the two lessons would overlap outright and
 * get the plain message instead.
 */
function ombyteOf(label: string, buffer: PupilBuffer): string | null {
  const sides: string[] = [];
  if (buffer.minutesBefore > 0) {
    sides.push(`${buffer.minutesBefore} min ombyte före`);
  }
  if (buffer.minutesAfter > 0) {
    sides.push(`${buffer.minutesAfter} min dusch och ombyte efter`);
  }
  return sides.length === 0 ? null : `${label} kräver ${sides.join(' och ')}`;
}

/** A card read in one slot that no longer stands in it. */
function blockCardStale(): ConflictException {
  return new ConflictException({
    message: 'Blockets lektioner står inte längre tillsammans i den tiden. Ladda om schemat och försök igen.',
    code: BLOCK_CARD_STALE,
  });
}

/** Minutes after midnight as the HH:MM a card compares (block-lessons.ts). */
function clockOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function toHHMM(time: Date): string {
  const h = time.getUTCHours().toString().padStart(2, '0');
  const m = time.getUTCMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

/** Re-exported: the rule lives with the one move rule it belongs to. */
export { reconcilableLessons };
