import { Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { RealtimeGateway } from './realtime.gateway';
import type { RealtimeLesson } from './realtime.types';

/**
 * Builds and broadcasts `calendar_lesson_updated` events. Called by services
 * that mutate a single calendar lesson (cancellation, teacher reassignment,
 * room/time change). Bulk operations (publishing a whole term) intentionally
 * do not broadcast per-lesson — clients refetch on navigation instead.
 *
 * Broadcasting is best-effort: a failure to emit never fails the mutation.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  constructor(private readonly gateway: RealtimeGateway) {}

  /**
   * Loads the lesson's current state (inside the caller's RLS transaction)
   * and broadcasts it after the transaction work is done.
   */
  async notifyLessonChanged(tx: PrismaClient, calendarLessonId: string): Promise<void> {
    try {
      const lesson = await tx.calendarLesson.findUnique({
        where: { id: calendarLessonId },
        select: {
          id: true,
          schoolId: true,
          startsAt: true,
          endsAt: true,
          status: true,
          subject: { select: { name: true } },
          room: { select: { name: true } },
          teachers: { select: { teacherId: true } },
          studentGroup: {
            select: {
              members: {
                where: { role: 'STUDENT', isActive: true },
                select: { id: true },
              },
            },
          },
        },
      });
      if (!lesson) return;

      const payload: RealtimeLesson = {
        id: lesson.id,
        startTime: lesson.startsAt.toISOString(),
        endTime: lesson.endsAt.toISOString(),
        subjectName: lesson.subject.name,
        roomName: lesson.room?.name ?? '—',
        studentIds: lesson.studentGroup.members.map((member) => member.id),
        status: lesson.status,
      };

      this.gateway.emitLessonUpdated(
        lesson.schoolId,
        lesson.teachers.map((assignment) => assignment.teacherId),
        { lessonId: lesson.id, updatedLesson: payload },
      );
    } catch {
      this.logger.warn(`Realtime broadcast failed [lesson=${calendarLessonId}]`);
    }
  }
}
