import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import { recordedReads } from '../../test/utils/recorded-reads';
import { Role } from '../auth/enums/role.enum';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import {
  APPROVED_LEAVE_NOTE,
  LEAVE_LIST_LIMIT,
  LEAVE_REQUEST_DECIDED,
  LEAVE_REQUEST_ENDS_BEFORE_START,
  LEAVE_REQUEST_TOO_LONG,
  LeaveService,
} from './leave.service';

/**
 * A row as Prisma returns it: only the fields the query selected, so a field
 * the service stopped selecting is undefined here as in production.
 */
const asSelected = (row: unknown, select?: Record<string, unknown>): unknown => {
  if (!select || row === null || typeof row !== 'object') return row;
  if (Array.isArray(row)) return row.map((item) => asSelected(item, select));
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, wanted]) => Boolean(wanted))
      .map(([field, wanted]) => [
        field,
        asSelected((row as Record<string, unknown>)[field], (wanted as { select?: Record<string, unknown> }).select),
      ]),
  );
};

const NOW = new Date('2027-02-10T08:00:00.000Z');
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const GUARDIAN_ID = '44444444-4444-4444-8444-444444444444';
const STUDENT_ID = '55555555-5555-4555-8555-555555555555';
const LINK_ID = '66666666-6666-4666-8666-666666666666';
const REQUEST_ID = '88888888-8888-4888-8888-888888888888';
const SCHOOL_ID = '99999999-9999-4999-8999-999999999999';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BERTIL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOTICE_A = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const NOTICE_B = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';

/** The SQL of a tagged-template $queryRaw call, with its values. */
const rawCall = (mock: jest.Mock, index = 0): { sql: string; values: unknown[] } => {
  const [strings, ...values] = mock.mock.calls[index] as [TemplateStringsArray, ...unknown[]];
  return { sql: strings.join('?'), values };
};

