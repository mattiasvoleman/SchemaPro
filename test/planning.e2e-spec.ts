import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * The Kom igång → Planering surface over HTTP: läsår, salstyper, klasser and
 * undervisningsgrupper, timplan and tillgänglighet.
 *
 * These are the routes an admin walks on their first day, and the ones whose
 * failures reach a school as "det går inte att spara" with no further clue.
 * A service spec cannot see a route that does not resolve, a path param the
 * UUID pipe rejects, or a DTO that refuses the payload the form submits —
 * so those are what this suite asserts.
 */

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const GROUP_ID = '55555555-5555-4555-8555-555555555555';
const TYPE_ID = '66666666-6666-4666-8666-666666666666';
const SUBJECT_ID = '99999999-9999-4999-8999-999999999999';
const STUDENT_ID = '88888888-8888-4888-8888-888888888888';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

describe('Planning surface (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const admin = () => asUser({});

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('academic years', () => {
    it('creates one from the form payload', async () => {
      harness.tx['academicYear']!['create']!.mockResolvedValue({ id: YEAR_ID });

      const response = await request(http())
        .post('/api/v1/academic-years')
        .set('x-test-user', admin())
        .send({
          name: '2026/2027',
          startDate: '2026-08-17',
          endDate: '2027-06-11',
          isActive: true,
        })
        .expect(201);

      expect(response.body).toMatchObject({ id: YEAR_ID });
      const args = harness.tx['academicYear']!['create']!.mock.calls[0]?.[0] as {
        data: { schoolId: string };
      };
      expect(args.data.schoolId).toBe(SCHOOL_ID);
    });

    it('rejects a date that is not a date', async () => {
      await request(http())
        .post('/api/v1/academic-years')
        .set('x-test-user', admin())
        .send({ name: '2026/2027', startDate: 'hösten', endDate: '2027-06-11' })
        .expect(400);
    });

    it('404s rather than 500s on a path that does not exist', async () => {
      // The failure a school actually reports is a 404 on save. Pin the shape
      // of the routing table so a renamed prefix fails here, not in the field.
      await request(http())
        .post('/api/v1/academic-year')
        .set('x-test-user', admin())
        .send({ name: 'x', startDate: '2026-08-17', endDate: '2027-06-11' })
        .expect(404);
    });

    it('deletes with 204 and no body', async () => {
      harness.tx['academicYear']!['delete']!.mockResolvedValue({ id: YEAR_ID });

      const response = await request(http())
        .delete(`/api/v1/academic-years/${YEAR_ID}`)
        .set('x-test-user', admin())
        .expect(204);

      expect(response.body).toEqual({});
    });

    it('400s on an id that is not a v4 uuid, before touching the database', async () => {
      await request(http())
        .delete('/api/v1/academic-years/not-a-uuid')
        .set('x-test-user', admin())
        .expect(400);

      expect(harness.tx['academicYear']!['delete']).not.toHaveBeenCalled();
    });
  });

  describe('room types', () => {
    it('lists them with the usage counts the UI disables delete on', async () => {
      harness.tx['roomType']!['findMany']!.mockResolvedValue([
        { id: TYPE_ID, name: 'Textilslöjd', _count: { rooms: 2, subjects: 1 } },
      ]);

      const response = await request(http())
        .get('/api/v1/room-types')
        .set('x-test-user', admin())
        .expect(200);

      expect(response.body).toEqual([
        { id: TYPE_ID, name: 'Textilslöjd', _count: { rooms: 2, subjects: 1 } },
      ]);
    });

    it('creates one', async () => {
      harness.tx['roomType']!['create']!.mockResolvedValue({
        id: TYPE_ID,
        name: 'Hemkunskapssal',
      });

      await request(http())
        .post('/api/v1/room-types')
        .set('x-test-user', admin())
        .send({ name: 'Hemkunskapssal' })
        .expect(201);
    });

    it('refuses to delete one still in use, and says by what', async () => {
      harness.tx['roomType']!['findUnique']!.mockResolvedValue({
        id: TYPE_ID,
        _count: { rooms: 3, subjects: 2 },
      });

      const response = await request(http())
        .delete(`/api/v1/room-types/${TYPE_ID}`)
        .set('x-test-user', admin())
        .expect(400);

      // RFC-7807 body, in Swedish, naming both counts — this is the text an
      // admin reads, so it is worth pinning end to end.
      expect(response.body).toMatchObject({ status: 400 });
      expect(JSON.stringify(response.body)).toContain('3 sal(ar) och 2 ämne(n)');
      expect(harness.tx['roomType']!['delete']).not.toHaveBeenCalled();
    });
  });

  describe('classes and teaching groups', () => {
    it('creates a class for a year', async () => {
      harness.tx['studentGroup']!['create']!.mockResolvedValue({ id: GROUP_ID });

      await request(http())
        .post('/api/v1/student-groups')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, name: '7A', gradeLevel: 7 })
        .expect(201);
    });

    it('creates a teaching group, which the timplan lists separately', async () => {
      harness.tx['studentGroup']!['create']!.mockResolvedValue({ id: GROUP_ID });

      await request(http())
        .post('/api/v1/student-groups')
        .set('x-test-user', admin())
        .send({
          academicYearId: YEAR_ID,
          name: 'Ma71',
          kind: 'TEACHING_GROUP',
          // A level group legitimately carries a year — the old "no gradeLevel
          // means teaching group" guess got exactly this case wrong.
          gradeLevel: 7,
        })
        .expect(201);

      const args = harness.tx['studentGroup']!['create']!.mock.calls[0]?.[0] as {
        data: { kind: string; gradeLevel: number };
      };
      expect(args.data).toMatchObject({ kind: 'TEACHING_GROUP', gradeLevel: 7 });
    });

    it('defaults to a home class when no kind is given', async () => {
      harness.tx['studentGroup']!['create']!.mockResolvedValue({ id: GROUP_ID });

      await request(http())
        .post('/api/v1/student-groups')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, name: '7A', gradeLevel: 7 })
        .expect(201);

      const args = harness.tx['studentGroup']!['create']!.mock.calls[0]?.[0] as {
        data: { kind: string };
      };
      expect(args.data.kind).toBe('CLASS');
    });

    it('rejects a kind that is not one of the two', async () => {
      await request(http())
        .post('/api/v1/student-groups')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, name: 'Ma71', kind: 'NIVÅGRUPP' })
        .expect(400);
    });

    it('rejects a grade level outside the Swedish 0–12 range', async () => {
      await request(http())
        .post('/api/v1/student-groups')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, name: 'Gy1', gradeLevel: 13 })
        .expect(400);
    });

    it('replaces the member list wholesale', async () => {
      harness.tx['studentGroup']!['findUnique']!.mockResolvedValue({
        id: GROUP_ID,
      });
      harness.tx['user']!['findMany']!.mockResolvedValue([
        { id: STUDENT_ID, role: 'STUDENT' },
      ]);
      harness.tx['studentGroupMember']!['deleteMany']!.mockResolvedValue({
        count: 0,
      });
      harness.tx['studentGroupMember']!['createMany']!.mockResolvedValue({
        count: 1,
      });

      await request(http())
        .put(`/api/v1/student-groups/${GROUP_ID}/members`)
        .set('x-test-user', admin())
        .send({ studentIds: [STUDENT_ID] })
        .expect(200);
    });

    it('rejects a member list holding something that is not a uuid', async () => {
      await request(http())
        .put(`/api/v1/student-groups/${GROUP_ID}/members`)
        .set('x-test-user', admin())
        .send({ studentIds: ['alma@example.com'] })
        .expect(400);
    });

    it('lists members', async () => {
      harness.tx['studentGroupMember']!['findMany']!.mockResolvedValue([]);

      await request(http())
        .get(`/api/v1/student-groups/${GROUP_ID}/members`)
        .set('x-test-user', admin())
        .expect(200);
    });
  });

  describe('timplan (teaching requirements)', () => {
    it('creates a requirement', async () => {
      harness.tx['teachingRequirement']!['create']!.mockResolvedValue({
        id: SUBJECT_ID,
      });

      await request(http())
        .post('/api/v1/teaching-requirements')
        .set('x-test-user', admin())
        .send({
          academicYearId: YEAR_ID,
          subjectId: SUBJECT_ID,
          studentGroupId: GROUP_ID,
          lessonsPerWeek: 3,
          minutesPerLesson: 60,
        })
        .expect(201);
    });

    it('rejects a period date that no calendar has', async () => {
      // 2026 is not a leap year, and April has 30 days. Both shapes are
      // /^\d{4}-\d{2}-\d{2}$/ and both were accepted before, then rolled over
      // by `new Date` to the 1st of the following month — an admin's typo
      // became a period that quietly meant something else. Asserted over HTTP
      // because it is the validation pipe, not the service, that has to answer.
      for (const startDate of ['2026-02-29', '2026-04-31']) {
        await request(http())
          .post('/api/v1/teaching-requirements')
          .set('x-test-user', admin())
          .send({
            academicYearId: YEAR_ID,
            subjectId: SUBJECT_ID,
            studentGroupId: GROUP_ID,
            startDate,
          })
          .expect(400);
      }
      expect(harness.tx['teachingRequirement']!['create']).not.toHaveBeenCalled();
    });

    it('rejects a lesson length outside the schedulable range', async () => {
      for (const minutesPerLesson of [5, 600]) {
        await request(http())
          .post('/api/v1/teaching-requirements')
          .set('x-test-user', admin())
          .send({
            academicYearId: YEAR_ID,
            subjectId: SUBJECT_ID,
            studentGroupId: GROUP_ID,
            minutesPerLesson,
          })
          .expect(400);
      }
    });
  });

  describe('tillgänglighet (availability constraints)', () => {
    it('creates a teacher constraint for a weekday', async () => {
      harness.tx['availabilityConstraint']!['create']!.mockResolvedValue({
        id: TYPE_ID,
      });

      await request(http())
        .post('/api/v1/availability-constraints')
        .set('x-test-user', admin())
        .send({
          resourceType: 'TEACHER',
          userId: STUDENT_ID,
          dayOfWeek: 5,
          startTime: '13:00',
          endTime: '16:00',
          type: 'UNAVAILABLE',
        })
        .expect(201);
    });

    it('rejects a weekday outside 1–7', async () => {
      await request(http())
        .post('/api/v1/availability-constraints')
        .set('x-test-user', admin())
        .send({
          resourceType: 'TEACHER',
          userId: STUDENT_ID,
          dayOfWeek: 0,
          startTime: '13:00',
          endTime: '16:00',
        })
        .expect(400);
    });

    it('rejects an unknown resource type', async () => {
      await request(http())
        .post('/api/v1/availability-constraints')
        .set('x-test-user', admin())
        .send({
          resourceType: 'CARETAKER',
          startTime: '13:00',
          endTime: '16:00',
        })
        .expect(400);
    });
  });

  describe('lunch och matsalens platser', () => {
    it('returns null before anyone has defined lunch', async () => {
      harness.tx['lunchSetting']!['findUnique']!.mockResolvedValue(null);

      const response = await request(http())
        .get('/api/v1/lunch-settings')
        .set('x-test-user', admin())
        .expect(200);

      // Not an invented default: the publish warning turns on being able to
      // tell "not decided yet" from "decided to be 11:00".
      expect(response.body).toEqual({});
    });

    it('saves the window, the break and the number of seats', async () => {
      // The two time columns are @db.Time, which Prisma reads as `Date`s at
      // 1970-01-01. `{ id }` alone could never come back from the database, and
      // a fixture that cannot occur is what let the endpoint ship those Dates
      // to a client asking for a clock.
      harness.tx['lunchSetting']!['upsert']!.mockResolvedValue({
        id: TYPE_ID,
        lunchStartTime: new Date('1970-01-01T11:00:00.000Z'),
        lunchEndTime: new Date('1970-01-01T13:00:00.000Z'),
      });

      const saved = await request(http())
        .put('/api/v1/lunch-settings')
        .set('x-test-user', admin())
        .send({
          lunchEnabled: true,
          lunchStartTime: '10:45',
          lunchEndTime: '12:30',
          lunchMinutes: 30,
          diningSeats: 180,
        })
        .expect(200);

      // Over the wire as a wall clock. While the row went out unserialised this
      // read "1970-01-01T11:00:00.000Z", the lunch card cut it to "1970-", and
      // <input type="time"> drew an empty box on every load.
      expect(saved.body).toMatchObject({
        lunchStartTime: '11:00',
        lunchEndTime: '13:00',
      });

      const args = harness.tx['lunchSetting']!['upsert']!.mock.calls[0]?.[0] as {
        where: { schoolId: string };
        create: { diningSeats: number };
      };
      expect(args.where.schoolId).toBe(SCHOOL_ID);
      expect(args.create.diningSeats).toBe(180);
    });

    it.each([
      // The solver grid is five minutes now, not fifteen: a 40-minute break and
      // a 10:50 start are both legal on it, and a school with 40-minute lessons
      // is why it moved. What is still refused is a time between slots.
      ['a break that is not a whole number of slots', { lunchMinutes: 37 }],
      ['a window ending after the school day', { lunchEndTime: '18:30' }],
      ['a start off the grid', { lunchStartTime: '10:52' }],
      ['a window too short for the break', { lunchEndTime: '11:00' }],
    ])('400s on %s, before it can be replayed on every run', async (_label, patch) => {
      // A saved setting is replayed on every generation, and the gateway throws
      // the engine's explanation away — so the only place these can still be
      // explained is the moment they are typed.
      await request(http())
        .put('/api/v1/lunch-settings')
        .set('x-test-user', admin())
        .send({
          lunchEnabled: true,
          lunchStartTime: '10:45',
          lunchEndTime: '12:30',
          lunchMinutes: 30,
          ...patch,
        })
        .expect(400);

      expect(harness.tx['lunchSetting']!['upsert']).not.toHaveBeenCalled();
    });

    it('400s on a seat count sent as a string', async () => {
      // enableImplicitConversion is off, so "180" is not 180 anywhere.
      await request(http())
        .put('/api/v1/lunch-settings')
        .set('x-test-user', admin())
        .send({
          lunchEnabled: true,
          lunchStartTime: '10:45',
          lunchEndTime: '12:30',
          lunchMinutes: 30,
          diningSeats: '180',
        })
        .expect(400);
    });

    it('denies a teacher on both verbs', async () => {
      for (const send of [
        () => request(http()).get('/api/v1/lunch-settings'),
        () => request(http()).put('/api/v1/lunch-settings'),
      ]) {
        await send()
          .set('x-test-user', asUser({ role: 'TEACHER' as never }))
          .send({})
          .expect(403);
      }
    });
  });

  describe('låsta tider för en årskurs', () => {
    it('creates a year-range lock that names no resource', async () => {
      harness.tx['availabilityConstraint']!['create']!.mockResolvedValue({
        id: TYPE_ID,
      });

      await request(http())
        .post('/api/v1/availability-constraints')
        .set('x-test-user', admin())
        .send({
          resourceType: 'GRADE_LEVEL',
          minGradeLevel: 4,
          maxGradeLevel: 6,
          dayOfWeek: 3,
          startTime: '11:30',
          endTime: '12:00',
          reason: 'Lunch',
        })
        .expect(201);

      const args = harness.tx['availabilityConstraint']!['create']!.mock
        .calls[0]?.[0] as { data: { minGradeLevel: number; userId: null } };
      expect(args.data).toMatchObject({ minGradeLevel: 4, userId: null });
    });

    it('400s a year-range lock with no bounds', async () => {
      await request(http())
        .post('/api/v1/availability-constraints')
        .set('x-test-user', admin())
        .send({
          resourceType: 'GRADE_LEVEL',
          dayOfWeek: 3,
          startTime: '11:30',
          endTime: '12:00',
        })
        .expect(400);
    });

    it('400s a year outside the Swedish 0-12 range', async () => {
      await request(http())
        .post('/api/v1/availability-constraints')
        .set('x-test-user', admin())
        .send({
          resourceType: 'GRADE_LEVEL',
          minGradeLevel: 13,
          dayOfWeek: 3,
          startTime: '11:30',
          endTime: '12:00',
        })
        .expect(400);
    });

    it('400s a year-range lock that also names a group', async () => {
      await request(http())
        .post('/api/v1/availability-constraints')
        .set('x-test-user', admin())
        .send({
          resourceType: 'GRADE_LEVEL',
          minGradeLevel: 4,
          studentGroupId: GROUP_ID,
          dayOfWeek: 3,
          startTime: '11:30',
          endTime: '12:00',
        })
        .expect(400);
    });
  });

  describe('RBAC', () => {
    const adminOnly = [
      ['POST', '/api/v1/academic-years'],
      ['POST', '/api/v1/room-types'],
      ['GET', '/api/v1/room-types'],
      ['POST', '/api/v1/student-groups'],
      ['POST', '/api/v1/teaching-requirements'],
      ['POST', '/api/v1/availability-constraints'],
      // Both verbs for ramtider. The GET is the one that would go missing in a
      // refactor: a decorator dropped from the class leaves the writes guarded
      // by their own bodies and the list wide open, and a list of frames tells
      // an outsider the shape of a school's day.
      ['POST', '/api/v1/frame-times'],
      ['GET', '/api/v1/frame-times'],
      ['POST', '/api/v1/lunch-servings'],
      ['GET', '/api/v1/lunch-servings'],
    ] as const;

    it.each(adminOnly)('denies a teacher on %s %s', async (method, path) => {
      const agent = request(http());
      const call = method === 'GET' ? agent.get(path) : agent.post(path);

      await call
        .set('x-test-user', asUser({ role: 'TEACHER' as never }))
        .send({})
        .expect(403);
    });
  });
});
