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
import { RealtimeService } from '../realtime/realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { parseTimeString, zonedTimeToUtc } from '../common/utils/time';
import type { CreateMasterLessonDto } from './dto/create-master-lesson.dto';
import type { UpdateMasterLessonDto } from './dto/update-master-lesson.dto';

export interface MasterLessonConflict {
  kind: 'TEACHER' | 'ROOM' | 'GROUP' | 'AVAILABILITY';
  message: string;
  /** The other master lesson involved, when applicable. */
  masterLessonId?: string;
}

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
  extraGroupIds: string[];
  studentIds: string[];
}

export interface UpdateMasterLessonResult extends MasterLessonResult {
  /** Future calendar lessons that were moved along with the template. */
  propagatedLessons: number;
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
        roomId: dto.roomId ?? null,
        extraGroupIds: (dto.extraGroupIds ?? []).filter(
          (groupId) => groupId !== dto.studentGroupId,
        ),
        studentIds: dto.studentIds ?? [],
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
          roomId: dto.roomId ?? null,
          dayOfWeek: dto.dayOfWeek,
          startTime: parseTimeString(dto.startTime),
          endTime: parseTimeString(dto.endTime),
          isLocked: dto.isLocked ?? false,
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
        coTeacherId: lesson.coTeacherId,
        roomId: dto.roomId !== undefined ? dto.roomId : lesson.roomId,
        extraGroupIds: (dto.extraGroupIds !== undefined
          ? dto.extraGroupIds
          : lesson.extraGroups.map((entry) => entry.studentGroupId)
        ).filter((groupId) => groupId !== lesson.studentGroupId),
        studentIds:
          dto.studentIds !== undefined
            ? dto.studentIds
            : lesson.participants.map((entry) => entry.studentId),
      };
      if (candidate.startMinutes >= candidate.endMinutes) {
        throw new BadRequestException('startTime must be before endTime.');
      }

      const conflicts = await this.findConflicts(
        tx,
        {
          id: lesson.id,
          academicYearId: lesson.academicYearId,
          studentGroupId: lesson.studentGroupId,
        },
        candidate,
      );
      if (conflicts.length > 0) {
        // The exception filter forwards `message` as the problem detail, so
        // the conflict list is folded into it for the UI to display.
        const unique = [...new Set(conflicts.map((conflict) => conflict.message))];
        throw new ConflictException(unique.join(' '));
      }

      const updated = await tx.masterLesson.update({
        where: { id },
        data: {
          dayOfWeek: candidate.dayOfWeek,
          ...(dto.startTime !== undefined
            ? { startTime: parseTimeString(dto.startTime) }
            : {}),
          ...(dto.endTime !== undefined
            ? { endTime: parseTimeString(dto.endTime) }
            : {}),
          ...(dto.roomId !== undefined ? { roomId: dto.roomId } : {}),
          ...(dto.teacherId !== undefined ? { teacherId: dto.teacherId } : {}),
          ...(dto.isLocked !== undefined ? { isLocked: dto.isLocked } : {}),
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

      const propagatedLessons =
        dto.propagate === false
          ? 0
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
        `Master lesson adjusted [lesson=${id}, propagated=${propagatedLessons}]`,
      );
      this.realtime.notifyMasterTimetableChanged(lesson.school.id);

      // In-app schedule-change notice to affected classes once published
      // lessons actually moved.
      if (propagatedLessons > 0) {
        const recipients = await this.notifications.recipientsForGroups(tx, [
          lesson.studentGroupId,
          ...lesson.extraGroups.map((entry) => entry.studentGroupId),
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

      return { ...after, propagatedLessons };
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
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const { count: removedCalendarLessons } = await tx.calendarLesson.deleteMany({
        where: {
          masterLessonId: id,
          status: 'SCHEDULED',
          date: { gte: today },
          attendanceRecords: { none: {} },
        },
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

  private async findConflicts(
    tx: PrismaClient,
    lesson: {
      /** Null when validating a brand-new lesson. */
      id: string | null;
      academicYearId: string;
      studentGroupId: string;
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
        ...(lesson.id ? { id: { not: lesson.id } } : {}),
      },
      select: {
        id: true,
        teacherId: true,
        coTeacherId: true,
        roomId: true,
        studentGroupId: true,
        startTime: true,
        endTime: true,
        subject: { select: { name: true } },
        extraGroups: { select: { studentGroupId: true } },
        participants: { select: { studentId: true } },
      },
    });

    for (const other of sameDay) {
      const overlaps =
        toMinutes(other.startTime) < candidate.endMinutes &&
        candidate.startMinutes < toMinutes(other.endTime);
      if (!overlaps) continue;

      const otherTeachers = [other.teacherId, other.coTeacherId].filter(Boolean);
      if (candidateTeachers.some((id) => otherTeachers.includes(id))) {
        conflicts.push({
          kind: 'TEACHER',
          message: `Teacher already teaches ${other.subject.name} in this slot.`,
          masterLessonId: other.id,
        });
      }
      if (candidate.roomId && other.roomId === candidate.roomId) {
        conflicts.push({
          kind: 'ROOM',
          message: `Room is already booked for ${other.subject.name} in this slot.`,
          masterLessonId: other.id,
        });
      }
      const otherGroups = new Set<string>([
        other.studentGroupId,
        ...other.extraGroups.map((entry) => entry.studentGroupId),
      ]);
      if ([...candidateGroups].some((groupId) => otherGroups.has(groupId))) {
        conflicts.push({
          kind: 'GROUP',
          message: `The group already has ${other.subject.name} in this slot.`,
          masterLessonId: other.id,
        });
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
          message: `A participating student already has ${other.subject.name} in this slot.`,
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
            message: `A student of this class attends ${other.subject.name} in this slot.`,
            masterLessonId: other.id,
          });
        }
      }
    }

    // Weekly (recurring) unavailability for the involved resources.
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
   * Moves future, still-SCHEDULED calendar lessons that were materialized
   * from this template and carry no attendance yet. Lessons in the past or
   * with attendance are left untouched (history must stay accurate).
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
    },
    timezone: string,
    schoolId: string,
  ): Promise<number> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const futureLessons = await tx.calendarLesson.findMany({
      where: {
        masterLessonId: before.id,
        status: 'SCHEDULED',
        date: { gte: today },
        attendanceRecords: { none: {} },
      },
      select: { id: true, date: true },
    });

    const dayShift = after.dayOfWeek - before.dayOfWeek;
    const startHHMM = toHHMM(after.startTime);
    const endHHMM = toHHMM(after.endTime);

    for (const calendarLesson of futureLessons) {
      const newDate = new Date(calendarLesson.date);
      newDate.setUTCDate(newDate.getUTCDate() + dayShift);
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

    return futureLessons.length;
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
    extraGroupIds: lesson.extraGroups.map((entry) => entry.studentGroupId),
    studentIds: lesson.participants.map((entry) => entry.studentId),
  };
}

function toMinutes(time: Date): number {
  return time.getUTCHours() * 60 + time.getUTCMinutes();
}

function toHHMM(time: Date): string {
  const h = time.getUTCHours().toString().padStart(2, '0');
  const m = time.getUTCMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}
