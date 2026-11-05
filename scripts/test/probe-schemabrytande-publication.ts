/**
 * The adapter probe's checks for what happens to a schemabrytande aktivitet
 * beside the rest of the calendar (20270101090000), through the real services
 * on the API's role and real Postgres. Each check builds a school of its own
 * (slug <marker>-akt-<tag>), swept before and after, because a publish writes
 * every master of the year and would otherwise write into the other checks:
 *
 *   sa-g2 changing an activity across the day that has begun: the lessons a
 *         replacement lesson that was held stands for stay cancelled with it
 *         (a removal's rule), and the preview says so;
 *   sa-k  a publish beside the activity's own transaction, in DIRECT and in
 *         DRAFT, the activity first and the publish first: no lesson the
 *         publish wrote into the activity's days is left standing;
 *   sa-l  a DIRECT master moved onto a day of the activity: the lesson it
 *         moves there is cancelled with the rest, and the replacement lesson
 *         holds it;
 *   sa-m  "Tillämpa igen": what has come into the days since is counted
 *         (`addedSince`), cancelled and replaced, and counted no more;
 *   sa-n  a lov entered after the activity: no replacement lesson is written
 *         on it again, by "Tillämpa igen" or by a change;
 *   sa-o  a class deleted since the activity was made does not make the
 *         activity impossible to change.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { CalendarService } from '../../src/calendar/calendar.service';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { ScheduleVersionsService } from '../../src/calendar/schedule-versions.service';
import type { PrismaService } from '../../src/database/prisma.service';
import { NotificationDeliveryService } from '../../src/notifications/notification-delivery.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { DraftService } from '../../src/publication/draft.service';
import { PublicationsService } from '../../src/publication/publications.service';
import { ScheduleActivitiesService } from '../../src/publication/schedule-activities.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import { StaffingLoadService } from '../../src/staffing/staffing-load.service';
import { TimplanCoverageService } from '../../src/timplan/timplan-coverage.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

const slugOf = (marker: string, tag: string) => `${marker}-akt-${tag}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const addDays = (date: string, n: number): string => {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** The Monday of next week: always after today. */
const nextMonday = (today: string): string => {
  const d = new Date(`${today}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + (7 - ((d.getUTCDay() + 6) % 7)));
  return d.toISOString().slice(0, 10);
};

export async function sweepScheduleActivityPublicationSchools(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug LIKE $1`, [`${marker}-akt-%`]);
}

const realtime = {
  notifyLessonChanged: async () => undefined,
  notifyLessonsChanged: async () => undefined,
  notifyCoverBoardChanged: () => undefined,
  notifyMasterTimetableChanged: () => undefined,
} as unknown as RealtimeService;

