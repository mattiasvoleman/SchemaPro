/**
 * Ett parallellt blocks förläggningar (PR C1) genom Nests egen injektion, mot Postgres och mot den RIKTIGA motorn.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@127.0.0.1:5617/c1_real?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@127.0.0.1:5617/c1_real' \
 *   AI_ENGINE_URL=http://127.0.0.1:8813 AI_ENGINE_API_KEY=<motorns API_KEY> AI_ENGINE_TIMEOUT_MS=90000 \
 *   JWT_SECRET=x JWT_ISSUER=https://ci.invalid/auth/v1 NODE_ENV=test \
 *   npx ts-node --transpile-only scripts/test/probe-forlagg-block-motor.ts
 *
 * Inte i CI: provet frågar en motor på riktigt (optimization-engine i det här trädet, startad med uvicorn), och motorn är
 * enheten som prövas. Mallen är probe-forlagg-utan-sal.ts; probe-forlagg-block.ts är samma sak mot en stubbmotor och visar
 * hur ett blocks förläggning sparas och dömer. Här är frågan vad Generera gör med den när motorn är den riktiga.
 *
 * VARFÖR DET FINNS. Motorn kräver att plats k i ett block fästs hos ALLA blockets poster eller hos ingen, på samma dag och start
 * (PLACED_LESSONS_OF_BLOCK_DIFFER, optimization-engine/app/solver/pins.py). Gatewayen bygger det: varje blockrad blir ett fäste
 * hos varje medlem, i samma stabila ordning (dag, start, id) så att varje medlem får samma plats k, med salen när posten har en
 * salsrad och aldrig som lås. Enhetsproven med mockad Prisma och stubbmotorn kan inte se att motorn håller med. Det här kan.
 * Varje steg läser därför resultatet ur MasterLessons med rena SQL-frågor, inte ur svaret, och med en domare som inte använder
 * en rad av gatewayens kod (blockOracle och clashes här nedanför).
 *
 * Varje steg bygger sin egen värld (en scen) och river den efteråt, så de kan köras var för sig: STEPS=a,c,f väljer steg.
 *
 *   bm-a  ett block med tre poster och två lektioner i veckan, EN lektion förlagd: Generera håller alla tre där (samma dag och
 *         start, fromPlacement, låsta, genererade) och lägger den andra lektionen ihop hos alla tre;
 *   bm-b  båda lektionerna förlagda: allt ligger där och inget annat är lagt;
 *   bm-c  en fjärde post läggs i blocket efteråt (INSERT med blockId) och får lektionen, med en sal motorn väljer;
 *   bm-d  med och utan sal per post: en vald sal hålls, de andra får en ledig sal av rätt typ, ingen sal är dubbelbokad;
 *   bm-e  blandade längder (80+40, och 60+60+40) med förläggningarna givna i omkastad ordning: samma plats k hos alla,
 *         rätt längd på rätt tid, med bara den korta, bara den långa och båda förlagda;
 *   bm-f  ett block som följer ett annat blocks tider följer det förlagda (ledarens lektioner är de märkta, följarens vanliga),
 *         HT och VT över minst fyra perioder i ett läsår som börjar en lördag, och två olänkade terminsblock som båda är
 *         förlagda måndag 09:00 (ett fäste gäller bara i postens perioder);
 *   bm-g  ett riktigt lås på en av blockets lektioner vägras som förut, BLOCK_PARTLY_LOCKED, före motorn;
 *   bm-h  schemaförslag: ett ändrat blockförlägg (dag, sal) gör ett sparat förslag föråldrat av sig självt, ett lika sparat
 *         förlägg gör det inte, och tillämpningen märker och låser blockets lektioner;
 *   bm-i  GENERATE_STALE när blockraden eller en salsrad ändras medan motorn löser, och inget skrivs;
 *   bm-j  mot en motor utan fältet pinnedLessons (git archive 9d3ef437): körningen vägras ENGINE_LACKS_PINNED_LESSONS och inget
 *         skrivs, medan ett block utan förläggningar går som förut. KRÄVER EN ÄLDRE MOTOR på AI_ENGINE_URL (se nedan);
 *   bm-k  en förläggning motorn inte kan hålla (två medlemmar med samma lärare, en lärare upptagen av ett lås, en längd som
 *         inte ryms i klassens ramtid) vägras av förkontrollen eller motorn med blocket och lektionen NAMNGIVNA, utan skrivning.
 *
 * Provet frågar motorn vad den kan (/openapi.json) och kör bara de steg motorn bär: en motor med PinnedLesson kör bm-a till bm-i
 * och bm-k, en utan kör bara bm-j. Kör alltså två gånger, en gång mot varje motor, för att få med alla steg.
 *
 * Ett steg som fäller skriver sin FAIL-rad och körningen går vidare. Exitkoden är 1 vid minst en FAIL. Oberoende av vad tidigare
 * körningar lämnat: en egen skola (probe-forlagg-block-motor), läsåret 2095/96 som börjar en LÖRDAG (2095-08-20), planterad och
 * borttagen av provet.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { HttpException, type INestApplicationContext } from '@nestjs/common';
import { Client } from 'pg';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';

const SLUG = 'probe-forlagg-block-motor';
/** Läsåret börjar en lördag (2095-08-20), som ett riktigt läsår gör (periods-are-not-terms). Måndagen efter är 2095-08-22. */
const YEAR_START = '2095-08-20';
const YEAR_END = '2096-06-10';
const AUTUMN_END = '2095-12-20';
const SPRING_START = '2096-01-12';

// ---------------------------------------------------------------------------
// Provets bokföring
// ---------------------------------------------------------------------------

let failures = 0;
const only = new Set(
  (process.env['STEPS'] ?? '')
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id !== ''),
);

function summarise(error: unknown): string {
  if (error instanceof HttpException) return `${error.name} ${error.getStatus()} ${JSON.stringify(error.getResponse())}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

const note = (text: string) => console.log(`     ${text}`);

async function step(id: string, label: string, body: () => Promise<void>): Promise<void> {
  if (only.size > 0 && !only.has(id)) return;
  const started = Date.now();
  try {
    await body();
    console.log(`ok   (bm-${id}) ${label} [${Math.round((Date.now() - started) / 100) / 10} s]`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL (bm-${id}) ${label}\n     ${summarise(error).replace(/\n/g, '\n     ')}`);
  }
}

