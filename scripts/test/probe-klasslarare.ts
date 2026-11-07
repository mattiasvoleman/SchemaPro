/**
 * The adapter probe's checks for Klasslärarens schema (20270128090000), through
 * the real services on the API's role and real Postgres as CI runs it — the part
 * the unit specs and the e2e cannot see, since both run on the Prisma mock: that
 * the database's own refusals (CT403, CT409, CT422, 23505) arrive through
 * @prisma/adapter-pg as the codes the gateway maps, that the frame's arguments
 * are typed as Postgres wants them, that a draft is carried out by the editor's
 * own services and nothing else, and that two writers never overwrite each other.
 * In a school of its own (slug <marker>-klasslarare), swept whole before and after.
 *
 * The school lives a week ahead (found from today, so the dates are always in
 * front of it and the probe never ages):
 *
 *   4A     Mon 08:30-09:30 Matematik (Karin, Sal 1)   Thu 09:00-10:00 Svenska (Karin, Sal 1)
 *          Wed 09:00-10:00 Engelska (Karin, Sal 1)    the dated lessons of the Monday and the Thursday
 *   4B     Tue 10:00-10:30 Matematik (Lars, Sal 2)    its dated lesson on the Tuesday
 *   Open   Monday to Thursday 08:00-12:00 for every class
 *   Karin  is klasslärare of 4A, appointed by Sara (schemaläggare); Lars is no one's
 *
 *   kl-a  the week: every lesson Karin may change has no reason, the one with a
 *         colleague is named, the versions are the database's and the rooms know
 *         which are theirs to choose;
 *   kl-b  a draft is born a draft at revision 1 in Karin's name; a second for the
 *         same lesson is 409 with the first; one written against a lesson that has
 *         changed is 409 with the lesson as it is; a lesson of another class is
 *         refused with its reason, and a class Karin is not klasslärare of with
 *         the appointment's;
 *   kl-c  a draft edited at its revision moves to the next; a second writer at the
 *         old one gets the draft as it stands; so does a discard;
 *   kl-d  the live check names a clash by what clashes (a room another class has),
 *         and says nothing of who teaches it;
 *   kl-e  the schemaläggare publishes: the room changes through the day operations
 *         and the draft is a record, in Sara's name;
 *   kl-f  the school's option: refused while off, and then Karin publishes their
 *         own class, which is carried out as Sara;
 *   kl-g  a lesson of the grundschema moved, and a long one split in two (the
 *         second part a lesson of its own), through the editor's own services;
 *   kl-h  a clash found at publication stops the draft and leaves the lesson;
 *   kl-i  an appointment whose administrator is deactivated, or has become the
 *         expedition, lapses with a code, and mends;
 *   kl-j  two writers of the same lesson at once: one draft, one 409.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { CalendarLessonsService } from '../../src/calendar/calendar-lessons.service';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { ClassTeacherAdminService } from '../../src/class-teacher/class-teacher-admin.service';
import { ClassTeacherEngine } from '../../src/class-teacher/class-teacher-engine';
import { ClassTeacherService } from '../../src/class-teacher/class-teacher.service';
import type { PrismaService } from '../../src/database/prisma.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function klasslarareSlug(marker: string): string {
  return `${marker}-klasslarare`;
}

export async function sweepKlasslarareSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [klasslarareSlug(marker)]);
}

/** Runs a body that must be refused and answers the refusal, so a check can read its code. */
async function refusedWith(body: () => Promise<unknown>): Promise<{ status: number; response: Record<string, unknown> }> {
  try {
    await body();
  } catch (error) {
    const e = error as { getStatus?: () => number; getResponse?: () => unknown };
    if (typeof e.getStatus === 'function') return { status: e.getStatus(), response: (e.getResponse?.() ?? {}) as Record<string, unknown> };
    throw error;
  }
  throw new Error('expected a refusal');
}

