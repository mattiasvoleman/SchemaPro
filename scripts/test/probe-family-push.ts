/**
 * The adapter probe's checks for elev- och vårdnadshavarytan (20261013090000–
 * 20261013110000), against real Postgres as CI runs it: the guardian's child
 * schedule through the real FamilyScheduleService (ey-a), its teacher labels
 * against the public viewer's (ey-b), delivery after the commit as a TEACHER
 * and as an ADMIN with Expo stubbed at fetch (ey-c), the device registry,
 * tickets, receipts and housekeeping through the real functions (ey-d), and
 * the guardian's read timed for the record (ey-e). In a school of its own
 * (slug <marker>-familj), swept whole before and after.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { FamilyScheduleService, type FamilySchedule } from '../../src/family/family-schedule.service';
import { DevicesService } from '../../src/notifications/devices.service';
import { ExpoPushClient, resetExpoPacing } from '../../src/notifications/expo-push.client';
import { NotificationDeliveryService } from '../../src/notifications/notification-delivery.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { PushReceiptsService } from '../../src/notifications/push-receipts.service';
import { tokenHashOf } from '../../src/publication/public-token';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;
type Person = { id: string; authId: string };

const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const mondayOf = (date: string) => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));

interface FamilySchool {
  schoolId: string;
  yearId: string;
  today: string;
  admin: AuthenticatedUser;
  guardian: AuthenticatedUser;
  guardianId: string;
  teacher: AuthenticatedUser;
  child: Person;
  sibling: Person;
  classA: string;
  classB: string;
  classN: string;
  other: string;
  tg: string;
  tg2: string;
  t1: Person;
  t2: Person;
  t3: Person;
  subject: string;
}

export function familySlug(marker: string): string {
  return `${marker}-familj`;
}

async function givenFamilySchool(owner: Client, marker: string): Promise<FamilySchool> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [familySlug(marker)]);
  const one = async <T extends object>(sql: string, params: unknown[]): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const { today } = await one<{ today: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS today`, []);
  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${marker} familj`, familySlug(marker)],
  );
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, $2, $3::date, $4::date, true, now()) RETURNING id`,
    [school.id, `${marker} familj`, addDays(today, -60), addDays(today, 200)],
  );
  const group = (name: string, kind: 'CLASS' | 'TEACHING_GROUP') =>
    one<{ id: string }>(
      `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "updatedAt") VALUES ($1, $2, $3, $4::"StudentGroupKind", now()) RETURNING id`,
      [school.id, year.id, name, kind],
    );
  const classA = (await group('7A', 'CLASS')).id;
  const classB = (await group('7B', 'CLASS')).id;
  const classN = (await group('7N', 'CLASS')).id;
  const other = (await group('8A', 'CLASS')).id;
  const tg = (await group('Spanska 7', 'TEACHING_GROUP')).id;
  const tg2 = (await group('Modersmål 7', 'TEACHING_GROUP')).id;
  const person = (role: string, key: string, first: string, last: string, groupId: string | null = null) =>
    one<Person>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::"UserRole", gen_random_uuid(), true, $6, now()) RETURNING id, "authId"`,
      [school.id, `${marker}-familj-${key}@example.invalid`, first, last, role, groupId],
    );
  const admin = await person('SCHOOL_ADMIN', 'admin', 'Probe', 'Admin');
  const guardian = await person('GUARDIAN', 'guardian', 'Probe', 'Vårdnadshavare');
  const t1 = await person('TEACHER', 't1', 'Erik', 'Johansson');
  const t2 = await person('TEACHER', 't2', 'Anna', 'Lind');
  const t3 = await person('TEACHER', 't3', 'Lena', 'Berg');
  const child = await person('STUDENT', 'child', 'Ella', 'Probesson', classA);
  const sibling = await person('STUDENT', 'sibling', 'Olle', 'Probesson', classB);
  for (const kid of [child, sibling]) {
    await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3)`, [school.id, guardian.id, kid.id]);
  }
  await owner.query(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES ($1, $2, $3), ($1, $4, $5)`, [
    school.id,
    tg,
    child.id,
    tg2,
    sibling.id,
  ]);
  for (const [who, signature] of [
    [t1, 'ERJO'],
    [t2, 'ANLI'],
    [t3, 'LEBE'],
  ] as const) {
    await owner.query(
      `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", signature, "updatedAt") VALUES ($1, $2, $3, 100, $4, now())`,
      [school.id, who.id, year.id, signature],
    );
  }
  const subject = (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, 'Matematik', now()) RETURNING id`, [school.id])).id;
  const principal = (who: Person, role: Role): AuthenticatedUser => ({ authId: who.authId, userId: who.id, schoolId: school.id, role });
  return {
    schoolId: school.id,
    yearId: year.id,
    today,
    admin: principal(admin, Role.SCHOOL_ADMIN),
    guardian: principal(guardian, Role.GUARDIAN),
    guardianId: guardian.id,
    teacher: principal(t1, Role.TEACHER),
    child,
    sibling,
    classA,
    classB,
    classN,
    other,
    tg,
    tg2,
    t1,
    t2,
    t3,
    subject,
  };
}

export async function familyPushChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  const school = await givenFamilySchool(owner, marker);
  const schedule = new FamilyScheduleService(api);
  const lesson = async (
    date: string,
    start: string,
    groupId: string,
    teachers: Array<[Person, 'LEAD' | 'ASSISTANT' | 'SUBSTITUTE']>,
    extra: { extraGroup?: string; named?: string; status?: string; note?: string } = {},
  ): Promise<string> => {
    const row = (
      await owner.query<{ id: string }>(
        `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, note, "updatedAt")
         VALUES ($1, $2, $3, $4::date, ($4::date + $5::time) AT TIME ZONE 'Europe/Stockholm',
                 ($4::date + $5::time + interval '45 minutes') AT TIME ZONE 'Europe/Stockholm', $6::"LessonStatus", $7, now())
         RETURNING id`,
        [school.schoolId, school.subject, groupId, date, start, extra.status ?? 'SCHEDULED', extra.note ?? null],
      )
    ).rows[0]!;
    for (const [who, role] of teachers) {
      await owner.query(
        `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, $4::"TeacherAssignmentRole")`,
        [school.schoolId, row.id, who.id, role],
      );
    }
    if (extra.extraGroup) {
      await owner.query(`INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId") VALUES ($1, $2, $3)`, [
        school.schoolId,
        row.id,
        extra.extraGroup,
      ]);
    }
    if (extra.named) {
      await owner.query(`INSERT INTO "CalendarLessonStudents" ("schoolId", "calendarLessonId", "studentId") VALUES ($1, $2, $3)`, [
        school.schoolId,
        row.id,
        extra.named,
      ]);
    }
    return row.id;
  };

  // Next week: every day of it lies after the child's first class segment (today).
  const next = mondayOf(addDays(school.today, 7));
  const d = (offset: number) => addDays(next, offset);
  const ids = {
    home: await lesson(d(0), '08:00', school.classA, [[school.t1, 'LEAD'], [school.t2, 'ASSISTANT']]),
    homeInactiveTeacher: await lesson(d(0), '10:00', school.classA, [[school.t3, 'LEAD']]),
    tgOwn: await lesson(d(1), '08:00', school.tg, [[school.t2, 'LEAD']]),
    tgExtra: await lesson(d(1), '09:00', school.other, [[school.t1, 'LEAD']], { extraGroup: school.tg }),
    named: await lesson(d(1), '10:00', school.other, [[school.t1, 'LEAD']], { named: school.child.id }),
    cancelled: await lesson(d(2), '08:00', school.classA, [[school.t1, 'LEAD']], { status: 'CANCELLED', note: 'Inställd: Friluftsdag' }),
    substituted: await lesson(d(2), '09:00', school.classA, [[school.t3, 'SUBSTITUTE']], { note: 'Självstudier under tillsyn' }),
    rescheduled: await lesson(d(2), '10:00', school.classA, [[school.t1, 'LEAD']], { status: 'RESCHEDULED' }),
    otherClass: await lesson(d(3), '08:00', school.other, [[school.t1, 'LEAD']]),
    sibling: await lesson(d(3), '09:00', school.classB, [[school.t1, 'LEAD']]),
    siblingGroup: await lesson(d(3), '10:00', school.other, [[school.t1, 'LEAD']], { extraGroup: school.tg2 }),
    otherNamed: await lesson(d(3), '11:00', school.other, [[school.t1, 'LEAD']], { named: school.sibling.id }),
  };
  await owner.query(
    `INSERT INTO "CalendarLunches" ("schoolId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
     VALUES ($1, $2, $3::date, ($3::date + time '11:20') AT TIME ZONE 'Europe/Stockholm', ($3::date + time '11:50') AT TIME ZONE 'Europe/Stockholm', now())`,
    [school.schoolId, school.classA, d(0)],
  );
  await owner.query(
    `INSERT INTO "PublicationSettings" ("schoolId", "publicViewerEnabled", "publicGroups", "publicTeacherDisplay", "updatedAt")
     VALUES ($1, true, true, 'SIGNATURE', now())`,
    [school.schoolId],
  );

  const shown = (doc: FamilySchedule) => new Map(doc.lessons.map((l) => [l.id, l]));

  await check('(ey-a) a guardian reads their child’s published week through the real service: the union, never the sibling’s, another class’s or another pupil’s lesson', async () => {
    const doc = await schedule.week({ studentId: school.child.id, week: d(3) }, school.guardian);
    const got = shown(doc);
    assert.deepEqual(
      [...got.keys()].sort(),
      [ids.home, ids.homeInactiveTeacher, ids.tgOwn, ids.tgExtra, ids.named, ids.cancelled, ids.substituted].sort(),
    );
    assert.equal(doc.week.from, next);
    assert.equal(doc.student.firstName, 'Ella');
    assert.deepEqual(doc.lunches.map((m) => [m.date, m.start, m.end]), [[d(0), '11:20', '11:50']]);
    assert.equal(got.get(ids.home)!.start, '08:00');
    assert.ok(!JSON.stringify(doc).includes('Friluftsdag') && !JSON.stringify(doc).includes('Självstudier'), 'a note reached the family');
    // The sibling's own week, through the same guardian: theirs, not Ella's.
    const theirs = shown(await schedule.week({ studentId: school.sibling.id, week: d(3) }, school.guardian));
    assert.deepEqual([...theirs.keys()].sort(), [ids.sibling, ids.siblingGroup, ids.otherNamed].sort());
    // The same 404 for a pupil of no link, as the guardian.
    const stranger = await owner.query<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, 'Främling', 'Probe', 'STUDENT', gen_random_uuid(), true, $3, now()) RETURNING id`,
      [school.schoolId, `${marker}-familj-stranger@example.invalid`, school.classA],
    );
    await assert.rejects(schedule.week({ studentId: stranger.rows[0]!.id }, school.guardian), (e: unknown) => {
      const body = (e as { getResponse?: () => { code?: string } }).getResponse?.();
      return body?.code === 'STUDENT_NOT_FOUND';
    });
    await assert.rejects(schedule.week({ studentId: school.child.id, week: addDays(school.today, -21) }, school.guardian), (e: unknown) => {
      const body = (e as { getResponse?: () => { code?: string } }).getResponse?.();
      return body?.code === 'WEEK_OUT_OF_RANGE';
    });
  });

  await check('(ey-a) a pupil who moved class today: last week shows neither class’s home lessons, next week the new class’s', async () => {
    const last = mondayOf(addDays(school.today, -7));
    const lastNew = await lesson(addDays(last, 2), '08:00', school.classN, [[school.t1, 'LEAD']]);
    const lastOld = await lesson(addDays(last, 2), '09:00', school.classA, [[school.t1, 'LEAD']]);
    const nextNew = await lesson(d(4), '08:00', school.classN, [[school.t1, 'LEAD']]);
    await owner.query(`UPDATE "Users" SET "studentGroupId" = $2, "updatedAt" = now() WHERE id = $1`, [school.child.id, school.classN]);
    try {
      const before = shown(await schedule.week({ studentId: school.child.id, week: last }, school.guardian));
      assert.ok(!before.has(lastNew), 'the new class’s lesson before the move was shown');
      assert.ok(!before.has(lastOld), 'the old class’s lesson was shown after the move');
      const after = shown(await schedule.week({ studentId: school.child.id, week: d(4) }, school.guardian));
      assert.ok(after.has(nextNew), 'the new class’s lesson after the move was not shown');
      assert.ok(!after.has(ids.home), 'the old class’s lesson after the move was shown');
      assert.ok(after.has(ids.tgOwn), 'the teaching group went with the move');
    } finally {
      await owner.query(`UPDATE "Users" SET "studentGroupId" = $2, "updatedAt" = now() WHERE id = $1`, [school.child.id, school.classA]);
    }
  });

  await check('(ey-b) the family’s labels are the viewer’s for active teachers, under SIGNATURE and NAME; a substituted or cancelled lesson names nobody; a deactivated teacher is unlabelled here', async () => {
    const token = `probe-familj-${Date.now()}-abcdefghijklmnopqrstuvwxyz`;
    await owner.query(
      `INSERT INTO "PublicTimetableLinks" ("schoolId", "academicYearId", kind, "targetGroupId", "tokenHash") VALUES ($1, $2, 'GROUP', $3, $4)`,
      [school.schoolId, school.yearId, school.classA, tokenHashOf(token)],
    );
    const viewerLabels = async (): Promise<Map<string, string[]>> => {
      const [row] = await api.withPublicViewer((tx) =>
        tx.$queryRaw<{ doc: { days: Array<{ date: string; lessons: Array<{ start: string; teachers: string[] }> }> } | null }[]>`
          SELECT app.public_timetable(${tokenHashOf(token)}, NULL::uuid, ${d(0)}::date) AS "doc"`,
      );
      assert.ok(row?.doc, 'the viewer answered nothing');
      return new Map(row.doc.days.flatMap((day) => day.lessons.map((l) => [`${day.date} ${l.start}`, l.teachers] as [string, string[]])));
    };
    const familyLabels = async (): Promise<Map<string, string[]>> => {
      const doc = await schedule.week({ studentId: school.child.id, week: d(0) }, school.guardian);
      return new Map(doc.lessons.filter((l) => l.date === d(0) || l.date === d(2)).map((l) => [`${l.date} ${l.start}`, l.teachers]));
    };
    for (const display of ['SIGNATURE', 'NAME']) {
      await owner.query(`UPDATE "PublicationSettings" SET "publicTeacherDisplay" = $2::"TeacherDisplay" WHERE "schoolId" = $1`, [school.schoolId, display]);
      const viewer = await viewerLabels();
      const family = await familyLabels();
      for (const key of [`${d(0)} 08:00`, `${d(0)} 10:00`]) {
        assert.deepEqual(family.get(key), viewer.get(key), `${display} ${key}: family ${JSON.stringify(family.get(key))} viewer ${JSON.stringify(viewer.get(key))}`);
      }
      assert.deepEqual(family.get(`${d(2)} 08:00`), [], 'a cancelled lesson named a teacher');
      assert.deepEqual(family.get(`${d(2)} 09:00`), [], 'a substituted lesson named somebody');
    }
    await owner.query(`UPDATE "PublicationSettings" SET "publicTeacherDisplay" = 'SIGNATURE' WHERE "schoolId" = $1`, [school.schoolId]);
    assert.deepEqual((await familyLabels()).get(`${d(0)} 08:00`), ['ANLI', 'ERJO']);
    const doc = await schedule.week({ studentId: school.child.id, week: d(2) }, school.guardian);
    assert.equal(doc.lessons.find((l) => l.id === ids.substituted)?.substitute, true);
    assert.equal(doc.lessons.find((l) => l.id === ids.cancelled)?.substitute, false);
    // Deactivated: the viewer still says LEBE, the family nobody.
    await owner.query(`UPDATE "Users" SET "isActive" = false WHERE id = $1`, [school.t3.id]);
    try {
      assert.deepEqual((await viewerLabels()).get(`${d(0)} 10:00`), ['LEBE']);
      assert.deepEqual((await familyLabels()).get(`${d(0)} 10:00`), []);
    } finally {
      await owner.query(`UPDATE "Users" SET "isActive" = true WHERE id = $1`, [school.t3.id]);
    }
  });

  // ---- delivery after the commit, with Expo and Resend stubbed at fetch.
  const calls: Array<{ url: string; body: unknown; rowsAtCall: number }> = [];
  let receiptsAnswer: Record<string, unknown> = {};
  const fetchStub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    const body = JSON.parse(String(init?.body ?? 'null')) as unknown;
    // What another connection sees when the hook runs: the committed rows.
    const { rows } = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM "Notifications" WHERE "schoolId" = $1`, [school.schoolId]);
    calls.push({ url: target, body, rowsAtCall: rows[0]!.n });
    if (target.endsWith('/send')) {
      const messages = body as unknown[];
      return new Response(JSON.stringify({ data: messages.map((_m, i) => ({ status: 'ok', id: `probe-ticket-${Date.now()}-${i}` })) }), { status: 200 });
    }
    if (target.endsWith('/getReceipts')) return new Response(JSON.stringify({ data: receiptsAnswer }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const expo = new ExpoPushClient({ apiUrl: 'https://push.probe.invalid', fetch: fetchStub as typeof fetch, sleep: async () => undefined });
  const pushOn = { get: (key: string) => (key === 'push' ? { enabled: true } : undefined) };
  const delivery = new NotificationDeliveryService(api, pushOn as never, expo);
  const notifications = new NotificationsService(api, delivery);
  const devices = new DevicesService(api, pushOn as never);
  const receipts = new PushReceiptsService(api, pushOn as never, expo);
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await delivery.idle();
  };
  // Resend is reached through the global fetch: stubbed too, so nothing leaves the machine.
  const savedKey = process.env.RESEND_API_KEY;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = fetchStub as typeof fetch;
  process.env.RESEND_API_KEY = 'probe-resend-key';
  resetExpoPacing();
  const TOKEN = 'ExponentPushToken[probeFamiljAAAA]';
  const TEACHER_TOKEN = 'ExponentPushToken[probeFamiljBBBB]';

  try {
    await check('(ey-d) a guardian registers a device through the claim function; the row is theirs, readable and deletable by them alone', async () => {
      await devices.register({ token: TOKEN, platform: 'IOS', locale: 'sv' }, school.guardian);
      await devices.register({ token: TOKEN, platform: 'IOS', locale: 'en' }, school.guardian);
      const { rows } = await owner.query<{ userId: string; locale: string }>(`SELECT "userId", locale FROM "DevicePushTokens" WHERE token = $1`, [TOKEN]);
      assert.deepEqual(rows, [{ userId: school.guardianId, locale: 'en' }]);
      const seen = await api.withRls(school.admin, (tx) => tx.devicePushToken.count());
      assert.equal(seen, 0, 'the admin reads a guardian’s device');
      await devices.unregister({ token: TOKEN }, school.teacher);
      assert.equal((await owner.query(`SELECT 1 FROM "DevicePushTokens" WHERE token = $1`, [TOKEN])).rowCount, 1, 'a teacher unregistered a guardian’s device');
    });

    await check('(ey-c) a TEACHER’s notice to a guardian commits with ids the gateway made, and is mailed and pushed once, after the commit; a rolled-back one tells nobody', async () => {
      calls.length = 0;
      await assert.rejects(
        api.withRls(school.teacher, async (tx) => {
          await notifications.notifyUsers(tx, {
            schoolId: school.schoolId,
            userIds: [school.guardianId],
            type: 'ABSENCE_UNREPORTED',
            meta: { studentName: 'Ella Probesson', subjectName: 'Matematik', date: d(0) },
            email: { subject: 'S', body: 'B' },
          });
          throw new Error('rolled back after the notice');
        }),
        /rolled back after the notice/,
      );
      await settle();
      assert.equal(calls.length, 0, 'a rolled-back notice was delivered');

      await api.withRls(school.teacher, (tx) =>
        notifications.notifyUsers(tx, {
          schoolId: school.schoolId,
          userIds: [school.guardianId],
          type: 'ABSENCE_UNREPORTED',
          meta: { studentName: 'Ella Probesson', subjectName: 'Matematik', date: d(0) },
          email: { subject: 'S', body: 'B' },
        }),
      );
      await settle();
      assert.deepEqual(calls.map((c) => c.url.replace(/^https:\/\/[^/]+/, '')), ['/emails', '/send']);
      assert.ok(calls.every((c) => c.rowsAtCall === 1), 'the hook ran before the row was visible to another connection');
      const [message] = calls[1]!.body as Array<{ to: string; body: string; data: { notificationId: string; type: string } }>;
      assert.equal(message!.to, TOKEN);
      assert.equal(message!.body, `Unreported absence ${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${d(0)}T12:00:00Z`))}. Open SchemaPro to see more.`);
      assert.ok(!JSON.stringify(calls[1]!.body).includes('Ella') && !JSON.stringify(calls[1]!.body).includes('Matematik'));
      const { rows } = await owner.query<{ id: string }>(`SELECT id FROM "Notifications" WHERE "userId" = $1`, [school.guardianId]);
      assert.deepEqual(rows.map((r) => r.id), [message!.data.notificationId]);
      const tickets = await owner.query(`SELECT 1 FROM "PushTickets" WHERE "schoolId" = $1`, [school.schoolId]);
      assert.equal(tickets.rowCount, 1, 'the ticket was not stored');
    });

    await check('(ey-c) an ADMIN’s three cancellations in one transaction are one push per person, and an opt-out silences the type outside the app only', async () => {
      calls.length = 0;
      await devices.register({ token: TEACHER_TOKEN, platform: 'ANDROID', locale: 'sv' }, school.teacher);
      await api.withRls(school.teacher, (tx) =>
        tx.notificationOptOut.createMany({ data: [{ userId: school.t1.id, schoolId: school.schoolId, type: 'LESSON_CANCELLED' }] }),
      );
      await api.withRls(school.admin, async (tx) => {
        for (let i = 0; i < 3; i++) {
          await notifications.notifyUsers(tx, {
            schoolId: school.schoolId,
            userIds: [school.guardianId, school.t1.id],
            type: 'LESSON_CANCELLED',
            meta: { subjectName: 'Matematik', startsAt: new Date(Date.parse(`${d(i)}T06:00:00Z`)).toISOString() },
          });
        }
      });
      await settle();
      assert.deepEqual(calls.map((c) => c.url.replace(/^https:\/\/[^/]+/, '')), ['/send']);
      const sent = calls[0]!.body as Array<{ to: string; body: string }>;
      assert.deepEqual(sent.map((m) => [m.to, m.body]), [[TOKEN, '3 lessons are cancelled.']]);
      const inbox = await owner.query(`SELECT 1 FROM "Notifications" WHERE "userId" = $1 AND type = 'LESSON_CANCELLED'`, [school.t1.id]);
      assert.equal(inbox.rowCount, 3, 'an opt-out removed in-app rows');
    });

    await check('(ey-c) a substitute’s own booking reaches them whatever they opted out of', async () => {
      calls.length = 0;
      await api.withRls(school.teacher, (tx) =>
        tx.notificationOptOut.createMany({ data: [{ userId: school.t1.id, schoolId: school.schoolId, type: 'LESSON_SUBSTITUTE' }] }),
      );
      await api.withRls(school.admin, (tx) =>
        notifications.notifyUsers(tx, {
          schoolId: school.schoolId,
          userIds: [school.t1.id],
          type: 'LESSON_SUBSTITUTE',
          meta: { cover: true, subjectName: 'Matematik', groupName: '7A', roomName: 'B204', startsAt: `${d(0)}T07:00:00.000Z` },
        }),
      );
      await settle();
      const sent = calls[0]?.body as Array<{ to: string; body: string }> | undefined;
      assert.deepEqual(sent?.map((m) => m.to), [TEACHER_TOKEN]);
      assert.match(sent![0]!.body, /^Du har ett vikariepass \S+ \d+ \S+ \d{2}:\d{2}\.$/);
    });

    await check('(ey-d) receipts: a due ticket is claimed past a locked one (SKIP LOCKED), DeviceNotRegistered revokes the device, the checked tickets go, and housekeeping keeps 24 h, 30 d and 180 d', async () => {
      // Every ticket so far is due, and one more is held by another transaction.
      await owner.query(`UPDATE "PushTickets" SET "createdAt" = now() - interval '20 minutes' WHERE "schoolId" = $1`, [school.schoolId]);
      const { rows: tickets } = await owner.query<{ id: string; tokenId: string }>(`SELECT id, "tokenId" FROM "PushTickets" WHERE "schoolId" = $1 ORDER BY id`, [school.schoolId]);
      assert.ok(tickets.length >= 2, `only ${tickets.length} tickets to check`);
      const [locked, ...free] = tickets;
      const guardianToken = (await owner.query<{ id: string }>(`SELECT id FROM "DevicePushTokens" WHERE token = $1`, [TOKEN])).rows[0]!.id;
      // Housekeeping fodder: a ticket past 24 h, a token revoked 31 days ago, one unseen for 181 days.
      await owner.query(`INSERT INTO "PushTickets" (id, "schoolId", "tokenId", "createdAt") VALUES ('probe-old-ticket-1', $1, $2, now() - interval '25 hours')`, [
        school.schoolId,
        guardianToken,
      ]);
      const oldToken = (await owner.query<{ id: string }>(
        `INSERT INTO "DevicePushTokens" ("schoolId", "userId", token, platform, "revokedAt", "revokedReason")
         VALUES ($1, $2, 'ExponentPushToken[probeFamiljOLD1]', 'IOS', now() - interval '31 days', 'DEVICE_NOT_REGISTERED') RETURNING id`,
        [school.schoolId, school.t2.id],
      )).rows[0]!.id;
      const staleToken = (await owner.query<{ id: string }>(
        `INSERT INTO "DevicePushTokens" ("schoolId", "userId", token, platform, "lastSeenAt") VALUES ($1, $2, 'ExponentPushToken[probeFamiljOLD2]', 'IOS', now() - interval '181 days') RETURNING id`,
        [school.schoolId, school.t2.id],
      )).rows[0]!.id;

      receiptsAnswer = Object.fromEntries(
        free.map((t) => [t.id, t.tokenId === guardianToken ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' }]),
      );
      calls.length = 0;
      await owner.query('BEGIN');
      try {
        await owner.query(`SELECT 1 FROM "PushTickets" WHERE id = $1 FOR UPDATE`, [locked!.id]);
        await receipts.tick();
      } finally {
        await owner.query('ROLLBACK');
      }
      const asked = (calls[0]?.body as { ids: string[] } | undefined)?.ids ?? [];
      assert.deepEqual([...asked].sort(), free.map((t) => t.id).sort(), 'the receipts asked were not the free due tickets');
      const left = await owner.query<{ id: string }>(`SELECT id FROM "PushTickets" WHERE "schoolId" = $1 ORDER BY id`, [school.schoolId]);
      assert.deepEqual(left.rows.map((r) => r.id), [locked!.id], 'checked or expired tickets were left, or the locked one went');
      const gone = await owner.query(`SELECT 1 FROM "DevicePushTokens" WHERE id = ANY($1::uuid[])`, [[oldToken, staleToken]]);
      assert.equal(gone.rowCount, 0, 'housekeeping kept a dead or stale device');
      if (free.some((t) => t.tokenId === guardianToken)) {
        const revoked = await owner.query<{ revokedReason: string }>(`SELECT "revokedReason" FROM "DevicePushTokens" WHERE id = $1`, [guardianToken]);
        assert.equal(revoked.rows[0]?.revokedReason, 'DEVICE_NOT_REGISTERED');
      }
    });

    await check('(ey-d) release at the next sign-in deletes whoever held the device; a claim takes it over', async () => {
      await devices.register({ token: TOKEN, platform: 'IOS', locale: 'sv' }, school.teacher);
      const holder = await owner.query<{ userId: string; revokedAt: Date | null }>(`SELECT "userId", "revokedAt" FROM "DevicePushTokens" WHERE token = $1`, [TOKEN]);
      assert.deepEqual(holder.rows, [{ userId: school.t1.id, revokedAt: null }]);
      await devices.release({ token: TOKEN }, school.guardian);
      assert.equal((await owner.query(`SELECT 1 FROM "DevicePushTokens" WHERE token = $1`, [TOKEN])).rowCount, 0);
      await devices.unregister({ token: TEACHER_TOKEN }, school.teacher);
      assert.equal((await owner.query(`SELECT 1 FROM "DevicePushTokens" WHERE token = $1`, [TEACHER_TOKEN])).rowCount, 0);
    });
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = savedKey;
  }

  await check('(ey-e) the guardian’s week, timed (informational; the arms’ cost to staff reads is scripts/bench/family-arms.ts’s)', async () => {
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const started = performance.now();
      await schedule.week({ studentId: school.child.id, week: d(0) }, school.guardian);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    console.log(`     family schedule week: median ${times[3]!.toFixed(1)} ms over 7 (pool of ${process.env.DATABASE_URL?.match(/connection_limit=(\d+)/)?.[1] ?? '?'})`);
  });

  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [familySlug(marker)]);
}

/** For the probe's sweep, after a run that stopped inside these checks. */
export async function sweepFamilySchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [familySlug(marker)]);
}
