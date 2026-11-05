/**
 * The adapter probe's checks for Frånvarobevakning (20261231090000–20261231090100),
 * through the real AbsenceWatchService, AbsenceWatchJob and JobRunner on the
 * API's role, against real Postgres as CI runs it. The RLS sections prove what
 * the functions and the arms do; this proves what the gateway and the adapter
 * make of them: the casts of the job's parameters, the enum and date columns
 * read back, the transaction the digest and the read log share, and the claim
 * the runner takes. In a school of its own (slug <marker>-absence-watch), swept
 * whole before and after, with the lessons planted as the owner over the last
 * weeks of the school's own calendar:
 *
 *   wa  the page as the school's admin: off with no row, on with today's
 *       date, a limit of each kind, a second one for the same group, kind and
 *       basis a 409, figures of the other kind a 400, and an edit and a removal;
 *   wb  one night through AbsenceWatchJob.runSchool with no principal: a pupil
 *       absent the last four school days is over the share limit and the run
 *       limit, the one who was present is not, a second count of the same
 *       night changes nothing, and the week's digests are written once and
 *       handed to the delivery: the mentor, the guardian and the administrators
 *       each one notice with a count and a period, and a row in the read log;
 *   wc  the view: the administrator reads all three findings, the mentor the
 *       one of their class, the guardian the one of their child and the other
 *       guardian none, each read recorded as attendance and as people;
 *   wd  the runner's glue: app.absence_watch_schools names the school, the
 *       nightly claim is taken once and not again once finished;
 *   we  the switch turned off while a count is in progress waits for the
 *       count and then closes what it wrote (two connections, the second
 *       seen waiting on a lock before the first commits).
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Client } from 'pg';
import { AbsenceWatchJob } from '../../src/absence-watch/absence-watch.job';
import { ABSENCE_WATCH_JOB } from '../../src/absence-watch/absence-watch';
import { AbsenceWatchService } from '../../src/absence-watch/absence-watch.service';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { JobRunner } from '../../src/jobs/job-runner';
import type { OutboxEntry } from '../../src/notifications/notification-outbox';
import type { NotificationsService } from '../../src/notifications/notifications.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function absenceWatchSlug(marker: string): string {
  return `${marker}-absence-watch`;
}

export async function sweepAbsenceWatchSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [absenceWatchSlug(marker)]);
}

export async function absenceWatchChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepAbsenceWatchSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await one<{ n: string }>(sql, params)).n);
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;

  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${marker} absence watch`, absenceWatchSlug(marker)],
  );
  const s = school.id;
  const person = async (role: string, label: string, extra: { adminProfile?: string; group?: string } = {}) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "studentGroupId", "authId", "isActive", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4::"UserRole", $5::"AdminProfile", $6, $7, true, now()) RETURNING id`,
      [s, `${marker}-aw-${label}@example.invalid`, label, role, extra.adminProfile ?? null, extra.group ?? null, authId],
    );
    return { id: row.id, authId };
  };
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, 'aw probe', '${today}'::date - 200, '${today}'::date + 200, true, now()) RETURNING id`,
    [s],
  );
  const group = await one<{ id: string }>(
    `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES ($1, $2, 'AW7A', 7, now()) RETURNING id`,
    [s, year.id],
  );
  const subject = await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'AW', 'AWP', now()) RETURNING id`, [s]);
  const admin = await person('SCHOOL_ADMIN', 'admin', { adminProfile: 'FULL' });
  const mentor = await person('TEACHER', 'mentor');
  const other = await person('TEACHER', 'other');
  const absent = await person('STUDENT', 'absent', { group: group.id });
  const present = await person('STUDENT', 'present', { group: group.id });
  const guardian = await person('GUARDIAN', 'guardian');
  const guardianOfPresent = await person('GUARDIAN', 'guardian-present');
  await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3), ($1, $4, $5)`, [
    s, guardian.id, absent.id, guardianOfPresent.id, present.id,
  ]);
  await owner.query(
    `INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "updatedAt")
     VALUES ($1, $2, $3, 'MENTORSKAP', 'Mentor AW7A', 60, $4, now())`,
    [s, mentor.id, year.id, group.id],
  );
  const as = (who: { id: string; authId: string }, role: Role, adminProfile?: 'FULL'): AuthenticatedUser => ({
    authId: who.authId, role, userId: who.id, schoolId: s, ...(adminProfile ? { adminProfile } : {}),
  });
  const asAdmin = as(admin, Role.SCHOOL_ADMIN, 'FULL');

  const service = new AbsenceWatchService(api);

  await check('wa: the page: off until turned on, limits of both kinds, a duplicate is a 409, wrong figures a 400, an edit and a removal', async () => {
    const before = await service.overview(asAdmin);
    assert.equal(before.settings.enabled, false, 'the school started with the bevakning on');
    assert.equal(before.settings.enabledOn, null);
    assert.deepEqual(before.settings.cadence, { MENTOR: 'WEEKLY', REKTOR: 'WEEKLY', KANSLI: 'WEEKLY', GUARDIAN: 'MONTHLY' });
    assert.deepEqual(before.limits, []);

    const on = await service.updateSettings({ enabled: true }, asAdmin);
    assert.equal(on.settings.enabled, true);
    assert.equal(on.settings.enabledOn, today, 'the switch was not dated with the school\'s own day');

    const share = await service.createLimit({ recipientGroup: 'MENTOR', kind: 'SHARE', basis: 'INVALID', percent: 10, windowDays: 14 }, asAdmin);
    assert.deepEqual([share.percent, share.windowDays, share.consecutiveDays], [10, 14, null]);
    await service.createLimit({ recipientGroup: 'GUARDIAN', kind: 'SHARE', basis: 'INVALID', percent: 10, windowDays: 14 }, asAdmin);
    await service.createLimit({ recipientGroup: 'REKTOR', kind: 'CONSECUTIVE', basis: 'ALL', consecutiveDays: 3 }, asAdmin);
    await assert.rejects(
      service.createLimit({ recipientGroup: 'MENTOR', kind: 'SHARE', basis: 'INVALID', percent: 20, windowDays: 30 }, asAdmin),
      ConflictException,
    );
    await assert.rejects(
      service.createLimit({ recipientGroup: 'KANSLI', kind: 'SHARE', basis: 'ALL', consecutiveDays: 3 }, asAdmin),
      BadRequestException,
    );
    const edited = await service.updateLimit(share.id, { percent: 12, windowDays: 14 }, asAdmin);
    assert.equal(edited.percent, 12);
    const back = await service.updateLimit(share.id, { percent: 10, windowDays: 14 }, asAdmin);
    assert.equal(back.percent, 10);
    const temp = await service.createLimit({ recipientGroup: 'KANSLI', kind: 'CONSECUTIVE', basis: 'VALID', consecutiveDays: 5 }, asAdmin);
    await service.deleteLimit(temp.id, asAdmin);
    assert.equal((await service.overview(asAdmin)).limits.length, 3, 'the removed limit is still there');
  });

  // The calendar: weekdays of the last 14 days, two lessons of 60 minutes
  // each. The absent pupil was absent on the last four school days and
  // present before; the other was present throughout.
  const weekdays = (
    await owner.query<{ d: string }>(
      `SELECT g::date::text AS d FROM generate_series('${today}'::date - 14, '${today}'::date - 1, interval '1 day') g
        WHERE extract(isodow FROM g) < 6 ORDER BY g`,
    )
  ).rows.map((r) => r.d);
  const lastFour = new Set(weekdays.slice(-4));
  for (const day of weekdays) {
    for (const slot of [0, 1]) {
      const lesson = await one<{ id: string }>(
        `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
         VALUES ($1, $2, $3, $4::date, ($4::date + time '08:00') AT TIME ZONE 'Europe/Stockholm' + $5 * interval '70 minutes',
                 ($4::date + time '09:00') AT TIME ZONE 'Europe/Stockholm' + $5 * interval '70 minutes', now()) RETURNING id`,
        [s, subject.id, group.id, day, slot],
      );
      await owner.query(
        `INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "updatedAt")
         VALUES ($1, $2, $3, $4::"AttendanceStatus", now()), ($1, $2, $5, 'PRESENT', now())`,
        [s, lesson.id, absent.id, lastFour.has(day) ? 'ABSENT' : 'PRESENT', present.id],
      );
    }
  }
  // The switch went on long ago, so that the last whole week and month are due.
  await owner.query(`ALTER TABLE "AbsenceWatchSettings" DISABLE TRIGGER "AbsenceWatchSettings_stamp"`);
  await owner.query(`UPDATE "AbsenceWatchSettings" SET "enabledOn" = '${today}'::date - 62 WHERE "schoolId" = $1`, [s]);
  await owner.query(`ALTER TABLE "AbsenceWatchSettings" ENABLE TRIGGER "AbsenceWatchSettings_stamp"`);

  const delivered: OutboxEntry[] = [];
  const notifications = { deliverCommitted: (entries: readonly OutboxEntry[]) => delivered.push(...entries) } as unknown as NotificationsService;
  const runner = new JobRunner(api);
  const job = new AbsenceWatchJob(api, notifications, undefined, runner);
  const localDay = new Date(`${today}T00:00:00Z`);

  await check('wb: one night: the pupil over the limits is found, the digests are written once and told', async () => {
    const counts = await job.runSchool(s, localDay);
    assert.equal(counts.pupils, 2, 'the pupils with registered lessons');
    assert.equal(counts.opened, 3, 'the findings: the share limit of the mentors and of the guardians, the run limit of rektor');
    assert.equal(await count(`SELECT count(*) AS n FROM "AbsenceWatchFindings" WHERE "schoolId" = $1 AND "clearedOn" IS NULL`, [s]), 3);
    const rows = (
      await owner.query<{ g: string; kind: string; first: string; abs: number | null; rec: number | null; streak: number | null; who: string }>(
        `SELECT f."recipientGroup"::text AS g, f.kind::text AS kind, f."firstCrossedOn"::text AS first, f."absentMinutes" AS abs,
                f."recordedMinutes" AS rec, f."streakDays" AS streak, u."firstName" AS who
           FROM "AbsenceWatchFindings" f JOIN "Users" u ON u.id = f."studentId" WHERE f."schoolId" = $1 ORDER BY 1`,
        [s],
      )
    ).rows;
    assert.deepEqual(rows.map((r) => `${r.who} ${r.g} ${r.kind}`), ['absent GUARDIAN SHARE', 'absent MENTOR SHARE', 'absent REKTOR CONSECUTIVE']);
    const share = rows.find((r) => r.kind === 'SHARE')!;
    assert.equal(share.abs, 480, 'four school days of two lessons of 60 minutes');
    assert.ok(share.rec! >= 480, 'the registered minutes include the absent ones');
    assert.equal(rows.find((r) => r.kind === 'CONSECUTIVE')!.streak, 4);

    // The digests: the mentors', the guardians' and rektor's are written; nothing for kansli, which has no limit.
    assert.equal(counts.digests, 3, 'the groups with a limit');
    assert.equal(counts.notices, 3, 'the mentor, the guardian of the absent pupil and the administrator');
    assert.equal(delivered.length, 3);
    assert.ok(delivered.every((entry) => entry.type === 'ABSENCE_WATCH_DIGEST' && entry.schoolId === s));
    for (const entry of delivered) {
      assert.deepEqual(Object.keys(entry.meta).sort(), ['crossed', 'group', 'open', 'periodEnd', 'periodStart']);
      assert.doesNotMatch(entry.email!.body, /Probe|absent|present|@/, 'a digest named someone');
    }
    assert.equal(await count(`SELECT count(*) AS n FROM "Notifications" WHERE "schoolId" = $1 AND type = 'ABSENCE_WATCH_DIGEST'`, [s]), 3);
    assert.equal(await count(`SELECT count(*) AS n FROM "AbsenceWatchDigests" WHERE "schoolId" = $1`, [s]), 3);
    // The read log: each recipient read the absent pupil, as attendance, through the digest.
    const reads = (
      await owner.query<{ who: string; subjects: string[]; channel: string; size: number }>(
        `SELECT u."firstName" AS who, a."subjectIds"::text[] AS subjects, a.channel::text AS channel, a."readSize" AS size
           FROM "PersonalDataAccess" a JOIN "Users" u ON u.id = a."actorId"
          WHERE a."schoolId" = $1 AND a.kind = 'ATTENDANCE' ORDER BY u."firstName"`,
        [s],
      )
    ).rows;
    assert.deepEqual(reads.map((r) => r.who), ['admin', 'guardian', 'mentor']);
    for (const read of reads) {
      assert.deepEqual(read.subjects, [absent.id]);
      assert.equal(read.channel, 'OTHER');
      assert.equal(read.size, 1);
    }

    // The same night again changes nothing: the count finds the same, the ledger holds the digests.
    delivered.length = 0;
    const again = await job.runSchool(s, localDay);
    assert.deepEqual([again.opened, again.closed, again.digests, again.notices], [0, 0, 0, 0]);
    assert.equal(delivered.length, 0);
    assert.equal(await count(`SELECT count(*) AS n FROM "AbsenceWatchFindings" WHERE "schoolId" = $1`, [s]), 3);
  });

  await check('wc: the view: each role reads its own findings, and each read is in the log', async () => {
    const before = await count(`SELECT count(*) AS n FROM "PersonalDataAccess" WHERE "schoolId" = $1 AND kind = 'PEOPLE'`, [s]);
    const all = await service.findings({}, { ...asAdmin, channel: 'WEB' });
    assert.equal(all.findings.length, 3);
    assert.ok(all.findings.every((f) => f.studentName === 'absent Probe' && f.className === 'AW7A' && f.clearedOn === null));
    const mine = await service.findings({}, as(mentor, Role.TEACHER));
    assert.deepEqual(mine.findings.map((f) => f.recipientGroup), ['MENTOR']);
    const child = await service.findings({}, as(guardian, Role.GUARDIAN));
    assert.deepEqual(child.findings.map((f) => f.recipientGroup), ['GUARDIAN']);
    assert.deepEqual((await service.findings({}, as(guardianOfPresent, Role.GUARDIAN))).findings, []);
    assert.deepEqual((await service.findings({}, as(other, Role.TEACHER))).findings, []);
    const share = all.findings.find((f) => f.kind === 'SHARE')!;
    assert.equal(share.absentMinutes, 480);
    assert.equal(share.streakDays, null);
    // The reads of people: the administrator's, the mentor's and the guardian's, each a row of PEOPLE.
    const after = await count(`SELECT count(*) AS n FROM "PersonalDataAccess" WHERE "schoolId" = $1 AND kind = 'PEOPLE'`, [s]);
    assert.equal(after - before, 3, 'a read of findings is a read of people, once per reader');
    // The recent ones, none of them closed yet.
    assert.equal((await service.findings({ recent: true }, asAdmin)).findings.length, 3);
  });

  await check('wd: the runner: the school is listed, its night is claimed once and not again once finished', async () => {
    const listed = await api.withDeliveryService((tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM app.absence_watch_schools() AS id`);
    assert.ok(listed.some((row) => row.id === s), 'the school with the switch on is not on the job\'s list');
    const claimed = await runner.claimNightly(ABSENCE_WATCH_JOB, 0, [s], 5, new Date());
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.schoolId, s);
    assert.equal((await runner.claimNightly(ABSENCE_WATCH_JOB, 0, [s], 5, new Date())).length, 0, 'a night in progress was claimed twice');
    await runner.finishNightly(ABSENCE_WATCH_JOB, s, claimed[0]!.localDay, new Date());
    assert.equal((await runner.claimNightly(ABSENCE_WATCH_JOB, 0, [s], 5, new Date())).length, 0, 'a finished night was claimed again');
    // Turned off: the school leaves the list and its findings close.
    await service.updateSettings({ enabled: false }, asAdmin);
    const gone = await api.withDeliveryService((tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM app.absence_watch_schools() AS id`);
    assert.ok(!gone.some((row) => row.id === s));
    assert.equal(await count(`SELECT count(*) AS n FROM "AbsenceWatchFindings" WHERE "schoolId" = $1 AND "clearedOn" IS NULL`, [s]), 0);
    assert.equal((await service.findings({ recent: true }, asAdmin)).findings.length, 3, 'the closed findings are the recent ones');
    assert.equal((await service.findings({}, asAdmin)).findings.length, 0);
  });

  await check('we: turning the switch off waits for a count in progress and then closes its findings', async () => {
    await service.updateSettings({ enabled: true }, asAdmin);
    const yesterday = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date - 1)::text AS d`)).d;
    const counting = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
    const switching = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
    await counting.connect();
    await switching.connect();
    try {
      await counting.query('BEGIN');
      const counted = await counting.query<{ opened: number }>(`SELECT opened FROM app.absence_watch_evaluate($1::uuid, $2::date)`, [s, yesterday]);
      assert.equal(counted.rows[0]!.opened, 3, 'the count in progress found the three findings again');
      const backend = (await switching.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
      const off = switching.query(`UPDATE "AbsenceWatchSettings" SET enabled = false WHERE "schoolId" = $1`, [s]);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = (
          await owner.query(`SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`, [backend])
        ).rowCount === 1;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(waiting, 'the switch was turned off under a count that was still reading it');
      await counting.query('COMMIT');
      await off;
      assert.equal(await count(`SELECT count(*) AS n FROM "AbsenceWatchFindings" WHERE "schoolId" = $1 AND "clearedOn" IS NULL`, [s]), 0,
        'what the count wrote stayed open after the switch went off');
      assert.equal(await count(`SELECT count(*) AS n FROM "AbsenceWatchFindings" WHERE "schoolId" = $1`, [s]) >= 3, true);
    } finally {
      await counting.query('ROLLBACK').catch(() => undefined);
      await counting.end();
      await switching.end();
    }
  });

  await sweepAbsenceWatchSchool(owner, marker);
  await owner.query(`DELETE FROM "JobClaims" WHERE job = $1 AND "schoolId" = $2`, [ABSENCE_WATCH_JOB, s]);
}