export async function klasslarareChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepKlasslarareSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  // The Monday at least a week ahead, so nothing about the week has begun.
  const monday = (await one<{ d: string }>(`SELECT (current_date + 7 + ((8 - extract(isodow FROM current_date + 7)::int) % 7))::text AS d`)).d;
  const plus = async (date: string, days: number) => (await one<{ d: string }>(`SELECT ($1::date + $2::int)::text AS d`, [date, days])).d;
  const tuesday = await plus(monday, 1);
  const thursday = await plus(monday, 3);

  const s = (
    await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [
      `${marker} klasslärare`,
      klasslarareSlug(marker),
    ])
  ).id;
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
       VALUES ($1, 'probe klasslärare', current_date - 30, current_date + 450, true, 'NIOARIG', now()) RETURNING id`,
      [s],
    )
  ).id;
  const subject = async (name: string, code: string) =>
    (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "countsTowardTimplan", "updatedAt") VALUES ($1, $2, $3, true, now()) RETURNING id`, [s, name, code])).id;
  const [matte, svenska, engelska] = [await subject('Matematik', 'KLMA'), await subject('Svenska', 'KLSV'), await subject('Engelska', 'KLEN')];
  const groupOf = async (name: string) =>
    (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', 4, now()) RETURNING id`, [s, year, name])).id;
  const [g4a, g4b] = [await groupOf('4A'), await groupOf('4B')];
  const roomOf = async (name: string) => (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [s, name])).id;
  const [sal1, sal2, sal3] = [await roomOf('Sal 1'), await roomOf('Sal 2'), await roomOf('Sal 3')];
  await owner.query(`UPDATE "Rooms" SET "requiresApproval" = true WHERE id = $1`, [sal3]);

  const person = async (role: string, label: string, adminProfile: string | null = null) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4::"UserRole", $5::"AdminProfile", $6, true, now()) RETURNING id`,
      [s, `${marker}-kl-${label}@example.invalid`, label, role, adminProfile, authId],
    );
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
  const sara = await person('SCHOOL_ADMIN', 'sara', 'SCHEMALAGGARE');
  const expedition = await person('SCHOOL_ADMIN', 'expedition', 'EXPEDITION');
  const karin = await person('TEACHER', 'karin');
  const lars = await person('TEACHER', 'lars');
  const unlucky = await person('TEACHER', 'ingen');

  const master = async (subjectId: string, groupId: string, roomId: string, teacher: AuthenticatedUser, dow: number, from: string, to: string): Promise<string> =>
    (
      await one<{ id: string }>(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::time, $9::time, now()) RETURNING id`,
        [s, year, subjectId, groupId, teacher.userId, roomId, dow, from, to],
      )
    ).id;
  const dated = async (masterId: string, subjectId: string, groupId: string, roomId: string, teacher: AuthenticatedUser, date: string, from: string, to: string): Promise<string> => {
    const id = (
      await one<{ id: string }>(
        `INSERT INTO "CalendarLessons" ("schoolId", "masterLessonId", "subjectId", "studentGroupId", "roomId", date, "startsAt", "endsAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6::date, ($6::date + $7::time) AT TIME ZONE 'Europe/Stockholm', ($6::date + $8::time) AT TIME ZONE 'Europe/Stockholm', now()) RETURNING id`,
        [s, masterId, subjectId, groupId, roomId, date, from, to],
      )
    ).id;
    await owner.query(`INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, 'LEAD')`, [s, id, teacher.userId]);
    return id;
  };
  const mMon = await master(matte, g4a, sal1, karin, 1, '08:30', '09:30');
  const mThu = await master(svenska, g4a, sal1, karin, 4, '09:00', '10:00');
  const mWed = await master(engelska, g4a, sal1, karin, 3, '09:00', '10:00');
  const mTue4b = await master(matte, g4b, sal2, lars, 2, '10:00', '10:30');
  const lMon = await dated(mMon, matte, g4a, sal1, karin, monday, '08:30', '09:30');
  const lThu = await dated(mThu, svenska, g4a, sal1, karin, thursday, '09:00', '10:00');
  const lTue4b = await dated(mTue4b, matte, g4b, sal2, lars, tuesday, '10:00', '10:30');
  await owner.query(
    `INSERT INTO "ClassTeacherOpenTimes" ("schoolId", "academicYearId", "dayOfWeek", "startTime", "endTime") SELECT $1, $2, d, '08:00', '12:00' FROM generate_series(1, 4) d`,
    [s, year],
  );
  await owner.query(`INSERT INTO "ClassTeacherAppointments" ("schoolId", "academicYearId", "studentGroupId", "userId", "appointedByUserId") VALUES ($1, $2, $3, $4, $5)`, [s, year, g4a, karin.userId, sara.userId]);

  const notifications = { recipientsForLessons: async () => [], notifyUsers: async () => 0 } as unknown as NotificationsService;
  const realtime = {
    notifyMasterTimetableChanged: () => undefined,
    notifyLessonChanged: async () => undefined,
    notifyCoverBoardChanged: () => undefined,
  } as unknown as RealtimeService;
  const masters = new MasterLessonsService(api, realtime, notifications);
  const calendar = new CalendarLessonsService(api, realtime, notifications);
  const engine = new ClassTeacherEngine(api, masters, calendar, notifications, realtime);
  const teacherService = new ClassTeacherService(api, engine);
  const adminService = new ClassTeacherAdminService(api, engine);
  /** The version the page would read: the week view's own, so the probe never builds one by hand. */
  const weekOf = async (who: AuthenticatedUser, classId: string, from = monday) => teacherService.week(classId, { from }, who);
  const occasion = async (id: string, from = monday) => (await weekOf(karin, g4a, from)).occasions.find((row) => row.id === id)!;
  const template = async (id: string) => (await weekOf(karin, g4a)).template.find((row) => row.id === id)!;

  await check('(kl-a) the week: what Karin may change has no reason, what is a colleague’s is named, and the versions and rooms are the database’s', async () => {
    const week = await weekOf(karin, g4a);
    assert.equal(week.className, '4A');
    assert.equal(week.weekStart, monday);
    assert.deepEqual(week.days.length, 5);
    assert.deepEqual(week.openTimes.map((row) => [row.dayOfWeek, row.start, row.end]), [[1, '08:00', '12:00'], [2, '08:00', '12:00'], [3, '08:00', '12:00'], [4, '08:00', '12:00']]);
    const mon = week.occasions.find((row) => row.id === lMon)!;
    assert.deepEqual([mon.start, mon.end, mon.mine, mon.refusal, mon.draftId], ['08:30', '09:30', true, null, null]);
    assert.match(mon.version, /^[0-9a-f]{32}$/);
    assert.equal(week.occasions.some((row) => row.id === lTue4b), false, 'a lesson of another class is not in the week');
    assert.deepEqual(week.template.map((row) => [row.id, row.refusal]).sort(), [[mMon, null], [mThu, null], [mWed, null]].sort());
    assert.deepEqual(week.rooms.map((row) => [row.name, row.refusal]), [['Sal 1', null], ['Sal 2', null], ['Sal 3', 'ROOM_NEEDS_APPROVAL']]);
    // A colleague’s lesson is theirs: Lars’s class is not Karin’s to read.
    const refused = await refusedWith(() => weekOf(karin, g4b));
    assert.equal(refused.status, 403);
    assert.equal(refused.response.code, 'CLASS_TEACHER_NOT_APPOINTED');
    const nobody = await teacherService.mine(unlucky);
    assert.deepEqual(nobody.classes, []);
    assert.deepEqual((await teacherService.mine(karin)).classes.map((row) => row.name), ['4A']);
  });

  let monDraft = '';
  await check('(kl-b) a draft is born a draft in Karin’s name at revision 1, one waits per lesson, a stale one is refused with the lesson, and the frame names its reason', async () => {
    const mon = await occasion(lMon);
    const made = await teacherService.create(g4a, { kind: 'OCCASION_CANCEL', calendarLessonId: lMon, baseVersion: mon.version, note: 'Studiebesök' }, karin);
    monDraft = made.id;
    assert.deepEqual([made.status, made.rev, made.authorId, made.date, made.note], ['DRAFT', 1, karin.userId, monday, 'Studiebesök']);
    const row = await one<{ baseVersion: string; baseSnapshot: { status: string; roomId: string } }>(`SELECT "baseVersion", "baseSnapshot" FROM "ClassTeacherChanges" WHERE id = $1`, [made.id]);
    assert.equal(row.baseVersion, mon.version);
    assert.deepEqual([row.baseSnapshot.status, row.baseSnapshot.roomId], ['SCHEDULED', sal1]);

    const twice = await refusedWith(() => teacherService.create(g4a, { kind: 'OCCASION_ROOM', calendarLessonId: lMon, baseVersion: mon.version, targetRoomId: sal2 }, karin));
    assert.equal(twice.status, 409);
    assert.equal(twice.response.code, 'CLASS_TEACHER_DRAFT_EXISTS');
    assert.equal((twice.response.existing as { id: string }).id, made.id);

    // The Thursday’s room changes under Karin, and a draft against the old version is refused with the lesson as it is.
    const thu = await occasion(lThu, thursday);
    await owner.query(`UPDATE "CalendarLessons" SET "roomId" = $2 WHERE id = $1`, [lThu, sal2]);
    const stale = await refusedWith(() => teacherService.create(g4a, { kind: 'OCCASION_CANCEL', calendarLessonId: lThu, baseVersion: thu.version }, karin));
    assert.equal(stale.status, 409);
    assert.equal(stale.response.code, 'CLASS_TEACHER_STALE');
    assert.equal(((stale.response.current as { snapshot: { roomId: string } }).snapshot).roomId, sal2);
    await owner.query(`UPDATE "CalendarLessons" SET "roomId" = $2 WHERE id = $1`, [lThu, sal1]);

    // Another class’s lesson, asked for in Karin’s class: the frame says whose it is.
    const other = await refusedWith(() => teacherService.create(g4a, { kind: 'OCCASION_CANCEL', calendarLessonId: lTue4b, baseVersion: 'a'.repeat(32) }, karin));
    assert.equal(other.status, 403);
    assert.deepEqual([other.response.code, other.response.reason], ['CLASS_TEACHER_OUTSIDE_FRAME', 'OTHER_CLASS']);
    const stranger = await refusedWith(() => teacherService.create(g4b, { kind: 'OCCASION_CANCEL', calendarLessonId: lTue4b, baseVersion: 'a'.repeat(32) }, karin));
    assert.equal(stranger.response.code, 'CLASS_TEACHER_NOT_APPOINTED');
    // A teacher who is nobody’s klasslärare is refused at the door, and writes nothing.
    const nobody = await refusedWith(() => teacherService.create(g4a, { kind: 'OCCASION_CANCEL', calendarLessonId: lThu, baseVersion: thu.version }, lars));
    assert.equal(nobody.response.code, 'CLASS_TEACHER_NOT_APPOINTED');
    // A time the schemaläggare has not opened: Friday.
    const friday = await plus(monday, 4);
    const closed = await refusedWith(() =>
      teacherService.create(g4a, { kind: 'OCCASION_MOVE', calendarLessonId: lThu, baseVersion: thu.version, targetDate: friday, targetStart: '09:00', targetEnd: '10:00' }, karin),
    );
    assert.deepEqual([closed.response.code, closed.response.reason], ['CLASS_TEACHER_OUTSIDE_FRAME', 'TARGET_CLOSED']);
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ClassTeacherChanges" WHERE "schoolId" = $1`, [s])).n, 1);
  });

  await check('(kl-c) a draft edited at its revision moves to the next; the writer who read the old one is told how it stands now, and so is a discard', async () => {
    const edited = await teacherService.update(g4a, monDraft, { rev: 1, note: 'Studiebesök i Eksjö' }, karin);
    assert.deepEqual([edited.rev, edited.note], [2, 'Studiebesök i Eksjö']);
    const late = await refusedWith(() => teacherService.update(g4a, monDraft, { rev: 1, note: 'Mitt' }, karin));
    assert.equal(late.status, 409);
    assert.equal(late.response.code, 'CLASS_TEACHER_REV');
    assert.deepEqual([(late.response.current as { rev: number }).rev, (late.response.current as { note: string }).note], [2, 'Studiebesök i Eksjö']);
    const lateDiscard = await refusedWith(() => teacherService.discard(g4a, monDraft, 1, karin));
    assert.equal(lateDiscard.response.code, 'CLASS_TEACHER_REV');
    // A draft is about a lesson and a writer for good.
    await assert.rejects(() => owner.query(`UPDATE "ClassTeacherChanges" SET "calendarLessonId" = $2 WHERE id = $1`, [monDraft, lThu]), /CLASS_TEACHER_CHANGE_IS_FIXED/);
    await teacherService.discard(g4a, monDraft, 2, karin);
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ClassTeacherChanges" WHERE id = $1`, [monDraft])).n, 0);
    const gone = await refusedWith(() => teacherService.discard(g4a, monDraft, 2, karin));
    assert.equal(gone.status, 404);
  });

  await check('(kl-d) the live check names a clash by what clashes and says nothing of who teaches it', async () => {
    const mon = await occasion(lMon);
    // Tuesday 10:00-10:30 in Sal 2 is Lars’s lesson of 4B: the room is taken, and so is nothing else.
    const clash = await teacherService.preview(g4a, { kind: 'OCCASION_MOVE', calendarLessonId: lMon, targetDate: tuesday, targetStart: '10:00', targetEnd: '10:30', targetRoomId: sal2 }, karin);
    assert.equal(clash.verdict.state, 'CONFLICT');
    const conflicts = (clash.verdict as { conflicts: Array<{ kind: string; other?: { className: string; subjectName: string } }> }).conflicts;
    assert.deepEqual(conflicts.map((c) => c.kind), ['ROOM']);
    assert.deepEqual([conflicts[0]!.other!.className, conflicts[0]!.other!.subjectName], ['4B', 'Matematik']);
    assert.equal(JSON.stringify(clash).includes(lars.userId!), false);
    assert.equal(JSON.stringify(clash).includes('Probe'), false);
    // The same hour in Sal 1 is free; so is another hour in Sal 2.
    const free = await teacherService.preview(g4a, { kind: 'OCCASION_MOVE', calendarLessonId: lMon, targetDate: tuesday, targetStart: '10:00', targetEnd: '10:30', targetRoomId: sal1 }, karin);
    assert.deepEqual(free.verdict, { state: 'OK' });
    // A template move into the same hour as Lars’s lesson meets the editor’s own check.
    const weekly = await teacherService.preview(g4a, { kind: 'TEMPLATE_MOVE', masterLessonId: mWed, targetDayOfWeek: 2, targetStart: '10:00', targetEnd: '10:30', targetRoomId: sal2 }, karin);
    assert.equal(weekly.verdict.state, 'CONFLICT');
    assert.equal(mon.refusal, null);
    // Nothing was written.
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ClassTeacherChanges" WHERE "schoolId" = $1`, [s])).n, 0);
    // A lov closes the day: a move onto it is a clash, found by the same rule a publish skips a date by.
    await owner.query(
      `INSERT INTO "SchoolBreaks" ("schoolId", "academicYearId", name, kind, "startDate", "endDate", "updatedAt") VALUES ($1, $2, 'Lov', 'HOLIDAY', $3::date, $3::date, now())`,
      [s, year, tuesday],
    );
    const lov = await teacherService.preview(g4a, { kind: 'OCCASION_MOVE', calendarLessonId: lMon, targetDate: tuesday, targetStart: '11:00', targetEnd: '11:30' }, karin);
    assert.deepEqual((lov.verdict as { conflicts: Array<{ kind: string }> }).conflicts.map((c) => c.kind), ['BREAK']);
    await owner.query(`DELETE FROM "SchoolBreaks" WHERE "schoolId" = $1`, [s]);
  });

  await check('(kl-e) the schemaläggare publishes a draft: the room changes through the day operations and the draft stays as the record, in Sara’s name', async () => {
    const thu = await occasion(lThu, thursday);
    const made = await teacherService.create(g4a, { kind: 'OCCASION_ROOM', calendarLessonId: lThu, baseVersion: thu.version, targetRoomId: sal2 }, karin);
    const drafts = await adminService.drafts(g4a, sara);
    assert.deepEqual(drafts.map((row) => [row.change.id, row.className, row.verdict.state]), [[made.id, '4A', 'OK']]);
    const outcomes = await adminService.publish(g4a, undefined, sara);
    assert.deepEqual(outcomes.outcomes, [{ id: made.id, outcome: 'PUBLISHED' }]);
    assert.equal((await one<{ roomId: string }>(`SELECT "roomId" FROM "CalendarLessons" WHERE id = $1`, [lThu])).roomId, sal2);
    const record = await one<{ status: string; publishedByUserId: string; publishedAt: Date | null; rev: number }>(
      `SELECT status, "publishedByUserId", "publishedAt", rev FROM "ClassTeacherChanges" WHERE id = $1`,
      [made.id],
    );
    assert.deepEqual([record.status, record.publishedByUserId, record.publishedAt !== null, record.rev], ['PUBLISHED', sara.userId, true, 2]);
    // A published draft is a record: nobody discards it.
    assert.equal((await refusedWith(() => adminService.discard(made.id, sara))).status, 404);
    await owner.query(`UPDATE "CalendarLessons" SET "roomId" = $2 WHERE id = $1`, [lThu, sal1]);
  });

  await check('(kl-f) the school’s option: refused while off; on, Karin publishes their own class, carried out as the administrator who appointed them', async () => {
    const mon = await occasion(lMon);
    const made = await teacherService.create(g4a, { kind: 'OCCASION_CANCEL', calendarLessonId: lMon, baseVersion: mon.version, note: 'Inställd av klassläraren' }, karin);
    const off = await refusedWith(() => teacherService.publish(g4a, {}, karin));
    assert.deepEqual([off.status, off.response.code], [403, 'CLASS_TEACHER_PUBLISH_OFF']);
    assert.equal((await one<{ status: string }>(`SELECT status FROM "CalendarLessons" WHERE id = $1`, [lMon])).status, 'SCHEDULED');
    assert.deepEqual(await adminService.updateSettings({ selfPublish: true }, sara), { selfPublish: true });
    const done = await teacherService.publish(g4a, { changeIds: [made.id] }, karin);
    assert.deepEqual(done.outcomes, [{ id: made.id, outcome: 'PUBLISHED' }]);
    const lesson = await one<{ status: string; cancelCause: string; note: string }>(`SELECT status, "cancelCause", note FROM "CalendarLessons" WHERE id = $1`, [lMon]);
    assert.deepEqual([lesson.status, lesson.cancelCause, lesson.note], ['CANCELLED', 'MANUAL', 'Inställd av klassläraren']);
    assert.equal((await one<{ by: string }>(`SELECT "publishedByUserId" AS by FROM "ClassTeacherChanges" WHERE id = $1`, [made.id])).by, sara.userId);
    // A cancelled lesson is closed to a second change.
    const again = await refusedWith(() => teacherService.create(g4a, { kind: 'OCCASION_ROOM', calendarLessonId: lMon, baseVersion: 'a'.repeat(32), targetRoomId: sal2 }, karin));
    assert.equal(again.response.reason, 'NOT_SCHEDULED');
    await adminService.updateSettings({ selfPublish: false }, sara);
  });

  await check('(kl-g) a lesson of the grundschema moved, and a long one split in two, through the editor’s own services', async () => {
    const wed = await template(mWed);
    const move = await teacherService.create(g4a, { kind: 'TEMPLATE_MOVE', masterLessonId: mWed, baseVersion: wed.version, targetDayOfWeek: 3, targetStart: '10:00', targetEnd: '11:00' }, karin);
    assert.deepEqual((await adminService.publish(g4a, [move.id], sara)).outcomes, [{ id: move.id, outcome: 'PUBLISHED' }]);
    const moved = await one<{ dayOfWeek: number; startTime: string; endTime: string }>(`SELECT "dayOfWeek", "startTime"::text, "endTime"::text FROM "MasterLessons" WHERE id = $1`, [mWed]);
    assert.deepEqual([moved.dayOfWeek, moved.startTime, moved.endTime], [3, '10:00:00', '11:00:00']);

    const after = await template(mWed);
    const split = await teacherService.create(
      g4a,
      { kind: 'TEMPLATE_SPLIT', masterLessonId: mWed, baseVersion: after.version, targetDayOfWeek: 3, targetStart: '11:00', targetEnd: '11:30', keepEnd: '10:30', targetRoomId: sal2 },
      karin,
    );
    assert.deepEqual((await adminService.publish(g4a, [split.id], sara)).outcomes, [{ id: split.id, outcome: 'PUBLISHED' }]);
    const parts = await all<{ id: string; startTime: string; endTime: string; roomId: string; teacherId: string; subjectId: string }>(
      `SELECT id, "startTime"::text, "endTime"::text, "roomId", "teacherId", "subjectId" FROM "MasterLessons" WHERE "studentGroupId" = $1 AND "subjectId" = $2 ORDER BY "startTime"`,
      [g4a, engelska],
    );
    assert.deepEqual(parts.map((row) => [row.startTime, row.endTime, row.roomId]), [['10:00:00', '10:30:00', sal1], ['11:00:00', '11:30:00', sal2]]);
    assert.ok(parts.every((row) => row.teacherId === karin.userId && row.subjectId === engelska), 'both parts are the same teacher’s and subject’s');
    // The log of the editor has both writes, in the actor’s name.
    const log = await all<{ action: string; actorId: string }>(`SELECT action, "actorId" FROM "ScheduleChangeLogs" WHERE "schoolId" = $1 ORDER BY "createdAt"`, [s]);
    assert.ok(log.length >= 3 && log.every((row) => row.actorId === sara.userId));
  });

  await check('(kl-h) a clash found when the draft is published stops it and leaves the lesson as it was', async () => {
    const thu = await occasion(lThu, thursday);
    const made = await teacherService.create(g4a, { kind: 'OCCASION_MOVE', calendarLessonId: lThu, baseVersion: thu.version, targetDate: tuesday, targetStart: '10:00', targetEnd: '10:30', targetRoomId: sal1 }, karin);
    // Lars’s lesson moves into Sal 1 at that hour after the draft was made: the room is taken.
    await owner.query(`UPDATE "CalendarLessons" SET "roomId" = $2 WHERE id = $1`, [lTue4b, sal1]);
    const outcomes = (await adminService.publish(g4a, [made.id], sara)).outcomes;
    assert.equal(outcomes[0]!.outcome, 'CONFLICT');
    const lesson = await one<{ date: string; roomId: string }>(`SELECT date::text, "roomId" FROM "CalendarLessons" WHERE id = $1`, [lThu]);
    assert.deepEqual([lesson.date, lesson.roomId], [thursday, sal1]);
    assert.equal((await one<{ status: string }>(`SELECT status FROM "ClassTeacherChanges" WHERE id = $1`, [made.id])).status, 'DRAFT');
    await owner.query(`UPDATE "CalendarLessons" SET "roomId" = $2 WHERE id = $1`, [lTue4b, sal2]);
    // Out of the way, the same draft goes (the lesson is what it was when it was written).
    const retried = (await adminService.publish(g4a, [made.id], sara)).outcomes;
    assert.deepEqual(retried, [{ id: made.id, outcome: 'PUBLISHED' }]);
    const moved = await one<{ date: string; start: string }>(`SELECT date::text, to_char("startsAt" AT TIME ZONE 'Europe/Stockholm', 'HH24:MI') AS start FROM "CalendarLessons" WHERE id = $1`, [lThu]);
    assert.deepEqual([moved.date, moved.start], [tuesday, '10:00']);
  });

  await check('(kl-i) an appointment whose administrator is gone or no longer writes what the work needs lapses with a code, and mends', async () => {
    await owner.query(`UPDATE "Users" SET "isActive" = false WHERE id = $1`, [sara.userId]);
    const lapsed = await refusedWith(() => teacherService.check(g4a, karin));
    assert.deepEqual([lapsed.status, lapsed.response.code], [409, 'CLASS_TEACHER_APPOINTER_GONE']);
    await owner.query(`UPDATE "Users" SET "isActive" = true, "adminProfile" = 'EXPEDITION' WHERE id = $1`, [sara.userId]);
    assert.equal((await refusedWith(() => teacherService.preview(g4a, { kind: 'OCCASION_CANCEL', calendarLessonId: lThu }, karin))).response.code, 'CLASS_TEACHER_APPOINTER_GONE');
    const list = await adminService.appointments(year, expedition);
    assert.deepEqual(list.map((row) => [row.className, row.runs]), [['4A', false]]);
    await owner.query(`UPDATE "Users" SET "adminProfile" = 'SCHEMALAGGARE' WHERE id = $1`, [sara.userId]);
    assert.deepEqual((await teacherService.check(g4a, karin)).length, 0);
    assert.deepEqual((await adminService.appointments(year, sara)).map((row) => row.runs), [true]);
    // The schemaläggare takes it over, in their own name, by appointing again.
    const taken = await adminService.appoint({ studentGroupId: g4a, userId: karin.userId! }, sara);
    assert.equal(taken.length, 1);
  });

  await check('(kl-j) two writers of the same lesson at once leave one draft and one 409, never two drafts and never a silent loss', async () => {
    const thu = await occasion(lThu, tuesday);
    const results = await Promise.allSettled([
      teacherService.create(g4a, { kind: 'OCCASION_ROOM', calendarLessonId: lThu, baseVersion: thu.version, targetRoomId: sal2 }, karin),
      teacherService.create(g4a, { kind: 'OCCASION_CANCEL', calendarLessonId: lThu, baseVersion: thu.version }, karin),
    ]);
    const made = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(made.length, 1, 'exactly one draft was written');
    assert.equal(refused.length, 1);
    assert.equal((refused[0]!.reason as { getResponse: () => { code: string } }).getResponse().code, 'CLASS_TEACHER_DRAFT_EXISTS');
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ClassTeacherChanges" WHERE "calendarLessonId" = $1 AND status = 'DRAFT'`, [lThu])).n, 1);
    // Two edits at the same revision: one wins, the other is told how it stands.
    const id = (made[0] as PromiseFulfilledResult<{ id: string }>).value.id;
    const edits = await Promise.allSettled([
      teacherService.update(g4a, id, { rev: 1, note: 'A' }, karin),
      teacherService.update(g4a, id, { rev: 1, note: 'B' }, karin),
    ]);
    assert.equal(edits.filter((r) => r.status === 'fulfilled').length, 1);
    const lost = edits.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal((lost.reason as { getResponse: () => { code: string } }).getResponse().code, 'CLASS_TEACHER_REV');
    const kept = await one<{ note: string; rev: number }>(`SELECT note, rev FROM "ClassTeacherChanges" WHERE id = $1`, [id]);
    assert.equal(kept.rev, 2);
    assert.ok(['A', 'B'].includes(kept.note));
  });

  // The rows a klasslärare reads and writes through the API’s role are the class’s own, whatever the service asks.
  await check('(kl-k) through the API’s role, a klasslärare reads and writes only their class’s drafts, and nothing of another school', async () => {
    const ownRows = await api.withRls(karin, (tx) => tx.classTeacherChange.findMany({ select: { id: true, studentGroupId: true } }));
    assert.ok(ownRows.every((row) => row.studentGroupId === g4a));
    const larsRows = await api.withRls(lars, (tx) => tx.classTeacherChange.findMany({ select: { id: true } }));
    assert.deepEqual(larsRows, []);
    const removed = await api.withRls(lars, (tx) => tx.classTeacherChange.deleteMany({}));
    assert.equal(removed.count, 0);
  });

}
