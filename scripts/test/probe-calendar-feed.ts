/**
 * Kalenderprenumeration (20261112091000) through the real services, against
 * Postgres:
 *
 *   kf-a  a teacher, a pupil and a guardian (per child) make their feeds
 *         through CalendarFeedsService; each lists their own and no one
 *         else's; the database holds the address's sha256 and never the
 *         address; a new address revokes the old;
 *   kf-b  a guardian's feed of a child is the family's week, lesson for
 *         lesson (FamilyScheduleService), this week and the next, after the
 *         child moved class today: times, subject, room, teachers as the
 *         school names them, cancelled and covered as the family sees them;
 *         and it ends with the active year's last week, as the family's
 *         week does;
 *   kf-c  a teacher's feed is the lessons the teacher is on in the window
 *         (CalendarLessonTeachers, as their own page reads it), last week's
 *         Monday to a year ahead, past the year's end, no more;
 *   kf-d  the feed written as iCalendar is the same bytes when asked twice
 *         at one moment, one VEVENT per lesson and day off, each lesson's
 *         UID its id and the child's; the guardian's two asks are one
 *         read-log row, CALENDAR, SCHEDULE of the child; the pupil's and the
 *         teacher's none; and the guardian's read of the week in the app
 *         right after the calendar's is written too;
 *   kf-e  the school switching an audience off revokes its feeds: the
 *         person's list is empty and the address answers nothing;
 *   kf-f  a feed asked for while its owner is being deactivated, or while
 *         the guardian's link to the child is deleted, waits for that and
 *         is refused, so none lives on silent until the owner or the link
 *         comes back; and a live feed the door refuses (its
 *         owner's role changed with the triggers off, as a restore runs) is
 *         ended by the door and stays ended when the role is put back;
 *   kf-g  a guardian's feed made during an SS12000 apply of the school waits
 *         for the apply (readLocalSlice holds the school's people lock), and
 *         in the apply's scan order that deadlocked before (the child's row
 *         locked, then the guardian's) the scan never waits for the feed:
 *         no side is aborted, and the feed is made after.
 */
import { strict as assert } from 'node:assert';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { CalendarFeedsService, readFeed } from '../../src/calendar-feed/calendar-feeds.service';
import { feedIcs } from '../../src/calendar-feed/ics';
import { icsProblems } from '../../src/calendar-feed/ics-check';
import type { PrismaService } from '../../src/database/prisma.service';
import { FamilyScheduleService } from '../../src/family/family-schedule.service';
import { readLocalSlice } from '../../src/integration/ss12000-sync/local-slice';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function calendarFeedSlug(marker: string): string {
  return `${marker}-kalender`;
}

export async function sweepCalendarFeedSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [calendarFeedSlug(marker)]);
}

const plus = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const mondayOf = (date: string) => plus(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));

