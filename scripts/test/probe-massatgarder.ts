/**
 * The adapter probe's checks for Massåtgärder (src/common/bulk.ts), through
 * the real services on the API's role and real Postgres as CI runs it. In a
 * school of its own (slug <marker>-massval), swept whole before and after:
 *
 *   mv1  the inventory of what hangs on a deleted row
 *        (src/common/removal-inventory.ts) is the catalogue's: every foreign
 *        key to StudentGroups and Users in pg_constraint, with its ON DELETE,
 *        and nothing else. 26 of them are written in migrations alone and
 *        never declared in schema.prisma, which removal-inventory.spec.ts
 *        reads, so this is where a key added in SQL is caught untold;
 *   mv2  a dry run's counts, made under the admin's RLS, are the rows the
 *        owner counts by the same keys, for a class with a half, pupils, a
 *        membership and class history, and for its pupils;
 *        A level down too: every key to a table either delete reaches
 *        through CASCADE keys, at any depth, is GROUP_BELOW's or STUDENT_BELOW's;
 *   mv3  a delete that carries its dry run's counts back deletes nothing when
 *        a kind grew meanwhile, says which, and deletes with the new counts;
 *   mv4  the bulk and single writes take a class and its half in one order
 *        (src/common/lock-order.ts), the half's id the lower and, for a
 *        half's own edit (whose trigger holds the class), the class's:
 *        overlapping pairs end without a deadlock (409 WRITE_CONFLICT), a
 *        pupils' move between two classes being deleted included;
 *   mv6  that order is the rollover's: a write over a class waits for a
 *        transaction that holds the half and then the class FOR SHARE, as
 *        the rollover and the year's activation hold a year's groups in id
 *        order, rather than holding the class and deadlocking;
 *   mv5  a delete's dry run holds no row lock: it answers while another
 *        transaction holds a pupil's and a class's key, as a teacher's
 *        attendance insert and a lesson's insert do.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import {
  GROUP_BELOW,
  GROUP_KEYS,
  STUDENT_BELOW,
  STUDENT_KEYS,
  type BelowKey,
  type InventoryKey,
  type OnDelete,
} from '../../src/common/removal-inventory';
import { WRITE_CONFLICT } from '../../src/common/utils/prisma-errors';
import { StudentGroupsService } from '../../src/resources/student-groups.service';
import type { SupabaseAdminService } from '../../src/users/supabase-admin.service';
import { UsersService } from '../../src/users/users.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function massvalSlug(marker: string): string {
  return `${marker}-massval`;
}

export async function sweepMassvalSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [massvalSlug(marker)]);
}

const ON_DELETE: Record<string, OnDelete> = { c: 'CASCADE', n: 'SET NULL', r: 'RESTRICT' };
const asKey = (entry: { table: string; columns: readonly string[]; onDelete: string }) =>
  `${entry.table}|${entry.columns.join(',')}|${entry.onDelete}`;

/** What the owner counts for `ids` by the inventory's counted keys, kind by kind. */
async function ownerCounts(
  owner: Client,
  keys: readonly InventoryKey<string>[],
  ids: string[],
): Promise<Record<string, number>> {
  const byKindAndTable = new Map<string, Map<string, string[]>>();
  for (const entry of keys) {
    if (!('counted' in entry.tell)) continue;
    const tables = byKindAndTable.get(entry.tell.counted) ?? new Map<string, string[]>();
    tables.set(entry.table, [...(tables.get(entry.table) ?? []), entry.columns[0]!]);
    byKindAndTable.set(entry.tell.counted, tables);
  }
  const counts: Record<string, number> = {};
  for (const [kind, tables] of byKindAndTable) {
    counts[kind] = 0;
    for (const [table, columns] of tables) {
      const where = columns.map((column) => `"${column}" = ANY($1::uuid[])`).join(' OR ');
      counts[kind] += (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`, [ids])).rows[0]!.n;
    }
  }
  return counts;
}

export async function massvalChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await check('(mv1) the inventory of what hangs on a deleted group or person is the catalogue’s, every key told', async () => {
    const { rows } = await owner.query<{ parent: string; child: string; del: string; cols: string }>(`
      SELECT c.confrelid::regclass::text AS parent, trim(both '"' from c.conrelid::regclass::text) AS child, c.confdeltype AS del,
             (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols
        FROM pg_constraint c
       WHERE c.contype = 'f' AND c.confrelid IN ('"StudentGroups"'::regclass, '"Users"'::regclass)`);
    for (const [parent, inventory] of [
      ['"StudentGroups"', GROUP_KEYS],
      ['"Users"', STUDENT_KEYS],
    ] as const) {
      const catalogue = rows
        .filter((row) => row.parent === parent)
        .map((row) => asKey({ table: row.child, columns: row.cols.split(','), onDelete: ON_DELETE[row.del] ?? row.del }))
        .sort();
      const told = (inventory as readonly InventoryKey<string>[]).map(asKey).sort();
      assert.ok(catalogue.length > 10, `the catalogue read found ${catalogue.length} keys to ${parent}`);
      assert.deepEqual(
        catalogue.filter((key) => !told.includes(key)),
        [],
        `keys to ${parent} the inventory does not tell (src/common/removal-inventory.ts)`,
      );
      assert.deepEqual(told.filter((key) => !catalogue.includes(key)), [], `keys the inventory tells that ${parent} has no longer`);
    }
    // A level down: the catalogue's own cascade from each, walked to the end.
    const { rows: below } = await owner.query<{ root: string; parent: string; child: string; cols: string; del: string }>(`
      WITH RECURSIVE fk AS (
        SELECT trim(both '"' from c.confrelid::regclass::text) COLLATE "C" AS parent,
               trim(both '"' from c.conrelid::regclass::text) COLLATE "C" AS child, c.confdeltype AS del,
               (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                  FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) COLLATE "C" AS cols
          FROM pg_constraint c WHERE c.contype = 'f'
      ), taken(root, tbl, depth) AS (
        SELECT v.r COLLATE "C", fk.child, 1
          FROM (VALUES ('StudentGroups'), ('Users')) v(r)
          JOIN fk ON fk.parent = v.r AND fk.del = 'c' AND fk.child <> v.r
        UNION
        SELECT t.root, fk.child, t.depth + 1
          FROM taken t JOIN fk ON fk.parent = t.tbl AND fk.del = 'c' AND fk.child <> t.tbl
         WHERE t.depth < 10
      )
      SELECT DISTINCT t.root, fk.parent, fk.child, fk.cols, fk.del
        FROM taken t JOIN fk ON fk.parent = t.tbl
       WHERE fk.parent NOT IN ('StudentGroups', 'Users')`);
    const asBelow = (entry: { parent: string; table: string; columns: readonly string[]; onDelete: string }) =>
      `${entry.parent} > ${asKey(entry)}`;
    for (const [root, inventory] of [
      ['StudentGroups', GROUP_BELOW],
      ['Users', STUDENT_BELOW],
    ] as const) {
      const catalogue = below
        .filter((row) => row.root === root)
        .map((row) =>
          asBelow({ parent: row.parent, table: row.child, columns: row.cols.split(','), onDelete: ON_DELETE[row.del] ?? row.del }),
        )
        .sort();
      const told = (inventory as readonly BelowKey<string>[]).map(asBelow).sort();
      assert.ok(catalogue.length >= 9, `the cascade walk found ${catalogue.length} keys below ${root}`);
      assert.deepEqual(
        catalogue.filter((key) => !told.includes(key)),
        [],
        `keys a level down from ${root} the inventory does not tell (GROUP_BELOW / STUDENT_BELOW)`,
      );
      assert.deepEqual(told.filter((key) => !catalogue.includes(key)), [], `keys below ${root} the catalogue has no longer`);
    }
  });

  await sweepMassvalSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;
  const s = (
    await one<{ id: string }>(
      `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
      [`${marker} massval`, massvalSlug(marker)],
    )
  ).id;
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
     VALUES ($1, 'probe massval', '${today}'::date - 30, '${today}'::date + 300, true, 'NIOARIG', now()) RETURNING id`,
    [s],
  );
  const group = (name: string, kind: string, halfOfId: string | null = null) =>
    one<{ id: string }>(
      `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "halfOfId", "updatedAt")
       VALUES ($1, $2, $3, $4::"StudentGroupKind", 7, $5, now()) RETURNING id`,
      [s, year.id, name, kind, halfOfId],
    );
  const person = async (role: string, label: string, groupId: string | null = null) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4, $5, true, $6, now()) RETURNING id`,
      [s, `${marker}-massval-${label}@example.invalid`, label, role, authId, groupId],
    );
    return { id: row.id, authId };
  };
  const admin = await person('SCHOOL_ADMIN', 'admin');
  const asAdmin: AuthenticatedUser = {
    authId: admin.authId,
    role: Role.SCHOOL_ADMIN,
    userId: admin.id,
    schoolId: s,
    channel: 'WEB',
    adminProfile: 'FULL',
  };
  const groups = new StudentGroupsService(api);
  const users = new UsersService(api, { deleteUser: async () => undefined } as unknown as SupabaseAdminService);

  try {
    const c7 = await group('MV7A', 'CLASS');
    const half = await group('MV7A:1', 'TEACHING_GROUP', c7.id);
    const ma = await group('MV-Ma7', 'TEACHING_GROUP');
    const p1 = await person('STUDENT', 'p1', c7.id);
    const p2 = await person('STUDENT', 'p2', c7.id);
    for (const [groupId, studentId] of [
      [half.id, p1.id],
      [ma.id, p1.id],
      [ma.id, p2.id],
    ]) {
      await owner.query(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES ($1, $2, $3)`, [
        s,
        groupId,
        studentId,
      ]);
    }

    await check('(mv2) a dry run’s counts under the admin’s RLS are the rows the owner counts by the same keys', async () => {
      const groupRun = await groups.bulkRemove({ ids: [c7.id], dryRun: true }, asAdmin);
      assert.equal(groupRun.applied, false);
      const expectedGroups = await ownerCounts(owner, GROUP_KEYS, [c7.id, half.id]);
      // halves and successors are counted apart: the halves the call does not name, the successors it does not delete.
      expectedGroups.halves = 1;
      expectedGroups.successors = 0;
      for (const [kind, count] of Object.entries(expectedGroups)) {
        assert.equal((groupRun.consequences as Record<string, number> | undefined)?.[kind], count, `the groups' ${kind}`);
      }
      assert.ok(expectedGroups.homePupils === 2 && expectedGroups.memberships === 1 && expectedGroups.enrolments >= 2);

      const pupilRun = await users.bulkRemoveStudents({ ids: [p1.id, p2.id], dryRun: true }, asAdmin);
      const expectedPupils = await ownerCounts(owner, STUDENT_KEYS, [p1.id, p2.id]);
      for (const [kind, count] of Object.entries(expectedPupils)) {
        assert.equal((pupilRun.consequences as Record<string, number> | undefined)?.[kind], count, `the pupils' ${kind}`);
      }
      assert.ok(expectedPupils.memberships === 3 && expectedPupils.enrolments >= 2);
      // Nothing was deleted by either.
      const left = await one<{ n: number }>(`SELECT count(*)::int AS n FROM "Users" WHERE id = ANY($1::uuid[])`, [[p1.id, p2.id]]);
      assert.equal(left.n, 2);
    });

    await check('(mv3) a delete whose consequences grew since its dry run deletes nothing, says which, and deletes on the new counts', async () => {
      const dry = await groups.bulkRemove({ ids: [c7.id], dryRun: true }, asAdmin);
      // A pupil placed in the class after the dialog showed the counts.
      await person('STUDENT', 'p3', c7.id);
      const refused = await groups.bulkRemove(
        { ids: [c7.id], dryRun: false, expected: dry.consequences as unknown as Record<string, unknown> },
        asAdmin,
      );
      assert.equal(refused.applied, false);
      assert.deepEqual(refused.consequencesGrew, ['enrolments', 'homePupils']);
      assert.equal((refused.consequences as unknown as Record<string, number>).homePupils, 3);
      assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "StudentGroups" WHERE id = $1`, [c7.id])).n, 1);

      const applied = await groups.bulkRemove(
        { ids: [c7.id], dryRun: false, expected: refused.consequences as unknown as Record<string, unknown> },
        asAdmin,
      );
      assert.equal(applied.applied, true);
      assert.equal(
        (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "StudentGroups" WHERE id = ANY($1::uuid[])`, [[c7.id, half.id]])).n,
        0,
      );
      assert.equal(
        (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "Users" WHERE "schoolId" = $1 AND "studentGroupId" IS NOT NULL`, [s])).n,
        0,
      );
    });
    // A class and its half, the half's id the lower unless `classLower`: a
    // lock in plain id order takes the half first, the cascade and the single
    // routes the class; a half's own edit holds the half, and its trigger then
    // the class, against a write that holds the class first when its id is the
    // lower.
    const family = async (label: string, classLower = false) => {
      const [low, high] = [randomUUID(), randomUUID()].sort();
      const [classId, halfId] = classLower ? [low!, high!] : [high!, low!];
      const cls = await one<{ id: string }>(
        `INSERT INTO "StudentGroups" (id, "schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
         VALUES ($1, $2, $3, $4, 'CLASS', 7, now()) RETURNING id`,
        [classId, s, year.id, `MV-F${label}`],
      );
      await owner.query(
        `INSERT INTO "StudentGroups" (id, "schoolId", "academicYearId", name, kind, "gradeLevel", "halfOfId", "updatedAt")
         VALUES ($1, $2, $3, $4, 'TEACHING_GROUP', 7, $5, now())`,
        [halfId, s, year.id, `MV-F${label}:1`, cls.id],
      );
      const pupils = [(await person('STUDENT', `f${label}a`, cls.id)).id, (await person('STUDENT', `f${label}b`, cls.id)).id];
      return { cls: cls.id, half: halfId, name: `MV-F${label}:1`, pupils };
    };
    type Family = Awaited<ReturnType<typeof family>>;

    await check('(mv4) a class and its half are locked in one order by every write: overlapping pairs end without a deadlock', async () => {
      // What the edit dialog sends when a half is saved: the whole form, its
      // kind and läsår among it, which wake the half trigger.
      const editHalf = (a: Family) =>
        groups.update(a.half, { name: a.name, kind: 'TEACHING_GROUP', academicYearId: year.id, gradeLevel: 7 }, asAdmin);
      const pairs: [string, (a: Family, b: Family) => Promise<unknown>, (a: Family, b: Family) => Promise<unknown>, 'class lower'?][] = [
        ['update(A) × bulkRemove([A])', (a) => groups.update(a.cls, { gradeLevel: 8 }, asAdmin), (a) =>
          groups.bulkRemove({ ids: [a.cls], dryRun: false }, asAdmin)],
        ['bulkUpdate([A]) × bulkRemove([H, A])', (a) => groups.bulkUpdate({ ids: [a.cls], changes: { gradeLevel: 9 }, dryRun: false }, asAdmin), (a) =>
          groups.bulkRemove({ ids: [a.half, a.cls], dryRun: false }, asAdmin)],
        ['bulkUpdate([H, A]) × bulkUpdate([A])', (a) => groups.bulkUpdate({ ids: [a.half, a.cls], changes: { gradeLevel: 9 }, dryRun: false }, asAdmin), (a) =>
          groups.bulkUpdate({ ids: [a.cls], changes: { gradeLevel: 6 }, dryRun: false }, asAdmin)],
        ['remove(A) × bulkUpdate([H, A])', (a) => groups.remove(a.cls, asAdmin), (a) =>
          groups.bulkUpdate({ ids: [a.half, a.cls], changes: { gradeLevel: 9 }, dryRun: false }, asAdmin)],
        ['placeHalves(A) × bulkRemove([A])', (a) =>
          groups.placeHalves(a.cls, { halves: [{ groupId: a.half, studentIds: [a.pupils[0]!] }] }, asAdmin), (a) =>
          groups.bulkRemove({ ids: [a.cls], dryRun: false }, asAdmin)],
        ['setMembers(H) × bulkRemove([A])', (a) => groups.setMembers(a.half, { studentIds: a.pupils }, asAdmin), (a) =>
          groups.bulkRemove({ ids: [a.cls], dryRun: false }, asAdmin)],
        ['bulkUpdateStudents(A → B) × bulkRemove([A, B])', (a, b) =>
          users.bulkUpdateStudents({ ids: a.pupils, changes: { studentGroupId: b.cls }, dryRun: false }, asAdmin), (a, b) =>
          groups.bulkRemove({ ids: [a.cls, b.cls], dryRun: false }, asAdmin)],
        ['update(A) × bulkRemove([A]), the class\'s id the lower', (a) => groups.update(a.cls, { gradeLevel: 8 }, asAdmin), (a) =>
          groups.bulkRemove({ ids: [a.cls], dryRun: false }, asAdmin), 'class lower'],
        ['update(H, the edit dialog) × remove(A)', editHalf, (a) => groups.remove(a.cls, asAdmin), 'class lower'],
        ['update(H, the edit dialog) × bulkRemove([A])', editHalf, (a) =>
          groups.bulkRemove({ ids: [a.cls], dryRun: false }, asAdmin), 'class lower'],
        ['update(H, the edit dialog) × bulkUpdate([A])', editHalf, (a) =>
          groups.bulkUpdate({ ids: [a.cls], changes: { gradeLevel: 9 }, dryRun: false }, asAdmin), 'class lower'],
        ['update(H, the edit dialog) × update(A)', editHalf, (a) => groups.update(a.cls, { gradeLevel: 8 }, asAdmin), 'class lower'],
      ];
      const ended: string[] = [];
      for (const [name, first, second, layout] of pairs) {
        for (let round = 0; round < 6; round += 1) {
          const a = await family(`${pairs.findIndex(([n]) => n === name)}-${round}a`, layout === 'class lower');
          const b = await family(`${pairs.findIndex(([n]) => n === name)}-${round}b`, layout === 'class lower');
          const outcomes = await Promise.allSettled([
            first(a, b),
            new Promise((resolve) => setTimeout(resolve, round % 4)).then(() => second(a, b)),
          ]);
          for (const outcome of outcomes) {
            if (outcome.status === 'fulfilled') continue;
            const reason = outcome.reason as { response?: { code?: unknown }; getStatus?: () => number };
            // A refusal of a row already gone is an answer; a deadlock or a 5xx is not.
            const status = typeof reason.getStatus === 'function' ? reason.getStatus() : 500;
            if (reason.response?.code === WRITE_CONFLICT || status >= 500) ended.push(`${name}: ${String(outcome.reason)}`);
          }
          await owner.query(`DELETE FROM "Users" WHERE id = ANY($1::uuid[])`, [[...a.pupils, ...b.pupils]]);
          await owner.query(`DELETE FROM "StudentGroups" WHERE id = ANY($1::uuid[])`, [[a.half, a.cls, b.half, b.cls]]);
        }
      }
      assert.deepEqual(ended, [], 'overlapping writes that ended in a deadlock or a 5xx');
    });

    await check('(mv6) a write over a class waits for a transaction that holds its half and then the class FOR SHARE, as the rollover does, and neither is aborted', async () => {
      const writes: [string, (f: Family) => Promise<unknown>][] = [
        ['update(A)', (f) => groups.update(f.cls, { gradeLevel: 8 }, asAdmin)],
        ['bulkUpdate([A])', (f) => groups.bulkUpdate({ ids: [f.cls], changes: { gradeLevel: 9 }, dryRun: false }, asAdmin)],
        ['remove(A)', (f) => groups.remove(f.cls, asAdmin)],
        ['bulkRemove([A])', (f) => groups.bulkRemove({ ids: [f.cls], dryRun: false }, asAdmin)],
      ];
      for (const [index, [name, write]] of writes.entries()) {
        const f = await family(`roll${index}`);
        await owner.query('BEGIN');
        try {
          // The rollover's read of a year's groups, FOR SHARE in id order: the half first, its id the lower.
          await owner.query(`SELECT 1 FROM "StudentGroups" WHERE id = $1 FOR SHARE`, [f.half]);
          const pending = write(f).then(
            () => null,
            (error: unknown) => error,
          );
          // The write is now waiting for the half, and holds nothing the rollover needs next.
          await new Promise((resolve) => setTimeout(resolve, 500));
          const aborted = await owner.query(`SELECT 1 FROM "StudentGroups" WHERE id = $1 FOR SHARE`, [f.cls]).then(
            () => null,
            (error: unknown) => error,
          );
          await owner.query(aborted ? 'ROLLBACK' : 'COMMIT');
          assert.equal(aborted, null, `${name}: the rollover's lock of the class was aborted: ${String(aborted)}`);
          assert.equal(await pending, null, `${name} failed after the rollover's commit`);
        } finally {
          await owner.query('ROLLBACK').catch(() => undefined);
        }
        await owner.query(`DELETE FROM "Users" WHERE id = ANY($1::uuid[])`, [f.pupils]);
        await owner.query(`DELETE FROM "StudentGroups" WHERE id = ANY($1::uuid[])`, [[f.half, f.cls]]);
      }
    });

    await check('(mv5) a delete’s dry run holds no row lock: it answers while a teacher’s insert holds a pupil’s and a class’s key', async () => {
      const f = await family('lock');
      const held = owner;
      await held.query('BEGIN');
      try {
        // What an attendance insert and a lesson insert hold until they commit.
        await held.query(`SELECT 1 FROM "Users" WHERE id = $1 FOR KEY SHARE`, [f.pupils[0]]);
        await held.query(`SELECT 1 FROM "StudentGroups" WHERE id = $1 FOR KEY SHARE`, [f.cls]);
        const within = <T>(work: Promise<T>) =>
          Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('waited 10 s on a lock')), 10_000))]);
        const pupils = await within(users.bulkRemoveStudents({ ids: f.pupils, dryRun: true }, asAdmin));
        assert.deepEqual([...pupils.done].sort(), [...f.pupils].sort());
        const classes = await within(groups.bulkRemove({ ids: [f.cls], dryRun: true }, asAdmin));
        assert.deepEqual(classes.done, [f.cls]);
        assert.equal(classes.consequences?.halves, 1);
      } finally {
        await held.query('ROLLBACK');
      }
    });
  } finally {
    await sweepMassvalSchool(owner, marker);
  }
}
