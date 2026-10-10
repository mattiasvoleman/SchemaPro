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
import { randomUUID } from 'node:crypto';
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
import { TimplanCoverageService, readPlannedInput } from '../../src/timplan/timplan-coverage.service';
import { TimplanStageService } from '../../src/timplan/timplan-stage.service';
import { TimplanRequirementsService } from '../../src/timplan/timplan-requirements.service';
import { TimplanCreditsService } from '../../src/timplan/timplan-credits.service';
import { readDeliveredRows, staffingCreditStatement } from '../../src/timplan/timplan-delivered.sql';
import type { DeliveredLineDetail } from '../../src/common/timplan-delivered';
import {
  decidedTimplanRefusal,
  isTimplanInUseRefusal,
  rethrowPrismaError,
  rolloverLinkRefusal,
  teacherDutyBlockRefusal,
  timplanCreditKeyField,
} from '../../src/common/utils/prisma-errors';
import { UsersService } from '../../src/users/users.service';
import type { SupabaseAdminService } from '../../src/users/supabase-admin.service';
import { TeacherDutiesService } from '../../src/staffing/teacher-duties.service';
import { attendanceSpan, lockEmploymentsOf } from '../../src/staffing/staffing-enforcement';
import { TeachingRequirementsService } from '../../src/resources/teaching-requirements.service';
import { OptimizationProxyService } from '../../src/optimization/optimization-proxy.service';
import { YearRolloverService } from '../../src/year-rollover/year-rollover.service';
import { StaffingRolloverService } from '../../src/year-rollover/staffing-rollover.service';
import { TeacherEmploymentsService } from '../../src/staffing/teacher-employments.service';
import { StaffingLoadService } from '../../src/staffing/staffing-load.service';
import { lockStaffRow } from '../../src/staffing/staff-lock';
import { countHomePupils, rostersOfYear, type RosterBasis } from '../../src/year-rollover/projected-rosters';
import { loadRosters } from '../../src/optimization/room-eligibility';
import { RoomOptimizationService } from '../../src/optimization/room-optimization.service';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { CalendarLessonsService } from '../../src/calendar/calendar-lessons.service';
import { LunchSittingsService } from '../../src/resources/lunch-sittings.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import type { ScheduleVersionsService } from '../../src/calendar/schedule-versions.service';
import { CalendarService } from '../../src/calendar/calendar.service';
import { PublicationsService } from '../../src/publication/publications.service';
import { DraftService } from '../../src/publication/draft.service';
import { snapshotRanges } from '../../src/publication/published-grundschema';
import { CancellationBatchesService } from '../../src/publication/cancellation-batches.service';
import { PublicLinksService } from '../../src/publication/public-links.service';
import { tokenHashOf } from '../../src/publication/public-token';
import { ScheduleVersionsService as RealScheduleVersionsService } from '../../src/calendar/schedule-versions.service';

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
    // Staffing Fas 3: the import's writes are versions by the admin, and the
    // identical re-import is none (the trigger skips an unchanged row).
    const versions = (
      await owner.query<{ action: string; actorId: string | null }>(
        `SELECT l.action::text AS action, l."actorId" FROM "TeacherEmploymentLogs" l
           JOIN "TeacherDuties" d ON d.id = l."entityId" WHERE d.label = $1 ORDER BY l.version`,
        [`${MARKER} import`],
      )
    ).rows;
    assert.deepEqual(versions, [
      { action: 'CREATE', actorId: admin.userId },
      { action: 'UPDATE', actorId: admin.userId },
    ]);
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

  // ---- (u2) lektionslängder: the schema's first array column, through the real adapter
  await check('(u2) lektionslängder round-trip as an int[] through the real adapter, the CHECK is a 400 naming the field, and generate SPLIT writes them', async () => {
    const requirements = new TeachingRequirementsService(api);
    const subjects = new SubjectsService(api);
    const timplans = new LocalTimplansService(api);
    const years = new AcademicYearsService(api);
    const yearTimplans = new AcademicYearTimplansService(api);
    const generator = new TimplanRequirementsService(api);

    const year = await years.create(
      { name: `${MARKER} ll`, startDate: '2097-08-17', endDate: '2098-06-11' } as never,
      admin,
    );
    const idrott = await subjects.create({ name: `${MARKER} ll-idrott` } as never, admin);
    const matematik = await subjects.create({ name: `${MARKER} ll-ma`, nationalCode: 'MA' } as never, admin);
    const classId = (
      await owner.query<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
         VALUES ($1, $2, $3 || ' 7A', 'CLASS', 7, now()) RETURNING id`,
        [fixture.schoolId, year.id, MARKER],
      )
    ).rows[0].id;
    const stored = async (id: string) =>
      (
        await owner.query<{ lessonLengths: unknown; lessonsPerWeek: number; minutesPerLesson: number }>(
          'SELECT "lessonLengths", "lessonsPerWeek", "minutesPerLesson" FROM "TeachingRequirements" WHERE id = $1',
          [id],
        )
      ).rows[0];

    // Written through the service, read back by the model API as number[].
    const created = await requirements.create(
      { academicYearId: year.id, subjectId: idrott.id, studentGroupId: classId, lessonLengths: [40, 80] },
      admin,
    );
    assert.deepEqual(
      [created.lessonsPerWeek, created.minutesPerLesson, created.lessonLengths],
      [2, 80, [80, 40]],
    );
    const read = await api.withRls(admin, (tx) =>
      tx.teachingRequirement.findUnique({ where: { id: created.id }, select: { lessonLengths: true } }),
    );
    assert.ok(Array.isArray(read?.lessonLengths), `lessonLengths read back as ${shapeOf(read?.lessonLengths)}`);
    assert.ok(read!.lessonLengths.every((minutes) => typeof minutes === 'number'), JSON.stringify(read));
    assert.deepEqual(read!.lessonLengths, [80, 40]);

    // The merge over the stored row, through the real adapter: equal scalars keep it, others clear it.
    await requirements.update(created.id, { lessonsPerWeek: 2, minutesPerLesson: 80 }, admin);
    assert.deepEqual(await stored(created.id), { lessonLengths: [80, 40], lessonsPerWeek: 2, minutesPerLesson: 80 });
    const uniform = await requirements.update(created.id, { lessonsPerWeek: 3, minutesPerLesson: 60 }, admin);
    assert.equal('lessonLengths' in uniform, false, 'a uniform row was answered with its list');
    assert.deepEqual(await stored(created.id), { lessonLengths: [], lessonsPerWeek: 3, minutesPerLesson: 60 });

    // A writer past the service — PostgREST's SQL, here the model API — meets
    // the CHECK, and rethrowPrismaError names the field.
    await requirements.update(created.id, { lessonLengths: [80, 40] }, admin);
    for (const data of [{ lessonsPerWeek: 3 }, { lessonLengths: [60, 60], lessonsPerWeek: 2, minutesPerLesson: 60 }]) {
      try {
        await api.withRls(admin, (tx) => tx.teachingRequirement.update({ where: { id: created.id }, data }));
        assert.fail(`the CHECK let ${JSON.stringify(data)} through`);
      } catch (error) {
        assert.equal(sqlStateOf(error), '23514', summarise(error));
        assert.throws(() => rethrowPrismaError(error), (thrown: unknown) => {
          assert.ok(thrown instanceof BadRequestException, summarise(thrown));
          assert.ok(thrown.message.startsWith('lessonLengths: '), thrown.message);
          return true;
        });
      }
    }
    assert.deepEqual(await stored(created.id), { lessonLengths: [80, 40], lessonsPerWeek: 2, minutesPerLesson: 80 });

    // Generate with SPLIT writes 175 as 2 × 60 + 1 × 55; the same call without the mode is today's preview.
    const plan = await timplans.create(
      { name: `${MARKER} ll`, schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: fixture.grundskolaVersionId },
      admin,
    );
    await timplans.replaceEntries(plan.id, { entries: [{ subjectId: matematik.id, gradeLevel: 7, minutesPerWeek: 175 }] }, admin);
    await yearTimplans.replace(year.id, { timplans: [{ gradeLevel: 7, localTimplanId: plan.id }] }, admin);
    const roundUp = await generator.generate(plan.id, { academicYearId: year.id, minutesPerLesson: 60, dryRun: true }, admin);
    assert.deepEqual(
      roundUp.rows.map((row) => [row.lessonsPerWeek, row.minutesPerLesson, row.surplusMinutesPerWeek, 'lessonLengths' in row]),
      [[3, 60, 5, false]],
    );
    const split = await generator.generate(
      plan.id,
      { academicYearId: year.id, minutesPerLesson: 60, remainder: 'SPLIT', dryRun: false },
      admin,
    );
    assert.equal(split.created, 1, JSON.stringify(split));
    assert.deepEqual(await stored(split.rows[0]!.requirementId!), {
      lessonLengths: [60, 60, 55],
      lessonsPerWeek: 3,
      minutesPerLesson: 60,
    });

    await years.remove(year.id, admin);
    await timplans.remove(plan.id, admin);
    await subjects.remove(idrott.id, admin);
    await subjects.remove(matematik.id, admin);
  });

  // ---- (u3) tillgodoräknad tid through the real adapter
  await check('(u3) a timplan credit round-trips under RLS, a CHECK or key reached past the DTO is a 400 naming the field, and a teacher reads but cannot write', async () => {
    const credits = new TimplanCreditsService(api);
    const subjects = new SubjectsService(api);
    const years = new AcademicYearsService(api);

    const year = await years.create(
      { name: `${MARKER} kredit`, startDate: '2096-08-17', endDate: '2097-06-11' } as never,
      admin,
    );
    const idrott = await subjects.create({ name: `${MARKER} kredit-idrott` } as never, admin);
    const classId = (
      await owner.query<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
         VALUES ($1, $2, $3 || ' 7A', 'CLASS', 7, now()) RETURNING id`,
        [fixture.schoolId, year.id, MARKER],
      )
    ).rows[0].id;

    const created = await credits.create(
      {
        academicYearId: year.id,
        date: '2096-09-25',
        minutes: 300,
        subjectId: idrott.id,
        minGradeLevel: 7,
        maxGradeLevel: 9,
        name: ' Friluftsdag ',
        note: '  ',
      },
      admin,
    );
    assert.deepEqual(
      [created.date, created.minutes, created.subjectId, created.minGradeLevel, created.maxGradeLevel, created.name, created.note],
      ['2096-09-25', 300, idrott.id, 7, 9, 'Friluftsdag', null],
    );
    // The DATE round-trips as the day it is, through the adapter, under RLS.
    const raw = await owner.query<{ date: string }>(`SELECT date::text AS date FROM "TimplanCredits" WHERE id = $1`, [created.id]);
    assert.equal(raw.rows[0]?.date, '2096-09-25');

    // The PATCH replaces the scope whole.
    const moved = await credits.update(created.id, { studentGroupId: classId }, admin);
    assert.deepEqual([moved.studentGroupId, moved.minGradeLevel, moved.maxGradeLevel], [classId, null, null]);
    await assert.rejects(
      credits.create({ academicYearId: year.id, date: '2097-06-14', minutes: 60, name: 'Utanför' }, admin),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException, summarise(error));
        assert.equal((error.getResponse() as { code?: string }).code, 'TIMPLAN_CREDIT_OUTSIDE_YEAR');
        return true;
      },
    );

    // Past the DTO — PostgREST's SQL, here the model API: the CHECK and the
    // composite key answer, and the gateway's mapping names the field.
    try {
      await api.withRls(admin, (tx) => tx.timplanCredit.update({ where: { id: created.id }, data: { minutes: 601 } }));
      assert.fail('the minutes CHECK let 601 through');
    } catch (error) {
      assert.equal(sqlStateOf(error), '23514', summarise(error));
      assert.throws(() => rethrowPrismaError(error), (thrown: unknown) => {
        assert.ok(thrown instanceof BadRequestException, summarise(thrown));
        assert.ok(thrown.message.startsWith('minutes: '), thrown.message);
        return true;
      });
    }
    try {
      await api.withRls(admin, (tx) =>
        tx.timplanCredit.create({
          data: { schoolId: fixture.schoolId, academicYearId: fixture.foreignYearId, date: new Date('2096-09-25T00:00:00Z'), minutes: 60, name: MARKER },
        }),
      );
      assert.fail('another school’s year was accepted under a credit stamped with this school');
    } catch (error) {
      assert.equal(sqlStateOf(error), '23503', summarise(error));
      assert.equal(timplanCreditKeyField(error), 'academicYearId', summarise(error));
    }

    // A teacher reads the year's credits — their coverage counts them — and
    // writes none: the INSERT meets WITH CHECK, the DELETE finds no row.
    const teacherRow = (
      await owner.query<{ id: string; authId: string }>(
        `SELECT id, "authId" FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER' AND "isActive" AND "authId" IS NOT NULL
          ORDER BY "authId" LIMIT 1`,
        [fixture.schoolId],
      )
    ).rows[0];
    const teacher = { authId: teacherRow.authId, userId: teacherRow.id, schoolId: fixture.schoolId, role: Role.TEACHER };
    const read = await credits.list(year.id, teacher);
    assert.deepEqual(read.map((row) => row.id), [created.id]);
    await assert.rejects(
      credits.create({ academicYearId: year.id, date: '2096-09-26', minutes: 60, name: MARKER }, teacher),
      (error: unknown) => {
        assert.equal(sqlStateOf(error), '42501', summarise(error));
        return true;
      },
    );
    await assert.rejects(credits.remove(created.id, teacher), NotFoundException);

    await credits.remove(created.id, admin);
    assert.equal((await owner.query('SELECT 1 FROM "TimplanCredits" WHERE id = $1', [created.id])).rowCount, 0);
    await years.remove(year.id, admin);
    await subjects.remove(idrott.id, admin);
  });

  // ---- (u4) the delivered SQL, under RLS, through the real adapter
  await check('(u4) genomförd tid: every bucket the SQL defines, one audience row per shared signature, the per-lesson horizon, and the same figures for an admin and a teacher', async () => {
    const coverage = new TimplanCoverageService(api);
    const DAY = 24 * 60 * 60 * 1000;
    const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const dayAt = (offset: number) => new Date(today.getTime() + offset * DAY).toISOString().slice(0, 10);
    const one = async <T extends object>(sql: string, params: unknown[]): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;

    const year = await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
       VALUES ($1, $2 || ' genomfört', $3::date, $4::date, false, now()) RETURNING id`,
      [fixture.schoolId, MARKER, dayAt(-60), dayAt(200)],
    );
    const subject = await one<{ id: string }>(
      `INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, $2 || ' gf-ma', now()) RETURNING id`,
      [fixture.schoolId, MARKER],
    );
    const mentor = await one<{ id: string }>(
      `INSERT INTO "Subjects" ("schoolId", name, "countsTowardTimplan", "updatedAt") VALUES ($1, $2 || ' gf-ment', false, now()) RETURNING id`,
      [fixture.schoolId, MARKER],
    );
    const group = (name: string, grade: number) =>
      one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
         VALUES ($1, $2, $3 || ' ' || $4, 'CLASS', $5, now()) RETURNING id`,
        [fixture.schoolId, year.id, MARKER, name, grade],
      );
    const sevenA = await group('7A', 7);
    const eightA = await group('8A', 8);
    const pupil = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2 || '-gf@example.invalid', 'Probe', 'Elev', 'STUDENT', gen_random_uuid(), true, $3, now()) RETURNING id`,
      [fixture.schoolId, MARKER, sevenA.id],
    );
    const teacherRow = (
      await owner.query<{ id: string; authId: string }>(
        `SELECT id, "authId" FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER' AND "isActive" AND "authId" IS NOT NULL
          ORDER BY "authId" LIMIT 1`,
        [fixture.schoolId],
      )
    ).rows[0];
    const teacher = { authId: teacherRow.authId, userId: teacherRow.id, schoolId: fixture.schoolId, role: Role.TEACHER };
    await owner.query(
      `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "lessonsPerWeek", "minutesPerLesson", "updatedAt")
       VALUES ($1, $2, $3, $4, 3, 60, now())`,
      [fixture.schoolId, year.id, subject.id, sevenA.id],
    );
    // A lov a week ago that covers the whole school, entered after publish:
    // the cancelled row standing on it is not lost.
    await owner.query(
      `INSERT INTO "SchoolBreaks" ("schoolId", "academicYearId", name, "startDate", "endDate", "updatedAt")
       VALUES ($1, $2, $3, $4::date, $4::date, now())`,
      [fixture.schoolId, year.id, MARKER, dayAt(-7)],
    );
    // And one in two weeks, entered after publish too: the cancelled row
    // standing on it is neither lost nor projected before its day either.
    await owner.query(
      `INSERT INTO "SchoolBreaks" ("schoolId", "academicYearId", name, "startDate", "endDate", "updatedAt")
       VALUES ($1, $2, $3 || ' framåt', $4::date, $4::date, now())`,
      [fixture.schoolId, year.id, MARKER, dayAt(15)],
    );
    const masterLesson = (dayOfWeek: number, extra: string = '') =>
      one<{ id: string }>(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "isParked", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, '08:00', '09:00', $7, now()) RETURNING id`,
        [fixture.schoolId, year.id, subject.id, sevenA.id, teacherRow.id, dayOfWeek, extra === 'parked'],
      );
    // On tomorrow's weekday, with rows tomorrow and a week later: the
    // calendar holds exactly what the master would write — no drift.
    const tomorrow = new Date(today.getTime() + DAY);
    const published = await masterLesson(((tomorrow.getUTCDay() + 6) % 7) + 1);
    const unpublished = await masterLesson(2);
    const parked = await masterLesson(3, 'parked');

    /** One calendar row; a teacher row unless told otherwise; extra group and cause as named. */
    const lesson = async (
      offset: number,
      status: string,
      options: { teacher?: boolean; cause?: string; extra?: string; subjectId?: string; masterLessonId?: string } = {},
    ) => {
      const date = dayAt(offset);
      const row = await one<{ id: string }>(
        `INSERT INTO "CalendarLessons" ("schoolId", "masterLessonId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "cancelCause", "updatedAt")
         VALUES ($1, $2, $3, $4, $5::date, $5::date + time '06:00', $5::date + time '07:00', $6::"LessonStatus", $7::"LessonCancelCause", now())
         RETURNING id`,
        [fixture.schoolId, options.masterLessonId ?? null, options.subjectId ?? subject.id, sevenA.id, date, status, options.cause ?? null],
      );
      if (options.teacher !== false) {
        await owner.query(
          `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, 'SUBSTITUTE')`,
          [fixture.schoolId, row.id, teacherRow.id],
        );
      }
      if (options.extra) {
        await owner.query(
          `INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId") VALUES ($1, $2, $3)`,
          [fixture.schoolId, row.id, options.extra],
        );
      }
      return row;
    };
    await lesson(-14, 'SCHEDULED');
    await lesson(-13, 'SCHEDULED');
    await lesson(-12, 'COMPLETED');
    await lesson(-11, 'SCHEDULED', { teacher: false });
    await lesson(-10, 'CANCELLED', { cause: 'TEACHER_UNAVAILABLE' });
    await lesson(-9, 'CANCELLED');
    await lesson(-7, 'CANCELLED', { cause: 'TEACHER_UNAVAILABLE' });
    await lesson(-6, 'RESCHEDULED');
    // Two lessons shared with 8A, one audience: statement B answers one row of two.
    await lesson(-5, 'SCHEDULED', { extra: eightA.id });
    await lesson(-4, 'SCHEDULED', { extra: eightA.id });
    // A subject that does not count: no bucket at all.
    await lesson(-3, 'SCHEDULED', { subjectId: mentor.id });
    // Ahead: the published master lesson's rows, and the parked one's.
    await lesson(1, 'SCHEDULED', { masterLessonId: published.id });
    await lesson(8, 'CANCELLED', { masterLessonId: published.id, cause: 'MANUAL' });
    await lesson(9, 'SCHEDULED', { masterLessonId: parked.id });
    await lesson(15, 'CANCELLED', { cause: 'TEACHER_UNAVAILABLE' });
    // A credit on a day that had a delivered lesson in its scope.
    await owner.query(
      `INSERT INTO "TimplanCredits" ("schoolId", "academicYearId", date, minutes, "subjectId", "studentGroupId", name, "updatedAt")
       VALUES ($1, $2, $3::date, 120, $4, $5, $6, now())`,
      [fixture.schoolId, year.id, dayAt(-14), subject.id, sevenA.id, MARKER],
    );

    const window = { academicYearId: year.id, yearStart: dayAt(-60), yearEnd: dayAt(200), asOf: new Date() };
    const read = (user: AuthenticatedUser) =>
      api.withRls(user, (tx) => readDeliveredRows(tx, window, [dayAt(-14), dayAt(-7)]));
    const sorted = (rows: Awaited<ReturnType<typeof read>>) => ({
      ...rows,
      audiences: [...rows.audiences].sort((a, b) => `${a.studentGroupId}${a.bucket}${a.extraGroupIds}`.localeCompare(`${b.studentGroupId}${b.bucket}${b.extraGroupIds}`)),
      horizon: [...rows.horizon].sort((a, b) => a.masterLessonId.localeCompare(b.masterLessonId)),
      dates: [...rows.dates].sort((a, b) => a.date.localeCompare(b.date)),
    });
    const forAdmin = sorted(await read(admin));
    const forTeacher = sorted(await read(teacher));
    assert.deepEqual(forTeacher, forAdmin, 'a teacher’s statements answered differently from the admin’s');

    const bucket = (name: string, shared = false) =>
      forAdmin.audiences
        .filter((row) => row.bucket === name && (row.extraGroupIds.length > 0) === shared)
        .map((row) => [row.minutes, row.lessons]);
    assert.deepEqual(bucket('DELIVERED'), [[180, 3]], 'SCHEDULED and COMPLETED with a teacher row are delivered');
    assert.deepEqual(bucket('DELIVERED', true), [[120, 2]], 'two lessons with one audience are one signature row');
    assert.deepEqual(forAdmin.audiences.find((row) => row.extraGroupIds.length > 0)?.extraGroupIds, [eightA.id]);
    assert.deepEqual(bucket('TEACHERLESS'), [[60, 1]]);
    assert.deepEqual(bucket('CANCELLED_TEACHER_UNAVAILABLE'), [[60, 1]]);
    assert.deepEqual(bucket('CANCELLED_UNKNOWN'), [[60, 1]]);
    assert.deepEqual(bucket('CANCELLED_ON_BREAK'), [[60, 1]]);
    assert.deepEqual(bucket('OTHER'), [[60, 1]]);
    assert.deepEqual(bucket('AHEAD'), [[120, 2]]);
    assert.deepEqual(bucket('AHEAD_CANCELLED'), [[60, 1]]);
    assert.deepEqual(bucket('AHEAD_CANCELLED_ON_BREAK'), [[60, 1]], 'a cancelled row on a lov ahead read as cancelled ahead');
    assert.ok(!forAdmin.audiences.some((row) => row.subjectId === mentor.id), 'a subject that does not count reached a bucket');
    assert.deepEqual(forAdmin.published, { from: dayAt(-14), through: dayAt(15) });
    // Every date holding a row, of any subject and status: the gaps are the rest.
    assert.deepEqual(
      forAdmin.publishedDays,
      [-14, -13, -12, -11, -10, -9, -7, -6, -5, -4, -3, 1, 8, 9, 15].map(dayAt),
    );
    assert.deepEqual(
      forAdmin.horizon.map((row) => [row.masterLessonId, row.aheadRows, row.lastDate]),
      [
        [published.id, 2, dayAt(8)],
        [parked.id, 1, dayAt(9)],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    assert.deepEqual(forAdmin.dates, [{ studentGroupId: sevenA.id, date: dayAt(-14), minutes: 60 }]);

    // The service: the hand counts, for the admin with the pupil and the teacher without.
    const answer = await coverage.delivered({ academicYearId: year.id, layer: 'delivered', studentGroupId: sevenA.id }, admin);
    const line = answer.groups.find((g) => g.studentGroupId === sevenA.id)!.lines.find((l) => l.subjectId === subject.id)!;
    assert.deepEqual(
      [line.deliveredMinutes, line.lostMinutes, line.publishedMinutes, line.creditedMinutes],
      [300, 240, 540, 120],
      JSON.stringify(line),
    );
    const projection = (line as DeliveredLineDetail).projection;
    assert.equal(projection.calendarAhead, 120);
    assert.equal(projection.aheadCancelled, 60, 'the cancelled row on the lov ahead counted as cancelled ahead');
    assert.equal((line as DeliveredLineDetail).cancelledOnBreak, 120);
    assert.ok(projection.masterAhead > 0, 'the master lesson with no calendar row was not projected');
    assert.deepEqual(answer.drift?.lessons, 1, `the parked lesson's standing row is not drift: ${JSON.stringify(answer.drift)}`);
    // The drill-down answers for 7A alone; 8A's line is the overview's.
    assert.deepEqual(answer.groups.map((g) => g.studentGroupId), [sevenA.id]);
    const overview = await coverage.delivered({ academicYearId: year.id, layer: 'delivered' }, admin);
    const eighth = overview.groups.find((g) => g.studentGroupId === eightA.id)!.lines.find((l) => l.subjectId === subject.id)!;
    assert.equal(eighth.deliveredMinutes, 120, 'the extra group’s line did not count the shared lessons');
    assert.ok(answer.verdicts.some((v) => v.code === 'TIMPLAN_CREDIT_OVERLAPS_DELIVERED'));
    assert.equal(answer.pupils?.find((p) => p.pupilId === pupil.id)?.lines[0]?.deliveredMinutes, 300);
    const forTeacherAnswer = await coverage.delivered({ academicYearId: year.id, layer: 'delivered', studentGroupId: sevenA.id }, teacher);
    assert.equal(forTeacherAnswer.pupils, null);
    assert.ok(!JSON.stringify(forTeacherAnswer).includes(pupil.id), 'a pupil id reached the teacher');
    assert.deepEqual(
      forTeacherAnswer.groups.map((g) => g.totals),
      answer.groups.map((g) => g.totals),
      'a teacher’s group figures differ from the admin’s',
    );
    void unpublished;

    await owner.query('DELETE FROM "AcademicYears" WHERE id = $1', [year.id]);
    await owner.query('DELETE FROM "Users" WHERE id = $1', [pupil.id]);
    await owner.query('DELETE FROM "Subjects" WHERE id IN ($1, $2)', [subject.id, mentor.id]);
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
  const rull = await givenRolloverSchool(owner, fixture.grundskolaVersionId);
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
    assert.deepEqual(result.counts, { groups: 2, members: 1, requirements: 1, breaks: 1, classRules: 1, timplans: 3 });
    // Timplan per årskurs by cohort, through the adapter's createMany: åk 8
    // keeps the draft its cohort followed in åk 7; åk 7 (the entry grade) and
    // åk 9 (no row for åk 8 below it) take the newest decided plan; åk 9's
    // own cohort graduates and carries nothing. Nothing else: not the grades
    // 1–6 a new year's create would have defaulted.
    const carried = (
      await owner.query<{ grade: number; plan: string }>(
        `SELECT "gradeLevel" AS grade, "localTimplanId" AS plan FROM "AcademicYearTimplans"
          WHERE "academicYearId" = $1 ORDER BY "gradeLevel"`,
        [targetYearId],
      )
    ).rows;
    assert.deepEqual(carried, [
      { grade: 7, plan: rull.decidedPlanId },
      { grade: 8, plan: rull.draftPlanId },
      { grade: 9, plan: rull.decidedPlanId },
    ]);
    assert.deepEqual(
      preview.timplans.map((row) => [row.gradeLevel, row.reason, row.planStatus]),
      [
        [7, 'DEFAULT', 'DECIDED'],
        [8, 'CARRIED', 'DRAFT'],
        [9, 'DEFAULT', 'DECIDED'],
      ],
    );
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

  /*
   * FÖRBERÄKNADE KLASSLISTOR, through the real adapter: what each roster
   * reader computes for the new year before the activation, on the projected
   * rosters, is what it computes after (x) has really moved the pupils.
   * Canonical (ids sorted, nothing anonymous), so Postgres moving the updated
   * tuples cannot make two equal answers look different.
   */
  const rullTeacher: AuthenticatedUser = {
    authId: rull.teacherAuthId,
    userId: rull.teacherId,
    schoolId: rull.schoolId,
    role: Role.TEACHER,
  };
  let projectedReads: Record<string, unknown> | null = null;
  const sortedEntries = (map: Map<string, unknown>) =>
    [...map].map(([key, value]) => [key, value instanceof Set ? [...value].sort() : value]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
  const targetGroup = async (name: string) =>
    (
      await owner.query<{ id: string }>('SELECT id FROM "StudentGroups" WHERE "academicYearId" = $1 AND name = $2', [targetYearId, `${MARKER} ${name}`])
    ).rows[0].id;
  const rosterReads = async (): Promise<{ basis: RosterBasis['kind']; reads: Record<string, unknown> }> => {
    const groups = (
      await owner.query<{ id: string; gradeLevel: number | null }>(
        'SELECT id, "gradeLevel" FROM "StudentGroups" WHERE "academicYearId" = $1 ORDER BY id',
        [targetYearId],
      )
    ).rows;
    const [g8a, ma8] = [await targetGroup('8A'), await targetGroup('Ma8')];
    const proxy = new OptimizationProxyService(
      api,
      { post: () => { throw new Error('the engine was called'); } } as never,
      { getOrThrow: () => ({ baseUrl: 'http://engine.invalid', apiKey: 'k'.repeat(32), timeoutMs: 1 }) } as never,
    );
    const lessons = new MasterLessonsService(api, { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService, {} as NotificationsService);
    const { basis, reads } = await api.withRls(rullAdmin, async (tx) => {
      const basis = await rostersOfYear(tx, rullAdmin, targetYearId);
      const rosters = await loadRosters(tx, basis, groups.map((group) => group.id), groups);
      const payload = await (
        proxy as unknown as { fetchAndAnonymize: (...args: unknown[]) => Promise<{ headcountByGroup: Map<string, number> }> }
      ).fetchAndAnonymize(tx, targetYearId, rull.schoolId, basis);
      const conflicts = await (
        lessons as unknown as { findConflicts: (...args: unknown[]) => Promise<{ kind: string; message: string }[]> }
      ).findConflicts(
        tx,
        basis,
        { id: null, academicYearId: targetYearId, studentGroupId: g8a, subjectId: rull.subjectId },
        { dayOfWeek: 1, startMinutes: 8 * 60, endMinutes: 9 * 60, teacherId: null, roomId: null },
      );
      const planned = await readPlannedInput(tx, rullAdmin, targetYearId, true);
      return {
        basis,
        reads: {
          rosters: {
            membersByGroup: sortedEntries(rosters.membersByGroup),
            groupsByStudent: sortedEntries(rosters.groupsByStudent),
            homeMembers: [...rosters.homeMembers].sort((a, b) => (a.id < b.id ? -1 : 1)),
            homeClassOf: sortedEntries(rosters.homeClassOf),
          },
          headcountByGroup: sortedEntries(payload.headcountByGroup),
          conflicts: conflicts.map((conflict) => [conflict.kind, conflict.message]).sort(),
          span: await attendanceSpan(tx, { academicYearId: targetYearId, groupIds: [ma8], rosters: basis }),
          pupils: planned!.pupils.map((pupil) => ({ ...pupil, groupIds: [...pupil.groupIds].sort() })).sort((a, b) => (a.id < b.id ? -1 : 1)),
          count8a: await countHomePupils(tx, basis, { role: 'STUDENT', isActive: true }, g8a),
        },
      };
    });
    const proposal = await new RoomOptimizationService(
      api,
      proxy,
      {} as ScheduleVersionsService,
      { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService,
    ).propose({ academicYearId: targetYearId, walkers: 'BOTH' } as never, rullAdmin);
    return { basis: basis.kind, reads: { ...reads, roomBasis: proposal.basis } };
  };
  const rosterChecksum = async () =>
    (
      await owner.query<{ sum: string }>(
        `SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS sum FROM (
           SELECT to_jsonb(u)::text AS x FROM "Users" u WHERE u."schoolId" = $1
           UNION ALL SELECT to_jsonb(m)::text FROM "StudentGroupMembers" m WHERE m."schoolId" = $1
         ) rows`,
        [rull.schoolId],
      )
    ).rows[0].sum;

  await check('(w2) the new year reads the class lists its activation would leave, for the admin and a teacher, writing nothing, and a lesson placed by hand meets the coming pupils', async () => {
    assert.ok(targetYearId, '(w) did not roll the year');
    const [g8a, ma8] = [await targetGroup('8A'), await targetGroup('Ma8')];
    const homes = await api.withRls(rullAdmin, (tx) => rostersOfYear(tx, rullAdmin, targetYearId));
    assert.equal(homes.kind, 'PROJECTED');
    const pupilId = async (name: string) =>
      (await owner.query<{ id: string }>('SELECT id FROM "Users" WHERE email = $1', [`${MARKER}-${name}@example.invalid`])).rows[0].id;
    const [p1, p2, p3] = [await pupilId('rull-p1'), await pupilId('rull-p2'), await pupilId('rull-p3')];
    assert.deepEqual(
      sortedEntries(homes.kind === 'PROJECTED' ? new Map(homes.homeOf) : new Map()),
      [[p1, g8a], [p2, g8a], [p3, null]].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    );
    // A teacher computes the same projection from rows the staff policies
    // already let them read.
    const asTeacher = await api.withRls(rullTeacher, (tx) => rostersOfYear(tx, rullTeacher, targetYearId));
    assert.equal(asTeacher.kind, 'PROJECTED');
    assert.deepEqual(sortedEntries(new Map(asTeacher.kind === 'PROJECTED' ? asTeacher.homeOf : [])), sortedEntries(new Map(homes.homeOf)));

    // Ma8 on Monday morning, placed by hand; then 8A at the same hour is a
    // pupil clash, because p1 will be in both.
    const lessons = new MasterLessonsService(api, { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService, {} as NotificationsService);
    await lessons.create({ academicYearId: targetYearId, subjectId: rull.subjectId, studentGroupId: ma8, dayOfWeek: 1, startTime: '08:00', endTime: '09:00' }, rullAdmin);
    await assert.rejects(
      lessons.create({ academicYearId: targetYearId, subjectId: rull.subjectId, studentGroupId: g8a, dayOfWeek: 1, startTime: '08:00', endTime: '09:00' }, rullAdmin),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException, summarise(error));
        assert.match(error.message, /Students of this group already have/);
        return true;
      },
    );

    const before = await rosterChecksum();
    const read = await rosterReads();
    assert.equal(read.basis, 'PROJECTED');
    assert.equal(await rosterChecksum(), before, 'a projected read wrote Users or StudentGroupMembers');
    assert.equal(read.reads['count8a'], 2);
    assert.deepEqual(read.reads['span'], { min: 8, max: 8 });
    assert.equal((read.reads['conflicts'] as unknown[]).length, 1);
    projectedReads = read.reads;
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
    // Every reader reads, on the rows the activation wrote, what (w2) read on
    // the projection of them.
    assert.ok(projectedReads, '(w2) did not read the projection');
    const current = await rosterReads();
    assert.equal(current.basis, 'CURRENT');
    assert.deepEqual(current.reads, projectedReads);
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

  /*
   * TJÄNSTER OCH UPPDRAG FÖLJER MED (staffing Fas 5), through the real
   * adapter, in a school of their own: (å) the rollover with the option, (ä)
   * the carry into a year rolled without it. The school has three teachers
   * with posts in the source year (the third deactivated after their rows
   * were written), a fourth with none, and two classes: 7A, which continues,
   * and 9A, which graduates.
   */
  const tj = await givenStaffingSchool(owner);
  const tjAdmin: AuthenticatedUser = { authId: tj.adminAuthId, userId: tj.adminId, schoolId: tj.schoolId, role: Role.SCHOOL_ADMIN };
  const tjTeacher = (who: { id: string; authId: string }): AuthenticatedUser => ({
    authId: who.authId,
    userId: who.id,
    schoolId: tj.schoolId,
    role: Role.TEACHER,
  });
  const tjYears = new AcademicYearsService(api);
  const tjOptions = { name: `${MARKER} tj mål`, startDate: '2094-08-16', endDate: '2095-06-11', graduatingGradeLevel: 9 };
  const schoolConstraints = async () =>
    (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM "AvailabilityConstraints" WHERE "schoolId" = $1', [tj.schoolId])).rows[0].n;
  const staffingOf = async (yearId: string) => ({
    employments: (
      await owner.query<Record<string, unknown>>(
        `SELECT "userId", "employmentPercent"::text AS percent, "reductionPercent"::text AS reduction, "contractKind"::text AS kind,
                "teachingTargetMinutesPerWeek" AS target, signature, note
           FROM "TeacherEmployments" WHERE "academicYearId" = $1 ORDER BY "userId"`,
        [yearId],
      )
    ).rows,
    duties: (
      await owner.query<Record<string, unknown>>(
        `SELECT d."userId", d.kind::text AS kind, d.label, d."minutesPerWeek" AS minutes, d."countsAsTeaching" AS counts,
                d.note, g.name AS "group", c.id AS "slotId", c."resourceType"::text AS "slotKind", c.type::text AS "slotType",
                c."userId" AS "slotUser", c."dayOfWeek" AS day, c."startTime"::text AS start, c."endTime"::text AS "end",
                c.reason, c."roomId" AS room, c."studentGroupId" AS "slotGroup", c.date
           FROM "TeacherDuties" d
           LEFT JOIN "StudentGroups" g ON g.id = d."studentGroupId"
           LEFT JOIN "AvailabilityConstraints" c ON c.id = d."blockedConstraintId"
          WHERE d."academicYearId" = $1 ORDER BY d.kind, d.label`,
        [yearId],
      )
    ).rows,
  });
  /** The TEACHER rows the engine is handed for a year, at one weekday and start. */
  const enginesTeacherSlots = async (yearId: string, day: number, start: string) =>
    api.withRls(tjAdmin, async (tx) => {
      const proxy = new OptimizationProxyService(
        api,
        { post: () => { throw new Error('the engine was called'); } } as never,
        { getOrThrow: () => ({ baseUrl: 'http://engine.invalid', apiKey: 'k'.repeat(32), timeoutMs: 1 }) } as never,
      );
      const basis = await rostersOfYear(tx, tjAdmin, yearId);
      const payload = await (
        proxy as unknown as {
          fetchAndAnonymize: (...args: unknown[]) => Promise<{ constraints: { resourceKind: string; dayOfWeek: number | null; startTime: string }[] }>;
        }
      ).fetchAndAnonymize(tx, yearId, tj.schoolId, basis);
      return payload.constraints.filter((c) => c.resourceKind === 'TEACHER' && c.dayOfWeek === day && c.startTime.startsWith(start)).length;
    });
  const tjRefusedWith = (code: string) => (error: unknown) => {
    assert.ok(error instanceof ConflictException, summarise(error));
    assert.equal((error.getResponse() as { code?: string }).code, code, summarise(error));
    return true;
  };

  await check('(å) a läsårsrullning with tjänster carries posts, uppdrag and NEW slots through the real adapter, in one transaction, and leaves the source untouched', async () => {
    const rollover = new YearRolloverService(api);
    const before = await sourceChecksum(owner, tj.sourceYearId);
    const sourceSlots = (await staffingOf(tj.sourceYearId)).duties.map((duty) => duty.slotId).filter((id) => id !== null);
    assert.equal(sourceSlots.length, 2, 'the fixture lost a slot');
    const constraintsBefore = await schoolConstraints();
    const leftBehind = async () =>
      (
        await owner.query<{ n: number }>(
          `SELECT ((SELECT count(*) FROM "AcademicYears" WHERE "schoolId" = $1 AND name = $2)
                 + (SELECT count(*) FROM "TeacherEmployments" WHERE "schoolId" = $1 AND "academicYearId" <> $3)
                 + (SELECT count(*) FROM "TeacherDuties" WHERE "schoolId" = $1 AND "academicYearId" <> $3))::int AS n`,
          [tj.schoolId, tjOptions.name, tj.sourceYearId],
        )
      ).rows[0].n + ((await schoolConstraints()) - constraintsBefore);

    // Without the option the preview is today's: no staffing, the old skip.
    const without = await rollover.previewRollover(tj.sourceYearId, tjOptions, tjAdmin);
    assert.equal(without.staffing, null);
    assert.ok(without.problems.some((problem) => problem.code === 'DUTY_SLOTS_NOT_CARRIED'));

    const preview = await rollover.previewRollover(tj.sourceYearId, { ...tjOptions, carryStaffing: true }, tjAdmin);
    assert.equal(preview.blocking, false, JSON.stringify(preview.problems));
    assert.notEqual(preview.planHash, without.planHash, 'the option did not reach the hash');
    const staffing = preview.staffing!;
    assert.equal(staffing.employments.carried, 2);
    assert.deepEqual(staffing.employments.notCarried, [{ userId: tj.t3.id, reason: 'INACTIVE' }]);
    assert.deepEqual(staffing.employments.withReduction, [tj.t1.id]);
    assert.deepEqual(staffing.employments.withTargetOverride, [tj.t2.id]);
    assert.equal(staffing.duties.carried, 2);
    assert.equal(staffing.duties.slots, 2);
    assert.equal(staffing.duties.followedGroup, 1);
    assert.deepEqual(
      staffing.duties.relabelled.map((row) => [row.from, row.to]),
      [[`Mentor ${MARKER} 7A`, `Mentor ${MARKER} 8A`]],
    );
    assert.deepEqual(
      staffing.duties.notCarried.map((row) => [row.userId, row.kind, row.reason]).sort(),
      [
        [tj.t2.id, 'MENTORSKAP', 'GROUP_LEAVES'],
        [tj.t3.id, 'ANNAT', 'TEACHER_NOT_CARRIED'],
      ].sort(),
    );
    const codes = preview.problems.map((problem) => problem.code);
    for (const code of ['STAFFING_MENTORSKAP_NOT_CARRIED', 'STAFFING_TEACHERS_NOT_CARRIED', 'STAFFING_PER_YEAR_TERMS_CARRIED']) {
      assert.ok(codes.includes(code as never), `${code} missing from ${JSON.stringify(codes)}`);
    }
    assert.ok(!codes.includes('DUTY_SLOTS_NOT_CARRIED'), 'the old skip warning stayed with the option on');
    const execute = { ...tjOptions, carryStaffing: true, planHash: preview.planHash };

    // A hash from the preview without tjänster does not execute with them.
    await assert.rejects(
      rollover.executeRollover(tj.sourceYearId, { ...execute, planHash: without.planHash }, tjAdmin),
      tjRefusedWith('ROLLOVER_PREVIEW_STALE'),
    );
    assert.equal(await leftBehind(), 0, 'a stale rollover left rows behind');

    // Atomicity: the uppdrag step fails after the year, the groups, the posts
    // and the slots were inserted, and all of it is gone.
    await owner.query(`
      CREATE FUNCTION public.probe_tj_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'probe: the duties step refuses'; END $$`);
    await owner.query(
      `CREATE TRIGGER probe_tj_refuse BEFORE INSERT ON "TeacherDuties"
         FOR EACH ROW WHEN (NEW."schoolId" = '${tj.schoolId}'::uuid) EXECUTE FUNCTION public.probe_tj_refuse()`,
    );
    try {
      await assert.rejects(rollover.executeRollover(tj.sourceYearId, execute, tjAdmin), /refuses/);
    } finally {
      await dropStaffingTriggers(owner);
    }
    assert.equal(await leftBehind(), 0, 'a rollover that failed in its uppdrag step left rows behind');

    // The Fas 2 guard, met by the carry: a slot that is no longer the duty
    // teacher's own when the duty lands (re-pointed after its insert, so the
    // RETURNING the carry pairs on is the row it wrote) is TD409, a 409, and
    // the whole rollover goes.
    await owner.query(`
      CREATE FUNCTION public.probe_tj_repoint() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        UPDATE "AvailabilityConstraints" SET "userId" = '${tj.t2.id}'::uuid WHERE id = NEW.id;
        RETURN NULL;
      END $$`);
    await owner.query(
      `CREATE TRIGGER probe_tj_repoint AFTER INSERT ON "AvailabilityConstraints"
         FOR EACH ROW WHEN (NEW."schoolId" = '${tj.schoolId}'::uuid AND NEW."userId" = '${tj.t1.id}'::uuid AND NEW.reason = 'Uppdrag')
         EXECUTE FUNCTION public.probe_tj_repoint()`,
    );
    try {
      await assert.rejects(rollover.executeRollover(tj.sourceYearId, execute, tjAdmin), tjRefusedWith('TEACHER_DUTY_BLOCK_MISMATCH'));
    } finally {
      await dropStaffingTriggers(owner);
    }
    assert.equal(await leftBehind(), 0, 'a rollover refused by TD409 left rows behind');

    const result = await rollover.executeRollover(tj.sourceYearId, execute, tjAdmin);
    tj.targetYearId = result.academicYear.id;
    assert.deepEqual(result.staffing, { employments: 2, duties: 2, dutySlots: 2 });
    assert.equal(result.counts.groups, 1);

    const target = await staffingOf(tj.targetYearId);
    const source = await staffingOf(tj.sourceYearId);
    // Staffing Fas 3: every carried post and uppdrag is a CREATE version of
    // the new year, written in the rollover's transaction by the admin who ran it.
    const carriedVersions = (
      await owner.query<{ entity: string; action: string; actorId: string | null }>(
        `SELECT entity::text AS entity, action::text AS action, "actorId" FROM "TeacherEmploymentLogs"
          WHERE "academicYearId" = $1 ORDER BY "userId", version`,
        [tj.targetYearId],
      )
    ).rows;
    assert.equal(carriedVersions.filter((v) => v.entity === 'EMPLOYMENT' && v.action === 'CREATE').length, 2, 'a carried post is no version');
    assert.equal(carriedVersions.filter((v) => v.entity === 'DUTY' && v.action === 'CREATE').length, 2, 'a carried uppdrag is no version');
    assert.ok(carriedVersions.every((v) => v.actorId === tjAdmin.userId), 'a carried version names another actor than the admin');
    assert.deepEqual(target.employments, [
      { userId: tj.t1.id, percent: '100.000', reduction: '10.000', kind: 'FERIE', target: null, signature: 'TJ1', note: 'probe tj ett' },
      { userId: tj.t2.id, percent: '80.000', reduction: '0.000', kind: 'SEMESTER', target: 900, signature: 'TJ2', note: null },
    ].sort((a, b) => (a.userId < b.userId ? -1 : 1)));
    const slotShape = { slotKind: 'TEACHER', slotType: 'UNAVAILABLE', slotUser: tj.t1.id, reason: 'Uppdrag', room: null, slotGroup: null, date: null };
    assert.deepEqual(
      target.duties.map(({ slotId: _slotId, ...duty }) => duty),
      [
        { userId: tj.t1.id, kind: 'MENTORSKAP', label: `Mentor ${MARKER} 8A`, minutes: 60, counts: false, note: null, group: `${MARKER} 8A`, ...slotShape, day: 2, start: '15:00:00', end: '15:30:00' },
        { userId: tj.t1.id, kind: 'RASTVAKT', label: 'Rastvakt', minutes: 30, counts: true, note: 'probe tj vakt', group: null, ...slotShape, day: 4, start: '12:00:00', end: '12:30:00' },
      ],
    );
    for (const duty of target.duties) {
      assert.ok(!sourceSlots.includes(duty.slotId as string), 'a carried uppdrag holds the source year’s slot');
    }
    assert.equal(source.duties.filter((duty) => duty.slotId !== null).length, 2, 'the source year lost a slot');
    assert.equal(await sourceChecksum(owner, tj.sourceYearId), before, 'the rollover changed the source year');

    // The engine: each year blocks the teacher with its own slot only.
    assert.equal(await enginesTeacherSlots(tj.sourceYearId, 2, '15:00'), 1, 'the source year’s payload has not exactly its own APT slot');
    assert.equal(await enginesTeacherSlots(tj.targetYearId, 2, '15:00'), 1, 'the new year’s payload has not exactly its carried slot');
    assert.equal(await enginesTeacherSlots(tj.targetYearId, 4, '12:00'), 1);

    // The year deleted as the gateway deletes it: its posts and uppdrag go,
    // and the carried slots with them; the source keeps its own.
    await tjYears.remove(tj.targetYearId, tjAdmin);
    const carriedSlots = target.duties.map((duty) => duty.slotId);
    assert.equal(
      (await owner.query('SELECT 1 FROM "AvailabilityConstraints" WHERE id = ANY($1::uuid[])', [carriedSlots])).rowCount,
      0,
      'a deleted year’s carried uppdrag left their slots behind',
    );
    assert.equal(await schoolConstraints(), constraintsBefore);
    assert.equal(await sourceChecksum(owner, tj.sourceYearId), before, 'deleting the new year changed the source year');
    assert.equal(
      (await owner.query('SELECT 1 FROM "TeacherEmploymentLogs" WHERE "academicYearId" = $1', [tj.targetYearId])).rowCount,
      0,
      'a deleted year left its tjänsters history behind',
    );
    tj.targetYearId = '';
  });

  await check('(ä) a year rolled without tjänster gets them once, through the real adapter: a post written first makes it stale, a carry locked first is updated after, a signature taken meanwhile is a 409', async () => {
    const rollover = new YearRolloverService(api);
    const plain = await rollover.previewRollover(tj.sourceYearId, tjOptions, tjAdmin);
    const yearId = (await rollover.executeRollover(tj.sourceYearId, { ...tjOptions, planHash: plain.planHash }, tjAdmin)).academicYear.id;
    tj.targetYearId = yearId;
    const before = await sourceChecksum(owner, tj.sourceYearId);
    const constraintsBefore = await schoolConstraints();
    assert.deepEqual(await staffingOf(yearId), { employments: [], duties: [] }, 'a rollover without the option carried tjänster');

    const carry = new StaffingRolloverService(api);
    const other = open(withConnectionLimit(appUrl, 1));
    await other.onModuleInit();
    const rivalCarry = new StaffingRolloverService(other);
    const clearTarget = async () => {
      await owner.query('DELETE FROM "TeacherDuties" WHERE "academicYearId" = $1', [yearId]);
      await owner.query('DELETE FROM "TeacherEmployments" WHERE "academicYearId" = $1', [yearId]);
      assert.equal(await schoolConstraints(), constraintsBefore, 'clearing the target left carried slots');
    };
    /** Polls until some backend waits on `pid`; returns the waiting backend's pid. */
    const waiterOn = async (pid: number, what: string): Promise<number> => {
      for (let tries = 0; ; tries++) {
        const { rows } = await owner.query<{ pid: number }>(
          'SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) LIMIT 1',
          [pid],
        );
        if (rows[0]) return rows[0].pid;
        if (tries > 500) throw new Error(`${what} never waited`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    // The preview: the same carry the rollover would have made.
    const preview = await carry.preview(yearId, tjAdmin);
    assert.deepEqual(preview.source, { id: tj.sourceYearId, name: `${MARKER} tj källa` });
    assert.equal(preview.employments.carried, 2);
    assert.equal(preview.duties.carried, 2);
    assert.equal(preview.duties.slots, 2);
    assert.deepEqual(preview.duties.relabelled.map((row) => row.to), [`Mentor ${MARKER} 8A`]);

    // (a) A post written first, under the person's lock: the carry waits on
    // that lock, then plans again, finds the post, and is stale with nothing written.
    const touched = deferred<number>();
    const release = deferred<void>();
    const holder = api.withRls(tjAdmin, async (tx) => {
      await lockStaffRow(tx, tj.t1.id, 'tjänst');
      await tx.teacherEmployment.create({ data: { schoolId: tj.schoolId, userId: tj.t1.id, academicYearId: yearId, employmentPercent: 60 } });
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      touched.resolve(pid);
      await release.promise;
    });
    const holderSettled = holder.then(() => null, (error: unknown) => error);
    const holderPid = await Promise.race([
      touched.promise,
      holderSettled.then((error) => {
        throw error ?? new Error('the holder committed before it parked');
      }),
    ]);
    const staleSettled = rivalCarry.execute(yearId, preview.planHash, tjAdmin).then(() => null, (error: unknown) => error);
    await waiterOn(holderPid, 'the carry, on the post writer’s lock of the teacher,');
    release.resolve();
    const [holderError, staleError] = await Promise.all([holderSettled, staleSettled]);
    assert.equal(holderError, null, `the holder failed: ${summarise(holderError)}`);
    tjRefusedWith('STAFFING_ROLLOVER_PREVIEW_STALE')(staleError);
    const afterA = await staffingOf(yearId);
    assert.deepEqual(afterA.employments.map((row) => [row.userId, row.percent]), [[tj.t1.id, '60.000']]);
    assert.deepEqual(afterA.duties, [], 'a stale carry wrote uppdrag');
    assert.equal(await schoolConstraints(), constraintsBefore, 'a stale carry wrote slots');
    await clearTarget();

    // (b) The carry locks first, held at its uppdrag lock by a table lock
    // of the owner's; the real upsert of the same teacher waits on the carry's
    // lock of the person, and after the carry commits it updates the carried
    // post by its own key: no P2002, and the stored row is the upsert's.
    const fresh = await carry.preview(yearId, tjAdmin);
    const blocker = new Client({ connectionString: ownerUrl });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE "TeacherDuties" IN EXCLUSIVE MODE');
      const [{ pid: blockerPid }] = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      const carried = carry.execute(yearId, fresh.planHash, tjAdmin).then(
        (value) => ({ value, error: null as unknown }),
        (error: unknown) => ({ value: null, error }),
      );
      const carryPid = await waiterOn(blockerPid, 'the carry, on the owner’s lock of TeacherDuties,');
      const upserted = new TeacherEmploymentsService(other)
        .upsert(tj.t1.id, yearId, { employmentPercent: 60, note: 'probe tj upsert' }, tjAdmin)
        .then(() => null, (error: unknown) => error);
      await waiterOn(carryPid, 'the upsert, on the carry’s lock of the teacher,');
      await blocker.query('COMMIT');
      const carriedResult = await carried;
      assert.equal(carriedResult.error, null, `the carry failed: ${summarise(carriedResult.error)}`);
      assert.deepEqual(carriedResult.value?.counts, { employments: 2, duties: 2, dutySlots: 2 });
      assert.equal(await upserted, null, 'the upsert after the carry failed');
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
    }
    const afterB = await staffingOf(yearId);
    const t1Post = afterB.employments.find((row) => row.userId === tj.t1.id);
    assert.deepEqual(
      t1Post && { percent: t1Post.percent, reduction: t1Post.reduction, signature: t1Post.signature, note: t1Post.note },
      { percent: '60.000', reduction: '0.000', signature: null, note: 'probe tj upsert' },
    );
    assert.equal(afterB.employments.length, 2);
    assert.equal(afterB.duties.length, 2);

    // Twice is once: everybody is set up, the second run writes nothing.
    const again = await carry.preview(yearId, tjAdmin);
    assert.equal(again.employments.carried, 0);
    assert.equal(again.duties.carried, 0);
    assert.deepEqual(
      again.employments.notCarried.map((row) => [row.userId, row.reason]).sort(),
      [
        [tj.t1.id, 'ALREADY_PRESENT'],
        [tj.t2.id, 'ALREADY_PRESENT'],
        [tj.t3.id, 'INACTIVE'],
      ].sort(),
    );
    assert.deepEqual(
      (await carry.execute(yearId, again.planHash, tjAdmin)).counts,
      { employments: 0, duties: 0, dutySlots: 0 },
    );
    assert.equal((await staffingOf(yearId)).duties.length, 2, 'a second carry wrote uppdrag');

    // HR stays HR: each teacher reads their own carried rows and nothing of a
    // colleague's, and the load report cuts to their own row.
    for (const [who, duties] of [[tj.t1, 2], [tj.t2, 0]] as const) {
      const principal = tjTeacher(who);
      const seen = await api.withRls(principal, async (tx) => ({
        employments: await tx.teacherEmployment.findMany({ where: { academicYearId: yearId }, select: { userId: true } }),
        duties: await tx.teacherDuty.findMany({ where: { academicYearId: yearId }, select: { userId: true } }),
      }));
      assert.deepEqual(seen.employments.map((row) => row.userId), [who.id]);
      assert.deepEqual(seen.duties.map((row) => row.userId), Array(duties).fill(who.id));
      const load = await new StaffingLoadService(api).load(yearId, 'planned', principal);
      assert.deepEqual(load.teachers.map((row) => row.userId), [who.id]);
    }
    await clearTarget();

    // (c) A signature taken in the target by a teacher outside the carried
    // set, after the carry read and before it inserted: the insert meets the
    // uncommitted row on the per-year signature key, waits, and once that
    // commits gets a P2002, which is the stale 409 with nothing written.
    const third = await carry.preview(yearId, tjAdmin);
    const blocker2 = new Client({ connectionString: ownerUrl });
    await blocker2.connect();
    try {
      await blocker2.query('BEGIN');
      await blocker2.query(
        `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", signature, "updatedAt")
         VALUES ($1, $2, $3, 100, 'TJ1', now())`,
        [tj.schoolId, tj.t4.id, yearId],
      );
      const [{ pid: blockerPid }] = (await blocker2.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      const taken = carry.execute(yearId, third.planHash, tjAdmin).then(() => null, (error: unknown) => error);
      await waiterOn(blockerPid, 'the carry, on the signature the other insert holds,');
      await blocker2.query('COMMIT');
      tjRefusedWith('STAFFING_ROLLOVER_PREVIEW_STALE')(await taken);
    } finally {
      await blocker2.query('ROLLBACK').catch(() => undefined);
      await blocker2.end();
    }
    const afterC = await staffingOf(yearId);
    assert.deepEqual(afterC.employments.map((row) => [row.userId, row.signature]), [[tj.t4.id, 'TJ1']]);
    assert.deepEqual(afterC.duties, [], 'a carry refused on a signature wrote uppdrag');
    assert.equal(await schoolConstraints(), constraintsBefore, 'a carry refused on a signature wrote slots');

    // The re-preview shows the signature taken, and carries the post without it.
    const dropped = await carry.preview(yearId, tjAdmin);
    assert.deepEqual(dropped.employments.signaturesDropped, [{ userId: tj.t1.id, signature: 'TJ1' }]);
    assert.ok(dropped.problems.some((problem) => problem.code === 'STAFFING_SIGNATURE_TAKEN'));
    assert.deepEqual((await carry.execute(yearId, dropped.planHash, tjAdmin)).counts, { employments: 2, duties: 2, dutySlots: 2 });
    assert.equal(await sourceChecksum(owner, tj.sourceYearId), before, 'the carry changed the source year');
    // Staffing Fas 3: the staffing-rollover endpoint's writes are versions by the admin.
    const endpointVersions = (
      await owner.query<{ actorId: string | null }>(
        `SELECT "actorId" FROM "TeacherEmploymentLogs" WHERE "academicYearId" = $1 AND action = 'CREATE'`,
        [yearId],
      )
    ).rows;
    // The probe's own owner-written rows (the signature taken meanwhile) carry no actor.
    const byAdmin = endpointVersions.filter((v) => v.actorId === tjAdmin.userId).length;
    assert.ok(byAdmin >= 4, `the carry wrote ${byAdmin} version(s) by the admin, expected its posts and uppdrag`);
    assert.ok(endpointVersions.every((v) => v.actorId === tjAdmin.userId || v.actorId === null), 'a version names an actor nobody was');
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

  // ---- (u5) en elev minns sina klasser: every path that changes a pupil's
  // class writes its history in the same transaction, through the real
  // services and the real adapter, in a school of its own (the activation
  // moves pupils and hands the active flag over).
  {
    const eh = await givenEnrolmentSchool(owner);
    const ehAdmin: AuthenticatedUser = { authId: eh.adminAuthId, userId: eh.adminId, schoolId: eh.schoolId, role: Role.SCHOOL_ADMIN };
    const segmentsOf = async (email: string) =>
      (
        await owner.query<{ group: string | null; grade: number | null; from: string; to: string | null; source: string; year: string }>(
          `SELECT g.name AS "group", e."gradeLevel" AS grade, e."validFrom"::text AS "from", e."validTo"::text AS "to",
                  e.source::text AS source, y.name AS year
             FROM "StudentEnrollments" e JOIN "Users" u ON u.id = e."studentId"
             JOIN "AcademicYears" y ON y.id = e."academicYearId"
             LEFT JOIN "StudentGroups" g ON g.id = e."studentGroupId"
            WHERE u.email = $1 ORDER BY e."validFrom", e."createdAt"`,
          [`${MARKER}-eh-${email}@example.invalid`],
        )
      ).rows.map((row) => [row.year.replace(`${MARKER} eh `, ''), row.group?.replace(`${MARKER} eh `, '') ?? null, row.grade, row.from, row.to, row.source]);
    const today = eh.today;
    try {
      await check('(u5) en elevs klasshistorik: every writer of a pupil’s class records it in its own transaction — users, CSV, SS12000, the activation, a class deleted, a year deleted — and nobody else writes it', async () => {
        const users = new UsersService(api, { isConfigured: false } as unknown as SupabaseAdminService);
        const rollover = new YearRolloverService(api);
        const years = new AcademicYearsService(api);
        const groups = new StudentGroupsService(api);
        const sinceStart = eh.currentStart;

        // 9: the rollover writes no history.
        const before = (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM "StudentEnrollments" WHERE "schoolId" = $1`, [eh.schoolId])).rows[0].n;
        const rolled = await rollover.previewRollover(eh.prevYearId, eh.rolloverOptions, ehAdmin);
        assert.ok(!rolled.problems.some((problem) => problem.code === 'ROLLOVER_2028_RENUMBERING'));
        const target = await rollover.executeRollover(eh.prevYearId, { ...eh.rolloverOptions, planHash: rolled.planHash }, ehAdmin);
        const after = (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM "StudentEnrollments" WHERE "schoolId" = $1`, [eh.schoolId])).rows[0].n;
        assert.equal(after, before, 'the rollover wrote class history');
        const curYear = target.academicYear.id;
        await groups.create({ academicYearId: curYear, name: `${MARKER} eh 8B`, gradeLevel: 8 }, ehAdmin);
        const cls = async (name: string) =>
          (await owner.query<{ id: string }>(`SELECT id FROM "StudentGroups" WHERE "academicYearId" = $1 AND name = $2`, [curYear, `${MARKER} eh ${name}`])).rows[0].id;

        // 5: a FIRST activation, run after the new year began, records the
        // moved pupils from the year's first day; the graduate's open segment
        // closes; the pupil inactive at the activation is left where they are.
        const preview = await rollover.previewActivation(curYear, ehAdmin);
        await rollover.executeActivation(curYear, { planHash: preview.planHash }, ehAdmin);
        assert.deepEqual(await segmentsOf('p1'), [['i år', '8A', 8, sinceStart, null, 'RECORDED']]);
        assert.deepEqual(await segmentsOf('p2'), [['i år', '8A', 8, sinceStart, null, 'RECORDED']]);
        assert.deepEqual(await segmentsOf('p3'), [], 'the graduate kept a segment');
        assert.deepEqual(await segmentsOf('p4'), [], 'an inactive pupil got a segment');
        // The straggler: p4 comes back, still in last year's 7A, and the
        // ACTIVE year's activation moves them — recorded from today, no hint.
        await users.update(eh.p4, { isActive: true }, ehAdmin);
        assert.deepEqual(await segmentsOf('p4'), [['förra', '7A', 7, eh.prevEnd1, null, 'RECORDED']]);
        const straggler = await rollover.previewActivation(curYear, ehAdmin);
        await rollover.executeActivation(curYear, { planHash: straggler.planHash }, ehAdmin);
        assert.deepEqual(await segmentsOf('p4'), [['i år', '8A', 8, today, null, 'RECORDED']]);

        // 1 and 2: POST /users with a class, then PATCHes.
        const p5 = await users.create(
          { role: 'STUDENT', firstName: 'Probe', lastName: 'EH', email: `${MARKER}-eh-p5@example.invalid`, studentGroupId: await cls('8A') } as never,
          ehAdmin,
        );
        assert.deepEqual(await segmentsOf('p5'), [['i år', '8A', 8, today, null, 'RECORDED']]);
        await users.update(p5.id, { studentGroupId: await cls('8B') }, ehAdmin); // a same-day correction
        assert.deepEqual(await segmentsOf('p5'), [['i år', '8B', 8, today, null, 'RECORDED']]);
        // A move of a pupil who sat in 8A since the year began closes and opens at today.
        await users.update(eh.p1, { studentGroupId: await cls('8B') }, ehAdmin);
        assert.deepEqual(await segmentsOf('p1'), [
          ['i år', '8A', 8, sinceStart, today, 'RECORDED'],
          ['i år', '8B', 8, today, null, 'RECORDED'],
        ]);
        await users.update(eh.p1, { studentGroupId: await cls('8A') }, ehAdmin); // back, the same day
        assert.deepEqual(await segmentsOf('p1'), [['i år', '8A', 8, sinceStart, null, 'RECORDED']]);
        // Deactivation closes; reactivation re-opens (the same day: one segment again).
        await users.update(eh.p2, { isActive: false }, ehAdmin);
        assert.deepEqual(await segmentsOf('p2'), [['i år', '8A', 8, sinceStart, today, 'RECORDED']]);
        await users.update(eh.p2, { isActive: true }, ehAdmin);
        assert.deepEqual(await segmentsOf('p2'), [['i år', '8A', 8, sinceStart, null, 'RECORDED']]);
        // Another school's class is no class of this school: 400, nothing
        // written — the same answer as a class id that exists nowhere, for an
        // active pupil and for one being deactivated in the same write.
        const refusals: string[] = [];
        for (const data of [
          { studentGroupId: eh.foreignGroupId },
          { studentGroupId: randomUUID() },
          { studentGroupId: eh.foreignGroupId, isActive: false },
        ]) {
          await assert.rejects(users.update(eh.p2, data as never, ehAdmin), (error: unknown) => {
            assert.ok(error instanceof BadRequestException, summarise(error));
            refusals.push(error.message);
            return true;
          });
        }
        assert.deepEqual(refusals, Array(3).fill('studentGroupId: klassen finns inte i skolan.'));
        assert.deepEqual(await segmentsOf('p2'), [['i år', '8A', 8, sinceStart, null, 'RECORDED']]);

        // 8: a move whose transaction rolls back leaves no history.
        await assert.rejects(
          api.withRls(ehAdmin, async (tx) => {
            await tx.user.update({ where: { id: eh.p2 }, data: { studentGroupId: await cls('8B') } });
            throw new Error('probe: roll back');
          }),
          /roll back/,
        );
        assert.deepEqual(await segmentsOf('p2'), [['i år', '8A', 8, sinceStart, null, 'RECORDED']]);

        // 3: the CSV import (one row of a class the year has, one of none).
        const imports = new ImportService(api, users);
        const report = await imports.importStudents(
          {
            academicYearId: curYear,
            rows: [
              { firstName: 'Probe', lastName: 'EH', email: `${MARKER}-eh-csv@example.invalid`, className: `${MARKER} eh 8B` },
              { firstName: 'Probe', lastName: 'EH', email: `${MARKER}-eh-csv2@example.invalid`, className: 'Ingen sådan klass' },
            ],
          } as never,
          ehAdmin,
        );
        assert.equal(report.created, 1, JSON.stringify(report));
        assert.deepEqual(await segmentsOf('csv'), [['i år', '8B', 8, today, null, 'RECORDED']]);
        assert.deepEqual(await segmentsOf('csv2'), []);

        // 4: SS12000 under the service principal, into the active year's class by name.
        await owner.query(
          `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
           VALUES ($1, $2, 'Probe', 'EH', 'STUDENT', gen_random_uuid(), true, now())`,
          [eh.schoolId, `${MARKER}-eh-ss@example.invalid`],
        );
        const synced = await new Ss12000Service(api).importPersons(eh.schoolId, [
          { email: `${MARKER}-eh-ss@example.invalid`, groupDisplayName: `${MARKER} eh 8B` },
        ]);
        assert.equal(synced.updated, 1);
        assert.deepEqual(await segmentsOf('ss'), [['i år', '8B', 8, today, null, 'RECORDED']]);

        // The stage totals and the families' statement, on these rows: 8B's
        // matematik mapped to MA and planned 3 × 60.
        const stages = new TimplanStageService(api);
        const subject = (
          await owner.query<{ id: string }>(
            `INSERT INTO "Subjects" ("schoolId", name, code, "nationalCode", "updatedAt") VALUES ($1, $2, 'EHMA', 'MA', now()) RETURNING id`,
            [eh.schoolId, `${MARKER} eh matematik`],
          )
        ).rows[0].id;
        await owner.query(
          `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "lessonsPerWeek", "minutesPerLesson", "updatedAt")
           VALUES ($1, $2, $3, $4, 3, 60, now())`,
          [eh.schoolId, curYear, subject, await cls('8B')],
        );
        // 11: the statements sent do not grow with the pupils read — one class
        // or the whole school, the same reads per läsår.
        const class8bId = await cls('8B');
        const small = await statementsDuring(async () => {
          const answer = await stages.overview({ academicYearId: curYear, studentGroupId: class8bId }, ehAdmin);
          assert.ok(answer.pupils!.length >= 3, `8B holds ${answer.pupils!.length} pupils`);
        });
        const whole = await statementsDuring(() => stages.overview({ academicYearId: curYear }, ehAdmin));
        assert.equal(small.length, whole.length, `one class sent ${small.length} statements, the school ${whole.length}`);
        // 12: published under the admin, read under the pupil's own RLS and a guardian's.
        const published = await stages.publish({ academicYearId: curYear }, ehAdmin);
        assert.ok(published.rows > 0, JSON.stringify(published));
        const pupilUser = async (email: string) => {
          const row = (await owner.query<{ id: string; authId: string }>(`SELECT id, "authId" FROM "Users" WHERE email = $1`, [`${MARKER}-eh-${email}@example.invalid`])).rows[0];
          return { id: row.id, user: { authId: row.authId, userId: row.id, schoolId: eh.schoolId, role: Role.STUDENT } as AuthenticatedUser };
        };
        const csvPupil = await pupilUser('csv');
        const p5Pupil = await pupilUser('p5');
        const own = await stages.card({ studentId: p5Pupil.id }, csvPupil.user);
        assert.equal(own.statement?.studentId, csvPupil.id, 'a pupil read a classmate’s card');
        // Högstadiet, every cell bilaga 1 prints there (a cell nothing is planned
        // for is the clearest shortfall), and matematik with 8B's minutes.
        assert.deepEqual(own.statement!.stages.map((stage) => stage.stage), ['HOG']);
        const lines = own.statement!.stages[0]!.lines;
        assert.ok(lines.find((line) => line.subjectCode === 'MA')!.plannedHours > 0);
        assert.ok(lines.filter((line) => line.subjectCode !== 'MA').every((line) => line.plannedHours === 0));
        assert.equal(lines.find((line) => line.subjectCode === 'MA')!.nationalHours, 400);
        const guardian = (
          await owner.query<{ id: string; authId: string }>(
            `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
             VALUES ($1, $2, 'Probe', 'EH', 'GUARDIAN', gen_random_uuid(), true, now()) RETURNING id, "authId"`,
            [eh.schoolId, `${MARKER}-eh-guardian@example.invalid`],
          )
        ).rows[0];
        await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3)`, [eh.schoolId, guardian.id, p5Pupil.id]);
        const guardianUser = { authId: guardian.authId, userId: guardian.id, schoolId: eh.schoolId, role: Role.GUARDIAN } as AuthenticatedUser;
        assert.equal((await stages.card({ studentId: p5Pupil.id }, guardianUser)).statement?.studentId, p5Pupil.id);
        assert.deepEqual(await stages.card({ studentId: csvPupil.id }, guardianUser), { statement: null }, 'a guardian read a child not theirs');
        // A publication is a snapshot: the admin who published it can be removed, and it stays, unattributed.
        const admin2 = (
          await owner.query<{ id: string; authId: string }>(
            `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
             VALUES ($1, $2, 'Probe', 'EH', 'SCHOOL_ADMIN', gen_random_uuid(), true, now()) RETURNING id, "authId"`,
            [eh.schoolId, `${MARKER}-eh-admin2@example.invalid`],
          )
        ).rows[0];
        const admin2User = { authId: admin2.authId, userId: admin2.id, schoolId: eh.schoolId, role: Role.SCHOOL_ADMIN } as AuthenticatedUser;
        await stages.publish({ academicYearId: curYear }, admin2User);
        await users.remove(admin2.id, ehAdmin);
        assert.deepEqual(
          (await owner.query(`SELECT "publishedByUserId" FROM "TimplanStatementPublications" WHERE "schoolId" = $1`, [eh.schoolId])).rows,
          [{ publishedByUserId: null }],
        );
        // Two publishes at once: the second meets the unique key, 409, nothing half-written.
        await stages.withdraw(ehAdmin);
        const holder = new Client({ connectionString: ownerUrl });
        await holder.connect();
        try {
          await holder.query('BEGIN');
          await holder.query(`INSERT INTO "TimplanStatementPublications" ("schoolId", "academicYearId", "asOfDate", pupils) VALUES ($1, $2, current_date, 0)`, [eh.schoolId, curYear]);
          const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          const racing = stages.publish({ academicYearId: curYear }, ehAdmin).then(() => null, (error: unknown) => error);
          for (let tries = 0; ; tries++) {
            const { rows } = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holderPid]);
            if (rows[0].n > 0) break;
            if (tries > 1000) throw new Error('the racing publish never waited on the unique key');
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          await holder.query('COMMIT');
          const error = await racing;
          assert.ok(error instanceof ConflictException, summarise(error));
          assert.equal((error.getResponse() as { code?: string }).code, 'TIMPLAN_STAGE_PUBLISH_IN_PROGRESS');
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await holder.end();
        }
        assert.equal((await owner.query(`SELECT 1 FROM "TimplanStatements" WHERE "schoolId" = $1`, [eh.schoolId])).rowCount, 0);
        await owner.query(`DELETE FROM "TimplanStatementPublications" WHERE "schoolId" = $1`, [eh.schoolId]);

        // C3: a class with history keeps its year — the service names it,
        // and the key refuses the PostgREST-equivalent write.
        // 8B, not 8A: 8A continues last year's 7A, and a linked class's year
        // is the rollover link trigger's to refuse (LR409) before this key.
        await assert.rejects(groups.update(await cls('8B'), { academicYearId: eh.prevYearId }, ehAdmin), (error: unknown) => {
          assert.ok(error instanceof ConflictException, summarise(error));
          assert.equal((error.getResponse() as { code?: string }).code, 'STUDENT_GROUP_HAS_ENROLMENT_HISTORY');
          return true;
        });
        const class8b = await cls('8B');
        await assert.rejects(
          api.withRls(ehAdmin, (tx) => tx.studentGroup.update({ where: { id: class8b }, data: { academicYearId: eh.prevYearId } })),
          (error: unknown) => {
            assert.equal(sqlStateOf(error), '23503', summarise(error));
            return true;
          },
        );

        // 6: a class deleted. Its pupils' segments close at today with no
        // class and keep their grade; their class is cleared.
        await users.update(eh.p4, { studentGroupId: await cls('8B') }, ehAdmin); // p4's same-day 8A segment is replaced
        await groups.remove(await cls('8A'), ehAdmin);
        assert.deepEqual(await segmentsOf('p1'), [['i år', null, 8, sinceStart, today, 'RECORDED']]);
        assert.deepEqual(await segmentsOf('p2'), [['i år', null, 8, sinceStart, today, 'RECORDED']]);

        // Nobody but the database writes it: the owner meets the guard (SE403),
        // TRUNCATE included, and the API role the grant (42501).
        for (const sql of [
          `INSERT INTO "StudentEnrollments" ("schoolId", "studentId", "academicYearId", "validFrom") VALUES ('${eh.schoolId}', '${eh.p1}', '${curYear}', DATE '2001-01-01')`,
          `UPDATE "StudentEnrollments" SET "validFrom" = DATE '2001-01-01' WHERE "schoolId" = '${eh.schoolId}'`,
          `DELETE FROM "StudentEnrollments" WHERE "schoolId" = '${eh.schoolId}'`,
          `TRUNCATE "StudentEnrollments"`,
        ]) {
          await assert.rejects(owner.query(sql), (error: unknown) => {
            assert.equal((error as { code?: string }).code, 'SE403', `${sql}: ${summarise(error)}`);
            return true;
          });
        }
        await assert.rejects(
          api.withRls(ehAdmin, (tx) => tx.$executeRaw`DELETE FROM "StudentEnrollments"`),
          (error: unknown) => {
            assert.equal(sqlStateOf(error), '42501', summarise(error));
            return true;
          },
        );
        // The constraints behind the trigger, with the guard set aside in a
        // transaction that is rolled back: an overlapping segment is 23P01,
        // a second open one 23505.
        await owner.query('BEGIN');
        try {
          await owner.query('ALTER TABLE "StudentEnrollments" DISABLE TRIGGER "StudentEnrollments_written_by_trigger"');
          for (const [sql, state] of [
            [`INSERT INTO "StudentEnrollments" ("schoolId", "studentId", "academicYearId", "validFrom", "validTo") VALUES ('${eh.schoolId}', '${eh.p1}', '${curYear}', '${sinceStart}', '${today}')`, '23P01'],
            [`INSERT INTO "StudentEnrollments" ("schoolId", "studentId", "academicYearId", "validFrom") VALUES ('${eh.schoolId}', '${p5.id}', '${eh.prevYearId}', DATE '2001-01-01')`, '23505'],
          ] as const) {
            await owner.query('SAVEPOINT s');
            await assert.rejects(owner.query(sql), (error: unknown) => {
              assert.equal((error as { code?: string }).code, state, `${sql}: ${summarise(error)}`);
              return true;
            });
            await owner.query('ROLLBACK TO SAVEPOINT s');
          }
        } finally {
          await owner.query('ROLLBACK');
        }

        // 2028: the rollover preview says it, blocks nothing.
        const into2028 = await rollover.previewRollover(
          curYear,
          { name: `${MARKER} eh 2028`, startDate: '2028-08-14', endDate: '2029-06-08', graduatingGradeLevel: 9 },
          ehAdmin,
        );
        assert.deepEqual(
          into2028.problems.filter((problem) => problem.code === 'ROLLOVER_2028_RENUMBERING'),
          [{ code: 'ROLLOVER_2028_RENUMBERING', blocking: false, params: { startYear: 2028, source: 'SFS 2025:729, övergångsbestämmelse 4' } }],
        );

        // 7: a year deleted takes its history along, nothing raised — once its
        // pupils have left its classes (YEAR_HAS_HOME_PUPILS guards that).
        await owner.query(`UPDATE "Users" SET "studentGroupId" = NULL WHERE "schoolId" = $1 AND role = 'STUDENT'`, [eh.schoolId]);
        await owner.query(`UPDATE "AcademicYears" SET "isActive" = false WHERE id = $1`, [curYear]);
        await years.remove(curYear, ehAdmin);
        assert.equal(
          (await owner.query(`SELECT 1 FROM "StudentEnrollments" WHERE "academicYearId" = $1`, [curYear])).rowCount,
          0,
        );
      });

      await check('(u5) the backfill: every active pupil of the seeded school with a class has exactly one open segment, in that class', async () => {
        const { rows } = await owner.query<{ id: string; open: number; same: number }>(
          `SELECT u.id,
                  (SELECT count(*)::int FROM "StudentEnrollments" e WHERE e."studentId" = u.id AND e."validTo" IS NULL) AS open,
                  (SELECT count(*)::int FROM "StudentEnrollments" e WHERE e."studentId" = u.id AND e."validTo" IS NULL
                      AND e."studentGroupId" = u."studentGroupId") AS same
             FROM "Users" u
            WHERE u."schoolId" = $1 AND u.role = 'STUDENT' AND u."isActive" AND u."studentGroupId" IS NOT NULL`,
          [fixture.schoolId],
        );
        assert.ok(rows.length > 0);
        assert.deepEqual(rows.filter((row) => row.open !== 1 || row.same !== 1), []);
      });
    } finally {
      await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-elevhistorik'`, [MARKER]);
    }
  }

  await check('(z) the active year\'s hot paths send Postgres exactly f5ff8da\'s statements, the PATCH one fewer: the roster basis rides on reads they already make', async () => {
    // A school of its own, swept whole: an active year with 7A and 8A at the
    // same hour (no shared pupil or teacher), a published lesson, behörighet,
    // employments, a policy and lunch switched on.
    const budget = await givenBudgetSchool(owner);
    try {
      const admin = budget.admin;
      const notifications = {
        recipientsForGroups: async () => [],
        notifyUsers: async () => undefined,
      } as unknown as NotificationsService;
      const lessons = new MasterLessonsService(
        api,
        { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService,
        notifications,
      );
      const calendar = new CalendarLessonsService(
        api,
        { notifyLessonChanged: async () => undefined } as unknown as RealtimeService,
        notifications,
      );
      const sent: Record<string, string[]> = {};
      const count = async (name: string, body: () => Promise<unknown>) => {
        sent[name] = await statementsDuring(body);
      };
      await count('suggest a substitute', () => calendar.suggestSubstitutes(budget.calendarLesson, admin));
      await count('assign a substitute', () =>
        calendar.assignSubstitute(budget.calendarLesson, { teacherId: budget.teachers[3] }, admin),
      );
      await count('PATCH a new teacher', () => lessons.update(budget.lesson7a, { teacherId: budget.teachers[1] }, admin));
      await count('PATCH a drag', () => lessons.update(budget.lesson7a, { dayOfWeek: 1 }, admin));
      await count('PATCH a drag back beside 8A', () => lessons.update(budget.lesson7a, { dayOfWeek: 3 }, admin));
      await count('place a meal', () =>
        new LunchSittingsService(api).place(
          { academicYearId: budget.yearId, studentGroupId: budget.class7a, dayOfWeek: 3, startTime: '11:30' },
          admin,
        ),
      );
      await count('give a timplanspost a teacher', () =>
        new TeachingRequirementsService(api).update(budget.requirement8a, { teacherId: budget.teachers[1] }, admin),
      );
      // Counted at pg's Client.query, BEGIN, set_config and COMMIT included.
      // The same steps against the services of f5ff8da (a git archive of it,
      // run on the same database) sent 20, 21, 34, 21, 24, 7 and 22: the
      // refusal's scan of every läsår was the PATCH's one statement more. A
      // year's flags read as a SELECTED relation (a group's or a lesson's
      // `academicYear`) is a statement of its own under Prisma 7, and was +1
      // on the substitute paths and on every meal placed, until they asked
      // the year with a relation filter or counted it with `_count`.
      assert.deepEqual(
        Object.fromEntries(Object.entries(sent).map(([name, statements]) => [name, statements.length])),
        {
          // Vikarieplanering, both argued in its commit. The suggestion is
          // intersected with the hard cover rules (+10: the class's year,
          // the school's clock, the day's lessons of the candidates with
          // their rows, their closures, bookings, work rules, absences, pool
          // memberships and posts — one read each, for all candidates).
          'suggest a substitute': 30,
          // The assignment enters the publication lock and locks the lesson
          // row and the substitute (+3: two writers cannot both put one
          // person on two lessons at one hour, nor cover during a DRAFT
          // publish), reads the absences (+1: SUBSTITUTE_IS_ABSENT and the
          // decision), the substitute's day for the cover warnings (+8) and
          // the class's name for the substitute's own notice (+1).
          'assign a substitute': 34,
          // +1 each since Publicering: app.enter_grundschema_write, the shared
          // publication lock and the mode in one statement, first (below).
          'PATCH a new teacher': 34,
          'PATCH a drag': 21,
          'PATCH a drag back beside 8A': 24,
          'place a meal': 7,
          'give a timplanspost a teacher': 22,
        },
        JSON.stringify(sent, null, 1),
      );
      // The PATCH's first statement after BEGIN and the claims is the
      // publication lock with its argument, the school.
      for (const name of ['PATCH a new teacher', 'PATCH a drag', 'PATCH a drag back beside 8A']) {
        const first = sent[name].find((statement) => !/^(BEGIN|SELECT set_config)/.test(statement));
        assert.match(String(first), /app\.enter_grundschema_write\(\$1::uuid\)/, `${name} began with ${first}`);
      }
      // A drag reads no läsår row at all: no scan, no relation load.
      for (const name of ['PATCH a drag', 'PATCH a drag back beside 8A']) {
        const years = sent[name].filter((statement) => /^SELECT "public"\."AcademicYears"/.test(statement));
        assert.deepEqual(years, [], `${name} read AcademicYears`);
      }
    } finally {
      await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-budget'`, [MARKER]);
    }
  });

  // ---- Staffing Fas 3: avstämning, historik, faktor och /duties, in a school of their own.
  {
    const f3 = await givenFas3School(owner);
    const notifications = {
      recipientsForGroups: async () => [],
      notifyUsers: async () => undefined,
    } as unknown as NotificationsService;
    const realtime = { notifyMasterTimetableChanged: () => undefined, notifyLessonChanged: async () => undefined } as unknown as RealtimeService;
    try {
      await check('(ö1) avstämning: statement E credits the rows on held lessons through the real adapter — lead and co-teacher at their percentages, the vikarie at 100 %, a lead beside a vikarie nobody — and a teacher gets their own row alone', async () => {
        const loads = new StaffingLoadService(api);
        const range = { academicYearId: f3.yearId, from: f3.dayAt(-20), to: f3.dayAt(10) };
        const admin = await loads.delivered(range, f3.admin);
        const row = (userId: string) => admin.teachers.find((teacher) => teacher.userId === userId);
        assert.deepEqual(
          [row(f3.t1.id), row(f3.t2.id), row(f3.t3.id)].map((teacher) =>
            teacher && [teacher.delivered, teacher.substituteMinutes, teacher.coveredByOthersMinutes, teacher.lostMinutes, teacher.aheadMinutes, teacher.deliveredLessons, teacher.displacedLessons],
          ),
          [
            // t1: L1 and the mentorstid lesson held; L2 and L4 covered; L3 lost; L6 ahead; L4's LEAD displaced.
            // The legacy LEAD rows beside a vikarie on the cancelled L7 and the coming L8 charge t1 nothing.
            [120, 0, 120, 60, 60, 2, 1],
            // t2 at 50 %: L1; L2 and L4 covered; L3 lost; L6 ahead.
            [30, 0, 60, 30, 30, 1, 0],
            // t3 the vikarie: L2 and L4 at 100 %; L7 lost and L8 ahead, theirs alone.
            [120, 120, 0, 60, 60, 2, 0],
          ],
          'a LEAD beside a SUBSTITUTE was charged lost or coming minutes — one lesson counted twice',
        );
        assert.ok(admin.notices.some((notice) => notice.code === 'STAFFING_LEAD_BESIDE_SUBSTITUTE' && notice.params.lessons === 1));
        assert.deepEqual(
          admin.groupLosses.map((loss) => [loss.studentGroupId, loss.subjectId, loss.cancelledTeacherUnavailable, loss.lessons]),
          [[f3.class7a, f3.ma, 120, 2]],
        );
        // The teachers' bortfall is the group's, not twice it.
        assert.equal(admin.totals?.lostMinutes, 60 + 30 + 60);
        assert.equal(admin.totals?.delivered, 270);

        const own = await loads.delivered(range, f3.teacher(f3.t1));
        assert.deepEqual(own.teachers.map((teacher) => teacher.userId), [f3.t1.id]);
        assert.deepEqual(own.groupLosses, []);
        assert.equal(own.totals, null);
        const mine = own.teachers[0]!;
        const theirs = row(f3.t1.id)!;
        assert.deepEqual(
          [mine.planned, mine.scheduled, mine.delivered, mine.coveredByOthersMinutes, mine.lostMinutes, mine.displacedLessons],
          [theirs.planned, theirs.scheduled, theirs.delivered, theirs.coveredByOthersMinutes, theirs.lostMinutes, null],
        );
        // The rows Postgres hands back are the types the module reads.
        const rows = await api.withRls(f3.admin, (tx) =>
          tx.$queryRaw<{ minutes: unknown; lessons: unknown; extraGroupIds: unknown }[]>(
            staffingCreditStatement(
              { academicYearId: f3.yearId, yearStart: f3.dayAt(-60), yearEnd: f3.dayAt(200), asOf: new Date() },
              { from: range.from, to: range.to },
              null,
            ),
          ),
        );
        assert.ok(rows.length > 0 && rows.every((r) => typeof r.minutes === 'number' && typeof r.lessons === 'number'));
        assert.ok(rows.every((r) => r.extraGroupIds === null || Array.isArray(r.extraGroupIds)));
      });

      await check('(ö2) a master lesson’s new teacher is not written beside a vikarie, and naming the vikarie as the lead is no longer a P2002 (C5b)', async () => {
        const lessons = new MasterLessonsService(api, realtime, notifications);
        const calendar = new CalendarLessonsService(api, realtime, notifications);
        await calendar.assignSubstitute(f3.future.withSub, { teacherId: f3.t3.id }, f3.admin);
        const rowsOf = async (lesson: string) =>
          (
            await owner.query<{ teacherId: string; role: string }>(
              `SELECT "teacherId", role::text AS role FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = $1 ORDER BY role, "teacherId"`,
              [lesson],
            )
          ).rows.map((r) => [r.teacherId, r.role]);
        assert.deepEqual(await rowsOf(f3.future.withSub), [[f3.t3.id, 'SUBSTITUTE']]);

        await lessons.update(f3.future.master, { teacherId: f3.t2.id }, f3.admin);
        assert.deepEqual(await rowsOf(f3.future.withSub), [[f3.t3.id, 'SUBSTITUTE']], 'the new lead was written beside the vikarie');
        assert.deepEqual(await rowsOf(f3.future.plain), [[f3.t2.id, 'LEAD']], 'a lesson without a vikarie did not get the new lead');

        // The vikarie as the new lead: one row each, no unique violation.
        await lessons.update(f3.future.master, { teacherId: f3.t3.id }, f3.admin);
        assert.deepEqual(await rowsOf(f3.future.withSub), [[f3.t3.id, 'SUBSTITUTE']]);
        assert.deepEqual(await rowsOf(f3.future.plain), [[f3.t3.id, 'LEAD']]);
      });

      await check('(ö3) a tjänst’s history through the real adapter: every service write a version by the admin, a no-op none, a teacher reads their own, the owner rewrites nothing, and a person deleted takes theirs', async () => {
        const employments = new TeacherEmploymentsService(api);
        const duties = new TeacherDutiesService(api);
        const versionsOf = async (userId: string) =>
          (
            await owner.query<{ version: number; entity: string; action: string; actorId: string | null }>(
              `SELECT version, entity::text AS entity, action::text AS action, "actorId" FROM "TeacherEmploymentLogs"
                WHERE "userId" = $1 AND "academicYearId" = $2 ORDER BY version`,
              [userId, f3.yearId],
            )
          ).rows;
        const startAt = (await versionsOf(f3.t2.id)).length;
        await employments.upsert(f3.t2.id, f3.yearId, { employmentPercent: 75 }, f3.admin);
        await employments.upsert(f3.t2.id, f3.yearId, { employmentPercent: 75 }, f3.admin);
        await employments.upsert(f3.t2.id, f3.yearId, { employmentPercent: 75, reductionPercent: 5 }, f3.admin);
        const duty = await duties.create(
          { userId: f3.t2.id, academicYearId: f3.yearId, kind: 'RASTVAKT', label: `${MARKER} f3 vakt`, minutesPerWeek: 30 },
          f3.admin,
        );
        await duties.update(duty.id, { minutesPerWeek: 45 }, f3.admin);
        await duties.remove(duty.id, f3.admin);
        const written = (await versionsOf(f3.t2.id)).slice(startAt);
        assert.deepEqual(
          written.map((v) => [v.entity, v.action, v.actorId]),
          [
            ['EMPLOYMENT', 'UPDATE', f3.admin.userId],
            ['EMPLOYMENT', 'UPDATE', f3.admin.userId],
            ['DUTY', 'CREATE', f3.admin.userId],
            ['DUTY', 'UPDATE', f3.admin.userId],
            ['DUTY', 'DELETE', f3.admin.userId],
          ],
          'the writes are not exactly five versions (the identical PUT must write none)',
        );
        const all = await versionsOf(f3.t2.id);
        assert.deepEqual(all.map((v) => v.version), all.map((_, i) => i + 1), 'versions have a gap');

        const history = await employments.history(f3.t2.id, f3.yearId, f3.admin);
        assert.equal(history.entries[0]!.version, all.length);
        assert.deepEqual(history.entries.find((e) => e.entity === 'EMPLOYMENT' && e.action === 'UPDATE' && e.changes.some((c) => c.field === 'reductionPercent'))!.changes, [
          { field: 'reductionPercent', before: 0, after: 5 },
        ]);
        // The teacher: their own through the service and through RLS; a colleague's 403.
        assert.equal((await employments.history(f3.t2.id, f3.yearId, f3.teacher(f3.t2))).entries.length, history.entries.length);
        await assert.rejects(employments.history(f3.t2.id, f3.yearId, f3.teacher(f3.t1)), ForbiddenException);
        const seen = await api.withRls(f3.teacher(f3.t1), (tx) => tx.teacherEmploymentLog.findMany({ select: { userId: true } }));
        assert.ok(seen.length > 0 && seen.every((r) => r.userId === f3.t1.id), 'a teacher read a colleague’s history through RLS');

        // The owner rewrites nothing: the guards hold for the role RLS does not bind.
        for (const statement of [
          `UPDATE "TeacherEmploymentLogs" SET "actorId" = NULL WHERE "userId" = $1`,
          `DELETE FROM "TeacherEmploymentLogs" WHERE "userId" = $1`,
          `INSERT INTO "TeacherEmploymentLogs" ("schoolId", "userId", "academicYearId", version, entity, "entityId", action, after)
           SELECT "schoolId", "userId", "academicYearId", 999, entity, "entityId", 'CREATE', '{}'::jsonb FROM "TeacherEmploymentLogs" WHERE "userId" = $1 LIMIT 1`,
        ]) {
          await assert.rejects(owner.query(statement, [f3.t2.id]), (error: { code?: string }) => error.code === 'TL403');
        }
        // Nor empties it: TRUNCATE fires no row guard, the statement guard refuses it.
        await assert.rejects(owner.query(`TRUNCATE "TeacherEmploymentLogs"`), (error: { code?: string }) => error.code === 'TL403');

        // A note written is a version; its text is never in the history.
        await employments.upsert(f3.t2.id, f3.yearId, { employmentPercent: 75, reductionPercent: 5, note: `${MARKER} hemlig` }, f3.admin);
        const kept = await owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "TeacherEmploymentLogs"
            WHERE "userId" = $1 AND (COALESCE(before::text, '') || COALESCE(after::text, '')) LIKE '%hemlig%'`,
          [f3.t2.id],
        );
        assert.equal(kept.rows[0]!.n, 0, 'a note’s text was kept in the history');
        const noted = await employments.history(f3.t2.id, f3.yearId, f3.admin);
        assert.deepEqual(noted.entries[0]!.changes, [{ field: 'noteChanged', before: null, after: true }]);

        // A person deleted, with a post, a slot-holding uppdrag and a mentorship: works, and takes their history.
        await owner.query(`DELETE FROM "Users" WHERE id = $1`, [f3.t4.id]);
        assert.equal((await versionsOf(f3.t4.id)).length, 0, 'a deleted person left history behind');
      });

      await check('(ö4) /ss12000/v1/duties under the service principal: the active year’s posts of active users as Duty objects, the mentorship, no nedsättning ever, the percentage only with the opt-in', async () => {
        const ss12000 = new Ss12000Service(api);
        const off = await ss12000.duties(f3.schoolId);
        const keys = (duty: object) => Object.keys(duty).sort();
        assert.ok(off.data.length >= 2);
        assert.ok(off.data.every((duty) => !('dutyPercent' in duty) && !('hoursPerYear' in duty) && duty.dutyRole === 'Lärare'));
        assert.ok(!JSON.stringify(off).includes('reduction'));
        const t1 = off.data.find((duty) => duty.person.id === f3.t1.id)!;
        assert.deepEqual(t1.assignmentRole, [
          { group: { id: f3.class7a }, assignmentRoleType: 'Mentor', startDate: f3.dayAt(-60), endDate: f3.dayAt(200) },
        ]);
        assert.ok(keys(t1).every((key) => ['id', 'meta', 'person', 'assignmentRole', 'dutyAt', 'dutyRole', 'signature', 'startDate', 'endDate'].includes(key)));
        assert.ok(!off.data.some((duty) => duty.person.id === f3.inactive.id), 'an inactive user’s post was exported');

        await owner.query(`UPDATE "StaffingPolicies" SET "shareEmploymentWithIntegrations" = true WHERE "schoolId" = $1`, [f3.schoolId]);
        const on = await ss12000.duties(f3.schoolId);
        const t1On = on.data.find((duty) => duty.person.id === f3.t1.id)!;
        // t1's post is 100 % with 20 % nedsättning: the post, never the difference.
        assert.equal(t1On.dutyPercent, 100);
        assert.equal(t1On.hoursPerYear, 1767);
        await owner.query(`UPDATE "StaffingPolicies" SET "shareEmploymentWithIntegrations" = false WHERE "schoolId" = $1`, [f3.schoolId]);
      });

      await check('(ö5) a subject’s Faktor round-trips as a number, and under FACTOR the load and the scheduled horizon charge minutes × factor through the real adapter', async () => {
        const subjects = new SubjectsService(api);
        const loads = new StaffingLoadService(api);
        const before = await loads.load(f3.yearId, 'planned', f3.admin);
        const updated = await subjects.update(f3.ma, { loadFactor: 0.7 }, f3.admin);
        assert.equal(updated.loadFactor, 0.7);
        const minutes = await loads.load(f3.yearId, 'planned', f3.admin);
        assert.deepEqual(JSON.stringify(minutes), JSON.stringify(before), 'a factor moved a MINUTES school’s figures');
        await owner.query(`UPDATE "StaffingPolicies" SET "loadModel" = 'FACTOR' WHERE "schoolId" = $1`, [f3.schoolId]);
        try {
          const factor = await loads.load(f3.yearId, 'planned', f3.admin);
          const t1 = (report: typeof factor) => report.teachers.find((teacher) => teacher.userId === f3.t1.id)!;
          assert.equal(factor.loadModel, 'FACTOR');
          assert.equal(t1(factor).assignedMinutesPerWeek, Math.round(t1(before).assignedMinutesPerWeek * 0.7));
          assert.equal(factor.totals.lessonMinutesPerWeek, before.totals.lessonMinutesPerWeek);
          const scheduled = await loads.load(f3.yearId, 'scheduled', f3.admin);
          assert.equal(scheduled.horizon, 'scheduled');
          assert.equal(scheduled.listsComputed, false);
          const own = await loads.load(f3.yearId, 'scheduled', f3.teacher(f3.t1));
          assert.deepEqual(own.teachers.map((teacher) => teacher.userId), [f3.t1.id]);
        } finally {
          await owner.query(`UPDATE "StaffingPolicies" SET "loadModel" = 'MINUTES' WHERE "schoolId" = $1`, [f3.schoolId]);
          await subjects.update(f3.ma, { loadFactor: 1 }, f3.admin);
        }
      });
    } finally {
      // (ö6) as the owner: a school with posts, uppdrag and their history deletes whole.
      await owner.query(`DELETE FROM "Schools" WHERE id = $1`, [f3.schoolId]);
    }
    await check('(ö6) a school with posts, uppdrag and history deletes whole, and leaves no history', async () => {
      assert.equal((await owner.query('SELECT 1 FROM "TeacherEmploymentLogs" WHERE "schoolId" = $1', [f3.schoolId])).rowCount, 0);
    });
  }

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

  await publicationChecks(owner, api);
  await draftChecks(owner, api);
  await equivalenceCheck(owner, api);
  await weekEdgeChecks(owner, api);
  await mealChecks(owner, api);
  await pastRowChecks(owner, api);
  await batchChecks(owner, api);
  await batchMoveChecks(owner, api);
  await viewerChecks(owner, api);
}


/** The throwaway school (w) and (x) roll and activate, created as the owner, filled as its admin. */
interface StaffingSchool {
  schoolId: string;
  adminId: string;
  adminAuthId: string;
  /** Posts in the source year: t1 with a nedsättning, t2 with a target override, t3 deactivated after. t4 has none. */
  t1: { id: string; authId: string };
  t2: { id: string; authId: string };
  t3: { id: string; authId: string };
  t4: { id: string; authId: string };
  sourceYearId: string;
  /** Set by (å) and (ä) while a successor exists, for the sweep's sake. */
  targetYearId: string;
}

/**
 * (å) and (ä)'s school: an active source year with 7A (continues) and 9A
 * (graduates), a pupil in each, and its staffing written through the real
 * services — so the slots are the builder's: t1 a mentorskap of 7A with an
 * APT-like Tuesday slot and a rastvakt with a Thursday slot, t2 a mentorskap
 * of 9A, t3 an ANNAT and then deactivated.
 */
async function givenStaffingSchool(owner: Client): Promise<StaffingSchool> {
  const one = async <T extends object>(sql: string, params: unknown[]): Promise<T> =>
    (await owner.query<T>(sql, params)).rows[0];
  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${MARKER} rulltj`, `${MARKER}-rulltj`],
  );
  const person = (role: string, email: string, groupId: string | null = null) =>
    one<{ id: string; authId: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, 'Probe', 'Tjänst', $3::"UserRole", gen_random_uuid(), true, $4, now()) RETURNING id, "authId"`,
      [school.id, `${MARKER}-${email}@example.invalid`, role, groupId],
    );
  const admin = await person('SCHOOL_ADMIN', 'tj-admin');
  const t1 = await person('TEACHER', 'tj-t1');
  const t2 = await person('TEACHER', 'tj-t2');
  const t3 = await person('TEACHER', 'tj-t3');
  const t4 = await person('TEACHER', 'tj-t4');
  const principal: AuthenticatedUser = { authId: admin.authId, userId: admin.id, schoolId: school.id, role: Role.SCHOOL_ADMIN };
  const api = prismaServiceFor(requiredEnv('DATABASE_URL'));
  try {
    const year = await new AcademicYearsService(api).create(
      { name: `${MARKER} tj källa`, startDate: '2093-08-17', endDate: '2094-06-12', isActive: true },
      principal,
    );
    const groups = await api.withRls(principal, async (tx) => ({
      g7a: await tx.studentGroup.create({ data: { schoolId: school.id, academicYearId: year.id, name: `${MARKER} 7A`, gradeLevel: 7 } }),
      g9a: await tx.studentGroup.create({ data: { schoolId: school.id, academicYearId: year.id, name: `${MARKER} 9A`, gradeLevel: 9 } }),
    }));
    await person('STUDENT', 'tj-p1', groups.g7a.id);
    await person('STUDENT', 'tj-p2', groups.g9a.id);

    const employments = new TeacherEmploymentsService(api);
    await employments.upsert(t1.id, year.id, { employmentPercent: 100, reductionPercent: 10, signature: 'TJ1', note: 'probe tj ett' }, principal);
    await employments.upsert(
      t2.id,
      year.id,
      { employmentPercent: 80, contractKind: 'SEMESTER', teachingTargetMinutesPerWeek: 900, signature: 'TJ2' },
      principal,
    );
    await employments.upsert(t3.id, year.id, { employmentPercent: 50, signature: 'TJ3' }, principal);
    const duties = new TeacherDutiesService(api);
    await duties.create(
      {
        userId: t1.id,
        academicYearId: year.id,
        kind: 'MENTORSKAP',
        label: `Mentor ${MARKER} 7A`,
        minutesPerWeek: 60,
        studentGroupId: groups.g7a.id,
        blockedSlot: { dayOfWeek: 2, startTime: '15:00', endTime: '15:30' },
      },
      principal,
    );
    await duties.create(
      {
        userId: t1.id,
        academicYearId: year.id,
        kind: 'RASTVAKT',
        label: 'Rastvakt',
        minutesPerWeek: 30,
        countsAsTeaching: true,
        note: 'probe tj vakt',
        blockedSlot: { dayOfWeek: 4, startTime: '12:00', endTime: '12:30' },
      },
      principal,
    );
    await duties.create(
      { userId: t2.id, academicYearId: year.id, kind: 'MENTORSKAP', label: `Mentor ${MARKER} 9A`, minutesPerWeek: 60, studentGroupId: groups.g9a.id },
      principal,
    );
    await duties.create({ userId: t3.id, academicYearId: year.id, kind: 'ANNAT', label: 'Bibliotek', minutesPerWeek: 30 }, principal);
    await owner.query('UPDATE "Users" SET "isActive" = false WHERE id = $1', [t3.id]);
    return { schoolId: school.id, adminId: admin.id, adminAuthId: admin.authId, t1, t2, t3, t4, sourceYearId: year.id, targetYearId: '' };
  } finally {
    await api.$disconnect();
  }
}

async function dropStaffingTriggers(owner: Client): Promise<void> {
  await owner.query('DROP TRIGGER IF EXISTS probe_tj_refuse ON "TeacherDuties"');
  await owner.query('DROP FUNCTION IF EXISTS public.probe_tj_refuse()');
  await owner.query('DROP TRIGGER IF EXISTS probe_tj_repoint ON "AvailabilityConstraints"');
  await owner.query('DROP FUNCTION IF EXISTS public.probe_tj_repoint()');
}

interface EnrolmentSchool {
  schoolId: string;
  adminId: string;
  adminAuthId: string;
  prevYearId: string;
  p4: string;
  p1: string;
  p2: string;
  foreignGroupId: string;
  /** The school's local today, the start of the rolled year (50 days ago), and the old year's end + 1. */
  today: string;
  currentStart: string;
  prevEnd1: string;
  rolloverOptions: { name: string; startDate: string; endDate: string; graduatingGradeLevel: number };
}

/**
 * (u5)'s school: an ACTIVE year that ended 60 days ago, with 7A (p1, p2, and
 * p4, who is inactive) and 9A (p3, who graduates). Its rollover is a year
 * that began 50 days ago, so the activation is a late first one — the case
 * the class history's hint exists for. Dates relative to the real day: the
 * trigger's "today" is the database's, not an injected one.
 */
async function givenEnrolmentSchool(owner: Client): Promise<EnrolmentSchool> {
  const one = async <T extends object>(sql: string, params: unknown[]): Promise<T> =>
    (await owner.query<T>(sql, params)).rows[0];
  const day = await one<{ today: string; start: string; prevStart: string; prevEnd: string; prevEnd1: string; end: string }>(
    `SELECT t::text AS today, (t - 50)::text AS start, (t - 400)::text AS "prevStart", (t - 60)::text AS "prevEnd",
            (t - 59)::text AS "prevEnd1", (t + 250)::text AS "end"
       FROM (SELECT (now() AT TIME ZONE 'Europe/Stockholm')::date AS t) d`,
    [],
  );
  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${MARKER} elevhistorik`, `${MARKER}-elevhistorik`],
  );
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, $2, $3::date, $4::date, true, now()) RETURNING id`,
    [school.id, `${MARKER} eh förra`, day.prevStart, day.prevEnd],
  );
  const group = (name: string, grade: number) =>
    one<{ id: string }>(
      `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
       VALUES ($1, $2, $3, 'CLASS', $4, now()) RETURNING id`,
      [school.id, year.id, `${MARKER} eh ${name}`, grade],
    );
  const g7a = await group('7A', 7);
  const g9a = await group('9A', 9);
  const person = (role: string, email: string, groupId: string | null = null) =>
    one<{ id: string; authId: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, 'Probe', 'EH', $3::"UserRole", gen_random_uuid(), true, $4, now()) RETURNING id, "authId"`,
      [school.id, `${MARKER}-eh-${email}@example.invalid`, role, groupId],
    );
  const admin = await person('SCHOOL_ADMIN', 'admin');
  const p1 = await person('STUDENT', 'p1', g7a.id);
  const p2 = await person('STUDENT', 'p2', g7a.id);
  await person('STUDENT', 'p3', g9a.id);
  const p4 = await person('STUDENT', 'p4', g7a.id);
  await owner.query('UPDATE "Users" SET "isActive" = false WHERE id = $1', [p4.id]);
  const foreign = await one<{ id: string }>(
    `SELECT g.id FROM "StudentGroups" g JOIN "Schools" s ON s.id = g."schoolId"
      WHERE s.slug = 'rls-fixture-school' AND g.name = 'RLS Fixture Class'`,
    [],
  );
  return {
    schoolId: school.id,
    adminId: admin.id,
    adminAuthId: admin.authId,
    prevYearId: year.id,
    p1: p1.id,
    p2: p2.id,
    p4: p4.id,
    foreignGroupId: foreign.id,
    today: day.today,
    currentStart: day.start,
    prevEnd1: day.prevEnd1,
    rolloverOptions: { name: `${MARKER} eh i år`, startDate: day.start, endDate: day.end, graduatingGradeLevel: 9 },
  };
}

interface RolloverSchool {
  schoolId: string;
  adminId: string;
  adminAuthId: string;
  teacherId: string;
  teacherAuthId: string;
  sourceYearId: string;
  group7a: string;
  groupMa7: string;
  subjectId: string;
  breakId: string;
  /** Åk 7 of the source year follows this DRAFT, åk 9 the decided plan. */
  draftPlanId: string;
  decidedPlanId: string;
}

async function givenRolloverSchool(owner: Client, grundskolaVersionId: string): Promise<RolloverSchool> {
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
    // Timplan per årskurs, written after the year exists (so the create's
    // defaults, with no decided plan yet, attached nothing): åk 7 on a draft,
    // åk 9 on a decided plan, åk 8 on none.
    const timplans = new LocalTimplansService(api);
    const draft = await timplans.create(
      { name: `${MARKER} rull utkast`, schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: grundskolaVersionId },
      principal,
    );
    const decided = await timplans.create(
      { name: `${MARKER} rull beslutad`, schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: grundskolaVersionId },
      principal,
    );
    await timplans.replaceEntries(
      decided.id,
      { entries: [{ subjectId: made.subject.id, gradeLevel: 9, minutesPerWeek: 120 }] },
      principal,
    );
    await timplans.decide(decided.id, { decisionNote: MARKER }, principal);
    await new AcademicYearTimplansService(api).replace(
      year.id,
      {
        timplans: [
          { gradeLevel: 7, localTimplanId: draft.id },
          { gradeLevel: 9, localTimplanId: decided.id },
        ],
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
      teacherAuthId: teacher.authId,
      sourceYearId: year.id,
      group7a: made.g7a.id,
      groupMa7: made.ma7.id,
      subjectId: made.subject.id,
      breakId: made.lov.id,
      draftPlanId: draft.id,
      decidedPlanId: decided.id,
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
       UNION ALL SELECT to_jsonb(t)::text FROM "AcademicYearTimplans" t WHERE t."academicYearId" = $1
       UNION ALL SELECT to_jsonb(e)::text FROM "TeacherEmployments" e WHERE e."academicYearId" = $1
       UNION ALL SELECT to_jsonb(d)::text FROM "TeacherDuties" d WHERE d."academicYearId" = $1
       UNION ALL SELECT to_jsonb(c)::text FROM "AvailabilityConstraints" c
         WHERE c.id IN (SELECT "blockedConstraintId" FROM "TeacherDuties" WHERE "academicYearId" = $1)
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
  // (u3)'s and (u4)'s years: their groups, credits and calendar rows go with them.
  await owner.query(`DELETE FROM "AcademicYears" WHERE "schoolId" = $1 AND name IN ($2 || ' kredit', $2 || ' genomfört')`, [
    schoolId,
    MARKER,
  ]);
  // (v)'s chain and its throwaway school, for a run that stopped half-way;
  // the groups cascade, and the link triggers let the foreign keys clear.
  await owner.query(`DELETE FROM "AcademicYears" WHERE "schoolId" = $1 AND name LIKE $2 || ' rull %'`, [schoolId, MARKER]);
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-rullning'`, [MARKER]);
  // (w)/(x)'s school, whole, and (w)'s temporary trigger if a run died inside it.
  await dropRolloverTrigger(owner);
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-rullgw'`, [MARKER]);
  // (å)/(ä)'s school, whole, and their temporary triggers if a run died inside one.
  await dropStaffingTriggers(owner);
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-rulltj'`, [MARKER]);
  // (z)'s school, whole, for a run that stopped inside it.
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-budget'`, [MARKER]);
  // (ö)'s school, whole, for a run that stopped inside it.
  // (u5)'s school, whole, for a run that stopped inside it.
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-elevhistorik'`, [MARKER]);
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-fas3'`, [MARKER]);
  // The publicering checks' schools, whole, for a run that stopped inside them.
  await owner.query(
    `DELETE FROM "Schools" WHERE slug IN ($1 || '-publicering', $1 || '-utkast', $1 || '-tvilling-a', $1 || '-tvilling-b', $1 || '-avbokning', $1 || '-visare')`,
    [MARKER],
  );
  // (u4)'s pupil, for a run that stopped before deleting it.
  await owner.query(`DELETE FROM "Users" WHERE "schoolId" = $1 AND email = $2 || '-gf@example.invalid'`, [schoolId, MARKER]);
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

/** (z)'s school: one active year, the rows its hot paths read, and their ids. */
interface Fas3Person {
  id: string;
  authId: string;
}

interface Fas3School {
  schoolId: string;
  yearId: string;
  admin: AuthenticatedUser & { userId: string };
  t1: Fas3Person;
  t2: Fas3Person;
  t3: Fas3Person;
  t4: Fas3Person;
  inactive: Fas3Person;
  teacher: (person: Fas3Person) => AuthenticatedUser;
  class7a: string;
  ma: string;
  dayAt: (offset: number) => string;
  future: { master: string; withSub: string; plain: string };
}

/**
 * Staffing Fas 3's school, as the owner: an active year around today, 7A,
 * Ma and a mentorstid subject outside the timplan, a Ma row t1 leads at
 * 100 % and t2 co-teaches at 50 %, its master lesson, and a calendar of
 * held, substituted, cancelled and coming lessons (ö1); a second master
 * with two future lessons (ö2); posts and a mentorship (ö3, ö4).
 */
async function givenFas3School(owner: Client): Promise<Fas3School> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-fas3'`, [MARKER]);
  // The publicering checks' schools, whole, for a run that stopped inside them.
  await owner.query(
    `DELETE FROM "Schools" WHERE slug IN ($1 || '-publicering', $1 || '-utkast', $1 || '-tvilling-a', $1 || '-tvilling-b', $1 || '-avbokning', $1 || '-visare')`,
    [MARKER],
  );
  const one = async <T extends object>(sql: string, params: unknown[]): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const DAY = 24 * 60 * 60 * 1000;
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const dayAt = (offset: number) => new Date(today.getTime() + offset * DAY).toISOString().slice(0, 10);
  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${MARKER} fas3`, `${MARKER}-fas3`],
  );
  const person = (role: string, email: string, active = true) =>
    one<Fas3Person>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
       VALUES ($1, $2, 'Probe', 'Fas3', $3::"UserRole", gen_random_uuid(), $4, now()) RETURNING id, "authId"`,
      [school.id, `${MARKER}-fas3-${email}@example.invalid`, role, active],
    );
  const admin = await person('SCHOOL_ADMIN', 'admin');
  const t1 = await person('TEACHER', 't1');
  const t2 = await person('TEACHER', 't2');
  const t3 = await person('TEACHER', 't3');
  const t4 = await person('TEACHER', 't4');
  const inactive = await person('TEACHER', 'inactive', false);
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, $2, $3::date, $4::date, true, now()) RETURNING id`,
    [school.id, `${MARKER} fas3`, dayAt(-60), dayAt(200)],
  );
  const class7a = await one<{ id: string }>(
    `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
     VALUES ($1, $2, '7A', 'CLASS', 7, now()) RETURNING id`,
    [school.id, year.id],
  );
  const ma = await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, 'Matematik', now()) RETURNING id`, [school.id]);
  const mentor = await one<{ id: string }>(
    `INSERT INTO "Subjects" ("schoolId", name, "countsTowardTimplan", "updatedAt") VALUES ($1, 'Mentorstid', false, now()) RETURNING id`,
    [school.id],
  );
  await owner.query(`INSERT INTO "StaffingPolicies" ("schoolId", "fullTimeTeachingMinutesPerWeek", "updatedAt") VALUES ($1, 1080, now())`, [school.id]);
  for (const [who, percent, reduction] of [[t1, 100, 20], [t2, 100, 0], [t3, 50, 0], [t4, 100, 0], [inactive, 100, 0]] as const) {
    await owner.query(
      `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "reductionPercent", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, now())`,
      [school.id, who.id, year.id, percent, reduction],
    );
  }
  await owner.query(
    `INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "updatedAt")
     VALUES ($1, $2, $3, 'MENTORSKAP', 'Mentor 7A', 60, $4, now())`,
    [school.id, t1.id, year.id, class7a.id],
  );
  // t4, to be deleted with a post, a slot-holding uppdrag and a mentorship (ö3).
  const slot = await one<{ id: string }>(
    `INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, reason, "updatedAt")
     VALUES ($1, 'TEACHER', $2, 2, '15:00', '16:00', 'UNAVAILABLE', 'Uppdrag', now()) RETURNING id`,
    [school.id, t4.id],
  );
  await owner.query(
    `INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "blockedConstraintId", "updatedAt")
     VALUES ($1, $2, $3, 'APT_KONFERENS', 'APT', 60, $4, now())`,
    [school.id, t4.id, year.id, slot.id],
  );
  await owner.query(
    `INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "updatedAt")
     VALUES ($1, $2, $3, 'MENTORSKAP', 'Mentor 7A bis', 30, $4, now())`,
    [school.id, t4.id, year.id, class7a.id],
  );
  await owner.query(
    `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "coTeacherId",
                                         "lessonsPerWeek", "minutesPerLesson", "teacherLoadPercent", "coTeacherLoadPercent", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, 3, 60, 100, 50, now())`,
    [school.id, year.id, ma.id, class7a.id, t1.id, t2.id],
  );
  const master = (teacherId: string, coTeacherId: string | null, dayOfWeek: number) =>
    one<{ id: string }>(
      `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "coTeacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, '08:00', '09:00', now()) RETURNING id`,
      [school.id, year.id, ma.id, class7a.id, teacherId, coTeacherId, dayOfWeek],
    );
  const taught = await master(t1.id, t2.id, 1);
  const lesson = async (offset: number, status: string, rows: [Fas3Person, string][], options: { cause?: string; subjectId?: string; masterId?: string | null } = {}) => {
    const date = dayAt(offset);
    const row = await one<{ id: string }>(
      `INSERT INTO "CalendarLessons" ("schoolId", "masterLessonId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "cancelCause", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::date, $5::date + time '06:00', $5::date + time '07:00', $6::"LessonStatus", $7::"LessonCancelCause", now())
       RETURNING id`,
      [school.id, 'masterId' in options ? options.masterId : taught.id, options.subjectId ?? ma.id, class7a.id, date, status, options.cause ?? null],
    );
    for (const [who, role] of rows) {
      await owner.query(
        `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, $4::"TeacherAssignmentRole")`,
        [school.id, row.id, who.id, role],
      );
    }
    return row.id;
  };
  await lesson(-14, 'SCHEDULED', [[t1, 'LEAD'], [t2, 'ASSISTANT']]);
  await lesson(-13, 'SCHEDULED', [[t3, 'SUBSTITUTE']]);
  await lesson(-12, 'CANCELLED', [[t1, 'LEAD'], [t2, 'ASSISTANT']], { cause: 'TEACHER_UNAVAILABLE' });
  await lesson(-11, 'SCHEDULED', [[t3, 'SUBSTITUTE'], [t1, 'LEAD']]);
  // Mentorstid, made by hand: no master, no row — t1's teaching at 100 %.
  await lesson(-10, 'SCHEDULED', [[t1, 'LEAD']], { subjectId: mentor.id, masterId: null });
  await lesson(5, 'SCHEDULED', [[t1, 'LEAD'], [t2, 'ASSISTANT']]);
  // Legacy rows (before C5b): a LEAD beside a vikarie on a lesson later
  // cancelled, and on one still ahead — the lost and coming minutes are the
  // vikarie's alone, never the lead's as well.
  await lesson(-9, 'CANCELLED', [[t3, 'SUBSTITUTE'], [t1, 'LEAD']], { cause: 'TEACHER_UNAVAILABLE' });
  await lesson(6, 'SCHEDULED', [[t3, 'SUBSTITUTE'], [t1, 'LEAD']]);
  // (ö2): a second master, t1 leading, with two lessons a month ahead.
  const second = await master(t1.id, null, 3);
  const withSub = await lesson(30, 'SCHEDULED', [[t1, 'LEAD']], { masterId: second.id });
  const plain = await lesson(37, 'SCHEDULED', [[t1, 'LEAD']], { masterId: second.id });
  return {
    schoolId: school.id,
    yearId: year.id,
    admin: { authId: admin.authId, userId: admin.id, schoolId: school.id, role: Role.SCHOOL_ADMIN },
    t1,
    t2,
    t3,
    t4,
    inactive,
    teacher: (who) => ({ authId: who.authId, userId: who.id, schoolId: school.id, role: Role.TEACHER }),
    class7a: class7a.id,
    ma: ma.id,
    dayAt,
    future: { master: second.id, withSub, plain },
  };
}

interface BudgetSchool {
  schoolId: string;
  admin: AuthenticatedUser;
  teachers: string[];
  lesson7a: string;
  requirement8a: string;
  class7a: string;
  calendarLesson: string;
  yearId: string;
}

/** (z)'s school, as the owner: the paths it counts write nothing it needs again. */
async function givenBudgetSchool(owner: Client): Promise<BudgetSchool> {
  const one = async <T extends object>(sql: string, params: unknown[]): Promise<T> =>
    (await owner.query<T>(sql, params)).rows[0];
  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${MARKER} budget`, `${MARKER}-budget`],
  );
  const person = (role: string, email: string, groupId: string | null = null) =>
    one<{ id: string; authId: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, 'Probe', 'Budget', $3::"UserRole", gen_random_uuid(), true, $4, now()) RETURNING id, "authId"`,
      [school.id, `${MARKER}-budget-${email}@example.invalid`, role, groupId],
    );
  const admin = await person('SCHOOL_ADMIN', 'admin');
  const teachers = [await person('TEACHER', 't1'), await person('TEACHER', 't2'), await person('TEACHER', 't3'), await person('TEACHER', 't4')];
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, $2, '2096-08-13', '2097-06-11', true, now()) RETURNING id`,
    [school.id, `${MARKER} budget`],
  );
  const group = (name: string, grade: number) =>
    one<{ id: string }>(
      `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "updatedAt")
       VALUES ($1, $2, $3, $4, 'CLASS', now()) RETURNING id`,
      [school.id, year.id, `${MARKER} ${name}`, grade],
    );
  const g7a = await group('7A', 7);
  const g8a = await group('8A', 8);
  for (const [n, g] of [[1, g7a], [2, g7a], [3, g8a], [4, g8a]] as const) await person('STUDENT', `p${n}`, g.id);
  const subject = await one<{ id: string }>(
    `INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`,
    [school.id, `${MARKER} budget matematik`],
  );
  await owner.query(
    `INSERT INTO "LunchSettings" ("schoolId", "lunchEnabled", "lunchStartTime", "lunchEndTime", "lunchMinutes", "updatedAt")
     VALUES ($1, true, '11:00', '13:00', 30, now())`,
    [school.id],
  );
  await owner.query(`INSERT INTO "StaffingPolicies" ("schoolId", "updatedAt") VALUES ($1, now())`, [school.id]);
  for (const teacher of teachers) {
    await owner.query(
      `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt")
       VALUES ($1, $2, $3, 100, now())`,
      [school.id, teacher.id, year.id],
    );
    await owner.query(
      `INSERT INTO "TeacherSubjectQualifications" ("schoolId", "userId", "subjectId", "minGradeLevel", "maxGradeLevel", kind, "updatedAt")
       VALUES ($1, $2, $3, 7, 9, 'BEHORIG', now())`,
      [school.id, teacher.id, subject.id],
    );
  }
  const requirement = await one<{ id: string }>(
    `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 2, 60, now()) RETURNING id`,
    [school.id, year.id, subject.id, g8a.id, teachers[0].id],
  );
  // 7A and 8A at the same hour, sharing no pupil and no teacher: a PATCH of
  // either reads both rosters and lands.
  const lesson = (groupId: string, teacherId: string) =>
    one<{ id: string }>(
      `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 3, '08:00', '09:00', now()) RETURNING id`,
      [school.id, year.id, subject.id, groupId, teacherId],
    );
  const l7a = await lesson(g7a.id, teachers[0].id);
  await lesson(g8a.id, teachers[2].id);
  const calendar = await one<{ id: string }>(
    `INSERT INTO "CalendarLessons" ("schoolId", "masterLessonId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
     VALUES ($1, $2, $3, $4, '2096-10-17', '2096-10-17T06:00:00Z', '2096-10-17T07:00:00Z', now()) RETURNING id`,
    [school.id, l7a.id, subject.id, g7a.id],
  );
  await owner.query(
    `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, 'LEAD')`,
    [school.id, calendar.id, teachers[0].id],
  );
  return {
    schoolId: school.id,
    admin: { authId: admin.authId, userId: admin.id, schoolId: school.id, role: Role.SCHOOL_ADMIN },
    teachers: teachers.map((teacher) => teacher.id),
    lesson7a: l7a.id,
    requirement8a: requirement.id,
    class7a: g7a.id,
    calendarLesson: calendar.id,
    yearId: year.id,
  };
}

/** Every statement pg sends while `body` runs, counted at Client.query: what reaches Postgres. */
async function statementsDuring(body: () => Promise<unknown>): Promise<string[]> {
  const sent: string[] = [];
  const prototype = Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const query = prototype.query;
  prototype.query = function (this: Client, ...args: unknown[]) {
    const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
    sent.push(String(text).replace(/\s+/g, ' ').trim().slice(0, 120));
    return query.apply(this, args);
  };
  try {
    await body();
  } finally {
    prototype.query = query;
  }
  return sent;
}

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

// ---- Publicering (migrations 20261011090000 onwards), in a school of its own.

interface PublicationSchool {
  schoolId: string;
  yearId: string;
  admin: AuthenticatedUser;
  teacher: AuthenticatedUser;
  class7a: string;
  subject: string;
  room: string;
  teacherId: string;
  /** Monday 08:00 with a room, Wednesday 10:00 without one. */
  monday: string;
  wednesday: string;
}

/**
 * A school in 2096, so every day of its year lies ahead and nothing a check
 * writes is ever "the past": an active year, 7A with two pupils, a teacher, a
 * room, two weekly lessons and lunch switched on. Written as the owner; every
 * assertion then runs through the real services as app_authenticated.
 */
async function givenPublicationSchool(
  owner: Client,
  suffix = 'publicering',
  dates: { start: string; end: string } = { start: '2096-08-13', end: '2097-06-11' },
): Promise<PublicationSchool> {
  const one = async <T extends object>(sql: string, params: unknown[]): Promise<T> =>
    (await owner.query<T>(sql, params)).rows[0];
  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${MARKER} ${suffix}`, `${MARKER}-${suffix}`],
  );
  const person = (role: string, email: string, groupId: string | null = null) =>
    one<{ id: string; authId: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, 'Probe', 'Publicering', $3::"UserRole", gen_random_uuid(), true, $4, now()) RETURNING id, "authId"`,
      [school.id, `${MARKER}-${suffix}-${email}@example.invalid`, role, groupId],
    );
  const admin = await person('SCHOOL_ADMIN', 'admin');
  const teacher = await person('TEACHER', 't1');
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, $2, $3, $4, true, now()) RETURNING id`,
    [school.id, `${MARKER} publicering`, dates.start, dates.end],
  );
  const g7a = await one<{ id: string }>(
    `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "updatedAt")
     VALUES ($1, $2, $3, 7, 'CLASS', now()) RETURNING id`,
    [school.id, year.id, `${MARKER} 7A`],
  );
  await person('STUDENT', 'p1', g7a.id);
  await person('STUDENT', 'p2', g7a.id);
  const subject = await one<{ id: string }>(
    `INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`,
    [school.id, `${MARKER} publicering matematik`],
  );
  const room = await one<{ id: string }>(
    `INSERT INTO "Rooms" ("schoolId", name, capacity, "updatedAt") VALUES ($1, $2, 30, now()) RETURNING id`,
    [school.id, `${MARKER} sal 1`],
  );
  await owner.query(
    `INSERT INTO "LunchSettings" ("schoolId", "lunchEnabled", "lunchStartTime", "lunchEndTime", "lunchMinutes", "updatedAt")
     VALUES ($1, true, '11:00', '13:00', 30, now())`,
    [school.id],
  );
  const lesson = (day: number, start: string, end: string, roomId: string | null) =>
    one<{ id: string }>(
      `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::time, $9::time, now()) RETURNING id`,
      [school.id, year.id, subject.id, g7a.id, teacher.id, roomId, day, start, end],
    );
  const monday = await lesson(1, '08:00', '09:00', room.id);
  const wednesday = await lesson(3, '10:00', '11:00', null);
  // A timplanspost and a post, so the teacher's figures have rows to show.
  await owner.query(
    `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 2, 60, now())`,
    [school.id, year.id, subject.id, g7a.id, teacher.id],
  );
  await owner.query(
    `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt")
     VALUES ($1, $2, $3, 100, now())`,
    [school.id, teacher.id, year.id],
  );
  return {
    schoolId: school.id,
    yearId: year.id,
    admin: { authId: admin.authId, userId: admin.id, schoolId: school.id, role: Role.SCHOOL_ADMIN },
    teacher: { authId: teacher.authId, userId: teacher.id, schoolId: school.id, role: Role.TEACHER },
    class7a: g7a.id,
    subject: subject.id,
    room: room.id,
    teacherId: teacher.id,
    monday: monday.id,
    wednesday: wednesday.id,
  };
}

