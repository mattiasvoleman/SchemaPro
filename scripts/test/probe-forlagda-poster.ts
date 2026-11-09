/**
 * Förlagda poster through Nest's own injection, against Postgres, with the
 * engine on the wire (PR #293, review HÖG-1).
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   JWT_SECRET=… JWT_ISSUER=https://ci.invalid/auth/v1 AI_ENGINE_API_KEY=… NODE_ENV=test \
 *   npx ts-node --transpile-only scripts/test/probe-forlagda-poster.ts
 *
 * WHY THIS EXISTS. The proxy's specs build OptimizationProxyService by hand,
 * with a fake MasterLessonsService in its fourth place, and the e2e specs
 * mock Prisma. Neither could see that Nest handed the proxy nothing: an import
 * cycle (master-lessons.service ↔ optimization-proxy.service) decorated the
 * constructor's fourth parameter `undefined`, @Optional() let Nest pass it on,
 * and every Generera of a school with one förläggning was a 500, in the built
 * application, while every check was green. So this boots the application the
 * way main.ts does — NestFactory.createApplicationContext(AppModule), the
 * first src import of this file, the order that decorated the proxy wrong —
 * and asks it, on a real database and under row security, for what a school
 * does: save a förläggning, press Generera, read the grundschema.
 *
 * The engine is a node:http server on 127.0.0.1 that AI_ENGINE_URL names
 * before the application is read. It records every request as it arrived on
 * the wire (so the key, the anonymised ids and the fields the gateway sends
 * are what the engine would get) and answers /v1/schedule with each requested
 * post's lessons, lessonsPerWeek of them, in rooms from the request. Where it
 * puts them does not matter to the gateway's own checks; that the counts are
 * right does.
 *
 *   fp-a  the proxy Nest built holds the SAME MasterLessonsService instance
 *         as the context (not undefined: the check that fails on the cycle);
 *   fp-b  a förläggning saves through RequirementPlacementsService.replace on
 *         a post of two lessons: Tuesday 10:00, 60 min, a room, every week,
 *         and the verdict is ok;
 *   fp-c  Generera as an administrator answers OPTIMAL or FEASIBLE, and the
 *         engine was sent the post with ONE lesson left to place, the
 *         förläggning as a fixed lesson (day 2, 10:00:00–11:00:00, the room's
 *         anonymous id, the post's teacher and class), and `placements`
 *         naming that lock and the post with its WHOLE demand (two lessons);
 *   fp-d  the grundschema holds the post's two lessons, the placed one locked,
 *         generated and fromPlacement on the right day, time and room, and no
 *         twin of it;
 *   fp-e  a second Generera writes it again (a new id, still one placed
 *         lesson, the week's lessons the same in number);
 *   fp-f  an engine older than `placements` answers 422 extra_forbidden on
 *         ['body', 'placements']: the gateway sends the same request again
 *         without the field, and the placed lesson is written all the same;
 *   fp-g  a handmade, locked lesson with the same teacher at the förläggning's
 *         time: Generera is INFEASIBLE with PLACEMENTS_REFUSED_SUMMARY and one
 *         PLACEMENT_CANNOT_STAND (reason TEACHER) BEFORE the engine is woken,
 *         and not a row of the grundschema or the change log is touched;
 *   fp-h  the class's lunch (MEDEL-1): a sitting Generera laid (isGenerated)
 *         does not refuse the förläggning, at the save, in the dialog's
 *         verdicts or at Generera, and Generera lays the lunch anew; a sitting
 *         the school placed refuses it with LUNCH in all three.
 *
 * DELADE LEKTIONER (20270208090000), on a post of three lessons of 40 whose
 * huvudlärare has two and a share's teacher one:
 *
 *   fp-i  the share teacher's lesson saves with its teacher (Thursday 10:00),
 *         and a row naming nobody is refused NO_TEACHER at its index;
 *   fp-j  Generera sends the post with the huvudlärare's two lessons left and
 *         no lessonTeacherIds, the förläggning as the SHARE TEACHER's fixed
 *         lesson, and `placements` with all three, each its teacher; the
 *         grundschema has the placed lesson the share teacher's;
 *   fp-k  the share given to another teacher through the requirements PATCH
 *         (one out, one in, the same lessons) carries the förläggning along,
 *         and the transaction commits (the deferred trigger agrees);
 *   fp-l  the share removed through the PATCH is refused 409
 *         REQUIREMENT_PLACEMENTS_DO_NOT_FIT TEACHER naming the förläggning by
 *         day and clock, and nothing is written;
 *   fp-m  another writer, as the owner: the share's teacher changed without
 *         the förläggning is refused at COMMIT (FP409 TEACHER, the deferred
 *         trigger), and with the förläggning moved in the same transaction it
 *         commits — both outcomes of a teacher swap on real Postgres;
 *   fp-n  that teacher removed: the share and the förläggning are nobody's,
 *         the removal commits, the dialog's row names nobody and its save is
 *         refused NO_TEACHER, and a share given a teacher again through the
 *         PATCH hands the förläggning to them.
 *
 * A step that fails prints its FAIL line and the run goes on; the steps share
 * the world, so a failure early on may take later ones with it. The exit code
 * is 1 for any FAIL.
 *
 * Independent of what earlier CI steps left in the database: it works in a
 * school of its own, planted and dropped by this probe, and counts on nothing
 * in the seed. 2095/96, so no date of its year is behind the clock.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import 'reflect-metadata';
import { HttpException, type INestApplicationContext } from '@nestjs/common';
import { Client } from 'pg';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';

const SLUG = 'probe-forlagda-poster';
const API_KEY = process.env['AI_ENGINE_API_KEY'] ?? 'probe-engine-key';

// ---------------------------------------------------------------------------
// The engine, on the wire
// ---------------------------------------------------------------------------

interface WireRequirement {
  id: string;
  studentGroupId: string;
  teacherId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  /** Delade lektioner: one teacher per lesson, when the lessons left have two or more. */
  lessonTeacherIds?: (string | null)[];
}

