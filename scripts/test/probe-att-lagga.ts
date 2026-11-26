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
 *   (al-c) another school's year is no year of this school (404), and a school's tray names nobody;
 *   (al-d) the tray's figure for every post is what Generera's own pre-flight (prepareSchedule) sends for it: uniform, split, shared, odd weeks, a term,
 *          a medlärare, a lesson kept for a second class, a förläggning with a room (a lock) and one without (a pinned lesson, which takes nothing
 *          off what Generera sends), a parallel block with a lesson placed, and one lesson Generera laid and nobody locked (the one difference).
 *
 * It works in schools of its own (slug `probe-att-lagga-<n>`) and drops them.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { HttpService } from '@nestjs/axios';
import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { BoardTrayService } from '../../src/board-tray/board-tray.service';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { PrismaService } from '../../src/database/prisma.service';
import { OptimizationProxyService } from '../../src/optimization/optimization-proxy.service';
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
  const slugs = [`${SLUG}-0`, `${SLUG}-1`, `${SLUG}-2`];
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

    await check('(al-d) the tray\'s figure for every post is what Generera\'s own pre-flight sends for it, the pinned lessons and the one standing lesson Generera would delete apart', async () => {
      const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
      const school = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $1, 'Europe/Stockholm', now()) RETURNING id`, [slugs[2]])).id;
      const year = (
        await one<{ id: string }>(
          `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt") VALUES ($1, 'al-d', '2098-08-16', '2099-06-11', true, 'NIOARIG', now()) RETURNING id`,
          [school],
        )
      ).id;
      const person = async (label: string, role: string, adminProfile?: string) => {
        const authId = randomUUID();
        const row = await one<{ id: string }>(
          `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "adminProfile", "updatedAt") VALUES ($1, $2, $3, 'AlD', $4, $5, true, $6, now()) RETURNING id`,
          [school, `${slugs[2]}-${label}@example.invalid`, label, role, authId, adminProfile ?? null],
        );
        return { id: row.id, authId };
      };
      const admin = await person('admin', 'SCHOOL_ADMIN', 'SCHEMALAGGARE');
      const caller = { authId: admin.authId, userId: admin.id, schoolId: school, role: 'SCHOOL_ADMIN', adminProfile: 'SCHEMALAGGARE', channel: 'WEB', hrRead: false } as never;
      const [anna, bo, cia] = [await person('anna', 'TEACHER'), await person('bo', 'TEACHER'), await person('cia', 'TEACHER')];
      const room = (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, 'AlD sal', now()) RETURNING id`, [school])).id;
      const group = async (name: string) =>
        (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', 7, now()) RETURNING id`, [school, year, name])).id;
      const [gA, gB] = [await group('AlD A'), await group('AlD B')];
      const subject = async (name: string) => (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [school, name])).id;
      type Opts = { teacher: string; lessons: number; minutes: number; lengths?: number[]; co?: string; recurrence?: string; start?: string; end?: string; group?: string; block?: string };
      const post = async (name: string, o: Opts) => {
        const subjectId = await subject(name);
        const id = (
          await one<{ id: string }>(
            `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "coTeacherId", "lessonsPerWeek", "minutesPerLesson", "lessonLengths", recurrence, "startDate", "endDate", "blockId", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::int[], $10::"LessonRecurrence", $11, $12, $13, now()) RETURNING id`,
            [school, year, subjectId, o.group ?? gA, o.teacher, o.co ?? null, o.lessons, o.minutes, o.lengths ?? [], o.recurrence ?? 'ALL_WEEKS', o.start ?? null, o.end ?? null, o.block ?? null],
          )
        ).id;
        return { id, subjectId };
      };
      const lesson = async (subjectId: string, groupId: string, teacher: string, day: number, start: string, end: string, o: { locked?: boolean; generated?: boolean; recurrence?: string; start?: string; end?: string } = {}) =>
        (
          await one<{ id: string }>(
            `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", recurrence, "startDate", "endDate", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::"LessonRecurrence", $12, $13, now()) RETURNING id`,
            [school, year, subjectId, groupId, teacher, day, start, end, o.locked ?? true, o.generated ?? false, o.recurrence ?? 'ALL_WEEKS', o.start ?? null, o.end ?? null],
          )
        ).id;
      const row = (postId: string, day: number, start: string, minutes: number, roomId: string | null, recurrence = 'ALL_WEEKS') =>
        owner.query(`INSERT INTO "TeachingRequirementPlacements" ("schoolId", "requirementId", "dayOfWeek", "startTime", minutes, "roomId", recurrence, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7::"LessonRecurrence", now())`, [school, postId, day, start, minutes, roomId, recurrence]);

      const uni = await post('AlD Uni', { teacher: anna.id, lessons: 3, minutes: 60 });
      await lesson(uni.subjectId, gA, anna.id, 1, '09:00', '10:00');
      const split = await post('AlD Split', { teacher: anna.id, lessons: 2, minutes: 80, lengths: [80, 40] });
      await lesson(split.subjectId, gA, anna.id, 1, '10:15', '10:55');
      const shared = await post('AlD Shared', { teacher: anna.id, lessons: 3, minutes: 60 });
      await owner.query(`INSERT INTO "TeachingRequirementShares" ("schoolId", "requirementId", "teacherId", lessons, minutes, "updatedAt") VALUES ($1, $2, $3, 1, 60, now())`, [school, shared.id, bo.id]);
      await lesson(shared.subjectId, gA, bo.id, 2, '09:00', '10:00');
      const odd = await post('AlD Odd', { teacher: bo.id, lessons: 2, minutes: 60, recurrence: 'ODD_WEEKS' });
      await lesson(odd.subjectId, gA, bo.id, 2, '10:15', '11:15', { recurrence: 'ODD_WEEKS' });
      const term = await post('AlD Term', { teacher: bo.id, lessons: 2, minutes: 60, start: '2099-01-11', end: '2099-06-11' });
      await lesson(term.subjectId, gA, bo.id, 3, '09:00', '10:00', { start: '2099-01-11', end: '2099-06-11' });
      const termWrong = await post('AlD Term2', { teacher: bo.id, lessons: 2, minutes: 60, start: '2099-01-11', end: '2099-06-11' });
      // A lesson of the autumn does not run the spring's weeks: it answers none of them.
      await lesson(termWrong.subjectId, gA, bo.id, 3, '10:15', '11:15', { start: '2098-08-16', end: '2098-12-19' });
      const cot = await post('AlD Cot', { teacher: anna.id, lessons: 2, minutes: 60, co: cia.id });
      const extra = await post('AlD Extra', { teacher: bo.id, lessons: 3, minutes: 60, group: gB });
      const extraLesson = await lesson(extra.subjectId, gB, bo.id, 3, '10:15', '11:15');
      await owner.query(`INSERT INTO "MasterLessonGroups" ("schoolId", "masterLessonId", "studentGroupId") VALUES ($1, $2, $3)`, [school, extraLesson, gA]);
      const free = await post('AlD Free', { teacher: cia.id, lessons: 2, minutes: 60, group: gB });
      await lesson(free.subjectId, gB, cia.id, 4, '09:00', '10:00', { locked: false, generated: true });
      const withRoom = await post('AlD Row', { teacher: cia.id, lessons: 2, minutes: 60 });
      await row(withRoom.id, 5, '08:00', 60, room);
      const pinned = await post('AlD Pin', { teacher: cia.id, lessons: 2, minutes: 60 });
      await row(pinned.id, 5, '09:00', 60, null);
      const blockId = (await one<{ id: string }>(`INSERT INTO "TeachingBlocks" ("schoolId", "academicYearId", name, "updatedAt") VALUES ($1, $2, 'AlD block', now()) RETURNING id`, [school, year])).id;
      const memberA = await post('AlD Språk', { teacher: anna.id, lessons: 3, minutes: 60, block: blockId });
      const memberB = await post('AlD Språk B', { teacher: bo.id, lessons: 3, minutes: 60, group: gB, block: blockId });
      await owner.query(`INSERT INTO "TeachingBlockPlacements" ("schoolId", "blockId", "academicYearId", "dayOfWeek", "startTime", minutes, "updatedAt") VALUES ($1, $2, $3, 5, '10:00', 60, now())`, [school, blockId, year]);

      const response = await tray.trayOfYear(year, undefined, caller);
      const bricksOf = (postId: string) => response.bricks.filter((brick) => brick.postId === postId).length;
      const config = { getOrThrow: () => ({ baseUrl: 'http://127.0.0.1:1', apiKey: 'x', timeoutMs: 1000 }) } as unknown as ConfigService;
      const http = { post: () => { throw new Error('the pre-flight wakes no engine'); } } as unknown as HttpService;
      const proxy = new OptimizationProxyService(api, http, config, masters) as unknown as { prepareSchedule: (tx: unknown, year: string, user: unknown) => Promise<{ ready: boolean; demand?: Array<{ requirementId: string; lessonsPerWeek: number }>; refusalCode?: string }> };
      const sent = await api.withRls(caller, (tx) => proxy.prepareSchedule(tx, year, caller));
      assert.equal(sent.ready, true, `Generera's pre-flight goes through (${sent.refusalCode ?? ''})`);
      const sentOf = new Map((sent.demand ?? []).map((entry) => [entry.requirementId, entry.lessonsPerWeek]));
      // The tray, what Generera sends, and what they differ by: a pinned lesson (a förläggning with no room, and every lesson of a placed block) stays in what
      // Generera sends and is a lesson laid on the tray; the one lesson Generera laid and nobody locked is deleted by Generera before it counts and stands on the tray.
      const cases: Array<[string, string, number, number, number]> = [
        // name, post, bricks, pinned, standing free
        ['uniform with a lock', uni.id, 2, 0, 0],
        ['split 80 + 40 with a lock of 40', split.id, 1, 0, 0],
        ['shared, Bo\'s own lock answers Bo\'s lesson', shared.id, 2, 0, 0],
        ['odd weeks with a lock of odd weeks', odd.id, 1, 0, 0],
        ['a term with a lock that runs it', term.id, 1, 0, 0],
        ['a term with a lock of the autumn', termWrong.id, 2, 0, 0],
        ['a medlärare', cot.id, 2, 0, 0],
        ['a lesson kept for a second class', extra.id, 2, 0, 0],
        ['one lesson Generera laid and nobody locked', free.id, 1, 0, 1],
        ['a förläggning with a room (a lock)', withRoom.id, 1, 0, 0],
        ['a förläggning with no room (a pinned lesson)', pinned.id, 1, 1, 0],
        ['a block with a lesson placed, member A', memberA.id, 2, 1, 0],
        ['a block with a lesson placed, member B', memberB.id, 2, 1, 0],
      ];
      for (const [name, postId, bricks, pins, standing] of cases) {
        assert.equal(bricksOf(postId), bricks, `${name}: the tray's bricks`);
        assert.equal(sentOf.get(postId) ?? 0, bricks + pins + standing, `${name}: what Generera sends is the tray's bricks, the pinned lessons and the standing free lesson`);
      }
      // 31 lessons: seven answered by a lesson that stands (the autumn's lesson answers none of the spring's), four by a förläggning (a lock, a pin and the block's two).
      assert.deepEqual(response.tally, { lessons: 31, laid: 7, placedByRow: 4, left: 20 });
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
