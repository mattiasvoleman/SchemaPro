/**
 * Optimeringsprofilen (P5) against a real database, as the API role under RLS, through the real service.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=2' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-optimeringsprofil.ts
 *
 * The jest specs hold the rules (src/optimization/optimization-profile.spec.ts) and the route's guards (test/optimization-profile.e2e-spec.ts)
 * with the database faked, and the RLS suite (section 601) holds the arms. What they cannot see is the service's own statements against the
 * table through the adapter: that the first save makes the row and a later one replaces it, that a school reads its own and no other's,
 * and that the profiles that do not write Schemaläggning are refused by the database and leave the row as it was.
 *
 *   (a) a school with no row reads the defaults, stored: false;
 *   (b) the first save makes the row, a second replaces the five weights in the same row, and a read gives them back;
 *   (c) another school reads its own defaults, and its save changes nothing of the first school's;
 *   (d) the expedition and a läsare are refused a save by the database and the row is as it was; a läsare reads what a full administrator reads;
 *   (e) a profile of 0 and 1000 is a profile (the DTO's bounds are the table's).
 *
 * Its schools are its own (slug probe-profil-*), made and dropped by the probe.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { createPgAdapter } from '../../src/database/pool-config';
import { PrismaService } from '../../src/database/prisma.service';
import { DEFAULT_PROFILE_WEIGHTS } from '../../src/optimization/optimization-profile';
import { OptimizationProfileService } from '../../src/optimization/optimization-profile.service';

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

const MARKER = 'probe-profil';
type Profile = 'FULL' | 'SCHEMALAGGARE' | 'EXPEDITION' | 'LASARE';

async function school(owner: PrismaClient, key: string): Promise<{ schoolId: string; as: Record<Profile, AuthenticatedUser> }> {
  const slug = `${MARKER}-${key}`;
  await owner.school.deleteMany({ where: { slug } });
  const made = await owner.school.create({ data: { name: slug, slug, timezone: 'Europe/Stockholm' } });
  const as = {} as Record<Profile, AuthenticatedUser>;
  for (const profile of ['FULL', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE'] as const) {
    const row = await owner.user.create({
      data: { schoolId: made.id, authId: randomUUID(), role: 'SCHOOL_ADMIN', adminProfile: profile, firstName: profile, lastName: 'Profil', email: `${profile.toLowerCase()}-${slug}@probe.example.com` },
    });
    as[profile] = { authId: row.authId, userId: row.id, schoolId: made.id, role: Role.SCHOOL_ADMIN, adminProfile: profile, hrRead: false, channel: 'OTHER' };
  }
  return { schoolId: made.id, as };
}

const WEIGHTS = { preferredFree: 20, preferredBusy: 1, disruption: 9, spread: 4, teacherGap: 3 };

async function main(): Promise<void> {
  const owner = new PrismaClient({ adapter: createPgAdapter(requiredEnv('PROBE_OWNER_URL')) });
  const previous = process.env['DATABASE_URL'];
  const api = new PrismaService();
  process.env['DATABASE_URL'] = previous;
  const service = new OptimizationProfileService(api);
  const rows = (schoolId: string) => owner.optimizationProfile.findMany({ where: { schoolId } });

  await owner.school.deleteMany({ where: { slug: { startsWith: `${MARKER}-` } } });
  try {
    const first = await school(owner, 'a');
    const second = await school(owner, 'b');

    await check('(a) a school with no row reads the defaults, and nothing is written by reading', async () => {
      assert.deepEqual(await service.read(first.as.FULL), { weights: DEFAULT_PROFILE_WEIGHTS, stored: false, updatedAt: null });
      assert.equal((await rows(first.schoolId)).length, 0);
    });

    await check('(b) the first save makes the row, a second replaces the five weights in it, and a read gives them back', async () => {
      const saved = await service.save(WEIGHTS, first.as.SCHEMALAGGARE);
      assert.deepEqual([saved.weights, saved.stored], [WEIGHTS, true]);
      assert.ok(saved.updatedAt);
      const again = await service.save({ ...WEIGHTS, spread: 30, teacherGap: 0 }, first.as.FULL);
      assert.deepEqual(again.weights, { ...WEIGHTS, spread: 30, teacherGap: 0 });
      assert.equal((await rows(first.schoolId)).length, 1, 'one row a school');
      assert.deepEqual((await service.read(first.as.FULL)).weights, { ...WEIGHTS, spread: 30, teacherGap: 0 });
    });

    await check('(c) another school reads its own defaults, and its save changes nothing of the first school\'s', async () => {
      assert.deepEqual((await service.read(second.as.FULL)).weights, DEFAULT_PROFILE_WEIGHTS);
      await service.save({ ...WEIGHTS, disruption: 77 }, second.as.FULL);
      assert.equal((await service.read(first.as.FULL)).weights.disruption, 9);
      assert.equal((await service.read(second.as.FULL)).weights.disruption, 77);
    });

    await check('(d) the expedition and a läsare are refused a save by the database, and the row is as it was', async () => {
      const before = (await service.read(first.as.FULL)).weights;
      for (const profile of ['EXPEDITION', 'LASARE'] as const) {
        await assert.rejects(service.save({ ...WEIGHTS, spread: 1 }, first.as[profile]), `${profile} was refused`);
      }
      assert.deepEqual((await service.read(first.as.FULL)).weights, before);
      // A school that has no row yet: the refusal is of the insert, and no row appears.
      const fresh = await school(owner, 'c');
      await assert.rejects(service.save(WEIGHTS, fresh.as.LASARE));
      assert.equal((await rows(fresh.schoolId)).length, 0);
      assert.deepEqual(await service.read(first.as.LASARE), await service.read(first.as.FULL));
    });

    await check('(e) 0 and 1000 are weights', async () => {
      const edge = { preferredFree: 0, preferredBusy: 1000, disruption: 0, spread: 1000, teacherGap: 0 };
      assert.deepEqual((await service.save(edge, first.as.FULL)).weights, edge);
      assert.deepEqual((await service.read(first.as.FULL)).weights, edge);
    });
  } finally {
    await owner.school.deleteMany({ where: { slug: { startsWith: `${MARKER}-` } } }).catch((error) => console.error('sweep:', error));
    await api.$disconnect();
    await owner.$disconnect();
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\noptimeringsprofil probe passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
