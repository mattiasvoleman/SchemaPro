/**
 * Förläggning utan sal (20270213090000) through Nest's own injection, against Postgres, with the REAL engine on the wire:
 * a förläggning that leaves the room to the engine is sent as a pinned lesson (pinnedLessons), the lesson that comes back is
 * written with the room the engine chose, and a week the engine cannot hold is refused with the lessons named.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@127.0.0.1:5604/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@127.0.0.1:5604/schemapro' \
 *   AI_ENGINE_URL=http://127.0.0.1:8805 AI_ENGINE_API_KEY=<the engine's API_KEY> \
 *   JWT_SECRET=… JWT_ISSUER=https://ci.invalid/auth/v1 NODE_ENV=test \
 *   npx ts-node --transpile-only scripts/test/probe-forlagg-utan-sal.ts
 *
 * Needs an engine of this tree (or main from #317) listening at AI_ENGINE_URL: it asks the engine for real. The engine that
 * answers is the unit under test; the stub in (gu-l) is an engine that predates the key.
 *
 *   gu-a  a förläggning with no room saves through the service (roomId left out), reads back with none, and the week shows it;
 *   gu-b  Generera sends the post whole (nothing taken off it) with the pin at the lesson's place and nothing as a lock, and
 *         writes the lesson that came back: on the pin's day and hour, in a room of the right type that is FREE then (the
 *         other is held by a lock), locked, the run's own and marked; no master of the week is double-booked;
 *   gu-c  a second Generera writes it again, and a lesson of the post the engine laid is the engine's;
 *   gu-d  a pair with no room on a half is refused at the save (PAIR_ROOM), and a pair with rooms is saved;
 *   gu-e  two pinned lessons in the one room of a subject at one hour: Generera answers INFEASIBLE naming both by the
 *         school's own names, before anything is written (PLACED_LESSON_IN_THE_WAY_ANY_ROOM);
 *   gu-f  a row changed while the engine solved is GENERATE_STALE, with nothing written;
 *   gu-g  a schemaförslag run and its apply mark the lesson the same way (locked, marked, the candidate's room);
 *   gu-h  a hand change of the room of such a lesson is refused 409 LESSON_IS_PLACED, and a version restore puts it back
 *         as a förlagd lesson (the flag travels with the row);
 *   gu-i  an engine that predates the key answers 422: the run is refused ENGINE_LACKS_PINNED_LESSONS, the week is sent
 *         once and not again without the key, and nothing is written;
 *   gu-j  the same school with the row given a room is the lock it was: no pin on the wire, the room is the school's;
 *   gu-k  the class's meal per part of the läsår (19.7): a pinned lesson with no room across the lunch window in the
 *         autumn and another in the spring give the class one meal in each term, at the hours the pins leave, and the
 *         same two lessons as locks with rooms give the same two meals.
 *
 * A step that fails prints its FAIL line and the run goes on; the steps share the world. The exit code is 1 for any FAIL.
 *
 * Independent of what earlier steps left in the database: a school of its own, planted and dropped by this probe, in the
 * year 2095/96.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import 'reflect-metadata';
import { HttpException, type INestApplicationContext } from '@nestjs/common';
import { Client } from 'pg';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';

const SLUG = 'probe-forlagg-utan-sal';

// ---------------------------------------------------------------------------
// An engine that predates the key, on the wire
// ---------------------------------------------------------------------------

/** What the older engine answers to a requirement it does not know a field of: the body of a pydantic 422. */
const refusesPins = (body: { requirements?: Array<{ pinnedLessons?: unknown }> }) => ({
  code: 'VALIDATION_ERROR',
  message: 'Request payload failed schema validation.',
  details: {
    errors: (body.requirements ?? []).flatMap((requirement, index) =>
      requirement.pinnedLessons === undefined ? [] : [{ type: 'extra_forbidden', loc: ['body', 'requirements', index, 'pinnedLessons'], msg: 'Extra inputs are not permitted' }],
    ),
  },
});

class OlderEngine {
  readonly calls: Array<{ pinned: number }> = [];
  private server: Server | null = null;

