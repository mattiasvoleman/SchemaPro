/**
 * Generera som kö (20270222090000) through the real OptimizationJobsService, against Postgres, as the API's role:
 *
 *   gq-a  a start claims the year: the first heartbeat makes the row RUNNING, names this process as the claimant and takes a lease
 *         270 s long (the API's wait of 240 s and thirty seconds) from the database's clock; the page's read of it is a running run
 *         with the wait the page quotes, and carries no claimant and no lease;
 *   gq-b  a second start of the year is refused 409 GENERATE_ALREADY_RUNNING by the partial unique index, and the adapter's own
 *         shape of the refusal is the one isUniqueViolation reads (P2002, or P2010 with 23505 in the cause); one active run is left;
 *   gq-c  two starts at once, of a year with none going, are one run and one 409, never two runs and never SCHEDULE_BUSY;
 *   gq-d  a renewal is the compare-and-set the service says it is: it moves the heartbeat and the lease of an active run through
 *         the adapter (the lease passed as a number to make_interval), and changes nothing of a run that has ended;
 *   gq-e  a run whose lease has run out is read as FAILED ENGINE_RUN_ABANDONED before the sweep has come round, the sweep then makes
 *         it so (finished when the lease ran out) and answers a number the adapter decodes, and a start that finds such a run
 *         sweeps it first and goes through;
 *   gq-f  the sweep skips a row another transaction holds (a heartbeat in flight) without waiting for it, takes no row that a
 *         heartbeat committed in the meantime made alive, and takes the same row once it is let go of and still dead;
 *   gq-g  the sweep's door refuses a login through the adapter (GQ403 in the cause of a P2010), and the job's own path, with no
 *         claims, runs it;
 *   gq-h  a run the sweep gave up on while its engine call was still going, which then comes back, ends SUCCEEDED and loses the
 *         abandonment it was given: what happened wins over what was guessed;
 *   gq-i  a restart that can say so (onModuleDestroy) fails the run in flight with ENGINE_RUN_ABANDONED and frees the year at once.
 *   gq-j  a start works whatever the API's clock says: heartbeatAt and leaseUntil are both filled by the database's clock, which the
 *         CHECK OptimizationJobs_lease_follows_the_heartbeat compares.
 *
 * Everything is decided by the database's state: a lease is planted as a time relative to the database's own clock, and nothing
 * waits for one to run out. The one step across a real clock jump (the service's own run, then the database's clock moved on and
 * the sweep) was run by hand on the clock-shim image, and is described in docs/DEPLOYMENT.md §27.7.
 */
import { strict as assert } from 'node:assert';
import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { INSTANCE_NAME, isUniqueViolation } from '../../src/optimization/generate-runs';
import type { AiEngineScheduleResponse } from '../../src/optimization/interfaces/ai-engine-payload.interface';
import { OptimizationJobsService } from '../../src/optimization/optimization-jobs.service';
import type { OptimizationProxyService } from '../../src/optimization/optimization-proxy.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function generateQueueSlug(marker: string): string {
  return `${marker}-generera-ko`;
}

export async function sweepGenerateQueueSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [generateQueueSlug(marker)]);
}

interface Row {
  status: string;
  claimedBy: string | null;
  error: string | null;
  errorCode: string | null;
  lease: number;
  fresh: boolean;
  ended: boolean;
  finishedIsLeaseEnd: boolean;
}

const ANSWER = (): AiEngineScheduleResponse =>
  ({ requestId: 'probe', status: 'OPTIMAL', lessons: [], conflicts: null }) as unknown as AiEngineScheduleResponse;