/** A school with a year, the helpers to fill it, and the real services over the API's pool. */
async function world(owner: Client, api: PrismaService, marker: string, tag: string) {
  const slug = slugOf(marker, tag);
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [slug]);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;
  const s = (
    await one<{ id: string }>(
      `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
      [`${marker} aktivitet ${tag}`, slug],
    )
  ).id;
  const yearId = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
       VALUES ($1, 'probe aktivitet', $2::date - 30, $2::date + 300, true, 'NIOARIG', now()) RETURNING id`,
      [s, today],
    )
  ).id;
  const group = async (name: string, grade: number | null = 7) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', $4, now()) RETURNING id`,
        [s, yearId, name, grade],
      )
    ).id;
  const subject = async (name: string, code: string, counts: boolean) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "Subjects" ("schoolId", name, code, "countsTowardTimplan", "updatedAt") VALUES ($1, $2, $3, $4, now()) RETURNING id`,
        [s, name, code, counts],
      )
    ).id;
  const person = async (role: string, label: string, groupId: string | null = null): Promise<AuthenticatedUser> => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "adminProfile", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4, $5, true, $6, $7::"AdminProfile", now()) RETURNING id`,
      [s, `${marker}-akt-${tag}-${label}@example.invalid`, label, role, authId, groupId, role === 'SCHOOL_ADMIN' ? 'FULL' : null],
    );
    return {
      authId,
      role: role as Role,
      userId: row.id,
      schoolId: s,
      channel: 'WEB',
      ...(role === 'SCHOOL_ADMIN' ? { adminProfile: 'FULL' as never, hrRead: false } : {}),
    };
  };
  const master = async (subjectId: string, groupId: string, teacherId: string, dayOfWeek: number, from: string, to: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7::time, $8::time, now()) RETURNING id`,
        [s, yearId, subjectId, groupId, teacherId, dayOfWeek, from, to],
      )
    ).id;
  /** A calendar lesson with its master, as a publish leaves it. */
  const lesson = async (date: string, from: string, to: string, subjectId: string, groupId: string, teacher: AuthenticatedUser) => {
    const id = (
      await one<{ id: string }>(
        `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
         VALUES ($1, $2, $3, $4::date, ($4::date + $5::time) AT TIME ZONE 'Europe/Stockholm', ($4::date + $6::time) AT TIME ZONE 'Europe/Stockholm', 'SCHEDULED', now())
         RETURNING id`,
        [s, subjectId, groupId, date, from, to],
      )
    ).id;
    const dayOfWeek = (await one<{ d: number }>(`SELECT extract(isodow FROM $1::date)::int AS d`, [date])).d;
    const m = await master(subjectId, groupId, teacher.userId!, dayOfWeek, from, to);
    await owner.query(`UPDATE "CalendarLessons" SET "masterLessonId" = $2 WHERE id = $1`, [id, m]);
    await owner.query(
      `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, 'LEAD')`,
      [s, id, teacher.userId],
    );
    return id;
  };
  const notifications = new NotificationsService(api, new NotificationDeliveryService(api));
  const quiet = { recipientsForLessons: async () => [], notifyUsers: async () => undefined } as unknown as NotificationsService;
  const admin = await person('SCHOOL_ADMIN', 'Admin');
  return {
    s,
    yearId,
    today,
    one,
    all,
    group,
    subject,
    person,
    master,
    lesson,
    admin,
    notifications,
    quiet,
    activities: (service: PrismaService = api) => new ScheduleActivitiesService(service, realtime, notifications),
    publications: (service: PrismaService = api) =>
      new PublicationsService(service, new CalendarService(service), new TimplanCoverageService(service), new StaffingLoadService(service), quiet, realtime),
    status: (id: string) => one<{ status: string }>(`SELECT status::text AS status FROM "CalendarLessons" WHERE id = $1`, [id]),
    replacements: (activityId: string) =>
      all<{ id: string; date: string; from: string; to: string; studentGroupId: string }>(
        `SELECT cl.id, cl.date::text AS date,
                to_char(cl."startsAt" AT TIME ZONE 'Europe/Stockholm', 'HH24:MI') AS "from",
                to_char(cl."endsAt" AT TIME ZONE 'Europe/Stockholm', 'HH24:MI') AS "to", cl."studentGroupId"
           FROM "ScheduleActivityLessons" sal JOIN "CalendarLessons" cl ON cl.id = sal."calendarLessonId"
          WHERE sal."activityId" = $1 ORDER BY cl.date, cl."startsAt", cl."studentGroupId"`,
        [activityId],
      ),
    /** What stands in a class's days at a time of day, by status. */
    standing: (groupId: string, from: string, to: string, at: string) =>
      all<{ date: string; status: string; subject: string }>(
        `SELECT cl.date::text AS date, cl.status::text AS status, sub.name AS subject
           FROM "CalendarLessons" cl JOIN "Subjects" sub ON sub.id = cl."subjectId"
          WHERE cl."schoolId" = $1 AND cl."studentGroupId" = $2 AND cl.date BETWEEN $3::date AND $4::date
            AND to_char(cl."startsAt" AT TIME ZONE 'Europe/Stockholm', 'HH24:MI') = $5
          ORDER BY cl.date`,
        [s, groupId, from, to, at],
      ),
    cleanup: () => owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [slug]),
  };
}

type World = Awaited<ReturnType<typeof world>>;

/**
 * A PrismaService whose first MAIN transaction (a publish's and an activity's
 * carry the 120 s timeout; the reads before them do not) is kept open for
 * `holdMs` after the callback returned.
 */
function holding(api: PrismaService, holdMs: number) {
  let reached!: () => void;
  const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
  let first = true;
  const service = new Proxy(api, {
    get(target, prop, receiver) {
      if (prop !== 'withRls') return Reflect.get(target, prop, receiver);
      return (user: never, fn: (tx: unknown) => Promise<unknown>, options?: unknown) =>
        (target.withRls as never as (u: unknown, f: unknown, o?: unknown) => Promise<unknown>)(
          user,
          async (tx: unknown) => {
            const result = await fn(tx);
            if (first && (options as { timeoutMs?: number } | undefined)?.timeoutMs === 120_000) {
              first = false;
              reached();
              await sleep(holdMs);
            }
            return result;
          },
          options,
        );
    },
  }) as unknown as PrismaService;
  return { service, reached: reachedPromise };
}

export async function scheduleActivityPublicationChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepScheduleActivityPublicationSchools(owner, marker);
  try {
    await check('(sa-g2) changing it across the day that has begun: the lessons a held replacement stands for stay cancelled, as in a removal', async () => {
      const w = await world(owner, api, marker, 'g2');
      const matte = await w.subject('Matte', 'AGMA', true);
      const idrott = await w.subject('Idrott', 'AGID', true);
      const temadag = await w.subject('Temadag', 'AGTD', false);
      const k7a = await w.group('AG7A');
      const anna = await w.person('TEACHER', 'Anna');
      const ella = await w.person('STUDENT', 'Ella', k7a);
      const monday = nextMonday(w.today);
      const friday = addDays(monday, 4);
      const following = addDays(monday, 7);
      const f1 = await w.lesson(friday, '08:00', '08:45', matte, k7a, anna);
      const f2 = await w.lesson(friday, '09:00', '09:45', matte, k7a, anna);
      const m1 = await w.lesson(following, '08:00', '08:45', matte, k7a, anna);
      const activities = w.activities();
      const body = (extra: Record<string, unknown> = {}) => ({
        academicYearId: w.yearId,
        name: 'Prov åk 7A',
        fromDate: friday,
        toDate: following,
        scope: 'GROUPS' as const,
        groupIds: [k7a],
        replacementSubjectId: temadag,
        teachers: [{ studentGroupId: k7a, teacherId: anna.userId!, role: 'LEAD' as const }],
        credits: [{ subjectId: idrott, minutes: 60 }],
        notify: false,
        ...extra,
      });
      const created = await activities.create(body(), w.admin);
      const [fridayReplacement] = await w.replacements(created.activity.id);
      assert.equal(fridayReplacement.date, friday);
      // Time has passed: Friday's replacement lesson has begun and has a register, while the class's lessons
      // of that day are still ahead and cancelled.
      await owner.query(`UPDATE "CalendarLessons" SET "startsAt" = now() - interval '2 hours' WHERE id = $1`, [fridayReplacement.id]);
      await owner.query(
        `INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "updatedAt") VALUES ($1, $2, $3, 'PRESENT', now())`,
        [w.s, fridayReplacement.id, ella.userId],
      );
      // The administrator narrows it to start on the Monday after.
      const change = body({ fromDate: following });
      const preview = await activities.updatePreview(created.activity.id, change, w.admin);
      assert.equal(preview.change?.released, 0);
      const changed = await activities.update(created.activity.id, change, w.admin);
      assert.equal(changed.released, 0);
      assert.equal((await w.status(f1)).status, 'CANCELLED');
      assert.equal((await w.status(f2)).status, 'CANCELLED');
      assert.equal((await w.status(m1)).status, 'CANCELLED');
      // The class has the one lesson that day, the one that was held.
      assert.deepEqual((await w.replacements(created.activity.id)).map((row) => row.date), [friday, following]);
      assert.equal(
        (await w.all(`SELECT 1 FROM "CalendarLessons" WHERE "studentGroupId" = $1 AND date = $2::date AND status = 'SCHEDULED' AND "startsAt" > now()`, [k7a, friday])).length,
        0,
      );
      // And the same removal puts the Monday back and keeps Friday as it was held.
      const removed = await activities.remove(created.activity.id, w.admin);
      assert.equal(removed.replacementsKept, 1);
      assert.equal((await w.status(f1)).status, 'CANCELLED');
      assert.equal((await w.status(m1)).status, 'SCHEDULED');
      await w.cleanup();
    });

    for (const mode of ['DIRECT', 'DRAFT'] as const) {
      for (const order of ['activity-first', 'publish-first'] as const) {
        await check(`(sa-k) ${mode}, ${order}: a publish beside the activity leaves none of its lessons standing in the activity's days`, async () => {
          const w = await world(owner, api, marker, `k${mode[1].toLowerCase()}${order[0]}`);
          const matte = await w.subject('Matte', 'AKMA', true);
          const temadag = await w.subject('Temadag', 'AKTD', false);
          const k7a = await w.group('AK7A');
          const anna = await w.person('TEACHER', 'Anna');
          await w.person('STUDENT', 'Ella', k7a);
          const monday = nextMonday(w.today);
          const tuesday = addDays(monday, 1);
          const range = { academicYearId: w.yearId, validFrom: monday, validTo: addDays(monday, 13), acknowledgeWarnings: true };
          const publications = w.publications();
          await w.master(matte, k7a, anna.userId!, 2, '08:00', '09:00');
          await publications.publish(range, w.admin);
          const masters = new MasterLessonsService(api, realtime, w.quiet);
          if (mode === 'DRAFT') {
            const calendar = new CalendarService(api);
            await new DraftService(api, calendar, new ScheduleVersionsService(api), realtime).switchMode('DRAFT', w.admin);
            await masters.create(
              { academicYearId: w.yearId, subjectId: matte, studentGroupId: k7a, teacherId: anna.userId!, dayOfWeek: 2, startTime: '13:00', endTime: '14:00' } as never,
              w.admin,
            );
          } else {
            await w.master(matte, k7a, anna.userId!, 2, '13:00', '14:00');
          }
          const body = {
            academicYearId: w.yearId,
            name: 'Prov åk 7A',
            fromDate: tuesday,
            toDate: addDays(monday, 8),
            scope: 'GROUPS' as const,
            groupIds: [k7a],
            replacementSubjectId: temadag,
            teachers: [{ studentGroupId: k7a, teacherId: anna.userId!, role: 'LEAD' as const }],
            notify: false,
          };
          const held = holding(api, 2000);
          if (order === 'activity-first') {
            const activity = w.activities(held.service).create(body, w.admin);
            await held.reached;
            // The publish runs while the activity's transaction is open: it is not made to wait, and does not see it.
            await publications.publish(range, w.admin);
            await activity;
          } else {
            const publish = w.publications(held.service).publish(range, w.admin);
            await held.reached;
            await w.activities().create(body, w.admin);
            await publish;
          }
          const late = await w.standing(k7a, tuesday, addDays(monday, 8), '13:00');
          assert.equal(late.length, 2, `the two 13:00 lessons were published: ${JSON.stringify(late)}`);
          assert.deepEqual(late.map((row) => row.status), ['CANCELLED', 'CANCELLED']);
          const [activity] = await w.all<{ id: string }>(`SELECT id FROM "ScheduleActivities" WHERE "schoolId" = $1`, [w.s]);
          const replacement = await w.replacements(activity.id);
          assert.deepEqual(replacement.map((row) => [row.from, row.to]), [['08:00', '14:00'], ['08:00', '14:00']]);
          await w.cleanup();
        });
      }
    }

    await check('(sa-l) a DIRECT master moved onto a day of the activity: the lesson it moves there is cancelled with the rest and the replacement holds it', async () => {
      const w = await world(owner, api, marker, 'l');
      const matte = await w.subject('Matte', 'ALMA', true);
      const temadag = await w.subject('Temadag', 'ALTD', false);
      const k7a = await w.group('AL7A');
      const anna = await w.person('TEACHER', 'Anna');
      await w.person('STUDENT', 'Ella', k7a);
      await w.master(matte, k7a, anna.userId!, 2, '08:00', '09:00');
      const thursday = await w.master(matte, k7a, anna.userId!, 4, '10:00', '11:00');
      const monday = nextMonday(w.today);
      const tuesday = addDays(monday, 1);
      const nextTuesday = addDays(monday, 8);
      await w.publications().publish({ academicYearId: w.yearId, validFrom: monday, validTo: addDays(monday, 20), acknowledgeWarnings: true }, w.admin);
      const created = await w.activities().create(
        {
          academicYearId: w.yearId,
          name: 'Prov åk 7A',
          fromDate: tuesday,
          toDate: nextTuesday,
          scope: 'GROUPS' as const,
          groupIds: [k7a],
          replacementSubjectId: temadag,
          teachers: [{ studentGroupId: k7a, teacherId: anna.userId!, role: 'LEAD' as const }],
          notify: false,
        },
        w.admin,
      );
      const thursdayOne = addDays(monday, 3);
      assert.deepEqual((await w.replacements(created.activity.id)).map((row) => [row.date, row.to]), [
        [tuesday, '09:00'],
        [thursdayOne, '11:00'],
        [nextTuesday, '09:00'],
      ]);
      // Thursday's weekly lesson is moved to Tuesday 13:00. The first Thursday is cancelled and stays where it
      // was; the second moves onto the activity's last day, where it is cancelled and the replacement grows.
      await new MasterLessonsService(api, realtime, w.quiet).update(thursday, { dayOfWeek: 2, startTime: '13:00', endTime: '14:00' }, w.admin);
      const late = await w.standing(k7a, tuesday, nextTuesday, '13:00');
      assert.deepEqual(late.map((row) => [row.date, row.status]), [[nextTuesday, 'CANCELLED']]);
      assert.deepEqual((await w.replacements(created.activity.id)).map((row) => [row.date, row.to]), [
        [tuesday, '09:00'],
        [thursdayOne, '11:00'],
        [nextTuesday, '14:00'],
      ]);
      await w.cleanup();
    });

    await check('(sa-m) apply again: what has come into the days since is counted, cancelled and replaced, and counted no more', async () => {
      const w = await world(owner, api, marker, 'm');
      const matte = await w.subject('Matte', 'AMMA', true);
      const temadag = await w.subject('Temadag', 'AMTD', false);
      const k7a = await w.group('AM7A');
      const anna = await w.person('TEACHER', 'Anna');
      const ella = await w.person('STUDENT', 'Ella', k7a);
      const monday = nextMonday(w.today);
      const tuesday = addDays(monday, 1);
      const wednesday = addDays(monday, 2);
      await w.lesson(tuesday, '08:00', '08:45', matte, k7a, anna);
      await w.lesson(wednesday, '08:00', '08:45', matte, k7a, anna);
      const activities = w.activities();
      const created = await activities.create(
        {
          academicYearId: w.yearId,
          name: 'Prov åk 7A',
          fromDate: tuesday,
          toDate: wednesday,
          scope: 'GROUPS' as const,
          groupIds: [k7a],
          replacementSubjectId: temadag,
          teachers: [{ studentGroupId: k7a, teacherId: anna.userId!, role: 'LEAD' as const }],
        },
        w.admin,
      );
      assert.equal((await activities.list(w.yearId, w.admin))[0].addedSince, 0);
      const arrived = await w.lesson(wednesday, '10:00', '10:45', matte, k7a, anna);
      assert.equal((await activities.list(w.yearId, w.admin))[0].addedSince, 1);
      const before = await w.one<{ n: number }>(`SELECT count(*)::int AS n FROM "Notifications" WHERE "schoolId" = $1 AND type = 'CANCELLATION_DIGEST'`, [w.s]);

      const applied = await activities.reapply(created.activity.id, w.admin);

      assert.equal(applied.added, 1);
      assert.equal(applied.activity.addedSince, 0);
      assert.equal((await w.status(arrived)).status, 'CANCELLED');
      assert.deepEqual((await w.replacements(created.activity.id)).map((row) => [row.date, row.from, row.to]), [
        [tuesday, '08:00', '08:45'],
        [wednesday, '08:00', '10:45'],
      ]);
      // The people it newly touches are told once; a second run tells nobody and changes nothing.
      const after = await w.one<{ n: number }>(`SELECT count(*)::int AS n FROM "Notifications" WHERE "schoolId" = $1 AND type = 'CANCELLATION_DIGEST'`, [w.s]);
      assert.ok(after.n > before.n);
      assert.ok((await w.all<{ userId: string }>(`SELECT "userId" FROM "Notifications" WHERE "schoolId" = $1 AND type = 'CANCELLATION_DIGEST'`, [w.s])).some((row) => row.userId === ella.userId));
      assert.equal((await activities.reapply(created.activity.id, w.admin)).added, 0);
      assert.equal(
        (await w.one<{ n: number }>(`SELECT count(*)::int AS n FROM "Notifications" WHERE "schoolId" = $1 AND type = 'CANCELLATION_DIGEST'`, [w.s])).n,
        after.n,
      );
      await w.cleanup();
    });

    await check('(sa-n) a lov entered after the activity: no replacement lesson is written on it again', async () => {
      const w = await world(owner, api, marker, 'n');
      const matte = await w.subject('Matte', 'ANMA', true);
      const temadag = await w.subject('Temadag', 'ANTD', false);
      const k7a = await w.group('AN7A');
      const anna = await w.person('TEACHER', 'Anna');
      await w.person('STUDENT', 'Ella', k7a);
      const monday = nextMonday(w.today);
      const days = [1, 2, 3].map((n) => addDays(monday, n));
      for (const day of days) await w.lesson(day, '08:00', '08:45', matte, k7a, anna);
      const activities = w.activities();
      const body = {
        academicYearId: w.yearId,
        name: 'Prov åk 7A',
        fromDate: days[0],
        toDate: days[2],
        scope: 'GROUPS' as const,
        groupIds: [k7a],
        replacementSubjectId: temadag,
        teachers: [{ studentGroupId: k7a, teacherId: anna.userId!, role: 'LEAD' as const }],
        notify: false,
      };
      const created = await activities.create(body, w.admin);
      assert.equal((await w.replacements(created.activity.id)).length, 3);
      // The school enters a lov on the middle day; the break service deletes the lessons that day that are still
      // scheduled (its replacement lesson), and leaves the cancelled ones.
      await owner.query(
        `INSERT INTO "SchoolBreaks" ("schoolId", "academicYearId", name, "startDate", "endDate", "updatedAt") VALUES ($1, $2, 'Lov', $3::date, $3::date, now())`,
        [w.s, w.yearId, days[1]],
      );
      await owner.query(
        `DELETE FROM "CalendarLessons" WHERE "schoolId" = $1 AND date = $2::date AND status = 'SCHEDULED' AND "startsAt" > now()`,
        [w.s, days[1]],
      );
      assert.deepEqual((await w.replacements(created.activity.id)).map((row) => row.date), [days[0], days[2]]);

      await activities.reapply(created.activity.id, w.admin);
      assert.deepEqual((await w.replacements(created.activity.id)).map((row) => row.date), [days[0], days[2]]);
      await activities.update(created.activity.id, { ...body, name: 'Prov åk 7A (ny)' }, w.admin);
      assert.deepEqual((await w.replacements(created.activity.id)).map((row) => row.date), [days[0], days[2]]);
      const preview = await activities.updatePreview(created.activity.id, body, w.admin);
      assert.equal(preview.replacementLessons, 2);
      await w.cleanup();
    });

    await check('(sa-o) a class deleted since the activity was made does not make it impossible to change', async () => {
      const w = await world(owner, api, marker, 'o');
      const matte = await w.subject('Matte', 'AOMA', true);
      const temadag = await w.subject('Temadag', 'AOTD', false);
      const k7a = await w.group('AO7A');
      const k7b = await w.group('AO7B');
      const anna = await w.person('TEACHER', 'Anna');
      await w.person('STUDENT', 'Ella', k7a);
      await w.person('STUDENT', 'Bea', k7b);
      const tuesday = addDays(nextMonday(w.today), 1);
      await w.lesson(tuesday, '08:00', '08:45', matte, k7a, anna);
      await w.lesson(tuesday, '08:00', '08:45', matte, k7b, anna);
      const activities = w.activities();
      const body = {
        academicYearId: w.yearId,
        name: 'Prov åk 7',
        fromDate: tuesday,
        toDate: tuesday,
        scope: 'GROUPS' as const,
        groupIds: [k7a, k7b],
        replacementSubjectId: temadag,
        teachers: [
          { studentGroupId: k7a, teacherId: anna.userId!, role: 'LEAD' as const },
          { studentGroupId: k7b, teacherId: anna.userId!, role: 'LEAD' as const },
        ],
        notify: false,
      };
      const created = await activities.create(body, w.admin);
      assert.equal(created.replacementLessons, 2);
      // 7B is deleted, with the lessons and the replacement lesson it had (the group's delete does that); the
      // activity keeps naming it, since neither list is a foreign key.
      await owner.query(`DELETE FROM "CalendarLessons" WHERE "studentGroupId" = $1`, [k7b]);
      await owner.query(`DELETE FROM "StudentGroups" WHERE id = $1`, [k7b]);
      assert.deepEqual((await activities.list(w.yearId, w.admin))[0].scopeGroupIds.sort(), [k7a, k7b].sort());
      // The form sends back what the activity stores; the change goes through without the class.
      const preview = await activities.updatePreview(created.activity.id, body, w.admin);
      assert.deepEqual(preview.classes.map((entry) => entry.groupId), [k7a]);
      await activities.update(created.activity.id, { ...body, name: 'Prov åk 7A' }, w.admin);
      const view = (await activities.list(w.yearId, w.admin))[0];
      assert.deepEqual(view.scopeGroupIds, [k7a]);
      assert.deepEqual(view.teachers.map((row) => row.studentGroupId), [k7a]);
      await w.cleanup();
    });
  } finally {
    await sweepScheduleActivityPublicationSchools(owner, marker);
  }
}
