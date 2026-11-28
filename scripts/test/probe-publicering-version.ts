/**
 * Versionen vid varje publicering (E9) against a real database, as the API role under RLS, through the real services.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-publicering-version.ts
 *
 *   (pv-a) POST /publications leaves a version of the grundschema as it was published, named by the window it is valid for as the log gives it
 *          ("Publicering 2026-11-30–2026-12-18"), with the lessons the grundschema had, in the transaction of the publication;
 *   (pv-b) the old POST /calendar/publish leaves one too, named by the window it materialised;
 *   (pv-b2) a publication whose version cannot be saved is not published at all, on either route: the version is written in the publication's own
 *          transaction, so a database that refuses the version row takes the log row and the lessons with it (not only the version is missing);
 *   (pv-c) a publication a check the school set to REFUSE stops is logged and leaves NO version (the version is rolled back with the transaction that
 *          would have published): the log has the refusal, the version list is as it was;
 *   (pv-d) a restore of a version tells the staff room that the master timetable changed (the event carries no lesson ids: the client reads the year),
 *          once and after the restore has committed, and a restore that fails tells nobody.
 *
 * It works in a school of its own (slug `probe-publicering-version-<n>`) and drops it.
 */
import { strict as assert } from 'node:assert';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';
import { CalendarService } from '../../src/calendar/calendar.service';
import { ScheduleVersionAnnouncer } from '../../src/calendar/schedule-version-announcer';
import { ScheduleVersionNamesService } from '../../src/calendar/schedule-version-names.service';
import { ScheduleVersionsController } from '../../src/calendar/schedule-versions.controller';
import { ScheduleVersionsService } from '../../src/calendar/schedule-versions.service';
import { PrismaService } from '../../src/database/prisma.service';
import { PublicationsService } from '../../src/publication/publications.service';
import { StaffingLoadService } from '../../src/staffing/staffing-load.service';
import { TimplanCoverageService } from '../../src/timplan/timplan-coverage.service';
import { plant, type World } from './probe-domaren';

const SLUG = 'probe-publicering-version';
const FROM = '2026-11-30';
const TO = '2026-12-18';

