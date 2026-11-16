/**
 * Förlägg i veckan, a block's lessons, against Postgres (PR C2): what the week's page does to a parallel block, step by step,
 * through the real services as the API's role under row security.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-forlagg-block-veckan.ts
 *
 * WHY THIS EXISTS. probe-forlagg-block.ts (C1) lays the lesson the way the dialog does: one save, read first. The week writes
 * differently: ONE PUT of the block's whole list per change, each made on top of the key the PREVIOUS ANSWER gave (no read in
 * between: the page puts the answer into its cache), an undo that is a PUT on the key OUR last write left, and an answer whose
 * `verdicts[].index` the page has to map to the lesson it names. Those are the page's contract with the gateway, and the web's
 * unit tests can only assume them. This asks the real gateway, over a real database, for each of them.
 *
 * A block of three posts (Spanska, Tyska, Franska, two lessons of 60 minutes each, a teacher each) in a school of its own:
 *
 *   bw-a  the chain: the first lesson is written on the key an empty block is read with, the second on the key the first answer
 *         gave, a move on the second's, with no read in between, and every answer's key is the key the next read gives and the
 *         key the week's board states (`board.blocks[].rowsKey`, which the page compares with its own last key);
 *   bw-b  the week's board and the members' counts follow each write (placed and left of each member's part);
 *   bw-c  undo and redo are PUTs on the key OUR last write left, and each lands; a write by somebody else after ours makes the
 *         step a 409 BLOCK_PLACEMENTS_STALE and writes nothing (the week's key is then not ours: the page's `reconcile`);
 *   bw-d  a lesson carries its rooms back: a move writes every other lesson with its rooms, and a lesson sent with none loses
 *         them (so the page must send each lesson's `rooms` as it stands, and only the members that chose one);
 *   bw-e  every empty block has the one key, and two writers of the FIRST lesson both holding it see each other as stale: exactly
 *         one saves, six rounds;
 *   bw-f  a write while Generera holds the year's regeneration lock is 409 SCHEDULE_BUSY and writes nothing, and goes through
 *         when the lock is released;
 *   bw-g  THE INDEXES the page has to map. The gateway keeps and answers the lessons in (day, start) order. `verdicts[].index`
 *         of a 200 and of the read is a lesson's place in the ANSWER's `placements`; `params.index` of BLOCK_PLACEMENT_REFUSED
 *         and of BLOCK_PLACEMENTS_DO_NOT_FIT is its place in the list that was SENT. A lesson put earlier in the week than the
 *         one the block has changes the answer's order: the red lesson is then at another index in the answer than in the list;
 *   bw-h  a block whose two lessons have stopped holding is mended one at a time on chained keys, a new lesson beside one that
 *         stands is refused by the symmetric judge, and one that touches neither is let through;
 *   bw-i  the member the judge names for a refused lesson is the member (BLOCK_PLACEMENT_REFUSED.params.requirementId), also
 *         when the lesson is sent last.
 *
 * A step that fails prints its FAIL line and the run goes on; the steps share the world, so a failure early on may take later
 * ones with it. The exit code is 1 for any FAIL. Independent of what earlier CI steps left in the database: it works in a school
 * of its own, planted and dropped by this probe. 2095/96, so no date of its year is behind the clock.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { PrismaService } from '../../src/database/prisma.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import { BlockPlacementsService, type BlockPlacementsResponse } from '../../src/requirement-placements/block-placements.service';
import { RequirementPlacementsService } from '../../src/requirement-placements/requirement-placements.service';

const SLUG = 'probe-forlagg-block-veckan';

// ---------------------------------------------------------------------------
// The checks' own bookkeeping
// ---------------------------------------------------------------------------

let failures = 0;

function summarise(error: unknown): string {
  if (error instanceof HttpException) return `${error.name} ${error.getStatus()} ${JSON.stringify(error.getResponse())}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function check(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}\n     ${summarise(error).replace(/\n/g, '\n     ')}`);
  }
}

/** The error a refused call is, as a value. */
async function refusalOf(work: Promise<unknown>): Promise<HttpException> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof HttpException, `expected an HttpException, got ${summarise(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'the call was not refused' });
}

const codeOf = (error: HttpException): string | undefined => (error.getResponse() as { code?: string }).code;
const paramsOf = (error: HttpException): Record<string, unknown> => (error.getResponse() as { params?: Record<string, unknown> }).params ?? {};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const started = Date.now();
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  try {
    await sweep(owner);
    await run(owner, api);
  } finally {
    await sweep(owner).catch((error: unknown) => console.error(`the probe's school was not dropped: ${summarise(error)}`));
    await owner.end();
    await api.$disconnect?.();
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (failures > 0) {
    console.error(`==> Förlagda block, veckan, probe FAILED: ${failures} step(s) in ${seconds} s`);
    process.exitCode = 1;
  } else {
    console.log(`==> Förlagda block, veckan, probe passed in ${seconds} s`);
  }
}

