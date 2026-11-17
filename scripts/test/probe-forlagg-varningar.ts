/**
 * Varningarna medan man lägger (D1) mot riktig Postgres OCH den riktiga motorn: för varje varning ett fall där Generera sedan vägrar av
 * samma skäl, och ett där den inte gör det. Varningen ska varken vara tyst eller ropa i onödan, och `refuses` ska vara sann bara där
 * motorn vägrar.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@127.0.0.1:5646/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@127.0.0.1:5646/schemapro' \
 *   AI_ENGINE_URL=http://127.0.0.1:8824 AI_ENGINE_API_KEY=<the engine's API_KEY> AI_ENGINE_TIMEOUT_MS=120000 \
 *   JWT_SECRET=… JWT_ISSUER=https://ci.invalid/auth/v1 NODE_ENV=test \
 *   npx ts-node --transpile-only scripts/test/probe-forlagg-varningar.ts
 *
 * Med en motor ur det här trädet på AI_ENGINE_URL körs också Generera på riktigt. Med PROBE_NO_ENGINE=1 (Database-jobbet i CI har ingen
 * motor; appen kräver ändå en AI_ENGINE_URL för att starta) hålls det gatewayen säger mot databasen ensam: samma fall, samma varningar,
 * utan att Generera frågas.
 *
 * Varje fall är en egen skola (läsåret 2095/96, som börjar en lördag) där varje post är helt lagd för hand, så att motorn bara har
 * låsen och de fästa lektionerna att ta ställning till. Raderna sparas genom tjänsten som sidan gör (en vägran vore ett fel i provet:
 * en varning vägrar aldrig en sparning), varningarna läses ur tavlan OCH ur sparningens svar (samma ord på båda ställen), och
 * Generera körs på riktigt. Ett fall som felar skriver sin FAIL-rad och körningen går vidare. Exitkoden är 1 vid någon FAIL.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';

const SLUG = 'probe-forlagg-varningar';
let failures = 0;

/**
 * Whether Generera is asked. The app needs AI_ENGINE_URL and AI_ENGINE_API_KEY to start at all (the CI job gives it a URL nobody
 * answers at), so a run with no engine says so with PROBE_NO_ENGINE=1.
 */
const withEngine = (): boolean => process.env['PROBE_NO_ENGINE'] !== '1' && Boolean(process.env['AI_ENGINE_URL'] && process.env['AI_ENGINE_API_KEY']);

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
  // Without an engine (the Database job of CI has none) the probe holds what the gateway says; with one, what Generera then does.
  if (!withEngine()) console.log('     (no engine: the warnings are checked against the database alone, and Generera is not asked)');
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  try {
    await sweep(owner);
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
    await sweep(owner).catch((error: unknown) => console.error(`the probe's schools were not dropped: ${summarise(error)}`));
    await owner.end();
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (failures > 0) {
    console.error(`==> Varningar probe FAILED: ${failures} step(s) in ${seconds} s`);
    process.exitCode = 1;
  } else {
    console.log(`==> Varningar probe passed in ${seconds} s`);
  }
}

