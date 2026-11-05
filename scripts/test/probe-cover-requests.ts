/**
 * The adapter probe's checks for Vikariefrågan (20270102091000), through the
 * real services on the API's role and real Postgres as CI runs it — the part
 * the unit specs and the e2e cannot see, since both run on the Prisma mock.
 * In a school of its own (slug <marker>-vikariefraga), swept whole before and
 * after:
 *
 *   cr-a  a request for two lessons goes to three colleagues; the second to
 *         answer says yes and has both: the colleague is placed (the absent
 *         teacher's row gone, theirs there), two SUBSTITUTE decisions in the
 *         sender's name, the lessons' confirmations, the request ACCEPTED
 *         with the lessons closed; the others are told it is taken, the
 *         sender who said yes, the colleague of the booking; no notice names
 *         the absent teacher; the board and both colleagues' lists say so; a
 *         colleague not asked sees and can do nothing;
 *   cr-b  THE FIRST YES: six colleagues say yes to one request for two lessons
 *         through six connections at once, four rounds. Exactly one is
 *         placed, five are told it is taken, nobody deadlocks, and the
 *         lessons carry the winner and nobody else. Twelve connections, so
 *         the calls are truly concurrent;
 *   cr-c  a yes against an administrator's own decision on the same lesson,
 *         five rounds, both orders: one vikarie on the lesson, whichever got
 *         there first, the request ended to match, and no 40P01 either way;
 *   cr-d  a yes that breaks the work rule's daily cap is refused by name and
 *         leaves the question open for the next colleague, who gets it; and
 *         a question is not sent to a colleague the rules would refuse;
 *   cr-e  a lesson cancelled by a schemabrytande aktivitet (cancelCause
 *         EVENT) cannot be asked about, and one cancelled after it was asked
 *         cannot be said yes to;
 *   cr-f  a question that ran out is refused by the database's clock, settled
 *         by the job and frees its lesson; a withdrawn one tells those who
 *         had not answered and can be said yes to by nobody;
 *   cr-g  a sender who is gone can place nobody, and the question stands;
 *   cr-h  a no is a no, once;
 *   cr-i  the vikarie's tap: unconfirmed, confirmed and idempotent, nobody
 *         else's to tap, and gone when the decision goes to another;
 *   cr-j  the fairness view counts what the database holds.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { CalendarLessonsService } from '../../src/calendar/calendar-lessons.service';
import { CoverRequestsJob } from '../../src/cover/cover-requests.job';
import { CoverRequestsService } from '../../src/cover/cover-requests.service';
import { CoverService } from '../../src/cover/cover.service';
import { PrismaService } from '../../src/database/prisma.service';
import { NotificationDeliveryService } from '../../src/notifications/notification-delivery.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function coverRequestsSlug(marker: string): string {
  return `${marker}-vikariefraga`;
}

export async function sweepCoverRequestsSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [coverRequestsSlug(marker)]);
}

/** The 4xx's body code, whatever Nest wrapped it in. */
const codeOf = (error: unknown): unknown => (error as { getResponse?: () => { code?: unknown } }).getResponse?.().code;
const messageOf = (error: unknown): string =>
  String((error as { getResponse?: () => { message?: unknown } }).getResponse?.().message ?? (error as Error).message);

/** A service of its own with `limit` connections: the race needs calls that really overlap. */
async function serviceWithPool(limit: number): Promise<PrismaService> {
  const url = new URL(process.env['DATABASE_URL']!);
  url.searchParams.set('connection_limit', String(limit));
  const previous = process.env['DATABASE_URL'];
  process.env['DATABASE_URL'] = url.toString();
  try {
    const service = new PrismaService();
    await service.onModuleInit();
    return service;
  } finally {
    process.env['DATABASE_URL'] = previous;
  }
}

