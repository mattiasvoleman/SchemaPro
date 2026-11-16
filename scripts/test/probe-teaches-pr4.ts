/**
 * Administratör som lärare, del 4 (krisläge, mentor och rapporteringsgrad som lärare), through the real adapter. PR 3 proved the
 * database's arms and functions in SQL (RLS sections 510-514); this proves what the real services make of them, on the API's role
 * and real Postgres as CI runs it. Called last by prisma-adapter-probe.ts, in a school of its own (`<marker>-teaches-pr4`),
 * created and removed as the owner.
 *
 * The school narrowed who may start an alarm to full and rektor (the case the mark is for). Marks are set the way the product sets
 * them: UsersService.update, by a full administratör, on a person with a post; a mark is never UPDATEd in before the post exists.
 *
 *   (tk-a) the twin test of Krisläge, the one that matters: a TEACHER and a marked administrator answer for the same group, a group
 *          nobody of them answers for, a group a colleague answers for; four alarms (one going, one that ended 54 minutes ago, one
 *          that ended 66 minutes ago and an old one). CrisisService.mine gives the marked administrator the SAME alarms and groups
 *          as the teacher (the two in the window, and the one group) and not the school's: the database lets an administrator read
 *          every alarm and group of the school, for good, which is read here too, so the narrowing is shown to be the gateway's.
 *          searchPupils gives the marked administrator the pupils outside their own lists (not an empty answer: every pupil is on
 *          some list), the same as the teacher, and refuses the alarm that ended 66 minutes ago (404) as it refuses the teacher.
 *          The marked administrator with no group sees the alarms in the window with no group in them;
 *   (tk-b) the marks, in a school whose start list leaves out the schemaläggare and the expedition: a marked one marks their OWN group
 *          (stored, in their own name, not on behalf of anybody) and cannot mark a group they do not answer for (403
 *          CRISIS_NOT_YOURS); unmarked, they cannot mark even their own; full and rektor always can, for any group, on behalf of the
 *          management;
 *   (tk-c) rapporteringsgrad: the lessons a marked administrator stands on count as theirs once they are marked, the first count after
 *          the mark and not before it (the retroactivity: the 90 days it recomputes), the reminder is written for them and not for an
 *          unmarked administrator with the same lessons, and ReportingRateService.mine gives them their open lessons and their share;
 *   (tk-d) mentor: marking an administrator who is a pupil's mentor (MENTORSKAP) tells them of the pending leave request they were
 *          never told of (the catch-up UsersService.update asks for when the mark changes), and the same mark again asks nothing; as
 *          the pupil's deciding mentor they pass the request on to rektor (referLeaveRequest), once (a second is 409), and a request
 *          somebody else decided is 409; an unmarked administrator with the same MENTORSKAP is no mentor and passes nothing on, as before.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { CrisisService } from '../../src/crisis/crisis.service';
import type { PrismaService } from '../../src/database/prisma.service';
import { LeaveService } from '../../src/family/leave.service';
import { NotificationDeliveryService } from '../../src/notifications/notification-delivery.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import { ReportingRateService } from '../../src/reporting-rate/reporting-rate.service';
import type { SupabaseAdminService } from '../../src/users/supabase-admin.service';
import { UsersService } from '../../src/users/users.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function teachesPr4Slug(marker: string): string {
  return `${marker}-teaches-pr4`;
}

export async function sweepTeachesPr4School(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [teachesPr4Slug(marker)]);
}

/** The error a promise rejects with, or a failed assertion when it resolves. */
async function refusalOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  assert.fail('the call was not refused');
}

/** The problem body of a 4xx a service threw: its status and the `code` the filter would forward. */
function problemOf(error: unknown): { status?: number; code?: string } {
  const status = (error as { status?: number } | null)?.status;
  const body = (error as { getResponse?: () => unknown } | null)?.getResponse?.();
  return { status, ...(typeof body === 'object' && body !== null ? (body as { code?: string }) : {}) };
}

