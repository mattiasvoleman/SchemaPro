/**
 * The adapter probe's checks for Mentorns ledighetsbeslut (20261023090000,
 * 20261023091000), against real Postgres as CI runs it, through the real
 * LeaveService, NotificationsService and TeacherDutiesService on the API's
 * role. In schools of their own (slug <marker>-ledighet, and
 * <marker>-ledighet-fall for the case table), swept whole before and after:
 *
 *   la  the case table (src/family/school-days.cases.json): every case
 *       planted as the owner and asked of app.leave_school_days, and of
 *       school-days.ts over what readSchoolDayBasis reads as the school's
 *       admin under RLS; both give exactly the case's days;
 *   lb  the same two over the leave school's own läsår, lov and classes, for
 *       60 periods; and the mentors app.leave_mentors finds against
 *       duty-dates.ts mentorsOf for a pupil who has been in the class all
 *       along;
 *   lc  the guardian files, and the database tells both mentors of 7A in the
 *       filing transaction (two LEAVE_REQUESTED rows, the delivery handed
 *       their addresses, no reason anywhere in the notice); both read it in
 *       their inbox with its facts, and a teacher who mentors nobody does not;
 *   ld  the two mentors decide at once: the second waits for the first's row
 *       lock, then finds nothing pending and is a 409; the absence is
 *       written once, on the request's skoldagar, and the guardian reads that
 *       the mentor decided;
 *   le  a request over sportlovet: twelve days, three skoldagar, the
 *       mentor's, and the approval writes absence on those three only;
 *   lf  a request over the delegation's limit is not the mentor's: her
 *       decision is a 409 (app.leave_request_taken), and rektor decides it as
 *       ADMIN; a request passed on to rektor leaves the mentor's inbox, the
 *       co-mentor's decision of it is a 409 too, and it shows in rektor's
 *       with who passed it on;
 *   lg  HR data decides: moving Anna's uppdrag's Till through the real
 *       TeacherDutiesService takes her pending request from her inbox and
 *       leaves it Bertil's; a new delegation of no days takes it from both;
 *   li  the catch-ups: a request filed while nothing is delegated tells
 *       nobody, and the delegation recorded after it tells both mentors,
 *       once; a MENTORSKAP written through TeacherDutiesService tells its
 *       teacher of every pending request it gives them;
 *   lj  the year: a request of more than 366 days is refused by the gateway
 *       (400) and by LeaveRequests_a_year_at_most, and app.leave_school_days
 *       counts no further than a year from its first day;
 *   lh  rektor's inbox, timed: 600 pupils and 300 requests, read as admin.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { LeaveService } from '../../src/family/leave.service';
import { readSchoolDayBasis, schoolDaysOf, type SchoolDayBreak, type SchoolDayEnrollment, type SchoolDayYear } from '../../src/family/school-days';
import { NotificationDeliveryService } from '../../src/notifications/notification-delivery.service';
import type { OutboxEntry } from '../../src/notifications/notification-outbox';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { mentorsOf } from '../../src/staffing/duty-dates';
import { TeacherDutiesService } from '../../src/staffing/teacher-duties.service';
import { TeacherEmploymentsService } from '../../src/staffing/teacher-employments.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;
type Person = { id: string; authId: string };

const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const mondayOf = (date: string) => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));

interface Case {
  name: string;
  years: SchoolDayYear[];
  breaks: SchoolDayBreak[];
  enrollments: SchoolDayEnrollment[];
  from: string;
  to: string;
  days: string[];
}

export function leaveSlug(marker: string): string {
  return `${marker}-ledighet`;
}

export async function sweepLeaveSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug IN ($1, $2)`, [leaveSlug(marker), `${leaveSlug(marker)}-fall`]);
}

/** A held decision: the service's transaction parks after its body until released. */
function held(api: PrismaService, reached: () => void, release: Promise<void>): PrismaService {
  return {
    withRls: <T>(user: AuthenticatedUser, fn: (tx: PrismaClient) => Promise<T>) =>
      api.withRls(
        user,
        async (tx) => {
          const result = await fn(tx);
          reached();
          await release;
          return result;
        },
        { timeoutMs: 60_000 },
      ),
  } as unknown as PrismaService;
}