interface WireFixedLesson {
  id: string;
  teacherId: string | null;
  studentGroupId: string;
  roomId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

interface WireBody {
  requestId: string;
  requirements: WireRequirement[];
  rooms: Array<{ id: string; capacity: number | null }>;
  fixedLessons: WireFixedLesson[];
  placements?: { lessons: Array<{ fixedLessonId: string; requirementId: string }>; requirements: WireRequirement[] };
}

interface WireCall {
  method: string;
  path: string;
  apiKey: string | undefined;
  body: WireBody;
}

const clockOf = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;

/**
 * What the engine answers a request: every requirement's lessons, as many as
 * it asked for (the gateway refuses an answer with another number), one hour
 * of its own each from 13:00, in the request's rooms in turn. The times are
 * the stub's own, clear of the förläggning (Tuesday 10:00).
 */
function answerOf(body: WireBody) {
  const lessons: Array<{ requirementId: string; roomId: string | null; dayOfWeek: number; startTime: string; endTime: string; teacherId?: string | null }> = [];
  let n = 0;
  for (const requirement of body.requirements) {
    for (let k = 0; k < requirement.lessonsPerWeek; k++, n++) {
      const start = 13 * 60 + Math.floor(n / 5) * 60;
      lessons.push({
        requirementId: requirement.id,
        roomId: body.rooms[n % Math.max(body.rooms.length, 1)]?.id ?? null,
        dayOfWeek: (n % 5) + 1,
        startTime: clockOf(start),
        endTime: clockOf(start + requirement.minutesPerLesson),
        // The engine answers each lesson of a shared post with the teacher it was sent.
        ...(requirement.lessonTeacherIds ? { teacherId: requirement.lessonTeacherIds[k] } : {}),
      });
    }
  }
  return { requestId: body.requestId, status: 'OPTIMAL', lessons, lunches: [], conflicts: null };
}

/** The refusal an engine older than a field gives, as the engine's validation handler words it. */
function extraForbidden(field: string) {
  return {
    code: 'VALIDATION_ERROR',
    message: 'Request payload failed schema validation.',
    details: { errors: [{ type: 'extra_forbidden', loc: ['body', field], msg: 'Extra inputs are not permitted' }] },
  };
}

class EngineStub {
  readonly calls: WireCall[] = [];
  /** An engine older than Förlagda poster: its models forbid `placements`. */
  olderThanPlacements = false;
  private server: Server | undefined;

