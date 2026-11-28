/**
 * En återställning i Direkt lämnar inga föräldralösa publicerade lektioner (E9, g520 M-3) against a real database, as the API role under RLS,
 * through the real services.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=2' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-aterstallning-direkt.ts
 *
 * A restore deletes the year's master lessons and makes the version's anew, under new ids. CalendarLessons.masterLessonId is ON DELETE SET NULL,
 * and a publication keys on (masterLessonId, date), so in Direkt every published lesson stood on as an orphan after a restore and the next
 * publication laid the same week out again: six lessons became twelve, two on every time. The jest specs hold the pairing of lessons and
 * the order of the writes on a faked client (restore-calendar.spec.ts, schedule-versions.service.spec.ts); what only a database can say is
 * what the calendar looks like afterwards and that a refused restore left everything as it was.
 *
 *   (ra) a restore in Direkt of a version of the published grundschema, then a publication: the school has as many published lessons as the
 *        grundschema gives, and not twice as many (before: 130 became 260, two lessons on every time);
 *   (rb) the same, with the rows looked at: no orphan, the same rows, under the restored lessons;
 *   (rc) a vikarie, a changed room and a note on published lessons the version holds unchanged follow them over: the same rows, the same
 *        vikarie, and the next publication adds nothing;
 *   (rd) a version of an earlier grundschema (another lesson on another day, saved by hand): the lessons it changes lose their future rows, the
 *        count says how many and how many somebody had worked on by hand, and the next publication gives the calendar the grundschema has;
 *   (ri) every kind of hand work on a published lesson that goes with it is counted in what the restore says it took: a vikarie, a note on the
 *        row, another room, a lesson log, a note to the substitute, a pupil moved to the lesson for the day, a decision on a teacher's absence;
 *   (re) the school has not answered the question of Direkt: the restore is refused 409 DIRECT_REACH_UNANSWERED with what it would take, and
 *        the lessons, the calendar and the versions are as they were; once the school has answered it goes through;
 *   (rf) a lesson that has already happened is not touched: a past row of a lesson the restore replaces stays and is an orphan, as when a hand
 *        edit removes a lesson;
 *   (rg) in utkast the restore writes no calendar row, and a school with nothing published is asked nothing;
 *   (rh) a publication of a later window that is inserting rows under the old lessons while the restore is at its last statement is
 *        waited for: no row of it is stranded (before: every row of the window was an orphan and the next publication doubled it).
 *
 * Each in a school of its own (slug <marker>-<n>), swept whole after, and before the first. The year is in 2096, so every day of it lies ahead.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { CalendarService } from '../../src/calendar/calendar.service';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { ScheduleVersionsService } from '../../src/calendar/schedule-versions.service';
import { createPgAdapter } from '../../src/database/pool-config';
import { PrismaService } from '../../src/database/prisma.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import { DirectReachService } from '../../src/publication/direct-reach.service';
import { DraftService } from '../../src/publication/draft.service';
import { PublicationsService } from '../../src/publication/publications.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import { StaffingLoadService } from '../../src/staffing/staffing-load.service';
import { TimplanCoverageService } from '../../src/timplan/timplan-coverage.service';

type Owner = PrismaClient;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

let failures = 0;
async function check(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}\n     ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const MARKER = 'probe-aterstallning';
const YEAR_START = '2096-08-13';
const YEAR_END = '2097-06-11';
const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

interface School {
  schoolId: string;
  yearId: string;
  admin: AuthenticatedUser;
  /** Monday 08:00-09:00 in a room, Wednesday 10:00-11:00 and Friday 13:00-14:00 (T2), all of 7A. */
  monday: string;
  wednesday: string;
  friday: string;
  teacherId: string;
  secondTeacherId: string;
  groupId: string;
  subjectId: string;
  roomId: string;
}

