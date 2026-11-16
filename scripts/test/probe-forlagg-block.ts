/**
 * Förlagda block through Nest's own injection, against Postgres, with the engine on the wire (PR C1).
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   JWT_SECRET=… JWT_ISSUER=https://ci.invalid/auth/v1 AI_ENGINE_API_KEY=… NODE_ENV=test \
 *   npx ts-node --transpile-only scripts/test/probe-forlagg-block.ts
 *
 * WHY THIS EXISTS. The unit specs of the block's förläggningar mock Prisma, so they cannot see the two new tables, their
 * keys, the trigger BP409, or what two writers do at once. This boots the application the way main.ts does (AppModule is the
 * first src import, as in probe-forlagda-poster.ts) and asks it, on a real database and under row security, for what a school
 * does with a parallel block: lay one of its lessons, read it, be refused, generate, and change the block under it.
 *
 * The engine is a node:http server on 127.0.0.1 that AI_ENGINE_URL names before the application is read. It records every request
 * as it arrived on the wire and answers /v1/schedule the way the real engine does with a pin: the pinned lesson at its weekday
 * and start, in the room it names, or in the engine's choice (the last room) when it names none; every other lesson on a place
 * of its own.
 *
 * A block of three posts (Spanska, Tyska, Franska, two lessons of 60 minutes each, a teacher and a room each):
 *
 *   fb-a  one lesson (Tuesday 10:00, 60 min) saves through BlockPlacementsService.replace, with a room for Spanska only: one
 *         placement row, one room row, a verdict ok for each of the three members, a rowsKey, the block's lengths;
 *   fb-b  the read and the week's board say the same, and a member's count reads the block's lesson as placed (placed 1, left 1);
 *   fb-c  refusals, each writing nothing: a length the block has none of (LENGTH, at its index), a third lesson of 60 (COUNT),
 *         a new lesson the members' week cannot hold because two members share a teacher (BLOCK_PLACEMENT_REFUSED, with the
 *         member named), and a room that is not the school's (400);
 *   fb-d  the post's own rule stays: a row of Spanska's own in the block is refused REQUIREMENT_PLACEMENTS_DO_NOT_FIT BLOCK, at
 *         the gateway and, as the owner, by the database (FP409);
 *   fb-e  the database's own rule, as the owner: a lesson of 50 minutes is refused BP409 LENGTH, and a room row for a post that is
 *         not a member BP409 MEMBER;
 *   fb-f  two writers at once with the same baseKey, ten times: exactly one saves and the other is BLOCK_PLACEMENTS_STALE;
 *   fb-g  Generera sends each member's lesson as a pinned lesson at the same place k, day and start, with Spanska's room in the
 *         anonymous id and the others with none, no fixed lesson, no `placements`, the blockId on all three, the post's lessons
 *         whole, and the grundschema holds one locked, generated, fromPlacement lesson for each member on Tuesday 10:00, Spanska's
 *         in its room, and no twin;
 *   fb-h  the board's "kvar" plus the pinned lessons is what Generera sent (the figure on the page is the figure sent);
 *   fb-i  a second Generera writes the lessons again (new ids, still three);
 *   fb-j  a real lock on one member's lesson refuses the run by name (BLOCK_PARTLY_LOCKED) before the engine is woken;
 *   fb-k  a lesson of the block changed while the solver ran is GENERATE_STALE, and nothing is written;
 *   fb-l  a post that joins the block has the lesson at once, its room chosen by the engine, and is written too;
 *   fb-m  a post that leaves the block takes only its own room row, the block's lessons and the others' rows stay;
 *   fb-n  the placed block card is not moved by hand (LESSON_IS_PLACED), and the block can still be locked and unlocked;
 *   fb-o  a room a member chose is not removed, and the refusal names the block;
 *   fb-p  a block whose two lessons both stopped holding is mended one lesson at a time (the lesson the block has stands, named
 *         red in the answer and in the read), a new or changed lesson that does not hold is still refused, and Generera refuses
 *         the standing one by name before the engine is woken (review of #326 in #328).
 *
 * A step that fails prints its FAIL line and the run goes on; the steps share the world, so a failure early on may take later ones
 * with it. The exit code is 1 for any FAIL. Independent of what earlier CI steps left in the database: it works in a school of its
 * own, planted and dropped by this probe. 2095/96, so no date of its year is behind the clock.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import 'reflect-metadata';
import { HttpException, type INestApplicationContext } from '@nestjs/common';
import { Client } from 'pg';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';

const SLUG = 'probe-forlagg-block';
const API_KEY = process.env['AI_ENGINE_API_KEY'] ?? 'probe-engine-key';

// ---------------------------------------------------------------------------
// The engine, on the wire
// ---------------------------------------------------------------------------

interface WirePin {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  roomId?: string;
}

interface WireRequirement {
  id: string;
  studentGroupId: string;
  teacherId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  lessonLengths?: number[];
  blockId?: string;
  pinnedLessons?: (WirePin | null)[];
}

interface WireBody {
  requestId: string;
  requirements: WireRequirement[];
  rooms: Array<{ id: string; capacity: number | null }>;
  fixedLessons: unknown[];
  placements?: unknown;
}

interface WireCall {
  method: string;
  path: string;
  apiKey: string | undefined;
  body: WireBody;
}

const clockOf = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;

/** The answer of an engine that holds pins: the pinned lesson where it is pinned, every other lesson on a place of its own. */
function answerOf(body: WireBody) {
  const lessons: Array<{ requirementId: string; roomId: string | null; dayOfWeek: number; startTime: string; endTime: string }> = [];
  let n = 0;
  for (const requirement of body.requirements) {
    for (let k = 0; k < requirement.lessonsPerWeek; k++, n++) {
      const pin = requirement.pinnedLessons?.[k] ?? null;
      const minutes = requirement.lessonLengths?.[k] ?? requirement.minutesPerLesson;
      if (pin) {
        // The room the school named, or the engine's own choice: the last room of the request.
        lessons.push({
          requirementId: requirement.id,
          roomId: pin.roomId ?? body.rooms[body.rooms.length - 1]?.id ?? null,
          dayOfWeek: pin.dayOfWeek,
          startTime: pin.startTime,
          endTime: pin.endTime,
        });
        continue;
      }
      const start = 13 * 60 + Math.floor(n / 5) * 60;
      lessons.push({
        requirementId: requirement.id,
        roomId: body.rooms[n % Math.max(body.rooms.length, 1)]?.id ?? null,
        dayOfWeek: (n % 5) + 1,
        startTime: clockOf(start),
        endTime: clockOf(start + minutes),
      });
    }
  }
  return { requestId: body.requestId, status: 'OPTIMAL', lessons, lunches: [], conflicts: null };
}

