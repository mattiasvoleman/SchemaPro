/**
 * Delade lokaler och lärare (20261217090000) through the real adapter
 * (prisma-adapter-probe.ts calls this). The RLS suite proves the arms and the
 * functions in psql (sections 275–279), and the e2e suite mocks
 * PrismaService; what neither shows is the gateway's half against the
 * database: the services' reads through the functions, the borrower's own
 * room made in its own transaction, and what @prisma/adapter-pg hands back
 * for an RL refusal and for the EXCLUDE that keeps two approved loans of a
 * room apart.
 *
 *   (dl-a) SharingService.view at school A and at the roller school: the
 *          other schools of the huvudman by name with the minutes between
 *          them (15, written by the roller school) and none to C; the
 *          shared teachers by the school's own rows, T with both schools,
 *          and none of U, V or W;
 *   (dl-b) putTravel: A's planner writes the figure signed with A, and the
 *          roller school's planner puts it back; a school that is not H's is
 *          the 404 SCHOOL_NOT_SIBLING; the roller school's expedition is
 *          refused by the arm's WITH CHECK, which rethrowPrismaError gives
 *          as the 403 AREA_NOT_YOURS;
 *   (dl-c) RoomLoansService.rooms and .list from both sides: the hall's two
 *          loans as A borrows them (its own room "Roller hall (lånad)", the
 *          owner's name) and as the roller school lends them;
 *   (dl-d) a request as A's planner makes A's own room for "Roller 1" and a
 *          PENDING loan, and a second one names that room again; the roller
 *          school's schemaläggare approves; an approval that meets the
 *          approved one is the 409 ROOM_LOAN_OVERLAP; A deciding is the 404
 *          ROOM_LOAN_NOT_FOUND, the expedition asking the 403
 *          ROOM_LOAN_NOT_YOURS; withdraw, revoke, and a revoke of what is not
 *          approved the 409 ROOM_LOAN_NOT_APPROVED;
 *   (dl-e) the raw forms the adapter gives: 23P01 with the constraint's name
 *          in the driver's message, an RL refusal as P2010 (not P2039, as
 *          the HM ones through withHuvudmanKeyPrincipal) with the driver's
 *          code and message, each read by roomLoanRefusal; and
 *          app.shared_teacher_busy's time and date columns as Dates, which
 *          the generator and publish (second half) read.
 *
 * On the RLS fixtures (run-rls-tests.sh first). What it writes is the loans
 * of "Roller 1" and A's own room for it, which the owner deletes before and
 * after, and the A–roller figure, which it puts back.
 */
import { strict as assert } from 'node:assert';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { RoomLoansService } from '../../src/sharing/room-loans.service';
import { roomLoanRefusal } from '../../src/sharing/sharing-errors';
import { SharingService } from '../../src/sharing/sharing.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

const T = 'fe000000-0000-4000-8000-000000002750';
const DATES = { startDate: '2030-08-19', endDate: '2031-06-13' } as const;

/** The error a call throws, or null. */
async function failure(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  return null;
}

const codeOf = (error: unknown): unknown => (error as { getResponse?: () => { code?: unknown } }).getResponse?.().code;

