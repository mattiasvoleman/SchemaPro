/**
 * A PAIR in the week (D2) through Nest's own injection, against Postgres, with the REAL engine on the wire: two pairs laid the way
 * the page lays them (the post's whole list with two rows added, on the key that was read), Generera, and what the engine and the
 * grundschema make of them. A pair is one lesson of an every-week post in two places, odd weeks here and even weeks there; the
 * engine cannot hold half a lesson of an every-week post, so a pair is sent as TWO LOCKS of the right parity, the post's demand
 * is one lesson less, and what comes back is two locked, placed lessons that run the weeks they were laid for.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@127.0.0.1:5647/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@127.0.0.1:5647/schemapro' \
 *   AI_ENGINE_URL=http://127.0.0.1:8825 AI_ENGINE_API_KEY=<the engine's API_KEY> AI_ENGINE_TIMEOUT_MS=120000 \
 *   JWT_SECRET=… JWT_ISSUER=https://ci.invalid/auth/v1 NODE_ENV=test \
 *   npx ts-node --transpile-only scripts/test/probe-forlagg-par-motor.ts
 *
 * Needs an engine of this tree listening at AI_ENGINE_URL. Not in CI (the Database job has no engine); probe-forlagg-par.ts holds
 * the database's half of the rules there, and this shows that they are what the real Generera does.
 *
 *   pm-a  two pairs laid, one PUT each, the answers say every row holds, and the week counts each pair as ONE lesson placed;
 *   pm-b  Generera sends each half as a lock of its own parity (no pair is sent as an every-week lock), the post's demand is one
 *         lesson less per pair, and nothing is sent as a pin (a half has a room);
 *   pm-c  Generera answers OPTIMAL or FEASIBLE, and writes each pair as two locked, generated, placed lessons: the odd half on the
 *         odd weeks at its day, start and room, the even half on the even weeks at its own; the posts' other lessons are the
 *         engine's, every week; the engine placed all of the demand (a pair is one lesson of it);
 *   pm-d  the week is clash-free where weeks meet (an odd lesson and an even one may share a time, an every-week lesson meets both),
 *         and the engine laid none of its own lessons over a half;
 *   pm-e  a second Generera writes the same pairs again, on the same days, starts and rooms, as the förläggningar's;
 *   pm-f  a lock of every week on the teacher at the even half's time is refused by name before the engine is woken, with the row
 *         named and nothing written; the same lock on ODD weeks only is no clash (the weeks never meet) and Generera runs;
 *   pm-g  the pair taken away: the lessons the engine wrote for it are the engine's again at the next Generera, and the post is
 *         whole (its full demand placed by the engine).
 *
 * A step that fails prints its FAIL line and the run goes on; the steps share the world. The exit code is 1 for any FAIL.
 * A school of its own, planted and dropped by this probe, in the year 2095/96.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';

const SLUG = 'probe-forlagg-par-motor';

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

async function main(): Promise<void> {
  const started = Date.now();
  if (!process.env['AI_ENGINE_URL'] || !process.env['AI_ENGINE_API_KEY']) {
    console.error('AI_ENGINE_URL and AI_ENGINE_API_KEY name the real engine this probe asks.');
    process.exit(2);
  }
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
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
      await run(owner, app);
    } finally {
      await app.close();
    }
  } finally {
    await sweep(owner).catch((error: unknown) => console.error(`the probe's school was not dropped: ${summarise(error)}`));
    await owner.end();
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (failures > 0) {
    console.error(`==> Par motor probe FAILED: ${failures} step(s) in ${seconds} s`);
    process.exitCode = 1;
  } else {
    console.log(`==> Par motor probe passed in ${seconds} s`);
  }
}

async function sweep(owner: Client): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
}

async function run(owner: Client, app: import('@nestjs/common').INestApplicationContext): Promise<void> {
  const { Role } = await import('../../src/auth/enums/role.enum');
  const { OptimizationProxyService } = await import('../../src/optimization/optimization-proxy.service');
  const { RequirementPlacementsService } = await import('../../src/requirement-placements/requirement-placements.service');
  const { PrismaService } = await import('../../src/database/prisma.service');
  const { rowsKeyOf } = await import('../../src/requirement-placements/placement-rows-key');
  const resolve = <T>(token: abstract new (...args: never[]) => T): T => app.get<T>(token as never, { strict: false });
  const proxy = resolve(OptimizationProxyService);
  const placements = resolve(RequirementPlacementsService);
  const prisma = resolve(PrismaService);

  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  // -------------------------------------------------------------------------
  // The school: two classes, rooms of two kinds, and posts: Matematik 7A (Anna, three lessons, one of them a pair), Biologi 7B
  // (a shared post: Anna two lessons and Bo one, Bo's lesson a pair), and posts nobody lays by hand
  // -------------------------------------------------------------------------
  const s = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Probe par motor', $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])).id;
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt") VALUES ($1, 'Probe 2095/96', '2095-08-15', '2096-06-10', true, now()) RETURNING id`,
      [s],
    )
  ).id;
  const group = async (name: string, grade: number) =>
    (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', $4, now()) RETURNING id`, [s, year, name, grade])).id;
  const g7a = await group('PM 7A', 7);
  const g7b = await group('PM 7B', 7);
  const person = async (label: string, role: string, extra: { groupId?: string; adminProfile?: string } = {}) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'Parmotor', $4, $5, $6, true, $7, now()) RETURNING id`,
      [s, `${SLUG}-${label}@example.invalid`, label, role, extra.adminProfile ?? null, authId, extra.groupId ?? null],
    );
    return { id: row.id, authId };
  };
  const adminRow = await person('admin', 'SCHOOL_ADMIN', { adminProfile: 'SCHEMALAGGARE' });
  const tAnna = await person('t-anna', 'TEACHER');
  const tBo = await person('t-bo', 'TEACHER');
  const tCecilia = await person('t-cecilia', 'TEACHER');
  const tDavid = await person('t-david', 'TEACHER');
  for (const [label, groupId] of [['p1', g7a], ['p2', g7a], ['p3', g7b], ['p4', g7b]] as const) await person(label, 'STUDENT', { groupId });
  const admin: AuthenticatedUser = {
    authId: adminRow.authId,
    userId: adminRow.id,
    schoolId: s,
    role: Role.SCHOOL_ADMIN,
    adminProfile: 'SCHEMALAGGARE',
    channel: 'WEB',
    hrRead: false,
  } as AuthenticatedUser;
  const roomType = async (name: string) => (await one<{ id: string }>(`INSERT INTO "RoomTypes" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [s, name])).id;
  const classType = await roomType('PM Klassrum');
  const labType = await roomType('PM Lab');
  const room = async (name: string, typeId: string) =>
    (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, capacity, "roomTypeId", "updatedAt") VALUES ($1, $2, 30, $3, now()) RETURNING id`, [s, name, typeId])).id;
  const kl1 = await room('PM Klassrum 1', classType);
  const kl2 = await room('PM Klassrum 2', classType);
  const kl3 = await room('PM Klassrum 3', classType);
  await room('PM Klassrum 4', classType);
  const lab = await room('PM Lab', labType);
  const subject = async (name: string, typeId: string) =>
    (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "requiredRoomTypeId", "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [s, name, typeId])).id;
  const matte = await subject('PM Matematik', classType);
  const biologi = await subject('PM Biologi', labType);
  const svenska = await subject('PM Svenska', classType);
  const engelska = await subject('PM Engelska', classType);
  const post = async (groupId: string, subjectId: string, teacherId: string, lessons: number, minutes: number, recurrence = 'ALL_WEEKS') =>
    (
      await one<{ id: string }>(
        `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", recurrence, "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::"LessonRecurrence", now()) RETURNING id`,
        [s, year, subjectId, groupId, teacherId, lessons, minutes, recurrence],
      )
    ).id;
  const mattePost = await post(g7a, matte, tAnna.id, 3, 60);
  const biologiPost = await post(g7b, biologi, tAnna.id, 3, 60);
  await owner.query(`INSERT INTO "TeachingRequirementShares" ("schoolId", "requirementId", "teacherId", lessons, minutes, "updatedAt") VALUES ($1, $2, $3, 1, 60, now())`, [s, biologiPost, tBo.id]);
  const svenskaPost = await post(g7a, svenska, tCecilia.id, 3, 60, 'ODD_WEEKS');
  const engelskaPost = await post(g7b, engelska, tDavid.id, 3, 60);
  const demandOf = new Map([[mattePost, 3], [biologiPost, 3], [svenskaPost, 3], [engelskaPost, 3]]);

  // -------------------------------------------------------------------------
  // What the checks read
  // -------------------------------------------------------------------------
  interface MasterRow {
    id: string;
    groupId: string;
    subjectId: string;
    teacherId: string | null;
    roomId: string | null;
    day: number;
    start: string;
    end: string;
    isLocked: boolean;
    isGenerated: boolean;
    fromPlacement: boolean;
    recurrence: string;
  }
  const masterRows = (): Promise<MasterRow[]> =>
    all<MasterRow>(
      `SELECT id, "studentGroupId" AS "groupId", "subjectId", "teacherId", "roomId", "dayOfWeek" AS day, to_char("startTime", 'HH24:MI') AS start,
              to_char("endTime", 'HH24:MI') AS "end", "isLocked", "isGenerated", "fromPlacement", recurrence::text AS recurrence
         FROM "MasterLessons" WHERE "academicYearId" = $1 ORDER BY id`,
      [year],
    );
  const fingerprint = async (): Promise<string> =>
    JSON.stringify([await all(`SELECT * FROM "MasterLessons" WHERE "academicYearId" = $1 ORDER BY id`, [year]), await all(`SELECT id FROM "ScheduleChangeLogs" WHERE "academicYearId" = $1 ORDER BY id`, [year])]);
  const weeksMeet = (a: string, b: string) => a === 'ALL_WEEKS' || b === 'ALL_WEEKS' || a === b;
  /** No teacher, class or room in two places at once among masters whose weeks meet. */
  const clashes = async (): Promise<string[]> => {
    const rows = await masterRows();
    const found: string[] = [];
    for (const [i, a] of rows.entries()) {
      for (const b of rows.slice(i + 1)) {
        if (a.day !== b.day || !(a.start < b.end && b.start < a.end) || !weeksMeet(a.recurrence, b.recurrence)) continue;
        if (a.groupId === b.groupId) found.push(`class ${a.groupId} ${a.start}-${a.end} d${a.day}`);
        if (a.teacherId !== null && a.teacherId === b.teacherId) found.push(`teacher ${a.teacherId} ${a.start}-${a.end} d${a.day}`);
        if (a.roomId !== null && a.roomId === b.roomId) found.push(`room ${a.roomId} ${a.start}-${a.end} d${a.day}`);
      }
    }
    return found;
  };
  const generate = () => proxy.triggerScheduling(year, admin);
  const prepareOf = () => {
    const service = proxy as unknown as {
      prepareSchedule: (tx: unknown, yearId: string, user: AuthenticatedUser) => Promise<{ ready: boolean; payload: { fixedLessons: Array<Record<string, unknown>>; requirements: Array<Record<string, unknown>> } }>;
    };
    return prisma.withRls(admin, (tx) => service.prepareSchedule(tx, year, admin));
  };

  type Row = { dayOfWeek: number; startTime: string; minutes: number; roomId: string | null; recurrence: 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS'; teacherId?: string };
  const half = (recurrence: 'ODD_WEEKS' | 'EVEN_WEEKS', day: number, start: string, roomId: string, teacherId?: string): Row => ({
    dayOfWeek: day,
    startTime: start,
    minutes: 60,
    roomId,
    recurrence,
    ...(teacherId ? { teacherId } : {}),
  });
  // Anna's Matematik: odd weeks Tuesday 10:00, even weeks Thursday 13:15. Bo's Biologi lesson, the shared post's: odd weeks
  // Monday 09:00, even weeks Wednesday 14:00, both in the lab.
  const mattePair = [half('ODD_WEEKS', 2, '10:00', kl1), half('EVEN_WEEKS', 4, '13:15', kl2)];
  const biologiPair = [half('ODD_WEEKS', 1, '09:00', lab, tBo.id), half('EVEN_WEEKS', 3, '14:00', lab, tBo.id)];
  const emptyKey = rowsKeyOf([]);

  // (pm-a) -------------------------------------------------------------------
  await check('(pm-a) two pairs laid, one PUT each on the key read, every row holds, and the week counts each pair as ONE lesson placed', async () => {
    for (const [postId, rows] of [[mattePost, mattePair], [biologiPost, biologiPair]] as const) {
      assert.equal((await placements.listOfPost(postId, admin)).rowsKey, emptyKey, 'the post did not start empty');
      const answer = await placements.replace(postId, { placements: rows, baseKey: emptyKey } as never, admin);
      assert.deepEqual(answer.verdicts.map((verdict) => verdict.ok), [true, true], JSON.stringify(answer.verdicts));
      assert.equal(answer.placements.length, 2);
    }
    const board = await placements.boardOfYear(year, admin);
    assert.ok(board.placements.every((entry) => entry.verdict.ok), 'a row of the week does not hold');
    const mathematics = board.posts.find((entry) => entry.id === mattePost)!.parts;
    assert.deepEqual(mathematics.map((part) => [part.count, part.placed, part.left]), [[3, 1, 2]], 'a pair is one lesson placed');
    const bo = board.posts.find((entry) => entry.id === biologiPost)!.parts.find((part) => part.teacherId === tBo.id)!;
    const anna = board.posts.find((entry) => entry.id === biologiPost)!.parts.find((part) => part.teacherId === tAnna.id)!;
    assert.deepEqual([bo.count, bo.placed, bo.left], [1, 1, 0], "Bo's lesson is the pair");
    assert.deepEqual([anna.count, anna.placed, anna.left], [2, 0, 2], "Anna's two are the engine's");
  });

  // (pm-b) -------------------------------------------------------------------
  await check('(pm-b) Generera sends each half as a lock of its own parity, takes one lesson off each pair’s post, and sends no pin', async () => {
    const prepared = await prepareOf();
    assert.ok(prepared.ready, 'the pre-flight refused two pairs that hold');
    const locks = prepared.payload.fixedLessons;
    assert.equal(locks.length, 4, `${locks.length} fixed lessons for two pairs`);
    const parities = locks.map((lock) => lock['recurrence']).sort();
    assert.deepEqual(parities, ['EVEN_WEEKS', 'EVEN_WEEKS', 'ODD_WEEKS', 'ODD_WEEKS'], 'every half is a lock of its own weeks, none is a lock of every week');
    assert.ok(locks.every((lock) => lock['roomId'] !== null), 'a half is a lock with its room');
    const places = locks.map((lock) => `${String(lock['recurrence'])} d${String(lock['dayOfWeek'])} ${String(lock['startTime']).slice(0, 5)}`).sort();
    assert.deepEqual(places, ['EVEN_WEEKS d3 14:00', 'EVEN_WEEKS d4 13:15', 'ODD_WEEKS d1 09:00', 'ODD_WEEKS d2 10:00']);
    const pinned = prepared.payload.requirements.flatMap((requirement) => ((requirement['pinnedLessons'] as Array<unknown | null> | undefined) ?? []).filter((place) => place !== null));
    assert.equal(pinned.length, 0, 'a half has a room, so it is a lock and never a pin');
    // The demand: Matematik 3 -> 2 and Biologi 3 -> 2 (one lesson of each is the pair), the others whole.
    const lessonsOf = prepared.payload.requirements.map((requirement) => Number(requirement['lessonsPerWeek'])).sort();
    assert.deepEqual(lessonsOf, [2, 2, 3, 3], `the requirements' lessons: ${lessonsOf.join(',')}`);
  });

  // (pm-c) -------------------------------------------------------------------
  await check('(pm-c) Generera writes each pair as two locked, placed lessons that run the weeks they were laid for, and the engine places the rest', async () => {
    const answer = await generate();
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(String(answer.status)), `Generera answered ${answer.status}: ${JSON.stringify(answer.conflicts?.conflicts ?? []).slice(0, 600)}`);
    const rows = await masterRows();
    const placed = rows.filter((row) => row.fromPlacement);
    assert.equal(placed.length, 4, 'two lessons per pair');
    assert.ok(placed.every((row) => row.isLocked && row.isGenerated), 'locked and the run’s own');
    const at = (subjectId: string, recurrence: string) => placed.find((row) => row.subjectId === subjectId && row.recurrence === recurrence)!;
    assert.deepEqual([at(matte, 'ODD_WEEKS').day, at(matte, 'ODD_WEEKS').start, at(matte, 'ODD_WEEKS').roomId], [2, '10:00', kl1], 'the odd half, as laid');
    assert.deepEqual([at(matte, 'EVEN_WEEKS').day, at(matte, 'EVEN_WEEKS').start, at(matte, 'EVEN_WEEKS').roomId], [4, '13:15', kl2], 'the even half, as laid');
    assert.deepEqual([at(biologi, 'ODD_WEEKS').day, at(biologi, 'ODD_WEEKS').start, at(biologi, 'ODD_WEEKS').roomId, at(biologi, 'ODD_WEEKS').teacherId], [1, '09:00', lab, tBo.id], "Bo's odd half");
    assert.deepEqual([at(biologi, 'EVEN_WEEKS').day, at(biologi, 'EVEN_WEEKS').start, at(biologi, 'EVEN_WEEKS').roomId, at(biologi, 'EVEN_WEEKS').teacherId], [3, '14:00', lab, tBo.id], "Bo's even half");
    assert.equal(at(matte, 'ODD_WEEKS').teacherId, tAnna.id);
    // The posts' other lessons are the engine's, and run every week.
    const others = rows.filter((row) => !row.fromPlacement && (row.subjectId === matte || row.subjectId === biologi));
    assert.equal(others.length, 2 + 2, 'two more lessons of Matematik and two of Biologi');
    assert.ok(others.every((row) => row.recurrence === 'ALL_WEEKS' && row.isGenerated && !row.isLocked), 'the engine’s lessons are the engine’s and run every week');
    // The whole demand is placed: a pair is one lesson of it.
    for (const [postId, subjectId] of [[mattePost, matte], [biologiPost, biologi]] as const) {
      const count = rows.filter((row) => row.subjectId === subjectId).length;
      assert.equal(count, demandOf.get(postId)! + 1, `post ${postId}: three lessons are four rows (a pair is two rows)`);
    }
    assert.equal(rows.filter((row) => row.subjectId === svenska).length, 3, 'the odd post is placed whole');
  });

  // (pm-d) -------------------------------------------------------------------
  await check('(pm-d) the week is clash-free where weeks meet, and no lesson of the engine’s is on a half', async () => {
    assert.deepEqual(await clashes(), []);
    const rows = await masterRows();
    for (const row of rows.filter((entry) => entry.fromPlacement)) {
      const over = rows.filter((other) => other.id !== row.id && other.day === row.day && other.start < row.end && row.start < other.end && weeksMeet(other.recurrence, row.recurrence));
      assert.deepEqual(over, [], `something stands on the half at d${row.day} ${row.start}`);
    }
  });

  // (pm-e) -------------------------------------------------------------------
  await check('(pm-e) a second Generera writes the same pairs again, as the förläggningar’s, on the same days, starts and rooms', async () => {
    const before = (await masterRows()).filter((row) => row.fromPlacement).map((row) => [row.subjectId, row.recurrence, row.day, row.start, row.roomId, row.teacherId].join('|')).sort();
    const answer = await generate();
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(String(answer.status)), `the second Generera answered ${answer.status}`);
    const after = (await masterRows()).filter((row) => row.fromPlacement).map((row) => [row.subjectId, row.recurrence, row.day, row.start, row.roomId, row.teacherId].join('|')).sort();
    assert.deepEqual(after, before);
    assert.deepEqual(await clashes(), []);
  });

  // (pm-f) -------------------------------------------------------------------
  await check('(pm-f) an every-week lock on the teacher at a half’s time is refused by name, nothing is written; the same lock on ODD weeks at the EVEN half’s time is no clash', async () => {
    const before = await fingerprint();
    // Anna's even half is Thursday 13:15. A lock of every week of hers on the same time meets it.
    const lock = async (recurrence: string) =>
      one<{ id: string }>(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", recurrence, "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, 4, '13:15', '14:15', true, false, $7::"LessonRecurrence", now()) RETURNING id`,
        [s, year, engelska, g7b, tAnna.id, kl3, recurrence],
      );
    const every = await lock('ALL_WEEKS');
    const refused = await generate();
    assert.equal(refused.status, 'INFEASIBLE', `Generera answered ${refused.status}`);
    const named = (refused.conflicts?.conflicts ?? []).filter((line) => line.category === 'PLACEMENT' || String(line.code).includes('PLACEMENT'));
    assert.ok(named.length > 0, `no line named the row: ${JSON.stringify((refused.conflicts?.conflicts ?? []).map((line) => [line.code, line.category]))}`);
    await owner.query(`DELETE FROM "MasterLessons" WHERE id = $1`, [every.id]);
    // Nothing of the refused week was written: the masters are what they were, less the lock that was added and taken away.
    assert.equal(await fingerprint(), before, 'a refused week writes nothing');
    // On odd weeks only the lock meets the odd half (Tuesday) and not the even one (Thursday): no clash.
    await lock('ODD_WEEKS');
    const allowed = await generate();
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(String(allowed.status)), `an odd-weeks lock at the even half's time is no clash, Generera answered ${allowed.status}: ${JSON.stringify(allowed.conflicts?.conflicts ?? []).slice(0, 400)}`);
    await owner.query(`DELETE FROM "MasterLessons" WHERE id = $1`, [(await all<{ id: string }>(`SELECT id FROM "MasterLessons" WHERE "academicYearId" = $1 AND "teacherId" = $2 AND "dayOfWeek" = 4 AND "startTime" = '13:15' AND NOT "fromPlacement" AND recurrence = 'ODD_WEEKS'`, [year, tAnna.id]))[0]!.id]);
    assert.deepEqual((await masterRows()).filter((row) => row.fromPlacement).length, 4, 'the pairs stand');
  });

  // (pm-g) -------------------------------------------------------------------
  await check('(pm-g) the pair taken away: its lessons are the engine’s at the next Generera, and the post is whole', async () => {
    const key = (await placements.listOfPost(mattePost, admin)).rowsKey;
    await placements.replace(mattePost, { placements: [], baseKey: key } as never, admin);
    const answer = await generate();
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(String(answer.status)), `Generera answered ${answer.status}`);
    const rows = (await masterRows()).filter((row) => row.subjectId === matte);
    assert.equal(rows.length, 3, 'three lessons, the whole demand, all the engine’s');
    assert.ok(rows.every((row) => !row.fromPlacement && row.recurrence === 'ALL_WEEKS'), 'none is a half');
    assert.deepEqual(await clashes(), []);
    // Bo's pair is still a pair.
    assert.equal((await masterRows()).filter((row) => row.fromPlacement && row.subjectId === biologi).length, 2);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
