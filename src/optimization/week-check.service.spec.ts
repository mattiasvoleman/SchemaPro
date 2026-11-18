// FIRST, as the built application reads it (see optimization-module.di.spec.ts): the proxy's constructor must see the
// clash rule's file before the proxy's own is read. Kept first on purpose; do not let an import sorter move it.
import { MasterLessonsService } from '../calendar/master-lessons.service';
import { HttpException, HttpStatus, Logger, ServiceUnavailableException } from '@nestjs/common';
import { testUser } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type {
  AiEngineConflictAnalysis,
  AiEngineConflictDetail,
} from './interfaces/ai-engine-payload.interface';
import type { AiEngineWeekCheckResponse } from './interfaces/week-check.interface';
import type { OptimizationProxyService, PrepareResult } from './optimization-proxy.service';
import {
  ENGINE_LACKS_WEEK_CHECK,
  WEEK_CHECK_PATH,
  WEEK_CHECK_TIMEOUT_MS,
  WeekCheckService,
} from './week-check.service';

void MasterLessonsService;

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const TEACHER_USER_ID = '99999999-9999-4999-8999-999999999999';
const ANON_GROUP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const user = testUser();
const tx = { marker: 'the transaction' };

const detail = (overrides: Partial<AiEngineConflictDetail> = {}): AiEngineConflictDetail => ({
  category: 'REQUIREMENT_DEMAND',
  code: 'TIGHT_WEEK_LOAD',
  params: { grades: '9', demandMinutes: 2120, capacityMinutes: 2275, percent: 93 },
  message: 'Year 9 needs at least 2120 of the 2275 minutes (93 %).',
  requirementIds: [ANON_GROUP],
  roomIds: [],
  constraintIds: [],
  resourceIds: [ANON_GROUP],
  resourceNames: ['9A'],
  subjectIds: [TEACHER_USER_ID],
  ...overrides,
});

const analysis = (overrides: Partial<AiEngineConflictAnalysis> = {}): AiEngineConflictAnalysis => ({
  summary: '',
  summaryCode: '',
  summaryParams: {},
  conflicts: [detail()],
  ...overrides,
});

const answer = (overrides: Partial<AiEngineWeekCheckResponse> = {}): AiEngineWeekCheckResponse => ({
  requestId: 'r-1',
  verdict: 'TIGHT',
  years: [{ year: 9, demandMinutes: 2120, capacityMinutes: 2275, percent: 93, over: false }],
  conflicts: analysis(),
  skipped: ['LUNCH_STAGE'],
  elapsedMs: 210,
  ...overrides,
});

const anonMaps = { marker: 'anon maps' };
const payload = { requestId: 'r-1', academicYearId: YEAR_ID, requirements: [{ id: 'req-1' }], rooms: [], constraints: [] };

const ready = (overrides: Record<string, unknown> = {}): PrepareResult =>
  ({
    ready: true,
    requestId: 'r-1',
    academicYearId: YEAR_ID,
    schoolId: user.schoolId,
    payload,
    storedRules: null,
    anonMaps,
    ...overrides,
  }) as unknown as PrepareResult;

