import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';
import { forgetStaffingWorld } from './utils/staffing-world';

/**
 * Generation and day-to-day schedule editing over HTTP: optimization jobs,
 * master lessons, single-lesson actions and version snapshots.
 *
 * The solver call itself is stubbed (HttpService); what is under test is the
 * boundary in front of it — that a query parameter the UI sends is parsed,
 * that a lesson action reaches the right handler, and that only an admin can
 * regenerate or restore a school's timetable.
 */

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const LESSON_ID = '55555555-5555-4555-8555-555555555555';
const VERSION_ID = '66666666-6666-4666-8666-666666666666';
const TEACHER_ID = '77777777-7777-4777-8777-777777777777';
const SUBJECT_ID = '99999999-9999-4999-8999-999999999999';
const GROUP_ID = '88888888-8888-4888-8888-888888888888';

/** A calendar lesson shaped as the services select it. */
const lessonRow = (overrides: Record<string, unknown> = {}) => ({
  id: LESSON_ID,
  schoolId: '33333333-3333-4333-8333-333333333333',
  status: 'SCHEDULED',
  note: null,
  date: new Date('2026-08-17T00:00:00.000Z'),
  startsAt: new Date('2026-08-17T06:20:00.000Z'),
  endsAt: new Date('2026-08-17T07:20:00.000Z'),
  roomId: null,
  subjectId: SUBJECT_ID,
  studentGroupId: GROUP_ID,
  subject: { name: 'Matematik' },
  teachers: [{ teacherId: TEACHER_ID }],
  ...overrides,
});