async function givenSchool(owner: Owner, suffix: string): Promise<School> {
  const slug = `${MARKER}-${suffix}`;
  await owner.school.deleteMany({ where: { slug } });
  const school = await owner.school.create({ data: { name: slug, slug, timezone: 'Europe/Stockholm' } });
  const person = (key: string, role: 'SCHOOL_ADMIN' | 'TEACHER', extra: Record<string, unknown> = {}) =>
    owner.user.create({
      data: { schoolId: school.id, authId: randomUUID(), role, firstName: key, lastName: 'Aterstall', email: `${key.toLowerCase()}-${slug}@probe.example.com`, ...extra },
    });
  const admin = await person('Admin', 'SCHOOL_ADMIN', { adminProfile: 'FULL' });
  const teacher = await person('T1', 'TEACHER');
  const second = await person('T2', 'TEACHER');
  const year = await owner.academicYear.create({
    data: { schoolId: school.id, name: slug, startDate: new Date(YEAR_START), endDate: new Date(YEAR_END), gradeNumbering: 'NIOARIG', isActive: true },
  });
  const group = await owner.studentGroup.create({ data: { schoolId: school.id, academicYearId: year.id, name: `${slug} 7A`, kind: 'CLASS', gradeLevel: 7 } });
  const subject = await owner.subject.create({ data: { schoolId: school.id, name: `${slug} matte` } });
  const room = await owner.room.create({ data: { schoolId: school.id, name: `${slug} sal 1`, capacity: 30 } });
  const lesson = (dayOfWeek: number, start: string, end: string, teacherId: string, roomId: string | null) =>
    owner.masterLesson.create({
      data: { schoolId: school.id, academicYearId: year.id, subjectId: subject.id, studentGroupId: group.id, teacherId, roomId, dayOfWeek, startTime: time(start), endTime: time(end) },
    });
  const monday = await lesson(1, '08:00', '09:00', teacher.id, room.id);
  const wednesday = await lesson(3, '10:00', '11:00', teacher.id, null);
  const friday = await lesson(5, '13:00', '14:00', second.id, null);
  return {
    schoolId: school.id,
    yearId: year.id,
    admin: { authId: admin.authId, userId: admin.id, schoolId: school.id, role: Role.SCHOOL_ADMIN, adminProfile: 'FULL', hrRead: false, channel: 'OTHER' },
    monday: monday.id,
    wednesday: wednesday.id,
    friday: friday.id,
    teacherId: teacher.id,
    secondTeacherId: second.id,
    groupId: group.id,
    subjectId: subject.id,
    roomId: room.id,
  };
}

