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
   * Broadcasts that the master timetable of a school changed (create/update/
   * delete/regenerate/restore). Collaborating admin clients refetch on it.
   */
  notifyMasterTimetableChanged(schoolId: string): void {
    try {
      this.gateway.emitMasterTimetableUpdated(schoolId);
    } catch {
      this.logger.warn(`Realtime timetable broadcast failed [school=${schoolId}]`);
    }
  }

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
          // Home-class pupils…
          studentGroup: {
            select: {
              members: {
                where: { role: 'STUDENT', isActive: true },
                select: { id: true },
              },
              // …and the teaching-group roster, which lives in the join model
              // and not in that back-relation. A nivågrupp has no home-class
              // members at all, so asking only the first question produced an
              // empty list — and the teacher app writes this list straight into
              // its offline cache. Once that cache is correct, an empty
              // broadcast does not merely fail to help: it wipes the roster the
              // teacher is about to take attendance with.
              teachingMembers: {
                where: { student: { role: 'STUDENT', isActive: true } },
                select: { studentId: true },
              },
            },
          },
          extraGroups: {
            select: {
              studentGroup: {
                select: {
                  members: {
                    where: { role: 'STUDENT', isActive: true },
                    select: { id: true },
                  },
                  teachingMembers: {
                    where: { student: { role: 'STUDENT', isActive: true } },
                    select: { studentId: true },
                  },
                },
              },
            },
          },
          participants: { select: { studentId: true } },
        },
      });
      if (!lesson) return;

      const payload: RealtimeLesson = {
        id: lesson.id,
        startTime: lesson.startsAt.toISOString(),
        endTime: lesson.endsAt.toISOString(),
        subjectName: lesson.subject.name,
        roomName: lesson.room?.name ?? '—',
        // The same union the clients assemble: every class attending, the
        // teaching-group rosters of all of them, and pupils named individually.
        studentIds: [
          ...new Set([
            ...lesson.studentGroup.members.map((member) => member.id),
            ...lesson.studentGroup.teachingMembers.map((row) => row.studentId),
            ...lesson.extraGroups.flatMap((entry) => [
              ...entry.studentGroup.members.map((member) => member.id),
              ...entry.studentGroup.teachingMembers.map((row) => row.studentId),
            ]),
            ...lesson.participants.map((row) => row.studentId),
          ]),
        ],
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
