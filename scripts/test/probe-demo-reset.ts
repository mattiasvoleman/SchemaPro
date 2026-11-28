/**
 * Demoskolans återställning against a real database (P1 Pilotkit, part 3): a reset deletes a school, and this is what shows that it
 * can never delete one that is not the demo school.
 *
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-demo-reset.ts
 *
 * The jest spec (src/demo-school/demo-guard.spec.ts) holds the judgement with no database. This holds what a database adds: the
 * school's row locked while it is judged, a delete that cascades through hundreds of foreign keys, and a rollback that is one.
 *
 * It never touches the demo school (`demo-skola`): by the time it runs in CI the RLS fixtures and the adapter probe have put rows of
 * their own there. Every school it resets is made here, from a spec of its own (a slug, a name and a domain with the run's tag in
 * them), by the same function the seed uses, so what it resets is the demo school's shape and the judgement it meets is the demo's
 * judgement, applied to another name.
 *
 *   (1) A REAL SCHOOL IS UNTOUCHED: a school of the demo's shape with a real person in it, and other schools, beside a demo school
 *       that is reset. Every row of every table that has a schoolId, counted and hashed for each of them, is the same after;
 *   (2) the school with the demo's name and a real person is REFUSED, and nothing is deleted: every row of it, counted and hashed, is
 *       the same, and so is its id. The same for a person who is deactivated, for one with a look-alike address, and for a school with
 *       no people at all;
 *   (3) a school a huvudman is tied to, and one tied to another school (a travel time, a room on loan, a shared teacher) are
 *       REFUSED, because a delete cascades to the other end: the other school's rows are the same after;
 *   (4) a person added AT THE SAME TIME: one who commits first is seen and the reset refuses; one who is added after the school is
 *       judged waits on its lock, and finds the school gone: the person is never deleted and the insert fails, loudly;
 *   (5) a failure after the delete rolls everything back: the school is the one it was, id and all;
 *   (6) LOGINS: one only the demo held is written back, on the same address; one another school also holds is not, and that school's
 *       row is untouched; a Supabase user is never a row here at all;
 *   (7) a dry run writes nothing and says what it would do, and a school that is not there is made;
 *   (8) the rows the read log leaves (PersonalDataAccess: append-only, no foreign key to the school) do not stop a reset;
 *   (9) A DATABASE WITH A REAL SCHOOL: where the demo school is not there, it is not made, by `db:seed` or by `--reset` or in a dry run, and
 *       nothing is created; where it is there it is reset as before and the real school beside it is untouched. A school with nobody in
 *       it, and one whose people are all at the names reserved for examples, or all pseudonymised (`pseudonym.invalid`), are not a real school;
 *  (10) THE HÖGSTADIUM SEED'S RESET (prisma/seed-hogstadium.ts, the review of #405, L-5) deletes the school with its slug only when every
 *       person in it is at the seed's own domain: a school with a person at a real address is refused and is the same row for row, a school
 *       of the right people under another name is refused, and a school that is not there is not an error;
 *  (11) `db:seed` without --reset says "Use --reset" only of a school that --reset would reset (L-7): of a school that is not the demo
 *       school it says NOT RESET, with the reason, and writes nothing;
 *  (12) THE COMMAND ITSELF: `prisma/seed-hogstadium.ts --reset` run as the operator runs it, not its functions. What (10) holds is the
 *       judgement; what an operator meets is the script that calls it: a school with a person at a real address is refused, the exit code
 *       is 1 and the school is the same row for row, and a school of the seed's own people is deleted and made again.
 *
 * It needs a database with no school that has a person at a real address when it starts (the CI database holds made-up schools only: the
 * seed's, the RLS fixtures' and the probes'), because (7) makes a demo school where there is none, which is what (9) shows a real school
 * stops. It drops a school with a real address as soon as the check that made it is done.
 *
 * It drops every school it made.
 */
import { spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { createPgAdapter } from '../../src/database/pool-config';
import { type DemoSpec } from '../../src/demo-school/demo-guard';
import { resetDemoSchool, describeResult, describeExistingDemoSchool, deleteSeedSchool, judgeSeedDatabase } from '../../prisma/demo-reset';
import { createDemoSchool } from '../../prisma/demo-school';
import { spawnSync as spawnTheSeed } from 'node:child_process';
import { join as joinPath } from 'node:path';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

let failures = 0;
async function check(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}\n     ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const tag = randomUUID().slice(0, 8);
const specOf = (key: string): DemoSpec => ({ slug: `probe-demo-${key}-${tag}`, name: `Probe demo ${key} ${tag}`, domain: `probe-demo-${key}-${tag}.example.com` });

const created: string[] = [];
let owner: PrismaClient;

/** A school of the demo's shape, from a spec, as the seed makes it. */
async function demoSchool(key: string): Promise<{ spec: DemoSpec; schoolId: string }> {
  const spec = specOf(key);
  const summary = await owner.$transaction((tx) => createDemoSchool(tx, spec), { timeout: 120_000 });
  created.push(summary.schoolId);
  return { spec, schoolId: summary.schoolId };
}

/** Every table with a schoolId column, once. */
let tables: string[] = [];

/** Every row of a school in every table that has a schoolId, counted and hashed: what "untouched" means. */
async function snapshot(schoolId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of tables) {
    const rows = await owner.$queryRawUnsafe<{ n: bigint; h: string }[]>(
      `SELECT count(*) AS n, md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) AS h FROM "${table}" t WHERE "schoolId" = $1::uuid`,
      schoolId,
    );
    if (Number(rows[0]!.n) > 0) out[table] = `${rows[0]!.n}:${rows[0]!.h}`;
  }
  return out;
}

