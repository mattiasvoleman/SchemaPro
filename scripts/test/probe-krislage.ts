/**
 * The adapter probe's checks for Krisläge (20270113091000), through the real
 * services on the API's role and real Postgres as CI runs it — the part the
 * unit specs and the e2e cannot see, since both run on the Prisma mock. In a
 * school of its own (slug <marker>-krislage), swept whole before and after.
 *
 * One school day around the moment the probe runs, and an alarm in the middle
 * of a break:
 *
 *   7A    Matematik ended five minutes ago, Svenska begins in ten. Anna, who
 *         teaches both, is away and the cover board (the real CoverService)
 *         has put Vera on Svenska. Ella of 7A was marked absent by the
 *         register this morning.
 *   8B    a temadag: the ordinary lessons are cancelled (cancelCause EVENT)
 *         and one replacement lesson without a master lesson carries the
 *         class from before the break to the afternoon, with Bo to lead and
 *         Cia to assist (the shape D3 writes).
 *   9C    Idrott is going on, with Dan. One pupil was absent in the morning's
 *         register, one has an approved leave, one a guardian's report for
 *         the day, one was reported but is marked present by the register
 *         (the register speaks first), and a pupil of 10D is named on the
 *         lesson (a pupil on two lessons is on the one that sorts first).
 *   10D   a lesson is going on, and its teacher Eli is away with nobody put
 *         in their place: the call has nobody to answer for it.
 *
 *   kl-a  the snapshot: who stands before which group right now, with the
 *         vikarie, the replacement lesson and the break, who was absent
 *         before and why, and who is told (staff, and no one else, in words
 *         that name no one);
 *   kl-b  what each teacher reads: their own groups, a colleague's name, and
 *         nothing of a group that is not theirs;
 *   kl-c  the marks: by call and by lesson, once however often they are sent,
 *         a pupil off the list and a group not theirs refused, the time held,
 *         the administration marking for the group nobody answers for, and
 *         the live view's counts;
 *   kl-d  the end: the staff are told, the guardians only after a real alarm
 *         and only when the school chose, a late mark is taken in and says so,
 *         the protocol is the marks in order, and an hour after the end a mark
 *         is refused;
 *   kl-e  one alarm of each mode at a time: a real alarm cuts an exercise
 *         short, two starts at once give one alarm and one 409, and the
 *         lists cannot be added to afterwards;
 *   kl-f  who may start: the school's choice of profiles, the deciders always,
 *         a teacher never;
 *   kl-g  the job ends an alarm left open.
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
import { CrisisService } from '../../src/crisis/crisis.service';
import type { AlarmDetail } from '../../src/crisis/crisis-views';
import { PrismaService } from '../../src/database/prisma.service';
import { NotificationDeliveryService } from '../../src/notifications/notification-delivery.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function krislageSlug(marker: string): string {
  return `${marker}-krislage`;
}

export async function sweepKrislageSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [krislageSlug(marker)]);
}

/** The 4xx's body code, whatever Nest wrapped it in. */
const codeOf = (error: unknown): unknown => (error as { getResponse?: () => { code?: unknown } }).getResponse?.().code;

/** A service of its own with `limit` connections: the race needs calls that really overlap. */
async function serviceWithPool(limit: number): Promise<PrismaService> {
  const url = new URL(process.env['DATABASE_URL']!);
  url.searchParams.set('connection_limit', String(limit));
  const previous = process.env['DATABASE_URL'];
  process.env['DATABASE_URL'] = url.toString();
  try {
    const service = new PrismaService();
    await service.onModuleInit();
    return service;
  } finally {
    process.env['DATABASE_URL'] = previous;
  }
}

