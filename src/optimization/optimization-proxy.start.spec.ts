import { HttpException, Logger } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import type { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { of, throwError } from 'rxjs';
import { EngineTimingService } from './engine-timing.service';
import { PRODUCTION_BODY } from './__fixtures__/engine-timing-body';
import { OptimizationProxyService, type PreparedSchedule } from './optimization-proxy.service';
import type { PrismaService } from '../database/prisma.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/*
 * Ett schema som start (M9), on the wire: Generera hands the engine a schedule to start from, an engine that cannot take
 * one is never blocked by it, and the answer is counted into held, moved and laid.
 *
 * The fetch (prepareSchedule), the engine call's transport and the write are the big spec's. Here the fetch is a stub and
 * the write returns what it wrote, so that what is under test is the part M9 adds around them.
 */

const WITH_START = { ...PRODUCTION_BODY, capabilities: ['deadlineSeconds', 'startLessons'] };
const WITHOUT_START = { ...PRODUCTION_BODY, capabilities: ['deadlineSeconds'] };

const refusedWith = (status: number, data: unknown) => {
  const error = new AxiosError('boom');
  error.response = { status, data } as never;
  return error;
};

const USER = { userId: 'u-1', schoolId: 's-1', role: 'SCHOOL_ADMIN' } as unknown as AuthenticatedUser;

/** A week of two posts: maths (3 a week) and Swedish (2), of one class. */
const prepared = (over: { requirements?: object[]; draft?: object[]; rows?: object[] } = {}): PreparedSchedule =>
  ({
    ready: true,
    requestId: 'r-1',
    academicYearId: 'y-1',
    schoolId: 's-1',
    payload: {
      requestId: 'r-1',
      academicYearId: 'y-1',
      requirements: over.requirements ?? [
        { id: 'a-math', lessonsPerWeek: 3 },
        { id: 'a-swe', lessonsPerWeek: 2 },
      ],
    },
    storedRules: null,
    anonMaps: {
      requirementAnonMap: new Map([
        ['p-math', 'a-math'],
        ['p-swe', 'a-swe'],
      ]),
      groupAnonMap: new Map(),
    },
    freeDayWishes: [],
    consecutiveWishes: [],
    demand: [],
    mirrors: [],
    requirementRows: over.rows ?? [
      { id: 'p-math', subjectId: 's-math', studentGroupId: 'g-7a', recurrence: 'ALL_WEEKS', startDate: null, endDate: null },
      { id: 'p-swe', subjectId: 's-swe', studentGroupId: 'g-7a', recurrence: 'ALL_WEEKS', startDate: null, endDate: null },
    ],
    draftLessons: over.draft ?? [
      draft('s-math', 1, '08:00', '08:50'),
      draft('s-math', 3, '08:00', '08:50'),
      draft('s-math', 5, '08:00', '08:50'),
      draft('s-swe', 2, '09:00', '09:50'),
      draft('s-swe', 4, '09:00', '09:50'),
    ],
  }) as unknown as PreparedSchedule;

function draft(subjectId: string, dayOfWeek: number, startTime: string, endTime: string) {
  return {
    subjectId,
    studentGroupId: 'g-7a',
    teacherId: null,
    coTeacherId: null,
    roomId: null,
    dayOfWeek,
    startTime,
    endTime,
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    isParked: false,
  };
}

const lessonAt = (requirementId: string, dayOfWeek: number, startTime: string, endTime: string) => ({
  requirementId,
  roomId: null,
  dayOfWeek,
  startTime,
  endTime,
});

interface Built {
  service: OptimizationProxyService;
  post: jest.Mock;
  /** What the engine answers when the API asks it for its times (GET /api/v1/timing). */
  get: jest.Mock;
  tx: { scheduleVersion: { findFirst: jest.Mock }; academicYear: { findUnique: jest.Mock } };
  persist: jest.SpyInstance;
}

async function build(timingBody: unknown | null, fetched: PreparedSchedule): Promise<Built> {
  const post = jest.fn();
  const get = jest.fn();
  const config = {
    getOrThrow: jest.fn(() => ({ baseUrl: 'http://solver.test', apiKey: 'k'.repeat(32), timeoutMs: 240_000 })),
    get: jest.fn((key: string) => (key === 'app' ? { nodeEnv: 'production' } : undefined)),
  } as unknown as ConfigService;
  const http = { post, get } as unknown as HttpService;
  const timing = new EngineTimingService(http, config);
  get.mockReturnValue(timingBody === null ? throwError(() => new AxiosError('404')) : of({ data: timingBody }));
  await timing.refresh();
  const tx = { scheduleVersion: { findFirst: jest.fn() }, academicYear: { findUnique: jest.fn() } };
  const prisma = { withRls: jest.fn((_user: unknown, run: (t: unknown) => unknown) => run(tx)) } as unknown as PrismaService;
  const service = new OptimizationProxyService(prisma, http, config, undefined, timing);
  jest.spyOn(service, 'prepareSchedule').mockResolvedValue(fetched);
  const persist = jest.spyOn(service as unknown as { persistMasterLessons: () => Promise<unknown> }, 'persistMasterLessons').mockResolvedValue([]);
  return { service, post, get, tx, persist };
}

describe('OptimizationProxyService: Generera starts from a schedule (M9)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends the draft as startLessons, and says how many lessons stayed, moved and were laid', async () => {
    const { service, post } = await build(WITH_START, prepared());
    post.mockReturnValue(
      of({
        data: {
          requestId: 'r-1',
          status: 'OPTIMAL',
          // Three of maths stay, one of Swedish stays and one of Swedish moved from Thursday to Wednesday.
          lessons: [
            lessonAt('a-math', 1, '08:00:00', '08:50:00'),
            lessonAt('a-math', 3, '08:00:00', '08:50:00'),
            lessonAt('a-math', 5, '08:00:00', '08:50:00'),
            lessonAt('a-swe', 2, '09:00:00', '09:50:00'),
            lessonAt('a-swe', 3, '10:00:00', '10:50:00'),
          ],
          lunches: [],
        },
      }),
    );

    const result = await service.triggerScheduling('y-1', USER, null, null, { source: 'CURRENT' });

    const sent = post.mock.calls[0]![1] as { startLessons?: unknown[] };
    expect(sent.startLessons).toEqual([
      { requirementId: 'a-math', dayOfWeek: 1, startTime: '08:00:00', endTime: '08:50:00' },
      { requirementId: 'a-math', dayOfWeek: 3, startTime: '08:00:00', endTime: '08:50:00' },
      { requirementId: 'a-math', dayOfWeek: 5, startTime: '08:00:00', endTime: '08:50:00' },
      { requirementId: 'a-swe', dayOfWeek: 2, startTime: '09:00:00', endTime: '09:50:00' },
      { requirementId: 'a-swe', dayOfWeek: 4, startTime: '09:00:00', endTime: '09:50:00' },
    ]);
    expect(result.startedFrom).toEqual({
      source: 'CURRENT',
      versionName: null,
      engine: 'USED',
      offered: 5,
      used: 5,
      held: 4,
      moved: 1,
      laid: 0,
      dropped: {},
    });
  });

  it('sends the request it always sent, and answers with no startedFrom, when no start is asked for', async () => {
    const { service, post, tx } = await build(WITH_START, prepared());
    post.mockReturnValue(of({ data: { requestId: 'r-1', status: 'OPTIMAL', lessons: [], lunches: [] } }));

    const result = await service.triggerScheduling('y-1', USER, null, null);

    expect(post.mock.calls[0]![1]).not.toHaveProperty('startLessons');
    expect(result).not.toHaveProperty('startedFrom');
    expect(tx.scheduleVersion.findFirst).not.toHaveBeenCalled();
  });

  it('reads a saved version of THIS year and names it on the run', async () => {
    const { service, post, tx } = await build(WITH_START, prepared({ draft: [] }));
    tx.scheduleVersion.findFirst.mockResolvedValue({
      name: 'Före Generera',
      lessons: [{ studentGroupId: 'g-7a', subjectId: 's-math', dayOfWeek: 2, startTime: '10:00', endTime: '10:50', isGenerated: true, isLocked: false }],
    });
    post.mockReturnValue(of({ data: { requestId: 'r-1', status: 'OPTIMAL', lessons: [lessonAt('a-math', 2, '10:00:00', '10:50:00')], lunches: [] } }));

    const result = await service.triggerScheduling('y-1', USER, null, null, { source: 'VERSION', versionId: 'v-1' });

    expect((post.mock.calls[0]![1] as { startLessons: unknown[] }).startLessons).toHaveLength(1);
    expect(result.startedFrom).toMatchObject({ source: 'VERSION', versionName: 'Före Generera', engine: 'USED', held: 1, moved: 0, laid: 0 });
  });

  describe('an engine that cannot take it', () => {
    it('is not sent it when it has said what it can take and startLessons is not there: the week is laid as it always was, and the run says so', async () => {
      const { service, post, tx } = await build(WITHOUT_START, prepared());
      post.mockReturnValue(of({ data: { requestId: 'r-1', status: 'OPTIMAL', lessons: [lessonAt('a-math', 1, '08:00:00', '08:50:00')], lunches: [] } }));

      const result = await service.triggerScheduling('y-1', USER, null, null, { source: 'CURRENT' });

      expect(post.mock.calls[0]![1]).not.toHaveProperty('startLessons');
      expect(post).toHaveBeenCalledTimes(1);
      // The schedule is not even read: the engine could not use it.
      expect(tx.scheduleVersion.findFirst).not.toHaveBeenCalled();
      expect(result.startedFrom).toEqual({
        source: 'CURRENT',
        versionName: null,
        engine: 'OLDER',
        offered: 0,
        used: 0,
        held: null,
        moved: null,
        laid: null,
        dropped: {},
      });
    });

    it('is sent it once when it has said nothing, and sent the week again without it when it refuses the field: the same week, laid, and the run says so', async () => {
      const { service, post } = await build(null, prepared());
      post
        .mockReturnValueOnce(
          throwError(() =>
            refusedWith(422, {
              code: 'VALIDATION_ERROR',
              message: 'Request payload failed schema validation.',
              details: { errors: [{ type: 'extra_forbidden', loc: ['body', 'startLessons'], msg: 'Extra inputs are not permitted' }] },
            }),
          ),
        )
        .mockReturnValueOnce(of({ data: { requestId: 'r-1', status: 'OPTIMAL', lessons: [lessonAt('a-math', 1, '08:00:00', '08:50:00')], lunches: [] } }));

      const result = await service.triggerScheduling('y-1', USER, null, null, { source: 'CURRENT' });

      expect(post).toHaveBeenCalledTimes(2);
      expect(post.mock.calls[0]![1]).toHaveProperty('startLessons');
      expect(post.mock.calls[1]![1]).not.toHaveProperty('startLessons');
      expect(result.status).toBe('OPTIMAL');
      expect(result.startedFrom).toMatchObject({ engine: 'OLDER', used: 0, held: null, moved: null, laid: null });
    });

    it('that said it could and was rolled back since: sent the week again without the field, and the next run asks the engine again instead of believing what it said', async () => {
      const { service, post, get, tx } = await build(WITH_START, prepared());
      const answer = { data: { requestId: 'r-1', status: 'OPTIMAL', lessons: [lessonAt('a-math', 1, '08:00:00', '08:50:00')], lunches: [] } };
      post
        .mockReturnValueOnce(
          throwError(() =>
            refusedWith(422, {
              code: 'VALIDATION_ERROR',
              message: 'Request payload failed schema validation.',
              details: { errors: [{ type: 'extra_forbidden', loc: ['body', 'startLessons'], msg: 'Extra inputs are not permitted' }] },
            }),
          ),
        )
        .mockReturnValue(of(answer));
      // What the rolled-back engine says when it is asked again.
      get.mockClear();
      get.mockReturnValue(of({ data: WITHOUT_START }));

      const first = await service.triggerScheduling('y-1', USER, null, null, { source: 'CURRENT' });

      expect(post).toHaveBeenCalledTimes(2);
      expect(post.mock.calls[0]![1]).toHaveProperty('startLessons');
      expect(post.mock.calls[1]![1]).not.toHaveProperty('startLessons');
      expect(first.startedFrom).toMatchObject({ engine: 'OLDER', held: null });
      // It was asked at once, not left to the ten minutes between readings.
      expect(get).toHaveBeenCalledTimes(1);

      // The next run believes the new answer: the field is not sent and the schedule is not even read.
      tx.scheduleVersion.findFirst.mockClear();
      const second = await service.triggerScheduling('y-1', USER, null, null, { source: 'VERSION', versionId: 'v-1' });

      expect(post).toHaveBeenCalledTimes(3);
      expect(post.mock.calls[2]![1]).not.toHaveProperty('startLessons');
      expect(tx.scheduleVersion.findFirst).not.toHaveBeenCalled();
      expect(second.startedFrom).toMatchObject({ engine: 'OLDER', offered: 0, used: 0 });
    });

    it('is not mistaken for another refusal: a 422 about a different field is not read as "older than startLessons"', async () => {
      const { service, post } = await build(WITH_START, prepared());
      post.mockReturnValue(
        throwError(() => refusedWith(422, { details: { errors: [{ type: 'extra_forbidden', loc: ['body', 'relaxation'], msg: 'x' }] } })),
      );

      await expect(service.triggerScheduling('y-1', USER, null, null, { source: 'CURRENT' })).rejects.toBeInstanceOf(HttpException);
      expect(post).toHaveBeenCalledTimes(1);
    });
  });

  describe('a schedule with nothing to start from', () => {
    it('refuses with 409 START_NOTHING_TO_START_FROM before the engine is woken, and writes nothing', async () => {
      // Every lesson of the draft belongs to a post this year has no row for.
      const { service, post, persist } = await build(WITH_START, prepared({ draft: [draft('s-gone', 1, '08:00', '08:50')] }));

      const thrown = await service.triggerScheduling('y-1', USER, null, null, { source: 'CURRENT' }).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(HttpException);
      expect((thrown as HttpException).getStatus()).toBe(409);
      expect((thrown as HttpException).getResponse()).toMatchObject({
        code: 'START_NOTHING_TO_START_FROM',
        params: { source: 'CURRENT', offered: 1, noPost: 1 },
      });
      expect(post).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    });

    it('refuses a first Generera that asks to start from the draft: there is none', async () => {
      const { service, post } = await build(WITH_START, prepared({ draft: [] }));

      const thrown = await service.triggerScheduling('y-1', USER, null, null, { source: 'CURRENT' }).catch((error: unknown) => error);

      expect((thrown as HttpException).getResponse()).toMatchObject({ code: 'START_NOTHING_TO_START_FROM', params: { offered: 0 } });
      expect(post).not.toHaveBeenCalled();
    });

    it('does not refuse a week with nothing left to lay: every post is locked, so there is nothing to start and the engine is not asked either', async () => {
      const { service, post, tx } = await build(WITH_START, prepared({ requirements: [], draft: [] }));

      const result = await service.triggerScheduling('y-1', USER, null, null, { source: 'CURRENT' });

      expect(post).not.toHaveBeenCalled();
      expect(tx.scheduleVersion.findFirst).not.toHaveBeenCalled();
      expect(result.status).toBe('FEASIBLE');
      expect(result).not.toHaveProperty('startedFrom');
    });
  });

  describe('an engine older than startLessons and than exemptFromLunch (Undantag med flit, E1b)', () => {
    const forbidden = (...locs: (string | number)[][]) =>
      refusedWith(422, {
        code: 'VALIDATION_ERROR',
        message: 'Request payload failed schema validation.',
        details: { errors: locs.map((loc) => ({ type: 'extra_forbidden', loc, msg: 'Extra inputs are not permitted' })) },
      });
    const maps = () => ({
      requirementAnonMap: new Map<string, string>(),
      roomAnonMap: new Map<string, string>(),
      groupAnonMap: new Map<string, string>(),
      roomTypeAnonMap: new Map<string, string>(),
      constraintAnonMap: new Map<string, string>(),
      workRuleAnonMap: new Map<string, string>(),
      nameById: new Map<string, string>(),
      lessonAnonMap: new Map<string, string>(),
    });
    const WEEK = {
      requestId: 'r',
      requirements: [],
      fixedLessons: [{ id: 'l-1' }, { id: 'l-2', exemptFromLunch: true }],
      startLessons: [{ requirementId: 'a-math', dayOfWeek: 1, startTime: '08:00:00', endTime: '08:50:00' }],
    };
    const call = (service: OptimizationProxyService, fellBack: { startLessons?: boolean }) =>
      (service as unknown as { callAiEngine: (p: string, body: unknown, m: unknown, o: unknown) => Promise<unknown> }).callAiEngine(
        '/v1/schedule',
        WEEK,
        maps(),
        { fellBack },
      );

    it('answers each refusal once and sends neither field again: three calls, the third with neither', async () => {
      const { service, post } = await build(null, prepared());
      post
        .mockReturnValueOnce(throwError(() => forbidden(['body', 'startLessons'], ['body', 'fixedLessons', 1, 'exemptFromLunch'])))
        .mockReturnValueOnce(throwError(() => forbidden(['body', 'fixedLessons', 1, 'exemptFromLunch'])))
        .mockReturnValueOnce(of({ data: { requestId: 'r', status: 'OPTIMAL', lessons: [] } }));
      const fellBack: { startLessons?: boolean } = {};

      await expect(call(service, fellBack)).resolves.toMatchObject({ status: 'OPTIMAL' });

      expect(post).toHaveBeenCalledTimes(3);
      const sent = post.mock.calls.map(([, body]) => body as { startLessons?: unknown; fixedLessons: Record<string, unknown>[] });
      expect(sent.map((body) => [body.startLessons !== undefined, body.fixedLessons[1]!['exemptFromLunch'] !== undefined])).toEqual([
        [true, true],
        [false, true],
        [false, false],
      ]);
      // The lock itself is what it was, less the one key.
      expect(sent[2]!.fixedLessons).toEqual([{ id: 'l-1' }, { id: 'l-2' }]);
      expect(fellBack.startLessons).toBe(true);
    });

    it('does not send the week again for ever when the engine lists both on every refusal: after the two answers the third refusal is the refusal', async () => {
      const { service, post } = await build(null, prepared());
      post.mockReturnValue(throwError(() => forbidden(['body', 'startLessons'], ['body', 'fixedLessons', 1, 'exemptFromLunch'])));

      const thrown = await call(service, {}).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(HttpException);
      expect(post).toHaveBeenCalledTimes(3);
    });

    it('strips only the field that is refused: an engine that knows startLessons and not exemptFromLunch keeps the start', async () => {
      const { service, post } = await build(null, prepared());
      post
        .mockReturnValueOnce(throwError(() => forbidden(['body', 'fixedLessons', 1, 'exemptFromLunch'])))
        .mockReturnValueOnce(of({ data: { requestId: 'r', status: 'OPTIMAL', lessons: [] } }));
      const fellBack: { startLessons?: boolean } = {};

      await call(service, fellBack);

      expect(post).toHaveBeenCalledTimes(2);
      expect((post.mock.calls[1]![1] as { startLessons?: unknown }).startLessons).toHaveLength(1);
      expect(fellBack.startLessons).toBeUndefined();
    });
  });

  it('counts nothing for a week the engine refused: the school reads the refusal, not a count of lessons that were never written', async () => {
    const { service, post, persist } = await build(WITH_START, prepared());
    persist.mockResolvedValue(null);
    post.mockReturnValue(of({ data: { requestId: 'r-1', status: 'INFEASIBLE', lessons: [], lunches: [], conflicts: null } }));

    const result = await service.triggerScheduling('y-1', USER, null, null, { source: 'CURRENT' });

    expect(result.status).toBe('INFEASIBLE');
    expect(result.startedFrom).toMatchObject({ engine: 'USED', offered: 5, used: 5, held: null, moved: null, laid: null });
  });
});