const person = (schoolId: string, email: string, extra: Record<string, unknown> = {}) =>
  owner.user.create({ data: { schoolId, authId: randomUUID(), role: 'TEACHER', firstName: 'Real', lastName: 'Person', email, ...extra } });

const exists = async (schoolId: string) => (await owner.school.count({ where: { id: schoolId } })) === 1;

/** Schools a check made with a real address, to drop the moment it is done. */
const cleanupNow: string[] = [];
async function dropNow(): Promise<void> {
  for (const id of cleanupNow.splice(0)) await owner.school.delete({ where: { id } }).catch(() => undefined);
}

async function main(): Promise<void> {
  owner = new PrismaClient({ adapter: createPgAdapter(requiredEnv('PROBE_OWNER_URL')) });
  tables = (
    await owner.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'schoolId' AND table_name <> 'Schools' ORDER BY 1`,
    )
  ).map((row) => row.table_name);
  assert.ok(tables.length > 100, 'the tables that hold a school\'s rows');

  try {
    // (1) a real school is untouched
    await check('(1) a reset of the demo school leaves every row of a real school as it was, and replaces the demo school', async () => {
      const demo = await demoSchool('d1');
      const real = await demoSchool('r1');
      await owner.user.updateMany({ where: { schoolId: real.schoolId, role: 'SCHOOL_ADMIN' }, data: { email: `rektor-${tag}@riktig-skola.example.org` } });
      const other = await demoSchool('o1');
      const [before, beforeOther, demoBefore] = await Promise.all([snapshot(real.schoolId), snapshot(other.schoolId), snapshot(demo.schoolId)]);
      assert.ok(Object.keys(before).length > 8, 'the real school has rows in several tables');

      const result = await resetDemoSchool(owner, { spec: demo.spec });
      assert.equal(result.kind, 'RESET');
      if (result.kind !== 'RESET') return;
      created.push(result.schoolId);

      assert.deepEqual(await snapshot(real.schoolId), before, 'the real school, row for row');
      assert.deepEqual(await snapshot(other.schoolId), beforeOther, 'another demo-shaped school with another slug, row for row');
      assert.equal(await exists(demo.schoolId), false, 'the old demo school is gone');
      assert.ok(await exists(result.schoolId), 'and a new one is there');
      const rows = (s: Record<string, string>) => Object.fromEntries(Object.entries(s).map(([table, value]) => [table, value.split(':')[0]]));
      // Same shape, new rows: the same number in every table, none of the same rows.
      assert.deepEqual(rows(await snapshot(result.schoolId)), rows(demoBefore));
      assert.equal(await owner.school.count({ where: { slug: demo.spec.slug } }), 1);
    });

    // (2) the demo's name and a real person
    for (const [label, key, make] of [
      ['a real person', 'p1', (schoolId: string, spec: DemoSpec) => person(schoolId, `rektor-${tag}@kommun.example.org`)],
      ['a deactivated real person', 'p2', (schoolId: string) => person(schoolId, `slutad-${tag}@kommun.example.org`, { isActive: false })],
      ['a look-alike address', 'p3', (schoolId: string, spec: DemoSpec) => person(schoolId, `x@evil.${spec.domain}`)],
      ['the domain as the start of another', 'p4', (schoolId: string, spec: DemoSpec) => person(schoolId, `x@${spec.domain}.evil.org`)],
      ['a pupil on a real address', 'p5', (schoolId: string) => person(schoolId, `elev-${tag}@gmail.com`, { role: 'STUDENT' })],
      ['a person on a school domain', 'p6', (schoolId: string) => person(schoolId, `rektor-${tag}@skola.stockholm.se`)],
    ] as const) {
      await check(`(2) the school with the demo's name and ${label} is refused, and nothing is deleted`, async () => {
        const { spec, schoolId } = await demoSchool(key);
        // A real address is dropped with its school as soon as the check is done: while it is there the database holds a real school, which
        // is (7)'s and (9)'s to settle, not (2)'s.
        cleanupNow.push(schoolId);
        await make(schoolId, spec);
        const before = await snapshot(schoolId);
        const result = await resetDemoSchool(owner, { spec });
        assert.equal(result.kind, 'REFUSED');
        if (result.kind === 'REFUSED') assert.deepEqual(result.refusal, { code: 'PEOPLE_OUTSIDE_THE_DEMO', count: 1 });
        assert.deepEqual(await snapshot(schoolId), before, 'every row, as it was');
        assert.ok(await exists(schoolId), 'the same school');
        // The domain the demo's people have is the spec's, said once; no person's address is.
        assert.doesNotMatch(describeResult(result, spec).replaceAll(`@${spec.domain}`, ''), /@|kommun|gmail|evil/, 'the refusal names no address');
      }).finally(dropNow);
    }

    await check('(2) a school with no people is refused: nobody in it proves nothing', async () => {
      const spec = specOf('empty');
      const school = await owner.school.create({ data: { name: spec.name, slug: spec.slug, timezone: 'Europe/Stockholm' } });
      created.push(school.id);
      const result = await resetDemoSchool(owner, { spec });
      assert.deepEqual(result.kind === 'REFUSED' ? result.refusal : null, { code: 'NO_PEOPLE' });
      assert.ok(await exists(school.id));
    });

    await check('(2) a school with the right slug and another name is refused, however its people are written', async () => {
      const { spec, schoolId } = await demoSchool('n1');
      await owner.school.update({ where: { id: schoolId }, data: { name: 'Riktiga skolan' } });
      const result = await resetDemoSchool(owner, { spec });
      assert.deepEqual(result.kind === 'REFUSED' ? result.refusal : null, { code: 'NOT_THE_DEMO_SCHOOL' });
      assert.ok(await exists(schoolId));
    });

    // (3) tied to a huvudman or another school
    await check('(3) a school a huvudman has asked for is refused, and the huvudman\'s rows are as they were', async () => {
      const { spec, schoolId } = await demoSchool('h1');
      const huvudman = await owner.huvudman.create({ data: { name: `Probe huvudman ${tag}` } });
      await owner.$executeRaw(Prisma.sql`INSERT INTO "HuvudmanSchoolRequests" ("huvudmanId", "schoolId") VALUES (${huvudman.id}::uuid, ${schoolId}::uuid)`);
      try {
        const before = await snapshot(schoolId);
        const result = await resetDemoSchool(owner, { spec });
        assert.deepEqual(result.kind === 'REFUSED' ? result.refusal : null, { code: 'TIED_TO_A_HUVUDMAN', count: 1 });
        assert.deepEqual(await snapshot(schoolId), before);
        assert.equal(await owner.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM "HuvudmanSchoolRequests" WHERE "schoolId" = ${schoolId}::uuid`).then((rows) => Number(rows[0]!.n)), 1);
      } finally {
        await owner.huvudman.delete({ where: { id: huvudman.id } });
      }
    });

    // The guard counts three tables for a huvudman, and the check above reaches one of them. A school a huvudman OWNS is the case the refusal exists for
    // (the delete would take a kommun's school with it), and a school with an event in a huvudman's history has only that row to say so: a count that
    // leaves either table out refused nothing until these.
    for (const [label, key, table, tie] of [
      [
        'owns',
        'h2',
        'HuvudmanSchools',
        (huvudmanId: string, schoolId: string) => owner.$executeRaw(Prisma.sql`INSERT INTO "HuvudmanSchools" ("huvudmanId", "schoolId") VALUES (${huvudmanId}::uuid, ${schoolId}::uuid)`),
      ],
      [
        'has an event in its history for',
        'h3',
        'HuvudmanSchoolEvents',
        (huvudmanId: string, schoolId: string) => owner.$executeRaw(Prisma.sql`INSERT INTO "HuvudmanSchoolEvents" ("huvudmanId", "schoolId", "kind") VALUES (${huvudmanId}::uuid, ${schoolId}::uuid, 'LEFT')`),
      ],
    ] as const) {
      await check(`(3) a school a huvudman ${label} is refused, and the huvudman's rows are as they were`, async () => {
        const { spec, schoolId } = await demoSchool(key);
        const huvudman = await owner.huvudman.create({ data: { name: `Probe huvudman ${key} ${tag}` } });
        try {
          await tie(huvudman.id, schoolId);
          const before = await snapshot(schoolId);
          const result = await resetDemoSchool(owner, { spec });
          assert.deepEqual(result.kind === 'REFUSED' ? result.refusal : null, { code: 'TIED_TO_A_HUVUDMAN', count: 1 });
          assert.deepEqual(await snapshot(schoolId), before);
          assert.ok(await exists(schoolId), 'the same school');
          const rows = await owner.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM ${Prisma.raw(`"${table}"`)} WHERE "schoolId" = ${schoolId}::uuid`);
          assert.equal(Number(rows[0]!.n), 1, 'the huvudman\'s row is still there');
        } finally {
          // A huvudman that owns a school cannot be deleted: the ownership goes first.
          await owner.$executeRaw(Prisma.sql`DELETE FROM "HuvudmanSchools" WHERE "huvudmanId" = ${huvudman.id}::uuid`);
          await owner.huvudman.delete({ where: { id: huvudman.id } });
        }
      });
    }

    await check('(3) a school with a travel time to another school is refused from either end, and neither school is touched', async () => {
      const first = await demoSchool('t1');
      const second = await demoSchool('t2');
      // The pair is stored with the lesser id first (a check on the table), so one of the two schools is the pair's A and the other its B.
      const [a, b] = first.schoolId < second.schoolId ? [first.schoolId, second.schoolId] : [second.schoolId, first.schoolId];
      await owner.$executeRaw(Prisma.sql`INSERT INTO "SchoolTravelTimes" ("schoolAId", "schoolBId", "minutes", "setBySchoolId") VALUES (${a}::uuid, ${b}::uuid, 10, ${a}::uuid)`);
      const before = [await snapshot(first.schoolId), await snapshot(second.schoolId)];
      for (const demo of [first, second]) {
        const result = await resetDemoSchool(owner, { spec: demo.spec });
        assert.deepEqual(result.kind === 'REFUSED' ? result.refusal : null, { code: 'TIED_TO_ANOTHER_SCHOOL', count: 1 });
      }
      assert.deepEqual([await snapshot(first.schoolId), await snapshot(second.schoolId)], before);
      assert.equal(await owner.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM "SchoolTravelTimes" WHERE "schoolAId" = ${a}::uuid`).then((rows) => Number(rows[0]!.n)), 1);
    });

    for (const [label, key, tie] of [
      [
        'a room lent to it',
        'a',
        (lender: string, borrower: string, roomId: string) =>
          owner.$executeRaw(
            Prisma.sql`INSERT INTO "RoomLoans" ("ownerSchoolId", "roomId", "borrowerSchoolId", "localRoomName", "dayOfWeek", "startTime", "endTime", "startDate", "endDate")
                       VALUES (${lender}::uuid, ${roomId}::uuid, ${borrower}::uuid, 'Lånad sal', 1, '08:00', '09:00', '2026-09-01', '2026-12-18')`,
          ),
      ],
      [
        'a teacher shared with it',
        'b',
        (lender: string, borrower: string, _room: string, teacherId: string) =>
          owner.$executeRaw(Prisma.sql`INSERT INTO "SharedTeacherMarks" ("schoolId", "teacherId", "withSchoolId") VALUES (${lender}::uuid, ${teacherId}::uuid, ${borrower}::uuid)`),
      ],
    ] as const) {
      await check(`(3) a school with ${label} is refused from either end, and neither school is touched`, async () => {
        const lender = await demoSchool(`t3${key}`);
        const borrower = await demoSchool(`t4${key}`);
        const room = await owner.room.findFirstOrThrow({ where: { schoolId: lender.schoolId } });
        const teacher = await owner.user.findFirstOrThrow({ where: { schoolId: lender.schoolId, role: 'TEACHER' }, orderBy: { email: 'asc' } });
        await tie(lender.schoolId, borrower.schoolId, room.id, teacher.id);
        const before = [await snapshot(lender.schoolId), await snapshot(borrower.schoolId)];
        for (const demo of [lender, borrower]) {
          const result = await resetDemoSchool(owner, { spec: demo.spec });
          assert.deepEqual(result.kind === 'REFUSED' ? result.refusal : null, { code: 'TIED_TO_ANOTHER_SCHOOL', count: 1 });
        }
        assert.deepEqual([await snapshot(lender.schoolId), await snapshot(borrower.schoolId)], before);
      });
    }

    // (4) a person added at the same time
    await check('(4) a person who commits first is seen: the reset waits for the lock, reads the person and refuses', async () => {
      const { spec, schoolId } = await demoSchool('c1');
      const before = await snapshot(schoolId);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let inserted!: () => void;
      const insertedRow = new Promise<void>((resolve) => {
        inserted = resolve;
      });
      // The person is inserted in a transaction that stays open: it holds a share lock on the school's row.
      const adding = owner.$transaction(async (tx) => {
        await tx.user.create({ data: { schoolId, authId: randomUUID(), role: 'TEACHER', firstName: 'Real', lastName: 'Person', email: `rektor-${tag}@kommun.example.org` } });
        inserted();
        await held;
      });
      await insertedRow;
      const resetting = resetDemoSchool(owner, { spec });
      let settled = false;
      void resetting.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(settled, false, 'the reset waits for the person\'s transaction: it cannot lock the school\'s row');
      release();
      await adding;
      const result = await resetting;
      assert.deepEqual(result.kind === 'REFUSED' ? result.refusal : null, { code: 'PEOPLE_OUTSIDE_THE_DEMO', count: 1 });
      assert.ok(await exists(schoolId));
      // The person, and the version a trigger writes of a new person (Ss12000EntityVersions), are what the school gained; nothing else changed.
      const without = (s: Record<string, string>) => Object.fromEntries(Object.entries(s).filter(([table]) => table !== 'Users' && table !== 'Ss12000EntityVersions'));
      assert.deepEqual(without(await snapshot(schoolId)), without(before), 'everything but the person is as it was');
    });

    await check('(4) a person added after the school is judged waits for the lock, finds the school gone and fails: never deleted', async () => {
      const { spec, schoolId } = await demoSchool('c2');
      let insert: Promise<unknown> | null = null;
      let finishedEarly = false;
      const result = await resetDemoSchool(owner, {
        spec,
        afterJudged: async () => {
          // Another connection adds a real person to the school, now that the reset has judged it and before it deletes it.
          insert = owner
            .$executeRaw(
              Prisma.sql`INSERT INTO "Users" ("schoolId", "authId", "role", "firstName", "lastName", "email", "updatedAt") VALUES (${schoolId}::uuid, ${randomUUID()}::uuid, 'TEACHER', 'Real', 'Person', ${`late-${tag}@kommun.example.org`}, now())`,
            )
            .then(
              (value) => {
                finishedEarly = true;
                return value;
              },
              (error: unknown) => error,
            );
          await new Promise((resolve) => setTimeout(resolve, 600));
          assert.equal(finishedEarly, false, 'the insert waits: the school\'s row is locked by the reset');
        },
      });
      assert.equal(result.kind, 'RESET');
      if (result.kind === 'RESET') created.push(result.schoolId);
      const outcome = await insert!;
      assert.ok(outcome instanceof Error || (outcome as { code?: string }).code !== undefined, 'the insert failed, loudly');
      assert.equal(await owner.user.count({ where: { email: `late-${tag}@kommun.example.org` } }), 0, 'and no such person exists');
      const school = await owner.school.findUniqueOrThrow({ where: { slug: spec.slug } });
      const emails = (await owner.user.findMany({ where: { schoolId: school.id }, select: { email: true } })).map((row) => row.email);
      assert.ok(emails.length > 50 && emails.every((email) => email !== null && email.endsWith(`@${spec.domain}`)), 'the school is the demo school, made again');
    });

    await check('(4) a person who is CHANGED to a real address after the school is judged waits for the reset: nobody turns real unseen', async () => {
      const { spec, schoolId } = await demoSchool('c3');
      // A real address is dropped with its school as soon as the check is done, as in (2): the database must not hold one for (7) and (9).
      cleanupNow.push(schoolId);
      let update: Promise<unknown> | null = null;
      let finishedEarly = false;
      const result = await resetDemoSchool(owner, {
        spec,
        afterJudged: async () => {
          // Another connection sets a demo person's address to a real one, now that the reset has judged the school and before it deletes it.
          update = owner
            .$executeRaw(
              Prisma.sql`UPDATE "Users" SET "email" = ${`turned-${tag}@kommun.se`}, "updatedAt" = now() WHERE "schoolId" = ${schoolId}::uuid AND "role" = 'SCHOOL_ADMIN'`,
            )
            .then(
              (value) => {
                finishedEarly = true;
                return value;
              },
              (error: unknown) => error,
            );
          await new Promise((resolve) => setTimeout(resolve, 600));
          assert.equal(finishedEarly, false, 'the update waits: the people the reset judged are locked by it');
        },
      });
      assert.equal(result.kind, 'RESET');
      if (result.kind === 'RESET') created.push(result.schoolId);
      // It found nobody: the person went with the school, as the demo's person it was when it was judged, and the address never took.
      assert.equal(await update!, 0, 'the update changed no row');
      assert.equal(await owner.user.count({ where: { email: `turned-${tag}@kommun.se` } }), 0, 'and no such person exists');
    }).finally(dropNow);

    // (5) a failure after the delete
    await check('(5) a failure after the delete rolls everything back: the same school, with the same id and the same rows', async () => {
      const { spec, schoolId } = await demoSchool('f1');
      const before = await snapshot(schoolId);
      await assert.rejects(
        resetDemoSchool(owner, {
          spec,
          afterDeleted: async () => {
            throw new Error('a failure halfway');
          },
        }),
        /a failure halfway/,
      );
      assert.ok(await exists(schoolId));
      assert.deepEqual(await snapshot(schoolId), before);
      assert.equal(await owner.school.count({ where: { slug: spec.slug } }), 1, 'no second school was left behind');
    });

    // (6) logins
    await check('(6) a login only the demo held is written back on the same address; a shared one is not, and the other school is untouched', async () => {
      const { spec, schoolId } = await demoSchool('l1');
      const real = await demoSchool('l2');
      await owner.user.updateMany({ where: { schoolId: real.schoolId, role: 'SCHOOL_ADMIN' }, data: { email: `rektor-${tag}@riktig-skola.example.org` } });
      const adminLogin = randomUUID();
      const sharedLogin = randomUUID();
      const invited = new Date('2026-11-01T08:00:00.000Z');
      const adminRow = await owner.user.findFirstOrThrow({ where: { schoolId, role: 'SCHOOL_ADMIN' } });
      const teacherRow = await owner.user.findFirstOrThrow({ where: { schoolId, role: 'TEACHER' }, orderBy: { email: 'asc' } });
      const strangerRow = await owner.user.findFirstOrThrow({ where: { schoolId: real.schoolId, role: 'TEACHER' }, orderBy: { email: 'asc' } });
      await owner.user.update({ where: { id: adminRow.id }, data: { authId: adminLogin, invitedAt: invited } });
      // A login the real school's person holds too: a row takes a login another row holds only by the gateway's invitation, which says so.
      await owner.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT set_config('app.login_join', ${teacherRow.id}, true)`);
        await tx.user.update({ where: { id: strangerRow.id }, data: { authId: sharedLogin, invitedAt: invited } });
      });
      await owner.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT set_config('app.login_join', ${teacherRow.id}, true)`);
        await tx.user.update({ where: { id: teacherRow.id }, data: { authId: sharedLogin, invitedAt: invited } });
      });
      const strangerBefore = await snapshot(real.schoolId);

      const result = await resetDemoSchool(owner, { spec });
      assert.equal(result.kind, 'RESET');
      if (result.kind !== 'RESET') return;
      created.push(result.schoolId);
      assert.deepEqual(result.logins, { kept: 1, dropped: 1 });

      const adminAfter = await owner.user.findFirstOrThrow({ where: { schoolId: result.schoolId, email: adminRow.email } });
      assert.equal(adminAfter.authId, adminLogin, 'the administrator\'s login is on the new row');
      assert.equal(adminAfter.invitedAt?.toISOString(), invited.toISOString());
      assert.notEqual(adminAfter.id, adminRow.id, 'a new row, not the old one');
      const teacherAfter = await owner.user.findFirstOrThrow({ where: { schoolId: result.schoolId, email: teacherRow.email } });
      assert.notEqual(teacherAfter.authId, sharedLogin, 'a login another school also holds is not written back');
      assert.equal(teacherAfter.invitedAt, null);
      assert.deepEqual(await snapshot(real.schoolId), strangerBefore, 'the other school\'s row, which holds the login, is untouched');
      assert.equal(await owner.user.count({ where: { authId: sharedLogin } }), 1, 'the login is still held, by the one row that held it');
      assert.match(describeResult(result, spec), /Logins kept: 1\. Logins not kept: 1/);
    });

    // (7) a dry run, and a school that is not there
    await check('(7) a dry run writes nothing and says it may; for a school with a real person it refuses; for none it says it may be made', async () => {
      const { spec, schoolId } = await demoSchool('x1');
      const before = await snapshot(schoolId);
      const dry = await resetDemoSchool(owner, { spec, write: false });
      assert.equal(dry.kind, 'MAY_BE_RESET');
      assert.deepEqual(await snapshot(schoolId), before);
      assert.match(describeResult(dry, spec), /Nothing was written/);

      await person(schoolId, `rektor-${tag}@kommun.example.org`);
      const dryRefused = await resetDemoSchool(owner, { spec, write: false });
      assert.equal(dryRefused.kind, 'REFUSED');

      // No school with the slug, and no real school in the database: it may be made, and a dry run makes nothing.
      const none = specOf('none');
      const dryNone = await resetDemoSchool(owner, { spec: none, write: false });
      assert.equal(dryNone.kind, 'MAY_BE_CREATED', 'a database with made-up schools only: the demo school may be made (a real school in it would be (9)\'s)');
      assert.equal(await owner.school.count({ where: { slug: none.slug } }), 0, 'a dry run makes nothing');
      assert.match(describeResult(dryNone, none), /Nothing was written/);
      const made = await resetDemoSchool(owner, { spec: none });
      assert.equal(made.kind, 'CREATED');
      if (made.kind === 'CREATED') created.push(made.schoolId);
    });

    // (8) the read log
    await check('(8) rows in the read log, which no foreign key ties to the school, do not stop a reset', async () => {
      const { spec, schoolId } = await demoSchool('g1');
      const admin = await owner.user.findFirstOrThrow({ where: { schoolId, role: 'SCHOOL_ADMIN' } });
      await owner.$executeRaw(
        Prisma.sql`INSERT INTO "PersonalDataAccess" ("schoolId", "actorId", "actorRole", "channel", "kind", "subjectIds", "readSize") VALUES (${schoolId}::uuid, ${admin.id}::uuid, 'SCHOOL_ADMIN', 'WEB', 'PEOPLE', ARRAY[${admin.id}::uuid], 1)`,
      );
      const result = await resetDemoSchool(owner, { spec });
      assert.equal(result.kind, 'RESET');
      if (result.kind === 'RESET') created.push(result.schoolId);
    });

    // (9) a database with a real school
    await check('(9) where the demo school is not there and the database holds a real school, nothing is made: not by a seed, a reset or a dry run', async () => {
      const spec = specOf('db9');
      const real = await owner.school.create({ data: { name: `Probe riktig skola ${tag}`, slug: `probe-real-db9-${tag}`, timezone: 'Europe/Stockholm' } });
      cleanupNow.push(real.id);
      await person(real.id, `rektor-${tag}@skola.stockholm.se`);
      const before = await snapshot(real.id);
      try {
        for (const write of [true, false]) {
          const result = await resetDemoSchool(owner, { spec, write });
          assert.equal(result.kind, 'REFUSED');
          if (result.kind === 'REFUSED') {
            assert.equal(result.schoolId, null, 'no demo school to name');
            assert.deepEqual(result.refusal, { code: 'DATABASE_HAS_A_REAL_SCHOOL', count: 1 });
          }
          assert.match(describeResult(result, spec), /^NOT SEEDED\. Databasen har 1 skola med personer på riktiga adresser/);
          assert.doesNotMatch(describeResult(result, spec), /@|stockholm|rektor/, 'the refusal names no address');
        }
        assert.equal(await owner.school.count({ where: { slug: spec.slug } }), 0, 'no demo school was made');
        assert.deepEqual(await snapshot(real.id), before, 'the real school is as it was');

        // A demo school that is already there is reset as before, and the real school beside it is untouched.
        const there = await demoSchool('db9b');
        const reset = await resetDemoSchool(owner, { spec: there.spec });
        assert.equal(reset.kind, 'RESET');
        if (reset.kind === 'RESET') created.push(reset.schoolId);
        assert.deepEqual(await snapshot(real.id), before, 'the real school, row for row, after a reset of the demo school beside it');
      } finally {
        await dropNow();
      }
    });

    // The database is judged by the domain of each address, and SQL's split_part takes the part BETWEEN the first and the second `@`: an
    // address with two of them was a reserved one when it ends in `@gmail.com`. Every such shape is a real address (nothing mails it
    // to the reserved domain), and none of them is one a mailbox is behind either.
    for (const [label, address] of [
      ['two @ with a reserved name first', `x-${tag}@example.com@gmail.com`],
      ['two @ with a reserved name last', `x-${tag}@gmail.com@example.com`],
      ['an empty local part', `@example.com`],
      ['three @', `x-${tag}@example.com@example.org@gmail.com`],
    ] as const) {
      await check(`(9) an address with ${label} is a real address: the database refuses the demo school`, async () => {
        const real = await owner.school.create({ data: { name: `Probe adress ${tag}`, slug: `probe-real-db9d-${tag}`, timezone: 'Europe/Stockholm' } });
        cleanupNow.push(real.id);
        try {
          await person(real.id, address);
          const result = await resetDemoSchool(owner, { spec: specOf('db9d'), write: false });
          assert.deepEqual(result.kind === 'REFUSED' ? result.refusal : null, { code: 'DATABASE_HAS_A_REAL_SCHOOL', count: 1 });
        } finally {
          await dropNow();
        }
      });
    }

    await check('(9) a school with nobody in it, schools whose people are all at the names reserved for examples, and a school whose people are all pseudonymised, are not a real school', async () => {
      // Each kind is made here, not assumed from what the database holds: the demo school is made beside all three and nothing stops it.
      const empty = await owner.school.create({ data: { name: `Probe tom ${tag}`, slug: `probe-empty-db9-${tag}`, timezone: 'Europe/Stockholm' } });
      created.push(empty.id);
      const reserved = await owner.school.create({ data: { name: `Probe reserverad ${tag}`, slug: `probe-reserved-db9-${tag}`, timezone: 'Europe/Stockholm' } });
      created.push(reserved.id);
      await person(reserved.id, `lärare-${tag}@skola.example.org`);
      await person(reserved.id, `rektor-${tag}@kommun.test`);
      // What gallring leaves of a person (DEPLOYMENT §37): `.invalid` is reserved, so the school is not a real one to the guard.
      const pseudonymised = await owner.school.create({ data: { name: `Probe pseudonymiserad ${tag}`, slug: `probe-pseudonymised-db9-${tag}`, timezone: 'Europe/Stockholm' } });
      created.push(pseudonymised.id);
      await person(pseudonymised.id, `pseudonym-${randomUUID()}@pseudonym.invalid`);
      const before = await Promise.all([empty.id, reserved.id, pseudonymised.id].map((id) => snapshot(id)));

      const made = specOf('db9c');
      const result = await resetDemoSchool(owner, { spec: made });
      assert.equal(result.kind, 'CREATED');
      if (result.kind === 'CREATED') created.push(result.schoolId);
      assert.deepEqual(await Promise.all([empty.id, reserved.id, pseudonymised.id].map((id) => snapshot(id))), before, 'the three are as they were');
    });

    // (10b) THE HÖGSTADIUM SEED ASKS THE SAME IN EVERY PATH, as a command: in a database that holds a school with a person at a real address it makes
    // nothing (NOT SEEDED, exit 1), and without --reset it says NOT RESET of a school --reset would refuse, not the advice that ends in it.
    await check('(10) `seed-hogstadium.ts` as a command: NOT SEEDED in a database with a real school, NOT RESET (not "Use --reset") of a school with a real person, and nothing written', async () => {
      const slug = 'hogstadieskolan';
      assert.equal(await owner.school.count({ where: { slug } }), 0, `the slug is the seed's own: nothing else in this database has it`);
      const seed = (args: string[]): { status: number | null; out: string } => {
        const result = spawnTheSeed(joinPath(__dirname, '../../node_modules/.bin/ts-node'), ['--transpile-only', 'prisma/seed-hogstadium.ts', ...args], {
          cwd: joinPath(__dirname, '../..'),
          env: { ...process.env, DIRECT_URL: requiredEnv('PROBE_OWNER_URL'), DATABASE_URL: requiredEnv('PROBE_OWNER_URL') },
          encoding: 'utf8',
          timeout: 300_000,
        });
        return { status: result.status, out: `${result.stdout}${result.stderr}` };
      };

      // A database with a real school: the seed makes no school, for a plain run and for --reset alike.
      const real = await owner.school.create({ data: { name: `Probe riktig ${tag}`, slug: `probe-real-hs-${tag}`, timezone: 'Europe/Stockholm' } });
      created.push(real.id);
      cleanupNow.push(real.id);
      await person(real.id, `rektor-${tag}@skola.stockholm.se`);
      assert.deepEqual(await judgeSeedDatabase(owner), { code: 'DATABASE_HAS_A_REAL_SCHOOL', count: 1 }, 'the guard sees the real school');
      for (const args of [[], ['--reset']]) {
        const run = seed(args);
        assert.equal(run.status, 1, `exit code 1 where the database has a real school (${args.join(' ') || 'no flag'}): ${run.out}`);
        assert.match(run.out, /NOT SEEDED\. Databasen har 1 skola med personer på riktiga adresser/);
        assert.doesNotMatch(run.out, /rektor|stockholm/, 'the command names no address');
        assert.equal(await owner.school.count({ where: { slug } }), 0, 'and nothing was made');
      }
      await dropNow();
      assert.equal(await judgeSeedDatabase(owner), null, 'a database of made-up schools only may have it');

      // A school of the seed's own people, with a real person in it: a plain run says NOT RESET, not the advice, and writes nothing.
      const school = await owner.school.create({ data: { name: 'Högstadieskolan', slug, timezone: 'Europe/Stockholm' } });
      created.push(school.id);
      cleanupNow.push(school.id);
      await person(school.id, 'admin@hogstadieskolan.example.com', { role: 'SCHOOL_ADMIN' });
      await person(school.id, `rektor-${tag}@skola.stockholm.se`);
      const before = await snapshot(school.id);
      const refused = seed([]);
      assert.equal(refused.status, 1, `exit code 1: ${refused.out}`);
      assert.match(refused.out, /NOT RESET\. 1 person i skolan har en adress som inte slutar på @hogstadieskolan\.example\.com/);
      assert.doesNotMatch(refused.out, /Use --reset/, 'no advice that ends in a refusal');
      assert.deepEqual(await snapshot(school.id), before, 'nothing was written');
      assert.deepEqual(await deleteSeedSchool(owner, { slug, name: 'Högstadieskolan', domain: 'hogstadieskolan.example.com' }, { write: false }), {
        kind: 'REFUSED',
        schoolId: school.id,
        refusal: { code: 'PEOPLE_OUTSIDE_THE_DEMO', count: 1 },
      });

      // The real person goes: a plain run gives the advice and exits 0, and a dry run says the school may be deleted, and does not.
      await owner.user.deleteMany({ where: { schoolId: school.id, email: { contains: '@skola.stockholm.se' } } });
      const plain = seed([]);
      assert.equal(plain.status, 0, plain.out);
      assert.match(plain.out, /Use --reset to recreate it\./);
      assert.deepEqual(await deleteSeedSchool(owner, { slug, name: 'Högstadieskolan', domain: 'hogstadieskolan.example.com' }, { write: false }), { kind: 'MAY_BE_DELETED', schoolId: school.id });
      assert.ok(await exists(school.id), 'a dry run deletes nothing');
    }).finally(dropNow);

    // (10) the högstadium seed's reset
    await check('(10) the högstadium seed deletes the school with its slug only when every person in it is at the seed\'s domain', async () => {
      const { spec, schoolId } = await demoSchool('h10');
      const other = await demoSchool('h10o');

      // A person at a real address: refused, and the school is the one it was, row for row. Another school is not touched either way.
      await person(schoolId, `rektor-${tag}@skola.stockholm.se`);
      const [before, beforeOther] = await Promise.all([snapshot(schoolId), snapshot(other.schoolId)]);
      const refused = await deleteSeedSchool(owner, spec);
      assert.equal(refused.kind, 'REFUSED');
      if (refused.kind === 'REFUSED') {
        assert.equal(refused.schoolId, schoolId);
        assert.deepEqual(refused.refusal, { code: 'PEOPLE_OUTSIDE_THE_DEMO', count: 1 });
      }
      assert.ok(await exists(schoolId), 'the school is still there');
      assert.deepEqual(await snapshot(schoolId), before, 'row for row');

      // The right people under another name: the school is judged by its name too.
      await owner.user.deleteMany({ where: { schoolId, email: { contains: '@skola.stockholm.se' } } });
      const renamed = await deleteSeedSchool(owner, { ...spec, name: `Ett annat namn ${tag}` });
      assert.deepEqual(renamed.kind === 'REFUSED' ? renamed.refusal : null, { code: 'NOT_THE_DEMO_SCHOOL' });
      assert.ok(await exists(schoolId));

      // The seed's own school, as it is made: deleted, and only it.
      const deleted = await deleteSeedSchool(owner, spec);
      assert.deepEqual(deleted, { kind: 'DELETED', schoolId });
      assert.equal(await exists(schoolId), false, 'the school is gone');
      assert.deepEqual(await snapshot(other.schoolId), beforeOther, 'another school, row for row');

      // A school that is not there is not an error: the seed makes it.
      assert.deepEqual(await deleteSeedSchool(owner, spec), { kind: 'ABSENT' });
    });

    // (10b) a person added at the same time, to the högstadium seed's school: the lock deleteSeedSchool takes is what this holds
    await check('(10) a person who commits while the högstadium seed\'s school is being deleted is seen, not deleted unseen: the deletion waits for the lock, reads the person and refuses', async () => {
      const { spec, schoolId } = await demoSchool('h10c');
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let inserted!: () => void;
      const insertedRow = new Promise<void>((resolve) => {
        inserted = resolve;
      });
      // The person is inserted in a transaction that stays open: it holds a share lock on the school's row.
      cleanupNow.push(schoolId);
      const adding = owner.$transaction(async (tx) => {
        await tx.user.create({ data: { schoolId, authId: randomUUID(), role: 'TEACHER', firstName: 'Real', lastName: 'Person', email: `rektor-${tag}@kommun.example.org` } });
        inserted();
        await held;
      });
      await insertedRow;
      const deleting = deleteSeedSchool(owner, spec);
      let settled = false;
      void deleting.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(settled, false, 'the deletion waits for the person\'s transaction');
      release();
      await adding;
      const result = await deleting;
      // Without the lock on the school's row the facts are read before the person commits, the school passes, and the delete (which waits for the
      // person's share lock and then cascades to the person's row) takes a person nobody saw: DELETED, and the person gone.
      assert.deepEqual(result.kind === 'REFUSED' ? result.refusal : null, { code: 'PEOPLE_OUTSIDE_THE_DEMO', count: 1 }, 'refused: the person committed first and is seen');
      assert.ok(await exists(schoolId), 'the school is still there');
      assert.equal(await owner.user.count({ where: { schoolId, email: `rektor-${tag}@kommun.example.org` } }), 1, 'and so is the person');
    }).finally(dropNow);

    // (11) what db:seed says of a school that is there
    await check('(11) db:seed says "Use --reset" of the demo school and NOT RESET, with nothing written, of a school that is not', async () => {
      const { spec, schoolId } = await demoSchool('s11');
      const demo = await describeExistingDemoSchool(owner, schoolId, spec);
      assert.equal(demo.refused, false);
      assert.match(demo.text, /^Demo school already exists \(.+\)\. Use --reset to recreate it\.$/);

      await person(schoolId, `rektor-${tag}@kommun.example.org.evil.se`);
      const before = await snapshot(schoolId);
      const real = await describeExistingDemoSchool(owner, schoolId, spec);
      assert.equal(real.refused, true);
      assert.match(real.text, /^NOT RESET\. 1 person i skolan har en adress som inte slutar på @/);
      assert.doesNotMatch(real.text, /Use --reset/, 'no advice that ends in a refusal');
      assert.doesNotMatch(real.text, /rektor|evil/, 'the text names no address');
      assert.deepEqual(await snapshot(schoolId), before, 'nothing was written');
    });

    // (12) the command, not its functions
    await check('(12) `seed-hogstadium.ts --reset` as a command: refused with exit 1 and nothing written for a school with a real person, deleted and made again for a school of its own people', async () => {
      const slug = 'hogstadieskolan';
      const domain = 'hogstadieskolan.example.com';
      assert.equal(await owner.school.count({ where: { slug } }), 0, `the slug is the seed's own: nothing else in this database has it`);
      const run = (): { status: number | null; out: string } => {
        const result = spawnSync(join(__dirname, '../../node_modules/.bin/ts-node'), ['--transpile-only', 'prisma/seed-hogstadium.ts', '--reset'], {
          cwd: join(__dirname, '../..'),
          env: { ...process.env, DIRECT_URL: requiredEnv('PROBE_OWNER_URL'), DATABASE_URL: requiredEnv('PROBE_OWNER_URL') },
          encoding: 'utf8',
          timeout: 300_000,
        });
        return { status: result.status, out: `${result.stdout}${result.stderr}` };
      };

      const school = await owner.school.create({ data: { name: 'Högstadieskolan', slug, timezone: 'Europe/Stockholm' } });
      created.push(school.id);
      cleanupNow.push(school.id);
      await person(school.id, `admin@${domain}`, { role: 'SCHOOL_ADMIN' });
      await person(school.id, `rektor-${tag}@skola.stockholm.se`);
      const before = await snapshot(school.id);
      const refused = run();
      assert.equal(refused.status, 1, `exit code 1 on a refusal: ${refused.out}`);
      assert.match(refused.out, /NOT RESET\. 1 person i skolan har en adress som inte slutar på @hogstadieskolan\.example\.com/);
      assert.doesNotMatch(refused.out, /rektor|stockholm/, 'the command names no address');
      assert.ok(await exists(school.id), 'the school is still there');
      assert.deepEqual(await snapshot(school.id), before, 'row for row');

      // The real person goes: what is left is the seed's own school, and the command deletes it and makes it again.
      await owner.user.deleteMany({ where: { schoolId: school.id, email: { contains: '@skola.stockholm.se' } } });
      const again = run();
      assert.equal(again.status, 0, `exit code 0 for the seed's own school: ${again.out}`);
      assert.match(again.out, /Deleted the högstadium school\./);
      assert.equal(await exists(school.id), false, 'the old school is gone');
      const made = await owner.school.findUnique({ where: { slug } });
      assert.ok(made, 'and a new one is there');
      created.push(made.id);
      assert.ok((await owner.user.count({ where: { schoolId: made.id } })) > 400, 'with its people');
    }).finally(dropNow);
  } finally {
    for (const id of created.reverse()) {
      await owner.school.delete({ where: { id } }).catch(() => undefined);
    }
    await owner.$disconnect();
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\ndemo-reset probe passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
