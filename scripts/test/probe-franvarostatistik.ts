/**
 * The adapter probe's checks for Frånvarostatistik över tid (20270121090000), through the
 * real AbsenceStatsService and AbsenceStatsJob, on the API's role against real Postgres
 * as CI runs it. The RLS sections (390-394) prove what the functions and the table do;
 * this proves what the gateway and the adapter make of them: the casts of the job's and
 * the doors' parameters (a null class, dates as text), the integer and double columns
 * read back, the refusals that arrive as P2010 with the SQLSTATE in the driver's cause,
 * the read log the doors' names are recorded in, and the nightly job's plan and months
 * through the delivery's door. In a school of its own (slug <marker>-franvarostatistik)
 * and one for the läsårsaktivering (<marker>-franvarostatistik-ar), swept whole before
 * and after.
 *
 * The main school has one läsår holding today and a class 7A of seven pupils (one the
 * school has marked as having a protected identity), taught two lessons a day on the
 * weekdays from 75 days back to yesterday; the pupils' marks are present but for
 *
 *   p1  absent at 08:00 on Mondays      p2  excused at both lessons on Wednesdays
 *   p3  late at 08:00 on Fridays        pm  (marked) absent every Tuesday at 09:00
 *
 *   fa  the night through AbsenceStatsJob.runSchool: the plan, each month in a
 *       transaction of its own, the trim; the stored sums are what the raw marks
 *       come to, month by month, class by class; a second night writes nothing
 *   fb  the doors for an administrator: the school's months, the classes, a class
 *       with its patterns, its pupils (the marked one left out and counted), a
 *       pupil's card; the read log names the pupils, as ATTENDANCE and PEOPLE,
 *       and the sums name nobody
 *   fc  the mentor: their class and their pupils, not the marked one and not
 *       another class's; a teacher with no class reads nothing; the refusals
 *       arrive as the API's 403 with the database's code
 *   fd  the huvudman's reader: the sums, and no pupil: refused by the gateway
 *       and, asked straight, by the database (AS403)
 *   fe  the sums outlive the attendance: the school decides to purge attendance,
 *       the marks of an old month are purged, the night leaves the month, the
 *       class still shows it and the pupil's card has nothing left of it
 *   ff  a läsårsaktivering empties last year's classes and the history stands
 *       still: the class's pupils are still listed with their minutes over the
 *       year, the sums are the same, and the cohort's months are one series
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { AbsenceStatsJob } from '../../src/absence-stats/absence-stats.job';
import { AbsenceStatsService } from '../../src/absence-stats/absence-stats.service';
import { absenceStatsRefusal } from '../../src/absence-stats/absence-stats-errors';
import { ABSENCE_STATS_JOB } from '../../src/absence-stats/absence-stats';
import { YearRolloverService } from '../../src/year-rollover/year-rollover.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function absenceStatsSlug(marker: string): string {
  return `${marker}-franvarostatistik`;
}

function absenceStatsYearSlug(marker: string): string {
  return `${marker}-franvarostatistik-ar`;
}

export async function sweepAbsenceStatsSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "JobClaims" WHERE job = $1 AND "schoolId" IN (SELECT id FROM "Schools" WHERE slug = ANY($2::text[]))`, [
    ABSENCE_STATS_JOB,
    [absenceStatsSlug(marker), absenceStatsYearSlug(marker)],
  ]);
  await owner.query(`DELETE FROM "Schools" WHERE slug = ANY($1::text[])`, [[absenceStatsSlug(marker), absenceStatsYearSlug(marker)]]);
  await owner.query(`DELETE FROM "Huvudmen" WHERE name = $1`, [`${marker} frånvarostatistik huvudman`]);
}

export async function absenceStatsChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepAbsenceStatsSchool(owner, marker);
  const rows = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await rows<T>(sql, params))[0]!;
  const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await one<{ n: string }>(sql, params)).n);
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;
  const dayOf = async (from: string, n: number): Promise<string> => (await one<{ d: string }>(`SELECT ($1::date + $2::int)::text AS d`, [from, n])).d;
  const yesterday = await dayOf(today, -1);
  const midnight = (day: string) => new Date(`${day}T00:00:00.000Z`);
  const service = new AbsenceStatsService(api);
  const job = new AbsenceStatsJob(api);
  /** Nights until nothing more is written: three older months a night, so a läsår of months takes a few. */
  const settle = async (school: string): Promise<void> => {
    for (let night = 0; night < 8; night += 1) {
      if ((await job.runSchool(school, midnight(today))).written === 0) return;
    }
    throw new Error('the nights did not settle');
  };
  const refusal = async (promise: Promise<unknown>): Promise<{ status: number; code: string }> => {
    try {
      await promise;
    } catch (error) {
      const response = (error as { getStatus?: () => number; getResponse?: () => { code?: string } });
      return { status: response.getStatus?.() ?? 0, code: response.getResponse?.().code ?? '' };
    }
    throw new Error('the call was not refused');
  };

  const s = (
    await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [
      `${marker} frånvarostatistik`,
      absenceStatsSlug(marker),
    ])
  ).id;
  try {
    const year = (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
         VALUES ($1, 'probe frånvarostatistik', $2::date - 200, $2::date + 160, true, 'NIOARIG', now()) RETURNING id`,
        [s, today],
      )
    ).id;
    const group = (
      await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, 'FS7A', 'CLASS', 7, now()) RETURNING id`, [s, year])
    ).id;
    const other = (
      await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, 'FS7B', 'CLASS', 7, now()) RETURNING id`, [s, year])
    ).id;
    const subject = (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'Matte', 'FSMA', now()) RETURNING id`, [s])).id;

    const person = async (role: string, label: string, groupId: string | null = null, adminProfile: string | null = null): Promise<AuthenticatedUser> => {
      const authId = randomUUID();
      const row = await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "adminProfile", "updatedAt")
         VALUES ($1, $2, $3, 'Probe', $4, $5, true, $6, $7::"AdminProfile", now()) RETURNING id`,
        [s, `${marker}-franvarostatistik-${label}@example.invalid`, label, role, authId, groupId, adminProfile],
      );
      return {
        authId,
        role: role as Role,
        userId: row.id,
        schoolId: s,
        channel: 'WEB',
        ...(role === 'SCHOOL_ADMIN' ? { adminProfile: adminProfile as never, hrRead: false } : {}),
      };
    };
    const admin = await person('SCHOOL_ADMIN', 'Admin', null, 'FULL');
    const mentor = await person('TEACHER', 'Mentor');
    const stranger = await person('TEACHER', 'Annan');
    // The pupils sit in FS7A from the first day of the year (the history trigger records them from today).
    const pupils: AuthenticatedUser[] = [];
    for (const label of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'pm']) pupils.push(await person('STUDENT', label, group));
    const [p1, p2, p3, p4, , , pm] = pupils as [AuthenticatedUser, AuthenticatedUser, AuthenticatedUser, AuthenticatedUser, AuthenticatedUser, AuthenticatedUser, AuthenticatedUser];
    await owner.query(`INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "updatedAt")
                       VALUES ($1, $2, $3, 'MENTORSKAP', 'Mentor 7A', 60, $4, now())`, [s, mentor.userId, year, group]);
    await owner.query(`INSERT INTO "PersonProtections" ("userId", "schoolId", source) VALUES ($1, $2, 'MANUAL')`, [pm.userId, s]);
    await owner.query('BEGIN');
    await owner.query(`SET LOCAL session_replication_role = replica`);
    await owner.query(`UPDATE "StudentEnrollments" SET "validFrom" = $2::date - 200 WHERE "schoolId" = $1 AND "validTo" IS NULL`, [s, today]);
    await owner.query('COMMIT');

    // The lessons and the marks: every weekday from 75 days back to yesterday, two lessons a day, by one teacher.
    await owner.query('BEGIN');
    await owner.query(`SET LOCAL session_replication_role = replica`);
    await owner.query(
      `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
       SELECT $1, $2, $3, d::date, (d::date + make_time(8 + h, 0, 0)) AT TIME ZONE 'Europe/Stockholm',
              (d::date + make_time(8 + h, 50, 0)) AT TIME ZONE 'Europe/Stockholm', 'SCHEDULED', now()
         FROM generate_series($4::date - 75, $4::date - 1, interval '1 day') d CROSS JOIN generate_series(0, 1) h
        WHERE extract(isodow FROM d) < 6`,
      [s, subject, group, today],
    );
    await owner.query(
      `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) SELECT $1, id, $2, 'LEAD' FROM "CalendarLessons" WHERE "schoolId" = $1`,
      [s, mentor.userId],
    );
    await owner.query(
      `INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "updatedAt")
       SELECT $1, cl.id, u.id,
              (CASE
                 WHEN u."firstName" = 'p1' AND extract(isodow FROM cl.date) = 1 AND extract(hour FROM cl."startsAt" AT TIME ZONE 'Europe/Stockholm') = 8 THEN 'ABSENT'
                 WHEN u."firstName" = 'p2' AND extract(isodow FROM cl.date) = 3 THEN 'EXCUSED'
                 WHEN u."firstName" = 'p3' AND extract(isodow FROM cl.date) = 5 AND extract(hour FROM cl."startsAt" AT TIME ZONE 'Europe/Stockholm') = 8 THEN 'LATE'
                 WHEN u."firstName" = 'pm' AND extract(isodow FROM cl.date) = 2 AND extract(hour FROM cl."startsAt" AT TIME ZONE 'Europe/Stockholm') = 9 THEN 'ABSENT'
                 ELSE 'PRESENT'
               END)::"AttendanceStatus", now()
         FROM "CalendarLessons" cl JOIN "Users" u ON u."schoolId" = cl."schoolId" AND u.role = 'STUDENT' AND u."studentGroupId" = cl."studentGroupId"
        WHERE cl."schoolId" = $1`,
      [s],
    );
    await owner.query('COMMIT');

    /** What the raw marks come to per month, counted in a different way from the functions: one statement per kind. */
    const oracle = async (groupId: string | null) =>
      rows<{ month: string; recorded: string; valid: string; absent: string; late: string; late_n: string; held: string }>(
        `SELECT date_trunc('month', cl.date)::date::text AS month,
                coalesce(sum(50), 0)::text AS recorded,
                coalesce(sum(50) FILTER (WHERE a.status = 'EXCUSED'), 0)::text AS valid,
                coalesce(sum(50) FILTER (WHERE a.status = 'ABSENT'), 0)::text AS absent,
                coalesce(sum(15) FILTER (WHERE a.status = 'LATE'), 0)::text AS late,
                count(*) FILTER (WHERE a.status = 'LATE')::text AS late_n,
                count(DISTINCT cl.id)::text AS held
           FROM "CalendarLessons" cl JOIN "AttendanceRecords" a ON a."calendarLessonId" = cl.id
          WHERE cl."schoolId" = $1 AND ($2::uuid IS NULL OR cl."studentGroupId" = $2::uuid)
          GROUP BY 1 ORDER BY 1`,
        [s, groupId],
      );
    const stored = async (groupId: string | null) =>
      rows<{ month: string; recorded: string; valid: string; absent: string; late: string; late_n: string; held: string; reported: string; pupils: number }>(
        `SELECT "month"::text AS month, "recordedMinutes"::text AS recorded, "validMinutes"::text AS valid, "absentMinutes"::text AS absent,
                "lateMinutes"::text AS late, "lateCount"::text AS late_n, "lessonsHeld"::text AS held, "lessonsReported"::text AS reported, pupils
           FROM "AbsenceStatsMonths" WHERE "schoolId" = $1 AND "studentGroupId" IS NOT DISTINCT FROM $2::uuid AND "lessonsHeld" > 0 ORDER BY "month"`,
        [s, groupId],
      );

    await check('(fa) the night: the plan and each month in a transaction of its own; the sums are what the raw marks come to; a second night writes nothing', async () => {
      const first = await job.runSchool(s, midnight(today));
      assert.ok(first.months >= 3, `the first night counted ${first.months} months`);
      assert.equal(first.failedMonths, 0);
      assert.ok(first.written >= 3);
      for (const [label, groupId] of [['school', null], ['FS7A', group]] as const) {
        const want = await oracle(groupId);
        const got = await stored(groupId);
        assert.deepEqual(
          got.map((row) => [row.month, row.recorded, row.valid, row.absent, row.late, row.late_n, row.held]),
          want.map((row) => [row.month, row.recorded, row.valid, row.absent, row.late, row.late_n, row.held]),
          `the stored months of the ${label} are not what the marks come to`,
        );
      }
      // FS7B has no pupil: no row. Every lesson is reported (a register on each).
      assert.equal(await count(`SELECT count(*) AS n FROM "AbsenceStatsMonths" WHERE "schoolId" = $1 AND "studentGroupId" = $2`, [s, other]), 0);
      assert.ok((await stored(null)).every((row) => row.held === row.reported), 'a lesson with a register for every pupil is not reported');
      assert.equal(await count(`SELECT count(*) AS n FROM "AbsenceStatsMonths" WHERE "schoolId" = $1 AND pupils < 5`, [s]), 0);
      await settle(s);
      const again = await job.runSchool(s, midnight(today));
      assert.deepEqual([again.written, again.removed, again.failedMonths], [0, 0, 0], 'a night after the rest changed something');
      assert.ok(again.months >= 3, 'the recent months are not asked for every night');
    });

    await check('(fb) an administrator reads the school, the classes, a class with its patterns, its pupils and a pupil’s card; the pupils are named in the read log, the sums are not', async () => {
      const readsBefore = await count(`SELECT count(*) AS n FROM "PersonalDataAccess" WHERE "schoolId" = $1`, [s]);
      const view = await service.school(admin);
      assert.equal(view.window.minGroup, 5);
      assert.equal(view.window.today, today);
      assert.equal(view.window.year?.name, 'probe frånvarostatistik');
      const months = (await oracle(null)).map((row) => row.month);
      assert.deepEqual(view.series.filter((month) => month.figures !== null).map((month) => month.month), months);
      const first = view.series.find((month) => month.month === months[1])!;
      const wanted = (await oracle(null)).find((row) => row.month === months[1])!;
      assert.equal(first.figures?.recordedMinutes, Number(wanted.recorded));
      assert.equal(first.figures?.invalidMinutes, Number(wanted.absent) + Number(wanted.late));
      assert.equal(first.reporting.ratePct, 100);
      assert.equal(first.pupils, 7);
      assert.equal(first.partial, false);
      if (!today.endsWith('-01')) assert.equal(view.series.at(-1)?.partial, true, 'the month that is going on is not marked partial');
      const classes = await service.classes({}, admin);
      assert.deepEqual(classes.classes.map((c) => [c.className, c.yearName]), [['FS7A', 'probe frånvarostatistik']]);
      assert.equal(classes.classes[0]?.pupils, 7);
      const cls = await service.classView(group, {}, admin);
      assert.equal(cls.series.length > 0, true);
      assert.equal(cls.patterns.suppressed, false);
      assert.equal(cls.patterns.groupSize, 7);
      assert.deepEqual(cls.patterns.weekdays.map((cell) => cell.key), ['1', '2', '3', '4', '5']);
      assert.deepEqual(cls.patterns.slots.map((cell) => cell.key), ['08:00', '09:00']);
      assert.ok(cls.patterns.weekdays[0]!.figures.invalidMinutes > 0, 'the Mondays hold p1’s absence');
      assert.equal(await count(`SELECT count(*) AS n FROM "PersonalDataAccess" WHERE "schoolId" = $1`, [s]), readsBefore, 'the sums were recorded as a read of persons');

      const list = await service.classPupils(group, {}, admin);
      assert.deepEqual(list.pupils.map((pupil) => pupil.firstName), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
      assert.equal(list.heldOut, 1, 'the administrator is not told how many were left out');
      assert.ok(!JSON.stringify(list).includes(pm.userId!), 'the marked pupil is in the list');
      const absentMondays = await count(
        `SELECT count(*) AS n FROM "CalendarLessons" WHERE "schoolId" = $1 AND extract(isodow FROM date) = 1 AND extract(hour FROM "startsAt" AT TIME ZONE 'Europe/Stockholm') = 8`,
        [s],
      );
      assert.equal(list.pupils[0]?.figures.absentMinutes, absentMondays * 50);
      const card = await service.pupil(p1.userId!, {}, admin);
      assert.equal(card.student.className, 'FS7A');
      assert.equal(card.student.isProtected, false);
      assert.equal(card.total?.absentMinutes, absentMondays * 50);
      assert.equal(card.months.length >= 7, true);
      assert.equal(card.months.filter((month) => month.figures !== null).length, months.length);
      assert.equal(card.classSeries?.length, months.length);
      assert.equal(card.patterns.suppressed, false);
      assert.equal(card.marksTo, yesterday);
      const logged = await rows<{ kind: string; subjects: number }>(
        `SELECT kind::text AS kind, cardinality("subjectIds") AS subjects FROM "PersonalDataAccess" WHERE "schoolId" = $1 AND "actorId" = $2 ORDER BY "at", kind::text`,
        [s, admin.userId],
      );
      assert.deepEqual(
        [...new Set(logged.map((row) => row.kind))].sort(),
        ['ATTENDANCE', 'PEOPLE'],
        'the doors that name pupils are not recorded as ATTENDANCE and PEOPLE',
      );
      // The class's list names the six (the card's pupil was read a moment before: the log leaves out whoever the reader read in the last quarter-hour).
      assert.ok(logged.some((row) => row.subjects === 6));
      // The marked pupil is opened by an administrator and told so; there is no file, and the card says it is marked.
      const marked = await service.pupil(pm.userId!, {}, admin);
      assert.equal(marked.student.isProtected, true);
    });

    await check('(fc) the mentor reads their class and their pupils, not the marked one and not another class; a teacher with no class reads nothing', async () => {
      const own = await service.classView(group, {}, mentor);
      assert.equal(own.classId, group);
      const classes = await service.classes({}, mentor);
      assert.deepEqual(classes.classes.map((c) => c.className), ['FS7A']);
      const list = await service.classPupils(group, {}, mentor);
      assert.equal(list.pupils.length, 6);
      assert.equal(list.heldOut, null, 'a mentor is told that someone was left out');
      assert.ok(!JSON.stringify(list).includes(pm.userId!));
      assert.equal((await service.pupil(p2.userId!, {}, mentor)).student.firstName, 'p2');
      assert.deepEqual(await refusal(service.pupil(pm.userId!, {}, mentor)), { status: 403, code: 'ABSENCE_STATS_NOT_YOURS' });
      assert.deepEqual(await refusal(service.classView(other, {}, mentor)), { status: 403, code: 'ABSENCE_STATS_NOT_YOURS' });
      assert.deepEqual(await refusal(service.school(mentor)), { status: 403, code: 'ABSENCE_STATS_NOT_YOURS' });
      assert.equal((await service.classes({}, stranger)).classes.length, 0);
      assert.deepEqual(await refusal(service.pupil(p1.userId!, {}, stranger)), { status: 403, code: 'ABSENCE_STATS_NOT_YOURS' });
      assert.deepEqual(await refusal(service.classPupils(group, {}, stranger)), { status: 403, code: 'ABSENCE_STATS_NOT_YOURS' });
      // A period backwards, a class that is not there, a pupil that is not one.
      assert.deepEqual(await refusal(service.classes({ from: today, to: await dayOf(today, -400) }, admin)), { status: 400, code: 'ABSENCE_STATS_BAD_PERIOD' });
      assert.deepEqual(await refusal(service.classView(randomUUID(), {}, admin)), { status: 404, code: 'ABSENCE_STATS_NO_SUCH_CLASS' });
      assert.deepEqual(await refusal(service.pupil(mentor.userId!, {}, admin)), { status: 404, code: 'ABSENCE_STATS_NO_SUCH_PUPIL' });
    });

    await check('(fd) the huvudman’s reader reads the sums and no pupil: refused by the gateway, and by the database when asked straight', async () => {
      // A huvudman of its own, with a planner who reads the school as the läsare.
      const authId = randomUUID();
      const h = (
        await one<{ id: string }>(`INSERT INTO "Huvudmen" (name, "organisationNumber") VALUES ($1, $2) RETURNING id`, [
          `${marker} frånvarostatistik huvudman`,
          `21${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        ])
      ).id;
      const member = (
        await one<{ id: string }>(
          `INSERT INTO "HuvudmanMembers" ("huvudmanId", "authId", email, "firstName", "lastName", role, "isActive", "invitedAt")
           VALUES ($1, $2, $3, 'Huvudman', 'Planerare', 'PLANERARE', true, now()) RETURNING id`,
          [h, authId, `${marker}-franvarostatistik-hm@example.invalid`],
        )
      ).id;
      const huvudman = { id: member, huvudmanId: h };
      await owner.query(`INSERT INTO "HuvudmanSchools" ("schoolId", "huvudmanId", "requestedById") VALUES ($1, $2, $3)`, [s, h, member]);
      await owner.query(`INSERT INTO "HuvudmanSchoolEvents" ("huvudmanId", "schoolId", kind, "byMemberId") VALUES ($1, $2, 'REQUESTED', $3)`, [h, s, member]);
      await owner.query(`INSERT INTO "HuvudmanSchoolEvents" ("huvudmanId", "schoolId", kind, "byUserId") VALUES ($1, $2, 'JOINED', NULL)`, [h, s]);
      const reader: AuthenticatedUser = {
        authId,
        role: Role.SCHOOL_ADMIN,
        schoolId: s,
        adminProfile: 'LASARE',
        hrRead: false,
        channel: 'WEB',
        huvudman: { id: huvudman.huvudmanId, name: `${marker} huvudman`, memberId: huvudman.id, role: 'PLANERARE', firstName: 'Huvudman', lastName: 'Planerare' },
      };
      assert.ok((await service.school(reader)).series.length > 0);
      assert.equal((await service.classes({}, reader)).classes.length, 1);
      assert.equal((await service.classView(group, {}, reader)).patterns.suppressed, false);
      assert.deepEqual(await refusal(service.classPupils(group, {}, reader)), { status: 403, code: 'ABSENCE_STATS_NO_PUPILS_FOR_THE_READER' });
      assert.deepEqual(await refusal(service.pupil(p1.userId!, {}, reader)), { status: 403, code: 'ABSENCE_STATS_NO_PUPILS_FOR_THE_READER' });
      // The database on its own: asked for a pupil's head under the reader's claims, it refuses with AS403, which arrives as the adapter hands it.
      let thrown: unknown;
      try {
        await api.withRls(reader, (tx) => tx.$queryRaw`SELECT * FROM app.absence_stats_pupil_head(${p1.userId}::uuid)`);
      } catch (error) {
        thrown = error;
      }
      const mapped = absenceStatsRefusal(thrown);
      assert.ok(mapped, `the database did not refuse the reader: ${String(thrown)}`);
      assert.equal((mapped as unknown as { getResponse(): { code: string } }).getResponse().code, 'ABSENCE_STATS_NO_PUPILS_FOR_THE_READER');
      // And the reader leaves nothing in the school's read log.
      assert.equal(await count(`SELECT count(*) AS n FROM "PersonalDataAccess" WHERE "schoolId" = $1 AND "actorId" IS NULL AND kind IN ('ATTENDANCE', 'PEOPLE')`, [s]), 0);
    });

    await check('(fe) the sums outlive the attendance: the marks of an old month are purged, the night leaves the month, the class shows it and the pupil’s card has nothing of it', async () => {
      const months = (await stored(group)).map((row) => row.month);
      const old = months[0]!;
      const next = months[1]!;
      const before = (await stored(group)).find((row) => row.month === old)!;
      await owner.query('BEGIN');
      await owner.query(`ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped"`);
      await owner.query(`INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months, "decidedAt") VALUES ($1, 'ATTENDANCE', 'PURGE_AFTER', 1, now() - interval '3 days')`, [s]);
      await owner.query(`ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped"`);
      await owner.query('COMMIT');
      // The gallring takes the marks of every month before the one that is a month back.
      const run = (await one<{ id: string }>(`SELECT app.gallring_begin($1::uuid, now()) AS id`, [s])).id;
      await owner.query(`SELECT app.gallring_purge($1::uuid, 'ATTENDANCE', 100000)`, [run]);
      await owner.query(`SELECT app.gallring_finish($1::uuid, '{}'::jsonb, now())`, [run]);
      assert.equal(
        await count(`SELECT count(*) AS n FROM "AttendanceRecords" a JOIN "CalendarLessons" cl ON cl.id = a."calendarLessonId" WHERE cl."schoolId" = $1 AND date_trunc('month', cl.date) = $2::date`, [s, old]),
        0,
        'the gallring left the old month’s marks',
      );
      const night = await job.runSchool(s, midnight(today));
      assert.deepEqual([night.written, night.removed, night.failedMonths], [0, 0, 0], 'the night counted a month whose marks are gone');
      assert.deepEqual((await stored(group)).find((row) => row.month === old), before, 'the old month’s sums moved');
      const view = await service.classView(group, {}, admin);
      assert.equal(view.series.find((month) => month.month === old)?.figures?.recordedMinutes, Number(before.recorded));
      const card = await service.pupil(p1.userId!, {}, admin);
      assert.equal(card.months.find((month) => month.month === old)?.figures, null, 'the pupil’s card has figures of purged marks');
      assert.ok(card.marksFrom !== null && card.marksFrom >= next, 'the first day of the pupil’s marks is not after the purged month');
      // The school’s months still show the old one, with its comparison none.
      assert.equal((await service.school(admin)).series.find((month) => month.month === old)?.figures?.recordedMinutes, Number(before.recorded));
    });

    await check('(ff) a läsårsaktivering empties last year’s classes and the history stands still: the class’s pupils are listed with their minutes, the sums are the same, the cohort’s months are one series', async () => {
      const ys = absenceStatsYearSlug(marker);
      const s2 = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [`${marker} frånvarostatistik ar`, ys])).id;
      const first = await one<{ id: string; yearStart: string; yearEnd: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
         VALUES ($1, 'FF ett', $2::date - 200, $2::date - 20, true, 'NIOARIG', now()) RETURNING id, "startDate"::text AS "yearStart", "endDate"::text AS "yearEnd"`,
        [s2, today],
      );
      const second = (
        await one<{ id: string }>(
          `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "predecessorId", "updatedAt")
           VALUES ($1, 'FF tva', $2::date + 40, $2::date + 300, false, 'NIOARIG', $3, now()) RETURNING id`,
          [s2, today, first.id],
        )
      ).id;
      const class7 = (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, 'FF7A', 'CLASS', 7, now()) RETURNING id`, [s2, first.id])).id;
      const class8 = (
        await one<{ id: string }>(
          `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "predecessorId", "updatedAt") VALUES ($1, $2, 'FF8A', 'CLASS', 8, $3, now()) RETURNING id`,
          [s2, second, class7],
        )
      ).id;
      const subject2 = (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'Matte', 'FFMA', now()) RETURNING id`, [s2])).id;
      const who = async (role: string, label: string, groupId: string | null, adminProfile: string | null = null): Promise<AuthenticatedUser> => {
        const authId = randomUUID();
        const row = await one<{ id: string }>(
          `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "adminProfile", "updatedAt")
           VALUES ($1, $2, $3, 'Probe', $4, $5, true, $6, $7::"AdminProfile", now()) RETURNING id`,
          [s2, `${marker}-franvarostatistik-ar-${label}@example.invalid`, label, role, authId, groupId, adminProfile],
        );
        return { authId, role: role as Role, userId: row.id, schoolId: s2, channel: 'WEB', ...(role === 'SCHOOL_ADMIN' ? { adminProfile: adminProfile as never, hrRead: false } : {}) };
      };
      const admin2 = await who('SCHOOL_ADMIN', 'Admin', null, 'FULL');
      const hed = await who('TEACHER', 'Hed', null);
      const six: AuthenticatedUser[] = [];
      for (const label of ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']) six.push(await who('STUDENT', label, class7));
      // The pupils sat in 7A for the whole year; the history is the database's, so the owner plants it with the triggers held off.
      await owner.query('BEGIN');
      await owner.query(`SET LOCAL session_replication_role = replica`);
      await owner.query(`UPDATE "StudentEnrollments" SET "validFrom" = $2::date WHERE "schoolId" = $1 AND "studentGroupId" = $3 AND "validTo" IS NULL`, [s2, first.yearStart, class7]);
      await owner.query(
        `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
         SELECT $1, $2, $3, d::date, (d::date + make_time(8, 0, 0)) AT TIME ZONE 'Europe/Stockholm', (d::date + make_time(8, 50, 0)) AT TIME ZONE 'Europe/Stockholm', 'SCHEDULED', now()
           FROM generate_series($4::date - 70, $4::date - 40, interval '1 day') d WHERE extract(isodow FROM d) < 6`,
        [s2, subject2, class7, today],
      );
      await owner.query(`INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) SELECT $1, id, $2, 'LEAD' FROM "CalendarLessons" WHERE "schoolId" = $1`, [s2, hed.userId]);
      await owner.query(
        `INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "updatedAt")
         SELECT $1, cl.id, u.id, (CASE WHEN u."firstName" = 'q1' AND extract(isodow FROM cl.date) = 2 THEN 'ABSENT' ELSE 'PRESENT' END)::"AttendanceStatus", now()
           FROM "CalendarLessons" cl JOIN "Users" u ON u."schoolId" = cl."schoolId" AND u.role = 'STUDENT' WHERE cl."schoolId" = $1`,
        [s2],
      );
      await owner.query('COMMIT');
      await settle(s2);
      const sums = async () =>
        rows<{ month: string; recorded: string; absent: string }>(`SELECT "month"::text AS month, "recordedMinutes"::text AS recorded, "absentMinutes"::text AS absent FROM "AbsenceStatsMonths" WHERE "schoolId" = $1 AND "lessonsHeld" > 0 ORDER BY "month", "studentGroupId" NULLS FIRST`, [s2]);
      const before = await sums();
      assert.ok(before.length >= 2, 'the lessons were not counted');
      const listBefore = await service.classPupils(class7, { from: first.yearStart, to: first.yearEnd }, admin2);

      // The activation, through the real service: 7A's pupils move to 8A and 7A is empty.
      const rollover = new YearRolloverService(api);
      const preview = await rollover.previewActivation(second, admin2, { today });
      await rollover.executeActivation(second, { planHash: preview.planHash }, admin2, { today });
      assert.equal(await count(`SELECT count(*) AS n FROM "Users" WHERE "schoolId" = $1 AND "studentGroupId" = $2`, [s2, class7]), 0, 'last year’s class still has pupils');
      assert.equal(await count(`SELECT count(*) AS n FROM "Users" WHERE "schoolId" = $1 AND "studentGroupId" = $2`, [s2, class8]), 6);

      // The pupils have no class on the books in the weeks between the years, so a month that had a row of nothing there loses it
      // (removed); what was counted of the lessons stays, and nothing is written.
      const night = await job.runSchool(s2, midnight(today));
      assert.deepEqual([night.written, night.failedMonths], [0, 0], 'the activation changed last year’s sums');
      assert.deepEqual(await sums(), before);
      // The emptied class still has its pupils, by the history, with their minutes of the year.
      const listAfter = await service.classPupils(class7, { from: first.yearStart, to: first.yearEnd }, admin2);
      assert.deepEqual(listAfter.pupils.map((pupil) => [pupil.firstName, pupil.figures.recordedMinutes]), listBefore.pupils.map((pupil) => [pupil.firstName, pupil.figures.recordedMinutes]));
      assert.equal(listAfter.pupils.length, 6);
      assert.ok(listAfter.pupils.every((pupil) => pupil.figures.recordedMinutes > 0));
      // The cohort: this year's class reads last year's months as one series.
      const cohort = await service.classView(class8, {}, admin2);
      assert.ok(cohort.series.length >= 1);
      assert.ok(cohort.series.every((month) => month.classNames.includes('FF7A')), 'the cohort’s series does not reach last year’s class');
      // The control: without the history the class has no pupils to list, and the months of its pupils would have no class.
      await owner.query('BEGIN');
      await owner.query(`SET LOCAL session_replication_role = replica`);
      await owner.query(`DELETE FROM "StudentEnrollments" WHERE "schoolId" = $1 AND "studentGroupId" = $2`, [s2, class7]);
      await owner.query('COMMIT');
      assert.equal((await service.classPupils(class7, { from: first.yearStart, to: first.yearEnd }, admin2)).pupils.length, 0, 'the control did not show what the history keeps');
    });
  } finally {
    await sweepAbsenceStatsSchool(owner, marker);
  }
}
