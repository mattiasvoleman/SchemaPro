import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { calendarLessonRosters } from '../calendar/lesson-roster';
import { RealtimeGateway } from './realtime.gateway';
import type { RealtimeLesson } from './realtime.types';

/**
 * The lesson as a broadcast reads it: the payload's fields, and what the
 * roster reader takes (calendar/lesson-roster.ts), its class and the groups
 * joined to it. Who is on it is the reader's to answer, so the lesson's
 * members are not selected here.
 */
const LESSON_SELECT = {
  id: true,
  schoolId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  subject: { select: { name: true } },
  room: { select: { name: true } },
  teachers: { select: { teacherId: true } },
  // The roster reader's: a replacing group takes its pupils off its subject.
  subjectId: true,
  studentGroupId: true,
  extraGroups: { select: { studentGroupId: true } },
} as const satisfies Prisma.CalendarLessonSelect;

type BroadcastLesson = Prisma.CalendarLessonGetPayload<{ select: typeof LESSON_SELECT }>;

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
      const lesson = await tx.calendarLesson.findUnique({ where: { id: calendarLessonId }, select: LESSON_SELECT });
      if (!lesson) return;
      await this.emitAll(tx, [lesson]);
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
   * The same select and the same roster read as notifyLessonChanged (the
   * spec compares the two): a broadcast is the same payload however many
   * there are.
   */
  async notifyLessonsChanged(tx: PrismaClient, calendarLessonIds: readonly string[]): Promise<void> {
    if (calendarLessonIds.length === 0) return;
    try {
      const lessons = await tx.calendarLesson.findMany({ where: { id: { in: [...calendarLessonIds] } }, select: LESSON_SELECT });
      await this.emitAll(tx, lessons);
    } catch {
      this.logger.warn(`Realtime broadcast failed [lessons=${calendarLessonIds.length}]`);
    }
  }

  /**
   * Who is on each lesson, asked of the one roster reader in a fixed number
   * of statements however many lessons there are, then one emit each.
   *
   * ACTIVE, the filter the notices use, on all three sources. The teacher app
   * replaces the lesson's pupils in its offline cache with studentIds, and its
   * own fetch of the lesson (mobile/src/services/roster.ts) asks the
   * register's route, which asks this reader with the same filter: a
   * broadcast with another filter would leave the register depending on
   * which of the two came last. Before the reader, the named pupils went
   * unfiltered, so a named pupil who had left was written back into the
   * cache by the next broadcast. The attendance check reads RECORDED, a
   * superset of this list, so every pupil it offers is accepted, and a
   * register queued before a pupil left still drains.
   */
  private async emitAll(tx: PrismaClient, lessons: readonly BroadcastLesson[]): Promise<void> {
    const rosters = await calendarLessonRosters(tx, lessons, { pupils: 'ACTIVE' });
    for (const lesson of lessons) this.emit(lesson, rosters.get(lesson.id) ?? new Set<string>());
  }

  private emit(lesson: BroadcastLesson, roster: ReadonlySet<string>): void {
    const payload: RealtimeLesson = {
      id: lesson.id,
      startTime: lesson.startsAt.toISOString(),
      endTime: lesson.endsAt.toISOString(),
      subjectName: lesson.subject.name,
      roomName: lesson.room?.name ?? '—',
      studentIds: [...roster],
      status: lesson.status,
    };

    this.gateway.emitLessonUpdated(
      lesson.schoolId,
      lesson.teachers.map((assignment) => assignment.teacherId),
      { lessonId: lesson.id, updatedLesson: payload },
    );
  }
}
