// FIRST, as the built application reads it (see optimization-module.di.spec.ts): the proxy's constructor must see the
// clash rule's file before the proxy's own is read. Kept first on purpose; do not let an import sorter move it.
import { MasterLessonsService } from '../calendar/master-lessons.service';
import { ConflictException, HttpException, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createTxMock, testUser } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { AiEngineSuggestChangesResponse } from './interfaces/suggest-changes.interface';
import type { OptimizationProxyService, PrepareResult } from './optimization-proxy.service';
import {
  ANALYSIS_HEARTBEAT_MS,
  ANALYSIS_LEASE_SECONDS,
  PREFLIGHT_REFUSAL_CODES,
  failedSuggestions,
  runningSuggestions,
  suggestionsFromEngine,
  suggestionsOf,
  type Realiser,
  type SuggestionsStored,
} from './suggestions';
import {
  SUGGESTIONS_NOT_FOR_THIS_RUN,
  SUGGESTIONS_RUN_IS_OLD,
  SUGGESTIONS_YEAR_BUSY,
  SUGGEST_CHANGES_PATH,
  SUGGEST_DEADLINE_SECONDS,
  SUGGEST_SEARCH_SECONDS,
  SUGGEST_WAIT_MS,
  SUGGEST_WORKERS,
  SuggestionsService,
  failureOf,
} from './suggestions.service';

void MasterLessonsService;

/*
 * The analysis of a run that ended without a timetable (suggestions.service.ts).
 *
 * WHAT THESE HOLD: what a start is refused for, and by which code; that a second press is the first one's answer; that the engine is
 * asked outside the transaction, with the search and the deadline the analysis states, and with the run's own rules; that EVERY way
 * out writes the column (no error leaves a run RUNNING); what each way the engine can fail is said as; and that the write is only
 * over the analysis this call started.
 */

const JOB_ID = '66666666-6666-4666-8666-666666666666';
const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const RULE = '11111111-1111-4111-8111-111111111111';
const TEACHER = '99999999-9999-4999-8999-999999999999';
const ANON_RULE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const user = testUser();

const refused = { id: JOB_ID, academicYearId: YEAR_ID, status: 'SUCCEEDED', solverStatus: 'INFEASIBLE', errorCode: null, suggestions: null };

const realiser: Realiser = {
  real: (id) => (id === ANON_RULE ? RULE : id),
  nameOf: () => undefined,
  teacherOfRule: (id) => (id === RULE ? TEACHER : undefined),
};

const answer = (over: Partial<AiEngineSuggestChangesResponse> = {}): AiEngineSuggestChangesResponse => ({
  requestId: 'r-1',
  verdict: 'CHANGES',
  changes: [{
    rule: 'TEACHER_DAILY_CAP', cost: 168, current: 300, needed: 330, weekdays: [3], requirementIds: [], roomIds: [],
    resourceIds: [ANON_RULE], proof: 'SOLVED',
  }],
  verified: true,
  searchSeconds: 60,
  verifySeconds: 2.5,
  elapsedMs: 70_000,
  ...over,
});

const anonMaps = { marker: 'anon maps' };
const payload = { requestId: 'r-1', academicYearId: YEAR_ID, requirements: [{ id: 'req-1' }], rooms: [], constraints: [] };
const ready = (over: Record<string, unknown> = {}): PrepareResult =>
  ({ ready: true, requestId: 'r-1', academicYearId: YEAR_ID, schoolId: user.schoolId, payload, storedRules: null, anonMaps, ...over }) as unknown as PrepareResult;

const http = (status: number): HttpException => new HttpException({ message: 'x' }, status);

/** The JSON a Prisma.sql statement was given as a value: what the column is set to. */
const writtenBy = (call: unknown[]): SuggestionsStored =>
  JSON.parse((call[0] as Prisma.Sql).values.find((value) => typeof value === 'string' && value.startsWith('{')) as string) as SuggestionsStored;

