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
 *   (8) the rows the read log leaves (PersonalDataAccess: append-only, no foreign key to the school) do not stop a reset.
 *
 * It drops every school it made.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { createPgAdapter } from '../../src/database/pool-config';
import { type DemoSpec } from '../../src/demo-school/demo-guard';
import { resetDemoSchool, describeResult } from '../../prisma/demo-reset';
import { createDemoSchool } from '../../prisma/demo-school';

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
    ] as const) {
      await check(`(2) the school with the demo's name and ${label} is refused, and nothing is deleted`, async () => {
        const { spec, schoolId } = await demoSchool(key);
        await make(schoolId, spec);
        const before = await snapshot(schoolId);
        const result = await resetDemoSchool(owner, { spec });
        assert.equal(result.kind, 'REFUSED');
        if (result.kind === 'REFUSED') assert.deepEqual(result.refusal, { code: 'PEOPLE_OUTSIDE_THE_DEMO', count: 1 });
        assert.deepEqual(await snapshot(schoolId), before, 'every row, as it was');
        assert.ok(await exists(schoolId), 'the same school');
        // The domain the demo's people have is the spec's, said once; no person's address is.
        assert.doesNotMatch(describeResult(result, spec).replaceAll(`@${spec.domain}`, ''), /@|kommun|gmail|evil/, 'the refusal names no address');
      });
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
      assert.ok(emails.length > 50 && emails.every((email) => email.endsWith(`@${spec.domain}`)), 'the school is the demo school, made again');
    });

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
    await check('(7) a dry run writes nothing and says it may; for a school with a real person it refuses; for none it says there is none', async () => {
      const { spec, schoolId } = await demoSchool('x1');
      const before = await snapshot(schoolId);
      const dry = await resetDemoSchool(owner, { spec, write: false });
      assert.equal(dry.kind, 'MAY_BE_RESET');
      assert.deepEqual(await snapshot(schoolId), before);
      assert.match(describeResult(dry, spec), /Nothing was written/);

      await person(schoolId, `rektor-${tag}@kommun.example.org`);
      const dryRefused = await resetDemoSchool(owner, { spec, write: false });
      assert.equal(dryRefused.kind, 'REFUSED');

      const none = specOf('none');
      await assert.rejects(resetDemoSchool(owner, { spec: none, write: false }), /no school with the slug/);
      assert.equal(await owner.school.count({ where: { slug: none.slug } }), 0, 'a dry run makes nothing');
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
