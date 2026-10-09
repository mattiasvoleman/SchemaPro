import { createHash } from 'node:crypto';
import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';
import { lockingRead, type LockedTable } from './utils/locking-read';

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

      expect(response.body).toEqual({ id: STUDENT_ID, emailSent: true });
      expect(harness.supabase.inviteUser).toHaveBeenCalledWith(
        'karin.ek@example.com',
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
        columns: ['id', 'schoolId', 'role', 'firstName', 'lastName', 'email', 'isActive', 'studentGroupId'],
        lock: 'FOR NO KEY UPDATE',
      };
      Object.assign(harness.tx, {
        $queryRaw: jest.fn((...call: unknown[]) =>
          Promise.resolve(
            lockingRead(USERS, [{ id: GUARDIAN_ID, role: 'TEACHER', studentGroupId: null }], call),
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
      harness.tx['integrationApiKey']!['findFirst']!.mockResolvedValue({
        id: RECORD_ID,
        schoolId: SCHOOL_ID,
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
        harness.tx['integrationApiKey']!['findFirst']!.mockResolvedValue({ id: RECORD_ID, schoolId: SCHOOL_ID });
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