export async function krislageChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepKrislageSchool(owner, marker);
  const rows = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await rows<T>(sql, params))[0]!;
  // The probe plants lessons around the moment it runs, and the service judges them by the school's
  // day, so the school lives where it is about noon right now: a fixed-offset zone (Etc/GMT+n is n
  // hours WEST of Greenwich) chosen from the hour, which keeps the lessons on one school day however
  // late CI runs.
  const utcHour = (await one<{ h: number }>(`SELECT extract(hour FROM now() AT TIME ZONE 'UTC')::int AS h`)).h;
  const eastOffset = ((12 - utcHour + 36) % 24) - 12; // -12..+11 hours from Greenwich: local noon
  const zone = eastOffset === 0 ? 'Etc/GMT' : `Etc/GMT${eastOffset > 0 ? '-' : '+'}${Math.abs(eastOffset)}`;
  const racer = await serviceWithPool(6);
  try {
    const s = (
      await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [
        `${marker} krisläge`,
        krislageSlug(marker),
        zone,
      ])
    ).id;
    const year = (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
         VALUES ($1, 'Kl läsår', current_date - 30, current_date + 300, true, now()) RETURNING id`,
        [s],
      )
    ).id;
    const subjectOf = async (name: string, code: string) =>
      (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [s, name, code])).id;
    const matte = await subjectOf('Matematik', 'KLMA');
    const svenska = await subjectOf('Svenska', 'KLSV');
    const idrott = await subjectOf('Idrott', 'KLID');
    const temadag = await subjectOf('Temadag', 'KLTE');
    const groupOf = async (name: string) =>
      (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [s, year, name])).id;
    const [g7a, g8b, g9c, g10d] = [await groupOf('7A'), await groupOf('8B'), await groupOf('9C'), await groupOf('10D')];

    const person = async (role: string, label: string, adminProfile: string | null = null, groupId: string | null = null) => {
      const authId = randomUUID();
      const row = await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "studentGroupId", "updatedAt")
         VALUES ($1, $2, $3, 'Probe', $4::"UserRole", $5::"AdminProfile", $6, true, $7, now()) RETURNING id`,
        [s, `${marker}-krislage-${label}@example.invalid`, label, role, adminProfile, authId, groupId],
      );
      return { id: row.id, authId, label };
    };
    type Person = Awaited<ReturnType<typeof person>>;
    const asAdminOf = (p: Person, adminProfile: 'FULL' | 'SCHEMALAGGARE' | 'EXPEDITION' = 'FULL'): AuthenticatedUser => ({
      authId: p.authId,
      role: Role.SCHOOL_ADMIN,
      userId: p.id,
      schoolId: s,
      channel: 'WEB',
      adminProfile,
    });
    const asTeacher = (p: Person): AuthenticatedUser => ({ authId: p.authId, role: Role.TEACHER, userId: p.id, schoolId: s, channel: 'APP' });

    const admin = await person('SCHOOL_ADMIN', 'admin', 'FULL');
    const admin2 = await person('SCHOOL_ADMIN', 'admin2', 'FULL');
    const planner = await person('SCHOOL_ADMIN', 'planerare', 'SCHEMALAGGARE');
    const anna = await person('TEACHER', 'anna');
    const vera = await person('TEACHER', 'vera');
    const bo = await person('TEACHER', 'bo');
    const cia = await person('TEACHER', 'cia');
    const dan = await person('TEACHER', 'dan');
    const eli = await person('TEACHER', 'eli');
    const freja = await person('TEACHER', 'freja');
    const pupil = async (label: string, groupId: string) => person('STUDENT', label, null, groupId);
    const [p1, p2, ella] = [await pupil('p1', g7a), await pupil('p2', g7a), await pupil('ella', g7a)];
    const [q1, q2] = [await pupil('q1', g8b), await pupil('q2', g8b)];
    const [r1, r2, r3, r4] = [await pupil('r1', g9c), await pupil('r2', g9c), await pupil('r3', g9c), await pupil('r4', g9c)];
    const [s1, s2] = [await pupil('s1', g10d), await pupil('s2', g10d)];
    const guardianOf = async (label: string, child: Person) => {
      const g = await person('GUARDIAN', label);
      await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3)`, [s, g.id, child.id]);
      return g;
    };
    const guardianP1 = await guardianOf('vh-p1', p1);
    const guardianQ1 = await guardianOf('vh-q1', q1);
    const guardianR3 = await guardianOf('vh-r3', r3);

    // The lessons, all relative to the database's clock.
    const lesson = async (
      subject: string,
      group: string,
      from: string,
      to: string,
      teachers: Array<[Person, string]>,
      status = 'SCHEDULED',
      cause: string | null = null,
    ): Promise<string> => {
      const id = (
        await one<{ id: string }>(
          `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "cancelCause", "updatedAt")
           VALUES ($1, $2, $3, (($4::timestamptz) AT TIME ZONE $8)::date, $4::timestamptz, $5::timestamptz, $6::"LessonStatus", $7::"LessonCancelCause", now()) RETURNING id`,
          [s, subject, group, from, to, status, cause, zone],
        )
      ).id;
      for (const [teacher, role] of teachers) {
        await owner.query(`INSERT INTO "CalendarLessonTeachers" ("calendarLessonId", "teacherId", "schoolId", role) VALUES ($1, $2, $3, $4::"TeacherAssignmentRole")`, [id, teacher.id, s, role]);
      }
      return id;
    };
    const at = async (offsetMinutes: number): Promise<string> =>
      (await one<{ t: string }>(`SELECT (now() + make_interval(mins => $1::int))::text AS t`, [offsetMinutes])).t;
    const [m50, m5, p10, p55] = [await at(-50), await at(-5), await at(10), await at(55)];

    const l7aMatte = await lesson(matte, g7a, m50, m5, [[anna, 'LEAD']]);
    const l7aSvenska = await lesson(svenska, g7a, p10, p55, [[anna, 'LEAD']]);
    // The temadag: the ordinary lessons are off, and one lesson per class and day replaces them.
    await lesson(matte, g8b, await at(-60), await at(-15), [[bo, 'LEAD']], 'CANCELLED', 'EVENT');
    await lesson(svenska, g8b, await at(15), await at(60), [[bo, 'LEAD']], 'CANCELLED', 'EVENT');
    const l8bTema = await lesson(temadag, g8b, await at(-90), await at(300), [[bo, 'LEAD'], [cia, 'ASSISTANT']]);
    const l9c = await lesson(idrott, g9c, await at(-20), await at(25), [[dan, 'LEAD']]);
    await owner.query(`INSERT INTO "CalendarLessonStudents" ("schoolId", "calendarLessonId", "studentId") VALUES ($1, $2, $3)`, [s, l9c, s1.id]);
    const l10d = await lesson(svenska, g10d, await at(-10), await at(35), [[eli, 'LEAD']]);
    // This morning's register: Ella absent, r1 absent, r4 present.
    const morning = await lesson(matte, g9c, await at(-200), await at(-155), [[dan, 'LEAD']]);
    const morning7a = await lesson(matte, g7a, await at(-200), await at(-155), [[anna, 'LEAD']]);
    const mark = async (lessonId: string, who: Person, status: string) =>
      owner.query(`INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "recordedAt", "updatedAt") VALUES ($1, $2, $3, $4::"AttendanceStatus", now(), now())`, [s, lessonId, who.id, status]);
    await mark(morning, r1, 'ABSENT');
    await mark(morning, r4, 'PRESENT');
    await mark(morning7a, ella, 'ABSENT');
    await mark(morning7a, p1, 'PRESENT');
    // r2: an approved leave for the day. r3 and r4: a guardian's report for the whole day (r4's is overruled by the register).
    await owner.query(
      `INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason, status, "decidedById", "decidedAt")
       VALUES ($1, $2, $3, current_date - 1, current_date + 1, 'Resa', 'APPROVED', $4, now())`,
      [s, r2.id, guardianR3.id, admin.id],
    );
    for (const who of [r3, r4]) {
      await owner.query(`INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date) VALUES ($1, $2, $3, (now() AT TIME ZONE $4)::date)`, [s, who.id, guardianR3.id, zone]);
    }
    // Anna and Eli are away; the board puts Vera on Anna's Svenska, and nobody on Eli's lesson.
    const absenceOf = async (who: Person) =>
      (
        await one<{ id: string }>(
          `INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt") VALUES ($1, $2, now() - interval '2 hours', now() + interval '8 hours') RETURNING id`,
          [s, who.id],
        )
      ).id;
    const annaAbsence = await absenceOf(anna);
    await absenceOf(eli);

    const realtime = {
      notifyCrisisChanged: () => undefined,
      notifyCoverBoardChanged: () => undefined,
      notifyLessonsChanged: async () => undefined,
      notifyLessonChanged: async () => undefined,
    } as unknown as RealtimeService;
    const notifications = new NotificationsService(api, new NotificationDeliveryService(api));
    const crisis = new CrisisService(api, notifications, realtime);
    const raced = new CrisisService(racer, new NotificationsService(racer, new NotificationDeliveryService(racer)), realtime);
    const calendar = new CalendarLessonsService(api, realtime, notifications);
    const cover = new CoverService(api, realtime, notifications, calendar);
    await cover.decide(l7aSvenska, { absenceId: annaAbsence, kind: 'SUBSTITUTE', substituteId: vera.id, expected: 'OPEN' } as never, asAdminOf(admin));

    const noticesOf = (type: string) =>
      rows<{ userId: string; meta: Record<string, unknown> }>(`SELECT "userId", meta FROM "Notifications" WHERE "schoolId" = $1 AND type = $2::"NotificationType"`, [s, type]);
    const callOf = (detail: AlarmDetail, group: string) => detail.calls.find((call) => call.groupName === group)!;
    /** The owner changes what the trigger forbids (an alarm's start or end), and puts the trigger back whatever happens. */
    const withoutEndsOnce = async (work: () => Promise<unknown>) => {
      await owner.query(`ALTER TABLE "CrisisAlarms" DISABLE TRIGGER "CrisisAlarms_b_ends_once"`);
      try {
        await work();
      } finally {
        await owner.query(`ALTER TABLE "CrisisAlarms" ENABLE TRIGGER "CrisisAlarms_b_ends_once"`);
      }
    };
    const endOpenAlarms = async () => {
      await owner.query(`UPDATE "CrisisAlarms" SET "endedAt" = clock_timestamp() WHERE "schoolId" = $1 AND "endedAt" IS NULL`, [s]);
    };
    const asAdmin = asAdminOf(admin);
    let alarm!: AlarmDetail;

    await check('(kl-a) the snapshot in a break: the vikarie, the replacement lesson, the one who is away and who was absent before; the staff are told, in words that name nobody', async () => {
      alarm = await crisis.start({ kind: 'EVACUATION', mode: 'LIVE' }, asAdmin);
      assert.deepEqual(
        alarm.calls.map((call) => call.groupName).sort(),
        ['10D', '7A', '8B', '9C'],
      );
      assert.equal(alarm.alarm.kind, 'EVACUATION');
      assert.equal(alarm.alarm.mode, 'LIVE');
      assert.equal(alarm.alarm.endedAt, null);
      assert.equal(alarm.alarm.startedBy, 'admin Probe');

      // 7A is between Matematik and Svenska: the group goes with the lesson it is going to, and
      // that lesson's teacher is the vikarie the board put there, not Anna who is away.
      const a7 = callOf(alarm, '7A');
      assert.equal(a7.basis, 'NEXT_LESSON');
      assert.equal(a7.subjectName, 'Svenska');
      assert.equal(a7.lessonId, l7aSvenska);
      assert.deepEqual(a7.teachers.map((t) => [t.name, t.role]), [['vera Probe', 'SUBSTITUTE']]);
      assert.deepEqual(a7.pupils.map((p) => [p.firstName, p.status, p.priorAbsentSource]), [
        ['ella', 'ABSENT_BEFORE', 'ATTENDANCE'],
        ['p1', 'UNREPORTED', null],
        ['p2', 'UNREPORTED', null],
      ]);
      assert.equal(a7.uncovered, false);

      // 8B: the replacement lesson is going on; the two cancelled ones are not on any list.
      const a8 = callOf(alarm, '8B');
      assert.equal(a8.basis, 'LESSON');
      assert.equal(a8.subjectName, 'Temadag');
      assert.equal(a8.lessonId, l8bTema);
      assert.deepEqual(a8.teachers.map((t) => [t.name, t.role]).sort(), [['bo Probe', 'LEAD'], ['cia Probe', 'ASSISTANT']]);
      assert.deepEqual(a8.pupils.map((p) => p.firstName), ['q1', 'q2']);
      assert.ok(alarm.calls.every((call) => call.groupName !== '8B' || call.lessonId === l8bTema));

      // 9C: the register of the morning speaks first, then a leave, then a guardian's report; the
      // pupil named on the lesson from 10D is on this call and not on his own class's.
      const a9 = callOf(alarm, '9C');
      assert.equal(a9.basis, 'LESSON');
      assert.deepEqual(a9.teachers.map((t) => t.name), ['dan Probe']);
      assert.deepEqual(a9.pupils.map((p) => [p.firstName, p.status, p.priorAbsentSource]), [
        ['r1', 'ABSENT_BEFORE', 'ATTENDANCE'],
        ['r2', 'ABSENT_BEFORE', 'REPORTED'],
        ['r3', 'ABSENT_BEFORE', 'REPORTED'],
        ['r4', 'UNREPORTED', null],
        ['s1', 'UNREPORTED', null],
      ]);

      // 10D: the teacher is away and nobody covers: the call has nobody to answer for it.
      const a10 = callOf(alarm, '10D');
      assert.equal(a10.lessonId, l10d);
      assert.deepEqual(a10.teachers, []);
      assert.equal(a10.uncovered, true);
      assert.deepEqual(a10.pupils.map((p) => p.firstName), ['s2']);

      assert.deepEqual(alarm.alarm.counts, { pupils: 11, found: 0, missing: 0, absentBefore: 4, unreported: 7 });
      assert.equal(alarm.alarm.callsComplete, 0);
      assert.equal(alarm.alarm.teachers, 4);
      assert.equal(alarm.alarm.teachersAnswered, 0);

      // The lists are sealed in the transaction that wrote them.
      const sealed = await one<{ sealed: boolean }>(`SELECT "listsSealedAt" IS NOT NULL AS sealed FROM "CrisisAlarms" WHERE id = $1`, [alarm.alarm.id]);
      assert.equal(sealed.sealed, true);

      // The staff, but not the one who started it, and nobody else; and nothing in the notice names anyone.
      const told = await noticesOf('CRISIS_ALARM');
      assert.deepEqual(
        told.map((n) => n.userId).sort(),
        [admin2, planner, anna, vera, bo, cia, dan, eli, freja].map((p) => p.id).sort(),
      );
      for (const n of told) {
        assert.deepEqual(Object.keys(n.meta).sort(), ['alarmId', 'kind', 'mode', 'startedAt']);
        assert.equal(n.meta['kind'], 'EVACUATION');
        assert.equal(n.meta['mode'], 'LIVE');
      }
      assert.equal((await noticesOf('CRISIS_GUARDIAN_AFTER')).length, 0);
    });

    await check('(kl-b) a teacher reads their own groups and a colleague\'s name, and nothing of a group that is not theirs', async () => {
      const groupsOf = async (who: Person) => {
        const mine = await crisis.mine(asTeacher(who));
        assert.equal(mine.alarms.length, 1);
        assert.equal(mine.alarms[0]!.id, alarm.alarm.id);
        return mine.alarms[0]!.calls;
      };
      const vCalls = await groupsOf(vera);
      assert.deepEqual(vCalls.map((c) => [c.groupName, c.basis, c.colleagues]), [['7A', 'NEXT_LESSON', []]]);
      assert.deepEqual(vCalls[0]!.pupils.map((p) => p.status), ['ABSENT_BEFORE', 'UNREPORTED', 'UNREPORTED']);
      assert.deepEqual((await groupsOf(bo)).map((c) => [c.groupName, c.colleagues]), [['8B', ['cia Probe']]]);
      assert.deepEqual((await groupsOf(cia)).map((c) => [c.groupName, c.colleagues]), [['8B', ['bo Probe']]]);
      assert.deepEqual((await groupsOf(dan)).map((c) => c.groupName), ['9C']);
      // Anna was replaced; Eli is away; Freja has no group right now: the alarm, and no group.
      for (const who of [anna, eli, freja]) assert.deepEqual(await groupsOf(who), []);
      // A group's pupils carry no name of the marker's: the phone has only what the list shows.
      assert.ok(vCalls[0]!.pupils.every((p) => p.markedBy === null));
    });

    await check('(kl-c) the marks: by call and by lesson, once however often sent, off the list and not theirs refused, the time held; the administration marks for the group nobody answers for; the counts follow', async () => {
      const c7 = callOf(alarm, '7A');
      const c8 = callOf(alarm, '8B');
      const c9 = callOf(alarm, '9C');
      const c10 = callOf(alarm, '10D');
      const id1 = randomUUID();
      const id2 = randomUUID();
      const early = new Date(Date.now() - 3 * 3600_000).toISOString();
      const future = new Date(Date.now() + 3 * 3600_000).toISOString();
      const first = await crisis.markMine(
        [
          { id: id1, callId: c7.id, studentId: p1.id, state: 'FOUND', at: early },
          { id: id2, lessonId: l7aSvenska, studentId: p2.id, state: 'MISSING', at: future },
        ],
        asTeacher(vera),
      );
      assert.deepEqual(first, { stored: 2, duplicates: 0, unresolved: [] });
      // Sent again (a lost answer, a phone that retried): stored once.
      const again = await crisis.markMine(
        [
          { id: id1, callId: c7.id, studentId: p1.id, state: 'FOUND', at: early },
          { id: id2, lessonId: l7aSvenska, studentId: p2.id, state: 'MISSING', at: future },
        ],
        asTeacher(vera),
      );
      assert.deepEqual(again, { stored: 0, duplicates: 2, unresolved: [] });
      const stored = await rows<{ id: string; at: Date; receivedAt: Date; byUserId: string; onBehalf: boolean; late: boolean }>(
        `SELECT id, at, "receivedAt", "byUserId", "onBehalf", late FROM "CrisisReports" WHERE "alarmId" = $1 ORDER BY at`,
        [alarm.alarm.id],
      );
      assert.equal(stored.length, 2);
      const startedAt = (await one<{ t: Date }>(`SELECT "startedAt" AS t FROM "CrisisAlarms" WHERE id = $1`, [alarm.alarm.id])).t;
      // A mark made before the alarm is held at its start, one made after "now" at the receipt.
      assert.equal(stored[0]!.at.getTime(), startedAt.getTime());
      assert.ok(stored[1]!.at.getTime() <= stored[1]!.receivedAt.getTime() && stored[1]!.at.getTime() > startedAt.getTime());
      assert.ok(stored.every((r) => r.byUserId === vera.id && !r.onBehalf && !r.late));

      // Refused: a pupil who is not on the group's list; a group that is not theirs is not found (the
      // phone is told it belongs to no alarm of theirs, and drops the mark).
      await assert.rejects(
        crisis.markMine([{ id: randomUUID(), callId: c7.id, studentId: q1.id, state: 'FOUND', at: early }], asTeacher(vera)),
        (e: unknown) => codeOf(e) === 'CRISIS_MARK_INVALID',
      );
      const foreign = randomUUID();
      assert.deepEqual(await crisis.markMine([{ id: foreign, callId: c8.id, studentId: q1.id, state: 'FOUND', at: early }], asTeacher(vera)), {
        stored: 0,
        duplicates: 0,
        unresolved: [foreign],
      });
      await assert.rejects(crisis.markMine([{ id: randomUUID(), studentId: p1.id, state: 'FOUND', at: early } as never], asTeacher(vera)), (e: unknown) => codeOf(e) === 'CRISIS_MARK_INVALID');
      // A mark made by lesson before the alarm began belongs to no alarm; the phone is told, and drops it.
      const before = randomUUID();
      assert.deepEqual(await crisis.markMine([{ id: before, lessonId: l7aSvenska, studentId: p1.id, state: 'FOUND', at: early }], asTeacher(vera)), {
        stored: 0,
        duplicates: 0,
        unresolved: [before],
      });

      // The rest of the school marks: Bo 8B, Dan 9C (r1 turned up: a mark overrules "absent before"),
      // the administration 10D, which nobody answers for.
      await crisis.markMine(
        [q1, q2].map((who) => ({ id: randomUUID(), callId: c8.id, studentId: who.id, state: 'FOUND' as const, at: early })),
        asTeacher(bo),
      );
      await crisis.markMine(
        [r1, r4, s1].map((who) => ({ id: randomUUID(), lessonId: l9c, studentId: who.id, state: 'FOUND' as const, at: new Date().toISOString() })),
        asTeacher(dan),
      );
      await crisis.markAsAdministration(alarm.alarm.id, [{ id: randomUUID(), callId: c10.id, studentId: s2.id, state: 'FOUND', at: early }], asAdmin);
      const onBehalf = await one<{ onBehalf: boolean; byUserId: string }>(`SELECT "onBehalf", "byUserId" FROM "CrisisReports" WHERE "callId" = $1`, [c10.id]);
      assert.deepEqual(onBehalf, { onBehalf: true, byUserId: admin.id });

      // The live view.
      const detail = await crisis.detail(alarm.alarm.id, asAdmin);
      assert.deepEqual(detail.alarm.counts, { pupils: 11, found: 7, missing: 1, absentBefore: 3, unreported: 0 });
      assert.equal(detail.alarm.callsComplete, 4);
      assert.equal(detail.alarm.teachers, 4);
      // Vera, Bo and Dan have answered; Cia assists and has not marked.
      assert.equal(detail.alarm.teachersAnswered, 3);
      const d7 = callOf(detail, '7A');
      assert.deepEqual(d7.pupils.map((p) => [p.firstName, p.status]), [['ella', 'ABSENT_BEFORE'], ['p1', 'FOUND'], ['p2', 'MISSING']]);
      assert.ok(d7.completedAt !== null && d7.teachers[0]!.answeredAt !== null);
      assert.equal(d7.pupils.find((p) => p.firstName === 'p2')!.markedBy, 'vera Probe');
      assert.deepEqual(callOf(detail, '9C').pupils.map((p) => [p.firstName, p.status]), [
        ['r1', 'FOUND'],
        ['r2', 'ABSENT_BEFORE'],
        ['r3', 'ABSENT_BEFORE'],
        ['r4', 'FOUND'],
        ['s1', 'FOUND'],
      ]);
      assert.deepEqual(callOf(detail, '8B').teachers.map((t) => [t.name, t.answeredAt !== null]).sort(), [['bo Probe', true], ['cia Probe', false]]);
      // The list a teacher keeps offline says the same.
      const mine = (await crisis.mine(asTeacher(vera))).alarms[0]!.calls[0]!;
      assert.deepEqual(mine.counts, { pupils: 3, found: 1, missing: 1, absentBefore: 1, unreported: 0 });
      assert.ok(mine.completedAt !== null);
    });

    await check('(kl-d) the end: the staff are told, the guardians only after a real alarm and only when the school chose; a late mark says so; the protocol is the marks in order; an hour on a mark is refused', async () => {
      await crisis.updateSettings({ startProfiles: ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION'], notifyGuardiansAfter: true }, asAdmin);
      const ended = await crisis.end(alarm.alarm.id, { note: 'Falsklarm i hus B' }, asAdmin);
      assert.equal(ended.alarm.endNote, 'Falsklarm i hus B');
      assert.ok(ended.alarm.endedAt !== null && ended.alarm.endedBy === 'admin Probe' && !ended.alarm.autoEnded);
      assert.ok(ended.alarm.guardiansNotifiedAt !== null);
      await assert.rejects(crisis.end(alarm.alarm.id, {}, asAdmin), (e: unknown) => codeOf(e) === 'CRISIS_ALARM_ENDED');

      const staff = await noticesOf('CRISIS_ENDED');
      assert.deepEqual(staff.map((n) => n.userId).sort(), [admin, admin2, planner, anna, vera, bo, cia, dan, eli, freja].map((p) => p.id).sort());
      // The guardians of the pupils on the lists, once each (r3's guardian has the one child on a list), no name in it.
      const guardians = await noticesOf('CRISIS_GUARDIAN_AFTER');
      assert.deepEqual(guardians.map((n) => n.userId).sort(), [guardianP1, guardianQ1, guardianR3].map((p) => p.id).sort());
      for (const n of guardians) assert.deepEqual(Object.keys(n.meta).sort(), ['endedAt', 'kind', 'startedAt']);

      // A phone that got its signal after the end: taken in, and it says so; the list follows the later mark.
      const c7 = callOf(alarm, '7A');
      const lateAt = new Date().toISOString();
      assert.equal((await crisis.markMine([{ id: randomUUID(), callId: c7.id, studentId: p1.id, state: 'MISSING', at: lateAt }], asTeacher(vera))).stored, 1);
      const protocol = await crisis.protocol(alarm.alarm.id, asAdmin);
      assert.equal(protocol.marks.length, 9);
      assert.deepEqual(protocol.marks.map((m) => m.at), [...protocol.marks.map((m) => m.at)].sort());
      assert.deepEqual(protocol.marks.filter((m) => m.late).map((m) => [m.groupName, m.by]), [['7A', 'vera Probe']]);
      assert.deepEqual(protocol.marks.filter((m) => m.onBehalf).map((m) => [m.groupName, m.by]), [['10D', 'admin Probe']]);
      assert.equal(callOf(protocol, '7A').pupils.find((p) => p.firstName === 'p1')!.status, 'MISSING');
      assert.equal(protocol.alarm.endNote, 'Falsklarm i hus B');

      // Still on the phone within the hour; gone from it, and refused, after it.
      assert.equal((await crisis.mine(asTeacher(vera))).alarms.length, 1);
      await withoutEndsOnce(() => owner.query(`UPDATE "CrisisAlarms" SET "startedAt" = now() - interval '3 hours', "listsSealedAt" = now() - interval '3 hours', "endedAt" = now() - interval '2 hours' WHERE id = $1`, [alarm.alarm.id]));
      assert.deepEqual((await crisis.mine(asTeacher(vera))).alarms, []);
      // The teacher's own list is gone, so the mark belongs to no alarm of theirs: the phone is told and drops it.
      const tooLate = randomUUID();
      assert.deepEqual(await crisis.markMine([{ id: tooLate, callId: c7.id, studentId: p2.id, state: 'FOUND', at: lateAt }], asTeacher(vera)), {
        stored: 0,
        duplicates: 0,
        unresolved: [tooLate],
      });
      // The administration still sees the alarm, and the database says it is over.
      await assert.rejects(
        crisis.markAsAdministration(alarm.alarm.id, [{ id: randomUUID(), callId: c7.id, studentId: p2.id, state: 'FOUND', at: lateAt }], asAdmin),
        (e: unknown) => codeOf(e) === 'CRISIS_ALARM_ENDED',
      );
    });

    await check('(kl-e) one alarm of each mode at a time: a real alarm cuts an exercise short, two starts at once give one alarm and one 409, and an exercise ended does not reach the guardians', async () => {
      await endOpenAlarms();
      const drill = await crisis.start({ kind: 'LOCKDOWN', mode: 'DRILL' }, asAdmin);
      await assert.rejects(crisis.start({ kind: 'EVACUATION', mode: 'DRILL' }, asAdmin), (e: unknown) => codeOf(e) === 'CRISIS_ALARM_OPEN');
      // The told text of an exercise is the exercise's.
      assert.ok((await noticesOf('CRISIS_ALARM')).some((n) => n.meta['mode'] === 'DRILL' && n.meta['alarmId'] === drill.alarm.id));
      const real = await crisis.start({ kind: 'EVACUATION', mode: 'LIVE' }, asAdmin);
      const cut = await one<{ endedAt: Date | null; endNote: string | null; endedByUserId: string | null }>(
        `SELECT "endedAt", "endNote", "endedByUserId" FROM "CrisisAlarms" WHERE id = $1`,
        [drill.alarm.id],
      );
      assert.ok(cut.endedAt !== null && cut.endNote === 'Avbröts av ett skarpt larm.' && cut.endedByUserId === admin.id);
      await assert.rejects(crisis.start({ kind: 'LOCKDOWN', mode: 'LIVE' }, asAdminOf(admin2)), (e: unknown) => codeOf(e) === 'CRISIS_ALARM_OPEN');
      // A drill can go on beside the real one.
      const drill2 = await crisis.start({ kind: 'EVACUATION', mode: 'DRILL' }, asAdmin);
      await crisis.end(drill2.alarm.id, {}, asAdmin);
      assert.equal((await one<{ g: Date | null }>(`SELECT "guardiansNotifiedAt" AS g FROM "CrisisAlarms" WHERE id = $1`, [drill2.alarm.id])).g, null);
      await crisis.end(real.alarm.id, {}, asAdmin);

      // The race: two administrators start a real alarm in the same moment, through two pools.
      const outcomes = await Promise.allSettled([
        crisis.start({ kind: 'EVACUATION', mode: 'LIVE' }, asAdmin),
        raced.start({ kind: 'LOCKDOWN', mode: 'LIVE' }, asAdminOf(admin2)),
      ]);
      assert.deepEqual(outcomes.map((o) => o.status).sort(), ['fulfilled', 'rejected']);
      const refused = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
      assert.equal(codeOf(refused.reason), 'CRISIS_ALARM_OPEN');
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "CrisisAlarms" WHERE "schoolId" = $1 AND "endedAt" IS NULL AND mode = 'LIVE'`, [s])).n, 1);

      // The lists of an alarm that has begun cannot be added to: not by the owner's trigger-free route
      // (that is the RLS suite's), and not by the service, which has no door for it.
      const sealed = await one<{ calls: number; sealed: boolean }>(
        `SELECT (SELECT count(*)::int FROM "CrisisCalls" c WHERE c."alarmId" = a.id) AS calls, a."listsSealedAt" IS NOT NULL AS sealed
           FROM "CrisisAlarms" a WHERE a."schoolId" = $1 AND a."endedAt" IS NULL AND a.mode = 'LIVE'`,
        [s],
      );
      assert.equal(sealed.sealed, true);
      assert.ok(sealed.calls >= 3);
      await endOpenAlarms();
    });

    await check('(kl-f) who may start: the school\'s choice of profiles, the deciders always, a teacher never', async () => {
      await endOpenAlarms();
      // Only expeditionen chosen: the deciders and expeditionen may, the planner may not.
      await crisis.updateSettings({ startProfiles: ['EXPEDITION'], notifyGuardiansAfter: false }, asAdmin);
      await assert.rejects(crisis.start({ kind: 'EVACUATION', mode: 'DRILL' }, asAdminOf(planner, 'SCHEMALAGGARE')), (e: unknown) => codeOf(e) === 'CRISIS_NOT_YOURS');
      assert.deepEqual(await crisis.settings(asAdminOf(planner, 'SCHEMALAGGARE')), { startProfiles: ['EXPEDITION'], notifyGuardiansAfter: false });
      const byDecider = await crisis.start({ kind: 'EVACUATION', mode: 'DRILL' }, asAdmin);
      await crisis.end(byDecider.alarm.id, {}, asAdmin);
      // Only the deciders write the settings: the database refuses the planner.
      await assert.rejects(crisis.updateSettings({ startProfiles: ['SCHEMALAGGARE'], notifyGuardiansAfter: true }, asAdminOf(planner, 'SCHEMALAGGARE')));
      assert.deepEqual((await crisis.settings(asAdmin)).startProfiles, ['EXPEDITION']);
      // Back to the planner too: now they may.
      await crisis.updateSettings({ startProfiles: ['SCHEMALAGGARE', 'EXPEDITION'], notifyGuardiansAfter: false }, asAdmin);
      const byPlanner = await crisis.start({ kind: 'EVACUATION', mode: 'DRILL' }, asAdminOf(planner, 'SCHEMALAGGARE'));
      await crisis.end(byPlanner.alarm.id, {}, asAdminOf(planner, 'SCHEMALAGGARE'));
      // A teacher never starts one, whatever the school chose.
      await assert.rejects(crisis.start({ kind: 'EVACUATION', mode: 'DRILL' }, { ...asTeacher(vera) }), (e: unknown) => codeOf(e) === 'CRISIS_NOT_YOURS' || e instanceof Error);
    });

    await check('(kl-g) the job ends an alarm left open, in no person\'s name, and tells the lists nothing more', async () => {
      await endOpenAlarms();
      const left = await crisis.start({ kind: 'EVACUATION', mode: 'DRILL' }, asAdmin);
      await withoutEndsOnce(() =>
        owner.query(`UPDATE "CrisisAlarms" SET "startedAt" = now() - interval '5 hours', "listsSealedAt" = now() - interval '5 hours' WHERE id = $1`, [left.alarm.id]),
      );
      assert.ok((await crisis.settle()) >= 1);
      const ended = await one<{ autoEnded: boolean; endedAt: Date | null; endedByUserId: string | null }>(
        `SELECT "autoEnded", "endedAt", "endedByUserId" FROM "CrisisAlarms" WHERE id = $1`,
        [left.alarm.id],
      );
      assert.ok(ended.autoEnded && ended.endedAt !== null && ended.endedByUserId === null);
      assert.equal(await crisis.settle(), 0);
      // The exercise is over, so a new one can begin.
      const next = await crisis.start({ kind: 'EVACUATION', mode: 'DRILL' }, asAdmin);
      await crisis.end(next.alarm.id, {}, asAdmin);
    });
  } finally {
    await racer.onModuleDestroy?.();
    await sweepKrislageSchool(owner, marker);
  }
}
