/**
 * The adapter probe's checks for the tenant keys (20270115090000), through the
 * real services on the API's role and real Postgres as CI runs it. Two schools
 * of their own (slugs <marker>-nyckel-a and <marker>-nyckel-b), swept whole
 * before and after:
 *
 *   tk1  a group filed under another school's year is refused by the service
 *        (the review of #260, M8): a 409 that says what an unknown id says,
 *        nothing written in either school, while the school's own year takes it;
 *   tk2  the rows the services write through a parent (a master lesson's extra
 *        groups and pupils, a published lesson's teachers, groups and pupils, a
 *        room rule's rooms) take their school from the parent: Prisma refuses a
 *        nested row that names its own school (the key is on the pair), and
 *        asks nothing else of them. Which of the services' calls write them is
 *        read off the rows, in the school's own tables;
 *   tk3  a row of one school written with the id of another's is Prisma's P2003
 *        (a foreign key), not a row and not a 500: the model API's own refusal
 *        the services' error mapping already turns into a 409;
 *   tk4  removing a year files the same SS12000 tombstones for its lessons
 *        whichever door removes it and whatever order its cascade runs in (the
 *        review of #272, M1, R1, R2): a CalendarEvent for each lesson of a year
 *        that was sent, and an AdhocActivity only for the one that never had a
 *        master lesson; none at all for a year that was never sent. The keys'
 *        triggers fire in name order (RI_ConstraintTrigger_a_<oid>), so the
 *        order moves with every key that is dropped and added again; the BEFORE
 *        DELETE trigger on AcademicYears (20270120090000) takes the lessons
 *        first and the set no longer depends on it. The doors are the service,
 *        a DELETE of the year on the API's role, and a DELETE as the owner: the
 *        same set from each, or the check names the door.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { CalendarService } from '../../src/calendar/calendar.service';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import type { PrismaService } from '../../src/database/prisma.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import { AcademicYearsService } from '../../src/resources/academic-years.service';
import { RoomPreferencesService } from '../../src/resources/room-preferences.service';
import { StudentGroupsService } from '../../src/resources/student-groups.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function tenantKeySlug(marker: string, which: 'a' | 'b' | 'c'): string {
  return `${marker}-nyckel-${which}`;
}

export async function sweepTenantKeySchools(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = ANY($1::text[])`, [[tenantKeySlug(marker, 'a'), tenantKeySlug(marker, 'b'), tenantKeySlug(marker, 'c')]]);
}

export async function tenantKeyChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepTenantKeySchools(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const many = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  const build = async (which: 'a' | 'b') => {
    const school = (
      await one<{ id: string }>(
        `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
        [`${marker} nyckel ${which}`, tenantKeySlug(marker, which)],
      )
    ).id;
    const year = (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
         VALUES ($1, 'probe nyckel', '2098-08-17', '2099-06-11', true, 'NIOARIG', now()) RETURNING id`,
        [school],
      )
    ).id;
    const group = async (name: string, kind: string) =>
      (
        await one<{ id: string }>(
          `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
           VALUES ($1, $2, $3, $4::"StudentGroupKind", 7, now()) RETURNING id`,
          [school, year, name, kind],
        )
      ).id;
    const person = async (role: string, label: string, groupId: string | null = null) => {
      const authId = randomUUID();
      const row = await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "adminProfile", "updatedAt")
         VALUES ($1, $2, $3, 'Probe', $4, $5, true, $6, $7, now()) RETURNING id`,
        [school, `${marker}-nyckel-${which}-${label}@example.invalid`, label, role, authId, groupId, role === 'SCHOOL_ADMIN' ? 'FULL' : null],
      );
      return { id: row.id, authId };
    };
    const klass = await group(`TK7${which}`, 'CLASS');
    const teaching = await group(`TKG${which}`, 'TEACHING_GROUP');
    const subject = (
      await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [
        school,
        `TK ämne ${which}`,
        `TK${which}`.toUpperCase(),
      ])
    ).id;
    const room = (
      await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [school, `TKR${which}`])
    ).id;
    const admin = await person('SCHOOL_ADMIN', 'admin');
    const teacher = await person('TEACHER', 'teacher');
    const pupil = await person('STUDENT', 'pupil', klass);
    const asAdmin: AuthenticatedUser = {
      authId: admin.authId,
      role: Role.SCHOOL_ADMIN,
      userId: admin.id,
      schoolId: school,
      channel: 'WEB',
      adminProfile: 'FULL',
    };
    return { school, year, klass, teaching, subject, room, teacher: teacher.id, pupil: pupil.id, asAdmin };
  };

  try {
    const a = await build('a');
    const b = await build('b');
    const groups = new StudentGroupsService(api);
    const lessons = new MasterLessonsService(
      api,
      { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService,
      {} as NotificationsService,
    );
    const rules = new RoomPreferencesService(api);
    const calendar = new CalendarService(api);

    await check('(tk1) a group filed under another school’s year is a 409 that says what an unknown year says, writes nothing, and the own year takes it', async () => {
      const refusal = async (academicYearId: string) => {
        try {
          await groups.create({ name: 'TK1 främmande', academicYearId, gradeLevel: 7 } as never, b.asAdmin);
        } catch (error) {
          assert.ok(error instanceof ConflictException, `a ${(error as Error).constructor.name}: ${(error as Error).message}`);
          return error.message;
        }
        assert.fail('the group was written');
      };
      const foreign = await refusal(a.year);
      const nobody = await refusal(randomUUID());
      assert.equal(foreign, nobody, 'the refusal tells another school’s year from none');
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "StudentGroups" WHERE name = 'TK1 främmande'`)).n, 0);
      const own = await groups.create({ name: 'TK1 egen', academicYearId: b.year, gradeLevel: 7 } as never, b.asAdmin);
      const row = await one<{ schoolId: string; academicYearId: string }>(`SELECT "schoolId", "academicYearId" FROM "StudentGroups" WHERE id = $1`, [own.id]);
      assert.deepEqual(row, { schoolId: b.school, academicYearId: b.year });
    });

    await check('(tk2) the rows written through a parent take their school from it: a master lesson’s extra groups and pupils, a published lesson’s teachers, groups and pupils, a room rule’s rooms', async () => {
      const lesson = await lessons.create(
        {
          academicYearId: b.year,
          subjectId: b.subject,
          studentGroupId: b.klass,
          teacherId: b.teacher,
          roomId: b.room,
          dayOfWeek: 1,
          startTime: '08:00',
          endTime: '09:00',
          extraGroupIds: [b.teaching],
          studentIds: [b.pupil],
        } as never,
        b.asAdmin,
      );
      const parts = async (table: 'MasterLessonGroups' | 'MasterLessonStudents', id: string) =>
        many<{ schoolId: string }>(`SELECT "schoolId" FROM "${table}" WHERE "masterLessonId" = $1`, [id]);
      assert.deepEqual(await parts('MasterLessonGroups', lesson.id), [{ schoolId: b.school }]);
      assert.deepEqual(await parts('MasterLessonStudents', lesson.id), [{ schoolId: b.school }]);

      // The edit replaces them, in the same school.
      await lessons.update(lesson.id, { extraGroupIds: [], studentIds: [b.pupil] } as never, b.asAdmin);
      assert.deepEqual(await parts('MasterLessonGroups', lesson.id), []);
      assert.deepEqual(await parts('MasterLessonStudents', lesson.id), [{ schoolId: b.school }]);
      await lessons.update(lesson.id, { extraGroupIds: [b.teaching], studentIds: [b.pupil] } as never, b.asAdmin);
      assert.deepEqual(await parts('MasterLessonGroups', lesson.id), [{ schoolId: b.school }]);

      // The week published from it: a lesson with its teacher, group and pupil.
      await calendar.publish({ academicYearId: b.year, fromDate: '2098-08-17', toDate: '2098-08-23' } as never, b.asAdmin);
      const published = await many<{ id: string }>(`SELECT id FROM "CalendarLessons" WHERE "schoolId" = $1 AND "masterLessonId" = $2`, [b.school, lesson.id]);
      assert.equal(published.length, 1);
      for (const table of ['CalendarLessonTeachers', 'CalendarLessonGroups', 'CalendarLessonStudents']) {
        assert.deepEqual(
          await many<{ schoolId: string }>(`SELECT "schoolId" FROM "${table}" WHERE "calendarLessonId" = $1`, [published[0]!.id]),
          [{ schoolId: b.school }],
          table,
        );
      }

      // A room rule with a room named, made and changed.
      const rule = await rules.create({ subjectId: b.subject, roomIds: [b.room] } as never, b.asAdmin);
      assert.deepEqual(await many<{ schoolId: string }>(`SELECT "schoolId" FROM "RoomPreferenceRooms" WHERE "preferenceId" = $1`, [rule.id]), [
        { schoolId: b.school },
      ]);
      await rules.update(rule.id, { roomIds: [b.room] } as never, b.asAdmin);
      assert.deepEqual(await many<{ schoolId: string }>(`SELECT "schoolId" FROM "RoomPreferenceRooms" WHERE "preferenceId" = $1`, [rule.id]), [
        { schoolId: b.school },
      ]);
    });

    await check('(tk3) a row of one school written with the id of another’s is a foreign key’s refusal (P2003), whichever table and column, and writes nothing', async () => {
      const attempts: Array<[string, (tx: Prisma.TransactionClient) => Promise<unknown>]> = [
        ['a group in another school’s year', (tx) => tx.studentGroup.create({ data: { schoolId: b.school, academicYearId: a.year, name: 'TK3 g', gradeLevel: 7 } })],
        ['a room in another school’s type', async (tx) => {
          const type = await owner.query<{ id: string }>(`INSERT INTO "RoomTypes" ("schoolId", name, "updatedAt") VALUES ($1, 'TK3 typ', now()) RETURNING id`, [a.school]);
          return tx.room.create({ data: { schoolId: b.school, name: 'TK3 sal', roomTypeId: type.rows[0]!.id } });
        }],
        ['a lesson with another school’s subject', (tx) =>
          tx.calendarLesson.create({
            data: {
              schoolId: b.school,
              subjectId: a.subject,
              studentGroupId: b.klass,
              date: new Date('2098-09-01'),
              startsAt: new Date('2098-09-01T07:00:00Z'),
              endsAt: new Date('2098-09-01T07:50:00Z'),
            },
          })],
        ['a lesson in another school’s room', (tx) =>
          tx.calendarLesson.create({
            data: {
              schoolId: b.school,
              subjectId: b.subject,
              studentGroupId: b.klass,
              roomId: a.room,
              date: new Date('2098-09-02'),
              startsAt: new Date('2098-09-02T07:00:00Z'),
              endsAt: new Date('2098-09-02T07:50:00Z'),
            },
          })],
        ['a member of a group of another school', (tx) =>
          tx.studentGroupMember.create({ data: { schoolId: b.school, studentGroupId: a.teaching, studentId: b.pupil } })],
        ['another school’s pupil in a group', (tx) =>
          tx.studentGroupMember.create({ data: { schoolId: b.school, studentGroupId: b.teaching, studentId: a.pupil } })],
      ];
      for (const [what, write] of attempts) {
        let code: string | undefined;
        try {
          await api.withRls(b.asAdmin, async (tx) => write(tx));
        } catch (error) {
          code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : `${(error as Error).constructor.name}: ${(error as Error).message}`;
        }
        assert.equal(code, 'P2003', `${what}: ${code}`);
      }
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "StudentGroups" WHERE name = 'TK3 g'`)).n, 0);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "Rooms" WHERE name = 'TK3 sal'`)).n, 0);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "CalendarLessons" WHERE "schoolId" = $1 AND "subjectId" = $2`, [b.school, a.subject])).n, 0);
    });

    await check('(tk4) removing a year files the same SS12000 tombstones through the service, a DELETE on the API’s role and a DELETE as the owner: a CalendarEvent for each lesson and an AdhocActivity only for the one that had no master lesson, for a year that was sent and for the active one, and none for a year that was never sent', async () => {
      // A school of its own for the active year: a school has one, and a's and b's are the other checks' (a
      // home class with a pupil in it keeps the service from removing it, and the keys of b's years are the ones
      // above). It needs a person to remove the year, a subject, a teacher and a pupil, and nothing else.
      const bare = await (async () => {
        const school = (
          await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [
            `${marker} nyckel c`,
            tenantKeySlug(marker, 'c'),
          ])
        ).id;
        const person = async (role: string, label: string) => {
          const authId = randomUUID();
          const row = await one<{ id: string }>(
            `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "adminProfile", "updatedAt")
             VALUES ($1, $2, $3, 'Probe', $4, $5, true, $6, now()) RETURNING id`,
            [school, `${marker}-nyckel-c-${label}@example.invalid`, label, role, authId, role === 'SCHOOL_ADMIN' ? 'FULL' : null],
          );
          return { id: row.id, authId };
        };
        const subject = (
          await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'TK ämne c', 'TKC', now()) RETURNING id`, [school])
        ).id;
        const admin = await person('SCHOOL_ADMIN', 'admin');
        const teacher = await person('TEACHER', 'teacher');
        const pupil = await person('STUDENT', 'pupil');
        const asAdmin: AuthenticatedUser = {
          authId: admin.authId,
          role: Role.SCHOOL_ADMIN,
          userId: admin.id,
          schoolId: school,
          channel: 'WEB',
          adminProfile: 'FULL',
        };
        return { school, subject, teacher: teacher.id, pupil: pupil.id, asAdmin };
      })();

      // A year with a class, a master lesson and seven lessons, all in the class: two that keep their master
      // lesson and one that never had it, and four that keep it and that a trigger written to choose its lessons
      // would leave to the year's cascade, which files an AdhocActivity for each of those too (the master
      // lessons' key runs first and takes the master lesson away): one that is CANCELLED, one with a teacher, one
      // with an attendance record, and one dated before today and before the year began (the review of #276, M2).
      // `sent` is a year before the active one, `unsent` a year after it, `active` the school's own
      // (app.ss12000_year_is_emitted); the first two are b's, the third is the bare school's.
      const yearWithLessons = async (kind: 'sent' | 'unsent' | 'active', door: string) => {
        const [from, to, days] =
          kind === 'sent'
            ? (['2097-08-18', '2098-06-12', ['2097-08-25', '2097-09-01', '2097-09-02']] as const)
            : kind === 'unsent'
              ? (['2099-08-16', '2100-06-11', ['2099-08-23', '2099-08-30', '2099-09-01']] as const)
              : (['2098-08-17', '2099-06-11', ['2098-08-24', '2098-08-31', '2098-09-01']] as const);
        const at = kind === 'active' ? bare : b;
        const year = (
          await one<{ id: string }>(
            `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
             VALUES ($1, $2, $3::date, $4::date, $5, 'NIOARIG', now()) RETURNING id`,
            [at.school, `probe nyckel ${kind} ${door}`, from, to, kind === 'active'],
          )
        ).id;
        const group = (
          await one<{ id: string }>(
            `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
             VALUES ($1, $2, 'TK4 grupp', 'TEACHING_GROUP'::"StudentGroupKind", 7, now()) RETURNING id`,
            [at.school, year],
          )
        ).id;
        const master = (
          await one<{ id: string }>(
            `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "updatedAt")
             VALUES ($1, $2, $3, $4, 1, '08:00', '08:50', now()) RETURNING id`,
            [at.school, year, at.subject, group],
          )
        ).id;
        const lesson = async (date: string, masterId: string | null, status = 'SCHEDULED') =>
          (
            await one<{ id: string }>(
              `INSERT INTO "CalendarLessons" ("schoolId", "masterLessonId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
               VALUES ($1, $2, $3, $4, $5::date, ($5::date + time '08:00') AT TIME ZONE 'Europe/Stockholm', ($5::date + time '08:50') AT TIME ZONE 'Europe/Stockholm',
                       $6::"LessonStatus", now())
               RETURNING id`,
              [at.school, masterId, at.subject, group, date, status],
            )
          ).id;
        const plain = [await lesson(days[0], master), await lesson(days[1], master)];
        const adhoc = await lesson(days[2], null);
        const cancelled = await lesson(days[0], master, 'CANCELLED');
        const taught = await lesson(days[1], master);
        await owner.query(`INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId") VALUES ($1, $2, $3)`, [at.school, taught, at.teacher]);
        const marked = await lesson(days[2], master);
        await owner.query(`INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", "updatedAt") VALUES ($1, $2, $3, now())`, [at.school, marked, at.pupil]);
        const past = await lesson('2020-02-03', master);
        const keyed = [...plain, cancelled, taught, marked, past];
        // What the section claims of the lessons is what they are, or the check proves less than it says.
        const claimed = await one<{ lessons: number; cancelled: number; teachers: number; marks: number; past: number; keyed: number }>(
          `SELECT count(*)::int AS lessons,
                  (count(*) FILTER (WHERE status = 'CANCELLED'))::int AS cancelled,
                  (SELECT count(*)::int FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = ANY($2::uuid[])) AS teachers,
                  (SELECT count(*)::int FROM "AttendanceRecords" WHERE "calendarLessonId" = ANY($2::uuid[])) AS marks,
                  (count(*) FILTER (WHERE date < current_date))::int AS past,
                  (count(*) FILTER (WHERE "masterLessonId" IS NOT NULL))::int AS keyed
             FROM "CalendarLessons" WHERE "studentGroupId" = $1`,
          [group, [...keyed, adhoc]],
        );
        assert.deepEqual(claimed, { lessons: 7, cancelled: 1, teachers: 1, marks: 1, past: 1, keyed: 6 }, `${kind}, ${door}: the year's lessons are what the check says they are`);
        return { year, group, keyed, adhoc, at };
      };
      const doors: Array<[string, (year: string, asAdmin: AuthenticatedUser) => Promise<void>]> = [
        ['the service', (year, asAdmin) => new AcademicYearsService(api).remove(year, asAdmin)],
        [
          'a DELETE on the API’s role',
          (year, asAdmin) =>
            api.withRls(asAdmin, async (tx) => {
              const removed = await tx.$executeRawUnsafe(`DELETE FROM "AcademicYears" WHERE id = $1::uuid`, year);
              assert.equal(removed, 1, 'the DELETE reached the year');
            }),
        ],
        [
          'a DELETE as the owner',
          async (year) => {
            await owner.query(`DELETE FROM "AcademicYears" WHERE id = $1`, [year]);
          },
        ],
      ];
      const seen: Record<string, string> = {};
      for (const kind of ['sent', 'active', 'unsent'] as const) {
        for (const [door, remove] of doors) {
          const { year, group, keyed, adhoc, at } = await yearWithLessons(kind, door);
          const everyLesson = [...keyed, adhoc];
          await remove(year, at.asAdmin);

          assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "CalendarLessons" WHERE "studentGroupId" = $1`, [group])).n, 0, `${kind}, ${door}: the lessons went with the year`);
          assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "AcademicYears" WHERE id = $1`, [year])).n, 0, `${kind}, ${door}: the year went`);
          // Of the lessons' ids only: nothing else in the school's tombstones is this check's business.
          const buried = async (resource: string) =>
            (
              await many<{ emittedId: string }>(
                `SELECT "emittedId" FROM "Ss12000Tombstones" WHERE "schoolId" = $1 AND resource = $2 AND "emittedId" = ANY($3::uuid[])`,
                [at.school, resource, everyLesson],
              )
            )
              .map((row) => row.emittedId)
              .sort();
          const events = await buried('CalendarEvent');
          const adhocs = await buried('AdhocActivity');
          if (kind === 'unsent') {
            assert.deepEqual(events, [], `${door}: no CalendarEvent tombstone for the lessons of a year that was never sent`);
            assert.deepEqual(adhocs, [], `${door}: no AdhocActivity tombstone for the lessons of a year that was never sent`);
          } else {
            assert.deepEqual(events, [...everyLesson].sort(), `${kind}, ${door}: a CalendarEvent tombstone for each lesson of a year that was sent`);
            assert.deepEqual(
              adhocs,
              [adhoc],
              `${kind}, ${door}: an AdhocActivity tombstone for the lesson that never had a master lesson, and for none that had (a cancelled one, one with a teacher or an attendance record, a past one)`,
            );
          }
          // The same shape from every door (the ids differ, what they were does not).
          const shape = `${events.length} CalendarEvent, ${adhocs.length} AdhocActivity`;
          seen[kind] ??= shape;
          assert.equal(shape, seen[kind], `${kind}, ${door} filed ${shape}, the first door filed ${seen[kind]}`);
        }
      }
    });
  } finally {
    await sweepTenantKeySchools(owner, marker);
  }
}
