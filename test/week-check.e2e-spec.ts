import request from 'supertest';
import { AxiosError } from 'axios';
import { of, throwError } from 'rxjs';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';
import { forgetStaffingWorld } from './utils/staffing-world';

/**
 * Kontrollera veckan over HTTP, as an administrator: the route through the real
 * routing table, ValidationPipe, JwtAuthGuard and RolesGuard with the areas, the
 * problem filter, and the real fetch of Generera (OptimizationProxyService.
 * prepareSchedule) with the engine stubbed (HttpService).
 *
 * What a unit spec cannot see is pinned here: that the engine is asked at the
 * route with the week the fetch built, that nothing is written, that no id of
 * the engine's reaches the answer, that an older engine's 404 leaves as the
 * function that is coming, that a refusal about a post's days is worded for the
 * caller as the synchronous trigger words it, and which profiles may ask. A 403
 * row alone stops at the guard (rbac-rows-cover-no-handler): the admin round
 * trips below are what cover the controller.
 */

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const SUBJECT_ID = '99999999-9999-4999-8999-999999999999';
const GROUP_ID = '88888888-8888-4888-8888-888888888888';
const EVA = '12121212-eeee-4eee-8eee-121212121212';
const POST = '13131313-eeee-4eee-8eee-131313131313';
const HIDDEN_ENGLISH =
  "A teacher's limit on how many days a week they teach is one of the reasons the timetable could not be made. " +
  'The limit is shown to the principal, a full administrator and anyone with HR read access.';

