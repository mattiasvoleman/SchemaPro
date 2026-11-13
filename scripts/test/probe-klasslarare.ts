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
 *   kl-j  two writers of the same lesson at once: one draft, one 409;
 *   kl-k  through the API's role, only the class's drafts;
 *   kl-l  two who publish the same split at once carry it out once, six rounds;
 *   kl-m  a date's lesson moved: a change after the check is met under the lock, the row lock and the school's
 *         publication lock are waited for;
 *   kl-n  the board's rules (ramtid, the class's meal, a closure on årskurser) for the template and for a date,
 *         and a date held to the pupils of a teaching group and to the ombyte before and after;
 *   kl-o  a change of the template says what it takes out of the calendar, meets a lesson moved for its date, and
 *         shows a draft school's grundschema to nobody who may not read it;
 *   kl-p  a läsår that has ended, a date outside the läsår, the klasslärare's words added to the lesson's note;
 *   kl-q  a room changed for one date and published is not written back by a later change of the template: it is a
 *         clash (EXCEPTION) until the room is put back, and then the change goes through;
 *   kl-r  a room the school shares (Delade salar, G3) holds two classes whose pupils fit it and refuses three, and the
 *         klasslärare's verdict says what the editor's own check (the one the swaps of G1 are applied through) says,
 *         for a lesson of the template and for one date, and what the gate of a room change on one date says;
 *   kl-s  a lesson an exam week (G4, through the schedule activities of D3) has cancelled, and the replacement lesson
 *         it laid, meet the klasslärare as named reasons and never as an error, for a draft written before and one
 *         written after; a change of the template goes on over the cancelled lesson and leaves it be;
 *   kl-t  a lesson Generera wrote from a förläggning is no draft of the template's to move: refused with its reason in the list, the
 *         check, the draft and the publication, whether the draft was written before or after it was placed.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { CalendarLessonsService } from '../../src/calendar/calendar-lessons.service';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { ScheduleActivitiesService } from '../../src/publication/schedule-activities.service';
