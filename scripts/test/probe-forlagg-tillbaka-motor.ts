/**
 * Generera and the grundschema point back to the week (A3) through Nest's own injection, against Postgres, with the REAL engine on the
 * wire: ten lessons laid the way the page lays them (as probe-forlagg-veckan-skriv.ts does), Generera, and then what the week and
 * Generera's page are told about it.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@127.0.0.1:5628/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@127.0.0.1:5628/schemapro' \
 *   AI_ENGINE_URL=http://127.0.0.1:8819 AI_ENGINE_API_KEY=<the engine's API_KEY> AI_ENGINE_TIMEOUT_MS=120000 \
 *   JWT_SECRET=… JWT_ISSUER=https://ci.invalid/auth/v1 NODE_ENV=test \
 *   npx ts-node --transpile-only scripts/test/probe-forlagg-tillbaka-motor.ts
 *
 * Needs an engine of this tree listening at AI_ENGINE_URL. Not in CI (the Database job has no engine); the adapter probe's vv10 and
 * vv11 hold the same rules there, against the database alone, and this shows that they are what the real Generera does.
 *
 *   vt-a  ten lessons laid, one PUT each, the key chained; Generera answers OPTIMAL or FEASIBLE; the board's `timetable` says ten
 *         lessons written and a time after the run started, and the week's sentence says nothing (the rows are what was written from);
 *   vt-b  a lock planted beside a row (the post's own lesson held somewhere else by its teacher), then Generera: the pre-flight refuses
 *         by name, the line says the post's own id and the row's day and start (as the stored line the page reads says them), the link
 *         built from it reads back as a row of the week's board, and the week says "ändrat" for nothing it did not do (nothing changed);
 *   vt-c  a row taken away: the board still says ten written and the rows are nine, so the week says it; Generera again writes nine,
 *         `writtenAt` moves, and the sentence goes.
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
import { linkTargetOf, markedRowOf, placementLinkOfRefusal } from '../../web/lib/placement-link';
import { changedSinceRun } from '../../web/lib/placement-since-run';

const SLUG = 'probe-forlagg-tillbaka';

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
    console.error(`==> Tillbaka probe FAILED: ${failures} step(s) in ${seconds} s`);
    process.exitCode = 1;
  } else {
    console.log(`==> Tillbaka probe passed in ${seconds} s`);
  }
}

async function sweep(owner: Client): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
}

async function run(owner: Client, app: import('@nestjs/common').INestApplicationContext): Promise<void> {
  const { Role } = await import('../../src/auth/enums/role.enum');
  const { OptimizationProxyService } = await import('../../src/optimization/optimization-proxy.service');
  const { RequirementPlacementsService } = await import('../../src/requirement-placements/requirement-placements.service');
  const { rowsKeyOf } = await import('../../src/requirement-placements/placement-rows-key');
  const resolve = <T>(token: abstract new (...args: never[]) => T): T => app.get<T>(token as never, { strict: false });
  const proxy = resolve(OptimizationProxyService);
  const placements = resolve(RequirementPlacementsService);

  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  // -------------------------------------------------------------------------
  // The school: three classes, four teachers' worth of subjects, rooms of three kinds, a post that shares its lessons,
  // a post that runs odd weeks, and posts nobody lays by hand
  // -------------------------------------------------------------------------
  const s = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Probe tillbaka', $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])).id;
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt") VALUES ($1, 'Probe 2095/96', '2095-08-15', '2096-06-10', true, now()) RETURNING id`,
      [s],
    )
  ).id;
  const group = async (name: string, grade: number) =>
    (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', $4, now()) RETURNING id`, [s, year, name, grade])).id;
  const g7a = await group('VS 7A', 7);
  const g7b = await group('VS 7B', 7);
  const g8a = await group('VS 8A', 8);
  const person = async (label: string, role: string, extra: { groupId?: string; adminProfile?: string } = {}) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'Tillbaka', $4, $5, $6, true, $7, now()) RETURNING id`,
      [s, `${SLUG}-${label}@example.invalid`, label, role, extra.adminProfile ?? null, authId, extra.groupId ?? null],
    );
    return { id: row.id, authId };
  };
  const adminRow = await person('admin', 'SCHOOL_ADMIN', { adminProfile: 'SCHEMALAGGARE' });
  const tIdrott = await person('t-idrott', 'TEACHER');
  const tIdrott8 = await person('t-idrott-8', 'TEACHER');
  const tMatte = await person('t-matte', 'TEACHER');
  const tMatte7b = await person('t-matte-7b', 'TEACHER');
  const tSvenska = await person('t-svenska', 'TEACHER');
  const tSvenska8 = await person('t-svenska-8', 'TEACHER');
  const tEngelska = await person('t-engelska', 'TEACHER');
  const tAnna = await person('t-anna', 'TEACHER');
  const tBo = await person('t-bo', 'TEACHER');
  const tSlojd = await person('t-slojd', 'TEACHER');
  for (const [label, groupId] of [['p1', g7a], ['p2', g7a], ['p3', g7b], ['p4', g7b], ['p5', g8a], ['p6', g8a]] as const) await person(label, 'STUDENT', { groupId });
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
  const gymType = await roomType('VS Gymnastiksal');
  const slojdType = await roomType('VS Slöjdsal');
  const classType = await roomType('VS Klassrum');
  const room = async (name: string, typeId: string) =>
    (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, capacity, "roomTypeId", "updatedAt") VALUES ($1, $2, 30, $3, now()) RETURNING id`, [s, name, typeId])).id;
  const gym1 = await room('VS Gympasal 1', gymType);
  await room('VS Gympasal 2', gymType);
  const slojd = await room('VS Slöjdsalen', slojdType);
  const kl1 = await room('VS Klassrum 1', classType);
  const kl2 = await room('VS Klassrum 2', classType);
  const kl3 = await room('VS Klassrum 3', classType);
  await room('VS Klassrum 4', classType);
  const subject = async (name: string, typeId: string) =>
    (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "requiredRoomTypeId", "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [s, name, typeId])).id;
  const idrott = await subject('VS Idrott', gymType);
  const slojdSubject = await subject('VS Slöjd', slojdType);
  const matte = await subject('VS Matematik', classType);
  const svenska = await subject('VS Svenska', classType);
  const engelska = await subject('VS Engelska', classType);
  const biologi = await subject('VS Biologi', classType);
  const post = async (groupId: string, subjectId: string, teacherId: string, lessons: number, minutes: number, recurrence = 'ALL_WEEKS') =>
    (
      await one<{ id: string }>(
        `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", recurrence, "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::"LessonRecurrence", now()) RETURNING id`,
        [s, year, subjectId, groupId, teacherId, lessons, minutes, recurrence],
      )
    ).id;
  const p1 = await post(g7a, idrott, tIdrott.id, 2, 60);
  const p2 = await post(g7a, matte, tMatte.id, 3, 60);
  const p3 = await post(g7b, svenska, tSvenska.id, 2, 60, 'ODD_WEEKS');
  // Delade lektioner: 7B biologi, three lessons of 40, Anna's two and Bo's one.
  const p4 = await post(g7b, biologi, tAnna.id, 3, 40);
  await owner.query(
    `INSERT INTO "TeachingRequirementShares" ("schoolId", "requirementId", "teacherId", lessons, minutes, "updatedAt") VALUES ($1, $2, $3, 1, 40, now())`,
    [s, p4, tBo.id],
  );
  const p5 = await post(g7b, slojdSubject, tSlojd.id, 2, 60);
  const p6 = await post(g7a, engelska, tEngelska.id, 2, 45);
  // The eleventh lesson's post, and posts nobody lays by hand (the solver has the rest of the week to place).
  const p7 = await post(g8a, idrott, tIdrott8.id, 2, 60);
  await post(g7b, matte, tMatte7b.id, 3, 60);
  await post(g8a, svenska, tSvenska8.id, 3, 50);
  const demandLessons = 2 + 3 + 2 + 3 + 2 + 2 + 2 + 3 + 3;

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
  const roomTypeOf = new Map((await all<{ id: string; roomTypeId: string }>(`SELECT id, "roomTypeId" FROM "Rooms" WHERE "schoolId" = $1`, [s])).map((r) => [r.id, r.roomTypeId]));
  const roomName = new Map((await all<{ id: string; name: string }>(`SELECT id, name FROM "Rooms" WHERE "schoolId" = $1`, [s])).map((r) => [r.id, r.name]));
  const subjectType = new Map([[idrott, gymType], [slojdSubject, slojdType], [matte, classType], [svenska, classType], [engelska, classType], [biologi, classType]]);
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
        if (a.roomId !== null && a.roomId === b.roomId) found.push(`room ${roomName.get(a.roomId!)} ${a.start}-${a.end} d${a.day}`);
      }
    }
    return found;
  };

  // -------------------------------------------------------------------------
  // The ten lessons, as the page lays them: the post's list so far, plus one, on top of the last answer's key
  // -------------------------------------------------------------------------
  type Row = { dayOfWeek: number; startTime: string; minutes: number; roomId: string | null; recurrence: 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS'; teacherId?: string };
  interface Lesson {
    n: number;
    postId: string;
    what: string;
    row: Row;
    /** The teacher the lesson is held by: the row's own on the shared post, else the post's. */
    teacherId: string;
    subjectId: string;
    groupId: string;
  }
  const lessons: Lesson[] = [
    { n: 1, postId: p1, what: 'Idrott 7A, sal vald', row: { dayOfWeek: 1, startTime: '08:00', minutes: 60, roomId: gym1, recurrence: 'ALL_WEEKS' }, teacherId: tIdrott.id, subjectId: idrott, groupId: g7a },
    { n: 2, postId: p1, what: 'Idrott 7A, Motorn väljer sal', row: { dayOfWeek: 3, startTime: '10:00', minutes: 60, roomId: null, recurrence: 'ALL_WEEKS' }, teacherId: tIdrott.id, subjectId: idrott, groupId: g7a },
    { n: 3, postId: p2, what: 'Matematik 7A, sal vald', row: { dayOfWeek: 2, startTime: '09:00', minutes: 60, roomId: kl1, recurrence: 'ALL_WEEKS' }, teacherId: tMatte.id, subjectId: matte, groupId: g7a },
    { n: 4, postId: p2, what: 'Matematik 7A, Motorn väljer sal', row: { dayOfWeek: 4, startTime: '09:00', minutes: 60, roomId: null, recurrence: 'ALL_WEEKS' }, teacherId: tMatte.id, subjectId: matte, groupId: g7a },
    { n: 5, postId: p3, what: 'Svenska 7B, udda veckor, sal vald', row: { dayOfWeek: 1, startTime: '10:00', minutes: 60, roomId: kl2, recurrence: 'ODD_WEEKS' }, teacherId: tSvenska.id, subjectId: svenska, groupId: g7b },
    { n: 6, postId: p3, what: 'Svenska 7B, udda veckor, Motorn väljer sal', row: { dayOfWeek: 3, startTime: '13:00', minutes: 60, roomId: null, recurrence: 'ODD_WEEKS' }, teacherId: tSvenska.id, subjectId: svenska, groupId: g7b },
    { n: 7, postId: p4, what: 'Biologi 7B, Bos lektion (delad post), sal vald', row: { dayOfWeek: 4, startTime: '10:00', minutes: 40, roomId: kl3, recurrence: 'ALL_WEEKS', teacherId: tBo.id }, teacherId: tBo.id, subjectId: biologi, groupId: g7b },
    { n: 8, postId: p4, what: 'Biologi 7B, Annas lektion (delad post), Motorn väljer sal', row: { dayOfWeek: 5, startTime: '08:00', minutes: 40, roomId: null, recurrence: 'ALL_WEEKS', teacherId: tAnna.id }, teacherId: tAnna.id, subjectId: biologi, groupId: g7b },
    { n: 9, postId: p5, what: 'Slöjd 7B, Motorn väljer sal', row: { dayOfWeek: 5, startTime: '10:00', minutes: 60, roomId: null, recurrence: 'ALL_WEEKS' }, teacherId: tSlojd.id, subjectId: slojdSubject, groupId: g7b },
    { n: 10, postId: p6, what: 'Engelska 7A, sal vald', row: { dayOfWeek: 1, startTime: '13:00', minutes: 45, roomId: kl1, recurrence: 'ALL_WEEKS' }, teacherId: tEngelska.id, subjectId: engelska, groupId: g7a },
  ];
  const withRoom = lessons.filter((lesson) => lesson.row.roomId !== null);
  const withoutRoom = lessons.filter((lesson) => lesson.row.roomId === null);
  const keyOfPost = async (postId: string): Promise<string> => (await placements.listOfPost(postId, admin)).rowsKey;
  const put = (postId: string, rows: Row[], baseKey: string) => placements.replace(postId, { placements: rows, baseKey } as never, admin);
  const generate = () => proxy.triggerScheduling(year, admin);

  await check('(vt-0) ten lessons laid one at a time, a PUT of the post\'s whole list each, the key chained from answer to answer', async () => {
    const chain = new Map<string, { key: string; rows: Row[] }>();
    const emptyKey = rowsKeyOf([]);
    for (const lesson of lessons) {
      const held = chain.get(lesson.postId) ?? { key: emptyKey, rows: [] };
      if (!chain.has(lesson.postId)) assert.equal(await keyOfPost(lesson.postId), emptyKey, `post of lesson ${lesson.n} did not start empty`);
      const rows = [...held.rows, lesson.row];
      const answer = await put(lesson.postId, rows, held.key);
      assert.deepEqual(
        answer.verdicts.map((verdict) => verdict.ok),
        rows.map(() => true),
        `lesson ${lesson.n} (${lesson.what}): ${JSON.stringify(answer.verdicts)}`,
      );
      assert.equal(answer.placements.length, rows.length, `lesson ${lesson.n}: the answer lists ${answer.placements.length} rows`);
      assert.notEqual(answer.rowsKey, held.key, `lesson ${lesson.n}: the key did not move with the save`);
      chain.set(lesson.postId, { key: answer.rowsKey, rows });
    }
    // The key the last answer of each post gave is the key the post and the week have now.
    const board = await placements.boardOfYear(year, admin);
    for (const [postId, held] of chain) {
      assert.equal(await keyOfPost(postId), held.key, `the key of ${postId} is not the last answer's`);
      assert.equal(board.posts.find((entry) => entry.id === postId)!.rowsKey, held.key, `the week's key of ${postId} is not the last answer's`);
    }
    assert.equal(board.placements.length, 10);
    assert.ok(board.placements.every((entry) => entry.verdict.ok), 'a row of the week does not hold');
    assert.equal(board.posts.find((entry) => entry.id === p7)!.rowsKey, emptyKey, 'a post nobody laid has the key of an empty one');
  });

  await check('(vt-0b) Generera sends the rows with a room as locks and the rows with none as pinned lessons', async () => {
    const prepared = await prepareOf();
    assert.ok(prepared.ready, 'the pre-flight refused a week of ten rows that hold');
    const payload = prepared.payload;
    assert.equal(payload.fixedLessons.length, withRoom.length, `${payload.fixedLessons.length} fixed lessons for ${withRoom.length} rows with a room`);
    const pinned = (payload.requirements as Array<{ pinnedLessons?: Array<unknown | null> }>).flatMap((requirement) => (requirement.pinnedLessons ?? []).filter((place) => place !== null));
    assert.equal(pinned.length, withoutRoom.length, `${pinned.length} pinned lessons for ${withoutRoom.length} rows with no room`);
  });
  async function prepareOf() {
    const proxyService = proxy as unknown as { prepareSchedule: (tx: unknown, yearId: string, user: AuthenticatedUser) => Promise<{ ready: boolean; payload: { fixedLessons: unknown[]; requirements: unknown[] } }> };
    const { PrismaService } = await import('../../src/database/prisma.service');
    const api = resolve(PrismaService);
    return api.withRls(admin, (tx) => proxyService.prepareSchedule(tx, year, admin));
  }

  const stored = async () => {
    const { storedOf, conflictView } = await import('../../src/optimization/stored-conflicts');
    return { storedOf, conflictView };
  };
  const OPTIMAL = (finishedAt: string) => [{ status: 'SUCCEEDED', solverStatus: 'OPTIMAL', finishedAt }];
  let startedAt = 0;
  let wroteAt = '';

  await check('(vt-a) after Generera the board says ten lessons written, after the run started, and the week says nothing about a change', async () => {
    const board0 = await placements.boardOfYear(year, admin);
    assert.deepEqual(board0.timetable, { placedLessons: 0, writtenAt: null }, 'before a run');
    startedAt = Date.now();
    const answer = await generate();
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(answer.status), `Generera answered ${answer.status}`);
    const board = await placements.boardOfYear(year, admin);
    assert.equal(board.timetable.placedLessons, 10, 'ten lessons written from the ten rows');
    assert.ok(board.timetable.writtenAt !== null && new Date(board.timetable.writtenAt).getTime() >= startedAt - 2000, `written at ${board.timetable.writtenAt}, the run started at ${new Date(startedAt).toISOString()}`);
    assert.ok(new Date(board.timetable.writtenAt!).getTime() <= Date.now() + 2000);
    const newest = await one<{ at: Date }>(`SELECT max("createdAt") AS at FROM "MasterLessons" WHERE "academicYearId" = $1 AND "fromPlacement"`, [year]);
    assert.equal(board.timetable.writtenAt, newest.at.toISOString());
    wroteAt = board.timetable.writtenAt!;
    assert.equal(changedSinceRun(board, OPTIMAL(wroteAt)), false, 'the rows are what the grundschema was written from');
    assert.equal(changedSinceRun(board, []), false);
  });

  await check('(vt-b) a lock beside a row: Generera refuses by name, the line carries the post and the row\'s place, and the link reads back as a row of the week', async () => {
    // Matematik 7A\'s teacher is held on Tuesday 09:00 (lesson 3) by a locked hand-made lesson of another class.
    await owner.query(
      `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 2, '09:00', '10:00', true, false, now())`,
      [s, year, matte, g8a, tMatte.id, kl2],
    );
    const before = await fingerprint();
    const answer = await generate();
    assert.equal(answer.status, 'INFEASIBLE', `Generera answered ${answer.status}`);
    assert.equal(answer.conflicts?.summaryCode, 'PLACEMENTS_REFUSED_SUMMARY');
    assert.equal(await fingerprint(), before, 'a refused run wrote nothing');
    const { storedOf, conflictView } = await stored();
    const lines = (answer.conflicts?.conflicts ?? []).map((detail) => conflictView(storedOf(detail)));
    assert.equal(lines.length, 1, `${lines.length} lines for one row that does not hold`);
    const line = lines[0]!;
    assert.equal(line.category, 'PLACEMENT');
    assert.equal(line.params?.['postId'], p2, 'the post\'s own id, through the stored line the page reads');
    assert.equal(line.params?.['day'], 2);
    assert.equal(line.params?.['start'], '09:00');
    assert.ok(!('blockId' in (line.params ?? {})));
    const href = placementLinkOfRefusal(line.params, null)!;
    assert.ok(href, 'a link');
    const target = linkTargetOf(href.slice(href.indexOf('?')))!;
    const board = await placements.boardOfYear(year, admin);
    const row = markedRowOf(board.placements, target);
    assert.ok(row, `the link ${href} is no row of the week`);
    assert.equal(row!.requirementId, p2);
    assert.equal(row!.verdict.ok, false, 'and it is the row that does not hold');
    assert.equal(changedSinceRun(board, OPTIMAL(wroteAt)), false, 'nothing was changed: a refusal is no change of the rows');
    console.log(`     (the link: ${href})`);
  });

  await check('(vt-c) a row taken away: the board still says ten written and the rows are nine; Generera writes nine, writtenAt moves, and the sentence goes', async () => {
    await owner.query(`DELETE FROM "MasterLessons" WHERE "academicYearId" = $1 AND "isGenerated" = false AND "isLocked" = true`, [year]);
    const cut = await placements.listOfPost(p1, admin);
    const kept = cut.placements.filter((entry) => !(entry.dayOfWeek === 3 && entry.startTime.slice(0, 5) === '10:00'));
    assert.equal(kept.length, cut.placements.length - 1);
    await placements.replace(
      p1,
      { placements: kept.map((entry) => ({ dayOfWeek: entry.dayOfWeek, startTime: entry.startTime.slice(0, 5), minutes: entry.minutes, roomId: entry.roomId, recurrence: entry.recurrence })), baseKey: cut.rowsKey } as never,
      admin,
    );
    const board = await placements.boardOfYear(year, admin);
    assert.equal(board.placements.length, 9);
    assert.equal(board.timetable.placedLessons, 10, 'the removed row\'s lesson still stands in the grundschema');
    assert.equal(changedSinceRun(board, OPTIMAL(wroteAt)), true, 'nine rows for ten lessons written: the week says it');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const answer = await generate();
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(answer.status), `Generera answered ${answer.status}`);
    const after = await placements.boardOfYear(year, admin);
    assert.equal(after.timetable.placedLessons, 9);
    assert.ok(new Date(after.timetable.writtenAt!).getTime() > new Date(wroteAt).getTime(), 'written later');
    assert.equal(changedSinceRun(after, OPTIMAL(after.timetable.writtenAt!)), false);
  });

}

const clockOf = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

main().then(
  () => {
    process.exit(process.exitCode ?? 0);
  },
  (error: unknown) => {
    console.error(`FAIL ${summarise(error)}`);
    process.exit(1);
  },
);