function publicationServicesFor(api: PrismaService): { calendar: CalendarService; publications: PublicationsService } {
  const calendar = new CalendarService(api);
  const publications = new PublicationsService(
    api,
    calendar,
    new TimplanCoverageService(api),
    new StaffingLoadService(api),
    { recipientsForGroups: async () => [], notifyUsers: async () => undefined } as unknown as NotificationsService,
    { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService,
  );
  return { calendar, publications };
}

async function publicationChecks(owner: Client, api: PrismaService): Promise<void> {
  const school = await givenPublicationSchool(owner);
  const { publications } = publicationServicesFor(api);
  const rows = async (sql: string, params: unknown[] = [school.schoolId]) => (await owner.query(sql, params)).rows;
  const calendarRows = (from: string, to: string) =>
    rows(
      `SELECT "masterLessonId", date::text, "startsAt", "endsAt", status::text, "roomId", "cancelCause"::text
         FROM "CalendarLessons" WHERE "schoolId" = $1 AND date BETWEEN $2 AND $3 ORDER BY 1, 2`,
      [school.schoolId, from, to],
    );
  try {
    await check('(pub-a) a preview materialises in a transaction it rolls back: no lesson, no log row', async () => {
      const preview = await publications.preview(
        { academicYearId: school.yearId, validFrom: '2096-09-01', validTo: '2096-09-30' },
        school.admin,
      );
      // Four Mondays and four Wednesdays in September 2096.
      assert.equal(preview.result.created, 8);
      assert.deepEqual(
        preview.gates.map((gate) => [gate.code, gate.severity, gate.count]),
        [['PUB_NO_ROOM', 'WARN', 1]],
      );
      assert.equal((await rows(`SELECT 1 FROM "CalendarLessons" WHERE "schoolId" = $1`)).length, 0);
      assert.equal((await rows(`SELECT 1 FROM "TimetablePublications" WHERE "schoolId" = $1`)).length, 0);
    });

    await check('(pub-a) DIRECT publishes the window with its validity, and refuses a warning nobody acknowledged', async () => {
      const range = { academicYearId: school.yearId, validFrom: '2096-09-01', validTo: '2096-09-30' };
      await assert.rejects(publications.publish(range, school.admin), (error: unknown) =>
        error instanceof ConflictException && JSON.stringify(error.getResponse()).includes('PUBLISH_WARNINGS_UNACKNOWLEDGED'),
      );
      assert.equal((await rows(`SELECT 1 FROM "CalendarLessons" WHERE "schoolId" = $1`)).length, 0, 'the refused attempt left lessons');
      const outcome = await publications.publish({ ...range, acknowledgeWarnings: true }, school.admin);
      assert.equal(outcome.result.created, 8);
      const [log] = await rows(
        `SELECT kind::text, outcome::text, "publishMode"::text, "validFrom"::text, "validTo"::text, created, "acknowledgedWarnings"
           FROM "TimetablePublications" WHERE "schoolId" = $1`,
      );
      assert.deepEqual(log, {
        kind: 'PUBLISH',
        outcome: 'PUBLISHED',
        publishMode: 'DIRECT',
        validFrom: '2096-09-01',
        validTo: '2096-09-30',
        created: 8,
        acknowledgedWarnings: true,
      });
      assert.equal((await calendarRows('2096-09-01', '2096-09-30')).length, 8);
    });

    await check('(pub-a) the new DIRECT publish writes the rows the old route writes, byte for byte', async () => {
      await publications.publish(
        { academicYearId: school.yearId, validFrom: '2096-10-01', validTo: '2096-10-31', acknowledgeWarnings: true },
        school.admin,
      );
      const viaNew = await calendarRows('2096-10-01', '2096-10-31');
      await owner.query(`DELETE FROM "CalendarLessons" WHERE "schoolId" = $1 AND date BETWEEN '2096-10-01' AND '2096-10-31'`, [
        school.schoolId,
      ]);
      const legacy = await publications.legacyPublish(
        { academicYearId: school.yearId, fromDate: '2096-10-01', toDate: '2096-10-31' },
        school.admin,
      );
      assert.deepEqual(Object.keys(legacy).sort(), ['cancelled', 'created', 'fromDate', 'skipped', 'toDate']);
      assert.deepEqual(await calendarRows('2096-10-01', '2096-10-31'), viaNew);
      const kinds = await rows(`SELECT kind::text FROM "TimetablePublications" WHERE "schoolId" = $1 ORDER BY "publishedAt", id`);
      assert.deepEqual(kinds.map((row) => row.kind), ['PUBLISH', 'PUBLISH', 'LEGACY_PUBLISH']);
    });

    await check('(pub-a) a REFUSE the school set stops the publish, logs the refusal and writes no lesson', async () => {
      await publications.upsertSettings({ gateMissingRoom: 'REFUSE' }, school.admin);
      await assert.rejects(
        publications.publish(
          { academicYearId: school.yearId, validFrom: '2096-11-01', validTo: '2096-11-30', acknowledgeWarnings: true },
          school.admin,
        ),
        (error: unknown) => error instanceof ConflictException && JSON.stringify(error.getResponse()).includes('PUB_NO_ROOM'),
      );
      // The old route asks the same REFUSE, now that the school has one.
      await assert.rejects(
        publications.legacyPublish({ academicYearId: school.yearId, fromDate: '2096-11-01', toDate: '2096-11-30' }, school.admin),
        (error: unknown) => error instanceof ConflictException,
      );
      assert.equal((await calendarRows('2096-11-01', '2096-11-30')).length, 0);
      const refused = await rows(
        `SELECT kind::text, created, gates->0->>'code' AS code FROM "TimetablePublications" WHERE "schoolId" = $1 AND outcome = 'REFUSED' ORDER BY "publishedAt"`,
      );
      assert.deepEqual(refused, [
        { kind: 'PUBLISH', created: 0, code: 'PUB_NO_ROOM' },
        { kind: 'LEGACY_PUBLISH', created: 0, code: 'PUB_NO_ROOM' },
      ]);
      await publications.upsertSettings({ gateMissingRoom: 'WARN' }, school.admin);
    });

    await check('(pub-a) the timeline says which publication is valid when; a teacher cannot publish', async () => {
      const timeline = await publications.timeline(school.yearId, school.admin);
      assert.deepEqual(
        timeline.segments.map((segment) => [segment.from, segment.to]),
        [
          ['2096-09-01', '2096-09-30'],
          ['2096-10-01', '2096-10-31'],
        ],
      );
      assert.equal(timeline.publications.length, 5);
      await assert.rejects(
        api.withRls(school.teacher, (tx) =>
          tx.timetablePublication.create({
            data: {
              schoolId: school.schoolId,
              academicYearId: school.yearId,
              kind: 'PUBLISH',
              outcome: 'PUBLISHED',
              publishMode: 'DIRECT',
              validFrom: new Date('2096-09-01T00:00:00Z'),
              validTo: new Date('2096-09-02T00:00:00Z'),
            },
          }),
        ),
      );
    });
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-publicering'`, [MARKER]);
  }
}

/**
 * DRAFT (20261011100000), end to end against Postgres, in a school of its own:
 * the empty draft changes nothing a teacher or SS12000 reads (S8); a draft
 * edit and a draft delete move no published row and no teacher figure (B2);
 * the publish carries both over and only then do the figures move; the mode
 * switch back is refused while the draft differs; discard, the legacy
 * route's refusal, a restore's adoption and the refill.
 */
async function draftChecks(owner: Client, api: PrismaService): Promise<void> {
  const school = await givenPublicationSchool(owner, 'utkast');
  const { publications, calendar } = publicationServicesFor(api);
  const drafts = new DraftService(
    api,
    calendar,
    new RealScheduleVersionsService(api),
    { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService,
  );
  const silent = {
    recipientsForGroups: async () => [],
    notifyUsers: async () => undefined,
  } as unknown as NotificationsService;
  const announced: Array<{ schoolId: string; draft: boolean }> = [];
  const lessons = new MasterLessonsService(
    api,
    {
      notifyMasterTimetableChanged: (schoolId: string, options?: { draft?: boolean }) =>
        announced.push({ schoolId, draft: options?.draft === true }),
    } as unknown as RealtimeService,
    silent,
  );
  const rows = async (sql: string, params: unknown[] = [school.schoolId]) => (await owner.query(sql, params)).rows;
  const calendarRows = () =>
    rows(
      `SELECT "masterLessonId", date::text, to_char("startsAt" AT TIME ZONE 'Europe/Stockholm', 'Dy HH24:MI') AS at, status::text
         FROM "CalendarLessons" WHERE "schoolId" = $1 ORDER BY date, "startsAt"`,
    );
  const ss12000 = new Ss12000Service(api);
  const load = new StaffingLoadService(api);
  const coverage = new TimplanCoverageService(api);
  const range = { academicYearId: school.yearId, from: '2096-09-01', to: '2096-12-31' };
  /** Everything a teacher and the kommun read about the grundschema, in one object. */
  const nonAdminReads = async () => ({
    loadScheduled: await load.load(school.yearId, 'scheduled', school.teacher),
    delivered: await load.delivered(range, school.teacher),
    coverageScheduled: await coverage.scheduled({ academicYearId: school.yearId, layer: 'scheduled' }, school.teacher),
    coverageDelivered: await coverage.delivered({ academicYearId: school.yearId, layer: 'delivered' }, school.teacher),
    activities: await ss12000.activities(school.schoolId).then((page) => ({
      ...page,
      data: [...page.data].sort((a, b) => (a.id < b.id ? -1 : 1)),
    })),
    events: await ss12000.calendarEvents(school.schoolId, '2096-08-13', '2097-06-11', '500'),
  });
  // asOf/generated instants differ between two reads; everything else must not.
  const stable = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v) => (key === 'asOf' ? undefined : v)));
  try {
    // A published year in DIRECT, as the school has today.
    await publications.legacyPublish({ academicYearId: school.yearId, fromDate: '2096-08-13' }, school.admin);
    const before = stable(await nonAdminReads());
    const publishedBefore = await calendarRows();

    await check('(pub-b) S8: switching to DRAFT with no edit changes nothing a teacher or SS12000 reads', async () => {
      const switched = await drafts.switchMode('DRAFT', school.admin);
      assert.equal(switched.baselines.length, 1);
      assert.equal(switched.baselines[0]!.lessonCount, 2);
      assert.deepEqual(stable(await nonAdminReads()), before);
      // The teacher's RLS now shows no master lesson; the admin's shows both.
      const teacherSees = await api.withRls(school.teacher, (tx) => tx.masterLesson.count({ where: { academicYearId: school.yearId } }));
      const adminSees = await api.withRls(school.admin, (tx) => tx.masterLesson.count({ where: { academicYearId: school.yearId } }));
      assert.deepEqual([teacherSees, adminSees], [0, 2]);
    });

    await check('(pub-b) a draft edit and a draft delete move no published row and no teacher figure (B2)', async () => {
      const moved = await lessons.update(school.monday, { dayOfWeek: 2 }, school.admin);
      assert.deepEqual([moved.propagatedLessons, moved.removedCalendarLessons], [0, 0]);
      assert.deepEqual(announced.at(-1), { schoolId: school.schoolId, draft: true });
      const removed = await lessons.remove(school.wednesday, school.admin);
      assert.equal(removed.removedCalendarLessons, 0);
      // The deleted lesson's published rows are kept, their key nulled, and recorded.
      const pending = await rows(`SELECT count(*)::int AS n FROM "PublicationPendingRemovals" WHERE "schoolId" = $1`);
      const wednesdays = publishedBefore.filter((row) => row.masterLessonId === school.wednesday).length;
      assert.ok(wednesdays > 30, `only ${wednesdays} published Wednesdays`);
      assert.equal(pending[0].n, wednesdays);
      assert.deepEqual(
        (await calendarRows()).map((row) => [row.date, row.at, row.status]),
        publishedBefore.map((row) => [row.date, row.at, row.status]),
      );
      assert.deepEqual(stable(await nonAdminReads()), before);
      const state = await drafts.state(school.yearId, school.admin);
      assert.deepEqual([state.added.length, state.changed.length, state.removed.length, state.pendingRemovals], [0, 1, 1, wednesdays]);
    });

    await check('(pub-b) the old route answers 409 in DRAFT; switching back is refused while the draft differs', async () => {
      await assert.rejects(
        publications.legacyPublish({ academicYearId: school.yearId }, school.admin),
        (error: unknown) => error instanceof ConflictException && JSON.stringify(error.getResponse()).includes('PUBLISH_MODE_DRAFT'),
      );
      await assert.rejects(
        drafts.switchMode('DIRECT', school.admin),
        (error: unknown) => error instanceof ConflictException && JSON.stringify(error.getResponse()).includes('PUBLISH_DRAFT_PENDING'),
      );
    });

    await check('(pub-b) the publish carries the draft over from its validFrom, and only then do the figures move', async () => {
      const preview = await publications.preview({ academicYearId: school.yearId, validFrom: '2096-09-07' }, school.admin);
      assert.equal(preview.publishMode, 'DRAFT');
      assert.equal((await rows(`SELECT count(*)::int AS n FROM "PublicationPendingRemovals" WHERE "schoolId" = $1`))[0].n > 0, true);
      const outcome = await publications.publish(
        { academicYearId: school.yearId, validFrom: '2096-09-07', acknowledgeWarnings: true, expectedDigest: preview.digest },
        school.admin,
      );
      assert.deepEqual(outcome.draft, preview.draft);
      const after = await calendarRows();
      // Before 7 September: as published. From it: Tuesday, no Wednesday.
      const early = (list: typeof after) => list.filter((row) => row.date < '2096-09-07');
      assert.deepEqual(early(after), early(publishedBefore).map((row) =>
        row.masterLessonId === school.wednesday ? { ...row, masterLessonId: null } : row,
      ));
      const late = after.filter((row) => row.date >= '2096-09-07');
      assert.ok(late.length > 30);
      assert.ok(late.every((row) => row.at.startsWith('Tue 08:00') && row.masterLessonId === school.monday), JSON.stringify(late.slice(0, 3)));
      const [log] = await rows(
        `SELECT kind::text, "publishMode"::text, "validFrom"::text, "lessonCount", moved, removed, adopted
           FROM "TimetablePublications" WHERE "schoolId" = $1 AND kind = 'PUBLISH'`,
      );
      assert.deepEqual(log, {
        kind: 'PUBLISH',
        publishMode: 'DRAFT',
        validFrom: '2096-09-07',
        lessonCount: 1,
        moved: outcome.draft!.moved,
        removed: outcome.draft!.removed,
        adopted: 0,
      });
      assert.ok(outcome.draft!.moved > 30 && outcome.draft!.removed > 30);
      // The deleted lesson's four Wednesdays before validFrom stay published,
      // and recorded, until a publish covers them.
      const left = await rows(
        `SELECT cl.date::text FROM "PublicationPendingRemovals" p JOIN "CalendarLessons" cl ON cl.id = p."calendarLessonId"
          WHERE p."schoolId" = $1 ORDER BY 1`,
      );
      assert.deepEqual(left.map((row) => row.date), ['2096-08-15', '2096-08-22', '2096-08-29', '2096-09-05']);
      // A reader is shown the grundschema valid today, else the nearest one
      // ahead: in this 2096 school that is still the BASELINE's first weeks.
      assert.deepEqual(stable(await nonAdminReads()).activities, before.activities);
    });

    await check('(pub-b) with the draft published to the year’s end, the school may go back to DIRECT, and a DIRECT edit moves the calendar at once', async () => {
      await assert.rejects(drafts.switchMode('DIRECT', school.admin), (error: unknown) => error instanceof ConflictException);
      const all = await publications.publish({ academicYearId: school.yearId, acknowledgeWarnings: true }, school.admin);
      assert.equal(all.publication.validFrom, '2096-08-13');
      assert.equal((await rows(`SELECT count(*)::int AS n FROM "PublicationPendingRemovals" WHERE "schoolId" = $1`))[0].n, 0);
      // Now the published grundschema the readers are shown is the draft's.
      const now = stable(await nonAdminReads());
      assert.equal(now.activities.data.length, 1);
      assert.equal(now.activities.data[0].dayOfWeek, 2);
      assert.notDeepEqual(now.delivered, before.delivered);
      const back = await drafts.switchMode('DIRECT', school.admin);
      assert.equal(back.publishMode, 'DIRECT');
      const moved = await lessons.update(school.monday, { startTime: '09:00', endTime: '10:00' }, school.admin);
      assert.ok(moved.propagatedLessons > 30);
      assert.deepEqual(announced.at(-1), { schoolId: school.schoolId, draft: false });
    });

    await check('(pub-b) a restore in DRAFT keeps a vikarie through adoption, and writes no twin', async () => {
      const versions = new RealScheduleVersionsService(api);
      const saved = await versions.create(school.yearId, `${MARKER} före`, school.admin);
      await drafts.switchMode('DRAFT', school.admin);
      const [target] = await rows(
        `SELECT id, date::text FROM "CalendarLessons" WHERE "schoolId" = $1 AND "masterLessonId" = $2 AND date >= '2096-10-01' ORDER BY date LIMIT 1`,
        [school.schoolId, school.monday],
      );
      await owner.query(`DELETE FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = $1`, [target.id]);
      await owner.query(
        `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, 'SUBSTITUTE')`,
        [school.schoolId, target.id, school.teacherId],
      );
      // The restore recreates every master under a new id.
      await versions.restore(saved.id, school.admin);
      const pending = (await rows(`SELECT count(*)::int AS n FROM "PublicationPendingRemovals" WHERE "schoolId" = $1`))[0].n;
      assert.ok(pending > 30, `${pending} recorded`);
      // The same timetable under new ids is no change to the admin either.
      const state = await drafts.state(school.yearId, school.admin);
      assert.deepEqual([state.added.length, state.changed.length, state.removed.length], [0, 0, 0]);
      const outcome = await publications.publish({ academicYearId: school.yearId, acknowledgeWarnings: true }, school.admin);
      assert.ok(outcome.draft!.adopted >= pending - 1, JSON.stringify(outcome.draft));
      const kept = await rows(`SELECT role::text FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = $1`, [target.id]);
      assert.deepEqual(kept, [{ role: 'SUBSTITUTE' }]);
      const twins = await rows(
        `SELECT date::text, count(*)::int AS n FROM "CalendarLessons" WHERE "schoolId" = $1 AND date >= '2096-10-01' GROUP BY date HAVING count(*) > 1`,
      );
      assert.deepEqual(twins, []);
    });

    await check('(pub-b) a refill re-materialises the PUBLISHED snapshot, never the draft, and changes no validity', async () => {
      await owner.query(`DELETE FROM "CalendarLessons" WHERE "schoolId" = $1 AND date BETWEEN '2096-11-02' AND '2096-11-08'`, [school.schoolId]);
      // A draft edit the refill must not publish.
      const [master] = await rows(`SELECT id FROM "MasterLessons" WHERE "schoolId" = $1 LIMIT 1`);
      await lessons.update(master.id, { dayOfWeek: 4 }, school.admin);
      const refill = await drafts.refill(
        { academicYearId: school.yearId, validFrom: '2096-11-02', validTo: '2096-11-08' },
        school.admin,
      );
      assert.equal(refill.result.created, 1);
      const week = await rows(
        `SELECT to_char("startsAt" AT TIME ZONE 'Europe/Stockholm', 'Dy') AS day FROM "CalendarLessons" WHERE "schoolId" = $1 AND date BETWEEN '2096-11-02' AND '2096-11-08'`,
      );
      assert.deepEqual(week, [{ day: 'Tue' }]);
      const timeline = await publications.timeline(school.yearId, school.admin);
      assert.ok(timeline.publications.some((row) => row.kind === 'REFILL'));
      assert.ok(timeline.segments.every((segment) => timeline.publications.find((row) => row.id === segment.publicationId)?.kind !== 'REFILL'));
    });

    await check('(pub-b) discard puts the masters back under their own ids, and the school may leave DRAFT', async () => {
      const discarded = await drafts.discard(school.yearId, school.admin);
      assert.ok(discarded.restored >= 1);
      const state = await drafts.state(school.yearId, school.admin);
      assert.deepEqual([state.added.length, state.changed.length, state.removed.length], [0, 0, 0]);
      // Next läsår's grundschema, built in DRAFT and never published: leaving
      // DRAFT would publish it whole without a gate, so it is refused, named.
      const next = await owner.query(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
         VALUES ($1, $2, '2097-08-12', '2098-06-10', false, now()) RETURNING id`,
        [school.schoolId, `${MARKER} nästa`],
      );
      const nextGroup = await owner.query(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "updatedAt")
         VALUES ($1, $2, $3, 8, 'CLASS', now()) RETURNING id`,
        [school.schoolId, next.rows[0].id, `${MARKER} 8A`],
      );
      await owner.query(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "updatedAt")
         VALUES ($1, $2, $3, $4, 2, '08:00', '09:00', now())`,
        [school.schoolId, next.rows[0].id, school.subject, nextGroup.rows[0].id],
      );
      const teacherSeesNext = await api.withRls(school.teacher, (tx) => tx.masterLesson.count({ where: { academicYearId: next.rows[0].id } }));
      assert.equal(teacherSeesNext, 0);
      await assert.rejects(
        drafts.switchMode('DIRECT', school.admin),
        (error: unknown) =>
          error instanceof ConflictException &&
          JSON.stringify(error.getResponse()).includes('PUBLISH_DRAFT_PENDING') &&
          JSON.stringify(error.getResponse()).includes(`${MARKER} nästa`),
      );
      await owner.query(`DELETE FROM "AcademicYears" WHERE id = $1`, [next.rows[0].id]);
      assert.equal((await drafts.switchMode('DIRECT', school.admin)).publishMode, 'DIRECT');
    });
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-utkast'`, [MARKER]);
  }
}

