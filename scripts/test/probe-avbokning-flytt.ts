/**
 * The adapter probe's checks for a batch, an activity or an exam planning that is taken back after a DIRECT school's edit of the
 * template moved one of its lessons, through the real services on the API's role and real Postgres as CI runs it. The unit specs
 * (cancellation-core.reverse-plan.spec.ts, cancellation-batches.service.spec.ts, schedule-activities.service.spec.ts) see what the
 * plan and the services decide on a mocked client; what only the database answers is here: which rows stand on the new day when a
 * publication has written one, what the carried row's room and LEAD are, what a lov, a closure or the year's edge leaves, and who
 * is told and what the clients hear of a lesson that came back on another day.
 *
 * The first of them, `pub-d2` in the adapter probe, is the plain case (a batch, a template moved a day, the lesson carried to its new
 * day, a second batch holding it). These are what the review of #319 added:
 *
 *   kf-a  a week-long batch holds both the old and the new day (a publication wrote the new day's row after the template moved,
 *         and the batch took it): the lesson comes back ONCE, where it runs, not twice;
 *   kf-b  the template moved a day and changed room and teacher in the same edit: the carried lesson has the template's room and
 *         LEAD, and the batch says it put the lesson back;
 *   kf-c  the old room is taken at the new hour by another class and the template's room is free: the lesson comes back, in the
 *         template's room;
 *   kf-d  a vikarie holds the lesson: they stay, and no LEAD is written beside them;
 *   kf-e  a lesson moved for its date (an exception: the template was not touched) is put back where it stands, not deleted;
 *   kf-f  an activity that is changed so that it lets a lesson go carries the lesson to the template's slot as a removal does;
 *   kf-g  the template's day is outside the year, or a lov, or a closure of the class: the old row is deleted as before;
 *   kf-h  the digest, the clients and the board hear of a lesson that came back carried, and a batch that still holds the new day
 *         takes it without a digest saying it is back (a batch and an activity's removal, the day held and free).
 *
 * Each in a school of its own (slug <marker>-flytt-<n>), swept whole after, and before the first.
 */
import { strict as assert } from 'node:assert';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { CalendarService } from '../../src/calendar/calendar.service';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import type { PrismaService } from '../../src/database/prisma.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import { CancellationBatchesService } from '../../src/publication/cancellation-batches.service';
import { PublicationsService } from '../../src/publication/publications.service';
import { ScheduleActivitiesService } from '../../src/publication/schedule-activities.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import { StaffingLoadService } from '../../src/staffing/staffing-load.service';
import { TimplanCoverageService } from '../../src/timplan/timplan-coverage.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

const YEAR_START = '2096-08-13';
const YEAR_END = '2097-06-11';
/** Monday to Friday of the week the checks work in (ISO week 45 of 2096). */
const WEEK = ['2096-11-05', '2096-11-09'] as const;

const slugOf = (marker: string, suffix: string) => `${marker}-flytt-${suffix}`;