import { ClassTeacherAdminService } from '../../src/class-teacher/class-teacher-admin.service';
import { ClassTeacherEngine } from '../../src/class-teacher/class-teacher-engine';
import { ClassTeacherService } from '../../src/class-teacher/class-teacher.service';
import type { PrismaService } from '../../src/database/prisma.service';
import { rostersOfYear } from '../../src/year-rollover/projected-rosters';
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
    // The global filter forwards a problem's code and flat params only, so the draft is named by id.
    assert.equal((twice.response.params as { draftId: string }).draftId, made.id);

    // The Thursday’s room changes under Karin, and a draft against the old version is refused with the lesson as it is.
    const thu = await occasion(lThu, thursday);
    await owner.query(`UPDATE "CalendarLessons" SET "roomId" = $2 WHERE id = $1`, [lThu, sal2]);
    const stale = await refusedWith(() => teacherService.create(g4a, { kind: 'OCCASION_CANCEL', calendarLessonId: lThu, baseVersion: thu.version }, karin));
    assert.equal(stale.status, 409);
    assert.equal(stale.response.code, 'CLASS_TEACHER_STALE');
    const nowThu = await occasion(lThu, thursday);
    assert.notEqual(nowThu.version, thu.version);
    assert.equal((stale.response.params as { version: string }).version, nowThu.version);
    await owner.query(`UPDATE "CalendarLessons" SET "roomId" = $2 WHERE id = $1`, [lThu, sal1]);

    // Another class’s lesson, asked for in Karin’s class: the frame says whose it is.
    const other = await refusedWith(() => teacherService.create(g4a, { kind: 'OCCASION_CANCEL', calendarLessonId: lTue4b, baseVersion: 'a'.repeat(32) }, karin));
    assert.equal(other.status, 403);
    assert.deepEqual([other.response.code, (other.response.params as { reason: string }).reason], ['CLASS_TEACHER_OUTSIDE_FRAME', 'OTHER_CLASS']);
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
    assert.deepEqual([closed.response.code, (closed.response.params as { reason: string }).reason], ['CLASS_TEACHER_OUTSIDE_FRAME', 'TARGET_CLOSED']);
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ClassTeacherChanges" WHERE "schoolId" = $1`, [s])).n, 1);
  });

  await check('(kl-c) a draft edited at its revision moves to the next; the writer who read the old one is told how it stands now, and so is a discard', async () => {
    const edited = await teacherService.update(g4a, monDraft, { rev: 1, note: 'Studiebesök i Eksjö' }, karin);
    assert.deepEqual([edited.rev, edited.note], [2, 'Studiebesök i Eksjö']);
    const late = await refusedWith(() => teacherService.update(g4a, monDraft, { rev: 1, note: 'Mitt' }, karin));
    assert.equal(late.status, 409);
    assert.equal(late.response.code, 'CLASS_TEACHER_REV');
    assert.equal((late.response.params as { rev: number }).rev, 2);
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
    // Revision 1 as written, 2 as claimed by the publication, 3 as published.
    assert.deepEqual([record.status, record.publishedByUserId, record.publishedAt !== null, record.rev], ['PUBLISHED', sara.userId, true, 3]);
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
    assert.equal((again.response.params as { reason: string }).reason, 'NOT_SCHEDULED');
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

  // ------------------------------------------------------------------------------------------------------------
  // What the review of the first version found (PR 286). Each check is the scenario that was shown, run again.
  // ------------------------------------------------------------------------------------------------------------
  const idrott = await subject('Idrott', 'KLID');
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** A second connection as the owner, for a lock held beside the services. */
  const holder = async () => {
    const connection = new Client((owner as unknown as { connectionParameters: object }).connectionParameters);
    await connection.connect();
    return connection;
  };
  const verdictOf = async (body: Parameters<typeof teacherService.preview>[1]) => (await teacherService.preview(g4a, body, karin)).verdict;
  const kindsOf = (verdict: { state: string }) => ((verdict as { conflicts?: Array<{ kind: string }> }).conflicts ?? []).map((one) => one.kind);

  await check('(kl-l) two who publish the same split at once carry it out once: one PUBLISHED, the other GONE, two lessons and not three, in six rounds', async () => {
    for (let round = 1; round <= 6; round++) {
      const lesson = await master(svenska, g4a, sal1, karin, 1, '10:00', '11:00');
      const made = await teacherService.create(
        g4a,
        { kind: 'TEMPLATE_SPLIT', masterLessonId: lesson, baseVersion: (await template(lesson)).version, targetDayOfWeek: 1, targetStart: '10:30', targetEnd: '11:00', keepEnd: '10:30' },
        karin,
      );
      const both = await Promise.allSettled([adminService.publish(g4a, [made.id], sara), adminService.publish(g4a, [made.id], sara)]);
      const outcomes = both.map((one) => (one.status === 'fulfilled' ? one.value.outcomes[0]!.outcome : `ERROR ${String((one as PromiseRejectedResult).reason)}`));
      assert.deepEqual([...outcomes].sort(), ['GONE', 'PUBLISHED'], `round ${round}: ${outcomes.join(', ')}`);
      const parts = await all<{ s: string; e: string }>(
        `SELECT "startTime"::text AS s, "endTime"::text AS e FROM "MasterLessons" WHERE "studentGroupId" = $1 AND "subjectId" = $2 AND "dayOfWeek" = 1 AND "startTime" >= '10:00' ORDER BY "startTime"`,
        [g4a, svenska],
      );
      assert.deepEqual(parts.map((part) => [part.s, part.e]), [['10:00:00', '10:30:00'], ['10:30:00', '11:00:00']], `round ${round}: the lesson is split once`);
      const record = await one<{ status: string; rev: number }>(`SELECT status, rev FROM "ClassTeacherChanges" WHERE id = $1`, [made.id]);
      assert.deepEqual([record.status, record.rev], ['PUBLISHED', 3], `round ${round}: claimed once, published once`);
      await owner.query(`DELETE FROM "MasterLessons" WHERE "studentGroupId" = $1 AND "subjectId" = $2 AND "dayOfWeek" = 1 AND "startTime" >= '10:00'`, [g4a, svenska]);
      await owner.query(`DELETE FROM "ClassTeacherChanges" WHERE id = $1`, [made.id]);
    }
  });

  await check('(kl-m) a date’s lesson moved: a change after the check is met under the lock, the lesson’s row lock and the school’s publication lock are waited for', async () => {
    const wednesday = await plus(monday, 2);
    const lessonMaster = await master(matte, g4a, sal1, karin, 3, '11:30', '12:00');
    const lesson = await dated(lessonMaster, matte, g4a, sal1, karin, wednesday, '11:30', '12:00');
    const made = await teacherService.create(
      g4a,
      { kind: 'OCCASION_MOVE', calendarLessonId: lesson, baseVersion: (await occasion(lesson, wednesday)).version, targetDate: thursday, targetStart: '11:00', targetEnd: '11:30' },
      karin,
    );
    const row = (await api.withRls(sara, (tx) => tx.classTeacherChange.findUnique({ where: { id: made.id } })))!;
    const move = () => (engine as unknown as { moveOccasion: (actor: AuthenticatedUser, change: unknown) => Promise<void> }).moveOccasion(sara, row);
    const untouched = async () => {
      const now = await one<{ date: string }>(`SELECT date::text FROM "CalendarLessons" WHERE id = $1`, [lesson]);
      assert.equal(now.date, wednesday, 'the lesson stayed where it was');
    };

    // The check judged it; then somebody changed the room, which is the lesson's version. The writer reads the lesson again.
    await owner.query(`UPDATE "CalendarLessons" SET "roomId" = $2 WHERE id = $1`, [lesson, sal2]);
    const changed = await refusedWith(move);
    assert.deepEqual([changed.status, String(changed.response.message)], [409, 'The lesson has changed.']);
    await untouched();
    await owner.query(`UPDATE "CalendarLessons" SET "roomId" = $2 WHERE id = $1`, [lesson, sal1]);

    // Another transaction holds the lesson's row: the writer waits for it, and meets the version it leaves.
    const writer = await holder();
    try {
      await writer.query('BEGIN');
      await writer.query(`SELECT id FROM "CalendarLessons" WHERE id = $1 FOR UPDATE`, [lesson]);
      let settled = false;
      const waiting = refusedWith(move).finally(() => {
        settled = true;
      });
      await sleep(1500);
      assert.equal(settled, false, 'the writer waits for the lesson’s row lock');
      await writer.query(`UPDATE "CalendarLessons" SET "roomId" = $2 WHERE id = $1`, [lesson, sal2]);
      await writer.query('COMMIT');
      const after = await waiting;
      assert.equal(after.response.message, 'The lesson has changed.', 'and, the lock got, reads the lesson as the other left it');
      await untouched();
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await writer.end();
    }
    await owner.query(`UPDATE "CalendarLessons" SET "roomId" = $2 WHERE id = $1`, [lesson, sal1]);

    // The school's publication holds the grundschema exclusively: the writer waits for it and answers 409 after five seconds.
    const publication = await holder();
    try {
      await publication.query('BEGIN');
      await publication.query(`SELECT pg_advisory_xact_lock(hashtext('publication'), hashtext($1::uuid::text))`, [s]);
      const started = Date.now();
      const busy = await refusedWith(move);
      assert.deepEqual([busy.status, busy.response.code], [409, 'PUBLISH_IN_PROGRESS']);
      assert.ok(Date.now() - started >= 4000, 'it waited for the publication');
      await untouched();
    } finally {
      await publication.query('ROLLBACK').catch(() => undefined);
      await publication.end();
    }

    // Nothing in the way: it goes, and the draft is the record of it once published.
    const done = await adminService.publish(g4a, [made.id], sara);
    assert.deepEqual(done.outcomes, [{ id: made.id, outcome: 'PUBLISHED' }]);
    assert.equal((await one<{ date: string }>(`SELECT date::text FROM "CalendarLessons" WHERE id = $1`, [lesson])).date, thursday);
  });

  await check('(kl-n) the board’s rules hold a lesson of the template and of a date, and a date is held to the pupils of a teaching group and to the ombyte', async () => {
    const tuesdayDate = tuesday;
    await owner.query(
      `INSERT INTO "ClassTeacherOpenTimes" ("schoolId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime") SELECT $1, $2, $3, d, '07:00', '18:00' FROM generate_series(1, 4) d`,
      [s, year, g4a],
    );
    await owner.query(`INSERT INTO "FrameTimes" ("schoolId", "minGradeLevel", "maxGradeLevel", "dayOfWeek", "startTime", "endTime", "updatedAt") VALUES ($1, 1, 6, NULL, '08:00', '15:00', now())`, [s]);
    // The class's weekly meal is Tuesday 09:00-09:30; the one laid for the date is 11:30-12:00 (and replaces it that day).
    await owner.query(`INSERT INTO "LunchSittings" ("schoolId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "updatedAt") VALUES ($1, $2, $3, 2, '09:00', '09:30', now())`, [s, year, g4a]);
    await owner.query(
      `INSERT INTO "CalendarLunches" ("schoolId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
       VALUES ($1, $2, $3::date, ($3::date + time '11:30') AT TIME ZONE 'Europe/Stockholm', ($3::date + time '12:00') AT TIME ZONE 'Europe/Stockholm', now())`,
      [s, g4a, tuesdayDate],
    );
    await owner.query(
      `INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", type, "dayOfWeek", "startTime", "endTime", "minGradeLevel", "maxGradeLevel", "updatedAt")
       VALUES ($1, 'GRADE_LEVEL', 'UNAVAILABLE', 4, '13:00', '14:00', 1, 6, now())`,
      [s],
    );
    const lesson = await master(matte, g4a, sal1, karin, 1, '12:00', '13:00');
    const lessonDated = await dated(lesson, matte, g4a, sal1, karin, monday, '12:00', '13:00');
    const move = (day: number, from: string, to: string) => verdictOf({ kind: 'TEMPLATE_MOVE', masterLessonId: lesson, targetDayOfWeek: day, targetStart: from, targetEnd: to });
    const moveDate = (date: string, from: string, to: string) => verdictOf({ kind: 'OCCASION_MOVE', calendarLessonId: lessonDated, targetDate: date, targetStart: from, targetEnd: to });

    // The template: after the stage's day, on the class's meal, and in an hour closed to its year.
    assert.deepEqual(kindsOf(await move(2, '15:30', '16:30')), ['FRAME']);
    assert.deepEqual(kindsOf(await move(2, '09:00', '09:30')), ['LUNCH']);
    assert.deepEqual(kindsOf(await move(4, '13:00', '13:30')), ['GRADE_RULE']);
    assert.deepEqual(await move(2, '12:00', '13:00'), { state: 'OK' });
    // A date: the same three, and the date's own meal in place of the week's.
    assert.deepEqual(kindsOf(await moveDate(tuesdayDate, '15:30', '16:30')), ['FRAME']);
    assert.deepEqual(kindsOf(await moveDate(tuesdayDate, '11:30', '12:00')), ['LUNCH']);
    assert.deepEqual(await moveDate(tuesdayDate, '09:00', '09:30'), { state: 'OK' });
    assert.deepEqual(kindsOf(await moveDate(thursday, '13:00', '13:30')), ['GRADE_RULE']);
    assert.deepEqual(await moveDate(thursday, '12:00', '13:00'), { state: 'OK' });
    // A rule the school has not written holds nothing: the ramtid taken away, the template may go there.
    await owner.query(`DELETE FROM "FrameTimes" WHERE "schoolId" = $1`, [s]);
    assert.deepEqual(await move(2, '15:30', '16:30'), { state: 'OK' });

    // A teaching group that holds two of the class's pupils has a lesson on the Tuesday at noon, with another teacher.
    const mix = (
      await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, '4mix', 'TEACHING_GROUP', 4, now()) RETURNING id`, [s, year])
    ).id;
    for (const label of ['elev1', 'elev2']) {
      const pupil = (
        await one<{ id: string }>(
          `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "studentGroupId", "authId", "isActive", "updatedAt")
           VALUES ($1, $2, $3, 'Probe', 'STUDENT', $4, $5, true, now()) RETURNING id`,
          [s, `${marker}-kl-${label}@example.invalid`, label, g4a, randomUUID()],
        )
      ).id;
      await owner.query(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES ($1, $2, $3)`, [s, mix, pupil]);
    }
    const mixMaster = await master(idrott, mix, sal3, lars, 2, '12:00', '13:00');
    await dated(mixMaster, idrott, mix, sal3, lars, tuesdayDate, '12:00', '13:00');
    // The week's rule has always seen it; the date's rule now sees it too: no room, teacher or class in common, only pupils.
    const week = await move(2, '12:00', '13:00');
    assert.deepEqual(kindsOf(week), ['GROUP'], JSON.stringify(week));
    const onDate = await moveDate(tuesdayDate, '12:00', '13:00');
    assert.deepEqual(kindsOf(onDate), ['GROUP'], JSON.stringify(onDate));
    assert.deepEqual(
      (onDate as { conflicts: Array<{ other?: { className: string; subjectName: string; date?: string } }> }).conflicts[0]!.other,
      { className: '4mix', subjectName: 'Idrott', date: tuesdayDate, start: '12:00', end: '13:00' },
    );
    assert.equal(JSON.stringify(onDate).includes(lars.userId!), false, 'nobody is named');

    // Ombyte and dusch: a gym lesson of 4A on the Monday morning with twenty minutes of shower after it.
    await owner.query(`INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "studentGroupId", "subjectId", "minutesAfter", "updatedAt") VALUES ($1, $2, $3, $4, 20, now())`, [s, year, g4a, idrott]);
    const gym = await master(idrott, g4a, sal3, karin, 1, '10:00', '11:00');
    await dated(gym, idrott, g4a, sal3, karin, monday, '10:00', '11:00');
    assert.deepEqual(kindsOf(await move(1, '11:00', '12:00')), ['GROUP']);
    assert.deepEqual(kindsOf(await moveDate(monday, '11:00', '12:00')), ['GROUP']);
    assert.deepEqual(await moveDate(monday, '11:20', '12:20'), { state: 'OK' });

    for (const sql of [
      `DELETE FROM "TeachingRequirements" WHERE "schoolId" = $1`,
      `DELETE FROM "AvailabilityConstraints" WHERE "schoolId" = $1`,
      `DELETE FROM "CalendarLunches" WHERE "schoolId" = $1`,
      `DELETE FROM "LunchSittings" WHERE "schoolId" = $1`,
      `DELETE FROM "ClassTeacherOpenTimes" WHERE "schoolId" = $1 AND "studentGroupId" IS NOT NULL`,
      `DELETE FROM "CalendarLessons" WHERE "schoolId" = $1 AND "masterLessonId" = ANY ($2::uuid[])`,
      `DELETE FROM "MasterLessons" WHERE "schoolId" = $1 AND id = ANY ($2::uuid[])`,
    ]) {
      await owner.query(sql, sql.includes('$2') ? [s, [lesson, mixMaster, gym]] : [s]);
    }
    await owner.query(`DELETE FROM "StudentGroupMembers" WHERE "studentGroupId" = $1`, [mix]);
    await owner.query(`DELETE FROM "StudentGroups" WHERE id = $1`, [mix]);
    await owner.query(`DELETE FROM "Users" WHERE "schoolId" = $1 AND role = 'STUDENT'`, [s]);
  });

  await check('(kl-o) a change of the template says what it takes out of the calendar, meets a lesson moved for its date, and a draft school’s grundschema is shown to nobody who may not read it', async () => {
    const ending = await master(svenska, g4a, sal1, karin, 1, '10:00', '11:00');
    await owner.query(`UPDATE "MasterLessons" SET "endDate" = $2::date WHERE id = $1`, [ending, await plus(monday, 7)]);
    const first = await dated(ending, svenska, g4a, sal1, karin, monday, '10:00', '11:00');
    const second = await dated(ending, svenska, g4a, sal1, karin, await plus(monday, 7), '10:00', '11:00');
    await owner.query(`INSERT INTO "LessonLogs" ("schoolId", "calendarLessonId", homework, "updatedAt") VALUES ($1, $2, 'Läs kapitel 4', now())`, [s, second]);
    const to = (day: number) => ({ kind: 'TEMPLATE_MOVE' as const, masterLessonId: ending, targetDayOfWeek: day, targetStart: '10:00', targetEnd: '11:00' });

    // A day later is Tuesday the 2nd week after: past the template's own end. One lesson goes, with the homework on it.
    assert.deepEqual(await verdictOf(to(2)), { state: 'OK', removes: { lessons: 1, withLog: 1 } });
    // The same day, and a split, take nothing.
    assert.deepEqual(await verdictOf({ ...to(1), targetStart: '10:00', targetEnd: '11:00' }), { state: 'OK' });

    // The first Monday was moved for its date to the Tuesday (a published exception). A change of the template would carry it
    // to a third day, so it is met as a clash and the lesson stays where it is.
    await owner.query(
      `UPDATE "CalendarLessons" SET date = $2::date, "startsAt" = ($2::date + time '13:00') AT TIME ZONE 'Europe/Stockholm', "endsAt" = ($2::date + time '14:00') AT TIME ZONE 'Europe/Stockholm' WHERE id = $1`,
      [first, tuesday],
    );
    const meets = await verdictOf(to(4));
    assert.deepEqual(kindsOf(meets), ['EXCEPTION']);
    assert.deepEqual((meets as { conflicts: Array<{ other?: unknown }> }).conflicts[0]!.other, { className: '4A', subjectName: 'Svenska', date: tuesday, start: '13:00', end: '14:00' });
    const made = await teacherService.create(g4a, { ...to(4), baseVersion: (await template(ending)).version }, karin);
    const refused = (await adminService.publish(g4a, [made.id], sara)).outcomes;
    assert.equal(refused[0]!.outcome, 'CONFLICT');
    const stays = await one<{ date: string; dow: number }>(`SELECT date::text, extract(isodow FROM date)::int AS dow FROM "CalendarLessons" WHERE id = $1`, [first]);
    assert.deepEqual([stays.date, stays.dow], [tuesday, 2], 'the exception stands on its own day, not on a third');
    assert.equal((await one<{ dayOfWeek: number }>(`SELECT "dayOfWeek" FROM "MasterLessons" WHERE id = $1`, [ending])).dayOfWeek, 1);
    // Once the date has passed it is history, and no longer in the way.
    await owner.query(`UPDATE "CalendarLessons" SET date = current_date - 30, "startsAt" = now() - interval '30 days', "endsAt" = now() - interval '30 days' + interval '1 hour' WHERE id = $1`, [first]);
    assert.equal(kindsOf(await verdictOf(to(4))).includes('EXCEPTION'), false);
    await teacherService.discard(g4a, made.id, 1, karin);

    // A school that publishes through a draft hides its grundschema from teachers; the klasslärare's own check must not show it.
    await owner.query(`INSERT INTO "PublicationSettings" ("schoolId", "publishMode", "updatedAt") VALUES ($1, 'DRAFT', now()) ON CONFLICT ("schoolId") DO UPDATE SET "publishMode" = 'DRAFT'`, [s]);
    try {
      assert.equal(await api.withRls(lars, (tx) => tx.masterLesson.count()), 0, 'a teacher reads no grundschema in a draft school');
      // 4B's Tuesday 10:00-10:30 in Sal 2 is Lars's: Karin asks for the room at that hour, and is told the room is taken, not whose lesson.
      const body = { kind: 'TEMPLATE_MOVE' as const, masterLessonId: ending, targetDayOfWeek: 2, targetStart: '10:00', targetEnd: '10:30', targetRoomId: sal2 };
      const hidden = await teacherService.preview(g4a, body, karin);
      assert.ok(kindsOf(hidden.verdict).includes('ROOM'));
      assert.equal(JSON.stringify(hidden).includes('4B'), false, 'no other class is named');
      assert.equal(JSON.stringify(hidden).includes('Matematik'), false, 'no other subject is named');
      assert.equal((hidden.verdict as { conflicts: Array<{ other?: unknown }> }).conflicts.every((one) => one.other === undefined), true);
      // The administrator reads the same draft in full.
      const draft = await teacherService.create(g4a, { ...body, baseVersion: (await template(ending)).version }, karin);
      const full = (await adminService.drafts(g4a, sara)).find((row) => row.change.id === draft.id)!;
      assert.ok(JSON.stringify(full.verdict).includes('4B'), 'the administrator sees what the draft clashes with');
      // The klasslärare's live check, too: what a draft of the grundschema clashes with is the room, not the lesson. (A date's draft
      // of the same class may name the calendar's lesson, which the teacher reads; another draft's verdict is not this one's.)
      const checked = (await teacherService.check(g4a, karin)).find((row) => row.change.id === draft.id)!;
      assert.equal(JSON.stringify(checked.verdict).includes('4B'), false, `the live check shows no other class: ${JSON.stringify(checked.verdict)}`);
      assert.ok(kindsOf(checked.verdict).includes('ROOM'));
      await teacherService.discard(g4a, draft.id, 1, karin);
    } finally {
      await owner.query(`UPDATE "PublicationSettings" SET "publishMode" = 'DIRECT' WHERE "schoolId" = $1`, [s]);
    }
    await owner.query(`DELETE FROM "CalendarLessons" WHERE id = ANY ($1::uuid[])`, [[first, second]]);
    await owner.query(`DELETE FROM "MasterLessons" WHERE id = $1`, [ending]);
  });

  await check('(kl-p) a läsår that has ended is history, a date outside the läsår is no school day, and the klasslärare’s words are added to the lesson’s note', async () => {
    const oldYear = (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
         VALUES ($1, 'probe klasslärare förra året', current_date - 400, current_date - 40, false, 'NIOARIG', now()) RETURNING id`,
        [s],
      )
    ).id;
    const g3a = (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, '3A', 'CLASS', 3, now()) RETURNING id`, [s, oldYear])).id;
    const oldMaster = (
      await one<{ id: string }>(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, 1, '08:30', '09:30', now()) RETURNING id`,
        [s, oldYear, matte, g3a, karin.userId, sal1],
      )
    ).id;
    await owner.query(`INSERT INTO "ClassTeacherOpenTimes" ("schoolId", "academicYearId", "dayOfWeek", "startTime", "endTime") VALUES ($1, $2, 1, '08:00', '12:00')`, [s, oldYear]);
    await owner.query(`INSERT INTO "ClassTeacherAppointments" ("schoolId", "academicYearId", "studentGroupId", "userId", "appointedByUserId") VALUES ($1, $2, $3, $4, $5)`, [s, oldYear, g3a, karin.userId, sara.userId]);

    // Offered no more, and every change of its grundschema refused by name, also by the database.
    assert.deepEqual((await teacherService.mine(karin)).classes.map((row) => row.name), ['4A']);
    const lessons = (await weekOf(karin, g3a)).template;
    assert.deepEqual(lessons.map((row) => [row.id, row.refusal]), [[oldMaster, 'YEAR_ENDED']]);
    const ended = await refusedWith(() =>
      teacherService.create(g3a, { kind: 'TEMPLATE_MOVE', masterLessonId: oldMaster, baseVersion: lessons[0]!.version, targetDayOfWeek: 1, targetStart: '10:00', targetEnd: '11:00' }, karin),
    );
    assert.deepEqual([ended.status, ended.response.code, (ended.response.params as { reason: string }).reason], [403, 'CLASS_TEACHER_OUTSIDE_FRAME', 'YEAR_ENDED']);
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ClassTeacherChanges" WHERE "studentGroupId" = $1`, [g3a])).n, 0);

    // A date outside the läsår of the class: the Monday after its last day, inside the hours that are open.
    const afterYear = (await one<{ d: string }>(`SELECT (current_date + 450 + ((8 - extract(isodow FROM current_date + 450)::int) % 7) + 7)::text AS d`)).d;
    const lessonMaster = await master(matte, g4a, sal1, karin, 3, '09:00', '09:30');
    const lesson = await dated(lessonMaster, matte, g4a, sal1, karin, await plus(monday, 2), '09:00', '09:30');
    const wednesday = await plus(monday, 2);
    const version = (await occasion(lesson, wednesday)).version;
    const tooLate = await refusedWith(() =>
      teacherService.create(g4a, { kind: 'OCCASION_MOVE', calendarLessonId: lesson, baseVersion: version, targetDate: afterYear, targetStart: '09:00', targetEnd: '09:30' }, karin),
    );
    assert.deepEqual([tooLate.response.code, (tooLate.response.params as { reason: string }).reason], ['CLASS_TEACHER_OUTSIDE_FRAME', 'TARGET_CLOSED']);

    // The lesson's own note and the klasslärare's: both, not the one in place of the other.
    await owner.query(`UPDATE "CalendarLessons" SET note = 'Ta med gympakläder' WHERE id = $1`, [lesson]);
    const moved = await teacherService.create(
      g4a,
      { kind: 'OCCASION_MOVE', calendarLessonId: lesson, baseVersion: (await occasion(lesson, wednesday)).version, targetDate: thursday, targetStart: '08:00', targetEnd: '08:30', note: 'Flyttad pga besök' },
      karin,
    );
    assert.deepEqual((await adminService.publish(g4a, [moved.id], sara)).outcomes, [{ id: moved.id, outcome: 'PUBLISHED' }]);
    const after = await one<{ date: string; note: string }>(`SELECT date::text, note FROM "CalendarLessons" WHERE id = $1`, [lesson]);
    assert.deepEqual([after.date, after.note], [thursday, 'Ta med gympakläder · Flyttad pga besök']);
  });

  await check('(kl-q) a room changed for a date and published is not written back by a later change of the template: it is met as a clash until the room is put back', async () => {
    const lessonMaster = await master(svenska, g4a, sal1, karin, 1, '10:00', '11:00');
    const lesson = await dated(lessonMaster, svenska, g4a, sal1, karin, monday, '10:00', '11:00');
    const roomOf = async () => (await one<{ roomId: string; start: string }>(`SELECT "roomId", to_char("startsAt" AT TIME ZONE 'Europe/Stockholm', 'HH24:MI') AS start FROM "CalendarLessons" WHERE id = $1`, [lesson]));
    const later = { kind: 'TEMPLATE_MOVE' as const, masterLessonId: lessonMaster, targetDayOfWeek: 1, targetStart: '10:30', targetEnd: '11:30' };

    // Sal 1 is closed for the date, so Karin takes Sal 2 for it, and the schemaläggare publishes: the date's lesson stands in Sal 2.
    const room = await teacherService.create(g4a, { kind: 'OCCASION_ROOM', calendarLessonId: lesson, baseVersion: (await occasion(lesson)).version, targetRoomId: sal2 }, karin);
    assert.deepEqual((await adminService.publish(g4a, [room.id], sara)).outcomes, [{ id: room.id, outcome: 'PUBLISHED' }]);
    assert.equal((await roomOf()).roomId, sal2);

    // Then the template's hour is moved. The change would write the template's room, Sal 1, on every future lesson of it and take
    // the date's room back unasked; it is met as a clash that names the date, in the check and at publication, and nothing moves.
    const meets = await verdictOf(later);
    assert.deepEqual(kindsOf(meets), ['EXCEPTION'], JSON.stringify(meets));
    assert.deepEqual((meets as { conflicts: Array<{ other?: unknown }> }).conflicts[0]!.other, { className: '4A', subjectName: 'Svenska', date: monday, start: '10:00', end: '11:00' });
    const draft = await teacherService.create(g4a, { ...later, baseVersion: (await template(lessonMaster)).version }, karin);
    const refused = (await adminService.publish(g4a, [draft.id], sara)).outcomes;
    assert.deepEqual([refused[0]!.outcome, (refused[0] as { conflicts?: Array<{ kind: string }> }).conflicts?.map((one) => one.kind)], ['CONFLICT', ['EXCEPTION']]);
    assert.deepEqual(await roomOf(), { roomId: sal2, start: '10:00' }, 'the date keeps its room and its hour');
    assert.equal((await one<{ startTime: string }>(`SELECT "startTime"::text FROM "MasterLessons" WHERE id = $1`, [lessonMaster])).startTime, '10:00:00', 'and the template is unchanged');

    // The way out is three steps: a change of the template waits for the lesson (PENDING_TEMPLATE_CHANGE), so it is thrown first;
    // the room is put back for the date (a room change to the template's own); and then the change is written again, goes through,
    // and brings the date along, in the template's room, as it should.
    const waiting = await one<{ rev: number }>(`SELECT rev FROM "ClassTeacherChanges" WHERE id = $1`, [draft.id]);
    await teacherService.discard(g4a, draft.id, waiting.rev, karin);
    const back = await teacherService.create(g4a, { kind: 'OCCASION_ROOM', calendarLessonId: lesson, baseVersion: (await occasion(lesson)).version, targetRoomId: sal1 }, karin);
    assert.deepEqual((await adminService.publish(g4a, [back.id], sara)).outcomes, [{ id: back.id, outcome: 'PUBLISHED' }]);
    assert.deepEqual(await verdictOf(later), { state: 'OK' });
    const again = await teacherService.create(g4a, { ...later, baseVersion: (await template(lessonMaster)).version }, karin);
    assert.deepEqual((await adminService.publish(g4a, [again.id], sara)).outcomes, [{ id: again.id, outcome: 'PUBLISHED' }]);
    assert.deepEqual(await roomOf(), { roomId: sal1, start: '10:30' });

    await owner.query(`DELETE FROM "CalendarLessons" WHERE id = $1`, [lesson]);
    await owner.query(`DELETE FROM "MasterLessons" WHERE id = $1`, [lessonMaster]);
  });

  await check('(kl-r) a room the school shares holds two classes whose pupils fit and refuses three, and the klasslärare’s verdict says what the editor’s own check says, for the template and for a date', async () => {
    const g4c = await groupOf('4C');
    const aula = await roomOf('Aula');
    await owner.query(`UPDATE "Rooms" SET "canBeShared" = true, capacity = 20 WHERE id = $1`, [aula]);
    await owner.query(`INSERT INTO "LunchSettings" ("schoolId", "lunchEnabled", "lunchStartTime", "lunchEndTime", "lunchMinutes", "placementSharedMode", "updatedAt") VALUES ($1, false, '11:00', '13:00', 30, 'HARD', now()) ON CONFLICT ("schoolId") DO UPDATE SET "placementSharedMode" = 'HARD'`, [s]);
    // Eight pupils in each of the three classes: two fit twenty seats, three do not.
    for (const [label, group] of [['a', g4a], ['b', g4b], ['c', g4c]] as const) {
      await owner.query(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "studentGroupId", "authId", "isActive", "updatedAt")
         SELECT $1, $2 || n || '@example.invalid', 'elev' || n, 'Probe', 'STUDENT', $3, gen_random_uuid(), true, now() FROM generate_series(1, 8) n`,
        [s, `${marker}-kl-aula-${label}`, group],
      );
    }
    const mine = await master(svenska, g4a, sal1, karin, 1, '11:00', '12:00');
    const mineDated = await dated(mine, svenska, g4a, sal1, karin, monday, '11:00', '12:00');
    const theirs = await master(matte, g4b, aula, lars, 4, '10:00', '11:00');
    const theirsDated = await dated(theirs, matte, g4b, aula, lars, thursday, '10:00', '11:00');
    const intoTheHall = { targetDayOfWeek: 4, targetStart: '10:00', targetEnd: '11:00', targetRoomId: aula };
    const templateVerdict = () => verdictOf({ kind: 'TEMPLATE_MOVE', masterLessonId: mine, ...intoTheHall });
    const dateVerdict = () => verdictOf({ kind: 'OCCASION_MOVE', calendarLessonId: mineDated, targetDate: thursday, targetStart: '10:00', targetEnd: '11:00', targetRoomId: aula });
    /** What the editor's own check (findConflicts, the one a hand edit and the swaps of G1 are applied through) says of the same hour in the same room. */
    const editorsKinds = async () =>
      (
        await api.withRls(sara, async (tx) =>
          masters.findConflicts(
            tx,
            await rostersOfYear(tx, sara, year),
            { id: mine, academicYearId: year, studentGroupId: g4a, subjectId: svenska },
            { dayOfWeek: 4, startMinutes: 600, endMinutes: 660, teacherId: karin.userId, coTeacherId: null, roomId: aula, extraGroupIds: [], studentIds: [] },
          ),
        )
      ).map((one) => one.kind);

    // Two classes, sixteen pupils in a hall of twenty: the klasslärare may put 4A beside 4B, as the editor may.
    assert.deepEqual(await templateVerdict(), { state: 'OK' });
    assert.deepEqual(await dateVerdict(), { state: 'OK' });
    assert.deepEqual(await editorsKinds(), []);

    // A third class in the hall at the same hour: twenty-four pupils, and the hour is refused by all of them.
    const third = await master(engelska, g4c, aula, unlucky, 4, '10:00', '11:00');
    const thirdDated = await dated(third, engelska, g4c, aula, unlucky, thursday, '10:00', '11:00');
    // The hall cannot hold the three together, so each of the two lessons already there is a clash of its own, as the editor counts them.
    assert.deepEqual(await editorsKinds(), ['ROOM', 'ROOM']);
    assert.deepEqual(kindsOf(await templateVerdict()), ['ROOM', 'ROOM']);
    assert.deepEqual(kindsOf(await dateVerdict()), ['ROOM', 'ROOM']);
    // The template: the draft is written, and the publisher is told the same at publication, the lesson staying where it was.
    const draft = await teacherService.create(g4a, { kind: 'TEMPLATE_MOVE', masterLessonId: mine, ...intoTheHall, baseVersion: (await template(mine)).version }, karin);
    const refused = (await adminService.publish(g4a, [draft.id], sara)).outcomes[0] as { outcome: string; conflicts?: Array<{ kind: string }> };
    assert.deepEqual([refused.outcome, refused.conflicts?.map((one) => one.kind)], ['CONFLICT', ['ROOM', 'ROOM']]);
    assert.equal((await one<{ dayOfWeek: number }>(`SELECT "dayOfWeek" FROM "MasterLessons" WHERE id = $1`, [mine])).dayOfWeek, 1);
    await teacherService.discard(g4a, draft.id, (await one<{ rev: number }>(`SELECT rev FROM "ClassTeacherChanges" WHERE id = $1`, [draft.id])).rev, karin);
    await owner.query(`DELETE FROM "CalendarLessons" WHERE id = $1`, [thirdDated]);
    await owner.query(`DELETE FROM "MasterLessons" WHERE id = $1`, [third]);

    // One date's room: a lesson of 4A on the Thursday at the hour 4B is in the hall. The verdict and the gate of the room change
    // (CalendarLessonsService.changeRoom, with G3's own test of the shared room) agree, in both directions.
    const there = await master(matte, g4a, sal1, karin, 4, '10:00', '11:00');
    const thereDated = await dated(there, matte, g4a, sal1, karin, thursday, '10:00', '11:00');
    await owner.query(`DELETE FROM "CalendarLessons" WHERE id = $1`, [mineDated]);
    await owner.query(`DELETE FROM "MasterLessons" WHERE id = $1`, [mine]);
    const inTheHall = () => verdictOf({ kind: 'OCCASION_ROOM', calendarLessonId: thereDated, targetRoomId: aula });
    assert.deepEqual(await inTheHall(), { state: 'OK' });
    const roomChange = await teacherService.create(g4a, { kind: 'OCCASION_ROOM', calendarLessonId: thereDated, baseVersion: (await occasion(thereDated, thursday)).version, targetRoomId: aula }, karin);
    assert.deepEqual((await adminService.publish(g4a, [roomChange.id], sara)).outcomes, [{ id: roomChange.id, outcome: 'PUBLISHED' }]);
    assert.equal((await one<{ roomId: string }>(`SELECT "roomId" FROM "CalendarLessons" WHERE id = $1`, [thereDated])).roomId, aula);
    // Put back, and a third class comes to the hall that hour: the verdict says ROOM and the publication of a draft written meanwhile is refused.
    await owner.query(`UPDATE "CalendarLessons" SET "roomId" = $2 WHERE id = $1`, [thereDated, sal1]);
    const crowd = await master(engelska, g4c, aula, unlucky, 4, '10:00', '11:00');
    const crowdDated = await dated(crowd, engelska, g4c, aula, unlucky, thursday, '10:00', '11:00');
    assert.deepEqual(kindsOf(await inTheHall()), ['ROOM', 'ROOM']);
    const crowded = await teacherService.create(g4a, { kind: 'OCCASION_ROOM', calendarLessonId: thereDated, baseVersion: (await occasion(thereDated, thursday)).version, targetRoomId: aula }, karin);
    const gate = (await adminService.publish(g4a, [crowded.id], sara)).outcomes[0] as { outcome: string; conflicts?: Array<{ kind: string }> };
    assert.deepEqual([gate.outcome, gate.conflicts?.map((one) => one.kind)], ['CONFLICT', ['ROOM', 'ROOM']]);
    assert.equal((await one<{ roomId: string }>(`SELECT "roomId" FROM "CalendarLessons" WHERE id = $1`, [thereDated])).roomId, sal1);
    // The day operations' own door for the same room change says the same, so the verdict never promises what the gate refuses.
    const direct = await refusedWith(() => calendar.changeRoom(thereDated, { roomId: aula }, sara));
    assert.equal(direct.status, 409);
    await teacherService.discard(g4a, crowded.id, (await one<{ rev: number }>(`SELECT rev FROM "ClassTeacherChanges" WHERE id = $1`, [crowded.id])).rev, karin);

    await owner.query(`DELETE FROM "CalendarLessons" WHERE "schoolId" = $1 AND id = ANY ($2::uuid[])`, [s, [thereDated, crowdDated, theirsDated, mineDated]]);
    await owner.query(`DELETE FROM "MasterLessons" WHERE "schoolId" = $1 AND id = ANY ($2::uuid[])`, [s, [there, crowd, theirs, mine]]);
    await owner.query(`DELETE FROM "LunchSettings" WHERE "schoolId" = $1`, [s]);
    await owner.query(`DELETE FROM "Users" WHERE "schoolId" = $1 AND role = 'STUDENT'`, [s]);
    await owner.query(`DELETE FROM "StudentGroups" WHERE id = $1`, [g4c]);
  });

  await check('(kl-s) a lesson an exam week has cancelled, and the replacement lesson it laid, meet the klasslärare as named reasons and never as an error', async () => {
    const activities = new ScheduleActivitiesService(api, realtime, notifications);
    // A replacement lesson is laid for a class that has pupils to be on it.
    await owner.query(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "studentGroupId", "authId", "isActive", "updatedAt")
       VALUES ($1, $2, 'Ella', 'Probe', 'STUDENT', $3, gen_random_uuid(), true, now())`,
      [s, `${marker}-kl-prov-elev@example.invalid`, g4a],
    );
    // The replacement lesson's subject is one that does not count towards the timplan (the minutes go as credits).
    const prov = (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "countsTowardTimplan", "updatedAt") VALUES ($1, 'Prov', 'KLPR', false, now()) RETURNING id`, [s])).id;
    const examMaster = await master(matte, g4a, sal1, karin, 2, '09:00', '10:00');
    const examDated = await dated(examMaster, matte, g4a, sal1, karin, tuesday, '09:00', '10:00');
    const reasonOf = async (id: string) => (await weekOf(karin, g4a, tuesday)).occasions.find((row) => row.id === id)?.refusal;

    // A draft written before the exam week was laid: the date's room (a change of the template for the same lesson waits behind it).
    const roomDraft = await teacherService.create(g4a, { kind: 'OCCASION_ROOM', calendarLessonId: examDated, baseVersion: (await occasion(examDated, tuesday)).version, targetRoomId: sal2 }, karin);

    // The exam: a schedule activity (D3) for 4A over the lesson's hour, which cancels the lesson and lays one replacement lesson.
    const made = await activities.create(
      { academicYearId: year, name: 'Prov i matematik 4A', fromDate: tuesday, toDate: tuesday, startTime: '09:00', endTime: '10:00', scope: 'GROUPS', groupIds: [g4a], replacementSubjectId: prov, teachers: [{ studentGroupId: g4a, teacherId: lars.userId }], notify: false },
      sara,
    );
    assert.equal(made.cancelled >= 1, true, 'the activity cancelled the lesson');
    assert.equal((await one<{ status: string }>(`SELECT status FROM "CalendarLessons" WHERE id = $1`, [examDated])).status, 'CANCELLED');
    const replacement = await one<{ id: string }>(`SELECT sal."calendarLessonId" AS id FROM "ScheduleActivityLessons" sal WHERE sal."activityId" = $1`, [made.activity.id]);
    assert.ok(replacement, 'the activity laid a replacement lesson');

    // The week names both: the cancelled lesson and the replacement lesson are not the klasslärare's to change, with a reason each.
    const cancelledReason = await reasonOf(examDated);
    const replacementReason = await reasonOf(replacement.id);
    assert.equal(cancelledReason, 'NOT_SCHEDULED');
    assert.equal(replacementReason, 'NOT_A_REGULAR_LESSON');
    // A new draft against either is refused at the door with the reason and its code: a 403, never a 500.
    for (const [id, reason] of [[examDated, cancelledReason], [replacement.id, replacementReason]] as const) {
      for (const kind of ['OCCASION_CANCEL', 'OCCASION_ROOM', 'OCCASION_MOVE'] as const) {
        const body = {
          kind,
          calendarLessonId: id,
          baseVersion: 'a'.repeat(32),
          ...(kind === 'OCCASION_ROOM' ? { targetRoomId: sal2 } : {}),
          ...(kind === 'OCCASION_MOVE' ? { targetDate: tuesday, targetStart: '10:00', targetEnd: '11:00' } : {}),
        };
        const refused = await refusedWith(() => teacherService.create(g4a, body, karin));
        assert.deepEqual([refused.status, refused.response.code], [403, 'CLASS_TEACHER_OUTSIDE_FRAME'], `${kind} on ${String(reason)}`);
        assert.equal((refused.response.params as { reason: string }).reason, reason);
      }
    }
    // The preview says the same without writing: a verdict that is a refusal with the reason, not an error.
    for (const [id, reason] of [[examDated, cancelledReason], [replacement.id, replacementReason]] as const) {
      const previewed = (await teacherService.preview(g4a, { kind: 'OCCASION_CANCEL', calendarLessonId: id }, karin)).verdict;
      assert.deepEqual(previewed, { state: 'REFUSED', reason });
    }

    // The draft written before the exam week: its lesson has changed under it, and the check, the list and the publication say so.
    const checked = (await teacherService.check(g4a, karin)).find((row) => row.change.id === roomDraft.id)!;
    assert.ok(['STALE', 'REFUSED'].includes(checked.verdict.state), `the room draft reads as ${checked.verdict.state}`);
    const seen = (await adminService.drafts(g4a, sara)).find((row) => row.change.id === roomDraft.id)!;
    assert.ok(['STALE', 'REFUSED'].includes(seen.verdict.state));
    const published = (await adminService.publish(g4a, [roomDraft.id], sara)).outcomes[0] as { outcome: string };
    assert.ok(['STALE', 'REFUSED'].includes(published.outcome), `publishing the room draft answers ${published.outcome}`);
    assert.equal((await one<{ roomId: string }>(`SELECT "roomId" FROM "CalendarLessons" WHERE id = $1`, [examDated])).roomId, sal1, 'the cancelled lesson keeps its room');
    await teacherService.discard(g4a, roomDraft.id, (await one<{ rev: number }>(`SELECT rev FROM "ClassTeacherChanges" WHERE id = $1`, [roomDraft.id])).rev, karin);

    // A draft for the template's hour, written after, goes on over the cancelled lesson: it is judged and published, and the
    // cancelled lesson, which no change of the template moves, stays cancelled where it was.
    const hourDraft = await teacherService.create(g4a, { kind: 'TEMPLATE_MOVE', masterLessonId: examMaster, baseVersion: (await template(examMaster)).version, targetDayOfWeek: 2, targetStart: '09:30', targetEnd: '10:30' }, karin);
    const hourVerdict = (await teacherService.check(g4a, karin)).find((row) => row.change.id === hourDraft.id)!.verdict;
    assert.ok(['OK', 'CONFLICT'].includes(hourVerdict.state), `the template draft reads as ${hourVerdict.state}`);
    const hourOutcome = (await adminService.publish(g4a, [hourDraft.id], sara)).outcomes[0] as { outcome: string };
    assert.equal(hourOutcome.outcome, 'PUBLISHED');
    const after = await one<{ status: string; start: string }>(`SELECT status, to_char("startsAt" AT TIME ZONE 'Europe/Stockholm', 'HH24:MI') AS start FROM "CalendarLessons" WHERE id = $1`, [examDated]);
    assert.deepEqual([after.status, after.start], ['CANCELLED', '09:00']);

    // Taking the exam week away goes through with the template moved since (the editor's reversal knows a lesson whose template has
    // moved: it does not put the old hour back beside the new one), and the klasslärare's week is read as ever.
    await activities.remove(made.activity.id, sara);
    assert.equal((await weekOf(karin, g4a, tuesday)).className, '4A');
    assert.deepEqual(
      (await template(examMaster)).start,
      '09:30',
    );
    await owner.query(`DELETE FROM "CalendarLessons" WHERE "schoolId" = $1 AND "masterLessonId" = $2`, [s, examMaster]);
    await owner.query(`DELETE FROM "MasterLessons" WHERE id = $1`, [examMaster]);
    await owner.query(`DELETE FROM "Users" WHERE "schoolId" = $1 AND role = 'STUDENT'`, [s]);
  });

  await check('(kl-t) a lesson Generera wrote from a förläggning is not the klasslärare’s to move: listed refused, a draft refused with the reason, and a draft written before it was placed is REFUSED at publication, not CONFLICT with nothing in it', async () => {
    // A lesson of 4A’s template that nothing has placed and no draft waits for: Tuesday 08:30, in the open hours.
    const mP = await master(svenska, g4a, sal1, karin, 2, '08:30', '09:30');
    const before = await template(mP);
    assert.equal(before.refusal, null);
    const made = await teacherService.create(g4a, { kind: 'TEMPLATE_MOVE', masterLessonId: mP, baseVersion: before.version, targetDayOfWeek: 2, targetStart: '10:00', targetEnd: '11:00' }, karin);
    // Generera writes the lesson from a förläggning on the timplanspost.
    await owner.query(`UPDATE "MasterLessons" SET "fromPlacement" = true WHERE id = $1`, [mP]);
    try {
      assert.equal((await template(mP)).refusal, 'LESSON_IS_PLACED', 'the week lists the lesson as refused, with its reason');
      const checked = (await teacherService.check(g4a, karin)).find((row) => row.change.id === made.id)!;
      assert.deepEqual(checked.verdict, { state: 'REFUSED', reason: 'LESSON_IS_PLACED' });
      const seen = (await adminService.drafts(g4a, sara)).find((row) => row.change.id === made.id)!;
      assert.deepEqual(seen.verdict, { state: 'REFUSED', reason: 'LESSON_IS_PLACED' });
      const rev = (await one<{ rev: number }>(`SELECT rev FROM "ClassTeacherChanges" WHERE id = $1`, [made.id])).rev;
      assert.deepEqual((await adminService.publish(g4a, [made.id], sara)).outcomes, [{ id: made.id, outcome: 'REFUSED', reason: 'LESSON_IS_PLACED' }]);
      const row = await one<{ dayOfWeek: number; startTime: string }>(`SELECT "dayOfWeek", "startTime"::text FROM "MasterLessons" WHERE id = $1`, [mP]);
      assert.deepEqual([row.dayOfWeek, row.startTime], [2, '08:30:00'], 'the lesson was not moved');
      const draft = await one<{ status: string; rev: number }>(`SELECT status, rev FROM "ClassTeacherChanges" WHERE id = $1`, [made.id]);
      assert.deepEqual([draft.status, draft.rev], ['DRAFT', rev], 'a draft refused before it was claimed is left a draft at its revision');
      await teacherService.discard(g4a, made.id, rev, karin);

      // And a new draft for it is refused as it is written, by its reason, with nothing written.
      const version = (await template(mP)).version;
      const refused = await refusedWith(() => teacherService.create(g4a, { kind: 'TEMPLATE_MOVE', masterLessonId: mP, baseVersion: version, targetDayOfWeek: 2, targetStart: '10:00', targetEnd: '11:00' }, karin));
      assert.deepEqual([refused.status, refused.response.code, refused.response.params], [403, 'CLASS_TEACHER_OUTSIDE_FRAME', { reason: 'LESSON_IS_PLACED' }]);
      assert.equal((await one<{ n: string }>(`SELECT count(*) AS n FROM "ClassTeacherChanges" WHERE "masterLessonId" = $1`, [mP])).n, '0');
    } finally {
      await owner.query(`UPDATE "MasterLessons" SET "fromPlacement" = false WHERE id = $1`, [mP]);
    }
    // The same race: the förläggning wrote it between the judging and the writing. The editor says LESSON_IS_PLACED and the outcome says what
    // it is (the draft was judged OK before the lesson was marked, so the mark is put on at the editor's own refusal).
    const second = await teacherService.create(g4a, { kind: 'TEMPLATE_MOVE', masterLessonId: mP, baseVersion: (await template(mP)).version, targetDayOfWeek: 2, targetStart: '10:00', targetEnd: '11:00' }, karin);
    const winner = new (class extends MasterLessonsService {
      override async update(...args: Parameters<MasterLessonsService['update']>): ReturnType<MasterLessonsService['update']> {
        await owner.query(`UPDATE "MasterLessons" SET "fromPlacement" = true WHERE id = $1`, [mP]);
        try {
          return await super.update(...args);
        } finally {
          await owner.query(`UPDATE "MasterLessons" SET "fromPlacement" = false WHERE id = $1`, [mP]);
        }
      }
    })(api, realtime, notifications);
    const racing = new ClassTeacherAdminService(api, new ClassTeacherEngine(api, winner, calendar, notifications, realtime));
    const outcome = (await racing.publish(g4a, [second.id], sara)).outcomes[0]!;
    assert.deepEqual(outcome, { id: second.id, outcome: 'REFUSED', reason: 'LESSON_IS_PLACED' });
    await teacherService.discard(g4a, second.id, (await one<{ rev: number }>(`SELECT rev FROM "ClassTeacherChanges" WHERE id = $1`, [second.id])).rev, karin);
    await owner.query(`DELETE FROM "MasterLessons" WHERE id = $1`, [mP]);
  });

}
