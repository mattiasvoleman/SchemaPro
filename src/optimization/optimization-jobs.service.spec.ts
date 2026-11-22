import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const { DbNull } = Prisma;

import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../database/prisma.service';
import type {
  AiEngineLesson,
  AiEngineScheduleResponse,
} from './interfaces/ai-engine-payload.interface';
import { OptimizationJobsService, jobView } from './optimization-jobs.service';
import {
  ABANDONED_MESSAGE,
  ENGINE_RUN_ABANDONED,
  GENERATE_ALREADY_RUNNING,
  GENERATE_SWEEP_INTERVAL_MS,
  GENERATE_SWEEP_JOB,
  HEARTBEAT_INTERVAL_MS,
  INSTANCE_NAME,
  INTERRUPTED_MESSAGE,
} from './generate-runs';
import type { OptimizationProxyService } from './optimization-proxy.service';
import { recordedReads } from '../../test/utils/recorded-reads';
import {
  CONSECUTIVE_TEACHING_HIDDEN_MESSAGE,
  TEACHER_WORK_DAYS_HIDDEN,
  WORK_DAYS_HIDDEN_MESSAGE,
  WorkDaysRefusal,
} from './work-days';

const JOB_ID = '66666666-6666-4666-8666-666666666666';
const YEAR_ID = '44444444-4444-4444-8444-444444444444';

