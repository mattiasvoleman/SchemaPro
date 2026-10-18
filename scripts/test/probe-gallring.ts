/**
 * The adapter probe's checks for gallring (20261021090000–20261021110000),
 * through the real GallringService, GallringJob and JobRunner on the API's
 * role, against real Postgres as CI runs it. In a school of its own (slug
 * <marker>-gallring), swept whole before and after, with rows on both sides
 * of every cutoff written as the owner:
 *
 *   ga  the page as the school's admin: every kind ej beslutat, a period
 *       recorded through the service waits a day and previews its count, KEEP
 *       with months is a 400, and a teacher's preview is a 403;
 *   gb  one night through GallringJob.runSchool with no principal, on
 *       decisions dated two days back: exactly the rows older than each
 *       cutoff go, none on or after it, nothing of the kind with no decision,
 *       and no other school's row moves; the run counts what went and
 *       "gallrat före" answers the cutoffs;
 *   gc  the departed: an invited person's login is deleted before they are
 *       pseudonymised, one whose login the provider would not delete waits
 *       and is counted, a person with a tjänst this läsår waits for SCB, and
 *       the next night takes the one who waited;
 *   gd  the runner's own glue: app.gallring_schools names the school, the
 *       nightly claim is taken once and not again once finished, and a
 *       settled pass is a JobRuns row of counts;
 *   ge  with Notiser bevaras, a departed person's own notices go with the
 *       name, recent and old alike, while a guardian's notice that names
 *       them stays, as does every other kept notice;
 *   gf  a person reactivated mid-run keeps their login (20261021120000):
 *       the claim waits for a reactivation in flight and then answers
 *       nothing, a reactivation committed while the night deletes an
 *       earlier person's login spares the later one, and a KEEP recorded
 *       mid-run spares whoever is left;
 *   gg  a reactivation that holds the row while the night pseudonymises the
 *       person (20261021130000): the night waits for it, leaves the person
 *       active with their links and notices, counts only whom it
 *       pseudonymised, logs the lost login and finishes.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { ConsoleLogger, Logger } from '@nestjs/common';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { GallringJob, GALLRING_JOB } from '../../src/gallring/gallring.job';
import { GallringService } from '../../src/gallring/gallring.service';
import { JobRunner } from '../../src/jobs/job-runner';
import type { SupabaseAdminService } from '../../src/users/supabase-admin.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function gallringSlug(marker: string): string {
  return `${marker}-gallring`;
}

export async function sweepGallringSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [gallringSlug(marker)]);
  await owner.query(`DELETE FROM "JobRuns" WHERE job = $1`, [`${marker}-gallring`]);
}

export async function gallringChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepGallringSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await one<{ n: string }>(sql, params)).n);
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;
  const ago = (months: number) => `('${today}'::date - interval '${months} months')::date`;

  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${marker} gallring`, gallringSlug(marker)],
  );
  const s = school.id;
  const person = async (role: string, label: string, active = true, invited = false) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "invitedAt", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4, $5, $6, CASE WHEN $7 THEN now() END, now()) RETURNING id`,
      [s, `${marker}-${label}@example.invalid`, label, role, authId, active, invited],
    );
    return { id: row.id, authId };
  };
  const admin = await person('SCHOOL_ADMIN', 'admin');
  const teacher = await person('TEACHER', 'teacher');
  const pupil = await person('STUDENT', 'pupil');
  const guardian = await person('GUARDIAN', 'guardian');
  const gone = await person('STUDENT', 'gone', true, true);
  const stuck = await person('STUDENT', 'stuck', true, true);
  const autumn = await person('TEACHER', 'autumn');
  const asAdmin: AuthenticatedUser = { authId: admin.authId, role: Role.SCHOOL_ADMIN, adminProfile: 'FULL', userId: admin.id, schoolId: s };
  const asTeacher: AuthenticatedUser = { authId: teacher.authId, role: Role.TEACHER, userId: teacher.id, schoolId: s };

  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, 'probe 2019/20', '2019-08-01', '2020-06-30', false, now()) RETURNING id`,
    [s],
  );
  const current = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
     VALUES ($1, 'probe i år', '${today}'::date - 30, '${today}'::date + 300, true, 'NIOARIG', now()) RETURNING id`,
    [s],
  );
  const lessonsYear = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
     VALUES ($1, 'probe förra', ${ago(15)}, '${today}'::date - 62, false, 'NIOARIG', now()) RETURNING id`,
    [s],
  );
  const subject = await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'Probe', 'PRB', now()) RETURNING id`, [s]);
  const group = await one<{ id: string }>(
    `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "updatedAt") VALUES ($1, $2, 'P7', now()) RETURNING id`,
    [s, lessonsYear.id],
  );
  for (const months of [13, 12, 11]) {
    const lesson = await one<{ id: string }>(
      `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
       VALUES ($1, $2, $3, ${ago(months)}, ${ago(months)} + time '06:10', ${ago(months)} + time '06:50', now()) RETURNING id`,
      [s, subject.id, group.id],
    );
    await owner.query(
      `INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "updatedAt") VALUES ($1, $2, $3, 'PRESENT', now())`,
      [s, lesson.id, pupil.id],
    );
  }
  await owner.query(
    `INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date) VALUES ($1, $2, $3, ${ago(7)}), ($1, $2, $3, ${ago(5)})`,
    [s, pupil.id, guardian.id],
  );
  await owner.query(
    `INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason)
     VALUES ($1, $2, $3, ${ago(14)}, ${ago(13)}, $4), ($1, $2, $3, ${ago(14)}, ${ago(11)}, $4)`,
    [s, pupil.id, guardian.id, marker],
  );
  await owner.query(`INSERT INTO "Notifications" ("schoolId", "userId", type, "createdAt") VALUES ($1, $2, 'SCHEDULE_CHANGED', now() - interval '5 years')`, [s, pupil.id]);
  await owner.query(
    `INSERT INTO "ScheduleChangeLogs" ("schoolId", "academicYearId", action, "createdAt")
     VALUES ($1, $2, 'UPDATE', now() - interval '25 months'), ($1, $2, 'UPDATE', now() - interval '23 months')`,
    [s, lessonsYear.id],
  );
  await owner.query(
    `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", signature, "updatedAt")
     VALUES ($1, $2, $3, 100, 'PRB', now()), ($1, $2, $4, 100, 'PRB', now()), ($1, $5, $4, 60, 'AUT', now())`,
    [s, teacher.id, year.id, current.id, autumn.id],
  );
  const reason = await one<{ id: string }>(`INSERT INTO "TeacherAbsenceReasons" ("schoolId", builtin) VALUES ($1, 'SICK') RETURNING id`, [s]);
  await owner.query(
    `INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "reasonId")
     VALUES ($1, $2, now() - interval '13 months 2 days', now() - interval '13 months', $3),
            ($1, $2, now() - interval '11 months 2 days', now() - interval '11 months', $3)`,
    [s, teacher.id, reason.id],
  );
  await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3)`, [s, guardian.id, gone.id]);

  // Departed two years ago (and `days` more): the dating trigger stamps
  // now(), so the owner back-dates with it off for these rows alone.
  const depart = async (ids: string[], days = 0) => {
    await owner.query(`UPDATE "Users" SET "isActive" = false, "updatedAt" = now() WHERE id = ANY($1::uuid[])`, [ids]);
    await owner.query(`ALTER TABLE "Users" DISABLE TRIGGER "Users_deactivation_is_dated_on_update"`);
    try {
      await owner.query(`UPDATE "Users" SET "deactivatedAt" = now() - interval '2 years' - make_interval(days => $2) WHERE id = ANY($1::uuid[])`, [ids, days]);
    } finally {
      await owner.query(`ALTER TABLE "Users" ENABLE TRIGGER "Users_deactivation_is_dated_on_update"`);
    }
  };
  await depart([gone.id, stuck.id, autumn.id]);

  const other = await one<{ id: string }>(`SELECT id FROM "Schools" WHERE id <> $1 ORDER BY "createdAt" LIMIT 1`, [s]);
  const othersRows = () =>
    one<Record<string, string>>(
      `SELECT (SELECT count(*) FROM "AttendanceRecords" WHERE "schoolId" <> $1) AS att,
              (SELECT count(*) FROM "AbsenceReports" WHERE "schoolId" <> $1) AS abs,
              (SELECT count(*) FROM "LeaveRequests" WHERE "schoolId" <> $1) AS leave,
              (SELECT count(*) FROM "Notifications" WHERE "schoolId" <> $1) AS noti,
              (SELECT count(*) FROM "ScheduleChangeLogs" WHERE "schoolId" <> $1) AS logs,
              (SELECT count(*) FROM "TeacherEmploymentLogs" WHERE "schoolId" <> $1) AS emp,
              (SELECT count(*) FROM "TeacherAbsences" WHERE "schoolId" <> $1 AND "reasonId" IS NOT NULL) AS reasons,
              (SELECT md5(string_agg(u::text, ',' ORDER BY id)) FROM "Users" u WHERE "schoolId" <> $1) AS users`,
      [s],
    );
  assert.ok(other, 'gallring: no other school to watch');

  const service = new GallringService(api);
  const deleted: string[] = [];
  // (gf) acts in here, as if somebody did something while a login was being deleted.
  let whileDeleting: ((authId: string) => Promise<void>) | null = null;
  const supabase = {
    deleteUser: async (authId: string) => {
      if (authId === stuck.authId && !deleted.includes('retry')) throw new Error('Supabase delete failed: 500');
      await whileDeleting?.(authId);
      deleted.push(authId);
    },
  };
  const runner = new JobRunner(api);
  const job = new GallringJob(api, supabase as unknown as SupabaseAdminService, undefined, runner);
  // The job's log lines are kept, to be read for names in (gc).
  const lines: string[] = [];
  Logger.overrideLogger({
    log: (m: unknown) => void lines.push(String(m)),
    warn: (m: unknown) => void lines.push(String(m)),
    error: (m: unknown) => void lines.push(String(m)),
    debug: (m: unknown) => void lines.push(String(m)),
    verbose: (m: unknown) => void lines.push(String(m)),
  });
  try {

    await check('(ga) the page: ej beslutat, a period that waits a day and previews, KEEP without months, the admin\'s alone', async () => {
      const before = await service.overview(asAdmin);
      assert.ok(before.kinds.every((kind) => kind.current === null && kind.preview === null), 'a kind was decided before anyone decided');
      const after = await service.decide({ dataType: 'ATTENDANCE', decision: 'PURGE_AFTER', months: 12, reference: 'DHP probe' }, asAdmin);
      const attendance = after.kinds.find((kind) => kind.dataType === 'ATTENDANCE')!;
      assert.equal(attendance.current?.decidedBy, 'admin Probe');
      assert.ok(attendance.waitsUntil && attendance.waitsUntil > today, `a new period applies at once (${attendance.waitsUntil})`);
      assert.deepEqual(attendance.preview, { cutoff: (await one<{ d: string }>(`SELECT ${ago(12)}::text AS d`)).d, due: 1, held: 0 });
      const preview = await service.preview({ dataType: 'DEPARTED_PEOPLE', months: 12 }, asAdmin);
      assert.deepEqual([preview.due, preview.held], [2, 1], `departed preview ${JSON.stringify(preview)}`);
      await assert.rejects(service.decide({ dataType: 'NOTIFICATIONS', decision: 'KEEP', months: 3 }, asAdmin), /Bara en gallringsperiod/);
      await assert.rejects(service.preview({ dataType: 'ATTENDANCE', months: 12 }, asTeacher), /Bara skolans administratör/);
    });

    // The night below runs on periods the owner dates two days back, as if
    // they had been made then. The admin's 12 months above stays the newest,
    // and equal, so it changes nothing tonight.

    await owner.query(`ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_stamped"`);
    try {
      await owner.query(
        `INSERT INTO "RetentionDecisions" ("schoolId", "dataType", decision, months, "decidedById", "decidedAt")
         SELECT $1, k::"RetentionDataType", 'PURGE_AFTER', m, $2, now() - interval '2 days'
           FROM (VALUES ('ATTENDANCE', 12), ('ABSENCE_REPORTS', 6), ('LEAVE_REQUESTS', 12), ('CHANGE_LOGS', 24),
                        ('ABSENCE_REASONS', 12), ('DEPARTED_PEOPLE', 12)) AS d(k, m)`,
        [s, admin.id],
      );
    } finally {
      await owner.query(`ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_stamped"`);
    }

    await check('(gb) one night takes exactly what the periods say, and nothing of another school', async () => {
      const othersBefore = await othersRows();
      const result = await job.runSchool(s);
      assert.deepEqual(await othersRows(), othersBefore, 'another school moved');
      assert.equal(await count(`SELECT count(*) AS n FROM "AttendanceRecords" a JOIN "CalendarLessons" l ON l.id = a."calendarLessonId" WHERE a."schoolId" = $1 AND l.date < ${ago(12)}`, [s]), 0);
      assert.equal(await count(`SELECT count(*) AS n FROM "AttendanceRecords" WHERE "schoolId" = $1`, [s]), 2, 'attendance on or after the cutoff went');
      assert.equal(await count(`SELECT count(*) AS n FROM "AbsenceReports" WHERE "schoolId" = $1`, [s]), 1);
      assert.equal(await count(`SELECT count(*) AS n FROM "LeaveRequests" WHERE "schoolId" = $1 AND "endDate" >= ${ago(12)}`, [s]), 1, 'the request that ended after the cutoff went');
      assert.equal(await count(`SELECT count(*) AS n FROM "LeaveRequests" WHERE "schoolId" = $1`, [s]), 1);
      assert.equal(await count(`SELECT count(*) AS n FROM "Notifications" WHERE "schoolId" = $1 AND "createdAt" < now() - interval '4 years'`, [s]), 1, 'a notice went without a decision');
      assert.equal(await count(`SELECT count(*) AS n FROM "ScheduleChangeLogs" WHERE "schoolId" = $1`, [s]), 1);
      assert.equal(await count(`SELECT count(*) AS n FROM "TeacherEmploymentLogs" WHERE "academicYearId" = $1`, [year.id]), 0, '2019/20 history stayed');
      assert.ok((await count(`SELECT count(*) AS n FROM "TeacherEmploymentLogs" WHERE "academicYearId" = $1`, [current.id])) >= 2, 'this läsår\'s history went');
      assert.equal(await count(`SELECT count(*) AS n FROM "TeacherAbsences" WHERE "schoolId" = $1 AND "reasonId" IS NOT NULL`, [s]), 1);
      assert.equal(await count(`SELECT count(*) AS n FROM "TeacherAbsences" WHERE "schoolId" = $1`, [s]), 2, 'an absence went with its reason');
      // Attendance, an absence report, a request, a schedule log and 2019/20's
      // one version, an absence's reason.
      assert.equal(result.rows, 1 + 1 + 1 + 2 + 1, `rows ${result.rows}`);

      const run = await one<{ status: string; counts: Record<string, number>; complete: Record<string, boolean> }>(
        `SELECT status, counts, complete FROM "GallringRuns" WHERE "schoolId" = $1 ORDER BY "startedAt" DESC LIMIT 1`,
        [s],
      );
      assert.equal(run.status, 'DONE');
      assert.deepEqual(run.counts, { ATTENDANCE: 1, ABSENCE_REPORTS: 1, LEAVE_REQUESTS: 1, CHANGE_LOGS: 2, ABSENCE_REASONS: 1, DEPARTED_PEOPLE: 1 });
      const purged = await service.purgedBefore(asTeacher);
      assert.deepEqual(
        purged.map((p) => p.dataType),
        ['ATTENDANCE', 'ABSENCE_REPORTS', 'LEAVE_REQUESTS', 'CHANGE_LOGS', 'ABSENCE_REASONS'],
      );
      assert.equal(purged[0]!.purgedBefore, (await one<{ d: string }>(`SELECT ${ago(12)}::text AS d`)).d);
    });

    await check('(gc) the departed: login first, the stuck one waits and is counted, SCB holds the autumn teacher, the next night takes the rest', async () => {
      assert.deepEqual(deleted, [gone.authId], `logins deleted ${JSON.stringify(deleted)}`);
      const people = await owner.query<{ id: string; firstName: string; email: string; authId: string; pseudonymisedAt: Date | null }>(
        `SELECT id, "firstName", email, "authId", "pseudonymisedAt" FROM "Users" WHERE id = ANY($1::uuid[])`,
        [[gone.id, stuck.id, autumn.id]],
      );
      const byId = new Map(people.rows.map((row) => [row.id, row]));
      assert.equal(byId.get(gone.id)?.firstName, 'Pseudonym');
      assert.equal(byId.get(gone.id)?.email, `pseudonym-${gone.id}@pseudonym.invalid`);
      assert.notEqual(byId.get(gone.id)?.authId, gone.authId);
      assert.equal(byId.get(stuck.id)?.pseudonymisedAt, null, 'a person whose login stayed was pseudonymised');
      assert.equal(byId.get(autumn.id)?.pseudonymisedAt, null, 'SCB\'s teacher was pseudonymised');
      assert.equal(await count(`SELECT count(*) AS n FROM "GuardianStudents" WHERE "studentId" = $1`, [gone.id]), 0);
      const waiting = await one<{ waiting: Record<string, number> }>(
        `SELECT waiting FROM "GallringRuns" WHERE "schoolId" = $1 ORDER BY "startedAt" DESC LIMIT 1`,
        [s],
      );
      assert.deepEqual(waiting.waiting, { DEPARTED_PEOPLE_SCB: 1, DEPARTED_PEOPLE_LOGIN: 1 });

      deleted.push('retry');
      const next = await job.runSchool(s);
      assert.equal(next.people, 1);
      assert.equal(next.rows, 0, 'the second night took rows the first had left');
      assert.ok((await one<{ p: Date | null }>(`SELECT "pseudonymisedAt" AS p FROM "Users" WHERE id = $1`, [stuck.id])).p !== null);
      // The job logged ids and counts, and never a name or an e-mail.
      assert.ok(lines.some((line) => line.startsWith(`Gallring [school=${s}, `)), `no summary line in ${JSON.stringify(lines)}`);
      for (const line of lines) assert.ok(!/Probe|example\.invalid|Pseudonym/.test(line), `a log line carries a name: ${line}`);
    });

    await check('(gd) the runner: gallring_schools names the school, one claim a night, a settled pass is a row of counts', async () => {
      const schools = await api.withDeliveryService((tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM app.gallring_schools() AS id`);
      assert.ok(schools.some((row) => row.id === s), 'gallring_schools left out a school with periods');
      const noon = new Date(`${today}T10:00:00Z`);
      const job2 = `${marker}-gallring`;
      const [claimed] = await runner.claimNightly(job2, 3, [s], 5, noon);
      assert.equal(claimed?.schoolId, s);
      assert.deepEqual(await runner.claimNightly(job2, 3, [s], 5, new Date(noon.getTime() + 3_600_000)), []);
      await runner.finishNightly(job2, s, claimed!.localDay, new Date(noon.getTime() + 60_000));
      assert.deepEqual(await runner.claimNightly(job2, 3, [s], 5, new Date(noon.getTime() + 5 * 3_600_000)), []);

      runner.settled(job2, new Date(Date.now() - 1000), { ok: true, counts: { schools: 1, rows: 7 } });
      runner.settled(job2, new Date(Date.now() - 500), { ok: false, error: 'PrismaClientKnownRequestError' });
      for (let i = 0; i < 50; i += 1) {
        const row = (await owner.query<{ runs: number; failures: number; counts: Record<string, number>; lastError: string | null }>(
          `SELECT runs, failures, counts, "lastError" FROM "JobRuns" WHERE job = $1`,
          [job2],
        )).rows[0];
        if (row?.runs === 2) {
          assert.deepEqual([row.failures, row.counts, row.lastError], [1, { schools: 1, rows: 7 }, 'PrismaClientKnownRequestError']);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail('the two settled passes never reached JobRuns');
    });

    await check('(ge) Notiser bevaras: a departed person\'s own notices go with the name, a guardian\'s that names them stays', async () => {
      await service.decide({ dataType: 'NOTIFICATIONS', decision: 'KEEP' }, asAdmin);
      const quiet = await person('STUDENT', 'quiet');
      await owner.query(
        `INSERT INTO "Notifications" ("schoolId", "userId", type, "createdAt")
         VALUES ($1, $2, 'SCHEDULE_CHANGED', now() - interval '1 hour'), ($1, $2, 'LESSON_CANCELLED', now() - interval '3 years')`,
        [s, quiet.id],
      );
      const kept = await one<{ id: string }>(
        `INSERT INTO "Notifications" ("schoolId", "userId", type, meta, "createdAt")
         VALUES ($1, $2, 'ABSENCE_UNREPORTED', jsonb_build_object('studentName', 'quiet Probe'), now() - interval '1 hour') RETURNING id`,
        [s, guardian.id],
      );
      await depart([quiet.id]);
      const others = await count(`SELECT count(*) AS n FROM "Notifications" WHERE "schoolId" = $1 AND "userId" <> $2`, [s, quiet.id]);

      const night = await job.runSchool(s);
      assert.equal(night.people, 1, `people ${night.people}`);
      assert.equal(
        (await one<{ f: string }>(`SELECT "firstName" AS f FROM "Users" WHERE id = $1`, [quiet.id])).f,
        'Pseudonym',
      );
      assert.equal(await count(`SELECT count(*) AS n FROM "Notifications" WHERE "userId" = $1`, [quiet.id]), 0, 'a pseudonym kept a notice of their own');
      assert.equal(await count(`SELECT count(*) AS n FROM "Notifications" WHERE id = $1`, [kept.id]), 1, 'the guardian\'s notice went with the pupil\'s name');
      assert.equal(
        await count(`SELECT count(*) AS n FROM "Notifications" WHERE "schoolId" = $1 AND "userId" <> $2`, [s, quiet.id]),
        others,
        'a notice of somebody else went under Notiser bevaras',
      );
      const run = await one<{ counts: Record<string, number> }>(
        `SELECT counts FROM "GallringRuns" WHERE "schoolId" = $1 ORDER BY "startedAt" DESC LIMIT 1`,
        [s],
      );
      assert.equal(run.counts['NOTIFICATIONS'], undefined, `the run counted notices under KEEP: ${JSON.stringify(run.counts)}`);
    });

    await check('(gf) a person reactivated or spared mid-run keeps their login: the claim waits for the lock, then answers nothing', async () => {
      const begin = async () =>
        (await api.withDeliveryService((tx) =>
          tx.$queryRaw<Array<{ run: string }>>`SELECT app.gallring_begin(${s}::uuid, ${new Date()}::timestamptz) AS run`,
        ))[0]!.run;
      const claim = (run: string, userId: string) =>
        api.withDeliveryService((tx) =>
          tx.$queryRaw<Array<{ auth_id: string; invited: boolean }>>`SELECT auth_id, invited FROM app.gallring_claim_person(${run}::uuid, ${userId}::uuid)`,
        );
      const state = (id: string) =>
        one<{ isActive: boolean; authId: string; pseudonymisedAt: Date | null }>(
          `SELECT "isActive", "authId", "pseudonymisedAt" FROM "Users" WHERE id = $1`,
          [id],
        );

      // A reactivation in flight: the owner holds the row's lock, uncommitted.
      const back = await person('STUDENT', 'back', true, true);
      await depart([back.id]);
      let run = await begin();
      assert.deepEqual(await claim(run, back.id), [{ auth_id: back.authId, invited: true }], 'a due person was not claimed');
      await owner.query('BEGIN');
      let settled = false;
      let waited = false;
      let claimed: Promise<Array<{ auth_id: string; invited: boolean }>> | null = null;
      try {
        await owner.query(`UPDATE "Users" SET "isActive" = true, "updatedAt" = now() WHERE id = $1`, [back.id]);
        claimed = claim(run, back.id);
        void claimed.then(() => (settled = true), () => (settled = true));
        for (let i = 0; i < 100 && !waited && !settled; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          await owner.query('SELECT pg_stat_clear_snapshot()');
          waited = (await owner.query(
            `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%gallring_claim_person%' AND pid <> pg_backend_pid()`,
          )).rowCount === 1;
        }
      } finally {
        await owner.query('COMMIT');
      }
      assert.ok(waited && !settled, `the claim answered before the reactivation committed (waited ${waited}, settled ${settled})`);
      assert.deepEqual(await claimed, [], 'the claim answered for a person reactivated while it waited');

      // Through the night: while the first person's login is being deleted,
      // the second is reactivated, and the night no longer touches them.
      const first = await person('STUDENT', 'first', true, true);
      const second = await person('STUDENT', 'second', true, true);
      await depart([first.id], 1);
      await depart([second.id]);
      whileDeleting = async (authId) => {
        if (authId === first.authId) {
          await owner.query(`UPDATE "Users" SET "isActive" = true, "updatedAt" = now() WHERE id = $1`, [second.id]);
        }
      };
      const before = deleted.length;
      try {
        const night = await job.runSchool(s);
        assert.equal(night.people, 1, `people ${night.people}`);
      } finally {
        whileDeleting = null;
      }
      assert.deepEqual(deleted.slice(before), [first.authId], `logins deleted ${JSON.stringify(deleted.slice(before))}`);
      assert.ok((await state(first.id)).pseudonymisedAt !== null, 'the first person was not pseudonymised');
      const kept = await state(second.id);
      assert.deepEqual([kept.isActive, kept.authId, kept.pseudonymisedAt], [true, second.authId, null], 'the reactivated person was touched');
      assert.ok(!lines.some((line) => line.includes('no longer due')), 'a login went for a person no longer due');

      // A KEEP recorded mid-run: nobody is claimed after it.
      const third = await person('STUDENT', 'third');
      await depart([third.id]);
      run = await begin();
      assert.equal((await claim(run, third.id)).length, 1, 'a due person was not claimed');
      await service.decide({ dataType: 'DEPARTED_PEOPLE', decision: 'KEEP' }, asAdmin);
      assert.deepEqual(await claim(run, third.id), [], 'the claim answered under KEEP');
      assert.equal((await state(third.id)).pseudonymisedAt, null);
    });

    await check('(gg) a reactivation in flight while a person is pseudonymised: the night waits for it, leaves the person whole and finishes', async () => {
      // (gf)'s KEEP is taken back, so the period applies again tonight.
      await owner.query(`ALTER TABLE "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_append_only"`);
      try {
        await owner.query(`DELETE FROM "RetentionDecisions" WHERE "schoolId" = $1 AND "dataType" = 'DEPARTED_PEOPLE' AND decision = 'KEEP'`, [s]);
      } finally {
        await owner.query(`ALTER TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_append_only"`);
      }
      // (gf)'s third person, spared by the KEEP, is due again.
      const third = await one<{ id: string }>(`SELECT id FROM "Users" WHERE email = $1`, [`${marker}-third@example.invalid`]);
      const late = await person('STUDENT', 'late', true, true);
      await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3)`, [s, guardian.id, late.id]);
      await owner.query(`INSERT INTO "Notifications" ("schoolId", "userId", type, "createdAt") VALUES ($1, $2, 'SCHEDULE_CHANGED', now() - interval '1 hour')`, [s, late.id]);
      await depart([late.id]);

      // The claim has committed and the login is going when an admin makes
      // the person active again, and holds the row until the night's
      // pseudonymise waits for it.
      const reactivation: { held?: Promise<boolean> } = {};
      whileDeleting = async (authId) => {
        if (authId !== late.authId) return;
        await owner.query('BEGIN');
        await owner.query(`UPDATE "Users" SET "isActive" = true, "updatedAt" = now() WHERE id = $1`, [late.id]);
        reactivation.held = (async () => {
          let waited = false;
          try {
            for (let i = 0; i < 100 && !waited; i += 1) {
              await new Promise((resolve) => setTimeout(resolve, 20));
              await owner.query('SELECT pg_stat_clear_snapshot()');
              waited = (await owner.query(
                `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%gallring_pseudonymise%' AND pid <> pg_backend_pid()`,
              )).rowCount === 1;
            }
          } finally {
            await owner.query('COMMIT');
          }
          return waited;
        })();
      };
      const before = deleted.length;
      let night: { rows: number; people: number };
      let waited: boolean | undefined;
      try {
        night = await job.runSchool(s);
      } finally {
        whileDeleting = null;
        waited = await reactivation.held;
      }
      assert.equal(waited, true, 'the reactivation committed before the night asked for the row');
      assert.deepEqual(deleted.slice(before), [late.authId], `logins deleted ${JSON.stringify(deleted.slice(before))}`);
      assert.equal(night.people, 1, `people ${night.people}`);
      assert.ok(
        (await one<{ p: Date | null }>(`SELECT "pseudonymisedAt" AS p FROM "Users" WHERE id = $1`, [third.id])).p !== null,
        'the person still due was not pseudonymised',
      );
      const run = await one<{ status: string; counts: Record<string, number>; complete: Record<string, boolean> }>(
        `SELECT status, counts, complete FROM "GallringRuns" WHERE "schoolId" = $1 ORDER BY "startedAt" DESC LIMIT 1`,
        [s],
      );
      assert.deepEqual([run.status, run.counts['DEPARTED_PEOPLE'], run.complete['DEPARTED_PEOPLE']], ['DONE', 1, true], JSON.stringify(run));
      const kept = await one<{ isActive: boolean; firstName: string; pseudonymisedAt: Date | null }>(
        `SELECT "isActive", "firstName", "pseudonymisedAt" FROM "Users" WHERE id = $1`,
        [late.id],
      );
      assert.deepEqual([kept.isActive, kept.firstName, kept.pseudonymisedAt], [true, 'late', null], 'the reactivated person was pseudonymised');
      assert.equal(await count(`SELECT count(*) AS n FROM "GuardianStudents" WHERE "studentId" = $1`, [late.id]), 1, 'the reactivated person lost a guardian link');
      assert.equal(await count(`SELECT count(*) AS n FROM "Notifications" WHERE "userId" = $1`, [late.id]), 1, 'the reactivated person lost a notice');
      assert.ok(lines.includes(`Gallring removed the login of a person no longer due [school=${s}]`), `no line for the lost login in ${JSON.stringify(lines)}`);
    });
    assert.equal(GALLRING_JOB, 'gallring');
  } finally {
    Logger.overrideLogger(new ConsoleLogger());
    await sweepGallringSchool(owner, marker);
  }
}
