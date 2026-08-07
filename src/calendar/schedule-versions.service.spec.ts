import {
  BadRequestException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import {
  ScheduleVersionsService,
  type VersionLesson,
} from './schedule-versions.service';

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const VERSION_ID = '55555555-5555-4555-8555-555555555555';
const SAFETY_ID = '66666666-6666-4666-8666-666666666666';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SUBJECT_ID = '77777777-7777-4777-8777-777777777777';
const GROUP_ID = '88888888-8888-4888-8888-888888888888';
const TEACHER_ID = '99999999-9999-4999-8999-999999999999';
const CO_TEACHER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOM_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXTRA_GROUP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STUDENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const CREATED_AT = new Date('2026-08-06T12:00:00.000Z');

/** parseHHMM builds times on the epoch day, UTC. */
const utcTime = (h: number, m: number) => new Date(Date.UTC(1970, 0, 1, h, m));

describe('ScheduleVersionsService', () => {
  let service: ScheduleVersionsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new ScheduleVersionsService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('list', () => {
    it('lists the year’s versions under the caller’s RLS context', async () => {
      const user = testUser();
      tx.scheduleVersion.findMany.mockResolvedValue([
        {
          id: VERSION_ID,
          academicYearId: YEAR_ID,
          name: 'Draft v1',
          lessonCount: 3,
          createdAt: CREATED_AT,
        },
      ]);

      await expect(service.list(YEAR_ID, user)).resolves.toEqual([
        {
          id: VERSION_ID,
          academicYearId: YEAR_ID,
          name: 'Draft v1',
          lessonCount: 3,
          createdAt: '2026-08-06T12:00:00.000Z',
        },
      ]);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.scheduleVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { academicYearId: YEAR_ID },
          orderBy: { createdAt: 'desc' },
        }),
      );
    });

    it('returns an empty list for a year with no snapshots', async () => {
      tx.scheduleVersion.findMany.mockResolvedValue([]);

      await expect(service.list(YEAR_ID, testUser())).resolves.toEqual([]);
    });
  });

  describe('create', () => {
    const arrangeYear = () => {
      tx.academicYear.findUnique.mockResolvedValue({
        id: YEAR_ID,
        schoolId: SCHOOL_ID,
      });
      tx.scheduleVersion.create.mockResolvedValue({
        id: VERSION_ID,
        academicYearId: YEAR_ID,
        name: 'Draft v1',
        lessonCount: 1,
        createdAt: CREATED_AT,
      });
    };

    /** One master lesson as `snapshot()` reads it back from Prisma. */
    const masterLessonRow = () => ({
      subjectId: SUBJECT_ID,
      studentGroupId: GROUP_ID,
      teacherId: TEACHER_ID,
      coTeacherId: null,
      roomId: ROOM_ID,
      dayOfWeek: 2,
      startTime: utcTime(8, 5),
      endTime: utcTime(9, 30),
      isLocked: true,
      extraGroups: [{ studentGroupId: EXTRA_GROUP_ID }],
      participants: [{ studentId: STUDENT_ID }],
    });

    it('404s when the academic year does not exist', async () => {
      tx.academicYear.findUnique.mockResolvedValue(null);

      await expect(
        service.create(YEAR_ID, 'Draft v1', testUser()),
      ).rejects.toThrow(new NotFoundException('Academic year not found.'));
      expect(tx.scheduleVersion.create).not.toHaveBeenCalled();
    });

    it('snapshots every master lesson with HH:MM times and flattened relations', async () => {
      arrangeYear();
      tx.masterLesson.findMany.mockResolvedValue([masterLessonRow()]);

      await service.create(YEAR_ID, 'Draft v1', testUser({ userId: USER_ID }));

      expect(tx.masterLesson.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { academicYearId: YEAR_ID } }),
      );
      expect(tx.scheduleVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            // Tenant comes from the year row the caller can see under RLS.
            schoolId: SCHOOL_ID,
            academicYearId: YEAR_ID,
            name: 'Draft v1',
            createdById: USER_ID,
            lessonCount: 1,
            lessons: [
              {
                subjectId: SUBJECT_ID,
                studentGroupId: GROUP_ID,
                teacherId: TEACHER_ID,
                coTeacherId: null,
                roomId: ROOM_ID,
                dayOfWeek: 2,
                startTime: '08:05',
                endTime: '09:30',
                isLocked: true,
                extraGroupIds: [EXTRA_GROUP_ID],
                studentIds: [STUDENT_ID],
              },
            ],
          }),
        }),
      );
    });

    it('returns the stored summary with an ISO timestamp', async () => {
      arrangeYear();
      tx.masterLesson.findMany.mockResolvedValue([masterLessonRow()]);
      const user = testUser();

      await expect(service.create(YEAR_ID, 'Draft v1', user)).resolves.toEqual({
        id: VERSION_ID,
        academicYearId: YEAR_ID,
        name: 'Draft v1',
        lessonCount: 1,
        createdAt: '2026-08-06T12:00:00.000Z',
      });
      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
    });

    it('stores a null author for a principal with no userId', async () => {
      arrangeYear();
      tx.masterLesson.findMany.mockResolvedValue([]);

      await service.create(YEAR_ID, 'Draft v1', testUser({ userId: undefined }));

      expect(tx.scheduleVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ createdById: null, lessonCount: 0 }),
        }),
      );
    });
  });

  describe('get', () => {
    it('returns the version with its lesson snapshot', async () => {
      const lessons = [{ subjectId: SUBJECT_ID }];
      tx.scheduleVersion.findUnique.mockResolvedValue({
        id: VERSION_ID,
        academicYearId: YEAR_ID,
        name: 'Draft v1',
        lessonCount: 1,
        createdAt: CREATED_AT,
        lessons,
      });

      await expect(service.get(VERSION_ID, testUser())).resolves.toEqual({
        id: VERSION_ID,
        academicYearId: YEAR_ID,
        name: 'Draft v1',
        lessonCount: 1,
        createdAt: '2026-08-06T12:00:00.000Z',
        lessons,
      });

      expect(tx.scheduleVersion.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: VERSION_ID } }),
      );
    });

    it('404s on an unknown version', async () => {
      tx.scheduleVersion.findUnique.mockResolvedValue(null);

      await expect(service.get(VERSION_ID, testUser())).rejects.toThrow(
        new NotFoundException('Schedule version not found.'),
      );
    });
  });

  describe('restore', () => {
    const fullLesson = (): VersionLesson => ({
      subjectId: SUBJECT_ID,
      studentGroupId: GROUP_ID,
      teacherId: TEACHER_ID,
      coTeacherId: CO_TEACHER_ID,
      roomId: ROOM_ID,
      dayOfWeek: 1,
      startTime: '08:15',
      endTime: '09:00',
      isLocked: true,
      extraGroupIds: [EXTRA_GROUP_ID],
      studentIds: [STUDENT_ID],
    });

    /** Optional fields absent — the restore must default them. */
    const minimalLesson = (): VersionLesson => ({
      subjectId: SUBJECT_ID,
      studentGroupId: GROUP_ID,
      teacherId: null,
      roomId: null,
      dayOfWeek: 5,
      startTime: '13:00',
      endTime: '14:40',
      isLocked: false,
    });

    const arrangeRestore = (
      lessons: unknown = [fullLesson(), minimalLesson()],
    ) => {
      tx.scheduleVersion.findUnique.mockResolvedValue({
        id: VERSION_ID,
        schoolId: SCHOOL_ID,
        academicYearId: YEAR_ID,
        name: 'Golden master',
        lessons,
      });
      // The safety snapshot taken before the wipe reads the year and the
      // current timetable, then writes its own version row.
      tx.academicYear.findUnique.mockResolvedValue({
        id: YEAR_ID,
        schoolId: SCHOOL_ID,
      });
      tx.masterLesson.findMany.mockResolvedValue([]);
      tx.scheduleVersion.create.mockResolvedValue({
        id: SAFETY_ID,
        academicYearId: YEAR_ID,
        name: 'Before restore of "Golden master"',
        lessonCount: 0,
        createdAt: CREATED_AT,
      });
      tx.masterLesson.deleteMany.mockResolvedValue({ count: 0 });
      tx.masterLesson.create.mockResolvedValue({});
      tx.scheduleChangeLog.create.mockResolvedValue({});
    };

    it('404s on an unknown version without touching the timetable', async () => {
      tx.scheduleVersion.findUnique.mockResolvedValue(null);

      await expect(service.restore(VERSION_ID, testUser())).rejects.toThrow(
        new NotFoundException('Schedule version not found.'),
      );
      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
    });

    it('takes an automatic safety snapshot before wiping the timetable', async () => {
      arrangeRestore();

      const result = await service.restore(VERSION_ID, testUser());

      expect(tx.scheduleVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'Before restore of "Golden master"',
            academicYearId: YEAR_ID,
            schoolId: SCHOOL_ID,
          }),
        }),
      );
      expect(result.safetyVersionId).toBe(SAFETY_ID);
      // The snapshot must exist before the wipe, or a failed restore has
      // nothing to revert to.
      const snapshotOrder =
        tx.scheduleVersion.create.mock.invocationCallOrder[0];
      const wipeOrder = tx.masterLesson.deleteMany.mock.invocationCallOrder[0];
      expect(snapshotOrder).toBeLessThan(wipeOrder);
    });

    it('rejects a malformed snapshot before deleting anything', async () => {
      arrangeRestore({ corrupted: true });

      await expect(service.restore(VERSION_ID, testUser())).rejects.toThrow(
        new BadRequestException('Version snapshot is malformed.'),
      );
      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.masterLesson.create).not.toHaveBeenCalled();
    });

    it('replaces the year’s lessons with the snapshot, remapping every field', async () => {
      arrangeRestore();

      await service.restore(VERSION_ID, testUser());

      expect(tx.masterLesson.deleteMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR_ID },
      });
      expect(tx.masterLesson.create).toHaveBeenCalledTimes(2);
      expect(tx.masterLesson.create).toHaveBeenNthCalledWith(1, {
        data: {
          schoolId: SCHOOL_ID,
          academicYearId: YEAR_ID,
          subjectId: SUBJECT_ID,
          studentGroupId: GROUP_ID,
          teacherId: TEACHER_ID,
          coTeacherId: CO_TEACHER_ID,
          roomId: ROOM_ID,
          dayOfWeek: 1,
          startTime: utcTime(8, 15),
          endTime: utcTime(9, 0),
          isLocked: true,
          extraGroups: {
            create: [{ schoolId: SCHOOL_ID, studentGroupId: EXTRA_GROUP_ID }],
          },
          participants: {
            create: [{ schoolId: SCHOOL_ID, studentId: STUDENT_ID }],
          },
        },
      });
      // Absent optionals default: null co-teacher, no extra groups/students.
      expect(tx.masterLesson.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          teacherId: null,
          coTeacherId: null,
          roomId: null,
          startTime: utcTime(13, 0),
          endTime: utcTime(14, 40),
          isLocked: false,
          extraGroups: { create: [] },
          participants: { create: [] },
        }),
      });
    });

    it('records the restore in the change log with the actor and safety id', async () => {
      arrangeRestore();

      await service.restore(VERSION_ID, testUser({ userId: USER_ID }));

      expect(tx.scheduleChangeLog.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          academicYearId: YEAR_ID,
          actorId: USER_ID,
          action: 'RESTORE',
          after: {
            versionId: VERSION_ID,
            versionName: 'Golden master',
            restoredLessons: 2,
            safetyVersionId: SAFETY_ID,
          },
        },
      });
    });

    it('logs a null actor when the principal has no userId', async () => {
      arrangeRestore();

      await service.restore(VERSION_ID, testUser({ userId: undefined }));

      expect(tx.scheduleChangeLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ actorId: null }),
        }),
      );
    });

    it('returns the restored count and runs under the caller’s RLS context', async () => {
      arrangeRestore();
      const user = testUser();

      await expect(service.restore(VERSION_ID, user)).resolves.toEqual({
        restoredLessons: 2,
        safetyVersionId: SAFETY_ID,
      });
      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(prisma.withSystemTransaction).not.toHaveBeenCalled();
    });

    it('restores an empty snapshot to an empty timetable', async () => {
      arrangeRestore([]);

      await expect(service.restore(VERSION_ID, testUser())).resolves.toEqual({
        restoredLessons: 0,
        safetyVersionId: SAFETY_ID,
      });
      expect(tx.masterLesson.deleteMany).toHaveBeenCalled();
      expect(tx.masterLesson.create).not.toHaveBeenCalled();
    });

    it('404s when the academic year behind the version has vanished', async () => {
      arrangeRestore();
      tx.academicYear.findUnique.mockResolvedValue(null);

      await expect(service.restore(VERSION_ID, testUser())).rejects.toThrow(
        new NotFoundException('Academic year not found.'),
      );
      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes an existing version', async () => {
      tx.scheduleVersion.findUnique.mockResolvedValue({ id: VERSION_ID });
      tx.scheduleVersion.delete.mockResolvedValue({ id: VERSION_ID });
      const user = testUser();

      await expect(service.remove(VERSION_ID, user)).resolves.toEqual({
        id: VERSION_ID,
      });
      expect(tx.scheduleVersion.delete).toHaveBeenCalledWith({
        where: { id: VERSION_ID },
      });
      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
    });

    it('404s on an unknown version without deleting', async () => {
      tx.scheduleVersion.findUnique.mockResolvedValue(null);

      await expect(service.remove(VERSION_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
      expect(tx.scheduleVersion.delete).not.toHaveBeenCalled();
    });
  });
});