describe('OptimizationJobsService', () => {
  let service: OptimizationJobsService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let proxy: { triggerScheduling: jest.Mock };

  const lesson = (): AiEngineLesson => ({
    requirementId: 'anon-req',
    roomId: null,
    dayOfWeek: 1,
    startTime: '08:00:00',
    endTime: '09:00:00',
  });

  const engineResponse = (
    overrides: Partial<AiEngineScheduleResponse> = {},
  ): AiEngineScheduleResponse => ({
    requestId: 'req-1',
    status: 'OPTIMAL',
    lessons: [],
    conflicts: null,
    ...overrides,
  });

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    proxy = { triggerScheduling: jest.fn().mockResolvedValue(engineResponse()) };
    tx.optimizationJob.create.mockResolvedValue({ id: JOB_ID });
    tx.optimizationJob.update.mockResolvedValue({});
    // The run's heartbeats and its first claim are one compare-and-set each:
    // one row updated says the run is still active and the process's own.
    tx.$executeRaw.mockResolvedValue(1);
    service = new OptimizationJobsService(
      proxy as unknown as OptimizationProxyService,
      prisma as unknown as PrismaService,
    );
  });

  /**
   * `start` kicks off `run` as fire-and-forget (`void this.run(...)`). The
   * whole chain is promise-driven against already-resolved mocks, so one
   * macrotask turn drains it completely.
   */
  const flushBackgroundRun = () =>
    new Promise((resolve) => setImmediate(resolve));

  describe('start', () => {
    it('404s when the token carries no school context, before any query', async () => {
      const attempt = service.start(YEAR_ID, testUser({ schoolId: undefined }));

      await expect(attempt).rejects.toThrow(NotFoundException);
      await expect(attempt).rejects.toThrow('School context missing from token.');
      expect(prisma.withRls).not.toHaveBeenCalled();
      expect(proxy.triggerScheduling).not.toHaveBeenCalled();
    });

    it('creates a PENDING job scoped to the principal and returns its id', async () => {
      const user = testUser({ schoolId: 'school-A', userId: 'admin-1' });

      await expect(service.start(YEAR_ID, user)).resolves.toEqual({
        jobId: JOB_ID,
      });

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.optimizationJob.create).toHaveBeenCalledWith({
        data: {
          schoolId: 'school-A',
          academicYearId: YEAR_ID,
          actorId: 'admin-1',
          status: 'PENDING',
          weights: undefined,
        },
        select: { id: true },
      });
    });

    it('stores the requested weights on the job row', async () => {
      await service.start(YEAR_ID, testUser(), { spread: 5 });

      expect(tx.optimizationJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ weights: { spread: 5 } }),
        }),
      );
    });

    it('refuses 409 CANDIDATES_RUNNING while the year has a live schemaförslag run, before any job row', async () => {
      // The question is the candidate run's own: active and inside its lease
      // and its half hour (yearHasActiveCandidateRun), under the caller's RLS.
      tx.$queryRaw.mockImplementation(async (sql: { strings: string[] }) =>
        sql.strings.join('?').includes('"ScheduleCandidateRuns"') ? [{ active: 1 }] : [],
      );

      const attempt = service.start(YEAR_ID, testUser());
      await expect(attempt).rejects.toThrow(HttpException);
      await expect(attempt).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: 'CANDIDATES_RUNNING' }),
      });
      const sql = tx.$queryRaw.mock.calls
        .map(([call]) => call as { strings: string[]; values: unknown[] })
        .find((call) => call.strings.join('?').includes('"ScheduleCandidateRuns"')) as { strings: string[]; values: unknown[] };
      expect(sql.values).toEqual([YEAR_ID]);
      expect(sql.strings.join('?')).toContain(`"heartbeatAt" + make_interval(secs => "leaseSeconds") >= now()`);
      expect(tx.optimizationJob.create).not.toHaveBeenCalled();
      expect(proxy.triggerScheduling).not.toHaveBeenCalled();
    });

    it('asks under the year’s start lock, which a candidate start takes too, so two clicks cannot pass beside each other', async () => {
      const order: string[] = [];
      const textOf = (statement: unknown): string =>
        Array.isArray(statement) ? statement.join('?') : (statement as { strings: string[] }).strings.join('?');
      tx.$executeRaw.mockImplementation(async (statement: unknown) => {
        order.push(textOf(statement));
        return 1;
      });
      tx.$queryRaw.mockImplementation(async (statement: unknown) => {
        const text = textOf(statement);
        if (text.includes('optimization_jobs_sweep')) {
          order.push('sweep');
          return [{ changed: 0 }];
        }
        order.push('check');
        return [{ active: 0 }];
      });

      await service.start(YEAR_ID, testUser());

      // The sweep first, in a transaction of its own; then the lock and the check; the insert; and only then the
      // run's first heartbeat.
      expect(order.slice(0, 4)).toEqual([
        'sweep',
        "SET LOCAL lock_timeout = '5s'",
        "SELECT pg_advisory_xact_lock(hashtext('grundschema-solve-start'), hashtext(?::uuid::text))",
        'check',
      ]);
      expect(tx.optimizationJob.create).toHaveBeenCalledTimes(1);
    });

    it('starts beside no candidate run, or one past its lease', async () => {
      tx.$queryRaw.mockResolvedValue([{ active: 0 }]);
      await expect(service.start(YEAR_ID, testUser())).resolves.toEqual({ jobId: JOB_ID });
    });

    it('records a null actor when the token has no userId', async () => {
      await service.start(YEAR_ID, testUser({ userId: undefined }));

      expect(tx.optimizationJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ actorId: null }),
        }),
      );
    });

    it('passes weights and rules through to the solver proxy', async () => {
      const user = testUser();
      const weights = { disruption: 10 };
      const rules = { lunchMinutes: 30 };

      await service.start(YEAR_ID, user, weights, rules);
      await flushBackgroundRun();

      expect(proxy.triggerScheduling).toHaveBeenCalledWith(
        YEAR_ID,
        user,
        weights,
        rules,
      );
    });

    it('normalises omitted weights and rules to null for the proxy', async () => {
      await service.start(YEAR_ID, testUser());
      await flushBackgroundRun();

      expect(proxy.triggerScheduling).toHaveBeenCalledWith(
        YEAR_ID,
        testUser(),
        null,
        null,
      );
    });

    it('marks the job RUNNING before the solver call and SUCCEEDED after', async () => {
      proxy.triggerScheduling.mockResolvedValue(
        engineResponse({
          status: 'FEASIBLE',
          lessons: [lesson(), lesson(), lesson()],
          conflicts: {
            summary: '1 group collides',
            summaryCode: 'GROUP_COLLIDES',
            summaryParams: { count: 1 },
            conflicts: [
              {
                category: 'GROUP_OVERLAP',
                code: 'GROUP_OVERLAPS_ITSELF',
                params: { group: '4A' },
                message: 'Group overlaps itself',
                requirementIds: ['anon-1'],
                roomIds: [],
                constraintIds: [],
                resourceIds: ['anon-2'],
              },
            ],
          },
        }),
      );

      await service.start(YEAR_ID, testUser());
      await flushBackgroundRun();

      // RUNNING is the first heartbeat: the claim and the lease in one compare-and-set, before the solver call.
      const beat = tx.$executeRaw.mock.calls.find(([call]) => (call as { strings?: string[] }).strings?.join('?').includes(`SET "status" = 'RUNNING'`));
      expect(beat).toBeDefined();
      expect(tx.optimizationJob.update).toHaveBeenCalledTimes(1);
      expect(tx.optimizationJob.update).toHaveBeenNthCalledWith(1, {
        where: { id: JOB_ID },
        data: {
          status: 'SUCCEEDED',
          solverStatus: 'FEASIBLE',
          lessonsGenerated: 3,
          conflictSummary: '1 group collides',
          conflictSummaryCode: 'GROUP_COLLIDES',
          conflictSummaryParams: { count: 1 },
          // Category, message and the names survive; the id arrays from the
          // engine's conflict details must not be persisted on the job row.
          conflicts: [
            {
              category: 'GROUP_OVERLAP',
              code: 'GROUP_OVERLAPS_ITSELF',
              params: { group: '4A' },
              message: 'Group overlaps itself',
              resourceNames: [],
            },
          ],
          // Every wish kept, or none stated: null, as on every run before.
          notes: DbNull,
          // What a sweep or a restart said of the run while it was going is taken back: what happened wins.
          error: null,
          errorCode: null,
          errorParams: DbNull,
          // Only a TIMEOUT carries an account of its time (timeout-report.ts).
          report: DbNull,
          finishedAt: expect.any(Date),
        },
      });
    });

    describe('where a run that ran out of time spent it (omgång 13, M2)', () => {
      const report = {
        totalSeconds: 109,
        budgetSeconds: 100,
        configuredBudgetSeconds: 100,
        callerWaitSeconds: null,
        stages: [
          { stage: 'PRECHECKS', seconds: 0.4 },
          { stage: 'BUILD', seconds: 4 },
          { stage: 'SEARCH_CLEAN', seconds: 60 },
          { stage: 'SEARCH_CLONE', seconds: 40 },
          { stage: 'PROBE', seconds: 5 },
        ],
        search: { solutions: 0, phases: [{ phase: 'CLEAN', seconds: 60, conflicts: 118344, branches: null }] },
        weekLoadCut: false,
      };
      const lastWrite = () => tx.optimizationJob.update.mock.calls.at(-1)![0].data as { report: unknown };

      it('stores the engine’s report, rebuilt from the names it may hold, when the answer is a TIMEOUT', async () => {
        proxy.triggerScheduling.mockResolvedValue(
          engineResponse({ status: 'TIMEOUT', lessons: [], report: { ...report, injected: 'x'.repeat(500), search: { ...report.search, extra: 1 } } }),
        );

        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();

        expect(lastWrite().report).toEqual(report);
        expect(JSON.stringify(lastWrite().report)).not.toContain('injected');
      });

      it.each(['FEASIBLE', 'OPTIMAL', 'INFEASIBLE'])('stores none for a %s answer, even from an engine that sent one', async (status) => {
        proxy.triggerScheduling.mockResolvedValue(engineResponse({ status: status as 'FEASIBLE', lessons: [], report }));

        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();

        expect(lastWrite().report).toBe(DbNull);
      });

      it('stores none for a TIMEOUT from an engine older than the field, and for a report that is not wholly well formed', async () => {
        proxy.triggerScheduling.mockResolvedValueOnce(engineResponse({ status: 'TIMEOUT', lessons: [] }));
        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();
        expect(lastWrite().report).toBe(DbNull);

        proxy.triggerScheduling.mockResolvedValueOnce(
          engineResponse({ status: 'TIMEOUT', lessons: [], report: { ...report, stages: [{ stage: 'THINKING', seconds: 1 }] } }),
        );
        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();
        expect(lastWrite().report).toBe(DbNull);
      });
    });

    it('stores an empty conflict list when the solver reports none', async () => {
      await service.start(YEAR_ID, testUser());
      await flushBackgroundRun();

      expect(tx.optimizationJob.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'SUCCEEDED',
            conflictSummary: null,
            conflictSummaryCode: null,
            conflicts: [],
            lessonsGenerated: 0,
          }),
        }),
      );
    });

    it('records the failure message on the job row instead of throwing', async () => {
      proxy.triggerScheduling.mockRejectedValue(
        new Error('AI engine unavailable.'),
      );

      await service.start(YEAR_ID, testUser());
      await flushBackgroundRun();

      expect(tx.optimizationJob.update).toHaveBeenLastCalledWith({
        where: { id: JOB_ID },
        data: {
          status: 'FAILED',
          error: 'AI engine unavailable.',
          errorCode: null,
          errorParams: DbNull,
          finishedAt: expect.any(Date),
        },
      });
    });

    it('keeps the refusal\'s own name and values when the engine refuses the payload', async () => {
      // The engine refuses a payload it cannot schedule and names the reason;
      // the proxy throws that on as an HttpException whose body carries the
      // code and the values beside the English. Without them the screen has
      // nothing to render Swedish from, and an admin reads the fallback.
      proxy.triggerScheduling.mockRejectedValue(
        new HttpException(
          {
            message: 'Locked lessons leave student group 4A no 30-minute lunch break.',
            code: 'LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK',
            params: { group: '4A', minutes: 30, day: 2 },
          },
          400,
        ),
      );

      await service.start(YEAR_ID, testUser());
      await flushBackgroundRun();

      expect(tx.optimizationJob.update).toHaveBeenLastCalledWith({
        where: { id: JOB_ID },
        data: {
          status: 'FAILED',
          error: 'Locked lessons leave student group 4A no 30-minute lunch break.',
          errorCode: 'LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK',
          errorParams: { group: '4A', minutes: 30, day: 2 },
          finishedAt: expect.any(Date),
        },
      });
    });

    it('keeps no code for a failure of ours rather than of the school\'s data', async () => {
      // A lost connection to the engine has nothing for a school to act on and
      // nothing to translate; a Swedish sentence over it would be a promise
      // that the fault is theirs.
      proxy.triggerScheduling.mockRejectedValue(
        new HttpException('The AI engine returned an error.', 502),
      );

      await service.start(YEAR_ID, testUser());
      await flushBackgroundRun();

      expect(tx.optimizationJob.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            error: 'The AI engine returned an error.',
            errorCode: null,
          }),
        }),
      );
    });

    it('falls back to a generic message when the failure is not an Error', async () => {
      proxy.triggerScheduling.mockRejectedValue('boom');

      await service.start(YEAR_ID, testUser());
      await flushBackgroundRun();

      expect(tx.optimizationJob.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FAILED',
            error: 'The optimization run failed.',
          }),
        }),
      );
    });

    it('runs the create and every status update under the caller RLS session', async () => {
      const user = testUser({ schoolId: 'school-A' });

      await service.start(YEAR_ID, user);
      await flushBackgroundRun();

      // create + RUNNING + SUCCEEDED — three transactions, one principal.
      expect(prisma.withRls).toHaveBeenCalledTimes(3);
      for (const call of prisma.withRls.mock.calls) {
        expect(call[0]).toBe(user);
      }
    });
  });

  describe('run — failure containment', () => {
    // `run` is private and fire-and-forget; exercising its failure branches
    // through `start` would turn a deliberate rejection into an unhandled one
    // in the test process. Called directly so the promise is observable.
    const runPrivate = (user: AuthenticatedUser = testUser()) =>
      (
        service as unknown as {
          run: (
            jobId: string,
            academicYearId: string,
            user: AuthenticatedUser,
          ) => Promise<void>;
        }
      ).run(JOB_ID, YEAR_ID, user);

    it('resolves even when recording the FAILED status itself fails', async () => {
      proxy.triggerScheduling.mockRejectedValue(new Error('engine down'));
      tx.optimizationJob.update.mockRejectedValue(new Error('db down')); // the FAILED write also fails

      await expect(runPrivate()).resolves.toBeUndefined();
    });

    it('stores the exception’s own sentence, and no code, when a refusal’s message is a list', async () => {
      // A validation failure answers with a list of messages. That list is not
      // a sentence the screen can show, and it carries no code to translate:
      // the row keeps the exception's own message and says it has no code,
      // rather than an array in `error` or an `errorCode` left undefined.
      proxy.triggerScheduling.mockRejectedValue(
        new BadRequestException(['minutesPerLesson must fit the grid', 'lessonsPerWeek must be positive']),
      );

      await runPrivate();

      expect(tx.optimizationJob.update).toHaveBeenLastCalledWith({
        where: { id: JOB_ID },
        data: {
          status: 'FAILED',
          error: 'Bad Request Exception',
          errorCode: null,
          errorParams: DbNull,
          finishedAt: expect.any(Date),
        },
      });
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
    ])('still marks the job FAILED when a refusal carries a %s body', async (_label, body) => {
      /*
       * Reading the refusal happens inside run()'s catch. Were it to throw
       * there, the FAILED write below it would never run and the row would sit
       * at RUNNING for ever — the stranded job the class comment warns about,
       * reached through the one path meant to prevent it.
       */
      proxy.triggerScheduling.mockRejectedValue(new HttpException(body as never, 503));

      await expect(runPrivate()).resolves.toBeUndefined();

      expect(tx.optimizationJob.update).toHaveBeenLastCalledWith({
        where: { id: JOB_ID },
        data: {
          status: 'FAILED',
          error: 'Http Exception',
          errorCode: null,
          errorParams: DbNull,
          finishedAt: expect.any(Date),
        },
      });
    });

    it('marks the job FAILED when persisting the success result fails', async () => {
      tx.optimizationJob.update
        .mockRejectedValueOnce(new Error('conflicts write failed')) // SUCCEEDED
        .mockResolvedValueOnce({}); // FAILED

      await runPrivate();

      expect(tx.optimizationJob.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FAILED',
            error: 'conflicts write failed',
          }),
        }),
      );
    });

    it('records a failed first heartbeat on the job row instead of rejecting', async () => {
      // The RUNNING write (now the first heartbeat) once sat outside run()'s
      // try/catch, so its rejection escaped into `void this.run(...)` in
      // start() — an unhandled rejection, which Node answers by killing the API
      // for every school on the instance. It has to be contained like every
      // other failure in the run.
      tx.$executeRaw.mockRejectedValueOnce(new Error('db down')); // the first heartbeat
      tx.optimizationJob.update.mockResolvedValueOnce({}); // FAILED

      await expect(runPrivate()).resolves.toBeUndefined();

      expect(proxy.triggerScheduling).not.toHaveBeenCalled();
      expect(tx.optimizationJob.update).toHaveBeenLastCalledWith({
        where: { id: JOB_ID },
        data: {
          status: 'FAILED',
          error: 'db down',
          errorCode: null,
          errorParams: DbNull,
          finishedAt: expect.any(Date),
        },
      });
    });

    it('logs and swallows a crash that escapes run() rather than letting it kill the process', async () => {
      // Last line of defence for the same hazard: start() never awaits run(),
      // so anything that does escape it must be caught at the call site.
      const logger = jest
        .spyOn(
          (service as unknown as { logger: { error: (...args: unknown[]) => void } })
            .logger,
          'error',
        )
        .mockImplementation(() => undefined);
      jest
        .spyOn(service as unknown as { run: () => Promise<void> }, 'run')
        .mockRejectedValue(new Error('run itself threw'));

      await expect(service.start(YEAR_ID, testUser())).resolves.toEqual({
        jobId: JOB_ID,
      });
      await flushBackgroundRun();

      expect(logger).toHaveBeenCalledWith(
        `Optimization job ${JOB_ID} crashed outside its own error handling.`,
        expect.stringContaining('run itself threw'),
      );
    });
  });

  describe('the run as a queue entry', () => {
    const statementOf = (call: unknown): string =>
      Array.isArray(call) ? call.join('?') : ((call as { strings?: string[] }).strings ?? []).join('?');
    const beats = () => tx.$executeRaw.mock.calls.filter(([call]) => statementOf(call).includes(`SET "status" = 'RUNNING'`));
    const uniqueViolation = (shape: 'P2002' | 'adapter') =>
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: shape === 'P2002' ? 'P2002' : 'P2010',
        clientVersion: 'test',
        meta:
          shape === 'P2002'
            ? { target: ['schoolId', 'academicYearId'] }
            : { driverAdapterError: { cause: { originalCode: '23505', originalMessage: 'duplicate key' } } },
      });

    /** What the heartbeats answer in turn (the last one stays), every other raw statement of the start passing. */
    const heartbeatsAnswer = (...answers: Array<number | Error>) => {
      tx.$executeRaw.mockImplementation(async (call: unknown) => {
        if (!statementOf(call).includes(`SET "status" = 'RUNNING'`)) return 0;
        const next = answers.length > 1 ? answers.shift()! : answers[0]!;
        if (next instanceof Error) throw next;
        return next;
      });
    };

    afterEach(() => {
      jest.useRealTimers();
    });

    describe('one active run per year', () => {
      it.each([['P2002' as const], ['adapter' as const]])(
        'answers 409 GENERATE_ALREADY_RUNNING when the insert meets the partial unique index (%s), and runs nothing',
        async (shape) => {
          tx.optimizationJob.create.mockRejectedValue(uniqueViolation(shape));

          const attempt = service.start(YEAR_ID, testUser());

          await expect(attempt).rejects.toMatchObject({
            status: 409,
            response: expect.objectContaining({ code: GENERATE_ALREADY_RUNNING }),
          });
          await flushBackgroundRun();
          expect(proxy.triggerScheduling).not.toHaveBeenCalled();
          expect(beats()).toHaveLength(0);
          expect(service.running).toEqual([]);
        },
      );

      it('says it in Swedish in the body’s message, beside the code the page translates', async () => {
        tx.optimizationJob.create.mockRejectedValue(uniqueViolation('P2002'));
        await expect(service.start(YEAR_ID, testUser())).rejects.toMatchObject({
          response: { code: GENERATE_ALREADY_RUNNING, message: 'Generera kör redan för läsåret. Vänta tills körningen är klar.' },
        });
      });

      it('does not mistake another failure of the insert for it', async () => {
        tx.optimizationJob.create.mockRejectedValue(new Error('db down'));
        await expect(service.start(YEAR_ID, testUser())).rejects.toThrow('db down');
      });
    });

    describe('the sweep before a start', () => {
      it('runs in a transaction of its own, before the start’s own', async () => {
        await service.start(YEAR_ID, testUser());

        expect(prisma.withDeliveryService).toHaveBeenCalledTimes(1);
        expect(prisma.withDeliveryService.mock.invocationCallOrder[0]).toBeLessThan(prisma.withRls.mock.invocationCallOrder[0]);
        const sweep = tx.$queryRaw.mock.calls.map(([call]) => statementOf(call)).find((text) => text.includes('optimization_jobs_sweep'));
        expect(sweep).toContain('SELECT app.optimization_jobs_sweep()');
      });

      it('costs a start nothing when it fails: the partial index still holds the year', async () => {
        prisma.withDeliveryService.mockRejectedValueOnce(new Error('sweep down'));
        await expect(service.start(YEAR_ID, testUser())).resolves.toEqual({ jobId: JOB_ID });
      });
    });

    describe('the lease', () => {
      const engineThatNeverAnswers = () => {
        let answer!: (response: AiEngineScheduleResponse) => void;
        proxy.triggerScheduling.mockReturnValue(new Promise<AiEngineScheduleResponse>((resolve) => (answer = resolve)));
        return (response: AiEngineScheduleResponse = engineResponse()) => answer(response);
      };

      it('is taken in the first heartbeat, before the engine call: RUNNING, the claimant and the lease in one compare-and-set', async () => {
        Object.assign(proxy, { waitSeconds: 240 });
        const order: string[] = [];
        tx.$executeRaw.mockImplementation(async (call: unknown) => {
          if (statementOf(call).includes(`SET "status" = 'RUNNING'`)) order.push('beat');
          return 1;
        });
        proxy.triggerScheduling.mockImplementation(async () => {
          order.push('engine');
          return engineResponse();
        });

        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();

        expect(order).toEqual(['beat', 'engine']);
        const [call] = beats()[0] as [{ strings: string[]; values: unknown[] }];
        const text = call.strings.join('?');
        expect(text).toContain(`WHERE "id" = ?::uuid AND "status" IN ('PENDING', 'RUNNING')`);
        expect(text).toContain('"heartbeatAt" = now()');
        expect(text).toContain('"leaseUntil" = now() + make_interval(secs => ?)');
        // The claimant, the job, and the lease: the API's own wait for the engine, which must exceed the
        // engine's ceiling, and thirty seconds for its own steps.
        expect(call.values).toEqual([INSTANCE_NAME, 270, JOB_ID]);
      });

      it('follows the wait the API enforces, within the database’s bounds', async () => {
        Object.assign(proxy, { waitSeconds: 600 });
        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();
        expect((beats()[0]![0] as { values: unknown[] }).values[1]).toBe(630);
      });

      it('is renewed every half minute while the engine works, and stops being renewed when the run ends', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        Object.assign(proxy, { waitSeconds: 240 });
        const answer = engineThatNeverAnswers();

        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();
        expect(beats()).toHaveLength(1);
        expect(service.running).toEqual([JOB_ID]);

        await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS - 1);
        expect(beats()).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(beats()).toHaveLength(2);
        await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
        expect(beats()).toHaveLength(4);
        // Each renewal sets the lease again, to the same longest the engine can still be solving.
        expect(beats().map(([call]) => (call as { values: unknown[] }).values[1])).toEqual([270, 270, 270, 270]);

        answer();
        await flushBackgroundRun();
        expect(service.running).toEqual([]);
        await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 4);
        expect(beats()).toHaveLength(4);
      });

      it('stops renewing, and writes nothing, when a renewal finds the run no longer active', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        engineThatNeverAnswers();
        heartbeatsAnswer(1, 0);

        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();
        await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
        expect(beats()).toHaveLength(2);
        expect(service.running).toEqual([]);

        await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
        expect(beats()).toHaveLength(2);
        expect(tx.optimizationJob.update).not.toHaveBeenCalled();
      });

      it('costs one renewal when a renewal fails, not the run', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        engineThatNeverAnswers();
        heartbeatsAnswer(1, new Error('pool exhausted'), 1);

        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();
        await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);

        expect(beats()).toHaveLength(3);
        expect(service.running).toEqual([JOB_ID]);
        expect(tx.optimizationJob.update).not.toHaveBeenCalled();
      });

      it('runs nothing when the first heartbeat finds the run no longer active', async () => {
        heartbeatsAnswer(0);

        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();

        expect(proxy.triggerScheduling).not.toHaveBeenCalled();
        expect(tx.optimizationJob.update).not.toHaveBeenCalled();
        expect(service.running).toEqual([]);
      });

      it('never keeps the process alive', async () => {
        engineThatNeverAnswers();
        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();
        const { timer } = (service as unknown as { inFlight: Map<string, { timer: NodeJS.Timeout }> }).inFlight.get(JOB_ID)!;
        expect(timer.hasRef()).toBe(false);
        await service.onModuleDestroy();
      });
    });

    describe('a restart that can say so', () => {
      it('fails the runs in flight at once with ENGINE_RUN_ABANDONED, under the administrator who started each, and stops renewing', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        proxy.triggerScheduling.mockReturnValue(new Promise(() => undefined));
        const user = testUser({ userId: 'admin-1' });
        tx.optimizationJob.updateMany.mockResolvedValue({ count: 1 });
        await service.start(YEAR_ID, user);
        await flushBackgroundRun();
        prisma.withRls.mockClear();

        await service.onModuleDestroy();

        expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
        expect(tx.optimizationJob.updateMany).toHaveBeenCalledWith({
          where: { id: JOB_ID, status: { in: ['PENDING', 'RUNNING'] } },
          data: {
            status: 'FAILED',
            error: INTERRUPTED_MESSAGE,
            errorCode: ENGINE_RUN_ABANDONED,
            errorParams: DbNull,
            finishedAt: expect.any(Date),
          },
        });
        expect(service.running).toEqual([]);
        const before = beats().length;
        await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
        expect(beats()).toHaveLength(before);
      });

      it('only touches a run that is still active, so one that ended is left as it ended', async () => {
        proxy.triggerScheduling.mockReturnValue(new Promise(() => undefined));
        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();
        await service.onModuleDestroy();
        expect(tx.optimizationJob.updateMany.mock.calls[0]![0].where.status).toEqual({ in: ['PENDING', 'RUNNING'] });
      });

      it('has nothing to fail when no run is in flight, and still leaves the runner', async () => {
        const jobs = { register: jest.fn(), unregister: jest.fn(), isScheduled: jest.fn(), settled: jest.fn() };
        const withRunner = new OptimizationJobsService(
          proxy as unknown as OptimizationProxyService,
          prisma as unknown as PrismaService,
          undefined,
          jobs as never,
        );
        await withRunner.onModuleDestroy();
        expect(jobs.unregister).toHaveBeenCalledWith(GENERATE_SWEEP_JOB);
        expect(tx.optimizationJob.updateMany).not.toHaveBeenCalled();
      });

      it('survives a failed write: a restart must not hang on it', async () => {
        proxy.triggerScheduling.mockReturnValue(new Promise(() => undefined));
        tx.optimizationJob.updateMany.mockRejectedValue(new Error('db gone'));
        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();
        await expect(service.onModuleDestroy()).resolves.toBeUndefined();
      });
    });

    describe('the job in the gateway’s runner', () => {
      const runner = () => ({ register: jest.fn(), unregister: jest.fn(), isScheduled: jest.fn().mockReturnValue(true), settled: jest.fn() });
      const withRunner = (jobs: ReturnType<typeof runner>, background = true) =>
        new OptimizationJobsService(
          proxy as unknown as OptimizationProxyService,
          prisma as unknown as PrismaService,
          { get: () => ({ background }) } as never,
          jobs as never,
        );

      it('registers every five minutes when background jobs are on', () => {
        const jobs = runner();
        withRunner(jobs).onModuleInit();
        expect(jobs.register).toHaveBeenCalledWith({ name: GENERATE_SWEEP_JOB, intervalMs: GENERATE_SWEEP_INTERVAL_MS, tick: expect.any(Function) });
        expect(GENERATE_SWEEP_INTERVAL_MS).toBe(5 * 60 * 1000);
        expect(withRunner(jobs).scheduled).toBe(true);
      });

      it('registers nothing when CANDIDATES_BACKGROUND is off, or without a runner', () => {
        const jobs = runner();
        withRunner(jobs, false).onModuleInit();
        expect(jobs.register).not.toHaveBeenCalled();
        expect(() => service.onModuleInit()).not.toThrow();
        expect(service.scheduled).toBe(false);
      });

      it('records a pass with how many runs it failed', async () => {
        const jobs = runner();
        tx.$queryRaw.mockResolvedValue([{ changed: 2 }]);
        await withRunner(jobs).tick();
        expect(jobs.settled).toHaveBeenCalledWith(GENERATE_SWEEP_JOB, expect.any(Date), { ok: true, counts: { changed: 2 } });
      });

      it('never throws, and says how it failed by name only', async () => {
        const jobs = runner();
        tx.$queryRaw.mockRejectedValue(new TypeError('connection refused to db.example'));
        await expect(withRunner(jobs).tick()).resolves.toBeUndefined();
        expect(jobs.settled).toHaveBeenCalledWith(GENERATE_SWEEP_JOB, expect.any(Date), { ok: false, error: 'TypeError' });
      });

      it('lets a tick that finds the last pass still running wait for it', async () => {
        const jobs = runner();
        let finish!: (rows: unknown[]) => void;
        tx.$queryRaw.mockReturnValue(new Promise((resolve) => (finish = resolve)));
        const sweeper = withRunner(jobs);
        const first = sweeper.tick();
        const second = sweeper.tick();
        finish([{ changed: 0 }]);
        await Promise.all([first, second]);
        expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
        expect(jobs.settled).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('get', () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
      id: JOB_ID,
      status: 'SUCCEEDED',
      solverStatus: 'OPTIMAL',
      lessonsGenerated: 12,
      conflictSummary: null,
      conflicts: [{ category: 'ROOM_OVERLAP', message: 'clash' }],
      error: null,
      createdAt: new Date('2026-08-07T10:00:00.000Z'),
      finishedAt: new Date('2026-08-07T10:00:42.000Z'),
      ...overrides,
    });

    it('carries the longest a run can take, for the page to quote while it is going', async () => {
      // The wait is the deployment's (AI_ENGINE_TIMEOUT_MS), the same for every
      // run, so it rides every view and is read, not written into the page.
      Object.assign(proxy, { waitSeconds: 240 });
      tx.optimizationJob.findUnique.mockResolvedValue(row({ status: 'RUNNING', solverStatus: null }));

      await expect(service.get(JOB_ID, testUser())).resolves.toMatchObject({
        status: 'RUNNING',
        waitSeconds: 240,
      });
    });

    describe('a run whose lease has run out', () => {
      const running = (leaseUntil: Date | null | undefined, extra: Record<string, unknown> = {}) =>
        row({
          status: 'RUNNING',
          solverStatus: null,
          finishedAt: null,
          conflicts: null,
          lessonsGenerated: 0,
          createdAt: new Date(Date.now() - 6 * 60 * 1000),
          leaseUntil,
          ...extra,
        });

      it('is shown as what the sweep will make it: FAILED, ENGINE_RUN_ABANDONED, finished when the lease ran out', async () => {
        const leaseEnded = new Date(Date.now() - 2 * 60 * 1000);
        tx.optimizationJob.findUnique.mockResolvedValue(running(leaseEnded));

        await expect(service.get(JOB_ID, testUser())).resolves.toMatchObject({
          status: 'FAILED',
          solverStatus: null,
          errorCode: ENGINE_RUN_ABANDONED,
          error: ABANDONED_MESSAGE,
          errorParams: null,
          errorNames: [],
          finishedAt: leaseEnded.toISOString(),
        });
      });

      describe('says how long it had gone on, by its last sign of life and not by the end of its lease', () => {
        const created = new Date(Date.now() - 6 * 60 * 1000);
        const lastHeard = (seconds: number) => new Date(created.getTime() + seconds * 1000);

        it('when this read gives it up', async () => {
          tx.optimizationJob.findUnique.mockResolvedValue(
            running(new Date(Date.now() - 2 * 60 * 1000), { createdAt: created, heartbeatAt: lastHeard(150) }),
          );

          await expect(service.get(JOB_ID, testUser())).resolves.toMatchObject({
            errorCode: ENGINE_RUN_ABANDONED,
            error: ABANDONED_MESSAGE,
            errorParams: { lastSeenSeconds: 150 },
          });
        });

        it('when the sweep already had: it wrote the code and no figure, and its own sentence stays', async () => {
          tx.optimizationJob.findUnique.mockResolvedValue(
            row({
              status: 'FAILED',
              solverStatus: null,
              error: 'The service restarted while the run was going.',
              errorCode: ENGINE_RUN_ABANDONED,
              createdAt: created,
              finishedAt: new Date(Date.now() - 60_000),
              heartbeatAt: lastHeard(95),
            }),
          );

          await expect(service.get(JOB_ID, testUser())).resolves.toMatchObject({
            status: 'FAILED',
            errorCode: ENGINE_RUN_ABANDONED,
            error: 'The service restarted while the run was going.',
            errorParams: { lastSeenSeconds: 95 },
          });
        });

        it.each([
          ['a run last heard from four seconds in says nothing', 4, null],
          ['and five is the least that is said', 5, { lastSeenSeconds: 5 }],
        ])('%s', async (_name, seconds, params) => {
          tx.optimizationJob.findUnique.mockResolvedValue(
            running(new Date(Date.now() - 60_000), { createdAt: created, heartbeatAt: lastHeard(seconds) }),
          );

          expect((await service.get(JOB_ID, testUser())).errorParams).toEqual(params);
        });

        it('says nothing for a row with no heartbeat to read, or one that disagrees with its own start', async () => {
          tx.optimizationJob.findUnique.mockResolvedValue(running(new Date(Date.now() - 60_000), { createdAt: created }));
          expect((await service.get(JOB_ID, testUser())).errorParams).toBeNull();

          tx.optimizationJob.findUnique.mockResolvedValue(
            running(new Date(Date.now() - 60_000), { createdAt: created, heartbeatAt: lastHeard(-30) }),
          );
          expect((await service.get(JOB_ID, testUser())).errorParams).toBeNull();
        });

        it('reads the heartbeat with the run, in the one statement the poll costs', async () => {
          tx.optimizationJob.findUnique.mockResolvedValue(row());
          await service.get(JOB_ID, testUser());
          expect(tx.optimizationJob.findUnique.mock.calls[0]![0].select.heartbeatAt).toBe(true);
        });
      });

      it('is shown as running while the lease holds, and when the row has no lease to read (a row from before the column)', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(running(new Date(Date.now() + 60_000)));
        await expect(service.get(JOB_ID, testUser())).resolves.toMatchObject({ status: 'RUNNING', finishedAt: null, errorCode: null });

        tx.optimizationJob.findUnique.mockResolvedValue(running(undefined));
        await expect(service.get(JOB_ID, testUser())).resolves.toMatchObject({ status: 'RUNNING', finishedAt: null });
      });

      it('is abandoned past half an hour whatever its lease says: a timer can outlive the work it was for', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(
          running(new Date(Date.now() + 60_000), { createdAt: new Date(Date.now() - 31 * 60 * 1000) }),
        );
        const view = await service.get(JOB_ID, testUser());
        expect(view).toMatchObject({ status: 'FAILED', errorCode: ENGINE_RUN_ABANDONED });
        // Finished no later than now, never at a lease that has not come yet.
        expect(new Date(view.finishedAt as string).getTime()).toBeLessThanOrEqual(Date.now());
      });

      it('leaves a run that has ended exactly as it ended, however old its lease', async () => {
        const stale = new Date(Date.now() - 60 * 60 * 1000);
        tx.optimizationJob.findUnique.mockResolvedValue(row({ leaseUntil: stale }));
        await expect(service.get(JOB_ID, testUser())).resolves.toMatchObject({ status: 'SUCCEEDED', errorCode: null });

        tx.optimizationJob.findUnique.mockResolvedValue(
          row({ status: 'FAILED', error: 'engine down', errorCode: 'ENGINE_DOWN', leaseUntil: stale }),
        );
        await expect(service.get(JOB_ID, testUser())).resolves.toMatchObject({ status: 'FAILED', errorCode: 'ENGINE_DOWN', error: 'engine down' });
      });

      it('is read the same in the history, one clock for every run', async () => {
        const dead = running(new Date(Date.now() - 60_000), { id: 'dead' });
        const alive = running(new Date(Date.now() + 60_000), { id: 'alive' });
        tx.optimizationJob.findMany.mockResolvedValue([alive, dead]);

        const views = await service.list(YEAR_ID, testUser());

        expect(views.map((view) => [view.id, view.status, view.errorCode])).toEqual([
          ['alive', 'RUNNING', null],
          ['dead', 'FAILED', ENGINE_RUN_ABANDONED],
        ]);
      });

      it('asks the lease with the run, in the one statement the page’s poll costs', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(row());
        await service.get(JOB_ID, testUser());
        expect(tx.optimizationJob.findUnique.mock.calls[0]![0].select.leaseUntil).toBe(true);
        expect(prisma.queryWithRls).toHaveBeenCalledTimes(1);
      });
    });

    it('returns the job as an API view with ISO timestamps', async () => {
      tx.optimizationJob.findUnique.mockResolvedValue(row());

      await expect(service.get(JOB_ID, testUser())).resolves.toEqual({
        id: JOB_ID,
        status: 'SUCCEEDED',
        solverStatus: 'OPTIMAL',
        lessonsGenerated: 12,
        conflictSummary: null,
        // A row written before names and codes were kept: read back with an
        // empty list and explicit nulls, never an undefined the page would
        // have to guard or a JSON body would drop.
        conflictSummaryCode: null,
        conflictSummaryParams: null,
        // No days sentence, so nobody named beside one: always a list.
        conflictSummaryNames: [],
        conflicts: [{ category: 'ROOM_OVERLAP', message: 'clash', resourceNames: [] }],
        // And a row from before the wishes: no notes, an empty list.
        notes: [],
        error: null,
        errorCode: null,
        errorParams: null,
        errorNames: [],
        // Not a TIMEOUT: no account of its time.
        report: null,
        suggestions: null,
        suggestionsOffered: false,
        // No notes, so no change log read: nothing to say they were replaced.
        supersededBy: null,
        createdAt: '2026-08-07T10:00:00.000Z',
        finishedAt: '2026-08-07T10:00:42.000Z',
      });
      expect(tx.scheduleChangeLog.findFirst).not.toHaveBeenCalled();
    });

    it('reads a TIMEOUT’s report back through the same door: a stored value the page may not trust is a null', async () => {
      const report = {
        totalSeconds: 109,
        budgetSeconds: 100,
        configuredBudgetSeconds: 100,
        callerWaitSeconds: null,
        stages: [{ stage: 'BUILD', seconds: 4 }],
        search: { solutions: 0, phases: [] },
        weekLoadCut: false,
      };
      tx.optimizationJob.findUnique.mockResolvedValue(
        row({ solverStatus: 'TIMEOUT', report: { ...report, extra: 'x', stages: [...report.stages] } }),
      );
      expect((await service.get(JOB_ID, testUser())).report).toEqual(report);

      tx.optimizationJob.findUnique.mockResolvedValue(row({ solverStatus: 'TIMEOUT', report: ['not', 'an', 'object'] }));
      expect((await service.get(JOB_ID, testUser())).report).toBeNull();

      tx.optimizationJob.findUnique.mockResolvedValue(row({ solverStatus: 'TIMEOUT' }));
      expect((await service.get(JOB_ID, testUser())).report).toBeNull();
    });

    it('asks for the report with the run, in the one statement the poll costs', async () => {
      tx.optimizationJob.findUnique.mockResolvedValue(row());
      await service.get(JOB_ID, testUser());
      expect(tx.optimizationJob.findUnique.mock.calls[0]![0].select.report).toBe(true);
      expect(prisma.queryWithRls).toHaveBeenCalledTimes(1);
    });

    it('drops a stored value that is not a scalar rather than rendering it', async () => {
      // The column is written by this service alone, but a hand-edited row
      // must not put an object where a sentence expects a number: next-intl
      // renders that as [object Object] in the middle of a refusal.
      tx.optimizationJob.findUnique.mockResolvedValue({
        ...row(),
        conflictSummaryCode: 'LUNCH_SEATS_CAP',
        conflictSummaryParams: { seats: 115, nested: { deep: true }, list: [1, 2] },
        errorParams: 'not an object',
      });

      const view = await service.get(JOB_ID, testUser());

      expect(view.conflictSummaryParams).toEqual({ seats: 115 });
      expect(view.errorParams).toBeNull();
    });

    it('looks the job up by id under the caller RLS session', async () => {
      tx.optimizationJob.findUnique.mockResolvedValue(row());
      const user = testUser();

      await service.get(JOB_ID, user);

      expect(prisma.queryWithRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(prisma.withRls).not.toHaveBeenCalled();
      expect(tx.optimizationJob.findUnique).toHaveBeenCalledWith({
        where: { id: JOB_ID },
        select: expect.objectContaining({
          id: true,
          status: true,
          solverStatus: true,
          conflicts: true,
        }),
      });
    });

    it('normalises a still-running job: no solver verdict, no finish time', async () => {
      tx.optimizationJob.findUnique.mockResolvedValue(
        row({
          status: 'RUNNING',
          solverStatus: null,
          finishedAt: null,
          conflicts: null,
          lessonsGenerated: 0,
        }),
      );

      await expect(service.get(JOB_ID, testUser())).resolves.toMatchObject({
        status: 'RUNNING',
        solverStatus: null,
        finishedAt: null,
        conflicts: [],
      });
    });

    it('coerces a non-array conflicts payload to an empty list', async () => {
      tx.optimizationJob.findUnique.mockResolvedValue(
        row({ conflicts: { unexpected: 'shape' } }),
      );

      await expect(service.get(JOB_ID, testUser())).resolves.toMatchObject({
        conflicts: [],
      });
    });

    it('404s on an unknown job (which is what a cross-tenant row looks like under RLS)', async () => {
      tx.optimizationJob.findUnique.mockResolvedValue(null);

      await expect(service.get(JOB_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.get(JOB_ID, testUser())).rejects.toThrow(
        'Optimization job not found.',
      );
    });
  });

  describe('list', () => {
    it('returns the latest 20 runs for the year, newest first', async () => {
      tx.optimizationJob.findMany.mockResolvedValue([
        {
          id: JOB_ID,
          status: 'FAILED',
          solverStatus: null,
          lessonsGenerated: 0,
          conflictSummary: null,
          conflicts: null,
          error: 'The AI engine returned an error.',
          createdAt: new Date('2026-08-07T09:00:00.000Z'),
          finishedAt: null,
        },
      ]);
      const user = testUser();

      await expect(service.list(YEAR_ID, user)).resolves.toEqual([
        {
          id: JOB_ID,
          status: 'FAILED',
          solverStatus: null,
          lessonsGenerated: 0,
          conflictSummary: null,
          // A row from before the codes: explicit nulls, so the screen reads
          // "no code, show the English" rather than losing the field.
          conflictSummaryCode: null,
          conflictSummaryParams: null,
          conflictSummaryNames: [],
          conflicts: [],
          notes: [],
          error: 'The AI engine returned an error.',
          errorCode: null,
          errorParams: null,
          errorNames: [],
          report: null,
          suggestions: null,
          suggestionsOffered: false,
          supersededBy: null,
          createdAt: '2026-08-07T09:00:00.000Z',
          finishedAt: null,
        },
      ]);

      expect(prisma.queryWithRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(prisma.withRls).not.toHaveBeenCalled();
      expect(tx.optimizationJob.findMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR_ID },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: expect.objectContaining({ id: true, status: true }),
      });
    });

    it('returns an empty history when the year has no runs', async () => {
      tx.optimizationJob.findMany.mockResolvedValue([]);

      await expect(service.list(YEAR_ID, testUser())).resolves.toEqual([]);
    });
  });

  /*
   * Lärarens dag: a refusal about a post's days is stored without its figure
   * and worded for its reader when it is read (work-days.ts), and the
   * free-day wishes a finished run did not keep are stored beside it.
   */
  describe('Lärarens dag', () => {
    const EVA = '22222222-dddd-4ddd-8ddd-222222222222';
    const POST = '44444444-dddd-4ddd-8ddd-444444444444';
    const RULE = '77777777-dddd-4ddd-8ddd-777777777777';
    const OTHER_YEAR = '44444444-4444-4444-8444-4444444444ff';
    const noHr = () => testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false } as never);
    const hr = () => testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: true, channel: 'WEB' } as never);

    /** A days conflict as run() stores it: no figure, the hidden English, Eva beside it. */
    const daysConflict = (overrides: Record<string, unknown> = {}) => ({
      category: 'TEACHER_OVERLAP',
      code: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
      params: { limit: POST },
      message: WORK_DAYS_HIDDEN_MESSAGE,
      resourceNames: [],
      subjectIds: [EVA],
      ...overrides,
    });
    const lunchConflict = {
      category: 'AVAILABILITY',
      code: 'TEACHER_LUNCH_HAS_NOWHERE_TO_GO',
      params: { rule: RULE, minutes: 30, day: 2 },
      message: 'The 30-minute lunch …',
      resourceNames: [],
    };
    const row = (overrides: Record<string, unknown> = {}) => ({
      id: JOB_ID,
      academicYearId: YEAR_ID,
      status: 'SUCCEEDED',
      solverStatus: 'INFEASIBLE',
      lessonsGenerated: 0,
      conflictSummary: '2 causes',
      conflictSummaryCode: 'CONFLICT_CORE_SUMMARY',
      conflictSummaryParams: { count: 2 },
      conflicts: [daysConflict(), lunchConflict],
      notes: null,
      error: null,
      errorCode: null,
      errorParams: null,
      createdAt: new Date('2026-11-23T10:00:00.000Z'),
      finishedAt: new Date('2026-11-23T10:00:30.000Z'),
      ...overrides,
    });
    /** A failed run whose pre-flight refused the week over Eva's days. */
    const preflightRow = () =>
      row({
        status: 'FAILED',
        solverStatus: null,
        conflictSummary: null,
        conflictSummaryCode: null,
        conflictSummaryParams: null,
        conflicts: null,
        error: WORK_DAYS_HIDDEN_MESSAGE,
        errorCode: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK',
        errorParams: { limit: POST, weekMinutes: 1500, subjectIds: [EVA] },
      });
    /** A note as run() stores it: the day, Eva beside it, nobody named. */
    const wishNote = (overrides: Record<string, unknown> = {}) => ({
      category: 'AVAILABILITY',
      code: 'TEACHER_FREE_DAY_WISH_NOT_KEPT',
      params: { day: 5 },
      message: 'A teacher wishes Fridays free …',
      resourceNames: [],
      subjectIds: [EVA],
      ...overrides,
    });
    const evasName = { id: EVA, firstName: 'Eva', lastName: 'Ek' };
    const evasPost = (overrides: Record<string, unknown> = {}) => ({
      academicYearId: YEAR_ID,
      userId: EVA,
      maxTeachingDaysPerWeek: 3,
      maxConsecutiveTeachingMinutes: null,
      consecutiveBreakMinutes: null,
      user: { firstName: 'Eva', lastName: 'Ek' },
      ...overrides,
    });
    /** A note about a limit on teaching in a row as run() stores it: the weekday and the length, Eva server-side, no figure of the limit. */
    const stretchNote = (overrides: Record<string, unknown> = {}) => ({
      category: 'AVAILABILITY',
      code: 'TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT',
      params: { day: 2, minutes: 250 },
      message: 'A teacher with a limit on teaching in a row has 250 minutes in a row on Tuesdays …',
      resourceNames: [],
      subjectIds: [EVA],
      ...overrides,
    });

    describe('what run() stores', () => {
      it('keeps a days conflict’s teachers beside it, and no key on any other', async () => {
        proxy.triggerScheduling.mockResolvedValue(
          engineResponse({
            status: 'INFEASIBLE',
            conflicts: {
              summary: '2 causes',
              summaryCode: 'CONFLICT_CORE_SUMMARY',
              summaryParams: { count: 2 },
              conflicts: [
                {
                  category: 'TEACHER_OVERLAP',
                  code: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
                  params: { limit: POST },
                  message: WORK_DAYS_HIDDEN_MESSAGE,
                  requirementIds: [],
                  roomIds: [],
                  constraintIds: [],
                  resourceIds: [EVA],
                  resourceNames: [],
                  subjectIds: [EVA],
                },
                {
                  ...lunchConflict,
                  category: 'AVAILABILITY',
                  requirementIds: [],
                  roomIds: [],
                  constraintIds: [],
                  resourceIds: [RULE],
                  // An empty list is no teacher: no key either.
                  subjectIds: [],
                },
              ],
            },
          }),
        );

        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();

        expect(tx.optimizationJob.update).toHaveBeenLastCalledWith({
          where: { id: JOB_ID },
          data: expect.objectContaining({
            conflictSummaryParams: { count: 2 },
            conflicts: [daysConflict(), lunchConflict],
          }),
        });
      });

      it('keeps a days-bearing summary’s teachers inside its params, where no reader is given them', async () => {
        proxy.triggerScheduling.mockResolvedValue(
          engineResponse({
            status: 'INFEASIBLE',
            conflicts: {
              summary: WORK_DAYS_HIDDEN_MESSAGE,
              summaryCode: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
              summaryParams: { limit: POST },
              summarySubjectIds: [EVA],
              conflicts: [],
            },
          }),
        );

        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();

        expect(tx.optimizationJob.update).toHaveBeenLastCalledWith({
          where: { id: JOB_ID },
          data: expect.objectContaining({ conflictSummaryParams: { limit: POST, subjectIds: [EVA] } }),
        });
      });

      it('keeps a days pre-flight’s teachers inside its error params', async () => {
        proxy.triggerScheduling.mockRejectedValue(
          new WorkDaysRefusal(
            {
              message: WORK_DAYS_HIDDEN_MESSAGE,
              code: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK',
              params: { limit: POST, weekMinutes: 1500 },
            },
            400,
            [EVA],
          ),
        );

        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();

        expect(tx.optimizationJob.update).toHaveBeenLastCalledWith({
          where: { id: JOB_ID },
          data: {
            status: 'FAILED',
            error: WORK_DAYS_HIDDEN_MESSAGE,
            errorCode: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK',
            errorParams: { limit: POST, weekMinutes: 1500, subjectIds: [EVA] },
            finishedAt: expect.any(Date),
          },
        });
      });

      it('keeps no params, and so no teachers, for a days refusal whose body is not an object', async () => {
        // The teachers ride on the exception, never in the body; with no
        // params to sit beside, nothing is stored for them.
        const refusal = new WorkDaysRefusal(
          { message: WORK_DAYS_HIDDEN_MESSAGE, code: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK', params: {} },
          400,
          [EVA],
        );
        jest.spyOn(refusal, 'getResponse').mockReturnValue('refused');
        proxy.triggerScheduling.mockRejectedValue(refusal);

        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();

        expect(tx.optimizationJob.update).toHaveBeenLastCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ error: 'refused', errorCode: null, errorParams: DbNull }),
          }),
        );
      });

      it('stores the wishes the run did not keep as a conflict is kept, the teacher beside each and no name', async () => {
        proxy.triggerScheduling.mockResolvedValue(
          engineResponse({
            notes: [
              {
                category: 'AVAILABILITY',
                code: 'TEACHER_FREE_DAY_WISH_NOT_KEPT',
                params: { day: 5 },
                message: 'A teacher wishes Fridays free …',
                requirementIds: [],
                roomIds: [],
                constraintIds: [],
                resourceIds: [RULE],
                resourceNames: [],
                subjectIds: [EVA],
              },
              {
                // A note as an older proxy built it: no names, nobody beside it.
                category: 'AVAILABILITY',
                code: 'TEACHER_FREE_DAY_WISH_NOT_KEPT',
                params: { day: 1 },
                message: 'Mondays',
                requirementIds: [],
                roomIds: [],
                constraintIds: [],
                resourceIds: [RULE],
              },
            ],
          }),
        );

        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();

        // Not the rule's id: no view reads one, and it is the teacher the
        // note is about.
        expect(tx.optimizationJob.update).toHaveBeenLastCalledWith({
          where: { id: JOB_ID },
          data: expect.objectContaining({
            status: 'SUCCEEDED',
            notes: [
              {
                category: 'AVAILABILITY',
                code: 'TEACHER_FREE_DAY_WISH_NOT_KEPT',
                params: { day: 5 },
                message: 'A teacher wishes Fridays free …',
                resourceNames: [],
                subjectIds: [EVA],
              },
              {
                category: 'AVAILABILITY',
                code: 'TEACHER_FREE_DAY_WISH_NOT_KEPT',
                params: { day: 1 },
                message: 'Mondays',
                resourceNames: [],
              },
            ],
          }),
        });
      });

      it('stores no notes when the run broke no wish', async () => {
        proxy.triggerScheduling.mockResolvedValue(engineResponse({ notes: [] }));

        await service.start(YEAR_ID, testUser());
        await flushBackgroundRun();

        expect(tx.optimizationJob.update).toHaveBeenLastCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ notes: DbNull }) }),
        );
      });
    });

    describe('a reader without HR-läs', () => {
      it('is shown every days sentence as the hidden one, its category kept, and nothing read back', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(row());

        const view = await service.get(JOB_ID, noHr());

        expect(view.conflicts).toEqual([
          {
            category: 'TEACHER_OVERLAP',
            code: TEACHER_WORK_DAYS_HIDDEN,
            params: {},
            message: WORK_DAYS_HIDDEN_MESSAGE,
            resourceNames: [],
          },
          lunchConflict,
        ]);
        expect(prisma.withRls).not.toHaveBeenCalled();
        expect(tx.teacherEmployment.findMany).not.toHaveBeenCalled();
        expect(recordedReads(tx)).toEqual([]);
        // No post, no teacher, no figure anywhere in what leaves.
        expect(JSON.stringify(view)).not.toMatch(new RegExp(`${EVA}|${POST}|subjectIds`));
      });

      it('is shown two hidden sentences of one category as one, and of two categories as two', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(
          row({
            conflicts: [
              daysConflict(),
              lunchConflict,
              daysConflict({ code: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK', params: { limit: 'post-2', weekMinutes: 900 } }),
              daysConflict({ category: 'REQUIREMENT_DEMAND' }),
            ],
          }),
        );

        const view = await service.get(JOB_ID, noHr());

        expect(view.conflicts.map((conflict) => [conflict.category, conflict.code])).toEqual([
          ['TEACHER_OVERLAP', TEACHER_WORK_DAYS_HIDDEN],
          ['AVAILABILITY', 'TEACHER_LUNCH_HAS_NOWHERE_TO_GO'],
          ['REQUIREMENT_DEMAND', TEACHER_WORK_DAYS_HIDDEN],
        ]);
      });

      it('is shown a days pre-flight as the hidden sentence, and never the teachers kept beside it', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(preflightRow());

        const view = await service.get(JOB_ID, noHr());

        expect(view).toMatchObject({
          error: WORK_DAYS_HIDDEN_MESSAGE,
          errorCode: TEACHER_WORK_DAYS_HIDDEN,
          errorParams: {},
          errorNames: [],
          conflictSummaryNames: [],
        });
        expect(JSON.stringify(view)).not.toMatch(new RegExp(`${EVA}|${POST}|1500|Eva`));
      });

      it('is shown a days-bearing summary as the hidden sentence', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(
          row({
            conflictSummary: WORK_DAYS_HIDDEN_MESSAGE,
            conflictSummaryCode: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
            conflictSummaryParams: { limit: POST, subjectIds: [EVA] },
            conflicts: [],
          }),
        );

        await expect(service.get(JOB_ID, noHr())).resolves.toMatchObject({
          conflictSummary: WORK_DAYS_HIDDEN_MESSAGE,
          conflictSummaryCode: TEACHER_WORK_DAYS_HIDDEN,
          conflictSummaryParams: {},
          conflictSummaryNames: [],
        });
      });
    });

    /*
     * THE LIMIT ON TEACHING IN A ROW IS A POST’S HR DATA (20261218090000), and a
     * note about it is read by the rule of the days (work-days.ts): the limit,
     * the pause and the teacher only for a reader with HR-läs, from the post as
     * it stands; the hidden note for every other reader.
     */
    describe('a note about a limit on teaching in a row', () => {
      const stretchRun = (overrides: Record<string, unknown> = {}) =>
        row({ solverStatus: 'OPTIMAL', conflicts: [], notes: [stretchNote()], ...overrides });
      const evasLimit = (overrides: Record<string, unknown> = {}) =>
        evasPost({ maxTeachingDaysPerWeek: null, maxConsecutiveTeachingMinutes: 180, consecutiveBreakMinutes: 30, ...overrides });
      beforeEach(() => tx.scheduleChangeLog.findMany.mockResolvedValue([]));

      it('is the hidden note to a reader without HR-läs: no teacher, no weekday, no figure, no read of the post, no name read', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(stretchRun());

        const view = await service.get(JOB_ID, noHr());

        expect(view.notes).toEqual([
          {
            category: 'AVAILABILITY',
            code: 'TEACHER_CONSECUTIVE_TEACHING_HIDDEN',
            params: {},
            message: CONSECUTIVE_TEACHING_HIDDEN_MESSAGE,
            resourceNames: [],
          },
        ]);
        const shown = JSON.stringify(view);
        expect(shown).not.toMatch(new RegExp(`${EVA}|Eva|250|Tuesdays|180`));
        // Nothing of the post is read, nobody is named, nothing is recorded.
        expect(tx.teacherEmployment.findMany).not.toHaveBeenCalled();
        expect(tx.user.findMany).not.toHaveBeenCalled();
        expect(recordedReads(tx)).toEqual([]);
      });

      it('is shown with the limit and the pause read back from the post and the teacher named to a reader with HR-läs, and the read is logged', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(stretchRun());
        tx.teacherEmployment.findMany.mockResolvedValue([evasLimit()]);

        const view = await service.get(JOB_ID, hr());

        expect(view.notes).toEqual([
          {
            category: 'AVAILABILITY',
            code: 'TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT',
            params: { day: 2, minutes: 250, max: 180, breakMinutes: 30 },
            message: stretchNote().message,
            resourceNames: ['Eva Ek'],
          },
        ]);
        expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [EVA] }]);
        // Never the Users id the row keeps; and no name was read for it, the
        // post carried the name.
        expect(JSON.stringify(view)).not.toContain(EVA);
        expect(tx.user.findMany).not.toHaveBeenCalled();
      });

      it('stays hidden for a reader with HR-läs when the post no longer has a limit, or is gone', async () => {
        for (const posts of [[evasPost({ maxTeachingDaysPerWeek: 3 })], []]) {
          tx.optimizationJob.findUnique.mockResolvedValue(stretchRun());
          tx.teacherEmployment.findMany.mockResolvedValue(posts);

          const view = await service.get(JOB_ID, hr());

          expect(view.notes.map((note) => note.code)).toEqual(['TEACHER_CONSECUTIVE_TEACHING_HIDDEN']);
          expect(JSON.stringify(view)).not.toMatch(/Eva|180/);
        }
        expect(recordedReads(tx)).toEqual([]);
      });

      it('is one hidden note, not one per teacher, and shown beside a free-day note that still names its teacher', async () => {
        const OLLE = '33333333-dddd-4ddd-8ddd-333333333333';
        tx.optimizationJob.findUnique.mockResolvedValue(
          stretchRun({ notes: [wishNote(), stretchNote(), stretchNote({ subjectIds: [OLLE] })] }),
        );
        tx.user.findMany.mockResolvedValue([evasName]);

        const view = await service.get(JOB_ID, noHr());

        expect(view.notes.map((note) => note.code)).toEqual([
          'TEACHER_FREE_DAY_WISH_NOT_KEPT',
          'TEACHER_CONSECUTIVE_TEACHING_HIDDEN',
        ]);
        expect(view.notes[0]!.resourceNames).toEqual(['Eva Ek']);
        // The names read are the free-day note’s teacher, never the limit’s.
        expect(tx.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [EVA] } } }));
      });

      it('names no teacher of a limit in the history either', async () => {
        tx.scheduleChangeLog.findMany.mockResolvedValue([]);
        tx.optimizationJob.findMany.mockResolvedValue([stretchRun(), stretchRun()]);

        const views = await service.list(YEAR_ID, noHr());

        expect(views.map((view) => view.notes.map((note) => note.code))).toEqual([
          ['TEACHER_CONSECUTIVE_TEACHING_HIDDEN'],
          ['TEACHER_CONSECUTIVE_TEACHING_HIDDEN'],
        ]);
        expect(tx.user.findMany).not.toHaveBeenCalled();
        expect(JSON.stringify(views)).not.toMatch(/Eva|250/);
      });
    });

    describe('a reader with HR-läs', () => {
      it('is shown the days from the post as it stands and the teacher named, and the read is logged', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(row());
        tx.teacherEmployment.findMany.mockResolvedValue([evasPost()]);

        const view = await service.get(JOB_ID, hr());

        expect(view.conflicts).toEqual([
          {
            category: 'TEACHER_OVERLAP',
            code: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
            params: { limit: POST, days: 3 },
            message: WORK_DAYS_HIDDEN_MESSAGE,
            resourceNames: ['Eva Ek'],
          },
          lunchConflict,
        ]);
        // The run's own read stays one statement; the posts are a second
        // transaction, for the run's year and the teachers it names.
        expect(prisma.queryWithRls).toHaveBeenCalledTimes(1);
        expect(prisma.withRls).toHaveBeenCalledTimes(1);
        expect(tx.teacherEmployment.findMany).toHaveBeenCalledWith({
          where: {
            academicYearId: { in: [YEAR_ID] },
            userId: { in: [EVA] },
            OR: [{ maxTeachingDaysPerWeek: { not: null } }, { maxConsecutiveTeachingMinutes: { not: null } }],
          },
          select: {
            academicYearId: true,
            userId: true,
            maxTeachingDaysPerWeek: true,
            maxConsecutiveTeachingMinutes: true,
            consecutiveBreakMinutes: true,
            user: { select: { firstName: true, lastName: true } },
          },
        });
        expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [EVA] }]);
        // Never the Users id the row keeps.
        expect(JSON.stringify(view)).not.toContain(EVA);
      });

      it('is shown a days pre-flight with its days, from the post', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(preflightRow());
        tx.teacherEmployment.findMany.mockResolvedValue([evasPost({ maxTeachingDaysPerWeek: 2 })]);

        const view = await service.get(JOB_ID, hr());

        expect(view).toMatchObject({
          errorCode: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK',
          errorParams: { limit: POST, weekMinutes: 1500, days: 2 },
          // The post's id is no name a screen resolves: the teacher is
          // named beside the sentence, as a conflict's are in resourceNames.
          errorNames: ['Eva Ek'],
          conflictSummaryNames: [],
        });
        expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [EVA] }]);
        expect(JSON.stringify(view)).not.toContain(EVA);
      });

      it('is shown a days-bearing summary with its days and the teacher named beside it', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(
          row({
            conflictSummary: WORK_DAYS_HIDDEN_MESSAGE,
            conflictSummaryCode: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
            conflictSummaryParams: { limit: POST, subjectIds: [EVA] },
            conflicts: [],
          }),
        );
        tx.teacherEmployment.findMany.mockResolvedValue([evasPost()]);

        await expect(service.get(JOB_ID, hr())).resolves.toMatchObject({
          conflictSummaryCode: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
          conflictSummaryParams: { limit: POST, days: 3 },
          conflictSummaryNames: ['Eva Ek'],
          errorNames: [],
        });
        expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [EVA] }]);
      });

      it('is shown the hidden sentence, and logged nothing, when the post has no limit now or is gone', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(row());
        tx.teacherEmployment.findMany.mockResolvedValue([]);

        const view = await service.get(JOB_ID, hr());

        expect(view.conflicts[0]).toMatchObject({ code: TEACHER_WORK_DAYS_HIDDEN, params: {}, resourceNames: [] });
        expect(recordedReads(tx)).toEqual([]);
      });

      it('is shown a days pre-flight hidden, and nobody named, when the post has no limit now', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(preflightRow());
        tx.teacherEmployment.findMany.mockResolvedValue([]);

        await expect(service.get(JOB_ID, hr())).resolves.toMatchObject({
          errorCode: TEACHER_WORK_DAYS_HIDDEN,
          errorParams: {},
          errorNames: [],
        });
        expect(recordedReads(tx)).toEqual([]);
      });

      it('reads back a post of the run’s own year only', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(row());
        tx.teacherEmployment.findMany.mockResolvedValue([evasPost({ academicYearId: OTHER_YEAR })]);

        const view = await service.get(JOB_ID, hr());

        expect(view.conflicts[0]!.code).toBe(TEACHER_WORK_DAYS_HIDDEN);
      });

      it('reads nothing back for a run with no days sentence', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(row({ conflicts: [lunchConflict] }));

        await expect(service.get(JOB_ID, hr())).resolves.toMatchObject({ conflicts: [lunchConflict] });
        expect(prisma.withRls).not.toHaveBeenCalled();
      });

      it('reads the history’s posts once, for every run in it', async () => {
        tx.optimizationJob.findMany.mockResolvedValue([row(), preflightRow(), row({ conflicts: [lunchConflict] })]);
        tx.teacherEmployment.findMany.mockResolvedValue([evasPost(), evasPost({ userId: 'nobody-asked' })]);

        const views = await service.list(YEAR_ID, hr());

        expect(views.map((view) => view.conflicts[0]?.params?.['days'] ?? view.errorParams?.['days'])).toEqual([
          3,
          3,
          undefined,
        ]);
        expect(tx.teacherEmployment.findMany).toHaveBeenCalledTimes(1);
        expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [EVA] }]);
      });
    });

    /*
     * A free-day wish is the work rule's, which every member of staff reads:
     * its note names the teacher for every reader, read back by Users id when
     * the run is read, and the Läslogg is not written for a name.
     */
    describe('a note about a free-day wish', () => {
      const wishRun = (overrides: Record<string, unknown> = {}) =>
        row({ solverStatus: 'OPTIMAL', conflicts: [], notes: [wishNote()], ...overrides });
      // The year's log since the run: empty unless a test says otherwise.
      beforeEach(() => tx.scheduleChangeLog.findMany.mockResolvedValue([]));

      it('names the teacher for a reader without HR-läs, in a statement more for the names and one for the log, and no Läslogg', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(wishRun());
        tx.user.findMany.mockResolvedValue([evasName]);

        const view = await service.get(JOB_ID, noHr());

        expect(view.notes).toEqual([
          {
            category: 'AVAILABILITY',
            code: 'TEACHER_FREE_DAY_WISH_NOT_KEPT',
            params: { day: 5 },
            message: 'A teacher wishes Fridays free …',
            resourceNames: ['Eva Ek'],
          },
        ]);
        expect(JSON.stringify(view)).not.toMatch(/subjectIds|22222222-dddd/);
        // The run, the names, and the change log (supersededBy below).
        expect(prisma.queryWithRls).toHaveBeenCalledTimes(3);
        expect(prisma.withRls).not.toHaveBeenCalled();
        expect(tx.user.findMany).toHaveBeenCalledWith({
          where: { id: { in: [EVA] } },
          select: { id: true, firstName: true, lastName: true },
        });
        expect(tx.teacherEmployment.findMany).not.toHaveBeenCalled();
        expect(recordedReads(tx)).toEqual([]);
      });

      it('names the teacher for a reader with HR-läs too, beside a run with no days sentence', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(wishRun());
        tx.user.findMany.mockResolvedValue([evasName]);

        const view = await service.get(JOB_ID, hr());

        expect(view.notes[0]!.resourceNames).toEqual(['Eva Ek']);
        expect(prisma.withRls).not.toHaveBeenCalled();
        expect(recordedReads(tx)).toEqual([]);
      });

      it('reads the names in the transaction that reads the posts, when the run has both', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(wishRun({ conflicts: [daysConflict()] }));
        tx.teacherEmployment.findMany.mockResolvedValue([evasPost()]);
        tx.user.findMany.mockResolvedValue([evasName]);

        const view = await service.get(JOB_ID, hr());

        expect(view.notes[0]!.resourceNames).toEqual(['Eva Ek']);
        expect(view.conflicts[0]).toMatchObject({ params: { limit: POST, days: 3 }, resourceNames: ['Eva Ek'] });
        // The run's read and the change log's, and one transaction for the
        // posts and the names.
        expect(prisma.queryWithRls).toHaveBeenCalledTimes(2);
        expect(prisma.withRls).toHaveBeenCalledTimes(1);
        // The Läslogg names her for the post's days, not for the name.
        expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [EVA] }]);
      });

      it('reads no name for a reader with HR-läs shown a post’s days but no note', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(row());
        tx.teacherEmployment.findMany.mockResolvedValue([evasPost()]);

        await service.get(JOB_ID, hr());

        expect(tx.user.findMany).not.toHaveBeenCalled();
      });

      it('reads no name for a run that broke no wish', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(wishRun({ notes: null }));

        await expect(service.get(JOB_ID, noHr())).resolves.toMatchObject({ notes: [] });
        expect(prisma.queryWithRls).toHaveBeenCalledTimes(1);
        expect(tx.user.findMany).not.toHaveBeenCalled();
      });

      it('reads the history’s names once, for every run in it, each teacher once', async () => {
        const OLLE = '33333333-dddd-4ddd-8ddd-333333333333';
        tx.optimizationJob.findMany.mockResolvedValue([
          wishRun(),
          wishRun({ notes: [wishNote({ params: { day: 1 } }), wishNote({ subjectIds: [OLLE] })] }),
        ]);
        tx.user.findMany.mockResolvedValue([evasName, { id: OLLE, firstName: 'Olle', lastName: 'Ås' }]);

        const views = await service.list(YEAR_ID, noHr());

        expect(views.map((view) => view.notes.map((note) => note.resourceNames))).toEqual([
          [['Eva Ek']],
          [['Eva Ek'], ['Olle Ås']],
        ]);
        expect(tx.user.findMany).toHaveBeenCalledTimes(1);
        expect(tx.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [EVA, OLLE] } } }));
      });

      /*
       * A schemaförslag applied over the year since the run replaced the
       * timetable the notes describe. The apply's REGENERATE entry says so for
       * as long as the log keeps it, whatever becomes of the candidate's run.
       */
      describe('a candidate applied since', () => {
        const at = (minute: number) => new Date(`2026-11-23T11:${String(minute).padStart(2, '0')}:00.000Z`);
        const V1 = '99999999-9999-4999-8999-999999999991';
        const V2 = '99999999-9999-4999-8999-999999999992';
        /** An apply's REGENERATE entry, as ScheduleCandidatesService.apply writes it, with its safety version. */
        const apply = (minute: number, ordinal: number, safetyVersionId?: string) => ({
          action: 'REGENERATE',
          createdAt: at(minute),
          after: {
            source: 'CANDIDATE', runId: `run-${ordinal}`, ordinal, variant: 'TEACHER_GAPS', metrics: {},
            ...(safetyVersionId ? { safetyVersionId } : {}),
          },
        });
        /** A version restore's entry (ScheduleVersionsService.restore); the draft discard's names no version. */
        const restore = (minute: number, versionId?: string) => ({
          action: 'RESTORE',
          createdAt: at(minute),
          after: versionId ? { versionId, versionName: 'Före schemaförslag', restoredLessons: 40 } : { discardedDraft: true },
        });
        const read = async (...events: unknown[]) => {
          tx.optimizationJob.findUnique.mockResolvedValue(wishRun());
          tx.scheduleChangeLog.findMany.mockResolvedValue(events);
          return (await service.get(JOB_ID, noHr())).supersededBy;
        };

        it('names the newest candidate applied since the run finished, in one read of the year’s applies and restores', async () => {
          await expect(read(apply(10, 1, V1), apply(20, 2, V2))).resolves.toEqual({
            appliedAt: at(20).toISOString(),
            ordinal: 2,
            variant: 'TEACHER_GAPS',
            runId: 'run-2',
          });
          expect(tx.scheduleChangeLog.findMany).toHaveBeenCalledTimes(1);
          expect(tx.scheduleChangeLog.findMany).toHaveBeenCalledWith({
            where: {
              academicYearId: YEAR_ID,
              // Since it FINISHED: an apply that passed its check before the run
              // began, and wrote before the run's own write, is older than that.
              createdAt: { gt: wishRun().finishedAt },
              OR: [{ action: 'REGENERATE', after: { path: ['source'], equals: 'CANDIDATE' } }, { action: 'RESTORE' }],
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { action: true, createdAt: true, after: true },
          });
        });

        it('says none when an apply is undone by its own safety version: the run’s timetable is back', async () => {
          await expect(read(apply(10, 1, V1), restore(15, V1))).resolves.toBeNull();
        });

        it('says none when the first apply’s safety version is restored after a second apply', async () => {
          await expect(read(apply(10, 1, V1), apply(20, 2, V2), restore(25, V1))).resolves.toBeNull();
        });

        it('stays replaced when the second apply’s safety version is restored: that brings back the first candidate', async () => {
          await expect(read(apply(10, 1, V1), apply(20, 2, V2), restore(25, V2))).resolves.toMatchObject({ ordinal: 2, runId: 'run-2' });
        });

        it('says none when an apply made after the run came back is undone by its own version', async () => {
          // Apply, back to the run, apply again: the second safety version holds the run too.
          await expect(read(apply(10, 1, V1), restore(15, V1), apply(20, 2, V2), restore(25, V2))).resolves.toBeNull();
        });

        it('stays replaced after a restore of another version, a later one after the right one, or a draft discard', async () => {
          await expect(read(apply(10, 1, V1), restore(15, '88888888-8888-4888-8888-888888888888'))).resolves.toMatchObject({ ordinal: 1 });
          await expect(read(apply(10, 1, V1), restore(15, V1), restore(16, '88888888-8888-4888-8888-888888888888'))).resolves.toMatchObject({ ordinal: 1 });
          await expect(read(apply(10, 1, V1), restore(15))).resolves.toMatchObject({ ordinal: 1 });
        });

        it('stays replaced when the run’s timetable was already gone before the apply saved its version', async () => {
          // A restore of something else before the apply: its safety version is not the run's.
          await expect(read(restore(5, V2), apply(10, 1, V1), restore(15, V1))).resolves.toMatchObject({ ordinal: 1 });
        });

        it('stays replaced, unrestorable, for an apply logged without its safety version', async () => {
          await expect(read(apply(10, 1), restore(15, V1))).resolves.toMatchObject({ ordinal: 1 });
        });

        it('says none when the log has no apply since, restores alone included', async () => {
          await expect(read()).resolves.toBeNull();
          await expect(read(restore(15, V1))).resolves.toBeNull();
        });

        it('says a candidate was applied, unnamed, for an entry that does not say which', async () => {
          const unnamed = { action: 'REGENERATE', createdAt: at(20), after: { source: 'CANDIDATE', ordinal: '2', variant: 7, runId: 3 } };
          await expect(read(unnamed)).resolves.toEqual({ appliedAt: at(20).toISOString(), ordinal: null, variant: null, runId: null });
        });

        it('reads no log for a run without notes, one that did not succeed, nor for the history', async () => {
          tx.optimizationJob.findUnique.mockResolvedValue(wishRun({ notes: null }));
          await service.get(JOB_ID, noHr());
          tx.optimizationJob.findUnique.mockResolvedValue(wishRun({ status: 'FAILED', solverStatus: null }));
          await service.get(JOB_ID, noHr());
          tx.optimizationJob.findMany.mockResolvedValue([wishRun()]);
          const history = await service.list(YEAR_ID, noHr());

          expect(history[0]!.supersededBy).toBeNull();
          expect(tx.scheduleChangeLog.findMany).not.toHaveBeenCalled();
        });
      });

      it('names nobody a read does not find: a teacher RLS hides, or gone', async () => {
        tx.optimizationJob.findUnique.mockResolvedValue(wishRun());

        const view = await service.get(JOB_ID, noHr());

        expect(view.notes[0]!.resourceNames).toEqual([]);
      });
    });

    describe('the view', () => {
      it('is a whitelist: nothing kept for the server, and no id of a note, leaves', () => {
        const { view } = jobView(
          row({
            conflicts: [{ ...lunchConflict, subjectIds: [EVA], resourceIds: [RULE], extra: 'kept' }],
            notes: [{ ...wishNote(), resourceIds: [RULE], extra: 'kept' }],
          }) as never,
          null,
          new Map([[EVA, 'Eva Ek']]),
        );

        expect(view.conflicts).toEqual([lunchConflict]);
        expect(view.notes).toEqual([
          {
            category: 'AVAILABILITY',
            code: 'TEACHER_FREE_DAY_WISH_NOT_KEPT',
            params: { day: 5 },
            message: 'A teacher wishes Fridays free …',
            resourceNames: ['Eva Ek'],
          },
        ]);
      });

      it('names a note’s teacher only from the names it is given, after any name the note kept', () => {
        const run = row({
          notes: [
            wishNote({ resourceNames: ['Kept'] }),
            // A hand-edited row: a number is nobody, and an id with no name
            // (a teacher since removed) names nobody either.
            wishNote({ subjectIds: [42, 'gone'] }),
            wishNote({ subjectIds: 'not a list' }),
          ],
        });

        expect(jobView(run as never, null).view.notes.map((note) => note.resourceNames)).toEqual([['Kept'], [], []]);
        expect(
          jobView(run as never, null, new Map([[EVA, 'Eva Ek']])).view.notes.map((note) => note.resourceNames),
        ).toEqual([['Kept', 'Eva Ek'], [], []]);
      });

      it('drops a conflict’s params that are not scalars, and its code and params when it has none', () => {
        const { view } = jobView(
          row({
            conflicts: [
              { category: 'ROOM_OVERLAP', message: 'clash', params: { room: 'Aulan', nested: { deep: true } } },
              { category: 'ROOM_OVERLAP', message: 'old' },
            ],
          }) as never,
          null,
        );

        expect(view.conflicts).toEqual([
          { category: 'ROOM_OVERLAP', message: 'clash', params: { room: 'Aulan' }, resourceNames: [] },
          { category: 'ROOM_OVERLAP', message: 'old', resourceNames: [] },
        ]);
        expect(Object.keys(view.conflicts[1]!)).toEqual(['category', 'message', 'resourceNames']);
      });

      it('names the teachers who cannot make the walk for any reader, now and from the ids it keeps', () => {
        // Restid i generatorn: the sentence keeps the teachers' Users ids
        // server-side and is named when it is read, as a note is — with or
        // without HR-läs, and nobody for a teacher since removed.
        const travel = {
          category: 'TEACHER_OVERLAP',
          code: 'TEACHER_TRAVEL_CANNOT_BE_KEPT',
          params: { stepMinutes: 30, measured: 1 },
          message: 'The travel time between the school’s sites cannot be kept …',
          resourceNames: [],
          subjectIds: [EVA, 'gone'],
        };
        const run = row({ conflicts: [travel, { ...lunchConflict, subjectIds: [EVA] }] });

        for (const posts of [null, new Map()]) {
          const { view, revealed } = jobView(run as never, posts, new Map([[EVA, 'Eva Ek']]));
          expect(view.conflicts[0]).toEqual({
            category: 'TEACHER_OVERLAP',
            code: 'TEACHER_TRAVEL_CANNOT_BE_KEPT',
            params: { stepMinutes: 30, measured: 1 },
            message: travel.message,
            resourceNames: ['Eva Ek'],
          });
          // Another sentence's kept teacher is named by nothing here, and no
          // walk is a post's days: nothing for the Läslogg.
          expect(view.conflicts[1]!.resourceNames).toEqual([]);
          expect(revealed).toEqual([]);
          expect(JSON.stringify(view)).not.toMatch(new RegExp(`${EVA}|gone|subjectIds`));
        }
      });

      it('names the shared teacher another school holds, as the walk’s teachers are (Delade lokaler och lärare)', () => {
        const held = {
          category: 'AVAILABILITY',
          code: 'OTHER_SCHOOL_TEACHER_BUSY',
          params: { schools: 'Norraskolan', day: 2, start: '09:45', end: '11:15' },
          message: 'A teacher named here also teaches at Norraskolan …',
          resourceNames: [],
          subjectIds: [EVA],
        };
        const { view, revealed } = jobView(row({ conflicts: [held] }) as never, null, new Map([[EVA, 'Eva Ek']]));
        expect(view.conflicts[0]).toEqual({
          category: 'AVAILABILITY',
          code: 'OTHER_SCHOOL_TEACHER_BUSY',
          params: { schools: 'Norraskolan', day: 2, start: '09:45', end: '11:15' },
          message: held.message,
          resourceNames: ['Eva Ek'],
        });
        expect(revealed).toEqual([]);
        expect(JSON.stringify(view)).not.toMatch(new RegExp(`${EVA}|subjectIds`));
      });

      it('reads a notes column that is not a list as none', () => {
        expect(jobView(row({ notes: { unexpected: 'shape' } }) as never, null).view.notes).toEqual([]);
      });

      it('reads only Users ids out of the teachers a params blob keeps', () => {
        // A hand-edited row with something else in the list must not reach
        // the posts' read or the Läslogg as a teacher.
        const posts = new Map([[EVA, { days: 3, stretch: null, name: 'Eva Ek' }]]);
        const run = { ...preflightRow(), errorParams: { limit: POST, subjectIds: [EVA, 42] } };

        expect(jobView(run as never, posts)).toMatchObject({
          view: { errorParams: { limit: POST, days: 3 } },
          revealed: [EVA],
        });
      });

      it('says which teachers it showed the days of', () => {
        const posts = new Map([[EVA, { days: 3, stretch: null, name: 'Eva Ek' }]]);

        expect(jobView(row() as never, posts).revealed).toEqual([EVA]);
        expect(jobView(preflightRow() as never, posts).revealed).toEqual([EVA]);
        expect(jobView(row() as never, null).revealed).toEqual([]);
      });
    });

    describe('the synchronous trigger’s refusal', () => {
      const refusal = () =>
        new WorkDaysRefusal(
          {
            message: WORK_DAYS_HIDDEN_MESSAGE,
            code: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK',
            params: { limit: POST, weekMinutes: 1500 },
          },
          400,
          [EVA],
        );

      it('hands back every other error as it came', async () => {
        const error = new HttpException({ message: 'lunch', code: 'LUNCH_X', params: {} }, 400);

        await expect(service.refusalForReader(error, YEAR_ID, noHr())).resolves.toBe(error);
        await expect(service.refusalForReader('boom', YEAR_ID, hr())).resolves.toBe('boom');
        expect(prisma.withRls).not.toHaveBeenCalled();
      });

      it('words a days refusal as the hidden sentence for a reader without HR-läs', async () => {
        const answer = (await service.refusalForReader(refusal(), YEAR_ID, noHr())) as HttpException;

        expect(answer).toBeInstanceOf(HttpException);
        expect(answer).not.toBeInstanceOf(WorkDaysRefusal);
        expect(answer.getStatus()).toBe(400);
        // Exactly this, and no other key.
        expect(answer.getResponse()).toEqual({
          message: WORK_DAYS_HIDDEN_MESSAGE,
          code: TEACHER_WORK_DAYS_HIDDEN,
          params: {},
        });
        expect(Object.keys(answer.getResponse() as object)).toEqual(['message', 'code', 'params']);
        expect(prisma.withRls).not.toHaveBeenCalled();
      });

      it('words it with the post’s days for a reader with HR-läs, and logs the read', async () => {
        tx.teacherEmployment.findMany.mockResolvedValue([evasPost({ maxTeachingDaysPerWeek: 4 })]);

        const answer = (await service.refusalForReader(refusal(), YEAR_ID, hr())) as HttpException;

        expect(answer.getResponse()).toEqual({
          message: WORK_DAYS_HIDDEN_MESSAGE,
          code: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK',
          params: { limit: POST, weekMinutes: 1500, days: 4 },
        });
        // No name: problem+json carries code and params only (see refusalForReader).
        expect(Object.keys(answer.getResponse() as object)).toEqual(['message', 'code', 'params']);
        expect(tx.teacherEmployment.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              academicYearId: { in: [YEAR_ID] },
              userId: { in: [EVA] },
              OR: [{ maxTeachingDaysPerWeek: { not: null } }, { maxConsecutiveTeachingMinutes: { not: null } }],
            },
          }),
        );
        expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [EVA] }]);
      });
    });
  });
});
