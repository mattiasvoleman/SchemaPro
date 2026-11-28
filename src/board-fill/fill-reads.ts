import type { PrismaClient } from '@prisma/client';
import { ConflictReads } from '../calendar/conflict-reads';
import type { DayLesson } from '../calendar/master-lessons.service';
import { dayLessonOf } from '../swaps/swap-reads';
import type { SwapData } from '../swaps/swap-snapshot';
import type { SwapLesson } from '../swaps/swap-types';

/*
 * THE CLASH RULE'S READS FOR A FILL: the snapshot's day, and the lessons the fill has laid so far.
 *
 * The judge asks findConflicts what stands on a day. The database does not hold what the fill has laid until "Ta in", so the day is the snapshot's
 * (as the swap search reads it: SwapReads) with each lesson the fill lays added as it is laid, and the judge's word on the next brick is a word about
 * the school as it will stand. One lifetime: one proposal, one transaction. Never shared, never kept.
 */
export class FillReads extends ConflictReads {
  private readonly byDay = new Map<number, DayLesson[]>();

  constructor(lessons: readonly SwapLesson[]) {
    super();
    for (const lesson of lessons) this.add(lesson);
  }

  /** A lesson laid by the fill, in its place and its room. */
  add(lesson: SwapLesson): void {
    const row = dayLessonOf(lesson);
    const list = this.byDay.get(lesson.dayOfWeek);
    if (list) list.push(row);
    else this.byDay.set(lesson.dayOfWeek, [row]);
  }

  override dayLessons<T>(_academicYearId: string, dayOfWeek: number, excludeIds: readonly string[], _load: () => Promise<T>): Promise<T> {
    const excluded = new Set(excludeIds);
    return Promise.resolve((this.byDay.get(dayOfWeek) ?? []).filter((row) => !excluded.has(row.id)) as unknown as T);
  }

  /** Fills the group and roster caches for the whole year in a few statements, so that the rule's per-candidate roster reads come from memory. */
  async warm(tx: PrismaClient, data: SwapData): Promise<void> {
    const subjectIds = [...new Set(data.lessons.map((lesson) => lesson.subjectId))];
    const groupIds = data.groups.map((group) => group.id);
    await this.groupsInPlay(tx, groupIds, { subjectIds, academicYearId: data.academicYearId });
    await this.halvesOfClasses(tx, data.groups.filter((group) => group.kind === 'CLASS').map((group) => group.id));
    await this.pupilsOf(tx, data.basis, groupIds);
  }
}