/**
 * The equivalence the DRAFT publish is built to: the same edits made in a
 * DIRECT school (each reaching the calendar at once, then the old publish)
 * and in a DRAFT school (kept as a draft, then published from today to the
 * year's end) leave the same calendar. Two twin schools, compared on what a
 * row is — date, times, status, room, subject — since their ids differ. The
 * fixture has no day operations and no lov, so none of the documented
 * divergences applies.
 */
async function equivalenceCheck(owner: Client, api: PrismaService): Promise<void> {
  const direct = await givenPublicationSchool(owner, 'tvilling-a');
  const draft = await givenPublicationSchool(owner, 'tvilling-b');
  const { publications, calendar } = publicationServicesFor(api);
  const drafts = new DraftService(
    api,
    calendar,
    new RealScheduleVersionsService(api),
    { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService,
  );
  const lessons = new MasterLessonsService(
    api,
    { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService,
    { recipientsForGroups: async () => [], notifyUsers: async () => undefined } as unknown as NotificationsService,
  );
  const shape = async (schoolId: string) =>
    (
      await owner.query(
        `SELECT cl.date::text, cl."startsAt", cl."endsAt", cl.status::text, (cl."roomId" IS NULL) AS "noRoom",
                cl."masterLessonId" IS NULL AS orphan, (SELECT count(*)::int FROM "CalendarLessonTeachers" t WHERE t."calendarLessonId" = cl.id) AS teachers
           FROM "CalendarLessons" cl WHERE cl."schoolId" = $1 ORDER BY cl."startsAt", cl.date`,
        [schoolId],
      )
    ).rows;
  try {
    await check('(pub-c) DRAFT edits and a publish to the year’s end leave the calendar DIRECT edits and the old publish leave', async () => {
      for (const school of [direct, draft]) {
        await publications.legacyPublish({ academicYearId: school.yearId, fromDate: '2096-08-13' }, school.admin);
      }
      await drafts.switchMode('DRAFT', draft.admin);
      for (const school of [direct, draft]) {
        await lessons.update(school.monday, { dayOfWeek: 2, startTime: '10:00', endTime: '11:00', roomId: null }, school.admin);
        await lessons.remove(school.wednesday, school.admin);
      }
      await publications.legacyPublish({ academicYearId: direct.yearId }, direct.admin);
      await publications.publish({ academicYearId: draft.yearId, acknowledgeWarnings: true }, draft.admin);
      const a = await shape(direct.schoolId);
      const b = await shape(draft.schoolId);
      assert.ok(a.length > 30, `${a.length} rows`);
      assert.deepEqual(b, a);
    });
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug IN ($1 || '-tvilling-a', $1 || '-tvilling-b')`, [MARKER]);
  }
}

/**
 * The edges of a DRAFT publish's range inside a week. A publish carries a
 * changed master's rows only inside [validFrom, validTo]: a weekday move that
 * would take a row across either edge removes it (that week's lesson is
 * dropped, and PUB_WEEK_SPLIT said so), and never writes it into a day
 * another publication owns. Two consecutive partial publishes then never
 * carry one row twice — the shift is from the row's own weekday.
 */
async function weekEdgeChecks(owner: Client, api: PrismaService): Promise<void> {
  const school = await givenPublicationSchool(owner, 'veckokant');
  const { publications, calendar } = publicationServicesFor(api);
  const drafts = new DraftService(
    api,
    calendar,
    new RealScheduleVersionsService(api),
    { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService,
  );
  const lessons = new MasterLessonsService(
    api,
    { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService,
    { recipientsForGroups: async () => [], notifyUsers: async () => undefined } as unknown as NotificationsService,
  );
  const rows = async (from: string, to: string, masterLessonId: string) =>
    (
      await owner.query(
        `SELECT date::text, to_char("startsAt" AT TIME ZONE 'Europe/Stockholm', 'Dy HH24:MI') AS at
           FROM "CalendarLessons" WHERE "schoolId" = $1 AND "masterLessonId" = $2 AND date BETWEEN $3 AND $4 ORDER BY date`,
        [school.schoolId, masterLessonId, from, to],
      )
    ).rows.map((row) => `${row.date} ${row.at}`);
  try {
    await check('(pub-f) a mid-week validTo drops the week\'s lesson, and the next publish carries no row twice', async () => {
      await publications.legacyPublish({ academicYearId: school.yearId, fromDate: '2096-08-13' }, school.admin);
      await drafts.switchMode('DRAFT', school.admin);
      // Monday 08:00 → Thursday 08:00 in the draft.
      await lessons.update(school.monday, { dayOfWeek: 4 }, school.admin);
      // Mon 15 Oct .. Wed 21 Nov 2096: Mon 19 Nov's row would land on Thu 22 Nov.
      const first = await publications.publish(
        { academicYearId: school.yearId, validFrom: '2096-10-15', validTo: '2096-11-21', acknowledgeWarnings: true },
        school.admin,
      );
      assert.ok(first.gates.some((gate) => gate.code === 'PUB_WEEK_SPLIT'), JSON.stringify(first.gates.map((gate) => gate.code)));
      assert.deepEqual(await rows('2096-11-19', '2096-11-25', school.monday), []);
      assert.deepEqual(await rows('2096-11-12', '2096-11-18', school.monday), ['2096-11-15 Thu 08:00']);
      assert.deepEqual(await rows('2096-11-26', '2096-12-02', school.monday), ['2096-11-26 Mon 08:00']);
      // The rest of the year from Thu 22 Nov: the BASELINE's Mondays move once.
      await publications.publish({ academicYearId: school.yearId, validFrom: '2096-11-22', acknowledgeWarnings: true }, school.admin);
      assert.deepEqual(await rows('2096-11-19', '2096-12-02', school.monday), ['2096-11-22 Thu 08:00', '2096-11-29 Thu 08:00']);
      const weekend = await owner.query(
        `SELECT date::text FROM "CalendarLessons" WHERE "schoolId" = $1 AND extract(isodow FROM date) >= 6`,
        [school.schoolId],
      );
      assert.deepEqual(weekend.rows, []);
    });

    await check('(pub-f) a mid-week validFrom never writes a day before it: the week\'s lesson is dropped instead', async () => {
      const before = await rows('2096-08-13', '2096-12-04', school.wednesday);
      // Wednesday 10:00 → Monday 10:00, published from Wed 5 Dec.
      await lessons.update(school.wednesday, { dayOfWeek: 1 }, school.admin);
      const outcome = await publications.publish(
        { academicYearId: school.yearId, validFrom: '2096-12-05', acknowledgeWarnings: true },
        school.admin,
      );
      assert.ok(outcome.gates.some((gate) => gate.code === 'PUB_WEEK_SPLIT'));
      assert.deepEqual(await rows('2096-08-13', '2096-12-04', school.wednesday), before);
      assert.deepEqual(await rows('2096-12-05', '2096-12-16', school.wednesday), ['2096-12-10 Mon 10:00']);
    });

    await check('(pub-f) a teacher reads no row of the log — no refusal, no gates naming the draft — only the snapshot ranges', async () => {
      await publications.upsertSettings({ gateWeekSplit: 'REFUSE' }, school.admin);
      // Thursday 08:00 (as published) → Monday in the draft, published from Wed 16 Jan 2097: refused.
      await lessons.update(school.monday, { dayOfWeek: 1 }, school.admin);
      await assert.rejects(
        publications.publish({ academicYearId: school.yearId, validFrom: '2097-01-16', acknowledgeWarnings: true }, school.admin),
        (error: unknown) => error instanceof ConflictException && JSON.stringify(error.getResponse()).includes('PUBLISH_GATES_REFUSED'),
      );
      const refused = await owner.query(
        `SELECT gates::text FROM "TimetablePublications" WHERE "schoolId" = $1 AND outcome = 'REFUSED'`,
        [school.schoolId],
      );
      assert.ok(refused.rows.some((row) => row.gates.includes('PUB_WEEK_SPLIT')), JSON.stringify(refused.rows));
      const seen = await api.withRls(school.teacher, async (tx) => ({
        log: await tx.timetablePublication.findMany({ select: { id: true, gates: true } }),
        ranges: await snapshotRanges(tx, school.yearId),
      }));
      assert.deepEqual(seen.log, []);
      const asAdmin = await api.withRls(school.admin, (tx) => snapshotRanges(tx, school.yearId));
      // The BASELINE and the three publishes above; the refusal is none of them.
      assert.equal(asAdmin.length, 4);
      assert.deepEqual(seen.ranges, asAdmin);
    });
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-veckokant'`, [MARKER]);
  }
}

/**
 * The meals in DRAFT (20261011130000). The lunch sittings are part of the
 * draft and the calendar's meals are the published ones: a regeneration in
 * DRAFT leaves the meals pupils and guardians read alone; a refill writes the
 * meals its segment published, never a draft sitting; a DRAFT publish
 * replaces its window's meals from the sittings it publishes.
 */
async function mealChecks(owner: Client, api: PrismaService): Promise<void> {
  const school = await givenPublicationSchool(owner, 'maltider');
  const { publications, calendar } = publicationServicesFor(api);
  const drafts = new DraftService(
    api,
    calendar,
    new RealScheduleVersionsService(api),
    { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService,
  );
  const one = async (sql: string, params: unknown[]) => (await owner.query(sql, params)).rows[0];
  const pupil = await one(
    `SELECT id, "authId" FROM "Users" WHERE "schoolId" = $1 AND role = 'STUDENT' ORDER BY email LIMIT 1`,
    [school.schoolId],
  );
  const guardian = await one(
    `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
     VALUES ($1, $2, 'Probe', 'Vårdnadshavare', 'GUARDIAN', gen_random_uuid(), true, now()) RETURNING id, "authId"`,
    [school.schoolId, `${MARKER}-maltider-g1@example.invalid`],
  );
  await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3)`, [
    school.schoolId,
    guardian.id,
    pupil.id,
  ]);
  for (let day = 1; day <= 5; day++) {
    await owner.query(
      `INSERT INTO "LunchSittings" ("schoolId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime", headcount, "isGenerated", "updatedAt")
       VALUES ($1, $2, $3, $4, '11:30', '12:00', 2, true, now())`,
      [school.schoolId, school.yearId, school.class7a, day],
    );
  }
  const student = { authId: pupil.authId, userId: pupil.id, schoolId: school.schoolId, role: Role.STUDENT };
  const parent = { authId: guardian.authId, userId: guardian.id, schoolId: school.schoolId, role: Role.GUARDIAN };
  const mealsSeenBy = (user: AuthenticatedUser, from = '2096-08-13', to = '2097-06-11') =>
    api.withRls(user, (tx) =>
      tx.calendarLunch
        .findMany({
          where: { date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } },
          select: { date: true, startsAt: true, endsAt: true },
          orderBy: { date: 'asc' },
        })
        .then((rows) => rows.map((row) => `${row.date.toISOString().slice(0, 10)} ${row.startsAt.toISOString().slice(11, 16)}`)),
    );
  try {
    await publications.legacyPublish({ academicYearId: school.yearId, fromDate: '2096-08-13' }, school.admin);
    await drafts.switchMode('DRAFT', school.admin);
    const published = { student: await mealsSeenBy(student), guardian: await mealsSeenBy(parent) };
    assert.ok(published.student.length > 150, `${published.student.length} meals`);

    await check('(pub-g) a regeneration in DRAFT leaves the published meals a pupil and a guardian read as they were', async () => {
      const proxy = new OptimizationProxyService(
        api,
        { post: () => { throw new Error('the engine was called'); } } as never,
        { getOrThrow: () => ({ baseUrl: 'http://engine.invalid', apiKey: 'k'.repeat(32), timeoutMs: 1 }) } as never,
      );
      // The engine's answer: no lessons, and 7A eating at 12:30 on Tuesdays only.
      await api.withRls(school.admin, (tx) =>
        (proxy as unknown as {
          persistMasterLessons: (...args: unknown[]) => Promise<unknown>;
        }).persistMasterLessons(
          tx,
          school.yearId,
          school.admin,
          { status: 'OPTIMAL', lessons: [] },
          [],
          new Map(),
          new Map(),
          [{ studentGroupId: school.class7a, dayOfWeek: 2, startTime: '12:30:00', endTime: '13:00:00' }],
          new Map([[school.class7a, 2]]),
        ),
      );
      assert.deepEqual({ student: await mealsSeenBy(student), guardian: await mealsSeenBy(parent) }, published);
    });

    await check('(pub-g) a refill writes the meals its segment published, never the draft\'s sittings', async () => {
      await owner.query(
        `DELETE FROM "CalendarLunches" WHERE "schoolId" = $1 AND date BETWEEN '2096-11-05' AND '2096-11-11'`,
        [school.schoolId],
      );
      await drafts.refill(
        { academicYearId: school.yearId, validFrom: '2096-11-05', validTo: '2096-11-11', acknowledgeWarnings: true },
        school.admin,
      );
      assert.deepEqual(
        await mealsSeenBy(student, '2096-11-05', '2096-11-11'),
        published.student.filter((meal) => meal >= '2096-11-05' && meal < '2096-11-12'),
      );
    });

    await check('(pub-g) a DRAFT publish replaces its window\'s meals with the sittings it publishes', async () => {
      await publications.publish(
        { academicYearId: school.yearId, validFrom: '2096-11-12', validTo: '2096-11-18', acknowledgeWarnings: true },
        school.admin,
      );
      // 13 Nov 2096 is a Tuesday: the draft's one sitting, 12:30 Stockholm.
      assert.deepEqual(await mealsSeenBy(student, '2096-11-12', '2096-11-18'), ['2096-11-13 11:30']);
      // Outside the window the published meals stand.
      assert.deepEqual(
        await mealsSeenBy(student, '2096-11-19', '2096-11-25'),
        published.student.filter((meal) => meal >= '2096-11-19' && meal < '2096-11-26'),
      );
    });
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-maltider'`, [MARKER]);
  }
}

