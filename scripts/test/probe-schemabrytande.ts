/**
 * The adapter probe's checks for the schemabrytande aktivitet (20270101090000),
 * through the real services on the API's role and real Postgres as CI runs it.
 * In a school of its own (slug <marker>-aktivitet), swept whole before and
 * after:
 *
 *   sa-a  a preview names what the activity takes and what it does not: the
 *         named class, its half and the replacing group that lies wholly in it
 *         are cancelled; a teaching group with pupils of another class goes on
 *         and is named; a class with nobody responsible and a teacher who is
 *         busy with another class at the same time are warned about;
 *   sa-a2 a joint lesson of the named class and another class goes for both,
 *         and the other class's pupils are named as uncovered;
 *   sa-b  creating it cancels those lessons as an avbokning does (note,
 *         cause EVENT), writes ONE replacement lesson per class and day from
 *         the first start to the last end of what it replaces (master-less,
 *         the replacement subject, the responsible teachers), credits the
 *         named subjects on the days ahead, and tells the families, the
 *         teachers and the responsible teacher once;
 *   sa-c  the replacement lesson carries attendance: the responsible teacher
 *         opens its register and sees the class's pupils (not 7B's), reports
 *         them, and the pupil of the class who is in the teaching group that
 *         went on is on both lessons' rosters;
 *   sa-d  delivered time keeps one definition: the replacement lesson (a
 *         subject that does not count) is no pupil's timplan, is the teachers'
 *         held time once it is past, and a cancelled lesson is bortfall;
 *   sa-d2 the teachers' days and the cover board agree: the responsible are
 *         busy on the replacement lesson, the others whose lessons were
 *         cancelled are free, and a cancelled lesson derives as CANCELLED;
 *   sa-j  over a weekend and the change to summer time the replacement
 *         lessons keep the class's clock (07:00Z in winter, 06:00Z in summer
 *         for 08:00), and a day with no lesson gets none;
 *   sa-e  a lesson published into the activity's days later is taken by the
 *         re-application, and the replacement lesson grows to hold it;
 *   sa-f  the avbokning an activity owns cannot be reversed by itself, and is
 *         not listed with the others;
 *   sa-g  changing it: a day dropped puts its lessons back and deletes its
 *         replacement lesson, a day added cancels and replaces, a teacher is
 *         swapped on the lesson, the name follows to the cancelled lessons'
 *         notes, and a lesson of a vikarie stays;
 *   sa-i  the rows are the staff's to read and the administrator's to write:
 *         a teacher reads, a pupil, a guardian and another school read nothing,
 *         a teacher and a läsare write nothing;
 *   sa-h  removing it puts the lessons ahead back, deletes the replacement
 *         lessons ahead, and the credits; one with attendance stays, with the
 *         lessons it replaced; a second removal is 409;
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Client } from 'pg';
import { AttendanceService } from '../../src/attendance/attendance.service';
import { Role } from '../../src/auth/enums/role.enum';
import { deriveStatus } from '../../src/cover/cover-board';
import { readPersonDays } from '../../src/cover/cover-context';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { NotificationDeliveryService } from '../../src/notifications/notification-delivery.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { CancellationBatchesService, reapplyActiveBatches } from '../../src/publication/cancellation-batches.service';
import {
  ACTIVITY_SUBJECT_COUNTS,
  ScheduleActivitiesService,
} from '../../src/publication/schedule-activities.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import { deliveredLessons } from '../../src/timplan/timplan-delivered.sql';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function scheduleActivitySlug(marker: string): string {
  return `${marker}-aktivitet`;
}

export async function sweepScheduleActivitySchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [scheduleActivitySlug(marker)]);
}

export async function scheduleActivityChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepScheduleActivitySchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;

  const s = (
    await one<{ id: string }>(
      `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
      [`${marker} aktivitet`, scheduleActivitySlug(marker)],
    )
  ).id;
  const otherSchool = (
    await one<{ id: string }>(
      `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
      [`${marker} aktivitet två`, `${scheduleActivitySlug(marker)}-2`],
    )
  ).id;
  try {
    const year = await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
       VALUES ($1, 'probe aktivitet', $2::date - 30, $2::date + 300, true, 'NIOARIG', now()) RETURNING id`,
      [s, today],
    );
    const group = async (name: string, kind: 'CLASS' | 'TEACHING_GROUP', grade: number | null, halfOf: string | null = null, replaces: string | null = null) =>
      (
        await one<{ id: string }>(
          `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "halfOfId", "replacesSubjectId", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
          [s, year.id, name, kind, grade, halfOf, replaces],
        )
      ).id;
    const subject = async (name: string, code: string, counts: boolean) =>
      (
        await one<{ id: string }>(
          `INSERT INTO "Subjects" ("schoolId", name, code, "countsTowardTimplan", "updatedAt") VALUES ($1, $2, $3, $4, now()) RETURNING id`,
          [s, name, code, counts],
        )
      ).id;
    const matte = await subject('Matte', 'AKMA', true);
    const svenska = await subject('Svenska', 'AKSV', true);
    const idrott = await subject('Idrott', 'AKID', true);
    const temadag = await subject('Temadag', 'AKTD', false);
    const k7a = await group('AK7A', 'CLASS', 7);
    const k7b = await group('AK7B', 'CLASS', 7);
    const k7c = await group('AK7C', 'CLASS', 7);
    const half = await group('AK7A-1', 'TEACHING_GROUP', 7, k7a);
    const sva = await group('AK SvA7A', 'TEACHING_GROUP', null, null, svenska);
    const spanska = await group('AK Spanska', 'TEACHING_GROUP', null);

    const person = async (role: string, label: string, groupId: string | null = null, adminProfile: string | null = null): Promise<AuthenticatedUser> => {
      const authId = randomUUID();
      const row = await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "adminProfile", "updatedAt")
         VALUES ($1, $2, $3, 'Probe', $4, $5, true, $6, $7::"AdminProfile", now()) RETURNING id`,
        [s, `${marker}-aktivitet-${label}@example.invalid`, label, role, authId, groupId, adminProfile],
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
    const anna = await person('TEACHER', 'Anna');
    const bo = await person('TEACHER', 'Bo');
    const cecilia = await person('TEACHER', 'Cecilia');
    const dag = await person('TEACHER', 'Dag');
    const eva = await person('TEACHER', 'Eva');
    const ella = await person('STUDENT', 'Ella', k7a);
    const emil = await person('STUDENT', 'Emil', k7a);
    const frans = await person('STUDENT', 'Frans', k7b);
    const gunnar = await person('STUDENT', 'Gunnar', k7c);
    const guardian = await person('GUARDIAN', 'Sara');
    await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3)`, [s, guardian.userId, ella.userId]);
    const member = async (groupId: string, who: AuthenticatedUser) =>
      owner.query(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES ($1, $2, $3)`, [s, groupId, who.userId]);
    await member(half, ella);
    await member(sva, emil);
    await member(spanska, ella);
    await member(spanska, frans);

    // Next week's Tuesday and Wednesday (always after today): the activity's days.
    const monday = (await one<{ d: string }>(`SELECT (date_trunc('week', $1::date + 7))::date::text AS d`, [today])).d;
    const tuesday = (await one<{ d: string }>(`SELECT ($1::date + 1)::text AS d`, [monday])).d;
    const wednesday = (await one<{ d: string }>(`SELECT ($1::date + 2)::text AS d`, [monday])).d;
    const thursday = (await one<{ d: string }>(`SELECT ($1::date + 3)::text AS d`, [monday])).d;
    const lesson = async (date: string, from: string, to: string, subjectId: string, groupId: string, teachers: AuthenticatedUser[] = [], extra: string[] = []) => {
      const id = (
        await one<{ id: string }>(
          `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
           VALUES ($1, $2, $3, $4::date, ($4::date + $5::time) AT TIME ZONE 'Europe/Stockholm', ($4::date + $6::time) AT TIME ZONE 'Europe/Stockholm', 'SCHEDULED', now())
           RETURNING id`,
          [s, subjectId, groupId, date, from, to],
        )
      ).id;
      // The grundschema's lesson this one was published from, as a publish leaves it: the slot a reversal checks
      // before it puts the lesson back where it was.
      const master = (
        await one<{ id: string }>(
          `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, extract(isodow FROM $6::date)::int, $7::time, $8::time, now()) RETURNING id`,
          [s, year.id, subjectId, groupId, teachers[0]?.userId ?? null, date, from, to],
        )
      ).id;
      await owner.query(`UPDATE "CalendarLessons" SET "masterLessonId" = $2 WHERE id = $1`, [id, master]);
      for (const [index, teacher] of teachers.entries()) {
        await owner.query(
          `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, $4::"TeacherAssignmentRole")`,
          [s, id, teacher.userId, index === 0 ? 'LEAD' : 'ASSISTANT'],
        );
      }
      for (const groupId of extra) {
        await owner.query(`INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId") VALUES ($1, $2, $3)`, [s, id, groupId]);
      }
      return id;
    };
    // Tuesday: 7A has Matte 08:00–08:45 and Svenska 09:00–09:45; its half has Matte too (08:00);
    // SvA7A (Emil) has Svenska at 09:00 beside it; the Spanish group (Ella of 7A, Frans of 7B) meets at 10:00;
    // 7B has Matte at 08:00 with Bo, who is also asked to lead 7A: a clash.
    const matteA = await lesson(tuesday, '08:00', '08:45', matte, k7a, [anna]);
    const svA = await lesson(tuesday, '09:00', '09:45', svenska, k7a, [bo]);
    const halfL = await lesson(tuesday, '08:00', '08:45', matte, half, [cecilia]);
    const svaL = await lesson(tuesday, '09:00', '09:45', svenska, sva, [dag]);
    const spanskaL = await lesson(tuesday, '10:00', '10:45', svenska, spanska, [eva]);
    const matteB = await lesson(tuesday, '08:00', '08:45', matte, k7b, [bo]);
    const matteC = await lesson(tuesday, '08:00', '08:45', matte, k7c, [eva]);
    // Wednesday: 7A has one lesson.
    const wedA = await lesson(wednesday, '10:00', '10:45', matte, k7a, [anna]);
    // Thursday: 7A has one lesson (outside the activity until it is changed).
    const thuA = await lesson(thursday, '10:00', '10:45', matte, k7a, [anna]);

    const realtime = {
      notifyLessonChanged: async () => undefined,
      notifyLessonsChanged: async () => undefined,
      notifyCoverBoardChanged: () => undefined,
    } as unknown as RealtimeService;
    const notifications = new NotificationsService(api, new NotificationDeliveryService(api));
    const activities = new ScheduleActivitiesService(api, realtime, notifications);
    const batches = new CancellationBatchesService(api, realtime, notifications);
    const attendance = new AttendanceService(api, notifications);

    const body = (extra: Record<string, unknown> = {}) => ({
      academicYearId: year.id,
      name: 'Friluftsdag åk 7A',
      fromDate: tuesday,
      toDate: wednesday,
      scope: 'GROUPS' as const,
      groupIds: [k7a],
      replacementSubjectId: temadag,
      description: 'Samling vid skolgården',
      teachers: [
        { studentGroupId: k7a, teacherId: bo.userId!, role: 'LEAD' as const },
        { studentGroupId: k7a, teacherId: anna.userId!, role: 'ASSISTANT' as const },
      ],
      credits: [
        { subjectId: idrott, minutes: 120 },
        { subjectId: matte, minutes: 60 },
      ],
      ...extra,
    });
    const statusOf = async (id: string) => (await one<{ status: string; note: string | null }>(`SELECT status, note FROM "CalendarLessons" WHERE id = $1`, [id]));
    const replacementsOf = async (activityId: string) =>
      all<{ id: string; date: string; from: string; to: string; subjectId: string; masterLessonId: string | null; note: string | null; studentGroupId: string }>(
        `SELECT cl.id, cl.date::text AS date,
                to_char(cl."startsAt" AT TIME ZONE 'Europe/Stockholm', 'HH24:MI') AS "from",
                to_char(cl."endsAt" AT TIME ZONE 'Europe/Stockholm', 'HH24:MI') AS "to",
                cl."subjectId", cl."masterLessonId", cl.note, cl."studentGroupId"
           FROM "ScheduleActivityLessons" sal JOIN "CalendarLessons" cl ON cl.id = sal."calendarLessonId"
          WHERE sal."activityId" = $1 ORDER BY cl.date, cl."startsAt"`,
        [activityId],
      );
    const digests = async (batchId: string) =>
      all<{ userId: string; reversed: boolean }>(
        `SELECT "userId", (meta->>'reversed')::boolean AS reversed FROM "Notifications" WHERE "schoolId" = $1 AND type = 'CANCELLATION_DIGEST' AND meta->>'batchId' = $2`,
        [s, batchId],
      );

    let activity!: { id: string; batchId: string };

    await check('(sa-a) the preview names what is cancelled and what goes on; warns about a class with nobody responsible and a teacher who is busy', async () => {
      const preview = await activities.preview(body({ teachers: [{ studentGroupId: k7a, teacherId: bo.userId!, role: 'LEAD' }] }), admin);
      // 7A's Matte and Svenska, its half's Matte, SvA7A's Svenska: Tuesday 4, Wednesday 1.
      assert.equal(preview.matched, 5);
      assert.deepEqual(preview.expandedGroups.map((entry) => entry.name), ['AK SvA7A', 'AK7A-1']);
      assert.deepEqual(preview.classes.map((entry) => [entry.name, entry.days]), [['AK7A', 2]]);
      assert.equal(preview.replacementLessons, 2);
      assert.deepEqual(preview.warnings.classesWithoutTeacher, []);
      // The Spanish group has Ella of 7A and Frans of 7B: it is not taken, and it is named.
      assert.deepEqual(preview.warnings.continuing, [{ name: 'AK Spanska', lessons: 1 }]);
      // Bo leads 7A from 08:00 to 09:45 and teaches 7B at 08:00.
      assert.ok(preview.warnings.teacherClashes.some((clash) => clash.date === tuesday && clash.busyWith === 'AK7B'));
      const unled = await activities.preview(body({ teachers: [] }), admin);
      assert.deepEqual(unled.warnings.classesWithoutTeacher, ['AK7A']);
      // A subject that counts toward the timplan would count the day twice.
      await assert.rejects(
        activities.preview(body({ replacementSubjectId: matte }), admin),
        (error: unknown) => error instanceof BadRequestException && JSON.stringify(error.getResponse()).includes(ACTIVITY_SUBJECT_COUNTS),
      );
      // Nothing was written.
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "CancellationBatches" WHERE "schoolId" = $1`, [s])).n, 0);
    });

    await check('(sa-a2) a joint lesson of a named class and another class is cancelled for both, and the pupils of the one the activity is not for are named as uncovered', async () => {
      const friday = (await one<{ d: string }>(`SELECT ($1::date + 4)::text AS d`, [monday])).d;
      const joint = await lesson(friday, '11:00', '11:45', matte, k7a, [eva], [k7b]);
      const preview = await activities.preview(body({ fromDate: friday, toDate: friday }), admin);
      assert.equal(preview.matched, 1);
      // Frans goes in 7B, which the activity does not name: his lesson goes and nothing replaces it.
      assert.equal(preview.warnings.uncoveredPupils, 1);
      assert.deepEqual(preview.classes.map((entry) => [entry.name, entry.days]), [['AK7A', 1]]);
      await owner.query(`DELETE FROM "CalendarLessons" WHERE id = $1`, [joint]);
    });

    await check('(sa-b) creating cancels, replaces once per class and day, credits the named subjects and tells people once', async () => {
      const preview = await activities.preview(body(), admin);
      const created = await activities.create({ ...body(), expectedDigest: preview.digest }, admin);
      activity = { id: created.activity.id, batchId: created.activity.batchId };
      assert.equal(created.cancelled, 5);
      assert.equal(created.replacementLessons, 2);
      // 2 days × 2 subjects × the one named group.
      assert.equal(created.credits, 4);

      for (const id of [matteA, svA, halfL, svaL, wedA]) {
        const row = await statusOf(id);
        assert.equal(row.status, 'CANCELLED');
        assert.equal(row.note, 'Inställd: Friluftsdag åk 7A');
      }
      for (const id of [spanskaL, matteB, matteC, thuA]) assert.equal((await statusOf(id)).status, 'SCHEDULED');
      assert.equal((await one<{ cause: string }>(`SELECT "cancelCause" AS cause FROM "CalendarLessons" WHERE id = $1`, [matteA])).cause, 'EVENT');

      const replacement = await replacementsOf(activity.id);
      // Tuesday from the first start (08:00) to the last end (09:45), Wednesday its one lesson.
      assert.deepEqual(replacement.map((row) => [row.date, row.from, row.to]), [
        [tuesday, '08:00', '09:45'],
        [wednesday, '10:00', '10:45'],
      ]);
      for (const row of replacement) {
        assert.equal(row.masterLessonId, null);
        assert.equal(row.subjectId, temadag);
        assert.equal(row.studentGroupId, k7a);
        assert.equal(row.note, 'Friluftsdag åk 7A: Samling vid skolgården');
      }
      const teachers = await all<{ teacherId: string; role: string }>(
        `SELECT "teacherId", role::text FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = $1 ORDER BY role`,
        [replacement[0].id],
      );
      assert.deepEqual(teachers.map((row) => [row.teacherId, row.role]), [
        [anna.userId, 'ASSISTANT'],
        [bo.userId, 'LEAD'],
      ]);

      const credits = await all<{ date: string; minutes: number; subjectId: string; studentGroupId: string }>(
        `SELECT c.date::text AS date, c.minutes, c."subjectId", c."studentGroupId" FROM "TimplanCredits" c
           JOIN "CancellationBatchCredits" b ON b."creditId" = c.id WHERE b."batchId" = $1 ORDER BY c.date, c.minutes`,
        [activity.batchId],
      );
      assert.equal(credits.length, 4);
      assert.ok(credits.every((credit) => credit.studentGroupId === k7a));

      // Once each: the pupils and the guardian of 7A, the cancelled lessons' teachers, and the responsible teacher.
      const told = await digests(activity.batchId);
      assert.equal(told.length, new Set(told.map((row) => row.userId)).size);
      for (const person of [ella, emil, guardian, anna, bo, cecilia, dag]) assert.ok(told.some((row) => row.userId === person.userId), `${person.userId} was told`);
      for (const person of [frans, gunnar, eva]) assert.ok(!told.some((row) => row.userId === person.userId), `${person.userId} was not told`);
      assert.ok(told.every((row) => row.reversed === false));
    });

    await check('(sa-c) the replacement lesson carries attendance: the responsible teacher opens it, sees the class and no other, and reports it', async () => {
      const replacement = (await replacementsOf(activity.id))[0];
      const roster = await attendance.lessonRoster(replacement.id, bo);
      assert.deepEqual(roster.students.map((pupil) => pupil.id).sort(), [ella.userId, emil.userId].sort());
      // A teacher who is not on it has no register for it.
      await assert.rejects(attendance.lessonRoster(replacement.id, eva));
      // The pupil of 7A who is in the teaching group that goes on is on both rosters.
      const spanishRoster = await attendance.lessonRoster(spanskaL, eva);
      assert.ok(spanishRoster.students.some((pupil) => pupil.id === ella.userId));
      await attendance.reportAttendance(
        { calendarLessonId: replacement.id, records: [{ studentId: ella.userId!, status: 'PRESENT' }, { studentId: emil.userId!, status: 'ABSENT' }] } as never,
        bo,
      );
      const marks = await all<{ studentId: string; status: string }>(`SELECT "studentId", status::text FROM "AttendanceRecords" WHERE "calendarLessonId" = $1`, [replacement.id]);
      assert.equal(marks.length, 2);
      // The class's other pupils cannot be marked on it.
      await assert.rejects(
        attendance.reportAttendance({ calendarLessonId: replacement.id, records: [{ studentId: frans.userId!, status: 'PRESENT' }] } as never, bo),
      );
      // Taken back: the mark made it history.
      await owner.query(`DELETE FROM "AttendanceRecords" WHERE "calendarLessonId" = $1`, [replacement.id]);
    });

    await check('(sa-d) delivered time keeps one definition: the replacement is no pupil’s timplan, the teachers’ held time, and the cancelled lessons are bortfall', async () => {
      const asOf = new Date(Date.now() + 40 * 86_400_000);
      const rows = async (subjects: 'timplan' | 'all') =>
        api.withRls(admin, (tx) =>
          (tx as unknown as PrismaClient).$queryRaw<{ bucket: string; subjectId: string; minutes: number }[]>(
            Prisma.sql`WITH l AS (${deliveredLessons({ academicYearId: year.id, yearStart: today, yearEnd: tuesday.slice(0, 4) + '-12-31', asOf }, { subjects, audience: 'none', range: { from: tuesday, to: wednesday } })})
                       SELECT bucket, "subjectId", SUM(minutes)::int AS minutes FROM l GROUP BY 1, 2`,
          ),
        );
      const pupils = await rows('timplan');
      assert.ok(!pupils.some((row) => row.subjectId === temadag), 'a non-counting subject is no pupil’s timplan');
      // Matte: 7A (45) + half (45) + Wednesday (45), cancelled by an event, plus 7B and 7C which were not.
      assert.equal(pupils.find((row) => row.bucket === 'CANCELLED_EVENT' && row.subjectId === matte)?.minutes, 135);
      const staff = await rows('all');
      // 08:00–09:45 Tuesday and 08:00–08:45 Wednesday, with Bo and Anna: held once, in the one subject.
      assert.equal(staff.find((row) => row.bucket === 'DELIVERED' && row.subjectId === temadag)?.minutes, 105 + 45);
    });

    await check('(sa-d2) the teachers’ days and the cover board agree: the responsible teachers are busy on the replacement lesson, the others whose lessons were cancelled are free, and a cancelled lesson is never open for a vikarie', async () => {
      const days = await api.withRls(admin, (tx) =>
        readPersonDays(tx as unknown as PrismaClient, {
          date: tuesday,
          timezone: 'Europe/Stockholm',
          academicYearId: year.id,
          userIds: [anna.userId!, bo.userId!, cecilia.userId!, dag.userId!, eva.userId!],
        }),
      );
      const holding = (who: AuthenticatedUser) => days.days.get(who.userId!)!.lessons.filter((row) => row.date === tuesday && (row.status === 'SCHEDULED' || row.status === 'COMPLETED'));
      const replacement = (await replacementsOf(activity.id))[0];
      // Anna (assistant) and Bo (lead) are on the replacement lesson, nothing else.
      for (const who of [anna, bo]) assert.deepEqual(holding(who).map((row) => row.id).sort(), [replacement.id].concat(who === bo ? [matteB] : []).sort());
      // Cecilia and Dag taught only what the activity cancelled: free, and their cancelled lessons say why.
      for (const who of [cecilia, dag]) {
        assert.deepEqual(holding(who), []);
        assert.ok(days.days.get(who.userId!)!.lessons.filter((row) => row.date === tuesday).every((row) => row.status === 'CANCELLED' && row.cancelCause === 'EVENT'));
      }
      // Eva’s Spanish group goes on (and so does 7C’s Matte): still busy.
      assert.deepEqual(holding(eva).map((row) => row.id).sort(), [spanskaL, matteC].sort());
      // A cancelled lesson derives as CANCELLED, so the board offers no vikarie for it.
      for (const row of days.days.get(anna.userId!)!.lessons.filter((lesson) => lesson.id === matteA)) {
        assert.equal(deriveStatus({ lessonStatus: row.status, endsAt: new Date(row.end), decision: null, coveringSubstituteIds: [] }, new Date(0)).status, 'CANCELLED');
      }
    });

    await check('(sa-j) over a weekend and the change to summer time the replacement lessons keep the class’s own clock, and a day with no lesson gets none', async () => {
      const friday = '2027-03-26';
      const monday2 = '2027-03-29';
      for (const date of [friday, monday2]) await lesson(date, '08:00', '08:45', matte, k7c, [eva]);
      const dst = await activities.create(
        {
          academicYearId: year.id,
          name: 'Prov åk 7C',
          fromDate: friday,
          toDate: monday2,
          scope: 'GROUPS',
          groupIds: [k7c],
          replacementSubjectId: temadag,
          teachers: [{ studentGroupId: k7c, teacherId: eva.userId!, role: 'LEAD' }],
          notify: false,
        },
        admin,
      );
      assert.equal(dst.cancelled, 2);
      const rows = await replacementsOf(dst.activity.id);
      assert.deepEqual(rows.map((row) => [row.date, row.from, row.to]), [
        [friday, '08:00', '08:45'],
        [monday2, '08:00', '08:45'],
      ]);
      // 08:00 on the Friday is 07:00Z (winter time) and on the Monday 06:00Z (summer time).
      const instants = await all<{ at: string }>(
        `SELECT to_char(cl."startsAt" AT TIME ZONE 'UTC', 'HH24:MI') AS at FROM "ScheduleActivityLessons" sal JOIN "CalendarLessons" cl ON cl.id = sal."calendarLessonId" WHERE sal."activityId" = $1 ORDER BY cl.date`,
        [dst.activity.id],
      );
      assert.deepEqual(instants.map((row) => row.at), ['07:00', '06:00']);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "CalendarLessons" WHERE "schoolId" = $1 AND date = '2027-03-27'`, [s])).n, 0);
      await activities.remove(dst.activity.id, admin);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ScheduleActivityLessons" WHERE "activityId" = $1`, [dst.activity.id])).n, 0);
    });

    await check('(sa-e) a lesson published into the activity’s days later is cancelled with the rest, and the replacement lesson grows to hold it', async () => {
      const late = await lesson(tuesday, '11:00', '11:45', matte, k7a, [anna]);
      await api.withRls(admin, (tx) => reapplyActiveBatches(tx as unknown as PrismaClient, s, year.id, tuesday, wednesday, 'Europe/Stockholm'));
      assert.equal((await statusOf(late)).status, 'CANCELLED');
      const replacement = await replacementsOf(activity.id);
      assert.equal(replacement.length, 2);
      assert.deepEqual([replacement[0].from, replacement[0].to], ['08:00', '11:45']);
      // Idempotent: a second run writes nothing.
      const again = await api.withRls(admin, (tx) => reapplyActiveBatches(tx as unknown as PrismaClient, s, year.id, tuesday, wednesday, 'Europe/Stockholm'));
      assert.deepEqual(again, []);
      await owner.query(`UPDATE "CalendarLessons" SET status = 'SCHEDULED', "cancelCause" = NULL WHERE id = $1`, [late]);
      await owner.query(`DELETE FROM "CancellationBatchLessons" WHERE "calendarLessonId" = $1`, [late]);
      await owner.query(`DELETE FROM "CalendarLessons" WHERE id = $1`, [late]);
      await api.withRls(admin, async (tx) => {
        const { syncReplacementsInTransaction } = await import('../../src/publication/activity-replacements');
        await syncReplacementsInTransaction(tx as unknown as PrismaClient, s, activity.batchId);
      });
      assert.deepEqual([(await replacementsOf(activity.id))[0].from, (await replacementsOf(activity.id))[0].to], ['08:00', '09:45']);
    });

    await check('(sa-f) the avbokning an activity owns is not reversed on its own, and is not listed with the others', async () => {
      await assert.rejects(
        batches.reverse(activity.batchId, admin),
        (error: unknown) => error instanceof ConflictException && JSON.stringify(error.getResponse()).includes('ACTIVITY_OWNS_BATCH'),
      );
      await assert.rejects(batches.reversePreview(activity.batchId, admin), ConflictException);
      assert.deepEqual(await batches.list(year.id, admin), []);
      const listed = await activities.list(year.id, admin);
      // The removed one stays in the list as the record it is, marked.
      assert.deepEqual(listed.filter((entry) => entry.removedAt === null).map((entry) => [entry.id, entry.name, entry.replacementLessons, entry.credits, entry.doubleCounts]), [
        [activity.id, 'Friluftsdag åk 7A', 2, 4, false],
      ]);
      // What a change must send again is in the view: each named subject and its minutes a day.
      const active = listed.find((entry) => entry.id === activity.id)!;
      assert.deepEqual(
        active.creditLines.map((line) => [line.subjectId, line.minutes]).sort(),
        [[idrott, 120], [matte, 60]].sort(),
      );
      assert.equal(active.academicYearId, year.id);
      assert.deepEqual(listed.filter((entry) => entry.removedAt !== null).map((entry) => [entry.name, entry.replacementLessons]), [['Prov åk 7C', 0]]);
    });

    await check('(sa-g) changing it: a day dropped is put back, a day added is cancelled and replaced, the lesson’s teacher is swapped, the name follows', async () => {
      const wednesdayReplacement = (await replacementsOf(activity.id))[1];
      // A vikarie on the lesson stays through the swap.
      await owner.query(`INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, 'SUBSTITUTE')`, [s, wednesdayReplacement.id, dag.userId]);
      const change = body({
        name: 'Friluftsdag åk 7A (ny)',
        fromDate: tuesday,
        toDate: thursday,
        teachers: [{ studentGroupId: k7a, teacherId: cecilia.userId!, role: 'LEAD' }],
        credits: [{ subjectId: idrott, minutes: 90 }],
      });
      const preview = await activities.updatePreview(activity.id, change, admin);
      assert.equal(preview.change?.taken, 1);
      const changed = await activities.update(activity.id, { ...change, expectedDigest: preview.digest }, admin);
      assert.equal(changed.taken, 1);
      assert.equal(changed.released, 0);
      assert.equal((await statusOf(thuA)).status, 'CANCELLED');
      assert.equal((await statusOf(matteA)).note, 'Inställd: Friluftsdag åk 7A (ny)');
      const replacement = await replacementsOf(activity.id);
      assert.deepEqual(replacement.map((row) => row.date), [tuesday, wednesday, thursday]);
      const teachers = await all<{ teacherId: string; role: string }>(
        `SELECT "teacherId", role::text FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = $1 ORDER BY role`,
        [wednesdayReplacement.id],
      );
      assert.deepEqual(teachers.map((row) => [row.teacherId, row.role]), [
        [cecilia.userId, 'LEAD'],
        [dag.userId, 'SUBSTITUTE'],
      ]);
      // Credits: the new line on each of the three days, the old ones gone.
      const credits = await all<{ minutes: number }>(`SELECT c.minutes FROM "TimplanCredits" c JOIN "CancellationBatchCredits" b ON b."creditId" = c.id WHERE b."batchId" = $1`, [activity.batchId]);
      assert.deepEqual(credits.map((credit) => credit.minutes), [90, 90, 90]);

      // Back to two days: Thursday's lesson comes back, its replacement goes, and those it concerns are told.
      const back = await activities.update(activity.id, body({ name: 'Friluftsdag åk 7A (ny)', teachers: [{ studentGroupId: k7a, teacherId: cecilia.userId!, role: 'LEAD' }], credits: [{ subjectId: idrott, minutes: 90 }] }), admin);
      assert.equal(back.released, 1);
      assert.equal((await statusOf(thuA)).status, 'SCHEDULED');
      assert.equal((await statusOf(thuA)).note, null);
      assert.deepEqual((await replacementsOf(activity.id)).map((row) => row.date), [tuesday, wednesday]);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "CancellationBatchLessons" WHERE "batchId" = $1 AND "calendarLessonId" = $2`, [activity.batchId, thuA])).n, 0);
      const reversed = (await digests(activity.batchId)).filter((row) => row.reversed);
      assert.ok(reversed.some((row) => row.userId === anna.userId) && reversed.some((row) => row.userId === ella.userId));
    });

    await check('(sa-i) the rows are the staff’s to read and the administrator’s to write', async () => {
      const count = (caller: AuthenticatedUser, table: 'scheduleActivity' | 'scheduleActivityTeacher' | 'scheduleActivityLesson') =>
        api.withRls(caller, (tx) => {
          const client = tx as unknown as PrismaClient;
          return table === 'scheduleActivity'
            ? client.scheduleActivity.count()
            : table === 'scheduleActivityTeacher'
              ? client.scheduleActivityTeacher.count()
              : client.scheduleActivityLesson.count();
        });
      for (const table of ['scheduleActivity', 'scheduleActivityTeacher', 'scheduleActivityLesson'] as const) {
        assert.ok((await count(anna, table)) > 0, `${table}: a teacher reads`);
        assert.ok((await count(admin, table)) > 0, `${table}: an administrator reads`);
        assert.equal(await count(ella, table), 0, `${table}: a pupil reads nothing`);
        assert.equal(await count(guardian, table), 0, `${table}: a guardian reads nothing`);
      }
      // Another school's administrator reads none of it and cannot write into this school's rows.
      const authId = randomUUID();
      const outsider = (
        await one<{ id: string }>(
          `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "adminProfile", "updatedAt")
           VALUES ($1, $2, 'Ut', 'Probe', 'SCHOOL_ADMIN', $3, true, 'FULL', now()) RETURNING id`,
          [otherSchool, `${marker}-aktivitet-ut@example.invalid`, authId],
        )
      ).id;
      const stranger: AuthenticatedUser = { authId, role: Role.SCHOOL_ADMIN, userId: outsider, schoolId: otherSchool, channel: 'WEB', adminProfile: 'FULL' as never, hrRead: false };
      for (const table of ['scheduleActivity', 'scheduleActivityTeacher', 'scheduleActivityLesson'] as const) {
        assert.equal(await count(stranger, table), 0, `${table}: another school reads nothing`);
      }
      await assert.rejects(
        api.withRls(stranger, (tx) =>
          (tx as unknown as PrismaClient).scheduleActivity.update({ where: { id: activity.id }, data: { description: 'Främmande' } }),
        ),
      );
      for (const caller of [anna, reader]) {
        await assert.rejects(
          api.withRls(caller, (tx) =>
            (tx as unknown as PrismaClient).scheduleActivity.update({ where: { id: activity.id }, data: { description: 'Ändrad' } }),
          ),
          `${caller.role} may not write`,
        );
      }
      await assert.rejects(activities.remove(activity.id, anna));
    });

    await check('(sa-h) removing it puts the lessons ahead back, deletes the replacement lessons ahead and the credits; one with attendance stays with what it replaced; once', async () => {
      const [tue, wed] = await replacementsOf(activity.id);
      await owner.query(`INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "updatedAt") VALUES ($1, $2, $3, 'PRESENT', now())`, [s, tue.id, ella.userId]);
      const preview = await activities.removePreview(activity.id, admin);
      assert.equal(preview.replacementsKept, 1);
      assert.equal(preview.replacementsDeleted, 1);
      const removed = await activities.remove(activity.id, admin);
      assert.equal(removed.replacementsKept, 1);
      assert.equal(removed.replacementsDeleted, 1);
      // Wednesday is back; Tuesday, whose replacement carries a register, stays as it was held.
      assert.equal((await statusOf(wedA)).status, 'SCHEDULED');
      for (const id of [matteA, svA, halfL, svaL]) assert.equal((await statusOf(id)).status, 'CANCELLED');
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "CalendarLessons" WHERE id = $1`, [wed.id])).n, 0);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "CalendarLessons" WHERE id = $1`, [tue.id])).n, 1);
      const removedAt = await one<{ removedAt: Date | null }>(`SELECT "removedAt" FROM "ScheduleActivities" WHERE id = $1`, [activity.id]);
      assert.ok(removedAt.removedAt);
      await assert.rejects(activities.remove(activity.id, admin), ConflictException);
      await assert.rejects(activities.update(activity.id, body(), admin), ConflictException);
    });
  } finally {
    await sweepScheduleActivitySchool(owner, marker);
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [`${scheduleActivitySlug(marker)}-2`]);
  }
}
