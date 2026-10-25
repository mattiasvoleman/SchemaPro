/**
 * The adapter probe's checks for the rastvaktsschema (20261207090000), through
 * the real services on the API's role and real Postgres as CI runs it — the
 * part the unit specs and the e2e cannot see, since both run on the Prisma
 * mock. In a school of its own (slug <marker>-rastvakt), swept whole before
 * and after:
 *
 *   rv-a  the clash question is a Prisma filter on @db.Time columns, the only
 *         lt/gt on a time column in the gateway: through the adapter it finds
 *         the pass a new one shares a minute with and names it (409
 *         SUPERVISION_SHIFT_CLASH), lets the pass that starts the minute the
 *         other ends through, and, with the question skipped, the table's
 *         EXCLUDE refuses the same pass and the service reads the driver's
 *         23P01 as the same 409;
 *   rv-b  the schedule's read records whose rastvakt and ram it handed out
 *         in the läslogg (EMPLOYMENT);
 *   rv-c  the load reads the passes with one statement joining their areas
 *         under RLS: the admin's report charges each teacher their passes and
 *         drops a ram the passes cover, a teacher's own report (the `_count`
 *         and the join as a TEACHER) carries their line and nobody else's,
 *         and a pupil cannot be made of a teacher who holds a pass;
 *   rv-d  the schedule's one statement (areas, passes and each teacher's
 *         state) and the lessons a pass runs during, through the adapter:
 *         the teacher's lesson is named beside the pass, and a teacher
 *         deactivated today is so from the school's date, gets no new pass,
 *         and their own pass can still be ended;
 *   rv-e  Rastvakt i vardagen (20261210090000): an absent rastvakt's pass
 *         reaches the board and its candidates through the adapter, a
 *         vikarie's decision is written (a @db.Date and two instants) and
 *         read back COVERED, the vikarie's week (their own arm, as a
 *         TEACHER) and the absent teacher's both say so, the pass does not
 *         move under it, the vikarie is told with the new notice types, the
 *         cover rules hold the pass in the vikarie's day (the relation
 *         filter), and an undo tells them it is off.
 *
 * And in rv-a, the dates a pass is stored with are on its weekday: a typed
 * Friday Till is the Wednesday before, a Tuesday Från the Wednesday after.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { StaffingLoadService } from '../../src/staffing/staffing-load.service';
import type { CalendarLessonsService } from '../../src/calendar/calendar-lessons.service';
import { readPersonDays } from '../../src/cover/cover-context';
import { CoverService } from '../../src/cover/cover.service';
import { SupervisionCoverService } from '../../src/cover/supervision-cover.service';
import { NotificationDeliveryService } from '../../src/notifications/notification-delivery.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import {
  SUPERVISION_SHIFT_CLASH,
  SUPERVISION_SHIFT_HAS_COVERS,
  SUPERVISION_TEACHER_INACTIVE,
  SupervisionService,
} from '../../src/supervision/supervision.service';
import type { SupabaseAdminService } from '../../src/users/supabase-admin.service';
import { UsersService } from '../../src/users/users.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function rastvaktSlug(marker: string): string {
  return `${marker}-rastvakt`;
}

export async function sweepRastvaktSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [rastvaktSlug(marker)]);
}

/** The 409's body, whatever Nest wrapped it in. */
const codeOf = (error: unknown): unknown =>
  (error as { getResponse?: () => { code?: unknown } }).getResponse?.().code;

