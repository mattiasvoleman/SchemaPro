/**
 * Undantag med flit (E1b) through Generera, against Postgres, with the REAL engine on the wire.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@127.0.0.1:5781/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@127.0.0.1:5781/schemapro' \
 *   AI_ENGINE_URL=http://127.0.0.1:8921 AI_ENGINE_API_KEY=<the engine's API_KEY> AI_ENGINE_TIMEOUT_MS=120000 \
 *   JWT_SECRET=… JWT_ISSUER=https://ci.invalid/auth/v1 NODE_ENV=test \
 *   npx ts-node --transpile-only scripts/test/probe-undantag-motor.ts
 *
 * Needs an engine of THIS tree (the field exemptFromLunch, claude/e1b-undantag-motor) listening at AI_ENGINE_URL. Not in CI (the Database job has no
 * engine); src/optimization/ai-engine-contract.spec.ts holds what the gateway sends, optimization-engine/tests holds what the engine does with it, and
 * this shows that they are what the real Generera does:
 *
 *   um-0  a school with no exemption sends the payload it always sent (no key of the new field) and Generera places the week;
 *   um-a  the RAMTID: a lesson given the exemption from the stage's ramtid (a lock outside the frame 08:00-15:00) is kept by Generera as it
 *         stands: the same row, the same id, still locked and still carrying the rule, and the run is not refused. The engine needed no change for it;
 *   um-b  the LUNCH: a lesson locked over a meal the school placed by hand, with the exemption from the class's meal: the payload names it
 *         (exemptFromLunch) and no other lock, Generera places the week, and the meal is where the school put it;
 *   um-c  the same lesson with the exemption taken back (still locked, still over the meal: "låt stå") is refused by the engine by name
 *         (LUNCH_PLACEMENT_COLLIDES), and with it given again the same week is placed: the field is what lets it through.
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

const SLUG = 'probe-undantag-motor';

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
    console.error(`==> Undantag probe (the real engine) FAILED: ${failures} step(s) in ${seconds} s`);
    process.exitCode = 1;
  } else {
    console.log(`==> Undantag probe (the real engine) passed in ${seconds} s`);
  }
}

async function sweep(owner: Client): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
}

async function run(owner: Client, app: import('@nestjs/common').INestApplicationContext): Promise<void> {
  const { Role } = await import('../../src/auth/enums/role.enum');
  const { OptimizationProxyService } = await import('../../src/optimization/optimization-proxy.service');
  const { MasterLessonsService } = await import('../../src/calendar/master-lessons.service');
  const { PrismaService } = await import('../../src/database/prisma.service');
  const resolve = <T>(token: abstract new (...args: never[]) => T): T => app.get<T>(token as never, { strict: false });
  const proxy = resolve(OptimizationProxyService);
  const masters = resolve(MasterLessonsService);
  const api = resolve(PrismaService);

  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  // The school: one class of year 7 whose day is 08:00-15:00, a lunch window 11:00-13:00 of thirty minutes, and the Monday meal placed by hand at 12:00.
  const s = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Probe undantag', $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])).id;
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt") VALUES ($1, 'Probe 2095/96', '2095-08-15', '2096-06-10', true, 'NIOARIG', now()) RETURNING id`,
      [s],
    )
  ).id;
  const g7a = (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, 'UM 7A', 'CLASS', 7, now()) RETURNING id`, [s, year])).id;
  const person = async (label: string, role: string, adminProfile?: string, groupId?: string) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'Undantag', $4, $5, $6, true, $7, now()) RETURNING id`,
      [s, `${SLUG}-${label}@example.invalid`, label, role, adminProfile ?? null, authId, groupId ?? null],
    );
    return { id: row.id, authId };
  };
  const adminRow = await person('admin', 'SCHOOL_ADMIN', 'SCHEMALAGGARE');
  const tFrame = await person('t-ramtid', 'TEACHER');
  const tMeal = await person('t-lunch', 'TEACHER');
  const tMatte = await person('t-matte', 'TEACHER');
  const tSvenska = await person('t-svenska', 'TEACHER');
  for (const label of ['p1', 'p2', 'p3', 'p4']) await person(label, 'STUDENT', undefined, g7a);
  const admin = { authId: adminRow.authId, userId: adminRow.id, schoolId: s, role: Role.SCHOOL_ADMIN, adminProfile: 'SCHEMALAGGARE', channel: 'WEB', hrRead: false } as AuthenticatedUser;
  const roomType = (await one<{ id: string }>(`INSERT INTO "RoomTypes" ("schoolId", name, "updatedAt") VALUES ($1, 'UM Klassrum', now()) RETURNING id`, [s])).id;
  for (const name of ['UM Klassrum 1', 'UM Klassrum 2']) await owner.query(`INSERT INTO "Rooms" ("schoolId", name, capacity, "roomTypeId", "updatedAt") VALUES ($1, $2, 30, $3, now())`, [s, name, roomType]);
  const subject = async (name: string) => (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "requiredRoomTypeId", "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [s, name, roomType])).id;
  const frameSubject = await subject('UM Ramtid');
  const mealSubject = await subject('UM Lunch');
  const matte = await subject('UM Matematik');
  const svenska = await subject('UM Svenska');
  const post = async (subjectId: string, teacherId: string, lessons: number, minutes: number) =>
    owner.query(
      `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", recurrence, "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ALL_WEEKS'::"LessonRecurrence", now())`,
      [s, year, subjectId, g7a, teacherId, lessons, minutes],
    );
  await post(matte, tMatte.id, 2, 45);
  await post(svenska, tSvenska.id, 2, 45);
  await owner.query(`INSERT INTO "FrameTimes" ("schoolId", "minGradeLevel", "maxGradeLevel", "dayOfWeek", "startTime", "endTime", "updatedAt") VALUES ($1, 7, 9, NULL, '08:00', '15:00', now())`, [s]);
  await owner.query(`INSERT INTO "LunchSettings" ("schoolId", "lunchEnabled", "lunchStartTime", "lunchEndTime", "lunchMinutes", "updatedAt") VALUES ($1, true, '11:00', '13:00', 30, now())`, [s]);
  await owner.query(
    `INSERT INTO "LunchSittings" ("schoolId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "isGenerated", "updatedAt") VALUES ($1, $2, $3, 1, '12:00', '12:30', false, now())`,
    [s, year, g7a],
  );

  const generate = () => proxy.triggerScheduling(year, admin);
  const prepare = async (): Promise<{ ready: boolean; payload: { fixedLessons: Array<Record<string, unknown>> } }> => {
    const service = proxy as unknown as { prepareSchedule: (tx: unknown, yearId: string, user: AuthenticatedUser) => Promise<{ ready: boolean; payload: { fixedLessons: Array<Record<string, unknown>> } }> };
    return api.withRls(admin, (tx) => service.prepareSchedule(tx, year, admin));
  };
  const lesson = async (id: string) =>
    one<{ id: string; day: number; start: string; end: string; locked: boolean; ex: string[]; generated: boolean }>(
      `SELECT id, "dayOfWeek" AS day, to_char("startTime", 'HH24:MI') AS start, to_char("endTime", 'HH24:MI') AS "end", "isLocked" AS locked, "exemptFrom"::text[] AS ex, "isGenerated" AS generated
         FROM "MasterLessons" WHERE id = $1`,
      [id],
    );
  const placedMeals = () =>
    all<{ day: number; start: string }>(`SELECT "dayOfWeek" AS day, to_char("startTime", 'HH24:MI') AS start FROM "LunchSittings" WHERE "academicYearId" = $1 AND "isGenerated" = false ORDER BY "dayOfWeek"`, [year]);
  const generatedCount = async () => Number((await one<{ n: string }>(`SELECT count(*) AS n FROM "MasterLessons" WHERE "academicYearId" = $1 AND "isGenerated" = true`, [year])).n);

  const ok = (status: unknown) => ['OPTIMAL', 'FEASIBLE', 'SUCCEEDED'].includes(String((status as { solverStatus?: string; status?: string })?.solverStatus ?? (status as { status?: string })?.status));
  void ok;

  await check('(um-0) a school with no exemption sends the payload it always sent, and Generera places the week', async () => {
    const prepared = await prepare();
    assert.ok(prepared.ready, 'the pre-flight refused the plain week');
    assert.ok(!JSON.stringify(prepared.payload).includes('exemptFromLunch'), 'the payload names the new field though no lesson has an exemption');
    await generate();
    assert.ok((await generatedCount()) >= 4, `Generera wrote ${await generatedCount()} lessons of the four the week asks for`);
  });

  let frameLesson = '';
  let mealLesson = '';

  await check('(um-a) the ramtid: a lesson outside the frame, given the exemption, is kept by Generera as it stands and needs nothing of the engine', async () => {
    const created = await masters.create({ academicYearId: year, subjectId: frameSubject, studentGroupId: g7a, teacherId: tFrame.id, dayOfWeek: 2, startTime: '14:30', endTime: '15:30', exempt: ['FRAME'] }, admin);
    frameLesson = created.id;
    assert.deepEqual([created.isLocked, created.exemptFrom], [true, ['FRAME']]);
    const prepared = await prepare();
    assert.ok(prepared.ready, 'the pre-flight refused a week with a lesson outside the ramtid that the school let stand');
    const sent = prepared.payload.fixedLessons.filter((fixed) => fixed['dayOfWeek'] === 2 && fixed['startTime'] === '14:30:00');
    assert.equal(sent.length, 1, 'the lesson is sent as the lock it is');
    assert.ok(!('exemptFromLunch' in sent[0]!), 'a ramtid exemption sends nothing: the engine needs no field for it');
    await generate();
    assert.deepEqual(await lesson(frameLesson), { id: frameLesson, day: 2, start: '14:30', end: '15:30', locked: true, ex: ['FRAME'], generated: false });
    assert.ok((await generatedCount()) >= 4, 'Generera placed the rest of the week around it');
  });

  await check('(um-b) the lunch: a lesson locked over the meal the school placed, given the exemption, is named to the engine and the week is placed', async () => {
    const created = await masters.create({ academicYearId: year, subjectId: mealSubject, studentGroupId: g7a, teacherId: tMeal.id, dayOfWeek: 1, startTime: '11:45', endTime: '12:45', exempt: ['LUNCH'] }, admin);
    mealLesson = created.id;
    assert.deepEqual([created.isLocked, created.exemptFrom], [true, ['LUNCH']]);
    const prepared = await prepare();
    assert.ok(prepared.ready, 'the pre-flight refused it');
    const named = prepared.payload.fixedLessons.filter((fixed) => fixed['exemptFromLunch'] === true);
    assert.equal(named.length, 1, `${named.length} locks carry the exemption`);
    assert.deepEqual([named[0]!['dayOfWeek'], named[0]!['startTime']], [1, '11:45:00']);
    assert.equal(prepared.payload.fixedLessons.length - 1, prepared.payload.fixedLessons.filter((fixed) => !('exemptFromLunch' in fixed)).length, 'no other lock carries the key');
    await generate();
    assert.deepEqual(await placedMeals(), [{ day: 1, start: '12:00' }], 'the meal is where the school put it');
    assert.deepEqual((await lesson(mealLesson)).ex, ['LUNCH']);
    assert.ok((await generatedCount()) >= 4);
  });

  await check('(um-c) without the exemption the engine refuses the same week by name, and with it given again the week is placed', async () => {
    // Taken back: the lesson stays locked, over the meal, as a lesson that stands against the rule (låt stå).
    await masters.update(mealLesson, { exempt: [] }, admin);
    assert.deepEqual((await lesson(mealLesson)).ex, []);
    assert.ok(!JSON.stringify((await prepare()).payload).includes('exemptFromLunch'));
    let refused = '';
    try {
      await generate();
    } catch (error) {
      refused = summarise(error);
    }
    assert.match(refused, /LUNCH_PLACEMENT_COLLIDES/, `Generera was not refused by the engine by name: ${refused || 'it ran'}`);
    // Given again: the lesson stands over the meal, the question is answered yes, and the same week is placed.
    await masters.update(mealLesson, { exempt: ['LUNCH'] }, admin);
    assert.deepEqual((await lesson(mealLesson)).ex, ['LUNCH']);
    await generate();
    assert.deepEqual(await placedMeals(), [{ day: 1, start: '12:00' }]);
    assert.deepEqual(await lesson(mealLesson), { id: mealLesson, day: 1, start: '11:45', end: '12:45', locked: true, ex: ['LUNCH'], generated: false });
    assert.deepEqual((await lesson(frameLesson)).ex, ['FRAME'], 'and the ramtid exemption is still the one it was');
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
