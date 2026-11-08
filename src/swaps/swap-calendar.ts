import type { PrismaClient } from '@prisma/client';
import { reconcilableLessons, wouldRemoveOnUpdate } from '../calendar/propagate-template';
import type { SwapLesson, SwapMove } from './swap-types';

/*
 * WHAT A PROPOSAL TAKES OUT OF THE PUBLISHED CALENDAR, said before it is applied.
 *
 * Applying a swap moves master lessons, and the published calendar follows
 * (propagateTemplateChange). A swap always sends at least one lesson to an
 * earlier weekday, and a calendar lesson that the move would carry to a time
 * that has already begun is not moved but removed — "never into the past" — with
 * its vikarie, its lesson log and the homework on it (ON DELETE CASCADE).
 * Undoing the swap puts the master lessons back; it does not put those rows
 * back. A hand edit tells the schemaläggare afterwards (editRemoved); a swap is
 * a choice among a dozen proposals and has to say it beforehand, per proposal.
 *
 * The count is the write path's own rule asked of the same rows, not a second
 * rule: wouldRemoveOnUpdate is propagateTemplateChange's removal decision
 * (standsAt) over the rows reconcilableLessons selects, and a spec holds the
 * two to the same number case by case (swap-calendar.spec.ts).
 */

const clock = (minutes: number): Date => new Date(Date.UTC(1970, 0, 1, Math.floor(minutes / 60), minutes % 60));
const dateOf = (value: string | null): Date | null => (value ? new Date(`${value}T00:00:00.000Z`) : null);

/**
 * For every proposal, the number of published calendar lessons its moves would
 * remove: one read of the future rows of every lesson any proposal moves, then
 * the rule in memory. Same order as `proposals`.
 */
export async function removedCalendarLessons(
  tx: PrismaClient,
  proposals: ReadonlyArray<readonly SwapMove[]>,
  lessonById: ReadonlyMap<string, SwapLesson>,
  timezone: string,
  now: Date = new Date(),
): Promise<number[]> {
  const ids = [...new Set(proposals.flatMap((moves) => moves.map((move) => move.lessonId)))];
  if (ids.length === 0) return proposals.map(() => 0);

  const rows = await tx.calendarLesson.findMany({
    where: reconcilableLessons(ids),
    select: { masterLessonId: true, date: true },
  });
  const datesOf = new Map<string, Array<{ date: Date }>>();
  for (const row of rows) {
    if (row.masterLessonId === null) continue;
    const list = datesOf.get(row.masterLessonId);
    if (list) list.push({ date: row.date });
    else datesOf.set(row.masterLessonId, [{ date: row.date }]);
  }

  return proposals.map((moves) =>
    moves.reduce((total, move) => {
      const lesson = lessonById.get(move.lessonId);
      if (!lesson) return total;
      return (
        total +
        wouldRemoveOnUpdate(
          datesOf.get(move.lessonId) ?? [],
          { dayOfWeek: move.from.dayOfWeek },
          {
            dayOfWeek: move.to.dayOfWeek,
            startTime: clock(move.to.startMinutes),
            endTime: clock(move.to.endMinutes),
            recurrence: lesson.recurrence,
            startDate: dateOf(lesson.startDate),
            endDate: dateOf(lesson.endDate),
          },
          timezone,
          now,
        )
      );
    }, 0),
  );
}
