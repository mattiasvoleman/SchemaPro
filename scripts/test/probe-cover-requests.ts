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
 *   cr-j  the fairness view counts what the database holds, a question that
 *         can still be answered not among the unanswered;
 *   cr-k  the job's pass: a question whose lesson was cancelled, whose absence
 *         was taken back or shortened, or whose absent teacher left the lesson
 *         ends CLOSED and the colleagues it still waited on are told it is no
 *         longer needed (and nobody else); one that ran out unanswered ends
 *         EXPIRED and the sender is told; grounds gone come before time out;
 *         a sender who can no longer place a vikarie is told nothing; none of
 *         the notices names a subject, a group or a room;
 *   cr-l  a yes and a no from the same colleague in the same moment: one wins,
 *         the other is told they have answered, never that the question is
 *         missing;
 *   cr-m  lines and recipients are added to an open request only;
 *   cr-n  a sender deactivated, or made a teacher, between the lookup and the
 *         placement is said as that (COVER_REQUEST_SENDER_GONE), not as a 500,
 *         and nothing is placed;
 *   cr-o  the vikarie is away themself: the absent teacher's row is gone (a
 *         decision put the vikarie there), the pair is open again on the
 *         board, a question about it stands through the job's pass and a yes
 *         to it places the next colleague;
 *   cr-p  a question that ran out and is swept by a new question about its
 *         lesson tells its sender that nobody said yes, unless it is the same
 *         administrator asking again.
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
    const lesson = async (offset: number, hour: number, teacherId: string = absent.id): Promise<string> => {
      const date = await dayOf(offset);
      const id = (
        await one<{ id: string }>(
          `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
           VALUES ($1, $2, $3, $4::date, $4::date + make_interval(hours => $5::int), $4::date + make_interval(hours => $5::int + 1), now()) RETURNING id`,
          [s, subject, group, date, hour],
        )
      ).id;
      await owner.query(`INSERT INTO "CalendarLessonTeachers" ("calendarLessonId", "teacherId", "schoolId", role) VALUES ($1, $2, $3, 'LEAD')`, [id, teacherId, s]);
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
      // The winner asking again (a lost answer, a second tap) is told it is theirs, not that a colleague was first.
      assert.deepEqual(await requests.accept(sent.id, asTeacher(t[1]!)), { requestId: sent.id, lessons: 2 });
      assert.deepEqual(await substitutesOf(l1), [t[1]!.id]);
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
          // The colleagues who had not answered are told it is taken.
          const told = (await noticesTo(t[1]!.id, 'COVER_REQUEST_CLOSED')).filter((n) => n.meta['requestId'] === sent.id);
          assert.deepEqual(told.map((n) => n.meta['reason']), ['TAKEN'], `round ${round}`);
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
      // On firm ground (a lesson of the absent teacher, the absence active): it ran out, nothing else.
      await owner.query(`INSERT INTO "CoverRequestLessons" ("schoolId", "requestId", "absenceId", "calendarLessonId") VALUES ($1, $2, $3, $4)`, [s, stale, absence, await lesson(19, 6)]);
      await owner.query(`INSERT INTO "CoverRequestRecipients" ("schoolId", "requestId", "userId") VALUES ($1, $2, $3)`, [s, stale, t[3]!.id]);
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
      const truth = await rows<{ userId: string; received: number; accepted: number; declined: number; waiting: number }>(
        `SELECT x."userId", count(*)::int AS received,
                count(*) FILTER (WHERE x.answer = 'ACCEPTED')::int AS accepted,
                count(*) FILTER (WHERE x.answer = 'DECLINED')::int AS declined,
                count(*) FILTER (WHERE x.answer = 'PENDING' AND r.status = 'OPEN')::int AS waiting
           FROM "CoverRequestRecipients" x JOIN "CoverRequests" r ON r.id = x."requestId"
          WHERE x."schoolId" = $1 GROUP BY x."userId" ORDER BY x."userId"`,
        [s],
      );
      // A question that can still be answered is received, and neither answered nor left unanswered.
      assert.deepEqual(
        fair.rows.map((r) => [r.userId, r.received, r.accepted, r.declined, r.received - r.accepted - r.declined - r.unanswered]),
        truth.map((r) => [r.userId, r.received, r.accepted, r.declined, r.waiting]),
      );
      assert.ok(fair.rows.some((r) => r.accepted > 0) && fair.rows.some((r) => r.declined > 0) && fair.rows.some((r) => r.unanswered > 0));
      // One of the read is recorded: whom the view named.
      const read = await rows(`SELECT 1 FROM "PersonalDataAccess" WHERE "schoolId" = $1 AND kind = 'EMPLOYMENT' AND "actorId" = $2`, [s, admin.id]);
      assert.ok(read.length > 0);
    });

    /** Every notice the question wrote, whoever got it: for "nobody was told" and "told nothing of the lessons". */
    const noticesAbout = (requestId: string) =>
      rows<{ userId: string; type: string; meta: Record<string, unknown> }>(
        `SELECT "userId", type::text AS type, meta FROM "Notifications" WHERE "schoolId" = $1 AND meta ->> 'requestId' = $2 ORDER BY "createdAt", "userId"`,
        [s, requestId],
      );
    const namesNothing = (value: unknown) => {
      const text = JSON.stringify(value);
      assert.ok(!/Cr Matematik|Cr 7A|subjectName|groupName|roomName/.test(text), `a notice names the lesson: ${text}`);
    };
    /** A question inserted as the owner, with the clock of the writer's choosing: `endsIn` before now is a question that ran out. */
    const plantRequest = async (senderId: string, lessonId: string, absenceId: string, recipients: string[], expiredAgoMinutes: number | null): Promise<string> => {
      const id = (
        await one<{ id: string }>(
          expiredAgoMinutes === null
            ? `INSERT INTO "CoverRequests" ("schoolId", "requestedByUserId", "expiresAt") VALUES ($1, $2, now() + interval '1 hour') RETURNING id`
            : `INSERT INTO "CoverRequests" ("schoolId", "requestedByUserId", "createdAt", "expiresAt")
               VALUES ($1, $2, now() - make_interval(mins => ${Number(expiredAgoMinutes) + 60}), now() - make_interval(mins => ${Number(expiredAgoMinutes)})) RETURNING id`,
          [s, senderId],
        )
      ).id;
      await owner.query(`INSERT INTO "CoverRequestLessons" ("schoolId", "requestId", "absenceId", "calendarLessonId") VALUES ($1, $2, $3, $4)`, [s, id, absenceId, lessonId]);
      for (const userId of recipients) {
        await owner.query(`INSERT INTO "CoverRequestRecipients" ("schoolId", "requestId", "userId") VALUES ($1, $2, $3)`, [s, id, userId]);
      }
      return id;
    };

    await check('(cr-k) the job’s pass ends a question whose grounds are gone and tells the colleagues it still waited on; a question that ran out unanswered is told to the sender; none names the lesson', async () => {
      const job = new CoverRequestsJob(requests);
      const cases: Array<[string, (c: { lesson: string; absence: string; teacher: string }) => Promise<unknown>]> = [
        ['the lesson is cancelled', (c) => owner.query(`UPDATE "CalendarLessons" SET status = 'CANCELLED', "cancelCause" = 'EVENT' WHERE id = $1`, [c.lesson])],
        ['the absence is taken back', (c) => owner.query(`UPDATE "TeacherAbsences" SET status = 'WITHDRAWN', "withdrawnAt" = now() WHERE id = $1`, [c.absence])],
        [
          'the absence is shortened to before the lesson',
          (c) => owner.query(`UPDATE "TeacherAbsences" SET "endsAt" = (SELECT "startsAt" - interval '1 hour' FROM "CalendarLessons" WHERE id = $2) WHERE id = $1`, [c.absence, c.lesson]),
        ],
        ['the absent teacher is no longer on the lesson', (c) => owner.query(`DELETE FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = $1 AND "teacherId" = $2`, [c.lesson, c.teacher])],
      ];
      let index = 0;
      for (const [what, mutate] of cases) {
        index += 1;
        const teacher = await person('TEACHER', `borta${index}`);
        const lessonId = await lesson(20 + index, 6, teacher.id);
        const absenceId = (
          await one<{ id: string }>(
            `INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt") VALUES ($1, $2, now() - interval '1 day', now() + interval '90 days') RETURNING id`,
            [s, teacher.id],
          )
        ).id;
        const sent = await requests.create({ lessons: [{ lessonId, absenceId }], recipientIds: [t[0]!.id, t[1]!.id, t[2]!.id] }, asAdmin);
        await requests.decline(sent.id, asTeacher(t[2]!));
        // Firm ground: the pass leaves it be.
        await job.tick();
        assert.equal((await requestOf(sent.id)).status, 'OPEN', `${what}: a question on firm ground ended`);

        await mutate({ lesson: lessonId, absence: absenceId, teacher: teacher.id });
        await job.tick();
        const ended = await requestOf(sent.id);
        assert.deepEqual([ended.status, ended.open], ['CLOSED', 0], `${what}: the question was not closed and its lesson freed`);

        const told = await noticesAbout(sent.id);
        const closed = told.filter((n) => n.type === 'COVER_REQUEST_CLOSED');
        // The two who had not answered are told it is no longer needed; the one who said no, and the sender, are not.
        assert.deepEqual(
          closed.map((n) => [n.userId, n.meta['reason']]).sort(),
          [[t[0]!.id, 'NOT_NEEDED'], [t[1]!.id, 'NOT_NEEDED']].sort(),
          `${what}: wrong colleagues told`,
        );
        assert.ok(!told.some((n) => n.userId === admin.id && n.type === 'COVER_REQUEST_CLOSED'), `${what}: the sender was told of a question taken from them`);
        namesNothing(told);
        assert.deepEqual((await requests.mine(asTeacher(t[0]!))).requests.filter((r) => r.id === sent.id).map((r) => r.state), ['CLOSED']);
        await assert.rejects(requests.accept(sent.id, asTeacher(t[0]!)), (e: unknown) => codeOf(e) === 'COVER_REQUEST_GONE');
        // And the lesson is free for a new question, when it is a lesson at all.
        assert.equal((await rows(`SELECT 1 FROM "CoverRequestLessons" WHERE "requestId" = $1 AND open`, [sent.id])).length, 0);
      }

      // It ran out and nobody said yes: the sender is told, in the colleagues' own type, and the colleagues are not.
      const lonely = await plantRequest(admin.id, await lesson(30, 6), absence, [t[0]!.id, t[1]!.id], 5);
      await job.tick();
      assert.equal((await requestOf(lonely)).status, 'EXPIRED');
      const lonelyNotices = await noticesAbout(lonely);
      assert.deepEqual(lonelyNotices.map((n) => [n.userId, n.type, n.meta['reason']]), [[admin.id, 'COVER_REQUEST_CLOSED', 'UNANSWERED']]);
      assert.equal(lonelyNotices[0]!.meta['lessonCount'], 1);
      namesNothing(lonelyNotices);
      // The same pass again tells nobody twice.
      await job.tick();
      assert.equal((await noticesAbout(lonely)).length, 1);

      // Grounds gone come before time out.
      const lateTeacher = await person('TEACHER', 'borta-sent');
      const lateLesson = await lesson(31, 6, lateTeacher.id);
      const lateAbsence = (
        await one<{ id: string }>(
          `INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt") VALUES ($1, $2, now() - interval '1 day', now() + interval '90 days') RETURNING id`,
          [s, lateTeacher.id],
        )
      ).id;
      const both = await plantRequest(admin.id, lateLesson, lateAbsence, [t[0]!.id], 5);
      await owner.query(`UPDATE "CalendarLessons" SET status = 'CANCELLED', "cancelCause" = 'EVENT' WHERE id = $1`, [lateLesson]);
      await job.tick();
      assert.equal((await requestOf(both)).status, 'CLOSED');
      assert.deepEqual((await noticesAbout(both)).map((n) => [n.userId, n.meta['reason']]), [[t[0]!.id, 'NOT_NEEDED']]);

      // A sender who can no longer place a vikarie (read-only now): the question ends all the same, and nobody is told.
      const reader = await person('SCHOOL_ADMIN', 'lasare', 'LASARE');
      const orphan = await plantRequest(reader.id, await lesson(32, 6), absence, [t[0]!.id], 5);
      await job.tick();
      assert.equal((await requestOf(orphan)).status, 'EXPIRED');
      assert.deepEqual(await noticesAbout(orphan), []);
    });

    await check('(cr-l) a yes and a no from the same colleague in the same moment: one wins, and the other is told they have answered', async () => {
      let yesWon = 0;
      let noWon = 0;
      for (let round = 0; round < 12; round += 1) {
        const l = await lesson(40 + round, 6);
        const sent = await requests.create({ lessons: [{ lessonId: l, absenceId: absence }], recipientIds: [t[4]!.id, t[5]!.id] }, asAdmin);
        const me = asTeacher(t[4]!);
        const lag = [0, 4, 12, 25][round % 4]!;
        const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
        // The yes goes first in half the rounds and the no in the other half, with a little jitter either way.
        const yes = (round < 6 ? pause(0) : pause(lag)).then(() => raced.requests.accept(sent.id, me)).then(() => 'yes' as const, (e: unknown) => String(codeOf(e)));
        const no = (round < 6 ? pause(lag) : pause(0)).then(() => raced.requests.decline(sent.id, me)).then(() => 'no' as const, (e: unknown) => String(codeOf(e)));
        const [a, b] = await Promise.all([yes, no]);
        const row = await requestOf(sent.id);
        const answer = (await one<{ answer: string }>(`SELECT answer::text FROM "CoverRequestRecipients" WHERE "requestId" = $1 AND "userId" = $2`, [sent.id, t[4]!.id])).answer;
        if (a === 'yes') {
          assert.equal(b, 'COVER_REQUEST_ANSWERED', `round ${round}: the no beside a yes was told ${b}`);
          assert.deepEqual([row.status, answer, await substitutesOf(l)], ['ACCEPTED', 'ACCEPTED', [t[4]!.id]], `round ${round}`);
          yesWon += 1;
        } else {
          assert.deepEqual([a, b], ['COVER_REQUEST_ANSWERED', 'no'], `round ${round}: the yes beside a no was told ${a}`);
          assert.deepEqual([row.status, answer, await substitutesOf(l)], ['OPEN', 'DECLINED', []], `round ${round}`);
          noWon += 1;
          await requests.withdraw(sent.id, asAdmin);
        }
      }
      assert.equal(yesWon + noWon, 12);
    });

    await check('(cr-m) lines and recipients are added to an open request only', async () => {
      const l = await lesson(55, 6);
      const sent = await requests.create({ lessons: [{ lessonId: l, absenceId: absence }], recipientIds: [t[0]!.id] }, asAdmin);
      await requests.withdraw(sent.id, asAdmin);
      const other = await lesson(56, 6);
      await assert.rejects(api.withRls(asAdmin, (tx) => tx.coverRequestLesson.create({ data: { schoolId: s, requestId: sent.id, absenceId: absence, calendarLessonId: other } })));
      await assert.rejects(api.withRls(asAdmin, (tx) => tx.coverRequestRecipient.create({ data: { schoolId: s, requestId: sent.id, userId: t[1]!.id } })));
      assert.equal((await rows(`SELECT 1 FROM "CoverRequestLessons" WHERE "requestId" = $1`, [sent.id])).length, 1);
      assert.equal((await rows(`SELECT 1 FROM "CoverRequestRecipients" WHERE "requestId" = $1`, [sent.id])).length, 1);
      // The refused line did not hold the other lesson against a new question.
      const fresh = await requests.create({ lessons: [{ lessonId: other, absenceId: absence }], recipientIds: [t[0]!.id] }, asAdmin);
      await requests.withdraw(fresh.id, asAdmin);
    });

    await check('(cr-n) a sender deactivated, or made a teacher, between the lookup and the placement is said as that, and nothing is placed', async () => {
      const changes: Array<[string, string]> = [
        ['deactivated', `UPDATE "Users" SET "isActive" = false WHERE id = $1`],
        ['made a teacher', `UPDATE "Users" SET role = 'TEACHER'::"UserRole", "adminProfile" = NULL WHERE id = $1`],
      ];
      let index = 0;
      for (const [what, change] of changes) {
        index += 1;
        const sender = await person('SCHOOL_ADMIN', `avsandare${index}`, 'FULL');
        const l = await lesson(60 + index, 6);
        const sent = await requests.create({ lessons: [{ lessonId: l, absenceId: absence }], recipientIds: [t[0]!.id] }, asAdminOf(sender));
        // The sender changes after the colleague's lookup has answered who they are and before the placement opens.
        let transactions = 0;
        const shim = new Proxy(api, {
          get(target, property) {
            const value = Reflect.get(target, property, target) as unknown;
            if (property === 'withRls') {
              return async (...args: unknown[]) => {
                const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
                transactions += 1;
                if (transactions === 1) await owner.query(change, [sender.id]);
                return result;
              };
            }
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        }) as PrismaService;
        const { requests: shimmed } = build(shim);
        await assert.rejects(shimmed.accept(sent.id, asTeacher(t[0]!)), (e: unknown) => codeOf(e) === 'COVER_REQUEST_SENDER_GONE', `${what}: the sender's change was not said as that`);
        assert.equal((await requestOf(sent.id)).status, 'OPEN', what);
        assert.deepEqual(await substitutesOf(l), [], what);
        assert.equal((await one<{ answer: string }>(`SELECT answer::text FROM "CoverRequestRecipients" WHERE "requestId" = $1 AND "userId" = $2`, [sent.id, t[0]!.id])).answer, 'PENDING', what);
      }
    });

    await check('(cr-o) the vikarie is away themself: the pair is open again on the board, a question about it stands through the job’s pass, and a yes places the next colleague', async () => {
      const job = new CoverRequestsJob(requests);
      const l = await lesson(70, 6);
      const vik = await person('TEACHER', 'vikarie-borta');
      await cover.decide(l, { absenceId: absence, kind: 'SUBSTITUTE', substituteId: vik.id, expected: 'OPEN' }, asAdmin);
      // The absent teacher's row went with the decision.
      assert.equal(
        (await rows(`SELECT 1 FROM "CalendarLessonTeachers" WHERE "calendarLessonId" = $1 AND "teacherId" = $2`, [l, absent.id])).length,
        0,
      );
      // The vikarie falls ill the same day: the board reads the pair as open again.
      await owner.query(
        `INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt") VALUES ($1, $2, now() - interval '1 day', now() + interval '90 days')`,
        [s, vik.id],
      );
      const date = await dayOf(70);
      const pair = (await cover.board(date, date, asAdmin)).items.find((item) => item.lessonId === l && item.absenceId === absence);
      assert.equal(pair?.status, 'OPEN', 'the board does not read the pair as open again');

      const sent = await requests.create({ lessons: [{ lessonId: l, absenceId: absence }], recipientIds: [t[0]!.id, t[1]!.id] }, asAdmin);
      await job.tick();
      assert.equal((await requestOf(sent.id)).status, 'OPEN', 'the job closed a question the board still needs answered');
      assert.deepEqual((await noticesAbout(sent.id)).filter((n) => n.type === 'COVER_REQUEST_CLOSED'), []);
      // And the yes is placed: the colleague takes the lesson from the vikarie who is away.
      await requests.accept(sent.id, asTeacher(t[0]!));
      assert.equal((await requestOf(sent.id)).status, 'ACCEPTED');
      assert.ok((await substitutesOf(l)).includes(t[0]!.id));
    });

    await check('(cr-p) a question that ran out and is swept by a new question tells its sender that nobody said yes, unless it is the same administrator', async () => {
      const lonely = await lesson(75, 6);
      const old = await plantRequest(admin2.id, lonely, absence, [t[0]!.id], 5);
      const fresh = await requests.create({ lessons: [{ lessonId: lonely, absenceId: absence }], recipientIds: [t[1]!.id] }, asAdmin);
      assert.equal((await requestOf(old)).status, 'EXPIRED');
      assert.deepEqual(
        (await noticesAbout(old)).map((n) => [n.userId, n.type, n.meta['reason']]),
        [[admin2.id, 'COVER_REQUEST_CLOSED', 'UNANSWERED']],
      );
      namesNothing(await noticesAbout(old));
      await requests.withdraw(fresh.id, asAdmin);

      // The administrator who asks again knows already.
      const again = await lesson(76, 6);
      const mine = await plantRequest(admin.id, again, absence, [t[0]!.id], 5);
      const second = await requests.create({ lessons: [{ lessonId: again, absenceId: absence }], recipientIds: [t[1]!.id] }, asAdmin);
      assert.equal((await requestOf(mine)).status, 'EXPIRED');
      assert.deepEqual(await noticesAbout(mine), []);
      await requests.withdraw(second.id, asAdmin);
    });
  } finally {
    await racer.$disconnect().catch(() => undefined);
    await sweepCoverRequestsSchool(owner, marker);
  }
}