function servicesOf(api: PrismaService) {
  const realtime = { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService;
  const notifications = { recipientsForLessons: async () => [randomUUID()], notifyUsers: async () => 1 } as unknown as NotificationsService;
  const calendar = new CalendarService(api);
  const versions = new ScheduleVersionsService(api);
  // Built through a loose constructor type: PublicationsService takes the version service as a seventh argument once a publication leaves a
  // version (E9, #520), and the sixth-argument form of before is read the same. Either build of the class takes what it takes and ignores the rest.
  const Publications = PublicationsService as unknown as new (...args: unknown[]) => PublicationsService;
  return {
    versions,
    masters: new MasterLessonsService(api, realtime, notifications),
    publications: new Publications(api, calendar, new TimplanCoverageService(api), new StaffingLoadService(api), notifications, realtime, versions),
    drafts: new DraftService(api, calendar, versions, realtime),
    reach: new DirectReachService(api),
  };
}

const refusalOf = async (attempt: Promise<unknown>): Promise<{ code?: string; params?: Record<string, unknown> }> => {
  try {
    await attempt;
  } catch (error) {
    assert.ok(error instanceof HttpException, `not an HttpException: ${String(error)}`);
    assert.equal(error.getStatus(), 409);
    return error.getResponse() as { code?: string; params?: Record<string, unknown> };
  }
  throw new Error('the restore was not refused');
};

async function main(): Promise<void> {
  const owner = new PrismaClient({ adapter: createPgAdapter(requiredEnv('PROBE_OWNER_URL')) });
  const previous = process.env['DATABASE_URL'];
  const api = new PrismaService();
  process.env['DATABASE_URL'] = previous;

  const sweep = async () => {
    await owner.school.deleteMany({ where: { slug: { startsWith: `${MARKER}-` } } });
  };
  const inSchool = async (suffix: string, body: (s: School, svc: ReturnType<typeof servicesOf>) => Promise<void>) => {
    await body(await givenSchool(owner, suffix), servicesOf(api));
  };
  const publish = (s: School, svc: ReturnType<typeof servicesOf>) => svc.publications.legacyPublish({ academicYearId: s.yearId, fromDate: YEAR_START }, s.admin);

  /** The school's calendar rows: the ones a master lesson of the year holds, and the orphans (rows with no master lesson). */
  const calendarOf = async (s: School) => {
    const rows = await owner.calendarLesson.findMany({
      where: { schoolId: s.schoolId },
      select: { id: true, masterLessonId: true, date: true, roomId: true, note: true, teachers: { select: { role: true, teacherId: true } } },
      orderBy: [{ date: 'asc' }, { startsAt: 'asc' }],
    });
    return { rows, orphans: rows.filter((row) => row.masterLessonId === null) };
  };
  const mastersOf = async (s: School) => (await owner.masterLesson.findMany({ where: { academicYearId: s.yearId }, select: { id: true }, orderBy: { id: 'asc' } })).map((row) => row.id);
  /** What a publication of the grundschema gives: one row per date the lesson's weekday has in the year, for each lesson. */
  const rowsPerWeekday = async (s: School) => {
    const days = await owner.$queryRaw<Array<{ dow: number; n: bigint }>>`
      SELECT EXTRACT(ISODOW FROM d)::int AS dow, count(*) AS n FROM generate_series(${YEAR_START}::date, ${YEAR_END}::date, '1 day') d GROUP BY 1`;
    void s;
    return new Map(days.map((row) => [row.dow, Number(row.n)]));
  };
  const expectedRows = async (s: School) => {
    const perDay = await rowsPerWeekday(s);
    const lessons = await owner.masterLesson.findMany({ where: { academicYearId: s.yearId }, select: { dayOfWeek: true } });
    return lessons.reduce((sum, lesson) => sum + (perDay.get(lesson.dayOfWeek) ?? 0), 0);
  };
  /** A vikarie on one published lesson: the other teacher of the school than the one who has it. */
  const substitute = async (rowId: string, s: School, teacherId: string = s.secondTeacherId) =>
    owner.calendarLessonTeacher.create({ data: { schoolId: s.schoolId, calendarLessonId: rowId, teacherId, role: 'SUBSTITUTE' } });

  await sweep();
  try {
    await check('(ra) a restore in Direkt, then a publication: as many published lessons as the grundschema gives', async () => {
      await inSchool('a', async (s, svc) => {
        await publish(s, svc);
        const version = await svc.versions.create(s.yearId, 'efter publiceringen', s.admin);
        const expected = await expectedRows(s);
        assert.equal((await calendarOf(s)).rows.length, expected);
        await svc.versions.restore(version.id, s.admin);
        await publish(s, svc);
        assert.equal((await calendarOf(s)).rows.length, expected, 'the calendar has the lessons the grundschema gives, not those and the restored ones beside them');
      });
    });

    await check('(rb) a restore of the published grundschema, then a publication: the lessons the grundschema gives, once each, no orphan', async () => {
      await inSchool('b', async (s, svc) => {
        await publish(s, svc);
        const version = await svc.versions.create(s.yearId, 'efter publiceringen', s.admin);
        const before = await calendarOf(s);
        assert.equal(before.rows.length, await expectedRows(s), 'the first publication wrote what the grundschema gives');
        assert.equal(before.orphans.length, 0);
        const masterIdsBefore = await mastersOf(s);

        const restored = await svc.versions.restore(version.id, s.admin);
        assert.equal(restored.restoredLessons, 3);
        const masterIdsAfter = await mastersOf(s);
        assert.equal(masterIdsAfter.filter((id) => masterIdsBefore.includes(id)).length, 0, 'the restore made the lessons anew');
        const mid = await calendarOf(s);
        assert.equal(mid.orphans.length, 0, 'no published lesson is left without its lesson');
        assert.deepEqual(mid.rows.map((row) => row.id).sort(), before.rows.map((row) => row.id).sort(), 'the same rows');
        assert.ok(mid.rows.every((row) => masterIdsAfter.includes(row.masterLessonId!)), 'each stands under a lesson of the restored grundschema');

        await publish(s, svc);
        const after = await calendarOf(s);
        assert.equal(after.rows.length, await expectedRows(s), 'a publication after the restore adds nothing to what the grundschema gives');
        assert.equal(after.orphans.length, 0);
        const perSlot = new Map<string, number>();
        for (const row of after.rows) perSlot.set(`${row.date.toISOString()}`, (perSlot.get(`${row.date.toISOString()}`) ?? 0) + 1);
        assert.ok([...perSlot.values()].every((n) => n === 1), 'one lesson on every day, not two');
        assert.deepEqual(restored.calendar, { kept: before.rows.length, removed: 0, handChanged: 0 }, 'the restore says every row went with its lesson to the restored one');
      });
    });

    await check('(rc) a vikarie, a changed room and a note on a lesson the version holds unchanged follow it over', async () => {
      await inSchool('c', async (s, svc) => {
        await publish(s, svc);
        const version = await svc.versions.create(s.yearId, 'före', s.admin);
        const monday = (await calendarOf(s)).rows.filter((row) => row.masterLessonId === s.monday);
        const wednesday = (await calendarOf(s)).rows.filter((row) => row.masterLessonId === s.wednesday);
        await substitute(monday[0]!.id, s);
        const otherRoom = await owner.room.create({ data: { schoolId: s.schoolId, name: 'sal 2', capacity: 20 } });
        await owner.calendarLesson.update({ where: { id: monday[1]!.id }, data: { roomId: otherRoom.id } });
        await owner.calendarLesson.update({ where: { id: wednesday[0]!.id }, data: { note: 'Prov i dag' } });

        const restored = await svc.versions.restore(version.id, s.admin);
        const after = await calendarOf(s);
        assert.equal(after.orphans.length, 0);
        const byId = new Map(after.rows.map((row) => [row.id, row]));
        assert.ok(byId.get(monday[0]!.id)!.teachers.some((teacher) => teacher.role === 'SUBSTITUTE'), 'the vikarie is still on the lesson');
        assert.equal(byId.get(monday[1]!.id)!.roomId, otherRoom.id, 'the room the lesson was moved to for a day is still its room');
        assert.equal(byId.get(wednesday[0]!.id)!.note, 'Prov i dag');
        const mastersNow = await mastersOf(s);
        assert.ok(byId.get(monday[0]!.id)!.masterLessonId && mastersNow.includes(byId.get(monday[0]!.id)!.masterLessonId!), 'and stands under the restored lesson');
        await publish(s, svc);
        assert.equal((await calendarOf(s)).rows.length, await expectedRows(s), 'the next publication adds nothing');
        assert.deepEqual([restored.calendar?.removed, restored.calendar?.handChanged], [0, 0], 'the restore says nothing the school had worked on was taken');
      });
    });

    await check('(rd) a version of an earlier grundschema: what it changes loses its future rows, and the next publication gives what the grundschema has', async () => {
      await inSchool('d', async (s, svc) => {
        // An earlier grundschema, saved by hand: the Friday lesson was a Thursday.
        await owner.masterLesson.update({ where: { id: s.friday }, data: { dayOfWeek: 4 } });
        const earlier = await svc.versions.create(s.yearId, 'när fredagen var en torsdag', s.admin);
        await owner.masterLesson.update({ where: { id: s.friday }, data: { dayOfWeek: 5 } });
        await publish(s, svc);
        const published = await calendarOf(s);
        const fridays = published.rows.filter((row) => row.masterLessonId === s.friday);
        assert.ok(fridays.length > 0);
        await substitute(fridays[0]!.id, s, s.teacherId);
        await owner.calendarLesson.update({ where: { id: fridays[1]!.id }, data: { note: 'Gäst' } });
        // The school has answered, so the restore is not stopped by the question; the count says what it took.
        await svc.reach.acknowledge(s.admin);

        const restored = await svc.versions.restore(earlier.id, s.admin);
        const mid = await calendarOf(s);
        assert.equal(mid.orphans.length, 0);
        assert.equal(mid.rows.length, published.rows.length - fridays.length);

        await publish(s, svc);
        const after = await calendarOf(s);
        assert.equal(after.rows.length, await expectedRows(s), 'the calendar has the grundschema the version holds: its Thursday');
        assert.equal(after.orphans.length, 0);
        const days = new Set(after.rows.map((row) => row.date.getUTCDay()));
        assert.ok(days.has(4) && !days.has(5), 'a Thursday lesson and no Friday lesson');
        assert.equal(restored.calendar?.removed, fridays.length, 'the restore says the Friday rows went');
        assert.equal(restored.calendar?.handChanged, 2, 'and that two of them had a vikarie or a note: the school is told');
        assert.equal(restored.calendar?.kept, published.rows.length - fridays.length, 'and that Monday and Wednesday stayed');
      });
    });

    await check('(re) before the school has answered the restore is refused with what it would take, and everything is as it was; after the answer it goes', async () => {
      await inSchool('e', async (s, svc) => {
        await publish(s, svc);
        const version = await svc.versions.create(s.yearId, 'före', s.admin);
        // The grundschema moves on without the calendar following (a draft edit written straight to the table): the Monday lesson has another teacher.
        await owner.masterLesson.update({ where: { id: s.monday }, data: { teacherId: s.secondTeacherId } });
        const mondays = (await calendarOf(s)).rows.filter((row) => row.masterLessonId === s.monday);
        await substitute(mondays[0]!.id, s);
        const standing = async () => ({
          masters: await mastersOf(s),
          calendar: (await calendarOf(s)).rows.map((row) => `${row.id}:${row.masterLessonId}`).sort(),
          versions: await owner.scheduleVersion.count({ where: { academicYearId: s.yearId } }),
          log: await owner.scheduleChangeLog.count({ where: { academicYearId: s.yearId, action: 'RESTORE' } }),
        });
        const before = await standing();

        const refusal = await refusalOf(svc.versions.restore(version.id, s.admin));
        assert.equal(refusal.code, 'DIRECT_REACH_UNANSWERED');
        assert.deepEqual(refusal.params, { validFrom: YEAR_START, validTo: YEAR_END, removed: mondays.length, handChanged: 1 });
        assert.deepEqual(await standing(), before, 'the lessons, the calendar, the versions and the log are as they were: nothing was written, not even the safety version');

        await svc.reach.acknowledge(s.admin);
        const restored = await svc.versions.restore(version.id, s.admin);
        assert.equal(restored.calendar?.removed, mondays.length);
        assert.equal((await standing()).versions, before.versions + 1, 'now the safety version is there');
      });
    });

    await check('(ri) the restore counts each kind of hand work on a row it takes: vikarie, note, room, lesson log, note to the substitute, a pupil moved, a decision on an absence', async () => {
      await inSchool('i', async (s, svc) => {
        // A lesson of another class at the same time, and a pupil of the first class: the pupil can be moved to it for a day.
        const other = await owner.studentGroup.create({ data: { schoolId: s.schoolId, academicYearId: s.yearId, name: `${MARKER}-i 7B`, kind: 'CLASS', gradeLevel: 7 } });
        const parallel = await owner.masterLesson.create({
          data: { schoolId: s.schoolId, academicYearId: s.yearId, subjectId: s.subjectId, studentGroupId: other.id, teacherId: s.secondTeacherId, roomId: null, dayOfWeek: 1, startTime: time('08:00'), endTime: time('09:00') },
        });
        const pupil = await owner.user.create({ data: { schoolId: s.schoolId, authId: randomUUID(), role: 'STUDENT', firstName: 'Elev', lastName: 'Aterstall', email: `elev-${MARKER}-i@probe.example.com`, studentGroupId: s.groupId } });
        await publish(s, svc);
        const version = await svc.versions.create(s.yearId, 'före', s.admin);
        // The grundschema moves on without the calendar following: the Monday lesson has another teacher, so the restore changes it and takes its rows.
        await owner.masterLesson.update({ where: { id: s.monday }, data: { teacherId: s.secondTeacherId } });
        const rows = (await calendarOf(s)).rows.filter((row) => row.masterLessonId === s.monday);
        const parallelRows = (await calendarOf(s)).rows.filter((row) => row.masterLessonId === parallel.id);
        assert.ok(rows.length >= 8);
        const sameDay = (row: { date: Date }) => parallelRows.find((other) => other.date.getTime() === row.date.getTime())!;
        const otherRoom = await owner.room.create({ data: { schoolId: s.schoolId, name: 'sal 3', capacity: 20 } });
        await substitute(rows[0]!.id, s);
        await owner.calendarLesson.update({ where: { id: rows[1]!.id }, data: { note: 'Prov' } });
        await owner.calendarLesson.update({ where: { id: rows[2]!.id }, data: { roomId: otherRoom.id } });
        await owner.lessonLog.create({ data: { schoolId: s.schoolId, calendarLessonId: rows[3]!.id, topic: 'Bråk' } });
        await owner.lessonSubstituteNote.create({ data: { schoolId: s.schoolId, calendarLessonId: rows[4]!.id, body: 'Nyckeln ligger i lådan' } });
        await owner.lessonPupilMove.create({ data: { schoolId: s.schoolId, studentId: pupil.id, fromLessonId: rows[5]!.id, toLessonId: sameDay(rows[5]!).id } });
        const absence = await owner.teacherAbsence.create({ data: { schoolId: s.schoolId, userId: s.teacherId, startsAt: new Date(rows[6]!.date.getTime() + 7 * 3_600_000), endsAt: new Date(rows[6]!.date.getTime() + 8 * 3_600_000), wholeDays: false } });
        await owner.teacherAbsenceCover.create({ data: { schoolId: s.schoolId, absenceId: absence.id, calendarLessonId: rows[6]!.id, absentTeacherId: s.teacherId, removedTeachers: [{ teacherId: s.teacherId, role: 'LEAD' }], decision: 'CO_TEACHER' } });
        await svc.reach.acknowledge(s.admin);

        const restored = await svc.versions.restore(version.id, s.admin);
        assert.equal(restored.calendar?.removed, rows.length, 'every row of the Monday lesson went');
        assert.equal(restored.calendar?.handChanged, 7, 'and the seven somebody had worked on are said to be that');
      });
    });

    await check('(rf) a lesson that has already happened stays, as an orphan, when the restore replaces its lesson', async () => {
      await inSchool('f', async (s, svc) => {
        await publish(s, svc);
        const version = await svc.versions.create(s.yearId, 'före', s.admin);
        await owner.masterLesson.update({ where: { id: s.monday }, data: { teacherId: s.secondTeacherId } });
        const row = (await calendarOf(s)).rows.find((entry) => entry.masterLessonId === s.monday)!;
        // The lesson was held a long time ago.
        await owner.$executeRaw`UPDATE "CalendarLessons" SET "date" = '2000-01-03', "startsAt" = '2000-01-03T07:00:00Z', "endsAt" = '2000-01-03T08:00:00Z' WHERE "id" = ${row.id}::uuid`;
        await svc.reach.acknowledge(s.admin);
        await svc.versions.restore(version.id, s.admin);
        const after = await calendarOf(s);
        const kept = after.rows.find((entry) => entry.id === row.id);
        assert.ok(kept, 'the held lesson is still in the calendar');
        assert.equal(kept!.masterLessonId, null, 'with no lesson to belong to, as after a hand edit that removes one');
        assert.equal(after.orphans.length, 1, 'and it is the only orphan');
      });
    });

    await check('(rg) in utkast the restore writes no calendar row; a school with nothing published is asked nothing', async () => {
      await inSchool('g1', async (s, svc) => {
        await publish(s, svc);
        const version = await svc.versions.create(s.yearId, 'före', s.admin);
        const before = (await calendarOf(s)).rows.map((row) => row.id).sort();
        await svc.drafts.switchMode('DRAFT', s.admin);
        const restored = await svc.versions.restore(version.id, s.admin);
        assert.equal(restored.calendar, undefined, 'the draft is replaced and the calendar is left to a publication');
        assert.deepEqual((await calendarOf(s)).rows.map((row) => row.id).sort(), before, 'every published row is where it was');
      });
      await inSchool('g2', async (s, svc) => {
        const version = await svc.versions.create(s.yearId, 'före', s.admin);
        await owner.masterLesson.update({ where: { id: s.monday }, data: { teacherId: s.secondTeacherId } });
        const restored = await svc.versions.restore(version.id, s.admin);
        assert.equal(restored.restoredLessons, 3);
        assert.equal(restored.calendar, undefined, 'there was no calendar to carry');
        assert.equal((await owner.masterLesson.findFirstOrThrow({ where: { academicYearId: s.yearId, dayOfWeek: 1 } })).teacherId, s.teacherId);
      });
    });
    // A publication in Direkt takes no lock on the year, so it can meet a restore at any point. The restore is held at the start of its last
    // statement (the delete of the old lessons) by a statement trigger that waits for an advisory lock this probe holds; the trigger is made
    // here and dropped in the finally, and while nobody holds the lock it waits for nothing.
    const STALL = 7770522;
    const holder = new Client({ connectionString: requiredEnv('PROBE_OWNER_URL') });
    await holder.connect();
    try {
      await check('(rh) a publication that meets the restore at its last statement is waited for: nothing stranded, nothing doubled', async () => {
        await inSchool('h', async (s, svc) => {
          await svc.publications.legacyPublish({ academicYearId: s.yearId, fromDate: YEAR_START, toDate: '2096-09-30' }, s.admin);
          const version = await svc.versions.create(s.yearId, 'före', s.admin);
          await svc.reach.acknowledge(s.admin);
          await owner.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.probe_aterstallning_stall() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${STALL}); RETURN NULL; END $$`);
          await owner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS probe_aterstallning_stall ON "MasterLessons"`);
          await owner.$executeRawUnsafe(`CREATE TRIGGER probe_aterstallning_stall BEFORE DELETE ON "MasterLessons" FOR EACH STATEMENT EXECUTE FUNCTION public.probe_aterstallning_stall()`);
          await holder.query('SELECT pg_advisory_lock($1)', [STALL]);
          let released = false;
          const release = async () => {
            if (!released) {
              released = true;
              await holder.query('SELECT pg_advisory_unlock($1)', [STALL]);
            }
          };
          try {
            const restore = svc.versions.restore(version.id, s.admin).then(() => 'ok', (error: unknown) => error);
            const until = Date.now() + 15_000;
            for (;;) {
              const waiting = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = ${STALL}`);
              if (Number(waiting[0]!.n) > 0) break;
              assert.ok(Date.now() < until, 'the restore never reached its last statement');
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            const publication = svc.publications.legacyPublish({ academicYearId: s.yearId, fromDate: '2096-10-01', toDate: '2096-12-31' }, s.admin).then(() => 'ok', (error: unknown) => error);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await release();
            assert.equal(await restore, 'ok', 'the restore went through');
            await publication;
          } finally {
            await release();
            await owner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS probe_aterstallning_stall ON "MasterLessons"`);
          }
          assert.equal((await calendarOf(s)).orphans.length, 0, 'no published row is left without its lesson');
          await svc.publications.legacyPublish({ academicYearId: s.yearId, fromDate: YEAR_START }, s.admin);
          assert.equal((await calendarOf(s)).rows.length, await expectedRows(s), 'a publication after it gives the lessons the grundschema gives, once each');
        });
      });
    } finally {
      await holder.end().catch(() => undefined);
      await owner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS probe_aterstallning_stall ON "MasterLessons"`).catch(() => undefined);
    }
  } finally {
    await sweep().catch((error) => console.error('sweep:', error));
    await api.$disconnect();
    await owner.$disconnect();
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\naterstallning-direkt probe passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