export async function coverRequestsChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepCoverRequestsSchool(owner, marker);
  const rows = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await rows<T>(sql, params))[0]!;
  const racer = await serviceWithPool(12);
  try {
    const s = (
      await one<{ id: string }>(
        `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
        [`${marker} vikariefråga`, coverRequestsSlug(marker)],
      )
    ).id;
    const year = (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
         VALUES ($1, 'Cr läsår', current_date - 30, current_date + 300, true, now()) RETURNING id`,
        [s],
      )
    ).id;
    const subject = (
      await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'Cr Matematik', 'CRMA', now()) RETURNING id`, [s])
    ).id;
    const group = (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "updatedAt") VALUES ($1, $2, 'Cr 7A', now()) RETURNING id`,
        [s, year],
      )
    ).id;
    const person = async (role: string, label: string, adminProfile: string | null = null) => {
      const authId = randomUUID();
      const row = await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
         VALUES ($1, $2, $3, 'Probe', $4::"UserRole", $5::"AdminProfile", $6, true, now()) RETURNING id`,
        [s, `${marker}-vikariefraga-${label}@example.invalid`, label, role, adminProfile, authId],
      );
      return { id: row.id, authId, label };
    };
    const asAdminOf = (p: { id: string; authId: string }): AuthenticatedUser => ({
      authId: p.authId,
      role: Role.SCHOOL_ADMIN,
      userId: p.id,
      schoolId: s,
      channel: 'WEB',
      adminProfile: 'FULL',
    });
    const asTeacher = (p: { id: string; authId: string }): AuthenticatedUser => ({
      authId: p.authId,
      role: Role.TEACHER,
      userId: p.id,
      schoolId: s,
      channel: 'APP',
    });

    const admin = await person('SCHOOL_ADMIN', 'admin', 'FULL');
    const admin2 = await person('SCHOOL_ADMIN', 'admin2', 'FULL');
    const absent = await person('TEACHER', 'franvarande');
    const t = [] as Awaited<ReturnType<typeof person>>[];
    for (const label of ['t1', 't2', 't3', 't4', 't5', 't6']) t.push(await person('TEACHER', label));
    const outsider = await person('TEACHER', 'utomstaende');
    const pupil = await person('STUDENT', 'elev');
    void pupil;
    const asAdmin = asAdminOf(admin);

    // The absent teacher is away from yesterday for three months: the lessons
    // below are all a few days ahead of whenever the probe runs, because the
    // service judges them against the real clock (a colleague's list reads
    // four weeks ahead, a question cannot start in the past).
    const absence = (
      await one<{ id: string }>(
        `INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt")
         VALUES ($1, $2, now() - interval '1 day', now() + interval '90 days') RETURNING id`,
        [s, absent.id],
      )
    ).id;
    /** The school date `offset` days from the third day ahead, as YYYY-MM-DD. */
    const dayOf = async (offset: number): Promise<string> =>
      (await one<{ d: string }>(`SELECT (current_date + 2 + $1::int)::text AS d`, [offset])).d;
    /** A one-hour lesson of the absent teacher `offset` days on at `hour` (UTC; Stockholm is one or two hours on). */
    const lesson = async (offset: number, hour: number): Promise<string> => {
      const date = await dayOf(offset);
      const id = (
        await one<{ id: string }>(
          `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
           VALUES ($1, $2, $3, $4::date, $4::date + make_interval(hours => $5::int), $4::date + make_interval(hours => $5::int + 1), now()) RETURNING id`,
          [s, subject, group, date, hour],
        )
      ).id;
      await owner.query(`INSERT INTO "CalendarLessonTeachers" ("calendarLessonId", "teacherId", "schoolId", role) VALUES ($1, $2, $3, 'LEAD')`, [id, absent.id, s]);
      return id;
    };

    const notifications = new NotificationsService(api, new NotificationDeliveryService(api));
    const realtime = {
      notifyCoverBoardChanged: () => undefined,
      notifyLessonsChanged: async () => undefined,
      notifyLessonChanged: async () => undefined,
    } as unknown as RealtimeService;
    const build = (db: PrismaService) => {
      const notices = new NotificationsService(db, new NotificationDeliveryService(db));
      const calendar = new CalendarLessonsService(db, realtime, notices);
      const cover = new CoverService(db, realtime, notices, calendar);
      return { cover, requests: new CoverRequestsService(db, cover, notices, realtime) };
    };
    void notifications;
    const { cover, requests } = build(api);
    const raced = build(racer);

    const substitutesOf = async (lessonId: string) =>
      (await rows<{ teacherId: string }>(`SELECT "teacherId" FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = $1 AND role = 'SUBSTITUTE' ORDER BY 1`, [lessonId])).map(
        (row) => row.teacherId,
      );
    const requestOf = (id: string) =>
      one<{ status: string; acceptedByUserId: string | null; acceptedAt: Date | null; closedAt: Date | null; open: number }>(
        `SELECT r.status::text AS status, r."acceptedByUserId", r."acceptedAt", r."closedAt",
                (SELECT count(*)::int FROM "CoverRequestLessons" l WHERE l."requestId" = r.id AND l.open) AS open
           FROM "CoverRequests" r WHERE r.id = $1`,
        [id],
      );
    const noticesTo = async (userId: string, type: string) =>
      rows<{ meta: Record<string, unknown> }>(`SELECT meta FROM "Notifications" WHERE "userId" = $1 AND type = $2::"NotificationType" ORDER BY "createdAt"`, [userId, type]);

    await check('(cr-a) a request for two lessons: the second to answer says yes and has both, is placed and confirmed, the others and the sender are told, nobody learns who is away', async () => {
      const [l1, l2] = [await lesson(0, 6), await lesson(0, 7)];
      const sent = await requests.create(
        { lessons: [{ lessonId: l1, absenceId: absence }, { lessonId: l2, absenceId: absence }], recipientIds: [t[0]!.id, t[1]!.id, t[2]!.id] },
        asAdmin,
      );
      assert.equal(sent.status, 'OPEN');
      assert.deepEqual(sent.recipients.map((r) => r.answer), ['PENDING', 'PENDING', 'PENDING']);
      // Told with the lessons and the time; the meta names nobody who is away.
      for (const p of [t[0]!, t[1]!, t[2]!]) {
        const told = await noticesTo(p.id, 'COVER_REQUESTED');
        assert.equal(told.length, 1);
        assert.equal(told[0]!.meta['lessonCount'], 2);
        assert.ok(!JSON.stringify(told[0]!.meta).includes(absent.id) && !JSON.stringify(told[0]!.meta).includes('franvarande'));
      }
      // A colleague not asked sees nothing and can do nothing.
      assert.deepEqual(await requests.mine(asTeacher(outsider)), { requests: [], passes: [] });
      await assert.rejects(requests.accept(sent.id, asTeacher(outsider)), (e: unknown) => codeOf(e) === 'COVER_REQUEST_NOT_FOUND');

      const won = await requests.accept(sent.id, asTeacher(t[1]!));
      assert.deepEqual(won, { requestId: sent.id, lessons: 2 });

      // Placed as the board places: the absent teacher's row gone, the colleague's there.
      for (const l of [l1, l2]) {
        assert.deepEqual(await substitutesOf(l), [t[1]!.id]);
        const lead = await rows(`SELECT 1 FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = $1 AND "teacherId" = $2`, [l, absent.id]);
        assert.equal(lead.length, 0);
      }
      const decisions = await rows<{ decision: string; substituteId: string; decidedByUserId: string }>(
        `SELECT decision::text, "substituteId", "decidedByUserId" FROM "TeacherAbsenceCovers" WHERE "calendarLessonId" = ANY($1::uuid[]) ORDER BY "calendarLessonId"`,
        [[l1, l2]],
      );
      assert.deepEqual(decisions.map((d) => [d.decision, d.substituteId, d.decidedByUserId]), [
        ['SUBSTITUTE', t[1]!.id, admin.id],
        ['SUBSTITUTE', t[1]!.id, admin.id],
      ]);
      const ended = await requestOf(sent.id);
      assert.equal(ended.status, 'ACCEPTED');
      assert.equal(ended.acceptedByUserId, t[1]!.id);
      assert.ok(ended.acceptedAt && ended.closedAt && ended.acceptedAt.getTime() === ended.closedAt.getTime());
      assert.equal(ended.open, 0);
      assert.deepEqual(
        (await rows<{ userId: string; answer: string }>(`SELECT "userId", answer::text FROM "CoverRequestRecipients" WHERE "requestId" = $1 ORDER BY "userId"`, [sent.id]))
          .map((r) => [r.userId === t[1]!.id ? 'winner' : 'other', r.answer])
          .sort(),
        [['other', 'PENDING'], ['other', 'PENDING'], ['winner', 'ACCEPTED']],
      );
      assert.equal((await rows(`SELECT 1 FROM "CoverConfirmations" WHERE "calendarLessonId" = ANY($1::uuid[]) AND "userId" = $2`, [[l1, l2], t[1]!.id])).length, 2);

      // The notices.
      for (const p of [t[0]!, t[2]!]) {
        const closed = await noticesTo(p.id, 'COVER_REQUEST_CLOSED');
        assert.deepEqual(closed.map((n) => n.meta['reason']), ['TAKEN']);
      }
      assert.deepEqual((await noticesTo(t[1]!.id, 'COVER_REQUEST_CLOSED')).length, 0);
      const accepted = await noticesTo(admin.id, 'COVER_REQUEST_ACCEPTED');
      assert.equal(accepted.length, 1);
      assert.equal(accepted[0]!.meta['acceptedByName'], 't2 Probe');
      // One booking notice per lesson, as the board's own decisions send (the push folds them into one).
      assert.equal((await noticesTo(t[1]!.id, 'LESSON_SUBSTITUTE')).filter((n) => n.meta['cover'] === true).length, 2);

      // The board and both colleagues' lists.
      const board = await cover.board(await dayOf(0), await dayOf(0), asAdmin);
      assert.deepEqual(board.requests.map((r) => [r.id, r.status, r.acceptedByUserId]), [[sent.id, 'ACCEPTED', t[1]!.id]]);
      assert.equal(board.confirmations.length, 2);
      assert.deepEqual(board.items.map((i) => i.status), ['COVERED', 'COVERED']);
      const mine2 = await requests.mine(asTeacher(t[1]!));
      assert.deepEqual(mine2.requests.map((r) => r.state), ['ACCEPTED_BY_ME']);
      assert.deepEqual(mine2.passes.map((p) => [p.lessonId, p.confirmedAt !== null]), [[l1, true], [l2, true]]);
      const mine1 = await requests.mine(asTeacher(t[0]!));
      assert.deepEqual(mine1.requests.map((r) => r.state), ['TAKEN']);
      assert.equal(mine1.requests[0]!.lessons.length, 2);
      assert.deepEqual(mine1.passes, []);
      // Too late: told so, and the request is not touched again.
      await assert.rejects(requests.accept(sent.id, asTeacher(t[0]!)), (e: unknown) => codeOf(e) === 'COVER_REQUEST_TAKEN');
      await assert.rejects(requests.decline(sent.id, asTeacher(t[0]!)), (e: unknown) => codeOf(e) === 'COVER_REQUEST_GONE');
    });

    await check('(cr-b) THE FIRST YES: six colleagues say yes at once through six connections; exactly one is placed, five are told it is taken, nobody deadlocks', async () => {
      const winners: string[] = [];
      for (let round = 0; round < 4; round += 1) {
        const [l1, l2] = [await lesson(1 + round, 6), await lesson(1 + round, 7)];
        const sent = await requests.create(
          { lessons: [{ lessonId: l1, absenceId: absence }, { lessonId: l2, absenceId: absence }], recipientIds: t.map((p) => p.id) },
          asAdmin,
        );
        const outcomes = await Promise.allSettled(t.map((p) => raced.requests.accept(sent.id, asTeacher(p))));
        const ok = outcomes.flatMap((o, i) => (o.status === 'fulfilled' ? [i] : []));
        const refused = outcomes.flatMap((o) => (o.status === 'rejected' ? [codeOf(o.reason) ?? String(o.reason)] : []));
        assert.equal(ok.length, 1, `round ${round}: ${ok.length} said yes and were placed (${JSON.stringify(refused)})`);
        assert.deepEqual(refused, Array(5).fill('COVER_REQUEST_TAKEN'), `round ${round}: the others were told ${JSON.stringify(refused)}`);
        const winner = t[ok[0]!]!;
        winners.push(winner.label);
        for (const l of [l1, l2]) assert.deepEqual(await substitutesOf(l), [winner.id], `round ${round}: lesson ${l}`);
        const ended = await requestOf(sent.id);
        assert.equal(ended.status, 'ACCEPTED');
        assert.equal(ended.acceptedByUserId, winner.id);
        assert.equal(
          (await rows(`SELECT 1 FROM "CoverRequestRecipients" WHERE "requestId" = $1 AND answer = 'ACCEPTED'`, [sent.id])).length,
          1,
        );
        assert.equal((await rows(`SELECT 1 FROM "TeacherAbsenceCovers" WHERE "calendarLessonId" = ANY($1::uuid[])`, [[l1, l2]])).length, 2);
        assert.equal((await noticesTo(admin.id, 'COVER_REQUEST_ACCEPTED')).length >= round + 1, true);
      }
      assert.equal(winners.length, 4);
    });

    await check('(cr-c) a yes against the administrator’s own decision on the same lesson: one vikarie, whoever got there first, the request ended to match, no deadlock', async () => {
      const sides = { request: 0, board: 0 };
      for (let round = 0; round < 6; round += 1) {
        const l = await lesson(5 + round, 6);
        const sent = await requests.create({ lessons: [{ lessonId: l, absenceId: absence }], recipientIds: [t[0]!.id, t[1]!.id] }, asAdmin);
        const [yes, board] = await Promise.allSettled([
          raced.requests.accept(sent.id, asTeacher(t[0]!)),
          raced.cover.decide(l, { absenceId: absence, kind: 'SUBSTITUTE', substituteId: t[3]!.id, expected: 'OPEN' }, asAdmin),
        ]);
        const subs = await substitutesOf(l);
        assert.equal(subs.length, 1, `round ${round}: ${subs.length} vikarier on the lesson`);
        const ended = await requestOf(sent.id);
        if (yes.status === 'fulfilled') {
          sides.request += 1;
          assert.deepEqual(subs, [t[0]!.id]);
          assert.equal(ended.status, 'ACCEPTED');
          assert.equal(board.status, 'rejected', `round ${round}: both the yes and the board succeeded`);
          assert.equal(codeOf((board as PromiseRejectedResult).reason), 'COVER_STALE', `round ${round}: the board was refused with something else (a deadlock?)`);
        } else {
          sides.board += 1;
          assert.deepEqual(subs, [t[3]!.id]);
          assert.equal(board.status, 'fulfilled');
          assert.equal(ended.status, 'CLOSED');
          assert.ok(
            ['COVER_REQUEST_GONE', 'COVER_REQUEST_LESSON_COVERED', 'COVER_REQUEST_TAKEN'].includes(String(codeOf(yes.reason))),
            `round ${round}: the yes was refused with ${String(codeOf(yes.reason))} ${messageOf(yes.reason)}`,
          );
        }
        assert.equal(ended.open, 0);
      }
      assert.equal(sides.request + sides.board, 6);
    });

    await check('(cr-d) a yes that breaks the daily cap is refused by name and leaves the question open for the next colleague; a colleague the rules refuse is not asked', async () => {
      // t5 may teach 60 minutes a day.
      await owner.query(`INSERT INTO "TeacherWorkRules" ("schoolId", "userId", "maxTeachingMinutesPerDay", "updatedAt") VALUES ($1, $2, 60, now())`, [s, t[4]!.id]);
      const la = await lesson(11, 6);
      const sent = await requests.create({ lessons: [{ lessonId: la, absenceId: absence }], recipientIds: [t[4]!.id, t[5]!.id] }, asAdmin);
      // Meanwhile t5 is given an hour of their own that day: the cover would make it two.
      const own = (
        await one<{ id: string }>(
          `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
           VALUES ($1, $2, $3, $4::date, $4::date + interval '10 hours', $4::date + interval '11 hours', now()) RETURNING id`,
          [s, subject, group, await dayOf(11)],
        )
      ).id;
      await owner.query(`INSERT INTO "CalendarLessonTeachers" ("calendarLessonId", "teacherId", "schoolId", role) VALUES ($1, $2, $3, 'LEAD')`, [own, t[4]!.id, s]);
      await assert.rejects(requests.accept(sent.id, asTeacher(t[4]!)), (error: unknown) => {
        assert.equal(codeOf(error), 'COVER_REQUEST_RULE');
        assert.match(messageOf(error), /dagens tak för undervisning/);
        assert.deepEqual((error as { getResponse: () => { params: unknown } }).getResponse().params, { lessonId: la, rules: 'DAILY_CAP' });
        return true;
      });
      assert.equal((await requestOf(sent.id)).status, 'OPEN');
      assert.deepEqual(await substitutesOf(la), []);
      assert.equal((await rows(`SELECT 1 FROM "TeacherAbsenceCovers" WHERE "calendarLessonId" = $1`, [la])).length, 0);
      // The refused colleague may still answer, and the next colleague gets it.
      assert.deepEqual((await requests.mine(asTeacher(t[4]!))).requests.filter((r) => r.id === sent.id).map((r) => r.state), ['OPEN']);
      await requests.accept(sent.id, asTeacher(t[5]!));
      assert.deepEqual(await substitutesOf(la), [t[5]!.id]);
      // And a new question is not sent to t5 for that day at all.
      const lb = await lesson(11, 8);
      await assert.rejects(
        requests.create({ lessons: [{ lessonId: lb, absenceId: absence }], recipientIds: [t[4]!.id] }, asAdmin),
        (error: unknown) => {
          assert.equal(codeOf(error), 'COVER_REQUEST_RECIPIENT_RULE');
          assert.match(messageOf(error), /t5 Probe/);
          assert.deepEqual((error as { getResponse: () => { params: unknown } }).getResponse().params, { userId: t[4]!.id, lessonId: lb, rules: 'DAILY_CAP' });
          return true;
        },
      );
    });

    await check('(cr-e) a lesson a schemabrytande aktivitet has cancelled cannot be asked about, and one cancelled after it was asked cannot be said yes to', async () => {
      const cancelled = await lesson(12, 6);
      await owner.query(`UPDATE "CalendarLessons" SET status = 'CANCELLED', "cancelCause" = 'EVENT' WHERE id = $1`, [cancelled]);
      await assert.rejects(
        requests.create({ lessons: [{ lessonId: cancelled, absenceId: absence }], recipientIds: [t[0]!.id] }, asAdmin),
        (error: unknown) => codeOf(error) === 'COVER_REQUEST_LESSON_CANCELLED',
      );
      assert.equal((await rows(`SELECT 1 FROM "CoverRequests" r JOIN "CoverRequestLessons" l ON l."requestId" = r.id WHERE l."calendarLessonId" = $1`, [cancelled])).length, 0);

      const later = await lesson(13, 6);
      const sent = await requests.create({ lessons: [{ lessonId: later, absenceId: absence }], recipientIds: [t[0]!.id] }, asAdmin);
      await owner.query(`UPDATE "CalendarLessons" SET status = 'CANCELLED', "cancelCause" = 'EVENT' WHERE id = $1`, [later]);
      assert.deepEqual((await requests.mine(asTeacher(t[0]!))).requests.filter((r) => r.id === sent.id).map((r) => r.state), ['CLOSED']);
      await assert.rejects(requests.accept(sent.id, asTeacher(t[0]!)), (e: unknown) => codeOf(e) === 'COVER_REQUEST_LESSON_CANCELLED');
      assert.equal((await requestOf(sent.id)).status, 'OPEN');
      assert.deepEqual(await substitutesOf(later), []);
      await requests.withdraw(sent.id, asAdmin);
    });

    await check('(cr-f) a question that ran out is refused by the database’s clock, settled by the job and frees its lesson; a withdrawn one tells the unanswered and can be said yes to by nobody', async () => {
      const l = await lesson(14, 6);
      const asT1 = asTeacher(t[0]!);
      // Born ended in time: the writer's own clock is not the one that counts.
      const old = (
        await one<{ id: string }>(
          `INSERT INTO "CoverRequests" ("schoolId", "requestedByUserId", "createdAt", "expiresAt") VALUES ($1, $2, now() - interval '2 hours', now() - interval '1 hour') RETURNING id`,
          [s, admin.id],
        )
      ).id;
      await owner.query(`INSERT INTO "CoverRequestLessons" ("schoolId", "requestId", "absenceId", "calendarLessonId") VALUES ($1, $2, $3, $4)`, [s, old, absence, l]);
      await owner.query(`INSERT INTO "CoverRequestRecipients" ("schoolId", "requestId", "userId") VALUES ($1, $2, $3)`, [s, old, t[0]!.id]);
      assert.deepEqual((await requests.mine(asT1)).requests.filter((r) => r.id === old).map((r) => r.state), ['EXPIRED']);
      await assert.rejects(requests.accept(old, asT1), (e: unknown) => codeOf(e) === 'COVER_REQUEST_GONE');
      // A new question for the lesson settles the old one first, and goes out.
      const fresh = await requests.create({ lessons: [{ lessonId: l, absenceId: absence }], recipientIds: [t[0]!.id] }, asAdmin);
      assert.equal((await requestOf(old)).status, 'EXPIRED');
      assert.equal((await requestOf(old)).open, 0);
      // The job settles the rest.
      const stale = (
        await one<{ id: string }>(
          `INSERT INTO "CoverRequests" ("schoolId", "requestedByUserId", "createdAt", "expiresAt") VALUES ($1, $2, now() - interval '3 hours', now() - interval '2 hours') RETURNING id`,
          [s, admin.id],
        )
      ).id;
      const job = new CoverRequestsJob(requests);
      await job.tick();
      assert.equal((await requestOf(stale)).status, 'EXPIRED');
      assert.equal((await requestOf(fresh.id)).status, 'OPEN');

      // Withdrawn: the unanswered are told, and nobody can say yes.
      const two = await requests.create({ lessons: [{ lessonId: await lesson(15, 6), absenceId: absence }], recipientIds: [t[0]!.id, t[1]!.id, t[2]!.id] }, asAdmin);
      await requests.decline(two.id, asTeacher(t[1]!));
      const withdrawn = await requests.withdraw(two.id, asAdmin);
      assert.equal(withdrawn.status, 'WITHDRAWN');
      assert.deepEqual((await noticesTo(t[0]!.id, 'COVER_REQUEST_CLOSED')).map((n) => n.meta['reason']).slice(-1), ['WITHDRAWN']);
      assert.deepEqual((await noticesTo(t[2]!.id, 'COVER_REQUEST_CLOSED')).map((n) => n.meta['reason']).slice(-1), ['WITHDRAWN']);
      // The one who had said no is not told it is withdrawn.
      assert.equal((await noticesTo(t[1]!.id, 'COVER_REQUEST_CLOSED')).filter((n) => n.meta['reason'] === 'WITHDRAWN').length, 0);
      await assert.rejects(requests.accept(two.id, asT1), (e: unknown) => codeOf(e) === 'COVER_REQUEST_GONE');
      await assert.rejects(requests.withdraw(two.id, asAdmin), (e: unknown) => codeOf(e) === 'COVER_REQUEST_ENDED');
      await requests.withdraw(fresh.id, asAdmin);
    });

    await check('(cr-g) a sender who is gone can place nobody, and the question stands', async () => {
      const l = await lesson(16, 6);
      const sent = await requests.create({ lessons: [{ lessonId: l, absenceId: absence }], recipientIds: [t[0]!.id] }, asAdminOf(admin2));
      await owner.query(`UPDATE "Users" SET "isActive" = false WHERE id = $1`, [admin2.id]);
      await assert.rejects(requests.accept(sent.id, asTeacher(t[0]!)), (e: unknown) => codeOf(e) === 'COVER_REQUEST_SENDER_GONE');
      assert.equal((await requestOf(sent.id)).status, 'OPEN');
      assert.deepEqual(await substitutesOf(l), []);
      await owner.query(`UPDATE "Users" SET "isActive" = true WHERE id = $1`, [admin2.id]);
      await requests.accept(sent.id, asTeacher(t[0]!));
      assert.deepEqual(await substitutesOf(l), [t[0]!.id]);
    });

    await check('(cr-h) a no is a no, once, and not a yes afterwards', async () => {
      const l = await lesson(17, 6);
      const sent = await requests.create({ lessons: [{ lessonId: l, absenceId: absence }], recipientIds: [t[0]!.id, t[1]!.id] }, asAdmin);
      await requests.decline(sent.id, asTeacher(t[0]!));
      const view = (await cover.board(await dayOf(17), await dayOf(17), asAdmin)).requests.find((r) => r.id === sent.id)!;
      assert.deepEqual(view.recipients.map((r) => [r.userId === t[0]!.id ? 'first' : 'second', r.answer, r.answeredAt !== null]).sort(), [
        ['first', 'DECLINED', true],
        ['second', 'PENDING', false],
      ]);
      await assert.rejects(requests.accept(sent.id, asTeacher(t[0]!)), (e: unknown) => codeOf(e) === 'COVER_REQUEST_ANSWERED');
      await assert.rejects(requests.decline(sent.id, asTeacher(t[0]!)), (e: unknown) => codeOf(e) === 'COVER_REQUEST_ANSWERED');
      assert.deepEqual((await requests.mine(asTeacher(t[0]!))).requests.filter((r) => r.id === sent.id).map((r) => r.state), ['DECLINED_BY_ME']);
      await requests.accept(sent.id, asTeacher(t[1]!));
      assert.deepEqual(await substitutesOf(l), [t[1]!.id]);
    });

    await check('(cr-i) the vikarie’s tap: unconfirmed, confirmed once, nobody else’s to tap, and gone when the decision goes to another', async () => {
      const l = await lesson(18, 6);
      await cover.decide(l, { absenceId: absence, kind: 'SUBSTITUTE', substituteId: t[3]!.id, expected: 'OPEN' }, asAdmin);
      const before = await requests.mine(asTeacher(t[3]!));
      assert.deepEqual(before.passes.filter((p) => p.lessonId === l).map((p) => p.confirmedAt), [null]);
      assert.deepEqual(await requests.confirm(l, asTeacher(t[3]!)), { lessonId: l, confirmed: 1 });
      assert.deepEqual(await requests.confirm(l, asTeacher(t[3]!)), { lessonId: l, confirmed: 1 });
      const after = await requests.mine(asTeacher(t[3]!));
      assert.notEqual(after.passes.find((p) => p.lessonId === l)!.confirmedAt, null);
      assert.equal((await rows(`SELECT 1 FROM "CoverConfirmations" WHERE "calendarLessonId" = $1`, [l])).length, 1);
      const seen = await cover.board(await dayOf(18), await dayOf(18), asAdmin);
      assert.deepEqual(seen.confirmations.map((c) => [c.lessonId, c.userId]), [[l, t[3]!.id]]);
      await assert.rejects(requests.confirm(l, asTeacher(t[0]!)), (e: unknown) => codeOf(e) === 'COVER_PASS_NOT_FOUND');
      // The administrator hands the pass to another: the old tap does not follow.
      await owner.query(`UPDATE "TeacherAbsenceCovers" SET "substituteId" = $2 WHERE "calendarLessonId" = $1`, [l, t[2]!.id]);
      assert.equal((await rows(`SELECT 1 FROM "CoverConfirmations" WHERE "calendarLessonId" = $1`, [l])).length, 0);
    });

    await check('(cr-j) the fairness view counts what the database holds', async () => {
      // The requests were born today, outside last year: nothing in it.
      assert.deepEqual((await requests.fairness('2020-01-01', '2020-12-31', asAdmin)).rows, []);
      const today = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const fair = await requests.fairness(from, today, asAdmin);
      const truth = await rows<{ userId: string; received: number; accepted: number; declined: number }>(
        `SELECT x."userId", count(*)::int AS received,
                count(*) FILTER (WHERE x.answer = 'ACCEPTED')::int AS accepted,
                count(*) FILTER (WHERE x.answer = 'DECLINED')::int AS declined
           FROM "CoverRequestRecipients" x JOIN "CoverRequests" r ON r.id = x."requestId"
          WHERE x."schoolId" = $1 GROUP BY x."userId" ORDER BY x."userId"`,
        [s],
      );
      assert.deepEqual(
        fair.rows.map((r) => [r.userId, r.received, r.accepted, r.declined, r.received - r.accepted - r.declined - r.unanswered]),
        truth.map((r) => [r.userId, r.received, r.accepted, r.declined, 0]),
      );
      assert.ok(fair.rows.some((r) => r.accepted > 0) && fair.rows.some((r) => r.declined > 0) && fair.rows.some((r) => r.unanswered > 0));
      // One of the read is recorded: whom the view named.
      const read = await rows(`SELECT 1 FROM "PersonalDataAccess" WHERE "schoolId" = $1 AND kind = 'EMPLOYMENT' AND "actorId" = $2`, [s, admin.id]);
      assert.ok(read.length > 0);
    });
  } finally {
    await racer.$disconnect().catch(() => undefined);
    await sweepCoverRequestsSchool(owner, marker);
  }
}