export async function sweepAvbokningFlyttSchools(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE starts_with(slug, $1)`, [`${marker}-flytt-`]);
}

interface Spy {
  /** What notifyUsers was asked to send. */
  sent: Array<{ type: string; userIds: string[]; meta: Record<string, unknown> }>;
  /** What the clients were told changed, by lesson. */
  lessons: string[][];
  /** What the cover board was told changed, from and to. */
  board: Array<[string, string]>;
}

interface School {
  schoolId: string;
  yearId: string;
  slug: string;
  admin: AuthenticatedUser;
  t1: string;
  t2: string;
  c7a: string;
  c7b: string;
  subject: string;
  subject2: string;
  temadag: string;
  room1: string;
  room2: string;
  /** Monday 08:00-09:00, Sal 1, t1, 7A. */
  m1: string;
  /** Wednesday 10:00-11:00, no room, t1, 7A. */
  m2: string;
}

/** A school with a year, two classes, two teachers, two rooms and two lessons of 7A's, written in the school's own name. */
async function givenSchool(owner: Client, marker: string, suffix: string, opts: { start?: string; end?: string } = {}): Promise<School> {
  const slug = slugOf(marker, suffix);
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [slug]);
  const one = async <T extends object>(sql: string, params: unknown[]): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [slug, slug],
  );
  const person = (role: string, key: string, groupId: string | null = null) =>
    one<{ id: string; authId: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, 'Flytt', $5, $3::"UserRole", gen_random_uuid(), true, $4, now()) RETURNING id, "authId"`,
      [school.id, `${slug}-${key}@example.invalid`, role, groupId, key],
    );
  const admin = await person('SCHOOL_ADMIN', 'admin');
  const t1 = await person('TEACHER', 't1');
  const t2 = await person('TEACHER', 't2');
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
     VALUES ($1, $2, $3, $4, true, 'NIOARIG', now()) RETURNING id`,
    [school.id, slug, opts.start ?? YEAR_START, opts.end ?? YEAR_END],
  );
  const group = (name: string) =>
    one<{ id: string }>(
      `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "updatedAt") VALUES ($1, $2, $3, 7, 'CLASS', now()) RETURNING id`,
      [school.id, year.id, `${slug} ${name}`],
    );
  const g7a = await group('7A');
  const g7b = await group('7B');
  await person('STUDENT', 'p1', g7a.id);
  await person('STUDENT', 'p2', g7a.id);
  await person('STUDENT', 'p3', g7b.id);
  const subject = async (name: string, code: string | null, counts: boolean) =>
    one<{ id: string }>(
      `INSERT INTO "Subjects" ("schoolId", name, code, "countsTowardTimplan", "updatedAt") VALUES ($1, $2, $3, $4, now()) RETURNING id`,
      [school.id, `${slug} ${name}`, code, counts],
    );
  const matte = await subject('matte', null, true);
  const svenska = await subject('svenska', null, true);
  const temadag = await subject('temadag', 'FLTD', false);
  const room = (name: string) =>
    one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, capacity, "updatedAt") VALUES ($1, $2, 30, now()) RETURNING id`, [school.id, `${slug} ${name}`]);
  const room1 = await room('Sal 1');
  const room2 = await room('Sal 2');
  const lesson = (day: number, start: string, end: string, roomId: string | null) =>
    one<{ id: string }>(
      `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::time, $9::time, now()) RETURNING id`,
      [school.id, year.id, matte.id, g7a.id, t1.id, roomId, day, start, end],
    );
  const m1 = await lesson(1, '08:00', '09:00', room1.id);
  const m2 = await lesson(3, '10:00', '11:00', null);
  return {
    schoolId: school.id,
    yearId: year.id,
    slug,
    admin: { authId: admin.authId, userId: admin.id, schoolId: school.id, role: Role.SCHOOL_ADMIN, adminProfile: 'FULL' } as AuthenticatedUser,
    t1: t1.id,
    t2: t2.id,
    c7a: g7a.id,
    c7b: g7b.id,
    subject: matte.id,
    subject2: svenska.id,
    temadag: temadag.id,
    room1: room1.id,
    room2: room2.id,
    m1: m1.id,
    m2: m2.id,
  };
}

/** The school's services, recording what they send and broadcast. */
function servicesOf(api: PrismaService, spy: Spy) {
  const realtime = {
    notifyMasterTimetableChanged: () => undefined,
    notifyLessonChanged: async () => undefined,
    notifyLessonsChanged: async (_tx: unknown, ids: string[]) => {
      spy.lessons.push([...ids]);
    },
    notifyCoverBoardChanged: (_school: string, from: string, to: string) => {
      spy.board.push([from, to]);
    },
  } as unknown as RealtimeService;
  const notifications = {
    recipientsForLessons: async () => [],
    notifyUsers: async (_tx: unknown, input: { type: string; userIds: string[]; meta: Record<string, unknown> }) => {
      spy.sent.push({ type: input.type, userIds: input.userIds, meta: input.meta });
      return input.userIds.length;
    },
  } as unknown as NotificationsService;
  const calendar = new CalendarService(api);
  return {
    masters: new MasterLessonsService(api, realtime, notifications),
    batches: new CancellationBatchesService(api, realtime, notifications),
    activities: new ScheduleActivitiesService(api, realtime, notifications),
    publications: new PublicationsService(api, calendar, new TimplanCoverageService(api), new StaffingLoadService(api), notifications, realtime),
  };
}

