/**
 * PrismaService under @prisma/adapter-pg, against a real PostgreSQL, connected
 * as the role the API uses.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=2' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *     npx ts-node --transpile-only scripts/test/prisma-adapter-probe.ts
 *
 * Exits non-zero on the first failed assertion and names it, so it works as a
 * CI gate (the rls job runs it after scripts/test/run-rls-tests.sh).
 *
 * WHY IT EXISTS. The RLS suite proves the policies through psql, and the e2e
 * suite mocks PrismaService. Neither runs the layer between the two, and
 * Prisma 7 replaced all of it: the Rust engine and its pool became
 * @prisma/adapter-pg on pg's pool. Every guarantee PrismaService documents is a
 * guarantee about what that layer does with a transaction, so each one is
 * asserted here against the database itself, through the real PrismaService
 * and the real services.
 *
 * DETERMINISTIC ON PURPOSE. Nothing here waits on a clock. A connection is
 * reused because the pool has one, and the backend pid confirms it was. A lock
 * is observed while its holder is parked on a promise the probe resolves, and
 * the conflict is asked with NOWAIT, which answers at once. Checks that are
 * races by nature — a transaction outliving its timeout, an exhausted pool —
 * stay out of this file.
 *
 * WHAT IT NEEDS. Migrations, `npm run db:seed` and run-rls-tests.sh, in CI's
 * order: the seed gives the demo school and its admin, the RLS fixtures a
 * second school whose academic year the admin must not reach. The owner URL
 * only finds those ids (the app role sees nothing without a principal) and
 * sweeps up what the probe wrote; every assertion runs as app_authenticated.
 * The rows the probe needs are created through the services, under RLS, and
 * swept away whether it passes or not — before it starts too, in case an
 * earlier run was killed half-way.
 */
import { strict as assert } from 'node:assert';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { throwError } from 'rxjs';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { createPgAdapter } from '../../src/database/pool-config';
import { PrismaService } from '../../src/database/prisma.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { readYearBoundsForShare } from '../../src/resources/academic-year-bounds';
import { AcademicYearsService } from '../../src/resources/academic-years.service';
import { AvailabilityConstraintsService } from '../../src/resources/availability-constraints.service';
import { Ss12000Service } from '../../src/integration/ss12000.service';
import type { UpdateAcademicYearDto } from '../../src/resources/dto/academic-year.dto';
import type {
  CreateFrameTimeDto,
  UpdateFrameTimeDto,
} from '../../src/resources/dto/frame-time.dto';
import type { CreateLunchServingDto } from '../../src/resources/dto/lunch-serving.dto';
import type { CreateRastDto } from '../../src/resources/dto/rast.dto';
import { FrameTimesService } from '../../src/resources/frame-times.service';
import { LunchServingsService } from '../../src/resources/lunch-servings.service';
import { RastsService } from '../../src/resources/rasts.service';
import { StudentGroupsService } from '../../src/resources/student-groups.service';
import type { CreateRoomBookingDto } from '../../src/room-bookings/dto/room-booking.dto';
import { RoomBookingsService } from '../../src/room-bookings/room-bookings.service';
import { ImportService } from '../../src/import/import.service';
import { SubjectsService } from '../../src/resources/subjects.service';
import { LocalTimplansService } from '../../src/timplan/local-timplans.service';
import { AcademicYearTimplansService } from '../../src/timplan/academic-year-timplans.service';
import { TimplanCoverageService } from '../../src/timplan/timplan-coverage.service';
import { TimplanRequirementsService } from '../../src/timplan/timplan-requirements.service';
import {
  decidedTimplanRefusal,
  isTimplanInUseRefusal,
  rethrowPrismaError,
  rolloverLinkRefusal,
  teacherDutyBlockRefusal,
} from '../../src/common/utils/prisma-errors';
import { UsersService } from '../../src/users/users.service';
import type { SupabaseAdminService } from '../../src/users/supabase-admin.service';
import { TeacherDutiesService } from '../../src/staffing/teacher-duties.service';
import { lockEmploymentsOf } from '../../src/staffing/staffing-enforcement';
import { TeachingRequirementsService } from '../../src/resources/teaching-requirements.service';
import { OptimizationProxyService } from '../../src/optimization/optimization-proxy.service';
import { YearRolloverService } from '../../src/year-rollover/year-rollover.service';

/** Marks every row the probe writes that has a text column to mark. */
const MARKER = 'prisma-adapter-probe';

/**
 * StaffingPolicies has no text column to mark, so a policy row the probe
 * creates carries a fullTimeAnnualHours no school states (2 077 of a 1..2500
 * range; Bilaga M says 1 767), and the sweep removes exactly that row.
 */
const PROBE_ANNUAL_HOURS = 2077;

/**
 * Grade 12 on a Sunday at 05:07: a window no seeded or fixture row holds, and
 * FrameTimes is unique on (school, grade span, weekday). The sweep finds the
 * probe's frames and sittings by exactly these values.
 */
const PROBE_WINDOW = {
  minGradeLevel: 12,
  maxGradeLevel: 12,
  dayOfWeek: 7,
  startTime: '05:07',
  endTime: '05:53',
} as const;

/** A booking slot no lesson reaches, and one that overlaps it. */
const SLOT = { startsAt: '2099-03-02T10:00:00.000Z', endsAt: '2099-03-02T11:00:00.000Z' };
const OVERLAPPING_SLOT = {
  startsAt: '2099-03-02T10:30:00.000Z',
  endsAt: '2099-03-02T11:30:00.000Z',
};

/** The rows the checks act on, found as the owner. */
interface Fixture {
  schoolId: string;
  admin: AuthenticatedUser & { userId: string; schoolId: string };
  roomId: string;
  constraintId: string;
  activeYearId: string;
  pupilId: string;
  foreignYearId: string;
  grundskolaVersionId: string;
}

/** What a transaction can see of the settings PrismaService puts on it. */
interface SessionSettings {
  pid: number;
  claims: string | null;
  sub: string | null;
  serviceSchoolId: string | null;
  keyLookup: string | null;
}

class ProbeFailure extends Error {
  constructor(
    readonly label: string,
    readonly failure: unknown,
  ) {
    super(label);
  }
}

async function main(): Promise<void> {
  const appUrl = requiredEnv('DATABASE_URL');
  const ownerUrl = requiredEnv('PROBE_OWNER_URL');

  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  const services: PrismaService[] = [];
  const open = (url: string): PrismaService => {
    const service = prismaServiceFor(url);
    services.push(service);
    return service;
  };

  try {
    const fixture = await findFixture(owner);
    await sweep(owner, fixture.schoolId);
    try {
      await runChecks(owner, fixture, appUrl, ownerUrl, open);
    } finally {
      await sweep(owner, fixture.schoolId);
    }
  } finally {
    for (const service of services) {
      await service.$disconnect();
    }
    await owner.end();
  }
}