export async function calendarFeedChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepCalendarFeedSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;
  const lastMonday = mondayOf(plus(today, -7));

  const s = (
    await one<{ id: string }>(
      `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
      [`${marker} kalender`, calendarFeedSlug(marker)],
    )
  ).id;
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
       VALUES ($1, 'probe kalender', $2::date - 60, $2::date + 300, true, 'NIOARIG', now()) RETURNING id`,
      [s, today],
    )
  ).id;
  const group = async (name: string, kind = 'CLASS', grade: number | null = 7) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
        [s, year, name, kind, grade],
      )
    ).id;
  const k7a = await group('K7A');
  const k7b = await group('K7B');
  const spanska = await group('K Spanska 7', 'TEACHING_GROUP', null);
  const subject = async (name: string) =>
    (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [s, name])).id;
  const ma = await subject('Matematik');
  const sp = await subject('Spanska');
  const room = (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, 'K-salen', now()) RETURNING id`, [s])).id;
  const person = async (role: string, first: string, last: string, groupId: string | null = null) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, true, $7, now()) RETURNING id`,
      [s, `${marker}-kalender-${first.toLowerCase()}@example.invalid`, first, last, role, authId, groupId],
    );
    return { id: row.id, authId };
  };
  const teacher = await person('TEACHER', 'Karin', 'Kalender');
  const colleague = await person('TEACHER', 'Kurt', 'Kollega');
  const pupil = await person('STUDENT', 'Kim', 'Elev', k7a);
  const sibling = await person('STUDENT', 'Kaj', 'Syskon', k7b);
  const guardian = await person('GUARDIAN', 'Kerstin', 'Förälder');
  const admin = await person('SCHOOL_ADMIN', 'Klara', 'Rektor');
  await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3), ($1, $2, $4)`, [s, guardian.id, pupil.id, sibling.id]);
  await owner.query(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES ($1, $2, $3)`, [s, spanska, pupil.id]);
  await owner.query(
    `INSERT INTO "PublicationSettings" ("schoolId", "publicTeacherDisplay", "calendarFeedTeachers", "calendarFeedStudents", "calendarFeedGuardians", "updatedAt")
     VALUES ($1, 'NAME', true, true, true, now())`,
    [s],
  );
  // The pupil was in K7A and moved to K7B today: the class history is the
  // database's to write, when the class changes.
  await owner.query(`UPDATE "Users" SET "studentGroupId" = $1 WHERE id = $2`, [k7b, pupil.id]);

  const lesson = async (groupId: string, subjectId: string, date: string, hour: number, teachers: Array<[string, string]>, status = 'SCHEDULED') => {
    const row = await one<{ id: string }>(
      `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", "roomId", date, "startsAt", "endsAt", status, "updatedAt")
       VALUES ($1, $2, $3, $4, $5::date, ($5::date + make_time($6, 0, 0)) AT TIME ZONE 'Europe/Stockholm',
               ($5::date + make_time($6 + 1, 0, 0)) AT TIME ZONE 'Europe/Stockholm', $7, now()) RETURNING id`,
      [s, subjectId, groupId, room, date, hour, status],
    );
    for (const [teacherId, role] of teachers) {
      await owner.query(`INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, $4)`, [s, row.id, teacherId, role]);
    }
    return row.id;
  };
  // Last week and this: K7A's (before the move), K7B's (the sibling's class, the pupil's from today), Spanska's.
  const thisMonday = mondayOf(today);
  for (const date of [lastMonday, plus(lastMonday, 2), thisMonday, plus(thisMonday, 3), plus(thisMonday, 7), plus(thisMonday, 9)]) {
    await lesson(k7a, ma, date, 8, [[teacher.id, 'LEAD']]);
    await lesson(k7b, ma, date, 9, [[colleague.id, 'LEAD'], [teacher.id, 'ASSISTANT']]);
    await lesson(spanska, sp, date, 10, [[teacher.id, 'LEAD']]);
  }
  await lesson(spanska, sp, plus(thisMonday, 8), 10, [[teacher.id, 'LEAD']], 'CANCELLED');
  // K7A's lesson with K7B as its extra group, next week: the pupil's by the new class.
  const shared = await lesson(k7a, sp, plus(thisMonday, 8), 13, [[colleague.id, 'LEAD']]);
  await owner.query(`INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId") VALUES ($1, $2, $3)`, [s, shared, k7b]);
  await lesson(spanska, sp, plus(thisMonday, 10), 10, [[colleague.id, 'SUBSTITUTE']]);
  // Outside the window: the day before last Monday, and a year and a day on.
  await lesson(spanska, sp, plus(lastMonday, -1), 10, [[teacher.id, 'LEAD']]);
  await lesson(spanska, sp, plus(today, 366), 10, [[teacher.id, 'LEAD']]);
  // After the active year (today + 300) and its last week, inside a year:
  // the teacher's, and not the family's (next year's groups may be
  // published before the year is activated).
  const yearsLastSunday = plus(mondayOf(plus(today, 300)), 6);
  const pastTheYear = await lesson(spanska, sp, plus(yearsLastSunday, 1), 10, [[teacher.id, 'LEAD']]);
  const inTheYearsLastWeek = await lesson(spanska, sp, yearsLastSunday, 10, [[teacher.id, 'LEAD']]);
  await owner.query(
    `INSERT INTO "SchoolBreaks" ("schoolId", "academicYearId", name, "startDate", "endDate", "updatedAt") VALUES ($1, $2, 'Höstlov', $3::date + 20, $3::date + 24, now())`,
    [s, year, today],
  );

  const principal = (who: { id: string; authId: string }, role: Role): AuthenticatedUser => ({ authId: who.authId, userId: who.id, schoolId: s, role });
  const asTeacher = principal(teacher, Role.TEACHER);
  const asPupil = principal(pupil, Role.STUDENT);
  const asGuardian = principal(guardian, Role.GUARDIAN);
  const feeds = new CalendarFeedsService(api);
  const tokens: Record<string, string> = {};

  try {
    await check('(kf-a) a teacher, a pupil and a guardian per child make their feeds, list only their own, and the database keeps only the hash', async () => {
      const mine = await feeds.mine(asGuardian);
      assert.deepEqual(mine, { enabled: true, feeds: [] });
      tokens.teacher = (await feeds.create({}, asTeacher)).token;
      tokens.pupil = (await feeds.create({ locale: 'en' }, asPupil)).token;
      const first = await feeds.create({ studentId: pupil.id }, asGuardian);
      tokens.child = (await feeds.create({ studentId: pupil.id }, asGuardian)).token;
      tokens.sibling = (await feeds.create({ studentId: sibling.id }, asGuardian)).token;
      assert.equal(await readFeed(api, first.token), null, 'the replaced address still answers');
      const listed = await feeds.mine(asGuardian);
      assert.deepEqual(listed.feeds.map((feed) => feed.studentId).sort(), [pupil.id, sibling.id].sort());
      assert.deepEqual((await feeds.mine(asPupil)).feeds.map((feed) => [feed.audience, feed.studentId, feed.locale]), [['STUDENT', pupil.id, 'en']]);
      await assert.rejects(feeds.create({ studentId: sibling.id }, asPupil), /Eleven finns inte/);
      const stored = await owner.query<{ tokenHash: string }>(`SELECT "tokenHash" FROM "CalendarFeeds" WHERE "schoolId" = $1`, [s]);
      for (const token of Object.values(tokens)) {
        assert.ok(stored.rows.some((row) => row.tokenHash === createHash('sha256').update(token).digest('hex')), 'a feed is not stored by its hash');
        assert.ok(!stored.rows.some((row) => row.tokenHash.includes(token)), 'an address is stored');
      }
    });

    await check('(kf-b) a guardian\'s feed of a child is the family\'s week, lesson for lesson, after the child moved class today', async () => {
      const document = await readFeed(api, tokens.child!);
      assert.ok(document, 'the child\'s feed answered nothing');
      const family = new FamilyScheduleService(api);
      for (const monday of [thisMonday, plus(thisMonday, 7)]) {
        const week = await family.week({ studentId: pupil.id, week: monday }, asGuardian);
        const fromFeed = document.lessons
          .filter((entry) => entry.date >= monday && entry.date <= plus(monday, 6))
          .map((entry) => ({
            id: entry.id,
            start: `${entry.date} ${entry.start.slice(9, 11)}:${entry.start.slice(11, 13)}`,
            subject: entry.subject,
            room: entry.room,
            teachers: entry.teachers,
            cancelled: entry.cancelled,
            substitute: entry.substitute,
          }));
        const fromFamily = week.lessons.map((entry) => ({
          id: entry.id,
          start: `${entry.date} ${entry.start}`,
          subject: entry.subject,
          room: entry.room,
          teachers: entry.teachers,
          cancelled: entry.status === 'CANCELLED',
          substitute: entry.substitute,
        }));
        assert.deepEqual(fromFeed, fromFamily, `the week of ${monday}`);
        assert.ok(fromFamily.length > 0, `the week of ${monday} holds no lesson to compare`);
      }
      // This week's K7A lessons before today are not the pupil's any more (the family's rule), K7B's from today are.
      assert.ok(!document.lessons.some((entry) => entry.date < today && entry.subject === 'Matematik'), 'a class lesson before the move');
      assert.equal(document.breaks.map((entry) => entry.name).join(), 'Höstlov');
      assert.ok(!JSON.stringify(document).includes('Kaj'), 'the sibling is named in the child\'s feed');
      assert.ok(document.lessons.some((entry) => entry.id === shared), 'a lesson of the new class as an extra group is not in the child\'s feed');
      // The family's week ends with the active year's last week, and so does the feed.
      assert.ok(document.lessons.some((entry) => entry.id === inTheYearsLastWeek), 'the year\'s last week is not in the child\'s feed');
      assert.ok(!document.lessons.some((entry) => entry.id === pastTheYear), 'a lesson past the year\'s last week is in the child\'s feed');
      assert.ok(document.lessons.every((entry) => entry.date <= yearsLastSunday), 'the child\'s feed runs past the year');
      assert.equal(document.scope, pupil.id);
    });

    await check('(kf-c) a teacher\'s feed is every lesson they are on from last week\'s Monday to a year ahead, and no other', async () => {
      const document = await readFeed(api, tokens.teacher!);
      assert.ok(document);
      const expected = await owner.query<{ id: string }>(
        `SELECT cl.id FROM "CalendarLessonTeachers" t JOIN "CalendarLessons" cl ON cl.id = t."calendarLessonId"
          WHERE t."teacherId" = $1 AND cl.date BETWEEN $2::date AND $3::date + 365 ORDER BY cl."startsAt", cl."endsAt", cl.id`,
        [teacher.id, lastMonday, today],
      );
      assert.deepEqual(document.lessons.map((entry) => entry.id), expected.rows.map((row) => row.id));
      assert.ok(document.lessons.some((entry) => entry.id === pastTheYear), 'the teacher\'s feed stops with the year');
      assert.equal(document.scope, teacher.id);
      assert.ok(document.lessons.some((entry) => entry.teachers.includes('Kurt Kollega') && entry.groups.includes('K7B')), 'the colleague on K7B is not named');
      assert.ok(!JSON.stringify(document).includes('Kim') && !JSON.stringify(document).includes('Kaj'), 'a teacher\'s feed names a pupil');
    });

    await check('(kf-d) the iCalendar is the same bytes asked twice, a VEVENT per lesson and day off, and the guardian\'s asks are one read-log row', async () => {
      const before = Number((await one<{ n: string }>(`SELECT count(*)::text AS n FROM "PersonalDataAccess" WHERE "schoolId" = $1`, [s])).n);
      const first = await readFeed(api, tokens.child!);
      const second = await readFeed(api, tokens.child!);
      const at = new Date();
      const ics = feedIcs(first!, at);
      assert.equal(feedIcs(second!, at), ics, 'two asks of an unchanged week differ');
      assert.deepEqual(icsProblems(ics), [], 'the child\'s feed is no well-formed calendar');
      assert.deepEqual(icsProblems(feedIcs((await readFeed(api, tokens.teacher!))!, at)), [], 'the teacher\'s feed is no well-formed calendar');
      assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, first!.lessons.length + first!.breaks.length);
      const unfolded = ics.replace(/\r\n /g, '');
      for (const entry of first!.lessons) assert.ok(unfolded.includes(`UID:${entry.id}.${pupil.id}@schemapro\r\n`));
      await readFeed(api, tokens.pupil!);
      await readFeed(api, tokens.teacher!);
      const rows = await owner.query<{ actorId: string; channel: string; kind: string; subjectIds: string[] }>(
        `SELECT "actorId", channel::text, kind::text, "subjectIds"::text[] AS "subjectIds" FROM "PersonalDataAccess" WHERE "schoolId" = $1 ORDER BY at`,
        [s],
      );
      const calendar = rows.rows.filter((row) => row.channel === 'CALENDAR');
      // kf-b asked the child's feed once already today: still one row for it, and none for the pupil's or the teacher's.
      assert.deepEqual(
        calendar.map((row) => [row.actorId, row.kind, row.subjectIds]),
        [[guardian.id, 'SCHEDULE', [pupil.id]]],
      );
      // kf-b opened the family's week right after the calendar's ask: written as its own read.
      assert.ok(
        rows.rows.some((row) => row.channel !== 'CALENDAR' && row.actorId === guardian.id && row.kind === 'SCHEDULE' && row.subjectIds.includes(pupil.id)),
        'the calendar\'s row hid the guardian\'s read of the week',
      );
      assert.ok(rows.rows.length >= before);
    });

    // After kf-d, which holds the guardian's read-log rows as they stand,
    // and before kf-e switches the guardians' feeds off.
    await check('(kf-h) a pupil placed in a half of their class has the half\'s lesson in their own feed and the guardian\'s, a pupil in no half the class\'s alone, as the family\'s week has them', async () => {
      // K7B split (Halvklasser): Kim placed in K7B:1, Kaj in no half. Slöjd
      // and NO rotate through one hour next week, beside K7B's own lesson.
      // No teacher on either, so the teacher's feed is as kf-c left it.
      const half = async (name: string) =>
        (
          await one<{ id: string }>(
            `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "halfOfId", "updatedAt")
             VALUES ($1, $2, $3, 'TEACHING_GROUP', 7, $4, now()) RETURNING id`,
            [s, year, name, k7b],
          )
        ).id;
      const h1 = await half('K7B:1');
      const h2 = await half('K7B:2');
      await owner.query(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES ($1, $2, $3)`, [s, h1, pupil.id]);
      const day = plus(thisMonday, 9);
      const slojd = await lesson(h1, await subject('Slöjd'), day, 14, []);
      const no = await lesson(h2, await subject('NO'), day, 14, []);
      const classLessons = (
        await owner.query<{ id: string }>(`SELECT id FROM "CalendarLessons" WHERE "studentGroupId" = $1 AND date = $2::date`, [k7b, day])
      ).rows.map((row) => row.id);
      assert.ok(classLessons.length > 0, 'K7B has no lesson that day to compare with');
      type Feed = NonNullable<Awaited<ReturnType<typeof readFeed>>>;
      const idsOn = (document: Feed) => document.lessons.filter((entry) => entry.date === day).map((entry) => entry.id).sort();

      for (const [label, token] of [
        ['the pupil\'s own', tokens.pupil!],
        ['the guardian\'s', tokens.child!],
      ] as const) {
        const document = await readFeed(api, token);
        assert.ok(document, `${label} feed answered nothing`);
        const ids = idsOn(document);
        assert.ok(ids.includes(slojd), `${label} feed lacks the lesson of the half the pupil is placed in`);
        assert.ok(!ids.includes(no), `${label} feed has the other half's lesson`);
        for (const id of classLessons) assert.ok(ids.includes(id), `${label} feed lost the class's lesson`);
      }
      // In no half: the class's rule alone, so the class's lesson and neither half's.
      const unplaced = await readFeed(api, tokens.sibling!);
      assert.ok(unplaced, 'the guardian\'s feed of the pupil in no half answered nothing');
      const ids = idsOn(unplaced);
      assert.ok(!ids.includes(slojd) && !ids.includes(no), 'a pupil in no half has a half\'s lesson');
      for (const id of classLessons) assert.ok(ids.includes(id), 'a pupil in no half lost the class\'s lesson');

      // And both as the family's week has them that day.
      const family = new FamilyScheduleService(api);
      for (const [child, token] of [
        [pupil.id, tokens.child!],
        [sibling.id, tokens.sibling!],
      ] as const) {
        const week = await family.week({ studentId: child, week: mondayOf(day) }, asGuardian);
        const fromFamily = week.lessons.filter((entry) => entry.date === day).map((entry) => entry.id).sort();
        assert.deepEqual(idsOn((await readFeed(api, token))!), fromFamily, `the feed and the family's week disagree on ${day}`);
      }
    });

    await check('(kf-e) the school switching guardians off revokes their feeds: the list is empty, the address answers nothing', async () => {
      await owner.query(`UPDATE "PublicationSettings" SET "calendarFeedGuardians" = false WHERE "schoolId" = $1`, [s]);
      assert.deepEqual(await feeds.mine(asGuardian), { enabled: false, feeds: [] });
      assert.equal(await readFeed(api, tokens.child!), null);
      assert.ok(await readFeed(api, tokens.pupil!), 'the pupil\'s feed stopped with the guardians\'');
    });

    await check('(kf-f) a feed made while its owner is deactivated is refused, and the door ends a feed it refuses', async () => {
      const liveOf = async (userId: string) =>
        Number((await one<{ n: string }>(`SELECT count(*)::text AS n FROM "CalendarFeeds" WHERE "userId" = $1 AND "revokedAt" IS NULL`, [userId])).n);
      // The deactivation holds the colleague's row; the create waits for it and reads it after.
      await owner.query('BEGIN');
      await owner.query(`UPDATE "Users" SET "isActive" = false WHERE id = $1`, [colleague.id]);
      const made = feeds.create({}, principal(colleague, Role.TEACHER)).then(
        () => 'made',
        (error: unknown) => (error instanceof ForbiddenException ? 'refused' : Promise.reject(error)),
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      await owner.query('COMMIT');
      assert.equal(await made, 'refused', 'a feed was made for an owner deactivated in the same moment');
      assert.equal(await liveOf(colleague.id), 0, 'a deactivated owner has a live feed');

      // The same for a guardian's link to the child, deleted as the feed is made.
      await owner.query(`UPDATE "PublicationSettings" SET "calendarFeedGuardians" = true WHERE "schoolId" = $1`, [s]);
      await owner.query('BEGIN');
      await owner.query(`DELETE FROM "GuardianStudents" WHERE "guardianId" = $1 AND "studentId" = $2`, [guardian.id, sibling.id]);
      const ofSibling = feeds.create({ studentId: sibling.id }, asGuardian).then(
        () => 'made',
        (error: unknown) => (error instanceof NotFoundException ? 'refused' : Promise.reject(error)),
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      await owner.query('COMMIT');
      assert.equal(await ofSibling, 'refused', 'a feed was made of a child whose link went in the same moment');
      const ofTheChild = await one<{ n: string }>(
        `SELECT count(*)::text AS n FROM "CalendarFeeds" WHERE "userId" = $1 AND "studentId" = $2 AND "revokedAt" IS NULL`,
        [guardian.id, sibling.id],
      );
      assert.equal(ofTheChild.n, '0', 'a feed of a child no longer the guardian\'s is live');

      // A change the triggers do not see: the door refuses the feed and ends it.
      await owner.query(`SET session_replication_role = replica`);
      try {
        await owner.query(`UPDATE "Users" SET role = 'GUARDIAN' WHERE id = $1`, [teacher.id]);
      } finally {
        await owner.query(`RESET session_replication_role`);
      }
      assert.equal(await liveOf(teacher.id), 1, 'the triggers ran: the case is not one they miss');
      assert.equal(await readFeed(api, tokens.teacher!), null);
      assert.equal(await liveOf(teacher.id), 0, 'the door left a feed it refused live');
      await owner.query(`UPDATE "Users" SET role = 'TEACHER' WHERE id = $1`, [teacher.id]);
      assert.equal(await readFeed(api, tokens.teacher!), null, 'a feed the door ended came back with the role');
    });

    await check('(kf-g) a guardian\'s feed made during an SS12000 apply waits for it, and the apply\'s scan never waits for the feed', async () => {
      const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const peopleLockHeld = async () =>
        Number(
          (
            await one<{ n: string }>(
              `SELECT count(*)::text AS n FROM pg_locks l, (SELECT hashtextextended($1, 0) AS k) key
                WHERE l.locktype = 'advisory' AND l.mode = 'ExclusiveLock' AND l.granted AND l.objsubid = 1
                  AND l.classid = ((key.k >> 32) & 4294967295)::oid AND l.objid = (key.k & 4294967295)::oid`,
              [`Users:${s}`],
            )
          ).n,
        ) > 0;
      // The real apply's locks, held open: the school's people lock, then every row of the school.
      let holding!: () => void;
      let release!: () => void;
      const held = new Promise<void>((resolve) => (holding = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      // A hand-built administrator says its profile, as the gateway's does (Roller i skolan).
      const apply = api.withRls({ ...principal(admin, Role.SCHOOL_ADMIN), adminProfile: 'FULL' }, async (tx) => {
        await readLocalSlice(tx, s, { lock: true });
        holding();
        await released;
      });
      await held;
      assert.ok(await peopleLockHeld(), 'the apply does not hold the school\'s people lock');
      let settled = false;
      const during = feeds.create({ studentId: pupil.id }, asGuardian).finally(() => (settled = true));
      await pause(400);
      assert.equal(settled, false, 'a feed was made while the apply held the school');
      release();
      await apply;
      assert.ok((await during).token, 'the feed made during the apply was not made after it');

      // The order that deadlocked: the apply's scan has the child's row and
      // not yet the guardian's when the feed is asked for. The feed must wait
      // for the school's people lock without taking the guardian's row, so
      // the scan's next row is free.
      await owner.query('BEGIN');
      await owner.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`Users:${s}`]);
      await owner.query(`SELECT 1 FROM "Users" WHERE id = $1 FOR NO KEY UPDATE`, [pupil.id]);
      const interleaved = feeds.create({ studentId: pupil.id }, asGuardian).then(
        () => 'made',
        (error: unknown) => `failed: ${(error as Error).message}`,
      );
      await pause(400);
      let scanned: string;
      try {
        await owner.query(`SET LOCAL lock_timeout = '3s'`);
        await owner.query(`SELECT 1 FROM "Users" WHERE id = $1 FOR NO KEY UPDATE`, [guardian.id]);
        scanned = 'free';
      } catch (error) {
        // A lock timeout (the feed holds the guardian) or the deadlock itself.
        scanned = `waited: ${(error as { code?: string }).code ?? ''} ${(error as Error).message}`;
      }
      await owner.query(scanned === 'free' ? 'COMMIT' : 'ROLLBACK');
      assert.equal(scanned, 'free', 'the apply\'s scan waited for the feed\'s lock on the guardian');
      assert.equal(await interleaved, 'made', 'the feed asked for mid-scan did not survive the apply');
    });
  } finally {
    await sweepCalendarFeedSchool(owner, marker);
  }
}
