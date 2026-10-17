/**
 * The adapter probe's checks for SS12000-närvaro (20261114090000): the
 * provider's /attendances and /absences through the real services on the
 * API's role and real Postgres as CI runs it, with a local TLS mock webhook
 * receiver (never a real consumer). In a school of its own (slug
 * <marker>-ss12000-narvaro), swept whole before and after:
 *
 *   nv-a  off by default: a key with both scopes is 403 NOT_SHARED, its
 *         service principal reads no row of either table and the provider's
 *         two read functions answer nothing; and the school's changes write
 *         no version and no tombstone of attendance while it does not share;
 *   nv-b  the administrator decides through AttendanceSharingController, the
 *         row stamped with who and when; a teacher neither reads nor writes
 *         a decision; no decision is ever changed or removed (NV409), nor
 *         moved with its decider to another school;
 *   nv-c  shared: S1-shaped Attendances with the närvarorapport's minutes
 *         and Absences with their type, no note, reason or type of report,
 *         read through app.ss12000_attendances and app.ss12000_absences while
 *         the tables stay empty to the service principal; the student filter,
 *         the page token and the lookup; a key without the scope and a
 *         revoked key read no row; and calendarEvents?expand=attendance
 *         embeds the lesson's attendance;
 *   nv-d  every read is in the läslogg as the key: ATTENDANCE, a reported
 *         absence as ABSENCE_REPORTS, a granted leave's day as LEAVE_REQUESTS;
 *   nv-e  meta.modified moves with a status, the lesson's times, a relink and
 *         the school's timezone, and not with a note or a room; only a
 *         decision writes grantedLeave (NV403 for a guardian);
 *   nv-f  a pupil who leaves is buried with their attendance and absences,
 *         and comes back with them; a deleted record is buried;
 *   nv-g  gallring's night deletes what the school's periods say, and
 *         /deletedEntities serves exactly what it deleted;
 *   nv-h  a subscription to Attendance is told of a change while the school
 *         shares, and not after it stops; no new one is made then;
 *   nv-i  the functions behind it are nobody's to call but the API's
 *         questions and two reads, which answer nothing outside a service
 *         principal, and PostgREST's role may call none of them;
 *   nv-j  a school that stops and starts again between two reads of an
 *         integration: while it is stopped an unfiltered /deletedEntities
 *         still answers every category, the person who left and what went
 *         of attendance and absence by id, never what was reported and
 *         went within the stop (with the person or not); afterwards the next incremental
 *         read from before the stop reads what was written meanwhile and
 *         nothing that went, /deletedEntities lists what went (a purge, a
 *         departed pupil), and a subscriber is told;
 *   nv-k  a start decided while a notice claimed during the stop is in
 *         flight, settled after it: the next tick still tells the start,
 *         once;
 *   nv-l  a register save at a sharing school while an SS12000 apply links
 *         its pupils in the opposite order: the save waits for the apply
 *         (app.attendance_recording_waits_for_sync) and both go through,
 *         where each would otherwise hold a version the other waits for;
 *   nv-m  that wait ends after about 5 s with 409 ATTENDANCE_SYNC_IN_PROGRESS
 *         and nothing written, and a sharing decision waits for a save
 *         already writing.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { ConsoleLogger, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { AttendanceService } from '../../src/attendance/attendance.service';
import type { PrismaService } from '../../src/database/prisma.service';
import { GallringJob } from '../../src/gallring/gallring.job';
import { AttendanceSharingController } from '../../src/integration/attendance-sharing.controller';
import { IntegrationKeysController } from '../../src/integration/integration.controller';
import type { ClientOptions } from '../../src/integration/ss12000-sync/client';
import { sqlStateOf } from '../../src/integration/ss12000-sync/errors';
import { Ss12000Outbound, Ss12000Secrets } from '../../src/integration/ss12000-sync/ss12000-sync.providers';
import type { Scope } from '../../src/integration/ss12000-v2/scopes';
import { Ss12000V2Service, type V2Caller } from '../../src/integration/ss12000-v2/ss12000-v2.service';
import { Ss12000SubscriptionsService } from '../../src/integration/ss12000-v2/subscriptions.service';
import { Ss12000WebhookDeliveryService } from '../../src/integration/ss12000-v2/webhook-delivery.service';
import { JobRunner } from '../../src/jobs/job-runner';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { SupabaseAdminService } from '../../src/users/supabase-admin.service';
import { checkSchema } from '../../test/utils/s1-contract';
import { makeTestTls } from '../../test/utils/test-tls';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

const NOTE = 'probe: Karin har influensa och tandläkartid';
const FULL: Scope[] = ['attendances.read', 'absences.read', 'persons.read', 'calendarEvents.read', 'subscriptions.write'];

export function ss12000NarvaroSlug(marker: string): string {
  return `${marker}-ss12000-narvaro`;
}

export async function sweepSs12000NarvaroSchool(owner: Client, marker: string): Promise<void> {
  // The decisions are append-only, and a school's deletion cascades to them as a referential action.
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [ss12000NarvaroSlug(marker)]);
}

class ProbeOutbound extends Ss12000Outbound {
  constructor(private readonly ca: string) {
    super();
  }
  override clientOptions(): ClientOptions {
    return { policy: { allowLoopback: true, ca: this.ca } };
  }
}

export async function ss12000NarvaroChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepSs12000NarvaroSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;
  const day = (offset: number) => {
    const date = new Date(`${today}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 15));
  // A tombstone is dated by the database's clock; under load a container's
  // runs tens or hundreds of milliseconds off the host's, so every "after"
  // this probe asks with is the database's own.
  const dbNow = async () => (await one<{ t: Date }>(`SELECT clock_timestamp() AS t`)).t.toISOString();

  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${marker} ss12000 närvaro`, ss12000NarvaroSlug(marker)],
  );
  const s = school.id;
  const yearOf = (name: string, from: number, to: number, active: boolean) =>
    one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
       VALUES ($1, $2, $3::date, $4::date, $5, now()) RETURNING id`,
      [s, `${marker} ${name}`, day(from), day(to), active],
    );
  const past = await yearOf('förra året', -800, -430, false);
  const year = await yearOf('i år', -60, 240, true);
  const future = await yearOf('nästa år', 300, 600, false);
  const groupOf = (yearId: string, name: string, grade: number) =>
    one<{ id: string }>(
      `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', $4, now()) RETURNING id`,
      [s, yearId, name, grade],
    );
  const oldClass = await groupOf(past.id, '6A', 6);
  const klass = await groupOf(year.id, '7A', 7);
  const nextClass = await groupOf(future.id, '8A', 8);
  const person = (role: string, first: string, last: string, groupId: string | null = null) =>
    one<{ id: string; authId: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::"UserRole", gen_random_uuid(), true, $6, now()) RETURNING id, "authId"`,
      [s, `${marker}-nv-${randomUUID()}@example.invalid`, first, last, role, groupId],
    );
  const adminRow = await person('SCHOOL_ADMIN', 'Rolf', 'Rektor');
  const teacherRow = await person('TEACHER', 'Tove', 'Lärare');
  const guardianRow = await person('GUARDIAN', 'Gun', 'Vårdnadshavare');
  const pupil = await person('STUDENT', 'Palle', 'Girgensohn', klass.id);
  const classmate = await person('STUDENT', 'Petra', 'Elev', klass.id);
  const leaver = await person('STUDENT', 'Per', 'Slutar', klass.id);
  await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3)`, [s, guardianRow.id, pupil.id]);
  // An administrator is a full one (Roller i skolan): the decision is the decisions'.
  const as = (row: { id: string; authId: string }, role: Role): AuthenticatedUser => ({
    authId: row.authId,
    userId: row.id,
    schoolId: s,
    role,
    ...(role === Role.SCHOOL_ADMIN ? { adminProfile: 'FULL' as const } : {}),
  });
  const admin = as(adminRow, Role.SCHOOL_ADMIN);
  const teacher = as(teacherRow, Role.TEACHER);
  const guardian = as(guardianRow, Role.GUARDIAN);

  const subject = await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, 'Matematik', now()) RETURNING id`, [s]);
  const room = await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, capacity, "updatedAt") VALUES ($1, 'Sal 1', 30, now()) RETURNING id`, [s]);
  const lessonOf = (groupId: string, date: string) =>
    one<{ id: string }>(
      `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, note, "updatedAt")
       VALUES ($1, $2, $3, $4::date, $5::timestamptz, $5::timestamptz + interval '60 minutes', 'SCHEDULED', $6, now()) RETURNING id`,
      [s, subject.id, groupId, date, `${date}T07:00:00Z`, NOTE],
    );
  const lesson = await lessonOf(klass.id, day(-2));
  const oldLesson = await lessonOf(oldClass.id, day(-500));
  const futureLesson = await lessonOf(nextClass.id, day(330));
  const record = (lessonId: string, studentId: string, status: string) =>
    one<{ id: string }>(
      `INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "recordedById", "recordedAt", note, "updatedAt")
       VALUES ($1, $2, $3, $4::"AttendanceStatus", $5, now(), $6, now()) RETURNING id`,
      [s, lessonId, studentId, status, teacherRow.id, NOTE],
    );
  const present = await record(lesson.id, pupil.id, 'PRESENT');
  const late = await record(lesson.id, classmate.id, 'LATE');
  const leaving = await record(lesson.id, leaver.id, 'EXCUSED');
  const old = await record(oldLesson.id, pupil.id, 'ABSENT');
  const ahead = await record(futureLesson.id, pupil.id, 'ABSENT');
  const report = (studentId: string, reporter: string, date: string, type: string, note: string, grantedLeave: boolean, start: string | null = null, end: string | null = null) =>
    one<{ id: string }>(
      `INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date, "startTime", "endTime", type, note, "grantedLeave")
       VALUES ($1, $2, $3, $4::date, $5::time, $6::time, $7::"AbsenceReportType", $8, $9) RETURNING id`,
      [s, studentId, reporter, date, start, end, type, note, grantedLeave],
    );
  const sick = await report(pupil.id, guardianRow.id, day(-2), 'SICK', NOTE, false);
  const hours = await report(classmate.id, classmate.id, day(-1), 'APPOINTMENT', NOTE, false, '08:00', '10:00');
  const granted = await report(classmate.id, adminRow.id, day(5), 'OTHER', 'Approved leave', true);
  const oldReport = await report(pupil.id, guardianRow.id, day(-230), 'SICK', NOTE, false);

  const keyOf = (name: string, scopes: Scope[], revoked = false) =>
    one<{ id: string }>(
      `INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash", scopes, "revokedAt") VALUES ($1, $2, $3, $4::text[], $5) RETURNING id`,
      [s, name, `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`, scopes, revoked ? new Date() : null],
    );
  const key = await keyOf('probe närvaro', FULL);
  const narrow = await keyOf('probe utan närvaro', ['persons.read', 'calendarEvents.read']);
  const revoked = await keyOf('probe återkallad', FULL, true);
  const callerOf = (keyId: string, scopes: Scope[]): V2Caller => ({ schoolId: s, keyId, scopes: new Set(scopes) });
  const caller = callerOf(key.id, FULL);

  const tls = makeTestTls();
  const received: Array<{ body: string }> = [];
  const receiver: Server = createServer({ key: tls.serverKey, cert: tls.serverCert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ body: Buffer.concat(chunks).toString('utf8') });
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const target = `https://127.0.0.1:${(receiver.address() as AddressInfo).port}/ss12000/notices`;
  Logger.overrideLogger({ log: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined, verbose: () => undefined });
  const config = { get: () => ({ secretsKey: Buffer.alloc(32, 7), background: false, allowInsecureLocal: true }) } as unknown as ConfigService;
  const secrets = new Ss12000Secrets(config);
  const outbound = new ProbeOutbound(tls.ca);
  const provider = new Ss12000V2Service(api);
  const subscriptions = new Ss12000SubscriptionsService(api, outbound);
  const delivery = new Ss12000WebhookDeliveryService(api, outbound, secrets);
  const keys = new IntegrationKeysController(api, secrets);
  const sharing = new AttendanceSharingController(api);
  const window = { 'startTime.onOrAfter': `${day(-7)}T00:00:00Z`, 'startTime.onOrBefore': `${day(7)}T00:00:00Z` };

  /**
   * What the service principal of `keyId` reads past the gateway: the two
   * tables directly (never a row), and the provider's two read functions.
   */
  const direct = (keyId: string) =>
    api.withServicePrincipal(
      s,
      async (tx) => ({
        tables: (await tx.attendanceRecord.count()) + (await tx.absenceReport.count()),
        attendance: Number(
          (await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM app.ss12000_attendances(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`)[0]!.n,
        ),
        absences: Number((await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM app.ss12000_absences(NULL, NULL)`)[0]!.n),
        reads: (await tx.$queryRaw<Array<{ reads: boolean }>>`SELECT app.service_reads_attendance('attendances.read') AS reads`)[0]!.reads,
      }),
      { keyId },
    );
  /** The school's versions and tombstones of the two resources, as the owner sees them. */
  const recorded = () =>
    one<{ versions: string; tombstones: string }>(
      `SELECT (SELECT count(*) FROM "Ss12000EntityVersions" WHERE "schoolId" = $1 AND resource IN ('Attendance', 'Absence'))::text AS versions,
              (SELECT count(*) FROM "Ss12000Tombstones" WHERE "schoolId" = $1 AND resource IN ('Attendance', 'Absence'))::text AS tombstones`,
      [s],
    );
  const code = (expected: string) => (error: { code?: string }) => {
    assert.equal(error.code, expected);
    return true;
  };
  const ids = (items: ReadonlyArray<{ id: string }>) => items.map((item) => item.id).sort();
  const byId = (items: ReadonlyArray<Record<string, unknown> & { id: string }>) => new Map(items.map((item) => [item.id, item]));

  try {
    await check('(nv-a) off by default: NOT_SHARED, nothing read past the gateway, and nothing recorded while the school does not share', async () => {
      await assert.rejects(provider.listAttendances(caller, {}), code('NOT_SHARED'));
      await assert.rejects(provider.listAbsences(caller, {}), code('NOT_SHARED'));
      await assert.rejects(provider.listCalendarEvents(caller, { ...window, expand: 'attendance' }), code('NOT_SHARED'));
      assert.deepEqual(await direct(key.id), { tables: 0, attendance: 0, absences: 0, reads: false });
      const deleted = await provider.deletedEntities(caller, { entities: ['Attendance', 'Absence', 'Person'] });
      assert.deepEqual(Object.keys(deleted.data), ['persons']);
      // Every recorder, at a school that has not decided: a status, a lesson's
      // times, a new and a removed absence, a pupil who leaves and comes back,
      // a new timezone. Gallring's purge would be one more.
      await owner.query(`UPDATE "AttendanceRecords" SET status = 'LATE' WHERE id = $1`, [present.id]);
      await owner.query(`UPDATE "AttendanceRecords" SET status = 'PRESENT' WHERE id = $1`, [present.id]);
      await owner.query(`UPDATE "CalendarLessons" SET "endsAt" = "endsAt" + interval '1 minute' WHERE id = $1`, [lesson.id]);
      await owner.query(`UPDATE "CalendarLessons" SET "endsAt" = "endsAt" - interval '1 minute' WHERE id = $1`, [lesson.id]);
      const scratch = await report(leaver.id, leaver.id, day(3), 'SICK', NOTE, false);
      await owner.query(`DELETE FROM "AbsenceReports" WHERE id = $1`, [scratch.id]);
      await owner.query(`UPDATE "Users" SET "isActive" = false WHERE id = $1`, [leaver.id]);
      await owner.query(`UPDATE "Users" SET "isActive" = true WHERE id = $1`, [leaver.id]);
      await owner.query(`UPDATE "Schools" SET timezone = 'Europe/Helsinki' WHERE id = $1`, [s]);
      await owner.query(`UPDATE "Schools" SET timezone = 'Europe/Stockholm' WHERE id = $1`, [s]);
      assert.deepEqual(await recorded(), { versions: '0', tombstones: '0' }, 'a school that has not decided recorded attendance');
    });

    await check('(nv-b) the administrator decides, stamped by the database; a teacher neither reads nor writes it; no decision changes', async () => {
      const decided = await sharing.record({ shares: true, reference: 'Konsekvensbedömning 2026:12' }, admin);
      assert.deepEqual([decided.shares, decided.reference, decided.decidedBy], [true, 'Konsekvensbedömning 2026:12', 'Rolf Rektor']);
      const row = await one<{ decidedById: string; decidedAt: Date }>(`SELECT "decidedById", "decidedAt" FROM "AttendanceSharingDecisions" WHERE "schoolId" = $1`, [s]);
      assert.equal(row.decidedById, adminRow.id);
      assert.deepEqual((await sharing.get(admin)).current?.shares, true);
      assert.deepEqual(await api.withRls(teacher, (tx) => tx.attendanceSharingDecision.findMany()), []);
      await assert.rejects(api.withRls(teacher, (tx) => tx.attendanceSharingDecision.create({ data: { schoolId: s, shares: false } })));
      for (const sql of [
        `UPDATE "AttendanceSharingDecisions" SET shares = false WHERE "schoolId" = $1`,
        `DELETE FROM "AttendanceSharingDecisions" WHERE "schoolId" = $1`,
      ]) {
        await assert.rejects(owner.query(sql, [s]), (error: { code?: string }) => error.code === 'NV409', sql);
      }
      await assert.rejects(owner.query(`TRUNCATE "AttendanceSharingDecisions"`), (error: { code?: string }) => error.code === 'NV409');
      // A decision stays the school's: its decider is not moved to another school with it.
      await assert.rejects(
        owner.query(`UPDATE "Users" SET "schoolId" = (SELECT id FROM "Schools" WHERE id <> $1 ORDER BY id LIMIT 1) WHERE id = $2`, [s, adminRow.id]),
        (error: { code?: string; constraint?: string }) =>
          error.code === '23503' && error.constraint === 'AttendanceSharingDecisions_decidedById_schoolId_fkey',
      );
      assert.equal((await one<{ n: string }>(`SELECT count(*)::text AS n FROM "AttendanceSharingDecisions" WHERE "schoolId" = $1`, [s])).n, '1');
    });

    await check('(nv-c) shared: S1-shaped, the närvarorapport\'s minutes, no note or reason, and nothing for a key without the scope', async () => {
      const attendances = await provider.listAttendances(caller, { expandReferenceNames: 'true' });
      assert.deepEqual(checkSchema(attendances, 'Attendances'), []);
      // The future year's lesson never leaves.
      assert.deepEqual(ids(attendances.data), [present.id, late.id, leaving.id, old.id].sort());
      const attendance = byId(attendances.data);
      assert.deepEqual(
        [present, late, leaving, old].map((row) => {
          const item = attendance.get(row.id)!;
          return [item['attendanceMinutes'], item['validAbsenceMinutes'], item['invalidAbsenceMinutes']];
        }),
        [[60, 0, 0], [45, 0, 15], [0, 60, 0], [0, 0, 60]],
      );
      assert.deepEqual(attendance.get(present.id)!['student'], { id: pupil.id, displayName: 'Palle Girgensohn' });
      const absences = await provider.listAbsences(caller, {});
      assert.deepEqual(checkSchema(absences, 'Absences'), []);
      assert.deepEqual(ids(absences.data), [sick.id, hours.id, granted.id, oldReport.id].sort());
      const absence = byId(absences.data);
      assert.equal(absence.get(granted.id)!['type'], 'Beviljad ledighet');
      assert.equal(absence.get(sick.id)!['type'], 'Anmäld frånvaro');
      const events = await provider.listCalendarEvents(caller, { ...window, expand: 'attendance' });
      assert.deepEqual(checkSchema(events, 'CalendarEvents'), []);
      const embedded = (events.data.find((event) => event.id === lesson.id)!['_embedded'] as { attendance: Array<{ id: string }> }).attendance;
      assert.deepEqual(ids(embedded), [present.id, late.id, leaving.id].sort());
      const text = JSON.stringify([attendances, absences, events]);
      for (const forbidden of [NOTE, 'Approved leave', 'SICK', 'APPOINTMENT', 'absenceReason', '"note"', 'registeredBy', 'reporter']) {
        assert.ok(!text.includes(forbidden), `${forbidden} left through v2`);
      }

      // One pupil's, in pages, and looked up: what S1 offers for reading a pupil.
      assert.deepEqual(ids((await provider.listAttendances(caller, { student: pupil.id })).data), [present.id, old.id].sort());
      const first = await provider.listAttendances(caller, { limit: '2' });
      assert.equal(first.data.length, 2);
      const rest = await provider.listAttendances(caller, { pageToken: first.pageToken! });
      assert.equal(rest.pageToken, null);
      assert.deepEqual([...ids(first.data), ...ids(rest.data)].sort(), [present.id, late.id, leaving.id, old.id].sort());
      assert.deepEqual(ids(await provider.lookupAttendances(caller, { students: [classmate.id], calendareEvents: [futureLesson.id] }, {})), [late.id]);
      await assert.rejects(provider.getAttendance(caller, ahead.id, {}), code('NOT_FOUND'));
      assert.deepEqual(ids(await provider.lookupAbsences(caller, { ids: [granted.id, hours.id] }, {})), [granted.id, hours.id].sort());

      // Past the gateway: the tables are empty to the service principal, the functions answer the key's scope.
      assert.deepEqual(await direct(key.id), { tables: 0, attendance: 4, absences: 4, reads: true });
      assert.deepEqual(await direct(narrow.id), { tables: 0, attendance: 0, absences: 0, reads: false });
      assert.deepEqual(await direct(revoked.id), { tables: 0, attendance: 0, absences: 0, reads: false });
      await assert.rejects(provider.listAttendances(callerOf(narrow.id, ['persons.read', 'calendarEvents.read']), {}), code('SCOPE_MISSING'));
      await assert.rejects(
        provider.listCalendarEvents(callerOf(narrow.id, ['persons.read', 'calendarEvents.read']), { ...window, expand: 'attendance' }),
        code('SCOPE_MISSING'),
      );
    });

    await check('(nv-d) every read is in the läslogg as the key: ATTENDANCE, ABSENCE_REPORTS, and a granted leave as LEAVE_REQUESTS', async () => {
      const rows = await owner.query<{ kind: string; channel: string; actorId: string | null; subjectIds: string[] }>(
        `SELECT kind::text, channel::text, "actorId", "subjectIds" FROM "PersonalDataAccess" WHERE "apiKeyId" = $1 ORDER BY at, kind`,
        [key.id],
      );
      const of = (kind: string) => [...new Set(rows.rows.filter((row) => row.kind === kind).flatMap((row) => row.subjectIds))].sort();
      assert.ok(rows.rows.every((row) => row.channel === 'INTEGRATION' && row.actorId === null));
      assert.deepEqual(of('ATTENDANCE'), [pupil.id, classmate.id, leaver.id].sort());
      assert.deepEqual(of('ABSENCE_REPORTS'), [pupil.id, classmate.id].sort());
      assert.deepEqual(of('LEAVE_REQUESTS'), [classmate.id]);
    });

    await check('(nv-e) meta.modified moves with a status, the lesson\'s times, a relink and the timezone, not with a note or a room; grantedLeave is a decision\'s', async () => {
      const modified = async (id: string) => ((await provider.getAttendance(caller, id, {}))['meta'] as { modified: string }).modified;
      const m0 = await modified(late.id);
      await pause();
      await owner.query(`UPDATE "AttendanceRecords" SET note = 'probe: annan anteckning' WHERE id = $1`, [late.id]);
      await owner.query(`UPDATE "CalendarLessons" SET "roomId" = $2 WHERE id = $1`, [lesson.id, room.id]);
      assert.equal(await modified(late.id), m0, 'a note or a room moved an Attendance');
      // The newest meta.modified of all of them: what an incremental reader holds.
      const mark = (await provider.listAttendances(caller, {})).data
        .map((item) => (item['meta'] as { modified: string }).modified)
        .sort()
        .pop()!;
      await pause();
      await owner.query(`UPDATE "AttendanceRecords" SET status = 'ABSENT' WHERE id = $1`, [late.id]);
      const m1 = await modified(late.id);
      assert.ok(m1 > m0, `a status did not move the Attendance (${m0} -> ${m1})`);
      assert.deepEqual(ids((await provider.listAttendances(caller, { 'meta.modified.after': mark })).data), [late.id]);
      await pause();
      await owner.query(`UPDATE "CalendarLessons" SET "endsAt" = "endsAt" + interval '10 minutes' WHERE id = $1`, [lesson.id]);
      const longer = await provider.getAttendance(caller, present.id, {});
      assert.equal(longer['attendanceMinutes'], 70);
      assert.ok((longer['meta'] as { modified: string }).modified > m1, 'the lesson\'s new times did not move its attendance');
      // A pupil linked to the source: every object naming them moves, under the new id.
      const before = (await provider.getAbsence(caller, sick.id, {}))['meta'] as { modified: string };
      await pause();
      const source = randomUUID();
      // Only an administrator links a row to the source (ss12000_ids_are_written_by_an_admin).
      const link = (value: string | null) =>
        api.withRls(admin, (tx) => tx.user.updateMany({ where: { id: pupil.id }, data: { ss12000Id: value } }));
      await link(source);
      const relinked = await provider.getAbsence(caller, sick.id, {});
      assert.deepEqual(relinked['student'], { id: source });
      assert.ok((relinked['meta'] as { modified: string }).modified > before.modified, 'a relink did not move the absence');
      assert.deepEqual(((await provider.getAttendance(caller, present.id, {}))['student'] as { id: string }).id, source);
      await link(null);
      // A full-day absence is the school's local day: a new timezone moves it, an hour earlier in Helsinki.
      const span = async () => {
        const item = await provider.getAbsence(caller, sick.id, {});
        return { start: Date.parse(String(item['startTime'])), modified: (item['meta'] as { modified: string }).modified };
      };
      const stockholm = await span();
      await pause();
      await owner.query(`UPDATE "Schools" SET timezone = 'Europe/Helsinki' WHERE id = $1`, [s]);
      const helsinki = await span();
      assert.equal(stockholm.start - helsinki.start, 3_600_000, 'the day did not follow the school\'s timezone');
      assert.ok(helsinki.modified > stockholm.modified, 'a new timezone did not move the absence');
      await owner.query(`UPDATE "Schools" SET timezone = 'Europe/Stockholm' WHERE id = $1`, [s]);

      // A guardian cannot make their own report a granted leave; the administrator can.
      const forged = await api
        .withRls(guardian, (tx) => tx.absenceReport.createMany({ data: [{ schoolId: s, studentId: pupil.id, reportedById: guardianRow.id, date: new Date(`${day(9)}T00:00:00Z`), type: 'OTHER', note: 'Approved leave', grantedLeave: true }] }))
        .then(() => 'written', (error: unknown) => sqlStateOf(error));
      assert.equal(forged, 'NV403');
      const plain = await api.withRls(guardian, (tx) =>
        tx.absenceReport.createMany({ data: [{ schoolId: s, studentId: pupil.id, reportedById: guardianRow.id, date: new Date(`${day(9)}T00:00:00Z`), type: 'OTHER', note: 'Approved leave' }] }),
      );
      assert.equal(plain.count, 1);
      const types = (await provider.listAbsences(caller, { 'startTime.onOrAfter': `${day(8)}T00:00:00Z` })).data.map((item) => item['type']);
      assert.deepEqual(types, ['Anmäld frånvaro'], 'a guardian\'s "Approved leave" note was emitted as a granted leave');
      const decided = await api.withRls(admin, (tx) =>
        tx.absenceReport.createMany({ data: [{ schoolId: s, studentId: pupil.id, reportedById: adminRow.id, date: new Date(`${day(10)}T00:00:00Z`), type: 'OTHER', grantedLeave: true }] }),
      );
      assert.equal(decided.count, 1);
    });

    await check('(nv-f) a pupil who leaves is buried with their attendance and absences, and comes back with them', async () => {
      const before = await dbNow();
      await pause();
      await owner.query(`UPDATE "Users" SET "isActive" = false WHERE id = $1`, [leaver.id]);
      const gone = await provider.deletedEntities(caller, { after: before, entities: ['Attendance', 'Absence'] });
      assert.deepEqual(gone.data, { attendances: [leaving.id], absences: [] });
      assert.ok(!ids((await provider.listAttendances(caller, {})).data).includes(leaving.id), 'a deactivated pupil\'s attendance is still served');
      await owner.query(`UPDATE "Users" SET "isActive" = true WHERE id = $1`, [leaver.id]);
      assert.deepEqual((await provider.deletedEntities(caller, { after: before, entities: 'Attendance' })).data, { attendances: [] });
      assert.deepEqual(ids((await provider.listAttendances(caller, { 'meta.modified.after': before })).data), [leaving.id]);
      // A deleted record is buried; a record of the future year never was.
      const deleted = await dbNow();
      await pause();
      await owner.query(`DELETE FROM "AttendanceRecords" WHERE id = ANY ($1::uuid[])`, [[leaving.id, ahead.id]]);
      assert.deepEqual((await provider.deletedEntities(caller, { after: deleted, entities: 'Attendance' })).data, { attendances: [leaving.id] });
    });

    await check('(nv-g) gallring\'s night deletes what the periods say, and /deletedEntities serves exactly what it deleted', async () => {
      await owner.query(`ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped"`);
      try {
        await owner.query(
          `INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months, "decidedById", "decidedAt")
           SELECT $1, k::"RetentionDataType", 'PURGE_AFTER', m, $2, now() - interval '2 days'
             FROM (VALUES ('ATTENDANCE', 12), ('ABSENCE_REPORTS', 6)) AS d(k, m)`,
          [s, adminRow.id],
        );
      } finally {
        await owner.query(`ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped"`);
      }
      const before = await dbNow();
      await pause();
      const job = new GallringJob(api, { deleteUser: async () => undefined } as unknown as SupabaseAdminService, undefined, new JobRunner(api));
      await job.runSchool(s);
      const left = await one<{ att: string; abs: string }>(
        `SELECT (SELECT count(*) FROM "AttendanceRecords" WHERE id = $1)::text AS att, (SELECT count(*) FROM "AbsenceReports" WHERE id = $2)::text AS abs`,
        [old.id, oldReport.id],
      );
      assert.deepEqual(left, { att: '0', abs: '0' }, 'the night did not purge the old rows');
      const purged = await provider.deletedEntities(caller, { after: before, entities: ['Attendance', 'Absence'] });
      assert.deepEqual(purged.data, { attendances: [old.id], absences: [oldReport.id] });
      assert.ok(!ids((await provider.listAttendances(caller, {})).data).includes(old.id), 'a purged record is still served');
    });

    await check('(nv-h) a subscription to Attendance hears of a change while the school shares, and nothing once it stops', async () => {
      await keys.webhookSecret(key.id, admin);
      await subscriptions.create(caller, { name: 'probe närvaro', target, resourceTypes: [{ resource: 'Attendance' }] });
      await owner.query(`UPDATE "AttendanceRecords" SET status = 'PRESENT' WHERE id = $1`, [late.id]);
      await delivery.tick();
      assert.deepEqual(received.map((notice) => JSON.parse(notice.body)), [{ modifiedEntites: ['Attendance'], deletedEntities: false }]);
      // A change made while the school shared, not yet told when it stops: never told (app.ss12000_notifies).
      await owner.query(`UPDATE "AttendanceRecords" SET status = 'ABSENT' WHERE id = $1`, [late.id]);
      await sharing.record({ shares: false }, admin);
      await delivery.tick();
      assert.equal(received.length, 1, 'a school that stopped sharing still told a subscriber of a change from before');
      // And a change after it stops is not even recorded.
      await owner.query(`UPDATE "AttendanceRecords" SET status = 'LATE' WHERE id = $1`, [late.id]);
      await delivery.tick();
      assert.equal(received.length, 1, 'a school that stopped sharing still told a subscriber of attendance');
      await assert.rejects(provider.listAttendances(caller, {}), code('NOT_SHARED'));
      await assert.rejects(
        subscriptions.create(caller, { name: 'probe frånvaro', target, resourceTypes: [{ resource: 'Absence' }] }),
        code('NOT_SHARED'),
      );
    });

    await check('(nv-i) the functions behind it are nobody\'s but the API\'s question and reads, which answer nothing outside a service principal', async () => {
      const internal = [
        `SELECT app.attendance_shared($1::uuid)`,
        `SELECT app.attendance_shared_since($1::uuid)`,
        `SELECT app.attendance_ever_shared($1::uuid)`,
        `SELECT app.attendance_run_xid($1::uuid)`,
        `SELECT app.attendance_stopped_since($1::uuid)`,
        `SELECT app.ss12000_may_have_left($1::uuid, 'Absence', ARRAY[$1::uuid], ARRAY[now()])`,
        `SELECT app.ss12000_notifies('{Attendance}'::text[], '{attendances.read}'::text[], $1::uuid)`,
        `SELECT app.ss12000_notifies_removals('{Attendance}'::text[], '{attendances.read}'::text[], $1::uuid)`,
        `SELECT app.ss12000_emitted_years($1::uuid)`,
        `SELECT app.ss12000_attendance_emitted($1::uuid, ARRAY[$1::uuid])`,
        `SELECT app.ss12000_absence_emitted($1::uuid, ARRAY[$1::uuid])`,
      ];
      const reads = [
        `SELECT app.service_reads_attendance('attendances.read')::text AS answer`,
        `SELECT app.service_reads_attendance_removals('attendances.read')::text AS answer`,
        `SELECT count(*)::text AS answer FROM app.ss12000_attendances(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
        `SELECT count(*)::text AS answer FROM app.ss12000_absences(NULL, NULL)`,
      ];
      const inRole = async <T>(role: string, body: () => Promise<T>): Promise<T> => {
        await owner.query('BEGIN');
        try {
          await owner.query(`SET LOCAL ROLE ${role}`);
          return await body();
        } finally {
          await owner.query('ROLLBACK');
        }
      };
      const refused = (label: string) => (error: { code?: string }) => {
        assert.equal(error.code, '42501', label);
        return true;
      };
      for (const role of ['app_authenticated', 'authenticated']) {
        for (const sql of internal) await inRole(role, () => assert.rejects(owner.query(sql, [s]), refused(`${role}: ${sql}`)));
      }
      for (const sql of reads) {
        await inRole('authenticated', () => assert.rejects(owner.query(sql), refused(`authenticated: ${sql}`)));
        // The API's, but with no service principal they answer nothing.
        const answer = await inRole('app_authenticated', async () => (await owner.query<{ answer: string }>(sql)).rows[0]!.answer);
        assert.ok(answer === 'false' || answer === '0', `app_authenticated without a principal: ${sql} answered ${answer}`);
      }
    });

    await check('(nv-j) a school that stops and starts again between two reads: the next incremental read drops what went and reads the rest', async () => {
      const after = (items: ReadonlyArray<{ id: string }>) => ids(items);
      const modifiedOf = (item: Record<string, unknown>) => (item['meta'] as { modified: string }).modified;
      // The integration reads whole when the school shares, and is told so by its subscription.
      await sharing.record({ shares: true, reference: 'probe: igen' }, admin);
      await provider.listAttendances(caller, {});
      await provider.listAbsences(caller, {});
      await delivery.tick();
      assert.deepEqual(JSON.parse(received.at(-1)!.body), { modifiedEntites: ['Attendance'], deletedEntities: true }, 'a start was not told');
      const told = received.length;
      await delivery.tick();
      assert.equal(received.length, told, 'a start was told twice');
      const cursor = await dbNow();
      await pause();

      // It stops. Meanwhile: a purge, a pupil who leaves, a register saved, an absence reported.
      // And what never left: an absence reported and withdrawn, and the leaving classmate's
      // sick days reported just before they go (told with them, they would count them).
      await sharing.record({ shares: false }, admin);
      await owner.query(`DELETE FROM "AttendanceRecords" WHERE id = $1`, [present.id]);
      const withdrawn = await report(pupil.id, guardianRow.id, day(13), 'SICK', NOTE, false);
      await owner.query(`DELETE FROM "AbsenceReports" WHERE id = $1`, [withdrawn.id]);
      const unseen = await report(classmate.id, guardianRow.id, day(14), 'SICK', NOTE, false);
      await owner.query(`UPDATE "Users" SET "isActive" = false WHERE id = $1`, [classmate.id]);
      const meanwhile = await record(lesson.id, leaver.id, 'EXCUSED');
      const reported = await report(pupil.id, guardianRow.id, day(12), 'SICK', NOTE, false);
      // S1's default /deletedEntities, no entities, is still answered whole while the school is
      // stopped: the person who left, and the attendance and absence that went, by id; never
      // what was written and went within the stop.
      const stopped = await provider.deletedEntities(caller, { after: cursor });
      assert.deepEqual(stopped.data['persons'], [classmate.id], 'a person who left while the school was stopped is not told');
      assert.deepEqual(
        { attendances: [...stopped.data['attendances']!].sort(), absences: [...stopped.data['absences']!].sort() },
        { attendances: [present.id, late.id].sort(), absences: [hours.id, granted.id].sort() },
        'what went while the school was stopped is not told while it is, or what never left is',
      );
      assert.ok(
        !stopped.data['absences']!.includes(withdrawn.id) && !stopped.data['absences']!.includes(unseen.id),
        'an absence reported while the school was stopped is told of its removal',
      );
      // Nothing else of them is open meanwhile.
      await assert.rejects(provider.listAttendances(caller, {}), code('NOT_SHARED'));
      await assert.rejects(provider.listAbsences(caller, {}), code('NOT_SHARED'));
      // As the owner: nothing written meanwhile has a version, so only the start makes it read.
      const versioned = await one<{ n: string }>(
        `SELECT count(*)::text AS n FROM "Ss12000EntityVersions" WHERE "schoolId" = $1 AND "entityId" = ANY ($2::uuid[])`,
        [s, [meanwhile.id, reported.id]],
      );
      assert.equal(versioned.n, '0', 'a row written while the school did not share was versioned');
      await pause();
      await sharing.record({ shares: true }, admin);
      const since = (await one<{ since: Date }>(`SELECT app.attendance_shared_since($1::uuid) AS since`, [s])).since.toISOString();

      // The next incremental read from before the stop.
      const attendances = (await provider.listAttendances(caller, { 'meta.modified.after': cursor })).data;
      assert.deepEqual(after(attendances), [meanwhile.id], 'the attendance written meanwhile is not read, or a gone one is');
      assert.ok(attendances.every((item) => modifiedOf(item) >= since), 'an attendance reads as modified before the school started again');
      const absences = (await provider.listAbsences(caller, { 'meta.modified.after': cursor })).data;
      assert.ok(after(absences).includes(reported.id), 'the absence reported meanwhile is not read');
      assert.ok(!after(absences).some((id) => id === hours.id || id === granted.id), 'a departed pupil\'s absence is still read');
      const gone = await provider.deletedEntities(caller, { after: cursor, entities: ['Attendance', 'Absence'] });
      assert.deepEqual(
        { attendances: [...gone.data['attendances']!].sort(), absences: [...gone.data['absences']!].sort() },
        { attendances: [present.id, late.id].sort(), absences: [hours.id, granted.id].sort() },
        'what went meanwhile is not in /deletedEntities',
      );
      // And a subscriber is told, with deletedEntities, though nothing changed after the start.
      await delivery.tick();
      assert.equal(received.length, told + 1, 'a start again was not told');
      assert.deepEqual(JSON.parse(received.at(-1)!.body), { modifiedEntites: ['Attendance'], deletedEntities: true });
    });

    await check('(nv-k) a start decided while a notice is in flight is still told once the notice is settled', async () => {
      // Stopped, with a removal for the subscription: the delivery claims it while the school does not share.
      await sharing.record({ shares: false }, admin);
      const leaverRow = await one<{ id: string }>(`SELECT id FROM "AttendanceRecords" WHERE "studentId" = $1`, [leaver.id]);
      await owner.query(`DELETE FROM "AttendanceRecords" WHERE id = $1`, [leaverRow.id]);
      type Claimed = { subscription_id: string; school_id: string; modified: string[]; deleted: boolean; watermark_to: string };
      const claimed = await api.withDeliveryService(
        (tx) => tx.$queryRaw<Claimed[]>`SELECT subscription_id, school_id, modified, deleted, watermark_to FROM app.ss12000_due_notifications(50)`,
      );
      const inFlight = claimed.find((row) => row.school_id === s);
      assert.ok(inFlight, 'the removal while the school was stopped did not make the subscription due');
      assert.deepEqual([inFlight.modified, inFlight.deleted], [[], true]);
      // The school starts again before that notice is settled, and the settle stamps a later time.
      await sharing.record({ shares: true }, admin);
      await pause();
      await api.withDeliveryService(
        (tx) => tx.$queryRaw`SELECT app.ss12000_notification_settled(${inFlight.subscription_id}::uuid, true, 200, 'DELIVERED',
                                                                     ${inFlight.watermark_to}, 5, now())`,
      );
      // The next tick tells the start, once.
      const before = received.length;
      await delivery.tick();
      assert.equal(received.length, before + 1, 'a start decided while a notice was in flight was never told');
      assert.deepEqual(JSON.parse(received.at(-1)!.body), { modifiedEntites: ['Attendance'], deletedEntities: true });
      await delivery.tick();
      assert.equal(received.length, before + 1, 'a start was told twice');
    });

    await check('(nv-l) a register save waits for an SS12000 apply that links its pupils, and neither is aborted', async () => {
      const shares = await one<{ shares: boolean }>(`SELECT app.attendance_shared($1::uuid) AS shares`, [s]);
      assert.equal(shares.shares, true, 'the school does not share before the race');
      // Two pupils marked absent in a lesson; every record has its version (written while the school shares).
      const raceLesson = await lessonOf(klass.id, day(-1));
      const first = await record(raceLesson.id, pupil.id, 'ABSENT');
      const second = await record(raceLesson.id, leaver.id, 'ABSENT');
      const notifications = { notifyUsers: async () => 0, guardiansOf: async () => [] } as unknown as NotificationsService;
      const attendance = new AttendanceService(api, notifications);

      // The apply's shape (readLocalSlice with lock, then one ss12000Id update per PERSON LINK, in
      // change order), as the owner: the school's people lock, then the first pupil linked, which
      // moves and holds the versions of every record of theirs until the apply ends.
      await owner.query('BEGIN');
      let committed = false;
      try {
        // As the administrator whose apply it is: only an administrator's apply writes an ss12000Id.
        await owner.query(`SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text)::text, true)`, [adminRow.authId]);
        await owner.query(`SELECT pg_advisory_xact_lock(hashtextextended('Users:' || $1::text, 0))`, [s]);
        await owner.query(`UPDATE "Users" SET "ss12000Id" = gen_random_uuid() WHERE id = $1`, [pupil.id]);
        // Meanwhile the register is corrected, the other pupil first: without the wait it would hold
        // the second pupil's version while it waits for the first's, which the apply holds.
        const saving = attendance
          .reportAttendance(
            { calendarLessonId: raceLesson.id, records: [{ studentId: leaver.id, status: 'LATE' }, { studentId: pupil.id, status: 'LATE' }] } as never,
            admin,
          )
          .then(
            (answer) => ({ answer, afterCommit: committed, error: null as unknown }),
            (error: unknown) => ({ answer: null, afterCommit: committed, error }),
          );
        await new Promise((resolve) => setTimeout(resolve, 400));
        // The apply links the second pupil, which moves that pupil's versions too, and commits.
        await owner.query(`UPDATE "Users" SET "ss12000Id" = gen_random_uuid() WHERE id = $1`, [leaver.id]);
        committed = true;
        await owner.query('COMMIT');
        const saved = await saving;
        assert.equal(saved.error, null, `the register save was aborted: ${String(saved.error)}`);
        assert.deepEqual(saved.answer, { created: 0, updated: 2 }, 'the register save did not write both');
        assert.equal(saved.afterCommit, true, 'the register save wrote while the apply was running');
      } catch (error) {
        if (!committed) await owner.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      const statuses = await owner.query<{ status: string }>(
        `SELECT status::text AS status FROM "AttendanceRecords" WHERE id = ANY ($1::uuid[])`,
        [[first.id, second.id]],
      );
      assert.deepEqual(statuses.rows.map((row) => row.status), ['LATE', 'LATE'], 'the register save is not what the records say');
    });

    await check('(nv-m) the wait has a limit, and a decision waits for a save already writing', async () => {
      const raceLesson = await one<{ id: string }>(
        `SELECT "calendarLessonId" AS id FROM "AttendanceRecords" WHERE "studentId" = $1 AND status = 'LATE' ORDER BY "createdAt" DESC LIMIT 1`,
        [pupil.id],
      );
      const notifications = { notifyUsers: async () => 0, guardiansOf: async () => [] } as unknown as NotificationsService;
      const attendance = new AttendanceService(api, notifications);
      const save = () =>
        attendance.reportAttendance({ calendarLessonId: raceLesson.id, records: [{ studentId: pupil.id, status: 'PRESENT' }] } as never, admin);

      // An apply that runs longer than the save may wait: the save answers 409 within about 5 s
      // and writes nothing, where it would otherwise hold its connection until the apply ends.
      await owner.query('BEGIN');
      try {
        await owner.query(`SELECT pg_advisory_xact_lock(hashtextextended('Users:' || $1::text, 0))`, [s]);
        const started = Date.now();
        await assert.rejects(save(), (error: unknown) => (error as { response?: { code?: string } }).response?.code === 'ATTENDANCE_SYNC_IN_PROGRESS');
        const waited = Date.now() - started;
        assert.ok(waited >= 4_500 && waited < 12_000, `the save waited ${waited} ms, not about 5 s`);
      } finally {
        await owner.query('ROLLBACK');
      }
      const unchanged = await one<{ status: string }>(
        `SELECT status::text AS status FROM "AttendanceRecords" WHERE "calendarLessonId" = $1 AND "studentId" = $2`,
        [raceLesson.id, pupil.id],
      );
      assert.equal(unchanged.status, 'LATE', 'a save that waited out its limit wrote');

      // A save that has begun holds a decision back until it ends, so it never writes on having
      // read the decision before: a real save, held up briefly by an apply (well under its 5 s),
      // and a real decision to stop made meanwhile, which may only be written after the save.
      const order: string[] = [];
      await owner.query('BEGIN');
      let released = false;
      try {
        await owner.query(`SELECT pg_advisory_xact_lock(hashtextextended('Users:' || $1::text, 0))`, [s]);
        const saving = save().then(() => order.push('save'));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const deciding = sharing.record({ shares: false, reference: 'probe: medan registret sparas' }, admin).then(() => order.push('decision'));
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.deepEqual(order, [], 'the save or the decision went ahead while the apply was running');
        released = true;
        await owner.query('COMMIT');
        await Promise.all([saving, deciding]);
        assert.deepEqual(order, ['save', 'decision'], 'a decision was written while a save that began before it was still writing');
      } catch (error) {
        if (!released) await owner.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      await sharing.record({ shares: true, reference: 'probe: igen efter registret' }, admin);
    });
  } finally {
    Logger.overrideLogger(new ConsoleLogger());
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await sweepSs12000NarvaroSchool(owner, marker);
  }
}
