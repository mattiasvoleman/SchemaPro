/**
 * The adapter probe's checks for skolenheter (20261031090000), through the
 * real services on the API's role and real Postgres as CI runs it. In a
 * school of its own (slug <marker>-skolenheter), swept whole before and
 * after:
 *
 *   se1  the admin writes the school's units through SchoolUnitsService, and
 *        reads them back in their order; a teacher reads none;
 *   se2  the span trigger's refusal arrives through @prisma/adapter-pg as
 *        SU409 (P2039, the SQLSTATE in meta), which the service answers as
 *        409 SCHOOL_UNIT_SPAN_OVERLAP, the same as its own check;
 *   se3  a unit linked to the source keeps its name, code and skolformer
 *        (409 SCHOOL_UNIT_FROM_SOURCE) and lets the school set its span;
 *   se4  the SS12000 v2 provider, under the service principal and its
 *        school_units_service_select arm, emits one Skolenhet per unit with
 *        its code, the class in the unit holding its årskurs, and the room
 *        with the first unit;
 *   se5  the consumer's apply creates a unit from the source as the admin
 *        (ss12000Id's guard lets the admin's apply through), and the sync
 *        principal's locked slice reads the units and locks none;
 *   se6  a removed unit is buried for /deletedEntities.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { applyChanges } from '../../src/integration/ss12000-sync/apply';
import { readLocalSlice } from '../../src/integration/ss12000-sync/local-slice';
import type { Scope } from '../../src/integration/ss12000-v2/scopes';
import { Ss12000V2Service, type V2Caller } from '../../src/integration/ss12000-v2/ss12000-v2.service';
import { isSpanOverlapRefusal, SchoolUnitsService } from '../../src/school-units/school-units.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function skolenheterSlug(marker: string): string {
  return `${marker}-skolenheter`;
}

export async function sweepSkolenheterSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [skolenheterSlug(marker)]);
}

const rejectsWith = async (body: () => Promise<unknown>, status: number, code: string) => {
  await assert.rejects(body, (error: { getStatus?: () => number; getResponse?: () => unknown }) => {
    assert.equal(error.getStatus?.(), status);
    assert.equal((error.getResponse?.() as { code?: string } | undefined)?.code, code);
    return true;
  });
};

export async function skolenheterChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepSkolenheterSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;
  const s = (
    await one<{ id: string }>(
      `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
      [`${marker} skolenheter`, skolenheterSlug(marker)],
    )
  ).id;
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
     VALUES ($1, 'probe skolenheter', '${today}'::date - 30, '${today}'::date + 300, true, 'NIOARIG', now()) RETURNING id`,
    [s],
  );
  const c7 = await one<{ id: string }>(
    `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES ($1, $2, 'SE7A', 7, now()) RETURNING id`,
    [s, year.id],
  );
  const room = await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, 'SE-salen', now()) RETURNING id`, [s]);
  const person = async (role: string, label: string) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4, $5, true, now()) RETURNING id`,
      [s, `${marker}-skolenheter-${label}@example.invalid`, label, role, authId],
    );
    return { id: row.id, authId };
  };
  const admin = await person('SCHOOL_ADMIN', 'admin');
  const teacher = await person('TEACHER', 'larare');
  const asAdmin: AuthenticatedUser = { authId: admin.authId, role: Role.SCHOOL_ADMIN, userId: admin.id, schoolId: s, channel: 'WEB', adminProfile: 'FULL' };
  const asTeacher: AuthenticatedUser = { authId: teacher.authId, role: Role.TEACHER, userId: teacher.id, schoolId: s, channel: 'WEB' };
  const units = new SchoolUnitsService(api);
  const sourceOrg = 'aaaaaaaa-0000-4000-8000-0000000005e1';

  try {
    let f6 = '';
    let u79 = '';
    await check('(se1) the admin writes and reads the school\'s units; a teacher reads none', async () => {
      u79 = (await units.create({ name: 'SE 7–9', code: '2222 2222', schoolTypes: ['GR'], gradeFrom: 7, gradeTo: 9 }, asAdmin)).id;
      f6 = (await units.create({ name: 'SE F–6', code: '11111111', schoolTypes: ['GR', 'FKLASS'], gradeFrom: 0, gradeTo: 6 }, asAdmin)).id;
      assert.deepEqual(
        (await units.list(asAdmin)).map((unit) => [unit.name, unit.code, unit.schoolTypes.join(','), unit.gradeFrom, unit.gradeTo]),
        [
          ['SE F–6', '11111111', 'FKLASS,GR', 0, 6],
          ['SE 7–9', '22222222', 'GR', 7, 9],
        ],
      );
      assert.deepEqual(await units.list(asTeacher), []);
      await rejectsWith(() => units.create({ name: 'Mellan', gradeFrom: 5, gradeTo: 7 }, asAdmin), 409, 'SCHOOL_UNIT_SPAN_OVERLAP');
      await rejectsWith(() => units.create({ name: 'Dubblett', code: '11111111' }, asAdmin), 409, 'SCHOOL_UNIT_CODE_TAKEN');
    });

    await check('(se2) the span trigger\'s refusal reaches the gateway as SU409', async () => {
      await assert.rejects(
        () => api.withRls(asAdmin, (tx) => tx.schoolUnit.create({ data: { schoolId: s, name: 'Förbi kontrollen', gradeFrom: 6, gradeTo: 7 } })),
        (error: unknown) => {
          assert.ok(isSpanOverlapRefusal(error), `not read as SU409: ${String(error)}`);
          return true;
        },
      );
    });

    await check('(se3) a unit from the register keeps its name, code and skolformer, and takes a span', async () => {
      await owner.query('BEGIN');
      try {
        await owner.query(`SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text)::text, true)`, [admin.authId]);
        await owner.query(`UPDATE "SchoolUnits" SET "ss12000Id" = $2 WHERE id = $1`, [f6, sourceOrg]);
        await owner.query('COMMIT');
      } catch (error) {
        await owner.query('ROLLBACK');
        throw error;
      }
      await rejectsWith(() => units.update(f6, { name: 'Annat namn' }, asAdmin), 409, 'SCHOOL_UNIT_FROM_SOURCE');
      await rejectsWith(() => units.update(f6, { code: '99999999' }, asAdmin), 409, 'SCHOOL_UNIT_FROM_SOURCE');
      const moved = await units.update(f6, { gradeFrom: 1, gradeTo: 6 }, asAdmin);
      assert.deepEqual([moved.fromSource, moved.gradeFrom, moved.gradeTo], [true, 1, 6]);
      await units.update(f6, { gradeFrom: 0 }, asAdmin);
    });

    await check('(se4) the provider emits one Skolenhet per unit and puts the class in the unit holding its årskurs', async () => {
      const key = await one<{ id: string }>(
        `INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash", scopes) VALUES ($1, 'probe skolenheter', $2, $3::text[]) RETURNING id`,
        [s, `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`, '{organisations.read,groups.read,rooms.read}'],
      );
      const caller: V2Caller = { schoolId: s, keyId: key.id, scopes: new Set(['organisations.read', 'groups.read', 'rooms.read'] as Scope[]) };
      const v2 = new Ss12000V2Service(api);
      const organisations = (await v2.listOrganisations(caller, {})).data;
      assert.deepEqual(
        organisations.map((o) => [o.id, o['organisationType'], o['schoolUnitCode'], o['displayName']]).sort(),
        [
          [sourceOrg, 'Skolenhet', '11111111', 'SE F–6'],
          [u79, 'Skolenhet', '22222222', 'SE 7–9'],
        ].sort(),
      );
      assert.deepEqual((await v2.getGroup(caller, c7.id, {}))['organisation'], { id: u79 });
      assert.deepEqual((await v2.getRoom(caller, room.id, {}))['owner'], { id: sourceOrg });
    });

    await check('(se5) the apply creates a unit from the source as the admin; the sync principal\'s slice reads the units, locks none', async () => {
      const created = 'aaaaaaaa-0000-4000-8000-0000000005e2';
      const outcome = await api.withRls(asAdmin, (tx) =>
        applyChanges(
          tx,
          s,
          [{ id: randomUUID(), seq: 0, entity: 'ORGANISATION', op: 'CREATE', externalId: created, localId: null, after: { name: 'SE Fritids', code: '33333333', schoolTypes: ['FTH'], gradeFrom: null, gradeTo: null } }],
          new Date(),
        ),
      );
      assert.equal(outcome.applied.length, 1, JSON.stringify(outcome.skipped));
      const row = await one<{ name: string; ss12000Id: string }>(`SELECT name, "ss12000Id" FROM "SchoolUnits" WHERE "schoolId" = $1 AND code = '33333333'`, [s]);
      assert.deepEqual(row, { name: 'SE Fritids', ss12000Id: created });
      const slice = await api.withSyncPrincipal(s, (tx) => readLocalSlice(tx, s, { lock: true }));
      assert.equal(slice.units?.length, 3);
    });

    await check('(se6) a removed unit is buried for /deletedEntities', async () => {
      await units.remove(u79, asAdmin);
      const buried = await one<{ n: string }>(
        `SELECT count(*)::text AS n FROM "Ss12000Tombstones" WHERE "schoolId" = $1 AND resource = 'Organisation' AND "emittedId" = $2`,
        [s, u79],
      );
      assert.equal(buried.n, '1');
    });
  } finally {
    await sweepSkolenheterSchool(owner, marker);
  }
}
