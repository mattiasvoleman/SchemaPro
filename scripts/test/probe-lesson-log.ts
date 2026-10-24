/**
 * The adapter probe's checks for the lektionslogg (20261203090000), through
 * the real services on the API's role and real Postgres as CI runs it. In a
 * school of its own (slug <marker>-lektionslogg), swept whole before and
 * after:
 *
 *   ll-a  the lesson's own teacher writes the log and the note through
 *         LessonLogService; the row names the writer whatever the gateway
 *         sent (the database stamps it), and the page reads it back; a save
 *         against a log changed since is 409; the substitute writes the log
 *         and reads the note but may not write it; a co-teacher (ASSISTANT)
 *         is one of the lesson's own teachers and writes the note; a
 *         colleague reads the log and neither writes nor sees the note; no
 *         administrator reads the note or writes one, the läsare no more than
 *         the one who writes drift, and their own read of the table is empty;
 *   ll-b  a pupil's own lessons over a week come by the one roster reader:
 *         their class's lesson and their teaching group's, not another
 *         class's, and never a note; a teacher's come with the notes of the
 *         lessons they are on;
 *   ll-c  the family's week (FamilyScheduleService) as the guardian carries
 *         each lesson's topic and homework and nothing of the note, and the
 *         read is recorded as SCHEDULE, as before;
 *   ll-d  the klassbok holds the class's own lessons and the teaching group's
 *         lesson with the one pupil of the class on it, counted; a teaching
 *         group's holds its own; neither carries the note;
 *   ll-e  the substitute's booking reads that a note exists (cover-notices)
 *         and the cover board names the noted lessons, as the administrator
 *         and as the läsare (app.substitute_noted_lessons); to a teacher the
 *         function says nothing.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { CalendarLessonsService } from '../../src/calendar/calendar-lessons.service';
import { readNoticeLessons } from '../../src/cover/cover-notices';
import { CoverService } from '../../src/cover/cover.service';
import type { PrismaService } from '../../src/database/prisma.service';
import { FamilyScheduleService } from '../../src/family/family-schedule.service';
import { ClassBookService } from '../../src/lesson-log/class-book.service';
import { LessonLogService } from '../../src/lesson-log/lesson-log.service';
import { substituteNotedLessons } from '../../src/lesson-log/substitute-noted';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function lessonLogSlug(marker: string): string {
  return `${marker}-lektionslogg`;
}

export async function sweepLessonLogSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [lessonLogSlug(marker)]);
}

export async function lessonLogChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepLessonLogSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;

  const s = (
    await one<{ id: string }>(
      `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
      [`${marker} lektionslogg`, lessonLogSlug(marker)],
    )
  ).id;
  try {
    const year = await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
       VALUES ($1, 'probe lektionslogg', $2::date - 30, $2::date + 300, true, 'NIOARIG', now()) RETURNING id`,
      [s, today],
    );
    const group = async (name: string, kind = 'CLASS') =>
      (
        await one<{ id: string }>(
          `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "updatedAt") VALUES ($1, $2, $3, $4, now()) RETURNING id`,
          [s, year.id, name, kind],
        )
      ).id;
    const k7a = await group('LL7A');
    const k7b = await group('LL7B');
    const spanish = await group('LL Spanska', 'TEACHING_GROUP');
    const subject = (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'Matte', 'LLMA', now()) RETURNING id`, [s])).id;
    const person = async (role: string, label: string, groupId: string | null = null, adminProfile: string | null = null): Promise<AuthenticatedUser> => {
      const authId = randomUUID();
      const row = await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "adminProfile", "updatedAt")
         VALUES ($1, $2, $3, 'Probe', $4, $5, true, $6, $7::"AdminProfile", now()) RETURNING id`,
        [s, `${marker}-lektionslogg-${label}@example.invalid`, label, role, authId, groupId, adminProfile],
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
    const reader = await person('SCHOOL_ADMIN', 'Läsare', null, 'LASARE');
    const teacher = await person('TEACHER', 'Anna');
    const substitute = await person('TEACHER', 'Bo');
    const colleague = await person('TEACHER', 'Cecilia');
    const coTeacher = await person('TEACHER', 'Dag');
    const pupil = await person('STUDENT', 'Ella', k7a);
    const other = await person('STUDENT', 'Frans', k7b);
    const guardian = await person('GUARDIAN', 'Sara');
    await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3)`, [s, guardian.userId, pupil.userId]);
    await owner.query(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES ($1, $2, $3)`, [s, spanish, pupil.userId]);

    // Next week's Monday to Wednesday, one lesson a day at 08:00 Stockholm:
    // after the pupils' class history begins (today, when they were made), so
    // the family's week holds the class's lessons.
    const monday = (await one<{ d: string }>(`SELECT (date_trunc('week', $1::date + 7))::date::text AS d`, [today])).d;
    const lesson = async (offset: number, groupId: string) =>
      (
        await one<{ id: string }>(
          `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
           VALUES ($1, $2, $3, $4::date + $5::int, (($4::date + $5::int) + time '08:00') AT TIME ZONE 'Europe/Stockholm',
                   (($4::date + $5::int) + time '08:45') AT TIME ZONE 'Europe/Stockholm', 'SCHEDULED', now()) RETURNING id`,
          [s, subject, groupId, monday, offset],
        )
      ).id;
    const own = await lesson(0, k7a);
    const theirs = await lesson(1, k7b);
    const language = await lesson(2, spanish);
    await owner.query(
      `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES
         ($1, $2, $3, 'LEAD'), ($1, $2, $7, 'ASSISTANT'), ($1, $2, $4, 'SUBSTITUTE'), ($1, $5, $3, 'LEAD'), ($1, $6, $3, 'LEAD')`,
      [s, own, teacher.userId, substitute.userId, theirs, language, coTeacher.userId],
    );

    const logs = new LessonLogService(api);

    await check('(ll-a) the lesson’s teacher writes the log and the note, stamped as the writer; a stale save is 409; the substitute, a colleague and the läsare get what is theirs', async () => {
      const first = await logs.putLog(own, { topic: '  Bråk ', homework: 'Uppgift 4.1\n', basis: null }, teacher);
      assert.equal(first.log?.topic, 'Bråk');
      assert.equal(first.log?.homework, 'Uppgift 4.1');
      assert.equal(first.log?.writtenBy, 'Anna Probe');
      const stamped = await one<{ writtenById: string }>(`SELECT "writtenById" FROM "LessonLogs" WHERE "calendarLessonId" = $1`, [own]);
      assert.equal(stamped.writtenById, teacher.userId);
      await assert.rejects(logs.putLog(own, { topic: 'x', basis: null }, teacher), ConflictException);
      const note = await logs.putNote(own, { body: 'Planeringen ligger i lärplattformen.', basis: null }, teacher);
      assert.equal(note.note?.body, 'Planeringen ligger i lärplattformen.');

      const asSubstitute = await logs.lesson(own, substitute);
      assert.deepEqual([asSubstitute.role, asSubstitute.may], ['SUBSTITUTE', { writeLog: true, readNote: true, writeNote: false }]);
      assert.equal(asSubstitute.note?.body, 'Planeringen ligger i lärplattformen.');
      assert.equal(asSubstitute.lesson.start, '08:00');
      const byTheSubstitute = await logs.putLog(own, { topic: 'Bråk', homework: 'Uppgift 4.1–4.3', basis: first.log!.updatedAt }, substitute);
      assert.equal(byTheSubstitute.log?.writtenBy, 'Bo Probe');
      await assert.rejects(logs.putNote(own, { body: 'Tack!' }, substitute), ForbiddenException);

      // A co-teacher (ASSISTANT) is one of the lesson's own teachers: reads and writes the note.
      const asCoTeacher = await logs.lesson(own, coTeacher);
      assert.deepEqual([asCoTeacher.role, asCoTeacher.may], ['REGULAR', { writeLog: true, readNote: true, writeNote: true }]);
      const byTheCoTeacher = await logs.putNote(own, { body: 'Planeringen ligger i lärplattformen.', basis: asCoTeacher.note!.updatedAt }, coTeacher);
      assert.equal(byTheCoTeacher.note?.writtenBy, 'Dag Probe');

      const asColleague = await logs.lesson(own, colleague);
      assert.deepEqual([asColleague.role, asColleague.may, asColleague.note], ['COLLEAGUE', { writeLog: false, readNote: false, writeNote: false }, null]);
      assert.equal(asColleague.log?.homework, 'Uppgift 4.1–4.3');
      await assert.rejects(logs.putLog(own, { topic: 'x' }, colleague), ForbiddenException);

      // No administrator reads the note or writes one: the läsare no more than
      // the one who writes drift, and the table itself is empty to them.
      const asReader = await logs.lesson(own, reader);
      assert.deepEqual([asReader.role, asReader.may, asReader.note], ['ADMIN', { writeLog: false, readNote: false, writeNote: false }, null]);
      const asAdmin = await logs.lesson(own, admin);
      assert.deepEqual([asAdmin.role, asAdmin.may, asAdmin.note], ['ADMIN', { writeLog: true, readNote: false, writeNote: false }, null]);
      for (const caller of [admin, reader]) {
        await assert.rejects(logs.putNote(own, { body: 'Från expeditionen' }, caller), ForbiddenException);
        const seen = await api.withRls(caller, (tx) => (tx as unknown as PrismaClient).lessonSubstituteNote.findMany({ select: { body: true } }));
        assert.deepEqual(seen, []);
      }

      // The administrator who writes drift: their write is theirs, and both empty removes the log.
      const byAdmin = await logs.putLog(theirs, { topic: 'Rektors rad' }, admin);
      assert.equal(byAdmin.log?.writtenBy, 'Admin Probe');
      assert.deepEqual(await logs.putLog(theirs, { topic: '', homework: null }, admin), { log: null });
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "LessonLogs" WHERE "calendarLessonId" = $1`, [theirs])).n, 0);
    });

    await logs.putLog(theirs, { topic: '7B:s rad' }, teacher);
    await logs.putLog(language, { homework: 'Glosor kapitel 3' }, teacher);
    await logs.putNote(language, { body: 'Spanska: läs högt' }, teacher);

    await check('(ll-b) a pupil’s week comes by the roster reader, without a note; a teacher’s with the notes', async () => {
      const week = { from: monday, to: (await one<{ d: string }>(`SELECT ($1::date + 6)::text AS d`, [monday])).d };
      const mine = await logs.listForCaller(week, pupil);
      assert.deepEqual(
        mine.entries.map((entry) => [entry.lessonId, entry.topic, entry.homework]).sort(),
        [
          [own, 'Bråk', 'Uppgift 4.1–4.3'],
          [language, null, 'Glosor kapitel 3'],
        ].sort(),
      );
      assert.ok(mine.entries.every((entry) => !('substituteNote' in entry)), 'a pupil was handed a note');
      const theirsToo = await logs.listForCaller(week, other);
      assert.deepEqual(theirsToo.entries.map((entry) => entry.lessonId), [theirs]);
      const taught = await logs.listForCaller(week, teacher);
      const byId = new Map(taught.entries.map((entry) => [entry.lessonId, entry]));
      assert.equal(byId.get(own)?.substituteNote, 'Planeringen ligger i lärplattformen.');
      assert.equal(byId.get(language)?.substituteNote, 'Spanska: läs högt');
      assert.equal(byId.get(theirs)?.substituteNote, null);
    });

    await check('(ll-c) the family’s week carries topic and homework and no note, and is recorded as SCHEDULE', async () => {
      const family = new FamilyScheduleService(api);
      const week = await family.week({ studentId: pupil.userId!, week: monday }, guardian);
      const byId = new Map(week.lessons.map((entry) => [entry.id, entry]));
      assert.deepEqual([byId.get(own)?.topic, byId.get(own)?.homework], ['Bråk', 'Uppgift 4.1–4.3']);
      assert.deepEqual([byId.get(language)?.topic, byId.get(language)?.homework], [null, 'Glosor kapitel 3']);
      assert.ok(!byId.has(theirs), 'another class’s lesson is in the child’s week');
      assert.ok(!JSON.stringify(week).includes('lärplattformen') && !JSON.stringify(week).includes('läs högt'), 'the family read a note');
      const logged = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM "PersonalDataAccess" WHERE "schoolId" = $1 AND kind = 'SCHEDULE' AND "actorId" = $2 AND $3::uuid = ANY ("subjectIds")`,
        [s, guardian.userId, pupil.userId],
      );
      assert.equal(logged.n, 1);
    });

    await check('(ll-d) the klassbok holds the class’s lessons and the teaching group’s with the class’s pupil counted, never a note', async () => {
      const books = new ClassBookService(api);
      const sunday = (await one<{ d: string }>(`SELECT ($1::date + 6)::text AS d`, [monday])).d;
      const book = await books.classBook({ groupId: k7a, from: monday, to: sunday }, colleague);
      assert.deepEqual(
        book.lessons.map((entry) => [entry.id, entry.attending, entry.topic, entry.homework]),
        [
          [own, null, 'Bråk', 'Uppgift 4.1–4.3'],
          [language, 1, null, 'Glosor kapitel 3'],
        ],
      );
      assert.equal(book.pupils, 1);
      assert.deepEqual(book.lessons[0]!.teachers, [
        { name: 'Anna Probe', substitute: false },
        { name: 'Dag Probe', substitute: false },
        { name: 'Bo Probe', substitute: true },
      ]);
      assert.ok(!JSON.stringify(book).includes('lärplattformen'), 'the klassbok carries a note');
      const groupBook = await books.classBook({ groupId: spanish, from: monday, to: sunday }, reader);
      assert.deepEqual(groupBook.lessons.map((entry) => entry.id), [language]);
    });

    await check('(ll-e) the booking reads that a note exists, and the cover board names the noted lessons', async () => {
      const notices = await api.withRls(admin, (tx) => readNoticeLessons(tx as unknown as PrismaClient, [own, theirs]));
      assert.deepEqual([notices.get(own)?.noted, notices.get(theirs)?.noted], [true, false]);
      const toReader = await api.withRls(reader, (tx) => substituteNotedLessons(tx as unknown as PrismaClient, [own, theirs, language]));
      assert.deepEqual([...toReader].sort(), [own, language].sort());
      // To a teacher, even the lesson's own, the function says nothing: they read the note itself.
      const toTeacher = await api.withRls(teacher, (tx) => substituteNotedLessons(tx as unknown as PrismaClient, [own, theirs, language]));
      assert.equal(toTeacher.size, 0);
      // The teacher is away that Monday, so the board has the Monday lesson.
      await owner.query(
        `INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt")
         VALUES ($1, $2, ($3::date + time '00:00') AT TIME ZONE 'Europe/Stockholm', ($3::date + 1 + time '00:00') AT TIME ZONE 'Europe/Stockholm')`,
        [s, teacher.userId, monday],
      );
      const cover = new CoverService(api, {} as RealtimeService, {} as NotificationsService, {} as CalendarLessonsService);
      const board = await cover.board(monday, monday, admin);
      assert.ok(board.items.some((item) => item.lessonId === own), 'Monday’s lesson is not on the board');
      assert.deepEqual(board.notedLessonIds, [own]);
    });
  } finally {
    await sweepLessonLogSchool(owner, marker);
  }
}
