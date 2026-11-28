/**
 * Frågan före en ändring i Direkt som når familjer (P5, beslut 8) against a real database, as the API role under RLS, through the real
 * services.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=2' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-direkt-fragan.ts
 *
 * The jest specs hold the rule (src/publication/direct-reach.spec.ts) and what each write does on a faked client
 * (master-lessons.service.spec.ts, "P5"); the RLS suite holds the reader's rights (sections 600 and 600o). What they cannot see is
 * the whole of it in one database: that a refused edit really leaves the master lesson, the calendar and the inbox as they were,
 * that the answer is read for an administrator's own school only, and that a switch of mode takes it back.
 *
 *   (a) a school in Direkt with a published period: a drag that moves published lessons is refused with DIRECT_REACH_UNANSWERED and nothing
 *       has moved (the master lesson, the calendar rows) and nobody has been told;
 *   (b) the school's answer lets the same drag through, the calendar moves and the class is told; the view then says nothing is asked;
 *   (c) a deletion is refused and kept the same way, and goes once the question is answered (a card's move has its unit test: a block
 *       needs a requirement per member, which this school does not have);
 *   (d) nothing is asked of a school with no publication that holds, of one whose publication ended yesterday, of a drag that does not
 *       propagate, or of a drag that reached no published lesson;
 *   (e) a switch of mode takes the answer back, both ways, and the question is asked again in Direkt;
 *   (f) the view counts the school's pupils and the guardians linked to an active one, and no other school's;
 *   (g) a läsare cannot answer for the school (the settings row is the Publicering area's), and nothing is written;
 *   (h) a swap that reached published lessons is refused whole, its safety version rolled back with it, and goes once the school has answered;
 *   (i) att lägga (E4): a brick that is a parked lesson with calendar rows, laid back in a published period, is refused as a drag is and nothing is written
 *       (g490 M-5); a brick that is no lesson yet reaches nobody; the answer lets the lay go, and the class is told.
 *
 * Each in a school of its own (slug <marker>-direkt-<n>), swept whole after, and before the first. The year is in 2096, so every day of
 * it lies ahead and nothing a check writes is ever "the past".
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { BoardTrayService } from '../../src/board-tray/board-tray.service';
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
import { SwapsService } from '../../src/swaps/swaps.service';
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

const MARKER = 'probe-direkt';
const YEAR_START = '2096-08-13';
const YEAR_END = '2097-06-11';
const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

interface Spy {
  sent: Array<{ type: string; userIds: string[] }>;
}

interface School {
  schoolId: string;
  yearId: string;
  admin: AuthenticatedUser;
  lasare: AuthenticatedUser;
  /** Monday 08:00-09:00 and Wednesday 10:00-11:00, 7A. */
  monday: string;
  wednesday: string;
  teacherId: string;
  groupId: string;
  subjectId: string;
}

