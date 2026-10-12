import { Controller, Get, Optional, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../database/prisma.service';
import { JobRunner, type JobsReadiness } from '../jobs/job-runner';

export interface LivenessResult {
  status: 'ok';
  uptimeSeconds: number;
}

export interface ReadinessResult {
  status: 'ready';
  database: 'up';
  /**
   * The background jobs, as counts (src/jobs): how many this process runs,
   * how many failed their last pass and how many no instance has finished a
   * pass of in three intervals. Absent when the job ledger cannot be read.
   * Never part of the verdict: a stuck nightly job does not stop the API
   * from serving.
   */
  jobs?: JobsReadiness;
}

/**
 * Container and load-balancer probes.
 *
 * Liveness and readiness are deliberately separate:
 *
 *   GET /health        — is this process alive? Touches nothing external.
 *   GET /health/ready  — can it serve traffic? Requires the database.
 *
 * Conflating them is a self-inflicted outage: if liveness depended on the
 * database, a brief Postgres blip would make every orchestrator kill every
 * container simultaneously, turning a recoverable dependency failure into a
 * full restart storm. Readiness is the probe that should drain a pod.
 *
 * Both routes are `@Public()` (no bearer token — a probe has no principal) and
 * `@SkipThrottle()` (a 15-second probe interval must never consume a tenant's
 * rate-limit budget or start failing under load).
 *
 * Neither response carries version, hostname, or dependency detail: these
 * endpoints are typically reachable from outside the cluster, and there is no
 * reason to hand an unauthenticated caller a fingerprint of the deployment.
 * The jobs line on readiness is three numbers for the same reason: no job
 * name, school, time or error.
 */
@Controller('health')
@Public()
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly jobs?: JobRunner,
  ) {}

  @Get()
  liveness(): LivenessResult {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  @Get('ready')
  async readiness(): Promise<ReadinessResult> {
    try {
      // Cheapest possible round trip that proves the pool can reach Postgres
      // and get a row back. Deliberately not a table read: an empty or
      // RLS-filtered result would be indistinguishable from a healthy one.
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      // The underlying driver error can contain the connection string; never
      // surface it on an unauthenticated endpoint.
      throw new ServiceUnavailableException('Database is unreachable.');
    }
    const jobs = this.jobs ? await this.jobs.readiness() : null;
    return jobs ? { status: 'ready', database: 'up', jobs } : { status: 'ready', database: 'up' };
  }
}
