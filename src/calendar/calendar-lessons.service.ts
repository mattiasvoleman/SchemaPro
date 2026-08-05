import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  NotificationsService,
  type NotificationKind,
} from '../notifications/notifications.service';
import type {
  AssignSubstituteDto,
  CancelLessonDto,
  ChangeRoomDto,
} from './dto/lesson-action.dto';

export interface LessonActionResult {
  id: string;
  status: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'RESCHEDULED';
  note: string | null;
}

/** A qualified, currently-free candidate to cover a lesson. */
export interface SubstituteSuggestion {
  teacherId: string;
  /** true = teaches this exact class+subject; false = teaches the subject elsewhere. */
  isPrimary: boolean;
}

interface LessonForAction {
  id: string;
  schoolId: string;
  status: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'RESCHEDULED';
  note: string | null;
  date: Date;
  startsAt: Date;
  endsAt: Date;
  roomId: string | null;
  subjectId: string;
  studentGroupId: string;
  subject: { name: string };
  teachers: { teacherId: string }[];
}

/**
 * Day-to-day operations on individual calendar lessons: cancellations,
 * reinstatements, substitute-teacher assignments and room changes. These are
 * the "something changed today" workflows, so every mutation broadcasts a
 * `calendar_lesson_updated` event and notifies the affected class (students +
 * guardians) and the teachers involved.
 */
