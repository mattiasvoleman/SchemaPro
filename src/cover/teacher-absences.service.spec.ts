import { Role } from '../auth/enums/role.enum';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { CalendarLessonsService } from '../calendar/calendar-lessons.service';
import { CoverService } from './cover.service';
import { fieldsOf, periodOf, TeacherAbsencesService } from './teacher-absences.service';

const TZ = 'Europe/Stockholm';
const SCHOOL = '33333333-3333-4333-8333-333333333333';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const ME = '66666666-6666-4666-8666-666666666666';
const OTHER = '77777777-7777-4777-8777-777777777777';
const REASON = '88888888-8888-4888-8888-888888888888';
const ABSENCE = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-10-14T05:00:00.000Z'); // 07:00 in Stockholm

const teacher = testUser({ role: Role.TEACHER, userId: ME });
const admin = testUser({ userId: ADMIN });

describe('absence periods', () => {
  it('whole days run from the school-local midnight of the first day to the one after the last', () => {
    expect(periodOf({ from: '2026-10-14', to: '2026-10-15', startTime: null, endTime: null }, TZ)).toEqual({
      startsAt: new Date('2026-10-13T22:00:00.000Z'),
      endsAt: new Date('2026-10-15T22:00:00.000Z'),
      wholeDays: true,
    });
  });

  it('part of a day: one date with both times, or a start on the first day and an end on the last', () => {
    expect(periodOf({ from: '2026-10-14', to: '2026-10-14', startTime: '10:00', endTime: '12:30' }, TZ)).toEqual({
      startsAt: new Date('2026-10-14T08:00:00.000Z'),
      endsAt: new Date('2026-10-14T10:30:00.000Z'),
      wholeDays: false,
    });
    expect(periodOf({ from: '2026-10-14', to: '2026-10-16', startTime: '13:00', endTime: null }, TZ).endsAt).toEqual(
      new Date('2026-10-16T22:00:00.000Z'),
    );
  });

  it('186 school-local days across the October change to winter time are accepted (186 days and an hour)', () => {
    const period = periodOf({ from: '2026-08-17', to: '2027-02-18', startTime: null, endTime: null }, TZ);
    const hours = (period.endsAt.getTime() - period.startsAt.getTime()) / 3_600_000;
    expect(hours).toBe(186 * 24 + 1);
  });

  it('refuses 187 days, a range backwards and an end before its start, naming the code', () => {
    const code = (input: Parameters<typeof periodOf>[0]) => {
      try {
        periodOf(input, TZ);
        return null;
      } catch (error) {
        return (error as { getResponse: () => { code: string } }).getResponse().code;
      }
    };
    expect(code({ from: '2026-08-17', to: '2027-02-19', startTime: null, endTime: null })).toBe('ABSENCE_RANGE');
    expect(code({ from: '2026-10-15', to: '2026-10-14', startTime: null, endTime: null })).toBe('ABSENCE_RANGE');
    expect(code({ from: '2026-10-14', to: '2026-10-14', startTime: '12:00', endTime: '11:00' })).toBe('ABSENCE_RANGE');
  });

  it('fieldsOf gives the form back from a stored period', () => {
    for (const input of [
      { from: '2026-10-14', to: '2026-10-15', startTime: null, endTime: null },
      { from: '2026-10-14', to: '2026-10-14', startTime: '10:00', endTime: '12:30' },
      { from: '2026-10-24', to: '2026-10-27', startTime: '13:00', endTime: '09:15' },
    ]) {
      expect(fieldsOf(periodOf(input, TZ), TZ)).toEqual(input);
    }
  });
});

