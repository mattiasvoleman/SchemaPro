/**
 * The adapter probe's checks for Elevlistan i uppföljningen
 * (20261215090000): what the events a membership moves do to other writers,
 * which only two real connections show. In a school of its own (slug
 * <marker>-elevlistan), swept whole before and after: 7A with eight pupils,
 * SvA7 replacing svenska, and four svenska lessons of 7A. Pupil P_n going into
 * SvA7 moves all four events, at the transaction's commit. For el-e also last
 * läsår, EnS7 replacing engelska with P6 in it, and an engelska lesson of a
 * this-year group without pupils with 7A added. For el-g a teacher T and 7A's
 * matematik, which T teaches. For el-j last läsår's SvA6 replacing svenska,
 * with P7 in it, and a svenska lesson of last läsår with 7A added. El-l
 * makes the school one that publishes drafts, with 8A and two of its
 * matematik masters, one of them published. Both
 * writers are the API's role with the administrator as principal; the
 * teacher's writer edits a lesson, which moves its event at the statement,
 * as on main.
 *
 *   el-a  a membership committing while a teacher's transaction holds the
 *         last event (in entityId order) does not hold the first: the
 *         membership's commit backs off (it sleeps between attempts), the
 *         teacher edits the first lesson at once, commits, and then the
 *         membership's commit goes through and moves all four events;
 *   el-b  once its patience is spent (set to 0 here), the flush waits as any
 *         writer does, under the transaction's own lock_timeout, and the
 *         commit fails with 55P03 and writes nothing;
 *   el-c  a transaction of several membership statements (a sync's chunks)
 *         takes no event at its statements: the teacher edits the last
 *         lesson and the first between them without waiting, and the
 *         membership's commit then moves all four;
 *   el-d  the flush catches the lock timeout and nothing else: a REPEATABLE
 *         READ membership whose event the teacher moved after its snapshot
 *         fails its commit with 40001 at once (on main a membership took no
 *         event, and this did not fail);
 *   el-e  a group without pupils (no enrollment holds it to its läsår) moved
 *         from this läsår to last moves its lesson that 7A is added to, in
 *         engelska, which only this läsår replaces (EnS7): P6 is on it again.
 *         The old läsår is what finds it (review of #226, R2-L1). Moved back,
 *         the new läsår finds it, and P6 is off it again (R3-L1);
 *   el-f  an attempt of the flush gives up long before a deadlock check: a
 *         teacher who holds the last event and, while an attempt waits on it
 *         holding the first three, edits the first, gets it within 500 ms
 *         (an attempt under a lock_timeout past deadlock_timeout brought
 *         back round 1's deadlock, R3-L1);
 *   el-g  a transaction like a sync's apply, which renames 7A, deactivates T
 *         and writes a membership, holds none of their events or activities
 *         before its commit: the teacher edits T's matematik and 7A's
 *         svenska at once, and while the commit backs off from the last
 *         event; then the commit moves all of them (R3-M1);
 *   el-h  a deadlock at the commit (past a patience of 0, the flush waits on
 *         the teacher's last event holding the first, and the teacher
 *         reaches for the first) reaches a withRls caller as the adapter's
 *         error, which the API answers with its 409 WRITE_CONFLICT and the
 *         sync reads as 40P01 (R3-M2). The teacher here is the owner, with a
 *         deadlock_timeout of 5 s, so the commit, which began waiting first,
 *         is the victim every time (R5-L3);
 *   el-i  under a publication of every table's deletes a membership still
 *         commits: the pending table is unlogged and in no publication
 *         (R3-M3);
 *   el-j  P7, whose class 7A is added to last läsår's svenska and who is in
 *         last läsår's SvA6, removed: that lesson moves, though the class is
 *         this läsår's (R3-L4);
 *   el-k  T, deactivated, reactivated: the matematik's event and activity
 *         move at the commit, and so does the activity of a matematik master
 *         T teaches (R4-L1);
 *   el-l  in a school that publishes drafts, 8A renamed: the activity of its
 *         published master moves (the snapshot is what is served), that of a
 *         master only the draft has does not (R4-L1);
 *   el-m  P2, named on T's matematik (a subject nothing replaces), relinked:
 *         that lesson moves at the commit (R4-L1);
 *   el-n  a membership whose transaction is older than its patience when
 *         it commits still backs off from the teacher's last event, holding
 *         none: the patience runs from the flush, not from the transaction's
 *         start (R5-L4, the reviewer's `aged`);
 *
 * and after each, the pending table is empty.
 *
 * Observing the waits: the probe polls pg_stat_activity for the membership's
 * backend (as the staffing checks poll pg_blocking_pids), with a deadline,
 * and asserts on what it is waiting on. No step sleeps for a set time.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { WRITE_CONFLICT, isWriteConflict, rethrowPrismaError } from '../../src/common/utils/prisma-errors';
import type { PrismaService } from '../../src/database/prisma.service';
import { sqlStateOf } from '../../src/integration/ss12000-sync/errors';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function elevlistanSlug(marker: string): string {
  return `${marker}-elevlistan`;
}

export async function sweepElevlistanSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [elevlistanSlug(marker)]);
}

/** A connection as the API's role (DATABASE_URL), the way the RLS suite writes as it. */
async function appClient(): Promise<{ client: Client; pid: number }> {
  return connectAs('DATABASE_URL');
}