  async listen(): Promise<string> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    // The gateway's HTTP client keeps sockets alive; close() alone would wait for them.
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
      if (this.olderThanPlacements && 'placements' in body) return send(422, extraForbidden('placements'));
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

/** The 409 a refused save is, as a value. */
async function refusalOf(work: Promise<unknown>): Promise<HttpException> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof HttpException, `expected an HttpException, got ${summarise(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'the call was not refused' });
}

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
    // No background tick of any job: a probe that boots everything must start nothing on its own. The flags are
    // the validated environment's own (each defaults to 'on'), so a job added later is switched off here too.
    // env.validation.ts is a leaf (class-validator only); reading it does not touch the cycle this probe is about.
    const { EnvironmentVariables } = await import('../../src/config/env.validation');
    for (const name of Object.keys(new EnvironmentVariables()).filter((key) => key.endsWith('_BACKGROUND'))) {
      process.env[name] = 'off';
    }

    // AppModule is the FIRST file of the application this one reads, as main.ts reads it: its graph reaches
    // master-lessons.service before the proxy, the order that decorated the proxy's constructor with
    // `undefined` while the two files imported each other. Everything else of src/ is read after it, by the
    // application's own references; do not hoist an import above this line.
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
    console.error(`==> Förlagda poster probe FAILED: ${failures} step(s) in ${seconds} s`);
    process.exitCode = 1;
  } else {
    console.log(`==> Förlagda poster probe passed in ${seconds} s`);
  }
}

async function sweep(owner: Client): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
}

async function run(owner: Client, engine: EngineStub, app: INestApplicationContext): Promise<void> {
  // The application's own classes, read after AppModule (see main). `get` is the context's.
  const { Role } = await import('../../src/auth/enums/role.enum');
  const { MasterLessonsService } = await import('../../src/calendar/master-lessons.service');
  const { OptimizationProxyService } = await import('../../src/optimization/optimization-proxy.service');
  const { RequirementPlacementsService } = await import('../../src/requirement-placements/requirement-placements.service');
  const { TeachingRequirementsService } = await import('../../src/resources/teaching-requirements.service');
  const resolve = <T>(token: abstract new (...args: never[]) => T): T => app.get<T>(token as never, { strict: false });
  const masters = resolve(MasterLessonsService);
  const proxy = resolve(OptimizationProxyService);
  const placements = resolve(RequirementPlacementsService);
  const requirements = resolve(TeachingRequirementsService);

  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  // -------------------------------------------------------------------------
  // The school: a class pair, three posts, three rooms, a teacher each
  // -------------------------------------------------------------------------
  const s = (
    await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Probe förlagda poster', $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])
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
  const g7a = await group('FP 7A');
  const g7b = await group('FP 7B');
  const person = async (label: string, role: string, extra: { groupId?: string; adminProfile?: string } = {}) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'Förlagd', $4, $5, $6, true, $7, now()) RETURNING id`,
      [s, `${SLUG}-${label}@example.invalid`, label, role, extra.adminProfile ?? null, authId, extra.groupId ?? null],
    );
    return { id: row.id, authId };
  };
  const adminRow = await person('admin', 'SCHOOL_ADMIN', { adminProfile: 'FULL' });
  const t1 = await person('t1', 'TEACHER');
  const t2 = await person('t2', 'TEACHER');
  // Delade lektioner: the shared post's huvudlärare, its share's teacher, the one who takes the share over, and
  // the one who takes it after that teacher is removed.
  const t3 = await person('t3', 'TEACHER');
  const t4 = await person('t4', 'TEACHER');
  const t5 = await person('t5', 'TEACHER');
  const t6 = await person('t6', 'TEACHER');
  await person('p1', 'STUDENT', { groupId: g7a });
  await person('p2', 'STUDENT', { groupId: g7a });
  await person('p3', 'STUDENT', { groupId: g7b });
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
  const idrott = await subject('FP Idrott');
  const matte = await subject('FP Matematik');
  const svenska = await subject('FP Svenska');
  // A capacity of its own each, so the stub's anonymous room ids can be told apart.
  const room = async (name: string, capacity: number) =>
    (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, capacity, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [s, name, capacity])).id;
  const gym = await room('FP Gympasal', 30);
  const sal32 = await room('FP sal 32', 32);
  await room('FP sal 34', 34);
  const post = async (groupId: string, subjectId: string, teacherId: string, lessons: number, minutes: number) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
        [s, year, subjectId, groupId, teacherId, lessons, minutes],
      )
    ).id;
  // Each post has a length of its own (60, 45, 50), so the stub tells them apart through the anonymisation.
  const idrottPost = await post(g7a, idrott, t1.id, 2, 60);
  await post(g7a, matte, t2.id, 2, 45);
  await post(g7b, svenska, t2.id, 3, 50);
  // Delade lektioner: 7B biologi, three lessons of 40, t3's two and t4's one.
  const biologi = await subject('FP Biologi');
  const sharedPost = await post(g7b, biologi, t3.id, 3, 40);
  await owner.query(
    `INSERT INTO "TeachingRequirementShares" ("schoolId", "requirementId", "teacherId", lessons, minutes, "updatedAt") VALUES ($1, $2, $3, 1, 40, now())`,
    [s, sharedPost, t4.id],
  );
  const demandLessons = 2 + 2 + 3 + 3;

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
    recurrence: string;
  }
  const masterRows = (): Promise<MasterRow[]> =>
    all<MasterRow>(
      `SELECT id, "studentGroupId" AS "groupId", "teacherId", "roomId", "dayOfWeek" AS day, to_char("startTime", 'HH24:MI') AS start,
              to_char("endTime", 'HH24:MI') AS "end", "isLocked", "isGenerated", "fromPlacement", recurrence::text AS recurrence
         FROM "MasterLessons" WHERE "academicYearId" = $1 ORDER BY id`,
      [year],
    );
  const placedOf = async (): Promise<MasterRow[]> => (await masterRows()).filter((row) => row.fromPlacement);
  /** Every column of every master and the log, as one string: equal before and after means nothing was written. */
  const fingerprint = async (): Promise<string> =>
    JSON.stringify([
      await all(`SELECT * FROM "MasterLessons" WHERE "academicYearId" = $1 ORDER BY id`, [year]),
      await all(`SELECT id FROM "ScheduleChangeLogs" WHERE "academicYearId" = $1 ORDER BY id`, [year]),
      await all(`SELECT * FROM "LunchSittings" WHERE "academicYearId" = $1 ORDER BY id`, [year]),
    ]);
  const placement = { dayOfWeek: 2, startTime: '10:00', minutes: 60, roomId: gym, recurrence: 'ALL_WEEKS' as const };
  const generate = () => proxy.triggerScheduling(year, admin);
  const callsSince = (mark: number) => engine.calls.slice(mark);
  /** The anonymised id of the post of a given length, as the request names it. */
  const requirementOfMinutes = (body: WireBody, minutes: number) => {
    const found = body.requirements.filter((requirement) => requirement.minutesPerLesson === minutes);
    assert.equal(found.length, 1, `${found.length} requirements of ${minutes} min in the request`);
    return found[0]!;
  };

  // -------------------------------------------------------------------------
  // The checks
  // -------------------------------------------------------------------------
  await check('fp-a: the proxy Nest built holds the context\'s own MasterLessonsService (the cycle of HÖG-1 is gone)', async () => {
    const held = (proxy as unknown as { masters?: unknown }).masters;
    const types = (Reflect.getMetadata('design:paramtypes', OptimizationProxyService) as Array<{ name?: string } | undefined>).map(
      (type) => type?.name ?? String(type),
    );
    assert.ok(
      held !== undefined && held !== null,
      `OptimizationProxyService.masters is ${String(held)}: Nest injected nothing (design:paramtypes ${JSON.stringify(types)})`,
    );
    assert.strictEqual(held, masters, "OptimizationProxyService.masters is not the context's MasterLessonsService");
    assert.deepEqual(types[3], 'MasterLessonsService', `the fourth parameter is decorated ${types[3]}`);
  });

  await check('fp-b: a förläggning saves on a post of two lessons (Tuesday 10:00, 60 min, a room, every week) with an ok verdict', async () => {
    const saved = await placements.replace(idrottPost, { placements: [placement] } as never, admin);
    assert.deepEqual(saved.verdicts, [{ index: 0, ok: true }]);
    assert.equal(saved.placements.length, 1);
    const row = saved.placements[0]!;
    assert.deepEqual(
      [row.dayOfWeek, row.startTime, row.endTime, row.minutes, row.roomId, row.recurrence],
      [2, '10:00', '11:00', 60, gym, 'ALL_WEEKS'],
    );
    const stored = await all<{ n: number }>(`SELECT count(*)::int AS n FROM "TeachingRequirementPlacements" WHERE "requirementId" = $1`, [idrottPost]);
    assert.equal(stored[0]!.n, 1, 'the row is not in the database');
  });

  await check('fp-c: Generera sends the post with one lesson left, the förläggning as a fixed lesson, and `placements` with the whole demand', async () => {
    const mark = engine.calls.length;
    const result = await generate();
    assert.ok(result.status === 'OPTIMAL' || result.status === 'FEASIBLE', `Generera answered ${result.status} ${JSON.stringify(result.conflicts?.summaryCode ?? null)}`);
    const sent = callsSince(mark);
    assert.equal(sent.length, 1, `${sent.length} engine calls`);
    assert.equal(sent[0]!.path, '/v1/schedule');
    assert.equal(sent[0]!.apiKey, API_KEY, 'the engine key did not travel');
    const body = sent[0]!.body;

    const post = requirementOfMinutes(body, 60);
    assert.equal(post.lessonsPerWeek, 1, 'the post still asks for both of its lessons');
    const gymWire = body.rooms.filter((candidate) => candidate.capacity === 30);
    assert.equal(gymWire.length, 1, 'the gym is not in the request, or twice');
    assert.equal(body.fixedLessons.length, 1, `${body.fixedLessons.length} fixed lessons`);
    const fixed = body.fixedLessons[0]!;
    assert.deepEqual(
      [fixed.dayOfWeek, fixed.startTime, fixed.endTime, fixed.roomId],
      [2, '10:00:00', '11:00:00', gymWire[0]!.id],
      'the förläggning is not a fixed lesson on Tuesday 10:00–11:00 in the gym',
    );
    assert.equal(fixed.studentGroupId, post.studentGroupId, 'the fixed lesson is not the post\'s class');
    assert.equal(fixed.teacherId, post.teacherId, 'the fixed lesson is not the post\'s teacher');

    assert.ok(body.placements, 'the request carries no `placements`');
    assert.deepEqual(body.placements!.lessons, [{ fixedLessonId: fixed.id, requirementId: post.id }]);
    const whole = body.placements!.requirements.filter((requirement) => requirement.id === post.id);
    assert.equal(whole.length, 1, 'the post is not in placements.requirements, or twice');
    assert.equal(whole[0]!.lessonsPerWeek, 2, 'placements.requirements does not carry the post\'s whole demand');
  });

  await check('fp-d: the grundschema holds the post\'s two lessons, the placed one locked, generated and fromPlacement at Tuesday 10:00 in the gym, with no twin', async () => {
    const rows = await masterRows();
    assert.equal(rows.length, demandLessons, `${rows.length} lessons in the grundschema`);
    const ofPost = rows.filter((row) => row.groupId === g7a && row.teacherId === t1.id);
    assert.equal(ofPost.length, 2, `${ofPost.length} lessons of the post`);
    const placed = ofPost.filter((row) => row.fromPlacement);
    assert.equal(placed.length, 1, `${placed.length} placed lessons of the post`);
    assert.deepEqual(
      { ...placed[0]!, id: undefined },
      { id: undefined, groupId: g7a, teacherId: t1.id, roomId: gym, day: 2, start: '10:00', end: '11:00', isLocked: true, isGenerated: true, fromPlacement: true, recurrence: 'ALL_WEEKS' },
    );
    const free = ofPost.find((row) => !row.fromPlacement)!;
    assert.deepEqual([free.isLocked, free.isGenerated], [false, true], 'the post\'s other lesson is not the engine\'s');
    assert.ok(!(free.day === 2 && free.start === '10:00'), 'the engine\'s lesson sits on the förläggning');
    assert.equal(rows.filter((row) => row.fromPlacement).length, 1, 'another lesson of the year is marked fromPlacement');
  });

  let placedId = '';
  await check('fp-e: a second Generera writes the placed lesson again (a new id, still one, the same week of lessons)', async () => {
    const before = await placedOf();
    assert.equal(before.length, 1);
    placedId = before[0]!.id;
    const mark = engine.calls.length;
    const result = await generate();
    assert.ok(result.status === 'OPTIMAL' || result.status === 'FEASIBLE', `Generera answered ${result.status}`);
    assert.equal(callsSince(mark).length, 1);
    const after = await placedOf();
    assert.equal(after.length, 1, `${after.length} placed lessons after the second Generera`);
    assert.notEqual(after[0]!.id, placedId, 'the placed lesson was left, not written again');
    assert.deepEqual([after[0]!.day, after[0]!.start, after[0]!.end, after[0]!.roomId, after[0]!.isLocked, after[0]!.isGenerated], [2, '10:00', '11:00', gym, true, true]);
    assert.equal((await masterRows()).length, demandLessons, 'the number of lessons moved');
    placedId = after[0]!.id;
  });

  await check('fp-f: an engine older than `placements` (422 extra_forbidden) is sent the request again without it, and the placed lesson is written all the same', async () => {
    engine.olderThanPlacements = true;
    try {
      const mark = engine.calls.length;
      const result = await generate();
      assert.ok(result.status === 'OPTIMAL' || result.status === 'FEASIBLE', `Generera answered ${result.status}`);
      const sent = callsSince(mark);
      assert.equal(sent.length, 2, `${sent.length} engine calls, expected the refused one and the second`);
      assert.ok('placements' in sent[0]!.body, 'the first request carried no `placements`');
      assert.ok(!('placements' in sent[1]!.body), 'the second request still carries `placements`');
      for (const call of sent) {
        // The förläggning is a fixed lesson to every engine; only its name in a refusal needs the field.
        assert.equal(call.body.fixedLessons.length, 1);
        assert.deepEqual([call.body.fixedLessons[0]!.dayOfWeek, call.body.fixedLessons[0]!.startTime, call.body.fixedLessons[0]!.endTime], [2, '10:00:00', '11:00:00']);
        assert.equal(requirementOfMinutes(call.body, 60).lessonsPerWeek, 1);
      }
      const after = await placedOf();
      assert.equal(after.length, 1, `${after.length} placed lessons`);
      assert.notEqual(after[0]!.id, placedId, 'the placed lesson was left, not written again');
      assert.deepEqual([after[0]!.day, after[0]!.start, after[0]!.end, after[0]!.roomId, after[0]!.isLocked, after[0]!.isGenerated], [2, '10:00', '11:00', gym, true, true]);
      assert.equal((await masterRows()).length, demandLessons);
    } finally {
      engine.olderThanPlacements = false;
    }
  });

  await check('fp-g: a handmade lock with the same teacher on the förläggning\'s time refuses Generera by name (TEACHER) before the engine, and writes nothing', async () => {
    const planted = (
      await one<{ id: string }>(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, 2, '10:00', '11:00', true, false, now()) RETURNING id`,
        [s, year, svenska, g7b, t1.id, sal32],
      )
    ).id;
    try {
      const before = await fingerprint();
      const mark = engine.calls.length;
      const result = await generate();
      assert.equal(result.status, 'INFEASIBLE');
      assert.equal(result.conflicts?.summaryCode, 'PLACEMENTS_REFUSED_SUMMARY', `summary ${result.conflicts?.summaryCode}`);
      assert.deepEqual(result.conflicts?.summaryParams, { count: 1 });
      const lines = result.conflicts?.conflicts ?? [];
      assert.equal(lines.length, 1, `${lines.length} refusal lines`);
      assert.equal(lines[0]!.code, 'PLACEMENT_CANNOT_STAND');
      assert.equal(lines[0]!.params['reason'], 'TEACHER', `reason ${String(lines[0]!.params['reason'])}`);
      assert.equal(callsSince(mark).length, 0, 'the engine was woken');
      assert.equal(await fingerprint(), before, 'the refusal touched the grundschema, the change log or the lunches');
    } finally {
      await owner.query(`DELETE FROM "MasterLessons" WHERE id = $1`, [planted]);
    }
  });

  await check('fp-h: a lunch Generera laid does not refuse the förläggning (save, dialog, Generera), one the school placed does (LUNCH)', async () => {
    const sitting = (generated: boolean) =>
      owner.query(
        `INSERT INTO "LunchSittings" ("schoolId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "isGenerated", "updatedAt")
         VALUES ($1, $2, $3, 2, '10:15', '10:45', $4, now())`,
        [s, year, g7a, generated],
      );
    const sittings = async () => (await all<{ n: number }>(`SELECT count(*)::int AS n FROM "LunchSittings" WHERE "academicYearId" = $1 AND "studentGroupId" = $2 AND "dayOfWeek" = 2`, [year, g7a]))[0]!.n;
    const dialog = async () => (await placements.listOfPost(idrottPost, admin)).verdicts;

    // Generera's own meal over the förläggning's hour.
    await sitting(true);
    assert.deepEqual(await dialog(), [{ index: 0, ok: true }], 'the dialog refuses on a lunch Generera laid');
    const saved = await placements.replace(idrottPost, { placements: [placement] } as never, admin);
    assert.deepEqual(saved.verdicts, [{ index: 0, ok: true }], 'the save refuses on a lunch Generera laid');
    const mark = engine.calls.length;
    const generated = await generate();
    assert.ok(generated.status === 'OPTIMAL' || generated.status === 'FEASIBLE', `Generera answered ${generated.status} ${String(generated.conflicts?.summaryCode ?? '')} ${JSON.stringify(generated.conflicts?.conflicts[0]?.params ?? null)}`);
    assert.equal(callsSince(mark).length, 1);
    assert.equal(await sittings(), 0, 'Generera did not lay the lunch anew (the engine laid none, the old one stands)');

    // The school's own meal over it.
    await sitting(false);
    try {
      const verdicts = await dialog();
      assert.equal(verdicts[0]?.ok, false, 'the dialog lets a lunch the school placed pass');
      assert.equal(verdicts[0]?.reason, 'LUNCH');
      const refusal = await refusalOf(placements.replace(idrottPost, { placements: [placement] } as never, admin));
      assert.equal(refusal.getStatus(), 409);
      const body = refusal.getResponse() as { code?: string; params?: Record<string, unknown> };
      assert.equal(body.code, 'REQUIREMENT_PLACEMENT_REFUSED');
      assert.equal(body.params?.['reason'], 'LUNCH');
      assert.equal(body.params?.['index'], 0);

      const before = await fingerprint();
      const markAgain = engine.calls.length;
      const refused = await generate();
      assert.equal(refused.status, 'INFEASIBLE');
      assert.equal(refused.conflicts?.summaryCode, 'PLACEMENTS_REFUSED_SUMMARY');
      assert.equal(refused.conflicts?.conflicts[0]?.code, 'PLACEMENT_CANNOT_STAND');
      assert.equal(refused.conflicts?.conflicts[0]?.params['reason'], 'LUNCH');
      assert.equal(callsSince(markAgain).length, 0, 'the engine was woken');
      assert.equal(await fingerprint(), before, 'the refusal wrote');
    } finally {
      await owner.query(`DELETE FROM "LunchSittings" WHERE "academicYearId" = $1 AND "studentGroupId" = $2 AND "dayOfWeek" = 2`, [year, g7a]);
    }
  });

  // -------------------------------------------------------------------------
  // Delade lektioner
  // -------------------------------------------------------------------------
  const sharedPlacement = { dayOfWeek: 4, startTime: '10:00', minutes: 40, roomId: sal32, recurrence: 'ALL_WEEKS' as const };
  const storedTeacher = async (): Promise<(string | null)[]> =>
    (await all<{ teacherId: string | null }>(`SELECT "teacherId" FROM "TeachingRequirementPlacements" WHERE "requirementId" = $1 ORDER BY id`, [sharedPost])).map(
      (row) => row.teacherId,
    );
  const shareTeachers = async (): Promise<(string | null)[]> =>
    (await all<{ teacherId: string | null }>(`SELECT "teacherId" FROM "TeachingRequirementShares" WHERE "requirementId" = $1 ORDER BY id`, [sharedPost])).map(
      (row) => row.teacherId,
    );
  const fp409 = async (statements: string[], params: unknown[][]): Promise<string> => {
    await owner.query('BEGIN');
    try {
      for (const [i, sql] of statements.entries()) await owner.query(sql, params[i] ?? []);
      await owner.query('COMMIT');
      return 'ok';
    } catch (error) {
      await owner.query('ROLLBACK').catch(() => undefined);
      const pg = error as { code?: string; detail?: string };
      return pg.code === 'FP409' ? `FP409 ${/reason=([A-Z_]+)/.exec(pg.detail ?? '')?.[1] ?? '?'}` : `${pg.code ?? 'error'} ${summarise(error)}`;
    }
  };

  await check('fp-i: the share teacher\'s lesson saves with its teacher, and a row naming nobody is refused NO_TEACHER at its index', async () => {
    const refused = await refusalOf(
      placements.replace(sharedPost, { placements: [{ ...sharedPlacement, teacherId: t4.id }, { ...sharedPlacement, dayOfWeek: 5 }] } as never, admin),
    );
    assert.equal(refused.getStatus(), 409);
    assert.deepEqual((refused.getResponse() as { params?: unknown }).params, { reason: 'NO_TEACHER', index: 1 });
    assert.deepEqual(await storedTeacher(), [], 'the refused save wrote');

    const saved = await placements.replace(sharedPost, { placements: [{ ...sharedPlacement, teacherId: t4.id }] } as never, admin);
    assert.deepEqual(saved.verdicts, [{ index: 0, ok: true }]);
    assert.equal(saved.placements[0]!.teacherId, t4.id);
    assert.deepEqual(await storedTeacher(), [t4.id]);
  });

  await check('fp-j: Generera locks the share teacher\'s lesson as theirs, takes it off their part, and writes it as theirs', async () => {
    const mark = engine.calls.length;
    const result = await generate();
    assert.ok(result.status === 'OPTIMAL' || result.status === 'FEASIBLE', `Generera answered ${result.status} ${JSON.stringify(result.conflicts?.conflicts?.[0]?.params ?? null)}`);
    const body = callsSince(mark)[0]!.body;
    const post = requirementOfMinutes(body, 40);
    assert.equal(post.lessonsPerWeek, 2, 'the post does not ask for the huvudlärare\'s two alone');
    assert.ok(!('lessonTeacherIds' in post), 'the lessons left are one teacher\'s, yet a list was sent');
    const fixed = body.fixedLessons.filter((lesson) => lesson.dayOfWeek === 4 && lesson.startTime === '10:00:00');
    assert.equal(fixed.length, 1, `${fixed.length} fixed lessons on Thursday 10:00`);
    assert.notEqual(fixed[0]!.teacherId, post.teacherId, 'the fixed lesson is the huvudlärare\'s, not the share teacher\'s');
    const whole = body.placements!.requirements.find((requirement) => requirement.id === post.id)!;
    assert.equal(whole.lessonsPerWeek, 3);
    assert.deepEqual(whole.lessonTeacherIds, [post.teacherId, post.teacherId, fixed[0]!.teacherId]);
    const placed = (await placedOf()).filter((row) => row.groupId === g7b);
    assert.equal(placed.length, 1, `${placed.length} placed lessons of 7B`);
    assert.deepEqual([placed[0]!.teacherId, placed[0]!.day, placed[0]!.start, placed[0]!.end, placed[0]!.roomId], [t4.id, 4, '10:00', '10:40', sal32]);
    const ofPost = (await masterRows()).filter((row) => row.groupId === g7b && !row.fromPlacement && row.teacherId === t3.id);
    assert.equal(ofPost.length, 2, `${ofPost.length} of the huvudlärare\'s lessons written`);
  });

  await check('fp-k: the share given to another teacher (one out, one in, the same lessons) carries the förläggning along, and commits', async () => {
    await requirements.update(sharedPost, { shares: [{ teacherId: t5.id, lessons: 1, minutes: 40 }] } as never, admin);
    assert.deepEqual(await shareTeachers(), [t5.id]);
    assert.deepEqual(await storedTeacher(), [t5.id], 'the förläggning stayed with the teacher who left');
  });

  await check('fp-l: the share removed under its förläggning is refused by naming it, and nothing is written', async () => {
    const refused = await refusalOf(requirements.update(sharedPost, { shares: [] } as never, admin));
    assert.equal(refused.getStatus(), 409);
    const body = refused.getResponse() as { code?: string; params?: Record<string, unknown> };
    assert.equal(body.code, 'REQUIREMENT_PLACEMENTS_DO_NOT_FIT');
    assert.deepEqual(body.params, { reason: 'TEACHER', day: 4, start: '10:00', end: '10:40', weeks: 'ALL_WEEKS' });
    assert.deepEqual(await shareTeachers(), [t5.id], 'the share was removed after all');
    assert.deepEqual(await storedTeacher(), [t5.id]);
  });

  await check('fp-m: another writer\'s swap is refused at COMMIT without the förläggning (FP409 TEACHER) and commits with it', async () => {
    const swap = `UPDATE "TeachingRequirementShares" SET "teacherId" = $1, "updatedAt" = now() WHERE "requirementId" = $2`;
    const follow = `UPDATE "TeachingRequirementPlacements" SET "teacherId" = $1, "updatedAt" = now() WHERE "requirementId" = $2`;
    assert.equal(await fp409([swap], [[t6.id, sharedPost]]), 'FP409 TEACHER');
    assert.deepEqual(await shareTeachers(), [t5.id], 'the refused swap stayed');
    // A delete and an insert, as every writer of shares replaces them, then the förläggning: one transaction.
    assert.equal(
      await fp409(
        [
          `DELETE FROM "TeachingRequirementShares" WHERE "requirementId" = $1`,
          `INSERT INTO "TeachingRequirementShares" ("schoolId", "requirementId", "teacherId", lessons, minutes, "updatedAt") VALUES ($1, $2, $3, 1, 40, now())`,
          follow,
        ],
        [[sharedPost], [s, sharedPost, t6.id], [t6.id, sharedPost]],
      ),
      'ok',
    );
    assert.deepEqual(await shareTeachers(), [t6.id]);
    assert.deepEqual(await storedTeacher(), [t6.id]);
  });

  await check('fp-n: the teacher removed leaves the lesson nobody\'s, which is not saved so, and a teacher given to the share takes it', async () => {
    await owner.query(`DELETE FROM "Users" WHERE id = $1`, [t6.id]);
    assert.deepEqual(await shareTeachers(), [null]);
    assert.deepEqual(await storedTeacher(), [null], 'the förläggning did not lose its removed teacher');

    const shown = await placements.listOfPost(sharedPost, admin);
    assert.equal(shown.placements[0]!.teacherId, null);
    const refused = await refusalOf(placements.replace(sharedPost, { placements: [sharedPlacement] } as never, admin));
    assert.deepEqual((refused.getResponse() as { params?: unknown }).params, { reason: 'NO_TEACHER', index: 0 });

    await requirements.update(sharedPost, { shares: [{ teacherId: t5.id, lessons: 1, minutes: 40 }] } as never, admin);
    assert.deepEqual(await storedTeacher(), [t5.id], 'the share nobody taught was given a teacher, and the förläggning stayed nobody\'s');
  });
}

main().then(
  () => {
    // Everything is closed by now; the exit is explicit so that a handle some module left open cannot hold the job.
    process.exit(process.exitCode ?? 0);
  },
  (error: unknown) => {
    console.error(`FAIL ${summarise(error)}`);
    process.exit(1);
  },
);
