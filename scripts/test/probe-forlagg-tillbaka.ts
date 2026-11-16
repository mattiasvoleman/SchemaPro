/**
 * The adapter probe's checks for the way back from Generera and the grundschema to the week (grafisk förläggning, A3): what a refusal
 * about a förläggning says of its post, and what the week's board says the grundschema holds of them. Through the real services on the
 * API's role and real Postgres as CI runs it. One school of its own (slug <marker>-tillbaka), a läsår that starts on a Saturday, swept
 * whole before and after:
 *
 *   vv10  Generera's pre-flight (prepareSchedule) refuses a förläggning that no longer holds, and the line carries the post's own id
 *         (`postId`) and the day and the start of its row, which the week's board holds as a row: a lock beside a post's row, a teacher
 *         changed on a post, a block's lesson (with `blockId`, and the member's own post), and a row that stands though it stopped
 *         holding (A2's rule: the save lets it stand and names it) gives the same link as before it was let stand; a row that holds is
 *         not named; a school with none says nothing. The lines have no `postId` in any other category (the lines the pre-flight makes
 *         for a block are of the category PLACEMENT as well);
 *   vv11  the board's `timetable` against the grundschema itself, in the four cases the week's sentence "Ändrat sedan senaste schemat"
 *         tells apart (web/lib/placement-since-run.ts, the very function the page runs, handed the real board): nothing written yet,
 *         unchanged (no sentence), a row laid after the run, a row changed after it, a row taken away (which leaves no changedAt behind
 *         and is told by the count), and a schemaförslag applied (the grundschema written again with no run: `writtenAt` moves and
 *         the count does not); a lock or an unlock moves `updatedAt` and never `writtenAt`.
 *
 * Generera's own write is not run here (that is the engine's, and the real-engine run's): the lessons it writes are laid as
 * writeRegeneration lays them, one `fromPlacement` lesson per row (and per member for a block's), locked and generated, after deleting
 * the year's generated ones, so what is asked of the database is the board's own read of what is there.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { HttpService } from '@nestjs/axios';
import type { ConfigService } from '@nestjs/config';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import type { PrismaService } from '../../src/database/prisma.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import { RequirementPlacementsService } from '../../src/requirement-placements/requirement-placements.service';
import { changedSinceRun } from '../../web/lib/placement-since-run';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function placementBackSlug(marker: string): string {
  return `${marker}-tillbaka`;
}

export async function sweepPlacementBackSchools(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [placementBackSlug(marker)]);
}

interface Line {
  category: string;
  code?: string;
  params?: Record<string, string | number>;
}

export async function placementBackChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepPlacementBackSchools(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  try {
    const school = (
      await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [
        `${marker} tillbaka`,
        placementBackSlug(marker),
      ])
    ).id;
    // A läsår that starts on a Saturday (2098-08-16), the active one, in the nine-year numbering the grade rules read.
    const year = (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
         VALUES ($1, 'probe tillbaka', '2098-08-16', '2099-06-11', true, 'NIOARIG', now()) RETURNING id`,
        [school],
      )
    ).id;
    const group = async (name: string) =>
      (
        await one<{ id: string }>(
          `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', 7, now()) RETURNING id`,
          [school, year, name],
        )
      ).id;
    const person = async (label: string, role: string, adminProfile: string | null = null) => {
      const authId = randomUUID();
      const row = await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "adminProfile", "updatedAt")
         VALUES ($1, $2, $3, 'Tillbaka', $4, $5, true, $6, now()) RETURNING id`,
        [school, `${marker}-tillbaka-${label}@example.invalid`, label, role, authId, adminProfile],
      );
      return { id: row.id, authId };
    };
    const subject = async (name: string) =>
      (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [school, name])).id;
    const room = async (name: string) =>
      (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [school, name])).id;

    const g7a = await group('TB 7A');
    const g7b = await group('TB 7B');
    const anna = await person('anna', 'TEACHER');
    const bo = await person('bo', 'TEACHER');
    const cecilia = await person('cecilia', 'TEACHER');
    const dag = await person('dag', 'TEACHER');
    const adminRow = await person('admin', 'SCHOOL_ADMIN', 'SCHEMALAGGARE');
    const admin = { authId: adminRow.authId, userId: adminRow.id, schoolId: school, role: Role.SCHOOL_ADMIN, adminProfile: 'SCHEMALAGGARE', channel: 'WEB', hrRead: false } as AuthenticatedUser;
    const ma = await subject('TB Matematik');
    const sv = await subject('TB Svenska');
    const fr = await subject('TB Franska');
    const ty = await subject('TB Tyska');
    const idh = await subject('TB Idrott');
    const r1 = await room('TB sal 1');
    const r2 = await room('TB sal 2');
    const post = async (groupId: string, subjectId: string, teacherId: string, lessons: number, minutes: number, blockId: string | null = null) =>
      (
        await one<{ id: string }>(
          `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "blockId", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING id`,
          [school, year, subjectId, groupId, teacherId, lessons, minutes, blockId],
        )
      ).id;
    // A hand-made locked lesson of the grundschema: what Generera keeps, and what a förläggning beside it is held against.
    const lock = (subjectId: string, groupId: string, teacherId: string, roomId: string, day: number, start: string, end: string) =>
      owner.query(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, false, now())`,
        [school, year, subjectId, groupId, teacherId, roomId, day, start, end],
      );

    // Posts: Matematik 7A (Anna, two of 60), Svenska 7B (Bo, two of 60), Idrott 7A (Anna, one of 60) that nothing will touch,
    // and a block of two members (Franska 7A with Cecilia, Tyska 7B with Dag, two of 60 each).
    const blockId = (await one<{ id: string }>(`INSERT INTO "TeachingBlocks" ("schoolId", "academicYearId", name, "updatedAt") VALUES ($1, $2, 'TB Språkval 7', now()) RETURNING id`, [school, year])).id;
    const pMa = await post(g7a, ma, anna.id, 2, 60);
    const pSv = await post(g7b, sv, bo.id, 2, 60);
    const pIdh = await post(g7a, idh, anna.id, 1, 60);
    const mFr = await post(g7a, fr, cecilia.id, 2, 60, blockId);
    const mTy = await post(g7b, ty, dag.id, 2, 60, blockId);

    const realtime = { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService;
    const masters = new MasterLessonsService(api, realtime, {} as NotificationsService);
    const placements = new RequirementPlacementsService(api, masters);
    const { OptimizationProxyService } = await import('../../src/optimization/optimization-proxy.service');
    const config = { getOrThrow: () => ({ baseUrl: 'http://127.0.0.1:1', apiKey: 'x', timeoutMs: 1000 }) } as unknown as ConfigService;
    const http = { post: () => { throw new Error('the pre-flight wakes no engine'); } } as unknown as HttpService;
    const proxy = new OptimizationProxyService(api, http, config, masters) as unknown as {
      prepareSchedule: (tx: unknown, year: string, user: AuthenticatedUser) => Promise<{ ready: boolean; refusal?: { conflicts?: { conflicts: Line[]; summaryCode?: string } | null } }>;
    };
    const row = (dayOfWeek: number, startTime: string, minutes: number, roomId: string | null, extra: Record<string, unknown> = {}) => ({
      dayOfWeek,
      startTime,
      minutes,
      roomId,
      recurrence: 'ALL_WEEKS' as const,
      ...extra,
    });
    const refusalLines = async (): Promise<{ ready: boolean; lines: Line[]; summaryCode: string | null }> => {
      const prepared = await api.withRls(admin, (tx) => proxy.prepareSchedule(tx, year, admin));
      return { ready: prepared.ready, lines: prepared.refusal?.conflicts?.conflicts ?? [], summaryCode: prepared.refusal?.conflicts?.summaryCode ?? null };
    };
    const at = (start: unknown): string => String(start).slice(0, 5);

    // The rows, laid through the service the dialog writes with: Matematik 7A on Tuesday 10:00 and Thursday 13:15, Svenska 7B on
    // Wednesday 09:00, Idrott 7A on Friday 13:00. A block's lesson on Friday 08:00, planted as the block's table holds it (the
    // database's own rules BP409 hold the lengths and the members), with Franska's room chosen and Tyska's left to the engine.
    await placements.replace(pMa, { placements: [row(2, '10:00', 60, r1), row(4, '13:15', 60, r1)] } as never, admin);
    await placements.replace(pSv, { placements: [row(3, '09:00', 60, r2)] } as never, admin);
    await placements.replace(pIdh, { placements: [row(5, '13:00', 60, r2)] } as never, admin);
    const blockRow = await one<{ id: string }>(
      `INSERT INTO "TeachingBlockPlacements" ("schoolId", "blockId", "academicYearId", "dayOfWeek", "startTime", minutes, recurrence, "updatedAt")
       VALUES ($1, $2, $3, 5, '08:00', 60, 'ALL_WEEKS', now()) RETURNING id`,
      [school, blockId, year],
    );
    await owner.query(`INSERT INTO "TeachingBlockPlacementRooms" ("schoolId", "placementId", "requirementId", "roomId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [
      school,
      blockRow.id,
      mFr,
      r1,
    ]);

    await check('(vv10) a school whose förläggningar all hold is refused by nothing, and the pre-flight names no line', async () => {
      const board = await placements.boardOfYear(year, admin);
      assert.equal(board.placements.length, 4, 'the four rows of the posts');
      assert.equal(board.blocks.length, 1);
      assert.equal(board.blocks[0]!.rows.length, 1);
      for (const entry of board.placements) assert.deepEqual(entry.verdict, { ok: true });
      const { ready, lines } = await refusalLines();
      assert.equal(ready, true, 'every row holds, so the run goes through the pre-flight');
      assert.deepEqual(lines, []);
    });

    await check('(vv10) a lock beside a post\'s row, and a teacher changed on a post: the line says the post, and its day and start are a row of the board', async () => {
      // Anna is held at Tuesday 10:00 in 7B's idrott by a lesson of the grundschema that is locked: a lock beside Matematik 7A's row (of a class and a
      // subject no post of the school has, so that no post's demand is answered by it).
      await lock(idh, g7b, anna.id, r2, 2, '10:00', '11:00');
      // Svenska 7B is taken over by Anna, who has a lesson at Wednesday 09:00 (locked, hand-made, Tyska 7A): the row that was Bo's now clashes with hers.
      await lock(ty, g7a, anna.id, r1, 3, '09:00', '10:00');
      await owner.query(`UPDATE "TeachingRequirements" SET "teacherId" = $1 WHERE id = $2`, [anna.id, pSv]);
      const board = await placements.boardOfYear(year, admin);
      const red = board.placements.filter((entry) => !entry.verdict.ok);
      assert.deepEqual(red.map((entry) => [entry.requirementId, entry.dayOfWeek, entry.startTime.slice(0, 5)]).sort(), [[pMa, 2, '10:00'], [pSv, 3, '09:00']].sort(), 'the week shows the two rows red');

      const { ready, lines, summaryCode } = await refusalLines();
      assert.equal(ready, false, 'a row that does not hold refuses the run before the engine');
      assert.equal(summaryCode, 'PLACEMENTS_REFUSED_SUMMARY');
      assert.equal(lines.length, 2, 'one line for each row that does not hold, and none for the rows that do');
      for (const line of lines) {
        assert.equal(line.category, 'PLACEMENT');
        assert.equal(line.code, 'PLACEMENT_CANNOT_STAND');
        const params = line.params!;
        assert.equal(typeof params['postId'], 'string', 'the post\'s own id');
        assert.ok(!('blockId' in params), 'a post of no block says no block');
        // The line's place is a row of the board: the link finds the card on the post, the day and the start.
        const found = board.placements.filter((entry) => entry.requirementId === params['postId'] && entry.dayOfWeek === params['day'] && entry.startTime.slice(0, 5) === params['start']);
        assert.equal(found.length, 1, `the line (${params['postId']}, ${params['day']}, ${params['start']}) is one row of the week`);
        assert.equal(found[0]!.verdict.ok, false, 'and it is the row that does not hold');
        // The id is the real id and never a name: the post's name is in `requirement`, the way the sentence reads it.
        assert.notEqual(params['requirement'], params['postId']);
        assert.match(String(params['postId']), /^[0-9a-f-]{36}$/);
      }
      assert.deepEqual(lines.map((line) => line.params!['postId']).sort(), [pMa, pSv].sort());
      assert.ok(!lines.some((line) => line.params!['postId'] === pIdh), 'Idrott 7A holds and is not named');
    });

    await check('(vv10) a block\'s lesson that stopped holding is named by its member, with the block, at the lesson\'s own day and start', async () => {
      // Cecilia (Franska 7A) is held on Friday 08:00 by a lesson of the grundschema in 7A: the block's lesson fails for that member only.
      await lock(sv, g7a, cecilia.id, r2, 5, '08:00', '09:00');
      const board = await placements.boardOfYear(year, admin);
      const block = board.blocks.find((entry) => entry.id === blockId)!;
      const failing = block.rows[0]!.verdicts.filter((verdict) => !verdict.ok).map((verdict) => verdict.requirementId);
      assert.deepEqual(failing, [mFr], 'the lesson is red for the member Cecilia teaches, and holds for the other');
      const { lines } = await refusalLines();
      const named = lines.filter((line) => line.params!['blockId'] === blockId);
      assert.equal(named.length, 1, 'the block\'s lesson is named once, for the member that fails');
      const params = named[0]!.params!;
      assert.equal(params['postId'], mFr, 'the member\'s own post');
      assert.equal(params['blockId'], blockId);
      assert.equal(params['day'], 5);
      assert.equal(params['start'], '08:00');
      const lesson = block.rows.find((entry) => entry.dayOfWeek === params['day'] && entry.startTime.slice(0, 5) === params['start']);
      assert.ok(lesson, 'the lesson is a row of the block on the board, found by its day and start');
      assert.ok(block.memberIds.includes(String(params['postId'])), 'and the member is the block\'s');
      // The posts' own lines carry no block, and the other member (Tyska) is not named.
      assert.ok(lines.filter((line) => line.params!['blockId'] === undefined).every((line) => [pMa, pSv].includes(String(line.params!['postId']))));
      assert.ok(!lines.some((line) => line.params!['postId'] === mTy));
    });

    await check('(vv10) a row the save lets stand (A2\'s rule) is named by the pre-flight with the same link as before it was let stand', async () => {
      const before = (await refusalLines()).lines.find((line) => line.params!['postId'] === pMa)!.params!;
      // Matematik 7A is saved again with its red Tuesday row as it is and the Thursday row moved: the server lets the old row stand.
      const answer = await placements.replace(pMa, { placements: [row(2, '10:00', 60, r1), row(4, '14:30', 60, r1)] } as never, admin);
      const stood = answer.verdicts.filter((verdict) => !verdict.ok);
      assert.equal(stood.length, 1, 'the standing row is named in the answer, red');
      const { lines } = await refusalLines();
      const after = lines.filter((line) => line.params!['postId'] === pMa);
      assert.equal(after.length, 1, 'only the row that stood is named; the moved row holds');
      assert.deepEqual([after[0]!.params!['postId'], after[0]!.params!['day'], after[0]!.params!['start']], [before['postId'], before['day'], before['start']], 'the same link');
      const board = await placements.boardOfYear(year, admin);
      assert.ok(board.placements.some((entry) => entry.requirementId === pMa && entry.dayOfWeek === 2 && entry.startTime.slice(0, 5) === '10:00' && !entry.verdict.ok));
    });

    await check('(vv10) every line of the category has its ids; no id is added to anything else the pre-flight says', async () => {
      const { lines } = await refusalLines();
      assert.ok(lines.length >= 3);
      for (const line of lines) {
        assert.equal(line.category, 'PLACEMENT');
        assert.equal(typeof line.params!['postId'], 'string');
        assert.ok(['PLACEMENT_CANNOT_STAND'].includes(String(line.code)));
        // Only the two ids and the sentence's own values: nothing else was put in.
        const extra = Object.keys(line.params!).filter((key) => !['requirement', 'room', 'day', 'start', 'end', 'reason', 'other', 'resource', 'schools', 'block', 'postId', 'blockId'].includes(key));
        assert.deepEqual(extra, []);
      }
    });

    // ---------------------------------------------------------------------------------------------------------------------------
    // vv11: the grundschema's own account on the board. A second set of rows is laid in a clean state: the refusals above are mended.
    // ---------------------------------------------------------------------------------------------------------------------------
    await owner.query(`DELETE FROM "MasterLessons" WHERE "academicYearId" = $1`, [year]);
    await owner.query(`UPDATE "TeachingRequirements" SET "teacherId" = $1 WHERE id = $2`, [bo.id, pSv]);
    await placements.replace(pMa, { placements: [row(2, '10:00', 60, r1), row(4, '13:15', 60, r1)] } as never, admin);

    /** What Generera writes from the rows, as writeRegeneration lays it: the year's generated lessons removed and a lesson per row (and per member for a block's) created. */
    const writeFromRows = async () => {
      await owner.query(`DELETE FROM "MasterLessons" WHERE "academicYearId" = $1 AND "isGenerated" = true`, [year]);
      const rows = await all<{ requirementId: string; dayOfWeek: number; startTime: string; minutes: number; roomId: string | null; recurrence: string }>(
        `SELECT p."requirementId", p."dayOfWeek", p."startTime"::text AS "startTime", p.minutes, p."roomId", p.recurrence::text AS recurrence
           FROM "TeachingRequirementPlacements" p JOIN "TeachingRequirements" r ON r.id = p."requirementId" WHERE r."academicYearId" = $1`,
        [year],
      );
      for (const entry of rows) {
        await owner.query(
          `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", recurrence, "isGenerated", "isLocked", "fromPlacement", "updatedAt")
           SELECT r."schoolId", r."academicYearId", r."subjectId", r."studentGroupId", r."teacherId", $2::uuid, $3::int, $4::time, ($4::time + make_interval(mins => $5::int)), $6::"LessonRecurrence", true, true, true, now()
             FROM "TeachingRequirements" r WHERE r.id = $1`,
          [entry.requirementId, entry.roomId, entry.dayOfWeek, entry.startTime, entry.minutes, entry.recurrence],
        );
      }
      return rows.length;
    };
    const timetable = async () => (await placements.boardOfYear(year, admin)).timetable;
    const sentence = async (jobs: Parameters<typeof changedSinceRun>[1]) => changedSinceRun(await placements.boardOfYear(year, admin), jobs);
    const OPTIMAL = [{ status: 'SUCCEEDED', solverStatus: 'OPTIMAL', finishedAt: new Date().toISOString() }];

    await check('(vv11) before any run the grundschema holds nothing from a förläggning: nothing written, and no sentence about a change', async () => {
      assert.deepEqual(await timetable(), { placedLessons: 0, writtenAt: null });
      assert.equal(await sentence([]), false, 'no schema yet: the week\'s own sentence stands');
      assert.equal(await sentence(undefined), false);
    });

    let writtenAt = '';
    await check('(vv11) after a run: the count is the lessons written (a row each, and a lesson per member for the block\'s) and the time is the newest createdAt', async () => {
      // The rows are saved first and the grundschema written after them, as a run does.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const written = await writeFromRows();
      const answer = await timetable();
      assert.equal(written, 4, 'the four rows of the posts are written (the block\'s lessons are the block table\'s, written for its members below)');
      // The block's lesson is one lesson for each member, as writeRegeneration writes it.
      await owner.query(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", recurrence, "isGenerated", "isLocked", "fromPlacement", "updatedAt")
         SELECT r."schoolId", r."academicYearId", r."subjectId", r."studentGroupId", r."teacherId", 5, '08:00', '09:00', 'ALL_WEEKS', true, true, true, now() FROM "TeachingRequirements" r WHERE r.id = ANY($1::uuid[])`,
        [[mFr, mTy]],
      );
      const after = await timetable();
      assert.equal(answer.placedLessons, 4);
      assert.equal(after.placedLessons, 6, 'four rows of posts and the block\'s lesson once for each of its two members');
      const newest = await one<{ at: Date }>(`SELECT max("createdAt") AS at FROM "MasterLessons" WHERE "academicYearId" = $1 AND "fromPlacement"`, [year]);
      assert.equal(after.writtenAt, newest.at.toISOString(), 'the newest createdAt among them');
      writtenAt = after.writtenAt!;
    });

    await check('(vv11) unchanged: the rows are what the grundschema was written from, so the week says nothing', async () => {
      assert.equal(await sentence(OPTIMAL), false);
      assert.equal(await sentence([]), false, 'the lessons written are a schema on their own, with no run in the history');
    });

    await check('(vv11) a lock or an unlock moves updatedAt and never the time the grundschema was written', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await owner.query(`UPDATE "MasterLessons" SET "isLocked" = false, "updatedAt" = now() WHERE "academicYearId" = $1 AND "fromPlacement"`, [year]);
      assert.equal((await timetable()).writtenAt, writtenAt);
      await owner.query(`UPDATE "MasterLessons" SET "isLocked" = true, "updatedAt" = now() WHERE "academicYearId" = $1 AND "fromPlacement"`, [year]);
      assert.equal((await timetable()).writtenAt, writtenAt);
      assert.equal(await sentence(OPTIMAL), false, 'and the sentence is not moved by it');
    });

    await check('(vv11) a row laid after the run: one lesson more than the grundschema holds, and a row saved after it was written', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await placements.replace(pSv, { placements: [row(3, '09:00', 60, r2), row(1, '11:00', 60, r2)] } as never, admin);
      const board = await placements.boardOfYear(year, admin);
      assert.equal(board.timetable.placedLessons, 6, 'the grundschema holds what it did');
      assert.equal(board.placements.length, 5);
      assert.equal(await sentence(OPTIMAL), true, 'laid after the run');
      assert.equal(await sentence([]), true, 'a schema from lessons alone says it as well');
    });

    await check('(vv11) a row changed after the run: the same count and a changedAt after the write (and the limit: saving the same list again is a change too)', async () => {
      await placements.replace(pSv, { placements: [row(3, '09:00', 60, r2)] } as never, admin);
      const board = await placements.boardOfYear(year, admin);
      assert.equal(board.placements.length, 4, 'the same rows as were written from');
      assert.equal(board.timetable.placedLessons, 6, 'and the same lessons');
      // The list was saved again with new ids and a new changedAt: that is all the sentence sees. It cannot know that the list is the same
      // as the one the grundschema was written from ("it is a prompt to generate again", the handbook says it); undo has the same effect.
      assert.ok(board.placements.some((entry) => entry.requirementId === pSv && new Date(entry.changedAt).getTime() > new Date(writtenAt).getTime()), 'the row is newer than the write');
      assert.equal(await sentence(OPTIMAL), true, 'saved after the run');
      // The grundschema is written again: the rows are what it was written from once more.
      await new Promise((resolve) => setTimeout(resolve, 30));
      await writeFromRows();
      await owner.query(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", recurrence, "isGenerated", "isLocked", "fromPlacement", "updatedAt")
         SELECT r."schoolId", r."academicYearId", r."subjectId", r."studentGroupId", r."teacherId", 5, '08:00', '09:00', 'ALL_WEEKS', true, true, true, now() FROM "TeachingRequirements" r WHERE r.id = ANY($1::uuid[])`,
        [[mFr, mTy]],
      );
      assert.equal(await sentence(OPTIMAL), false, 'written again after the last save');
      writtenAt = (await timetable()).writtenAt!;
    });

    await check('(vv11) a row taken away after the run leaves no changedAt, and the count tells it: its lesson stands in the grundschema', async () => {
      const before = await placements.boardOfYear(year, admin);
      const newestChange = Math.max(...before.placements.map((entry) => new Date(entry.changedAt).getTime()));
      await placements.replace(pSv, { placements: [] } as never, admin);
      const board = await placements.boardOfYear(year, admin);
      assert.equal(board.placements.length, 3);
      assert.equal(Math.max(...board.placements.map((entry) => new Date(entry.changedAt).getTime())) <= newestChange, true, 'no row is newer: the removed row left nothing behind');
      assert.equal(board.timetable.placedLessons, 6, 'and its lesson still stands');
      assert.equal(await sentence(OPTIMAL), true, 'one lesson fewer in the rows than in the grundschema');
      // A block's row taken away is told the same way.
      await placements.replace(pSv, { placements: [row(3, '09:00', 60, r2)] } as never, admin);
    });

    await check('(vv11) a schemaförslag applied writes the grundschema with no run: writtenAt moves, the count does not, and the week is current again', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const before = await timetable();
      // writeRegeneration again, as the candidates' apply does it: no row of the job history is touched.
      await writeFromRows();
      await owner.query(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", recurrence, "isGenerated", "isLocked", "fromPlacement", "updatedAt")
         SELECT r."schoolId", r."academicYearId", r."subjectId", r."studentGroupId", r."teacherId", 5, '08:00', '09:00', 'ALL_WEEKS', true, true, true, now() FROM "TeachingRequirements" r WHERE r.id = ANY($1::uuid[])`,
        [[mFr, mTy]],
      );
      const after = await timetable();
      assert.equal(after.placedLessons, before.placedLessons, 'the same lessons');
      assert.ok(new Date(after.writtenAt!).getTime() > new Date(before.writtenAt!).getTime(), 'written later');
      // No run in the history at all, yet a schema stands, and the week says nothing: the rows are what it was written from.
      assert.equal(await sentence([]), false);
    });

    await check('(vv11) the board\'s timetable is read as the expedition and the läsare read it, and a teacher\'s row security shows none', async () => {
      const profile = async (label: string, adminProfile: string) => {
        const created = await person(label, 'SCHOOL_ADMIN', adminProfile);
        return { authId: created.authId, userId: created.id, schoolId: school, role: Role.SCHOOL_ADMIN, adminProfile, channel: 'WEB', hrRead: false } as AuthenticatedUser;
      };
      const expedition = await profile('expedition', 'EXPEDITION');
      const reader = await profile('reader', 'LASARE');
      const mine = await timetable();
      assert.deepEqual((await placements.boardOfYear(year, expedition)).timetable, mine);
      assert.deepEqual((await placements.boardOfYear(year, reader)).timetable, mine);
      const teacher = { authId: anna.authId, userId: anna.id, schoolId: school, role: Role.TEACHER, adminProfile: null, channel: 'WEB', hrRead: false } as AuthenticatedUser;
      const seen = await placements.boardOfYear(year, teacher);
      assert.equal(seen.placements.length, 0, 'a teacher sees no förläggning');
      assert.ok(seen.timetable.placedLessons <= mine.placedLessons, 'and what a teacher sees of the grundschema is never more than the administrator sees');
    });
  } finally {
    await sweepPlacementBackSchools(owner, marker);
  }
}
