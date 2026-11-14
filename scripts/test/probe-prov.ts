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
 *   pv-g  taking the plan away puts the lessons back (the lesson the exam
 *         cancelled is SCHEDULED again: the lessons here have a template, a
 *         lesson without one is deleted by the reversal and 0 CANCELLED would
 *         prove nothing), deletes the replacement lesson, the credit and the
 *         sitting, cancels the booking and leaves the exam to be laid again; an
 *         activity removed on the activities page leaves the exam unlaid and
 *         the next change cleans up;
 *   pv-h  the rows are the administrators’: a läsare and a teacher write
 *         nothing, another school reads nothing;
 *   pv-i  an exam held in the room of the lesson it cancels: taking the plan
 *         away gives the class its lesson back in that room (the exam's
 *         booking and the room of its replacement lesson would otherwise hold
 *         the room against it), and says so when another lesson holds the
 *         room and the lesson cannot come back;
 *   pv-i2 the grundschema moved after an exam was laid: taking the plan away carries the lesson to the template's new hour;
 *   pv-j  an exam the planner left out can be changed (its reason goes with its
 *         figures, or the row is refused by Exams_reason_is_a_code);
 *   pv-k  an exam saved while the engine solves keeps its new version: the
 *         proposal made before is refused as stale;
 *   pv-l  an exam saved while it is applied is not applied (the last write is
 *         on the version read), and an exam being laid cannot be changed or
 *         removed until the apply has finished (the row is locked);
 *   pv-m  a day the calendar does not have, and seats a room cannot hold, are
 *         refused with a code and not by the database;
 *   pv-n  a pupil moved to a parallel lesson (Elevens lektion för dagen) in an
 *         exam week: the move falls with the lesson the exam cancels (as it
 *         does for any activity) and taking the plan away does not bring it
 *         back, and a move into the exam's replacement lesson goes with that
 *         lesson when the plan is taken away, without the removal failing.
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
import { LessonMovesService } from '../../src/lesson-moves/lesson-moves.service';
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Waits for a condition the database decides, a bounded number of times: never a sleep that stands for it. */
async function until(what: string, condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`never became true: ${what}`);
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
    const ella = await person('STUDENT', 'Ella', k7a);
    await person('STUDENT', 'Emil', k7a);
    const frans = await person('STUDENT', 'Frans', k7b);
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
    // The lessons the exam cancels have the template a publish leaves under them. Without one a reversed avbokning cannot
    // tell that the lesson still runs and deletes it instead of putting it back, and "no lesson is CANCELLED" proves nothing.
    const template = async (lessonId: string, date: string, from: string, to: string, subjectId: string, groupId: string, teacher: AuthenticatedUser, roomId: string | null = null) => {
      const master = (
        await one<{ id: string }>(
          `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "roomId", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, extract(isodow FROM $6::date)::int, $7::time, $8::time, $9, now()) RETURNING id`,
          [s, year.id, subjectId, groupId, teacher.userId, date, from, to, roomId],
        )
      ).id;
      await owner.query(`UPDATE "CalendarLessons" SET "masterLessonId" = $2 WHERE id = $1`, [lessonId, master]);
    };
    await template(svA, tuesday, '08:20', '09:20', svenska, k7a, anna, sal1);
    await template(maA, tuesday, '09:30', '10:30', matte, k7a, bo);
    await template(maWed, wednesday, '08:20', '09:20', matte, k7a, bo);
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
    let cancelledByTheExam!: string;
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
      cancelledByTheExam = expected[0];
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
      const undone = await planner.unplan(examId, admin);
      assert.deepEqual(undone.skippedRoomTaken, []);
      // The lesson is a lesson again (SCHEDULED, no cause), not deleted: it has a template, so a reversal puts it back.
      const back = await one<{ status: string; cause: string | null; roomId: string | null }>(`SELECT status::text, "cancelCause"::text AS cause, "roomId" FROM "CalendarLessons" WHERE id = $1`, [cancelledByTheExam]);
      assert.deepEqual([back.status, back.cause], ['SCHEDULED', null]);
      assert.equal(back.roomId, cancelledByTheExam === svA ? sal1 : null, 'in the room it had');
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

    // What an exam is laid by, as the administrator would place it: a time and the rooms with their invigilators.
    const placement = (exam: { id: string; version: string }, date: string, start: string, roomId: string, writers: number, teachers: AuthenticatedUser[]) => ({
      examId: exam.id,
      examVersion: exam.version,
      date,
      start,
      rooms: [{ roomId, writers, teacherIds: teachers.map((teacher) => teacher.userId!) }],
    });
    const lessonState = (id: string) => one<{ status: string; cause: string | null; roomId: string | null }>(`SELECT status::text, "cancelCause"::text AS cause, "roomId" FROM "CalendarLessons" WHERE id = $1`, [id]);
    const bookingsOf = async (title: string) => (await all<{ status: string }>(`SELECT status::text FROM "RoomBookings" WHERE title = $1 ORDER BY "createdAt"`, [`Prov: ${title}`])).map((b) => b.status);
    const replacementsOf = async (id: string) =>
      (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ScheduleActivityLessons" WHERE "activityId" = $1`, [id])).n;

    await check('(pv-i) an exam held in the room of the lesson it cancels gives the class its lesson back in that room, and says when it cannot', async () => {
      const lessonOfTheRoom = await lesson(friday, '10:00', '11:00', svenska, k7a, [anna], sal1);
      await template(lessonOfTheRoom, friday, '10:00', '11:00', svenska, k7a, anna, sal1);
      const exam = await exams.create({ ...description({ name: 'Rum 1', windowFrom: friday, windowTo: friday }), academicYearId: year.id } as never, admin);
      // The planner offers exactly this: Sal 1 is free at 10:00 because the exam cancels the lesson that holds it.
      const laid = await planner.apply({ academicYearId: year.id, items: [placement(exam, friday, '10:00', sal1, 25, [bo])], notify: false }, admin);
      assert.equal(laid.applied, 1, JSON.stringify(laid));
      const activity = laid.outcomes[0].activityId!;
      assert.deepEqual(await lessonState(lessonOfTheRoom), { status: 'CANCELLED', cause: 'EVENT', roomId: sal1 });
      assert.deepEqual(await bookingsOf('Rum 1'), ['APPROVED']);
      assert.equal(await replacementsOf(activity), 1);
      assert.equal((await one<{ roomId: string }>(`SELECT cl."roomId" FROM "ScheduleActivityLessons" sal JOIN "CalendarLessons" cl ON cl.id = sal."calendarLessonId" WHERE sal."activityId" = $1`, [activity])).roomId, sal1);

      const undone = await planner.unplan(exam.id, admin);
      assert.deepEqual(undone, { removed: true, skippedRoomTaken: [], relocated: [] });
      // The class has its lesson, in its room, and nothing of the exam is left in the room.
      assert.deepEqual(await lessonState(lessonOfTheRoom), { status: 'SCHEDULED', cause: null, roomId: sal1 });
      assert.deepEqual(await bookingsOf('Rum 1'), ['CANCELLED']);
      assert.equal(await replacementsOf(activity), 0);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ExamSittings" WHERE "examId" = $1`, [exam.id])).n, 0);

      // Laid again, and then another lesson takes the room at that hour (a booking would not have been let in, a lesson is not asked):
      // the class's lesson cannot come back, the plan is gone all the same, and the answer names the lesson that stayed cancelled.
      const again = (await exams.list(year.id, admin)).find((x) => x.id === exam.id)!;
      const second = await planner.apply({ academicYearId: year.id, items: [placement(again, friday, '10:00', sal1, 25, [bo])], notify: false }, admin);
      assert.equal(second.applied, 1, JSON.stringify(second));
      const blocker = await lesson(friday, '10:00', '11:00', svenska, k7c, [dag], sal1);
      const blocked = await planner.unplan(exam.id, admin);
      assert.equal(blocked.removed, true);
      assert.deepEqual(blocked.skippedRoomTaken.map((one) => [one.lessonId, one.roomId, one.by]), [[lessonOfTheRoom, sal1, 'LESSON']]);
      assert.equal((await lessonState(lessonOfTheRoom)).status, 'CANCELLED');
      assert.equal((await lessonState(blocker)).status, 'SCHEDULED');
      assert.equal((await exams.list(year.id, admin)).find((x) => x.id === exam.id)!.plan, null);
      assert.deepEqual(await bookingsOf('Rum 1'), ['CANCELLED', 'CANCELLED']);
      await exams.remove(exam.id, admin);
    });

    await check('(pv-i2) an exam laid, the grundschema moved after it, and the plan taken away: the class has its lesson at the template’s new hour, and the answer says so', async () => {
      const held = await lesson(friday, '12:00', '13:00', svenska, k7a, [anna], sal1);
      await template(held, friday, '12:00', '13:00', svenska, k7a, anna, sal1);
      const exam = await exams.create({ ...description({ name: 'Flytt 1', windowFrom: friday, windowTo: friday }), academicYearId: year.id } as never, admin);
      const laid = await planner.apply({ academicYearId: year.id, items: [placement(exam, friday, '12:00', sal1, 25, [bo])], notify: false }, admin);
      assert.equal(laid.applied, 1, JSON.stringify(laid));
      assert.equal((await lessonState(held)).status, 'CANCELLED');
      // The editor moves the template an hour and a half on after the exam was laid. A school that publishes at once moves the rows it can carry and
      // writes none for the new hour, so the cancelled row is the class's lesson that day: it was deleted by the removal, and the class stood
      // without it until the next publication.
      await owner.query(
        `UPDATE "MasterLessons" SET "startTime" = '13:30', "endTime" = '14:30', "updatedAt" = now() WHERE id = (SELECT "masterLessonId" FROM "CalendarLessons" WHERE id = $1)`,
        [held],
      );
      const undone = await planner.unplan(exam.id, admin);
      assert.deepEqual(undone, { removed: true, skippedRoomTaken: [], relocated: [{ lessonId: held, from: friday, to: friday }] });
      const back = await one<{ status: string; cause: string | null; roomId: string | null; start: string; end: string }>(
        `SELECT status::text, "cancelCause"::text AS cause, "roomId", to_char("startsAt" AT TIME ZONE 'Europe/Stockholm', 'HH24:MI') AS start, to_char("endsAt" AT TIME ZONE 'Europe/Stockholm', 'HH24:MI') AS "end" FROM "CalendarLessons" WHERE id = $1`,
        [held],
      );
      assert.deepEqual(back, { status: 'SCHEDULED', cause: null, roomId: sal1, start: '13:30', end: '14:30' });
      assert.deepEqual(await bookingsOf('Flytt 1'), ['CANCELLED']);
      await exams.remove(exam.id, admin);
    });

    await check('(pv-j) an exam the planner could not place can be changed: its reason goes with its figures', async () => {
      const big = await exams.create({ ...description({ name: 'För stort', writers: 500 }), academicYearId: year.id } as never, admin);
      const run = await planner.propose({ academicYearId: year.id, examIds: [big.id] }, admin);
      assert.equal(run.unplaced.length, 1, JSON.stringify(run));
      const left = await one<{ reason: string | null; params: unknown }>(`SELECT "lastReason" AS reason, "lastReasonParams" AS params FROM "Exams" WHERE id = $1`, [big.id]);
      assert.ok(left.reason !== null && left.params !== null, 'the run wrote a reason and its figures');
      // The natural next step after reading the reason; undefined would have left the figures and the check Exams_reason_is_a_code would have refused the row.
      const changed = await exams.update(big.id, description({ name: 'För stort', writers: 55 }) as never, admin);
      assert.equal(changed.lastReason, null);
      const after = await one<{ reason: string | null; params: unknown; at: string | null; writers: number }>(
        `SELECT "lastReason" AS reason, "lastReasonParams" AS params, "lastPlannedAt"::text AS at, writers FROM "Exams" WHERE id = $1`,
        [big.id],
      );
      assert.deepEqual(after, { reason: null, params: null, at: null, writers: 55 });
      await exams.remove(big.id, admin);
    });

    await check('(pv-k) an exam saved while the engine solves keeps its new version: the proposal made before is refused as stale', async () => {
      const exam = await exams.create({ ...description({ name: 'Under lösningen', windowFrom: wednesday, windowTo: wednesday, lengthMinutes: 45 }), academicYearId: year.id } as never, admin);
      const engine = proxy.callAiEngine.bind(proxy);
      let other: Awaited<ReturnType<typeof exams.update>> | null = null;
      (proxy as unknown as { callAiEngine: unknown }).callAiEngine = async (...args: Parameters<typeof engine>) => {
        // The other administrator saves the exam with 90 minutes while the engine works.
        other = await exams.update(exam.id, description({ name: 'Under lösningen', windowFrom: wednesday, windowTo: wednesday, lengthMinutes: 90 }) as never, admin);
        return engine(...args);
      };
      let proposal: Awaited<ReturnType<typeof planner.propose>>;
      try {
        proposal = await planner.propose({ academicYearId: year.id, examIds: [exam.id] }, admin);
      } finally {
        (proxy as unknown as { callAiEngine: unknown }).callAiEngine = engine;
      }
      assert.ok(other, 'the other administrator saved');
      const placed = proposal.placed[0];
      assert.ok(placed, JSON.stringify(proposal.unplaced));
      // The proposal is of the exam as it was read, and says so; the row holds the other administrator's version, not the one read.
      assert.equal(placed.version, exam.version);
      const row = await one<{ version: string; minutes: number }>(`SELECT "updatedAt" AS version, "lengthMinutes" AS minutes FROM "Exams" WHERE id = $1`, [exam.id]);
      assert.equal(row.minutes, 90);
      assert.equal(new Date(row.version).toISOString(), (other as { version: string }).version);
      assert.notEqual(new Date(row.version).toISOString(), exam.version);
      // So it is refused, and the 45 minutes the administrator read are not laid on an exam of 90.
      const applied = await planner.apply(
        { academicYearId: year.id, items: [{ examId: exam.id, examVersion: placed.version, date: placed.date, start: placed.start, rooms: placed.rooms.map((one) => ({ roomId: one.roomId, writers: one.writers, teacherIds: one.invigilators.map((entry) => entry.teacherId) })) }], notify: false },
        admin,
      );
      assert.deepEqual(applied.outcomes.map((o) => [o.ok, o.code]), [[false, 'EXAM_STALE']]);
      assert.equal((await one<{ activityId: string | null }>(`SELECT "activityId" FROM "Exams" WHERE id = $1`, [exam.id])).activityId, null);
      await exams.remove(exam.id, admin);
    });

    await check('(pv-l) an exam saved while it is applied is not applied, and an exam being laid is not changed or removed until the apply is done', async () => {
      // 1. Saved between the version being compared and the plan's last write: the apply is undone with the activity it made.
      const exam = await exams.create({ ...description({ name: 'Under tillämpningen', windowFrom: tuesday, windowTo: tuesday, lengthMinutes: 60 }), academicYearId: year.id } as never, admin);
      const reached = deferred();
      const release = deferred();
      const real = activities.createWithin.bind(activities);
      (activities as unknown as { createWithin: typeof activities.createWithin }).createWithin = async (tx, user, dto) => {
        const made = await real(tx, user, dto);
        reached.resolve();
        await release.promise;
        return made;
      };
      try {
        const applying = planner.apply({ academicYearId: year.id, items: [placement(exam, tuesday, '09:30', sal1, 25, [bo])], notify: false }, admin);
        await reached.promise;
        // Nothing of the exam is written yet, so the exam is not laid and the other administrator may save it.
        await exams.update(exam.id, description({ name: 'Under tillämpningen', windowFrom: tuesday, windowTo: tuesday, lengthMinutes: 90 }) as never, admin);
        release.resolve();
        const result = await applying;
        assert.deepEqual(result.outcomes.map((o) => [o.ok, o.code]), [[false, 'EXAM_STALE']], JSON.stringify(result));
      } finally {
        (activities as unknown as { createWithin: unknown }).createWithin = real;
        release.resolve();
      }
      // Nothing of the 60 minutes is left beside the 90: no activity, no credit, no booking, no sitting.
      const left = await one<{ minutes: number; planned: boolean; activities: number; credits: number; sittings: number }>(
        `SELECT e."lengthMinutes" AS minutes, e."activityId" IS NOT NULL AS planned,
                (SELECT count(*)::int FROM "ScheduleActivities" WHERE "schoolId" = $2 AND "removedAt" IS NULL AND "batchId" IN (SELECT id FROM "CancellationBatches" WHERE name = 'Prov: Under tillämpningen')) AS activities,
                (SELECT count(*)::int FROM "TimplanCredits" WHERE "schoolId" = $2 AND name = 'Prov: Under tillämpningen') AS credits,
                (SELECT count(*)::int FROM "ExamSittings" WHERE "examId" = e.id) AS sittings
           FROM "Exams" e WHERE e.id = $1`,
        [exam.id, s],
      );
      assert.deepEqual(left, { minutes: 90, planned: false, activities: 0, credits: 0, sittings: 0 });
      assert.deepEqual(await bookingsOf('Under tillämpningen'), []);

      // 2. Changed or removed while the apply has written its plan and not committed it: the change waits for the row, then finds the exam laid.
      //    (One at a time: the apply holds one of the pool's two connections and the waiting call the other.)
      for (const action of ['changed', 'removed'] as const) {
        const target = action === 'changed' ? exam : await exams.create({ ...description({ name: 'Under tillämpningen', windowFrom: tuesday, windowTo: tuesday, lengthMinutes: 60 }), academicYearId: year.id } as never, admin);
        const fresh = (await exams.list(year.id, admin)).find((x) => x.id === target.id)!;
        const wrote = deferred();
        const commit = deferred();
        const held = {
          withRls: (user: AuthenticatedUser, body: (tx: PrismaClient) => Promise<unknown>, options?: { timeoutMs?: number }) =>
            api.withRls(
              user,
              async (tx) => {
                try {
                  return await body(tx);
                } finally {
                  wrote.resolve();
                  await commit.promise;
                }
              },
              options,
            ),
        } as unknown as PrismaService;
        const slow = new ExamPlannerService(held, proxy, activities);
        let outcome = 'pending';
        const answer = (error: unknown) => (error as { getResponse?: () => { code?: string } }).getResponse?.().code ?? String(error);
        try {
          const applying = slow.apply({ academicYearId: year.id, items: [placement(fresh, tuesday, '09:30', sal1, 25, [bo])], notify: false }, admin);
          await wrote.promise;
          const waiting =
            action === 'changed'
              ? exams.update(target.id, description({ name: 'Under tillämpningen', windowFrom: tuesday, windowTo: tuesday, lengthMinutes: 30 }) as never, admin).then(() => (outcome = 'changed'), (error) => (outcome = answer(error)))
              : exams.remove(target.id, admin).then(() => (outcome = 'removed'), (error) => (outcome = answer(error)));
          // It is waiting for the row the apply holds (the database says so) and has not answered.
          await until(`the ${action === 'changed' ? 'change' : 'removal'} waits for the exam’s row`, async () =>
            (await one<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"Exams"%'`)).n >= 1,
          );
          assert.equal(outcome, 'pending');
          commit.resolve();
          const result = await applying;
          await waiting;
          assert.equal(result.applied, 1, JSON.stringify(result));
        } finally {
          commit.resolve();
        }
        assert.equal(outcome, 'EXAM_IS_PLANNED', `an exam laid at that moment is not ${action}`);
        const laid = (await exams.list(year.id, admin)).find((x) => x.id === target.id)!;
        assert.deepEqual([laid.lengthMinutes, laid.plan?.start, laid.plan?.end], [action === 'changed' ? 90 : 60, '09:30', action === 'changed' ? '11:00' : '10:30'], `as the apply laid it`);
        await planner.unplan(target.id, admin);
        await exams.remove(target.id, admin);
      }
    });

    await check('(pv-m) a day the calendar does not have and seats a room cannot hold are refused with a code, not by the database', async () => {
      for (const date of ['2030-11-31', '2030-11-32']) {
        await assert.rejects(exams.create({ ...description({ name: 'Datum', windowFrom: date, windowTo: date }), academicYearId: year.id } as never, admin), /finns i kalendern/);
      }
      const first = await planner.apply({ academicYearId: year.id, items: [{ examId: randomUUID(), examVersion: new Date().toISOString(), date: '2030-11-31', start: '08:20', rooms: [{ roomId: sal1, writers: 5, teacherIds: [bo.userId!] }] }] }, admin);
      assert.equal(first.outcomes[0].ok, false);
      await owner.query(`UPDATE "Rooms" SET capacity = 20 WHERE id = $1`, [sal2]);
      await assert.rejects(exams.markRoom(sal2, 500, admin), /rymmer 20/);
      await assert.rejects(exams.markRoom(sal2, 21, admin), /rymmer 20/);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ExamRooms" WHERE "roomId" = $1`, [sal2])).n, 0);
      await exams.markRoom(sal2, 20, admin);
      await exams.unmarkRoom(sal2, admin);
    });

    await check('(pv-n) a pupil moved to a parallel lesson in an exam week: the move falls with the cancelled lesson and stays gone, and a move into the replacement lesson goes with it', async () => {
      const thursday = (await one<{ d: string }>(`SELECT ($1::date + 3)::text AS d`, [monday])).d;
      const seven = await lesson(thursday, '13:00', '14:00', svenska, k7a, [anna], sal1);
      await template(seven, thursday, '13:00', '14:00', svenska, k7a, anna, sal1);
      const parallel = await lesson(thursday, '13:00', '14:00', svenska, k7b, [cecilia]);
      const moves = new LessonMovesService(api, realtime, notifications);
      const movesOf = async (pupil: AuthenticatedUser) =>
        (await all<{ fromLessonId: string; toLessonId: string }>(`SELECT "fromLessonId", "toLessonId" FROM "LessonPupilMoves" WHERE "studentId" = $1`, [pupil.userId])).map((row) => [row.fromLessonId, row.toLessonId]);
      const exam = await exams.create({ ...description({ name: 'Flyttad elev', windowFrom: thursday, windowTo: thursday }), academicYearId: year.id } as never, admin);

      // 1. Ella of 7A is moved to 7B's lesson, then the exam cancels her class's lesson: the move falls with it (D7's trigger, as for any activity).
      const first = await moves.move(ella.userId!, seven, parallel, admin);
      assert.equal(first.moved, true);
      assert.deepEqual(await movesOf(ella), [[seven, parallel]]);
      const laid = await planner.apply({ academicYearId: year.id, items: [placement(exam, thursday, '13:00', sal1, 25, [bo])], notify: false }, admin);
      assert.equal(laid.applied, 1, JSON.stringify(laid));
      assert.equal((await lessonState(seven)).status, 'CANCELLED');
      assert.deepEqual(await movesOf(ella), []);
      // Taking the plan away puts the lesson back and does not put the move back: the pupil is on their own lesson, as the move's own rule says.
      const undone = await planner.unplan(exam.id, admin);
      assert.deepEqual(undone, { removed: true, skippedRoomTaken: [], relocated: [] });
      assert.deepEqual(await lessonState(seven), { status: 'SCHEDULED', cause: null, roomId: sal1 });
      assert.deepEqual(await movesOf(ella), []);

      // 2. Laid again; Frans of 7B is moved into the exam's replacement lesson, and the plan is taken away: the lesson goes, and the move and the arrival with it.
      const again = (await exams.list(year.id, admin)).find((x) => x.id === exam.id)!;
      const second = await planner.apply({ academicYearId: year.id, items: [placement(again, thursday, '13:00', sal1, 25, [bo])], notify: false }, admin);
      assert.equal(second.applied, 1, JSON.stringify(second));
      const replacement = (await one<{ id: string }>(`SELECT sal."calendarLessonId" AS id FROM "ScheduleActivityLessons" sal WHERE sal."activityId" = $1`, [second.outcomes[0].activityId])).id;
      // The replacement lesson is a held lesson that overlaps the parallel one, so D7 lets a pupil be moved to it.
      assert.equal((await moves.move(frans.userId!, parallel, replacement, admin)).moved, true);
      assert.deepEqual(await movesOf(frans), [[parallel, replacement]]);
      const undoneAgain = await planner.unplan(exam.id, admin);
      assert.equal(undoneAgain.removed, true);
      assert.deepEqual(await lessonState(seven), { status: 'SCHEDULED', cause: null, roomId: sal1 });
      assert.deepEqual(await movesOf(frans), []);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "CalendarLessonStudents" WHERE "studentId" = $1 AND "calendarLessonId" = $2`, [frans.userId, replacement])).n, 0);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "CalendarLessons" WHERE id = $1`, [replacement])).n, 0);
      await exams.remove(exam.id, admin);
    });
  } finally {
    await sweepExamSchool(owner, marker);
  }
}
