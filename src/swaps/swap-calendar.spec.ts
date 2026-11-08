import type { LessonRecurrence, PrismaClient } from '@prisma/client';
import { createTxMock } from '../../test/utils/prisma-mock';
import { propagateTemplateChange, reconcilableLessons, wouldRemoveOnUpdate } from '../calendar/propagate-template';
import { removedCalendarLessons } from './swap-calendar';
import type { SwapLesson, SwapMove } from './swap-types';

/*
 * What a proposal would take out of the published calendar, said before it is
 * applied. The number is the write path's own rule asked of the same rows
 * (propagate-template's standsAt), so this spec holds the two to one answer:
 * the count asked beforehand is the `removed` that propagateTemplateChange
 * reports afterwards, case by case. The count and the write may differ by a
 * mutant only.
 */

const TZ = 'Europe/Stockholm';
/** Wednesday 14 October 2026, 10:00 in Stockholm: the week has begun, and so has this morning. */
const NOW = new Date('2026-10-14T08:00:00.000Z');
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const time = (h: number, m = 0) => new Date(Date.UTC(1970, 0, 1, h, m));

/** The date of the first `weekday` (1 = Monday) on or after `from`, and the same weekday for `weeks` weeks on. */
function weekly(weekday: number, weeks: number, from = '2026-10-14'): Array<{ date: Date }> {
  const start = day(from);
  const offset = (weekday - (start.getUTCDay() === 0 ? 7 : start.getUTCDay()) + 7) % 7;
  return Array.from({ length: weeks }, (_, week) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + offset + 7 * week);
    return { date };
  });
}

interface Case {
  name: string;
  from: number;
  to: number;
  /** Start of the new slot, as a clock; the old one is not asked. */
  at: [number, number];
  recurrence?: LessonRecurrence;
  endDate?: string | null;
  /** The rows the template has left to move: its weekday's, from today. */
  rows: Array<{ date: Date }>;
  removed: number;
}

const CASES: Case[] = [
  { name: 'a Friday lesson to Monday, in a week that has begun: this week’s row would land in the past', from: 5, to: 1, at: [8, 0], rows: weekly(5, 6), removed: 1 },
  { name: 'a Friday lesson to Wednesday 07:00, which began this morning', from: 5, to: 3, at: [7, 0], rows: weekly(5, 6), removed: 1 },
  { name: 'a Friday lesson to Wednesday 15:00, still ahead of today', from: 5, to: 3, at: [15, 0], rows: weekly(5, 6), removed: 0 },
  { name: 'a Monday lesson to Friday: every row moves forward', from: 1, to: 5, at: [8, 0], rows: weekly(1, 6), removed: 0 },
  { name: 'today’s lesson to an earlier hour of today', from: 3, to: 3, at: [8, 0], rows: weekly(3, 6, '2026-10-14'), removed: 1 },
  { name: 'a Tuesday lesson whose period ends on Wednesday 21 October, moved to Friday: the Friday is past its end', from: 2, to: 5, at: [9, 0], endDate: '2026-10-21', rows: weekly(2, 6), removed: 6 },
  { name: 'an odd-weeks lesson moved to Monday, with an even week among the rows: it does not run there', from: 5, to: 1, at: [8, 0], recurrence: 'ODD_WEEKS', rows: weekly(5, 6), removed: 3 },
  { name: 'a Wednesday lesson to Friday, an alternating week included', from: 3, to: 5, at: [8, 0], recurrence: 'EVEN_WEEKS', rows: weekly(3, 6), removed: 3 },
];

describe('the number said beforehand is the number the write path removes', () => {
  it.each(CASES)('$name', async ({ from, to, at, recurrence, endDate, rows, removed }) => {
    const after = {
      dayOfWeek: to,
      startTime: time(...at),
      endTime: time(at[0] + 1, at[1]),
      recurrence: recurrence ?? ('ALL_WEEKS' as const),
      startDate: null,
      endDate: endDate ? day(endDate) : null,
      roomId: null,
      teacherId: null,
    };

    const asked = wouldRemoveOnUpdate(rows, { dayOfWeek: from }, after, TZ, NOW);

    const tx = createTxMock();
    tx.calendarLesson.findMany.mockResolvedValue(rows.map((row, index) => ({ id: `r${index}`, date: row.date })));
    const written = await propagateTemplateChange(tx as unknown as PrismaClient, { id: 'master', dayOfWeek: from, teacherId: null }, after, {
      timezone: TZ,
      schoolId: 'school',
      now: NOW,
    });

    expect(written.removed).toBe(removed);
    expect(asked).toBe(removed);
    // And what is removed is exactly what the write deletes.
    expect(tx.calendarLesson.deleteMany).toHaveBeenCalledTimes(removed > 0 ? 1 : 0);
  });
});

