import { ServiceUnavailableException } from '@nestjs/common';
import type { PrismaService } from '../database/prisma.service';
import type { JobRunner } from '../jobs/job-runner';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let prisma: { $queryRaw: jest.Mock };
  let controller: HealthController;

  beforeEach(() => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]) };
    controller = new HealthController(prisma as unknown as PrismaService);
  });

  describe('liveness', () => {
    it('reports ok without touching the database', () => {
      expect(controller.liveness()).toEqual({
        status: 'ok',
        uptimeSeconds: expect.any(Number),
      });
      // The whole point of a separate liveness probe: a database outage must
      // not make every container look dead.
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('reports uptime as whole seconds', () => {
      jest.spyOn(process, 'uptime').mockReturnValue(42.987);
      expect(controller.liveness().uptimeSeconds).toBe(42);
    });
  });

  describe('readiness', () => {
    it('reports ready when the database answers', async () => {
      await expect(controller.readiness()).resolves.toEqual({
        status: 'ready',
        database: 'up',
      });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('returns 503 when the database is unreachable', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(controller.readiness()).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('does not leak the driver error to the caller', async () => {
      // Driver errors embed the connection string, including credentials.
      prisma.$queryRaw.mockRejectedValue(
        new Error('connect ECONNREFUSED postgresql://user:hunter2@db:5432/app'),
      );

      await expect(controller.readiness()).rejects.toThrow(
        'Database is unreachable.',
      );
      await expect(controller.readiness()).rejects.not.toThrow(/hunter2/);
    });

    it('adds the background jobs as three counts, and nothing when the ledger cannot be read', async () => {
      const jobs = { readiness: jest.fn().mockResolvedValue({ scheduled: 4, failing: 1, overdue: 0 }) };
      const withJobs = new HealthController(prisma as unknown as PrismaService, jobs as unknown as JobRunner);
      await expect(withJobs.readiness()).resolves.toEqual({
        status: 'ready',
        database: 'up',
        jobs: { scheduled: 4, failing: 1, overdue: 0 },
      });
      // A failing job is not a reason to drain the instance.
      jobs.readiness.mockResolvedValueOnce(null);
      await expect(withJobs.readiness()).resolves.toEqual({ status: 'ready', database: 'up' });
    });

    it('asks the database before the jobs, so an outage is still a 503', async () => {
      const jobs = { readiness: jest.fn() };
      prisma.$queryRaw.mockRejectedValue(new Error('ECONNREFUSED'));
      const withJobs = new HealthController(prisma as unknown as PrismaService, jobs as unknown as JobRunner);
      await expect(withJobs.readiness()).rejects.toThrow(ServiceUnavailableException);
      expect(jobs.readiness).not.toHaveBeenCalled();
    });
  });
});
