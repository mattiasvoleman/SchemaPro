/**
 * The adapter probe's checks for Skolans dag i ett svep (20270116090000),
 * through the real services on the API's role and real Postgres as CI runs it
 * — the part the unit specs and the e2e cannot see, since both run on the
 * Prisma mock. In a school of its own (slug <marker>-skolans-dag), swept
 * whole before and after.
 *
 * The school lives round the next change of the clocks (found from today, so
 * the dates are always ahead and the probe never ages): a Monday before it and
 * a Monday after it, and the Sunday between, which has 23 or 25 hours.
 *
 *   Monday before   7A Matematik 08:15 (Anna, Sal 1) — the same wall clock as after
 *   Monday after    7A Matematik 08:15 (Anna, Sal 1); 7A Svenska 09:15 (Anna, Sal 1)
 *                   with Anna away from 09:00 to 11:00 and the cover board's
 *                   vikarie Vera in her place; 8B Matematik 10:15 (Bo, Sal 2)
 *                   CANCELLED by hand; 9C Svenska 10:15 (Cia, Sal 3); Eva holds a
 *                   PENDING booking of Sal 4 10:15–11:00; Dan an APPROVED one of
 *                   Sal 1 11:15–12:00; Bo is closed 13:00–14:00 and Sal 3 is closed
 *                   13:00–14:00; Pelle is in the substitute pool with no window.
 *   Cia             away from the Friday before the change at 12:00 until 10:00 on
 *                   the Monday after, over the Sunday that is not 24 hours long.
 *   Tuesday after   8B's day is a temadag (the real ScheduleActivitiesService):
 *                   its two lessons are cancelled (EVENT) and one replacement
 *                   lesson with Bo and Dan carries the class.
 *   Thursday after  a lov for the whole school; Friday after a studiedag for åk 9.
 *   Eva             is marked as having a protected identity.
 *
 *   sd-a  the grid reads the lessons as the day planner does, and tells the same
 *         wall clock as the same minutes on both sides of the change of clocks;
 *   sd-b  the vikarie stands on the lesson, the absent teacher and the lesson that
 *         is cancelled are drawn as such, and the search names the Vikarietavla's
 *         rules for who is not free (and records the absence it names);
 *   sd-c  the cancelled lesson frees its teacher and its room, a booking and a
 *         closure hold a room, and a booking holds its booker;
 *   sd-d  a teacher closure and a room closure, in the interval and outside it;
 *   sd-e  an absence over the Sunday of the change: a block per day, the whole
 *         Sunday whatever its length, and the Monday cut at its wall clock;
 *   sd-f  the temadag: the replacement lesson is a lesson that holds its time,
 *         the cancelled ones free theirs;
 *   sd-g  a lov closes the school's search, a narrowed one only its årskurs;
 *   sd-h  the pool member is left out until a window of theirs holds the interval;
 *   sd-i  what a teacher has: NONE refuses, ROOMS has the rooms and no teacher,
 *         ALL has the grids without absence, uppdrag or free colleagues, and the
 *         marked teacher is in none of it, with no count that says one is missing
 *         (and a teacher cannot read the marks but the gateway can ask for them);
 *         a cancelled lesson is told as cancelled without its cause, and a
 *         vikarie stands on the lesson without the role that says whose it was;
 *   sd-j  the decision: those who decide write it, nobody else;
 *   sd-k  a room lent to another school of the huvudman is not free in the loan's
 *         window (the booking page's own rule), and is drawn as lent.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { CalendarLessonsService } from '../../src/calendar/calendar-lessons.service';
import { CoverService } from '../../src/cover/cover.service';
import type { PrismaService } from '../../src/database/prisma.service';
import { NotificationDeliveryService } from '../../src/notifications/notification-delivery.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { ScheduleActivitiesService } from '../../src/publication/schedule-activities.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import { SchoolDayService } from '../../src/school-day/school-day.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function skolansDagSlug(marker: string): string {
  return `${marker}-skolans-dag`;
}

export async function sweepSkolansDagSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug IN ($1, $2)`, [skolansDagSlug(marker), `${skolansDagSlug(marker)}-2`]);
}

export async function skolansDagChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepSkolansDagSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  // The next change of the clocks at least two weeks ahead, found by the zone's own rules.
  const sunday = (
    await one<{ d: string }>(
      `WITH days AS (SELECT d::date AS d FROM generate_series(current_date + 14, current_date + 400, interval '1 day') g(d)),
            hours AS (SELECT d, extract(hour FROM ((d + time '12:00') AT TIME ZONE 'Europe/Stockholm') AT TIME ZONE 'UTC') AS h FROM days)
       SELECT d::text AS d FROM (SELECT d, h, lag(h) OVER (ORDER BY d) AS p FROM hours) x WHERE p IS NOT NULL AND h <> p ORDER BY d LIMIT 1`,
    )
  ).d;
  const plus = async (date: string, days: number) => (await one<{ d: string }>(`SELECT ($1::date + $2::int)::text AS d`, [date, days])).d;
  const friday = await plus(sunday, -2);
  const mondayBefore = await plus(sunday, -6);
  const mondayAfter = await plus(sunday, 1);
  const tuesdayAfter = await plus(sunday, 2);
  const thursdayAfter = await plus(sunday, 4);
  const fridayAfter = await plus(sunday, 5);
  const saturday = await plus(sunday, -1);

  const s = (
    await one<{ id: string }>(
      `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
      [`${marker} skolans dag`, skolansDagSlug(marker)],
    )
  ).id;
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
       VALUES ($1, 'probe skolans dag', current_date - 30, current_date + 450, true, 'NIOARIG', now()) RETURNING id`,
      [s],
    )
  ).id;
  const subject = async (name: string, code: string, counts: boolean) =>
    (
      await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "countsTowardTimplan", "updatedAt") VALUES ($1, $2, $3, $4, now()) RETURNING id`, [
        s,
        name,
        code,
        counts,
      ])
    ).id;
  const matte = await subject('Matematik', 'SDMA', true);
  const svenska = await subject('Svenska', 'SDSV', true);
  const temadag = await subject('Temadag', 'SDTD', false);
  const groupOf = async (name: string, grade: number) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', $4, now()) RETURNING id`,
        [s, year, name, grade],
      )
    ).id;
  const [g7a, g8b, g9c] = [await groupOf('7A', 7), await groupOf('8B', 8), await groupOf('9C', 9)];
  const roomOf = async (name: string) => (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [s, name])).id;
  const [sal1, sal2, sal3, sal4] = [await roomOf('Sal 1'), await roomOf('Sal 2'), await roomOf('Sal 3'), await roomOf('Sal 4')];

  const person = async (role: string, label: string, adminProfile: string | null = null, post = true, groupId: string | null = null) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4::"UserRole", $5::"AdminProfile", $6, true, $7, now()) RETURNING id`,
      [s, `${marker}-sd-${label}@example.invalid`, label, role, adminProfile, authId, groupId],
    );
    if (role === 'TEACHER' && post) {
      await owner.query(`INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt") VALUES ($1, $2, $3, 100, now())`, [s, row.id, year]);
    }
    const user: AuthenticatedUser = {
      authId,
      role: role as Role,
      userId: row.id,
      schoolId: s,
      channel: 'WEB',
      ...(role === 'SCHOOL_ADMIN' ? { adminProfile: adminProfile as never, hrRead: false } : {}),
    };
    return user;
  };
  const admin = await person('SCHOOL_ADMIN', 'admin', 'FULL');
  const rektor = await person('SCHOOL_ADMIN', 'rektor', 'REKTOR');
  const expedition = await person('SCHOOL_ADMIN', 'expedition', 'EXPEDITION');
  const reader = await person('SCHOOL_ADMIN', 'lasare', 'LASARE');
  const anna = await person('TEACHER', 'anna');
  const bo = await person('TEACHER', 'bo');
  const cia = await person('TEACHER', 'cia');
  const dan = await person('TEACHER', 'dan');
  const eva = await person('TEACHER', 'eva');
  const vera = await person('TEACHER', 'vera');
  const pelle = await person('TEACHER', 'pelle', null, false);
  // A class with no pupils has no roster for a replacement lesson to carry (D3 writes one per class that has).
  await person('STUDENT', 'elev1', null, true, g8b);
  await person('STUDENT', 'elev2', null, true, g8b);
  await owner.query(`INSERT INTO "SubstitutePoolMembers" ("schoolId", "userId") VALUES ($1, $2)`, [s, pelle.userId]);
  await owner.query(`INSERT INTO "PersonProtections" ("userId", "schoolId", source) VALUES ($1, $2, 'MANUAL')`, [eva.userId, s]);

  const lesson = async (
    date: string,
    from: string,
    to: string,
    subjectId: string,
    groupId: string,
    roomId: string | null,
    teachers: AuthenticatedUser[],
    status = 'SCHEDULED',
    cause: string | null = null,
  ): Promise<string> => {
    const id = (
      await one<{ id: string }>(
        `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", "roomId", date, "startsAt", "endsAt", status, "cancelCause", "updatedAt")
         VALUES ($1, $2, $3, $4, $5::date, ($5::date + $6::time) AT TIME ZONE 'Europe/Stockholm', ($5::date + $7::time) AT TIME ZONE 'Europe/Stockholm',
                 $8::"LessonStatus", $9::"LessonCancelCause", now())
         RETURNING id`,
        [s, subjectId, groupId, roomId, date, from, to, status, cause],
      )
    ).id;
    // The grundschema's lesson this one was published from, the slot an activity's reversal checks.
    const master = (
      await one<{ id: string }>(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, extract(isodow FROM $6::date)::int, $7::time, $8::time, now()) RETURNING id`,
        [s, year, subjectId, groupId, teachers[0]?.userId ?? null, date, from, to],
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
  await lesson(mondayBefore, '08:15', '09:00', matte, g7a, sal1, [anna]);
  await lesson(mondayAfter, '08:15', '09:00', matte, g7a, sal1, [anna]);
  const svenska7a = await lesson(mondayAfter, '09:15', '10:00', svenska, g7a, sal1, [anna]);
  const cancelled8b = await lesson(mondayAfter, '10:15', '11:00', matte, g8b, sal2, [bo], 'CANCELLED', 'MANUAL');
  const svenska9c = await lesson(mondayAfter, '10:15', '11:00', svenska, g9c, sal3, [cia]);
  // Tuesday after: 8B's two lessons, which the temadag takes.
  await lesson(tuesdayAfter, '08:00', '08:45', matte, g8b, sal2, [bo]);
  await lesson(tuesdayAfter, '09:00', '09:45', svenska, g8b, sal2, [bo]);

  const atWall = (date: string, time: string) => `(${`'${date} ${time}'`}::timestamp AT TIME ZONE 'Europe/Stockholm')`;
  const absence = async (who: AuthenticatedUser, from: string, to: string): Promise<string> =>
    (
      await one<{ id: string }>(
        `INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt") VALUES ($1, $2, ${from}, ${to}) RETURNING id`,
        [s, who.userId],
      )
    ).id;
  const annaAbsence = await absence(anna, atWall(mondayAfter, '09:00'), atWall(mondayAfter, '11:00'));
  await absence(cia, atWall(friday, '12:00'), atWall(mondayAfter, '10:00'));
  const booking = async (room: string, who: AuthenticatedUser, status: string, from: string, to: string) =>
    owner.query(
      `INSERT INTO "RoomBookings" ("schoolId", "roomId", "bookedById", title, "startsAt", "endsAt", status, "updatedAt")
       VALUES ($1, $2, $3, 'Möte', ${from}, ${to}, $4::"RoomBookingStatus", now())`,
      [s, room, who.userId, status],
    );
  await booking(sal4, eva, 'PENDING', atWall(mondayAfter, '10:15'), atWall(mondayAfter, '11:00'));
  await booking(sal1, dan, 'APPROVED', atWall(mondayAfter, '11:15'), atWall(mondayAfter, '12:00'));
  const constraint = async (resource: 'TEACHER' | 'ROOM', id: string, date: string, from: string, to: string) =>
    owner.query(
      `INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "roomId", date, "startTime", "endTime", type, "updatedAt")
       VALUES ($1, $2::"ConstraintResource", $3, $4, $5::date, $6::time, $7::time, 'UNAVAILABLE', now())`,
      [s, resource, resource === 'TEACHER' ? id : null, resource === 'ROOM' ? id : null, date, from, to],
    );
  await constraint('TEACHER', bo.userId!, mondayAfter, '13:00', '14:00');
  await constraint('ROOM', sal3, mondayAfter, '13:00', '14:00');
  await owner.query(
    `INSERT INTO "SchoolBreaks" ("schoolId", "academicYearId", name, kind, "startDate", "endDate", "minGradeLevel", "maxGradeLevel", "updatedAt")
     VALUES ($1, $2, 'Lov', 'HOLIDAY', $3::date, $3::date, NULL, NULL, now()),
            ($1, $2, 'Studiedag åk 9', 'STAFF_DAY', $4::date, $4::date, 9, 9, now())`,
    [s, year, thursdayAfter, fridayAfter],
  );

  // Sal 2 is lent to another school on Mondays 12:00-14:00 (an approved loan, the borrower's room standing for it there).
  const other = (
    await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [
      `${marker} skolans dag två`,
      `${skolansDagSlug(marker)}-2`,
    ])
  ).id;
  const borrowedRoom = (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, 'Lånad sal', now()) RETURNING id`, [other])).id;
  await owner.query(
    `INSERT INTO "RoomLoans" ("ownerSchoolId", "roomId", "borrowerSchoolId", "localRoomId", "dayOfWeek", "startTime", "endTime", "startDate", "endDate", status, "decidedAt")
     VALUES ($1, $2, $3, $4, 1, '12:00', '14:00', $5::date - 30, $5::date + 60, 'APPROVED', now())`,
    [s, sal2, other, borrowedRoom, mondayAfter],
  );

  const realtime = {
    notifyLessonChanged: async () => undefined,
    notifyLessonsChanged: async () => undefined,
    notifyCoverBoardChanged: () => undefined,
  } as unknown as RealtimeService;
  const notifications = new NotificationsService(api, new NotificationDeliveryService(api));
  const calendar = new CalendarLessonsService(api, realtime, notifications);
  const cover = new CoverService(api, realtime, notifications, calendar);
  const activities = new ScheduleActivitiesService(api, realtime, notifications);
  const day = new SchoolDayService(api);

  // The board puts Vera on Anna's Svenska while Anna is away.
  await cover.decide(svenska7a, { absenceId: annaAbsence, kind: 'SUBSTITUTE', substituteId: vera.userId!, expected: 'OPEN' } as never, admin);

  // The people are named 'anna Probe'; the probe says 'anna'.
  const plain = (name: string) => name.replace(/ Probe$/, '');
  const nameOf = (rows: Array<{ id: string; name: string }> | null) => (rows ?? []).map((row) => plain(row.name)).sort();
  const free = (user: AuthenticatedUser, date: string, from: string, to: string) => day.free({ date, from, to }, user);

  await check('(sd-a) the grid reads the lessons as the day planner does, and the same wall clock is the same minutes on both sides of the change of clocks', async () => {
    const before = await day.grid({ from: mondayBefore }, admin);
    const after = await day.grid({ from: mondayAfter }, admin);
    const matteBefore = before.lessons.find((one) => one.subjectId === matte)!;
    const matteAfter = after.lessons.find((one) => one.subjectId === matte && one.groupId === g7a)!;
    assert.deepEqual([matteBefore.start, matteBefore.end], [495, 540]);
    assert.deepEqual([matteAfter.start, matteAfter.end], [495, 540]);
    // The instants differ by an hour when the offset changed; the minutes do not.
    const instants = await all<{ d: string; h: number }>(
      `SELECT date::text AS d, extract(hour FROM "startsAt" AT TIME ZONE 'UTC')::int AS h FROM "CalendarLessons"
        WHERE "schoolId" = $1 AND "subjectId" = $2 AND date IN ($3::date, $4::date) AND "studentGroupId" = $5 ORDER BY date`,
      [s, matte, mondayBefore, mondayAfter, g7a],
    );
    assert.notEqual(instants[0]!.h, instants[1]!.h, 'the probe needs the offset to differ across the change');
    assert.equal(after.timezone, 'Europe/Stockholm');
    assert.deepEqual(after.groups.map((group) => group.name), ['7A', '8B', '9C']);
    assert.deepEqual(after.rooms.map((room) => room.name), ['Sal 1', 'Sal 2', 'Sal 3', 'Sal 4']);
  });

  await check('(sd-b) the vikarie stands on the lesson, the absent one is drawn away and the cancelled lesson as cancelled; the search names the Vikarietavla’s rules', async () => {
    const view = await day.grid({ from: mondayAfter }, admin);
    const swedish = view.lessons.find((one) => one.id === svenska7a)!;
    assert.deepEqual(swedish.teachers, [{ id: vera.userId, role: 'SUBSTITUTE' }]);
    const cancelled = view.lessons.find((one) => one.id === cancelled8b)!;
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.cancelCause, 'MANUAL');
    const away = view.blocks.find((block) => block.resource === 'TEACHER' && block.resourceId === anna.userId && block.kind === 'ABSENT')!;
    assert.deepEqual([away.date, away.start, away.end], [mondayAfter, 9 * 60, 11 * 60]);

    const view2 = await free(admin, mondayAfter, '10:15', '11:00');
    const busy = new Map(view2.busyTeachers!.map((one) => [plain(one.name), one.reasons]));
    assert.deepEqual(busy.get('anna'), ['ABSENT']);
    assert.deepEqual(busy.get('cia'), ['BUSY_LESSON']);
    assert.deepEqual(busy.get('eva'), ['BOOKED_ROOM']);
    assert.deepEqual(busy.get('pelle'), ['POOL_NOT_DECLARED']);
    assert.deepEqual(view2.rules.teachers, ['ABSENT', 'BUSY_LESSON', 'BUSY_SUPERVISION', 'BUSY_DUTY', 'UNAVAILABLE', 'BOOKED_ROOM', 'POOL_NOT_DECLARED']);
    // Who is away is the read log's.
    const logged = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM "PersonalDataAccess" WHERE "schoolId" = $1 AND "actorId" = $2 AND kind = 'STAFF_ABSENCES' AND $3::uuid = ANY("subjectIds")`,
      [s, admin.userId, anna.userId],
    );
    assert.equal(logged.n, 1);
  });

  await check('(sd-c) a cancelled lesson frees its teacher and its room; a booking and a closure hold a room, and a booking holds its booker', async () => {
    const view = await free(admin, mondayAfter, '10:15', '11:00');
    // Vera’s lesson ended at 10:00, Bo’s was cancelled, Dan has nothing: they are free. Anna is away, Cia teaches, Eva holds a booking.
    assert.deepEqual(nameOf(view.teachers), ['bo', 'dan', 'vera']);
    // Sal 1 stands empty, Sal 2’s lesson is cancelled, Sal 3 is in use, Sal 4 is booked.
    assert.deepEqual(nameOf(view.rooms), ['Sal 1', 'Sal 2']);
    const busy = new Map(view.busyRooms!.map((one) => [one.name, one.reasons]));
    assert.deepEqual(busy.get('Sal 3'), ['ROOM_IN_USE']);
    assert.deepEqual(busy.get('Sal 4'), ['ROOM_BOOKED']);
    // Touching is free: Sal 1’s Svenska ended at 10:00 and its booking begins at 11:15, so it is free between them.
    assert.deepEqual(nameOf((await free(admin, mondayAfter, '10:00', '11:15')).rooms), ['Sal 1', 'Sal 2']);
    assert.deepEqual(nameOf((await free(admin, mondayAfter, '09:45', '10:00')).rooms), ['Sal 2', 'Sal 3', 'Sal 4']);
    assert.deepEqual(nameOf((await free(admin, mondayAfter, '11:00', '11:15')).rooms), ['Sal 1', 'Sal 2', 'Sal 3', 'Sal 4']);
    const bookings = (await day.grid({ from: mondayAfter }, admin)).blocks.filter((block) => block.kind === 'BOOKING');
    assert.deepEqual(
      bookings.map((block) => [block.resource === 'ROOM' ? block.resourceId : 'person', block.start, block.end]).sort(),
      [[sal1, 11 * 60 + 15, 12 * 60], [sal4, 10 * 60 + 15, 11 * 60], ['person', 10 * 60 + 15, 11 * 60], ['person', 11 * 60 + 15, 12 * 60]].sort(),
    );
  });

  await check('(sd-d) a teacher’s closure and a room’s, in the interval and outside it', async () => {
    const inside = await free(admin, mondayAfter, '13:00', '14:00');
    assert.deepEqual(inside.busyTeachers!.find((one) => plain(one.name) === 'bo')!.reasons, ['UNAVAILABLE']);
    assert.deepEqual(inside.busyRooms!.find((one) => one.name === 'Sal 3')!.reasons, ['ROOM_CLOSED']);
    const outside = await free(admin, mondayAfter, '14:00', '15:00');
    assert.ok(outside.teachers!.some((one) => plain(one.name) === 'bo'));
    assert.ok(outside.rooms.some((one) => one.name === 'Sal 3'));
  });

  await check('(sd-e) an absence over the Sunday of the change: a block a day, the whole Sunday whatever its length, the Monday cut at its wall clock', async () => {
    const view = await day.grid({ from: friday, to: mondayAfter }, admin);
    const ciaBlocks = view.blocks.filter((block) => block.resourceId === cia.userId && block.kind === 'ABSENT').map((block) => [block.date, block.start, block.end]);
    assert.deepEqual(ciaBlocks, [
      [friday, 12 * 60, 1440],
      [saturday, 0, 1440],
      [sunday, 0, 1440],
      [mondayAfter, 0, 10 * 60],
    ]);
    // Cia’s absence ended at 10:00; her lesson at 10:15 is hers again.
    assert.deepEqual((await free(admin, mondayAfter, '09:30', '10:00')).busyTeachers!.find((one) => plain(one.name) === 'cia')!.reasons, ['ABSENT']);
  });

  await check('(sd-f) a temadag: the replacement lesson holds its time, the lessons it replaced free theirs', async () => {
    const created = await activities.create(
      {
        academicYearId: year,
        name: 'Temadag 8B',
        fromDate: tuesdayAfter,
        toDate: tuesdayAfter,
        scope: 'GROUPS',
        groupIds: [g8b],
        replacementSubjectId: temadag,
        description: 'Samling vid skolgården',
        teachers: [
          { studentGroupId: g8b, teacherId: bo.userId!, role: 'LEAD' },
          { studentGroupId: g8b, teacherId: dan.userId!, role: 'ASSISTANT' },
        ],
        credits: [{ subjectId: matte, minutes: 60 }],
      } as never,
      admin,
    );
    assert.equal(created.cancelled, 2);
    assert.equal(created.replacementLessons, 1);
    const view = await day.grid({ from: tuesdayAfter }, admin);
    const replacement = view.lessons.filter((one) => one.activity);
    assert.equal(replacement.length, 1);
    assert.deepEqual([replacement[0]!.status, replacement[0]!.start, replacement[0]!.end, replacement[0]!.groupId], ['SCHEDULED', 8 * 60, 9 * 60 + 45, g8b]);
    assert.deepEqual(replacement[0]!.teachers.map((one) => one.role).sort(), ['ASSISTANT', 'LEAD']);
    assert.equal(view.lessons.filter((one) => one.status === 'CANCELLED' && one.cancelCause === 'EVENT').length, 2);
    // Bo and Dan are on the replacement lesson; the classes' two lessons that were cancelled hold nothing.
    const busy = await free(admin, tuesdayAfter, '08:00', '09:00');
    assert.deepEqual(busy.busyTeachers!.filter((one) => one.reasons.includes('BUSY_LESSON')).map((one) => plain(one.name)).sort(), ['bo', 'dan']);
    assert.deepEqual(nameOf(busy.rooms), ['Sal 1', 'Sal 2', 'Sal 3', 'Sal 4']);
  });

  await check('(sd-g) a lov closes the school’s search; a narrowed one names its årskurs and closes nobody', async () => {
    const lov = await free(admin, thursdayAfter, '10:00', '11:00');
    assert.deepEqual([lov.teachers, lov.rooms], [[], []]);
    assert.deepEqual(lov.breaks.map((one) => [one.name, one.kind, one.groupIds]), [['Lov', 'HOLIDAY', null]]);
    const studiedag = await free(admin, fridayAfter, '10:00', '11:00');
    assert.ok(studiedag.rooms.length === 4 && studiedag.teachers!.length > 0);
    assert.deepEqual(studiedag.breaks.map((one) => [one.name, one.kind, one.groupIds, one.minGradeLevel]), [['Studiedag åk 9', 'STAFF_DAY', [g9c], 9]]);
    const week = await day.grid({ from: mondayAfter, to: fridayAfter }, admin);
    assert.deepEqual(week.days.map((one) => one.breaks.length), [0, 0, 0, 1, 1]);
  });

  await check('(sd-h) a pool member is left out until a window of theirs holds the interval', async () => {
    const before = await free(admin, mondayAfter, '10:15', '11:00');
    assert.equal(before.poolLeftOut, 1);
    assert.ok(!(before.teachers ?? []).some((one) => plain(one.name) === 'pelle'));
    await owner.query(
      `INSERT INTO "SubstituteAvailabilities" ("schoolId", "userId", date, "startTime", "endTime") VALUES ($1, $2, $3::date, '10:00', '12:00')`,
      [s, pelle.userId, mondayAfter],
    );
    const after = await free(admin, mondayAfter, '10:15', '11:00');
    assert.equal(after.poolLeftOut, 0);
    assert.ok(after.teachers!.some((one) => plain(one.name) === 'pelle'));
    // The grid has a row for a pool member only when they hold something.
    const view = await day.grid({ from: mondayAfter }, admin);
    assert.ok(!view.teachers.some((one) => plain(one.name) === 'pelle'));
  });

  await check('(sd-i) what a teacher has: nothing until the school decides, the rooms with ROOMS, the grids without absence or colleagues’ freedom with ALL, and the marked teacher in none of it', async () => {
    await assert.rejects(day.grid({ from: mondayAfter }, anna), (error: unknown) => (error as { getResponse?: () => { code?: string } }).getResponse?.().code === 'SCHOOL_DAY_NOT_OPEN');
    await assert.rejects(free(anna, mondayAfter, '10:00', '11:00'), (error: unknown) => (error as { getResponse?: () => { code?: string } }).getResponse?.().code === 'SCHOOL_DAY_NOT_OPEN');

    await day.updateSettings({ teacherView: 'ROOMS' }, rektor);
    const rooms = await day.grid({ from: mondayAfter }, anna);
    assert.deepEqual(rooms.access, { admin: false, grids: false, freeTeachers: false });
    assert.deepEqual(rooms.teachers, []);
    assert.ok(rooms.lessons.length > 0 && rooms.lessons.every((one) => one.roomId !== null && one.teachers.length === 0));
    assert.ok(rooms.blocks.every((block) => block.resource === 'ROOM'));
    const roomsFree = await free(anna, mondayAfter, '10:15', '11:00');
    assert.deepEqual([roomsFree.teachers, roomsFree.busyTeachers, roomsFree.busyRooms], [null, null, null]);
    assert.deepEqual(nameOf(roomsFree.rooms), ['Sal 1', 'Sal 2']);

    await day.updateSettings({ teacherView: 'ALL' }, admin);
    // A teacher cannot read the marks; the gateway can ask which staff carry one.
    const readable = await api.withRls(anna, (tx) => tx.personProtection.count());
    assert.equal(readable, 0);
    const view = await day.grid({ from: mondayAfter, to: tuesdayAfter }, anna);
    assert.deepEqual(view.access, { admin: false, grids: true, freeTeachers: false });
    assert.ok(view.lessons.some((one) => one.teachers.length > 0));
    assert.equal(JSON.stringify(view).includes(eva.userId!), false, 'the marked teacher’s id is in the answer');
    assert.ok(!view.teachers.some((one) => one.name.startsWith('eva')));
    assert.ok(!view.blocks.some((block) => block.kind === 'ABSENT' || block.kind === 'UNAVAILABLE' || block.kind === 'DUTY' || block.kind === 'PASS'));
    // Eva holds a booking, which is a person’s block; the marked person has none on the teachers' side.
    assert.ok(!view.blocks.some((block) => block.resourceId === eva.userId));
    const search = await free(anna, mondayAfter, '10:15', '11:00');
    assert.equal(search.teachers, null);
    // The administrator sees the name.
    assert.ok((await day.grid({ from: mondayAfter }, reader)).teachers.some((one) => one.name.startsWith('eva')));

    // A marked teacher on a lesson is left out of the lesson without a trace: no id, and no count that says someone is missing.
    await owner.query(`INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, 'ASSISTANT')`, [s, svenska9c, eva.userId]);
    const masked = await day.grid({ from: mondayAfter }, anna);
    const lesson9c = masked.lessons.find((one) => one.id === svenska9c)!;
    assert.deepEqual(lesson9c.teachers.map((one) => one.id), [cia.userId]);
    // No field says that a teacher is missing: not on her lesson, not anywhere else.
    assert.deepEqual(masked.lessons.map((one) => one.hiddenTeachers).filter((count) => count !== 0), []);
    assert.deepEqual(masked.heldOut, { teachers: 0 });
    assert.equal(JSON.stringify(masked).includes(eva.userId!), false);
    const named = await day.grid({ from: mondayAfter }, reader);
    assert.deepEqual(named.lessons.find((one) => one.id === svenska9c)!.teachers.map((one) => one.id).sort(), [cia.userId, eva.userId].sort());
    assert.deepEqual(named.heldOut, { teachers: 0 });
    await owner.query(`DELETE FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = $1 AND "teacherId" = $2`, [svenska9c, eva.userId]);

    // Why a lesson is cancelled and in whose place a teacher stands are the administrators': the lesson is cancelled, and who holds it is there.
    await owner.query(`UPDATE "CalendarLessons" SET "cancelCause" = 'TEACHER_UNAVAILABLE' WHERE id = $1`, [cancelled8b]);
    try {
      for (const form of ['ALL', 'ROOMS'] as const) {
        await day.updateSettings({ teacherView: form }, admin);
        const told = await day.grid({ from: mondayAfter, to: tuesdayAfter }, anna);
        assert.equal(told.lessons.find((one) => one.id === cancelled8b)!.status, 'CANCELLED', `${form}: the cancelled lesson is cancelled`);
        assert.ok(told.lessons.every((one) => one.cancelCause === null), `${form}: a cause is told to a teacher`);
        assert.ok(told.lessons.every((one) => one.teachers.every((who) => who.role === null)), `${form}: a role is told to a teacher`);
        const text = JSON.stringify(told);
        for (const word of ['TEACHER_UNAVAILABLE', 'SUBSTITUTE', '"EVENT"']) assert.equal(text.includes(word), false, `${form}: ${word} is in what a teacher reads`);
      }
      await day.updateSettings({ teacherView: 'ALL' }, admin);
      const told = await day.grid({ from: mondayAfter }, anna);
      assert.equal(told.lessons.find((one) => one.id === svenska7a)!.teachers.length, 1, 'the vikarie holds the lesson, and is named');
      const read = await day.grid({ from: mondayAfter }, reader);
      assert.equal(read.lessons.find((one) => one.id === cancelled8b)!.cancelCause, 'TEACHER_UNAVAILABLE');
      assert.deepEqual(read.lessons.find((one) => one.id === svenska7a)!.teachers, [{ id: vera.userId, role: 'SUBSTITUTE' }]);
    } finally {
      await owner.query(`UPDATE "CalendarLessons" SET "cancelCause" = 'MANUAL' WHERE id = $1`, [cancelled8b]);
    }
  });

  await check('(sd-j) those who decide write the teachers’ share; the planner, the expedition, the läsare and a teacher do not', async () => {
    assert.deepEqual(await day.settings(anna), { teacherView: 'ALL' });
    assert.deepEqual(await day.updateSettings({ teacherView: 'NONE' }, admin), { teacherView: 'NONE' });
    for (const who of [expedition, reader, anna]) {
      await assert.rejects(day.updateSettings({ teacherView: 'ALL' }, who), `${who.role} wrote the decision`);
    }
    assert.deepEqual(await day.settings(expedition), { teacherView: 'NONE' });
    assert.equal((await all(`SELECT 1 FROM "SchoolDaySettings" WHERE "schoolId" = $1`, [s])).length, 1);
  });

  await check('(sd-k) a room lent to another school is not free in the loan’s window, and is drawn as lent', async () => {
    const during = await free(admin, mondayAfter, '12:30', '13:00');
    assert.deepEqual(during.busyRooms!.find((one) => one.name === 'Sal 2')!.reasons, ['ROOM_LENT']);
    assert.ok(!during.rooms.some((one) => one.name === 'Sal 2'));
    // Touching is free: it is lent until 14:00.
    assert.ok((await free(admin, mondayAfter, '14:00', '15:00')).rooms.some((one) => one.name === 'Sal 2'));
    assert.ok((await free(admin, mondayAfter, '11:00', '12:00')).rooms.some((one) => one.name === 'Sal 2'));
    // Another Monday outside the loan's dates, and another weekday: the loan holds nothing.
    assert.ok((await free(admin, await plus(mondayAfter, 77), '12:30', '13:00')).rooms.some((one) => one.name === 'Sal 2'));
    assert.ok((await free(admin, tuesdayAfter, '12:30', '13:00')).rooms.some((one) => one.name === 'Sal 2'));
    const lent = (await day.grid({ from: mondayAfter }, admin)).blocks.filter((block) => block.kind === 'LOAN');
    assert.deepEqual(lent.map((block) => [block.resourceId, block.start, block.end]), [[sal2, 12 * 60, 14 * 60]]);
    // A teacher with ROOMS reads the loans between the school and another too, and is told the same.
    await day.updateSettings({ teacherView: 'ROOMS' }, admin);
    assert.ok(!(await free(anna, mondayAfter, '12:30', '13:00')).rooms.some((one) => one.name === 'Sal 2'));
    await day.updateSettings({ teacherView: 'NONE' }, admin);
  });

  await sweepSkolansDagSchool(owner, marker);
}
