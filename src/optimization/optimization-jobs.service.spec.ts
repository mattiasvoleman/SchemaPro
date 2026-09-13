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
import { OptimizationJobsService } from './optimization-jobs.service';
import type { OptimizationProxyService } from './optimization-proxy.service';

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

      expect(tx.optimizationJob.update).toHaveBeenNthCalledWith(1, {
        where: { id: JOB_ID },
        data: { status: 'RUNNING' },
      });
      expect(tx.optimizationJob.update).toHaveBeenNthCalledWith(2, {
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
          finishedAt: expect.any(Date),
        },
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
      tx.optimizationJob.update
        .mockResolvedValueOnce({}) // RUNNING
        .mockRejectedValue(new Error('db down')); // FAILED write also fails

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
        .mockResolvedValueOnce({}) // RUNNING
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

    it('records a failed RUNNING update on the job row instead of rejecting', async () => {
      // The RUNNING write once sat outside run()'s try/catch, so its rejection
      // escaped into `void this.run(...)` in start() — an unhandled rejection,
      // which Node answers by killing the API for every school on the instance.
      // It has to be contained like every other failure in the run.
      tx.optimizationJob.update
        .mockRejectedValueOnce(new Error('db down')) // RUNNING
        .mockResolvedValueOnce({}); // FAILED

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
        conflicts: [{ category: 'ROOM_OVERLAP', message: 'clash', resourceNames: [] }],
        error: null,
        errorCode: null,
        errorParams: null,
        createdAt: '2026-08-07T10:00:00.000Z',
        finishedAt: '2026-08-07T10:00:42.000Z',
      });
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
          conflicts: [],
          error: 'The AI engine returned an error.',
          errorCode: null,
          errorParams: null,
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
});