describe('LeaveService', () => {
  let service: LeaveService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let notifications: { notifyUsers: jest.Mock; deliver: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    notifications = { notifyUsers: jest.fn().mockResolvedValue(1), deliver: jest.fn() };
    service = new LeaveService(prisma as unknown as PrismaService, notifications as unknown as NotificationsService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const guardianUser = () => testUser({ role: Role.GUARDIAN, userId: GUARDIAN_ID, schoolId: SCHOOL_ID });
  const mentorUser = () => testUser({ role: Role.TEACHER, userId: ANNA, schoolId: SCHOOL_ID });

  // -----------------------------------------------------------------------
  // createLeaveRequest
  // -----------------------------------------------------------------------

  describe('createLeaveRequest', () => {
    const leaveDto = (overrides: Partial<Record<string, string>> = {}) => ({
      studentId: STUDENT_ID,
      startDate: '2027-02-15',
      endDate: '2027-02-16',
      reason: 'Familjeresa',
      ...overrides,
    });

    const notice = (userId: string, notificationId: string, email: string | null) => ({
      notificationId,
      userId,
      email,
      meta: { leaveRequestId: REQUEST_ID, studentName: 'Ella Elev', startDate: '2027-02-15', endDate: '2027-02-16', schoolDays: 2 },
    });

    const arrange = (told: unknown[] = []) => {
      tx.user.findUnique.mockImplementation(({ where, select }: { where?: { id?: string }; select?: Record<string, unknown> }) =>
        Promise.resolve(where?.id === STUDENT_ID ? asSelected({ id: STUDENT_ID, role: 'STUDENT', schoolId: SCHOOL_ID }, select) : null),
      );
      tx.guardianStudent.findFirst.mockResolvedValue({ id: LINK_ID });
      tx.leaveRequest.create.mockResolvedValue({ id: REQUEST_ID, studentId: STUDENT_ID, status: 'PENDING' });
      tx.$queryRaw = jest.fn().mockResolvedValue(told);
    };

    it('rejects an inverted date range with its code before opening a transaction', async () => {
      const error = await service
        .createLeaveRequest(leaveDto({ startDate: '2027-02-16', endDate: '2027-02-15' }) as never, guardianUser())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe('endDate must not be before startDate.');
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: LEAVE_REQUEST_ENDS_BEFORE_START });
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('persists the request undecided, with the pupil’s school and the requester', async () => {
      arrange();
      const user = guardianUser();

      await expect(service.createLeaveRequest(leaveDto() as never, user)).resolves.toEqual({
        id: REQUEST_ID,
        studentId: STUDENT_ID,
        status: 'PENDING',
      });

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.leaveRequest.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          studentId: STUDENT_ID,
          requestedById: GUARDIAN_ID,
          startDate: day('2027-02-15'),
          endDate: day('2027-02-16'),
          reason: 'Familjeresa',
        },
        select: { id: true, studentId: true, status: true },
      });
    });

    it('asks the database, in the same transaction, what its trigger told the deciding mentors of the new request', async () => {
      arrange();

      await service.createLeaveRequest(leaveDto() as never, guardianUser());

      const call = rawCall(tx.$queryRaw as jest.Mock);
      expect(call.sql).toContain('app.leave_request_notices(');
      expect(call.values).toEqual([REQUEST_ID]);
    });

    it('refuses a request of more than a year before opening a transaction, and takes one of exactly a year', async () => {
      const error = await service
        .createLeaveRequest(leaveDto({ startDate: '2027-01-01', endDate: '2028-01-02' }) as never, guardianUser())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: LEAVE_REQUEST_TOO_LONG, params: { days: 366 } });
      expect(prisma.withRls).not.toHaveBeenCalled();

      arrange();
      // 2028 is a leap year: its 366 days, the 1st of January to the 31st of December.
      await service.createLeaveRequest(leaveDto({ startDate: '2028-01-01', endDate: '2028-12-31' }) as never, guardianUser());
      expect(tx.leaveRequest.create).toHaveBeenCalledTimes(1);
    });

    it('hands the notices the database wrote to the delivery, with the mentors’ addresses and no reason', async () => {
      arrange([notice(ANNA, NOTICE_A, 'anna@skolan.se'), notice(BERTIL, NOTICE_B, null)]);

      await service.createLeaveRequest(leaveDto() as never, guardianUser());

      expect(notifications.deliver).toHaveBeenCalledTimes(1);
      const [deliveredTx, entry] = notifications.deliver.mock.calls[0];
      expect(deliveredTx).toBe(tx);
      expect(entry).toEqual({
        schoolId: SCHOOL_ID,
        type: 'LEAVE_REQUESTED',
        meta: notice(ANNA, NOTICE_A, null).meta,
        recipients: [
          { userId: ANNA, notificationId: NOTICE_A },
          { userId: BERTIL, notificationId: NOTICE_B },
        ],
        email: {
          subject: 'New leave request / Ny ledighetsansökan',
          body:
            'A leave request for Ella Elev (2027-02-15 – 2027-02-16, 2 school days) is waiting for your decision in SchemaPro.\n\n' +
            'En ledighetsansökan för Ella Elev (2027-02-15 – 2027-02-16, 2 skoldagar) väntar på ditt beslut i SchemaPro.',
          // A mentor with no address gets the inbox notice and the push only.
          recipients: [{ userId: ANNA, email: 'anna@skolan.se' }],
        },
      });
      expect(JSON.stringify(entry)).not.toContain('Familjeresa');
    });

    it('says "skoldag" of a one-day request', async () => {
      arrange([{ ...notice(ANNA, NOTICE_A, 'anna@skolan.se'), meta: { ...notice(ANNA, NOTICE_A, null).meta, schoolDays: 1 } }]);

      await service.createLeaveRequest(leaveDto() as never, guardianUser());

      const [, entry] = notifications.deliver.mock.calls[0];
      expect(entry.email.body).toContain('1 school day)');
      expect(entry.email.body).toContain('1 skoldag)');
    });

    it('tells nobody when the request is rektor’s to decide', async () => {
      arrange([]);

      await service.createLeaveRequest(leaveDto() as never, guardianUser());

      expect(notifications.deliver).not.toHaveBeenCalled();
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('forbids a guardian without a link to the pupil, before any write', async () => {
      arrange();
      tx.guardianStudent.findFirst.mockResolvedValue(null);

      await expect(service.createLeaveRequest(leaveDto() as never, guardianUser())).rejects.toThrow(ForbiddenException);
      expect(tx.leaveRequest.create).not.toHaveBeenCalled();
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('lets a pupil file for themselves, as pupil and requester', async () => {
      arrange();
      const user = testUser({ role: Role.STUDENT, userId: STUDENT_ID, schoolId: SCHOOL_ID });

      await service.createLeaveRequest(leaveDto() as never, user);

      expect(tx.guardianStudent.findFirst).not.toHaveBeenCalled();
      expect(tx.leaveRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ studentId: STUDENT_ID, requestedById: STUDENT_ID }) }),
      );
    });

    it('forbids a pupil filing for another pupil, before any read', async () => {
      arrange();
      const user = testUser({ role: Role.STUDENT, userId: GUARDIAN_ID, schoolId: SCHOOL_ID });

      await expect(service.createLeaveRequest(leaveDto() as never, user)).rejects.toThrow(
        new ForbiddenException('Students may only report for themselves.'),
      );
      expect(tx.user.findUnique).not.toHaveBeenCalled();
    });

    it('403s a principal without a userId before touching the database', async () => {
      await expect(service.createLeaveRequest(leaveDto() as never, testUser({ userId: undefined }))).rejects.toThrow(
        new ForbiddenException('No user identity is associated with this account.'),
      );
      expect(prisma.withRls).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // decideLeaveRequest
  // -----------------------------------------------------------------------

  describe('decideLeaveRequest', () => {
    const arrangePending = (overrides: Record<string, unknown> = {}) => {
      const row = {
        id: REQUEST_ID,
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        requestedById: GUARDIAN_ID,
        // Thursday before sportlov to the Tuesday after it.
        startDate: day('2027-02-18'),
        endDate: day('2027-03-02'),
        status: 'PENDING',
        reason: 'Familjeresa',
        student: { firstName: 'Ella', lastName: 'Elev', email: 'ella@skolan.se' },
        ...overrides,
      };
      tx.leaveRequest.findUnique.mockImplementation(({ where, select }: { where?: { id?: string }; select?: Record<string, unknown> }) =>
        Promise.resolve(where?.id === REQUEST_ID ? asSelected(row, select) : null),
      );
      tx.leaveRequest.updateMany.mockResolvedValue({ count: 1 });
      tx.absenceReport.createMany.mockResolvedValue({ count: 0 });
      tx.academicYear.findMany.mockResolvedValue([{ startDate: day('2026-08-17'), endDate: day('2027-06-11') }]);
      tx.schoolBreak.findMany.mockResolvedValue([
        { startDate: day('2027-02-22'), endDate: day('2027-02-26'), minGradeLevel: null, maxGradeLevel: null },
      ]);
      tx.studentEnrollment.findMany.mockResolvedValue([{ validFrom: day('2026-08-17'), validTo: null, gradeLevel: 8 }]);
    };

    const absenceDates = () =>
      (tx.absenceReport.createMany.mock.calls as Array<[{ data: Array<{ date: Date }> }]>).flatMap(([arg]) =>
        arg.data.map((row) => row.date.toISOString().slice(0, 10)),
      );

    it('records rektor’s approval as ADMIN, conditionally on the request still being pending', async () => {
      arrangePending();

      await expect(service.decideLeaveRequest(REQUEST_ID, { status: 'APPROVED' }, testUser())).resolves.toEqual({
        id: REQUEST_ID,
        status: 'APPROVED',
        decidedAs: 'ADMIN',
        absenceDays: 4,
      });

      expect(tx.leaveRequest.updateMany).toHaveBeenCalledWith({
        where: { id: REQUEST_ID, status: 'PENDING' },
        data: { status: 'APPROVED', decidedById: ADMIN_ID, decidedAs: 'ADMIN', decidedAt: NOW, decisionNote: null },
      });
    });

    it('writes one full-day absence per skoldag: not on the weekends, not on sportlovet', async () => {
      arrangePending();

      await service.decideLeaveRequest(REQUEST_ID, { status: 'APPROVED' }, testUser());

      expect(absenceDates()).toEqual(['2027-02-18', '2027-02-19', '2027-03-01', '2027-03-02']);
      expect(tx.absenceReport.createMany).toHaveBeenCalledTimes(1);
      for (const row of tx.absenceReport.createMany.mock.calls[0][0].data) {
        expect(row).toEqual({
          schoolId: SCHOOL_ID,
          studentId: STUDENT_ID,
          reportedById: ADMIN_ID,
          date: expect.any(Date),
          type: 'OTHER',
          note: APPROVED_LEAVE_NOTE,
        });
      }
      // The pupil's school days are read in the decider's transaction.
      expect(tx.schoolBreak.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { schoolId: SCHOOL_ID, startDate: { lte: day('2027-03-02') }, endDate: { gte: day('2027-02-18') } } }),
      );
    });

    it('writes no absence for a request that falls on a weekend, and says so', async () => {
      arrangePending({ startDate: day('2027-02-13'), endDate: day('2027-02-14') });

      await expect(service.decideLeaveRequest(REQUEST_ID, { status: 'APPROVED' }, testUser())).resolves.toMatchObject({
        absenceDays: 0,
      });
      expect(tx.absenceReport.createMany).not.toHaveBeenCalled();
    });

    it('records the mentor’s decision as MENTOR in their name, only while it is not passed on, and files the absence in it', async () => {
      arrangePending();

      await expect(service.decideLeaveRequest(REQUEST_ID, { status: 'APPROVED', note: 'Trevlig resa' }, mentorUser())).resolves.toEqual({
        id: REQUEST_ID,
        status: 'APPROVED',
        decidedAs: 'MENTOR',
        absenceDays: 4,
      });

      expect(tx.leaveRequest.updateMany).toHaveBeenCalledWith({
        where: { id: REQUEST_ID, status: 'PENDING', referredAt: null },
        data: { status: 'APPROVED', decidedById: ANNA, decidedAs: 'MENTOR', decidedAt: NOW, decisionNote: 'Trevlig resa' },
      });
      expect(tx.absenceReport.createMany.mock.calls[0][0].data.every((row: { reportedById: string }) => row.reportedById === ANNA)).toBe(true);
    });

    it('writes neither the family’s reason nor the decision note onto the absences teachers read', async () => {
      arrangePending();

      await service.decideLeaveRequest(REQUEST_ID, { status: 'APPROVED', note: 'Beviljas, begravningen är på fredag' }, testUser());

      expect(tx.leaveRequest.findUnique.mock.calls[0][0].select).not.toHaveProperty('reason');
      expect(JSON.stringify(tx.absenceReport.createMany.mock.calls)).not.toMatch(/Familjeresa|begravningen/);
    });

    it('rejects without writing any absence, keeping the note', async () => {
      arrangePending();

      await expect(service.decideLeaveRequest(REQUEST_ID, { status: 'REJECTED', note: 'Terminstid' }, testUser())).resolves.toEqual({
        id: REQUEST_ID,
        status: 'REJECTED',
        decidedAs: 'ADMIN',
        absenceDays: 0,
      });
      expect(tx.absenceReport.createMany).not.toHaveBeenCalled();
      expect(tx.leaveRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED', decisionNote: 'Terminstid' }) }),
      );
    });

    it('tells the requester, bilingually, with the role the decision was made in', async () => {
      arrangePending();

      await service.decideLeaveRequest(REQUEST_ID, { status: 'APPROVED', note: 'Ok' }, testUser());

      expect(notifications.notifyUsers).toHaveBeenCalledWith(tx, {
        schoolId: SCHOOL_ID,
        userIds: [GUARDIAN_ID],
        type: 'LEAVE_DECIDED',
        meta: { status: 'APPROVED', studentName: 'Ella Elev', startDate: '2027-02-18', endDate: '2027-03-02', note: 'Ok', decidedAs: 'ADMIN' },
        email: {
          subject: 'Leave request approved / Ledighetsansökan beviljad',
          body:
            'Leave request for Ella Elev (2027-02-18 – 2027-03-02) was approved.\nNote: Ok\n\n' +
            'Ledighetsansökan för Ella Elev (2027-02-18 – 2027-03-02) beviljades.',
        },
      });
    });

    it('says the mentor decided, in both languages', async () => {
      arrangePending();

      await service.decideLeaveRequest(REQUEST_ID, { status: 'REJECTED' }, mentorUser());

      expect(notifications.notifyUsers).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          meta: expect.objectContaining({ decidedAs: 'MENTOR' }),
          email: {
            subject: 'Leave request rejected / Ledighetsansökan avslagen',
            body:
              'Leave request for Ella Elev (2027-02-18 – 2027-03-02) was rejected by the mentor.\n\n' +
              'Ledighetsansökan för Ella Elev (2027-02-18 – 2027-03-02) avslogs av mentorn.',
          },
        }),
      );
    });

    it('lets rektor without a userId reject, recording no decider', async () => {
      arrangePending();

      await service.decideLeaveRequest(REQUEST_ID, { status: 'REJECTED' }, testUser({ userId: undefined }));

      expect(tx.leaveRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ decidedById: null, decidedAs: 'ADMIN' }) }),
      );
    });

    it('403s an approval by a principal without a userId: the absences are filed in the decider’s name', async () => {
      arrangePending();

      await expect(service.decideLeaveRequest(REQUEST_ID, { status: 'APPROVED' }, testUser({ userId: undefined }))).rejects.toThrow(
        new ForbiddenException('No user identity is associated with this account.'),
      );
      expect(tx.absenceReport.createMany).not.toHaveBeenCalled();
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('403s a mentor without a userId before the transaction: a mentor’s decision names the mentor', async () => {
      await expect(
        service.decideLeaveRequest(REQUEST_ID, { status: 'REJECTED' }, testUser({ role: Role.TEACHER, userId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('404s a request the caller’s transaction does not find: unknown, or never this mentor’s to decide', async () => {
      tx.leaveRequest.findUnique.mockResolvedValue(null);
      tx.$queryRaw = jest.fn().mockResolvedValue([{ taken: false }]);

      await expect(service.decideLeaveRequest(REQUEST_ID, { status: 'APPROVED' }, mentorUser())).rejects.toThrow(
        new NotFoundException('Leave request not found.'),
      );
      const call = rawCall(tx.$queryRaw as jest.Mock);
      expect(call.sql).toContain('app.leave_request_taken(');
      expect(call.values).toEqual([REQUEST_ID]);
      expect(tx.leaveRequest.updateMany).not.toHaveBeenCalled();
    });

    it('409s a mentor whose request is no longer theirs: a co-mentor or rektor decided it, or it was passed on', async () => {
      tx.leaveRequest.findUnique.mockResolvedValue(null);
      tx.$queryRaw = jest.fn().mockResolvedValue([{ taken: true }]);

      const error = await service.decideLeaveRequest(REQUEST_ID, { status: 'APPROVED' }, mentorUser()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: LEAVE_REQUEST_DECIDED });
      expect(tx.leaveRequest.updateMany).not.toHaveBeenCalled();
    });

    it('404s rektor’s unknown request without asking who had it: rektor reads every request of the school', async () => {
      tx.leaveRequest.findUnique.mockResolvedValue(null);
      tx.$queryRaw = jest.fn();

      await expect(service.decideLeaveRequest(REQUEST_ID, { status: 'REJECTED' }, testUser())).rejects.toThrow(NotFoundException);
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });

    it.each(['APPROVED', 'REJECTED'])('409s a %s request, writing nothing', async (status) => {
      arrangePending({ status });

      const error = await service.decideLeaveRequest(REQUEST_ID, { status: 'APPROVED' }, testUser()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: LEAVE_REQUEST_DECIDED });
      expect(tx.leaveRequest.updateMany).not.toHaveBeenCalled();
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('409s the second of two decisions: the first wins, and the second writes no absence and tells nobody', async () => {
      arrangePending();
      tx.leaveRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.decideLeaveRequest(REQUEST_ID, { status: 'APPROVED' }, mentorUser())).rejects.toThrow(ConflictException);
      expect(tx.absenceReport.createMany).not.toHaveBeenCalled();
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // referLeaveRequest
  // -----------------------------------------------------------------------

  describe('referLeaveRequest', () => {
    it('passes a pending request on through app.leave_request_refer', async () => {
      tx.leaveRequest.findUnique.mockResolvedValue({ status: 'PENDING' });
      tx.$queryRaw = jest.fn().mockResolvedValue([{ referred: true }]);

      await expect(service.referLeaveRequest(REQUEST_ID, mentorUser())).resolves.toEqual({ id: REQUEST_ID, referred: true });

      const call = rawCall(tx.$queryRaw as jest.Mock);
      expect(call.sql).toContain('app.leave_request_refer(');
      expect(call.values).toEqual([REQUEST_ID]);
    });

    it('404s a request the mentor does not read, without passing it on', async () => {
      tx.leaveRequest.findUnique.mockResolvedValue(null);
      tx.$queryRaw = jest.fn().mockResolvedValue([{ taken: false }]);

      await expect(service.referLeaveRequest(REQUEST_ID, mentorUser())).rejects.toThrow(NotFoundException);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(rawCall(tx.$queryRaw as jest.Mock).sql).toContain('app.leave_request_taken(');
    });

    it('409s a request that was the mentor’s and is no longer, without passing it on', async () => {
      tx.leaveRequest.findUnique.mockResolvedValue(null);
      tx.$queryRaw = jest.fn().mockResolvedValue([{ taken: true }]);

      await expect(service.referLeaveRequest(REQUEST_ID, mentorUser())).rejects.toThrow(ConflictException);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('409s a decided request, and one decided while it was passed on', async () => {
      tx.leaveRequest.findUnique.mockResolvedValue({ status: 'APPROVED' });
      await expect(service.referLeaveRequest(REQUEST_ID, mentorUser())).rejects.toThrow(ConflictException);

      tx.leaveRequest.findUnique.mockResolvedValue({ status: 'PENDING' });
      tx.$queryRaw = jest.fn().mockResolvedValue([{ referred: false }]);
      await expect(service.referLeaveRequest(REQUEST_ID, mentorUser())).rejects.toThrow(ConflictException);
    });
  });

  // -----------------------------------------------------------------------
  // listLeaveRequests
  // -----------------------------------------------------------------------

  describe('listLeaveRequests', () => {
    const OTHER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const pending = {
      id: REQUEST_ID,
      studentId: STUDENT_ID,
      requestedById: GUARDIAN_ID,
      startDate: day('2027-02-15'),
      endDate: day('2027-02-16'),
      reason: 'Familjeresa',
      status: 'PENDING',
      createdAt: new Date('2027-02-01T09:00:00.000Z'),
      decidedById: null,
      decidedAt: null,
      decisionNote: null,
      decidedAs: null,
      referredAt: null,
      referredById: null,
    };
    const decided = {
      ...pending,
      id: OTHER_ID,
      status: 'APPROVED',
      decidedById: ADMIN_ID,
      decidedAt: new Date('2027-02-02T10:00:00.000Z'),
      decisionNote: 'Ok',
      decidedAs: 'ADMIN',
      referredAt: new Date('2027-02-02T09:00:00.000Z'),
      referredById: ANNA,
    };
    const fact = (requestId: string, overrides: Record<string, unknown> = {}) => ({
      requestId,
      schoolDays: 2,
      mentorLimit: 3,
      mentorIds: [ANNA],
      decidingMentorIds: [ANNA],
      yearName: '2026/27',
      yearStart: day('2026-08-17'),
      yearEnd: day('2027-06-11'),
      yearApprovedDays: 5,
      yearApprovedRequests: 2,
      yearPendingRequests: 1,
      ...overrides,
    });
    const PEOPLE = [
      { id: STUDENT_ID, firstName: 'Ella', lastName: 'Elev', studentGroup: { name: '7A' } },
      { id: GUARDIAN_ID, firstName: 'Vera', lastName: 'Vårdnadshavare', studentGroup: null },
      { id: ANNA, firstName: 'Anna', lastName: 'Mentor', studentGroup: null },
      { id: ADMIN_ID, firstName: 'Rut', lastName: 'Rektor', studentGroup: null },
    ];

    beforeEach(() => {
      tx.leaveRequest.findMany.mockResolvedValue([pending, decided]);
      tx.$queryRaw = jest.fn().mockResolvedValue([fact(REQUEST_ID), fact(OTHER_ID, { decidingMentorIds: [] })]);
      tx.user.findMany.mockResolvedValue(PEOPLE);
    });

    it('reads the school’s requests of the status, newest first, and their facts in one call', async () => {
      await service.listLeaveRequests({ status: 'PENDING' }, testUser({ schoolId: SCHOOL_ID }));

      expect(tx.leaveRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { schoolId: SCHOOL_ID, status: 'PENDING' },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: LEAVE_LIST_LIMIT,
        }),
      );
      const call = rawCall(tx.$queryRaw as jest.Mock);
      expect(call.sql).toContain('app.leave_request_facts(');
      expect(call.values).toEqual([[REQUEST_ID, OTHER_ID]]);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('answers each row as the families have read it, and adds who decides it now, the mentors, the läsår so far and the names', async () => {
      const result = await service.listLeaveRequests({}, testUser({ schoolId: SCHOOL_ID }));

      expect(result[0]).toEqual({
        id: REQUEST_ID,
        studentId: STUDENT_ID,
        requestedById: GUARDIAN_ID,
        startDate: '2027-02-15',
        endDate: '2027-02-16',
        reason: 'Familjeresa',
        status: 'PENDING',
        decidedById: null,
        decidedAt: null,
        decisionNote: null,
        createdAt: '2027-02-01T09:00:00.000Z',
        decidedAs: null,
        student: { id: STUDENT_ID, name: 'Ella Elev', className: '7A' },
        requestedBy: 'Vera Vårdnadshavare',
        decidedByName: null,
        referral: null,
        schoolDays: 2,
        decides: 'MENTOR',
        mentors: [{ id: ANNA, name: 'Anna Mentor' }],
        decidingMentors: [{ id: ANNA, name: 'Anna Mentor' }],
        year: { name: '2026/27', startDate: '2026-08-17', endDate: '2027-06-11', approvedDays: 5, approvedRequests: 2, pendingRequests: 1 },
      });
      expect(result[1]).toMatchObject({
        decidedById: ADMIN_ID,
        decidedAt: '2027-02-02T10:00:00.000Z',
        decisionNote: 'Ok',
        decidedAs: 'ADMIN',
        decidedByName: 'Rut Rektor',
        referral: { by: 'Anna Mentor', at: '2027-02-02T09:00:00.000Z' },
        decides: null,
        decidingMentors: [],
      });
      // Rektor's delegation is GET /leave-delegation's, not the list's.
      expect(tx.leaveDelegationDecision.findFirst).not.toHaveBeenCalled();
    });

    it('reads every name in one call, and names nobody the caller may not read rather than failing', async () => {
      // RLS hides the guardian from this reader: a required relation would
      // throw, so the service reads the people beside the requests.
      tx.user.findMany.mockResolvedValue(PEOPLE.filter((person) => person.id !== GUARDIAN_ID));

      const result = await service.listLeaveRequests({}, testUser({ schoolId: SCHOOL_ID }));

      expect(tx.user.findMany).toHaveBeenCalledTimes(1);
      const [query] = tx.user.findMany.mock.calls[0] as [{ where: { id: { in: string[] } } }];
      expect([...query.where.id.in].sort()).toEqual([ADMIN_ID, ANNA, GUARDIAN_ID, STUDENT_ID].sort());
      expect(result[0]).toMatchObject({ requestedById: GUARDIAN_ID, requestedBy: null });
    });

    it('records rektor’s read as LEAVE_REQUESTS of the pupils, and PEOPLE of the others it names', async () => {
      await service.listLeaveRequests({}, testUser({ schoolId: SCHOOL_ID, channel: 'WEB' }));

      const reads = recordedReads(tx);
      expect(reads.map((read) => read.kind)).toEqual(['LEAVE_REQUESTS', 'PEOPLE']);
      expect(reads[0]).toEqual({ kind: 'LEAVE_REQUESTS', channel: 'WEB', ids: [STUDENT_ID] });
      expect([...reads[1]!.ids].sort()).toEqual([ADMIN_ID, ANNA, GUARDIAN_ID].sort());
    });

    it('records the mentor’s read as LEAVE_REASON_AS_MENTOR: the mentor read the family’s reason', async () => {
      await service.listLeaveRequests({}, testUser({ role: Role.TEACHER, userId: ANNA, schoolId: SCHOOL_ID, channel: 'WEB' }));

      expect(recordedReads(tx)[0]).toEqual({ kind: 'LEAVE_REASON_AS_MENTOR', channel: 'WEB', ids: [STUDENT_ID] });
    });

    it('answers a family its own requests without the facts, and records LEAVE_REQUESTS', async () => {
      tx.$queryRaw = jest.fn();

      const result = await service.listLeaveRequests({}, testUser({ role: Role.GUARDIAN, userId: GUARDIAN_ID, schoolId: SCHOOL_ID, channel: 'APP' }));

      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(result.map((request) => request.id)).toEqual([REQUEST_ID, OTHER_ID]);
      expect(result[1]).toMatchObject({
        reason: 'Familjeresa',
        decidedAs: 'ADMIN',
        decidedByName: 'Rut Rektor',
        decisionNote: 'Ok',
        schoolDays: null,
        decides: null,
        mentors: [],
        decidingMentors: [],
        year: null,
      });
      expect(recordedReads(tx)[0]).toEqual({ kind: 'LEAVE_REQUESTS', channel: 'APP', ids: [STUDENT_ID] });
    });

    it('a pending request no mentor decides is rektor’s', async () => {
      (tx.$queryRaw as jest.Mock).mockResolvedValue([fact(REQUEST_ID, { decidingMentorIds: [], mentorIds: [] }), fact(OTHER_ID)]);

      const result = await service.listLeaveRequests({}, testUser({ schoolId: SCHOOL_ID }));

      expect(result[0]).toMatchObject({ decides: 'ADMIN', mentors: [], decidingMentors: [] });
    });

    it('leaves out a row the facts do not answer for, and a year it does not know', async () => {
      (tx.$queryRaw as jest.Mock).mockResolvedValue([fact(OTHER_ID, { yearName: null, yearStart: null, yearEnd: null })]);

      const result = await service.listLeaveRequests({}, testUser({ schoolId: SCHOOL_ID }));

      expect(result.map((request) => request.id)).toEqual([OTHER_ID]);
      expect(result[0]!.year).toBeNull();
    });

    it('answers no year for a mentor’s decided request, where the facts weigh none (20261101090000)', async () => {
      // app.leave_request_facts gives a TEACHER's decided row no läsår and no
      // totals: the pupil may no longer be theirs.
      const none = { yearName: null, yearStart: null, yearEnd: null, yearApprovedDays: null, yearApprovedRequests: null, yearPendingRequests: null };
      tx.$queryRaw.mockResolvedValue([fact(REQUEST_ID), fact(OTHER_ID, { ...none, decidingMentorIds: [] })]);

      const result = await service.listLeaveRequests({}, testUser({ role: Role.TEACHER, userId: ANNA, schoolId: SCHOOL_ID }));

      expect(result[0]!.year).toMatchObject({ approvedDays: 5, approvedRequests: 2, pendingRequests: 1 });
      expect(result[1]!.year).toBeNull();
    });

    it('answers no year when the facts give the läsår without its totals', async () => {
      tx.$queryRaw.mockResolvedValue([fact(OTHER_ID, { yearApprovedDays: null })]);

      const result = await service.listLeaveRequests({}, testUser({ schoolId: SCHOOL_ID }));

      expect(result[0]!.year).toBeNull();
    });

    it('asks no facts and no names for an empty inbox, and records nothing', async () => {
      tx.leaveRequest.findMany.mockResolvedValue([]);
      tx.$queryRaw = jest.fn();

      await expect(service.listLeaveRequests({}, mentorUser())).resolves.toEqual([]);
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(tx.user.findMany).not.toHaveBeenCalled();
      expect(recordedReads(tx)).toEqual([]);
    });

    it('runs as the caller, so RLS decides which requests a mentor gets', async () => {
      const user = mentorUser();

      await service.listLeaveRequests({}, user);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
    });
  });

  // -----------------------------------------------------------------------
  // Rektor's delegation
  // -----------------------------------------------------------------------

  describe('delegation', () => {
    const recorded = { mentorMaxSchoolDays: 3, reference: 'Dnr 12', decidedAt: new Date('2027-02-10T08:00:00.000Z'), decidedById: ADMIN_ID };

    beforeEach(() => {
      tx.user.findMany.mockResolvedValue([{ id: ADMIN_ID, firstName: 'Rut', lastName: 'Rektor' }]);
    });

    it('records a decision for the caller’s school, with the reference trimmed, and answers it stamped', async () => {
      tx.leaveDelegationDecision.create.mockResolvedValue(recorded);

      await expect(
        service.recordDelegation({ mentorMaxSchoolDays: 3, reference: '  Dnr 12 ' }, testUser({ schoolId: SCHOOL_ID })),
      ).resolves.toEqual({ mentorMaxSchoolDays: 3, reference: 'Dnr 12', decidedAt: '2027-02-10T08:00:00.000Z', decidedBy: 'Rut Rektor' });
      expect(tx.leaveDelegationDecision.create).toHaveBeenCalledWith({
        data: { schoolId: SCHOOL_ID, mentorMaxSchoolDays: 3, reference: 'Dnr 12' },
        select: { mentorMaxSchoolDays: true, reference: true, decidedAt: true, decidedById: true },
      });
    });

    it('tells the mentors the decision gives pending requests to, in the same transaction, and queues their e-mail', async () => {
      tx.leaveDelegationDecision.create.mockResolvedValue(recorded);
      const meta = { leaveRequestId: REQUEST_ID, studentName: 'Ella Elev', startDate: '2027-02-15', endDate: '2027-02-16', schoolDays: 2 };
      tx.$queryRaw = jest.fn().mockResolvedValue([{ notificationId: NOTICE_A, userId: ANNA, email: 'anna@skolan.se', meta }]);

      await service.recordDelegation({ mentorMaxSchoolDays: 3 }, testUser({ schoolId: SCHOOL_ID }));

      expect(rawCall(tx.$queryRaw as jest.Mock).sql).toContain('app.leave_requests_tell_new_mentors()');
      expect(notifications.deliver).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          type: 'LEAVE_REQUESTED',
          recipients: [{ userId: ANNA, notificationId: NOTICE_A }],
          email: expect.objectContaining({ recipients: [{ userId: ANNA, email: 'anna@skolan.se' }] }),
        }),
      );
    });

    it('records "no delegation" as a decision of its own, and a blank reference as none', async () => {
      tx.leaveDelegationDecision.create.mockResolvedValue({ ...recorded, mentorMaxSchoolDays: null, reference: null });

      await service.recordDelegation({ mentorMaxSchoolDays: null, reference: '   ' }, testUser({ schoolId: SCHOOL_ID }));

      expect(tx.leaveDelegationDecision.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { schoolId: SCHOOL_ID, mentorMaxSchoolDays: null, reference: null } }),
      );
    });

    it('answers the decision in force first, and the history newest first', async () => {
      const older = { ...recorded, mentorMaxSchoolDays: null, decidedAt: new Date('2026-08-01T08:00:00.000Z'), decidedById: null };
      tx.leaveDelegationDecision.findMany.mockResolvedValue([recorded, older]);

      const result = await service.getDelegation(mentorUser());

      expect(tx.leaveDelegationDecision.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { schoolId: SCHOOL_ID }, orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }] }),
      );
      expect(result.current).toMatchObject({ mentorMaxSchoolDays: 3, decidedBy: 'Rut Rektor' });
      expect(result.history.map((entry) => entry.mentorMaxSchoolDays)).toEqual([3, null]);
      expect(result.history[1]!.decidedBy).toBeNull();
    });

    it('says there is no delegation when the school recorded none', async () => {
      await expect(service.getDelegation(testUser({ schoolId: SCHOOL_ID }))).resolves.toEqual({ current: null, history: [] });
    });
  });
});
