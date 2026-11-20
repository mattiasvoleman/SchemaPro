import request from 'supertest';
import { of } from 'rxjs';
import { Role } from '../src/auth/enums/role.enum';
import { BASIS_PARTS, type BasisParts } from '../src/optimization/candidate-basis';
import type { AiEngineWeekBoundsResponse } from '../src/optimization/interfaces/staffing-search.interface';
import { OptimizationProxyService } from '../src/optimization/optimization-proxy.service';
import { StaffingProposalService, type Plan, type RowPlan, type TeacherPlan } from '../src/optimization/staffing-proposal.service';
import { weekBasisOf, withWeekBasis } from '../src/optimization/staffing-week';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Lärarval F3 over HTTP: the search for the choice of teachers that eases the week, through the real routing table, validation
 * pipe, RolesGuard with the areas, the problem filter, the real service (its task, its lease writes, its proposal) and the real
 * week route, with the school's read and the engine's counts stood in for.
 *
 * What a unit spec cannot see is pinned here: that an administrator without Schemaläggning and a teacher are refused before
 * anything is read, that a 409's code survives the problem filter, that the whole round trip (start, the task's calls to the
 * engine's own route, the poll, the proposal, and the week route that takes its digest) hangs together, and that a proposal
 * is answered 409 STAFF_PROPOSAL_STALE when the week it counted is no longer the school's.
 */

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const RUN_ID = '55555555-5555-4555-8555-555555555555';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const STAFFING_BASIS = 'a'.repeat(64);

