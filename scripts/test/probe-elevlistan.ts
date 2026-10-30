/**
 * The adapter probe's checks for Elevlistan i uppföljningen
 * (20261215090000): what the events a membership moves do to other writers,
 * which only two real connections show. In a school of its own (slug
 * <marker>-elevlistan), swept whole before and after: 7A with six pupils,
 * SvA7 replacing svenska, and four svenska lessons of 7A. Pupil P_n going into
 * SvA7 moves all four events, at the transaction's commit. For el-e also last
 * läsår, EnS7 replacing engelska with P6 in it, and an engelska lesson of a
 * this-year group without pupils with 7A added. Both writers are
 * the API's role with the administrator as principal; the teacher's writer
 * edits a lesson, which moves its event at the statement, as on main.
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
 *         fails its commit with 40001 at once, as its statement did on main;
 *   el-e  a group without pupils (no enrollment holds it to its läsår) moved
 *         from this läsår to last moves its lesson that 7A is added to, in
 *         engelska, which only this läsår replaces (EnS7): P6 is on it again.
 *         The old läsår is what finds it (review of #226, R2-L1);
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
import { Client } from 'pg';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function elevlistanSlug(marker: string): string {
  return `${marker}-elevlistan`;
}

export async function sweepElevlistanSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [elevlistanSlug(marker)]);
}

/** A connection as the API's role (DATABASE_URL), the way the RLS suite writes as it. */
async function appClient(): Promise<{ client: Client; pid: number }> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');
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

export async function elevlistanChecks(owner: Client, marker: string, check: Check): Promise<void> {
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
    await owner.query(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
       VALUES ($1, $2, 'El', 'Admin', 'SCHOOL_ADMIN', 'FULL', $3, true, now())`,
      [s, `${marker}-elevlistan-admin@example.invalid`, adminAuth],
    );
    const pupils: string[] = [];
    for (let n = 1; n <= 6; n++) {
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

    await check('el-e a group without pupils moved to last läsår moves its lesson in a subject only this läsår replaces', async () => {
      const b = await appClient();
      try {
        await b.client.query('BEGIN');
        await b.client.query(asAdmin, [adminAuth]);
        const moved = await b.client.query(`UPDATE "StudentGroups" SET "academicYearId" = $2 WHERE id = $1`, [empty, lastYear]);
        assert.equal(moved.rowCount, 1, 'the administrator could not move the group');
        const bXid = await xidOf(b.client);
        await b.client.query('COMMIT');
        const { rows } = await owner.query<{ xid: string }>(
          `SELECT xid::text AS xid FROM "Ss12000EntityVersions" WHERE resource = 'CalendarEvent' AND "entityId" = $1`,
          [english],
        );
        assert.equal(rows[0]?.xid, bXid, 'the engelska lesson, where P6 is on again, did not move');
      } finally {
        await b.client.query('ROLLBACK').catch(() => undefined);
        await b.client.end().catch(() => undefined);
      }
      await pendingIsEmpty('el-e');
    });
  } finally {
    await sweepElevlistanSchool(owner, marker);
  }
}
