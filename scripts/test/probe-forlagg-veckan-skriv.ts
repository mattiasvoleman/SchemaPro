/**
 * Veckan skriver (A2) through Nest's own injection, against Postgres, with the REAL engine on the wire: ten lessons laid the way
 * the page lays them, then Generera, then the grundschema read against the rows, and an eleventh lesson laid while the solver runs.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@127.0.0.1:5616/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@127.0.0.1:5616/schemapro' \
 *   AI_ENGINE_URL=http://127.0.0.1:8812 AI_ENGINE_API_KEY=<the engine's API_KEY> AI_ENGINE_TIMEOUT_MS=120000 \
 *   JWT_SECRET=… JWT_ISSUER=https://ci.invalid/auth/v1 NODE_ENV=test \
 *   npx ts-node --transpile-only scripts/test/probe-forlagg-veckan-skriv.ts
 *
 * Needs an engine of this tree (or main from #317 and #322, which carry the pinned lesson) listening at AI_ENGINE_URL.
 * Not in CI (the Database job has no engine); the unit specs and probe-forlagda-poster.ts hold the rules there, and this
 * shows that they are the rules of the engine too.
 *
 * WHAT THE PAGE DOES, AND SO WHAT THIS DOES. A lesson laid in the week is a PUT of the post's whole list of förläggningar, the
 * rows already laid with the new one among them, on top of the key the last answer gave (`baseKey` = the answer's `rowsKey`,
 * chained without reading the week again). The first lesson of a post is written on the key of an empty post (the constant
 * `rowsKey` of the week's read). A lesson may name a room or leave it to the engine ("Motorn väljer sal", roomId null); a post
 * that runs odd weeks lays its lessons on odd weeks; a post that shares its lessons gives each row its teacher.
 *
 *   vs-a  ten lessons laid, one PUT each, the key chained from answer to answer, and every PUT is accepted with the verdict ok;
 *         the week's key of every post is the key of the last answer;
 *   vs-b  Generera answers OPTIMAL or FEASIBLE and sends the engine the rows with a room as locks and the rows with none as
 *         pinned lessons (and nothing else of the week as either);
 *   vs-c  the grundschema holds the rows: every row's lesson on its day, start and length, its teacher (the post's, or the
 *         row's own on the shared post), its weeks, locked, generated and marked fromPlacement, in the room the school named
 *         or, where it named none, in a room of the kind the subject needs that nothing else holds then; the week is clash-free
 *         and the demand is written in full;
 *   vs-d  an eleventh lesson laid while the solver runs: the PUT is accepted, Generera's write is refused 409 GENERATE_STALE and
 *         the grundschema is not touched; the next Generera writes eleven.
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

const SLUG = 'probe-forlagg-veckan-skriv';

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
    console.error(`==> Veckan skriver probe FAILED: ${failures} step(s) in ${seconds} s`);
    process.exitCode = 1;
  } else {
    console.log(`==> Veckan skriver probe passed in ${seconds} s`);
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
  const s = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Probe veckan skriver', $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])).id;
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
       VALUES ($1, $2, $3, 'Veckan', $4, $5, $6, true, $7, now()) RETURNING id`,
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

  await check('(vs-a) ten lessons laid one at a time, a PUT of the post\'s whole list each, the key chained from answer to answer', async () => {
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

  await check('(vs-b) Generera sends the rows with a room as locks and the rows with none as pinned lessons', async () => {
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

  const table: string[][] = [];
  await check('(vs-c) Generera answers, and the grundschema holds every row: day, start, length, teacher, weeks, locked and marked, in the named room or one of the right kind that nothing holds then', async () => {
    const answer = await generate();
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(answer.status), `Generera answered ${answer.status} ${JSON.stringify(answer.conflicts)}`);
    const masters = await masterRows();
    assert.equal(masters.length, demandLessons, `${masters.length} lessons in the grundschema for a demand of ${demandLessons}`);
    const placed = masters.filter((master) => master.fromPlacement);
    assert.equal(placed.length, 10, `${placed.length} lessons are marked fromPlacement`);
    const problems: string[] = [];
    for (const lesson of lessons) {
      const row = lesson.row;
      const end = clockOf(Number(row.startTime.slice(0, 2)) * 60 + Number(row.startTime.slice(3)) + row.minutes);
      const found = placed.filter((master) => master.groupId === lesson.groupId && master.subjectId === lesson.subjectId && master.day === row.dayOfWeek && master.start === row.startTime);
      if (found.length !== 1) {
        problems.push(`lesson ${lesson.n}: ${found.length} placed lessons at day ${row.dayOfWeek} ${row.startTime}`);
        table.push([String(lesson.n), lesson.what, `${row.dayOfWeek} ${row.startTime}`, row.roomId ? roomName.get(row.roomId)! : '(motorn)', '-', 'MISSING']);
        continue;
      }
      const master = found[0]!;
      const wrong: string[] = [];
      if (master.end !== end) wrong.push(`ends ${master.end}, not ${end}`);
      if (master.teacherId !== lesson.teacherId) wrong.push('another teacher');
      if (master.recurrence !== row.recurrence) wrong.push(`weeks ${master.recurrence}, not ${row.recurrence}`);
      if (!(master.isLocked && master.isGenerated && master.fromPlacement)) wrong.push(`flags locked=${master.isLocked} generated=${master.isGenerated} fromPlacement=${master.fromPlacement}`);
      if (row.roomId !== null) {
        if (master.roomId !== row.roomId) wrong.push(`room ${master.roomId ? roomName.get(master.roomId) : 'none'}, not the school's ${roomName.get(row.roomId)}`);
      } else {
        if (master.roomId === null) wrong.push('no room was chosen');
        else if (roomTypeOf.get(master.roomId) !== subjectType.get(lesson.subjectId)) wrong.push(`room ${roomName.get(master.roomId)} is not of the subject's kind`);
      }
      if (wrong.length > 0) problems.push(`lesson ${lesson.n}: ${wrong.join('; ')}`);
      table.push([String(lesson.n), lesson.what, `${row.dayOfWeek} ${row.startTime}-${end}`, row.roomId ? roomName.get(row.roomId)! : '(motorn väljer)', master.roomId ? roomName.get(master.roomId)! : '-', wrong.length === 0 ? 'ok' : wrong.join('; ')]);
    }
    assert.deepEqual(problems, []);
    assert.deepEqual(await clashes(), [], 'the week is not clash-free');
    // The lessons nobody laid are the engine's, written and not locked.
    const others = masters.filter((master) => !master.fromPlacement);
    assert.equal(others.length, demandLessons - 10);
    assert.ok(others.every((master) => master.isGenerated && !master.isLocked), 'a lesson nobody laid is locked or not the run\'s');
  });

  await check('(vs-d) an eleventh lesson laid while the solver runs is accepted, and Generera\'s write is refused GENERATE_STALE with the grundschema untouched; the next Generera writes eleven', async () => {
    const before = await fingerprint();
    const original = proxy.callAiEngine.bind(proxy);
    const times: { putStart?: number; putDone?: number; solveDone?: number } = {};
    let eleventh: Awaited<ReturnType<typeof put>> | undefined;
    (proxy as unknown as { callAiEngine: typeof proxy.callAiEngine }).callAiEngine = (async (...args: Parameters<typeof proxy.callAiEngine>) => {
      const solving = original(...args).finally(() => {
        times.solveDone = Date.now();
      });
      // The page's PUT, on top of the key it read, while the engine is solving.
      times.putStart = Date.now();
      eleventh = await put(
        p7,
        [{ dayOfWeek: 2, startTime: '11:00', minutes: 60, roomId: null, recurrence: 'ALL_WEEKS' }],
        await keyOfPost(p7),
      );
      times.putDone = Date.now();
      return solving;
    }) as typeof proxy.callAiEngine;
    try {
      const refused = await generate().then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      assert.ok('error' in refused, `Generera went through over a row laid while it solved: ${JSON.stringify('result' in refused ? refused.result.status : null)}`);
      assert.ok(refused.error instanceof HttpException, summarise(refused.error));
      assert.equal(refused.error.getStatus(), 409);
      assert.equal((refused.error.getResponse() as { code?: string }).code, 'GENERATE_STALE', summarise(refused.error));
    } finally {
      (proxy as unknown as { callAiEngine: typeof proxy.callAiEngine }).callAiEngine = original;
    }
    assert.ok(eleventh && eleventh.verdicts.every((verdict) => verdict.ok), 'the eleventh PUT was not accepted');
    assert.equal(await fingerprint(), before, 'the refused run wrote');
    console.log(`     (the PUT took ${times.putDone! - times.putStart!} ms and was accepted ${times.solveDone! - times.putDone!} ms before the engine answered; negative: after. The write is refused either way: Generera reads the rows again under the year's lock)`);

    const answer = await generate();
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(answer.status), `the next Generera answered ${answer.status}`);
    const placed = (await masterRows()).filter((master) => master.fromPlacement);
    assert.equal(placed.length, 11, `${placed.length} placed lessons after the next Generera`);
    const lesson = placed.find((master) => master.groupId === g8a && master.subjectId === idrott && master.day === 2 && master.start === '11:00')!;
    assert.ok(lesson, 'the eleventh lesson is not written');
    assert.ok(lesson.roomId !== null && roomTypeOf.get(lesson.roomId) === gymType, 'the eleventh lesson (no room named) is not in a gymnastiksal');
    assert.deepEqual(await clashes(), []);
  });

  console.log('\n  #  lektion                                                     tid               vald sal           lagd i sal         utfall');
  for (const row of table) console.log(`  ${row[0]!.padEnd(2)} ${row[1]!.padEnd(58)} ${row[2]!.padEnd(17)} ${row[3]!.padEnd(18)} ${row[4]!.padEnd(18)} ${row[5]}`);
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
