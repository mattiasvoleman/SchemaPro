import { Prisma } from '@prisma/client';
import request from 'supertest';
import { of } from 'rxjs';
import { lockingRead, type LockedTable } from './utils/locking-read';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';
import { forgetStaffingWorld, givenStaffingWorld, type StaffingWorld } from './utils/staffing-world';
import { GRUNDSKOLA_2024, IDS, defaultRolloverRows, givenRolloverWorld, staffingRows, type Row } from './utils/rollover-world';
import { rolloverRowsAtFa4a3d6 } from './utils/rollover-rows-fa4a3d6';
import type { PrismaMock } from './utils/prisma-mock';
import { PrismaService } from '../src/database/prisma.service';
import type { AiEngineScheduleRequest } from '../src/optimization/interfaces/ai-engine-payload.interface';

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
   * Lektionslängder over HTTP: the list through the validation pipe, the
   * merge and the response, on POST and PATCH. A uniform row's request and
   * response carry no list at all, which is the promise to a school that
   * never splits.
   */
  describe('timplan lektionslängder', () => {
    const REQUIREMENT_ID = '16161616-1616-4616-8616-161616161616';
    const SPLIT = {
      id: REQUIREMENT_ID,
      academicYearId: YEAR_ID,
      subjectId: SUBJECT_ID,
      studentGroupId: GROUP_ID,
      teacherId: null,
      coTeacherId: null,
      lessonsPerWeek: 2,
      minutesPerLesson: 80,
      lessonLengths: [80, 40],
      startDate: null,
      endDate: null,
    };

    /** The row the database would hand back for the data that was written. */
    const echo = (stored: Record<string, unknown>) => ({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...stored, ...data });

    const post = (body: Record<string, unknown>) =>
      request(http())
        .post('/api/v1/teaching-requirements')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, subjectId: SUBJECT_ID, studentGroupId: GROUP_ID, ...body });
    const patch = (body: Record<string, unknown>) =>
      request(http())
        .patch(`/api/v1/teaching-requirements/${REQUIREMENT_ID}`)
        .set('x-test-user', admin())
        .send(body);
    const written = (method: 'create' | 'update') =>
      (harness.tx['teachingRequirement']![method]!.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    const givenStored = (row: Record<string, unknown>) =>
      harness.tx['teachingRequirement']!['findUnique']!.mockResolvedValue(row);

    afterEach(() => {
      harness.tx['teachingRequirement']!['findUnique']!.mockReset();
    });

    it('POST 1 × 80 + 1 × 40: 201 with the list, the count and the longest', async () => {
      harness.tx['teachingRequirement']!['create']!.mockImplementation(echo({ ...SPLIT, lessonLengths: [] }));

      const response = await post({ lessonLengths: [40, 80] }).expect(201);

      expect(written('create')).toMatchObject({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] });
      expect(response.body).toMatchObject({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] });
    });

    it('POST a uniform row: no list written and none answered', async () => {
      harness.tx['teachingRequirement']!['create']!.mockImplementation(echo({ ...SPLIT, lessonLengths: [] }));

      const response = await post({ lessonsPerWeek: 3, minutesPerLesson: 60 }).expect(201);

      expect(written('create')).not.toHaveProperty('lessonLengths');
      expect(response.body).toMatchObject({ lessonsPerWeek: 3, minutesPerLesson: 60 });
      expect(response.body).not.toHaveProperty('lessonLengths');
    });

    it('PATCH with the stored scalars keeps the split and writes no length field', async () => {
      givenStored(SPLIT);
      harness.tx['teachingRequirement']!['update']!.mockImplementation(echo(SPLIT));

      const response = await patch({ lessonsPerWeek: 2, minutesPerLesson: 80, minutesBefore: 10 }).expect(200);

      expect(written('update')).toEqual({ minutesBefore: 10 });
      expect(response.body).toMatchObject({ lessonLengths: [80, 40], minutesBefore: 10 });
    });

    it('PATCH with other scalars makes the row uniform as they say', async () => {
      givenStored(SPLIT);
      harness.tx['teachingRequirement']!['update']!.mockImplementation(echo(SPLIT));

      const response = await patch({ lessonsPerWeek: 3, minutesPerLesson: 60 }).expect(200);

      expect(written('update')).toEqual({ lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [] });
      expect(response.body).not.toHaveProperty('lessonLengths');
    });

    it('PATCH [] makes the row uniform at its count and longest', async () => {
      givenStored(SPLIT);
      harness.tx['teachingRequirement']!['update']!.mockImplementation(echo(SPLIT));

      await patch({ lessonLengths: [] }).expect(200);

      expect(written('update')).toEqual({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [] });
    });

    it.each<[string, Record<string, unknown>, string | null, string]>([
      ['scalars that contradict the list', { lessonLengths: [80, 40], lessonsPerWeek: 3 }, 'LESSON_LENGTHS_MISMATCH', 'lessonLengths: 2 lektioner'],
      ['a fourth different length', { lessonLengths: [90, 80, 60, 40] }, 'LESSON_LENGTHS_TOO_MANY_KINDS', 'högst tre olika'],
      ['a length between slots', { lessonLengths: [60, 42] }, null, 'Närmast är 40 eller 45 minuter'],
      ['a length past 240', { lessonLengths: [245, 40] }, null, 'lessonLengths: högst 240 minuter'],
      ['null', { lessonLengths: null }, null, 'lessonLengths: anges som en lista'],
    ])('400 on %s, on POST and on PATCH, and nothing written', async (_case, body, code, says) => {
      givenStored(SPLIT);

      const created = await post(body).expect(400);
      const patched = await patch(body).expect(400);

      for (const response of [created, patched]) {
        if (code) expect(response.body).toMatchObject({ code });
        expect(JSON.stringify(response.body)).toContain(says);
      }
      expect(harness.tx['teachingRequirement']!['create']).not.toHaveBeenCalled();
      expect(harness.tx['teachingRequirement']!['update']).not.toHaveBeenCalled();
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
      // The class check is asked of the year, with the class as a relation filter.
      harness.tx['academicYear']!['findFirst']!.mockResolvedValue({ isActive: true, predecessorId: null });
      harness.tx['user']!['count']!.mockResolvedValue(24);
    });

    // clearAllMocks keeps a stubbed value, so these would otherwise answer for
    // every describe below this one.
    afterEach(() => {
      harness.tx['lunchSetting']!['findUnique']!.mockReset();
      harness.tx['academicYear']!['findFirst']!.mockReset();
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
      loadFactor: new Prisma.Decimal('1.000'),
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

    it('a PATCH writes the subject’s Faktor and answers it as a number; 3,5 and four decimals are 400 in Swedish, a teacher 403', async () => {
      harness.tx['subject']!['update']!.mockResolvedValue({
        ...storedSubject('SL'),
        loadFactor: new Prisma.Decimal('0.700'),
      });

      const response = await request(http())
        .patch(`/api/v1/subjects/${NATIONAL_SUBJECT_ID}`)
        .set('x-test-user', admin())
        .send({ loadFactor: 0.7 })
        .expect(200);
      expect(response.body.loadFactor).toBe(0.7);
      expect(harness.tx['subject']!['update']).toHaveBeenCalledWith({
        where: { id: NATIONAL_SUBJECT_ID },
        data: { loadFactor: 0.7 },
      });

      for (const loadFactor of [3.5, 0.4, 1.2345, null]) {
        const refused = await request(http())
          .patch(`/api/v1/subjects/${NATIONAL_SUBJECT_ID}`)
          .set('x-test-user', admin())
          .send({ loadFactor })
          .expect(400);
        expect(JSON.stringify(refused.body)).toContain('faktorn är ett tal mellan 0,5 och 3');
      }
      await request(http())
        .patch(`/api/v1/subjects/${NATIONAL_SUBJECT_ID}`)
        .set('x-test-user', teacher())
        .send({ loadFactor: 0.7 })
        .expect(403);
      expect(harness.tx['subject']!['update']).toHaveBeenCalledTimes(1);
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

      it('writes the SS12000 switch through the handler, off unless sent, and 400s a string', async () => {
        harness.tx['staffingPolicy']!['upsert']!.mockResolvedValue(
          storedPolicy({ shareEmploymentWithIntegrations: true }),
        );
        const written = await request(http())
          .put('/api/v1/staffing-policy')
          .set('x-test-user', admin())
          .send({ fullTimeTeachingMinutesPerWeek: 1080, shareEmploymentWithIntegrations: true })
          .expect(200);
        expect(written.body).toMatchObject({ shareEmploymentWithIntegrations: true });
        const args = harness.tx['staffingPolicy']!['upsert']!.mock.calls[0]?.[0] as {
          update: Record<string, unknown>;
        };
        expect(args.update).toMatchObject({ shareEmploymentWithIntegrations: true });

        await request(http())
          .put('/api/v1/staffing-policy')
          .set('x-test-user', admin())
          .send({ fullTimeTeachingMinutesPerWeek: 1080 })
          .expect(200);
        const second = harness.tx['staffingPolicy']!['upsert']!.mock.calls[1]?.[0] as {
          update: Record<string, unknown>;
        };
        expect(second.update).toMatchObject({ shareEmploymentWithIntegrations: false });

        await request(http())
          .put('/api/v1/staffing-policy')
          .set('x-test-user', admin())
          .send({ shareEmploymentWithIntegrations: 'ja' })
          .expect(400);
        expect(harness.tx['staffingPolicy']!['upsert']).toHaveBeenCalledTimes(2);
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
        harness.tx['teachingRequirement']!['findUnique']!.mockResolvedValue({
          academicYearId: YEAR_ID,
          subjectId: SUBJECT_ID,
          studentGroup: { predecessorId: null },
        });
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

      it('names last year’s teacher of the subject, and ranks them before room left', async () => {
        const PREDECESSOR_GROUP = '80808080-8080-4080-8080-808080808080';
        harness.tx['teachingRequirement']!['findUnique']!.mockResolvedValue({
          academicYearId: YEAR_ID,
          subjectId: SUBJECT_ID,
          studentGroup: { predecessorId: PREDECESSOR_GROUP },
        });
        harness.tx['user']!['findMany']!.mockResolvedValue([{ id: COLLEAGUE_ID }, { id: TEACHER_ID }]);
        const thisYear = [
          requirementRow(),
          requirementRow({ id: '60606060-6060-4060-8060-606060606060', teacherId: TEACHER_ID, lessonsPerWeek: 2 }),
          requirementRow({ id: '70707070-7070-4070-8070-707070707070', teacherId: null, lessonsPerWeek: 3 }),
        ];
        harness.tx['teachingRequirement']!['findMany']!.mockImplementation(((args: { where: Record<string, unknown> }) =>
          Promise.resolve(
            args.where['studentGroupId'] === PREDECESSOR_GROUP
              ? [
                  {
                    teacherId: null,
                    coTeacherId: COLLEAGUE_ID,
                    studentGroup: { name: '6A', academicYear: { name: '2025/26' } },
                  },
                ]
              : thisYear,
          )) as never);

        const response = await request(http())
          .get(`/api/v1/staffing/suggest-teachers?requirementId=70707070-7070-4070-8070-707070707070`)
          .set('x-test-user', admin())
          .expect(200);

        expect(response.body.lastYear).toEqual({ groupName: '6A', yearName: '2025/26' });
        // Without continuity the teacher (780 left) leads the colleague (85
        // left); the colleague co-taught 6A Ma last year, which ranks first.
        expect(response.body.candidates).toEqual([
          expect.objectContaining({ userId: COLLEAGUE_ID, taughtLastYear: true, remainingMinutesPerWeek: 85 }),
          expect.objectContaining({ userId: TEACHER_ID, taughtLastYear: false, remainingMinutesPerWeek: 780 }),
        ]);
        expect(harness.tx['teachingRequirement']!['findMany']!).toHaveBeenLastCalledWith(
          expect.objectContaining({ where: { studentGroupId: PREDECESSOR_GROUP, subjectId: SUBJECT_ID } }),
        );
        // Back to the block's own stub, which later blocks have always inherited.
        harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue(thisYear);
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
      'teachingRequirement', 'schoolBreak', 'user', 'studentGroupMember', 'masterLesson',
      'timplanCredit', 'availabilityConstraint',
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
      // The pupil is short only because 7A is: counted, not listed line by line.
      expect(response.body).toMatchObject({ pupils: [], pupilsBelowTarget: 1 });
      expect(response.body.groups[0].lines[0].pupils).toEqual({ min: 120, median: 120, max: 120, below: 1 });
    });

    it('counts a split row by its lessons’ minutes: 1 × 80 + 1 × 40 is 120, not 160', async () => {
      givenTheYear();
      harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([
        {
          id: TYPE_ID, studentGroupId: GROUP_ID, subjectId: SUBJECT_ID,
          lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40],
          recurrence: 'ALL_WEEKS', startDate: null, endDate: null,
        },
      ]);

      const response = await request(http())
        .get(`/api/v1/timplan-coverage?academicYearId=${YEAR_ID}&layer=planned`)
        .set('x-test-user', admin())
        .expect(200);

      const query = harness.tx['teachingRequirement']!['findMany']!.mock.calls[0]![0] as { select: object };
      expect(query.select).toMatchObject({ lessonLengths: true });
      expect(response.body.groups[0].lines[0]).toMatchObject({
        targetMinutesPerWeek: 180,
        plannedMinutesPerWeek: 120,
        status: 'UNDER',
      });
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

    it('stops a pupil and a guardian at the guard, on every layer', async () => {
      for (const layer of ['', '&layer=planned', '&layer=scheduled', '&layer=delivered']) {
        for (const role of ['STUDENT', 'GUARDIAN']) {
          await request(http())
            .get(`/api/v1/timplan-coverage?academicYearId=${YEAR_ID}${layer}`)
            .set('x-test-user', asUser({ role: role as never }))
            .expect(403);
        }
      }
      expect(harness.tx['academicYear']!['findUnique']).not.toHaveBeenCalled();
    });

    const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
    const givenTheSchedule = () => {
      givenTheYear();
      harness.tx['masterLesson']!['findMany']!.mockResolvedValue(
        ['08:00', '10:00'].map((start, index) => ({
          id: `b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b${index}`,
          studentGroupId: GROUP_ID,
          subjectId: SUBJECT_ID,
          startTime: t(start),
          endTime: t(start === '08:00' ? '09:00' : '10:55'),
          recurrence: 'ALL_WEEKS',
          startDate: null,
          endDate: null,
          isParked: false,
          extraGroups: [],
          participants: [],
        })),
      );
    };

    it('an admin reads the scheduled layer, and drills into a group for every pupil', async () => {
      givenTheSchedule();
      const response = await request(http())
        .get(`/api/v1/timplan-coverage?academicYearId=${YEAR_ID}&layer=scheduled`)
        .set('x-test-user', admin())
        .expect(200);
      expect(response.body).toMatchObject({ academicYearId: YEAR_ID, layer: 'scheduled', pupilLevel: true, lessonCount: 2 });
      expect(response.body.groups[0].lines[0]).toMatchObject({
        plannedMinutesPerWeek: 120,
        scheduledMinutesPerWeek: 115,
        deltaMinutesPerWeek: -5,
        percent: 96,
        status: 'SHORT',
      });
      expect(response.body.verdicts).toEqual([
        expect.objectContaining({
          code: 'TIMPLAN_SCHEDULE_SHORT',
          message: '7A: Matematik har 115 min/vecka i grundschemat, 5 under planerade 120 min/vecka.',
        }),
      ]);
      expect(response.body.pupils).toEqual([]);

      const drilled = await request(http())
        .get(`/api/v1/timplan-coverage?academicYearId=${YEAR_ID}&layer=scheduled&studentGroupId=${GROUP_ID}`)
        .set('x-test-user', admin())
        .expect(200);
      expect(drilled.body.pupils).toEqual([
        expect.objectContaining({ pupilId: STUDENT_ID, lines: [expect.objectContaining({ scheduledMinutesPerWeek: 115 })] }),
      ]);
    });

    it('a teacher reads the scheduled layer at group level, drill-down or not, with no pupil in it', async () => {
      givenTheSchedule();
      for (const query of ['', `&studentGroupId=${GROUP_ID}`]) {
        const response = await request(http())
          .get(`/api/v1/timplan-coverage?academicYearId=${YEAR_ID}&layer=scheduled${query}`)
          .set('x-test-user', asUser({ role: 'TEACHER' as never }))
          .expect(200);
        expect(response.body).toMatchObject({ pupilLevel: false, pupils: null, pupilsBelowPlanned: null });
        expect(JSON.stringify(response.body)).not.toContain(STUDENT_ID);
      }
    });

    /**
     * The aggregate statements, answered by what each one asks for — the
     * harness has no database, so the SQL's own text routes the answer. The
     * year: 7A matematik delivered 10 × 60, one lesson cancelled for the
     * teacher, two ahead; nothing else.
     */
    const givenTheCalendar = (published: { from: string | null; through: string | null }) => {
      givenTheYear();
      const queryRaw = jest.fn((query: { sql?: string; strings?: string[] }) => {
        const text = query.sql ?? (query.strings ?? []).join('?');
        if (text.includes('"aheadRows"')) {
          // Only the grand total of GROUPING SETS: no master lesson has rows.
          return Promise.resolve([
            { masterLessonId: null, total: 1, aheadRows: 0, firstDate: published.from, lastDate: published.through },
          ]);
        }
        if (text.includes('GROUP BY 1, 2, 3, 4, 5')) {
          const row = (bucket: string, lessons: number) => ({
            studentGroupId: GROUP_ID, subjectId: SUBJECT_ID, bucket, extraGroupIds: [], studentIds: [], minutes: lessons * 60, lessons,
          });
          return Promise.resolve([row('DELIVERED', 10), row('CANCELLED_TEACHER_UNAVAILABLE', 1), row('AHEAD', 2)]);
        }
        if (text.includes('= ANY(')) return Promise.resolve([]);
        return Promise.reject(new Error(`unexpected statement: ${text.slice(0, 80)}`));
      });
      Object.assign(harness.tx, { $queryRaw: queryRaw });
      return queryRaw;
    };

    it('an admin reads the delivered layer: compact lines in the overview, the breakdown in the drill-down', async () => {
      const queryRaw = givenTheCalendar({ from: '2026-08-17', through: '2026-10-23' });
      const overview = await request(http())
        .get(`/api/v1/timplan-coverage?academicYearId=${YEAR_ID}&layer=delivered`)
        .set('x-test-user', admin())
        .expect(200);
      expect(overview.body).toMatchObject({
        academicYearId: YEAR_ID,
        layer: 'delivered',
        published: { from: '2026-08-17', through: '2026-10-23' },
        pupilLevel: true,
        pupilCount: 1,
      });
      expect(overview.body.groups[0].lostByCause).toEqual({ cancelledTeacherUnavailable: 60 });
      const line = overview.body.groups[0].lines[0];
      expect(line).toMatchObject({ publishedMinutes: 660, deliveredMinutes: 600, lostMinutes: 60, deliveredPercent: 91 });
      expect(line).not.toHaveProperty('projection');
      // C (with the published range), then A+B; D only with credit or break days.
      expect(queryRaw).toHaveBeenCalledTimes(2);
      for (const verdict of overview.body.verdicts) expect(typeof verdict.message).toBe('string');

      const drilled = await request(http())
        .get(`/api/v1/timplan-coverage?academicYearId=${YEAR_ID}&layer=delivered&studentGroupId=${GROUP_ID}`)
        .set('x-test-user', admin())
        .expect(200);
      expect(drilled.body.groups[0].lines[0]).toMatchObject({
        lost: { cancelledTeacherUnavailable: 60 },
        projection: { deliveredSoFar: 600, calendarAhead: 120 },
      });
      expect(drilled.body.pupils).toEqual([expect.objectContaining({ pupilId: STUDENT_ID })]);
    });

    it('a teacher reads the delivered layer at group level, drill-down included, with no pupil in it', async () => {
      givenTheCalendar({ from: '2026-08-17', through: '2026-10-23' });
      for (const query of ['', `&studentGroupId=${GROUP_ID}`]) {
        const response = await request(http())
          .get(`/api/v1/timplan-coverage?academicYearId=${YEAR_ID}&layer=delivered${query}`)
          .set('x-test-user', asUser({ role: 'TEACHER' as never }))
          .expect(200);
        expect(response.body).toMatchObject({ pupilLevel: false, pupils: null, pupilsBelowPlanned: null });
        expect(JSON.stringify(response.body)).not.toContain(STUDENT_ID);
        expect(response.body.groups[0].lines[0].deliveredMinutes).toBe(600);
      }
    });

    it('a year with no published calendar answers 200 with one notice and nothing else', async () => {
      givenTheCalendar({ from: null, through: null });
      const response = await request(http())
        .get(`/api/v1/timplan-coverage?academicYearId=${YEAR_ID}&layer=delivered`)
        .set('x-test-user', admin())
        .expect(200);
      expect(response.body).toMatchObject({ published: null, groups: [], pupils: [] });
      expect(response.body.verdicts).toEqual([
        expect.objectContaining({ code: 'TIMPLAN_NOT_PUBLISHED', severity: 'notice' }),
      ]);
    });

    it('400s a drill-down on the planned layer, whose answer keeps its shape', async () => {
      for (const query of [`&studentGroupId=${GROUP_ID}`, `&layer=planned&studentGroupId=${GROUP_ID}`]) {
        const response = await request(http())
          .get(`/api/v1/timplan-coverage?academicYearId=${YEAR_ID}${query}`)
          .set('x-test-user', admin())
          .expect(400);
        expect(response.body.detail).toContain('studentGroupId: ');
      }
    });

    it('400s an unknown layer, and a missing or malformed year, naming the field', async () => {
      const cases: [string, string][] = [
        [`?academicYearId=${YEAR_ID}&layer=weekly`, "layer: 'planned'"],
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

  describe('tillgodoräknad tid (timplan-credits)', () => {
    /*
     * /timplan-credits over HTTP: the admin's round trip POST → GET → PATCH
     * (the scope replaced whole) → DELETE reaches every handler; a teacher
     * reads and writes nothing; a pupil is stopped at the guard; the DTO and
     * the service's year rule answer 400 naming the field.
     */
    const CREDIT_ID = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
    const MODELS = ['academicYear', 'timplanCredit', 'studentGroup', 'subject'];
    const resetModels = () => {
      for (const model of MODELS) {
        for (const method of Object.values(harness.tx[model]!)) method.mockReset();
        harness.tx[model]!['findMany']!.mockResolvedValue([]);
      }
    };
    beforeEach(resetModels);
    afterEach(resetModels);

    const YEAR = {
      id: YEAR_ID,
      name: '2026/27',
      startDate: new Date('2026-08-17T00:00:00.000Z'),
      endDate: new Date('2027-06-11T00:00:00.000Z'),
    };
    const row = (overrides: Record<string, unknown> = {}) => ({
      id: CREDIT_ID,
      academicYearId: YEAR_ID,
      date: new Date('2026-09-25T00:00:00.000Z'),
      minutes: 300,
      subjectId: SUBJECT_ID,
      studentGroupId: null,
      minGradeLevel: 7,
      maxGradeLevel: 9,
      name: 'Friluftsdag',
      note: null,
      ...overrides,
    });

    it('an admin creates, lists, re-scopes and deletes a credit', async () => {
      const tx = harness.tx;
      tx['academicYear']!['findUnique']!.mockResolvedValue(YEAR);
      tx['subject']!['findUnique']!.mockResolvedValue({ id: SUBJECT_ID });
      tx['studentGroup']!['findUnique']!.mockResolvedValue({ academicYearId: YEAR_ID, name: '7A' });
      tx['timplanCredit']!['create']!.mockImplementation((args: { data: Record<string, unknown> }) =>
        Promise.resolve(row(args.data)),
      );

      const created = await request(http())
        .post('/api/v1/timplan-credits')
        .set('x-test-user', admin())
        .send({
          academicYearId: YEAR_ID,
          date: '2026-09-25',
          minutes: 300,
          subjectId: SUBJECT_ID,
          minGradeLevel: 7,
          maxGradeLevel: 9,
          name: 'Friluftsdag',
        })
        .expect(201);
      expect(created.body).toEqual({
        id: CREDIT_ID,
        academicYearId: YEAR_ID,
        date: '2026-09-25',
        minutes: 300,
        subjectId: SUBJECT_ID,
        studentGroupId: null,
        minGradeLevel: 7,
        maxGradeLevel: 9,
        name: 'Friluftsdag',
        note: null,
      });

      tx['timplanCredit']!['findMany']!.mockResolvedValue([row()]);
      const listed = await request(http())
        .get(`/api/v1/timplan-credits?academicYearId=${YEAR_ID}`)
        .set('x-test-user', admin())
        .expect(200);
      expect(listed.body).toMatchObject([{ id: CREDIT_ID, date: '2026-09-25', minutes: 300 }]);

      tx['timplanCredit']!['findUnique']!.mockResolvedValue({ ...row(), academicYear: YEAR });
      tx['timplanCredit']!['update']!.mockImplementation((args: { data: Record<string, unknown> }) =>
        Promise.resolve(row(args.data)),
      );
      const patched = await request(http())
        .patch(`/api/v1/timplan-credits/${CREDIT_ID}`)
        .set('x-test-user', admin())
        .send({ studentGroupId: GROUP_ID })
        .expect(200);
      expect(patched.body).toMatchObject({ studentGroupId: GROUP_ID, minGradeLevel: null, maxGradeLevel: null });
      expect(tx['timplanCredit']!['update']!.mock.calls[0]![0]).toMatchObject({
        where: { id: CREDIT_ID },
        data: { studentGroupId: GROUP_ID, minGradeLevel: null, maxGradeLevel: null },
      });

      tx['timplanCredit']!['delete']!.mockResolvedValue({ id: CREDIT_ID });
      await request(http())
        .delete(`/api/v1/timplan-credits/${CREDIT_ID}`)
        .set('x-test-user', admin())
        .expect(204);
      expect(tx['timplanCredit']!['delete']).toHaveBeenCalledWith({ where: { id: CREDIT_ID }, select: { id: true } });
    });

    it('a teacher reads the year’s credits and writes none', async () => {
      harness.tx['academicYear']!['findUnique']!.mockResolvedValue(YEAR);
      harness.tx['timplanCredit']!['findMany']!.mockResolvedValue([row()]);
      const teacher = asUser({ role: 'TEACHER' as never });
      await request(http())
        .get(`/api/v1/timplan-credits?academicYearId=${YEAR_ID}`)
        .set('x-test-user', teacher)
        .expect(200);
      await request(http()).post('/api/v1/timplan-credits').set('x-test-user', teacher).send({}).expect(403);
      await request(http())
        .patch(`/api/v1/timplan-credits/${CREDIT_ID}`)
        .set('x-test-user', teacher)
        .send({ minutes: 60 })
        .expect(403);
      await request(http()).delete(`/api/v1/timplan-credits/${CREDIT_ID}`).set('x-test-user', teacher).expect(403);
      expect(harness.tx['timplanCredit']!['create']).not.toHaveBeenCalled();
      expect(harness.tx['timplanCredit']!['delete']).not.toHaveBeenCalled();
    });

    it('stops a pupil and a guardian at the guard', async () => {
      for (const role of ['STUDENT', 'GUARDIAN']) {
        await request(http())
          .get(`/api/v1/timplan-credits?academicYearId=${YEAR_ID}`)
          .set('x-test-user', asUser({ role: role as never }))
          .expect(403);
      }
      expect(harness.tx['timplanCredit']!['findMany']).not.toHaveBeenCalled();
    });

    it('400s a date outside the läsår and a group with a span, naming the field', async () => {
      harness.tx['academicYear']!['findUnique']!.mockResolvedValue(YEAR);
      const base = { academicYearId: YEAR_ID, date: '2026-09-25', minutes: 300, name: 'Friluftsdag' };
      const outside = await request(http())
        .post('/api/v1/timplan-credits')
        .set('x-test-user', admin())
        .send({ ...base, date: '2027-06-14' })
        .expect(400);
      expect(outside.body).toMatchObject({ code: 'TIMPLAN_CREDIT_OUTSIDE_YEAR' });
      expect(outside.body.detail).toContain('date: 2027-06-14 ligger utanför läsåret 2026/27');

      const both = await request(http())
        .post('/api/v1/timplan-credits')
        .set('x-test-user', admin())
        .send({ ...base, studentGroupId: GROUP_ID, minGradeLevel: 7, maxGradeLevel: 9 })
        .expect(400);
      expect(both.body).toMatchObject({ code: 'TIMPLAN_CREDIT_SCOPE' });
      expect(both.body.detail).toContain('studentGroupId: ');

      const minutes = await request(http())
        .post('/api/v1/timplan-credits')
        .set('x-test-user', admin())
        .send({ ...base, minutes: 3000 })
        .expect(400);
      expect(JSON.stringify(minutes.body)).toContain('minutes: 1 till 600 minuter');
      expect(harness.tx['timplanCredit']!['create']).not.toHaveBeenCalled();
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

    it('SPLIT: previews 175 as 2 × 60 + 1 × 55, echoes the mode, and the apply writes the lengths', async () => {
      givenThePlan();
      const preview = await request(http())
        .post(path)
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, minutesPerLesson: 60, remainder: 'SPLIT', dryRun: true })
        .expect(200);
      expect(preview.body).toMatchObject({ remainder: 'SPLIT', dryRun: true, created: 0 });
      expect(preview.body.rows).toEqual([
        expect.objectContaining({
          lessonsPerWeek: 3,
          minutesPerLesson: 60,
          lessonLengths: [60, 60, 55],
          plannedMinutesPerWeek: 175,
          surplusMinutesPerWeek: 0,
        }),
      ]);

      harness.tx['teachingRequirement']!['createManyAndReturn']!.mockResolvedValueOnce([
        { id: TYPE_ID, studentGroupId: GROUP_ID, subjectId: SUBJECT_ID },
      ]);
      await request(http())
        .post(path)
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, minutesPerLesson: 60, remainder: 'SPLIT', dryRun: false })
        .expect(200);
      const written = harness.tx['teachingRequirement']!['createManyAndReturn']!.mock.calls[0]![0] as { data: Record<string, unknown>[] };
      expect(written.data[0]).toMatchObject({ lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [60, 60, 55] });
    });

    it('an omitted remainder answers and writes as before: 3 × 60, +5, no list, no echo', async () => {
      givenThePlan();
      const preview = await request(http())
        .post(path)
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, minutesPerLesson: 60, dryRun: true })
        .expect(200);
      expect(preview.body).not.toHaveProperty('remainder');
      expect(JSON.stringify(preview.body)).not.toContain('lessonLengths');

      harness.tx['teachingRequirement']!['createManyAndReturn']!.mockResolvedValueOnce([
        { id: TYPE_ID, studentGroupId: GROUP_ID, subjectId: SUBJECT_ID },
      ]);
      await request(http())
        .post(path)
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, minutesPerLesson: 60, dryRun: false })
        .expect(200);
      const written = harness.tx['teachingRequirement']!['createManyAndReturn']!.mock.calls[0]![0] as { data: Record<string, unknown>[] };
      expect(written.data[0]).not.toHaveProperty('lessonLengths');
    });

    it('400s a remainder that is neither SPLIT nor ROUND_UP, null included', async () => {
      for (const remainder of ['FOLD', null, 1]) {
        const response = await request(http())
          .post(path)
          .set('x-test-user', admin())
          .send({ academicYearId: YEAR_ID, minutesPerLesson: 60, remainder, dryRun: true })
          .expect(400);
        expect(JSON.stringify(response.body)).toContain('remainder: anges som SPLIT');
      }
      expect(harness.tx['localTimplan']!['findUnique']).not.toHaveBeenCalled();
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

  describe('year rollover', () => {
    /*
     * The four läsårsrullning routes over HTTP, against a small school held
     * as rows (test/utils/rollover-world.ts) rather than call-by-call stubs:
     * the rollover reads some twenty tables and plans from all of them. The
     * harness's PrismaService mock runs each withRls callback on the world's
     * transaction for the length of a test.
     */
    let prisma: PrismaMock;
    let originalWithRls: ((...args: unknown[]) => unknown) | undefined;

    beforeEach(() => {
      prisma = harness.app.get(PrismaService) as unknown as PrismaMock;
      originalWithRls = prisma.withRls.getMockImplementation();
    });
    afterEach(() => {
      prisma.withRls.mockImplementation(originalWithRls);
    });

    /** The default school, with year A moved to `startYear`/`startYear + 1`. */
    const givenSchool = (startYear: number) => {
      const rows = defaultRolloverRows();
      const shift = (startYear - 2026) * 364;
      const move = (value: unknown) =>
        value instanceof Date ? new Date(value.getTime() + shift * 86_400_000) : value;
      for (const table of ['academicYear', 'teachingRequirement', 'schoolBreak']) {
        for (const row of rows[table]!) {
          for (const key of ['startDate', 'endDate']) row[key] = move(row[key]);
        }
      }
      const world = givenRolloverWorld(rows);
      prisma.withRls.mockImplementation((_user: unknown, fn: (tx: unknown) => unknown) => fn(world.tx));
      const yearA = rows['academicYear']![0]!;
      const day = (key: string, days: number) =>
        new Date((yearA[key] as Date).getTime() + days * 86_400_000).toISOString().slice(0, 10);
      const options = {
        name: 'Nästa läsår',
        startDate: day('startDate', 364),
        endDate: day('endDate', 364),
      };
      return { world, rows, options };
    };
    const base = `/api/v1/academic-years/${IDS.yearA}`;

    /** Preview, then execute with the preview's hash, expecting `status`. */
    const roll = async (options: Record<string, unknown>, status: number) => {
      const preview = await request(http())
        .post(`${base}/rollover/preview`)
        .set('x-test-user', admin())
        .send(options)
        .expect(200);
      return request(http())
        .post(`${base}/rollover`)
        .set('x-test-user', admin())
        .send({ ...options, graduatingGradeLevel: 9, planHash: preview.body.planHash })
        .expect(status);
    };

    it('carries a split timplanspost into the new year with its lengths, and every uniform one without a list (admin round-trip)', async () => {
      const { world, options } = givenSchool(2020);
      const ma7 = world.rows['teachingRequirement']!.find(
        (row) => row['studentGroupId'] === IDS.g7a && row['subjectId'] === IDS.ma,
      )!;
      Object.assign(ma7, { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] });

      const yearB = (await roll(options, 201)).body.academicYear.id as string;

      const eightA = world.rows['studentGroup']!.find(
        (group) => group['academicYearId'] === yearB && group['name'] === '8A',
      )!['id'];
      const carried = world.rows['teachingRequirement']!.filter((row) => row['academicYearId'] === yearB);
      expect(carried.find((row) => row['studentGroupId'] === eightA && row['subjectId'] === IDS.ma)).toMatchObject({
        lessonsPerWeek: 2,
        minutesPerLesson: 80,
        lessonLengths: [80, 40],
      });
      expect(carried.filter((row) => 'lessonLengths' in row)).toHaveLength(1);
    });

    it('previews and executes a rollover, then previews and executes the activation (admin round-trips)', async () => {
      // A year that ended long ago, so the activation is not too early.
      const { world, options } = givenSchool(2020);

      const preview = await request(http()).post(`${base}/rollover/preview`).set('x-test-user', admin()).send(options).expect(200);
      expect(preview.body).toMatchObject({ graduatingGradeLevel: 9, blocking: false });
      expect(preview.body.groups.map((group: { targetName: string | null }) => group.targetName)).toEqual(
        expect.arrayContaining(['8A', '9A', null]),
      );

      const created = await request(http())
        .post(`${base}/rollover`)
        .set('x-test-user', admin())
        .send({ ...options, graduatingGradeLevel: 9, planHash: preview.body.planHash })
        .expect(201);
      expect(created.body).toMatchObject({
        academicYear: { name: 'Nästa läsår', isActive: false, predecessorId: IDS.yearA, graduatingGradeLevel: 9 },
        counts: { groups: 3, members: 2 },
      });
      const yearB = created.body.academicYear.id as string;

      const activation = await request(http())
        .post(`/api/v1/academic-years/${yearB}/activation/preview`)
        .set('x-test-user', admin())
        .expect(200);
      expect(activation.body).toMatchObject({ graduates: { count: 1, studentIds: [IDS.p9a1] }, blocking: false });

      const done = await request(http())
        .post(`/api/v1/academic-years/${yearB}/activation`)
        .set('x-test-user', admin())
        .send({ planHash: activation.body.planHash })
        .expect(200);
      expect(done.body).toEqual({ year: { id: yearB, name: 'Nästa läsår', isActive: true }, moved: 3, graduated: 1, unplaced: 0 });
      expect(world.rows['user']!.find((user) => user['id'] === IDS.p9a1)!['studentGroupId']).toBeNull();
    });

    it('answers a rollover request without the staffing option with fa4a3d6’s planHash, over HTTP (the deploy keeps an open preview executable)', async () => {
      const world = givenRolloverWorld(rolloverRowsAtFa4a3d6());
      prisma.withRls.mockImplementation((_user: unknown, fn: (tx: unknown) => unknown) => fn(world.tx));
      const options = { name: '2027/28', startDate: '2027-08-16', endDate: '2028-06-09' };
      const preview = await request(http()).post(`${base}/rollover/preview`).set('x-test-user', admin()).send(options).expect(200);
      expect(preview.body.planHash).toBe('ad548651574bc2a534bab3564dded501c71d6cb1c549fb935de895e610a0a621');
      const created = await request(http())
        .post(`${base}/rollover`)
        .set('x-test-user', admin())
        .send({ ...options, graduatingGradeLevel: 9, planHash: preview.body.planHash })
        .expect(201);
      expect(created.body.planHash).toBe(preview.body.planHash);
      // Without the field: no staffing in the preview or the result, as before.
      expect(preview.body.staffing).toBeNull();
      expect(created.body.staffing).toBeNull();
    });

    it('carries tjänster and uppdrag when asked, over HTTP: the preview names them, the execute writes them (admin round-trip)', async () => {
      const world = givenRolloverWorld(staffingRows());
      prisma.withRls.mockImplementation((_user: unknown, fn: (tx: unknown) => unknown) => fn(world.tx));
      const options = { name: '2027/28', startDate: '2027-08-16', endDate: '2028-06-09', carryStaffing: true };
      const preview = await request(http()).post(`${base}/rollover/preview`).set('x-test-user', admin()).send(options).expect(200);
      expect(preview.body.blocking).toBe(false);
      expect(preview.body.staffing).toMatchObject({
        employments: { carried: 2, withReduction: [IDS.anna], withTargetOverride: [IDS.cecilia] },
        duties: { carried: 5, slots: 2, relabelled: [expect.objectContaining({ from: 'Mentor 7A', to: 'Mentor 8A' })] },
      });
      expect(preview.body.problems.map((problem: { code: string }) => problem.code)).toEqual(
        expect.arrayContaining(['STAFFING_MENTORSKAP_NOT_CARRIED', 'STAFFING_PER_YEAR_TERMS_CARRIED']),
      );
      expect(preview.body).not.toHaveProperty('writes');
      const created = await request(http())
        .post(`${base}/rollover`)
        .set('x-test-user', admin())
        .send({ ...options, graduatingGradeLevel: 9, planHash: preview.body.planHash })
        .expect(201);
      expect(created.body.staffing).toEqual({ employments: 2, duties: 5, dutySlots: 2 });
      const target = created.body.academicYear.id as string;
      expect(world.rows['teacherDuty']!.filter((row) => row['academicYearId'] === target)).toHaveLength(5);
    });

    it('409s a carry’s hash executed without the option: the option is inside the plan hash', async () => {
      const world = givenRolloverWorld(staffingRows());
      prisma.withRls.mockImplementation((_user: unknown, fn: (tx: unknown) => unknown) => fn(world.tx));
      const options = { name: '2027/28', startDate: '2027-08-16', endDate: '2028-06-09' };
      const preview = await request(http())
        .post(`${base}/rollover/preview`)
        .set('x-test-user', admin())
        .send({ ...options, carryStaffing: true })
        .expect(200);
      const stale = await request(http())
        .post(`${base}/rollover`)
        .set('x-test-user', admin())
        .send({ ...options, graduatingGradeLevel: 9, planHash: preview.body.planHash })
        .expect(409);
      expect(stale.body).toMatchObject({ code: 'ROLLOVER_PREVIEW_STALE' });
      expect(world.rows['academicYear']).toHaveLength(1);
    });

    describe('tjänster carried into a year rolled without them (staffing-rollover)', () => {
      /** 2026/27 with a full staff, rolled to 2027/28 without tjänster, as before Fas 5. */
      const givenRolledWithoutStaffing = async () => {
        const world = givenRolloverWorld(staffingRows());
        prisma.withRls.mockImplementation((_user: unknown, fn: (tx: unknown) => unknown) => fn(world.tx));
        const options = { name: '2027/28', startDate: '2027-08-16', endDate: '2028-06-09' };
        const preview = await request(http()).post(`${base}/rollover/preview`).set('x-test-user', admin()).send(options).expect(200);
        const created = await request(http())
          .post(`${base}/rollover`)
          .set('x-test-user', admin())
          .send({ ...options, graduatingGradeLevel: 9, planHash: preview.body.planHash })
          .expect(201);
        return { world, yearB: created.body.academicYear.id as string };
      };
      const carry = (yearId: string) => `/api/v1/academic-years/${yearId}/staffing-rollover`;
      const asTeacher = (userId: string) => asUser({ role: 'TEACHER' as never, userId });

      it('previews, carries, and a second preview finds everyone already there and carries nothing (admin round-trips)', async () => {
        const { world, yearB } = await givenRolledWithoutStaffing();
        const preview = await request(http()).post(`${carry(yearB)}/preview`).set('x-test-user', admin()).expect(200);
        expect(preview.body).toMatchObject({
          source: { id: IDS.yearA, name: '2026/27' },
          target: { id: yearB, name: '2027/28' },
          blocking: false,
          employments: { carried: 2 },
          duties: { carried: 5, slots: 2 },
        });
        const done = await request(http()).post(carry(yearB)).set('x-test-user', admin()).send({ planHash: preview.body.planHash }).expect(201);
        expect(done.body).toEqual({ targetYearId: yearB, counts: { employments: 2, duties: 5, dutySlots: 2 }, planHash: preview.body.planHash });
        expect(world.rows['teacherEmployment']!.filter((row) => row['academicYearId'] === yearB)).toHaveLength(2);

        const again = await request(http()).post(`${carry(yearB)}/preview`).set('x-test-user', admin()).expect(200);
        expect(again.body.employments.notCarried).toEqual(
          expect.arrayContaining([
            { userId: IDS.anna, reason: 'ALREADY_PRESENT' },
            { userId: IDS.cecilia, reason: 'ALREADY_PRESENT' },
          ]),
        );
        expect(again.body.duties.carried).toBe(0);
        const twice = await request(http()).post(carry(yearB)).set('x-test-user', admin()).send({ planHash: again.body.planHash }).expect(201);
        expect(twice.body.counts).toEqual({ employments: 0, duties: 0, dutySlots: 0 });
      });

      it('409s a stale preview and a year nobody rolled into, 400s a malformed hash, 404s an unknown year', async () => {
        const { world, yearB } = await givenRolledWithoutStaffing();
        const preview = await request(http()).post(`${carry(yearB)}/preview`).set('x-test-user', admin()).expect(200);
        world.rows['teacherDuty']!.find((row) => row['id'] === IDS.dutyAmne)!['minutesPerWeek'] = 55;
        const stale = await request(http()).post(carry(yearB)).set('x-test-user', admin()).send({ planHash: preview.body.planHash }).expect(409);
        expect(stale.body).toMatchObject({ code: 'STAFFING_ROLLOVER_PREVIEW_STALE' });
        expect(world.rows['teacherEmployment']!.filter((row) => row['academicYearId'] === yearB)).toHaveLength(0);

        const never = await request(http()).post(`${carry(IDS.yearA)}/preview`).set('x-test-user', admin()).expect(409);
        expect(never.body).toMatchObject({ code: 'STAFFING_ROLLOVER_NO_PREDECESSOR' });
        const malformed = await request(http()).post(carry(yearB)).set('x-test-user', admin()).send({ planHash: 'nej' }).expect(400);
        expect(JSON.stringify(malformed.body)).toContain('planHash: förhandsvisningens planHash, 64 hexadecimala tecken.');
        await request(http()).post(carry(yearB)).set('x-test-user', admin()).send({ planHash: 'a'.repeat(64), extra: 1 }).expect(400);
        await request(http()).post(`${carry(YEAR_ID)}/preview`).set('x-test-user', admin()).expect(404);
      });

      it('keeps HR data HR for a teacher: 403 on both carry routes and on a colleague’s uppdrag, only their own post and load row in either year', async () => {
        const { yearB } = await givenRolledWithoutStaffing();
        const preview = await request(http()).post(`${carry(yearB)}/preview`).set('x-test-user', admin()).expect(200);
        await request(http()).post(`${carry(yearB)}/preview`).set('x-test-user', asTeacher(IDS.anna)).expect(403);
        await request(http()).post(carry(yearB)).set('x-test-user', asTeacher(IDS.anna)).send({ planHash: preview.body.planHash }).expect(403);
        await request(http()).post(carry(yearB)).set('x-test-user', admin()).send({ planHash: preview.body.planHash }).expect(201);

        await request(http())
          .get(`/api/v1/teacher-duties?academicYearId=${yearB}&userId=${IDS.cecilia}`)
          .set('x-test-user', asTeacher(IDS.anna))
          .expect(403);
        const own = await request(http()).get(`/api/v1/teacher-duties?academicYearId=${yearB}`).set('x-test-user', asTeacher(IDS.anna)).expect(200);
        expect(own.body.map((row: { userId: string }) => row.userId)).toEqual([IDS.anna, IDS.anna]);
        const posts = await request(http()).get(`/api/v1/teacher-employments?academicYearId=${yearB}`).set('x-test-user', asTeacher(IDS.anna)).expect(200);
        expect(posts.body.map((row: { userId: string }) => row.userId)).toEqual([IDS.anna]);
        for (const year of [yearB, IDS.yearA]) {
          const load = await request(http()).get(`/api/v1/staffing/load?academicYearId=${year}`).set('x-test-user', asTeacher(IDS.anna)).expect(200);
          expect({ year, teachers: load.body.teachers.map((row: { userId: string }) => row.userId) }).toEqual({ year, teachers: [IDS.anna] });
          expect(load.body.unstaffedRequirements).toEqual([]);
        }
      });
    });

    it('400s carryStaffing that is not a boolean, naming it, before reading anything', async () => {
      givenSchool(2020);
      const response = await request(http())
        .post(`${base}/rollover/preview`)
        .set('x-test-user', admin())
        .send({ name: 'x', startDate: '2021-08-16', endDate: '2022-06-10', carryStaffing: 'ja' })
        .expect(400);
      expect(JSON.stringify(response.body)).toContain('carryStaffing: true eller false.');
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it.each([
      ['a blank name', { name: '   ' }],
      ['a date that does not exist', { startDate: '2027-02-30' }],
      ['more than 500 groups', { groups: Array.from({ length: 501 }, () => ({ sourceGroupId: GROUP_ID })) }],
      ['an outcome that is not one', { groups: [{ sourceGroupId: GROUP_ID, outcome: 'GRADUATE' }] }],
    ])('400s %s before reading anything', async (_label, change) => {
      givenSchool(2020);
      const response = await request(http())
        .post(`${base}/rollover/preview`)
        .set('x-test-user', admin())
        .send({ name: 'x', startDate: '2021-08-16', endDate: '2022-06-10', ...change })
        .expect(400);
      expect(prisma.withRls).not.toHaveBeenCalled();
      expect(JSON.stringify(response.body)).toMatch(/name|startDate|groups/);
    });

    it('400s an execute without G or with a hash that is not one', async () => {
      const { options } = givenSchool(2020);
      await request(http()).post(`${base}/rollover`).set('x-test-user', admin()).send({ ...options, planHash: 'a'.repeat(64) }).expect(400);
      await request(http())
        .post(`${base}/rollover`)
        .set('x-test-user', admin())
        .send({ ...options, graduatingGradeLevel: 9, planHash: 'not-a-hash' })
        .expect(400);
      await request(http()).post(`${base}/activation`).set('x-test-user', admin()).send({ planHash: 'nope' }).expect(400);
    });

    it.each([
      ['a start before the source ends', (o: Record<string, string>) => ({ ...o, startDate: '2020-01-01' }), 'ROLLOVER_TARGET_DATES'],
      ['PROMOTE on a graduating group', (o: Record<string, string>) => ({ ...o, groups: [{ sourceGroupId: IDS.g9a, outcome: 'PROMOTE' }] }), 'PROMOTE_GRADUATING'],
      ['a name collision', (o: Record<string, string>) => ({ ...o, groups: [{ sourceGroupId: IDS.g9a, outcome: 'CARRY' }] }), 'ROLLOVER_NAME_COLLISION'],
      ['INTAKE on a group that is not the lowest', (o: Record<string, string>) => ({ ...o, groups: [{ sourceGroupId: IDS.g8a, outcome: 'INTAKE' }] }), 'INTAKE_NOT_LOWEST'],
      ['a lov with no dates and no proposal', (o: Record<string, string>) => ({ ...o, breaks: [{ sourceBreakId: IDS.vecka53 }] }), 'BREAK_NEEDS_DATES'],
    ])('400s %s, naming it', async (_label, change, code) => {
      // 2026/27 itself: the week-53 studiedag only has no proposal there.
      const { options } = givenSchool(2026);
      const response = await roll(change(options), 400);
      expect(response.body).toMatchObject({ code });
    });

    it('404s a year the caller cannot see', async () => {
      givenSchool(2020);
      await request(http())
        .post(`/api/v1/academic-years/${YEAR_ID}/rollover/preview`)
        .set('x-test-user', admin())
        .send({ name: 'x', startDate: '2021-08-16', endDate: '2022-06-10' })
        .expect(404);
      await request(http()).post(`/api/v1/academic-years/${YEAR_ID}/activation/preview`).set('x-test-user', admin()).expect(404);
    });

    it('409s a second rollover of a year, naming the successor', async () => {
      const { options } = givenSchool(2020);
      await roll(options, 201);
      const again = await request(http())
        .post(`${base}/rollover/preview`)
        .set('x-test-user', admin())
        .send({ ...options, name: 'Ett till' })
        .expect(409);
      expect(again.body).toMatchObject({ code: 'YEAR_HAS_SUCCESSOR' });
      expect(JSON.stringify(again.body)).toContain('har redan rullats vidare till Nästa läsår');
    });

    it('409s a stale preview, and writes nothing', async () => {
      const { world, options } = givenSchool(2020);
      const preview = await request(http()).post(`${base}/rollover/preview`).set('x-test-user', admin()).send(options).expect(200);
      world.rows['teachingRequirement']![0]!['lessonsPerWeek'] = 5;
      const before = world.rows['academicYear']!.length;
      const stale = await request(http())
        .post(`${base}/rollover`)
        .set('x-test-user', admin())
        .send({ ...options, graduatingGradeLevel: 9, planHash: preview.body.planHash })
        .expect(409);
      expect(stale.body).toMatchObject({ code: 'ROLLOVER_PREVIEW_STALE' });
      expect(world.rows['academicYear']).toHaveLength(before);
    });

    it('409s rolling a year whose pupils have not moved in, and activating one whose old year still runs', async () => {
      // A year that ends far in the future: always too early to activate its successor.
      const { options } = givenSchool(2098);
      const created = await roll(options, 201);
      const yearB = created.body.academicYear.id as string;

      const notYet = await request(http())
        .post(`/api/v1/academic-years/${yearB}/rollover/preview`)
        .set('x-test-user', admin())
        .send({ name: 'Året därpå', startDate: '2100-08-16', endDate: '2101-06-10' })
        .expect(409);
      expect(notYet.body).toMatchObject({ code: 'ROLLOVER_SOURCE_NOT_ACTIVATED' });

      const preview = await request(http())
        .post(`/api/v1/academic-years/${yearB}/activation/preview`)
        .set('x-test-user', admin())
        .expect(200);
      expect(preview.body.problems).toEqual([expect.objectContaining({ code: 'YEAR_ACTIVATION_TOO_EARLY' })]);
      const early = await request(http())
        .post(`/api/v1/academic-years/${yearB}/activation`)
        .set('x-test-user', admin())
        .send({ planHash: preview.body.planHash })
        .expect(409);
      expect(early.body).toMatchObject({ code: 'YEAR_ACTIVATION_TOO_EARLY' });
    });

    it('409s activating the old year again once its successor holds the pupils', async () => {
      const { options } = givenSchool(2020);
      const created = await roll(options, 201);
      const yearB = created.body.academicYear.id as string;
      const preview = await request(http()).post(`/api/v1/academic-years/${yearB}/activation/preview`).set('x-test-user', admin()).expect(200);
      await request(http()).post(`/api/v1/academic-years/${yearB}/activation`).set('x-test-user', admin()).send({ planHash: preview.body.planHash }).expect(200);

      const back = await request(http()).post(`${base}/activation/preview`).set('x-test-user', admin()).expect(200);
      const refused = await request(http())
        .post(`${base}/activation`)
        .set('x-test-user', admin())
        .send({ planHash: back.body.planHash })
        .expect(409);
      expect(refused.body).toMatchObject({ code: 'YEAR_IS_SUPERSEDED' });
      // And through the year form's own PATCH.
      const patched = await request(http()).patch(base).set('x-test-user', admin()).send({ isActive: true }).expect(409);
      expect(patched.body).toMatchObject({ code: 'YEAR_IS_SUPERSEDED' });
    });

    /** Preview and execute the activation of `yearId`. */
    const activate = async (yearId: string) => {
      const preview = await request(http()).post(`/api/v1/academic-years/${yearId}/activation/preview`).set('x-test-user', admin()).expect(200);
      return request(http())
        .post(`/api/v1/academic-years/${yearId}/activation`)
        .set('x-test-user', admin())
        .send({ planHash: preview.body.planHash })
        .expect(200);
    };

    it('409s an activation whose pupils changed class after the preview, moving nobody', async () => {
      const { world, options } = givenSchool(2020);
      const yearB = (await roll(options, 201)).body.academicYear.id as string;
      const preview = await request(http()).post(`/api/v1/academic-years/${yearB}/activation/preview`).set('x-test-user', admin()).expect(200);
      world.rows['user']!.find((user) => user['id'] === IDS.p7a2)!['studentGroupId'] = IDS.g8a;
      const stale = await request(http())
        .post(`/api/v1/academic-years/${yearB}/activation`)
        .set('x-test-user', admin())
        .send({ planHash: preview.body.planHash })
        .expect(409);
      expect(stale.body).toMatchObject({ code: 'ACTIVATION_PREVIEW_STALE' });
      expect(world.rows['user']!.find((user) => user['id'] === IDS.p7a1)!['studentGroupId']).toBe(IDS.g7a);
      expect(world.rows['academicYear']!.find((year) => year['id'] === yearB)!['isActive']).toBe(false);
    });

    it('409s a year two links back once a later year holds the pupils', async () => {
      const { options } = givenSchool(2020);
      const yearB = (await roll(options, 201)).body.academicYear.id as string;
      await activate(yearB);
      const created = await request(http())
        .post(`/api/v1/academic-years/${yearB}/rollover/preview`)
        .set('x-test-user', admin())
        .send({ name: 'Tredje läsåret', startDate: '2022-08-15', endDate: '2023-06-09', graduatingGradeLevel: 9 })
        .expect(200);
      const yearC = (
        await request(http())
          .post(`/api/v1/academic-years/${yearB}/rollover`)
          .set('x-test-user', admin())
          .send({ name: 'Tredje läsåret', startDate: '2022-08-15', endDate: '2023-06-09', graduatingGradeLevel: 9, planHash: created.body.planHash })
          .expect(201)
      ).body.academicYear.id as string;
      await activate(yearC);

      // A → B → C with everyone in C: A is superseded although B is empty.
      const patched = await request(http()).patch(base).set('x-test-user', admin()).send({ isActive: true }).expect(409);
      expect(patched.body).toMatchObject({ code: 'YEAR_IS_SUPERSEDED', params: { successor: 'Tredje läsåret' } });

    });

    it('409s rolling an active year whose straggler is still in last year’s class, naming it as such, until its own activation moves them', async () => {
      const { world, options } = givenSchool(2020);
      const yearB = (await roll(options, 201)).body.academicYear.id as string;
      await activate(yearB);
      // The pupil on leave at the activation returns, still in A's 7A.
      world.rows['user']!.find((user) => user['id'] === IDS.pGone)!['isActive'] = true;
      const next = { name: 'Tredje läsåret', startDate: '2022-08-15', endDate: '2023-06-09', graduatingGradeLevel: 9 };
      const straggling = await request(http())
        .post(`/api/v1/academic-years/${yearB}/rollover/preview`)
        .set('x-test-user', admin())
        .send(next)
        .expect(409);
      expect(straggling.body).toMatchObject({ code: 'ROLLOVER_SOURCE_HAS_STRAGGLERS', params: { year: 'Nästa läsår', pupils: 1 } });
      const preview = await request(http()).post(`/api/v1/academic-years/${yearB}/activation/preview`).set('x-test-user', admin()).expect(200);
      expect(preview.body.moves).toEqual([expect.objectContaining({ count: 1, studentIds: [IDS.pGone] })]);
      expect((await activate(yearB)).body).toMatchObject({ moved: 1 });
      await request(http()).post(`/api/v1/academic-years/${yearB}/rollover/preview`).set('x-test-user', admin()).send(next).expect(200);
    });

    it('generates, proposes rooms and judges a hand-placed lesson for a rolled year whose pupils have not moved in, on its projected rosters', async () => {
      const { world, options } = givenSchool(2098);
      const yearB = (await roll(options, 201)).body.academicYear.id as string;
      const started = await request(http())
        .post('/api/v1/optimization/jobs')
        .set('x-test-user', admin())
        .send({ academicYearId: yearB })
        .expect(202);
      // The job runs after the answer: wait for it to finish, on this world.
      const job = () => world.rows['optimizationJob']?.find((row) => row['id'] === started.body.jobId);
      for (let tick = 0; tick < 500 && !['SUCCEEDED', 'FAILED'].includes(job()?.['status'] as string); tick++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(harness.http.post).toHaveBeenCalledTimes(1);
      // Finished: the stub answers with no lessons, which the job records as a
      // failed run and leaves the timetable alone. What it was sent is the point.
      expect(job()?.['status']).toBe('FAILED');
      const [, payload] = harness.http.post.mock.calls[0] as [string, AiEngineScheduleRequest];
      // B's 8A seats 7A's two active pupils, 9A 8A's one; Ma8 (p7a1 and p8a1,
      // carried) clashes with both, and the hall seats three.
      const sizes = payload.requirements.map((row) => row.studentGroupSize).sort();
      expect(sizes).toEqual(expect.arrayContaining([2, 1]));
      expect(sizes).not.toContain(0);
      expect(payload.groupConflicts).toHaveLength(2);
      expect(payload.groups.map((group) => group.lunchHeadcount).sort()).toEqual([1, 2]);
      await request(http())
        .post('/api/v1/optimization/rooms/proposal')
        .set('x-test-user', admin())
        .send({ academicYearId: yearB, walkers: 'BOTH' })
        .expect(200);
      // A lesson placed by hand for B's 8A at Ma8's hour: they will share
      // p7a1, so it is a pupil clash now, as it will be after the activation.
      const inB = (name: string) =>
        world.rows['studentGroup']!.find((group) => group['academicYearId'] === yearB && group['name'] === name)!['id'] as string;
      world.rows['masterLesson']!.push({
        id: 'f3000000-0000-4000-8000-0000000000e1',
        academicYearId: yearB,
        subjectId: IDS.ma,
        studentGroupId: inB('Ma8 grupp 1'),
        teacherId: null,
        coTeacherId: null,
        roomId: null,
        dayOfWeek: 1,
        startTime: wallClock('08:00'),
        endTime: wallClock('09:00'),
        isLocked: true,
        isGenerated: false,
        isParked: false,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        subject: { name: 'Matematik' },
        extraGroups: [],
        participants: [],
      });
      const lesson = await request(http())
        .post('/api/v1/master-lessons')
        .set('x-test-user', admin())
        .send({ academicYearId: yearB, subjectId: IDS.sv, studentGroupId: inB('8A'), dayOfWeek: 1, startTime: '08:00', endTime: '09:00' })
        .expect(409);
      expect(JSON.stringify(lesson.body)).toContain('Students of this group already have Matematik in this slot.');
      // The active year itself is never refused for it.
      await request(http())
        .post('/api/v1/optimization/rooms/proposal')
        .set('x-test-user', admin())
        .send({ academicYearId: IDS.yearA, walkers: 'BOTH' })
        .expect((response) => expect(response.body?.code).not.toBe('ROLLOVER_NOT_ACTIVATED'));
    });

    it('generates a split timplanspost as one engine entry with its lengths, and stamps each lesson at its own length (admin round-trip)', async () => {
      const { world } = givenSchool(2098);
      // 7A's Matematik as 1 × 80 + 1 × 40; every other row stays uniform.
      const ma7 = world.rows['teachingRequirement']!.find(
        (row) => row['studentGroupId'] === IDS.g7a && row['subjectId'] === IDS.ma,
      )!;
      Object.assign(ma7, { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] });
      const clock = (minutes: number): string =>
        `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
      // The engine as it now answers: every lesson at the length it was sent.
      harness.http.post.mockImplementationOnce((_url: string, payload: AiEngineScheduleRequest) =>
        of({
          data: {
            requestId: payload.requestId,
            status: 'OPTIMAL',
            lessons: payload.requirements.flatMap((row, r) =>
              (row.lessonLengths ?? Array.from({ length: row.lessonsPerWeek }, () => row.minutesPerLesson)).map(
                (minutes, i) => ({
                  requirementId: row.id,
                  roomId: payload.rooms[0]?.id ?? null,
                  dayOfWeek: 1 + ((r + i) % 5),
                  startTime: clock(480 + 90 * r),
                  endTime: clock(480 + 90 * r + minutes),
                }),
              ),
            ),
            conflicts: null,
          },
        }),
      );

      const started = await request(http())
        .post('/api/v1/optimization/jobs')
        .set('x-test-user', admin())
        .send({ academicYearId: IDS.yearA })
        .expect(202);
      const job = () => world.rows['optimizationJob']?.find((row) => row['id'] === started.body.jobId);
      for (let tick = 0; tick < 500 && !['SUCCEEDED', 'FAILED'].includes(job()?.['status'] as string); tick++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(job()?.['status']).toBe('SUCCEEDED');

      const [, payload] = harness.http.post.mock.calls[0] as [string, AiEngineScheduleRequest];
      const split = payload.requirements.filter((row) => row.lessonLengths !== undefined);
      expect(split).toEqual([expect.objectContaining({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] })]);
      // Every other entry is the uniform one it always was: no list key.
      expect(payload.requirements.filter((row) => 'lessonLengths' in row)).toHaveLength(1);

      const stamped = world.rows['masterLesson']!
        .filter((row) => row['isGenerated'] && row['studentGroupId'] === IDS.g7a && row['subjectId'] === IDS.ma)
        .map((row) => ((row['endTime'] as Date).getTime() - (row['startTime'] as Date).getTime()) / 60_000)
        .sort((a, b) => b - a);
      expect(stamped).toEqual([80, 40]);
    });

    it('answers GET rosters with the projection before the activation and CURRENT after it, stores the projected lunch headcount, and keeps a room proposal’s basis across the activation (admin round-trips)', async () => {
      const { world, options } = givenSchool(2020);
      const yearB = (await roll(options, 201)).body.academicYear.id as string;
      const inB = (name: string) =>
        world.rows['studentGroup']!.find((group) => group['academicYearId'] === yearB && group['name'] === name)!['id'] as string;
      const rosters = `/api/v1/academic-years/${yearB}/rosters`;

      const projected = await request(http()).get(rosters).set('x-test-user', admin()).expect(200);
      expect(projected.body).toEqual({
        academicYearId: yearB,
        basis: 'PROJECTED',
        homeClasses: [
          { studentId: IDS.p7a1, studentGroupId: inB('8A') },
          { studentId: IDS.p7a2, studentGroupId: inB('8A') },
          { studentId: IDS.p8a1, studentGroupId: inB('9A') },
          { studentId: IDS.p9a1, studentGroupId: null },
        ],
        counts: { moved: 3, graduates: 1, unplaced: 0 },
        membershipsOutOfDate: { missing: 0, stale: 0 },
      });

      // A meal placed by hand for B's 8A seats its two coming pupils.
      world.rows['lunchSetting'] = [{ schoolId: IDS.school, lunchEnabled: true, lunchMinutes: 30 }];
      const meal = await request(http())
        .post('/api/v1/lunch-sittings')
        .set('x-test-user', admin())
        .send({ academicYearId: yearB, studentGroupId: inB('8A'), dayOfWeek: 1, startTime: '11:00' })
        .expect(201);
      expect(meal.body).toMatchObject({ headcount: 2 });

      const proposal = async () =>
        (
          await request(http())
            .post('/api/v1/optimization/rooms/proposal')
            .set('x-test-user', admin())
            .send({ academicYearId: yearB, walkers: 'BOTH' })
            .expect(200)
        ).body.basis as string;
      const spring = await proposal();

      await activate(yearB);
      const current = await request(http()).get(rosters).set('x-test-user', admin()).expect(200);
      expect(current.body).toEqual({
        academicYearId: yearB,
        basis: 'CURRENT',
        homeClasses: [],
        counts: { moved: 0, graduates: 0, unplaced: 0 },
        membershipsOutOfDate: { missing: 0, stale: 0 },
      });
      // What the projection said is what the activation did.
      for (const { studentId, studentGroupId } of projected.body.homeClasses as { studentId: string; studentGroupId: string | null }[]) {
        expect(world.rows['user']!.find((user) => user['id'] === studentId)!['studentGroupId']).toBe(studentGroupId);
      }
      // A proposal made in spring would apply now: the basis is the same.
      expect(await proposal()).toBe(spring);
      // And the active year A — superseded now — reads its own rows.
      await request(http()).get(`/api/v1/academic-years/${IDS.yearA}/rosters`).set('x-test-user', admin()).expect(200);
    });

    it('judges a PATCH that drags a rolled year’s lesson onto a pupil clash on the projected rosters, the same 409 before the activation as after it (admin round-trips)', async () => {
      const { world, options } = givenSchool(2020);
      const yearB = (await roll(options, 201)).body.academicYear.id as string;
      const inB = (name: string) =>
        world.rows['studentGroup']!.find((group) => group['academicYearId'] === yearB && group['name'] === name)!['id'] as string;
      const lesson = (id: string, academicYearId: string, studentGroupId: string, dayOfWeek: number, subjectId: string, name: string): Row => ({
        id,
        schoolId: IDS.school,
        // The school the PATCH joins, with its count of the lesson's year.
        school: { id: IDS.school, timezone: 'Europe/Stockholm' },
        academicYearId,
        subjectId,
        studentGroupId,
        teacherId: null,
        coTeacherId: null,
        roomId: null,
        dayOfWeek,
        startTime: wallClock('08:00'),
        endTime: wallClock('09:00'),
        isLocked: false,
        isGenerated: false,
        isParked: false,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        subject: { name },
        extraGroups: [],
        participants: [],
      });
      const dragged = 'f3000000-0000-4000-8000-0000000000e2';
      world.rows['masterLesson']!.push(
        // Ma8 (carried with p7a1, who is coming to 8A) on Monday at 08:00.
        lesson('f3000000-0000-4000-8000-0000000000e1', yearB, inB('Ma8 grupp 1'), 1, IDS.ma, 'Matematik'),
        // 8A's svenska on Tuesday, dragged onto Monday below.
        lesson(dragged, yearB, inB('8A'), 2, IDS.sv, 'Svenska'),
      );
      const drag = (id: string, dayOfWeek: number) =>
        request(http()).patch(`/api/v1/master-lessons/${id}`).set('x-test-user', admin()).send({ dayOfWeek });

      // Before the activation: 8A's coming pupils meet Ma8's p7a1.
      const spring = await drag(dragged, 1).expect(409);
      expect(JSON.stringify(spring.body)).toContain('Students of this group already have Matematik in this slot.');
      // Where nobody is, it lands, and goes back.
      await drag(dragged, 4).expect(200);
      await drag(dragged, 2).expect(200);

      await activate(yearB);
      const autumn = await drag(dragged, 1).expect(409);
      expect(autumn.body.detail ?? autumn.body.message).toBe(spring.body.detail ?? spring.body.message);
    });

    it('409s a PATCH of a lesson in a year two steps ahead (R6), naming the predecessor', async () => {
      const { world, options } = givenSchool(2020);
      const yearB = (await roll(options, 201)).body.academicYear.id as string;
      const yearC = 'a0000000-0000-4000-8000-0000000000cc';
      world.rows['academicYear']!.push({
        id: yearC,
        schoolId: IDS.school,
        name: 'Tredje läsåret',
        startDate: new Date('2022-08-15T00:00:00Z'),
        endDate: new Date('2023-06-09T00:00:00Z'),
        isActive: false,
        predecessorId: yearB,
        graduatingGradeLevel: 9,
      });
      const b8a = world.rows['studentGroup']!.find((group) => group['academicYearId'] === yearB && group['name'] === '8A')!;
      const c9a = 'b0000000-0000-4000-8000-0000000000c9';
      world.rows['studentGroup']!.push({ id: c9a, academicYearId: yearC, name: '9A', kind: 'CLASS', gradeLevel: 9, predecessorId: b8a['id'] });
      const inC = 'f3000000-0000-4000-8000-0000000000e3';
      world.rows['masterLesson']!.push({
        id: inC,
        schoolId: IDS.school,
        school: { id: IDS.school, timezone: 'Europe/Stockholm' },
        academicYearId: yearC,
        subjectId: IDS.ma,
        studentGroupId: c9a,
        teacherId: null,
        coTeacherId: null,
        roomId: null,
        dayOfWeek: 1,
        startTime: wallClock('08:00'),
        endTime: wallClock('09:00'),
        isLocked: false,
        isGenerated: false,
        isParked: false,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        subject: { name: 'Matematik' },
        extraGroups: [],
        participants: [],
      });
      const refused = await request(http())
        .patch(`/api/v1/master-lessons/${inC}`)
        .set('x-test-user', admin())
        .send({ dayOfWeek: 2 })
        .expect(409);
      expect(refused.body).toMatchObject({ code: 'ROLLOVER_NOT_ACTIVATED', params: { year: 'Tredje läsåret', predecessor: 'Nästa läsår' } });
      expect(world.rows['masterLesson']!.find((row) => row['id'] === inC)!['dayOfWeek']).toBe(1);
    });

    it('409s every roster reader of a year whose predecessor is not activated (R6), naming the predecessor, and 404s GET rosters for a year RLS hides', async () => {
      const { world, options } = givenSchool(2020);
      const yearB = (await roll(options, 201)).body.academicYear.id as string;
      // C, inserted through PostgREST with B as its predecessor (the API
      // refuses to roll B while its pupils wait to move).
      const yearC = 'a0000000-0000-4000-8000-0000000000cc';
      world.rows['academicYear']!.push({
        id: yearC,
        schoolId: IDS.school,
        name: 'Tredje läsåret',
        startDate: new Date('2022-08-15T00:00:00Z'),
        endDate: new Date('2023-06-09T00:00:00Z'),
        isActive: false,
        predecessorId: yearB,
        graduatingGradeLevel: 9,
      });
      const b8a = world.rows['studentGroup']!.find((group) => group['academicYearId'] === yearB && group['name'] === '8A')!;
      world.rows['studentGroup']!.push({ id: 'b0000000-0000-4000-8000-0000000000c9', academicYearId: yearC, name: '9A', kind: 'CLASS', gradeLevel: 9, predecessorId: b8a['id'] });
      const refused = { code: 'ROLLOVER_NOT_ACTIVATED', params: { year: 'Tredje läsåret', predecessor: 'Nästa läsår' } };

      const job = await request(http()).post('/api/v1/optimization/jobs').set('x-test-user', admin()).send({ academicYearId: yearC }).expect(409);
      expect(job.body).toMatchObject(refused);
      const rooms = await request(http())
        .post('/api/v1/optimization/rooms/proposal')
        .set('x-test-user', admin())
        .send({ academicYearId: yearC, walkers: 'BOTH' })
        .expect(409);
      expect(rooms.body).toMatchObject(refused);
      const lesson = await request(http())
        .post('/api/v1/master-lessons')
        .set('x-test-user', admin())
        .send({ academicYearId: yearC, subjectId: IDS.ma, studentGroupId: 'b0000000-0000-4000-8000-0000000000c9', dayOfWeek: 1, startTime: '08:00', endTime: '09:00' })
        .expect(409);
      expect(lesson.body).toMatchObject(refused);
      const listed = await request(http()).get(`/api/v1/academic-years/${yearC}/rosters`).set('x-test-user', admin()).expect(409);
      expect(listed.body).toMatchObject(refused);
      // Not only the sites that refused before the projection: every reader
      // of C's class lists answers the same, the reports and the staffing
      // checks too (roster-readers.inventory.spec.ts names the routes).
      // A timplanspost of C's 9A, so the load report has a group to span.
      const c9aRequirement = { ...world.rows['teachingRequirement']![0]!, id: '00000000-0000-4000-8000-0000000000c1', academicYearId: yearC, studentGroupId: 'b0000000-0000-4000-8000-0000000000c9' };
      world.rows['teachingRequirement']!.push(c9aRequirement);
      const teacher = asUser({ role: 'TEACHER' as never });
      for (const [who, user] of [['admin', admin()], ['teacher', teacher]] as const) {
        const load = await request(http()).get(`/api/v1/staffing/load?academicYearId=${yearC}`).set('x-test-user', user).expect(409);
        expect([who, load.body]).toMatchObject([who, refused]);
        const coverage = await request(http()).get(`/api/v1/timplan-coverage?academicYearId=${yearC}`).set('x-test-user', user).expect(409);
        expect([who, coverage.body]).toMatchObject([who, refused]);
      }
      world.rows['lunchSetting'] = [{ schoolId: IDS.school, lunchEnabled: true, lunchMinutes: 30 }];
      const meal = await request(http())
        .post('/api/v1/lunch-sittings')
        .set('x-test-user', admin())
        .send({ academicYearId: yearC, studentGroupId: 'b0000000-0000-4000-8000-0000000000c9', dayOfWeek: 1, startTime: '11:00' })
        .expect(409);
      expect(meal.body).toMatchObject(refused);
      const requirement = await request(http())
        .post('/api/v1/teaching-requirements')
        .set('x-test-user', admin())
        .send({ academicYearId: yearC, subjectId: IDS.ma, studentGroupId: 'b0000000-0000-4000-8000-0000000000c9', teacherId: IDS.anna, lessonsPerWeek: 2, minutesPerLesson: 60 })
        .expect(409);
      expect(requirement.body).toMatchObject(refused);
      // B itself, the active year's successor, is not refused.
      await request(http()).get(`/api/v1/academic-years/${yearB}/rosters`).set('x-test-user', admin()).expect(200);

      await request(http()).get(`/api/v1/academic-years/${YEAR_ID}/rosters`).set('x-test-user', admin()).expect(404);
    });

    it('409s the rolled year’s readers once the school has no active year (R6), naming the year to activate again', async () => {
      const { options } = givenSchool(2020);
      const yearB = (await roll(options, 201)).body.academicYear.id as string;
      // The year form has no guard against switching the active year off.
      await request(http()).patch(`/api/v1/academic-years/${IDS.yearA}`).set('x-test-user', admin()).send({ isActive: false }).expect(200);
      const refused = { code: 'ROLLOVER_NOT_ACTIVATED', params: { year: 'Nästa läsår', predecessor: '2026/27' } };
      const load = await request(http()).get(`/api/v1/staffing/load?academicYearId=${yearB}`).set('x-test-user', admin()).expect(409);
      expect(load.body).toMatchObject(refused);
      const listed = await request(http()).get(`/api/v1/academic-years/${yearB}/rosters`).set('x-test-user', admin()).expect(409);
      expect(listed.body).toMatchObject(refused);
      // A itself, with no predecessor (R2), still reads its own rows.
      const own = await request(http()).get(`/api/v1/academic-years/${IDS.yearA}/rosters`).set('x-test-user', admin()).expect(200);
      expect(own.body).toMatchObject({ basis: 'CURRENT', homeClasses: [] });
    });

    it('stops a student at the guard on GET rosters', async () => {
      await request(http())
        .get(`/api/v1/academic-years/${YEAR_ID}/rosters`)
        .set('x-test-user', asUser({ role: 'STUDENT' as never }))
        .expect(403);
    });

    it('409s PATCH {isActive: true} while pupils wait to move, and DELETE of a year that holds home classes', async () => {
      const { world, options } = givenSchool(2020);
      const created = await roll(options, 201);
      const yearB = created.body.academicYear.id as string;

      const patched = await request(http())
        .patch(`/api/v1/academic-years/${yearB}`)
        .set('x-test-user', admin())
        .send({ isActive: true })
        .expect(409);
      expect(patched.body).toMatchObject({ code: 'YEAR_ACTIVATION_HAS_MOVES', params: { pupils: 4 } });
      expect(world.rows['academicYear']!.find((year) => year['id'] === yearB)!['isActive']).toBe(false);

      const removed = await request(http()).delete(base).set('x-test-user', admin()).expect(409);
      expect(removed.body).toMatchObject({ code: 'YEAR_HAS_HOME_PUPILS' });
      expect(world.rows['academicYear']!.some((year) => year['id'] === IDS.yearA)).toBe(true);
    });

    it('carries timplan per årskurs by cohort, and the new year’s rows are read and replaced through GET/PUT timplans', async () => {
      const { world, rows, options } = givenSchool(2020);
      const decidedId = 'f2000000-0000-4000-8000-0000000000d1';
      rows['localTimplan']!.push({
        id: decidedId,
        name: 'Grundskola 2024',
        schoolForm: 'GRUNDSKOLA',
        status: 'DECIDED',
        decidedAt: new Date('2024-05-01T00:00:00Z'),
        createdAt: new Date('2024-04-01T00:00:00Z'),
        nationalVersion: GRUNDSKOLA_2024,
        entries: [],
      });

      const preview = await request(http()).post(`${base}/rollover/preview`).set('x-test-user', admin()).send(options).expect(200);
      expect(preview.body.timplans).toEqual([
        expect.objectContaining({ gradeLevel: 7, reason: 'DEFAULT', planName: 'Grundskola 2024', planStatus: 'DECIDED' }),
        expect.objectContaining({ gradeLevel: 8, reason: 'CARRIED', fromGradeLevel: 7, planStatus: 'DRAFT' }),
        expect.objectContaining({ gradeLevel: 9, reason: 'CARRIED', fromGradeLevel: 8, planStatus: 'DRAFT' }),
      ]);
      const created = await request(http())
        .post(`${base}/rollover`)
        .set('x-test-user', admin())
        .send({ ...options, graduatingGradeLevel: 9, planHash: preview.body.planHash })
        .expect(201);
      expect(created.body.counts).toMatchObject({ timplans: 3 });
      const successor = `/api/v1/academic-years/${created.body.academicYear.id}/timplans`;

      const read = await request(http()).get(successor).set('x-test-user', admin()).expect(200);
      expect(read.body).toEqual([
        { gradeLevel: 7, localTimplanId: decidedId, planName: 'Grundskola 2024', planStatus: 'DECIDED' },
        { gradeLevel: 8, localTimplanId: IDS.draftPlan, planName: 'Utkast 2027', planStatus: 'DRAFT' },
        { gradeLevel: 9, localTimplanId: IDS.draftPlan, planName: 'Utkast 2027', planStatus: 'DRAFT' },
      ]);

      // The admin decides åk 8 should follow the decided plan after all, and drops åk 9.
      const replaced = await request(http())
        .put(successor)
        .set('x-test-user', admin())
        .send({
          timplans: [
            { gradeLevel: 7, localTimplanId: decidedId },
            { gradeLevel: 8, localTimplanId: decidedId },
            { gradeLevel: 9, localTimplanId: null },
          ],
        })
        .expect(200);
      expect(replaced.body.map((row: { gradeLevel: number; planName: string }) => [row.gradeLevel, row.planName])).toEqual([
        [7, 'Grundskola 2024'],
        [8, 'Grundskola 2024'],
      ]);
      const again = await request(http()).get(successor).set('x-test-user', admin()).expect(200);
      expect(again.body).toEqual(replaced.body);
      // The source year's mapping is the cohort's record and did not move.
      expect(world.rows['academicYearTimplan']!.filter((row) => row['academicYearId'] === IDS.yearA)).toHaveLength(3);
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
      // Läsårsrullning: a whole year written at once, and every pupil moved.
      ['POST', `/api/v1/academic-years/${YEAR_ID}/rollover/preview`],
      ['POST', `/api/v1/academic-years/${YEAR_ID}/rollover`],
      ['POST', `/api/v1/academic-years/${YEAR_ID}/activation/preview`],
      ['POST', `/api/v1/academic-years/${YEAR_ID}/activation`],
      // Tjänster carried into a rolled year: every teacher's post, the admin's.
      ['POST', `/api/v1/academic-years/${YEAR_ID}/staffing-rollover/preview`],
      ['POST', `/api/v1/academic-years/${YEAR_ID}/staffing-rollover`],
      // Next year's class lists, pupil by pupil: the admin's.
      ['GET', `/api/v1/academic-years/${YEAR_ID}/rosters`],
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