export async function teachesPr4Checks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepTeachesPr4School(owner, marker);
  const rows = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await rows<T>(sql, params))[0]!;
  const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await one<{ n: string }>(sql, params)).n);

  const s = (
    await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [
      `${marker} teaches pr4`,
      teachesPr4Slug(marker),
    ])
  ).id;
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
       VALUES ($1, 'probe teaches pr4', current_date - 120, current_date + 300, true, 'NIOARIG', now()) RETURNING id`,
      [s],
    )
  ).id;
  const subject = (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'Probe ämne', 'TK4', now()) RETURNING id`, [s])).id;
  const groupOf = async (name: string): Promise<string> =>
    (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', 7, now()) RETURNING id`,
        [s, year, name],
      )
    ).id;
  const gA = await groupOf('TKA');
  const gB = await groupOf('TKB');
  const gC = await groupOf('TKC');

  type Person = AuthenticatedUser & { userId: string };
  const person = async (role: string, label: string, groupId: string | null = null, adminProfile: string | null = null): Promise<Person> => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "adminProfile", "hrRead", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4, $5, true, $6, $7::"AdminProfile", false, now()) RETURNING id`,
      [s, `${marker}-teaches-pr4-${label}@example.invalid`, label, role, authId, groupId, adminProfile],
    );
    return {
      authId,
      role: role as Role,
      userId: row.id,
      schoolId: s,
      channel: role === 'TEACHER' ? 'APP' : 'WEB',
      ...(role === 'SCHOOL_ADMIN' ? { adminProfile: adminProfile as never, hrRead: false } : {}),
    } as Person;
  };
  const full = await person('SCHOOL_ADMIN', 'full', null, 'FULL');
  const rektor = await person('SCHOOL_ADMIN', 'rektor', null, 'REKTOR');
  const sched = await person('SCHOOL_ADMIN', 'sched', null, 'SCHEMALAGGARE');
  const exp = await person('SCHOOL_ADMIN', 'exp', null, 'EXPEDITION');
  const lone = await person('SCHOOL_ADMIN', 'lone', null, 'SCHEMALAGGARE'); // marked, answers for no group
  const plain = await person('SCHOOL_ADMIN', 'plain', null, 'SCHEMALAGGARE'); // never marked
  const ment = await person('SCHOOL_ADMIN', 'ment', null, 'EXPEDITION'); // the pupil's mentor, marked in (tk-d)
  const ment2 = await person('SCHOOL_ADMIN', 'ment2', null, 'EXPEDITION'); // a mentor too, never marked
  const teacher = await person('TEACHER', 'teacher');
  const colleague = await person('TEACHER', 'colleague');
  const pa1 = await person('STUDENT', 'pa1', gA);
  const pa2 = await person('STUDENT', 'pa2', gA);
  const pb1 = await person('STUDENT', 'pb1', gB);
  const pb2 = await person('STUDENT', 'pb2', gB);
  const pc1 = await person('STUDENT', 'pc1', gC);

  // A post for the year for everybody who will be marked (a mark needs one), and the school's start list narrowed to full and rektor.
  for (const who of [sched, exp, lone, ment, rektor, full, plain, ment2, teacher]) {
    await owner.query(`INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt") VALUES ($1, $2, $3, 50, now())`, [s, who.userId, year]);
  }
  await owner.query(`INSERT INTO "CrisisSettings" ("schoolId", "startProfiles", "updatedAt") VALUES ($1, ARRAY['FULL', 'REKTOR']::"AdminProfile"[], now())`, [s]);

  const realtime = {
    notifyCrisisChanged: () => undefined,
    notifyCoverBoardChanged: () => undefined,
    notifyLessonsChanged: async () => undefined,
    notifyLessonChanged: async () => undefined,
  } as unknown as RealtimeService;
  const notifications = new NotificationsService(api, new NotificationDeliveryService(api));
  const crisis = new CrisisService(api, notifications, realtime);
  const reporting = new ReportingRateService(api);
  const leave = new LeaveService(api, notifications);
  const users = new UsersService(api, { isConfigured: false } as unknown as SupabaseAdminService, notifications);
  const setMark = (who: Person, value: boolean) => users.update(who.userId, { teaches: value } as never, full);
  const teachesNow = async (who: Person): Promise<boolean> => (await one<{ teaches: boolean }>(`SELECT teaches FROM "Users" WHERE id = $1`, [who.userId])).teaches;

  // ---- the alarms (planted as the owner, the triggers that forbid a moved start and an end put back for the planting) ----
  type PlantedAlarm = { id: string; gA: string; gB: string; gC: string };
  const alarms = {} as Record<'old' | 'e66' | 'e54' | 'live', PlantedAlarm>;
  const plant = async (name: keyof typeof alarms, startedMinutesAgo: number, endedMinutesAgo: number | null, withMarked: Person[]): Promise<void> => {
    const alarm = await one<{ id: string }>(`INSERT INTO "CrisisAlarms" ("schoolId", kind, mode) VALUES ($1, 'EVACUATION', 'LIVE') RETURNING id`, [s]);
    const call = async (basis: string, group: string, pupils: Person[], teachers: Array<[Person, string]>): Promise<string> => {
      const c = await one<{ id: string }>(
        `INSERT INTO "CrisisCalls" ("schoolId", "alarmId", basis, "groupName", "subjectName", "lessonStartsAt", "lessonEndsAt")
         VALUES ($1, $2, $3::"CrisisCallBasis", $4, 'Probe ämne', now() - interval '30 minutes', now() + interval '30 minutes') RETURNING id`,
        [s, alarm.id, basis, group],
      );
      for (const [who, role] of teachers) {
        await owner.query(`INSERT INTO "CrisisCallTeachers" ("schoolId", "callId", "teacherId", role) VALUES ($1, $2, $3, $4::"TeacherAssignmentRole")`, [s, c.id, who.userId, role]);
      }
      for (const pupil of pupils) {
        await owner.query(`INSERT INTO "CrisisPupils" ("schoolId", "alarmId", "callId", "studentId") VALUES ($1, $2, $3, $4)`, [s, alarm.id, c.id, pupil.userId]);
      }
      return c.id;
    };
    const callA = await call('LESSON', 'TKA', [pa1, pa2], [[teacher, 'LEAD'], ...withMarked.map((who) => [who, 'ASSISTANT'] as [Person, string])]);
    const callB = await call('LESSON', 'TKB', [pb1, pb2], []);
    const callC = await call('LESSON', 'TKC', [pc1], [[colleague, 'LEAD']]);
    await owner.query(
      `UPDATE "CrisisAlarms" SET "startedAt" = now() - make_interval(mins => $2::int),
              "endedAt" = CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(mins => $3::int) END,
              "listsSealedAt" = now() - make_interval(mins => $2::int)
        WHERE id = $1`,
      [alarm.id, startedMinutesAgo, endedMinutesAgo],
    );
    alarms[name] = { id: alarm.id, gA: callA, gB: callB, gC: callC };
  };
  await owner.query(`ALTER TABLE "CrisisAlarms" DISABLE TRIGGER "CrisisAlarms_a_born_open"`);
  await owner.query(`ALTER TABLE "CrisisAlarms" DISABLE TRIGGER "CrisisAlarms_b_ends_once"`);
  try {
    // Oldest first, each ended before the next is born (one alarm of a mode is open at a time).
    await plant('old', 3 * 24 * 60 + 20, 3 * 24 * 60, [sched, exp]);
    await plant('e66', 100, 66, [sched, exp]);
    await plant('e54', 90, 54, [sched, exp]);
    await plant('live', 20, null, [sched, exp]);
  } finally {
    await owner.query(`ALTER TABLE "CrisisAlarms" ENABLE TRIGGER "CrisisAlarms_a_born_open"`);
    await owner.query(`ALTER TABLE "CrisisAlarms" ENABLE TRIGGER "CrisisAlarms_b_ends_once"`);
  }

  // The mark, as the product sets it (a decider, on a person with a post).
  for (const who of [sched, exp, lone]) await setMark(who, true);
  assert.deepEqual(await Promise.all([sched, exp, lone].map(teachesNow)), [true, true, true], 'the mark is set (a proof of "unchanged" must show that the thing changed)');

  /** What the phone is shown of the alarms: the alarms, their groups and each group's pupils; colleagues differ between two people and are left out. */
  const shown = (view: Awaited<ReturnType<CrisisService['mine']>>) =>
    view.alarms.map((alarm) => ({ id: alarm.id, calls: alarm.calls.map((c) => ({ group: c.groupName, pupils: c.pupils.map((p) => p.studentId).sort() })) }));

  await check('(tk-a) the twin test: a marked administrator is shown the alarms and groups a teacher is, not the school\'s; the narrowing is the gateway\'s, since the database admits an administrator everything', async () => {
    const asTeacher = await crisis.mine(teacher);
    const asMarked = await crisis.mine(sched);
    // The two in the window (newest first), and in each only the group the person answers for.
    assert.deepEqual(asTeacher.alarms.map((a) => a.id), [alarms.live.id, alarms.e54.id], 'a teacher reads the alarm that is going and the one that ended 54 minutes ago');
    assert.deepEqual(shown(asMarked), shown(asTeacher), 'a marked administrator reads what a teacher reads');
    assert.deepEqual(
      shown(asMarked)[0]!.calls,
      [{ group: 'TKA', pupils: [pa1.userId, pa2.userId].sort() }],
      'in the alarm that is going: the one group both answer for, not the group nobody answers for nor the colleague\'s',
    );
    // The control that makes it the gateway's: the database lets an administrator read every alarm and every group of the school.
    const database = await api.withRls(sched, async (tx) => ({ alarms: await tx.crisisAlarm.count(), calls: await tx.crisisCall.count() }));
    assert.deepEqual(database, { alarms: 4, calls: 12 }, 'row-level security gives an administrator the whole school: four alarms, twelve groups');
    // The marked administrator with no group: the alarms in the window, with nobody to answer for.
    const asLone = await crisis.mine(lone);
    assert.deepEqual(asLone.alarms.map((a) => a.id), [alarms.live.id, alarms.e54.id]);
    assert.ok(asLone.alarms.every((a) => a.calls.length === 0), 'no group in either alarm');

    // searchPupils: the pupils outside the person's own lists, which is not nothing, and the same as the teacher's.
    const found = async (who: Person, alarmId: string) => (await crisis.searchPupils(alarmId, 'Probe', who)).map((p) => p.studentId).sort();
    const teacherList = await found(teacher, alarms.live.id);
    const markedList = await found(sched, alarms.live.id);
    assert.deepEqual(markedList, teacherList);
    assert.deepEqual(markedList, [pb1.userId, pb2.userId, pc1.userId].sort(), 'the pupils of the group nobody answers for and of the colleague\'s, and not the person\'s own two');
    assert.deepEqual(await found(lone, alarms.live.id), [pa1.userId, pa2.userId, pb1.userId, pb2.userId, pc1.userId].sort(), 'with no group of their own, every pupil is to be found');
    // An alarm that ended 66 minutes ago is not theirs to read, as it is not a teacher's; one that ended 54 minutes ago is.
    for (const who of [teacher, sched]) {
      const e = problemOf(await refusalOf(crisis.searchPupils(alarms.e66.id, 'Probe', who)));
      assert.equal(e.status, 404, `${who.role} reading an alarm that ended 66 minutes ago`);
    }
    assert.equal((await found(sched, alarms.e54.id)).length, 3);
  });

  await check('(tk-b) the marks: a marked schemaläggare and expedition mark their own group in a school whose list leaves them out, and nobody else\'s; unmarked, not even their own; full and rektor always', async () => {
    const mark = (who: Person, callId: string, studentId: string) =>
      crisis.markMine([{ id: randomUUID(), callId, studentId, state: 'FOUND', at: new Date().toISOString() } as never], who);
    const stamped = async (studentId: string) =>
      one<{ byUserId: string; onBehalf: boolean }>(`SELECT "byUserId", "onBehalf" FROM "CrisisReports" WHERE "studentId" = $1 AND "alarmId" = $2 ORDER BY "receivedAt" DESC LIMIT 1`, [studentId, alarms.live.id]);
    for (const [who, pupil] of [[sched, pa1], [exp, pa2]] as Array<[Person, Person]>) {
      assert.deepEqual(await mark(who, alarms.live.gA, pupil.userId), { stored: 1, duplicates: 0, unresolved: [] }, `${who.adminProfile} marked, their own group`);
      assert.deepEqual(await stamped(pupil.userId), { byUserId: who.userId, onBehalf: false }, 'in their own name, for themselves');
      const refused = problemOf(await refusalOf(mark(who, alarms.live.gB, pb1.userId)));
      assert.deepEqual([refused.status, refused.code], [403, 'CRISIS_NOT_YOURS'], `${who.adminProfile} marked, a group they do not answer for`);
      const refusedColleague = problemOf(await refusalOf(mark(who, alarms.live.gC, pc1.userId)));
      assert.deepEqual([refusedColleague.status, refusedColleague.code], [403, 'CRISIS_NOT_YOURS'], `${who.adminProfile} marked, a colleague's group`);
    }
    // Unmarked, not even their own: the list leaves them out (as before this change).
    await setMark(sched, false);
    assert.equal(await teachesNow(sched), false);
    const refusedPlain = problemOf(await refusalOf(mark(sched, alarms.live.gA, pa2.userId)));
    assert.deepEqual([refusedPlain.status, refusedPlain.code], [403, 'CRISIS_NOT_YOURS'], 'unmarked, their own group');
    await setMark(sched, true);
    // Full and rektor mark any group, on behalf of the management: the administrator's arm, as before.
    for (const who of [full, rektor]) {
      assert.deepEqual(await mark(who, alarms.live.gB, pb1.userId), { stored: 1, duplicates: 0, unresolved: [] }, `${who.adminProfile}, a group nobody answers for`);
      assert.deepEqual(await stamped(pb1.userId), { byUserId: who.userId, onBehalf: true });
    }
    // A teacher is as before: their own, and a colleague's group is not even there for them to name (row-level security hides the call, so the
    // mark is "unresolved" and nothing is stored); an administrator reads every call, names it, and is refused by the database (403, above).
    assert.deepEqual(await mark(teacher, alarms.live.gA, pa1.userId), { stored: 1, duplicates: 0, unresolved: [] });
    const colleaguesGroup = await mark(teacher, alarms.live.gC, pc1.userId);
    assert.deepEqual([colleaguesGroup.stored, colleaguesGroup.unresolved.length], [0, 1]);
  });

  // ---- rapporteringsgrad: the lessons ----
  const reportingDay = (await one<{ d: string }>(`SELECT (current_date - CASE extract(isodow FROM current_date)::int WHEN 6 THEN 1 WHEN 7 THEN 2 ELSE 0 END)::text AS d`)).d;
  const lessonOf = async (who: Person, daysBefore: number, hour: number, saved: boolean): Promise<string> => {
    const l = await one<{ id: string }>(
      `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
       VALUES ($1, $2, $3, $4::date - $5::int, (($4::date - $5::int) + make_time($6::int, 0, 0)) AT TIME ZONE 'Europe/Stockholm',
               (($4::date - $5::int) + make_time($6::int, 50, 0)) AT TIME ZONE 'Europe/Stockholm', 'SCHEDULED', now()) RETURNING id`,
      [s, subject, gA, reportingDay, daysBefore, hour],
    );
    await owner.query(`INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, 'LEAD')`, [s, l.id, who.userId]);
    if (saved) await owner.query(`INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "updatedAt") VALUES ($1, $2, $3, 'PRESENT', now())`, [s, l.id, pa1.userId]);
    return l.id;
  };
  const schedLessons = [await lessonOf(sched, 3, 8, false), await lessonOf(sched, 4, 8, false), await lessonOf(sched, 5, 8, true)];
  await lessonOf(plain, 3, 9, false);
  await lessonOf(plain, 4, 9, false);
  await lessonOf(teacher, 3, 10, false);
  await lessonOf(teacher, 4, 10, false);
  await owner.query(`ALTER TABLE "ReportingSettings" DISABLE TRIGGER "ReportingSettings_stamp"`);
  try {
    await owner.query(
      `INSERT INTO "ReportingSettings" ("schoolId", "teacherReminders", "teacherRemindersOn", "openAfterDays", "updatedAt") VALUES ($1, true, $2::date - 40, 2, now())`,
      [s, reportingDay],
    );
  } finally {
    await owner.query(`ALTER TABLE "ReportingSettings" ENABLE TRIGGER "ReportingSettings_stamp"`);
  }
  // The night's count is of a day that is over: yesterday (the lessons are three days back and more).
  const yesterday = (await one<{ d: string }>(`SELECT (current_date - 1)::text AS d`)).d;
  const compute = () => api.withDeliveryService((tx) => tx.$queryRaw`SELECT * FROM app.reporting_compute(${s}::uuid, ${yesterday}::date)`);
  const remind = () => api.withDeliveryService((tx) => tx.$queryRaw`SELECT * FROM app.reporting_remind(${s}::uuid, ${reportingDay}::date)`);
  const daysOf = async (who: Person) =>
    one<{ held: string; reported: string }>(
      `SELECT coalesce(sum(held), 0)::text AS held, coalesce(sum(reported), 0)::text AS reported FROM "TeacherReportingDays" WHERE "schoolId" = $1 AND "teacherId" = $2`,
      [s, who.userId],
    );

  await check('(tk-c) rapporteringsgrad: a lesson counts to a marked administrator from the first count after the mark (the retroactivity), the reminder reaches them and not an unmarked one, and their page has their lessons and share', async () => {
    // Before the mark: the lessons of the schemaläggare (not marked now) and of the unmarked administrator are nobody's to report.
    await setMark(sched, false);
    assert.equal(await teachesNow(sched), false);
    await compute();
    assert.deepEqual(await daysOf(sched), { held: '0', reported: '0' }, 'unmarked: nothing is counted as theirs');
    assert.deepEqual(await daysOf(plain), { held: '0', reported: '0' });
    assert.deepEqual(await daysOf(teacher), { held: '2', reported: '0' }, 'the teacher beside them is counted, as ever');
    // The mark, and the next count takes in the last 90 days at once: three lessons held, one with its register saved.
    await setMark(sched, true);
    assert.equal(await teachesNow(sched), true);
    await compute();
    assert.deepEqual(await daysOf(sched), { held: '3', reported: '1' }, 'marked: the lessons they stand on, the first count after the mark');
    assert.deepEqual(await daysOf(plain), { held: '0', reported: '0' }, 'an unmarked administrator with lessons of their own is still nobody\'s to count');
    assert.deepEqual(await daysOf(teacher), { held: '2', reported: '0' });
    // Their page: the open lessons (the two without a register), newest first, and their share.
    const page = await reporting.mine(sched);
    assert.deepEqual(
      page.open.map((l) => l.lessonId),
      [schedLessons[0], schedLessons[1]],
      'the two lessons waiting for their register, the newest first',
    );
    assert.equal(page.year?.held, 3);
    assert.equal(page.year?.reported, 1);
    // An unmarked administrator is asked the same and gets nothing: the database does not count them.
    const plainPage = await reporting.mine(plain);
    assert.deepEqual(plainPage.open, []);
    assert.equal(plainPage.year?.held ?? 0, 0);
    // The reminder is written for the marked administrator and the teacher, never for the unmarked one.
    await remind();
    const reminded = async (who: Person) => count(`SELECT count(*) AS n FROM "Notifications" WHERE "schoolId" = $1 AND "userId" = $2 AND type = 'LESSON_REPORT_REMINDER'`, [s, who.userId]);
    assert.equal(await reminded(sched), 1, 'the marked administrator is reminded');
    assert.equal(await reminded(teacher), 1);
    assert.equal(await reminded(plain), 0, 'the unmarked administrator is not');
    const meta = (await one<{ meta: { count: number } }>(`SELECT meta FROM "Notifications" WHERE "schoolId" = $1 AND "userId" = $2 AND type = 'LESSON_REPORT_REMINDER'`, [s, sched.userId])).meta;
    assert.equal(meta.count, 2, 'one reminder, for the two lessons without a register');
    // The mark taken away: the next count takes them out again, and the person is no teacher's to count.
    await setMark(sched, false);
    await compute();
    assert.deepEqual(await daysOf(sched), { held: '0', reported: '0' }, 'unmarked again: the next count takes them out');
    await setMark(sched, true);
  });

  // ---- mentor ----
  const monday = (await one<{ d: string }>(`SELECT (date_trunc('week', current_date) + interval '7 days')::date::text AS d`)).d;
  await owner.query(`INSERT INTO "LeaveDelegationDecisions" ("schoolId", "mentorMaxSchoolDays", reference) VALUES ($1, 3, 'probe')`, [s]);
  await owner.query(
    `INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "updatedAt")
     VALUES ($1, $2, $3, 'MENTORSKAP', 'Mentor TKB', 60, $4, now()), ($1, $5, $3, 'MENTORSKAP', 'Mentor TKB 2', 60, $4, now())`,
    [s, ment.userId, year, gB, ment2.userId],
  );
  const request = async (pupil: Person, status = 'PENDING'): Promise<string> =>
    (
      await one<{ id: string }>(
        `INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason, status, "decidedById", "decidedAt", "decidedAs")
         VALUES ($1, $2, $2, $3::date, $3::date + 1, 'probe', $4::"LeaveRequestStatus", CASE WHEN $4 = 'PENDING' THEN NULL ELSE $5::uuid END,
                 CASE WHEN $4 = 'PENDING' THEN NULL ELSE now() END, CASE WHEN $4 = 'PENDING' THEN NULL ELSE 'ADMIN'::"LeaveDeciderRole" END) RETURNING id`,
        [s, pupil.userId, monday, status, full.userId],
      )
    ).id;
  const waiting = await request(pb1);
  const decided = await request(pb2, 'APPROVED');
  const noticesOf = (who: Person) => count(`SELECT count(*) AS n FROM "Notifications" WHERE "schoolId" = $1 AND "userId" = $2 AND type = 'LEAVE_REQUESTED'`, [s, who.userId]);

  await check('(tk-d) mentor: the mark tells the new mentor of a request they were never told of, once; they pass it on as the deciding mentor (a second is 409, one somebody else decided is 409); an unmarked mentor is no mentor and passes nothing on', async () => {
    assert.equal(await teachesNow(ment), false);
    assert.equal(await noticesOf(ment), 0, 'no notice before the mark: an administrator was no mentor');
    assert.equal(await noticesOf(ment2), 0);
    await setMark(ment, true);
    assert.equal(await teachesNow(ment), true);
    assert.equal(await noticesOf(ment), 1, 'the mark made them a mentor, and UsersService.update told them of the pending request');
    assert.equal(await noticesOf(ment2), 0, 'an unmarked administrator with the same duty is told nothing');
    // The same value again asks nothing (the People page sends the field with every save).
    await setMark(ment, true);
    assert.equal(await noticesOf(ment), 1, 'a value that did not change tells nobody again');
    // The request a pupil of their class filed is theirs to pass on, once.
    assert.deepEqual(await leave.referLeaveRequest(waiting, ment), { id: waiting, referred: true });
    const referred = await one<{ referredById: string; status: string }>(`SELECT "referredById", status FROM "LeaveRequests" WHERE id = $1`, [waiting]);
    assert.deepEqual(referred, { referredById: ment.userId, status: 'PENDING' }, 'passed on to rektor, still pending');
    assert.equal(problemOf(await refusalOf(leave.referLeaveRequest(waiting, ment))).status, 409, 'a second time');
    // One somebody else already decided.
    assert.equal(problemOf(await refusalOf(leave.referLeaveRequest(decided, ment))).status, 409, 'a request already decided');
    // An administrator who is not the pupil's deciding mentor passes nothing on, marked or not: the database says the request is not theirs
    // (leave_request_refer is false), and the service answers 409 as for any request that is not the caller's to pass on (an administrator
    // reads every request, so the 404 a teacher gets for one that is not theirs is not asked). The unmarked administrator with the same
    // MENTORSKAP is no mentor, as before this change, and reaches the route only here, at the service: the guard keeps them out of it.
    const another = await request(pb1);
    const passedOn = async () => (await one<{ referredAt: Date | null }>(`SELECT "referredAt" FROM "LeaveRequests" WHERE id = $1`, [another])).referredAt;
    assert.equal(problemOf(await refusalOf(leave.referLeaveRequest(another, ment2))).status, 409, 'an unmarked administrator with the same duty');
    assert.equal(problemOf(await refusalOf(leave.referLeaveRequest(another, plain))).status, 409, 'an administrator with no duty');
    assert.equal(problemOf(await refusalOf(leave.referLeaveRequest(another, lone))).status, 409, 'a marked administrator who is no mentor of the pupil');
    assert.equal(await passedOn(), null, 'none of them passed it on');
    await setMark(ment, false);
    assert.equal(problemOf(await refusalOf(leave.referLeaveRequest(another, ment))).status, 409, 'unmarked again, they are no mentor again');
    assert.equal(await passedOn(), null);
    await setMark(ment, true);
    assert.deepEqual(await leave.referLeaveRequest(another, ment), { id: another, referred: true }, 'marked again, they are');
    assert.notEqual(await passedOn(), null);
  });
}