  async listen(): Promise<string> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { requirements?: Array<{ pinnedLessons?: unknown }> };
    this.calls.push({ pinned: (body.requirements ?? []).filter((requirement) => requirement.pinnedLessons !== undefined).length });
    response.writeHead(422, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(refusesPins(body)));
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

async function refusalOf(work: Promise<unknown>): Promise<HttpException> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof HttpException, `expected an HttpException, got ${summarise(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'the call was not refused' });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const started = Date.now();
  if (!process.env['AI_ENGINE_URL'] || !process.env['AI_ENGINE_API_KEY']) {
    console.error('AI_ENGINE_URL and AI_ENGINE_API_KEY name the real engine this probe asks.');
    process.exit(2);
  }
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const older = new OlderEngine();
  try {
    await sweep(owner);
    process.env['NODE_ENV'] ??= 'test';
    process.env['JWT_SECRET'] ??= 'probe-secret-not-used-by-anything-here';
    process.env['JWT_ISSUER'] ??= 'https://probe.invalid/auth/v1';
    const { EnvironmentVariables } = await import('../../src/config/env.validation');
    for (const name of Object.keys(new EnvironmentVariables()).filter((key) => key.endsWith('_BACKGROUND'))) {
      process.env[name] = 'off';
    }
    // AppModule first, as main.ts reads it (see probe-forlagda-poster.ts).
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('../../src/app.module');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    try {
      await run(owner, older, app);
    } finally {
      await app.close();
    }
  } finally {
    await sweep(owner).catch((error: unknown) => console.error(`the probe's school was not dropped: ${summarise(error)}`));
    await older.close();
    await owner.end();
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (failures > 0) {
    console.error(`==> Förläggning utan sal probe FAILED: ${failures} step(s) in ${seconds} s`);
    process.exitCode = 1;
  } else {
    console.log(`==> Förläggning utan sal probe passed in ${seconds} s`);
  }
}

async function sweep(owner: Client): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
}

