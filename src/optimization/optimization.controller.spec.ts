import 'reflect-metadata';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { testUser } from '../../test/utils/prisma-mock';
import type { TriggerOptimizationDto } from './dto/trigger-optimization.dto';
import type { AiEngineScheduleResponse } from './interfaces/ai-engine-payload.interface';
import { OptimizationController } from './optimization.controller';
import type { OptimizationJobsService } from './optimization-jobs.service';
import type { OptimizationProxyService } from './optimization-proxy.service';

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const JOB_ID = '66666666-6666-4666-8666-666666666666';

describe('OptimizationController', () => {
  let proxy: { triggerScheduling: jest.Mock };
  let jobs: { start: jest.Mock; get: jest.Mock; list: jest.Mock };
  let controller: OptimizationController;

  const dto = (
    overrides: Partial<TriggerOptimizationDto> = {},
  ): TriggerOptimizationDto =>
    ({ academicYearId: YEAR_ID, ...overrides }) as TriggerOptimizationDto;

  beforeEach(() => {
    proxy = { triggerScheduling: jest.fn() };
    jobs = { start: jest.fn(), get: jest.fn(), list: jest.fn() };
    controller = new OptimizationController(
      proxy as unknown as OptimizationProxyService,
      jobs as unknown as OptimizationJobsService,
    );
  });

  describe('startJob', () => {
    it('starts a job for the DTO year with the caller as principal', async () => {
      jobs.start.mockResolvedValue({ jobId: JOB_ID });
      const user = testUser();
      const body = dto({
        weights: { spread: 3 },
        rules: { lunchMinutes: 30 },
      });

      await expect(controller.startJob(body, user)).resolves.toEqual({
        jobId: JOB_ID,
      });
      expect(jobs.start).toHaveBeenCalledWith(
        YEAR_ID,
        user,
        { spread: 3 },
        { lunchMinutes: 30 },
      );
    });

    it('passes undefined tuning through when the body omits it', async () => {
      jobs.start.mockResolvedValue({ jobId: JOB_ID });
      const user = testUser();

      await controller.startJob(dto(), user);

      expect(jobs.start).toHaveBeenCalledWith(
        YEAR_ID,
        user,
        undefined,
        undefined,
      );
    });
  });

  describe('listJobs', () => {
    it('returns the run history for the queried year and caller', async () => {
      const history = [{ id: JOB_ID, status: 'SUCCEEDED' }];
      jobs.list.mockResolvedValue(history);
      const user = testUser();

      await expect(controller.listJobs(YEAR_ID, user)).resolves.toBe(history);
      expect(jobs.list).toHaveBeenCalledWith(YEAR_ID, user);
    });
  });

  describe('getJob', () => {
    it('returns the job view for the path id and caller', async () => {
      const view = { id: JOB_ID, status: 'RUNNING' };
      jobs.get.mockResolvedValue(view);
      const user = testUser();

      await expect(controller.getJob(JOB_ID, user)).resolves.toBe(view);
      expect(jobs.get).toHaveBeenCalledWith(JOB_ID, user);
    });
  });

  describe('trigger', () => {
    const engineResponse = (
      overrides: Partial<AiEngineScheduleResponse> = {},
    ): AiEngineScheduleResponse => ({
      requestId: 'req-1',
      status: 'OPTIMAL',
      lessons: [],
      conflicts: null,
      ...overrides,
    });

    it('returns only the solver verdict and the lesson count', async () => {
      proxy.triggerScheduling.mockResolvedValue(
        engineResponse({
          status: 'OPTIMAL',
          lessons: [
            {
              requirementId: 'anon-1',
              roomId: null,
              dayOfWeek: 1,
              startTime: '08:00:00',
              endTime: '09:00:00',
            },
            {
              requirementId: 'anon-2',
              roomId: null,
              dayOfWeek: 2,
              startTime: '10:00:00',
              endTime: '11:00:00',
            },
          ],
          conflicts: { summary: 'internal detail', conflicts: [] },
        }),
      );

      // Anonymous lesson placements and conflict analysis stay server-side;
      // the sync endpoint's contract is just { status, lessonsGenerated }.
      await expect(controller.trigger(dto(), testUser())).resolves.toEqual({
        status: 'OPTIMAL',
        lessonsGenerated: 2,
      });
    });

    it('SUSPECTED BUG (pinned): the sync endpoint silently drops weights and rules', async () => {
      // TriggerOptimizationDto accepts weights/rules on both POST /jobs and
      // POST /trigger, but trigger() forwards only the academicYearId — the
      // caller's tuning is ignored without an error. Pinning current
      // behaviour; if intentional, the DTO for /trigger should not accept
      // the fields.
      proxy.triggerScheduling.mockResolvedValue(engineResponse());
      const user = testUser();

      await controller.trigger(
        dto({ weights: { spread: 9 }, rules: { lunchMinutes: 45 } }),
        user,
      );

      expect(proxy.triggerScheduling).toHaveBeenCalledWith(YEAR_ID, user);
    });

    it('propagates a solver failure to the caller', async () => {
      proxy.triggerScheduling.mockRejectedValue(
        new Error('AI engine unavailable.'),
      );

      await expect(controller.trigger(dto(), testUser())).rejects.toThrow(
        'AI engine unavailable.',
      );
    });
  });

  describe('access control metadata', () => {
    it('restricts the whole controller to school and platform admins', () => {
      // The Roles decorator is the RBAC boundary for every optimization route;
      // RolesGuard reads exactly this metadata.
      expect(Reflect.getMetadata(ROLES_KEY, OptimizationController)).toEqual([
        Role.SCHOOL_ADMIN,
        Role.SYSTEM_ADMIN,
      ]);
    });
  });
});