/**
 * A batch reversed after the grundschema moved one of its lessons. The
 * publish moves the template and materialises the new day, which the batch
 * still in force takes (S7); the old day's row stays cancelled by the batch.
 * Reversing gives back only the row at the slot the lesson runs at now, and
 * deletes the old slot's — else the class would have it twice that week, or
 * an "Inställd" for an event taken back.
 */
async function batchMoveChecks(owner: Client, api: PrismaService): Promise<void> {
  const school = await givenPublicationSchool(owner, 'avbokning-flytt');
  const { publications, calendar } = publicationServicesFor(api);
  const drafts = new DraftService(
    api,
    calendar,
    new RealScheduleVersionsService(api),
    { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService,
  );
  const lessons = new MasterLessonsService(
    api,
    { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService,
    { recipientsForGroups: async () => [], notifyUsers: async () => undefined } as unknown as NotificationsService,
  );
  const batches = new CancellationBatchesService(api, {
    notifyLessonsChanged: async () => undefined,
  } as unknown as RealtimeService);
  const week = async () =>
    (
      await owner.query(
        `SELECT date::text, to_char("startsAt" AT TIME ZONE 'Europe/Stockholm', 'Dy HH24:MI') AS at, status::text
           FROM "CalendarLessons" WHERE "schoolId" = $1 AND "masterLessonId" = $2 AND date BETWEEN '2096-11-05' AND '2096-11-11' ORDER BY date`,
        [school.schoolId, school.monday],
      )
    ).rows.map((row) => `${row.date} ${row.at} ${row.status}`);
  try {
    await check('(pub-d) a reversal after a publish moved one of the batch\'s lessons gives back only the row where it runs now and deletes the old slot\'s', async () => {
      await publications.legacyPublish({ academicYearId: school.yearId, fromDate: '2096-08-13' }, school.admin);
      await drafts.switchMode('DRAFT', school.admin);
      const selection = {
        academicYearId: school.yearId,
        name: 'Prao åk 7',
        cause: 'EVENT' as const,
        fromDate: '2096-11-05',
        toDate: '2096-11-09',
        scope: 'GROUPS' as const,
        groupIds: [school.class7a],
      };
      const preview = await batches.preview(selection, school.admin);
      const created = await batches.create({ ...selection, expectedDigest: preview.digest }, school.admin);
      // Monday 08:00 → Tuesday 08:00, published from the batch's Monday on.
      await lessons.update(school.monday, { dayOfWeek: 2 }, school.admin);
      await publications.publish({ academicYearId: school.yearId, validFrom: '2096-10-15', acknowledgeWarnings: true }, school.admin);
      assert.deepEqual(await week(), ['2096-11-05 Mon 08:00 CANCELLED', '2096-11-06 Tue 08:00 CANCELLED']);
      const reversal = await batches.reversePreview(created.batch.id, school.admin);
      assert.deepEqual(reversal.removedTemplateMoved.map((entry) => entry.date), ['2096-11-05']);
      await batches.reverse(created.batch.id, school.admin);
      assert.deepEqual(await week(), ['2096-11-06 Tue 08:00 SCHEDULED']);
    });
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-avbokning-flytt'`, [MARKER]);
  }
}

/**
 * A school with a past (20261011132000). The 2096 school above has none, so
 * it cannot see what a draft delete does to rows that have been held: the
 * calendar's ON DELETE SET NULL takes their key at once. The trigger records
 * them too, so every reader on the published key — SS12000 calendarEvents,
 * the teacher's delivered figures — answers as before until the deletion is
 * published, and the publish then releases them as DIRECT's orphans.
 */
async function pastRowChecks(owner: Client, api: PrismaService): Promise<void> {
  // Eight weeks back to the Monday, thirty-eight weeks ahead: today is inside.
  const monday = new Date();
  monday.setUTCHours(0, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 56);
  const end = new Date(monday);
  end.setUTCDate(end.getUTCDate() + 7 * 38 - 3);
  const dates = { start: monday.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  const school = await givenPublicationSchool(owner, 'dagens', dates);
  const { publications, calendar } = publicationServicesFor(api);
  const drafts = new DraftService(
    api,
    calendar,
    new RealScheduleVersionsService(api),
    { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService,
  );
  const lessons = new MasterLessonsService(
    api,
    { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService,
    { recipientsForGroups: async () => [], notifyUsers: async () => undefined } as unknown as NotificationsService,
  );
  const ss12000 = new Ss12000Service(api);
  const load = new StaffingLoadService(api);
  const stable = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v) => (key === 'asOf' ? undefined : v)));
  const reads = async () =>
    stable({
      events: await ss12000.calendarEvents(school.schoolId, dates.start, dates.end, '500'),
      delivered: await load.delivered({ academicYearId: school.yearId, from: dates.start, to: dates.end }, school.teacher),
    });
  const pastWednesdays = async () =>
    (
      await owner.query(
        `SELECT count(*)::int AS n FROM "CalendarLessons" WHERE "schoolId" = $1 AND "startsAt" <= now()
            AND extract(isodow FROM date) = 3`,
        [school.schoolId],
      )
    ).rows[0].n as number;
  try {
    await check('(pub-b) a draft delete on a school with a past changes no published key of a held lesson until it is published', async () => {
      await publications.legacyPublish({ academicYearId: school.yearId, fromDate: dates.start }, school.admin);
      // A substitute on one held Wednesday, so statement C has a past row to key.
      await owner.query(
        `UPDATE "CalendarLessonTeachers" SET role = 'SUBSTITUTE' WHERE "calendarLessonId" = (
           SELECT id FROM "CalendarLessons" WHERE "schoolId" = $1 AND "masterLessonId" = $2 AND "startsAt" <= now() ORDER BY date LIMIT 1)`,
        [school.schoolId, school.wednesday],
      );
      const held = await pastWednesdays();
      assert.ok(held >= 7, `${held} held Wednesdays`);
      await drafts.switchMode('DRAFT', school.admin);
      const before = await reads();
      await lessons.remove(school.wednesday, school.admin);
      assert.deepEqual(await reads(), before);
      const recorded = await owner.query(
        `SELECT count(*) FILTER (WHERE cl."startsAt" <= now())::int AS past, count(*) FILTER (WHERE NOT p.reconcilable AND cl."startsAt" <= now())::int AS kept
           FROM "PublicationPendingRemovals" p JOIN "CalendarLessons" cl ON cl.id = p."calendarLessonId" WHERE p."schoolId" = $1`,
        [school.schoolId],
      );
      assert.deepEqual(recorded.rows[0], { past: held, kept: held });
      // The draft state counts only what a publish will settle.
      const state = await drafts.state(school.yearId, school.admin);
      const ahead = await owner.query(
        `SELECT count(*)::int AS n FROM "PublicationPendingRemovals" p JOIN "CalendarLessons" cl ON cl.id = p."calendarLessonId"
          WHERE p."schoolId" = $1 AND cl."startsAt" > now()`,
        [school.schoolId],
      );
      assert.equal(state.pendingRemovals, ahead.rows[0].n);
    });

    await check('(pub-b) the publish of the deletion releases the held rows: they are DIRECT\'s orphans, and nothing is left pending', async () => {
      await publications.publish({ academicYearId: school.yearId, acknowledgeWarnings: true }, school.admin);
      const left = await owner.query(`SELECT count(*)::int AS n FROM "PublicationPendingRemovals" WHERE "schoolId" = $1`, [
        school.schoolId,
      ]);
      assert.equal(left.rows[0].n, 0);
      // The held Wednesdays now answer as DIRECT answers for a deleted template.
      const events = await ss12000.calendarEvents(school.schoolId, dates.start, dates.end, '500');
      const held = events.data.filter((event) => new Date(event.startTime) <= new Date() && new Date(event.startTime).getUTCDay() === 3);
      assert.ok(held.length >= 7);
      assert.ok(held.every((event) => event.activityId === null), JSON.stringify(held.slice(0, 2)));
      assert.equal((await drafts.switchMode('DIRECT', school.admin)).publishMode, 'DIRECT');
    });

    await check('(pub-e) a share link shows this week and last week, never further back', async () => {
      await publications.upsertSettings({ publicViewerEnabled: true, publicGroups: true }, school.admin);
      const link = await new PublicLinksService(api).create(
        { academicYearId: school.yearId, kind: 'GROUP', targetId: school.class7a },
        school.admin,
      );
      const view = (date: string | null) =>
        api.withPublicViewer(async (tx) => {
          const [row] = await tx.$queryRaw<{ doc: unknown }[]>`
            SELECT app.public_timetable(${tokenHashOf(link.token)}, ${null}::uuid, ${date}::date) AS "doc"`;
          return row?.doc ?? null;
        });
      const day = (offset: number) => {
        const at = new Date();
        at.setUTCDate(at.getUTCDate() + offset);
        return at.toISOString().slice(0, 10);
      };
      assert.ok(await view(null), 'today');
      assert.ok(await view(day(-7)), 'last week');
      assert.equal(await view(day(-15)), null);
      assert.equal(await view(dates.start), null);
    });
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-dagens'`, [MARKER]);
  }
}

/**
 * Bulk avbokning (20261011110000) against Postgres, in a school of its own:
 * the batch takes a class's week in one transaction with the cause the
 * timplan counts and the note pupils read; a credit is handed off and linked;
 * the reversal leaves a row whose room was booked meanwhile, restores the
 * notes and deletes the credits ahead; a second reversal is refused; and a
 * publish into a batch still in force cancels what it writes there (S7).
 */
async function batchChecks(owner: Client, api: PrismaService): Promise<void> {
  const school = await givenPublicationSchool(owner, 'avbokning');
  const { publications } = publicationServicesFor(api);
  const broadcast: string[][] = [];
  const batches = new CancellationBatchesService(api, {
    notifyLessonsChanged: async (_tx: unknown, ids: readonly string[]) => {
      broadcast.push([...ids]);
    },
  } as unknown as RealtimeService);
  const rows = async (sql: string, params: unknown[] = [school.schoolId]) => (await owner.query(sql, params)).rows;
  const week = {
    academicYearId: school.yearId,
    name: 'Prao åk 7',
    cause: 'EVENT' as const,
    fromDate: '2096-10-01',
    toDate: '2096-10-07',
    scope: 'GRADES' as const,
    minGradeLevel: 7,
    maxGradeLevel: 7,
  };
  try {
    await publications.legacyPublish({ academicYearId: school.yearId, fromDate: '2096-09-01', toDate: '2096-10-31' }, school.admin);
    // A note somebody wrote on one of the week's lessons, to be given back.
    await owner.query(
      `UPDATE "CalendarLessons" SET note = 'Ta med miniräknare' WHERE "schoolId" = $1 AND date = '2096-10-01'`,
      [school.schoolId],
    );

    await check('(pub-d) a batch takes a class\'s week in one transaction, EVENT and the note, and hands off its credits', async () => {
      const preview = await batches.preview(week, school.admin);
      // 1–7 Oct 2096: Mon 1 and Wed 3 (the school's two weekly lessons).
      assert.equal(preview.matched, 2);
      assert.deepEqual(preview.creditDates, ['2096-10-01', '2096-10-03']);
      const created = await batches.create({ ...week, expectedDigest: preview.digest, credit: { minutes: 300 } }, school.admin);
      assert.deepEqual([created.cancelled, created.credits], [2, 2]);
      const cancelled = await rows(
        `SELECT status::text, "cancelCause"::text AS cause, note FROM "CalendarLessons" WHERE "schoolId" = $1 AND date BETWEEN '2096-10-01' AND '2096-10-07' ORDER BY date`,
      );
      assert.deepEqual(cancelled, [
        { status: 'CANCELLED', cause: 'EVENT', note: 'Inställd: Prao åk 7' },
        { status: 'CANCELLED', cause: 'EVENT', note: 'Inställd: Prao åk 7' },
      ]);
      const credits = await rows(
        `SELECT c.date::text, c.minutes, c."minGradeLevel", c."maxGradeLevel" FROM "TimplanCredits" c
           JOIN "CancellationBatchCredits" l ON l."creditId" = c.id WHERE c."schoolId" = $1 ORDER BY c.date`,
      );
      assert.deepEqual(credits, [
        { date: '2096-10-01', minutes: 300, minGradeLevel: 7, maxGradeLevel: 7 },
        { date: '2096-10-03', minutes: 300, minGradeLevel: 7, maxGradeLevel: 7 },
      ]);
      assert.deepEqual(broadcast.at(-1)!.length, 2);
      // The same digest again: the rows have changed, so it is stale.
      await assert.rejects(
        batches.create({ ...week, expectedDigest: preview.digest }, school.admin),
        (error: unknown) => error instanceof ConflictException && JSON.stringify(error.getResponse()).includes('CANCELLATION_STALE'),
      );
    });

    await check('(pub-d) a publish into a batch still in force cancels what it writes there (S7)', async () => {
      // A third lesson that week, published after the batch was made.
      await owner.query(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 5, '13:00', '14:00', now())`,
        [school.schoolId, school.yearId, school.subject, school.class7a, school.teacherId],
      );
      await publications.publish(
        { academicYearId: school.yearId, validFrom: '2096-10-01', validTo: '2096-10-07', acknowledgeWarnings: true },
        school.admin,
      );
      const friday = await rows(
        `SELECT status::text, "cancelCause"::text AS cause FROM "CalendarLessons" WHERE "schoolId" = $1 AND date = '2096-10-05'`,
      );
      assert.deepEqual(friday, [{ status: 'CANCELLED', cause: 'EVENT' }]);
      const list = await batches.list(school.yearId, school.admin);
      assert.equal(list[0]!.cancelled, 3);
      assert.equal(list[0]!.addedSince, 0);
    });

    await check('(pub-d) the reversal leaves a row whose room was booked meanwhile, gives the notes back and deletes the credits ahead; once', async () => {
      const [monday] = await rows(
        `SELECT id, "startsAt", "endsAt", "roomId" FROM "CalendarLessons" WHERE "schoolId" = $1 AND date = '2096-10-01'`,
      );
      await owner.query(
        `INSERT INTO "RoomBookings" ("schoolId", "roomId", "bookedById", title, "startsAt", "endsAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, now())`,
        [school.schoolId, monday.roomId, school.teacherId, MARKER, monday.startsAt, monday.endsAt],
      );
      const [batch] = await batches.list(school.yearId, school.admin);
      const preview = await batches.reversePreview(batch!.id, school.admin);
      assert.equal(preview.reinstate, 2);
      assert.deepEqual(preview.skippedRoomTaken.map((entry) => [entry.date, entry.by]), [['2096-10-01', 'BOOKING']]);
      assert.equal(preview.creditsDeleted, 2);
      const result = await batches.reverse(batch!.id, school.admin);
      assert.equal(result.reinstate, 2);
      const after = await rows(
        `SELECT date::text, status::text, "cancelCause"::text AS cause, note FROM "CalendarLessons" WHERE "schoolId" = $1 AND date BETWEEN '2096-10-01' AND '2096-10-07' ORDER BY date`,
      );
      assert.deepEqual(after, [
        { date: '2096-10-01', status: 'CANCELLED', cause: 'EVENT', note: 'Inställd: Prao åk 7' },
        { date: '2096-10-03', status: 'SCHEDULED', cause: null, note: null },
        { date: '2096-10-05', status: 'SCHEDULED', cause: null, note: null },
      ]);
      assert.equal((await rows(`SELECT count(*)::int AS n FROM "TimplanCredits" WHERE "schoolId" = $1`))[0].n, 0);
      await assert.rejects(
        batches.reverse(batch!.id, school.admin),
        (error: unknown) => error instanceof ConflictException && JSON.stringify(error.getResponse()).includes('CANCELLATION_REVERSED'),
      );
    });

    await check('(pub-d) a teacher reads the delivered layer of a school with batches, and no batch row', async () => {
      const coverage = new TimplanCoverageService(api);
      const delivered = await coverage.delivered({ academicYearId: school.yearId, layer: 'delivered' }, school.teacher);
      assert.ok(delivered);
      const seen = await api.withRls(school.teacher, (tx) => tx.cancellationBatch.count());
      assert.equal(seen, 0);
    });
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-avbokning'`, [MARKER]);
  }
}

/**
 * The public viewer (20261011120000) against Postgres: what the one door,
 * app.public_timetable(), answers through PrismaService.withPublicViewer — no
 * principal, a 2 s statement timeout — for a class, a room and a teacher, and
 * that it answers nothing for every link that does not resolve. The payload
 * is asserted on its exact keys and searched for every pupil's name and
 * e-mail, and for the cancelled lesson's note, which must never appear.
 */
async function viewerChecks(owner: Client, api: PrismaService): Promise<void> {
  const one = async <T extends object>(sql: string, params: unknown[]): Promise<T> => (await owner.query<T>(sql, params)).rows[0];
  const school = await givenPublicationSchool(owner, 'visare');
  const links = new PublicLinksService(api);
  const { publications } = publicationServicesFor(api);
  // A second teacher, hidden later; signatures on both posts.
  const hidden = await one<{ id: string }>(
    `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
     VALUES ($1, $2, 'Skyddad', 'Lärare', 'TEACHER', gen_random_uuid(), true, now()) RETURNING id`,
    [school.schoolId, `${MARKER}-visare-hidden@example.invalid`],
  );
  await owner.query(`UPDATE "TeacherEmployments" SET signature = 'ANLI' WHERE "userId" = $1`, [school.teacherId]);
  await owner.query(
    `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", signature, "updatedAt")
     VALUES ($1, $2, $3, 100, 'SKYD', now())`,
    [school.schoolId, hidden.id, school.yearId],
  );
  // A teaching group of one pupil, named after him, and a big one.
  const pupils = (await owner.query<{ id: string; firstName: string; lastName: string; email: string }>(
    `SELECT id, "firstName", "lastName", email FROM "Users" WHERE "schoolId" = $1 AND role = 'STUDENT'`,
    [school.schoolId],
  )).rows;
  await owner.query(`UPDATE "Users" SET "firstName" = 'Ahmed', "lastName" = 'Probesson' WHERE id = $1`, [pupils[0]!.id]);
  const small = await one<{ id: string }>(
    `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "updatedAt")
     VALUES ($1, $2, 'Sva – Ahmed', 'TEACHING_GROUP', now()) RETURNING id`,
    [school.schoolId, school.yearId],
  );
  await owner.query(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES ($1, $2, $3)`, [
    school.schoolId,
    small.id,
    pupils[0]!.id,
  ]);
  const lesson = (groupId: string, day: number, start: string, end: string, teacherId: string) =>
    one<{ id: string }>(
      `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::time, $9::time, now()) RETURNING id`,
      [school.schoolId, school.yearId, school.subject, groupId, teacherId, school.room, day, start, end],
    );
  await lesson(small.id, 2, '10:00', '11:00', school.teacherId);
  const named = await lesson(school.class7a, 4, '09:00', '10:00', school.teacherId);
  await owner.query(`INSERT INTO "MasterLessonStudents" ("schoolId", "masterLessonId", "studentId") VALUES ($1, $2, $3)`, [
    school.schoolId,
    named.id,
    pupils[1]!.id,
  ]);
  await lesson(school.class7a, 5, '08:00', '09:00', hidden.id);
  // The week of Monday 1 October 2096, published.
  await publications.legacyPublish({ academicYearId: school.yearId, fromDate: '2096-10-01', toDate: '2096-10-07' }, school.admin);
  await owner.query(
    `INSERT INTO "CalendarLunches" ("schoolId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
     VALUES ($1, $2, '2096-10-01', '2096-10-01T10:30:00Z', '2096-10-01T11:00:00Z', now())`,
    [school.schoolId, school.class7a],
  ).catch(() => undefined);
  await owner.query(
    `UPDATE "CalendarLessons" SET status = 'CANCELLED', "cancelCause" = 'TEACHER_UNAVAILABLE', note = 'Läraren är sjukskriven'
      WHERE "schoolId" = $1 AND date = '2096-10-05'`,
    [school.schoolId],
  );
  const view = (token: string, target: string | null = null, date = '2096-10-03') =>
    api.withPublicViewer(async (tx) => {
      const [row] = await tx.$queryRaw<{ doc: Record<string, unknown> | null }[]>`
        SELECT app.public_timetable(${tokenHashOf(token)}, ${target}::uuid, ${date}::date) AS "doc"`;
      return row?.doc ?? null;
    });
  const secrets = (doc: unknown) => {
    const text = JSON.stringify(doc);
    for (const pupil of pupils) {
      for (const value of [pupil.email, pupil.firstName, pupil.lastName, 'Ahmed', 'Probesson']) {
        assert.ok(!text.includes(value), `the viewer leaked ${value}`);
      }
    }
    for (const value of ['sjukskriven', 'TEACHER_UNAVAILABLE', 'Skyddad', 'SKYD', 'Sva – Ahmed', 'cancelCause', 'note', 'id"']) {
      assert.ok(!text.includes(value), `the viewer leaked ${value}`);
    }
  };
  try {
    await publications.upsertSettings(
      {
        publicViewerEnabled: true,
        publicGroups: true,
        publicTeachers: true,
        publicRooms: true,
        publicTeacherDisplay: 'SIGNATURE',
      },
      school.admin,
    );
    await links.setHidden(hidden.id, true, school.admin);
    const klass = await links.create({ academicYearId: school.yearId, kind: 'GROUP', targetId: school.class7a }, school.admin);
    const room = await links.create({ academicYearId: school.yearId, kind: 'ROOM', targetId: school.room }, school.admin);
    const teacher = await links.create({ academicYearId: school.yearId, kind: 'TEACHER', targetId: school.teacherId }, school.admin);
    const index = await links.create({ academicYearId: school.yearId, kind: 'GROUP' }, school.admin);

    await check('(pub-e) a class\'s week: the whitelist\'s keys, a hidden teacher unnamed, a cancelled lesson without its cause, no pupil anywhere', async () => {
      const doc = (await view(klass.token)) as {
        days: Array<{ date: string; lessons: Array<Record<string, unknown>>; meals?: unknown[] }>;
      } & Record<string, unknown>;
      assert.ok(doc, 'the class link did not resolve');
      assert.deepEqual(Object.keys(doc).sort(), ['days', 'kind', 'school', 'title', 'week']);
      assert.deepEqual(doc.week, { from: '2096-10-01', to: '2096-10-07', isoWeek: '2096-W40' });
      assert.equal(doc.days.length, 7);
      assert.deepEqual(Object.keys(doc.days[0]!).sort(), ['date', 'lessons', 'meals']);
      const lessons = doc.days.flatMap((day) => day.lessons.map((entry) => ({ date: day.date, ...entry })));
      for (const entry of lessons) {
        assert.deepEqual(Object.keys(entry).sort(), ['cancelled', 'date', 'end', 'groups', 'room', 'start', 'subject', 'teachers']);
      }
      // Monday and Wednesday as published; Thursday's is a named pupil's (left out); Friday's teacher is hidden.
      assert.deepEqual(
        lessons.map((entry) => [entry.date, entry.start, entry.teachers, entry.cancelled]),
        [
          ['2096-10-01', '08:00', ['ANLI'], false],
          ['2096-10-03', '10:00', ['ANLI'], false],
          ['2096-10-05', '08:00', [], true],
        ],
      );
      secrets(doc);
    });

    await check('(pub-e) a room\'s week shows a named pupil\'s lesson as busy, and a one-pupil group without its name', async () => {
      const doc = (await view(room.token)) as { days: Array<{ date: string; lessons: Array<Record<string, unknown>> }> };
      const lessons = doc.days.flatMap((day) => day.lessons.map((entry) => ({ date: day.date, ...entry })));
      const thursday = lessons.find((entry) => entry.date === '2096-10-04');
      assert.deepEqual(thursday, { date: '2096-10-04', start: '09:00', end: '10:00', busy: true });
      const tuesday = lessons.find((entry) => entry.date === '2096-10-02');
      assert.deepEqual(tuesday?.groups, [null]);
      assert.ok(!('meals' in doc.days[0]!), 'a room has no meals');
      secrets(doc);
    });

    await check('(pub-e) a teacher\'s week shows only what is held as scheduled, with no cancelled field', async () => {
      const doc = (await view(teacher.token)) as { title: string; days: Array<{ lessons: Array<Record<string, unknown>> }> };
      assert.equal(doc.title, 'ANLI');
      const lessons = doc.days.flatMap((day) => day.lessons);
      assert.equal(lessons.length, 3);
      for (const entry of lessons) assert.ok(!('cancelled' in entry), 'a teacher\'s page says a lesson is cancelled');
      secrets(doc);
    });

    await check('(pub-e) an index lists classes and big enough groups only; a small group and a hidden teacher cannot be linked', async () => {
      const doc = (await view(index.token)) as { targets: Array<{ id: string; label: string }> };
      assert.deepEqual(doc.targets.map((target) => target.label), [`${MARKER} 7A`]);
      assert.ok(await view(index.token, school.class7a));
      assert.equal(await view(index.token, small.id), null);
      await assert.rejects(
        links.create({ academicYearId: school.yearId, kind: 'GROUP', targetId: small.id }, school.admin),
        (error: unknown) => JSON.stringify((error as { getResponse?: () => unknown }).getResponse?.()).includes('PUBLIC_GROUP_TOO_SMALL'),
      );
      await assert.rejects(
        links.create({ academicYearId: school.yearId, kind: 'TEACHER', targetId: hidden.id }, school.admin),
        (error: unknown) => JSON.stringify((error as { getResponse?: () => unknown }).getResponse?.()).includes('PUBLIC_TEACHER_NOT_SHOWABLE'),
      );
    });

    await check('(pub-e) a class\'s and a room\'s week name no teacher on a cancelled lesson and never a vikarie; no week outside the link\'s year', async () => {
      // Monday's lesson cancelled for the teacher's absence; Wednesday's taken by a vikarie.
      await owner.query(
        `UPDATE "CalendarLessons" SET status = 'CANCELLED', "cancelCause" = 'TEACHER_UNAVAILABLE' WHERE "schoolId" = $1 AND date = '2096-10-01'`,
        [school.schoolId],
      );
      await owner.query(
        `UPDATE "CalendarLessonTeachers" SET role = 'SUBSTITUTE'
          WHERE "calendarLessonId" IN (SELECT id FROM "CalendarLessons" WHERE "schoolId" = $1 AND date = '2096-10-03')`,
        [school.schoolId],
      );
      const week = async (token: string) => {
        const doc = (await view(token)) as { days: Array<{ date: string; lessons: Array<Record<string, unknown>> }> };
        secrets(doc);
        return new Map(doc.days.map((day) => [day.date, day.lessons.map((entry) => [entry.teachers, entry.cancelled])]));
      };
      const classWeek = await week(klass.token);
      assert.deepEqual(classWeek.get('2096-10-01'), [[[], true]]);
      assert.deepEqual(classWeek.get('2096-10-03'), [[[], false]]);
      // The room holds Monday's lesson (Wednesday's has no room).
      assert.deepEqual((await week(room.token)).get('2096-10-01'), [[[], true]]);
      // A week before the link's läsår, or after it: the one not-found.
      assert.equal(await view(room.token, null, '2019-10-14'), null);
      assert.equal(await view(klass.token, null, '2097-09-01'), null);
      assert.ok(await view(klass.token, null, '2097-06-09'));
    });

    await check('(pub-e) the link list says which links answer, by the same rule as the viewer, and why the others do not', async () => {
      const agree = async () => {
        const listed = await links.list(school.yearId, school.admin);
        const byId = new Map(listed.map((entry) => [entry.id, entry.notShownBecause]));
        const out: Record<string, string | null> = {};
        for (const [name, made] of Object.entries({ klass, room, teacher, index })) {
          const reason = byId.get(made.link.id) ?? null;
          assert.equal(reason === null, (await view(made.token)) !== null, `${name}: listed ${reason}`);
          out[name] = reason;
        }
        return out;
      };
      assert.deepEqual(await agree(), { klass: null, room: null, teacher: null, index: null });
      await owner.query(`UPDATE "TeacherEmployments" SET signature = NULL WHERE "userId" = $1`, [school.teacherId]);
      assert.equal((await agree()).teacher, 'NO_SIGNATURE');
      await owner.query(`UPDATE "TeacherEmployments" SET signature = 'ANLI' WHERE "userId" = $1`, [school.teacherId]);
      await links.setHidden(school.teacherId, true, school.admin);
      assert.equal((await agree()).teacher, 'TEACHER_HIDDEN');
      await links.setHidden(school.teacherId, false, school.admin);
      await publications.upsertSettings({ publicRooms: false }, school.admin);
      assert.equal((await agree()).room, 'SCOPE_OFF');
      await publications.upsertSettings({ publicRooms: true }, school.admin);
      await publications.upsertSettings({ publicViewerEnabled: false }, school.admin);
      assert.deepEqual(await agree(), { klass: 'VIEWER_OFF', room: 'VIEWER_OFF', teacher: 'VIEWER_OFF', index: 'VIEWER_OFF' });
      await publications.upsertSettings({ publicViewerEnabled: true }, school.admin);
    });

    await check('(pub-e) nothing for a revoked link, a scope switched off, the viewer switched off, an unknown token; and 2 s at most', async () => {
      const timeout = await api.withPublicViewer((tx) => tx.$queryRaw<{ statement_timeout: string }[]>`SHOW statement_timeout`);
      assert.equal(timeout[0]!.statement_timeout, '2s');
      await links.revoke(room.link.id, school.admin);
      assert.equal(await view(room.token), null);
      await publications.upsertSettings({ publicTeachers: false }, school.admin);
      assert.equal(await view(teacher.token), null);
      await publications.upsertSettings({ publicViewerEnabled: false }, school.admin);
      assert.equal(await view(klass.token), null);
      assert.equal(await view('A'.repeat(43)), null);
      // Without a principal the API role reads no link and no setting itself.
      const direct = await api.withPublicViewer((tx) => tx.publicTimetableLink.count());
      assert.equal(direct, 0);
    });
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1 || '-visare'`, [MARKER]);
  }
}