describe('TeacherAbsencesService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let notifications: { notifyUsers: jest.Mock; recipientsForGroups: jest.Mock };
  let realtime: { notifyCoverBoardChanged: jest.Mock; notifyLessonsChanged: jest.Mock; notifyLessonChanged: jest.Mock };
  let service: TeacherAbsencesService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    notifications = { notifyUsers: jest.fn().mockResolvedValue(1), recipientsForGroups: jest.fn().mockResolvedValue([]) };
    realtime = { notifyCoverBoardChanged: jest.fn(), notifyLessonsChanged: jest.fn(), notifyLessonChanged: jest.fn() };
    const calendar = new CalendarLessonsService(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimeService,
      notifications as unknown as NotificationsService,
    );
    const cover = new CoverService(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimeService,
      notifications as unknown as NotificationsService,
      calendar,
    );
    jest.spyOn(cover, 'now').mockReturnValue(NOW);
    service = new TeacherAbsencesService(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimeService,
      notifications as unknown as NotificationsService,
      cover,
    );
    tx.school.findUnique.mockResolvedValue({ timezone: TZ });
    tx.user.findUnique.mockResolvedValue({ id: ME, role: 'TEACHER', isActive: true });
    tx.teacherAbsence.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: ABSENCE, status: 'ACTIVE', createdAt: NOW, ...data }),
    );
  });

  const code = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => null, (e: unknown) => e);
    return (error as { getResponse?: () => { code?: string } } | null)?.getResponse?.().code ?? String(error);
  };

  describe('create', () => {
    it('an admin registers anybody’s, from up to 30 days back, the school’s categories ensured first', async () => {
      tx.teacherAbsenceReason.findUnique.mockResolvedValue({ archivedAt: null });
      const view = await service.create({ userId: ME, from: '2026-10-14', to: '2026-10-14', reasonId: REASON }, admin);
      expect(view).toMatchObject({ userId: ME, wholeDays: true, reasonId: REASON, phase: 'ONGOING', selfReported: false });
      const ensure = (tx.$executeRaw.mock.calls[0]![0] as { sql: string }).sql;
      expect(ensure).toContain('ON CONFLICT ("schoolId", "builtin") WHERE "builtin" IS NOT NULL DO NOTHING');
      expect(await code(service.create({ userId: ME, from: '2026-09-13', to: '2026-09-14' }, admin))).toBe('ABSENCE_TOO_FAR_BACK');
      // Self-report is the admin's to be told of, not the admin's own.
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
      expect(realtime.notifyCoverBoardChanged).toHaveBeenCalledWith(SCHOOL, '2026-10-14', '2026-10-14');
    });

    it('refuses an archived or unknown category', async () => {
      tx.teacherAbsenceReason.findUnique.mockResolvedValue({ archivedAt: NOW });
      expect(await code(service.create({ userId: ME, from: '2026-10-14', to: '2026-10-14', reasonId: REASON }, admin))).toBe(
        'ABSENCE_REASON',
      );
    });

    it('refuses an inactive person, or somebody who is not staff', async () => {
      tx.user.findUnique.mockResolvedValue({ id: ME, role: 'STUDENT', isActive: true });
      expect(await code(service.create({ userId: ME, from: '2026-10-14', to: '2026-10-14' }, admin))).toBe('ABSENCE_PERSON');
    });

    it('a teacher reports only their own, only when the school allows it, from today', async () => {
      expect(await code(service.create({ userId: OTHER, from: '2026-10-14', to: '2026-10-14' }, teacher))).toBe('ABSENCE_NOT_YOURS');
      tx.coverSettings.findUnique.mockResolvedValue({ teacherSelfReport: false });
      expect(await code(service.create({ userId: ME, from: '2026-10-14', to: '2026-10-14' }, teacher))).toBe('ABSENCE_SELF_REPORT_OFF');
      tx.coverSettings.findUnique.mockResolvedValue({ teacherSelfReport: true });
      expect(await code(service.create({ userId: ME, from: '2026-10-13', to: '2026-10-14' }, teacher))).toBe('ABSENCE_TOO_FAR_BACK');
    });

    it('a whole day reported at 07:00 for today is accepted, and the admins are told the period, never the reason', async () => {
      tx.coverSettings.findUnique.mockResolvedValue({ teacherSelfReport: true });
      tx.teacherAbsenceReason.findUnique.mockResolvedValue({ archivedAt: null });
      tx.user.findMany.mockResolvedValue([{ id: ADMIN }]);
      const view = await service.create({ userId: ME, from: '2026-10-14', to: '2026-10-14', reasonId: REASON }, teacher);
      expect(view.selfReported).toBe(true);
      tx.user.findUnique.mockImplementation((query: { select: Record<string, boolean> }) =>
        Promise.resolve(query.select.firstName ? { firstName: 'Karin', lastName: 'Ek' } : { id: ME, role: 'TEACHER', isActive: true }),
      );
      notifications.notifyUsers.mockClear();
      await service.create({ userId: ME, from: '2026-10-14', to: '2026-10-14', reasonId: REASON }, teacher);
      // Who and when, so the admin need not open the register to know; never why.
      expect(notifications.notifyUsers).toHaveBeenCalledWith(tx, {
        schoolId: SCHOOL,
        userIds: [ADMIN],
        type: 'TEACHER_ABSENCE_REPORTED',
        meta: {
          absenceId: ABSENCE,
          userId: ME,
          teacherName: 'Karin Ek',
          startsAt: '2026-10-13T22:00:00.000Z',
          endsAt: '2026-10-14T22:00:00.000Z',
          wholeDays: true,
        },
      });
      expect(JSON.stringify(notifications.notifyUsers.mock.calls)).not.toContain(REASON);
    });

    it('an overlap is a 409 naming the other period — never its reason — under the person’s lock', async () => {
      tx.teacherAbsence.findFirst.mockResolvedValue({
        id: 'other',
        startsAt: new Date('2026-10-13T22:00:00.000Z'),
        endsAt: new Date('2026-10-14T22:00:00.000Z'),
      });
      const error = await service.create({ userId: ME, from: '2026-10-14', to: '2026-10-14' }, admin).catch((e: unknown) => e);
      const body = (error as { getResponse: () => Record<string, unknown> }).getResponse();
      expect(body).toMatchObject({ code: 'ABSENCE_OVERLAPS', params: { otherAbsenceId: 'other' } });
      expect(tx.teacherAbsence.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ select: { id: true, startsAt: true, endsAt: true } }),
      );
      const lock = tx.$executeRaw.mock.calls.map(([sql]) => (sql as { sql: string }).sql).find((sql) => sql.includes('cover-teacher'));
      expect(lock).toBeDefined();
      expect(tx.teacherAbsence.create).not.toHaveBeenCalled();
    });

    it('the EXCLUDE refusal (23P01), if the read raced it, is the same 409', async () => {
      const { Prisma } = jest.requireActual('@prisma/client');
      tx.teacherAbsence.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('x', { code: 'P2039', clientVersion: 'x', meta: { driverAdapterError: { cause: { originalCode: '23P01' } } } }),
      );
      expect(await code(service.create({ userId: ME, from: '2026-10-14', to: '2026-10-14' }, admin))).toBe('ABSENCE_OVERLAPS');
    });
  });

  describe('list', () => {
    it('current and coming by default, with each absence’s counts from the board’s own statement', async () => {
      tx.teacherAbsence.findMany.mockResolvedValue([
        {
          id: ABSENCE,
          userId: ME,
          startsAt: new Date('2026-10-13T22:00:00.000Z'),
          endsAt: new Date('2026-10-14T22:00:00.000Z'),
          wholeDays: true,
          reasonId: REASON,
          status: 'ACTIVE',
          createdByUserId: ADMIN,
          createdAt: NOW,
        },
      ]);
      tx.$queryRaw.mockResolvedValue([
        { absenceId: ABSENCE, absentTeacherId: ME, lessonId: 'l1', lessonStatus: 'SCHEDULED', decision: null, endsAt: new Date('2026-10-14T09:00:00Z'), startsAt: new Date('2026-10-14T08:00:00Z'), absenceStartsAt: new Date('2026-10-13T22:00:00Z'), absenceEndsAt: new Date('2026-10-14T22:00:00Z'), teachers: [], coveringSubstituteIds: [] },
        { absenceId: ABSENCE, absentTeacherId: ME, lessonId: 'l2', lessonStatus: 'CANCELLED', decision: null, endsAt: new Date('2026-10-14T11:00:00Z'), startsAt: new Date('2026-10-14T10:00:00Z'), absenceStartsAt: new Date('2026-10-13T22:00:00Z'), absenceEndsAt: new Date('2026-10-14T22:00:00Z'), teachers: [], coveringSubstituteIds: [] },
      ]);
      const [view] = await service.list({}, admin);
      expect(view).toMatchObject({ reasonId: REASON, phase: 'ONGOING', counts: { open: 1, cancelled: 1, covered: 0, handled: 0, passedOpen: 0 } });
      expect(tx.teacherAbsence.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'ACTIVE', endsAt: { gt: NOW } } }),
      );
      await service.list({ includeEnded: 'true', userId: ME, from: '2026-10-01', to: '2026-10-31' }, admin);
      expect(tx.teacherAbsence.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {
            userId: ME,
            endsAt: { gt: new Date('2026-09-30T22:00:00.000Z') },
            startsAt: { lt: new Date('2026-10-31T23:00:00.000Z') },
          },
        }),
      );
    });
  });

  describe('end, update and withdraw', () => {
    const current = (overrides: Record<string, unknown> = {}) => ({
      id: ABSENCE,
      userId: ME,
      startsAt: new Date('2026-10-13T22:00:00.000Z'),
      endsAt: new Date('2026-10-16T22:00:00.000Z'),
      wholeDays: true,
      reasonId: REASON,
      status: 'ACTIVE',
      createdByUserId: ME,
      createdAt: new Date('2026-10-14T04:30:00.000Z'),
      ...overrides,
    });
    beforeEach(() => {
      tx.teacherAbsence.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...current(), ...data }),
      );
      tx.coverSettings.findUnique.mockResolvedValue({ teacherSelfReport: true });
    });

    it('an admin may end it in the past but not before it started; never later than it was', async () => {
      tx.teacherAbsence.findUnique.mockResolvedValue(current());
      const ended = await service.end(ABSENCE, { at: '2026-10-14T03:00:00Z' }, admin);
      expect(ended.endsAt).toBe('2026-10-14T03:00:00.000Z');
      expect(await code(service.end(ABSENCE, { at: '2026-10-13T21:00:00Z' }, admin))).toBe('ABSENCE_END');
      expect(await code(service.end(ABSENCE, { at: '2026-10-20T00:00:00Z' }, admin))).toBe('ABSENCE_END');
    });

    it('a teacher’s end is never before now', async () => {
      tx.teacherAbsence.findUnique.mockResolvedValue(current());
      const ended = await service.end(ABSENCE, { at: '2026-10-14T00:00:00Z' }, teacher);
      expect(new Date(ended.endsAt).getTime()).toBeGreaterThan(NOW.getTime());
    });

    it('decisions on lessons still ahead outside the new period: 409 listing them, or undone when asked', async () => {
      tx.teacherAbsence.findUnique.mockResolvedValue(current());
      tx.teacherAbsenceCover.findMany.mockResolvedValue([{ calendarLessonId: 'l-ahead', decision: 'SUPERVISED_STUDY' }]);
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: 'l-ahead', startsAt: new Date('2026-10-16T08:00:00Z'), endsAt: new Date('2026-10-16T09:00:00Z') },
      ]);
      const error = await service.end(ABSENCE, { at: '2026-10-15T00:00:00Z' }, admin).catch((e: unknown) => e);
      expect((error as { getResponse: () => unknown }).getResponse()).toMatchObject({
        code: 'ABSENCE_HAS_DECISIONS',
        params: { count: 1, lessonId: 'l-ahead', decision: 'SUPERVISED_STUDY' },
      });
      expect(tx.teacherAbsence.update).not.toHaveBeenCalled();
    });

    it('a withdrawal with a decision on a held lesson is refused outright', async () => {
      tx.teacherAbsence.findUnique.mockResolvedValue(current());
      tx.teacherAbsenceCover.findMany.mockResolvedValue([{ calendarLessonId: 'l-held', decision: 'SUBSTITUTE' }]);
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: 'l-held', startsAt: new Date('2026-10-14T03:00:00Z'), endsAt: new Date('2026-10-14T04:00:00Z') },
      ]);
      expect(await code(service.withdraw(ABSENCE, true, admin))).toBe('ABSENCE_HAS_HELD_DECISIONS');
    });

    it('a teacher withdraws within the hour when nothing is decided, and not after it has started otherwise', async () => {
      tx.teacherAbsence.findUnique.mockResolvedValue(current());
      tx.teacherAbsenceCover.findMany.mockResolvedValue([]);
      const withdrawn = await service.withdraw(ABSENCE, false, teacher);
      expect(withdrawn.status).toBe('WITHDRAWN');
      expect(tx.teacherAbsence.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'WITHDRAWN', withdrawnAt: NOW, withdrawnByUserId: ME } }),
      );
      tx.teacherAbsence.findUnique.mockResolvedValue(current({ createdAt: new Date('2026-10-14T03:00:00.000Z') }));
      expect(await code(service.withdraw(ABSENCE, false, teacher))).toBe('ABSENCE_WITHDRAW_TOO_LATE');
    });

    it('an admin edit moves the period, keeps the reason unless told, and refuses a withdrawn absence', async () => {
      tx.teacherAbsence.findUnique.mockResolvedValue(current());
      tx.teacherAbsenceCover.findMany.mockResolvedValue([]);
      await service.update(ABSENCE, { to: '2026-10-15' }, admin);
      expect(tx.teacherAbsence.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { startsAt: new Date('2026-10-13T22:00:00.000Z'), endsAt: new Date('2026-10-15T22:00:00.000Z'), wholeDays: true },
        }),
      );
      tx.teacherAbsence.findUnique.mockResolvedValue(current({ status: 'WITHDRAWN' }));
      expect(await code(service.update(ABSENCE, { to: '2026-10-15' }, admin))).toBe('ABSENCE_WITHDRAWN');
    });
  });
});