async function runChecks(
  owner: Client,
  fixture: Fixture,
  appUrl: string,
  ownerUrl: string,
  open: (url: string) => PrismaService,
): Promise<void> {
  const { admin } = fixture;
  const api = open(appUrl);

  await check('(a) onModuleInit boots as app_authenticated', async () => {
    await api.onModuleInit();
    const [who] = await api.$queryRaw<{ name: string }[]>`SELECT current_user::text AS name`;
    assert.equal(who?.name, 'app_authenticated');
  });

  await check('(f) booting as the owner is refused, since the owner bypasses RLS', async () => {
    await assert.rejects(
      open(ownerUrl).onModuleInit(),
      /Refusing to start: the database role "postgres" is a superuser/,
    );
  });

  // ---- (b) settings end with their transaction, on a connection that is reused
  const single = open(withConnectionLimit(appUrl, 1));
  await single.onModuleInit();

  /** Reads the settings and which backend is answering, in one statement. */
  const readSettings = (db: Pick<PrismaClient, '$queryRaw'>) =>
    db.$queryRaw<SessionSettings[]>`
      SELECT pg_backend_pid() AS pid,
             current_setting('request.jwt.claims', true) AS claims,
             current_setting('request.jwt.claim.sub', true) AS sub,
             current_setting('app.service_school_id', true) AS "serviceSchoolId",
             current_setting('app.service_key_lookup', true) AS "keyLookup"
    `;

  const [baseline] = await single.$queryRaw<SessionSettings[]>`
    SELECT pg_backend_pid() AS pid
  `;

  /** The next transaction on the pool of one: same backend, nothing left set. */
  const assertClearedAfter = async (what: string): Promise<void> => {
    const [after] = await single.withSystemTransaction((tx) => readSettings(tx));
    assert.equal(
      after.pid,
      baseline.pid,
      `the pool of one answered from another backend after ${what}, so reuse was not tested`,
    );
    for (const key of ['claims', 'sub', 'serviceSchoolId', 'keyLookup'] as const) {
      assert.ok(
        after[key] === null || after[key] === '',
        `${key} was still ${JSON.stringify(after[key])} in the next transaction after ${what}`,
      );
    }
  };

  await check('(b) withRls claims are gone at COMMIT on the reused connection', async () => {
    const [inside] = await single.withRls(admin, (tx) => readSettings(tx));
    assert.equal(inside.sub, admin.authId, 'withRls did not set the sub claim in its transaction');
    await assertClearedAfter('withRls committed');
  });

  await check('(b) withServicePrincipal’s school is gone at COMMIT on the reused connection', async () => {
    const [inside] = await single.withServicePrincipal(fixture.schoolId, (tx) =>
      readSettings(tx),
    );
    assert.equal(inside.serviceSchoolId, fixture.schoolId);
    await assertClearedAfter('withServicePrincipal committed');
  });

  await check('(b) withServiceKeyLookup’s switch is gone at COMMIT on the reused connection', async () => {
    const [inside] = await single.withServiceKeyLookup((tx) => readSettings(tx));
    assert.equal(inside.keyLookup, 'on');
    await assertClearedAfter('withServiceKeyLookup committed');
  });

  await check('(b) a batch’s claims are gone at COMMIT on the reused connection', async () => {
    const [inside] = await single.queryWithRls(admin, (db) => readSettings(db));
    assert.equal(inside.sub, admin.authId);
    await assertClearedAfter('queryWithRls committed');
  });

  await check('(b) claims are gone after a ROLLBACK on the reused connection', async () => {
    const rolledBack = new Error('the probe rolls this transaction back');
    await assert.rejects(
      single.withRls(admin, async (tx) => {
        const [inside] = await readSettings(tx);
        assert.equal(inside.sub, admin.authId);
        throw rolledBack;
      }),
      (error: unknown) => error === rolledBack,
    );
    await assertClearedAfter('withRls rolled back');
  });

  // ---- (k) a transaction takes no statement after its end
  // Prisma's timeout ends a transaction while its plan may still be sending
  // statements; ended-transaction-guard.ts refuses them. Timing the real
  // timeout is a race, so the end is driven on the adapter directly, over a
  // pool of one: what is asserted is only what the server then shows.
  type GuardedAdapter = Awaited<ReturnType<ReturnType<typeof createPgAdapter>['connect']>>;
  type AdapterTransaction = Awaited<ReturnType<GuardedAdapter['startTransaction']>>;
  const statement = (sql: string) => ({ sql, args: [], argTypes: [] });
  const backendOf = async (tx: AdapterTransaction): Promise<number> =>
    Number((await tx.queryRaw(statement('SELECT pg_backend_pid()'))).rows[0]?.[0]);
  // Every borrowed transaction is released in its own finally, before
  // dispose(). pg-pool's end() waits for every checked-out connection, so an
  // assertion that failed while one was still out would hang the probe instead
  // of failing it. rollback() runs exactly once per transaction: pg-pool throws
  // on a second release, and the guard releases a connection whose end was
  // never answered with an error, so the pool destroys it and end() resolves.

  await check('(k) a statement after ROLLBACK is refused and never runs on the reused connection', async () => {
    const adapter = await createPgAdapter(withConnectionLimit(appUrl, 1)).connect();
    try {
      const ended = await adapter.startTransaction();
      let endedOn: number;
      try {
        endedOn = await backendOf(ended);
        await ended.executeRaw(statement('ROLLBACK'));
      } finally {
        await ended.rollback();
      }
      await assert.rejects(
        ended.queryRaw(statement(`SELECT set_config('app.probe_after_end', 'ran', false)`)),
        /Statement refused: its transaction has already ended\./,
      );

      const next = await adapter.startTransaction();
      try {
        assert.equal(await backendOf(next), endedOn, 'an answered ROLLBACK did not hand its connection on');
        const { rows } = await next.queryRaw(
          statement(`SELECT current_setting('app.probe_after_end', true)`),
        );
        assert.ok(
          rows[0]?.[0] === null || rows[0]?.[0] === '',
          `the refused statement ran on the next borrower's connection: ${JSON.stringify(rows)}`,
        );
        await next.executeRaw(statement('ROLLBACK'));
      } finally {
        await next.rollback();
      }
    } finally {
      await adapter.dispose();
    }
  });

  await check('(k) a connection released without an answered end is destroyed, not reused', async () => {
    const adapter = await createPgAdapter(withConnectionLimit(appUrl, 1)).connect();
    try {
      const abandoned = await adapter.startTransaction();
      let abandonedOn: number;
      try {
        abandonedOn = await backendOf(abandoned);
      } finally {
        // No ROLLBACK is sent: releasing without an answered end is the case.
        await abandoned.rollback();
      }

      const next = await adapter.startTransaction();
      try {
        assert.notEqual(
          await backendOf(next),
          abandonedOn,
          'the pool lent out a connection whose transaction was never ended',
        );
        await next.executeRaw(statement('ROLLBACK'));
      } finally {
        await next.rollback();
      }
    } finally {
      await adapter.dispose();
    }
  });

  // ---- (c) a batch is one transaction
  await check('(c) queryWithRls runs its claims and its query in one transaction', async () => {
    // set_config(..., true) lasts exactly as long as the transaction that ran
    // it, so the query seeing the claims IS the query sharing that transaction.
    const [seen] = await api.queryWithRls(admin, (db) => readSettings(db));
    assert.equal(seen.sub, admin.authId);
    assert.deepEqual(JSON.parse(seen.claims ?? 'null'), {
      sub: admin.authId,
      role: 'authenticated',
    });

    const schools = await api.queryWithRls(admin, (db) =>
      db.school.findMany({ select: { id: true } }),
    );
    assert.deepEqual(schools, [{ id: fixture.schoolId }], 'a model query in the batch did not run under the claims');
  });

  await check('(c) withVerifiedSubject finds the profile under the claims it sets', async () => {
    // JwtStrategy's lookup: with no claims on the statement RLS returns no row.
    const self = await api.withVerifiedSubject(admin.authId, (db) =>
      db.user.findFirst({ where: { authId: admin.authId }, select: { id: true } }),
    );
    assert.equal(self?.id, admin.userId);
  });

  await check('(c) withRls keeps every statement of its callback in one transaction', async () => {
    const txid = async (tx: PrismaClient) =>
      (await tx.$queryRaw<{ txid: string }[]>`SELECT txid_current()::text AS txid`)[0].txid;
    const [first, second] = await api.withRls(admin, async (tx) => [await txid(tx), await txid(tx)]);
    assert.equal(second, first);
  });

  // ---- (d) isolation
  await check('(d) withRls and the batches run at READ COMMITTED', async () => {
    type Isolation = { transaction_isolation: string }[];
    const [interactive] = await api.withRls(admin, (tx) =>
      tx.$queryRaw<Isolation>`SHOW transaction_isolation`,
    );
    assert.equal(interactive.transaction_isolation, 'read committed');
    const [batch] = await api.queryWithRls(admin, (db) =>
      db.$queryRaw<Isolation>`SHOW transaction_isolation`,
    );
    assert.equal(batch.transaction_isolation, 'read committed');
  });

  // ---- (e) a locking read holds until COMMIT
  await check('(e) a FOR UPDATE read inside withRls holds its row lock until COMMIT', async () => {
    const observer = open(withConnectionLimit(appUrl, 1));
    await observer.onModuleInit();

    const lockWithNowait = () =>
      observer.withRls(admin, (tx) =>
        tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "AvailabilityConstraints"
          WHERE "id" = ${fixture.constraintId}::uuid
          FOR UPDATE NOWAIT
        `,
      );
    const tableLocksOf = (pid: number) =>
      observer.$queryRaw<{ mode: string; granted: boolean }[]>`
        SELECT l.mode, l.granted
        FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid = ${pid}::int AND c.relname = 'AvailabilityConstraints'
      `;

    const locked = deferred<number>();
    const release = deferred<void>();
    const holder = api.withRls(admin, async (tx) => {
      // lockWindow's statement, availability-constraints.service.ts.
      const rows = await tx.$queryRaw<{ startTime: Date }[]>`
        SELECT "startTime", "endTime"
        FROM "AvailabilityConstraints"
        WHERE "id" = ${fixture.constraintId}::uuid
        FOR UPDATE
      `;
      assert.equal(rows.length, 1, 'the admin could not lock their own school’s constraint');
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      locked.resolve(pid);
      await release.promise;
    });
    // A holder that fails before it parks must fail the check, not hang it.
    const holderSettled = holder.then(
      () => undefined,
      (error: unknown) => error,
    );

    let pid: number;
    try {
      pid = await Promise.race([
        locked.promise,
        holderSettled.then((error) => {
          throw error ?? new Error('the holder committed before it reported its lock');
        }),
      ]);

      const held = await tableLocksOf(pid);
      assert.ok(
        held.some((lock) => lock.mode === 'RowShareLock' && lock.granted),
        `pg_locks shows no granted RowShareLock for the holder: ${JSON.stringify(held)}`,
      );
      const [activity] = await observer.$queryRaw<{ state: string }[]>`
        SELECT state FROM pg_stat_activity WHERE pid = ${pid}::int
      `;
      assert.equal(activity?.state, 'idle in transaction');
      await assert.rejects(lockWithNowait(), (error: unknown) => {
        assert.equal(
          sqlStateOf(error),
          '55P03',
          `expected lock_not_available (55P03) while the holder waits, got ${summarise(error)}`,
        );
        return true;
      });
    } finally {
      release.resolve();
    }

    const holderError = await holderSettled;
    if (holderError) throw holderError;

    const [freed] = await lockWithNowait();
    assert.equal(freed?.id, fixture.constraintId, 'the row was still locked after the holder committed');
    assert.deepEqual(await tableLocksOf(pid), [], 'the holder’s backend kept a lock past COMMIT');
  });

  // ---- (g) the exclusion constraint through RoomBookingsService
  await check('(g) an overlapping room booking is a 409, not a 500', async () => {
    const bookings = new RoomBookingsService(api, new NotificationsService());
    const booking = (slot: typeof SLOT) =>
      ({ roomId: fixture.roomId, title: MARKER, ...slot }) as CreateRoomBookingDto;

    const first = await bookings.create(booking(SLOT), admin);
    assert.equal(first.status, 'APPROVED');

    // The error the service recognises, as the adapter raises it.
    await assert.rejects(
      api.withRls(admin, (tx) =>
        tx.roomBooking.create({
          data: {
            schoolId: fixture.schoolId,
            roomId: fixture.roomId,
            bookedById: admin.userId,
            title: MARKER,
            startsAt: new Date(OVERLAPPING_SLOT.startsAt),
            endsAt: new Date(OVERLAPPING_SLOT.endsAt),
          },
        }),
      ),
      (error: unknown) => {
        assert.ok(
          error instanceof Prisma.PrismaClientKnownRequestError,
          `expected a PrismaClientKnownRequestError, got ${summarise(error)}`,
        );
        assert.equal(error.code, 'P2039', summarise(error));
        assert.match(error.message, /23P01/);
        assert.match(error.message, /RoomBookings_room_is_held_once/);
        // The message leads with the failing call and its source frame; the
        // database's own line is the last one.
        const lines = error.message.trim().split('\n');
        console.log(`       ${error.code}: ${lines[lines.length - 1]}`);
        return true;
      },
    );

    await assert.rejects(bookings.create(booking(OVERLAPPING_SLOT), admin), (error: unknown) => {
      assert.ok(error instanceof ConflictException, `expected ConflictException, got ${summarise(error)}`);
      assert.equal(error.message, 'That room is already booked for this time.');
      return true;
    });

    const { rows } = await owner.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM "RoomBookings" WHERE title = $1',
      [MARKER],
    );
    assert.equal(rows[0].n, 1, 'a refused booking was written anyway');
  });

  // ---- (h) a row RLS hides from an update
  await check('(h) an update RLS hides is P2025, and the service answers 404', async () => {
    const nameOfForeignYear = async () =>
      (
        await owner.query<{ name: string }>('SELECT name FROM "AcademicYears" WHERE id = $1', [
          fixture.foreignYearId,
        ])
      ).rows[0]?.name;
    assert.equal(await nameOfForeignYear(), 'RLS Fixture Year', 'the fixture year is not there to hide');

    await assert.rejects(
      api.withRls(admin, (tx) =>
        tx.academicYear.update({ where: { id: fixture.foreignYearId }, data: { name: MARKER } }),
      ),
      (error: unknown) => {
        assert.ok(
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025',
          `expected P2025, got ${summarise(error)}`,
        );
        return true;
      },
    );

    const years = new AcademicYearsService(api);
    await assert.rejects(
      years.update(fixture.foreignYearId, { name: MARKER } as UpdateAcademicYearDto, admin),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundException, `expected NotFoundException, got ${summarise(error)}`);
        assert.equal(error.message, 'The requested record does not exist.');
        return true;
      },
    );

    assert.equal(await nameOfForeignYear(), 'RLS Fixture Year', 'the hidden year was renamed');
  });

  // ---- (i) time and date columns, raw and through the model API
  await check('(i) FrameTimes: raw time columns are the model API’s Dates, and a PATCH merges against them', async () => {
    const frames = new FrameTimesService(api);
    const created = await frames.create({ ...PROBE_WINDOW } as CreateFrameTimeDto, admin);

    const { model, raw } = await api.withRls(admin, async (tx) => ({
      model: await tx.frameTime.findUniqueOrThrow({
        where: { id: created.id },
        select: { startTime: true, endTime: true },
      }),
      // lockBounds's statement, frame-times.service.ts.
      raw: (
        await tx.$queryRaw<
          { startTime: Date; endTime: Date; minGradeLevel: number; maxGradeLevel: number }[]
        >`
          SELECT "startTime", "endTime", "minGradeLevel", "maxGradeLevel"
          FROM "FrameTimes"
          WHERE "id" = ${created.id}::uuid
          FOR UPDATE
        `
      )[0],
    }));
    sameInstant('FrameTimes.startTime', model.startTime, raw.startTime);
    sameInstant('FrameTimes.endTime', model.endTime, raw.endTime);
    assert.equal(raw.startTime.toISOString(), '1970-01-01T05:07:00.000Z');
    // (j) assertSpan compares these as numbers.
    assert.equal(raw.minGradeLevel, 12);
    assert.equal(raw.maxGradeLevel, 12);

    // update() reads the stored start raw and merges a PATCH naming only the end.
    const moved = await frames.update(created.id, { endTime: '05:50' } as UpdateFrameTimeDto, admin);
    assert.deepEqual(
      { startTime: moved.startTime, endTime: moved.endTime },
      { startTime: '05:07', endTime: '05:50' },
    );
    await assert.rejects(
      frames.update(created.id, { endTime: '05:00' } as UpdateFrameTimeDto, admin),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException, `expected BadRequestException, got ${summarise(error)}`);
        assert.equal(error.message, 'startTime must be before endTime.');
        return true;
      },
    );

    await frames.remove(created.id, admin);
  });

  await check('(i) LunchServings: raw time columns are the model API’s Dates', async () => {
    const servings = new LunchServingsService(api);
    const created = await servings.create({ ...PROBE_WINDOW } as CreateLunchServingDto, admin);

    const { model, raw } = await api.withRls(admin, async (tx) => ({
      model: await tx.lunchServing.findUniqueOrThrow({
        where: { id: created.id },
        select: { startTime: true, endTime: true },
      }),
      // lockBounds's statement, lunch-servings.service.ts.
      raw: (
        await tx.$queryRaw<{ startTime: Date; endTime: Date }[]>`
          SELECT "startTime", "endTime", "minGradeLevel", "maxGradeLevel"
          FROM "LunchServings"
          WHERE "id" = ${created.id}::uuid
          FOR UPDATE
        `
      )[0],
    }));
    sameInstant('LunchServings.startTime', model.startTime, raw.startTime);
    sameInstant('LunchServings.endTime', model.endTime, raw.endTime);
    assert.equal(raw.endTime.toISOString(), '1970-01-01T05:53:00.000Z');

    await servings.remove(created.id, admin);
  });

  await check('(i) Rasts: raw time columns are the model API’s Dates', async () => {
    const rasts = new RastsService(api);
    const created = await rasts.create({ ...PROBE_WINDOW, name: MARKER } as CreateRastDto, admin);

    const { model, raw } = await api.withRls(admin, async (tx) => ({
      model: await tx.rast.findUniqueOrThrow({
        where: { id: created.id },
        select: { startTime: true, endTime: true },
      }),
      // lockBounds's statement, rasts.service.ts.
      raw: (
        await tx.$queryRaw<{ startTime: Date; endTime: Date }[]>`
          SELECT "startTime", "endTime", "minGradeLevel", "maxGradeLevel"
          FROM "Rasts"
          WHERE "id" = ${created.id}::uuid
          FOR UPDATE
        `
      )[0],
    }));
    sameInstant('Rasts.startTime', model.startTime, raw.startTime);
    sameInstant('Rasts.endTime', model.endTime, raw.endTime);

    await rasts.remove(created.id, admin);
  });

  await check('(i) AvailabilityConstraints: raw time columns are the model API’s Dates', async () => {
    const { model, raw } = await api.withRls(admin, async (tx) => ({
      model: await tx.availabilityConstraint.findUniqueOrThrow({
        where: { id: fixture.constraintId },
        select: { startTime: true, endTime: true },
      }),
      // lockWindow's statement, availability-constraints.service.ts.
      raw: (
        await tx.$queryRaw<{ startTime: Date; endTime: Date }[]>`
          SELECT "startTime", "endTime"
          FROM "AvailabilityConstraints"
          WHERE "id" = ${fixture.constraintId}::uuid
          FOR UPDATE
        `
      )[0],
    }));
    sameInstant('AvailabilityConstraints.startTime', model.startTime, raw.startTime);
    sameInstant('AvailabilityConstraints.endTime', model.endTime, raw.endTime);
    assert.equal(raw.startTime.toISOString().slice(0, 10), '1970-01-01');
  });

  await check('(i) AcademicYears: raw date columns are the model API’s midnight-UTC Dates', async () => {
    const { model, forShare, forNoKeyUpdate } = await api.withRls(admin, async (tx) => ({
      model: await tx.academicYear.findUniqueOrThrow({
        where: { id: fixture.activeYearId },
        select: { startDate: true, endDate: true },
      }),
      // academic-year-bounds.ts itself.
      forShare: await readYearBoundsForShare(tx, fixture.activeYearId),
      // assertYearStillHoldsItsPeriods's statement, academic-years.service.ts.
      forNoKeyUpdate: (
        await tx.$queryRaw<{ startDate: Date; endDate: Date }[]>`
          SELECT "startDate", "endDate"
          FROM "AcademicYears"
          WHERE "id" = ${fixture.activeYearId}::uuid
          FOR NO KEY UPDATE
        `
      )[0],
    }));
    assert.ok(forShare, 'readYearBoundsForShare found no row for the admin’s own active year');
    for (const [label, raw] of [
      ['FOR SHARE', forShare],
      ['FOR NO KEY UPDATE', forNoKeyUpdate],
    ] as const) {
      sameInstant(`AcademicYears.startDate (${label})`, model.startDate, raw.startDate);
      sameInstant(`AcademicYears.endDate (${label})`, model.endDate, raw.endDate);
    }
    assert.match(forShare.startDate.toISOString(), /T00:00:00\.000Z$/);
  });

  // ---- (j) the other raw values the code compares
  // ---- (l) a decided lokal timplan, through every door
  await check('(l) a decided timplan refuses the service, the trigger and the subject cascade with 409 TIMPLAN_IS_DECIDED', async () => {
    const timplans = new LocalTimplansService(api);
    const subjects = new SubjectsService(api);
    const imports = new ImportService(api, {} as UsersService);
    const isDecided = (planName: string) => (error: unknown) => {
      assert.ok(error instanceof ConflictException, `expected ConflictException, got ${summarise(error)}`);
      const body = error.getResponse() as { code?: string; message?: string };
      assert.equal(body.code, 'TIMPLAN_IS_DECIDED', summarise(error));
      assert.ok(body.message?.includes(`"${planName}"`), `the 409 did not name the plan: ${body.message}`);
      return true;
    };
    const entriesOf = async (planId: string) =>
      (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM "LocalTimplanEntries" WHERE "localTimplanId" = $1', [planId])).rows[0].n;

    const subject = await subjects.create({ name: MARKER, nationalCode: 'MA' } as never, admin);
    const name = `${MARKER} beslutad`;
    const plan = await timplans.create(
      { name, schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: fixture.grundskolaVersionId },
      admin,
    );
    assert.equal(plan.planningWeeks, 35.6, `planningWeeks came back as ${shapeOf(plan.planningWeeks)}`);

    // The NUMERIC(4,1) default read back through the driver: 707 min/vecka of
    // matematik over 35.6 weeks is 419.49 h, the protected cell half an hour short.
    const saved = await timplans.replaceEntries(
      plan.id,
      { entries: [1, 2, 3].map((gradeLevel) => ({ subjectId: subject.id, gradeLevel, minutesPerWeek: gradeLevel === 3 ? 235 : 236 })) },
      admin,
    );
    const ma = saved.check.verdicts.find(
      (v) => v.code === 'TIMPLAN_PROTECTED_SUBJECT_REDUCED' && v.subjectCode === 'MA' && v.stage === 'LAG',
    );
    assert.deepEqual(ma?.params, { nationalHours: 420, plannedHours: 419.4, deficitHours: 0.6, reducedPercent: 0.2 });

    const decided = await timplans.decide(plan.id, { decisionNote: MARKER }, admin);
    assert.equal(decided.status, 'DECIDED');
    assert.equal(decided.decidedByUserId, admin.userId);

    // The service's own line.
    await assert.rejects(timplans.replaceEntries(plan.id, { entries: [] }, admin), isDecided(name));
    await assert.rejects(timplans.update(plan.id, { planningWeeks: 36 }, admin), isDecided(name));
    await assert.rejects(
      imports.importTimplan({ localTimplanId: plan.id, rows: [{ subject: MARKER, gradeLevel: 4, minutesPerWeek: 60 }] }, admin),
      isDecided(name),
    );

    // The trigger's line, met by writes that skip the service, translated by the mapper.
    const direct = async (write: (tx: PrismaClient) => Promise<unknown>) => {
      try {
        await api.withRls(admin, write);
      } catch (error) {
        assert.equal(sqlStateOf(error), 'TP409', summarise(error));
        assert.equal(decidedTimplanRefusal(error)?.planId, plan.id);
        rethrowPrismaError(error);
      }
      assert.fail('the write went through');
    };
    await assert.rejects(
      direct((tx) =>
        tx.localTimplanEntry.create({
          data: { schoolId: fixture.schoolId, localTimplanId: plan.id, subjectId: subject.id, gradeLevel: 4, minutesPerWeek: 60 },
        }),
      ),
      isDecided(name),
    );
    await assert.rejects(direct((tx) => tx.localTimplan.update({ where: { id: plan.id }, data: { name: MARKER } })), isDecided(name));
    await assert.rejects(direct((tx) => tx.subject.delete({ where: { id: subject.id } })), isDecided(name));

    // The subjects service asks first and names the plan; the subject stands.
    await assert.rejects(subjects.remove(subject.id, admin), isDecided(name));
    assert.equal((await owner.query('SELECT 1 FROM "Subjects" WHERE id = $1', [subject.id])).rowCount, 1);
    assert.equal(await entriesOf(plan.id), 3, 'a refused write changed the decided plan');

    // Reopen copies; deleting the decided source cascades its entries past the
    // trigger and clears only the draft's pointer.
    const draft = await timplans.reopen(plan.id, {}, admin);
    assert.equal(draft.status, 'DRAFT');
    assert.equal(draft.copiedFromId, plan.id);
    assert.equal(draft.entries.length, 3);
    await timplans.remove(plan.id, admin);
    assert.equal(await entriesOf(plan.id), 0);
    const [after] = (await owner.query<{ copiedFromId: string | null; schoolId: string }>(
      'SELECT "copiedFromId", "schoolId" FROM "LocalTimplans" WHERE id = $1', [draft.id],
    )).rows;
    assert.deepEqual(after, { copiedFromId: null, schoolId: fixture.schoolId });

    // A subject only a DRAFT holds is deleted, and its entries go with it.
    await subjects.remove(subject.id, admin);
    assert.equal(await entriesOf(draft.id), 0);
  });

  // ---- (m) a timplan save and a subject delete meeting in one draft
  await check('(m) a subject delete waits for a draft’s save instead of deadlocking with it, and a deadlock is a 409', async () => {
    const timplans = new LocalTimplansService(api);
    const other = open(withConnectionLimit(appUrl, 1));
    await other.onModuleInit();
    const subjects = new SubjectsService(other);

    const subject = await subjects.create({ name: MARKER, nationalCode: 'BL' } as never, admin);
    const plan = await timplans.create(
      { name: `${MARKER} utkast m`, schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: fixture.grundskolaVersionId },
      admin,
    );
    const seed = () =>
      timplans.replaceEntries(plan.id, { entries: [{ subjectId: subject.id, gradeLevel: 4, minutesPerWeek: 60 }] }, admin);

    /**
     * The grid save's order (replaceEntries, importTimplan): touch the plan,
     * then delete its entries. The holder parks between the two while `rival`
     * runs, and the probe releases it once the rival is seen waiting on it.
     */
    const meet = async (rival: () => Promise<unknown>) => {
      const touched = deferred<number>();
      const release = deferred<void>();
      const holder = api.withRls(admin, async (tx) => {
        await tx.localTimplan.update({ where: { id: plan.id }, data: { updatedAt: new Date() } });
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        touched.resolve(pid);
        await release.promise;
        await tx.localTimplanEntry.deleteMany({ where: { localTimplanId: plan.id } });
      });
      const holderSettled = holder.then(() => null, (error: unknown) => error);
      const pid = await Promise.race([
        touched.promise,
        holderSettled.then((error) => {
          throw error ?? new Error('the holder committed before it touched the plan');
        }),
      ]);
      const rivalSettled = rival().then(() => null, (error: unknown) => error);
      // Released only once the rival is blocked on the holder: a lock the
      // database reports, not a clock.
      for (let tries = 0; ; tries++) {
        const { rows } = await owner.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
          [pid],
        );
        if (rows[0].n > 0) break;
        if (tries > 500) throw new Error('the subject delete never waited on the draft’s save');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      release.resolve();
      return Promise.all([holderSettled, rivalSettled]);
    };

    // The service: it locks the plan before its cascade locks an entry, so it
    // waits for the save, and both commit.
    await seed();
    const [saveError, removeError] = await meet(() => subjects.remove(subject.id, admin));
    assert.equal(saveError, null, `the save failed: ${summarise(saveError)}`);
    assert.equal(removeError, null, `the subject delete failed: ${summarise(removeError)}`);
    assert.equal((await owner.query('SELECT 1 FROM "Subjects" WHERE id = $1', [subject.id])).rowCount, 0);

    // The order the service had before (the cascade first, the plan's lock
    // from the trigger after): PostgreSQL detects the deadlock and aborts one
    // of the two, and the error the adapter hands over must map to the 409.
    const again = await subjects.create({ name: MARKER, nationalCode: 'BL' } as never, admin);
    await timplans.replaceEntries(plan.id, { entries: [{ subjectId: again.id, gradeLevel: 4, minutesPerWeek: 60 }] }, admin);
    const results = await meet(() => other.withRls(admin, (tx) => tx.subject.delete({ where: { id: again.id } })));
    const aborted = results.filter((error) => error !== null);
    assert.equal(aborted.length, 1, `expected exactly one side aborted, got ${aborted.map(summarise).join(' | ')}`);
    const [deadlock] = aborted;
    assert.ok(
      deadlock instanceof Prisma.PrismaClientKnownRequestError && deadlock.code === 'P2034',
      `the adapter reported the deadlock as ${summarise(deadlock)}, not P2034`,
    );
    assert.throws(
      () => rethrowPrismaError(deadlock),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException, summarise(error));
        assert.equal((error.getResponse() as { code?: string }).code, 'WRITE_CONFLICT');
        return true;
      },
    );
    await timplans.remove(plan.id, admin);
  });

  // ---- (n) a CHECK a DTO bound did not foresee is a 400 naming the field
  await check('(n) a lokal timplan CHECK reached past the DTO is a 400 naming the field, not a 500', async () => {
    const timplans = new LocalTimplansService(api);
    const isField = (field: string) => (error: unknown) => {
      assert.ok(error instanceof BadRequestException, `expected BadRequestException, got ${summarise(error)}`);
      assert.ok(error.message.startsWith(`${field}: `), `the 400 did not name ${field}: ${error.message}`);
      return true;
    };
    // 100 × "a" + U+FE0F: what MaxLength counted as 100 characters, and
    // char_length as 200 code points. The DTO counts code points now; this is
    // the service called as the DTO's bound would not have stopped it.
    const selected = (n: number) => 'a️'.repeat(n);
    await assert.rejects(
      timplans.create(
        { name: selected(100), schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: fixture.grundskolaVersionId },
        admin,
      ),
      isField('name'),
    );
    const plan = await timplans.create(
      { name: `${MARKER} n`, schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: fixture.grundskolaVersionId },
      admin,
    );
    await assert.rejects(timplans.decide(plan.id, { decisionNote: selected(300) }, admin), isField('decisionNote'));
    await timplans.remove(plan.id, admin);
  });

  // ---- (o) a duty's slot link, guarded by the database, answers 4xx through the adapter
  await check('(o) a duty slot the database refuses is a 409 or a 403 through the real adapter, and a duty CHECK a 400', async () => {
    const constraints = new AvailabilityConstraintsService(api);
    const teachers = (
      await owner.query<{ id: string; authId: string }>(
        `SELECT id, "authId" FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER' AND "isActive" AND "authId" IS NOT NULL
          ORDER BY "authId" LIMIT 2`,
        [fixture.schoolId],
      )
    ).rows;
    assert.equal(teachers.length, 2, 'the demo school needs two active teachers');
    const [mine, colleague] = teachers;
    const teacher: AuthenticatedUser = {
      authId: mine.authId,
      userId: mine.id,
      schoolId: fixture.schoolId,
      role: Role.TEACHER,
    };
    const isCode = (Type: typeof ConflictException | typeof ForbiddenException, code: string) => (error: unknown) => {
      assert.ok(error instanceof Type, `expected ${Type.name}, got ${summarise(error)}`);
      assert.equal((error.getResponse() as { code?: string }).code, code, summarise(error));
      return true;
    };
    const isField = (field: string) => (error: unknown) => {
      assert.ok(error instanceof BadRequestException, `expected BadRequestException, got ${summarise(error)}`);
      assert.ok(error.message.startsWith(`${field}: `), `the 400 did not name ${field}: ${error.message}`);
      return true;
    };
    /** A write past every service, as PostgREST would send it, mapped as a service maps it. */
    const direct = async (principal: AuthenticatedUser, state: string, write: (tx: PrismaClient) => Promise<unknown>) => {
      try {
        await api.withRls(principal, write);
      } catch (error) {
        assert.equal(sqlStateOf(error), state, summarise(error));
        rethrowPrismaError(error);
      }
      assert.fail('the write went through');
    };

    const slot = await constraints.create(
      { resourceType: 'TEACHER', userId: mine.id, dayOfWeek: 2, startTime: '15:00', endTime: '17:00', reason: MARKER } as never,
      admin,
    );
    const theirs = await constraints.create(
      { resourceType: 'TEACHER', userId: colleague.id, dayOfWeek: 2, startTime: '15:00', endTime: '17:00', reason: MARKER } as never,
      admin,
    );
    const dutyOf = (blockedConstraintId: string | null, label = MARKER) => ({
      schoolId: fixture.schoolId,
      userId: mine.id,
      academicYearId: fixture.activeYearId,
      kind: 'APT_KONFERENS' as const,
      label,
      minutesPerWeek: 120,
      blockedConstraintId,
    });

    // The link the service will write: accepted, and read back in the model's types.
    const duty = await api.withRls(admin, (tx) => tx.teacherDuty.create({ data: dutyOf(slot.id) }));
    assert.equal(duty.blockedConstraintId, slot.id);
    assert.equal(duty.countsAsTeaching, false);
    assert.equal(duty.kind, 'APT_KONFERENS');

    // A colleague's constraint as the slot: TD409 from the duty trigger, 409.
    await assert.rejects(
      direct(admin, 'TD409', (tx) => tx.teacherDuty.create({ data: dutyOf(theirs.id, `${MARKER} fel`) })),
      isCode(ConflictException, 'TEACHER_DUTY_BLOCK_MISMATCH'),
    );
    // The admin's generic constraint PATCH moving the linked slot: the
    // service's own rethrowPrismaError answers the constraint trigger's TD409.
    await assert.rejects(
      constraints.update(slot.id, { resourceType: 'TEACHER', userId: colleague.id } as never, admin),
      isCode(ConflictException, 'TEACHER_DUTY_BLOCK_MISMATCH'),
    );
    // The teacher moving their own APT slot past every service: TD403, 403.
    await assert.rejects(
      direct(teacher, 'TD403', (tx) =>
        tx.availabilityConstraint.update({ where: { id: slot.id }, data: { reason: `${MARKER} flyttad` } }),
      ),
      isCode(ForbiddenException, 'TEACHER_DUTY_BLOCK_IS_THE_ADMINS'),
    );
    assert.equal(
      teacherDutyBlockRefusal(
        await api.withRls(teacher, (tx) => tx.availabilityConstraint.delete({ where: { id: slot.id } })).then(
          () => null,
          (error: unknown) => error,
        ),
      )?.availabilityConstraintId,
      slot.id,
      'the TD403 on a delete did not carry the constraint id in DETAIL',
    );

    // The CHECKs a DTO bound did not foresee: a 400 naming the field.
    await assert.rejects(
      direct(admin, '23514', (tx) => tx.teacherDuty.create({ data: dutyOf(null, '\u00a0') })),
      isField('label'),
    );
    await assert.rejects(
      direct(admin, '23514', (tx) => tx.teacherDuty.update({ where: { id: duty.id }, data: { minutesPerWeek: 2401 } })),
      isField('minutesPerWeek'),
    );
    const [requirement] = (
      await owner.query<{ id: string }>(
        `SELECT id FROM "TeachingRequirements" WHERE "schoolId" = $1 ORDER BY id LIMIT 1`,
        [fixture.schoolId],
      )
    ).rows;
    await assert.rejects(
      direct(admin, '23514', (tx) =>
        tx.teachingRequirement.update({ where: { id: requirement.id }, data: { teacherLoadPercent: 201 } }),
      ),
      isField('teacherLoadPercent'),
    );

    // The admin deletes the slot through the service: the duty keeps all but the pointer.
    await constraints.remove(slot.id, admin);
    const [after] = (
      await owner.query<{ blockedConstraintId: string | null; schoolId: string; minutesPerWeek: number }>(
        'SELECT "blockedConstraintId", "schoolId", "minutesPerWeek" FROM "TeacherDuties" WHERE id = $1',
        [duty.id],
      )
    ).rows;
    assert.deepEqual(after, { blockedConstraintId: null, schoolId: fixture.schoolId, minutesPerWeek: 120 });
  });

  await check('(p) the duties service keeps an uppdrag and its slot together through the real adapter, and a person goes with theirs', async () => {
    const duties = new TeacherDutiesService(api);
    // remove() calls the provider only for an invited person; this one never was.
    const users = new UsersService(api, {} as SupabaseAdminService);
    const teachers = (
      await owner.query<{ id: string; authId: string }>(
        `SELECT id, "authId" FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER' AND "isActive" AND "authId" IS NOT NULL
          ORDER BY "authId" LIMIT 2`,
        [fixture.schoolId],
      )
    ).rows;
    const [mine, colleague] = teachers;
    const teacher: AuthenticatedUser = {
      authId: mine.authId,
      userId: mine.id,
      schoolId: fixture.schoolId,
      role: Role.TEACHER,
    };
    const slotOf = async (dutyId: string) =>
      (
        await owner.query<{ constraintId: string | null; userId: string | null; resourceType: string | null; type: string | null; dayOfWeek: number | null; date: string | null; startTime: string | null; endTime: string | null; reason: string | null }>(
          `SELECT d."blockedConstraintId" AS "constraintId", c."userId", c."resourceType"::text, c.type::text,
                  c."dayOfWeek", c.date::text, c."startTime"::text, c."endTime"::text, c.reason
             FROM "TeacherDuties" d LEFT JOIN "AvailabilityConstraints" c ON c.id = d."blockedConstraintId"
            WHERE d.id = $1`,
          [dutyId],
        )
      ).rows[0];
    const constraintExists = async (id: string) =>
      (await owner.query('SELECT 1 FROM "AvailabilityConstraints" WHERE id = $1', [id])).rowCount === 1;

    // Create with a slot: one TEACHER UNAVAILABLE weekly row, linked, in one go.
    const created = await duties.create(
      {
        userId: mine.id,
        academicYearId: fixture.activeYearId,
        kind: 'RASTVAKT',
        label: `${MARKER} rastvakt`,
        minutesPerWeek: 20,
        blockedSlot: { dayOfWeek: 2, startTime: '10:00', endTime: '10:20' },
      },
      admin,
    );
    assert.deepEqual(created.blockedSlot, { dayOfWeek: 2, startTime: '10:00', endTime: '10:20' });
    const first = await slotOf(created.id);
    assert.deepEqual(
      { ...first, constraintId: undefined },
      {
        constraintId: undefined,
        userId: mine.id,
        resourceType: 'TEACHER',
        type: 'UNAVAILABLE',
        dayOfWeek: 2,
        date: null,
        startTime: '10:00:00',
        endTime: '10:20:00',
        // The word, not the label: every colleague reads this column.
        reason: 'Uppdrag',
      },
    );
    const firstConstraint = first.constraintId!;
    // As the colleague, through the real adapter: the slot is visible (it
    // blocks a timetable everybody reads), the uppdrag it stands for is not.
    const colleagueUser: AuthenticatedUser = {
      authId: colleague.authId,
      userId: colleague.id,
      schoolId: fixture.schoolId,
      role: Role.TEACHER,
    };
    const seenByColleague = await api.withRls(colleagueUser, (tx) =>
      tx.availabilityConstraint.findMany({ where: { id: firstConstraint }, select: { reason: true } }),
    );
    assert.equal(seenByColleague.length, 1, 'the colleague no longer reads the school’s constraints');
    assert.ok(
      !(seenByColleague[0].reason ?? '').includes(MARKER),
      `a colleague read the uppdrag’s label through its slot: ${seenByColleague[0].reason}`,
    );

    // Move it: the same constraint row, retimed — the BEFORE UPDATE trigger agrees.
    const moved = await duties.update(
      created.id,
      { blockedSlot: { dayOfWeek: 3, startTime: '12:05', endTime: '12:30' } },
      admin,
    );
    assert.deepEqual(moved.blockedSlot, { dayOfWeek: 3, startTime: '12:05', endTime: '12:30' });
    assert.equal((await slotOf(created.id)).constraintId, firstConstraint);

    // Take it away: unlinked, and the constraint is gone.
    const unblocked = await duties.update(created.id, { blockedSlot: null }, admin);
    assert.equal(unblocked.blockedSlot, null);
    assert.equal(unblocked.blockedConstraintId, null);
    assert.equal(await constraintExists(firstConstraint), false, 'the dropped slot was left behind');

    // Give it one again: a new constraint, linked.
    const reblocked = await duties.update(
      created.id,
      { blockedSlot: { dayOfWeek: 4, startTime: '08:00', endTime: '08:15' } },
      admin,
    );
    assert.ok(reblocked.blockedConstraintId && reblocked.blockedConstraintId !== firstConstraint);

    // A teacher reads their own through the service, and RLS alone hides the colleague's.
    const theirs = await duties.create(
      { userId: colleague.id, academicYearId: fixture.activeYearId, kind: 'MENTORSKAP', label: `${MARKER} mentor`, minutesPerWeek: 60 },
      admin,
    );
    const ownList = await duties.list(fixture.activeYearId, undefined, teacher);
    assert.ok(ownList.some((row) => row.id === created.id));
    assert.ok(ownList.every((row) => row.userId === mine.id));
    assert.deepEqual(ownList.find((row) => row.id === created.id)?.blockedSlot, {
      dayOfWeek: 4,
      startTime: '08:00',
      endTime: '08:15',
    });
    const unfiltered = await api.withRls(teacher, (tx) => tx.teacherDuty.findMany({ where: { id: theirs.id } }));
    assert.deepEqual(unfiltered, [], 'RLS handed a teacher a colleague’s uppdrag');
    await assert.rejects(duties.list(fixture.activeYearId, colleague.id, teacher), ForbiddenException);

    // Delete: the uppdrag and the time it blocked, both.
    await duties.remove(created.id, admin);
    assert.equal(await constraintExists(reblocked.blockedConstraintId!), false, 'the deleted duty left its slot');
    await assert.rejects(duties.remove(created.id, admin), NotFoundException);

    // A pupil holds no uppdrag: the Users lock answers 400 before a slot exists.
    await assert.rejects(
      duties.create(
        {
          userId: fixture.pupilId,
          academicYearId: fixture.activeYearId,
          kind: 'ANNAT',
          label: `${MARKER} elev`,
          minutesPerWeek: 10,
          blockedSlot: { dayOfWeek: 1, startTime: '08:00', endTime: '08:10' },
        },
        admin,
      ),
      BadRequestException,
    );

    // A person with an uppdrag: not demoted while it stands, and deleted with it.
    const [person] = (
      await owner.query<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
         VALUES ($1, $2, 'Probe', 'Duty', 'TEACHER', gen_random_uuid(), true, now()) RETURNING id`,
        [fixture.schoolId, `${MARKER}-duty@example.invalid`],
      )
    ).rows;
    const held = await duties.create(
      {
        userId: person.id,
        academicYearId: fixture.activeYearId,
        kind: 'APT_KONFERENS',
        label: `${MARKER} apt`,
        minutesPerWeek: 90,
        blockedSlot: { dayOfWeek: 3, startTime: '15:00', endTime: '16:30' },
      },
      admin,
    );
    await assert.rejects(
      users.update(person.id, { role: 'STUDENT' } as never, admin),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException, summarise(error));
        assert.ok(error.message.includes('1 uppdrag'), error.message);
        return true;
      },
    );
    await users.remove(person.id, admin);
    assert.equal(
      (await owner.query('SELECT 1 FROM "TeacherDuties" WHERE id = $1', [held.id])).rowCount,
      0,
      'the person’s uppdrag outlived them',
    );
    assert.equal(
      await constraintExists(held.blockedConstraintId!),
      false,
      'the person’s blocked time outlived them',
    );
  });

  await check('(q) the uppdrag import locks its teachers by an id array and is idempotent through the real adapter', async () => {
    const imports = new ImportService(api, {} as UsersService);
    const [person] = (
      await owner.query<{ email: string; id: string }>(
        `SELECT email, id FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER' AND "isActive" ORDER BY email LIMIT 1`,
        [fixture.schoolId],
      )
    ).rows;
    const file = {
      academicYearId: fixture.activeYearId,
      columns: ['teacherEmail', 'kind', 'label', 'minutesPerWeek', 'countsAsTeaching', 'note'] as never,
      rows: [
        { teacherEmail: person.email.toUpperCase(), kind: 'RASTVAKT' as const, label: `${MARKER} import`, minutesPerWeek: 20, countsAsTeaching: true, note: null },
        { teacherEmail: 'ingen@example.invalid', kind: 'ANNAT' as const, label: `${MARKER} okänd`, minutesPerWeek: 10, countsAsTeaching: null, note: null },
      ],
    };
    const first = await imports.importTeacherDuties(file, admin);
    assert.deepEqual({ ...first, errors: first.errors.map((e) => e.row) }, { created: 1, updated: 0, skipped: 0, errors: [2] });
    const again = await imports.importTeacherDuties(file, admin);
    assert.deepEqual({ ...again, errors: again.errors.length }, { created: 0, updated: 0, skipped: 1, errors: 1 });
    const changed = await imports.importTeacherDuties(
      { ...file, rows: [{ ...file.rows[0], minutesPerWeek: 25 }] },
      admin,
    );
    assert.equal(changed.updated, 1);
    const stored = (
      await owner.query<{ userId: string; minutesPerWeek: number; countsAsTeaching: boolean; blockedConstraintId: string | null }>(
        `SELECT "userId", "minutesPerWeek", "countsAsTeaching", "blockedConstraintId" FROM "TeacherDuties" WHERE label = $1`,
        [`${MARKER} import`],
      )
    ).rows;
    assert.deepEqual(stored, [{ userId: person.id, minutesPerWeek: 25, countsAsTeaching: true, blockedConstraintId: null }]);
  });

  // ---- (r) the staffing checks: a post locked through the real adapter
  await check('(r) two admins staffing one teacher cannot both pass: the post lock binds an id array, waits, and the second is a 409', async () => {
    const requirements = new TeachingRequirementsService(api);
    const other = open(withConnectionLimit(appUrl, 1));
    await other.onModuleInit();
    const rivalRequirements = new TeachingRequirementsService(other);

    const group = await onlyRow<{ id: string; name: string }>(
      owner,
      `SELECT id, name FROM "StudentGroups" WHERE "schoolId" = $1 AND "academicYearId" = $2 ORDER BY name LIMIT 1`,
      [fixture.schoolId, fixture.activeYearId],
      'a group of the demo school’s active year',
    );
    const [person] = (
      await owner.query<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
         VALUES ($1, $2, 'Probe', 'Staff', 'TEACHER', gen_random_uuid(), true, now()) RETURNING id`,
        [fixture.schoolId, `${MARKER}-staff@example.invalid`],
      )
    ).rows;
    // A 100-minute target, no tolerance: one 60-minute row fits, two do not.
    await owner.query(
      `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "teachingTargetMinutesPerWeek", "updatedAt")
       VALUES ($1, $2, $3, 100, 100, now())`,
      [fixture.schoolId, person.id, fixture.activeYearId],
    );
    const subjectIds: string[] = [];
    for (const name of [`${MARKER} ma`, `${MARKER} fy`]) {
      subjectIds.push(
        (
          await owner.query<{ id: string }>(
            `INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`,
            [fixture.schoolId, name],
          )
        ).rows[0].id,
      );
    }

    // The school's policy: kept and put back if it has one, created marked if not.
    const kept = (
      await owner.query<Record<string, unknown>>(
        `SELECT "qualificationMode"::text, "overAllocationMode"::text, "overAllocationTolerancePercent",
                "unstaffedGeneration"::text
           FROM "StaffingPolicies" WHERE "schoolId" = $1`,
        [fixture.schoolId],
      )
    ).rows[0];
    if (kept) {
      await owner.query(
        `UPDATE "StaffingPolicies" SET "qualificationMode" = 'OFF', "overAllocationMode" = 'REFUSE',
                "overAllocationTolerancePercent" = 0, "unstaffedGeneration" = 'REFUSE' WHERE "schoolId" = $1`,
        [fixture.schoolId],
      );
    } else {
      await owner.query(
        `INSERT INTO "StaffingPolicies" ("schoolId", "fullTimeAnnualHours", "qualificationMode", "overAllocationMode",
                "overAllocationTolerancePercent", "unstaffedGeneration", "updatedAt")
         VALUES ($1, $2, 'OFF', 'REFUSE', 0, 'REFUSE', now())`,
        [fixture.schoolId, PROBE_ANNUAL_HOURS],
      );
    }
    const teacherOf = async (id: string) =>
      (await owner.query<{ teacherId: string | null }>('SELECT "teacherId" FROM "TeachingRequirements" WHERE id = $1', [id]))
        .rows[0].teacherId;
    const isOverTarget = (minutes: number) => (error: unknown) => {
      assert.ok(error instanceof ConflictException, summarise(error));
      const body = error.getResponse() as { code?: string; params?: Record<string, unknown> };
      assert.equal(body.code, 'STAFF_TEACHER_OVER_TARGET');
      assert.deepEqual(body.params, { role: 'TEACHER', minutes, target: 100, limit: 100, tolerance: 0 });
      return true;
    };

    try {
      const [a, b] = await Promise.all(
        subjectIds.map((subjectId) =>
          requirements.create(
            { academicYearId: fixture.activeYearId, subjectId, studentGroupId: group.id, lessonsPerWeek: 1, minutesPerLesson: 60 } as never,
            admin,
          ),
        ),
      );

      // One after the other: the first fits, the second is refused and not written.
      const first = await requirements.update(a.id, { teacherId: person.id } as never, admin);
      assert.deepEqual(first.warnings, []);
      await assert.rejects(requirements.update(b.id, { teacherId: person.id } as never, admin), isOverTarget(120));
      assert.equal(await teacherOf(b.id), null, 'the refused PATCH wrote its teacher');

      // Concurrently. The holder is the first admin's write parked mid-way —
      // the service's own lock, then the assignment — and the rival is the
      // second admin through the real service on its own connection. The
      // rival must WAIT on the holder's lock (asked of the database, not of a
      // clock), and once the holder commits, read its row and be refused.
      await requirements.update(a.id, { teacherId: null } as never, admin);
      const touched = deferred<number>();
      const release = deferred<void>();
      const holder = api.withRls(admin, async (tx) => {
        assert.equal(await lockEmploymentsOf(tx, fixture.activeYearId, [person.id]), 1);
        await tx.teachingRequirement.update({ where: { id: a.id }, data: { teacherId: person.id } });
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        touched.resolve(pid);
        await release.promise;
      });
      const holderSettled = holder.then(() => null, (error: unknown) => error);
      const pid = await Promise.race([
        touched.promise,
        holderSettled.then((error) => {
          throw error ?? new Error('the holder committed before it parked');
        }),
      ]);
      const rivalSettled = rivalRequirements
        .update(b.id, { teacherId: person.id } as never, admin)
        .then(() => null, (error: unknown) => error);
      for (let tries = 0; ; tries++) {
        const { rows } = await owner.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
          [pid],
        );
        if (rows[0].n > 0) break;
        if (tries > 500) throw new Error('the second admin’s write never waited on the first one’s post lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      release.resolve();
      const [holderError, rivalError] = await Promise.all([holderSettled, rivalSettled]);
      assert.equal(holderError, null, `the holder failed: ${summarise(holderError)}`);
      assert.notEqual(rivalError, null, 'both admins’ writes passed: the second was judged on a load read before the first committed');
      isOverTarget(120)(rivalError);
      assert.equal(await teacherOf(a.id), person.id);
      assert.equal(await teacherOf(b.id), null, 'both admins’ writes committed: the teacher is over target');

      // The generate pre-flight through the adapter: b has no teacher, and the
      // policy refuses — no engine, and b named by subject and group.
      const proxy = new OptimizationProxyService(
        api,
        { post: () => { throw new Error('the engine was called'); } } as never,
        { getOrThrow: () => ({ baseUrl: 'http://engine.invalid', apiKey: 'k'.repeat(32), timeoutMs: 1 }) } as never,
      );
      const refused = await proxy.triggerScheduling(fixture.activeYearId, admin);
      assert.equal(refused.status, 'INFEASIBLE');
      assert.equal(refused.conflicts?.summaryCode, 'STAFF_UNSTAFFED_REQUIREMENTS');
      const detail = refused.conflicts?.conflicts[0];
      assert.ok(detail?.resourceIds.includes(b.id), 'the refusal does not name the unstaffed row by its real id');
      assert.ok(
        detail?.resourceNames?.includes(`${MARKER} fy för ${group.name}`),
        `the refusal named ${JSON.stringify(detail?.resourceNames)}`,
      );
    } finally {
      if (kept) {
        await owner.query(
          `UPDATE "StaffingPolicies" SET "qualificationMode" = $2::"StaffingCheckMode", "overAllocationMode" = $3::"StaffingCheckMode",
                  "overAllocationTolerancePercent" = $4, "unstaffedGeneration" = $5::"UnstaffedGenerationMode" WHERE "schoolId" = $1`,
          [fixture.schoolId, kept.qualificationMode, kept.overAllocationMode, kept.overAllocationTolerancePercent, kept.unstaffedGeneration],
        );
      }
    }
  });

  await check('(s) an uppdrag’s slot blocks its own läsår only, and goes with its year, through the real adapter', async () => {
    const duties = new TeacherDutiesService(api);
    const years = new AcademicYearsService(api);
    const [teacherRow] = (
      await owner.query<{ id: string }>(
        `SELECT id FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER' AND "isActive" ORDER BY "authId" LIMIT 1`,
        [fixture.schoolId],
      )
    ).rows;
    const [next] = (
      await owner.query<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
         VALUES ($1, $2, DATE '2098-08-15', DATE '2099-06-10', false, now()) RETURNING id`,
        [fixture.schoolId, `${MARKER} nästa år`],
      )
    ).rows;
    // An odd time no seed row uses, on two weekdays: Tuesday for next year's
    // APT, Thursday for this year's.
    const slot = { startTime: '15:55', endTime: '16:35' };
    const nextYears = await duties.create(
      { userId: teacherRow.id, academicYearId: next.id, kind: 'APT_KONFERENS', label: `${MARKER} apt nästa år`, minutesPerWeek: 120, blockedSlot: { dayOfWeek: 2, ...slot } },
      admin,
    );
    const thisYears = await duties.create(
      { userId: teacherRow.id, academicYearId: fixture.activeYearId, kind: 'APT_KONFERENS', label: `${MARKER} apt i år`, minutesPerWeek: 120, blockedSlot: { dayOfWeek: 4, ...slot } },
      admin,
    );
    let payload: { constraints: { resourceKind: string; dayOfWeek: number | null; startTime: string }[] } | undefined;
    const proxy = new OptimizationProxyService(
      api,
      {
        post: (_url: string, body: typeof payload) => {
          payload = body;
          return throwError(() => new Error('engine stub'));
        },
      } as never,
      { getOrThrow: () => ({ baseUrl: 'http://engine.invalid', apiKey: 'k'.repeat(32), timeoutMs: 1 }) } as never,
    );
    // (r)'s policy row may still refuse an unstaffed year (the sweep removes
    // it at the end): allow generation for this one call, as it was.
    const kept = (
      await owner.query<{ unstaffedGeneration: string }>(
        'SELECT "unstaffedGeneration"::text AS "unstaffedGeneration" FROM "StaffingPolicies" WHERE "schoolId" = $1',
        [fixture.schoolId],
      )
    ).rows[0];
    await owner.query(`UPDATE "StaffingPolicies" SET "unstaffedGeneration" = 'ALLOW' WHERE "schoolId" = $1`, [fixture.schoolId]);
    try {
      await proxy.triggerScheduling(fixture.activeYearId, admin).catch(() => undefined);
    } finally {
      if (kept) {
        await owner.query(
          `UPDATE "StaffingPolicies" SET "unstaffedGeneration" = $2::"UnstaffedGenerationMode" WHERE "schoolId" = $1`,
          [fixture.schoolId, kept.unstaffedGeneration],
        );
      }
    }
    assert.ok(payload, 'the proxy never built a payload');
    const blockedOn = (day: number) =>
      payload!.constraints.filter(
        (c) => c.resourceKind === 'TEACHER' && c.dayOfWeek === day && c.startTime.startsWith('15:55'),
      ).length;
    assert.equal(blockedOn(4), 1, 'this year’s uppdrag slot is missing from this year’s payload');
    assert.equal(blockedOn(2), 0, 'next year’s uppdrag slot blocks this year’s generation');

    // The year deleted as the gateway deletes it: its duty cascades, and the
    // duty's slot goes with it instead of blocking every later year.
    await years.remove(next.id, admin);
    assert.equal(
      (await owner.query('SELECT 1 FROM "AvailabilityConstraints" WHERE id = $1', [nextYears.blockedConstraintId])).rowCount,
      0,
      'a deleted year’s uppdrag left its slot behind',
    );
    assert.equal(
      (await owner.query('SELECT 1 FROM "AvailabilityConstraints" WHERE id = $1', [thisYears.blockedConstraintId])).rowCount,
      1,
      'deleting another year took this year’s slot',
    );
    await duties.remove(thisYears.id, admin);
  });

  // ---- (t) a plan a läsår follows, refused by its key, answers 4xx through the adapter
  await check('(t) deleting a plan a läsår follows is a 409 TIMPLAN_IN_USE through the real adapter, and the attachment CHECK a 400', async () => {
    const timplans = new LocalTimplansService(api);
    const plan = await timplans.create(
      { name: `${MARKER} följd`, schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: fixture.grundskolaVersionId },
      admin,
    );
    // The attachment through the year dialog's PUT: its FOR NO KEY UPDATE
    // read of the year runs under RLS as the admin, through the adapter.
    const yearTimplans = new AcademicYearTimplansService(api);
    const before = await yearTimplans.list(fixture.activeYearId, admin);
    const attached = await yearTimplans.replace(
      fixture.activeYearId,
      { timplans: [...before, { gradeLevel: 4, localTimplanId: plan.id }].filter((row, i, all) => all.findIndex((other) => other.gradeLevel === row.gradeLevel) === i) },
      admin,
    );
    assert.ok(
      attached.some((row) => row.gradeLevel === 4 && row.localTimplanId === plan.id && row.planStatus === 'DRAFT'),
      `the PUT did not attach årskurs 4: ${JSON.stringify(attached)}`,
    );
    const yearName = (
      await owner.query<{ name: string }>('SELECT name FROM "AcademicYears" WHERE id = $1', [fixture.activeYearId])
    ).rows[0].name;
    const isInUse = (error: unknown) => {
      assert.ok(error instanceof ConflictException, `expected ConflictException, got ${summarise(error)}`);
      const body = error.getResponse() as { code?: string };
      assert.equal(body.code, 'TIMPLAN_IN_USE', summarise(error));
      return true;
    };

    // The raw refusal first: 23503 on the plan key, recognised as in use.
    try {
      await api.withRls(admin, (tx) => tx.localTimplan.delete({ where: { id: plan.id } }));
      assert.fail('an attached plan was deleted');
    } catch (error) {
      assert.equal(sqlStateOf(error), '23503', summarise(error));
      assert.ok(isTimplanInUseRefusal(error), `not recognised as in use: ${summarise(error)}`);
    }
    // Through the service: its own read answers first, naming the year.
    await assert.rejects(timplans.remove(plan.id, admin), (error: unknown) => {
      isInUse(error);
      const message = ((error as ConflictException).getResponse() as { message?: string }).message ?? '';
      assert.ok(message.includes(`läsåret "${yearName}"`), `the 409 did not name the year: ${message}`);
      return true;
    });
    assert.equal((await owner.query('SELECT 1 FROM "LocalTimplans" WHERE id = $1', [plan.id])).rowCount, 1);

    // The same key's other direction — another school's year under a row
    // stamped with this one — is a missing reference, not a plan in use.
    try {
      await api.withRls(admin, (tx) =>
        tx.academicYearTimplan.create({
          data: { schoolId: fixture.schoolId, academicYearId: fixture.foreignYearId, gradeLevel: 4, localTimplanId: plan.id },
        }),
      );
      assert.fail('an attachment named another school’s year');
    } catch (error) {
      assert.equal(sqlStateOf(error), '23503', summarise(error));
      assert.equal(isTimplanInUseRefusal(error), false, summarise(error));
      assert.throws(() => rethrowPrismaError(error), (thrown: unknown) => {
        assert.ok(thrown instanceof ConflictException, summarise(thrown));
        assert.notEqual((thrown.getResponse() as { code?: string }).code, 'TIMPLAN_IN_USE');
        return true;
      });
    }

    // The CHECK a DTO bound did not foresee: a 400 naming gradeLevel.
    try {
      await api.withRls(admin, (tx) =>
        tx.academicYearTimplan.create({
          data: { schoolId: fixture.schoolId, academicYearId: fixture.activeYearId, gradeLevel: 11, localTimplanId: plan.id },
        }),
      );
      assert.fail('årskurs 11 was attached');
    } catch (error) {
      assert.throws(() => rethrowPrismaError(error), (thrown: unknown) => {
        assert.ok(thrown instanceof BadRequestException, summarise(thrown));
        assert.ok(thrown.message.startsWith('gradeLevel: '), thrown.message);
        return true;
      });
    }

    // Detached through the same PUT (the year's own rows as they were), the plan goes.
    await yearTimplans.replace(fixture.activeYearId, { timplans: before }, admin);
    await timplans.remove(plan.id, admin);
    assert.equal((await owner.query('SELECT 1 FROM "LocalTimplans" WHERE id = $1', [plan.id])).rowCount, 0);
  });

  // ---- (u) P2 end to end through the real adapter: a year's defaults, generate, coverage
  await check('(u) a new year follows the newest decided plan, generate-requirements is idempotent, and coverage reads under RLS by role', async () => {
    const timplans = new LocalTimplansService(api);
    const subjects = new SubjectsService(api);
    const years = new AcademicYearsService(api);
    const yearTimplans = new AcademicYearTimplansService(api);
    const generator = new TimplanRequirementsService(api);
    const coverage = new TimplanCoverageService(api);

    const subject = await subjects.create({ name: `${MARKER} p2-ämne`, nationalCode: 'MA' } as never, admin);
    // The alternatives, read by the generator through Subject.nationalCode:
    // a språkval never goes on a class, and of SV_SVA the class gets one.
    const svenska = await subjects.create({ name: `${MARKER} p2-sv`, nationalCode: 'SV_SVA' } as never, admin);
    const sva = await subjects.create({ name: `${MARKER} p2-sva`, nationalCode: 'SV_SVA' } as never, admin);
    const language = await subjects.create({ name: `${MARKER} p2-språk`, nationalCode: 'M2' } as never, admin);
    const plan = await timplans.create(
      { name: `${MARKER} p2`, schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: fixture.grundskolaVersionId },
      admin,
    );
    await timplans.replaceEntries(
      plan.id,
      {
        entries: [
          { subjectId: subject.id, gradeLevel: 7, minutesPerWeek: 175 },
          { subjectId: svenska.id, gradeLevel: 7, minutesPerWeek: 200 },
          { subjectId: sva.id, gradeLevel: 7, minutesPerWeek: 200 },
          { subjectId: language.id, gradeLevel: 7, minutesPerWeek: 100 },
        ],
      },
      admin,
    );
    await timplans.decide(plan.id, { decisionNote: MARKER }, admin);

    // The year's create attaches grades 1–9 to the newest decided plan, in its transaction.
    const year = await years.create(
      { name: `${MARKER} p2`, startDate: '2098-08-17', endDate: '2099-06-11' } as never,
      admin,
    );
    assert.deepEqual(
      year.timplans.map((row) => [row.gradeLevel, row.localTimplanId]),
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((grade) => [grade, plan.id]),
    );
    // The dialog narrows it to åk 7.
    await yearTimplans.replace(year.id, { timplans: [{ gradeLevel: 7, localTimplanId: plan.id }] }, admin);

    const groups = await owner.query<{ id: string; kind: string }>(
      `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
       VALUES ($1, $2, $3 || ' 7A', 'CLASS', 7, now()), ($1, $2, $3 || ' Ma-grupp', 'TEACHING_GROUP', NULL, now())
       RETURNING id, kind::text`,
      [fixture.schoolId, year.id, MARKER],
    );
    const classId = groups.rows.find((row) => row.kind === 'CLASS')!.id;
    const teachingId = groups.rows.find((row) => row.kind === 'TEACHING_GROUP')!.id;
    // The demo pupil as a member of the teaching group: their home class is
    // another year's, so the coverage counts them outside this year's classes.
    await owner.query(
      'INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES ($1, $2, $3)',
      [fixture.schoolId, teachingId, fixture.pupilId],
    );

    const dto = { academicYearId: year.id, minutesPerLesson: 60 };
    const preview = await generator.generate(plan.id, { ...dto, dryRun: true }, admin);
    assert.deepEqual(
      preview.rows.map((row) => [row.subjectId, row.lessonsPerWeek, row.minutesPerLesson, row.surplusMinutesPerWeek]),
      [
        [svenska.id, 4, 60, 40],
        [subject.id, 3, 60, 5],
      ],
    );
    assert.deepEqual(
      preview.skipped.map((row) => [row.subjectId, row.reason, row.alternativeCode, row.alternativeTo]),
      [
        [language.id, 'ALTERNATIVE', 'M2', null],
        [sva.id, 'ALTERNATIVE', 'SV_SVA', svenska.name],
      ],
    );
    const countRows = async () =>
      (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM "TeachingRequirements" WHERE "academicYearId" = $1', [year.id])).rows[0].n;
    assert.equal(await countRows(), 0, 'a preview wrote a requirement');

    // createManyAndReturn + skipDuplicates under RLS, twice: one row, then none.
    const first = await generator.generate(plan.id, { ...dto, dryRun: false }, admin);
    assert.equal(first.created, 2, JSON.stringify(first));
    assert.ok(first.rows.every((row) => row.requirementId), 'a created row has no id');
    const second = await generator.generate(plan.id, { ...dto, dryRun: false }, admin);
    assert.equal(second.created, 0);
    assert.deepEqual(second.skipped.map((row) => row.reason), ['ALTERNATIVE', 'EXISTS', 'ALTERNATIVE', 'EXISTS']);
    assert.equal(await countRows(), 2);

    // The ON CONFLICT path itself: a row created behind the read is passed by, not a 409.
    const raced = await api.withRls(admin, (tx) =>
      tx.teachingRequirement.createManyAndReturn({
        data: [{ schoolId: fixture.schoolId, academicYearId: year.id, subjectId: subject.id, studentGroupId: classId, lessonsPerWeek: 1, minutesPerLesson: 60 }],
        skipDuplicates: true,
        select: { id: true },
      }),
    );
    assert.equal(raced.length, 0);

    const forAdmin = await coverage.planned({ academicYearId: year.id }, admin);
    const line = forAdmin.groups
      .find((group) => group.studentGroupId === classId)
      ?.lines.find((entry) => entry.key === `subject:${subject.id}`);
    assert.deepEqual(
      [line?.targetMinutesPerWeek, line?.plannedMinutesPerWeek, line?.status],
      [175, 180, 'MET'],
    );
    assert.equal(forAdmin.pupilLevel, true);
    assert.equal(forAdmin.pupilsOutsideClasses, 1);

    const teacherRow = (
      await owner.query<{ id: string; authId: string }>(
        `SELECT id, "authId" FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER' AND "isActive" AND "authId" IS NOT NULL
          ORDER BY "authId" LIMIT 1`,
        [fixture.schoolId],
      )
    ).rows[0];
    const forTeacher = await coverage.planned(
      { academicYearId: year.id },
      { authId: teacherRow.authId, userId: teacherRow.id, schoolId: fixture.schoolId, role: Role.TEACHER },
    );
    assert.equal(forTeacher.pupilLevel, false);
    assert.equal(forTeacher.pupils, null);
    assert.ok(!JSON.stringify(forTeacher).includes(fixture.pupilId), 'a pupil id reached the teacher');
    assert.equal(
      forTeacher.groups[0]?.lines.find((entry) => entry.key === `subject:${subject.id}`)?.status,
      'MET',
    );

    // Deleting the year takes its groups, rows and attachments; then the plan goes.
    await years.remove(year.id, admin);
    await timplans.remove(plan.id, admin);
  });

  await check('(v) a läsårsrullning link the database refuses is a 409 through the real adapter, and the deletes that clear one pass', async () => {
    const years = new AcademicYearsService(api);
    const groups = new StudentGroupsService(api);
    const isCode = (code: string) => (error: unknown) => {
      assert.ok(error instanceof ConflictException, `expected ConflictException, got ${summarise(error)}`);
      assert.equal((error.getResponse() as { code?: string }).code, code, summarise(error));
      return true;
    };
    /** A write past every service, as PostgREST would send it, mapped as a service maps it. */
    const direct = async (state: string, write: (tx: PrismaClient) => Promise<unknown>) => {
      try {
        await api.withRls(admin, write);
      } catch (error) {
        assert.equal(sqlStateOf(error), state, summarise(error));
        rethrowPrismaError(error);
      }
      assert.fail('the write went through');
    };

    // A year and its successor, a class and its successor, as the rollover
    // will write them: the link columns through the model API, under RLS.
    const first = await years.create(
      { name: `${MARKER} rull 1`, startDate: '2095-08-15', endDate: '2096-06-10' },
      admin,
    );
    const second = await api.withRls(admin, (tx) =>
      tx.academicYear.create({
        data: {
          schoolId: fixture.schoolId,
          name: `${MARKER} rull 2`,
          startDate: new Date('2096-08-15T00:00:00Z'),
          endDate: new Date('2097-06-10T00:00:00Z'),
          predecessorId: first.id,
          graduatingGradeLevel: 9,
        },
      }),
    );
    assert.equal(second.predecessorId, first.id);
    assert.equal(second.graduatingGradeLevel, 9);
    const seventh = await groups.create({ academicYearId: first.id, name: `${MARKER} 7A`, gradeLevel: 7 }, admin);
    const eighth = await api.withRls(admin, (tx) =>
      tx.studentGroup.create({
        data: {
          schoolId: fixture.schoolId,
          academicYearId: second.id,
          name: `${MARKER} 8A`,
          gradeLevel: 8,
          predecessorId: seventh.id,
        },
      }),
    );
    assert.equal(eighth.predecessorId, seventh.id);

    // The groups PATCH takes academicYearId: moving a linked group is the
    // service's own rethrowPrismaError answering the trigger's LR409.
    await assert.rejects(
      groups.update(eighth.id, { academicYearId: first.id }, admin),
      isCode('ROLLOVER_GROUP_IS_LINKED'),
    );
    await assert.rejects(
      groups.update(seventh.id, { academicYearId: second.id }, admin),
      isCode('ROLLOVER_GROUP_IS_LINKED'),
    );
    // Past every service: clearing a standing link, and a predecessor outside
    // the year before. DETAIL carries the written row's own id.
    await assert.rejects(
      direct('LR409', (tx) => tx.academicYear.update({ where: { id: second.id }, data: { predecessorId: null } })),
      isCode('ROLLOVER_LINK_IS_FIXED'),
    );
    const parallel = await groups.create({ academicYearId: first.id, name: `${MARKER} 7B`, gradeLevel: 7 }, admin);
    const mismatch = await api
      .withRls(admin, (tx) =>
        tx.studentGroup.create({
          data: { schoolId: fixture.schoolId, academicYearId: first.id, name: `${MARKER} fel år`, predecessorId: parallel.id },
        }),
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.equal(rolloverLinkRefusal(mismatch)?.reason, 'ROLLOVER_LINK_MISMATCH', summarise(mismatch));
    assert.match(String(rolloverLinkRefusal(mismatch)?.studentGroupId), /^[0-9a-f-]{36}$/);
    assert.throws(() => rethrowPrismaError(mismatch), isCode('ROLLOVER_LINK_MISMATCH'));

    // A second successor is the unique key's P2002, which the rollover will
    // turn into YEAR_HAS_SUCCESSOR; pinned here so it can rely on the target.
    const twice = await api
      .withRls(admin, (tx) =>
        tx.academicYear.create({
          data: {
            schoolId: fixture.schoolId,
            name: `${MARKER} rull 2 igen`,
            startDate: new Date('2096-08-15T00:00:00Z'),
            endDate: new Date('2097-06-10T00:00:00Z'),
            predecessorId: first.id,
          },
        }),
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(twice instanceof Prisma.PrismaClientKnownRequestError && twice.code === 'P2002', summarise(twice));
    assert.match(JSON.stringify(twice.meta), /predecessorId/, `the P2002 did not name the predecessor key: ${summarise(twice)}`);

    // The predecessor year deleted as the gateway deletes it: its class
    // cascades, the successor year and class stand with the links cleared.
    await years.remove(first.id, admin);
    const after = await owner.query<{ year: string | null; group: string | null; grade: number | null }>(
      `SELECT y."predecessorId" AS year, g."predecessorId" AS "group", y."graduatingGradeLevel" AS grade
         FROM "AcademicYears" y JOIN "StudentGroups" g ON g."academicYearId" = y.id
        WHERE y.id = $1 AND g.id = $2`,
      [second.id, eighth.id],
    );
    assert.deepEqual(after.rows, [{ year: null, group: null, grade: 9 }]);
    await years.remove(second.id, admin);

    // A school with a three-year chain, deleted whole as the owner (the API
    // has no DELETE on Schools; prisma/seed.ts --reset and a leaving tenant
    // do this): every SET NULL the cascade provokes reaches a row already
    // gone or a parent already gone, and nothing raises.
    const [school] = (
      await owner.query<{ id: string }>(
        `INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
         VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
        [`${MARKER} rullning`, `${MARKER}-rullning`],
      )
    ).rows;
    let previousYear: string | null = null;
    let previousGroup: string | null = null;
    for (const [index, grade] of [7, 8, 9].entries()) {
      const [year]: { id: string }[] = (
        await owner.query<{ id: string }>(
          `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "predecessorId", "updatedAt")
           VALUES ($1, $2, make_date(2095 + $3::int, 8, 15), make_date(2096 + $3::int, 6, 10), $4, now()) RETURNING id`,
          [school.id, `År ${index + 1}`, index, previousYear],
        )
      ).rows;
      const [group]: { id: string }[] = (
        await owner.query<{ id: string }>(
          `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "predecessorId", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
          [school.id, year.id, `${grade}A`, grade, previousGroup],
        )
      ).rows;
      previousYear = year.id;
      previousGroup = group.id;
    }
    const removed = await owner.query('DELETE FROM "Schools" WHERE id = $1', [school.id]);
    assert.equal(removed.rowCount, 1);
    const left = await owner.query<{ n: number }>(
      `SELECT ((SELECT count(*) FROM "AcademicYears" WHERE "schoolId" = $1)
             + (SELECT count(*) FROM "StudentGroups" WHERE "schoolId" = $1))::int AS n`,
      [school.id],
    );
    assert.equal(left.rows[0].n, 0, 'a deleted school left years or groups behind');
  });

  // (w) and (x) run in a school of their own: the activation hands the
  // active flag over and moves pupils, which in the demo school would move
  // the seed's pupils and take its active year away from every later check.
  const rull = await givenRolloverSchool(owner);
  const rullAdmin: AuthenticatedUser = {
    authId: rull.adminAuthId,
    userId: rull.adminId,
    schoolId: rull.schoolId,
    role: Role.SCHOOL_ADMIN,
  };
  const rollover = new YearRolloverService(api);
  const rullYears = new AcademicYearsService(api);
  let targetYearId = '';
  let thirdYearId = '';
  const rolloverOptions = {
    name: `${MARKER} rull mål`,
    startDate: '2094-08-16',
    endDate: '2095-06-11',
    breaks: [{ sourceBreakId: rull.breakId }],
  };

  await check('(w) a läsårsrullning writes the new year in one transaction, through the real adapter, and leaves the source untouched', async () => {
    const before = await sourceChecksum(owner, rull.sourceYearId);
    const targetRows = async () =>
      (
        await owner.query<{ n: number }>(
          `SELECT ((SELECT count(*) FROM "AcademicYears" WHERE "schoolId" = $1 AND name = $2)
                 + (SELECT count(*) FROM "StudentGroups" g JOIN "AcademicYears" y ON y.id = g."academicYearId"
                     WHERE y."schoolId" = $1 AND y.name = $2))::int AS n`,
          [rull.schoolId, rolloverOptions.name],
        )
      ).rows[0].n;

    const preview = await rollover.previewRollover(rull.sourceYearId, rolloverOptions, rullAdmin);
    assert.equal(preview.blocking, false, JSON.stringify(preview.problems));
    assert.equal(preview.graduatingGradeLevel, 9);
    const execute = { ...rolloverOptions, graduatingGradeLevel: 9, planHash: preview.planHash };

    // A stale hash: a 409 before anything is written.
    await assert.rejects(
      rollover.executeRollover(rull.sourceYearId, { ...execute, planHash: 'f'.repeat(64) }, rullAdmin),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException, summarise(error));
        assert.equal((error.getResponse() as { code?: string }).code, 'ROLLOVER_PREVIEW_STALE');
        return true;
      },
    );
    assert.equal(await targetRows(), 0, 'a stale rollover left rows behind');

    // Atomicity: the requirements step fails after the year and the groups
    // were inserted, and the whole rollover is gone with it.
    await owner.query(`
      CREATE FUNCTION public.probe_rull_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'probe: the requirements step refuses'; END $$`);
    await owner.query(
      `CREATE TRIGGER probe_rull_refuse BEFORE INSERT ON "TeachingRequirements"
         FOR EACH ROW WHEN (NEW."schoolId" = '${rull.schoolId}'::uuid) EXECUTE FUNCTION public.probe_rull_refuse()`,
    );
    try {
      await assert.rejects(rollover.executeRollover(rull.sourceYearId, execute, rullAdmin), /refuses/);
    } finally {
      await dropRolloverTrigger(owner);
    }
    assert.equal(await targetRows(), 0, 'a rollover that failed half-way left rows behind');

    const result = await rollover.executeRollover(rull.sourceYearId, execute, rullAdmin);
    targetYearId = result.academicYear.id;
    assert.deepEqual(result.counts, { groups: 2, members: 1, requirements: 1, breaks: 1, classRules: 1 });
    const groups = (
      await owner.query<{ name: string; grade: number; predecessor: string | null }>(
        `SELECT name, "gradeLevel" AS grade, "predecessorId" AS predecessor FROM "StudentGroups"
          WHERE "academicYearId" = $1 ORDER BY name`,
        [targetYearId],
      )
    ).rows;
    assert.deepEqual(groups, [
      { name: `${MARKER} 8A`, grade: 8, predecessor: rull.group7a },
      { name: `${MARKER} Ma8`, grade: 8, predecessor: rull.groupMa7 },
    ]);
    const year = (
      await owner.query<{ predecessor: string; grade: number; active: boolean }>(
        `SELECT "predecessorId" AS predecessor, "graduatingGradeLevel" AS grade, "isActive" AS active FROM "AcademicYears" WHERE id = $1`,
        [targetYearId],
      )
    ).rows[0];
    assert.deepEqual(year, { predecessor: rull.sourceYearId, grade: 9, active: false });
    // The vårtermin ended the day the source year ended, and ends the day the new one does.
    const period = (
      await owner.query<{ start: string; end: string; teacher: string | null }>(
        `SELECT "startDate"::text AS start, "endDate"::text AS end, "teacherId" AS teacher
           FROM "TeachingRequirements" WHERE "academicYearId" = $1`,
        [targetYearId],
      )
    ).rows;
    assert.deepEqual(period, [{ start: '2095-01-10', end: '2095-06-11', teacher: rull.teacherId }]);

    assert.equal(await sourceChecksum(owner, rull.sourceYearId), before, 'the rollover changed the source year');

    await assert.rejects(
      rollover.previewRollover(rull.sourceYearId, { ...rolloverOptions, name: `${MARKER} rull igen` }, rullAdmin),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException, summarise(error));
        assert.equal((error.getResponse() as { code?: string }).code, 'YEAR_HAS_SUCCESSOR');
        assert.match(error.message, /har redan rullats vidare till prisma-adapter-probe rull mål/);
        return true;
      },
    );
  });

  await check('(x) the activation moves the planned pupils by id through the real adapter, once, not while the old year runs, and the year form cannot go around it', async () => {
    const homes = async () =>
      Object.fromEntries(
        (
          await owner.query<{ email: string; group: string | null }>(
            `SELECT u.email, g.name AS "group" FROM "Users" u LEFT JOIN "StudentGroups" g ON g.id = u."studentGroupId"
              WHERE u."schoolId" = $1 AND u.role = 'STUDENT' ORDER BY u.email`,
            [rull.schoolId],
          )
        ).rows.map((row) => [row.email.replace(`${MARKER}-`, '').replace('@example.invalid', ''), row.group]),
      );

    const refusedWith = (code: string) => (error: unknown) => {
      assert.ok(error instanceof ConflictException, summarise(error));
      assert.equal((error.getResponse() as { code?: string }).code, code, summarise(error));
      return true;
    };
    // Before the activation: the year form cannot flip the flag past the
    // moves, the source cannot be deleted from under its pupils, and the new
    // year cannot be moved to start before the old one ends.
    await assert.rejects(rullYears.update(targetYearId, { isActive: true }, rullAdmin), refusedWith('YEAR_ACTIVATION_HAS_MOVES'));
    await assert.rejects(rullYears.remove(rull.sourceYearId, rullAdmin), refusedWith('YEAR_HAS_HOME_PUPILS'));
    await assert.rejects(rullYears.update(targetYearId, { startDate: '2094-06-01' }, rullAdmin), BadRequestException);

    const early = await rollover.previewActivation(targetYearId, rullAdmin, { today: '2094-06-12' });
    await assert.rejects(
      rollover.executeActivation(targetYearId, { planHash: early.planHash }, rullAdmin, { today: '2094-06-12' }),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException, summarise(error));
        assert.equal((error.getResponse() as { code?: string }).code, 'YEAR_ACTIVATION_TOO_EARLY');
        return true;
      },
    );

    const today = { today: '2094-06-13' };
    const preview = await rollover.previewActivation(targetYearId, rullAdmin, today);
    assert.deepEqual(
      preview.moves.map((move) => [move.fromGroupName, move.toGroupName, move.count]),
      [[`${MARKER} 7A`, `${MARKER} 8A`, 2]],
    );
    assert.equal(preview.graduates.count, 1);
    const result = await rollover.executeActivation(targetYearId, { planHash: preview.planHash }, rullAdmin, today);
    assert.deepEqual(result, { year: { id: targetYearId, name: rolloverOptions.name, isActive: true }, moved: 2, graduated: 1, unplaced: 0 });
    assert.deepEqual(await homes(), {
      'rull-p1': `${MARKER} 8A`,
      'rull-p2': `${MARKER} 8A`,
      'rull-p3': null,
      'rull-p4': `${MARKER} 7A`,
    });
    const active = (
      await owner.query<{ id: string }>(`SELECT id FROM "AcademicYears" WHERE "schoolId" = $1 AND "isActive"`, [rull.schoolId])
    ).rows;
    assert.deepEqual(active, [{ id: targetYearId }]);

    // Twice is once.
    const again = await rollover.previewActivation(targetYearId, rullAdmin, today);
    assert.equal(again.moves.length, 0);
    assert.deepEqual(
      await rollover.executeActivation(targetYearId, { planHash: again.planHash }, rullAdmin, today),
      { year: { id: targetYearId, name: rolloverOptions.name, isActive: true }, moved: 0, graduated: 0, unplaced: 0 },
    );

    // The old year again: superseded, by the activation and by the year form;
    // and the new year now holds the home classes, so it is not deleted.
    await assert.rejects(rullYears.update(rull.sourceYearId, { isActive: true }, rullAdmin), refusedWith('YEAR_IS_SUPERSEDED'));
    await assert.rejects(rullYears.remove(targetYearId, rullAdmin), refusedWith('YEAR_HAS_HOME_PUPILS'));
    const back = await rollover.previewActivation(rull.sourceYearId, rullAdmin, today);
    await assert.rejects(
      rollover.executeActivation(rull.sourceYearId, { planHash: back.planHash }, rullAdmin, today),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException, summarise(error));
        assert.equal((error.getResponse() as { code?: string }).code, 'YEAR_IS_SUPERSEDED');
        return true;
      },
    );
  });

  await check('(x2) a year two links back stays superseded, a stale activation moves nobody, and an inactive pupil holds the year it is in', async () => {
    const refusedWith = (code: string) => (error: unknown) => {
      assert.ok(error instanceof ConflictException, summarise(error));
      assert.equal((error.getResponse() as { code?: string }).code, code, summarise(error));
      return true;
    };
    const pupil = async (name: string) =>
      (
        await owner.query<{ id: string; group: string | null }>(
          `SELECT u.id, g.name AS "group" FROM "Users" u LEFT JOIN "StudentGroups" g ON g.id = u."studentGroupId"
            WHERE u.email = $1`,
          [`${MARKER}-${name}@example.invalid`],
        )
      ).rows[0];

    // p4, inactive, was left in the source's 7A by the activation: the source
    // is still somebody's year, and deleting it would clear that silently.
    await assert.rejects(rullYears.remove(rull.sourceYearId, rullAdmin), (error: unknown) => {
      refusedWith('YEAR_HAS_HOME_PUPILS')(error);
      assert.deepEqual((error as ConflictException).getResponse(), {
        message:
          'Läsåret har klasser som är hemklass för 1 elever, varav 1 inaktiva. ' +
          'Flytta eleverna, eller aktivera ett annat läsår som tar över dem, innan läsåret tas bort.',
        code: 'YEAR_HAS_HOME_PUPILS',
        params: { pupils: 1, inactive: 1 },
      });
      return true;
    });

    // Roll the new year on: A → B → C.
    const third = { name: `${MARKER} rull tre`, startDate: '2095-08-15', endDate: '2096-06-10', graduatingGradeLevel: 9 };
    const rolled = await rollover.previewRollover(targetYearId, third, rullAdmin);
    assert.equal(rolled.blocking, false, JSON.stringify(rolled.problems));
    const yearC = (await rollover.executeRollover(targetYearId, { ...third, planHash: rolled.planHash }, rullAdmin)).academicYear.id;
    thirdYearId = yearC;

    // A stale activation: p2 leaves B's 8A between the preview and the
    // execute. Nobody moves, the flag stays, and a fresh preview moves both.
    const today = { today: '2095-06-12' };
    const preview = await rollover.previewActivation(yearC, rullAdmin, today);
    const p2 = await pupil('rull-p2');
    const b8a = (await owner.query<{ id: string }>('SELECT "studentGroupId" AS id FROM "Users" WHERE id = $1', [p2.id])).rows[0].id;
    await owner.query('UPDATE "Users" SET "studentGroupId" = NULL WHERE id = $1', [p2.id]);
    await assert.rejects(
      rollover.executeActivation(yearC, { planHash: preview.planHash }, rullAdmin, today),
      refusedWith('ACTIVATION_PREVIEW_STALE'),
    );
    assert.equal((await pupil('rull-p1')).group, `${MARKER} 8A`, 'a stale activation moved a pupil');
    const stillActive = (await owner.query<{ id: string }>(`SELECT id FROM "AcademicYears" WHERE "schoolId" = $1 AND "isActive"`, [rull.schoolId])).rows;
    assert.deepEqual(stillActive, [{ id: targetYearId }], 'a stale activation handed the flag over');
    await owner.query('UPDATE "Users" SET "studentGroupId" = $2 WHERE id = $1', [p2.id, b8a]);
    const fresh = await rollover.previewActivation(yearC, rullAdmin, today);
    assert.deepEqual(
      (await rollover.executeActivation(yearC, { planHash: fresh.planHash }, rullAdmin, today)).moved,
      2,
    );

    // A, two links back from where the pupils are, with B empty: superseded.
    await assert.rejects(rullYears.update(rull.sourceYearId, { isActive: true }, rullAdmin), refusedWith('YEAR_IS_SUPERSEDED'));
    const back = await rollover.previewActivation(rull.sourceYearId, rullAdmin, today);
    assert.deepEqual(
      back.problems.map((problem) => [problem.code, problem.params['successor']]),
      [['YEAR_IS_SUPERSEDED', third.name]],
    );
  });

  await check('(x3) an active year with a straggler in last year\'s class names it instead of calling itself not activated, and its own activation moves them', async () => {
    const pupil = async (name: string) =>
      (
        await owner.query<{ id: string; group: string | null }>(
          `SELECT u.id, g.name AS "group" FROM "Users" u LEFT JOIN "StudentGroups" g ON g.id = u."studentGroupId"
            WHERE u.email = $1`,
          [`${MARKER}-${name}@example.invalid`],
        )
      ).rows[0];
    const refusedWith = (code: string) => (error: unknown) => {
      assert.ok(error instanceof ConflictException, summarise(error));
      assert.equal((error.getResponse() as { code?: string }).code, code, summarise(error));
      return true;
    };
    const today = { today: '2095-06-12' };
    assert.ok(thirdYearId, '(x2) did not roll the third year');
    // p4 comes back: a straggler in A's 7A while C is active. The rollover of
    // C names that, the activation of the active C moves them, and then C rolls.
    const p4 = await pupil('rull-p4');
    await owner.query('UPDATE "Users" SET "isActive" = true WHERE id = $1', [p4.id]);
    const fourth = { name: `${MARKER} rull fyra`, startDate: '2096-08-13', endDate: '2097-06-09', graduatingGradeLevel: 9 };
    await assert.rejects(rollover.previewRollover(thirdYearId, fourth, rullAdmin), (error: unknown) => {
      refusedWith('ROLLOVER_SOURCE_HAS_STRAGGLERS')(error);
      assert.deepEqual(((error as ConflictException).getResponse() as { params?: unknown }).params, { year: `${MARKER} rull tre`, pupils: 1 });
      return true;
    });
    const stragglers = await rollover.previewActivation(thirdYearId, rullAdmin, today);
    assert.deepEqual(
      stragglers.moves.map((move) => [move.fromGroupName, move.toGroupName, move.studentIds]),
      [[`${MARKER} 7A`, `${MARKER} 9A`, [p4.id]]],
    );
    await rollover.executeActivation(thirdYearId, { planHash: stragglers.planHash }, rullAdmin, today);
    assert.equal((await pupil('rull-p4')).group, `${MARKER} 9A`);
    assert.equal((await rollover.previewRollover(thirdYearId, fourth, rullAdmin)).blocking, false);
  });

  await check('(y) the SS12000 sync keeps a pupil whose roster still names last year\'s class, under the service principal', async () => {
    // After (x2)/(x3): C is active, rolled from B; p1 is in C's 9A, the
    // promoted B-8A. A register that has not rolled yet still sends "8A".
    const sync = new Ss12000Service(api);
    const home = async () =>
      (
        await owner.query<{ group: string | null }>(
          `SELECT g.name AS "group" FROM "Users" u LEFT JOIN "StudentGroups" g ON g.id = u."studentGroupId" WHERE u.email = $1`,
          [`${MARKER}-rull-p1@example.invalid`],
        )
      ).rows[0].group;
    assert.equal(await home(), `${MARKER} 9A`);
    const stale = await sync.importPersons(rull.schoolId, [
      { email: `${MARKER}-rull-p1@example.invalid`, groupDisplayName: `${MARKER} 8A` },
    ]);
    assert.deepEqual(stale, { updated: 1, groupsCreated: 0, guardianLinks: 0, classesKept: 1, needsProvisioning: [] });
    assert.equal(await home(), `${MARKER} 9A`, 'the sync moved a pupil back into last year\'s name');
    // The pupil's own class name is a plain match, and moves nothing either.
    const same = await sync.importPersons(rull.schoolId, [
      { email: `${MARKER}-rull-p1@example.invalid`, groupDisplayName: `${MARKER} 9A` },
    ]);
    assert.equal(same.classesKept, 0);
    assert.equal(await home(), `${MARKER} 9A`);
  });

  await check('(j) raw reads the code relies on come back as the types it compares', async () => {
    // assertRlsIsEnforceable's statement. It tests the two attributes for
    // truth, so a 'f' string would refuse every boot, and it compares the
    // count with > 0, which a bigint would still pass but a string would not.
    const [role] = await api.$queryRaw<
      { name: unknown; rolsuper: unknown; rolbypassrls: unknown; unforcedOwnedTables: unknown }[]
    >`
      SELECT current_user::text AS name,
             r.rolsuper,
             r.rolbypassrls,
             (SELECT count(*)::int
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public'
                 AND c.relkind = 'r'
                 AND NOT c.relforcerowsecurity
                 AND c.relowner = r.oid) AS "unforcedOwnedTables"
        FROM pg_roles r
       WHERE r.rolname = current_user
    `;
    assert.deepEqual(role, {
      name: 'app_authenticated',
      rolsuper: false,
      rolbypassrls: false,
      unforcedOwnedTables: 0,
    });

    // users.service.ts reads the stored role and class raw and compares them
    // with enum strings and uuids.
    const [pupil] = await api.withRls(admin, (tx) =>
      tx.$queryRaw<{ role: unknown; studentGroupId: unknown }[]>`
        SELECT "role", "studentGroupId"
        FROM "Users"
        WHERE "id" = ${fixture.pupilId}::uuid
        FOR NO KEY UPDATE
      `,
    );
    assert.equal(pupil?.role, 'STUDENT');
    assert.match(String(pupil?.studentGroupId), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(typeof pupil?.studentGroupId, 'string');

    // No raw read in src/ returns a bigint, numeric or json column — every
    // count is cast ::int. These pin what an uncast one gives, the same as
    // Prisma 5 gave, so the next raw read written against them is not a guess.
    const [types] = await api.$queryRaw<{ n: unknown; amount: unknown; doc: unknown }[]>`
      SELECT count(*) AS n, 1.50::numeric AS amount, '{"a": [1, "b"]}'::jsonb AS doc
    `;
    assert.equal(typeof types.n, 'bigint', `count(*) came back as ${shapeOf(types.n)}`);
    assert.ok(types.amount instanceof Prisma.Decimal, `numeric came back as ${shapeOf(types.amount)}`);
    assert.equal((types.amount as Prisma.Decimal).toString(), '1.5');
    assert.deepEqual(types.doc, { a: [1, 'b'] });
  });
}


/** The throwaway school (w) and (x) roll and activate, created as the owner, filled as its admin. */
interface RolloverSchool {
  schoolId: string;
  adminId: string;
  adminAuthId: string;
  teacherId: string;
  sourceYearId: string;
  group7a: string;
  groupMa7: string;
  breakId: string;
}

async function givenRolloverSchool(owner: Client): Promise<RolloverSchool> {
  const one = async <T extends object>(sql: string, params: unknown[]): Promise<T> =>
    (await owner.query<T>(sql, params)).rows[0];
  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${MARKER} rullgw`, `${MARKER}-rullgw`],
  );
  const person = (role: string, email: string, groupId: string | null = null) =>
    one<{ id: string; authId: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, 'Probe', 'Rull', $3::"UserRole", gen_random_uuid(), true, $4, now()) RETURNING id, "authId"`,
      [school.id, `${MARKER}-${email}@example.invalid`, role, groupId],
    );
  const admin = await person('SCHOOL_ADMIN', 'rull-admin');
  const teacher = await person('TEACHER', 'rull-teacher');
  const principal: AuthenticatedUser = {
    authId: admin.authId,
    userId: admin.id,
    schoolId: school.id,
    role: Role.SCHOOL_ADMIN,
  };
  const api = prismaServiceFor(requiredEnv('DATABASE_URL'));
  try {
    const year = await new AcademicYearsService(api).create(
      { name: `${MARKER} rull källa`, startDate: '2093-08-17', endDate: '2094-06-12', isActive: true },
      principal,
    );
    const made = await api.withRls(principal, async (tx) => {
      const group = (name: string, gradeLevel: number, kind: 'CLASS' | 'TEACHING_GROUP' = 'CLASS') =>
        tx.studentGroup.create({ data: { schoolId: school.id, academicYearId: year.id, name, gradeLevel, kind } });
      const g7a = await group(`${MARKER} 7A`, 7);
      const g9a = await group(`${MARKER} 9A`, 9);
      const ma7 = await group(`${MARKER} Ma7`, 7, 'TEACHING_GROUP');
      const subject = await tx.subject.create({ data: { schoolId: school.id, name: `${MARKER} matematik` } });
      const lov = await tx.schoolBreak.create({
        data: {
          schoolId: school.id,
          academicYearId: year.id,
          name: 'Höstlov',
          startDate: new Date('2093-10-26T00:00:00Z'),
          endDate: new Date('2093-10-30T00:00:00Z'),
        },
      });
      await tx.availabilityConstraint.create({
        data: {
          schoolId: school.id,
          resourceType: 'STUDENT_GROUP',
          studentGroupId: g7a.id,
          dayOfWeek: 5,
          startTime: new Date('1970-01-01T13:00:00Z'),
          endTime: new Date('1970-01-01T15:00:00Z'),
        },
      });
      return { g7a, g9a, ma7, subject, lov };
    });
    await new TeachingRequirementsService(api).create(
      {
        academicYearId: year.id,
        subjectId: made.subject.id,
        studentGroupId: made.g7a.id,
        teacherId: teacher.id,
        lessonsPerWeek: 2,
        minutesPerLesson: 60,
        startDate: '2094-01-11',
        endDate: '2094-06-12',
      },
      principal,
    );
    // Pupils: two in 7A, one in 9A (who graduates), and one in Ma7 from 7A
    // and one from 9A (who is not carried into Ma8). p4 is in 7A but inactive.
    const p1 = await person('STUDENT', 'rull-p1', made.g7a.id);
    await person('STUDENT', 'rull-p2', made.g7a.id);
    const p3 = await person('STUDENT', 'rull-p3', made.g9a.id);
    const p4 = await person('STUDENT', 'rull-p4', made.g7a.id);
    await owner.query('UPDATE "Users" SET "isActive" = false WHERE id = $1', [p4.id]);
    await api.withRls(principal, (tx) =>
      tx.studentGroupMember.createMany({
        data: [p1, p3].map((pupil) => ({ schoolId: school.id, studentGroupId: made.ma7.id, studentId: pupil.id })),
      }),
    );
    return {
      schoolId: school.id,
      adminId: admin.id,
      adminAuthId: admin.authId,
      teacherId: teacher.id,
      sourceYearId: year.id,
      group7a: made.g7a.id,
      groupMa7: made.ma7.id,
      breakId: made.lov.id,
    };
  } finally {
    await api.$disconnect();
  }
}

/** Every row of the source year a rollover could touch, and the school's pupils, as one checksum. */
async function sourceChecksum(owner: Client, yearId: string): Promise<string> {
  const { rows } = await owner.query<{ sum: string }>(
    `WITH groups AS (SELECT id FROM "StudentGroups" WHERE "academicYearId" = $1)
     SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS sum FROM (
       SELECT to_jsonb(y)::text AS x FROM "AcademicYears" y WHERE y.id = $1
       UNION ALL SELECT to_jsonb(g)::text FROM "StudentGroups" g WHERE g."academicYearId" = $1
       UNION ALL SELECT to_jsonb(m)::text FROM "StudentGroupMembers" m WHERE m."studentGroupId" IN (SELECT id FROM groups)
       UNION ALL SELECT to_jsonb(r)::text FROM "TeachingRequirements" r WHERE r."academicYearId" = $1
       UNION ALL SELECT to_jsonb(b)::text FROM "SchoolBreaks" b WHERE b."academicYearId" = $1
       UNION ALL SELECT to_jsonb(c)::text FROM "AvailabilityConstraints" c WHERE c."studentGroupId" IN (SELECT id FROM groups)
       UNION ALL SELECT to_jsonb(u)::text FROM "Users" u
         WHERE u."schoolId" = (SELECT "schoolId" FROM "AcademicYears" WHERE id = $1)
     ) rows`,
    [yearId],
  );
  return rows[0].sum;
}

async function dropRolloverTrigger(owner: Client): Promise<void> {
  await owner.query('DROP TRIGGER IF EXISTS probe_rull_refuse ON "TeachingRequirements"');
  await owner.query('DROP FUNCTION IF EXISTS public.probe_rull_refuse()');
}

// ---- setup

async function findFixture(owner: Client): Promise<Fixture> {
  const school = await onlyRow<{ id: string }>(
    owner,
    `SELECT id FROM "Schools" WHERE slug = 'demo-skola'`,
    [],
    'the demo school (npm run db:seed)',
  );
  const admin = await onlyRow<{ id: string; authId: string }>(
    owner,
    `SELECT id, "authId" FROM "Users"
      WHERE "schoolId" = $1 AND role = 'SCHOOL_ADMIN' AND "isActive" AND "authId" IS NOT NULL
      ORDER BY email LIMIT 1`,
    [school.id],
    'an active SCHOOL_ADMIN of the demo school',
  );
  const room = await onlyRow<{ id: string }>(
    owner,
    `SELECT id FROM "Rooms" WHERE "schoolId" = $1 AND NOT "requiresApproval" ORDER BY name LIMIT 1`,
    [school.id],
    'a room of the demo school that needs no approval',
  );
  const constraint = await onlyRow<{ id: string }>(
    owner,
    `SELECT id FROM "AvailabilityConstraints" WHERE "schoolId" = $1 ORDER BY id LIMIT 1`,
    [school.id],
    'an availability constraint of the demo school',
  );
  const activeYear = await onlyRow<{ id: string }>(
    owner,
    `SELECT id FROM "AcademicYears" WHERE "schoolId" = $1 AND "isActive"`,
    [school.id],
    'the demo school’s active academic year',
  );
  const pupil = await onlyRow<{ id: string }>(
    owner,
    `SELECT id FROM "Users"
      WHERE "schoolId" = $1 AND role = 'STUDENT' AND "studentGroupId" IS NOT NULL
      ORDER BY email LIMIT 1`,
    [school.id],
    'a pupil with a class in the demo school',
  );
  const foreignYear = await onlyRow<{ id: string }>(
    owner,
    `SELECT y.id FROM "AcademicYears" y JOIN "Schools" s ON s.id = y."schoolId"
      WHERE s.slug = 'rls-fixture-school' AND y.name = 'RLS Fixture Year'`,
    [],
    'the RLS fixture school’s year (run scripts/test/run-rls-tests.sh first)',
  );

  const grundskola = await onlyRow<{ id: string }>(
    owner,
    `SELECT id FROM "NationalTimplanVersions" WHERE code = 'SFS2023:945/B1'`,
    [],
    'bilaga 1 of the national timplan (migration 20261006090000)',
  );

  return {
    grundskolaVersionId: grundskola.id,
    schoolId: school.id,
    admin: {
      authId: admin.authId,
      userId: admin.id,
      schoolId: school.id,
      role: Role.SCHOOL_ADMIN,
    },
    roomId: room.id,
    constraintId: constraint.id,
    activeYearId: activeYear.id,
    pupilId: pupil.id,
    foreignYearId: foreignYear.id,
  };
}

/** Removes what the probe writes. Narrow enough to touch nothing else. */
async function sweep(owner: Client, schoolId: string): Promise<void> {
  await owner.query('DELETE FROM "RoomBookings" WHERE title = $1', [MARKER]);
  // Duties first: TeacherDuties_take_their_block deletes each one's slot with
  // it (the service writes the slot's reason as the bare word "Uppdrag", so a
  // reason match could not find them, and must not: it would take the seed's).
  await owner.query(`DELETE FROM "TeacherDuties" WHERE "schoolId" = $1 AND label LIKE $2 || '%'`, [schoolId, MARKER]);
  await owner.query(`DELETE FROM "AvailabilityConstraints" WHERE "schoolId" = $1 AND reason LIKE $2 || '%'`, [schoolId, MARKER]);
  // (s)'s next year, for a run that stopped before deleting it; its duties and slots go with it.
  await owner.query(`DELETE FROM "AcademicYears" WHERE "schoolId" = $1 AND name = $2 || ' nästa år'`, [schoolId, MARKER]);
  // (u)'s year, for a run that stopped first: its groups, rows and attachments go with it.
  await owner.query(`DELETE FROM "AcademicYears" WHERE "schoolId" = $1 AND name = $2 || ' p2'`, [schoolId, MARKER]);
  // (v)'s chain and its throwaway school, for a run that stopped half-way;
  // the groups cascade, and the link triggers let the foreign keys clear.
  await owner.query(`DELETE FROM "AcademicYears" WHERE "schoolId" = $1 AND name LIKE $2 || ' rull %'`, [schoolId, MARKER]);
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-rullning'`, [MARKER]);
  // (w)/(x)'s school, whole, and (w)'s temporary trigger if a run died inside it.
  await dropRolloverTrigger(owner);
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-rullgw'`, [MARKER]);
  // The throwaway person (p) deletes through the service; this is for a run that stopped first.
  await owner.query(`DELETE FROM "Users" WHERE "schoolId" = $1 AND email = $2 || '-duty@example.invalid'`, [schoolId, MARKER]);
  // (t)'s attachment, for a run that stopped before detaching it: the plan
  // key is ON DELETE RESTRICT, so the plans below would not go while it stands.
  await owner.query(
    `DELETE FROM "AcademicYearTimplans" a USING "LocalTimplans" p
      WHERE p.id = a."localTimplanId" AND p."schoolId" = $1 AND p.name LIKE $2 || '%'`,
    [schoolId, MARKER],
  );
  // Plans before ANY probe subject: a decided plan's entries refuse the
  // subject's cascade (TIMPLAN_IS_DECIDED), and the plans' own cascade passes
  // the trigger. (u)'s subjects sit in a decided plan and match the
  // "MARKER %" subject delete below, so a (u) that stopped before removing
  // its plan made every later run fail here until this came first.
  await owner.query(`DELETE FROM "LocalTimplans" WHERE "schoolId" = $1 AND name LIKE $2 || '%'`, [schoolId, MARKER]);
  // (r): the person (their post goes with them), the two subjects (their
  // timplansposter go with them) and the policy row the probe created.
  await owner.query(`DELETE FROM "Users" WHERE "schoolId" = $1 AND email = $2 || '-staff@example.invalid'`, [schoolId, MARKER]);
  await owner.query(`DELETE FROM "Subjects" WHERE "schoolId" = $1 AND name LIKE $2 || ' %'`, [schoolId, MARKER]);
  await owner.query('DELETE FROM "StaffingPolicies" WHERE "schoolId" = $1 AND "fullTimeAnnualHours" = $2', [
    schoolId,
    PROBE_ANNUAL_HOURS,
  ]);
  await owner.query('DELETE FROM "Subjects" WHERE "schoolId" = $1 AND name = $2', [schoolId, MARKER]);
  await owner.query('DELETE FROM "Rasts" WHERE "schoolId" = $1 AND name = $2', [schoolId, MARKER]);
  for (const table of ['FrameTimes', 'LunchServings']) {
    await owner.query(
      `DELETE FROM "${table}"
        WHERE "schoolId" = $1 AND "minGradeLevel" = $2 AND "maxGradeLevel" = $3
          AND "dayOfWeek" = $4 AND "startTime" = $5::time`,
      [
        schoolId,
        PROBE_WINDOW.minGradeLevel,
        PROBE_WINDOW.maxGradeLevel,
        PROBE_WINDOW.dayOfWeek,
        PROBE_WINDOW.startTime,
      ],
    );
  }
}

