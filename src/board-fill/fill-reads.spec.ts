import type { PrismaClient } from '@prisma/client';
import { ConflictReads } from '../calendar/conflict-reads';
import { makeWorld } from '../swaps/__fixtures__/swap-world';
import type { SwapLesson } from '../swaps/swap-types';
import { FillReads } from './fill-reads';

/*
 * The clash rule's day for a fill: the snapshot's lessons and the ones the fill lays as it lays them, read from memory.
 */

const lesson = (id: string, day: number, start: number, over: Partial<SwapLesson> = {}): SwapLesson => ({
  id,
  subjectId: 's1',
  subjectName: 'Matematik',
  studentGroupId: 'c1',
  groupName: 'C1',
  teacherId: 't1',
  coTeacherId: null,
  roomId: 'r1',
  dayOfWeek: day,
  startMinutes: start,
  endMinutes: start + 60,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isLocked: false,
  isGenerated: true,
  extraGroupIds: [],
  studentIds: [],
  ...over,
});

describe('FillReads', () => {
  const load = jest.fn();

  it('answers a day with the lessons of the snapshot, less the ids the rule excludes, and never asks the database', async () => {
    const reads = new FillReads([lesson('a', 1, 480), lesson('b', 1, 540), lesson('c', 2, 480)]);
    const monday = await reads.dayLessons<Array<{ id: string }>>('year', 1, ['b'], load);
    expect(monday.map((row) => row.id)).toEqual(['a']);
    expect((await reads.dayLessons<unknown[]>('year', 3, [], load)).length).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });

  it('adds a lesson the fill has laid to its day, in its place and its room, so that the judge sees it for the next brick', async () => {
    const reads = new FillReads([lesson('a', 1, 480)]);
    reads.add(lesson('laid', 1, 600, { roomId: 'r2' }));
    reads.add(lesson('tuesday', 2, 480));
    const monday = await reads.dayLessons<Array<{ id: string; roomId: string | null; startTime: Date }>>('year', 1, [], load);
    expect(monday.map((row) => [row.id, row.roomId])).toEqual([['a', 'r1'], ['laid', 'r2']]);
    expect(monday[1]!.startTime.getUTCHours()).toBe(10);
    expect((await reads.dayLessons<unknown[]>('year', 2, [], load)).length).toBe(1);
  });

  it('warms the rule\'s caches for the year\'s groups and pupils in three reads', async () => {
    const groups = jest.spyOn(ConflictReads.prototype, 'groupsInPlay').mockResolvedValue(undefined as never);
    const halves = jest.spyOn(ConflictReads.prototype, 'halvesOfClasses').mockResolvedValue(undefined as never);
    const pupils = jest.spyOn(ConflictReads.prototype, 'pupilsOf').mockResolvedValue(undefined as never);
    const { data } = makeWorld({ seed: 2, classes: 2, perClass: 3 });
    const tx = {} as PrismaClient;
    await new FillReads(data.lessons).warm(tx, data);
    expect(groups).toHaveBeenCalledWith(tx, ['c1', 'c2'], { subjectIds: expect.any(Array), academicYearId: data.academicYearId });
    expect(halves).toHaveBeenCalledWith(tx, ['c1', 'c2']);
    expect(pupils).toHaveBeenCalledWith(tx, data.basis, ['c1', 'c2']);
    jest.restoreAllMocks();
  });
});
