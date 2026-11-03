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
 *   mv3  a delete that carries its dry run's counts back deletes nothing when
 *        a kind grew meanwhile, says which, and deletes with the new counts.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { GROUP_KEYS, STUDENT_KEYS, type InventoryKey, type OnDelete } from '../../src/common/removal-inventory';
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
  } finally {
    await sweepMassvalSchool(owner, marker);
  }
}
