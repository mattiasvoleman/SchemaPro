/**
 * The adapter probe's checks for Elevens lektion för dagen (20270122091000),
 * through the real services on the API's role and real Postgres as CI runs it.
 * In a school of its own (slug <marker>-flytt), swept whole before and after:
 *
 *   lm-a  who may move a pupil and to where: a teacher of the lesson, the
 *         pupil's mentor and an administrator with Drift may, a colleague who
 *         teaches neither and a läsare may not (403, the database's door and
 *         the gateway answer the same); a lesson that does not overlap, a
 *         cancelled one and one an activity has replaced are refused with a
 *         named reason (409), and so is a lesson where the pupil already has
 *         another; a target room over capacity is a warning, not a refusal;
 *   lm-b  the move itself: the pupil's mark on the lesson they left is set
 *         aside (UNKNOWN) and kept, the roster of the source lacks them and
 *         the target's has them, a register save names the pupil on the
 *         source as moved away and writes nothing for them, and a move back
 *         to where they started is the undo;
 *   lm-c  a mark on the lesson they were moved to stops Ångra (409), and
 *         when it is taken away Ångra puts the set-aside mark back;
 *   lm-d  the family follows: the guardian's week has the target lesson,
 *         marked as moved here, and not the source; the pupil's own read of
 *         their lessons names the target; the calendar feed's function gives
 *         the same; the pupil's guardian is told only when the school said so;
 *   lm-e  a lesson that is cancelled takes the move with it (the arrival with
 *         it), and a deleted move takes its arrival;
 *   lm-f  a move and a register save of the same pupil's lesson, started
 *         together eight times, always meet in one order: the move stands and
 *         the pupil's mark on the source is never anything but UNKNOWN or
 *         absent, whichever was first.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Client } from 'pg';
import { AttendanceService } from '../../src/attendance/attendance.service';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { FamilyScheduleService } from '../../src/family/family-schedule.service';
import { LessonMovesService } from '../../src/lesson-moves/lesson-moves.service';
import { NotificationDeliveryService } from '../../src/notifications/notification-delivery.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function lessonMovesSlug(marker: string): string {
  return `${marker}-flytt`;
}

export async function sweepLessonMovesSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [lessonMovesSlug(marker)]);
}

/** The code a coded 4xx of the gateway carries. */
const codeOf = (error: unknown): string | undefined => {
  if (!(error instanceof HttpException)) return undefined;
  const body = error.getResponse();
  return typeof body === 'object' && body !== null ? (body as { code?: string }).code : undefined;
};
const refusedWith = (status: 403 | 409, code: string) => (error: unknown) => {
  assert.ok(error instanceof (status === 403 ? ForbiddenException : ConflictException), `not a ${status}: ${String(error)}`);
  assert.equal(codeOf(error), code);
  return true;
};

