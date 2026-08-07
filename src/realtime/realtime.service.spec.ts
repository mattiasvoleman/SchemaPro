import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import type { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const LESSON_ID = '44444444-4444-4444-8444-444444444444';

describe('RealtimeService', () => {
  let service: RealtimeService;
  let tx: TxMock;
  let gateway: {
    emitMasterTimetableUpdated: jest.Mock;
    emitLessonUpdated: jest.Mock;
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
    };
    service = new RealtimeService(gateway as unknown as RealtimeGateway);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const client = () => tx as unknown as PrismaClient;

  const lessonRow = (overrides: Record<string, unknown> = {}) => ({
    id: LESSON_ID,
    schoolId: SCHOOL_ID,
    startsAt: new Date('2026-08-10T08:15:00.000Z'),
    endsAt: new Date('2026-08-10T09:00:00.000Z'),
    status: 'CANCELLED',
    subject: { name: 'Mathematics' },
    room: { name: 'A101' },
    teachers: [{ teacherId: 'teacher-1' }, { teacherId: 'teacher-2' }],
    studentGroup: { members: [{ id: 'student-1' }, { id: 'student-2' }] },
    ...overrides,
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

  describe('notifyLessonChanged', () => {
    it('reads the lesson through the caller’s transaction, filtering to active students', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(lessonRow());

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
              },
            },
          }),
        }),
      );
    });

    it('broadcasts the wire payload to the school and its teachers', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(lessonRow());

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
      tx.calendarLesson.findUnique.mockResolvedValue(lessonRow({ room: null }));

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
      tx.calendarLesson.findUnique.mockResolvedValue(lessonRow());
      gateway.emitLessonUpdated.mockImplementation(() => {
        throw new Error('socket.io down');
      });

      await expect(
        service.notifyLessonChanged(client(), LESSON_ID),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(LESSON_ID));
    });
  });
});