export async function generateQueueChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepGenerateQueueSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const school = (
    await one<{ id: string }>(
      `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
      [`${marker} generera-kö`, generateQueueSlug(marker)],
    )
  ).id;
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
       VALUES ($1, 'probe generera-kö', '2095-08-17', '2096-06-12', true, 'NIOARIG', now()) RETURNING id`,
      [school],
    )
  ).id;
  // An earlier year of the same school, not the active one: the index is per year, not per school.
  const earlierYear = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
       VALUES ($1, 'probe generera-kö, året före', '2094-08-17', '2095-06-12', false, 'NIOARIG', now()) RETURNING id`,
      [school],
    )
  ).id;
  const adminRow = await one<{ id: string; authId: string }>(
    `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
     VALUES ($1, $2, 'Gerd', 'Kö', 'SCHOOL_ADMIN', 'FULL', gen_random_uuid(), true, now()) RETURNING id, "authId"`,
    [school, `${marker}-generera-ko@example.invalid`],
  );
  const admin: AuthenticatedUser = {
    authId: adminRow.authId,
    userId: adminRow.id,
    schoolId: school,
    role: Role.SCHOOL_ADMIN,
    adminProfile: 'FULL',
  };

  // The engine, answered by hand: every call waits for the probe to say so.
  const calls: Array<(response?: AiEngineScheduleResponse) => void> = [];
  const refuseCalls: Array<(error: Error) => void> = [];
  const proxy = {
    waitSeconds: 240,
    triggerScheduling: () =>
      new Promise<AiEngineScheduleResponse>((resolve, reject) => {
        calls.push((response = ANSWER()) => resolve(response));
        refuseCalls.push(reject);
      }),
  } as unknown as OptimizationProxyService;
  const jobs = new OptimizationJobsService(proxy, api);

  const row = async (id: string): Promise<Row> =>
    one<Row>(
      `SELECT status::text AS status, "claimedBy", error, "errorCode",
              extract(epoch FROM "leaseUntil" - "heartbeatAt")::float8 AS lease,
              abs(extract(epoch FROM now() - "heartbeatAt")) < 30 AS fresh,
              "finishedAt" IS NOT NULL AS ended,
              "finishedAt" = "leaseUntil" AS "finishedIsLeaseEnd"
         FROM "OptimizationJobs" WHERE id = $1`,
      [id],
    );
  const active = async (): Promise<number> =>
    Number((await one<{ n: string }>(`SELECT count(*) AS n FROM "OptimizationJobs" WHERE "academicYearId" = $1 AND status IN ('PENDING', 'RUNNING')`, [year])).n);
  const until = async (what: string, done: () => Promise<boolean>): Promise<void> => {
    for (let tries = 0; tries < 200; tries++) {
      if (await done()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`never: ${what}`);
  };
  const answerAll = () => {
    for (const answer of calls.splice(0)) answer();
    refuseCalls.length = 0;
  };
  /** Every run of the year ended: the way back to a year with none going. */
  const settle = async () => {
    answerAll();
    await until('every run of the year has ended', async () => (await active()) === 0);
  };
  const plantDead = async (): Promise<string> =>
    (
      await one<{ id: string }>(
        `INSERT INTO "OptimizationJobs" ("schoolId", "academicYearId", "actorId", status, "createdAt", "heartbeatAt", "leaseUntil")
         VALUES ($1, $2, $3, 'RUNNING', now() - interval '6 minutes', now() - interval '5 minutes', now() - interval '30 seconds') RETURNING id`,
        [school, year, adminRow.id],
      )
    ).id;
  const causeCode = (error: unknown): string | undefined =>
    (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } }).meta?.driverAdapterError?.cause?.originalCode;

  try {
    let first = '';

    await check('(gq-a) a start claims the year: RUNNING, this process, and a lease of the API’s wait and thirty seconds from the database’s clock', async () => {
      first = (await jobs.start(year, admin)).jobId;
      await until('the first heartbeat', async () => (await row(first)).status === 'RUNNING');
      const stored = await row(first);
      assert.equal(stored.claimedBy, INSTANCE_NAME);
      assert.equal(stored.lease, 270);
      assert.equal(stored.fresh, true, 'the heartbeat is the database’s now');
      assert.equal(stored.ended, false);
      assert.equal(calls.length, 1, 'the engine was asked once, after the heartbeat');
      const view = await jobs.get(first, admin);
      assert.equal(view.status, 'RUNNING');
      assert.equal(view.waitSeconds, 240);
      assert.deepEqual(Object.keys(view).filter((key) => /claimed|lease|heartbeat/i.test(key)), [], 'no claimant and no lease on the wire');
      assert.equal(await active(), 1);
    });

    await check('(gq-b) a second start of the year is 409 GENERATE_ALREADY_RUNNING, by the index, in the shape isUniqueViolation reads', async () => {
      await assert.rejects(jobs.start(year, admin), (error: unknown) => {
        assert.ok(error instanceof HttpException);
        assert.equal(error.getStatus(), 409);
        assert.equal((error.getResponse() as { code?: string }).code, 'GENERATE_ALREADY_RUNNING');
        return true;
      });
      // What the adapter makes of the insert itself: the shape the gateway's mapping depends on, which no mock can say.
      let shape: unknown;
      try {
        await api.withRls(admin, (tx) => tx.optimizationJob.create({ data: { schoolId: school, academicYearId: year, actorId: adminRow.id, status: 'PENDING' }, select: { id: true } }));
      } catch (error) {
        shape = error;
      }
      assert.ok(shape instanceof Prisma.PrismaClientKnownRequestError, 'the insert was refused as a known request error');
      assert.ok(isUniqueViolation(shape), `${(shape as Prisma.PrismaClientKnownRequestError).code} is read as a unique violation`);
      assert.ok(['P2002', 'P2010'].includes((shape as Prisma.PrismaClientKnownRequestError).code));
      assert.equal(await active(), 1);
      assert.equal(calls.length, 1, 'no second solve was started');
    });

    await check('(gq-c) two starts at once are one run and one 409, never two runs and never SCHEDULE_BUSY', async () => {
      await settle();
      assert.equal((await row(first)).status, 'SUCCEEDED');
      const outcomes = await Promise.allSettled([jobs.start(year, admin), jobs.start(year, admin)]);
      const started = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const refused = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      assert.equal(started.length, 1, JSON.stringify(outcomes.map((outcome) => outcome.status)));
      assert.equal(refused.length, 1);
      assert.ok(refused[0]!.reason instanceof HttpException);
      assert.equal(refused[0]!.reason.getStatus(), 409);
      assert.equal((refused[0]!.reason.getResponse() as { code?: string }).code, 'GENERATE_ALREADY_RUNNING');
      assert.equal(await active(), 1);
      await until('its first heartbeat', async () => calls.length >= 1);
    });

    await check('(gq-c2) a second year of the same school runs at once: the index is per year, not per school', async () => {
      await settle();
      const a = (await jobs.start(year, admin)).jobId;
      const b = (await jobs.start(earlierYear, admin)).jobId;
      assert.notEqual(a, b);
      await until('both have their first heartbeat', async () => (await row(a)).status === 'RUNNING' && (await row(b)).status === 'RUNNING');
      assert.equal(await active(), 1, 'one in the active year');
      assert.equal(Number((await one<{ n: string }>(`SELECT count(*) AS n FROM "OptimizationJobs" WHERE "academicYearId" = $1 AND status = 'RUNNING'`, [earlierYear])).n), 1, 'and one in the year before');
      // Each year refuses its own second start.
      for (const y of [year, earlierYear]) {
        await assert.rejects(jobs.start(y, admin), (error: unknown) => {
          assert.ok(error instanceof HttpException);
          assert.equal((error.getResponse() as { code?: string }).code, 'GENERATE_ALREADY_RUNNING');
          return true;
        });
      }
      await settle();
      await until('the earlier year’s run ended', async () => (await row(b)).status === 'SUCCEEDED');
    });

    await check('(gq-d) a renewal moves an active run’s heartbeat and lease through the adapter, and leaves a run that ended alone', async () => {
      const running = (await jobs.start(year, admin)).jobId;
      await until('its first heartbeat', async () => (await row(running)).status === 'RUNNING');
      await owner.query(`UPDATE "OptimizationJobs" SET "heartbeatAt" = now() - interval '100 seconds', "leaseUntil" = now() - interval '10 seconds' WHERE id = $1`, [running]);
      const renewed = await (jobs as unknown as { beat: (id: string, user: AuthenticatedUser) => Promise<boolean> }).beat(running, admin);
      assert.equal(renewed, true);
      const after = await row(running);
      assert.equal(after.lease, 270);
      assert.equal(after.fresh, true);
      assert.equal(after.claimedBy, INSTANCE_NAME);
      await settle();
      const ended = await (jobs as unknown as { beat: (id: string, user: AuthenticatedUser) => Promise<boolean> }).beat(running, admin);
      assert.equal(ended, false, 'a run that has ended is not renewed');
      assert.equal((await row(running)).status, 'SUCCEEDED');
    });

    await check('(gq-e) a run past its lease is read as abandoned before the sweep, made so by it, and a start sweeps it first', async () => {
      const dead = await plantDead();
      const view = await jobs.get(dead, admin);
      assert.equal(view.status, 'FAILED');
      assert.equal(view.errorCode, 'ENGINE_RUN_ABANDONED');
      assert.equal((await row(dead)).status, 'RUNNING', 'the row itself is the sweep’s to change');
      assert.equal(
        (await jobs.list(year, admin)).find((entry) => entry.id === dead)?.status,
        'FAILED',
        'and the history reads it the same',
      );
      assert.equal(await jobs.sweep(), 1);
      const swept = await row(dead);
      assert.equal(swept.status, 'FAILED');
      assert.equal(swept.errorCode, 'ENGINE_RUN_ABANDONED');
      assert.equal(swept.finishedIsLeaseEnd, true, 'finished when the lease ran out');
      assert.equal(await jobs.sweep(), 0, 'a second sweep has nothing to do');

      // A start that finds a dead run that nobody has swept: the sweep first, then the year is free.
      const another = await plantDead();
      assert.equal(await active(), 1);
      const started = (await jobs.start(year, admin)).jobId;
      assert.equal((await row(another)).status, 'FAILED');
      await until('its heartbeat', async () => (await row(started)).status === 'RUNNING');
      await settle();
    });

    await check('(gq-f) the sweep skips a row a heartbeat holds, takes none that a heartbeat made alive, and takes a held one let go of while dead', async () => {
      const dead = await plantDead();
      // The holder: a second owner connection with the row locked, as a heartbeat's own transaction holds it.
      const side = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
      await side.connect();
      try {
        await side.query('BEGIN');
        await side.query(`SELECT id FROM "OptimizationJobs" WHERE id = $1 FOR UPDATE`, [dead]);
        const started = Date.now();
        assert.equal(await jobs.sweep(), 0, 'a row another transaction holds is skipped');
        assert.ok(Date.now() - started < 3000, 'and not waited for');
        // The heartbeat commits: the run is alive again, and the sweep takes nothing.
        await side.query(`UPDATE "OptimizationJobs" SET "heartbeatAt" = now(), "leaseUntil" = now() + interval '270 seconds' WHERE id = $1`, [dead]);
        await side.query('COMMIT');
        assert.equal(await jobs.sweep(), 0, 'a run a heartbeat made alive is not abandoned');
        assert.equal((await row(dead)).status, 'RUNNING');
        // A hold let go of with the run still dead: taken.
        await owner.query(`UPDATE "OptimizationJobs" SET "heartbeatAt" = now() - interval '5 minutes', "leaseUntil" = now() - interval '30 seconds' WHERE id = $1`, [dead]);
        await side.query('BEGIN');
        await side.query(`SELECT id FROM "OptimizationJobs" WHERE id = $1 FOR UPDATE`, [dead]);
        assert.equal(await jobs.sweep(), 0);
        await side.query('ROLLBACK');
        assert.equal(await jobs.sweep(), 1);
        assert.equal((await row(dead)).status, 'FAILED');
      } finally {
        await side.end();
      }
    });

    await check('(gq-g) the sweep’s door refuses a login through the adapter, and the job’s own path, with no claims, runs it', async () => {
      let refusal: unknown;
      try {
        await api.withRls(admin, (tx) => tx.$queryRaw`SELECT app.optimization_jobs_sweep() AS "changed"`);
      } catch (error) {
        refusal = error;
      }
      assert.ok(refusal instanceof Prisma.PrismaClientKnownRequestError, 'refused');
      assert.equal(causeCode(refusal), 'GQ403', (refusal as Error).message);
      const rows = await api.withDeliveryService((tx) => tx.$queryRaw<{ changed: number }[]>`SELECT app.optimization_jobs_sweep() AS "changed"`);
      assert.equal(typeof rows[0]!.changed, 'number', 'the adapter decodes the count as a number');
    });

    await check('(gq-h) a run the sweep gave up on, which then comes back, ends SUCCEEDED and loses the abandonment', async () => {
      const id = (await jobs.start(year, admin)).jobId;
      await until('its heartbeat', async () => (await row(id)).status === 'RUNNING');
      await owner.query(`UPDATE "OptimizationJobs" SET "heartbeatAt" = now() - interval '5 minutes', "leaseUntil" = now() - interval '30 seconds' WHERE id = $1`, [id]);
      assert.equal(await jobs.sweep(), 1);
      assert.equal((await row(id)).errorCode, 'ENGINE_RUN_ABANDONED');
      assert.equal(await active(), 0, 'the year is free while its engine call is still going');
      answerAll();
      await until('the run writes its own end', async () => (await row(id)).status === 'SUCCEEDED');
      const done = await row(id);
      assert.equal(done.errorCode, null);
      assert.equal(done.error, null);
    });

    await check('(gq-i) a restart that can say so fails the run in flight with ENGINE_RUN_ABANDONED and frees the year at once', async () => {
      const id = (await jobs.start(year, admin)).jobId;
      await until('its heartbeat', async () => (await row(id)).status === 'RUNNING');
      assert.deepEqual(jobs.running, [id]);
      await jobs.onModuleDestroy();
      const stored = await row(id);
      assert.equal(stored.status, 'FAILED');
      assert.equal(stored.errorCode, 'ENGINE_RUN_ABANDONED');
      assert.equal(stored.ended, true);
      assert.deepEqual(jobs.running, []);
      assert.equal(await active(), 0);
      answerAll();
      await until('the run that was in flight ends', async () => (await row(id)).status === 'SUCCEEDED');
    });

    await check('(gq-j) a start works whatever the API’s clock says: the heartbeat and the lease are filled by the database, one clock for both', async () => {
      // OptimizationJobs_lease_follows_the_heartbeat compares leaseUntil (the database's now() + 15 minutes) with heartbeatAt. A heartbeatAt
      // that Prisma fills from the API's clock (@default(now())) breaks every start once that clock leads the database's by the
      // lease's fifteen minutes (23514, a 500): the API's clock is moved twenty minutes on, and a start must still go through.
      const RealDate = Date;
      const lead = 20 * 60_000;
      class LeadingDate extends RealDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) super(RealDate.now() + lead);
          else super(...(args as [string | number | Date]));
        }
        static override now(): number {
          return RealDate.now() + lead;
        }
      }
      let id = '';
      (globalThis as { Date: DateConstructor }).Date = LeadingDate as unknown as DateConstructor;
      try {
        id = (await jobs.start(year, admin)).jobId;
      } finally {
        (globalThis as { Date: DateConstructor }).Date = RealDate;
      }
      await until('its heartbeat', async () => (await row(id)).status === 'RUNNING');
      assert.equal((await row(id)).lease, 270);
      await settle();
    });
  } finally {
    answerAll();
    await jobs.onModuleDestroy().catch(() => undefined);
    await sweepGenerateQueueSchool(owner, marker);
  }
}