type Services = ReturnType<typeof servicesOf>;
interface Fixture extends Services {
  owner: Client;
  fx: School;
  spy: Spy;
  /** A publication of the whole year, which writes the rows the template lacks (it only creates). */
  publish: () => Promise<void>;
  /** A batch for 7A (or the classes given) over the days, made and returned as the service answers it. */
  batch: (name: string, from: string, to: string, extra?: { groups?: string[]; notify?: boolean }) => Promise<{ batch: { id: string; cancelled: number } }>;
  /** The rows of a lesson (or all) over the days, as "date weekday from-to STATUS[/cause] room [teachers]". */
  week: (master: string | null, from?: string, to?: string) => Promise<string[]>;
}

/** Runs a body in a school of its own and sweeps the school after. */
async function inSchool(
  owner: Client,
  api: PrismaService,
  marker: string,
  suffix: string,
  body: (fixture: Fixture) => Promise<void>,
  opts: { start?: string; end?: string } = {},
): Promise<void> {
  const fx = await givenSchool(owner, marker, suffix, opts);
  const spy: Spy = { sent: [], lessons: [], board: [] };
  const services = servicesOf(api, spy);
  const fixture: Fixture = {
    ...services,
    owner,
    fx,
    spy,
    publish: async () => {
      await services.publications.legacyPublish({ academicYearId: fx.yearId, fromDate: opts.start ?? YEAR_START }, fx.admin);
    },
    batch: async (name, from, to, extra = {}) => {
      const selection = {
        academicYearId: fx.yearId,
        name,
        cause: 'EVENT' as const,
        fromDate: from,
        toDate: to,
        scope: 'GROUPS' as const,
        groupIds: extra.groups ?? [fx.c7a],
        ...(extra.notify ? { notify: true } : {}),
      };
      return services.batches.create({ ...selection, expectedDigest: (await services.batches.preview(selection, fx.admin)).digest }, fx.admin);
    },
    week: async (master, from = WEEK[0], to = WEEK[1]) => {
      const rows = await owner.query<{
        d: string;
        s: string;
        e: string;
        st: string;
        cause: string | null;
        room: string | null;
        teachers: string | null;
      }>(
        `SELECT cl.date::text AS d, to_char(cl."startsAt" AT TIME ZONE 'Europe/Stockholm', 'Dy HH24:MI') AS s,
                to_char(cl."endsAt" AT TIME ZONE 'Europe/Stockholm', 'HH24:MI') AS e, cl.status::text AS st, cl."cancelCause"::text AS cause,
                r.name AS room,
                (SELECT string_agg(left(u."lastName", 3) || ':' || t.role::text, ',' ORDER BY u."lastName")
                   FROM "CalendarLessonTeachers" t JOIN "Users" u ON u.id = t."teacherId" WHERE t."calendarLessonId" = cl.id) AS teachers
           FROM "CalendarLessons" cl LEFT JOIN "Rooms" r ON r.id = cl."roomId"
          WHERE cl."schoolId" = $1 AND ($2::uuid IS NULL OR cl."masterLessonId" = $2) AND cl.date BETWEEN $3 AND $4
          ORDER BY cl.date, cl."startsAt", cl.id`,
        [fx.schoolId, master, from, to],
      );
      return rows.rows.map(
        (row) =>
          `${row.d} ${row.s}-${row.e} ${row.st}${row.cause ? `/${row.cause}` : ''}${row.room ? ` ${row.room.replace(`${fx.slug} `, '')}` : ''}${row.teachers ? ` [${row.teachers}]` : ''}`,
      );
    },
  };
  try {
    await body(fixture);
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [fx.slug]);
  }
}