/** Two lessons of one class; L2 has no room, which a check set to REFUSE can stop a publication for. */
const WORLD: World = {
  classes: [{ key: '7A', grade: 7 }],
  teachers: ['T1', 'T2'],
  rooms: ['R1'],
  subjects: ['Matematik', 'Kemi'],
  lessons: [
    { key: 'L1', class: '7A', subject: 'Matematik', teacher: 'T1', room: 'R1', day: 1, start: '09:00', minutes: 60 },
    { key: 'L2', class: '7A', subject: 'Kemi', teacher: 'T2', day: 2, start: '10:00', minutes: 60 },
  ],
  unavailable: [],
  frames: [{ grades: [7, 9], start: '08:00', end: '15:00' }],
  meals: [],
};

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export async function publiceringVersionChecks(owner: Client, api: PrismaService, check: Check): Promise<void> {
  const told: Array<{ schoolId: string; options?: unknown }> = [];
  const realtime = { notifyMasterTimetableChanged: (schoolId: string, options?: unknown) => void told.push({ schoolId, options }) };
  const notifications = { recipientsForLessons: async () => [], notifyUsers: async () => 0 };
  const versions = new ScheduleVersionsService(api);
  const publications = new PublicationsService(api, new CalendarService(api), new TimplanCoverageService(api), new StaffingLoadService(api), notifications as never, realtime as never, versions);
  const slug = `${SLUG}-0`;
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [slug]);
  try {
    const a = await plant(owner, slug, WORLD);
    const versionsOf = async () =>
      (await owner.query<{ id: string; name: string; count: number; lessons: Array<{ subjectId: string; dayOfWeek: number; startTime: string }> }>(
        `SELECT id, name, "lessonCount" AS count, lessons FROM "ScheduleVersions" WHERE "academicYearId" = $1 ORDER BY "createdAt", id`,
        [a.year],
      )).rows;
    const shape = (rows: Array<{ subjectId: string; dayOfWeek: number; startTime: string }>) => rows.map((row) => `${row.subjectId}|${row.dayOfWeek}|${row.startTime.slice(0, 5)}`).sort();

    await check('(pv-a) a publication leaves a version of the grundschema as it was published, named by the window', async () => {
      assert.deepEqual(await versionsOf(), []);
      const outcome = await publications.publish({ academicYearId: a.year, validFrom: FROM, validTo: TO, acknowledgeWarnings: true }, a.caller);
      assert.equal(outcome.publication.outcome, 'PUBLISHED');
      const [version, ...rest] = await versionsOf();
      assert.equal(rest.length, 0, 'one publication, one version');
      assert.equal(version!.name, `Publicering ${outcome.publication.validFrom}–${outcome.publication.validTo}`);
      assert.equal(version!.name, `Publicering ${FROM}–${TO}`);
      const grundschema = (await owner.query<{ subjectId: string; dayOfWeek: number; startTime: string }>(`SELECT "subjectId", "dayOfWeek", to_char("startTime", 'HH24:MI') AS "startTime" FROM "MasterLessons" WHERE "academicYearId" = $1`, [a.year])).rows;
      assert.equal(version!.count, grundschema.length);
      assert.deepEqual(shape(version!.lessons), shape(grundschema), 'the version holds the lessons that were published');
    });

    await check('(pv-b) the old route leaves one too, named by the window it materialised', async () => {
      const result = await publications.legacyPublish({ academicYearId: a.year, fromDate: FROM, toDate: TO }, a.caller);
      const all = await versionsOf();
      assert.equal(all.length, 2);
      assert.equal(all[1]!.name, `Publicering ${result.fromDate}–${result.toDate}`);
    });

    await check('(pv-b2) a publication whose version cannot be saved is not published at all, on either route', async () => {
      // The owner makes the database refuse the version row of this school. The version is in the publication's own transaction, so what the publication wrote
      // before it (the log row, the dated lessons) goes with it; a version taken after the publication has committed would leave them standing.
      const count = async (sql: string): Promise<number> => Number((await owner.query<{ n: string }>(sql, [a.school])).rows[0]!.n);
      const standing = async () => ({
        publications: await count(`SELECT count(*) AS n FROM "TimetablePublications" WHERE "schoolId" = $1`),
        lessons: await count(`SELECT count(*) AS n FROM "CalendarLessons" WHERE "schoolId" = $1`),
        versions: await count(`SELECT count(*) AS n FROM "ScheduleVersions" WHERE "schoolId" = $1`),
      });
      await owner.query(`CREATE OR REPLACE FUNCTION probe_publicering_version_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'the version row is refused'; END $$`);
      await owner.query(`CREATE TRIGGER probe_publicering_version_refuse BEFORE INSERT ON "ScheduleVersions" FOR EACH ROW EXECUTE FUNCTION probe_publicering_version_refuse()`);
      try {
        const before = await standing();
        await assert.rejects(publications.publish({ academicYearId: a.year, validFrom: '2027-01-11', validTo: '2027-01-15', acknowledgeWarnings: true }, a.caller), /version row is refused/);
        assert.deepEqual(await standing(), before, 'POST /publications: the refused version took the publication and its lessons with it');
        await assert.rejects(publications.legacyPublish({ academicYearId: a.year, fromDate: '2027-01-18', toDate: '2027-01-22' }, a.caller), /version row is refused/);
        assert.deepEqual(await standing(), before, 'the old route: the refused version took the publication and its lessons with it');
      } finally {
        await owner.query(`DROP TRIGGER IF EXISTS probe_publicering_version_refuse ON "ScheduleVersions"`);
        await owner.query(`DROP FUNCTION IF EXISTS probe_publicering_version_refuse()`);
      }
    });

    await check('(pv-c) a publication that a check set to REFUSE stops is logged and leaves no version', async () => {
      await owner.query(`INSERT INTO "PublicationSettings" ("schoolId", "gateMissingRoom", "updatedAt") VALUES ($1, 'REFUSE', now()) ON CONFLICT ("schoolId") DO UPDATE SET "gateMissingRoom" = 'REFUSE'`, [a.school]);
      const before = (await versionsOf()).length;
      const logged = async () => Number((await owner.query<{ n: string }>(`SELECT count(*) AS n FROM "TimetablePublications" WHERE "academicYearId" = $1 AND outcome = 'REFUSED'`, [a.year])).rows[0]!.n);
      const refusals = await logged();
      let refused: HttpException | undefined;
      try {
        await publications.publish({ academicYearId: a.year, validFrom: FROM, validTo: TO, acknowledgeWarnings: true }, a.caller);
      } catch (error) {
        refused = error as HttpException;
      }
      assert.equal(refused?.getStatus(), 409);
      assert.equal((refused?.getResponse() as { code?: string }).code, 'PUBLISH_GATES_REFUSED');
      assert.equal((await versionsOf()).length, before, 'the refusal left no version');
      assert.equal(await logged(), refusals + 1, 'the refusal is in the log');
    });

    await check('(pv-d) a restore tells the staff room once it has committed, everyone in the direct mode and the administrators in the draft mode, and a restore that fails tells nobody', async () => {
      const controller = new ScheduleVersionsController(versions, new ScheduleVersionNamesService(api), new ScheduleVersionAnnouncer(api, realtime as never));
      const [version] = await versionsOf();
      told.length = 0;
      const restored = await controller.restore(version!.id, a.caller);
      assert.equal(restored.restoredLessons, version!.count);
      assert.deepEqual(told, [{ schoolId: a.school, options: {} }]);
      // The draft mode: the grundschema is the draft, and only the administrators are told.
      await owner.query(`UPDATE "PublicationSettings" SET "publishMode" = 'DRAFT' WHERE "schoolId" = $1`, [a.school]);
      told.length = 0;
      await controller.restore(version!.id, a.caller);
      assert.deepEqual(told, [{ schoolId: a.school, options: { draft: true } }]);
      // A restore that is refused (a version that is not there) tells nobody.
      told.length = 0;
      let refused: HttpException | undefined;
      try {
        await controller.restore('00000000-0000-4000-8000-000000000000', a.caller);
      } catch (error) {
        refused = error as HttpException;
      }
      assert.equal(refused?.getStatus(), 404);
      assert.deepEqual(told, []);
    });
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [slug]);
  }
}

async function main() {
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  try {
    await publiceringVersionChecks(owner, api, async (name, run) => {
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
