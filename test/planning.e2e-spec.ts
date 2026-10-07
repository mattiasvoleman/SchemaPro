import { Prisma } from '@prisma/client';
import request from 'supertest';
import { lockingRead, type LockedTable } from './utils/locking-read';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';
import { forgetStaffingWorld, givenStaffingWorld, type StaffingWorld } from './utils/staffing-world';

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

/** A `@db.Time` value as Prisma hands it back: a Date anchored at 1970-01-01. */
const wallClock = (time: string): Date => new Date(`1970-01-01T${time}:00.000Z`);

/** What Prisma throws when RLS hides the row a write names. */
const notFound = () =>
  new Prisma.PrismaClientKnownRequestError('Simulated P2025', {
    code: 'P2025',
    clientVersion: Prisma.prismaVersion.client,
  });

describe('Planning surface (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const admin = () => asUser({});

  /**
   * Answers the locking read an update() takes from `rows`, as the table would
   * (see lockingRead): a read that drops its lock, its key or a column throws,
   * and the request 500s instead of passing on a row it never asked for.
   */
  const givenLockedRows = (table: LockedTable, rows: Record<string, unknown>[]) => {
    // The auto-vivifying tx hands back a model proxy for `$queryRaw`, and a
    // proxy is not callable.
    const queryRaw = jest.fn((...call: unknown[]) =>
      Promise.resolve(lockingRead(table, rows, call)),
    );
    Object.assign(harness.tx, { $queryRaw: queryRaw });
    return queryRaw;
  };

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    // The harness outlives the test, and the table one test answered from is
    // not the next one's.
    delete (harness.tx as Record<string, unknown>)['$queryRaw'];
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

  /*
   * The staffing policy at the timplan's two write points, over HTTP: WARN is
   * the write with `warnings` in the body, REFUSE is a 409 problem carrying the
   * code AND the params the web renders its sentence from, with the table not
   * written, and OFF asks nothing. The questions themselves are pinned in
   * src/staffing/staffing-checks.spec.ts.
   */
  describe('timplan under the staffing policy', () => {
    const KARIN = '12121212-1212-4212-8212-121212121212';
    const POST_KARIN = '13131313-1313-4313-8313-131313131313';
    const REQUIREMENT_ID = '14141414-1414-4414-8414-141414141414';
    const OTHER_SUBJECT = '15151515-1515-4515-8515-151515151515';

    /** Karin carries 8 × 120 = 960 of a 1 000-minute target; behörig in neither subject. */
    const world = (overrides: StaffingWorld = {}): StaffingWorld => ({
      year: { id: YEAR_ID, startDate: new Date('2026-08-17'), endDate: new Date('2027-06-11') },
      groups: [{ id: GROUP_ID, name: '7A', gradeLevel: 7 }],
      subjects: [
        { id: SUBJECT_ID, name: 'Matematik' },
        { id: OTHER_SUBJECT, name: 'Fysik' },
      ],
      employments: [{ id: POST_KARIN, userId: KARIN }],
      requirements: [
        {
          id: 'held',
          subjectId: OTHER_SUBJECT,
          studentGroupId: GROUP_ID,
          teacherId: KARIN,
          coTeacherId: null,
          lessonsPerWeek: 8,
          minutesPerLesson: 120,
        },
      ],
      qualifications: [{ userId: STUDENT_ID, subjectId: SUBJECT_ID, minGradeLevel: 7, maxGradeLevel: 9 }],
      ...overrides,
    });

    const create = (body: Record<string, unknown> = {}) =>
      request(http())
        .post('/api/v1/teaching-requirements')
        .set('x-test-user', admin())
        .send({
          academicYearId: YEAR_ID,
          subjectId: SUBJECT_ID,
          studentGroupId: GROUP_ID,
          teacherId: KARIN,
          lessonsPerWeek: 1,
          minutesPerLesson: 60,
          ...body,
        });

    beforeEach(() => {
      harness.tx['teachingRequirement']!['create']!.mockResolvedValue({
        id: REQUIREMENT_ID,
        startDate: null,
        endDate: null,
      });
      harness.tx['teachingRequirement']!['update']!.mockResolvedValue({
        id: REQUIREMENT_ID,
        startDate: null,
        endDate: null,
      });
    });

    afterEach(() => {
      forgetStaffingWorld(harness.tx);
      harness.tx['teachingRequirement']!['findUnique']!.mockReset();
    });

    it('WARN: 201, the row written, and the finding in `warnings`', async () => {
      givenStaffingWorld(harness.tx, world());

      const response = await create().expect(201);

      expect(response.body.warnings).toEqual([
        {
          code: 'STAFF_TEACHER_NOT_QUALIFIED',
          params: { role: 'TEACHER', subject: 'Matematik', grades: '7' },
        },
      ]);
      expect(harness.tx['teachingRequirement']!['create']).toHaveBeenCalledTimes(1);
    });

    it('REFUSE: 409 with the code, the params and the Swedish — and the table untouched', async () => {
      givenStaffingWorld(harness.tx, world({ policy: { qualificationMode: 'REFUSE' } }));

      const response = await create().expect(409);

      expect(response.body).toMatchObject({
        status: 409,
        code: 'STAFF_TEACHER_NOT_QUALIFIED',
        params: { role: 'TEACHER', subject: 'Matematik', grades: '7' },
        detail: 'Läraren saknar behörighet i Matematik för åk 7.',
      });
      expect(harness.tx['teachingRequirement']!['create']).not.toHaveBeenCalled();
    });

    it('REFUSE over target on a PATCH: 409 naming minutes and limit, and the row untouched', async () => {
      const handle = givenStaffingWorld(
        harness.tx,
        world({
          policy: { overAllocationMode: 'REFUSE', qualificationMode: 'OFF' },
          requirements: [
            ...world().requirements!,
            {
              id: REQUIREMENT_ID,
              subjectId: SUBJECT_ID,
              studentGroupId: GROUP_ID,
              teacherId: KARIN,
              coTeacherId: null,
              lessonsPerWeek: 1,
              minutesPerLesson: 60,
            },
          ],
        }),
      );
      harness.tx['teachingRequirement']!['findUnique']!.mockResolvedValue({
        academicYearId: YEAR_ID,
        subjectId: SUBJECT_ID,
        studentGroupId: GROUP_ID,
        teacherId: KARIN,
        coTeacherId: null,
      });

      // 960 + 60 = 1 020 today; 4 × 60 makes it 1 200, past the 1 100 limit.
      const response = await request(http())
        .patch(`/api/v1/teaching-requirements/${REQUIREMENT_ID}`)
        .set('x-test-user', admin())
        .send({ lessonsPerWeek: 4 })
        .expect(409);

      expect(response.body).toMatchObject({
        code: 'STAFF_TEACHER_OVER_TARGET',
        params: { role: 'TEACHER', minutes: 1200, target: 1000, limit: 1100, tolerance: 10 },
      });
      expect(handle.locked).toEqual([[POST_KARIN]]);
      expect(harness.tx['teachingRequirement']!['update']).not.toHaveBeenCalled();
    });

    it('OFF: 201 with no warnings, and no post locked', async () => {
      const handle = givenStaffingWorld(
        harness.tx,
        world({ policy: { qualificationMode: 'OFF', overAllocationMode: 'OFF' } }),
      );

      const response = await create({ lessonsPerWeek: 10 }).expect(201);

      expect(response.body.warnings).toEqual([]);
      expect(handle.locked).toEqual([]);
      expect(harness.tx['teachingRequirement']!['create']).toHaveBeenCalledTimes(1);
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

    it('400s a window carrying a second, which the table would answer with a 500', async () => {
      // The same defect as on teacher-work-rules, on the one other table whose
      // CHECK counts seconds. The DTO takes HH:MM:SS because that is what
      // PostgREST hands back, and assertFitsTheSolverGrid reads only hours and
      // minutes — so 11:00:30 to 11:30 measured as a whole thirty minutes, sat
      // on the grid, and went to the database, whose
      // LunchSettings_window_fits_break counts 1770 seconds against 1800 and
      // refuses it. That refusal is not a Prisma code this gateway maps, so the
      // admin got a 500 with no field named. The status code is the contract
      // here, not the sentence.
      await request(http())
        .put('/api/v1/lunch-settings')
        .set('x-test-user', admin())
        .send({
          lunchEnabled: true,
          lunchStartTime: '11:00:30',
          lunchEndTime: '11:30:00',
          lunchMinutes: 30,
        })
        .expect(400);

      expect(harness.tx['lunchSetting']!['upsert']).not.toHaveBeenCalled();
    });

    it('still takes the zero seconds PostgREST writes out', async () => {
      // Why the DTO admits HH:MM:SS at all. Refusing the second must not refuse
      // the round-trip it exists for.
      harness.tx['lunchSetting']!['upsert']!.mockResolvedValue({
        id: TYPE_ID,
        lunchStartTime: new Date('1970-01-01T10:45:00.000Z'),
        lunchEndTime: new Date('1970-01-01T12:30:00.000Z'),
      });

      await request(http())
        .put('/api/v1/lunch-settings')
        .set('x-test-user', admin())
        .send({
          lunchEnabled: true,
          lunchStartTime: '10:45:00',
          lunchEndTime: '12:30:00',
          lunchMinutes: 30,
        })
        .expect(200);
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

  // The RBAC table at the bottom proves a teacher is turned away from the three
  // routes below, and that 403 comes from RolesGuard before any handler runs.
  // What follows is the admin getting through: the route resolving, the DTO
  // taking the body the page actually sends through the real ValidationPipe,
  // the school stamped by the service rather than the client, and @db.Time
  // leaving as a clock rather than a 1970 timestamp.

  describe('lunchsittningar (lunch servings)', () => {
    const SERVING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    const storedServing = (overrides: Record<string, unknown> = {}) => ({
      id: SERVING_ID,
      schoolId: SCHOOL_ID,
      minGradeLevel: 4,
      maxGradeLevel: 6,
      dayOfWeek: null,
      startTime: wallClock('11:00'),
      endTime: wallClock('11:30'),
      seats: null,
      createdAt: new Date('2026-08-31T09:00:00.000Z'),
      updatedAt: new Date('2026-08-31T09:00:00.000Z'),
      ...overrides,
    });

    /** The stored sitting, found by its own id under update()'s lock and by nothing else. */
    const givenServing = (overrides: Record<string, unknown> = {}) =>
      givenLockedRows(
        { name: 'LunchServings', columns: Object.keys(storedServing()), lock: 'FOR UPDATE' },
        [storedServing(overrides)],
      );

    it('lists the flow as clock times, and only the fields the page reads', async () => {
      harness.tx['lunchServing']!['findMany']!.mockResolvedValue([storedServing()]);

      const response = await request(http())
        .get('/api/v1/lunch-servings')
        .set('x-test-user', admin())
        .expect(200);

      // The row carries @db.Time Dates and the school's id. Neither is what the
      // page reads, and the Dates are what the lunch-settings route once sent
      // to a client asking for a clock.
      expect(response.body).toEqual([
        {
          id: SERVING_ID,
          minGradeLevel: 4,
          maxGradeLevel: 6,
          dayOfWeek: null,
          startTime: '11:00',
          endTime: '11:30',
          seats: null,
        },
      ]);
    });

    it('creates the every-day sitting for the caller’s school, null day and seats included', async () => {
      harness.tx['lunchServing']!['create']!.mockResolvedValue(storedServing());

      // The page's body (admin/lunch-servings/page.tsx): an empty seats field is
      // sent as null, the hall's own limit, and "every day" as dayOfWeek: null.
      const response = await request(http())
        .post('/api/v1/lunch-servings')
        .set('x-test-user', admin())
        .send({
          minGradeLevel: 4,
          maxGradeLevel: 6,
          dayOfWeek: null,
          startTime: '11:00',
          endTime: '11:30',
          seats: null,
        })
        .expect(201);

      expect(response.body).toMatchObject({ id: SERVING_ID, startTime: '11:00', endTime: '11:30' });
      const args = harness.tx['lunchServing']!['create']!.mock.calls[0]?.[0] as {
        data: { schoolId: string; dayOfWeek: number | null; seats: number | null };
      };
      expect(args.data).toMatchObject({ schoolId: SCHOOL_ID, dayOfWeek: null, seats: null });
    });

    it('400s a sitting with no chairs, before it reaches the database', async () => {
      await request(http())
        .post('/api/v1/lunch-servings')
        .set('x-test-user', admin())
        .send({ minGradeLevel: 4, maxGradeLevel: 6, startTime: '11:00', endTime: '11:30', seats: 0 })
        .expect(400);

      expect(harness.tx['lunchServing']!['create']).not.toHaveBeenCalled();
    });

    it('checks a PATCH against the stored window, not the payload alone', async () => {
      // Sent alone, 10:30 is a valid time. Against the stored 11:00 it is a
      // sitting that ends before it begins.
      givenServing();

      await request(http())
        .patch(`/api/v1/lunch-servings/${SERVING_ID}`)
        .set('x-test-user', admin())
        .send({ endTime: '10:30' })
        .expect(400);

      expect(harness.tx['lunchServing']!['update']).not.toHaveBeenCalled();
    });

    it('writes only the fields a PATCH names', async () => {
      givenServing();
      harness.tx['lunchServing']!['update']!.mockResolvedValue(storedServing({ seats: 60 }));

      const response = await request(http())
        .patch(`/api/v1/lunch-servings/${SERVING_ID}`)
        .set('x-test-user', admin())
        .send({ seats: 60 })
        .expect(200);

      expect(response.body).toMatchObject({ seats: 60, startTime: '11:00' });
      expect(harness.tx['lunchServing']!['update']).toHaveBeenCalledWith({
        where: { id: SERVING_ID },
        data: { seats: 60 },
      });
    });

    it('deletes with 204 and no body', async () => {
      harness.tx['lunchServing']!['delete']!.mockResolvedValue(storedServing());

      const response = await request(http())
        .delete(`/api/v1/lunch-servings/${SERVING_ID}`)
        .set('x-test-user', admin())
        .expect(204);

      expect(response.body).toEqual({});
      expect(harness.tx['lunchServing']!['delete']).toHaveBeenCalledWith({
        where: { id: SERVING_ID },
      });
    });

    it('400s on an id that is not a v4 uuid, before touching the table', async () => {
      // update() reads the row under a lock, so that read is what the pipe has
      // to stop; findUnique is not called on this path at all.
      const queryRaw = givenServing();

      await request(http())
        .patch('/api/v1/lunch-servings/not-a-uuid')
        .set('x-test-user', admin())
        .send({ seats: 60 })
        .expect(400);

      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('404s on a sitting RLS hides, rather than a 500', async () => {
      harness.tx['lunchServing']!['delete']!.mockRejectedValueOnce(notFound());

      await request(http())
        .delete(`/api/v1/lunch-servings/${SERVING_ID}`)
        .set('x-test-user', admin())
        .expect(404);
    });
  });

  describe('raster', () => {
    const RAST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    /**
     * What the admin page sends, for a create and an edit alike: its submit
     * builds one object from the whole form (admin/rasts/page.tsx), and its
     * "every day" option is `dayOfWeek: null`.
     */
    const PAGE_BODY = {
      name: 'Förmiddagsrast',
      minGradeLevel: 4,
      maxGradeLevel: 6,
      dayOfWeek: null,
      startTime: '09:40',
      endTime: '10:00',
      requiresLessonBefore: false,
    };

    const storedRast = (overrides: Record<string, unknown> = {}) => ({
      id: RAST_ID,
      schoolId: SCHOOL_ID,
      name: 'Förmiddagsrast',
      minGradeLevel: 4,
      maxGradeLevel: 6,
      dayOfWeek: null,
      startTime: wallClock('09:40'),
      endTime: wallClock('10:00'),
      requiresLessonBefore: false,
      createdAt: new Date('2026-09-05T09:00:00.000Z'),
      updatedAt: new Date('2026-09-05T09:00:00.000Z'),
      ...overrides,
    });

    /** The stored rast, found by its own id under update()'s lock and by nothing else. */
    const givenRast = (overrides: Record<string, unknown> = {}) =>
      givenLockedRows(
        { name: 'Rasts', columns: Object.keys(storedRast()), lock: 'FOR UPDATE' },
        [storedRast(overrides)],
      );

    it('lists them as clock times, with whether a lesson must come first', async () => {
      harness.tx['rast']!['findMany']!.mockResolvedValue([storedRast()]);

      const response = await request(http())
        .get('/api/v1/rasts')
        .set('x-test-user', admin())
        .expect(200);

      expect(response.body).toEqual([
        {
          id: RAST_ID,
          name: 'Förmiddagsrast',
          minGradeLevel: 4,
          maxGradeLevel: 6,
          dayOfWeek: null,
          startTime: '09:40',
          endTime: '10:00',
          requiresLessonBefore: false,
        },
      ]);
    });

    it('creates the every-day rast the page sends, for the caller’s school and with its rule', async () => {
      // The rule is sent switched on: the page's default is false, and so is
      // the service's, so a flag that never reached the row would pass unseen.
      harness.tx['rast']!['create']!.mockResolvedValue(storedRast({ requiresLessonBefore: true }));

      const response = await request(http())
        .post('/api/v1/rasts')
        .set('x-test-user', admin())
        .send({ ...PAGE_BODY, requiresLessonBefore: true })
        .expect(201);

      expect(response.body).toMatchObject({
        id: RAST_ID,
        startTime: '09:40',
        endTime: '10:00',
        requiresLessonBefore: true,
      });
      const args = harness.tx['rast']!['create']!.mock.calls[0]?.[0] as {
        data: { schoolId: string; dayOfWeek: number | null; requiresLessonBefore: boolean };
      };
      expect(args.data).toMatchObject({
        schoolId: SCHOOL_ID,
        dayOfWeek: null,
        requiresLessonBefore: true,
      });
    });

    it('400s the lesson-before rule sent as the string "true"', async () => {
      // enableImplicitConversion is off, so "true" is not true anywhere. Refused
      // here it is a 400 the form can show, not a type error from the database.
      await request(http())
        .post('/api/v1/rasts')
        .set('x-test-user', admin())
        .send({ ...PAGE_BODY, requiresLessonBefore: 'true' })
        .expect(400);

      expect(harness.tx['rast']!['create']).not.toHaveBeenCalled();
    });

    it('takes the whole form back as an edit, not only the field that changed', async () => {
      givenRast();
      harness.tx['rast']!['update']!.mockResolvedValue(
        storedRast({ dayOfWeek: 5, requiresLessonBefore: true }),
      );

      const response = await request(http())
        .patch(`/api/v1/rasts/${RAST_ID}`)
        .set('x-test-user', admin())
        .send({ ...PAGE_BODY, dayOfWeek: 5, requiresLessonBefore: true })
        .expect(200);

      expect(response.body).toMatchObject({
        id: RAST_ID,
        dayOfWeek: 5,
        startTime: '09:40',
        requiresLessonBefore: true,
      });
      expect(harness.tx['rast']!['update']).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: RAST_ID },
          data: expect.objectContaining({ dayOfWeek: 5, requiresLessonBefore: true }),
        }),
      );
    });

    it('deletes with 204 and no body', async () => {
      harness.tx['rast']!['delete']!.mockResolvedValue(storedRast());

      const response = await request(http())
        .delete(`/api/v1/rasts/${RAST_ID}`)
        .set('x-test-user', admin())
        .expect(204);

      expect(response.body).toEqual({});
      expect(harness.tx['rast']!['delete']).toHaveBeenCalledWith({ where: { id: RAST_ID } });
    });

    it('400s on an id that is not a v4 uuid, before touching the table', async () => {
      await request(http())
        .delete('/api/v1/rasts/1')
        .set('x-test-user', admin())
        .expect(400);

      expect(harness.tx['rast']!['delete']).not.toHaveBeenCalled();
    });

    it('404s on a rast RLS hides, rather than a 500', async () => {
      harness.tx['rast']!['delete']!.mockRejectedValueOnce(notFound());

      await request(http())
        .delete(`/api/v1/rasts/${RAST_ID}`)
        .set('x-test-user', admin())
        .expect(404);
    });
  });

  describe('en lunch lagd för hand (lunch sittings)', () => {
    const SITTING_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    /** What the grid sends when the school clicks a meal onto a day (admin/timetable/page.tsx). */
    const PLACE_BODY = {
      academicYearId: YEAR_ID,
      studentGroupId: GROUP_ID,
      dayOfWeek: 2,
      startTime: '13:00',
    };

    const storedSitting = (overrides: Record<string, unknown> = {}) => ({
      id: SITTING_ID,
      schoolId: SCHOOL_ID,
      academicYearId: YEAR_ID,
      studentGroupId: GROUP_ID,
      dayOfWeek: 2,
      startTime: wallClock('13:00'),
      endTime: wallClock('13:30'),
      headcount: 24,
      isGenerated: false,
      createdAt: new Date('2026-09-11T09:00:00.000Z'),
      updatedAt: new Date('2026-09-11T09:00:00.000Z'),
      ...overrides,
    });

    // Lunch on and thirty minutes long, and GROUP_ID a class of YEAR_ID with 24
    // pupils at home in it: what every placement reads before it writes.
    beforeEach(() => {
      harness.tx['lunchSetting']!['findUnique']!.mockResolvedValue({
        lunchEnabled: true,
        lunchMinutes: 30,
      });
      harness.tx['studentGroup']!['findFirst']!.mockResolvedValue({ id: GROUP_ID });
      harness.tx['user']!['count']!.mockResolvedValue(24);
    });

    // clearAllMocks keeps a stubbed value, so these would otherwise answer for
    // every describe below this one.
    afterEach(() => {
      harness.tx['lunchSetting']!['findUnique']!.mockReset();
      harness.tx['studentGroup']!['findFirst']!.mockReset();
      harness.tx['user']!['count']!.mockReset();
    });

    it('places the meal the grid sends as the school’s, as long as lunch is', async () => {
      harness.tx['lunchSitting']!['upsert']!.mockResolvedValue(storedSitting());

      const response = await request(http())
        .post('/api/v1/lunch-sittings')
        .set('x-test-user', admin())
        .send(PLACE_BODY)
        .expect(201);

      expect(response.body).toEqual({
        id: SITTING_ID,
        studentGroupId: GROUP_ID,
        dayOfWeek: 2,
        startTime: '13:00',
        endTime: '13:30',
        headcount: 24,
        isGenerated: false,
      });
      // The end is the school's one lunch length after the start, the tenant
      // comes from the principal, and false is what makes the next run keep
      // the meal and send it back as a pin.
      const args = harness.tx['lunchSitting']!['upsert']!.mock.calls[0]?.[0] as {
        create: { schoolId: string; endTime: Date; headcount: number; isGenerated: boolean };
      };
      expect(args.create).toMatchObject({
        schoolId: SCHOOL_ID,
        endTime: wallClock('13:30'),
        headcount: 24,
        isGenerated: false,
      });
    });

    it('400s a body that names its own end, before anything is read', async () => {
      // Only the start: the length is the school's lunchMinutes, and an end in
      // the body would be a second answer to how long lunch is — one a meal
      // placed by hand would go on giving after the setting changed.
      await request(http())
        .post('/api/v1/lunch-sittings')
        .set('x-test-user', admin())
        .send({ ...PLACE_BODY, endTime: '13:45' })
        .expect(400);

      expect(harness.tx['lunchSetting']!['findUnique']).not.toHaveBeenCalled();
      expect(harness.tx['lunchSitting']!['upsert']).not.toHaveBeenCalled();
    });

    it('moves the solver’s meal as a drag sends it: pinned, a lunch long, in place of that day’s', async () => {
      harness.tx['lunchSitting']!['findUnique']!.mockResolvedValue(
        storedSitting({ isGenerated: true }),
      );
      harness.tx['lunchSitting']!['deleteMany']!.mockResolvedValue({ count: 1 });
      harness.tx['lunchSitting']!['update']!.mockResolvedValue(
        storedSitting({ dayOfWeek: 3, startTime: wallClock('13:15'), endTime: wallClock('13:45') }),
      );

      // A drag names both the day and the start (moveLunch in the grid).
      const response = await request(http())
        .patch(`/api/v1/lunch-sittings/${SITTING_ID}`)
        .set('x-test-user', admin())
        .send({ dayOfWeek: 3, startTime: '13:15' })
        .expect(200);

      expect(response.body).toMatchObject({
        dayOfWeek: 3,
        startTime: '13:15',
        endTime: '13:45',
        isGenerated: false,
      });
      // A class eats once a day, so Wednesday's meal makes way for the one
      // dragged onto it rather than failing on the unique key.
      expect(harness.tx['lunchSitting']!['deleteMany']).toHaveBeenCalledWith({
        where: { academicYearId: YEAR_ID, studentGroupId: GROUP_ID, dayOfWeek: 3 },
      });
      expect(harness.tx['lunchSitting']!['update']).toHaveBeenCalledWith({
        where: { id: SITTING_ID },
        data: {
          dayOfWeek: 3,
          startTime: wallClock('13:15'),
          endTime: wallClock('13:45'),
          isGenerated: false,
        },
      });
    });

    it('removes a meal placed by hand with 204 and no body', async () => {
      harness.tx['lunchSitting']!['findUnique']!.mockResolvedValue(storedSitting());

      const response = await request(http())
        .delete(`/api/v1/lunch-sittings/${SITTING_ID}`)
        .set('x-test-user', admin())
        .expect(204);

      expect(response.body).toEqual({});
      expect(harness.tx['lunchSitting']!['delete']).toHaveBeenCalledWith({
        where: { id: SITTING_ID },
      });
    });

    it('refuses to remove the solver’s meal, which would leave the day with none', async () => {
      harness.tx['lunchSitting']!['findUnique']!.mockResolvedValue(
        storedSitting({ isGenerated: true }),
      );

      await request(http())
        .delete(`/api/v1/lunch-sittings/${SITTING_ID}`)
        .set('x-test-user', admin())
        .expect(400);

      expect(harness.tx['lunchSitting']!['delete']).not.toHaveBeenCalled();
    });

    it('400s on an id that is not a v4 uuid, before touching the table', async () => {
      await request(http())
        .patch('/api/v1/lunch-sittings/not-a-uuid')
        .set('x-test-user', admin())
        .send({ dayOfWeek: 3 })
        .expect(400);

      expect(harness.tx['lunchSitting']!['findUnique']).not.toHaveBeenCalled();
    });

    it('404s on a meal RLS hides, rather than a 500', async () => {
      // Under RLS another school's row reads as no row at all.
      harness.tx['lunchSitting']!['findUnique']!.mockResolvedValue(null);

      await request(http())
        .delete(`/api/v1/lunch-sittings/${SITTING_ID}`)
        .set('x-test-user', admin())
        .expect(404);

      expect(harness.tx['lunchSitting']!['delete']).not.toHaveBeenCalled();
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

  describe('lärarnas arbetstid', () => {
    /*
     * The one resource in this module a TEACHER may write, so the round trip is
     * what covers it: an RBAC row stops at the guard and proves nothing about the
     * handler, and the ownership rule lives in the handler.
     */
    const TEACHER_ID = '22222222-2222-4222-8222-222222222222';
    const COLLEAGUE_ID = '77777777-7777-4777-8777-777777777777';
    const teacher = () => asUser({ role: 'TEACHER' as never });

    const storedRule = (userId: string) => ({
      id: '10101010-1010-4010-8010-101010101010',
      schoolId: SCHOOL_ID,
      userId,
      lunchMinutes: 30,
      lunchStartTime: wallClock('10:30'),
      lunchEndTime: wallClock('13:30'),
      minDailyRestMinutes: 660,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    beforeEach(() => {
      // Whose rule may exist is a question about Users.role, asked inside the
      // writing transaction because a CHECK cannot read another table.
      harness.tx['user']!['findUnique']!.mockResolvedValue({ role: 'TEACHER' });
    });

    it('an admin writes any teacher’s row, and gets clocks back', async () => {
      harness.tx['teacherWorkRule']!['upsert']!.mockResolvedValue(
        storedRule(COLLEAGUE_ID),
      );

      const response = await request(http())
        .put(`/api/v1/teacher-work-rules/${COLLEAGUE_ID}`)
        .set('x-test-user', admin())
        .send({
          lunchMinutes: 30,
          lunchStartTime: '10:30',
          lunchEndTime: '13:30',
          minDailyRestMinutes: 660,
        })
        .expect(200);

      // A timestamp here is what emptied the lunch card's time inputs; the form
      // reads these into <input type="time">.
      expect(response.body).toMatchObject({
        userId: COLLEAGUE_ID,
        lunchStartTime: '10:30',
        lunchEndTime: '13:30',
        minDailyRestMinutes: 660,
      });
      expect(JSON.stringify(response.body)).not.toContain('1970');
    });

    it('a teacher writes their own', async () => {
      harness.tx['teacherWorkRule']!['upsert']!.mockResolvedValue(
        storedRule(TEACHER_ID),
      );

      await request(http())
        .put(`/api/v1/teacher-work-rules/${TEACHER_ID}`)
        .set('x-test-user', teacher())
        .send({ minDailyRestMinutes: 660 })
        .expect(200);
    });

    it('403s a teacher writing a colleague’s, without touching the table', async () => {
      await request(http())
        .put(`/api/v1/teacher-work-rules/${COLLEAGUE_ID}`)
        .set('x-test-user', teacher())
        .send({ minDailyRestMinutes: 660 })
        .expect(403);

      expect(harness.tx['teacherWorkRule']!['upsert']).not.toHaveBeenCalled();
    });

    it('403s a teacher deleting a colleague’s', async () => {
      await request(http())
        .delete(`/api/v1/teacher-work-rules/${COLLEAGUE_ID}`)
        .set('x-test-user', teacher())
        .expect(403);

      expect(harness.tx['teacherWorkRule']!['delete']).not.toHaveBeenCalled();
    });

    it('204s a delete of one’s own row', async () => {
      await request(http())
        .delete(`/api/v1/teacher-work-rules/${TEACHER_ID}`)
        .set('x-test-user', teacher())
        .expect(204);

      expect(harness.tx['teacherWorkRule']!['delete']).toHaveBeenCalledWith({
        where: { userId: TEACHER_ID },
      });
    });

    it('400s half a lunch rule', async () => {
      // A length with no window is a lunch the solver may place at 07:00. The
      // table refuses it too; this is the route saying which field is missing.
      await request(http())
        .put(`/api/v1/teacher-work-rules/${TEACHER_ID}`)
        .set('x-test-user', admin())
        .send({ lunchMinutes: 30 })
        .expect(400);
    });

    it('400s a length off the solver grid', async () => {
      await request(http())
        .put(`/api/v1/teacher-work-rules/${TEACHER_ID}`)
        .set('x-test-user', admin())
        .send({ lunchMinutes: 7, lunchStartTime: '10:30', lunchEndTime: '13:30' })
        .expect(400);
    });

    it('400s a window carrying a second, which the table would answer with a 500', async () => {
      // The DTO takes HH:MM:SS, because that is what PostgREST hands back, and
      // the service's width check reads only hours and minutes — so 10:30:30 to
      // 11:00 measured as a whole thirty minutes and went to the database, whose
      // CHECK counts seconds and refused it. That refusal is not a Prisma code
      // this gateway maps, so the admin got a 500 with no field named. The
      // status code is the contract here, not the sentence.
      await request(http())
        .put(`/api/v1/teacher-work-rules/${TEACHER_ID}`)
        .set('x-test-user', admin())
        .send({
          lunchMinutes: 30,
          lunchStartTime: '10:30:30',
          lunchEndTime: '11:00:00',
        })
        .expect(400);
    });

    it('400s a path that is not a uuid, before any of that', async () => {
      await request(http())
        .put('/api/v1/teacher-work-rules/anna')
        .set('x-test-user', admin())
        .send({ minDailyRestMinutes: 660 })
        .expect(400);
    });

    it('lists the school’s rules for a teacher too', async () => {
      // A refused week names the rule row that did not fit, and a teacher who
      // cannot open it meets a refusal with no visible cause.
      harness.tx['teacherWorkRule']!['findMany']!.mockResolvedValue([
        storedRule(COLLEAGUE_ID),
      ]);

      const response = await request(http())
        .get('/api/v1/teacher-work-rules')
        .set('x-test-user', teacher())
        .expect(200);

      expect(response.body).toHaveLength(1);
    });

    it('404s a write against a row RLS hides', async () => {
      harness.tx['user']!['findUnique']!.mockResolvedValue(null);

      await request(http())
        .put(`/api/v1/teacher-work-rules/${COLLEAGUE_ID}`)
        .set('x-test-user', admin())
        .send({ minDailyRestMinutes: 660 })
        .expect(404);
    });
  });

  describe('nationella timplanen och ämneskopplingen', () => {
    /*
     * Two things the subjects form could not say before: which cell of the
     * statute a school subject feeds, and whether it is undervisning at all.
     * The create round trip is what covers the handler — the known-code lookup
     * and the Swedish refusal both live there, and the DTO alone cannot know a
     * code from a typo.
     */
    const NATIONAL_SUBJECT_ID = 'abababab-abab-4bab-8bab-abababababab';
    const teacher = () => asUser({ role: 'TEACHER' as never });
    const student = () => asUser({ role: 'STUDENT' as never });

    const storedSubject = (nationalCode: string | null, countsTowardTimplan = true) => ({
      id: NATIONAL_SUBJECT_ID,
      schoolId: SCHOOL_ID,
      name: 'Matematik',
      code: 'MA',
      color: null,
      requiredRoomTypeId: null,
      nationalCode,
      countsTowardTimplan,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    const statute = () => {
      harness.tx['nationalTimplanVersion']!['findMany']!.mockResolvedValue([
        {
          id: '0b1e0b1e-0b1e-40b1-80b1-0b1e0b1e0b1e',
          code: 'SFS2023:945/B1',
          sfs: 'SFS 2023:945',
          title: 'Timplan för grundskolan',
          schoolForm: 'GRUNDSKOLA',
          totalHours: 6890,
          skolansValHours: 600,
          reductionCapPercent: 20,
          appliesFromCohortTerm: 'HT2024',
          supersededByCode: 'SFS2025:729',
          entries: [
            {
              subjectCode: 'MA',
              stage: 'LAG',
              hours: 420,
              minimumHoursPerChild: null,
              protectedFromReduction: true,
            },
          ],
        },
      ]);
      harness.tx['nationalSubject']!['findMany']!.mockResolvedValue([
        { code: 'MA', name: 'Matematik', parentCode: null, isGroup: false },
      ]);
    };

    it('an admin creates a subject with a national code, and reads both fields back', async () => {
      harness.tx['nationalSubject']!['findUnique']!.mockResolvedValue({ code: 'MA' });
      harness.tx['subject']!['create']!.mockResolvedValue(storedSubject('MA', true));

      const response = await request(http())
        .post('/api/v1/subjects')
        .set('x-test-user', admin())
        .send({ name: 'Matematik', code: 'MA', nationalCode: 'MA', countsTowardTimplan: true })
        .expect(201);

      expect(response.body).toMatchObject({
        id: NATIONAL_SUBJECT_ID,
        nationalCode: 'MA',
        countsTowardTimplan: true,
      });
      const args = harness.tx['subject']!['create']!.mock.calls[0]?.[0] as {
        data: { schoolId: string; nationalCode: string | null; countsTowardTimplan: boolean };
      };
      expect(args.data).toMatchObject({
        schoolId: SCHOOL_ID,
        nationalCode: 'MA',
        countsTowardTimplan: true,
      });
    });

    it('400s an unknown code in Swedish, naming the field, and writes nothing', async () => {
      // The FK would refuse it too, as a 409 about "a record"; the status and
      // the field name are the contract, the sentence is not.
      harness.tx['nationalSubject']!['findUnique']!.mockResolvedValue(null);

      const response = await request(http())
        .post('/api/v1/subjects')
        .set('x-test-user', admin())
        .send({ name: 'Matte', nationalCode: 'MATTE' })
        .expect(400);

      expect(response.body.detail).toContain('nationalCode');
      expect(response.body.detail).toContain('MATTE');
      expect(harness.tx['subject']!['create']).not.toHaveBeenCalled();
    });

    it('400s a flag that is not a boolean, before the handler', async () => {
      await request(http())
        .post('/api/v1/subjects')
        .set('x-test-user', admin())
        .send({ name: 'Resurs', countsTowardTimplan: 'nej' })
        .expect(400);

      expect(harness.tx['subject']!['create']).not.toHaveBeenCalled();
    });

    it('a PATCH clears the mapping with null and flags a subject as not undervisning', async () => {
      harness.tx['subject']!['update']!.mockResolvedValue(storedSubject(null, false));

      const response = await request(http())
        .patch(`/api/v1/subjects/${NATIONAL_SUBJECT_ID}`)
        .set('x-test-user', admin())
        .send({ nationalCode: null, countsTowardTimplan: false })
        .expect(200);

      expect(response.body).toMatchObject({ nationalCode: null, countsTowardTimplan: false });
      expect(harness.tx['subject']!['update']).toHaveBeenCalledWith({
        where: { id: NATIONAL_SUBJECT_ID },
        data: { nationalCode: null, countsTowardTimplan: false },
      });
      // Clearing is not a code to look up.
      expect(harness.tx['nationalSubject']!['findUnique']).not.toHaveBeenCalled();
    });

    it('404s a PATCH against a subject RLS hides', async () => {
      harness.tx['nationalSubject']!['findUnique']!.mockResolvedValue({ code: 'MA' });
      harness.tx['subject']!['update']!.mockRejectedValue(notFound());

      await request(http())
        .patch(`/api/v1/subjects/${NATIONAL_SUBJECT_ID}`)
        .set('x-test-user', admin())
        .send({ nationalCode: 'MA' })
        .expect(404);
    });

    it.each([
      ['TEACHER', teacher],
      ['STUDENT', student],
    ])('hands the statute to a %s', async (_role, principal) => {
      // Public information: a pupil asking how many hours of matematik the
      // law guarantees is asking the law, not the school.
      statute();

      const response = await request(http())
        .get('/api/v1/national-timplans')
        .set('x-test-user', principal())
        .expect(200);

      expect(response.body.versions).toHaveLength(1);
      expect(response.body.versions[0]).toMatchObject({
        code: 'SFS2023:945/B1',
        totalHours: 6890,
        entries: [{ subjectCode: 'MA', stage: 'LAG', hours: 420 }],
      });
      expect(response.body.subjects).toEqual([
        { code: 'MA', name: 'Matematik', parentCode: null, isGroup: false },
      ]);
    });

    it('is cacheable: Cache-Control, an ETag, and a 304 on If-None-Match', async () => {
      // The figures change on a deploy and not before, so a client holding
      // them costs nothing; the ETag is Express's own, computed from the body,
      // and the service orders every list so the same data gives the same tag.
      statute();

      const first = await request(http())
        .get('/api/v1/national-timplans')
        .set('x-test-user', admin())
        .expect(200);

      expect(first.headers['cache-control']).toBe('private, max-age=3600');
      const etag = first.headers['etag'];
      expect(etag).toBeDefined();

      await request(http())
        .get('/api/v1/national-timplans')
        .set('x-test-user', admin())
        .set('If-None-Match', etag!)
        .expect(304);
    });

    it('403s a principal with no school, rather than answering with six empty tables', async () => {
      await request(http())
        .get('/api/v1/national-timplans')
        .set('x-test-user', asUser({ schoolId: undefined }))
        .expect(403);

      expect(harness.tx['nationalTimplanVersion']!['findMany']).not.toHaveBeenCalled();
    });

    it('403s SYSTEM_ADMIN, who has no Users row and would read nothing under RLS', async () => {
      await request(http())
        .get('/api/v1/national-timplans')
        .set('x-test-user', asUser({ role: 'SYSTEM_ADMIN' as never, schoolId: undefined }))
        .expect(403);
    });
  });

  describe('tjänstefördelning', () => {
    /*
     * The module whose role lists differ per verb: a TEACHER reads their own
     * post, every behörighet and their own load, and writes nothing. The
     * writes stop at the guard with a 403 — so each controller also needs an
     * ADMIN round trip here, or no handler is covered at all.
     */
    const TEACHER_ID = '22222222-2222-4222-8222-222222222222';
    const COLLEAGUE_ID = '77777777-7777-4777-8777-777777777777';
    const teacher = () => asUser({ role: 'TEACHER' as never });

    /** Users as the post and behörighet writes lock the teacher's row: FOR NO KEY UPDATE. */
    const USERS: LockedTable = {
      name: 'Users',
      columns: ['id', 'schoolId', 'role', 'firstName', 'lastName', 'email', 'isActive', 'studentGroupId'],
      lock: 'FOR NO KEY UPDATE',
    };

    const storedEmployment = (userId: string, overrides: Record<string, unknown> = {}) => ({
      id: '20202020-2020-4020-8020-202020202020',
      schoolId: SCHOOL_ID,
      userId,
      academicYearId: YEAR_ID,
      employmentPercent: new Prisma.Decimal('80.000'),
      reductionPercent: new Prisma.Decimal('0.000'),
      contractKind: 'FERIE',
      teachingTargetMinutesPerWeek: null,
      signature: 'KOL',
      note: null,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      ...overrides,
    });

    const storedQualification = (userId: string) => ({
      id: '30303030-3030-4030-8030-303030303030',
      schoolId: SCHOOL_ID,
      userId,
      subjectId: SUBJECT_ID,
      minGradeLevel: 7,
      maxGradeLevel: 9,
      kind: 'LEGITIMATION',
      validFrom: null,
      validTo: new Date('2030-06-30T00:00:00.000Z'),
      note: null,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    const storedPolicy = (overrides: Record<string, unknown> = {}) => ({
      id: '40404040-4040-4040-8040-404040404040',
      schoolId: SCHOOL_ID,
      fullTimeTeachingMinutesPerWeek: 1080,
      fullTimeRegulatedHoursPerYear: 1360,
      fullTimeAnnualHours: 1767,
      workDaysPerYear: 194,
      semesterHoursPerWeek: new Prisma.Decimal('40.0'),
      qualificationMode: 'WARN',
      overAllocationMode: 'WARN',
      overAllocationTolerancePercent: 10,
      loadModel: 'MINUTES',
      unstaffedGeneration: 'ALLOW',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      ...overrides,
    });

    describe('inställningar (staffing policy)', () => {
      it('an admin reads and writes the school’s row, and gets numbers back', async () => {
        harness.tx['staffingPolicy']!['findUnique']!.mockResolvedValue(storedPolicy());
        harness.tx['staffingPolicy']!['upsert']!.mockResolvedValue(storedPolicy());

        const read = await request(http())
          .get('/api/v1/staffing-policy')
          .set('x-test-user', admin())
          .expect(200);
        expect(read.body).toMatchObject({ fullTimeTeachingMinutesPerWeek: 1080, semesterHoursPerWeek: 40 });

        const written = await request(http())
          .put('/api/v1/staffing-policy')
          .set('x-test-user', admin())
          .send({ fullTimeTeachingMinutesPerWeek: 1080, overAllocationTolerancePercent: 10 })
          .expect(200);
        expect(written.body).toMatchObject({ semesterHoursPerWeek: 40 });
        const args = harness.tx['staffingPolicy']!['upsert']!.mock.calls[0]?.[0] as {
          create: Record<string, unknown>;
        };
        expect(args.create).toMatchObject({
          schoolId: SCHOOL_ID,
          fullTimeRegulatedHoursPerYear: 1360,
          unstaffedGeneration: 'ALLOW',
        });
      });

      it('writes the generation refusal through the handler, and 400s a mode it does not have', async () => {
        harness.tx['staffingPolicy']!['upsert']!.mockResolvedValue(
          storedPolicy({ unstaffedGeneration: 'REFUSE' }),
        );
        const written = await request(http())
          .put('/api/v1/staffing-policy')
          .set('x-test-user', admin())
          .send({ fullTimeTeachingMinutesPerWeek: 1080, unstaffedGeneration: 'REFUSE' })
          .expect(200);
        expect(written.body).toMatchObject({ unstaffedGeneration: 'REFUSE' });
        const args = harness.tx['staffingPolicy']!['upsert']!.mock.calls[0]?.[0] as {
          update: Record<string, unknown>;
        };
        expect(args.update).toMatchObject({ unstaffedGeneration: 'REFUSE' });

        await request(http())
          .put('/api/v1/staffing-policy')
          .set('x-test-user', admin())
          .send({ unstaffedGeneration: 'WARN' })
          .expect(400);
        expect(harness.tx['staffingPolicy']!['upsert']).toHaveBeenCalledTimes(1);
      });

      it('400s a tolerance over 50 % and a reglerad arbetstid larger than the year, in Swedish', async () => {
        await request(http())
          .put('/api/v1/staffing-policy')
          .set('x-test-user', admin())
          .send({ overAllocationTolerancePercent: 51 })
          .expect(400);

        const response = await request(http())
          .put('/api/v1/staffing-policy')
          .set('x-test-user', admin())
          .send({ fullTimeRegulatedHoursPerYear: 1800, fullTimeAnnualHours: 1767 })
          .expect(400);
        expect(JSON.stringify(response.body)).toContain('1800 h');
        expect(harness.tx['staffingPolicy']!['upsert']).not.toHaveBeenCalled();
      });

      it('403s a teacher on both verbs', async () => {
        await request(http()).get('/api/v1/staffing-policy').set('x-test-user', teacher()).expect(403);
        await request(http())
          .put('/api/v1/staffing-policy')
          .set('x-test-user', teacher())
          .send({})
          .expect(403);
      });
    });

    describe('tjänster (teacher employments)', () => {
      it('an admin lists the year and writes a colleague’s post, locking the Users row', async () => {
        harness.tx['teacherEmployment']!['findMany']!.mockResolvedValue([
          storedEmployment(COLLEAGUE_ID),
          storedEmployment(TEACHER_ID, { signature: 'ME' }),
        ]);
        const list = await request(http())
          .get(`/api/v1/teacher-employments?academicYearId=${YEAR_ID}`)
          .set('x-test-user', admin())
          .expect(200);
        expect(list.body).toHaveLength(2);
        expect(list.body[0]).toMatchObject({ employmentPercent: 80, reductionPercent: 0 });
        expect(harness.tx['teacherEmployment']!['findMany']).toHaveBeenCalledWith({
          where: { academicYearId: YEAR_ID },
          orderBy: { userId: 'asc' },
        });

        const queryRaw = givenLockedRows(USERS, [{ id: COLLEAGUE_ID, role: 'TEACHER' }]);
        harness.tx['teacherEmployment']!['upsert']!.mockResolvedValue(
          storedEmployment(COLLEAGUE_ID, { reductionPercent: new Prisma.Decimal('20.000') }),
        );

        const response = await request(http())
          .put(`/api/v1/teacher-employments/${COLLEAGUE_ID}?academicYearId=${YEAR_ID}`)
          .set('x-test-user', admin())
          .send({ employmentPercent: 80, reductionPercent: 20, signature: 'KOL' })
          .expect(200);

        expect(response.body).toMatchObject({ userId: COLLEAGUE_ID, employmentPercent: 80, reductionPercent: 20 });
        expect(queryRaw).toHaveBeenCalledTimes(1);
        expect(harness.tx['teacherEmployment']!['upsert']).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              schoolId_userId_academicYearId: {
                schoolId: SCHOOL_ID,
                userId: COLLEAGUE_ID,
                academicYearId: YEAR_ID,
              },
            },
          }),
        );
      });

      it('a teacher reads their own post only — the service narrows, not RLS alone', async () => {
        harness.tx['teacherEmployment']!['findMany']!.mockResolvedValue([storedEmployment(TEACHER_ID)]);

        const response = await request(http())
          .get(`/api/v1/teacher-employments?academicYearId=${YEAR_ID}`)
          .set('x-test-user', teacher())
          .expect(200);

        expect(response.body).toHaveLength(1);
        expect(harness.tx['teacherEmployment']!['findMany']).toHaveBeenCalledWith({
          where: { academicYearId: YEAR_ID, userId: TEACHER_ID },
          orderBy: { userId: 'asc' },
        });
      });

      it('403s a teacher writing a colleague’s post — or their own — without touching the table', async () => {
        const queryRaw = givenLockedRows(USERS, [{ id: COLLEAGUE_ID, role: 'TEACHER' }]);

        for (const target of [COLLEAGUE_ID, TEACHER_ID]) {
          await request(http())
            .put(`/api/v1/teacher-employments/${target}?academicYearId=${YEAR_ID}`)
            .set('x-test-user', teacher())
            .send({ employmentPercent: 100 })
            .expect(403);
          await request(http())
            .delete(`/api/v1/teacher-employments/${target}?academicYearId=${YEAR_ID}`)
            .set('x-test-user', teacher())
            .expect(403);
        }

        expect(queryRaw).not.toHaveBeenCalled();
        expect(harness.tx['teacherEmployment']!['upsert']).not.toHaveBeenCalled();
        expect(harness.tx['teacherEmployment']!['delete']).not.toHaveBeenCalled();
      });

      it('400s a post over 100 %, and a nedsättning larger than the post, naming both', async () => {
        const queryRaw = givenLockedRows(USERS, [{ id: COLLEAGUE_ID, role: 'TEACHER' }]);

        const over = await request(http())
          .put(`/api/v1/teacher-employments/${COLLEAGUE_ID}?academicYearId=${YEAR_ID}`)
          .set('x-test-user', admin())
          .send({ employmentPercent: 100.5 })
          .expect(400);
        expect(JSON.stringify(over.body)).toContain('över 100 %');

        const reduction = await request(http())
          .put(`/api/v1/teacher-employments/${COLLEAGUE_ID}?academicYearId=${YEAR_ID}`)
          .set('x-test-user', admin())
          .send({ employmentPercent: 80, reductionPercent: 90 })
          .expect(400);
        expect(JSON.stringify(reduction.body)).toContain('90 %');

        expect(queryRaw).not.toHaveBeenCalled();
        expect(harness.tx['teacherEmployment']!['upsert']).not.toHaveBeenCalled();
      });

      it('400s a missing or malformed academicYearId before anything else', async () => {
        await request(http())
          .get('/api/v1/teacher-employments')
          .set('x-test-user', admin())
          .expect(400);
        await request(http())
          .put(`/api/v1/teacher-employments/${COLLEAGUE_ID}?academicYearId=2026`)
          .set('x-test-user', admin())
          .send({ employmentPercent: 80 })
          .expect(400);
      });

      it('404s a write against a user RLS hides', async () => {
        givenLockedRows(USERS, []);

        await request(http())
          .put(`/api/v1/teacher-employments/${COLLEAGUE_ID}?academicYearId=${YEAR_ID}`)
          .set('x-test-user', admin())
          .send({ employmentPercent: 80 })
          .expect(404);
        expect(harness.tx['teacherEmployment']!['upsert']).not.toHaveBeenCalled();
      });

      it('409s a signature another teacher holds this year, naming it', async () => {
        givenLockedRows(USERS, [{ id: COLLEAGUE_ID, role: 'TEACHER' }]);
        harness.tx['teacherEmployment']!['upsert']!.mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: Prisma.prismaVersion.client,
          }),
        );

        const response = await request(http())
          .put(`/api/v1/teacher-employments/${COLLEAGUE_ID}?academicYearId=${YEAR_ID}`)
          .set('x-test-user', admin())
          .send({ employmentPercent: 80, signature: 'ABC' })
          .expect(409);
        expect(response.body.detail).toContain('Signaturen "ABC"');
      });

      it('204s an admin’s delete, keyed on teacher and year', async () => {
        harness.tx['teacherEmployment']!['delete']!.mockResolvedValue(storedEmployment(COLLEAGUE_ID));

        await request(http())
          .delete(`/api/v1/teacher-employments/${COLLEAGUE_ID}?academicYearId=${YEAR_ID}`)
          .set('x-test-user', admin())
          .expect(204);

        expect(harness.tx['teacherEmployment']!['delete']).toHaveBeenCalledWith({
          where: {
            schoolId_userId_academicYearId: {
              schoolId: SCHOOL_ID,
              userId: COLLEAGUE_ID,
              academicYearId: YEAR_ID,
            },
          },
        });
      });
    });

    describe('behörigheter (teacher qualifications)', () => {
      it('a teacher reads the school’s list, a colleague’s rows included', async () => {
        harness.tx['teacherSubjectQualification']!['findMany']!.mockResolvedValue([
          storedQualification(COLLEAGUE_ID),
        ]);

        const response = await request(http())
          .get(`/api/v1/teacher-qualifications?userId=${COLLEAGUE_ID}`)
          .set('x-test-user', teacher())
          .expect(200);

        expect(response.body).toEqual([
          expect.objectContaining({ userId: COLLEAGUE_ID, kind: 'LEGITIMATION', validTo: '2030-06-30' }),
        ]);
      });

      it('an admin replaces a teacher’s list wholesale', async () => {
        givenLockedRows(USERS, [{ id: COLLEAGUE_ID, role: 'TEACHER' }]);
        harness.tx['subject']!['findMany']!.mockResolvedValue([{ id: SUBJECT_ID }]);
        harness.tx['teacherSubjectQualification']!['findMany']!.mockResolvedValue([
          storedQualification(COLLEAGUE_ID),
        ]);

        const response = await request(http())
          .put(`/api/v1/teacher-qualifications/${COLLEAGUE_ID}`)
          .set('x-test-user', admin())
          .send({
            items: [
              { subjectId: SUBJECT_ID, minGradeLevel: 7, maxGradeLevel: 9, kind: 'LEGITIMATION', validTo: '2030-06-30' },
            ],
          })
          .expect(200);

        expect(response.body).toHaveLength(1);
        expect(harness.tx['teacherSubjectQualification']!['deleteMany']).toHaveBeenCalledWith({
          where: { userId: COLLEAGUE_ID },
        });
        expect(harness.tx['teacherSubjectQualification']!['createMany']).toHaveBeenCalledWith({
          data: [
            expect.objectContaining({
              schoolId: SCHOOL_ID,
              userId: COLLEAGUE_ID,
              subjectId: SUBJECT_ID,
              kind: 'LEGITIMATION',
              validTo: new Date('2030-06-30T00:00:00.000Z'),
            }),
          ],
        });
      });

      it('403s a teacher writing any list, their own included', async () => {
        await request(http())
          .put(`/api/v1/teacher-qualifications/${TEACHER_ID}`)
          .set('x-test-user', teacher())
          .send({ items: [] })
          .expect(403);
        expect(harness.tx['teacherSubjectQualification']!['deleteMany']).not.toHaveBeenCalled();
      });

      it('400s a reversed grade span and a subject outside the school, naming them', async () => {
        const reversed = await request(http())
          .put(`/api/v1/teacher-qualifications/${COLLEAGUE_ID}`)
          .set('x-test-user', admin())
          .send({ items: [{ subjectId: SUBJECT_ID, minGradeLevel: 9, maxGradeLevel: 7, kind: 'BEHORIG' }] })
          .expect(400);
        expect(JSON.stringify(reversed.body)).toContain('7–9, inte 9–7');

        givenLockedRows(USERS, [{ id: COLLEAGUE_ID, role: 'TEACHER' }]);
        harness.tx['subject']!['findMany']!.mockResolvedValue([]);
        const foreign = await request(http())
          .put(`/api/v1/teacher-qualifications/${COLLEAGUE_ID}`)
          .set('x-test-user', admin())
          .send({ items: [{ subjectId: SUBJECT_ID, minGradeLevel: 7, maxGradeLevel: 9, kind: 'BEHORIG' }] })
          .expect(400);
        expect(JSON.stringify(foreign.body)).toContain(SUBJECT_ID);
        expect(harness.tx['teacherSubjectQualification']!['deleteMany']).not.toHaveBeenCalled();
      });

      it('404s a write against a user RLS hides', async () => {
        givenLockedRows(USERS, []);
        await request(http())
          .put(`/api/v1/teacher-qualifications/${COLLEAGUE_ID}`)
          .set('x-test-user', admin())
          .send({ items: [] })
          .expect(404);
      });
    });

    describe('belastning (staffing load)', () => {
      const yearRow = () => ({
        startDate: new Date('2026-08-17T00:00:00.000Z'),
        endDate: new Date('2027-06-11T00:00:00.000Z'),
      });
      const requirementRow = (overrides: Record<string, unknown> = {}) => ({
        id: '50505050-5050-4050-8050-505050505050',
        subjectId: SUBJECT_ID,
        studentGroupId: GROUP_ID,
        teacherId: COLLEAGUE_ID,
        coTeacherId: null,
        lessonsPerWeek: 10,
        minutesPerLesson: 60,
        teacherLoadPercent: 100,
        coTeacherLoadPercent: 100,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        subject: { name: 'Matematik' },
        studentGroup: { name: '7A', gradeLevel: 7 },
        ...overrides,
      });

      beforeEach(() => {
        // clearAllMocks keeps implementations, so the behörighet list and the
        // roster reads an earlier test stubbed would reach the report here.
        harness.tx['teacherSubjectQualification']!['findMany']!.mockResolvedValue([]);
        harness.tx['schoolBreak']!['findMany']!.mockResolvedValue([]);
        harness.tx['user']!['findMany']!.mockResolvedValue([]);
        harness.tx['studentGroupMember']!['findMany']!.mockResolvedValue([]);
        harness.tx['academicYear']!['findUnique']!.mockResolvedValue(yearRow());
        harness.tx['staffingPolicy']!['findUnique']!.mockResolvedValue(storedPolicy());
        harness.tx['teacherEmployment']!['findMany']!.mockResolvedValue([
          storedEmployment(COLLEAGUE_ID),
          storedEmployment(TEACHER_ID, { signature: 'ME', employmentPercent: new Prisma.Decimal('100.000') }),
        ]);
        harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([
          requirementRow(),
          requirementRow({ id: '60606060-6060-4060-8060-606060606060', teacherId: TEACHER_ID, lessonsPerWeek: 2 }),
          requirementRow({ id: '70707070-7070-4070-8070-707070707070', teacherId: null, lessonsPerWeek: 3 }),
        ]);
      });

      it('an admin reads the whole school’s report', async () => {
        const response = await request(http())
          .get(`/api/v1/staffing/load?academicYearId=${YEAR_ID}&horizon=planned`)
          .set('x-test-user', admin())
          .expect(200);

        expect(response.body).toMatchObject({
          academicYearId: YEAR_ID,
          horizon: 'planned',
          year: { startDate: '2026-08-17', endDate: '2027-06-11' },
          qualificationsRecorded: false,
          totals: { teacherMinutesPerWeek: 720, lessonMinutesPerWeek: 900 },
        });
        expect(response.body.teachers).toHaveLength(2);
        expect(response.body.teachers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              userId: COLLEAGUE_ID,
              targetMinutesPerWeek: 865,
              assignedMinutesPerWeek: 600,
              status: 'UNDER',
              subjects: [expect.objectContaining({ subjectName: 'Matematik', percentOfEmployment: 80 })],
            }),
          ]),
        );
        expect(response.body.unstaffedRequirements).toEqual([
          expect.objectContaining({ groupName: '7A', minutesPerWeek: 180, gradeSpan: { min: 7, max: 7 } }),
        ]);
      });

      it('a teacher reads their own row and none of the admin’s lists', async () => {
        const response = await request(http())
          .get(`/api/v1/staffing/load?academicYearId=${YEAR_ID}`)
          .set('x-test-user', teacher())
          .expect(200);

        expect(response.body.teachers).toEqual([
          expect.objectContaining({ userId: TEACHER_ID, assignedMinutesPerWeek: 120 }),
        ]);
        expect(response.body.unstaffedRequirements).toEqual([]);
      });

      it('400s a horizon that does not exist yet, and a missing year', async () => {
        const response = await request(http())
          .get(`/api/v1/staffing/load?academicYearId=${YEAR_ID}&horizon=scheduled`)
          .set('x-test-user', admin())
          .expect(400);
        expect(response.body.detail).toContain('"scheduled"');
        await request(http()).get('/api/v1/staffing/load').set('x-test-user', admin()).expect(400);
      });

      it('404s a year RLS hides', async () => {
        harness.tx['academicYear']!['findUnique']!.mockResolvedValue(null);
        await request(http())
          .get(`/api/v1/staffing/load?academicYearId=${YEAR_ID}`)
          .set('x-test-user', admin())
          .expect(404);
      });

      it('ranks the staff for one row for an admin; 403 for a teacher, 400 without an id, 404 for a hidden row', async () => {
        harness.tx['teachingRequirement']!['findUnique']!.mockResolvedValue({ academicYearId: YEAR_ID });
        harness.tx['user']!['findMany']!.mockResolvedValue([{ id: COLLEAGUE_ID }, { id: TEACHER_ID }]);
        const response = await request(http())
          .get(`/api/v1/staffing/suggest-teachers?requirementId=70707070-7070-4070-8070-707070707070`)
          .set('x-test-user', admin())
          .expect(200);
        expect(response.body).toMatchObject({
          requirementId: '70707070-7070-4070-8070-707070707070',
          teacherMinutesPerWeek: 180,
          qualificationsRecorded: false,
        });
        // Both teach 7A Ma already; the colleague has 865 − 600 − 180 = 85
        // left, the teacher 1080 − 120 − 180 = 780, so the teacher first.
        expect(response.body.candidates).toEqual([
          expect.objectContaining({ userId: TEACHER_ID, remainingMinutesPerWeek: 780, wouldExceed: false }),
          expect.objectContaining({ userId: COLLEAGUE_ID, remainingMinutesPerWeek: 85, teachesGroupAlready: true }),
        ]);

        await request(http())
          .get(`/api/v1/staffing/suggest-teachers?requirementId=70707070-7070-4070-8070-707070707070`)
          .set('x-test-user', teacher())
          .expect(403);
        await request(http())
          .get('/api/v1/staffing/suggest-teachers')
          .set('x-test-user', admin())
          .expect(400);
        harness.tx['teachingRequirement']!['findUnique']!.mockResolvedValue(null);
        await request(http())
          .get(`/api/v1/staffing/suggest-teachers?requirementId=70707070-7070-4070-8070-707070707070`)
          .set('x-test-user', admin())
          .expect(404);
      });

      it('lists the unstaffed rows for an admin, and 403s a teacher', async () => {
        const response = await request(http())
          .get(`/api/v1/staffing/unstaffed?academicYearId=${YEAR_ID}`)
          .set('x-test-user', admin())
          .expect(200);
        expect(response.body).toEqual([
          expect.objectContaining({ subjectName: 'Matematik', groupName: '7A', minutesPerWeek: 180 }),
        ]);

        await request(http())
          .get(`/api/v1/staffing/unstaffed?academicYearId=${YEAR_ID}`)
          .set('x-test-user', teacher())
          .expect(403);
      });
    });

    describe('uppdrag (teacher duties)', () => {
      const DUTY_ID = '80808080-8080-4080-8080-808080808080';
      const CONSTRAINT_ID = '90909090-9090-4090-8090-909090909090';
      const DUTIES: LockedTable = {
        name: 'TeacherDuties',
        columns: ['id', 'schoolId', 'userId', 'academicYearId', 'label', 'blockedConstraintId'],
        lock: 'FOR NO KEY UPDATE',
      };
      const storedDuty = (overrides: Record<string, unknown> = {}) => ({
        id: DUTY_ID,
        schoolId: SCHOOL_ID,
        userId: COLLEAGUE_ID,
        academicYearId: YEAR_ID,
        kind: 'RASTVAKT',
        label: 'Rastvakt tisdag',
        minutesPerWeek: 20,
        countsAsTeaching: false,
        subjectId: null,
        studentGroupId: null,
        blockedConstraintId: CONSTRAINT_ID,
        note: null,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
        blockedConstraint: { dayOfWeek: 2, startTime: wallClock('10:00'), endTime: wallClock('10:20') },
        ...overrides,
      });
      const body = {
        userId: COLLEAGUE_ID,
        academicYearId: YEAR_ID,
        kind: 'RASTVAKT',
        label: 'Rastvakt tisdag',
        minutesPerWeek: 20,
        blockedSlot: { dayOfWeek: 2, startTime: '10:00', endTime: '10:20' },
      };

      it('an admin lists, creates with a slot, patches and deletes — every handler reached', async () => {
        harness.tx['teacherDuty']!['findMany']!.mockResolvedValue([storedDuty()]);
        const list = await request(http())
          .get(`/api/v1/teacher-duties?academicYearId=${YEAR_ID}&userId=${COLLEAGUE_ID}`)
          .set('x-test-user', admin())
          .expect(200);
        expect(list.body).toEqual([
          expect.objectContaining({
            id: DUTY_ID,
            blockedSlot: { dayOfWeek: 2, startTime: '10:00', endTime: '10:20' },
          }),
        ]);
        expect(harness.tx['teacherDuty']!['findMany']).toHaveBeenCalledWith(
          expect.objectContaining({ where: { academicYearId: YEAR_ID, userId: COLLEAGUE_ID } }),
        );

        givenLockedRows(USERS, [{ id: COLLEAGUE_ID, role: 'TEACHER' }]);
        harness.tx['availabilityConstraint']!['create']!.mockResolvedValue({ id: CONSTRAINT_ID });
        harness.tx['teacherDuty']!['create']!.mockResolvedValue(storedDuty());
        const created = await request(http())
          .post('/api/v1/teacher-duties')
          .set('x-test-user', admin())
          .send(body)
          .expect(201);
        expect(created.body).toMatchObject({ id: DUTY_ID, blockedConstraintId: CONSTRAINT_ID });
        expect(harness.tx['availabilityConstraint']!['create']).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ resourceType: 'TEACHER', type: 'UNAVAILABLE', userId: COLLEAGUE_ID, dayOfWeek: 2 }),
          }),
        );

        givenLockedRows(DUTIES, [storedDuty()]);
        harness.tx['teacherDuty']!['update']!.mockResolvedValue(storedDuty({ minutesPerWeek: 30 }));
        const patched = await request(http())
          .patch(`/api/v1/teacher-duties/${DUTY_ID}`)
          .set('x-test-user', admin())
          .send({ minutesPerWeek: 30, countsAsTeaching: true })
          .expect(200);
        expect(patched.body).toMatchObject({ minutesPerWeek: 30 });

        await request(http())
          .delete(`/api/v1/teacher-duties/${DUTY_ID}`)
          .set('x-test-user', admin())
          .expect(204);
        expect(harness.tx['teacherDuty']!['delete']).toHaveBeenCalledWith({ where: { id: DUTY_ID } });
        expect(harness.tx['availabilityConstraint']!['deleteMany']).toHaveBeenCalledWith({
          where: { id: CONSTRAINT_ID },
        });
      });

      it('a teacher reads their own uppdrag, 403s on a colleague’s, and writes nothing', async () => {
        harness.tx['teacherDuty']!['findMany']!.mockResolvedValue([storedDuty({ userId: TEACHER_ID })]);
        await request(http())
          .get(`/api/v1/teacher-duties?academicYearId=${YEAR_ID}`)
          .set('x-test-user', teacher())
          .expect(200);
        expect(harness.tx['teacherDuty']!['findMany']).toHaveBeenCalledWith(
          expect.objectContaining({ where: { academicYearId: YEAR_ID, userId: TEACHER_ID } }),
        );

        await request(http())
          .get(`/api/v1/teacher-duties?academicYearId=${YEAR_ID}&userId=${COLLEAGUE_ID}`)
          .set('x-test-user', teacher())
          .expect(403);

        await request(http()).post('/api/v1/teacher-duties').set('x-test-user', teacher()).send(body).expect(403);
        await request(http())
          .patch(`/api/v1/teacher-duties/${DUTY_ID}`)
          .set('x-test-user', teacher())
          .send({ minutesPerWeek: 30 })
          .expect(403);
        await request(http())
          .delete(`/api/v1/teacher-duties/${DUTY_ID}`)
          .set('x-test-user', teacher())
          .expect(403);
        expect(harness.tx['teacherDuty']!['create']).not.toHaveBeenCalled();
        expect(harness.tx['teacherDuty']!['update']).not.toHaveBeenCalled();
        expect(harness.tx['teacherDuty']!['delete']).not.toHaveBeenCalled();
      });

      it('400s what the table would refuse, a slot off the grid and a constraint id in the body', async () => {
        const tooMuch = await request(http())
          .post('/api/v1/teacher-duties')
          .set('x-test-user', admin())
          .send({ ...body, minutesPerWeek: 2401 })
          .expect(400);
        expect(JSON.stringify(tooMuch.body)).toContain('minutesPerWeek: högst 2400 minuter');

        const offGrid = await request(http())
          .post('/api/v1/teacher-duties')
          .set('x-test-user', admin())
          .send({ ...body, blockedSlot: { dayOfWeek: 2, startTime: '10:00', endTime: '10:22' } })
          .expect(400);
        expect(offGrid.body.detail).toContain('blockedSlot.endTime');

        await request(http())
          .patch(`/api/v1/teacher-duties/${DUTY_ID}`)
          .set('x-test-user', admin())
          .send({ blockedConstraintId: CONSTRAINT_ID })
          .expect(400);
        await request(http())
          .get('/api/v1/teacher-duties?academicYearId=2026')
          .set('x-test-user', admin())
          .expect(400);
        expect(harness.tx['teacherDuty']!['create']).not.toHaveBeenCalled();
      });

      it('404s a duty RLS hides, and 409s a slot the database refuses to link', async () => {
        givenLockedRows(DUTIES, []);
        await request(http())
          .patch(`/api/v1/teacher-duties/${DUTY_ID}`)
          .set('x-test-user', admin())
          .send({ minutesPerWeek: 30 })
          .expect(404);
        await request(http())
          .delete(`/api/v1/teacher-duties/${DUTY_ID}`)
          .set('x-test-user', admin())
          .expect(404);

        givenLockedRows(USERS, [{ id: COLLEAGUE_ID, role: 'TEACHER' }]);
        harness.tx['availabilityConstraint']!['create']!.mockResolvedValue({ id: CONSTRAINT_ID });
        harness.tx['teacherDuty']!['create']!.mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('TEACHER_DUTY_BLOCK_MISMATCH: x', {
            code: 'P2010',
            clientVersion: Prisma.prismaVersion.client,
            meta: {
              driverAdapterError: {
                cause: {
                  originalCode: 'TD409',
                  originalMessage: 'TEACHER_DUTY_BLOCK_MISMATCH: x',
                  detail: `teacherDutyId=${DUTY_ID} availabilityConstraintId=${CONSTRAINT_ID}`,
                  kind: 'postgres',
                },
              },
            },
          }),
        );
        const refused = await request(http())
          .post('/api/v1/teacher-duties')
          .set('x-test-user', admin())
          .send(body)
          .expect(409);
        expect(refused.body.code).toBe('TEACHER_DUTY_BLOCK_MISMATCH');
        harness.tx['teacherDuty']!['create']!.mockReset();
      });

      it('400s an uppdrag for a pupil, naming why', async () => {
        givenLockedRows(USERS, [{ id: COLLEAGUE_ID, role: 'STUDENT' }]);
        const response = await request(http())
          .post('/api/v1/teacher-duties')
          .set('x-test-user', admin())
          .send(body)
          .expect(400);
        expect(response.body.detail).toBe('Ett uppdrag hör till en lärare. Elever och vårdnadshavare undervisar inte.');
      });
    });
  });

  describe('lokala timplaner', () => {
    /*
     * A school's own timplan and the decision that fixes it. TEACHER reads the
     * three GETs; every write is the admin's and stops at the guard for anyone
     * else — so each verb has an admin round trip that reaches its handler,
     * and the decided-state rules (409 TIMPLAN_IS_DECIDED) are asserted over
     * HTTP with the problem code a client acts on.
     */
    const PLAN_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
    const COPY_ID = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';
    const VERSION_ID = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
    const ADMIN_USER_ID = '22222222-2222-4222-8222-222222222222';
    const teacher = () => asUser({ role: 'TEACHER' as never });
    const student = () => asUser({ role: 'STUDENT' as never });

    const MODELS = ['localTimplan', 'localTimplanEntry', 'nationalTimplanVersion', 'nationalSubject', 'subject'];
    /**
     * clearAllMocks keeps implementations, and a plan stubbed here must not
     * answer a subjects test further down. Reset to the harness's defaults —
     * every findMany an empty table — before and after each case.
     */
    const resetModels = () => {
      for (const model of MODELS) {
        for (const method of Object.values(harness.tx[model]!)) method.mockReset();
        harness.tx[model]!['findMany']!.mockResolvedValue([]);
      }
    };
    beforeEach(resetModels);
    afterEach(resetModels);

    const storedPlan = (overrides: Record<string, unknown> = {}) => ({
      id: PLAN_ID,
      schoolId: SCHOOL_ID,
      name: 'Grundskolan 2024',
      schoolForm: 'GRUNDSKOLA',
      nationalTimplanVersionId: VERSION_ID,
      planningWeeks: new Prisma.Decimal('35.6'),
      status: 'DRAFT',
      decidedAt: null,
      decidedByUserId: null,
      decisionNote: null,
      copiedFromId: null,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      ...overrides,
    });
    const decidedPlan = () =>
      storedPlan({
        status: 'DECIDED',
        decidedAt: new Date('2026-05-12T10:00:00.000Z'),
        decidedByUserId: ADMIN_USER_ID,
        decisionNote: 'Beslutat av huvudman 2026-05-12',
      });
    const maEntry = (gradeLevel: number, minutesPerWeek: number) => ({
      id: `e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e${gradeLevel}`,
      subjectId: SUBJECT_ID,
      gradeLevel,
      minutesPerWeek,
      note: null,
    });

    /** Bilaga 1's matematik cells and the pool, as the check reads them. */
    const givenTheStatute = () => {
      harness.tx['nationalTimplanVersion']!['findUnique']!.mockImplementation(
        (args: { select?: { entries?: unknown } }) =>
          Promise.resolve(
            args.select?.entries
              ? {
                  code: 'SFS2023:945/B1',
                  schoolForm: 'GRUNDSKOLA',
                  totalHours: 6890,
                  skolansValHours: 600,
                  reductionCapPercent: 20,
                  appliesFromCohortTerm: 'HT2024',
                  entries: [
                    { subjectCode: 'MA', stage: 'LAG', hours: 420, minimumHoursPerChild: null, protectedFromReduction: true },
                  ],
                }
              : { code: 'SFS2023:945/B1', schoolForm: 'GRUNDSKOLA' },
          ),
      );
      harness.tx['nationalSubject']!['findMany']!.mockResolvedValue([
        { code: 'MA', name: 'Matematik', parentCode: null },
      ]);
    };

    /** The decided-plan trigger's refusal, as @prisma/adapter-pg delivers it. */
    const triggerRefusal = () => {
      const message = 'TIMPLAN_IS_DECIDED: lokal timplan "Grundskolan 2024" är beslutad och dess poster kan inte ändras';
      return new Prisma.PrismaClientKnownRequestError(`Database error. Code: \`TP409\`. Message: \`${message}\``, {
        code: 'P2039',
        clientVersion: Prisma.prismaVersion.client,
        meta: {
          driverAdapterError: {
            cause: { originalCode: 'TP409', originalMessage: message, detail: `localTimplanId=${PLAN_ID}` },
          },
        },
      });
    };

    it('an admin creates a plan, and reads planningWeeks back as a number', async () => {
      givenTheStatute();
      harness.tx['localTimplan']!['create']!.mockResolvedValue(storedPlan());

      const response = await request(http())
        .post('/api/v1/local-timplans')
        .set('x-test-user', admin())
        .send({ name: 'Grundskolan 2024', schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: VERSION_ID })
        .expect(201);

      expect(response.body).toMatchObject({ id: PLAN_ID, planningWeeks: 35.6, status: 'DRAFT', entries: [] });
      expect(harness.tx['localTimplan']!['create']).toHaveBeenCalledWith({
        data: expect.objectContaining({ schoolId: SCHOOL_ID, planningWeeks: '35.6' }),
      });
    });

    it('an admin lists, reads, renames and deletes a plan', async () => {
      harness.tx['localTimplan']!['findMany']!.mockResolvedValueOnce([
        { ...storedPlan(), _count: { entries: 3 } },
      ]);
      const list = await request(http()).get('/api/v1/local-timplans').set('x-test-user', admin()).expect(200);
      expect(list.body).toEqual([expect.objectContaining({ id: PLAN_ID, entryCount: 3, planningWeeks: 35.6 })]);

      harness.tx['localTimplan']!['findUnique']!.mockResolvedValueOnce({ ...storedPlan(), entries: [maEntry(4, 180)] });
      const one = await request(http()).get(`/api/v1/local-timplans/${PLAN_ID}`).set('x-test-user', admin()).expect(200);
      expect(one.body.entries).toEqual([expect.objectContaining({ gradeLevel: 4, minutesPerWeek: 180 })]);

      harness.tx['localTimplan']!['findUnique']!.mockResolvedValueOnce(storedPlan());
      harness.tx['localTimplan']!['update']!.mockResolvedValueOnce(storedPlan({ name: 'Grundskolan 2025' }));
      await request(http())
        .patch(`/api/v1/local-timplans/${PLAN_ID}`)
        .set('x-test-user', admin())
        .send({ name: 'Grundskolan 2025', planningWeeks: 36 })
        .expect(200);
      expect(harness.tx['localTimplan']!['update']).toHaveBeenCalledWith({
        where: { id: PLAN_ID },
        data: { name: 'Grundskolan 2025', planningWeeks: '36.0' },
      });

      harness.tx['localTimplan']!['delete']!.mockResolvedValueOnce(decidedPlan());
      const gone = await request(http())
        .delete(`/api/v1/local-timplans/${PLAN_ID}`)
        .set('x-test-user', admin())
        .expect(204);
      expect(gone.body).toEqual({});
    });

    it('an admin replaces the entries and gets the verdicts back in the same answer', async () => {
      givenTheStatute();
      harness.tx['localTimplan']!['findUnique']!
        .mockResolvedValueOnce(storedPlan())
        .mockResolvedValueOnce({ ...storedPlan(), entries: [maEntry(1, 236), maEntry(2, 236), maEntry(3, 235)] });
      harness.tx['subject']!['findMany']!
        .mockResolvedValueOnce([{ id: SUBJECT_ID }])
        .mockResolvedValueOnce([{ id: SUBJECT_ID, name: 'Matematik', nationalCode: 'MA', countsTowardTimplan: true }]);

      const response = await request(http())
        .put(`/api/v1/local-timplans/${PLAN_ID}/entries`)
        .set('x-test-user', admin())
        .send({
          entries: [
            { subjectId: SUBJECT_ID, gradeLevel: 1, minutesPerWeek: 236 },
            { subjectId: SUBJECT_ID, gradeLevel: 2, minutesPerWeek: 236 },
            { subjectId: SUBJECT_ID, gradeLevel: 3, minutesPerWeek: 235, note: 'skolans val' },
          ],
        })
        .expect(200);

      expect(response.body.plan.entries).toHaveLength(3);
      expect(response.body.check.verdicts[0]).toMatchObject({
        code: 'TIMPLAN_PROTECTED_SUBJECT_REDUCED',
        severity: 'warning',
        message: 'Matematik i lågstadiet: 419,4 h planerat, 0,6 h under målet 420 h. Ämnet får inte minskas för skolans val.',
      });
      expect(harness.tx['localTimplanEntry']!['createMany']).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({ schoolId: SCHOOL_ID, localTimplanId: PLAN_ID, gradeLevel: 3, note: 'skolans val' }),
        ]),
      });
    });

    it('an admin decides a draft, stamped with their own id', async () => {
      harness.tx['localTimplan']!['findUnique']!
        .mockResolvedValueOnce(storedPlan())
        .mockResolvedValueOnce(decidedPlan());
      harness.tx['localTimplan']!['updateMany']!.mockResolvedValueOnce({ count: 1 });

      const response = await request(http())
        .post(`/api/v1/local-timplans/${PLAN_ID}/decide`)
        .set('x-test-user', admin())
        .send({ decisionNote: 'Beslutat av huvudman 2026-05-12' })
        .expect(200);

      expect(response.body).toMatchObject({ status: 'DECIDED', decidedByUserId: ADMIN_USER_ID });
      expect(harness.tx['localTimplan']!['updateMany']).toHaveBeenCalledWith({
        where: { id: PLAN_ID, status: 'DRAFT' },
        data: expect.objectContaining({ decidedByUserId: ADMIN_USER_ID, status: 'DECIDED' }),
      });
    });

    it('an admin reopens a decided plan, and copies one, each into a new draft (201)', async () => {
      for (const action of ['reopen', 'copy']) {
        harness.tx['localTimplan']!['findUnique']!
          .mockResolvedValueOnce({ ...decidedPlan(), entries: [maEntry(4, 180)] })
          .mockResolvedValueOnce({ ...storedPlan({ id: COPY_ID, copiedFromId: PLAN_ID }), entries: [maEntry(4, 180)] });
        harness.tx['localTimplan']!['create']!.mockResolvedValueOnce(storedPlan({ id: COPY_ID }));

        const response = await request(http())
          .post(`/api/v1/local-timplans/${PLAN_ID}/${action}`)
          .set('x-test-user', admin())
          .send({})
          .expect(201);

        expect(response.body).toMatchObject({ id: COPY_ID, copiedFromId: PLAN_ID, status: 'DRAFT' });
      }
      expect(harness.tx['localTimplan']!['create']!.mock.calls.map((call) => call[0].data.name)).toEqual([
        'Grundskolan 2024 (utkast)',
        'Grundskolan 2024 (kopia)',
      ]);
      expect(harness.tx['localTimplanEntry']!['createMany']).toHaveBeenCalledTimes(2);
    });

    it('a teacher reads the list, a plan and its check — and a pupil reads none of them here', async () => {
      givenTheStatute();
      await request(http()).get('/api/v1/local-timplans').set('x-test-user', teacher()).expect(200);

      harness.tx['localTimplan']!['findUnique']!.mockResolvedValueOnce({ ...storedPlan(), entries: [] });
      await request(http()).get(`/api/v1/local-timplans/${PLAN_ID}`).set('x-test-user', teacher()).expect(200);

      harness.tx['localTimplan']!['findUnique']!.mockResolvedValueOnce({ ...storedPlan(), entries: [] });
      const check = await request(http())
        .get(`/api/v1/local-timplans/${PLAN_ID}/check`)
        .set('x-test-user', teacher())
        .expect(200);
      expect(check.body).toMatchObject({ localTimplanId: PLAN_ID, total: { guaranteedHours: 6890 } });
      // An empty plan is under mål everywhere; it is still a 200 with warnings, not a refusal.
      expect(check.body.verdicts.map((v: { code: string }) => v.code)).toEqual([
        'TIMPLAN_PROTECTED_SUBJECT_REDUCED',
        'TIMPLAN_TOTAL_BELOW_GUARANTEE',
      ]);

      for (const role of [student(), asUser({ role: 'GUARDIAN' as never })]) {
        await request(http()).get('/api/v1/local-timplans').set('x-test-user', role).expect(403);
      }
    });

    it('403s every write for a teacher, before any table is touched', async () => {
      const writes: [string, string, object][] = [
        ['post', '/api/v1/local-timplans', { name: 'X', schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: VERSION_ID }],
        ['patch', `/api/v1/local-timplans/${PLAN_ID}`, { name: 'X' }],
        ['delete', `/api/v1/local-timplans/${PLAN_ID}`, {}],
        ['put', `/api/v1/local-timplans/${PLAN_ID}/entries`, { entries: [] }],
        ['post', `/api/v1/local-timplans/${PLAN_ID}/decide`, { decisionNote: 'x' }],
        ['post', `/api/v1/local-timplans/${PLAN_ID}/reopen`, {}],
        ['post', `/api/v1/local-timplans/${PLAN_ID}/copy`, {}],
      ];
      for (const [verb, path, body] of writes) {
        const agent = request(http()) as unknown as Record<string, (p: string) => request.Test>;
        await agent[verb]!(path).set('x-test-user', teacher()).send(body).expect(403);
      }
      for (const method of ['findUnique', 'create', 'update', 'updateMany', 'delete']) {
        expect(harness.tx['localTimplan']![method]).not.toHaveBeenCalled();
      }
    });

    it('400s a body the table would refuse, naming the field, before the database', async () => {
      const weeks = await request(http())
        .post('/api/v1/local-timplans')
        .set('x-test-user', admin())
        .send({ name: 'X', schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: VERSION_ID, planningWeeks: 41 })
        .expect(400);
      expect(JSON.stringify(weeks.body)).toContain('planningWeeks: högst 40,0 veckor.');

      await request(http())
        .post('/api/v1/local-timplans')
        .set('x-test-user', admin())
        .send({ name: '   ', schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: VERSION_ID })
        .expect(400);

      const grade = await request(http())
        .put(`/api/v1/local-timplans/${PLAN_ID}/entries`)
        .set('x-test-user', admin())
        .send({ entries: [{ subjectId: SUBJECT_ID, gradeLevel: 11, minutesPerWeek: 60 }] })
        .expect(400);
      expect(JSON.stringify(grade.body)).toContain('gradeLevel: högsta årskurs är 10.');

      await request(http())
        .post(`/api/v1/local-timplans/${PLAN_ID}/decide`)
        .set('x-test-user', admin())
        .send({ decisionNote: '  ' })
        .expect(400);

      await request(http())
        .patch(`/api/v1/local-timplans/${PLAN_ID}`)
        .set('x-test-user', admin())
        .send({ schoolForm: 'SAMESKOLA' })
        .expect(400);

      await request(http()).get('/api/v1/local-timplans/not-a-uuid').set('x-test-user', admin()).expect(400);

      // A list of lists: ValidateNested used to descend into it, the pipe let
      // it through, and the service read cells without a subject (a 500).
      const nested = await request(http())
        .put(`/api/v1/local-timplans/${PLAN_ID}/entries`)
        .set('x-test-user', admin())
        .send({ entries: [[{ subjectId: SUBJECT_ID, gradeLevel: 1, minutesPerWeek: 60 }]] })
        .expect(400);
      expect(JSON.stringify(nested.body)).toContain('entries: varje post anges som ett objekt.');

      // 100 × "a" + U+FE0F is 200 code points: within MaxLength's count, past
      // the CHECK's char_length, so it reached the database as a 500.
      const selected = await request(http())
        .post('/api/v1/local-timplans')
        .set('x-test-user', admin())
        .send({ name: 'a\uFE0F'.repeat(100), schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: VERSION_ID })
        .expect(400);
      expect(JSON.stringify(selected.body)).toContain('name: namnet kan vara högst 100 tecken.');

      expect(harness.tx['localTimplan']!['findUnique']).not.toHaveBeenCalled();
      expect(harness.tx['localTimplan']!['create']).not.toHaveBeenCalled();
    });

    it('reads a subject id written in capitals as the same subject', async () => {
      const lower = 'abcdef12-3456-4789-8abc-def012345678';
      givenTheStatute();
      harness.tx['localTimplan']!['findUnique']!
        .mockResolvedValueOnce(storedPlan())
        .mockResolvedValueOnce({ ...storedPlan(), entries: [{ ...maEntry(1, 236), subjectId: lower }] });
      harness.tx['subject']!['findMany']!
        .mockResolvedValueOnce([{ id: lower }])
        .mockResolvedValueOnce([{ id: lower, name: 'Matematik', nationalCode: 'MA', countsTowardTimplan: true }]);

      await request(http())
        .put(`/api/v1/local-timplans/${PLAN_ID}/entries`)
        .set('x-test-user', admin())
        .send({ entries: [{ subjectId: lower.toUpperCase(), gradeLevel: 1, minutesPerWeek: 236 }] })
        .expect(200);

      expect(harness.tx['subject']!['findMany']).toHaveBeenNthCalledWith(1, {
        where: { id: { in: [lower] } },
        select: { id: true },
      });
      expect(harness.tx['localTimplanEntry']!['createMany']).toHaveBeenCalledWith({
        data: [expect.objectContaining({ subjectId: lower })],
      });
    });

    it('400s a version of another school form, naming both forms', async () => {
      harness.tx['nationalTimplanVersion']!['findUnique']!.mockResolvedValueOnce({
        code: 'SFS2023:945/B4',
        schoolForm: 'SAMESKOLA',
      });

      const response = await request(http())
        .post('/api/v1/local-timplans')
        .set('x-test-user', admin())
        .send({ name: 'X', schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: VERSION_ID })
        .expect(400);
      expect(response.body.detail).toContain('SFS2023:945/B4 är timplanen för sameskolan');
    });

    it('404s a plan RLS hides, on a read, an entries write and a delete', async () => {
      harness.tx['localTimplan']!['findUnique']!.mockResolvedValue(null);
      await request(http()).get(`/api/v1/local-timplans/${PLAN_ID}`).set('x-test-user', admin()).expect(404);
      await request(http())
        .put(`/api/v1/local-timplans/${PLAN_ID}/entries`)
        .set('x-test-user', admin())
        .send({ entries: [] })
        .expect(404);

      harness.tx['localTimplan']!['delete']!.mockRejectedValueOnce(notFound());
      await request(http()).delete(`/api/v1/local-timplans/${PLAN_ID}`).set('x-test-user', admin()).expect(404);
      expect(harness.tx['localTimplanEntry']!['deleteMany']).not.toHaveBeenCalled();
    });

    it('409s TIMPLAN_IS_DECIDED for a rename, an entries write and a second decide of a decided plan', async () => {
      const calls: [string, string, object][] = [
        ['patch', `/api/v1/local-timplans/${PLAN_ID}`, { name: 'X' }],
        ['put', `/api/v1/local-timplans/${PLAN_ID}/entries`, { entries: [] }],
        ['post', `/api/v1/local-timplans/${PLAN_ID}/decide`, { decisionNote: 'igen' }],
      ];
      for (const [verb, path, body] of calls) {
        harness.tx['localTimplan']!['findUnique']!.mockResolvedValueOnce(decidedPlan());
        const agent = request(http()) as unknown as Record<string, (p: string) => request.Test>;
        const response = await agent[verb]!(path).set('x-test-user', admin()).send(body).expect(409);
        expect(response.body).toMatchObject({ status: 409, code: 'TIMPLAN_IS_DECIDED' });
        expect(response.body.detail).toContain('"Grundskolan 2024" är beslutad');
      }
      expect(harness.tx['localTimplan']!['update']).not.toHaveBeenCalled();
      expect(harness.tx['localTimplan']!['updateMany']).not.toHaveBeenCalled();
      expect(harness.tx['localTimplanEntry']!['deleteMany']).not.toHaveBeenCalled();
    });

    it('409s the trigger’s refusal — a plan decided mid-save — with the same code, never a 500', async () => {
      harness.tx['localTimplan']!['findUnique']!.mockResolvedValueOnce(storedPlan());
      harness.tx['subject']!['findMany']!.mockResolvedValueOnce([{ id: SUBJECT_ID }]);
      harness.tx['localTimplanEntry']!['createMany']!.mockRejectedValueOnce(triggerRefusal());

      const response = await request(http())
        .put(`/api/v1/local-timplans/${PLAN_ID}/entries`)
        .set('x-test-user', admin())
        .send({ entries: [{ subjectId: SUBJECT_ID, gradeLevel: 4, minutesPerWeek: 180 }] })
        .expect(409);
      expect(response.body).toMatchObject({ code: 'TIMPLAN_IS_DECIDED' });
      expect(response.body.detail).toContain('"Grundskolan 2024"');
    });

    it('409s reopening a draft, which is edited as it stands', async () => {
      harness.tx['localTimplan']!['findUnique']!.mockResolvedValueOnce({ ...storedPlan(), entries: [] });

      const response = await request(http())
        .post(`/api/v1/local-timplans/${PLAN_ID}/reopen`)
        .set('x-test-user', admin())
        .send({})
        .expect(409);
      expect(response.body).toMatchObject({ code: 'TIMPLAN_IS_DRAFT' });
      expect(harness.tx['localTimplan']!['create']).not.toHaveBeenCalled();
    });

    it('409s a name the school already uses', async () => {
      givenTheStatute();
      harness.tx['localTimplan']!['create']!.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: Prisma.prismaVersion.client }),
      );

      const response = await request(http())
        .post('/api/v1/local-timplans')
        .set('x-test-user', admin())
        .send({ name: 'Grundskolan 2024', schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: VERSION_ID })
        .expect(409);
      expect(response.body.detail).toContain('heter "Grundskolan 2024"');
    });
  });

  describe('timplan per årskurs', () => {
    /*
     * The year dialog's "Timplan per årskurs" over HTTP: a round trip that
     * reaches the handler and writes the diff, the DTO's refusals with their
     * field names, the 404 for a year RLS hides, the guard for a teacher — and
     * the delete of a plan some year follows, refused with the years named.
     */
    const PLAN_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
    const YEARS: LockedTable = {
      name: 'AcademicYears',
      columns: ['id', 'schoolId', 'name', 'startDate', 'endDate', 'isActive'],
      lock: 'FOR NO KEY UPDATE',
    };
    const MODELS = ['academicYearTimplan', 'localTimplan', 'academicYear'];
    const resetModels = () => {
      for (const model of MODELS) {
        for (const method of Object.values(harness.tx[model]!)) method.mockReset();
        harness.tx[model]!['findMany']!.mockResolvedValue([]);
      }
    };
    beforeEach(resetModels);
    afterEach(resetModels);

    it('an admin replaces the year’s mapping and reads it back, draft marked', async () => {
      givenLockedRows(YEARS, [{ id: YEAR_ID, schoolId: SCHOOL_ID }]);
      harness.tx['localTimplan']!['findMany']!.mockResolvedValueOnce([{ id: PLAN_ID }]);
      harness.tx['academicYearTimplan']!['findMany']!
        .mockResolvedValueOnce([{ gradeLevel: 9, localTimplanId: PLAN_ID }])
        .mockResolvedValueOnce([
          { gradeLevel: 7, localTimplanId: PLAN_ID, localTimplan: { name: 'Grundskolan 2027', status: 'DRAFT' } },
        ]);

      const response = await request(http())
        .put(`/api/v1/academic-years/${YEAR_ID}/timplans`)
        .set('x-test-user', admin())
        .send({ timplans: [{ gradeLevel: 7, localTimplanId: PLAN_ID.toUpperCase() }, { gradeLevel: 9, localTimplanId: null }] })
        .expect(200);

      expect(response.body).toEqual([
        { gradeLevel: 7, localTimplanId: PLAN_ID, planName: 'Grundskolan 2027', planStatus: 'DRAFT' },
      ]);
      expect(harness.tx['academicYearTimplan']!['deleteMany']).toHaveBeenCalledWith({
        where: { academicYearId: YEAR_ID, gradeLevel: { in: [9] } },
      });
      expect(harness.tx['academicYearTimplan']!['create']).toHaveBeenCalledWith({
        data: { schoolId: SCHOOL_ID, academicYearId: YEAR_ID, gradeLevel: 7, localTimplanId: PLAN_ID },
      });

      harness.tx['academicYear']!['findUnique']!.mockResolvedValueOnce({ id: YEAR_ID });
      harness.tx['academicYearTimplan']!['findMany']!.mockResolvedValueOnce([
        { gradeLevel: 7, localTimplanId: PLAN_ID, localTimplan: { name: 'Grundskolan 2027', status: 'DRAFT' } },
      ]);
      const read = await request(http())
        .get(`/api/v1/academic-years/${YEAR_ID}/timplans`)
        .set('x-test-user', admin())
        .expect(200);
      expect(read.body).toEqual(response.body);
    });

    it('a new year answers with the årskurser it follows the newest decided plan in', async () => {
      harness.tx['academicYear']!['create']!.mockResolvedValueOnce({ id: YEAR_ID, name: '2027/2028' });
      harness.tx['localTimplan']!['findFirst']!.mockResolvedValueOnce({
        id: PLAN_ID,
        name: 'Grundskolan 2024',
        status: 'DECIDED',
        nationalVersion: { schoolForm: 'GRUNDSKOLA', appliesFromCohortTerm: 'HT2024' },
        entries: [],
      });

      const response = await request(http())
        .post('/api/v1/academic-years')
        .set('x-test-user', admin())
        .send({ name: '2027/2028', startDate: '2027-08-16', endDate: '2028-06-09' })
        .expect(201);

      expect(response.body.timplans.map((row: { gradeLevel: number }) => row.gradeLevel)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(harness.tx['academicYearTimplan']!['createMany']).toHaveBeenCalledTimes(1);
    });

    it('400s a grade outside 0..10, a missing plan field and the same grade twice, naming the field', async () => {
      const bodies: [object, string][] = [
        [{ timplans: [{ gradeLevel: 11, localTimplanId: null }] }, 'gradeLevel: högsta årskurs är 10.'],
        [{ timplans: [{ gradeLevel: 4 }] }, 'localTimplanId: den lokala timplanen anges med sitt id, eller null för ingen.'],
        [{ timplans: [[{ gradeLevel: 4, localTimplanId: null }]] }, 'timplans: varje årskurs anges som ett objekt.'],
        [
          { timplans: [{ gradeLevel: 4, localTimplanId: null }, { gradeLevel: 4, localTimplanId: PLAN_ID }] },
          'rad 2 gäller samma årskurs 4 som rad 1',
        ],
      ];
      for (const [body, message] of bodies) {
        const response = await request(http())
          .put(`/api/v1/academic-years/${YEAR_ID}/timplans`)
          .set('x-test-user', admin())
          .send(body)
          .expect(400);
        expect(JSON.stringify(response.body)).toContain(message);
      }
      expect(harness.tx['academicYearTimplan']!['create']).not.toHaveBeenCalled();
    });

    it('404s a year RLS hides, on the read and on the write', async () => {
      givenLockedRows(YEARS, []);
      harness.tx['academicYear']!['findUnique']!.mockResolvedValueOnce(null);
      await request(http()).get(`/api/v1/academic-years/${YEAR_ID}/timplans`).set('x-test-user', admin()).expect(404);
      await request(http())
        .put(`/api/v1/academic-years/${YEAR_ID}/timplans`)
        .set('x-test-user', admin())
        .send({ timplans: [] })
        .expect(404);
    });

    it('stops a teacher at the guard on both verbs', async () => {
      const teacher = asUser({ role: 'TEACHER' as never });
      await request(http()).get(`/api/v1/academic-years/${YEAR_ID}/timplans`).set('x-test-user', teacher).expect(403);
      await request(http())
        .put(`/api/v1/academic-years/${YEAR_ID}/timplans`)
        .set('x-test-user', teacher)
        .send({ timplans: [] })
        .expect(403);
      expect(harness.tx['academicYearTimplan']!['findMany']).not.toHaveBeenCalled();
    });

    it('409s TIMPLAN_IN_USE for the delete of a plan a year follows, naming the year', async () => {
      harness.tx['academicYearTimplan']!['findMany']!.mockResolvedValueOnce([{ academicYear: { name: '2026/2027' } }]);

      const response = await request(http())
        .delete(`/api/v1/local-timplans/${PLAN_ID}`)
        .set('x-test-user', admin())
        .expect(409);

      expect(response.body).toMatchObject({ status: 409, code: 'TIMPLAN_IN_USE' });
      expect(response.body.detail).toContain('läsåret "2026/2027"');
      expect(harness.tx['localTimplan']!['delete']).not.toHaveBeenCalled();
    });
  });

  describe('timplanstäckning (planerat mot timplan)', () => {
    /*
     * GET /timplan-coverage over HTTP: the admin's round trip reaches the
     * handler and gets the pupil level; a teacher gets the same document
     * without a pupil in it; a pupil is stopped at the guard; the query DTO
     * refuses a layer that does not exist yet and a missing year.
     */
    const PLAN_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
    const MODELS = [
      'academicYear', 'academicYearTimplan', 'localTimplan', 'subject', 'studentGroup',
      'teachingRequirement', 'schoolBreak', 'user', 'studentGroupMember',
    ];
    const resetModels = () => {
      for (const model of MODELS) {
        for (const method of Object.values(harness.tx[model]!)) method.mockReset();
        harness.tx[model]!['findMany']!.mockResolvedValue([]);
      }
    };
    beforeEach(resetModels);
    afterEach(resetModels);

    const givenTheYear = () => {
      harness.tx['academicYear']!['findUnique']!.mockResolvedValue({
        startDate: new Date('2026-08-17T00:00:00.000Z'),
        endDate: new Date('2027-06-11T00:00:00.000Z'),
      });
      harness.tx['academicYearTimplan']!['findMany']!.mockResolvedValue([{ gradeLevel: 7, localTimplanId: PLAN_ID }]);
      harness.tx['localTimplan']!['findMany']!.mockResolvedValue([
        { id: PLAN_ID, name: 'Grundskolan 2024', status: 'DECIDED', entries: [{ subjectId: SUBJECT_ID, gradeLevel: 7, minutesPerWeek: 180 }] },
      ]);
      harness.tx['subject']!['findMany']!.mockResolvedValue([
        { id: SUBJECT_ID, name: 'Matematik', nationalCode: 'MA', countsTowardTimplan: true },
      ]);
      harness.tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: GROUP_ID, name: '7A', kind: 'CLASS', gradeLevel: 7 }]);
      harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([
        { id: TYPE_ID, studentGroupId: GROUP_ID, subjectId: SUBJECT_ID, lessonsPerWeek: 2, minutesPerLesson: 60, recurrence: 'ALL_WEEKS', startDate: null, endDate: null },
      ]);
      harness.tx['user']!['findMany']!.mockResolvedValue([{ id: STUDENT_ID, studentGroupId: GROUP_ID }]);
    };

    it('an admin reads the year’s planned coverage, pupil level included', async () => {
      givenTheYear();
      const response = await request(http())
        .get(`/api/v1/timplan-coverage?academicYearId=${YEAR_ID}&layer=planned`)
        .set('x-test-user', admin())
        .expect(200);

      expect(response.body).toMatchObject({ academicYearId: YEAR_ID, layer: 'planned', pupilLevel: true, pupilCount: 1 });
      expect(response.body.groups[0].lines[0]).toMatchObject({
        targetMinutesPerWeek: 180,
        plannedMinutesPerWeek: 120,
        deltaMinutesPerWeek: -60,
        status: 'UNDER',
      });
      expect(response.body.verdicts).toEqual([
        expect.objectContaining({
          code: 'TIMPLAN_GROUP_UNDERPLANNED',
          message: '7A: Matematik är planerat till 120 min/vecka, 60 under målet 180 min/vecka för åk 7.',
        }),
      ]);
      expect(response.body.pupils).toEqual([expect.objectContaining({ pupilId: STUDENT_ID })]);
    });

    it('a teacher reads the group level, with no pupil in the answer', async () => {
      givenTheYear();
      const response = await request(http())
        .get(`/api/v1/timplan-coverage?academicYearId=${YEAR_ID}`)
        .set('x-test-user', asUser({ role: 'TEACHER' as never }))
        .expect(200);

      expect(response.body).toMatchObject({ pupilLevel: false, pupils: null, pupilsBelowTarget: null });
      expect(JSON.stringify(response.body)).not.toContain(STUDENT_ID);
    });

    it('stops a pupil and a guardian at the guard', async () => {
      for (const role of ['STUDENT', 'GUARDIAN']) {
        await request(http())
          .get(`/api/v1/timplan-coverage?academicYearId=${YEAR_ID}`)
          .set('x-test-user', asUser({ role: role as never }))
          .expect(403);
      }
      expect(harness.tx['academicYear']!['findUnique']).not.toHaveBeenCalled();
    });

    it('400s a layer that is not built yet, and a missing or malformed year, naming the field', async () => {
      const cases: [string, string][] = [
        [`?academicYearId=${YEAR_ID}&layer=delivered`, "layer: bara 'planned'"],
        ['', 'academicYearId: läsåret anges med sitt id.'],
        ['?academicYearId=2026', 'academicYearId: läsåret anges med sitt id.'],
      ];
      for (const [query, message] of cases) {
        const response = await request(http())
          .get(`/api/v1/timplan-coverage${query}`)
          .set('x-test-user', admin())
          .expect(400);
        expect(JSON.stringify(response.body)).toContain(message);
      }
      expect(harness.tx['academicYear']!['findUnique']).not.toHaveBeenCalled();
    });

    it('404s a year RLS hides', async () => {
      harness.tx['academicYear']!['findUnique']!.mockResolvedValue(null);
      const response = await request(http())
        .get(`/api/v1/timplan-coverage?academicYearId=${YEAR_ID}`)
        .set('x-test-user', admin())
        .expect(404);
      expect(response.body.detail).toBe('Läsåret finns inte.');
    });
  });

  describe('skapa timplansposter (generate-requirements)', () => {
    /*
     * POST /local-timplans/:id/generate-requirements over HTTP: a preview and
     * an apply that reach the handler, the DTO's lesson bounds and grid with
     * their field names, the guard for a teacher, and the 404 for a plan RLS
     * hides.
     */
    const PLAN_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
    const path = `/api/v1/local-timplans/${PLAN_ID}/generate-requirements`;
    const MODELS = ['localTimplan', 'academicYear', 'academicYearTimplan', 'studentGroup', 'teachingRequirement', 'subject'];
    const resetModels = () => {
      for (const model of MODELS) {
        for (const method of Object.values(harness.tx[model]!)) method.mockReset();
        harness.tx[model]!['findMany']!.mockResolvedValue([]);
      }
    };
    beforeEach(resetModels);
    afterEach(resetModels);

    const givenThePlan = () => {
      harness.tx['localTimplan']!['findUnique']!.mockResolvedValue({
        id: PLAN_ID,
        name: 'Grundskolan 2024',
        status: 'DECIDED',
        entries: [{ subjectId: SUBJECT_ID, gradeLevel: 7, minutesPerWeek: 175 }],
      });
      harness.tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR_ID });
      harness.tx['academicYearTimplan']!['findMany']!.mockResolvedValue([{ gradeLevel: 7 }]);
      harness.tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: GROUP_ID, name: '7A', gradeLevel: 7 }]);
      harness.tx['subject']!['findMany']!.mockResolvedValue([{ id: SUBJECT_ID, name: 'Matematik' }]);
    };

    it('an admin previews, then applies, and the apply writes the previewed row', async () => {
      givenThePlan();
      const preview = await request(http())
        .post(path)
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, minutesPerLesson: 60, dryRun: true })
        .expect(200);
      expect(preview.body).toMatchObject({ dryRun: true, created: 0, gradeLevels: [7] });
      expect(preview.body.rows).toEqual([
        expect.objectContaining({ groupName: '7A', subjectName: 'Matematik', lessonsPerWeek: 3, minutesPerLesson: 60, surplusMinutesPerWeek: 5 }),
      ]);
      expect(harness.tx['teachingRequirement']!['createManyAndReturn']).not.toHaveBeenCalled();

      harness.tx['teachingRequirement']!['createManyAndReturn']!.mockResolvedValueOnce([
        { id: TYPE_ID, studentGroupId: GROUP_ID, subjectId: SUBJECT_ID },
      ]);
      const applied = await request(http())
        .post(path)
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, minutesPerLesson: 60, dryRun: false })
        .expect(200);
      expect(applied.body).toMatchObject({ dryRun: false, created: 1 });
      expect(applied.body.rows[0]).toMatchObject({ requirementId: TYPE_ID });
      expect(harness.tx['teachingRequirement']!['createManyAndReturn']).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });

    it('400s a length off the grid or out of bounds, a missing dryRun and an override past 40 lessons, naming the field', async () => {
      const bodies: [object, string][] = [
        [{ academicYearId: YEAR_ID, minutesPerLesson: 37, dryRun: true }, 'minutesPerLesson: lektionslängden måste vara ett helt antal 5-minutersintervall'],
        [{ academicYearId: YEAR_ID, minutesPerLesson: 250, dryRun: true }, 'minutesPerLesson: högst 240 minuter per lektion.'],
        [{ academicYearId: YEAR_ID, minutesPerLesson: 60 }, 'dryRun: anges som true'],
        [
          {
            academicYearId: YEAR_ID,
            minutesPerLesson: 60,
            dryRun: false,
            overrides: [{ studentGroupId: GROUP_ID, subjectId: SUBJECT_ID, lessonsPerWeek: 41, minutesPerLesson: 60 }],
          },
          'overrides: högst 40 lektioner per vecka.',
        ],
      ];
      for (const [body, message] of bodies) {
        const response = await request(http()).post(path).set('x-test-user', admin()).send(body).expect(400);
        expect(JSON.stringify(response.body)).toContain(message);
      }
      expect(harness.tx['localTimplan']!['findUnique']).not.toHaveBeenCalled();
    });

    it('400s an override for a class and subject the plan gives no row', async () => {
      givenThePlan();
      const response = await request(http())
        .post(path)
        .set('x-test-user', admin())
        .send({
          academicYearId: YEAR_ID,
          minutesPerLesson: 60,
          dryRun: false,
          overrides: [{ studentGroupId: STUDENT_ID, subjectId: SUBJECT_ID, lessonsPerWeek: 2, minutesPerLesson: 60 }],
        })
        .expect(400);
      expect(response.body.detail).toContain('timplanen inte ger någon post');
      expect(harness.tx['teachingRequirement']!['createManyAndReturn']).not.toHaveBeenCalled();
    });

    it('stops a teacher at the guard, and 404s a plan RLS hides', async () => {
      await request(http())
        .post(path)
        .set('x-test-user', asUser({ role: 'TEACHER' as never }))
        .send({ academicYearId: YEAR_ID, minutesPerLesson: 60, dryRun: true })
        .expect(403);
      harness.tx['localTimplan']!['findUnique']!.mockResolvedValue(null);
      await request(http())
        .post(path)
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, minutesPerLesson: 60, dryRun: true })
        .expect(404);
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
      ['POST', '/api/v1/rasts'],
      ['GET', '/api/v1/rasts'],
      ['POST', '/api/v1/lunch-sittings'],
      // The staffing settings and the unstaffed list are the admin's. The
      // module's other GETs admit TEACHER on purpose and are covered above.
      ['GET', '/api/v1/staffing-policy'],
      ['GET', '/api/v1/staffing/unstaffed'],
      ['GET', '/api/v1/staffing/suggest-teachers'],
      ['POST', '/api/v1/teacher-duties'],
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
