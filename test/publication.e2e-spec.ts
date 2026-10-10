import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Publicering over HTTP: the routes resolve, the DTOs take what the admin's
 * dialog sends and refuse what it must not, every route is the admin's, and
 * the old POST /calendar/publish still answers exactly what it answered.
 *
 * The database is mocked here, as in every e2e spec; what the rows do under
 * RLS is section 27 of scripts/test/rls-policies.sql, and the services'
 * transactions against Postgres are the adapter probe's.
 */

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const time = (h: number) => new Date(Date.UTC(1970, 0, 1, h));

describe('Publicering (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const admin = () => asUser({ role: 'SCHOOL_ADMIN' as never });

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    const { tx } = harness;
    jest.clearAllMocks();
    tx.academicYear.findUnique.mockResolvedValue({
      id: YEAR_ID,
      startDate: day('2026-08-17'),
      endDate: day('2027-06-11'),
      isActive: true,
      predecessorId: null,
      school: { timezone: 'Europe/Stockholm' },
    });
    tx.publicationSettings.findUnique.mockResolvedValue(null);
    tx.lunchSetting.findUnique.mockResolvedValue({ lunchEnabled: true });
    tx.staffingPolicy.findUnique.mockResolvedValue(null);
    tx.masterLesson.findMany.mockResolvedValue([
      {
        id: '55555555-5555-4555-8555-555555555555',
        subjectId: 'sub',
        studentGroupId: 'grp',
        teacherId: 'tea',
        coTeacherId: null,
        roomId: 'room',
        dayOfWeek: 1,
        startTime: time(8),
        endTime: time(9),
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        isParked: false,
        extraGroups: [],
        participants: [],
        subject: { name: 'Matematik' },
        studentGroup: { name: '7B' },
      },
    ]);
    tx.calendarLesson.create.mockResolvedValue({ id: 'cl' });
    tx.timetablePublication.findMany.mockResolvedValue([]);
    tx.timetablePublication.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'pub-1',
      kind: data.kind,
      outcome: data.outcome,
      publishMode: data.publishMode,
      validFrom: data.validFrom,
      validTo: data.validTo,
      publishedAt: new Date('2026-10-12T08:00:00Z'),
      publishedByUserId: data.publishedByUserId ?? null,
      created: data.created ?? 0,
      cancelled: data.cancelled ?? 0,
      skipped: data.skipped ?? 0,
      moved: 0,
      removed: 0,
      adopted: 0,
      lessonCount: null,
      gates: data.gates ?? [],
      acknowledgedWarnings: data.acknowledgedWarnings ?? false,
    }));
    tx.publicationSettings.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
      publishMode: 'DIRECT',
      gateClashes: 'WARN',
      gateParked: 'WARN',
      gateUnplaced: 'WARN',
      gateUnstaffed: 'WARN',
      gateMissingTeacher: 'WARN',
      gateMissingRoom: 'WARN',
      gateStaffing: 'WARN',
      gateTimplan: 'WARN',
      gateOverlap: 'WARN',
      gatePast: 'WARN',
      gateLunch: 'WARN',
      gateWeekSplit: 'WARN',
      gateGap: 'WARN',
      gateDayOpsLost: 'WARN',
      ...create,
    }));
  });

  describe('the admin round trip', () => {
    it('reads the defaults, stores a REFUSE and reads it back', async () => {
      const before = await request(http()).get('/api/v1/publication-settings').set('x-test-user', admin()).expect(200);
      expect(before.body).toMatchObject({ publishMode: 'DIRECT', gateClashes: 'WARN', stored: false });

      const put = await request(http())
        .put('/api/v1/publication-settings')
        .set('x-test-user', admin())
        .send({ gateMissingRoom: 'REFUSE' })
        .expect(200);
      expect(put.body).toMatchObject({ gateMissingRoom: 'REFUSE', gateClashes: 'WARN', stored: true });
      expect(harness.tx.publicationSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { gateMissingRoom: 'REFUSE' } }),
      );
    });

    it('refuses a gate mode that is not WARN or REFUSE, and a field that is not a gate', async () => {
      await request(http())
        .put('/api/v1/publication-settings')
        .set('x-test-user', admin())
        .send({ gateClashes: 'IGNORE' })
        .expect(400);
      await request(http())
        .put('/api/v1/publication-settings')
        .set('x-test-user', admin())
        .send({ publishMode: 'DRAFT' })
        .expect(400);
    });

    it('previews, then publishes what it previewed, with its validity', async () => {
      const preview = await request(http())
        .post('/api/v1/publications/preview')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, validFrom: '2026-11-02', validTo: '2026-12-18' })
        .expect(200);
      expect(preview.body).toMatchObject({ validFrom: '2026-11-02', validTo: '2026-12-18', refused: false });
      expect(harness.tx.timetablePublication.create).not.toHaveBeenCalled();

      const published = await request(http())
        .post('/api/v1/publications')
        .set('x-test-user', admin())
        .send({
          academicYearId: YEAR_ID,
          validFrom: '2026-11-02',
          validTo: '2026-12-18',
          expectedDigest: preview.body.digest,
          // Run after 2 November and the range starts in the past: a warning.
          acknowledgeWarnings: true,
        })
        .expect(200);
      expect(published.body.publication).toMatchObject({
        kind: 'PUBLISH',
        outcome: 'PUBLISHED',
        validFrom: '2026-11-02',
        validTo: '2026-12-18',
      });
    });

    it('lists the timeline', async () => {
      const response = await request(http())
        .get(`/api/v1/publications?academicYearId=${YEAR_ID}`)
        .set('x-test-user', admin())
        .expect(200);
      expect(response.body).toMatchObject({ academicYearId: YEAR_ID, publications: [], segments: [], validNow: null });
    });

    it('answers 409 with the code when the school refuses, and 409 when a warning is not acknowledged', async () => {
      harness.tx.publicationSettings.findUnique.mockResolvedValue({ publishMode: 'DIRECT', gateLunch: 'REFUSE' });
      harness.tx.lunchSetting.findUnique.mockResolvedValue({ lunchEnabled: false });
      const refused = await request(http())
        .post('/api/v1/publications')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, acknowledgeWarnings: true })
        .expect(409);
      expect(refused.body).toMatchObject({ code: 'PUBLISH_GATES_REFUSED', params: { refused: 'PUB_LUNCH_NOT_SET' } });

      harness.tx.publicationSettings.findUnique.mockResolvedValue(null);
      const unacknowledged = await request(http())
        .post('/api/v1/publications')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID })
        .expect(409);
      expect(unacknowledged.body).toMatchObject({ code: 'PUBLISH_WARNINGS_UNACKNOWLEDGED' });
    });

    it('refuses a malformed range and a digest that is not one', async () => {
      await request(http())
        .post('/api/v1/publications/preview')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, validFrom: '12/11/2026' })
        .expect(400);
      await request(http())
        .post('/api/v1/publications')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, expectedDigest: 'abc' })
        .expect(400);
    });

    it('keeps the old POST /calendar/publish answer, and logs it', async () => {
      const response = await request(http())
        .post('/api/v1/calendar/publish')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, fromDate: '2026-11-02', toDate: '2026-11-08' })
        .expect(200);
      expect(Object.keys(response.body).sort()).toEqual(['cancelled', 'created', 'fromDate', 'skipped', 'toDate']);
      expect(response.body).toMatchObject({ created: 1, fromDate: '2026-11-02', toDate: '2026-11-08' });
      expect(harness.tx.timetablePublication.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ kind: 'LEGACY_PUBLISH', validFrom: day('2026-11-02'), validTo: day('2026-11-08') }),
        }),
      );
    });
  });

  describe('the draft layer', () => {
    it('switches to DRAFT, recording a BASELINE per year with a grundschema', async () => {
      harness.tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
      harness.tx.academicYear.findMany.mockResolvedValue([
        { id: YEAR_ID, name: '2026/27', startDate: day('2026-08-17'), endDate: day('2027-06-11') },
      ]);
      harness.tx.publishedLesson.createMany.mockResolvedValue({ count: 1 });
      const response = await request(http())
        .post('/api/v1/publication-settings/mode')
        .set('x-test-user', admin())
        .send({ publishMode: 'DRAFT' })
        .expect(200);
      expect(response.body.publishMode).toBe('DRAFT');
      expect(response.body.baselines).toEqual([
        expect.objectContaining({ academicYearId: YEAR_ID, validTo: '2027-06-11', lessonCount: 1 }),
      ]);
      expect(harness.tx.timetablePublication.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ kind: 'BASELINE', publishMode: 'DRAFT', lessonCount: 1 }) }),
      );
      // The exclusive lock first.
      expect(harness.tx.$queryRaw.mock.calls[0]![0].strings.join('?')).toContain('app.enter_publication');
    });

    it('refuses a mode that is not DIRECT or DRAFT', async () => {
      await request(http())
        .post('/api/v1/publication-settings/mode')
        .set('x-test-user', admin())
        .send({ publishMode: 'LIVE' })
        .expect(400);
    });

    it('answers the draft state against what is published', async () => {
      harness.tx.publicationPendingRemoval.count.mockResolvedValue(0);
      const response = await request(http())
        .get(`/api/v1/publications/state?academicYearId=${YEAR_ID}`)
        .set('x-test-user', admin())
        .expect(200);
      expect(response.body).toMatchObject({ academicYearId: YEAR_ID, publishMode: 'DIRECT', pendingRemovals: 0 });
      expect(response.body.added).toHaveLength(1);
    });

    it('refuses discard and refill to a DIRECT school, and the old route to a DRAFT one', async () => {
      const discard = await request(http())
        .post('/api/v1/publications/discard')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID })
        .expect(409);
      expect(discard.body.code).toBe('PUBLISH_NOT_DRAFT');
      const refill = await request(http())
        .post('/api/v1/publications/refill')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID })
        .expect(409);
      expect(refill.body.code).toBe('PUBLISH_NOT_DRAFT');

      harness.tx.publicationSettings.findUnique.mockResolvedValue({ publishMode: 'DRAFT' });
      const legacy = await request(http())
        .post('/api/v1/calendar/publish')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID })
        .expect(409);
      expect(legacy.body.code).toBe('PUBLISH_MODE_DRAFT');
      expect(harness.tx.calendarLesson.create).not.toHaveBeenCalled();
    });

    it('never publishes a draft from a day that has begun', async () => {
      harness.tx.publicationSettings.findUnique.mockResolvedValue({ publishMode: 'DRAFT' });
      const response = await request(http())
        .post('/api/v1/publications/preview')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR_ID, validFrom: '2026-08-17' })
        .expect(400);
      expect(response.body.code).toBe('PUBLISH_FROM_IN_PAST');
    });
  });

  describe('every route is the admin\'s', () => {
    const routes = [
      ['GET', '/api/v1/publication-settings'],
      ['PUT', '/api/v1/publication-settings'],
      ['POST', '/api/v1/publication-settings/mode'],
      ['GET', `/api/v1/publications?academicYearId=${YEAR_ID}`],
      ['GET', `/api/v1/publications/state?academicYearId=${YEAR_ID}`],
      ['POST', '/api/v1/publications/preview'],
      ['POST', '/api/v1/publications'],
      ['POST', '/api/v1/publications/discard'],
      ['POST', '/api/v1/publications/refill'],
      ['POST', '/api/v1/calendar/publish'],
    ] as const;
    const send = (method: string, path: string) => {
      const agent = request(http());
      return method === 'GET' ? agent.get(path) : method === 'PUT' ? agent.put(path) : agent.post(path);
    };

    it.each(
      routes.flatMap(([method, path]) => (['TEACHER', 'STUDENT', 'GUARDIAN'] as const).map((role) => [role, method, path])),
    )('refuses a %s on %s %s', async (role, method, path) => {
      await send(method, path)
        .set('x-test-user', asUser({ role: role as never }))
        .send({ academicYearId: YEAR_ID })
        .expect(403);
      expect(harness.tx.timetablePublication.create).not.toHaveBeenCalled();
    });

    it.each(routes)('refuses %s %s without a principal', async (method, path) => {
      await send(method, path).send({ academicYearId: YEAR_ID }).expect(401);
    });
  });
});
