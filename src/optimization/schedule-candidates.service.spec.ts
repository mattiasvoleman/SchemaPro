import { ConflictException, HttpException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import { recordedReads } from '../../test/utils/recorded-reads';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { ScheduleVersionsService } from '../calendar/schedule-versions.service';
import type { PrismaService } from '../database/prisma.service';
import type { JobRunner } from '../jobs/job-runner';
import type { RealtimeService } from '../realtime/realtime.service';
import { BASIS_PARTS, type BasisParts } from './candidate-basis';
import { BEST_EFFORT_VARIANT, snapshotNameOf, variantOf, variantsFor } from './candidate-variants';
import { deviationsDigestOf, storedDeviationsOf } from './deviations';
import type { StartCandidatesDto } from './dto/schedule-candidates.dto';
import { TEACHER_FREE_DAY_WISH_NOT_KEPT, freeDayWishMessage } from './free-day-wishes';
import type { AiEngineConflictAnalysis } from './interfaces/ai-engine-payload.interface';
import type { CandidateSolution, OptimizationProxyService, PreparedSchedule } from './optimization-proxy.service';
import {
  BEST_EFFORT_NO_REFRESH,
  BEST_EFFORT_NOT_ENABLED,
  SCHEDULE_CANDIDATE_DEVIATIONS_NOT_ACCEPTED,
  CANDIDATE_ENGINE_FAILED,
  CANDIDATE_ENGINE_TIMEOUT,
  CANDIDATE_GONE,
  CANDIDATE_RUN_ABANDONED,
  CANDIDATE_RUN_CANCELLED,
  CANDIDATE_RUN_INTERRUPTED,
  CANDIDATES_BUSY,
  CANDIDATES_FIRST_FAILED,
  CANDIDATES_NEED_A_DRAFT,
  CANDIDATES_NONE_APPLICABLE,
  CANDIDATES_RUNNING,
  draftMastersWhere,
  engineFailureOf,
  GENERATE_RUNNING,
  plainWeights,
  PUBLISH_MODE_CHANGED,
  REFRESH_GONE,
  runViewOf,
  SCHEDULE_CANDIDATE_NOT_APPLICABLE,
  ScheduleCandidatesService,
  storedConflictsOf,
  storedLessonsOf,
  storedLunchesOf,
  SWEEP_INTERVAL_MS,
  SWEEP_JOB,
  yearHasActiveCandidateRun,
} from './schedule-candidates.service';
import { ENGINE_LACKS_BEST_EFFORT, ENGINE_LACKS_CANDIDATES } from './optimization-proxy.service';
import {
  CONSECUTIVE_TEACHING_HIDDEN_MESSAGE,
  TEACHER_WORK_DAYS_HIDDEN,
  DEVIATION_WORK_DAYS_HIDDEN_MESSAGE,
  WORK_DAYS_HIDDEN_MESSAGE,
  WorkDaysRefusal,
} from './work-days';
import { SCHEDULE_CANDIDATE_BUSY, SCHEDULE_CANDIDATE_STALE } from './regeneration-lock';

/*
 * The run is a row other parties write too — a DELETE sets it CANCELLING, an
 * apply supersedes it, the sweep fails it — so the spec keeps it in a small
 * world rather than as canned answers: the compare-and-set really updates
 * only a PENDING or RUNNING row, the row lock really reads the status the
 * last writer left, and a test can change the status in the middle of an
 * engine call and watch the task stop.
 */

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const YEAR = '44444444-4444-4444-8444-444444444444';
const RUN = '55555555-5555-4555-8555-555555555555';
const OLD_RUN = '57575757-5757-4575-8575-575757575757';
const CANDIDATE = '66666666-6666-4666-8666-666666666666';
const G7A = '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a';
const MA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ROOM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TEACHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_TEACHER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const BASIS = 'a'.repeat(64);
const PARTS: BasisParts = Object.fromEntries(BASIS_PARTS.map((part, i) => [part, String(i).repeat(64)])) as BasisParts;

interface RunState {
  status: string;
  progress: number;
  basis: string | null;
  basisParts: unknown;
  error?: string | null;
  errorCode?: string | null;
  errorParams?: unknown;
  unplaced?: unknown;
  draftNotes?: unknown;
  appliedCandidateId?: string | null;
}

/** "SQL ? with ? placeholders", from a tagged call or a Prisma.sql object. */
function sqlOf(args: unknown[]): { text: string; values: unknown[] } {
  const [first, ...rest] = args;
  if (Array.isArray(first)) return { text: (first as string[]).join('?'), values: rest };
  const sql = first as { strings: string[]; values: unknown[] };
  return { text: sql.strings.join('?'), values: sql.values };
}

const statusMatches = (filter: unknown, status: string): boolean => {
  if (filter === undefined) return true;
  if (typeof filter === 'string') return filter === status;
  return ((filter as { in: string[] }).in ?? []).includes(status);
};

describe('ScheduleCandidatesService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let proxy: { prepareSchedule: jest.Mock; solveCandidate: jest.Mock; applyCandidateWrite: jest.Mock };
  let versions: { snapshotInTransaction: jest.Mock };
  let realtime: { notifyMasterTimetableChanged: jest.Mock };
  let jobs: { register: jest.Mock; unregister: jest.Mock; isScheduled: jest.Mock; settled: jest.Mock };
  let candidatesConfig: { maxSeconds: number; runsMax: number; solverWorkers: number; background: boolean };
  let service: ScheduleCandidatesService;
  let run: RunState;
  let stored: Array<Record<string, unknown>>;
  /** Every raw statement and proxy step, in order. */
  let steps: string[];
  let activeRuns: number;
  const user: AuthenticatedUser = testUser();

  const requirementRows = [
    { id: 'req-ma', subjectId: MA, studentGroupId: G7A, teacherId: TEACHER, coTeacherId: null, recurrence: 'ALL_WEEKS' as const, startDate: null, endDate: null },
    { id: 'req-sv', subjectId: SV, studentGroupId: G7A, teacherId: null, coTeacherId: null, recurrence: 'ODD_WEEKS' as const, startDate: new Date('2027-01-11T00:00:00.000Z'), endDate: null },
  ];

  const prepared = (overrides: Partial<PreparedSchedule> = {}): PreparedSchedule =>
    ({
      ready: true,
      requestId: 'req-id',
      academicYearId: YEAR,
      schoolId: SCHOOL,
      payload: {
        requestId: 'req-id',
        academicYearId: YEAR,
        requirements: [{ id: 'anon-ma' }, { id: 'anon-sv' }],
        previousLessons: [{ requirementId: 'anon-ma', dayOfWeek: 1, startTime: '08:00:00' }],
      },
      storedRules: null,
      freeDayWishes: [],
      consecutiveWishes: [],
      keptTimetable: [],
      anonMaps: {
        requirementAnonMap: new Map([
          ['req-ma', 'anon-ma'],
          ['req-sv', 'anon-sv'],
        ]),
        roomAnonMap: new Map(),
        groupAnonMap: new Map(),
        roomTypeAnonMap: new Map(),
        constraintAnonMap: new Map(),
        workRuleAnonMap: new Map(),
        nameById: new Map(),
      },
      headcountByGroup: new Map(),
      demand: [
        { requirementId: 'req-ma', lessonsPerWeek: 1 },
        { requirementId: 'req-sv', lessonsPerWeek: 1 },
      ],
      requirementRows,
      basis: BASIS,
      basisParts: PARTS,
      draftIds: ['m-1', 'm-2'],
      draftLessons: [
        { id: 'm-1', subjectId: MA, studentGroupId: G7A, teacherId: TEACHER, coTeacherId: null, roomId: ROOM, dayOfWeek: 1, startTime: '08:00', endTime: '09:00', recurrence: 'ALL_WEEKS', startDate: null, endDate: null, isParked: false },
        { id: 'm-2', subjectId: SV, studentGroupId: G7A, teacherId: null, coTeacherId: null, roomId: null, dayOfWeek: 2, startTime: '10:00', endTime: '11:00', recurrence: 'ODD_WEEKS', startDate: '2027-01-11', endDate: null, isParked: false },
      ],
      coverage: null,
      ...overrides,
    }) as unknown as PreparedSchedule;

  /** The draft as it is: Ma kept, Sv moved a day. */
  const solved = (overrides: Partial<CandidateSolution> = {}): CandidateSolution => ({
    status: 'OPTIMAL',
    lessons: [
      { requirementId: 'req-ma', roomId: ROOM, dayOfWeek: 1, startTime: '08:00', endTime: '09:00' },
      { requirementId: 'req-sv', roomId: null, dayOfWeek: 3, startTime: '10:00', endTime: '11:00' },
    ],
    lunches: [{ studentGroupId: G7A, dayOfWeek: 1, startTime: '11:30:00', endTime: '12:00:00' }],
    conflicts: null,
    ...overrides,
  });

  const conflictAnalysis: AiEngineConflictAnalysis = {
    summary: 'No timetable satisfies every hard constraint.',
    summaryCode: 'CONFLICT_CORE_SUMMARY',
    summaryParams: { count: 1 },
    conflicts: [
      {
        category: 'INSUFFICIENT_RESOURCES',
        code: 'INSUFFICIENT_RESOURCESED',
        params: { minutes: 1800 },
        message: 'A teacher has more lessons than days.',
        requirementIds: ['req-ma'],
        roomIds: [],
        constraintIds: [],
        resourceIds: [TEACHER],
        resourceNames: [],
      },
    ],
  };

  const dto = (overrides: Partial<StartCandidatesDto> = {}): StartCandidatesDto =>
    ({ academicYearId: YEAR, ...overrides }) as StartCandidatesDto;

  const build = () =>
    new ScheduleCandidatesService(
      prisma as unknown as PrismaService,
      proxy as unknown as OptimizationProxyService,
      versions as unknown as ScheduleVersionsService,
      realtime as unknown as RealtimeService,
      { get: (key: string) => (key === 'candidates' ? candidatesConfig : undefined) } as never,
      jobs as unknown as JobRunner,
    );

  /** Turns of the event loop until the background task has finished. */
  const drain = async () => {
    for (let turn = 0; turn < 100 && service.running.length > 0; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(service.running).toEqual([]);
  };

  /** Starts a run and waits for its task. */
  const startAndRun = async (body: StartCandidatesDto = dto()) => {
    const answer = await service.start(body, user);
    await drain();
    return answer;
  };

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    stored = [];
    steps = [];
    activeRuns = 0;
    run = { status: 'PENDING', progress: 0, basis: null, basisParts: null };
    candidatesConfig = { maxSeconds: 30, runsMax: 2, solverWorkers: 4, background: true };

    tx.$executeRaw = jest.fn(async (...args: unknown[]) => {
      const { text, values } = sqlOf(args);
      steps.push(`x:${text.replace(/\s+/g, ' ').trim()}`);
      if (text.includes(`SET "status" = 'RUNNING'`)) {
        if (run.status !== 'PENDING' && run.status !== 'RUNNING') return 0;
        run.status = 'RUNNING';
        if (text.includes('"basis" =')) {
          run.basis = values[0] as string;
          run.basisParts = JSON.parse(values[1] as string);
        }
        return 1;
      }
      if (text.includes('"progress" = "progress" + 1')) {
        run.progress += 1;
        return 1;
      }
      return 0;
    });
    tx.$queryRaw = jest.fn(async (...args: unknown[]) => {
      const { text } = sqlOf(args);
      steps.push(`q:${text.replace(/\s+/g, ' ').trim()}`);
      if (text.includes('"ScheduleCandidateRuns" WHERE "id" =') && text.includes('FOR UPDATE')) return [{ status: run.status }];
      if (text.includes('schedule_candidate_runs_active')) return [{ active: activeRuns }];
      if (text.includes('schedule_candidates_sweep')) return [{ changed: 0 }];
      if (text.includes('enter_grundschema_write')) return [{ mode: 'DRAFT' }];
      if (text.includes('school_publish_mode')) return [{ mode: 'DRAFT' }];
      return [];
    });
    tx.scheduleCandidateRun.create.mockImplementation(async () => {
      run = { status: 'PENDING', progress: 0, basis: null, basisParts: null };
      return { id: RUN };
    });
    tx.scheduleCandidateRun.updateMany.mockImplementation(async ({ where, data }: { where: { id?: string; status?: unknown }; data: Partial<RunState> }) => {
      if (where.id !== undefined && where.id !== RUN) return { count: 0 };
      if (!statusMatches(where.status, run.status)) return { count: 0 };
      Object.assign(run, data);
      return { count: 1 };
    });
    tx.scheduleCandidateRun.update.mockImplementation(async ({ data }: { data: Partial<RunState> }) => {
      Object.assign(run, data);
      return {};
    });
    tx.scheduleCandidateRun.deleteMany.mockResolvedValue({ count: 1 });
    tx.scheduleCandidateRun.findFirst.mockResolvedValue(null);
    tx.scheduleCandidate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      stored.push(data);
      return { id: `candidate-${stored.length}` };
    });
    tx.masterLesson.count.mockResolvedValue(12);
    tx.optimizationJob.count.mockResolvedValue(0);

    proxy = {
      prepareSchedule: jest.fn(async () => {
        steps.push('proxy:prepare');
        return prepared();
      }),
      solveCandidate: jest.fn(async () => solved()),
      applyCandidateWrite: jest.fn(async () => {
        steps.push('proxy:write');
        return { versionId: 'version-1', lessonsCreated: 2, unlockedReplaced: 2, lockedPreserved: 5, calendarLessonsRemoved: 0 };
      }),
    };
    versions = { snapshotInTransaction: jest.fn() };
    realtime = { notifyMasterTimetableChanged: jest.fn() };
    jobs = { register: jest.fn(), unregister: jest.fn(), isScheduled: jest.fn(() => true), settled: jest.fn() };
    service = build();
  });

  describe('POST candidates: the refusals before the 202', () => {
    const refusal = async (body = dto()) => {
      const error = (await service.start(body, user).catch((caught: unknown) => caught)) as HttpException;
      expect(error).toBeInstanceOf(HttpException);
      return { status: error.getStatus(), body: error.getResponse() as { code?: string } };
    };

    it('starts a PENDING run with its lease, weights and creator, and answers its id', async () => {
      await expect(startAndRun(dto({ weights: { spread: 4 } as never }))).resolves.toEqual({ runId: RUN });
      expect(tx.scheduleCandidateRun.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL,
          academicYearId: YEAR,
          createdById: user.userId,
          status: 'PENDING',
          requested: 3,
          // Twice the lead call's 95 s (30 + 45 + the probe's 20).
          leaseSeconds: 190,
          weights: { spread: 4 },
          refreshOfId: null,
        },
        select: { id: true },
      });
    });

    it('sweeps first, in a transaction of its own with no principal, and starts even when the sweep fails', async () => {
      await startAndRun();
      expect(prisma.withDeliveryService).toHaveBeenCalledTimes(1);
      expect(steps[0]).toContain('SELECT app.schedule_candidates_sweep()');

      prisma.withDeliveryService.mockRejectedValueOnce(new Error('pool exhausted'));
      await expect(startAndRun()).resolves.toEqual({ runId: RUN });
    });

    it('409 CANDIDATES_NEED_A_DRAFT when the year has no lesson a regeneration replaces', async () => {
      tx.masterLesson.count.mockResolvedValue(0);
      await expect(refusal()).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: CANDIDATES_NEED_A_DRAFT }) });
      expect(tx.masterLesson.count).toHaveBeenCalledWith({ where: draftMastersWhere(YEAR) });
      expect(tx.scheduleCandidateRun.create).not.toHaveBeenCalled();
    });

    it('409 GENERATE_RUNNING beside a Generera job of the year younger than 15 minutes', async () => {
      tx.optimizationJob.count.mockResolvedValue(1);
      await expect(refusal()).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: GENERATE_RUNNING }) });
      const where = tx.optimizationJob.count.mock.calls[0][0].where;
      expect(where).toMatchObject({ academicYearId: YEAR, status: { in: ['PENDING', 'RUNNING'] } });
      expect(Date.now() - where.createdAt.gte.getTime()).toBeGreaterThanOrEqual(15 * 60 * 1000 - 1000);
    });

    it('asks about Generera under the year’s start lock, which POST jobs takes too', async () => {
      const original = tx.optimizationJob.count.getMockImplementation();
      tx.optimizationJob.count.mockImplementation(async (...args: unknown[]) => {
        steps.push('generate-check');
        return original ? original(...args) : 0;
      });
      await startAndRun();
      const lock = steps.findIndex((step) => step.includes(`hashtext('grundschema-solve-start')`));
      expect(lock).toBeGreaterThan(-1);
      expect(steps[lock - 1]).toContain(`SET LOCAL lock_timeout = '5s'`);
      expect(steps.indexOf('generate-check')).toBeGreaterThan(lock);
      // Then past any rewrite of the year in progress, so the task's fetch reads its result.
      const rewrite = steps.findIndex((step) => step.includes(`hashtext('grundschema-regenerate')`));
      expect(rewrite).toBeGreaterThan(lock);
      // Both before the global start lock: no start holds that one while it waits for a year.
      expect(steps.findIndex((step) => step.includes(`hashtext('schedule-candidates-start')`))).toBeGreaterThan(rewrite);
    });

    it('409 SCHEDULE_BUSY when a rewrite of the year holds it past the 5 s, and inserts nothing', async () => {
      const original = tx.$executeRaw.getMockImplementation()!;
      tx.$executeRaw.mockImplementation(async (...args: unknown[]) => {
        if (sqlOf(args).text.includes('grundschema-regenerate')) throw new Error('canceling statement due to lock timeout (55P03)');
        return original(...args);
      });
      await expect(refusal()).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: 'SCHEDULE_BUSY' }) });
      expect(tx.scheduleCandidateRun.create).not.toHaveBeenCalled();
    });

    it('409 CANDIDATES_RUNNING beside an active run of the year, and on the partial unique index', async () => {
      tx.scheduleCandidateRun.findFirst.mockResolvedValueOnce({ id: OLD_RUN });
      await expect(refusal()).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: CANDIDATES_RUNNING }) });
      expect(tx.scheduleCandidateRun.findFirst).toHaveBeenCalledWith({
        where: { academicYearId: YEAR, status: { in: ['PENDING', 'RUNNING', 'CANCELLING'] } },
        select: { id: true },
      });

      tx.scheduleCandidateRun.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
      );
      await expect(refusal()).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: CANDIDATES_RUNNING }) });
    });

    it('409 CANDIDATES_BUSY at CANDIDATE_RUNS_MAX active runs, asked under the start lock', async () => {
      activeRuns = 2;
      await expect(refusal()).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: CANDIDATES_BUSY }) });
      const lock = steps.findIndex((step) => step.includes(`hashtext('schedule-candidates-start')`));
      const counted = steps.findIndex((step) => step.includes('schedule_candidate_runs_active'));
      expect(steps[lock - 1]).toContain(`SET LOCAL lock_timeout = '5s'`);
      expect(lock).toBeGreaterThan(-1);
      expect(counted).toBeGreaterThan(lock);

      activeRuns = 1;
      await expect(startAndRun()).resolves.toEqual({ runId: RUN });
    });

    it('409 CANDIDATES_BUSY when the start lock is not had in 5 s', async () => {
      const original = tx.$executeRaw.getMockImplementation()!;
      tx.$executeRaw.mockImplementation(async (...args: unknown[]) => {
        if (sqlOf(args).text.includes('schedule-candidates-start')) throw new Error('canceling statement due to lock timeout (55P03)');
        return original(...args);
      });
      await expect(refusal()).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: CANDIDATES_BUSY }) });
    });

    it('404 REFRESH_GONE for a refresh of a run that is gone, not SUCCEEDED, or of another year', async () => {
      tx.scheduleCandidateRun.findUnique.mockResolvedValueOnce(null);
      await expect(refusal(dto({ refreshOf: OLD_RUN }))).resolves.toEqual({ status: 404, body: expect.objectContaining({ code: REFRESH_GONE }) });

      const old = (overrides: Record<string, unknown>) => ({
        academicYearId: YEAR,
        status: 'SUCCEEDED',
        weights: null,
        candidates: [{ ordinal: 1, variant: 'KEEP', weights: null, seed: null, solverStatus: 'OPTIMAL', lessons: [] }],
        ...overrides,
      });
      tx.scheduleCandidateRun.findUnique.mockResolvedValueOnce(old({ status: 'FAILED' }));
      await expect(refusal(dto({ refreshOf: OLD_RUN }))).resolves.toEqual({ status: 404, body: expect.objectContaining({ code: REFRESH_GONE }) });
      tx.scheduleCandidateRun.findUnique.mockResolvedValueOnce(old({ academicYearId: OLD_RUN }));
      await expect(refusal(dto({ refreshOf: OLD_RUN }))).resolves.toEqual({ status: 404, body: expect.objectContaining({ code: REFRESH_GONE }) });
      expect(tx.scheduleCandidateRun.create).not.toHaveBeenCalled();
    });

    it('asks the year two steps ahead question before anything else, as Generera does', async () => {
      await startAndRun();
      expect(tx.academicYear.findUnique).toHaveBeenCalledWith({
        where: { id: YEAR },
        select: { isActive: true, predecessorId: true },
      });
    });
  });

  describe('the task', () => {
    it('solves the candidates one after another from one fetch, each with its own weights, seed, search and timeout', async () => {
      await startAndRun(dto({ count: 3, weights: { spread: 4 } as never }));

      expect(proxy.prepareSchedule).toHaveBeenCalledTimes(1);
      expect(proxy.prepareSchedule).toHaveBeenCalledWith(tx, YEAR, user, { coverage: true });
      const calls = proxy.solveCandidate.mock.calls.map(([, options]) => options);
      expect(calls).toEqual([
        { weights: { spread: 4 }, search: { workers: 4, probes: true, maxSeconds: 30 }, timeoutMs: 95_000 },
        { weights: { spread: 4, disruption: 2, teacherGap: 8 }, search: { workers: 4, probes: false, maxSeconds: 30, seed: 1 }, timeoutMs: 75_000 },
        { weights: { spread: 9, disruption: 2 }, search: { workers: 4, probes: false, maxSeconds: 30, seed: 2 }, timeoutMs: 75_000 },
      ]);
      expect(stored.map((row) => [row['ordinal'], row['variant'], row['seed'], row['weights']])).toEqual([
        [1, 'KEEP', null, { spread: 4 }],
        [2, 'TEACHER_GAPS', 1, { spread: 4, disruption: 2, teacherGap: 8 }],
        [3, 'SPREAD', 2, { spread: 9, disruption: 2 }],
      ]);
      expect(run).toMatchObject({ status: 'SUCCEEDED', progress: 3, basis: BASIS, basisParts: PARTS });
    });

    it('a KEEP over no weights sends none, and reads the candidate budget and the workers from the configuration', async () => {
      candidatesConfig = { maxSeconds: 90, runsMax: 2, solverWorkers: 2, background: false };
      service = build();
      await startAndRun(dto({ count: 2 }));
      const calls = proxy.solveCandidate.mock.calls.map(([, options]) => options);
      expect(calls[0]).toEqual({ weights: null, search: { workers: 2, probes: true, maxSeconds: 90 }, timeoutMs: 155_000 });
      expect(calls[1]).toEqual({ weights: { disruption: 2, teacherGap: 8 }, search: { workers: 2, probes: false, maxSeconds: 90, seed: 1 }, timeoutMs: 135_000 });
    });

    it('sets each call\'s engine deadline with its heartbeat and clears it as the candidate is stored, the run finishes or fails', async () => {
      await startAndRun(dto({ count: 2 }));
      const raw = tx.$executeRaw.mock.calls.map((args) => sqlOf(args));
      // Lead 30 + 45 + 20 s, then 30 + 45 s.
      expect(raw.filter(({ text }) => text.includes('make_interval(secs =>')).map(({ values }) => values[0])).toEqual([95, 75]);
      expect(raw.filter(({ text }) => text.includes('"progress" = "progress" + 1')).every(({ text }) => text.includes('"engineBusyUntil" = NULL'))).toBe(true);
      expect(tx.scheduleCandidateRun.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCEEDED', engineBusyUntil: null }) }),
      );

      // An engine that answered — a refusal, a crash — is solving nothing for the run.
      proxy.solveCandidate.mockRejectedValueOnce(new HttpException('The AI engine returned an error.', 500));
      run = { status: 'PENDING', progress: 0, basis: null, basisParts: null };
      await startAndRun(dto({ count: 2 }));
      expect(tx.scheduleCandidateRun.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', engineBusyUntil: null }) }),
      );

      // An engine never reached has nothing of the run to solve.
      proxy.solveCandidate.mockRejectedValueOnce(new ServiceUnavailableException('The AI engine could not be reached.'));
      run = { status: 'PENDING', progress: 0, basis: null, basisParts: null };
      await startAndRun(dto({ count: 2 }));
      expect(tx.scheduleCandidateRun.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', engineBusyUntil: null }) }),
      );

      // A timeout (the gateway's, or the engine's 503, whose wait does not
      // stop its solve thread) keeps the call's deadline.
      proxy.solveCandidate.mockRejectedValueOnce(new ServiceUnavailableException('The AI engine did not respond in time.'));
      run = { status: 'PENDING', progress: 0, basis: null, basisParts: null };
      await startAndRun(dto({ count: 2 }));
      const timedOut = tx.scheduleCandidateRun.updateMany.mock.calls.at(-1)![0] as { data: Record<string, unknown> };
      expect(timedOut.data).toMatchObject({ status: 'FAILED', errorCode: 'CANDIDATE_ENGINE_TIMEOUT' });
      expect(timedOut.data).not.toHaveProperty('engineBusyUntil');
    });

    it('keeps the deadline of a run cancelled while its call was out when that call times out, and clears it when the engine answered', async () => {
      // A DELETE (or an apply) sets the run CANCELLING while the call is out;
      // the engine's own 503 then comes back. The run ends CANCELLED, still
      // counted: the solve thread the 503 left behind runs on.
      const cancelledThen = (error: HttpException) =>
        proxy.solveCandidate.mockImplementationOnce(async () => {
          run.status = 'CANCELLING';
          throw error;
        });
      cancelledThen(new HttpException({ message: 'The AI engine returned an error.' }, 503));
      await startAndRun(dto({ count: 2 }));
      const cancelled = tx.scheduleCandidateRun.updateMany.mock.calls.at(-1)![0] as { where: Record<string, unknown>; data: Record<string, unknown> };
      expect(cancelled.where).toEqual({ id: RUN, status: 'CANCELLING' });
      expect(cancelled.data).toMatchObject({ status: 'FAILED', errorCode: CANDIDATE_RUN_CANCELLED });
      expect(cancelled.data).not.toHaveProperty('engineBusyUntil');
      expect(run.status).toBe('FAILED');

      // The gateway's own timeout: the same.
      run = { status: 'PENDING', progress: 0, basis: null, basisParts: null };
      cancelledThen(new ServiceUnavailableException('The AI engine did not respond in time.'));
      await startAndRun(dto({ count: 2 }));
      expect((tx.scheduleCandidateRun.updateMany.mock.calls.at(-1)![0] as { data: Record<string, unknown> }).data).not.toHaveProperty('engineBusyUntil');

      // An engine that answered, or was never reached, solves nothing on.
      for (const answered of [new HttpException('The AI engine returned an error.', 500), new ServiceUnavailableException('The AI engine could not be reached.')]) {
        run = { status: 'PENDING', progress: 0, basis: null, basisParts: null };
        cancelledThen(answered);
        await startAndRun(dto({ count: 2 }));
        expect(tx.scheduleCandidateRun.updateMany).toHaveBeenLastCalledWith({
          where: { id: RUN, status: 'CANCELLING' },
          data: expect.objectContaining({ status: 'FAILED', errorCode: CANDIDATE_RUN_CANCELLED, engineBusyUntil: null }),
        });
      }
    });

    it('bumps the heartbeat by compare-and-set before the fetch and before every call, and only while PENDING or RUNNING', async () => {
      await startAndRun(dto({ count: 2 }));
      const cas = steps.filter((step) => step.startsWith('x:UPDATE "ScheduleCandidateRuns" SET "status" = \'RUNNING\''));
      // Before the fetch, the basis, and one per candidate.
      expect(cas).toHaveLength(4);
      for (const step of cas) {
        expect(step).toContain(`"heartbeatAt" = now()`);
        expect(step).toContain(`"startedAt" = coalesce("startedAt", now())`);
        expect(step).toContain(`WHERE "id" = ?::uuid AND "status" IN ('PENDING', 'RUNNING')`);
      }
      expect(cas[1]).toContain('"basis" = ?, "basisParts" = ?::jsonb');
    });

    it('stores a candidate under the row lock with its progress, and supersedes the year\'s other finished runs only on success', async () => {
      await startAndRun(dto({ count: 2 }));
      const store = steps.findIndex((step) => step.includes('FOR UPDATE') && step.includes('ScheduleCandidateRuns'));
      expect(store).toBeGreaterThan(-1);
      expect(steps[store + 1]).toContain('"progress" = "progress" + 1, "heartbeatAt" = now()');
      expect(tx.scheduleCandidateRun.deleteMany).toHaveBeenCalledWith({
        // Never a run whose engine call can still be solving (its cap place).
        where: { academicYearId: YEAR, id: { not: RUN }, status: { in: ['SUCCEEDED', 'FAILED'] }, OR: [{ engineBusyUntil: null }, { engineBusyUntil: { lte: expect.any(Date) } }] },
      });
    });

    it('stores moved, kept and room changes against the draft, sameAs against an earlier candidate, and the run\'s unplaced figure', async () => {
      const coverage = {
        year: { startDate: '2026-08-17', endDate: '2027-06-11' },
        closures: [],
        subjects: [{ id: MA, name: 'Ma', nationalCode: null, countsTowardTimplan: true }],
        groups: [{ id: G7A, name: '7A', kind: 'CLASS' as const, gradeLevel: 7 }],
        requirements: [{ id: 'req-ma', studentGroupId: G7A, subjectId: MA, lessonsPerWeek: 1, minutesPerLesson: 60, recurrence: 'ALL_WEEKS' as const, startDate: null, endDate: null }],
        preservedLessons: [],
        draftLessons: [],
      };
      proxy.prepareSchedule.mockResolvedValue(prepared({ coverage }));
      await startAndRun(dto({ count: 2 }));

      expect(stored[0]!['metrics']).toEqual({
        moved: 1,
        movedOf: 2,
        kept: 1,
        roomChanges: 0,
        sameAs: null,
        lessonCount: 2,
        unplaced: { lines: 0, minutes: 0 },
      });
      // The same answer twice: the second is "Samma som förslag 1".
      expect((stored[1]!['metrics'] as { sameAs: number }).sameAs).toBe(1);
      // The draft has no Ma at all: one line, an hour a week.
      expect(run.unplaced).toEqual({ lines: 0, minutes: 0, draftLines: 1, draftMinutes: 60 });
    });

    it('stores lessons, lunches and conflicts in ids and times, with no pupil anywhere', async () => {
      proxy.solveCandidate
        .mockResolvedValueOnce(
          solved({
            // A field a future proxy might carry does not ride into the row.
            lessons: [{ requirementId: 'req-ma', roomId: ROOM, dayOfWeek: 1, startTime: '08:00', endTime: '09:00', studentIds: ['p-1'] } as never],
            lunches: [{ studentGroupId: G7A, dayOfWeek: 1, startTime: '11:30:00', endTime: '12:00:00', participants: ['p-1'] } as never],
          }),
        )
        .mockResolvedValueOnce(solved({ status: 'INFEASIBLE', lessons: [], lunches: null, conflicts: conflictAnalysis }));
      await startAndRun(dto({ count: 2 }));

      expect(stored[0]!['lessons']).toEqual([{ requirementId: 'req-ma', roomId: ROOM, dayOfWeek: 1, startTime: '08:00', endTime: '09:00' }]);
      expect(stored[0]!['lunches']).toEqual([{ studentGroupId: G7A, dayOfWeek: 1, startTime: '11:30:00', endTime: '12:00:00' }]);
      expect(stored[1]!['conflicts']).toEqual([
        { category: 'INSUFFICIENT_RESOURCES', code: 'INSUFFICIENT_RESOURCESED', params: { minutes: 1800 }, message: 'A teacher has more lessons than days.', resourceNames: [] },
      ]);
      for (const row of stored) {
        const json = JSON.stringify(row);
        expect(json).not.toMatch(/studentIds|participants|p-1/);
      }
    });

    it('stores a later INFEASIBLE or TIMEOUT candidate with no metrics and goes on', async () => {
      proxy.solveCandidate
        .mockResolvedValueOnce(solved())
        .mockResolvedValueOnce(solved({ status: 'TIMEOUT', lessons: [], lunches: null, conflicts: conflictAnalysis }))
        .mockResolvedValueOnce(solved({ status: 'FEASIBLE' }));
      await startAndRun();
      expect(stored.map((row) => [row['solverStatus'], row['metrics'] === Prisma.DbNull, row['errorCode']])).toEqual([
        ['OPTIMAL', false, null],
        ['TIMEOUT', true, 'CONFLICT_CORE_SUMMARY'],
        ['FEASIBLE', false, null],
      ]);
      expect(stored[1]!['lessons']).toEqual([]);
      expect(stored[1]!['lunches']).toBe(Prisma.DbNull);
      expect(run.status).toBe('SUCCEEDED');
    });

    /*
     * Önskad ledig dag: a candidate's timetable is its own lessons with their
     * posts' teachers, beside what every candidate keeps; the draft's is its
     * own lessons beside the same. Each is read as Generera reads what it
     * wrote (unkeptFreeDayWishes), when it is stored.
     */
    describe('the free-day wishes', () => {
      const wishes = [
        { ruleId: 'rule-teacher', userId: TEACHER, day: 1 },
        { ruleId: 'rule-other', userId: OTHER_TEACHER, day: 3 },
      ];
      /** As the job row keeps a note: the teacher's id kept for the server, no name and no rule id. */
      const note = (userId: string, day: number) => ({
        category: 'AVAILABILITY',
        code: TEACHER_FREE_DAY_WISH_NOT_KEPT,
        params: { day },
        message: freeDayWishMessage(day),
        resourceNames: [],
        subjectIds: [userId],
      });

      it('stores each applicable candidate’s broken wishes, the kept lessons’ among them, and none for one with no timetable', async () => {
        proxy.prepareSchedule.mockResolvedValue(
          prepared({
            freeDayWishes: wishes,
            // A locked lesson the other teacher co-teaches on their wished
            // Wednesday: every candidate keeps it, so every one breaks it.
            keptTimetable: [
              {
                id: 'kept-1',
                teacherId: null,
                coTeacherId: OTHER_TEACHER,
                dayOfWeek: 3,
                startMinutes: 480,
                endMinutes: 540,
                recurrence: 'ALL_WEEKS',
                startDate: null,
                endDate: null,
              },
            ],
          }),
        );
        proxy.solveCandidate
          // Ma, the teacher's post, on her wished Monday.
          .mockResolvedValueOnce(solved())
          // Ma on Tuesday, and Sv (nobody's) on Monday: her Monday is free.
          .mockResolvedValueOnce(
            solved({
              lessons: [
                { requirementId: 'req-ma', roomId: ROOM, dayOfWeek: 2, startTime: '08:00', endTime: '09:00' },
                { requirementId: 'req-sv', roomId: null, dayOfWeek: 1, startTime: '10:00', endTime: '11:00' },
              ],
            }),
          )
          .mockResolvedValueOnce(solved({ status: 'TIMEOUT', lessons: [], lunches: null, conflicts: conflictAnalysis }));
        await startAndRun(dto({ count: 3 }));

        expect(stored.map((row) => row['notes'])).toEqual([
          [note(TEACHER, 1), note(OTHER_TEACHER, 3)],
          [note(OTHER_TEACHER, 3)],
          Prisma.DbNull,
        ]);
        // The draft: her Ma on Monday (m-1), and the kept lesson.
        expect(run.draftNotes).toEqual([note(TEACHER, 1), note(OTHER_TEACHER, 3)]);
        expect(run.status).toBe('SUCCEEDED');
      });

      it('stores an empty list when every wish is kept, and lets a parked lesson of the draft occupy no day', async () => {
        proxy.prepareSchedule.mockResolvedValue(
          prepared({
            freeDayWishes: wishes,
            draftLessons: prepared().draftLessons.map((lesson) => ({ ...lesson, isParked: lesson.id === 'm-1' })),
          }),
        );
        proxy.solveCandidate.mockResolvedValue(
          solved({ lessons: [{ requirementId: 'req-ma', roomId: ROOM, dayOfWeek: 4, startTime: '08:00', endTime: '09:00' }] }),
        );
        await startAndRun(dto({ count: 2 }));

        expect(stored.map((row) => row['notes'])).toEqual([[], []]);
        expect(run.draftNotes).toEqual([]);
      });

      it('keeps the draft’s off a run that ends with nothing to apply', async () => {
        proxy.prepareSchedule.mockResolvedValue(prepared({ freeDayWishes: wishes }));
        proxy.solveCandidate.mockResolvedValue(solved({ rejected: true }));
        await startAndRun(dto({ count: 2 }));

        expect(run.errorCode).toBe(CANDIDATES_NONE_APPLICABLE);
        expect(run.draftNotes).toBeUndefined();
        expect(stored.map((row) => row['notes'])).toEqual([Prisma.DbNull, Prisma.DbNull]);
      });
    });

    /*
     * Sammanhängande undervisning (20261218090000): the limit is the post's, HR
     * data, and a schemaförslag reads no post back, so it stores the HIDDEN
     * note for every reader — one per timetable, no params, no teacher, no
     * figure — beside the other notes (consecutive-wishes.ts hideConsecutiveNotes).
     */
    describe('the limits on teaching in a row', () => {
      const limits = [
        { userId: TEACHER, maxMinutes: 30, breakMinutes: 5 },
        { userId: OTHER_TEACHER, maxMinutes: 30, breakMinutes: 5 },
      ];
      const hidden = {
        category: 'AVAILABILITY',
        code: 'TEACHER_CONSECUTIVE_TEACHING_HIDDEN',
        params: {},
        message: CONSECUTIVE_TEACHING_HIDDEN_MESSAGE,
        resourceNames: [],
      };

      it('stores one hidden note per timetable, for the candidates and the draft, and nothing of the limit or the teacher', async () => {
        proxy.prepareSchedule.mockResolvedValue(
          prepared({
            consecutiveWishes: limits,
            keptTimetable: [
              {
                id: 'kept-1',
                teacherId: null,
                coTeacherId: OTHER_TEACHER,
                dayOfWeek: 3,
                startMinutes: 480,
                endMinutes: 600,
                recurrence: 'ALL_WEEKS',
                startDate: null,
                endDate: null,
              },
            ],
          }),
        );
        // Ma is an hour on a Monday: over a limit of half an hour for her; the
        // kept lesson is two hours for the other teacher in every candidate.
        proxy.solveCandidate.mockResolvedValue(solved());
        await startAndRun(dto({ count: 2 }));

        expect(stored.map((row) => row['notes'])).toEqual([[hidden], [hidden]]);
        expect(run.draftNotes).toEqual([hidden]);
        const everything = JSON.stringify([stored.map((row) => row['notes']), run.draftNotes]);
        expect(everything).not.toMatch(new RegExp(`${TEACHER}|${OTHER_TEACHER}|subjectIds|"max"|breakMinutes`));
      });

      it('stores none for a candidate that keeps every limit, and keeps the other notes in their place', async () => {
        proxy.prepareSchedule.mockResolvedValue(
          prepared({
            consecutiveWishes: [{ userId: TEACHER, maxMinutes: 480, breakMinutes: 5 }],
            freeDayWishes: [{ ruleId: 'rule-teacher', userId: TEACHER, day: 1 }],
          }),
        );
        proxy.solveCandidate.mockResolvedValue(solved());
        await startAndRun(dto({ count: 1 }));

        expect((stored[0]!['notes'] as unknown[]).map((note) => (note as { code: string }).code)).toEqual([
          TEACHER_FREE_DAY_WISH_NOT_KEPT,
        ]);
      });
    });

    it('stores a first candidate stopped by a post’s days with the hidden sentence, as its summary and in its list', async () => {
      // A days-bearing summary is not something the engine writes today; the
      // code holds it to the list's rule all the same, as realiseConflicts does.
      const days = {
        category: 'AVAILABILITY',
        code: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
        params: { limit: 'post-1' },
        message: WORK_DAYS_HIDDEN_MESSAGE,
        resourceIds: ['teacher-1'],
        resourceNames: [],
      };
      proxy.solveCandidate.mockResolvedValueOnce(
        solved({
          status: 'INFEASIBLE',
          lessons: [],
          lunches: null,
          conflicts: { summary: 's', summaryCode: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT', summaryParams: { limit: 'post-1' }, conflicts: [days] } as never,
        }),
      );
      await startAndRun();
      expect(stored[0]).toMatchObject({ errorCode: TEACHER_WORK_DAYS_HIDDEN, errorParams: Prisma.DbNull });
      expect(stored[0]!['conflicts']).toEqual([
        { category: 'AVAILABILITY', code: TEACHER_WORK_DAYS_HIDDEN, params: {}, message: WORK_DAYS_HIDDEN_MESSAGE, resourceNames: [] },
      ]);
      expect(JSON.stringify(stored[0])).not.toMatch(/post-1|teacher-1/);
    });

    it.each(['INFEASIBLE', 'TIMEOUT'] as const)(
      'stops at a first candidate that is %s: stored with its conflicts, the run FAILED CANDIDATES_FIRST_FAILED, nothing superseded',
      async (status) => {
        proxy.solveCandidate.mockResolvedValueOnce(solved({ status, lessons: [], lunches: null, conflicts: conflictAnalysis }));
        await startAndRun();
        expect(proxy.solveCandidate).toHaveBeenCalledTimes(1);
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ ordinal: 1, solverStatus: status, conflicts: [expect.objectContaining({ code: 'INSUFFICIENT_RESOURCESED' })] });
        // The summary is kept with its values, so the page can say what stopped it even with no list.
        expect(stored[0]).toMatchObject({ errorCode: 'CONFLICT_CORE_SUMMARY', errorParams: { count: 1 } });
        expect(run).toMatchObject({ status: 'FAILED', errorCode: CANDIDATES_FIRST_FAILED, progress: 1 });
        expect(tx.scheduleCandidateRun.deleteMany).not.toHaveBeenCalled();
      },
    );

    it('stores an answer the demand guard refused as REJECTED, and fails a run with nothing applicable CANDIDATES_NONE_APPLICABLE, superseding nothing', async () => {
      proxy.solveCandidate.mockResolvedValue(solved({ lessons: [], lunches: null, rejected: true }));
      await startAndRun(dto({ count: 2 }));
      expect(stored.map((row) => row['solverStatus'])).toEqual(['REJECTED', 'REJECTED']);
      expect(stored.every((row) => row['metrics'] === Prisma.DbNull && row['errorCode'] === null)).toBe(true);
      expect(run).toMatchObject({ status: 'FAILED', errorCode: CANDIDATES_NONE_APPLICABLE });
      expect(tx.scheduleCandidateRun.deleteMany).not.toHaveBeenCalled();
    });

    it.each([
      ['a gateway timeout', new ServiceUnavailableException('The AI engine did not respond in time.'), CANDIDATE_ENGINE_TIMEOUT],
      ['an engine older than search', new HttpException({ message: 'older', code: ENGINE_LACKS_CANDIDATES }, 503), ENGINE_LACKS_CANDIDATES],
      ['an engine that broke', new HttpException('The AI engine returned an error.', 500), CANDIDATE_ENGINE_FAILED],
      ['a named engine refusal', new HttpException({ message: 'Lunch has no room.', code: 'LUNCH_WINDOW_EMPTY', params: { group: '7A' } }, 400), 'LUNCH_WINDOW_EMPTY'],
    ])('fails the run at once on %s, without the next candidate', async (_label, error, code) => {
      proxy.solveCandidate.mockResolvedValueOnce(solved()).mockRejectedValueOnce(error);
      await startAndRun();
      expect(proxy.solveCandidate).toHaveBeenCalledTimes(2);
      // Ended where it failed: no compare-and-set for a third candidate
      // (before the fetch, the basis, and one per candidate asked).
      expect(steps.filter((step) => step.includes(`SET "status" = 'RUNNING'`))).toHaveLength(4);
      expect(stored).toHaveLength(1);
      expect(run).toMatchObject({ status: 'FAILED', errorCode: code });
      expect(tx.scheduleCandidateRun.deleteMany).not.toHaveBeenCalled();
    });

    it('fails the run with the refusal\'s code when the fetch refuses, and asks the engine nothing', async () => {
      proxy.prepareSchedule.mockResolvedValue({
        ready: false,
        requestId: 'r',
        academicYearId: YEAR,
        refusal: { requestId: 'r', status: 'INFEASIBLE', lessons: [], conflicts: { summary: '2 requirement(s) have no teacher.', summaryCode: 'STAFF_UNSTAFFED_REQUIREMENTS', summaryParams: { count: 2 }, conflicts: [] } },
        refusalCode: 'STAFF_UNSTAFFED_REQUIREMENTS',
      });
      await startAndRun();
      expect(proxy.solveCandidate).not.toHaveBeenCalled();
      expect(run).toMatchObject({ status: 'FAILED', errorCode: 'STAFF_UNSTAFFED_REQUIREMENTS', errorParams: { count: 2 } });
    });

    it('fails the run with its message when the fetch throws', async () => {
      proxy.prepareSchedule.mockRejectedValue(new Error('connection reset'));
      await startAndRun();
      expect(run).toMatchObject({ status: 'FAILED', errorCode: null, error: 'connection reset' });
    });

    describe('compare-and-set: a 0 stops the task, and it never writes again', () => {
      it('a run set CANCELLING before its task began ends CANDIDATE_RUN_CANCELLED, with no fetch', async () => {
        tx.scheduleCandidateRun.create.mockImplementationOnce(async () => {
          run = { status: 'CANCELLING', progress: 0, basis: null, basisParts: null };
          return { id: RUN };
        });
        await startAndRun();
        expect(proxy.prepareSchedule).not.toHaveBeenCalled();
        expect(run).toMatchObject({ status: 'FAILED', errorCode: CANDIDATE_RUN_CANCELLED });
      });

      it('a DELETE during an engine call: the answer is not stored, the run ends CANCELLED, no next call', async () => {
        proxy.solveCandidate.mockImplementationOnce(async () => {
          run.status = 'CANCELLING';
          return solved();
        });
        await startAndRun();
        expect(proxy.solveCandidate).toHaveBeenCalledTimes(1);
        expect(stored).toHaveLength(0);
        expect(run).toMatchObject({ status: 'FAILED', errorCode: CANDIDATE_RUN_CANCELLED, progress: 0 });
      });

      it('a DELETE between two candidates stops at the next compare-and-set', async () => {
        proxy.solveCandidate.mockResolvedValueOnce(solved()).mockImplementationOnce(async () => solved());
        tx.scheduleCandidate.create.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => {
          stored.push(data);
          run.status = 'CANCELLING';
          return { id: 'c-1' };
        });
        await startAndRun();
        expect(proxy.solveCandidate).toHaveBeenCalledTimes(1);
        expect(stored).toHaveLength(1);
        expect(run).toMatchObject({ status: 'FAILED', errorCode: CANDIDATE_RUN_CANCELLED });
      });

      it('a run the sweep gave up stays exactly as the sweep left it', async () => {
        proxy.solveCandidate.mockImplementationOnce(async () => {
          Object.assign(run, { status: 'FAILED', errorCode: CANDIDATE_RUN_ABANDONED });
          return solved();
        });
        await startAndRun();
        expect(stored).toHaveLength(0);
        expect(run).toMatchObject({ status: 'FAILED', errorCode: CANDIDATE_RUN_ABANDONED });
        expect(tx.scheduleCandidateRun.update).not.toHaveBeenCalled();
        expect(tx.scheduleCandidateRun.deleteMany).not.toHaveBeenCalled();
      });

      it('a run cancelled after its last candidate is not finished SUCCEEDED', async () => {
        let calls = 0;
        tx.scheduleCandidate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          stored.push(data);
          if (++calls === 2) run.status = 'CANCELLING';
          return { id: `c-${calls}` };
        });
        await startAndRun(dto({ count: 2 }));
        expect(stored).toHaveLength(2);
        expect(run).toMatchObject({ status: 'FAILED', errorCode: CANDIDATE_RUN_CANCELLED });
        expect(tx.scheduleCandidateRun.deleteMany).not.toHaveBeenCalled();
      });
    });

    describe('refresh ("Uppdatera förslagen")', () => {
      const oldLessons = [
        { requirementId: 'req-ma', roomId: ROOM, dayOfWeek: 4, startTime: '13:00', endTime: '14:00' },
        { requirementId: 'req-gone', roomId: null, dayOfWeek: 5, startTime: '08:00', endTime: '09:00' },
      ];

      beforeEach(() => {
        tx.scheduleCandidateRun.findUnique.mockResolvedValue({
          academicYearId: YEAR,
          status: 'SUCCEEDED',
          weights: { spread: 4 },
          candidates: [
            { ordinal: 1, variant: 'KEEP', weights: { spread: 4 }, seed: null, solverStatus: 'REJECTED', lessons: [] },
            { ordinal: 2, variant: 'TEACHER_GAPS', weights: { spread: 4, disruption: 2, teacherGap: 8 }, seed: 1, solverStatus: 'OPTIMAL', lessons: oldLessons },
            { ordinal: 3, variant: 'SPREAD', weights: { disruption: 55 }, seed: 2, solverStatus: 'FEASIBLE', lessons: oldLessons.slice(0, 1) },
          ],
        });
      });

      it('mirrors the old batch\'s applicable candidates under their ordinals, with the old lessons as hints and disruption raised to 40', async () => {
        await startAndRun(dto({ refreshOf: OLD_RUN, count: 4 }));
        expect(tx.scheduleCandidateRun.create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ requested: 2, refreshOfId: OLD_RUN, weights: { spread: 4 } }) }),
        );
        const calls = proxy.solveCandidate.mock.calls.map(([, options]) => options);
        expect(calls[0]).toEqual({
          weights: { spread: 4, disruption: 40, teacherGap: 8 },
          // The first call of the run is the lead, whatever its variant.
          search: { workers: 4, probes: true, maxSeconds: 30, seed: 1 },
          // Only the lesson whose post this fetch still sends.
          previousLessons: [{ requirementId: 'anon-ma', dayOfWeek: 4, startTime: '13:00:00' }],
          timeoutMs: 95_000,
        });
        expect(calls[1]).toMatchObject({ weights: { disruption: 55 }, search: { probes: false, seed: 2 } });
        expect(stored.map((row) => [row['ordinal'], row['variant']])).toEqual([
          [2, 'TEACHER_GAPS'],
          [3, 'SPREAD'],
        ]);
      });

      it('a refresh whose first candidate finds nothing stops there too', async () => {
        proxy.solveCandidate.mockResolvedValueOnce(solved({ status: 'INFEASIBLE', lessons: [], lunches: null, conflicts: conflictAnalysis }));
        await startAndRun(dto({ refreshOf: OLD_RUN }));
        expect(run).toMatchObject({ status: 'FAILED', errorCode: CANDIDATES_FIRST_FAILED });
      });
    });
  });

  describe('the sweep and shutdown', () => {
    it('registers every quarter hour only when CANDIDATES_BACKGROUND is on and a runner exists, and leaves on shutdown', async () => {
      service.onModuleInit();
      expect(jobs.register).toHaveBeenCalledWith({ name: SWEEP_JOB, intervalMs: SWEEP_INTERVAL_MS, tick: expect.any(Function) });
      expect(service.scheduled).toBe(true);
      await service.onModuleDestroy();
      expect(jobs.unregister).toHaveBeenCalledWith(SWEEP_JOB);

      jobs.register.mockClear();
      candidatesConfig.background = false;
      build().onModuleInit();
      expect(jobs.register).not.toHaveBeenCalled();
      expect(
        new ScheduleCandidatesService(prisma as never, proxy as never, versions as never, realtime as never).scheduled,
      ).toBe(false);
    });

    it('settles a pass with its count, and a failed pass by its error name', async () => {
      tx.$queryRaw.mockResolvedValueOnce([{ changed: 3 }]);
      await service.tick();
      expect(jobs.settled).toHaveBeenCalledWith(SWEEP_JOB, expect.any(Date), { ok: true, counts: { changed: 3 } });

      prisma.withDeliveryService.mockRejectedValueOnce(new TypeError('boom'));
      await service.tick();
      expect(jobs.settled).toHaveBeenLastCalledWith(SWEEP_JOB, expect.any(Date), { ok: false, error: 'TypeError' });
    });

    it('fails this instance\'s runs in flight CANDIDATE_RUN_INTERRUPTED under their admin on shutdown', async () => {
      let release!: () => void;
      proxy.solveCandidate.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(solved()))));
      await service.start(dto(), user);
      for (let turn = 0; turn < 20 && !release; turn++) await new Promise((resolve) => setImmediate(resolve));
      expect(service.running).toEqual([RUN]);

      // The call out on the engine was given its deadline with the heartbeat:
      // 30 s + 45 + the lead's probe 20, the latest it can still be solving.
      const busy = tx.$executeRaw.mock.calls
        .map((args) => sqlOf(args))
        .filter(({ text }) => text.includes('"engineBusyUntil" = now() + make_interval(secs =>'));
      expect(busy.map(({ values }) => values[0])).toEqual([95]);

      await service.onModuleDestroy();
      expect(run).toMatchObject({ status: 'FAILED', errorCode: CANDIDATE_RUN_INTERRUPTED });
      expect(prisma.withRls).toHaveBeenLastCalledWith(user, expect.any(Function));
      // The interruption keeps that deadline: the run holds its place under
      // CANDIDATE_RUNS_MAX until the orphaned solve could have ended.
      const interrupted = tx.scheduleCandidateRun.updateMany.mock.calls.at(-1)![0] as { data: Record<string, unknown> };
      expect(interrupted.data).not.toHaveProperty('engineBusyUntil');

      // The task wakes to a run that is no longer its own, and writes nothing.
      release();
      for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
      expect(stored).toHaveLength(0);
      expect(run.errorCode).toBe(CANDIDATE_RUN_INTERRUPTED);
    });
  });

  describe('GET candidates', () => {
    const NOW = new Date('2026-10-17T12:00:00.000Z');
    const row = (overrides: Record<string, unknown> = {}): Parameters<typeof runViewOf>[0] & { candidates: unknown[]; unplaced: unknown } => ({
      id: RUN,
      status: 'SUCCEEDED',
      requested: 2,
      progress: 2,
      createdAt: new Date('2026-10-17T11:50:00.000Z'),
      startedAt: new Date('2026-10-17T11:50:01.000Z'),
      finishedAt: new Date('2026-10-17T11:53:00.000Z'),
      error: null,
      errorCode: null,
      errorParams: null,
      createdById: user.userId,
      appliedCandidateId: null,
      appliedAt: null,
      refreshOfId: null,
      heartbeatAt: new Date('2026-10-17T11:53:00.000Z'),
      leaseSeconds: 250,
      unplaced: { lines: 1, minutes: 30, draftLines: 2, draftMinutes: 90 },
      candidates: [
        { id: CANDIDATE, ordinal: 1, variant: 'KEEP', weights: null, solverStatus: 'OPTIMAL', errorCode: null, metrics: { moved: 1, movedOf: 2, kept: 1, roomChanges: 0, sameAs: null, lessonCount: 2, unplaced: { lines: 1, minutes: 30 } }, conflicts: [] },
        { id: 'c2', ordinal: 2, variant: 'TEACHER_GAPS', weights: { disruption: 2, teacherGap: 8 }, solverStatus: 'TIMEOUT', errorCode: 'CONFLICT_CORE_SUMMARY', errorParams: { count: 1, nested: { x: 1 } }, metrics: null, conflicts: [{ category: 'INSUFFICIENT_RESOURCES', message: 'm' }] },
      ],
      ...overrides,
    }) as never;

    it('passes a stored sentence out field by field: nothing else a row carries goes with it', async () => {
      tx.scheduleCandidateRun.findFirst.mockResolvedValueOnce(
        row({
          candidates: [
            {
              id: CANDIDATE, ordinal: 1, variant: 'KEEP', weights: null, solverStatus: 'INFEASIBLE', errorCode: null, metrics: null,
              conflicts: [{ category: 'AVAILABILITY', code: 'X', params: { n: 1 }, message: 'm', resourceNames: ['Sal 1'], subjectIds: ['teacher-1'], resourceIds: ['r-1'] }],
            },
          ],
        }),
      );
      const overview = await service.overview(YEAR, user, NOW);
      expect(overview.latest!.candidates[0]!.conflicts).toEqual([
        { category: 'AVAILABILITY', code: 'X', params: { n: 1 }, message: 'm', resourceNames: ['Sal 1'] },
      ]);
    });

    it('answers the newest run as the batch too when it SUCCEEDED, with the five figures, never the lessons', async () => {
      tx.scheduleCandidateRun.findFirst.mockResolvedValueOnce(row());
      const overview = await service.overview(YEAR, user, NOW);
      expect(tx.scheduleCandidateRun.findFirst).toHaveBeenCalledTimes(1);
      const select = tx.scheduleCandidateRun.findFirst.mock.calls[0][0].select;
      expect(select.candidates.select).not.toHaveProperty('lessons');
      expect(overview.batch).toEqual(overview.latest);
      expect(overview.unplaced).toEqual({ lines: 1, minutes: 30, draftLines: 2, draftMinutes: 90 });
      expect(overview.latest!.run).toEqual({
        id: RUN,
        status: 'SUCCEEDED',
        requested: 2,
        progress: 2,
        createdAt: '2026-10-17T11:50:00.000Z',
        startedAt: '2026-10-17T11:50:01.000Z',
        finishedAt: '2026-10-17T11:53:00.000Z',
        error: null,
        errorCode: null,
        errorParams: null,
        createdById: user.userId,
        createdByName: null,
        appliedCandidateId: null,
        appliedAt: null,
        refreshOfId: null,
      });
      expect(overview.latest!.candidates).toEqual([
        // A row from before the wishes were measured: not measured, not "none".
        { id: CANDIDATE, ordinal: 1, variant: 'KEEP', weights: null, solverStatus: 'OPTIMAL', lessonCount: 2, errorCode: null, errorParams: null, metrics: { moved: 1, movedOf: 2, roomChanges: 0, kept: 1, sameAs: null }, conflicts: [], notes: null, deviations: null, deviationsDigest: null },
        // The summary's values, scalars only: what its sentence substitutes.
        { id: 'c2', ordinal: 2, variant: 'TEACHER_GAPS', weights: { disruption: 2, teacherGap: 8 }, solverStatus: 'TIMEOUT', lessonCount: 0, errorCode: 'CONFLICT_CORE_SUMMARY', errorParams: { count: 1 }, metrics: null, conflicts: [{ category: 'INSUFFICIENT_RESOURCES', message: 'm', resourceNames: [] }], notes: null, deviations: null, deviationsDigest: null },
      ]);
      expect(overview.draftNotes).toBeNull();
      // Nobody to name, so no read of Users.
      expect(tx.user.findMany).not.toHaveBeenCalled();
    });

    it('answers a running newest run beside the previous batch, and nothing for a year without runs', async () => {
      tx.scheduleCandidateRun.findFirst
        .mockResolvedValueOnce(row({ id: 'new', status: 'RUNNING', progress: 1, finishedAt: null, heartbeatAt: new Date('2026-10-17T11:59:00.000Z'), createdAt: new Date('2026-10-17T11:58:00.000Z'), unplaced: null, candidates: [] }))
        .mockResolvedValueOnce(row());
      const overview = await service.overview(YEAR, user, NOW);
      expect(overview.latest!.run).toMatchObject({ id: 'new', status: 'RUNNING', progress: 1 });
      expect(overview.batch!.run.id).toBe(RUN);
      // Neither question finds a run a discard removed.
      expect(tx.scheduleCandidateRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { academicYearId: YEAR, discardedAt: null } }));
      expect(tx.scheduleCandidateRun.findFirst).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { academicYearId: YEAR, status: 'SUCCEEDED', discardedAt: null } }),
      );

      tx.scheduleCandidateRun.findFirst.mockResolvedValue(null);
      await expect(service.overview(YEAR, user, NOW)).resolves.toEqual({ latest: null, batch: null, unplaced: null, draftNotes: null });
    });

    describe('the free-day wishes', () => {
      const wish = (userId: string, day: number, extra: Record<string, unknown> = {}) => ({
        category: 'AVAILABILITY',
        code: 'TEACHER_FREE_DAY_WISH_NOT_KEPT',
        params: { day },
        message: 'A teacher wishes Mondays free …',
        resourceNames: [],
        subjectIds: [userId],
        ...extra,
      });
      const shown = (day: number, names: string[]) => ({
        category: 'AVAILABILITY',
        code: 'TEACHER_FREE_DAY_WISH_NOT_KEPT',
        params: { day },
        message: 'A teacher wishes Mondays free …',
        resourceNames: names,
      });
      const keep = { id: CANDIDATE, ordinal: 1, variant: 'KEEP', weights: null, solverStatus: 'OPTIMAL', errorCode: null, metrics: { moved: 0, movedOf: 2, kept: 2, roomChanges: 0, sameAs: null, lessonCount: 2 }, conflicts: [] };

      it('names the teachers of the draft’s and every candidate’s notes for every reader, in one read of Users, and keeps their ids on the server', async () => {
        tx.scheduleCandidateRun.findFirst.mockResolvedValueOnce(
          row({
            draftNotes: [wish(TEACHER, 1), wish(OTHER_TEACHER, 3)],
            candidates: [
              { ...keep, notes: [wish(TEACHER, 1, { resourceIds: ['rule-1'], extra: 'kept' })] },
              { ...keep, id: 'c2', ordinal: 2, variant: 'TEACHER_GAPS', notes: [] },
            ],
          }),
        );
        // The other teacher is gone, or RLS hides them: named by nobody.
        tx.user.findMany.mockResolvedValue([{ id: TEACHER, firstName: 'Eva', lastName: 'Ek' }]);

        const overview = await service.overview(YEAR, user, NOW);

        expect(overview.draftNotes).toEqual([shown(1, ['Eva Ek']), shown(3, [])]);
        expect(overview.batch!.candidates.map((candidate) => candidate.notes)).toEqual([[shown(1, ['Eva Ek'])], []]);
        expect(overview.latest).toEqual(overview.batch);
        // Each teacher once, though the newest run is the batch too.
        expect(tx.user.findMany).toHaveBeenCalledTimes(1);
        expect(tx.user.findMany).toHaveBeenCalledWith({
          where: { id: { in: [TEACHER, OTHER_TEACHER] } },
          select: { id: true, firstName: true, lastName: true },
        });
        expect(JSON.stringify(overview)).not.toMatch(new RegExp(`subjectIds|rule-1|extra|${TEACHER}|${OTHER_TEACHER}`));
        // A name beside a staff-readable wish is not recorded (access-log.ts).
        expect(recordedReads(tx)).toEqual([]);
      });

      it('names a refused candidate’s travel teachers for every reader, from the ids it keeps', async () => {
        // Restid i generatorn: a candidate refused over the walk names the
        // teachers who cannot make it as a note names its teacher.
        const travel = {
          category: 'TEACHER_OVERLAP',
          code: 'TEACHER_TRAVEL_CANNOT_BE_KEPT',
          params: { stepMinutes: 30, measured: 1 },
          message: 'The travel time between the school’s sites cannot be kept …',
          resourceNames: [],
          subjectIds: [TEACHER, OTHER_TEACHER],
        };
        tx.scheduleCandidateRun.findFirst.mockResolvedValueOnce(
          row({
            draftNotes: [],
            candidates: [{ ...keep, solverStatus: 'INFEASIBLE', metrics: null, conflicts: [travel], notes: null }],
          }),
        );
        tx.user.findMany.mockResolvedValue([{ id: TEACHER, firstName: 'Eva', lastName: 'Ek' }]);

        const overview = await service.overview(YEAR, user, NOW);

        expect(overview.batch!.candidates[0]!.conflicts).toEqual([
          {
            category: 'TEACHER_OVERLAP',
            code: 'TEACHER_TRAVEL_CANNOT_BE_KEPT',
            params: { stepMinutes: 30, measured: 1 },
            message: travel.message,
            resourceNames: ['Eva Ek'],
          },
        ]);
        expect(tx.user.findMany).toHaveBeenCalledWith({
          where: { id: { in: [TEACHER, OTHER_TEACHER] } },
          select: { id: true, firstName: true, lastName: true },
        });
        expect(JSON.stringify(overview)).not.toMatch(new RegExp(`subjectIds|${TEACHER}|${OTHER_TEACHER}`));
        expect(recordedReads(tx)).toEqual([]);
      });

      it('names the previous batch’s teachers beside a running run, and shows no wish of a candidate with no timetable', async () => {
        tx.scheduleCandidateRun.findFirst
          .mockResolvedValueOnce(row({ id: 'new', status: 'RUNNING', progress: 0, finishedAt: null, heartbeatAt: NOW, unplaced: null, candidates: [] }))
          .mockResolvedValueOnce(
            row({
              draftNotes: [],
              candidates: [
                { ...keep, notes: [wish(TEACHER, 1)] },
                // A hand-edited row: a TIMEOUT has no timetable, whatever it holds.
                { ...keep, id: 'c2', ordinal: 2, solverStatus: 'TIMEOUT', metrics: null, notes: [wish(OTHER_TEACHER, 3)] },
              ],
            }),
          );
        tx.user.findMany.mockResolvedValue([{ id: TEACHER, firstName: 'Eva', lastName: 'Ek' }]);

        const overview = await service.overview(YEAR, user, NOW);

        expect(overview.latest!.candidates).toEqual([]);
        expect(overview.draftNotes).toEqual([]);
        expect(overview.batch!.candidates.map((candidate) => candidate.notes)).toEqual([[shown(1, ['Eva Ek'])], null]);
      });

      it('reads a notes column that is not a list as not measured', async () => {
        tx.scheduleCandidateRun.findFirst.mockResolvedValueOnce(
          row({ draftNotes: { unexpected: 'shape' }, candidates: [{ ...keep, notes: 'not a list' }] }),
        );

        const overview = await service.overview(YEAR, user, NOW);

        expect(overview.draftNotes).toBeNull();
        expect(overview.batch!.candidates[0]!.notes).toBeNull();
        expect(tx.user.findMany).not.toHaveBeenCalled();
      });
    });

    it('shows an active run past its lease, or older than half an hour, as FAILED CANDIDATE_RUN_ABANDONED', () => {
      const base = row({ status: 'RUNNING', finishedAt: null });
      // Heartbeat 11:53 + 250 s = 11:57:10, before noon.
      expect(runViewOf(base, NOW)).toMatchObject({
        status: 'FAILED',
        errorCode: CANDIDATE_RUN_ABANDONED,
        finishedAt: '2026-10-17T11:57:10.000Z',
      });
      expect(runViewOf({ ...base, heartbeatAt: new Date('2026-10-17T11:59:00.000Z') }, NOW)).toMatchObject({ status: 'RUNNING', errorCode: null });
      expect(
        runViewOf({ ...base, heartbeatAt: new Date('2026-10-17T11:59:00.000Z'), createdAt: new Date('2026-10-17T11:29:00.000Z') }, NOW),
      ).toMatchObject({ status: 'FAILED', errorCode: CANDIDATE_RUN_ABANDONED });
      // A finished run is what it is, however old.
      expect(runViewOf(row({ heartbeatAt: new Date(0) }), NOW)).toMatchObject({ status: 'SUCCEEDED' });
    });
  });

  describe('GET candidates/:id/lessons', () => {
    it('resolves each lesson from its timplanspost now, leaves out one whose post is gone, and names no pupil', async () => {
      tx.scheduleCandidate.findUnique.mockResolvedValue({
        lessons: [
          { requirementId: 'req-ma', roomId: ROOM, dayOfWeek: 1, startTime: '08:00', endTime: '09:00' },
          { requirementId: 'req-sv', roomId: null, dayOfWeek: 3, startTime: '10:00', endTime: '11:00' },
          { requirementId: 'req-gone', roomId: null, dayOfWeek: 4, startTime: '10:00', endTime: '11:00' },
        ],
      });
      tx.teachingRequirement.findMany.mockResolvedValue(requirementRows);
      const lessons = await service.lessons(CANDIDATE, user);
      expect(tx.teachingRequirement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['req-ma', 'req-sv', 'req-gone'] } } }),
      );
      expect(lessons).toEqual([
        { requirementId: 'req-ma', subjectId: MA, studentGroupId: G7A, teacherId: TEACHER, coTeacherId: null, roomId: ROOM, dayOfWeek: 1, startTime: '08:00', endTime: '09:00', recurrence: 'ALL_WEEKS', startDate: null, endDate: null },
        { requirementId: 'req-sv', subjectId: SV, studentGroupId: G7A, teacherId: null, coTeacherId: null, roomId: null, dayOfWeek: 3, startTime: '10:00', endTime: '11:00', recurrence: 'ODD_WEEKS', startDate: '2027-01-11', endDate: null },
      ]);
      expect(JSON.stringify(lessons)).not.toMatch(/studentIds|participants/);
    });

    it('404 CANDIDATE_GONE for a candidate that is not there, and nothing read for one with no lessons', async () => {
      tx.scheduleCandidate.findUnique.mockResolvedValueOnce(null);
      await expect(service.lessons(CANDIDATE, user)).rejects.toMatchObject({ status: 404, response: expect.objectContaining({ code: CANDIDATE_GONE }) });
      tx.scheduleCandidate.findUnique.mockResolvedValueOnce({ lessons: [] });
      await expect(service.lessons(CANDIDATE, user)).resolves.toEqual([]);
      expect(tx.teachingRequirement.findMany).not.toHaveBeenCalled();
    });
  });

  describe('GET candidates/runs/:runId/check', () => {
    beforeEach(() => {
      tx.scheduleCandidateRun.findUnique.mockResolvedValue({ academicYearId: YEAR, basis: BASIS, basisParts: PARTS });
    });

    it('rebuilds the basis once in a transaction that writes no timetable, and finds an unchanged batch fresh', async () => {
      await expect(service.check(RUN, user)).resolves.toEqual({
        stale: false,
        changed: [],
        refusalCode: null,
        mode: 'DRAFT',
        futureCalendarLessons: 0,
        coverAssignments: 0,
        deviations: null,
        deviationsDigest: null,
      });
      // Not READ ONLY: the fetch writes its Läslogg row for the posts' day
      // limits it reads (Lärarens dag), and a read-only transaction would
      // refuse it. It writes nothing of the timetable.
      expect(steps.some((step) => step.includes('READ ONLY'))).toBe(false);
      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
      expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
      expect(proxy.prepareSchedule).toHaveBeenCalledWith(tx, YEAR, user);
      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function), { timeoutMs: 30_000 });
      expect(tx.calendarLesson.count).not.toHaveBeenCalled();
    });

    it('names the parts that changed, and the refusal the draft now meets', async () => {
      proxy.prepareSchedule.mockResolvedValueOnce(prepared({ basis: 'b'.repeat(64), basisParts: { ...PARTS, preserved: 'f'.repeat(64), rosters: 'e'.repeat(64) } }));
      await expect(service.check(RUN, user)).resolves.toMatchObject({ stale: true, changed: ['preserved', 'rosters'] });

      proxy.prepareSchedule.mockResolvedValueOnce({ ready: false, refusalCode: 'BLOCK_PARTLY_LOCKED_SUMMARY' });
      await expect(service.check(RUN, user)).resolves.toEqual({
        stale: true,
        changed: [],
        refusalCode: 'BLOCK_PARTLY_LOCKED_SUMMARY',
        mode: 'DRAFT',
        futureCalendarLessons: 0,
        coverAssignments: 0,
        deviations: null,
        deviationsDigest: null,
      });
    });

    it('in DIRECT counts the dated lessons the write would remove, by its own clause, and the vikarier on them', async () => {
      tx.$queryRaw.mockImplementation(async (...args: unknown[]) => (sqlOf(args).text.includes('school_publish_mode') ? [{ mode: 'DIRECT' }] : []));
      tx.calendarLesson.count.mockResolvedValue(40);
      tx.calendarLessonTeacher.count.mockResolvedValue(3);
      await expect(service.check(RUN, user)).resolves.toMatchObject({ mode: 'DIRECT', futureCalendarLessons: 40, coverAssignments: 3 });
      const where = tx.calendarLesson.count.mock.calls[0][0].where;
      expect(where).toMatchObject({ masterLessonId: { in: ['m-1', 'm-2'] }, status: 'SCHEDULED', attendanceRecords: { none: {} } });
      expect(tx.calendarLessonTeacher.count).toHaveBeenCalledWith({ where: { role: 'SUBSTITUTE', calendarLesson: { is: where } } });
    });

    it.each([
      ['00:30 summer time', '2026-08-12T22:30:00.000Z', '2026-08-13'],
      ['00:30 winter time', '2026-01-14T23:30:00.000Z', '2026-01-15'],
      ['23:30 summer time', '2026-08-12T21:30:00.000Z', '2026-08-12'],
    ])("in DIRECT at %s counts from the school's today, the day the apply sweeps from", async (_label, instant, day) => {
      // UTC's day at 00:30 is yesterday in Stockholm: the dialog would have
      // counted yesterday's lessons, which the apply no longer takes.
      tx.$queryRaw.mockImplementation(async (...args: unknown[]) => (sqlOf(args).text.includes('school_publish_mode') ? [{ mode: 'DIRECT' }] : []));
      tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
      tx.calendarLesson.count.mockResolvedValue(0);
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }).setSystemTime(new Date(instant));
      try {
        await service.check(RUN, user);
      } finally {
        jest.useRealTimers();
      }
      expect(tx.school.findUnique).toHaveBeenCalledWith({ where: { id: SCHOOL }, select: { timezone: true } });
      expect(tx.calendarLesson.count.mock.calls[0][0].where.date).toEqual({ gte: new Date(`${day}T00:00:00.000Z`) });
    });

    it('404 CANDIDATE_GONE for a run that is not there, or that a discard removed', async () => {
      tx.scheduleCandidateRun.findUnique.mockResolvedValue(null);
      await expect(service.check(RUN, user)).rejects.toMatchObject({ status: 404, response: expect.objectContaining({ code: CANDIDATE_GONE }) });
      tx.scheduleCandidateRun.findUnique.mockResolvedValue({ academicYearId: YEAR, basis: BASIS, basisParts: PARTS, discardedAt: new Date() });
      await expect(service.check(RUN, user)).rejects.toMatchObject({ status: 404, response: expect.objectContaining({ code: CANDIDATE_GONE }) });
      expect(proxy.prepareSchedule).not.toHaveBeenCalled();
    });
  });

  describe('POST candidates/:id/apply', () => {
    const storedCandidate = (overrides: Record<string, unknown> = {}) => ({
      id: CANDIDATE,
      runId: RUN,
      ordinal: 2,
      variant: 'TEACHER_GAPS',
      solverStatus: 'OPTIMAL',
      lessons: [
        { requirementId: 'req-ma', roomId: ROOM, dayOfWeek: 1, startTime: '08:00', endTime: '09:00' },
        { requirementId: 'req-sv', roomId: null, dayOfWeek: 3, startTime: '10:00', endTime: '11:00' },
      ],
      lunches: [{ studentGroupId: G7A, dayOfWeek: 1, startTime: '11:30:00', endTime: '12:00:00' }],
      metrics: { moved: 1, movedOf: 2, kept: 1, roomChanges: 0, sameAs: null, lessonCount: 2, unplaced: null },
      run: { academicYearId: YEAR },
      ...overrides,
    });
    const created = new Date('2026-10-17T11:50:00.000Z');

    beforeEach(() => {
      run = { status: 'SUCCEEDED', progress: 2, basis: BASIS, basisParts: PARTS };
      tx.scheduleCandidate.findUnique.mockResolvedValue(storedCandidate());
      tx.scheduleCandidateRun.findUnique.mockImplementation(async () => ({ id: RUN, status: run.status, basis: BASIS, basisParts: PARTS, createdAt: created }));
    });

    const refusal = async (mode: 'DRAFT' | 'DIRECT' = 'DRAFT') => {
      const error = (await service.apply(CANDIDATE, mode, user).catch((caught: unknown) => caught)) as HttpException;
      expect(error).toBeInstanceOf(HttpException);
      return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
    };

    it('takes the publication lock, then the three year locks in their order, the run, the masters, the fetch, and only then writes', async () => {
      await expect(service.apply(CANDIDATE, 'DRAFT', user)).resolves.toEqual({ lessonsCreated: 2, versionId: 'version-1' });
      const at = (needle: string) => {
        const index = steps.findIndex((step) => step.includes(needle));
        expect(index).toBeGreaterThan(-1);
        return index;
      };
      const order = [
        at('enter_grundschema_write'),
        at(`SET LOCAL lock_timeout = '5s'`),
        at(`hashtext('grundschema-regenerate')`),
        at(`hashtext('room-optimization')`),
        at(`hashtext('staffing-proposal')`),
        at('"ScheduleCandidateRuns" WHERE "id" ='),
        at('FROM "MasterLessons"'),
        at('proxy:prepare'),
        at('proxy:write'),
      ];
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function), { timeoutMs: 60_000 });
    });

    it('writes through the proxy with the rebuilt fetch, the stored lessons and lunches, the safety version and the change log\'s after', async () => {
      await service.apply(CANDIDATE, 'DRAFT', user);
      const [client, input] = proxy.applyCandidateWrite.mock.calls[0];
      expect(client).toBe(tx);
      expect(input).toMatchObject({
        user,
        mode: 'DRAFT',
        lessons: storedCandidate().lessons,
        lunches: storedCandidate().lunches,
        solverStatus: 'OPTIMAL',
        snapshot: { versions, name: 'Före schemaförslag 2 – Färre håltimmar för lärarna' },
        after: { source: 'CANDIDATE', runId: RUN, ordinal: 2, variant: 'TEACHER_GAPS', metrics: storedCandidate().metrics },
      });
      expect(input.prepared).toMatchObject({ basis: BASIS, draftIds: ['m-1', 'm-2'] });
      expect(run.appliedCandidateId).toBe(CANDIDATE);
      expect((run as { appliedAt?: Date }).appliedAt).toBeInstanceOf(Date);
    });

    it('asks a newer active run of the year to stop, and keeps the batch', async () => {
      await service.apply(CANDIDATE, 'DRAFT', user);
      expect(tx.scheduleCandidateRun.updateMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR, status: { in: ['PENDING', 'RUNNING'] }, createdAt: { gt: created } },
        data: { status: 'CANCELLING' },
      });
      expect(tx.scheduleCandidateRun.deleteMany).not.toHaveBeenCalled();
    });

    it('sends the realtime notice after the commit, the draft\'s in DRAFT and everyone\'s in DIRECT', async () => {
      await service.apply(CANDIDATE, 'DRAFT', user);
      expect(realtime.notifyMasterTimetableChanged).toHaveBeenLastCalledWith(SCHOOL, { draft: true });

      tx.$queryRaw.mockImplementation(async (...args: unknown[]) =>
        sqlOf(args).text.includes('enter_grundschema_write') ? [{ mode: 'DIRECT' }] : [],
      );
      await service.apply(CANDIDATE, 'DIRECT', user);
      expect(realtime.notifyMasterTimetableChanged).toHaveBeenLastCalledWith(SCHOOL);
    });

    it('409 PUBLISH_MODE_CHANGED when the school\'s mode is not the one the dialog was confirmed in, before any year lock', async () => {
      await expect(refusal('DIRECT')).resolves.toEqual({
        status: 409,
        body: expect.objectContaining({ code: PUBLISH_MODE_CHANGED, params: { mode: 'DRAFT' } }),
      });
      expect(steps.some((step) => step.includes('grundschema-regenerate'))).toBe(false);
      expect(proxy.applyCandidateWrite).not.toHaveBeenCalled();
    });

    it('404 CANDIDATE_GONE for a candidate that is not there', async () => {
      tx.scheduleCandidate.findUnique.mockResolvedValue(null);
      await expect(refusal()).resolves.toEqual({ status: 404, body: expect.objectContaining({ code: CANDIDATE_GONE }) });
    });

    it.each([
      ['a run that is not SUCCEEDED', () => (run.status = 'FAILED')],
      ['a candidate that found no timetable', () => tx.scheduleCandidate.findUnique.mockResolvedValue(storedCandidate({ solverStatus: 'INFEASIBLE' }))],
      ['a candidate whose stored lessons are not the run\'s shape', () => tx.scheduleCandidate.findUnique.mockResolvedValue(storedCandidate({ lessons: [{ requirementId: 1 }] }))],
    ])('409 SCHEDULE_CANDIDATE_NOT_APPLICABLE for %s', async (_label, arrange) => {
      arrange();
      await expect(refusal()).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: SCHEDULE_CANDIDATE_NOT_APPLICABLE }) });
      expect(proxy.prepareSchedule).not.toHaveBeenCalled();
    });

    it('409 GENERATE_RUNNING beside a Generera job of the year', async () => {
      tx.optimizationJob.count.mockResolvedValue(1);
      await expect(refusal()).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: GENERATE_RUNNING }) });
      expect(proxy.applyCandidateWrite).not.toHaveBeenCalled();
    });

    it('409 SCHEDULE_CANDIDATE_STALE naming the parts that changed, and writes nothing', async () => {
      proxy.prepareSchedule.mockResolvedValue(prepared({ basis: 'b'.repeat(64), basisParts: { ...PARTS, requirements: 'f'.repeat(64) } }));
      await expect(refusal()).resolves.toEqual({
        status: 409,
        body: expect.objectContaining({
          code: SCHEDULE_CANDIDATE_STALE,
          changed: ['requirements'],
          refusalCode: null,
          // What the problem filter forwards: the code and flat params.
          params: { changed: 'requirements' },
        }),
      });
      expect(proxy.applyCandidateWrite).not.toHaveBeenCalled();
      expect(run.appliedCandidateId).toBeUndefined();
    });

    it('409 SCHEDULE_CANDIDATE_STALE with the refusal the draft now meets', async () => {
      proxy.prepareSchedule.mockResolvedValue({ ready: false, refusalCode: 'STAFF_UNSTAFFED_REQUIREMENTS' });
      await expect(refusal()).resolves.toEqual({
        status: 409,
        body: expect.objectContaining({
          code: SCHEDULE_CANDIDATE_STALE,
          changed: [],
          refusalCode: 'STAFF_UNSTAFFED_REQUIREMENTS',
          params: { refusalCode: 'STAFF_UNSTAFFED_REQUIREMENTS' },
        }),
      });
    });

    it('passes the final asserts\' refusal on and marks nothing applied', async () => {
      proxy.applyCandidateWrite.mockRejectedValue(
        new ConflictException({ code: SCHEDULE_CANDIDATE_STALE, changed: ['preserved'], refusalCode: null }),
      );
      await expect(refusal()).resolves.toEqual({
        status: 409,
        body: expect.objectContaining({ code: SCHEDULE_CANDIDATE_STALE, changed: ['preserved'], params: { changed: 'preserved' } }),
      });
      expect(run.appliedCandidateId).toBeUndefined();
      expect(realtime.notifyMasterTimetableChanged).not.toHaveBeenCalled();
    });

    it('409 SCHEDULE_CANDIDATE_BUSY when a year lock is not had in 5 s, and for a deadlock anywhere in the transaction', async () => {
      const original = tx.$executeRaw.getMockImplementation()!;
      tx.$executeRaw.mockImplementation(async (...args: unknown[]) => {
        if (sqlOf(args).text.includes('room-optimization')) throw new Error('canceling statement due to lock timeout (55P03)');
        return original(...args);
      });
      await expect(refusal()).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: SCHEDULE_CANDIDATE_BUSY }) });
      tx.$executeRaw.mockImplementation(original);

      proxy.prepareSchedule.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('deadlock detected', { code: 'P2034', clientVersion: 'test' }),
      );
      await expect(refusal()).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: SCHEDULE_CANDIDATE_BUSY }) });

      proxy.prepareSchedule.mockRejectedValueOnce(new Error('something else'));
      await expect(service.apply(CANDIDATE, 'DRAFT', user)).rejects.toThrow('something else');
    });
  });

  describe('DELETE candidates', () => {
    it('asks the active run to stop and deletes the finished ones, never an active one', async () => {
      run = { status: 'RUNNING', progress: 1, basis: BASIS, basisParts: PARTS };
      await service.discard(YEAR, user);
      expect(tx.scheduleCandidateRun.updateMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR, status: { in: ['PENDING', 'RUNNING'] } },
        data: { status: 'CANCELLING' },
      });
      expect(tx.scheduleCandidateRun.deleteMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR, status: { in: ['SUCCEEDED', 'FAILED'] }, OR: [{ engineBusyUntil: null }, { engineBusyUntil: { lte: expect.any(Date) } }] },
      });
      expect(run.status).toBe('CANCELLING');
      // No run with a call out: nothing is marked.
      expect(tx.scheduleCandidate.deleteMany).not.toHaveBeenCalled();
    });

    it('empties and hides a finished run whose engine call can still be solving, instead of deleting its place under the cap', async () => {
      tx.scheduleCandidateRun.findMany.mockResolvedValueOnce([{ id: 'interrupted' }]);
      await service.discard(YEAR, user);
      const deleted = tx.scheduleCandidateRun.deleteMany.mock.calls[0][0] as { where: { OR: Array<{ engineBusyUntil: unknown }> } };
      const asked = tx.scheduleCandidateRun.findMany.mock.calls[0][0] as { where: { engineBusyUntil: { gt: Date } } };
      expect(asked).toEqual({ where: { academicYearId: YEAR, status: { in: ['SUCCEEDED', 'FAILED'] }, engineBusyUntil: { gt: expect.any(Date) } }, select: { id: true } });
      // One clock for the rows deleted and the rows kept: each run is in exactly one.
      expect(deleted.where.OR[1]).toEqual({ engineBusyUntil: { lte: asked.where.engineBusyUntil.gt } });
      expect(tx.scheduleCandidate.deleteMany).toHaveBeenCalledWith({ where: { runId: { in: ['interrupted'] } } });
      expect(tx.scheduleCandidateRun.updateMany).toHaveBeenLastCalledWith({
        where: { id: { in: ['interrupted'] }, discardedAt: null },
        data: { discardedAt: asked.where.engineBusyUntil.gt },
      });
    });

    it('a new batch hides the year\'s older runs whose call is still out the same way', async () => {
      tx.scheduleCandidateRun.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
        where['engineBusyUntil'] ? [{ id: 'timed-out' }] : [],
      );
      await startAndRun(dto({ count: 2 }));
      expect(run.status).toBe('SUCCEEDED');
      expect(tx.scheduleCandidateRun.findMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR, id: { not: RUN }, status: { in: ['SUCCEEDED', 'FAILED'] }, engineBusyUntil: { gt: expect.any(Date) } },
        select: { id: true },
      });
      expect(tx.scheduleCandidate.deleteMany).toHaveBeenCalledWith({ where: { runId: { in: ['timed-out'] } } });
      expect(tx.scheduleCandidateRun.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['timed-out'] }, discardedAt: null },
        data: { discardedAt: expect.any(Date) },
      });
    });
  });

  describe('Bästa möjliga schema', () => {
    const ANNA = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const WORK_RULE = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
    const POST = 'cccccccc-3333-4333-8333-cccccccccccc';
    const bestEffort = (overrides: Partial<StartCandidatesDto> = {}) => dto({ mode: 'BEST_EFFORT', ...overrides });
    const switchedOn = (on = true) => tx.lunchSetting.findUnique.mockResolvedValue({ generatorBestEffort: on });

    /** The engine's lines as the proxy hands them over, realised: a cap that gave way, a subject's per-day cap, a part-timer's days. */
    const realised = {
      cap: {
        category: 'DEVIATION' as const,
        code: 'DEVIATION_TEACHER_DAILY_CAP',
        params: { rule: WORK_RULE, day: 1, minutes: 360, taught: 375, over: 15, needed: 375 },
        message: `The cap that the working-time rule ${WORK_RULE} sets gave way on Monday.`,
        requirementIds: [], roomIds: [], constraintIds: [], resourceIds: [WORK_RULE], resourceNames: [], subjectIds: [ANNA],
      },
      perDay: {
        category: 'DEVIATION' as const,
        code: 'DEVIATION_SUBJECT_PER_DAY',
        params: { requirement: 'Matematik för 7A', day: 2, maxPerDay: 1, count: 2, over: 1, needed: 2 },
        message: 'Matematik för 7A has 2 lessons on Tuesday.',
        requirementIds: [], roomIds: [], constraintIds: [], resourceIds: [], resourceNames: [], subjectIds: [],
      },
      days: {
        category: 'DEVIATION' as const,
        code: 'DEVIATION_TEACHER_WORK_DAYS',
        params: {},
        message: DEVIATION_WORK_DAYS_HIDDEN_MESSAGE,
        requirementIds: [], roomIds: [], constraintIds: [], resourceIds: [], resourceNames: [], subjectIds: [],
      },
    };

    describe('POST candidates with mode BEST_EFFORT', () => {
      // The engine answers the mode with a list, as it always does.
      beforeEach(() => proxy.solveCandidate.mockResolvedValue(solved({ deviations: [] })));
      const refusal = async (body = bestEffort()) => {
        const error = (await service.start(body, user).catch((caught: unknown) => caught)) as HttpException;
        expect(error).toBeInstanceOf(HttpException);
        return { status: error.getStatus(), body: error.getResponse() as { code?: string } };
      };

      it('is refused 409 BEST_EFFORT_NOT_ENABLED while the school’s switch is off — no row, or a row that says off — and starts nothing', async () => {
        // No Skolregler row at all.
        tx.lunchSetting.findUnique.mockResolvedValue(null);
        await expect(refusal()).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: BEST_EFFORT_NOT_ENABLED }) });
        switchedOn(false);
        await expect(refusal()).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: BEST_EFFORT_NOT_ENABLED }) });
        expect(tx.lunchSetting.findUnique).toHaveBeenCalledWith({ where: { schoolId: SCHOOL }, select: { generatorBestEffort: true } });
        expect(tx.scheduleCandidateRun.create).not.toHaveBeenCalled();
        expect(proxy.prepareSchedule).not.toHaveBeenCalled();
        expect(proxy.solveCandidate).not.toHaveBeenCalled();
      });

      it('refuses before it takes a single lock, so a school that has not switched it on holds nobody up', async () => {
        switchedOn(false);
        await refusal();
        expect(steps.some((step) => step.includes('hashtext'))).toBe(false);
      });

      it('plans ONE candidate — ordinal 1, the code BEST_EFFORT, the run’s weights as they are, no seed — and sends the engine the mode', async () => {
        switchedOn();
        await startAndRun(bestEffort({ weights: { spread: 4 } as never }));

        expect(tx.scheduleCandidateRun.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ requested: 1, leaseSeconds: 190, weights: { spread: 4 }, refreshOfId: null }),
          select: { id: true },
        });
        // The lead call: probes on, so a refusal on a hard rule is explained.
        expect(proxy.solveCandidate.mock.calls.map(([, options]) => options)).toEqual([
          { weights: { spread: 4 }, search: { workers: 4, probes: true, maxSeconds: 30 }, bestEffort: true, timeoutMs: 95_000 },
        ]);
        expect(stored.map((row) => [row['ordinal'], row['variant'], row['seed'], row['weights']])).toEqual([[1, 'BEST_EFFORT', null, { spread: 4 }]]);
        expect(run).toMatchObject({ status: 'SUCCEEDED', progress: 1 });
      });

      it('sends no weights when the request names none, as KEEP does', async () => {
        switchedOn();
        await startAndRun(bestEffort());
        expect(proxy.solveCandidate.mock.calls[0]![1]).toMatchObject({ weights: null, bestEffort: true });
      });

      it('does not ask for a draft: the mode is for the week Generera placed nothing in', async () => {
        switchedOn();
        tx.masterLesson.count.mockResolvedValue(0);
        await expect(startAndRun(bestEffort())).resolves.toEqual({ runId: RUN });
        expect(tx.masterLesson.count).not.toHaveBeenCalled();
        // …where an ordinary run still needs one.
        await expect(refusal(dto())).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: CANDIDATES_NEED_A_DRAFT }) });
      });

      it('does not read a count: the run has one candidate, whatever a client sent beside the mode', async () => {
        switchedOn();
        await startAndRun(bestEffort({ count: 4 }));
        expect(proxy.solveCandidate).toHaveBeenCalledTimes(1);
        expect(stored).toHaveLength(1);
      });

      it('keeps every other guard of a start: Generera running, a run active, the year’s locks', async () => {
        switchedOn();
        tx.optimizationJob.count.mockResolvedValue(1);
        await expect(refusal()).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: GENERATE_RUNNING }) });
        tx.optimizationJob.count.mockResolvedValue(0);
        tx.scheduleCandidateRun.findFirst.mockResolvedValueOnce({ id: OLD_RUN });
        await expect(refusal()).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: CANDIDATES_RUNNING }) });
        expect(tx.scheduleCandidateRun.create).not.toHaveBeenCalled();
      });

      it('400 BEST_EFFORT_NO_REFRESH for the mode together with a refresh, before anything is read', async () => {
        switchedOn();
        await expect(refusal(bestEffort({ refreshOf: OLD_RUN }))).resolves.toEqual({ status: 400, body: expect.objectContaining({ code: BEST_EFFORT_NO_REFRESH }) });
        expect(prisma.withRls).not.toHaveBeenCalled();
        expect(prisma.withDeliveryService).not.toHaveBeenCalled();
      });

      it('stores the first candidate’s refusal of a hard rule and ends the run there, as any first candidate does', async () => {
        switchedOn();
        proxy.solveCandidate.mockResolvedValueOnce({ status: 'INFEASIBLE', lessons: [], lunches: null, conflicts: conflictAnalysis });
        await startAndRun(bestEffort());
        expect(run).toMatchObject({ status: 'FAILED', errorCode: CANDIDATES_FIRST_FAILED });
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ solverStatus: 'INFEASIBLE', deviations: Prisma.DbNull });
      });
    });

    describe('a run that is not the mode’s', () => {
      it('sends the engine exactly what it sent, reads no switch, and stores no deviations — null, not an empty list', async () => {
        await startAndRun(dto({ count: 2 }));
        for (const [, options] of proxy.solveCandidate.mock.calls) expect(options).not.toHaveProperty('bestEffort');
        expect(tx.lunchSetting.findUnique).not.toHaveBeenCalled();
        expect(stored.map((row) => row['deviations'])).toEqual([Prisma.DbNull, Prisma.DbNull]);
      });

      it('stores none even if the solution somehow carried a list: the mode was not asked for', async () => {
        proxy.solveCandidate.mockResolvedValue(solved({ deviations: [realised.perDay] }));
        await startAndRun(dto({ count: 2 }));
        expect(stored.map((row) => row['deviations'])).toEqual([Prisma.DbNull, Prisma.DbNull]);
      });
    });

    describe('the task stores what gave way', () => {
      beforeEach(() => switchedOn());

      it('stores the list as the candidate keeps it: a cap with its teacher kept for the server, a part-timer’s days hidden whole', async () => {
        proxy.solveCandidate.mockResolvedValueOnce(solved({ deviations: [realised.perDay, realised.cap, realised.days] }));
        await startAndRun(bestEffort());

        expect(stored[0]!['deviations']).toEqual([
          { category: 'DEVIATION', code: 'DEVIATION_SUBJECT_PER_DAY', params: realised.perDay.params, message: realised.perDay.message, resourceNames: [] },
          { category: 'DEVIATION', code: 'DEVIATION_TEACHER_DAILY_CAP', params: realised.cap.params, message: realised.cap.message, resourceNames: [], subjectIds: [ANNA] },
          { category: 'DEVIATION', code: TEACHER_WORK_DAYS_HIDDEN, params: {}, message: DEVIATION_WORK_DAYS_HIDDEN_MESSAGE, resourceNames: [] },
        ]);
        // Written once with the candidate, in the same create as its timetable.
        expect(stored[0]).toMatchObject({ solverStatus: 'OPTIMAL', variant: 'BEST_EFFORT' });
        // No person's name, no id array, and no figure of a post anywhere in a stored row.
        const text = JSON.stringify(stored[0]);
        expect(text).not.toMatch(/Anna|Svensson|requirementIds|resourceIds|roomIds/);
        expect(text).not.toContain(POST);
      });

      it('stores an empty list when nothing gave way — the mode ran, which null does not say', async () => {
        proxy.solveCandidate.mockResolvedValueOnce(solved({ deviations: [] }));
        await startAndRun(bestEffort());
        expect(stored[0]!['deviations']).toEqual([]);
        expect(stored[0]!['deviations']).not.toBe(Prisma.DbNull);
      });

      it('stores a FEASIBLE timetable’s list as an OPTIMAL one’s', async () => {
        proxy.solveCandidate.mockResolvedValueOnce(solved({ status: 'FEASIBLE', deviations: [realised.perDay] }));
        await startAndRun(bestEffort());
        expect(stored[0]).toMatchObject({ solverStatus: 'FEASIBLE' });
        expect(stored[0]!['deviations']).toHaveLength(1);
      });

      it('stores none for an answer the demand guard rejected: there is no timetable to have deviations in', async () => {
        proxy.solveCandidate.mockResolvedValueOnce(solved({ rejected: true, lessons: [], lunches: null, deviations: [realised.perDay] }));
        await startAndRun(bestEffort());
        expect(stored[0]).toMatchObject({ solverStatus: 'REJECTED', deviations: Prisma.DbNull });
      });

      it('fails the run, and stores nothing, if a timetable of the mode comes without its list — it could not say that nothing gave way', async () => {
        proxy.solveCandidate.mockResolvedValueOnce(solved());
        await startAndRun(bestEffort());
        expect(stored).toEqual([]);
        expect(run).toMatchObject({ status: 'FAILED', errorCode: ENGINE_LACKS_BEST_EFFORT });
      });

      it('fails the run with the proxy’s sentence when the engine is older than the mode', async () => {
        proxy.solveCandidate.mockRejectedValueOnce(new HttpException({ message: 'older', code: ENGINE_LACKS_BEST_EFFORT }, 503));
        await startAndRun(bestEffort());
        expect(run).toMatchObject({ status: 'FAILED', errorCode: ENGINE_LACKS_BEST_EFFORT });
        expect(engineFailureOf(new HttpException({ message: 'older', code: ENGINE_LACKS_BEST_EFFORT }, 503))).toMatchObject({ code: ENGINE_LACKS_BEST_EFFORT });
        // The engine refused the field at once: it is not solving for the run.
        expect(run).not.toHaveProperty('engineBusyUntil', expect.any(Date));
      });
    });

    describe('refresh of a batch of the mode', () => {
      const oldBatch = (variant: string) => ({
        academicYearId: YEAR,
        status: 'SUCCEEDED',
        weights: null,
        candidates: [
          { ordinal: 1, variant, weights: null, seed: null, solverStatus: 'OPTIMAL', lessons: [{ requirementId: 'req-ma', roomId: ROOM, dayOfWeek: 4, startTime: '13:00', endTime: '14:00' }] },
        ],
      });

      it('keeps the mode: the engine is sent it, a draft is not asked for, and the switch is read', async () => {
        switchedOn();
        tx.masterLesson.count.mockResolvedValue(0);
        tx.scheduleCandidateRun.findUnique.mockResolvedValue(oldBatch('BEST_EFFORT'));
        proxy.solveCandidate.mockResolvedValue(solved({ deviations: [realised.perDay] }));

        await startAndRun(dto({ refreshOf: OLD_RUN }));

        expect(tx.lunchSetting.findUnique).toHaveBeenCalled();
        expect(tx.masterLesson.count).not.toHaveBeenCalled();
        const [, options] = proxy.solveCandidate.mock.calls[0]!;
        expect(options).toMatchObject({
          bestEffort: true,
          weights: { disruption: 40 },
          previousLessons: [{ requirementId: 'anon-ma', dayOfWeek: 4, startTime: '13:00:00' }],
        });
        expect(stored.map((row) => [row['ordinal'], row['variant']])).toEqual([[1, 'BEST_EFFORT']]);
        expect(stored[0]!['deviations']).toHaveLength(1);
      });

      it('is refused while the switch is off — whoever began the batch', async () => {
        switchedOn(false);
        tx.scheduleCandidateRun.findUnique.mockResolvedValue(oldBatch('BEST_EFFORT'));
        const error = (await service.start(dto({ refreshOf: OLD_RUN }), user).catch((caught: unknown) => caught)) as HttpException;
        expect(error.getResponse()).toMatchObject({ code: BEST_EFFORT_NOT_ENABLED });
        expect(tx.scheduleCandidateRun.create).not.toHaveBeenCalled();
      });

      it('leaves an ordinary batch ordinary: no mode, no switch read, a draft asked for', async () => {
        tx.scheduleCandidateRun.findUnique.mockResolvedValue(oldBatch('KEEP'));
        await startAndRun(dto({ refreshOf: OLD_RUN }));
        expect(tx.lunchSetting.findUnique).not.toHaveBeenCalled();
        expect(tx.masterLesson.count).toHaveBeenCalled();
        expect(proxy.solveCandidate.mock.calls[0]![1]).not.toHaveProperty('bestEffort');
        expect(stored[0]!['deviations']).toBe(Prisma.DbNull);
      });
    });

    describe('GET candidates: what the page is shown', () => {
      const NOW = new Date('2026-10-17T12:00:00.000Z');
      const runRow = (candidates: unknown[]) =>
        ({
          id: RUN, status: 'SUCCEEDED', requested: 1, progress: 1,
          createdAt: new Date('2026-10-17T11:50:00.000Z'), startedAt: new Date('2026-10-17T11:50:01.000Z'), finishedAt: new Date('2026-10-17T11:53:00.000Z'),
          error: null, errorCode: null, errorParams: null, createdById: user.userId, appliedCandidateId: null, appliedAt: null, refreshOfId: null,
          heartbeatAt: new Date('2026-10-17T11:53:00.000Z'), leaseSeconds: 250, unplaced: null, draftNotes: null, candidates,
        }) as never;
      const candidateRow = (overrides: Record<string, unknown> = {}) => ({
        id: CANDIDATE, ordinal: 1, variant: 'BEST_EFFORT', weights: null, solverStatus: 'OPTIMAL', errorCode: null, errorParams: null,
        metrics: { moved: 1, movedOf: 2, kept: 1, roomChanges: 0, sameAs: null, lessonCount: 2, unplaced: null },
        conflicts: [], notes: [], deviations: storedDeviationsOf([realised.perDay, realised.cap, realised.days]), ...overrides,
      });
      const overviewOf = async (candidates: unknown[]) => {
        tx.scheduleCandidateRun.findFirst.mockResolvedValueOnce(runRow(candidates));
        return (await service.overview(YEAR, user, NOW)).latest!.candidates;
      };

      it('shows the list as sentences with the cap’s teacher NAMED in it — by the name now, never an id — and a part-timer’s days hidden', async () => {
        tx.user.findMany.mockResolvedValue([{ id: ANNA, firstName: 'Anna', lastName: 'Svensson' }]);
        tx.personProtection.findMany.mockResolvedValue([]);

        const [view] = await overviewOf([candidateRow()]);

        expect(view!.deviations).toEqual([
          { category: 'DEVIATION', code: 'DEVIATION_SUBJECT_PER_DAY', params: realised.perDay.params, message: realised.perDay.message, resourceNames: [] },
          {
            category: 'DEVIATION',
            code: 'DEVIATION_TEACHER_DAILY_CAP',
            params: { ...realised.cap.params, rule: 'Anna Svensson' },
            message: `The cap that the working-time rule Anna Svensson sets gave way on Monday.`,
            resourceNames: [],
          },
          { category: 'DEVIATION', code: TEACHER_WORK_DAYS_HIDDEN, params: {}, message: DEVIATION_WORK_DAYS_HIDDEN_MESSAGE, resourceNames: [] },
        ]);
        expect(JSON.stringify(view)).not.toContain(ANNA);
        expect(JSON.stringify(view)).not.toContain(WORK_RULE);
        expect(view!.deviationsDigest).toBe(deviationsDigestOf(CANDIDATE, candidateRow().deviations));
        expect(view!.deviationsDigest).toMatch(/^[0-9a-f]{64}$/);
        // The teacher is read with the others in one read of Users.
        expect(tx.user.findMany).toHaveBeenCalledTimes(1);
        expect(tx.user.findMany).toHaveBeenCalledWith({ where: { id: { in: [ANNA] } }, select: { id: true, firstName: true, lastName: true } });
      });

      it('names nobody who is marked with a protected identity: the sentence keeps the row’s id where the name would be', async () => {
        tx.user.findMany.mockResolvedValue([{ id: ANNA, firstName: 'Anna', lastName: 'Svensson' }]);
        tx.personProtection.findMany.mockResolvedValue([{ userId: ANNA }]);

        const [view] = await overviewOf([candidateRow()]);

        expect(tx.personProtection.findMany).toHaveBeenCalledWith({ where: { userId: { in: [ANNA] } }, select: { userId: true } });
        expect(JSON.stringify(view!.deviations)).not.toMatch(/Anna|Svensson/);
        expect(view!.deviations![1]!.params!['rule']).toBe(WORK_RULE);
      });

      it('reads no mark and no name when no cap gave way', async () => {
        const [view] = await overviewOf([candidateRow({ deviations: storedDeviationsOf([realised.perDay, realised.days]) })]);
        expect(view!.deviations).toHaveLength(2);
        expect(tx.user.findMany).not.toHaveBeenCalled();
        expect(tx.personProtection.findMany).not.toHaveBeenCalled();
      });

      it('shows null for a candidate that is not the mode’s, an empty list for one where nothing gave way, and neither has a digest', async () => {
        const views = await overviewOf([candidateRow({ deviations: null }), candidateRow({ id: 'c2', ordinal: 2, deviations: [] })]);
        expect(views.map((view) => [view.deviations, view.deviationsDigest])).toEqual([[null, null], [[], null]]);
      });

      it('shows none for a candidate that found no timetable, whatever its row holds', async () => {
        const [view] = await overviewOf([candidateRow({ solverStatus: 'INFEASIBLE', metrics: null })]);
        expect(view).toMatchObject({ deviations: null, deviationsDigest: null });
      });

      it('has a digest that no other candidate with the same list shares', async () => {
        const views = await overviewOf([candidateRow(), candidateRow({ id: 'c2', ordinal: 2 })]);
        expect(views[0]!.deviationsDigest).not.toBe(views[1]!.deviationsDigest);
      });
    });

    describe('GET candidates/runs/:runId/check: what the apply dialog shows and the administrator accepts', () => {
      const withDeviations = storedDeviationsOf([realised.perDay, realised.cap]);
      const arrange = (candidates: unknown[]) =>
        tx.scheduleCandidateRun.findUnique.mockResolvedValue({ academicYearId: YEAR, basis: BASIS, basisParts: PARTS, discardedAt: null, candidates });

      it('says the run’s deviations and the digest the apply asks for', async () => {
        arrange([{ id: CANDIDATE, solverStatus: 'OPTIMAL', deviations: withDeviations }]);
        tx.user.findMany.mockResolvedValue([{ id: ANNA, firstName: 'Anna', lastName: 'Svensson' }]);
        tx.personProtection.findMany.mockResolvedValue([]);

        const check = await service.check(RUN, user);

        expect(check.deviationsDigest).toBe(deviationsDigestOf(CANDIDATE, withDeviations));
        expect(check.deviations).toHaveLength(2);
        expect(check.deviations![1]!.params!['rule']).toBe('Anna Svensson');
        expect(JSON.stringify(check)).not.toContain(ANNA);
      });

      it('says the same when the batch is stale or refused — the dialog still has the list to show', async () => {
        arrange([{ id: CANDIDATE, solverStatus: 'OPTIMAL', deviations: withDeviations }]);
        proxy.prepareSchedule.mockResolvedValueOnce({ ready: false, refusalCode: 'BLOCK_PARTLY_LOCKED_SUMMARY' });
        await expect(service.check(RUN, user)).resolves.toMatchObject({
          stale: true,
          deviationsDigest: deviationsDigestOf(CANDIDATE, withDeviations),
        });
      });

      it.each([
        ['a run of ordinary candidates', [{ id: CANDIDATE, solverStatus: 'OPTIMAL', deviations: null }]],
        ['a run of the mode where nothing gave way', [{ id: CANDIDATE, solverStatus: 'OPTIMAL', deviations: [] }]],
        ['a candidate that found no timetable', [{ id: CANDIDATE, solverStatus: 'INFEASIBLE', deviations: withDeviations }]],
        ['a run with no candidates', []],
      ])('says null and null for %s', async (_label, candidates) => {
        arrange(candidates);
        await expect(service.check(RUN, user)).resolves.toMatchObject({ deviations: null, deviationsDigest: null });
        expect(tx.user.findMany).not.toHaveBeenCalled();
      });
    });

    describe('POST candidates/:id/apply: the school accepts what gave way, or nothing is written', () => {
      const deviations = storedDeviationsOf([realised.perDay, realised.cap, realised.days]);
      const digest = deviationsDigestOf(CANDIDATE, deviations)!;
      const created = new Date('2026-10-17T11:50:00.000Z');
      const candidateWith = (overrides: Record<string, unknown> = {}) => ({
        id: CANDIDATE, runId: RUN, ordinal: 1, variant: 'BEST_EFFORT', solverStatus: 'OPTIMAL',
        lessons: [{ requirementId: 'req-ma', roomId: ROOM, dayOfWeek: 1, startTime: '08:00', endTime: '09:00' }],
        lunches: null, metrics: { moved: 0 }, deviations, run: { academicYearId: YEAR }, ...overrides,
      });

      beforeEach(() => {
        run = { status: 'SUCCEEDED', progress: 1, basis: BASIS, basisParts: PARTS };
        tx.scheduleCandidate.findUnique.mockResolvedValue(candidateWith());
        tx.scheduleCandidateRun.findUnique.mockImplementation(async () => ({ id: RUN, status: run.status, basis: BASIS, basisParts: PARTS, createdAt: created }));
        switchedOn();
      });

      const refusal = async (accepted?: string) => {
        const error = (await service.apply(CANDIDATE, 'DRAFT', user, accepted).catch((caught: unknown) => caught)) as HttpException;
        expect(error).toBeInstanceOf(HttpException);
        return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
      };
      /** Nothing of the timetable, the run or the safety version was touched. */
      const nothingWritten = () => {
        expect(proxy.applyCandidateWrite).not.toHaveBeenCalled();
        expect(proxy.prepareSchedule).not.toHaveBeenCalled();
        expect(versions.snapshotInTransaction).not.toHaveBeenCalled();
        expect(tx.scheduleCandidateRun.update).not.toHaveBeenCalled();
        expect(tx.scheduleCandidateRun.updateMany).not.toHaveBeenCalled();
        expect(run.appliedCandidateId).toBeUndefined();
        expect(realtime.notifyMasterTimetableChanged).not.toHaveBeenCalled();
      };

      it('refuses a candidate with deviations 409 SCHEDULE_CANDIDATE_DEVIATIONS_NOT_ACCEPTED, with the count, when nothing is accepted — and writes nothing', async () => {
        await expect(refusal(undefined)).resolves.toEqual({
          status: 409,
          body: expect.objectContaining({ code: SCHEDULE_CANDIDATE_DEVIATIONS_NOT_ACCEPTED, params: { count: 3 } }),
        });
        nothingWritten();
      });

      it.each([
        ['an empty string', ''],
        ['a value that is not a digest', 'yes'],
        ['another candidate’s digest', deviationsDigestOf('77777777-7777-4777-8777-777777777777', deviations)!],
        ['the digest of fewer deviations', deviationsDigestOf(CANDIDATE, deviations.slice(0, 2))!],
        ['the right digest in capitals', deviationsDigestOf(CANDIDATE, deviations)!.toUpperCase()],
        ['the right digest with a space after it', `${deviationsDigestOf(CANDIDATE, deviations)!} `],
      ])('refuses %s, and writes nothing', async (_label, accepted) => {
        await expect(refusal(accepted)).resolves.toMatchObject({
          status: 409,
          body: expect.objectContaining({ code: SCHEDULE_CANDIDATE_DEVIATIONS_NOT_ACCEPTED, params: { count: 3 } }),
        });
        nothingWritten();
      });

      it('refuses a digest read off a row that has since been changed by hand', async () => {
        tx.scheduleCandidate.findUnique.mockResolvedValue(candidateWith({ deviations: deviations.slice(0, 1) }));
        await expect(refusal(digest)).resolves.toMatchObject({ body: expect.objectContaining({ code: SCHEDULE_CANDIDATE_DEVIATIONS_NOT_ACCEPTED, params: { count: 1 } }) });
        nothingWritten();
      });

      it('applies it with the digest, and keeps the acceptance in the REGENERATE entry: the list, its digest and the moment — no teacher id, no name', async () => {
        await expect(service.apply(CANDIDATE, 'DRAFT', user, digest)).resolves.toEqual({ lessonsCreated: 2, versionId: 'version-1' });

        const { after, snapshot } = proxy.applyCandidateWrite.mock.calls[0]![1];
        expect(snapshot.name).toBe('Före schemaförslag 1 – Bästa möjliga');
        expect(after).toMatchObject({ source: 'CANDIDATE', runId: RUN, ordinal: 1, variant: 'BEST_EFFORT', deviationsDigest: digest });
        expect(after.acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(after.deviations).toHaveLength(3);
        expect(after.deviations.map((entry: { code: string }) => entry.code)).toEqual(['DEVIATION_SUBJECT_PER_DAY', 'DEVIATION_TEACHER_DAILY_CAP', TEACHER_WORK_DAYS_HIDDEN]);
        const text = JSON.stringify(after);
        expect(text).not.toContain(ANNA);
        expect(text).not.toContain('subjectIds');
        expect(run.appliedCandidateId).toBe(CANDIDATE);
      });

      it('checks the acceptance after the candidate is known to be applicable and before any lock-taking write of the year', async () => {
        await refusal(undefined);
        // It read the school's switch and nothing past it: no Generera check, no run to stop, no masters locked.
        expect(steps.some((step) => step.includes('FROM "MasterLessons"'))).toBe(false);
        expect(tx.optimizationJob.count).not.toHaveBeenCalled();
      });

      it('refuses 409 BEST_EFFORT_NOT_ENABLED, whatever digest, once the school has turned the mode off — the consent is withdrawn with it', async () => {
        switchedOn(false);
        await expect(refusal(digest)).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: BEST_EFFORT_NOT_ENABLED }) });
        tx.lunchSetting.findUnique.mockResolvedValue(null);
        await expect(refusal(digest)).resolves.toEqual({ status: 409, body: expect.objectContaining({ code: BEST_EFFORT_NOT_ENABLED }) });
        nothingWritten();
      });

      it('takes no digest from a candidate with none — null or an empty list — and is not stopped by one that is sent', async () => {
        for (const clean of [null, []]) {
          proxy.applyCandidateWrite.mockClear();
          tx.scheduleCandidate.findUnique.mockResolvedValue(candidateWith({ deviations: clean, ordinal: 2, variant: 'SPREAD' }));
          await expect(service.apply(CANDIDATE, 'DRAFT', user)).resolves.toMatchObject({ lessonsCreated: 2 });
          await expect(service.apply(CANDIDATE, 'DRAFT', user, 'any digest at all')).resolves.toMatchObject({ lessonsCreated: 2 });
        }
        // A candidate of an ordinary run does not so much as read the school's switch.
        expect(tx.lunchSetting.findUnique).not.toHaveBeenCalled();
      });

      it('writes nothing about deviations into the entry of a candidate that has none, and a bare [] for one where the mode found none', async () => {
        tx.scheduleCandidate.findUnique.mockResolvedValue(candidateWith({ deviations: null, ordinal: 2, variant: 'SPREAD' }));
        await service.apply(CANDIDATE, 'DRAFT', user);
        expect(proxy.applyCandidateWrite.mock.calls[0]![1].after).not.toHaveProperty('deviations');
        expect(proxy.applyCandidateWrite.mock.calls[0]![1].after).not.toHaveProperty('deviationsDigest');

        tx.scheduleCandidate.findUnique.mockResolvedValue(candidateWith({ deviations: [] }));
        await service.apply(CANDIDATE, 'DRAFT', user);
        const after = proxy.applyCandidateWrite.mock.calls[1]![1].after;
        expect(after.deviations).toEqual([]);
        expect(after).not.toHaveProperty('deviationsDigest');
        expect(after).not.toHaveProperty('acceptedAt');
      });

      it('lets the existing refusals go first: a run that is not finished is NOT_APPLICABLE, not a missing acceptance', async () => {
        run = { status: 'RUNNING', progress: 0, basis: BASIS, basisParts: PARTS };
        await expect(refusal(undefined)).resolves.toMatchObject({ body: expect.objectContaining({ code: SCHEDULE_CANDIDATE_NOT_APPLICABLE }) });
      });
    });

    describe('the variant', () => {
      it('is not one of the table’s four, and is still named in the safety version', () => {
        expect(variantsFor(4).map((variant) => variant.code)).not.toContain('BEST_EFFORT');
        expect(variantOf('BEST_EFFORT')).toBe(BEST_EFFORT_VARIANT);
        expect(variantOf('NOT_A_VARIANT')).toBeUndefined();
        expect(snapshotNameOf(1, 'BEST_EFFORT')).toBe('Före schemaförslag 1 – Bästa möjliga');
        expect(BEST_EFFORT_VARIANT).toMatchObject({ ordinal: 1, overrides: {}, seed: null });
      });
    });
  });
});