describe('Kontrollera veckan (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const admin = () => asUser({});
  const as = (adminProfile: string) => asUser({ adminProfile } as never);
  const post = () => request(http()).post('/api/v1/optimization/week-check');

  /** One post, taught by Eva, whose post allows teaching on three days: a week the fetch can build. */
  const givenAWeek = () => {
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
    harness.tx['teacherEmployment']!['findMany']!.mockResolvedValue([
      { id: POST, academicYearId: YEAR_ID, userId: EVA, maxTeachingDaysPerWeek: 3, user: { firstName: 'Eva', lastName: 'Ek' } },
    ]);
  };

  /** The engine's answer to the check, as an HTTP answer the stubbed HttpService returns. */
  const engineAnswers = (data: Record<string, unknown>) => harness.http.post.mockReturnValueOnce(of({ data }));

  /** The engine's refusal of a request, as axios reports it. */
  const engineRefuses = (status: number, data: Record<string, unknown>) => {
    const refused = new AxiosError('boom');
    refused.response = { status, data } as never;
    harness.http.post.mockReturnValueOnce(throwError(() => refused));
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
    harness.tx['teacherEmployment']!['findMany']!.mockReset().mockResolvedValue([]);
    harness.tx['teachingRequirement']!['findMany']!.mockReset().mockResolvedValue([]);
  });

  describe('the week as the engine is asked about it', () => {
    it('answers 200 for a full administrator with the engine\'s verdict, years and rows, whitelisted, and asks the engine at its route with the week the fetch built', async () => {
      givenAWeek();
      engineAnswers({
        requestId: '55555555-5555-4555-8555-555555555555',
        verdict: 'TIGHT',
        years: [{ year: 9, demandMinutes: 2120, capacityMinutes: 2275, percent: 93, over: false }],
        conflicts: {
          summary: '',
          summaryCode: '',
          summaryParams: {},
          conflicts: [
            {
              category: 'REQUIREMENT_DEMAND',
              code: 'TIGHT_WEEK_LOAD',
              params: { grades: '9', demandMinutes: 2120, capacityMinutes: 2275, percent: 93 },
              message: 'Year 9 needs at least 2120 of the 2275 minutes (93 %).',
              requirementIds: [],
              roomIds: [],
              constraintIds: [],
              resourceIds: [],
            },
          ],
        },
        skipped: ['LUNCH_STAGE'],
        elapsedMs: 210,
      });

      const response = await post().set('x-test-user', admin()).send({ academicYearId: YEAR_ID }).expect(200);

      expect(response.body).toEqual({
        verdict: 'TIGHT',
        years: [{ year: 9, demandMinutes: 2120, capacityMinutes: 2275, percent: 93, over: false }],
        conflicts: {
          summary: '',
          summaryCode: '',
          summaryParams: {},
          conflicts: [
            {
              category: 'REQUIREMENT_DEMAND',
              code: 'TIGHT_WEEK_LOAD',
              params: { grades: '9', demandMinutes: 2120, capacityMinutes: 2275, percent: 93 },
              message: 'Year 9 needs at least 2120 of the 2275 minutes (93 %).',
              resourceNames: [],
            },
          ],
        },
        skipped: ['LUNCH_STAGE'],
        elapsedMs: 210,
        checkedBy: 'ENGINE',
      });
      // Asked once, at the engine's route, with the service key, a wait of seconds, and Generera's own request: the
      // post the fetch read, anonymised (no real id of Eva's, the group's or the subject's).
      expect(harness.http.post).toHaveBeenCalledTimes(1);
      const [url, sent, options] = harness.http.post.mock.calls[0] as unknown as [string, { requirements: unknown[] }, { timeout: number; headers: Record<string, string> }];
      expect(url).toMatch(/\/api\/v1\/check-week$/);
      expect(sent.requirements).toHaveLength(1);
      expect(options.timeout).toBe(30_000);
      expect(options.headers['X-API-Key']).toBeTruthy();
      for (const real of [EVA, GROUP_ID, SUBJECT_ID]) expect(JSON.stringify(sent)).not.toContain(real);
    });

    it('writes nothing: no run is stored, no lesson is deleted or created', async () => {
      givenAWeek();
      engineAnswers({ requestId: 'r', verdict: 'OK', years: [], conflicts: null, skipped: ['LUNCH_STAGE'], elapsedMs: 3 });

      await post().set('x-test-user', admin()).send({ academicYearId: YEAR_ID }).expect(200);

      expect(harness.tx['optimizationJob']!['create']).not.toHaveBeenCalled();
      expect(harness.tx['optimizationJob']!['update']).not.toHaveBeenCalled();
      expect(harness.tx['masterLesson']!['deleteMany']).not.toHaveBeenCalled();
      expect(harness.tx['masterLesson']!['createMany']).not.toHaveBeenCalled();
    });

    it('says a week with nothing to place is OK without waking the engine', async () => {
      // No timplansposter: the fetch reads an empty demand.
      const response = await post().set('x-test-user', admin()).send({ academicYearId: YEAR_ID }).expect(200);

      expect(response.body).toMatchObject({ verdict: 'OK', skipped: ['ENGINE'], checkedBy: 'GATEWAY', years: [], conflicts: null });
      expect(harness.http.post).not.toHaveBeenCalled();
    });
  });

  describe('when the gateway answers itself', () => {
    afterEach(() => {
      forgetStaffingWorld(harness.tx);
    });

    it('answers a post without a teacher as the refusal Generera gives, without waking the engine', async () => {
      harness.tx['staffingPolicy']!['findUnique']!.mockResolvedValue({ unstaffedGeneration: 'REFUSE' });
      harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([
        { id: '12121212-1212-4212-8212-121212121212', subject: { name: 'Matematik' }, studentGroup: { name: '7A' } },
      ]);

      const response = await post().set('x-test-user', admin()).send({ academicYearId: YEAR_ID }).expect(200);

      expect(response.body).toMatchObject({
        verdict: 'IMPOSSIBLE',
        checkedBy: 'GATEWAY',
        years: [],
        skipped: [],
        conflicts: {
          summaryCode: 'STAFF_UNSTAFFED_REQUIREMENTS',
          summaryParams: { count: 1 },
          conflicts: [expect.objectContaining({ code: 'STAFF_UNSTAFFED_REQUIREMENTS', resourceNames: ['Matematik för 7A'] })],
        },
      });
      expect(harness.http.post).not.toHaveBeenCalled();
    });
  });

  describe('when the engine cannot answer', () => {
    it('says an older engine\'s 404 as the function that is coming, in Swedish, with its own code, and not as an engine error', async () => {
      givenAWeek();
      engineRefuses(404, { code: 'HTTP_ERROR', message: 'Not Found' });

      const response = await post().set('x-test-user', admin()).send({ academicYearId: YEAR_ID }).expect(503);

      expect(response.body).toMatchObject({
        code: 'ENGINE_LACKS_WEEK_CHECK',
        detail: 'Schemamotorn är äldre än API:t och kan inte kontrollera veckan ännu. Försök igen om några minuter.',
      });
      expect(JSON.stringify(response.body)).not.toContain('The AI engine returned an error');
    });

    it('leaves a refusal of the payload as the 400 Generera gives, with the engine\'s code and values', async () => {
      givenAWeek();
      engineRefuses(400, {
        code: 'INVALID_SCHEDULE_INPUT',
        message: 'Student group g brings 30 students to lunch, more than the dining hall\'s 20 seats.',
        details: { code: 'LUNCH_HEADCOUNT_EXCEEDS_SEATS', params: { seats: 20, headcount: 30 } },
      });

      const response = await post().set('x-test-user', admin()).send({ academicYearId: YEAR_ID }).expect(400);

      expect(response.body).toMatchObject({ code: 'LUNCH_HEADCOUNT_EXCEEDS_SEATS', params: { seats: 20, headcount: 30 } });
    });

    describe('a refusal about a post\'s days (HR data)', () => {
      const refuseOverEvasDays = () => {
        givenAWeek();
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

      it('answers a schemaläggare without HR-läs with the hidden sentence, as the synchronous trigger does', async () => {
        refuseOverEvasDays();

        const response = await post()
          .set('x-test-user', asUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false } as never))
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

        const response = await post()
          .set('x-test-user', asUser({ adminProfile: 'REKTOR', hrRead: true } as never))
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

  describe('who may ask, and what is refused first', () => {
    it.each([
      ['a teacher', asUser({ role: 'TEACHER', adminProfile: undefined, hrRead: undefined } as never)],
      ['an expedition administrator, who writes no Schemaläggning', as('EXPEDITION')],
      ['a läsare, who writes no area', as('LASARE')],
    ])('refuses %s at the guard, before anything is read or asked', async (_who, principal) => {
      await post().set('x-test-user', principal).send({ academicYearId: YEAR_ID }).expect(403);

      expect(harness.tx['teachingRequirement']!['findMany']).not.toHaveBeenCalled();
      expect(harness.http.post).not.toHaveBeenCalled();
    });

    it.each([
      ['a full administrator', as('FULL')],
      ['a rektor', as('REKTOR')],
      ['a schemaläggare', as('SCHEMALAGGARE')],
    ])('lets %s through to the handler', async (_who, principal) => {
      givenAWeek();
      engineAnswers({ requestId: 'r', verdict: 'OK', years: [], conflicts: null, skipped: ['LUNCH_STAGE'], elapsedMs: 3 });

      const response = await post().set('x-test-user', principal).send({ academicYearId: YEAR_ID }).expect(200);

      expect(response.body.verdict).toBe('OK');
    });

    it.each([
      ['no year', {}],
      ['a year that is no uuid', { academicYearId: 'latest' }],
      ['a field the route does not read', { academicYearId: YEAR_ID, weights: { spread: 4 } }],
    ])('refuses %s with 400 and reads nothing', async (_label, body) => {
      await post().set('x-test-user', admin()).send(body).expect(400);

      expect(harness.tx['teachingRequirement']!['findMany']).not.toHaveBeenCalled();
      expect(harness.http.post).not.toHaveBeenCalled();
    });
  });
});
