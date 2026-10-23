import request from 'supertest';
import { AxiosError } from 'axios';
import { throwError } from 'rxjs';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';
import { forgetStaffingWorld, givenStaffingWorld } from './utils/staffing-world';
import { recordedReads } from './utils/recorded-reads';

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

    /*
     * Lärarens dag: a refusal about a post's days carries HR data (Roller i
     * skolan), and a run is read by every administrator. Stored without the
     * figure; worded per reader when read (src/optimization/work-days.ts):
     * rektor reads the days and the teacher, a schemaläggare without HR-läs
     * neither — not in the sentence, not in a param, not anywhere in the body.
     */
    describe('a refusal about a post’s days', () => {
      const EVA = '12121212-eeee-4eee-8eee-121212121212';
      const POST = '13131313-eeee-4eee-8eee-131313131313';
      const HIDDEN_ENGLISH =
        "A teacher's limit on how many days a week they teach is one of the reasons the timetable could not be made. " +
        'The limit is shown to the principal, a full administrator and anyone with HR read access.';
      const rektor = () => asUser({ adminProfile: 'REKTOR' } as never);
      const planner = () => asUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false } as never);
      const evasPost = {
        id: POST,
        academicYearId: YEAR_ID,
        userId: EVA,
        maxTeachingDaysPerWeek: 3,
        user: { firstName: 'Eva', lastName: 'Ek' },
      };
      const failedRun = {
        id: VERSION_ID,
        academicYearId: YEAR_ID,
        status: 'FAILED',
        solverStatus: null,
        lessonsGenerated: 0,
        conflictSummary: null,
        conflictSummaryCode: null,
        conflictSummaryParams: null,
        conflicts: null,
        notes: null,
        // As run() stores the engine's pre-flight: no figure, the hidden
        // English, Eva's Users id kept beside the params for the server.
        error: HIDDEN_ENGLISH,
        errorCode: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK',
        errorParams: { limit: POST, weekMinutes: 1500, subjectIds: [EVA] },
        createdAt: new Date('2026-11-23T10:00:00.000Z'),
        finishedAt: new Date('2026-11-23T10:00:02.000Z'),
      };
      const infeasibleRun = {
        ...failedRun,
        status: 'SUCCEEDED',
        solverStatus: 'INFEASIBLE',
        conflictSummary: '1 cause',
        conflictSummaryCode: 'CONFLICT_CORE_SUMMARY',
        conflictSummaryParams: { count: 1 },
        conflicts: [
          {
            category: 'TEACHER_OVERLAP',
            code: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
            params: { limit: POST },
            message: HIDDEN_ENGLISH,
            resourceNames: [],
            subjectIds: [EVA],
          },
        ],
        error: null,
        errorCode: null,
        errorParams: null,
      };

      afterEach(() => {
        harness.tx['optimizationJob']!['findUnique']!.mockReset();
        harness.tx['optimizationJob']!['findMany']!.mockReset().mockResolvedValue([]);
        harness.tx['teacherEmployment']!['findMany']!.mockReset().mockResolvedValue([]);
        harness.tx['teachingRequirement']!['findMany']!.mockReset().mockResolvedValue([]);
      });

      it('shows rektor the failed run with the days read back from the post, and logs the read', async () => {
        harness.tx['optimizationJob']!['findUnique']!.mockResolvedValue(failedRun);
        harness.tx['teacherEmployment']!['findMany']!.mockResolvedValue([evasPost]);

        const response = await request(http())
          .get(`/api/v1/optimization/jobs/${VERSION_ID}`)
          .set('x-test-user', rektor())
          .expect(200);

        expect(response.body).toMatchObject({
          status: 'FAILED',
          errorCode: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK',
          errorParams: { limit: POST, weekMinutes: 1500, days: 3 },
          // `limit` is a post's id, which no screen resolves: whose post it
          // is stands beside the sentence, as a conflict's resourceNames.
          errorNames: ['Eva Ek'],
          conflictSummaryNames: [],
          notes: [],
        });
        expect(JSON.stringify(response.body)).not.toContain(EVA);
        expect(recordedReads(harness.tx)).toEqual([expect.objectContaining({ kind: 'EMPLOYMENT', ids: [EVA] })]);
      });

      it('shows rektor a refused week’s days sentence with the teacher named', async () => {
        harness.tx['optimizationJob']!['findMany']!.mockResolvedValue([infeasibleRun]);
        harness.tx['teacherEmployment']!['findMany']!.mockResolvedValue([evasPost]);

        const response = await request(http())
          .get(`/api/v1/optimization/jobs?academicYearId=${YEAR_ID}`)
          .set('x-test-user', rektor())
          .expect(200);

        expect(response.body[0].conflicts).toEqual([
          {
            category: 'TEACHER_OVERLAP',
            code: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
            params: { limit: POST, days: 3 },
            message: HIDDEN_ENGLISH,
            resourceNames: ['Eva Ek'],
          },
        ]);
        // Named once, on the sentence about her: the summary counts causes.
        expect(response.body[0]).toMatchObject({ conflictSummaryNames: [], errorNames: [] });
      });

      it.each([
        ['the run', () => request(http()).get(`/api/v1/optimization/jobs/${VERSION_ID}`), failedRun],
        ['the history', () => request(http()).get(`/api/v1/optimization/jobs?academicYearId=${YEAR_ID}`), infeasibleRun],
      ])('shows a schemaläggare without HR-läs %s with no days, no post and no teacher anywhere', async (_what, ask, run) => {
        harness.tx['optimizationJob']!['findUnique']!.mockResolvedValue(run);
        harness.tx['optimizationJob']!['findMany']!.mockResolvedValue([run]);
        // Were the posts read, they would say all of it.
        harness.tx['teacherEmployment']!['findMany']!.mockResolvedValue([evasPost]);

        const response = await ask().set('x-test-user', planner()).expect(200);

        // Both lists there, and nobody in them.
        const view = Array.isArray(response.body) ? response.body[0] : response.body;
        expect(view).toMatchObject({ errorNames: [], conflictSummaryNames: [] });
        const body = JSON.stringify(response.body);
        expect(body).toContain('TEACHER_WORK_DAYS_HIDDEN');
        expect(body).not.toMatch(/TEACHER_WORK_DAYS_(TOO_FEW|CANNOT)|"days"|Eva|subjectIds/);
        expect(body).not.toContain(EVA);
        expect(body).not.toContain(POST);
        expect(body).not.toContain('1500');
        expect(harness.tx['teacherEmployment']!['findMany']).not.toHaveBeenCalled();
        expect(recordedReads(harness.tx)).toEqual([]);
      });

      describe('from the synchronous trigger', () => {
        const refuseOverEvasDays = () => {
          harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([
            {
              id: '14141414-eeee-4eee-8eee-141414141414',
              subjectId: SUBJECT_ID,
              studentGroupId: GROUP_ID,
              teacherId: EVA,
              coTeacherId: null,
              lessonsPerWeek: 3,
              minutesPerLesson: 60,
              lessonLengths: [],
              minutesBefore: 0,
              minutesAfter: 0,
              recurrence: 'ALL_WEEKS',
              startDate: null,
              endDate: null,
              subject: { requiredRoomTypeId: null, name: 'Matematik' },
            },
          ]);
          harness.tx['teacherEmployment']!['findMany']!.mockResolvedValue([evasPost]);
          harness.http.post.mockImplementationOnce((_url: string, payload: { teacherDayLimits: { id: string }[] }) => {
            const refused = new AxiosError('boom');
            refused.response = {
              status: 400,
              data: {
                code: 'INVALID_SCHEDULE_INPUT',
                message: `The teacher's post ${payload.teacherDayLimits[0]!.id} allows teaching on at most 3 days a week …`,
                details: {
                  code: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK',
                  params: { limit: payload.teacherDayLimits[0]!.id, days: 3, weekMinutes: 180 },
                },
              },
            } as never;
            return throwError(() => refused);
          });
        };

        it('answers a schemaläggare without HR-läs with the hidden sentence', async () => {
          refuseOverEvasDays();

          const response = await request(http())
            .post('/api/v1/optimization/trigger')
            .set('x-test-user', planner())
            .send({ academicYearId: YEAR_ID })
            .expect(400);

          expect(response.body).toMatchObject({ code: 'TEACHER_WORK_DAYS_HIDDEN', detail: HIDDEN_ENGLISH });
          const body = JSON.stringify(response.body);
          expect(body).not.toMatch(/"days"|3 days|TOO_FEW/);
          expect(body).not.toContain(EVA);
          expect(body).not.toContain(POST);
        });

        it('answers rektor with the days read back from the post', async () => {
          refuseOverEvasDays();

          const response = await request(http())
            .post('/api/v1/optimization/trigger')
            .set('x-test-user', rektor())
            .send({ academicYearId: YEAR_ID })
            .expect(400);

          expect(response.body).toMatchObject({
            code: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK',
            params: { limit: POST, weekMinutes: 180, days: 3 },
          });
          expect(JSON.stringify(response.body)).not.toContain(EVA);
        });
      });
    });

    /*
     * Lärarens dag: a free-day wish the run did not keep is the work rule's,
     * which every member of staff reads, so its note names the teacher for
     * every reader — read back by the Users id stored beside it, which no
     * body carries, and never written to the Läslogg.
     */
    describe('a note about a free-day wish', () => {
      const EVA = '12121212-ffff-4fff-8fff-121212121212';
      const wishRun = {
        id: VERSION_ID,
        academicYearId: YEAR_ID,
        status: 'SUCCEEDED',
        solverStatus: 'OPTIMAL',
        lessonsGenerated: 24,
        conflictSummary: null,
        conflictSummaryCode: null,
        conflictSummaryParams: null,
        conflicts: [],
        // As run() stores it: the day, Eva beside it, nobody named.
        notes: [
          {
            category: 'AVAILABILITY',
            code: 'TEACHER_FREE_DAY_WISH_NOT_KEPT',
            params: { day: 5 },
            message: 'A teacher wishes Fridays free, and the new timetable gives them lessons that day. …',
            resourceNames: [],
            subjectIds: [EVA],
          },
        ],
        error: null,
        errorCode: null,
        errorParams: null,
        createdAt: new Date('2026-11-23T10:00:00.000Z'),
        finishedAt: new Date('2026-11-23T10:00:30.000Z'),
      };

      afterEach(() => {
        harness.tx['optimizationJob']!['findUnique']!.mockReset();
        harness.tx['optimizationJob']!['findMany']!.mockReset().mockResolvedValue([]);
        harness.tx['user']!['findMany']!.mockReset().mockResolvedValue([]);
      });

      it.each([
        ['a schemaläggare without HR-läs', () => asUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false } as never)],
        ['rektor', () => asUser({ adminProfile: 'REKTOR' } as never)],
      ])('names the teacher whose wish it was to %s, with the day and no id', async (_who, reader) => {
        harness.tx['optimizationJob']!['findUnique']!.mockResolvedValue(wishRun);
        harness.tx['user']!['findMany']!.mockResolvedValue([{ id: EVA, firstName: 'Eva', lastName: 'Ek' }]);

        const response = await request(http())
          .get(`/api/v1/optimization/jobs/${VERSION_ID}`)
          .set('x-test-user', reader())
          .expect(200);

        expect(response.body.notes).toEqual([
          {
            category: 'AVAILABILITY',
            code: 'TEACHER_FREE_DAY_WISH_NOT_KEPT',
            params: { day: 5 },
            message: wishRun.notes[0]!.message,
            resourceNames: ['Eva Ek'],
          },
        ]);
        expect(JSON.stringify(response.body)).not.toMatch(/subjectIds|"rule"/);
        expect(JSON.stringify(response.body)).not.toContain(EVA);
        expect(harness.tx['user']!['findMany']).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: { in: [EVA] } } }),
        );
        expect(recordedReads(harness.tx)).toEqual([]);
      });

      it('names her in the run history too', async () => {
        harness.tx['optimizationJob']!['findMany']!.mockResolvedValue([wishRun]);
        harness.tx['user']!['findMany']!.mockResolvedValue([{ id: EVA, firstName: 'Eva', lastName: 'Ek' }]);

        const response = await request(http())
          .get(`/api/v1/optimization/jobs?academicYearId=${YEAR_ID}`)
          .set('x-test-user', admin())
          .expect(200);

        expect(response.body[0].notes.map((note: { resourceNames: string[] }) => note.resourceNames)).toEqual([['Eva Ek']]);
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
     * Block i schemat: a parallel block's card and its lock, through the
     * handlers. Declared before PATCH :id, whose UUID pipe would answer the
     * word with a 400, so a request that reaches the service here proves the
     * order; the rest is the service's (master-lessons.service.spec.ts).
     */
    describe('a parallel block’s card (Block i schemat)', () => {
      const FR_LESSON = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
      const FR_GROUP = '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b';
      const BLOCK = '4c4c4c4c-4c4c-4c4c-8c4c-4c4c4c4c4c4c';
      const member = (id: string, studentGroupId: string, name: string) => ({
        id,
        academicYearId: YEAR_ID,
        subjectId: SUBJECT_ID,
        studentGroupId,
        teacherId: null,
        coTeacherId: null,
        roomId: null,
        dayOfWeek: 1,
        startTime: new Date('1970-01-01T10:00:00.000Z'),
        endTime: new Date('1970-01-01T11:00:00.000Z'),
        isLocked: false,
        isParked: false,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        extraGroups: [],
        participants: [],
        subject: { name: 'Tyska' },
        studentGroup: { name },
        school: { id: '33333333-3333-4333-8333-333333333333', timezone: 'Europe/Stockholm', _count: { academicYears: 1 } },
      });

      it('moves the card in one statement and answers every member', async () => {
        harness.tx['masterLesson']!['findMany']!
          .mockResolvedValueOnce([member(LESSON_ID, GROUP_ID, 'Ty7'), member(FR_LESSON, FR_GROUP, 'Fr7')])
          .mockResolvedValue([]);
        harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([
          { studentGroupId: GROUP_ID, subjectId: SUBJECT_ID, blockId: BLOCK },
          { studentGroupId: FR_GROUP, subjectId: SUBJECT_ID, blockId: BLOCK },
        ]);
        harness.tx['masterLesson']!['updateMany']!.mockResolvedValue({ count: 2 });

        const response = await request(http())
          .patch('/api/v1/master-lessons/block-card')
          .set('x-test-user', admin())
          .send({ lessonIds: [LESSON_ID, FR_LESSON], dayOfWeek: 2, startTime: '09:00', endTime: '10:00' })
          .expect(200);

        expect(response.body.lessons.map((lesson: { id: string; dayOfWeek: number }) => [lesson.id, lesson.dayOfWeek])).toEqual([
          [LESSON_ID, 2],
          [FR_LESSON, 2],
        ]);
        expect(harness.tx['masterLesson']!['updateMany']).toHaveBeenCalledTimes(1);
      });

      it('answers a card of one lesson, or of no lessons, with 400 before the service', async () => {
        for (const lessonIds of [[LESSON_ID], ['not-a-uuid', LESSON_ID], [LESSON_ID, LESSON_ID]]) {
          await request(http())
            .patch('/api/v1/master-lessons/block-card')
            .set('x-test-user', admin())
            .send({ lessonIds, dayOfWeek: 2, startTime: '09:00', endTime: '10:00' })
            .expect(400);
        }
        // An undo's `follow` names lessons by id, each once.
        for (const follow of [['not-a-uuid'], [FR_LESSON, FR_LESSON], 'all']) {
          await request(http())
            .patch('/api/v1/master-lessons/block-card')
            .set('x-test-user', admin())
            .send({ lessonIds: [LESSON_ID, FR_LESSON], dayOfWeek: 2, startTime: '09:00', endTime: '10:00', follow })
            .expect(400);
        }
        expect(harness.tx['masterLesson']!['updateMany']).not.toHaveBeenCalled();
      });

      it('locks the block, and is the administrator’s alone', async () => {
        harness.tx['teachingBlock']!['findUnique']!.mockResolvedValue({
          id: BLOCK,
          schoolId: '33333333-3333-4333-8333-333333333333',
          academicYearId: YEAR_ID,
          requirements: [{ studentGroupId: GROUP_ID, subjectId: SUBJECT_ID }],
          // On no other block's times, and none on its.
          sameTimesAs: null,
          sameTimes: [],
        });
        harness.tx['masterLesson']!['findMany']!.mockResolvedValue([member(LESSON_ID, GROUP_ID, 'Ty7')]);
        harness.tx['masterLesson']!['updateMany']!.mockResolvedValue({ count: 1 });

        const response = await request(http())
          .patch('/api/v1/master-lessons/block-lock')
          .set('x-test-user', admin())
          .send({ blockId: BLOCK, isLocked: true })
          .expect(200);
        expect(response.body).toEqual({ blockId: BLOCK, isLocked: true, lessonIds: [LESSON_ID], parked: 0 });

        for (const path of ['block-lock', 'block-card']) {
          await request(http())
            .patch(`/api/v1/master-lessons/${path}`)
            .set('x-test-user', asUser({ role: 'TEACHER' as never }))
            .send({ blockId: BLOCK, isLocked: true })
            .expect(403);
        }
      });
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
        // The school read also counts the lesson's year when R1 or R2 settles it.
        school: { id: '33333333-3333-4333-8333-333333333333', timezone: 'Europe/Stockholm', _count: { academicYears: 1 } },
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

    it('stores the cause the absence page sends, and MANUAL when a cancel sends none', async () => {
      const arrange = () => {
        harness.tx['calendarLesson']!['findUnique']!.mockResolvedValue(lessonRow());
        harness.tx['calendarLesson']!['update']!.mockResolvedValue({ id: LESSON_ID, status: 'CANCELLED', note: null });
        harness.tx['studentGroupMember']!['findMany']!.mockResolvedValue([]);
        harness.tx['guardianStudent']!['findMany']!.mockResolvedValue([]);
        harness.tx['notification']!['createMany']!.mockResolvedValue({ count: 0 });
      };
      const written = () =>
        (harness.tx['calendarLesson']!['update']!.mock.calls.at(-1)![0] as { data: { cancelCause?: string } }).data
          .cancelCause;

      arrange();
      await request(http())
        .patch(`/api/v1/calendar-lessons/${LESSON_ID}/cancel`)
        .set('x-test-user', admin())
        .send({ cause: 'TEACHER_UNAVAILABLE' })
        .expect(200);
      expect(written()).toBe('TEACHER_UNAVAILABLE');

      arrange();
      await request(http())
        .patch(`/api/v1/calendar-lessons/${LESSON_ID}/cancel`)
        .set('x-test-user', admin())
        .send({})
        .expect(200);
      expect(written()).toBe('MANUAL');
    });

    it('400s a cause the column does not have, naming the field', async () => {
      harness.tx['calendarLesson']!['update']!.mockClear();
      const response = await request(http())
        .patch(`/api/v1/calendar-lessons/${LESSON_ID}/cancel`)
        .set('x-test-user', admin())
        .send({ cause: 'SICK' })
        .expect(400);
      expect(JSON.stringify(response.body)).toContain("cause: 'TEACHER_UNAVAILABLE'");
      expect(harness.tx['calendarLesson']!['update']).not.toHaveBeenCalled();
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
      // The lesson's year, asked with its class as a relation filter.
      harness.tx['academicYear']!['findFirst']!.mockResolvedValue({ id: YEAR_ID, isActive: true, predecessorId: null });
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
