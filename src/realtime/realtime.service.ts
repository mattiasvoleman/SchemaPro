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
   * `draft`: the school is in DRAFT and the change is a draft, so only its
   * admins hear of it; the staff room hears when it is published.
   */
  notifyMasterTimetableChanged(schoolId: string, options: { draft?: boolean } = {}): void {
    try {
      if (options.draft) this.gateway.emitMasterTimetableUpdated(schoolId, 'admin');
      else this.gateway.emitMasterTimetableUpdated(schoolId);
    } catch {
      this.logger.warn(`Realtime timetable broadcast failed [school=${schoolId}]`);
    }
  }

  /**
   * The cover board of a school changed over [from, to] (school-local
   * dates). Called AFTER the write has committed, so an admin who refetches
   * on it reads the new state. Best effort.
   */
  notifyCoverBoardChanged(schoolId: string, from: string, to: string): void {
    try {
      this.gateway.emitCoverBoardUpdated(schoolId, { from, to, changedAt: new Date().toISOString() });
    } catch {
      this.logger.warn(`Realtime cover board broadcast failed [school=${schoolId}]`);
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
      this.emit(lesson);
    } catch {
      this.logger.warn(`Realtime broadcast failed [lesson=${calendarLessonId}]`);
    }
  }

  /**
   * Many lessons at once, for a bulk avbokning and its reversal: ONE read of
   * them all, then one emit each — the teacher app writes these into its
   * offline cache, so none may be skipped, and a read per lesson inside the
   * writing transaction is what a hundred-lesson batch cannot afford. Called
   * AFTER the write has committed, in a transaction of its own.
   *
   * The select is notifyLessonChanged's, word for word (the spec compares the
   * two calls): a broadcast is the same payload however many there are.
   */
  async notifyLessonsChanged(tx: PrismaClient, calendarLessonIds: readonly string[]): Promise<void> {
    if (calendarLessonIds.length === 0) return;
    try {
      const lessons = await tx.calendarLesson.findMany({
        where: { id: { in: [...calendarLessonIds] } },
        // notifyLessonChanged's select, word for word: see the members
        // comments there for why both rosters are read.
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
      for (const lesson of lessons) this.emit(lesson);
    } catch {
      this.logger.warn(`Realtime broadcast failed [lessons=${calendarLessonIds.length}]`);
    }
  }

  private emit(lesson: {
    id: string;
    schoolId: string;
    startsAt: Date;
    endsAt: Date;
    status: RealtimeLesson['status'];
    subject: { name: string };
    room: { name: string } | null;
    teachers: { teacherId: string }[];
    studentGroup: { members: { id: string }[]; teachingMembers: { studentId: string }[] };
    extraGroups: { studentGroup: { members: { id: string }[]; teachingMembers: { studentId: string }[] } }[];
    participants: { studentId: string }[];
  }): void {
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
  }
}