async function sweep(owner: Client): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
}

/** One lesson as the PUT takes it. */
interface Lesson {
  dayOfWeek: number;
  startTime: string;
  minutes: number;
  rooms: { requirementId: string; roomId: string }[];
}

async function run(owner: Client, api: PrismaService): Promise<void> {
  const realtime = { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService;
  const masters = new MasterLessonsService(api, realtime, {} as NotificationsService);
  const postPlacements = new RequirementPlacementsService(api, masters);
  const blocks = new BlockPlacementsService(api, masters, postPlacements);

  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  // -------------------------------------------------------------------------
  // The school: three language posts in one block, a class of one pupil each, a teacher and a room each
  // -------------------------------------------------------------------------
  const s = (
    await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Probe förlagda block, veckan', $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])
  ).id;
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
       VALUES ($1, 'Probe 2095/96', '2095-08-15', '2096-06-10', true, now()) RETURNING id`,
      [s],
    )
  ).id;
  const group = async (name: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', 7, now()) RETURNING id`,
        [s, year, name],
      )
    ).id;
  const person = async (label: string, role: string, extra: { groupId?: string; adminProfile?: string } = {}) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'Veckan', $4, $5, $6, true, $7, now()) RETURNING id`,
      [s, `${SLUG}-${label}@example.invalid`, label, role, extra.adminProfile ?? null, authId, extra.groupId ?? null],
    );
    return { id: row.id, authId };
  };
  const adminRow = await person('admin', 'SCHOOL_ADMIN', { adminProfile: 'FULL' });
  const teachers = [await person('t1', 'TEACHER'), await person('t2', 'TEACHER'), await person('t3', 'TEACHER'), await person('t4', 'TEACHER')];
  const groups = [await group('BV Spanska 7'), await group('BV Tyska 7'), await group('BV Franska 7'), await group('BV Annan 7')];
  for (const [index, groupId] of groups.entries()) await person(`p${index + 1}`, 'STUDENT', { groupId });
  const admin: AuthenticatedUser = {
    authId: adminRow.authId,
    userId: adminRow.id,
    schoolId: s,
    role: Role.SCHOOL_ADMIN,
    adminProfile: 'FULL',
    channel: 'WEB',
    hrRead: false,
  } as AuthenticatedUser;
  const subject = async (name: string) =>
    (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [s, name])).id;
  const subjects = [await subject('BV Spanska'), await subject('BV Tyska'), await subject('BV Franska'), await subject('BV Annat')];
  const room = async (name: string) => (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [s, name])).id;
  const sal1 = await room('BV sal 1');
  const sal2 = await room('BV sal 2');
  const blockId = (
    await one<{ id: string }>(`INSERT INTO "TeachingBlocks" ("schoolId", "academicYearId", name, "updatedAt") VALUES ($1, $2, 'BV Språkval 7', now()) RETURNING id`, [s, year])
  ).id;
  const emptyBlockId = (
    await one<{ id: string }>(`INSERT INTO "TeachingBlocks" ("schoolId", "academicYearId", name, "updatedAt") VALUES ($1, $2, 'BV Tomt block', now()) RETURNING id`, [s, year])
  ).id;
  const post = async (index: number) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "blockId", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 2, 60, $6, now()) RETURNING id`,
        [s, year, subjects[index], groups[index], teachers[index]!.id, blockId],
      )
    ).id;
  const spanska = await post(0);
  const tyska = await post(1);
  const franska = await post(2);
  const members = [spanska, tyska, franska];

  // -------------------------------------------------------------------------
  // What the checks read and do: the page's own moves, as plain functions
  // -------------------------------------------------------------------------
  const lessonOf = (view: BlockPlacementsResponse['placements'][number]): Lesson => ({
    dayOfWeek: view.dayOfWeek,
    startTime: view.startTime,
    minutes: view.minutes,
    rooms: view.rooms.map((one) => ({ requirementId: one.requirementId, roomId: one.roomId })),
  });
  /** The page's cache of the block: the lessons as the last answer held them, and the key that answer gave. */
  let held: { lessons: Lesson[]; key: string } = { lessons: [], key: '' };
  /** The key OUR last write of the block left: what an undo or a redo is made on top of. */
  let ours = '';
  /** One write the way the page makes it: the whole list, on the key the page holds; the answer goes into the page's cache. */
  const write = async (list: Lesson[], baseKey = held.key): Promise<BlockPlacementsResponse> => {
    const answer = await blocks.replace(blockId, { placements: list, baseKey } as never, admin);
    held = { lessons: answer.placements.map(lessonOf), key: answer.rowsKey };
    ours = answer.rowsKey;
    return answer;
  };
  const read = async (): Promise<void> => {
    const answer = await blocks.listOfBlock(blockId, admin);
    held = { lessons: answer.placements.map(lessonOf), key: answer.rowsKey };
  };
  const lesson = (dayOfWeek: number, startTime: string, rooms: Lesson['rooms'] = [], minutes = 60): Lesson => ({ dayOfWeek, startTime, minutes, rooms });
  const textOf = (lessons: readonly Lesson[]): string[] =>
    lessons.map((one) => `${one.dayOfWeek} ${one.startTime} ${one.minutes} ${one.rooms.map((room) => `${room.requirementId}=${room.roomId}`).sort().join(',')}`);
  const storedRows = (): Promise<{ day: number; start: string; minutes: number }[]> =>
    all(`SELECT "dayOfWeek" AS day, to_char("startTime", 'HH24:MI') AS start, minutes FROM "TeachingBlockPlacements" WHERE "blockId" = $1 ORDER BY "dayOfWeek", "startTime"`, [blockId]);
  const roomRows = (): Promise<{ requirementId: string; roomId: string }[]> =>
    all(`SELECT "requirementId", "roomId" FROM "TeachingBlockPlacementRooms" WHERE "schoolId" = $1 ORDER BY "requirementId"`, [s]);
  const fingerprint = async (): Promise<string> =>
    JSON.stringify([
      await all(`SELECT id, "dayOfWeek", "startTime", minutes FROM "TeachingBlockPlacements" WHERE "blockId" = $1 ORDER BY id`, [blockId]),
      await roomRows(),
    ]);
  const clear = async (): Promise<void> => {
    await read();
    await write([]);
  };
  /** The week's board key of the block, which the page compares with its own last key. */
  const boardOfBlock = async () => {
    const board = await postPlacements.boardOfYear(year, admin);
    const view = board.blocks.find((candidate) => candidate.id === blockId);
    assert.ok(view, 'the block is on the board');
    return { board, view };
  };
  const redOf = (verdicts: readonly { index: number; requirementId: string; ok: boolean; reason?: string }[]) =>
    verdicts.filter((verdict) => !verdict.ok).map((verdict) => [verdict.index, verdict.requirementId, verdict.reason]);
  /** A lesson of another class (kept as it is, locked) that makes a member's teacher busy: the lesson of the block then no longer holds. */
  const lock = async (teacher: number, day: number, from: string, to: string): Promise<string> =>
    (
      await one<{ id: string }>(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, false, now()) RETURNING id`,
        [s, year, subjects[3], groups[3], teachers[teacher]!.id, day, from, to],
      )
    ).id;
  const unlock = async (ids: string[]): Promise<void> => void (await owner.query(`DELETE FROM "MasterLessons" WHERE id = ANY($1::uuid[])`, [ids]));

  // -------------------------------------------------------------------------
  // The checks
  // -------------------------------------------------------------------------
  const tuesday = lesson(2, '10:00', [{ requirementId: spanska, roomId: sal1 }]);
  const thursday = lesson(4, '13:30', [{ requirementId: tyska, roomId: sal2 }]);
  let emptyKey = '';
  let afterFirst = '';
  let afterSecond = '';
  let afterMove = '';

  await check('bw-a: the chain: the first lesson on the key an empty block is read with, the next on the key of the answer before, with no read between, and every key is the one the next read and the week\'s board give', async () => {
    await read();
    emptyKey = held.key;
    assert.match(emptyKey, /^[0-9a-f]{32}$/);

    const first = await write([tuesday]);
    afterFirst = first.rowsKey;
    assert.notEqual(afterFirst, emptyKey);
    assert.deepEqual(textOf(held.lessons), textOf([tuesday]));
    assert.equal((await blocks.listOfBlock(blockId, admin)).rowsKey, afterFirst, 'the answer\'s key is the next read\'s');
    assert.equal((await boardOfBlock()).view.rowsKey, afterFirst, 'and the week\'s board\'s');

    // The page adds the second lesson on the answer's key: the answer's lessons plus the new one, no read in between.
    const second = await write([...held.lessons, thursday]);
    afterSecond = second.rowsKey;
    assert.notEqual(afterSecond, afterFirst);
    assert.deepEqual(textOf(held.lessons), textOf([tuesday, thursday]), 'the lessons come back in the week\'s order');
    assert.equal((await boardOfBlock()).view.rowsKey, afterSecond);

    // A move of the first lesson a quarter of an hour: the list is the answer's lessons, the moved one changed, every other as it stands.
    const moved = await write(held.lessons.map((one, at) => (at === 0 ? { ...one, startTime: '10:15' } : one)));
    afterMove = moved.rowsKey;
    assert.notEqual(afterMove, afterSecond);
    assert.deepEqual(textOf(held.lessons), textOf([{ ...tuesday, startTime: '10:15' }, thursday]));
    assert.ok(moved.verdicts.length === 6 && moved.verdicts.every((verdict) => verdict.ok), 'a verdict for each of the two lessons and three members, all holding');
    assert.equal((await blocks.listOfBlock(blockId, admin)).rowsKey, afterMove);
    assert.equal((await boardOfBlock()).view.rowsKey, afterMove);
    assert.equal((await storedRows()).length, 2);
  });

  await check('bw-b: the week\'s board and every member\'s count follow each write', async () => {
    const { board, view } = await boardOfBlock();
    assert.deepEqual([view.memberIds.length, view.cannotPlace, view.rows.length], [3, null, 2]);
    assert.ok(view.rows.every((row) => row.verdicts.length === 3 && row.verdicts.every((verdict) => verdict.ok)), 'a verdict for every member on every lesson');
    for (const id of members) {
      const part = board.posts.find((candidate) => candidate.id === id)!.parts[0]!;
      assert.deepEqual([part.count, part.placed, part.left], [2, 2, 0], `post ${id} after two lessons`);
    }
    // One lesson fewer: the page's own estimate (placed down by one, left up by one) is what the next read says.
    await write(held.lessons.slice(0, 1));
    const after = await boardOfBlock();
    for (const id of members) {
      const part = after.board.posts.find((candidate) => candidate.id === id)!.parts[0]!;
      assert.deepEqual([part.placed, part.left], [1, 1], `post ${id} after one lesson`);
    }
    assert.equal(after.view.rowsKey, held.key);
    // Put it back for the next steps, on the chained key.
    await write([...held.lessons, thursday]);
    assert.equal((await boardOfBlock()).view.rows.length, 2);
  });

  await check('bw-c: undo and redo are PUTs on the key OUR last write left; somebody else\'s write after ours makes the step a 409 and writes nothing', async () => {
    // The history of three steps, as the page holds it: the lists before and after each.
    await clear();
    const l0: Lesson[] = [];
    const l1 = [tuesday];
    const l2 = [tuesday, thursday];
    const w1 = await write(l1);
    const w2 = await write(l2);
    assert.notEqual(w1.rowsKey, w2.rowsKey);
    // Undo the last step: the list before it, on our last key (not on a key read now).
    const undone = await write(l1, ours);
    assert.deepEqual(textOf(undone.placements.map(lessonOf)), textOf(l1));
    assert.equal((await boardOfBlock()).view.rowsKey, undone.rowsKey);
    // Redo it: the list after it, on the key the undo left.
    const redone = await write(l2, ours);
    assert.deepEqual(textOf(redone.placements.map(lessonOf)), textOf(l2));
    // And the first step: the empty list.
    const gone = await write(l0, ours);
    assert.equal(gone.rowsKey, emptyKey, 'the empty list has the empty key again');
    assert.equal((await storedRows()).length, 0);
    await write(l2, ours);

    // Somebody else writes the block (another administrator, through the same service on a key they read).
    const theirs = await blocks.replace(blockId, { placements: [lesson(3, '09:00', []), lesson(5, '09:00', [])], baseKey: ours } as never, admin);
    assert.notEqual(theirs.rowsKey, ours);
    const before = await fingerprint();
    // Our undo is made on OUR last key, which is not the block's now.
    const refused = await refusalOf(blocks.replace(blockId, { placements: l1, baseKey: ours } as never, admin));
    assert.equal(refused.getStatus(), 409);
    assert.equal(codeOf(refused), 'BLOCK_PLACEMENTS_STALE');
    assert.deepEqual(paramsOf(refused), {}, 'no params: the page needs none');
    assert.equal(await fingerprint(), before, 'nothing was written over their change');
    // What the week then shows is a key that is not ours (the page throws its history away).
    assert.notEqual((await boardOfBlock()).view.rowsKey, ours);
    assert.equal((await boardOfBlock()).view.rowsKey, theirs.rowsKey);
    await read();
    await write([]);
  });

  await check('bw-d: a lesson carries its rooms back: a move writes every other lesson with its rooms, and one sent with none loses them', async () => {
    await read();
    const a = lesson(2, '10:00', [{ requirementId: spanska, roomId: sal1 }]);
    const b = lesson(4, '13:30', [{ requirementId: tyska, roomId: sal2 }, { requirementId: franska, roomId: sal1 }]);
    await write([a, b]);
    assert.equal((await roomRows()).length, 3);
    // Moving A: the page sends A moved with its rooms, and B as it stands, with ITS rooms.
    await write(held.lessons.map((one, at) => (at === 0 ? { ...one, dayOfWeek: 3 } : one)));
    assert.deepEqual(textOf(held.lessons), textOf([{ ...a, dayOfWeek: 3 }, b]));
    assert.equal((await roomRows()).length, 3, 'every room is still there');
    // A member that chose no room has none, and the engine chooses: only the members that chose are sent.
    await write(held.lessons.map((one, at) => (at === 1 ? { ...one, rooms: one.rooms.filter((room) => room.requirementId !== franska) } : one)));
    assert.deepEqual(await roomRows(), [spanska, tyska].sort().map((id) => ({ requirementId: id, roomId: id === spanska ? sal1 : sal2 })).sort((x, y) => (x.requirementId < y.requirementId ? -1 : 1)));
    // A lesson sent with no rooms has none: B's room is gone, A's stays. (A builder that drops them loses the block's choices.)
    await write(held.lessons.map((one, at) => (at === 1 ? { ...one, rooms: [] } : one)));
    assert.deepEqual(await roomRows(), [{ requirementId: spanska, roomId: sal1 }]);
    await write([]);
  });

  await check('bw-e: every empty block has one key, and two writers of the first lesson who both hold it see each other as stale: exactly one saves, six rounds', async () => {
    const empty = await blocks.listOfBlock(emptyBlockId, admin);
    assert.equal(empty.rowsKey, emptyKey, 'the empty key is one key for every block');
    for (let round = 0; round < 6; round++) {
      await clear();
      const base = held.key;
      assert.equal(base, emptyKey);
      const outcomes = await Promise.allSettled([
        blocks.replace(blockId, { placements: [tuesday], baseKey: base } as never, admin),
        blocks.replace(blockId, { placements: [lesson(3, '10:00', [])], baseKey: base } as never, admin),
      ]);
      const saved = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const refused = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      assert.equal(saved.length, 1, `round ${round}: ${saved.length} writers saved`);
      assert.ok(refused[0]!.reason instanceof HttpException && codeOf(refused[0]!.reason) === 'BLOCK_PLACEMENTS_STALE', `round ${round}: ${summarise(refused[0]!.reason)}`);
      assert.equal((await storedRows()).length, 1, `round ${round}: one lesson`);
    }
    await clear();
  });

  await check('bw-f: a write while Generera holds the year\'s regeneration lock is 409 SCHEDULE_BUSY and writes nothing, and goes through once the lock is released', async () => {
    await read();
    const key = held.key;
    const before = await fingerprint();
    const rewrite = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
    await rewrite.connect();
    try {
      await rewrite.query('BEGIN');
      // What Generera's write holds for its whole transaction (lockYearForRegeneration).
      await rewrite.query(`SELECT pg_advisory_xact_lock(hashtext('grundschema-regenerate'), hashtext($1::uuid::text))`, [year]);
      const busy = await refusalOf(blocks.replace(blockId, { placements: [tuesday], baseKey: key } as never, admin));
      assert.equal(busy.getStatus(), 409);
      assert.equal(codeOf(busy), 'SCHEDULE_BUSY');
      assert.equal(await fingerprint(), before, 'the refused write changed nothing');
    } finally {
      await rewrite.query('ROLLBACK').catch(() => undefined);
      await rewrite.end();
    }
    // The same write, with the same key, goes through once the lock is gone.
    const done = await blocks.replace(blockId, { placements: [tuesday], baseKey: key } as never, admin);
    assert.equal((await storedRows()).length, 1);
    assert.equal(done.rowsKey, (await blocks.listOfBlock(blockId, admin)).rowsKey);
    await clear();
  });

  await check('bw-g: the indexes the page maps: a verdict\'s index in an answer is the lesson\'s place in the ANSWER (day, start), a refusal\'s index is its place in the list that was SENT', async () => {
    await read();
    // Two lessons: Wednesday 10:00 (A) first, Thursday 13:30 (B). The first is made to stop holding: Spanska's teacher has a lesson then.
    const a = lesson(3, '10:00', []);
    const b = lesson(4, '13:30', []);
    await write([a, b]);
    const aLock = await lock(0, 3, '10:00', '10:30');
    const monLock = await lock(1, 1, '08:00', '09:00');
    try {
      const stored = await blocks.listOfBlock(blockId, admin);
      assert.deepEqual(redOf(stored.verdicts), [[0, spanska, 'TEACHER']], 'the read names A, which is the first of the stored lessons');
      assert.deepEqual(stored.placements.map((view) => [view.dayOfWeek, view.startTime]), [[3, '10:00'], [4, '13:30']]);

      // The page moves B earlier in the week, to Monday 08:00: it sends [A, B moved] (B keeps its place in the list) and the answer is in the
      // week's order, [B moved, A]. B moved is refused: Tyska's teacher has a lesson then. The refusal's index is B's place in the SENT list.
      const before = await fingerprint();
      const sent = [a, { ...b, dayOfWeek: 1, startTime: '08:00' }];
      const refused = await refusalOf(blocks.replace(blockId, { placements: sent, baseKey: stored.rowsKey } as never, admin));
      assert.equal(codeOf(refused), 'BLOCK_PLACEMENT_REFUSED');
      assert.deepEqual([paramsOf(refused)['index'], paramsOf(refused)['requirementId'], paramsOf(refused)['reason']], [1, tyska, 'TEACHER'], 'the SENT list\'s place (1), not the answer\'s (0)');
      assert.equal(await fingerprint(), before, 'nothing was written');

      // A length the block has none of (the fit's rule), sent second: the index is again the sent list's.
      const wrong = await refusalOf(blocks.replace(blockId, { placements: [a, { ...b, dayOfWeek: 2, startTime: '08:00', minutes: 50 }], baseKey: stored.rowsKey } as never, admin));
      assert.equal(codeOf(wrong), 'BLOCK_PLACEMENTS_DO_NOT_FIT');
      assert.deepEqual([paramsOf(wrong)['reason'], paramsOf(wrong)['index']], ['LENGTH', 1]);

      // With the clash gone the same list is saved, and now the answer is in the week's order while the list was not: A stands red.
      await unlock([monLock]);
      const answer = await blocks.replace(blockId, { placements: sent, baseKey: stored.rowsKey } as never, admin);
      assert.deepEqual(answer.placements.map((view) => [view.dayOfWeek, view.startTime]), [[1, '08:00'], [3, '10:00']], 'answered in (day, start) order, not in the order sent');
      assert.deepEqual(redOf(answer.verdicts), [[1, spanska, 'TEACHER']], 'A, which was sent FIRST, is at index 1 of the answer');
      assert.deepEqual([answer.placements[1]!.dayOfWeek, answer.placements[1]!.startTime], [3, '10:00'], 'and that index names Wednesday 10:00');
      // The read and the week's board say the same, by the same index.
      const reread = await blocks.listOfBlock(blockId, admin);
      assert.deepEqual(redOf(reread.verdicts), redOf(answer.verdicts));
      const { view } = await boardOfBlock();
      assert.deepEqual(view.rows.map((row) => [row.dayOfWeek, row.startTime, row.verdicts.some((verdict) => !verdict.ok)]), [[1, '08:00', false], [3, '10:00', true]], 'the board lists the lessons in the same order, a red one with a verdict that is not ok');
    } finally {
      await unlock([aLock, monLock]);
    }
    await clear();
  });

  await check('bw-h: a block whose two lessons stopped holding is mended one at a time on chained keys; a new lesson beside one that stands is refused, one that touches neither is let through', async () => {
    await read();
    const a = lesson(3, '10:00', []);
    const b = lesson(4, '13:30', []);
    await write([a, b]);
    const locks = [await lock(0, 3, '10:00', '10:30'), await lock(1, 4, '13:30', '14:00')];
    try {
      await read();
      assert.deepEqual(redOf((await blocks.listOfBlock(blockId, admin)).verdicts), [[0, spanska, 'TEACHER'], [1, tyska, 'TEACHER']], 'the read names both');

      // A new lesson that meets the red one A at Wednesday 10:00 (and not the teacher's lesson, which ends 10:30): refused, at its place in the list.
      const beside = await refusalOf(blocks.replace(blockId, { placements: [a, lesson(3, '10:45', [])], baseKey: held.key } as never, admin));
      assert.equal(codeOf(beside), 'BLOCK_PLACEMENT_REFUSED');
      assert.deepEqual([paramsOf(beside)['index'], paramsOf(beside)['requirementId'], paramsOf(beside)['reason']], [1, spanska, 'TEACHER'], 'a new lesson beside a red one is refused: the judge sees every row');

      // Mend A: move it to Friday; B stands, red, and is named at ITS place in the answer (the week's order puts it first).
      const mendedA = await write([lesson(5, '09:00', []), held.lessons[1]!]);
      assert.deepEqual(mendedA.placements.map((view) => [view.dayOfWeek, view.startTime]), [[4, '13:30'], [5, '09:00']]);
      assert.deepEqual(redOf(mendedA.verdicts), [[0, tyska, 'TEACHER']], 'B stands and is named at index 0; the moved lesson holds');

      // Mend B on the key of that answer, with no read: every lesson holds.
      const mendedB = await write(held.lessons.map((one, at) => (at === 0 ? { ...one, dayOfWeek: 1, startTime: '09:00' } : one)));
      assert.ok(mendedB.verdicts.every((verdict) => verdict.ok), 'nothing stands red any more');

      // A lesson that touches neither teacher's lessons holds beside one that stands. The lessons are put back as they were (the locks gone,
      // so that Wednesday 10:00 can be saved), and Spanska's teacher is given the lesson again: Wednesday's stands, red, and Friday's is new.
      await unlock(locks.splice(0));
      await write([a]);
      locks.push(await lock(0, 3, '10:00', '10:30'));
      assert.deepEqual(redOf((await blocks.listOfBlock(blockId, admin)).verdicts), [[0, spanska, 'TEACHER']]);
      const added = await write([...held.lessons, lesson(5, '14:00', [])]);
      assert.deepEqual(redOf(added.verdicts), [[0, spanska, 'TEACHER']], 'A stands and is named; the new lesson holds');
      assert.equal(added.placements.length, 2);
    } finally {
      await unlock(locks);
    }
    await clear();
  });

  await check('bw-i: the member a refusal names is the member, also when the lesson is sent last (requirementId, not a place)', async () => {
    await read();
    // Franska's teacher has a lesson of another class on Tuesday 09:00: a lesson of the block there is refused for Franska and for nobody else.
    const franskaLock = await lock(2, 2, '09:00', '10:00');
    try {
      const refused = await refusalOf(blocks.replace(blockId, { placements: [lesson(3, '10:00', []), lesson(2, '09:30', [])], baseKey: held.key } as never, admin));
      assert.equal(codeOf(refused), 'BLOCK_PLACEMENT_REFUSED');
      assert.deepEqual([paramsOf(refused)['index'], paramsOf(refused)['requirementId'], paramsOf(refused)['reason']], [1, franska, 'TEACHER']);
      // The other members are not named.
      assert.ok(![spanska, tyska].includes(String(paramsOf(refused)['requirementId'])));
    } finally {
      await unlock([franskaLock]);
    }
  });
}

void main();
