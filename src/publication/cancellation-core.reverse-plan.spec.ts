import type { PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { reversePlan, type BatchRow } from './cancellation-core';

jest.mock('./publish-mode', () => ({ publishModeOf: jest.fn().mockResolvedValue('DIRECT') }));

/**
 * Reversing a cancellation puts each lesson back in its room unless the room
 * is taken by then. A hall the school lets several groups use at once (Delade
 * salar) is not taken by a lesson that fits it beside this one: the generator
 * put the two there together.
 */
type Query = { where?: Record<string, any> };

const SCHOOL = 'school-1';
const HALL = 'hall';
const OTHER_GROUP = 'group-b';
const STARTS = new Date('2026-08-12T08:00:00.000Z');
const ENDS = new Date('2026-08-12T09:00:00.000Z');

describe('reversePlan and a shared room', () => {
  let tx: TxMock;
  const client = () => tx as unknown as PrismaClient;
  const batch = { id: 'batch-1', cause: 'EVENT', academicYearId: 'year-1' } as unknown as BatchRow;

  /** A Wednesday lesson, 08:00-09:00 UTC, cancelled by the batch, whose master still runs it there. */
  const arrange = (mode: 'OFF' | 'SOFT' | 'HARD', room: { canBeShared: boolean; capacity: number | null } | null) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    tx = createTxMock();
    tx.cancellationBatchLesson.findMany.mockResolvedValue([
      {
        previousNote: null,
        calendarLesson: {
          id: 'cl-1',
          date: new Date('2026-08-12T00:00:00.000Z'),
          startsAt: STARTS,
          endsAt: ENDS,
          status: 'CANCELLED',
          cancelCause: 'EVENT',
          roomId: HALL,
          masterLessonId: 'm-1',
          _count: { attendanceRecords: 0 },
        },
      },
    ]);
    tx.masterLesson.findMany.mockResolvedValue([
      {
        id: 'm-1',
        isParked: false,
        dayOfWeek: 3,
        startTime: new Date('1970-01-01T08:00:00.000Z'),
        endTime: new Date('1970-01-01T09:00:00.000Z'),
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
      },
    ]);
    // Another lesson stands in the hall at the same hour.
    tx.calendarLesson.findFirst.mockResolvedValue({ id: 'cl-2' });
    tx.roomBooking.findFirst.mockResolvedValue(null);
    tx.lunchSetting.findUnique.mockResolvedValue({ placementSharedMode: mode });
    tx.room.findMany.mockImplementation((query: Query = {}) =>
      Promise.resolve(room !== null && query.where?.['canBeShared'] ? [{ id: HALL, ...room }] : []),
    );
    const lessonRow = (id: string, studentGroupId: string) => ({
      id,
      startsAt: STARTS,
      endsAt: ENDS,
      subjectId: 'subject-1',
      studentGroupId,
      extraGroups: [],
    });
    tx.calendarLesson.findMany.mockResolvedValue([lessonRow('cl-1', 'group-a'), lessonRow('cl-2', OTHER_GROUP)]);
    tx.user.findMany.mockImplementation((query: Query = {}) =>
      Promise.resolve(
        [
          { id: 'a1', studentGroupId: 'group-a' },
          { id: 'a2', studentGroupId: 'group-a' },
          { id: 'b1', studentGroupId: OTHER_GROUP },
          { id: 'b2', studentGroupId: OTHER_GROUP },
        ].filter((pupil) => query.where?.['studentGroupId']?.in?.includes(pupil.studentGroupId)),
      ),
    );
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  it('puts the lesson back into a shared hall that holds both classes’ pupils', async () => {
    arrange('HARD', { canBeShared: true, capacity: 4 });
    const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
    expect(plan.reinstate.map((entry) => entry.id)).toEqual(['cl-1']);
    expect(plan.skipped).toEqual([]);
  });

  it('skips it as taken when their pupils together do not fit', async () => {
    arrange('SOFT', { canBeShared: true, capacity: 3 });
    const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
    expect(plan.reinstate).toEqual([]);
    expect(plan.skipped).toEqual([expect.objectContaining({ lessonId: 'cl-1', roomId: HALL, by: 'LESSON' })]);
  });

  it('skips it as before for a room not marked, a room without a capacity, or the rule off', async () => {
    for (const [mode, room] of [
      ['HARD', null],
      ['HARD', { canBeShared: true, capacity: null }],
      ['OFF', { canBeShared: true, capacity: 100 }],
    ] as const) {
      arrange(mode, room);
      const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
      expect(plan.skipped).toEqual([expect.objectContaining({ lessonId: 'cl-1', by: 'LESSON' })]);
    }
  });

  it('asks nothing about the rule when no lesson stands in the room', async () => {
    arrange('HARD', { canBeShared: true, capacity: 4 });
    tx.calendarLesson.findFirst.mockResolvedValue(null);
    const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
    expect(plan.reinstate.map((entry) => entry.id)).toEqual(['cl-1']);
    expect(tx.lunchSetting.findUnique).not.toHaveBeenCalled();
  });
});