async function run(owner: Client, older: OlderEngine, app: INestApplicationContext): Promise<void> {
  const { Role } = await import('../../src/auth/enums/role.enum');
  const { MasterLessonsService } = await import('../../src/calendar/master-lessons.service');
  const { ScheduleVersionsService } = await import('../../src/calendar/schedule-versions.service');
  const { OptimizationProxyService } = await import('../../src/optimization/optimization-proxy.service');
  const { ScheduleCandidatesService } = await import('../../src/optimization/schedule-candidates.service');
  const { RequirementPlacementsService } = await import('../../src/requirement-placements/requirement-placements.service');
  const resolve = <T>(token: abstract new (...args: never[]) => T): T => app.get<T>(token as never, { strict: false });
  const masters = resolve(MasterLessonsService);
  const versions = resolve(ScheduleVersionsService);
  const proxy = resolve(OptimizationProxyService);
  const candidates = resolve(ScheduleCandidatesService);
  const placements = resolve(RequirementPlacementsService);

  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  // -------------------------------------------------------------------------
  // The school: two classes, four rooms of three types (two gym halls, ONE slöjdsal, classrooms), a teacher each
  // -------------------------------------------------------------------------
  const s = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Probe förläggning utan sal', $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])).id;
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt") VALUES ($1, 'Probe 2095/96', '2095-08-15', '2096-06-10', true, now()) RETURNING id`,
      [s],
    )
  ).id;
  const group = async (name: string) =>
    (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', 7, now()) RETURNING id`, [s, year, name])).id;
  const g7a = await group('GU 7A');
  const g7b = await group('GU 7B');
  const person = async (label: string, role: string, extra: { groupId?: string; adminProfile?: string } = {}) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'Utan sal', $4, $5, $6, true, $7, now()) RETURNING id`,
      [s, `${SLUG}-${label}@example.invalid`, label, role, extra.adminProfile ?? null, authId, extra.groupId ?? null],
    );
    return { id: row.id, authId };
  };
  const adminRow = await person('admin', 'SCHOOL_ADMIN', { adminProfile: 'FULL' });
  const tIdrott = await person('t-idrott', 'TEACHER');
  const tIdrottB = await person('t-idrott-b', 'TEACHER');
  const tSlojdA = await person('t-slojd-a', 'TEACHER');
  const tSlojdB = await person('t-slojd-b', 'TEACHER');
  const tMatte = await person('t-matte', 'TEACHER');
  for (const [label, groupId] of [['p1', g7a], ['p2', g7a], ['p3', g7b], ['p4', g7b]] as const) await person(label, 'STUDENT', { groupId });
  const admin: AuthenticatedUser = {
    authId: adminRow.authId,
    userId: adminRow.id,
    schoolId: s,
    role: Role.SCHOOL_ADMIN,
    adminProfile: 'FULL',
    channel: 'WEB',
    hrRead: false,
  } as AuthenticatedUser;
  const roomType = async (name: string) => (await one<{ id: string }>(`INSERT INTO "RoomTypes" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [s, name])).id;
  const gymType = await roomType('GU Gymnastiksal');
  const slojdType = await roomType('GU Slöjdsal');
  const classType = await roomType('GU Klassrum');
  const room = async (name: string, typeId: string) =>
    (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, capacity, "roomTypeId", "updatedAt") VALUES ($1, $2, 30, $3, now()) RETURNING id`, [s, name, typeId])).id;
  const gym1 = await room('GU Gympasal 1', gymType);
  const gym2 = await room('GU Gympasal 2', gymType);
  const slojd = await room('GU Slöjdsalen', slojdType);
  await room('GU Klassrum 1', classType);
  await room('GU Klassrum 2', classType);
  const subject = async (name: string, typeId: string | null) =>
    (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "requiredRoomTypeId", "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [s, name, typeId])).id;
  const idrott = await subject('GU Idrott', gymType);
  const slojdSubject = await subject('GU Slöjd', slojdType);
  const matte = await subject('GU Matematik', classType);
  const post = async (groupId: string, subjectId: string, teacherId: string, lessons: number, minutes: number) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
        [s, year, subjectId, groupId, teacherId, lessons, minutes],
      )
    ).id;
  const idrottPost = await post(g7a, idrott, tIdrott.id, 2, 60);
  const slojdPostA = await post(g7a, slojdSubject, tSlojdA.id, 2, 60);
  const slojdPostB = await post(g7b, slojdSubject, tSlojdB.id, 2, 60);
  const mattePost = await post(g7a, matte, tMatte.id, 3, 60);
  const demandLessons = 2 + 2 + 2 + 3;
  // The first gym hall is held Wednesday 10:00-11:00 by a lesson 7B's teacher has laid by hand (a lock): the free hall then is the second.
  await owner.query(
    `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, 3, '10:00', '11:00', true, false, now())`,
    [s, year, idrott, g7b, tIdrottB.id, gym1],
  );

  // -------------------------------------------------------------------------
  // What the checks read and do
  // -------------------------------------------------------------------------
  interface MasterRow {
    id: string;
    groupId: string;
    teacherId: string | null;
    roomId: string | null;
    day: number;
    start: string;
    end: string;
    isLocked: boolean;
    isGenerated: boolean;
    fromPlacement: boolean;
    subjectId: string;
  }
  const masterRows = (): Promise<MasterRow[]> =>
    all<MasterRow>(
      `SELECT id, "studentGroupId" AS "groupId", "teacherId", "roomId", "dayOfWeek" AS day, to_char("startTime", 'HH24:MI') AS start,
              to_char("endTime", 'HH24:MI') AS "end", "isLocked", "isGenerated", "fromPlacement", "subjectId"
         FROM "MasterLessons" WHERE "academicYearId" = $1 ORDER BY id`,
      [year],
    );
  const placedOf = async (): Promise<MasterRow[]> => (await masterRows()).filter((row) => row.fromPlacement);
  const fingerprint = async (): Promise<string> =>
    JSON.stringify([
      await all(`SELECT * FROM "MasterLessons" WHERE "academicYearId" = $1 ORDER BY id`, [year]),
      await all(`SELECT id FROM "ScheduleChangeLogs" WHERE "academicYearId" = $1 ORDER BY id`, [year]),
    ]);
  const generate = () => proxy.triggerScheduling(year, admin);
  /** No teacher, class or room is in two places at once among the week's masters (the week has no odd or even lessons). */
  const clashes = async (): Promise<string[]> => {
    const rows = await masterRows();
    const found: string[] = [];
    for (const [i, a] of rows.entries()) {
      for (const b of rows.slice(i + 1)) {
        if (a.day !== b.day || !(a.start < b.end && b.start < a.end)) continue;
        if (a.groupId === b.groupId) found.push(`class ${a.groupId} ${a.start}-${a.end} d${a.day}`);
        if (a.teacherId !== null && a.teacherId === b.teacherId) found.push(`teacher ${a.teacherId} ${a.start}-${a.end} d${a.day}`);
        if (a.roomId !== null && a.roomId === b.roomId) found.push(`room ${a.roomId} ${a.start}-${a.end} d${a.day}`);
      }
    }
    return found;
  };
  const wednesday = { dayOfWeek: 3, startTime: '10:00', minutes: 60, recurrence: 'ALL_WEEKS' as const };
  const idrottNoRoom = [{ ...wednesday }];

  // (gu-a) -------------------------------------------------------------------
  await check('(gu-a) a förläggning with no room saves, reads back with none, and the week shows it', async () => {
    const saved = await placements.replace(idrottPost, { placements: idrottNoRoom }, admin);
    assert.equal(saved.placements.length, 1);
    assert.deepEqual([saved.placements[0]!.roomId, saved.placements[0]!.roomName], [null, null]);
    assert.deepEqual(saved.verdicts, [{ index: 0, ok: true }]);
    const board = await placements.boardOfYear(year, admin);
    assert.deepEqual(board.placements.map((row) => [row.roomId, row.roomName, row.verdict.ok]), [[null, null, true]]);
    assert.equal(board.posts.find((p) => p.id === idrottPost)!.parts[0]!.placed, 1);
  });

  // (gu-b) -------------------------------------------------------------------
  await check('(gu-b) Generera sends the pin and no lock, and writes the lesson that came back in a free room of the right type, locked and marked', async () => {
    const prepared = await prisma_prepare();
    assert.ok(prepared.ready);
    const sent = prepared.payload.requirements.find((r) => r.lessonsPerWeek === 2 && (r as { pinnedLessons?: unknown }).pinnedLessons !== undefined)!;
    assert.ok(sent, 'no post carried the pin');
    assert.equal(sent.lessonsPerWeek, 2, 'the pinned lesson is still the post’s own: nothing is taken off it');
    assert.deepEqual((sent as unknown as { pinnedLessons: unknown }).pinnedLessons, [{ dayOfWeek: 3, startTime: '10:00:00', endTime: '11:00:00' }, null]);
    assert.ok(!('placements' in prepared.payload), 'a pin is no lock: `placements` is only for the locks');
    assert.equal(prepared.payload.fixedLessons.length, 1, 'the one lock is the lesson 7B laid by hand');

    const answer = await generate();
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(answer.status), `Generera answered ${answer.status} ${JSON.stringify(answer.conflicts)}`);
    const placed = await placedOf();
    assert.equal(placed.length, 1, 'one lesson is the förläggning’s');
    const lesson = placed[0]!;
    assert.deepEqual([lesson.day, lesson.start, lesson.end], [3, '10:00', '11:00']);
    assert.equal(lesson.groupId, g7a);
    assert.equal(lesson.teacherId, tIdrott.id);
    assert.equal(lesson.roomId, gym2, 'the first hall is held by a lock then: the engine chose the free one, of the right type');
    assert.ok(lesson.isLocked && lesson.isGenerated && lesson.fromPlacement);
    assert.equal((await masterRows()).length, demandLessons + 1, 'the demand and the lock');
    assert.deepEqual(await clashes(), [], 'the week is clash-free');
  });

  // (gu-c) -------------------------------------------------------------------
  await check('(gu-c) a second Generera writes the lesson again, as the förläggning’s, and the engine’s other lesson of the post as the engine’s', async () => {
    const first = (await placedOf())[0]!;
    await generate();
    const rows = await masterRows();
    const placed = rows.filter((row) => row.fromPlacement);
    assert.equal(placed.length, 1);
    assert.notEqual(placed[0]!.id, first.id, 'it is written again, with a new id');
    assert.deepEqual([placed[0]!.day, placed[0]!.start, placed[0]!.roomId], [3, '10:00', gym2]);
    const others = rows.filter((row) => row.subjectId === idrott && row.groupId === g7a && !row.fromPlacement);
    assert.equal(others.length, 1, 'the post’s other lesson');
    assert.ok(others[0]!.isGenerated && !others[0]!.isLocked && !others[0]!.fromPlacement, 'the engine’s lesson is the engine’s');
    assert.deepEqual(await clashes(), []);
  });

  // (gu-d) -------------------------------------------------------------------
  await check('(gu-d) a pair with no room on a half is refused at the save (PAIR_ROOM), and a pair with rooms is saved', async () => {
    const odd = { dayOfWeek: 1, startTime: '08:00', minutes: 60, recurrence: 'ODD_WEEKS' as const, roomId: slojd };
    const even = { dayOfWeek: 2, startTime: '08:00', minutes: 60, recurrence: 'EVEN_WEEKS' as const };
    const refused = await refusalOf(placements.replace(slojdPostA, { placements: [odd, even] }, admin));
    assert.equal(refused.getStatus(), 409);
    assert.deepEqual(refused.getResponse(), expect409('REQUIREMENT_PLACEMENTS_DO_NOT_FIT', 'PAIR_ROOM', refused));
    assert.equal((await all(`SELECT 1 FROM "TeachingRequirementPlacements" WHERE "requirementId" = $1`, [slojdPostA])).length, 0, 'nothing was written');
    const saved = await placements.replace(slojdPostA, { placements: [odd, { ...even, roomId: slojd }] }, admin);
    assert.equal(saved.placements.length, 2);
    await placements.replace(slojdPostA, { placements: [] }, admin);
  });

  // (gu-e) -------------------------------------------------------------------
  await check('(gu-e) two pinned lessons in the one room of a subject at one hour are refused with both named, and nothing is written', async () => {
    const thursday = { dayOfWeek: 4, startTime: '09:00', minutes: 60, recurrence: 'ALL_WEEKS' as const };
    await placements.replace(slojdPostA, { placements: [thursday] }, admin);
    await placements.replace(slojdPostB, { placements: [thursday] }, admin);
    const before = await fingerprint();
    const answer = await generate();
    assert.equal(answer.status, 'INFEASIBLE', `Generera answered ${answer.status}`);
    const lines = answer.conflicts?.conflicts ?? [];
    const named = lines.filter((line) => line.code === 'PLACED_LESSON_IN_THE_WAY_ANY_ROOM');
    assert.equal(named.length, 2, `the lines: ${JSON.stringify(lines.map((line) => [line.code, line.params]))}`);
    const requirements = named.map((line) => String(line.params?.['requirement'])).sort();
    assert.deepEqual(requirements, ['GU Slöjd för GU 7A', 'GU Slöjd för GU 7B'], 'named by the school’s own names for the posts');
    for (const line of named) assert.deepEqual([line.params?.['day'], line.params?.['start']], [4, '09:00']);
    assert.equal(await fingerprint(), before, 'a refused week writes nothing');
    await placements.replace(slojdPostA, { placements: [] }, admin);
    await placements.replace(slojdPostB, { placements: [] }, admin);
  });

  // (gu-f) -------------------------------------------------------------------
  await check('(gu-f) a row changed while the engine solved is GENERATE_STALE, and nothing is written', async () => {
    const before = await fingerprint();
    const original = proxy.callAiEngine.bind(proxy);
    let moved = false;
    (proxy as unknown as { callAiEngine: typeof proxy.callAiEngine }).callAiEngine = (async (...args: Parameters<typeof proxy.callAiEngine>) => {
      const response = await original(...args);
      if (!moved) {
        moved = true;
        await owner.query(`UPDATE "TeachingRequirementPlacements" SET "roomId" = $2 WHERE "requirementId" = $1`, [idrottPost, gym2]);
      }
      return response;
    }) as typeof proxy.callAiEngine;
    try {
      const refused = await refusalOf(generate());
      assert.equal(refused.getStatus(), 409);
      assert.equal((refused.getResponse() as { code?: string }).code, 'GENERATE_STALE');
    } finally {
      (proxy as unknown as { callAiEngine: typeof proxy.callAiEngine }).callAiEngine = original;
      await owner.query(`UPDATE "TeachingRequirementPlacements" SET "roomId" = NULL WHERE "requirementId" = $1`, [idrottPost]);
    }
    assert.equal(await fingerprint(), before, 'the stale run wrote');
  });

  // (gu-g) -------------------------------------------------------------------
  await check('(gu-g) a schemaförslag run and its apply write the lesson the same way', async () => {
    await generate();
    const { runId } = await candidates.start({ academicYearId: year, count: 1 }, admin);
    for (let tries = 0; candidates.running.includes(runId); tries++) {
      if (tries > 6000) throw new Error('the run never finished');
      await sleep(20);
    }
    const run = await one<{ status: string; errorCode: string | null }>(`SELECT status::text AS status, "errorCode" FROM "ScheduleCandidateRuns" WHERE id = $1`, [runId]);
    assert.equal(run.status, 'SUCCEEDED', `the run ended ${run.status} ${run.errorCode}`);
    const rows = await all<{ id: string }>(`SELECT id FROM "ScheduleCandidates" WHERE "runId" = $1 ORDER BY ordinal`, [runId]);
    assert.ok(rows.length >= 1);
    await candidates.apply(rows[0]!.id, 'DIRECT', admin);
    const placed = await placedOf();
    assert.equal(placed.length, 1);
    assert.deepEqual([placed[0]!.day, placed[0]!.start, placed[0]!.end, placed[0]!.groupId], [3, '10:00', '11:00', g7a]);
    assert.ok(placed[0]!.isLocked && placed[0]!.isGenerated && placed[0]!.fromPlacement);
    assert.equal(placed[0]!.roomId, gym2, 'the room is the candidate’s: the engine’s choice');
    assert.deepEqual(await clashes(), []);
  });

  // (gu-h) -------------------------------------------------------------------
  await check('(gu-h) a hand change of the room is LESSON_IS_PLACED, and a version restore puts the lesson back as a förlagd one', async () => {
    const lesson = (await placedOf())[0]!;
    const refused = await refusalOf(masters.update(lesson.id, { roomId: gym1 } as never, admin));
    assert.equal(refused.getStatus(), 409);
    assert.equal(await one<{ roomId: string }>(`SELECT "roomId" FROM "MasterLessons" WHERE id = $1`, [lesson.id]).then((row) => row.roomId), gym2, 'the refused change wrote');
    const version = await versions.create(year, 'gu-h', admin);
    await owner.query(`DELETE FROM "MasterLessons" WHERE id = $1`, [lesson.id]);
    await versions.restore(version.id, admin);
    const back = await placedOf();
    assert.equal(back.length, 1);
    assert.deepEqual([back[0]!.roomId, back[0]!.day, back[0]!.start, back[0]!.isLocked, back[0]!.fromPlacement], [gym2, 3, '10:00', true, true]);
  });

  // (gu-i) -------------------------------------------------------------------
  await check('(gu-i) an engine that predates the key answers 422: the run is refused, the week is sent once, and nothing is written', async () => {
    const before = await fingerprint();
    const config = (proxy as unknown as { aiConfig: { baseUrl: string } }).aiConfig;
    const real = config.baseUrl;
    config.baseUrl = await older.listen();
    try {
      const refused = await refusalOf(generate());
      assert.equal(refused.getStatus(), 503);
      assert.equal((refused.getResponse() as { code?: string }).code, 'ENGINE_LACKS_PINNED_LESSONS');
    } finally {
      config.baseUrl = real;
    }
    assert.equal(older.calls.length, 1, 'the week was sent more than once');
    assert.equal(older.calls[0]!.pinned, 1, 'the one request carried the pin');
    assert.equal(await fingerprint(), before, 'the refused run wrote');
  });

  // (gu-j) -------------------------------------------------------------------
  await check('(gu-j) the same row given a room is the lock it was: no pin on the wire, the lesson in the school’s room', async () => {
    await placements.replace(idrottPost, { placements: [{ ...wednesday, roomId: gym2 }] }, admin);
    const prepared = await prisma_prepare();
    assert.ok(prepared.ready);
    assert.ok(prepared.payload.requirements.every((r) => !('pinnedLessons' in r)), 'a pin was sent for a row with a room');
    assert.equal(prepared.payload.requirements.find((r) => r.lessonsPerWeek === 1) !== undefined, true, 'the lock is taken off the post');
    assert.ok('placements' in prepared.payload, 'the lock is named in `placements`');
    await generate();
    const placed = await placedOf();
    assert.equal(placed.length, 1);
    assert.equal(placed[0]!.roomId, gym2);
  });

  // (gu-k) -------------------------------------------------------------------
  await check('(gu-k) two pinned lessons with no room across the lunch window, one a term, give the class a meal in each term, as the same lessons as locks do', async () => {
    await owner.query(
      `INSERT INTO "LunchSettings" ("schoolId", "lunchEnabled", "lunchStartTime", "lunchEndTime", "lunchMinutes", "diningSeats", "updatedAt") VALUES ($1, true, '11:00', '12:00', 30, 60, now())`,
      [s],
    );
    await placements.replace(idrottPost, { placements: [] }, admin);
    const temaH = await subject('GU Tema höst', null);
    const temaV = await subject('GU Tema vår', null);
    const tTemaH = await person('t-tema-h', 'TEACHER');
    const tTemaV = await person('t-tema-v', 'TEACHER');
    const dated = async (subjectId: string, teacherId: string, startDate: string | null, endDate: string | null) =>
      (
        await one<{ id: string }>(
          `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "startDate", "endDate", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 1, 30, $6, $7, now()) RETURNING id`,
          [s, year, subjectId, g7a, teacherId, startDate, endDate],
        )
      ).id;
    const autumn = await dated(temaH, tTemaH.id, null, '2095-12-19');
    const spring = await dated(temaV, tTemaV.id, '2096-01-12', null);
    const monday = (start: string, roomId?: string) => ({ dayOfWeek: 1, startTime: start, minutes: 30, recurrence: 'ALL_WEEKS' as const, ...(roomId ? { roomId } : {}) });
    const meals = () =>
      all<{ start: string; end: string; from: string | null; to: string | null }>(
        `SELECT to_char("startTime", 'HH24:MI') AS start, to_char("endTime", 'HH24:MI') AS "end", "startDate"::text AS "from", "endDate"::text AS "to"
           FROM "LunchSittings" WHERE "academicYearId" = $1 AND "studentGroupId" = $2 AND "dayOfWeek" = 1 ORDER BY "startDate" NULLS FIRST, "startTime"`,
        [year, g7a],
      );
    const oneMealATerm = async (label: string) => {
      const answer = await generate();
      assert.ok(['OPTIMAL', 'FEASIBLE'].includes(answer.status), `${label}: Generera answered ${answer.status} ${JSON.stringify(answer.conflicts)}`);
      const rows = await meals();
      assert.equal(rows.length, 2, `${label}: ${JSON.stringify(rows)}`);
      assert.notEqual(rows[0]!.from === rows[1]!.from, true, `${label}: the two meals hold the same weeks ${JSON.stringify(rows)}`);
      return rows.map((row) => `${row.start}-${row.end}`);
    };

    await placements.replace(autumn, { placements: [monday('11:00')] }, admin);
    await placements.replace(spring, { placements: [monday('11:30')] }, admin);
    const prepared = await prisma_prepare();
    assert.ok(prepared.ready);
    assert.equal((prepared.payload as { lunchPerPeriod?: boolean }).lunchPerPeriod, true, 'the meal is planned per part of the läsår');
    const pinned = await oneMealATerm('pins');
    // The autumn's pin takes 11:00-11:30 of the autumn, the spring's 11:30-12:00 of the spring: the meal is the half hour that is left in each.
    assert.deepEqual(pinned, ['11:30-12:00', '11:00-11:30'], 'one meal in each term, at the hour the other term’s pin leaves');
    assert.deepEqual((await placedOf()).filter((row) => row.start === '11:00' || row.start === '11:30').map((row) => row.start).sort(), ['11:00', '11:30']);

    // The same two lessons as locks: each with a room.
    await placements.replace(autumn, { placements: [monday('11:00', gym1)] }, admin);
    await placements.replace(spring, { placements: [monday('11:30', gym2)] }, admin);
    const locked = await oneMealATerm('locks');
    assert.deepEqual(locked, pinned, 'a pinned lesson with no room cuts the year for the meal as the same lesson as a lock does');
    await placements.replace(autumn, { placements: [] }, admin);
    await placements.replace(spring, { placements: [] }, admin);
  });

  /** The fetch alone, as the basis and the payload read it. */
  async function prisma_prepare() {
    const { PrismaService } = await import('../../src/database/prisma.service');
    const prisma = resolve(PrismaService);
    return prisma.withRls(admin, (tx) => proxy.prepareSchedule(tx as never, year, admin));
  }

  /** The body a 409 of the fit rule has: the code, the rule, and the message the school reads. */
  function expect409(code: string, reason: string, error: HttpException): Record<string, unknown> {
    const body = error.getResponse() as Record<string, unknown>;
    assert.equal(body['code'], code);
    assert.equal((body['params'] as { reason?: string } | undefined)?.reason, reason);
    return body;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
