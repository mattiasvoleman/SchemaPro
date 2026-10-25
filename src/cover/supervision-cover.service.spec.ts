import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import { recordedReads } from '../../test/utils/recorded-reads';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { CalendarLessonsService } from '../calendar/calendar-lessons.service';
import { CoverService } from './cover.service';
import { SupervisionCoverService } from './supervision-cover.service';

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const SHIFT = '44444444-4444-4444-8444-444444444444';
const ABSENCE = '55555555-5555-4555-8555-555555555555';
const YEAR = '66666666-6666-4666-8666-666666666666';
const AREA = '77777777-7777-4777-8777-777777777777';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const T = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const DATE = '2026-10-14'; // a Wednesday, CEST
const NOW = new Date('2026-10-14T06:00:00.000Z');
const PASS_START = new Date('2026-10-14T08:00:00.000Z'); // 10:00
const PASS_END = new Date('2026-10-14T08:20:00.000Z'); // 10:20
const clock = (time: string) => new Date(`1970-01-01T${time}:00.000Z`);

/** The SQL text of each raw statement, in order. */
const statements = (tx: TxMock) =>
  (tx.$executeRaw as jest.Mock).mock.calls.map(([sql]) => ({
    text: ((sql as { strings?: string[] }).strings ?? []).join('?'),
    values: (sql as { values?: unknown[] }).values ?? [],
  }));