const moved = (list: ReadonlyArray<{ from: string; to: string }>) => list.map((move) => [move.from, move.to]);

/** A row without its room and teachers, and without the cause of a cancellation: "2096-11-05 Mon 08:00-09:00 CANCELLED". */
const head = (row: string): string => row.split(' ').slice(0, 4).join(' ').replace(/\/EVENT$/, '');

export async function avbokningFlyttChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepAvbokningFlyttSchools(owner, marker);
  const run = (suffix: string, body: (fixture: Fixture) => Promise<void>, opts: { start?: string; end?: string } = {}) =>
    inSchool(owner, api, marker, suffix, body, opts);

  await check('(kf-a) a week-long avbokning that holds both the old and the new day of a moved lesson gives it back once', async () => {
    await run('a', async (s) => {
      await s.publish();
      const made = await s.batch('Prao mån–tis', '2096-11-05', '2096-11-06');
      // Monday 08:00 → Tuesday 08:00; the edit writes no Tuesday row and cannot carry the cancelled Monday one.
      await s.masters.update(s.fx.m1, { dayOfWeek: 2 }, s.fx.admin);
      assert.deepEqual(await s.week(s.fx.m1), ['2096-11-05 Mon 08:00-09:00 CANCELLED/EVENT Sal 1 [t1:LEAD]']);
      // A publication writes Tuesday's row, which the batch takes (S7): the batch holds the old day and the new.
      await s.publish();
      assert.deepEqual((await s.week(s.fx.m1)).map(head), ['2096-11-05 Mon 08:00-09:00 CANCELLED', '2096-11-06 Tue 08:00-09:00 CANCELLED']);
      // The Tuesday row already runs at the template and comes back where it stands; the Monday row is the old slot's and goes.
      const preview = await s.batches.reversePreview(made.batch.id, s.fx.admin);
      assert.equal(preview.reinstate, 1);
      assert.deepEqual(preview.relocated, []);
      assert.deepEqual(preview.removedTemplateMoved.map((entry) => entry.date), ['2096-11-05']);
      await s.batches.reverse(made.batch.id, s.fx.admin);
      assert.deepEqual(await s.week(s.fx.m1), ['2096-11-06 Tue 08:00-09:00 SCHEDULED Sal 1 [t1:LEAD]']);
    });
  });

  await check('(kf-b) the carried lesson has the template\'s room and LEAD, and the batch says it put the lesson back', async () => {
    await run('b', async (s) => {
      await s.publish();
      const made = await s.batch('Prao', '2096-11-05', '2096-11-05');
      await s.masters.update(s.fx.m1, { dayOfWeek: 2, roomId: s.fx.room2, teacherId: s.fx.t2 }, s.fx.admin);
      // The edit carries the weeks it can: next week's lesson is Tuesday in Sal 2 with t2.
      assert.deepEqual(await s.week(s.fx.m1, '2096-11-12', '2096-11-16'), ['2096-11-13 Tue 08:00-09:00 SCHEDULED Sal 2 [t2:LEAD]']);
      const preview = await s.batches.reversePreview(made.batch.id, s.fx.admin);
      assert.deepEqual([preview.reinstate, moved(preview.relocated)], [0, [['2096-11-05', '2096-11-06']]]);
      await s.batches.reverse(made.batch.id, s.fx.admin);
      // The same as the weeks the edit carried: Sal 2 and t2, not the Sal 1 and t1 the cancelled row had.
      assert.deepEqual(await s.week(s.fx.m1), ['2096-11-06 Tue 08:00-09:00 SCHEDULED Sal 2 [t2:LEAD]']);
      const stored = await owner.query<{ reinstated: number }>(`SELECT reinstated FROM "CancellationBatches" WHERE id = $1`, [made.batch.id]);
      assert.equal(stored.rows[0]!.reinstated, 1, 'a lesson carried to its new day is a lesson that came back');
    });
  });

  await check('(kf-c) the lesson comes back when the old room is taken at the new hour and the template\'s room is free', async () => {
    await run('c', async (s) => {
      // 7B has Sal 1 on Tuesday 08:00, the hour 7A's lesson is going to.
      const other = await owner.query<{ id: string }>(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, 2, '08:00', '09:00', now()) RETURNING id`,
        [s.fx.schoolId, s.fx.yearId, s.fx.subject2, s.fx.c7b, s.fx.t2, s.fx.room1],
      );
      assert.ok(other.rows[0]);
      await s.publish();
      const made = await s.batch('Prao', '2096-11-05', '2096-11-05');
      await s.masters.update(s.fx.m1, { dayOfWeek: 2, roomId: s.fx.room2 }, s.fx.admin);
      const preview = await s.batches.reversePreview(made.batch.id, s.fx.admin);
      assert.deepEqual(preview.skippedRoomTaken, [], 'Sal 1 is 7B\'s then, but the lesson is in Sal 2');
      assert.deepEqual(moved(preview.relocated), [['2096-11-05', '2096-11-06']]);
      await s.batches.reverse(made.batch.id, s.fx.admin);
      assert.deepEqual(await s.week(s.fx.m1), ['2096-11-06 Tue 08:00-09:00 SCHEDULED Sal 2 [t1:LEAD]']);
    });
  });

  await check('(kf-d) a vikarie who holds the lesson stays on it, and no LEAD is written beside them', async () => {
    // First the template keeps its teacher (t1: a LEAD written beside the vikarie would be two people on a lesson one holds), then it
    // is given the vikarie as its teacher (the unique key on the lesson's teachers would refuse a second row for them).
    for (const [suffix, edit] of [
      ['d1', (_s: Fixture) => ({ dayOfWeek: 2 })],
      ['d2', (s: Fixture) => ({ dayOfWeek: 2, teacherId: s.fx.t2 })],
    ] as const) {
      await run(suffix, async (s) => {
        await s.publish();
        // t1 is away on Monday: the lesson's rows are replaced by the vikarie's (assignSubstitute).
        await owner.query(
          `DELETE FROM "CalendarLessonTeachers" WHERE "calendarLessonId" IN (SELECT id FROM "CalendarLessons" WHERE "masterLessonId" = $1 AND date = '2096-11-05')`,
          [s.fx.m1],
        );
        await owner.query(
          `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role)
           SELECT $1, id, $3, 'SUBSTITUTE' FROM "CalendarLessons" WHERE "masterLessonId" = $2 AND date = '2096-11-05'`,
          [s.fx.schoolId, s.fx.m1, s.fx.t2],
        );
        const made = await s.batch('Prao', '2096-11-05', '2096-11-05');
        await s.masters.update(s.fx.m1, edit(s), s.fx.admin);
        await s.batches.reverse(made.batch.id, s.fx.admin);
        assert.deepEqual(await s.week(s.fx.m1), ['2096-11-06 Tue 08:00-09:00 SCHEDULED Sal 1 [t2:SUBSTITUTE]']);
      });
    }
  });

  await check('(kf-e) a lesson moved for its date, whose template was not touched, is put back where it stands and not deleted', async () => {
    await run('e', async (s) => {
      await s.publish();
      // The class teacher's move of Monday's lesson to Thursday 14:00: the row keeps its master and its other fields.
      await owner.query(
        `UPDATE "CalendarLessons"
            SET date = '2096-11-08', "startsAt" = ('2096-11-08 14:00'::timestamp AT TIME ZONE 'Europe/Stockholm'),
                "endsAt" = ('2096-11-08 15:00'::timestamp AT TIME ZONE 'Europe/Stockholm')
          WHERE "masterLessonId" = $1 AND date = '2096-11-05'`,
        [s.fx.m1],
      );
      const made = await s.batch('Prao tor', '2096-11-08', '2096-11-08');
      assert.deepEqual(await s.week(s.fx.m1), ['2096-11-08 Thu 14:00-15:00 CANCELLED/EVENT Sal 1 [t1:LEAD]']);
      const preview = await s.batches.reversePreview(made.batch.id, s.fx.admin);
      assert.deepEqual([preview.reinstate, preview.relocated, preview.removedTemplateMoved], [1, [], []]);
      await s.batches.reverse(made.batch.id, s.fx.admin);
      assert.deepEqual(await s.week(s.fx.m1), ['2096-11-08 Thu 14:00-15:00 SCHEDULED Sal 1 [t1:LEAD]']);
    });
  });

  await check('(kf-f) an activity changed to let a lesson go carries it to the template\'s slot, as a removal does', async () => {
    await run('f', async (s) => {
      await s.publish();
      const body = (from: string, to: string) => ({
        academicYearId: s.fx.yearId,
        name: 'Temadag 7A',
        fromDate: from,
        toDate: to,
        scope: 'GROUPS' as const,
        groupIds: [s.fx.c7a],
        replacementSubjectId: s.fx.temadag,
        description: 'Samling',
        teachers: [{ studentGroupId: s.fx.c7a, teacherId: s.fx.t1 }],
        credits: [],
        notify: false,
      });
      // Monday and Wednesday, then the template's Monday goes to Tuesday, and the activity is changed to Wednesday only.
      const made = await s.activities.create(body('2096-11-05', '2096-11-07'), s.fx.admin);
      await s.masters.update(s.fx.m1, { dayOfWeek: 2 }, s.fx.admin);
      assert.deepEqual(await s.week(s.fx.m1), ['2096-11-05 Mon 08:00-09:00 CANCELLED/EVENT Sal 1 [t1:LEAD]']);
      const changed = await s.activities.update(made.activity.id, body('2096-11-07', '2096-11-07'), s.fx.admin);
      assert.equal(changed.released, 1, 'the lesson the new description lets go is back');
      assert.deepEqual(await s.week(s.fx.m1), ['2096-11-06 Tue 08:00-09:00 SCHEDULED Sal 1 [t1:LEAD]']);
      // Wednesday's lesson is still the activity's.
      assert.deepEqual(await s.week(s.fx.m2, '2096-11-07', '2096-11-07'), ['2096-11-07 Wed 10:00-11:00 CANCELLED/EVENT [t1:LEAD]']);
    });
  });

  for (const [suffix, why, opts, setup] of [
    ['g1', 'after the last day of the year', { end: '2096-11-07' }, async (_s: Fixture) => undefined],
    ['g2', 'before the first day of the year', { start: '2096-11-07' }, async (_s: Fixture) => undefined],
    [
      'g3',
      'on a lov',
      {},
      async (s: Fixture) => {
        await owner.query(
          `INSERT INTO "SchoolBreaks" ("schoolId", "academicYearId", name, kind, "startDate", "endDate", "updatedAt")
           VALUES ($1, $2, 'Studiedag', 'HOLIDAY', '2096-11-09', '2096-11-09', now())`,
          [s.fx.schoolId, s.fx.yearId],
        );
      },
    ],
  ] as const) {
    await check(`(kf-${suffix}) a lesson whose template's new day lies ${why} is deleted as before, not carried there`, async () => {
      await run(
        suffix,
        async (s) => {
          await s.publish();
          await setup(s);
          // Before the year starts the lesson is Wednesday's (the year begins on that Wednesday), else Monday's, and the template goes to
          // the day outside: Monday for the first, Friday for the others.
          const [master, day] = suffix === 'g2' ? [s.fx.m2, 1] : [s.fx.m1, 5];
          const date = suffix === 'g2' ? '2096-11-07' : '2096-11-05';
          const made = await s.batch('Prao', date, date);
          await s.masters.update(master, { dayOfWeek: day }, s.fx.admin);
          const preview = await s.batches.reversePreview(made.batch.id, s.fx.admin);
          assert.deepEqual(preview.relocated, [], 'a publication would not write the lesson there');
          assert.deepEqual(preview.removedTemplateMoved.map((entry) => entry.date), [date]);
          await s.batches.reverse(made.batch.id, s.fx.admin);
          assert.deepEqual(await s.week(master), []);
        },
        opts,
      );
    });
  }

  // The digest, the clients and the board: a batch and an activity's removal, with the new day held by another batch and free.
  for (const [mode, held] of [
    ['batch', false],
    ['batch', true],
    ['activity', false],
    ['activity', true],
  ] as const) {
    await check(`(kf-h) a ${mode} taken back tells of the lesson it carried to a ${held ? 'held' : 'free'} day, and the clients and the board hear of it`, async () => {
      await run(`h-${mode}-${held ? 'held' : 'free'}`, async (s) => {
        await s.publish();
        let batchId = '';
        let activityId = '';
        if (mode === 'batch') {
          batchId = (await s.batch('Prao åk 7', '2096-11-05', '2096-11-05', { notify: true })).batch.id;
        } else {
          const made = await s.activities.create(
            {
              academicYearId: s.fx.yearId,
              name: 'Temadag',
              fromDate: '2096-11-05',
              toDate: '2096-11-05',
              scope: 'GROUPS',
              groupIds: [s.fx.c7a],
              replacementSubjectId: s.fx.temadag,
              description: 'Samling',
              teachers: [{ studentGroupId: s.fx.c7a, teacherId: s.fx.t1 }],
              credits: [],
              notify: true,
            },
            s.fx.admin,
          );
          activityId = made.activity.id;
        }
        await s.masters.update(s.fx.m1, { dayOfWeek: 2 }, s.fx.admin);
        // Another batch holds Tuesday and Wednesday: it takes what it finds, and the carried lesson when it lands there (S7).
        if (held) await s.batch('Studiedag tis–ons', '2096-11-06', '2096-11-07');
        s.spy.sent.length = 0;
        s.spy.lessons.length = 0;
        s.spy.board.length = 0;
        const preview = mode === 'batch' ? await s.batches.reversePreview(batchId, s.fx.admin) : await s.activities.removePreview(activityId, s.fx.admin);
        assert.deepEqual(moved(preview.relocated), [['2096-11-05', '2096-11-06']]);
        // The preview sends nothing.
        assert.equal(s.spy.sent.length, 0);
        const result = mode === 'batch' ? await s.batches.reverse(batchId, s.fx.admin) : await s.activities.remove(activityId, s.fx.admin);
        assert.deepEqual(moved(result.relocated), [['2096-11-05', '2096-11-06']]);
        const carried = result.relocated[0]!.lessonId;
        const digests = s.spy.sent.filter((entry) => entry.type === 'CANCELLATION_DIGEST');
        if (held) {
          // The other batch took the lesson at once: it is cancelled again, and nobody is told it is back.
          assert.equal(digests.length, 0);
          assert.equal(result.notify, 0);
          assert.deepEqual((await s.week(s.fx.m1)).map(head), ['2096-11-06 Tue 08:00-09:00 CANCELLED']);
        } else {
          // Told as when it was made: one digest to the two pupils and the teacher, naming the new day and saying it is a reversal.
          assert.equal(digests.length, 1);
          assert.equal(digests[0]!.userIds.length, 3);
          assert.deepEqual(
            [digests[0]!.meta['lessonCount'], digests[0]!.meta['startDate'], digests[0]!.meta['endDate'], digests[0]!.meta['reversed']],
            [1, '2096-11-06', '2096-11-06', true],
          );
          assert.equal(result.notify, 3);
          assert.deepEqual(await s.week(s.fx.m1), ['2096-11-06 Tue 08:00-09:00 SCHEDULED Sal 1 [t1:LEAD]']);
        }
        // The clients hear of the lesson either way (it changed, and may have changed twice), and the board of the old day and the new.
        assert.ok(s.spy.lessons.some((ids) => ids.includes(carried)), 'the clients hear of the carried lesson');
        assert.ok(s.spy.board.some(([from, to]) => from <= '2096-11-05' && to >= '2096-11-06'), 'the board hears of both days');
      });
    });
  }
}