async function refusalOf(work: Promise<unknown>): Promise<HttpException> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof HttpException, `förväntade ett HttpException, fick ${summarise(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'anropet vägrades inte' });
}

const codeOf = (error: HttpException): string | undefined => (error.getResponse() as { code?: string }).code;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Körningen
// ---------------------------------------------------------------------------

async function engineHoldsPins(url: string): Promise<boolean> {
  const response = await fetch(`${url}/openapi.json`);
  assert.ok(response.ok, `motorn svarade ${response.status} på /openapi.json`);
  return JSON.stringify(await response.json()).includes('PinnedLesson');
}

async function main(): Promise<void> {
  const started = Date.now();
  if (!process.env['AI_ENGINE_URL'] || !process.env['AI_ENGINE_API_KEY']) {
    console.error('AI_ENGINE_URL och AI_ENGINE_API_KEY pekar ut den riktiga motorn som provet frågar.');
    process.exit(2);
  }
  const pins = await engineHoldsPins(process.env['AI_ENGINE_URL']);
  console.log(`motorn på ${process.env['AI_ENGINE_URL']} ${pins ? 'har' : 'saknar'} PinnedLesson i /openapi.json`);
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
    // AppModule först, som main.ts läser den (se probe-forlagda-poster.ts).
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('../../src/app.module');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    try {
      await run(owner, app, pins);
    } finally {
      await app.close();
    }
  } finally {
    await sweep(owner).catch((error: unknown) => console.error(`provets skola togs inte bort: ${summarise(error)}`));
    await owner.end();
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (failures > 0) {
    console.error(`==> Block mot riktig motor FAILED: ${failures} steg på ${seconds} s`);
    process.exitCode = 1;
  } else {
    console.log(`==> Block mot riktig motor passed in ${seconds} s`);
  }
}

async function sweep(owner: Client): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
}

async function run(owner: Client, app: INestApplicationContext, enginePins: boolean): Promise<void> {
  const { Role } = await import('../../src/auth/enums/role.enum');
  const { PrismaService } = await import('../../src/database/prisma.service');
  const { OptimizationProxyService } = await import('../../src/optimization/optimization-proxy.service');
  const { ScheduleCandidatesService } = await import('../../src/optimization/schedule-candidates.service');
  const { BlockPlacementsService } = await import('../../src/requirement-placements/block-placements.service');
  const resolve = <T>(token: abstract new (...args: never[]) => T): T => app.get<T>(token as never, { strict: false });
  const prisma = resolve(PrismaService);
  const proxy = resolve(OptimizationProxyService);
  const candidates = resolve(ScheduleCandidatesService);
  const blocks = resolve(BlockPlacementsService);

  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  // -------------------------------------------------------------------------
  // Skolan: en administratör, ett läsår, åtta salar av en typ. Allt annat byggs per steg (scene).
  // -------------------------------------------------------------------------
  const s = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Probe block mot riktig motor', $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])).id;
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt") VALUES ($1, 'Probe 2095/96', $2, $3, true, now()) RETURNING id`,
      [s, YEAR_START, YEAR_END],
    )
  ).id;
  let counter = 0;
  const person = async (label: string, role: string, extra: { groupId?: string; adminProfile?: string } = {}) => {
    counter += 1;
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'Blockmotor', $4, $5, $6, true, $7, now()) RETURNING id`,
      [s, `${SLUG}-${label}-${counter}@example.invalid`, label, role, extra.adminProfile ?? null, authId, extra.groupId ?? null],
    );
    return { id: row.id, authId };
  };
  const adminRow = await person('admin', 'SCHOOL_ADMIN', { adminProfile: 'FULL' });
  const admin: AuthenticatedUser = {
    authId: adminRow.authId,
    userId: adminRow.id,
    schoolId: s,
    role: Role.SCHOOL_ADMIN,
    adminProfile: 'FULL',
    channel: 'WEB',
    hrRead: false,
  } as AuthenticatedUser;
  const classType = (await one<{ id: string }>(`INSERT INTO "RoomTypes" ("schoolId", name, "updatedAt") VALUES ($1, 'BM Klassrum', now()) RETURNING id`, [s])).id;
  const salar: string[] = [];
  for (let i = 1; i <= 8; i++) {
    salar.push((await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, capacity, "roomTypeId", "updatedAt") VALUES ($1, $2, 30, $3, now()) RETURNING id`, [s, `BM sal ${i}`, classType])).id);
  }
  const salSet = new Set(salar);

  // -------------------------------------------------------------------------
  // Byggstenar
  // -------------------------------------------------------------------------
  const newGroup = async (name: string) => {
    const id = (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', 7, now()) RETURNING id`, [s, year, `${name} ${++counter}`])).id;
    await person(`elev-${counter}`, 'STUDENT', { groupId: id });
    return id;
  };
  const newTeacher = async (label: string) => (await person(`${label}`, 'TEACHER')).id;
  const newSubject = async (name: string) =>
    (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "requiredRoomTypeId", "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [s, `${name} ${++counter}`, classType])).id;
  const newBlock = async (name: string, sameTimesAsBlockId: string | null = null) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "TeachingBlocks" ("schoolId", "academicYearId", name, "sameTimesAsBlockId", "updatedAt") VALUES ($1, $2, $3, $4, now()) RETURNING id`,
        [s, year, `${name} ${++counter}`, sameTimesAsBlockId],
      )
    ).id;
  interface PostShape {
    blockId?: string | null;
    groupId: string;
    subjectId: string;
    teacherId: string;
    lengths?: number[];
    lessons?: number;
    minutes?: number;
    startDate?: string | null;
    endDate?: string | null;
  }
  const newPost = async (p: PostShape): Promise<string> => {
    const lengths = p.lengths ?? Array.from({ length: p.lessons ?? 2 }, () => p.minutes ?? 60);
    const sorted = [...lengths].sort((a, b) => b - a);
    const mixed = new Set(sorted).size > 1;
    return (
      await one<{ id: string }>(
        `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "lessonLengths", "blockId", "startDate", "endDate", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date, now()) RETURNING id`,
        [s, year, p.subjectId, p.groupId, p.teacherId, sorted.length, sorted[0], mixed ? sorted : [], p.blockId ?? null, p.startDate ?? null, p.endDate ?? null],
      )
    ).id;
  };

  /** En medlem av ett block, som provet minns den: posten och det dess klass, ämne och lärare är. */
  interface Member {
    postId: string;
    groupId: string;
    subjectId: string;
    teacherId: string;
  }
  interface Scene {
    blockId: string;
    members: Member[];
    lengths: number[];
    /** Antalet lektioner vid sidan av blocket (hela efterfrågan är medlemmarnas plus dessa). */
    bystanderLessons: number;
    startDate: string | null;
    endDate: string | null;
  }
  const addMember = async (scene: Scene, label: string): Promise<Member> => {
    const groupId = await newGroup(`BM ${label}`);
    const subjectId = await newSubject(`BM ${label}-ämne`);
    const teacherId = await newTeacher(`lärare-${label}`);
    const postId = await newPost({ blockId: scene.blockId, groupId, subjectId, teacherId, lengths: scene.lengths, startDate: scene.startDate, endDate: scene.endDate });
    const member = { postId, groupId, subjectId, teacherId };
    scene.members.push(member);
    return member;
  };
  /** Ett block med n poster, var och en med klass, ämne och lärare av egna, och två vanliga poster bredvid som motorn också lägger. */
  const scene = async (options: { members: number; lengths?: number[]; startDate?: string | null; endDate?: string | null; bystanders?: boolean }): Promise<Scene> => {
    const blockId = await newBlock('BM Språkval');
    const sc: Scene = {
      blockId,
      members: [],
      lengths: options.lengths ?? [60, 60],
      bystanderLessons: 0,
      startDate: options.startDate ?? null,
      endDate: options.endDate ?? null,
    };
    const names = ['Spanska', 'Tyska', 'Franska', 'Italienska', 'Ryska'];
    for (let i = 0; i < options.members; i++) await addMember(sc, names[i]!);
    if (options.bystanders !== false) {
      // Vid sidan av: en matematik och en svenska för två andra klasser, så att motorn har något annat att lägga och sätta sig i vägen.
      for (const [name, lessons] of [['Matematik', 3], ['Svenska', 2]] as const) {
        await newPost({ groupId: await newGroup(`BM ${name}`), subjectId: await newSubject(`BM ${name}`), teacherId: await newTeacher(`lärare-${name}`), lessons, minutes: 60 });
        sc.bystanderLessons += lessons;
      }
    }
    return sc;
  };
  /** Rivningen: allt scenen byggde, utom skolan, läsåret, administratören och salarna. */
  const dropScene = async (): Promise<void> => {
    await owner.query(`DELETE FROM "MasterLessons" WHERE "academicYearId" = $1`, [year]);
    await owner.query(`DELETE FROM "FrameTimes" WHERE "schoolId" = $1`, [s]);
    await owner.query(`DELETE FROM "TeachingRequirements" WHERE "academicYearId" = $1`, [year]);
    await owner.query(`DELETE FROM "TeachingBlocks" WHERE "academicYearId" = $1`, [year]);
    await owner.query(`DELETE FROM "Users" WHERE "schoolId" = $1 AND id <> $2`, [s, adminRow.id]);
    await owner.query(`DELETE FROM "StudentGroups" WHERE "academicYearId" = $1`, [year]);
    await owner.query(`DELETE FROM "Subjects" WHERE "schoolId" = $1`, [s]);
  };
  const inScene = async <T extends Scene>(make: () => Promise<T>, body: (sc: T) => Promise<void>): Promise<void> => {
    await dropScene();
    const sc = await make();
    try {
      await body(sc);
    } finally {
      await dropScene();
    }
  };

  // -------------------------------------------------------------------------
  // Vad stegen läser och gör
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
    minutes: number;
    recurrence: string;
    startDate: string | null;
    endDate: string | null;
    isLocked: boolean;
    isGenerated: boolean;
    fromPlacement: boolean;
  }
  const masterRows = (): Promise<MasterRow[]> =>
    all<MasterRow>(
      `SELECT id, "studentGroupId" AS "groupId", "subjectId", "teacherId", "roomId", "dayOfWeek" AS day,
              to_char("startTime", 'HH24:MI') AS start, to_char("endTime", 'HH24:MI') AS "end",
              (extract(epoch FROM "endTime" - "startTime") / 60)::int AS minutes,
              recurrence::text AS recurrence, "startDate"::text AS "startDate", "endDate"::text AS "endDate",
              "isLocked", "isGenerated", "fromPlacement"
         FROM "MasterLessons" WHERE "academicYearId" = $1 ORDER BY id`,
      [year],
    );
  /** Vad en körning kan ha rört: lektionerna, förläggningarna och ändringsloggen. Ett vägrat Generera lämnar den som den var. */
  const fingerprint = async (): Promise<string> =>
    JSON.stringify([
      await all(`SELECT * FROM "MasterLessons" WHERE "academicYearId" = $1 ORDER BY id`, [year]),
      await all(`SELECT * FROM "TeachingBlockPlacements" WHERE "academicYearId" = $1 ORDER BY id`, [year]),
      await all(`SELECT * FROM "TeachingBlockPlacementRooms" WHERE "schoolId" = $1 ORDER BY id`, [s]),
      await all(`SELECT id FROM "ScheduleChangeLogs" WHERE "academicYearId" = $1 ORDER BY id`, [year]),
    ]);
  const generate = () => proxy.triggerScheduling(year, admin);
  const prepare = () => prisma.withRls(admin, (tx) => proxy.prepareSchedule(tx as never, year, admin));
  const solved = (answer: Awaited<ReturnType<typeof generate>>) => {
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(answer.status), `Generera svarade ${answer.status} ${JSON.stringify(answer.conflicts?.conflicts?.map((line) => [line.code, line.params]))}`);
  };
  const replace = (sc: Scene, placements: Array<{ dayOfWeek: number; startTime: string; minutes: number; rooms?: Array<{ requirementId: string; roomId: string }> }>) =>
    blocks.replace(sc.blockId, { placements } as never, admin);
  const slot = (dayOfWeek: number, startTime: string, minutes = 60, rooms?: Array<{ requirementId: string; roomId: string }>) => ({ dayOfWeek, startTime, minutes, ...(rooms ? { rooms } : {}) });

  /** Två lektioner är på samma plats samtidigt: samma tid på dagen, en vecka båda går och fönster som möts. */
  const sameWeeks = (a: MasterRow, b: MasterRow): boolean =>
    (a.startDate ?? '0000-00-00') <= (b.endDate ?? '9999-99-99') &&
    (b.startDate ?? '0000-00-00') <= (a.endDate ?? '9999-99-99') &&
    !((a.recurrence === 'ODD_WEEKS' && b.recurrence === 'EVEN_WEEKS') || (a.recurrence === 'EVEN_WEEKS' && b.recurrence === 'ODD_WEEKS'));
  /** Ingen lärare, klass eller sal är på två ställen samtidigt bland veckans lektioner. */
  const clashes = async (): Promise<string[]> => {
    const rows = await masterRows();
    const found: string[] = [];
    for (const [i, a] of rows.entries()) {
      for (const b of rows.slice(i + 1)) {
        if (a.day !== b.day || !(a.start < b.end && b.start < a.end) || !sameWeeks(a, b)) continue;
        if (a.groupId === b.groupId) found.push(`klass ${a.groupId} d${a.day} ${a.start}-${a.end}`);
        if (a.teacherId !== null && a.teacherId === b.teacherId) found.push(`lärare ${a.teacherId} d${a.day} ${a.start}-${a.end}`);
        if (a.roomId !== null && a.roomId === b.roomId) found.push(`sal ${a.roomId} d${a.day} ${a.start}-${a.end}`);
      }
    }
    return found;
  };
  interface ExpectedPlacement {
    day: number;
    start: string;
    minutes: number;
    /** medlemmens index -> den sal skolan valde; en medlem som saknas har sin sal vald av motorn. */
    rooms?: Record<number, string>;
  }
  const tupleOf = (row: MasterRow) => `${row.day} ${row.start} ${row.minutes}`;
  /**
   * Domaren över ett block efter Generera, utan en rad av gatewayens kod. För varje medlem: exakt så många lektioner som posten
   * ber om (längderna), exakt en märkt lektion (fromPlacement, låst, genererad, rätt lärare) för varje förläggning på rätt dag,
   * start och längd, i sin sal om den hade en och annars i en sal; de andra lektionerna är motorns (genererade, inte låsta,
   * inte märkta); och blockets lektioner ligger ihop: varje medlem har samma lista (dag, start, längd) som de andra.
   */
  const blockOracle = async (sc: Scene, expected: ExpectedPlacement[], label: string): Promise<MasterRow[]> => {
    const rows = await masterRows();
    const wantLengths = [...sc.lengths].sort((a, b) => b - a).join(',');
    const lists: string[][] = [];
    for (const [index, member] of sc.members.entries()) {
      const mine = rows.filter((row) => row.groupId === member.groupId && row.subjectId === member.subjectId);
      assert.equal(mine.map((row) => row.minutes).sort((a, b) => b - a).join(','), wantLengths, `${label}: medlem ${index} har andra längder än posten ber om`);
      assert.ok(mine.every((row) => row.teacherId === member.teacherId), `${label}: medlem ${index} har fel lärare på en lektion`);
      assert.ok(mine.every((row) => row.roomId !== null && salSet.has(row.roomId)), `${label}: medlem ${index} har en lektion utan sal eller i en annan sal än skolans`);
      const marked = mine.filter((row) => row.fromPlacement);
      assert.equal(marked.length, expected.length, `${label}: medlem ${index} har ${marked.length} märkta lektioner för ${expected.length} förläggningar`);
      const free = [...marked];
      for (const want of expected) {
        const at = free.findIndex((row) => row.day === want.day && row.start === want.start && row.minutes === want.minutes);
        assert.ok(at >= 0, `${label}: medlem ${index} saknar den märkta lektionen d${want.day} ${want.start} ${want.minutes} min (har ${marked.map(tupleOf).join('; ')})`);
        const [hit] = free.splice(at, 1);
        assert.ok(hit!.isLocked && hit!.isGenerated, `${label}: medlem ${index}: en förlagd lektion är låst och genererad`);
        const chosen = want.rooms?.[index];
        if (chosen !== undefined) assert.equal(hit!.roomId, chosen, `${label}: medlem ${index} lades inte i salen skolan valde`);
      }
      for (const row of mine.filter((candidate) => !candidate.fromPlacement)) {
        assert.ok(row.isGenerated && !row.isLocked, `${label}: medlem ${index}: motorns lektion är genererad och inte låst`);
      }
      lists.push(mine.map(tupleOf).sort());
    }
    for (const [index, list] of lists.entries()) assert.deepEqual(list, lists[0], `${label}: medlem ${index} ligger inte ihop med medlem 0`);
    assert.deepEqual(await clashes(), [], `${label}: veckan är inte fri från krockar`);
    return rows;
  };
  const blockRowsOf = (rows: MasterRow[], sc: Scene) => rows.filter((row) => sc.members.some((member) => member.groupId === row.groupId && member.subjectId === row.subjectId));

  // ===========================================================================
  // Stegen
  // ===========================================================================
  if (enginePins) {
    // (bm-a) ---------------------------------------------------------------
    await step('a', 'a block of three posts with two lessons a week, ONE lesson placed: Generera holds all three there and lays the other lesson together', async () => {
      await inScene(() => scene({ members: 3 }), async (sc) => {
        await replace(sc, [slot(2, '10:00')]);
        const prepared = await prepare();
        assert.ok(prepared.ready);
        const sent = prepared.payload.requirements.filter((requirement) => (requirement as { blockId?: string }).blockId !== undefined);
        assert.equal(sent.length, 3, 'blocket skickas som block');
        const pinOf = (requirement: unknown) => ((requirement as { pinnedLessons?: Array<{ dayOfWeek: number; startTime: string } | null> }).pinnedLessons ?? []).map((pin, index) => (pin ? `${index}:${pin.dayOfWeek}@${pin.startTime}` : null)).filter((x) => x !== null);
        const pinned = sent.map(pinOf);
        assert.ok(pinned.every((list) => list.length === 1 && list[0] === pinned[0]![0]), `samma plats k hos alla tre: ${JSON.stringify(pinned)}`);
        assert.ok(pinned[0]![0]!.endsWith('2@10:00:00'), 'tisdag 10:00');
        assert.equal(prepared.payload.fixedLessons.length, 0, 'ett fäste är inget lås');
        assert.ok(!('placements' in prepared.payload), 'ingenting i placements');

        solved(await generate());
        const rows = await blockOracle(sc, [{ day: 2, start: '10:00', minutes: 60 }], 'a');
        assert.equal(rows.length, 3 * 2 + sc.bystanderLessons, 'efterfrågan och inget annat');
        // En andra körning skriver om lektionerna ur förläggningen: nya id:n, samma plats.
        const before = new Set(rows.filter((row) => row.fromPlacement).map((row) => row.id));
        solved(await generate());
        const again = await blockOracle(sc, [{ day: 2, start: '10:00', minutes: 60 }], 'a, andra körningen');
        assert.ok(again.filter((row) => row.fromPlacement).every((row) => !before.has(row.id)), 'de märkta lektionerna skrivs om');
        assert.equal(again.length, 3 * 2 + sc.bystanderLessons);
      });
    });

    // (bm-b) ---------------------------------------------------------------
    await step('b', 'both lessons placed: everything lies where it was placed and the engine lays nothing else of the block', async () => {
      await inScene(() => scene({ members: 3 }), async (sc) => {
        await replace(sc, [slot(2, '10:00'), slot(4, '13:00')]);
        solved(await generate());
        const rows = await blockOracle(sc, [{ day: 2, start: '10:00', minutes: 60 }, { day: 4, start: '13:00', minutes: 60 }], 'b');
        assert.equal(blockRowsOf(rows, sc).filter((row) => !row.fromPlacement).length, 0, 'alla sex lektioner är förlagda');
        assert.equal(rows.length, 3 * 2 + sc.bystanderLessons);
      });
    });

    // (bm-c) ---------------------------------------------------------------
    await step('c', 'a fourth post joins the block afterwards (INSERT with blockId) and gets the lesson, in a room the engine chooses', async () => {
      await inScene(() => scene({ members: 3 }), async (sc) => {
        await replace(sc, [slot(2, '10:00')]);
        solved(await generate());
        await blockOracle(sc, [{ day: 2, start: '10:00', minutes: 60 }], 'c, före');
        const fourth = await addMember(sc, 'Italienska-sen');
        solved(await generate());
        const rows = await blockOracle(sc, [{ day: 2, start: '10:00', minutes: 60 }], 'c, efter');
        assert.equal(sc.members.length, 4);
        const placed = rows.filter((row) => row.fromPlacement);
        assert.equal(placed.length, 4, 'en märkt lektion för var och en av fyra');
        const mine = placed.find((row) => row.groupId === fourth.groupId)!;
        assert.ok(mine.roomId !== null && salSet.has(mine.roomId), 'den fjärde fick en sal av motorn');
        assert.equal(new Set(placed.map((row) => row.roomId)).size, 4, 'fyra olika salar samtidigt');
        assert.equal(rows.length, 4 * 2 + sc.bystanderLessons);
      });
    });

    // (bm-d) ---------------------------------------------------------------
    await step('d', 'with and without a room per post: a chosen room is held, the others get a free room of the right type, no room is double-booked', async () => {
      await inScene(() => scene({ members: 3 }), async (sc) => {
        // Ett lås som håller salen 2 tisdag 10:00 (en annan klass, en annan lärare): motorn får inte välja den åt de medlemmar som inte valt.
        const holder = await newGroup('BM hållare');
        const holderSubject = await newSubject('BM hållarämne');
        const holderTeacher = await newTeacher('lärare-hållare');
        await owner.query(
          `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, 2, '10:00', '11:00', true, false, now())`,
          [s, year, holderSubject, holder, holderTeacher, salar[1]],
        );
        // Med salar: första lektionen med sal för medlem 0 (sal 1), den andra med salar för medlem 1 och 2 (sal 4 och 5).
        await replace(sc, [
          slot(2, '10:00', 60, [{ requirementId: sc.members[0]!.postId, roomId: salar[0]! }]),
          slot(4, '13:00', 60, [
            { requirementId: sc.members[1]!.postId, roomId: salar[3]! },
            { requirementId: sc.members[2]!.postId, roomId: salar[4]! },
          ]),
        ]);
        const prepared = await prepare();
        assert.ok(prepared.ready);
        assert.equal(prepared.payload.fixedLessons.length, 1, 'ett lås: hållaren, och inga blockrader bland låsen');
        solved(await generate());
        const withRooms = await blockOracle(
          sc,
          [
            { day: 2, start: '10:00', minutes: 60, rooms: { 0: salar[0]! } },
            { day: 4, start: '13:00', minutes: 60, rooms: { 1: salar[3]!, 2: salar[4]! } },
          ],
          'd, med salar',
        );
        const tuesday = blockRowsOf(withRooms, sc).filter((row) => row.fromPlacement && row.day === 2);
        assert.equal(tuesday.length, 3);
        assert.ok(tuesday.every((row) => row.roomId !== salar[1]), 'ingen medlem fick salen låset håller');
        assert.equal(new Set(tuesday.map((row) => row.roomId)).size, 3, 'tre olika salar tisdag');
        // Utan salar: samma lektioner, allt åt motorn.
        await replace(sc, [slot(2, '10:00'), slot(4, '13:00')]);
        solved(await generate());
        const without = await blockOracle(sc, [{ day: 2, start: '10:00', minutes: 60 }, { day: 4, start: '13:00', minutes: 60 }], 'd, utan salar');
        const tue = blockRowsOf(without, sc).filter((row) => row.day === 2);
        assert.ok(tue.every((row) => row.roomId !== salar[1]), 'ingen medlem fick salen låset håller, utan salar heller');
        // Blandat: bara medlem 2 valde, och bara på den andra lektionen.
        await replace(sc, [slot(2, '10:00'), slot(4, '13:00', 60, [{ requirementId: sc.members[2]!.postId, roomId: salar[7]! }])]);
        solved(await generate());
        await blockOracle(sc, [{ day: 2, start: '10:00', minutes: 60 }, { day: 4, start: '13:00', minutes: 60, rooms: { 2: salar[7]! } }], 'd, blandat');
      });
    });

    // (bm-e) ---------------------------------------------------------------
    await step('e', 'mixed lengths (80+40 and 60+60+40) with the placements given in reverse order: place k alike for every member, the right length at the right time', async () => {
      const variants: Array<{ label: string; lengths: number[]; placed: Array<[number, string, number]> }> = [
        { label: '80+40, båda, omkastad', lengths: [80, 40], placed: [[3, '09:00', 80], [1, '10:00', 40]] },
        { label: '80+40, bara den korta', lengths: [80, 40], placed: [[1, '10:00', 40]] },
        { label: '80+40, bara den långa', lengths: [80, 40], placed: [[3, '09:00', 80]] },
        { label: '60+60+40, den korta och en 60, omkastad', lengths: [60, 60, 40], placed: [[5, '09:00', 40], [3, '13:00', 60]] },
        { label: '60+60+40, alla tre, omkastad', lengths: [60, 60, 40], placed: [[5, '09:00', 40], [3, '13:00', 60], [1, '10:00', 60]] },
      ];
      for (const variant of variants) {
        await inScene(() => scene({ members: 3, lengths: variant.lengths }), async (sc) => {
          await replace(sc, variant.placed.map(([day, start, minutes]) => slot(day, start, minutes)));
          const prepared = await prepare();
          assert.ok(prepared.ready);
          const sent = prepared.payload.requirements.filter((requirement) => (requirement as { blockId?: string }).blockId !== undefined);
          const places = sent.map((requirement) => JSON.stringify((requirement as { pinnedLessons?: unknown[] }).pinnedLessons));
          assert.equal(new Set(places).size, 1, `${variant.label}: samma fästen på samma platser hos alla medlemmar: ${places.join(' | ')}`);
          solved(await generate());
          await blockOracle(sc, variant.placed.map(([day, start, minutes]) => ({ day, start, minutes })), `e, ${variant.label}`);
        });
      }
    });

    // (bm-f) ---------------------------------------------------------------
    await step('f', 'a block on another block\'s times follows the placed one (HT and VT over at least four periods, a läsår that starts on a Saturday); two unlinked term blocks both placed Monday 09:00 keep their own periods', async () => {
      await dropScene();
      try {
        // Ledaren: höstens block (HT), tre poster, en lektion förlagd. Följaren: vårens block (VT) på ledarens tider, samma ämnen,
        // samma klasser med klasserna roterade mellan ämnena (unik nyckel: klass och ämne är en post), samma lärare per ämne.
        const groups = [await newGroup('BM 7A'), await newGroup('BM 7B'), await newGroup('BM 7C')];
        const subjects = [await newSubject('BM Slöjd'), await newSubject('BM Hemkunskap'), await newSubject('BM Teknik')];
        const teachers = [await newTeacher('lärare-slöjd'), await newTeacher('lärare-hem'), await newTeacher('lärare-teknik')];
        const autumn = await newBlock('BM HT');
        const spring = await newBlock('BM VT', autumn);
        for (const [i, subjectId] of subjects.entries()) {
          await newPost({ blockId: autumn, groupId: groups[i]!, subjectId, teacherId: teachers[i]!, lessons: 2, minutes: 60, endDate: AUTUMN_END });
          await newPost({ blockId: spring, groupId: groups[(i + 1) % 3]!, subjectId, teacherId: teachers[i]!, lessons: 2, minutes: 60, startDate: SPRING_START });
        }
        // Datum som skär läsåret i fler perioder: den första måndagen (lördag-söndag blir en period för sig), ett slut i oktober och en början i mars.
        const extra = async (name: string, lessons: number, startDate: string | null, endDate: string | null) =>
          newPost({ groupId: await newGroup(`BM ${name}`), subjectId: await newSubject(`BM ${name}`), teacherId: await newTeacher(`lärare-${name}`), lessons, minutes: 60, startDate, endDate });
        await extra('Idrott', 2, '2095-08-22', '2095-10-31');
        await extra('Musik', 1, '2096-03-02', null);
        // En post som går från första måndagen och aldrig slutar: läsårets första vecka (lördag och söndag) är den enda vecka som inte har den,
        // alltså en period för sig på en vecka (periods-are-not-terms).
        await extra('Bild', 1, '2095-08-22', null);
        await extra('Engelska', 1, '2095-09-18', '2096-02-09');
        await blocks.replace(autumn, { placements: [slot(1, '09:00')] } as never, admin);
        const prepared = await prepare();
        assert.ok(prepared.ready);
        const periods = (prepared.payload as { periodWeeks?: number[] }).periodWeeks ?? [];
        assert.ok(periods.length >= 6, `minst sex perioder som i ett riktigt läsår, fick ${periods.length}`);
        assert.ok(periods.includes(1), `läsårets första vecka (lördag och söndag) är en period för sig: ${periods.join(',')}`);
        note(`perioder i nyttolasten: ${periods.length} (${periods.join(',')} veckor)`);
        solved(await generate());
        const rows = await masterRows();
        const lessonsOf = (postGroup: string, postSubject: string) => rows.filter((row) => row.groupId === postGroup && row.subjectId === postSubject);
        // Ledarens poster: två lektioner var, en märkt måndag 09:00, höstens fönster; ihop hos alla tre.
        const leaders = subjects.map((subjectId, i) => lessonsOf(groups[i]!, subjectId));
        for (const [i, lessons] of leaders.entries()) {
          assert.equal(lessons.length, 2, `ledarpost ${i}`);
          assert.ok(lessons.every((row) => row.startDate === null && row.endDate === AUTUMN_END && row.teacherId === teachers[i]), `ledarpost ${i}: höstens fönster och rätt lärare`);
          const marked = lessons.filter((row) => row.fromPlacement);
          assert.equal(marked.length, 1);
          assert.deepEqual([marked[0]!.day, marked[0]!.start, marked[0]!.isLocked, marked[0]!.isGenerated], [1, '09:00', true, true]);
          assert.ok(lessons.filter((row) => !row.fromPlacement).every((row) => row.isGenerated && !row.isLocked));
        }
        assert.deepEqual(leaders.map((lessons) => lessons.map(tupleOf).sort()), [0, 1, 2].map(() => leaders[0]!.map(tupleOf).sort()), 'ledarens lektioner ligger ihop');
        // Följarens poster: vanliga lektioner (genererade, inte låsta, inte märkta) på ledarens tider i vårens fönster.
        const followers = subjects.map((subjectId, i) => lessonsOf(groups[(i + 1) % 3]!, subjectId));
        for (const [i, lessons] of followers.entries()) {
          assert.equal(lessons.length, 2, `följarpost ${i}`);
          assert.ok(
            lessons.every((row) => row.startDate === SPRING_START && row.endDate === null && row.teacherId === teachers[i] && row.isGenerated && !row.isLocked && !row.fromPlacement),
            `följarpost ${i}: vårens fönster, genererad, varken låst eller märkt: ${JSON.stringify(lessons)}`,
          );
          assert.deepEqual(lessons.map(tupleOf).sort(), leaders[i]!.map(tupleOf).sort(), `följarpost ${i} ligger på ledarens tider i sitt ämne`);
        }
        assert.deepEqual(await clashes(), []);
        assert.equal(rows.filter((row) => row.fromPlacement).length, 3, 'tre märkta lektioner: ledarens, inte följarens');
        await dropScene();

        // De olänkade: höstens block och vårens block på samma klasser och samma lärare, båda förlagda måndag 09:00. Gäller fästet
        // året runt vägras veckan (läraren och klassen på två ställen); gäller det bara i postens perioder går den.
        const htGroups = [await newGroup('BM HT-A'), await newGroup('BM HT-B'), await newGroup('BM HT-C')];
        const htTeachers = [await newTeacher('lärare-ht-a'), await newTeacher('lärare-ht-b'), await newTeacher('lärare-ht-c')];
        const ht = await newBlock('BM Olänkad HT');
        const vt = await newBlock('BM Olänkad VT');
        for (const [i, groupId] of htGroups.entries()) {
          await newPost({ blockId: ht, groupId, subjectId: await newSubject('BM HT-ämne'), teacherId: htTeachers[i]!, lessons: 2, minutes: 60, endDate: AUTUMN_END });
          await newPost({ blockId: vt, groupId, subjectId: await newSubject('BM VT-ämne'), teacherId: htTeachers[i]!, lessons: 2, minutes: 60, startDate: SPRING_START });
        }
        await extra('Idrott2', 2, '2095-08-22', '2095-10-31');
        await extra('Musik2', 1, '2096-03-02', null);
        await extra('Bild2', 1, '2095-08-22', null);
        await extra('Engelska2', 1, '2095-09-18', '2096-02-09');
        await blocks.replace(ht, { placements: [slot(1, '09:00')] } as never, admin);
        await blocks.replace(vt, { placements: [slot(1, '09:00')] } as never, admin);
        const second = await prepare();
        assert.ok(second.ready);
        assert.ok(((second.payload as { periodWeeks?: number[] }).periodWeeks ?? []).length >= 6);
        solved(await generate());
        const both = await masterRows();
        const marked = both.filter((row) => row.fromPlacement);
        assert.equal(marked.length, 6, 'sex märkta lektioner: tre i höstens block och tre i vårens');
        assert.ok(marked.every((row) => row.day === 1 && row.start === '09:00' && row.isLocked));
        assert.equal(marked.filter((row) => row.endDate === AUTUMN_END).length, 3, 'höstens tre ligger i höstens fönster');
        assert.equal(marked.filter((row) => row.startDate === SPRING_START).length, 3, 'vårens tre ligger i vårens fönster');
        assert.deepEqual(await clashes(), []);
      } finally {
        await dropScene();
      }
    });

    // (bm-g) ---------------------------------------------------------------
    await step('g', 'a real lock on one of the block\'s lessons is refused as before, BLOCK_PARTLY_LOCKED, before the engine is asked', async () => {
      await inScene(() => scene({ members: 3 }), async (sc) => {
        await replace(sc, [slot(2, '10:00')]);
        const member = sc.members[1]!;
        await owner.query(
          `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, 4, '13:00', '14:00', true, false, now())`,
          [s, year, member.subjectId, member.groupId, member.teacherId, salar[2]],
        );
        const before = await fingerprint();
        const original = proxy.callAiEngine.bind(proxy);
        let asked = 0;
        (proxy as unknown as { callAiEngine: typeof proxy.callAiEngine }).callAiEngine = ((...args: Parameters<typeof proxy.callAiEngine>) => {
          asked += 1;
          return original(...args);
        }) as typeof proxy.callAiEngine;
        try {
          const answer = await generate();
          assert.equal(answer.status, 'INFEASIBLE');
          const lines = answer.conflicts?.conflicts ?? [];
          assert.ok(lines.some((line) => line.code === 'BLOCK_PARTLY_LOCKED'), `vägrades som ${JSON.stringify(lines.map((line) => [line.code, line.params]))}`);
          assert.equal(asked, 0, 'motorn väcktes inte');
        } finally {
          (proxy as unknown as { callAiEngine: typeof proxy.callAiEngine }).callAiEngine = original;
        }
        assert.equal(await fingerprint(), before, 'en vägrad körning skriver inget');
      });
    });

    // (bm-h) ---------------------------------------------------------------
    await step('h', 'schemaförslag: a changed block placement makes a saved proposal stale by itself, an equal one does not, and applying it marks the block\'s lessons', async () => {
      await inScene(() => scene({ members: 3 }), async (sc) => {
        const [spanska, tyska] = [sc.members[0]!, sc.members[1]!];
        await replace(sc, [slot(2, '10:00', 60, [{ requirementId: spanska.postId, roomId: salar[0]! }])]);
        // Förslag tas fram ur ett första schema (CANDIDATES_NEED_A_DRAFT): Generera först.
        solved(await generate());
        const { runId } = await candidates.start({ academicYearId: year, count: 1 }, admin);
        for (let tries = 0; candidates.running.includes(runId); tries++) {
          if (tries > 9000) throw new Error('förslagskörningen blev aldrig klar');
          await sleep(20);
        }
        const run = await one<{ status: string; errorCode: string | null }>(`SELECT status::text AS status, "errorCode" FROM "ScheduleCandidateRuns" WHERE id = $1`, [runId]);
        assert.equal(run.status, 'SUCCEEDED', `körningen slutade ${run.status} ${run.errorCode}`);
        const fresh = await candidates.check(runId, admin);
        assert.equal(fresh.stale, false, 'ett nytt förslag är inte föråldrat');
        // Ett lika sparat förlägg (nya id:n, samma plats och sal) ändrar inte basen.
        await replace(sc, [slot(2, '10:00', 60, [{ requirementId: spanska.postId, roomId: salar[0]! }])]);
        assert.equal((await candidates.check(runId, admin)).stale, false, 'ett lika förlägg gör inte förslaget föråldrat');
        // Dagen ändras: föråldrat, och tillämpningen vägras utan att skriva.
        await replace(sc, [slot(3, '10:00', 60, [{ requirementId: spanska.postId, roomId: salar[0]! }])]);
        const moved = await candidates.check(runId, admin);
        assert.equal(moved.stale, true, 'en ändrad dag gör förslaget föråldrat');
        note(`ändrade delar efter dagen: ${JSON.stringify(moved.changed)}`);
        const before = await fingerprint();
        const refused = await refusalOf(candidates.apply(await firstCandidate(runId), 'DIRECT', admin));
        assert.equal(refused.getStatus(), 409);
        assert.equal(codeOf(refused), 'SCHEDULE_CANDIDATE_STALE');
        assert.equal(await fingerprint(), before, 'ett vägrat tillämpande skriver inget');
        // Tillbaka: friskt igen. Sedan bara en sal ändras (en salsrad tillkommer): föråldrat igen.
        await replace(sc, [slot(2, '10:00', 60, [{ requirementId: spanska.postId, roomId: salar[0]! }])]);
        assert.equal((await candidates.check(runId, admin)).stale, false);
        await replace(sc, [slot(2, '10:00', 60, [{ requirementId: spanska.postId, roomId: salar[0]! }, { requirementId: tyska.postId, roomId: salar[1]! }])]);
        const roomed = await candidates.check(runId, admin);
        assert.equal(roomed.stale, true, 'en ny salsrad gör förslaget föråldrat');
        note(`ändrade delar efter salen: ${JSON.stringify(roomed.changed)}`);
        await replace(sc, [slot(2, '10:00', 60, [{ requirementId: spanska.postId, roomId: salar[2]! }])]);
        assert.equal((await candidates.check(runId, admin)).stale, true, 'en ändrad sal gör förslaget föråldrat');
        // Tillbaka till förslagets förlägg: tillämpningen märker och låser blockets lektioner.
        await replace(sc, [slot(2, '10:00', 60, [{ requirementId: spanska.postId, roomId: salar[0]! }])]);
        await candidates.apply(await firstCandidate(runId), 'DIRECT', admin);
        const rows = await blockOracle(sc, [{ day: 2, start: '10:00', minutes: 60, rooms: { 0: salar[0]! } }], 'h, tillämpat');
        assert.equal(rows.filter((row) => row.fromPlacement).length, 3);
        assert.equal(rows.length, 3 * 2 + sc.bystanderLessons);
      });
      async function firstCandidate(runId: string): Promise<string> {
        return (await one<{ id: string }>(`SELECT id FROM "ScheduleCandidates" WHERE "runId" = $1 ORDER BY ordinal LIMIT 1`, [runId])).id;
      }
    });

    // (bm-i) ---------------------------------------------------------------
    await step('i', 'GENERATE_STALE when the block row or a room row changes while the engine solves, and nothing is written', async () => {
      await inScene(() => scene({ members: 3 }), async (sc) => {
        const [spanska, tyska] = [sc.members[0]!, sc.members[1]!];
        await replace(sc, [slot(2, '10:00', 60, [{ requirementId: spanska.postId, roomId: salar[0]! }])]);
        const original = proxy.callAiEngine.bind(proxy);
        /** Kör Generera och ändrar något MEDAN motorn löser: ändringen skickas direkt efter att anropet gått iväg och är gjord innan svaret kommer. */
        const duringTheSolve = async (change: () => Promise<void>, options: { engineStillSolving: boolean } = { engineStillSolving: true }): Promise<HttpException> => {
          let landed: 'before' | 'after' | null = null;
          (proxy as unknown as { callAiEngine: typeof proxy.callAiEngine }).callAiEngine = (async (...args: Parameters<typeof proxy.callAiEngine>) => {
            const pending = original(...args);
            let answered = false;
            void pending.then(
              () => (answered = true),
              () => (answered = true),
            );
            await change();
            landed = answered ? 'after' : 'before';
            return pending;
          }) as typeof proxy.callAiEngine;
          try {
            const refused = await refusalOf(generate());
            // En ändring som är en enda SQL-sats är gjord medan motorn löser. En som går genom tjänsten (lås, läsning, flera satser) kan ta längre tid
            // än en liten värld, och då har motorn hunnit svara; ändringen är ändå gjord innan gatewayen läser svaret och skriver, och det är det som prövas.
            if (options.engineStillSolving) assert.equal(landed, 'before', 'ändringen hann inte före motorns svar: provet säger inget om att motorn löser');
            return refused;
          } finally {
            (proxy as unknown as { callAiEngine: typeof proxy.callAiEngine }).callAiEngine = original;
          }
        };
        const changes: Array<[string, () => Promise<void>, () => Promise<void>, { engineStillSolving: boolean }?]> = [
          [
            'startTime på blockraden',
            async () => void (await owner.query(`UPDATE "TeachingBlockPlacements" SET "startTime" = '11:00', "updatedAt" = now() WHERE "blockId" = $1`, [sc.blockId])),
            async () => void (await owner.query(`UPDATE "TeachingBlockPlacements" SET "startTime" = '10:00', "updatedAt" = now() WHERE "blockId" = $1`, [sc.blockId])),
          ],
          [
            'dayOfWeek på blockraden',
            async () => void (await owner.query(`UPDATE "TeachingBlockPlacements" SET "dayOfWeek" = 3, "updatedAt" = now() WHERE "blockId" = $1`, [sc.blockId])),
            async () => void (await owner.query(`UPDATE "TeachingBlockPlacements" SET "dayOfWeek" = 2, "updatedAt" = now() WHERE "blockId" = $1`, [sc.blockId])),
          ],
          [
            'roomId på en salsrad',
            async () => void (await owner.query(`UPDATE "TeachingBlockPlacementRooms" SET "roomId" = $2, "updatedAt" = now() WHERE "requirementId" = $1`, [spanska.postId, salar[5]])),
            async () => void (await owner.query(`UPDATE "TeachingBlockPlacementRooms" SET "roomId" = $2, "updatedAt" = now() WHERE "requirementId" = $1`, [spanska.postId, salar[0]])),
          ],
          [
            'en ny salsrad för en annan medlem',
            async () =>
              void (await owner.query(
                `INSERT INTO "TeachingBlockPlacementRooms" ("schoolId", "placementId", "requirementId", "roomId", "updatedAt")
                 SELECT $1, id, $2, $3, now() FROM "TeachingBlockPlacements" WHERE "blockId" = $4`,
                [s, tyska.postId, salar[6], sc.blockId],
              )),
            async () => void (await owner.query(`DELETE FROM "TeachingBlockPlacementRooms" WHERE "requirementId" = $1`, [tyska.postId])),
          ],
          [
            'salsraden tas bort',
            async () => void (await owner.query(`DELETE FROM "TeachingBlockPlacementRooms" WHERE "requirementId" = $1`, [spanska.postId])),
            async () =>
              void (await owner.query(
                `INSERT INTO "TeachingBlockPlacementRooms" ("schoolId", "placementId", "requirementId", "roomId", "updatedAt")
                 SELECT $1, id, $2, $3, now() FROM "TeachingBlockPlacements" WHERE "blockId" = $4`,
                [s, spanska.postId, salar[0], sc.blockId],
              )),
          ],
          [
            // Nyckeln bygger på radernas egna id:n (blockPlacementsKeyOf), och en sparning ersätter dem: ett lika sparat förlägg medan motorn löser
            // är därför ett förlägg som rörts, fast basen (det motorn fick) är densamma. Det är den enda ändring som bara nyckeln ser; de andra
            // ändrar också förslagens bas, som skrivningen jämför en gång till (params.changed = requirements) och som vore vägran även utan nyckeln.
            'ett lika sparat förlägg (nya id:n, samma innehåll)',
            async () => void (await replace(sc, [slot(2, '10:00', 60, [{ requirementId: spanska.postId, roomId: salar[0]! }])])),
            async () => undefined,
            { engineStillSolving: false },
          ],
          [
            'blockraden tas bort',
            async () => void (await owner.query(`DELETE FROM "TeachingBlockPlacements" WHERE "blockId" = $1`, [sc.blockId])),
            async () => void (await replace(sc, [slot(2, '10:00', 60, [{ requirementId: spanska.postId, roomId: salar[0]! }])])),
          ],
        ];
        for (const [label, change, revert, options] of changes) {
          const before = await fingerprintWithoutPlacements();
          let refused: HttpException;
          try {
            refused = await duringTheSolve(change, options);
          } finally {
            // Lektionerna jämförs före och efter; förläggningarna är ändrade med flit, så de återställs innan fingeravtrycket jämförs igen.
            await revert();
          }
          assert.equal(refused.getStatus(), 409, `${label}: ${summarise(refused)}`);
          assert.equal(codeOf(refused), 'GENERATE_STALE', `${label}: ${summarise(refused)}`);
          assert.equal(await fingerprintWithoutPlacements(), before, `${label}: en inaktuell körning skrev`);
          note(`${label}: ${JSON.stringify((refused.getResponse() as { params?: unknown }).params ?? null)}`);
        }
        // Ett förlägg som tillkommer medan motorn löser, när blocket inte hade något när veckan hämtades: nyckeln var tom och är det inte längre.
        await replace(sc, []);
        const emptyBefore = await fingerprintWithoutPlacements();
        const addedRefusal = await duringTheSolve(async () =>
          void (await owner.query(
            `INSERT INTO "TeachingBlockPlacements" ("schoolId", "blockId", "academicYearId", "dayOfWeek", "startTime", minutes, "updatedAt") VALUES ($1, $2, $3, 3, '10:00', 60, now())`,
            [s, sc.blockId, year],
          )),
        );
        await owner.query(`DELETE FROM "TeachingBlockPlacements" WHERE "blockId" = $1`, [sc.blockId]);
        assert.equal(codeOf(addedRefusal), 'GENERATE_STALE', summarise(addedRefusal));
        assert.equal(await fingerprintWithoutPlacements(), emptyBefore, 'en inaktuell körning skrev');
        // Kontrollen: inga ändringar, och körningen skriver.
        await replace(sc, [slot(2, '10:00', 60, [{ requirementId: spanska.postId, roomId: salar[0]! }])]);
        solved(await generate());
        await blockOracle(sc, [{ day: 2, start: '10:00', minutes: 60, rooms: { 0: salar[0]! } }], 'i, kontroll');
      });
      /** Lektionerna och ändringsloggen: det en körning skriver. Förläggningarna är det provet själv ändrar. */
      async function fingerprintWithoutPlacements(): Promise<string> {
        return JSON.stringify([
          await all(`SELECT * FROM "MasterLessons" WHERE "academicYearId" = $1 ORDER BY id`, [year]),
          await all(`SELECT id FROM "ScheduleChangeLogs" WHERE "academicYearId" = $1 ORDER BY id`, [year]),
        ]);
      }
    });

    // (bm-k) ---------------------------------------------------------------
    await step('k', 'a placement the engine cannot hold is refused with the block and the lesson NAMED, and nothing is written', async () => {
      // (1) två medlemmar med samma lärare, efter att förlägget sparats (att spara det med samma lärare vägras redan).
      await inScene(() => scene({ members: 3 }), async (sc) => {
        await replace(sc, [slot(2, '10:00')]);
        await owner.query(`UPDATE "TeachingRequirements" SET "teacherId" = $2 WHERE id = $1`, [sc.members[1]!.postId, sc.members[0]!.teacherId]);
        const before = await fingerprint();
        const answer = await generate().catch((error: unknown) => error);
        const lines = answer instanceof HttpException ? [] : ((answer as Awaited<ReturnType<typeof generate>>).conflicts?.conflicts ?? []);
        note(`två medlemmar med samma lärare: ${answer instanceof HttpException ? summarise(answer) : `${(answer as { status: string }).status} ${JSON.stringify(lines.map((line) => [line.code, line.params]))}`}`);
        assert.ok(!(answer instanceof HttpException) && (answer as { status: string }).status === 'INFEASIBLE', 'vägras');
        const text = JSON.stringify(lines);
        assert.ok(lines.length > 0, 'en rad som säger varför');
        assert.ok(text.includes('BM Språkval'), `blocket namnges med skolans namn: ${text}`);
        assert.ok(text.includes('BM Spanska-ämne') && text.includes('BM Tyska-ämne'), `båda medlemmarnas lektioner namnges: ${text}`);
        assert.equal(await fingerprint(), before, 'inget skrevs');
      });
      // (2) en lärare som ett lås tar vid förläggningens tid.
      await inScene(() => scene({ members: 3 }), async (sc) => {
        await replace(sc, [slot(2, '10:00')]);
        const holder = await newGroup('BM upptagen');
        const holderSubject = await newSubject('BM upptagenämne');
        await owner.query(
          `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, 2, '10:00', '11:00', true, false, now())`,
          [s, year, holderSubject, holder, sc.members[2]!.teacherId, salar[7]],
        );
        const before = await fingerprint();
        const answer = await generate().catch((error: unknown) => error);
        note(`lärare upptagen av ett lås: ${answer instanceof HttpException ? summarise(answer) : `${(answer as { status: string }).status} ${JSON.stringify(((answer as Awaited<ReturnType<typeof generate>>).conflicts?.conflicts ?? []).map((line) => [line.code, line.params]))}`}`);
        assert.ok(!(answer instanceof HttpException) && (answer as { status: string }).status === 'INFEASIBLE', 'vägras');
        const text = JSON.stringify((answer as Awaited<ReturnType<typeof generate>>).conflicts);
        assert.ok(text.includes('BM Språkval') && text.includes('BM Franska-ämne'), `blocket och medlemmens lektion namnges: ${text}`);
        assert.equal(await fingerprint(), before, 'inget skrevs');
      });
      // (4) fler lektioner av blocket än salar som är lediga: sex av åtta salar hålls av lås vid förläggningens tid, tre medlemmar har två kvar.
      await inScene(() => scene({ members: 3 }), async (sc) => {
        await replace(sc, [slot(2, '10:00')]);
        for (let i = 0; i < 6; i++) {
          await owner.query(
            `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, 2, '10:00', '11:00', true, false, now())`,
            [s, year, await newSubject(`BM upptagen-sal${i}`), await newGroup(`BM upptagen-sal${i}`), await newTeacher(`lärare-sal${i}`), salar[i]],
          );
        }
        const before = await fingerprint();
        const answer = await generate().catch((error: unknown) => error);
        note(`tre medlemmar, två lediga salar: ${answer instanceof HttpException ? summarise(answer) : `${(answer as { status: string }).status} ${JSON.stringify(((answer as Awaited<ReturnType<typeof generate>>).conflicts?.conflicts ?? []).map((line) => [line.code, line.params]))}`}`);
        assert.ok(!(answer instanceof HttpException) && (answer as { status: string }).status === 'INFEASIBLE', 'vägras');
        // Här är det motorn som vägrar (förkontrollen ser inte salarnas antal): dess rader namnger lektionerna med skolans namn för posterna,
        // inte blocket, eftersom motorns katalog är oförändrad (Val 2 i designanteckningen: bara förkontrollens rad bär blockets namn).
        const text = JSON.stringify((answer as Awaited<ReturnType<typeof generate>>).conflicts);
        assert.ok(['Spanska', 'Tyska', 'Franska'].every((name) => text.includes(`BM ${name}-ämne`)), `alla tre lektionerna namnges: ${text}`);
        assert.equal(await fingerprint(), before, 'inget skrevs');
      });
      // (3) en lektion som inte ryms i klassens ramtid: ramen smalnas efter att förlägget sparats. Ramen gäller alla årskurser (0 till 12):
      // en tioårig grundskolas årskurs 7 skickas till motorn som 6, så en ram för just 7 träffar inte klassen.
      await inScene(() => scene({ members: 3 }), async (sc) => {
        await replace(sc, [slot(2, '09:00')]);
        await owner.query(
          `INSERT INTO "FrameTimes" ("schoolId", "minGradeLevel", "maxGradeLevel", "dayOfWeek", "startTime", "endTime", "updatedAt") VALUES ($1, 0, 12, NULL, '09:30', '15:00', now())`,
          [s],
        );
        const before = await fingerprint();
        const sentNow = await prepare();
        if (sentNow.ready) note(`ramtider i nyttolasten: ${JSON.stringify((sentNow.payload as { frameTimes?: unknown }).frameTimes)}; klassernas årskurser: ${JSON.stringify(sentNow.payload.requirements.map((r) => [r.minGradeLevel, r.maxGradeLevel]))}`);
        const answer = await generate().catch((error: unknown) => error);
        note(`förlägget utanför ramtiden: ${answer instanceof HttpException ? summarise(answer) : `${(answer as { status: string }).status} ${JSON.stringify(((answer as Awaited<ReturnType<typeof generate>>).conflicts?.conflicts ?? []).map((line) => [line.code, line.params]))}`}`);
        assert.ok(!(answer instanceof HttpException) && (answer as { status: string }).status === 'INFEASIBLE', 'vägras');
        const text = JSON.stringify((answer as Awaited<ReturnType<typeof generate>>).conflicts);
        assert.ok(text.includes('BM Språkval') && ['Spanska', 'Tyska', 'Franska'].every((name) => text.includes(`BM ${name}-ämne`)), `blocket och alla tre lektionerna namnges: ${text}`);
        assert.equal(await fingerprint(), before, 'inget skrevs');
      });
    });
    // (bm-z) ---------------------------------------------------------------
    await step('z', 'the oracle of these steps is itself checked: a finished week made wrong on purpose is read as wrong, every time', async () => {
      await inScene(() => scene({ members: 3 }), async (sc) => {
        await replace(sc, [slot(2, '10:00')]);
        solved(await generate());
        const expected = [{ day: 2, start: '10:00', minutes: 60 }];
        await blockOracle(sc, expected, 'z, före');
        const [m0, m1, m2] = sc.members as [Member, Member, Member];
        const corruptions: Array<[string, string, unknown[]]> = [
          ['en märkt lektion flyttad en timme', `UPDATE "MasterLessons" SET "startTime" = '11:00', "endTime" = '12:00' WHERE "academicYearId" = $1 AND "studentGroupId" = $2 AND "fromPlacement"`, [year, m0.groupId]],
          ['ett märke borttaget', `UPDATE "MasterLessons" SET "fromPlacement" = false WHERE "academicYearId" = $1 AND "studentGroupId" = $2 AND "fromPlacement"`, [year, m1.groupId]],
          ['en förlagd lektion olåst', `UPDATE "MasterLessons" SET "isLocked" = false WHERE "academicYearId" = $1 AND "studentGroupId" = $2 AND "fromPlacement"`, [year, m1.groupId]],
          [
            'två medlemmar i samma sal samtidigt',
            `UPDATE "MasterLessons" SET "roomId" = (SELECT "roomId" FROM "MasterLessons" WHERE "academicYearId" = $1 AND "studentGroupId" = $2 AND "fromPlacement") WHERE "academicYearId" = $1 AND "studentGroupId" = $3 AND "fromPlacement"`,
            [year, m0.groupId, m1.groupId],
          ],
          [
            'en medlems andra lektion skild från de andras',
            `UPDATE "MasterLessons" SET "dayOfWeek" = CASE WHEN "dayOfWeek" = 5 THEN 4 ELSE 5 END WHERE id = (SELECT id FROM "MasterLessons" WHERE "academicYearId" = $1 AND "studentGroupId" = $2 AND NOT "fromPlacement" LIMIT 1)`,
            [year, m2.groupId],
          ],
          ['en lärare på två ställen', `UPDATE "MasterLessons" SET "teacherId" = $3 WHERE "academicYearId" = $1 AND "studentGroupId" = $2 AND "fromPlacement"`, [year, m1.groupId, m0.teacherId]],
          ['en lektion för mycket', `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isGenerated", "updatedAt") VALUES ('${s}', $1, $2, $3, $4, $5, 1, '16:00', '17:00', true, now())`, [year, m0.subjectId, m0.groupId, m0.teacherId, salar[7]]],
          ['en lektion utan sal', `UPDATE "MasterLessons" SET "roomId" = NULL WHERE id = (SELECT id FROM "MasterLessons" WHERE "academicYearId" = $1 AND "studentGroupId" = $2 AND NOT "fromPlacement" LIMIT 1)`, [year, m2.groupId]],
        ];
        for (const [label, sql, params] of corruptions) {
          // I en transaktion på samma anslutning som domaren läser med, som rullas tillbaka.
          await owner.query('BEGIN');
          try {
            await owner.query(sql, params);
            await assert.rejects(blockOracle(sc, expected, `z, ${label}`), undefined, `domaren såg inte "${label}"`);
          } finally {
            await owner.query('ROLLBACK');
          }
        }
        await blockOracle(sc, expected, 'z, efter');
      });
    });
  } else {
    note('motorn saknar pinnedLessons: bara bm-j körs (de andra stegen kräver en motor med fältet)');
  }

  // (bm-j) ---------------------------------------------------------------
  if (!enginePins) {
    await step('j', 'against an engine with no pinnedLessons the run is refused ENGINE_LACKS_PINNED_LESSONS and nothing is written; a block with no placements runs as before', async () => {
      await inScene(() => scene({ members: 3 }), async (sc) => {
        // Utan förläggningar: den äldre motorn lägger blocket som förut, hos alla tre ihop.
        solved(await generate());
        const plain = await masterRows();
        assert.equal(plain.length, 3 * 2 + sc.bystanderLessons);
        assert.equal(plain.filter((row) => row.fromPlacement).length, 0);
        const lists = sc.members.map((member) => plain.filter((row) => row.groupId === member.groupId).map(tupleOf).sort());
        assert.deepEqual(lists, [lists[0], lists[0], lists[0]], 'blocket ligger ihop utan förläggning');
        // Med en förläggning: vägras med den äldre motorns 422 omsatt till koden.
        await replace(sc, [slot(2, '10:00')]);
        const before = await fingerprint();
        const refused = await refusalOf(generate());
        assert.equal(refused.getStatus(), 503, summarise(refused));
        assert.equal(codeOf(refused), 'ENGINE_LACKS_PINNED_LESSONS');
        assert.equal(await fingerprint(), before, 'en vägrad körning skriver inget');
      });
    });
  } else {
    note('bm-j hoppas över: motorn har pinnedLessons. Kör om mot en motor byggd ur git archive 9d3ef437 (se huvudet)');
  }
  assert.ok(counter > 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