async function sweep(owner: Client): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug LIKE $1`, [`${SLUG}%`]);
}

// ISO dates of a läsår that starts on a Saturday: its first Monday is two days later.
const dayMs = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const START = (() => {
  let ms = Date.parse('2095-08-10T00:00:00.000Z');
  while (new Date(ms).getUTCDay() !== 6) ms += dayMs;
  return ms;
})();
const YEAR_START = iso(START); // a Saturday
const MONDAY_1 = iso(START + 2 * dayMs);
const week = (n: number): string => iso(START + 2 * dayMs + 7 * n * dayMs); // the Monday n weeks after the first
const sunday = (n: number): string => iso(START + 2 * dayMs + 7 * n * dayMs + 6 * dayMs); // that week's Sunday
const YEAR_END = iso(START + 2 * dayMs + 7 * 42 * dayMs + 4 * dayMs);

type Recurrence = 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS';
interface Row {
  dayOfWeek: number;
  startTime: string;
  minutes: number;
  roomId: string | null;
  recurrence: Recurrence;
}

/** What a case says: the warnings it expects (post, code, refuses), what Generera does, and for a refusal a code that names the cause. */
interface Case {
  name: string;
  lunch?: boolean;
  build: (w: World) => Promise<void>;
  warns: Array<[post: string, code: string, refuses: boolean]>;
  generera: 'SOLVES' | 'REFUSES';
  /** A refusal of the engine's that must be among the answer's lines: the same cause as the warning says. */
  because?: RegExp;
}

interface World {
  school: string;
  year: string;
  admin: AuthenticatedUser;
  reader: AuthenticatedUser;
  one: <T extends object>(sql: string, params?: unknown[]) => Promise<T>;
  query: (sql: string, params?: unknown[]) => Promise<void>;
  group: (name: string) => Promise<string>;
  teacher: (name: string) => Promise<string>;
  roomType: (name: string) => Promise<string>;
  room: (name: string, type: string) => Promise<string>;
  subject: (name: string, type: string) => Promise<string>;
  post: (key: string, group: string, subject: string, teacher: string, options?: { lessons?: number; minutes?: number; recurrence?: Recurrence; startDate?: string; endDate?: string }) => Promise<string>;
  lay: (key: string, rows: Array<Partial<Row> & { dayOfWeek: number; startTime: string; minutes: number }>) => Promise<void>;
  cap: (teacher: string, minutes: number) => Promise<void>;
  limits: (teacher: string, limits: { days?: number; stretch?: [number, number] }) => Promise<void>;
  kept: (lesson: { group: string; subject: string; teacher: string; room: string; dayOfWeek: number; start: string; end: string }) => Promise<void>;
  meal: (group: string, dayOfWeek: number, start: string, end: string) => Promise<void>;
  posts: Map<string, string>;
  /** The warnings each lay answered with, by post key. */
  answered: Map<string, Array<{ code: string; refuses: boolean; params?: unknown }>>;
}

async function run(owner: Client, app: import('@nestjs/common').INestApplicationContext): Promise<void> {
  const { Role } = await import('../../src/auth/enums/role.enum');
  const { OptimizationProxyService } = await import('../../src/optimization/optimization-proxy.service');
  const { RequirementPlacementsService } = await import('../../src/requirement-placements/requirement-placements.service');
  const resolve = <T>(token: abstract new (...args: never[]) => T): T => app.get<T>(token as never, { strict: false });
  const proxy = resolve(OptimizationProxyService);
  const placements = resolve(RequirementPlacementsService);
  const { storedOf, conflictView } = await import('../../src/optimization/stored-conflicts');

  let counter = 0;
  async function build(label: string, lunch: boolean): Promise<World> {
    counter += 1;
    const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
    const query = async (sql: string, params: unknown[] = []): Promise<void> => void (await owner.query(sql, params));
    const s = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [`Probe varningar ${label}`, `${SLUG}-${counter}`])).id;
    const year = (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt") VALUES ($1, 'Probe 2095/96', $2, $3, true, now()) RETURNING id`,
        [s, YEAR_START, YEAR_END],
      )
    ).id;
    const person = async (name: string, role: string, adminProfile: string | null = null) => {
      const authId = randomUUID();
      const row = await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
         VALUES ($1, $2, $3, 'Varning', $4, $5, $6, true, now()) RETURNING id`,
        [s, `${SLUG}-${counter}-${name}@example.invalid`, name, role, adminProfile, authId],
      );
      return { id: row.id, authId };
    };
    const adminRow = await person('admin', 'SCHOOL_ADMIN', 'FULL');
    const readerRow = await person('reader', 'SCHOOL_ADMIN', 'SCHEMALAGGARE');
    const admin = { authId: adminRow.authId, userId: adminRow.id, schoolId: s, role: Role.SCHOOL_ADMIN, adminProfile: 'FULL', channel: 'WEB', hrRead: false } as AuthenticatedUser;
    const reader = { authId: readerRow.authId, userId: readerRow.id, schoolId: s, role: Role.SCHOOL_ADMIN, adminProfile: 'SCHEMALAGGARE', channel: 'WEB', hrRead: false } as AuthenticatedUser;
    if (lunch) {
      await query(`INSERT INTO "LunchSettings" ("schoolId", "lunchEnabled", "lunchStartTime", "lunchEndTime", "lunchMinutes", "updatedAt") VALUES ($1, true, '10:30', '13:00', 30, now())`, [s]);
    }
    const posts = new Map<string, string>();
    const answered = new Map<string, Array<{ code: string; refuses: boolean; params?: unknown }>>();
    const world: World = {
      school: s,
      year,
      admin,
      reader,
      one,
      query,
      posts,
      answered,
      group: async (name) =>
        (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', 7, now()) RETURNING id`, [s, year, name])).id,
      teacher: async (name) => (await person(name, 'TEACHER')).id,
      roomType: async (name) => (await one<{ id: string }>(`INSERT INTO "RoomTypes" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [s, name])).id,
      room: async (name, type) => (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, capacity, "roomTypeId", "updatedAt") VALUES ($1, $2, 30, $3, now()) RETURNING id`, [s, name, type])).id,
      subject: async (name, type) => (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "requiredRoomTypeId", "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [s, name, type])).id,
      post: async (key, group, subject, teacher, options = {}) => {
        const id = (
          await one<{ id: string }>(
            `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", recurrence, "startDate", "endDate", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::"LessonRecurrence", $9, $10, now()) RETURNING id`,
            [s, year, subject, group, teacher, options.lessons ?? 1, options.minutes ?? 60, options.recurrence ?? 'ALL_WEEKS', options.startDate ?? null, options.endDate ?? null],
          )
        ).id;
        posts.set(key, id);
        return id;
      },
      lay: async (key, rows) => {
        const id = posts.get(key)!;
        const body = rows.map((row) => ({ roomId: null, recurrence: 'ALL_WEEKS' as const, ...row }));
        // A save is never refused for a warning: the answer must be a 200 with every row clean.
        const answer = await placements.replace(id, { placements: body } as never, admin);
        assert.deepEqual(
          answer.verdicts.map((verdict) => verdict.ok),
          body.map(() => true),
          `the rows of ${key} do not hold as laid: ${JSON.stringify(answer.verdicts)}`,
        );
        answered.set(key, answer.warnings.map((warning) => ({ code: warning.code, refuses: warning.refuses, params: warning.params })));
      },
      cap: async (teacher, minutes) => query(`INSERT INTO "TeacherWorkRules" ("schoolId", "userId", "maxTeachingMinutesPerDay", "updatedAt") VALUES ($1, $2, $3, now())`, [s, teacher, minutes]),
      limits: async (teacher, limits) =>
        query(
          `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "maxTeachingDaysPerWeek", "maxConsecutiveTeachingMinutes", "consecutiveBreakMinutes", "updatedAt")
           VALUES ($1, $2, $3, 100, $4, $5, $6, now())`,
          [s, teacher, year, limits.days ?? null, limits.stretch?.[0] ?? null, limits.stretch?.[1] ?? null],
        ),
      kept: async (lesson) =>
        query(
          `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, false, now())`,
          [s, year, lesson.subject, lesson.group, lesson.teacher, lesson.room, lesson.dayOfWeek, lesson.start, lesson.end],
        ),
      meal: async (group, dayOfWeek, start, end) =>
        query(`INSERT INTO "LunchSittings" ("schoolId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime", headcount, "isGenerated", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, 0, false, now())`, [s, year, group, dayOfWeek, start, end]),
    };
    return world;
  }

  /** The classes' rooms and the subjects every case uses, for the cases that need not a kind of room of their own. */
  async function classroomsOf(w: World) {
    const type = await w.roomType('Klassrum');
    const rooms = [await w.room('K1', type), await w.room('K2', type), await w.room('K3', type), await w.room('K4', type)];
    return { type, rooms, subject: await w.subject('Matematik', type), subject2: await w.subject('Svenska', type), subject3: await w.subject('Engelska', type), subject4: await w.subject('Biologi', type) };
  }

  /**
   * A post nobody has laid: the engine has something to place, so it asks the week its rules. With every lesson laid by hand
   * Generera has nothing to do and never looks at them, which would make a "solves" prove nothing.
   */
  async function free(w: World, c: Awaited<ReturnType<typeof classroomsOf>>, group: string, teacher: string, minutes = 60): Promise<void> {
    await w.post('F', group, c.subject3, teacher, { minutes });
  }

  const cases: Case[] = [];

  // ------------------------------------------------------------------ lärarens dag: taket
  const twoHoursMonday = async (w: World, pin: boolean, cap: number) => {
    const c = await classroomsOf(w);
    const { rooms, subject, subject2 } = c;
    const anna = await w.teacher('Anna');
    const g1 = await w.group('7A');
    const g2 = await w.group('7B');
    await free(w, c, await w.group('7C'), anna);
    await w.cap(anna, cap);
    await w.post('A', g1, subject, anna);
    await w.post('B', g2, subject2, anna);
    await w.lay('A', [{ dayOfWeek: 1, startTime: '08:00', minutes: 60, roomId: rooms[0]! }]);
    await w.lay('B', [{ dayOfWeek: 1, startTime: '09:00', minutes: 60, roomId: pin ? null : rooms[1]! }]);
  };
  cases.push(
    { name: 'taket: två lås en timme var, taket 90: varnar, vägras inte (motorn tar låsen som de är)', build: (w) => twoHoursMonday(w, false, 90), warns: [['A', 'TEACHER_DAY_TOO_LONG', false], ['B', 'TEACHER_DAY_TOO_LONG', false]], generera: 'SOLVES' },
    { name: 'taket: ett lås och en fäst lektion, taket 90: varnar att Generera vägrar, och motorn vägrar', build: (w) => twoHoursMonday(w, true, 90), warns: [['A', 'TEACHER_DAY_TOO_LONG', true], ['B', 'TEACHER_DAY_TOO_LONG', true]], generera: 'REFUSES', because: /TEACHER_DAILY_CAP_CANNOT_BE_KEPT/ },
    { name: 'taket: precis vid taket (120) varnar inte, med lås', build: (w) => twoHoursMonday(w, false, 120), warns: [], generera: 'SOLVES' },
    { name: 'taket: precis vid taket (120) varnar inte, med en fäst lektion, och motorn lägger den', build: (w) => twoHoursMonday(w, true, 120), warns: [], generera: 'SOLVES' },
  );

  // ------------------------------------------------------------------ lärarens dag: dagarna
  const threeDays = async (w: World, limit: number, thirdIsPin: boolean, extraPinOnMonday = false) => {
    const c = await classroomsOf(w);
    const { rooms, subject, subject2 } = c;
    const anna = await w.teacher('Anna');
    const [g1, g2, g3] = [await w.group('7A'), await w.group('7B'), await w.group('7C')];
    await free(w, c, await w.group('7E'), anna);
    await w.limits(anna, { days: limit });
    await w.post('A', g1, subject, anna);
    await w.post('B', g2, subject2, anna);
    await w.post('C', g3, subject, anna);
    await w.lay('A', [{ dayOfWeek: 1, startTime: '08:00', minutes: 60, roomId: rooms[0]! }]);
    await w.lay('B', [{ dayOfWeek: 2, startTime: '08:00', minutes: 60, roomId: rooms[1]! }]);
    if (extraPinOnMonday) {
      await w.lay('C', [{ dayOfWeek: 3, startTime: '08:00', minutes: 60, roomId: rooms[2]! }]);
      const g4 = await w.group('7D');
      await w.post('D', g4, subject2, anna);
      await w.lay('D', [{ dayOfWeek: 1, startTime: '10:00', minutes: 60, roomId: null }]);
    } else {
      await w.lay('C', [{ dayOfWeek: 3, startTime: '08:00', minutes: 60, roomId: thirdIsPin ? null : rooms[2]! }]);
    }
  };
  const threeWarned = (refuses: boolean): Case['warns'] => ['A', 'B', 'C'].map((post) => [post, 'TEACHER_WEEK_TOO_MANY_DAYS', refuses] as [string, string, boolean]);
  cases.push(
    { name: 'dagarna: lås tre dagar, gränsen två: varnar, vägras inte', build: (w) => threeDays(w, 2, false), warns: threeWarned(false), generera: 'SOLVES' },
    { name: 'dagarna: lås två dagar och en fäst lektion en tredje, gränsen två: varnar att Generera vägrar, och motorn vägrar', build: (w) => threeDays(w, 2, true), warns: threeWarned(true), generera: 'REFUSES', because: /TEACHER_WORK_DAYS_CANNOT_BE_KEPT/ },
    { name: 'dagarna: gränsen tre varnar inte', build: (w) => threeDays(w, 3, true), warns: [], generera: 'SOLVES' },
    {
      name: 'dagarna: en fäst lektion på en dag som låsen redan har, gränsen två: varnar men vägras inte (P \\ L är tom)',
      build: (w) => threeDays(w, 2, false, true),
      warns: [['A', 'TEACHER_WEEK_TOO_MANY_DAYS', false], ['B', 'TEACHER_WEEK_TOO_MANY_DAYS', false], ['C', 'TEACHER_WEEK_TOO_MANY_DAYS', false], ['D', 'TEACHER_WEEK_TOO_MANY_DAYS', false]],
      generera: 'SOLVES',
    },
  );

  // ------------------------------------------------------------------ lärarens dag: sammanhängande undervisning
  const stretchOf = async (w: World, secondMinutes: number) => {
    const c = await classroomsOf(w);
    const { rooms, subject, subject2 } = c;
    const anna = await w.teacher('Anna');
    const [g1, g2] = [await w.group('7A'), await w.group('7B')];
    await free(w, c, await w.group('7C'), anna);
    await w.limits(anna, { stretch: [180, 30] });
    await w.post('A', g1, subject, anna, { minutes: 120 });
    await w.post('B', g2, subject2, anna, { minutes: secondMinutes });
    await w.lay('A', [{ dayOfWeek: 1, startTime: '08:00', minutes: 120, roomId: rooms[0]! }]);
    await w.lay('B', [{ dayOfWeek: 1, startTime: '10:00', minutes: secondMinutes, roomId: rooms[1]! }]);
  };
  cases.push(
    { name: 'sammanhängande: 240 minuter i följd mot 180: varnar, och vägras aldrig (generatorn håller gränsen som ett önskemål)', build: (w) => stretchOf(w, 120), warns: [['A', 'TEACHER_STRETCH_TOO_LONG', false], ['B', 'TEACHER_STRETCH_TOO_LONG', false]], generera: 'SOLVES' },
    { name: 'sammanhängande: precis 180 varnar inte', build: (w) => stretchOf(w, 60), warns: [], generera: 'SOLVES' },
  );

  // ------------------------------------------------------------------ klassens lunch
  const lunchWeek = async (w: World, shape: { first: [string, number]; second?: [string, number]; secondIsPin?: boolean; meal?: [string, string]; recurrences?: [Recurrence, Recurrence] }) => {
    const c = await classroomsOf(w);
    const { rooms, subject, subject2 } = c;
    const [anna, bo, cy] = [await w.teacher('Anna'), await w.teacher('Bo'), await w.teacher('Cy')];
    const g1 = await w.group('7A');
    // 7A has a lesson left to place, so that the engine looks at the class's lunch; a meal placed by hand comes first.
    await free(w, c, g1, cy, 45);
    if (shape.meal) await w.meal(g1, 2, shape.meal[0], shape.meal[1]);
    await w.post('A', g1, subject, anna, { minutes: shape.first[1], recurrence: shape.recurrences?.[0] ?? 'ALL_WEEKS' });
    await w.lay('A', [{ dayOfWeek: 2, startTime: shape.first[0], minutes: shape.first[1], roomId: rooms[0]!, recurrence: shape.recurrences?.[0] ?? 'ALL_WEEKS' }]);
    if (shape.second) {
      await w.post('B', g1, subject2, bo, { minutes: shape.second[1], recurrence: shape.recurrences?.[1] ?? 'ALL_WEEKS' });
      await w.lay('B', [{ dayOfWeek: 2, startTime: shape.second[0], minutes: shape.second[1], roomId: shape.secondIsPin ? null : rooms[1]!, recurrence: shape.recurrences?.[1] ?? 'ALL_WEEKS' }]);
    }
  };
  const both = (code: string, refuses: boolean): Case['warns'] => [['A', code, refuses], ['B', code, refuses]];
  cases.push(
    { name: 'lunchen: två lås fyller fönstret 10:30-13:00: varnar att Generera vägrar, och motorn säger att lektionerna lämnar ingen rast', lunch: true, build: (w) => lunchWeek(w, { first: ['10:30', 75], second: ['11:45', 75] }), warns: both('CLASS_HAS_NO_LUNCH', true), generera: 'REFUSES', because: /LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK/ },
    { name: 'lunchen: ett lås och en fäst lektion fyller fönstret: varnar att Generera vägrar, och motorn vägrar', lunch: true, build: (w) => lunchWeek(w, { first: ['10:30', 75], second: ['11:45', 75], secondIsPin: true }), warns: both('CLASS_HAS_NO_LUNCH', true), generera: 'REFUSES', because: /LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK/ },
    { name: 'lunchen: en start kvar (12:30) varnar inte, och motorn lägger lunchen där', lunch: true, build: (w) => lunchWeek(w, { first: ['10:30', 120] }), warns: [], generera: 'SOLVES' },
    { name: 'lunchen: en start mindre (12:35 är förbi sista starten) varnar', lunch: true, build: (w) => lunchWeek(w, { first: ['10:30', 125] }), warns: [['A', 'CLASS_HAS_NO_LUNCH', true]], generera: 'REFUSES', because: /LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK/ },
    { name: 'lunchen: en handlagd måltid efter fönstret räddar dagen: ingen varning, och motorn lägger den', lunch: true, build: (w) => lunchWeek(w, { first: ['10:30', 75], second: ['11:45', 75], meal: ['13:00', '13:30'] }), warns: [], generera: 'SOLVES' },
    { name: 'lunchen: udda veckors lektion och jämna veckors fyller fönstret tillsammans: måltiden är lika varje vecka, så varnar och motorn vägrar', lunch: true, build: (w) => lunchWeek(w, { first: ['10:30', 75], second: ['11:45', 75], recurrences: ['ODD_WEEKS', 'EVEN_WEEKS'] }), warns: both('CLASS_HAS_NO_LUNCH', true), generera: 'REFUSES', because: /LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK/ },
    { name: 'lunchen: lunchen avstängd i skolan varnar inte', lunch: false, build: (w) => lunchWeek(w, { first: ['10:30', 75], second: ['11:45', 75] }), warns: [], generera: 'SOLVES' },
  );

  // Terminer: tre poster som delar läsåret i många perioder. Klassen 7A:s lektioner är höstens och vårens; 7B:s poster delar hösten i två.
  const terms = async (w: World, shape: 'AUTUMN_FILLS' | 'NEVER_MEET') => {
    const c = await classroomsOf(w);
    const { rooms, subject, subject2, subject3, subject4 } = c;
    const [anna, bo, cy, di, ed] = [await w.teacher('Anna'), await w.teacher('Bo'), await w.teacher('Cy'), await w.teacher('Di'), await w.teacher('Ed')];
    const [g1, g2] = [await w.group('7A'), await w.group('7B')];
    await w.post('F', g1, subject3, ed, { minutes: 45 });
    const autumn = { startDate: MONDAY_1, endDate: sunday(17) };
    const spring = { startDate: week(21), endDate: sunday(40) };
    // 7B's two posts cut the autumn in three and the spring in one: the periods are many, and a cause of 7A's spans several.
    await w.post('X', g2, subject, cy, { minutes: 60, startDate: MONDAY_1, endDate: sunday(7) });
    await w.post('Y', g2, subject2, di, { minutes: 60, startDate: week(8), endDate: sunday(17) });
    await w.lay('X', [{ dayOfWeek: 4, startTime: '08:00', minutes: 60, roomId: rooms[3]! }]);
    await w.lay('Y', [{ dayOfWeek: 4, startTime: '08:00', minutes: 60, roomId: rooms[3]! }]);
    if (shape === 'AUTUMN_FILLS') {
      await w.post('A', g1, subject, anna, { minutes: 75, ...autumn });
      await w.post('B', g1, subject2, bo, { minutes: 75, ...autumn });
      await w.lay('A', [{ dayOfWeek: 2, startTime: '10:30', minutes: 75, roomId: rooms[0]! }]);
      await w.lay('B', [{ dayOfWeek: 2, startTime: '11:45', minutes: 75, roomId: rooms[1]! }]);
      // The spring's lesson leaves room: it must not be warned.
      await w.post('C', g1, subject4, anna, { minutes: 60, ...spring });
      await w.lay('C', [{ dayOfWeek: 2, startTime: '10:30', minutes: 60, roomId: rooms[0]! }]);
    } else {
      await w.post('A', g1, subject, anna, { minutes: 75, ...autumn });
      await w.post('B', g1, subject2, bo, { minutes: 75, ...spring });
      await w.lay('A', [{ dayOfWeek: 2, startTime: '10:30', minutes: 75, roomId: rooms[0]! }]);
      await w.lay('B', [{ dayOfWeek: 2, startTime: '11:45', minutes: 75, roomId: rooms[1]! }]);
    }
  };
  cases.push(
    { name: 'terminer: höstens lektioner fyller fönstret i flera perioder: varnar höstens rader en gång vardera, inte vårens, och motorn vägrar', lunch: true, build: (w) => terms(w, 'AUTUMN_FILLS'), warns: [['A', 'CLASS_HAS_NO_LUNCH', true], ['B', 'CLASS_HAS_NO_LUNCH', true]], generera: 'REFUSES', because: /LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK/ },
    { name: 'terminer: höstens och vårens lektioner fyller fönstret tillsammans men möts aldrig: ingen varning, och motorn lägger veckan', lunch: true, build: (w) => terms(w, 'NEVER_MEET'), warns: [], generera: 'SOLVES' },
  );

  // ------------------------------------------------------------------ en sal av rätt slag
  const slojd = async (w: World, shape: { rooms: number; second: 'LOCK' | 'PIN' | 'NONE'; secondStart: string; firstIsPin?: boolean }) => {
    const slojdType = await w.roomType('Slöjdsal');
    const classType = await w.roomType('Klassrum');
    const slojdRooms: string[] = [];
    for (let n = 0; n < shape.rooms; n += 1) slojdRooms.push(await w.room(`Slöjd ${n + 1}`, slojdType));
    await w.room('K1', classType);
    const sloyd = await w.subject('Slöjd', slojdType);
    const [anna, bo] = [await w.teacher('Anna'), await w.teacher('Bo')];
    const [g1, g2] = [await w.group('7A'), await w.group('7B')];
    await w.post('P1', g1, sloyd, anna);
    await w.post('P2', g2, sloyd, bo);
    // The first lesson holds a room of the kind (a lock) or has none (a pin); the second is a pin whose kind has one room.
    await w.lay('P1', [{ dayOfWeek: 1, startTime: '09:00', minutes: 60, roomId: shape.firstIsPin ? null : slojdRooms[0]! }]);
    await w.lay('P2', [{ dayOfWeek: 1, startTime: shape.secondStart, minutes: 60, roomId: null }]);
  };
  cases.push(
    { name: 'sal: ett lås håller slöjdsalen och en fäst lektion vill ha den samma timme: varnar att Generera vägrar, och motorn vägrar', build: (w) => slojd(w, { rooms: 1, second: 'PIN', secondStart: '09:00' }), warns: [['P2', 'NO_ROOM_FREE', true]], generera: 'REFUSES', because: /PLACED_LESSON_IN_THE_WAY_ANY_ROOM/ },
    { name: 'sal: en andra slöjdsal varnar inte, och motorn ger den fästa lektionen den', build: (w) => slojd(w, { rooms: 2, second: 'PIN', secondStart: '09:00' }), warns: [], generera: 'SOLVES' },
    { name: 'sal: en annan timme varnar inte', build: (w) => slojd(w, { rooms: 1, second: 'PIN', secondStart: '10:00' }), warns: [], generera: 'SOLVES' },
    { name: 'sal: två fästa lektioner samma timme och en sal: båda varnas, och motorn vägrar', build: (w) => slojd(w, { rooms: 1, second: 'PIN', secondStart: '09:00', firstIsPin: true }), warns: [['P1', 'NO_ROOM_FREE', true], ['P2', 'NO_ROOM_FREE', true]], generera: 'REFUSES', because: /PLACED_LESSON_IN_THE_WAY_ANY_ROOM/ },
  );

  // ------------------------------------------------------------------ udda och jämna veckor, och lektioner som Generera bevarar
  const oddEven = async (w: World, cap: number) => {
    const c = await classroomsOf(w);
    const { rooms, subject, subject2 } = c;
    const anna = await w.teacher('Anna');
    const [g1, g2] = [await w.group('7A'), await w.group('7B')];
    await free(w, c, await w.group('7C'), anna);
    await w.cap(anna, cap);
    await w.post('A', g1, subject, anna, { minutes: 180, recurrence: 'ODD_WEEKS' });
    await w.post('B', g2, subject2, anna, { minutes: 180, recurrence: 'EVEN_WEEKS' });
    await w.lay('A', [{ dayOfWeek: 1, startTime: '08:00', minutes: 180, roomId: rooms[0]!, recurrence: 'ODD_WEEKS' }]);
    await w.lay('B', [{ dayOfWeek: 1, startTime: '08:00', minutes: 180, roomId: rooms[1]!, recurrence: 'EVEN_WEEKS' }]);
  };
  const keptHour = async (w: World, pin: boolean) => {
    const c = await classroomsOf(w);
    const { rooms, subject, subject2 } = c;
    const anna = await w.teacher('Anna');
    const [g1, g2] = [await w.group('7A'), await w.group('7B')];
    await free(w, c, await w.group('7C'), anna);
    await w.cap(anna, 90);
    // An hour Anna keeps in the grundschema (locked, made by hand), and the row beside it.
    await w.kept({ group: g1, subject, teacher: anna, room: rooms[0]!, dayOfWeek: 1, start: '08:00', end: '09:00' });
    await w.post('B', g2, subject2, anna);
    await w.lay('B', [{ dayOfWeek: 1, startTime: '09:00', minutes: 60, roomId: pin ? null : rooms[1]! }]);
  };
  cases.push(
    { name: 'veckor: tre timmar udda och tre jämna samma måndag är tre timmar i varje vecka: taket 200 varnar inte, och motorn lägger veckan', build: (w) => oddEven(w, 200), warns: [], generera: 'SOLVES' },
    { name: 'veckor: samma timmar mot taket 150 varnar (tre timmar är över), och vägras inte: låsen tas som de är', build: (w) => oddEven(w, 150), warns: [['A', 'TEACHER_DAY_TOO_LONG', false], ['B', 'TEACHER_DAY_TOO_LONG', false]], generera: 'SOLVES' },
    { name: 'bevarat: en timme Generera bevarar och en förläggning med sal över taket: varnar bara raden, och vägras inte', build: (w) => keptHour(w, false), warns: [['B', 'TEACHER_DAY_TOO_LONG', false]], generera: 'SOLVES' },
    { name: 'bevarat: samma med en fäst lektion: varnar att Generera vägrar, och motorn vägrar av taket', build: (w) => keptHour(w, true), warns: [['B', 'TEACHER_DAY_TOO_LONG', true]], generera: 'REFUSES', because: /TEACHER_DAILY_CAP_CANNOT_BE_KEPT/ },
  );

  // ------------------------------------------------------------------ run them
  for (const one of cases) {
    await check(one.name, async () => {
      const w = await build(one.name.slice(0, 40), one.lunch ?? false);
      await one.build(w);
      const board = await placements.boardOfYear(w.year, w.admin);
      const keyOf = (postId: string): string => [...w.posts].find(([, id]) => id === postId)![0];
      const got = board.warnings.map((warning) => [keyOf(warning.requirementId), warning.code, warning.refuses] as [string, string, boolean]).sort();
      const expected = [...one.warns].sort();
      assert.deepEqual(got, expected, `warnings on the board: ${JSON.stringify(board.warnings)}`);
      // The answer to the post's own read says the same words as the board, at its own rows.
      for (const [key, id] of w.posts) {
        const read = await placements.listOfPost(id, w.admin);
        const onBoard = board.warnings.filter((warning) => warning.requirementId === id).map((warning) => [warning.code, warning.refuses, JSON.stringify(warning.params ?? null)]).sort();
        const ofPost = read.warnings.map((warning) => [warning.code, warning.refuses, JSON.stringify(warning.params ?? null)]).sort();
        assert.deepEqual(ofPost, onBoard, `the read of ${key} and the board say different things`);
        for (const warning of read.warnings) assert.ok(read.placements.some((row) => row.id === warning.rowId), `a warning of ${key} names a row the answer does not have`);
      }
      // Every warning is the same on the save's answer as on the board, for the last post laid.
      for (const [key, laid] of w.answered) {
        const here = board.warnings.filter((warning) => warning.requirementId === w.posts.get(key)!).map((warning) => warning.code);
        assert.ok(laid.length <= here.length, `the save of ${key} said ${laid.length} warnings and the board ${here.length}`);
      }
      // A reader without HR-läs gets the days and the stretch without their figures, and the others the same.
      const forReader = await placements.boardOfYear(w.year, w.reader);
      for (const warning of forReader.warnings) {
        if (warning.code.endsWith('_HIDDEN')) assert.equal(warning.params, undefined, 'a hidden warning carries no figure');
        assert.ok(!['TEACHER_WEEK_TOO_MANY_DAYS', 'TEACHER_STRETCH_TOO_LONG'].includes(warning.code), `a reader without HR-läs read ${warning.code}`);
      }
      assert.equal(forReader.warnings.length, board.warnings.length, 'the reader without HR-läs is told as many things');
      // The week is what Generera is then asked about.
      if (!withEngine()) return;
      const answer = await proxy.triggerScheduling(w.year, w.admin);
      const lines = (answer.conflicts?.conflicts ?? []).map((detail) => conflictView(storedOf(detail)));
      const said = `${answer.status} ${answer.conflicts?.summaryCode ?? ''} ${lines.map((line) => line.code).join(',')}`;
      if (one.generera === 'SOLVES') assert.ok(['OPTIMAL', 'FEASIBLE'].includes(answer.status), `Generera should solve this week: ${said}`);
      else {
        assert.ok(!['OPTIMAL', 'FEASIBLE'].includes(answer.status), `Generera should refuse this week and solved it: ${answer.status}`);
        if (one.because) assert.ok(one.because.test(said), `Generera refused, but not for this cause: ${said}`);
      }
      console.log(`     (Generera: ${said.trim()})`);
    });
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    console.error(`FAIL ${summarise(error)}`);
    process.exit(1);
  },
);