describe('SuggestionsService', () => {
  let tx: ReturnType<typeof createTxMock>;
  /** The statements that touch the column (the claim, then the write), not the year's solve-start lock's two. */
  const columnCalls = (): unknown[][] =>
    tx.$executeRaw.mock.calls.filter((call) => ((call[0] as Prisma.Sql).sql ?? '').includes('UPDATE "OptimizationJobs"'));
  let prisma: { withRls: jest.Mock };
  let proxy: { prepareSchedule: jest.Mock; callAiEngine: jest.Mock; realiserOf: jest.Mock };
  let service: SuggestionsService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    tx = createTxMock();
    tx.optimizationJob!.findUnique!.mockResolvedValue(refused);
    tx.optimizationJob!.findFirst!.mockResolvedValue({ id: JOB_ID });
    tx.optimizationJob!.count!.mockResolvedValue(0);
    // yearHasActiveCandidateRun: no candidate run holds the year.
    tx.$queryRaw.mockResolvedValue([{ active: 0 }]);
    tx.$executeRaw.mockResolvedValue(1);
    prisma = { withRls: jest.fn(async (_user: unknown, run: (client: unknown) => unknown) => run(tx)) };
    proxy = {
      prepareSchedule: jest.fn(async () => ready()),
      callAiEngine: jest.fn(async () => answer()),
      realiserOf: jest.fn(() => realiser),
    };
    service = new SuggestionsService(prisma as unknown as PrismaService, proxy as unknown as OptimizationProxyService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('what a start is refused for', () => {
    it('is 404 for a run the school has not got', async () => {
      tx.optimizationJob!.findUnique!.mockResolvedValue(null);
      await expect(service.start(JOB_ID, user)).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it.each([
      ['a run that has a timetable', { status: 'SUCCEEDED', solverStatus: 'OPTIMAL', errorCode: null }],
      ['a run still going', { status: 'RUNNING', solverStatus: null, errorCode: null }],
      ['a run the engine never answered', { status: 'FAILED', solverStatus: null, errorCode: 'ENGINE_NOT_REACHED' }],
      ['a run whose process went away', { status: 'FAILED', solverStatus: null, errorCode: 'ENGINE_RUN_ABANDONED' }],
      ['a refusal a rule that never gives way made', { status: 'FAILED', solverStatus: null, errorCode: 'LUNCH_WINDOW_SHORTER_THAN_BREAK' }],
    ])('is 409 %s, and wakes nothing', async (_name, run) => {
      tx.optimizationJob!.findUnique!.mockResolvedValue({ ...refused, ...run });
      await expect(service.start(JOB_ID, user)).rejects.toMatchObject({ response: { code: SUGGESTIONS_NOT_FOR_THIS_RUN } });
      expect(proxy.prepareSchedule).not.toHaveBeenCalled();
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it.each(PREFLIGHT_REFUSAL_CODES)('is 409 for a run the gateway itself refused before the engine was asked (%s), and the start reads the code that says so (G6b)', async (code) => {
      tx.optimizationJob!.findUnique!.mockResolvedValue({ ...refused, conflictSummaryCode: code });
      await expect(service.start(JOB_ID, user)).rejects.toMatchObject({ response: { code: SUGGESTIONS_NOT_FOR_THIS_RUN } });
      // The mock answers whatever it is given whether the select asks for the code or not: that it is asked for is held here.
      expect(tx.optimizationJob!.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ select: expect.objectContaining({ conflictSummaryCode: true }) }),
      );
      expect(proxy.prepareSchedule).not.toHaveBeenCalled();
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('is 409 for a run that is not the year\'s newest', async () => {
      tx.optimizationJob!.findFirst!.mockResolvedValue({ id: 'another-run' });
      await expect(service.start(JOB_ID, user)).rejects.toMatchObject({ response: { code: SUGGESTIONS_RUN_IS_OLD } });
      expect(tx.optimizationJob!.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { academicYearId: YEAR_ID }, orderBy: { createdAt: 'desc' },
      }));
    });

    it('is 409 while the year has a run going or a schemaförslag run', async () => {
      tx.optimizationJob!.count!.mockResolvedValueOnce(1);
      await expect(service.start(JOB_ID, user)).rejects.toMatchObject({ response: { code: SUGGESTIONS_YEAR_BUSY } });
      expect(tx.optimizationJob!.count).toHaveBeenCalledWith({ where: { academicYearId: YEAR_ID, status: { in: ['PENDING', 'RUNNING'] } } });
      tx.$queryRaw.mockResolvedValue([{ active: 1 }]);
      await expect(service.start(JOB_ID, user)).rejects.toBeInstanceOf(ConflictException);
      expect(columnCalls()).toHaveLength(0);
    });

    it('asks under the year\'s solve-start lock, which Generera\'s start and a schemaförslag run\'s take too, before it counts the runs', async () => {
      await service.start(JOB_ID, user);
      await service.settled();
      const textOf = (call: unknown[]): string => (Array.isArray(call[0]) ? (call[0] as string[]).join('?') : ((call[0] as Prisma.Sql).sql ?? ''));
      const lock = tx.$executeRaw.mock.calls.findIndex((call) => textOf(call).includes(`pg_advisory_xact_lock(hashtext('grundschema-solve-start')`));
      expect(lock).toBeGreaterThan(-1);
      expect(textOf(tx.$executeRaw.mock.calls[lock - 1]!)).toContain(`SET LOCAL lock_timeout = '5s'`);
      // Before the count of the year's jobs, and so before the claim.
      expect(tx.$executeRaw.mock.invocationCallOrder[lock]!).toBeLessThan(tx.optimizationJob!.count!.mock.invocationCallOrder[0]!);
      expect(tx.$executeRaw.mock.invocationCallOrder[lock]!).toBeLessThan(tx.$executeRaw.mock.invocationCallOrder[tx.$executeRaw.mock.calls.indexOf(columnCalls()[0]!)]!);
    });

    it('is 409 SCHEDULE_BUSY when the start lock is not had in 5 s, and claims nothing', async () => {
      tx.$executeRaw.mockImplementation(async (statement: unknown) => {
        if (Array.isArray(statement) && statement.join('?').includes('grundschema-solve-start')) throw new Error('canceling statement due to lock timeout (55P03)');
        return 1;
      });
      await expect(service.start(JOB_ID, user)).rejects.toMatchObject({ response: { code: 'SCHEDULE_BUSY' } });
      expect(columnCalls()).toHaveLength(0);
    });

    it.each([
      ['an INFEASIBLE answer', { status: 'SUCCEEDED', solverStatus: 'INFEASIBLE', errorCode: null }],
      ['a TIMEOUT answer', { status: 'SUCCEEDED', solverStatus: 'TIMEOUT', errorCode: null }],
      ['the engine\'s own clock running out', { status: 'FAILED', solverStatus: null, errorCode: 'ENGINE_TIMED_OUT' }],
      ['the API\'s wait running out', { status: 'FAILED', solverStatus: null, errorCode: 'ENGINE_WAIT_EXPIRED' }],
      ['the road to the engine closing the call', { status: 'FAILED', solverStatus: null, errorCode: 'ENGINE_PATH_CLOSED' }],
      ['a cap the week cannot hold', { status: 'FAILED', solverStatus: null, errorCode: 'TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK' }],
      ['a lesson longer than the cap', { status: 'FAILED', solverStatus: null, errorCode: 'TEACHER_LESSON_LONGER_THAN_DAILY_CAP' }],
      ['a post\'s days the week cannot hold', { status: 'FAILED', solverStatus: null, errorCode: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK' }],
      ['a subject\'s spread', { status: 'FAILED', solverStatus: null, errorCode: 'SUBJECT_DISTRIBUTION_WEEK_TOO_SHORT' }],
      ['a locked room the week cannot hold', { status: 'FAILED', solverStatus: null, errorCode: 'ROOM_LOCK_WEEK_TOO_SMALL' }],
    ])('is asked for after %s', async (_name, run) => {
      tx.optimizationJob!.findUnique!.mockResolvedValue({ ...refused, ...run });
      await expect(service.start(JOB_ID, user)).resolves.toMatchObject({ state: 'RUNNING' });
      await service.settled();
    });
  });

  describe('a press', () => {
    it('answers at once with the analysis RUNNING, claims the column in one statement, and returns before the engine has answered', async () => {
      let release: (value: AiEngineSuggestChangesResponse) => void = () => undefined;
      proxy.callAiEngine.mockReturnValue(new Promise((resolve) => { release = resolve; }));

      const view = await service.start(JOB_ID, user);

      expect(view).toMatchObject({ state: 'RUNNING', verdict: null, changes: [], failure: null, finishedAt: null });
      const claim = columnCalls()[0]![0] as Prisma.Sql;
      expect(claim.sql).toContain('UPDATE "OptimizationJobs"');
      expect(claim.sql).toContain(`"suggestions"->>'state' <> 'RUNNING'`);
      expect(claim.values).toContain(JOB_ID);
      // The claim is in the first transaction, the engine is asked in no transaction at all.
      await new Promise((resolve) => setImmediate(resolve));
      expect(proxy.callAiEngine).toHaveBeenCalledTimes(1);
      release(answer());
      await service.settled();
    });

    it('is the first press\'s answer when one is running, and starts no second analysis', async () => {
      const running = runningSuggestions(new Date());
      tx.optimizationJob!.findUnique!.mockResolvedValue({ ...refused, suggestions: running });

      const view = await service.start(JOB_ID, user);

      expect(view).toMatchObject({ state: 'RUNNING', startedAt: running.startedAt });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(proxy.prepareSchedule).not.toHaveBeenCalled();
    });

    it('takes over an analysis that has been RUNNING for longer than any lasts: its process went away', async () => {
      const stale = runningSuggestions(new Date(Date.now() - 10 * 60 * 1000));
      tx.optimizationJob!.findUnique!.mockResolvedValue({ ...refused, suggestions: stale });

      await service.start(JOB_ID, user);
      await service.settled();

      expect(proxy.callAiEngine).toHaveBeenCalledTimes(1);
    });

    it('starts again after one that ended, whatever it said', async () => {
      tx.optimizationJob!.findUnique!.mockResolvedValue({ ...refused, suggestions: { ...runningSuggestions(new Date()), state: 'FAILED', failure: 'ENGINE_FAILED', finishedAt: new Date().toISOString() } });
      await service.start(JOB_ID, user);
      await service.settled();
      expect(proxy.callAiEngine).toHaveBeenCalledTimes(1);
    });

    it('treats a claim another press won first as that press\'s answer', async () => {
      tx.$executeRaw.mockImplementation(async (statement: unknown) => (((statement as Prisma.Sql).sql ?? '').includes('UPDATE "OptimizationJobs"') ? 0 : 1));
      const winner = runningSuggestions(new Date());
      tx.optimizationJob!.findUnique!.mockResolvedValueOnce(refused).mockResolvedValueOnce({ suggestions: winner });

      const view = await service.start(JOB_ID, user);

      expect(view.startedAt).toBe(winner.startedAt);
      expect(proxy.prepareSchedule).not.toHaveBeenCalled();
    });
  });

  describe('the request to the engine', () => {
    it("is Generera's own fetch with the school's rules, the analysis's search and deadline, and its own wait", async () => {
      const rules = { lunchStartTime: '11:00:00', lunchEndTime: '13:00:00', lunchMinutes: 30 };
      proxy.prepareSchedule.mockResolvedValue(ready({ storedRules: rules }));

      await service.start(JOB_ID, user);
      await service.settled();

      expect(proxy.prepareSchedule).toHaveBeenCalledWith(tx, YEAR_ID, user, { requestId: expect.any(String) });
      expect(proxy.callAiEngine).toHaveBeenCalledWith(
        SUGGEST_CHANGES_PATH,
        { ...payload, rules, search: { maxSeconds: SUGGEST_SEARCH_SECONDS, workers: SUGGEST_WORKERS }, deadlineSeconds: SUGGEST_DEADLINE_SECONDS },
        anonMaps,
        { timeoutMs: SUGGEST_WAIT_MS },
      );
      expect(proxy.callAiEngine.mock.calls[0]![1]).not.toHaveProperty('relaxation');
    });

    it('sends no `rules` key for a school with none', async () => {
      await service.start(JOB_ID, user);
      await service.settled();
      expect(Object.keys(proxy.callAiEngine.mock.calls[0]![1] as object)).not.toContain('rules');
    });

    it('keeps the engine\'s wait inside the API\'s and the deadline inside the wait', () => {
      expect(SUGGEST_DEADLINE_SECONDS * 1000).toBeLessThan(SUGGEST_WAIT_MS);
      // The engine's own ceiling for the route (search + the check's 30 s + two builds' 60 s) leaves the margin before the wait.
      expect((SUGGEST_SEARCH_SECONDS + 30 + 60) * 1000).toBeLessThan(SUGGEST_WAIT_MS);
    });
  });

  describe('what is written', () => {
    it('is the engine\'s list as the column keeps it: realised, ranked, whitelisted, and only over the analysis this call started', async () => {
      const view = await service.start(JOB_ID, user);
      await service.settled();

      const write = columnCalls()[1]!;
      const sql = write[0] as Prisma.Sql;
      expect(sql.sql).toContain(`"suggestions"->>'state' = 'RUNNING'`);
      expect(sql.sql).toContain(`"suggestions"->>'startedAt' =`);
      expect(sql.values).toContain(view.startedAt);
      expect(sql.values).toContain(JOB_ID);
      const stored = writtenBy(write);
      expect(suggestionsOf(stored)).toEqual(stored);
      expect(stored).toMatchObject({ state: 'DONE', verdict: 'CHANGES', verified: true, total: 1, startedAt: view.startedAt });
      expect(stored.changes[0]).toMatchObject({ rule: 'TEACHER_DAILY_CAP', proof: 'SOLVED', current: 300, needed: 330, resourceIds: [RULE], teacherIds: [TEACHER] });
      // The write is a second transaction: the engine was asked between the two.
      expect(prisma.withRls.mock.invocationCallOrder[1]).toBeLessThan(proxy.callAiEngine.mock.invocationCallOrder[0]!);
      expect(prisma.withRls.mock.invocationCallOrder[2]).toBeGreaterThan(proxy.callAiEngine.mock.invocationCallOrder[0]!);
    });

    it('keeps what the engine says of the least value, and hides it with `needed` for a part-timer\'s days (g493-L-5)', async () => {
      proxy.callAiEngine.mockResolvedValue(
        answer({
          changes: [
            { rule: 'TEACHER_DAILY_CAP', cost: 168, current: 300, needed: 330, neededIsLeast: true, weekdays: [3], requirementIds: [], roomIds: [], resourceIds: [ANON_RULE], proof: 'SOLVED_TOGETHER' },
            { rule: 'TEACHER_WORK_DAYS', cost: 1200, current: 3, needed: 4, neededIsLeast: true, weekdays: [2], requirementIds: [], roomIds: [], resourceIds: [], proof: 'SOLVED_TOGETHER' },
          ],
        }),
      );
      await service.start(JOB_ID, user);
      await service.settled();

      const stored = writtenBy(columnCalls()[1]!);
      expect(stored.changes.find((change) => change.rule === 'TEACHER_DAILY_CAP')).toMatchObject({ needed: 330, neededIsLeast: true });
      expect(stored.changes.find((change) => change.hidden)).toMatchObject({ rule: 'TEACHER_WORK_DAYS', needed: null, neededIsLeast: null });
    });

    it('keeps the account of where a NOT_FOUND\'s time went, through the same whitelist as a run\'s', async () => {
      const report = {
        totalSeconds: 71.2, budgetSeconds: 60, configuredBudgetSeconds: 60, callerWaitSeconds: 195,
        stages: [{ stage: 'BUILD', seconds: 9.4 }, { stage: 'SEARCH_CLEAN', seconds: 60 }],
        search: { solutions: 0, phases: [{ phase: 'CLEAN', seconds: 60, conflicts: 1834, branches: 20113 }] },
        weekLoadCut: false,
      };
      proxy.callAiEngine.mockResolvedValue(answer({ verdict: 'NOT_FOUND', changes: [], verified: false, report }));
      await service.start(JOB_ID, user);
      await service.settled();

      expect(writtenBy(columnCalls()[1]!)).toMatchObject({ state: 'DONE', verdict: 'NOT_FOUND', report });
    });

    it('realises through the proxy\'s own maps', async () => {
      await service.start(JOB_ID, user);
      await service.settled();
      expect(proxy.realiserOf).toHaveBeenCalledWith(anonMaps);
    });
  });

  describe('every way out writes the column', () => {
    const outcomeOf = async (): Promise<SuggestionsStored> => {
      await service.start(JOB_ID, user);
      await service.settled();
      return writtenBy(columnCalls()[1]!);
    };

    it.each([
      ['an engine older than the route (404)', 404, 'ENGINE_LACKS_SUGGESTIONS'],
      ['an engine older than the route (405)', 405, 'ENGINE_LACKS_SUGGESTIONS'],
      ['an engine that is busy (429)', 429, 'ENGINE_BUSY'],
      ['an engine that failed (500)', 500, 'ENGINE_FAILED'],
      ['an engine that is down (503)', 503, 'ENGINE_FAILED'],
    ])('says %s as %s', async (_name, status, failure) => {
      proxy.callAiEngine.mockRejectedValue(http(status));
      expect(await outcomeOf()).toMatchObject({ state: 'FAILED', failure, changes: [] });
    });

    it('says a refusal of the engine\'s hard rules (400) as the answer: no change of the five can help', async () => {
      proxy.callAiEngine.mockRejectedValue(http(400));
      expect(await outcomeOf()).toMatchObject({ state: 'DONE', verdict: 'HARD_REFUSAL', failure: null, changes: [], verified: false });
    });

    it('says an error that is not an HTTP one as a failure, and nothing of it', async () => {
      proxy.callAiEngine.mockRejectedValue(new Error('socket: secret detail'));
      const stored = await outcomeOf();
      expect(stored).toMatchObject({ state: 'FAILED', failure: 'ENGINE_FAILED' });
      expect(JSON.stringify(stored)).not.toContain('secret');
    });

    it('says a fetch that failed as a failure', async () => {
      proxy.prepareSchedule.mockRejectedValue(new Error('read failed'));
      expect(await outcomeOf()).toMatchObject({ state: 'FAILED', failure: 'ENGINE_FAILED' });
      expect(proxy.callAiEngine).not.toHaveBeenCalled();
    });

    it('says a week the gateway\'s own pre-flight refuses as a refusal, without asking the engine', async () => {
      proxy.prepareSchedule.mockResolvedValue({ ready: false, refusalCode: 'STAFF_UNSTAFFED_REQUIREMENTS', refusal: { conflicts: null } });
      expect(await outcomeOf()).toMatchObject({ state: 'DONE', verdict: 'HARD_REFUSAL' });
      expect(proxy.callAiEngine).not.toHaveBeenCalled();
    });

    it('says a year with every post hand-placed as having nothing to place, without asking the engine', async () => {
      proxy.prepareSchedule.mockResolvedValue(ready({ payload: { ...payload, requirements: [] } }));
      expect(await outcomeOf()).toMatchObject({ state: 'FAILED', failure: 'NOTHING_TO_PLACE' });
      expect(proxy.callAiEngine).not.toHaveBeenCalled();
    });

    it('does not let a write that fails take the process down: the column is then left to read as abandoned', async () => {
      let updates = 0;
      tx.$executeRaw.mockImplementation(async (statement: unknown) => {
        if (!((statement as Prisma.Sql).sql ?? '').includes('UPDATE "OptimizationJobs"')) return 1;
        if (++updates === 2) throw new Error('database went away');
        return 1;
      });
      await service.start(JOB_ID, user);
      await expect(service.settled()).resolves.toBeUndefined();
      expect(Logger.prototype.error).toHaveBeenCalled();
    });
  });

  describe('a press over a finished analysis (g385-L-5)', () => {
    const listed = suggestionsFromEngine(answer(), realiser, '2027-03-05T10:00:00.000Z', new Date('2027-03-05T10:01:30.000Z'));

    /**
     * The press, the engine's end of it, and what the column holds after: the first read is the run as it stands, the read in the write
     * sees what the claim wrote (the column moves between the two, as it does for real).
     */
    async function pressOver(held: unknown, engine: () => Promise<AiEngineSuggestChangesResponse>) {
      tx.optimizationJob!.findUnique!.mockImplementation(async () => ({
        ...refused,
        suggestions: columnCalls().length === 0 ? held : writtenBy(columnCalls()[0]!),
      }));
      proxy.callAiEngine.mockImplementation(engine);
      await service.start(JOB_ID, user);
      await service.settled();
      return { claimed: writtenBy(columnCalls()[0]!), written: writtenBy(columnCalls()[1]!) };
    }

    it('keeps the finished analysis inside the running one, and gives it back when the engine says it is busy', async () => {
      const { claimed, written } = await pressOver(listed, async () => {
        throw http(HttpStatus.TOO_MANY_REQUESTS);
      });
      expect(claimed).toMatchObject({ state: 'RUNNING', previous: { state: 'DONE', verdict: 'CHANGES', previous: null } });
      // The failure never replaced the list the school could use: the column is the list again.
      expect(written).toEqual(listed);
    });

    it('gives it back when the new analysis found nothing in its time, and when it failed in any other way', async () => {
      const notFound = await pressOver(listed, async () => answer({ verdict: 'NOT_FOUND', changes: [], verified: false }));
      expect(notFound.written).toEqual(listed);
      tx.$executeRaw.mockClear();
      const failed = await pressOver(listed, async () => {
        throw new Error('the engine fell over');
      });
      expect(failed.written).toEqual(listed);
    });

    it('takes the new analysis when it has a list of its own, or a refusal by a rule that never gives way', async () => {
      const fresh = await pressOver(listed, async () =>
        answer({ changes: [{ rule: 'SUBJECT_PER_DAY', cost: 20, current: 1, needed: 2, weekdays: [1], requirementIds: [], roomIds: [], resourceIds: [], proof: 'SOLVED' }] }),
      );
      expect(fresh.written).toMatchObject({ state: 'DONE', verdict: 'CHANGES', previous: null });
      expect(fresh.written.changes[0]!.rule).toBe('SUBJECT_PER_DAY');
      tx.$executeRaw.mockClear();
      proxy.prepareSchedule.mockResolvedValueOnce({ ready: false, refusalCode: 'STAFF_UNSTAFFED_REQUIREMENTS', refusal: { conflicts: null } });
      const refusedNow = await pressOver(listed, async () => answer());
      expect(refusedNow.written).toMatchObject({ state: 'DONE', verdict: 'HARD_REFUSAL', previous: null });
    });

    it('keeps nothing over an analysis that failed or found nothing: a failure over a failure is a failure', async () => {
      const failedBefore = failedSuggestions('2027-03-05T09:00:00.000Z', 'ENGINE_FAILED', new Date('2027-03-05T09:01:00.000Z'));
      const { claimed, written } = await pressOver(failedBefore, async () => {
        throw http(HttpStatus.TOO_MANY_REQUESTS);
      });
      expect(claimed.previous).toBeNull();
      expect(written).toMatchObject({ state: 'FAILED', failure: 'ENGINE_BUSY' });
    });

    it('hands on what an abandoned press was asked over, and keeps nothing for the press that took its place', async () => {
      const abandoned = { ...runningSuggestions(new Date(Date.now() - 20 * 60 * 1000), listed) };
      const { claimed } = await pressOver(abandoned, async () => answer());
      expect(claimed.previous).toMatchObject({ state: 'DONE', verdict: 'CHANGES' });
    });
  });

  describe('its lease (g385-L-4)', () => {
    const sqlOf = (call: unknown[]): string => ((call[0] as Prisma.Sql).sql ?? '').replace(/\s+/g, ' ');
    /** The statements that renew the lease: they set it with jsonb_set over the column and write nothing else. */
    const renewals = (): unknown[][] => columnCalls().filter((call) => sqlOf(call).startsWith('UPDATE "OptimizationJobs" SET "suggestions" = jsonb_set("suggestions"'));
    /** An engine call that answers when the test says so. */
    function engineHeldOpen() {
      let release!: (value: AiEngineSuggestChangesResponse) => void;
      proxy.callAiEngine.mockImplementation(() => new Promise<AiEngineSuggestChangesResponse>((resolve) => (release = resolve)));
      return { release: (value: AiEngineSuggestChangesResponse = answer()) => release(value) };
    }

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('takes the place with a lease from the database\'s clock, and only where the place is free', async () => {
      await service.start(JOB_ID, user);
      await service.settled();
      const claim = columnCalls()[0]!;
      const text = sqlOf(claim);
      expect(text).toContain(`jsonb_set(`);
      expect(text).toContain(`'{leaseUntil}'`);
      expect(text).toContain(`to_char((now() + make_interval(secs =>`);
      expect((claim[0] as Prisma.Sql).values).toContain(ANALYSIS_LEASE_SECONDS);
      // Free: no analysis, one that ended, or one that holds no longer. Held is judged by the lease, or by the start for one with none.
      expect(text).toContain(`"suggestions" IS NULL OR "suggestions"->>'state' <> 'RUNNING' OR NOT (CASE WHEN "suggestions"->>'leaseUntil' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'`);
      expect(text).toContain(`("suggestions"->>'leaseUntil') COLLATE "C" >= to_char(now() AT TIME ZONE 'UTC'`);
      expect(text).not.toContain('::timestamptz');
    });

    it('renews it every half minute while the engine works, over its own analysis, and stops when it has an answer', async () => {
      const engine = engineHeldOpen();
      await service.start(JOB_ID, user);
      const startedAt = writtenBy(columnCalls()[0]!).startedAt;
      expect(renewals()).toHaveLength(0);

      await jest.advanceTimersByTimeAsync(ANALYSIS_HEARTBEAT_MS * 2);
      expect(renewals()).toHaveLength(2);
      const renewal = renewals()[0]![0] as Prisma.Sql;
      expect(sqlOf(renewals()[0]!)).toContain(`"suggestions"->>'state' = 'RUNNING' AND "suggestions"->>'startedAt' =`);
      expect(renewal.values).toEqual(expect.arrayContaining([JOB_ID, startedAt, ANALYSIS_LEASE_SECONDS]));
      expect(prisma.withRls).toHaveBeenLastCalledWith(user, expect.any(Function));

      engine.release();
      await service.settled();
      const writes = columnCalls().length;
      await jest.advanceTimersByTimeAsync(ANALYSIS_HEARTBEAT_MS * 4);
      expect(columnCalls()).toHaveLength(writes);
      expect(writtenBy(columnCalls()[columnCalls().length - 1]!)).toMatchObject({ state: 'DONE', startedAt });
    });

    it('renews at least three times within one lease, so that one renewal that fails (a full pool) is not an abandonment', async () => {
      // The comment on ANALYSIS_LEASE_SECONDS promises it, and nothing else holds the two numbers together: a beat as long as the lease
      // abandons an analysis that is alive, the first time its engine call takes longer than the beat.
      const engine = engineHeldOpen();
      await service.start(JOB_ID, user);
      await jest.advanceTimersByTimeAsync(ANALYSIS_LEASE_SECONDS * 1000 - 1);
      expect(renewals().length).toBeGreaterThanOrEqual(3);
      engine.release();
      await service.settled();
    });

    it('lets a renewal that fails cost nothing: the analysis goes on, and the failure is said', async () => {
      const engine = engineHeldOpen();
      tx.$executeRaw.mockImplementation(async (statement: unknown) => {
        if (sqlOf([statement]).startsWith('UPDATE "OptimizationJobs" SET "suggestions" = jsonb_set("suggestions"')) throw new Error('pool is full');
        return 1;
      });
      await service.start(JOB_ID, user);
      await jest.advanceTimersByTimeAsync(ANALYSIS_HEARTBEAT_MS);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('lease not renewed'));
      engine.release();
      await expect(service.settled()).resolves.toBeUndefined();
      expect(writtenBy(columnCalls()[columnCalls().length - 1]!)).toMatchObject({ state: 'DONE' });
    });

    it('does not start a renewal while the last one is still being written: a full pool is not given more to wait for', async () => {
      const engine = engineHeldOpen();
      let stuck = 0;
      tx.$executeRaw.mockImplementation(async (statement: unknown) => {
        if (sqlOf([statement]).startsWith('UPDATE "OptimizationJobs" SET "suggestions" = jsonb_set("suggestions"')) {
          stuck += 1;
          return new Promise<number>(() => undefined);
        }
        return 1;
      });
      await service.start(JOB_ID, user);
      await jest.advanceTimersByTimeAsync(ANALYSIS_HEARTBEAT_MS * 5);
      expect(stuck).toBe(1);
      engine.release();
      await service.settled();
    });

    it('ends its analyses at once when the service is asked to stop, under the administrator who asked, and renews nothing after', async () => {
      const engine = engineHeldOpen();
      await service.start(JOB_ID, user);
      const startedAt = writtenBy(columnCalls()[0]!).startedAt;
      prisma.withRls.mockClear();

      await service.onModuleDestroy();

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      const ended = writtenBy(columnCalls()[columnCalls().length - 1]!);
      expect(ended).toMatchObject({ state: 'FAILED', failure: 'ABANDONED', startedAt, leaseUntil: null });
      const statements = columnCalls().length;
      await jest.advanceTimersByTimeAsync(ANALYSIS_HEARTBEAT_MS * 3);
      expect(columnCalls()).toHaveLength(statements);
      // The engine's late answer still goes through the write, which is only over a RUNNING analysis with this start (the column's own test).
      engine.release();
      await service.settled();
    });

    it('has nothing to end when nothing is running', async () => {
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
      expect(columnCalls()).toHaveLength(0);
    });

    it('lets a restart end an analysis that had been asked over a finished one, and gives that one back', async () => {
      const listed = suggestionsFromEngine(answer(), realiser, '2027-03-05T10:00:00.000Z', new Date('2027-03-05T10:01:30.000Z'));
      tx.optimizationJob!.findUnique!.mockImplementation(async () => ({
        ...refused,
        suggestions: columnCalls().length === 0 ? listed : writtenBy(columnCalls()[0]!),
      }));
      engineHeldOpen();
      await service.start(JOB_ID, user);
      await service.onModuleDestroy();
      expect(writtenBy(columnCalls()[columnCalls().length - 1]!)).toEqual(listed);
    });

    it('answers a second press with the analysis that holds its place, and takes the place of one whose lease has run out', async () => {
      const held = runningSuggestions(new Date());
      tx.optimizationJob!.findUnique!.mockResolvedValue({ ...refused, suggestions: held });
      const same = await service.start(JOB_ID, user);
      expect(same.state).toBe('RUNNING');
      expect(columnCalls()).toHaveLength(0);
      expect(proxy.prepareSchedule).not.toHaveBeenCalled();

      jest.setSystemTime(Date.now() + ANALYSIS_LEASE_SECONDS * 1000 + 1);
      await service.start(JOB_ID, user);
      await service.settled();
      expect(columnCalls().length).toBeGreaterThan(0);
      expect(proxy.prepareSchedule).toHaveBeenCalledTimes(1);
    });
  });

  describe('failureOf', () => {
    it.each([
      [http(HttpStatus.NOT_FOUND), 'ENGINE_LACKS_SUGGESTIONS'],
      [http(HttpStatus.METHOD_NOT_ALLOWED), 'ENGINE_LACKS_SUGGESTIONS'],
      [http(HttpStatus.TOO_MANY_REQUESTS), 'ENGINE_BUSY'],
      [http(HttpStatus.BAD_REQUEST), 'REFUSED'],
      [http(HttpStatus.UNPROCESSABLE_ENTITY), 'ENGINE_FAILED'],
      [http(HttpStatus.SERVICE_UNAVAILABLE), 'ENGINE_FAILED'],
      [new Error('x'), 'ENGINE_FAILED'],
      ['x', 'ENGINE_FAILED'],
    ])('says %#', (error, said) => {
      expect(failureOf(error)).toBe(said);
    });
  });
});