class EngineStub {
  readonly calls: WireCall[] = [];
  /** Runs once when a request arrives, before it is answered: where a school changes something while the solver runs. */
  onRequest: (() => Promise<void>) | undefined;
  private server: Server | undefined;

  async listen(): Promise<string> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as WireBody;
      const header = request.headers['x-api-key'];
      this.calls.push({ method: request.method ?? '', path: request.url ?? '', apiKey: Array.isArray(header) ? header[0] : header, body });
      if (request.method !== 'POST' || request.url !== '/v1/schedule') return send(404, { code: 'HTTP_404', message: 'Not found.' });
      if (header !== API_KEY) return send(401, { code: 'HTTP_401', message: 'Invalid API key.' });
      if (this.onRequest) {
        const hook = this.onRequest;
        this.onRequest = undefined;
        await hook();
      }
      return send(200, answerOf(body));
    } catch (error) {
      return send(500, { code: 'STUB', message: String(error) });
    }
  }
}

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
  const engine = new EngineStub();
  try {
    await sweep(owner);

    // The environment the application validates when its config module is READ, so before the import below.
    process.env['AI_ENGINE_URL'] = await engine.listen();
    process.env['AI_ENGINE_API_KEY'] = API_KEY;
    process.env['NODE_ENV'] ??= 'test';
    process.env['JWT_SECRET'] ??= 'probe-secret-not-used-by-anything-here';
    process.env['JWT_ISSUER'] ??= 'https://probe.invalid/auth/v1';
    // No background tick of any job: a probe that boots everything must start nothing on its own.
    const { EnvironmentVariables } = await import('../../src/config/env.validation');
    for (const name of Object.keys(new EnvironmentVariables()).filter((key) => key.endsWith('_BACKGROUND'))) {
      process.env[name] = 'off';
    }

    // AppModule is the FIRST file of the application this one reads, as main.ts reads it (see probe-forlagda-poster.ts).
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('../../src/app.module');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    try {
      await run(owner, engine, app);
    } finally {
      await app.close();
    }
  } finally {
    await sweep(owner).catch((error: unknown) => console.error(`the probe's school was not dropped: ${summarise(error)}`));
    await engine.close();
    await owner.end();
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (failures > 0) {
    console.error(`==> Förlagda block probe FAILED: ${failures} step(s) in ${seconds} s`);
    process.exitCode = 1;
  } else {
    console.log(`==> Förlagda block probe passed in ${seconds} s`);
  }
}

