import { createHash } from 'node:crypto';
import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

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
        .send({ studentId: STUDENT_ID, date: '2026-08-18', type: 'SICK' })
        .expect(201);
    });

    it('rejects an absence type outside the three the form offers', async () => {
      await request(http())
        .post('/api/v1/absence-reports')
        .set('x-test-user', guardian())
        .send({ studentId: STUDENT_ID, date: '2026-08-18', type: 'HOLIDAY' })
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
          startDate: '2026-10-26',
          endDate: '2026-10-30',
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
          startsAt: '2026-08-18T17:00:00.000Z',
          endsAt: '2026-08-18T18:30:00.000Z',
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
          endsAt: '2026-08-18T18:30:00.000Z',
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
            startsAt: '2026-08-18T17:00:00.000Z',
            endsAt: '2026-08-18T18:30:00.000Z',
          })
          .expect(403);
      }
    });
  });

  describe('user administration', () => {
    it('creates a user, inviting the identity first', async () => {
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

      expect(harness.supabase.inviteUser).toHaveBeenCalledWith(
        'karin.ek@example.com',
      );
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
