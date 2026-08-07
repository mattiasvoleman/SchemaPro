import { NotFoundException } from '@nestjs/common';
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
      await expect(
        service.start(YEAR_ID, testUser({ schoolId: undefined })),
      ).rejects.toThrow(NotFoundException);
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
            conflicts: [
              {
                category: 'GROUP_OVERLAP',
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
          // Only category + message survive; the anonymous-id arrays from the
          // engine's conflict details must not be persisted on the job row.
          conflicts: [
            { category: 'GROUP_OVERLAP', message: 'Group overlaps itself' },
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
          finishedAt: expect.any(Date),
        },
      });
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

    it('SUSPECTED BUG (pinned): a failed RUNNING update escapes the fire-and-forget', async () => {
      // The `await this.update(jobId, user, { status: 'RUNNING' })` sits
      // OUTSIDE run()'s try/catch, and start() invokes run() as
      // `void this.run(...)`. A rejection here therefore becomes an unhandled
      // promise rejection (fatal by default on Node >= 15) instead of being
      // captured on the job row like every other failure. This test pins the
      // current behaviour; the fix belongs in production code.
      tx.optimizationJob.update.mockRejectedValue(new Error('db down'));

      await expect(runPrivate()).rejects.toThrow('db down');
      expect(proxy.triggerScheduling).not.toHaveBeenCalled();
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
        conflicts: [{ category: 'ROOM_OVERLAP', message: 'clash' }],
        error: null,
        createdAt: '2026-08-07T10:00:00.000Z',
        finishedAt: '2026-08-07T10:00:42.000Z',
      });
    });

    it('looks the job up by id under the caller RLS session', async () => {
      tx.optimizationJob.findUnique.mockResolvedValue(row());
      const user = testUser();

      await service.get(JOB_ID, user);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
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
          conflicts: [],
          error: 'The AI engine returned an error.',
          createdAt: '2026-08-07T09:00:00.000Z',
          finishedAt: null,
        },
      ]);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
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
