import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';
import { forgetStaffingWorld, givenStaffingWorld } from './utils/staffing-world';

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

    /*
     * The staffing pre-flight: with the policy's unstaffedGeneration REFUSE
     * and a timplanspost without a teacher, a run is refused before the engine
     * is woken, and the refusal is stored like an engine refusal — summary code
     * STAFF_UNSTAFFED_REQUIREMENTS, the rows named by subject and group.
     */
    describe('the staffing pre-flight', () => {
      const MA_7A = '12121212-1212-4212-8212-121212121212';

      const givenRefusingSchool = () => {
        harness.tx['staffingPolicy']!['findUnique']!.mockResolvedValue({ unstaffedGeneration: 'REFUSE' });
        harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([
          { id: MA_7A, subject: { name: 'Matematik' }, studentGroup: { name: '7A' } },
        ]);
      };

      afterEach(() => {
        forgetStaffingWorld(harness.tx);
        harness.tx['optimizationJob']!['create']!.mockReset();
        harness.tx['optimizationJob']!['update']!.mockReset();
      });

      it('refuses the synchronous trigger without calling the engine', async () => {
        givenRefusingSchool();

        const response = await request(http())
          .post('/api/v1/optimization/trigger')
          .set('x-test-user', admin())
          .send({ academicYearId: YEAR_ID })
          .expect(202);

        expect(response.body).toEqual({ status: 'INFEASIBLE', lessonsGenerated: 0 });
        expect(harness.http.post).not.toHaveBeenCalled();
        expect(harness.tx['masterLesson']!['deleteMany']).not.toHaveBeenCalled();
      });

      it('stores the refusal on the job the way an engine refusal is stored', async () => {
        givenRefusingSchool();
        harness.tx['optimizationJob']!['create']!.mockResolvedValue({ id: VERSION_ID });
        harness.tx['optimizationJob']!['update']!.mockResolvedValue({ id: VERSION_ID });

        await request(http())
          .post('/api/v1/optimization/jobs')
          .set('x-test-user', admin())
          .send({ academicYearId: YEAR_ID })
          .expect(202);

        // The run is fire-and-forget: wait for it to write its outcome.
        const update = harness.tx['optimizationJob']!['update']!;
        for (let tries = 0; tries < 50 && update.mock.calls.length < 2; tries++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(update).toHaveBeenLastCalledWith({
          where: { id: VERSION_ID },
          data: expect.objectContaining({
            status: 'SUCCEEDED',
            solverStatus: 'INFEASIBLE',
            lessonsGenerated: 0,
            conflictSummaryCode: 'STAFF_UNSTAFFED_REQUIREMENTS',
            conflictSummaryParams: { count: 1 },
            conflicts: [
              expect.objectContaining({
                code: 'STAFF_UNSTAFFED_REQUIREMENTS',
                params: { count: 1 },
                resourceNames: ['Matematik för 7A'],
              }),
            ],
          }),
        });
        expect(harness.http.post).not.toHaveBeenCalled();
      });
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

    /*
     * Re-teachering a lesson under the staffing policy, through the handler:
     * WARN is a 200 whose body still carries `warnings` after serialisation,
     * REFUSE a 409 problem with the code and the params the web renders its
     * sentence from, and the lesson untouched.
     */
    describe('re-teachered under the staffing policy', () => {
      const NEW_TEACHER = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
      const stored = {
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
        isParked: false,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        extraGroups: [],
        participants: [],
        school: { id: '33333333-3333-4333-8333-333333333333', timezone: 'Europe/Stockholm' },
      };
      const arrange = (qualificationMode: 'WARN' | 'REFUSE') => {
        givenStaffingWorld(harness.tx, {
          year: { id: YEAR_ID, startDate: new Date('2026-08-17'), endDate: new Date('2027-06-11') },
          policy: { qualificationMode },
          groups: [{ id: GROUP_ID, name: '8A', gradeLevel: 8 }],
          subjects: [{ id: SUBJECT_ID, name: 'Matematik' }],
          // Somebody holds a behörighet, so the question is asked; not the new teacher.
          qualifications: [{ userId: TEACHER_ID, subjectId: SUBJECT_ID, minGradeLevel: 7, maxGradeLevel: 9 }],
        });
        harness.tx['masterLesson']!['findUnique']!.mockResolvedValue(stored);
        harness.tx['masterLesson']!['findMany']!.mockResolvedValue([]);
        harness.tx['masterLesson']!['update']!.mockResolvedValue({ ...stored, teacherId: NEW_TEACHER });
      };
      const patch = () =>
        request(http())
          .patch(`/api/v1/master-lessons/${LESSON_ID}`)
          .set('x-test-user', admin())
          .send({ teacherId: NEW_TEACHER });

      afterEach(() => {
        forgetStaffingWorld(harness.tx);
        harness.tx['masterLesson']!['findUnique']!.mockReset();
      });

      it('WARN: 200, the lesson re-teachered, and the finding in `warnings`', async () => {
        arrange('WARN');

        const response = await patch().expect(200);

        expect(response.body.warnings).toEqual([
          { code: 'STAFF_TEACHER_NOT_QUALIFIED', params: { role: 'TEACHER', subject: 'Matematik', grades: '8' } },
        ]);
        expect(harness.tx['masterLesson']!['update']).toHaveBeenCalledTimes(1);
      });

      it('REFUSE: 409 with the code, the params and the Swedish — and the lesson untouched', async () => {
        arrange('REFUSE');

        const response = await patch().expect(409);

        expect(response.body).toMatchObject({
          status: 409,
          code: 'STAFF_TEACHER_NOT_QUALIFIED',
          params: { role: 'TEACHER', subject: 'Matematik', grades: '8' },
          detail: 'Läraren saknar behörighet i Matematik för åk 8.',
        });
        expect(harness.tx['masterLesson']!['update']).not.toHaveBeenCalled();
      });
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