export async function leaveChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepLeaveSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const { today } = await one<{ today: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS today`);

  // ---------------------------------------------------------------------
  // (la) the case table, SQL and TypeScript, case by case
  // ---------------------------------------------------------------------
  await check('(la) every case of school-days.cases.json gives its days in app.leave_school_days and in school-days.ts read under RLS', async () => {
    const cases = (JSON.parse(readFileSync(join(__dirname, '..', '..', 'src', 'family', 'school-days.cases.json'), 'utf8')) as { cases: Case[] }).cases;
    assert.ok(cases.length >= 13, `the case table holds ${cases.length} cases`);
    const school = await one<{ id: string }>(
      `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
      [`${marker} ledighet fall`, `${leaveSlug(marker)}-fall`],
    );
    const admin = await one<Person>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
       VALUES ($1, $2, 'Probe', 'Rektor', 'SCHOOL_ADMIN', gen_random_uuid(), true, now()) RETURNING id, "authId"`,
      [school.id, `${marker}-fall-admin@example.invalid`],
    );
    const principal: AuthenticatedUser = { authId: admin.authId, userId: admin.id, schoolId: school.id, role: Role.SCHOOL_ADMIN };
    for (const [index, entry] of cases.entries()) {
      const pupil = await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
         VALUES ($1, $2, 'Fall', $3, 'STUDENT', gen_random_uuid(), true, now()) RETURNING id`,
        [school.id, `${marker}-fall-${index}@example.invalid`, String(index)],
      );
      await owner.query(`DELETE FROM "AcademicYears" WHERE "schoolId" = $1`, [school.id]);
      const years: string[] = [];
      for (const [y, year] of entry.years.entries()) {
        years.push(
          (
            await one<{ id: string }>(
              `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
               VALUES ($1, $2, $3::date, $4::date, false, now()) RETURNING id`,
              [school.id, `fall ${index}.${y}`, year.startDate, year.endDate],
            )
          ).id,
        );
      }
      for (const entryBreak of entry.breaks) {
        await owner.query(
          `INSERT INTO "SchoolBreaks" ("schoolId", "academicYearId", name, "startDate", "endDate", "minGradeLevel", "maxGradeLevel", "updatedAt")
           VALUES ($1, $2, 'fall', $3::date, $4::date, $5, $6, now())`,
          [school.id, years[0], entryBreak.startDate, entryBreak.endDate, entryBreak.minGradeLevel, entryBreak.maxGradeLevel],
        );
      }
      if (entry.enrollments.length > 0) {
        // The history is the Users trigger's to write; a case states it outright.
        await owner.query('BEGIN');
        try {
          await owner.query('ALTER TABLE "StudentEnrollments" DISABLE TRIGGER "StudentEnrollments_written_by_trigger"');
          for (const segment of entry.enrollments) {
            await owner.query(
              `INSERT INTO "StudentEnrollments" ("schoolId", "studentId", "academicYearId", "studentGroupId", "gradeLevel", "validFrom", "validTo")
               VALUES ($1, $2, $3, NULL, $4, $5::date, $6::date)`,
              [school.id, pupil.id, years[0], segment.gradeLevel, segment.validFrom, segment.validTo],
            );
          }
          await owner.query('ALTER TABLE "StudentEnrollments" ENABLE TRIGGER "StudentEnrollments_written_by_trigger"');
          await owner.query('COMMIT');
        } catch (error) {
          await owner.query('ROLLBACK');
          throw error;
        }
      }
      const sql = (
        await owner.query<{ day: string }>(`SELECT d::text AS day FROM app.leave_school_days($1, $2, $3::date, $4::date) d`, [
          school.id,
          pupil.id,
          entry.from,
          entry.to,
        ])
      ).rows.map((row) => row.day);
      const basis = await api.withRls(principal, (tx) => readSchoolDayBasis(tx, school.id, pupil.id, entry.from, entry.to));
      const ts = schoolDaysOf(basis, entry.from, entry.to);
      assert.deepEqual(sql, entry.days, `${entry.name}: the SQL gives ${sql.join(',')}`);
      assert.deepEqual(ts, entry.days, `${entry.name}: the TypeScript gives ${ts.join(',')}`);
    }
    await owner.query(`DELETE FROM "Schools" WHERE id = $1`, [school.id]);
  });

  // ---------------------------------------------------------------------
  // The leave school
  // ---------------------------------------------------------------------
  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${marker} ledighet`, leaveSlug(marker)],
  );
  const s = school.id;
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, $2, $3::date, $4::date, true, now()) RETURNING id`,
    [s, `${marker} ledighet`, addDays(today, -30), addDays(today, 200)],
  );
  const group = async (name: string, grade: number) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, $4, now()) RETURNING id`,
        [s, year.id, name, grade],
      )
    ).id;
  const g7a = await group('7A', 7);
  const g7b = await group('7B', 7);
  const person = (role: string, key: string, first: string, groupId: string | null = null) =>
    one<Person>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4::"UserRole", gen_random_uuid(), true, $5, now()) RETURNING id, "authId"`,
      [s, `${marker}-ledighet-${key}@example.invalid`, first, role, groupId],
    );
  const rektor = await person('SCHOOL_ADMIN', 'rektor', 'Rut');
  const anna = await person('TEACHER', 'anna', 'Anna');
  const bertil = await person('TEACHER', 'bertil', 'Bertil');
  const david = await person('TEACHER', 'david', 'David');
  const vera = await person('GUARDIAN', 'vera', 'Vera');
  const ella = await person('STUDENT', 'ella', 'Ella', g7a);
  const gustav = await person('STUDENT', 'gustav', 'Gustav', g7b);
  await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3)`, [s, vera.id, ella.id]);
  const as = (who: Person, role: Role): AuthenticatedUser => ({ authId: who.authId, userId: who.id, schoolId: s, role });
  const admin = as(rektor, Role.SCHOOL_ADMIN);
  const annaUser = as(anna, Role.TEACHER);
  const bertilUser = as(bertil, Role.TEACHER);
  const davidUser = as(david, Role.TEACHER);
  const guardian = as(vera, Role.GUARDIAN);

  // Two weeks out, and sportlovet two weeks after that: every day lies after
  // the pupils' first class segment (today).
  const M = mondayOf(addDays(today, 14));
  const lov = { from: addDays(M, 14), to: addDays(M, 18) };
  await owner.query(
    `INSERT INTO "SchoolBreaks" ("schoolId", "academicYearId", name, "startDate", "endDate", "updatedAt") VALUES ($1, $2, 'Sportlov', $3::date, $4::date, now())`,
    [s, year.id, lov.from, lov.to],
  );

  const employments = new TeacherEmploymentsService(api);
  for (const [teacher, signature] of [
    [anna, 'ANME'],
    [bertil, 'BEME'],
    [david, 'DALÄ'],
  ] as const) {
    await employments.upsert(teacher.id, year.id, { employmentPercent: 100, signature }, admin);
  }
  const delivery = new NotificationDeliveryService(api);
  const delivered: OutboxEntry[] = [];
  const notifications = new (class extends NotificationsService {
    override deliver(tx: PrismaClient, entry: OutboxEntry): void {
      delivered.push(entry);
      super.deliver(tx, entry);
    }
  })(api, delivery);
  // With the notifications, as Nest builds it: a MENTORSKAP written here
  // tells its teacher of the pending requests it gives them (li).
  const duties = new TeacherDutiesService(api, notifications);
  const annaDuty = await duties.create(
    { userId: anna.id, academicYearId: year.id, kind: 'MENTORSKAP', label: 'Mentor 7A', minutesPerWeek: 60, studentGroupId: g7a },
    admin,
  );
  await duties.create(
    { userId: bertil.id, academicYearId: year.id, kind: 'MENTORSKAP', label: 'Mentor 7A', minutesPerWeek: 60, studentGroupId: g7a },
    admin,
  );

  const leave = new LeaveService(api, notifications);
  await leave.recordDelegation({ mentorMaxSchoolDays: 3, reference: `${marker} delegation` }, admin);

  const file = (from: string, to: string, reason: string, who = guardian, pupil = ella) =>
    leave.createLeaveRequest({ studentId: pupil.id, startDate: from, endDate: to, reason }, who);
  const inbox = async (user: AuthenticatedUser, status?: 'PENDING' | 'APPROVED' | 'REJECTED') =>
    leave.listLeaveRequests(status ? { status } : {}, user);
  const absenceDays = async (pupil: Person) =>
    (
      await owner.query<{ day: string }>(
        `SELECT date::text AS day FROM "AbsenceReports" WHERE "studentId" = $1 AND note = 'Approved leave' ORDER BY date`,
        [pupil.id],
      )
    ).rows.map((row) => row.day);

  // ---------------------------------------------------------------------
  // (lb) parity over the school's own year
  // ---------------------------------------------------------------------
  await check('(lb) over the leave school’s läsår, lov and classes, the SQL and the TypeScript agree on skoldagar, and on the mentors', async () => {
    let state = 20261023;
    const random = () => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return state / 2 ** 31;
    };
    for (let n = 0; n < 60; n++) {
      const pupil = n % 2 === 0 ? ella : gustav;
      const from = addDays(today, Math.floor(random() * 230) - 40);
      const to = addDays(from, Math.floor(random() * 25));
      const { count } = await one<{ count: string }>(`SELECT count(*) AS count FROM app.leave_school_days($1, $2, $3::date, $4::date)`, [
        s,
        pupil.id,
        from,
        to,
      ]);
      const basis = await api.withRls(admin, (tx) => readSchoolDayBasis(tx, s, pupil.id, from, to));
      assert.equal(schoolDaysOf(basis, from, to).length, Number(count), `${from}–${to}: the SQL counts ${count}`);
    }
    for (const [from, to] of [
      [today, addDays(today, 3)],
      [addDays(today, 30), addDays(today, 60)],
      [addDays(today, 199), addDays(today, 240)],
    ] as const) {
      const sql = (
        await owner.query<{ id: string }>(`SELECT m::text AS id FROM app.leave_mentors($1, $2, $3::date, $4::date) m ORDER BY 1`, [s, ella.id, from, to])
      ).rows.map((row) => row.id);
      const ts = await api.withRls(admin, (tx) => mentorsOf(tx, g7a, new Date(`${from}T00:00:00Z`), new Date(`${to}T00:00:00Z`)));
      assert.deepEqual(sql, [...new Set(ts.map((m) => m.userId))].sort(), `${from}–${to}: the mentors differ`);
    }
  });

  // ---------------------------------------------------------------------
  // (lc) filing tells both mentors, and only them
  // ---------------------------------------------------------------------
  let shortId = '';
  await check('(lc) the guardian files, both mentors of 7A are told in the filing transaction, read it with its facts, and nobody else does', async () => {
    delivered.length = 0;
    const made = await file(M, addDays(M, 2), 'Probe: kort resa');
    shortId = made.id;
    const told = await owner.query<{ userId: string; meta: Record<string, unknown> }>(
      `SELECT "userId", meta FROM "Notifications" WHERE "schoolId" = $1 AND type = 'LEAVE_REQUESTED' ORDER BY "userId"`,
      [s],
    );
    assert.deepEqual(told.rows.map((row) => row.userId), [anna.id, bertil.id].sort());
    for (const row of told.rows) {
      assert.deepEqual(row.meta, { leaveRequestId: made.id, studentName: 'Ella Probe', startDate: M, endDate: addDays(M, 2), schoolDays: 3 });
    }
    assert.equal(delivered.length, 1, 'the filing handed the delivery no notice, or more than one');
    assert.deepEqual(delivered[0]!.recipients.map((r) => r.userId).sort(), [anna.id, bertil.id].sort());
    // The addresses the database handed back for the e-mail; whether a mail
    // goes is the delivery's (RESEND_API_KEY), after the commit.
    assert.deepEqual(delivered[0]!.email?.recipients.map((r) => r.email).sort(), [
      `${marker}-ledighet-anna@example.invalid`,
      `${marker}-ledighet-bertil@example.invalid`,
    ]);
    assert.ok(!JSON.stringify(delivered[0]).includes('kort resa'), 'the notice carried the reason');

    for (const mentor of [annaUser, bertilUser]) {
      const [row] = await inbox(mentor, 'PENDING');
      assert.ok(row, 'a mentor does not read the request');
      assert.equal(row.reason, 'Probe: kort resa');
      assert.equal(row.schoolDays, 3);
      assert.equal(row.decides, 'MENTOR');
      assert.deepEqual(row.decidingMentors.map((m) => m.id).sort(), [anna.id, bertil.id].sort());
      assert.deepEqual(row.year && { approved: row.year.approvedRequests, pending: row.year.pendingRequests }, { approved: 0, pending: 0 });
    }
    assert.deepEqual(await inbox(davidUser), [], 'a teacher who mentors nobody reads a request');
    const fromAdmin = await inbox(admin, 'PENDING');
    assert.deepEqual(fromAdmin.map((row) => [row.id, row.decides]), [[made.id, 'MENTOR']]);
  });

  // ---------------------------------------------------------------------
  // (ld) the first decision wins, under real concurrency
  // ---------------------------------------------------------------------
  await check('(ld) two mentors decide at once: the second waits on the first’s row lock, finds nothing pending and is a 409; the absence is written once', async () => {
    let reached!: () => void;
    const parked = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const first = new LeaveService(held(api, reached, released), notifications)
      .decideLeaveRequest(shortId, { status: 'APPROVED', note: 'Trevlig resa' }, annaUser)
      .then((result) => result, (error: unknown) => error);
    await parked;
    const second = leave.decideLeaveRequest(shortId, { status: 'REJECTED' }, bertilUser).then(
      () => null,
      (error: unknown) => error,
    );
    for (let tries = 0; ; tries++) {
      const { rows } = await owner.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%LeaveRequests%'`,
      );
      if (Number(rows[0]!.n) > 0) break;
      assert.ok(tries < 500, 'the second decision never waited on the first');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    const [won, lost] = await Promise.all([first, second]);
    assert.deepEqual(won, { id: shortId, status: 'APPROVED', decidedAs: 'MENTOR', absenceDays: 3 });
    assert.ok(lost instanceof ConflictException, `the second decision was ${String(lost)}`);
    assert.deepEqual(await absenceDays(ella), [M, addDays(M, 1), addDays(M, 2)]);
    const seen = await api.withRls(guardian, (tx) => tx.leaveRequest.findMany({ where: { id: shortId }, select: { status: true, decidedAs: true } }));
    assert.deepEqual(seen, [{ status: 'APPROVED', decidedAs: 'MENTOR' }]);
    assert.deepEqual((await inbox(bertilUser)).map((row) => row.id), [], 'Bertil reads Anna’s decision');
    assert.deepEqual((await inbox(annaUser, 'APPROVED')).map((row) => [row.id, row.decidedAs]), [[shortId, 'MENTOR']]);
  });

  // ---------------------------------------------------------------------
  // (le) over sportlovet
  // ---------------------------------------------------------------------
  await check('(le) twelve days over sportlovet are three skoldagar: the mentor’s, and the approval writes absence on those three only', async () => {
    const from = addDays(M, 10);
    const to = addDays(M, 21);
    const made = await file(from, to, 'Probe: över lovet');
    const [row] = (await inbox(annaUser, 'PENDING')).filter((candidate) => candidate.id === made.id);
    assert.equal(row?.schoolDays, 3);
    assert.equal(row?.year?.approvedDays, 3, 'the läsår so far does not count the approved leave');
    const decided = await leave.decideLeaveRequest(made.id, { status: 'APPROVED' }, annaUser);
    assert.equal(decided.absenceDays, 3);
    const days = await absenceDays(ella);
    assert.deepEqual(days.filter((day) => day >= from), [from, addDays(M, 11), to]);
  });

  // ---------------------------------------------------------------------
  // (lf) over the limit, and passed on
  // ---------------------------------------------------------------------
  await check('(lf) over the limit the request is rektor’s, decided as ADMIN; passed on, it leaves the mentor for rektor', async () => {
    const long = await file(addDays(M, 28), addDays(M, 31), 'Probe: fyra dagar');
    // Anna mentors the pupil on those days, but the request is rektor's: the
    // gateway says it is decided or no longer hers, never that it is unknown.
    await assert.rejects(leave.decideLeaveRequest(long.id, { status: 'APPROVED' }, annaUser), ConflictException);
    await assert.rejects(leave.decideLeaveRequest(long.id, { status: 'APPROVED' }, davidUser), NotFoundException);
    const [rektors] = (await inbox(admin, 'PENDING')).filter((row) => row.id === long.id);
    assert.equal(rektors?.decides, 'ADMIN');
    assert.equal(rektors?.schoolDays, 4);
    assert.deepEqual(rektors?.mentors.map((m) => m.id).sort(), [anna.id, bertil.id].sort());
    assert.deepEqual(await leave.decideLeaveRequest(long.id, { status: 'REJECTED', note: 'För lång' }, admin), {
      id: long.id,
      status: 'REJECTED',
      decidedAs: 'ADMIN',
      absenceDays: 0,
    });

    const passed = await file(addDays(M, 35), addDays(M, 35), 'Probe: till rektor');
    assert.deepEqual(await leave.referLeaveRequest(passed.id, annaUser), { id: passed.id, referred: true });
    assert.ok(!(await inbox(annaUser)).some((row) => row.id === passed.id), 'the mentor still reads what she passed on');
    assert.ok(!(await inbox(bertilUser)).some((row) => row.id === passed.id), 'the co-mentor reads what was passed on');
    await assert.rejects(leave.decideLeaveRequest(passed.id, { status: 'APPROVED' }, bertilUser), ConflictException);
    await assert.rejects(leave.referLeaveRequest(passed.id, bertilUser), ConflictException);
    const [atRektor] = (await inbox(admin, 'PENDING')).filter((row) => row.id === passed.id);
    assert.equal(atRektor?.decides, 'ADMIN');
    assert.equal(atRektor?.referral?.by, 'Anna Probe');
  });

  // ---------------------------------------------------------------------
  // (lg) HR data decides access
  // ---------------------------------------------------------------------
  await check('(lg) Anna’s Till moved through TeacherDutiesService takes her pending request, Bertil keeps it, and no delegation takes it from both', async () => {
    const made = await file(addDays(M, 42), addDays(M, 42), 'Probe: personaldata');
    const pending = async (user: AuthenticatedUser) => (await inbox(user, 'PENDING')).map((row) => row.id);
    assert.ok((await pending(annaUser)).includes(made.id));
    await duties.update(annaDuty.id, { validTo: addDays(M, 41) }, admin);
    assert.ok(!(await pending(annaUser)).includes(made.id), 'with her uppdrag ended, Anna still reads the request');
    assert.ok((await pending(bertilUser)).includes(made.id), 'Bertil lost the request with Anna’s Till');
    await duties.update(annaDuty.id, { validTo: null }, admin);
    assert.ok((await pending(annaUser)).includes(made.id), 'Anna did not get the request back with her uppdrag');
    await leave.recordDelegation({ mentorMaxSchoolDays: null }, admin);
    assert.deepEqual(await pending(annaUser), []);
    assert.deepEqual(await pending(bertilUser), []);
    const [atRektor] = (await inbox(admin, 'PENDING')).filter((row) => row.id === made.id);
    assert.equal(atRektor?.decides, 'ADMIN');
    await leave.recordDelegation({ mentorMaxSchoolDays: 3 }, admin);
  });

  // ---------------------------------------------------------------------
  // (li) the catch-ups
  // ---------------------------------------------------------------------
  const toldOf = async (requestId: string) =>
    (
      await owner.query<{ userId: string }>(
        `SELECT "userId" FROM "Notifications" WHERE "schoolId" = $1 AND type = 'LEAVE_REQUESTED' AND meta ->> 'leaveRequestId' = $2 ORDER BY "userId"`,
        [s, requestId],
      )
    ).rows.map((row) => row.userId);
  await check('(li) a delegation recorded after a request tells its mentors once, and so does a MENTORSKAP written through TeacherDutiesService', async () => {
    await leave.recordDelegation({ mentorMaxSchoolDays: null }, admin);
    delivered.length = 0;
    const early = await file(addDays(M, 49), addDays(M, 49), 'Probe: före delegeringen');
    assert.deepEqual(await toldOf(early.id), [], 'a request rektor decides told a mentor');
    assert.equal(delivered.length, 0);

    await leave.recordDelegation({ mentorMaxSchoolDays: 3 }, admin);
    assert.deepEqual(await toldOf(early.id), [anna.id, bertil.id].sort());
    const entry = delivered.find((candidate) => candidate.meta['leaveRequestId'] === early.id);
    assert.ok(entry, 'the delegation handed the delivery no notice of the earlier request');
    assert.deepEqual(entry.recipients.map((r) => r.userId).sort(), [anna.id, bertil.id].sort());
    // Every other pending request was told when it was filed: nobody twice.
    assert.deepEqual(delivered.map((candidate) => candidate.meta['leaveRequestId']), [early.id]);
    // The filer reads back what their own filing's transaction wrote, and
    // never the mentors' addresses from a later one.
    const readBack = await api.withRls(guardian, (tx) => tx.$queryRaw<unknown[]>`SELECT * FROM app.leave_request_notices(${early.id}::uuid)`);
    assert.deepEqual(readBack, [], 'the filer read back notices another transaction wrote');
    await leave.recordDelegation({ mentorMaxSchoolDays: 3 }, admin);
    assert.deepEqual(await toldOf(early.id), [anna.id, bertil.id].sort(), 'a second delegation told a mentor again');

    delivered.length = 0;
    const davidDuty = await duties.create(
      { userId: david.id, academicYearId: year.id, kind: 'MENTORSKAP', label: 'Mentor 7A', minutesPerWeek: 60, studentGroupId: g7a },
      admin,
    );
    const davids = (await inbox(davidUser, 'PENDING')).map((row) => row.id).sort();
    assert.ok(davids.includes(early.id), 'the new mentor does not read the pending request');
    const toldDavid = (
      await owner.query<{ id: string }>(
        `SELECT meta ->> 'leaveRequestId' AS id FROM "Notifications" WHERE "userId" = $1 AND type = 'LEAVE_REQUESTED' ORDER BY 1`,
        [david.id],
      )
    ).rows.map((row) => row.id);
    assert.deepEqual(toldDavid, davids, 'the new mentor was told of other requests than his inbox shows');
    assert.deepEqual(delivered.flatMap((candidate) => candidate.recipients.map((r) => r.userId)), davids.map(() => david.id));
    await duties.remove(davidDuty.id, admin);
  });

  // ---------------------------------------------------------------------
  // (lj) at most a year
  // ---------------------------------------------------------------------
  await check('(lj) a request of more than 366 days is refused by the gateway and by the table, and the skoldagar stop at a year', async () => {
    await assert.rejects(file(M, addDays(M, 366), 'Probe: för lång'), BadRequestException);
    const refused = await owner
      .query(
        `INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason)
         VALUES ($1, $2, $3, $4::date, $4::date + 366, 'Probe: för lång')`,
        [s, ella.id, vera.id, M],
      )
      .then(
        () => null,
        (error: { code?: string; constraint?: string }) => error,
      );
    assert.equal(refused?.code, '23514', 'the table took a request of 367 days');
    assert.equal(refused?.constraint, 'LeaveRequests_a_year_at_most');
    const counted = async (to: string) =>
      Number((await one<{ count: string }>(`SELECT count(*) AS count FROM app.leave_school_days($1, $2, $3::date, $4::date)`, [s, ella.id, M, to])).count);
    assert.equal(await counted(addDays(M, 3650)), await counted(addDays(M, 365)), 'app.leave_school_days counted past a year');
  });

  // ---------------------------------------------------------------------
  // (lh) rektor's inbox, timed
  // ---------------------------------------------------------------------
  await check('(lh) rektor’s inbox over 600 pupils and 300 requests, timed for the record', async () => {
    await owner.query(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       SELECT $1, $2 || '-elev-' || n || '@example.invalid', 'Elev', n::text, 'STUDENT', gen_random_uuid(), true,
              CASE WHEN n % 2 = 0 THEN $3::uuid ELSE $4::uuid END, now()
         FROM generate_series(1, 600) AS n`,
      [s, marker, g7a, g7b],
    );
    await owner.query(
      `INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason, status, "decidedById", "decidedAt", "decidedAs")
       SELECT $1, u.id, $2, $3::date + (n % 120), $3::date + (n % 120) + (n % 6), 'Probe: mängd',
              CASE WHEN n % 3 = 0 THEN 'APPROVED' ELSE 'PENDING' END::"LeaveRequestStatus",
              CASE WHEN n % 3 = 0 THEN $2::uuid END, CASE WHEN n % 3 = 0 THEN now() END,
              CASE WHEN n % 3 = 0 THEN 'ADMIN' END::"LeaveDeciderRole"
         FROM (SELECT id, (row_number() OVER (ORDER BY id))::int AS n FROM "Users" WHERE "schoolId" = $1 AND role = 'STUDENT' AND email LIKE $4) u
        WHERE u.n <= 300`,
      [s, rektor.id, today, `${marker}-elev-%`],
    );
    const timed = async (label: string, user: AuthenticatedUser, status: 'PENDING' | 'APPROVED') => {
      const runs: number[] = [];
      let rows = 0;
      for (let n = 0; n < 5; n++) {
        const started = performance.now();
        rows = (await inbox(user, status)).length;
        runs.push(performance.now() - started);
      }
      runs.sort((a, b) => a - b);
      console.log(`    ${label}: ${rows} requests, median ${runs[2]!.toFixed(0)} ms (min ${runs[0]!.toFixed(0)}, max ${runs[4]!.toFixed(0)})`);
      return { rows, median: runs[2]! };
    };
    const pendingAdmin = await timed('rektor, väntar', admin, 'PENDING');
    const approvedAdmin = await timed('rektor, beviljade', admin, 'APPROVED');
    const mentor = await timed('Anna, väntar', annaUser, 'PENDING');
    assert.ok(pendingAdmin.rows >= 200 && approvedAdmin.rows >= 100, 'the timing measured fewer requests than it says');
    assert.ok(mentor.rows > 0, 'the mentor’s timing measured an empty inbox');
    // A bound for a broken plan, not a target: the numbers are logged above.
    assert.ok(pendingAdmin.median < 3000 && approvedAdmin.median < 3000 && mentor.median < 3000, 'an inbox took over three seconds');
  });

  await sweepLeaveSchool(owner, marker);
}
