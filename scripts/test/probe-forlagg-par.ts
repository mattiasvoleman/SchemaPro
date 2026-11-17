/**
 * A PAIR in the week (D2) through Nest's own injection, against Postgres: one lesson of an every-week post laid in two places,
 * odd weeks here and even weeks there. The page holds the first half in the browser and writes both halves in ONE write
 * (the post's whole list with two rows added), because the database refuses a lone half and a half with no room. This holds the
 * database and the gateway to what the page relies on.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@127.0.0.1:5647/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@127.0.0.1:5647/schemapro' \
 *   JWT_SECRET=… JWT_ISSUER=https://ci.invalid/auth/v1 NODE_ENV=test \
 *   npx ts-node --transpile-only scripts/test/probe-forlagg-par.ts
 *
 * No engine: the real engine's half is probe-forlagg-par-motor.ts.
 *
 *   gp-a  a pair with rooms is saved by the service in one write, reads back as two rows, and is ONE lesson on the week
 *         (placed 1, left 1); every stored fact is the page's: weeks, day, start, room;
 *   gp-b  the database itself: the two halves in ONE statement are accepted, the same two halves in two statements of one
 *         transaction are not (the first is a lone half: FP409 PAIRS), and a lone half alone is refused whoever writes it;
 *   gp-c  a lone half through the service is refused 409 REQUIREMENT_PLACEMENTS_DO_NOT_FIT with the reason PAIRS and nothing is
 *         written; so is a half of another length, and an even half on a post of odd weeks (WEEKS);
 *   gp-d  a pair with no room on a half is refused (PAIR_ROOM, B2), whichever half it is, and both halves without a room too;
 *   gp-e  a shared post's pair is ONE TEACHER'S: Bo's two halves are saved, an odd half of Bo's and an even half of Anna's
 *         are not (TEACHER_PAIRS) and nothing is written; Bo's pair and Anna's pair of the same length are both saved and
 *         each teacher's part has its own lesson placed; one half of Anna's pair taken away alone is refused;
 *   gp-f  the write is made on the key that was read: a pair on an old key is 409 REQUIREMENT_PLACEMENTS_STALE and nothing is
 *         written (the page keeps its first half and lays the second again);
 *   gp-g  the pair is taken away whole, and a half is never left behind: the lesson is to lay again (left 2).
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

const SLUG = 'probe-forlagg-par';

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

async function main(): Promise<void> {
  const started = Date.now();
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
    console.error(`==> Par probe FAILED: ${failures} step(s) in ${seconds} s`);
    process.exitCode = 1;
  } else {
    console.log(`==> Par probe passed in ${seconds} s`);
  }
}

async function sweep(owner: Client): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
}

async function run(owner: Client, app: import('@nestjs/common').INestApplicationContext): Promise<void> {
  const { Role } = await import('../../src/auth/enums/role.enum');
  const { RequirementPlacementsService } = await import('../../src/requirement-placements/requirement-placements.service');
  const resolve = <T>(token: abstract new (...args: never[]) => T): T => app.get<T>(token as never, { strict: false });
  const placements = resolve(RequirementPlacementsService);

  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  // -------------------------------------------------------------------------
  // The school: a class, three teachers, two rooms, and four posts: an every-week post of two lessons, a post that shares its
  // lessons between two teachers, a post of odd weeks, and a post that is not paired for the length's sake
  // -------------------------------------------------------------------------
  const s = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Probe par', $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])).id;
  // A year that starts on a Saturday, as production's does.
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt") VALUES ($1, 'Probe 2095/96', '2095-08-15', '2096-06-10', true, now()) RETURNING id`,
      [s],
    )
  ).id;
  const g7a = (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, 'GP 7A', 'CLASS', 7, now()) RETURNING id`, [s, year])).id;
  const person = async (label: string, role: string, extra: { groupId?: string; adminProfile?: string } = {}) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'Par', $4, $5, $6, true, $7, now()) RETURNING id`,
      [s, `${SLUG}-${label}@example.invalid`, label, role, extra.adminProfile ?? null, authId, extra.groupId ?? null],
    );
    return { id: row.id, authId };
  };
  const adminRow = await person('admin', 'SCHOOL_ADMIN', { adminProfile: 'SCHEMALAGGARE' });
  const anna = await person('anna', 'TEACHER');
  const bo = await person('bo', 'TEACHER');
  const cecilia = await person('cecilia', 'TEACHER');
  await person('p1', 'STUDENT', { groupId: g7a });
  const admin: AuthenticatedUser = {
    authId: adminRow.authId,
    userId: adminRow.id,
    schoolId: s,
    role: Role.SCHOOL_ADMIN,
    adminProfile: 'SCHEMALAGGARE',
    channel: 'WEB',
    hrRead: false,
  } as AuthenticatedUser;
  const room = async (name: string) => (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, capacity, "updatedAt") VALUES ($1, $2, 30, now()) RETURNING id`, [s, name])).id;
  const a12 = await room('GP A12');
  const b3 = await room('GP B3');
  const subject = async (name: string) => (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [s, name])).id;
  const [matte, slojd, fysik, svenska] = [await subject('GP Matematik'), await subject('GP Slöjd'), await subject('GP Fysik'), await subject('GP Svenska')];
  const post = async (subjectId: string, teacherId: string, lessons: number, minutes: number, recurrence = 'ALL_WEEKS') =>
    (
      await one<{ id: string }>(
        `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", recurrence, "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::"LessonRecurrence", now()) RETURNING id`,
        [s, year, subjectId, g7a, teacherId, lessons, minutes, recurrence],
      )
    ).id;
  const mattePost = await post(matte, anna.id, 2, 60);
  const slojdPost = await post(slojd, bo.id, 3, 60);
  // Anna takes one of the shared post's lessons, Cecilia one; Bo keeps the third.
  for (const teacher of [anna, cecilia]) {
    await owner.query(`INSERT INTO "TeachingRequirementShares" ("schoolId", "requirementId", "teacherId", lessons, minutes, "updatedAt") VALUES ($1, $2, $3, 1, 60, now())`, [s, slojdPost, teacher.id]);
  }
  const fysikPost = await post(fysik, anna.id, 1, 60, 'ODD_WEEKS');
  const svenskaPost = await post(svenska, anna.id, 1, 60);

  const half = (recurrence: 'ODD_WEEKS' | 'EVEN_WEEKS', day: number, start: string, roomId: string | null, extra: Record<string, unknown> = {}) => ({
    dayOfWeek: day,
    startTime: start,
    minutes: 60,
    recurrence,
    ...(roomId === null ? {} : { roomId }),
    ...extra,
  });
  const rowsOf = (id: string) =>
    all<{ day: number; start: string; recurrence: string; roomId: string | null; teacherId: string | null; xmin: string }>(
      `SELECT "dayOfWeek" AS day, to_char("startTime", 'HH24:MI') AS start, recurrence::text AS recurrence, "roomId", "teacherId", xmin::text AS xmin
         FROM "TeachingRequirementPlacements" WHERE "requirementId" = $1 ORDER BY "dayOfWeek", "startTime", recurrence::text`,
      [id],
    );
  const countOf = async (id: string) => (await rowsOf(id)).length;
  const reasonOf = (refused: HttpException): string | undefined => ((refused.getResponse() as Record<string, unknown>)['params'] as { reason?: string } | undefined)?.reason;
  const partsOf = async (id: string) => (await placements.boardOfYear(year, admin)).posts.find((entry) => entry.id === id)!.parts;

  // (gp-a) -------------------------------------------------------------------
  await check('(gp-a) a pair with rooms is saved in one write, reads back as two rows, and is ONE lesson on the week', async () => {
    const saved = await placements.replace(mattePost, { placements: [half('ODD_WEEKS', 2, '10:00', a12), half('EVEN_WEEKS', 4, '13:15', b3)] }, admin);
    assert.equal(saved.placements.length, 2);
    assert.deepEqual(saved.verdicts.map((verdict) => verdict.ok), [true, true]);
    assert.deepEqual(
      saved.placements.map((row) => [row.recurrence, row.dayOfWeek, row.startTime, row.roomId]),
      [['ODD_WEEKS', 2, '10:00', a12], ['EVEN_WEEKS', 4, '13:15', b3]],
    );
    const stored = await rowsOf(mattePost);
    assert.deepEqual(stored.map((row) => [row.recurrence, row.day, row.start, row.roomId]), [['ODD_WEEKS', 2, '10:00', a12], ['EVEN_WEEKS', 4, '13:15', b3]]);
    // The halves are one write: one transaction made both.
    assert.equal(new Set(stored.map((row) => row.xmin)).size, 1, 'both halves were written by one transaction');
    const [part] = await partsOf(mattePost);
    assert.deepEqual([part!.count, part!.placed, part!.left], [2, 1, 1], 'a pair is one lesson placed, and one is left');
  });

  // (gp-b) -------------------------------------------------------------------
  await check('(gp-b) the database: two halves in ONE statement are accepted, in two statements they are not, and a lone half is refused whoever writes it', async () => {
    await owner.query(`DELETE FROM "TeachingRequirementPlacements" WHERE "requirementId" = $1`, [svenskaPost]);
    const insert = (rows: Array<[string, number, string]>) =>
      `INSERT INTO "TeachingRequirementPlacements" ("schoolId", "requirementId", "dayOfWeek", "startTime", minutes, "roomId", recurrence, "updatedAt")
       VALUES ${rows.map(([recurrence, day, start]) => `('${s}', '${svenskaPost}', ${day}, '${start}', 60, '${a12}', '${recurrence}'::"LessonRecurrence", now())`).join(', ')}`;
    // One statement, both halves: judged after the statement, as a pair.
    await owner.query(insert([['ODD_WEEKS', 1, '08:00'], ['EVEN_WEEKS', 3, '08:00']]));
    assert.equal(await countOf(svenskaPost), 2);
    await owner.query(`DELETE FROM "TeachingRequirementPlacements" WHERE "requirementId" = $1`, [svenskaPost]);
    // Two statements of ONE transaction: the first is a lone half and is refused when it is written, however the second would end it.
    await owner.query('BEGIN');
    let code: string | undefined;
    try {
      await owner.query(insert([['ODD_WEEKS', 1, '08:00']]));
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    await owner.query('ROLLBACK');
    assert.equal(code, 'FP409', 'a lone half is refused by the database at its own statement');
    assert.equal(await countOf(svenskaPost), 0, 'nothing is left behind');
    // And alone, in a transaction of its own.
    let alone: string | undefined;
    try {
      await owner.query(insert([['EVEN_WEEKS', 3, '08:00']]));
    } catch (error) {
      alone = (error as { code?: string }).code;
    }
    assert.equal(alone, 'FP409');
    assert.equal(await countOf(svenskaPost), 0);
  });

  // (gp-c) -------------------------------------------------------------------
  await check('(gp-c) a lone half through the service is refused with the reason PAIRS and writes nothing; so are the wrong length and the wrong weeks', async () => {
    const before = await rowsOf(svenskaPost);
    const lone = await refusalOf(placements.replace(svenskaPost, { placements: [half('ODD_WEEKS', 1, '08:00', a12)] }, admin));
    assert.equal(lone.getStatus(), 409);
    assert.equal((lone.getResponse() as Record<string, unknown>)['code'], 'REQUIREMENT_PLACEMENTS_DO_NOT_FIT');
    assert.equal(reasonOf(lone), 'PAIRS');
    // An even half of another length is no other half: the lengths are counted apart.
    const lengths = await refusalOf(placements.replace(svenskaPost, { placements: [half('ODD_WEEKS', 1, '08:00', a12), { ...half('EVEN_WEEKS', 3, '08:00', a12), minutes: 40 }] }, admin));
    assert.ok(['LENGTH', 'PAIRS'].includes(reasonOf(lengths) ?? ''), `the reason was ${reasonOf(lengths)}`);
    // A post of odd weeks has no even half.
    const weeks = await refusalOf(placements.replace(fysikPost, { placements: [half('EVEN_WEEKS', 1, '08:00', a12)] }, admin));
    assert.equal(reasonOf(weeks), 'WEEKS');
    assert.deepEqual(await rowsOf(svenskaPost), before, 'nothing was written');
    assert.equal(await countOf(fysikPost), 0);
  });

  // (gp-d) -------------------------------------------------------------------
  await check('(gp-d) a pair with no room on a half is refused (PAIR_ROOM, B2), whichever half, and with no room on either', async () => {
    for (const [name, rows] of [
      ['the second half', [half('ODD_WEEKS', 1, '08:00', a12), half('EVEN_WEEKS', 3, '08:00', null)]],
      ['the first half', [half('ODD_WEEKS', 1, '08:00', null), half('EVEN_WEEKS', 3, '08:00', a12)]],
      ['both halves', [half('ODD_WEEKS', 1, '08:00', null), half('EVEN_WEEKS', 3, '08:00', null)]],
    ] as const) {
      const refused = await refusalOf(placements.replace(svenskaPost, { placements: [...rows] }, admin));
      assert.equal(refused.getStatus(), 409, name);
      assert.equal(reasonOf(refused), 'PAIR_ROOM', `no room on ${name}`);
    }
    assert.equal(await countOf(svenskaPost), 0, 'nothing was written');
    // A lesson of every week with no room is still the engine's to place: the rule is the pair's.
    const whole = await placements.replace(svenskaPost, { placements: [{ dayOfWeek: 5, startTime: '09:00', minutes: 60, recurrence: 'ALL_WEEKS' as const }] }, admin);
    assert.equal(whole.placements.length, 1);
    await placements.replace(svenskaPost, { placements: [] }, admin);
  });

  // (gp-e) -------------------------------------------------------------------
  await check("(gp-e) a shared post's pair is one teacher's: Bo's two halves are saved, Bo's odd and Anna's even are not, and each teacher's part counts its own", async () => {
    const forBo = (recurrence: 'ODD_WEEKS' | 'EVEN_WEEKS', day: number, start: string) => half(recurrence, day, start, a12, { teacherId: bo.id });
    const forAnna = (recurrence: 'ODD_WEEKS' | 'EVEN_WEEKS', day: number, start: string) => half(recurrence, day, start, b3, { teacherId: anna.id });
    // Two teachers' halves are not a pair, though the counts per length match.
    const mixed = await refusalOf(placements.replace(slojdPost, { placements: [forBo('ODD_WEEKS', 1, '08:00'), forAnna('EVEN_WEEKS', 3, '08:00')] }, admin));
    assert.equal(mixed.getStatus(), 409);
    assert.equal(reasonOf(mixed), 'TEACHER_PAIRS');
    assert.equal(await countOf(slojdPost), 0, 'nothing was written');
    // Bo's pair, and Anna's pair of the same length beside it.
    const saved = await placements.replace(
      slojdPost,
      { placements: [forBo('ODD_WEEKS', 1, '08:00'), forBo('EVEN_WEEKS', 3, '08:00'), forAnna('ODD_WEEKS', 2, '09:00'), forAnna('EVEN_WEEKS', 4, '09:00')] },
      admin,
    );
    assert.equal(saved.placements.length, 4);
    assert.deepEqual(saved.verdicts.map((verdict) => verdict.ok), [true, true, true, true]);
    const parts = await partsOf(slojdPost);
    const byTeacher = new Map(parts.map((part) => [part.teacherId, part]));
    assert.deepEqual([byTeacher.get(bo.id)!.count, byTeacher.get(bo.id)!.placed, byTeacher.get(bo.id)!.left], [1, 1, 0], "Bo's lesson is placed");
    assert.deepEqual([byTeacher.get(anna.id)!.count, byTeacher.get(anna.id)!.placed, byTeacher.get(anna.id)!.left], [1, 1, 0], "Anna's lesson is placed");
    assert.deepEqual([byTeacher.get(cecilia.id)!.count, byTeacher.get(cecilia.id)!.placed, byTeacher.get(cecilia.id)!.left], [1, 0, 1], "Cecilia's lesson is still to lay");
    // One half of Anna's pair taken away alone leaves a lone half of hers.
    const lone = await refusalOf(
      placements.replace(slojdPost, { placements: [forBo('ODD_WEEKS', 1, '08:00'), forBo('EVEN_WEEKS', 3, '08:00'), forAnna('ODD_WEEKS', 2, '09:00')] }, admin),
    );
    assert.equal(lone.getStatus(), 409);
    assert.ok(['TEACHER_PAIRS', 'PAIRS'].includes(reasonOf(lone) ?? ''), `the reason was ${reasonOf(lone)}`);
    assert.equal(await countOf(slojdPost), 4, 'nothing was changed');
    // A third teacher's pair is a pair too: Cecilia's lesson, in a third place.
    const third = await placements.replace(
      slojdPost,
      {
        placements: [
          forBo('ODD_WEEKS', 1, '08:00'),
          forBo('EVEN_WEEKS', 3, '08:00'),
          forAnna('ODD_WEEKS', 2, '09:00'),
          forAnna('EVEN_WEEKS', 4, '09:00'),
          half('ODD_WEEKS', 5, '10:00', a12, { teacherId: cecilia.id }),
          half('EVEN_WEEKS', 5, '13:00', a12, { teacherId: cecilia.id }),
        ],
      },
      admin,
    );
    assert.equal(third.placements.length, 6);
    assert.ok((await partsOf(slojdPost)).every((part) => part.left === 0), 'every lesson of the post is placed');
    await placements.replace(slojdPost, { placements: [] }, admin);
  });

  // (gp-f) -------------------------------------------------------------------
  await check('(gp-f) a pair on an old key is 409 STALE and writes nothing', async () => {
    const read = (await placements.listOfPost(mattePost, admin)).rowsKey;
    // Somebody else writes the post between the page's read and its pair.
    await placements.replace(mattePost, { placements: [] }, admin);
    const stale = await refusalOf(
      placements.replace(mattePost, { placements: [half('ODD_WEEKS', 1, '08:00', a12), half('EVEN_WEEKS', 2, '08:00', b3)], baseKey: read }, admin),
    );
    assert.equal(stale.getStatus(), 409);
    assert.equal((stale.getResponse() as Record<string, unknown>)['code'], 'REQUIREMENT_PLACEMENTS_STALE');
    assert.equal(await countOf(mattePost), 0, 'nothing was written');
    // On the key as it stands the same pair is saved.
    const fresh = (await placements.listOfPost(mattePost, admin)).rowsKey;
    const saved = await placements.replace(mattePost, { placements: [half('ODD_WEEKS', 1, '08:00', a12), half('EVEN_WEEKS', 2, '08:00', b3)], baseKey: fresh }, admin);
    assert.equal(saved.placements.length, 2);
  });

  // (gp-g) -------------------------------------------------------------------
  await check('(gp-g) the pair is taken away whole, and the lesson is to lay again', async () => {
    const [before] = await partsOf(mattePost);
    assert.deepEqual([before!.placed, before!.left], [1, 1]);
    const emptied = await placements.replace(mattePost, { placements: [] }, admin);
    assert.equal(emptied.placements.length, 0);
    const [after] = await partsOf(mattePost);
    assert.deepEqual([after!.placed, after!.left], [0, 2]);
    assert.equal(await countOf(mattePost), 0);
    // A half taken away by the database itself is refused whole: the other half cannot be left alone.
    await placements.replace(mattePost, { placements: [half('ODD_WEEKS', 1, '08:00', a12), half('EVEN_WEEKS', 2, '08:00', b3)] }, admin);
    let code: string | undefined;
    try {
      await owner.query(`DELETE FROM "TeachingRequirementPlacements" WHERE "requirementId" = $1 AND recurrence = 'EVEN_WEEKS'`, [mattePost]);
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    assert.equal(code, 'FP409', 'a half cannot be deleted alone');
    assert.equal(await countOf(mattePost), 2);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