export async function lessonMoveChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepLessonMovesSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;

  const s = (
    await one<{ id: string }>(
      `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
      [`${marker} flytt`, lessonMovesSlug(marker)],
    )
  ).id;
  try {
    const year = await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
       VALUES ($1, 'probe flytt', $2::date - 30, $2::date + 300, true, 'NIOARIG', now()) RETURNING id`,
      [s, today],
    );
    const group = async (name: string, kind = 'CLASS') =>
      (
        await one<{ id: string }>(
          `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "updatedAt") VALUES ($1, $2, $3, $4, now()) RETURNING id`,
          [s, year.id, name, kind],
        )
      ).id;
    const k7a = await group('FL7A');
    const k7b = await group('FL7B');
    const spec = await group('FL Spec', 'TEACHING_GROUP');
    const subject = async (name: string, code: string) =>
      (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [s, name, code])).id;
    const sv = await subject('Svenska', 'FLSV');
    const en = await subject('Engelska', 'FLEN');
    const ma = await subject('Matte', 'FLMA');
    const room = (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, capacity, "updatedAt") VALUES ($1, 'Sal 1', 1, now()) RETURNING id`, [s])).id;

    const person = async (role: string, label: string, groupId: string | null = null, adminProfile: string | null = null): Promise<AuthenticatedUser> => {
      const authId = randomUUID();
      const row = await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "adminProfile", "updatedAt")
         VALUES ($1, $2, $3, 'Probe', $4, $5, true, $6, $7::"AdminProfile", now()) RETURNING id`,
        [s, `${marker}-flytt-${label}@example.invalid`, label, role, authId, groupId, adminProfile],
      );
      return {
        authId,
        role: role as Role,
        userId: row.id,
        schoolId: s,
        channel: 'WEB',
        ...(role === 'SCHOOL_ADMIN' ? { adminProfile: adminProfile as never, hrRead: false } : {}),
      };
    };
    const admin = await person('SCHOOL_ADMIN', 'Admin', null, 'FULL');
    const reader = await person('SCHOOL_ADMIN', 'Läsare', null, 'LASARE');
    const anna = await person('TEACHER', 'Anna');
    const bertil = await person('TEACHER', 'Bertil');
    const cecilia = await person('TEACHER', 'Cecilia');
    const dag = await person('TEACHER', 'Dag');
    const erik = await person('TEACHER', 'Erik');
    const p1 = await person('STUDENT', 'Alva', k7a);
    const p2 = await person('STUDENT', 'Bo', k7a);
    const p3 = await person('STUDENT', 'Cia', k7b);
    const guardian = await person('GUARDIAN', 'Sara');
    await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3)`, [s, guardian.userId, p1.userId]);
    await owner.query(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES ($1, $2, $3)`, [s, spec, p2.userId]);
    // Cecilia mentors 7A; she teaches nothing that day.
    await owner.query(
      `INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'MENTORSKAP', 'Mentor 7A', 60, $4, now())`,
      [s, cecilia.userId, year.id, k7a],
    );

    // Next week's Monday, after the pupils' class history begins (today, when they were made).
    const monday = (await one<{ d: string }>(`SELECT (date_trunc('week', $1::date + 7))::date::text AS d`, [today])).d;
    const lesson = async (groupId: string, subjectId: string, from: string, to: string, extra: { status?: string; cause?: string; roomId?: string } = {}) =>
      (
        await one<{ id: string }>(
          `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", "roomId", date, "startsAt", "endsAt", status, "cancelCause", "updatedAt")
           VALUES ($1, $2, $3, $4, $5::date, ($5::date + $6::time) AT TIME ZONE 'Europe/Stockholm', ($5::date + $7::time) AT TIME ZONE 'Europe/Stockholm',
                   $8::"LessonStatus", $9::"LessonCancelCause", now()) RETURNING id`,
          [s, subjectId, groupId, extra.roomId ?? null, monday, from, to, extra.status ?? 'SCHEDULED', extra.cause ?? null],
        )
      ).id;
    const S = await lesson(k7a, sv, '08:00', '08:45');
    const E = await lesson(k7b, en, '08:00', '08:45', { roomId: room });
    const N = await lesson(k7b, ma, '09:00', '09:45');
    const X = await lesson(k7b, ma, '08:15', '09:00', { status: 'CANCELLED', cause: 'MANUAL' });
    const V = await lesson(k7b, en, '08:15', '09:00', { status: 'CANCELLED', cause: 'EVENT' });
    const T = await lesson(spec, ma, '08:30', '09:15');
    const teach = async (lessonId: string, teacher: AuthenticatedUser) =>
      owner.query(`INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, 'LEAD')`, [s, lessonId, teacher.userId]);
    await teach(S, anna);
    await teach(E, bertil);
    await teach(T, dag);
    void N;

    const realtime = { notifyLessonsChanged: async () => undefined } as unknown as RealtimeService;
    const notifications = new NotificationsService(api, new NotificationDeliveryService(api));
    const moves = new LessonMovesService(api, realtime, notifications);
    const attendance = new AttendanceService(api, notifications);
    const markOf = async (lessonId: string, pupil: AuthenticatedUser) =>
      (await owner.query<{ status: string }>(`SELECT status::text FROM "AttendanceRecords" WHERE "calendarLessonId" = $1 AND "studentId" = $2`, [lessonId, pupil.userId])).rows[0]?.status ?? null;
    const moveRows = async () =>
      (await owner.query<{ id: string; fromLessonId: string; toLessonId: string; studentId: string; movedById: string | null; displacedMark: unknown }>(
        `SELECT id, "fromLessonId", "toLessonId", "studentId", "movedById", "displacedMark" FROM "LessonPupilMoves" WHERE "schoolId" = $1 ORDER BY "createdAt"`,
        [s],
      )).rows;
    const rosterOf = async (lessonId: string, as: AuthenticatedUser) => (await attendance.lessonRoster(lessonId, as)).students.map((row) => row.id).sort();

    await check('(lm-a) a teacher of the lesson, the mentor and Drift may move; a colleague and a läsare may not; the parallel rules refuse by name; a full room is a warning', async () => {
      const c1 = await moves.candidates(S, p1.userId!, anna);
      const byId = new Map(c1.candidates.map((row) => [row.id, row]));
      assert.ok(!byId.has(N), 'a lesson that does not overlap is offered');
      assert.equal(byId.get(E)?.refusal, null);
      assert.deepEqual(byId.get(E)?.warnings.map((w) => w.code), ['TARGET_ROOM_OVER_CAPACITY']);
      assert.equal(byId.get(X)?.refusal?.code, 'LESSON_MOVE_LESSON_NOT_HELD');
      assert.equal(byId.get(V)?.refusal?.code, 'LESSON_MOVE_REPLACED_BY_ACTIVITY');
      assert.equal(byId.get(T)?.refusal, null);
      // Bo is on Spec's lesson that overlaps Engelska: not a lesson to go to, and Spec's own is where they are.
      const c2 = await moves.candidates(S, p2.userId!, anna);
      const byId2 = new Map(c2.candidates.map((row) => [row.id, row]));
      assert.equal(byId2.get(E)?.refusal?.code, 'LESSON_MOVE_PUPIL_DOUBLE_BOOKED');
      assert.equal(byId2.get(T)?.refusal?.code, 'LESSON_MOVE_ALREADY_ON_TARGET');

      await assert.rejects(moves.move(p1.userId!, S, N, anna), refusedWith(409, 'LESSON_MOVE_NOT_PARALLEL'));
      await assert.rejects(moves.move(p1.userId!, S, X, anna), refusedWith(409, 'LESSON_MOVE_LESSON_NOT_HELD'));
      await assert.rejects(moves.move(p1.userId!, S, V, anna), refusedWith(409, 'LESSON_MOVE_REPLACED_BY_ACTIVITY'));
      await assert.rejects(moves.move(p2.userId!, S, E, anna), refusedWith(409, 'LESSON_MOVE_PUPIL_DOUBLE_BOOKED'));
      await assert.rejects(moves.move(p1.userId!, S, E, erik), refusedWith(403, 'LESSON_MOVE_NOT_ALLOWED'));
      await assert.rejects(moves.move(p1.userId!, S, E, reader), refusedWith(403, 'LESSON_MOVE_NOT_ALLOWED'));
      assert.deepEqual(await moveRows(), []);

      // The mentor moves their mentee, without teaching either lesson; the administrator with Drift moves another.
      const byMentor = await moves.move(p2.userId!, S, T, cecilia).catch((error) => error);
      assert.ok(byMentor instanceof Error, 'Bo is already on Spec’s lesson; a move there is refused');
      const asMentor = await moves.move(p1.userId!, S, T, cecilia);
      assert.equal(asMentor.moved, true);
      assert.ok(asMentor.moveId);
      await moves.undo(asMentor.moveId!, cecilia);
      const asAdmin = await moves.move(p1.userId!, S, T, admin);
      assert.equal(asAdmin.moved, true);
      await moves.undo(asAdmin.moveId!, admin);
      assert.deepEqual(await moveRows(), []);
    });

    await check('(lm-b) the move sets the mark aside, the registers follow, a register save names the pupil as moved away, a move back is the undo', async () => {
      await owner.query(
        `INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "recordedAt", "updatedAt") VALUES ($1, $2, $3, 'PRESENT', now(), now())`,
        [s, S, p1.userId],
      );
      const result = await moves.move(p1.userId!, S, E, anna);
      assert.equal(result.moved, true);
      assert.deepEqual(result.warnings.map((w) => w.code), ['TARGET_ROOM_OVER_CAPACITY']);
      const rows = await moveRows();
      assert.equal(rows.length, 1);
      assert.deepEqual([rows[0]!.studentId, rows[0]!.fromLessonId, rows[0]!.toLessonId, rows[0]!.movedById], [p1.userId, S, E, anna.userId]);
      assert.ok(rows[0]!.displacedMark, 'the set-aside mark is kept');
      assert.equal(await markOf(S, p1), 'UNKNOWN');
      const arrival = await one<{ moveId: string }>(`SELECT "moveId" FROM "CalendarLessonStudents" WHERE "calendarLessonId" = $1 AND "studentId" = $2`, [E, p1.userId]);
      assert.equal(arrival.moveId, rows[0]!.id);

      assert.deepEqual(await rosterOf(S, anna), [p2.userId].sort());
      assert.deepEqual(await rosterOf(E, bertil), [p1.userId, p3.userId].sort());

      // Anna's register, saved from a page opened before the move, still names Alva: dropped and counted, nothing written for her.
      const saved = await attendance.reportAttendance(
        {
          calendarLessonId: S,
          records: [
            { studentId: p1.userId!, status: 'ABSENT' },
            { studentId: p2.userId!, status: 'PRESENT' },
          ],
        } as never,
        anna,
      );
      assert.equal(saved.movedAway, 1);
      assert.equal(await markOf(S, p1), 'UNKNOWN');
      assert.equal(await markOf(S, p2), 'PRESENT');

      // Sending the pupil on from the lesson they were moved to keeps where they started; sending them back undoes.
      const back = await moves.move(p1.userId!, E, S, anna);
      assert.equal(back.moved, false);
      assert.deepEqual(await moveRows(), []);
      assert.equal(await markOf(S, p1), 'PRESENT', 'the set-aside mark is back');
      assert.deepEqual(await rosterOf(S, anna), [p1.userId, p2.userId].sort());
    });

    await check('(lm-c) a mark on the lesson they were moved to stops Ångra; taken away, Ångra puts the set-aside mark back', async () => {
      const moved = await moves.move(p1.userId!, S, E, anna);
      assert.equal(await markOf(S, p1), 'UNKNOWN');
      await attendance.reportAttendance({ calendarLessonId: E, records: [{ studentId: p1.userId!, status: 'LATE' }] } as never, bertil);
      assert.equal(await markOf(E, p1), 'LATE');
      await assert.rejects(moves.undo(moved.moveId!, anna), refusedWith(409, 'LESSON_MOVE_HAS_ATTENDANCE'));
      assert.equal((await moveRows()).length, 1);
      await owner.query(`DELETE FROM "AttendanceRecords" WHERE "calendarLessonId" = $1 AND "studentId" = $2`, [E, p1.userId]);
      await moves.undo(moved.moveId!, anna);
      assert.deepEqual(await moveRows(), []);
      assert.equal(await markOf(S, p1), 'PRESENT');
    });

    await check('(lm-d) the guardian’s week and the pupil’s own read follow the move; the calendar feed too; the guardian is told only when the school said so', async () => {
      const family = new FamilyScheduleService(api);
      const noticeCount = async (userId: string) =>
        (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "Notifications" WHERE "userId" = $1 AND "type"::text = 'LESSON_PUPIL_MOVED'`, [userId])).n;
      const [guardianBefore, bertilBefore, annaBefore] = [await noticeCount(guardian.userId!), await noticeCount(bertil.userId!), await noticeCount(anna.userId!)];
      const moved = await moves.move(p1.userId!, S, E, anna);
      const week = await family.week({ studentId: p1.userId!, week: monday }, guardian);
      const byId = new Map(week.lessons.map((entry) => [entry.id, entry]));
      assert.ok(byId.has(E), 'the lesson the child was moved to is not in their week');
      assert.equal(byId.get(E)?.movedHere, true);
      assert.ok(!byId.has(S), 'the lesson the child left is in their week');
      assert.ok(!JSON.stringify(week).includes(admin.userId!) && !JSON.stringify(week).includes('Anna'), 'the family read who moved the child');

      const own = await api.withRls(p1, (tx) =>
        (tx as unknown as PrismaClient).calendarLessonStudent.findMany({ where: { studentId: p1.userId! }, select: { calendarLessonId: true } }),
      );
      assert.deepEqual(own.map((row) => row.calendarLessonId), [E]);
      const readOwnMove = await api.withRls(p1, (tx) => (tx as unknown as PrismaClient).lessonPupilMove.findMany({ select: { toLessonId: true } }));
      assert.deepEqual(readOwnMove.map((row) => row.toLessonId), [E]);
      const othersMove = await api.withRls(p3, (tx) => (tx as unknown as PrismaClient).lessonPupilMove.findMany({ select: { toLessonId: true } }));
      assert.deepEqual(othersMove, [], 'a classmate reads another pupil’s move');

      const feed = (await one<{ lessons: Array<{ id: string }> }>(
        `SELECT app.calendar_feed_pupil_lessons($1::uuid, $2::uuid, $3::date, $3::date, 'Europe/Stockholm', 'NONE'::"TeacherDisplay") AS lessons`,
        [s, p1.userId, monday],
      )).lessons;
      const feedIds = JSON.stringify(feed);
      assert.ok(feedIds.includes(E) && !feedIds.includes(S), 'the feed names the lesson the child left or misses the one they went to');

      // Off until the school says so: the guardian has no notice; the teacher of the other lesson has one.
      assert.equal(await noticeCount(guardian.userId!), guardianBefore, 'the guardian was told with the school’s choice off');
      assert.equal(await noticeCount(bertil.userId!), bertilBefore + 1);
      assert.equal(await noticeCount(anna.userId!), annaBefore, 'the one who moved the pupil is told too');
      await moves.undo(moved.moveId!, anna);
      await owner.query(
        `INSERT INTO "SchoolDaySettings" ("schoolId", "guardianNoticeOnMove", "updatedAt") VALUES ($1, true, now())
         ON CONFLICT ("schoolId") DO UPDATE SET "guardianNoticeOnMove" = true, "updatedAt" = now()`,
        [s],
      );
      const again = await moves.move(p1.userId!, S, E, anna);
      assert.equal(await noticeCount(guardian.userId!), guardianBefore + 1);
      const meta = JSON.stringify((await one<{ meta: unknown }>(`SELECT meta FROM "Notifications" WHERE "userId" = $1 AND "type"::text = 'LESSON_PUPIL_MOVED' ORDER BY "createdAt" DESC LIMIT 1`, [guardian.userId])).meta);
      assert.ok(!meta.includes('Alva') && !meta.includes('Anna'), 'the guardian’s notice names the pupil or the mover');
      await moves.undo(again.moveId!, anna);
      await owner.query(`UPDATE "SchoolDaySettings" SET "guardianNoticeOnMove" = false WHERE "schoolId" = $1`, [s]);
    });

    await check('(lm-e) a lesson that is cancelled takes the move with it, and a deleted move takes the arrival', async () => {
      await moves.move(p1.userId!, S, E, anna);
      assert.equal((await moveRows()).length, 1);
      await owner.query(`UPDATE "CalendarLessons" SET status = 'CANCELLED', "cancelCause" = 'MANUAL', "updatedAt" = now() WHERE id = $1`, [E]);
      assert.deepEqual(await moveRows(), []);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "CalendarLessonStudents" WHERE "calendarLessonId" = $1`, [E])).n, 0);
      assert.deepEqual(await rosterOf(S, anna), [p1.userId, p2.userId].sort());
      await owner.query(`UPDATE "CalendarLessons" SET status = 'SCHEDULED', "cancelCause" = NULL, "updatedAt" = now() WHERE id = $1`, [E]);

      await moves.move(p1.userId!, S, E, anna);
      await owner.query(`DELETE FROM "LessonPupilMoves" WHERE "schoolId" = $1`, [s]);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "CalendarLessonStudents" WHERE "calendarLessonId" = $1`, [E])).n, 0);
      assert.deepEqual(await rosterOf(S, anna), [p1.userId, p2.userId].sort());
    });

    await check('(lm-f) a move and a register save started together always meet in one order', async () => {
      for (let round = 0; round < 8; round++) {
        await owner.query(`DELETE FROM "AttendanceRecords" WHERE "calendarLessonId" = $1 AND "studentId" = $2`, [S, p1.userId]);
        const [moved, saved] = await Promise.allSettled([
          moves.move(p1.userId!, S, E, anna),
          attendance.reportAttendance({ calendarLessonId: S, records: [{ studentId: p1.userId!, status: 'PRESENT' }] } as never, anna),
        ]);
        assert.equal(moved.status, 'fulfilled', `round ${round}: the move was refused: ${moved.status === 'rejected' ? String(moved.reason) : ''}`);
        assert.equal(saved.status, 'fulfilled', `round ${round}: the save was refused: ${saved.status === 'rejected' ? String(saved.reason) : ''}`);
        assert.equal((await moveRows()).length, 1, `round ${round}: the move does not stand`);
        const mark = await markOf(S, p1);
        assert.ok(mark === null || mark === 'UNKNOWN', `round ${round}: the pupil is moved away and the lesson holds the mark ${mark}`);
        await moves.undo((await moveRows())[0]!.id, anna);
      }
    });
  } finally {
    await sweepLessonMovesSchool(owner, marker);
  }
}
