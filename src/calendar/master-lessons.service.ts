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
import { runsOn, weeksCanOverlap } from './lesson-recurrence';
import type { LessonRecurrence } from '@prisma/client';
import { RealtimeService } from '../realtime/realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { parseTimeString, zonedTimeToUtc } from '../common/utils/time';
import type { CreateMasterLessonDto } from './dto/create-master-lesson.dto';
import type { UpdateMasterLessonDto } from './dto/update-master-lesson.dto';
import { lessonQualificationFindings } from '../staffing/staffing-enforcement';
import {
  settleFindings,
  type StaffingRole,
  type StaffingWarning,
} from '../staffing/staffing-checks';

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
   * the lesson (STAFF_TEACHER_NOT_QUALIFIED only — see update()). Empty when
   * nothing was found or nobody new was assigned.
   */
  warnings: StaffingWarning[];
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
  ): Promise<MasterLessonResult> {
    return this.prisma.withRls(user, async (tx) => {
      const year = await tx.academicYear.findUnique({
        where: { id: dto.academicYearId },
        select: { id: true, schoolId: true },
      });
      if (!year) {
        throw new NotFoundException('Academic year not found.');
      }

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

      this.logger.log(`Master lesson created manually [lesson=${created.id}]`);
      this.realtime.notifyMasterTimetableChanged(year.schoolId);
      return result;
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
      const lesson = await tx.masterLesson.findUnique({
        where: { id },
        select: {
          ...LESSON_SELECT,
          school: { select: { id: true, timezone: true } },
        },
      });
      if (!lesson) {
        throw new NotFoundException('Master lesson not found.');
      }

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
      const warnings =
        assignees.length > 0
          ? settleFindings(
              await lessonQualificationFindings(tx, {
                schoolId: lesson.school.id,
                academicYearId: lesson.academicYearId,
                subjectId: lesson.subjectId,
                groupIds: [lesson.studentGroupId, ...candidate.extraGroupIds],
                studentIds: candidate.studentIds,
                assignees,
              }),
            )
          : [];

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
          ...(dto.recurrence !== undefined ||
          dto.startDate !== undefined ||
          dto.endDate !== undefined
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

      const { moved: propagatedLessons, removed: removedCalendarLessons } =
        dto.propagate === false
          ? { moved: 0, removed: 0 }
          : await this.propagate(tx, lesson, updated, lesson.school.timezone, lesson.school.id);

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
      this.realtime.notifyMasterTimetableChanged(lesson.school.id);

      // In-app schedule-change notice to affected classes once published
      // lessons actually moved — or disappeared, which the class needs to
      // hear about just as much.
      if (propagatedLessons > 0 || removedCalendarLessons > 0) {
        // The notice describes the lesson as it is after this update, so it
        // goes to the classes attending it after this update. Read off the
        // stored row, a class the same patch attached never heard about the
        // lessons it now has, and a class it detached was told about a slot
        // that is no longer theirs.
        const recipients = await this.notifications.recipientsForGroups(tx, [
          lesson.studentGroupId,
          ...after.extraGroupIds,
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
  // Delete
  // ---------------------------------------------------------------------

  async remove(
    id: string,
    user: AuthenticatedUser,
  ): Promise<DeleteMasterLessonResult> {
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await tx.masterLesson.findUnique({
        where: { id },
        select: { ...LESSON_SELECT, schoolId: true },
      });
      if (!lesson) {
        throw new NotFoundException('Master lesson not found.');
      }

      // Remove future, still-SCHEDULED materialized lessons without recorded
      // attendance. Past lessons and lessons with attendance stay (history
      // must remain accurate); the FK sets their masterLessonId to null.
      const { count: removedCalendarLessons } = await tx.calendarLesson.deleteMany({
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

      this.realtime.notifyMasterTimetableChanged(lesson.schoolId);
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

    const [homeClass, teachingGroups] = await Promise.all([
      tx.user.findMany({
        where: { studentGroupId: { in: ids } },
        select: { id: true, studentGroupId: true },
      }),
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
      const students = await tx.user.findMany({
        where: { id: { in: candidateStudents } },
        select: { id: true, studentGroupId: true },
      });
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
        ...(lesson.id ? { id: { not: lesson.id } } : {}),
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
    const buffers =
      sameDay.length === 0
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
    const clashing = sameDay.filter((other) => {
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
    const membersOf = await this.rosterOf(tx, groupsInPlay);
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
        const reverse = await tx.user.count({
          where: {
            id: { in: other.participants.map((entry) => entry.studentId) },
            studentGroupId: { in: [...candidateGroups] },
          },
        });
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

  // ---------------------------------------------------------------------
  // Propagation to materialized calendar lessons
  // ---------------------------------------------------------------------

  /**
   * Reconciles future, still-SCHEDULED calendar lessons that were
   * materialized from this template and carry no attendance yet: they move
   * with the slot, and the ones the template no longer runs on are removed.
   * Lessons in the past or with attendance are left untouched (history must
   * stay accurate).
   *
   * Only the removing half lives here, deliberately. Narrowing a template —
   * every week to odd weeks, a term end pulled forward — strands rows that no
   * later publish can ever reach again, because publishing only ever creates;
   * they would sit in the calendar until the template itself is deleted, so
   * this is the one place that can clear them. Widening leaves the opposite
   * gap, dates that ought to exist and do not, but filling it is
   * materialization: it needs the academic year's bounds, the holiday
   * closures and the idempotency set that `CalendarService.publish` owns.
   * Re-publishing is how those dates appear, and it is idempotent, so it can
   * be run any time after the change.
   */
  private async propagate(
    tx: PrismaClient,
    before: { id: string; dayOfWeek: number; teacherId: string | null },
    after: {
      dayOfWeek: number;
      startTime: Date;
      endTime: Date;
      roomId: string | null;
      teacherId: string | null;
      recurrence: LessonRecurrence;
      startDate: Date | null;
      endDate: Date | null;
    },
    timezone: string,
    schoolId: string,
  ): Promise<{ moved: number; removed: number }> {
    const futureLessons = await tx.calendarLesson.findMany({
      where: reconcilableLessons(before.id),
      select: { id: true, date: true },
    });

    const dayShift = after.dayOfWeek - before.dayOfWeek;
    const startHHMM = toHHMM(after.startTime);
    const endHHMM = toHHMM(after.endTime);
    const stale: string[] = [];
    let moved = 0;

    for (const calendarLesson of futureLessons) {
      const newDate = new Date(calendarLesson.date);
      newDate.setUTCDate(newDate.getUTCDate() + dayShift);

      // The date the row would land on is the one that has to survive the
      // template's own rule — a weekday move can carry a half-term lesson
      // past its end date, and a parity change empties every other week.
      if (!runsOn(after, newDate)) {
        stale.push(calendarLesson.id);
        continue;
      }

      const dateString = newDate.toISOString().slice(0, 10);

      await tx.calendarLesson.update({
        where: { id: calendarLesson.id },
        data: {
          date: newDate,
          startsAt: zonedTimeToUtc(dateString, startHHMM, timezone),
          endsAt: zonedTimeToUtc(dateString, endHHMM, timezone),
          roomId: after.roomId,
        },
      });
      moved++;

      // Keep the LEAD teacher assignment in sync with the template.
      if (after.teacherId !== before.teacherId) {
        await tx.calendarLessonTeacher.deleteMany({
          where: { calendarLessonId: calendarLesson.id, role: 'LEAD' },
        });
        if (after.teacherId) {
          await tx.calendarLessonTeacher.create({
            data: {
              schoolId,
              calendarLessonId: calendarLesson.id,
              teacherId: after.teacherId,
              role: 'LEAD',
            },
          });
        }
      }
    }

    // Deleting by id alone is safe: these ids come from the guarded query
    // above, so they are already future, SCHEDULED and attendance-free.
    if (stale.length > 0) {
      await tx.calendarLesson.deleteMany({ where: { id: { in: stale } } });
    }

    return { moved, removed: stale.length };
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

/**
 * The materialized lessons a template change may still rewrite or remove.
 *
 * One definition for every caller: deleting the template, narrowing it, and
 * the room optimisation moving its room (RoomOptimizationService.apply) reach
 * the same rows, and a difference between the rules would mean a lesson that
 * one of them rewrites and another leaves alone. Anything in the past, no
 * longer merely SCHEDULED (cancelled, completed, rescheduled by hand), or
 * with attendance recorded is what happened, and stays as it happened.
 *
 * Several templates at once for the room optimisation, which moves hundreds
 * of lessons in one transaction and would otherwise pay a statement each.
 */
export function reconcilableLessons(
  masterLessonIds: string | string[],
): Prisma.CalendarLessonWhereInput {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return {
    masterLessonId:
      typeof masterLessonIds === 'string' ? masterLessonIds : { in: masterLessonIds },
    status: 'SCHEDULED',
    date: { gte: today },
    attendanceRecords: { none: {} },
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

function toHHMM(time: Date): string {
  const h = time.getUTCHours().toString().padStart(2, '0');
  const m = time.getUTCMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}