async function onlyRow<T extends object>(
  owner: Client,
  sql: string,
  params: unknown[],
  what: string,
): Promise<T> {
  const { rows } = await owner.query<T>(sql, params);
  if (rows.length !== 1) {
    throw new Error(`Setup: expected ${what}, found ${rows.length} rows.`);
  }
  return rows[0];
}

// ---- helpers

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set; see the header of scripts/test/prisma-adapter-probe.ts.`);
  }
  return value;
}

/** A PrismaService built as Nest builds it — from DATABASE_URL — for this URL. */
function prismaServiceFor(databaseUrl: string): PrismaService {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = databaseUrl;
  try {
    return new PrismaService();
  } finally {
    process.env.DATABASE_URL = previous;
  }
}

function withConnectionLimit(databaseUrl: string, limit: number): string {
  const queryStart = databaseUrl.indexOf('?');
  const base = queryStart === -1 ? databaseUrl : databaseUrl.slice(0, queryStart);
  const params = new URLSearchParams(queryStart === -1 ? '' : databaseUrl.slice(queryStart + 1));
  params.set('connection_limit', String(limit));
  return `${base}?${params.toString()}`;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function sameInstant(label: string, model: unknown, raw: unknown): void {
  assert.ok(model instanceof Date, `${label}: the model API returned ${shapeOf(model)}, not a Date`);
  assert.ok(raw instanceof Date, `${label}: $queryRaw returned ${shapeOf(raw)}, not a Date`);
  assert.equal(
    raw.getTime(),
    model.getTime(),
    `${label}: $queryRaw read ${raw.toISOString()}, the model API ${model.toISOString()}`,
  );
}

/** The SQLSTATE a Prisma error carries, from the adapter's cause or the message. */
function sqlStateOf(error: unknown): string | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const meta = error.meta as
    | { driverAdapterError?: { cause?: { originalCode?: unknown } } }
    | undefined;
  const original = meta?.driverAdapterError?.cause?.originalCode;
  if (typeof original === 'string') return original;
  return /Code: `([0-9A-Z]{5})`/.exec(error.message)?.[1];
}

function shapeOf(value: unknown): string {
  return `${typeof value} ${value instanceof Object ? value.constructor.name : ''} ${String(value)}`;
}

function summarise(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `${error.name} ${error.code}: ${error.message} ${JSON.stringify(error.meta ?? {})}`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function check(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    throw new ProbeFailure(label, error);
  }
  console.log(`ok   ${label}`);
}

main().then(
  () => {
    console.log('==> Prisma adapter probe passed');
  },
  (error: unknown) => {
    if (error instanceof ProbeFailure) {
      console.error(`FAIL ${error.label}\n     ${summarise(error.failure)}`);
    } else {
      console.error(`FAIL ${summarise(error)}`);
    }
    process.exitCode = 1;
  },
);
