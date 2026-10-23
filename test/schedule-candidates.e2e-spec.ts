import request from 'supertest';
import { OptimizationProxyService } from '../src/optimization/optimization-proxy.service';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Schemaförslag over HTTP (design §3–§4): the routes the compare page calls,
 * through the real routing table, validation pipe, RolesGuard with the
 * areas, the problem filter and the real proxy's fetch and write.
 *
 * What a unit spec cannot see is pinned here: that a 409's code and the
 * parts it names survive the problem filter, that an administrator without
 * Schemaläggning is refused before anything is read, that the apply's whole
 * transaction runs through the real regeneration write in a DRAFT school,
 * and that no response carries a pupil.
 */

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const RUN_ID = '55555555-5555-4555-8555-555555555555';
const CANDIDATE_ID = '66666666-6666-4666-8666-666666666666';
const GROUP_ID = '88888888-8888-4888-8888-888888888888';
const SUBJECT_ID = '99999999-9999-4999-8999-999999999999';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

/** "SQL ? with ? placeholders", from a tagged call or a Prisma.sql object. */
const sqlOf = (args: unknown[]): string => {
  const [first] = args;
  return Array.isArray(first) ? (first as string[]).join('?') : ((first as { strings?: string[] }).strings ?? []).join('?');
};

describe('Schemaförslag (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const admin = () => asUser({});
  const as = (adminProfile: string) => asUser({ adminProfile } as never);
  /** The publication mode the school is in, as app.enter_grundschema_write answers it. */
  let mode: 'DRAFT' | 'DIRECT';

  /** Lets the background task a start fired finish against the mocks. */
  const settle = async () => {
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
  };

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mode = 'DRAFT';
    harness.tx.$queryRaw = jest.fn(async (...args: unknown[]) => {
      const sql = sqlOf(args);
      if (sql.includes('enter_grundschema_write') || sql.includes('school_publish_mode')) return [{ mode }];
      if (sql.includes('"ScheduleCandidateRuns" WHERE "id" =')) return [{ status: 'SUCCEEDED' }];
      return [];
    });
    harness.tx.$executeRaw = jest.fn(async () => 0);
    harness.tx['masterLesson']!['count']!.mockResolvedValue(4);
    harness.tx['optimizationJob']!['count']!.mockResolvedValue(0);
    harness.tx['scheduleCandidateRun']!['findFirst']!.mockResolvedValue(null);
    harness.tx['scheduleCandidateRun']!['create']!.mockResolvedValue({ id: RUN_ID });
  });

  describe('POST /api/v1/optimization/candidates', () => {
    it('answers 202 with the run, inserted PENDING for three candidates under the lease of the longest call', async () => {
      const response = await request(http())
        .post('/api/v1/optimization/candidates')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, weights: { spread: 4 } })
        .expect(202);
      await settle();

      expect(response.body).toEqual({ runId: RUN_ID });
      expect(harness.tx['scheduleCandidateRun']!['create']).toHaveBeenCalledWith({
        data: expect.objectContaining({
          schoolId: SCHOOL_ID,
          academicYearId: YEAR_ID,
          status: 'PENDING',
          requested: 3,
          leaseSeconds: 190,
          weights: { spread: 4 },
          refreshOfId: null,
        }),
        select: { id: true },
      });
      // The sweep ran first, and the task stopped at its first
      // compare-and-set (the mock updates no row): no fetch, no engine call.
      expect(sqlOf(harness.tx.$queryRaw.mock.calls[0])).toContain('app.schedule_candidates_sweep()');
      expect(harness.http.post).not.toHaveBeenCalled();
    });

    it.each([
      ['a count of 5', { count: 5 }],
      ['a count of 1', { count: 1 }],
      ['a seed, which the gateway chooses', { seed: 7 }],
      ['a weight over 1000', { weights: { disruption: 5000 } }],
      ['a refresh that is no uuid', { refreshOf: 'latest' }],
    ])('refuses %s with 400 and inserts nothing', async (_label, extra) => {
      await request(http())
        .post('/api/v1/optimization/candidates')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, ...extra })
        .expect(400);
      expect(harness.tx['scheduleCandidateRun']!['create']).not.toHaveBeenCalled();
    });

    it('answers 409 CANDIDATES_NEED_A_DRAFT, in Swedish, for a year with nothing to replace', async () => {
      harness.tx['masterLesson']!['count']!.mockResolvedValue(0);
      const response = await request(http())
        .post('/api/v1/optimization/candidates')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID })
        .expect(409);
      expect(response.body).toMatchObject({
        code: 'CANDIDATES_NEED_A_DRAFT',
        detail: 'Generera ett första schema, sedan kan du ta fram förslag utifrån det.',
      });
    });

    it('answers 409 CANDIDATES_RUNNING beside an active run of the year', async () => {
      harness.tx['scheduleCandidateRun']!['findFirst']!.mockResolvedValue({ id: RUN_ID });
      const response = await request(http())
        .post('/api/v1/optimization/candidates')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, count: 2 })
        .expect(409);
      expect(response.body).toMatchObject({ code: 'CANDIDATES_RUNNING' });
    });

    it('answers 404 REFRESH_GONE for a refresh of a batch that is gone', async () => {
      harness.tx['scheduleCandidateRun']!['findUnique']!.mockResolvedValue(null);
      const response = await request(http())
        .post('/api/v1/optimization/candidates')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, refreshOf: RUN_ID })
        .expect(404);
      expect(response.body).toMatchObject({ code: 'REFRESH_GONE' });
    });

    it('refuses a teacher at the guard, and an administrator without Schemaläggning with a 403 that names the area', async () => {
      await request(http())
        .post('/api/v1/optimization/candidates')
        .set('x-test-user', asUser({ role: 'TEACHER' as never }))
        .send({ academicYearId: YEAR_ID })
        .expect(403);
      const refused = await request(http())
        .post('/api/v1/optimization/candidates')
        .set('x-test-user', as('EXPEDITION'))
        .send({ academicYearId: YEAR_ID })
        .expect(403);
      expect(refused.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
      expect(harness.tx['masterLesson']!['count']).not.toHaveBeenCalled();
      expect(harness.tx['scheduleCandidateRun']!['create']).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/optimization/jobs beside a run', () => {
    it('refuses Generera 409 CANDIDATES_RUNNING while the year has a live candidate run', async () => {
      harness.tx.$queryRaw = jest.fn(async (...args: unknown[]) =>
        sqlOf(args).includes('"ScheduleCandidateRuns"') ? [{ active: 1 }] : [],
      );
      const response = await request(http())
        .post('/api/v1/optimization/jobs')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID })
        .expect(409);
      expect(response.body).toMatchObject({ code: 'CANDIDATES_RUNNING' });
      expect(harness.tx['optimizationJob']!['create']).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/optimization/candidates', () => {
    const BO = '33333333-3333-4333-8333-333333333303';
    const wish = {
      category: 'AVAILABILITY',
      code: 'TEACHER_FREE_DAY_WISH_NOT_KEPT',
      params: { day: 3 },
      message: 'A teacher wishes Wednesdays free …',
      resourceNames: [],
      subjectIds: [BO],
    };
    const runRow = {
      id: RUN_ID,
      status: 'SUCCEEDED',
      requested: 2,
      progress: 2,
      createdAt: new Date('2026-10-17T08:00:00.000Z'),
      startedAt: new Date('2026-10-17T08:00:01.000Z'),
      finishedAt: new Date('2026-10-17T08:03:00.000Z'),
      error: null,
      errorCode: null,
      errorParams: null,
      createdById: '22222222-2222-4222-8222-222222222222',
      appliedCandidateId: null,
      appliedAt: null,
      refreshOfId: null,
      heartbeatAt: new Date('2026-10-17T08:03:00.000Z'),
      leaseSeconds: 250,
      unplaced: { lines: 0, minutes: 0, draftLines: 1, draftMinutes: 60 },
      // A free-day wish the draft and the candidate break (Lärarens dag), as
      // the run stores it: the teacher's Users id kept for the server.
      draftNotes: [wish],
      candidates: [
        {
          id: CANDIDATE_ID,
          ordinal: 1,
          variant: 'KEEP',
          weights: null,
          solverStatus: 'OPTIMAL',
          errorCode: null,
          metrics: { moved: 3, movedOf: 40, kept: 37, roomChanges: 1, sameAs: null, lessonCount: 40, unplaced: { lines: 0, minutes: 0 } },
          conflicts: [],
          notes: [wish],
        },
      ],
    };
    const shownWish = {
      category: 'AVAILABILITY',
      code: 'TEACHER_FREE_DAY_WISH_NOT_KEPT',
      params: { day: 3 },
      message: 'A teacher wishes Wednesdays free …',
      resourceNames: ['Bo Ek'],
    };

    it('answers the newest run and batch with the five figures, and lets every administrator read it', async () => {
      harness.tx['scheduleCandidateRun']!['findFirst']!.mockResolvedValue(runRow);
      harness.tx['user']!['findMany']!.mockResolvedValue([{ id: BO, firstName: 'Bo', lastName: 'Ek' }]);
      // The läsare (Läsbehörighet) reads them like every administrator.
      for (const profile of ['FULL', 'EXPEDITION', 'LASARE']) {
        const response = await request(http())
          .get(`/api/v1/optimization/candidates?academicYearId=${YEAR_ID}`)
          .set('x-test-user', as(profile))
          .expect(200);
        expect(response.body.latest.run).toMatchObject({ id: RUN_ID, status: 'SUCCEEDED', createdByName: null });
        expect(response.body.batch).toEqual(response.body.latest);
        expect(response.body.unplaced).toEqual({ lines: 0, minutes: 0, draftLines: 1, draftMinutes: 60 });
        expect(response.body.latest.candidates[0]).toEqual({
          id: CANDIDATE_ID,
          ordinal: 1,
          variant: 'KEEP',
          weights: null,
          solverStatus: 'OPTIMAL',
          lessonCount: 40,
          errorCode: null,
          errorParams: null,
          metrics: { moved: 3, movedOf: 40, roomChanges: 1, kept: 37, sameAs: null },
          conflicts: [],
          notes: [shownWish],
        });
        // Whose wish, named for every reader; the id stays on the server.
        expect(response.body.draftNotes).toEqual([shownWish]);
        expect(response.text).not.toMatch(new RegExp(`subjectIds|${BO}`));
      }
    });

    it('refuses a year that is no uuid', async () => {
      await request(http()).get('/api/v1/optimization/candidates?academicYearId=current').set('x-test-user', admin()).expect(400);
    });
  });

  describe('GET /api/v1/optimization/candidates/:id/lessons', () => {
    it('answers the MasterLesson shape resolved from the timplanspost, with no pupil in it', async () => {
      harness.tx['scheduleCandidate']!['findUnique']!.mockResolvedValue({
        lessons: [{ requirementId: 'req-1', roomId: null, dayOfWeek: 2, startTime: '09:00', endTime: '10:00' }],
      });
      harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([
        { id: 'req-1', subjectId: SUBJECT_ID, studentGroupId: GROUP_ID, teacherId: null, coTeacherId: null, recurrence: 'ALL_WEEKS', startDate: null, endDate: null },
      ]);
      const response = await request(http())
        .get(`/api/v1/optimization/candidates/${CANDIDATE_ID}/lessons`)
        .set('x-test-user', admin())
        .expect(200);
      expect(response.body).toEqual([
        {
          requirementId: 'req-1',
          subjectId: SUBJECT_ID,
          studentGroupId: GROUP_ID,
          teacherId: null,
          coTeacherId: null,
          roomId: null,
          dayOfWeek: 2,
          startTime: '09:00',
          endTime: '10:00',
          recurrence: 'ALL_WEEKS',
          startDate: null,
          endDate: null,
        },
      ]);
      expect(JSON.stringify(response.body)).not.toMatch(/studentIds|participants/);
    });

    it('answers 404 CANDIDATE_GONE for a candidate that is not there', async () => {
      harness.tx['scheduleCandidate']!['findUnique']!.mockResolvedValue(null);
      const response = await request(http())
        .get(`/api/v1/optimization/candidates/${CANDIDATE_ID}/lessons`)
        .set('x-test-user', admin())
        .expect(404);
      expect(response.body).toMatchObject({ code: 'CANDIDATE_GONE' });
    });
  });

  describe('the check and the apply, through the real fetch and write', () => {
    /** The basis this harness's (empty) school hashes to, through the real proxy. */
    let basis: { basis: string; basisParts: unknown };

    beforeEach(async () => {
      harness.tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR_ID, schoolId: SCHOOL_ID, isActive: true, predecessorId: null });
      const prepared = await harness.app
        .get(OptimizationProxyService)
        .prepareSchedule(harness.tx as never, YEAR_ID, JSON.parse(admin()));
      if (!prepared.ready) throw new Error('The harness school was refused before the engine.');
      basis = { basis: prepared.basis, basisParts: prepared.basisParts };
      jest.clearAllMocks();
      harness.tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR_ID, schoolId: SCHOOL_ID, isActive: true, predecessorId: null });
    });

    const candidate = (overrides: Record<string, unknown> = {}) => ({
      id: CANDIDATE_ID,
      runId: RUN_ID,
      ordinal: 2,
      variant: 'TEACHER_GAPS',
      solverStatus: 'OPTIMAL',
      // Nothing to place in an empty school: the write's guard holds it to the demand.
      lessons: [],
      lunches: null,
      metrics: { moved: 0, movedOf: 0, kept: 0, roomChanges: 0, sameAs: null, lessonCount: 0, unplaced: null },
      run: { academicYearId: YEAR_ID },
      ...overrides,
    });

    it('checks a batch against the draft as it is: fresh, in DRAFT, nothing taken off the calendar', async () => {
      harness.tx['scheduleCandidateRun']!['findUnique']!.mockResolvedValue({ academicYearId: YEAR_ID, ...basis });
      const response = await request(http())
        .get(`/api/v1/optimization/candidates/runs/${RUN_ID}/check`)
        .set('x-test-user', admin())
        .expect(200);
      expect(response.body).toEqual({ stale: false, changed: [], refusalCode: null, mode: 'DRAFT', futureCalendarLessons: 0, coverAssignments: 0 });
      // Not READ ONLY since Lärarens dag: the fetch writes its Läslogg row for
      // the posts' day limits it reads. Nothing of the timetable is written.
      expect(harness.tx.$executeRaw.mock.calls.map((call) => sqlOf(call))).not.toContain('SET TRANSACTION READ ONLY');
      expect(harness.tx['masterLesson']!['deleteMany']).not.toHaveBeenCalled();
      expect(harness.tx['masterLesson']!['createMany']).not.toHaveBeenCalled();
    });

    it('applies a candidate in DRAFT: the safety version first, the write, the change log, the run marked applied', async () => {
      harness.tx['scheduleCandidate']!['findUnique']!.mockResolvedValue(candidate());
      harness.tx['scheduleCandidateRun']!['findUnique']!.mockResolvedValue({
        id: RUN_ID,
        status: 'SUCCEEDED',
        createdAt: new Date('2026-10-17T08:00:00.000Z'),
        ...basis,
      });
      harness.tx['scheduleVersion']!['create']!.mockResolvedValue({
        id: 'version-1',
        academicYearId: YEAR_ID,
        name: 'Före schemaförslag 2 – Färre håltimmar för lärarna',
        lessonCount: 0,
        createdAt: new Date(),
      });
      harness.tx['masterLesson']!['deleteMany']!.mockResolvedValue({ count: 0 });
      harness.tx['masterLesson']!['count']!.mockResolvedValue(0);

      const response = await request(http())
        .post(`/api/v1/optimization/candidates/${CANDIDATE_ID}/apply`)
        .set('x-test-user', admin())
        .send({ expectedMode: 'DRAFT' })
        .expect(200);

      expect(response.body).toEqual({ lessonsCreated: 0, versionId: 'version-1' });
      expect(harness.tx['scheduleVersion']!['create']).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'Före schemaförslag 2 – Färre håltimmar för lärarna' }) }),
      );
      expect(harness.tx['scheduleChangeLog']!['create']).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'REGENERATE',
          after: expect.objectContaining({ source: 'CANDIDATE', runId: RUN_ID, ordinal: 2, variant: 'TEACHER_GAPS', solverStatus: 'OPTIMAL' }),
        }),
      });
      // DRAFT: the calendar keeps its published rows until the next publish.
      expect(harness.tx['calendarLesson']!['deleteMany']).not.toHaveBeenCalled();
      expect(harness.tx['scheduleCandidateRun']!['update']).toHaveBeenCalledWith({
        where: { id: RUN_ID },
        data: { appliedCandidateId: CANDIDATE_ID, appliedAt: expect.any(Date) },
      });
      const locks = harness.tx.$executeRaw.mock.calls.map(sqlOf).filter((sql) => sql.includes('pg_advisory_xact_lock'));
      expect(locks.map((sql) => /hashtext\('([a-z-]+)'\)/.exec(sql)?.[1])).toEqual([
        'grundschema-regenerate',
        'room-optimization',
        'staffing-proposal',
      ]);
    });

    it('answers 409 SCHEDULE_CANDIDATE_STALE with the parts that changed as params, which survive the problem filter', async () => {
      harness.tx['scheduleCandidate']!['findUnique']!.mockResolvedValue(candidate());
      harness.tx['scheduleCandidateRun']!['findUnique']!.mockResolvedValue({
        id: RUN_ID,
        status: 'SUCCEEDED',
        createdAt: new Date('2026-10-17T08:00:00.000Z'),
        basis: 'f'.repeat(64),
        basisParts: { ...(basis.basisParts as Record<string, string>), rooms: '0'.repeat(64) },
      });
      const response = await request(http())
        .post(`/api/v1/optimization/candidates/${CANDIDATE_ID}/apply`)
        .set('x-test-user', admin())
        .send({ expectedMode: 'DRAFT' })
        .expect(409);
      expect(response.body).toMatchObject({ code: 'SCHEDULE_CANDIDATE_STALE', params: { changed: 'rooms' } });
      expect(harness.tx['scheduleVersion']!['create']).not.toHaveBeenCalled();
    });

    it('answers 409 PUBLISH_MODE_CHANGED with the mode now, before any year lock', async () => {
      harness.tx['scheduleCandidate']!['findUnique']!.mockResolvedValue(candidate());
      const response = await request(http())
        .post(`/api/v1/optimization/candidates/${CANDIDATE_ID}/apply`)
        .set('x-test-user', admin())
        .send({ expectedMode: 'DIRECT' })
        .expect(409);
      expect(response.body).toMatchObject({ code: 'PUBLISH_MODE_CHANGED', params: { mode: 'DRAFT' } });
      expect(harness.tx.$executeRaw.mock.calls.map(sqlOf).some((sql) => sql.includes('grundschema-regenerate'))).toBe(false);
    });

    it('refuses an apply without a mode, and an administrator without Schemaläggning and Drift', async () => {
      await request(http())
        .post(`/api/v1/optimization/candidates/${CANDIDATE_ID}/apply`)
        .set('x-test-user', admin())
        .send({})
        .expect(400);
      const refused = await request(http())
        .post(`/api/v1/optimization/candidates/${CANDIDATE_ID}/apply`)
        .set('x-test-user', as('EXPEDITION'))
        .send({ expectedMode: 'DRAFT' })
        .expect(403);
      expect(refused.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
      expect(harness.tx['scheduleCandidate']!['findUnique']).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/v1/optimization/candidates', () => {
    it('answers 204: the active run asked to stop, the finished ones deleted', async () => {
      harness.tx['scheduleCandidateRun']!['updateMany']!.mockResolvedValue({ count: 1 });
      harness.tx['scheduleCandidateRun']!['deleteMany']!.mockResolvedValue({ count: 2 });
      await request(http())
        .delete(`/api/v1/optimization/candidates?academicYearId=${YEAR_ID}`)
        .set('x-test-user', admin())
        .expect(204);
      expect(harness.tx['scheduleCandidateRun']!['updateMany']).toHaveBeenCalledWith({
        where: { academicYearId: YEAR_ID, status: { in: ['PENDING', 'RUNNING'] } },
        data: { status: 'CANCELLING' },
      });
      expect(harness.tx['scheduleCandidateRun']!['deleteMany']).toHaveBeenCalledWith({
        where: {
          academicYearId: YEAR_ID,
          status: { in: ['SUCCEEDED', 'FAILED'] },
          // Never a run whose engine call can still be solving (its cap place).
          OR: [{ engineBusyUntil: null }, { engineBusyUntil: { lte: expect.any(Date) } }],
        },
      });
    });

    it('refuses an administrator without Schemaläggning', async () => {
      await request(http())
        .delete(`/api/v1/optimization/candidates?academicYearId=${YEAR_ID}`)
        .set('x-test-user', as('EXPEDITION'))
        .expect(403);
      expect(harness.tx['scheduleCandidateRun']!['deleteMany']).not.toHaveBeenCalled();
    });
  });

  describe('the läsare (Läsbehörighet)', () => {
    it('never starts, refreshes, discards or applies: each is 403 AREA_NOT_YOURS before anything is read or written', async () => {
      const reader = as('LASARE');
      const writes = [
        () => request(http()).post('/api/v1/optimization/candidates').set('x-test-user', reader).send({ academicYearId: YEAR_ID }),
        () =>
          request(http())
            .post('/api/v1/optimization/candidates')
            .set('x-test-user', reader)
            .send({ academicYearId: YEAR_ID, refreshOf: RUN_ID }),
        () => request(http()).delete(`/api/v1/optimization/candidates?academicYearId=${YEAR_ID}`).set('x-test-user', reader),
        () =>
          request(http())
            .post(`/api/v1/optimization/candidates/${CANDIDATE_ID}/apply`)
            .set('x-test-user', reader)
            .send({ expectedMode: 'DRAFT' }),
      ];
      for (const write of writes) {
        const refused = await write().expect(403);
        expect(refused.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
      }
      expect(harness.tx['scheduleCandidateRun']!['create']).not.toHaveBeenCalled();
      expect(harness.tx['scheduleCandidateRun']!['deleteMany']).not.toHaveBeenCalled();
      expect(harness.tx['scheduleCandidate']!['findUnique']).not.toHaveBeenCalled();
    });
  });
});
