/**
 * Skriv in förläggningarna (E4b) beside Generera, against Postgres, with the REAL engine on the wire: the bridge writes what Generera writes.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@127.0.0.1:5781/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@127.0.0.1:5781/schemapro' \
 *   AI_ENGINE_URL=http://127.0.0.1:8921 AI_ENGINE_API_KEY=<the engine's API_KEY, 32 characters or more> AI_ENGINE_TIMEOUT_MS=120000 \
 *   JWT_SECRET=… JWT_ISSUER=https://ci.invalid/auth/v1 NODE_ENV=test \
 *   npx ts-node --transpile-only scripts/test/probe-skriv-in-motor.ts
 *
 * Needs an engine listening at AI_ENGINE_URL. Not in CI (the Database job has no engine); scripts/test/probe-skriv-in.ts holds what the bridge does
 * against the database alone, and this shows that what it writes is what the real Generera writes from the same förläggningar:
 *
 *   sm-a  a school with three posts and two förläggningar with a room: the bridge writes two lessons; Generera, run after it, writes the same two lessons
 *         (the same class, subject, teacher, room, clock and weeks, locked, the run's own, marked from a förläggning) and places the rest around them;
 *   sm-b  the bridge, run once more after Generera, changes nothing: what Generera wrote from the rows is what the bridge would write.
 *
 * A step that fails prints its FAIL line and the run goes on. The exit code is 1 for any FAIL. A school of its own, in the year 2095/96.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';

const SLUG = 'probe-skriv-in-motor';
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
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
    process.env['NODE_ENV'] ??= 'test';
    process.env['JWT_SECRET'] ??= 'probe-secret-not-used-by-anything-here';
    process.env['JWT_ISSUER'] ??= 'https://probe.invalid/auth/v1';
    const { EnvironmentVariables } = await import('../../src/config/env.validation');
    for (const name of Object.keys(new EnvironmentVariables()).filter((key) => key.endsWith('_BACKGROUND'))) process.env[name] = 'off';
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('../../src/app.module');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    try {
      await run(owner, app);
    } finally {
      await app.close();
    }
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]).catch((error: unknown) => console.error(`the probe's school was not dropped: ${summarise(error)}`));
    await owner.end();
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (failures > 0) {
    console.error(`==> Skriv in probe (the real engine) FAILED: ${failures} step(s) in ${seconds} s`);
    process.exitCode = 1;
  } else {
    console.log(`==> Skriv in probe (the real engine) passed in ${seconds} s`);
  }
}

async function run(owner: Client, app: import('@nestjs/common').INestApplicationContext): Promise<void> {
  const { Role } = await import('../../src/auth/enums/role.enum');
  const { OptimizationProxyService } = await import('../../src/optimization/optimization-proxy.service');
  const { PlacementWriteInService } = await import('../../src/requirement-placements/placement-write-in.service');
  const resolve = <T>(token: abstract new (...args: never[]) => T): T => app.get<T>(token as never, { strict: false });
  const proxy = resolve(OptimizationProxyService);
  const bridge = resolve(PlacementWriteInService);

  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  const s = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Probe skriv in', $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])).id;
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt") VALUES ($1, 'Probe 2095/96', '2095-08-15', '2096-06-10', true, 'NIOARIG', now()) RETURNING id`,
      [s],
    )
  ).id;
  const g7a = (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, 'AL 7A', 'CLASS', 7, now()) RETURNING id`, [s, year])).id;
  const person = async (label: string, role: string, adminProfile?: string, groupId?: string) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'Lagga', $4, $5, $6, true, $7, now()) RETURNING id`,
      [s, `${SLUG}-${label}@example.invalid`, label, role, adminProfile ?? null, authId, groupId ?? null],
    );
    return { id: row.id, authId };
  };
  const adminRow = await person('admin', 'SCHOOL_ADMIN', 'SCHEMALAGGARE');
  const tMatte = await person('t-matte', 'TEACHER');
  const tSvenska = await person('t-svenska', 'TEACHER');
  const tKemi = await person('t-kemi', 'TEACHER');
  for (const label of ['p1', 'p2', 'p3']) await person(label, 'STUDENT', undefined, g7a);
  const admin = { authId: adminRow.authId, userId: adminRow.id, schoolId: s, role: Role.SCHOOL_ADMIN, adminProfile: 'SCHEMALAGGARE', channel: 'WEB', hrRead: false } as AuthenticatedUser;
  const roomType = (await one<{ id: string }>(`INSERT INTO "RoomTypes" ("schoolId", name, "updatedAt") VALUES ($1, 'AL Klassrum', now()) RETURNING id`, [s])).id;
  for (const name of ['AL Klassrum 1', 'AL Klassrum 2']) await owner.query(`INSERT INTO "Rooms" ("schoolId", name, capacity, "roomTypeId", "updatedAt") VALUES ($1, $2, 30, $3, now())`, [s, name, roomType]);
  const subject = async (name: string) => (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "requiredRoomTypeId", "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [s, name, roomType])).id;
  const matte = await subject('AL Matematik');
  const svenska = await subject('AL Svenska');
  const kemi = await subject('AL Kemi');
  const post = async (subjectId: string, teacherId: string, lessons: number, minutes: number) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", recurrence, "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ALL_WEEKS'::"LessonRecurrence", now()) RETURNING id`,
        [s, year, subjectId, g7a, teacherId, lessons, minutes],
      )
    ).id;
  const pMatte = await post(matte, tMatte.id, 3, 60);
  const pSvenska = await post(svenska, tSvenska.id, 2, 45);
  const pKemi = await post(kemi, tKemi.id, 2, 60);
  await owner.query(`INSERT INTO "FrameTimes" ("schoolId", "minGradeLevel", "maxGradeLevel", "dayOfWeek", "startTime", "endTime", "updatedAt") VALUES ($1, 7, 9, NULL, '08:00', '15:00', now())`, [s]);
  const room = async (name: string) => (await one<{ id: string }>(`SELECT id FROM "Rooms" WHERE "schoolId" = $1 AND name = $2`, [s, name])).id;
  const [r1, r2] = [await room('AL Klassrum 1'), await room('AL Klassrum 2')];
  await owner.query(
    `INSERT INTO "TeachingRequirementPlacements" ("schoolId", "requirementId", "dayOfWeek", "startTime", minutes, "roomId", recurrence, "updatedAt")
     VALUES ($1, $2, 1, '09:00', 60, $3, 'ALL_WEEKS', now()), ($1, $4, 2, '10:00', 45, $5, 'ALL_WEEKS', now())`,
    [s, pMatte, r1, pSvenska, r2],
  );
  // What a lesson made from a förläggning is, whoever wrote it: where and with whom, and whose it is. No id, no time of writing.
  const fromRows = async () =>
    all<{ subject: string; teacher: string; room: string; day: number; start: string; end: string; weeks: string; locked: boolean; generated: boolean }>(
      `SELECT sub.name AS subject, l."teacherId" AS teacher, l."roomId" AS room, l."dayOfWeek" AS day, to_char(l."startTime", 'HH24:MI') AS start, to_char(l."endTime", 'HH24:MI') AS "end",
              l.recurrence::text AS weeks, l."isLocked" AS locked, l."isGenerated" AS generated
         FROM "MasterLessons" l JOIN "Subjects" sub ON sub.id = l."subjectId" WHERE l."academicYearId" = $1 AND l."fromPlacement" ORDER BY sub.name, l."dayOfWeek"`,
      [year],
    );
  const lessonCount = async () => Number((await one<{ n: string }>(`SELECT count(*) AS n FROM "MasterLessons" WHERE "academicYearId" = $1`, [year])).n);

  let written: Awaited<ReturnType<typeof fromRows>> = [];
  await check('(sm-a) the bridge writes the two lessons the förläggningar say; Generera, run after it, writes the same two and places the rest around them', async () => {
    const result = await bridge.write(year, admin);
    assert.deepEqual([result.lessonsWritten, result.lessonsReplaced, result.notWritten], [2, 0, []]);
    written = await fromRows();
    assert.equal(written.length, 2);
    assert.ok(written.every((lesson) => lesson.locked && lesson.generated));
    await proxy.triggerScheduling(year, admin);
    assert.deepEqual(await fromRows(), written, 'Generera wrote from the rows what the bridge had written');
    // Every lesson of every post stands: the bridge's two, and what the engine placed around them (3 + 2 + 2).
    assert.equal(await lessonCount(), 7);
  });

  await check('(sm-b) the bridge, run once more after Generera, changes nothing: the lessons are what the rows say', async () => {
    const ids = (await all<{ id: string }>(`SELECT id FROM "MasterLessons" WHERE "academicYearId" = $1 AND "fromPlacement" ORDER BY id`, [year])).map((row) => row.id);
    const again = await bridge.write(year, admin);
    assert.deepEqual([again.lessonsWritten, again.lessonsReplaced, again.safetyVersionId], [0, 0, null]);
    assert.deepEqual((await all<{ id: string }>(`SELECT id FROM "MasterLessons" WHERE "academicYearId" = $1 AND "fromPlacement" ORDER BY id`, [year])).map((row) => row.id), ids);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
