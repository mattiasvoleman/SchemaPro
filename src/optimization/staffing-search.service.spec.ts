// FIRST, as the built application reads it (see optimization-module.di.spec.ts): the proxy's constructor must see the
// clash rule's file before the proxy's own is read. Kept first on purpose; do not let an import sorter move it.
import { MasterLessonsService } from '../calendar/master-lessons.service';
import { ConflictException, HttpException, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { BASIS_PARTS, type BasisParts } from './candidate-basis';
import type { AiEngineScheduleRequest, AnonymousRequirement } from './interfaces/ai-engine-payload.interface';
import type { AiEngineWeekBoundsResponse } from './interfaces/staffing-search.interface';
import type { OptimizationProxyService } from './optimization-proxy.service';
import * as proposals from './staffing-proposal.service';
import type { Plan, RowPlan, StaffingProposalService, TeacherPlan } from './staffing-proposal.service';
import {
  BOUNDS_SECONDS,
  SEARCH_ABANDONED,
  SEARCH_ENGINE_OLDER,
  SEARCH_INTERRUPTED,
  SEARCH_LEASE_SECONDS,
  SEARCH_START_NOT_EXACT,
  SEARCH_START_REFUSED,
  STAFFING_SEARCH_ALREADY_RUNNING,
  STAFFING_SEARCH_NOT_READY,
  STAFFING_SEARCH_NO_POSTS,
  STAFFING_SEARCH_NO_QUALIFICATIONS,
  STAFFING_SEARCH_SWEEP_JOB,
  StaffingSearchService,
  WEEK_BOUNDS_PATH,
  figuresDocOf,
} from './staffing-search.service';
import { weekBasisOf, withWeekBasis } from './staffing-week';

void MasterLessonsService;

const YEAR = '44444444-4444-4444-8444-444444444444';
const RUN = '55555555-5555-4555-8555-555555555555';
const STAFFING_BASIS = 'a'.repeat(64);
const user = testUser();

const real = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const anon = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Teachers: the real id a plan speaks in and the id the payload names them by. */
const T = {
  a: { real: 'a1a1a1a1-0000-4000-8000-0000000000a1', engine: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  b: { real: 'b2b2b2b2-0000-4000-8000-0000000000b2', engine: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  c: { real: 'c3c3c3c3-0000-4000-8000-0000000000c3', engine: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
};

const CAPACITY = 1000;
const BASE = 700;
const POST_MINUTES = 200;

const post = (n: number, teacher = T.a.engine, patch: Partial<AnonymousRequirement> = {}): AnonymousRequirement => ({
  id: anon(n),
  subjectId: 'engine-subject',
  studentGroupId: 'engine-group',
  teacherId: teacher,
  lessonsPerWeek: 1,
  minutesPerLesson: POST_MINUTES,
  minutesBefore: 0,
  minutesAfter: 0,
  studentGroupSize: 20,
  requiredRoomType: null,
  coTeacherId: null,
  minGradeLevel: 9,
  maxGradeLevel: 9,
  ...patch,
});

const planned = (n: number, patch: Partial<RowPlan> = {}): RowPlan =>
  ({
    row: { id: real(n) },
    kind: 'KEPT',
    inconsistent: false,
    vacated: false,
    current: T.a.real,
    co: null,
    chargeExact: 10,
    chargeTenths: 100,
    lessonMinutes: POST_MINUTES,
    eligible: [T.a.real, T.b.real, T.c.real],
    lastYear: [],
    excluded: [],
    ...patch,
  }) as RowPlan;

const teacher = (userId: string, patch: Partial<TeacherPlan> = {}): TeacherPlan =>
  ({ userId, target: 1000, targetTenths: 10000, limitTenths: 100000, floorTenths: 0, fixedTenths: 0, currentTenths: 400, keepOrShed: false, ...patch }) as TeacherPlan;

const planOf = (rows: RowPlan[], teachers: TeacherPlan[], patch: Partial<Plan> = {}): Plan =>
  ({
    recorded: true,
    respect: true,
    respectForcedByPolicy: false,
    tolerance: 10,
    staff: new Set(teachers.map((t) => t.userId)),
    candidates: new Set(teachers.map((t) => t.userId)),
    teachers,
    teacherById: new Map(teachers.map((t) => [t.userId, t])),
    rows,
    rowById: new Map(rows.map((r) => [r.row.id, r])),
    pinned: [],
    ...patch,
  }) as Plan;

const parts = (overrides: Partial<BasisParts> = {}): BasisParts =>
  ({ ...Object.fromEntries(BASIS_PARTS.map((part) => [part, `${part}-digest`])), ...overrides }) as BasisParts;

/**
 * The engine, made up: a week's demand is a base and the most one teacher's posts of the week add up to, as the real count queues
 * teachers who share groups. A row of year 9, in one week, converged and exact, unless the request's cutoff says the figure is above
 * the share the year's tightest week had at the start.
 */
function fakeBounds(payload: AiEngineScheduleRequest & { years?: number[]; cutoffs?: { year: number; demandMinutes: number; capacityMinutes: number }[] }): AiEngineWeekBoundsResponse {
  const perTeacher = new Map<string, number>();
  for (const entry of payload.requirements) {
    const minutes = entry.lessonsPerWeek * entry.minutesPerLesson;
    perTeacher.set(entry.teacherId!, (perTeacher.get(entry.teacherId!) ?? 0) + minutes);
  }
  const demand = BASE + Math.max(0, ...perTeacher.values());
  const cut = payload.cutoffs?.find((c) => c.year === 9);
  const cutOff = cut !== undefined && demand * cut.capacityMinutes > cut.demandMinutes * CAPACITY;
  return {
    requestId: payload.requestId,
    weeksTotal: 1,
    weeksCounted: 1,
    rows: (payload.years ?? [9]).map((year) => ({
      year,
      period: null,
      parity: null,
      demandMinutes: demand,
      capacityMinutes: CAPACITY,
      over: demand > CAPACITY,
      converged: !cutOff,
      cutoff: cutOff,
    })),
    refusal: null,
    deadlineHit: false,
    elapsedMs: 1,
  };
}

interface Harness {
  service: StaffingSearchService;
  tx: TxMock;
  prisma: PrismaMock;
  proxy: { prepareSchedule: jest.Mock; callAiEngine: jest.Mock };
  staffing: { readPlan: jest.Mock; proposalFromLeads: jest.Mock };
  jobs: { register: jest.Mock; unregister: jest.Mock; settled: jest.Mock; isScheduled: jest.Mock };
  state: { active: number; recorded: boolean; ready: boolean; posts: AnonymousRequirement[]; weekParts: BasisParts; plan: Plan; heartbeat: 'RUNNING' | 'CANCELLING' | null; row: Record<string, unknown> | null };
}

function harness(overrides: { posts?: AnonymousRequirement[]; plan?: Plan } = {}): Harness {
  const tx = createTxMock();
  const prisma = createPrismaMock(tx);
  const posts = overrides.posts ?? [post(1), post(2), post(3), post(4)];
  const state: Harness['state'] = {
    active: 0,
    recorded: true,
    ready: true,
    posts,
    weekParts: parts(),
    plan:
      overrides.plan ??
      planOf(
        posts.map((_, i) => planned(i + 1)),
        [teacher(T.a.real), teacher(T.b.real), teacher(T.c.real)],
      ),
    heartbeat: 'RUNNING',
    row: null,
  };
  tx.staffingSearchRun!.count!.mockImplementation(async () => state.active);
  tx.staffingSearchRun!.deleteMany!.mockResolvedValue({ count: 0 });
  tx.staffingSearchRun!.create!.mockImplementation(async () => ({ id: RUN }));
  tx.staffingSearchRun!.findUnique!.mockImplementation(async () => state.row);
  tx.staffingSearchRun!.findFirst!.mockImplementation(async () => state.row);
  tx.staffingSearchRun!.updateMany!.mockResolvedValue({ count: 1 });
  tx.academicYear!.findUnique!.mockResolvedValue({ gradeNumbering: 'NIOARIG' });
  tx.optimizationJob!.count!.mockResolvedValue(0);
  tx.$queryRaw!.mockImplementation(async (query: Prisma.Sql) => {
    const text = String(query.sql ?? '');
    if (text.includes('app.staffing_search_sweep')) return [{ changed: 0 }];
    return state.heartbeat === null ? [] : [{ status: state.heartbeat }];
  });
  tx.$executeRaw!.mockResolvedValue(1);

  const proxy = { prepareSchedule: jest.fn(), callAiEngine: jest.fn() };
  proxy.prepareSchedule.mockImplementation(async () =>
    state.ready
      ? {
          ready: true,
          payload: { requestId: 'q', academicYearId: YEAR, requirements: state.posts, rooms: [], constraints: [], teacherWorkRules: [], groupConflicts: [] },
          storedRules: null,
          anonMaps: { requirementAnonMap: new Map(state.posts.map((r, i) => [real(i + 1), r.id])) },
          teacherAnonMap: new Map([
            [T.a.real, T.a.engine],
            [T.b.real, T.b.engine],
            [T.c.real, T.c.engine],
          ]),
          basisParts: state.weekParts,
          periodStretches: null,
        }
      : { ready: false, refusalCode: 'BLOCK_PARTLY_LOCKED_SUMMARY' },
  );
  proxy.callAiEngine.mockImplementation(async (_path: string, payload: AiEngineScheduleRequest) => fakeBounds(payload as never));

  const staffing = {
    readPlan: jest.fn(async () => ({ state: { read: { input: { requirements: [] } } }, plan: state.plan, basisSha256: STAFFING_BASIS })),
    proposalFromLeads: jest.fn((_state: unknown, _plan: unknown, leads: Map<string, string>, basis: string) => ({ basisSha256: basis, leads: [...leads] })),
  };
  const jobs = { register: jest.fn(), unregister: jest.fn(), settled: jest.fn(), isScheduled: jest.fn(() => true) };
  const service = new StaffingSearchService(
    prisma as unknown as PrismaService,
    proxy as unknown as OptimizationProxyService,
    staffing as unknown as StaffingProposalService,
    undefined,
    jobs as never,
  );
  (service as unknown as { delay: () => Promise<void> }).delay = async () => undefined;
  return { service, tx, prisma, proxy, staffing, jobs, state };
}

const settled = async (service: StaffingSearchService): Promise<void> => {
  for (let i = 0; i < 2000 && service.running.length > 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
  expect(service.running).toEqual([]);
};

const sqlOf = (call: unknown[]): { sql: string; values: unknown[] } => {
  const query = call[0] as Prisma.Sql;
  return { sql: query.sql.replace(/\s+/g, ' '), values: query.values };
};
const raws = (h: Harness, needle: string): { sql: string; values: unknown[] }[] =>
  [...h.tx.$executeRaw!.mock.calls, ...h.tx.$queryRaw!.mock.calls].map(sqlOf).filter((q) => q.sql.includes(needle));
const finishing = (h: Harness) => raws(h, '"finishedAt" = now()').filter((q) => q.sql.includes('"stopReason"') || q.sql.includes("'FAILED'"));

describe('StaffingSearchService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  describe('a start', () => {
    it('sweeps first, keeps one finished run per year, and inserts the run with the bases it read and this process as claimant', async () => {
      const h = harness();

      const result = await h.service.start({ academicYearId: YEAR }, user);

      expect(result).toEqual({ runId: RUN });
      expect(h.prisma.withDeliveryService).toHaveBeenCalled();
      expect(h.tx.staffingSearchRun!.deleteMany).toHaveBeenCalledWith({ where: { academicYearId: YEAR, status: { notIn: ['PENDING', 'RUNNING', 'CANCELLING'] } } });
      const created = h.tx.staffingSearchRun!.create!.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(created.data).toMatchObject({
        academicYearId: YEAR,
        staffingBasis: STAFFING_BASIS,
        weekBasis: weekBasisOf(h.state.weekParts),
        createdById: user.userId,
      });
      expect(String(created.data.claimedBy)).toMatch(/:/);
      await settled(h.service);
    });

    it('is refused beside an active search of the year, and when two starts pass the check at once (the partial unique index)', async () => {
      const h = harness();
      h.state.active = 1;
      await expect(h.service.start({ academicYearId: YEAR }, user)).rejects.toMatchObject({ response: { code: STAFFING_SEARCH_ALREADY_RUNNING } });
      expect(h.tx.staffingSearchRun!.create).not.toHaveBeenCalled();

      h.state.active = 0;
      h.tx.staffingSearchRun!.create!.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' }));
      await expect(h.service.start({ academicYearId: YEAR }, user)).rejects.toBeInstanceOf(ConflictException);
      await expect(h.service.start({ academicYearId: YEAR }, user)).rejects.toMatchObject({ response: { code: STAFFING_SEARCH_ALREADY_RUNNING } });
    });

    it.each([
      ['no behörigheter are recorded', (h: Harness) => (h.state.plan = planOf(h.state.plan.rows, h.state.plan.teachers, { recorded: false })), STAFFING_SEARCH_NO_QUALIFICATIONS],
      ['Generera refuses the week as it stands', (h: Harness) => (h.state.ready = false), STAFFING_SEARCH_NOT_READY],
      ['every post is hand-placed', (h: Harness) => (h.state.posts = []), STAFFING_SEARCH_NO_POSTS],
    ])('is refused 409, and writes nothing, when %s', async (_name, arrange, code) => {
      const h = harness();
      arrange(h);

      await expect(h.service.start({ academicYearId: YEAR }, user)).rejects.toMatchObject({ response: { code } });

      expect(h.tx.staffingSearchRun!.create).not.toHaveBeenCalled();
      expect(h.proxy.callAiEngine).not.toHaveBeenCalled();
    });

    it('reads the plan of the posts the school released, with the posts the admin pinned', async () => {
      const h = harness();

      await h.service.start({ academicYearId: YEAR, pinnedRequirementIds: [real(1)] }, user);
      await settled(h.service);

      expect(h.staffing.readPlan).toHaveBeenCalledWith(h.tx, user, { academicYearId: YEAR, pinnedRequirementIds: [real(1)] });
      expect(h.proxy.prepareSchedule).toHaveBeenCalledWith(h.tx, YEAR, user, expect.objectContaining({ skipUnstaffedRefusal: true }));
    });
  });

  // -------------------------------------------------------------------------
  describe('a whole search', () => {
    it('counts each year on its own first, then candidates the leads they move, and keeps the best state as a checkpoint', async () => {
      const h = harness();

      await h.service.start({ academicYearId: YEAR }, user);
      await settled(h.service);

      // Every call is the exact count of the engine's own route, with the years it is asked for, the guard as cutoffs and its own seconds.
      const calls = h.proxy.callAiEngine.mock.calls as [string, Record<string, unknown>, unknown, { timeoutMs: number }][];
      expect(calls.length).toBeGreaterThan(1);
      for (const [path, body, , options] of calls) {
        expect(path).toBe(WEEK_BOUNDS_PATH);
        expect(body).toMatchObject({ years: [9], seconds: BOUNDS_SECONDS });
        expect(options.timeoutMs).toBeGreaterThan(BOUNDS_SECONDS * 1000);
      }
      // The baseline asks no cutoff (nothing to guard yet); every candidate carries the year's tightest week as it began.
      expect(calls[0]![1].cutoffs).toBeUndefined();
      expect(calls[1]![1].cutoffs).toEqual([{ year: 9, demandMinutes: 1500, capacityMinutes: CAPACITY }]);
      expect(new Set(calls.map(([, body]) => body.requestId)).size).toBe(calls.length);

      const done = finishing(h).at(-1)!;
      expect(done.sql).toContain('"stopReason"');
      expect(done.values).toContain('SUCCEEDED');
      // Four posts of 200 on one teacher (1,500) spread over three: no teacher carries more than two (1,100, one of them).
      const checkpoint = JSON.parse(done.values.find((v) => typeof v === 'string' && v.includes('"changes"')) as string) as { changes: { requirementId: string; fromTeacherId: string; toTeacherId: string }[] };
      expect(checkpoint.changes.length).toBeGreaterThan(0);
      for (const move of checkpoint.changes) {
        expect(move.fromTeacherId).toBe(T.a.real);
        expect([T.b.real, T.c.real]).toContain(move.toTeacherId);
      }
      const figures = JSON.parse(done.values.find((v) => typeof v === 'string' && v.includes('"skippedPosts"')) as string) as ReturnType<typeof figuresDocOf>;
      expect(figures.years[0]!.weeks[0]!.before).toEqual({ demandMinutes: 1500, capacityMinutes: CAPACITY });
      expect(figures.years[0]!.weeks[0]!.after.demandMinutes).toBeLessThan(1500);
      expect(h.tx.staffingSearchRun!.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ teacherId: expect.anything() }) }));
    });

    it('writes the checkpoint after every accepted move, so that a run that is lost has its best so far', async () => {
      const h = harness();

      await h.service.start({ academicYearId: YEAR }, user);
      await settled(h.service);

      const stored = raws(h, '"checkpoint" = ');
      // One write per accepted move (progress), and the finishing one.
      expect(stored.length).toBeGreaterThan(1);
      const moves = stored.map((q) => (JSON.parse(q.values.find((v) => typeof v === 'string' && v.includes('"changes"')) as string) as { changes: unknown[] }).changes.length);
      expect(moves).toEqual([...moves].sort((x, y) => x - y));
    });

    it('stops at once, and asks the engine nothing, when the week is not tight', async () => {
      const h = harness();
      h.proxy.callAiEngine.mockImplementation(async (_p: string, payload: AiEngineScheduleRequest) => {
        const answer = fakeBounds(payload as never);
        return { ...answer, rows: answer.rows.map((r) => ({ ...r, demandMinutes: 600 })) };
      });

      await h.service.start({ academicYearId: YEAR }, user);
      await settled(h.service);

      // The baseline is asked (one count), and no candidate is.
      expect(h.proxy.callAiEngine).toHaveBeenCalledTimes(1);
      expect(finishing(h).at(-1)!.values).toEqual(expect.arrayContaining(['SUCCEEDED', 'NOT_TIGHT']));
    });

    it('fails the run, with the quick count named, when the week as it stands is refused by one', async () => {
      const h = harness();
      h.proxy.callAiEngine.mockResolvedValue({ requestId: 'x', weeksTotal: 1, weeksCounted: 0, rows: [], refusal: { code: 'TEACHER_HOURS_SHORT', params: {} }, deadlineHit: false, elapsedMs: 1 });

      await h.service.start({ academicYearId: YEAR }, user);
      await settled(h.service);

      const failed = finishing(h).at(-1)!;
      expect(failed.sql).toContain("'FAILED'");
      expect(failed.values).toEqual(expect.arrayContaining([SEARCH_START_REFUSED, JSON.stringify({ code: 'TEACHER_HOURS_SHORT' })]));
    });

    it('fails the run when no year could be counted to the end in the engine\'s seconds', async () => {
      const h = harness();
      h.proxy.callAiEngine.mockImplementation(async (_p: string, payload: AiEngineScheduleRequest) => ({
        ...fakeBounds(payload as never),
        deadlineHit: true,
      }));

      await h.service.start({ academicYearId: YEAR }, user);
      await settled(h.service);

      expect(finishing(h).at(-1)!.values).toContain(SEARCH_START_NOT_EXACT);
    });

    it('fails the run, and asks no more, when the engine does not have the route yet', async () => {
      const h = harness();
      h.proxy.callAiEngine.mockRejectedValue(new HttpException('Not Found', HttpStatus.NOT_FOUND));

      await h.service.start({ academicYearId: YEAR }, user);
      await settled(h.service);

      expect(finishing(h).at(-1)!.values).toContain(SEARCH_ENGINE_OLDER);
      expect(h.proxy.callAiEngine.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it('waits and asks again when the engine says it is busy (429), and counts nothing it did not answer', async () => {
      const h = harness();
      let busy = 2;
      h.proxy.callAiEngine.mockImplementation(async (_p: string, payload: AiEngineScheduleRequest) => {
        if (busy-- > 0) throw new HttpException('busy', HttpStatus.TOO_MANY_REQUESTS);
        return fakeBounds(payload as never);
      });

      await h.service.start({ academicYearId: YEAR }, user);
      await settled(h.service);

      expect(finishing(h).at(-1)!.values).toContain('SUCCEEDED');
      expect(h.proxy.callAiEngine.mock.calls.length).toBeGreaterThan(3);
    });

    it('gives way to a Generera run of the year: it asks the engine nothing while one is going', async () => {
      const h = harness();
      let generating = 2;
      h.tx.optimizationJob!.count!.mockImplementation(async () => (generating-- > 0 ? 1 : 0));
      const waits: number[] = [];
      (h.service as unknown as { delay: (ms: number) => Promise<void> }).delay = async (ms) => {
        waits.push(ms);
        // Nothing was asked of the engine while the run was going.
        expect(h.proxy.callAiEngine).not.toHaveBeenCalled();
      };

      await h.service.start({ academicYearId: YEAR }, user);
      await settled(h.service);

      expect(waits.length).toBeGreaterThanOrEqual(2);
      expect(h.proxy.callAiEngine).toHaveBeenCalled();
    });

    it('leaves no post out that has somewhere to go: a school with nothing released has nothing to search and says so', async () => {
      const h = harness({ plan: planOf([planned(1, { kind: 'FIXED' })], [teacher(T.a.real), teacher(T.b.real)]) });

      await h.service.start({ academicYearId: YEAR }, user);
      await settled(h.service);

      expect(h.proxy.callAiEngine).not.toHaveBeenCalled();
      expect(finishing(h).at(-1)!.values).toEqual(expect.arrayContaining(['SUCCEEDED', 'NO_MOVES']));
    });
  });

  // -------------------------------------------------------------------------
  describe('the lease', () => {
    it('is taken in the first heartbeat, before the engine is asked: RUNNING, the lease from the database\'s clock, in one compare-and-set', async () => {
      const h = harness();
      const order: string[] = [];
      h.tx.$queryRaw!.mockImplementation(async (query: Prisma.Sql) => {
        if (String(query.sql).includes('"heartbeatAt"')) order.push('heartbeat');
        return [{ status: 'RUNNING' }];
      });
      h.proxy.callAiEngine.mockImplementation(async (_p: string, payload: AiEngineScheduleRequest) => {
        order.push('engine');
        return fakeBounds(payload as never);
      });

      await h.service.start({ academicYearId: YEAR }, user);
      await settled(h.service);

      expect(order[0]).toBe('heartbeat');
      expect(order[1]).toBe('engine');
      const beat = h.tx.$queryRaw!.mock.calls.map(sqlOf).find((q) => q.sql.includes('"heartbeatAt" = now()'))!;
      expect(beat.sql).toContain("'PENDING', 'RUNNING', 'CANCELLING'");
      expect(beat.sql).toContain('make_interval(secs =>');
      expect(beat.values).toContain(SEARCH_LEASE_SECONDS);
    });

    it('runs nothing when the first heartbeat finds the run no longer active (the sweep took it, or a restart failed it)', async () => {
      const h = harness();
      h.state.heartbeat = null;

      await h.service.start({ academicYearId: YEAR }, user);
      await settled(h.service);

      expect(h.proxy.callAiEngine).not.toHaveBeenCalled();
      expect(finishing(h)).toEqual([]);
    });

    it('renews on a timer while it works, and learns of a cancellation from the renewal', async () => {
      jest.useFakeTimers();
      const h = harness();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let beats = 0;
      h.tx.$queryRaw!.mockImplementation(async (query: Prisma.Sql) => {
        if (!String(query.sql).includes('"heartbeatAt"')) return [{ changed: 0 }];
        beats += 1;
        // The second renewal finds that another instance's cancel has set CANCELLING.
        return [{ status: beats >= 2 ? 'CANCELLING' : 'RUNNING' }];
      });
      h.proxy.callAiEngine.mockImplementation(async (_p: string, payload: AiEngineScheduleRequest) => {
        await gate;
        return fakeBounds(payload as never);
      });

      await h.service.start({ academicYearId: YEAR }, user);
      await jest.advanceTimersByTimeAsync(6_000);
      expect(beats).toBeGreaterThanOrEqual(2);
      release();
      await jest.advanceTimersByTimeAsync(10);
      for (let i = 0; i < 50 && h.service.running.length > 0; i += 1) await jest.advanceTimersByTimeAsync(10);

      expect(h.service.running).toEqual([]);
      // The search ended, because it was cancelled, with the status the cancellation asked for.
      expect(finishing(h).at(-1)!.values).toContain('CANCELLED');
    });
  });

  describe('a run that stops being the task\'s while it works', () => {
    it('stops asking the engine for it, and finishes nothing over what took it (the sweep, a restart on another instance)', async () => {
      jest.useFakeTimers();
      const h = harness();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let beats = 0;
      h.tx.$queryRaw!.mockImplementation(async (query: Prisma.Sql) => {
        if (!String(query.sql).includes('"heartbeatAt"')) return [{ changed: 0 }];
        beats += 1;
        // The first renewal holds the run, the second finds it taken: no row is still active.
        return beats === 1 ? [{ status: 'RUNNING' }] : [];
      });
      let calls = 0;
      h.proxy.callAiEngine.mockImplementation(async (_p: string, payload: AiEngineScheduleRequest) => {
        calls += 1;
        if (calls > 1) await gate;
        return fakeBounds(payload as never);
      });

      await h.service.start({ academicYearId: YEAR }, user);
      await jest.advanceTimersByTimeAsync(6_000);
      expect(beats).toBeGreaterThanOrEqual(2);
      const asked = h.proxy.callAiEngine.mock.calls.length;
      release();
      for (let i = 0; i < 100 && h.service.running.length > 0; i += 1) await jest.advanceTimersByTimeAsync(10);

      expect(h.service.running).toEqual([]);
      // The candidates in flight were answered, and nothing more was asked once the run was seen to be gone.
      expect(h.proxy.callAiEngine.mock.calls.length).toBeLessThanOrEqual(asked + 3);
      // Nothing was written to a run that is no longer the task's but its checkpoint writes, which a status guard turns away.
      expect(finishing(h).every((q) => q.sql.includes("\"status\" IN ('PENDING', 'RUNNING', 'CANCELLING')"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('a cancel', () => {
    it('is told to a task on this instance at once, which then ends CANCELLED with what it has', async () => {
      const h = harness();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      h.proxy.callAiEngine.mockImplementation(async (_p: string, payload: AiEngineScheduleRequest) => {
        calls += 1;
        // The baseline answers; the first candidate waits, and the school cancels meanwhile.
        if (calls > 1) await gate;
        return fakeBounds(payload as never);
      });
      h.state.row = { id: RUN, status: 'CANCELLING', academicYearId: YEAR, round: 0, evaluations: 0, acceptedMoves: 0, leaseUntil: new Date(Date.now() + 60_000), createdAt: new Date(), startedAt: new Date(), finishedAt: null, errorParams: null, figures: null, checkpoint: null, stopReason: null, error: null, errorCode: null };

      await h.service.start({ academicYearId: YEAR }, user);
      for (let i = 0; i < 200 && calls < 2; i += 1) await new Promise((resolve) => setImmediate(resolve));
      const view = await h.service.cancel(RUN, user);
      release();
      await settled(h.service);

      expect(h.tx.staffingSearchRun!.updateMany).toHaveBeenCalledWith({ where: { id: RUN, status: { in: ['PENDING', 'RUNNING'] } }, data: { status: 'CANCELLING' } });
      expect(view.id).toBe(RUN);
      expect(finishing(h).at(-1)!.values).toEqual(expect.arrayContaining(['CANCELLED', 'CANCELLED']));
    });

    it('is a 404 for a run that is not there, and changes nothing', async () => {
      const h = harness();
      h.state.row = null;

      await expect(h.service.cancel(RUN, user)).rejects.toBeInstanceOf(NotFoundException);
      expect(h.tx.staffingSearchRun!.updateMany).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('a restart that can say so', () => {
    it('fails the runs in flight at once with SEARCH_INTERRUPTED, under the administrator who started each, and leaves the runner', async () => {
      const h = harness();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.proxy.callAiEngine.mockImplementation(async (_p: string, payload: AiEngineScheduleRequest) => {
        await gate;
        return fakeBounds(payload as never);
      });

      await h.service.start({ academicYearId: YEAR }, user);
      for (let i = 0; i < 100 && h.proxy.callAiEngine.mock.calls.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
      expect(h.service.running).toEqual([RUN]);
      await h.service.onModuleDestroy();

      expect(h.jobs.unregister).toHaveBeenCalledWith(STAFFING_SEARCH_SWEEP_JOB);
      expect(h.prisma.withRls).toHaveBeenLastCalledWith(user, expect.any(Function));
      const update = h.tx.staffingSearchRun!.updateMany!.mock.calls.at(-1)![0] as { where: { id: string; status: { in: string[] } }; data: Record<string, unknown> };
      expect(update.where).toEqual({ id: RUN, status: { in: ['PENDING', 'RUNNING', 'CANCELLING'] } });
      expect(update.data).toMatchObject({ status: 'FAILED', errorCode: SEARCH_INTERRUPTED });
      expect(h.service.running).toEqual([]);

      // The task that outlives the restart asks the engine nothing more and finishes nothing over the failed row.
      const before = h.proxy.callAiEngine.mock.calls.length;
      release();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.proxy.callAiEngine.mock.calls.length).toBeLessThanOrEqual(before + 1);
    });

    it('stops renewing the lease of a run it has just failed: a timer must not outlive the restart', async () => {
      jest.useFakeTimers();
      const h = harness();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let beats = 0;
      h.tx.$queryRaw!.mockImplementation(async (query: Prisma.Sql) => {
        if (String(query.sql).includes('"heartbeatAt"')) beats += 1;
        return [{ status: 'RUNNING' }];
      });
      h.proxy.callAiEngine.mockImplementation(async (_p: string, payload: AiEngineScheduleRequest) => {
        await gate;
        return fakeBounds(payload as never);
      });

      await h.service.start({ academicYearId: YEAR }, user);
      await jest.advanceTimersByTimeAsync(6_000);
      const before = beats;
      expect(before).toBeGreaterThanOrEqual(2);
      await h.service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(30_000);

      expect(beats).toBe(before);
      release();
      await jest.advanceTimersByTimeAsync(10);
    });

    it('survives a write that fails: a restart must not hang on it', async () => {
      const h = harness();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.proxy.callAiEngine.mockImplementation(async (_p: string, payload: AiEngineScheduleRequest) => {
        await gate;
        return fakeBounds(payload as never);
      });
      await h.service.start({ academicYearId: YEAR }, user);
      for (let i = 0; i < 100 && h.proxy.callAiEngine.mock.calls.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
      h.tx.staffingSearchRun!.updateMany!.mockRejectedValue(new Error('connection lost'));

      await expect(h.service.onModuleDestroy()).resolves.toBeUndefined();
      release();
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  // -------------------------------------------------------------------------
  describe('the sweep', () => {
    it('asks the database\'s door, with no principal, and settles the job; a failing pass never throws', async () => {
      const h = harness();
      h.tx.$queryRaw!.mockResolvedValue([{ changed: 2 }]);

      await h.service.tick();
      expect(h.jobs.settled).toHaveBeenCalledWith(STAFFING_SEARCH_SWEEP_JOB, expect.any(Date), { ok: true, counts: { changed: 2 } });

      h.tx.$queryRaw!.mockRejectedValue(new Error('down'));
      await expect(h.service.tick()).resolves.toBeUndefined();
      expect(h.jobs.settled).toHaveBeenLastCalledWith(STAFFING_SEARCH_SWEEP_JOB, expect.any(Date), { ok: false, error: 'Error' });
      expect(h.prisma.withDeliveryService).toHaveBeenCalledTimes(2);
    });

    it('registers only when the runner is there and the deployment has background jobs on', () => {
      const h = harness();
      h.service.onModuleInit();
      expect(h.jobs.register).toHaveBeenCalledWith(expect.objectContaining({ name: STAFFING_SEARCH_SWEEP_JOB }));

      const off = harness();
      const config = { get: () => ({ background: false }) };
      const service = new StaffingSearchService(off.prisma as never, off.proxy as never, off.staffing as never, config as never, off.jobs as never);
      service.onModuleInit();
      expect(off.jobs.register).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('what a poll reads', () => {
    const row = (patch: Record<string, unknown> = {}) => ({
      id: RUN,
      academicYearId: YEAR,
      status: 'RUNNING',
      stopReason: null,
      round: 3,
      evaluations: 41,
      acceptedMoves: 2,
      figures: { years: [{ year: 9, weeks: [] }], skippedPosts: 0, immovablePosts: 1 },
      checkpoint: { changes: [{ requirementId: real(1), fromTeacherId: T.a.real, toTeacherId: T.b.real }], tally: { better: 2, notBetter: 30, worse: 4, refused: 0, unranked: 5 } },
      error: null,
      errorCode: null,
      errorParams: null,
      leaseUntil: new Date(Date.now() + 60_000),
      createdAt: new Date(Date.now() - 120_000),
      startedAt: new Date(Date.now() - 100_000),
      finishedAt: null,
      ...patch,
    });

    it('is the counters, the figures in the school\'s own numbering, the tally and the time used against the budget', async () => {
      const h = harness();
      h.tx.academicYear!.findUnique!.mockResolvedValue({ gradeNumbering: 'TIOARIG' });
      h.state.row = row();

      const view = await h.service.view(RUN, user);

      expect(view).toMatchObject({ id: RUN, status: 'RUNNING', round: 3, evaluations: 41, acceptedMoves: 2, hasProposal: false, budgetMs: 900_000 });
      // The payload's 9 is the school's 10 in a ten-year numbering.
      expect(view.figures!.years[0]!.year).toBe(10);
      expect(view.tally).toEqual({ better: 2, notBetter: 30, worse: 4, refused: 0, unranked: 5 });
      expect(view.elapsedMs).toBeGreaterThan(90_000);
    });

    it('has a proposal once it has ended with a move, and not while it goes on', async () => {
      const h = harness();
      h.state.row = row({ status: 'SUCCEEDED', stopReason: 'LOCAL_OPTIMUM', finishedAt: new Date() });
      expect((await h.service.view(RUN, user)).hasProposal).toBe(true);

      h.state.row = row({ status: 'SUCCEEDED', checkpoint: { changes: [], tally: { better: 0, notBetter: 1, worse: 0, refused: 0, unranked: 0 } }, finishedAt: new Date() });
      expect((await h.service.view(RUN, user)).hasProposal).toBe(false);
    });

    it('shows a run whose lease has run out as what the sweep will make it, with its best so far kept', async () => {
      const h = harness();
      h.state.row = row({ leaseUntil: new Date(Date.now() - 60_000) });

      const view = await h.service.view(RUN, user);

      expect(view).toMatchObject({ status: 'FAILED', errorCode: SEARCH_ABANDONED, hasProposal: true });
      expect(view.finishedAt).not.toBeNull();
    });

    it('leaves a run that has ended exactly as it ended, however old its lease', async () => {
      const h = harness();
      h.state.row = row({ status: 'CANCELLED', stopReason: 'CANCELLED', leaseUntil: new Date(Date.now() - 3_600_000), finishedAt: new Date(Date.now() - 3_000_000) });

      expect(await h.service.view(RUN, user)).toMatchObject({ status: 'CANCELLED', errorCode: null });
    });

    it('is the year\'s latest run, or null when there is none, and a 404 for a run that is gone', async () => {
      const h = harness();
      h.state.row = null;
      expect(await h.service.latest(YEAR, user)).toBeNull();
      await expect(h.service.view(RUN, user)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  describe('the proposal', () => {
    const run = (patch: Record<string, unknown> = {}) => ({
      id: RUN,
      academicYearId: YEAR,
      status: 'SUCCEEDED',
      staffingBasis: STAFFING_BASIS,
      weekBasis: weekBasisOf(parts()),
      options: { pinnedRequirementIds: [] },
      figures: { years: [], skippedPosts: 0, immovablePosts: 0 },
      checkpoint: { changes: [{ requirementId: real(1), fromTeacherId: T.a.real, toTeacherId: T.b.real }], tally: { better: 1, notBetter: 0, worse: 0, refused: 0, unranked: 0 } },
      ...patch,
    });

    beforeEach(() => {
      jest.spyOn(proposals, 'growthRefusal').mockReturnValue(null);
    });

    it('is an ordinary proposal: today\'s leads with the moves laid over them, and the basis of the tjänstefördelning and the week together', async () => {
      const h = harness();
      h.state.row = run();

      const result = await h.service.proposal(RUN, user);

      expect(h.staffing.proposalFromLeads).toHaveBeenCalledTimes(1);
      const [, , leads, basis] = h.staffing.proposalFromLeads.mock.calls[0]!;
      expect(basis).toBe(withWeekBasis(STAFFING_BASIS, weekBasisOf(parts())));
      expect(leads.get(real(1))).toBe(T.b.real);
      expect(leads.get(real(2))).toBe(T.a.real);
      expect(result.proposal).toMatchObject({ basisSha256: basis });
    });

    it('is old (409 STAFF_PROPOSAL_STALE) when the tjänstefördelning or the releases have changed since the search read them', async () => {
      const h = harness();
      h.state.row = run({ staffingBasis: 'b'.repeat(64) });

      await expect(h.service.proposal(RUN, user)).rejects.toMatchObject({ response: { code: proposals.STAFF_PROPOSAL_STALE } });
      expect(h.staffing.proposalFromLeads).not.toHaveBeenCalled();
    });

    it('is old when the week has changed since the search counted it', async () => {
      const h = harness();
      h.state.row = run();
      h.state.weekParts = parts({ [BASIS_PARTS[0]!]: 'something-else' } as Partial<BasisParts>);

      await expect(h.service.proposal(RUN, user)).rejects.toMatchObject({ response: { code: proposals.STAFF_PROPOSAL_STALE } });
    });

    it('is old, and never shown, when a move no longer passes the plan\'s own rules (the teacher is no longer qualified)', async () => {
      const h = harness();
      h.state.row = run();
      h.state.plan = planOf([planned(1, { eligible: [T.a.real] }), planned(2)], [teacher(T.a.real), teacher(T.b.real)]);

      await expect(h.service.proposal(RUN, user)).rejects.toMatchObject({ response: { code: proposals.STAFF_PROPOSAL_STALE } });
    });

    it('is old when the move\'s from-lead is not the post\'s lead any more, or somebody would end over their limit', async () => {
      const h = harness();
      h.state.row = run({ checkpoint: { changes: [{ requirementId: real(1), fromTeacherId: T.c.real, toTeacherId: T.b.real }], tally: { better: 1, notBetter: 0, worse: 0, refused: 0, unranked: 0 } } });
      await expect(h.service.proposal(RUN, user)).rejects.toMatchObject({ response: { code: proposals.STAFF_PROPOSAL_STALE } });

      const grows = harness();
      grows.state.row = run();
      jest.spyOn(proposals, 'growthRefusal').mockReturnValue({ kind: 'LIMIT', userId: T.b.real });
      await expect(grows.service.proposal(RUN, user)).rejects.toMatchObject({ response: { code: proposals.STAFF_PROPOSAL_STALE } });
    });

    it('is refused while the search goes on, and a 404 when it found nothing to propose', async () => {
      const h = harness();
      h.state.row = run({ status: 'RUNNING' });
      await expect(h.service.proposal(RUN, user)).rejects.toBeInstanceOf(ConflictException);

      h.state.row = run({ checkpoint: { changes: [], tally: { better: 0, notBetter: 3, worse: 0, refused: 0, unranked: 0 } } });
      await expect(h.service.proposal(RUN, user)).rejects.toBeInstanceOf(NotFoundException);
      h.state.row = run({ checkpoint: null });
      await expect(h.service.proposal(RUN, user)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('figuresDocOf', () => {
  const cell = (demand: number, capacity = 1000) => ({ demand, capacity });

  it('keeps each judged year\'s weeks, before and as far as the search has come, with the dates of a period', () => {
    const start = new Map([[9, new Map([['0:x', cell(1100)], ['1:ODD_WEEKS', cell(900)]])]]);
    const now = new Map([[9, new Map([['0:x', cell(950)], ['1:ODD_WEEKS', cell(900)]])]]);
    const stretches = [[{ from: '2026-08-18', to: '2026-12-21' }], [{ from: '2027-01-11', to: '2027-06-10' }]];

    const doc = figuresDocOf(start, now, stretches as never, { skippedPosts: 2, immovablePosts: 3 });

    expect(doc.skippedPosts).toBe(2);
    expect(doc.immovablePosts).toBe(3);
    expect(doc.years).toHaveLength(1);
    const [autumn, spring] = doc.years[0]!.weeks;
    expect(autumn).toMatchObject({ period: 0, parity: null, from: '2026-08-18', to: '2026-12-21', before: { demandMinutes: 1100 }, after: { demandMinutes: 950 } });
    expect(spring).toMatchObject({ period: 1, parity: 'ODD_WEEKS', after: { demandMinutes: 900 } });
  });

  it('has no dates for a year without periods', () => {
    const start = new Map([[9, new Map([['x:x', cell(1100)]])]]);

    const doc = figuresDocOf(start, start, null, { skippedPosts: 0, immovablePosts: 0 });

    expect(doc.years[0]!.weeks[0]).toMatchObject({ period: null, parity: null, from: null, to: null });
  });
});