describe('yearHasActiveCandidateRun', () => {
  it('counts the year\'s active runs inside their lease and their half hour, under the caller\'s RLS', async () => {
    const tx = createTxMock();
    tx.$queryRaw.mockResolvedValueOnce([{ active: 1 }]);
    await expect(yearHasActiveCandidateRun(tx as never, YEAR)).resolves.toBe(true);
    const sql = (tx.$queryRaw.mock.calls[0][0] as { strings: string[] }).strings.join('?');
    expect(sql).toContain(`"status" IN ('PENDING', 'RUNNING', 'CANCELLING')`);
    expect(sql).toContain(`"heartbeatAt" + make_interval(secs => "leaseSeconds") >= now()`);
    expect(sql).toContain(`"createdAt" >= now() - interval '30 minutes'`);
    await expect(yearHasActiveCandidateRun(tx as never, YEAR)).resolves.toBe(false);
  });
});

describe('the pieces', () => {
  it('reads the draft by the regeneration\'s one rule: everything not PRESERVED_FROM_REGENERATION', () => {
    expect(draftMastersWhere(YEAR)).toEqual({
      academicYearId: YEAR,
      NOT: {
        OR: [{ isGenerated: false }, { isLocked: true, fromPlacement: false }, { extraGroups: { some: {} } }, { participants: { some: {} } }],
      },
    });
  });

  it('keeps the five weights as integers 0..1000 and nothing else', () => {
    expect(plainWeights({ spread: 4, disruption: 1001, teacherGap: 2.5, preferredFree: 0, extra: 3 })).toEqual({ spread: 4, preferredFree: 0 });
    expect(plainWeights({})).toBeNull();
    expect(plainWeights([1])).toBeNull();
  });

  it('reads stored lessons and lunches back only in the shape the run wrote', () => {
    const lesson = { requirementId: 'r', roomId: null, dayOfWeek: 1, startTime: '08:00', endTime: '09:00' };
    expect(storedLessonsOf([lesson])).toEqual([lesson]);
    expect(storedLessonsOf([{ ...lesson, dayOfWeek: 8 }])).toBeNull();
    expect(storedLessonsOf([{ ...lesson, startTime: '8:00' }])).toBeNull();
    expect(storedLessonsOf({})).toBeNull();
    // Delade lektioner: a shared post's lesson names its own teacher, or null.
    expect(storedLessonsOf([{ ...lesson, teacherId: 't-bo' }])).toEqual([{ ...lesson, teacherId: 't-bo' }]);
    expect(storedLessonsOf([{ ...lesson, teacherId: null }])).toEqual([{ ...lesson, teacherId: null }]);
    expect(storedLessonsOf([{ ...lesson, teacherId: 7 }])).toBeNull();
    expect(storedLunchesOf(null)).toBeNull();
    expect(storedLunchesOf([{ studentGroupId: 'g', dayOfWeek: 1, startTime: '11:30:00', endTime: '12:00:00' }])).toHaveLength(1);
    expect(storedLunchesOf([{ studentGroupId: 1 }])).toBeNull();
  });

  it('reads a failure that is not an HttpException as its message with no code', () => {
    expect(engineFailureOf(new Error('boom'))).toEqual({ message: 'boom', code: null, params: null });
    expect(engineFailureOf(new HttpException('Bad request', HttpStatus.BAD_REQUEST))).toEqual({ message: 'Bad request', code: null, params: null });
    expect(engineFailureOf(new HttpException({ message: 'x', code: 'not a code' }, 504))).toMatchObject({ code: CANDIDATE_ENGINE_TIMEOUT });
  });

  it('names an engine that broke, and a 3xx that reached the run as one, CANDIDATE_ENGINE_FAILED', () => {
    expect(engineFailureOf(new HttpException('Broke', HttpStatus.BAD_GATEWAY))).toMatchObject({ code: CANDIDATE_ENGINE_FAILED });
    // callAiEngine gives a redirect a 502, so none arrives; one that did is no
    // run without a name.
    expect(engineFailureOf(new HttpException('Moved', HttpStatus.FOUND))).toMatchObject({ code: CANDIDATE_ENGINE_FAILED });
    expect(engineFailureOf(new HttpException('Moved', HttpStatus.PERMANENT_REDIRECT))).toMatchObject({ code: CANDIDATE_ENGINE_FAILED });
    // The engine's own refusal keeps no name of ours.
    expect(engineFailureOf(new HttpException('Bad request', HttpStatus.UNPROCESSABLE_ENTITY))).toMatchObject({ code: null });
  });

  /*
   * Lärarens dag (work-days.ts): a post's days are HR data. A candidate's page
   * has no HR-läs path, so a sentence about them is kept as the one a reader
   * without HR-läs is shown — for every reader, rektor too — and never with
   * the post or the teacher it is about.
   */
  it('keeps a sentence about a post’s days as the hidden one, once, with no post and no teacher', () => {
    const days = (category: string) => ({
      category,
      code: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
      params: { limit: 'post-1', weekMinutes: 1500 },
      message: WORK_DAYS_HIDDEN_MESSAGE,
      resourceIds: ['teacher-1'],
      resourceNames: [],
      subjectIds: ['teacher-1'],
    });
    const stored = storedConflictsOf({
      summary: 's',
      conflicts: [
        days('AVAILABILITY'),
        { category: 'INSUFFICIENT_RESOURCES', code: 'X', params: { n: 1 }, message: 'm', resourceIds: ['r'], resourceNames: ['Sal 1'] },
        days('AVAILABILITY'),
      ],
    } as unknown as AiEngineConflictAnalysis);
    expect(stored).toEqual([
      { category: 'AVAILABILITY', code: TEACHER_WORK_DAYS_HIDDEN, params: {}, message: WORK_DAYS_HIDDEN_MESSAGE, resourceNames: [] },
      { category: 'INSUFFICIENT_RESOURCES', code: 'X', params: { n: 1 }, message: 'm', resourceNames: ['Sal 1'] },
    ]);
    expect(JSON.stringify(stored)).not.toMatch(/post-1|teacher-1|subjectIds/);
  });

  it('keeps a travel sentence’s teachers server-side, and no other sentence’s', () => {
    const stored = storedConflictsOf({
      summary: 's',
      conflicts: [
        {
          category: 'TEACHER_OVERLAP',
          code: 'TEACHER_TRAVEL_CANNOT_BE_KEPT',
          params: { stepMinutes: 30, measured: 1 },
          message: 'm',
          resourceIds: ['teacher-1'],
          resourceNames: [],
          subjectIds: ['teacher-1'],
        },
        { category: 'INSUFFICIENT_RESOURCES', code: 'X', params: {}, message: 'm', resourceIds: ['r'], resourceNames: [], subjectIds: ['teacher-2'] },
      ],
    } as unknown as AiEngineConflictAnalysis);
    expect(stored).toEqual([
      { category: 'TEACHER_OVERLAP', code: 'TEACHER_TRAVEL_CANNOT_BE_KEPT', params: { stepMinutes: 30, measured: 1 }, message: 'm', resourceNames: [], subjectIds: ['teacher-1'] },
      { category: 'INSUFFICIENT_RESOURCES', code: 'X', params: {}, message: 'm', resourceNames: [] },
    ]);
  });

  it('fails a run the engine refused over a post’s days with the hidden sentence, and keeps no post', () => {
    const refusal = new WorkDaysRefusal(
      { message: WORK_DAYS_HIDDEN_MESSAGE, code: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK', params: { limit: 'post-1', weekMinutes: 1500 } },
      400,
      ['teacher-1'],
    );
    expect(engineFailureOf(refusal)).toEqual({ message: WORK_DAYS_HIDDEN_MESSAGE, code: TEACHER_WORK_DAYS_HIDDEN, params: null });
  });
});
