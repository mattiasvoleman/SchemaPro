import type { PrismaClient } from '@prisma/client';
import { ConflictReads } from '../calendar/conflict-reads';
import type { DayLesson } from '../calendar/master-lessons.service';
import type { SwapData } from './swap-snapshot';
import type { SwapLesson, SwapSlot } from './swap-types';

/*
 * THE CLASH RULE'S READS, FROM THE SNAPSHOT.
 *
 * A search asks findConflicts hundreds of times with nothing written in
 * between, the situation an import is in (conflict-reads.ts), and gets the same
 * answer: the rule's facts are read once and each later question is answered
 * from memory. Not a new rule — the rule is findConflicts, untouched; only
 * where its day's lessons come from differs. The year's placed lessons were
 * read once by readSwapData in the transaction the search runs in, by the same
 * filter the rule's own read uses (the year, not parked), so the day the rule
 * asks for is the day the database would have given, less the ids it excludes.
 *
 * One lifetime: one search, one transaction. Never shared, never kept.
 */

const clock = (minutes: number): Date => new Date(Date.UTC(1970, 0, 1, Math.floor(minutes / 60), minutes % 60));
const dateOf = (value: string | null): Date | null => (value ? new Date(`${value}T00:00:00.000Z`) : null);

/** A lesson as the clash rule holds its day: with the slot it is asked about, or its own. */
export function dayLessonOf(lesson: SwapLesson, at: SwapSlot = lesson): DayLesson {
  return {
    id: lesson.id,
    teacherId: lesson.teacherId,
    coTeacherId: lesson.coTeacherId,
    roomId: lesson.roomId,
    studentGroupId: lesson.studentGroupId,
    subjectId: lesson.subjectId,
    startTime: clock(at.startMinutes),
    endTime: clock(at.endMinutes),
    recurrence: lesson.recurrence,
    startDate: dateOf(lesson.startDate),
    endDate: dateOf(lesson.endDate),
    subject: { name: lesson.subjectName },
    extraGroups: lesson.extraGroupIds.map((studentGroupId) => ({ studentGroupId })),
    participants: lesson.studentIds.map((studentId) => ({ studentId })),
  };
}

export class SwapReads extends ConflictReads {
  private readonly byDay = new Map<number, DayLesson[]>();

  constructor(lessons: readonly SwapLesson[]) {
    super();
    for (const lesson of lessons) {
      const list = this.byDay.get(lesson.dayOfWeek);
      const row = dayLessonOf(lesson);
      if (list) list.push(row);
      else this.byDay.set(lesson.dayOfWeek, [row]);
    }
  }

  override dayLessons<T>(
    _academicYearId: string,
    dayOfWeek: number,
    excludeIds: readonly string[],
    _load: () => Promise<T>,
  ): Promise<T> {
    const excluded = new Set(excludeIds);
    return Promise.resolve((this.byDay.get(dayOfWeek) ?? []).filter((row) => !excluded.has(row.id)) as unknown as T);
  }

  /**
   * Fills the group and roster caches for the whole year in a few statements,
   * so that the rule's per-candidate roster reads are answered from memory.
   */
  async warm(tx: PrismaClient, data: SwapData): Promise<void> {
    const subjectIds = [...new Set(data.lessons.map((lesson) => lesson.subjectId))];
    const groupIds = data.groups.map((group) => group.id);
    await this.groupsInPlay(tx, groupIds, { subjectIds, academicYearId: data.academicYearId });
    await this.halvesOfClasses(tx, data.groups.filter((group) => group.kind === 'CLASS').map((group) => group.id));
    await this.pupilsOf(tx, data.basis, groupIds);
  }
}