async function givenSchool(owner: Owner, suffix: string): Promise<School> {
  const slug = `${MARKER}-${suffix}`;
  await owner.school.deleteMany({ where: { slug } });
  const school = await owner.school.create({ data: { name: slug, slug, timezone: 'Europe/Stockholm' } });
  const person = (key: string, role: 'SCHOOL_ADMIN' | 'TEACHER' | 'STUDENT' | 'GUARDIAN', extra: Record<string, unknown> = {}) =>
    owner.user.create({
      data: { schoolId: school.id, authId: randomUUID(), role, firstName: key, lastName: 'Direkt', email: `${key.toLowerCase()}-${slug}@probe.example.com`, ...extra },
    });
  const admin = await person('Admin', 'SCHOOL_ADMIN', { adminProfile: 'FULL' });
  const lasare = await person('Lasare', 'SCHOOL_ADMIN', { adminProfile: 'LASARE' });
  const teacher = await person('T1', 'TEACHER');
  const year = await owner.academicYear.create({
    data: { schoolId: school.id, name: slug, startDate: new Date(YEAR_START), endDate: new Date(YEAR_END), gradeNumbering: 'NIOARIG', isActive: true },
  });
  const group = await owner.studentGroup.create({ data: { schoolId: school.id, academicYearId: year.id, name: `${slug} 7A`, kind: 'CLASS', gradeLevel: 7 } });
  const subject = await owner.subject.create({ data: { schoolId: school.id, name: `${slug} matte` } });
  const room = await owner.room.create({ data: { schoolId: school.id, name: `${slug} sal 1`, capacity: 30 } });
  const lesson = (dayOfWeek: number, start: string, end: string, roomId: string | null) =>
    owner.masterLesson.create({
      data: {
        schoolId: school.id,
        academicYearId: year.id,
        subjectId: subject.id,
        studentGroupId: group.id,
        teacherId: teacher.id,
        roomId,
        dayOfWeek,
        startTime: time(start),
        endTime: time(end),
      },
    });
  const monday = await lesson(1, '08:00', '09:00', room.id);
  const wednesday = await lesson(3, '10:00', '11:00', null);
  const as = (row: { id: string; authId: string }, adminProfile: 'FULL' | 'LASARE'): AuthenticatedUser => ({
    authId: row.authId,
    userId: row.id,
    schoolId: school.id,
    role: Role.SCHOOL_ADMIN,
    adminProfile,
    hrRead: false,
    channel: 'OTHER',
  });
  return {
    schoolId: school.id,
    yearId: year.id,
    admin: as(admin, 'FULL'),
    lasare: as(lasare, 'LASARE'),
    monday: monday.id,
    wednesday: wednesday.id,
    teacherId: teacher.id,
    groupId: group.id,
    subjectId: subject.id,
  };
}