/** A connection as the owner (PROBE_OWNER_URL), for a setting only a superuser may change. */
async function ownerClient(): Promise<{ client: Client; pid: number }> {
  return connectAs('PROBE_OWNER_URL');
}

async function connectAs(env: 'DATABASE_URL' | 'PROBE_OWNER_URL'): Promise<{ client: Client; pid: number }> {
  const url = process.env[env];
  if (!url) throw new Error(`${env} is not set`);
  const client = new Client({ connectionString: url.split('?')[0] });
  // The cleanup terminates a backend left waiting; its client then reports
  // the termination here instead of crashing the probe.
  client.on('error', () => undefined);
  await client.connect();
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return { client, pid: rows[0]!.pid };
}

interface Settled {
  error: (Error & { code?: string }) | null;
}
const settle = (promise: Promise<unknown>): Promise<Settled> =>
  promise.then(
    () => ({ error: null }),
    (error: Error & { code?: string }) => ({ error }),
  );

/** The promise's outcome, or 'pending' once `ms` have passed. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function elevlistanChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepElevlistanSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  try {
    const s = (
      await one<{ id: string }>(
        `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
        [`${marker} elevlistan`, elevlistanSlug(marker)],
      )
    ).id;
    const year = (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
         VALUES ($1, 'El i år', current_date - 30, current_date + 300, true, now()) RETURNING id`,
        [s],
      )
    ).id;
    const sv = (
      await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'El svenska', 'ELSV', now()) RETURNING id`, [s])
    ).id;
    const k7a = (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES ($1, $2, 'El 7A', 7, now()) RETURNING id`,
        [s, year],
      )
    ).id;
    const sva = (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "replacesSubjectId", "updatedAt")
         VALUES ($1, $2, 'El SvA7', 7, 'TEACHING_GROUP', $3, now()) RETURNING id`,
        [s, year, sv],
      )
    ).id;
    const adminAuth = randomUUID();
    const adminId = (
      await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
         VALUES ($1, $2, 'El', 'Admin', 'SCHOOL_ADMIN', 'FULL', $3, true, now()) RETURNING id`,
        [s, `${marker}-elevlistan-admin@example.invalid`, adminAuth],
      )
    ).id;
    const admin: AuthenticatedUser = { authId: adminAuth, userId: adminId, schoolId: s, role: Role.SCHOOL_ADMIN, adminProfile: 'FULL' };
    const pupils: string[] = [];
    for (let n = 1; n <= 8; n++) {
      pupils.push(
        (
          await one<{ id: string }>(
            `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
             VALUES ($1, $2, 'El', $3, 'STUDENT', $4, true, $5, now()) RETURNING id`,
            [s, `${marker}-elevlistan-p${n}@example.invalid`, `P${n}`, randomUUID(), k7a],
          )
        ).id,
      );
    }
    const lastYear = (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
         VALUES ($1, 'El i fjol', current_date - 400, current_date - 31, false, now()) RETURNING id`,
        [s],
      )
    ).id;
    const en = (
      await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'El engelska', 'ELEN', now()) RETURNING id`, [s])
    ).id;
    const lessons: string[] = [];
    for (let n = 0; n < 4; n++) {
      lessons.push(
        (
          await one<{ id: string }>(
            `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
             VALUES ($1, $2, $3, current_date + $4::int, (current_date + $4::int) + time '08:00', (current_date + $4::int) + time '09:00', $5, now())
             RETURNING id`,
            [s, sv, k7a, n + 1, `El-${n}`],
          )
        ).id,
      );
    }
    lessons.sort();
    const ens = (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "replacesSubjectId", "updatedAt")
         VALUES ($1, $2, 'El EnS7', 7, 'TEACHING_GROUP', $3, now()) RETURNING id`,
        [s, year, en],
      )
    ).id;
    await owner.query(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES ($1, $2, $3)`, [s, ens, pupils[5]]);
    const empty = (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "updatedAt")
         VALUES ($1, $2, 'El En7 utan elever', 7, 'TEACHING_GROUP', now()) RETURNING id`,
        [s, year],
      )
    ).id;
    const english = (
      await one<{ id: string }>(
        `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
         VALUES ($1, $2, $3, current_date + 9, (current_date + 9) + time '10:00', (current_date + 9) + time '11:00', 'El-en', now())
         RETURNING id`,
        [s, en, empty],
      )
    ).id;
    await owner.query(`INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId") VALUES ($1, $2, $3)`, [s, english, k7a]);
    // el-g: T teaches 7A's matematik, an ad hoc lesson of the active läsår
    // (its activity is the lesson's own).
    const teacher = (
      await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
         VALUES ($1, $2, 'El', 'Lärare', 'TEACHER', $3, true, now()) RETURNING id`,
        [s, `${marker}-elevlistan-t@example.invalid`, randomUUID()],
      )
    ).id;
    const ma = (
      await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'El matematik', 'ELMA', now()) RETURNING id`, [s])
    ).id;
    const maths = (
      await one<{ id: string }>(
        `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
         VALUES ($1, $2, $3, current_date + 8, (current_date + 8) + time '13:00', (current_date + 8) + time '14:00', 'El-ma', now())
         RETURNING id`,
        [s, ma, k7a],
      )
    ).id;
    await owner.query(`INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, 'LEAD')`, [s, maths, teacher]);
    // el-j: last läsår's svenska of a group of its own with this läsår's 7A
    // added, and last läsår's SvA6 with P7 (at home in 7A) in it, so P7 is
    // off that lesson.
    const sv6 = (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "updatedAt")
         VALUES ($1, $2, 'El Sv6', 6, 'TEACHING_GROUP', now()) RETURNING id`,
        [s, lastYear],
      )
    ).id;
    const svenska6 = (
      await one<{ id: string }>(
        `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", note, "updatedAt")
         VALUES ($1, $2, $3, current_date - 100, (current_date - 100) + time '08:00', (current_date - 100) + time '09:00', 'El-sv6', now())
         RETURNING id`,
        [s, sv, sv6],
      )
    ).id;
    await owner.query(`INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId") VALUES ($1, $2, $3)`, [s, svenska6, k7a]);
    const sva6 = (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", kind, "replacesSubjectId", "updatedAt")
         VALUES ($1, $2, 'El SvA6', 6, 'TEACHING_GROUP', $3, now()) RETURNING id`,
        [s, lastYear, sv],
      )
    ).id;
    await owner.query(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES ($1, $2, $3)`, [s, sva6, pupils[6]]);
    const first = lessons[0]!;
    const last = lessons[lessons.length - 1]!;
    // Each event has its version row (the inserts above moved them), so the
    // writers below meet on existing rows.
    assert.equal(
      (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "Ss12000EntityVersions" WHERE resource = 'CalendarEvent' AND "entityId" = ANY ($1::uuid[])`, [lessons])).n,
      4,
    );

    const asAdmin = `SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text)::text, true)`;
    const join = (client: Client, pupil: string) =>
      client.query(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES ($1, $2, $3)`, [s, sva, pupil]);
    // A teacher's edit that moves the event at its statement, as on main: the
    // lesson a minute later (the note alone moves nothing).
    const edit = (client: Client, lesson: string) =>
      client.query(`UPDATE "CalendarLessons" SET "startsAt" = "startsAt" + interval '1 minute', "endsAt" = "endsAt" + interval '1 minute' WHERE id = $1`, [lesson]);
    const xidOf = async (client: Client) => (await client.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')).rows[0]!.xid;
    /** The xid each entity's version carries, by resource and id. */
    const xidsOf = async (resource: string, ids: string[]) =>
      (
        await owner.query<{ xid: string }>(
          `SELECT xid::text AS xid FROM "Ss12000EntityVersions" WHERE resource = $1 AND "entityId" = ANY ($2::uuid[]) ORDER BY "entityId"`,
          [resource, ids],
        )
      ).rows.map((row) => row.xid);
    const versionsOf = async () =>
      (
        await owner.query<{ id: string; xid: string }>(
          `SELECT "entityId" AS id, xid::text AS xid FROM "Ss12000EntityVersions" WHERE resource = 'CalendarEvent' AND "entityId" = ANY ($1::uuid[]) ORDER BY 1`,
          [lessons],
        )
      ).rows;
    const member = async (pupil: string) =>
      (await owner.query(`SELECT 1 FROM "StudentGroupMembers" WHERE "studentGroupId" = $1 AND "studentId" = $2`, [sva, pupil])).rowCount === 1;
    const pendingIsEmpty = async (label: string) => {
      const { n } = await one<{ n: number }>(`SELECT count(*)::int AS n FROM app."Ss12000ReplacedPending"`);
      assert.equal(n, 0, `${label}: the pending table kept ${n} rows past the commit`);
    };
    /** Waits (with a deadline) until the backend's activity matches; returns what it saw. */
    const until = async (pid: number, what: string, matches: (row: { state: string; query: string; type: string | null; event: string | null }) => boolean) => {
      for (let tries = 0; ; tries++) {
        const { rows } = await owner.query<{ state: string; query: string; type: string | null; event: string | null }>(
          `SELECT state, query, wait_event_type AS type, wait_event AS event FROM pg_stat_activity WHERE pid = $1`,
          [pid],
        );
        if (rows[0] && matches(rows[0])) return rows[0];
        if (tries > 1000) throw new Error(`${what}: never seen; last ${JSON.stringify(rows[0])}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const inCommit = (row: { state: string; query: string }) => row.state === 'active' && /^COMMIT/i.test(row.query.trim());

    await check('el-a a committing membership backs off and holds nothing a teacher needs; then it moves every event', async () => {
      const b = await appClient();
      const a = await appClient();
      try {
        await b.client.query('BEGIN');
        await b.client.query(asAdmin, [adminAuth]);
        await join(b.client, pupils[0]!);
        const bXid = await xidOf(b.client);
        await a.client.query('BEGIN');
        await a.client.query(asAdmin, [adminAuth]);
        await a.client.query(`SET LOCAL lock_timeout = '2s'`);
        await edit(a.client, last);
        const committed = settle(b.client.query('COMMIT'));
        // Between attempts the flush sleeps, holding no version row.
        await until(b.pid, 'the membership’s flush backing off', (row) => inCommit(row) && row.event === 'PgSleep');
        // Under the teacher's lock_timeout (2 s): it waits at most for one
        // attempt of the flush (50 ms), or fails here.
        await edit(a.client, first);
        assert.equal(await within(committed, 0), 'pending', 'the membership committed while the teacher held its last event');
        await a.client.query('COMMIT');
        const outcome = await within(committed, 15_000);
        assert.notEqual(outcome, 'pending', 'the membership never committed after the teacher did');
        assert.equal((outcome as Settled).error, null, `the membership's commit failed: ${(outcome as Settled).error?.message}`);
        assert.deepEqual(
          (await versionsOf()).map((row) => row.xid),
          lessons.map(() => bXid),
          'not every event carries the membership’s transaction',
        );
        assert.ok(await member(pupils[0]!));
      } finally {
        await a.client.query('ROLLBACK').catch(() => undefined);
        await b.client.query('ROLLBACK').catch(() => undefined);
        await owner.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ANY ($1::int[])', [[a.pid, b.pid]]);
        await a.client.end().catch(() => undefined);
        await b.client.end().catch(() => undefined);
      }
      await pendingIsEmpty('el-a');
    });

    await check('el-b after its patience the flush waits as a writer, under the transaction’s lock_timeout', async () => {
      const b = await appClient();
      const a = await appClient();
      try {
        await a.client.query('BEGIN');
        await a.client.query(asAdmin, [adminAuth]);
        await a.client.query(`SET LOCAL lock_timeout = '2s'`);
        await edit(a.client, last);
        await b.client.query('BEGIN');
        await b.client.query(asAdmin, [adminAuth]);
        await b.client.query(`SELECT set_config('app.ss12000_replaced_patience', '0', true)`);
        await b.client.query(`SET LOCAL lock_timeout = '300ms'`);
        await join(b.client, pupils[1]!);
        const outcome = await within(settle(b.client.query('COMMIT')), 10_000);
        assert.notEqual(outcome, 'pending', 'the flush kept retrying past its patience');
        assert.equal((outcome as Settled).error?.code, '55P03', `the commit ended with ${(outcome as Settled).error?.message ?? 'success'}`);
        assert.equal(await member(pupils[1]!), false, 'the failed commit kept the membership');
      } finally {
        await a.client.query('ROLLBACK').catch(() => undefined);
        await b.client.query('ROLLBACK').catch(() => undefined);
        await owner.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ANY ($1::int[])', [[a.pid, b.pid]]);
        await a.client.end().catch(() => undefined);
        await b.client.end().catch(() => undefined);
      }
      await pendingIsEmpty('el-b');
    });

    await check('el-c a transaction of membership statements takes no event before its commit', async () => {
      const b = await appClient();
      const a = await appClient();
      try {
        await b.client.query('BEGIN');
        await b.client.query(asAdmin, [adminAuth]);
        await join(b.client, pupils[2]!);
        const bXid = await xidOf(b.client);
        await a.client.query('BEGIN');
        await a.client.query(asAdmin, [adminAuth]);
        await a.client.query(`SET LOCAL lock_timeout = '2s'`);
        await edit(a.client, last);
        await join(b.client, pupils[3]!);
        await edit(a.client, first);
        await a.client.query('COMMIT');
        await b.client.query('COMMIT');
        assert.deepEqual(
          (await versionsOf()).map((row) => row.xid),
          lessons.map(() => bXid),
          'not every event carries the membership’s transaction',
        );
        assert.ok((await member(pupils[2]!)) && (await member(pupils[3]!)));
      } finally {
        await a.client.query('ROLLBACK').catch(() => undefined);
        await b.client.query('ROLLBACK').catch(() => undefined);
        await owner.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ANY ($1::int[])', [[a.pid, b.pid]]);
        await a.client.end().catch(() => undefined);
        await b.client.end().catch(() => undefined);
      }
      await pendingIsEmpty('el-c');
    });

    await check('el-d the flush lets any error but the lock timeout through: 40001 at once under REPEATABLE READ', async () => {
      const b = await appClient();
      const a = await appClient();
      try {
        await b.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await b.client.query(asAdmin, [adminAuth]);
        await b.client.query(`SELECT set_config('app.ss12000_replaced_patience', '60', true)`);
        await join(b.client, pupils[4]!);
        await a.client.query('BEGIN');
        await a.client.query(asAdmin, [adminAuth]);
        // The membership's statement holds no event: the teacher does not wait.
        await a.client.query(`SET LOCAL lock_timeout = '2s'`);
        await edit(a.client, last);
        await a.client.query('COMMIT');
        const outcome = await within(settle(b.client.query('COMMIT')), 5_000);
        if (outcome === 'pending') {
          await owner.query('SELECT pg_cancel_backend($1)', [b.pid]);
          assert.fail('the flush swallowed the serialization failure and kept retrying');
        }
        assert.equal(outcome.error?.code, '40001', `the commit ended with ${outcome.error?.message ?? 'success'}`);
        assert.equal(await member(pupils[4]!), false, 'the failed commit kept the membership');
      } finally {
        await a.client.query('ROLLBACK').catch(() => undefined);
        await b.client.query('ROLLBACK').catch(() => undefined);
        await owner.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ANY ($1::int[])', [[a.pid, b.pid]]);
        await a.client.end().catch(() => undefined);
        await b.client.end().catch(() => undefined);
      }
      await pendingIsEmpty('el-d');
    });

    await check('el-e a group without pupils moved to last läsår and back moves its lesson in a subject only this läsår replaces, both ways', async () => {
      for (const [to, which] of [[lastYear, 'the old läsår'], [year, 'the new läsår']] as const) {
        const b = await appClient();
        try {
          await b.client.query('BEGIN');
          await b.client.query(asAdmin, [adminAuth]);
          const moved = await b.client.query(`UPDATE "StudentGroups" SET "academicYearId" = $2 WHERE id = $1`, [empty, to]);
          assert.equal(moved.rowCount, 1, 'the administrator could not move the group');
          const bXid = await xidOf(b.client);
          await b.client.query('COMMIT');
          assert.deepEqual(await xidsOf('CalendarEvent', [english]), [bXid], `the engelska lesson did not move (${which} finds it)`);
        } finally {
          await b.client.query('ROLLBACK').catch(() => undefined);
          await b.client.end().catch(() => undefined);
        }
      }
      await pendingIsEmpty('el-e');
    });

    await check('el-f an attempt of the flush gives up long before a deadlock check: a teacher reaching for an event it holds waits at most that attempt', async () => {
      const b = await appClient();
      const a = await appClient();
      try {
        await a.client.query('BEGIN');
        await a.client.query(asAdmin, [adminAuth]);
        await edit(a.client, last);
        await b.client.query('BEGIN');
        await b.client.query(asAdmin, [adminAuth]);
        // No fallback while the check runs: only attempts.
        await b.client.query(`SELECT set_config('app.ss12000_replaced_patience', '60', true)`);
        await join(b.client, pupils[1]!);
        const bXid = await xidOf(b.client);
        const committed = settle(b.client.query('COMMIT'));
        // Mid-attempt: the first three events locked, waiting on the last.
        await until(b.pid, 'an attempt of the flush waiting on the teacher', (row) => inCommit(row) && row.type === 'Lock');
        // The attempt gives up after 50 ms and releases the first event; one
        // that waited past deadlock_timeout (1 s) would deadlock with the
        // teacher here, or keep the teacher past this lock_timeout.
        await a.client.query(`SET LOCAL lock_timeout = '500ms'`);
        await edit(a.client, first);
        assert.equal(await within(committed, 0), 'pending', 'the membership committed while the teacher held its last event');
        await a.client.query('COMMIT');
        const outcome = await within(committed, 15_000);
        assert.notEqual(outcome, 'pending', 'the membership never committed after the teacher did');
        assert.equal((outcome as Settled).error, null, `the membership's commit failed: ${(outcome as Settled).error?.message}`);
        assert.deepEqual(await xidsOf('CalendarEvent', lessons), lessons.map(() => bXid), 'not every event carries the membership’s transaction');
      } finally {
        await a.client.query('ROLLBACK').catch(() => undefined);
        await b.client.query('ROLLBACK').catch(() => undefined);
        await owner.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ANY ($1::int[])', [[a.pid, b.pid]]);
        await a.client.end().catch(() => undefined);
        await b.client.end().catch(() => undefined);
      }
      await pendingIsEmpty('el-f');
    });

    await check('el-g a sync-like transaction (a group renamed, a membership, a teacher deactivated) holds none of their events or activities before its commit', async () => {
      const b = await appClient();
      const a = await appClient();
      try {
        await b.client.query('BEGIN');
        await b.client.query(asAdmin, [adminAuth]);
        // As the sync's apply: its lock_timeout, its order (groups, ...,
        // memberships, ..., deactivations).
        await b.client.query(`SET LOCAL lock_timeout = '10s'`);
        assert.equal((await b.client.query(`UPDATE "StudentGroups" SET name = 'El 7A omdöpt' WHERE id = $1`, [k7a])).rowCount, 1, 'the administrator could not rename 7A');
        await join(b.client, pupils[4]!);
        assert.equal((await b.client.query(`UPDATE "Users" SET "isActive" = false WHERE id = $1`, [teacher])).rowCount, 1, 'the administrator could not deactivate T');
        const bXid = await xidOf(b.client);
        // Before its commit it holds none of them: the teacher edits T's
        // matematik (its event and activity the deactivation moves) and
        // 7A's svenska (its activity the new name moves, its event the
        // membership) without waiting.
        await a.client.query('BEGIN');
        await a.client.query(asAdmin, [adminAuth]);
        await a.client.query(`SET LOCAL lock_timeout = '500ms'`);
        await edit(a.client, maths);
        await edit(a.client, first);
        await a.client.query('ROLLBACK');
        // At its commit: the teacher holds the last svenska event, the commit
        // backs off, and the teacher edits the matematik at once.
        await a.client.query('BEGIN');
        await a.client.query(asAdmin, [adminAuth]);
        await a.client.query(`SET LOCAL lock_timeout = '2s'`);
        await edit(a.client, last);
        const committed = settle(b.client.query('COMMIT'));
        await until(b.pid, 'the commit’s flush backing off', (row) => inCommit(row) && row.event === 'PgSleep');
        await edit(a.client, maths);
        assert.equal(await within(committed, 0), 'pending', 'the commit went through while the teacher held its last event');
        await a.client.query('COMMIT');
        const outcome = await within(committed, 15_000);
        assert.notEqual(outcome, 'pending', 'the commit never went through after the teacher’s');
        assert.equal((outcome as Settled).error, null, `the commit failed: ${(outcome as Settled).error?.message}`);
        const all = [...lessons, maths].sort();
        assert.deepEqual(await xidsOf('CalendarEvent', all), all.map(() => bXid), 'not every event carries the transaction');
        assert.deepEqual(await xidsOf('Activity', all), all.map(() => bXid), 'not every activity carries the transaction');
      } finally {
        await a.client.query('ROLLBACK').catch(() => undefined);
        await b.client.query('ROLLBACK').catch(() => undefined);
        await owner.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ANY ($1::int[])', [[a.pid, b.pid]]);
        await a.client.end().catch(() => undefined);
        await b.client.end().catch(() => undefined);
      }
      await pendingIsEmpty('el-g');
    });

    await check('el-h a deadlock at the commit reaches withRls as the adapter’s error: the API’s 409 WRITE_CONFLICT, and 40P01 to the sync', async () => {
      // The teacher is the owner here: only a superuser may set
      // deadlock_timeout. With 5 s against the commit's 1 s, the commit,
      // which began waiting first, always finds the deadlock first; under
      // load the teacher's check could otherwise run first and make it the
      // victim (review R5-L3). The edit runs the same triggers either way.
      const a = await ownerClient();
      let pid = 0;
      try {
        await a.client.query('BEGIN');
        await a.client.query(`SET LOCAL deadlock_timeout = '5s'`);
        await a.client.query(`SET LOCAL lock_timeout = '10s'`);
        await edit(a.client, last);
        const saved = api
          .withRls(admin, async (tx) => {
            pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
            // Past a patience of 0 the flush waits as a writer at once.
            await tx.$executeRaw`SELECT set_config('app.ss12000_replaced_patience', '0', true)`;
            await tx.$executeRaw`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES (${s}::uuid, ${sva}::uuid, ${pupils[5]}::uuid)`;
          })
          .then(
            () => null,
            (error: unknown) => error,
          );
        for (let tries = 0; pid === 0; tries++) {
          if (tries > 1000) throw new Error('the save never began');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        // The commit holds the first three events and waits on the last ...
        await until(pid, 'the commit waiting on the teacher', (row) => row.state === 'active' && row.type === 'Lock');
        // ... and the teacher reaches for the first: a deadlock, which the
        // commit, waiting longer, finds first.
        await edit(a.client, first);
        await a.client.query('COMMIT');
        const error = await saved;
        assert.ok(error, 'the save committed through a deadlock');
        assert.equal(isWriteConflict(error), true, `not a write conflict: ${String((error as Error).message)}`);
        assert.equal(sqlStateOf(error), '40P01');
        assert.throws(
          () => rethrowPrismaError(error),
          (thrown: unknown) => thrown instanceof ConflictException && (thrown.getResponse() as { code?: string }).code === WRITE_CONFLICT,
        );
        assert.equal(await member(pupils[5]!), false, 'the failed commit kept the membership');
      } finally {
        await a.client.query('ROLLBACK').catch(() => undefined);
        if (pid) await owner.query('SELECT pg_cancel_backend($1)', [pid]);
        await owner.query('SELECT pg_terminate_backend($1)', [a.pid]);
        await a.client.end().catch(() => undefined);
      }
      await pendingIsEmpty('el-h');
    });

    await check('el-i under a publication of every table’s deletes a membership still commits (the pending table is in none)', async () => {
      const publication = `elevlistan_${randomUUID().replace(/-/g, '')}`;
      await owner.query(`CREATE PUBLICATION ${publication} FOR ALL TABLES`);
      const b = await appClient();
      try {
        await b.client.query('BEGIN');
        await b.client.query(asAdmin, [adminAuth]);
        await join(b.client, pupils[7]!);
        const bXid = await xidOf(b.client);
        const outcome = await settle(b.client.query('COMMIT'));
        assert.equal(outcome.error, null, `the commit failed: ${outcome.error?.message}`);
        assert.deepEqual(await xidsOf('CalendarEvent', lessons), lessons.map(() => bXid), 'not every event carries the membership’s transaction');
      } finally {
        await b.client.query('ROLLBACK').catch(() => undefined);
        await b.client.end().catch(() => undefined);
        await owner.query(`DROP PUBLICATION IF EXISTS ${publication}`);
      }
      await pendingIsEmpty('el-i');
    });

    await check('el-j a pupil removed whose class is added to a lesson of last läsår, where a group of theirs replaces it, moves that lesson', async () => {
      const b = await appClient();
      try {
        await b.client.query('BEGIN');
        await b.client.query(asAdmin, [adminAuth]);
        assert.equal((await b.client.query(`DELETE FROM "Users" WHERE id = $1`, [pupils[6]])).rowCount, 1, 'the administrator could not remove P7');
        const bXid = await xidOf(b.client);
        await b.client.query('COMMIT');
        assert.deepEqual(await xidsOf('CalendarEvent', [svenska6]), [bXid], 'last läsår’s svenska, where P7 was off, did not move');
      } finally {
        await b.client.query('ROLLBACK').catch(() => undefined);
        await b.client.end().catch(() => undefined);
      }
      await pendingIsEmpty('el-j');
    });

    await check('el-k a teacher reactivated moves their events and activities at the commit', async () => {
      // T as el-g's commit left it, deactivated, whatever el-g came to, and
      // a master of 7A's matematik T teaches (the school publishes directly).
      await owner.query(`UPDATE "Users" SET "isActive" = false WHERE id = $1 AND "isActive"`, [teacher]);
      const taught = (
        await one<{ id: string }>(
          `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 3, '13:00', '14:00', now()) RETURNING id`,
          [s, year, ma, k7a, teacher],
        )
      ).id;
      const b = await appClient();
      try {
        await b.client.query('BEGIN');
        await b.client.query(asAdmin, [adminAuth]);
        assert.equal((await b.client.query(`UPDATE "Users" SET "isActive" = true WHERE id = $1`, [teacher])).rowCount, 1, 'the administrator could not reactivate T');
        const bXid = await xidOf(b.client);
        await b.client.query('COMMIT');
        assert.deepEqual(await xidsOf('CalendarEvent', [maths]), [bXid], 'T’s matematik event did not move');
        assert.deepEqual(await xidsOf('Activity', [maths]), [bXid], 'T’s matematik activity did not move');
        assert.deepEqual(await xidsOf('Activity', [taught]), [bXid], 'the activity of the master T teaches did not move');
      } finally {
        await b.client.query('ROLLBACK').catch(() => undefined);
        await b.client.end().catch(() => undefined);
      }
      await pendingIsEmpty('el-k');
    });

    await check('el-l in a school that publishes drafts a group renamed moves its published activity, not one only the draft has', async () => {
      const k8a = (
        await one<{ id: string }>(
          `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES ($1, $2, 'El 8A', 8, now()) RETURNING id`,
          [s, year],
        )
      ).id;
      const master = async (day: number) =>
        (
          await one<{ id: string }>(
            `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, '09:00', '10:00', now()) RETURNING id`,
            [s, year, ma, k8a, day],
          )
        ).id;
      const published = await master(1);
      const draftOnly = await master(2);
      await owner.query(`INSERT INTO "PublicationSettings" ("schoolId", "publishMode") VALUES ($1, 'DRAFT')`, [s]);
      const publication = (
        await one<{ id: string }>(
          `INSERT INTO "TimetablePublications" ("schoolId", "academicYearId", kind, outcome, "publishMode", "validFrom", "validTo", "publishedByUserId")
           VALUES ($1, $2, 'PUBLISH', 'PUBLISHED', 'DRAFT', current_date - 30, current_date + 300, $3) RETURNING id`,
          [s, year, adminId],
        )
      ).id;
      await owner.query(
        `INSERT INTO "PublishedLessons" ("schoolId", "publicationId", "academicYearId", "masterLessonId", "subjectId", "studentGroupId",
                                         "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "isParked", recurrence)
         VALUES ($1, $2, $3, $4, $5, $6, 1, '09:00', '10:00', false, false, false, 'ALL_WEEKS')`,
        [s, publication, year, published, ma, k8a],
      );
      const b = await appClient();
      try {
        await b.client.query('BEGIN');
        await b.client.query(asAdmin, [adminAuth]);
        assert.equal((await b.client.query(`UPDATE "StudentGroups" SET name = 'El 8A omdöpt' WHERE id = $1`, [k8a])).rowCount, 1, 'the administrator could not rename 8A');
        const bXid = await xidOf(b.client);
        await b.client.query('COMMIT');
        assert.deepEqual(await xidsOf('Activity', [published]), [bXid], 'the published master’s activity did not move');
        assert.equal((await xidsOf('Activity', [draftOnly])).includes(bXid), false, 'the activity of a master only the draft has moved');
      } finally {
        await b.client.query('ROLLBACK').catch(() => undefined);
        await b.client.end().catch(() => undefined);
      }
      await pendingIsEmpty('el-l');
    });

    await check('el-m a pupil named on a lesson, relinked, moves that lesson at the commit', async () => {
      // Matematik: no group replaces it, so only the naming moves it.
      await owner.query(`INSERT INTO "CalendarLessonStudents" ("schoolId", "calendarLessonId", "studentId") VALUES ($1, $2, $3)`, [s, maths, pupils[1]]);
      const b = await appClient();
      try {
        await b.client.query('BEGIN');
        await b.client.query(asAdmin, [adminAuth]);
        assert.equal((await b.client.query(`UPDATE "Users" SET "ss12000Id" = $2 WHERE id = $1`, [pupils[1], randomUUID()])).rowCount, 1, 'the administrator could not relink P2');
        const bXid = await xidOf(b.client);
        await b.client.query('COMMIT');
        assert.deepEqual(await xidsOf('CalendarEvent', [maths]), [bXid], 'the matematik naming P2 did not move');
      } finally {
        await b.client.query('ROLLBACK').catch(() => undefined);
        await b.client.end().catch(() => undefined);
      }
      await pendingIsEmpty('el-m');
    });

    await check('el-n a transaction older than its patience still backs off at its commit: the patience runs from the flush', async () => {
      // P6 is out of SvA7 (el-h's failed commit left it so); made sure here.
      await owner.query(`DELETE FROM "StudentGroupMembers" WHERE "studentGroupId" = $1 AND "studentId" = $2`, [sva, pupils[5]]);
      const b = await appClient();
      const a = await appClient();
      try {
        await b.client.query('BEGIN');
        await b.client.query(asAdmin, [adminAuth]);
        await b.client.query(`SELECT set_config('app.ss12000_replaced_patience', '1', true)`);
        await join(b.client, pupils[5]!);
        const bXid = await xidOf(b.client);
        await a.client.query('BEGIN');
        await a.client.query(asAdmin, [adminAuth]);
        await a.client.query(`SET LOCAL lock_timeout = '2s'`);
        await edit(a.client, last);
        // The membership's transaction grows older than its patience ...
        for (let tries = 0; ; tries++) {
          const { old } = await one<{ old: boolean }>(
            `SELECT clock_timestamp() - xact_start > interval '1.2 seconds' AS old FROM pg_stat_activity WHERE pid = $1`,
            [b.pid],
          );
          if (old) break;
          if (tries > 1000) throw new Error('the membership’s transaction never grew older than its patience');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        // ... and its commit still backs off from the last event, holding
        // none, so the teacher edits the first at once. A deadline counted
        // from the transaction's start (now()) would be spent already: the
        // flush would wait as a writer at once, holding the first three.
        const committed = settle(b.client.query('COMMIT'));
        await until(b.pid, 'the commit’s flush backing off', (row) => inCommit(row) && row.event === 'PgSleep');
        await edit(a.client, first);
        assert.equal(await within(committed, 0), 'pending', 'the commit went through while the teacher held its last event');
        await a.client.query('COMMIT');
        const outcome = await within(committed, 15_000);
        assert.notEqual(outcome, 'pending', 'the commit never went through after the teacher’s');
        assert.equal((outcome as Settled).error, null, `the commit failed: ${(outcome as Settled).error?.message}`);
        assert.deepEqual(await xidsOf('CalendarEvent', lessons), lessons.map(() => bXid), 'not every event carries the membership’s transaction');
      } finally {
        await a.client.query('ROLLBACK').catch(() => undefined);
        await b.client.query('ROLLBACK').catch(() => undefined);
        await owner.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ANY ($1::int[])', [[a.pid, b.pid]]);
        await a.client.end().catch(() => undefined);
        await b.client.end().catch(() => undefined);
      }
      await pendingIsEmpty('el-n');
    });
  } finally {
    await sweepElevlistanSchool(owner, marker);
  }
}
