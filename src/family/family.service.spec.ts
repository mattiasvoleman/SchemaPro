import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import { Role } from '../auth/enums/role.enum';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { FamilyService } from './family.service';

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

const NOW = new Date('2026-08-07T08:00:00.000Z');
const GUARDIAN_ID = '44444444-4444-4444-8444-444444444444';
const STUDENT_ID = '55555555-5555-4555-8555-555555555555';
const LINK_ID = '66666666-6666-4666-8666-666666666666';
const REPORT_ID = '77777777-7777-4777-8777-777777777777';
const REQUEST_ID = '88888888-8888-4888-8888-888888888888';
const SCHOOL_ID = '99999999-9999-4999-8999-999999999999';
/** `testUser()`'s default userId — the acting admin in most tests. */
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';

describe('FamilyService', () => {
  let service: FamilyService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let notifications: { notifyUsers: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    notifications = { notifyUsers: jest.fn().mockResolvedValue(1) };
    service = new FamilyService(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationsService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const guardianUser = () =>
    testUser({ role: Role.GUARDIAN, userId: GUARDIAN_ID, schoolId: SCHOOL_ID });

  /**
   * The student as the school lookup finds them: by id, with only the columns
   * the query selected. Any other id is a row RLS does not show.
   */
  const arrangeStudentRow = () =>
    tx.user.findUnique.mockImplementation(
      ({ where, select }: { where?: { id?: string }; select?: Record<string, unknown> }) =>
        Promise.resolve(
          where?.id === STUDENT_ID
            ? asSelected({ id: STUDENT_ID, role: 'STUDENT', schoolId: SCHOOL_ID }, select)
            : null,
        ),
    );

  // -----------------------------------------------------------------------
  // createLink
  // -----------------------------------------------------------------------

  describe('createLink', () => {
    const linkDto = { guardianId: GUARDIAN_ID, studentId: STUDENT_ID };
    const guardianRow = { id: GUARDIAN_ID, role: 'GUARDIAN', schoolId: SCHOOL_ID };
    const studentRow = { id: STUDENT_ID, role: 'STUDENT', schoolId: SCHOOL_ID };

    /** Both users are looked up in one Promise.all — dispatch on the id. */
    const arrangeUsers = (guardian: unknown, student: unknown) => {
      tx.user.findUnique.mockImplementation(({ where, select }: any) =>
        Promise.resolve(
          asSelected(
            where?.id === GUARDIAN_ID
              ? guardian
              : where?.id === STUDENT_ID
                ? student
                : null,
            select,
          ),
        ),
      );
    };

    it('ensures the link idempotently under the admin’s RLS context', async () => {
      arrangeUsers(guardianRow, studentRow);
      tx.guardianStudent.upsert.mockResolvedValue({
        id: LINK_ID,
        guardianId: GUARDIAN_ID,
        studentId: STUDENT_ID,
      });
      const user = testUser();

      await expect(service.createLink(linkDto, user)).resolves.toEqual({
        id: LINK_ID,
        guardianId: GUARDIAN_ID,
        studentId: STUDENT_ID,
      });

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      // `update: {}` — re-linking an existing pair is a no-op, not an error.
      // The tenant on the row comes from the STUDENT record (SCHOOL_ID), not
      // from the principal (whose schoolId is testUser's default).
      expect(tx.guardianStudent.upsert).toHaveBeenCalledWith({
        where: {
          guardianId_studentId: {
            guardianId: GUARDIAN_ID,
            studentId: STUDENT_ID,
          },
        },
        create: {
          schoolId: SCHOOL_ID,
          guardianId: GUARDIAN_ID,
          studentId: STUDENT_ID,
        },
        update: {},
        select: { id: true, guardianId: true, studentId: true },
      });
    });

    it('rejects an unknown guardian', async () => {
      arrangeUsers(null, studentRow);

      await expect(service.createLink(linkDto, testUser())).rejects.toThrow(
        'guardianId must reference a GUARDIAN user.',
      );
      expect(tx.guardianStudent.upsert).not.toHaveBeenCalled();
    });

    it('rejects a guardianId pointing at a non-guardian', async () => {
      arrangeUsers({ ...guardianRow, role: 'TEACHER' }, studentRow);

      await expect(service.createLink(linkDto, testUser())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects an unknown student', async () => {
      arrangeUsers(guardianRow, null);

      await expect(service.createLink(linkDto, testUser())).rejects.toThrow(
        'studentId must reference a STUDENT user.',
      );
    });

    it('rejects a studentId pointing at a non-student', async () => {
      arrangeUsers(guardianRow, { ...studentRow, role: 'GUARDIAN' });

      await expect(service.createLink(linkDto, testUser())).rejects.toThrow(
        'studentId must reference a STUDENT user.',
      );
    });

    it('rejects a cross-school pairing', async () => {
      arrangeUsers(guardianRow, {
        ...studentRow,
        schoolId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });

      await expect(service.createLink(linkDto, testUser())).rejects.toThrow(
        'Guardian and student belong to different schools.',
      );
      expect(tx.guardianStudent.upsert).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // removeLink
  // -----------------------------------------------------------------------

  describe('removeLink', () => {
    it('deletes an existing link under the admin’s RLS context', async () => {
      tx.guardianStudent.findUnique.mockResolvedValue({ id: LINK_ID });
      tx.guardianStudent.delete.mockResolvedValue({ id: LINK_ID });
      const user = testUser();

      await expect(service.removeLink(LINK_ID, user)).resolves.toEqual({
        id: LINK_ID,
      });

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.guardianStudent.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: LINK_ID } }),
      );
      expect(tx.guardianStudent.delete).toHaveBeenCalledWith({
        where: { id: LINK_ID },
      });
    });

    it('404s on an unknown link and deletes nothing', async () => {
      tx.guardianStudent.findUnique.mockResolvedValue(null);

      await expect(service.removeLink(LINK_ID, testUser())).rejects.toThrow(
        new NotFoundException('Guardian link not found.'),
      );
      expect(tx.guardianStudent.delete).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // createAbsenceReport
  // -----------------------------------------------------------------------

  describe('createAbsenceReport', () => {
    const reportDto = (overrides: Partial<Record<string, string>> = {}) => ({
      studentId: STUDENT_ID,
      date: '2026-08-07',
      type: 'SICK',
      ...overrides,
    });

    const arrangeStudent = () => {
      arrangeStudentRow();
      tx.absenceReport.create.mockResolvedValue({
        id: REPORT_ID,
        studentId: STUDENT_ID,
        date: new Date('2026-08-07T00:00:00.000Z'),
      });
    };

    it('rejects startTime without endTime before opening a transaction', async () => {
      await expect(
        service.createAbsenceReport(
          reportDto({ startTime: '08:00' }) as any,
          testUser(),
        ),
      ).rejects.toThrow(
        'startTime and endTime must be provided together (omit both for full day).',
      );
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('rejects endTime without startTime', async () => {
      await expect(
        service.createAbsenceReport(
          reportDto({ endTime: '10:00' }) as any,
          testUser(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('lets a linked guardian file a full-day report', async () => {
      arrangeStudent();
      tx.guardianStudent.findFirst.mockResolvedValue({ id: LINK_ID });
      const user = guardianUser();

      await expect(
        service.createAbsenceReport(reportDto() as any, user),
      ).resolves.toEqual({
        id: REPORT_ID,
        studentId: STUDENT_ID,
        date: new Date('2026-08-07T00:00:00.000Z'),
      });

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.guardianStudent.findFirst).toHaveBeenCalledWith({
        where: { guardianId: GUARDIAN_ID, studentId: STUDENT_ID },
        select: { id: true },
      });
      expect(tx.absenceReport.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          studentId: STUDENT_ID,
          reportedById: GUARDIAN_ID,
          date: new Date('2026-08-07T00:00:00.000Z'),
          startTime: null,
          endTime: null,
          type: 'SICK',
          note: null,
        },
        select: { id: true, studentId: true, date: true },
      });
    });

    it('stores a timed absence as epoch-day Time values', async () => {
      arrangeStudent();
      tx.guardianStudent.findFirst.mockResolvedValue({ id: LINK_ID });

      await service.createAbsenceReport(
        reportDto({ startTime: '08:15', endTime: '10:00', note: 'Dentist' }) as any,
        guardianUser(),
      );

      expect(tx.absenceReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            startTime: new Date('1970-01-01T08:15:00.000Z'),
            endTime: new Date('1970-01-01T10:00:00.000Z'),
            note: 'Dentist',
          }),
        }),
      );
    });

    it('forbids a guardian without a link to the student', async () => {
      arrangeStudent();
      tx.guardianStudent.findFirst.mockResolvedValue(null);

      await expect(
        service.createAbsenceReport(reportDto() as any, guardianUser()),
      ).rejects.toThrow('Not a guardian of this student.');
      expect(tx.absenceReport.create).not.toHaveBeenCalled();
    });

    it('lets a student report for themselves without a guardianship lookup', async () => {
      arrangeStudent();
      const user = testUser({
        role: Role.STUDENT,
        userId: STUDENT_ID,
        schoolId: SCHOOL_ID,
      });

      await service.createAbsenceReport(reportDto() as any, user);

      expect(tx.guardianStudent.findFirst).not.toHaveBeenCalled();
      expect(tx.absenceReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reportedById: STUDENT_ID }),
        }),
      );
    });

    it('forbids a student reporting for another student', async () => {
      const user = testUser({ role: Role.STUDENT, userId: GUARDIAN_ID });

      await expect(
        service.createAbsenceReport(reportDto() as any, user),
      ).rejects.toThrow('Students may only report for themselves.');
      expect(tx.absenceReport.create).not.toHaveBeenCalled();
    });

    it('lets an admin report for any student, via withRls only', async () => {
      arrangeStudent();
      const user = testUser();

      await service.createAbsenceReport(reportDto() as any, user);

      expect(tx.guardianStudent.findFirst).not.toHaveBeenCalled();
      // Tenancy: a per-user request must never run under a service or
      // system transaction.
      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(prisma.withServicePrincipal).not.toHaveBeenCalled();
      expect(prisma.withSystemTransaction).not.toHaveBeenCalled();
      expect(prisma.withVerifiedSubject).not.toHaveBeenCalled();
    });

    it('forbids roles outside guardian/student/admin', async () => {
      await expect(
        service.createAbsenceReport(
          reportDto() as any,
          testUser({ role: Role.TEACHER }),
        ),
      ).rejects.toThrow('This role cannot report absences.');
    });

    it('404s when the student row does not exist', async () => {
      tx.user.findUnique.mockResolvedValue(null);

      await expect(
        service.createAbsenceReport(reportDto() as any, testUser()),
      ).rejects.toThrow('Student not found.');
      expect(tx.absenceReport.create).not.toHaveBeenCalled();
    });

    it('403s an admin principal without userId before touching the database', async () => {
      // AuthenticatedUser.userId is optional in the type, but reportedById is
      // a required column. No such principal reaches this route today:
      // JwtStrategy reads userId from the Users row for every tenant role, and
      // SYSTEM_ADMIN, the one principal without a row, is not in its @Roles.
      // The service checks anyway, so the invariant does not rest on that list
      // staying as it is, and it fails before the transaction, not at the
      // insert.
      arrangeStudent();

      await expect(
        service.createAbsenceReport(
          reportDto() as any,
          testUser({ userId: undefined }),
        ),
      ).rejects.toThrow(
        new ForbiddenException('No user identity is associated with this account.'),
      );
      expect(prisma.withRls).not.toHaveBeenCalled();
      expect(tx.absenceReport.create).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // removeAbsenceReport
  // -----------------------------------------------------------------------

  describe('removeAbsenceReport', () => {
    const arrangeReport = (overrides: Record<string, unknown> = {}) => {
      const row = {
        id: REPORT_ID,
        studentId: STUDENT_ID,
        reportedById: GUARDIAN_ID,
        // NOW is 2026-08-07T08:00Z, so this is "today" at UTC midnight.
        date: new Date('2026-08-07T00:00:00.000Z'),
        type: 'SICK',
        ...overrides,
      };
      // Found by its id only; any other id is a report RLS does not show.
      tx.absenceReport.findUnique.mockImplementation(({ where, select }: any) =>
        Promise.resolve(where?.id === REPORT_ID ? asSelected(row, select) : null),
      );
      tx.absenceReport.delete.mockResolvedValue({ id: REPORT_ID });
    };

    it('lets the reporter remove a report dated today (boundary: not past)', async () => {
      arrangeReport();
      const user = guardianUser();

      await expect(service.removeAbsenceReport(REPORT_ID, user)).resolves.toEqual(
        { id: REPORT_ID },
      );
      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.absenceReport.delete).toHaveBeenCalledWith({
        where: { id: REPORT_ID },
      });
    });

    it('lets an admin remove someone else’s report', async () => {
      arrangeReport({ date: new Date('2026-08-09T00:00:00.000Z') });

      await expect(
        service.removeAbsenceReport(REPORT_ID, testUser()),
      ).resolves.toEqual({ id: REPORT_ID });
    });

    it('forbids a non-admin who is not the reporter', async () => {
      arrangeReport();

      await expect(
        service.removeAbsenceReport(
          REPORT_ID,
          testUser({ role: Role.GUARDIAN, userId: 'someone-else' }),
        ),
      ).rejects.toThrow('Only the reporter may remove this report.');
      expect(tx.absenceReport.delete).not.toHaveBeenCalled();
    });

    it('refuses to remove a past report even for an admin', async () => {
      arrangeReport({ date: new Date('2026-08-06T00:00:00.000Z') });

      await expect(
        service.removeAbsenceReport(REPORT_ID, testUser()),
      ).rejects.toThrow('Past absence reports cannot be removed.');
      expect(tx.absenceReport.delete).not.toHaveBeenCalled();
    });

    it('404s on an unknown report', async () => {
      tx.absenceReport.findUnique.mockResolvedValue(null);

      await expect(
        service.removeAbsenceReport(REPORT_ID, testUser()),
      ).rejects.toThrow(new NotFoundException('Absence report not found.'));
    });
  });

  // -----------------------------------------------------------------------
  // createLeaveRequest
  // -----------------------------------------------------------------------

  describe('createLeaveRequest', () => {
    const leaveDto = (overrides: Partial<Record<string, string>> = {}) => ({
      studentId: STUDENT_ID,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
      reason: 'Family trip',
      ...overrides,
    });

    const arrangeStudent = () => {
      arrangeStudentRow();
      tx.leaveRequest.create.mockResolvedValue({
        id: REQUEST_ID,
        studentId: STUDENT_ID,
        status: 'PENDING',
      });
    };

    it('rejects an inverted date range before opening a transaction', async () => {
      await expect(
        service.createLeaveRequest(
          leaveDto({ startDate: '2026-08-12', endDate: '2026-08-10' }) as any,
          testUser(),
        ),
      ).rejects.toThrow('endDate must not be before startDate.');
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('accepts a single-day range (endDate === startDate)', async () => {
      arrangeStudent();
      tx.guardianStudent.findFirst.mockResolvedValue({ id: LINK_ID });

      await expect(
        service.createLeaveRequest(
          leaveDto({ endDate: '2026-08-10' }) as any,
          guardianUser(),
        ),
      ).resolves.toEqual({
        id: REQUEST_ID,
        studentId: STUDENT_ID,
        status: 'PENDING',
      });
    });

    it('persists the request with the student’s school and the requester', async () => {
      arrangeStudent();
      tx.guardianStudent.findFirst.mockResolvedValue({ id: LINK_ID });
      const user = guardianUser();

      await service.createLeaveRequest(leaveDto() as any, user);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.leaveRequest.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          studentId: STUDENT_ID,
          requestedById: GUARDIAN_ID,
          startDate: new Date('2026-08-10T00:00:00.000Z'),
          endDate: new Date('2026-08-12T00:00:00.000Z'),
          reason: 'Family trip',
        },
        select: { id: true, studentId: true, status: true },
      });
    });

    it('forbids a guardian without a link to the student', async () => {
      arrangeStudent();
      tx.guardianStudent.findFirst.mockResolvedValue(null);

      await expect(
        service.createLeaveRequest(leaveDto() as any, guardianUser()),
      ).rejects.toThrow(ForbiddenException);
      expect(tx.leaveRequest.create).not.toHaveBeenCalled();
    });

    it('403s an admin principal without userId before touching the database', async () => {
      // requestedById is a required column: the same local guard as for
      // reportedById on an absence report, behind the same @Roles.
      arrangeStudent();

      await expect(
        service.createLeaveRequest(leaveDto() as any, testUser({ userId: undefined })),
      ).rejects.toThrow(
        new ForbiddenException('No user identity is associated with this account.'),
      );
      expect(prisma.withRls).not.toHaveBeenCalled();
      expect(tx.leaveRequest.create).not.toHaveBeenCalled();
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
        startDate: new Date('2026-08-10T00:00:00.000Z'),
        endDate: new Date('2026-08-12T00:00:00.000Z'),
        status: 'PENDING',
        reason: 'Family trip',
        student: { firstName: 'Elsa', lastName: 'Berg', email: 'elsa@school.se' },
        ...overrides,
      };
      // Found by its id only; any other id is a request RLS does not show.
      tx.leaveRequest.findUnique.mockImplementation(({ where, select }: any) =>
        Promise.resolve(where?.id === REQUEST_ID ? asSelected(row, select) : null),
      );
      tx.leaveRequest.update.mockImplementation(({ data, select }: any) =>
        Promise.resolve(asSelected({ ...row, ...data }, select)),
      );
      tx.absenceReport.create.mockResolvedValue({ id: REPORT_ID });
    };

    it('approves and records the decider, decision time and empty note', async () => {
      arrangePending();

      await expect(
        service.decideLeaveRequest(REQUEST_ID, { status: 'APPROVED' }, testUser()),
      ).resolves.toEqual({ id: REQUEST_ID, status: 'APPROVED', absenceDays: 3 });

      expect(tx.leaveRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: REQUEST_ID },
          data: {
            status: 'APPROVED',
            decidedById: ADMIN_ID,
            decidedAt: NOW,
            decisionNote: null,
          },
        }),
      );
    });

    it('materializes one full-day absence report per day of the range, inclusive', async () => {
      arrangePending();

      await service.decideLeaveRequest(
        REQUEST_ID,
        { status: 'APPROVED' },
        testUser(),
      );

      const dates = tx.absenceReport.create.mock.calls.map(
        ([arg]: [{ data: { date: Date } }]) => arg.data.date,
      );
      expect(dates).toEqual([
        new Date('2026-08-10T00:00:00.000Z'),
        new Date('2026-08-11T00:00:00.000Z'),
        new Date('2026-08-12T00:00:00.000Z'),
      ]);
      expect(tx.absenceReport.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          schoolId: SCHOOL_ID,
          studentId: STUDENT_ID,
          reportedById: ADMIN_ID,
          type: 'OTHER',
          note: 'Approved leave',
        }),
      });
    });

    it('creates a single absence report for a one-day leave', async () => {
      arrangePending({ endDate: new Date('2026-08-10T00:00:00.000Z') });

      await expect(
        service.decideLeaveRequest(REQUEST_ID, { status: 'APPROVED' }, testUser()),
      ).resolves.toMatchObject({ absenceDays: 1 });
      expect(tx.absenceReport.create).toHaveBeenCalledTimes(1);
    });

    it('rejects without creating any absence reports, carrying the note', async () => {
      arrangePending();

      await expect(
        service.decideLeaveRequest(
          REQUEST_ID,
          { status: 'REJECTED', note: 'Term time' },
          testUser(),
        ),
      ).resolves.toEqual({ id: REQUEST_ID, status: 'REJECTED', absenceDays: 0 });

      expect(tx.absenceReport.create).not.toHaveBeenCalled();
      expect(tx.leaveRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'REJECTED',
            decisionNote: 'Term time',
          }),
        }),
      );
    });

    it('notifies the requester inside the same transaction, bilingually', async () => {
      arrangePending();

      await service.decideLeaveRequest(
        REQUEST_ID,
        { status: 'APPROVED', note: 'Ok' },
        testUser(),
      );

      expect(notifications.notifyUsers).toHaveBeenCalledWith(tx, {
        schoolId: SCHOOL_ID,
        userIds: [GUARDIAN_ID],
        type: 'LEAVE_DECIDED',
        meta: {
          status: 'APPROVED',
          studentName: 'Elsa Berg',
          startDate: '2026-08-10',
          endDate: '2026-08-12',
          note: 'Ok',
        },
        email: {
          subject: 'Leave request approved / Ledighetsansökan beviljad',
          body:
            'Leave request for Elsa Berg (2026-08-10 – 2026-08-12) was approved.\n' +
            'Note: Ok\n\n' +
            'Ledighetsansökan för Elsa Berg (2026-08-10 – 2026-08-12) beviljades.',
        },
      });
    });

    it('words the rejection email as rejected/avslagen', async () => {
      arrangePending();

      await service.decideLeaveRequest(
        REQUEST_ID,
        { status: 'REJECTED' },
        testUser(),
      );

      expect(notifications.notifyUsers).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          email: expect.objectContaining({
            subject: 'Leave request rejected / Ledighetsansökan avslagen',
            // No note was given, so there is no note line either.
            body:
              'Leave request for Elsa Berg (2026-08-10 – 2026-08-12) was rejected.\n\n' +
              'Ledighetsansökan för Elsa Berg (2026-08-10 – 2026-08-12) avslogs.',
          }),
        }),
      );
    });

    it('stores decidedById null for a principal without a userId', async () => {
      // decidedById is nullable, so a rejection needs no identity to record.
      arrangePending();

      await service.decideLeaveRequest(
        REQUEST_ID,
        { status: 'REJECTED' },
        testUser({ userId: undefined }),
      );

      expect(tx.leaveRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ decidedById: null }),
        }),
      );
    });

    it('403s an approval by a principal without a userId', async () => {
      // Approval files absence reports in the decider's name, and their
      // reporter column is required — so a principal without a userId may
      // reject but not approve. The route is SCHOOL_ADMIN-only, and that
      // role's userId always comes from the Users row, so this holds the
      // invariant at the write rather than stopping a caller that exists. The
      // throw rolls the transaction back, status included.
      arrangePending();

      await expect(
        service.decideLeaveRequest(
          REQUEST_ID,
          { status: 'APPROVED' },
          testUser({ userId: undefined }),
        ),
      ).rejects.toThrow(
        new ForbiddenException('No user identity is associated with this account.'),
      );
      expect(tx.absenceReport.create).not.toHaveBeenCalled();
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('404s on an unknown request', async () => {
      tx.leaveRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.decideLeaveRequest(REQUEST_ID, { status: 'APPROVED' }, testUser()),
      ).rejects.toThrow(new NotFoundException('Leave request not found.'));
    });

    it.each(['APPROVED', 'REJECTED', 'CANCELLED'])(
      'refuses to re-decide a %s request',
      async (status) => {
        arrangePending({ status });

        await expect(
          service.decideLeaveRequest(
            REQUEST_ID,
            { status: 'APPROVED' },
            testUser(),
          ),
        ).rejects.toThrow('Leave request is already decided.');
        expect(tx.leaveRequest.update).not.toHaveBeenCalled();
        expect(notifications.notifyUsers).not.toHaveBeenCalled();
      },
    );
  });
});
