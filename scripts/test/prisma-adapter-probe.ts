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
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../../src/database/prisma.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { readYearBoundsForShare } from '../../src/resources/academic-year-bounds';
import { AcademicYearsService } from '../../src/resources/academic-years.service';
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
import type { CreateRoomBookingDto } from '../../src/room-bookings/dto/room-booking.dto';
import { RoomBookingsService } from '../../src/room-bookings/room-bookings.service';

/** Marks every row the probe writes that has a text column to mark. */
const MARKER = 'prisma-adapter-probe';

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

  return {
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
