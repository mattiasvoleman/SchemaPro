/**
 * The adapter probe's checks for Rapporteringsgrad (20270108090000–20270108090100),
 * through the real ReportingRateService, ReportingRateJob and JobRunner, and the real
 * services that make the lessons it counts (AttendanceService's register save,
 * ScheduleActivitiesService's replacement lessons, CoverService's substitutes), on the
 * API's role against real Postgres as CI runs it. The RLS sections prove what the
 * functions and the arms do; this proves what the gateway and the adapter make of them:
 * the casts of the job's parameters, the date and integer columns read back, the sums
 * the view asks the database for, the read log and the notices the night hands over.
 * In a school of its own (slug <marker>-rapportering), swept whole before and after.
 *
 * The weeks are counted from `base`, a Monday four or five weeks back, so that the
 * night can be run for the Monday three weeks on and every lesson has ended:
 *
 *   W1  base          Anna: a saved register, an open lesson, one whose register holds
 *                     only UNKNOWN, a lesson on a day she is away that nobody has
 *                     decided; Bo: two saved lessons and the replacement lesson of an
 *                     activity (he is responsible for it); Cecilia: the two lessons
 *                     the activity cancelled (with registers, which count for no one)
 *                     and a lesson she took as the substitute of Anna's, saved
 *   W2  base + 7      a lov: the week's lessons are cancelled, saved or not
 *   W3  base + 14     Anna one saved and one open lesson, Bo one saved, Cecilia one open
 *
 *   ra  the page: both switches off and two days until turned on, dated with the
 *       school's own day, and a limit of 31 or 0 refused by the table;
 *   rb  the definition through the real register save and the real services: what
 *       a held lesson with a saved register is, a cancelled lesson with a register
 *       is nobody's, a replacement lesson is its responsible teacher's, a
 *       substitute's lesson is the substitute's and not the absent teacher's;
 *   rc  the night through ReportingRateJob.runSchool for the Monday after W3: the
 *       days are stored, the reminders go to the two teachers with open lessons,
 *       rektor gets W3's totals, nothing names anyone, and a second night changes
 *       nothing;
 *   rd  the view: a week, a lov week, the läsår, sorted lowest share first, with the
 *       read recorded as employment and people; a teacher reads their own days alone;
 *       a pupil and a guardian read nothing;
 *   re  the teacher's own page: the open lessons with the limit applied, newest
 *       first, and their own läsår;
 *   rf  the runner's glue: the school is on the job's list, its night is claimed once;
 *   rg  summer time and a lov in March, and the end of summer time in October, counted
 *       to the day through the service: a week across the switch is seven calendar
 *       days, a lesson at midnight is Monday's, an absence across the night overlaps
 *       by the clock and not by the date.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { AttendanceService } from '../../src/attendance/attendance.service';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { CalendarLessonsService } from '../../src/calendar/calendar-lessons.service';
import { CoverService } from '../../src/cover/cover.service';
import type { PrismaService } from '../../src/database/prisma.service';
import { JobRunner } from '../../src/jobs/job-runner';
import { NotificationDeliveryService } from '../../src/notifications/notification-delivery.service';
import type { OutboxEntry } from '../../src/notifications/notification-outbox';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { ScheduleActivitiesService } from '../../src/publication/schedule-activities.service';
import { REPORTING_RATE_JOB } from '../../src/reporting-rate/reporting-rate';
import { ReportingRateJob } from '../../src/reporting-rate/reporting-rate.job';
import { ReportingRateService } from '../../src/reporting-rate/reporting-rate.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function reportingRateSlug(marker: string): string {
  return `${marker}-rapportering`;
}

export async function sweepReportingRateSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "JobClaims" WHERE job = $1 AND "schoolId" IN (SELECT id FROM "Schools" WHERE slug = $2)`, [REPORTING_RATE_JOB, reportingRateSlug(marker)]);
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [reportingRateSlug(marker)]);
}

export async function reportingRateChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepReportingRateSchool(owner, marker);
  const rows = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await rows<T>(sql, params))[0]!;
  const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await one<{ n: string }>(sql, params)).n);
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;
  const base = (await one<{ d: string }>(`SELECT date_trunc('week', $1::date - 28)::date::text AS d`, [today])).d;
  const day = async (n: number): Promise<string> => (await one<{ d: string }>(`SELECT ($1::date + $2::int)::text AS d`, [base, n])).d;
  const dayOf = async (from: string, n: number): Promise<string> => (await one<{ d: string }>(`SELECT ($1::date + $2::int)::text AS d`, [from, n])).d;

  const s = (
    await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [
      `${marker} rapportering`,
      reportingRateSlug(marker),
    ])
  ).id;
  try {
    const year = await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
       VALUES ($1, 'probe rapportering', $2::date - 120, $2::date + 300, true, 'NIOARIG', now()) RETURNING id`,
      [s, today],
    );
    const group = (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, 'RP7A', 'CLASS', 7, now()) RETURNING id`,
        [s, year.id],
      )
    ).id;
    const subject = async (name: string, code: string, counts: boolean) =>
      (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "countsTowardTimplan", "updatedAt") VALUES ($1, $2, $3, $4, now()) RETURNING id`, [s, name, code, counts])).id;
    const matte = await subject('Matte', 'RPMA', true);
    const temadag = await subject('Temadag', 'RPTD', false);

    const person = async (role: string, label: string, groupId: string | null = null, adminProfile: string | null = null): Promise<AuthenticatedUser> => {
      const authId = randomUUID();
      const row = await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "adminProfile", "updatedAt")
         VALUES ($1, $2, $3, 'Probe', $4, $5, true, $6, $7::"AdminProfile", now()) RETURNING id`,
        [s, `${marker}-rapportering-${label}@example.invalid`, label, role, authId, groupId, adminProfile],
      );
      return {
        authId,
        role: role as Role,
        userId: row.id,
        schoolId: s,
        channel: role === 'TEACHER' ? 'APP' : 'WEB',
        ...(role === 'SCHOOL_ADMIN' ? { adminProfile: adminProfile as never, hrRead: false } : {}),
      };
    };
    const admin = await person('SCHOOL_ADMIN', 'Admin', null, 'FULL');
    const rektor = await person('SCHOOL_ADMIN', 'Rektor', null, 'REKTOR');
    const expedition = await person('SCHOOL_ADMIN', 'Expedition', null, 'EXPEDITION');
    const anna = await person('TEACHER', 'Anna');
    const bo = await person('TEACHER', 'Bo');
    const cecilia = await person('TEACHER', 'Cecilia');
    const dag = await person('TEACHER', 'Dag');
    const eva = await person('TEACHER', 'Eva');
    const elev1 = await person('STUDENT', 'Elev1', group);
    const elev2 = await person('STUDENT', 'Elev2', group);
    const guardian = await person('GUARDIAN', 'Vardnadshavare');
    await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3)`, [s, guardian.userId, elev1.userId]);
    const pupils = [elev1, elev2].map((p) => p.userId!);
    const uid = (p: AuthenticatedUser) => p.userId!;

    const realtime = {
      notifyLessonChanged: async () => undefined,
      notifyLessonsChanged: async () => undefined,
      notifyCoverBoardChanged: () => undefined,
    } as unknown as RealtimeService;
    const notices = new NotificationsService(api, new NotificationDeliveryService(api));
    const attendance = new AttendanceService(api, notices);
    const activities = new ScheduleActivitiesService(api, realtime, notices);
    const cover = new CoverService(api, realtime, notices, new CalendarLessonsService(api, realtime, notices));
    const service = new ReportingRateService(api);

    /** A lesson of one hour from `hour` (local) on `date` for a teacher, as publish leaves it, with a master. */
    const lesson = async (date: string, hour: number, teachers: AuthenticatedUser[], opts: { status?: string; cause?: string; subjectId?: string } = {}): Promise<string> => {
      const subjectId = opts.subjectId ?? matte;
      const id = (
        await one<{ id: string }>(
          `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "cancelCause", "updatedAt")
           VALUES ($1, $2, $3, $4::date, ($4::date + make_time($5::int, 0, 0)) AT TIME ZONE 'Europe/Stockholm',
                   ($4::date + make_time($5::int, 50, 0)) AT TIME ZONE 'Europe/Stockholm', $6::"LessonStatus", $7::"LessonCancelCause", now()) RETURNING id`,
          [s, subjectId, group, date, hour, opts.status ?? 'SCHEDULED', opts.cause ?? null],
        )
      ).id;
      const master = (
        await one<{ id: string }>(
          `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, extract(isodow FROM $6::date)::int, make_time($7::int, 0, 0), make_time($7::int, 50, 0), now()) RETURNING id`,
          [s, year.id, subjectId, group, teachers[0]?.userId ?? null, date, hour],
        )
      ).id;
      await owner.query(`UPDATE "CalendarLessons" SET "masterLessonId" = $2 WHERE id = $1`, [id, master]);
      for (const [index, teacher] of teachers.entries()) {
        await owner.query(
          `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, $4::"TeacherAssignmentRole")`,
          [s, id, teacher.userId, index === 0 ? 'LEAD' : 'ASSISTANT'],
        );
      }
      return id;
    };
    /** The register as the teacher saves it: through the real service. */
    const save = (lessonId: string, teacher: AuthenticatedUser, statuses: Array<'PRESENT' | 'ABSENT' | 'UNKNOWN'>) =>
      attendance.reportAttendance({ calendarLessonId: lessonId, records: statuses.map((status, i) => ({ studentId: pupils[i]!, status })) }, teacher);
    const mark = (lessonId: string) =>
      owner.query(
        `INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "updatedAt") VALUES ($1, $2, $3, 'PRESENT', now()), ($1, $2, $4, 'PRESENT', now())`,
        [s, lessonId, pupils[0], pupils[1]],
      );
    /** Moves lessons to another date by whole days, keeping the school's wall clock. */
    const shift = (ids: string[], days: number) =>
      owner.query(
        `UPDATE "CalendarLessons" SET date = date + $2::int,
                "startsAt" = (("startsAt" AT TIME ZONE 'Europe/Stockholm') + $2::int * interval '1 day') AT TIME ZONE 'Europe/Stockholm',
                "endsAt" = (("endsAt" AT TIME ZONE 'Europe/Stockholm') + $2::int * interval '1 day') AT TIME ZONE 'Europe/Stockholm'
          WHERE id = ANY($1::uuid[])`,
        [ids, days],
      );

    await check('(ra) the page: both off with two days until turned on, dated with the school\'s own day; the table refuses a limit outside 1-30', async () => {
      const before = await service.settings(admin);
      assert.deepEqual(before, { teacherReminders: false, rektorDigest: false, openAfterDays: 2 });
      assert.equal(await count(`SELECT count(*) AS n FROM "ReportingSettings" WHERE "schoolId" = $1`, [s]), 0, 'reading the page wrote a row');
      // An empty save is no save: it writes nothing.
      assert.deepEqual(await service.updateSettings({}, admin), before);
      assert.equal(await count(`SELECT count(*) AS n FROM "ReportingSettings" WHERE "schoolId" = $1`, [s]), 0);
      const on = await service.updateSettings({ teacherReminders: true, rektorDigest: true, openAfterDays: 2 }, admin);
      assert.deepEqual(on, { teacherReminders: true, rektorDigest: true, openAfterDays: 2 });
      const stamped = await one<{ a: string; b: string }>(`SELECT "teacherRemindersOn"::text AS a, "rektorDigestOn"::text AS b FROM "ReportingSettings" WHERE "schoolId" = $1`, [s]);
      assert.deepEqual([stamped.a, stamped.b], [today, today], 'the switches were not dated with the school\'s own day');
      // The teacher reads the limit but is not the one who writes it.
      assert.equal((await service.settings(anna)).openAfterDays, 2);
      await assert.rejects(service.updateSettings({ openAfterDays: 31 }, admin), /open_after_days_is_sane|openAfterDays/);
      await assert.rejects(service.updateSettings({ openAfterDays: 0 }, admin), /open_after_days_is_sane|openAfterDays/);
      assert.equal((await service.settings(admin)).openAfterDays, 2);
      // Turned off again and the row stays (never deleted); the night turns them on from here, back-dated below.
      assert.equal((await service.updateSettings({ teacherReminders: false, rektorDigest: false }, admin)).teacherReminders, false);
      assert.equal(await count(`SELECT count(*) AS n FROM "ReportingSettings" WHERE "schoolId" = $1`, [s]), 1);
      await service.updateSettings({ teacherReminders: true, rektorDigest: true }, admin);
    });

    // W1. Anna: a saved lesson, an open one, one whose register holds only UNKNOWN, and one on a day she is away
    // that nobody has decided on. Bo: two saved lessons.
    const a1 = await lesson(await day(0), 8, [anna]);
    const a2 = await lesson(await day(0), 9, [anna]);
    const a3 = await lesson(await day(0), 10, [anna]);
    await save(a1, anna, ['PRESENT', 'PRESENT']);
    await save(a3, anna, ['UNKNOWN', 'UNKNOWN']);
    const b1 = await lesson(await day(0), 11, [bo]);
    const b2 = await lesson(await day(0), 12, [bo]);
    await save(b1, bo, ['PRESENT', 'ABSENT']);
    await save(b2, bo, ['PRESENT', 'PRESENT']);
    const away = await lesson(await day(4), 9, [anna]);
    await save(away, anna, ['PRESENT', 'PRESENT']); // a register, but she is away: not hers to have taken
    await owner.query(
      `INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "updatedAt")
       VALUES ($1, $2, ($3::date + time '00:00') AT TIME ZONE 'Europe/Stockholm', ($3::date + 1) AT TIME ZONE 'Europe/Stockholm', now())`,
      [s, anna.userId, await day(4)],
    );

    // The activity and the substitute are made on days ahead, by the real services, and then moved back into W1.
    const nextMonday = (await one<{ d: string }>(`SELECT date_trunc('week', $1::date + 7)::date::text AS d`, [today])).d;
    const aheadTue = await dayOf(nextMonday, 1);
    const aheadThu = await dayOf(nextMonday, 3);
    const weeksBack = (await one<{ n: number }>(`SELECT ($1::date - $2::date)::int AS n`, [nextMonday, base])).n;

    // Cecilia teaches the two lessons the activity cancels. The activity takes lessons nobody has taken a register on, so
    // the registers are put on after: the lessons that were saved and then cancelled, which count for nobody.
    const c1 = await lesson(aheadTue, 8, [cecilia]);
    const c2 = await lesson(aheadTue, 10, [cecilia]);
    await check('(rb) a replacement lesson is its responsible teacher\'s, and the lessons it cancelled are nobody\'s, saved or not', async () => {
      const body = {
        academicYearId: year.id,
        name: 'Friluftsdag åk 7A',
        fromDate: aheadTue,
        toDate: aheadTue,
        scope: 'GROUPS' as const,
        groupIds: [group],
        replacementSubjectId: temadag,
        description: 'Samling vid skolgården',
        teachers: [{ studentGroupId: group, teacherId: bo.userId!, role: 'LEAD' as const }],
        credits: [{ subjectId: matte, minutes: 60 }],
      };
      const preview = await activities.preview(body, admin);
      const created = await activities.create({ ...body, expectedDigest: preview.digest }, admin);
      assert.equal(created.cancelled, 2);
      assert.equal(created.replacementLessons, 1);
      const replacement = await one<{ id: string }>(
        `SELECT cl.id FROM "ScheduleActivityLessons" sal JOIN "CalendarLessons" cl ON cl.id = sal."calendarLessonId" WHERE sal."activityId" = $1`,
        [created.activity.id],
      );
      assert.deepEqual(
        (await rows<{ teacherId: string }>(`SELECT "teacherId" FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = $1`, [replacement.id])).map((r) => r.teacherId),
        [bo.userId],
        'the replacement lesson has its responsible teacher and nobody else',
      );
      assert.equal((await rows(`SELECT 1 FROM "CalendarLessons" WHERE id = ANY($1::uuid[]) AND status = 'CANCELLED' AND "cancelCause" = 'EVENT'`, [[c1, c2]])).length, 2);
      await mark(c1);
      await mark(c2);
      // The responsible teacher opens the register of the replacement lesson and saves it, as on any lesson.
      await save(replacement.id, bo, ['PRESENT', 'PRESENT']);
      // Into W1, on its Tuesday.
      await shift([c1, c2, replacement.id], -weeksBack);

      // The substitute: Anna is away on a day ahead, the board puts Cecilia on her lesson, and Cecilia saves it.
      const l = await lesson(aheadThu, 13, [anna]);
      const absence = (
        await one<{ id: string }>(
          `INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "updatedAt")
           VALUES ($1, $2, ($3::date + time '00:00') AT TIME ZONE 'Europe/Stockholm', ($3::date + 1) AT TIME ZONE 'Europe/Stockholm', now()) RETURNING id`,
          [s, anna.userId, aheadThu],
        )
      ).id;
      await cover.decide(l, { absenceId: absence, kind: 'SUBSTITUTE', substituteId: cecilia.userId!, expected: 'OPEN' }, admin);
      assert.deepEqual(
        (await rows<{ teacherId: string; role: string }>(`SELECT "teacherId", role::text FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = $1`, [l])).map((r) => [r.teacherId, r.role]),
        [[cecilia.userId, 'SUBSTITUTE']],
        'the board replaced the absent teacher\'s row with the substitute\'s',
      );
      await save(l, cecilia, ['PRESENT', 'ABSENT']);
      await shift([l], -weeksBack);
      // That absence is a day ahead and is no longer anyone's to be judged by.
      await owner.query(`DELETE FROM "TeacherAbsences" WHERE id = $1`, [absence]);
    });

    // W2: a lov. The week's lessons are cancelled, with registers on some.
    await owner.query(
      `INSERT INTO "SchoolBreaks" ("schoolId", "academicYearId", name, kind, "startDate", "endDate", "updatedAt") VALUES ($1, $2, 'Höstlov', 'HOLIDAY', $3::date, $4::date, now())`,
      [s, year.id, await day(7), await day(11)],
    );
    for (const n of [7, 8, 9, 10, 11]) {
      const x = await lesson(await day(n), 8, [anna], { status: 'CANCELLED', cause: 'MANUAL' });
      const y = await lesson(await day(n), 9, [bo], { status: 'CANCELLED', cause: 'MANUAL' });
      if (n % 2 === 1) {
        await mark(x);
        await mark(y);
      }
    }
    // W3: Anna one saved and one open; Bo one saved; Cecilia one open (on the Friday).
    const w3a = await lesson(await day(14), 8, [anna]);
    await save(w3a, anna, ['PRESENT', 'PRESENT']);
    await lesson(await day(17), 9, [anna]);
    const w3b = await lesson(await day(15), 8, [bo]);
    await save(w3b, bo, ['PRESENT', 'PRESENT']);
    await lesson(await day(18), 8, [cecilia]);

    // The night for the Monday after W3. The switches are dated back to the start of W1 so that W1's lessons count.
    await owner.query(`ALTER TABLE "ReportingSettings" DISABLE TRIGGER "ReportingSettings_stamp"`);
    await owner.query(`UPDATE "ReportingSettings" SET "teacherRemindersOn" = $2::date, "rektorDigestOn" = $2::date WHERE "schoolId" = $1`, [s, base]);
    await owner.query(`ALTER TABLE "ReportingSettings" ENABLE TRIGGER "ReportingSettings_stamp"`);
    const delivered: OutboxEntry[] = [];
    const notifications = { deliverCommitted: (entries: readonly OutboxEntry[]) => delivered.push(...entries) } as unknown as NotificationsService;
    const runner = new JobRunner(api);
    const job = new ReportingRateJob(api, notifications, undefined, runner);
    const monday = await day(21);
    const localDay = new Date(`${monday}T00:00:00Z`);

    await check('(rc) one night: the days are stored, the two teachers with open lessons are reminded once, rektor gets the week\'s totals, nobody is named, and a second night changes nothing', async () => {
      const counts = await job.runSchool(s, localDay);
      // W1: Anna 3 held 1 reported; Bo 3/3; Cecilia 1/1 (the substitute lesson); W3: Anna 2 held 1 reported, Bo 1/1, Cecilia 1 held 0 reported.
      assert.equal(counts.held, 7 + 4);
      assert.equal(counts.reported, 5 + 2);
      assert.equal(counts.reminders, 2, 'Anna and Cecilia');
      assert.equal(counts.digests, 1);
      assert.equal(counts.notices, 2, 'rektor and the full administrator');
      const stored = (
        await rows<{ who: string; d: string; held: number; reported: number }>(
          `SELECT u."firstName" AS who, d.day::text AS d, d.held, d.reported FROM "TeacherReportingDays" d JOIN "Users" u ON u.id = d."teacherId" WHERE d."schoolId" = $1 ORDER BY d.day, u."firstName"`,
          [s],
        )
      ).map((r) => `${r.d} ${r.who} ${r.reported}/${r.held}`);
      assert.deepEqual(
        stored,
        [
          `${await day(0)} Anna 1/3`,
          `${await day(0)} Bo 2/2`,
          `${await day(1)} Bo 1/1`,
          `${await day(3)} Cecilia 1/1`,
          `${await day(14)} Anna 1/1`,
          `${await day(15)} Bo 1/1`,
          `${await day(17)} Anna 0/1`,
          `${await day(18)} Cecilia 0/1`,
        ],
        'the stored days: no row for the cancelled lessons, the lov, or the day Anna was away',
      );

      // The reminders: Anna's two open lessons of W1 (the third has an UNKNOWN register, the fourth is on a day she was away) and W3's, Cecilia's Friday.
      const reminders = delivered.filter((entry) => entry.type === 'LESSON_REPORT_REMINDER');
      assert.equal(reminders.length, 2);
      const byUser = new Map(reminders.map((entry) => [entry.recipients[0]!.userId, entry.meta]));
      assert.deepEqual(byUser.get(anna.userId!), { count: 3, limitDays: 2 });
      assert.deepEqual(byUser.get(cecilia.userId!), { count: 1, limitDays: 2 });
      assert.ok(!byUser.has(bo.userId!), 'Bo has no open lesson');
      for (const entry of reminders) {
        assert.doesNotMatch(entry.email!.body, /Matte|Probe|RP7A|@/, 'a reminder named a subject, a class or a person');
        assert.equal(entry.schoolId, s);
      }
      assert.equal(await count(`SELECT count(*) AS n FROM "ReportingReminders" WHERE "schoolId" = $1`, [s]), 4);
      // The week's notice: W3's totals, to rektor and the full administrator alone.
      const digests = delivered.filter((entry) => entry.type === 'REPORTING_RATE_DIGEST');
      assert.deepEqual(digests.flatMap((entry) => entry.recipients.map((r) => r.userId)).sort(), [admin.userId, rektor.userId].sort());
      for (const entry of digests) {
        assert.deepEqual(entry.meta, { periodStart: await day(14), periodEnd: await day(20), held: 4, reported: 2, teachers: 3 });
        assert.doesNotMatch(entry.email!.body, /Probe|Anna|Bo|Cecilia|@/, 'the notice named someone');
      }
      assert.ok(!digests.some((entry) => entry.recipients.some((r) => r.userId === expedition.userId)), 'expedition is not told');
      assert.equal(await count(`SELECT count(*) AS n FROM "Notifications" WHERE "schoolId" = $1 AND type IN ('LESSON_REPORT_REMINDER', 'REPORTING_RATE_DIGEST')`, [s]), 4);
      assert.equal(await count(`SELECT count(*) AS n FROM "ReportingDigests" WHERE "schoolId" = $1 AND "periodEnd" = $2::date`, [s, await day(20)]), 1);

      // The same night again: the count finds the same, and nobody is told twice.
      delivered.length = 0;
      const again = await job.runSchool(s, localDay);
      assert.deepEqual([again.written, again.removed, again.reminders, again.digests, again.notices], [0, 0, 0, 0, 0]);
      assert.equal(delivered.length, 0);
      assert.equal(await count(`SELECT count(*) AS n FROM "ReportingReminders" WHERE "schoolId" = $1`, [s]), 4);
    });

    await check('(rd) the view: a week, a lov week and the läsår, the lowest share first; the read is in the log; each reader sees what is theirs', async () => {
      const beforeLog = await count(`SELECT count(*) AS n FROM "PersonalDataAccess" WHERE "schoolId" = $1 AND kind IN ('EMPLOYMENT', 'PEOPLE')`, [s]);
      const w1 = await service.overview({ period: 'WEEK', anchor: await day(2) }, admin);
      assert.deepEqual([w1.from, w1.to, w1.previousAnchor, w1.nextAnchor, w1.yearName], [await day(0), await day(6), await day(-1), await day(7), null]);
      assert.deepEqual(w1.total, { held: 7, reported: 5 });
      assert.deepEqual(w1.teachers.map((t) => `${t.firstName} ${t.reported}/${t.held}`), ['Anna 1/3', 'Bo 3/3', 'Cecilia 1/1']);
      assert.equal(w1.through, await day(18), 'the last day the nights have counted');
      // The lov week has no held lesson: no teacher, no share.
      const w2 = await service.overview({ period: 'WEEK', anchor: await day(9) }, admin);
      assert.deepEqual(w2.total, { held: 0, reported: 0 });
      assert.deepEqual(w2.teachers, []);
      const w3 = await service.overview({ period: 'WEEK', anchor: await day(16) }, rektor);
      assert.deepEqual(w3.teachers.map((t) => `${t.firstName} ${t.reported}/${t.held}`), ['Cecilia 0/1', 'Anna 1/2', 'Bo 1/1']);
      assert.deepEqual(w3.total, { held: 4, reported: 2 });
      // The läsår holding the day: W1 and W3, the lov counted for no one.
      const full = await service.overview({ period: 'YEAR', anchor: await day(2) }, admin);
      assert.equal(full.yearName, 'probe rapportering');
      assert.deepEqual(full.total, { held: 11, reported: 7 });
      assert.deepEqual(full.teachers.map((t) => `${t.firstName} ${t.reported}/${t.held}`), ['Anna 2/5', 'Cecilia 1/2', 'Bo 4/4']);
      // A month holds the weeks that fall in it: the same days, added in the database.
      const monthAnchor = await day(2);
      const month = await service.overview({ period: 'MONTH', anchor: monthAnchor }, admin);
      const expected = await one<{ held: string; reported: string }>(
        `SELECT coalesce(sum(held), 0) AS held, coalesce(sum(reported), 0) AS reported FROM "TeacherReportingDays" WHERE "schoolId" = $1 AND day BETWEEN $2::date AND $3::date`,
        [s, month.from, month.to],
      );
      assert.deepEqual(month.total, { held: Number(expected.held), reported: Number(expected.reported) });
      // A day with no läsår: nothing, and no error.
      const outside = await service.overview({ period: 'YEAR', anchor: '2001-05-05' }, admin);
      assert.deepEqual([outside.from, outside.to, outside.yearName, outside.teachers.length], [null, null, null, 0]);

      // The read log: each of the views above that listed teachers wrote one row of employment and one of people.
      const afterLog = await count(`SELECT count(*) AS n FROM "PersonalDataAccess" WHERE "schoolId" = $1 AND kind IN ('EMPLOYMENT', 'PEOPLE')`, [s]);
      assert.ok(afterLog - beforeLog >= 2, "a view of other people's days left no row in the read log");
      const logged = await rows<{ kind: string; subjects: string[]; actor: string }>(
        `SELECT kind::text AS kind, "subjectIds"::text[] AS subjects, "actorId"::text AS actor FROM "PersonalDataAccess"
          WHERE "schoolId" = $1 AND kind IN ('EMPLOYMENT', 'PEOPLE') AND "actorId" = $2 ORDER BY "at"`,
        [s, admin.userId],
      );
      assert.ok(logged.some((row) => row.kind === 'EMPLOYMENT' && [anna.userId, bo.userId, cecilia.userId].every((id) => row.subjects.includes(id!))));
      assert.ok(logged.some((row) => row.kind === 'PEOPLE' && [anna.userId, bo.userId, cecilia.userId].every((id) => row.subjects.includes(id!))));

      // A teacher reads their own days alone, and a teacher's own page is not a read of other people.
      const before = await count(`SELECT count(*) AS n FROM "PersonalDataAccess" WHERE "schoolId" = $1`, [s]);
      const own = await service.overview({ period: 'YEAR', anchor: await day(2) }, anna);
      assert.deepEqual(own.teachers.map((t) => t.teacherId), [anna.userId]);
      assert.deepEqual(own.total, { held: 5, reported: 2 });
      const afterOwn = await count(`SELECT count(*) AS n FROM "PersonalDataAccess" WHERE "schoolId" = $1`, [s]);
      await service.mine(anna);
      assert.equal(await count(`SELECT count(*) AS n FROM "PersonalDataAccess" WHERE "schoolId" = $1`, [s]), afterOwn, 'a teacher\'s page about themself left a row in the read log');
      void before;
      // A pupil and a guardian read nothing; a teacher with no lesson in the period reads nothing.
      for (const reader of [elev1, guardian]) {
        const seen = await service.overview({ period: 'YEAR', anchor: await day(2) }, reader);
        assert.deepEqual([seen.total, seen.teachers], [{ held: 0, reported: 0 }, []], `a ${reader.role} read other people's days`);
      }
    });

    await check('(re) the teacher\'s own page: the open lessons with the limit applied, newest first, and their own läsår', async () => {
      // Two lessons of Anna's, one the day before (inside the limit) and one three days back (past it).
      const recent1 = await lesson(await dayOf(today, -1), 8, [anna]);
      const recent3 = await lesson(await dayOf(today, -3), 8, [anna]);
      const mine = await service.mine(anna);
      assert.equal(mine.openAfterDays, 2);
      assert.deepEqual(mine.year && [mine.year.name, mine.year.held, mine.year.reported], ['probe rapportering', 5, 2]);
      const ids = mine.open.map((item) => item.lessonId);
      assert.ok(ids.includes(recent1) && ids.includes(recent3));
      assert.equal(mine.open.find((item) => item.lessonId === recent1)!.overdue, false);
      assert.equal(mine.open.find((item) => item.lessonId === recent3)!.overdue, true);
      const limitDay = await dayOf(today, -2);
      assert.ok(mine.open.every((item) => item.overdue === (item.date <= limitDay)), 'overdue is the limit\'s days back or more');
      assert.ok(mine.open.every((item, i, all) => i === 0 || all[i - 1]!.startsAt >= item.startsAt), 'newest first');
      assert.equal(mine.open[0]!.subjectName, 'Matte');
      assert.equal(mine.open[0]!.groupName, 'RP7A');
      assert.ok(!ids.includes(a1), 'a saved lesson is listed');
      // A teacher with nothing open, a lesson saved, and a teacher who is another's substitute.
      const boMine = await service.mine(bo);
      assert.ok(boMine.open.every((item) => item.lessonId !== b1 && item.lessonId !== b2));
      assert.deepEqual(boMine.year && [boMine.year.held, boMine.year.reported], [4, 4]);
      const ceciliaMine = await service.mine(cecilia);
      assert.deepEqual(ceciliaMine.year && [ceciliaMine.year.held, ceciliaMine.year.reported], [2, 1]);
      // The list is the caller's own: an administrator and a pupil are given nothing.
      assert.deepEqual((await service.mine(admin)).open, []);
      assert.deepEqual((await service.mine(elev1)).open, []);
      void a2;
    });

    await check('(rf) the runner: the school is on the job\'s list, its night is claimed once and not again once finished', async () => {
      const listed = await api.withDeliveryService((tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM app.reporting_schools() AS id`);
      assert.ok(listed.some((row) => row.id === s), 'a school with lessons in the last 90 days is not on the job\'s list');
      const claimed = await runner.claimNightly(REPORTING_RATE_JOB, 0, [s], 10, new Date());
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]!.schoolId, s);
      assert.equal((await runner.claimNightly(REPORTING_RATE_JOB, 0, [s], 10, new Date())).length, 0, 'a night in progress was claimed twice');
      await runner.finishNightly(REPORTING_RATE_JOB, s, claimed[0]!.localDay, new Date());
      assert.equal((await runner.claimNightly(REPORTING_RATE_JOB, 0, [s], 10, new Date())).length, 0, 'a finished night was claimed again');
    });

    await check('(rg) summer time and a lov, counted to the day: a week across the switch is seven calendar days, midnight is Monday\'s, an absence across the night overlaps by the clock', async () => {
      // March 2026. The week of the 9th is two saved lessons of Anna's; the week of the 16th is a lov (cancelled, with registers);
      // Friday the 27th Anna has one saved lesson and one at 23:00; Monday the 30th Bo has one at midnight (Sunday 22:00 in UTC),
      // and Anna one at 08:00 that is saved and one at 07:00 that falls in her absence from Monday 03:00 to 07:30.
      for (const [d, h] of [['2026-03-10', 8], ['2026-03-11', 8]] as const) await mark(await lesson(d, h, [dag]));
      for (const d of ['2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20']) {
        await mark(await lesson(d, 8, [dag], { status: 'CANCELLED', cause: 'MANUAL' }));
        await mark(await lesson(d, 9, [eva], { status: 'CANCELLED', cause: 'MANUAL' }));
      }
      await mark(await lesson('2026-03-27', 8, [dag]));
      await lesson('2026-03-27', 23, [dag]);
      await lesson('2026-03-30', 0, [eva]);
      await mark(await lesson('2026-03-30', 8, [dag]));
      await mark(await lesson('2026-03-30', 7, [dag]));
      await owner.query(
        `INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "updatedAt")
         VALUES ($1, $2, '2026-03-30 03:00'::timestamp AT TIME ZONE 'Europe/Stockholm', '2026-03-30 07:30'::timestamp AT TIME ZONE 'Europe/Stockholm', now())`,
        [s, dag.userId],
      );
      // October 2026: the end of summer time. Friday the 23rd one saved lesson, Monday the 26th one open.
      await mark(await lesson('2026-10-23', 8, [dag]));
      await lesson('2026-10-26', 8, [dag]);
      for (const asOf of ['2026-04-05', '2026-11-01']) {
        await api.withDeliveryService((tx) => tx.$queryRaw`SELECT * FROM app.reporting_compute(${s}::uuid, ${asOf}::date)`);
      }
      // Only the two teachers of these dates: the weeks counted from `base` can lie on the same days of the autumn.
      const names = (view: Awaited<ReturnType<typeof service.overview>>) =>
        view.teachers.filter((t) => t.firstName === 'Dag' || t.firstName === 'Eva').map((t) => `${t.firstName} ${t.reported}/${t.held}`);
      const spring1 = await service.overview({ period: 'WEEK', anchor: '2026-03-29' }, admin);
      assert.deepEqual([spring1.from, spring1.to, spring1.previousAnchor, spring1.nextAnchor], ['2026-03-23', '2026-03-29', '2026-03-22', '2026-03-30']);
      assert.deepEqual(names(spring1), ['Dag 1/2']);
      const spring2 = await service.overview({ period: 'WEEK', anchor: '2026-03-30' }, admin);
      assert.deepEqual([spring2.from, spring2.to], ['2026-03-30', '2026-04-05']);
      assert.deepEqual(names(spring2), ['Eva 0/1', 'Dag 1/1'], 'midnight on Monday is Monday\'s, and the 07:00 lesson of an absent teacher is no one\'s');
      assert.deepEqual(spring2.total, { held: 2, reported: 1 });
      const lov = await service.overview({ period: 'WEEK', anchor: '2026-03-18' }, admin);
      assert.deepEqual([lov.total, lov.teachers], [{ held: 0, reported: 0 }, []]);
      const march = await service.overview({ period: 'MONTH', anchor: '2026-03-31' }, admin);
      assert.deepEqual([march.from, march.to, march.previousAnchor, march.nextAnchor], ['2026-03-01', '2026-03-31', '2026-02-28', '2026-04-01']);
      assert.deepEqual(names(march), ['Eva 0/1', 'Dag 4/5']);
      assert.deepEqual(march.total, { held: 6, reported: 4 });
      const autumn1 = await service.overview({ period: 'WEEK', anchor: '2026-10-25' }, admin);
      const autumn2 = await service.overview({ period: 'WEEK', anchor: '2026-10-26' }, admin);
      assert.deepEqual([autumn1.from, autumn1.to, autumn2.from, autumn2.to], ['2026-10-19', '2026-10-25', '2026-10-26', '2026-11-01']);
      assert.deepEqual([names(autumn1), names(autumn2)], [['Dag 1/1'], ['Dag 0/1']]);
    });
  } finally {
    await sweepReportingRateSchool(owner, marker);
  }
}
