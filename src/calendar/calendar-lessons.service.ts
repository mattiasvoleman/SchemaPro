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
import { NotificationsService } from '../notifications/notifications.service';
import type { AssignSubstituteDto, CancelLessonDto } from './dto/lesson-action.dto';

export interface LessonActionResult {
  id: string;
  status: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'RESCHEDULED';
  note: string | null;
}

/**
 * Day-to-day operations on individual calendar lessons: cancellations,
 * reinstatements and substitute-teacher assignments. These are the
 * "something changed today" workflows, so every mutation broadcasts a
 * `calendar_lesson_updated` event to the affected teachers and school
 * dashboards.
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
      await this.notifyGroup(tx, lesson, 'LESSON_CANCELLED');
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
      const clash = await tx.calendarLesson.findFirst({
        where: {
          id: { not: id },
          status: 'SCHEDULED',
          startsAt: { lt: lesson.endsAt },
          endsAt: { gt: lesson.startsAt },
          teachers: { some: { teacherId: dto.teacherId } },
        },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException(
          'The substitute already teaches another lesson at this time.',
        );
      }

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
      // Ids only in logs — never teacher names.
      await this.notifyGroup(tx, lesson, 'LESSON_SUBSTITUTE');
      this.logger.log(`Substitute assigned [lesson=${id}]`);
      return updated;
    });
  }

  private async requireLesson(
    tx: PrismaClient,
    id: string,
  ): Promise<{
    id: string;
    schoolId: string;
    status: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'RESCHEDULED';
    note: string | null;
    startsAt: Date;
    endsAt: Date;
    studentGroupId: string;
    subject: { name: string };
  }> {
    const lesson = await tx.calendarLesson.findUnique({
      where: { id },
      select: {
        id: true,
        schoolId: true,
        status: true,
        note: true,
        startsAt: true,
        endsAt: true,
        studentGroupId: true,
        subject: { select: { name: true } },
      },
    });
    if (!lesson) {
      throw new NotFoundException('Lesson not found.');
    }
    return lesson;
  }

  /** In-app notice to the lesson's class (students + guardians). */
  private async notifyGroup(
    tx: PrismaClient,
    lesson: {
      schoolId: string;
      studentGroupId: string;
      startsAt: Date;
      subject: { name: string };
    },
    type: 'LESSON_CANCELLED' | 'LESSON_SUBSTITUTE',
  ): Promise<void> {
    const recipients = await this.notifications.recipientsForGroups(tx, [
      lesson.studentGroupId,
    ]);
    await this.notifications.notifyUsers(tx, {
      schoolId: lesson.schoolId,
      userIds: recipients,
      type,
      meta: {
        subjectName: lesson.subject.name,
        startsAt: lesson.startsAt.toISOString(),
      },
    });
  }
}