async function sweep(owner: Client): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
}

async function run(owner: Client, engine: EngineStub, app: INestApplicationContext): Promise<void> {
  const { Role } = await import('../../src/auth/enums/role.enum');
  const { MasterLessonsService } = await import('../../src/calendar/master-lessons.service');
  const { OptimizationProxyService } = await import('../../src/optimization/optimization-proxy.service');
  const { BlockPlacementsService } = await import('../../src/requirement-placements/block-placements.service');
  const { RequirementPlacementsService } = await import('../../src/requirement-placements/requirement-placements.service');
  const { RoomsService } = await import('../../src/resources/rooms.service');
  const resolve = <T>(token: abstract new (...args: never[]) => T): T => app.get<T>(token as never, { strict: false });
  const masters = resolve(MasterLessonsService);
  const proxy = resolve(OptimizationProxyService);
  const blocks = resolve(BlockPlacementsService);
  const postPlacements = resolve(RequirementPlacementsService);
  const rooms = resolve(RoomsService);

  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  // -------------------------------------------------------------------------
  // The school: three language posts in one block, a class of one pupil each, a teacher and a room each
  // -------------------------------------------------------------------------
  const s = (
    await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Probe förlagda block', $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])
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
       VALUES ($1, $2, $3, 'Block', $4, $5, $6, true, $7, now()) RETURNING id`,
      [s, `${SLUG}-${label}@example.invalid`, label, role, extra.adminProfile ?? null, authId, extra.groupId ?? null],
    );
    return { id: row.id, authId };
  };
  const adminRow = await person('admin', 'SCHOOL_ADMIN', { adminProfile: 'FULL' });
  const teachers = [await person('t1', 'TEACHER'), await person('t2', 'TEACHER'), await person('t3', 'TEACHER'), await person('t4', 'TEACHER')];
  const groups = [await group('FB Spanska 7'), await group('FB Tyska 7'), await group('FB Franska 7'), await group('FB Italienska 7')];
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
  const subjects = [await subject('FB Spanska'), await subject('FB Tyska'), await subject('FB Franska'), await subject('FB Italienska')];
  // A capacity of its own each, so the stub's anonymous room ids can be told apart.
  const room = async (name: string, capacity: number) =>
    (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, capacity, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [s, name, capacity])).id;
  const sal1 = await room('FB sal 1', 30);
  const sal2 = await room('FB sal 2', 32);
  const sal3 = await room('FB sal 3', 34);
  const blockId = (
    await one<{ id: string }>(`INSERT INTO "TeachingBlocks" ("schoolId", "academicYearId", name, "updatedAt") VALUES ($1, $2, 'FB Språkval 7', now()) RETURNING id`, [s, year])
  ).id;
  const post = async (index: number, inBlock: boolean) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "blockId", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 2, 60, $6, now()) RETURNING id`,
        [s, year, subjects[index], groups[index], teachers[index]!.id, inBlock ? blockId : null],
      )
    ).id;
  const spanska = await post(0, true);
  const tyska = await post(1, true);
  const franska = await post(2, true);
  const members = [spanska, tyska, franska];

  // -------------------------------------------------------------------------
  // What the checks read and do
  // -------------------------------------------------------------------------
  interface MasterRow {
    id: string;
    groupId: string;
    roomId: string | null;
    day: number;
    start: string;
    end: string;
    isLocked: boolean;
    isGenerated: boolean;
    fromPlacement: boolean;
  }
  const masterRows = (): Promise<MasterRow[]> =>
    all<MasterRow>(
      `SELECT id, "studentGroupId" AS "groupId", "roomId", "dayOfWeek" AS day, to_char("startTime", 'HH24:MI') AS start,
              to_char("endTime", 'HH24:MI') AS "end", "isLocked", "isGenerated", "fromPlacement"
         FROM "MasterLessons" WHERE "academicYearId" = $1 ORDER BY id`,
      [year],
    );
  const placedOf = async (): Promise<MasterRow[]> => (await masterRows()).filter((row) => row.fromPlacement);
  const fingerprint = async (): Promise<string> =>
    JSON.stringify([
      await all(`SELECT * FROM "MasterLessons" WHERE "academicYearId" = $1 ORDER BY id`, [year]),
      await all(`SELECT id, "dayOfWeek", "startTime", minutes FROM "TeachingBlockPlacements" WHERE "blockId" = $1 ORDER BY id`, [blockId]),
      await all(`SELECT id, "requirementId", "roomId" FROM "TeachingBlockPlacementRooms" WHERE "schoolId" = $1 ORDER BY id`, [s]),
    ]);
  const storedRows = (): Promise<{ id: string; day: number; start: string; minutes: number }[]> =>
    all(`SELECT id, "dayOfWeek" AS day, to_char("startTime", 'HH24:MI') AS start, minutes FROM "TeachingBlockPlacements" WHERE "blockId" = $1 ORDER BY id`, [blockId]);
  const roomRows = (): Promise<{ requirementId: string; roomId: string }[]> =>
    all(`SELECT "requirementId", "roomId" FROM "TeachingBlockPlacementRooms" WHERE "schoolId" = $1 ORDER BY "requirementId"`, [s]);
  const tuesday = (overrides: Record<string, unknown> = {}) => ({
    dayOfWeek: 2,
    startTime: '10:00',
    minutes: 60,
    rooms: [{ requirementId: spanska, roomId: sal1 }],
    ...overrides,
  });
  const generate = () => proxy.triggerScheduling(year, admin);
  const clearBlock = () => blocks.replace(blockId, { placements: [] } as never, admin);
  /** The pin of the one pinned place a requirement was sent with: its index in the list, and the place. */
  const pinOf = (requirement: WireRequirement) => {
    const index = (requirement.pinnedLessons ?? []).findIndex((pin) => pin !== null);
    return index < 0 ? null : { index, pin: requirement.pinnedLessons![index]! };
  };

  // -------------------------------------------------------------------------
  // The checks
  // -------------------------------------------------------------------------
  let key = '';
  await check('fb-a: one lesson of the block saves (Tuesday 10:00, 60 min) with a room for Spanska only, and every member is judged ok', async () => {
    const saved = await blocks.replace(blockId, { placements: [tuesday()] } as never, admin);
    assert.equal(saved.placements.length, 1);
    const lesson = saved.placements[0]!;
    assert.deepEqual([lesson.dayOfWeek, lesson.startTime, lesson.endTime, lesson.minutes, lesson.recurrence], [2, '10:00', '11:00', 60, 'ALL_WEEKS']);
    assert.deepEqual(lesson.rooms.map((r) => [r.requirementId, r.roomId, r.roomName]), [[spanska, sal1, 'FB sal 1']]);
    assert.equal(saved.verdicts.length, 3, 'one verdict per member');
    assert.ok(saved.verdicts.every((verdict) => verdict.ok && verdict.index === 0));
    assert.deepEqual(new Set(saved.verdicts.map((verdict) => verdict.requirementId)), new Set(members));
    assert.match(saved.rowsKey, /^[0-9a-f]{32}$/);
    assert.deepEqual(saved.lengths, [60, 60]);
    assert.equal((await storedRows()).length, 1);
    assert.deepEqual(await roomRows(), [{ requirementId: spanska, roomId: sal1 }]);
    key = saved.rowsKey;
  });

  await check('fb-b: the read and the week say the same, and a member counts the block\'s lesson as placed', async () => {
    const read = await blocks.listOfBlock(blockId, admin);
    assert.equal(read.rowsKey, key);
    assert.ok(read.verdicts.length === 3 && read.verdicts.every((verdict) => verdict.ok));
    const board = await postPlacements.boardOfYear(year, admin);
    const view = board.blocks.find((candidate) => candidate.id === blockId);
    assert.ok(view, 'the block is on the board');
    assert.deepEqual([view.memberIds.length, view.cannotPlace, view.recurrence], [3, null, 'ALL_WEEKS']);
    assert.equal(view.rows.length, 1);
    assert.equal(view.rows[0]!.verdicts.length, 3);
    assert.equal(view.rowsKey, key);
    for (const id of members) {
      const part = board.posts.find((candidate) => candidate.id === id)!.parts[0]!;
      assert.deepEqual([part.count, part.placed, part.left], [2, 1, 1], `post ${id}`);
    }
  });

  await check('fb-c: refusals write nothing: LENGTH, COUNT, a clash between members, a room that is not the school\'s', async () => {
    const before = await fingerprint();
    const wrongLength = await refusalOf(blocks.replace(blockId, { placements: [tuesday(), tuesday({ dayOfWeek: 3, minutes: 40 })] } as never, admin));
    assert.equal(codeOf(wrongLength), 'BLOCK_PLACEMENTS_DO_NOT_FIT');
    assert.deepEqual([paramsOf(wrongLength)['reason'], paramsOf(wrongLength)['index']], ['LENGTH', 1]);
    const tooMany = await refusalOf(
      blocks.replace(blockId, { placements: [tuesday(), tuesday({ dayOfWeek: 3 }), tuesday({ dayOfWeek: 4 })] } as never, admin),
    );
    assert.equal(paramsOf(tooMany)['reason'], 'COUNT');
    assert.equal(paramsOf(tooMany)['index'], 2);
    // Two members that share a teacher cannot sit the same lesson: Tyska is handed to Spanska's teacher. The lesson is a NEW one
    // (Wednesday): the Tuesday the block has already would stand, named red, as a row the block has (fb-p).
    await owner.query(`UPDATE "TeachingRequirements" SET "teacherId" = $2 WHERE id = $1`, [tyska, teachers[0]!.id]);
    try {
      const clash = await refusalOf(blocks.replace(blockId, { placements: [tuesday({ dayOfWeek: 3 })] } as never, admin));
      assert.equal(codeOf(clash), 'BLOCK_PLACEMENT_REFUSED');
      assert.equal(paramsOf(clash)['reason'], 'TEACHER');
      assert.ok([spanska, tyska].includes(String(paramsOf(clash)['requirementId'])), 'the member the clash is found on is named');
      assert.equal(paramsOf(clash)['index'], 0);
    } finally {
      await owner.query(`UPDATE "TeachingRequirements" SET "teacherId" = $2 WHERE id = $1`, [tyska, teachers[1]!.id]);
    }
    const noRoom = await refusalOf(blocks.replace(blockId, { placements: [tuesday({ rooms: [{ requirementId: spanska, roomId: randomUUID() }] })] } as never, admin));
    assert.equal(noRoom.getStatus(), 400);
    assert.equal(await fingerprint(), before, 'nothing was written');
  });

  await check('fb-d: the post\'s own rule stays: a row of Spanska\'s own in the block is refused BLOCK, by the gateway and by the database', async () => {
    const own = await refusalOf(
      postPlacements.replace(spanska, { placements: [{ dayOfWeek: 3, startTime: '09:00', minutes: 60, roomId: sal1, recurrence: 'ALL_WEEKS' }] } as never, admin),
    );
    assert.equal(codeOf(own), 'REQUIREMENT_PLACEMENTS_DO_NOT_FIT');
    assert.equal(paramsOf(own)['reason'], 'BLOCK');
    await assert.rejects(
      owner.query(
        `INSERT INTO "TeachingRequirementPlacements" ("schoolId", "requirementId", "dayOfWeek", "startTime", minutes, "roomId", "updatedAt")
         VALUES ($1, $2, 3, '09:00', 60, $3, now())`,
        [s, spanska, sal1],
      ),
      (error: { code?: string; message?: string }) => error.code === 'FP409' && String(error.message).startsWith('BLOCK'),
    );
  });

  await check('fb-e: the database\'s own rule BP409, as the owner: LENGTH on a lesson of 50 minutes, MEMBER on a room row for a post that is not a member', async () => {
    await assert.rejects(
      owner.query(
        `INSERT INTO "TeachingBlockPlacements" ("schoolId", "blockId", "academicYearId", "dayOfWeek", "startTime", minutes, "updatedAt") VALUES ($1, $2, $3, 4, '09:00', 50, now())`,
        [s, blockId, year],
      ),
      (error: { code?: string; message?: string }) => error.code === 'BP409' && String(error.message).startsWith('LENGTH'),
    );
    const stranger = await post(3, false);
    const placementId = (await storedRows())[0]!.id;
    await assert.rejects(
      owner.query(`INSERT INTO "TeachingBlockPlacementRooms" ("schoolId", "placementId", "requirementId", "roomId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [s, placementId, stranger, sal2]),
      (error: { code?: string; message?: string }) => error.code === 'BP409' && String(error.message).startsWith('MEMBER'),
    );
    await owner.query(`DELETE FROM "TeachingRequirements" WHERE id = $1`, [stranger]);
  });

  await check('fb-f: two writers at once with the same baseKey, ten times: one saves and the other is BLOCK_PLACEMENTS_STALE', async () => {
    for (let round = 0; round < 10; round++) {
      await clearBlock();
      const base = (await blocks.listOfBlock(blockId, admin)).rowsKey;
      const outcomes = await Promise.allSettled([
        blocks.replace(blockId, { placements: [tuesday()], baseKey: base } as never, admin),
        blocks.replace(blockId, { placements: [tuesday({ dayOfWeek: 3 })], baseKey: base } as never, admin),
      ]);
      const saved = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const refused = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      assert.equal(saved.length, 1, `round ${round}: ${saved.length} writers saved`);
      assert.equal(refused.length, 1);
      assert.ok(refused[0]!.reason instanceof HttpException && codeOf(refused[0]!.reason) === 'BLOCK_PLACEMENTS_STALE', `round ${round}: ${summarise(refused[0]!.reason)}`);
      assert.equal((await storedRows()).length, 1);
    }
    await blocks.replace(blockId, { placements: [tuesday()] } as never, admin);
  });

  let sent: WireBody | undefined;
  await check('fb-g: Generera pins every member\'s lesson at the same place k, with Spanska\'s room and no other, and writes it marked', async () => {
    const mark = engine.calls.length;
    const answer = await generate();
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(answer.status), `Generera answered ${answer.status}`);
    sent = engine.calls[mark]!.body;
    assert.deepEqual(sent.fixedLessons, []);
    assert.ok(!('placements' in sent), 'no placements: a pinned lesson is no lock');
    assert.equal(sent.requirements.length, 3);
    assert.ok(sent.requirements.every((requirement) => requirement.lessonsPerWeek === 2), 'the pin keeps the lesson in the post\'s demand');
    const blockIds = new Set(sent.requirements.map((requirement) => requirement.blockId));
    assert.ok(blockIds.size === 1 && !blockIds.has(undefined), 'the block is sent as a block');
    const pins = sent.requirements.map((requirement) => ({ requirement, ...pinOf(requirement)! }));
    assert.ok(pins.every((entry) => entry.pin !== undefined), 'every member has a pinned lesson');
    assert.equal(new Set(pins.map((entry) => entry.index)).size, 1, 'the same place k at every member');
    assert.ok(pins.every((entry) => entry.pin.dayOfWeek === 2 && entry.pin.startTime === '10:00:00' && entry.pin.endTime === '11:00:00'));
    // Spanska's room is in the payload's id (the room of capacity 30); the others name none.
    const room1 = sent.rooms.find((candidate) => candidate.capacity === 30)!.id;
    const withRoom = pins.filter((entry) => entry.pin.roomId !== undefined);
    assert.equal(withRoom.length, 1);
    assert.equal(withRoom[0]!.pin.roomId, room1);
    const placed = await placedOf();
    assert.equal(placed.length, 3, 'one marked lesson for each member');
    assert.ok(placed.every((row) => row.isLocked && row.isGenerated && row.day === 2 && row.start === '10:00' && row.end === '11:00'));
    assert.deepEqual(new Set(placed.map((row) => row.groupId)), new Set([groups[0], groups[1], groups[2]]));
    assert.equal(placed.find((row) => row.groupId === groups[0])!.roomId, sal1);
    assert.ok(placed.filter((row) => row.groupId !== groups[0]).every((row) => row.roomId !== null), 'the engine chose a room for the others');
    assert.equal((await masterRows()).length, 6, 'the members\' six lessons, and no twin of the placed ones');
  });

  await check('fb-h: the board\'s "kvar" plus the pinned lessons is what Generera sent (the figure on the page is the figure sent)', async () => {
    assert.ok(sent);
    const board = await postPlacements.boardOfYear(year, admin);
    // The request names the posts in its own ids, so the two are compared as sorted lists: for each post the count sent is the
    // board's "kvar" plus the pinned lessons, and the board's "lagda" are the pinned lessons.
    const parts = members.map((id) => board.posts.find((candidate) => candidate.id === id)!.parts[0]!);
    const pinnedSent = (requirement: WireRequirement) => (requirement.pinnedLessons ?? []).filter((pin) => pin !== null).length;
    assert.deepEqual(
      sent.requirements.map((requirement) => requirement.lessonsPerWeek).sort(),
      parts.map((part) => part.left + part.placed).sort(),
    );
    assert.deepEqual(sent.requirements.map(pinnedSent).sort(), parts.map((part) => part.placed).sort());
  });

  await check('fb-i: a second Generera writes the lessons again: new ids, still one marked lesson for each member', async () => {
    const before = new Set((await placedOf()).map((row) => row.id));
    const answer = await generate();
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(answer.status));
    const after = await placedOf();
    assert.equal(after.length, 3);
    assert.ok(after.every((row) => !before.has(row.id)), 'written again');
    assert.equal((await masterRows()).length, 6);
  });

  await check('fb-j: a real lock on one member\'s lesson refuses the run by name before the engine is woken', async () => {
    const mark = engine.calls.length;
    const lock = (
      await one<{ id: string }>(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, 4, '13:00', '14:00', true, false, now()) RETURNING id`,
        [s, year, subjects[1], groups[1], teachers[1]!.id, sal3],
      )
    ).id;
    try {
      const answer = await generate();
      assert.equal(engine.calls.length, mark, 'the engine was not woken');
      assert.equal(answer.status, 'INFEASIBLE');
      assert.ok(JSON.stringify(answer.conflicts).includes('BLOCK_PARTLY_LOCKED'), `refused as ${JSON.stringify(answer.conflicts).slice(0, 200)}`);
    } finally {
      await owner.query(`DELETE FROM "MasterLessons" WHERE id = $1`, [lock]);
    }
  });

  await check('fb-k: a lesson of the block changed while the solver ran is GENERATE_STALE, and nothing is written', async () => {
    const lessonsBefore = JSON.stringify(await masterRows());
    engine.onRequest = async () => {
      await owner.query(`UPDATE "TeachingBlockPlacements" SET "startTime" = '11:00', "updatedAt" = now() WHERE "blockId" = $1`, [blockId]);
    };
    try {
      const error = await refusalOf(generate());
      assert.equal(error.getStatus(), 409);
      assert.ok(JSON.stringify(error.getResponse()).includes('GENERATE_STALE'), summarise(error));
      assert.equal(JSON.stringify(await masterRows()), lessonsBefore, 'the grundschema is as it was');
    } finally {
      await owner.query(`UPDATE "TeachingBlockPlacements" SET "startTime" = '10:00', "updatedAt" = now() WHERE "blockId" = $1`, [blockId]);
    }
  });

  let fourth = '';
  await check('fb-l: a post that joins the block has the lesson at once, its room chosen by the engine, and is written too', async () => {
    fourth = await post(3, true);
    const mark = engine.calls.length;
    const answer = await generate();
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(answer.status), `Generera answered ${answer.status}`);
    const body = engine.calls[mark]!.body;
    assert.equal(body.requirements.length, 4);
    const pins = body.requirements.map((requirement) => pinOf(requirement));
    assert.ok(pins.every((entry) => entry !== null));
    assert.equal(new Set(pins.map((entry) => entry!.index)).size, 1, 'the same place k at all four');
    assert.equal(pins.filter((entry) => entry!.pin.roomId !== undefined).length, 1, 'only Spanska names a room');
    const placed = await placedOf();
    assert.equal(placed.length, 4);
    assert.ok(placed.every((row) => row.day === 2 && row.start === '10:00'));
  });

  await check('fb-m: a post that leaves the block takes only its own room row; the block\'s lessons and the others\' rows stay', async () => {
    await owner.query(`INSERT INTO "TeachingBlockPlacementRooms" ("schoolId", "placementId", "requirementId", "roomId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [
      s,
      (await storedRows())[0]!.id,
      fourth,
      sal2,
    ]);
    assert.deepEqual((await roomRows()).map((row) => row.requirementId).sort(), [spanska, fourth].sort());
    await owner.query(`UPDATE "TeachingRequirements" SET "blockId" = NULL WHERE id = $1`, [fourth]);
    assert.deepEqual(await roomRows(), [{ requirementId: spanska, roomId: sal1 }]);
    assert.equal((await storedRows()).length, 1);
    // And Spanska leaving takes its own: the block stays with two members and the lesson.
    await owner.query(`UPDATE "TeachingRequirements" SET "blockId" = NULL WHERE id = $1`, [spanska]);
    assert.deepEqual(await roomRows(), []);
    await owner.query(`UPDATE "TeachingRequirements" SET "blockId" = $2 WHERE id = $1`, [spanska, blockId]);
    assert.equal((await storedRows()).length, 1);
    await owner.query(`DELETE FROM "TeachingRequirements" WHERE id = $1`, [fourth]);
    await blocks.replace(blockId, { placements: [tuesday()] } as never, admin);
  });

  await check('fb-n: the placed block card is not moved by hand (LESSON_IS_PLACED), and the block can still be locked and unlocked', async () => {
    await generate();
    const lessons = (await placedOf()).map((row) => row.id);
    assert.equal(lessons.length, 3);
    const refused = await refusalOf(masters.moveBlockCard({ lessonIds: lessons, dayOfWeek: 3, startTime: '09:00', endTime: '10:00' } as never, admin));
    assert.equal(codeOf(refused), 'LESSON_IS_PLACED');
    assert.ok((await placedOf()).every((row) => row.day === 2 && row.start === '10:00'), 'the card stayed');
    await masters.lockBlock({ blockId, isLocked: false } as never, admin);
    assert.ok((await placedOf()).every((row) => !row.isLocked), 'unlocked');
    await masters.lockBlock({ blockId, isLocked: true } as never, admin);
    assert.ok((await placedOf()).every((row) => row.isLocked), 'locked again');
  });

  await check('fb-o: a room a member chose is not removed, and the refusal names the block', async () => {
    const error = await refusalOf(rooms.remove(sal1, admin));
    assert.equal(error.getStatus(), 400);
    assert.ok(JSON.stringify(error.getResponse()).includes('FB Språkval 7'), summarise(error));
    assert.equal((await all(`SELECT id FROM "Rooms" WHERE id = $1`, [sal1])).length, 1);
  });

  await check('fb-p: a block whose two lessons stopped holding is mended one lesson at a time; a new or changed lesson that does not hold is still refused', async () => {
    await clearBlock();
    // The lessons the earlier steps' Generera wrote are locked lessons of the grundschema that answer the posts' lessons: gone, so that
    // the two lessons below are what the posts have.
    await owner.query(`DELETE FROM "MasterLessons" WHERE "academicYearId" = $1`, [year]);
    const wednesday = { dayOfWeek: 3, startTime: '10:00', minutes: 60, rooms: [] };
    const thursday = { dayOfWeek: 4, startTime: '13:30', minutes: 60, rooms: [] };
    const friday = { dayOfWeek: 5, startTime: '09:00', minutes: 60, rooms: [] };
    const saved = await blocks.replace(blockId, { placements: [wednesday, thursday] } as never, admin);
    assert.ok(saved.verdicts.every((verdict) => verdict.ok), 'both lessons hold when they are saved');
    // Tyska's teacher is given a lesson of another class (kept as it is) at both times: both of the block's lessons stop holding for Tyska.
    const locks: string[] = [];
    for (const [day, from, to] of [[3, '10:00', '11:00'], [4, '13:30', '14:30']] as const) {
      locks.push(
        (
          await one<{ id: string }>(
            `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, false, now()) RETURNING id`,
            [s, year, subjects[3], groups[3], teachers[1]!.id, sal3, day, from, to],
          )
        ).id,
      );
    }
    const redOf = (verdicts: { index: number; requirementId: string; ok: boolean; reason?: string }[]) =>
      verdicts.filter((verdict) => !verdict.ok).map((verdict) => [verdict.index, verdict.requirementId, verdict.reason]);
    try {
      const read = await blocks.listOfBlock(blockId, admin);
      assert.deepEqual(redOf(read.verdicts), [[0, tyska, 'TEACHER'], [1, tyska, 'TEACHER']], 'the read names both');

      // Moving Thursday's lesson to Friday: Wednesday's, red as it was, stands and is named at its place in the answer.
      const mended = await blocks.replace(blockId, { placements: [friday, wednesday], baseKey: read.rowsKey } as never, admin);
      assert.deepEqual(mended.placements.map((row) => row.dayOfWeek), [3, 5], 'the lessons come back by day');
      assert.deepEqual(redOf(mended.verdicts), [[0, tyska, 'TEACHER']], 'Wednesday stands and is named; Friday holds');
      assert.deepEqual(redOf((await blocks.listOfBlock(blockId, admin)).verdicts), redOf(mended.verdicts), 'the read says what the answer said');
      assert.equal((await storedRows()).length, 2);

      // A new lesson that does not hold is refused, though a red one stands in the same request; so is a changed one.
      const before = await fingerprint();
      const added = await refusalOf(blocks.replace(blockId, { placements: [wednesday, thursday] } as never, admin));
      assert.equal(codeOf(added), 'BLOCK_PLACEMENT_REFUSED');
      assert.deepEqual([paramsOf(added)['index'], paramsOf(added)['requirementId'], paramsOf(added)['reason']], [1, tyska, 'TEACHER']);
      const moved = await refusalOf(blocks.replace(blockId, { placements: [{ ...wednesday, startTime: '10:05' }, friday] } as never, admin));
      assert.equal(codeOf(moved), 'BLOCK_PLACEMENT_REFUSED');
      assert.deepEqual([paramsOf(moved)['index'], paramsOf(moved)['requirementId']], [0, tyska]);
      assert.equal(await fingerprint(), before, 'nothing was written');

      // Generera refuses the one that stands, by name, before the engine is woken.
      const mark = engine.calls.length;
      const refused = await generate();
      assert.equal(engine.calls.length, mark, 'the engine was not woken');
      assert.equal(refused.status, 'INFEASIBLE');
      assert.ok(JSON.stringify(refused.conflicts).includes('PLACEMENT_CANNOT_STAND'), `refused as ${JSON.stringify(refused.conflicts).slice(0, 200)}`);
    } finally {
      await owner.query(`DELETE FROM "MasterLessons" WHERE id = ANY($1::uuid[])`, [locks]);
    }
    // With the lock gone the same list holds, and every verdict is ok.
    const clean = await blocks.replace(blockId, { placements: [friday, wednesday] } as never, admin);
    assert.ok(clean.verdicts.every((verdict) => verdict.ok));
    await clearBlock();
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