export async function rastvaktChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepRastvaktSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  try {
    const s = (
      await one<{ id: string }>(
        `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
        [`${marker} rastvakt`, rastvaktSlug(marker)],
      )
    ).id;
    const year = (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
         VALUES ($1, 'Rv 2030/31', DATE '2030-08-19', DATE '2031-06-13', true, now()) RETURNING id`,
        [s],
      )
    ).id;
    const person = async (role: string, label: string, adminProfile: string | null = null) => {
      const authId = randomUUID();
      const row = await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
         VALUES ($1, $2, $3, 'Probe', $4::"UserRole", $5::"AdminProfile", $6, true, now()) RETURNING id`,
        [s, `${marker}-rastvakt-${label}@example.invalid`, label, role, adminProfile, authId],
      );
      return { id: row.id, authId };
    };
    // One rast for every stage, every day: the yard's break.
    await owner.query(
      `INSERT INTO "Rasts" ("schoolId", name, "minGradeLevel", "maxGradeLevel", "startTime", "endTime", "updatedAt")
       VALUES ($1, 'Rv förmiddagsrast', 0, 12, '10:00', '10:20', now())`,
      [s],
    );
    const admin = await person('SCHOOL_ADMIN', 'admin', 'FULL');
    const anna = await person('TEACHER', 'anna');
    const bo = await person('TEACHER', 'bo');
    const asAdmin: AuthenticatedUser = { authId: admin.authId, role: Role.SCHOOL_ADMIN, userId: admin.id, schoolId: s, channel: 'WEB', adminProfile: 'FULL' };
    const asAnna: AuthenticatedUser = { authId: anna.authId, role: Role.TEACHER, userId: anna.id, schoolId: s, channel: 'APP' };
    const supervision = new SupervisionService(api);
    const garden = await supervision.createArea({ name: 'Rv Skolgården' }, asAdmin);
    const hall = await supervision.createArea({ name: 'Rv Matsalen', duringRasts: false, duringLunch: true, countsAsTeaching: true }, asAdmin);
    // Anna on the yard every Monday 10:00–10:20, and in the hall on autumn Wednesdays.
    await supervision.createShift({ academicYearId: year, areaId: garden.id, userId: anna.id, dayOfWeek: 1, startTime: '10:00', endTime: '10:20' }, asAdmin);
    const autumn = await supervision.createShift(
      { academicYearId: year, areaId: hall.id, userId: anna.id, dayOfWeek: 3, startTime: '11:30', endTime: '12:00', validTo: '2030-12-20' },
      asAdmin,
    );

    await check('(rv-a) the clash on @db.Time is found through the adapter and named, the minute after is free, and the EXCLUDE refuses what the question would have', async () => {
      const clash = { academicYearId: year, areaId: hall.id, userId: anna.id, dayOfWeek: 1, startTime: '10:10', endTime: '10:30' };
      await assert.rejects(supervision.createShift(clash, asAdmin), (error: unknown) => {
        assert.equal(codeOf(error), SUPERVISION_SHIFT_CLASH);
        assert.match(String((error as Error).message), /Rv Skolgården måndag 10:00–10:20/);
        return true;
      });
      // A December Wednesday clashes with the autumn's; one from January does not.
      await assert.rejects(
        supervision.createShift({ ...clash, dayOfWeek: 3, startTime: '11:45', endTime: '12:15', validFrom: '2030-12-02', validTo: '2030-12-31' }, asAdmin),
        (error: unknown) => codeOf(error) === SUPERVISION_SHIFT_CLASH,
      );
      const january = await supervision.createShift({ ...clash, dayOfWeek: 3, startTime: '11:45', endTime: '12:15', validFrom: '2031-01-07' }, asAdmin);
      // Stored on the Wednesday: Till Friday 20 December is the 18th, Från Tuesday 7 January the 8th.
      assert.equal(autumn.validTo, '2030-12-18');
      assert.equal(january.validFrom, '2031-01-08');
      const after = await supervision.createShift({ ...clash, startTime: '10:20', endTime: '10:40' }, asAdmin);
      assert.deepEqual([after.startTime, after.endTime], ['10:20', '10:40']);
      // Past the question, the table: the same 409 from the driver's 23P01.
      const unguarded = Object.assign(Object.create(Object.getPrototypeOf(supervision)), supervision, {
        assertOnePlace: async () => undefined,
      }) as SupervisionService;
      await assert.rejects(unguarded.createShift(clash, asAdmin), (error: unknown) => codeOf(error) === SUPERVISION_SHIFT_CLASH);
      await supervision.removeShift(after.id, asAdmin);
      await supervision.removeShift(january.id, asAdmin);
      const [{ n }] = (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM "SupervisionShifts" WHERE "schoolId" = $1`, [s])).rows;
      assert.equal(n, 2);
    });

    await check('(rv-b) the schedule’s read records whose rastvakt and ram it handed out (EMPLOYMENT), in its own transaction', async () => {
      await owner.query(
        `INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "updatedAt")
         VALUES ($1, $2, $3, 'RASTVAKT', 'Rastvakt', 60, now()), ($1, $4, $3, 'RASTVAKT', 'Rastvakt', 40, now())`,
        [s, anna.id, year, bo.id],
      );
      const rota = await supervision.rota(year, asAdmin);
      assert.deepEqual(rota.teachers.map((row) => row.userId).sort(), [anna.id, bo.id].sort());
      // The yard's rast is watched on Mondays alone: Tuesday to Friday are short, all year.
      assert.deepEqual(
        rota.gaps.filter((gap) => gap.areaId === garden.id).map((gap) => [gap.dayOfWeek, gap.fromYearStart, gap.toYearEnd]),
        [
          [2, true, true],
          [3, true, true],
          [4, true, true],
          [5, true, true],
        ],
      );
      const recorded = await owner.query<{ subjects: string[] }>(
        `SELECT "subjectIds"::text[] AS subjects FROM "PersonalDataAccess" WHERE "schoolId" = $1 AND "actorId" = $2 AND kind = 'EMPLOYMENT'`,
        [s, admin.id],
      );
      assert.deepEqual(recorded.rows.flatMap((row) => row.subjects).sort(), [anna.id, bo.id].sort());
    });

    await check('(rv-c) the load joins the passes to their areas under RLS: the admin sees each teacher’s, a teacher their own, the ram the passes cover counts no more, and a teacher holding a pass is no pupil', async () => {
      const load = new StaffingLoadService(api);
      const report = await load.load(year, 'planned', asAdmin);
      const annaRow = report.teachers.find((row) => row.userId === anna.id)!;
      const boRow = report.teachers.find((row) => row.userId === bo.id)!;
      // Anna: 20 every week and 30 in the autumn's weeks, her ram gone; the hall counts as teaching.
      assert.ok(annaRow.dutyMinutesPerWeek > 20 && annaRow.dutyMinutesPerWeek < 50, JSON.stringify(annaRow));
      assert.ok(annaRow.countedDutyMinutesPerWeek > 0 && annaRow.countedDutyMinutesPerWeek < 30, JSON.stringify(annaRow));
      // Bo has no pass: his uppdrag counts as it always did.
      assert.equal(boRow.dutyMinutesPerWeek, 40);
      assert.deepEqual(
        report.supervision?.teachers.map((row) => [row.userId, row.shiftCount, row.ramMinutesPerWeek, row.ramCountedMinutesPerWeek]),
        [[anna.id, 2, 60, 0]],
      );
      const own = await load.load(year, 'planned', asAnna);
      assert.deepEqual(own.supervision?.teachers.map((row) => row.userId), [anna.id]);
      assert.equal(own.teachers[0]!.dutyMinutesPerWeek, annaRow.dutyMinutesPerWeek);
      // Bo, a teacher with no pass, reads no line: his `_count` is 0 and nothing more is asked.
      const asBo: AuthenticatedUser = { authId: bo.authId, role: Role.TEACHER, userId: bo.id, schoolId: s, channel: 'APP' };
      assert.equal((await load.load(year, 'planned', asBo)).supervision, null);
      const users = new UsersService(api, {} as SupabaseAdminService);
      await assert.rejects(
        users.update(anna.id, { role: Role.STUDENT } as never, asAdmin),
        /2 rastvaktspass finns registrerade/,
      );
    });

    await check('(rv-d) the schedule’s one statement and the lessons a pass runs during come through the adapter, and a teacher deactivated today is so from the school’s date', async () => {
      // A lesson of Anna's, Mondays 10:00–11:00: her Monday on the yard runs during it.
      const subject = (
        await one<{ id: string }>(
          `INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'Rv Matematik', 'RVMA', now()) RETURNING id`,
          [s],
        )
      ).id;
      const group = (
        await one<{ id: string }>(
          `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES ($1, $2, 'Rv 8A', 8, now()) RETURNING id`,
          [s, year],
        )
      ).id;
      await owner.query(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 1, '10:00', '11:00', now())`,
        [s, year, subject, group, anna.id],
      );
      const rota = await supervision.rota(year, asAdmin);
      const monday = rota.shifts.find((row) => row.userId === anna.id && row.dayOfWeek === 1)!;
      assert.deepEqual(monday.lessonClashes, [{ subject: 'Rv Matematik', group: 'Rv 8A', dayOfWeek: 1, startTime: '10:00', endTime: '11:00' }]);
      assert.deepEqual([monday.startTime, monday.endTime, monday.validFrom, monday.inactiveFrom], ['10:00', '10:20', null, null]);
      assert.deepEqual(
        rota.areas.map((area) => [area.name, area.shiftCount]),
        [
          ['Rv Matsalen', 1],
          ['Rv Skolgården', 1],
        ],
      );
      // Bo is deactivated today.
      const tuesday = await supervision.createShift(
        { academicYearId: year, areaId: garden.id, userId: bo.id, dayOfWeek: 2, startTime: '10:00', endTime: '10:20' },
        asAdmin,
      );
      await owner.query(`UPDATE "Users" SET "isActive" = false, "updatedAt" = now() WHERE id = $1`, [bo.id]);
      const today = (await one<{ day: string }>(`SELECT (now() AT TIME ZONE 'Europe/Stockholm')::date::text AS day`)).day;
      const after = await supervision.rota(year, asAdmin);
      assert.equal(after.shifts.find((row) => row.id === tuesday.id)!.inactiveFrom, today);
      await assert.rejects(
        supervision.createShift({ academicYearId: year, areaId: garden.id, userId: bo.id, dayOfWeek: 4, startTime: '10:00', endTime: '10:20' }, asAdmin),
        (error: unknown) => codeOf(error) === SUPERVISION_TEACHER_INACTIVE,
      );
      // His own pass is ended all the same, on its weekday.
      const ended = await supervision.updateShift(tuesday.id, { validTo: '2031-01-16' }, asAdmin);
      assert.deepEqual([ended.validTo, ended.inactiveFrom], ['2031-01-14', today]);
    });

    await check('(rv-e) an absent rastvakt’s pass reaches the board and its candidates, a vikarie is booked and read back, both weeks say so, the pass stays put, the vikarie is told, the cover rules hold it, and an undo tells them it is off', async () => {
      const cilla = await person('TEACHER', 'cilla');
      const asCilla: AuthenticatedUser = { authId: cilla.authId, role: Role.TEACHER, userId: cilla.id, schoolId: s, channel: 'APP' };
      // Anna is away all of Monday 2 September 2030; her pass on the yard runs 10:00–10:20 (08:00 UTC).
      const absence = (
        await one<{ id: string }>(
          `INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt")
           VALUES ($1, $2, timestamptz '2030-09-01 22:00 UTC', timestamptz '2030-09-02 22:00 UTC') RETURNING id`,
          [s, anna.id],
        )
      ).id;
      const notifications = new NotificationsService(api, new NotificationDeliveryService(api));
      const realtime = { notifyCoverBoardChanged: () => undefined, notifyLessonsChanged: async () => undefined } as unknown as RealtimeService;
      const cover = new CoverService(api, realtime, notifications, {} as CalendarLessonsService);
      const passes = new SupervisionCoverService(api, cover);

      const board = await cover.board('2030-09-02', '2030-09-02', asAdmin);
      assert.equal(board.supervision.length, 1, JSON.stringify(board.supervision));
      const [item] = board.supervision;
      assert.deepEqual(
        [item!.absentTeacherId, item!.absenceId, item!.areaId, item!.startsAt, item!.endsAt, item!.status],
        [anna.id, absence, garden.id, '2030-09-02T08:00:00.000Z', '2030-09-02T08:20:00.000Z', 'OPEN'],
      );
      const shiftId = item!.shiftId;

      const candidates = await passes.candidates(shiftId, '2030-09-02', asAdmin);
      assert.deepEqual(candidates.candidates.map((row) => row.userId), [cilla.id]);
      assert.deepEqual(
        candidates.excluded.find((row) => row.userId === anna.id)?.codes.map((code) => code.code),
        ['ON_LESSON', 'ABSENT'],
      );

      await passes.decide(shiftId, '2030-09-02', { absenceId: absence, kind: 'SUBSTITUTE', substituteId: cilla.id, expected: 'OPEN' }, asAdmin);
      const stored = await one<{ date: string; startsAt: Date; endsAt: Date; decision: string }>(
        `SELECT date::text AS date, "startsAt", "endsAt", decision::text AS decision FROM "SupervisionCovers" WHERE "shiftId" = $1`,
        [shiftId],
      );
      assert.deepEqual(
        [stored.date, stored.startsAt.toISOString(), stored.endsAt.toISOString(), stored.decision],
        ['2030-09-02', '2030-09-02T08:00:00.000Z', '2030-09-02T08:20:00.000Z', 'SUBSTITUTE'],
      );
      const covered = await cover.board('2030-09-02', '2030-09-02', asAdmin);
      assert.deepEqual([covered.supervision[0]!.status, covered.supervision[0]!.substituteId], ['COVERED', cilla.id]);

      // Cilla's week, read as herself: the pass she takes, and nobody's name.
      const hers = await supervision.week('2030-09-02', '2030-09-08', asCilla);
      assert.deepEqual(
        hers.passes.map((row) => [row.kind, row.date, row.areaName, row.handover]),
        [['COVER', '2030-09-02', 'Rv Skolgården', null]],
      );
      // Anna's: the Monday handed over, the autumn's Wednesday in the hall hers.
      const annas = await supervision.week('2030-09-02', '2030-09-08', asAnna);
      assert.deepEqual(
        annas.passes.map((row) => [row.kind, row.date, row.areaName, row.handover]),
        [
          ['OWN', '2030-09-02', 'Rv Skolgården', 'SUBSTITUTE'],
          ['OWN', '2030-09-04', 'Rv Matsalen', null],
        ],
      );

      await assert.rejects(
        supervision.updateShift(shiftId, { startTime: '10:05' }, asAdmin),
        (error: unknown) => codeOf(error) === SUPERVISION_SHIFT_HAS_COVERS,
      );

      // The cover rules hold the pass in Cilla's day: the OR's relation filter through the adapter.
      const day = await api.withRls(asAdmin, (tx) =>
        readPersonDays(tx, { date: '2030-09-02', timezone: 'Europe/Stockholm', academicYearId: year, userIds: [cilla.id] }),
      );
      assert.deepEqual(
        day.days.get(cilla.id)!.supervision!.map((pass) => [new Date(pass.start).toISOString(), new Date(pass.end).toISOString()]),
        [['2030-09-02T08:00:00.000Z', '2030-09-02T08:20:00.000Z']],
      );

      await passes.undo(shiftId, '2030-09-02', asAdmin);
      const reopened = await cover.board('2030-09-02', '2030-09-02', asAdmin);
      assert.equal(reopened.supervision[0]!.status, 'OPEN');
      // Told twice, with the new types and the place and the time, no name.
      const told = await owner.query<{ type: string; meta: Record<string, unknown> }>(
        `SELECT type::text AS type, meta FROM "Notifications" WHERE "userId" = $1 ORDER BY "createdAt", type`,
        [cilla.id],
      );
      assert.deepEqual(
        told.rows.map((row) => [row.type, row.meta['areaName'], row.meta['startsAt']]),
        [
          ['SUPERVISION_COVER', 'Rv Skolgården', '2030-09-02T08:00:00.000Z'],
          ['SUPERVISION_COVER_WITHDRAWN', 'Rv Skolgården', '2030-09-02T08:00:00.000Z'],
        ],
      );
      assert.deepEqual(Object.keys(told.rows[0]!.meta).sort(), ['areaName', 'endsAt', 'startsAt']);
    });
  } finally {
    await sweepRastvaktSchool(owner, marker);
  }
}
