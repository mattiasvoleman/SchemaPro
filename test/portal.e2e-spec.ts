import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';
import { lockingRead, rawSql, type LockedTable } from './utils/locking-read';
import { recordedReads } from './utils/recorded-reads';

/**
 * The surfaces outside the admin's planning work: the guardian portal, teacher
 * self-service room bookings, user administration, the probes an orchestrator
 * calls, and the SS12000 API a municipality's systems call.
 *
 * The role matrix is the point here. These routes are the ones where a wrong
 * @Roles does real damage — a guardian who can read another family's data, or
 * a teacher who can approve their own booking.
 */

const STUDENT_ID = '88888888-8888-4888-8888-888888888888';
const GUARDIAN_ID = '77777777-7777-4777-8777-777777777777';
const ROOM_ID = '11111111-1111-4111-8111-111111111111';
const BOOKING_ID = '55555555-5555-4555-8555-555555555555';
const RECORD_ID = '66666666-6666-4666-8666-666666666666';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

/**
 * Dates are computed, never written out. A hard-coded "next week" is a test
 * that passes until the day it silently becomes the past — which is exactly
 * how the booking spec below started failing a day after it was written.
 */
const daysFromNow = (days: number): Date =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000);

const isoAt = (days: number, hour: number): string => {
  const date = daysFromNow(days);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

const dateOnly = (days: number): string =>
  daysFromNow(days).toISOString().slice(0, 10);

describe('Portal and platform surfaces (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const admin = () => asUser({});
  const guardian = () =>
    asUser({ role: 'GUARDIAN' as never, userId: GUARDIAN_ID });
  const teacher = () => asUser({ role: 'TEACHER' as never });

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('guardian portal', () => {
    it('lets a guardian report their child absent', async () => {
      harness.tx['guardianStudent']!['findFirst']!.mockResolvedValue({
        id: RECORD_ID,
        guardianId: GUARDIAN_ID,
        studentId: STUDENT_ID,
      });
      harness.tx['user']!['findUnique']!.mockResolvedValue({
        schoolId: SCHOOL_ID,
      });
      harness.tx['absenceReport']!['create']!.mockResolvedValue({
        id: RECORD_ID,
      });

      await request(http())
        .post('/api/v1/absence-reports')
        .set('x-test-user', guardian())
        .send({ studentId: STUDENT_ID, date: dateOnly(1), type: 'SICK' })
        .expect(201);
    });

    it('rejects an absence type outside the three the form offers', async () => {
      await request(http())
        .post('/api/v1/absence-reports')
        .set('x-test-user', guardian())
        .send({ studentId: STUDENT_ID, date: dateOnly(1), type: 'HOLIDAY' })
        .expect(400);
    });

    it('lets a guardian file a leave request but never decide one', async () => {
      harness.tx['guardianStudent']!['findFirst']!.mockResolvedValue({
        id: RECORD_ID,
        studentId: STUDENT_ID,
      });
      harness.tx['user']!['findUnique']!.mockResolvedValue({
        schoolId: SCHOOL_ID,
      });
      harness.tx['leaveRequest']!['create']!.mockResolvedValue({
        id: RECORD_ID,
      });

      await request(http())
        .post('/api/v1/leave-requests')
        .set('x-test-user', guardian())
        .send({
          studentId: STUDENT_ID,
          startDate: dateOnly(60),
          endDate: dateOnly(64),
          reason: 'Familjeresa',
        })
        .expect(201);

      await request(http())
        .patch(`/api/v1/leave-requests/${RECORD_ID}/decide`)
        .set('x-test-user', guardian())
        .send({ status: 'APPROVED' })
        .expect(403);
    });

    it('lets a pupil file their own leave request, never another pupil’s, and never decide one', async () => {
      const pupil = asUser({ role: 'STUDENT' as never, userId: STUDENT_ID, schoolId: SCHOOL_ID });
      harness.tx['user']!['findUnique']!.mockResolvedValue({
        schoolId: SCHOOL_ID,
      });
      harness.tx['leaveRequest']!['create']!.mockResolvedValue({
        id: RECORD_ID,
        studentId: STUDENT_ID,
        status: 'PENDING',
      });
      const body = (studentId: string) => ({
        studentId,
        startDate: dateOnly(60),
        endDate: dateOnly(61),
        reason: 'Tandläkaren',
      });

      await request(http())
        .post('/api/v1/leave-requests')
        .set('x-test-user', pupil)
        .send(body(STUDENT_ID))
        .expect(201);
      expect(harness.tx['leaveRequest']!['create']).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ studentId: STUDENT_ID, requestedById: STUDENT_ID }),
        }),
      );

      await request(http())
        .post('/api/v1/leave-requests')
        .set('x-test-user', pupil)
        .send(body(GUARDIAN_ID))
        .expect(403);
      expect(harness.tx['leaveRequest']!['create']).toHaveBeenCalledTimes(1);

      await request(http())
        .patch(`/api/v1/leave-requests/${RECORD_ID}/decide`)
        .set('x-test-user', pupil)
        .send({ status: 'APPROVED' })
        .expect(403);
    });

    it('refuses a request that ends before it starts or covers more than a year with a code, before any transaction', async () => {
      // LeaveRequests_a_year_at_most holds the database to the same bound
      // (20261023091000); the gateway says it first, with a code the
      // guardian's page words in Swedish (20261101090000), not the
      // validation pipe's English sentence.
      const filed = (startDate: string, endDate: string) =>
        request(http())
          .post('/api/v1/leave-requests')
          .set('x-test-user', guardian())
          .send({ studentId: STUDENT_ID, startDate, endDate, reason: 'Familjeresa' });

      const backwards = await filed('2027-03-02', '2027-03-01').expect(400);
      expect(backwards.body).toMatchObject({ code: 'LEAVE_REQUEST_ENDS_BEFORE_START' });
      const long = await filed('2027-01-01', '2028-01-02').expect(400);
      expect(long.body).toMatchObject({ code: 'LEAVE_REQUEST_TOO_LONG', params: { days: 366 } });
      expect(harness.tx['leaveRequest']!['create']).not.toHaveBeenCalled();
    });

    it('lets a mentor reach the inbox, the decision and the referral, which RLS narrows, and never rektor’s delegation', async () => {
      // The mentor's arms are the API's (20261023091000): the route lets a
      // TEACHER in, and a request that is not theirs to decide is one their
      // transaction does not find.
      harness.tx['leaveRequest']!['findUnique']!.mockResolvedValue(null);
      await request(http())
        .patch(`/api/v1/leave-requests/${RECORD_ID}/decide`)
        .set('x-test-user', teacher())
        .send({ status: 'APPROVED' })
        .expect(404);
      await request(http()).patch(`/api/v1/leave-requests/${RECORD_ID}/refer`).set('x-test-user', teacher()).expect(404);
      harness.tx['leaveRequest']!['findMany']!.mockResolvedValue([]);
      await request(http())
        .get('/api/v1/leave-requests?status=PENDING')
        .set('x-test-user', teacher())
        .expect(200, []);
      await request(http()).get('/api/v1/leave-requests?status=CANCELLED').set('x-test-user', teacher()).expect(400);
      await request(http()).get('/api/v1/leave-delegation').set('x-test-user', teacher()).expect(200, { current: null, history: [] });
      await request(http())
        .post('/api/v1/leave-delegation')
        .set('x-test-user', teacher())
        .send({ mentorMaxSchoolDays: 10 })
        .expect(403);
    });

    it('keeps the referral and the delegation from families, and the referral from rektor', async () => {
      const pupil = asUser({ role: 'STUDENT' as never, userId: STUDENT_ID, schoolId: SCHOOL_ID });
      // A family reads its own requests on the same route, without the facts
      // (LeaveService.listLeaveRequests).
      harness.tx['leaveRequest']!['findMany']!.mockResolvedValue([]);
      for (const principal of [guardian(), pupil]) {
        await request(http()).get('/api/v1/leave-requests').set('x-test-user', principal).expect(200, []);
        await request(http()).patch(`/api/v1/leave-requests/${RECORD_ID}/refer`).set('x-test-user', principal).expect(403);
        await request(http()).get('/api/v1/leave-delegation').set('x-test-user', principal).expect(403);
        await request(http())
          .post('/api/v1/leave-delegation')
          .set('x-test-user', principal)
          .send({ mentorMaxSchoolDays: 3 })
          .expect(403);
      }
      // Rektor decides a request outright; passing it on is the mentor's.
      await request(http()).patch(`/api/v1/leave-requests/${RECORD_ID}/refer`).set('x-test-user', admin()).expect(403);
      expect(harness.tx['leaveRequest']!['findUnique']).not.toHaveBeenCalled();
    });

    it('lets rektor record a delegation of 1 to 10 skoldagar, or none, and nothing else', async () => {
      harness.tx['leaveDelegationDecision']!['create']!.mockResolvedValue({
        mentorMaxSchoolDays: 3,
        reference: null,
        decidedAt: new Date('2026-10-13T08:00:00.000Z'),
        decidedById: null,
      });
      for (const body of [{ mentorMaxSchoolDays: 3 }, { mentorMaxSchoolDays: null }, { mentorMaxSchoolDays: 10, reference: 'Dnr 2026:4' }]) {
        await request(http()).post('/api/v1/leave-delegation').set('x-test-user', admin()).send(body).expect(201);
      }
      for (const body of [{}, { mentorMaxSchoolDays: 0 }, { mentorMaxSchoolDays: 11 }, { mentorMaxSchoolDays: 2.5 }, { mentorMaxSchoolDays: '3' }, { mentorMaxSchoolDays: 3, reference: '   ' }]) {
        await request(http()).post('/api/v1/leave-delegation').set('x-test-user', admin()).send(body).expect(400);
      }
      expect(harness.tx['leaveDelegationDecision']!['create']).toHaveBeenCalledTimes(3);
    });

    it('keeps guardian links an admin-only operation', async () => {
      for (const principal of [guardian(), teacher()]) {
        await request(http())
          .post('/api/v1/guardian-links')
          .set('x-test-user', principal)
          .send({ guardianId: GUARDIAN_ID, studentId: STUDENT_ID })
          .expect(403);
      }
    });
  });

  describe('room bookings', () => {
    it('lets a teacher book a room', async () => {
      harness.tx['room']!['findUnique']!.mockResolvedValue({
        id: ROOM_ID,
        requiresApproval: false,
      });
      harness.tx['roomBooking']!['create']!.mockResolvedValue({
        id: BOOKING_ID,
      });

      await request(http())
        .post('/api/v1/room-bookings')
        .set('x-test-user', teacher())
        .send({
          roomId: ROOM_ID,
          title: 'Föräldramöte 7A',
          startsAt: isoAt(7, 15),
          endsAt: isoAt(7, 17),
        })
        .expect(201);
    });

    it('rejects a timestamp that is not ISO-8601', async () => {
      await request(http())
        .post('/api/v1/room-bookings')
        .set('x-test-user', teacher())
        .send({
          roomId: ROOM_ID,
          title: 'Möte',
          startsAt: '18/8 kl 17',
          endsAt: isoAt(7, 17),
        })
        .expect(400);
    });

    it('does not let a teacher approve a booking', async () => {
      await request(http())
        .patch(`/api/v1/room-bookings/${BOOKING_ID}/decide`)
        .set('x-test-user', teacher())
        .send({ status: 'APPROVED' })
        .expect(403);
    });

    it('keeps bookings away from students and guardians entirely', async () => {
      for (const role of ['STUDENT', 'GUARDIAN']) {
        await request(http())
          .post('/api/v1/room-bookings')
          .set('x-test-user', asUser({ role: role as never }))
          .send({
            roomId: ROOM_ID,
            title: 'Möte',
            startsAt: isoAt(7, 15),
            endsAt: isoAt(7, 17),
          })
          .expect(403);
      }
    });
  });

  describe('user administration', () => {
    it('409s deleting the person a decided timplan names as its decider, and keeps the identity', async () => {
      harness.tx['user']!['findUnique']!.mockResolvedValueOnce({
        authId: '11111111-1111-4111-8111-111111111111',
        invitedAt: new Date('2026-08-01T00:00:00.000Z'),
      });
      harness.tx['localTimplan']!['findMany']!.mockResolvedValueOnce([{ name: 'Grundskolan 2024' }]);

      const response = await request(http())
        .delete(`/api/v1/users/${STUDENT_ID}`)
        .set('x-test-user', admin())
        .expect(409);

      expect(response.body.detail).toContain('"Grundskolan 2024"');
      expect(response.body.detail).toContain('Inaktivera kontot i stället');
      expect(harness.tx['user']!['delete']).not.toHaveBeenCalled();
      expect(harness.supabase.deleteUser).not.toHaveBeenCalled();
    });

    it('creates a user quietly — no invitation unless one is asked for', async () => {
      harness.tx['user']!['create']!.mockResolvedValue({ id: STUDENT_ID });

      await request(http())
        .post('/api/v1/users')
        .set('x-test-user', admin())
        .send({
          role: 'TEACHER',
          firstName: 'Karin',
          lastName: 'Ek',
          email: 'karin.ek@example.com',
        })
        .expect(201);

      expect(harness.supabase.inviteUser).not.toHaveBeenCalled();
    });

    it('invites on creation when the admin ticks the box', async () => {
      harness.tx['user']!['create']!.mockResolvedValue({ id: STUDENT_ID });

      await request(http())
        .post('/api/v1/users')
        .set('x-test-user', admin())
        .send({
          role: 'TEACHER',
          firstName: 'Karin',
          lastName: 'Ek',
          email: 'karin.ek@example.com',
          sendInvitation: true,
        })
        .expect(201);

      expect(harness.supabase.inviteUser).toHaveBeenCalledWith(
        'karin.ek@example.com',
        STUDENT_ID,
      );
    });

    it('invites one person on demand, and says whether mail actually went out', async () => {
      harness.tx['user']!['findUnique']!.mockResolvedValue({
        id: STUDENT_ID,
        email: 'karin.ek@example.com',
        isActive: true,
      });
      harness.tx['user']!['update']!.mockResolvedValue({ id: STUDENT_ID });

      const response = await request(http())
        .post(`/api/v1/users/${STUDENT_ID}/invite`)
        .set('x-test-user', admin())
        .expect(200);

      expect(response.body).toEqual({ id: STUDENT_ID, emailSent: true, loginMoved: false, sharedLogin: false });
      expect(harness.supabase.inviteUser).toHaveBeenCalledWith(
        'karin.ek@example.com',
        STUDENT_ID,
      );
    });

    it('invites a whole selection in one request', async () => {
      harness.tx['user']!['findUnique']!.mockResolvedValue({
        id: STUDENT_ID,
        email: 'elev@example.com',
        isActive: true,
      });
      harness.tx['user']!['update']!.mockResolvedValue({ id: STUDENT_ID });

      const response = await request(http())
        .post('/api/v1/users/invitations')
        .set('x-test-user', admin())
        .send({
          userIds: [STUDENT_ID, GUARDIAN_ID, ROOM_ID],
        })
        .expect(200);

      expect(response.body).toMatchObject({ sent: 3, errors: [] });
    });

    it('rejects a bulk invitation carrying something that is not an id', async () => {
      await request(http())
        .post('/api/v1/users/invitations')
        .set('x-test-user', admin())
        .send({ userIds: ['karin.ek@example.com'] })
        .expect(400);
    });

    it('denies a teacher sending invitations', async () => {
      for (const path of [
        `/api/v1/users/${STUDENT_ID}/invite`,
        '/api/v1/users/invitations',
      ]) {
        await request(http())
          .post(path)
          .set('x-test-user', teacher())
          .send({ userIds: [STUDENT_ID] })
          .expect(403);
      }
    });

    it('rejects a role that does not exist', async () => {
      await request(http())
        .post('/api/v1/users')
        .set('x-test-user', admin())
        .send({
          role: 'REKTOR',
          firstName: 'A',
          lastName: 'B',
          email: 'a@example.com',
        })
        .expect(400);
    });

    it('denies a teacher creating users', async () => {
      await request(http())
        .post('/api/v1/users')
        .set('x-test-user', teacher())
        .send({
          role: 'STUDENT',
          firstName: 'A',
          lastName: 'B',
          email: 'a@example.com',
        })
        .expect(403);
    });

    it('409s making a teacher a pupil while their tjänst stands, in Swedish', async () => {
      // The locking read of the stored role (FOR NO KEY UPDATE, answered as
      // the table would — the auto-vivifying tx hands back a proxy for
      // `$queryRaw`, and a proxy is not callable), then the two staffing
      // counts that answer whether the role may leave staff at all.
      const USERS: LockedTable = {
        name: 'Users',
        columns: ['id', 'schoolId', 'role', 'firstName', 'lastName', 'email', 'isActive', 'studentGroupId', 'deactivatedAt', 'pseudonymisedAt', 'adminProfile', 'hrRead'],
        lock: 'FOR NO KEY UPDATE',
      };
      Object.assign(harness.tx, {
        $queryRaw: jest.fn((...call: unknown[]) =>
          Promise.resolve(
            lockingRead(USERS, [{ id: GUARDIAN_ID, role: 'TEACHER', studentGroupId: null, adminProfile: null, hrRead: false }], call),
          ),
        ),
      });
      harness.tx['teacherEmployment']!['count']!.mockResolvedValue(1);
      harness.tx['teacherSubjectQualification']!['count']!.mockResolvedValue(0);

      try {
        const response = await request(http())
          .patch(`/api/v1/users/${GUARDIAN_ID}`)
          .set('x-test-user', admin())
          .send({ role: 'STUDENT' })
          .expect(409);

        expect(response.body.detail).toContain('1 tjänst');
        expect(harness.tx['user']!['update']).not.toHaveBeenCalled();
      } finally {
        // The harness outlives the test, and the table this row answered
        // from is not the next one's.
        delete (harness.tx as Record<string, unknown>)['$queryRaw'];
      }
    });

    // Massåtgärder: the pupils' list acts on a selection in one call. Each
    // handler is reached by an administrator's request (the area gates are in
    // admin-areas.e2e-spec.ts).
    describe('bulk actions on pupils (Massåtgärder)', () => {
      // Sorts after STUDENT_ID: the report lists ids in id order.
      const OTHER_ID = 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5';
      const CLASS_ID = '4c4c4c4c-4c4c-4c4c-8c4c-4c4c4c4c4c4c';
      const LOGIN = '9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a';
      const DELETE = '/api/v1/users/students/bulk-delete';
      const UPDATE = '/api/v1/users/students/bulk-update';
      const post = (path: string, body: unknown) =>
        request(http()).post(path).set('x-test-user', admin()).send(body as object);
      const manyIds = (count: number) => Array.from({ length: count }, () => randomUUID());

      /*
       * A bulk statement answers with the rows it wrote, here every row its
       * `id in` names: writeAll tries the rows one by one when the count
       * falls short. Reset after, since the harness outlives the test.
       */
      const writesEveryRowNamed = ({ where }: { where?: { id?: { in?: string[] } } }) =>
        Promise.resolve({ count: where?.id?.in?.length ?? 0 });
      beforeEach(() => {
        harness.tx['user']!['updateMany']!.mockImplementation(writesEveryRowNamed);
        harness.tx['user']!['deleteMany']!.mockImplementation(writesEveryRowNamed);
      });
      afterEach(() => {
        harness.tx['user']!['updateMany']!.mockReset();
        harness.tx['user']!['deleteMany']!.mockReset();
      });
      const pupil = (id: string, overrides: Record<string, unknown> = {}) => ({
        id,
        role: 'STUDENT',
        studentGroupId: null,
        isActive: true,
        pseudonymisedAt: null,
        authId: LOGIN,
        invitedAt: null,
        ss12000Id: null,
        ...overrides,
      });

      /**
       * The raw statements the bulk calls send: the locking read of the rows
       * (answered with `rows`, whole), the mentors' catch-up (nobody to tell)
       * and the question whether another school holds a login (nobody does).
       * The auto-vivifying tx hands back a model proxy for `$queryRaw`, and a
       * proxy is not callable.
       */
      const givenRows = (rows: Record<string, unknown>[]) =>
        Object.assign(harness.tx, {
          $queryRaw: jest.fn((...call: unknown[]) => {
            const sql = rawSql(call);
            if (sql.includes('app.leave_requests_tell_new_mentors')) return Promise.resolve([]);
            if (sql.includes('app.login_is_held_elsewhere')) return Promise.resolve([{ held: false }]);
            const ids = call[1] as string[];
            return Promise.resolve(rows.filter((row) => ids.includes(row['id'] as string)));
          }),
        });

      afterEach(() => {
        // The harness outlives the test, and the table these rows answered
        // from is not the next one's.
        delete (harness.tx as Record<string, unknown>)['$queryRaw'];
      });

      it('answers a dry-run delete 200 with the report and the counts, which it records as reads', async () => {
        givenRows([pupil(STUDENT_ID, { invitedAt: new Date('2026-08-01T00:00:00Z'), ss12000Id: 'ss-1' })]);
        harness.tx['user']!['findMany']!.mockResolvedValueOnce([
          { id: STUDENT_ID, invitedAt: new Date('2026-08-01T00:00:00Z'), ss12000Id: 'ss-1' },
        ]);
        const counts = {
          studentGroupMember: 5,
          studentEnrollment: 6,
          guardianStudent: 3,
          absenceReport: 20,
          leaveRequest: 2,
          attendanceRecord: 400,
        };
        for (const [model, count] of Object.entries(counts)) harness.tx[model]!['count']!.mockResolvedValueOnce(count);

        const response = await post(DELETE, { ids: [STUDENT_ID], dryRun: true }).expect(200);

        expect(response.body).toEqual({
          applied: false,
          dryRun: true,
          done: [STUDENT_ID],
          refused: [],
          consequences: {
            memberships: 5,
            enrolments: 6,
            guardianLinks: 3,
            absenceReports: 20,
            leaveRequests: 2,
            attendanceMarks: 400,
            logins: 1,
            fromSource: 1,
          },
        });
        expect(recordedReads(harness.tx).map((read) => read.kind)).toEqual([
          'ROSTER',
          'GUARDIANS',
          'ABSENCE_REPORTS',
          'LEAVE_REQUESTS',
          'ATTENDANCE',
        ]);
        // A dry run removes no login, then or later.
        await new Promise((resolve) => setImmediate(resolve));
        expect(harness.supabase.deleteUser).not.toHaveBeenCalled();
      });

      it('deletes the selection and, once it has committed, the logins of the invited', async () => {
        givenRows([
          pupil(STUDENT_ID, { invitedAt: new Date('2026-08-01T00:00:00Z') }),
          pupil(OTHER_ID, { authId: '9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b', invitedAt: null }),
        ]);

        const response = await post(DELETE, { ids: [OTHER_ID, STUDENT_ID] }).expect(200);

        expect(response.body).toEqual({ applied: true, dryRun: false, done: [STUDENT_ID, OTHER_ID], refused: [] });
        expect(harness.tx['user']!['deleteMany']).toHaveBeenCalledWith({ where: { id: { in: [STUDENT_ID, OTHER_ID] } } });
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        // The invited pupil’s login only: the other was never contacted.
        expect(harness.supabase.deleteUser.mock.calls).toEqual([[LOGIN]]);
      });

      it('refuses what is no pupil in the report, 200, and deletes nothing at the provider', async () => {
        givenRows([pupil(STUDENT_ID, { invitedAt: new Date('2026-08-01T00:00:00Z') }), pupil(GUARDIAN_ID, { role: 'GUARDIAN' })]);

        const response = await post(DELETE, { ids: [STUDENT_ID, GUARDIAN_ID, ROOM_ID] }).expect(200);

        expect(response.body).toEqual({
          applied: false,
          dryRun: false,
          done: [STUDENT_ID],
          refused: [
            {
              id: ROOM_ID,
              code: 'BULK_ROW_NOT_FOUND',
              message: 'Raden finns inte längre. Den kan ha tagits bort av någon annan.',
            },
            {
              id: GUARDIAN_ID,
              code: 'NOT_A_STUDENT',
              message: 'Raden är ingen elev. Lärare, administratörer och vårdnadshavare ändras och tas bort en i taget.',
            },
          ],
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(harness.supabase.deleteUser).not.toHaveBeenCalled();
      });

      it('moves the selection to a class and answers 200 applied with the report', async () => {
        givenRows([pupil(STUDENT_ID), pupil(OTHER_ID)]);
        harness.tx['studentGroup']!['findUnique']!.mockResolvedValueOnce({ kind: 'CLASS' });

        const response = await post(UPDATE, {
          ids: [OTHER_ID, STUDENT_ID],
          changes: { studentGroupId: CLASS_ID },
        }).expect(200);

        expect(response.body).toEqual({ applied: true, dryRun: false, done: [STUDENT_ID, OTHER_ID], refused: [] });
        expect(harness.tx['user']!['updateMany']).toHaveBeenCalledWith({
          where: { id: { in: [STUDENT_ID, OTHER_ID] } },
          data: { studentGroupId: CLASS_ID },
        });
        // Ids only in the answer: no read to record.
        expect(recordedReads(harness.tx)).toEqual([]);
      });

      it('sets the status on a dry run and answers what would be done', async () => {
        givenRows([pupil(STUDENT_ID), pupil(OTHER_ID, { isActive: false })]);

        const response = await post(UPDATE, { ids: [STUDENT_ID, OTHER_ID], changes: { isActive: false }, dryRun: true }).expect(200);

        expect(response.body).toEqual({ applied: false, dryRun: true, done: [STUDENT_ID, OTHER_ID], refused: [] });
        // Only the pupil who is active is written (and rolled back).
        expect(harness.tx['user']!['updateMany']).toHaveBeenCalledWith({
          where: { id: { in: [STUDENT_ID] } },
          data: { isActive: false },
        });
      });

      it('refuses a pseudonymised pupil made active in the report, 200, and a teaching group as a home class with 400', async () => {
        givenRows([pupil(STUDENT_ID), pupil(OTHER_ID, { pseudonymisedAt: new Date('2026-10-21T01:10:00Z'), isActive: false })]);

        const report = await post(UPDATE, { ids: [STUDENT_ID, OTHER_ID], changes: { isActive: true } }).expect(200);
        expect(report.body).toMatchObject({
          applied: false,
          done: [STUDENT_ID],
          refused: [{ id: OTHER_ID, code: 'USER_IS_PSEUDONYMISED' }],
        });

        harness.tx['studentGroup']!['findUnique']!.mockResolvedValueOnce({ kind: 'TEACHING_GROUP' });
        const refused = await post(UPDATE, { ids: [STUDENT_ID], changes: { studentGroupId: CLASS_ID } }).expect(400);
        expect(refused.body).toMatchObject({ code: 'STUDENT_HOME_GROUP_NOT_A_CLASS' });
      });

      it('takes 500 ids, the most a call may name', async () => {
        givenRows([]);

        const response = await post(DELETE, { ids: manyIds(500) }).expect(200);

        expect(response.body.refused).toHaveLength(500);
      });

      it.each([
        ['501 ids', { ids: manyIds(501) }],
        ['no ids', { ids: [] }],
        ['an id that is no uuid', { ids: ['karin.ek@example.com'] }],
        ['a dryRun that is not a boolean', { ids: [STUDENT_ID], dryRun: 1 }],
        ['a field it does not know', { ids: [STUDENT_ID], includeStaff: true }],
      ])('refuses a bulk delete with %s, before any transaction', async (_what, body) => {
        await post(DELETE, body).expect(400);
        expect(harness.prisma.withRls).not.toHaveBeenCalled();
        expect(harness.tx['user']!['deleteMany']).not.toHaveBeenCalled();
      });

      it.each([
        ['501 ids', { ids: manyIds(501), changes: { isActive: false } }],
        ['an id that is no uuid', { ids: ['karin'], changes: { isActive: false } }],
        ['no changes', { ids: [STUDENT_ID] }],
        ['changes that name nothing', { ids: [STUDENT_ID], changes: {} }],
        ['a class that is no uuid', { ids: [STUDENT_ID], changes: { studentGroupId: '7A' } }],
        ['a status that is no boolean', { ids: [STUDENT_ID], changes: { isActive: 'false' } }],
        ['a role, which only one person at a time may be given', { ids: [STUDENT_ID], changes: { role: 'TEACHER' } }],
        ['a field a bulk update may not set', { ids: [STUDENT_ID], changes: { email: 'a@example.com' } }],
      ])('refuses a bulk update with %s, before any transaction', async (_what, body) => {
        await post(UPDATE, body).expect(400);
        expect(harness.prisma.withRls).not.toHaveBeenCalled();
        expect(harness.tx['user']!['updateMany']).not.toHaveBeenCalled();
      });

      it('denies a teacher both routes', async () => {
        for (const path of [DELETE, UPDATE]) {
          await request(http())
            .post(path)
            .set('x-test-user', teacher())
            .send({ ids: [STUDENT_ID], changes: { isActive: false } })
            .expect(403);
        }
        expect(harness.prisma.withRls).not.toHaveBeenCalled();
      });
    });
  });

  describe("the login's schools (Flera skolor per inloggning)", () => {
    const OTHER = '44444444-4444-4444-8444-444444444444';

    it('lists every role\'s schools from app.my_schools(), only the switcher\'s fields', async () => {
      harness.tx.$queryRaw.mockResolvedValueOnce([
        { school_id: SCHOOL_ID, school_name: 'Ekbacken', role: 'GUARDIAN', admin_profile: null, closed_reason: null, is_current: true, user_id: GUARDIAN_ID },
        { school_id: OTHER, school_name: 'Granen', role: 'TEACHER', admin_profile: null, closed_reason: 'sso_required', is_current: false, user_id: STUDENT_ID },
      ]);

      const response = await request(http())
        .get('/api/v1/me/schools')
        .set('x-test-user', guardian())
        .expect(200);

      expect(response.body).toEqual([
        { schoolId: SCHOOL_ID, schoolName: 'Ekbacken', role: 'GUARDIAN', adminProfile: null, closed: null, current: true, huvudman: null },
        { schoolId: OTHER, schoolName: 'Granen', role: 'TEACHER', adminProfile: null, closed: 'sso_required', current: false, huvudman: null },
      ]);
    });

    it('is every signed-in role\'s, and nobody else\'s', async () => {
      for (const token of [admin(), teacher(), guardian(), asUser({ role: 'STUDENT' as never })]) {
        await request(http()).get('/api/v1/me/schools').set('x-test-user', token).expect(200);
      }
      await request(http()).get('/api/v1/me/schools').expect(401);
    });
  });

  describe('integration keys', () => {
    it('returns the plaintext key exactly once, on creation', async () => {
      harness.tx['integrationApiKey']!['create']!.mockResolvedValue({
        id: RECORD_ID,
        name: 'Kommunens elevregister',
        createdAt: new Date('2026-08-17T10:00:00.000Z'),
      });

      const created = await request(http())
        .post('/api/v1/integration-keys')
        .set('x-test-user', admin())
        .send({ name: 'Kommunens elevregister' })
        .expect(201);

      expect(created.body.key).toMatch(/^sp_[0-9a-f]{48}$/);
      // Only the hash is persisted — the plaintext must not be in the row.
      const args = harness.tx['integrationApiKey']!['create']!.mock
        .calls[0]?.[0] as { data: Record<string, unknown> };
      expect(args.data['keyHash']).toBe(
        createHash('sha256').update(created.body.key).digest('hex'),
      );
      expect(JSON.stringify(args.data)).not.toContain(created.body.key);

      harness.tx['integrationApiKey']!['findMany']!.mockResolvedValue([
        { id: RECORD_ID, name: 'Kommunens elevregister' },
      ]);
      const listed = await request(http())
        .get('/api/v1/integration-keys')
        .set('x-test-user', admin())
        .expect(200);

      expect(JSON.stringify(listed.body)).not.toContain(created.body.key);
    });

    it('denies a teacher minting a key', async () => {
      await request(http())
        .post('/api/v1/integration-keys')
        .set('x-test-user', teacher())
        .send({ name: 'mine' })
        .expect(403);
    });
  });

  describe('SS12000 API', () => {
    it('401s with no key at all', async () => {
      await request(http()).get('/ss12000/v1/organisation').expect(401);
    });

    it('401s on a key that does not carry the sp_ prefix', async () => {
      await request(http())
        .get('/ss12000/v1/organisation')
        .set('x-api-key', 'Bearer something')
        .expect(401);
    });

    it('401s on a well-formed key that matches no row', async () => {
      harness.tx['integrationApiKey']!['findFirst']!.mockResolvedValue(null);

      await request(http())
        .get('/ss12000/v1/organisation')
        .set('x-api-key', `sp_${'a'.repeat(48)}`)
        .expect(401);
    });

    it('scopes a valid key to its own school, not the caller-supplied one', async () => {
      // Every key that existed before 20261014120000 holds these scopes.
      harness.tx['integrationApiKey']!['findFirst']!.mockResolvedValue({
        id: RECORD_ID,
        schoolId: SCHOOL_ID,
        scopes: ['ss12000.v1', 'ss12000.v1.import'],
      });
      harness.tx['school']!['findUnique']!.mockResolvedValue({
        id: SCHOOL_ID,
        name: 'Testskolan',
      });

      await request(http())
        .get('/ss12000/v1/organisation')
        .set('x-api-key', `sp_${'b'.repeat(48)}`)
        .expect(200);

      // A JWT principal must not reach these handlers — the key is the only
      // tenant source, and it resolves through the restricted lookup.
      expect(harness.tx['integrationApiKey']!['findFirst']).toHaveBeenCalled();
    });

    it('accepts a bearer token as no substitute for the key', async () => {
      await request(http())
        .get('/ss12000/v1/persons')
        .set('x-test-user', admin())
        .expect(401);
    });

    describe('/duties (SS12000 2.1.0 Duty)', () => {
      const givenPosts = (share: boolean) => {
        harness.tx['integrationApiKey']!['findFirst']!.mockResolvedValue({ id: RECORD_ID, schoolId: SCHOOL_ID, scopes: ['ss12000.v1', 'ss12000.v1.import'] });
        harness.tx['academicYear']!['findFirst']!.mockResolvedValue({
          id: 'year-1',
          startDate: new Date('2026-08-17T00:00:00.000Z'),
          endDate: new Date('2027-06-11T00:00:00.000Z'),
        });
        harness.tx['staffingPolicy']!['findUnique']!.mockResolvedValue({ shareEmploymentWithIntegrations: share, fullTimeAnnualHours: 1767 });
        harness.tx['teacherEmployment']!['count']!.mockResolvedValue(1);
        harness.tx['teacherEmployment']!['findMany']!.mockResolvedValue([
          {
            id: 'emp-1',
            userId: 'user-1',
            employmentPercent: 80,
            signature: 'ANN',
            createdAt: new Date('2026-08-01T00:00:00.000Z'),
            updatedAt: new Date('2026-09-01T00:00:00.000Z'),
            ...(share ? { contractKind: 'FERIE' } : {}),
          },
        ]);
        harness.tx['teacherDuty']!['findMany']!.mockResolvedValue([]);
      };

      it('a key reads its school’s posts as Duty objects, with no tjänstgöringsgrad unless the school shares it', async () => {
        givenPosts(false);
        const off = await request(http()).get('/ss12000/v1/duties').set('x-api-key', `sp_${'b'.repeat(48)}`).expect(200);
        expect(off.body).toMatchObject({
          totalCount: 1,
          data: [{ id: 'emp-1', person: { id: 'user-1' }, dutyAt: { id: SCHOOL_ID }, dutyRole: 'Lärare', startDate: '2026-08-17' }],
        });
        expect(off.body.data[0]).not.toHaveProperty('dutyPercent');
        const select = (harness.tx['teacherEmployment']!['findMany']!.mock.calls[0]![0] as { select: Record<string, unknown> }).select;
        expect(select).not.toHaveProperty('reductionPercent');

        givenPosts(true);
        const on = await request(http()).get('/ss12000/v1/duties').set('x-api-key', `sp_${'b'.repeat(48)}`).expect(200);
        expect(on.body.data[0]).toMatchObject({ dutyPercent: 80, hoursPerYear: 1414 });
      });

      it('401s with no key, a revoked or unknown key, and a bearer token', async () => {
        await request(http()).get('/ss12000/v1/duties').expect(401);
        harness.tx['integrationApiKey']!['findFirst']!.mockResolvedValue(null);
        await request(http()).get('/ss12000/v1/duties').set('x-api-key', `sp_${'c'.repeat(48)}`).expect(401);
        await request(http()).get('/ss12000/v1/duties').set('x-test-user', admin()).expect(401);
        expect(harness.tx['teacherEmployment']!['findMany']).not.toHaveBeenCalled();
      });
    });
  });

  describe('probes', () => {
    it('answers liveness without a principal', async () => {
      await request(http()).get('/health').expect(200);
    });

    it('answers readiness', async () => {
      harness.tx['$queryRaw']!.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(http()).get('/health/ready');

      // Ready or not-ready both count as wired; a 404 would not.
      expect([200, 503]).toContain(response.status);
    });
  });
});
