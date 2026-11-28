/**
 * Versionerna (E9) against a real database, as the API role under RLS, through the real services.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-versioner.ts
 *
 *   (ve-a) en version döps om av skolans administratör: namnet trimmas, ingenting annat i raden ändras (lektionerna, antalet, när den sparades);
 *   (ve-b) en annan skolas version syns inte för administratören: 404, och raden är orörd (RLS, inte en kontroll i tjänsten);
 *   (ve-c) ett namn som bara är blanksteg skrivs inte.
 *
 * It works in two schools of its own (slugs `probe-versioner-<n>`) and drops them.
 */
import { strict as assert } from 'node:assert';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';
import { ScheduleVersionNamesService } from '../../src/calendar/schedule-version-names.service';
import { ScheduleVersionsService } from '../../src/calendar/schedule-versions.service';
import { PrismaService } from '../../src/database/prisma.service';
import { plant, type World } from './probe-domaren';

const SLUG = 'probe-versioner';
const WORLD: World = {
  classes: [{ key: '7A', grade: 7 }],
  teachers: ['T1'],
  rooms: ['R1'],
  subjects: ['Matematik'],
  lessons: [{ key: 'L1', class: '7A', subject: 'Matematik', teacher: 'T1', room: 'R1', day: 1, start: '09:00', minutes: 60 }],
  unavailable: [],
  frames: [{ grades: [7, 9], start: '08:00', end: '15:00' }],
  meals: [],
};

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export async function versionerChecks(owner: Client, api: PrismaService, check: Check): Promise<void> {
  const names = new ScheduleVersionNamesService(api);
  const versions = new ScheduleVersionsService(api);
  const mine = `${SLUG}-0`;
  const theirs = `${SLUG}-1`;
  await owner.query(`DELETE FROM "Schools" WHERE slug = ANY($1)`, [[mine, theirs]]);
  try {
    const a = await plant(owner, mine, WORLD);
    const b = await plant(owner, theirs, WORLD);
    const own = await versions.create(a.year, 'Före vårjusteringar', a.caller);
    const other = await versions.create(b.year, 'Den andra skolans', b.caller);
    const rowOf = async (id: string) =>
      (await owner.query<{ name: string; count: number; lessons: unknown; saved: string }>(`SELECT name, "lessonCount" AS count, lessons, "createdAt"::text AS saved FROM "ScheduleVersions" WHERE id = $1`, [id])).rows[0]!;

    await check('(ve-a) the administrator renames a version of the school: the name is trimmed and nothing else in the row changes', async () => {
      const before = await rowOf(own.id);
      const renamed = await names.rename(own.id, '  Efter lovet  ', a.caller);
      assert.equal(renamed.name, 'Efter lovet');
      assert.equal(renamed.lessonCount, own.lessonCount);
      const after = await rowOf(own.id);
      assert.deepEqual({ ...after, name: undefined }, { ...before, name: undefined }, 'lessons, count and the time it was saved are the snapshot\'s and stay');
      assert.equal(after.name, 'Efter lovet');
      // The list says the new name.
      assert.deepEqual((await versions.list(a.year, a.caller)).map((version) => version.name), ['Efter lovet']);
    });

    await check('(ve-b) a version of another school is not there for the administrator: 404, and the row is untouched', async () => {
      const before = await rowOf(other.id);
      let refused: HttpException | undefined;
      try {
        await names.rename(other.id, 'Övertaget', a.caller);
      } catch (error) {
        refused = error as HttpException;
      }
      assert.equal(refused?.getStatus(), 404);
      assert.deepEqual(await rowOf(other.id), before);
    });

    await check('(ve-c) a name of blanks is not written', async () => {
      let refused: HttpException | undefined;
      try {
        await names.rename(own.id, '   ', a.caller);
      } catch (error) {
        refused = error as HttpException;
      }
      assert.equal(refused?.getStatus(), 400);
      assert.equal((await rowOf(own.id)).name, 'Efter lovet');
    });
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = ANY($1)`, [[mine, theirs]]);
  }
}

async function main() {
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  try {
    await versionerChecks(owner, api, async (name, run) => {
      try {
        await run();
        console.log(`  ok  ${name}`);
      } catch (error) {
        console.error(`  FAIL  ${name}`);
        throw error;
      }
    });
  } finally {
    await owner.end();
    await api.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
