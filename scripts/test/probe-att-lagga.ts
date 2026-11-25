/**
 * Att lägga (E4): the grundschema's tray against a real database, as the API role under RLS, through the real services.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-att-lagga.ts
 *
 *   (al-a) the tray's figure for every post is the week of förläggningars own (boardOfYear: demandLeftOf through boardPostOf) for a year where nothing
 *          stands but the lessons Generera keeps: one function, two readers;
 *   (al-b) what stands on the grundschema answers a lesson, the lessons Generera laid and nobody locked as well; a lesson on the tray answers none; a
 *          förläggning answers one and is said apart;
 *   (al-c) another school's year is no year of this school (404), and a school's tray names nobody.
 *
 * It works in schools of its own (slug `probe-att-lagga-<n>`) and drops them.
 */
import { strict as assert } from 'node:assert';
import { NotFoundException } from '@nestjs/common';
import { Client } from 'pg';
import { BoardTrayService } from '../../src/board-tray/board-tray.service';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { PrismaService } from '../../src/database/prisma.service';
import { RequirementPlacementsService } from '../../src/requirement-placements/requirement-placements.service';
import { plant, type World } from './probe-domaren';

const SLUG = 'probe-att-lagga';

const WORLD: World = {
  classes: [{ key: '7A', grade: 7 }, { key: '7B', grade: 7 }],
  teachers: ['T1', 'T2'],
  rooms: ['R1'],
  subjects: ['Matematik', 'Kemi', 'Musik'],
  lessons: [
    // Matematik 7A: one of its three lessons is locked by hand.
    { key: 'M1', class: '7A', subject: 'Matematik', teacher: 'T1', room: 'R1', day: 1, start: '09:00', minutes: 60 },
  ],
  unavailable: [],
  frames: [{ grades: [7, 9], start: '08:00', end: '15:00' }],
  meals: [],
};

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export async function attLaggaChecks(owner: Client, api: PrismaService, check: Check): Promise<void> {
  const realtime = { notifyMasterTimetableChanged: () => undefined };
  const notifications = { recipientsForLessons: async () => [], notifyUsers: async () => undefined };
  const masters = new MasterLessonsService(api, realtime as never, notifications as never);
  const tray = new BoardTrayService(api);
  const week = new RequirementPlacementsService(api, masters);
  const slugs = [`${SLUG}-0`, `${SLUG}-1`];
  const cleanup = async () => {
    for (const slug of slugs) await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [slug]);
  };
  await cleanup();
  try {
    const a = await plant(owner, slugs[0]!, WORLD);
    const b = await plant(owner, slugs[1]!, { ...WORLD, lessons: [] });
    const post = async (cls: string, subject: string, teacher: string, lessons: number, minutes: number) =>
      (
        await owner.query<{ id: string }>(
          `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", recurrence, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'ALL_WEEKS'::"LessonRecurrence", now()) RETURNING id`,
          [a.school, a.year, a.subjectId.get(subject), a.classId.get(cls), a.teacherId.get(teacher), lessons, minutes],
        )
      ).rows[0]!.id;
    const pMath = await post('7A', 'Matematik', 'T1', 3, 60);
    const pKem = await post('7A', 'Kemi', 'T2', 2, 45);
    const pMusik = await post('7B', 'Musik', 'T2', 1, 40);
    const leftOf = (response: Awaited<ReturnType<BoardTrayService['trayOfYear']>>, postId: string) => response.bricks.filter((brick) => brick.postId === postId).length;

    await check('(al-a) the tray\'s figure for each post is the week of förläggningars own: one function, two readers', async () => {
      const bricks = await tray.trayOfYear(a.year, undefined, a.caller);
      const board = await week.boardOfYear(a.year, a.caller);
      for (const post of board.posts) {
        const boardLeft = post.parts.reduce((sum, part) => sum + part.left, 0);
        assert.equal(leftOf(bricks, post.id), boardLeft, `the post ${post.id}: ${leftOf(bricks, post.id)} bricks, the week of förläggningar says ${boardLeft} left`);
      }
      assert.deepEqual([leftOf(bricks, pMath), leftOf(bricks, pKem), leftOf(bricks, pMusik)], [2, 2, 1], 'Matematik 7A has one lesson locked by hand');
      assert.deepEqual(bricks.tally, { lessons: 6, laid: 1, placedByRow: 0, left: 5 });
    });

    await check('(al-b) a lesson standing on the grundschema answers one, free or locked; a lesson on the tray answers none; a förläggning answers one and is said apart', async () => {
      // Generera laid a Kemi lesson and nobody has locked it: it stands on the board, so its brick is gone.
      const free = (
        await owner.query<{ id: string }>(
          `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 3, '10:00', '10:45', false, true, now()) RETURNING id`,
          [a.school, a.year, a.subjectId.get('Kemi'), a.classId.get('7A'), a.teacherId.get('T2')],
        )
      ).rows[0]!.id;
      assert.equal(leftOf(await tray.trayOfYear(a.year, undefined, a.caller), pKem), 1);
      // On the tray it occupies nothing and the brick is back.
      await owner.query(`UPDATE "MasterLessons" SET "isParked" = true WHERE id = $1`, [free]);
      assert.equal(leftOf(await tray.trayOfYear(a.year, undefined, a.caller), pKem), 2);
      await owner.query(`UPDATE "MasterLessons" SET "isParked" = false WHERE id = $1`, [free]);
      // A förläggning of Musik 7B answers its one lesson: no brick, and the tally says it was a row.
      await owner.query(`INSERT INTO "TeachingRequirementPlacements" ("schoolId", "requirementId", "dayOfWeek", "startTime", minutes, recurrence, "updatedAt") VALUES ($1, $2, 4, '11:00', 40, 'ALL_WEEKS'::"LessonRecurrence", now())`, [a.school, pMusik]);
      const after = await tray.trayOfYear(a.year, undefined, a.caller);
      assert.equal(leftOf(after, pMusik), 0);
      assert.deepEqual(after.tally, { lessons: 6, laid: 2, placedByRow: 1, left: 3 });
      // One class's bricks, the year's tally.
      const only7B = await tray.trayOfYear(a.year, a.classId.get('7B'), a.caller);
      assert.equal(only7B.bricks.length, 0);
      assert.deepEqual(only7B.tally, after.tally);
      assert.deepEqual(after.groups.find((entry) => entry.studentGroupId === a.classId.get('7A')), { studentGroupId: a.classId.get('7A'), left: 3 });
    });

    await check('(al-c) another school\'s year is no year of this school, and the tray names nobody', async () => {
      await assert.rejects(tray.trayOfYear(b.year, undefined, a.caller), (error: unknown) => error instanceof NotFoundException);
      const own = await tray.trayOfYear(a.year, undefined, a.caller);
      assert.ok(!/firstName|lastName|email|@example/.test(JSON.stringify(own)), 'a person is named');
    });
  } finally {
    await cleanup();
  }
}

async function main() {
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  try {
    await attLaggaChecks(owner, api, async (name, run) => {
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
