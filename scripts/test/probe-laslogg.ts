/**
 * The adapter probe's checks for the läslogg (20261026091000), through the
 * real services on the API's role and real Postgres as CI runs it. In a
 * school of its own (slug <marker>-laslogg), swept whole before and after:
 *
 *   lä1  the register's hot path: AttendanceService.lessonRoster records the
 *        pupils it named as ROSTER with the caller's channel, in its own
 *        transaction (one statement more, the last before COMMIT), and the
 *        same list opened again within the quarter-hour writes no row;
 *   lä2  the family's reads (FamilyReadsService) as a guardian record the
 *        child as PEOPLE, ABSENCE_REPORTS and LEAVE_REQUESTS with the
 *        guardian's id and role; the administrator's people list records
 *        everyone but the administrator;
 *   lä3  the log is append-only to its owner too: UPDATE, DELETE and
 *        TRUNCATE are refused (PD409) outside a cascade or gallring, a
 *        deleted reader leaves the row with no actor, and the setting
 *        app.gallring is what lets a purge's DELETE through;
 *   lä4  an integration's reads are the key's: SS12000 v1 persons records
 *        PEOPLE and GUARDIANS with the key, v2 persons records the Users ids
 *        behind the emitted ones, the source system's ids included, and v2
 *        activities record what expand=groups and expand=teachers embed;
 *   lä5  the staff's HR and absences: the year's posts and the load report
 *        record EMPLOYMENT, the absence list STAFF_ABSENCES;
 *   lä6  "vem har läst om eleven" (AccessLogService) answers the pupil's
 *        entries with the readers' names and records its own read;
 *   lä7  a read that cannot be recorded fails: under the sync principal the
 *        writer refuses (PD403), and the read's transaction with it.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { recordRead } from '../../src/access-log/access-log';
import { AccessLogService } from '../../src/access-log/access-log.service';
import { AttendanceService } from '../../src/attendance/attendance.service';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { CoverService } from '../../src/cover/cover.service';
import { TeacherAbsencesService } from '../../src/cover/teacher-absences.service';
import type { PrismaService } from '../../src/database/prisma.service';
import { FamilyReadsService } from '../../src/family/family-reads.service';
import { Ss12000Service } from '../../src/integration/ss12000.service';
import { Ss12000V2Service, type V2Caller } from '../../src/integration/ss12000-v2/ss12000-v2.service';
import type { Scope } from '../../src/integration/ss12000-v2/scopes';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import { StaffingLoadService } from '../../src/staffing/staffing-load.service';
import { TeacherEmploymentsService } from '../../src/staffing/teacher-employments.service';
import type { SupabaseAdminService } from '../../src/users/supabase-admin.service';
import { UsersService } from '../../src/users/users.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function lasloggSlug(marker: string): string {
  return `${marker}-laslogg`;
}

export async function sweepLasloggSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [lasloggSlug(marker)]);
}

/** Every statement pg sends while `body` runs, counted at Client.query. */
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

interface LogRow {
  actorId: string | null;
  actorRole: string | null;
  apiKeyId: string | null;
  channel: string;
  kind: string;
  subjectIds: string[];
}

