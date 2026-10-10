import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import type { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

/**
 * A row as Prisma returns it: only the fields the query selected. The shared
 * mock resolves whatever a spec stubs, whole, so a field the service stopped
 * selecting would still reach its output here and be undefined in production.
 */
const asSelected = (row: unknown, select?: Record<string, unknown>): unknown => {
  if (!select || row === null || typeof row !== 'object') return row;
  if (Array.isArray(row)) return row.map((item) => asSelected(item, select));
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, wanted]) => Boolean(wanted))
      .map(([field, wanted]) => [
        field,
        asSelected(
          (row as Record<string, unknown>)[field],
          (wanted as { select?: Record<string, unknown> }).select,
        ),
      ]),
  );
};

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const LESSON_ID = '44444444-4444-4444-8444-444444444444';

describe('RealtimeService', () => {
  let service: RealtimeService;
  let tx: TxMock;
  let gateway: {
    emitMasterTimetableUpdated: jest.Mock;
    emitLessonUpdated: jest.Mock;
    emitCoverBoardUpdated: jest.Mock;
  };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    tx = createTxMock();
    gateway = {
      emitMasterTimetableUpdated: jest.fn(),
      emitLessonUpdated: jest.fn(),
      emitCoverBoardUpdated: jest.fn(),
    };
    service = new RealtimeService(gateway as unknown as RealtimeGateway);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const client = () => tx as unknown as PrismaClient;

  /** The lesson as the query returns it: only what it selected. */
  const arrangeLesson = (row: Record<string, unknown>) =>
    tx.calendarLesson.findUnique.mockImplementation(
      ({ select }: { select?: Record<string, unknown> }) =>
        Promise.resolve(asSelected(row, select)),
    );

  const lessonRow = (overrides: Record<string, unknown> = {}) => ({
    id: LESSON_ID,
    schoolId: SCHOOL_ID,
    startsAt: new Date('2026-08-10T08:15:00.000Z'),
    endsAt: new Date('2026-08-10T09:00:00.000Z'),
    status: 'CANCELLED',
    subject: { name: 'Mathematics' },
    room: { name: 'A101' },
    teachers: [{ teacherId: 'teacher-1' }, { teacherId: 'teacher-2' }],
    studentGroup: {
      members: [{ id: 'student-1' }, { id: 'student-2' }],
      teachingMembers: [],
    },
    extraGroups: [],
    participants: [],
    ...overrides,
  });

  describe('who a lesson update is about', () => {
    it('includes a teaching group’s roster, which no home class holds', async () => {
      // Ma71 has no home-class members by construction. The teacher app writes
      // this list straight into its offline cache, so an empty broadcast does
      // not merely fail to help — it wipes the roster the teacher is about to
      // take attendance with.
      arrangeLesson(
        lessonRow({
          studentGroup: {
            members: [],
            teachingMembers: [{ studentId: 'ma71-1' }, { studentId: 'ma71-2' }],
          },
        }),
      );

      await service.notifyLessonChanged(tx as never, LESSON_ID);

      const [, , message] = gateway.emitLessonUpdated.mock.calls[0] as [
        string,
        string[],
        { updatedLesson: { studentIds: string[] } },
      ];
      expect(message.updatedLesson.studentIds.sort()).toEqual(['ma71-1', 'ma71-2']);
    });

    it('gathers every class attending, plus pupils named individually', async () => {
      arrangeLesson(
        lessonRow({
          studentGroup: { members: [{ id: 'a' }], teachingMembers: [] },
          extraGroups: [
            {
              studentGroup: {
                members: [{ id: 'b' }],
                teachingMembers: [{ studentId: 'c' }],
              },
            },
          ],
          participants: [{ studentId: 'd' }],
        }),
      );

      await service.notifyLessonChanged(tx as never, LESSON_ID);

      const [, , message] = gateway.emitLessonUpdated.mock.calls[0] as [
        string,
        string[],
        { updatedLesson: { studentIds: string[] } },
      ];
      expect(message.updatedLesson.studentIds.sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('counts a pupil once when two sources name them', async () => {
      arrangeLesson(
        lessonRow({
          studentGroup: { members: [{ id: 'a' }], teachingMembers: [{ studentId: 'a' }] },
          participants: [{ studentId: 'a' }],
        }),
      );

      await service.notifyLessonChanged(tx as never, LESSON_ID);

      const [, , message] = gateway.emitLessonUpdated.mock.calls[0] as [
        string,
        string[],
        { updatedLesson: { studentIds: string[] } },
      ];
      expect(message.updatedLesson.studentIds).toEqual(['a']);
    });
  });

  describe('notifyMasterTimetableChanged', () => {
    it('broadcasts the school whose timetable changed', () => {
      service.notifyMasterTimetableChanged(SCHOOL_ID);

      expect(gateway.emitMasterTimetableUpdated).toHaveBeenCalledWith(
        SCHOOL_ID,
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it('swallows a gateway failure so the mutation never fails', () => {
      gateway.emitMasterTimetableUpdated.mockImplementation(() => {
        throw new Error('socket.io down');
      });

      expect(() => service.notifyMasterTimetableChanged(SCHOOL_ID)).not.toThrow();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(SCHOOL_ID),
      );
    });
  });

  describe('notifyCoverBoardChanged', () => {
    it('tells the admins the days that changed, with the instant, and nothing else', () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-14T06:00:00.000Z'));
      try {
        service.notifyCoverBoardChanged(SCHOOL_ID, '2026-10-14', '2026-10-15');
      } finally {
        jest.useRealTimers();
      }
      expect(gateway.emitCoverBoardUpdated).toHaveBeenCalledWith(SCHOOL_ID, {
        from: '2026-10-14',
        to: '2026-10-15',
        changedAt: '2026-10-14T06:00:00.000Z',
      });
    });

    it('swallows a gateway failure so the write never fails', () => {
      gateway.emitCoverBoardUpdated.mockImplementation(() => {
        throw new Error('socket.io down');
      });
      expect(() => service.notifyCoverBoardChanged(SCHOOL_ID, '2026-10-14', '2026-10-14')).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(SCHOOL_ID));
    });
  });

  describe('notifyLessonChanged', () => {
    it('reads the lesson through the caller’s transaction, filtering to active students', async () => {
      arrangeLesson(lessonRow());

      await service.notifyLessonChanged(client(), LESSON_ID);

      expect(tx.calendarLesson.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: LESSON_ID },
          select: expect.objectContaining({
            studentGroup: {
              select: {
                members: expect.objectContaining({
                  where: { role: 'STUDENT', isActive: true },
                }),
                // A teaching group holds nobody through that back-relation.
                teachingMembers: expect.objectContaining({
                  where: { student: { role: 'STUDENT', isActive: true } },
                }),
              },
            },
            // The same filter for every other class attending: a deactivated
            // pupil of an extra group is no more on the roster than one of the
            // home class.
            extraGroups: {
              select: {
                studentGroup: {
                  select: {
                    members: expect.objectContaining({
                      where: { role: 'STUDENT', isActive: true },
                    }),
                    teachingMembers: expect.objectContaining({
                      where: { student: { role: 'STUDENT', isActive: true } },
                    }),
                  },
                },
              },
            },
          }),
        }),
      );
    });

    it('broadcasts the wire payload to the school and its teachers', async () => {
      arrangeLesson(lessonRow());

      await service.notifyLessonChanged(client(), LESSON_ID);

      expect(gateway.emitLessonUpdated).toHaveBeenCalledWith(
        SCHOOL_ID,
        ['teacher-1', 'teacher-2'],
        {
          lessonId: LESSON_ID,
          updatedLesson: {
            id: LESSON_ID,
            startTime: '2026-08-10T08:15:00.000Z',
            endTime: '2026-08-10T09:00:00.000Z',
            subjectName: 'Mathematics',
            roomName: 'A101',
            studentIds: ['student-1', 'student-2'],
            status: 'CANCELLED',
          },
        },
      );
    });

    it('renders a roomless lesson with the em-dash placeholder', async () => {
      arrangeLesson(lessonRow({ room: null }));

      await service.notifyLessonChanged(client(), LESSON_ID);

      expect(gateway.emitLessonUpdated).toHaveBeenCalledWith(
        SCHOOL_ID,
        expect.any(Array),
        expect.objectContaining({
          updatedLesson: expect.objectContaining({ roomName: '—' }),
        }),
      );
    });

    it('stays silent when the lesson has vanished', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(null);

      await expect(
        service.notifyLessonChanged(client(), LESSON_ID),
      ).resolves.toBeUndefined();
      expect(gateway.emitLessonUpdated).not.toHaveBeenCalled();
      // A lesson deleted in the same transaction is nothing to warn about.
      expect(warn).not.toHaveBeenCalled();
    });

    it('swallows a lookup failure — broadcasting is best-effort', async () => {
      tx.calendarLesson.findUnique.mockRejectedValue(
        new Error('connection reset'),
      );

      await expect(
        service.notifyLessonChanged(client(), LESSON_ID),
      ).resolves.toBeUndefined();
      expect(gateway.emitLessonUpdated).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(LESSON_ID));
    });

    it('swallows an emit failure without rejecting the mutation', async () => {
      arrangeLesson(lessonRow());
      gateway.emitLessonUpdated.mockImplementation(() => {
        throw new Error('socket.io down');
      });

      await expect(
        service.notifyLessonChanged(client(), LESSON_ID),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(LESSON_ID));
    });
  });

  describe('notifyLessonsChanged (a bulk avbokning)', () => {
    it('reads every lesson in ONE statement with the single read\'s select, and emits each', async () => {
      arrangeLesson(lessonRow());
      await service.notifyLessonChanged(client(), LESSON_ID);
      const single = tx.calendarLesson.findUnique.mock.calls[0]![0].select;

      gateway.emitLessonUpdated.mockClear();
      tx.calendarLesson.findMany.mockImplementation(({ select }: { select?: Record<string, unknown> }) =>
        Promise.resolve([asSelected(lessonRow(), select), asSelected(lessonRow({ id: 'lesson-2' }), select)]),
      );
      await service.notifyLessonsChanged(client(), [LESSON_ID, 'lesson-2']);
      expect(tx.calendarLesson.findMany).toHaveBeenCalledTimes(1);
      expect(tx.calendarLesson.findMany.mock.calls[0]![0]).toEqual({
        where: { id: { in: [LESSON_ID, 'lesson-2'] } },
        select: single,
      });
      expect(gateway.emitLessonUpdated).toHaveBeenCalledTimes(2);
    });

    it('asks nothing for no lesson, and swallows a failure', async () => {
      await service.notifyLessonsChanged(client(), []);
      expect(tx.calendarLesson.findMany).not.toHaveBeenCalled();
      tx.calendarLesson.findMany.mockRejectedValue(new Error('connection reset'));
      await expect(service.notifyLessonsChanged(client(), [LESSON_ID])).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    });
  });
});