const real = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const anon = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TEACHERS = {
  a: { real: 'a1a1a1a1-0000-4000-8000-0000000000a1', engine: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  b: { real: 'b2b2b2b2-0000-4000-8000-0000000000b2', engine: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
};
const CAPACITY = 1000;

const post = (n: number) => ({
  id: anon(n),
  subjectId: 'engine-subject',
  studentGroupId: 'engine-group',
  teacherId: TEACHERS.a.engine,
  lessonsPerWeek: 1,
  minutesPerLesson: 200,
  minutesBefore: 0,
  minutesAfter: 0,
  studentGroupSize: 20,
  requiredRoomType: null,
  coTeacherId: null,
  minGradeLevel: 9,
  maxGradeLevel: 9,
});

const planned = (n: number): RowPlan =>
  ({
    row: { id: real(n) },
    kind: 'KEPT',
    inconsistent: false,
    vacated: false,
    current: TEACHERS.a.real,
    co: null,
    chargeExact: 10,
    chargeTenths: 100,
    lessonMinutes: 200,
    eligible: [TEACHERS.a.real, TEACHERS.b.real],
    lastYear: [],
    excluded: [],
  }) as unknown as RowPlan;
const teacher = (userId: string): TeacherPlan =>
  ({ userId, target: 1000, targetTenths: 10000, limitTenths: 100000, floorTenths: 0, fixedTenths: 0, currentTenths: 300, keepOrShed: false }) as TeacherPlan;

/** A week of year 9: 700 and what the busiest teacher's posts add up to, in the engine's own row shape. */
function bounds(payload: { requestId: string; requirements: { teacherId: string; lessonsPerWeek: number; minutesPerLesson: number }[]; years?: number[] }): AiEngineWeekBoundsResponse {
  const perTeacher = new Map<string, number>();
  for (const entry of payload.requirements) {
    perTeacher.set(entry.teacherId, (perTeacher.get(entry.teacherId) ?? 0) + entry.lessonsPerWeek * entry.minutesPerLesson);
  }
  const demand = 700 + Math.max(0, ...perTeacher.values());
  return {
    requestId: payload.requestId,
    weeksTotal: 1,
    weeksCounted: 1,
    rows: (payload.years ?? [9]).map((year) => ({ year, period: null, parity: null, demandMinutes: demand, capacityMinutes: CAPACITY, over: demand > CAPACITY, converged: true, cutoff: false })),
    refusal: null,
    deadlineHit: false,
    elapsedMs: 1,
  };
}

const parts = (): BasisParts => Object.fromEntries(BASIS_PARTS.map((part) => [part, `${part}-digest`])) as unknown as BasisParts;

describe('Lärarval F3: sökningen (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const admin = () => asUser({});
  const as = (adminProfile: string) => asUser({ adminProfile } as never);
  const settle = async () => {
    for (let turn = 0; turn < 60; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  let proxy: OptimizationProxyService;
  let staffing: StaffingProposalService;
  let weekParts: BasisParts;
  let plan: Plan;

  beforeAll(async () => {
    harness = await createTestApp();
    proxy = harness.app.get(OptimizationProxyService);
    staffing = harness.app.get(StaffingProposalService);
  });
  afterAll(async () => {
    await harness.close();
  });

  const run = (patch: Record<string, unknown> = {}) => ({
    id: RUN_ID,
    schoolId: SCHOOL_ID,
    academicYearId: YEAR_ID,
    status: 'SUCCEEDED',
    stopReason: 'LOCAL_OPTIMUM',
    options: { pinnedRequirementIds: [] },
    staffingBasis: STAFFING_BASIS,
    weekBasis: weekBasisOf(parts()),
    round: 4,
    evaluations: 31,
    acceptedMoves: 1,
    figures: { years: [{ year: 9, weeks: [{ period: null, parity: null, from: null, to: null, before: { demandMinutes: 1300, capacityMinutes: CAPACITY }, after: { demandMinutes: 1100, capacityMinutes: CAPACITY } }] }], leftOut: { posts: [{ reason: 'UNSTAFFED', count: 2 }], years: [{ year: 8, reason: 'YEAR_LIMIT' }] } },
    checkpoint: { changes: [{ requirementId: real(1), fromTeacherId: TEACHERS.a.real, toTeacherId: TEACHERS.b.real }], tally: { better: 1, notBetter: 9, worse: 2, refused: 0, unranked: 1 } },
    error: null,
    errorCode: null,
    errorParams: null,
    claimedBy: 'x',
    leaseUntil: new Date(Date.now() - 1_000),
    createdAt: new Date(Date.now() - 600_000),
    startedAt: new Date(Date.now() - 590_000),
    finishedAt: new Date(Date.now() - 10_000),
    ...patch,
  });

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    weekParts = parts();
    plan = {
      recorded: true,
      respect: true,
      respectForcedByPolicy: false,
      tolerance: 10,
      staff: new Set([TEACHERS.a.real, TEACHERS.b.real]),
      candidates: new Set([TEACHERS.a.real, TEACHERS.b.real]),
      teachers: [teacher(TEACHERS.a.real), teacher(TEACHERS.b.real)],
      teacherById: new Map([
        [TEACHERS.a.real, teacher(TEACHERS.a.real)],
        [TEACHERS.b.real, teacher(TEACHERS.b.real)],
      ]),
      rows: [planned(1), planned(2), planned(3)],
      rowById: new Map([planned(1), planned(2), planned(3)].map((r) => [r.row.id, r])),
      pinned: [],
    } as unknown as Plan;
    harness.tx['optimizationJob']!['count']!.mockResolvedValue(0);
    harness.tx['staffingSearchRun']!['count']!.mockResolvedValue(0);
    harness.tx['staffingSearchRun']!['deleteMany']!.mockResolvedValue({ count: 0 });
    harness.tx['staffingSearchRun']!['create']!.mockResolvedValue({ id: RUN_ID });
    harness.tx['staffingSearchRun']!['updateMany']!.mockResolvedValue({ count: 1 });
    harness.tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR_ID, gradeNumbering: 'NIOARIG' });
    harness.tx.$queryRaw = jest.fn(async () => [{ status: 'RUNNING' }]);
    harness.tx.$executeRaw = jest.fn(async () => 1);
    jest.spyOn(staffing, 'readPlan').mockImplementation(async () => ({ state: { read: { input: { requirements: [], duties: [], employments: [], qualifications: [], closures: [] } } } as never, plan, basisSha256: STAFFING_BASIS }));
    jest.spyOn(proxy, 'prepareSchedule').mockImplementation(async () =>
      ({
        ready: true,
        payload: { requestId: 'q', academicYearId: YEAR_ID, requirements: [post(1), post(2), post(3)], rooms: [], constraints: [], teacherWorkRules: [], groupConflicts: [] },
        storedRules: null,
        anonMaps: { requirementAnonMap: new Map([1, 2, 3].map((n) => [real(n), anon(n)])) },
        teacherAnonMap: new Map([
          [TEACHERS.a.real, TEACHERS.a.engine],
          [TEACHERS.b.real, TEACHERS.b.engine],
        ]),
        basisParts: weekParts,
        periodStretches: null,
      }) as never,
    );
    harness.http.post.mockImplementation((_url: string, body: never) => of({ data: bounds(body) }));
  });

  describe('who may start a search', () => {
    it('is refused to a teacher and to an administrator who does not write Schemaläggning, before anything is read', async () => {
      await request(http()).post('/api/v1/optimization/staffing/search').set('x-test-user', asUser({ role: Role.TEACHER })).send({ academicYearId: YEAR_ID }).expect(403);
      for (const profile of ['EXPEDITION', 'LASARE']) {
        await request(http()).post('/api/v1/optimization/staffing/search').set('x-test-user', as(profile)).send({ academicYearId: YEAR_ID }).expect(403);
      }
      expect(staffing.readPlan).not.toHaveBeenCalled();
      expect(harness.http.post).not.toHaveBeenCalled();
    });

    it('is refused a body that is not a year and the posts pinned, as every route of this controller', async () => {
      await request(http()).post('/api/v1/optimization/staffing/search').set('x-test-user', admin()).send({ academicYearId: 'not-a-uuid' }).expect(400);
      await request(http()).post('/api/v1/optimization/staffing/search').set('x-test-user', admin()).send({ academicYearId: YEAR_ID, pinnedRequirementIds: ['nope'] }).expect(400);
      await request(http()).post('/api/v1/optimization/staffing/search').set('x-test-user', admin()).send({}).expect(400);
    });

    it('lets every administrator read, as the table\'s select arm does, and refuses the cancel to one who does not write Schemaläggning', async () => {
      harness.tx['staffingSearchRun']!['findFirst']!.mockResolvedValue(null);
      for (const profile of ['EXPEDITION', 'LASARE']) {
        await request(http()).get(`/api/v1/optimization/staffing/search/latest?academicYearId=${YEAR_ID}`).set('x-test-user', as(profile)).expect(200);
        await request(http()).post(`/api/v1/optimization/staffing/search/${RUN_ID}/cancel`).set('x-test-user', as(profile)).expect(403);
      }
      await request(http()).get(`/api/v1/optimization/staffing/search/latest?academicYearId=${YEAR_ID}`).set('x-test-user', asUser({ role: Role.TEACHER })).expect(403);
      expect(harness.tx['staffingSearchRun']!['updateMany']).not.toHaveBeenCalled();
    });

    it('is refused a run that is not a uuid, and a year that is not given', async () => {
      await request(http()).get('/api/v1/optimization/staffing/search/not-a-uuid').set('x-test-user', admin()).expect(400);
      await request(http()).get('/api/v1/optimization/staffing/search/latest').set('x-test-user', admin()).expect(400);
    });
  });

  describe('the round trip', () => {
    it('starts (202), counts the years and the candidates by the engine\'s own route, and ends with its best state kept', async () => {
      const started = await request(http()).post('/api/v1/optimization/staffing/search').set('x-test-user', admin()).send({ academicYearId: YEAR_ID }).expect(202);
      await settle();

      expect(started.body).toEqual({ runId: RUN_ID });
      const calls = harness.http.post.mock.calls as [string, { years: number[]; seconds: number; cutoffs?: unknown[] }, { headers: Record<string, string> }][];
      expect(calls.length).toBeGreaterThan(1);
      expect(calls.every(([url]) => String(url).endsWith('/api/v1/week-bounds'))).toBe(true);
      expect(calls[0]![1]).toMatchObject({ years: [9], seconds: 25 });
      expect(calls[0]![1].cutoffs).toBeUndefined();
      expect(calls[1]![1].cutoffs).toEqual([{ year: 9, demandMinutes: 1300, capacityMinutes: CAPACITY }]);
      // The service's key goes with every call, and the payload carries no real id of a teacher.
      expect(calls.every(([, , options]) => typeof options.headers['X-API-Key'] === 'string')).toBe(true);
      expect(JSON.stringify(calls.map(([, body]) => body))).not.toContain(TEACHERS.b.real);
      // The task's own writes: the first heartbeat, the checkpoint after each accepted move, the finish.
      const sql = (harness.tx.$executeRaw.mock.calls as unknown[][]).map((args) => ((args[0] as { strings?: string[] }).strings ?? []).join('?'));
      expect(sql.some((text) => text.includes('"checkpoint" = ?::jsonb') && text.includes('"acceptedMoves"'))).toBe(true);
      expect(sql.at(-1)).toContain('"finishedAt" = now()');
    });

    it('is answered by a poll with the counters and the figures, and by the proposal once it has ended', async () => {
      harness.tx['staffingSearchRun']!['findFirst']!.mockResolvedValue(run());
      harness.tx['staffingSearchRun']!['findUnique']!.mockResolvedValue(run());
      const echoed = jest.spyOn(staffing, 'proposalFromLeads').mockImplementation(((_s: unknown, _p: unknown, leads: Map<string, string>, basis: string) => ({ basisSha256: basis, leads: [...leads] })) as never);

      const latest = await request(http()).get(`/api/v1/optimization/staffing/search/latest?academicYearId=${YEAR_ID}`).set('x-test-user', admin()).expect(200);
      expect(latest.body).toMatchObject({ id: RUN_ID, status: 'SUCCEEDED', stopReason: 'LOCAL_OPTIMUM', round: 4, evaluations: 31, acceptedMoves: 1, hasProposal: true });
      // The figures are in the school's numbering and carry no name or id.
      expect(latest.body.figures.years[0].year).toBe(9);
      // And what the search left out is said, with its reasons: two posts nobody leads, a year past the limit.
      expect(latest.body.figures.leftOut).toEqual({ posts: [{ reason: 'UNSTAFFED', count: 2 }], years: [{ year: 8, reason: 'YEAR_LIMIT' }] });
      expect(JSON.stringify(latest.body)).not.toContain(TEACHERS.a.real);

      const one = await request(http()).get(`/api/v1/optimization/staffing/search/${RUN_ID}`).set('x-test-user', admin()).expect(200);
      expect(one.body.id).toBe(RUN_ID);

      const proposed = await request(http()).get(`/api/v1/optimization/staffing/search/${RUN_ID}/proposal`).set('x-test-user', admin()).expect(200);
      expect(proposed.body.proposal.basisSha256).toBe(withWeekBasis(STAFFING_BASIS, weekBasisOf(weekParts)));
      // The proposal carries the same account of what was left out.
      expect(proposed.body.figures.leftOut).toEqual({ posts: [{ reason: 'UNSTAFFED', count: 2 }], years: [{ year: 8, reason: 'YEAR_LIMIT' }] });
      const leads = new Map<string, string>(proposed.body.proposal.leads);
      expect(leads.get(real(1))).toBe(TEACHERS.b.real);
      expect(leads.get(real(2))).toBe(TEACHERS.a.real);
      expect(echoed).toHaveBeenCalledTimes(1);
    });

    it('is a 404 with its code for a run that is gone, and an empty answer for a year that has none', async () => {
      harness.tx['staffingSearchRun']!['findUnique']!.mockResolvedValue(null);
      harness.tx['staffingSearchRun']!['findFirst']!.mockResolvedValue(null);

      const gone = await request(http()).get(`/api/v1/optimization/staffing/search/${RUN_ID}`).set('x-test-user', admin()).expect(404);
      expect(gone.body).toMatchObject({ code: 'STAFFING_SEARCH_GONE' });
      const none = await request(http()).get(`/api/v1/optimization/staffing/search/latest?academicYearId=${YEAR_ID}`).set('x-test-user', admin()).expect(200);
      expect(none.body === null || Object.keys(none.body).length === 0).toBe(true);
    });

    it('is cancelled (200) as CANCELLING, which the task sees, and the run is answered as it stands', async () => {
      harness.tx['staffingSearchRun']!['findUnique']!.mockResolvedValue(run({ status: 'CANCELLING', finishedAt: null, leaseUntil: new Date(Date.now() + 60_000) }));

      const cancelled = await request(http()).post(`/api/v1/optimization/staffing/search/${RUN_ID}/cancel`).set('x-test-user', admin()).expect(200);

      expect(harness.tx['staffingSearchRun']!['updateMany']).toHaveBeenCalledWith({ where: { id: RUN_ID, status: { in: ['PENDING', 'RUNNING'] } }, data: { status: 'CANCELLING' } });
      expect(cancelled.body).toMatchObject({ id: RUN_ID, status: 'CANCELLING' });
    });
  });

  describe('what stands in the way', () => {
    it('is a 409 with its code beside a search that is going, for no behörigheter, and for a week Generera refuses', async () => {
      harness.tx['staffingSearchRun']!['count']!.mockResolvedValue(1);
      const going = await request(http()).post('/api/v1/optimization/staffing/search').set('x-test-user', admin()).send({ academicYearId: YEAR_ID }).expect(409);
      expect(going.body).toMatchObject({ code: 'STAFFING_SEARCH_ALREADY_RUNNING' });

      harness.tx['staffingSearchRun']!['count']!.mockResolvedValue(0);
      plan = { ...plan, recorded: false } as Plan;
      const none = await request(http()).post('/api/v1/optimization/staffing/search').set('x-test-user', admin()).send({ academicYearId: YEAR_ID }).expect(409);
      expect(none.body).toMatchObject({ code: 'STAFFING_SEARCH_NO_QUALIFICATIONS' });

      plan = { ...plan, recorded: true } as Plan;
      (proxy.prepareSchedule as jest.Mock).mockResolvedValue({ ready: false, refusalCode: 'BLOCK_PARTLY_LOCKED_SUMMARY' });
      const refused = await request(http()).post('/api/v1/optimization/staffing/search').set('x-test-user', admin()).send({ academicYearId: YEAR_ID }).expect(409);
      expect(refused.body).toMatchObject({ code: 'STAFFING_SEARCH_NOT_READY' });
      expect(harness.http.post).not.toHaveBeenCalled();
    });

    it('is a 409 STAFF_PROPOSAL_STALE for a proposal whose week, or whose tjänstefördelning, is no longer the school\'s', async () => {
      harness.tx['staffingSearchRun']!['findUnique']!.mockResolvedValue(run({ weekBasis: weekBasisOf({ ...parts(), [BASIS_PARTS[0]!]: 'changed' } as BasisParts) }));
      const week = await request(http()).get(`/api/v1/optimization/staffing/search/${RUN_ID}/proposal`).set('x-test-user', admin()).expect(409);
      expect(week.body).toMatchObject({ code: 'STAFF_PROPOSAL_STALE' });

      harness.tx['staffingSearchRun']!['findUnique']!.mockResolvedValue(run({ staffingBasis: 'b'.repeat(64) }));
      const staff = await request(http()).get(`/api/v1/optimization/staffing/search/${RUN_ID}/proposal`).set('x-test-user', admin()).expect(409);
      expect(staff.body).toMatchObject({ code: 'STAFF_PROPOSAL_STALE' });
    });

    it('is a 409 while the search goes on, and a 404 when it found nothing to propose', async () => {
      harness.tx['staffingSearchRun']!['findUnique']!.mockResolvedValue(run({ status: 'RUNNING', finishedAt: null, leaseUntil: new Date(Date.now() + 60_000) }));
      await request(http()).get(`/api/v1/optimization/staffing/search/${RUN_ID}/proposal`).set('x-test-user', admin()).expect(409);

      harness.tx['staffingSearchRun']!['findUnique']!.mockResolvedValue(run({ checkpoint: { changes: [], tally: { better: 0, notBetter: 3, worse: 0, refused: 0, unranked: 0 } } }));
      await request(http()).get(`/api/v1/optimization/staffing/search/${RUN_ID}/proposal`).set('x-test-user', admin()).expect(404);
    });
  });

  describe('the week before and after a proposal that covers the week', () => {
    const WEEK = '/api/v1/optimization/staffing/proposal/week';
    const body = (basisSha256: string, coversWeek?: boolean) => ({
      academicYearId: YEAR_ID,
      basisSha256,
      changes: [{ requirementId: real(1), fromTeacherId: TEACHERS.a.real, toTeacherId: TEACHERS.b.real }],
      ...(coversWeek === undefined ? {} : { coversWeek }),
    });

    beforeEach(() => {
      jest.spyOn(staffing, 'currentBasis').mockResolvedValue(STAFFING_BASIS);
    });

    it('takes the digest of the tjänstefördelning and the week together when it says it covers the week, and answers the digest it was given', async () => {
      const digest = withWeekBasis(STAFFING_BASIS, weekBasisOf(weekParts));
      harness.http.post.mockImplementation(() => of({ data: { requestId: 'r', verdict: 'OK', years: [], skipped: ['LUNCH_STAGE'], elapsedMs: 1, conflicts: null } }));

      const answered = await request(http()).post(WEEK).set('x-test-user', admin()).send(body(digest, true)).expect(200);

      expect(answered.body).toMatchObject({ status: 'DONE', basisSha256: digest });
    });

    it('refuses a digest that is not both, and a proposal of the tjänstefördelning alone when it claims to cover the week', async () => {
      const refusedAlone = await request(http()).post(WEEK).set('x-test-user', admin()).send(body(STAFFING_BASIS, true)).expect(409);
      expect(refusedAlone.body).toMatchObject({ code: 'STAFF_PROPOSAL_STALE' });
      const refusedDigest = await request(http()).post(WEEK).set('x-test-user', admin()).send(body(withWeekBasis(STAFFING_BASIS, 'f'.repeat(64)), true)).expect(409);
      expect(refusedDigest.body).toMatchObject({ code: 'STAFF_PROPOSAL_STALE' });
      expect(harness.http.post).not.toHaveBeenCalled();
    });

    it('is exactly what it was for a proposal that does not say it covers the week', async () => {
      harness.http.post.mockImplementation(() => of({ data: { requestId: 'r', verdict: 'OK', years: [], skipped: ['LUNCH_STAGE'], elapsedMs: 1, conflicts: null } }));
      const answered = await request(http()).post(WEEK).set('x-test-user', admin()).send(body(STAFFING_BASIS)).expect(200);
      expect(answered.body).toMatchObject({ status: 'DONE', basisSha256: withWeekBasis(STAFFING_BASIS, weekBasisOf(weekParts)) });

      const stale = await request(http()).post(WEEK).set('x-test-user', admin()).send(body('c'.repeat(64))).expect(409);
      expect(stale.body).toMatchObject({ code: 'STAFF_PROPOSAL_STALE' });
    });
  });
});