describe('SupervisionCoverService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let realtime: { notifyLessonsChanged: jest.Mock; notifyCoverBoardChanged: jest.Mock; notifyLessonChanged: jest.Mock };
  let notifications: { notifyUsers: jest.Mock; recipientsForLessons: jest.Mock };
  let cover: CoverService;
  let service: SupervisionCoverService;
  /** Users the reads see: id → role and active. */
  let people: Map<string, { role: string; isActive: boolean }>;
  const admin = testUser({ schoolId: SCHOOL });

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    realtime = {
      notifyLessonChanged: jest.fn().mockResolvedValue(undefined),
      notifyLessonsChanged: jest.fn().mockResolvedValue(undefined),
      notifyCoverBoardChanged: jest.fn(),
    };
    notifications = { notifyUsers: jest.fn().mockResolvedValue(1), recipientsForLessons: jest.fn().mockResolvedValue([]) };
    const calendar = new CalendarLessonsService(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimeService,
      notifications as unknown as NotificationsService,
    );
    cover = new CoverService(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimeService,
      notifications as unknown as NotificationsService,
      calendar,
    );
    jest.spyOn(cover, 'now').mockReturnValue(NOW);
    service = new SupervisionCoverService(prisma as unknown as PrismaService, cover);

    people = new Map([
      [A, { role: 'TEACHER', isActive: true }],
      [S, { role: 'TEACHER', isActive: true }],
      [T, { role: 'TEACHER', isActive: true }],
    ]);
    tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    // Anna's Wednesday pass on the lågstadiegård, 10:00–10:20.
    tx.supervisionShift.findUnique.mockResolvedValue({
      id: SHIFT,
      academicYearId: YEAR,
      areaId: AREA,
      userId: A,
      dayOfWeek: 3,
      startTime: clock('10:00'),
      endTime: clock('10:20'),
      validFrom: null,
      validTo: null,
    });
    tx.supervisionArea.findMany.mockResolvedValue([
      { id: AREA, name: 'Lågstadiegården', siteId: null, minGradeLevel: 0, maxGradeLevel: 3 },
    ]);
    tx.academicYear.findMany.mockResolvedValue([
      { id: YEAR, startDate: new Date('2026-08-17T00:00:00Z'), endDate: new Date('2027-06-11T00:00:00Z'), gradeNumbering: 'NIOARIG' },
    ]);
    // Anna is away all of Wednesday.
    tx.teacherAbsence.findUnique.mockResolvedValue({
      id: ABSENCE,
      userId: A,
      startsAt: new Date('2026-10-13T22:00:00Z'),
      endsAt: new Date('2026-10-14T22:00:00Z'),
      status: 'ACTIVE',
    });
    tx.supervisionCover.findUnique.mockResolvedValue(null);
    tx.user.findMany.mockImplementation(async (args: { where: { id?: { in: string[] }; isActive?: boolean; role?: string } }) => {
      const ids = args.where.id?.in ?? [...people.keys()];
      return ids
        .filter((id) => people.has(id))
        .filter((id) => (args.where.isActive === undefined ? true : people.get(id)!.isActive === args.where.isActive))
        .filter((id) => (args.where.role === undefined ? true : people.get(id)!.role === args.where.role))
        .map((id) => ({ id, ...people.get(id)!, deactivatedAt: null }));
    });
  });

  const coverRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'cov-1',
    shiftId: SHIFT,
    date: new Date(`${DATE}T00:00:00.000Z`),
    areaId: AREA,
    startsAt: PASS_START,
    endsAt: PASS_END,
    absenceId: ABSENCE,
    absentTeacherId: A,
    decision: 'SUBSTITUTE',
    substituteId: S,
    decidedAt: new Date('2026-10-13T18:00:00Z'),
    ...overrides,
  });

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  describe('decide', () => {
    it('books a vikarie: the occurrence stored as decided, the absent teacher and the vikarie locked before the pass, the vikarie told', async () => {
      const result = await service.decide(SHIFT, DATE, { absenceId: ABSENCE, kind: 'SUBSTITUTE', substituteId: S, expected: 'OPEN' }, admin);
      expect(result).toEqual({ shiftId: SHIFT, date: DATE, warnings: [] });
      expect(tx.supervisionCover.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          schoolId: SCHOOL,
          shiftId: SHIFT,
          date: new Date(`${DATE}T00:00:00.000Z`),
          areaId: AREA,
          startsAt: PASS_START,
          endsAt: PASS_END,
          absenceId: ABSENCE,
          absentTeacherId: A,
          decision: 'SUBSTITUTE',
          substituteId: S,
        }),
      });
      // The per-teacher cover locks, sorted, then the pass FOR SHARE.
      const sent = statements(tx);
      const locks = sent.filter((s) => s.text.includes('cover-teacher:') || s.text.includes('FOR SHARE'));
      expect(locks.map((s) => (s.text.includes('FOR SHARE') ? 'pass' : s.values[0]))).toEqual([A, S, 'pass']);
      expect(notifications.notifyUsers).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          userIds: [S],
          type: 'SUPERVISION_COVER',
          meta: { areaName: 'Lågstadiegården', startsAt: PASS_START.toISOString(), endsAt: PASS_END.toISOString() },
        }),
      );
      expect(realtime.notifyCoverBoardChanged).toHaveBeenCalledWith(SCHOOL, DATE, DATE);
    });

    it('refuses a vikarie who teaches, is on another pass, is away or is no active teacher then', async () => {
      const decide = () =>
        service.decide(SHIFT, DATE, { absenceId: ABSENCE, kind: 'SUBSTITUTE', substituteId: S, expected: 'OPEN' }, admin);
      tx.calendarLessonTeacher.findMany.mockResolvedValueOnce([
        {
          teacherId: S,
          calendarLesson: {
            id: 'l', date: new Date(`${DATE}T00:00:00Z`), startsAt: new Date('2026-10-14T07:30:00Z'), endsAt: new Date('2026-10-14T08:30:00Z'),
            status: 'SCHEDULED', cancelCause: null, studentGroupId: 'g', subjectId: 's', roomId: null,
          },
        },
      ]);
      await expect(decide()).rejects.toMatchObject({ response: { code: 'SUPERVISION_SUBSTITUTE_BUSY' } });
      tx.supervisionShift.findMany.mockResolvedValueOnce([
        { id: 'other', userId: S, academicYearId: YEAR, dayOfWeek: 3, startTime: clock('10:10'), endTime: clock('10:30'), validFrom: null, validTo: null, covers: [] },
      ]);
      await expect(decide()).rejects.toMatchObject({ response: { code: 'SUPERVISION_SUBSTITUTE_BUSY' } });
      tx.teacherAbsence.findMany.mockResolvedValueOnce([{ userId: S, startsAt: NOW, endsAt: new Date('2026-10-14T22:00:00Z') }]);
      await expect(decide()).rejects.toMatchObject({ response: { code: 'SUBSTITUTE_IS_ABSENT' } });
      people.set(S, { role: 'TEACHER', isActive: false });
      await expect(decide()).rejects.toMatchObject({ response: { code: 'SUPERVISION_SUBSTITUTE_NOT_TEACHER' } });
      expect(tx.supervisionCover.create).not.toHaveBeenCalled();
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('refuses the absent teacher as their own vikarie, and a vikarie on NO_COVER', async () => {
      await expect(
        service.decide(SHIFT, DATE, { absenceId: ABSENCE, kind: 'SUBSTITUTE', substituteId: A, expected: 'OPEN' }, admin),
      ).rejects.toMatchObject({ response: { code: 'SUBSTITUTE_IS_ABSENT' } });
      await expect(
        service.decide(SHIFT, DATE, { absenceId: ABSENCE, kind: 'NO_COVER', substituteId: S, expected: 'OPEN' }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.decide(SHIFT, DATE, { absenceId: ABSENCE, kind: 'SUBSTITUTE', expected: 'OPEN' }, admin)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('warns of the rules a rektor may override, as a lesson’s pick', async () => {
      tx.teacherWorkRule.findMany.mockResolvedValueOnce([
        {
          userId: S,
          lunchMinutes: 20,
          lunchStartTime: clock('10:00'),
          lunchEndTime: clock('10:30'),
          minDailyRestMinutes: null,
          maxTeachingMinutesPerDay: null,
          preferredFreeDayOfWeek: null,
        },
      ]);
      const result = await service.decide(SHIFT, DATE, { absenceId: ABSENCE, kind: 'SUBSTITUTE', substituteId: S, expected: 'OPEN' }, admin);
      expect(result.warnings).toEqual([{ code: 'COVER_BREAKS_LUNCH', params: { minutes: 20 } }]);
      expect(tx.supervisionCover.create).toHaveBeenCalled();
    });

    it('leaves a pass without a vikarie (NO_COVER) and tells nobody', async () => {
      await service.decide(SHIFT, DATE, { absenceId: ABSENCE, kind: 'NO_COVER', expected: 'OPEN' }, admin);
      expect(tx.supervisionCover.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ decision: 'NO_COVER', substituteId: null }),
      });
      await settle();
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('answers COVER_STALE on a pass covered since, and replaces a vikarie who is away in place, telling both', async () => {
      tx.supervisionCover.findUnique.mockResolvedValue(coverRow());
      await expect(
        service.decide(SHIFT, DATE, { absenceId: ABSENCE, kind: 'SUBSTITUTE', substituteId: T, expected: 'OPEN' }, admin),
      ).rejects.toMatchObject({ response: { code: 'COVER_STALE', params: { current: 'COVERED' } } });
      tx.supervisionCover.findUnique.mockResolvedValue(coverRow({ decision: 'NO_COVER', substituteId: null }));
      await expect(
        service.decide(SHIFT, DATE, { absenceId: ABSENCE, kind: 'SUBSTITUTE', substituteId: T, expected: 'OPEN' }, admin),
      ).rejects.toMatchObject({ response: { code: 'COVER_STALE', params: { current: 'HANDLED' } } });

      // S is away now: the decision is stale and T takes the pass.
      tx.supervisionCover.findUnique.mockResolvedValue(coverRow());
      tx.teacherAbsence.findMany.mockImplementation(async (args: { where: { userId: { in: string[] } } }) =>
        args.where.userId.in.includes(S) ? [{ userId: S, startsAt: NOW, endsAt: new Date('2026-10-14T22:00:00Z') }] : [],
      );
      await service.decide(SHIFT, DATE, { absenceId: ABSENCE, kind: 'SUBSTITUTE', substituteId: T, expected: 'OPEN' }, admin);
      expect(tx.supervisionCover.update).toHaveBeenCalledWith({
        where: { id: 'cov-1' },
        data: expect.objectContaining({ decision: 'SUBSTITUTE', substituteId: T }),
      });
      expect(tx.supervisionCover.create).not.toHaveBeenCalled();
      expect(notifications.notifyUsers.mock.calls.map(([, call]) => [call.userIds, call.type])).toEqual([
        [[S], 'SUPERVISION_COVER_WITHDRAWN'],
        [[T], 'SUPERVISION_COVER'],
      ]);
    });

    it('is not the board’s when the absence is another person’s, withdrawn or misses the pass, or the pass does not run that day', async () => {
      const decide = (date = DATE) =>
        service.decide(SHIFT, date, { absenceId: ABSENCE, kind: 'NO_COVER', expected: 'OPEN' }, admin);
      tx.teacherAbsence.findUnique.mockResolvedValueOnce({ id: ABSENCE, userId: T, startsAt: NOW, endsAt: PASS_END, status: 'ACTIVE' });
      await expect(decide()).rejects.toBeInstanceOf(NotFoundException);
      tx.teacherAbsence.findUnique.mockResolvedValueOnce({ id: ABSENCE, userId: A, startsAt: NOW, endsAt: PASS_END, status: 'WITHDRAWN' });
      await expect(decide()).rejects.toBeInstanceOf(NotFoundException);
      // Away from 10:20: the pass ends as she leaves.
      tx.teacherAbsence.findUnique.mockResolvedValueOnce({ id: ABSENCE, userId: A, startsAt: PASS_END, endsAt: new Date('2026-10-14T22:00:00Z'), status: 'ACTIVE' });
      await expect(decide()).rejects.toMatchObject({ response: { code: 'SUPERVISION_COVER_NOT_AFFECTED' } });
      // A Thursday: the Wednesday pass does not run.
      await expect(decide('2026-10-15')).rejects.toMatchObject({ response: { code: 'SUPERVISION_COVER_NOT_AFFECTED' } });
      expect(tx.supervisionCover.create).not.toHaveBeenCalled();
    });

    it('changes nothing once the pass has ended', async () => {
      jest.spyOn(cover, 'now').mockReturnValue(PASS_END);
      await expect(
        service.decide(SHIFT, DATE, { absenceId: ABSENCE, kind: 'NO_COVER', expected: 'OPEN' }, admin),
      ).rejects.toMatchObject({ response: { code: 'SUPERVISION_COVER_HELD' } });
    });
  });

  describe('undo', () => {
    it('removes the decision and tells its vikarie the pass is off', async () => {
      tx.supervisionCover.findUnique.mockResolvedValue(coverRow());
      tx.teacherAbsence.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      await expect(service.undo(SHIFT, DATE, admin)).resolves.toEqual({ shiftId: SHIFT, date: DATE });
      expect(tx.supervisionCover.delete).toHaveBeenCalledWith({ where: { id: 'cov-1' } });
      expect(notifications.notifyUsers).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ userIds: [S], type: 'SUPERVISION_COVER_WITHDRAWN' }),
      );
      // The absent teacher's cover lock first, then the pass.
      const locks = statements(tx).filter((s) => s.text.includes('cover-teacher:') || s.text.includes('FOR SHARE'));
      expect(locks.map((s) => (s.text.includes('FOR SHARE') ? 'pass' : s.values[0]))).toEqual([A, 'pass']);
    });

    it('answers 404 without a decision or with one of a withdrawn absence, and 409 once the pass has ended', async () => {
      await expect(service.undo(SHIFT, DATE, admin)).rejects.toMatchObject({ response: { code: 'COVER_NO_DECISION' } });
      tx.supervisionCover.findUnique.mockResolvedValue(coverRow());
      tx.teacherAbsence.findUnique.mockResolvedValue({ status: 'WITHDRAWN' });
      await expect(service.undo(SHIFT, DATE, admin)).rejects.toBeInstanceOf(NotFoundException);
      tx.teacherAbsence.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      jest.spyOn(cover, 'now').mockReturnValue(PASS_END);
      await expect(service.undo(SHIFT, DATE, admin)).rejects.toBeInstanceOf(ConflictException);
      expect(tx.supervisionCover.delete).not.toHaveBeenCalled();
    });
  });

  describe('candidates', () => {
    it('ranks who may take the pass, leaves out the absent, the busy and the pass’s own teacher, and records the reads', async () => {
      // T teaches 10:00–11:00; S is free and has her own pass on the same yard on Mondays.
      tx.calendarLessonTeacher.findMany.mockResolvedValue([
        {
          teacherId: T,
          calendarLesson: {
            id: 'l', date: new Date(`${DATE}T00:00:00Z`), startsAt: PASS_START, endsAt: new Date('2026-10-14T09:00:00Z'),
            status: 'SCHEDULED', cancelCause: null, studentGroupId: 'g', subjectId: 's', roomId: null,
          },
        },
      ]);
      tx.teacherAbsence.findMany.mockResolvedValue([
        { userId: A, startsAt: new Date('2026-10-13T22:00:00Z'), endsAt: new Date('2026-10-14T22:00:00Z') },
      ]);
      tx.supervisionShift.findMany.mockImplementation(async (args: { where: { areaId?: string } }) =>
        args.where.areaId === AREA ? [{ userId: S }] : [],
      );
      const answer = await service.candidates(SHIFT, DATE, admin);
      expect(answer.candidates.map((c) => [c.userId, c.reasons.map((r) => r.code)])).toEqual([[S, ['KNOWS_AREA', 'NOT_ON_SITE']]]);
      expect(answer.excluded).toEqual([
        { userId: A, codes: [{ code: 'ON_LESSON', params: {} }, { code: 'ABSENT', params: {} }] },
        { userId: T, codes: [{ code: 'BUSY_LESSON', params: { lessonId: 'l' } }] },
      ]);
      expect(recordedReads(tx)).toEqual([
        { kind: 'EMPLOYMENT', channel: null, ids: [S] },
        { kind: 'STAFF_ABSENCES', channel: null, ids: [A] },
      ]);
    });

    it('answers 404 for a pass that does not run that day', async () => {
      await expect(service.candidates(SHIFT, '2026-10-15', admin)).rejects.toMatchObject({
        response: { code: 'SUPERVISION_COVER_NOT_AFFECTED' },
      });
    });
  });
});