describe('Scheduling surface (e2e)', () => {
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

  describe('optimization jobs', () => {
    it('accepts a run with 202 and hands back a job id to poll', async () => {
      harness.tx['optimizationJob']!['create']!.mockResolvedValue({
        id: VERSION_ID,
      });

      const response = await request(http())
        .post('/api/v1/optimization/jobs')
        .set('x-test-user', admin())
        .send({
          academicYearId: YEAR_ID,
          weights: { spread: 10, teacherGap: 5 },
          rules: { lunchStartTime: '11:00:00' },
        })
        .expect(202);

      expect(response.body).toHaveProperty('jobId');
    });

    it('rejects an objective weight outside the accepted range', async () => {
      await request(http())
        .post('/api/v1/optimization/jobs')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, weights: { spread: 5000 } })
        .expect(400);
    });

    it('rejects an unknown key inside a nested weights object', async () => {
      // Nested whitelisting is easy to lose: @ValidateNested without the
      // global whitelist reaching into it would let this through silently.
      await request(http())
        .post('/api/v1/optimization/jobs')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, weights: { chaos: 10 } })
        .expect(400);
    });

    it('400s when the year query parameter is missing from the history list', async () => {
      await request(http())
        .get('/api/v1/optimization/jobs')
        .set('x-test-user', admin())
        .expect(400);
    });

    it('lists the run history for a year', async () => {
      harness.tx['optimizationJob']!['findMany']!.mockResolvedValue([]);

      await request(http())
        .get(`/api/v1/optimization/jobs?academicYearId=${YEAR_ID}`)
        .set('x-test-user', admin())
        .expect(200);
    });

    it('404s a job id that is not visible to the caller', async () => {
      harness.tx['optimizationJob']!['findUnique']!.mockResolvedValue(null);

      await request(http())
        .get(`/api/v1/optimization/jobs/${VERSION_ID}`)
        .set('x-test-user', admin())
        .expect(404);
    });

    it('denies a teacher starting a run', async () => {
      await request(http())
        .post('/api/v1/optimization/jobs')
        .set('x-test-user', asUser({ role: 'TEACHER' as never }))
        .send({ academicYearId: YEAR_ID })
        .expect(403);
    });
  });

  describe('master lessons', () => {
    it('creates a manually placed lesson', async () => {
      harness.tx['academicYear']!['findUnique']!.mockResolvedValue({
        id: YEAR_ID,
        schoolId: '33333333-3333-4333-8333-333333333333',
      });
      harness.tx['masterLesson']!['findMany']!.mockResolvedValue([]);
      harness.tx['studentGroupMember']!['findMany']!.mockResolvedValue([]);
      harness.tx['masterLesson']!['create']!.mockResolvedValue({
        id: LESSON_ID,
        academicYearId: YEAR_ID,
        subjectId: SUBJECT_ID,
        studentGroupId: GROUP_ID,
        teacherId: TEACHER_ID,
        coTeacherId: null,
        roomId: null,
        dayOfWeek: 2,
        startTime: new Date('1970-01-01T08:20:00.000Z'),
        endTime: new Date('1970-01-01T09:20:00.000Z'),
        isLocked: true,
        extraGroups: [],
        participants: [],
      });

      await request(http())
        .post('/api/v1/master-lessons')
        .set('x-test-user', admin())
        .send({
          academicYearId: YEAR_ID,
          subjectId: SUBJECT_ID,
          studentGroupId: GROUP_ID,
          teacherId: TEACHER_ID,
          dayOfWeek: 2,
          startTime: '08:20',
          endTime: '09:20',
          isLocked: true,
        })
        .expect(201);
    });

    it('rejects a time that is not HH:MM, naming the field', async () => {
      const response = await request(http())
        .post('/api/v1/master-lessons')
        .set('x-test-user', admin())
        .send({
          academicYearId: YEAR_ID,
          subjectId: SUBJECT_ID,
          studentGroupId: GROUP_ID,
          dayOfWeek: 2,
          startTime: '8.20',
          endTime: '09:20',
        })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('startTime');
    });

    it('rejects a weekend day the school week has no room for', async () => {
      await request(http())
        .post('/api/v1/master-lessons')
        .set('x-test-user', admin())
        .send({
          academicYearId: YEAR_ID,
          subjectId: SUBJECT_ID,
          studentGroupId: GROUP_ID,
          dayOfWeek: 8,
          startTime: '08:20',
          endTime: '09:20',
        })
        .expect(400);
    });
  });

  describe('single-lesson actions', () => {
    it('cancels a lesson with a reason', async () => {
      harness.tx['calendarLesson']!['findUnique']!.mockResolvedValue(lessonRow());
      harness.tx['calendarLesson']!['update']!.mockResolvedValue({
        id: LESSON_ID,
        status: 'CANCELLED',
        note: 'Läraren är sjuk',
      });
      harness.tx['studentGroupMember']!['findMany']!.mockResolvedValue([]);
      harness.tx['guardianStudent']!['findMany']!.mockResolvedValue([]);
      harness.tx['notification']!['createMany']!.mockResolvedValue({ count: 0 });

      await request(http())
        .patch(`/api/v1/calendar-lessons/${LESSON_ID}/cancel`)
        .set('x-test-user', admin())
        .send({ reason: 'Läraren är sjuk' })
        .expect(200);
    });

    it('clears a room with an explicit null', async () => {
      // `null` is meaningful here — it removes the room rather than leaving
      // it untouched — so the DTO must accept it where a uuid would go.
      harness.tx['calendarLesson']!['findUnique']!.mockResolvedValue(
        lessonRow({ roomId: '11111111-1111-4111-8111-111111111111' }),
      );
      harness.tx['calendarLesson']!['findMany']!.mockResolvedValue([]);
      harness.tx['calendarLesson']!['update']!.mockResolvedValue({
        id: LESSON_ID,
        roomId: null,
      });
      harness.tx['studentGroupMember']!['findMany']!.mockResolvedValue([]);
      harness.tx['guardianStudent']!['findMany']!.mockResolvedValue([]);
      harness.tx['notification']!['createMany']!.mockResolvedValue({ count: 0 });

      await request(http())
        .patch(`/api/v1/calendar-lessons/${LESSON_ID}/room-change`)
        .set('x-test-user', admin())
        .send({ roomId: null })
        .expect(200);
    });

    it('assigns an obehörig vikarie under REFUSE and says so: the policy refuses the plan, never today’s cover', async () => {
      const SUB_ID = '13131313-1313-4313-8313-131313131313';
      harness.tx['calendarLesson']!['findUnique']!.mockResolvedValue(lessonRow());
      harness.tx['user']!['findUnique']!.mockResolvedValue({ id: SUB_ID, role: 'TEACHER', isActive: true });
      harness.tx['calendarLesson']!['findFirst']!.mockResolvedValue(null);
      harness.tx['calendarLesson']!['update']!.mockResolvedValue({ id: LESSON_ID, status: 'SCHEDULED', note: null });
      harness.tx['staffingPolicy']!['findUnique']!.mockResolvedValue({
        qualificationMode: 'REFUSE',
        overAllocationMode: 'REFUSE',
        overAllocationTolerancePercent: 10,
        fullTimeTeachingMinutesPerWeek: 1000,
        unstaffedGeneration: 'ALLOW',
      });
      harness.tx['teacherSubjectQualification']!['findMany']!.mockResolvedValue([
        { userId: TEACHER_ID, subjectId: SUBJECT_ID, minGradeLevel: 7, maxGradeLevel: 9, kind: 'LEGITIMATION', validFrom: null, validTo: null },
      ]);
      harness.tx['subject']!['findUnique']!.mockResolvedValue({ name: 'Matematik' });
      harness.tx['studentGroup']!['findUnique']!.mockResolvedValue({ academicYearId: YEAR_ID });
      harness.tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: GROUP_ID, gradeLevel: 8 }]);
      harness.tx['studentGroupMember']!['findMany']!.mockResolvedValue([]);
      harness.tx['guardianStudent']!['findMany']!.mockResolvedValue([]);
      harness.tx['notification']!['createMany']!.mockResolvedValue({ count: 0 });

      try {
        const response = await request(http())
          .patch(`/api/v1/calendar-lessons/${LESSON_ID}/substitute`)
          .set('x-test-user', admin())
          .send({ teacherId: SUB_ID })
          .expect(200);

        expect(response.body).toMatchObject({
          id: LESSON_ID,
          warnings: [
            {
              code: 'STAFF_TEACHER_NOT_QUALIFIED',
              params: { role: 'SUBSTITUTE', subject: 'Matematik', grades: '8' },
            },
          ],
        });
        expect(harness.tx['calendarLessonTeacher']!['create']).toHaveBeenCalledWith({
          data: expect.objectContaining({ teacherId: SUB_ID, role: 'SUBSTITUTE' }),
        });
      } finally {
        forgetStaffingWorld(harness.tx);
        harness.tx['user']!['findUnique']!.mockReset();
        harness.tx['calendarLesson']!['findFirst']!.mockReset();
      }
    });

    it('rejects a substitute that is not a teacher id', async () => {
      await request(http())
        .patch(`/api/v1/calendar-lessons/${LESSON_ID}/substitute`)
        .set('x-test-user', admin())
        .send({ teacherId: 'karin.ek@example.com' })
        .expect(400);
    });

    it('offers substitute suggestions', async () => {
      harness.tx['calendarLesson']!['findUnique']!.mockResolvedValue(lessonRow());
      harness.tx['calendarLesson']!['findMany']!.mockResolvedValue([]);
      harness.tx['user']!['findMany']!.mockResolvedValue([]);
      harness.tx['availabilityConstraint']!['findMany']!.mockResolvedValue([]);

      await request(http())
        .get(`/api/v1/calendar-lessons/${LESSON_ID}/substitute-suggestions`)
        .set('x-test-user', admin())
        .expect(200);
    });
  });

  describe('version snapshots', () => {
    it('creates a snapshot', async () => {
      harness.tx['academicYear']!['findUnique']!.mockResolvedValue({
        id: YEAR_ID,
        schoolId: '33333333-3333-4333-8333-333333333333',
      });
      harness.tx['masterLesson']!['findMany']!.mockResolvedValue([]);
      harness.tx['scheduleVersion']!['create']!.mockResolvedValue({
        id: VERSION_ID,
        name: 'Före omgenerering',
        createdAt: new Date('2026-08-17T10:00:00.000Z'),
        lessonCount: 0,
      });

      await request(http())
        .post('/api/v1/schedule-versions')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, name: 'Före omgenerering' })
        .expect(201);
    });

    it('rejects an empty snapshot name', async () => {
      await request(http())
        .post('/api/v1/schedule-versions')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, name: '' })
        .expect(400);
    });

    it('400s a list request with no year', async () => {
      await request(http())
        .get('/api/v1/schedule-versions')
        .set('x-test-user', admin())
        .expect(400);
    });

    it('denies a teacher restoring a snapshot over the live timetable', async () => {
      await request(http())
        .post(`/api/v1/schedule-versions/${VERSION_ID}/restore`)
        .set('x-test-user', asUser({ role: 'TEACHER' as never }))
        .send({})
        .expect(403);
    });
  });
});