function servicesOf(api: PrismaService, spy: Spy) {
  const realtime = { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService;
  const notifications = {
    recipientsForLessons: async () => [randomUUID()],
    notifyUsers: async (_tx: unknown, input: { type: string; userIds: string[] }) => {
      spy.sent.push({ type: input.type, userIds: input.userIds });
      return input.userIds.length;
    },
  } as unknown as NotificationsService;
  const calendar = new CalendarService(api);
  const masters = new MasterLessonsService(api, realtime, notifications);
  return {
    masters,
    tray: new BoardTrayService(api, masters),
    swaps: new SwapsService(api, masters, new ScheduleVersionsService(api), realtime, notifications),
    publications: new PublicationsService(api, calendar, new TimplanCoverageService(api), new StaffingLoadService(api), notifications, realtime, new ScheduleVersionsService(api)),
    drafts: new DraftService(api, calendar, new ScheduleVersionsService(api), realtime),
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
  throw new Error('the write was not refused');
};

async function main(): Promise<void> {
  const owner = new PrismaClient({ adapter: createPgAdapter(requiredEnv('PROBE_OWNER_URL')) });
  const previous = process.env['DATABASE_URL'];
  const api = new PrismaService();
  process.env['DATABASE_URL'] = previous;

  const made: string[] = [];
  const sweep = async () => {
    await owner.school.deleteMany({ where: { slug: { startsWith: `${MARKER}-` } } });
  };
  const inSchool = async (suffix: string, body: (s: School, spy: Spy, svc: ReturnType<typeof servicesOf>) => Promise<void>) => {
    const fx = await givenSchool(owner, suffix);
    made.push(fx.schoolId);
    const spy: Spy = { sent: [] };
    await body(fx, spy, servicesOf(api, spy));
  };
  /** The master lesson's day and the calendar's rows of it: what a refused edit must leave alone. */
  const standing = async (id: string) => {
    const master = await owner.masterLesson.findUniqueOrThrow({ where: { id }, select: { dayOfWeek: true } });
    const rows = await owner.calendarLesson.findMany({ where: { masterLessonId: id }, select: { date: true }, orderBy: { date: 'asc' } });
    return `${master.dayOfWeek}|${rows.map((row) => row.date.toISOString().slice(0, 10)).join(',')}`;
  };
  const publish = (s: School, svc: ReturnType<typeof servicesOf>) => svc.publications.legacyPublish({ academicYearId: s.yearId, fromDate: YEAR_START }, s.admin);
  const answerOf = async (s: School) =>
    (await owner.publicationSettings.findUnique({ where: { schoolId: s.schoolId }, select: { directReachAcknowledgedAt: true } }))?.directReachAcknowledgedAt ?? null;

  await sweep();
  try {
    await check('(a) a drag that moves published lessons is refused before the school has answered, and nothing has moved', async () => {
      await inSchool('a', async (s, spy, svc) => {
        await publish(s, svc);
        const before = await standing(s.monday);
        assert.ok(before.split('|')[1]!.length > 0, 'the publication wrote calendar rows of the Monday lesson');
        const view = await svc.reach.read(s.admin);
        assert.deepEqual([view.ask, view.mode, view.period?.to], [true, 'DIRECT', YEAR_END]);
        const refusal = await refusalOf(svc.masters.update(s.monday, { dayOfWeek: 2 }, s.admin));
        assert.equal(refusal.code, 'DIRECT_REACH_UNANSWERED');
        assert.deepEqual(refusal.params, { validFrom: YEAR_START, validTo: YEAR_END });
        assert.equal(await standing(s.monday), before, 'the master lesson and the calendar are as they were');
        assert.deepEqual(spy.sent, [], 'nobody was told');
        assert.equal(await answerOf(s), null);
      });
    });

    await check('(b) once the school has answered, the same drag goes through, the calendar moves and the class is told', async () => {
      await inSchool('b', async (s, spy, svc) => {
        await publish(s, svc);
        const answered = await svc.reach.acknowledge(s.admin);
        assert.equal(answered.ask, false);
        assert.ok(answered.acknowledgedAt, 'the view carries the time of the answer');
        assert.equal(answered.audience, null, 'nobody is counted when nothing is asked');
        const moved = await svc.masters.update(s.monday, { dayOfWeek: 2 }, s.admin);
        assert.ok(moved.propagatedLessons > 0, 'published lessons moved');
        assert.deepEqual(spy.sent.map((notice) => notice.type), ['SCHEDULE_CHANGED']);
        assert.match(await standing(s.monday), /^2\|/);
        assert.equal((await svc.reach.read(s.admin)).ask, false);
      });
    });

    await check('(c) a deletion is refused and kept, and goes once the school has answered', async () => {
      await inSchool('c', async (s, _spy, svc) => {
        await publish(s, svc);
        const before = await standing(s.wednesday);
        await refusalOf(svc.masters.remove(s.wednesday, s.admin));
        assert.equal(await standing(s.wednesday), before, 'the lesson and its calendar rows are still there');
        await svc.reach.acknowledge(s.admin);
        const removed = await svc.masters.remove(s.wednesday, s.admin);
        assert.ok(removed.removedCalendarLessons > 0);
        assert.equal(await owner.masterLesson.count({ where: { id: s.wednesday } }), 0);
      });
    });

    await check('(d) nothing is asked where nothing reaches families', async () => {
      await inSchool('d1', async (s, _spy, svc) => {
        // The calendar holds rows the old route wrote (CalendarService.publish writes no publication in the log): a drag reaches them, and no
        // publication holds, so nobody is asked.
        await new CalendarService(api).publish({ academicYearId: s.yearId, fromDate: YEAR_START, toDate: YEAR_END }, s.admin);
        const view = await svc.reach.read(s.admin);
        assert.deepEqual([view.ask, view.period], [false, null]);
        const moved = await svc.masters.update(s.monday, { dayOfWeek: 2 }, s.admin);
        assert.ok(moved.propagatedLessons > 0, 'the drag reached published rows');
      });
      await inSchool('d2', async (s, _spy, svc) => {
        await publish(s, svc);
        // propagate: false leaves the calendar where it is, so nobody is reached.
        const moved = await svc.masters.update(s.monday, { dayOfWeek: 2, propagate: false }, s.admin);
        assert.equal(moved.propagatedLessons, 0);
        // A lesson the calendar holds no row of reaches nobody, whatever the publication.
        await owner.calendarLesson.deleteMany({ where: { masterLessonId: s.wednesday } });
        const unseen = await svc.masters.update(s.wednesday, { dayOfWeek: 4 }, s.admin);
        assert.equal(unseen.propagatedLessons, 0, 'no calendar row of the lesson stood to be moved');
      });
      await inSchool('d3', async (s, _spy, svc) => {
        await publish(s, svc);
        // The publication ended yesterday, in the school's own day: there is no period that holds.
        await owner.$executeRaw`UPDATE "TimetablePublications" SET "validFrom" = '2000-01-01', "validTo" = (now() AT TIME ZONE 'Europe/Stockholm')::date - 1 WHERE "schoolId" = ${s.schoolId}::uuid`;
        const view = await svc.reach.read(s.admin);
        assert.deepEqual([view.ask, view.period], [false, null]);
        const moved = await svc.masters.update(s.monday, { dayOfWeek: 2 }, s.admin);
        assert.ok(moved.propagatedLessons > 0, 'the drag reached rows of a period that has ended, and nobody is asked');
      });
    });

    await check('(e) a switch of mode takes the answer back, and the question is new in Direkt', async () => {
      await inSchool('e', async (s, _spy, svc) => {
        await publish(s, svc);
        await svc.reach.acknowledge(s.admin);
        assert.ok(await answerOf(s));
        await svc.drafts.switchMode('DRAFT', s.admin);
        assert.equal(await answerOf(s), null, 'to utkast takes the answer back');
        // In utkast nothing reaches anybody, so nothing is asked, and an edit is a draft.
        const inDraft = await svc.reach.read(s.admin);
        assert.deepEqual([inDraft.mode, inDraft.ask], ['DRAFT', false]);
        await svc.masters.update(s.monday, { dayOfWeek: 2 }, s.admin);
        // An answer given while the school is in utkast (a tab that was open since Direkt) is written, and the switch back takes it away too: the
        // clearing is in both directions, which only an answer written in between can tell from a clearing on the way out alone.
        await svc.reach.acknowledge(s.admin);
        assert.ok(await answerOf(s), 'the stale answer was written in utkast');
        // Back in Direkt (nothing unpublished: the draft is published first), the question stands again.
        await svc.drafts.discard(s.yearId, s.admin);
        await svc.drafts.switchMode('DIRECT', s.admin);
        const back = await svc.reach.read(s.admin);
        assert.deepEqual([back.mode, back.ask, back.acknowledgedAt], ['DIRECT', true, null]);
        const refusal = await refusalOf(svc.masters.update(s.monday, { dayOfWeek: 3 }, s.admin));
        assert.equal(refusal.code, 'DIRECT_REACH_UNANSWERED');
      });
    });

    await check('(f) the view counts the school\'s pupils and the guardians of an active one, and nobody else\'s', async () => {
      await inSchool('f', async (s, _spy, svc) => {
        const pupil = (key: string, extra: Record<string, unknown> = {}) =>
          owner.user.create({
            data: { schoolId: s.schoolId, authId: randomUUID(), role: 'STUDENT', firstName: key, lastName: 'Elev', email: `${key.toLowerCase()}-${s.schoolId}@probe.example.com`, studentGroupId: s.groupId, ...extra },
          });
        const guardian = (key: string, extra: Record<string, unknown> = {}) =>
          owner.user.create({
            data: { schoolId: s.schoolId, authId: randomUUID(), role: 'GUARDIAN', firstName: key, lastName: 'Vh', email: `${key.toLowerCase()}-${s.schoolId}@probe.example.com`, ...extra },
          });
        const [p1, p2, p3] = [await pupil('P1'), await pupil('P2'), await pupil('P3', { isActive: false })];
        const [g1, g2, g3] = [await guardian('G1'), await guardian('G2'), await guardian('G3', { isActive: false })];
        for (const [guardianId, studentId] of [[g1.id, p1.id], [g1.id, p2.id], [g2.id, p2.id], [g2.id, p3.id], [g3.id, p1.id]] as const) {
          await owner.guardianStudent.create({ data: { schoolId: s.schoolId, guardianId, studentId } });
        }
        // Another school's pupils and guardians are not this school's.
        const other = await givenSchool(owner, 'f-annan');
        await owner.user.create({
          data: { schoolId: other.schoolId, authId: randomUUID(), role: 'STUDENT', firstName: 'X', lastName: 'Annan', email: `x-${other.schoolId}@probe.example.com`, studentGroupId: other.groupId },
        });
        await publish(s, svc);
        const view = await svc.reach.read(s.admin);
        // Two active pupils; g1 and g2 are linked to an active pupil and are active themselves (g3 is deactivated; p3 is, so g2 counts through p2).
        assert.deepEqual(view.audience, { pupils: 2, guardians: 2 });
      });
    });

    await check('(g) a läsare cannot answer for the school, and nothing is written', async () => {
      await inSchool('g', async (s, _spy, svc) => {
        await publish(s, svc);
        await assert.rejects(svc.reach.acknowledge(s.lasare));
        assert.equal(await answerOf(s), null);
        // A läsare reads the same question as a full administrator.
        assert.deepEqual(await svc.reach.read(s.lasare), await svc.reach.read(s.admin));
      });
    });

    await check('(h) a swap that reached published lessons is refused whole before the school has answered, the safety version with it, and goes after', async () => {
      await inSchool('h', async (s, spy, svc) => {
        await publish(s, svc);
        const body = {
          lessonId: s.monday,
          moves: [
            { lessonId: s.monday, from: { dayOfWeek: 1, startTime: '08:00', endTime: '09:00' }, to: { dayOfWeek: 3, startTime: '10:00', endTime: '11:00' } },
            { lessonId: s.wednesday, from: { dayOfWeek: 3, startTime: '10:00', endTime: '11:00' }, to: { dayOfWeek: 1, startTime: '08:00', endTime: '09:00' } },
          ],
        };
        const before = [await standing(s.monday), await standing(s.wednesday)];
        // The publication above left its own version (E9); the swap's safety version is the one after it.
        const published = await owner.scheduleVersion.count({ where: { schoolId: s.schoolId } });
        const refusal = await refusalOf(svc.swaps.apply(body, s.admin));
        assert.equal(refusal.code, 'DIRECT_REACH_UNANSWERED');
        assert.deepEqual([await standing(s.monday), await standing(s.wednesday)], before, 'both lessons and their calendar rows are as they were');
        assert.equal(await owner.scheduleVersion.count({ where: { schoolId: s.schoolId } }), published, 'the safety version the swap took first was rolled back with it');
        assert.equal(await owner.scheduleChangeLog.count({ where: { schoolId: s.schoolId } }), 0, 'no log row');
        assert.deepEqual(spy.sent, [], 'nobody was told');
        await svc.reach.acknowledge(s.admin);
        const applied = await svc.swaps.apply(body, s.admin);
        assert.ok(applied.propagatedLessons > 0, 'published lessons moved');
        assert.equal(await owner.scheduleVersion.count({ where: { schoolId: s.schoolId } }), published + 1, 'the safety version stands now');
        assert.ok(spy.sent.length > 0, 'the classes were told');
      });
    });

    await check('(i) a lay that moves a parked lesson with calendar rows back is refused before the school has answered, and a brick that is no lesson reaches nobody', async () => {
      await inSchool('i', async (s, spy, svc) => {
        // A post of one lesson a week of its own subject, and its lesson on a Tuesday: published, it has calendar rows.
        const subject = await owner.subject.create({ data: { schoolId: s.schoolId, name: `${MARKER}-i idrott` } });
        const post = await owner.teachingRequirement.create({
          data: { schoolId: s.schoolId, academicYearId: s.yearId, subjectId: subject.id, studentGroupId: s.groupId, teacherId: s.teacherId, lessonsPerWeek: 2, minutesPerLesson: 60 },
        });
        const tuesday = await owner.masterLesson.create({
          data: { schoolId: s.schoolId, academicYearId: s.yearId, subjectId: subject.id, studentGroupId: s.groupId, teacherId: s.teacherId, dayOfWeek: 2, startTime: time('09:00'), endTime: time('10:00'), isLocked: true },
        });
        await publish(s, svc);
        // The lesson is put on the tray the way the page puts it (a drag to the parking), which the school may have answered for; its rows stay.
        await svc.reach.acknowledge(s.admin);
        await svc.masters.update(tuesday.id, { isParked: true }, s.admin);
        await owner.$executeRaw`UPDATE "PublicationSettings" SET "directReachAcknowledgedAt" = NULL WHERE "schoolId" = ${s.schoolId}::uuid`;
        assert.equal(await answerOf(s), null, 'the question is open again');
        spy.sent.length = 0; // the park itself told the class (the school had answered): the check starts from here
        const told = (): string[] => spy.sent.map((notice) => notice.type);
        const rowsBefore = await standing(tuesday.id);
        assert.ok(rowsBefore.split('|')[1]!.length > 0, 'the parked lesson still has calendar rows');
        const brickOf = async () => {
          const bricks = (await svc.tray.trayOfYear(s.yearId, undefined, s.admin)).bricks.filter((brick) => brick.postId === post.id);
          return bricks;
        };
        const parkedBrick = (await brickOf()).find((brick) => brick.lessonId === tuesday.id);
        assert.ok(parkedBrick, 'the parked lesson is a brick of the post');
        const lay = (brick: NonNullable<typeof parkedBrick>, day: number) =>
          svc.tray.lay(
            { academicYearId: s.yearId, postId: post.id, teacherId: s.teacherId, minutes: 60, partKey: brick.partKey, ...(brick.lessonId ? { lessonId: brick.lessonId } : {}), dayOfWeek: day, startTime: '09:00', roomId: null },
            s.admin,
          );
        const parkedState = async () => {
          const row = await owner.masterLesson.findUniqueOrThrow({ where: { id: tuesday.id }, select: { isParked: true, dayOfWeek: true, isLocked: true } });
          return `${row.isParked}|${row.dayOfWeek}|${row.isLocked}`;
        };
        const stateBefore = await parkedState();
        const logBefore = await owner.scheduleChangeLog.count({ where: { schoolId: s.schoolId } });
        const refusal = await refusalOf(lay(parkedBrick!, 4));
        assert.equal(refusal.code, 'DIRECT_REACH_UNANSWERED');
        assert.deepEqual(refusal.params, { validFrom: YEAR_START, validTo: YEAR_END });
        assert.equal(await parkedState(), stateBefore, 'the lesson is still on the tray, where it was');
        assert.equal(await standing(tuesday.id), rowsBefore, 'the calendar rows have not moved');
        assert.deepEqual(told(), [], 'nobody was told');
        assert.equal(await owner.scheduleChangeLog.count({ where: { schoolId: s.schoolId } }), logBefore, 'the refused lay left no log row');

        // The brick that is no lesson yet makes a new lesson, whose calendar rows come with the next generation of the calendar: nobody is reached,
        // and nobody is asked.
        const second = (await brickOf()).find((brick) => brick.lessonId === null);
        assert.ok(second, 'the post has a second brick, which is no lesson yet');
        const made = await lay(second!, 5);
        assert.equal(made.lesson.dayOfWeek, 5);
        assert.deepEqual(told(), [], 'a new lesson reached nobody');

        // Once the school has answered, the same lay goes: the lesson is back on the grundschema, locked, its rows moved, the class told.
        await svc.reach.acknowledge(s.admin);
        const fresh = (await brickOf()).find((brick) => brick.lessonId === tuesday.id);
        assert.ok(fresh, 'the parked lesson is still a brick');
        const laid = await lay(fresh!, 4);
        assert.equal(laid.noRoom, true);
        assert.equal(await parkedState(), 'false|4|true');
        assert.match(await standing(tuesday.id), /^4\|/);
        assert.deepEqual(told(), ['SCHEDULE_CHANGED']);
      });
    });
  } finally {
    await sweep().catch((error) => console.error('sweep:', error));
    await api.$disconnect();
    await owner.$disconnect();
  }
  void made;
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\ndirekt-fragan probe passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