describe('WeekCheckService', () => {
  let prisma: { withRls: jest.Mock };
  let proxy: { prepareSchedule: jest.Mock; callAiEngine: jest.Mock; realiseConflicts: jest.Mock };
  let service: WeekCheckService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma = { withRls: jest.fn(async (_user: unknown, run: (client: unknown) => unknown) => run(tx)) };
    proxy = {
      prepareSchedule: jest.fn(async () => ready()),
      callAiEngine: jest.fn(async () => answer()),
      // The proxy's own answer is the engine's analysis, "realised": here the names the school knows.
      realiseConflicts: jest.fn((conflicts: AiEngineConflictAnalysis | null | undefined) =>
        conflicts ? { ...conflicts, conflicts: conflicts.conflicts.map((d) => ({ ...d, resourceNames: ['9A'] })) } : null,
      ),
    };
    service = new WeekCheckService(prisma as unknown as PrismaService, proxy as unknown as OptimizationProxyService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('the request', () => {
    it("is Generera's own fetch, in the caller's transaction, and asks the engine outside it with the stored rules", async () => {
      const rules = { lunchStartTime: '11:00:00', lunchEndTime: '13:00:00', lunchMinutes: 30 };
      proxy.prepareSchedule.mockResolvedValue(ready({ storedRules: rules }));

      await service.check(YEAR_ID, user);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      // Only the request id: no `employmentReads`, so the fetch logs what it reads as Generera's does.
      expect(proxy.prepareSchedule).toHaveBeenCalledWith(tx, YEAR_ID, user, { requestId: expect.any(String) });
      expect(proxy.callAiEngine).toHaveBeenCalledWith(
        WEEK_CHECK_PATH,
        { ...payload, rules },
        anonMaps,
        { timeoutMs: WEEK_CHECK_TIMEOUT_MS },
      );
      // The engine is asked after the transaction has closed.
      expect(prisma.withRls.mock.invocationCallOrder[0]).toBeLessThan(proxy.callAiEngine.mock.invocationCallOrder[0]!);
    });

    it('sends no `rules` key for a school with none, the request a Generera without rules sends', async () => {
      await service.check(YEAR_ID, user);

      expect(proxy.callAiEngine.mock.calls[0]![1]).toEqual(payload);
      expect(Object.keys(proxy.callAiEngine.mock.calls[0]![1] as object)).not.toContain('rules');
    });

    it('waits seconds for the engine, not the minutes a run waits', () => {
      expect(WEEK_CHECK_TIMEOUT_MS).toBe(30_000);
      expect(WEEK_CHECK_PATH).toBe('/api/v1/check-week');
    });
  });

  describe('the answer', () => {
    it('is the engine\'s, whitelisted: the verdict, the years, the sentences by code and values, what was not run', async () => {
      const view = await service.check(YEAR_ID, user);

      expect(view).toEqual({
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
              resourceNames: ['9A'],
            },
          ],
        },
        skipped: ['LUNCH_STAGE'],
        elapsedMs: 210,
        checkedBy: 'ENGINE',
      });
      expect(proxy.realiseConflicts).toHaveBeenCalledWith(answer().conflicts, anonMaps);
    });

    it('carries no id, anonymous or real, and no teacher: nothing a reader\'s HR-läs would decide', async () => {
      const body = JSON.stringify(await service.check(YEAR_ID, user));

      expect(body).not.toContain(ANON_GROUP);
      expect(body).not.toContain(TEACHER_USER_ID);
      expect(body).not.toMatch(/requirementIds|resourceIds|subjectIds|roomIds|constraintIds/);
    });

    it('says OK as no conflicts and no years', async () => {
      proxy.callAiEngine.mockResolvedValue(answer({ verdict: 'OK', years: [], conflicts: null }));

      expect(await service.check(YEAR_ID, user)).toMatchObject({ verdict: 'OK', years: [], conflicts: null, checkedBy: 'ENGINE' });
    });

    it('keeps an impossible week\'s summary and its code and values', async () => {
      proxy.callAiEngine.mockResolvedValue(
        answer({
          verdict: 'IMPOSSIBLE',
          years: [{ year: 9, demandMinutes: 2365, capacityMinutes: 2275, percent: 103, over: true }],
          conflicts: analysis({
            summary: 'Year 9 does not fit.',
            summaryCode: 'DEMAND_YEAR_WEEK_SHORT',
            summaryParams: { grades: '9', demandMinutes: 2365, capacityMinutes: 2275, shared: 'some' },
          }),
        }),
      );

      const view = await service.check(YEAR_ID, user);

      expect(view.verdict).toBe('IMPOSSIBLE');
      expect(view.years[0]!.over).toBe(true);
      expect(view.conflicts).toMatchObject({
        summary: 'Year 9 does not fit.',
        summaryCode: 'DEMAND_YEAR_WEEK_SHORT',
        summaryParams: { grades: '9', demandMinutes: 2365, capacityMinutes: 2275, shared: 'some' },
      });
    });

    it('drops a name of something not run that this gateway has no sentence for, rather than hand it to a screen', async () => {
      proxy.callAiEngine.mockResolvedValue(answer({ skipped: ['LUNCH_STAGE', 'A_NEWER_THING', 'WEEK_LOAD_DEADLINE'] }));

      expect((await service.check(YEAR_ID, user)).skipped).toEqual(['LUNCH_STAGE', 'WEEK_LOAD_DEADLINE']);
    });

    it('refuses a verdict it cannot say as the engine\'s failure, with nothing passed on', async () => {
      proxy.callAiEngine.mockResolvedValue(answer({ verdict: 'MAYBE' as never }));

      await expect(service.check(YEAR_ID, user)).rejects.toMatchObject({ status: HttpStatus.BAD_GATEWAY });
    });

    it('reads a year with no number as the classes of unknown year, and an absent `over` as false', async () => {
      proxy.callAiEngine.mockResolvedValue(
        answer({ years: [{ year: undefined as never, demandMinutes: 1, capacityMinutes: 2, percent: 50, over: undefined as never }] }),
      );

      expect((await service.check(YEAR_ID, user)).years).toEqual([
        { year: null, demandMinutes: 1, capacityMinutes: 2, percent: 50, over: false },
      ]);
    });

    it('falls back to its own clock when the engine sends no time', async () => {
      proxy.callAiEngine.mockResolvedValue(answer({ elapsedMs: undefined as never }));

      expect((await service.check(YEAR_ID, user)).elapsedMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("the gateway's own pre-flight", () => {
    const refusal = (summaryCode: string) =>
      ({
        ready: false,
        requestId: 'r-1',
        academicYearId: YEAR_ID,
        refusalCode: summaryCode,
        refusal: {
          requestId: 'r-1',
          status: 'INFEASIBLE',
          lessons: [],
          conflicts: analysis({
            summary: 'Two posts have no teacher.',
            summaryCode,
            summaryParams: { count: 2 },
            conflicts: [detail({ category: 'STAFFING' as never, code: summaryCode, params: { count: 2 }, resourceNames: ['Matematik för 7A'] })],
          }),
        },
      }) as unknown as PrepareResult;

    it('answers IMPOSSIBLE as the refusal Generera gives, without asking the engine and without realising it twice', async () => {
      proxy.prepareSchedule.mockResolvedValue(refusal('STAFF_UNSTAFFED_REQUIREMENTS'));

      const view = await service.check(YEAR_ID, user);

      expect(view).toMatchObject({
        verdict: 'IMPOSSIBLE',
        years: [],
        skipped: [],
        checkedBy: 'GATEWAY',
        conflicts: {
          summaryCode: 'STAFF_UNSTAFFED_REQUIREMENTS',
          summaryParams: { count: 2 },
          conflicts: [{ code: 'STAFF_UNSTAFFED_REQUIREMENTS', resourceNames: ['Matematik för 7A'] }],
        },
      });
      expect(proxy.callAiEngine).not.toHaveBeenCalled();
      // The refusal is realised already (triggerScheduling returns it as it stands): a second turn would put the period in twice.
      expect(proxy.realiseConflicts).not.toHaveBeenCalled();
    });

    it('throws the 400 of two blocks that no longer fit together, as Generera does', async () => {
      const error = new HttpException({ message: 'blocks differ', code: 'BLOCK_SAME_TIMES_DIFFER' }, HttpStatus.BAD_REQUEST);
      proxy.prepareSchedule.mockResolvedValue({ ...(refusal('BLOCK_SAME_TIMES_DIFFER') as object), error } as never);

      await expect(service.check(YEAR_ID, user)).rejects.toBe(error);
      expect(proxy.callAiEngine).not.toHaveBeenCalled();
    });

    it('says a week with every post hand-placed is OK without asking the engine, and says why', async () => {
      proxy.prepareSchedule.mockResolvedValue(ready({ payload: { ...payload, requirements: [] } }));

      expect(await service.check(YEAR_ID, user)).toMatchObject({
        verdict: 'OK',
        years: [],
        conflicts: null,
        skipped: ['ENGINE'],
        checkedBy: 'GATEWAY',
      });
      expect(proxy.callAiEngine).not.toHaveBeenCalled();
    });
  });

  describe('when the engine cannot answer', () => {
    it('says an older engine\'s 404 as the function that is coming, in Swedish, with its own code', async () => {
      proxy.callAiEngine.mockRejectedValue(new HttpException({ message: 'Not Found' }, HttpStatus.NOT_FOUND));

      const error = await service.check(YEAR_ID, user).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect((error as HttpException).getResponse()).toEqual({
        message: 'Schemamotorn är äldre än API:t och kan inte kontrollera veckan ännu. Försök igen om några minuter.',
        code: ENGINE_LACKS_WEEK_CHECK,
      });
    });

    it.each([
      ['a refusal of the payload', new HttpException({ message: 'seats', code: 'INVALID_X', params: { seats: 20 } }, HttpStatus.BAD_REQUEST)],
      ['an engine that was not reached', new ServiceUnavailableException('The AI engine could not be reached.')],
      ['a check that took too long', new ServiceUnavailableException('The AI engine did not respond in time.')],
      ['an engine that broke', new HttpException({ message: 'The AI engine returned an error.' }, HttpStatus.INTERNAL_SERVER_ERROR)],
      ['a 422 the gateway caused', new HttpException({ message: 'Request payload failed schema validation.' }, HttpStatus.UNPROCESSABLE_ENTITY)],
    ])('passes %s on as it came, and does not say it is an older engine', async (_label, thrown) => {
      proxy.callAiEngine.mockRejectedValue(thrown);

      await expect(service.check(YEAR_ID, user)).rejects.toBe(thrown);
    });

    it('does not turn the fetch\'s own 404 (a year that is not there) into an older engine', async () => {
      const notThere = new HttpException({ message: 'Academic year not found.' }, HttpStatus.NOT_FOUND);
      proxy.prepareSchedule.mockRejectedValue(notThere);

      await expect(service.check(YEAR_ID, user)).rejects.toBe(notThere);
      expect(proxy.callAiEngine).not.toHaveBeenCalled();
    });
  });
});
