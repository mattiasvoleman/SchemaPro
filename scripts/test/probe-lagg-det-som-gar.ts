/**
 * Lägg det som går (E7a), through the real services against a real database, as the API role under RLS:
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-lagg-det-som-gar.ts
 *
 * The school is the högstadium of scripts/fixtures/hogstadium-week.ts (six classes with two letters: parallel blocks, shared specialist rooms, a teacher's
 * closed hour), laid by a randomised greedy; lessons of the classes are taken out, which makes their bricks, and the fill puts them back.
 *
 *   (fp-a) a proposal writes nothing (no lesson, no version, no log row), says how many of the bricks asked about fitted and which did not, and names no one;
 *   (fp-b) every lesson it lays is one the judge lets through as a hand edit would be asked, with the lessons it laid before it standing (checked in the
 *          database after Ta in, against every rule, for every lesson it wrote), in a room the generator's rule allows, and none is given an exemption;
 *   (fp-c) Ta in writes exactly the proposal as locked lessons of the school's own, after a version, and no lesson that stood has moved or changed room;
 *   (fp-d) a grundschema that has changed since the proposal is refused (409 BOARD_FILL_STALE) and nothing is written, no version either;
 *   (fp-e) the scopes ask for what they name: marked bricks, a class, a year, the school; a brick named that is not one of the tray's is stale;
 *   (fp-f) a brick whose teacher is closed all week is left, "not laid by this" (NO_FREE_START), and the answer never says it cannot be laid;
 *   (fp-g) Direkt: a parked lesson with calendar rows among the bricks, in a published period the school has not answered about, refuses Ta in with
 *          DIRECT_REACH_UNANSWERED and writes nothing (no lesson moved, no version kept); once the school has answered, the same Ta in goes;
 *   (fp-h) the proposal's time over 12, 60 and every brick of the school, with the load beside it.
 *
 * A school of its own (slug probe-lagg-det-som-gar), dropped at the start and at the end.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { BoardFillService, type FillProposal } from '../../src/board-fill/board-fill.service';
import { BoardTrayService } from '../../src/board-tray/board-tray.service';
import { CalendarService } from '../../src/calendar/calendar.service';
import { judgeLessons } from '../../src/calendar/lesson-judge';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { PossibleTimesService } from '../../src/calendar/possible-times.service';
import { ScheduleVersionsService } from '../../src/calendar/schedule-versions.service';
import { PrismaService } from '../../src/database/prisma.service';
import { DirectReachService } from '../../src/publication/direct-reach.service';
import { PublicationsService } from '../../src/publication/publications.service';
import { StaffingLoadService } from '../../src/staffing/staffing-load.service';
import { TimplanCoverageService } from '../../src/timplan/timplan-coverage.service';
import { seedHogstadium } from '../fixtures/hogstadium-week';

const SLUG = 'probe-lagg-det-som-gar';
const uptime = (): string => execSync('uptime').toString().trim().replace(/^.*load averages?: /, 'load ');

async function main(): Promise<void> {
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  const sent: string[] = [];
  const realtime = { notifyMasterTimetableChanged: () => undefined } as never;
  const notifications = { recipientsForLessons: async () => [randomUUID()], notifyUsers: async (_tx: unknown, input: { type: string }) => (sent.push(input.type), 1) } as never;
  const masters = new MasterLessonsService(api, realtime, notifications);
  const tray = new BoardTrayService(api, masters);
  const versions = new ScheduleVersionsService(api);
  const possible = new PossibleTimesService(api, masters);
  const fill = new BoardFillService(api, tray, masters, possible, versions);
  fill.budgetMs = 120_000; // a probe on a loaded host is given all the time it needs: a failure of the host is no answer
  const calendar = new CalendarService(api);
  const publications = new PublicationsService(api, calendar, new TimplanCoverageService(api), new StaffingLoadService(api), notifications, realtime);
  const reach = new DirectReachService(api);

  let failures = 0;
  const check = async (label: string, body: () => Promise<void>) => {
    try {
      await body();
      console.log(`  ok  ${label}`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL  ${label}\n        ${error instanceof Error ? (error.stack ?? error.message).replace(/\n/g, '\n        ') : String(error)}`);
    }
  };
  const q = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;
  const refusal = async (promise: Promise<unknown>): Promise<{ status: number; code?: string; reason?: string }> => {
    try {
      await promise;
    } catch (error) {
      assert.ok(error instanceof HttpException, `not an HttpException: ${String(error)}`);
      const body = error.getResponse() as { code?: string; params?: { reason?: string } };
      return { status: error.getStatus(), code: body.code, reason: body.params?.reason };
    }
    throw new Error('the write was not refused');
  };

  try {
    const seeded = await seedHogstadium(owner, { slug: SLUG, letters: 'AB', pupils: 12 });
    const school = seeded.school;
    const year = seeded.year;
    const admin: AuthenticatedUser = { authId: seeded.adminAuth, role: Role.SCHOOL_ADMIN, userId: seeded.admin, schoolId: school, channel: 'WEB', adminProfile: 'FULL' as never, hrRead: false };

    const classIds = new Set(seeded.classes.map((entry) => entry.id));
    const counts = async () => ({
      lessons: Number((await q<{ n: string }>(`SELECT count(*) AS n FROM "MasterLessons" WHERE "academicYearId" = $1`, [year]))[0]!.n),
      versions: Number((await q<{ n: string }>(`SELECT count(*) AS n FROM "ScheduleVersions" WHERE "academicYearId" = $1`, [year]))[0]!.n),
      log: Number((await q<{ n: string }>(`SELECT count(*) AS n FROM "ScheduleChangeLogs" WHERE "schoolId" = $1`, [school]))[0]!.n),
    });
    const standing = async () =>
      (await q<{ id: string; dayOfWeek: number; startTime: string; roomId: string | null; isLocked: boolean; exemptFrom: string[] }>(`SELECT id, "dayOfWeek", "startTime"::text, "roomId", "isLocked", "exemptFrom" FROM "MasterLessons" WHERE "academicYearId" = $1 ORDER BY id`, [year]));
    /** Takes `count` of the classes' own lessons out of the grundschema (the owner deletes them: they become bricks). */
    const takeOut = async (count: number, seed: number): Promise<string[]> => {
      const own = (await q<{ id: string }>(`SELECT id FROM "MasterLessons" WHERE "academicYearId" = $1 AND "studentGroupId" = ANY($2::uuid[]) ORDER BY md5(id::text || $3::text)`, [year, [...classIds], String(seed)])).slice(0, count).map((row) => row.id);
      await owner.query(`DELETE FROM "MasterLessons" WHERE id = ANY($1::uuid[])`, [own]);
      return own;
    };
    const keysOf = (proposal: FillProposal) => [...proposal.placed.map((entry) => entry.key), ...proposal.left.map((entry) => entry.key)].sort();
    const itemsOf = (proposal: FillProposal) =>
      proposal.placed.map((entry) => ({ key: entry.key, dayOfWeek: entry.dayOfWeek, startTime: `${String(Math.floor(entry.startMinutes / 60)).padStart(2, '0')}:${String(entry.startMinutes % 60).padStart(2, '0')}`, roomId: entry.roomId }));

    await check('(fp-a) a proposal writes nothing, accounts for every brick it was asked about, and names no one', async () => {
      await takeOut(12, 1);
      const before = await counts();
      const started = Date.now();
      const proposal = await fill.propose({ academicYearId: year, scope: 'SCHOOL' }, admin);
      console.log(`        (fp-a) ${proposal.placed.length} of ${proposal.asked} laid in ${Date.now() - started} ms; ${uptime()}`);
      assert.deepEqual(await counts(), before, 'nothing was written');
      assert.equal(proposal.answeredBy, 'FILL');
      assert.ok(proposal.asked >= 12, 'the twelve lessons taken out are bricks (the blocks\' bricks are asked about too and left as blocks)');
      assert.equal(proposal.placed.length + proposal.left.length, proposal.asked, 'every brick is laid or left');
      assert.ok(proposal.placed.length >= 10, `the greedy puts back most of twelve: ${proposal.placed.length}`);
      assert.match(proposal.basis, /^[0-9a-f]{32}$/);
      assert.deepEqual(proposal.moved, []);
      for (const entry of proposal.left) assert.ok(['NO_FREE_START', 'JUDGE', 'TIME', 'BLOCK', 'NO_TEACHER'].includes(entry.reason), `a reason that says "not laid": ${entry.reason}`);
      assert.doesNotMatch(JSON.stringify(proposal), /firstName|lastName|email|går inte|cannot be laid|impossible/i);
    });

    await check('(fp-b, fp-c) Ta in writes exactly the proposal as locked lessons after a version, every one is let through by the judge, and nothing that stood moved', async () => {
      const proposal = await fill.propose({ academicYearId: year, scope: 'SCHOOL' }, admin);
      const before = await counts();
      const stood = await standing();
      const applied = await fill.apply({ academicYearId: year, basis: proposal.basis, items: itemsOf(proposal) }, admin);
      const after = await counts();
      assert.equal(after.lessons - before.lessons, proposal.placed.length, 'one lesson written for each lesson proposed');
      assert.equal(after.versions - before.versions, 1, 'one version, before the write');
      assert.equal(applied.laid.length, proposal.placed.length);
      const version = (await q<{ lessonCount: number; id: string }>(`SELECT "lessonCount", id FROM "ScheduleVersions" WHERE id = $1`, [applied.versionId]))[0]!;
      assert.equal(version.lessonCount, before.lessons, 'the version holds the grundschema as it was before the first write');
      const now = new Map((await standing()).map((row) => [row.id, row]));
      for (const row of stood) assert.deepEqual(now.get(row.id), row, 'a lesson that stood is as it was');
      const written = applied.laid.map((entry) => now.get(entry.lessonId)!);
      assert.ok(written.every((row) => row.isLocked && row.exemptFrom.length === 0), 'locked, and no exemption given');
      // The judge's word on each lesson written, as a fresh hand edit, with every other lesson (the fill's too) in the database.
      const rows = await q<{ id: string; studentGroupId: string; subjectId: string; teacherId: string | null; coTeacherId: string | null; roomId: string | null; dayOfWeek: number; start: number; end: number; recurrence: 'ALL_WEEKS' }>(
        `SELECT id, "studentGroupId", "subjectId", "teacherId", "coTeacherId", "roomId", "dayOfWeek", extract(hour from "startTime")*60 + extract(minute from "startTime") AS start, extract(hour from "endTime")*60 + extract(minute from "endTime") AS "end", recurrence FROM "MasterLessons" WHERE id = ANY($1::uuid[])`,
        [applied.laid.map((entry) => entry.lessonId)],
      );
      await api.withRls(admin, async (tx) => {
        const verdicts = await judgeLessons(
          tx,
          masters,
          { academicYearId: year, schoolId: school, basis: { kind: 'CURRENT' }, gradeNumbering: 'NIOARIG' },
          rows.map((row) => ({
            lesson: { id: row.id, studentGroupId: row.studentGroupId, subjectId: row.subjectId },
            candidate: { dayOfWeek: row.dayOfWeek, startMinutes: Number(row.start), endMinutes: Number(row.end), teacherId: row.teacherId, coTeacherId: row.coTeacherId, roomId: row.roomId, recurrence: row.recurrence },
            stands: null,
            excludeIds: [row.id],
          })),
        );
        const refused = verdicts.flatMap((verdict, index) => (verdict.ok ? [] : [`${rows[index]!.id}: ${verdict.refusals.map((r) => r.reason).join(',')}`]));
        assert.deepEqual(refused, [], 'every lesson the fill laid is one the judge lets through');
      });
      // The tray is what was left.
      const trayAfter = await tray.trayOfYear(year, undefined, admin);
      assert.equal(trayAfter.bricks.filter((brick) => classIds.has(brick.studentGroupId) && brick.cannotPlace === null).length, proposal.left.filter((entry) => entry.reason !== 'BLOCK' && entry.reason !== 'NO_TEACHER' && classIds.has(entry.studentGroupId)).length, 'the bricks left on the tray are the ones the fill left');
    });

    await check('(fp-d) a grundschema that changed since the proposal is refused, and nothing is written', async () => {
      await takeOut(6, 2);
      const proposal = await fill.propose({ academicYearId: year, scope: 'SCHOOL' }, admin);
      assert.ok(proposal.placed.length > 0);
      // Somebody moves a lesson, then the proposal is taken in.
      const [mover] = await q<{ id: string }>(`SELECT id FROM "MasterLessons" WHERE "academicYearId" = $1 AND "isParked" = false ORDER BY id LIMIT 1`, [year]);
      await owner.query(`UPDATE "MasterLessons" SET "updatedAt" = now() + interval '1 second' WHERE id = $1`, [mover!.id]);
      const before = await counts();
      const refused = await refusal(fill.apply({ academicYearId: year, basis: proposal.basis, items: itemsOf(proposal) }, admin));
      assert.deepEqual([refused.status, refused.code], [409, 'BOARD_FILL_STALE']);
      assert.deepEqual(await counts(), before, 'no lesson, no version, no log row');
    });

    await check('(fp-e) the scopes ask for what they name', async () => {
      const bricks = (await tray.trayOfYear(year, undefined, admin)).bricks;
      const ofClass = bricks.filter((brick) => classIds.has(brick.studentGroupId));
      assert.ok(ofClass.length >= 3, 'a few bricks of the classes are on the tray');
      const one = ofClass[0]!;
      const classAsked = await fill.propose({ academicYearId: year, scope: 'CLASS', studentGroupId: one.studentGroupId }, admin);
      assert.deepEqual(keysOf(classAsked), bricks.filter((brick) => brick.studentGroupId === one.studentGroupId).map((brick) => `${brick.postId}|${brick.teacherId ?? '-'}|${brick.minutes}|${brick.nth}`).sort());
      const marked = await fill.propose({ academicYearId: year, scope: 'BRICKS', bricks: ofClass.slice(0, 2).map((brick) => ({ postId: brick.postId, teacherId: brick.teacherId, minutes: brick.minutes, nth: brick.nth })) }, admin);
      assert.equal(marked.asked, 2);
      const grade = seeded.classes.find((entry) => entry.id === one.studentGroupId)!.grade;
      const gradeAsked = await fill.propose({ academicYearId: year, scope: 'GRADE', gradeLevel: grade }, admin);
      assert.ok(gradeAsked.asked >= classAsked.asked, 'the year holds the class');
      assert.equal((await fill.propose({ academicYearId: year, scope: 'GRADE', gradeLevel: 12 }, admin)).asked, 0, 'a year nobody is in has no bricks');
      const school_ = await fill.propose({ academicYearId: year, scope: 'SCHOOL' }, admin);
      assert.ok(school_.asked >= gradeAsked.asked);
      const wrongNth = await refusal(fill.propose({ academicYearId: year, scope: 'BRICKS', bricks: [{ postId: one.postId, teacherId: one.teacherId, minutes: one.minutes, nth: 99 }] }, admin));
      assert.deepEqual([wrongNth.status, wrongNth.code], [409, 'BOARD_FILL_STALE']);
    });

    await check('(fp-f) a brick whose teacher is closed all week is left as "not laid by this"', async () => {
      const [target] = (await tray.trayOfYear(year, undefined, admin)).bricks.filter((brick) => classIds.has(brick.studentGroupId) && brick.teacherId !== null);
      assert.ok(target, 'a brick with a teacher');
      for (const day of [1, 2, 3, 4, 5]) {
        await owner.query(
          `INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, "updatedAt") VALUES ($1, 'TEACHER', $2, $3, '07:00', '18:00', 'UNAVAILABLE', now())`,
          [school, target.teacherId, day],
        );
      }
      const proposal = await fill.propose({ academicYearId: year, scope: 'BRICKS', bricks: [{ postId: target.postId, teacherId: target.teacherId, minutes: target.minutes, nth: target.nth }] }, admin);
      assert.deepEqual([proposal.asked, proposal.placed.length, proposal.left.map((entry) => entry.reason)], [1, 0, ['NO_FREE_START']]);
      await owner.query(`DELETE FROM "AvailabilityConstraints" WHERE "schoolId" = $1 AND "userId" = $2 AND "startTime" = '07:00'`, [school, target.teacherId]);
    });

    await check('(fp-h) every lesson of the classes taken out and put back: the proposal is as long as the school is, and every brick is accounted for', async () => {
      const gone = await takeOut(100_000, 3);
      const before = await counts();
      const started = Date.now();
      const proposal = await fill.propose({ academicYearId: year, scope: 'SCHOOL' }, admin);
      const elapsed = Date.now() - started;
      console.log(`        (fp-h) ${proposal.placed.length} of ${proposal.asked} bricks laid after ${gone.length} lessons of the classes were taken out, in ${elapsed} ms (probe ${proposal.stats.probeMs} ms, worlds ${proposal.stats.worldMs} ms in ${proposal.stats.worlds}, cost ${proposal.stats.costMs} ms, judge ${proposal.stats.judgeMs} ms); ${uptime()}`);
      assert.deepEqual(await counts(), before, 'nothing was written');
      assert.equal(proposal.placed.length + proposal.left.length, proposal.asked);
      assert.ok(proposal.placed.length >= gone.length * 0.8, `most of the school's classes are laid again from nothing: ${proposal.placed.length} of ${gone.length}`);
      const taking = Date.now();
      const applied = await fill.apply({ academicYearId: year, basis: proposal.basis, items: itemsOf(proposal) }, admin);
      console.log(`        (fp-h) Ta in of ${applied.laid.length} lessons in ${Date.now() - taking} ms; ${uptime()}`);
      assert.equal(applied.laid.length, proposal.placed.length);
    });

    await check('(fp-g) Direkt: a parked lesson with calendar rows is asked about before it is laid back, and nothing is written when the school has not answered', async () => {
      // A published period, then one lesson of a class parked with its rows standing (the way a park leaves them).
      // A year of three weeks and a half in 2096: every day of it lies ahead, and the publication writes a few hundred rows and not twelve thousand.
      await owner.query(`UPDATE "AcademicYears" SET "startDate" = '2096-08-13', "endDate" = '2096-09-06' WHERE id = $1`, [year]);
      await publications.legacyPublish({ academicYearId: year, fromDate: '2096-08-13' }, admin);
      const [parkedRow] = await q<{ id: string }>(`SELECT id FROM "MasterLessons" WHERE "academicYearId" = $1 AND "studentGroupId" = ANY($2::uuid[]) AND "isParked" = false ORDER BY id LIMIT 1`, [year, [...classIds]]);
      await owner.query(`UPDATE "MasterLessons" SET "isParked" = true WHERE id = $1`, [parkedRow!.id]);
      const rows = Number((await q<{ n: string }>(`SELECT count(*) AS n FROM "CalendarLessons" WHERE "masterLessonId" = $1`, [parkedRow!.id]))[0]!.n);
      assert.ok(rows > 0, 'the parked lesson still has calendar rows');
      const brick = (await tray.trayOfYear(year, undefined, admin)).bricks.find((entry) => entry.lessonId === parkedRow!.id);
      assert.ok(brick, 'the parked lesson is a brick');
      const proposal = await fill.propose({ academicYearId: year, scope: 'BRICKS', bricks: [{ postId: brick.postId, teacherId: brick.teacherId, minutes: brick.minutes, nth: brick.nth }] }, admin);
      assert.equal(proposal.placed.length, 1);
      const before = await counts();
      const rowsBefore = (await q<{ d: string }>(`SELECT "date"::text AS d FROM "CalendarLessons" WHERE "masterLessonId" = $1 ORDER BY "date"`, [parkedRow!.id])).map((row) => row.d).join(',');
      const refused = await refusal(fill.apply({ academicYearId: year, basis: proposal.basis, items: itemsOf(proposal) }, admin));
      assert.deepEqual([refused.status, refused.code], [409, 'DIRECT_REACH_UNANSWERED']);
      assert.deepEqual(await counts(), before, 'no lesson, no version, no log row');
      assert.equal((await q<{ isParked: boolean }>(`SELECT "isParked" FROM "MasterLessons" WHERE id = $1`, [parkedRow!.id]))[0]!.isParked, true, 'the lesson is still on the tray');
      assert.equal((await q<{ d: string }>(`SELECT "date"::text AS d FROM "CalendarLessons" WHERE "masterLessonId" = $1 ORDER BY "date"`, [parkedRow!.id])).map((row) => row.d).join(','), rowsBefore, 'the calendar rows have not moved');
      await reach.acknowledge(admin);
      const applied = await fill.apply({ academicYearId: year, basis: proposal.basis, items: itemsOf(proposal) }, admin);
      assert.equal(applied.laid.length, 1);
      assert.equal((await q<{ isParked: boolean; isLocked: boolean }>(`SELECT "isParked", "isLocked" FROM "MasterLessons" WHERE id = $1`, [parkedRow!.id]))[0]!.isParked, false);
    });
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]).catch((error) => console.error('sweep:', error));
    await api.$disconnect();
    await owner.end();
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nlagg-det-som-gar probe passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