describe('removedCalendarLessons: per proposal, from one read', () => {
  const lesson = (id: string, over: Partial<SwapLesson> = {}): SwapLesson => ({
    id,
    subjectId: 's',
    subjectName: 'Matematik',
    studentGroupId: 'g',
    groupName: '7A',
    teacherId: null,
    coTeacherId: null,
    roomId: null,
    dayOfWeek: 5,
    startMinutes: 480,
    endMinutes: 540,
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    isLocked: false,
    isGenerated: true,
    extraGroupIds: [],
    studentIds: [],
    ...over,
  });
  const slot = (dayOfWeek: number) => ({ dayOfWeek, startMinutes: 480, endMinutes: 540 });
  const move = (lessonId: string, from: number, to: number): SwapMove => ({ lessonId, from: slot(from), to: slot(to) });

  const friday = lesson('fri', { dayOfWeek: 5 });
  const monday = lesson('mon', { dayOfWeek: 1 });
  const byId = new Map([friday, monday].map((l) => [l.id, l]));
  const rowsOf = (masterLessonId: string, weekday: number, weeks = 4) => weekly(weekday, weeks).map((row) => ({ masterLessonId, date: row.date }));

  function txOf(rows: Array<{ masterLessonId: string | null; date: Date }>) {
    return { calendarLesson: { findMany: jest.fn(async (_args: unknown) => rows) } };
  }

  it('says, per proposal, how many rows its moves take: Friday to Monday loses this week’s, Monday to Friday loses none', async () => {
    const tx = txOf([...rowsOf('fri', 5), ...rowsOf('mon', 1)]);
    // The swap of the two (Friday ↔ Monday), and a proposal that only moves Monday later.
    const counts = await removedCalendarLessons(
      tx as never,
      [[move('fri', 5, 1), move('mon', 1, 5)], [move('mon', 1, 5), move('fri', 5, 5)]],
      byId,
      TZ,
      NOW,
    );
    expect(counts).toEqual([1, 0]);
  });

  it('reads once, for every lesson of every proposal, by the rule that selects what the write path may rewrite', async () => {
    const tx = txOf([]);
    await removedCalendarLessons(tx as never, [[move('fri', 5, 1), move('mon', 1, 5)], [move('mon', 1, 2), move('fri', 5, 2)]], byId, TZ, NOW);
    expect(tx.calendarLesson.findMany).toHaveBeenCalledTimes(1);
    const args = tx.calendarLesson.findMany.mock.calls[0]![0] as { where: unknown; select: unknown };
    expect(Object.keys(args.where as object).sort()).toEqual(Object.keys(reconcilableLessons(['fri', 'mon'])).sort());
    expect(args.where).toMatchObject({ masterLessonId: { in: ['fri', 'mon'] }, status: 'SCHEDULED', attendanceRecords: { none: {} } });
  });

  it('counts a lesson with no future calendar rows as nothing, and reads nothing when there is nothing to ask', async () => {
    const tx = txOf([]);
    expect(await removedCalendarLessons(tx as never, [[move('fri', 5, 1), move('mon', 1, 5)]], byId, TZ, NOW)).toEqual([0]);
    const none = txOf([]);
    expect(await removedCalendarLessons(none as never, [], byId, TZ, NOW)).toEqual([]);
    expect(none.calendarLesson.findMany).not.toHaveBeenCalled();
  });

  it('counts a lesson on its own recurrence and period, as the write does', async () => {
    const odd = lesson('odd', { dayOfWeek: 5, recurrence: 'ODD_WEEKS' });
    const tx = txOf(rowsOf('odd', 5, 6));
    const [count] = await removedCalendarLessons(tx as never, [[move('odd', 5, 1), move('mon', 1, 5)]], new Map([[odd.id, odd], [monday.id, monday]]), TZ, NOW);
    expect(count).toBe(3);
  });
});