export async function lasloggChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepLasloggSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;

  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${marker} läslogg`, lasloggSlug(marker)],
  );
  const s = school.id;
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, 'probe läslogg', '${today}'::date - 30, '${today}'::date + 300, true, now()) RETURNING id`,
    [s],
  );
  const home = await one<{ id: string }>(
    `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "updatedAt") VALUES ($1, $2, 'L7', now()) RETURNING id`,
    [s, year.id],
  );
  const subject = await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'Läs', 'LÄS', now()) RETURNING id`, [s]);
  const person = async (role: string, label: string, groupId: string | null = null) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4, $5, true, $6, now()) RETURNING id`,
      [s, `${marker}-laslogg-${label}@example.invalid`, label, role, authId, groupId],
    );
    return { id: row.id, authId };
  };
  const admin = await person('SCHOOL_ADMIN', 'Admin');
  const teacher = await person('TEACHER', 'Lärare');
  const pupil = await person('STUDENT', 'Elev', home.id);
  const classmate = await person('STUDENT', 'Kamrat', home.id);
  // The classmate's id in the source system, written as the school's admin,
  // the only writer the guard lets set it: v2 emits it in place of the row's.
  const sourced = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
  await owner.query('BEGIN');
  try {
    await owner.query(`SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text)::text, true)`, [admin.authId]);
    await owner.query(`UPDATE "Users" SET "ss12000Id" = $2 WHERE id = $1`, [classmate.id, sourced]);
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
  const guardian = await person('GUARDIAN', 'Förälder');
  await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3)`, [s, guardian.id, pupil.id]);
  const lesson = await one<{ id: string }>(
    `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
     VALUES ($1, $2, $3, '${today}', '${today}'::date + time '07:10', '${today}'::date + time '07:50', now()) RETURNING id`,
    [s, subject.id, home.id],
  );
  await owner.query(`INSERT INTO "CalendarLessonTeachers" ("calendarLessonId", "teacherId", "schoolId") VALUES ($1, $2, $3)`, [lesson.id, teacher.id, s]);
  await owner.query(`INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date, note) VALUES ($1, $2, $3, '${today}'::date + 1, 'probe')`, [s, pupil.id, guardian.id]);
  await owner.query(
    `INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason) VALUES ($1, $2, $3, '${today}'::date + 5, '${today}'::date + 6, 'probe')`,
    [s, pupil.id, guardian.id],
  );
  await owner.query(
    `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt") VALUES ($1, $2, $3, 100, now())`,
    [s, teacher.id, year.id],
  );
  const reason = await one<{ id: string }>(`INSERT INTO "TeacherAbsenceReasons" ("schoolId", builtin) VALUES ($1, 'SICK') RETURNING id`, [s]);
  await owner.query(
    `INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "reasonId") VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days', $3)`,
    [s, teacher.id, reason.id],
  );
  const key = await one<{ id: string }>(
    `INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash", scopes) VALUES ($1, 'probe läslogg', $2, $3::text[]) RETURNING id`,
    [s, `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`, '{ss12000.v1,persons.read,responsibles.read}'],
  );

  const asAdmin: AuthenticatedUser = { authId: admin.authId, role: Role.SCHOOL_ADMIN, userId: admin.id, schoolId: s, channel: 'WEB' };
  const asTeacher: AuthenticatedUser = { authId: teacher.authId, role: Role.TEACHER, userId: teacher.id, schoolId: s, channel: 'APP' };
  const asGuardian: AuthenticatedUser = { authId: guardian.authId, role: Role.GUARDIAN, userId: guardian.id, schoolId: s, channel: 'APP' };
  const log = async (where = 'TRUE', params: unknown[] = []): Promise<LogRow[]> =>
    (
      await owner.query<LogRow>(
        `SELECT "actorId", "actorRole"::text AS "actorRole", "apiKeyId", channel::text AS channel, kind::text AS kind,
                ARRAY(SELECT x::text FROM unnest("subjectIds") x ORDER BY x) AS "subjectIds"
           FROM "PersonalDataAccess" WHERE "schoolId" = $1 AND ${where} ORDER BY "at", id`,
        [s, ...params],
      )
    ).rows;
  const sorted = (...ids: string[]) => [...ids].sort();
  const notifications = { notifyUsers: async () => 0, guardiansOf: async () => [] } as unknown as NotificationsService;

  try {
    await check('(lä1) the register records its roster in its own transaction, once a quarter-hour per reader', async () => {
      const attendance = new AttendanceService(api, notifications);
      const sent = await statementsDuring(() => attendance.lessonRoster(lesson.id, asTeacher));
      const writes = sent.filter((statement) => statement.includes('app.personal_data_read('));
      assert.equal(writes.length, 1, `the roster sent ${writes.length} log statements`);
      assert.equal(sent.indexOf(writes[0]!), sent.length - 2, `the log statement was not the last before COMMIT: ${JSON.stringify(sent)}`);
      assert.match(sent[sent.length - 1]!, /^COMMIT/);
      await attendance.lessonRoster(lesson.id, asTeacher);
      const rows = await log(`kind = 'ROSTER'`);
      assert.deepEqual(rows, [
        { actorId: teacher.id, actorRole: 'TEACHER', apiKeyId: null, channel: 'APP', kind: 'ROSTER', subjectIds: sorted(pupil.id, classmate.id) },
      ]);
    });

    await check('(lä2) the family\'s reads and the people list record whom they named, never the reader', async () => {
      const family = new FamilyReadsService(api);
      assert.deepEqual((await family.children(asGuardian)).map((child) => child.id), [pupil.id]);
      assert.equal((await family.absenceReports({}, asGuardian)).length, 1);
      assert.equal((await family.leaveRequests({}, asGuardian)).length, 1);
      const rows = await log(`"actorId" = $2`, [guardian.id]);
      assert.deepEqual(
        rows.map((row) => [row.kind, row.actorRole, row.channel, row.subjectIds]),
        [
          ['PEOPLE', 'GUARDIAN', 'APP', [pupil.id]],
          ['ABSENCE_REPORTS', 'GUARDIAN', 'APP', [pupil.id]],
          ['LEAVE_REQUESTS', 'GUARDIAN', 'APP', [pupil.id]],
        ],
      );
      const users = new UsersService(api, {} as SupabaseAdminService);
      const people = await users.list(asAdmin);
      assert.equal(people.length, 5);
      const [listed] = await log(`"actorId" = $2 AND kind = 'PEOPLE'`, [admin.id]);
      assert.deepEqual(listed?.subjectIds, sorted(teacher.id, pupil.id, classmate.id, guardian.id), 'the people list recorded the admin or left someone out');
      assert.deepEqual(await users.counts(asAdmin), { byRole: { STUDENT: 2, TEACHER: 1, SCHOOL_ADMIN: 1, GUARDIAN: 1 } });
      assert.equal((await log(`"actorId" = $2`, [admin.id])).length, 1, 'the counts were recorded');
    });

    await check('(lä3) the log is append-only to its owner, a deleted reader leaves the row, and only gallring deletes', async () => {
      for (const statement of [
        `UPDATE "PersonalDataAccess" SET "at" = now() WHERE "schoolId" = $1`,
        `DELETE FROM "PersonalDataAccess" WHERE "schoolId" = $1`,
      ]) {
        await assert.rejects(owner.query(statement, [s]), (error: { code?: string }) => error.code === 'PD409', statement);
      }
      await assert.rejects(owner.query(`TRUNCATE "PersonalDataAccess"`), (error: { code?: string }) => error.code === 'PD409');
      const before = (await log()).length;
      // A reader's row deleted: the cascade's SET NULL passes the trigger.
      const gone = await person('TEACHER', 'Borta');
      const goneUser: AuthenticatedUser = { authId: gone.authId, role: Role.TEACHER, userId: gone.id, schoolId: s, channel: 'WEB' };
      await api.withRls(goneUser, (tx) => recordRead(tx, 'ROSTER', [pupil.id], 'WEB'));
      await owner.query(`DELETE FROM "Users" WHERE id = $1`, [gone.id]);
      const orphan = await log(`"actorId" IS NULL AND "actorRole" = 'TEACHER' AND channel = 'WEB'`);
      assert.equal(orphan.length, 1, 'a deleted reader took their rows with them or left their id');
      // The purge's own path: app.gallring set to the school, no principal.
      const client = new Client({ connectionString: process.env.PROBE_OWNER_URL });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.gallring', $1, true)`, [s]);
        const removed = await client.query(`DELETE FROM "PersonalDataAccess" WHERE "schoolId" = $1 AND "actorId" IS NULL`, [s]);
        assert.equal(removed.rowCount, 1);
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
      assert.equal((await log()).length, before + 1);
    });

    await check('(lä4) an integration\'s reads are recorded as its key, with the Users ids behind the emitted ones', async () => {
      await new Ss12000Service(api).persons(s, '100', '0', undefined, key.id);
      const v1 = await log(`"apiKeyId" = $2`, [key.id]);
      assert.deepEqual(
        v1.map((row) => [row.kind, row.channel, row.actorId, row.actorRole, row.subjectIds]),
        [
          ['PEOPLE', 'INTEGRATION', null, null, sorted(admin.id, teacher.id, pupil.id, classmate.id, guardian.id)],
          ['GUARDIANS', 'INTEGRATION', null, null, sorted(pupil.id, guardian.id)],
        ],
      );
      const other = await one<{ id: string }>(
        `INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash", scopes) VALUES ($1, 'probe läslogg v2', $2, $3::text[]) RETURNING id`,
        [s, `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`, '{persons.read}'],
      );
      const caller: V2Caller = { schoolId: s, keyId: other.id, scopes: new Set(['persons.read'] as Scope[]) };
      const page = await new Ss12000V2Service(api).listPersons(caller, {});
      // The source system's id is what v2 emits for the classmate; the log names the row.
      assert.ok(page.data.some((item) => item.id === sourced), 'v2 did not emit the source id');
      const [v2] = await log(`"apiKeyId" = $2`, [other.id]);
      // A key without responsibles.read is shown no guardian, so none is recorded.
      assert.deepEqual(v2?.subjectIds, sorted(admin.id, teacher.id, pupil.id, classmate.id));
      assert.equal(v2?.kind, 'PEOPLE');

      // Activities name groups and teachers by reference (the timetable,
      // unrecorded); expand=groups embeds the groups with their members and
      // expand=teachers the posts with their person, which are recorded.
      await owner.query(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 1, '08:00', '09:00', now())`,
        [s, year.id, subject.id, home.id, teacher.id],
      );
      const third = await one<{ id: string }>(
        `INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash", scopes) VALUES ($1, 'probe läslogg aktiviteter', $2, $3::text[]) RETURNING id`,
        [s, `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`, '{activities.read,groups.read,duties.read}'],
      );
      const activityCaller: V2Caller = {
        schoolId: s,
        keyId: third.id,
        scopes: new Set(['activities.read', 'groups.read', 'duties.read'] as Scope[]),
      };
      // The master lesson, and the dated lesson without one as an ad hoc activity.
      const plain = await new Ss12000V2Service(api).listActivities(activityCaller, {});
      assert.equal(plain.data.length, 2, `${plain.data.length} activities, not the master lesson and the ad hoc one`);
      assert.deepEqual(await log(`"apiKeyId" = $2`, [third.id]), [], 'an activity by reference was recorded');
      await new Ss12000V2Service(api).listActivities(activityCaller, { expand: ['groups', 'teachers'] });
      const expanded = await log(`"apiKeyId" = $2`, [third.id]);
      assert.deepEqual(
        expanded.map((row) => [row.kind, row.subjectIds]),
        [
          ['EMPLOYMENT', [teacher.id]],
          ['ROSTER', sorted(pupil.id, classmate.id)],
        ].sort(([a], [b]) => String(a).localeCompare(String(b))),
        JSON.stringify(expanded),
      );
    });

    await check('(lä5) the staff\'s posts, load and absences are recorded for the administrator who reads them', async () => {
      await new TeacherEmploymentsService(api).list(year.id, asAdmin);
      await new StaffingLoadService(api).load(year.id, 'planned', asAdmin);
      const cover = { now: () => new Date() } as unknown as CoverService;
      const absences = new TeacherAbsencesService(api, {} as RealtimeService, notifications, cover);
      assert.equal((await absences.list({}, asAdmin)).length, 1);
      const rows = await log(`"actorId" = $2 AND kind IN ('EMPLOYMENT', 'STAFF_ABSENCES')`, [admin.id]);
      assert.deepEqual(
        rows.map((row) => [row.kind, row.subjectIds]),
        [
          ['EMPLOYMENT', [teacher.id]],
          ['STAFF_ABSENCES', [teacher.id]],
        ],
        'the load report within the quarter-hour of the posts wrote a second EMPLOYMENT row, or none was written',
      );
      // The teacher's own: their post and their own load name nobody else.
      await new TeacherEmploymentsService(api).list(year.id, asTeacher);
      await new StaffingLoadService(api).load(year.id, 'planned', asTeacher);
      assert.equal((await log(`"actorId" = $2 AND kind = 'EMPLOYMENT'`, [teacher.id])).length, 0);
    });

    await check('(lä6) "vem har läst om eleven" names the readers and records its own read', async () => {
      const answer = await new AccessLogService(api).forPerson({ personId: pupil.id }, asAdmin);
      const readers = answer.entries.map((entry) => [entry.kind, entry.reader.type, entry.reader.type === 'PERSON' ? entry.reader.name : entry.reader.name]);
      assert.ok(readers.some(([kind, , name]) => kind === 'ROSTER' && name === 'Lärare Probe'), JSON.stringify(readers));
      assert.ok(readers.some(([kind, type, name]) => kind === 'PEOPLE' && type === 'KEY' && name === 'probe läslogg'), JSON.stringify(readers));
      assert.ok(readers.some(([kind, , name]) => kind === 'LEAVE_REQUESTS' && name === 'Förälder Probe'), JSON.stringify(readers));
      const own = await log(`"actorId" = $2 AND kind = 'ACCESS_LOG'`, [admin.id]);
      assert.deepEqual(own.map((row) => row.subjectIds), [[pupil.id]]);
      // Its own read shows up in the next answer.
      const again = await new AccessLogService(api).forPerson({ personId: pupil.id }, asAdmin);
      assert.equal(again.entries[0]?.kind, 'ACCESS_LOG');
    });

    await check('(lä7) a read the log cannot record fails with it: the sync is no reader', async () => {
      await assert.rejects(
        api.withSyncPrincipal(s, (tx) => recordRead(tx, 'PEOPLE', [pupil.id])),
        (error: unknown) => /PD403|PERSONAL_DATA_READ_HAS_NO_READER/.test(String((error as { message?: string }).message ?? error)),
      );
    });
  } finally {
    await sweepLasloggSchool(owner, marker);
  }
}
