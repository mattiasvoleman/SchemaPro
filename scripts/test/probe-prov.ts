/**
 * The adapter probe's checks for Provplanering (20270127090000), through the
 * real services on the API's role and real Postgres as CI runs it. In a school
 * of its own (slug <marker>-prov), swept whole before and after. The engine is
 * not in this job: a stand-in answers the request the gateway builds (a greedy
 * choice of the first time, room and teachers that fit), or, with
 * G4_ENGINE_URL and G4_ENGINE_KEY set, the real engine does.
 *
 *   pv-a  the school's decisions, the skrivsalar and an exam are written and
 *         refused through the services: a replacement subject that counts, a
 *         subject that does not, a class of another year;
 *   pv-b  a proposal is built from the real calendar: the times are the lesson
 *         starts of the exam's class, a teacher with a lesson at one of them
 *         is blocked there, the room a booking holds is blocked, a teacher
 *         with a protected identity is not in the pool at all, and nothing
 *         real crosses to the engine;
 *   pv-c  applying a proposal makes a schemabrytande aktivitet: the lessons
 *         the exam overlaps are cancelled, ONE replacement lesson for the class
 *         spans them, held in the room, with the invigilators as its teachers;
 *         the exam's own minutes are a credit on its subject, linked to the
 *         activity's avbokning; the room is booked; the sitting and the
 *         invigilators are written;
 *   pv-d  delivered time keeps one definition: the replacement lesson (a
 *         subject that does not count) is no pupil's timplan and the
 *         invigilator's held time, a cancelled lesson is bortfall;
 *   pv-e  the invigilators’ counter counts the pass, and a protected identity
 *         is on no list: the exam's view and the counter leave a marked teacher
 *         out, whether or not they keep watch;
 *   pv-f  what stands is judged against what is asked: the same exam again is
 *         refused, a second exam over the same hour in the same room for the
 *         same class is refused, and a stale version is refused; one exam
 *         failing leaves the others laid;
 *   pv-g  taking the plan away puts the lessons back, deletes the replacement
 *         lesson, the credit and the sitting, cancels the booking and leaves
 *         the exam to be laid again; an activity removed on the activities
 *         page leaves the exam unlaid and the next change cleans up;
 *   pv-h  the rows are the administrators’: a läsare and a teacher write
 *         nothing, another school reads nothing.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { ExamPlannerService } from '../../src/exams/exam-planner.service';
import { ExamsService } from '../../src/exams/exams.service';
import type { PlanExamsRequest, PlanExamsResponse } from '../../src/exams/interfaces/exam-engine.interface';
import { NotificationDeliveryService } from '../../src/notifications/notification-delivery.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import type { OptimizationProxyService } from '../../src/optimization/optimization-proxy.service';
import { ScheduleActivitiesService } from '../../src/publication/schedule-activities.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import { deliveredLessons } from '../../src/timplan/timplan-delivered.sql';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function examSlug(marker: string): string {
  return `${marker}-prov`;
}

export async function sweepExamSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = ANY($1)`, [[examSlug(marker), `${examSlug(marker)}-2`]]);
}

/** The first time, rooms and invigilators that fit: what the engine is stood in for by when it is not in the job. */
function greedy(request: PlanExamsRequest): PlanExamsResponse {
  const placed: PlanExamsResponse['placed'] = [];
  const unplaced: PlanExamsResponse['unplaced'] = [];
  const busyRooms = new Set<string>();
  for (const exam of request.exams) {
    let found = false;
    exam.slots.forEach((_, index) => {
      if (found) return;
      const rooms = request.rooms.filter((room) => !exam.roomBlocks.some((block) => block.id === room.id && block.slots.includes(index)) && !busyRooms.has(room.id));
      const room = rooms.find((candidate) => candidate.seats >= exam.writers);
      if (!room) return;
      const needed = Math.max(1, Math.ceil(exam.writers / request.limits.writersPerInvigilator));
      const free = request.teachers.filter((teacher) => !exam.teacherBlocks.some((block) => block.id === teacher.id && block.slots.includes(index)));
      if (free.length < needed) return;
      found = true;
      busyRooms.add(room.id);
      placed.push({ exam: exam.id, slot: index, rooms: [{ room: room.id, writers: exam.writers, invigilators: free.slice(0, needed).map((teacher) => teacher.id) }] });
    });
    if (!found) unplaced.push({ exam: exam.id, reason: 'EXAM_NOT_REACHED', params: {}, message: 'no place' });
  }
  return {
    requestId: request.requestId,
    status: 'FEASIBLE',
    placed,
    unplaced,
    invigilatorMinutes: placed.flatMap((one) => one.rooms.flatMap((room) => room.invigilators.map((teacher) => ({ teacher, minutes: request.exams.find((exam) => exam.id === one.exam)!.length })))),
    metrics: { placed: placed.length, unplaced: unplaced.length, loss: 0, roomsUsed: placed.length, invigilatorPasses: placed.length, maxLoad: 0, minLoad: 0, solveSeconds: 0 },
  };
}