@Injectable()
export class CalendarLessonsService {
  private readonly logger = new Logger(CalendarLessonsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  async cancel(
    id: string,
    dto: CancelLessonDto,
    user: AuthenticatedUser,
  ): Promise<LessonActionResult> {
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await this.requireLesson(tx, id);
      if (lesson.status !== 'SCHEDULED') {
        throw new BadRequestException('Only scheduled lessons can be cancelled.');
      }

      const updated = await tx.calendarLesson.update({
        where: { id },
        data: { status: 'CANCELLED', note: dto.reason ?? lesson.note },
        select: { id: true, status: true, note: true },
      });

      await this.realtime.notifyLessonChanged(tx, id);
      await this.notifyLessonAudience(tx, lesson, {
        type: 'LESSON_CANCELLED',
        teacherIds: lesson.teachers.map((t) => t.teacherId),
        email: {
          subject: `Lesson cancelled: ${lesson.subject.name}`,
          body: `${lesson.subject.name} on ${lesson.startsAt.toISOString()} has been cancelled.${
            dto.reason ? ` Reason: ${dto.reason}` : ''
          }`,
        },
      });
      this.logger.log(`Lesson cancelled [lesson=${id}]`);
      return updated;
    });
  }

  async reinstate(id: string, user: AuthenticatedUser): Promise<LessonActionResult> {
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await this.requireLesson(tx, id);
      if (lesson.status !== 'CANCELLED') {
        throw new BadRequestException('Only cancelled lessons can be reinstated.');
      }

      const updated = await tx.calendarLesson.update({
        where: { id },
        data: { status: 'SCHEDULED' },
        select: { id: true, status: true, note: true },
      });

      await this.realtime.notifyLessonChanged(tx, id);
      this.logger.log(`Lesson reinstated [lesson=${id}]`);
      return updated;
    });
  }

  /**
   * Replaces the lesson's teacher assignments with a single SUBSTITUTE
   * assignment. The substitute must be an active teacher in the same school
   * and free at the lesson's time.
   */
  async assignSubstitute(
    id: string,
    dto: AssignSubstituteDto,
    user: AuthenticatedUser,
  ): Promise<LessonActionResult> {
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await this.requireLesson(tx, id);
      if (lesson.status === 'COMPLETED') {
        throw new BadRequestException('Completed lessons cannot be reassigned.');
      }

      const substitute = await tx.user.findUnique({
        where: { id: dto.teacherId },
        select: { id: true, role: true, isActive: true },
      });
      if (!substitute || !substitute.isActive || substitute.role !== 'TEACHER') {
        throw new BadRequestException('The substitute must be an active teacher.');
      }

      // The substitute must not already teach an overlapping lesson.
      if (await this.teacherHasClash(tx, dto.teacherId, lesson)) {
        throw new ConflictException(
          'The substitute already teaches another lesson at this time.',
        );
      }

      const outgoingTeacherIds = lesson.teachers.map((t) => t.teacherId);
      await tx.calendarLessonTeacher.deleteMany({ where: { calendarLessonId: id } });
      await tx.calendarLessonTeacher.create({
        data: {
          schoolId: lesson.schoolId,
          calendarLessonId: id,
          teacherId: dto.teacherId,
          role: 'SUBSTITUTE',
        },
      });

      const updated = await tx.calendarLesson.update({
        where: { id },
        data: dto.note !== undefined ? { note: dto.note } : {},
        select: { id: true, status: true, note: true },
      });

      await this.realtime.notifyLessonChanged(tx, id);
      // Notify the class and both the outgoing teacher(s) and the substitute.
      await this.notifyLessonAudience(tx, lesson, {
        type: 'LESSON_SUBSTITUTE',
        teacherIds: [...outgoingTeacherIds, dto.teacherId],
        email: {
          subject: `Substitute assigned: ${lesson.subject.name}`,
          body: `${lesson.subject.name} on ${lesson.startsAt.toISOString()} will be covered by a substitute teacher.`,
        },
      });
      // Ids only in logs — never teacher names.
      this.logger.log(`Substitute assigned [lesson=${id}]`);
      return updated;
    });
  }

  /**
   * Moves a scheduled lesson to a different room (or clears it). Rejects a
   * target room already booked by another scheduled lesson at the same time.
   */
  async changeRoom(
    id: string,
    dto: ChangeRoomDto,
    user: AuthenticatedUser,
  ): Promise<LessonActionResult> {
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await this.requireLesson(tx, id);
      if (lesson.status === 'COMPLETED') {
        throw new BadRequestException('Completed lessons cannot be changed.');
      }
      // No-op: same room and nothing else to record — return without notifying.
      if (lesson.roomId === dto.roomId && dto.note === undefined) {
        return { id: lesson.id, status: lesson.status, note: lesson.note };
      }

      if (dto.roomId !== null) {
        const room = await tx.room.findUnique({
          where: { id: dto.roomId },
          select: { id: true },
        });
        if (!room) {
          throw new BadRequestException('Room not found.');
        }

        const clash = await tx.calendarLesson.findFirst({
          where: {
            id: { not: id },
            status: 'SCHEDULED',
            roomId: dto.roomId,
            startsAt: { lt: lesson.endsAt },
            endsAt: { gt: lesson.startsAt },
          },
          select: { id: true },
        });
        if (clash) {
          throw new ConflictException(
            'That room is already booked by another lesson at this time.',
          );
        }

        // The room must not be held by an approved self-service booking either.
        const bookingClash = await tx.roomBooking.findFirst({
          where: {
            roomId: dto.roomId,
            status: 'APPROVED',
            startsAt: { lt: lesson.endsAt },
            endsAt: { gt: lesson.startsAt },
          },
          select: { id: true },
        });
        if (bookingClash) {
          throw new ConflictException(
            'That room is reserved by an approved booking at this time.',
          );
        }
      }

      const updated = await tx.calendarLesson.update({
        where: { id },
        data: {
          roomId: dto.roomId,
          ...(dto.note !== undefined ? { note: dto.note } : {}),
        },
        select: { id: true, status: true, note: true },
      });

      await this.realtime.notifyLessonChanged(tx, id);
      await this.notifyLessonAudience(tx, lesson, {
        type: 'LESSON_ROOM_CHANGED',
        teacherIds: lesson.teachers.map((t) => t.teacherId),
        email: {
          subject: `Room changed: ${lesson.subject.name}`,
          body: `${lesson.subject.name} on ${lesson.startsAt.toISOString()} has moved to a different room.`,
        },
      });
      this.logger.log(`Lesson room changed [lesson=${id}]`);
      return updated;
    });
  }

  /**
   * Suggests substitute teachers for a lesson: those who teach the subject and
   * are free at the lesson's time. Mirrors the open-slot finder's "free +
   * qualified" idea — teachers assigned to this exact class+subject rank first
   * (isPrimary), other subject teachers follow as fallbacks. Freeness uses the
   * same overlapping-lesson check `assignSubstitute` enforces, so every
   * suggestion is guaranteed to be assignable.
   */
  async suggestSubstitutes(
    id: string,
    user: AuthenticatedUser,
  ): Promise<SubstituteSuggestion[]> {
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await this.requireLesson(tx, id);

      const requirements = await tx.teachingRequirement.findMany({
        where: { subjectId: lesson.subjectId },
        select: { teacherId: true, coTeacherId: true, studentGroupId: true },
      });

      const primaryIds = new Set<string>();
      const qualifiedIds = new Set<string>();
      for (const req of requirements) {
        const forThisClass = req.studentGroupId === lesson.studentGroupId;
        for (const teacherId of [req.teacherId, req.coTeacherId]) {
          if (!teacherId) continue;
          qualifiedIds.add(teacherId);
          if (forThisClass) primaryIds.add(teacherId);
        }
      }

      // Never suggest a teacher already assigned to this lesson.
      for (const assignment of lesson.teachers) {
        qualifiedIds.delete(assignment.teacherId);
        primaryIds.delete(assignment.teacherId);
      }
      if (qualifiedIds.size === 0) return [];

      const teachers = await tx.user.findMany({
        where: {
          id: { in: [...qualifiedIds] },
          role: 'TEACHER',
          isActive: true,
        },
        select: { id: true },
      });

      const suggestions: SubstituteSuggestion[] = [];
      for (const teacher of teachers) {
        if (await this.teacherHasClash(tx, teacher.id, lesson)) continue;
        suggestions.push({ teacherId: teacher.id, isPrimary: primaryIds.has(teacher.id) });
      }

      // Assigned-subject teachers first, then fallbacks.
      return suggestions.sort(
        (a, b) => Number(b.isPrimary) - Number(a.isPrimary),
      );
    });
  }

  /** True when the teacher already teaches another scheduled lesson that overlaps. */
  private async teacherHasClash(
    tx: PrismaClient,
    teacherId: string,
    lesson: { id: string; startsAt: Date; endsAt: Date },
  ): Promise<boolean> {
    const clash = await tx.calendarLesson.findFirst({
      where: {
        id: { not: lesson.id },
        status: 'SCHEDULED',
        startsAt: { lt: lesson.endsAt },
        endsAt: { gt: lesson.startsAt },
        teachers: { some: { teacherId } },
      },
      select: { id: true },
    });
    return clash !== null;
  }

  private async requireLesson(
    tx: PrismaClient,
    id: string,
  ): Promise<LessonForAction> {
    const lesson = await tx.calendarLesson.findUnique({
      where: { id },
      select: {
        id: true,
        schoolId: true,
        status: true,
        note: true,
        date: true,
        startsAt: true,
        endsAt: true,
        roomId: true,
        subjectId: true,
        studentGroupId: true,
        subject: { select: { name: true } },
        teachers: { select: { teacherId: true } },
      },
    });
    if (!lesson) {
      throw new NotFoundException('Lesson not found.');
    }
    return lesson;
  }

  /**
   * In-app (and optionally email) notice about a lesson change. Fans out to the
   * lesson's class (students + guardians) and to the teachers involved.
   */
  private async notifyLessonAudience(
    tx: PrismaClient,
    lesson: {
      schoolId: string;
      studentGroupId: string;
      startsAt: Date;
      subject: { name: string };
    },
    options: {
      type: NotificationKind;
      teacherIds: string[];
      email?: { subject: string; body: string };
    },
  ): Promise<void> {
    const groupRecipients = await this.notifications.recipientsForGroups(tx, [
      lesson.studentGroupId,
    ]);
    const recipients = [...new Set([...groupRecipients, ...options.teacherIds])];
    await this.notifications.notifyUsers(tx, {
      schoolId: lesson.schoolId,
      userIds: recipients,
      type: options.type,
      meta: {
        subjectName: lesson.subject.name,
        startsAt: lesson.startsAt.toISOString(),
      },
      ...(options.email ? { email: options.email } : {}),
    });
  }
}