export async function deladeChecks(owner: Client, api: PrismaService, check: Check): Promise<void> {
  const one = async <R extends object>(sql: string, params: unknown[] = []): Promise<R | undefined> =>
    (await owner.query<R>(sql, params)).rows[0];
  const a = (await one<{ id: string }>(`SELECT id FROM "Schools" WHERE slug <> 'rls-fixture-school' ORDER BY "createdAt" LIMIT 1`))?.id;
  const m = (await one<{ id: string }>(`SELECT id FROM "Schools" WHERE slug = 'rls-roller-school'`))?.id;
  const c = (await one<{ id: string }>(`SELECT id FROM "Schools" WHERE slug = 'rls-huvudman-c'`))?.id;
  const b = (await one<{ id: string }>(`SELECT id FROM "Schools" WHERE slug = 'rls-fixture-school'`))?.id;
  assert.ok(a && m && c && b, 'the RLS fixtures have no huvudman (run run-rls-tests.sh first)');
  const aName = (await one<{ name: string }>(`SELECT name FROM "Schools" WHERE id = $1`, [a]))!.name;

  const principal = async (where: string, params: unknown[]): Promise<AuthenticatedUser> => {
    const row = await one<{ id: string; authId: string; schoolId: string; adminProfile: string; hrRead: boolean }>(
      `SELECT id, "authId", "schoolId", "adminProfile"::text AS "adminProfile", "hrRead" FROM "Users" WHERE ${where}`,
      params,
    );
    assert.ok(row, `no principal where ${where}`);
    return {
      authId: row.authId,
      role: Role.SCHOOL_ADMIN,
      userId: row.id,
      schoolId: row.schoolId,
      adminProfile: row.adminProfile as AuthenticatedUser['adminProfile'],
      hrRead: row.hrRead,
    };
  };
  // A's own administrator, the one the fixtures named on the hall's loans.
  const aPlanner = await principal(
    `"schoolId" = $1 AND role = 'SCHOOL_ADMIN' AND "isActive" AND "adminProfile" = 'FULL'
     AND "authId"::text NOT LIKE 'fe000000-%' ORDER BY "createdAt", id LIMIT 1`,
    [a],
  );
  const mFull = await principal(`"authId" = '00000000-0000-4000-8000-000000000105'`, []);
  const mPlanner = await principal(`"authId" = '00000000-0000-4000-8000-000000000107'`, []);
  const mExpedition = await principal(`"authId" = '00000000-0000-4000-8000-000000000108'`, []);

  const ids = async () => ({
    tA: (await one<{ id: string }>(`SELECT id FROM "Users" WHERE "authId" = $1 AND "schoolId" = $2`, [T, a]))!.id,
    hall: (await one<{ id: string }>(`SELECT id FROM "Rooms" WHERE "schoolId" = $1 AND name = 'Roller hall'`, [m]))!.id,
    roller1: (await one<{ id: string }>(`SELECT id FROM "Rooms" WHERE "schoolId" = $1 AND name = 'Roller 1'`, [m]))!.id,
    localHall: (await one<{ id: string }>(`SELECT id FROM "Rooms" WHERE "schoolId" = $1 AND name = 'Roller hall (lånad)'`, [a]))!.id,
  });
  const { tA, hall, roller1, localHall } = await ids();
  const pair = a < m ? [a, m] : [m, a];

  const sharing = new SharingService(api);
  const loans = new RoomLoansService(api);

  // What the probe writes, gone before it starts and after it ends.
  const sweep = async () => {
    await owner.query(`DELETE FROM "RoomLoans" WHERE "roomId" = $1`, [roller1]);
    await owner.query(`DELETE FROM "Rooms" WHERE "schoolId" = $1 AND name = 'Roller 1 (RLS Roller)'`, [a]);
    await owner.query(
      `UPDATE "SchoolTravelTimes" SET minutes = 15, "setBySchoolId" = $3 WHERE "schoolAId" = $1 AND "schoolBId" = $2`,
      [pair[0], pair[1], m],
    );
  };
  await sweep();

  try {
    await check('(dl-a) the other schools with the minutes between them, and the shared teachers by the school\'s own rows', async () => {
      const atA = await sharing.view(aPlanner);
      assert.deepEqual(atA.schools, [
        { id: c, name: 'RLS Huvudman C', travelMinutes: null, travelSetByUs: null },
        { id: m, name: 'RLS Roller', travelMinutes: 15, travelSetByUs: false },
      ]);
      const t = atA.teachers.find((teacher) => teacher.teacherId === tA);
      assert.deepEqual(t, {
        teacherId: tA,
        firstName: 'Delade',
        lastName: 'delade-t-a',
        schools: [
          { id: c, name: 'RLS Huvudman C' },
          { id: m, name: 'RLS Roller' },
        ],
      });
      const names = atA.teachers.map((teacher) => teacher.lastName);
      for (const notShared of ['delade-u-a', 'delade-v-a', 'delade-w-a']) {
        assert.ok(!names.includes(notShared), `${notShared} is listed as shared`);
      }
      assert.ok(names.includes('delade-y-a'), 'Y, shared with the roller school, is not listed');
      // Every teacher listed is a row of A's own.
      const own = await owner.query<{ id: string }>(`SELECT id FROM "Users" WHERE "schoolId" = $1 AND id = ANY ($2::uuid[])`, [
        a,
        atA.teachers.map((teacher) => teacher.teacherId),
      ]);
      assert.equal(own.rowCount, atA.teachers.length);

      const atM = await sharing.view(mFull);
      assert.equal(atM.schools.length, 2);
      assert.deepEqual(atM.schools.find((school) => school.id === a), { id: a, name: aName, travelMinutes: 15, travelSetByUs: true });
      assert.deepEqual(atM.schools.find((school) => school.id === c), { id: c, name: 'RLS Huvudman C', travelMinutes: null, travelSetByUs: null });
    });

    await check('(dl-b) the travel is written signed with the school, a school not H\'s is a 404, and the expedition is refused by the arm', async () => {
      const written = await sharing.putTravel(m, 20, aPlanner);
      assert.deepEqual(
        written.schools.find((school) => school.id === m),
        { id: m, name: 'RLS Roller', travelMinutes: 20, travelSetByUs: true },
      );
      const row = await one<{ minutes: number; setBySchoolId: string }>(
        `SELECT minutes, "setBySchoolId" FROM "SchoolTravelTimes" WHERE "schoolAId" = $1 AND "schoolBId" = $2`,
        pair,
      );
      assert.deepEqual(row, { minutes: 20, setBySchoolId: a });

      const notOurs = await failure(() => sharing.putTravel(b, 10, aPlanner));
      assert.ok(notOurs instanceof NotFoundException, `a school not H's: ${String(notOurs)}`);
      assert.equal(codeOf(notOurs), 'SCHOOL_NOT_SIBLING');

      const expedition = await failure(() => sharing.putTravel(a, 30, mExpedition));
      // Row security's WITH CHECK (42501), which rethrowPrismaError reads as the area's refusal.
      assert.ok(expedition instanceof ForbiddenException, `the expedition's write: ${String(expedition)}`);
      assert.equal(codeOf(expedition), 'AREA_NOT_YOURS');
      assert.equal(
        (await one<{ minutes: number }>(`SELECT minutes FROM "SchoolTravelTimes" WHERE "schoolAId" = $1 AND "schoolBId" = $2`, pair))!.minutes,
        20,
      );

      const back = await sharing.putTravel(a, 15, mPlanner);
      assert.deepEqual(back.schools.find((school) => school.id === a)?.travelSetByUs, true);
      assert.deepEqual(
        await one(`SELECT minutes, "setBySchoolId" FROM "SchoolTravelTimes" WHERE "schoolAId" = $1 AND "schoolBId" = $2`, pair),
        { minutes: 15, setBySchoolId: m },
      );
      // No figure to C: removing none is nothing.
      await sharing.putTravel(c, null, aPlanner);
    });

    await check('(dl-c) the rooms to ask for, and the hall\'s two loans from both sides', async () => {
      const rooms = await loans.rooms(aPlanner);
      const roller = rooms.find((school) => school.id === m);
      assert.ok(roller && roller.name === 'RLS Roller', 'the roller school offers no room to A');
      assert.deepEqual(roller.rooms.find((room) => room.id === hall), {
        id: hall,
        name: 'Roller hall',
        capacity: 60,
        roomTypeName: null,
        localRoomId: localHall,
      });
      assert.deepEqual(roller.rooms.find((room) => room.id === roller1)?.localRoomId, null);
      assert.ok(!rooms.some((school) => school.id === a), 'A is offered its own rooms');
      assert.ok(!(await loans.rooms(mFull)).some((school) => school.rooms.some((room) => room.id === localHall)), 'A\'s own room for the hall is offered');

      const borrowed = (await loans.list(aPlanner)).borrowed
        .filter((loan) => loan.room.id === localHall)
        .map((loan) => [loan.status, loan.dayOfWeek, loan.startTime, loan.endTime, loan.startDate, loan.endDate, loan.room.name, loan.school.name, loan.ownerRoomName]);
      assert.deepEqual(borrowed.sort(), [
        ['APPROVED', 2, '10:00', '11:30', '2030-08-19', '2031-06-13', 'Roller hall (lånad)', 'RLS Roller', 'Roller hall'],
        ['PENDING', 3, '13:00', '14:00', '2030-08-19', '2031-06-13', 'Roller hall (lånad)', 'RLS Roller', 'Roller hall'],
      ]);
      const lent = (await loans.list(mFull)).lent
        .filter((loan) => loan.room.id === hall)
        .map((loan) => [loan.status, loan.room.name, loan.school.id, loan.ownerRoomName]);
      assert.deepEqual(lent.sort(), [
        ['APPROVED', 'Roller hall', a, null],
        ['PENDING', 'Roller hall', a, null],
      ]);
    });

    await check('(dl-d) A asks for a room of its own making, the roller school decides, and each refusal is the one it names', async () => {
      const window = (dayOfWeek: number, startTime: string, endTime: string) => ({ dayOfWeek, startTime, endTime });
      await loans.request({ roomId: roller1, windows: [window(1, '08:00', '09:00')], ...DATES, note: ' Probe ' }, aPlanner);
      const local = await one<{ id: string; capacity: number | null }>(
        `SELECT id, capacity FROM "Rooms" WHERE "schoolId" = $1 AND name = 'Roller 1 (RLS Roller)'`,
        [a],
      );
      assert.ok(local, 'A\'s own room for Roller 1 was not made');
      await loans.request({ roomId: roller1, windows: [window(5, '08:00', '09:00')], ...DATES }, aPlanner);
      const made = await owner.query<{ id: string; dayOfWeek: number; status: string; localRoomId: string; note: string | null; requestedById: string }>(
        `SELECT id, "dayOfWeek", status::text AS status, "localRoomId", note, "requestedById" FROM "RoomLoans" WHERE "roomId" = $1 ORDER BY "dayOfWeek"`,
        [roller1],
      );
      assert.deepEqual(
        made.rows.map((row) => [row.dayOfWeek, row.status, row.localRoomId, row.note, row.requestedById]),
        [
          [1, 'PENDING', local.id, 'Probe', aPlanner.userId],
          [5, 'PENDING', local.id, null, aPlanner.userId],
        ],
      );
      assert.equal(
        (await one<{ n: string }>(`SELECT count(*)::text AS n FROM "Rooms" WHERE "schoolId" = $1 AND name LIKE 'Roller 1 (%'`, [a]))!.n,
        '1',
      );
      const monday = made.rows[0]!.id;
      const friday = made.rows[1]!.id;

      // A decides nothing of the roller school's; the expedition asks nothing.
      const byA = await failure(() => loans.decide(monday, true, aPlanner));
      assert.ok(byA instanceof NotFoundException, `A decides: ${String(byA)}`);
      assert.equal(codeOf(byA), 'ROOM_LOAN_NOT_FOUND');
      const aRoom = (await one<{ id: string }>(
        `SELECT r.id FROM "Rooms" r WHERE r."schoolId" = $1 AND NOT EXISTS (SELECT 1 FROM "RoomLoans" l WHERE l."localRoomId" = r.id) ORDER BY r.name LIMIT 1`,
        [a],
      ))!.id;
      const byExpedition = await failure(() =>
        loans.request({ roomId: aRoom, windows: [window(2, '08:00', '09:00')], ...DATES, localRoomId: roller1 }, mExpedition),
      );
      assert.ok(byExpedition instanceof ForbiddenException, `the expedition asks: ${String(byExpedition)}`);
      assert.equal(codeOf(byExpedition), 'ROOM_LOAN_NOT_YOURS');

      const approved = await loans.decide(monday, true, mPlanner);
      assert.equal(approved.lent.find((loan) => loan.id === monday)?.status, 'APPROVED');

      await loans.request({ roomId: roller1, windows: [window(1, '08:30', '09:30')], ...DATES }, aPlanner);
      const meets = (await one<{ id: string }>(`SELECT id FROM "RoomLoans" WHERE "roomId" = $1 AND status = 'PENDING' AND "dayOfWeek" = 1`, [roller1]))!.id;
      const overlap = await failure(() => loans.decide(meets, true, mPlanner));
      assert.ok(overlap instanceof ConflictException, `an approval that meets the approved one: ${String(overlap)}`);
      assert.equal(codeOf(overlap), 'ROOM_LOAN_OVERLAP');
      const declined = await loans.decide(meets, false, mPlanner);
      assert.equal(declined.lent.find((loan) => loan.id === meets)?.status, 'DECLINED');

      const withdrawn = await loans.withdraw(monday, aPlanner);
      assert.equal(withdrawn.borrowed.find((loan) => loan.id === monday)?.status, 'WITHDRAWN');
      const pendingRevoke = await failure(() => loans.revoke(friday, mFull));
      assert.ok(pendingRevoke instanceof ConflictException, `revoking a pending loan: ${String(pendingRevoke)}`);
      assert.equal(codeOf(pendingRevoke), 'ROOM_LOAN_NOT_APPROVED');
      await loans.decide(friday, true, mFull);
      const revoked = await loans.revoke(friday, mFull);
      assert.equal(revoked.lent.find((loan) => loan.id === friday)?.status, 'REVOKED');
      const again = await failure(() => loans.withdraw(friday, aPlanner));
      assert.ok(again instanceof ConflictException, `withdrawing a revoked loan: ${String(again)}`);
      assert.equal(codeOf(again), 'ROOM_LOAN_ALREADY_ENDED');
    });

    await check('(dl-e) the adapter gives 23P01 with the constraint\'s name, an RL refusal as P2010 with its code, and the busy times as Dates', async () => {
      // An approved loan to meet, then an approval over it, read raw.
      await loans.request({ roomId: roller1, windows: [{ dayOfWeek: 3, startTime: '08:00', endTime: '09:00' }], ...DATES }, aPlanner);
      await loans.request({ roomId: roller1, windows: [{ dayOfWeek: 3, startTime: '08:30', endTime: '09:30' }], ...DATES }, aPlanner);
      const wednesday = await owner.query<{ id: string }>(
        `SELECT id FROM "RoomLoans" WHERE "roomId" = $1 AND "dayOfWeek" = 3 ORDER BY "startTime"`,
        [roller1],
      );
      await loans.decide(wednesday.rows[0]!.id, true, mPlanner);
      const exclusion = await failure(() =>
        api.withRls(mPlanner, (tx) => tx.$queryRaw`SELECT app.room_loan_decide(${wednesday.rows[1]!.id}::uuid, true)`),
      );
      assert.ok(exclusion instanceof Prisma.PrismaClientKnownRequestError, `23P01 came back as ${String(exclusion)}`);
      const cause = (exclusion.meta as { driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string } } })
        ?.driverAdapterError?.cause;
      assert.equal(cause?.originalCode, '23P01', `23P01 came back as ${exclusion.code} ${JSON.stringify(exclusion.meta)}`);
      assert.match(cause?.originalMessage ?? '', /RoomLoans_a_room_is_lent_once/);

      // An RL refusal: P2010 ("Raw query failed") through $queryRaw and
      // $executeRaw alike, the code and message in the driver's cause, which
      // roomLoanRefusal reads first.
      for (const read of ['query', 'execute'] as const) {
        const refused = await failure(() =>
          api.withRls(aPlanner, (tx) =>
            read === 'query'
              ? tx.$queryRaw`SELECT app.room_loan_decide(${wednesday.rows[1]!.id}::uuid, true)::text`
              : tx.$executeRaw`SELECT app.room_loan_decide(${wednesday.rows[1]!.id}::uuid, true)`,
          ),
        );
        assert.ok(refused instanceof Prisma.PrismaClientKnownRequestError, `RL404 (${read}) came back as ${String(refused)}`);
        const rl = (refused.meta as { driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string } } })
          ?.driverAdapterError?.cause;
        assert.equal(refused.code, 'P2010', `RL404 (${read}) came back as ${refused.code}: ${refused.message}`);
        assert.deepEqual([rl?.originalCode, rl?.originalMessage], ['RL404', 'ROOM_LOAN_NOT_FOUND']);
        const mapped = roomLoanRefusal(refused);
        assert.ok(mapped instanceof NotFoundException, `RL404 (${read}) mapped to ${String(mapped)}`);
      }
      assert.ok(roomLoanRefusal(exclusion) instanceof ConflictException);
      assert.equal(codeOf(roomLoanRefusal(exclusion)), 'ROOM_LOAN_OVERLAP');

      const busy = await api.withRls(aPlanner, (tx) =>
        tx.$queryRaw<Array<{ teacher_id: string; school_id: string; day_of_week: number; start_time: Date; end_time: Date; recurrence: string; start_date: Date; end_date: Date; travel_minutes: number | null }>>`
          SELECT * FROM app.shared_teacher_busy('2030-08-01'::date, '2031-07-31'::date) WHERE teacher_id = ${tA}::uuid ORDER BY day_of_week`,
      );
      assert.deepEqual(
        busy.map((row) => [
          row.school_id,
          row.day_of_week,
          row.start_time instanceof Date ? row.start_time.toISOString() : `not a Date: ${String(row.start_time)}`,
          row.end_time instanceof Date ? row.end_time.toISOString().slice(11, 16) : String(row.end_time),
          row.recurrence,
          row.start_date instanceof Date ? row.start_date.toISOString().slice(0, 10) : `not a Date: ${String(row.start_date)}`,
          row.end_date instanceof Date ? row.end_date.toISOString().slice(0, 10) : String(row.end_date),
          row.travel_minutes,
        ]),
        [
          [m, 2, '1970-01-01T10:00:00.000Z', '11:00', 'ALL_WEEKS', '2030-08-15', '2031-06-15', 15],
          [m, 4, '1970-01-01T13:00:00.000Z', '14:00', 'ODD_WEEKS', '2030-09-02', '2030-12-20', 15],
          [m, 5, '1970-01-01T08:00:00.000Z', '09:00', 'ALL_WEEKS', '2030-08-15', '2031-06-15', 15],
        ],
      );
    });
  } finally {
    await sweep();
  }
}