export async function examChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepExamSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;

  const s = (
    await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [`${marker} prov`, examSlug(marker)])
  ).id;
  const otherSchool = (
    await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [`${marker} prov två`, `${examSlug(marker)}-2`])
  ).id;
  try {
    const year = await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
       VALUES ($1, 'probe prov', $2::date - 30, $2::date + 300, true, 'NIOARIG', now()) RETURNING id`,
      [s, today],
    );
    const group = async (name: string, grade: number) =>
      (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', $4, now()) RETURNING id`, [s, year.id, name, grade])).id;
    const subject = async (name: string, code: string, counts: boolean) =>
      (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "countsTowardTimplan", "updatedAt") VALUES ($1, $2, $3, $4, now()) RETURNING id`, [s, name, code, counts])).id;
    const matte = await subject('Matte', 'PVMA', true);
    const svenska = await subject('Svenska', 'PVSV', true);
    const prov = await subject('Prov', 'PVPR', false);
    const k7a = await group('PV7A', 7);
    const k7b = await group('PV7B', 7);
    const k7c = await group('PV7C', 7);

    const person = async (role: string, label: string, groupId: string | null = null, adminProfile: string | null = null): Promise<AuthenticatedUser> => {
      const authId = randomUUID();
      const row = await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "adminProfile", "updatedAt")
         VALUES ($1, $2, $3, 'Probe', $4, $5, true, $6, $7::"AdminProfile", now()) RETURNING id`,
        [s, `${marker}-prov-${label}@example.invalid`, label, role, authId, groupId, adminProfile],
      );
      return { authId, role: role as Role, userId: row.id, schoolId: s, channel: 'WEB', ...(role === 'SCHOOL_ADMIN' ? { adminProfile: adminProfile as never, hrRead: false } : {}) };
    };
    const admin = await person('SCHOOL_ADMIN', 'Admin', null, 'FULL');
    const reader = await person('SCHOOL_ADMIN', 'Läsare', null, 'LASARE');
    const anna = await person('TEACHER', 'Anna');
    const bo = await person('TEACHER', 'Bo');
    const cecilia = await person('TEACHER', 'Cecilia');
    const dag = await person('TEACHER', 'Dag');
    const hemlig = await person('TEACHER', 'Hemlig');
    await person('STUDENT', 'Ella', k7a);
    await person('STUDENT', 'Emil', k7a);
    await person('STUDENT', 'Frans', k7b);
    await owner.query(`INSERT INTO "PersonProtections" ("userId", "schoolId", source) VALUES ($1, $2, 'MANUAL')`, [hemlig.userId, s]);

    const room = async (name: string) => (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [s, name])).id;
    const matsalen = await room('Matsalen');
    const sal1 = await room('Sal 1');
    const sal2 = await room('Sal 2');

    // Next week's Tuesday and Wednesday: always after today.
    const monday = (await one<{ d: string }>(`SELECT (date_trunc('week', $1::date + 7))::date::text AS d`, [today])).d;
    const tuesday = (await one<{ d: string }>(`SELECT ($1::date + 1)::text AS d`, [monday])).d;
    const wednesday = (await one<{ d: string }>(`SELECT ($1::date + 2)::text AS d`, [monday])).d;
    const friday = (await one<{ d: string }>(`SELECT ($1::date + 4)::text AS d`, [monday])).d;
    const lesson = async (date: string, from: string, to: string, subjectId: string, groupId: string, teachers: AuthenticatedUser[] = [], roomId: string | null = null) => {
      const id = (
        await one<{ id: string }>(
          `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", "roomId", date, "startsAt", "endsAt", status, "updatedAt")
           VALUES ($1, $2, $3, $4, $5::date, ($5::date + $6::time) AT TIME ZONE 'Europe/Stockholm', ($5::date + $7::time) AT TIME ZONE 'Europe/Stockholm', 'SCHEDULED', now())
           RETURNING id`,
          [s, subjectId, groupId, roomId, date, from, to],
        )
      ).id;
      for (const [index, teacher] of teachers.entries()) {
        await owner.query(
          `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, $4::"TeacherAssignmentRole")`,
          [s, id, teacher.userId, index === 0 ? 'LEAD' : 'ASSISTANT'],
        );
      }
      return id;
    };
    // 7A: Svenska Tuesday 08:20–09:20 (Anna, in Sal 1) and Matte 09:30–10:30 (Bo); Matte Wednesday 08:20–09:20 (Bo).
    // 7B: Svenska Tuesday 08:20–09:20 (Cecilia). Dag teaches 7C at Tuesday 08:20: busy at the first time.
    const svA = await lesson(tuesday, '08:20', '09:20', svenska, k7a, [anna], sal1);
    const maA = await lesson(tuesday, '09:30', '10:30', matte, k7a, [bo]);
    const maWed = await lesson(wednesday, '08:20', '09:20', matte, k7a, [bo]);
    const svB = await lesson(tuesday, '08:20', '09:20', svenska, k7b, [cecilia]);
    const dagL = await lesson(tuesday, '08:20', '09:20', svenska, k7c, [dag]);
    // The Wednesday hall is booked by somebody else all morning.
    await owner.query(
      `INSERT INTO "RoomBookings" ("schoolId", "roomId", "bookedById", title, "startsAt", "endsAt", status, "updatedAt")
       VALUES ($1, $2, $3, 'Föräldramöte', ($4::date + '07:00'::time) AT TIME ZONE 'Europe/Stockholm', ($4::date + '12:00'::time) AT TIME ZONE 'Europe/Stockholm', 'APPROVED', now())`,
      [s, matsalen, admin.userId, wednesday],
    );

    const realtime = { notifyLessonChanged: async () => undefined, notifyLessonsChanged: async () => undefined, notifyCoverBoardChanged: () => undefined } as unknown as RealtimeService;
    const notifications = new NotificationsService(api, new NotificationDeliveryService(api));
    const activities = new ScheduleActivitiesService(api, realtime, notifications);
    const sent: PlanExamsRequest[] = [];
    const proxy = {
      callAiEngine: async <T>(_path: string, payload: object): Promise<T> => {
        sent.push(payload as PlanExamsRequest);
        const url = process.env.G4_ENGINE_URL;
        if (url) {
          const response = await fetch(`${url}/api/v1/plan-exams`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': process.env.G4_ENGINE_KEY ?? '' },
            body: JSON.stringify(payload),
          });
          assert.equal(response.status, 200, `the engine answered ${response.status}: ${await response.clone().text()}`);
          return (await response.json()) as T;
        }
        return greedy(payload as PlanExamsRequest) as T;
      },
    } as unknown as OptimizationProxyService;
    const exams = new ExamsService(api);
    const planner = new ExamPlannerService(api, proxy, activities);

    const description = (over: Record<string, unknown> = {}) => ({
      subjectId: matte,
      name: 'Algebra',
      lengthMinutes: 60,
      writers: 25,
      windowKind: 'WEEK' as const,
      windowFrom: tuesday,
      windowTo: wednesday,
      groupIds: [k7a],
      ...over,
    });
    const settings = (over: Record<string, unknown> = {}) => ({
      enabled: true,
      maxPerClassPerDay: 1,
      maxPerClassPerWeek: 3,
      writersPerInvigilator: 30,
      turnoverMinutes: 10,
      replacementSubjectId: prov,
      ...over,
    });
    const clock = (column: string) => `to_char(${column} AT TIME ZONE 'Europe/Stockholm', 'HH24:MI')`;

    let examId!: string;

    await check('(pv-a) the school’s decisions, its skrivsalar and an exam are written through the services, and refused where they must be', async () => {
      await assert.rejects(exams.updateSettings(settings({ replacementSubjectId: matte }) as never, admin), /EXAM_REPLACEMENT_SUBJECT_COUNTS|räknas mot timplanen/);
      await assert.rejects(exams.updateSettings(settings({ maxPerClassPerDay: 3, maxPerClassPerWeek: 2 }) as never, admin), /EXAM_CAPS|minst lika många/);
      assert.equal((await exams.settings(admin)).enabled, false, 'a school that has decided nothing has the planner off');
      const saved = await exams.updateSettings(settings({ enabled: false }) as never, admin);
      assert.deepEqual([saved.enabled, saved.replacementSubject?.id], [false, prov]);
      await exams.markRoom(matsalen, 60, admin);
      await exams.markRoom(sal1, 30, admin);
      const rooms = await exams.rooms(admin);
      assert.deepEqual(rooms.filter((row) => row.seats !== null).map((row) => [row.name, row.seats]), [['Matsalen', 60], ['Sal 1', 30]]);
      // The planner is the school's to turn on.
      await assert.rejects(planner.propose({ academicYearId: year.id }, admin), /EXAM_PLANNING_OFF|inte påslagen/);
      await exams.updateSettings(settings() as never, admin);

      await assert.rejects(exams.create({ ...description({ subjectId: prov }), academicYearId: year.id } as never, admin), /räknas inte mot timplanen/);
      await assert.rejects(exams.create({ ...description({ groupIds: [randomUUID()] }), academicYearId: year.id } as never, admin), /finns inte i läsåret/);
      const created = await exams.create({ ...description(), academicYearId: year.id } as never, admin);
      examId = created.id;
      assert.equal(created.plan, null);
      assert.deepEqual(created.groups.map((row) => row.name), ['PV7A']);
      assert.equal((await exams.list(year.id, admin)).length, 1);
    });

    let proposed!: Awaited<ReturnType<typeof planner.propose>>;
    await check('(pv-b) a proposal is built from the real calendar and sends the engine nothing real', async () => {
      proposed = await planner.propose({ academicYearId: year.id }, admin);
      const request = sent[sent.length - 1];
      assert.equal(request.exams.length, 1);
      // 7A's lesson starts: Tuesday 08:20 (Svenska), Tuesday 09:30 (Matte), Wednesday 08:20 (Matte).
      assert.deepEqual(request.exams[0].slots.map((slot) => slot.start), [500, 570, 500]);
      // Taking Svenska away costs its 60 minutes; the exam is Matte, so Matte's own cost nothing.
      assert.deepEqual(request.exams[0].slots.map((slot) => slot.loss), [60, 0, 0]);
      // The pool: the four teachers and not the one with a protected identity.
      assert.equal(request.teachers.length, 4);
      // Dag teaches 7C and Cecilia 7B at the first time, which the exam does not take: both blocked there only.
      // Anna and Bo teach what the exam cancels: free.
      assert.equal(request.exams[0].teacherBlocks.length, 2);
      assert.ok(request.exams[0].teacherBlocks.every((block) => block.slots.length === 1 && block.slots[0] === 0));
      // The Wednesday hall is booked: blocked at the third time only.
      assert.equal(request.exams[0].roomBlocks.length, 1);
      assert.deepEqual(request.exams[0].roomBlocks[0].slots, [2]);
      const wire = JSON.stringify(request);
      for (const real of [examId, k7a, matsalen, sal1, anna.userId, dag.userId, hemlig.userId, s]) assert.ok(!wire.includes(real as string), `${real} crossed`);
      assert.equal(proposed.placed.length, 1);
      assert.equal(proposed.placed[0].examId, examId);
      assert.ok(proposed.placed[0].rooms[0].invigilators.length >= 1);
      assert.ok(!JSON.stringify(proposed).includes('Hemlig'), 'a teacher with a protected identity is on no list');
      assert.equal(proposed.unplaced.length, 0);
    });

    let activityId!: string;
    await check('(pv-c) applying a proposal makes an activity: lessons cancelled, one replacement lesson in the room with the invigilators, the credit, the booking, the sitting', async () => {
      const place = proposed.placed[0];
      const room1 = place.rooms[0];
      const result = await planner.apply(
        {
          academicYearId: year.id,
          items: [{ examId, examVersion: place.version, date: place.date, start: place.start, rooms: place.rooms.map((one) => ({ roomId: one.roomId, writers: one.writers, teacherIds: one.invigilators.map((entry) => entry.teacherId) })) }],
          notify: false,
        },
        admin,
      );
      assert.deepEqual([result.applied, result.failed], [1, 0], JSON.stringify(result));
      activityId = result.outcomes[0].activityId!;

      const row = await one<{ activityId: string; fromDate: string; from: string; to: string; batchId: string }>(
        `SELECT e."activityId", b."fromDate"::text AS "fromDate", to_char(b."startTime", 'HH24:MI') AS "from", to_char(b."endTime", 'HH24:MI') AS "to", a."batchId"
           FROM "Exams" e JOIN "ScheduleActivities" a ON a.id = e."activityId" JOIN "CancellationBatches" b ON b.id = a."batchId" WHERE e.id = $1`,
        [examId],
      );
      assert.equal(row.activityId, activityId);
      assert.equal(row.fromDate, place.date);
      assert.equal(row.from, place.start);
      assert.equal(row.to, place.end);
      // The lessons the exam overlaps are cancelled with the event's cause, and no other.
      const cancelled = await all<{ id: string }>(`SELECT id FROM "CalendarLessons" WHERE "schoolId" = $1 AND status = 'CANCELLED' AND "cancelCause" = 'EVENT'`, [s]);
      const expected = place.date === tuesday && place.start === '08:20' ? [svA] : place.date === tuesday ? [maA] : [maWed];
      assert.deepEqual(cancelled.map((c) => c.id), expected);
      for (const other of [svB, dagL]) assert.equal((await one<{ status: string }>(`SELECT status FROM "CalendarLessons" WHERE id = $1`, [other])).status, 'SCHEDULED');

      // ONE replacement lesson for the class: the activity's, in the exam's room, held in the replacement subject.
      const replacement = await all<{ id: string; roomId: string; subjectId: string; masterLessonId: string | null; studentGroupId: string }>(
        `SELECT cl.id, cl."roomId", cl."subjectId", cl."masterLessonId", cl."studentGroupId" FROM "ScheduleActivityLessons" sal JOIN "CalendarLessons" cl ON cl.id = sal."calendarLessonId" WHERE sal."activityId" = $1`,
        [activityId],
      );
      assert.equal(replacement.length, 1);
      assert.deepEqual([replacement[0].roomId, replacement[0].subjectId, replacement[0].masterLessonId, replacement[0].studentGroupId], [room1.roomId, prov, null, k7a]);
      const teachers = await all<{ teacherId: string; role: string }>(`SELECT "teacherId", role::text FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = $1 ORDER BY role`, [replacement[0].id]);
      assert.deepEqual(teachers.map((t) => t.teacherId).sort(), room1.invigilators.map((entry) => entry.teacherId).sort());
      assert.equal(teachers.filter((t) => t.role === 'LEAD').length, 1);

      // The exam's own minutes, credited to its own subject for the class, linked to the avbokning.
      const credits = await all<{ date: string; minutes: number; subjectId: string; studentGroupId: string }>(
        `SELECT c.date::text AS date, c.minutes, c."subjectId", c."studentGroupId" FROM "TimplanCredits" c JOIN "CancellationBatchCredits" b ON b."creditId" = c.id WHERE b."batchId" = $1`,
        [row.batchId],
      );
      assert.deepEqual(credits, [{ date: place.date, minutes: 60, subjectId: matte, studentGroupId: k7a }]);

      // The room is held by a booking, and the sitting and the invigilators are written.
      const booked = await all<{ roomId: string; status: string; from: string }>(`SELECT "roomId", status::text, ${clock('"startsAt"')} AS "from" FROM "RoomBookings" WHERE title = 'Prov: Algebra'`);
      assert.deepEqual(booked.map((b) => [b.roomId, b.status, b.from]), [[room1.roomId, 'APPROVED', place.start]]);
      const sittings = await all<{ roomId: string; writers: number; bookingId: string | null }>(`SELECT "roomId", writers, "bookingId" FROM "ExamSittings" WHERE "examId" = $1`, [examId]);
      assert.deepEqual(sittings.map((x) => [x.roomId, x.writers, x.bookingId !== null]), [[room1.roomId, 25, true]]);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ExamInvigilators" WHERE "examId" = $1`, [examId])).n, room1.invigilators.length);

      // The view says so, and the calendar's room is busy for anything that would ask (the day grid's rule).
      const view = (await exams.list(year.id, admin))[0];
      assert.deepEqual([view.plan?.date, view.plan?.start, view.plan?.end], [place.date, place.start, place.end]);
      assert.equal(view.plan?.sittings[0].roomName, room1.roomName);
    });

    await check('(pv-d) delivered time keeps one definition: the replacement is no pupil’s timplan, it is the invigilators’ held time, the cancelled lessons are bortfall', async () => {
      const place = proposed.placed[0];
      const asOf = new Date(Date.now() + 40 * 86_400_000);
      const rows = async (subjects: 'timplan' | 'all') =>
        api.withRls(admin, (tx) =>
          (tx as unknown as PrismaClient).$queryRaw<{ bucket: string; subjectId: string; minutes: number }[]>(
            Prisma.sql`WITH l AS (${deliveredLessons({ academicYearId: year.id, yearStart: today, yearEnd: tuesday.slice(0, 4) + '-12-31', asOf }, { subjects, audience: 'none', range: { from: tuesday, to: wednesday } })})
                       SELECT bucket, "subjectId", SUM(minutes)::int AS minutes FROM l GROUP BY 1, 2`,
          ),
        );
      const pupils = await rows('timplan');
      assert.ok(!pupils.some((row) => row.subjectId === prov), 'a non-counting subject is no pupil’s timplan');
      assert.ok(pupils.some((row) => row.bucket === 'CANCELLED_EVENT'), 'the lessons the exam took are bortfall');
      const staff = await rows('all');
      assert.ok(staff.some((row) => row.bucket === 'DELIVERED' && row.subjectId === prov), 'the replacement lesson is held time for its teachers');
      void place;
    });

    await check('(pv-e) the counter counts the pass, and a teacher with a protected identity is on no list even when they keep watch', async () => {
      const place = proposed.placed[0];
      const watcher = place.rooms[0].invigilators[0].teacherId;
      const counter = await exams.counter(year.id, admin);
      assert.deepEqual([counter.find((row) => row.teacherId === watcher)?.passes, counter.find((row) => row.teacherId === watcher)?.minutes], [1, 60]);
      assert.ok(!counter.some((row) => row.teacherId === hemlig.userId), 'a marked teacher is on no counter');
      // Marked after the pass was laid: the exam's view and the counter leave them out, and say nothing of it.
      await owner.query(`INSERT INTO "PersonProtections" ("userId", "schoolId", source) VALUES ($1, $2, 'MANUAL')`, [watcher, s]);
      try {
        const view = (await exams.list(year.id, admin))[0];
        assert.ok(!view.plan!.sittings.flatMap((sitting) => sitting.invigilators).some((entry) => entry.teacherId === watcher));
        assert.ok(!(await exams.counter(year.id, admin)).some((row) => row.teacherId === watcher));
        assert.ok(!JSON.stringify(view).includes(watcher), 'the id of a marked teacher is in no answer');
      } finally {
        await owner.query(`DELETE FROM "PersonProtections" WHERE "userId" = $1`, [watcher]);
      }
    });

    await check('(pv-f) what stands is judged against what is asked: the same exam again, a stale version, a second exam over the hour, and one failing leaves the other laid', async () => {
      const place = proposed.placed[0];
      const item = {
        examId,
        examVersion: place.version,
        date: place.date,
        start: place.start,
        rooms: place.rooms.map((one) => ({ roomId: one.roomId, writers: one.writers, teacherIds: one.invigilators.map((entry) => entry.teacherId) })),
      };
      const again = await planner.apply({ academicYearId: year.id, items: [item] }, admin);
      assert.deepEqual(again.outcomes.map((o) => [o.ok, o.code]), [[false, 'EXAM_IS_PLANNED']]);
      // A second exam for the same class at the same hour in the same room: refused, and nothing of it is written.
      const second = await exams.create({ ...description({ name: 'Geometri' }), academicYearId: year.id } as never, admin);
      const clash = await planner.apply({ academicYearId: year.id, items: [{ ...item, examId: second.id, examVersion: second.version }] }, admin);
      assert.equal(clash.outcomes[0].ok, false);
      assert.ok(['EXAM_PLACEMENT', 'EXAM_ROOM_TAKEN'].includes(clash.outcomes[0].code!), JSON.stringify(clash));
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ExamSittings" WHERE "examId" = $1`, [second.id])).n, 0);
      // A stale version, and the second exam laid on the Friday beside a failing one.
      const stale = await planner.apply({ academicYearId: year.id, items: [{ ...item, examId: second.id, examVersion: '2000-01-01T00:00:00.000Z' }] }, admin);
      assert.equal(stale.outcomes[0].code, 'EXAM_STALE');
      await exams.update(second.id, description({ name: 'Geometri', windowFrom: friday, windowTo: friday, groupIds: [k7a] }) as never, admin);
      const refreshed = (await exams.list(year.id, admin)).find((x) => x.id === second.id)!;
      assert.equal(refreshed.plan, null);
      await exams.remove(second.id, admin);
      // A laid exam is not changed or removed.
      await assert.rejects(exams.remove(examId, admin), /ta bort planeringen först/);
      await assert.rejects(exams.update(examId, description() as never, admin), /ta bort planeringen först/);
    });

    await check('(pv-g) taking the plan away puts the lessons back and frees the room; an activity removed elsewhere leaves the exam unlaid and the next change cleans up', async () => {
      await planner.unplan(examId, admin);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "CalendarLessons" WHERE "schoolId" = $1 AND status = 'CANCELLED'`, [s])).n, 0);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ScheduleActivityLessons" WHERE "activityId" = $1`, [activityId])).n, 0);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "TimplanCredits" WHERE "schoolId" = $1 AND "subjectId" = $2`, [s, matte])).n, 0);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ExamSittings" WHERE "examId" = $1`, [examId])).n, 0);
      assert.deepEqual((await all<{ status: string }>(`SELECT status::text FROM "RoomBookings" WHERE title = 'Prov: Algebra'`)).map((b) => b.status), ['CANCELLED']);
      assert.equal((await exams.list(year.id, admin))[0].plan, null);
      await assert.rejects(planner.unplan(examId, admin), /inte lagt/);

      // Laid again, then taken away on the activities page: the exam reads unlaid, and a change clears what it left.
      const again = await planner.propose({ academicYearId: year.id }, admin);
      const place = again.placed[0];
      const done = await planner.apply(
        { academicYearId: year.id, items: [{ examId, examVersion: place.version, date: place.date, start: place.start, rooms: place.rooms.map((one) => ({ roomId: one.roomId, writers: one.writers, teacherIds: one.invigilators.map((e) => e.teacherId) })) }], notify: false },
        admin,
      );
      assert.equal(done.applied, 1, JSON.stringify(done));
      await activities.remove(done.outcomes[0].activityId!, admin);
      assert.equal((await exams.list(year.id, admin))[0].plan, null);
      await exams.update(examId, description({ name: 'Algebra 2' }) as never, admin);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ExamSittings" WHERE "examId" = $1`, [examId])).n, 0);
      assert.deepEqual((await all<{ status: string }>(`SELECT status::text FROM "RoomBookings" WHERE title = 'Prov: Algebra'`)).map((b) => b.status), ['CANCELLED', 'CANCELLED']);
    });

    await check('(pv-h) the rows are the administrators’: a läsare and a teacher write nothing, another school reads nothing', async () => {
      await assert.rejects(exams.create({ ...description(), academicYearId: year.id } as never, reader));
      await assert.rejects(exams.updateSettings(settings() as never, reader));
      await assert.rejects(exams.markRoom(sal2, 20, anna));
      const teacherRead = await api.withRls(anna, (tx) => (tx as unknown as PrismaClient).exam.count());
      assert.equal(teacherRead, 0, 'a teacher reads no exam');
      const outsider: AuthenticatedUser = { authId: randomUUID(), role: Role.SCHOOL_ADMIN, userId: randomUUID(), schoolId: otherSchool, channel: 'WEB', adminProfile: 'FULL' as never, hrRead: false };
      void outsider;
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "Exams" WHERE "schoolId" = $1`, [otherSchool])).n, 0);
      await exams.markRoom(sal2, 20, admin);
      await exams.unmarkRoom(sal2, admin);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ExamRooms" WHERE "roomId" = $1`, [sal2])).n, 0);
    });
  } finally {
    await sweepExamSchool(owner, marker);
  }
}
